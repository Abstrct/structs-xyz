/* Sound: weapon and UI cues synthesised with WebAudio (no assets to load),
 * the game's own stingers for the big moments, and a low ambient drone. */

import { asset } from './base';

type Sfx = 'hover' | 'select' | 'confirm' | 'deny' | 'tick' | 'missile' | 'cannon' | 'gatling' | 'laser' | 'impact' | 'explosion'
  | 'shield' | 'evade' | 'warp' | 'charge' | 'alert' | 'stealth' | 'ping';

const SAMPLES: Record<string, string> = {
  explosionBig: asset('/sound/explosion-big.mp3'),
  youExploded: asset('/sound/you-exploded.mp3'),
  vulnerable: asset('/sound/planet-vulnerable.mp3'),
  secure: asset('/sound/planet-secure.mp3'),
  alpha: asset('/sound/alpha.mp3'),
};

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private musicBus!: GainNode;
  private noise!: AudioBuffer;
  private buffers = new Map<string, AudioBuffer>();
  private drone: { stop: () => void } | null = null;
  private lastPlayed = new Map<string, number>();
  muted = false;

  constructor() {
    try { this.muted = localStorage.getItem('structs.muted') === '1'; } catch { /* storage unavailable */ }
    // Start on the first gesture, and resume after any later interruption (iOS, OS audio focus).
    const unlock = () => { if (!this.ctx) this.init(); else if (this.ctx.state === 'suspended' && !this.muted) void this.ctx.resume(); };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  private init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4;
    this.master.connect(comp).connect(this.ctx.destination);
    this.sfxBus = this.ctx.createGain(); this.sfxBus.gain.value = 0.7; this.sfxBus.connect(this.master);
    this.musicBus = this.ctx.createGain(); this.musicBus.gain.value = this.musicVolume; this.musicBus.connect(this.master);
    const len = this.ctx.sampleRate * 2;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    for (const [k, url] of Object.entries(SAMPLES)) {
      fetch(url).then((r) => r.arrayBuffer()).then((b) => this.ctx!.decodeAudioData(b)).then((buf) => this.buffers.set(k, buf)).catch(() => { /* optional */ });
    }
    this.startDrone();
    if (this.muted) void this.ctx.suspend();
  }

  private volume = 0.8;
  private musicVolume = 0.32;
  // A gain must be a finite number (a bad one throws in the middle of building the graph): 0..1 or the old level.
  setVolume(v: number) { v = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : this.volume; this.volume = v; if (this.ctx && !this.muted) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); }
  setMusicVolume(v: number) { v = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : this.musicVolume; this.musicVolume = v; if (this.ctx) this.musicBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.1); }

  setMuted(m: boolean) {
    this.muted = m;
    try { localStorage.setItem('structs.muted', m ? '1' : '0'); } catch { /* ignore */ }
    if (this.ctx) {
      this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.05);
      // Muted means silent and idle: suspend the graph so the score costs no CPU.
      if (m) setTimeout(() => { if (this.muted) void this.ctx?.suspend(); }, 150);
      else void this.ctx.resume();
    }
  }
  toggle() { this.setMuted(!this.muted); return this.muted; }

  private env(g: GainNode, t: number, a: number, peak: number, dcy: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + dcy);
  }
  private osc(type: OscillatorType, f0: number, f1: number, dur: number, peak: number, when = 0, dest?: AudioNode) {
    const c = this.ctx!, t = c.currentTime + when;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    this.env(g, t, 0.005, peak, dur);
    o.connect(g).connect(dest || this.sfxBus);
    o.start(t); o.stop(t + dur + 0.05);
  }
  private noiseBurst(dur: number, peak: number, filter: BiquadFilterType, f0: number, f1: number, when = 0, q = 1) {
    const c = this.ctx!, t = c.currentTime + when;
    const s = c.createBufferSource(); s.buffer = this.noise; s.loop = true;
    const f = c.createBiquadFilter(); f.type = filter; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = c.createGain(); this.env(g, t, 0.004, peak, dur);
    s.connect(f).connect(g).connect(this.sfxBus);
    s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }
  private sample(name: string, gain = 1, rate = 1) {
    const b = this.buffers.get(name);
    if (!b || !this.ctx) return false;
    const s = this.ctx.createBufferSource(); s.buffer = b; s.playbackRate.value = rate;
    const g = this.ctx.createGain(); g.gain.value = gain;
    s.connect(g).connect(this.sfxBus); s.start();
    return true;
  }

  play(name: Sfx, intensity = 1) {
    if (!this.ctx || this.muted) return;
    // Rate-limit identical cues so volleys don't stack into mush.
    const now = performance.now();
    const minGap = name === 'hover' ? 40 : name === 'gatling' ? 30 : 25;
    if (now - (this.lastPlayed.get(name) || 0) < minGap) return;
    this.lastPlayed.set(name, now);
    const k = intensity;
    switch (name) {
      case 'hover': this.osc('sine', 1800, 2200, 0.04, 0.03 * k); break;
      case 'select': this.osc('square', 880, 1320, 0.06, 0.05 * k); this.osc('sine', 1760, 1760, 0.08, 0.04 * k, 0.03); break;
      case 'confirm': this.osc('square', 660, 660, 0.06, 0.05); this.osc('square', 990, 990, 0.09, 0.05, 0.07); break;
      case 'deny': this.osc('sawtooth', 220, 140, 0.18, 0.06); break;
      case 'tick': this.osc('sine', 1200, 900, 0.05, 0.035 * k); this.noiseBurst(0.03, 0.02 * k, 'highpass', 6000, 9000); break;
      case 'ping': this.osc('sine', 1568, 1568, 0.25, 0.04 * k); this.osc('sine', 2093, 2093, 0.3, 0.025 * k, 0.05); break;
      case 'missile': this.noiseBurst(0.7, 0.12 * k, 'bandpass', 600, 2400, 0, 2); this.osc('sawtooth', 160, 90, 0.25, 0.05 * k); break;
      case 'cannon': this.osc('sine', 140, 38, 0.45, 0.45 * k); this.noiseBurst(0.25, 0.22 * k, 'lowpass', 2400, 200); break;
      case 'gatling': this.osc('square', 300, 120, 0.05, 0.06 * k); this.noiseBurst(0.06, 0.12 * k, 'bandpass', 2400, 1200, 0, 1.5); break;
      case 'laser': this.osc('sawtooth', 1800, 200, 0.22, 0.08 * k); this.osc('square', 900, 120, 0.2, 0.04 * k); break;
      case 'impact': this.noiseBurst(0.22, 0.25 * k, 'lowpass', 3000, 300); this.osc('sine', 110, 50, 0.2, 0.25 * k); break;
      case 'explosion':
        if (!this.sample('explosionBig', 0.75 * Math.min(1.2, k), 0.9 + Math.random() * 0.2)) {
          this.noiseBurst(1.2, 0.5 * k, 'lowpass', 1800, 60); this.osc('sine', 80, 25, 1.0, 0.5 * k);
        }
        break;
      case 'shield': this.osc('sine', 520, 1040, 0.25, 0.08 * k); this.osc('triangle', 780, 1560, 0.3, 0.05 * k, 0.02); this.noiseBurst(0.15, 0.04, 'highpass', 4000, 8000); break;
      case 'evade': this.noiseBurst(0.3, 0.09 * k, 'bandpass', 3000, 400, 0, 3); this.osc('sine', 900, 300, 0.25, 0.04 * k); break;
      case 'warp': this.osc('sawtooth', 60, 900, 0.9, 0.06 * k); this.noiseBurst(0.9, 0.08 * k, 'bandpass', 200, 5000, 0, 4); break;
      case 'charge': this.osc('triangle', 300, 1200, 0.35, 0.05 * k); break;
      case 'alert': this.osc('square', 740, 740, 0.12, 0.06); this.osc('square', 740, 740, 0.12, 0.06, 0.18); break;
      case 'stealth': this.osc('sine', 1200, 200, 0.6, 0.06 * k); this.noiseBurst(0.6, 0.05, 'highpass', 8000, 1500); break;
    }
  }

  stinger(name: 'youExploded' | 'vulnerable' | 'secure' | 'alpha', gain = 0.8) {
    if (!this.ctx || this.muted) return;
    this.sample(name, gain);
  }

  /* ── Generative score ─────────────────────────────────────────────────
   * A low drone, slow minor chord pads that change every two bars, sparse
   * pentatonic plinks through a delay and a synthetic reverb — and, when
   * intensity rises (battle), a soft low pulse on the beat. */
  private intensity = 0.3;
  setIntensity(v: number) { this.intensity = Math.max(0, Math.min(1, v)); }

  private startDrone() {
    if (!this.ctx || this.drone) return;
    const c = this.ctx;
    const out = c.createGain(); out.gain.value = 0;
    out.gain.linearRampToValueAtTime(1, c.currentTime + 6);
    out.connect(this.musicBus);

    // Space: a generated impulse response and a filtered feedback delay.
    const verb = c.createConvolver();
    const len = c.sampleRate * 3.2;
    const ir = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6); }
    verb.buffer = ir;
    const verbGain = c.createGain(); verbGain.gain.value = 0.55;
    verb.connect(verbGain).connect(out);
    const delay = c.createDelay(2); delay.delayTime.value = 0.42;
    const fb = c.createGain(); fb.gain.value = 0.38;
    const dlp = c.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 2400;
    delay.connect(dlp).connect(fb).connect(delay);
    dlp.connect(out); dlp.connect(verb);

    // Drone bed.
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 380; lp.Q.value = 2.5;
    const lfo = c.createOscillator(); lfo.frequency.value = 0.04;
    const lfoGain = c.createGain(); lfoGain.gain.value = 160;
    lfo.connect(lfoGain).connect(lp.frequency);
    const oscs = [55, 55.3, 82.4].map((f, i) => {
      const o = c.createOscillator(); o.type = i < 2 ? 'sawtooth' : 'triangle'; o.frequency.value = f;
      const g = c.createGain(); g.gain.value = i < 2 ? 0.045 : 0.03;
      o.connect(g).connect(lp); o.start();
      return o;
    });
    lp.connect(out); lp.connect(verb);
    lfo.start();

    const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);
    // Am9 → Fmaj7 → Dm9 → Em7(add11): cold, unresolved.
    const CHORDS = [[57, 60, 64, 67, 71], [53, 57, 60, 64, 67], [50, 53, 57, 60, 64], [52, 55, 59, 62, 69]];
    const PENTA = [69, 72, 74, 76, 79, 81, 84, 86, 88];
    const pad = (notes: number[], at: number, dur: number) => {
      for (const n of notes) {
        for (const det of [-6, 6]) {
          const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = midi(n - 12); o.detune.value = det;
          const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(500, at); f.frequency.linearRampToValueAtTime(900 + this.intensity * 900, at + dur * 0.5); f.frequency.linearRampToValueAtTime(500, at + dur);
          const g = c.createGain(); g.gain.setValueAtTime(0.0001, at); g.gain.linearRampToValueAtTime(0.012, at + 2.4); g.gain.setValueAtTime(0.012, at + dur - 2.5); g.gain.linearRampToValueAtTime(0.0001, at + dur + 1.5);
          o.connect(f).connect(g); g.connect(out); g.connect(verb);
          o.start(at); o.stop(at + dur + 1.6);
        }
      }
    };
    const plink = (n: number, at: number, vel: number) => {
      const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = midi(n);
      const o2 = c.createOscillator(); o2.type = 'triangle'; o2.frequency.value = midi(n) * 2.001;
      const g = c.createGain(); g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.03 * vel, at + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, at + 1.6);
      const g2 = c.createGain(); g2.gain.value = 0.25;
      o.connect(g); o2.connect(g2).connect(g);
      g.connect(delay); g.connect(out); g.connect(verb);
      o.start(at); o2.start(at); o.stop(at + 1.7); o2.stop(at + 1.7);
    };
    const pulse = (at: number, vel: number) => {
      const o = c.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(90, at); o.frequency.exponentialRampToValueAtTime(42, at + 0.25);
      const g = c.createGain(); g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.16 * vel, at + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.4);
      o.connect(g).connect(out); o.start(at); o.stop(at + 0.45);
    };

    const BAR = 4.0;                     // seconds per bar (60 bpm, 4/4)
    let nextBar = c.currentTime + 0.5, bar = 0;
    const timer = window.setInterval(() => {
      if (!this.ctx || this.muted) { nextBar = Math.max(nextBar, c.currentTime + 0.5); return; }
      // After a throttled background stretch, skip the missed bars instead of stacking them.
      if (nextBar < c.currentTime) nextBar = c.currentTime + 0.1;
      while (nextBar < c.currentTime + 1.0) {
        if (bar % 2 === 0) pad(CHORDS[(bar / 2) % CHORDS.length], nextBar, BAR * 2);
        // Plinks: sparse, denser with intensity.
        const count = Math.random() < 0.5 + this.intensity * 0.4 ? 1 + Math.floor(Math.random() * (1 + this.intensity * 3)) : 0;
        for (let i = 0; i < count; i++) plink(PENTA[Math.floor(Math.random() * PENTA.length)], nextBar + Math.floor(Math.random() * 8) * (BAR / 8), 0.5 + Math.random() * 0.5);
        if (this.intensity > 0.6) for (let b = 0; b < 4; b++) pulse(nextBar + b * (BAR / 4), b === 0 ? 1 : 0.55);
        nextBar += BAR; bar++;
      }
    }, 250);
    this.drone = { stop: () => { oscs.forEach((o) => o.stop()); lfo.stop(); clearInterval(timer); } };
  }
}

export const audio = new AudioEngine();
