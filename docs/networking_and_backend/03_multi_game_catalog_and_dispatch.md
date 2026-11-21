# Chapter 3.3: Multi-Game Catalog & Dynamic Dispatch

This document details the multi-game catalog architecture (`internal/server/catalog.go`), the route multiplexer, and the automatic single-game synthesis fallback.

---

## 1. Multi-Game Catalog Schema (`games.json`)

To support hosting multiple GameCube and Wii titles on a single streaming origin, the server reads an optional `games.json` file from the data directory (`-data-dir`).

### Schema Definition

```json
{
  "version": 1,
  "games": [
    {
      "id": "ssbm",
      "title": "Super Smash Bros. Melee",
      "platform": "gamecube",
      "cover": "/games/ssbm/cover.png",
      "bannerSound": "/games/ssbm/banner.wav",
      "discSize": 1459978240,
      "blockShift": 18,
      "poolMb": 64
    },
    {
      "id": "mkwii",
      "title": "Mario Kart Wii",
      "platform": "wii",
      "cover": "/games/mkwii/cover.png",
      "bannerSound": "/games/mkwii/banner.wav",
      "discSize": 4699979776,
      "blockShift": 18,
      "poolMb": 64
    }
  ]
}
```

### Strict Validation Rules (`internal/server/catalog.go`)

Every entry in `games.json` is validated before server startup:

1. **Path Traversal Guard:** `id` must be alphanumeric (allowing `-` and `_`) and length 1–64. Any ID containing `.`, `..`, `/`, `\`, or whitespace is immediately rejected to prevent directory traversal attacks.
2. **Platform Constraints:** `platform` must be either `"gamecube"` or `"wii"`. Unknown platforms are rejected.
3. **Disc Sizing:** `discSize` must be $> 0$.
4. **Memory Geometry:** `blockShift` must be in the range $[12, 24]$ (typically 18 = 256 KB). `poolMb` must be $\ge 16$.

---

## 2. Automatic Single-Game Synthesis Fallback

When deploying a quick demo or testing a single newly sliced game, requiring developers to write a boilerplate `games.json` is tedious.

If `games.json` does not exist in `dataDir`, the server automatically synthesizes a single-game catalog from the root `manifest.bin`:

```go
// internal/server/catalog.go (Excerpt)
func SynthesizeCatalog(hdr *manifest.ManifestHeader) *Catalog {
    discSize := int64(hdr.TotalBlocks) << hdr.BlockShift
    platform := "gamecube"
    if discSize > 2000000000 { // Discs > 2 GB are Wii (GC discs are 1.4 GB)
        platform = "wii"
    }

    return &Catalog{
        Version: 1,
        Games: []GameEntry{
            {
                ID:         "disc",
                Title:      "Disc Channel",
                Platform:   platform,
                Cover:      "",
                DiscSize:   discSize,
                BlockShift: hdr.BlockShift,
                PoolMB:     int(hdr.DefaultPoolMB),
            },
        },
    }
}
```

* Computes total disc size as $\text{TotalBlocks} \times 2^{\text{BlockShift}}$.
* Heuristically determines platform: files $> 2\text{ GB}$ are Wii dual/single-layer discs, while files $\le 2\text{ GB}$ are GameCube discs (1.4 GB).
* The synthesized catalog is served at `GET /games.json` with `id: "default"`.

### Frontend Slot 0 Disc Channel Reconciliation (`web/index.html`)

In `web/index.html`, the 4x3 channel grid reserves Slot 0 for the authentic physical Disc Channel (`id="disc-channel"`), while slots 1..11 represent installed Wii Channels.

When `games.json` is synthesized for a single game:

```javascript
// web/index.html (Excerpt)
if (cat.games.length === 1 && cat.games[0].id === 'default') {
    // Single-game synthesized catalog attaches to Disc Channel (slot 0)
    const discSlot = channelSlots[0];
    if (discSlot) {
        discSlot.dataset.gameId = 'default';
        const titleEl = discSlot.querySelector('.channel-title');
        if (titleEl && cat.games[0].title) titleEl.textContent = cat.games[0].title;
    }
    return;
}
```

This ensures that running in single-game fallback mode places the game directly into the animated Disc Channel slot rather than shifting it into the Mii Channel slot (Slot 1), preserving the authentic Wii startup experience.

---

## 3. Dynamic Multi-Game Route Dispatch

The Go server dispatches requests across games using a prefix-based multiplexer:

```text
Incoming HTTP Request Path               Target Handler
--------------------------               --------------
GET /games.json                          handleCatalog (JSON list of games)
GET /manifest.bin                        serveManifestDirect (Root game)
GET /packs/{filename}                    servePackDirect (Root game)
GET /games/{gameId}/manifest.bin         serveSubGameManifest ({gameId} snapshot)
GET /games/{gameId}/packs/{filename}     serveSubGamePack ({gameId} snapshot)
POST /telemetry/transitions?build={hash} handleTelemetry (ETag matched game)
```

### Zero-Allocation Sub-Game Resolution

```go
// internal/server/server.go (Excerpt)
func (s *Server) serveSubGamePack(w http.ResponseWriter, r *http.Request, 
                                 gameID, filename string) {
    s.subGamesMu.RLock()
    snap, ok := s.subGames[gameID]
    s.subGamesMu.RUnlock()

    if !ok {
        http.NotFound(w, r)
        return
    }

    s.servePackDirect(w, r, snap, filename)
}
```

---

## 4. Frontend & Worker Dynamic Slicing Integration

In `web/index.html`, selecting a game card passes the selected `gameId` to the worker pipeline:

```javascript
// web/index.html (Excerpt)
function launchGame(game) {
    const gameId = game.id;
    // Launch Worker A & Worker B
    workerA = new Worker('worker_a.js', { type: 'module' });
    workerB = new Worker('worker_b.js', { type: 'module' });

    // Establish direct MessageChannel between Worker A and Worker B
    const channel = new MessageChannel();
    workerA.postMessage({ type: 'INIT_PORT', port: channel.port1 }, [channel.port1]);
    workerB.postMessage({ 
        type: 'INIT_PORT', 
        port: channel.port2, 
        gameId: gameId,
        manifestUrl: `/games/${gameId}/manifest.bin`
    }, [channel.port2]);
}
```

Inside `worker_b.js`, pack requests automatically prefix their URLs with `/games/${gameId}/packs/`, ensuring completely isolated network fetching, separate OPFS caches (`cache_${gameId}.opfs`), and independent save directories (`/saves/${gameId}/`).
