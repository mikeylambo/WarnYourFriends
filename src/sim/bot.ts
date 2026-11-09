import { TUNING } from '../tuning';
import { angleDiff, wrap } from './math';
import type { Sim } from './sim';
import type { SimInput } from './types';

/**
 * Balance-harness bot (§33): steers toward the nearest smashable target,
 * avoiding things it can't smash. Deterministic: uses only sim state.
 */
export class Bot {
  private target = -1;
  private retarget = 0;
  private shoulderCooldown = 0;

  constructor(private sim: Sim) {}

  input(): SimInput {
    const sim = this.sim;
    const g = sim.giant;
    const rank = sim.smashRank();
    const ranks = { light: 0, medium: 1, heavy: 2, immovable: 3 } as const;

    this.retarget -= sim.dt;
    const cur = sim.props[this.target];
    if (this.retarget <= 0 || !cur || !cur.alive) {
      this.retarget = 0.75;
      let best = -1;
      let bestScore = Infinity;
      for (const p of sim.props) {
        if (!p.alive || ranks[p.cls] > Math.max(rank, 1) || ranks[p.cls] === 0) continue;
        const dx = p.x - g.x;
        const dz = p.z - g.z;
        const d = Math.hypot(dx, dz);
        if (d < 4 || d > 70) continue;
        const ang = Math.abs(angleDiff(g.heading, Math.atan2(dz, dx)));
        const score = d * (1 + ang * 1.5);
        if (score < bestScore) {
          bestScore = score;
          best = p.id;
        }
      }
      this.target = best;
    }

    let aim: number = g.heading;
    const t = sim.props[this.target];
    if (t && t.alive) aim = Math.atan2(t.z - g.z, t.x - g.x);
    else aim = Math.atan2(-g.z, -g.x); // head back toward the middle

    // Feelers: steer away from unsmashable obstacles ahead.
    const look = 4 + g.speed * 0.6;
    for (const side of [-0.45, 0, 0.45]) {
      const a = g.heading + side;
      const px = g.x + Math.cos(a) * look;
      const pz = g.z + Math.sin(a) * look;
      for (const p of sim.props) {
        if (!p.alive || ranks[p.cls] <= rank) continue;
        if (Math.abs(p.x - px) < p.hw + TUNING.giant.radius && Math.abs(p.z - pz) < p.hd + TUNING.giant.radius) {
          aim = wrap(g.heading - Math.sign(side || 1) * 1.2);
          break;
        }
      }
    }

    // Never ask for more than ~95° off the facing: a yank past 110° costs a tier,
    // and a sensible player turns through corners rather than reversing.
    const off = angleDiff(g.heading, aim);
    const lim = (95 * Math.PI) / 180;
    if (Math.abs(off) > lim) aim = wrap(g.heading + Math.sign(off) * lim);

    this.shoulderCooldown -= sim.dt;
    let shoulder = false;
    if (t && t.alive && ranks[t.cls] > rank && this.shoulderCooldown <= 0 && Math.hypot(t.x - g.x, t.z - g.z) < 5) {
      shoulder = true;
      this.shoulderCooldown = 3;
    }
    return { turn: 0, aim, brake: false, shoulder };
  }
}
