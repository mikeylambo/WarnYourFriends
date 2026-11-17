import { describe, expect, it } from 'vitest';
import { Sim } from './sim';
import { Bot } from './bot';
import { TUNING } from '../tuning';
import type { SimEvent } from './types';

describe("the producer's asks (Mike, 2026-11-15)", () => {
  it('three distinct, seeded asks per segment; same seed, same asks', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const a = new Sim({ seed }).asks.list.map((x) => x.id);
      const b = new Sim({ seed }).asks.list.map((x) => x.id);
      expect(a).toEqual(b);
      expect(a.length).toBe(TUNING.asks.perSegment);
      expect(new Set(a).size).toBe(a.length);
    }
  });

  it('only offers a road ask when that road comes up, and the chopper ask only from segment 2', () => {
    for (let seed = 1; seed <= 60; seed++) {
      for (const segment of [0, 3]) {
        const sim = new Sim({ seed, segment });
        const zones = new Set(sim.track.segments.filter((s) => s.s0 <= TUNING.asks.zoneLookahead).map((s) => s.zone));
        for (const a of sim.asks.list) {
          if (a.id === 'bridge') expect(zones.has('bridge')).toBe(true);
          if (a.id === 'tunnel') expect(zones.has('tunnel')).toBe(true);
          if (a.id === 'chopper') expect(segment).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  it('a finished ask banks its reward into the score once; "without a bounce" fails on a bounce', () => {
    let finished = 0;
    let failedClean = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const sim = new Sim({ seed, segment: seed % 5 });
      const bot = new Bot(sim);
      const ev: SimEvent[] = [];
      while (sim.live && sim.time < 200) ev.push(...sim.step(bot.input()));
      const fromDistance = sim.stats.distancePoints;
      const fromChains = ev.reduce((n, e) => n + (e.type === 'chainEnd' ? e.points : 0), 0);
      const fromAsks = sim.asks.list.reduce((n, a) => n + (a.done ? a.reward : 0), 0);
      // Score = chains + asks + distance (Rampage loop, 2026-11-17).
      expect(Math.abs(sim.show.banked - (fromChains + fromAsks + fromDistance))).toBeLessThan(2);
      for (const a of sim.asks.list) {
        const doneEvents = ev.filter((e) => e.type === 'ask' && e.id === a.id && e.done);
        expect(doneEvents.length).toBe(a.done ? 1 : 0);
        if (a.done) finished++;
        if (a.id === 'clean' && ev.some((e) => e.type === 'bounce')) {
          expect(a.done).toBe(false);
          failedClean++;
        }
      }
    }
    expect(finished).toBeGreaterThan(10);
    void failedClean;
  });
});
