import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startStreamerServer, launchBrowser, rootDir } from './test_helper.mjs';

test('6.0: Dolphin WebAssembly Emulation Core & Out-of-Core Stream Execution', async () => {
    const catalogPath = path.join(rootDir, 'dist', 'games.json');
    if (!fs.existsSync(catalogPath)) {
        execFileSync(process.execPath, [path.join(rootDir, 'scripts', 'gen_mock_games.mjs')], { stdio: 'inherit' });
    }
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    const zelda = catalog.games.find(g => g.id === 'zelda_tp');
    const targetGame = zelda || catalog.games[0];
    assert.ok(targetGame, 'Catalog must contain at least one game');

    const { proc: serverProc, url } = await startStreamerServer();
    const browser = await launchBrowser();

    try {
        const page = await browser.newPage();
        await page.goto(url);

        const result = await page.evaluate(async (game) => {
            return await new Promise((resolve) => {
                const channel = new MessageChannel();
                const wA = new Worker('emu_worker.js', { type: 'module' });
                const wB = new Worker('worker_b.js', { type: 'module' });

                let booted = null;
                let frame = null;

                wA.onmessage = (e) => {
                    if (e.data.type === 'EMU_BOOTED') {
                        booted = e.data;
                    } else if (e.data.type === 'EMU_FRAME' && !frame) {
                        frame = { width: e.data.width, height: e.data.height, bytes: e.data.buffer.byteLength };
                        wA.postMessage({ type: 'STOP' });
                    } else if (e.data.type === 'STOPPED') {
                        wA.terminate();
                        wB.terminate();
                        resolve({ booted, frame, stopped: true });
                    }
                };

                wA.postMessage({ type: 'PORT', port: channel.port1, gameId: game.id, platform: game.platform }, [channel.port1]);
                wB.postMessage({ type: 'PORT', port: channel.port2, gameId: game.id }, [channel.port2]);

                setTimeout(() => resolve({ timeout: true, booted, frame }), 15000);
            });
        }, targetGame);

        assert.equal(result.timeout, undefined, 'Worker must not timeout');
        assert.ok(result.booted?.ok, 'Dolphin core must report successful boot');
        assert.ok(result.frame?.width > 0 && result.frame?.height > 0, 'Frame dimensions must be positive');
        assert.ok(result.frame?.bytes > 0, 'Frame buffer must contain pixel bytes');
        assert.equal(result.stopped, true, 'Emulator must stop cleanly');
    } finally {
        await browser.close();
        serverProc.kill('SIGTERM');
    }
});
