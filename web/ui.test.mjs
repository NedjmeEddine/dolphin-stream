import test from 'node:test';
import assert from 'node:assert/strict';
import { startStaticServer, launchBrowser } from './test_helper.mjs';

test('2.1: 4x3 Wii Channel Grid Layout & DOM Structure', async () => {
    const { server, url } = await startStaticServer();
    const browser = await launchBrowser();

    try {
        const page = await browser.newPage();
        await page.goto(url);

        const wiiHome = await page.$('#wii-home');
        assert.ok(wiiHome, '#wii-home container must exist');

        const channelGrid = await page.$('#channel-grid');
        assert.ok(channelGrid, '#channel-grid must exist');

        const channels = await page.$$('#channel-grid .channel-slot');
        assert.equal(channels.length, 12, 'Must have exactly 12 channels in 4x3 grid');

        const discChannel = await page.$('#disc-channel');
        assert.ok(discChannel, '#disc-channel must exist');
        const discTitle = await discChannel.$eval('.channel-title', el => el.textContent.trim());
        assert.ok(discTitle.includes('Disc Channel'), 'Disc channel must have Disc Channel title');

        for (let i = 0; i < channels.length; i++) {
            const tabIndex = await channels[i].getAttribute('tabindex');
            assert.equal(tabIndex, '0', `Channel slot ${i} must have tabindex="0" for keyboard/gamepad navigation`);
        }

        assert.ok(await page.$('#wii-bottom-bar'), '#wii-bottom-bar must exist');
        assert.ok(await page.$('#btn-wii-options'), '#btn-wii-options button must exist');
        assert.ok(await page.$('#wii-clock'), '#wii-clock must exist');
        assert.ok(await page.$('#btn-wii-messages'), '#btn-wii-messages button must exist');

        const emuViewport = await page.$('#viewport-wrapper');
        assert.equal(await emuViewport.isVisible(), false, 'Emulator viewport must be initially hidden while browsing channels');

        await page.keyboard.press('ArrowRight');
        const activeId = await page.evaluate(() => document.activeElement?.id);
        assert.equal(activeId, 'disc-channel', 'Arrow key on un-focused landing must focus first channel (disc-channel)');

        await page.click('#channel-ssbm');
        const bannerModal = await page.$('#wii-banner-modal');
        assert.ok(bannerModal, '#wii-banner-modal must exist');
        assert.equal(await bannerModal.isVisible(), true, 'Clicking channel should display the Wii banner zoom modal');

        const bannerTitle = await page.$eval('#banner-title', el => el.textContent.trim());
        assert.equal(bannerTitle, 'Super Smash Bros. Melee', 'Banner modal must show selected game title');

        const startBtn = await page.$('#btn-start-game');
        const backBtn = await page.$('#btn-banner-back');
        assert.ok(startBtn && backBtn, 'Banner action buttons must exist');

        await backBtn.click();
        assert.equal(await bannerModal.isVisible(), false, 'Back button must close banner modal and return to grid');

        await page.click('#channel-ssbm');
        await startBtn.click();
        assert.equal(await emuViewport.isVisible(), true, 'Clicking Start button must enter emulator viewport');

        await page.click('#btn-return-menu');
        assert.equal(await emuViewport.isVisible(), false, 'Clicking Wii Menu button must return to channel grid');
    } finally {
        await browser.close();
        server.close();
    }
});
