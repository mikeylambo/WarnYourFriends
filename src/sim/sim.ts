import { TUNING, type MassClass } from '../tuning';
import { angleDiff, approach, clamp, DEG, wrap } from './math';
import { Rng } from './rng';
import { generateLayout, type Layout } from './layout';
import type { GiantState, Ped, Prop, SimEvent, SimInput } from './types';

const CLASS_RANK: Record<MassClass, number> = { light: 0, medium: 1, heavy: 2, immovable: 3 };

/** Static spatial hash for props (props never move; they only die and respawn). */
class PropGrid {
  private cells = new Map<number, number[]>();
  constructor(private props: Prop[], private size = 8) {
    for (const p of props) {
      const x0 = Math.floor((p.x - p.hw) / size);
      const x1 = Math.floor((p.x + p.hw) / size);
      const z0 = Math.floor((p.z - p.hd) / size);
      const z1 = Math.floor((p.z + p.hd) / size);
      for (let i = x0; i <= x1; i++) {
        for (let j = z0; j <= z1; j++) {
          const k = this.key(i, j);
          let arr = this.cells.get(k);
          if (!arr) this.cells.set(k, (arr = []));
          arr.push(p.id);
        }
      }
    }
  }
  private key(i: number, j: number) {
    return (i + 4096) * 8192 + (j + 4096);
  }
  /** Unique live-or-dead props whose cells touch the circle's bounds. */
  query(x: number, z: number, r: number, out: Prop[]): Prop[] {
    out.length = 0;
    const s = this.size;
    const x0 = Math.floor((x - r) / s);
    const x1 = Math.floor((x + r) / s);
    const z0 = Math.floor((z - r) / s);
    const z1 = Math.floor((z + r) / s);
    for (let i = x0; i <= x1; i++) {
      for (let j = z0; j <= z1; j++) {
        const arr = this.cells.get(this.key(i, j));
        if (!arr) continue;
        for (const id of arr) {
          const p = this.props[id];
          if (!out.includes(p)) out.push(p);
        }
      }
    }
    return out;
  }
}

export interface SimStats {
  timeAtTier: [number, number, number];
  smashes: number;
  knocks: number;
  bounces: number;
  scrapes: number;
  tierUps: number;
  tierDowns: number;
  shoves: number;
  minSpeed: number;
}

export interface SimOptions {
  seed: number;
}

/**
 * The Phase 0 simulation: the giant, a block of breakable props, pedestrians.
 * Pure TypeScript, no rendering, deterministic for a given seed and input stream.
 */
export class Sim {
  readonly dt = 1 / TUNING.sim.hz;
  readonly seed: number;
  readonly layout: Layout;
  readonly props: Prop[];
  readonly peds: Ped[];
  readonly giant: GiantState;
  readonly rng: Rng;
  tick = 0;
  time = 0;
  stats: SimStats = { timeAtTier: [0, 0, 0], smashes: 0, knocks: 0, bounces: 0, scrapes: 0, tierUps: 0, tierDowns: 0, shoves: 0, minSpeed: Infinity };

  private grid: PropGrid;
  private scratch: Prop[] = [];
  private events: SimEvent[] = [];

  constructor(opts: SimOptions) {
    this.seed = opts.seed;
    this.rng = new Rng(opts.seed ^ 0x51ed);
    this.layout = generateLayout(opts.seed);
    this.props = this.layout.props;
    this.peds = this.layout.peds;
    this.grid = new PropGrid(this.props);
    const s = this.layout.spawn;
    this.giant = {
      x: s.x,
      z: s.z,
      heading: s.heading,
      travel: s.heading,
      speed: TUNING.giant.startSpeed,
      angVel: 0,
      tier: 0,
      tierTimer: 0,
      stumble: 0,
      brakeHeld: 0,
      braking: false,
      shoulderT: 0,
      shoulderCd: 0,
      shoulderBuffer: 0,
      gaitPhase: 0,
      turnLog: [],
      yankLatched: false,
    };
  }

  get tierTuning() {
    return TUNING.tiers[this.giant.tier];
  }

  /** Advance one fixed 60 Hz tick. Returns events produced this tick. */
  step(input: SimInput): SimEvent[] {
    this.events = [];
    const dt = this.dt;
    this.stepGiant(input, dt);
    this.collideGiant();
    this.stepPeds(dt);
    this.stepRespawn(dt);
    const g = this.giant;
    this.stats.timeAtTier[g.tier] += dt;
    this.stats.minSpeed = Math.min(this.stats.minSpeed, g.speed);
    this.tick++;
    this.time += dt;
    return this.events;
  }

  private emit(e: SimEvent) {
    this.events.push(e);
    switch (e.type) {
      case 'smash': this.stats.smashes++; break;
      case 'knock': this.stats.knocks++; break;
      case 'bounce': this.stats.bounces++; break;
      case 'scrape': this.stats.scrapes++; break;
      case 'tierUp': this.stats.tierUps++; break;
      case 'tierDown': this.stats.tierDowns++; break;
      case 'shove': this.stats.shoves++; break;
    }
  }

  private setTier(tier: number, reason?: 'impact' | 'turn' | 'brake') {
    const g = this.giant;
    const next = clamp(tier, 0, TUNING.tiers.length - 1);
    if (next === g.tier) return;
    const up = next > g.tier;
    g.tier = next;
    g.tierTimer = 0;
    g.turnLog.length = 0;
    if (up) this.emit({ type: 'tierUp', tier: next });
    else this.emit({ type: 'tierDown', tier: next, reason: reason ?? 'impact' });
  }

  private stepGiant(input: SimInput, dt: number) {
    const g = this.giant;
    const T = this.tierTuning;
    const D = TUNING.tierDrop;

    // --- Shoulder Check (buffered) -------------------------------------
    if (input.shoulder) g.shoulderBuffer = TUNING.shoulderCheck.bufferFrames;
    g.shoulderCd = Math.max(0, g.shoulderCd - dt);
    g.shoulderT = Math.max(0, g.shoulderT - dt);
    if (g.shoulderBuffer > 0) {
      if (g.shoulderCd <= 0 && g.stumble <= 0) {
        g.shoulderBuffer = 0;
        g.shoulderT = TUNING.shoulderCheck.duration;
        g.shoulderCd = TUNING.shoulderCheck.cooldown;
        g.speed += TUNING.shoulderCheck.burstSpeed;
        const fx = Math.cos(g.heading);
        const fz = Math.sin(g.heading);
        this.emit({ type: 'shoulder', x: g.x, z: g.z, dirX: fx, dirZ: fz });
        this.shovePedsInRadius(g.x + fx * 2, g.z + fz * 2, TUNING.shoulderCheck.shoveRadius);
      } else {
        g.shoulderBuffer--;
      }
    }

    // --- Steering --------------------------------------------------------
    let maxTurn = T.turnRateDeg * DEG;
    if (input.brake) maxTurn *= TUNING.brake.turnMul;
    if (g.stumble > 0) maxTurn *= D.stumbleTurnMul;
    let desired = 0;
    if (input.aim !== null) {
      // Critically-ish damped approach to an absolute heading (stick, mouse, touch).
      const k = 0.4 / T.turnLag;
      desired = clamp(angleDiff(g.heading, input.aim) * k, -maxTurn, maxTurn);
    } else {
      desired = clamp(input.turn, -1, 1) * maxTurn;
    }
    g.angVel += (desired - g.angVel) * approach(dt, T.turnLag);
    g.angVel = clamp(g.angVel, -maxTurn, maxTurn);
    const dHeading = g.angVel * dt;
    g.heading = wrap(g.heading + dHeading);

    // Sharp turn: more than 110° of net steering within 0.5s drops a tier (§9).
    g.turnLog.push(dHeading);
    const windowTicks = Math.round(D.sharpTurnWindow / dt);
    if (g.turnLog.length > windowTicks) g.turnLog.shift();
    let net = 0;
    for (const d of g.turnLog) net += d;
    if (Math.abs(net) > D.sharpTurnDeg * DEG && g.tier > 0) this.setTier(g.tier - 1, 'turn');
    // With §9 turn rates the net-heading rule is nearly unreachable, so a steering
    // demand more than 110° off the facing (stick/mouse/touch yank) also counts
    // as a sharp turn. See DECISIONS.md.
    if (input.aim !== null) {
      const off = Math.abs(angleDiff(g.heading, input.aim));
      if (off > D.sharpTurnDeg * DEG && !g.yankLatched) {
        g.yankLatched = true;
        if (g.tier > 0) this.setTier(g.tier - 1, 'turn');
      } else if (off < D.yankReleaseDeg * DEG) {
        g.yankLatched = false;
      }
    } else {
      g.yankLatched = false;
    }

    // Drift: travel direction chases the facing at the tier's grip.
    const slip = angleDiff(g.travel, g.heading);
    g.travel = wrap(g.travel + slip * (1 - Math.exp(-T.grip * dt)));

    // --- Speed ----------------------------------------------------------
    g.braking = input.brake;
    const tier = this.tierTuning; // may have changed above
    const top = tier.topSpeed + (g.shoulderT > 0 ? TUNING.shoulderCheck.burstSpeed : 0);
    if (input.brake) {
      g.speed -= TUNING.brake.decel * dt;
      g.brakeHeld += dt;
      g.tierTimer = 0;
      if (g.brakeHeld > D.brakeHold) {
        g.brakeHeld = 0;
        if (g.tier > 0) this.setTier(g.tier - 1, 'brake');
      }
    } else {
      g.brakeHeld = 0;
      if (g.stumble > 0) {
        // No acceleration while stumbling; it's a wobble, not a stop.
      } else if (g.speed < top) {
        g.speed = Math.min(top, g.speed + tier.accel * dt);
      } else if (g.speed > top) {
        g.speed = Math.max(top, g.speed - TUNING.giant.overspeedDecel * dt);
      }
    }
    // Scrubbing sideways costs a little speed: drifting is never free.
    g.speed -= Math.abs(Math.sin(angleDiff(g.travel, g.heading))) * 5 * dt;
    g.speed = Math.max(TUNING.giant.speedFloor, g.speed); // LOCKED Law 1

    g.stumble = Math.max(0, g.stumble - dt);

    // --- Tier up --------------------------------------------------------
    if (!input.brake && g.stumble <= 0 && g.speed >= tier.topSpeed * TUNING.giant.topSpeedEpsilon) {
      g.tierTimer += dt;
      if (g.tierTimer >= tier.tierUpAfter) this.setTier(g.tier + 1);
    }

    // --- Integrate ------------------------------------------------------
    const dist = g.speed * dt;
    g.x += Math.cos(g.travel) * dist;
    g.z += Math.sin(g.travel) * dist;

    const prevHalf = Math.floor(g.gaitPhase * 2);
    g.gaitPhase += dist / this.tierTuning.strideLength;
    const nowHalf = Math.floor(g.gaitPhase * 2);
    if (nowHalf !== prevHalf) {
      this.emit({ type: 'footfall', tier: g.tier, foot: (nowHalf & 1) as 0 | 1, x: g.x, z: g.z, speed: g.speed });
    }
  }

  /** Index of the heaviest class the giant smashes right now. */
  smashRank(): number {
    const g = this.giant;
    const base = this.tierTuning.smashes ? CLASS_RANK[this.tierTuning.smashes] : -1;
    const bonus = g.shoulderT > 0 ? 1 : 0;
    return Math.min(base + bonus, CLASS_RANK.heavy);
  }

  private collideGiant() {
    const g = this.giant;
    const r = TUNING.giant.radius;
    const near = this.grid.query(g.x, g.z, r + 0.5, this.scratch);
    const smashRank = this.smashRank();
    for (const p of near) {
      if (!p.alive) continue;
      // Closest point on AABB.
      const cx = clamp(g.x, p.x - p.hw, p.x + p.hw);
      const cz = clamp(g.z, p.z - p.hd, p.z + p.hd);
      let nx = g.x - cx;
      let nz = g.z - cz;
      let d = Math.hypot(nx, nz);
      if (d >= r) continue;
      let pen: number;
      if (d < 1e-6) {
        // Centre inside the box: push out along the shallowest axis.
        const px = p.hw - Math.abs(g.x - p.x);
        const pz = p.hd - Math.abs(g.z - p.z);
        if (px < pz) {
          nx = Math.sign(g.x - p.x) || 1;
          nz = 0;
          pen = px + r;
        } else {
          nx = 0;
          nz = Math.sign(g.z - p.z) || 1;
          pen = pz + r;
        }
        d = 1;
      } else {
        nx /= d;
        nz /= d;
        pen = r - d;
      }

      const rank = CLASS_RANK[p.cls];
      const dirX = Math.cos(g.travel);
      const dirZ = Math.sin(g.travel);
      if (rank <= smashRank) {
        p.alive = false;
        p.deadT = 0;
        g.speed = Math.max(TUNING.giant.speedFloor, g.speed * (1 - TUNING.collision.smashSpeedLoss[p.cls]));
        const e = { propId: p.id, cls: p.cls, mat: p.mat, x: p.x, z: p.z, dirX, dirZ, speed: g.speed };
        this.emit(p.cls === 'light' ? { type: 'knock', ...e } : { type: 'smash', ...e });
        continue;
      }

      // Can't smash it: push out, then bounce or scrape.
      g.x += nx * pen;
      g.z += nz * pen;
      const into = -(dirX * nx + dirZ * nz); // 1 = head-on, 0 = parallel
      if (into <= 0) continue;
      if (into < 0.3) {
        // Grazing contact: slide along the surface. Not an "impact" (DECISIONS.md).
        const tx = dirX + nx * into;
        const tz = dirZ + nz * into;
        g.travel = Math.atan2(tz, tx);
        g.speed = Math.max(TUNING.giant.speedFloor, g.speed * (1 - 0.9 * into));
        this.emit({ type: 'scrape', x: cx, z: cz });
        continue;
      }
      // Heavy, embarrassing bounce (§10): reflect, lose speed, drop a tier, stumble.
      const rx = dirX + 2 * into * nx;
      const rz = dirZ + 2 * into * nz;
      const bounced = Math.atan2(rz, rx);
      g.travel = bounced;
      // Facing swings most of the way toward the rebound; the stumble sells the rest.
      g.heading = wrap(g.heading + angleDiff(g.heading, bounced) * 0.7);
      g.angVel = 0;
      g.speed = Math.max(TUNING.giant.speedFloor, g.speed * TUNING.collision.bounceSpeedKeep);
      const fresh = g.stumble <= 0;
      g.stumble = TUNING.tierDrop.stumbleTime;
      g.tierTimer = 0;
      if (fresh) {
        this.emit({ type: 'bounce', cls: p.cls, x: cx, z: cz, nx, nz, speed: g.speed });
        if (g.tier > 0) this.setTier(g.tier - 1, 'impact');
      }
    }
  }

  private shovePedsInRadius(x: number, z: number, r: number) {
    for (const p of this.peds) {
      const dx = p.x - x;
      const dz = p.z - z;
      const d = Math.hypot(dx, dz);
      if (d > r || p.state === 'tumble') continue;
      const k = TUNING.pedestrian.shoveSpeed / Math.max(d, 0.5);
      p.vx = dx * k * 0.6;
      p.vz = dz * k * 0.6;
      p.state = 'tumble';
      p.t = TUNING.pedestrian.tumbleTime;
      p.spin = this.rng.range(-12, 12);
      this.emit({ type: 'shove', pedId: p.id, x: p.x, z: p.z });
    }
  }

  private stepPeds(dt: number) {
    const g = this.giant;
    const P = TUNING.pedestrian;
    const gr = TUNING.giant.radius + P.radius;
    const fx = Math.cos(g.travel);
    const fz = Math.sin(g.travel);
    for (const p of this.peds) {
      const dx = p.x - g.x;
      const dz = p.z - g.z;
      const d = Math.hypot(dx, dz);

      if (p.state === 'tumble') {
        p.t -= dt;
        const f = Math.exp(-3.5 * dt);
        p.vx *= f;
        p.vz *= f;
        if (p.t <= 0) {
          p.state = 'walk';
          p.t = this.rng.range(1, 3);
        }
      } else if (d < gr) {
        // Shoved aside comically: sideways relative to the giant's path.
        const side = fx * dz - fz * dx >= 0 ? 1 : -1;
        const sx = -fz * side;
        const sz = fx * side;
        const s = P.shoveSpeed + g.speed * 0.4;
        p.vx = (sx * 0.8 + fx * 0.5) * s;
        p.vz = (sz * 0.8 + fz * 0.5) * s;
        p.state = 'tumble';
        p.t = P.tumbleTime;
        p.spin = this.rng.range(-14, 14);
        this.emit({ type: 'shove', pedId: p.id, x: p.x, z: p.z });
      } else if (d < P.fleeRadius && dx * fx + dz * fz > -2) {
        // Dive clear: perpendicular to the giant's line.
        const side = fx * dz - fz * dx >= 0 ? 1 : -1;
        const tx = -fz * side;
        const tz = fx * side;
        p.state = 'flee';
        p.vx = tx * P.fleeSpeed;
        p.vz = tz * P.fleeSpeed;
        p.heading = Math.atan2(tz, tx);
        p.t = 0.8;
      } else {
        p.t -= dt;
        if (p.state === 'flee' && p.t <= 0) p.state = 'walk';
        if (p.state === 'walk') {
          if (p.t <= 0) {
            p.heading = wrap(p.heading + this.rng.range(-1.2, 1.2));
            p.t = this.rng.range(1.5, 4);
          }
          p.vx = Math.cos(p.heading) * P.walkSpeed;
          p.vz = Math.sin(p.heading) * P.walkSpeed;
        }
      }

      p.x += p.vx * dt;
      p.z += p.vz * dt;

      // Keep peds out of solid things and inside the arena.
      const near = this.grid.query(p.x, p.z, P.radius + 0.2, this.scratch);
      for (const q of near) {
        if (!q.alive || q.cls === 'light') continue;
        const cx = clamp(p.x, q.x - q.hw, q.x + q.hw);
        const cz = clamp(p.z, q.z - q.hd, q.z + q.hd);
        const ex = p.x - cx;
        const ez = p.z - cz;
        const e = Math.hypot(ex, ez);
        if (e >= P.radius) continue;
        if (e < 1e-6) {
          const px = q.hw - Math.abs(p.x - q.x);
          const pz = q.hd - Math.abs(p.z - q.z);
          if (px < pz) p.x += (Math.sign(p.x - q.x) || 1) * (px + P.radius);
          else p.z += (Math.sign(p.z - q.z) || 1) * (pz + P.radius);
        } else {
          p.x += (ex / e) * (P.radius - e);
          p.z += (ez / e) * (P.radius - e);
        }
        if (p.state === 'walk') p.heading = wrap(p.heading + Math.PI * 0.6);
      }
    }
  }

  private stepRespawn(dt: number) {
    const g = this.giant;
    const B = TUNING.block;
    for (const p of this.props) {
      if (p.alive) continue;
      p.deadT += dt;
      if (p.deadT < B.respawnAfter) continue;
      if (Math.hypot(p.x - g.x, p.z - g.z) < B.respawnMinDistance) continue;
      p.alive = true;
      p.deadT = 0;
      this.emit({ type: 'respawn', propId: p.id });
    }
  }
}
