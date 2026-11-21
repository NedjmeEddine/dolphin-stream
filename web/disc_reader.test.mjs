import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname);
const rootDir = path.resolve(__dirname, '..');

const CHROME_PATH = process.env.PLAYWRIGHT_CHROME_PATH ||
    path.join(process.env.HOME, '.cache/ms-playwright/chromium-1255/chrome-linux64/chrome');

test('3.3: Worker A Dolphin DiscIO Sector Reader & Boot Identifier', async (t) => {
    // 1. Static server with Cross-Origin Isolation headers for SharedArrayBuffer
    const server = http.createServer((req, res) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        res.setHeader('Access-Control-Allow-Origin', '*');

        let reqPath = req.url.split('?')[0];
        let filePath;
        if (reqPath === '/manifest.bin' || reqPath.startsWith('/packs/')) {
            filePath = path.join(rootDir, 'dist', path.basename(reqPath));
        } else {
            if (reqPath === '/') reqPath = '/index.html';
            filePath = path.join(webDir, reqPath);
        }

        if (!fs.existsSync(filePath)) {
            res.statusCode = 404;
            res.end('Not Found');
            return;
        }

        const ext = path.extname(filePath);
        const mimeTypes = {
            '.html': 'text/html',
            '.js': 'application/javascript',
            '.mjs': 'application/javascript',
            '.css': 'text/css',
            '.wasm': 'application/wasm'
        };
        res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');

        const rangeHeader = req.headers.range;
        if (rangeHeader) {
            const stat = fs.statSync(filePath);
            const matches = rangeHeader.match(/bytes=(\d+)-(\d+)/);
            if (matches) {
                const start = parseInt(matches[1], 10);
                const end = parseInt(matches[2], 10);
                res.statusCode = 206;
                res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
                res.setHeader('Content-Length', end - start + 1);
                fs.createReadStream(filePath, { start, end }).pipe(res);
                return;
            }
        }

        fs.createReadStream(filePath).pipe(res);
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/`;

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
        await page.goto(url);

        // Run DiscIO test inside browser context with Worker A & Worker B
        const result = await page.evaluate(async () => {
            const channel = new MessageChannel();
            const workerA = new Worker('worker_a.js', { type: 'module' });
            const workerB = new Worker('worker_b.js', { type: 'module' });

            workerA.postMessage({ type: 'PORT', port: channel.port1, gameId: 'ssbm' }, [channel.port1]);
            workerB.postMessage({ type: 'PORT', port: channel.port2, gameId: 'ssbm' }, [channel.port2]);

            // Helper to send message to Worker A and await response by id
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

            // Wait for Worker B to reach RUNNING status (which means arena is initialized)
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

            // 1. Open disc through Worker A DiscIO interface
            const openRes = await sendA({ type: 'DISC_OPEN', path: 'game.iso' });
            if (!openRes.ok) return { step: 'DISC_OPEN', res: openRes };

            // 2. Read sector 0 (first 64 bytes)
            const readRes = await sendA({ type: 'DISC_READ', offset: 0, len: 64 });
            if (!readRes.ok) return { step: 'DISC_READ', res: readRes };

            // 3. Identify disc platform & magic
            const identifyRes = await sendA({ type: 'DISC_IDENTIFY' });

            // 4. Close disc reader
            const closeRes = await sendA({ type: 'DISC_CLOSE' });
            if (!closeRes.ok) return { step: 'DISC_CLOSE', res: closeRes };

            // Terminate test workers
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

    } finally {
        await browser.close();
        server.close();
    }
});
