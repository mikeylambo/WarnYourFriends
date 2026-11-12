import { TUNING, type MassClass } from '../tuning';
import { clamp } from './math';
import { Rng } from './rng';
import { Track } from './track';
import { Escort } from './escort';
import { Show } from './show';
import { Pursuit } from './pursuit';
import type { GainType, GiantState, Prop, SimEvent, SimInput, TierDropReason, Unit } from './types';

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
  /** Phase 2: the sign-off exit ramp, once open (v0.3 §4). */
  exit: { s: number; gore: number; segment: number; lane: number } | null = null;
  tick = 0;
  time = 0;
  stats: SimStats = { timeAtTier: [0, 0, 0], smashes: 0, smashesAcross: 0, bounces: 0, wallBumps: 0, laneChanges: 0, tierUps: 0, tierDowns: 0, footfalls: 0, merges: 0, minSpeed: Infinity };

  private events: SimEvent[] = [];
  private near: Prop[] = [];

  constructor(opts: SimOptions) {
    this.seed = opts.seed;
    this.rng = new Rng(opts.seed ^ 0x51ed);
    this.track = new Track(opts.seed);
    this.escort = new Escort(opts.seed, this.track);
    this.pursuit = new Pursuit(opts.seed, this);
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
      tier: 0,
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
    };
  }

  get tierTuning() {
    return TUNING.tiers[this.giant.tier];
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
    this.stepShoulder(input, dt);
    this.stepLanes(input);
    this.stepSpeed(input, dt);
    const segBefore = this.track.segmentAt(this.giant.s).index;
    this.advance(dt);
    this.stepLateral(dt);
    this.collide();
    const seg = this.track.segmentAt(this.giant.s);
    if (seg.index !== segBefore && seg.kind === 'merge') this.emit({ type: 'merge', from: seg.lanes0, to: seg.lanes1, s: seg.s0 });
    if (seg.index !== segBefore && seg.zoneStart) this.emit({ type: 'zone', zone: seg.zone, name: seg.zoneName });
    this.pursuit.step(dt);
    this.stepExit();
    const outnumbered = this.pursuit.chasing >= TUNING.show.outnumberedAt;
    this.show.stepPin(dt, this.boxedIn(), this.giant.speed, this.events);
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

  /** §12 gain, with "outnumbered" applied. */
  award(type: GainType) {
    this.show.gain(type, this.time, this.pursuit.chasing >= TUNING.show.outnumberedAt, this.events);
  }

  /** Another unit is already winding up (one tell at a time). */
  tellBusy(except: Unit): boolean {
    return this.pursuit.units.some((u) => u !== except && u.alive && u.phase === 'tell') || this.pursuit.tellActive;
  }

  /** Spike strip (v0.3): −1 tier, keep 70% speed, a stumble. No knock-back. */
  spikeHit(u: Unit) {
    const g = this.giant;
    g.speed = Math.max(TUNING.giant.speedFloor, g.speed * TUNING.pursuit.spike.speedKeep);
    g.stumble = TUNING.tierDrop.stumbleTime;
    g.tierTimer = 0;
    if (g.tier > 0) this.setTier(g.tier - 1, 'impact');
    this.emit({ type: 'spiked', id: u.id });
  }

  /** v0.3 box-in: both neighbouring lanes blocked and a unit within 8m ahead in yours. */
  boxedIn(): boolean {
    const g = this.giant;
    const S = TUNING.show;
    const units = this.pursuit.solidBetween(g.s - 6, g.s + S.pinUnitAhead + 3);
    const inLane = (lane: number, u: Prop) => Math.abs(u.d - this.track.laneCenter(lane)) < u.hw + 1.0;
    const ahead = units.some((u) => u.s - u.hl - g.s <= S.pinUnitAhead && u.s > g.s && inLane(g.lane, u));
    if (!ahead) return false;
    const rank = this.smashRank();
    const blocked = (lane: number) => {
      if (!this.track.laneUsable(lane, g.s)) return true;
      if (units.some((u) => Math.abs(u.s - g.s) < u.hl + 4 && inLane(lane, u))) return true;
      return this.track.propsBetween(g.s - 3, g.s + 4).some((p) => CLASS_RANK[p.cls] > rank && inLane(lane, p));
    };
    return blocked(g.lane - 1) && blocked(g.lane + 1);
  }

  /** v0.3 §4: the exit ramp opens at 130s; be in the rightmost lane at the gore to sign off. */
  private stepExit() {
    const X = TUNING.segment;
    const g = this.giant;
    const now = this.time + this.dt;
    if (!this.exit && now >= X.exitOpensAt && now < X.length + X.grace) this.openExit();
    if (this.exit && g.s >= this.exit.gore) {
      const lanes = this.track.lanesAt(this.exit.gore);
      if (g.lane === lanes - 1 && g.move !== 'wallBump') {
        this.show.clear(this.events);
        return;
      }
      this.emit({ type: 'exitMissed', s: this.exit.gore });
      this.exit = null;
    }
    if (now >= X.length + X.grace) this.show.bust('missed', this.events);
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
    for (const p of this.track.propsBetween(gore - X.exitClear, gore + 6)) if (Math.abs(p.d - c) < p.hw + 1.2) p.alive = false;
    this.exit = { s: seg.s0, gore, segment: seg.index, lane };
    this.emit({ type: 'exitOpen', s: gore, segment: seg.index, lane });
  }

  private emit(e: SimEvent) {
    this.events.push(e);
    const st = this.stats;
    switch (e.type) {
      case 'smash':
        st.smashes++;
        if (e.across) st.smashesAcross++;
        if (e.cls === 'medium' || e.cls === 'heavy') this.award(e.cls);
        break;
      case 'bounce': st.bounces++; break;
      case 'wallBump': st.wallBumps++; break;
      case 'laneChange': st.laneChanges++; break;
      case 'tierUp': st.tierUps++; break;
      case 'tierDown': st.tierDowns++; break;
      case 'footfall': st.footfalls++; break;
      case 'merge': st.merges++; break;
      case 'smash': break;
    }
  }

  private setTier(tier: number, reason?: TierDropReason) {
    const g = this.giant;
    const next = clamp(tier, 0, TUNING.tiers.length - 1);
    if (next === g.tier) return;
    const up = next > g.tier;
    g.tier = next;
    g.tierTimer = 0;
    if (up) this.emit({ type: 'tierUp', tier: next });
    else this.emit({ type: 'tierDown', tier: next, reason: reason ?? 'impact' });
  }

  private stepShoulder(input: SimInput, dt: number) {
    const g = this.giant;
    if (input.shoulder) g.shoulderBuffer = TUNING.shoulderCheck.bufferFrames;
    g.shoulderCd = Math.max(0, g.shoulderCd - dt);
    g.shoulderT = Math.max(0, g.shoulderT - dt);
    if (g.shoulderBuffer > 0) {
      if (g.shoulderCd <= 0 && g.stumble <= 0) {
        g.shoulderBuffer = 0;
        g.shoulderT = TUNING.shoulderCheck.duration;
        g.shoulderCd = TUNING.shoulderCheck.cooldown;
        g.speed += TUNING.shoulderCheck.burstSpeed;
        this.emit({ type: 'shoulder', s: g.s, d: g.d });
      } else {
        g.shoulderBuffer--;
      }
    }
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
    if (g.move === null && !this.track.laneUsable(g.lane, g.s + 3)) {
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

  // --- Speed and gait ----------------------------------------------------------

  private stepSpeed(input: SimInput, dt: number) {
    const g = this.giant;
    const tier = this.tierTuning;
    const top = tier.topSpeed + (g.shoulderT > 0 ? TUNING.shoulderCheck.burstSpeed : 0);
    g.braking = input.brake;
    if (input.brake) {
      g.speed -= TUNING.brake.decel * dt;
      g.brakeHeld += dt;
      g.tierTimer = 0;
      if (g.brakeHeld > TUNING.tierDrop.brakeHold) {
        g.brakeHeld = 0;
        if (g.tier > 0) this.setTier(g.tier - 1, 'brake');
      }
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
    if (!input.brake && g.stumble <= 0 && g.speed >= t.topSpeed * TUNING.giant.topSpeedEpsilon) {
      g.tierTimer += dt;
      if (g.tierTimer >= t.tierUpAfter) this.setTier(g.tier + 1);
    }
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
    const base = this.tierTuning.smashes ? CLASS_RANK[this.tierTuning.smashes] : -1;
    return Math.min(base + (g.shoulderT > 0 ? 1 : 0), CLASS_RANK.heavy);
  }

  /** Is `lane` free of things the giant can't smash over [s0, s1]? */
  laneClear(lane: number, s0: number, s1: number, moving = true): boolean {
    if (!this.track.laneUsable(lane, s0) || !this.track.laneUsable(lane, s1)) return false;
    const c = this.track.laneCenter(lane);
    const r = TUNING.giant.radius;
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
    const r = TUNING.giant.radius;
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

      if (CLASS_RANK[p.cls] <= rank) {
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
      if (!moving && g.s < p.s) g.s = Math.min(g.s, p.s - p.hl - Math.sqrt(Math.max(0, r * r - dd * dd)) - 0.01);
      if (unit) (p as Unit).hit = true;
      if (g.stumble > 0 || g.move === 'knock') continue; // already reeling: no double penalty

      // −1 tier, 0.3s stumble, knocked back to the previous lane (v0.3).
      g.speed = Math.max(TUNING.giant.speedFloor, g.speed * TUNING.collision.bounceSpeedKeep);
      g.stumble = TUNING.tierDrop.stumbleTime;
      g.tierTimer = 0;
      g.laneQueue = 0;
      const toLane = this.knockLane(p);
      if (g.tier > 0) this.setTier(g.tier - 1, 'impact');
      this.beginMove('knock', toLane, TUNING.lanes.knockbackTime);
      this.emit({ type: 'bounce', propId: p.id, cls: p.cls, s: p.s, d: p.d, toLane, speed: g.speed });
    }
  }

  /** Where an unsmashable hit sends the giant: the previous lane, else the nearest clear one. */
  private knockLane(p: Prop): number {
    const g = this.giant;
    const s0 = g.s - 2;
    const s1 = Math.max(p.s + p.hl, g.s) + 4;
    const candidates: number[] = [];
    if (g.move === 'change') candidates.push(g.moveFromLane);
    candidates.push(g.prevLane);
    const here = g.lane;
    for (let k = 1; k <= TUNING.lanes.max; k++) candidates.push(here - k, here + k);
    for (const lane of candidates) {
      if (lane === here && g.move !== 'change') continue;
      if (this.laneClear(lane, s0, s1, false)) return lane;
    }
    // Nowhere clear (rows always leave a lane, so rare): fall back to the previous lane.
    return this.track.laneUsable(g.prevLane, g.s) ? g.prevLane : here;
  }
}
