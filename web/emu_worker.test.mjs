import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const serverBin = path.join(rootDir, 'bin', 'streamer-server');

const CHROME_PATH = process.env.PLAYWRIGHT_CHROME_PATH ||
    path.join(process.env.HOME, '.cache/ms-playwright/chromium-1255/chrome-linux64/chrome');

test('6.0: Dolphin WebAssembly Emulation Core & Out-of-Core Stream Execution', async () => {
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

    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout starting server')), 8000);
        serverProc.stdout.on('data', (d) => {
            if (d.toString().includes('streamer-server listening')) {
                clearTimeout(timeout);
                resolve();
            }
        });
        serverProc.stderr.on('data', (d) => {
            if (d.toString().includes('listening')) {
                clearTimeout(timeout);
                resolve();
            }
        });
    });

    const browser = await chromium.launch({
        executablePath: fs.existsSync(CHROME_PATH) ? CHROME_PATH : undefined,
        headless: true,
        args: ['--enable-features=SharedArrayBuffer', '--no-sandbox']
    });

    try {
        const page = await browser.newPage();
        await page.goto(`http://${serverAddr}/`);

        const result = await page.evaluate(async () => {
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

                wA.postMessage({ type: 'PORT', port: channel.port1, gameId: 'zelda_tp' }, [channel.port1]);
                wB.postMessage({ type: 'PORT', port: channel.port2, gameId: 'zelda_tp' }, [channel.port2]);

                setTimeout(() => resolve({ timeout: true, booted, frame }), 15000);
            });
        });

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
