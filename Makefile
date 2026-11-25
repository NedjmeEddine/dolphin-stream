CC ?= gcc
CXX ?= g++
EMCC ?= emcc

BUILD_DIR = build
VFS_DIR = externals/vfs-streamer/client/vfs
CFLAGS = -std=c11 -O2 -Wall -Wextra -pthread -I. -Iexternals/vfs-streamer -I$(VFS_DIR)
CXXFLAGS = -std=c++20 -O2 -Wall -Wextra -pthread -I. -Iexternals/vfs-streamer -I$(VFS_DIR)

VFS_OBJS = $(BUILD_DIR)/vfs_client.o $(BUILD_DIR)/vfs_fs.o $(BUILD_DIR)/vfs_hal.o $(BUILD_DIR)/vfs_policy.o
DISC_IO_OBJS = $(BUILD_DIR)/vfs_blob_reader.o $(BUILD_DIR)/disc_header.o

all: libdolphin_vfs.a disc_io_test

libdolphin_vfs.a: $(DISC_IO_OBJS) $(VFS_OBJS)
	ar rcs $@ $^

disc_io_test: src/disc_io/disc_io_test.cpp $(DISC_IO_OBJS) $(VFS_OBJS)
	$(CXX) $(CXXFLAGS) -DVFS_TESTING $^ -o $@

$(BUILD_DIR)/vfs_blob_reader.o: src/disc_io/vfs_blob_reader.cpp | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -c $< -o $@

$(BUILD_DIR)/disc_header.o: src/disc_io/disc_header.cpp | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -c $< -o $@

$(BUILD_DIR)/%.o: $(VFS_DIR)/%.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

test: disc_io_test
	./disc_io_test

EMCXX ?= em++

wasm:
	mkdir -p $(BUILD_DIR)/embuild
	$(EMCC) -std=c11 -O2 -pthread -I. -I$(VFS_DIR) -Isrc -Isrc/disc_io -c $(VFS_DIR)/vfs_client.c -o $(BUILD_DIR)/embuild/vfs_client.o
	$(EMCC) -std=c11 -O2 -pthread -I. -I$(VFS_DIR) -Isrc -Isrc/disc_io -c $(VFS_DIR)/vfs_hal.c -o $(BUILD_DIR)/embuild/vfs_hal.o
	$(EMCC) -std=c11 -O2 -pthread -I. -I$(VFS_DIR) -Isrc -Isrc/disc_io -c $(VFS_DIR)/vfs_policy.c -o $(BUILD_DIR)/embuild/vfs_policy.o
	$(EMCC) -std=c11 -O2 -pthread -I. -I$(VFS_DIR) -Isrc -Isrc/disc_io -c $(VFS_DIR)/vfs_fs.c -o $(BUILD_DIR)/embuild/vfs_fs.o
	$(EMCXX) -std=c++20 -O2 -pthread -I. -I$(VFS_DIR) -Isrc -Isrc/disc_io -c src/disc_io/vfs_blob_reader.cpp -o $(BUILD_DIR)/embuild/vfs_blob_reader.o
	$(EMCXX) -std=c++20 -O2 -pthread -I. -I$(VFS_DIR) -Isrc -Isrc/disc_io -c src/disc_io/disc_header.cpp -o $(BUILD_DIR)/embuild/disc_header.o
	$(EMCXX) -O2 -pthread \
	  -sIMPORTED_MEMORY=1 -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=4294967296 -sALLOW_MEMORY_GROWTH=1 \
	  -sWASM_BIGINT \
	  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createVfsModule \
	  -sEXPORTED_FUNCTIONS='["_vfs_init_arena","_vfs_attach_arena","_vfs_read_sync","_vfs_hint_cold","_vfs_save_write_sync","_vfs_save_read_sync","_vfs_fs_mount","_vfs_fs_unmount","_vfs_fs_stat","_vfs_fs_open","_vfs_fs_read","_vfs_fs_pread","_vfs_fs_seek","_vfs_fs_tell","_vfs_fs_close","_vfs_fs_hint_cold","_vfs_blob_open","_vfs_blob_read","_vfs_blob_size","_vfs_blob_block_size","_vfs_blob_hint_cold","_vfs_blob_close","_vfs_blob_identify","_vfs_client_ctx_size","_vfs_fs_struct_size","_aligned_alloc","_malloc","_free"]' \
	  $(BUILD_DIR)/embuild/*.o \
	  -o web/vfs.js

clean:
	rm -rf $(BUILD_DIR) libdolphin_vfs.a disc_io_test src/disc_io/*.o *.o

.PHONY: all clean test wasm
