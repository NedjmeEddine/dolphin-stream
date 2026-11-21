# Chapter 5.3: 1st-Order Markov Prefetch Tuning & Dirty Gates

This document explains the mathematical modeling, parameter tuning, and cache eviction constraints that enable DolphinStream to achieve $\ge 90\%$ cache hit ratios over standard broadband connections.

---

## 1. The 1st-Order Markov Transition Model

Optical disc reads in games exhibit strong temporal and spatial clustering, but are non-linear:
* Loading a stage reads the level geometry header, followed by character skeleton data, sound banks, and texture packages located in scattered disc sectors.
* Standard sequential read-ahead (e.g., prefetching $b+1, b+2, b+3$) fails because disc sectors are non-contiguous.

### Transition Probability Matrix

To predict future reads accurately, the slicer (`markov-pack`) models disc access as a **1st-order discrete-time Markov chain**:

$$P(B \mid A) = \frac{\text{Count}(A \to B)}{\sum_{X} \text{Count}(A \to X)}$$

Where:
* $A$ is the currently accessed block ID.
* $B$ is the candidate next block ID.
* $\text{Count}(A \to B)$ is the frequency with which access to block $A$ was immediately followed by access to block $B$ across recorded gameplay tours.

During compilation, `markov-pack` sorts candidate successors by descending probability and stores the top-$K$ most likely neighbors for every block in `manifest.bin`.

---

## 2. Parameter Tuning: Top-$K$, Pool Size & Cooldown

Selecting the optimal prefetch parameters requires balancing cache hit ratio against network bandwidth consumption:

```text
+-----------+------------------+-------------------+------------------------------------+
| Top-K     | Cache Hit Ratio  | Bandwidth Waste   | Operational Assessment             |
+-----------+------------------+-------------------+------------------------------------+
| K = 1     | 62% - 68%        | Low (< 5%)        | Insufficient run-ahead; stalls CPU |
| K = 2..4  | 90% - 94%        | Moderate (10-15%) | Optimal operating point (Default)  |
| K >= 6    | 93% - 96%        | High (> 45%)      | Thrashes network & evicts hot L1   |
+-----------+------------------+-------------------+------------------------------------+
```

### 1. Top-$K$ Selection ($K = 2 \text{ or } 4$)
* For games with deterministic stage loads (e.g. Super Smash Bros. Melee), $K=2$ achieves $> 90\%$ hit ratios with negligible bandwidth waste.
* For open-world or streaming titles (e.g. Mario Kart Wii), $K=4$ accounts for branching path navigation without saturating typical home connections.

### 2. Request Coalescing
When multiple predicted blocks are contiguous on disc (e.g. blocks 104, 105, 106), Worker B merges them into a single HTTP 206 range request:
```http
Range: bytes=27262976-28049407 (768 KB single fetch instead of 3x 256 KB fetches)
```
This reduces HTTP connection overhead and TLS round-trip latency by 66%.

### 3. Flight Tracking & Cooldown
Before dispatching a prefetch request for candidate block $B$, Worker B verifies:
1. Is block $B$ already resident in L1 RAM slab? (`isResidentL1(B) == true`) $\to$ Skip.
2. Is block $B$ currently in-flight? (`state == FRAME_LOADING`) $\to$ Skip.
3. Is block $B$ already resident in L2 OPFS SSD cache? (`isResidentL2(B) == true`) $\to$ Load from local SSD instead of network!

---

## 3. The Dirty Frame Eviction Gate

In `externals/vfs-streamer/client/vfs/vfs_policy.c`, the cache allocator distinguishes between two allocation modes:

```c
#define VFS_ALLOC_DEMAND   0  // Blocking read requested by emulator
#define VFS_ALLOC_PREFETCH 1  // Speculative prefetch requested by Markov model
```

### The Prefetch Stalling Hazard

When a block has been downloaded from the network into the L1 slab but has not yet been flushed to the OPFS SSD cache by the idle write-behind loop, it is flagged with `FLAG_DIRTY_OPFS`.

* If a **demand read** needs a frame and all candidate ways in the set are dirty, it must synchronously write through to OPFS because the emulator is waiting and cannot proceed without a frame.
* **However**, if a **speculative prefetch** were allowed to evict a dirty frame:
  1. The speculative prefetch would block the Worker B event loop on a synchronous disk write.
  2. A real demand read arriving behind it would be starved.
  3. Evicting dirty data for a block that might never be read wastes disk I/O and risks losing modified data.

### The Policy Gate (`client/vfs/vfs_policy.c`)

The eviction algorithm enforces an absolute gate:

```c
// client/vfs/vfs_policy.c (Excerpt)
int vfs_policy_allocate(PageFrameEntry* ways, uint32_t block_id, 
                        int alloc_type, uint32_t now) {
    // ...
    for (size_t w = 0; w < 8; w++) {
        // If this allocation is PREFETCH, strictly skip frames flagged DIRTY_OPFS
        if (alloc_type == VFS_ALLOC_PREFETCH && 
            (atomic_load_explicit(&ways[w].flags, memory_order_relaxed) & FLAG_DIRTY_OPFS)) {
            continue; // Gate: Prefetch must NEVER evict dirty frames!
        }
        
        // Evaluate LRU age and cold hints...
    }
    // ...
}
```

* Prefetch allocations never trigger synchronous write-through.
* If all 8 ways in a set are dirty or pinned, the prefetch allocation safely aborts without affecting running code.

---

## 4. Closed-Loop Benchmark Results (Benchmark T9)

The repository includes a closed-loop Markov tour benchmark (`client/vfs/vfs_test.c: benchmark_t9`):

```bash
make -C externals/vfs-streamer/client/vfs bench
```

### Benchmark Metrics (64 MB Slab / 256 KB Blocks)

* **Linear Sequential Streaming:** $> 99.2\%$ L1 hit ratio.
* **Simulated Markov Tour (Random Branching):** $91.8\%$ L1 hit ratio.
* **Effective Network Bandwidth Saved:** $> 88\%$ compared to naive non-predictive demand fetching.
* **Perceived CPU Stall Time:** $< 0.4\text{ ms}$ average stall per gigabyte streamed.
