/// <reference types="vite/client" />
import { TUNING, type MassClass } from './tuning';

/**
 * Authored sound effects (ElevenLabs, 2026-11-15): `src/assets/sfx/<kind>-<take>.mp3`, trimmed,
 * peak-normalised to -1 dBFS, mono 96 kbps. Each kind has one or more takes; a call plays a random
 * take with a little pitch jitter. Kinds without a file (or before they decode) use the synth below.
 */
/** Spatial mix numbers (presentation): pan reaches full width this far across (m), never hard-panned; level falls off past `near`. */
const SPATIAL = { panWidth: 14, panMax: 0.85, near: 6, falloff: 28, duckDepth: 0.45, duckHold: 0.9 };

const SFX_FILES = import.meta.glob('./assets/sfx/*.mp3', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
export type SfxKind =
  | 'foot' | 'smash-light' | 'smash-medium' | 'smash-heavy' | 'bounce' | 'scrape' | 'shoulder' | 'leap' | 'land'
  | 'whoosh' | 'tierup' | 'tierdown' | 'banked' | 'cape' | 'spike' | 'roadblock';

/**
 * Audio: authored samples where they exist (SFX_FILES), Web Audio synthesis for the rest.
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
  private sirenPans: StereoPannerNode[] = [];
  private bed: { next: number; step: number; timer: number } | null = null;
  /** Rampage layer on the music bus (driving kick, 16th hats, brass stabs): in at Rampage, out when it's lost. */
  private rampLayer: GainNode | null = null;
  private gear = 0;
  /**
   * Spatial mix (Mike, 2026-11-15): the listener is the giant; left/right is the camera's screen-right,
   * so a honk left of him on screen comes from the left in any camera angle; farther is quieter.
   */
  private listener = { x: 0, z: 0, rx: 1, rz: 0 };
  /** Where the sound being built right now goes (a panner for a positioned sound, else the SFX bus). */
  private route: AudioNode | null = null;
  private out(): AudioNode {
    return this.route ?? this.buses.sfx;
  }
  /** Called every frame: the giant's position and the camera's screen-right on the ground. */
  setListener(x: number, z: number, rightX: number, rightZ: number) {
    const n = Math.hypot(rightX, rightZ) || 1;
    this.listener = { x, z, rx: rightX / n, rz: rightZ / n };
  }
  /** Pan (−1..1) and level for a sound at world (x, z). Public for the E2E check. */
  placeOf(x: number, z: number): { pan: number; gain: number } {
    const L = this.listener;
    const dx = x - L.x;
    const dz = z - L.z;
    const across = dx * L.rx + dz * L.rz;
    const dist = Math.hypot(dx, dz);
    return { pan: Math.max(-1, Math.min(1, across / SPATIAL.panWidth)) * SPATIAL.panMax, gain: 1 / (1 + Math.max(0, dist - SPATIAL.near) / SPATIAL.falloff) };
  }
  /** Build one sound at a world position: everything `make` creates goes through its own panner. */
  private at(pos: { x: number; z: number } | undefined, make: () => void) {
    if (!pos || !this.ctx) return make();
    const { pan, gain } = this.placeOf(pos.x, pos.z);
    const g = this.ctx.createGain();
    g.gain.value = gain;
    const p = this.ctx.createStereoPanner();
    p.pan.value = pan;
    g.connect(p).connect(this.buses.sfx);
    this.route = g;
    try {
      make();
    } finally {
      this.route = null;
    }
    // The nodes are released when the sounds feeding them end (no references kept).
  }
  /** Stingers duck the effects for a moment so the news cue cuts through. */
  private duck(depth: number, hold: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const g = this.buses.sfx.gain;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(this.vol.sfx * depth, t, 0.03);
    g.setTargetAtTime(this.vol.sfx, t + hold, 0.25);
  }

  /** Decoded takes per kind (filled after unlock). */
  private samples = new Map<string, AudioBuffer[]>();

  /** Fetch and decode every take once; calls fall back to the synth until theirs are in. */
  private loadSamples() {
    for (const [path, url] of Object.entries(SFX_FILES)) {
      const kind = path.replace(/^.*\/|-[a-z]\.mp3$/g, '');
      fetch(url)
        .then((r) => r.arrayBuffer())
        .then((b) => this.ctx!.decodeAudioData(b))
        .then((buf) => {
          const list = this.samples.get(kind) ?? [];
          list.push(buf);
          this.samples.set(kind, list);
        })
        .catch((e) => console.warn(`sfx ${path} failed to load:`, e));
    }
  }

  /** Kinds with at least one decoded take, and how many takes (E2E / debug). */
  loadedKinds(): Record<string, number> {
    return Object.fromEntries([...this.samples].map(([k, v]) => [k, v.length]));
  }

  /** Play a take of `kind`: false when none is loaded (the caller plays its synth instead). */
  private play(kind: SfxKind, vol: number, rate = 1, jitter = 0.04, when = 0): boolean {
    const takes = this.samples.get(kind);
    if (!takes?.length || !this.ctx) return false;
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = takes[Math.floor(Math.random() * takes.length)];
    src.playbackRate.value = rate * (1 + (Math.random() * 2 - 1) * jitter);
    const g = c.createGain();
    g.gain.value = vol;
    src.connect(g).connect(this.out());
    src.start(c.currentTime + when);
    return true;
  }

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
      this.loadSamples();
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
    this.buses.sfx.gain.setTargetAtTime(this.hushed ? 0 : this.vol.sfx, this.ctx.currentTime, 0.12);
  }

  /** The title's cover art hides the attract broadcast: its sounds (steps, sirens, rotor) wait for the main menu. */
  private hushed = false;
  setHushed(h: boolean) {
    if (h === this.hushed) return;
    this.hushed = h;
    this.applyVolumes();
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
    src.connect(f).connect(g).connect(this.out());
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
    o.connect(g).connect(this.out());
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** §13 bass footfalls; §10 pitch drops on each tier. */
  footfall(tier: number) {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    const base = [72, 60, 50][tier];
    const vol = [0.55, 0.75, 1.0][tier];
    // Rampage: a sub thump under every step, whatever plays on top (he's at his heaviest).
    if (tier === TUNING.tiers.length - 1) {
      const R = TUNING.rampageAudio;
      this.tone(t, R.subTime, R.subFrom, R.subTo, R.subVol);
    }
    // Heavier and lower each gear (§10: pitch drops on each tier).
    if (this.play('foot', [0.5, 0.7, 0.95][tier], [1.0, 0.9, 0.8][tier])) return;
    this.tone(t, 0.22 + tier * 0.05, base, base * 0.45, vol);
    this.noise(t, 0.07, 'lowpass', 500 - tier * 80, 0.7, 0.25 + tier * 0.12);
  }

  smash(cls: MassClass, pos?: { x: number; z: number }) {
    if (!this.ready) return;
    this.at(pos, () => this.smashAt(cls));
  }
  private smashAt(cls: MassClass) {
    const t = this.ctx!.currentTime;
    // Small smashes (Mike, 2026-11-17: "no SFX on breaking smaller objects at times"): their takes are quiet (medium
    // averages −27.6 dB vs −11 for heavy) and the hit lands ~0.2s in, so a crack goes under them at once, and they play louder.
    if (cls === 'light' || cls === 'medium') {
      const k = cls === 'medium' ? 1 : 0.7;
      this.noise(t, 0.09, 'bandpass', 1800, 0.9, 0.55 * k, 700);
      this.tone(t, 0.1, 160, 70, 0.35 * k);
    }
    const SV = TUNING.sfxLevels;
    if (cls !== 'immovable' && this.play(`smash-${cls}` as SfxKind, cls === 'heavy' ? SV.heavy : cls === 'medium' ? SV.medium : SV.light)) return;
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

  bounce(pos?: { x: number; z: number }) {
    if (!this.ready) return;
    this.at(pos, () => this.bounceAt());
  }
  private bounceAt() {
    if (this.play('bounce', 0.9)) return;
    const t = this.ctx!.currentTime;
    // Dull, embarrassing "bwomp".
    this.tone(t, 0.35, 95, 55, 0.9);
    this.tone(t, 0.3, 180, 140, 0.15, 'triangle');
    this.noise(t, 0.12, 'lowpass', 300, 0.5, 0.5);
  }

  scrape(pos?: { x: number; z: number }) {
    if (!this.ready) return;
    this.at(pos, () => this.scrapeAt());
  }
  private scrapeAt() {
    if (this.play('scrape', 0.35, 1, 0.08)) return;
    this.noise(this.ctx!.currentTime, 0.12, 'bandpass', 2400, 3, 0.12);
  }

  /** Spectacle chain: a bright tick per stunt, pitched up by the multiplier. */
  chainTick(mult: number) {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    const f = 520 * Math.pow(2, (mult - 1) / 6);
    this.tone(t, 0.12, f, f * 1.5, 0.07, 'square');
  }
  /** Chain banked (a till ring, bigger for a bigger multiplier) or dropped (a dull thud). */
  chainEnd(mult: number, dropped: boolean) {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    if (dropped) {
      this.tone(t, 0.3, 160, 70, 0.18, 'sawtooth');
      return;
    }
    // A till ring, louder and a touch higher for a bigger multiplier.
    if (this.play('banked', Math.min(0.85, 0.35 + mult * 0.1), 1 + Math.min(4, mult) * 0.03, 0.01)) return;
    for (let i = 0; i < Math.min(4, mult); i++) this.tone(t + i * 0.06, 0.25, 880 * Math.pow(1.26, i), 880 * Math.pow(1.26, i), 0.06, 'triangle');
  }

  /** Gear build-up: a short rising tick on each step of the last second before a gear-up (k 0..1). */
  gearTick(k: number) {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    this.tone(t, 0.09, 420 + k * 520, 520 + k * 700, 0.05 + k * 0.05, 'triangle');
  }

  /**
   * The music follows the gear: at Rampage a layer drops in; losing Rampage cuts it with a power-down
   * sweep. `quiet` (a new broadcast, the end) cuts it without the sweep.
   */
  setGear(tier: number, quiet = false) {
    const top = tier === TUNING.tiers.length - 1;
    const was = this.gear === TUNING.tiers.length - 1;
    this.gear = tier;
    if (!this.ready || !this.rampLayer) return;
    const R = TUNING.rampageAudio;
    const t = this.ctx!.currentTime;
    const g = this.rampLayer.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(top ? R.layer : 0, t + (top ? R.fadeIn : R.fadeOut));
    if (was && !top && !quiet) {
      // Power-down: a falling saw through a closing filter, like the band running out of tape.
      const o = this.ctx!.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(220, t);
      o.frequency.exponentialRampToValueAtTime(40, t + 0.45);
      const lp = this.ctx!.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(2400, t);
      lp.frequency.exponentialRampToValueAtTime(200, t + 0.45);
      const v = this.ctx!.createGain();
      v.gain.setValueAtTime(0.09, t);
      v.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.connect(lp).connect(v).connect(this.buses.music);
      o.start(t);
      o.stop(t + 0.55);
    }
  }

  tierUp(tier: number) {
    if (!this.ready) return;
    // Lower and bigger at Rampage.
    if (this.play('tierup', tier >= 2 ? 1 : 0.8, tier >= 2 ? 0.85 : 1, 0.02)) return;
    const t = this.ctx!.currentTime;
    this.noise(t, 0.45, 'bandpass', 300, 1.5, 0.35, 2600);
    this.tone(t, 0.35, 90 - tier * 12, 45 - tier * 6, 0.6);
  }

  tierDown() {
    if (!this.ready) return;
    if (this.play('tierdown', 0.7)) return;
    const t = this.ctx!.currentTime;
    this.noise(t, 0.3, 'bandpass', 1400, 1.5, 0.2, 300);
  }

  shoulder() {
    if (!this.ready) return;
    if (this.play('shoulder', 0.85)) return;
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
    if (this.play('leap', 0.85)) return;
    const t = this.ctx!.currentTime;
    this.noise(t, 0.35, 'bandpass', 400, 1.2, 0.4, 1800);
    this.tone(t, 0.25, 70, 140, 0.4);
  }
  /** Impact pass: a dodge, air ripping past (rising then falling, like a car passing close). */
  whoosh(pos?: { x: number; z: number }) {
    if (!this.ready) return;
    this.at(pos, () => this.whooshAt());
  }
  private whooshAt() {
    if (this.play('whoosh', 0.6, 1, 0.08)) return;
    const t = this.ctx!.currentTime;
    this.noise(t, 0.28, 'bandpass', 700, 1.6, 0.45, 2600);
  }
  /** Leap landing: the biggest thump in the game. */
  land() {
    if (!this.ready) return;
    if (this.play('land', 1)) return;
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
    if (this.play('cape', 0.25 * intensity, 1, 0.1)) return;
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
  honk(vol: number, pos?: { x: number; z: number }) {
    if (!this.ready) return;
    this.at(pos, () => this.honkAt(vol));
  }
  private honkAt(vol: number) {
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
    g.connect(f).connect(this.out());
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
      const pan = c.createStereoPanner();
      o.connect(bp).connect(g).connect(pan).connect(this.buses.sfx);
      o.start();
      lfo.start();
      this.sirens.push(g);
      this.sirenPans.push(pan);
    }
  }

  /** Siren levels 0..1 per cruiser (distance-based; 0 = not in the chase), and where each one is (panned like the rest of the mix). */
  setSirens(levels: number[], positions?: ({ x: number; z: number } | null)[]) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.sirens.forEach((g, i) => g.gain.setTargetAtTime(0.022 * (levels[i] ?? 0), t, 0.4));
    if (positions) this.sirenPans.forEach((p, i) => {
      const at = positions[i];
      if (at) p.pan.setTargetAtTime(this.placeOf(at.x, at.z).pan, t, 0.15);
    });
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
    const layer = (this.rampLayer = c.createGain());
    layer.gain.value = this.gear === TUNING.tiers.length - 1 ? TUNING.rampageAudio.layer : 0;
    layer.connect(bus);
    const hat = (t: number, vol: number) => {
      const src = c.createBufferSource();
      src.buffer = this.noiseBuf;
      const hp = c.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 7000;
      const g = c.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
      src.connect(hp).connect(g).connect(layer);
      src.start(t, Math.random() * 0.5, 0.06);
    };
    const into = (t: number, f0: number, f1: number, dur: number, vol: number, type: OscillatorType, cutoff: number) => {
      const o = c.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = cutoff;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(lp).connect(g).connect(layer);
      o.start(t);
      o.stop(t + dur + 0.05);
    };
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
        // Rampage layer (scheduled only while it's up or fading): kick on the beat, 16th hats, brass stabs on 1 and the and-of-2.
        if (this.gear === TUNING.tiers.length - 1 || layer.gain.value > 0.001) {
          if (step % 2 === 0) into(t, 140, 42, 0.18, 0.5, 'sine', 900);
          hat(t, step % 2 === 0 ? 0.05 : 0.03);
          hat(t + eighth / 2, 0.022);
          if (step % 8 === 0 || step % 8 === 3) for (const k of [4, 4 * thirds[bar], 6]) into(t, root * k, root * k, eighth * 0.85, 0.05, 'sawtooth', 1900);
        }
        b.step++;
        b.next += eighth;
      }
    };
    this.bed.timer = window.setInterval(tick, 60);
  }

  /** §25/§26 BREAKING stinger: a short brass-like stab on the music bus. */
  breaking() {
    if (!this.ready) return;
    this.duck(SPATIAL.duckDepth, SPATIAL.duckHold);
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
  tell(kind: 'cruiser' | 'roadblock' | 'spike' | 'rolling' | 'chopper' | 'net' | 'carrier', pos?: { x: number; z: number }) {
    if (!this.ready) return;
    // Police Net: tyres and a siren chirp as they close; Car Carrier: a long horn and the load rattling loose.
    if (kind === 'net') {
      this.at(pos, () => this.tellAt('roadblock'));
      this.whoop();
      return;
    }
    if (kind === 'carrier') {
      this.at(pos, () => {
        this.honkAt(0.9);
        this.tellAt('spike');
      });
      return;
    }
    this.at(pos, () => this.tellAt(kind));
  }
  private tellAt(kind: 'cruiser' | 'roadblock' | 'spike' | 'rolling' | 'chopper') {
    const t = this.ctx!.currentTime;
    switch (kind) {
      case 'cruiser':
        this.tone(t, 0.6, 70, 190, 0.18, 'sawtooth');
        this.noise(t, 0.6, 'lowpass', 300, 1, 0.15, 900);
        break;
      case 'roadblock':
        if (this.play('roadblock', 0.6)) break;
        this.noise(t, 1.2, 'bandpass', 2600, 6, 0.22, 1800);
        this.noise(t + 0.3, 1.0, 'bandpass', 3100, 7, 0.16, 2000);
        break;
      case 'spike':
        if (this.play('spike', 0.7)) break;
        for (let k = 0; k < 8; k++) this.noise(t + k * 0.09, 0.05, 'highpass', 4500, 2, 0.12);
        break;
      case 'rolling':
        this.noise(t, 1.0, 'bandpass', 3400, 9, 0.12, 2400);
        break;
      case 'chopper':
        // A second rotor comes in, its pitch rising as the cone sweeps (§11 "rotor pitch rises").
        for (let k = 0; k < 14; k++) this.noise(t + k * 0.1, 0.06, 'lowpass', 260 + k * 22, 1.5, 0.16 + k * 0.01);
        this.tone(t, 1.5, 48, 74, 0.08, 'sawtooth');
        break;
    }
  }

  /** Police chopper spotlight locks on: a hard electrical clunk. */
  spotlightLock() {
    if (!this.ready) return;
    const t = this.ctx!.currentTime;
    this.noise(t, 0.08, 'bandpass', 1800, 3, 0.35);
    this.tone(t, 0.25, 140, 120, 0.12, 'square');
  }

  /** End of the broadcast: a falling sting for busted, a rising one for the sign-off. */
  ending(cleared: boolean) {
    if (!this.ready) return;
    this.duck(SPATIAL.duckDepth, SPATIAL.duckHold * 1.4);
    const t = this.ctx!.currentTime;
    const chord = cleared ? [293.66, 369.99, 440, 587.33] : [293.66, 349.23, 415.3, 220];
    chord.forEach((f, i) => this.tone(t + i * 0.12, 0.9, f, cleared ? f : f * 0.94, 0.05, 'sawtooth'));
    this.tone(t, 1.2, 60, 35, 0.6);
  }

  setRotor(level: number) {
    if (this.rotor && this.ctx) this.rotor.gain.gain.setTargetAtTime(0.08 + level * 0.06, this.ctx.currentTime, 0.3);
  }
}
