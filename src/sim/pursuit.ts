import { TUNING } from '../tuning';
import { clamp } from './math';
import { Rng } from './rng';
import { PROP_DEFS } from './track';
import type { Sim } from './sim';
import type { PropKind, Unit, UnitKind } from './types';

const smoothstep = (t: number) => t * t * (3 - 2 * t);

/**
 * Phase 2 pursuit, lane-runner version (v0.3 §11). Units are moving obstacles:
 * solid ones collide exactly like props (Rampage smashes a cruiser; anything
 * less bounces), so the smash/bounce rules don't fork.
 *
 *  - Cruiser: comes up from behind in a neighbouring lane, pulls alongside,
 *    blinker + 0.6s drift (tell), swerves into your lane. Change away or Rampage through.
 *  - Rolling roadblock: 2–3 cruisers abreast ahead; brake lights 1.5s, then they
 *    slow to a crawl. One car is a compact (Medium): Stride or Shoulder Check beats it.
 *  - Spike strip: covers your lane; officer kneels 1.2s. Change lanes.
 *  - Static roadblock: cars slide in over 2.0s across all lanes but one; the gap is clear.
 *  - Police chopper: a spotlight sweeps in (1.5s) and locks onto his lane; while it has him,
 *    police arrive twice as fast. Two quick lane changes shake it; a tunnel breaks line of sight.
 *
 * Police crashes: a chasing cruiser drives in a lane and hits what's in it. It watches him,
 * not the road, so leading it into a Heavy prop crashes it out of the chase (on screen only).
 *
 * Fairness: spawns ≥40m away (LOCKED) and off camera (soak-checked), at most one
 * tell at a time, ahead-threats one at a time and never on the approach to the exit.
 */
export class Pursuit {
  readonly units: Unit[] = [];
  private nextId = 1_000_000;
  private group = 0;
  private spawnT = 0;
  /** Sim time the last police chopper spawned (one per `chopper.every`). */
  private chopperAt = -Infinity;
  /** Closest approach (m) per unit while passing, for near-misses. */
  private closest = new Map<number, number>();
  private rng: Rng;
  /** Police Net: nets this segment, when the last one spawned, and how long he's been out of each one's box. */
  private nets = 0;
  private netAt = -Infinity;
  private outOfBox = new Map<number, number>();
  /** Rolling Blockade: time to the next gap shift, per row. */
  private shiftT = new Map<number, number>();
  /** Car Carrier: when the next one may come. */
  private carrierAt: number;

  constructor(seed: number, private sim: Sim) {
    this.rng = new Rng((seed ^ 0x9015e) >>> 0);
    this.carrierAt = TUNING.pursuit.carrier.firstAt;
  }

  /** A Police Net is in play (presentation: the BOXED IN meter, the producer's call). */
  get netActive(): boolean {
    return this.units.some((u) => u.alive && u.unit === 'net' && u.phase !== 'approach' && u.phase !== 'leave');
  }

  /** Break up every Police Net: the truck drives off, the flankers fall back (no award: the caller decides). */
  disperseNet() {
    for (const u of this.units) if (u.alive && u.unit === 'net' && u.phase !== 'leave') {
      this.setPhase(u, 'leave');
      u.hit = true; // never also counted as a near-miss or a lost track
    }
  }

  /** Any threat is winding up (camera director: no cuts during a tell). */
  get tellActive(): boolean {
    return this.units.some((u) => u.alive && (u.phase === 'tell' || (u.unit === 'roadblock' && u.phase === 'act' && u.phaseT < TUNING.pursuit.roadblock.tell)));
  }

  /** A police chopper has his lane: police arrive faster (v0.3 §11 "marks your lane for units"). */
  get marked(): boolean {
    return this.units.some((u) => u.alive && u.unit === 'chopper' && u.phase === 'act');
  }

  /** Units chasing (not yet lost), for §12 "outnumbered". */
  get chasing(): number {
    return this.units.filter((u) => u.alive && !u.lost && u.unit !== 'spike').length;
  }

  /** A fork taken: nothing follows him off the highway. Units that engaged are shaken (lost track). */
  loseAll(): number {
    let n = 0;
    for (const u of this.units) {
      if (!u.alive) continue;
      const engaged = !u.lost && (u.unit === 'cruiser' ? u.target >= 0 || u.phase !== 'approach' : u.phase !== 'approach');
      if (engaged && u.unit !== 'spike' && u.unit !== 'roadblock') {
        n++;
        this.sim.emitPublic({ type: 'lostTrack', id: u.id, kind: u.unit });
        this.sim.award('lostTrack');
      }
      u.alive = false;
    }
    this.closest.clear();
    return n;
  }

  /** The Stare: cruisers closing in or winding up back off (they've lost their nerve, not him). */
  backOff(): number {
    let n = 0;
    for (const u of this.units) {
      if (!u.alive || u.unit !== 'cruiser' || u.phase === 'leave') continue;
      if (u.phase === 'approach' && u.s < this.sim.giant.s - 15) continue;
      this.setPhase(u, 'leave');
      u.target = -1; // didn't engage: no "lost track" award
      n++;
    }
    return n;
  }

  solidBetween(s0: number, s1: number, out: Unit[] = []): Unit[] {
    out.length = 0;
    for (const u of this.units) if (u.alive && u.solid && u.s + u.hl >= s0 && u.s - u.hl <= s1) out.push(u);
    return out;
  }

  private make(kind: PropKind, unit: UnitKind, s: number, d: number, lane: number): Unit {
    const def = PROP_DEFS[kind];
    const u: Unit = {
      id: this.nextId++, kind, cls: def.cls, mat: def.mat, s, d, hl: def.hl, hw: def.hw, h: def.h, variant: 0, alive: true, segment: -1,
      unit, phase: 'approach', phaseT: 0, speed: 0, lane, fromD: d, toD: d, group: -1, solid: true, target: -1, hit: false, nearMissed: false, lost: false, shakes: 0, shakeT: 0,
    };
    this.units.push(u);
    return u;
  }

  private setPhase(u: Unit, p: Unit['phase']) {
    u.phase = p;
    u.phaseT = 0;
  }

  /** Any live track prop overlapping lane `lane` over [s0, s1]? */
  private propIn(lane: number, s0: number, s1: number): boolean {
    const c = this.sim.track.laneCenter(lane);
    for (const p of this.sim.track.propsBetween(s0, s1)) if (Math.abs(p.d - c) < p.hw + 1.0) return true;
    return false;
  }

  private aheadThreatActive(): boolean {
    return this.units.some((u) => u.alive && u.unit !== 'cruiser' && u.unit !== 'chopper' && !u.lost && u.s > this.sim.giant.s - 10);
  }

  step(dt: number) {
    const sim = this.sim;
    const P = TUNING.pursuit;
    if (sim.show.state !== 'live') return;
    // Spawning (§19 by Heat).
    if (sim.time >= P.firstAt) {
      const H = P.byHeat[sim.show.heat - 1];
      this.spawnT += dt * (this.marked ? P.chopper.spawnBoost : 1);
      const active = this.units.filter((u) => u.alive && !u.lost).length;
      if (this.spawnT >= H.cadence && active < H.cap) {
        const kinds = H.kinds.filter((k) => this.allowed(k));
        if (kinds.length) {
          let total = 0;
          for (const k of kinds) total += P.weights[k];
          let r = this.rng.next() * total;
          let pick = kinds[0];
          for (const k of kinds) if ((r -= P.weights[k]) < 0) {
            pick = k;
            break;
          }
          this.spawnT = this.spawn(pick) ? 0 : H.cadence - 1;
        } else this.spawnT = H.cadence - 1;
      }
    }
    // Car Carrier Spill: traffic on its own timer (one at a time, never near a ramp or another threat ahead).
    if (sim.time >= this.carrierAt) {
      const C = TUNING.pursuit.carrier;
      if (this.allowed('carrier') && this.spawnCarrier()) this.carrierAt = sim.time + this.rng.range(C.every[0], C.every[1]);
      else this.carrierAt = sim.time + 3;
    }
    for (const u of this.units) if (u.alive) this.update(u, dt);
    // Tidy: units well behind are gone.
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i];
      const behind = sim.giant.s - u.s;
      const done = u.lost || u.phase === 'leave' || u.unit === 'spike' || u.unit === 'roadblock' || u.unit === 'carrier';
      if (u.unit === 'chopper' && u.phase === 'leave' && u.phaseT >= P.chopper.leaveTime) u.alive = false;
      // Units driving off ahead (a finished net's truck, a carrier) go once well out of sight.
      const gone = u.phase === 'leave' && -behind > 300;
      if (!u.alive || gone || (done && behind > P.removeBehind) || behind > P.spawnBehind + 20) this.units.splice(i, 1);
    }
  }

  private allowed(k: UnitKind): boolean {
    const sim = this.sim;
    if (k === 'net') {
      const N = TUNING.pursuit.net;
      if (this.nets >= N.perSegment[sim.show.heat - 1] || sim.time - this.netAt < N.minGap) return false;
      if (this.units.some((u) => u.alive && (u.unit === 'net' || u.unit === 'rolling' || u.unit === 'carrier'))) return false;
    }
    if (k === 'cruiser') return this.units.filter((u) => u.alive && u.unit === 'cruiser' && !u.lost).length < 2;
    if (k === 'chopper') {
      if (this.units.some((u) => u.alive && u.unit === 'chopper') || sim.time - this.chopperAt < TUNING.pursuit.chopper.every) return false;
      if (this.units.some((u) => u.alive && u.phase === 'tell') || this.aheadThreatActive()) return false;
      const ex = sim.exit;
      return !(ex && ex.gore - sim.giant.s < 320 && ex.gore > sim.giant.s);
    }
    if (this.aheadThreatActive()) return false;
    // One tell at a time: no threat ahead while a cruiser is closing in or winding up.
    if (this.units.some((u) => u.alive && u.unit === 'cruiser' && !u.lost && u.phase !== 'leave' && u.s > sim.giant.s - 40)) return false;
    // Never on the approach to the sign-off ramp, or to a fork's gore (the choice must be readable).
    const ex = sim.exit;
    if (ex && ex.gore - sim.giant.s < 320 && ex.gore > sim.giant.s) return false;
    const fk = sim.fork;
    if (fk && fk.gore - sim.giant.s < TUNING.forks.clearOfExit && fk.gore > sim.giant.s) return false;
    return true;
  }

  private spawn(k: UnitKind): boolean {
    switch (k) {
      case 'cruiser': return this.spawnCruiser();
      case 'rolling': return this.spawnRolling();
      case 'spike': return this.spawnSpike();
      case 'roadblock': return this.spawnRoadblock();
      case 'chopper': return this.spawnChopper();
      case 'net': return this.spawnNet();
      case 'carrier': return this.spawnCarrier();
    }
  }

  // --- Police Net -------------------------------------------------------------------

  /** The armoured truck takes his lane ahead; two flankers come up from behind in the lanes either side. */
  private spawnNet(): boolean {
    const sim = this.sim;
    const g = sim.giant;
    const P = TUNING.pursuit;
    const N = P.net;
    const track = sim.track;
    if (g.s < P.spawnBehind + 2) return false;
    const s = this.aheadSpot();
    track.ensure(s + 260);
    const L = track.lanesAt(s);
    if (L < 2) return false;
    // No merge where the box closes (from him to well past the truck); flankers coming up from behind just follow their lane.
    for (let x = g.s; x <= s + 150; x += 10) if (track.lanesAt(x) !== L) return false;
    const lane = Math.min(g.lane, L - 1);
    const grp = this.group++;
    const truck = this.make('armored', 'net', s, track.laneCenter(lane), lane);
    truck.group = grp;
    truck.speed = g.speed * N.cruiseFactor;
    for (const side of [-1, 1]) {
      const fl = lane + side;
      if (fl < 0 || fl >= L) continue; // the road edge is the wall on that side
      const u = this.make('cruiser', 'net', g.s - P.spawnBehind, track.laneCenter(fl), fl);
      u.group = grp;
      u.target = side; // its side of the truck, kept for the whole net
      u.ram = true;
      u.cls = 'immovable';
      u.speed = g.speed + N.flankClose;
    }
    this.nets++;
    this.netAt = sim.time;
    this.outOfBox.set(grp, 0);
    sim.emitPublic({ type: 'unitSpawn', id: truck.id, kind: 'net', s, d: truck.d, lanes: [lane] });
    return true;
  }

  private updateNet(u: Unit, dt: number) {
    const sim = this.sim;
    const g = sim.giant;
    const N = TUNING.pursuit.net;
    const track = sim.track;
    const crew = this.units.filter((x) => x.alive && x.group === u.group);
    const truck = crew.find((x) => x.kind === 'armored');
    const isTruck = u === truck;
    const W = TUNING.lanes.width;
    switch (u.phase) {
      case 'approach': {
        if (isTruck) {
          // Hold his lane ahead until its tell (on screen), then the whole crew winds up.
          u.lane = Math.min(g.lane, track.lanesAt(u.s) - 1);
          if (u.s - g.s <= Math.min(N.tellMax, Math.max(N.tellMin, g.speed * N.tellAhead))) {
            for (const x of crew) this.setPhase(x, 'tell');
            sim.emitPublic({ type: 'tell', id: u.id, kind: 'net', lane: u.lane, time: N.tell });
          }
        } else if (truck) this.flankLane(u, truck);
        break;
      }
      case 'tell':
        // The truck keeps sliding into his lane through the warning (beat it with a late, committed move); the flankers follow it.
        if (isTruck) u.lane = Math.min(g.lane, track.lanesAt(u.s) - 1);
        else if (truck) this.flankLane(u, truck);
        if (u.phaseT >= N.tell) this.setPhase(u, 'act');
        break;
      case 'act': {
        if (!isTruck) {
          if (truck && u.phaseT === dt) this.flankLane(u, truck); // the box closes: an outside flanker with no lane peels off now
          break;
        }
        // Contained: the truck close ahead in his lane and every flanker alongside him.
        const flankers = crew.filter((x) => x !== truck);
        const inBox = u.s - g.s < 30 && u.s > g.s && Math.abs(u.d - g.d) < W * 0.6 && flankers.every((f) => Math.abs(f.s - g.s) < 7);
        const out = inBox ? 0 : (this.outOfBox.get(u.group) ?? 0) + dt;
        this.outOfBox.set(u.group, out);
        if (out >= N.escapeAfter || u.phaseT >= N.actMax) {
          // He got out (or they gave up): the net breaks up and he's shaken them.
          for (const x of crew) {
            this.setPhase(x, 'leave');
            x.hit = true;
          }
          sim.emitPublic({ type: 'netEscape', id: u.id });
          sim.award('lostTrack');
        }
        break;
      }
    }
    // Movement. The truck: cruise, then brake to a crawl in front of him; drive off when it's over.
    if (isTruck) {
      if (u.phase === 'approach' || u.phase === 'tell') u.speed = Math.max(u.speed, g.speed * N.cruiseFactor);
      else if (u.phase === 'act') u.speed = Math.max(N.crawl, u.speed - N.decel * dt);
      else u.speed = Math.min(g.speed + 8, u.speed + N.decel * dt);
    } else if (u.phase === 'leave') {
      // Dropping back out of the chase: no longer in his way (a stopped flanker must never hold him up).
      u.solid = false;
      u.speed = Math.max(0, Math.min(u.speed, g.speed) - N.flankDecel * dt);
    } else {
      // Flankers: close from behind and come up alongside him; once it's closed, hold the slot beside the truck
      // where he's pressed up behind it, so the box keeps its shape (braking to the floor drops him out the back).
      const slot = u.phase === 'act' && truck ? truck.s - truck.hl - TUNING.giant.radius * 1.3 : g.s;
      const pace = u.phase === 'act' && truck ? truck.speed : g.speed;
      const want = u.s < slot - 4 ? pace + N.flankClose : pace + (slot - u.s) * 1.5;
      // Coming alongside they can only brake so hard (a late brake still beats them); once it's closed they hold the slot hard.
      const decel = u.phase === 'act' ? N.flankHold : N.flankDecel;
      u.speed += Math.max(-decel * dt, Math.min(N.flankAccel * dt, want - u.speed));
    }
    u.s += u.speed * dt;
    const target = track.laneCenter(Math.max(0, Math.min(track.lanesAt(u.s) - 1, u.lane)));
    u.d += Math.max(-N.flankSide * dt, Math.min(N.flankSide * dt, target - u.d));
    // The crew ploughs through what's in its lane (armoured; nothing stops it), in the chopper's frame.
    for (const p of track.propsBetween(u.s - u.hl, u.s + u.hl + 1)) {
      if (!p.alive || Math.abs(p.d - u.d) >= p.hw + u.hw) continue;
      p.alive = false;
      sim.emitPublic({ type: 'policeSmash', id: u.id, propId: p.id, cls: p.cls, mat: p.mat, s: p.s, d: p.d, speed: Math.max(u.speed, 6) });
    }
  }

  /** A flanker keeps its side of the truck; if that side is the road edge, the edge is the wall and it peels off. */
  private flankLane(u: Unit, truck: Unit) {
    const lane = truck.lane + u.target;
    if (lane < 0 || lane >= this.sim.track.lanesAt(u.s)) {
      // Off the road on that side: hold its lane while the truck may still move; once the box closes, the edge is the wall.
      if (u.phase === 'act') {
        this.setPhase(u, 'leave');
        u.hit = true;
      }
      return;
    }
    u.lane = lane;
  }

  // --- Car Carrier Spill -----------------------------------------------------------

  private spawnCarrier(): boolean {
    const sim = this.sim;
    const g = sim.giant;
    const C = TUNING.pursuit.carrier;
    const track = sim.track;
    const s = this.aheadSpot();
    track.ensure(s + 220);
    const L = track.lanesAt(s);
    if (L < 2) return false;
    for (let x = s - 10; x <= s + 200; x += 10) if (track.lanesAt(x) !== L) return false;
    const options = Array.from({ length: L }, (_, i) => i).filter((l) => l !== g.lane);
    const lane = options[this.rng.int(0, options.length - 1)];
    // Its own lane, ≥100m ahead (never visible): clear for it to drive down.
    const c = track.laneCenter(lane);
    for (const p of track.propsBetween(s - 10, s + 200)) if (Math.abs(p.d - c) < p.hw + 1.4) p.alive = false;
    const u = this.make('carrier', 'carrier', s, c, lane);
    u.speed = g.speed * C.cruiseFactor;
    u.drops = C.drops;
    u.dropT = 0;
    sim.emitPublic({ type: 'unitSpawn', id: u.id, kind: 'carrier', s, d: c, lanes: [lane] });
    return true;
  }

  private updateCarrier(u: Unit, dt: number) {
    const sim = this.sim;
    const g = sim.giant;
    const C = TUNING.pursuit.carrier;
    const track = sim.track;
    const W = TUNING.lanes.width;
    const ahead = u.s - g.s;
    const onScreen = Math.min(C.tellMax, Math.max(C.tellMin, g.speed * C.tellAhead));
    if (u.phase === 'approach') {
      // Cruise until it's in the frame (its tell, like every tell, starts on screen) ...
      u.speed = Math.max(u.speed, g.speed * C.cruiseFactor);
      if (ahead <= onScreen) {
        this.setPhase(u, 'act');
        u.dropT = C.firstDrop;
        sim.emitPublic({ type: 'tell', id: u.id, kind: 'carrier', lane: u.lane, time: C.firstDrop });
      }
    } else if (u.phase === 'act') {
      // ... then hold station near the top of the frame while it sheds its load.
      u.speed = g.speed + (onScreen - ahead) * 1.2;
    } else u.speed += C.leaveSpeed * dt;
    u.s += u.speed * dt;
    if (u.phase !== 'act') return;
    u.dropT = (u.dropT ?? 0) - dt;
    if (u.dropT > 0) return;
    u.dropT = C.dropEvery;
    const at = u.s - u.hl - 2;
    if (at - g.s < g.speed * C.dropLead) return; // he'd have no time to see it land
    const L = track.lanesAt(at);
    const options = [u.lane, u.lane - 1, u.lane + 1].filter((l) => l >= 0 && l < L);
    for (let tries = 0; tries < options.length; tries++) {
      const lane = options[this.rng.int(0, options.length - 1)];
      // Never the drop that closes the last open lane there.
      const blocked = new Set<number>([lane]);
      for (const p of track.propsBetween(at - 5, at + 5)) if (p.alive) blocked.add(Math.floor(p.d / W));
      if (blocked.size >= L) continue;
      const p = track.drop('car', at, track.laneCenter(lane) + this.rng.range(-0.4, 0.4));
      sim.emitPublic({ type: 'carrierDrop', carrierId: u.id, propId: p.id, s: p.s, d: p.d });
      u.drops = (u.drops ?? 1) - 1;
      if (u.drops <= 0) this.setPhase(u, 'leave');
      break;
    }
  }


  // --- Cruiser ram ---------------------------------------------------------------

  private spawnCruiser(): boolean {
    const sim = this.sim;
    const g = sim.giant;
    const P = TUNING.pursuit;
    if (g.s < P.spawnBehind + 2) return false;
    const s = g.s - P.spawnBehind;
    const lanes = sim.track.lanesAt(s);
    const sides = [-1, 1].filter((d) => g.lane + d >= 0 && g.lane + d < lanes);
    if (!sides.length) return false;
    const lane = g.lane + sides[this.rng.int(0, sides.length - 1)];
    const u = this.make('cruiser', 'cruiser', s, sim.track.laneCenter(lane), lane);
    u.speed = g.speed + P.cruiser.closeSpeed;
    sim.emitPublic({ type: 'unitSpawn', id: u.id, kind: 'cruiser', s, d: u.d, lanes: [lane] });
    return true;
  }

  private updateCruiser(u: Unit, dt: number) {
    const sim = this.sim;
    const g = sim.giant;
    const C = TUNING.pursuit.cruiser;
    const track = sim.track;
    const lanes = track.lanesAt(u.s);
    if (u.phase === 'tell' || u.phase === 'act') {
      // Traffic where it's swerving: it backs off (and has lost him).
      if ([u.lane, u.target].some((l) => l >= 0 && this.propIn(l, u.s - u.hl, u.s + u.hl + 2))) {
        this.setPhase(u, 'leave');
        return;
      }
    }
    switch (u.phase) {
      case 'approach': {
        const close = u.s >= g.s - 9;
        if (!close) {
          // Far behind: ride the giant's own path (it's clear: he smashed or avoided everything).
          u.speed = g.speed + C.closeSpeed;
          u.s += u.speed * dt;
          const pd = sim.escort.pathAt(u.s);
          u.d += clamp(pd - u.d, -C.sideSpeed * 2 * dt, C.sideSpeed * 2 * dt);
          u.lane = clamp(Math.round(u.d / TUNING.lanes.width - 0.5), 0, lanes - 1);
          u.phaseT = 0; // the give-up clock only runs once it's close
          break;
        }
        // Close: pull into a clear lane next to his and come alongside.
        // It watches him, not the road: only what's just ahead of it counts.
        const clear = (l: number) => l >= 0 && l < lanes && l !== g.lane && !this.propIn(l, u.s - u.hl - 2, Math.max(u.s + u.hl + TUNING.pursuit.crash.react, g.s + 2));
        if (u.lane !== g.lane && Math.abs(u.d - g.d) < TUNING.lanes.width * 1.5 && !clear(u.lane)) {
          // Alongside him and its lane is blocked just ahead: the only way out is away from him.
          const away = u.lane + Math.sign(u.lane - g.lane);
          if (clear(away)) u.lane = away;
        } else if (!clear(u.lane) || Math.abs(u.lane - g.lane) !== 1) {
          const opts = [g.lane - 1, g.lane + 1].filter(clear);
          if (opts.length) u.lane = opts.reduce((a, b) => (Math.abs(track.laneCenter(a) - u.d) <= Math.abs(track.laneCenter(b) - u.d) ? a : b));
        }
        const cd = track.laneCenter(u.lane);
        u.d += clamp(cd - u.d, -C.sideSpeed * dt, C.sideSpeed * dt);
        const inPlace = Math.abs(u.d - cd) < 0.05 && Math.abs(u.lane - g.lane) === 1 && clear(u.lane);
        if (!inPlace || u.s < g.s - 2.5) {
          // Hang back until the lane is clear, then close up.
          // Alongside him it's fixated: it keeps pace even when its lane is blocked ahead (lead it into
          // something Heavy and it crashes). Otherwise it hangs back 9m until a lane opens.
          const fixated = u.s >= g.s - 4 && Math.abs(u.lane - g.lane) === 1;
          u.speed = inPlace ? g.speed + C.closeSpeed * 0.5 : g.speed;
          u.s = fixated && !inPlace ? u.s + u.speed * dt : Math.min(u.s + u.speed * dt, g.s - (inPlace ? 0 : 9));
          if (u.phaseT > 8) this.setPhase(u, 'leave'); // never found a way in
        } else {
          u.speed = g.speed;
          u.s += g.speed * dt + (g.s - u.s) * Math.min(1, dt * 3);
          // Only wind up if both lanes stay clear through the windup and swerve.
          const reach = u.s + u.hl + g.speed * (C.tell + C.swerve) + 3;
          const room = !this.propIn(u.lane, u.s - u.hl, reach) && !this.propIn(g.lane, u.s - u.hl, reach);
          if (!g.move && room && !this.sim.tellBusy(u) && !this.aheadThreatActive()) {
            u.target = g.lane;
            u.fromD = u.d;
            this.setPhase(u, 'tell');
            sim.emitPublic({ type: 'tell', id: u.id, kind: 'cruiser', lane: u.target, time: C.tell });
          }
        }
        break;
      }
      case 'tell': {
        // Blinker + drift toward the target lane.
        u.speed = g.speed;
        u.s += g.speed * dt + (g.s - u.s) * Math.min(1, dt * 3);
        const dir = Math.sign(track.laneCenter(u.target) - u.fromD);
        u.d = u.fromD + dir * C.drift * Math.min(1, u.phaseT / C.tell);
        if (u.phaseT >= C.tell) {
          u.fromD = u.d;
          u.toD = track.laneCenter(u.target);
          this.setPhase(u, 'act');
        }
        break;
      }
      case 'act': {
        u.speed = g.speed;
        u.s += g.speed * dt;
        const k = Math.min(1, u.phaseT / C.swerve);
        u.d = u.fromD + (u.toD - u.fromD) * smoothstep(k);
        if (k >= 1) {
          u.lane = u.target;
          sim.emitPublic({ type: 'ram', id: u.id, hit: u.hit });
          this.setPhase(u, 'leave');
        }
        break;
      }
      case 'leave': {
        // Falls back, never parks: it always moves, and it pulls out of his lane so it can't wall him in.
        // In his way and level with or ahead of him, it speeds up to clear him rather than sit in front.
        const inWay = this.inHisWay(u);
        u.speed = inWay && u.s >= g.s - u.hl ? g.speed + C.fallBack * 0.5 : Math.max(g.speed * 0.4, g.speed - C.fallBack);
        u.s += u.speed * dt;
        if (inWay) {
          const opts = [g.lane - 1, g.lane + 1].filter((l) => l >= 0 && l < lanes);
          if (opts.length) {
            u.lane = opts.reduce((a, b) => (Math.abs(track.laneCenter(a) - u.d) <= Math.abs(track.laneCenter(b) - u.d) ? a : b));
            u.d += clamp(track.laneCenter(u.lane) - u.d, -C.sideSpeed * dt, C.sideSpeed * dt);
          }
        }
        break;
      }
    }
  }

  // --- Rolling roadblock --------------------------------------------------------------

  private aheadSpot(): number {
    const g = this.sim.giant;
    return g.s + Math.max(TUNING.pursuit.spawnAheadMin, g.speed * 8);
  }

  private spawnRolling(): boolean {
    const sim = this.sim;
    const g = sim.giant;
    const R = TUNING.pursuit.rolling;
    const s = this.aheadSpot();
    const track = sim.track;
    track.ensure(s + 220);
    const L = track.lanesAt(s);
    for (let x = s - 10; x <= s + 200; x += 10) if (track.lanesAt(x) !== L) return false; // no merges under it
    const n = L >= 3 ? L - 1 : L;
    const lanes = Array.from({ length: L }, (_, i) => i);
    if (L >= 3) lanes.splice(this.rng.int(0, L - 1), 1);
    const weak = this.rng.int(0, n - 1);
    // Rolling Blockade: from Heat 3 one car in the line is the armoured truck (never the weak link).
    const B = TUNING.pursuit.blockade;
    const armored = sim.show.heat >= B.armoredFrom && n >= 2 ? (weak + 1 + this.rng.int(0, n - 2)) % n : -1;
    // Clear its path of lane props. All ≥100m ahead, so nothing visible pops.
    for (const p of track.propsBetween(s - 10, s + 200)) if (lanes.some((l) => Math.abs(p.d - track.laneCenter(l)) < p.hw + 1.2)) p.alive = false;
    const grp = this.group++;
    const cruise = g.speed * R.cruiseFactor;
    lanes.forEach((lane, i) => {
      const u = this.make(i === weak ? 'compact' : i === armored ? 'armored' : 'cruiser', 'rolling', s, track.laneCenter(lane), lane);
      u.group = grp;
      u.speed = cruise;
    });
    this.shiftT.set(grp, B.shiftEvery);
    sim.emitPublic({ type: 'unitSpawn', id: this.nextId - 1, kind: 'rolling', s, d: track.laneCenter(lanes[0]), lanes });
    return true;
  }

  /**
   * Rolling Blockade: with 3+ lanes, the gap moves. Every `shiftEvery` s a car beside the gap slides into it
   * (never into his lane while he's within 10m of the row), so the open lane is a moving target.
   */
  private shiftGap(u: Unit, dt: number) {
    const sim = this.sim;
    const g = sim.giant;
    const B = TUNING.pursuit.blockade;
    const track = sim.track;
    const row = this.units.filter((x) => x.alive && x.group === u.group);
    const L = track.lanesAt(u.s);
    if (L < 3 || row.length !== L - 1) return;
    const t = (this.shiftT.get(u.group) ?? B.shiftEvery) - dt;
    this.shiftT.set(u.group, t);
    if (t > 0 || row.some((x) => Math.abs(x.d - x.toD) > 0.05)) return;
    this.shiftT.set(u.group, B.shiftEvery);
    const taken = new Set(row.map((x) => x.lane));
    const gap = Array.from({ length: L }, (_, i) => i).find((l) => !taken.has(l));
    if (gap === undefined) return;
    if (gap === g.lane && Math.abs(u.s - g.s) < 10) return;
    const movers = row.filter((x) => Math.abs(x.lane - gap) === 1);
    if (!movers.length) return;
    const m = movers[this.rng.int(0, movers.length - 1)];
    m.fromD = m.d;
    m.toD = track.laneCenter(gap);
    m.lane = gap;
  }

  private updateRolling(u: Unit, dt: number) {
    const sim = this.sim;
    const g = sim.giant;
    const R = TUNING.pursuit.rolling;
    const lead = this.units.find((x) => x.alive && x.group === u.group) === u;
    switch (u.phase) {
      case 'approach':
        if (u.s - g.s <= Math.min(R.tellMax, Math.max(R.tellMin, g.speed * R.tellAhead))) {
          for (const x of this.units) if (x.group === u.group && x.alive) this.setPhase(x, 'tell');
          if (lead) sim.emitPublic({ type: 'tell', id: u.id, kind: 'rolling', lane: u.lane, time: R.tell });
        }
        break;
      case 'tell':
        if (u.phaseT >= R.tell) this.setPhase(u, 'act');
        break;
      case 'act':
        u.speed = Math.max(R.crawl, u.speed - R.decel * dt);
        if (u.phaseT >= R.actMax) this.setPhase(u, 'leave');
        if (lead) this.shiftGap(u, dt);
        break;
      case 'leave':
        u.speed = Math.min(g.speed + 5, u.speed + R.decel * dt);
        break;
    }
    u.s += u.speed * dt;
    // A blockade car sliding across into the gap (blinker on in the view).
    if (Math.abs(u.toD - u.d) > 1e-3) {
      const step = (TUNING.lanes.width / TUNING.pursuit.blockade.shiftTime) * dt;
      u.d += Math.max(-step, Math.min(step, u.toD - u.d));
    }
  }

  // --- Spike strip ----------------------------------------------------------------

  private spawnSpike(): boolean {
    const sim = this.sim;
    const g = sim.giant;
    const S = TUNING.pursuit.spike;
    let s = g.s + Math.max(S.aheadMin, g.speed * (S.aheadTime + 1.5));
    for (let tries = 0; tries < 20 && this.propIn(g.lane, s - 6, s + 6); tries++) s += 3;
    if (this.propIn(g.lane, s - 6, s + 6)) return false;
    const u = this.make('barricade', 'spike', s, sim.track.laneCenter(g.lane), g.lane);
    u.solid = false;
    u.hl = 0.35;
    u.hw = 1.8;
    u.cls = 'immovable';
    sim.emitPublic({ type: 'unitSpawn', id: u.id, kind: 'spike', s, d: u.d, lanes: [g.lane] });
    return true;
  }

  private updateSpike(u: Unit) {
    const sim = this.sim;
    const g = sim.giant;
    const S = TUNING.pursuit.spike;
    if (u.phase === 'approach' && u.s - g.s <= Math.min(S.tellMax, g.speed * S.tellAhead + 2)) {
      // Targets you: unrolls across whichever lane you're in now.
      const lane = clamp(g.lane, 0, sim.track.lanesAt(u.s) - 1);
      if (!this.propIn(lane, u.s - 6, u.s + 6)) {
        u.lane = lane;
        u.d = sim.track.laneCenter(lane);
      }
      this.setPhase(u, 'tell');
      sim.emitPublic({ type: 'tell', id: u.id, kind: 'spike', lane: u.lane, time: S.tell });
    } else if (u.phase === 'tell' && u.phaseT >= S.tell) this.setPhase(u, 'act');
    // Leaping over it or riding a hijacked car through it: no effect.
    if (u.phase === 'act' && !u.hit && g.air <= 0 && g.ride <= 0 && Math.abs(g.s - u.s) < u.hl + 0.5 && Math.abs(g.d - u.d) < u.hw + 0.3) {
      u.hit = true;
      sim.spikeHit(u);
    }
  }

  // --- Static roadblock ---------------------------------------------------------------

  private spawnRoadblock(): boolean {
    const sim = this.sim;
    const g = sim.giant;
    const B = TUNING.pursuit.roadblock;
    const track = sim.track;
    let s = g.s + Math.max(TUNING.pursuit.spawnAheadMin + 20, g.speed * B.aheadTime);
    track.ensure(s + 100);
    for (let tries = 0; tries < 30; tries++, s += 3) {
      const L = track.lanesAt(s);
      if (L < 2 || track.lanesAt(s - 12) !== L || track.lanesAt(s + 12) !== L) continue;
      if (track.propsBetween(s - 7, s + 7).length) continue;
      // The gap must be clear from the approach on, for any tier.
      const gaps = Array.from({ length: L }, (_, i) => i).filter((l) => !this.propIn(l, s - 30, s + 8));
      if (!gaps.length) continue;
      const gap = gaps[this.rng.int(0, gaps.length - 1)];
      const grp = this.group++;
      const w = track.widthAt(s);
      const ids: number[] = [];
      for (let lane = 0; lane < L; lane++) {
        if (lane === gap) continue;
        const left = lane < gap;
        const park = left ? -3.2 : w + 3.2;
        const u = this.make('cruiser', 'roadblock', s + (lane - gap) * 0.6, park, lane);
        u.group = grp;
        u.fromD = park;
        u.toD = track.laneCenter(lane);
        u.target = gap;
        u.solid = false; // parked behind the barrier until it slides in
        ids.push(lane);
      }
      sim.emitPublic({ type: 'unitSpawn', id: this.nextId - 1, kind: 'roadblock', s, d: track.laneCenter(gap), lanes: ids });
      return true;
    }
    return false;
  }

  private updateRoadblock(u: Unit) {
    const sim = this.sim;
    const g = sim.giant;
    const B = TUNING.pursuit.roadblock;
    if (u.phase === 'approach' && u.s - g.s <= Math.min(B.slideMax, g.speed * B.slideAhead + 2)) {
      const first = this.units.find((x) => x.alive && x.group === u.group) === u;
      for (const x of this.units) if (x.group === u.group && x.alive && x.phase === 'approach') {
        this.setPhase(x, 'act');
        x.solid = true;
      }
      if (first) sim.emitPublic({ type: 'tell', id: u.id, kind: 'roadblock', lane: u.target, time: B.tell });
    }
    if (u.phase === 'act') {
      const k = Math.min(1, u.phaseT / B.tell);
      u.d = u.fromD + (u.toD - u.fromD) * smoothstep(k);
    }
  }

  // --- Police chopper spotlight -----------------------------------------------------------

  private spawnChopper(): boolean {
    const sim = this.sim;
    const g = sim.giant;
    const s = this.aheadSpot();
    const w = sim.track.widthAt(s);
    // The pool starts over the far side of the road, ahead and off the top of the frame.
    const d = g.d < w / 2 ? w - 1.5 : 1.5;
    const u = this.make('barricade', 'chopper', s, d, g.lane);
    u.solid = false;
    u.cls = 'immovable';
    u.hl = 0;
    u.hw = 0;
    u.h = 0;
    this.chopperAt = sim.time;
    sim.emitPublic({ type: 'unitSpawn', id: u.id, kind: 'chopper', s, d, lanes: [g.lane] });
    return true;
  }

  private chopperLose(u: Unit, award: boolean) {
    u.lost = true;
    this.setPhase(u, 'leave');
    u.fromD = u.d;
    if (award) {
      this.sim.emitPublic({ type: 'lostTrack', id: u.id, kind: 'chopper' });
      this.sim.award('lostTrack');
    }
  }

  private updateChopper(u: Unit, dt: number) {
    const sim = this.sim;
    const g = sim.giant;
    const H = TUNING.pursuit.chopper;
    const tellAt = Math.min(H.tellMax, g.speed * H.tellAhead + 2);
    const hold = Math.max(H.holdMin, g.speed * H.holdAhead + 20);
    const tunnel = sim.track.segmentAt(g.s).zone === 'tunnel';
    switch (u.phase) {
      case 'approach': {
        // Hover off the top of the frame until nothing else is winding up, then sweep in.
        const free = !tunnel && !sim.tellBusy(u) && !this.units.some((x) => x.alive && x !== u && x.unit !== 'chopper' && x.unit !== 'cruiser' && x.phase === 'approach' && x.s - g.s < 90)
          ;
        const want = free ? tellAt : hold;
        const gap = u.s - g.s;
        u.s = g.s + Math.max(want, gap - (gap > want ? H.sweepInSpeed * dt : 0));
        if (!free) u.s = Math.max(u.s, g.s + Math.min(gap, hold));
        if (free && u.s - g.s <= tellAt + 0.01) {
          u.lane = g.lane;
          u.fromD = u.d;
          this.setPhase(u, 'tell');
          sim.emitPublic({ type: 'tell', id: u.id, kind: 'chopper', lane: g.lane, time: H.tell });
        } else if (u.phaseT > H.giveUp) this.chopperLose(u, false);
        break;
      }
      case 'tell': {
        // The cone sweeps across and down the road onto him.
        const k = smoothstep(Math.min(1, u.phaseT / H.tell));
        u.s = g.s + tellAt * (1 - k);
        u.d = u.fromD + (g.d - u.fromD) * k;
        if (u.phaseT >= H.tell) {
          u.lane = g.lane;
          u.shakes = 0;
          u.shakeT = 0;
          this.setPhase(u, 'act');
          sim.emitPublic({ type: 'spotlight', id: u.id, lane: g.lane });
        }
        break;
      }
      case 'act': {
        // Locked: the pool rides with him and lags his lane changes, so each one visibly pulls him out of it.
        u.s = g.s;
        u.d += clamp(g.d - u.d, -H.trackSpeed * dt, H.trackSpeed * dt);
        u.shakeT += dt;
        if (u.shakeT > H.shakeWindow) u.shakes = 0;
        if (g.move === null && g.lane !== u.lane) {
          u.lane = g.lane;
          u.shakes = u.shakeT <= H.shakeWindow || u.shakes === 0 ? u.shakes + 1 : 1;
          u.shakeT = 0;
        }
        if (u.shakes >= H.shakes || tunnel) this.chopperLose(u, true);
        else if (u.phaseT >= H.lockMax) this.chopperLose(u, false);
        break;
      }
      case 'leave': {
        // Sweeps off ahead and away.
        u.s = g.s + u.phaseT * 30;
        u.d = u.fromD + (u.fromD < sim.track.widthAt(u.s) / 2 ? -1 : 1) * u.phaseT * 8;
        break;
      }
    }
  }

  /** A leaving cruiser still overlapping his lane near him (it must clear out before anything else). */
  private inHisWay(u: Unit): boolean {
    const g = this.sim.giant;
    return u.s > g.s - 10 && Math.abs(u.d - g.d) < TUNING.lanes.width * 0.9;
  }

  // --- Police crashes --------------------------------------------------------------

  /** A chasing cruiser hits what's in its lane: ploughs through Medium, crashes out on Heavy. */
  private crashCheck(u: Unit) {
    const sim = this.sim;
    const g = sim.giant;
    const K = TUNING.pursuit.crash;
    if (u.s < g.s - K.visibleBehind) return; // out of the chopper's frame: not news, no crash
    const track = sim.track;
    // Last-moment swerve: a clear neighbouring lane that isn't his.
    if (u.phase === 'leave' || (u.phase === 'approach' && u.s >= g.s - 9)) {
      const lanes = track.lanesAt(u.s);
      const lane = clamp(Math.round(u.d / TUNING.lanes.width - 0.5), 0, lanes - 1);
      const heavyAhead = (l: number) => track.propsBetween(u.s, u.s + u.hl + K.react).some((p) => p.cls !== 'medium' && p.cls !== 'light' && Math.abs(p.d - track.laneCenter(l)) < p.hw + u.hw);
      if (u.phase === 'leave' && !this.inHisWay(u) && heavyAhead(lane)) {
        const opts = [lane - 1, lane + 1].filter((l) => l >= 0 && l < lanes && l !== g.lane && !this.propIn(l, u.s - u.hl, u.s + u.hl + K.react));
        if (opts.length) {
          u.lane = opts[0];
          u.d += clamp(track.laneCenter(u.lane) - u.d, -TUNING.pursuit.cruiser.sideSpeed * 2 * this.sim.dt, TUNING.pursuit.cruiser.sideSpeed * 2 * this.sim.dt);
        }
      }
    }
    for (const p of track.propsBetween(u.s - u.hl - 3, u.s + u.hl + 3)) {
      if (!p.alive) continue;
      if (Math.abs(p.s - u.s) >= p.hl + u.hl || Math.abs(p.d - u.d) >= p.hw + u.hw - 0.15) continue;
      if (p.cls === 'medium' || p.cls === 'light') {
        p.alive = false;
        u.speed *= K.plowKeep;
        sim.emitPublic({ type: 'policeSmash', id: u.id, propId: p.id, cls: p.cls, mat: p.mat, s: p.s, d: p.d, speed: u.speed });
        sim.award('collateral');
        continue;
      }
      // Heavy or immovable: out of the chase. A Heavy prop goes flying with it.
      const smashed = p.cls === 'heavy';
      if (smashed) p.alive = false;
      u.alive = false;
      u.lost = true;
      sim.emitPublic({ type: 'policeCrash', id: u.id, propId: p.id, propKind: p.kind, propCls: p.cls, propSmashed: smashed, s: u.s, d: u.d, speed: Math.max(u.speed, g.speed) });
      sim.award('policeCrash');
      return;
    }
  }

  private update(u: Unit, dt: number) {
    u.phaseT += dt;
    switch (u.unit) {
      case 'cruiser': this.updateCruiser(u, dt); break;
      case 'rolling': this.updateRolling(u, dt); break;
      case 'spike': this.updateSpike(u); break;
      case 'roadblock': this.updateRoadblock(u); break;
      case 'chopper': this.updateChopper(u, dt); break;
      case 'net': this.updateNet(u, dt); break;
      case 'carrier': this.updateCarrier(u, dt); break;
    }
    if (u.unit === 'cruiser' && u.alive) this.crashCheck(u);
    if (!u.alive) return;
    this.checkNearAndLost(u);
  }

  /** §12 near-miss (+3) and "pursuer loses track" (+6). */
  private checkNearAndLost(u: Unit) {
    const sim = this.sim;
    const g = sim.giant;
    const P = TUNING.pursuit;
    if (u.unit === 'spike' || u.unit === 'roadblock' || u.unit === 'chopper' || u.unit === 'net' || u.unit === 'carrier') return;
    // A near-miss (§12) is judged once the pass is over: the closest he came during the
    // swerve (or the crawl past), if it never connected.
    const passing = u.phase === 'act' || (u.unit === 'rolling' && u.phase === 'leave');
    if (passing && !u.hit) {
      const ds = Math.max(0, Math.abs(u.s - g.s) - u.hl);
      const dd = Math.max(0, Math.abs(u.d - g.d) - u.hw);
      const gap = Math.hypot(ds, dd) - this.sim.radius();
      this.closest.set(u.id, Math.min(this.closest.get(u.id) ?? Infinity, gap));
    }
    const over = u.unit === 'cruiser' ? u.phase === 'leave' : g.s - u.s > u.hl + 2;
    if (over && !u.hit && !u.nearMissed && (this.closest.get(u.id) ?? Infinity) < P.nearMiss) {
      u.nearMissed = true;
      sim.emitPublic({ type: 'nearMiss', id: u.id });
      sim.award('nearMiss');
    }
    if (!u.lost && u.phase !== 'approach' && g.s - u.s > P.lostBehind) {
      u.lost = true;
      // One award per unit that chased and didn't connect (a rolling row counts once).
      const first = u.group < 0 || !this.units.some((x) => x !== u && x.group === u.group && x.lost);
      // Only a unit that engaged (wound up a tell) counts as shaken off.
      const engaged = u.unit === 'cruiser' ? u.target >= 0 : true;
      if (!u.hit && first && engaged) {
        sim.emitPublic({ type: 'lostTrack', id: u.id, kind: u.unit });
        sim.award('lostTrack');
      }
    }
  }
}
