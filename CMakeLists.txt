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
    )
endif()

add_library(dolphin_vfs_disc_io STATIC
    ${VFS_SOURCES}
    ${DISC_IO_SOURCES}
)

# Standalone test executable to verify DiscIO reads
add_executable(disc_io_test
    src/disc_io/vfs_blob_reader.cpp
    ${VFS_SOURCES}
)
target_compile_definitions(disc_io_test PRIVATE VFS_TESTING)
