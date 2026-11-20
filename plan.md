# DolphinStream Implementation Plan 🐬⚡

An incremental, Test-Driven Development (TDD) roadmap to stream GameCube and Wii games directly in the browser using WebAssembly, WebGPU, and an out-of-core 64 MB RAM cache.

---

## 🏛️ Guiding Principles

1. **Test-Driven Development (TDD):** Every micro-step starts with an automated test (unit or end-to-end) that fails first, then passes with the minimal code.
2. **Incremental Commits & Pushes:** Every micro-step is committed and pushed individually to keep a clean, bisectable git history on `main`.
3. **Zero GPU Server Cost:** All graphics rendering (WebGPU/WebGL2) and CPU emulation (PowerPC) execute on the player's client; servers only host immutable 256 KB slices over HTTP 206 range requests.
4. **Instant-Load HTML Presentation:** The UI is an authentic Wii Home Screen built in HTML/CSS/WebAudio that loads in <100ms. The heavy WASM emulator core is never loaded until a game channel is launched.

---

## 🗺️ Roadmap & Milestones

```text
+-------------------------------------------------------------------------------------------------+
| Milestone 1: Multi-Game Sliced Storage & Server Catalog (Go Backend)                           |
+-------------------------------------------------------------------------------------------------+
                                              |
                                              v
+-------------------------------------------------------------------------------------------------+
| Milestone 2: Wii Channel Grid & HTML Presentation Shell (Frontend UI)                          |
+-------------------------------------------------------------------------------------------------+
                                              |
                                              v
+-------------------------------------------------------------------------------------------------+
| Milestone 3: Dynamic Multi-Game Worker Streaming & OPFS State (Client JS/WASM)                  |
+-------------------------------------------------------------------------------------------------+
                                              |
                                              v
+-------------------------------------------------------------------------------------------------+
| Milestone 4: Headless Dolphin WASM Core & DiscIO Hook (Emscripten / C++)                       |
+-------------------------------------------------------------------------------------------------+
                                              |
                                              v
+-------------------------------------------------------------------------------------------------+
| Milestone 5: WebGPU/WebGL2 Graphics, Audio & In-Game Home Overlay (E2E Integration)            |
+-------------------------------------------------------------------------------------------------+
```

---

## Milestone 1: Multi-Game Sliced Storage & Server Catalog (Go Backend)

Enable the HTTP range server to host multiple GameCube/Wii titles under a unified catalogue.

- [ ] **Micro-step 1.1: Catalog Schema & Validation (`games.json`)**
  - **TDD:** Write `internal/server/catalog_test.go` defining schema test (game ID, title, cover image, banner sound, disc size, block shift, pool MB).
  - **Impl:** Implement catalog parser and route handler in `internal/server/server.go`.
  - **Commit:** `feat(server): add games.json catalogue schema and parser`

- [ ] **Micro-step 1.2: Dynamic Per-Game Range & Manifest Routing**
  - **TDD:** Write integration test in `internal/server/server_test.go` verifying requests for `/games/{id}/manifest.bin` and `/games/{id}/packs/*.bin`.
  - **Impl:** Route dynamic snapshot resolution per game ID from a `games/` directory.
  - **Commit:** `feat(server): support multi-game range streaming routes`

- [ ] **Micro-step 1.3: Multi-Game Packager CLI Script**
  - **TDD:** Add test in `cmd/markov-pack/main_test.go` verifying batch packaging of multiple ISO files into catalog structure.
  - **Impl:** Add `-catalog` flag to `markov-pack` to append game metadata to `games.json`.
  - **Commit:** `feat(packager): support catalog registration during disc slicing`

---

## Milestone 2: Wii Channel Grid & HTML Presentation Shell (Frontend UI)

Create an authentic, instant-loading Wii Home Screen catalogue in `web/index.html`.

- [ ] **Micro-step 2.1: 4x3 Wii Channel Grid Layout (HTML/CSS)**
  - **TDD:** Write Playwright test in `web/ui.test.mjs` asserting grid container, channel elements, and responsive layout.
  - **Impl:** Build CSS Grid layout with channel borders, title labels, and hover zoom effects.
  - **Commit:** `feat(web): implement 4x3 wii channel grid layout`

- [ ] **Micro-step 2.2: Wii Web Audio Sound Engine**
  - **TDD:** Write Node test verifying Web Audio chime generator and sound effect trigger states.
  - **Impl:** Create `web/wii_audio.js` using Web Audio API to synthesize cursor hover ticks, channel select chimes, and start sounds.
  - **Commit:** `feat(web): add web audio sound effects for wii channels`

- [ ] **Micro-step 2.3: Gamepad API Navigation Loop**
  - **TDD:** Write Playwright test simulating standard gamepad inputs (D-Pad, Left Stick, A Button).
  - **Impl:** Implement navigation loop in `web/wii_input.js` to navigate channels with game controllers.
  - **Commit:** `feat(web): add gamepad navigation for wii home screen`

- [ ] **Micro-step 2.4: Channel Zoom & Start Banner Transition**
  - **TDD:** Write Playwright test asserting channel zoom animation, "Start" button appearance, and "Back" button event.
  - **Impl:** Implement zoom overlay and banner presentation on channel click.
  - **Commit:** `feat(web): add wii channel zoom and start banner transition`

---

## Milestone 3: Dynamic Multi-Game Worker Streaming & OPFS State (Client JS/WASM)

Connect the channel selection workflow to dynamic out-of-core streaming workers.

- [ ] **Micro-step 3.1: Dynamic Game Worker Initialization**
  - **TDD:** Write unit test in `client/web/worker_b_core.test.mjs` verifying Worker B dynamically loads manifests from `/games/{id}/manifest.bin`.
  - **Impl:** Add `INIT_GAME` message to Worker A and Worker B to mount arbitrary game catalogs.
  - **Commit:** `feat(client): support dynamic game boot in worker streaming engine`

- [ ] **Micro-step 3.2: Per-Game OPFS Save & Block Cache Partitioning**
  - **TDD:** Write test verifying game saves and cache blocks are partitioned under `/saves/{gameId}/` in OPFS.
  - **Impl:** Partition OPFS directory handles by game ID in `worker_b.js`.
  - **Commit:** `feat(client): partition opfs persistent storage by game id`

- [ ] **Micro-step 3.3: Worker A Disc Mount & VfsBlobReader Instantiation**
  - **TDD:** Write C++ test in `src/disc_io/disc_io_test.cpp` verifying `VfsBlobReader` can switch files dynamically upon unmount/mount.
  - **Impl:** Wire `FS_MOUNT` in `worker_a.js` to instantiate `VfsBlobReader` for the active game disc.
  - **Commit:** `feat(vfs): add dynamic disc mount adapter for worker a`

---

## Milestone 4: Headless Dolphin WASM Core & DiscIO Hook (Emscripten / C++)

Build the trimmed Dolphin emulator core targeting WebAssembly.

- [ ] **Micro-step 4.1: Shallow Submodule Scaffold (`externals/dolphin`)**
  - **TDD:** Add verification script checking presence of Dolphin core headers without full historical git tree.
  - **Impl:** Add shallow submodule `externals/dolphin` with `--depth 1`.
  - **Commit:** `build(dolphin): add shallow submodule for upstream dolphin core`

- [ ] **Micro-step 4.2: Minimal Headless CMake Toolchain (`DolphinNoGUI`)**
  - **TDD:** Write CMake configuration test verifying builds succeed with `-DENABLE_QT=OFF` and `-DENFORCE_INTERPRETER=ON`.
  - **Impl:** Create `CMakeLists.txt` profile for Emscripten compiling `Common`, `PowerPC` (Interpreter), `Core`, and `DiscIO`.
  - **Commit:** `build(dolphin): configure minimal emscripten build for headless dolphin`

- [ ] **Micro-step 4.3: DiscIO `VfsBlobReader` Upstream Integration**
  - **TDD:** Write test in `disc_io_test.cpp` testing Dolphin's `DiscIO::CreateBlobReader("vfs://disc.iso")`.
  - **Impl:** Hook `VfsBlobReader` into Dolphin's `Source/Core/DiscIO/Blob.cpp` factory.
  - **Commit:** `feat(dolphin): integrate vfs blob reader into discio factory`

- [ ] **Micro-step 4.4: Exported WASM Lifecycle Hooks (Init, Tick, Pause, Save)**
  - **TDD:** Write Node test verifying Emscripten module exports `_dolphin_init`, `_dolphin_tick_frame`, `_dolphin_pause`.
  - **Impl:** Expose C C-ABI wrapper functions in `src/disc_io/dolphin_wasm_api.cpp`.
  - **Commit:** `feat(dolphin): expose lifecycle and frame step c abi for wasm`

---

## Milestone 5: WebGPU/WebGL2 Graphics, Audio & In-Game Home Overlay (E2E Integration)

Deliver the complete playable experience.

- [ ] **Micro-step 5.1: Canvas Presentation & Video Frame Loop**
  - **TDD:** Write Playwright E2E test verifying frame renders to canvas element without WebGPU errors.
  - **Impl:** Bridge Dolphin video backend to WebGPU / WebGL2 canvas context on main thread.
  - **Commit:** `feat(render): connect emulator video surface to webgpu canvas`

- [ ] **Micro-step 5.2: Web Audio Latency-Bounded Playback**
  - **TDD:** Test Web Audio ring buffer underrun/overrun recovery in Node.
  - **Impl:** Stream Dolphin audio samples to Web Audio `AudioWorklet`.
  - **Commit:** `feat(audio): bridge dolphin audio output to web audio worklet`

- [ ] **Micro-step 5.3: Authentic Wii In-Game Home Menu Overlay**
  - **TDD:** Playwright test asserting pressing `Home` pauses emulator Worker A and shows Wii menu options (Reset, Return to Wii Menu, Save State).
  - **Impl:** HTML overlay with blurred viewport, battery indicators, and channel return animation.
  - **Commit:** `feat(web): add authentic wii home menu overlay`

---

## 🚦 Verification Commands

```bash
# 1. Run all backend Go tests with race detector
cd externals/vfs-streamer && go test -race -v ./...

# 2. Run all C11 VFS tests with ThreadSanitizer
make -C externals/vfs-streamer/client/vfs test

# 3. Run DiscIO C++ tests
make test

# 4. Run JS runtime unit tests
cd externals/vfs-streamer && node --test client/web/*.test.mjs

# 5. Run end-to-end browser suite (Playwright)
cd externals/vfs-streamer && node client/web/web_e2e_test.mjs
```
