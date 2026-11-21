# Chapter 5.1: Strict EOF Contracts & Boundary Hardening

This document examines the exact boundary conditions, 64-bit integer overflow traps, and strict EOF contracts governing Dolphin’s disc-reading interface (`src/disc_io/vfs_blob_reader.cpp`).

---

## 1. The Clamping Anti-Pattern in Emulator Disc I/O

In typical desktop file reading, libraries often clamp read sizes to the remaining file length:

```cpp
// DANGEROUS CLAMPING ANTI-PATTERN (DO NOT USE IN EMULATION)
bool VfsBlobReader::Read(uint64_t offset, uint64_t size, uint8_t* out_ptr) {
    if (offset >= m_size) return false;
    uint64_t toRead = std::min(size, m_size - offset);
    vfs_read_sync(m_fs->ctx, offset, out_ptr, toRead);
    return true; // DANGEROUS: Returns true on partial read!
}
```

### Why Partial Reads Corrupt Emulator RAM

In GameCube and Wii hardware, the DVD controller (Drive Interface / DI) reads sectors in fixed hardware chunks:
* 2,048 bytes (GameCube standard optical sector)
* 32,768 bytes (32 KB ECC block)

When Dolphin’s disc subsystem requests 2,048 bytes into a buffer allocated in emulator RAM:
1. If the disc image ends abruptly, or if the game attempts to read past EOF, clamping `toRead` copies fewer than 2,048 bytes (e.g. 512 bytes).
2. Returning `true` tells the Dolphin emulator core that the hardware read succeeded completely.
3. The remaining 1,536 bytes in emulator RAM remain uninitialized or retain stale data from previously executed code.
4. When the PowerPC CPU branches into that memory, it executes uninitialized garbage instructions, causing inexplicable, non-reproducible crashes.

### The Strict EOF Invariant

> **The Dolphin DiscIO EOF Contract:**  
> Any read that exceeds the disc image boundary—even by a single byte—must be **completely rejected** and return `false`. The destination buffer must not be modified, and partial reads must never report success.

---

## 2. The 64-Bit Integer Overflow Vulnerability

When validating read parameters, standard boundary checks look like this:

```cpp
// VULNERABLE BOUNDARY CHECK
if (offset >= m_size || offset + size > m_size) {
    return false;
}
```

### The Unsigned Wrap Hazard

In C++ on 64-bit platforms, `offset` and `size` are `uint64_t` ($0 \text{ to } 2^{64}-1$).

Consider what happens if an attacker, corrupted save file, or malformed IPC message passes:
* `offset = 100`
* `size = UINT64_MAX - 50` ($18,446,744,073,709,551,565$)
* `m_size = 1,459,978,240` (1.4 GB GameCube disc)

Evaluating `offset + size`:
$$100 + (2^{64} - 51) = 2^{64} + 49 \equiv 49 \pmod{2^{64}}$$

Because of unsigned 64-bit integer overflow:
1. `offset + size` wraps around to **`49`**.
2. The condition `49 > m_size` evaluates to **`false`**!
3. The check passes, and the engine attempts to copy $18.4\text{ Exabytes}$ of data from memory, triggering immediate segmentation faults or security vulnerabilities.

### The Hardened Subtraction Invariant (Commit `3d6394b`)

To eliminate unsigned integer overflow permanently, the addition must be converted to an equivalent subtraction that can never wrap:

```cpp
// src/disc_io/vfs_blob_reader.cpp (Excerpt)
bool VfsBlobReader::Read(uint64_t offset, uint64_t size, uint8_t* out_ptr) {
    if (!out_ptr) return false;
    if (size == 0) return true; // Zero-byte reads succeed as no-op
    
    // Hardened overflow-safe EOF boundary check
    if (offset >= m_size || size > m_size - offset) {
        return false;
    }

    if (m_fd != 0) {
        int64_t bytesRead = vfs_fs_pread(m_fs, m_fd, offset, out_ptr, size);
        return bytesRead == static_cast<int64_t>(size);
    } else if (m_fs && m_fs->ctx) {
        ptrdiff_t bytesRead = vfs_read_sync(m_fs->ctx, offset, out_ptr, size);
        return bytesRead == static_cast<ptrdiff_t>(size);
    }
    return false;
}
```

Because `offset < m_size` is guaranteed by the first check, `m_size - offset` is always strictly positive and cannot wrap. Comparing `size > m_size - offset` is mathematically immune to overflow for any value of `size` up to `UINT64_MAX`.

---

## 3. Boundary Verification Suite (`src/disc_io/disc_io_test.cpp`)

The native C++ test suite enforces every boundary edge case:

```cpp
// src/disc_io/disc_io_test.cpp (Excerpt)
uint8_t buffer[64];
const uint64_t dummySize = 1048576; // 1 MB

assert(!reader.Read(0, 16, nullptr));                    // Null destination buffer rejected
assert(reader.Read(0, 0, buffer));                       // Zero-byte read succeeds
assert(!reader.Read(dummySize, 1, buffer));              // Read at exact EOF rejected
assert(!reader.Read(dummySize + 10, 1, buffer));         // Read past EOF rejected
assert(!reader.Read(dummySize - 10, 20, buffer));        // Partial read beyond EOF rejected
assert(!reader.Read(dummySize - 1, UINT64_MAX, buffer)); // 64-bit overflow rejected
assert(!reader.Read(UINT64_MAX, 1, buffer));             // Max offset rejected
assert(!reader.Read(100, UINT64_MAX - 50, buffer));      // Wrapping size rejected
```

---

## 4. Boot Sector Header Parser (`src/disc_io/disc_header.cpp`)

Before launching an optical disc, DolphinStream inspects the boot sector to identify the game title, disc ID, and console generation.

### Optical Disc Boot Sector Layout

```text
Offset 0x00..0x05: Game ID (6 ASCII chars, e.g. "GALE01" for Melee, "RMCE01" for Mario Kart Wii)
Offset 0x18..0x1B: Magic Word (Big-Endian uint32)
                   - GameCube Magic: 0xC2339F3D
                   - Wii Magic:      0x5D1C9EA3
Offset 0x20..0x5F: Game Title (Null-terminated ASCII string up to 64 bytes)
```

### Parser Implementation & Magic Verification

```cpp
// src/disc_io/disc_header.cpp (Excerpt)
bool ReadDiscHeader(BlobReader* reader, DiscHeader* header) {
    if (!reader || !header) return false;
    if (reader->GetDataSize() < 0x60) return false; // Minimum header size

    uint8_t sector[0x60];
    if (!reader->Read(0, sizeof(sector), sector)) {
        return false;
    }

    // Extract big-endian magic word at offset 0x18
    uint32_t magic = (static_cast<uint32_t>(sector[0x18]) << 24) |
                     (static_cast<uint32_t>(sector[0x19]) << 16) |
                     (static_cast<uint32_t>(sector[0x1A]) << 8)  |
                      static_cast<uint32_t>(sector[0x1B]);

    header->magic = magic;
    if (magic == 0xC2339F3D) {
        header->platform = Platform::GameCube;
    } else if (magic == 0x5D1C9EA3) {
        header->platform = Platform::Wii;
    } else {
        header->platform = Platform::Unknown;
        return false; // Reject disc image with corrupt magic
    }

    header->gameId = std::string(reinterpret_cast<char*>(sector), 6);
    header->gameTitle = std::string(reinterpret_cast<char*>(sector + 0x20));
    return true;
}
```

This parser runs directly inside `Worker A` during disc mounting (`DISC_IDENTIFY`), allowing the browser UI to display authentic channel banners and platform badges without relying on server-side metadata.
