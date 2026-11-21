# Chapter 6.2: WebGPU Presentation Pipeline & Live Memory HUD

This document details the graphics and telemetry presentation pipeline, including the WebGPU 1.0 textured-quad viewport and the real-time 2D Canvas Memory HUD overlay.

---

## 1. WebGPU 1.0 Presentation Pipeline (`webgpu_renderer.mjs`)

DolphinStream presents emulator framebuffers on the browser main thread via modern **WebGPU 1.0**:

```text
+-----------------------------------------------------------------------------------+
| Dolphin C++ Video Core (Worker A)                                                 |
| - Renders native GC/Wii frame (640x480 RGBA8) into shared transferable buffer     |
+-----------------------------------------------------------------------------------+
                                          |
                         (Transferable ImageBitmap / MessagePort)
                                          v
+-----------------------------------------------------------------------------------+
| WebGPU Viewport Pipeline (Main Thread: #emulator-canvas)                          |
| - Device: GPUAdapter -> GPUDevice (webgpu_renderer.mjs)                           |
| - Texture: device.createTexture({ format: 'rgba8unorm', usage: ... })             |
| - Pipeline: WGSL Vertex/Fragment Shader (Textured Quad)                           |
| - Viewport: letterbox/pillarbox maintaining 4:3 (480i) or 16:9 (anamorphic)      |
+-----------------------------------------------------------------------------------+
```

### WGSL Shader Pipeline

The renderer uses a lightweight WGSL shader to project the emulator texture onto a fullscreen textured quad:

```wgsl
struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var pos = array<vec2f, 6>(
        vec2f(-1.0, -1.0), vec2f( 1.0, -1.0), vec2f(-1.0,  1.0),
        vec2f(-1.0,  1.0), vec2f( 1.0, -1.0), vec2f( 1.0,  1.0)
    );
    var uvs = array<vec2f, 6>(
        vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0),
        vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0)
    );

    var output: VertexOutput;
    output.position = vec4f(pos[vertexIndex], 0.0, 1.0);
    output.uv = uvs[vertexIndex];
    return output;
}

@group(0) @binding(0) var uSampler: sampler;
@group(0) @binding(1) var uTexture: texture_2d<f32>;

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
    return textureSample(uTexture, uSampler, uv);
}
```

* **Zero-copy texture updates:** Uploads frames using `device.queue.copyExternalImageToTexture()`.
* **Hardware Aspect Ratio Scaling:** Supports switching between standard 4:3 (original CRT) and 16:9 widescreen with linear texture filtering.

### Dual-Layer Aspect Ratio Scaling (`web/index.html`)

A common mistake in browser emulator frontends is updating only CSS `style.width` and `style.height` while leaving the canvas drawing buffer locked at 640x480. In 16:9 widescreen mode, this results in non-uniform bilinear stretching of a 4:3 buffer.

DolphinStream separates scaling into two distinct layers (`web/index.html:resize`):
1. **CSS Presentation Layer:** Computes letterboxing/pillarboxing to fit the parent container while strictly enforcing `targetW / targetH == aspect` (4:3 $\approx 1.333$ or 16:9 $\approx 1.777$).
2. **Hardware Swapchain Layer:** Updates internal canvas buffer dimensions (`emuCanvas.width` and `emuCanvas.height`) via `gpuRenderer.resize(targetW, targetH)` or setting 854x480 (16:9) / 640x480 (4:3), ensuring the GPU swapchain texture renders native anamorphic pixels.

### Canvas Context Exclusivity & Safe WebGPU Fallback Sequencing

An HTML `<canvas>` element can acquire only **one** rendering context type (`webgpu` or `2d`) during its DOM lifetime.

#### The Context Lock Trap
If code invokes `canvas.getContext('webgpu')` before verifying whether the hardware adapter and device can actually be acquired, and `device.requestDevice()` subsequently fails (e.g., driver crash or unsupported GPU flags), any subsequent attempt to fall back to `canvas.getContext('2d')` returns `null` or throws `InvalidStateError`.

#### The Safe Fallback Pattern (`web/index.html`)
To guarantee graceful degradation on devices lacking WebGPU or running headless in CI:
```javascript
async function setupRenderer() {
    try {
        if (!gpuRenderer) {
            const res = await initWebGpuRenderer(emuCanvas);
            if (res && res.supported) {
                gpuRenderer = res;
            } else {
                gpuRenderer = createMockGpuRenderer(emuCanvas);
            }
        }
        if (gpuRenderer) {
            gpuRenderer.renderFrame([{ dstRect: [0, 0, 1, 1], uvRect: [0, 0, 1, 1], tint: [1, 1, 1, 1] }]);
        }
        return gpuRenderer;
    } catch (err) {
        console.warn('WebGPU renderer setup failed, falling back to 2D mock:', err);
        gpuRenderer = createMockGpuRenderer(emuCanvas);
        return gpuRenderer;
    }
}
```
`initWebGpuRenderer` acquires the `GPUAdapter` and `GPUDevice` *before* requesting `canvas.getContext('webgpu')`. If device acquisition fails, `getContext('webgpu')` is never invoked, leaving the canvas free to initialize a standard 2D canvas context.

---

## 2. Real-Time 2D Memory HUD Overlay (`hud_overlay.mjs`)

To visualize out-of-core block streaming in real-time, DolphinStream renders a high-performance **2D Canvas HUD overlay** directly on top of the emulator canvas (`#hud-canvas`):

```text
+-----------------------------------------------------------------------------------+
| DOLPHIN STREAM VFS LIVE MONITOR                     [ L1 HIT: 94.2% | L2: 4.8% ]  |
| Slab: 64 MB (256 x 256KB Frames)                    Bandwidth: 14.2 MB/s          |
|                                                                                   |
| [X][X][X][X][X][X][X][X]  Set 00: [========]  Frames 0..7    (Ready / Pinned)    |
| [X][X][L][L][X][X][X][X]  Set 01: [==LL====]  Frames 8..15   (Loading from Net)   |
| [D][D][X][X][X][X][C][C]  Set 02: [DD====CC]  Frames 16..23  (Dirty OPFS / Cold)  |
| ...                                                                               |
| [ ][ ][ ][ ][ ][ ][ ][ ]  Set 31: [        ]  Frames 248..255 (Empty)             |
+-----------------------------------------------------------------------------------+
```

### Color-Coded Frame Legend

The 256 physical frames in the slab are drawn as a continuous 2D matrix, updated at 30 FPS:

| Color | State / Flag | Meaning |
|---|---|---|
| **Dark Charcoal (`#1a1a1a`)** | `FRAME_EMPTY` | Unallocated slot available for eviction. |
| **Electric Cyan (`#00d4ff`)** | `FRAME_LOADING` | Network HTTP 206 slice fetch currently in flight. |
| **Emerald Green (`#00ff88`)** | `FRAME_READY` | Block cached in L1 RAM slab; available for $0\text{ ms}$ reads. |
| **Bright Orange (`#ff8800`)** | `FLAG_DIRTY_OPFS` | Block modified/streamed, waiting for OPFS SSD write-behind. |
| **Slate Gray (`#666666`)** | `FLAG_COLD_HINT` | File cutscene finished; block hinted as cold and eligible for eviction. |

---

## 3. Non-Blocking Telemetry Generation (`WorkerBCore: getHudSnapshot`)

A common mistake in memory profiling is having the HUD loop acquire locks on the shared arena, which degrades emulator performance.

Worker B generates telemetry **lock-free and non-blocking** in `getHudSnapshot()`:

```javascript
// client/web/worker_b_core.mjs (Excerpt)
getHudSnapshot() {
    const totalFrames = this.totalFrames;
    const frameStates = new Uint8Array(totalFrames);
    const frameFlags = new Uint8Array(totalFrames);

    // Read frame directory using relaxed Atomics
    for (let f = 0; f < totalFrames; f++) {
        const base = (Offsets.VFS_ARENA_DIR_OFFSET + f * Offsets.PAGE_FRAME_ENTRY_SIZE) >>> 2;
        frameStates[f] = Atomics.load(this.u32, base + 1); // state
        frameFlags[f]  = Atomics.load(this.u32, base + 4); // flags
    }

    // Read 64-bit performance counters
    const l1Hits = Atomics.load(this.u64, Offsets.CTRL_L1_HITS_OFFSET >>> 3);
    const l1Misses = Atomics.load(this.u64, Offsets.CTRL_L1_MISSES_OFFSET >>> 3);
    const netFetches = Atomics.load(this.u64, Offsets.CTRL_NETWORK_FETCHES_OFFSET >>> 3);
    const totalStallNs = Atomics.load(this.u64, Offsets.CTRL_TOTAL_STALL_NS_OFFSET >>> 3);

    return {
        frameStates,
        frameFlags,
        l1Hits: Number(l1Hits),
        l1Misses: Number(l1Misses),
        netFetches: Number(netFetches),
        totalStallMs: Number(totalStallNs / 1000000n)
    };
}
```

* Snapshots are dispatched to the main thread via `postMessage`.
* The main thread renders the HUD on a transparent overlay canvas without blocking user input or emulator execution.
* Users can toggle the HUD on and off dynamically using the **"Toggle Memory HUD"** button (`#btn-toggle-hud`) in the viewport controls bar.
