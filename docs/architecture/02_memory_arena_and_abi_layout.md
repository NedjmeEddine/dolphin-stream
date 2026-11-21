# Chapter 1.2: Memory Arena & ABI Layout

This document details the exact memory layout of the 64 MB `SharedArrayBuffer` arena shared between WebAssembly (Worker A) and JavaScript (Worker B). It also explains the strict codegen gate (`gen_offsets.c`) that prevents memory corruption across the language boundary.

---

## 1. Arena Memory Geometry

The shared arena is allocated once at initialization (`WebAssembly.Memory({ initial: 1024, maximum: 65536, shared: true })`). It is partitioned into three strictly aligned contiguous regions:

```text
+-----------------------------------------------------------------------------------+
| REGION 1: SabControlHeader (Offset: 0x00000000 | Size: 128 Bytes)                |
| - Futex doorbells: miss_futex, io_futex, save_futex, save_lock                    |
| - Error generation counter: io_error_gen                                          |
| - Miss ring buffer: miss_ring[16] + read/write indices                            |
| - Telemetry double-buffer: telem_banks[2] + active_telem_bank                     |
| - Global performance counters: l1_hits, l1_misses, network_fetches                |
+-----------------------------------------------------------------------------------+
                                          |
+-----------------------------------------------------------------------------------+
| REGION 2: Page Frame Directory (Offset: 0x00000080 | Size: 8,192 Bytes)           |
| - 256 PageFrameEntry structs (32 bytes each)                                      |
| - Organized as 32 sets x 8 ways (8-way set-associative cache)                     |
| - Fields: block_id, state, pin_count, lru_tick, flags                             |
+-----------------------------------------------------------------------------------+
                                          |
+-----------------------------------------------------------------------------------+
| REGION 3: Data Slab (Offset: 0x00002080 aligned to 0x00010000 | Size: 64 MB)      |
| - 256 physical block frames (262,144 bytes / 256 KB each)                         |
| - Frame f corresponds directly to PageFrameDirectory[f]                           |
| - Slab offset calculation: SLAB_BASE + (frame_index << block_shift)               |
+-----------------------------------------------------------------------------------+
```

---

## 2. ABI Struct Definitions & Normative Offsets

The normative source of truth for all struct definitions is `externals/vfs-streamer/client/vfs/vfs_client.h`.

### `SabControlHeader` (128 Bytes)

```c
typedef struct {
    _Atomic uint32_t miss_futex;               // Offset: 0x00 (Doorbell for Worker B)
    _Atomic uint32_t io_futex;                 // Offset: 0x04 (Wakeup for Worker A)
    _Atomic uint32_t io_error_gen;             // Offset: 0x08 (I/O error generation counter)
    _Atomic uint32_t build_rotated_flag;       // Offset: 0x0C (Signals 404/server reload)
    
    _Atomic uint32_t miss_write_idx;           // Offset: 0x10 (Circular ring write head)
    _Atomic uint32_t miss_read_idx;            // Offset: 0x14 (Circular ring read tail)
    _Atomic uint32_t miss_ring[16];            // Offset: 0x18..0x54 (16-slot block miss ring)
    
    _Atomic uint32_t global_lru_clock;         // Offset: 0x58 (Monotonic counter for LRU)
    uint32_t         num_sets;                 // Offset: 0x5C (Number of cache sets: 32)
    uint32_t         block_shift;              // Offset: 0x60 (Block size shift: 18 = 256KB)
    
    // Save state channel
    _Atomic uint32_t save_lock;                // Offset: 0x64 (Cross-thread mutex)
    _Atomic uint32_t save_futex;               // Offset: 0x68 (Futex for save operations)
    _Atomic uint32_t save_op_state;            // Offset: 0x6C (SAVE_OP_IDLE/WRITE/READ/DONE)
    _Atomic uint32_t save_abandoned;           // Offset: 0x70 (Tri-state abandonment flag)
    _Atomic int32_t  save_result;              // Offset: 0x74 (VFS_OK, VFS_ERR_*)
    uint32_t         save_byte_len;            // Offset: 0x78 (Payload size in save buffer)
    char             save_filename[64];        // Offset: 0x7C (Filename string)
    
    // Telemetry banks
    _Atomic uint32_t active_telem_bank;        // Offset: 0xBC (0 or 1)
    _Atomic uint32_t telem_bank_count[2];      // Offset: 0xC0 (Record counts in banks 0/1)
    _Atomic uint32_t telem_inflight[2];        // Offset: 0xC8 (Active writers in banks 0/1)
    
    // Telemetry & metrics
    _Atomic uint64_t l1_hits;                  // Offset: 0xD0 (Hits in SAB RAM)
    _Atomic uint64_t l1_misses;                // Offset: 0xD8 (Demand misses requiring fetch)
    _Atomic uint64_t network_fetches;          // Offset: 0xE0 (Total HTTP 206 slice fetches)
    _Atomic uint64_t total_stall_ns;           // Offset: 0xE8 (Cumulative stall time)
} SabControlHeader;
```

### `PageFrameEntry` (32 Bytes)

```c
typedef struct {
    _Atomic uint32_t block_id;   // Offset: 0x00 (VFS_INVALID_BLOCK = 0xFFFFFFFF if empty)
    _Atomic uint32_t state;      // Offset: 0x04 (FRAME_EMPTY=0, FRAME_LOADING=1, FRAME_READY=2, FRAME_EVICTING=3)
    _Atomic uint32_t pin_count;  // Offset: 0x08 (Active readers currently accessing this frame)
    _Atomic uint32_t lru_tick;   // Offset: 0x0C (Timestamp from global_lru_clock for eviction)
    _Atomic uint32_t flags;      // Offset: 0x10 (FLAG_DIRTY_OPFS=0x01, FLAG_COLD_HINT=0x02)
    uint32_t         reserved[3];// Offset: 0x14..0x1C (Pad to exactly 32 bytes for cacheline alignment)
} PageFrameEntry;
```

---

## 3. 8-Way Set Associative Indexing

To guarantee constant-time ($O(1)$) cache lookups without maintaining a dynamic hash table or acquiring locks, the slab is partitioned into **sets** and **ways**:

* Total Frames: $N = 256$
* Associativity: $W = 8$ ways per set
* Number of Sets: $S = N / W = 32$ sets

### Set Index Calculation

Given a requested block ID $b$:

$$\text{SetIndex}(b) = b \pmod S = b \pmod{32} = b \ \& \ 31$$

```c
uint32_t vfs_policy_set_index(uint32_t block_id, uint32_t num_sets) {
    return block_id % num_sets;
}
```

### Way Searching

When searching for block $b$, the engine scans only the 8 entries in set $\text{SetIndex}(b)$:

```c
size_t base = set_index * 8;
for (size_t w = 0; w < 8; w++) {
    size_t frame_idx = base + w;
    if (dir[frame_idx].block_id == b) {
        // Candidate frame found
    }
}
```

* **Why 8-Way?** 8 entries fit inside four 64-byte CPU cache lines (or a single SIMD vector scan). It provides high hit ratios under complex streaming patterns while capping linear search latency to 8 iterations.

---

## 4. The Codegen Synchronization Gate (`gen_offsets.c`)

### The Danger of Manual JS Offsets

Because Worker B is written in JavaScript and accesses the `SharedArrayBuffer` via `Int32Array`, `Uint32Array`, and `BigInt64Array` typed array views, any mismatch between C struct padding/alignment and JavaScript array indices leads to fatal, silent data corruption:

* If C compilers align a 64-bit atomic to an 8-byte boundary, an index calculated as `offset / 4` in JS might point to padding bytes rather than the actual atomic variable.
* Writing to `save_lock` might accidentally overwrite `save_futex`.

### The Automated Solution

The build system prohibits manually defining byte offsets in JavaScript. Instead, `client/vfs/gen_offsets.c` compiles natively with GCC/Clang and emits the JavaScript module `client/web/vfs_offsets.js`:

```c
// client/vfs/gen_offsets.c (Excerpt)
printf("export const MISS_FUTEX_INDEX = %zu;\n", 
       offsetof(SabControlHeader, miss_futex) / 4);
printf("export const IO_FUTEX_INDEX = %zu;\n", 
       offsetof(SabControlHeader, io_futex) / 4);
printf("export const IO_ERROR_GEN_INDEX = %zu;\n", 
       offsetof(SabControlHeader, io_error_gen) / 4);
printf("export const PAGE_FRAME_ENTRY_SIZE = %zu;\n", 
       sizeof(PageFrameEntry));
printf("export const VFS_ARENA_SLAB_OFFSET = %zu;\n", 
       VFS_ARENA_SLAB_OFFSET);
```

### The CI Verification Gate

To ensure no developer or agent ever modifies C structs without updating the JavaScript offset file, CI enforces a strict zero-drift check:

```bash
make -C client/vfs check-offsets
```

Under the hood, this Makefile rule compiles `gen_offsets.c`, generates a temporary offset file, and runs `diff -u` against `client/web/vfs_offsets.js`. If any difference exists, the build immediately terminates with a non-zero exit code.
