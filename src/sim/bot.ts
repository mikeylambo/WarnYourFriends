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

  /** Phase 3: when to use the equipped ability (so the soak exercises every one). */
  private wantAbility(here: number, bestScore: number, best: number): boolean {
    const sim = this.sim;
    const g = sim.giant;
    if (!sim.ability || g.abilityCd > 0) return false;
    const trapped = here <= -60 && (best === g.lane || bestScore <= -60);
    switch (sim.ability) {
      case 'leap':
        return trapped;
      case 'stare':
        return here <= -100;
      case 'breakaway': {
        // Out of trouble, or out from under the police on his tail.
        const tail = sim.pursuit.units.some((u) => u.alive && u.unit === 'cruiser' && !u.lost && u.s < g.s && u.s > g.s - 15);
        return trapped || here <= -100 || tail;
      }
      case 'primeTime': {
        // On air when there's plenty to smash just ahead and he can smash it.
        const rank = sim.smashRank();
        const ahead = sim.track.propsBetween(g.s, g.s + g.speed * 3).filter((p) => p.alive && CLASS_RANK[p.cls] <= rank).length;
        return g.tier === 2 && (ahead >= 3 || sim.show.ratings < 30);
      }
    }
  }

  /** Rampage loop: the bot fires Rampage the moment the meter is full. */
  input(): SimInput {
    const g = this.sim.giant;
    return { ...this.decide(), shoulder: g.meter >= 100 && !this.sim.inRampage };
  }

  private decide(): SimInput {
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
        if (u.unit === 'cruiser' && (u.phase === 'tell' || u.phase === 'act') && u.target === lane) return true;
        if (u.unit === 'spike' && u.phase !== 'approach' && Math.abs(u.d - c) < 2 && u.s > g.s - 1 && u.s < s1 + 10) return true;
      }
      return false;
    };
    // A police chopper has him: two lane changes in a row shake it.
    const spotted = units.some((u) => u.unit === 'chopper' && u.phase === 'act');
    // Police Net: a flanker alongside with the truck braking ahead. Brake and drop back behind them; a Leap or
    // the Stare if equipped (a full meter fires Rampage, which runs through them).
    const net = units.filter((u) => u.unit === 'net' && (u.phase === 'tell' || u.phase === 'act'));
    if (net.length) {
      const flank = net.filter((u) => u.ram && Math.abs(u.s - g.s) < 6);
      const truck = net.find((u) => u.kind === 'armored');
      const closing = truck && truck.s > g.s && truck.s - g.s < 22 && Math.abs(truck.d - g.d) < 2;
      if (closing && flank.length) {
        if (sim.ability === 'leap' || sim.ability === 'stare') {
          if (g.abilityCd <= 0) return { lane: 0, brake: false, shoulder: false, ability: true };
        }
        // Behind the flankers now? Then step out of the box.
        if (flank.every((f) => f.s - f.hl > g.s + 1)) {
          const out = flank.length === 1 ? Math.sign(flank[0].d - g.d) : 1;
          this.decideCooldown = 0.15;
          return { lane: out, brake: false, shoulder: false };
        }
        return { lane: 0, brake: true, shoulder: false };
      }
    }
    const ex = sim.exit;
    // Forks: take about half of them (deterministic per seed and fork), so the soak exercises both roads.
    const fk = sim.fork;
    const forkLane = fk && fk.gore - g.s < 230 && fk.gore > g.s && (fk.segment + sim.seed) % 2 === 0 ? track.lanesAt(fk.gore) - 1 : -1;
    const exitLane = ex && ex.gore - g.s < 230 && ex.gore > g.s ? track.lanesAt(ex.gore) - 1 : forkLane;
    const exitGore = exitLane < 0 ? -1 : ex && ex.gore > g.s ? ex.gore : fk ? fk.gore : -1;
    const score = (lane: number): number => {
      if (!track.laneUsable(lane, g.s) || !track.laneUsable(lane, g.s + 6)) return -Infinity;
      // The exit lane leaves the road at the gore: judge it only up to there (a merge past the gore is not his problem).
      const end = lane === exitLane && exitGore > g.s ? Math.min(s1, exitGore + 1) : s1;
      if (!sim.laneClear(lane, s0, end)) return -100;
      if (threatened(lane)) return -60;
      let sc = exitLane >= 0 ? -6 * Math.abs(lane - exitLane) : 0;
      // Prefer lanes with things to smash once we can.
      const c = track.laneCenter(lane);
      for (const p of track.propsBetween(s0, s1)) {
        if (Math.abs(p.d - c) < p.hw + this.sim.radius() && CLASS_RANK[p.cls] <= rank) sc += 2;
      }
      if (spotted && lane !== g.lane) sc += 3;
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

    const shoulder = false;
    const ability = this.wantAbility(here, bestScore, best);
    if (best !== g.lane) {
      this.decideCooldown = 0.15;
      return { lane: Math.sign(best - g.lane), brake: false, shoulder, ability };
    }
    return { lane: 0, brake: false, shoulder, ability };
  }
}
