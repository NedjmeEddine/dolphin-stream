import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(__dirname);

const CHROME_PATH = process.env.PLAYWRIGHT_CHROME_PATH ||
    path.join(process.env.HOME, '.cache/ms-playwright/chromium-1255/chrome-linux64/chrome');

test('2.1: 4x3 Wii Channel Grid Layout & DOM Structure', async (t) => {
    // 1. Start simple static server with COOP/COEP headers
    const server = http.createServer((req, res) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        res.setHeader('Access-Control-Allow-Origin', '*');

        let reqPath = req.url.split('?')[0];
        if (reqPath === '/') reqPath = '/index.html';
        const filePath = path.join(webDir, reqPath);

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

        // Verify Wii Home container exists
        const wiiHome = await page.$('#wii-home');
        assert.ok(wiiHome, '#wii-home container must exist');

        // Verify Channel Grid exists with exactly 12 channel slots (4 columns x 3 rows)
        const channelGrid = await page.$('#channel-grid');
        assert.ok(channelGrid, '#channel-grid must exist');

        const channels = await page.$$('#channel-grid .channel-slot');
        assert.equal(channels.length, 12, 'Must have exactly 12 channels in 4x3 grid');

        // Verify Disc Channel is present at slot 0
        const discChannel = await page.$('#disc-channel');
        assert.ok(discChannel, '#disc-channel must exist');
        const discTitle = await discChannel.$eval('.channel-title', el => el.textContent.trim());
        assert.ok(discTitle.includes('Disc Channel'), 'Disc channel must have Disc Channel title');

        // Verify each channel slot is keyboard focusable (tabindex="0")
        for (let i = 0; i < channels.length; i++) {
            const tabIndex = await channels[i].getAttribute('tabindex');
            assert.equal(tabIndex, '0', `Channel slot ${i} must have tabindex="0" for keyboard/gamepad navigation`);
        }

        // Verify Bottom Bar controls (Wii button, clock, and message board)
        const bottomBar = await page.$('#wii-bottom-bar');
        assert.ok(bottomBar, '#wii-bottom-bar must exist');

        const wiiBtn = await page.$('#btn-wii-options');
        assert.ok(wiiBtn, '#btn-wii-options button must exist');

        const clockEl = await page.$('#wii-clock');
        assert.ok(clockEl, '#wii-clock must exist');

        const msgBtn = await page.$('#btn-wii-messages');
        assert.ok(msgBtn, '#btn-wii-messages button must exist');

        // Verify emulator canvas viewport is initially hidden in catalog view
        const emuViewport = await page.$('#viewport-wrapper');
        const isEmuVisible = await emuViewport.isVisible();
        assert.equal(isEmuVisible, false, 'Emulator viewport must be initially hidden while browsing channels');

    } finally {
        await browser.close();
        server.close();
    }
});
