import type { MassClass } from './tuning';

/**
 * Phase 0 placeholder audio, synthesized with Web Audio (no assets).
 * §29: separate music, SFX and voice buses. §26: footfalls are the brand;
 * Phase 5 replaces these with authored sounds without touching callers.
 */
export class Audio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  readonly buses: Record<'music' | 'sfx' | 'voice', GainNode> = {} as never;
  private noiseBuf!: AudioBuffer;
  private rotor: { gain: GainNode } | null = null;
  private lastWhip = 0;

  get ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** Must be called from a user gesture (autoplay policy). */
  unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.8;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      this.master.connect(comp).connect(this.ctx.destination);
      for (const k of ['music', 'sfx', 'voice'] as const) {
        const g = this.ctx.createGain();
        g.connect(this.master);
        this.buses[k] = g;
      }
      const len = this.ctx.sampleRate * 1.5;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.startRotor();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** §8: pause freezes broadcast audio. */
  setPaused(p: boolean) {
    if (!this.ctx) return;
    if (p) void this.ctx.suspend();
    else void this.ctx.resume();
  }

  private noise(t: number, dur: number, filter: BiquadFilterType, freq: number, q: number, vol: number, freqEnd?: number) {
    const c = this.ctx!;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = c.createBiquadFilter();
    f.type = filter;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.buses.sfx);
    src.start(t, Math.random() * 0.5, dur + 0.05);
  }

  private tone(t: number, dur: number, f0: number, f1: number, vol: number, type: OscillatorType = 'sine') {
    const c = this.ctx!;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.buses.sfx);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** §13 bass footfalls; §10 pitch drops on each tier. */
  footfall(tier: number) {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    const base = [72, 60, 50][tier];
    const vol = [0.55, 0.75, 1.0][tier];
    this.tone(t, 0.22 + tier * 0.05, base, base * 0.45, vol);
    this.noise(t, 0.07, 'lowpass', 500 - tier * 80, 0.7, 0.25 + tier * 0.12);
  }

  smash(cls: MassClass) {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    if (cls === 'medium') {
      // crunch
      this.noise(t, 0.22, 'bandpass', 1100, 0.8, 0.7, 400);
      this.tone(t, 0.18, 120, 50, 0.5);
    } else if (cls === 'heavy') {
      // metal crash + bass
      this.noise(t, 0.6, 'highpass', 2500, 0.5, 0.55, 1200);
      this.noise(t, 0.35, 'bandpass', 700, 2, 0.6, 300);
      this.tone(t, 0.5, 70, 32, 1.0);
      this.tone(t + 0.02, 0.3, 320, 180, 0.12, 'square');
    }
    // §13 low grunt on smashes
    this.tone(t + 0.01, 0.16, 110, 80, 0.18, 'sawtooth');
  }

  knock() {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    this.noise(t, 0.09, 'bandpass', 1600, 1.2, 0.35);
    this.tone(t, 0.08, 220, 120, 0.2, 'triangle');
  }

  bounce() {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    // Dull, embarrassing "bwomp".
    this.tone(t, 0.35, 95, 55, 0.9);
    this.tone(t, 0.3, 180, 140, 0.15, 'triangle');
    this.noise(t, 0.12, 'lowpass', 300, 0.5, 0.5);
  }

  scrape() {
    if (!this.ready) return;
    this.noise(this.ctx!.currentTime, 0.12, 'bandpass', 2400, 3, 0.12);
  }

  tierUp(tier: number) {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    this.noise(t, 0.45, 'bandpass', 300, 1.5, 0.35, 2600);
    this.tone(t, 0.35, 90 - tier * 12, 45 - tier * 6, 0.6);
  }

  tierDown() {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    this.noise(t, 0.3, 'bandpass', 1400, 1.5, 0.2, 300);
  }

  shoulder() {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    this.noise(t, 0.25, 'lowpass', 900, 1, 0.6, 200);
    this.tone(t, 0.3, 140, 60, 0.6);
  }

  shove() {
    if (!this.ready) return;
    // Tiny "hup!" yelp: comic, not pained.
    const t = this.ctx!.currentTime;
    const f = 500 + Math.random() * 300;
    this.tone(t, 0.12, f, f * 1.4, 0.06, 'triangle');
  }

  /** §13 cape whip on turns. */
  capeWhip(intensity: number) {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    if (t - this.lastWhip < 0.35) return;
    this.lastWhip = t;
    this.noise(t, 0.18, 'bandpass', 1800, 1.2, 0.12 * intensity, 600);
  }

  /** §26 rotor wash bed. */
  private startRotor() {
    const c = this.ctx!;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 260;
    const chop = c.createGain();
    chop.gain.value = 0.5;
    const lfo = c.createOscillator();
    lfo.frequency.value = 7.5;
    const lfoGain = c.createGain();
    lfoGain.gain.value = 0.45;
    lfo.connect(lfoGain).connect(chop.gain);
    const g = c.createGain();
    g.gain.value = 0.12;
    src.connect(f).connect(chop).connect(g).connect(this.buses.sfx);
    src.start();
    lfo.start();
    this.rotor = { gain: g };
  }

  setRotor(level: number) {
    if (this.rotor && this.ctx) this.rotor.gain.gain.setTargetAtTime(0.08 + level * 0.06, this.ctx.currentTime, 0.3);
  }
}
