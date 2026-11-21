# Chapter 3.1: Thread-Safe HTTP Range Serving & ETag Traps

This document explains the network architecture of the Go streaming server (`externals/vfs-streamer/internal/server`), focusing on two subtle HTTP/POSIX failure modes: file descriptor offset corruption during concurrent range requests, and the browser `If-Range` downgrade trap.

---

## 1. The `*os.File` Offset Corruption Trap

In Go's standard library, `http.ServeContent` is the standard way to serve files over HTTP with automatic `206 Partial Content` and `Range` header support:

```go
// NAIVE ANTI-PATTERN (DO NOT USE)
func servePack(w http.ResponseWriter, r *http.Request, f *os.File, size int64) {
    http.ServeContent(w, r, "pak_0000.bin", modTime, f)
}
```

### The Failure Mode

In Linux and POSIX systems, an `*os.File` possesses a single, stateful kernel file offset.
1. When `http.ServeContent` serves a range request (e.g. `bytes=0-262143`), it calls `f.Seek(0, io.SeekStart)` followed by `f.Read(buf)`.
2. Worker B routinely issues **up to 4 concurrent range requests** simultaneously (demand read + top-$K$ prefetch blocks).
3. If two goroutines execute `ServeContent` on the same `*os.File` handle:
   * Goroutine A seeks to offset 0 MB.
   * Goroutine B seeks to offset 500 MB.
   * Goroutine A calls `Read()`: it receives bytes from 500 MB instead of 0 MB!
4. **Result:** Worker B receives corrupted block payloads, the SHA-256/CRC integrity checks fail, or emulator memory is filled with arbitrary byte data from different parts of the disc.

---

## 2. The Stateless `pread` Fix (`io.NewSectionReader`)

To serve concurrent HTTP range requests without locks, the server must use the POSIX `pread()` system call. Unlike `read()`, `pread()` takes an explicit offset and **does not modify the file descriptor's seek offset**.

In Go, `http.ServeContent` detects whether the provided reader implements `io.ReaderAt`. If it does, it uses `pread()` instead of `Seek()` + `Read()`.

### The Solution in `internal/server/server.go`

```go
// internal/server/server.go (Excerpt)
func (s *Server) servePackDirect(w http.ResponseWriter, r *http.Request, 
                               snap *snapshot, filename string) {
    handle, ok := snap.packHandles[filename]
    if !ok {
        http.NotFound(w, r)
        return
    }

    // Wrap the pre-opened OS file in an io.NewSectionReader per request.
    // SectionReader implements io.ReadSeeker and io.ReaderAt via stateless pread.
    section := io.NewSectionReader(handle.file, 0, handle.size)
    http.ServeContent(w, r, filename, handle.modTime, section)
}
```

By wrapping `handle.file` in `io.NewSectionReader`, hundreds of concurrent goroutines can read arbitrary slices of the same pack file simultaneously with zero lock contention and zero offset corruption.

---

## 3. The `If-Range` ETag Downgrade Trap

When a web browser caches an HTTP resource and subsequently makes a range request, it frequently sends an `If-Range` header containing the ETag of its cached copy:

```http
GET /packs/pak_0000.bin HTTP/1.1
Host: 127.0.0.1:8080
Range: bytes=262144-524287
If-Range: "1a2b3c4d5e6f7a8b"
```

### The Catastrophic Failure Mode

According to RFC 7233 §3.2:
* If the server's current ETag does not match the client's `If-Range` ETag byte-for-byte, **the server must ignore the `Range` header and return the entire resource with `200 OK`**.
* In DolphinStream, pack files (`pak_*.bin`) are typically 16 MB to 512 MB in size (or multi-gigabyte files in single-pack mode).
* If a browser passes a stale ETag, or if an intermediate reverse proxy strips quotes from the ETag, Go's `http.ServeContent` downgrades the request:
  * Instead of returning the requested **256 KB slice** with `206 Partial Content`, it begins streaming the **full 512 MB pack file** with `200 OK`!
  * Worker B's array buffer allocations overflow, bandwidth consumption spikes 2,000%, and the streaming runtime grinds to a halt.

### The Solution: Strip `If-Range` on Immutable Packs

Pack files in DolphinStream are **strictly immutable**. Their filenames are derived deterministically from the 64-bit `BuildEtagHash` of the manifest (`pak_{etag}_{index}.bin`). Therefore, a pack file can never be modified in-place.

The server unconditionally deletes `If-Range` on pack routes before calling `http.ServeContent`:

```go
// internal/server/server.go (Excerpt)
// Invariant: Strip If-Range so mismatched ETags on immutable packs never fall back to 200 OK
r.Header.Del("If-Range")

w.Header().Set("Content-Type", "application/octet-stream")
w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
w.Header().Set("ETag", snap.quotedBuildEtag)

section := io.NewSectionReader(handle.file, 0, handle.size)
http.ServeContent(w, r, filename, handle.modTime, section)
```

With `If-Range` deleted:
* Every valid `Range` request is guaranteed to receive a `206 Partial Content` response containing only the exact 256 KB block requested.
* The response includes `Cache-Control: immutable`, instructing browser caches and CDNs to store slices permanently without revalidation.
