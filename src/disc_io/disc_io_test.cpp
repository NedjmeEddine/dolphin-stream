#include "vfs_blob_reader.h"
#include <cassert>
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

    std::cout << "[disc_io_test] All DiscIO BlobReader assertions PASSED successfully." << std::endl;
    return 0;
}
