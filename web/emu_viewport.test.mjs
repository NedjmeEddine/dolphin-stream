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

test('4.1: Emulator Viewport, Aspect Ratio Toggle, & Live HUD Overlay', async (t) => {
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
        await page.setViewportSize({ width: 1024, height: 768 });
        await page.goto(url);

        // 1. Initial State: Viewport hidden
        const viewport = await page.$('#viewport-wrapper');
        assert.ok(viewport, '#viewport-wrapper must exist');
        assert.equal(await viewport.isVisible(), false, 'Viewport must initially be hidden');

        // 2. Click a channel to open zoom banner, then Start
        const discChannel = await page.$('#disc-channel');
        await discChannel.click();
        const startBtn = await page.waitForSelector('#btn-start-game', { state: 'visible' });
        await startBtn.click();

        // 3. Viewport is now displayed
        await page.waitForSelector('#viewport-wrapper', { state: 'visible' });
        assert.equal(await viewport.isVisible(), true, 'Viewport must be visible after launching game');

        // 4. Emulator and HUD canvases exist and have dimensions
        const emuCanvas = await page.$('#emulator-canvas');
        const hudCanvas = await page.$('#hud-canvas');
        assert.ok(emuCanvas, '#emulator-canvas must exist');
        assert.ok(hudCanvas, '#hud-canvas must exist');

        // 5. Aspect Ratio Button verification
        const aspectBtn = await page.waitForSelector('#btn-aspect-ratio');
        assert.ok(aspectBtn, '#btn-aspect-ratio must exist');
        const initialAspectText = await aspectBtn.textContent();
        assert.equal(initialAspectText.trim(), '4:3', 'Initial aspect ratio must be 4:3');

        // Check 4:3 dimensions
        const initialDims = await emuCanvas.evaluate((el) => {
            return { width: parseFloat(el.style.width), height: parseFloat(el.style.height) };
        });
        const ratio43 = initialDims.width / initialDims.height;
        assert.ok(Math.abs(ratio43 - (4 / 3)) < 0.05, `4:3 ratio mismatch: got ${ratio43}`);

        // 6. Toggle to 16:9
        await aspectBtn.click();
        const toggledAspectText = await aspectBtn.textContent();
        assert.equal(toggledAspectText.trim(), '16:9', 'Toggled aspect ratio must be 16:9');

        const wideDims = await emuCanvas.evaluate((el) => {
            return { width: parseFloat(el.style.width), height: parseFloat(el.style.height) };
        });
        const ratio169 = wideDims.width / wideDims.height;
        assert.ok(Math.abs(ratio169 - (16 / 9)) < 0.05, `16:9 ratio mismatch: got ${ratio169}`);

        // 7. Toggle back to 4:3
        await aspectBtn.click();
        const restoredAspectText = await aspectBtn.textContent();
        assert.equal(restoredAspectText.trim(), '4:3', 'Restored aspect ratio must be 4:3');

        // 8. HUD Toggle button
        const hudBtn = await page.$('#btn-toggle-hud');
        assert.ok(hudBtn, '#btn-toggle-hud must exist');
        await hudBtn.click(); // hide
        await hudBtn.click(); // restore

        // 9. Return to Wii Menu
        const returnBtn = await page.$('#btn-return-menu');
        await returnBtn.click();
        await page.waitForSelector('#viewport-wrapper', { state: 'hidden' });
        assert.equal(await viewport.isVisible(), false, 'Viewport must be hidden after returning to Wii Menu');

    } finally {
        await browser.close();
        server.close();
    }
});
