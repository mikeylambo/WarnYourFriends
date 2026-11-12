import { TUNING } from '../tuning';
import { CLASS_RANK, type Sim } from './sim';
import type { SimInput } from './types';

/**
 * Balance-harness bot (§33), lane-runner version: keeps the lane while it's
 * clear, dodges what it can't smash, and at Stride+ steers into lanes with
 * smashable props (smash-across is the fun). Deterministic: sim state only.
 */
export class Bot {
  private shoulderCooldown = 0;
  private decideCooldown = 0;

  constructor(private sim: Sim) {}

  input(): SimInput {
    const sim = this.sim;
    const g = sim.giant;
    const track = sim.track;
    this.shoulderCooldown -= sim.dt;
    this.decideCooldown -= sim.dt;
    if (sim.laneBusy || this.decideCooldown > 0 || !sim.live) return { lane: 0, brake: false, shoulder: false };

    const look = g.speed * 1.3 + 10;
    const s0 = g.s;
    const s1 = g.s + look;
    const lanes = track.lanesAt(g.s + 4);
    const rank = sim.smashRank();

    const units = sim.pursuit.units.filter((u) => u.alive);
    // Phase 2 threats: a cruiser winding up to swerve into a lane, a spike strip in a lane.
    const threatened = (lane: number) => {
      const c = track.laneCenter(lane);
      for (const u of units) {
        if (u.unit === 'cruiser' && (u.phase === 'tell' || u.phase === 'act') && u.target === lane && g.tier < 2) return true;
        if (u.unit === 'spike' && u.phase !== 'approach' && Math.abs(u.d - c) < 2 && u.s > g.s - 1 && u.s < s1 + 10) return true;
      }
      return false;
    };
    const ex = sim.exit;
    const exitLane = ex && ex.gore - g.s < 230 && ex.gore > g.s ? track.lanesAt(ex.gore) - 1 : -1;
    const score = (lane: number): number => {
      if (!track.laneUsable(lane, g.s) || !track.laneUsable(lane, g.s + 6)) return -Infinity;
      if (!sim.laneClear(lane, s0, s1)) return -100;
      if (threatened(lane)) return -60;
      let sc = exitLane >= 0 ? -6 * Math.abs(lane - exitLane) : 0;
      // Prefer lanes with things to smash once we can.
      const c = track.laneCenter(lane);
      for (const p of track.propsBetween(s0, s1)) {
        if (Math.abs(p.d - c) < p.hw + TUNING.giant.radius && CLASS_RANK[p.cls] <= rank) sc += 2;
      }
      return sc - Math.abs(lane - g.lane) * 0.5;
    };

    const here = score(g.lane);
    let best = g.lane;
    let bestScore = here;
    for (const lane of [g.lane - 1, g.lane + 1]) {
      if (lane < 0 || lane >= lanes) continue;
      const sc = score(lane);
      if (sc > bestScore + 0.75) {
        best = lane;
        bestScore = sc;
      }
    }

    let shoulder = false;
    if (here <= -100 && bestScore <= -100 && this.shoulderCooldown <= 0) {
      shoulder = true;
      this.shoulderCooldown = 3;
    }
    if (best !== g.lane) {
      this.decideCooldown = 0.15;
      return { lane: Math.sign(best - g.lane), brake: false, shoulder };
    }
    return { lane: 0, brake: false, shoulder };
  }
}
