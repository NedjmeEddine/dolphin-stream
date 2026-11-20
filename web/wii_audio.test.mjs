import test from 'node:test';
import assert from 'node:assert/strict';
import { createWiiSoundEngine } from './wii_audio.js';

test('2.2: Wii Web Audio Sound Engine', async (t) => {
    // Mock AudioContext for headless Node environment
    class MockGainNode {
        constructor() {
            this.gain = {
                value: 1,
                setValueAtTime: (val, time) => { this.gain.value = val; },
                exponentialRampToValueAtTime: (val, time) => { this.gain.value = val; },
                linearRampToValueAtTime: (val, time) => { this.gain.value = val; }
            };
        }
        connect(target) {}
    }

    class MockOscillatorNode {
        constructor() {
            this.type = 'sine';
            this.frequency = {
                value: 440,
                setValueAtTime: (val, time) => { this.frequency.value = val; },
                exponentialRampToValueAtTime: (val, time) => { this.frequency.value = val; }
            };
            this.started = false;
            this.stopped = false;
        }
        connect(target) {}
        start(time) { this.started = true; }
        stop(time) { this.stopped = true; }
    }

    class MockAudioContext {
        constructor() {
            this.currentTime = 0;
            this.state = 'running';
            this.destination = {};
            this.oscillators = [];
            this.gainNodes = [];
        }
        createGain() {
            const g = new MockGainNode();
            this.gainNodes.push(g);
            return g;
        }
        createOscillator() {
            const osc = new MockOscillatorNode();
            this.oscillators.push(osc);
            return osc;
        }
        resume() {
            this.state = 'running';
            return Promise.resolve();
        }
    }

    const mockCtx = new MockAudioContext();
    const soundEngine = createWiiSoundEngine({ audioContext: mockCtx });

    // Test hover sound
    soundEngine.playHover();
    assert.ok(mockCtx.oscillators.length >= 1, 'playHover must create at least one oscillator');
    assert.ok(mockCtx.oscillators[mockCtx.oscillators.length - 1].started, 'Oscillator must start');

    // Test select chime
    const prevOscCount = mockCtx.oscillators.length;
    soundEngine.playSelect();
    assert.ok(mockCtx.oscillators.length > prevOscCount, 'playSelect must generate harmonic chime oscillators');

    // Test cancel sound
    soundEngine.playCancel();
    assert.ok(mockCtx.oscillators.length > prevOscCount + 1, 'playCancel must trigger sound');

    // Test mute toggle
    soundEngine.setMuted(true);
    assert.equal(soundEngine.isMuted(), true, 'Engine must report muted');
    const oscCountBeforeMute = mockCtx.oscillators.length;
    soundEngine.playHover();
    assert.equal(mockCtx.oscillators.length, oscCountBeforeMute, 'No oscillators created when muted');

    soundEngine.setMuted(false);
    assert.equal(soundEngine.isMuted(), false, 'Engine must report unmuted');
});
