// wii_input.js — Gamepad navigation loop for Wii 4x3 channel grid

export function createGamepadNavigation(options = {}) {
    const getElements = options.getElements || (() => []);
    const getGamepads = options.getGamepads || (() => (typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : []));
    const cols = options.cols || 4;
    const rows = options.rows || 3;
    const debounceMs = options.debounceMs || 180;
    const deadzone = options.deadzone || 0.45;
    const onCancel = options.onCancel || (() => {});

    let currentIndex = 0;
    let lastMoveTime = 0;
    let prevA = false;
    let prevB = false;
    let running = false;
    let rafId = null;

    function getActiveGamepad() {
        const gps = getGamepads();
        if (!gps) return null;
        for (let i = 0; i < gps.length; i++) {
            if (gps[i] && gps[i].connected !== false) return gps[i];
        }
        return null;
    }

    function poll(now = (typeof performance !== 'undefined' ? performance.now() : Date.now())) {
        const gp = getActiveGamepad();
        const elements = getElements();
        if (!elements || elements.length === 0) return;

        if (!gp) return;

        const total = Math.min(elements.length, cols * rows);

        // Buttons: 0 = A, 1 = B, 12 = Up, 13 = Down, 14 = Left, 15 = Right
        const btn = (idx) => gp.buttons[idx] && (gp.buttons[idx].pressed || gp.buttons[idx].value > 0.5);
        const axisX = gp.axes && gp.axes[0] !== undefined ? gp.axes[0] : 0;
        const axisY = gp.axes && gp.axes[1] !== undefined ? gp.axes[1] : 0;

        let dx = 0;
        let dy = 0;

        // D-Pad or Left Stick navigation
        if (btn(15) || axisX > deadzone) dx = 1;
        else if (btn(14) || axisX < -deadzone) dx = -1;

        if (btn(13) || axisY > deadzone) dy = 1;
        else if (btn(12) || axisY < -deadzone) dy = -1;

        if ((dx !== 0 || dy !== 0) && (lastMoveTime === 0 || now - lastMoveTime >= debounceMs)) {
            let nextIndex = currentIndex;
            const curRow = Math.floor(currentIndex / cols);
            const curCol = currentIndex % cols;

            if (dx === 1 && curCol < cols - 1) nextIndex += 1;
            else if (dx === -1 && curCol > 0) nextIndex -= 1;

            if (dy === 1 && curRow < rows - 1) nextIndex += cols;
            else if (dy === -1 && curRow > 0) nextIndex -= cols;

            if (nextIndex >= 0 && nextIndex < total && nextIndex !== currentIndex) {
                currentIndex = nextIndex;
                lastMoveTime = now;
                if (elements[currentIndex] && typeof elements[currentIndex].focus === 'function') {
                    elements[currentIndex].focus();
                }
            }
        } else if (dx === 0 && dy === 0) {
            // Reset debounce when axes/D-pad return to neutral
            lastMoveTime = 0;
        }

        // Button A (Select / Click) — Edge triggered (press)
        const isAPressed = btn(0);
        if (isAPressed && !prevA) {
            if (elements[currentIndex] && typeof elements[currentIndex].click === 'function') {
                elements[currentIndex].click();
            }
        }
        prevA = isAPressed;

        // Button B (Cancel / Return) — Edge triggered (press)
        const isBPressed = btn(1);
        if (isBPressed && !prevB) {
            onCancel();
        }
        prevB = isBPressed;
    }

    function loop() {
        if (!running) return;
        poll();
        if (typeof requestAnimationFrame !== 'undefined') {
            rafId = requestAnimationFrame(loop);
        }
    }

    function start() {
        if (running) return;
        running = true;
        loop();
    }

    function stop() {
        running = false;
        if (rafId && typeof cancelAnimationFrame !== 'undefined') {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
    }

    return {
        poll,
        start,
        stop,
        getCurrentIndex: () => currentIndex,
        setCurrentIndex: (idx) => { currentIndex = idx; }
    };
}
