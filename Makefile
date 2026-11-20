CC ?= gcc
CXX ?= g++
EMCC ?= emcc

VFS_DIR = externals/vfs-streamer/client/vfs
CFLAGS = -std=c11 -O2 -Wall -Wextra -pthread -I. -Iexternals/vfs-streamer -I$(VFS_DIR)
CXXFLAGS = -std=c++20 -O2 -Wall -Wextra -pthread -I. -Iexternals/vfs-streamer -I$(VFS_DIR)

all: libdolphin_vfs.a

libdolphin_vfs.a: src/disc_io/vfs_blob_reader.o $(VFS_DIR)/vfs_client.o $(VFS_DIR)/vfs_fs.o $(VFS_DIR)/vfs_hal.o $(VFS_DIR)/vfs_policy.o
	ar rcs $@ $^

src/disc_io/vfs_blob_reader.o: src/disc_io/vfs_blob_reader.cpp
	$(CXX) $(CXXFLAGS) -c $< -o $@

$(VFS_DIR)/%.o: $(VFS_DIR)/%.c
	$(CC) $(CFLAGS) -c $< -o $@

clean:
	rm -f src/disc_io/*.o libdolphin_vfs.a

.PHONY: all clean
