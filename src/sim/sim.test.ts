import { describe, expect, it } from 'vitest';
import { Sim } from './sim';
import { TUNING } from '../tuning';
import { NO_INPUT, type Prop, type SimEvent, type SimInput } from './types';
import { DEG } from './math';
import { generateLayout } from './layout';

/** A sim with every prop removed: the "empty block" from the M0 gate. */
function emptySim(seed = 1): Sim {
  const sim = new Sim({ seed });
  for (const p of sim.props) if (p.kind !== 'wall') p.alive = false;
  for (const p of sim.peds) p.x = p.z = 9999;
  // Keep dead props from respawning mid-test.
  for (const p of sim.props) p.deadT = -1e9;
  // Start in the middle with room to run.
  sim.giant.x = -120;
  sim.giant.z = 0;
  sim.giant.heading = sim.giant.travel = 0; // facing +X
  return sim;
}

function run(sim: Sim, seconds: number, input: SimInput = NO_INPUT): SimEvent[] {
  const out: SimEvent[] = [];
  const n = Math.round(seconds * TUNING.sim.hz);
  for (let i = 0; i < n; i++) out.push(...sim.step(input));
  return out;
}

function placeProp(sim: Sim, kind: Prop['kind'], cls: Prop['cls'], x: number, z: number): Prop {
  // Reuse a dead prop slot so the spatial grid still finds it: pick one near (x, z).
  const p = sim.props.find((q) => !q.alive && q.kind !== 'wall' && q.kind !== 'building' && Math.abs(q.x - x) < 4 && Math.abs(q.z - z) < 4);
  if (!p) throw new Error('no slot');
  Object.assign(p, { kind, cls, alive: true, hw: 0.8, hd: 0.8, x, z, deadT: -1e9 });
  return p;
}

describe('layout', () => {
  it('is deterministic per seed', () => {
    const a = generateLayout(42);
    const b = generateLayout(42);
    expect(a.props.map((p) => [p.kind, p.x, p.z])).toEqual(b.props.map((p) => [p.kind, p.x, p.z]));
    expect(generateLayout(43).props.length).not.toBe(0);
  });

  it('keeps the spawn clear', () => {
    for (let seed = 1; seed < 30; seed++) {
      const l = generateLayout(seed);
      const r = TUNING.giant.radius + 2;
      for (const p of l.props) {
        const inside = Math.abs(p.x - l.spawn.x) < p.hw + r && Math.abs(p.z - l.spawn.z) < p.hd + r;
        expect(inside, `seed ${seed} prop ${p.kind}`).toBe(false);
      }
    }
  });
});

describe('movement (§9)', () => {
  it('never drops below the 2 m/s floor, even braking forever (Law 1, LOCKED)', () => {
    const sim = emptySim();
    run(sim, 1.5, { ...NO_INPUT, brake: true });
    expect(sim.giant.speed).toBeCloseTo(TUNING.giant.speedFloor, 5);
    expect(sim.stats.minSpeed).toBeGreaterThanOrEqual(TUNING.giant.speedFloor);
  });

  it('tiers up Jog → Stride → Rampage on schedule in an empty block', () => {
    const sim = emptySim();
    const ev = run(sim, 0.75); // 4 → 6 m/s at 8 m/s² takes 0.25s; then 2.0s at top
    expect(sim.giant.tier).toBe(0);
    run(sim, 1.6);
    expect(sim.giant.tier).toBe(1);
    // Stride: 6 → 10 at 6 m/s² ≈ 0.67s, then 3.0s at top
    run(sim, 3.8);
    expect(sim.giant.tier).toBe(2);
    expect(ev.filter((e) => e.type === 'tierUp').length).toBe(0);
    run(sim, 1.5);
    expect(sim.giant.speed).toBeCloseTo(15, 1);
  });

  it('turns at the tier turn rate, and later at higher tiers', () => {
    const turnAfter = (tier: number) => {
      const sim = emptySim();
      sim.giant.tier = tier;
      sim.giant.speed = TUNING.tiers[tier].topSpeed;
      const h0 = sim.giant.heading;
      run(sim, 0.25, { ...NO_INPUT, turn: 1 });
      return Math.abs(sim.giant.heading - h0) / DEG;
    };
    const jog = turnAfter(0);
    const stride = turnAfter(1);
    const rampage = turnAfter(2);
    expect(jog).toBeGreaterThan(stride);
    expect(stride).toBeGreaterThan(rampage);
    expect(jog).toBeLessThanOrEqual(220 * 0.25 + 1e-6);
  });

  it('drifts at Rampage: travel lags facing more than at Jog', () => {
    const slipAfter = (tier: number) => {
      const sim = emptySim();
      sim.giant.tier = tier;
      sim.giant.speed = TUNING.tiers[tier].topSpeed;
      let maxSlip = 0;
      for (let i = 0; i < 30; i++) {
        sim.step({ ...NO_INPUT, turn: 1 });
        maxSlip = Math.max(maxSlip, Math.abs(sim.giant.heading - sim.giant.travel));
      }
      return maxSlip / sim.giant.angVel; // seconds of lag
    };
    expect(slipAfter(2)).toBeGreaterThan(slipAfter(0) * 2);
  });

  it('drops a tier when braking longer than 0.4s', () => {
    const sim = emptySim();
    sim.giant.tier = 2;
    sim.giant.speed = 15;
    const ev = run(sim, 0.45, { ...NO_INPUT, brake: true });
    expect(sim.giant.tier).toBe(1);
    expect(ev.some((e) => e.type === 'tierDown' && e.reason === 'brake')).toBe(true);
  });

  it('drops a tier on a sharp steering yank (>110° off the facing)', () => {
    const sim = emptySim();
    sim.giant.tier = 2;
    sim.giant.speed = 15;
    sim.giant.tierTimer = -1e9;
    // 90° corner: fine.
    let ev = run(sim, 0.2, { ...NO_INPUT, aim: Math.PI / 2 });
    expect(ev.some((e) => e.type === 'tierDown')).toBe(false);
    // Yank behind: one tier, once, not every tick.
    ev = run(sim, 0.3, { ...NO_INPUT, aim: sim.giant.heading + Math.PI * 0.9 });
    expect(ev.filter((e) => e.type === 'tierDown' && e.reason === 'turn').length).toBe(1);
    expect(sim.giant.tier).toBe(1);
  });

  it('emits footfalls with stride length that grows per tier', () => {
    const count = (tier: number) => {
      const sim = emptySim();
      sim.giant.tier = tier;
      sim.giant.speed = TUNING.tiers[tier].topSpeed;
      sim.giant.tierTimer = -1e9; // hold the tier
      const ev = run(sim, 2);
      const dist = TUNING.tiers[tier].topSpeed * 2;
      return dist / ev.filter((e) => e.type === 'footfall').length;
    };
    expect(count(2)).toBeGreaterThan(count(1));
    expect(count(1)).toBeGreaterThan(count(0));
  });
});

describe('collisions by mass class (§9)', () => {
  const hit = (tier: number, cls: Prop['cls'], shoulder = false) => {
    const sim = emptySim();
    sim.giant.tier = tier;
    sim.giant.speed = TUNING.tiers[tier].topSpeed;
    sim.giant.tierTimer = -1e9;
    const target = sim.props.find((p) => !p.alive && p.kind !== 'wall' && p.kind !== 'building')!;
    sim.giant.x = target.x - 6;
    sim.giant.z = target.z;
    sim.giant.heading = sim.giant.travel = 0;
    placeProp(sim, 'car', cls, target.x, target.z);
    const ev: SimEvent[] = [];
    for (let i = 0; i < 90; i++) ev.push(...sim.step({ ...NO_INPUT, shoulder: shoulder && i === 12 }));
    return { ev, sim };
  };

  const table: [Prop['cls'], number, 'smash' | 'bounce' | 'knock'][] = [
    ['light', 0, 'knock'], ['light', 1, 'knock'], ['light', 2, 'knock'],
    ['medium', 0, 'bounce'], ['medium', 1, 'smash'], ['medium', 2, 'smash'],
    ['heavy', 0, 'bounce'], ['heavy', 1, 'bounce'], ['heavy', 2, 'smash'],
    ['immovable', 0, 'bounce'], ['immovable', 1, 'bounce'], ['immovable', 2, 'bounce'],
  ];
  for (const [cls, tier, expected] of table) {
    it(`${cls} at ${TUNING.tiers[tier].name} → ${expected}`, () => {
      const { ev } = hit(tier, cls);
      expect(ev.some((e) => e.type === expected)).toBe(true);
    });
  }

  it('a bounce drops a tier, stumbles, and never stops the giant', () => {
    const { ev, sim } = hit(1, 'heavy');
    expect(ev.some((e) => e.type === 'tierDown' && e.reason === 'impact')).toBe(true);
    expect(sim.stats.minSpeed).toBeGreaterThanOrEqual(TUNING.giant.speedFloor);
  });

  it('Shoulder Check smashes one mass class up (Stride vs heavy)', () => {
    const { ev } = hit(1, 'heavy', true);
    expect(ev.some((e) => e.type === 'shoulder')).toBe(true);
    expect(ev.some((e) => e.type === 'smash' && e.cls === 'heavy')).toBe(true);
  });

  it('Shoulder Check never smashes immovables', () => {
    const { ev } = hit(2, 'immovable', true);
    expect(ev.some((e) => e.type === 'smash')).toBe(false);
  });
});

describe('determinism', () => {
  it('same seed + same inputs = same state', () => {
    const a = new Sim({ seed: 7 });
    const b = new Sim({ seed: 7 });
    for (let i = 0; i < 600; i++) {
      const input: SimInput = { turn: Math.sin(i / 40), aim: null, brake: i % 200 < 10, shoulder: i % 180 === 0 };
      a.step(input);
      b.step(input);
    }
    expect([a.giant.x, a.giant.z, a.giant.speed, a.giant.tier]).toEqual([b.giant.x, b.giant.z, b.giant.speed, b.giant.tier]);
  });
});
