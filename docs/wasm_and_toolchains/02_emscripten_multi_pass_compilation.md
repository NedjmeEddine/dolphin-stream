# Chapter 4.2: Emscripten Multi-Pass Compilation & BigInt IPC

This document explains the WebAssembly build pipeline, focusing on language dialect separation (`emcc` vs `em++`), 64-bit integer IPC (`-sWASM_BIGINT`), and modular ES6 WebAssembly compilation.

---

## 1. The Emscripten Standard Mixing Trap

DolphinStream combines two distinct codebases with different language standard requirements:
1. **Core VFS Engine (`externals/vfs-streamer/client/vfs`):** Written in pure **C11** (`-std=c11`), relying on C11 `_Atomic`, anonymous unions, and POSIX futex extensions (`_GNU_SOURCE`).
2. **Dolphin DiscIO Adapter (`src/disc_io`):** Written in modern **C++20** (`-std=c++20`), relying on `std::unique_ptr`, `constexpr`, and modern template abstractions.

### The Single-Command Failure Mode

When developers attempt to compile all sources in a single command:

```bash
# FAILS: Single-command compilation mixing C and C++
emcc -std=c++20 -O2 \
  client/vfs/vfs_client.c \
  src/disc_io/vfs_blob_reader.cpp \
  -o vfs.js
```

Emscripten uses Clang under the hood. When given a single dialect flag (`-std=c++20`):
* Clang applies C++ dialect rules to `.c` files, triggering warnings and errors on C-style struct initializers, `void*` implicit casts, and C11 atomics.
* Conversely, if `-std=c11` is passed, `vfs_blob_reader.cpp` fails to compile because C++20 standard library headers are rejected by a C11 preprocessor.

---

## 2. Multi-Pass Compilation Pipeline

To eliminate dialect collisions, DolphinStream’s `Makefile` enforces a **three-stage multi-pass compilation architecture**:

```text
STAGE 1: C11 Compilation Pass (emcc)
  vfs_client.c  ---> [ emcc -std=c11 -pthread -O2 ] ---> build/embuild/vfs_client.o
  vfs_hal.c     ---> [ emcc -std=c11 -pthread -O2 ] ---> build/embuild/vfs_hal.o
  vfs_policy.c  ---> [ emcc -std=c11 -pthread -O2 ] ---> build/embuild/vfs_policy.o
  vfs_fs.c      ---> [ emcc -std=c11 -pthread -O2 ] ---> build/embuild/vfs_fs.o

STAGE 2: C++20 Compilation Pass (em++)
  vfs_blob_reader.cpp ---> [ em++ -std=c++20 -pthread -O2 ] ---> build/embuild/vfs_blob_reader.o
  disc_header.cpp     ---> [ em++ -std=c++20 -pthread -O2 ] ---> build/embuild/disc_header.o

STAGE 3: Link & Module Synthesis Pass (em++)
  All Object Files (*.o) ---> [ em++ -pthread -sWASM_BIGINT ... ] ---> web/vfs.js + web/vfs.wasm
```

### The Makefile Implementation (`Makefile: wasm`)

```makefile
EMCC ?= emcc
EMCXX ?= em++
BUILD_DIR = build
VFS_DIR = externals/vfs-streamer/client/vfs

wasm:
	mkdir -p $(BUILD_DIR)/embuild
	
	# Stage 1: C11 Object Pass
	$(EMCC) -std=c11 -O2 -pthread -I. -I$(VFS_DIR) -Isrc -Isrc/disc_io -c $(VFS_DIR)/vfs_client.c -o $(BUILD_DIR)/embuild/vfs_client.o
	$(EMCC) -std=c11 -O2 -pthread -I. -I$(VFS_DIR) -Isrc -Isrc/disc_io -c $(VFS_DIR)/vfs_hal.c -o $(BUILD_DIR)/embuild/vfs_hal.o
	$(EMCC) -std=c11 -O2 -pthread -I. -I$(VFS_DIR) -Isrc -Isrc/disc_io -c $(VFS_DIR)/vfs_policy.c -o $(BUILD_DIR)/embuild/vfs_policy.o
	$(EMCC) -std=c11 -O2 -pthread -I. -I$(VFS_DIR) -Isrc -Isrc/disc_io -c $(VFS_DIR)/vfs_fs.c -o $(BUILD_DIR)/embuild/vfs_fs.o
	
	# Stage 2: C++20 Object Pass
	$(EMCXX) -std=c++20 -O2 -pthread -I. -I$(VFS_DIR) -Isrc -Isrc/disc_io -c src/disc_io/vfs_blob_reader.cpp -o $(BUILD_DIR)/embuild/vfs_blob_reader.o
	$(EMCXX) -std=c++20 -O2 -pthread -I. -I$(VFS_DIR) -Isrc -Isrc/disc_io -c src/disc_io/disc_header.cpp -o $(BUILD_DIR)/embuild/disc_header.o
	
	# Stage 3: Link Pass
	$(EMCXX) -O2 -pthread \
	  -sIMPORTED_MEMORY=1 -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=4294967296 -sALLOW_MEMORY_GROWTH=1 \
	  -sWASM_BIGINT \
	  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createVfsModule \
	  -sEXPORTED_FUNCTIONS='["_vfs_init_arena","_vfs_attach_arena","_vfs_read_sync","_vfs_hint_cold","_vfs_save_write_sync","_vfs_save_read_sync","_vfs_fs_mount","_vfs_fs_unmount","_vfs_fs_stat","_vfs_fs_open","_vfs_fs_read","_vfs_fs_pread","_vfs_fs_seek","_vfs_fs_tell","_vfs_fs_close","_vfs_fs_hint_cold","_vfs_blob_open","_vfs_blob_read","_vfs_blob_size","_vfs_blob_block_size","_vfs_blob_hint_cold","_vfs_blob_close","_vfs_blob_identify","_aligned_alloc","_malloc","_free"]' \
	  $(BUILD_DIR)/embuild/*.o \
	  -o $(VFS_DIR)/../web/vfs.js
```

---

## 3. The `-sWASM_BIGINT` Invariant

Wii optical discs range up to **8.5 GB** (dual-layer DVD-9). A byte offset into a Wii disc cannot fit inside a standard 32-bit integer ($2^{32} - 1 \approx 4.29\text{ GB}$).

In WebAssembly, 64-bit integers (`i64`) have native hardware representation in WASM virtual machines. However, the default JavaScript WebAssembly bridge cannot convert JavaScript numbers to `i64`:
* Without `-sWASM_BIGINT`, Emscripten splits 64-bit parameters into pairs of 32-bit low/high integers (`offset_low, offset_high`) or throws:
  `TypeError: Conversion from Number to BigInt not supported`.
* Passing `-sWASM_BIGINT` enables native hardware mapping between WebAssembly `i64` and JavaScript `BigInt` primitives (`0n..18446744073709551615n`).

### Worker A BigInt Calling Pattern

In `client/web/worker_a.js`, disc read calls pass native 64-bit integers:

```javascript
// client/web/worker_a.js (Excerpt)
const offset = BigInt(msg.offset || 0); // Native 64-bit BigInt
const len = Number(msg.len);

const success = wasmModule._vfs_blob_read(blobReaderPtr, offset, BigInt(len), scratchBufPtr);
if (success === 1) {
    const bytes = new Uint8Array(wasmMemory.buffer, scratchBufPtr, len).slice();
    self.postMessage({ type: 'DISC_READ_RES', id: msg.id, ok: true, bytes: bytes.buffer }, [bytes.buffer]);
}
```

---

## 4. ES6 Modularization (`-sMODULARIZE=1 -sEXPORT_ES6=1`)

Modern web applications use ES modules (`import / export`) rather than polluting the browser `window` global scope.

Emscripten flags:
* `-sMODULARIZE=1`: Wraps the entire compiled runtime inside a factory function (`createVfsModule()`).
* `-sEXPORT_ES6=1`: Emits clean `export default createVfsModule;`.
* `-sIMPORTED_MEMORY=1`: Instructs the WASM instance not to allocate its own private memory, but instead to import the `SharedArrayBuffer` passed via `Module.wasmMemory`.

---

## 5. CMake Target Source Parity vs. Makefile (Commit `3d6394b`)

When creating native C++ unit tests that mirror the WebAssembly export surface, maintainers must ensure source-list parity between `Makefile` and `CMakeLists.txt`.

### The Missing Symbol Linker Trap

In `src/disc_io/disc_io_test.cpp`, the test runner verifies both the synchronous reader (`vfs_blob_reader.cpp`) and the boot sector parser (`disc_header.cpp`):

```cpp
#include "vfs_blob_reader.h"
#include "disc_header.h"
// ...
assert(DiscIO::ReadDiscHeader(&gcDisc, &gcHdr));
```

If `CMakeLists.txt` defines its native test executable by enumerating individual source files:

```cmake
# BROKEN: Misses disc_header.cpp
add_executable(disc_io_test
    src/disc_io/disc_io_test.cpp
    src/disc_io/vfs_blob_reader.cpp
    ${VFS_SOURCES}
)
```

Building through CMake fails during linking:
```text
undefined reference to `DiscIO::ReadDiscHeader(DiscIO::BlobReader*, DiscIO::DiscHeader*)'
undefined reference to `vfs_blob_identify'
```

### The Fix: Unified Source Group Variables

Commit `3d6394b` groups all DiscIO sources under `${DISC_IO_SOURCES}`:

```cmake
# CMakeLists.txt (Excerpt)
set(DISC_IO_SOURCES
    src/disc_io/vfs_blob_reader.cpp
    src/disc_io/disc_header.cpp
)

add_executable(disc_io_test
    src/disc_io/disc_io_test.cpp
    ${DISC_IO_SOURCES}
    ${VFS_SOURCES}
)
```

This guarantees that newly added translation units in `src/disc_io/` automatically compile into both the native test executable (`disc_io_test`) and the Emscripten WebAssembly module (`vfs.wasm`).
