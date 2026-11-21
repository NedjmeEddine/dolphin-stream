#ifndef DISC_HEADER_H
#define DISC_HEADER_H

#include <cstdint>
#include <cstddef>
#include <string>

namespace DiscIO {

class BlobReader;

enum class Platform : uint8_t {
    Unknown = 0,
    GameCube = 1,
    Wii = 2
};

struct DiscHeader {
    Platform    platform = Platform::Unknown;
    std::string gameId;      // e.g. "GALE01" (GameID + Maker)
    std::string gameTitle;   // e.g. "Super Smash Bros. Melee"
    uint32_t    magic = 0;   // 0xC2339F3D (GC) or 0x5D1C9EA3 (Wii)
    uint8_t     version = 0;
};

// Reads sector 0 from reader and validates the GameCube or Wii disc header.
// Returns true if magic and layout are valid, false otherwise.
bool ReadDiscHeader(BlobReader* reader, DiscHeader* out);

} // namespace DiscIO

#ifdef __cplusplus
extern "C" {
#endif

typedef struct VfsBlobReaderOpaque VfsBlobReaderOpaque;

// C ABI convenience: extracts game ID (e.g. "GALE01") and title.
// Returns: 1 = GameCube, 2 = Wii, 0 = Unknown/Invalid.
int32_t vfs_blob_identify(VfsBlobReaderOpaque* reader, char* out_game_id, size_t id_cap, char* out_title, size_t title_cap);

#ifdef __cplusplus
}
#endif

#endif // DISC_HEADER_H
