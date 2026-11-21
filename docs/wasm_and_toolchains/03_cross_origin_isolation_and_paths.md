# Chapter 4.3: Cross-Origin Isolation & Web Path Invariants

This document details the browser security requirements for multithreaded WebAssembly (`SharedArrayBuffer`), including Cross-Origin Isolation headers (`COOP`/`COEP`) and Go’s static directory traversal restrictions.

---

## 1. Post-Spectre Security & Cross-Origin Isolation

Following the discovery of the Spectre and Meltdown hardware speculative execution vulnerabilities, browser vendors disabled high-resolution timers and `SharedArrayBuffer` by default to prevent cross-origin side-channel attacks.

To re-enable `SharedArrayBuffer`, browsers require **Cross-Origin Isolation**. 

### The Mandatory Response Headers

The origin server must send two explicit HTTP response headers on **every** HTML, script, and WebAssembly asset:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

* **`Cross-Origin-Opener-Policy: same-origin` (COOP):** Isolates the browsing context, ensuring that top-level documents cannot open windows that share memory or execution contexts across different origins.
* **`Cross-Origin-Embedder-Policy: require-corp` (COEP):** Guarantees that any resource loaded by the document (such as images, worker scripts, or video) must explicitly grant permission via Cross-Origin Resource Policy (CORP) or CORS.

### Server Implementation (`internal/server/server.go`)

In `streamer-server`, these headers are injected automatically via middleware wrapped around the root router:

```go
// internal/server/server.go (Excerpt)
func (s *Server) securityMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Enforce cross-origin isolation headers for SharedArrayBuffer support
        w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
        w.Header().Set("Cross-Origin-Embedder-Policy", "require-corp")
        
        // Prevent MIME sniffing
        w.Header().Set("X-Content-Type-Options", "nosniff")
        
        next.ServeHTTP(w, r)
    })
}
```

If these headers are omitted or misconfigured, JavaScript evaluates `typeof SharedArrayBuffer === 'undefined'`, and `Worker A` fails to instantiate with:
`ReferenceError: SharedArrayBuffer is not defined`.

---

## 2. Go Static File Server Traversal Restrictions

In DolphinStream’s repository layout, the project is structured as a two-repo hierarchy:
* Root repo: `dolphin-stream` (holds `web/index.html` and C++ DiscIO adapter).
* Git submodule: `externals/vfs-streamer` (holds core VFS C11 engine and worker scripts).

### The `../` Path Traversal Ban

Go's standard library `http.FileServer` strictly forbids directory traversal outside the served directory:

```go
http.Handle("/", http.FileServer(http.Dir("./web")))
```

If `web/index.html` attempts to import a script located in the submodule using relative path traversal:
```javascript
// FAILS: Go http.FileServer returns 404 or redirects
import createVfsModule from '../externals/vfs-streamer/client/web/vfs.js';
```
Go’s `http.FileServer` cleans the path via `path.Clean()`. Any request containing `../` that attempts to escape the root `./web` directory is automatically rejected with `404 Not Found`.

### The Symlink Invariant

To satisfy Go’s security model while maintaining the clean separation of the git submodule, all shared client runtime scripts are **symlinked directly inside `web/`**:

```bash
web/
├── index.html
├── wii_audio.js
├── wii_input.js
├── worker_a.js      -> ../externals/vfs-streamer/client/web/worker_a.js
├── worker_b.js      -> ../externals/vfs-streamer/client/web/worker_b.js
├── worker_b_core.mjs -> ../externals/vfs-streamer/client/web/worker_b_core.mjs
├── vfs_offsets.js   -> ../externals/vfs-streamer/client/web/vfs_offsets.js
├── hud_overlay.mjs  -> ../externals/vfs-streamer/client/web/hud_overlay.mjs
├── vfs.js           -> ../externals/vfs-streamer/client/web/vfs.js
└── vfs.wasm         -> ../externals/vfs-streamer/client/web/vfs.wasm
```

When Go’s `http.FileServer` serves `./web`, it resolves the symlinks on the host filesystem and serves the assets with valid MIME types (`application/javascript` and `application/wasm`) without path traversal violations.

---

## 3. Headless Browser Testing Flags (Playwright)

When running automated end-to-end browser tests in CI or headless environments (`node client/web/web_e2e_test.mjs` or `npm run test:disc`):

Chromium’s security sandbox disables `SharedArrayBuffer` in headless Linux containers unless explicitly overridden.

### Mandatory Chromium Launch Flags

Every Playwright test runner in this repository must configure Chromium with these exact arguments:

```javascript
import { chromium } from 'playwright';

const browser = await chromium.launch({
    headless: true,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--enable-features=SharedArrayBuffer',
        '--enable-unsafe-webgpu'
    ]
});
```

* `--no-sandbox`: Required inside rootless Docker containers and Linux environments.
* `--enable-features=SharedArrayBuffer`: Ensures that `SharedArrayBuffer` is enabled across all workers even if running under atypical localhost origins.
