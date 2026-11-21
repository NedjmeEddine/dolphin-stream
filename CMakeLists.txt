cmake_minimum_required(VERSION 3.20)
project(dolphin_stream C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

# Submodule paths
set(VFS_STREAMER_DIR ${CMAKE_CURRENT_SOURCE_DIR}/externals/vfs-streamer)
set(VFS_CORE_DIR ${VFS_STREAMER_DIR}/client/vfs)

include_directories(
    ${CMAKE_CURRENT_SOURCE_DIR}/src
    ${CMAKE_CURRENT_SOURCE_DIR}/src/disc_io
    ${VFS_STREAMER_DIR}
    ${VFS_CORE_DIR}
)

# Core VFS Sources
set(VFS_SOURCES
    ${VFS_CORE_DIR}/vfs_client.c
    ${VFS_CORE_DIR}/vfs_fs.c
    ${VFS_CORE_DIR}/vfs_hal.c
    ${VFS_CORE_DIR}/vfs_policy.c
)

# Dolphin DiscIO Adapter Sources
set(DISC_IO_SOURCES
    src/disc_io/vfs_blob_reader.cpp
)

# Emscripten flags for multi-threaded out-of-core WebAssembly
if(EMSCRIPTEN)
    add_compile_options(
        -pthread
        -O2
        -Wno-deprecated
    )

    set(VFS_EXPORTED_FUNCTIONS "[\"_vfs_init_arena\",\"_vfs_attach_arena\",\"_vfs_read_sync\",\"_vfs_hint_cold\",\"_vfs_save_write_sync\",\"_vfs_save_read_sync\",\"_vfs_fs_mount\",\"_vfs_fs_unmount\",\"_vfs_fs_stat\",\"_vfs_fs_open\",\"_vfs_fs_read\",\"_vfs_fs_pread\",\"_vfs_fs_seek\",\"_vfs_fs_tell\",\"_vfs_fs_close\",\"_vfs_fs_hint_cold\",\"_vfs_blob_open\",\"_vfs_blob_read\",\"_vfs_blob_size\",\"_vfs_blob_block_size\",\"_vfs_blob_hint_cold\",\"_vfs_blob_close\",\"_aligned_alloc\",\"_malloc\",\"_free\"]")

    add_link_options(
        -pthread
        -sIMPORTED_MEMORY=1
        -sINITIAL_MEMORY=67108864
        -sMAXIMUM_MEMORY=4294967296
        -sALLOW_MEMORY_GROWTH=1
        -sWASM_BIGINT
        -sMODULARIZE=1
        -sEXPORT_ES6=1
        -sEXPORT_NAME=createDolphinVfsModule
        -sEXPORTED_FUNCTIONS=${VFS_EXPORTED_FUNCTIONS}
    )

    add_executable(dolphin_vfs_module
        ${VFS_SOURCES}
        ${DISC_IO_SOURCES}
    )
    set_target_properties(dolphin_vfs_module PROPERTIES OUTPUT_NAME "vfs" SUFFIX ".js")
endif()

add_library(dolphin_vfs_disc_io STATIC
    ${VFS_SOURCES}
    ${DISC_IO_SOURCES}
)

# Standalone test executable to verify DiscIO reads
add_executable(disc_io_test
    src/disc_io/disc_io_test.cpp
    src/disc_io/vfs_blob_reader.cpp
    ${VFS_SOURCES}
)
target_compile_definitions(disc_io_test PRIVATE VFS_TESTING)
