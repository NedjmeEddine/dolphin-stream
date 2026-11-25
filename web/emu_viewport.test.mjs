import test from 'node:test';
import assert from 'node:assert/strict';
import { startStaticServer, launchBrowser } from './test_helper.mjs';

test('4.1: Emulator Viewport, Aspect Ratio Toggle, & Live HUD Overlay', async () => {
    const { server, url } = await startStaticServer();
    const browser = await launchBrowser();

    try {
        const page = await browser.newPage();
        await page.setViewportSize({ width: 1024, height: 768 });
        await page.goto(url);

        const viewport = await page.$('#viewport-wrapper');
        assert.ok(viewport, '#viewport-wrapper must exist');
        assert.equal(await viewport.isVisible(), false, 'Viewport must initially be hidden');

        await (await page.$('#disc-channel')).click();
        const startBtn = await page.waitForSelector('#btn-start-game', { state: 'visible' });
        await startBtn.click();

        await page.waitForSelector('#viewport-wrapper', { state: 'visible' });
        assert.equal(await viewport.isVisible(), true, 'Viewport must be visible after launching game');

        const emuCanvas = await page.$('#emulator-canvas');
        const hudCanvas = await page.$('#hud-canvas');
        assert.ok(emuCanvas && hudCanvas, 'Canvases must exist');

        const aspectBtn = await page.waitForSelector('#btn-aspect-ratio');
        assert.equal((await aspectBtn.textContent()).trim(), '4:3', 'Initial aspect ratio must be 4:3');

        const initialDims = await emuCanvas.evaluate((el) => ({
            width: parseFloat(el.style.width),
            height: parseFloat(el.style.height)
        }));
        assert.ok(Math.abs((initialDims.width / initialDims.height) - (4 / 3)) < 0.05, '4:3 ratio mismatch');

        await aspectBtn.click();
        assert.equal((await aspectBtn.textContent()).trim(), '16:9', 'Toggled aspect ratio must be 16:9');

        const wideDims = await emuCanvas.evaluate((el) => ({
            width: parseFloat(el.style.width),
            height: parseFloat(el.style.height)
        }));
        assert.ok(Math.abs((wideDims.width / wideDims.height) - (16 / 9)) < 0.05, '16:9 ratio mismatch');

        await aspectBtn.click();
        assert.equal((await aspectBtn.textContent()).trim(), '4:3', 'Restored aspect ratio must be 4:3');

        const hudBtn = await page.$('#btn-toggle-hud');
        assert.ok(hudBtn, '#btn-toggle-hud must exist');
        await hudBtn.click();
        await hudBtn.click();

        await (await page.$('#btn-return-menu')).click();
        await page.waitForSelector('#viewport-wrapper', { state: 'hidden' });
        assert.equal(await viewport.isVisible(), false, 'Viewport must be hidden after returning to Wii Menu');
    } finally {
        await browser.close();
        server.close();
    }
});
