# DolphinStream 🐬⚡

> **Instant-Play Out-of-Core WebAssembly Streaming for Dolphin Emulator (GameCube & Wii)**

Play multi-gigabyte GameCube and Wii games directly in standard web browsers within a strictly bounded **64 MB RAM cache** without waiting to download full 1.4–8.5 GB ISO disc images.

---

## 🌟 The Superpower

Traditional WebAssembly emulator ports hit a hard wall with 6th- and 7th-generation consoles:
* **The 4 GB WASM Memory Wall:** A Wii disc is 4.7 GB (single-layer) to 8.5 GB (dual-layer). Loading the disc into browser RAM crashes the 32-bit `wasm32` heap.
* **The 30-Minute Download Wall:** Players don't want to wait 20 minutes for an ISO to download before the title screen appears.
* **The Cloud Gaming Cost:** Cloud streaming (GeForce Now, Xbox Cloud) requires expensive server GPU farms and adds video compression lag.

**DolphinStream is the middle ground:**
1. **Play in 2 Seconds:** Click a link and start playing immediately.
2. **Native Client Compute:** WebAssembly pthreads run the PowerPC emulation and WebGPU renders the graphics directly on your local GPU.
3. **Out-of-Core Block Streaming:** Game discs are sliced into 256 KB content-addressed blocks and streamed over HTTP 206 range requests into a bounded 64 MB `SharedArrayBuffer` slab.
4. **Offline Markov Prefetching:** Access patterns are trained into an $O(1)$ lookup table to prefetch textures and audio ahead of player inputs.
5. **Local SSD Persistence:** Visited disc blocks are saved to the browser's Origin Private File System (OPFS), so replaying a level loads with zero network traffic.

---

## 🏗️ Architecture

```text
========================================================================================
 Browser Presentation (Main Thread): WebGPU Canvas + Gamepad API + 2D Memory HUD
========================================================================================
                                      |
         (Disc Read Request: DiscIO::BlobReader::Read(offset, size, out))
                                      v
========================================================================================
 Worker A (WASM Pthread): Dolphin PowerPC CPU Core + DiscIO VfsBlobReader
 - Synchronous C POSIX ABI (vfs_fs_pread, vfs_fs_seek, vfs_fs_tell)
 - Blocks on io_futex (Atomics.wait) when disc blocks are missing from RAM
========================================================================================
                                      |
               (64 MB SharedArrayBuffer Page Cache: 256 x 256 KB Frames)
                                      v
========================================================================================
 Worker B (Async Non-Blocking I/O): Fetch Engine, OPFS Cache & Markov Prefetcher
 - Resolves demand misses via HTTP 206 Range slices (/packs/*.bin)
 - Idle write-behind saves disc blocks to local SSD (cache.opfs)
 - Predicts and prefetches top-K next blocks from manifest.bin
========================================================================================
```

---

## 🚀 Quickstart

### 1. Slicing a GameCube Disc Image (`.iso`)

Use the offline compiler from the `vfs-streamer` submodule to prepare any GameCube or Wii disc:

```bash
# Clone the repository and initialize submodules
git clone --recurse-submodules git@github.com:NedjmeEddine/dolphin-stream.git
cd dolphin-stream

# Compile the packager tool
go build -o bin/markov-pack externals/vfs-streamer/cmd/markov-pack

# Slice a 1.4 GB GameCube ISO into 256 KB blocks and 64 MB pool configuration
./bin/markov-pack -in ssbm.iso -out-dir ./dist -block-shift 18 -pool-mb 64 -top-k 4
```

### 2. Building the WebAssembly Disc Adapter

```bash
# Activate Emscripten SDK
source ~/.local/share/emsdk/emsdk_env.sh

# Configure and build with CMake
mkdir -p build && cd build
emcmake cmake ..
emmake make
```

### 3. Serving the Player

Launch the streaming HTTP 206 server:

```bash
go build -o bin/streamer-server externals/vfs-streamer/cmd/streamer-server
./bin/streamer-server -data-dir ./dist -web-dir ./web -addr 127.0.0.1:8080
```

Open `http://127.0.0.1:8080/` in Chromium or Firefox with WebGPU enabled.

### 4. Running the Verification Suites

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
```

---

## 📁 Repository Structure

```text
dolphin-stream/
├── externals/
│   └── vfs-streamer/        # Core out-of-core streaming engine submodule
├── src/
│   └── disc_io/
│       ├── vfs_blob_reader.h   # C++ adapter for Dolphin's DiscIO::BlobReader
│       ├── vfs_blob_reader.cpp # Zero-allocation synchronous read implementation
│       ├── disc_header.h       # Boot sector magic (0xC2339F3D / 0x5D1C9EA3) parser
│       ├── disc_header.cpp     # Platform detection & GameID extraction
│       └── disc_io_test.cpp    # Native DiscIO unit verification suite
├── web/
│   ├── index.html           # Wii Channel Grid, WebGPU viewport, and memory HUD
│   ├── wii_audio.js         # Zero-asset procedural Web Audio synthesizer
│   ├── wii_input.js         # Gamepad API navigation loop with analog deadzone
│   ├── emu_viewport.test.mjs# Viewport and aspect ratio Playwright test
│   └── multi_game_e2e.test.mjs # Full multi-game capstone E2E Playwright test
├── scripts/
│   └── gen_mock_games.mjs   # Mock GameCube and Wii disc generator & slicer
├── CMakeLists.txt           # Emscripten C++20 build definition
├── Makefile                 # Emscripten multi-pass build & native test runner
└── README.md
```

---

## 📄 License

GPLv2+ (matching Dolphin Emulator) / MIT (matching VFS Streamer Core).
