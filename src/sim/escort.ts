import { TUNING } from '../tuning';
import { clamp } from './math';
import { Rng } from './rng';
import type { Track } from './track';
import type { GiantState } from './types';

/**
 * Phase 0c escort: 2–3 police cruisers trailing the giant with lights and
 * sirens. They follow the path the giant actually ran (so it's clear), hold a
 * trail gap, never catch up and never attack. Pursuit AI is Phase 2.
 *
 * They don't touch the giant or props; they're sim-side so the soak can prove
 * the LOCKED spawn rule (never within 40m, never on camera) and the gap floor.
 */
export interface Cruiser {
  id: number;
  active: boolean;
  /** Sim time this cruiser joins. */
  joinAt: number;
  s: number;
  d: number;
  speed: number;
  /** Current side offset from the giant's path (m). */
  off: number;
  /** Side offset this cruiser wants when the road allows it. */
  side: number;
  trail: number;
}

export class Escort {
  readonly cruisers: Cruiser[] = [];
  /** Giant's path: lateral offset `d` sampled along `s`, oldest first. */
  private pathS: number[] = [];
  private pathD: number[] = [];

  constructor(seed: number, private track: Track) {
    const E = TUNING.escort;
    const rng = new Rng((seed ^ 0xe5c0e5c0) >>> 0);
    let t = rng.range(E.firstJoin[0], E.firstJoin[1]);
    const sides = [0, 1, -1];
    for (let i = 0; i < E.count; i++) {
      this.cruisers.push({ id: i, active: false, joinAt: t, s: 0, d: 0, speed: 0, off: 0, side: sides[i % 3] * E.sideOffset, trail: E.trail[i] ?? E.trail[E.trail.length - 1] + 7 * i });
      t += rng.range(E.joinGap[0], E.joinGap[1]);
    }
  }

  /** Giant's lateral offset where it was at `s` (interpolated). */
  pathAt(s: number): number {
    const S = this.pathS;
    const n = S.length;
    if (n === 0) return 0;
    if (s <= S[0]) return this.pathD[0];
    if (s >= S[n - 1]) return this.pathD[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (S[mid] <= s) lo = mid;
      else hi = mid;
    }
    const f = (s - S[lo]) / Math.max(1e-9, S[hi] - S[lo]);
    return this.pathD[lo] + (this.pathD[hi] - this.pathD[lo]) * f;
  }

  /** Is a live prop in the way of a cruiser at (s, d)? */
  private blocked(s: number, d: number): boolean {
    for (const p of this.track.propsBetween(s - 4, s + 10)) {
      if (Math.abs(p.d - d) < p.hw + 1.1) return true;
    }
    return false;
  }

  /** Returns ids of cruisers that joined this tick. */
  step(dt: number, time: number, g: GiantState): number[] {
    const E = TUNING.escort;
    const joined: number[] = [];
    const S = this.pathS;
    if (S.length === 0 || g.s - S[S.length - 1] >= 0.5) {
      S.push(g.s);
      this.pathD.push(g.d);
    }
    const keep = g.s - E.spawnBehind - 30;
    let drop = 0;
    while (drop < S.length - 2 && S[drop] < keep) drop++;
    if (drop > 64) {
      S.splice(0, drop);
      this.pathD.splice(0, drop);
    }

    for (const c of this.cruisers) {
      if (!c.active) {
        if (time < c.joinAt || g.s < E.spawnBehind + 1) continue;
        c.active = true;
        c.s = g.s - E.spawnBehind;
        c.speed = g.speed + E.closeSpeed;
        c.off = 0;
        c.d = this.pathAt(c.s);
        joined.push(c.id);
        continue;
      }
      const gap = g.s - c.s;
      const want = g.speed + clamp((gap - c.trail) / E.holdTau, -E.closeSpeed, E.closeSpeed);
      c.speed += (want - c.speed) * Math.min(1, dt / 0.25);
      c.speed = Math.max(0, c.speed);
      c.s += c.speed * dt;
      // Never catch up: hard floor on the gap.
      if (g.s - c.s < E.minGap) {
        c.s = g.s - E.minGap;
        c.speed = Math.min(c.speed, g.speed);
      }
      const base = this.pathAt(c.s);
      const target = c.side !== 0 && !this.blocked(c.s, base + c.side) ? c.side : 0;
      c.off += clamp(target - c.off, -E.sideSpeed * dt, E.sideSpeed * dt);
      if (c.off !== 0 && this.blocked(c.s, base + c.off)) c.off += clamp(-c.off, -E.sideSpeed * 2 * dt, E.sideSpeed * 2 * dt);
      const w = this.track.widthAt(c.s);
      c.d = clamp(base + c.off, 1.2, Math.max(1.2, w - 1.2));
    }
    return joined;
  }
}
