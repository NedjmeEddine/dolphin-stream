#include "disc_header.h"
#include "vfs_blob_reader.h"
#include <cstring>
#include <array>
#include <cstdio>

namespace DiscIO {

constexpr uint32_t GAMECUBE_MAGIC = 0xC2339F3D;
constexpr uint32_t WII_MAGIC      = 0x5D1C9EA3;

bool ReadDiscHeader(BlobReader* reader, DiscHeader* out) {
    if (!reader || !out) return false;

    std::array<uint8_t, 0x100> sector0{};
    if (!reader->Read(0, sector0.size(), sector0.data())) {
        return false;
    }

    auto readBE32 = [](const uint8_t* p) -> uint32_t {
        return (static_cast<uint32_t>(p[0]) << 24) |
               (static_cast<uint32_t>(p[1]) << 16) |
               (static_cast<uint32_t>(p[2]) << 8)  |
                static_cast<uint32_t>(p[3]);
    };

    uint32_t magic18 = readBE32(sector0.data() + 0x18);
    uint32_t magic1C = readBE32(sector0.data() + 0x1C);
    uint32_t magic = 0;

    if (magic18 == WII_MAGIC) {
        out->platform = Platform::Wii;
        magic = magic18;
    } else if (magic1C == GAMECUBE_MAGIC || magic18 == GAMECUBE_MAGIC) {
        out->platform = Platform::GameCube;
        magic = GAMECUBE_MAGIC;
    } else {
        out->platform = Platform::Unknown;
        return false;
    }

    out->magic = magic;
    out->version = sector0[0x07];

    // Game ID: 4-byte game code + 2-byte maker code
    char idBuf[7] = {0};
    std::memcpy(idBuf, sector0.data(), 6);
    out->gameId = idBuf;

    // Game Title: up to 64 bytes at offset 0x20
    char titleBuf[65] = {0};
    std::memcpy(titleBuf, sector0.data() + 0x20, 64);
    out->gameTitle = titleBuf;

    return true;
}

} // namespace DiscIO

extern "C" {

int32_t vfs_blob_identify(VfsBlobReaderOpaque* reader, char* out_game_id, size_t id_cap, char* out_title, size_t title_cap) {
    if (!reader) return 0;
    auto* r = reinterpret_cast<DiscIO::VfsBlobReader*>(reader);
    DiscIO::DiscHeader hdr;
    if (!DiscIO::ReadDiscHeader(r, &hdr)) {
        return 0;
    }

    if (out_game_id && id_cap > 0) {
        snprintf(out_game_id, id_cap, "%s", hdr.gameId.c_str());
    }
    if (out_title && title_cap > 0) {
        snprintf(out_title, title_cap, "%s", hdr.gameTitle.c_str());
    }
    return static_cast<int32_t>(hdr.platform);
}

} // extern "C"
