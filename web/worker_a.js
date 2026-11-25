import createVfsModule from './vfs.js';
import * as Offsets from './vfs_offsets.js';

let portB = null;
let wasmModule = null;
let wasmMemory = null;
let ctxPtr = 0;
let arenaPtr = 0;

// Layer 5 pre-allocated reusable buffers
let fsPtr = 0;
let blobReaderPtr = 0;
let scratchBufPtr = 0;
let tocBufPtr = 0;
let tocBufCap = 4 * 1024 * 1024; // 4 MiB default
const FS_IPC_MAX_READ_BYTES = 4 * 1024 * 1024; // 4 MiB max per IPC read
let pathBufPtr = 0;
let outBufPtr = 0;

let buildRotatedPosted = false;

function postBuildRotated() {
    if (!buildRotatedPosted) {
        buildRotatedPosted = true;
        self.postMessage({ type: 'BUILD_ROTATED' });
    }
}

self.onmessage = async (e) => {
    const msg = e.data || {};
    const type = msg.type;

    if (type === 'PORT') {
        portB = msg.port;
        setupPortB();
        return;
    }

    if (!wasmModule || !ctxPtr) {
        const tBuf = msg.transferBuffer || null;
        self.postMessage(
            { type: `${type}_RES`, id: msg.id, ok: false, code: -1, error: 'WASM not initialized', buffer: tBuf },
            tBuf ? [tBuf] : []
        );
        return;
    }

    if (type === 'READ') {
        const len = Number(msg.length);
        const dstPtr = wasmModule._malloc(len);
        try {
            const bytesRead = wasmModule._vfs_read_sync(ctxPtr, BigInt(msg.offset), dstPtr, len);
            if (bytesRead >= 0) {
                const bytes = new Uint8Array(wasmMemory.buffer, dstPtr, Number(bytesRead)).slice();
                wasmModule._free(dstPtr);
                self.postMessage({ type: 'READ_RES', id: msg.id, status: Number(bytesRead), data: bytes }, [bytes.buffer]);
            } else {
                wasmModule._free(dstPtr);
                self.postMessage({ type: 'READ_RES', id: msg.id, status: Number(bytesRead), data: null });
                if (bytesRead === -2) postBuildRotated();
            }
        } catch (err) {
            wasmModule._free(dstPtr);
            self.postMessage({ type: 'READ_RES', id: msg.id, status: -1, error: err.message });
        }
        return;
    }

    if (type === 'HINT_COLD') {
        wasmModule._vfs_hint_cold(ctxPtr, Number(msg.blockId));
        return;
    }

    if (type === 'FS_MOUNT') {
        const mountFlags = msg.mountFlags !== undefined ? Number(msg.mountFlags) : Offsets.VFS_FS_MOUNT_TELEM_HYBRID;
        const requestedCap = msg.maxTocBytes ? Number(msg.maxTocBytes) : tocBufCap;
        if (requestedCap > tocBufCap) {
            const newPtr = wasmModule._malloc(requestedCap);
            if (!newPtr) {
                self.postMessage({ type: 'FS_MOUNT_RES', id: msg.id, ok: false, code: Offsets.VFS_FS_ERR_BUF_TOO_SMALL });
                return;
            }
            if (tocBufPtr) wasmModule._free(tocBufPtr);
            tocBufPtr = newPtr;
            tocBufCap = requestedCap;
        }

        const dv = new DataView(wasmMemory.buffer, outBufPtr, 4);
        dv.setUint32(0, 0, true);

        const rc = wasmModule._vfs_fs_mount(fsPtr, ctxPtr, tocBufPtr, tocBufCap, mountFlags, outBufPtr);
        const reqBytes = dv.getUint32(0, true);

        self.postMessage({
            type: 'FS_MOUNT_RES',
            id: msg.id,
            ok: rc === Offsets.VFS_FS_OK,
            code: rc,
            requiredBytes: reqBytes
        });
        if (rc === -2) postBuildRotated();
        return;
    }

    if (type === 'FS_UNMOUNT') {
        const rc = wasmModule._vfs_fs_unmount(fsPtr);
        self.postMessage({ type: 'FS_UNMOUNT_RES', id: msg.id, ok: rc === Offsets.VFS_FS_OK, code: rc });
        return;
    }

    if (type === 'FS_STAT') {
        const pathBytes = new TextEncoder().encode((msg.path || '') + '\0');
        if (pathBytes.length > 1024) {
            self.postMessage({ type: 'FS_STAT_RES', id: msg.id, ok: false, code: Offsets.VFS_FS_ERR_INVALID_PATH });
            return;
        }
        new Uint8Array(wasmMemory.buffer, pathBufPtr, pathBytes.length).set(pathBytes);

        const dv = new DataView(wasmMemory.buffer, outBufPtr, 8);
        dv.setBigUint64(0, 0n, true);

        const rc = wasmModule._vfs_fs_stat(fsPtr, pathBufPtr, outBufPtr);
        const size = dv.getBigUint64(0, true);

        self.postMessage({
            type: 'FS_STAT_RES',
            id: msg.id,
            ok: rc === Offsets.VFS_FS_OK,
            code: rc,
            size: rc === Offsets.VFS_FS_OK ? size : 0n
        });
        return;
    }

    if (type === 'FS_OPEN') {
        const pathBytes = new TextEncoder().encode((msg.path || '') + '\0');
        if (pathBytes.length > 1024) {
            self.postMessage({ type: 'FS_OPEN_RES', id: msg.id, ok: false, code: Offsets.VFS_FS_ERR_INVALID_PATH });
            return;
        }
        new Uint8Array(wasmMemory.buffer, pathBufPtr, pathBytes.length).set(pathBytes);

        const dv = new DataView(wasmMemory.buffer, outBufPtr, 4);
        dv.setUint32(0, 0, true);

        const rc = wasmModule._vfs_fs_open(fsPtr, pathBufPtr, outBufPtr);
        const fd = dv.getUint32(0, true);

        self.postMessage({
            type: 'FS_OPEN_RES',
            id: msg.id,
            ok: rc === Offsets.VFS_FS_OK,
            code: rc,
            fd: rc === Offsets.VFS_FS_OK ? fd : 0
        });
        return;
    }

    if (type === 'FS_READ') {
        const len = Number(msg.len);
        if (!Number.isSafeInteger(len) || len < 0) {
            self.postMessage({ type: 'FS_READ_RES', id: msg.id, ok: false, code: Offsets.VFS_FS_ERR_INVALID_ARG });
            return;
        }
        if (len > FS_IPC_MAX_READ_BYTES) {
            self.postMessage({ type: 'FS_READ_RES', id: msg.id, ok: false, code: Offsets.VFS_FS_ERR_TOO_LARGE });
            return;
        }

        const bytesRead = wasmModule._vfs_fs_read(fsPtr, Number(msg.fd), scratchBufPtr, len);
        if (bytesRead >= 0n) {
            const count = Number(bytesRead);
            const slice = count > 0 ? new Uint8Array(wasmMemory.buffer, scratchBufPtr, count).slice() : new Uint8Array(0);
            self.postMessage(
                { type: 'FS_READ_RES', id: msg.id, ok: true, code: Offsets.VFS_FS_OK, bytes: slice.buffer },
                count > 0 ? [slice.buffer] : []
            );
        } else {
            const code = Number(bytesRead);
            self.postMessage({ type: 'FS_READ_RES', id: msg.id, ok: false, code });
            if (code === -2) postBuildRotated();
        }
        return;
    }

    if (type === 'FS_PREAD') {
        const len = Number(msg.len);
        const tBuf = msg.transferBuffer || null;
        if (!Number.isSafeInteger(len) || len < 0) {
            self.postMessage(
                { type: 'FS_PREAD_RES', id: msg.id, ok: false, code: Offsets.VFS_FS_ERR_INVALID_ARG, buffer: tBuf },
                tBuf ? [tBuf] : []
            );
            return;
        }
        if (len > FS_IPC_MAX_READ_BYTES) {
            self.postMessage(
                { type: 'FS_PREAD_RES', id: msg.id, ok: false, code: Offsets.VFS_FS_ERR_TOO_LARGE, buffer: tBuf },
                tBuf ? [tBuf] : []
            );
            return;
        }
        if (tBuf && tBuf.byteLength < len) {
            self.postMessage(
                { type: 'FS_PREAD_RES', id: msg.id, ok: false, code: Offsets.VFS_FS_ERR_INVALID_ARG, buffer: tBuf },
                [tBuf]
            );
            return;
        }

        let offset;
        try {
            offset = BigInt(msg.offset);
        } catch (err) {
            self.postMessage(
                { type: 'FS_PREAD_RES', id: msg.id, ok: false, code: Offsets.VFS_FS_ERR_INVALID_ARG, buffer: tBuf },
                tBuf ? [tBuf] : []
            );
            return;
        }
        const bytesRead = wasmModule._vfs_fs_pread(fsPtr, Number(msg.fd), offset, scratchBufPtr, len);
        if (bytesRead >= 0n) {
            const count = Number(bytesRead);
            if (tBuf) {
                if (count > 0) {
                    new Uint8Array(tBuf).set(new Uint8Array(wasmMemory.buffer, scratchBufPtr, count));
                }
                self.postMessage(
                    { type: 'FS_PREAD_RES', id: msg.id, ok: true, code: Offsets.VFS_FS_OK, bytesRead: count, buffer: tBuf },
                    [tBuf]
                );
            } else {
                const slice = count > 0 ? new Uint8Array(wasmMemory.buffer, scratchBufPtr, count).slice() : new Uint8Array(0);
                self.postMessage(
                    { type: 'FS_PREAD_RES', id: msg.id, ok: true, code: Offsets.VFS_FS_OK, bytes: slice.buffer, bytesRead: count },
                    count > 0 ? [slice.buffer] : []
                );
            }
        } else {
            const code = Number(bytesRead);
            self.postMessage(
                { type: 'FS_PREAD_RES', id: msg.id, ok: false, code, buffer: tBuf },
                tBuf ? [tBuf] : []
            );
            if (code === -2) postBuildRotated();
        }
        return;
    }

    if (type === 'FS_SEEK') {
        let offset;
        try {
            offset = BigInt(msg.offset);
        } catch (err) {
            self.postMessage({ type: 'FS_SEEK_RES', id: msg.id, ok: false, code: Offsets.VFS_FS_ERR_INVALID_ARG });
            return;
        }
        const whence = Number(msg.whence);
        const cur = wasmModule._vfs_fs_seek(fsPtr, Number(msg.fd), offset, whence);
        if (cur >= 0n) {
            self.postMessage({ type: 'FS_SEEK_RES', id: msg.id, ok: true, code: Offsets.VFS_FS_OK, cursor: cur });
        } else {
            self.postMessage({ type: 'FS_SEEK_RES', id: msg.id, ok: false, code: Number(cur) });
        }
        return;
    }

    if (type === 'FS_TELL') {
        const cur = wasmModule._vfs_fs_tell(fsPtr, Number(msg.fd));
        if (cur >= 0n) {
            self.postMessage({ type: 'FS_TELL_RES', id: msg.id, ok: true, code: Offsets.VFS_FS_OK, cursor: cur });
        } else {
            self.postMessage({ type: 'FS_TELL_RES', id: msg.id, ok: false, code: Number(cur) });
        }
        return;
    }

    if (type === 'FS_CLOSE') {
        const rc = wasmModule._vfs_fs_close(fsPtr, Number(msg.fd));
        self.postMessage({ type: 'FS_CLOSE_RES', id: msg.id, ok: rc === Offsets.VFS_FS_OK, code: rc });
        return;
    }

    if (type === 'FS_HINT_COLD') {
        let relOffset, len;
        try {
            relOffset = BigInt(msg.relOffset || 0n);
            len = BigInt(msg.len || 0n);
        } catch (err) {
            self.postMessage({ type: 'FS_HINT_COLD_RES', id: msg.id, ok: false, code: Offsets.VFS_FS_ERR_INVALID_ARG });
            return;
        }
        const flags = Number(msg.flags || 0);
        const rc = wasmModule._vfs_fs_hint_cold(fsPtr, Number(msg.fd), relOffset, len, flags);
        self.postMessage({ type: 'FS_HINT_COLD_RES', id: msg.id, ok: rc === Offsets.VFS_FS_OK, code: rc });
        return;
    }

    // Dolphin DiscIO BlobReader Handlers
    if (type === 'DISC_OPEN') {
        const pathBytes = new TextEncoder().encode((msg.path || 'game.iso') + '\0');
        if (pathBytes.length > 1024) {
            self.postMessage({ type: 'DISC_OPEN_RES', id: msg.id, ok: false, error: 'path too long' });
            return;
        }
        if (blobReaderPtr) {
            wasmModule._vfs_blob_close(blobReaderPtr);
            blobReaderPtr = 0;
        }
        new Uint8Array(wasmMemory.buffer, pathBufPtr, pathBytes.length).set(pathBytes);
        blobReaderPtr = wasmModule._vfs_blob_open(fsPtr, pathBufPtr);
        if (blobReaderPtr) {
            const size = wasmModule._vfs_blob_size(blobReaderPtr);
            const blockSize = wasmModule._vfs_blob_block_size(blobReaderPtr);
            self.postMessage({ type: 'DISC_OPEN_RES', id: msg.id, ok: true, size, blockSize });
        } else {
            self.postMessage({ type: 'DISC_OPEN_RES', id: msg.id, ok: false });
        }
        return;
    }

    if (type === 'DISC_IDENTIFY') {
        if (!blobReaderPtr) {
            self.postMessage({ type: 'DISC_IDENTIFY_RES', id: msg.id, ok: false, error: 'no open disc' });
            return;
        }
        const idBufPtr = outBufPtr;
        const titleBufPtr = pathBufPtr;
        const platformCode = wasmModule._vfs_blob_identify(blobReaderPtr, idBufPtr, 16, titleBufPtr, 64);
        let gameId = '';
        let gameTitle = '';
        if (platformCode > 0) {
            const idBytes = new Uint8Array(wasmMemory.buffer, idBufPtr, 16);
            const titleBytes = new Uint8Array(wasmMemory.buffer, titleBufPtr, 64);
            const idEnd = idBytes.indexOf(0);
            const titleEnd = titleBytes.indexOf(0);
            gameId = new TextDecoder().decode(idBytes.slice(0, idEnd >= 0 ? idEnd : 16));
            gameTitle = new TextDecoder().decode(titleBytes.slice(0, titleEnd >= 0 ? titleEnd : 64));
        }
        const platform = platformCode === 1 ? 'gamecube' : (platformCode === 2 ? 'wii' : 'unknown');
        self.postMessage({ type: 'DISC_IDENTIFY_RES', id: msg.id, ok: platformCode > 0, platform, gameId, gameTitle });
        return;
    }

    if (type === 'DISC_READ') {
        if (!blobReaderPtr) {
            self.postMessage({ type: 'DISC_READ_RES', id: msg.id, ok: false, error: 'no open disc' });
            return;
        }
        const len = Number(msg.len);
        if (!Number.isSafeInteger(len) || len < 0 || len > FS_IPC_MAX_READ_BYTES) {
            self.postMessage({ type: 'DISC_READ_RES', id: msg.id, ok: false, error: 'invalid read length' });
            return;
        }
        let offset;
        try {
            offset = BigInt(msg.offset || 0);
        } catch (err) {
            self.postMessage({ type: 'DISC_READ_RES', id: msg.id, ok: false, error: 'invalid offset' });
            return;
        }
        const success = wasmModule._vfs_blob_read(blobReaderPtr, offset, BigInt(len), scratchBufPtr);
        if (success === 1) {
            const bytes = len > 0 ? new Uint8Array(wasmMemory.buffer, scratchBufPtr, len).slice() : new Uint8Array(0);
            self.postMessage({ type: 'DISC_READ_RES', id: msg.id, ok: true, bytes: bytes.buffer }, len > 0 ? [bytes.buffer] : []);
        } else {
            self.postMessage({ type: 'DISC_READ_RES', id: msg.id, ok: false });
        }
        return;
    }

    if (type === 'DISC_CLOSE') {
        if (blobReaderPtr) {
            wasmModule._vfs_blob_close(blobReaderPtr);
            blobReaderPtr = 0;
        }
        self.postMessage({ type: 'DISC_CLOSE_RES', id: msg.id, ok: true });
        return;
    }
};

function setupPortB() {
    portB.onmessage = async (e) => {
        const { type, manifestHeaderBytes, arenaBytes } = e.data || {};
        if (type === 'GEOMETRY') {
            try {
                const arenaPages = Math.ceil(arenaBytes / 65536);
                const initialPages = 1024 + arenaPages;
                const maximumPages = Math.min(65536, initialPages + 4096);

                try {
                    wasmMemory = new WebAssembly.Memory({
                        initial: initialPages,
                        maximum: maximumPages,
                        shared: true
                    });
                } catch (memErr) {
                    portB.postMessage({ type: 'RETRY_SMALLER_POOL', reason: memErr.message });
                    return;
                }

                wasmModule = await createVfsModule({ wasmMemory });

                arenaPtr = wasmModule._aligned_alloc(65536, arenaBytes);
                if (!arenaPtr) {
                    portB.postMessage({ type: 'BOOT_ERROR', reason: 'aligned_alloc failed' });
                    return;
                }

                const hdrPtr = wasmModule._malloc(32);
                new Uint8Array(wasmMemory.buffer, hdrPtr, 32).set(manifestHeaderBytes);

                const ctxSize = wasmModule._vfs_client_ctx_size ? Number(wasmModule._vfs_client_ctx_size()) : 64;
                ctxPtr = wasmModule._malloc(ctxSize);
                const rc = wasmModule._vfs_init_arena(ctxPtr, arenaPtr, hdrPtr);
                wasmModule._free(hdrPtr);

                if (rc !== 0) {
                    portB.postMessage({ type: 'BOOT_ERROR', reason: `vfs_init_arena failed: ${rc}` });
                    return;
                }

                const fsSize = wasmModule._vfs_fs_struct_size ? Number(wasmModule._vfs_fs_struct_size()) : 8192;
                fsPtr = wasmModule._malloc(fsSize);
                new Uint8Array(wasmMemory.buffer, fsPtr, fsSize).fill(0);
                new DataView(wasmMemory.buffer, fsPtr, 4).setUint32(0, ctxPtr, true);

                scratchBufPtr = wasmModule._malloc(FS_IPC_MAX_READ_BYTES);
                tocBufPtr = wasmModule._malloc(tocBufCap);
                pathBufPtr = wasmModule._malloc(1024);
                outBufPtr = wasmModule._malloc(16);

                portB.postMessage({
                    type: 'ARENA_READY',
                    wasmMemory,
                    arenaOffset: arenaPtr
                });
            } catch (err) {
                portB.postMessage({ type: 'BOOT_ERROR', reason: err.message });
            }
        }
    };
}
