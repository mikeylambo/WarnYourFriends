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
  private sirens: GainNode[] = [];
  private bed: { next: number; step: number; timer: number } | null = null;

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
      this.startSirens(3);
      this.startBed();
      this.applyVolumes();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private vol = { master: 0.8, music: 0.8, sfx: 0.9 };
  /** Shell settings: master / music / SFX volume (0..1). */
  setVolumes(master: number, music: number, sfx: number) {
    this.vol = { master: 0.8 * master, music, sfx };
    this.applyVolumes();
  }
  private applyVolumes() {
    if (!this.ctx) return;
    this.master.gain.value = this.vol.master;
    this.buses.music.gain.value = 0.55 * this.vol.music;
    this.buses.sfx.gain.value = this.vol.sfx;
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

  // --- Phase 3 abilities (§17): semantic calls, synth placeholders ---
  /** Leap take-off: a heavy grunt of air. */
  leap() {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    this.noise(t, 0.35, 'bandpass', 400, 1.2, 0.4, 1800);
    this.tone(t, 0.25, 70, 140, 0.4);
  }
  /** Leap landing: the biggest thump in the game. */
  land() {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    this.tone(t, 0.6, 55, 22, 1.0);
    this.noise(t, 0.5, 'lowpass', 700, 0.8, 0.8, 120);
  }
  /** The Stare: a low swell, then silence. */
  stare() {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    this.tone(t, 0.9, 110, 104, 0.35, 'triangle');
    this.tone(t + 0.05, 0.9, 165, 156, 0.18, 'triangle');
  }
  /** Hijack Hop: roof dent and an engine rev. */
  hijack() {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    this.noise(t, 0.18, 'bandpass', 900, 2, 0.5);
    this.tone(t + 0.1, 0.8, 80, 220, 0.25, 'sawtooth');
  }
  /** Pose for the Camera: a run of camera shutters and flashes charging. */
  pose() {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    for (let i = 0; i < 6; i++) {
      this.noise(t + i * 0.11 + Math.random() * 0.04, 0.04, 'highpass', 3000, 1, 0.25);
      this.tone(t + i * 0.11, 0.12, 2400, 5200, 0.03, 'sine');
    }
  }
  /** Ability button with nothing to do (cooling down / no car near): a soft dud. */
  dud() {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    this.tone(t, 0.1, 220, 180, 0.08, 'square');
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

  /** Phase 0c: car horn, two detuned square tones (deadpan, not angry). */
  honk(vol: number) {
    if (!this.ready) return;
    const c = this.ctx!;
    const t = c.currentTime;
    const dur = 0.18 + Math.random() * 0.2;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.07 * vol, t + 0.01);
    g.gain.setValueAtTime(0.07 * vol, t + dur);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.05);
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1800;
    g.connect(f).connect(this.buses.sfx);
    const base = 380 + Math.random() * 60;
    for (const m of [1, 1.26]) {
      const o = c.createOscillator();
      o.type = 'square';
      o.frequency.value = base * m;
      o.connect(g);
      o.start(t);
      o.stop(t + dur + 0.08);
    }
  }

  /** Phase 0c: one continuous siren voice per cruiser (wail, yelp, hi-lo), silent until set. */
  private startSirens(n: number) {
    const c = this.ctx!;
    const modes = [
      { centre: 950, depth: 380, rate: 0.19, wave: 'sine' as OscillatorType },
      { centre: 1050, depth: 300, rate: 2.7, wave: 'sine' as OscillatorType },
      { centre: 820, depth: 140, rate: 0.85, wave: 'square' as OscillatorType },
    ];
    for (let i = 0; i < n; i++) {
      const m = modes[i % modes.length];
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = m.centre;
      const lfo = c.createOscillator();
      lfo.type = m.wave;
      lfo.frequency.value = m.rate;
      const depth = c.createGain();
      depth.gain.value = m.depth;
      lfo.connect(depth).connect(o.frequency);
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1100;
      bp.Q.value = 0.9;
      const g = c.createGain();
      g.gain.value = 0;
      o.connect(bp).connect(g).connect(this.buses.sfx);
      o.start();
      lfo.start();
      this.sirens.push(g);
    }
  }

  /** Siren levels 0..1 per cruiser (distance-based; 0 = not in the chase). */
  setSirens(levels: number[]) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.sirens.forEach((g, i) => g.gain.setTargetAtTime(0.022 * (levels[i] ?? 0), t, 0.4));
  }

  /**
   * Phase 0c: a low, original news-theme bed on the music bus. 100 BPM: a pulsing
   * bass ostinato over i–VI–VII–V in D minor, a soft pad, a teletype tick, and a
   * low drum every four bars. Scheduled ahead in small batches.
   */
  private startBed() {
    const c = this.ctx!;
    const beat = 60 / 100;
    const eighth = beat / 2;
    const roots = [73.42, 58.27, 65.41, 55.0]; // D2, Bb1, C2, A1
    const thirds = [1.189, 1.26, 1.26, 1.26]; // minor third on i, major on VI/VII/V
    const bus = this.buses.music;
    bus.gain.value = 0.55;
    this.bed = { next: c.currentTime + 0.1, step: 0, timer: 0 };
    const voice = (t: number, f: number, dur: number, vol: number, type: OscillatorType, cutoff: number) => {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = cutoff;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + Math.min(0.02, dur / 4));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(lp).connect(g).connect(bus);
      o.start(t);
      o.stop(t + dur + 0.05);
    };
    const tick = () => {
      const b = this.bed!;
      if (c.state !== 'running') return;
      while (b.next < c.currentTime + 0.25) {
        const t = b.next;
        const step = b.step; // 8th notes, 32 per 4-bar phrase
        const bar = Math.floor(step / 8) % 4;
        const root = roots[bar];
        // Bass: driving 8ths, octave pop on the off-beat of beat 4.
        voice(t, step % 8 === 7 ? root * 2 : root, eighth * 0.9, step % 2 === 0 ? 0.16 : 0.1, 'sawtooth', 380);
        // Pad: one chord per bar.
        if (step % 8 === 0) for (const k of [2, 2 * thirds[bar], 3]) voice(t, root * k, beat * 4 * 0.98, 0.022, 'triangle', 1400);
        // Teletype tick on 8ths, accented on the beat.
        voice(t, 2400, 0.03, step % 2 === 0 ? 0.018 : 0.009, 'square', 6000);
        // Low drum at the top of each phrase and before the turnaround.
        if (step % 32 === 0 || step % 32 === 30) voice(t, 58, 0.5, 0.22, 'sine', 300);
        b.step++;
        b.next += eighth;
      }
    };
    this.bed.timer = window.setInterval(tick, 60);
  }

  /** §25/§26 BREAKING stinger: a short brass-like stab on the music bus. */
  breaking() {
    if (!this.ready) return;
    const c = this.ctx!;
    const t = c.currentTime;
    for (const [f, d] of [[293.66, 0], [349.23, 0], [440, 0], [587.33, 0.0]] as const) {
      for (const det of [-6, 6]) {
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = det;
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(3200, t);
        lp.frequency.exponentialRampToValueAtTime(700, t + 0.5);
        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, t + d);
        g.gain.exponentialRampToValueAtTime(0.035, t + d + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.6);
        o.connect(lp).connect(g).connect(this.buses.music);
        o.start(t + d);
        o.stop(t + d + 0.65);
      }
    }
    this.tone(t, 0.6, 70, 40, 0.5);
  }

  /** §19: a siren whoop announces each pursuer before it arrives. */
  whoop() {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    this.tone(t, 0.5, 500, 1300, 0.07, 'sawtooth');
    this.tone(t + 0.5, 0.35, 1300, 600, 0.05, 'sawtooth');
  }

  /** §11 tells: engine rev (cruiser ram), tyre screech (roadblock), metallic rattle (spikes), brakes (rolling). */
  tell(kind: 'cruiser' | 'roadblock' | 'spike' | 'rolling') {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    switch (kind) {
      case 'cruiser':
        this.tone(t, 0.6, 70, 190, 0.18, 'sawtooth');
        this.noise(t, 0.6, 'lowpass', 300, 1, 0.15, 900);
        break;
      case 'roadblock':
        this.noise(t, 1.2, 'bandpass', 2600, 6, 0.22, 1800);
        this.noise(t + 0.3, 1.0, 'bandpass', 3100, 7, 0.16, 2000);
        break;
      case 'spike':
        for (let k = 0; k < 8; k++) this.noise(t + k * 0.09, 0.05, 'highpass', 4500, 2, 0.12);
        break;
      case 'rolling':
        this.noise(t, 1.0, 'bandpass', 3400, 9, 0.12, 2400);
        break;
    }
  }

  /** End of the broadcast: a falling sting for busted, a rising one for the sign-off. */
  ending(cleared: boolean) {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    const chord = cleared ? [293.66, 369.99, 440, 587.33] : [293.66, 349.23, 415.3, 220];
    chord.forEach((f, i) => this.tone(t + i * 0.12, 0.9, f, cleared ? f : f * 0.94, 0.05, 'sawtooth'));
    this.tone(t, 1.2, 60, 35, 0.6);
  }

  setRotor(level: number) {
    if (this.rotor && this.ctx) this.rotor.gain.gain.setTargetAtTime(0.08 + level * 0.06, this.ctx.currentTime, 0.3);
  }
}
