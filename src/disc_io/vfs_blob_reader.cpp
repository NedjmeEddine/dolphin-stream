#include "vfs_blob_reader.h"
#include <iostream>

#ifndef _Atomic
#define _Atomic
#endif
#ifndef _Static_assert
#define _Static_assert static_assert
#endif

extern "C" {
#include "externals/vfs-streamer/client/vfs/vfs_client.h"
#include "externals/vfs-streamer/client/vfs/vfs_fs.h"
}

namespace DiscIO {

std::unique_ptr<VfsBlobReader> VfsBlobReader::Create(VfsFs* fs, const std::string& path) {
    if (!fs) return nullptr;

    uint64_t size = 0;
    int32_t statRc = vfs_fs_stat(fs, path.c_str(), &size);
    if (statRc != VFS_FS_OK) {
        std::cerr << "[VfsBlobReader] stat failed on " << path << ": " << statRc << std::endl;
        return nullptr;
    }

    uint32_t fd = 0;
    int32_t openRc = vfs_fs_open(fs, path.c_str(), &fd);
    if (openRc != VFS_FS_OK) {
        std::cerr << "[VfsBlobReader] open failed on " << path << ": " << openRc << std::endl;
        return nullptr;
    }

    return std::make_unique<VfsBlobReader>(fs, fd, size);
}

VfsBlobReader::VfsBlobReader(VfsFs* fs, uint32_t fd, uint64_t discSize)
    : m_fs(fs), m_fd(fd), m_size(discSize) {
}

VfsBlobReader::~VfsBlobReader() {
    if (m_fs && m_fd) {
        vfs_fs_close(m_fs, m_fd);
        m_fd = 0;
    }
}

uint64_t VfsBlobReader::GetBlockSize() const {
    if (!m_fs || !m_fs->ctx) return 262144ULL; // Default 256 KB
    return 1ULL << vfs_block_shift(m_fs->ctx);
}

bool VfsBlobReader::Read(uint64_t offset, uint64_t size, uint8_t* out_ptr) {
    if (!out_ptr) return false;
    if (size == 0) return true;
    if (offset >= m_size || offset + size > m_size) return false;

    int64_t bytesRead = vfs_fs_pread(m_fs, m_fd, offset, out_ptr, size);
    return bytesRead == static_cast<int64_t>(size);
}

void VfsBlobReader::HintCold(uint64_t offset, uint64_t size) {
    if (!m_fs || !m_fd || size == 0) return;
    vfs_fs_hint_cold(m_fs, m_fd, offset, size, VFS_FS_HINT_INTERIOR_ONLY);
}

} // namespace DiscIO

extern "C" {

VfsBlobReaderOpaque* vfs_blob_open(struct VfsFs* fs, const char* path) {
    if (!fs || !path) return nullptr;
    auto reader = DiscIO::VfsBlobReader::Create(fs, path);
    return reinterpret_cast<VfsBlobReaderOpaque*>(reader.release());
}

int32_t vfs_blob_read(VfsBlobReaderOpaque* reader, uint64_t offset, uint64_t size, uint8_t* out_ptr) {
    if (!reader) return 0;
    auto* r = reinterpret_cast<DiscIO::VfsBlobReader*>(reader);
    return r->Read(offset, size, out_ptr) ? 1 : 0;
}

uint64_t vfs_blob_size(const VfsBlobReaderOpaque* reader) {
    if (!reader) return 0;
    const auto* r = reinterpret_cast<const DiscIO::VfsBlobReader*>(reader);
    return r->GetDataSize();
}

uint64_t vfs_blob_block_size(const VfsBlobReaderOpaque* reader) {
    if (!reader) return 0;
    const auto* r = reinterpret_cast<const DiscIO::VfsBlobReader*>(reader);
    return r->GetBlockSize();
}

void vfs_blob_hint_cold(VfsBlobReaderOpaque* reader, uint64_t offset, uint64_t size) {
    if (!reader) return;
    auto* r = reinterpret_cast<DiscIO::VfsBlobReader*>(reader);
    r->HintCold(offset, size);
}

void vfs_blob_close(VfsBlobReaderOpaque* reader) {
    if (!reader) return;
    delete reinterpret_cast<DiscIO::VfsBlobReader*>(reader);
}

} // extern "C"
