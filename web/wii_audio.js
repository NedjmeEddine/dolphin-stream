// wii_audio.js — Zero-asset procedural Web Audio synthesizer for Wii sound effects

export function createWiiSoundEngine(options = {}) {
    let ctx = options.audioContext || null;
    let muted = false;
    let masterVolume = 0.5;

    function getContext() {
        if (!ctx && typeof window !== 'undefined') {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (AudioCtx) {
                ctx = new AudioCtx();
            }
        }
        if (ctx && ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
        }
        return ctx;
    }

    // Soft cursor hover tick
    function playHover() {
        if (muted) return;
        const ac = getContext();
        if (!ac) return;

        const t = ac.currentTime;
        const osc = ac.createOscillator();
        const gain = ac.createGain();

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(1200, t);
        osc.frequency.exponentialRampToValueAtTime(450, t + 0.03);

        gain.gain.setValueAtTime(masterVolume * 0.15, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.035);

        osc.connect(gain);
        gain.connect(ac.destination);

        osc.start(t);
        osc.stop(t + 0.04);
        osc.onended = () => {
            try { gain.disconnect(); osc.disconnect(); } catch (_) {}
        };
    }

    // Ascending harmonic channel select chime (classic Wii chime)
    function playSelect() {
        if (muted) return;
        const ac = getContext();
        if (!ac) return;

        const t = ac.currentTime;
        const notes = [
            { freq: 659.25, time: 0.00, dur: 0.28 }, // E5
            { freq: 987.77, time: 0.07, dur: 0.32 }, // B5
            { freq: 1318.5, time: 0.14, dur: 0.45 }  // E6
        ];

        notes.forEach(({ freq, time, dur }) => {
            const osc = ac.createOscillator();
            const gain = ac.createGain();

            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, t + time);

            gain.gain.setValueAtTime(0.001, t + time);
            gain.gain.linearRampToValueAtTime(masterVolume * 0.35, t + time + 0.015);
            gain.gain.exponentialRampToValueAtTime(0.0001, t + time + dur);

            osc.connect(gain);
            gain.connect(ac.destination);

            osc.start(t + time);
            osc.stop(t + time + dur);
            osc.onended = () => {
                try { gain.disconnect(); osc.disconnect(); } catch (_) {}
            };
        });
    }

    // Downward cancel / back blip
    function playCancel() {
        if (muted) return;
        const ac = getContext();
        if (!ac) return;

        const t = ac.currentTime;
        const osc = ac.createOscillator();
        const gain = ac.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(480, t);
        osc.frequency.exponentialRampToValueAtTime(240, t + 0.09);

        gain.gain.setValueAtTime(masterVolume * 0.25, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);

        osc.connect(gain);
        gain.connect(ac.destination);

        osc.start(t);
        osc.stop(t + 0.1);
        osc.onended = () => {
            try { gain.disconnect(); osc.disconnect(); } catch (_) {}
        };
    }

    // Resonant shimmering disc chime
    function playDisc() {
        if (muted) return;
        const ac = getContext();
        if (!ac) return;

        const t = ac.currentTime;
        const freqs = [1046.5, 1567.98, 2093.0]; // C6, G6, C7
        freqs.forEach((f, idx) => {
            const osc = ac.createOscillator();
            const gain = ac.createGain();

            osc.type = 'sine';
            osc.frequency.setValueAtTime(f, t + idx * 0.04);

            gain.gain.setValueAtTime(0.001, t + idx * 0.04);
            gain.gain.linearRampToValueAtTime(masterVolume * 0.2, t + idx * 0.04 + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, t + idx * 0.04 + 0.35);

            osc.connect(gain);
            gain.connect(ac.destination);

            osc.start(t + idx * 0.04);
            osc.stop(t + idx * 0.04 + 0.36);
            osc.onended = () => {
                try { gain.disconnect(); osc.disconnect(); } catch (_) {}
            };
        });
    }

    return {
        playHover,
        playSelect,
        playCancel,
        playDisc,
        isMuted: () => muted,
        setMuted: (val) => { muted = Boolean(val); },
        setVolume: (val) => { masterVolume = Math.max(0, Math.min(1, Number(val) || 0.5)); }
    };
}
