import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const binMarkovPack = path.join(rootDir, 'bin', 'markov-pack');
const distDir = path.join(rootDir, 'dist');
const tmpDir = path.join(rootDir, '.tmp_isos');

fs.mkdirSync(distDir, { recursive: true });
fs.mkdirSync(tmpDir, { recursive: true });

function createMockIso(filePath, gameId, magicU32, title, sizeBytes = 1048576) {
    const buf = Buffer.alloc(sizeBytes, 0);
    // 0x00..0x05: Game ID (6 bytes)
    buf.write(gameId, 0, 6, 'ascii');
    // 0x18..0x1B: Magic (4 bytes Big-Endian)
    buf.writeUInt32BE(magicU32, 0x18);
    // 0x20..0x5F: Title (up to 64 bytes)
    buf.write(title, 0x20, Math.min(title.length, 64), 'ascii');

    // Fill some pattern in remaining sectors
    for (let i = 0x100; i < sizeBytes; i += 256) {
        buf.write(`[DATA_${gameId}_${i}]`, i, 'ascii');
    }

    fs.writeFileSync(filePath, buf);
    return filePath;
}

// 1. Create SSBM (GameCube: 0xC2339F3D, GALE01)
const ssbmIso = path.join(tmpDir, 'ssbm.iso');
createMockIso(ssbmIso, 'GALE01', 0xC2339F3D, 'Super Smash Bros. Melee', 1048576);

// 2. Create MKWii (Wii: 0x5D1C9EA3, RMCE01)
const mkwiiIso = path.join(tmpDir, 'mkwii.iso');
createMockIso(mkwiiIso, 'RMCE01', 0x5D1C9EA3, 'Mario Kart Wii', 1048576);

// 3. Slice SSBM into dist/games/ssbm
const ssbmOut = path.join(distDir, 'games', 'ssbm');
fs.mkdirSync(ssbmOut, { recursive: true });
execFileSync(binMarkovPack, [
    '-in', ssbmIso,
    '-out-dir', ssbmOut,
    '-block-shift', '18',
    '-pack-shift', '0',
    '-pool-mb', '64',
    '-top-k', '4'
]);

// 4. Slice MKWii into dist/games/mkwii
const mkwiiOut = path.join(distDir, 'games', 'mkwii');
fs.mkdirSync(mkwiiOut, { recursive: true });
execFileSync(binMarkovPack, [
    '-in', mkwiiIso,
    '-out-dir', mkwiiOut,
    '-block-shift', '18',
    '-pack-shift', '0',
    '-pool-mb', '64',
    '-top-k', '4'
]);

// 5. Generate dist/games.json
const catalog = {
    version: 1,
    games: [
        {
            id: 'ssbm',
            title: 'Super Smash Bros. Melee',
            platform: 'gamecube',
            discSize: 1048576,
            blockShift: 18,
            poolMb: 64
        },
        {
            id: 'mkwii',
            title: 'Mario Kart Wii',
            platform: 'wii',
            discSize: 1048576,
            blockShift: 18,
            poolMb: 64
        }
    ]
};

fs.writeFileSync(path.join(distDir, 'games.json'), JSON.stringify(catalog, null, 2));

// Clean up temporary ISOs
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('Successfully generated multi-game packs in dist/games/ and dist/games.json');
