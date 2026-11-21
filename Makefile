CC ?= gcc
CXX ?= g++
EMCC ?= emcc

BUILD_DIR = build
VFS_DIR = externals/vfs-streamer/client/vfs
CFLAGS = -std=c11 -O2 -Wall -Wextra -pthread -I. -Iexternals/vfs-streamer -I$(VFS_DIR)
CXXFLAGS = -std=c++20 -O2 -Wall -Wextra -pthread -I. -Iexternals/vfs-streamer -I$(VFS_DIR)

VFS_OBJS = $(BUILD_DIR)/vfs_client.o $(BUILD_DIR)/vfs_fs.o $(BUILD_DIR)/vfs_hal.o $(BUILD_DIR)/vfs_policy.o
DISC_IO_OBJS = $(BUILD_DIR)/vfs_blob_reader.o

all: libdolphin_vfs.a disc_io_test

libdolphin_vfs.a: $(DISC_IO_OBJS) $(VFS_OBJS)
	ar rcs $@ $^

disc_io_test: src/disc_io/disc_io_test.cpp $(DISC_IO_OBJS) $(VFS_OBJS)
	$(CXX) $(CXXFLAGS) -DVFS_TESTING $^ -o $@

$(BUILD_DIR)/vfs_blob_reader.o: src/disc_io/vfs_blob_reader.cpp | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) -c $< -o $@

$(BUILD_DIR)/%.o: $(VFS_DIR)/%.c | $(BUILD_DIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

test: disc_io_test
	./disc_io_test

clean:
	rm -rf $(BUILD_DIR) libdolphin_vfs.a disc_io_test src/disc_io/*.o *.o

.PHONY: all clean test
