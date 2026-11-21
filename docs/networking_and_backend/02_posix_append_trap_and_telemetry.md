# Chapter 3.2: POSIX Append Traps & Telemetry Routing

This document details two critical operational features of the Go backend: the POSIX `O_APPEND` vs. `WriteAt` kernel trap encountered during telemetry log initialization, and sub-game telemetry routing by `BuildEtagHash`.

---

## 1. The POSIX `O_APPEND` vs. `WriteAt` Trap

The streaming server records Markov transition edges streamed back from client browsers into a binary log file: `transitions_{etag}.log`.

The file begins with a 16-byte binary header (`TransitionLogHeader`):
* `0x00..0x03`: Magic bytes (`"TRNS"`)
* `0x04`: `neighbor_id_bytes` (1, 2, or 4)
* `0x05..0x07`: Reserved padding
* `0x08..0x0F`: `BuildEtagHash` (uint64)

Following the header, transition records are appended continuously as 4-byte or 8-byte tuples $(A \to B)$.

### The Trap in Naive Code

A developer naturally opens an append-only log file with `os.O_APPEND`:

```go
// SUBTLE BUG: os.O_APPEND breaks WriteAt(0)
logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0644)
// ...
_, err = logFile.WriteAt(hdrBuf[:], 0) // Intended: write header at offset 0
```

### The Kernel Behavior

According to POSIX.1-2008 and Linux kernel documentation for `pwrite(2)`:
> *"POSIX requires that opening a file with the `O_APPEND` flag should have no affect on the location at which `pwrite()` writes data. However, on Linux, if a file is opened with `O_APPEND`, `pwrite()` appends data to the end of the file, regardless of the value of `offset`."*

Because Go's `WriteAt` translates directly to the `pwrite64` system call:
* If the file already contained data, calling `logFile.WriteAt(hdrBuf[:], 0)` **silently ignores offset 0 and appends the header to the end of the file**.
* The file offset `0x00` remains corrupted or empty, and subsequent parser checks fail with `invalid transition log magic`.

### The Correct Fix (`internal/server/server.go`)

To reliably initialize the header at offset 0 while maintaining high append throughput, the file is opened **without `O_APPEND`**:

```go
// internal/server/server.go (Excerpt)
// 1. Open with O_RDWR (explicitly omitting os.O_APPEND)
logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_RDWR, 0644)
if err != nil {
    return nil, fmt.Errorf("open transition log %s: %w", logFilename, err)
}

stat, err := logFile.Stat()
if stat.Size() < 16 {
    // 2. Truncate and write header strictly at offset 0
    if err := logFile.Truncate(0); err != nil { ... }
    if _, err := logFile.WriteAt(hdrBuf[:], 0); err != nil { ... }
    if err := logFile.Sync(); err != nil { ... }
    
    // 3. Move file offset to end for subsequent streaming appends
    if _, err := logFile.Seek(0, io.SeekEnd); err != nil { ... }
} else {
    // Validate existing header matches active build ETag
    if _, err := io.ReadFull(logFile, hdrBuf[:]); err != nil { ... }
    if hdr.BuildEtagHash != header.BuildEtagHash {
        return nil, fmt.Errorf("etag mismatch in existing log")
    }
    // Seek to end of file for appending new client transitions
    if _, err := logFile.Seek(0, io.SeekEnd); err != nil { ... }
}
```

---

## 2. Telemetry Ingestion: No `fsync` in the Request Path

Browsers periodically flush transition logs to `/telemetry/transitions` via `navigator.sendBeacon()` or `fetch()`.

### The Performance Anti-Pattern

Calling `snap.logFile.Sync()` (the `fsync()` syscall) inside the HTTP request handler causes severe disk I/O bottlenecks:
* `fsync` forces an SSD cache flush, taking 2 ms–20 ms per call.
* With dozens of clients streaming transitions concurrently, server throughput collapses from 100,000 req/sec to $< 500\text{ req/sec}$.

### The Solution

The server relies on the OS page cache for append performance:
* The telemetry handler performs a standard unbuffered `logFile.Write(validBuf)`.
* `Sync()` is executed **only during snapshot retirement** (when a new build is loaded) or during clean server shutdown.
* OS crash safety is preserved because transition logs are additive statistical telemetry; losing the last 100 ms of transitions in a sudden kernel power outage has zero impact on game execution.

---

## 3. Sub-Game Telemetry Routing by `BuildEtagHash`

In multi-game setups, a single Go server instance hosts multiple games simultaneously (e.g. `ssbm` and `mkwii`). Each game has its own disc image, its own `manifest.bin`, and its own unique `BuildEtagHash`.

When a client finishes a gameplay session or returns to the Wii Menu, it submits telemetry:

```http
POST /telemetry/transitions?build=a1b2c3d4e5f67890 HTTP/1.1
Content-Type: application/octet-stream
```

### The 409 Conflict Bug

In early versions of the server, the endpoint checked telemetry strictly against the root server snapshot. If the user was playing a sub-game whose ETag differed from the root archive, the server rejected the telemetry with `409 Conflict`.

### The ETag Dispatch Solution (`internal/server/server.go`)

The server now routes incoming telemetry dynamically by matching the `build` query parameter against all loaded sub-game snapshots:

```go
// internal/server/server.go (Excerpt)
func (s *Server) handleTelemetry(w http.ResponseWriter, r *http.Request) {
    reqBuild := r.URL.Query().Get("build")
    
    // Acquire active snapshot
    snap := s.acquireSnapshot()
    defer snap.mu.RUnlock()

    var targetSnap *snapshot
    // Check if build matches the active root snapshot
    if reqBuild == "" || reqBuild == strings.Trim(snap.quotedBuildEtag, "\"") {
        targetSnap = snap
    } else {
        // Search registered sub-game catalog snapshots
        s.subGamesMu.RLock()
        for _, sub := range s.subGames {
            if reqBuild == strings.Trim(sub.quotedBuildEtag, "\"") {
                targetSnap = sub
                break
            }
        }
        s.subGamesMu.RUnlock()
    }

    if targetSnap == nil {
        http.Error(w, "unknown or inactive build ETag", http.StatusConflict)
        return
    }

    // Write transitions directly to the targeted game's log file
    targetSnap.logFileMu.Lock()
    _, err = targetSnap.logFile.Write(validBuf)
    targetSnap.logFileMu.Unlock()
    
    w.WriteHeader(http.StatusAccepted)
}
```

This guarantees that transition edges from Super Smash Bros. Melee are appended to `transitions_ssbm.log` and Mario Kart Wii transitions are appended to `transitions_mkwii.log`, even when both are served concurrently from the same domain.

---

## 4. Telemetry Rate Limiter Scale: Inline Eviction vs. Background Ticker

To protect the server from telemetry floods, `handleTelemetry` enforces a per-IP rate limit (`DefaultTelemetryRPM = 60`) backed by an in-memory map (`limiters: map[string]*clientWindow`).

### The Inline Map Probing Bottleneck

When the number of unique client IPs reaches 4,096:

```go
// internal/server/server.go:checkRateLimit (Excerpt)
if len(s.limiters) >= 4096 {
    probed := 0
    evicted := false
    for k, v := range s.limiters {
        if now.Sub(v.windowStart) > time.Minute {
            delete(s.limiters, k)
            evicted = true
            break
        }
        probed++
        if probed >= 16 { break }
    }
    if !evicted {
        for k := range s.limiters {
            delete(s.limiters, k)
            break
        }
    }
}
```

Under high unique IP churn (e.g., hundreds of players closing tabs concurrently):
* Probing 16 map entries inside the request path while holding `limiterMu` incurs non-deterministic latency.
* If all 16 probed entries are active within their 1-minute window, the loop falls back to evicting an arbitrary active IP via a non-deterministic Go map iteration (`for k := range s.limiters`).

### Production Scale Pattern

For deployments expected to sustain tens of thousands of concurrent players, the recommended upgrade pattern separates eviction from the request path:
1. Maintain client windows in a ring-partitioned shard or LRU cache.
2. Run a periodic background ticker (`time.NewTicker(time.Minute)`) to sweep expired IP windows without holding locks during HTTP requests.
