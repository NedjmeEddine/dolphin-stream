import createVfsModule from './vfs.js';
import createDolphinCore from './cores/dolphin/dolphin-core-upstream.js';

const SCRATCH_CAP = 4 * 1024 * 1024; // 4 MiB reusable read buffer
let portB = null;
let useWebGpu = false;
let offscreenCanvas = null;
let gpuDevice = null;
let vfsModule = null;
let vfsMemory = null;
let ctxPtr = 0;
let scratchBufPtr = 0;
let discSize = 0;
let dolphinCore = null;
let isRunning = false;
let lastCoreFrame = -1;
let lastAudioTime = 0;
let lastFramePostTime = 0;
let totalVfsWaitMs = 0;
let totalCpuTimeMs = 0;
let totalDiscBytesRead = 0;
let lastReadEndTimestamp = 0;
let lastMetricsReportTime = 0;

const loopChannel = new MessageChannel();
loopChannel.port1.onmessage = () => {
    if (isRunning) pumpEmuLoop();
};

function scheduleNextPump() {
    if (isRunning) loopChannel.port2.postMessage(0);
}

function cPath(mod, str) {
    const bytes = new TextEncoder().encode(str + '\0');
    const ptr = mod._malloc(bytes.length);
    mod.HEAPU8.set(bytes, ptr);
    return ptr;
}

self.onmessage = async (e) => {
    const msg = e.data || {};
    const type = msg.type;

    if (type === 'PORT') {
        portB = msg.port;
        useWebGpu = Boolean(msg.useWebGpu);
        offscreenCanvas = msg.canvas || null;
        setupPortB();
        return;
    }

    if (type === 'INPUT' && dolphinCore) {
        dolphinCore._SetInputState(
            msg.mask || 0,
            msg.stickX ?? 128,
            msg.stickY ?? 128,
            msg.cStickX ?? 128,
            msg.cStickY ?? 128,
            msg.triggerLeft || 0,
            msg.triggerRight || 0,
            msg.analogA || 0,
            msg.analogB || 0,
            msg.generation || 0
        );
        return;
    }

    if (type === 'STOP') {
        isRunning = false;
        if (dolphinCore) dolphinCore._StopCore();
        self.postMessage({ type: 'STOPPED' });
        return;
    }
};

function setupPortB() {
    portB.onmessage = async (e) => {
        const { type, manifestHeaderBytes, effectivePoolMB, arenaBytes } = e.data || {};
        if (type === 'GEOMETRY') {
            try {
                const arenaPages = Math.ceil(arenaBytes / 65536);
                const initialPages = 1024 + arenaPages;
                const maximumPages = Math.min(65536, initialPages + 4096);

                vfsMemory = new WebAssembly.Memory({
                    initial: initialPages,
                    maximum: maximumPages,
                    shared: true
                });

                vfsModule = await createVfsModule({ wasmMemory: vfsMemory });

                const arenaPtr = vfsModule._aligned_alloc(65536, arenaBytes);
                if (!arenaPtr) {
                    portB.postMessage({ type: 'BOOT_ERROR', reason: 'aligned_alloc failed' });
                    return;
                }

                const hdrPtr = vfsModule._malloc(32);
                new Uint8Array(vfsMemory.buffer, hdrPtr, 32).set(manifestHeaderBytes);

                ctxPtr = vfsModule._malloc(64);
                const rc = vfsModule._vfs_init_arena(ctxPtr, arenaPtr, hdrPtr);
                vfsModule._free(hdrPtr);

                if (rc !== 0) {
                    portB.postMessage({ type: 'BOOT_ERROR', reason: `vfs_init_arena failed: ${rc}` });
                    return;
                }

                scratchBufPtr = vfsModule._malloc(SCRATCH_CAP);

                // Extract disc total byte size directly from manifest header (offset 0x08)
                const dv = new DataView(manifestHeaderBytes.buffer, manifestHeaderBytes.byteOffset, 32);
                discSize = Number(dv.getBigUint64(8, true));

                portB.postMessage({
                    type: 'ARENA_READY',
                    wasmMemory: vfsMemory,
                    arenaOffset: arenaPtr
                });

                // Initialize WebGPU if requested and supported
                if (useWebGpu && typeof navigator !== 'undefined' && navigator.gpu) {
                    try {
                        const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
                        if (adapter) {
                            const requiredFeatures = [];
                            if (adapter.features && adapter.features.has('dual-source-blending')) {
                                requiredFeatures.push('dual-source-blending');
                            }
                            gpuDevice = await adapter.requestDevice({ requiredFeatures });

                            if (gpuDevice) {
                                gpuDevice.addEventListener('uncapturederror', (e) => {
                                    console.error('[WebGPU Error]', e.error?.message || e.error);
                                });
                                gpuDevice.lost.then((info) => {
                                    console.warn('[WebGPU Device Lost]', info.message, info.reason);
                                });
                            }

                            if (offscreenCanvas) {
                                const gpuCtx = offscreenCanvas.getContext('webgpu');
                                if (gpuCtx) {
                                    const format = navigator.gpu.getPreferredCanvasFormat();
                                    gpuCtx.configure({ device: gpuDevice, format, alphaMode: 'opaque' });
                                }
                            }
                        }
                    } catch (gpuErr) {
                        console.warn('[emu_worker] WebGPU request failed, falling back to Software:', gpuErr);
                        gpuDevice = null;
                    }
                }

                // Initialize Dolphin Core
                dolphinCore = await createDolphinCore({
                    locateFile: (p) => `./cores/dolphin/${p}`,
                    canvas: offscreenCanvas || undefined,
                    preinitializedWebGPUDevice: gpuDevice || undefined,
                    print: (text) => console.log('[Dolphin]', text),
                    printErr: (text) => console.warn('[Dolphin Err]', text)
                });

                // Register virtual disc device in Dolphin Emscripten FS
                dolphinCore.FS.mkdir('/vfs');
                const dev = dolphinCore.FS.makedev(64, 0);
                dolphinCore.FS.registerDevice(dev, {
                    open: (stream) => { stream.seekable = true; },
                    read: (stream, buffer, offset, length, position) => {
                        if (length === 0) return 0;
                        const readStart = performance.now();
                        if (lastReadEndTimestamp > 0) {
                            totalCpuTimeMs += (readStart - lastReadEndTimestamp);
                        }

                        let totalRead = 0;
                        while (totalRead < length) {
                            const chunkLen = Math.min(length - totalRead, SCRATCH_CAP);
                            const t0 = performance.now();
                            const n = vfsModule._vfs_read_sync(ctxPtr, BigInt(position + totalRead), scratchBufPtr, chunkLen);
                            totalVfsWaitMs += (performance.now() - t0);
                            if (n <= 0) break;
                            const slice = new Uint8Array(vfsMemory.buffer, scratchBufPtr, Number(n));
                            buffer.set(slice, offset + totalRead);
                            totalRead += Number(n);
                            if (Number(n) < chunkLen) break;
                        }

                        lastReadEndTimestamp = performance.now();
                        totalDiscBytesRead += totalRead;

                        if (lastReadEndTimestamp - lastMetricsReportTime >= 2000) {
                            lastMetricsReportTime = lastReadEndTimestamp;
                            console.log(`[VFS-TIMING] Disc: ${(totalDiscBytesRead / (1024 * 1024)).toFixed(2)} MB | VFS Futex Wait: ${totalVfsWaitMs.toFixed(1)} ms | CPU/Decompress Time: ${totalCpuTimeMs.toFixed(1)} ms`);
                        }

                        return totalRead;
                    },
                    llseek: (stream, offset, whence) => {
                        let dest = offset;
                        if (whence === 1) dest += stream.position;
                        else if (whence === 2) dest += discSize;
                        if (dest < 0) throw new dolphinCore.FS.ErrnoError(28);
                        return dest;
                    }
                });

                const node = dolphinCore.FS.mkdev('/vfs/game.iso', 0o666, dev);
                node.usedBytes = discSize;

                // In WebGPU mode, keep single-threaded (0) to preserve swapchain thread affinity;
                // in Software mode, run dual-core (1) so the CPU and rasterizer run in parallel pthreads.
                dolphinCore._SetCpuThread(gpuDevice ? 0 : 1);
                const backendName = gpuDevice ? 'WebGPU-Real' : 'Software Renderer';
                const backendPtr = cPath(dolphinCore, backendName);
                dolphinCore._SetVideoBackend(backendPtr);
                dolphinCore._free(backendPtr);

                const cachedInterpPtr = cPath(dolphinCore, 'cached-interpreter');
                dolphinCore._SetCpuCore(cachedInterpPtr);
                dolphinCore._free(cachedInterpPtr);

                // Smooth 60 FPS console pacing with balanced 0.75x virtual CPU load
                if (dolphinCore._SetCpuOverclock) dolphinCore._SetCpuOverclock(0.75);
                if (dolphinCore._SetEmulationSpeed) dolphinCore._SetEmulationSpeed(1.0);
                if (!gpuDevice && dolphinCore._SetFastSoftwareRaster) dolphinCore._SetFastSoftwareRaster(3);
                if (dolphinCore._SetXfbFastPaths) dolphinCore._SetXfbFastPaths(3);
                if (dolphinCore._SetSoftwareTevHotCaseMode) dolphinCore._SetSoftwareTevHotCaseMode(1);

                dolphinCore._CoreInit();

                if (dolphinCore._SetPpcWasmJitEnabled) dolphinCore._SetPpcWasmJitEnabled(1);

                const discPathPtr = cPath(dolphinCore, '/vfs/game.iso');
                const bootRc = dolphinCore._BootDisc(discPathPtr);
                dolphinCore._free(discPathPtr);

                const coreTitle = dolphinCore.UTF8ToString(dolphinCore._GetCoreTitle());
                const coreStatus = dolphinCore.UTF8ToString(dolphinCore._GetCoreStatus());

                self.postMessage({
                    type: 'EMU_BOOTED',
                    ok: bootRc === 1,
                    title: coreTitle,
                    status: coreStatus,
                    discSize,
                    backend: gpuDevice ? 'WebGPU' : 'Dual-Core Software'
                });

                if (bootRc === 1) {
                    isRunning = true;
                    scheduleNextPump();
                }
            } catch (err) {
                console.error('[emu_worker] Initialization failed:', err);
                portB.postMessage({ type: 'BOOT_ERROR', reason: err.message });
            }
        }
    };
}

function pumpEmuLoop() {
    if (!isRunning || !dolphinCore) return;

    try {
        dolphinCore._PumpHostJobs();

        // Only transfer and post frame when in Software mode and Dolphin has rendered a new frame
        const currentFrame = dolphinCore._GetFrame ? dolphinCore._GetFrame() : 0;
        if (!gpuDevice && currentFrame !== lastCoreFrame) {
            lastCoreFrame = currentFrame;
            const now = performance.now();
            // Cap frame dispatch to display refresh rate (~60 Hz) to avoid worker message saturation
            if (now - lastFramePostTime >= 15) {
                lastFramePostTime = now;
                const w = dolphinCore._FrameWidth();
                const h = dolphinCore._FrameHeight();
                const ptr = dolphinCore._FrameBuffer();

                if (w > 0 && h > 0 && ptr) {
                    const frameBytes = new Uint8Array(dolphinCore.HEAPU8.buffer, ptr, w * h * 4).slice();
                    self.postMessage(
                        { type: 'EMU_FRAME', width: w, height: h, buffer: frameBytes.buffer },
                        [frameBytes.buffer]
                    );
                }
            }
        }

        const now = performance.now();
        if (now - lastAudioTime >= 30) {
            lastAudioTime = now;
            const audioCap = dolphinCore._AudioBufferFrames();
            const mixed = dolphinCore._MixAudio(Math.min(audioCap, 2048));
            if (mixed > 0) {
                const aPtr = dolphinCore._AudioBuffer();
                const pcm = new Int16Array(dolphinCore.HEAPU8.buffer, aPtr, mixed * 2).slice();
                self.postMessage(
                    { type: 'EMU_AUDIO', pcm: pcm.buffer, frames: mixed, rate: dolphinCore._AudioSampleRate() },
                    [pcm.buffer]
                );
            }
        }
    } catch (loopErr) {
        console.warn('[emu_worker] Frame loop warning:', loopErr);
    }

    // Yield to worker event queue via zero-delay MessageChannel dispatch
    scheduleNextPump();
}
