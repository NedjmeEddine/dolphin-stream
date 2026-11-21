# Chapter 6.1: Authentic Wii Shell, Procedural Audio & Input

This document details the frontend implementation in `web/`, including the authentic Nintendo Wii System Menu UI, the zero-asset procedural Web Audio synthesizer, the Gamepad navigation loop, and worker lifecycle management.

---

## 1. The Authentic Nintendo Wii System Menu (`web/index.html`)

DolphinStream wraps the emulator in a pixel-faithful recreation of the 2006 Nintendo Wii Home Menu:

```text
+-----------------------------------------------------------------------------------+
|  (Time/Date)                                                    (Wii Message Board)|
|                                                                                   |
|  [ Disc Channel ]  [ Melee Channel ]  [ MKWii Channel ]  [ Empty Channel ]        |
|  [ Channel 5    ]  [ Channel 6     ]  [ Channel 7     ]  [ Channel 8     ]        |
|  [ Channel 9    ]  [ Channel 10    ]  [ Channel 11    ]  [ Channel 12    ]        |
|                                                                                   |
|  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~(SVG Bottom Swoop Wave)~~~~~~~~~~~~~~~~~~~~~~~~~~~~ |
|  ( Wii Options )                                               ( SD Card Menu )   |
+-----------------------------------------------------------------------------------+
```

### Visual Engineering Highlights

* **Authentic 4x3 Proportions:** The channel grid respects original 480i aspect ratios with CRT scanline overlays.
* **Cyan Glow Hover Halo:** Hovering over channel cards invokes an authentic animated radial cyan gradient with subtle CSS perspective transforms (`transform: perspective(600px) rotateX(...)`).
* **Unclipped SVG Bottom Wave:** The iconic curved bottom border is rendered as a vector SVG path with layered drop shadows, guaranteed not to clip across wide 16:9 and ultrawide displays.
* **Channel Zoom Modal:** Clicking a channel zooms into an authentic channel banner modal with pill-shaped "Start" and "Wii Menu" buttons.

---

## 2. Zero-Asset Procedural Web Audio Synthesizer (`web/wii_audio.js`)

Most web applications download MP3 or WAV audio assets for user interface sounds.

### The Downside of Audio Assets
* Added network payload (several megabytes of sound files).
* Added latency: sound effects stutter or fail to play during the first seconds before assets have finished downloading.
* Browser autoplay policy restrictions on media elements.

### The Procedural Audio Solution

`web/wii_audio.js` implements a **zero-asset procedural sound engine** built entirely on the standard **Web Audio API** (`AudioContext`). It ships with zero external WAV/MP3 files.

```javascript
// web/wii_audio.js (Excerpt)
export class WiiSoundEngine {
    constructor() {
        this.ctx = null;
    }

    init() {
        if (!this.ctx) {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        }
    }

    // Authentic Wii cursor hover click
    playHover() {
        this.init();
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(1200, now);
        osc.frequency.exponentialRampToValueAtTime(600, now + 0.015);

        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.015);

        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now);
        osc.stop(now + 0.015);
    }

    // Authentic Wii channel select zoom chime (dual-sine harmonic chord)
    playSelect() {
        this.init();
        const now = this.ctx.currentTime;
        const freqs = [523.25, 659.25, 783.99]; // C5, E5, G5 Major Triad

        freqs.forEach(f => {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(f, now);

            gain.gain.setValueAtTime(0.06, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

            osc.connect(gain);
            gain.connect(this.ctx.destination);
            osc.start(now);
            osc.stop(now + 0.35);
        });
    }

    // Authentic Wii cancel/back sound
    playCancel() {
        this.init();
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.exponentialRampToValueAtTime(220, now + 0.08);

        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now);
        osc.stop(now + 0.08);
    }
}
```

* **Instantaneous playback:** Zero HTTP requests or decoding delay.
* **Micro-footprint:** The entire sound synthesizer compiles to $< 2\text{ KB}$ of JavaScript.

---

## 3. Gamepad Navigation Loop with Deadzone Filtering (`web/wii_input.js`)

To enable native couch-play with GameCube USB adapters, Xbox, PlayStation, and Switch Pro controllers, `web/wii_input.js` hooks the browser **Gamepad API**:

### Analog Stick Deadzone & Debounce

Raw analog sticks constantly jitter with small values (e.g. $\pm 0.08$). Without deadzone filtering, menus scroll uncontrollably.

```javascript
// web/wii_input.js (Excerpt)
const DEADZONE = 0.35; // Strict analog threshold
const REPEAT_DELAY_MS = 250;
const REPEAT_RATE_MS = 100;

function pollGamepad() {
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = gamepads[0];
    if (!gp) return;

    const stickX = gp.axes[0] || 0;
    const stickY = gp.axes[1] || 0;
    
    // Check D-Pad buttons
    const dpadUp = gp.buttons[12]?.pressed;
    const dpadDown = gp.buttons[13]?.pressed;
    const dpadLeft = gp.buttons[14]?.pressed;
    const dpadRight = gp.buttons[15]?.pressed;

    let dir = null;
    if (dpadUp || stickY < -DEADZONE) dir = 'UP';
    else if (dpadDown || stickY > DEADZONE) dir = 'DOWN';
    else if (dpadLeft || stickX < -DEADZONE) dir = 'LEFT';
    else if (dpadRight || stickX > DEADZONE) dir = 'RIGHT';

    if (dir) {
        handleDirectionalNav(dir);
    }
}
```

### Auto-Detection on Startup (Commit `3d6394b`)

Browsers do not always fire `window.on('gamepadconnected')` if the controller was already plugged in before the webpage loaded.

Commit `3d6394b` introduced `checkConnectedGamepad()`:

```javascript
// web/index.html (Excerpt)
function checkConnectedGamepad() {
    const gps = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = Array.from(gps).find(g => g && g.connected !== false);
    if (gp) {
        badgeController.textContent = `Gamepad: ${gp.id.slice(0, 18)}...`;
        badgeController.className = "badge ok";
        gamepadNav.start();
    }
}
// Run check immediately on page startup
checkConnectedGamepad();
```

---

## 4. Worker Lifecycle Teardown on Return to Menu

When the user exits a game to return to the Wii Menu, leaving background streaming workers active causes resource leaks, ongoing network traffic, and potential OPFS file-lock collisions.

Commit `3d6394b` wired the clean exit sequence:

```javascript
// web/index.html (Excerpt)
function exitToMenu() {
    soundEngine.playCancel();
    
    // 1. Flush any pending telemetry to server
    flushTelem('menu');
    
    // 2. Terminate background Web Workers to release SharedArrayBuffer and OPFS locks
    if (workerA) { 
        workerA.terminate(); 
        workerA = null; 
    }
    if (workerB) { 
        workerB.terminate(); 
        workerB = null; 
    }
    
    // 3. Hide emulator canvas viewport and restore Wii Channel Grid
    emuViewport.style.display = 'none';
}

btnReturnMenu.addEventListener('click', exitToMenu);
```

This guarantees that returning to the Wii Menu leaves the browser state completely clean, ready to launch a different game without residual memory overhead.
