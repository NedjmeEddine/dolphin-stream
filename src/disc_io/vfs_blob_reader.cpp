#include "vfs_blob_reader.h"
#include <iostream>

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
    if (offset >= m_size) return false;

    // Clamp read to end of disc image
    uint64_t toRead = size;
    if (offset + toRead > m_size) {
        toRead = m_size - offset;
    }

    int64_t bytesRead = vfs_fs_pread(m_fs, m_fd, offset, out_ptr, toRead);
    return bytesRead == static_cast<int64_t>(toRead);
}

void VfsBlobReader::HintCold(uint64_t offset, uint64_t size) {
    if (!m_fs || !m_fd || size == 0) return;
    vfs_fs_hint_cold(m_fs, m_fd, offset, size, VFS_FS_HINT_INTERIOR_ONLY);
}

} // namespace DiscIO
