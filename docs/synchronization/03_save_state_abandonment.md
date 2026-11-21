# Chapter 2.3: Save State Abandonment Protocol

This document details the synchronization protocol governing GameCube memory card and Wii NAND save operations across the shared arena, specifically how the runtime prevents permanent deadlocks when browser disk I/O exceeds frame deadlines.

---

## 1. The Save Synchronization Problem

In DolphinStream, save operations (such as writing to a simulated GameCube Memory Card or Wii save flash) are initiated by the C++ core in Worker A:

```c
int32_t vfs_save_write_sync(VfsClientContext* ctx, const char* name, 
                            const uint8_t* data, size_t len);
```

Unlike read caching (which is read-only and backed by the 64 MB slab), save operations must persist modified data permanently to the browser's Origin Private File System (`/saves/${gameId}/`).

### The Timing Dilemma

1. Worker A acquires `save_lock`, copies save payload bytes into `ctx->save_buf`, sets `save_op_state = SAVE_OP_WRITE`, and rings `miss_futex`.
2. Worker A then suspends on `Atomics.wait(save_futex)` with a timeout (`VFS_SAVE_TIMEOUT_MS = 1000 ms`).
3. If the user's host disk is heavily loaded, or if the browser's OPFS sync access handle takes $> 1000\text{ ms}$ to flush, **Worker A hits its timeout**.

### The Deadlock Trap of Naive Timeout

If Worker A simply unlocks `save_lock` and returns `VFS_ERR_TIMEOUT` to the emulator:
* Worker B is **still actively running** inside its asynchronous OPFS write handler, reading from `ctx->save_buf`.
* If the emulator immediately attempts a second save operation, the new thread acquires `save_lock` and overwrites `ctx->save_buf` while Worker B is in the middle of writing the first save to disk.
* Result: Save file corruption on disk, or a race condition where the first save's completion overwrites the second save's state.

On the other hand, if Worker A leaves `save_lock` locked when it times out, no future save operation can ever be executed for the remainder of the session!

---

## 2. The Tri-State Abandonment Protocol

To resolve this dilemma without locks, the header defines a tri-state atomic flag:

```c
_Atomic uint32_t save_abandoned; // SabControlHeader offset 0x70
```

The flag has three distinct lifecycle states:

| Value | State | Meaning |
|---|---|---|
| `0` | `SAVE_STATE_NORMAL` | Save in progress; Worker A is actively waiting for Worker B. |
| `1` | `SAVE_STATE_ABANDONED` | Worker A hit its 1000 ms timeout and abandoned waiting. |
| `2` | `SAVE_STATE_CLAIMED` | Worker B completed the write and claimed the completion slot. |

---

## 3. Worker A Abandonment Sequence

When Worker A's wait loop expires in `client/vfs/vfs_client.c`, it executes an atomic Compare-And-Swap (CAS):

```c
// client/vfs/vfs_client.c (Excerpt)
uint64_t elapsed_ms = (hal_now_ns() - t0) / 1000000ULL;
if (elapsed_ms >= VFS_SAVE_TIMEOUT_MS) {
    // Attempt to transition save_abandoned from 0 to 1
    uint32_t expected_zero = 0;
    if (atomic_compare_exchange_strong_explicit(&ctrl->save_abandoned, &expected_zero, 1,
                                                memory_order_seq_cst, memory_order_seq_cst)) {
        // CAS Succeeded: Worker B has NOT completed yet.
        // Leave save_lock HELD so no new caller can corrupt save_buf!
        // Worker B will clean up the lock when it eventually finishes.
        return VFS_ERR_TIMEOUT;
    }

    // CAS Failed: Worker B completed at the exact moment we timed out!
    // save_abandoned was already set to 2 by Worker B.
    // Clean up normally.
    int32_t res = atomic_load_explicit(&ctrl->save_result, memory_order_relaxed);
    atomic_store_explicit(&ctrl->save_abandoned, 0, memory_order_relaxed);
    atomic_store_explicit(&ctrl->save_op_state, SAVE_OP_IDLE, memory_order_release);
    atomic_store_explicit(&ctrl->save_lock, 0, memory_order_release);
    return res;
}
```

---

## 4. Worker B Resolution Sequence

When Worker B eventually finishes the slow OPFS disk write in `client/web/worker_b_core.mjs` (or in C simulation in `vfs_test.c`), it performs the complementary CAS:

```c
// client/vfs/vfs_test.c & client/web/worker_b_core.mjs (Excerpt)
atomic_store_explicit(&ctrl->save_result, VFS_OK, memory_order_release);

uint32_t expected_zero = 0;
if (atomic_compare_exchange_strong_explicit(&ctrl->save_abandoned, &expected_zero, 2,
                                            memory_order_seq_cst, memory_order_seq_cst)) {
    // Case 1: Normal Completion
    // CAS Succeeded (expected_zero was 0): Worker A is still waiting!
    atomic_store_explicit(&ctrl->save_op_state, SAVE_OP_DONE, memory_order_release);
    atomic_fetch_add_explicit(&ctrl->save_futex, 1, memory_order_release);
    hal_futex_wake(&ctrl->save_futex, INT32_MAX);
} else {
    // Case 2: Abandoned Save Cleanup
    // CAS Failed: expected_zero was 1! Worker A already timed out and abandoned.
    // Worker B now takes responsibility for cleaning up the arena state.
    atomic_store_explicit(&ctrl->save_abandoned, 0, memory_order_relaxed);
    atomic_store_explicit(&ctrl->save_op_state, SAVE_OP_IDLE, memory_order_release);
    atomic_store_explicit(&ctrl->save_lock, 0, memory_order_release);
    hal_futex_wake(&ctrl->save_lock, 1);
}
```

---

## 5. Verification & Test Coverage

This protocol is verified in two dedicated test suites:

1. **Native C ThreadSanitizer Test 5 (`client/vfs/vfs_test.c`):**
   * Manually sets `save_abandoned = 1`, acquires `save_lock`, and dispatches a save operation.
   * Asserts that Worker B completes the write, detects `save_abandoned == 1`, safely releases `save_lock = 0`, and leaves `save_abandoned == 0`.
2. **JavaScript Core Unit Test J11 (`client/web/worker_b_core.test.mjs`):**
   ```javascript
   test('J11: Save Abandonment Recovery by Worker B (§5.6)', () => {
       // Worker A acquired save_lock, timed out, and set save_abandoned = 1
       Atomics.store(core.i32, Offsets.SAVE_LOCK_INDEX, 1);
       Atomics.store(core.u32, Offsets.CTRL_SAVE_ABANDONED_OFFSET >>> 2, 1);
       Atomics.store(core.u32, Offsets.CTRL_SAVE_OP_STATE_OFFSET >>> 2, Offsets.SAVE_OP_WRITE);
       
       // Worker B completes the abandoned save
       core.handleSaveOp();

       // Verify Worker B cleaned up arena state completely
       assert.equal(Atomics.load(core.i32, Offsets.SAVE_LOCK_INDEX), 0);
       assert.equal(Atomics.load(core.u32, Offsets.CTRL_SAVE_ABANDONED_OFFSET >>> 2), 0);
       assert.equal(Atomics.load(core.u32, Offsets.CTRL_SAVE_OP_STATE_OFFSET >>> 2), Offsets.SAVE_OP_IDLE);
   });
   ```
