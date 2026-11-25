import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startStreamerServer, launchBrowser, rootDir } from './test_helper.mjs';

test('5.0: Full Capstone Multi-Game End-to-End Streaming & Platform Identification', async () => {
    const catalogPath = path.join(rootDir, 'dist', 'games.json');
    if (!fs.existsSync(catalogPath)) {
        execFileSync(process.execPath, [path.join(rootDir, 'scripts', 'gen_mock_games.mjs')], { stdio: 'inherit' });
    }

    const { proc: serverProc, url } = await startStreamerServer();
    const browser = await launchBrowser();

    try {
        const page = await browser.newPage();
        await page.setViewportSize({ width: 1200, height: 800 });
        await page.goto(url);

        // Phase 1: Verify Multi-Game Catalog populated in Channel Grid and unused slots cleared
        await page.waitForFunction(() => {
            const slots = document.querySelectorAll('.channel-slot');
            const s1 = slots[1]?.querySelector('.channel-title')?.textContent?.trim();
            const s2 = slots[2]?.querySelector('.channel-title')?.textContent?.trim();
            return s1 === 'Super Smash Bros. Melee' && s2 === 'Mario Kart Wii';
        }, { timeout: 5000 });

        const channelSlots = await page.$$('.channel-slot');
        assert.equal(await channelSlots[1].$eval('.channel-title', el => el.textContent.trim()), 'Super Smash Bros. Melee');
        assert.equal(await channelSlots[1].$eval('.game-badge', el => el.textContent.trim()), 'GC');
        assert.equal(await channelSlots[2].$eval('.channel-title', el => el.textContent.trim()), 'Mario Kart Wii');
        assert.equal(await channelSlots[2].$eval('.game-badge', el => el.textContent.trim()), 'WII');

        // Unused hardcoded slot (Super Mario Sunshine at slot 4) must be cleared when catalog has <= 3 games
        const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
        if (catalog.games.length <= 3) {
            const slot4GameId = await channelSlots[4].getAttribute('data-game-id');
            assert.equal(slot4GameId, null, 'Unused slot must not keep stale data-game-id');
        }

        // Phase 2: Launch Game 1 (Super Smash Bros. Melee - GameCube) and verify boot
        await channelSlots[1].click();
        await (await page.waitForSelector('#btn-start-game', { state: 'visible' })).click();

        await page.waitForSelector('#viewport-wrapper', { state: 'visible' });
        await page.waitForFunction(() => {
            const b = document.getElementById('badge-iso')?.textContent || '';
            return b.startsWith('Running');
        }, { timeout: 10000 });

        const gameLabel = await page.$eval('#emu-game-label', el => el.textContent.trim());
        assert.ok(gameLabel.includes('(GameCube)'), `Label mismatch: ${gameLabel}`);
        const aspectBtn = await page.$('#btn-aspect-ratio');
        assert.equal((await aspectBtn.textContent()).trim(), '4:3', 'GameCube titles must default to 4:3 aspect ratio');

        const returnBtn = await page.$('#btn-return-menu');
        await returnBtn.click();
        await page.waitForSelector('#viewport-wrapper', { state: 'hidden' });

        // Phase 3: Launch Game 2 (Mario Kart Wii - Wii) and verify boot
        await channelSlots[2].click();
        await (await page.waitForSelector('#btn-start-game', { state: 'visible' })).click();

        await page.waitForSelector('#viewport-wrapper', { state: 'visible' });
        await page.waitForFunction(() => {
            const b = document.getElementById('badge-iso')?.textContent || '';
            return b.startsWith('Running');
        }, { timeout: 10000 });

        const gameLabel2 = await page.$eval('#emu-game-label', el => el.textContent.trim());
        assert.ok(gameLabel2.includes('(Wii)'), `Label mismatch: ${gameLabel2}`);
        assert.equal((await aspectBtn.textContent()).trim(), '16:9', 'Wii titles must default to 16:9 aspect ratio');

        await returnBtn.click();
        await page.waitForSelector('#viewport-wrapper', { state: 'hidden' });
    } finally {
        await browser.close();
        serverProc.kill('SIGTERM');
    }
});
