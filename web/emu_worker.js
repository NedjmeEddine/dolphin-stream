import createVfsModule from './vfs.js';
import * as Offsets from './vfs_offsets.js';
import createDolphinCore from './cores/dolphin/dolphin-core-upstream.js';

let portB = null;
let vfsModule = null;
let vfsMemory = null;
let ctxPtr = 0;
let scratchBufPtr = 0;
let discSize = 0;
let dolphinCore = null;
let isRunning = false;
let frameTimer = null;

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
        if (frameTimer) { clearTimeout(frameTimer); frameTimer = null; }
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

                scratchBufPtr = vfsModule._malloc(65536); // 64 KB scratch buffer

                // Extract disc total byte size directly from manifest header (offset 0x08)
                const dv = new DataView(manifestHeaderBytes.buffer, manifestHeaderBytes.byteOffset, 32);
                discSize = Number(dv.getBigUint64(8, true));

                portB.postMessage({
                    type: 'ARENA_READY',
                    wasmMemory: vfsMemory,
                    arenaOffset: arenaPtr
                });

                // Initialize Dolphin Core
                dolphinCore = await createDolphinCore({
                    locateFile: (p) => `./cores/dolphin/${p}`,
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
                        // shortcut: synchronous read using 64 KB scratch chunks, upgrade to full buffer if length exceeds scratch
                        const chunkLen = Math.min(length, 65536);
                        const n = vfsModule._vfs_read_sync(ctxPtr, BigInt(position), scratchBufPtr, chunkLen);
                        if (n > 0) {
                            const slice = new Uint8Array(vfsMemory.buffer, scratchBufPtr, Number(n));
                            buffer.set(slice, offset);
                            return Number(n);
                        }
                        return 0;
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

                dolphinCore._SetCpuThread(0);
                const swRendererPtr = cPath(dolphinCore, 'Software Renderer');
                dolphinCore._SetVideoBackend(swRendererPtr);
                dolphinCore._free(swRendererPtr);

                const cachedInterpPtr = cPath(dolphinCore, 'cached-interpreter');
                dolphinCore._SetCpuCore(cachedInterpPtr);
                dolphinCore._free(cachedInterpPtr);

                dolphinCore._CoreInit();

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
                    discSize
                });

                if (bootRc === 1) {
                    isRunning = true;
                    pumpEmuLoop();
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
        dolphinCore._RunFrame();

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

        const audioCap = dolphinCore._AudioBufferFrames();
        const mixed = dolphinCore._MixAudio(Math.min(audioCap, 1024));
        if (mixed > 0) {
            const aPtr = dolphinCore._AudioBuffer();
            const pcm = new Int16Array(dolphinCore.HEAPU8.buffer, aPtr, mixed * 2).slice();
            self.postMessage(
                { type: 'EMU_AUDIO', pcm: pcm.buffer, frames: mixed, rate: dolphinCore._AudioSampleRate() },
                [pcm.buffer]
            );
        }
    } catch (loopErr) {
        console.warn('[emu_worker] Frame loop warning:', loopErr);
    }

    frameTimer = setTimeout(pumpEmuLoop, 16);
}
