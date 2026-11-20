#ifndef VFS_BLOB_READER_H
#define VFS_BLOB_READER_H

#include <cstdint>
#include <cstddef>
#include <memory>
#include <string>

// Forward declaration of Layer 5 VFS handle from submodule
struct VfsFs;

namespace DiscIO {

// Standalone forward declaration matching Dolphin's DiscIO::BlobReader
#ifndef DOLPHIN_BLOB_READER_DECLARED
#define DOLPHIN_BLOB_READER_DECLARED
class BlobReader {
public:
    virtual ~BlobReader() = default;
    virtual uint64_t GetDataSize() const = 0;
    virtual uint64_t GetRawSize() const = 0;
    virtual uint64_t GetBlockSize() const = 0;
    virtual bool Read(uint64_t offset, uint64_t size, uint8_t* out_ptr) = 0;
};
#endif

/**
 * VfsBlobReader
 * 
 * Adapts Dolphin's disc-reading interface (DiscIO::BlobReader) to the Out-of-Core
 * WebAssembly predictive streaming VFS.
 * 
 * Guarantees:
 * - Zero allocations on the Read() hot path.
 * - Thread-safe synchronous reads: blocks Worker A on io_futex while
 *   Worker B streams 256 KB blocks asynchronously over HTTP 206 / OPFS.
 * - Native 64-bit addressing: streams 1.4 GB (GC) and 4.7-8.5 GB (Wii) ISOs
 *   inside a strictly bounded 32-64 MB SharedArrayBuffer slab.
 */
class VfsBlobReader : public BlobReader {
public:
    static std::unique_ptr<VfsBlobReader> Create(VfsFs* fs, const std::string& path);

    VfsBlobReader(VfsFs* fs, uint32_t fd, uint64_t discSize);
    ~VfsBlobReader() override;

    uint64_t GetDataSize() const override { return m_size; }
    uint64_t GetRawSize() const override { return GetDataSize(); }
    uint64_t GetBlockSize() const override;

    // Synchronously reads `size` bytes starting at `offset` into `out_ptr`.
    // Calls vfs_fs_pread without altering any shared file cursor.
    bool Read(uint64_t offset, uint64_t size, uint8_t* out_ptr) override;

    // Signals that the underlying disc blocks are cold and eligible for eviction
    // (useful after Dolphin uploads textures to GPU or finishes an FMV cutscene).
    void HintCold(uint64_t offset, uint64_t size);

    uint32_t GetFd() const { return m_fd; }

private:
    VfsFs*   m_fs;
    uint32_t m_fd;
    uint64_t m_size;
};

} // namespace DiscIO

#endif // VFS_BLOB_READER_H
