import { describe, expect, it } from 'vitest';
import { Gait } from './gait';
import { Sim } from '../sim/sim';
import { Bot } from '../sim/bot';
import { TUNING } from '../tuning';

/**
 * v0.3 run-cycle test: foot slide under 5cm per plant at every tier, including
 * lane changes, knock-backs and wall bumps, sampled at 60 Hz and at a 144 Hz
 * render rate (interpolated, as the game renders).
 */
function runGait(seed: number, seconds: number, renderHz: number) {
  const sim = new Sim({ seed });
  const bot = new Bot(sim);
  const gait = new Gait();
  const dt = 1 / renderHz;
  const simDt = sim.dt;
  let acc = 0;
  let prev = { s: sim.giant.s, d: sim.giant.d, stepPos: sim.giant.stepPos };
  const pos = { x: 0, z: 0 };
  for (let t = 0; t < seconds; t += dt) {
    acc += dt;
    while (acc >= simDt) {
      acc -= simDt;
      prev = { s: sim.giant.s, d: sim.giant.d, stepPos: sim.giant.stepPos };
      // Brake for 1.5s every 12s so every tier (and braking) gets sampled.
      const braking = t % 12 > 9 && t % 12 < 10.5;
      sim.step({ ...bot.input(), brake: braking });
    }
    const a = acc / simDt;
    const g = sim.giant;
    const s = prev.s + (g.s - prev.s) * a;
    const d = prev.d + (g.d - prev.d) * a;
    const stepPos = prev.stepPos + (g.stepPos - prev.stepPos) * a;
    sim.track.posAt(s, d, pos);
    const h = sim.track.headingAt(s);
    gait.update({ x: pos.x, z: pos.z, fx: Math.cos(h), fz: Math.sin(h), speed: g.speed, stepPos, stepLen: g.stepLen, tier: g.tier, dt });
  }
  return { gait, sim };
}

describe('gait: feet locked to distance', () => {
  for (const hz of [60, 144]) {
    it(`foot slide < 5cm per plant at every tier (${hz} Hz render, 10 seeds × 45s)`, () => {
      const worst = [0, 0, 0];
      const count = [0, 0, 0];
      let early = 0;
      for (let seed = 1; seed <= 10; seed++) {
        const { gait } = runGait(seed, 45, hz);
        for (const r of gait.records) {
          worst[r.tier] = Math.max(worst[r.tier], r.slide);
          count[r.tier]++;
          if (r.liftedEarly) early++;
        }
      }
      for (let t = 0; t < 3; t++) {
        expect(count[t], `plants at tier ${t}`).toBeGreaterThan(30);
        expect(worst[t], `worst slide at tier ${t}`).toBeLessThan(TUNING.gait.maxFootSlide);
      }
      // Early lifts only happen when a lane change outruns the leg; they must stay rare.
      const total = count[0] + count[1] + count[2];
      expect(early / total).toBeLessThan(0.25);
    });
  }

  it('stance is leg-reach limited and leaves a hang that grows with stride', () => {
    const jog = Gait.stanceDistance(6 / 2.0);
    const ramp = Gait.stanceDistance(15 / 2.3);
    expect(jog / (6 / 2.0)).toBeGreaterThan(ramp / (15 / 2.3));
    expect(ramp).toBeLessThanOrEqual(TUNING.gait.stanceMaxDistance);
  });
});
