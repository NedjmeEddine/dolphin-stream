import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startStaticServer, launchBrowser, rootDir } from './test_helper.mjs';

test('3.3: Worker A Dolphin DiscIO Sector Reader & Boot Identifier', async () => {
    const ssbmPackDir = path.join(rootDir, 'dist', 'games', 'ssbm');
    if (!fs.existsSync(path.join(ssbmPackDir, 'manifest.bin'))) {
        execFileSync(process.execPath, [path.join(rootDir, 'scripts', 'gen_mock_games.mjs')], { stdio: 'inherit' });
    }

    const { server, url } = await startStaticServer({ packDir: ssbmPackDir });
    const browser = await launchBrowser();

    try {
        const page = await browser.newPage();
        await page.goto(url);

        const result = await page.evaluate(async () => {
            const channel = new MessageChannel();
            const workerA = new Worker('worker_a.js', { type: 'module' });
            const workerB = new Worker('worker_b.js', { type: 'module' });

            workerA.postMessage({ type: 'PORT', port: channel.port1 }, [channel.port1]);
            workerB.postMessage({ type: 'PORT', port: channel.port2 }, [channel.port2]);

            let nextMsgId = 1;
            function sendA(msg) {
                return new Promise((resolve, reject) => {
                    const id = nextMsgId++;
                    const onMsg = (e) => {
                        if (e.data && e.data.id === id) {
                            workerA.removeEventListener('message', onMsg);
                            resolve(e.data);
                        }
                    };
                    workerA.addEventListener('message', onMsg);
                    workerA.postMessage({ ...msg, id });
                    setTimeout(() => {
                        workerA.removeEventListener('message', onMsg);
                        reject(new Error(`Timeout waiting for Worker A response to ${msg.type}`));
                    }, 5000);
                });
            }

            await new Promise((resolve, reject) => {
                const onB = (e) => {
                    if (e.data && e.data.type === 'STATUS' && e.data.phase === 'running') {
                        workerB.removeEventListener('message', onB);
                        resolve();
                    }
                };
                workerB.addEventListener('message', onB);
                setTimeout(() => reject(new Error('Timeout waiting for Worker B running status')), 5000);
            });

            const openRes = await sendA({ type: 'DISC_OPEN', path: 'game.iso' });
            if (!openRes.ok) return { step: 'DISC_OPEN', res: openRes };

            const readRes = await sendA({ type: 'DISC_READ', offset: 0, len: 64 });
            if (!readRes.ok) return { step: 'DISC_READ', res: readRes };

            const identifyRes = await sendA({ type: 'DISC_IDENTIFY' });
            const closeRes = await sendA({ type: 'DISC_CLOSE' });
            if (!closeRes.ok) return { step: 'DISC_CLOSE', res: closeRes };

            workerA.terminate();
            workerB.terminate();

            return {
                ok: true,
                discSize: Number(openRes.size),
                blockSize: Number(openRes.blockSize),
                bytesRead: readRes.bytes.byteLength,
                identified: identifyRes
            };
        });

        assert.equal(result.ok, true, `DiscIO test failed: ${JSON.stringify(result)}`);
        assert.ok(result.discSize > 0, 'Disc size must be > 0');
        assert.ok(result.blockSize >= 65536, 'Block size must be >= 64 KB');
        assert.equal(result.bytesRead, 64, 'Must have read exactly 64 bytes');
        assert.equal(result.identified.ok, true, 'DISC_IDENTIFY must recognize GC/Wii boot magic');
        assert.equal(result.identified.platform, 'gamecube');
        assert.equal(result.identified.gameId, 'GALE01');
    } finally {
        await browser.close();
        server.close();
    }
});
