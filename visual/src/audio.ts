import { Kind, rng, Rng } from "./rules";

// Every sound is synthesized in code, sample by sample, when audio is unlocked: nothing is loaded.
// A gunshot = supersonic crack + muzzle blast (saturated low-passed noise) + sub thump + action clack,
// played dry and through an outdoor reverb (early wall reflections + long diffuse tail).

interface ShotVoice {
    crackT: number;   // crack decay (s)
    bodyHz: number;   // blast low-pass cutoff
    bodyT: number;    // blast decay (s)
    thump: number;    // sub thump base frequency
    thumpT: number;
    sub: number;      // thump level
    drive: number;    // saturation
    mech: number;     // action clack delay (s), 0 = none
    mechGain: number;
    len: number;      // buffer length (s)
    gain: number;
    verb: number;     // reverb send
}

const VOICES: Record<Kind | "bot", ShotVoice> = {
    pistol: { crackT: 0.003, bodyHz: 1700, bodyT: 0.035, thump: 130, thumpT: 0.05, sub: 0.6, drive: 2.6, mech: 0.028, mechGain: 0.25, len: 0.22, gain: 0.8, verb: 0.35 },
    smg: { crackT: 0.0025, bodyHz: 1900, bodyT: 0.03, thump: 140, thumpT: 0.04, sub: 0.5, drive: 2.4, mech: 0.022, mechGain: 0.3, len: 0.18, gain: 0.72, verb: 0.3 },
    assault: { crackT: 0.004, bodyHz: 1300, bodyT: 0.05, thump: 105, thumpT: 0.06, sub: 0.8, drive: 3.2, mech: 0.03, mechGain: 0.22, len: 0.26, gain: 0.9, verb: 0.45 },
    marksman: { crackT: 0.005, bodyHz: 1100, bodyT: 0.07, thump: 88, thumpT: 0.08, sub: 0.95, drive: 3.6, mech: 0.035, mechGain: 0.2, len: 0.32, gain: 1, verb: 0.6 },
    sniper: { crackT: 0.006, bodyHz: 900, bodyT: 0.11, thump: 62, thumpT: 0.12, sub: 1.2, drive: 4.2, mech: 0, mechGain: 0, len: 0.45, gain: 1.1, verb: 0.85 },
    shotgun: { crackT: 0.005, bodyHz: 800, bodyT: 0.09, thump: 70, thumpT: 0.1, sub: 1.15, drive: 3.8, mech: 0, mechGain: 0, len: 0.4, gain: 1.05, verb: 0.65 },
    bot: { crackT: 0.004, bodyHz: 1300, bodyT: 0.05, thump: 105, thumpT: 0.06, sub: 0.8, drive: 3.2, mech: 0.03, mechGain: 0.15, len: 0.26, gain: 0.9, verb: 0.5 },
};
const VARIANTS = 3;
const TAU = Math.PI * 2;

/** One gunshot as raw samples. */
function synthShot(sr: number, v: ShotVoice, r: Rng): Float32Array<ArrayBuffer> {
    const n = Math.floor(sr * v.len), d = new Float32Array(n);
    const a = 1 - Math.exp(-TAU * v.bodyHz / sr), norm = Math.tanh(v.drive);
    let lp1 = 0, lp2 = 0, prev = 0, ph = 0, peak = 0;
    for (let i = 0; i < n; i++) {
        const t = i / sr, w = r() * 2 - 1;
        const crack = (w - prev) * (t < 0.0005 ? t / 0.0005 : Math.exp(-(t - 0.0005) / v.crackT));
        prev = w;
        lp1 += a * (w - lp1);
        lp2 += a * (lp1 - lp2);
        const body = lp2 * 3.2 * (t < 0.0015 ? t / 0.0015 : Math.exp(-(t - 0.0015) / v.bodyT));
        ph += TAU * v.thump * (1 + 2.5 * Math.exp(-t / 0.008)) / sr;
        const thump = Math.sin(ph) * Math.exp(-t / v.thumpT) * v.sub;
        let x = Math.tanh((crack + body + thump) * v.drive) / norm;
        if (v.mech && t >= v.mech) {
            const u = t - v.mech;
            x += (Math.sin(TAU * 3100 * u) * 0.5 + Math.sin(TAU * 4700 * u) * 0.3 + w * 0.5) * Math.exp(-u / 0.005) * v.mechGain;
        }
        // Fade the last 10 ms to avoid a click.
        d[i] = x * Math.min(1, (n - i) / (sr * 0.01));
        peak = Math.max(peak, Math.abs(d[i]));
    }
    for (let i = 0; i < n; i++) d[i] *= 0.9 / peak;
    return d;
}

/** Metallic impact: noise burst plus inharmonic decaying partials (clicks, mags, bolts, casings). */
function synthMetal(sr: number, r: Rng, freqs: number[], decay: number, noise: number, len: number): Float32Array<ArrayBuffer> {
    const n = Math.floor(sr * len), d = new Float32Array(n);
    const ph = freqs.map(() => r() * TAU);
    for (let i = 0; i < n; i++) {
        const t = i / sr;
        let x = (r() * 2 - 1) * noise * Math.exp(-t / 0.002);
        for (let k = 0; k < freqs.length; k++) x += Math.sin(ph[k] + TAU * freqs[k] * t) * Math.exp(-t / (decay / (1 + k * 0.4))) / (1 + k * 0.6);
        d[i] = x * 0.5 * Math.min(1, t / 0.0003);
    }
    return d;
}

/** Outdoor impulse response: a few wall reflections, then a diffuse tail that loses its highs over time. */
function synthIR(sr: number, r: Rng): Float32Array<ArrayBuffer>[] {
    const n = Math.floor(sr * 2.2), out: Float32Array<ArrayBuffer>[] = [];
    const taps = [[0.045, 0.5], [0.085, 0.38], [0.14, 0.3], [0.2, 0.22], [0.29, 0.16], [0.41, 0.1]];
    for (let ch = 0; ch < 2; ch++) {
        const d = new Float32Array(n);
        let lp = 0;
        for (let i = 0; i < n; i++) {
            const t = i / sr;
            lp += (0.55 * Math.exp(-t / 0.45) + 0.04) * ((r() * 2 - 1) - lp);
            d[i] = lp * 0.35 * Math.exp(-t / 0.55) * Math.min(1, t / 0.02);
        }
        for (const [at, g] of taps) {
            const s = Math.floor((at + (ch ? 0.011 : 0) * (1 + r())) * sr);
            for (let j = 0; j < 60 && s + j < n; j++) d[s + j] += (r() * 2 - 1) * g * Math.exp(-j / 15);
        }
        out.push(d);
    }
    return out;
}

/** Procedural WebAudio effects. */
export class Sfx {
    private ctx: AudioContext | null = null;
    private master: GainNode;
    private verb: ConvolverNode;
    private noise: AudioBuffer;
    private shots = new Map<Kind | "bot", AudioBuffer[]>();
    private bank: Record<"click" | "magOut" | "magIn" | "bolt" | "shell" | "dry", AudioBuffer>;
    private casings: AudioBuffer[] = [];
    private r = rng(7);
    private volume = 0.7;

    /** Must run inside a user gesture (autoplay policy). Synthesizes every buffer once (~50 ms). */
    unlock(): void {
        if (!this.ctx) {
            try {
                this.ctx = new AudioContext();
            } catch {
                return;
            }
            const ctx = this.ctx, sr = ctx.sampleRate, r = rng(99);
            const comp = ctx.createDynamicsCompressor();
            comp.threshold.value = -10;
            comp.knee.value = 6;
            comp.ratio.value = 6;
            comp.attack.value = 0.001;
            comp.release.value = 0.12;
            comp.connect(ctx.destination);
            this.master = ctx.createGain();
            this.master.gain.value = this.volume;
            this.master.connect(comp);
            this.verb = ctx.createConvolver();
            this.verb.buffer = this.buffer(synthIR(sr, r));
            const wet = ctx.createGain();
            wet.gain.value = 0.55;
            this.verb.connect(wet).connect(this.master);

            const len = sr;
            this.noise = ctx.createBuffer(1, len, sr);
            const nd = this.noise.getChannelData(0);
            for (let i = 0; i < len; i++) nd[i] = r() * 2 - 1;
            for (const k of Object.keys(VOICES) as (Kind | "bot")[]) {
                const list: AudioBuffer[] = [];
                for (let i = 0; i < VARIANTS; i++) list.push(this.buffer([synthShot(sr, VOICES[k], r)]));
                this.shots.set(k, list);
            }
            this.bank = {
                click: this.buffer([synthMetal(sr, r, [2900, 4400, 6800], 0.012, 0.8, 0.06)]),
                magOut: this.buffer([synthMetal(sr, r, [820, 1650, 2700], 0.03, 0.6, 0.12)]),
                magIn: this.buffer([synthMetal(sr, r, [640, 1300, 3100], 0.025, 1, 0.12)]),
                bolt: this.buffer([synthMetal(sr, r, [1900, 3300, 5200], 0.018, 1, 0.09)]),
                shell: this.buffer([synthMetal(sr, r, [540, 1100, 2400], 0.035, 0.7, 0.14)]),
                dry: this.buffer([synthMetal(sr, r, [3600, 5900], 0.006, 0.9, 0.04)]),
            };
            for (let i = 0; i < VARIANTS; i++) {
                const f = 3800 + r() * 1500;
                this.casings.push(this.buffer([synthMetal(sr, r, [f, f * 1.47, f * 2.31], 0.05, 0.2, 0.18)]));
            }
        }
        if (this.ctx.state === "suspended") void this.ctx.resume();
    }

    get state(): string {
        return this.ctx ? this.ctx.state : "locked";
    }

    setVolume(v: number): void {
        this.volume = v;
        if (this.master) this.master.gain.value = v;
    }

    close(): void {
        void this.ctx?.close();
        this.ctx = null;
    }

    private ready(): boolean {
        return !!this.ctx && this.ctx.state === "running";
    }

    private buffer(chs: Float32Array<ArrayBuffer>[]): AudioBuffer {
        const b = this.ctx.createBuffer(chs.length, chs[0].length, this.ctx.sampleRate);
        chs.forEach((d, i) => b.copyToChannel(d, i));
        return b;
    }

    /** Plays a buffer at an offset, panned, with some reverb. */
    private play(buf: AudioBuffer, at: number, gain: number, pan = 0.15, verb = 0.15, rate = 1): void {
        const ctx = this.ctx, src = ctx.createBufferSource(), g = ctx.createGain(), p = ctx.createStereoPanner();
        src.buffer = buf;
        src.playbackRate.value = rate;
        g.gain.value = gain;
        p.pan.value = pan;
        src.connect(g).connect(p).connect(this.master);
        if (verb > 0) {
            const s = ctx.createGain();
            s.gain.value = verb;
            p.connect(s).connect(this.verb);
        }
        src.start(ctx.currentTime + at);
    }

    /** Noise burst through a filter with an exponential decay (cloth and friction sounds). */
    private burst(type: BiquadFilterType, freq: number, q: number, gain: number, attack: number, decay: number, at = 0): void {
        const t = this.ctx.currentTime + at;
        const src = this.ctx.createBufferSource(), f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
        src.buffer = this.noise;
        src.loop = true;
        f.type = type;
        f.frequency.value = freq;
        f.Q.value = q;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(gain, t + attack);
        g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
        src.connect(f).connect(g).connect(this.master);
        src.start(t, this.r() * 0.8);
        src.stop(t + attack + decay + 0.05);
    }

    private tone(type: OscillatorType, f0: number, f1: number, gain: number, decay: number, at = 0): void {
        const t = this.ctx.currentTime + at;
        const o = this.ctx.createOscillator(), g = this.ctx.createGain();
        o.type = type;
        o.frequency.setValueAtTime(f0, t);
        o.frequency.exponentialRampToValueAtTime(f1, t + decay);
        g.gain.setValueAtTime(gain, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
        o.connect(g).connect(this.master);
        o.start(t);
        o.stop(t + decay + 0.05);
    }

    /** dist in meters (0 = player's own gun), pan -1..1. Far shots arrive late (speed of sound), duller and wetter. */
    shot(kind: Kind | "bot", dist = 0, pan = 0): void {
        if (!this.ready()) return;
        const v = VOICES[kind], ctx = this.ctx, list = this.shots.get(kind);
        const at = ctx.currentTime + Math.min(0.15, dist / 343);
        const src = ctx.createBufferSource(), lp = ctx.createBiquadFilter(), g = ctx.createGain(), p = ctx.createStereoPanner(), send = ctx.createGain();
        src.buffer = list[Math.floor(this.r() * list.length)];
        src.playbackRate.value = 0.97 + this.r() * 0.06;
        lp.type = "lowpass";
        lp.frequency.value = 18000 / (1 + dist / 9);
        g.gain.value = v.gain / (1 + dist / 12);
        p.pan.value = Math.max(-1, Math.min(1, pan));
        send.gain.value = v.verb * (0.7 + Math.min(1.3, dist / 25));
        src.connect(lp).connect(g).connect(p).connect(this.master);
        p.connect(send).connect(this.verb);
        src.start(at);
        if (dist === 0 && kind !== "shotgun" && kind !== "sniper") {
            // Brass hitting the ground to the right.
            this.play(this.casings[Math.floor(this.r() * VARIANTS)], 0.38 + this.r() * 0.25, 0.09, 0.45, 0.05, 0.9 + this.r() * 0.2);
        }
    }

    reload(duration: number, perShell: boolean): void {
        if (!this.ready()) return;
        if (perShell) {
            this.play(this.bank.shell, duration * 0.6, 0.45);
            return;
        }
        // Release button, mag out, cloth, mag in, bolt release.
        this.play(this.bank.click, duration * 0.1, 0.35);
        this.play(this.bank.magOut, duration * 0.16, 0.5);
        this.burst("bandpass", 1400, 1.2, 0.12, 0.02, 0.18, duration * 0.3);
        this.play(this.bank.magIn, duration * 0.6, 0.7);
        this.play(this.bank.click, duration * 0.64, 0.35, 0.15, 0.15, 0.8);
        this.play(this.bank.bolt, duration * 0.86, 0.7);
    }

    /** Shotgun pump, or sniper bolt cycle (up, back, forward, down). */
    pump(bolt = false): void {
        if (!this.ready()) return;
        if (bolt) {
            this.play(this.bank.click, 0.32, 0.3, 0.2, 0.1, 0.7);
            this.play(this.bank.bolt, 0.42, 0.55, 0.2, 0.15, 0.85);
            this.play(this.casings[0], 0.62, 0.08, 0.5, 0.05, 0.8);
            this.play(this.bank.bolt, 0.6, 0.6, 0.2, 0.15, 1.05);
            this.play(this.bank.click, 0.72, 0.3, 0.2, 0.1, 0.8);
            return;
        }
        this.burst("bandpass", 1200, 1, 0.12, 0.01, 0.1, 0.12);
        this.play(this.bank.bolt, 0.2, 0.6, 0.15, 0.15, 0.75);
        this.play(this.bank.shell, 0.55, 0.12, 0.5, 0.05, 0.9);
        this.play(this.bank.bolt, 0.32, 0.7, 0.15, 0.15, 0.95);
    }

    dry(): void {
        if (this.ready()) this.play(this.bank.dry, 0, 0.5);
    }

    hit(head: boolean): void {
        if (!this.ready()) return;
        if (head) {
            this.tone("sine", 2400, 2300, 0.25, 0.28);
            this.tone("sine", 3600, 3500, 0.12, 0.22);
        } else this.tone("triangle", 1700, 1500, 0.18, 0.06);
    }

    kill(): void {
        if (!this.ready()) return;
        this.tone("sine", 320, 110, 0.5, 0.18);
        this.burst("bandpass", 2600, 4, 0.25, 0.002, 0.05, 0.02);
    }

    hurt(): void {
        if (!this.ready()) return;
        this.tone("sine", 90, 50, 0.6, 0.22);
        this.burst("lowpass", 380, 0.7, 0.5, 0.004, 0.18);
    }

    slide(): void {
        if (!this.ready()) return;
        this.burst("lowpass", 900, 0.6, 0.35, 0.02, 0.55);
        this.burst("bandpass", 2400, 0.8, 0.08, 0.02, 0.4);
    }

    step(): void {
        if (!this.ready()) return;
        this.burst("lowpass", 260 + this.r() * 120, 0.8, 0.16, 0.004, 0.07);
        this.burst("bandpass", 2600 + this.r() * 900, 1.5, 0.03, 0.002, 0.04);
    }

    horn(): void {
        if (!this.ready()) return;
        for (const f of [110, 164.8]) this.tone("sawtooth", f, f * 0.98, 0.09, 1.2);
    }
}
