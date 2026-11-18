import { describe, expect, it } from 'vitest';
import { enableProto } from '../tuning';
import { Sim } from './sim';
import { Bot } from './bot';

// Prototype rules (own file: enableProto changes TUNING for this file only). Same rule as onroad.test.ts.
enableProto();

describe('everything stays on the road (prototype)', () => {
  it('story and endless: police, escorts and moving traffic', () => {
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
      }
    }
  }, 60000);
});
