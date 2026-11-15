import { describe, expect, it } from 'vitest';
import { Sim } from './sim';
import { PROP_DEFS } from './track';
import { TUNING } from '../tuning';

/** Giant size (TUNING.growth): the hit-box grows with his gear but never reaches the next lane's props. */
describe('growth', () => {
  it('scales his collision radius by gear only when growth is on', () => {
    const on = new Sim({ seed: 1, growth: true });
    const off = new Sim({ seed: 1 });
    TUNING.growth.scale.forEach((k, tier) => {
      on.giant.tier = off.giant.tier = tier;
      expect(on.radius()).toBeCloseTo(TUNING.giant.radius * k, 9);
      expect(off.radius()).toBe(TUNING.giant.radius);
    });
  });
  it('at its biggest, the hit-box stays clear of any lane prop in the next lane (every row still leaves a lane)', () => {
    const r = TUNING.giant.radius * Math.max(...TUNING.growth.scale);
    const lanePropKinds = ['sawhorse', 'cart', 'fence', 'scooter', 'car', 'van', 'barricade', 'dozer', 'tollgate', 'foodtruck'] as const;
    const widest = Math.max(...lanePropKinds.map((k) => PROP_DEFS[k].hw));
    const jitter = 0.3; // props sit up to 0.3m off their lane centre
    expect(r).toBeLessThan(TUNING.lanes.width - widest - jitter);
  });
});
