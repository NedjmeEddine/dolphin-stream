# Chapter 1.1: System Topology & Data Flow

This document details the multi-tier topology of DolphinStream and VFS-Streamer. It explains how to decouple synchronous compute engines (such as emulators, databases, and microVMs) from asynchronous browser network and storage I/O using a `SharedArrayBuffer` synchronization bridge.

---

## 1. The 4-Layer Streaming Stack

Out-of-core block streaming requires four specialized layers operating in unison:

```text
+-----------------------------------------------------------------------------------+
| LAYER 1: Slicer & Compiler (Go CLI: markov-pack)                                 |
| - Inputs: Raw ISO / Disc Directory / Archive                                      |
| - Outputs: manifest.bin + pak_0000.bin ... pak_NNNN.bin                           |
| - Chunks binary into uniform 256 KB blocks (blockShift = 18)                     |
| - Compiles 24-byte path-sorted TOC & 1st-order Markov transition graphs           |
+-----------------------------------------------------------------------------------+
                                          |
                                    (HTTP/HTTPS)
                                          v
+-----------------------------------------------------------------------------------+
| LAYER 2: Origin / Edge Data Plane (Go Server: streamer-server)                   |
| - Stateless HTTP 206 Partial Content range server                                 |
| - Serves /games.json, /games/{gameId}/manifest.bin, /packs/*.bin                 |
| - SIGHUP live reload via atomic snapshot pointers                                 |
| - Thread-safe range serving via io.NewSectionReader (POSIX pread)                 |
| - Ingests client transition logs via /telemetry/transitions                       |
+-----------------------------------------------------------------------------------+
                                          |
                       (HTTP 206 Fetch / OPFS Sync Access Handle)
                                          v
+-----------------------------------------------------------------------------------+
| LAYER 3 & 4: Async I/O & Prefetch Engine (Web Worker: Worker B)                   |
| - Event-driven JavaScript loop (worker_b.js + worker_b_core.mjs)                  |
| - Drains miss_ring on miss_futex signal from Worker A                             |
| - Manages two-phase OPFS persistent cache (/cache_${gameId}.opfs)                 |
| - Executes 1st-order Markov predictive prefetching for top-K neighbors            |
| - Updates 8-way set-associative page directory & wakes Worker A via io_futex      |
+-----------------------------------------------------------------------------------+
                                          |
                 (64 MB SharedArrayBuffer Arena + Futex Doorbell)
                                          v
+-----------------------------------------------------------------------------------+
| LAYER 5: Synchronous Compute Core (WASM Pthread: Worker A)                        |
| - WebAssembly module (vfs.wasm compiled via Emscripten -pthread)                  |
| - Dolphin C++ DiscIO adapter (src/disc_io/vfs_blob_reader.cpp)                    |
| - Layer 5 lock-free virtual filesystem (client/vfs/vfs_fs.c)                      |
| - Synchronous reads: VfsBlobReader::Read(offset, size, out_ptr)                   |
| - Blocks on io_futex (Atomics.wait) during cache misses                           |
+-----------------------------------------------------------------------------------+
```

---

## 2. Decoupling Synchronous Compute from Async I/O

### The Impedance Mismatch

Emulators like Dolphin, databases like SQLite/DuckDB, and hypervisors like QEMU/Firecracker are architected around **synchronous block read contracts**:

```cpp
// Dolphin C++ DiscIO BlobReader interface
virtual bool Read(uint64_t offset, uint64_t size, uint8_t* out_ptr) = 0;
```

When an emulator executes a PowerPC/MIPS instruction that accesses the disc controller, it expects data to be copied into the destination buffer immediately before the CPU instruction cycle completes. 

However, modern browser I/O primitives (`fetch()`, `ReadableStream`, `FileSystemFileHandle.createWritable()`) are strictly **asynchronous**. In the browser main thread or standard Web Worker, you cannot block execution to wait for a promise without freezing the event loop.

### Why Prior Web Approaches Failed

1. **Emscripten Asyncify:** Rewrites the WebAssembly binary at compile time to inject state-machine unwinding and rewinding around every call site that touches I/O.
   * *Drawback:* Massive code bloat (30–60% binary size increase), heavy CPU overhead on the hot path, and catastrophic frame pacing drops in real-time emulators running at 60 FPS.
2. **Synchronous `XMLHttpRequest`:** Deprecated in modern browsers, banned in web workers across many engines, completely lacks HTTP 206 streaming support, and cannot access the Origin Private File System (OPFS).
3. **Pre-Allocation in Memory (`MEMFS`):** Downloading a 1.4 GB–8.5 GB ISO upfront exceeds the 32-bit WebAssembly heap ceiling (maximum 4 GB address space, often constrained to 2 GB in practice by browser memory fragmentation).

---

## 3. The SharedArrayBuffer Mailbox Protocol

DolphinStream solves this impedance mismatch by allocating a single shared memory slab (`WebAssembly.Memory` instantiated with `{ shared: true }`) accessible simultaneously by **Worker A** (synchronous C++/WASM compute) and **Worker B** (asynchronous JavaScript I/O).

The handshake sequence operates as a zero-allocation, lock-free mailbox:

```text
Worker A (WASM Pthread)                                Worker B (Async JS Worker)
----------------------                                --------------------------
1. VfsBlobReader::Read(offset, size, out)
   - Computes block ID: b = offset >> 18
   - Calls try_pin_frame(b)
   - Cache Miss detected!

2. Enqueue Miss:
   - Atomically pushes b to miss_ring
   - Increments miss_futex:
     atomic_fetch_add(&ctrl->miss_futex, 1)
   - hal_futex_wake(&ctrl->miss_futex, 1)

3. Suspend Worker A:
   - Atomics.wait(io_futex, expected)                4. Doorbell Wakeup:
   [Thread completely paused, 0% CPU]                  - Atomics.waitAsync(miss_futex) resolves
                                                       - Drains miss_ring: pops block ID b

                                                    5. Fetch & Cache Resolution:
                                                       - Checks L2 (OPFS SSD cache)
                                                       - If miss: HTTP 206 Partial Content
                                                         fetch(/packs/pak_0000.bin, Range)
                                                       - Copies payload into Slab frame f
                                                       - Updates PageFrameDirectory[f]:
                                                         state = FRAME_READY

                                                    6. Resume Worker A:
                                                       - Increments io_futex
                                                       - Atomics.notify(io_futex, Infinity)

7. Worker A Wakes:
   - Atomics.wait unblocks
   - try_pin_frame(b) succeeds!
   - Copies bytes from Slab[f] to out_ptr
   - Dekker unpin: pin_count--
   - Returns true to emulator core
```

### Mathematical Latency Budget

* **L1 Slab RAM Hit:** $< 100\text{ ns}$ (pure memory copy within SharedArrayBuffer).
* **L2 OPFS SSD Hit:** $\approx 0.8\text{ ms} - 2.5\text{ ms}$ (Chromium synchronous access handle `FileSystemSyncAccessHandle.read()`).
* **Origin HTTP 206 Fetch:** $\approx 15\text{ ms} - 45\text{ ms}$ (over broadband edge network).
* **Markov Predicted Hit:** When Markov prefetching runs ahead of demand reads, network latency drops to $0\text{ ms}$ perceived stall time, because blocks are already resident in L1 slab frames before the emulator executes the read instruction.

---

## 4. Blueprint: Adapting to Other Binary Workloads

This out-of-core streaming architecture is not limited to GameCube/Wii emulation. Any workload requiring synchronous random access over multi-gigabyte datasets can adopt this pattern:

### 1. SQLite & DuckDB in the Browser
* **Problem:** Querying a 10 GB analytical database typically requires downloading the entire database or relying on slow, high-overhead HTTP range extensions.
* **Adaptation:**
  * Implement an SQLite VFS (`sqlite3_vfs`) whose `xRead` method delegates to `vfs_read_sync`.
  * Slice the SQLite database into 64 KB or 256 KB blocks.
  * Analytical queries (e.g., `SELECT COUNT(*) FROM table WHERE col = X`) only stream the b-tree root and the specific table pages referenced, executing queries across gigabytes in milliseconds.

### 2. Browser Linux MicroVMs (v86 / TinyEMU)
* **Problem:** Booting an Ubuntu or Alpine cloud image (2 GB–20 GB) in browser WebAssembly.
* **Adaptation:**
  * Implement the virtio-block device driver backed by `vfs_read_sync`.
  * The Linux kernel boots in $< 2\text{ seconds}$, streaming only the kernel image, systemd units, and loaded shared libraries.

### 3. WebGPU Game Engines (Unreal / Godot / Unity)
* **Problem:** Streaming massive virtual texture megatextures and 3D level geometry without multi-gigabyte loading screens.
* **Adaptation:**
  * Hook the engine's asset streaming manager into `vfs_fs_pread`.
  * Stream mipmap tiles and collision meshes dynamically based on player camera frustum and position.
