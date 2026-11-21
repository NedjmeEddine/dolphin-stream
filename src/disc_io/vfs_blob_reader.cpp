#include "vfs_blob_reader.h"
#include <iostream>

#if !defined(__clang__) && !defined(_Atomic)
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
    if (statRc == VFS_FS_OK) {
        uint32_t fd = 0;
        int32_t openRc = vfs_fs_open(fs, path.c_str(), &fd);
        if (openRc == VFS_FS_OK) {
            return std::make_unique<VfsBlobReader>(fs, fd, size);
        }
    }

    // shortcut: Fallback for raw ISO streams where TOC is absent (fs unmounted or raw ISO pack),
    // upgrade when all ISOs are packaged in VFSI directory packs.
    if (fs->ctx) {
        uint64_t archiveSize = vfs_archive_byte_size(fs->ctx);
        if (archiveSize > 0) {
            return std::make_unique<VfsBlobReader>(fs, 0, archiveSize);
        }
    }

    return nullptr;
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

    if (m_fd != 0) {
        int64_t bytesRead = vfs_fs_pread(m_fs, m_fd, offset, out_ptr, size);
        return bytesRead == static_cast<int64_t>(size);
    } else if (m_fs && m_fs->ctx) {
        ptrdiff_t bytesRead = vfs_read_sync(m_fs->ctx, offset, out_ptr, size);
        return bytesRead == static_cast<ptrdiff_t>(size);
    }
    return false;
}

void VfsBlobReader::HintCold(uint64_t offset, uint64_t size) {
    if (!m_fs || size == 0) return;
    if (m_fd != 0) {
        vfs_fs_hint_cold(m_fs, m_fd, offset, size, VFS_FS_HINT_INTERIOR_ONLY);
    } else if (m_fs->ctx) {
        uint32_t shift = vfs_block_shift(m_fs->ctx);
        uint32_t first_block = static_cast<uint32_t>(offset >> shift);
        uint32_t last_block = static_cast<uint32_t>((offset + size - 1) >> shift);
        for (uint32_t b = first_block; b <= last_block; ++b) {
            vfs_hint_cold(m_fs->ctx, b);
        }
    }
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
