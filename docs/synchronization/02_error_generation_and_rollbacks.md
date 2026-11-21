# Chapter 2.2: Error Generation & Rollback Sequencing

This document explains how DolphinStream handles network disconnects, HTTP 404/504 errors, and aborted requests without deadlocking suspended WebAssembly threads or bricking cached gameplay sessions.

---

## 1. The Sticky Error Flag Anti-Pattern

In conventional systems programming, when a low-level block device encounters an unrecoverable I/O error, it sets a global sticky error flag:

```c
// NAIVE ANTI-PATTERN (DO NOT USE)
if (network_fetch_failed) {
    global_vfs_state = VFS_STATE_BROKEN; // Sticky error
}
```

In an out-of-core streaming architecture, **sticky errors are fatal**:

* If a player encounters a transient 2-second Wi-Fi drop or an HTTP 504 Gateway Timeout while loading an optional background sound effect, setting a global error flag permanently terminates the VFS.
* Even though 95% of the game (including the current scene, 3D character models, and gameplay logic) is already resident in the 64 MB L1 RAM slab or OPFS L2 cache, the emulator crashes immediately on the next read.

### The DolphinStream Invariant: Non-Sticky I/O

Errors must only abort the **specific demand read operation** that timed out after multiple failed retry rounds. Cached reads and subsequent new reads must continue functioning normally.

---

## 2. The Error Generation Protocol (`io_error_gen`)

When Worker A requests block $b$ and blocks on `Atomics.wait(io_futex)`, it needs a way to distinguish between:
1. **Normal Wakeup:** Worker B fetched block $b$ and marked it `FRAME_READY`.
2. **False Wakeup:** Worker B fetched some *other* block (e.g. a prefetch block) and signaled `io_futex`.
3. **Error Wakeup:** Worker B attempted to fetch block $b$, but the network request failed.

If Worker B encounters a network error, simply clearing the frame without signaling `io_error_gen` would cause Worker A to re-enqueue the miss, wake up, see that the block is not ready, and spin in an infinite futex loop until hard timeout.

### The Monotonic Counter Solution

The header contains an atomic 32-bit counter: `io_error_gen`.

```c
_Atomic uint32_t io_error_gen; // SabControlHeader offset 0x08
```

* Every time a **demand** fetch fails, Worker B increments `io_error_gen` and wakes all waiting threads.
* Worker A tracks `gen_seen`. If it wakes up, the block is still not ready, and `io_error_gen != gen_seen`, it knows an active fetch attempt for its block failed.

---

## 3. Strict 4-Step Frame Rollback Sequence

When a network fetch fails, aborts, or returns non-206 status (such as 404 Not Found, 416 Range Not Satisfiable, or 500 Internal Error), Worker B executes a strict 4-step rollback sequence in `client/web/worker_b_core.mjs`:

```javascript
// client/web/worker_b_core.mjs (Excerpt)
rollbackFrame(frameIdx, isDemand) {
    const base = (Offsets.VFS_ARENA_DIR_OFFSET + frameIdx * Offsets.PAGE_FRAME_ENTRY_SIZE) >>> 2;
    
    // Step 1: Clear block_id and flags atomically
    Atomics.store(this.u32, base, Offsets.VFS_INVALID_BLOCK);
    Atomics.store(this.u32, base + 4, 0);

    // Step 2: Transition state to FRAME_EMPTY
    Atomics.store(this.u32, base + 1, Offsets.FRAME_EMPTY);

    // Step 3: ONLY IF DEMAND: Increment io_error_gen
    if (isDemand) {
        Atomics.add(this.u32, Offsets.IO_ERROR_GEN_INDEX, 1);
    }

    // Step 4: Increment io_futex and wake all suspended readers
    Atomics.add(this.i32, Offsets.IO_FUTEX_INDEX, 1);
    Atomics.notify(this.i32, Offsets.IO_FUTEX_INDEX, Infinity);
}
```

### The Ordering Invariant

The order of these operations is mathematically critical:

1. **`block_id = INVALID` before `state = EMPTY`:** If `state` were set to `FRAME_EMPTY` while `block_id` still held the target ID, another thread performing a speculative lookup could match the old block ID in an invalid state.
2. **`state = EMPTY` before `io_error_gen++`:** Worker A must never observe an incremented error generation until the frame directory has already been cleanly restored to `FRAME_EMPTY`.
3. **`io_error_gen++` before `io_futex++` / `notify`:** If `io_futex` were notified first, Worker A could wake up, check `io_error_gen`, observe no change, and re-enqueue before the error is registered.

---

## 4. The Prefetch Invisibility Rule

Notice line 441 in `rollbackFrame`:

```javascript
if (isDemand) {
    Atomics.add(this.u32, Offsets.IO_ERROR_GEN_INDEX, 1);
}
```

### Why Prefetch Failures Must Stay Silent

Markov prefetching is purely speculative: it requests blocks that *might* be needed in the future.
* If a prefetch request fails (e.g. rate-limited by the browser or aborted because the user changed directions in the game), it is **not an error**.
* If a prefetch rollback incremented `io_error_gen`, an unrelated demand read currently waiting on a real block would see `io_error_gen` change and increment its failure count!
* **Rule:** Prefetch failures must silently recycle their frame to `FRAME_EMPTY` and remain 100% invisible to synchronous readers.

---

## 5. Reader Retry Loop & Bounded Abort

In `client/vfs/vfs_client.c`, Worker A handles errors with bounded exponential backoff:

```c
uint32_t gen_seen = atomic_load_explicit(&ctrl->io_error_gen, memory_order_acquire);
uint32_t failed_rounds = 0;

while (true) {
    // Check if server rotated build (e.g. 404 ETag mismatch)
    if (atomic_load_explicit(&ctrl->build_rotated_flag, memory_order_acquire)) {
        return total_copied > 0 ? (ptrdiff_t)total_copied : VFS_ERR_BUILD_ROTATED;
    }

    // Check overall read deadline (default 10,000 ms)
    uint64_t elapsed_ms = (hal_now_ns() - t0) / 1000000ULL;
    if (elapsed_ms >= VFS_READ_DEADLINE_MS) {
        return total_copied > 0 ? (ptrdiff_t)total_copied : VFS_ERR_TIMEOUT;
    }

    // Check if error generation incremented
    uint32_t g = atomic_load_explicit(&ctrl->io_error_gen, memory_order_acquire);
    if (g != gen_seen) {
        gen_seen = g;
        if (!is_block_ready_or_loading(ctx, b)) {
            failed_rounds++;
            if (failed_rounds >= VFS_MAX_FAILED_ROUNDS) { // Default: 3 rounds
                return total_copied > 0 ? (ptrdiff_t)total_copied : VFS_ERR_IO;
            }
        }
    }

    // Re-enqueue miss if frame was rolled back to EMPTY
    if (!is_block_ready_or_loading(ctx, b)) {
        if (enqueue_miss_block(ctrl, b)) {
            atomic_fetch_add_explicit(&ctrl->miss_futex, 1, memory_order_release);
            hal_futex_wake(&ctrl->miss_futex, 1);
        }
    }

    // Suspend until next I/O event or slice timeout
    int32_t expected = atomic_load_explicit(&ctrl->io_futex, memory_order_acquire);
    frame = try_pin_frame(ctx, b);
    if (frame >= 0) break; // Succeeded!

    hal_futex_wait(&ctrl->io_futex, expected, VFS_WAIT_SLICE_MS);
}
```

* If a single slice fetch fails due to packet loss, Worker A re-enqueues the miss and tries up to `VFS_MAX_FAILED_ROUNDS = 3` times.
* If all 3 rounds fail, it returns `VFS_ERR_IO` to the caller, allowing the emulator to display a "Disc Read Error" message without hanging the browser.
