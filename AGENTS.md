# AGENTS.md — Developer & Agent Guide for DolphinStream

DolphinStream is an out-of-core WebAssembly GameCube & Wii streaming runtime (Dolphin C++ DiscIO adapter + Go HTTP 206 server + C11 VFS engine + Web Workers & WebGPU canvas).

---

## 1. Toolchain & Environment Gotchas

* **Go Modules:** `go.mod` lives inside `externals/vfs-streamer`, NOT root. Running `go` commands from root fails with `cannot find main module`. Always run:
  ```bash
  cd externals/vfs-streamer && go test -race ./...
  cd externals/vfs-streamer && go build -o ../../bin/streamer-server ./cmd/streamer-server
  cd externals/vfs-streamer && go build -o ../../bin/markov-pack ./cmd/markov-pack
  cd externals/vfs-streamer && go build -o ../../bin/tile-gen ./cmd/tile-gen
  ```
* **Emscripten (emcc 4.0+):** Installed at `~/.local/share/emsdk`. Activate in bash:
  ```bash
  source ~/.local/share/emsdk/emsdk_env.sh
  ```
* **Playwright Chromium:** Cached at `~/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome`. Always launch with `--no-sandbox` and `--enable-features=SharedArrayBuffer`. Root `node_modules` is symlinked to `externals/vfs-streamer/node_modules`.

---

## 2. Fast Verification Commands

Run focused test suites depending on the layer being modified:

```bash
# 1. Root DiscIO C++ tests (BlobReader, C ABI, Boot Sector Parser)
make test

# 2. Worker A DiscIO sector reader integration test (Playwright)
npm run test:disc

# 3. Wii UI Playwright layout & transition tests
npm run test:ui

# 4. Web Audio & Gamepad navigation unit tests
node --test web/wii_audio.test.mjs web/wii_input.test.mjs

# 5. Go backend & catalog tests (with race detector)
cd externals/vfs-streamer && go test -count=1 -race ./...

# 6. C11 VFS multi-threading suite (with ThreadSanitizer)
make -C externals/vfs-streamer/client/vfs test

# 7. JavaScript worker core & WebGPU scheduler tests
cd externals/vfs-streamer && node --test client/web/worker_b_core.test.mjs client/web/webgpu_streamer_core.test.mjs

# 8. Rebuild WebAssembly binary module (vfs.js + vfs.wasm)
make wasm
```

---

## 3. Submodule & Architecture Rules

* **Two-Repo Hierarchy:** Root repo (`dolphin-stream`) holds the Dolphin DiscIO C++ adapter and `web/` Wii shell. `externals/vfs-streamer` is a git submodule pointing to `wasm-block-streamer`.
  * **Commit order:** Always commit and push inside `externals/vfs-streamer` first, then commit the updated submodule commit pointer in root `dolphin-stream`.
* **Static Web Directory Traversal (`web/`):** Go's `http.FileServer` serving `-web-dir ./web` strictly forbids `../` path traversal. Any client scripts imported by `web/index.html` (e.g. `worker_a.js`, `vfs_offsets.js`, `hud_overlay.mjs`) MUST be symlinked directly inside `web/`.
* **Catalog & Multi-Game Dispatch:**
  * `games.json` in `dataDir` defines catalog schema (ID, title, platform, disc size). If missing, the server automatically synthesizes a single-game catalog from root `manifest.bin`.
  * Multi-game routes: `/games/{gameId}/manifest.bin` and `/games/{gameId}/packs/*`.
  * Telemetry (`/telemetry/transitions?build={etag}`) routes transition logs to the game snapshot matching that specific `BuildEtagHash`.
* **VfsBlobReader Dual Mode:**
  * When `m_fd != 0`, reads through `vfs_fs_pread` inside VFSI filesystem containers.
  * When `m_fd == 0`, reads raw ISO streams directly via `vfs_read_sync(m_fs->ctx, ...)` without requiring a filesystem TOC.
* **Header Hygiene in `src/disc_io/vfs_blob_reader.h`:**
  * Do NOT define `#define _Atomic` or `#define _Static_assert` in `vfs_blob_reader.h`. It breaks standard `<atomic>` headers in modern C++.
  * Forward-declare `struct VfsFs;` in `vfs_blob_reader.h` and confine C11 headers (`vfs_client.h`, `vfs_fs.h`) to `.cpp` translation units.
* **DiscIO EOF Contract:** `VfsBlobReader::Read(offset, size, out)` must return `false` if `offset >= m_size || offset + size > m_size`. Never clamp `toRead` and return `true` on partial reads, which leaves uninitialized trailing bytes in emulator RAM.
* **Cross-Origin Isolation:** Worker A and Worker B communicate over `SharedArrayBuffer`. Pages must be served with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (enforced automatically by `streamer-server`).

---

## 4. Serving the Web Shell

To launch the local streaming server with sample sliced data:

```bash
# 1. Build CLIs
cd externals/vfs-streamer
go build -o ../../bin/streamer-server ./cmd/streamer-server
go build -o ../../bin/markov-pack ./cmd/markov-pack
cd ../..

# 2. Slice disc into 256 KB blocks (or create demo pack)
./bin/markov-pack -in <game.iso> -out-dir ./dist -transitions-dir ./transitions -block-shift 18 -pool-mb 64 -top-k 4

# 3. Start range server
./bin/streamer-server -data-dir ./dist -web-dir ./web -addr 127.0.0.1:8080
```
Open `http://127.0.0.1:8080/` in Chromium or Firefox.
