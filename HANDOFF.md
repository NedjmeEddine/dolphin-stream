# DolphinStream — Comprehensive Project & Architecture Handoff

> **To the Next Agent / Developer:** Read this document first. It contains the complete architectural context, codebase map, verified test commands, hard-earned invariants, and the exact roadmap for Phase 2.

---

## 1. Project Overview & Process Topology

**DolphinStream** is an out-of-core WebAssembly GameCube & Wii streaming runtime. It solves the 32-bit WASM memory ceiling (4 GB) and long download times by slicing multi-gigabyte ISOs into **256 KB blocks**, streaming them over **HTTP 206 Range requests** into a strictly bounded **64 MB SharedArrayBuffer slab**, and prefetching data using an offline-trained **1st-order Markov model**.

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
| - Two-phase OPFS SSD write-behind cache (/cache_${gameId}.opfs) and saves (/saves/)    |
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

## 2. Git & Two-Repo Submodule Rules

* **Root Repository (`dolphin-stream`):**
  - Remote: `git@github.com:NedjmeEddine/dolphin-stream.git` (Branch: `main`)
  - Contains DiscIO C++ adapter (`src/disc_io/`), Wii UI shell (`web/`), tests, and build scripts.
* **Submodule (`externals/vfs-streamer`):**
  - Remote: `git@github.com:NedjmeEddine/wasm-block-streamer.git` (Branch: `main`)
  - Contains Go HTTP server (`cmd/streamer-server`), slicer (`cmd/markov-pack`), C11 VFS engine (`client/vfs/`), and JS worker core (`client/web/`).

### Invariant 1: Strict Commit & Push Order
1. Always commit and push inside `externals/vfs-streamer` **FIRST**.
2. Stage the submodule pointer update in root (`git add externals/vfs-streamer`), commit, and push in root **SECOND**.

### Invariant 2: Symlink Hygiene in `web/`
Go's `http.FileServer` serving `./web` strictly forbids `../` path traversal. Any client script imported by `web/index.html` **must be symlinked directly inside `web/`**:
- `web/worker_a.js -> ../externals/vfs-streamer/client/web/worker_a.js`
- `web/worker_b.js -> ../externals/vfs-streamer/client/web/worker_b.js`
- `web/worker_b_core.mjs -> ../externals/vfs-streamer/client/web/worker_b_core.mjs`
- `web/vfs_offsets.js -> ../externals/vfs-streamer/client/web/vfs_offsets.js`
- `web/hud_overlay.mjs -> ../externals/vfs-streamer/client/web/hud_overlay.mjs`
- `web/webgpu_renderer.mjs -> ../externals/vfs-streamer/client/web/webgpu_renderer.mjs`
- `web/vfs.js -> ../externals/vfs-streamer/client/web/vfs.js`
- `web/vfs.wasm -> ../externals/vfs-streamer/client/web/vfs.wasm`

---

## 3. Phase 1 Accomplishments (Milestones 1–5 Complete)

All five milestones of Phase 1 are fully built, tested, and pushed to `main`:

* **Milestone 1 (Multi-Game Catalog Server):**
  - `internal/server/catalog.go`: `games.json` schema validation and automatic fallback synthesis.
  - `internal/server/server.go`: Multi-game route dispatch and `BuildEtagHash`-partitioned telemetry logging.
* **Milestone 2 (Authentic Wii UI, Audio & Gamepad Loop):**
  - `web/index.html`: 4x3 channel grid with CRT scanlines, cyan glow hover halo, and unclipped SVG bottom wave.
  - `web/wii_audio.js`: Zero-asset procedural Web Audio synthesizer.
  - `web/wii_input.js`: Gamepad API polling loop with analog stick deadzone filtering.
* **Milestone 3 (Dolphin WASM DiscIO Linking):**
  - `src/disc_io/vfs_blob_reader.cpp`: Zero-allocation `DiscIO::BlobReader` adapter with raw ISO fallback.
  - `src/disc_io/disc_header.cpp`: GameCube and Wii boot sector magic word parser (`0xC2339F3D` GC, `0x5D1C9EA3` Wii) and GameID extractor (`vfs_blob_identify`).
  - `Makefile`: `make wasm` rule compiling C11 and C++20 via multi-pass Emscripten flags.
* **Milestone 4 (WebGPU Canvas Renderer & Live Memory HUD):**
  - `web/webgpu_renderer.mjs`: WebGPU 1.0 textured quad WGSL pipeline with 2D mock fallback.
  - `web/index.html`: Dynamic aspect ratio toggling (4:3 CRT standard vs 16:9 widescreen) with dual-layer canvas buffer resizing (`854x480` / `640x480`).
  - `web/hud_overlay.mjs`: Real-time 2D memory slab HUD overlay rendering 256 physical block states at 30 FPS.
* **Milestone 5 (Multi-Game Slicing & Capstone Integration):**
  - `scripts/gen_mock_games.mjs`: Mock disc generator and slicer for GameCube (`GALE01`) and Wii (`RMCE01`).
  - Real decompressed ISOs: `ROMs/zelda_tp.iso` (4.7 GB, `RZDE01`), `ROMs/mkwii.iso` (4.65 GB, `RMCE01`).
  - Sliced game packs in `dist/games/zelda_tp` (17,929 blocks) and `dist/games/mkwii` (17,756 blocks).
  - Platform-aware aspect ratio auto-selection (4:3 for GameCube, 16:9 for Wii).

---

## 4. Critical Technical Lessons & Bugs Fixed

Before writing any new code, read these lessons:

1. **`TextDecoder` SharedArrayBuffer Exception (`worker_a.js:311-312`):**
   - Modern browsers throw `TypeError: The provided ArrayBufferView value must not be shared` if `TextDecoder.decode()` is passed a view on a `SharedArrayBuffer`.
   - **Fix:** Always call `.slice()` (not `.subarray()`) on `TypedArray` views before passing to `TextDecoder`.
2. **DiscIO Strict EOF & 64-Bit Integer Overflow (`src/disc_io/vfs_blob_reader.cpp:62`):**
   - `VfsBlobReader::Read` must never clamp and return `true` on partial reads at EOF; doing so injects garbage uninitialized memory into the emulator.
   - Prevent 64-bit unsigned addition overflow: use `if (offset >= m_size || size > m_size - offset) return false;`.
3. **Multi-Game OPFS Partitioning (`worker_b.js:77-85`):**
   - Always name cache files `cache_${gameId}.opfs` and saves `/saves/${gameId}/`. Sharing a global `cache.opfs` causes game switches to wipe cached blocks due to `BuildEtagHash` mismatch.
4. **Wii Menu Exit Teardown (`web/index.html:1320-1335`):**
   - Clicking "Wii Menu" must call `exitToMenu()`: flush telemetry (`flushTelem('menu')`), terminate `workerA` and `workerB`, and cancel stream timers to prevent background worker leaks.
5. **Gamepad API Pre-Connection State:**
   - Browsers only fire `gamepadconnected` when a controller is attached *while* the page is active. Always call `checkConnectedGamepad()` on page load to probe `navigator.getGamepads()`.
6. **CMake Target Parity (`CMakeLists.txt:70-74`):**
   - Link `${DISC_IO_SOURCES}` (including `disc_header.cpp`) into `disc_io_test` to prevent undefined reference linker errors.

---

## 5. Verification Commands (Cheat Sheet)

Run these commands from the repository root:

```bash
# 1. Full Multi-Game End-to-End Streaming & Boot Verification (Playwright)
npm run test:e2e

# 2. Viewport Presentation, Aspect Ratio Toggle, & Live HUD Test (Playwright)
npm run test:viewport

# 3. Wii Channel Grid Layout & Transition Tests (Playwright)
npm run test:ui

# 4. Worker A DiscIO Sector Reader Test (Playwright)
npm run test:disc

# 5. Root DiscIO C++ Adapter Tests
make test

# 6. Web Audio Synthesizer & Gamepad Navigation Unit Tests
node --test web/wii_audio.test.mjs web/wii_input.test.mjs

# 7. Go Backend & Catalog Tests (with race detector)
cd externals/vfs-streamer && go test -count=1 -race ./...

# 8. C11 VFS Multi-Threading Suite (with ThreadSanitizer)
make -C externals/vfs-streamer/client/vfs test

# 9. JavaScript Worker Core & WebGPU Scheduler Tests
cd externals/vfs-streamer && node --test client/web/worker_b_core.test.mjs client/web/webgpu_streamer_core.test.mjs

# 10. Rebuild WebAssembly Module (vfs.js + vfs.wasm)
source ~/.local/share/emsdk/emsdk_env.sh && make wasm
```

---

## 6. How to Launch Local Streaming for Real Games

```bash
# Start Go HTTP 206 streaming server
./bin/streamer-server -data-dir ./dist -web-dir ./web -addr 127.0.0.1:8080
```
Open `http://127.0.0.1:8080/` in Chromium, Chrome, or Firefox.
- **Slot 1:** Super Smash Bros. Melee (GameCube, `GALE01`)
- **Slot 2:** Mario Kart Wii (Wii, `RMCE01`)
- **Slot 3:** The Legend of Zelda: Twilight Princess (Wii, `RZDE01`)

Clicking "Start" mounts the disc, identifies the boot sector, streams 256 KB blocks into the 64 MB slab, and visualizes cache hits on the Live Memory HUD.

---

## 7. Phase 2 Roadmap: Compiling Dolphin's PowerPC Core

Phase 1 provides the complete out-of-core storage and streaming engine. Phase 2 connects Dolphin's emulator core to execute machine code:

1. **Ingest Dolphin Core Subsystem:**
   - Target Dolphin's core (`Source/Core/Core/`, `Source/Core/VideoCommon/`, `Source/Core/AudioCommon/`).
   - Configure Emscripten with `-pthread`, `-sALLOW_MEMORY_GROWTH=1`, `-sWASM_BIGINT`.
   - Enable PowerPC Interpreter mode (`-DENABLE_INTERPRETER=ON`, `-DENABLE_JIT=OFF`) for portable WASM execution.
2. **Hook `VfsBlobReader` into Dolphin's Disc Registry:**
   - In Dolphin's `Source/Core/DiscIO/Blob.cpp`, register `DiscIO::VfsBlobReader::Create` as the primary reader for streamed disc paths.
3. **WebGPU Frame Presentation:**
   - Forward Dolphin's rendered framebuffers through `device.queue.copyExternalImageToTexture()` to `#emulator-canvas`.
4. **Controller Input Mapping:**
   - Route Gamepad API inputs from `web/wii_input.js` into Dolphin's `Pad::SetStatus` and Wiimote registers.
