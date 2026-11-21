# DolphinStream Developer & Agent Guide 🐬⚡

Welcome to DolphinStream! This document is designed for an agent or developer starting with a fresh context window. It explains the project's architecture, what has been completed, exactly which files to read to implement the next milestones, and rules for gitignore and submodules.

---

## 1. Project Overview & Architecture

DolphinStream is an **out-of-core WebAssembly GameCube & Wii streaming runtime**. It bypasses the 32-bit WASM memory ceiling (4 GB) and long download times by slicing multi-gigabyte ISOs into **256 KB blocks**, streaming them over **HTTP 206 Range requests** into a bounded **64 MB SharedArrayBuffer slab**, and prefetching data using an offline-trained Markov model.

### Process & Threading Topology

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

## 2. Completed Milestones

* **Milestone 1 (Multi-Game Sliced Storage & Server Catalog in Go):**
  - `games.json` schema validation, parser, and fallback synthesis (`internal/server/catalog.go`).
  - Multi-game route dispatch and `BuildEtagHash`-partitioned telemetry logging (`internal/server/server.go`).
  - Unit tests in `internal/server/catalog_test.go`.
* **Milestone 2 (Authentic Wii Home Screen, Audio & Gamepad Loop):**
  - 4x3 channel grid with CRT scanlines, glowing cyan hover halo, and unclipped bottom wave.
  - Zero-dependency procedural Web Audio sound engine (`web/wii_audio.js`).
  - Gamepad API loop with D-Pad & analog deadzones (`web/wii_input.js`).
  - Channel zoom modal with authentic pill buttons ("Wii Menu" & "Start").
* **Milestone 3 (Dolphin WASM DiscIO Linking):**
  - Zero-allocation C++ adapter `DiscIO::VfsBlobReader` (`src/disc_io/vfs_blob_reader.cpp`).
  - C ABI bridge: `vfs_blob_open`, `vfs_blob_read`, `vfs_blob_size`, `vfs_blob_block_size`, `vfs_blob_hint_cold`, `vfs_blob_close`.
  - Boot sector parser extracting GameID, Title, and magic (`0xC2339F3D` GC, `0x5D1C9EA3` Wii) (`src/disc_io/disc_header.cpp`).
  - WebAssembly module compilation (`make wasm`).
  - Worker A dispatch handlers (`DISC_OPEN`, `DISC_IDENTIFY`, `DISC_READ`, `DISC_CLOSE`) verified via Playwright (`npm run test:disc`).

---

## 3. Files & Folders to Read for Next Milestones

When starting work on the upcoming milestones, read these specific files first:

### Milestone 4: WebGPU Canvas Renderer & Live Memory HUD

1. **`web/index.html` (Lines 800–1250)**
   - Houses the emulator viewport (`#viewport-wrapper`), WebGPU canvas (`#emulator-canvas`), and 2D HUD canvas (`#hud-canvas`).
   - Controls bar: aspect ratio toggling (4:3 vs 16:9), fullscreen, and memory HUD toggle (`#btn-toggle-hud`).
   - Handles canvas resize logic maintaining aspect ratio.
2. **`externals/vfs-streamer/client/web/hud_overlay.mjs`**
   - High-performance 2D Canvas renderer that draws the 64 MB slab (256 block frames).
   - Renders frame states: `FRAME_EMPTY`, `FRAME_LOADING` (blue), `FRAME_READY` (green), `FLAG_DIRTY_OPFS` (orange), cold hinted (grey), and Markov prefetch hits.
3. **`externals/vfs-streamer/client/web/webgpu_renderer.mjs` & `webgpu_streamer_core.mjs`**
   - Reference WebGPU rendering pipeline in the repository.
   - Shows how `navigator.gpu.requestAdapter()` and `requestDevice()` are configured, shader pipelines are compiled, and textures are presented.
4. **`externals/vfs-streamer/client/web/worker_b_core.mjs` (Method `getHudSnapshot`)**
   - Shows the exact JSON structure of the telemetry snapshot sent from Worker B to the main thread (`HUD_SNAPSHOT` messages).

### Milestone 5: Dolphin Core Emscripten Integration & Multi-Game Slicing

1. **`src/disc_io/vfs_blob_reader.cpp` & `src/disc_io/vfs_blob_reader.h`**
   - The synchronous C++ DiscIO adapter.
   - Note the dual-mode logic: `m_fd != 0` reads through `vfs_fs_pread` inside VFSI containers; `m_fd == 0` reads raw ISO streams via `vfs_read_sync(m_fs->ctx, ...)`.
2. **`src/disc_io/disc_header.cpp` & `src/disc_io/disc_header.h`**
   - Boot sector magic words and header validation (`0xC2339F3D` for GameCube, `0x5D1C9EA3` for Wii).
3. **`CMakeLists.txt` & `Makefile`**
   - Compiles both native static libraries (`libdolphin_vfs.a`, `disc_io_test`) and WebAssembly modules (`make wasm`).
   - Exported symbols list (`VFS_EXPORTED_FUNCTIONS`) must be kept in sync when adding new C bridge functions.
4. **`externals/vfs-streamer/cmd/markov-pack/main.go`**
   - The CLI tool for slicing raw ISOs into 256 KB blocks and generating `manifest.bin` + `pak_*.bin`.

---

## 4. Submodule & Two-Repo Protocol

* Root repo: `dolphin-stream` (`git@github.com:NedjmeEddine/dolphin-stream.git`)
* Submodule: `externals/vfs-streamer` (`git@github.com:NedjmeEddine/wasm-block-streamer.git`)
* **Strict Commit Order:**
  1. Commit and push inside `externals/vfs-streamer` FIRST.
  2. In root `dolphin-stream`, stage the updated submodule commit pointer (`git add externals/vfs-streamer`), commit, and push.
* **Symlink Invariant:**
  - `http.FileServer` serving `web/` forbids `../` path traversal.
  - Client scripts imported by `web/index.html` (`worker_a.js`, `vfs_offsets.js`, `hud_overlay.mjs`, `vfs.js`, `vfs.wasm`) must be symlinked directly inside `web/`.

---

## 5. Gitignore & Build Artifact Rules

The following files are generated during builds and test runs and **must never be committed to git**:

| Pattern | Description |
|---|---|
| `build/` | Temporary C++ object files and build intermediates |
| `bin/` | Compiled Go binaries (`streamer-server`, `markov-pack`, `tile-gen`) |
| `disc_io_test` | Native C++ test binary |
| `*.o`, `*.a`, `*.so` | Compiled static/dynamic object libraries |
| `*.wasm` (in root/build) | WebAssembly binaries (except verified submodule release bundles) |
| `node_modules` | Node dependencies (both symlink in root and directory in submodule) |
| `dist/`, `dist_e2e/` | Sliced disc packs and generated test archives |
| `transitions/`, `trans_e2e/` | Generated Markov transition logs (`transitions_{etag}.log`) |
| `*.iso`, `*.gcz`, `*.rvz` | GameCube & Wii ROM image files |
| `*.bin` (outside testdata) | Raw archive binaries |

---

## 6. Verification Commands Cheat Sheet

Before pushing changes, run the test suites for the layers you modified:

```bash
# 1. C++ DiscIO Adapter & C ABI Tests
make test

# 2. Worker A Sector Reading in Headless Chromium (Playwright)
npm run test:disc

# 3. Wii Channel Grid & Modal UI Tests (Playwright)
npm run test:ui

# 4. Viewport Presentation, Aspect Ratio Toggle, & Live HUD Tests (Playwright)
npm run test:viewport

# 5. Web Audio Synthesizer & Gamepad Loop Unit Tests
node --test web/wii_audio.test.mjs web/wii_input.test.mjs

# 6. Go Range Server & Multi-Game Catalog Tests (with race detector)
cd externals/vfs-streamer && go test -count=1 -race ./...

# 7. C11 VFS Multi-Threading & Dekker Memory Ordering Suite (with TSan)
make -C externals/vfs-streamer/client/vfs test

# 8. JavaScript Worker Core & WebGPU Scheduler Tests
cd externals/vfs-streamer && node --test client/web/worker_b_core.test.mjs client/web/webgpu_streamer_core.test.mjs

# 9. Rebuild WebAssembly Module (vfs.js + vfs.wasm)
source ~/.local/share/emsdk/emsdk_env.sh && make wasm
```
