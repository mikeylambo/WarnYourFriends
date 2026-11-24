import { describe, expect, it } from 'vitest';
import { enableProto } from '../tuning';
import { Sim } from './sim';
import { Bot } from './bot';

/**
 * The feel baseline (Mike, 2026-11-18: "the game feels better here, honestly, and I don't want to make it worse").
 * The prototype's rhythm as the bot plays it, pinned to a band: new content may move these, never out of the band.
 * Measured when it was set: story ~80% finish, ~2.5 hits/min, ~1.8 Rampages/min, first Rampage ~25s.
 */
enableProto();

function play(seed: number, endless: boolean, maxS: number) {
  const sim = new Sim({ seed, growth: true, ...(endless ? { endless: true } : {}) });
  const bot = new Bot(sim);
  let hits = 0;
  let ramps = 0;
  let first = -1;
  for (let i = 0; i < 60 * maxS && sim.live; i++) {
    for (const e of sim.step(bot.input())) {
      if (e.type === 'bounce') hits++;
      if (e.type === 'rampageStart') {
        ramps++;
        if (first < 0) first = sim.time;
      }
    }
  }
  return { sim, hits, ramps, first, min: sim.time / 60 };
}

describe('feel baseline (prototype)', () => {
  it('story: finishable, rare hits, a steady Rampage rhythm', () => {
    const runs = Array.from({ length: 12 }, (_, i) => play(101 + i, false, 400));
    const mins = runs.reduce((a, r) => a + r.min, 0);
    const finish = runs.filter((r) => r.sim.show.state === 'cleared').length / runs.length;
    const hitsPerMin = runs.reduce((a, r) => a + r.hits, 0) / mins;
    const rampsPerMin = runs.reduce((a, r) => a + r.ramps, 0) / mins;
    const firsts = runs.map((r) => r.first).filter((f) => f >= 0).sort((a, b) => a - b);
    const firstMedian = firsts[firsts.length >> 1];
    console.log(`feel: story finish ${(finish * 100).toFixed(0)}%, hits/min ${hitsPerMin.toFixed(2)}, Rampages/min ${rampsPerMin.toFixed(2)}, first Rampage ${firstMedian?.toFixed(0)}s`);
    expect(finish).toBeGreaterThanOrEqual(0.55);
    expect(hitsPerMin).toBeLessThanOrEqual(4);
    expect(rampsPerMin).toBeGreaterThanOrEqual(1.1);
    expect(rampsPerMin).toBeLessThanOrEqual(2.6);
    expect(firstMedian).toBeLessThanOrEqual(40);
  }, 60_000); // 12 headless runs: seconds, not milliseconds
  it('endless: always ends, and not too soon', () => {
    const runs = Array.from({ length: 8 }, (_, i) => play(201 + i, true, 1200));
    const t = runs.map((r) => r.sim.time).sort((a, b) => a - b);
    console.log(`feel: endless survival median ${t[t.length >> 1].toFixed(0)}s (${t.map((x) => x.toFixed(0)).join(' ')})`);
    expect(runs.every((r) => !r.sim.live)).toBe(true);
    expect(t[t.length >> 1]).toBeGreaterThanOrEqual(150);
  }, 60_000); // 8 endless runs up to 1200s each
});
