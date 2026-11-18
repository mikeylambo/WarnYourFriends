import { describe, expect, it } from 'vitest';
import { Sim } from './sim';
import { Bot } from './bot';

/**
 * Nothing drives off the road (Mike, 2026-11-18: a Car Carrier off the side of a bridge; roadblock cars sliding in
 * from over the water). Every ground police unit, escort cruiser and moving car stays between the road's edges.
 */
function check(sim: Sim, where: string) {
  const bad: string[] = [];
  const t = sim.track;
  const out = (s: number, d: number) => d < -0.05 || d > t.widthAt(s) + 0.05;
  for (const u of sim.pursuit.units) if (u.alive && u.unit !== 'chopper' && out(u.s, u.d)) bad.push(`${u.unit} d=${u.d.toFixed(2)} w=${t.widthAt(u.s).toFixed(2)}`);
  for (const c of sim.escort.cruisers) if (c.active && out(c.s, c.d)) bad.push(`escort d=${c.d.toFixed(2)}`);
  for (const m of t.movers) if (m.alive && out(m.s, m.d)) bad.push(`mover d=${m.d.toFixed(2)}`);
  if (bad.length) throw new Error(`${where} t=${sim.time.toFixed(1)}: ${bad.join(', ')}`);
}

describe('everything stays on the road', () => {
  it('default rules: police, carriers, escorts', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const sim = new Sim({ seed, segment: seed % 5, growth: true });
      const bot = new Bot(sim);
      for (let i = 0; i < 60 * 170 && sim.live; i++) {
        sim.step(bot.input());
        check(sim, `seed ${seed}`);
      }
    }
    expect(true).toBe(true);
  }, 60000);
});
