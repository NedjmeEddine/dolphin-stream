# DolphinStream & VFS-Streamer Engineering Field Guide & Post-Mortem

Welcome to the definitive engineering documentation and field guide for **DolphinStream** and its underlying core engine, **VFS-Streamer**.

This runtime represents a breakthrough architecture: **out-of-core WebAssembly predictive block streaming**. It executes multi-gigabyte GameCube (1.4 GB) and Wii (4.7–8.5 GB) disc images inside a standard browser tab without downloading the full ISO upfront and without exceeding WebAssembly's 32-bit (4 GB) address space ceiling.

---

## 1. The Core Engineering Challenge

Traditional WebAssembly ports of emulators, hypervisors, and database engines rely on one of two naive storage strategies:

1. **Pre-Download Everything (In-Memory `MEMFS`):** The application downloads the complete 1.4 GB–8.5 GB disc image into browser heap memory before boot.
   * *Failure Mode:* Multi-minute initial load times, high server bandwidth costs, and immediate Out-Of-Memory (OOM) crashes on 32-bit WASM runtimes when files exceed 2–4 GB.
2. **Synchronous Emscripten `FETCH` / Asyncify:** The runtime pauses execution on every synchronous read and converts it to an asynchronous HTTP fetch.
   * *Failure Mode:* Extreme CPU overhead, audio stuttering, 10–50x performance degradation, and massive binary size inflation due to unwinding/rewinding C++ call stacks at 60 FPS.

### The DolphinStream Solution

DolphinStream decouples **synchronous high-performance compute** (running at 60 FPS in a dedicated WebAssembly pthread) from **asynchronous browser network and disk I/O** (running in an event-driven Web Worker). 

The two worlds meet across a bounded **64 MB `SharedArrayBuffer` arena**. Missing 256 KB blocks are prefetched ahead of time using an offline-trained **1st-order Markov transition model**, achieving $\ge 90\%$ cache hit rates on real gameplay tours.

```text
+-----------------------------------------------------------------------------------------+
| Browser Main Presentation Thread (web/index.html)                                      |
| - Authentic 2000s Nintendo Wii Channel Grid (HTML/CSS + SVG bottom swoop wave)         |
| - Zero-asset procedural Web Audio sound synthesizer (web/wii_audio.js)                 |
| - Gamepad API navigation loop with analog stick deadzone (web/wii_input.js)            |
| - WebGPU canvas viewport (#emulator-canvas) + 2D Memory HUD Overlay (#hud-canvas)      |
+-----------------------------------------------------------------------------------------+
                                            |
                         (DiscIO Read Request via MessagePort)
                                            v
+-----------------------------------------------------------------------------------------+
| Worker A: WASM Pthread (worker_a.js + vfs.wasm)                                         |
| - Dolphin C++ DiscIO adapter (src/disc_io/vfs_blob_reader.cpp)                          |
| - Synchronous reads: VfsBlobReader::Read(offset, size, out)                             |
| - Enqueues cache misses to SabControlHeader miss_ring and blocks on io_futex (Atomics)  |
+-----------------------------------------------------------------------------------------+
                                            |
                      (64 MB SharedArrayBuffer: 256 x 256 KB Frames)
                                            v
+-----------------------------------------------------------------------------------------+
| Worker B: Async I/O & Prefetch Engine (worker_b.js + worker_b_core.mjs)                 |
| - Resolves demand misses via HTTP 206 Partial Content fetches from range server         |
| - Two-phase OPFS SSD write-behind cache (/cache.opfs) and save persistence (/saves/)    |
| - Markov predictor: prefetches top-K predicted neighbor blocks ahead of reads          |
| - Streams live memory HUD snapshots to main thread                                      |
+-----------------------------------------------------------------------------------------+
                                            |
                         (HTTP 206 Partial Content /packs/...)
                                            v
+-----------------------------------------------------------------------------------------+
| Go Range & Catalog Server (bin/streamer-server)                                         |
| - Serves /games.json multi-game catalog (or synthesizes from root manifest.bin)         |
| - Serves /games/{gameId}/manifest.bin and /games/{gameId}/packs/*                       |
| - Flushes client Markov transition logs to transitions_{etag}.log                       |
+-----------------------------------------------------------------------------------------+
```

---

## 2. Invariant Cheat Sheet (The Ground Rules)

When modifying or extending this codebase, the following invariants are absolute:

1. **Zero Allocations on the Read Hot Path:** Neither `vfs_read_sync`, `vfs_fs_pread`, nor `VfsBlobReader::Read` may ever call `malloc`, `free`, or `new`.
2. **Dekker Sequential Consistency:** Cross-worker atomic pinning (`try_pin_frame`) and eviction (`vfs_policy_allocate`) must use `memory_order_seq_cst` in C and `Atomics` operations in JS.
3. **No Clamping on EOF:** `VfsBlobReader::Read` must return `false` on any read that crosses EOF. Clamping `toRead` and returning `true` injects uninitialized memory into emulator RAM.
4. **Non-Sticky Network Errors:** Network errors must never set sticky global flags. Only the current demand read cycle may abort (`failed_rounds >= 3`), leaving cached and future reads intact.
5. **Two-Phase OPFS Commit:** In the browser Origin Private File System cache, data payloads must be flushed to storage *before* updating and flushing the presence bitmap.
6. **Thread-Safe Range Serving:** The Go HTTP server must wrap file handles in `io.NewSectionReader` to invoke stateless POSIX `pread`. Never pass raw `*os.File` handles to `http.ServeContent`.
7. **Header Hygiene:** C11 macros (`#define _Atomic`, `#define _Static_assert`) must never appear in C++ headers (`vfs_blob_reader.h`). Forward-declare C structs and isolate C11 headers to `.cpp` files.

---

## 3. Guide Directory Index

This field guide is divided into six specialized engineering chapters:

### Chapter 1: Architecture & Data Flow (`docs/architecture/`)
* **[01. System Topology & Data Flow](./architecture/01_system_topology_and_data_flow.md):** The 4-layer stack, decoupling synchronous WASM pthreads from browser async I/O via `SharedArrayBuffer`, and blueprints for porting other binary workloads (SQLite, hypervisors, game engines).
* **[02. Memory Arena & ABI Layout](./architecture/02_memory_arena_and_abi_layout.md):** 64 MB arena geometry, 8-way set-associative page frame directory, and the `gen_offsets.c` codegen gate.
* **[03. Layer 5 Lock-Free Virtual Filesystem](./architecture/03_layer5_lockfree_vfs.md):** 64-bit generation-stamped handles, lock-free slot reclamation without ABA, and 64 MiB POSIX slicing preventing 32-bit pointer overflow.

### Chapter 2: Concurrency & Synchronization Traps (`docs/synchronization/`)
* **[01. Dekker Memory Ordering](./synchronization/01_dekker_memory_ordering.md):** Why mutexes deadlock across workers, the double-checked atomic pinning sequence, and ThreadSanitizer verification.
* **[02. Error Generation & Rollback Sequencing](./synchronization/02_error_generation_and_rollbacks.md):** The `io_error_gen` protocol, demand vs. prefetch rollback rules, and non-sticky I/O recovery.
* **[03. Save State Abandonment](./synchronization/03_save_state_abandonment.md):** The tri-state `save_abandoned` protocol preventing deadlocks when slow OPFS writes exceed frame deadlines.

### Chapter 3: Networking & Backend Traps (`docs/networking_and_backend/`)
* **[01. Thread-Safe HTTP Range Serving](./networking_and_backend/01_threadsafe_http_range_serving.md):** Why `*os.File` corrupts concurrent range requests, stateless `pread` via `io.NewSectionReader`, and stripping `If-Range` headers to prevent 200 OK downgrades.
* **[02. POSIX Append Traps & Telemetry](./networking_and_backend/02_posix_append_trap_and_telemetry.md):** The `O_APPEND` vs. `WriteAt(0)` kernel trap in Go, atomic SIGHUP live reload, and routing telemetry by `BuildEtagHash`.
* **[03. Multi-Game Catalog & Route Dispatch](./networking_and_backend/03_multi_game_catalog_and_dispatch.md):** `games.json` schema validation, automatic single-game synthesis fallback, and dynamic sub-game route dispatch.

### Chapter 4: WebAssembly & Toolchain Hygiene (`docs/wasm_and_toolchains/`)
* **[01. C11 Atomics & C++ Header Hygiene](./wasm_and_toolchains/01_c11_atomic_and_cpp_header_hygiene.md):** Resolving macro collisions between C11 `_Atomic` and C++20 `<atomic>`, forward declaration patterns, and isolating C headers.
* **[02. Emscripten Multi-Pass Compilation](./wasm_and_toolchains/02_emscripten_multi_pass_compilation.md):** Why compiling `.c` and `.cpp` in a single command fails, structuring two-stage builds in Makefiles, and exporting C ABI symbols.
* **[03. Cross-Origin Isolation & Path Traversal](./wasm_and_toolchains/03_cross_origin_isolation_and_paths.md):** `COOP`/`COEP` security headers, browser `SharedArrayBuffer` requirements, and resolving Go `http.FileServer` `../` traversal bans via symlinks.

### Chapter 5: Storage, Caching & Boundary Contracts (`docs/storage_and_caching/`)
* **[01. Strict EOF & Boundary Contracts](./storage_and_caching/01_strict_eof_and_boundary_contracts.md):** The Dolphin DiscIO EOF contract, 64-bit integer overflow protection (`size > m_size - offset`), and dual-mode raw ISO vs. VFSI reading.
* **[02. OPFS Two-Phase Commit](./storage_and_caching/02_opfs_two_phase_commit.md):** Crash-safe write-behind caching, flushing payloads before presence bitmaps, and partitioning storage by `gameId`.
* **[03. 1st-Order Markov Prefetch Tuning](./storage_and_caching/03_markov_prefetch_tuning.md):** Transition probability graphs, tuning top-$K$ ($K=2..4$), cooldown suppression, and dirty frame eviction gates.

### Chapter 6: Frontend, Audio & Viewport (`docs/frontend_and_ui/`)
* **[01. Authentic Wii Shell, Audio & Gamepad Loop](./frontend_and_ui/01_wii_shell_audio_and_input.md):** Zero-asset procedural Web Audio synthesis, Gamepad API polling with deadzone filters, and worker lifecycle teardown.
* **[02. WebGPU Pipeline & Live Memory HUD](./frontend_and_ui/02_webgpu_and_memory_hud.md):** WebGPU 1.0 textured quad presentation, canvas aspect ratio management, and the high-performance 2D slab telemetry inspector.

---

## 4. Quick Verification Reference

When verifying changes across the repository stack:

```bash
# 1. Dolphin DiscIO C++ tests (BlobReader, C ABI, Boot Sector Parser)
make test

# 2. Worker A DiscIO sector reader integration test (Playwright)
npm run test:disc

# 3. Wii UI Playwright layout & transition tests
npm run test:ui

# 4. Viewport presentation, aspect ratio toggle (4:3 vs 16:9), and live HUD test (Playwright)
npm run test:viewport

# 5. Web Audio & Gamepad navigation unit tests
node --test web/wii_audio.test.mjs web/wii_input.test.mjs

# 6. Go backend & catalog tests (with race detector)
cd externals/vfs-streamer && go test -count=1 -race ./...

# 7. C11 VFS multi-threading suite (with ThreadSanitizer)
make -C externals/vfs-streamer/client/vfs test

# 8. JavaScript worker core & WebGPU scheduler tests
cd externals/vfs-streamer && node --test client/web/worker_b_core.test.mjs client/web/webgpu_streamer_core.test.mjs

# 9. Rebuild WebAssembly binary module (vfs.js + vfs.wasm)
source ~/.local/share/emsdk/emsdk_env.sh && make wasm
```
