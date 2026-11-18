import { describe, expect, it } from 'vitest';
import { Sim } from './sim';
import { Bot } from './bot';
import { TUNING } from '../tuning';
import type { SimEvent } from './types';

// Forks are off in the game (TUNING.forks.at = [], 2026-11-18); this file turns them back on so the dormant code stays sound.
(TUNING.forks as unknown as { at: number[] }).at = [30, 58, 86];

/** Bot-drive until a fork opens; then hold the right lane (take) or the left lane (stay) to the gore. */
function toFork(seed: number, take: boolean) {
  const sim = new Sim({ seed });
  const bot = new Bot(sim);
  const ev: SimEvent[] = [];
  while (sim.live && !sim.fork && sim.time < 140) ev.push(...sim.step(bot.input()));
  if (!sim.fork) return null;
  const opened = { ...sim.fork };
  let fork: Extract<SimEvent, { type: 'fork' }> | undefined;
  while (sim.live && !fork && sim.time < 160) {
    const right = sim.track.lanesAt(opened.gore) - 1;
    const want = take ? right : 0;
    const inp = bot.input();
    const lane = sim.laneBusy ? 0 : Math.sign(want - sim.giant.lane);
    const step = sim.step({ ...inp, lane });
    ev.push(...step);
    fork = step.find((e): e is Extract<SimEvent, { type: 'fork' }> => e.type === 'fork');
  }
  return { sim, ev, fork, opened };
}

describe('forks (Mike, 2026-11-15)', () => {
  it('a fork opens on a highway, its gore far enough ahead to see and choose', () => {
    let opened = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const r = toFork(seed, false);
      if (!r) continue;
      opened++;
      const e = r.ev.find((x) => x.type === 'forkOpen');
      expect(e).toBeTruthy();
    }
    expect(opened).toBeGreaterThan(5);
  });

  it('the right lane at the gore takes it: the road becomes the avenue, the police are gone, he stays on the road', () => {
    let taken = 0;
    for (let seed = 1; seed <= 20 && taken < 4; seed++) {
      const r = toFork(seed, true);
      if (!r?.fork) continue;
      if (!r.fork.taken) continue; // a bounce at the gore can still knock him out of the lane
      taken++;
      const { sim } = r;
      const g = sim.giant;
      expect(sim.track.segmentAt(g.s).zone).toBe('avenue');
      expect(sim.track.lanesAt(g.s)).toBe(TUNING.zones.lanes.avenue);
      expect(g.lane).toBeLessThan(sim.track.lanesAt(g.s));
      expect(Math.abs(g.d - sim.track.laneCenter(g.lane))).toBeLessThan(1e-9);
      expect(sim.pursuit.units.filter((u) => u.alive).length).toBe(0);
      expect(r.ev.some((e) => e.type === 'zone' && e.zone === 'avenue')).toBe(true);
      // Keeps running on the new road.
      for (let i = 0; i < 300 && sim.live; i++) sim.step({ lane: 0, brake: false, shoulder: false });
      expect(g.d).toBeGreaterThan(0);
      expect(g.d).toBeLessThan(sim.track.widthAt(g.s));
    }
    expect(taken).toBeGreaterThan(1);
  });

  it('any other lane stays on the highway', () => {
    let stayed = 0;
    for (let seed = 1; seed <= 20 && stayed < 3; seed++) {
      const r = toFork(seed, false);
      if (!r?.fork) continue;
      expect(r.fork.taken).toBe(false);
      expect(r.sim.track.segmentAt(r.sim.giant.s).zone).toBe('highway');
      stayed++;
    }
    expect(stayed).toBeGreaterThan(1);
  });
});
