# Chapter 1.3: Layer 5 Lock-Free Virtual Filesystem

This document describes the design and implementation of **Layer 5 VFS** (`externals/vfs-streamer/client/vfs/vfs_fs.c`), which implements a POSIX-compliant, lock-free virtual filesystem layer on top of the block-streaming runtime.

---

## 1. Architectural Purpose

Layer 3 and Layer 4 operate exclusively on raw block IDs ($b \in [0, N-1]$). However, higher-level applications and emulators often interact with file systems containing directory structures, file descriptors, and seek pointers.

Layer 5 bridges this gap by interpreting a **24-byte path-sorted Table of Contents (TOC)** placed at offset `0x00` of VFSI container archives:

```text
+-----------------------------------------------------------------------------------+
| 24-BYTE TOC ENTRY LAYOUT                                                          |
| 0x00..0x07: uint64_t path_hash    (64-bit SipHash-2-4 or FNV-1a of canonical path) |
| 0x08..0x0F: uint64_t data_offset  (Absolute byte offset of file content in disc)  |
| 0x10..0x17: uint64_t file_size    (Exact byte length of file)                     |
+-----------------------------------------------------------------------------------+
```

Layer 5 provides standard POSIX filesystem calls:
* `vfs_fs_open(fs, path, &fd)`
* `vfs_fs_pread(fs, fd, offset, buf, count)`
* `vfs_fs_read(fs, fd, buf, count)`
* `vfs_fs_seek(fs, fd, offset, whence)`
* `vfs_fs_tell(fs, fd)`
* `vfs_fs_close(fs, fd)`
* `vfs_fs_stat(fs, path, &size)`
* `vfs_fs_hint_cold(fs, fd, offset, size, mode)`

---

## 2. Lock-Free 64-Bit Handle Protocol

Traditional file descriptor tables use mutexes or spinlocks to protect slot allocation and cursor updates. Under high-concurrency multi-threaded emulation, lock contention introduces severe jitter.

Layer 5 eliminates all locks by encoding handle identity, state, and reference counting into **atomic 64-bit integers**.

### Handle Encoding

A file descriptor `fd` returned to user space is a 32-bit unsigned integer:

$$\text{fd} = (\text{gen} \ll 8) \mid \text{slot\_idx}$$

* **`slot_idx` (Bits 0..7):** Index into the fixed table of 256 handle slots (`0..255`).
* **`gen` (Bits 8..31):** 24-bit monotonically increasing generation counter (`1..16,777,215`).
* **Permanent Invariant:** `fd == 0` is permanently reserved and invalid.

### `slot_meta` Packing (64 Bits)

Each of the 256 slots contains a single `_Atomic uint64_t slot_meta`:

```text
+-------------------------------------------------------------------+
| 64-BIT ATOMIC slot_meta BITFIELD                                   |
| Bits 0..37  (38 bits): refcount       (Active readers currently in pread) |
| Bits 38..39 (2 bits) : state          (0=FREE, 1=ACTIVE, 2=CLOSING)       |
| Bits 40..63 (24 bits): generation     (Monotonic generation counter)      |
+-------------------------------------------------------------------+
```

### Slot State Machine & ABA Prevention

1. **Handle Allocation (`vfs_fs_open`):**
   * Scans slots for `state == FREE`.
   * CAS transition: `(old_gen, FREE, 0)` $\to$ `(old_gen + 1, ACTIVE, 0)`.
   * Returns `fd = (new_gen << 8) | slot_idx`.
2. **Handle Acquisition (`vfs_fs_pread`):**
   * Extracts `slot_idx = fd & 0xFF` and `gen = fd >> 8`.
   * Atomic fetch-add increments `refcount` by 1.
   * Re-verifies: `(meta.generation == gen) && (meta.state == ACTIVE)`.
   * If mismatch (e.g. handle was closed concurrently or recycled): atomic decrement `refcount` and return `VFS_FS_ERR_BADF`.
3. **Handle Deallocation (`vfs_fs_close`):**
   * Sets `state = CLOSING`.
   * If `refcount == 0`: immediately transitions to `state = FREE`.
   * If `refcount > 0`: the final exiting reader decrements `refcount` to 0 and transitions the slot to `FREE`.
   * **Result:** Total immunity to the ABA problem. Even if a slot is recycled millions of times, stale readers holding older `fd` values fail generation checks without accessing corrupted memory.

---

## 3. POSIX 64 MiB Read Slicing (`wasm32` Protection)

In a 32-bit WebAssembly environment (`wasm32`), `size_t` and `ptrdiff_t` are 32-bit integers. If an application attempts a multi-hundred-megabyte read, or if an internal pointer calculation wraps $2^{31}-1$, signed pointer arithmetic overflows, triggering silent heap corruption or engine crashes.

Layer 5 enforces a strict slicing limit:

```c
#define VFS_FS_READ_SLICE_MAX (64 * 1024 * 1024) // 64 MiB
```

When `vfs_fs_pread` receives a large read request, it automatically splits the request into consecutive chunks of $\le 64\text{ MiB}$:

```c
// client/vfs/vfs_fs.c (Excerpt)
int64_t total_read = 0;
while (count > 0) {
    size_t chunk = (count > VFS_FS_READ_SLICE_MAX) ? VFS_FS_READ_SLICE_MAX : (size_t)count;
    ptrdiff_t rc = vfs_read_sync_ex(fs->ctx, file_start + offset + total_read, 
                                     buf + total_read, chunk, &slot->cursor_telem);
    if (rc < 0) {
        // POSIX Short Read Contract:
        // If we already copied >= 1 byte, advance cursor and return bytes read.
        // The subsequent read will return the error code.
        return total_read > 0 ? total_read : rc;
    }
    total_read += rc;
    count -= rc;
    if ((size_t)rc < chunk) {
        break; // Reached EOF early
    }
}
return total_read;
```

---

## 4. Interior-Only Cold Hinting

Modern operating systems and emulators provide caching hints (like POSIX `fadvise(POSIX_FADV_DONTNEED)`). When Dolphin finishes playing a 500 MB video cutscene or completes uploading a batch of textures into VRAM, keeping those blocks in L1 RAM slab wastes cache capacity.

Layer 5 provides `vfs_fs_hint_cold`:

```c
void vfs_fs_hint_cold(VfsFs* fs, uint32_t fd, uint64_t offset, uint64_t size, int mode);
```

### The Block 0 Hazard

In container archives (VFSI), the TOC resides at offset `0x00` (Block 0). If an application calls `vfs_fs_hint_cold` with an offset that rounds down to block 0, evicting Block 0 would force the filesystem to re-fetch the TOC on the next file lookup.

Layer 5 implements `VFS_FS_HINT_INTERIOR_ONLY`:
* Computes the first block strictly within the file payload:
  $$b_{\text{first}} = \frac{\text{file\_start} + \text{offset} + \text{block\_size} - 1}{\text{block\_size}}$$
* Guarantees that any block containing TOC metadata is **never cold-hinted**.

---

## 5. Dual-Mode Integration in DolphinStream

In `src/disc_io/vfs_blob_reader.cpp`, DolphinStream supports both structured VFSI directory packs and raw monolithic ISO streams:

```cpp
std::unique_ptr<VfsBlobReader> VfsBlobReader::Create(VfsFs* fs, const std::string& path) {
    if (!fs) return nullptr;

    // Mode 1: VFSI Container with Table of Contents
    uint64_t size = 0;
    if (vfs_fs_stat(fs, path.c_str(), &size) == VFS_FS_OK) {
        uint32_t fd = 0;
        if (vfs_fs_open(fs, path.c_str(), &fd) == VFS_FS_OK) {
            return std::make_unique<VfsBlobReader>(fs, fd, size);
        }
    }

    // Mode 2: Raw Monolithic ISO Fallback (m_fd == 0)
    // Directly reads raw ISO stream without requiring a filesystem TOC
    if (fs->ctx) {
        uint64_t archiveSize = vfs_archive_byte_size(fs->ctx);
        if (archiveSize > 0) {
            return std::make_unique<VfsBlobReader>(fs, 0, archiveSize);
        }
    }

    return nullptr;
}
```

* **When `m_fd != 0`:** Reads dispatch through `vfs_fs_pread(m_fs, m_fd, offset, out_ptr, size)`.
* **When `m_fd == 0`:** Reads dispatch directly through `vfs_read_sync(m_fs->ctx, offset, out_ptr, size)`.
