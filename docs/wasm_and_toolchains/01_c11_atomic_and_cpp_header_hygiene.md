# Chapter 4.1: C11 Atomics & C++ Header Hygiene

This document describes the header hygiene rules and macro isolation patterns required to bridge the C11 VFS engine (`client/vfs`) with Dolphin's modern C++20 emulator core (`src/disc_io`).

---

## 1. The C11 `_Atomic` vs. C++ `<atomic>` Collision

In C11, atomics were introduced as a language keyword and type qualifier:
```c
_Atomic uint32_t pin_count;
```
In C++, atomics are implemented as a standard library template class:
```cpp
#include <atomic>
std::atomic<uint32_t> pin_count;
```

### The Clang/GCC Macro Explosion

When C++ code needs to include C11 headers containing `_Atomic`, developers frequently attempt a naive compatibility workaround:

```cpp
// DANGEROUS WORKAROUND (DO NOT PUT IN HEADERS)
#define _Atomic
#define _Static_assert static_assert
#include "vfs_client.h"
```

### The Fatal Compiler Errors

If `#define _Atomic` is placed in a header file (such as `src/disc_io/vfs_blob_reader.h`) that is subsequently included across other C++ translation units:

1. **Destruction of Standard Library Headers:**
   When `<memory>`, `<atomic>`, or `<thread>` is subsequently parsed by Clang, the preprocessor strips `_Atomic` from internal compiler intrinsics (such as `__c11_atomic_load` or GCC `__atomic_base<_Tp>`).
   ```text
   In file included from /usr/include/c++/13/memory:78:
   /usr/include/c++/13/bits/shared_ptr_base.h:541: error: expected unqualified-id before '_Atomic'
   /usr/include/c++/13/bits/atomic_base.h:320: error: redefinition of '_Atomic'
   ```
2. **Template Deduction Failure:**
   The C++ compiler fails to deduce template types for `std::make_shared` and `std::unique_ptr` because type qualifiers have been mangled.

---

## 2. The Strict Header Isolation Rule

To eliminate this collision permanently, DolphinStream enforces a strict architectural boundary:

> **Header Invariant:**  
> `src/disc_io/vfs_blob_reader.h` must remain pure C++. It must **never** `#define _Atomic`, `#define _Static_assert`, or include any C11 headers (`vfs_client.h`, `vfs_fs.h`).

### Forward Declaration Pattern

Instead of including `vfs_fs.h`, `vfs_blob_reader.h` forward-declares the opaque C struct:

```cpp
// src/disc_io/vfs_blob_reader.h (Excerpt)
#ifndef VFS_BLOB_READER_H
#define VFS_BLOB_READER_H

#include <cstdint>
#include <cstddef>
#include <memory>
#include <string>

// Forward declaration of Layer 5 VFS handle from submodule
struct VfsFs;

namespace DiscIO {

class VfsBlobReader : public BlobReader {
public:
    static std::unique_ptr<VfsBlobReader> Create(VfsFs* fs, const std::string& path);
    VfsBlobReader(VfsFs* fs, uint32_t fd, uint64_t discSize);
    ~VfsBlobReader() override;

    uint64_t GetDataSize() const override { return m_size; }
    uint64_t GetRawSize() const override { return GetDataSize(); }
    uint64_t GetBlockSize() const override;

    bool Read(uint64_t offset, uint64_t size, uint8_t* out_ptr) override;
    void HintCold(uint64_t offset, uint64_t size);

private:
    VfsFs*   m_fs;
    uint32_t m_fd;
    uint64_t m_size;
};

} // namespace DiscIO
```

Any C++ translation unit in Dolphin can now include `vfs_blob_reader.h` alongside `<memory>`, `<vector>`, and `<atomic>` without preprocessor corruption.

---

## 3. Translation Unit Confinement (`.cpp`)

The C11 compatibility definitions are confined strictly to the `.cpp` file (`src/disc_io/vfs_blob_reader.cpp`):

```cpp
// src/disc_io/vfs_blob_reader.cpp (Excerpt)
#include "vfs_blob_reader.h"
#include <iostream>

// Confine C11 atomic and assertion macros to this single translation unit
#if !defined(__clang__) && !defined(_Atomic)
#define _Atomic
#endif
#ifndef _Static_assert
#define _Static_assert static_assert
#endif

// Include C11 submodule headers within extern "C"
extern "C" {
#include "externals/vfs-streamer/client/vfs/vfs_client.h"
#include "externals/vfs-streamer/client/vfs/vfs_fs.h"
}
```

Because these macros are defined **after** all standard C++ library headers have already been parsed and are never exported to any other file, compiler intrinsics remain untouched.

---

## 4. The C ABI Export Bridge

To allow JavaScript in Worker A to call `VfsBlobReader` without C++ name mangling, `vfs_blob_reader.h` exports a flat C ABI using opaque pointer handles:

```cpp
// src/disc_io/vfs_blob_reader.h (Excerpt)
#ifdef __cplusplus
extern "C" {
#endif

typedef struct VfsBlobReaderOpaque VfsBlobReaderOpaque;

VfsBlobReaderOpaque* vfs_blob_open(struct VfsFs* fs, const char* path);
int32_t  vfs_blob_read(VfsBlobReaderOpaque* reader, uint64_t offset, 
                       uint64_t size, uint8_t* out_ptr);
uint64_t vfs_blob_size(const VfsBlobReaderOpaque* reader);
uint64_t vfs_blob_block_size(const VfsBlobReaderOpaque* reader);
void     vfs_blob_hint_cold(VfsBlobReaderOpaque* reader, uint64_t offset, uint64_t size);
void     vfs_blob_close(VfsBlobReaderOpaque* reader);

#ifdef __cplusplus
}
#endif
```

Inside `vfs_blob_reader.cpp`, implementations simply cast between `VfsBlobReaderOpaque*` and `DiscIO::VfsBlobReader*`:

```cpp
int32_t vfs_blob_read(VfsBlobReaderOpaque* reader, uint64_t offset, 
                      uint64_t size, uint8_t* out_ptr) {
    if (!reader) return 0;
    auto* r = reinterpret_cast<DiscIO::VfsBlobReader*>(reader);
    return r->Read(offset, size, out_ptr) ? 1 : 0;
}
```

This ensures a robust, type-safe boundary between C++, C11, and WebAssembly runtime exports.
