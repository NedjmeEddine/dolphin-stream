import test from 'node:test';
import assert from 'node:assert/strict';
import { createGamepadNavigation } from './wii_input.js';

test('2.3: Gamepad API Navigation Loop for Wii Grid', async (t) => {
    let focusedIndex = 0;
    let clickedIndex = -1;
    let canceled = false;

    const mockElements = Array.from({ length: 12 }, (_, i) => ({
        index: i,
        focus: () => { focusedIndex = i; },
        click: () => { clickedIndex = i; }
    }));

    // Mock gamepad object
    const mockGamepad = {
        axes: [0, 0], // x, y
        buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }))
    };

    let activeElements = mockElements;
    let simulatedGamepads = [mockGamepad];
    const nav = createGamepadNavigation({
        getElements: () => activeElements,
        getGamepads: () => simulatedGamepads,
        cols: 4,
        rows: 3,
        onCancel: () => { canceled = true; }
    });

    // Initial state
    assert.equal(focusedIndex, 0);

    // Step 1: Move right with D-Pad Right (button 15)
    mockGamepad.buttons[15].pressed = true;
    nav.poll(100);
    assert.equal(focusedIndex, 1, 'D-Pad Right should advance to index 1');

    // Debounce test: calling poll immediately without enough elapsed time should not move again
    nav.poll(150);
    assert.equal(focusedIndex, 1, 'Debounce should prevent rapid skipping');

    // Release button
    mockGamepad.buttons[15].pressed = false;

    // Step 2: Move Down with Left Stick Y (axis 1)
    mockGamepad.axes[1] = 0.8; // Down
    nav.poll(350);
    assert.equal(focusedIndex, 5, 'Moving down in 4-col grid should add 4 (1 + 4 = 5)');

    mockGamepad.axes[1] = 0.0; // Reset stick

    // Step 3: Press A button (button 0) to activate/click
    mockGamepad.buttons[0].pressed = true;
    nav.poll(550);
    assert.equal(clickedIndex, 5, 'A button should trigger click on focused slot (5)');

    mockGamepad.buttons[0].pressed = false;

    // Step 4: Press B button (button 1) to cancel
    mockGamepad.buttons[1].pressed = true;
    nav.poll(750);
    assert.equal(canceled, true, 'B button should trigger cancel/return');
    mockGamepad.buttons[1].pressed = false;

    // Step 5: Element list shrinks (e.g. entering a 2-button modal from slot 5)
    activeElements = mockElements.slice(0, 2); // Only 2 buttons in modal
    nav.setCurrentIndex(5); // Simulated state from slot 5
    // Poll should clamp index to 0 without out-of-bounds error
    nav.poll(950);
    assert.equal(nav.getCurrentIndex(), 0, 'Index >= total must clamp to 0');
});
