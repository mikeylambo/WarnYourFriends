import { describe, expect, it } from 'vitest';
import { enableProto } from '../tuning';
import { Sim } from './sim';
import { Bot } from './bot';

// Prototype rules (own file: enableProto changes TUNING for this file only). Same rule as onroad.test.ts.
enableProto();

describe('everything stays on the road (prototype)', () => {
  it('story and endless: police, escorts and moving traffic', () => {
    let carrierFrames = 0;
    let carrierOverlaps = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const sim = new Sim({ seed, growth: true, ...(seed % 2 ? { endless: true } : {}) });
      const bot = new Bot(sim);
      const t = sim.track;
      for (let i = 0; i < 60 * 300 && sim.live; i++) {
        sim.step(bot.input());
        const out = (s: number, d: number) => d < -0.05 || d > t.widthAt(s) + 0.05;
        for (const u of sim.pursuit.units) if (u.alive && u.unit !== 'chopper') expect(out(u.s, u.d), `${u.unit} at t=${sim.time.toFixed(1)}`).toBe(false);
        for (const c of sim.escort.cruisers) if (c.active) expect(out(c.s, c.d), `escort at t=${sim.time.toFixed(1)}`).toBe(false);
        for (const m of t.movers) if (m.alive) expect(out(m.s, m.d), `mover at t=${sim.time.toFixed(1)}`).toBe(false);
        // The Car Carrier doesn't drive through traffic in his frame (Mike, 2026-11-18): counted, held under 3%.
        for (const u of sim.pursuit.units) if (u.alive && u.unit === 'carrier' && u.s - sim.giant.s < 70) {
          carrierFrames++;
          if (t.propsBetween(u.s - u.hl, u.s + u.hl).some((p) => p.alive && Math.abs(p.d - u.d) < p.hw + u.hw - 0.2)) carrierOverlaps++;
        }
      }
    }
    expect(carrierOverlaps / Math.max(1, carrierFrames)).toBeLessThan(0.03);
  }, 60000);
});
