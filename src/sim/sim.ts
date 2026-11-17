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
  /** Phase 3: upgrades owned this run, and the one equipped ability (if any). */
  readonly upgrades: Set<UpgradeId>;
  readonly ability: AbilityId | null;
  /** The equipped ability's level (1–3; 0 with none). */
  readonly abilityLevel: number;
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

  constructor(opts: SimOptions) {
    this.seed = opts.seed;
    this.growth = opts.growth ?? false;
    this.rng = new Rng(opts.seed ^ 0x51ed);
    this.track = new Track(opts.seed, opts.segment ?? 0);
    this.escort = new Escort(opts.seed, this.track);
    this.pursuit = new Pursuit(opts.seed, this);
    this.upgrades = new Set(opts.upgrades ?? []);
    this.ability = (['leap', 'stare', 'breakaway', 'primeTime'] as AbilityId[]).find((a) => this.upgrades.has(a)) ?? null;
    this.abilityLevel = this.ability ? Math.max(1, Math.min(TUNING.maxLevel, opts.levels?.[this.ability] ?? 1)) : 0;
    this.show.startSegment(opts.segment ?? 0);
    this.asks = new Asks(opts.seed, opts.segment ?? 0, this.track);
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
    const dp = (this.giant.s - s0) * TUNING.rampage.distancePoints * TUNING.show.bankMult[this.giant.tier];
    this.show.banked += dp;
    this.stats.distancePoints += dp;
    this.stepLateral(dt);
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
    this.show.step(dt, this.time + dt, this.giant.tier, outnumbered, this.events);
    for (const id of this.escort.step(dt, this.time, this.giant)) {
      const c = this.escort.cruisers[id];
      this.emit({ type: 'escortJoin', id, behind: this.giant.s - c.s });
    }
    this.track.ensure(this.giant.s + TUNING.track.aheadDistance);
    if ((this.tick & 63) === 0) this.track.prune(this.giant.s);
    const g = this.giant;
    this.stats.timeAtTier[g.tier] += dt;
    this.stats.minSpeed = Math.min(this.stats.minSpeed, g.speed);
    this.tick++;
    this.time += dt;
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
    for (const p of this.track.propsBetween(g.s - r - 12, g.s)) {
      if (!p.alive || p.judged || p.s + p.hl > g.s - r) continue;
      p.judged = true;
      if (CLASS_RANK[p.cls] <= rank || g.air > 0) continue;
      const gap = Math.abs(p.d - g.d) - p.hw - r;
      if (gap < 0 || gap > TUNING.collision.dodgeGap) continue;
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
    if (g.speed >= C.below || g.air > 0) return false;
    return this.pursuit.onHisTail().length > 0 || this.escort.tailing(g);
  }

  /** v0.3 box-in: both neighbouring lanes blocked and a unit within 8m ahead in yours. */
  boxedIn(): boolean {
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
      return this.track.propsBetween(g.s - 3, g.s + 4).some((p) => CLASS_RANK[p.cls] > rank && inLane(lane, p));
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
    const X = TUNING.segment;
    const g = this.giant;
    const now = this.time + this.dt;
    // Plan the ramp's stretch of road before it's generated (the road exists `aheadDistance` ahead), from
    // where he'll be when it opens: keep it ramp-friendly so the exit always lands in reach.
    if (!this.exitPlanned && now >= X.exitOpensAt - X.planAhead) {
      this.exitPlanned = true;
      // Planned at Stride pace (the base gear): planned mid-Rampage, it landed out of reach at Stride later.
      const at = Math.max(this.track.end, g.s + Math.min(g.speed, TUNING.tiers[1].topSpeed) * X.planAhead + X.exitDistance[0] - 30);
      this.track.reserveExit(at, at + X.planLength);
    }
    if (!this.exit && !this.fork && now >= X.exitOpensAt && now < X.length + X.grace) this.openExit();
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
        if (e.cls === 'medium' || e.cls === 'heavy') this.award(e.cls);
        // Spectacle: a police car he flattened, else the class; smash-across pays a bonus.
        // Police units are ids ≥ 1,000,000; the car carrier is traffic, so it scores as a Heavy smash.
        const unit = e.propId >= 1_000_000 && this.pursuit.units.find((x) => x.id === e.propId)?.unit !== 'carrier';
        const cause = unit ? 'unit' : e.cls === 'heavy' ? 'heavy' : e.cls === 'medium' ? 'medium' : null;
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
      case 'lostTrack': this.stunt(e.kind === 'chopper' ? 'chopperShaken' : 'lostTrack'); break;
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
    g.rampT = TUNING.rampage.duration;
    g.rampElapsed = 0;
    this.setTier(TUNING.tiers.length - 1);
    this.emit({ type: 'rampageStart', time: g.rampT });
  }

  private endRampage() {
    const g = this.giant;
    g.rampT = 0;
    g.meter = this.upgrades.has('secondWind') ? TUNING.rampage.secondWindKeep : 0;
    this.setTier(1, 'rampageEnd');
    this.emit({ type: 'rampageEnd' });
  }

  /** A stunt in Stride fills the meter; in Rampage a smash keeps it going a little longer (capped). */
  private fillMeter(cause: StuntType) {
    const g = this.giant;
    const R = TUNING.rampage;
    if (this.inRampage) {
      if (cause === 'medium' || cause === 'heavy' || cause === 'unit') g.rampT = Math.min(g.rampT + R.perSmash, Math.max(0, R.maxDuration - g.rampElapsed));
      return;
    }
    if (g.meter >= 100) return;
    g.meter = Math.min(100, g.meter + (R.gain[cause] ?? 0));
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
    const L = this.abilityLevel - 1; // index into the per-level numbers
    g.abilityCd = Math.max(0, g.abilityCd - dt);
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
      if (g.air === 0 && g.airDur - 0 < A.landExtendMax + (g.airKind === 'breakaway' ? A.breakaway.time[2] : A.leap.time[2]) && this.landingBlocked()) {
        g.air = dt;
        g.airDur += dt;
      }
      if (g.air === 0) {
        if (g.airKind === 'breakaway') this.breakawayLand();
        else this.leapLand();
      }
    }
    if (input.ability) g.abilityBuffer = A.bufferFrames;
    if (g.abilityBuffer <= 0 || !this.ability) return;
    if (g.abilityCd > 0 || g.stumble > 0 || g.air > 0) {
      g.abilityBuffer--;
      return;
    }
    g.abilityBuffer = 0;
    const id = this.ability;
    if (id === 'leap') {
      g.air = g.airDur = A.leap.time[L];
      g.airKind = 'leap';
      g.abilityCd = A.leap.cooldown;
    } else if (id === 'stare') {
      this.stare();
      g.abilityCd = A.stare.cooldown;
    } else if (id === 'breakaway') {
      g.air = g.airDur = A.breakaway.time[L];
      g.airKind = 'breakaway';
      g.abilityCd = A.breakaway.cooldown;
    } else if (id === 'primeTime') {
      g.prime = A.primeTime.time[L];
      this.show.prime = true;
      g.abilityCd = A.primeTime.cooldown;
      this.emit({ type: 'primeTime', on: true, time: g.prime });
    }
    this.emit({ type: 'ability', id, ok: true, level: this.abilityLevel });
  }

  /** Would he land inside something the landing can't flatten? */
  private landingBlocked(): boolean {
    const g = this.giant;
    const r = this.radius();
    const all = g.airKind === 'leap' && this.abilityLevel >= 3;
    const near: Prop[] = [...this.track.propsBetween(g.s - r - 4, g.s + r + 4), ...this.pursuit.solidBetween(g.s - r - 4, g.s + r + 4)];
    return near.some((p) => p.alive && (p.cls === 'immovable' || (p as Unit).ram) && !all && Math.abs(p.s - g.s) < p.hl + r && Math.abs(p.d - g.d) < p.hw + r);
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
    const L = this.abilityLevel - 1;
    const smashed = this.slam(TUNING.abilities.leap.shockRadius[L], this.abilityLevel >= 3);
    this.emit({ type: 'leapLand', s: g.s, d: g.d, smashed });
  }

  /** Breakaway landing: a slam, every police car behind him loses track, and at III he lands in Rampage. */
  private breakawayLand() {
    const g = this.giant;
    const L = this.abilityLevel - 1;
    const smashed = this.slam(TUNING.abilities.breakaway.shockRadius[L], false);
    g.speed = Math.min(g.speed, this.tierTuning.topSpeed); // the landing takes the dive's extra speed
    const shaken = this.pursuit.loseAllBehind();
    if (this.abilityLevel >= 3) this.startRampage();
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
    const free = (p: Prop, c: number) => !this.track.propsBetween(p.s - p.hl - 3, p.s + p.hl + 3).some((q) => q !== p && Math.abs(q.d - c) < q.hw + p.hw + 0.4);
    // Nearest lanes first, so a car next to him can move out before one in his lane moves in beside it.
    const props = this.track.propsBetween(g.s, g.s + A.reach[this.abilityLevel - 1]).filter((p) => p.alive && p.cls !== 'immovable' && Math.abs(p.d - myC) <= W * A.lanesEitherSide + p.hw);
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
    const crashed = this.abilityLevel >= 3 ? this.pursuit.crashBackedOff() : 0;
    this.emit({ type: 'stare', moved, backedOff, crashed });
  }

  // --- Speed and gait ----------------------------------------------------------

  private stepSpeed(input: SimInput, dt: number) {
    const g = this.giant;
    const tier = this.tierTuning;
    const top = tier.topSpeed + (g.shoulderT > 0 ? TUNING.shoulderCheck.burstSpeed : 0);
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
      if (CLASS_RANK[p.cls] <= rank) continue;
      if (Math.abs(p.d - c) < p.hw + r) return false;
    }
    for (const u of this.pursuit.solidBetween(s0, s1)) {
      if (CLASS_RANK[u.cls] <= rank) continue;
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
      if (ds * ds + dd * dd >= r * r) continue;

      // A Police Net flanker breaks only to a Shoulder Check (then it's Heavy); otherwise nothing moves it.
      const u = p as Unit;
      // A cruiser mid-ram is driving into him: it can't be shrugged off at Rampage (only a Shoulder Check flattens it).
      const ramming = u.unit === 'cruiser' && u.phase === 'act' && TUNING.pursuit.cruiser.ramBeatsRampage && this.giant.shoulderT <= 0 && !this.inRampage;
      const cls = ramming ? 'immovable' : u.ram && this.giant.shoulderT > 0 ? 'heavy' : p.cls;
      if (CLASS_RANK[cls] <= rank) {
        // Smash, forward or across: the same class rule either way (v0.3 smash-across).
        p.alive = false;
        g.speed = Math.max(TUNING.giant.speedFloor, g.speed * (1 - TUNING.collision.smashSpeedLoss[p.cls]));
        const across = g.move === 'change' && Math.abs(g.d - p.d) > 0.4;
        this.emit({ type: 'smash', propId: p.id, cls: p.cls, mat: p.mat, s: p.s, d: p.d, across, speed: g.speed });
        continue;
      }

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
      for (const x of side) if (CLASS_RANK[x.cls] > this.smashRank()) force(x);
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
    const inWay = (x: Prop) => CLASS_RANK[x.cls] > rank && Math.abs(x.d - c) < x.hw + r && x.s + x.hl > g.s - r;
    for (const p of this.track.propsBetween(g.s - 6, g.s + 60)) if (inWay(p)) room = Math.min(room, p.s - p.hl - g.s);
    // Police alongside or ahead in that lane (a Net's flanker alongside means no way out on that side).
    for (const u of this.pursuit.solidBetween(g.s - 6, g.s + 60)) if (u.unit !== 'cruiser' && u.unit !== 'rolling' && u.phase !== 'leave' && inWay(u)) room = Math.min(room, u.s - u.hl - g.s);
    return room;
  }
}
