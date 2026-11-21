import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const serverBin = path.join(rootDir, 'bin', 'streamer-server');

const CHROME_PATH = process.env.PLAYWRIGHT_CHROME_PATH ||
    path.join(process.env.HOME, '.cache/ms-playwright/chromium-1255/chrome-linux64/chrome');

test('5.0: Full Capstone Multi-Game End-to-End Streaming & Platform Identification', async (t) => {
    // 0. Ensure multi-game packs and dist/games.json exist
    const catalogPath = path.join(rootDir, 'dist', 'games.json');
    if (!fs.existsSync(catalogPath)) {
        execFileSync(process.execPath, [path.join(rootDir, 'scripts', 'gen_mock_games.mjs')], { stdio: 'inherit' });
    }

    // 1. Find a free port for streamer-server
    const srv = http.createServer();
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    await new Promise(r => srv.close(r));

    const serverAddr = `127.0.0.1:${port}`;
    const serverProc = spawn(serverBin, [
        '-data-dir', path.join(rootDir, 'dist'),
        '-web-dir', path.join(rootDir, 'web'),
        '-addr', serverAddr
    ], { stdio: 'pipe' });

    // Wait for server to start listening (with fast exit on premature crash)
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout waiting for streamer-server to start')), 8000);
        serverProc.on('exit', (code) => {
            clearTimeout(timeout);
            reject(new Error(`streamer-server exited prematurely with code ${code}`));
        });
        serverProc.stdout.on('data', (d) => {
            if (d.toString().includes('streamer-server listening')) {
                clearTimeout(timeout);
                resolve();
            }
        });
        serverProc.stderr.on('data', (d) => {
            const str = d.toString();
            if (str.includes('listening')) {
                clearTimeout(timeout);
                resolve();
            }
        });
    });

    const browser = await chromium.launch({
        executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
        headless: true,
        args: [
            '--enable-features=SharedArrayBuffer',
            '--no-sandbox',
            '--disable-setuid-sandbox'
        ]
    });

    try {
        const page = await browser.newPage();
        await page.setViewportSize({ width: 1200, height: 800 });
        await page.goto(`http://${serverAddr}/`);

        // Phase 1: Verify Multi-Game Catalog populated in Channel Grid
        await page.waitForFunction(() => {
            const slots = document.querySelectorAll('.channel-slot');
            const s1 = slots[1]?.querySelector('.channel-title')?.textContent?.trim();
            const s2 = slots[2]?.querySelector('.channel-title')?.textContent?.trim();
            return s1 === 'Super Smash Bros. Melee' && s2 === 'Mario Kart Wii';
        }, { timeout: 5000 });

        const channelSlots = await page.$$('.channel-slot');
        const title1 = await channelSlots[1].$eval('.channel-title', el => el.textContent.trim());
        const badge1 = await channelSlots[1].$eval('.game-badge', el => el.textContent.trim());
        assert.equal(title1, 'Super Smash Bros. Melee');
        assert.equal(badge1, 'GC');

        const title2 = await channelSlots[2].$eval('.channel-title', el => el.textContent.trim());
        const badge2 = await channelSlots[2].$eval('.game-badge', el => el.textContent.trim());
        assert.equal(title2, 'Mario Kart Wii');
        assert.equal(badge2, 'WII');

        // Phase 2: Launch Game 1 (Super Smash Bros. Melee - GameCube)
        await channelSlots[1].click();
        const startBtn = await page.waitForSelector('#btn-start-game', { state: 'visible' });
        await startBtn.click();

        await page.waitForSelector('#viewport-wrapper', { state: 'visible' });
        const gameLabel = await page.$eval('#emu-game-label', el => el.textContent.trim());
        assert.ok(gameLabel.includes('Super Smash Bros. Melee (GameCube)'), `Label mismatch: ${gameLabel}`);

        // Verify GameCube default aspect ratio is 4:3
        const aspectBtn = await page.$('#btn-aspect-ratio');
        assert.equal((await aspectBtn.textContent()).trim(), '4:3', 'GameCube titles must default to 4:3 aspect ratio');

        // Return to Wii Menu
        const returnBtn = await page.$('#btn-return-menu');
        await returnBtn.click();
        await page.waitForSelector('#viewport-wrapper', { state: 'hidden' });

        // Phase 3: Launch Game 2 (Mario Kart Wii - Wii)
        await channelSlots[2].click();
        const startBtn2 = await page.waitForSelector('#btn-start-game', { state: 'visible' });
        await startBtn2.click();

        await page.waitForSelector('#viewport-wrapper', { state: 'visible' });
        const gameLabel2 = await page.$eval('#emu-game-label', el => el.textContent.trim());
        assert.ok(gameLabel2.includes('Mario Kart Wii (Wii)'), `Label mismatch: ${gameLabel2}`);

        // Verify Wii default aspect ratio is 16:9
        assert.equal((await aspectBtn.textContent()).trim(), '16:9', 'Wii titles must default to 16:9 aspect ratio');

        // Final Return to Wii Menu
        await returnBtn.click();
        await page.waitForSelector('#viewport-wrapper', { state: 'hidden' });

    } finally {
        await browser.close();
        serverProc.kill('SIGTERM');
    }
});
