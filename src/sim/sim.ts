import { TUNING, type AbilityId, type MassClass, type UpgradeId } from '../tuning';
import { clamp } from './math';
import { Rng } from './rng';
import { Track } from './track';
import { Escort } from './escort';
import { Show } from './show';
import { Pursuit } from './pursuit';
import { Asks } from './asks';
import type { GainType, GiantState, Prop, SimEvent, SimInput, StuntType, TierDropReason, Unit } from './types';

export const CLASS_RANK: Record<MassClass, number> = { light: 0, medium: 1, heavy: 2, immovable: 3 };

/**
 * v0.3 run cycle: cadence (steps/s) as a function of speed. Knots sit at each
 * tier's top speed, so cadence stays inside 2.0–2.3 at every speed. Step length
 * is speed ÷ cadence: speed comes from stride length, not leg speed.
 */
export function cadenceAt(speed: number): number {
  const tiers = TUNING.tiers;
  let c: number;
  if (speed <= tiers[0].topSpeed) c = tiers[0].cadence;
  else if (speed >= tiers[tiers.length - 1].topSpeed) c = tiers[tiers.length - 1].cadence;
  else {
    let i = 0;
    while (speed > tiers[i + 1].topSpeed) i++;
    const a = tiers[i];
    const b = tiers[i + 1];
    c = a.cadence + ((b.cadence - a.cadence) * (speed - a.topSpeed)) / (b.topSpeed - a.topSpeed);
  }
  return clamp(c, TUNING.gait.cadenceMin, TUNING.gait.cadenceMax);
}

export function stepLengthAt(speed: number): number {
  return speed / cadenceAt(speed);
}

export interface SimStats {
  timeAtTier: [number, number, number];
  /** Score earned by distance (Rampage loop): part of show.banked. */
  distancePoints: number;
  smashes: number;
  smashesAcross: number;
  bounces: number;
  wallBumps: number;
  laneChanges: number;
  tierUps: number;
  tierDowns: number;
  footfalls: number;
  merges: number;
  minSpeed: number;
}

export interface SimOptions {
  seed: number;
  /** Phase 3: which segment of the run (0-based): decay rate and starting Heat. */
  segment?: number;
  /** Phase 3: upgrades owned (passives, and the equipped ability). */
  upgrades?: UpgradeId[];
  /** Ability levels I–III (absent = I). */
  levels?: Partial<Record<AbilityId, number>>;
  /** Giant size: he grows with his gear, hit-box included (TUNING.growth). Off = the fixed 3.6m giant. */
  growth?: boolean;
  /** First broadcast ever (2026-11-17 onboarding): a calm opening (TUNING.guided). Part of the leaderboard submission. */
  guided?: boolean;
  /** Edition of the news (TUNING.editions, 0 = Evening News). Part of the leaderboard submission. */
  edition?: number;
  /** Prototype endless mode: no districts, no exit and no fuel; chunk levels climb with distance until he's caught or cut. */
  endless?: boolean;
  /** Story asks picked before going live (TUNING.proto.storyAsks ids); absent = the seeded segment asks. */
  asks?: string[];
  /** Traffic mods on (TUNING.proto.mods ids). */
  mods?: string[];
}

const smoothstep = (t: number) => t * t * (3 - 2 * t);

/**
 * Phase 0b simulation: the giant on a procedural highway. Pure TypeScript,
 * deterministic for a seed and input stream, no rendering.
 */
export class Sim {
  readonly dt = 1 / TUNING.sim.hz;
  readonly seed: number;
  readonly track: Track;
  readonly giant: GiantState;
  readonly rng: Rng;
  /** Phase 0c: cosmetic police escort (never touches the giant or props). */
  readonly escort: Escort;
  /** Phase 2: Ratings, Heat, Pin and how the segment ends (§12). */
  readonly show = new Show();
  readonly pursuit: Pursuit;
  /** The producer's asks for this segment (Mike, 2026-11-15). */
  readonly asks: Asks;
  /** Traffic mods on this run (prototype). */
  readonly mods: string[];
  /** Phase 3: upgrades owned this run, and the one equipped ability (if any). */
  readonly upgrades: Set<UpgradeId>;
  readonly ability: AbilityId | null;
  /** The equipped ability's level (1–3; 0 with none). */
  readonly abilityLevel: number;
  /** Abilities stack (Mike, 2026-11-17): up to `run.abilitySlots`, in the order bought; slot 2 has its own button. */
  readonly abilities: AbilityId[];
  readonly ability2: AbilityId | null;
  /**
   * The chase convoy queues instead of stacking (Mike, 2026-11-19): escort and pursuing cruisers drive his path
   * and never steered round each other. Nearest-to-him keeps its place; anything overlapping it drops back
   * behind its bumper (only ever back, so the LOCKED spawn rule and the escort's gap floor still hold).
   */
  private separateConvoy() {
    const E = TUNING.escort;
    const cars: { s: number; d: number; hl: number; hw: number; speed: number; yields: boolean; set: (s: number, v: number) => void }[] = [];
    for (const c of this.escort.cruisers)
      if (c.active) cars.push({ s: c.s, d: c.d, hl: E.hl, hw: E.hw, speed: c.speed, yields: false, set: (s, v) => { c.s = s; c.speed = v; } });
    for (const u of this.pursuit.units)
      if (u.alive && u.unit === 'cruiser' && u.s < this.giant.s)
        cars.push({ s: u.s, d: u.d, hl: u.hl, hw: u.hw, speed: u.speed, yields: u.lost || !!u.backOff || u.phase === 'leave', set: (s, v) => { u.s = s; u.speed = v; } });
    if (cars.length < 2) return;
    // A cruiser that's out of it (lost, backing off, leaving) gives way, so it never holds the chase off his heels.
    cars.sort((a, b) => Number(a.yields) - Number(b.yields) || b.s - a.s);
    for (let i = 1; i < cars.length; i++) {
      const c = cars[i];
      for (let j = 0; j < i; j++) {
        const a = cars[j];
        if (Math.abs(a.d - c.d) >= a.hw + c.hw) continue;
        const limit = a.s - a.hl - c.hl - E.convoyGap;
        if (c.s > limit) {
          c.s = limit;
          c.speed = Math.min(c.speed, a.speed);
          c.set(c.s, c.speed);
        }
      }
    }
  }

  private readonly levels: Partial<Record<AbilityId, number>>;
  /** An ability's level (1–3), 0 if not held. */
  levelOf(id: AbilityId): number {
    return this.abilities.includes(id) ? Math.max(1, Math.min(TUNING.maxLevel, this.levels[id] ?? 1)) : 0;
  }
  /** Phase 2: the sign-off exit ramp, once open (v0.3 §4). */
  exit: { s: number; gore: number; segment: number; lane: number } | null = null;
  /** A fork's exit ramp, once open (Mike, 2026-11-15). */
  fork: { gore: number; segment: number; zone: 'avenue'; name: string } | null = null;
  /** Forks opened so far this segment (indexes TUNING.forks.at). */
  private forksOpened = 0;
  tick = 0;
  time = 0;
  stats: SimStats = { timeAtTier: [0, 0, 0], distancePoints: 0, smashes: 0, smashesAcross: 0, bounces: 0, wallBumps: 0, laneChanges: 0, tierUps: 0, tierDowns: 0, footfalls: 0, merges: 0, minSpeed: Infinity };

  private events: SimEvent[] = [];
  private near: Prop[] = [];

  /** Giant size grows with gear (SimOptions.growth). */
  readonly growth: boolean;

  /** This broadcast's edition (TUNING.editions). */
  readonly edition: (typeof TUNING.editions)[number];
  /** First broadcast ever: a calm opening (no drain or police for `guided.calmFor` s, nothing unbreakable for `guided.clearFor` m). */
  readonly guided: boolean;
  private rampagedOnce = false;

  /** The product of one effect over the traffic mods on (1 when none sets it). */
  private modProduct(k: 'hit' | 'drain' | 'catch'): number {
    return this.mods.reduce((x, m) => x * (TUNING.proto.mods[m][k] ?? 1), 1);
  }
  /** The traffic mods' score multiplier, applied once when the broadcast ends. */
  modMult = 1;
  private modsBanked = false;
  private finaleQueued = false;
  /** Police spawn pace from the traffic mods, before any district's own pace. */
  private basePace = 1;
  /** Endless mode (prototype): no exit, no fuel. */
  readonly endless: boolean;
  private baseDecayMult = 1;

  constructor(opts: SimOptions) {
    this.seed = opts.seed;
    this.growth = opts.growth ?? false;
    this.rng = new Rng(opts.seed ^ 0x51ed);
    this.guided = !!opts.guided;
    this.edition = TUNING.editions[Math.max(0, Math.min(TUNING.editions.length - 1, opts.edition ?? 0))];
    this.endless = !!opts.endless;
    this.track = new Track(opts.seed, opts.segment ?? 0, this.guided, this.edition.hard, this.endless);
    this.mods = (opts.mods ?? []).filter((m) => m in TUNING.proto.mods);
    if (this.mods.includes('heavyLoad')) {
      this.track.levelBonus = 1;
      this.track.allPeak = true; // Mike, 2026-11-24: "barely noticed the difference"
    }
    this.escort = new Escort(opts.seed, this.track);
    this.pursuit = new Pursuit(opts.seed, this);
    for (const m of this.mods) this.pursuit.pace *= TUNING.proto.mods[m].pace ?? 1;
    this.basePace = this.pursuit.pace;
    const scratch: Unit[] = [];
    this.escort.solid = (a, b) => this.pursuit.solidBetween(a, b, scratch);
    this.track.occupied = (a, b) => this.pursuit.units.filter((u) => u.alive && u.unit !== 'chopper' && u.s + u.hl >= a && u.s - u.hl <= b);
    const EH = TUNING.escort;
    this.track.vehicles = (a, b) => [
      ...this.pursuit.units.filter((u) => u.alive && u.unit !== 'chopper' && u.s + u.hl >= a && u.s - u.hl <= b),
      ...this.escort.cruisers.filter((c) => c.active && c.s + EH.hl >= a && c.s - EH.hl <= b).map((c) => ({ s: c.s, d: c.d, hl: EH.hl, hw: EH.hw })),
    ];
    this.upgrades = new Set(opts.upgrades ?? []);
    // In the order bought (opts.upgrades keeps it), at most `abilitySlots`.
    this.abilities = (opts.upgrades ?? []).filter((u): u is AbilityId => (['leap', 'stare', 'breakaway', 'primeTime', 'shoulder'] as string[]).includes(u)).slice(0, TUNING.run.abilitySlots);
    this.levels = { ...(opts.levels ?? {}) };
    this.ability = this.abilities[0] ?? null;
    this.ability2 = this.abilities[1] ?? null;
    this.abilityLevel = this.ability ? this.levelOf(this.ability) : 0;
    this.show.startSegment(opts.segment ?? 0);
    if (this.guided) this.show.decayGrace = TUNING.guided.calmFor;
    this.show.decayMult = this.baseDecayMult = this.edition.decay * (TUNING.proto.on ? TUNING.proto.decayMult : 1) * this.modProduct('drain');
    this.show.pinFillMult = this.modProduct('catch');
    if (TUNING.proto.on) this.show.ratings = this.show.peak = TUNING.proto.startRatings;
    if (this.edition.heat) this.show.heat = Math.min(5, this.show.heat + this.edition.heat);
    this.asks = new Asks(opts.seed, opts.segment ?? 0, this.track, opts.asks);
    const PV = TUNING.passives;
    if (this.upgrades.has('crowdPleaser')) this.show.rampageDecayMult = PV.crowdPleaserDecay;
    if (this.upgrades.has('slipstream')) {
      this.show.gainMult.policeCrash = PV.slipstreamMult;
      this.show.stuntMult.policeCrash = PV.slipstreamMult;
    }
    const lane = Math.floor(TUNING.lanes.start / 2);
    const d = this.track.laneCenter(lane);
    const speed = TUNING.giant.startSpeed;
    this.giant = {
      s: 0,
      d,
      lane,
      prevLane: lane,
      move: null,
      moveT: 1,
      moveDur: 0,
      moveFromD: d,
      moveToD: d,
      moveFromLane: lane,
      bumpDir: 0,
      laneQueue: 0,
      laneBufferDir: 0,
      laneBufferFrames: 0,
      speed,
      tier: 1, // Rampage loop: Stride is the base gear (Jog is gone; the run-up from startSpeed is the ease-in)
      tierTimer: 0,
      stumble: 0,
      sprint: 0,
      brakeHeld: 0,
      braking: false,
      shoulderT: 0,
      shoulderCd: 0,
      shoulderBuffer: 0,
      stepPos: 0,
      stepLen: stepLengthAt(speed),
      odometer: 0,
      abilityCd: 0,
      abilityBuffer: 0,
      ability2Cd: 0,
      ability2Buffer: 0,
      air: 0,
      airDur: 0,
      airKind: 'leap',
      prime: 0,
      skin: this.upgrades.has('thickSkin') ? TUNING.passives.thickSkinHits : 0,
      peakTier: 1,
      meter: 0,
      rampT: 0,
      rampElapsed: 0,
    };
  }

  get tierTuning() {
    return TUNING.tiers[this.giant.tier];
  }

  /** Time at top speed to the next gear: Second Wind shortens it while he's below the gear he had. */
  private tierUpAfter(): number {
    const g = this.giant;
    const base = this.tierTuning.tierUpAfter;
    return base * (this.upgrades.has('secondWind') && g.tier < g.peakTier ? TUNING.passives.secondWindTierUp : 1);
  }

  /** Progress toward the next gear, 0..1 (0 at top gear): the HUD pip and the build-up cue read it. */
  get tierUpProgress(): number {
    // Rampage loop: the HUD's build-up reads the meter.
    if (this.giant.tier >= 1) return this.giant.meter / 100;
    const g = this.giant;
    const t = this.tierTuning;
    if (!Number.isFinite(t.tierUpAfter)) return 0;
    const after = this.tierUpAfter();
    return clamp(g.tierTimer / after, 0, 1);
  }

  /** Seconds to the next gear if he keeps it up (Infinity at top gear). */
  get tierUpIn(): number {
    const t = this.tierTuning;
    if (!Number.isFinite(t.tierUpAfter)) return Infinity;
    const after = this.tierUpAfter();
    return Math.max(0, after - this.giant.tierTimer);
  }

  /** A lateral move (lane change, knock-back or wall bump) is in progress. */
  get laneBusy(): boolean {
    return this.giant.move !== null;
  }

  /** The broadcast is still on air (the sim freezes once the segment ends). */
  get live(): boolean {
    return this.show.state === 'live';
  }

  /** A threat is winding up (v0.3 §15: no camera cut during a tell). */
  get tellActive(): boolean {
    return this.pursuit.tellActive;
  }

  step(input: SimInput): SimEvent[] {
    this.events = [];
    const dt = this.dt;
    if (!this.live) {
      // Signed off: he keeps running, up the ramp and out of the shot (presentation fades to the recap).
      if (this.show.state === 'cleared') this.runOffRamp(dt);
      return this.events;
    }
    this.stepRampage(input, dt);
    this.stepAbility(input, dt);
    this.stepLanes(input);
    this.stepSpeed(input, dt);
    const segBefore = this.track.segmentAt(this.giant.s).index;
    const s0 = this.giant.s;
    this.advance(dt);
    // Score for distance at all times (Rampage pays its gear multiplier on it too).
    const dp = (this.giant.s - s0) * TUNING.rampage.distancePoints * TUNING.show.bankMult[this.giant.tier] * (TUNING.proto.on ? 1 + this.giant.sprint * TUNING.proto.sprintPoints : 1);
    this.show.banked += dp;
    this.stats.distancePoints += dp;
    this.stepLateral(dt);
    if (this.track.movers.length) this.track.stepMovers(dt, this.giant.s, this.giant.speed);
    if (this.track.shifters.length) this.track.stepShifters(dt, this.giant.s);
    this.collide();
    this.judgePasses();
    const seg = this.track.segmentAt(this.giant.s);
    if (seg.index !== segBefore && seg.kind === 'merge') this.emit({ type: 'merge', from: seg.lanes0, to: seg.lanes1, s: seg.s0 });
    if (seg.index !== segBefore && seg.zoneStart) this.emit({ type: 'zone', zone: seg.zone, name: seg.zoneName });
    if (seg.index !== segBefore && seg.landmark) this.emit({ type: 'landmark', kind: seg.landmark, name: seg.landmarkName ?? '', s: seg.s0 });
    this.pursuit.step(dt);
    this.stepFork();
    this.stepExit();
    const outnumbered = this.pursuit.chasing >= TUNING.show.outnumberedAt;
    for (const a of this.asks.step(dt, this.giant.tier === TUNING.tiers.length - 1, this.events)) this.show.banked += a.reward;
    const slipsBefore = this.show.netSlips;
    this.show.stepPin(dt, this.boxedIn(), this.caught(), this.giant.speed, this.events);
    if (this.show.netSlips > slipsBefore) {
      // Slipped the net (or shook off the police on his tail): a gear down, a stumble, and they fall away.
      const g = this.giant;
      this.hit('slip');
      g.stumble = TUNING.tierDrop.stumbleTime;
      if (this.show.pinCause === 'net') this.pursuit.disperseNet();
      else this.pursuit.shakeOff();
    }
    // Endless: the audience gets harder to hold the longer it runs (drain × 1 + t / endlessRamp).
    if (this.endless) this.show.decayMult = this.baseDecayMult * (1 + this.time / TUNING.proto.endlessRamp);
    this.show.step(dt, this.time + dt, this.giant.tier, outnumbered, this.events);
    // The teaching opening: the first Rampage always lands inside the first minute.
    if (this.guided && TUNING.proto.on && !this.rampagedOnce && !this.inRampage && this.time >= TUNING.guided.rampageBy) this.show.ratings = 100;
    if (this.inRampage) this.rampagedOnce = true;
    if (TUNING.proto.on && !this.inRampage) {
      // Prototype: one bar. The audience is the meter; full audience is Rampage ready.
      const was = this.giant.meter;
      this.giant.meter = this.show.ratings;
      if (was < 100 && this.giant.meter >= 100) this.emit({ type: 'meterFull' });
    }
    for (const id of this.escort.step(dt, this.time, this.giant)) {
      const c = this.escort.cruisers[id];
      this.emit({ type: 'escortJoin', id, behind: this.giant.s - c.s });
    }
    this.separateConvoy();
    const dk = this.track.segmentAt(this.giant.s).district;
    if (dk !== undefined) {
      this.asks.enter(dk, this.events);
      // The story's peak district brings the police on faster too (2026-11-24: the finale is the run's hardest stretch).
      const D = TUNING.proto.story.districts[Math.min(dk, TUNING.proto.story.districts.length - 1)];
      this.pursuit.pace = this.basePace * (D.pace ?? 1);
    }
    this.track.ensure(this.giant.s + TUNING.track.aheadDistance);
    if ((this.tick & 63) === 0) this.track.prune(this.giant.s);
    const g = this.giant;
    this.stats.timeAtTier[g.tier] += dt;
    this.stats.minSpeed = Math.min(this.stats.minSpeed, g.speed);
    this.tick++;
    this.time += dt;
    // Traffic mods multiply the score once, the step the broadcast ends (here, so the server's re-play agrees).
    if (!this.live && !this.modsBanked) {
      this.modsBanked = true;
      this.modMult = this.mods.reduce((k, m) => k * TUNING.proto.mods[m].score, 1);
      if (this.modMult !== 1) this.show.banked = Math.round(this.show.banked * this.modMult);
    }
    return this.events;
  }

  private runOffRamp(dt: number) {
    const g = this.giant;
    this.stepSpeed({ lane: 0, brake: false, shoulder: false }, dt);
    this.advance(dt);
    g.move = null;
    const seg = this.track.segments.find((sg) => sg.exit);
    if (seg) {
      const target = this.track.widthAt(g.s) + this.track.exitOffset(seg, g.s);
      g.d += clamp(target - g.d, -6 * dt, 6 * dt);
    }
    this.track.ensure(g.s + TUNING.track.aheadDistance);
    this.tick++;
    this.time += dt;
  }

  /** For the pursuit system (same event stream). */
  emitPublic(e: SimEvent) {
    this.emit(e);
  }

  /** Count an event toward the producer's asks; a finished ask banks its reward into the score. */
  private observeAsks(e: SimEvent) {
    if (e.type !== 'signOff' && !this.live) return;
    const unit = e.type === 'smash' && e.propId >= 1_000_000 ? this.pursuit.units.find((u) => u.id === e.propId)?.unit ?? null : null;
    for (const a of this.asks.observe(e, this.track.segmentAt(this.giant.s).zone, unit, this.events)) this.show.banked += a.reward;
    if (e.type === 'signOff') this.asks.finish(true, this.mods.length > 0, this.events);
  }

  /** Spectacle: a stunt joins the chain (score; Ratings are separate). */
  private stunt(cause: StuntType, base?: number) {
    this.fillMeter(cause);
    const n = this.events.length;
    this.show.stunt(cause, this.time, this.giant.tier, this.events, base);
    this.observeShowEvents(n);
  }

  /** Show pushes its own events (chain, sign-off); the asks count them too. */
  private observeShowEvents(from: number) {
    for (const e of this.events.slice(from)) if (e.type === 'chain' || e.type === 'signOff') this.observeAsks(e);
  }

  /** §12 gain, with "outnumbered" applied. */
  award(type: GainType) {
    this.show.gain(type, this.time, this.pursuit.chasing >= TUNING.show.outnumberedAt, this.events);
    // Impact pass: smashing and dodging drive him up the gears faster than just running.
    const feed = (TUNING.collision.tierFeed as Partial<Record<GainType, number>>)[type];
    if (feed && this.giant.tier < TUNING.tiers.length - 1) this.giant.tierTimer += feed;
  }

  /**
   * Impact pass: a dodge is passing close by something that would have bounced him at his
   * current tier, without touching it. Scores as a near-miss.
   */
  /** His collision radius now: grows with his gear when growth is on. */
  radius(): number {
    return TUNING.giant.radius * (this.growth ? TUNING.growth.scale[this.giant.tier] : 1);
  }

  private judgePasses() {
    const g = this.giant;
    const r = this.radius();
    const rank = this.smashRank();
    // The closest each thing comes while alongside him (Mike, 2026-11-24: oncoming close calls went unscored when he'd
    // moved off by the time the car was behind him).
    for (const p of this.track.propsBetween(g.s - r, g.s + r)) {
      if (!p.alive || p.judged) continue;
      const gap = Math.abs(p.d - g.d) - p.hw - r;
      p.closest = Math.min(p.closest ?? Infinity, gap);
    }
    for (const p of this.track.propsBetween(g.s - r - 12, g.s)) {
      if (!p.alive || p.judged || p.s + p.hl > g.s - r) continue;
      p.judged = true;
      if (this.rankOf(p) <= rank || g.air > 0) continue;
      const gap = Math.min(p.closest ?? Infinity, Math.abs(p.d - g.d) - p.hw - r);
      if (gap < 0 || gap > (TUNING.proto.on ? TUNING.proto.dodgeGap : TUNING.collision.dodgeGap)) continue;
      this.emit({ type: 'dodge', propId: p.id, s: p.s, d: p.d, gap });
      this.award('nearMiss');
    }
  }

  /** Another unit is already winding up (one tell at a time). */
  tellBusy(except: Unit): boolean {
    return this.pursuit.units.some((u) => u !== except && u.alive && u.phase === 'tell') || this.pursuit.tellActive;
  }

  /** Spike strip (v0.3): −1 tier, keep 70% speed, a stumble. No knock-back. */
  spikeHit(u: Unit) {
    const g = this.giant;
    if (this.inRampage) return; // Rampage: he runs over the strip
    g.speed = Math.max(TUNING.giant.speedFloor, g.speed * TUNING.pursuit.spike.speedKeep);
    g.stumble = TUNING.tierDrop.stumbleTime;
    g.tierTimer = 0;
    this.hit('impact');
    this.emit({ type: 'spiked', id: u.id });
  }

  /** Caught: crawling (under `caught.below`) with a pursuing cruiser within reach of him. */
  caught(): boolean {
    const g = this.giant;
    const C = TUNING.pursuit.caught;
    if (g.speed >= (TUNING.proto.on ? TUNING.proto.caughtBelow : C.below) || g.air > 0) return false;
    return this.pursuit.onHisTail().length > 0 || this.escort.tailing(g);
  }

  /** v0.3 box-in: both neighbouring lanes blocked and a unit within 8m ahead in yours. */
  boxedIn(): boolean {
    // No brake, no box-in bust (Mike, 2026-11-24): braking out the back was the only way out of one.
    if (TUNING.proto.on && TUNING.proto.noBrake) return false;
    const g = this.giant;
    const S = TUNING.show;
    // Units driving off (a net that's broken up) don't box anyone in.
    const units = this.pursuit.solidBetween(g.s - 6, g.s + S.pinUnitAhead + 3).filter((u) => u.phase !== 'leave');
    const inLane = (lane: number, u: Prop) => Math.abs(u.d - this.track.laneCenter(lane)) < u.hw + 1.0;
    const ahead = units.some((u) => u.unit !== 'carrier' && u.s - u.hl - g.s <= S.pinUnitAhead && u.s > g.s && inLane(g.lane, u));
    if (!ahead) return false;
    const rank = this.smashRank();
    const blocked = (lane: number) => {
      if (!this.track.laneUsable(lane, g.s)) return true;
      if (units.some((u) => Math.abs(u.s - g.s) < u.hl + 4 && inLane(lane, u))) return true;
      return this.track.propsBetween(g.s - 3, g.s + 4).some((p) => this.rankOf(p) > rank && inLane(lane, p));
    };
    return blocked(g.lane - 1) && blocked(g.lane + 1);
  }

  /** Forks: open on schedule on a highway; at the gore, the rightmost lane takes the exit. */
  private stepFork() {
    const F = TUNING.forks;
    const g = this.giant;
    const now = this.time + this.dt;
    if (!this.fork && this.forksOpened < F.at.length && now >= F.at[this.forksOpened] && now < F.lastAt && !this.exit) this.openFork();
    if (!this.fork || g.s < this.fork.gore) return;
    const f = this.fork;
    const onRamp = this.onRampLane(f.gore);
    if (!onRamp && g.s < f.gore + this.lateTake()) return; // still time to steer onto it
    this.fork = null;
    if (!onRamp) {
      this.emit({ type: 'fork', taken: false, zone: f.zone, name: f.name, from: -1, shaken: 0 });
      return;
    }
    // Taken: the road from here on becomes the avenue, from the segment under him.
    const from = this.track.segmentAt(g.s).index;
    this.track.branch(from, f.zone, f.name, g.s + F.propsAfter);
    this.track.ensure(g.s + TUNING.track.aheadDistance);
    const lane = Math.min(g.lane, this.track.lanesAt(g.s) - 1);
    g.lane = g.prevLane = g.moveFromLane = lane;
    g.d = g.moveToD = g.moveFromD = this.track.laneCenter(lane);
    g.move = null;
    g.moveT = 1;
    g.laneQueue = 0;
    // The police can't follow him off the highway: every unit goes, and each one that engaged is shaken.
    const shaken = this.pursuit.loseAll();
    this.emit({ type: 'fork', taken: true, zone: f.zone, name: f.name, from, shaken });
    this.emit({ type: 'zone', zone: f.zone, name: f.name });
  }

  private openFork() {
    const F = TUNING.forks;
    const g = this.giant;
    const X = TUNING.segment;
    if (this.track.segmentAt(g.s).zone !== 'highway') return; // try again on the next highway stretch
    const want = clamp(g.speed * 12, F.distance[0], F.distance[1]);
    this.track.ensure(g.s + F.distance[1] + 80);
    const seg = this.track.segments.find((sg) => sg.s0 >= g.s + want && sg.s0 <= g.s + F.distance[1] && this.track.forkEligible(sg));
    if (!seg) return;
    // Never near the sign-off: the exit opens at 130s, roughly this far on.
    const toExit = (X.exitOpensAt - this.time) * g.speed;
    if (toExit < F.clearOfExit + F.distance[1]) {
      this.forksOpened = F.at.length;
      return;
    }
    this.forksOpened++;
    const name = this.track.forkName('avenue');
    seg.fork = { zone: 'avenue', name };
    const gore = seg.s0 + X.goreAt;
    const lane = this.track.lanesAt(gore) - 1;
    const c = this.track.laneCenter(lane);
    for (const p of this.track.propsBetween(gore - X.exitClear, gore + 6)) if (Math.abs(p.d - c) < p.hw + 1.2) p.alive = false;
    this.fork = { gore, segment: seg.index, zone: 'avenue', name };
    this.emit({ type: 'forkOpen', s: gore, segment: seg.index, zone: 'avenue', name });
  }

  /** v0.3 §4: the exit ramp opens at 130s; be in the rightmost lane at the gore to sign off. */
  private exitPlanned = false;
  private stepExit() {
    if (this.endless) return; // endless: no sign-off, no fuel; it ends when he's caught or cut
    const X = TUNING.segment;
    const g = this.giant;
    const now = this.time + this.dt;
    // Plan the ramp's stretch of road before it's generated (the road exists `aheadDistance` ahead), from
    // where he'll be when it opens: keep it ramp-friendly so the exit always lands in reach.
    // Story run (prototype): the exit opens by distance, at the end of the last district; fuel is the clock.
    const story = TUNING.proto.on;
    if (story) {
      // The finale's last word (Mike, 2026-11-24): a police roadblock between him and the sign-off (Rampage it, or take
      // the gap). Queued well before the exit opens so it lands even when a blockade is still out ahead.
      if (!this.finaleQueued && TUNING.difficulty.finaleRoadblock && this.track.courseEnd < Infinity && g.s >= this.track.courseEnd - TUNING.proto.finaleAt) {
        this.finaleQueued = true;
        this.pursuit.spawnFinale();
      }
      if (!this.exit && this.track.courseEnd < Infinity && g.s >= this.track.courseEnd - 400 && now < X.length + X.grace) this.openExit();
    } else if (!this.exitPlanned && now >= X.exitOpensAt - X.planAhead) {
      this.exitPlanned = true;
      // Planned at Stride pace (the base gear): planned mid-Rampage, it landed out of reach at Stride later.
      const at = Math.max(this.track.end, g.s + Math.min(g.speed, TUNING.tiers[1].topSpeed) * X.planAhead + X.exitDistance[0] - 30);
      this.track.reserveExit(at, at + X.planLength);
    }
    if (!story && !this.exit && !this.fork && now >= X.exitOpensAt && now < X.length + X.grace) {
      this.openExit();
      // Difficulty curve: the last segment's way out runs through a police roadblock (Rampage it, or take the gap).
      if (this.exit && TUNING.difficulty.finaleRoadblock && this.show.segment >= TUNING.run.segments - 1) this.pursuit.spawnFinale();
    }
    if (this.exit && g.s >= this.exit.gore) {
      if (this.onRampLane(this.exit.gore)) {
        const n = this.events.length;
        this.show.clear(this.events);
        this.observeShowEvents(n);
        return;
      }
      if (g.s >= this.exit.gore + this.lateTake()) {
        this.emit({ type: 'exitMissed', s: this.exit.gore });
        this.exit = null;
      }
    }
    if (now >= X.length + X.grace) this.show.bust('missed', this.events);
  }

  /**
   * In the ramp's lane (the rightmost at the gore)? A wall bump there counts: pressing toward the
   * ramp while already hugging it is exactly what a player does (it used to count as a miss).
   * A lane change already under way counts too (its target lane is his lane).
   */
  private onRampLane(gore: number): boolean {
    return this.giant.lane === this.track.lanesAt(gore) - 1;
  }

  /** How far past the gore a late move onto the ramp still takes it (m). */
  private lateTake(): number {
    return this.giant.speed * TUNING.segment.lateTake;
  }

  private openExit() {
    const X = TUNING.segment;
    const g = this.giant;
    // Reachable even at Jog: 12s of running, within the §4 150–250m window.
    const want = clamp(g.speed * 12, X.exitDistance[0], X.exitDistance[1]);
    this.track.ensure(g.s + X.exitSearchMax + 60);
    // §4 window first; if a tunnel fills it, the nearest eligible segment after it.
    const seg =
      this.track.segments.find((sg) => sg.s0 >= g.s + want && sg.s0 <= g.s + X.exitSearchMax && this.track.exitEligible(sg)) ??
      this.track.segments.find((sg) => sg.s0 >= g.s + X.exitDistance[0] && this.track.exitEligible(sg));
    if (!seg) return;
    seg.exit = true;
    const gore = seg.s0 + X.goreAt;
    const lane = this.track.lanesAt(gore) - 1;
    const c = this.track.laneCenter(lane);
    // Clear the exit lane up to the gore and on past it while the ramp pulls away (he crosses it on the way out).
    for (const p of this.track.propsBetween(gore - X.exitClear, gore + X.exitClearAfter)) if (Math.abs(p.d - c) < p.hw + 1.2) p.alive = false;
    this.exit = { s: seg.s0, gore, segment: seg.index, lane };
    this.emit({ type: 'exitOpen', s: gore, segment: seg.index, lane });
  }

  private emit(e: SimEvent) {
    this.events.push(e);
    this.observeAsks(e);
    const st = this.stats;
    switch (e.type) {
      case 'smash': {
        st.smashes++;
        if (e.across) st.smashesAcross++;
        // A rival station's van: the big one (its own stunt, Ratings and meter, and an event for the asks and the HUD).
        const rival = e.propId < 1_000_000 && this.track.props.find((x) => x.id === e.propId)?.kind === 'newsvan';
        const scoop = e.propId < 1_000_000 && this.track.props.find((x) => x.id === e.propId)?.kind === 'scoop';
        if (scoop) {
          this.award('scoop');
          this.emit({ type: 'scoop', s: e.s, d: e.d });
          this.stunt('scoop');
          break;
        }
        const bounty = e.propId < 1_000_000 && this.track.props.find((x) => x.id === e.propId)?.bounty;
        if (bounty) {
          // Target car: its own bonus, Rampage doubles it (on top of Rampage's double score).
          const X = TUNING.proto.target;
          const ramp = this.inRampage;
          this.award('target');
          this.emit({ type: 'target', s: e.s, d: e.d, rampage: ramp });
          this.stunt('target', X.score * (ramp ? X.rampMult : 1));
          break;
        }
        if (rival) {
          this.award('rival');
          this.emit({ type: 'rival', s: e.s, d: e.d });
        } else if (e.cls === 'medium' || e.cls === 'heavy') this.award(e.cls);
        // Spectacle: a police car he flattened, else the class; smash-across pays a bonus.
        // Police units are ids ≥ 1,000,000; the car carrier is traffic, so it scores as a Heavy smash.
        const unit = e.propId >= 1_000_000 && this.pursuit.units.find((x) => x.id === e.propId)?.unit !== 'carrier';
        const cause = rival ? 'rival' : unit ? 'unit' : e.cls === 'heavy' ? 'heavy' : e.cls === 'medium' ? 'medium' : null;
        if (cause) this.stunt(cause, e.across ? TUNING.spectacle.points[cause] * TUNING.spectacle.acrossBonus : undefined);
        break;
      }
      case 'bounce':
        st.bounces++;
        this.show.endChain(true, this.events);
        break;
      case 'spiked': this.show.endChain(true, this.events); break;
      case 'ram':
        if (e.hit) this.show.endChain(true, this.events);
        else this.stunt('ramDodge');
        break;
      case 'nearMiss': this.stunt('nearMiss'); break;
      // The chopper losing him isn't something he did (Mike, 2026-11-24): no stunt for it in the pivot loop.
      case 'lostTrack': if (e.kind !== 'chopper') this.stunt('lostTrack'); else if (!TUNING.proto.on) this.stunt('chopperShaken'); break;
      case 'policeCrash': if (e.onAir) this.stunt('policeCrash'); break;
      case 'policeSmash': this.stunt('collateral'); break;
      case 'leapLand': if (e.smashed > 0) this.stunt('leapLand'); break;
      case 'breakawayLand': this.stunt('breakawayLand'); break;
      case 'wallBump': st.wallBumps++; break;
      case 'laneChange': st.laneChanges++; break;
      case 'tierUp': st.tierUps++; break;
      case 'tierDown': st.tierDowns++; break;
      case 'footfall': st.footfalls++; break;
      case 'merge': st.merges++; break;
    }
  }

  /** A prop's rank against his: rampOnly things (concrete, police roadblocks) count as unbreakable outside Rampage. */
  rankOf(p: Prop): number {
    // Prototype: a rival station's van is the one vehicle he goes for in Stride.
    // ...and a Rolling Blockade's weak link (the compact) gives way, so a blockade across a 2-lane road is never a wall.
    if (TUNING.proto.on && (p.bounty || p.kind === 'newsvan' || (p.kind === 'compact' && (p as Unit).unit === 'rolling') || (TUNING.proto.small as readonly string[]).includes(p.kind))) return CLASS_RANK.light;
    return p.rampOnly && !this.inRampage && this.giant.shoulderT <= 0 ? CLASS_RANK.immovable : CLASS_RANK[p.cls];
  }

  /** In Rampage (the burst), not just at top speed. */
  get inRampage(): boolean {
    return this.giant.rampT > 0;
  }

  /** The Rampage button: fires a full meter. In Rampage, the clock runs down; smashes add to it (capped). */
  private rampBuffer = 0;
  private stepRampage(input: SimInput, dt: number) {
    const g = this.giant;
    const R = TUNING.rampage;
    if (input.shoulder) this.rampBuffer = R.bufferFrames;
    if (this.rampBuffer > 0) {
      if (g.meter >= 100 && !this.inRampage) {
        this.rampBuffer = 0;
        this.startRampage();
      } else this.rampBuffer--;
    }
    if (this.inRampage) {
      g.rampElapsed += dt;
      g.rampT = Math.max(0, g.rampT - dt);
      if (g.rampT === 0) this.endRampage();
    }
  }

  /** Fire Rampage (the button with a full meter, or Breakaway III's landing). */
  private startRampage() {
    const g = this.giant;
    g.meter = 0;
    g.sprint = 1;
    g.rampT = TUNING.rampage.duration + (this.upgrades.has('overdrive') ? TUNING.passives.overdriveTime : 0);
    g.rampElapsed = 0;
    this.setTier(TUNING.tiers.length - 1);
    this.emit({ type: 'rampageStart', time: g.rampT });
    // The surge: the road ahead (past the frame) fills up, rival vans and all.
    const T = TUNING.targets;
    this.track.ensure(g.s + T.ahead + T.length + 10);
    this.track.surge(g.s + T.ahead, g.s + T.ahead + T.length);
    // ...but never into a Car Carrier's or Rolling Blockade's lane (they'd drive through the new traffic).
    for (const u of this.pursuit.units) {
      if (!u.alive || (u.unit !== 'carrier' && u.unit !== 'rolling')) continue;
      const c = this.track.laneCenter(u.lane);
      for (const p of this.track.propsBetween(g.s + T.ahead - 2, g.s + T.ahead + T.length + 2)) if (Math.abs(p.d - c) < p.hw + 1.4) p.alive = false;
    }
    // Ground Zero: going Rampage flattens everything around him (bulldozers and police included).
    if (this.upgrades.has('groundZero')) this.emit({ type: 'groundZero', s: g.s, d: g.d, smashed: this.slam(TUNING.passives.groundZeroRadius, true) });
  }

  private endRampage() {
    const g = this.giant;
    g.rampT = 0;
    g.meter = this.upgrades.has('secondWind') ? TUNING.rampage.secondWindKeep : 0;
    if (TUNING.proto.on) {
      this.show.ratings = Math.min(this.show.ratings, TUNING.proto.afterRampage + (this.upgrades.has('secondWind') ? 15 : 0));
      g.meter = this.show.ratings;
    }
    this.setTier(1, 'rampageEnd');
    this.emit({ type: 'rampageEnd' });
  }

  /** A stunt in Stride fills the meter; in Rampage a smash keeps it going a little longer (capped). */
  private fillMeter(cause: StuntType) {
    const g = this.giant;
    const R = TUNING.rampage;
    if (this.inRampage) {
      const cap = R.maxDuration + (this.upgrades.has('overdrive') ? TUNING.passives.overdriveTime : 0);
      if (cause === 'medium' || cause === 'heavy' || cause === 'unit') g.rampT = Math.min(g.rampT + R.perSmash, Math.max(0, cap - g.rampElapsed));
      return;
    }
    if (g.meter >= 100 || TUNING.proto.on) return; // prototype: the audience is the meter (synced each step)
    const D = TUNING.difficulty;
    // Guided first broadcast: the meter fills faster in the calm opening, so the first Rampage lands while it's calm.
    const teach = this.guided && this.time < TUNING.guided.calmFor ? TUNING.guided.meterGain : 1;
    let add = teach * (R.gain[cause] ?? 0) * this.edition.meter * D.meterGain[Math.min(this.show.segment, D.meterGain.length - 1)] * (this.upgrades.has('shortFuse') ? TUNING.passives.shortFuseMult : 1);
    // Shoulder Check III: smashes in the charge fill the meter too.
    if (g.shoulderT > 0 && this.levelOf('shoulder') >= 3 && (cause === 'medium' || cause === 'heavy' || cause === 'unit')) add += TUNING.abilities.shoulder.meterPerSmash;
    g.meter = Math.min(100, g.meter + add);
    if (g.meter >= 100) this.emit({ type: 'meterFull' });
  }

  /**
   * What used to cost a gear: a bounce, spikes, a slipped Net, the police shaken off. In Stride it costs
   * meter (Thick Skin shrugs off the first); in Rampage only being caught or slipping a Net ends it.
   */
  private hit(reason: TierDropReason) {
    const g = this.giant;
    if (this.inRampage) {
      if (reason === 'slip') this.endRampage();
      return;
    }
    if (reason === 'impact' && g.skin > 0) {
      g.skin--;
      this.emit({ type: 'thickSkin', left: g.skin });
      return;
    }
    g.sprint = 0;
    if (TUNING.proto.on) {
      // Police on his tail: a hit is a bump from behind, and the CAUGHT meter takes a chunk.
      const P = TUNING.proto;
      const tail = this.pursuit.units.some((u) => u.alive && u.unit === 'cruiser' && !u.lost && u.phase !== 'leave' && g.s - u.s >= 0 && g.s - u.s <= P.tail)
        || this.escort.cruisers.some((c) => c.active && g.s - c.s >= 0 && g.s - c.s <= P.tail);
      if (tail && reason === 'impact') {
        this.show.pin = Math.min(99.9, this.show.pin + P.hitPin);
        this.show.pinCause = 'caught';
      }
      // Prototype: one bar, so a hit costs audience (it can cut to commercial).
      const before = this.show.ratings;
      this.show.ratings = Math.max(0, this.show.ratings - TUNING.proto.hitAudience * this.modProduct('hit'));
      g.meter = this.show.ratings;
      if (before > g.meter) this.emit({ type: 'meterLoss', amount: before - g.meter, reason });
      return;
    }
    const before = g.meter;
    g.meter = Math.max(0, g.meter - TUNING.rampage.bounceCost);
    if (before > g.meter) this.emit({ type: 'meterLoss', amount: before - g.meter, reason });
  }

  private setTier(tier: number, reason?: TierDropReason) {
    const g = this.giant;
    const next = clamp(tier, 0, TUNING.tiers.length - 1);
    if (next === g.tier) return;
    const up = next > g.tier;
    g.tier = next;
    g.tierTimer = 0;
    g.peakTier = Math.max(g.peakTier, next);
    if (up) this.emit({ type: 'tierUp', tier: next });
    else this.emit({ type: 'tierDown', tier: next, reason: reason ?? 'impact' });
  }



  // --- Lanes ---------------------------------------------------------------

  private stepLanes(input: SimInput) {
    const g = this.giant;
    const dir = Math.sign(input.lane);
    if (dir !== 0) {
      if (g.move !== null) {
        g.laneQueue = dir; // one queued input max: the newest wins
      } else if (g.stumble > 0) {
        g.laneBufferDir = dir;
        g.laneBufferFrames = TUNING.lanes.bufferFrames;
      } else {
        this.startLaneChange(dir, false);
      }
    } else if (g.laneBufferFrames > 0) {
      if (g.move === null && g.stumble <= 0) {
        const d = g.laneBufferDir;
        g.laneBufferFrames = 0;
        this.startLaneChange(d, false);
      } else {
        g.laneBufferFrames--;
      }
    }

    // A merge closing the giant's lane: the wall bounces it into the next lane, no stumble.
    // Also mid wall bump: tapping toward the wall used to chain bumps and keep him in a lane that had closed.
    if ((g.move === null || g.move === 'wallBump') && !this.track.laneUsable(g.lane, g.s + 3)) {
      const target = Math.max(0, Math.min(g.lane - 1, this.track.lanesAt(g.s + 3) - 1));
      this.beginMove('change', target, this.tierTuning.laneChangeTime);
      this.emit({ type: 'wallBump', dir: 1, forced: true });
    }
  }

  private startLaneChange(dir: number, _queued: boolean) {
    const g = this.giant;
    const target = g.lane + dir;
    if (!this.track.laneUsable(target, g.s) || !this.track.laneUsable(target, g.s + 4)) {
      // Into the wall: bump out and back, no stumble, no tier loss.
      g.move = 'wallBump';
      g.moveT = 0;
      g.moveDur = this.tierTuning.laneChangeTime;
      g.moveFromD = g.d;
      g.moveToD = this.track.laneCenter(g.lane);
      g.moveFromLane = g.lane;
      g.bumpDir = dir;
      this.emit({ type: 'wallBump', dir, forced: false });
      return;
    }
    g.prevLane = g.lane;
    this.beginMove('change', target, this.tierTuning.laneChangeTime);
    this.emit({ type: 'laneChange', from: g.prevLane, to: target, dur: g.moveDur });
  }

  private beginMove(kind: 'change' | 'knock', toLane: number, dur: number) {
    const g = this.giant;
    g.move = kind;
    g.moveT = 0;
    g.moveDur = dur;
    g.moveFromD = g.d;
    g.moveFromLane = g.lane;
    g.moveToD = this.track.laneCenter(toLane);
    g.lane = toLane;
    g.bumpDir = 0;
  }

  private stepLateral(dt: number) {
    const g = this.giant;
    if (g.move === null) {
      // Settle exactly on the lane centre (merges don't move lane centres).
      g.d = this.track.laneCenter(g.lane);
      return;
    }
    g.moveT = Math.min(1, g.moveT + dt / g.moveDur);
    const e = smoothstep(g.moveT);
    if (g.move === 'wallBump') {
      g.d = g.moveToD + g.bumpDir * TUNING.lanes.wallBumpDepth * Math.sin(Math.PI * g.moveT);
    } else {
      g.d = g.moveFromD + (g.moveToD - g.moveFromD) * e;
    }
    if (g.moveT >= 1) {
      g.move = null;
      g.d = g.moveToD;
      if (g.laneQueue !== 0) {
        const q = g.laneQueue;
        g.laneQueue = 0;
        if (g.stumble <= 0) this.startLaneChange(q, true);
        else {
          g.laneBufferDir = q;
          g.laneBufferFrames = TUNING.lanes.bufferFrames;
        }
      }
    }
  }

  // --- Phase 3 abilities -------------------------------------------------------

  private stepAbility(input: SimInput, dt: number) {
    const g = this.giant;
    const A = TUNING.abilities;
    g.abilityCd = Math.max(0, g.abilityCd - dt);
    g.ability2Cd = Math.max(0, g.ability2Cd - dt);
    g.shoulderT = Math.max(0, g.shoulderT - dt);
    if (g.prime > 0) {
      g.prime = Math.max(0, g.prime - dt);
      if (g.prime === 0) {
        this.show.prime = false;
        this.emit({ type: 'primeTime', on: false, time: 0 });
      }
    }
    if (g.air > 0) {
      g.air = Math.max(0, g.air - dt);
      // Never land inside something he can't flatten (a bulldozer, an armored truck): carry on over it.
      if (g.air === 0 && g.airDur - 0 < A.landExtendMax + (g.airKind === 'breakaway' ? A.breakaway.time[this.levelOf('breakaway') - 1] : A.leap.time[this.levelOf('leap') - 1]) && this.landingBlocked()) {
        g.air = dt;
        g.airDur += dt;
      }
      if (g.air === 0) {
        if (g.airKind === 'breakaway') this.breakawayLand();
        else this.leapLand();
      }
    }
    if (input.ability) g.abilityBuffer = A.bufferFrames;
    if (input.ability2) g.ability2Buffer = A.bufferFrames;
    // Slot 1 then slot 2, each with its own buffer and cooldown (an airborne ability blocks both until it lands).
    if (g.abilityBuffer > 0 && this.ability) {
      if (g.abilityCd > 0 || g.stumble > 0 || g.air > 0) {
        // The press ran out its buffer while he couldn't: tell him (a dud).
        if (--g.abilityBuffer === 0) this.emit({ type: 'ability', id: this.ability, ok: false, level: this.levelOf(this.ability), slot: 1 });
      }
      else {
        g.abilityBuffer = 0;
        g.abilityCd = this.fire(this.ability);
        this.emit({ type: 'ability', id: this.ability, ok: true, level: this.levelOf(this.ability), slot: 1 });
      }
    }
    if (g.ability2Buffer > 0 && this.ability2) {
      if (g.ability2Cd > 0 || g.stumble > 0 || g.air > 0) {
        // The press ran out its buffer while he couldn't: tell him (a dud).
        if (--g.ability2Buffer === 0) this.emit({ type: 'ability', id: this.ability2, ok: false, level: this.levelOf(this.ability2), slot: 2 });
      }
      else {
        g.ability2Buffer = 0;
        g.ability2Cd = this.fire(this.ability2);
        this.emit({ type: 'ability', id: this.ability2, ok: true, level: this.levelOf(this.ability2), slot: 2 });
      }
    }
  }

  /** Fire an ability; returns its cooldown. */
  private fire(id: AbilityId): number {
    const g = this.giant;
    const A = TUNING.abilities;
    const L = this.levelOf(id) - 1; // index into the per-level numbers
    if (id === 'leap') {
      g.air = g.airDur = A.leap.time[L];
      g.airKind = 'leap';
      return A.leap.cooldown;
    } else if (id === 'stare') {
      this.stare();
      return A.stare.cooldown;
    } else if (id === 'breakaway') {
      g.air = g.airDur = A.breakaway.time[L];
      g.airKind = 'breakaway';
      return A.breakaway.cooldown;
    } else if (id === 'primeTime') {
      g.prime = A.primeTime.time[L];
      this.show.prime = true;
      this.emit({ type: 'primeTime', on: true, time: g.prime });
      return A.primeTime.cooldown;
    }
    // Shoulder Check (the ability): a short charge that breaks concrete and police lines (rankOf), never bulldozers.
    g.shoulderT = A.shoulder.time[L];
    g.speed += A.shoulder.burst;
    this.emit({ type: 'shoulder', s: g.s, d: g.d });
    return A.shoulder.cooldown;
  }

  /** Would he land inside something the landing can't flatten? */
  private landingBlocked(): boolean {
    const g = this.giant;
    const r = this.radius();
    const all = g.airKind === 'leap' && this.levelOf('leap') >= 3;
    const near: Prop[] = [...this.track.propsBetween(g.s - r - 4, g.s + r + 4), ...this.pursuit.solidBetween(g.s - r - 4, g.s + r + 4)];
    return near.some((p) => p.alive && (this.rankOf(p) === CLASS_RANK.immovable || (p as Unit).ram) && !all && Math.abs(p.s - g.s) < p.hl + r && Math.abs(p.d - g.d) < p.hw + r);
  }

  /** A landing shockwave: smashes everything within `R` up to Heavy (or anything, `all`), never landing inside a car. */
  private slam(R: number, all: boolean): number {
    const g = this.giant;
    let smashed = 0;
    const near: Prop[] = [...this.track.propsBetween(g.s - R - 3, g.s + R + 3), ...this.pursuit.solidBetween(g.s - R - 3, g.s + R + 3)];
    for (const p of near) {
      if (!p.alive || (!all && CLASS_RANK[p.cls] > CLASS_RANK.heavy)) continue;
      const ds = Math.max(0, Math.abs(p.s - g.s) - p.hl);
      const dd = Math.max(0, Math.abs(p.d - g.d) - p.hw);
      if (Math.hypot(ds, dd) > R) continue;
      p.alive = false;
      smashed++;
      this.emit({ type: 'smash', propId: p.id, cls: p.cls === 'immovable' ? 'heavy' : p.cls, mat: p.mat, s: p.s, d: p.d, across: false, speed: g.speed });
    }
    return smashed;
  }

  /** Leap landing: the shockwave (III flattens anything, armored trucks and bulldozers too). */
  private leapLand() {
    const g = this.giant;
    const L = this.levelOf('leap') - 1;
    const smashed = this.slam(TUNING.abilities.leap.shockRadius[L], L >= 2);
    this.emit({ type: 'leapLand', s: g.s, d: g.d, smashed });
  }

  /** Breakaway landing: a slam, every police car behind him loses track, and at III he lands in Rampage. */
  private breakawayLand() {
    const g = this.giant;
    const L = this.levelOf('breakaway') - 1;
    const smashed = this.slam(TUNING.abilities.breakaway.shockRadius[L], false);
    g.speed = Math.min(g.speed, this.tierTuning.topSpeed); // the landing takes the dive's extra speed
    const shaken = this.pursuit.loseAllBehind();
    if (L >= 2 && !this.inRampage) this.startRampage();
    this.emit({ type: 'breakawayLand', s: g.s, d: g.d, smashed, shaken });
  }

  /**
   * The Stare: the road parts. Traffic ahead in his lane pulls over, and traffic in the lanes
   * either side moves one lane further out (where it's free), so an open strip runs ahead of him.
   * Police winding up back off.
   */
  private stare() {
    const g = this.giant;
    const A = TUNING.abilities.stare;
    const W = TUNING.lanes.width;
    const moved: { id: number; from: number; to: number }[] = [];
    const myC = this.track.laneCenter(g.lane);
    const free = (p: Prop, c: number) =>
      ![...this.track.propsBetween(p.s - p.hl - 3, p.s + p.hl + 3), ...this.pursuit.solidBetween(p.s - p.hl - 3, p.s + p.hl + 3)].some((q) => q !== p && q.alive && Math.abs(q.d - c) < q.hw + p.hw + 0.4);
    // Nearest lanes first, so a car next to him can move out before one in his lane moves in beside it.
    const props = this.track.propsBetween(g.s, g.s + A.reach[this.levelOf('stare') - 1]).filter((p) => p.alive && this.rankOf(p) !== CLASS_RANK.immovable && Math.abs(p.d - myC) <= W * A.lanesEitherSide + p.hw);
    props.sort((a, b) => Math.abs(b.d - myC) - Math.abs(a.d - myC));
    for (const p of props) {
      const lanes = this.track.lanesAt(p.s);
      const off = Math.round((p.d - myC) / W);
      const dirs = off === 0 ? [1, -1] : [Math.sign(off)];
      for (const dir of dirs) {
        const lane = g.lane + off + dir;
        if (lane < 0 || lane >= lanes) continue;
        const c = this.track.laneCenter(lane);
        if (!free(p, c)) continue;
        moved.push({ id: p.id, from: p.d, to: c });
        p.d = c;
        break;
      }
    }
    const backedOff = this.pursuit.backOff();
    // III: the ones that lose their nerve lose the road too.
    const crashed = this.levelOf('stare') >= 3 ? this.pursuit.crashBackedOff() : 0;
    this.emit({ type: 'stare', moved, backedOff, crashed });
  }

  // --- Speed and gait ----------------------------------------------------------

  private stepSpeed(input: SimInput, dt: number) {
    const g = this.giant;
    const tier = this.tierTuning;
    // Prototype sprint: clean running builds it; a hit or the brake resets it.
    if (TUNING.proto.on) {
      if (input.brake || g.stumble > 0) g.sprint = 0;
      else g.sprint = Math.min(1, g.sprint + dt / TUNING.proto.sprintBuild);
    }
    const top = tier.topSpeed + (g.shoulderT > 0 ? TUNING.abilities.shoulder.burst : 0) + (TUNING.proto.on ? g.sprint * TUNING.proto.sprintBonus : 0);
    // In the air (Leap, Breakaway) the brake does nothing.
    const brake = input.brake && g.air <= 0;
    g.braking = brake;
    if (brake) {
      g.speed -= TUNING.brake.decel * dt;
      g.brakeHeld += dt;
      g.tierTimer = 0;
      // Rampage loop: braking never costs a gear (Stride is the floor; Rampage runs its clock).
      if (g.brakeHeld > TUNING.tierDrop.brakeHold) g.brakeHeld = 0;
    } else {
      g.brakeHeld = 0;
      if (g.stumble > 0) {
        // No acceleration while stumbling: a wobble, not a stop.
      } else if (g.speed < top) {
        g.speed = Math.min(top, g.speed + tier.accel * dt);
      } else if (g.speed > top) {
        g.speed = Math.max(top, g.speed - TUNING.giant.overspeedDecel * dt);
      }
    }
    g.speed = Math.max(TUNING.giant.speedFloor, g.speed); // LOCKED Law 1
    g.stumble = Math.max(0, g.stumble - dt);

    const t = this.tierTuning;
    if (!brake && g.stumble <= 0 && g.speed >= t.topSpeed * TUNING.giant.topSpeedEpsilon) {
      g.tierTimer += dt;
      const after = this.tierUpAfter();
      if (g.tierTimer >= after) this.setTier(g.tier + 1);
    }
    // Breakaway: the dive carries him `boost` m/s over his gear's top speed (he settles back after landing).
    if (g.air > 0 && g.airKind === 'breakaway') g.speed = Math.max(g.speed, t.topSpeed + TUNING.abilities.breakaway.boost);
  }

  private advance(dt: number) {
    const g = this.giant;
    const ds = g.speed * dt;
    g.s += ds;
    g.odometer += ds;
    // Phase locked to distance: each step covers stepLen metres.
    g.stepLen = stepLengthAt(g.speed);
    const rate = ds / g.stepLen; // steps this tick
    const before = g.stepPos;
    g.stepPos += rate;
    const crossed = Math.floor(g.stepPos) - Math.floor(before);
    for (let k = 1; k <= crossed; k++) {
      const step = Math.floor(before) + k;
      // Exact sub-tick time of the plant, for cadence measurement.
      const frac = (step - before) / rate;
      this.emit({
        type: 'footfall',
        tier: g.tier,
        foot: (step & 1) as 0 | 1,
        step,
        t: this.time + frac * dt,
        s: g.s,
        d: g.d,
        speed: g.speed,
        stepLen: g.stepLen,
      });
    }
  }

  // --- Collisions ------------------------------------------------------------------

  /** Heaviest class the giant smashes right now (Shoulder Check lifts one class, never Immovable). */
  smashRank(): number {
    const g = this.giant;
    // Rampage loop: in Rampage he runs through everything, bulldozers and police included.
    if (this.inRampage) return CLASS_RANK.immovable;
    // Prototype: dodge in Stride; only light things break underfoot (a Shoulder Check still lifts it one class).
    if (TUNING.proto.on) return Math.min(CLASS_RANK.light + (g.shoulderT > 0 ? 1 : 0), CLASS_RANK.heavy);
    const base = this.tierTuning.smashes ? CLASS_RANK[this.tierTuning.smashes] : -1;
    return Math.min(base + (g.shoulderT > 0 ? 1 : 0), CLASS_RANK.heavy);
  }

  /** Is `lane` free of things the giant can't smash over [s0, s1]? */
  laneClear(lane: number, s0: number, s1: number, moving = true): boolean {
    if (!this.track.laneUsable(lane, s0) || !this.track.laneUsable(lane, s1)) return false;
    const c = this.track.laneCenter(lane);
    const r = this.radius();
    const rank = this.smashRank();
    for (const p of this.track.propsBetween(s0, s1)) {
      if (this.rankOf(p) <= rank) continue;
      if (Math.abs(p.d - c) < p.hw + r) return false;
    }
    for (const u of this.pursuit.solidBetween(s0, s1)) {
      if (this.rankOf(u) <= rank) continue;
      // Knock-backs ignore moving police cars: he shoves past them, so a lane is never sealed by traffic.
      if (!moving && (u.unit === 'cruiser' || u.unit === 'rolling')) continue;
      if (Math.abs(u.d - c) < u.hw + r) return false;
    }
    return true;
  }

  private collide() {
    const g = this.giant;
    if (g.air > 0) return; // Leap: airborne over everything
    const r = this.radius();
    const rank = this.smashRank();
    const near: Prop[] = this.track.propsBetween(g.s - r - 4, g.s + r + 4, this.near);
    for (const u of this.pursuit.solidBetween(g.s - r - 6, g.s + r + 6)) near.push(u);
    for (const p of near) {
      if (!p.alive) continue;
      const cs = clamp(g.s, p.s - p.hl, p.s + p.hl);
      const cd = clamp(g.d, p.d - p.hw, p.d + p.hw);
      const ds = g.s - cs;
      const dd = g.d - cd;
      // Crush reach (Mike, 2026-11-24: Rampage didn't break every car he ran through; some yellow items survived):
      // what he CAN smash breaks within his drawn body, a little wider than the hit-box. Only ever smashes more.
      const C = TUNING.collision;
      const reach = Math.max(r, this.inRampage ? C.rampageReach : 0, p.cls === 'light' ? C.lightReach : 0);
      const d2 = ds * ds + dd * dd;
      if (d2 >= reach * reach) continue;
      const inBody = d2 < r * r;

      // A Police Net flanker breaks only to a Shoulder Check (then it's Heavy); otherwise nothing moves it.
      const u = p as Unit;
      // A cruiser mid-ram is driving into him: it can't be shrugged off at Rampage (only a Shoulder Check flattens it).
      const ramming = u.unit === 'cruiser' && u.phase === 'act' && this.giant.shoulderT <= 0 && (TUNING.pursuit.cruiser.ramBeatsRampage || !this.inRampage);
      const pr = ramming ? CLASS_RANK.immovable : u.ram && this.giant.shoulderT > 0 ? CLASS_RANK.heavy : this.rankOf(p);
      if (pr <= rank) {
        // Smash, forward or across: the same class rule either way (v0.3 smash-across).
        p.alive = false;
        g.speed = Math.max(TUNING.giant.speedFloor, g.speed * (1 - TUNING.collision.smashSpeedLoss[p.cls]));
        const across = g.move === 'change' && Math.abs(g.d - p.d) > 0.4;
        this.emit({ type: 'smash', propId: p.id, cls: p.cls, mat: p.mat, s: p.s, d: p.d, across, speed: g.speed });
        continue;
      }
      if (!inBody) continue; // within reach but unbreakable: only the hit-box itself can hit it

      // Can't smash it. Clear the overlap along the road (never through it). A moving unit
      // that swerved into him shoves him sideways instead (knock-back below), no jump back.
      const unit = (p as Unit).unit;
      const moving = unit === 'cruiser' || unit === 'rolling';
      // Only a head-on hit pushes him back along the road. A side-on one (a lane change into it) knocks him
      // sideways only: pushing him back too let repeated attempts stall him (Law 1: he never stops).
      const headOn = Math.abs(g.d - p.d) < p.hw + r * 0.5;
      if (!moving && headOn && g.s < p.s) {
        g.s = Math.min(g.s, p.s - p.hl - Math.sqrt(Math.max(0, r * r - dd * dd)) - 0.01);
        // Held behind a police vehicle (a Net's truck braking into him): he's going its speed now, never below the floor.
        if (unit) g.speed = Math.max(TUNING.giant.speedFloor, Math.min(g.speed, (p as Unit).speed));
      }
      if (unit) (p as Unit).hit = true;
      if (p.mover) p.mover.v = 0; // moving traffic he runs into stops dead (no pushing into him every frame)
      p.judged = true; // touched it: never a dodge
      if (g.stumble > 0 || g.move === 'knock') continue; // already reeling: no double penalty

      // −1 tier, 0.3s stumble, knocked back to the previous lane (v0.3).
      g.speed = Math.max(TUNING.giant.speedFloor, g.speed * TUNING.collision.bounceSpeedKeep);
      g.stumble = TUNING.tierDrop.stumbleTime;
      g.tierTimer = 0;
      g.laneQueue = 0;
      const toLane = this.knockLane(p);
      this.hit('impact');
      // Nowhere to be knocked to (something unbreakable either side) and it isn't unbreakable itself: he
      // stumbles through it instead of bouncing in place against it for good (Law 1: he never stops).
      if (toLane === g.lane && !unit && p.cls !== 'immovable' && g.move !== 'change') {
        p.alive = false;
        this.emit({ type: 'bounce', propId: p.id, cls: p.cls, s: p.s, d: p.d, toLane, speed: g.speed });
        this.emit({ type: 'smash', propId: p.id, cls: p.cls, mat: p.mat, s: p.s, d: p.d, across: false, speed: g.speed });
        continue;
      }
      this.beginMove('knock', toLane, TUNING.lanes.knockbackTime);
      this.emit({ type: 'bounce', propId: p.id, cls: p.cls, s: p.s, d: p.d, toLane, speed: g.speed });
    }
  }

  /** Where an unsmashable hit sends the giant: the previous lane, else the nearest clear one. */
  private knockLane(p: Prop): number {
    const g = this.giant;
    const s0 = g.s - 2;
    // Clear beside what he hit, not beyond it: reaching past it caught the next row and refused the one lane
    // that was open here (Mike's playtest: he bounced in place off a bulldozer until busted).
    const s1 = Math.max(p.s + p.hl, g.s) + TUNING.lanes.knockClearPast;
    const candidates: number[] = [];
    if (g.move === 'change') candidates.push(g.moveFromLane);
    candidates.push(g.prevLane);
    const here = g.lane;
    for (let k = 1; k <= TUNING.lanes.max; k++) candidates.push(here - k, here + k);
    const r0 = this.radius();
    // Never knocked into (and so through) something unbreakable right beside him: a bulldozer, an armored truck.
    const solidBeside = (lane: number) => {
      const c = this.track.laneCenter(lane);
      return this.track.propsBetween(g.s - r0 - 4, g.s + r0 + 4).some((q) => q.alive && q.cls === 'immovable' && Math.abs(q.d - c) < q.hw + 1 && Math.abs(q.s - g.s) < q.hl + r0);
    };
    // Never knocked across a lane with a police car alongside him, or a bulldozer (it would carry him through it).
    const crossesUnit = (lane: number) => {
      for (let l = Math.min(lane, here) + 1; l < Math.max(lane, here); l++) {
        if (solidBeside(l)) return true;
        const c = this.track.laneCenter(l);
        // Only a Police Net's crew walls him in; he shoves past ordinary moving police (a lane is never sealed by traffic).
        if (this.pursuit.solidBetween(g.s - 8, g.s + 8).some((u) => u.unit === 'net' && u.phase !== 'leave' && Math.abs(u.d - c) < u.hw + 1 && Math.abs(u.s - g.s) < u.hl + 4)) return true;
      }
      return false;
    };
    for (const lane of candidates) {
      if (lane === here && g.move !== 'change') continue;
      if (crossesUnit(lane)) continue;
      if (this.laneClear(lane, s0, s1, false)) return lane;
    }
    // Nowhere clear: never back into the lane he's in (that bounces him in place off the same thing, Law 1).
    // Take the usable side lane whose nearest blocker is farthest ahead: the most room to get past.
    let best = -1;
    let room = -Infinity;
    for (const lane of [here - 1, here + 1]) {
      if (!this.track.laneUsable(lane, g.s) || solidBeside(lane)) continue;
      const r = this.roomAhead(lane);
      if (r > room) {
        room = r;
        best = lane;
      }
    }
    // Boxed on both sides by a Police Net: he stays in his lane behind whatever stopped him. That's the box.
    // Boxed by anything else (stalled cars staggered beside and ahead of him at Jog): Law 1, he never stops.
    // He bulls through what's in front of him if it isn't a bulldozer or police; against a bulldozer, through
    // what blocks the side lane instead (the stumble and lost gear already paid for it).
    if (best >= 0 && room <= 0) {
      const force = (x: Prop) => {
        x.alive = false;
        this.emit({ type: 'smash', propId: x.id, cls: x.cls, mat: x.mat, s: x.s, d: x.d, across: false, speed: g.speed });
      };
      // A stalled car in front is never the Net's box (that's its armoured truck), even with a flanker alongside.
      if (!(p as Unit).unit && p.cls !== 'immovable' && p.alive) {
        force(p);
        return here;
      }
      if (this.pursuit.solidBetween(g.s - 10, g.s + 10).some((u) => u.unit === 'net' && u.phase !== 'leave')) return here;
      const c = this.track.laneCenter(best);
      const side = this.track.propsBetween(g.s - r0 - 4, g.s + r0 + 6).filter((x) => x.alive && Math.abs(x.d - c) < x.hw + r0);
      if (side.some((x) => x.cls === 'immovable') || this.pursuit.solidBetween(g.s - r0 - 4, g.s + r0 + 6).some((u) => Math.abs(u.d - c) < u.hw + r0 && u.phase !== 'leave' && u.unit !== 'cruiser' && u.unit !== 'rolling')) return here;
      for (const x of side) if (this.rankOf(x) > this.smashRank()) force(x);
      return best;
    }
    return best >= 0 ? best : this.track.laneUsable(g.prevLane, g.s) && !solidBeside(g.prevLane) ? g.prevLane : here;
  }

  /** Metres of lane ahead of him before something he can't smash (props and police), up to 60m. */
  private roomAhead(lane: number): number {
    const g = this.giant;
    const c = this.track.laneCenter(lane);
    const r = this.radius();
    const rank = this.smashRank();
    let room = 60;
    // Only what's beside him or ahead counts: something ending behind his shoulders isn't in the way.
    const inWay = (x: Prop) => this.rankOf(x) > rank && Math.abs(x.d - c) < x.hw + r && x.s + x.hl > g.s - r;
    for (const p of this.track.propsBetween(g.s - 6, g.s + 60)) if (inWay(p)) room = Math.min(room, p.s - p.hl - g.s);
    // Police alongside or ahead in that lane (a Net's flanker alongside means no way out on that side).
    for (const u of this.pursuit.solidBetween(g.s - 6, g.s + 60)) if (u.unit !== 'cruiser' && u.unit !== 'rolling' && u.phase !== 'leave' && inWay(u)) room = Math.min(room, u.s - u.hl - g.s);
    return room;
  }
}
