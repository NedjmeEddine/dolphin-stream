#include "vfs_blob_reader.h"
#include "disc_header.h"
#include <cassert>
#include <cstring>
#include <iostream>
#include <vector>

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

class MockBlobReader : public DiscIO::BlobReader {
public:
    std::vector<uint8_t> data;
    MockBlobReader(size_t sz) : data(sz, 0) {}
    uint64_t GetDataSize() const override { return data.size(); }
    uint64_t GetRawSize() const override { return data.size(); }
    uint64_t GetBlockSize() const override { return 262144ULL; }
    bool Read(uint64_t offset, uint64_t size, uint8_t* out) override {
        if (!out) return false;
        if (size == 0) return true;
        if (offset >= data.size() || offset + size > data.size()) return false;
        std::memcpy(out, data.data() + offset, size);
        return true;
    }
};

int main() {
    std::cout << "[disc_io_test] Starting DiscIO BlobReader verification suite..." << std::endl;

    // Test 1: Null fs in Create returns nullptr
    auto nullReader = DiscIO::VfsBlobReader::Create(nullptr, "game.iso");
    assert(nullReader == nullptr);

    // Test 2: Construction and basic sizing accessors
    const uint64_t dummySize = 1048576; // 1 MB
    uint32_t dummyFd = 1;
    DiscIO::VfsBlobReader reader(nullptr, dummyFd, dummySize);

    assert(reader.GetDataSize() == dummySize);
    assert(reader.GetRawSize() == dummySize);
    assert(reader.GetBlockSize() == 262144ULL); // Default block size fallback
    assert(reader.GetFd() == dummyFd);

    // Test 3: Input validation and EOF boundary checks
    uint8_t buffer[64];
    assert(!reader.Read(0, 16, nullptr));                    // Null destination buffer
    assert(reader.Read(0, 0, buffer));                       // Zero-byte read succeeds
    assert(!reader.Read(dummySize, 1, buffer));              // Read at exact EOF
    assert(!reader.Read(dummySize + 10, 1, buffer));         // Read past EOF
    assert(!reader.Read(dummySize - 10, 20, buffer));        // Partial read beyond EOF rejected

    // Test 4: Cold hint safety with null/empty ranges
    reader.HintCold(0, 0);
    reader.HintCold(dummySize + 100, 10);

    // Test 5: C ABI Bridge Verification (vfs_blob_*)
    assert(vfs_blob_open(nullptr, "game.iso") == nullptr);
    assert(vfs_blob_open(nullptr, nullptr) == nullptr);
    assert(vfs_blob_read(nullptr, 0, 16, buffer) == 0);
    assert(vfs_blob_size(nullptr) == 0);
    assert(vfs_blob_block_size(nullptr) == 0);
    vfs_blob_hint_cold(nullptr, 0, 10);
    vfs_blob_close(nullptr); // Safe no-op

    // C ABI with heap-allocated reader
    auto* heapReader = new DiscIO::VfsBlobReader(nullptr, dummyFd, dummySize);
    auto* opaque = reinterpret_cast<VfsBlobReaderOpaque*>(heapReader);

    assert(vfs_blob_size(opaque) == dummySize);
    assert(vfs_blob_block_size(opaque) == 262144ULL);
    assert(vfs_blob_read(opaque, 0, 0, buffer) == 1);
    assert(vfs_blob_read(opaque, 0, 16, nullptr) == 0);
    assert(vfs_blob_read(opaque, dummySize, 1, buffer) == 0);
    assert(vfs_blob_read(opaque, dummySize + 10, 1, buffer) == 0);
    vfs_blob_hint_cold(opaque, 0, 1024);

    vfs_blob_close(opaque); // Frees heapReader safely

    // Test 6: GameCube & Wii Boot Sector Header Parsing (ReadDiscHeader)
    MockBlobReader gcDisc(1048576);
    // Write GameCube boot sector: "GALE01" at 0x00, 0xC2339F3D at 0x18, title at 0x20
    std::memcpy(gcDisc.data.data(), "GALE01", 6);
    gcDisc.data[0x18] = 0xC2; gcDisc.data[0x19] = 0x33; gcDisc.data[0x1A] = 0x9F; gcDisc.data[0x1B] = 0x3D;
    std::memcpy(gcDisc.data.data() + 0x20, "Super Smash Bros. Melee", 23);

    DiscIO::DiscHeader gcHdr;
    assert(DiscIO::ReadDiscHeader(&gcDisc, &gcHdr));
    assert(gcHdr.platform == DiscIO::Platform::GameCube);
    assert(gcHdr.gameId == "GALE01");
    assert(gcHdr.gameTitle == "Super Smash Bros. Melee");
    assert(gcHdr.magic == 0xC2339F3D);

    // Test 7: Wii Boot Sector Header Parsing
    MockBlobReader wiiDisc(1048576);
    // Write Wii boot sector: "RMCE01" at 0x00, 0x5D1C9EA3 at 0x18, title at 0x20
    std::memcpy(wiiDisc.data.data(), "RMCE01", 6);
    wiiDisc.data[0x18] = 0x5D; wiiDisc.data[0x19] = 0x1C; wiiDisc.data[0x1A] = 0x9E; wiiDisc.data[0x1B] = 0xA3;
    std::memcpy(wiiDisc.data.data() + 0x20, "Mario Kart Wii", 14);

    DiscIO::DiscHeader wiiHdr;
    assert(DiscIO::ReadDiscHeader(&wiiDisc, &wiiHdr));
    assert(wiiHdr.platform == DiscIO::Platform::Wii);
    assert(wiiHdr.gameId == "RMCE01");
    assert(wiiHdr.gameTitle == "Mario Kart Wii");
    assert(wiiHdr.magic == 0x5D1C9EA3);

    // Test 8: Corrupt magic rejected
    wiiDisc.data[0x18] = 0x00;
    DiscIO::DiscHeader badHdr;
    assert(!DiscIO::ReadDiscHeader(&wiiDisc, &badHdr));
    assert(badHdr.platform == DiscIO::Platform::Unknown);

    // Test 9: Short disc rejected
    MockBlobReader shortDisc(64);
    assert(!DiscIO::ReadDiscHeader(&shortDisc, &badHdr));

    std::cout << "[disc_io_test] All DiscIO BlobReader assertions PASSED successfully." << std::endl;
    return 0;
}
