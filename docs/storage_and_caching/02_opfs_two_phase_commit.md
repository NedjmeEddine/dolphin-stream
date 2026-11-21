# Chapter 5.2: OPFS Two-Phase Commit & Crash Consistency

This document details the persistent L2 SSD cache architecture implemented in `client/web/worker_b_core.mjs` using the browser’s **Origin Private File System (OPFS)** and `FileSystemSyncAccessHandle`.

---

## 1. The L2 Persistent Cache Architecture

While the 64 MB `SharedArrayBuffer` slab provides high-speed L1 RAM caching ($< 100\text{ ns}$ access latency), browser tabs have bounded memory and discard RAM upon closing.

To avoid re-downloading disc blocks across gameplay sessions, DolphinStream maintains a persistent block cache stored directly on the client’s local SSD via OPFS:

```text
OPFS Root Directory:
├── cache_ssbm.opfs     (L2 persistent cache for Super Smash Bros. Melee)
├── cache_mkwii.opfs    (L2 persistent cache for Mario Kart Wii)
└── saves/
    ├── ssbm/           (Memory Card files, e.g. "GC_SSBM.raw")
    └── mkwii/          (Wii NAND save files, e.g. "banner.bin")
```

### File Geometry of `cache_${gameId}.opfs`

```text
Offset 0x0000..0x001F: Cache Header (32 Bytes: Magic "VFSC", Version, TotalBlocks, BlockShift)
Offset 0x0020..0xXXXX: Presence Bitmap (ceil(TotalBlocks / 8) bytes)
Offset 0xXXXX..End   : Block Payloads (Indexed by: PayloadBase + (BlockID << BlockShift))
```

---

## 2. The Crash Inconsistency Hazard

Consider what happens if a naive write-behind cache persists blocks to OPFS:

```javascript
// DANGEROUS ANTI-PATTERN: Updating bitmap first
this.opfsHandle.write(updatedBitmap, { at: bitmapOffset });
this.opfsHandle.write(blockPayload,  { at: payloadOffset });
this.opfsHandle.flush();
```

### The Power Outage / Tab Close Scenario

If the user closes the browser tab, the OS crashes, or the browser runs out of battery between writing the bitmap and writing the payload:
1. The on-disk bitmap marks block $b$ as **present** (`1`).
2. The block payload on disk at `payloadOffset` contains **uninitialized zeroes or corrupted partial bytes**.
3. When the user returns to the game tomorrow:
   * The engine reads the on-disk bitmap during boot.
   * It sees block $b$ marked as present and skips network streaming.
   * The emulator reads from OPFS and receives corrupt zeroes, crashing the game on boot!

---

## 3. The Two-Phase Commit Protocol

To guarantee crash resilience, `WorkerBCore` implements a strict **Two-Phase Flush Protocol** (`client/web/worker_b_core.mjs`):

```javascript
// client/web/worker_b_core.mjs (Excerpt)
flushOPFS() {
    if (!this.opfsHandle || this.blocksWrittenSinceFlush === 0) return;
    try {
        // PHASE 1: Flush all pending data block payloads to physical storage
        if (this.opfsHandle.flush) {
            this.opfsHandle.flush();
        }

        // PHASE 2: Write updated presence bitmap only after payloads are committed
        this.opfsHandle.write(this.pendingBitmap, { at: this.bitmapOffset });

        // Flush bitmap to physical storage
        if (this.opfsHandle.flush) {
            this.opfsHandle.flush();
        }

        // Phase 3: Update in-memory persisted bitmap state
        this.persistedBitmap.set(this.pendingBitmap);
        this.blocksWrittenSinceFlush = 0;
        this.lastOPFSFlushTime = this.clockFn();
    } catch (e) {
        console.error('OPFS flush failed:', e);
    }
}
```

### Why This Order Is Crash-Safe

* **Crash during Phase 1:** Payload blocks may be partially written to disk, but the presence bitmap on disk **still has bit $b = 0$**. On subsequent boot, the engine treats block $b$ as a cache miss and streams fresh data from the network.
* **Crash during Phase 2:** Payload blocks are already fully committed to storage. If the bitmap write fails, the block is safely re-fetched. If the bitmap write succeeds, data integrity is 100% guaranteed.
* **In-memory state:** `persistedBitmap` is updated **only after** physical SSD flush confirms successful write.

---

## 4. Cache & Save Namespacing by `gameId` (Commit `d3f8a66`)

In earlier builds of the engine, the cache filename was hardcoded to `cache.opfs` and saves were written to `/saves/`.

### The Cross-Game Contamination Bug

When switching between Super Smash Bros. Melee (GameCube, 1.4 GB) and Mario Kart Wii (Wii, 4.7 GB):
1. `cache.opfs` was overwritten with conflicting block mappings.
2. Wii save files collided with GameCube save files of the same name.
3. Returning to Melee resulted in cache corruption because Melee block 10 was mapped to Mario Kart block 10.

### The Fix: Multi-Game Scoping

Commit `d3f8a66` partitions storage handles dynamically by `gameId`:

```javascript
// client/web/worker_b.js (Excerpt)
const cacheName = gameId ? `cache_${gameId}.opfs` : 'cache.opfs';
const fileHandle = await root.getFileHandle(cacheName, { create: true });
opfsHandle = await fileHandle.createSyncAccessHandle();

// Saves directory scoping
const savesDir = await root.getDirectoryHandle('saves', { create: true });
const gameSavesDir = gameId ? await savesDir.getDirectoryHandle(gameId, { create: true }) : savesDir;
```

Each game now operates in an isolated storage namespace:
* `cache_ssbm.opfs` preserves Melee sectors indefinitely.
* `cache_mkwii.opfs` preserves Mario Kart tracks indefinitely.
* Save states reside in `/saves/ssbm/` and `/saves/mkwii/`, completely eliminating cross-game overwrites.

---

## 5. Idle Write-Behind & Dirty Gates

Writing to OPFS synchronously on every network slice fetch would degrade download throughput. Instead, Worker B uses an **idle write-behind loop** (`idleOPFSWriteBehind`):

```javascript
// client/web/worker_b_core.mjs (Excerpt)
idleOPFSWriteBehind() {
    if (!this.opfsHandle) return;
    for (let f = 0; f < this.totalFrames; f++) {
        const entry = this.readFrameEntry(f);
        if (entry.state === Offsets.FRAME_READY && (entry.flags & Offsets.FLAG_DIRTY_OPFS)) {
            if (entry.block_id !== Offsets.VFS_INVALID_BLOCK) {
                const slabOff = Offsets.VFS_ARENA_SLAB_OFFSET + f * this.blockSize;
                // Write block to OPFS
                this.writeBlockToOPFS(entry.block_id, slabOff);
                // Atomically clear dirty flag
                const base = (Offsets.VFS_ARENA_DIR_OFFSET + f * Offsets.PAGE_FRAME_ENTRY_SIZE) >>> 2;
                Atomics.and(this.u32, base + 4, ~Offsets.FLAG_DIRTY_OPFS);
            }
        }
    }
    this.flushOPFS();
}
```

* Freshly streamed network blocks are flagged with `FLAG_DIRTY_OPFS`.
* During idle cycles (when no demand reads are stalling the engine), Worker B batches dirty blocks to OPFS in the background.
* The atomic `Atomics.and` clears the dirty flag without touching reader pin states.
