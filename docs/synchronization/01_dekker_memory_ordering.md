# Chapter 2.1: Dekker Memory Ordering & Synchronization

This document examines the lock-free pinning and eviction protocol that synchronizes Worker A (the synchronous WASM reader) and Worker B (the asynchronous JavaScript I/O engine) across the shared 64 MB slab.

---

## 1. Why Mutexes Fail Across Web Workers

In standard desktop multithreading, a reader and writer protect shared cache frames using read-write locks (`pthread_rwlock_t`) or mutexes (`std::mutex`). 

In a browser WebAssembly environment, traditional cross-thread mutexes fail catastrophically:

1. **Deadlock with the JavaScript Event Loop:**
   Worker B is a single-threaded JavaScript execution context driven by an event loop. If Worker B acquires a lock and is descheduled or pauses on microtasks, and Worker A (running in a WASM pthread) spinlocks or blocks waiting for that lock, priority inversion and deadlocks freeze the entire browser tab.
2. **Extreme Overhead at 60 FPS:**
   Dolphin reads disc sectors dozens of times per frame (e.g. streaming audio tracks, geometry, and textures). Acquiring and releasing a mutex on every 2 KB–256 KB read introduces unacceptable CPU overhead and cache-line contention.
3. **Pthread Heterogeneity:**
   Worker B runs pure JavaScript (`Atomics`), whereas Worker A runs compiled C11/C++ WASM machine code. Native pthread primitives cannot be acquired transparently by JavaScript event callbacks.

---

## 2. The Dekker Pin/Evict Race Condition

To allow Worker A to read from slab frames with zero lock overhead while Worker B concurrently evicts cold frames, the engine uses an algorithm derived from **Dekker’s Mutual Exclusion Algorithm**.

### The Vulnerable Interleaving (The Race)

Consider a naive implementation without strict memory ordering:

```text
Worker A (Reader)                               Worker B (Evictor)
-----------------                               ------------------
Reads dir[f].block_id == target                 Marks dir[f].state = FRAME_EVICTING
Reads dir[f].state == FRAME_READY               Checks dir[f].pin_count == 0 (Passes!)
Increments dir[f].pin_count                     Overwrites Slab[f] with new data!
Reads Slab[f]  <--- DATA CORRUPTION!
```

If Worker A checks the frame's validity *before* Worker B marks it as evicting, but Worker B checks `pin_count` *before* Worker A increments it, both operations succeed simultaneously. Worker B overwrites the slab memory while Worker A is actively copying from it.

---

## 3. The Double-Checked Dekker Pinning Protocol

DolphinStream solves this race condition by enforcing a strict **double-checked sequence with sequential consistency (`memory_order_seq_cst`)**.

### Reader Pinning Protocol (`vfs_client.c: try_pin_frame`)

```c
static int try_pin_frame(VfsClientContext* ctx, uint32_t target_block) {
    uint32_t s = vfs_policy_set_index(target_block, ctx->ctrl->num_sets);
    size_t base = s * 8;

    for (size_t w = 0; w < 8; w++) {
        size_t f = base + w;
        
        // 1. Speculative match check
        if (atomic_load_explicit(&ctx->dir[f].block_id, memory_order_acquire) == target_block) {
            
            // 2. Increment pin_count with sequential consistency
            atomic_fetch_add_explicit(&ctx->dir[f].pin_count, 1, memory_order_seq_cst);
            
            // 3. Re-verify BOTH block_id and state with sequential consistency
            uint32_t b2 = atomic_load_explicit(&ctx->dir[f].block_id, memory_order_seq_cst);
            uint32_t st = atomic_load_explicit(&ctx->dir[f].state, memory_order_seq_cst);

            if (b2 == target_block && st == FRAME_READY) {
                // Success: frame is pinned and safe from eviction!
                uint32_t now = atomic_fetch_add_explicit(&ctx->ctrl->global_lru_clock, 1, 
                                                         memory_order_relaxed) + 1;
                atomic_store_explicit(&ctx->dir[f].lru_tick, now, memory_order_relaxed);
                atomic_fetch_and_explicit(&ctx->dir[f].flags, ~FLAG_COLD_HINT, memory_order_relaxed);
                return (int)f;
            }

            // 4. Mismatch detected! Eviction started concurrently. Back out immediately.
            atomic_fetch_sub_explicit(&ctx->dir[f].pin_count, 1, memory_order_seq_cst);
        }
    }
    return -1; // Cache miss
}
```

### Reader Unpinning Protocol (`vfs_client.c: vfs_read_sync`)

Once Worker A finishes copying data from the slab frame into the emulator destination buffer, it decrements `pin_count`:

```c
// Copy bytes directly from slab to emulator buffer
uint8_t* src = ctx->slab + ((size_t)frame << block_shift) + off_in_block;
memcpy(dst_buf + total_copied, src, chunk_len);

// Dekker unpin with sequential consistency
atomic_fetch_sub_explicit(&ctx->dir[frame].pin_count, 1, memory_order_seq_cst);
```

### Evictor Allocation Protocol (`vfs_policy.c: vfs_policy_allocate`)

When Worker B needs to evict a frame to make room for a new block, it enforces the inverse sequence:

```c
// 1. Select candidate victim via LRU / cold hints
int victim = select_lru_victim(ways);

// 2. Mark state = FRAME_EVICTING
atomic_store_explicit(&ways[victim].state, FRAME_EVICTING, memory_order_seq_cst);

// 3. Check if any reader pinned the frame before the state store
if (atomic_load_explicit(&ways[victim].pin_count, memory_order_seq_cst) != 0) {
    // Eviction blocked! Restore state and select another victim
    atomic_store_explicit(&ways[victim].state, FRAME_READY, memory_order_seq_cst);
    return -1;
}

// 4. Safe to overwrite frame metadata and slab contents
atomic_store_explicit(&ways[victim].block_id, new_block_id, memory_order_release);
atomic_store_explicit(&ways[victim].state, FRAME_LOADING, memory_order_release);
return victim;
```

---

## 4. Why `memory_order_seq_cst` Is Mandatory

Software engineers often attempt to optimize atomic code by replacing `memory_order_seq_cst` with `memory_order_acquire` / `memory_order_release`.

**In Dekker’s algorithm, acquire/release is provably broken.**

* `store_release` guarantees that earlier writes complete before this store.
* `load_acquire` guarantees that later reads occur after this load.
* **However**, acquire/release does **not** prevent a store followed by a load from being reordered by CPU hardware or compiler optimizations:
  $$\text{Store}(\text{pin\_count}) \longleftrightarrow \text{Load}(\text{state})$$
  Without a full sequential consistency barrier (`seq_cst` or CPU `MFENCE`), the CPU may speculatively load `state` before the store to `pin_count` becomes globally visible to other CPU cores. Both threads will read the old state, and data corruption will occur.

---

## 5. ThreadSanitizer Verification Suite

To verify that no race conditions, memory model violations, or deadlocks exist, `externals/vfs-streamer/client/vfs` contains a dedicated multi-threaded stress suite (`vfs_test.c`).

The suite launches multiple reader threads competing against eviction threads at maximum throughput:

```bash
make -C externals/vfs-streamer/client/vfs test
```

Under the hood, this compiles the C engine with Clang's **ThreadSanitizer (TSan)**:
```makefile
CFLAGS += -fsanitize=thread -g -O1
```

If even a single memory access occurs without a proper happens-before relationship, TSan immediately aborts the test with a detailed stack trace of both conflicting threads. Passing this test suite guarantees that the Dekker memory ordering is mathematically sound.
