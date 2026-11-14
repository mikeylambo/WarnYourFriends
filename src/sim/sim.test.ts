import { describe, expect, it } from 'vitest';
import { Sim, cadenceAt, stepLengthAt } from './sim';
import { Bot } from './bot';
import { TUNING } from '../tuning';
import { NO_INPUT, type Prop, type SimEvent, type SimInput } from './types';
import { Track } from './track';
import { DEG } from './math';

const HZ = TUNING.sim.hz;

/** A sim with every lane prop removed: the "empty road". */
function emptySim(seed = 1): Sim {
  const sim = new Sim({ seed });
  sim.track.props.length = 0;
  // Stop new props appearing as the track extends.
  (sim.track as unknown as { addProps: () => void }).addProps = () => {};
  return sim;
}

function run(sim: Sim, seconds: number, input: SimInput = NO_INPUT): SimEvent[] {
  const out: SimEvent[] = [];
  const n = Math.round(seconds * HZ);
  for (let i = 0; i < n; i++) out.push(...sim.step(input));
  return out;
}

function placeProp(sim: Sim, kind: Prop['kind'], cls: Prop['cls'], s: number, lane: number): Prop {
  const p: Prop = { id: 9000 + sim.track.props.length, kind, cls, mat: 'metal', s, d: sim.track.laneCenter(lane), hl: 0.8, hw: 0.9, h: 1.5, variant: 0, alive: true, segment: 0 };
  sim.track.props.push(p);
  sim.track.props.sort((a, b) => a.s - b.s);
  return p;
}

function setTier(sim: Sim, tier: number) {
  sim.giant.tier = tier;
  sim.giant.speed = TUNING.tiers[tier].topSpeed;
  sim.giant.tierTimer = -1e9; // hold the tier
}

describe('track (v0.3 highway)', () => {
  it('is deterministic per seed', () => {
    const a = new Track(42);
    const b = new Track(42);
    a.ensure(2000);
    b.ensure(2000);
    expect(a.segments.map((s) => [s.kind, s.h1, s.lanes1])).toEqual(b.segments.map((s) => [s.kind, s.h1, s.lanes1]));
    expect(a.props.map((p) => [p.kind, p.s, p.d])).toEqual(b.props.map((p) => [p.kind, p.s, p.d]));
  });

  it('uses 40m segments, curves ≤ 8° per segment, 2–4 lanes of 4m, and merges', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const t = new Track(seed);
      t.ensure(4000);
      let merges = 0;
      for (const seg of t.segments) {
        expect(seg.length).toBe(40);
        expect(Math.abs(seg.h1 - seg.h0) / DEG).toBeLessThanOrEqual(TUNING.track.maxCurveDeg + 1e-9);
        expect(seg.lanes0).toBeGreaterThanOrEqual(2);
        expect(seg.lanes1).toBeLessThanOrEqual(4);
        if (seg.kind === 'merge') {
          merges++;
          expect(Math.abs(seg.lanes1 - seg.lanes0)).toBe(1);
        }
      }
      expect(merges, `seed ${seed}`).toBeGreaterThan(0);
      expect(t.laneCenter(1) - t.laneCenter(0)).toBe(4);
    }
  });

  it('only places Medium and Heavy props, and every row leaves a lane open', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const t = new Track(seed);
      t.ensure(3000);
      for (const p of t.props) expect(['medium', 'heavy']).toContain(p.cls);
      // Group by row (props within 4m of each other along s).
      const rows: Prop[][] = [];
      for (const p of t.props) {
        const row = rows[rows.length - 1];
        if (row && Math.abs(row[0].s - p.s) < 4) row.push(p);
        else rows.push([p]);
      }
      for (const row of rows) expect(row.length).toBeLessThan(t.lanesAt(row[0].s));
    }
  });
});

describe('lanes', () => {
  it('lane change times are Jog 0.22s, Stride 0.30s, Rampage 0.40s', () => {
    for (const [tier, dur] of [[0, 0.22], [1, 0.3], [2, 0.4]] as const) {
      const sim = emptySim();
      setTier(sim, tier);
      const from = sim.giant.lane;
      sim.step({ ...NO_INPUT, lane: 1 });
      let ticks = 1;
      while (sim.laneBusy) {
        sim.step(NO_INPUT);
        ticks++;
      }
      expect(sim.giant.lane).toBe(from + 1);
      expect(Math.abs(ticks / HZ - dur)).toBeLessThanOrEqual(1.5 / HZ);
      expect(sim.giant.d).toBeCloseTo(sim.track.laneCenter(from + 1), 6);
    }
  });

  it('queues one lane input during a change (newest wins), and buffers 5 frames during a stumble', () => {
    const sim = emptySim();
    sim.giant.lane = 0;
    sim.giant.d = sim.track.laneCenter(0);
    sim.step({ ...NO_INPUT, lane: 1 });
    sim.step({ ...NO_INPUT, lane: 1 });
    sim.step({ ...NO_INPUT, lane: 1 }); // only one is kept
    while (sim.laneBusy) sim.step(NO_INPUT);
    while (sim.laneBusy || sim.giant.lane < 2) {
      sim.step(NO_INPUT);
      if (sim.tick > 200) break;
    }
    expect(sim.giant.lane).toBe(2); // 0 → 1 → 2, not 3

    const s2 = emptySim();
    const start2 = s2.giant.lane;
    s2.giant.stumble = 3 / HZ; // ends in 3 frames: within the 5f buffer
    s2.step({ ...NO_INPUT, lane: -1 });
    run(s2, 0.5);
    expect(s2.giant.lane).toBe(start2 - 1);

    const s3 = emptySim();
    const start3 = s3.giant.lane;
    s3.giant.stumble = 8 / HZ; // ends after 8 frames: the buffer has expired
    s3.step({ ...NO_INPUT, lane: -1 });
    run(s3, 0.5);
    expect(s3.giant.lane).toBe(start3);
  });

  it('walls bounce you back into the lane with no stumble and no tier loss', () => {
    const sim = emptySim();
    setTier(sim, 2);
    sim.giant.lane = 0;
    sim.giant.d = sim.track.laneCenter(0);
    const ev = run(sim, 0.5, NO_INPUT).concat(sim.step({ ...NO_INPUT, lane: -1 }), run(sim, 0.6));
    expect(ev.some((e) => e.type === 'wallBump')).toBe(true);
    expect(sim.giant.lane).toBe(0);
    expect(sim.giant.tier).toBe(2);
    expect(sim.giant.stumble).toBe(0);
    expect(sim.giant.d).toBeCloseTo(sim.track.laneCenter(0), 6);
  });

  it('a merge that closes your lane moves you over, no stumble', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const sim = emptySim(seed);
      sim.track.ensure(5000);
      const close = sim.track.segments.find((s) => s.kind === 'merge' && s.lanes1 < s.lanes0);
      if (!close) continue;
      // Put the giant in the closing lane just before the merge.
      sim.giant.s = close.s0 - 10;
      sim.giant.lane = close.lanes0 - 1;
      sim.giant.d = sim.track.laneCenter(sim.giant.lane);
      const ev = run(sim, (close.length + 20) / sim.giant.speed + 1);
      expect(sim.giant.lane).toBeLessThan(close.lanes1);
      expect(ev.some((e) => e.type === 'wallBump' && e.forced)).toBe(true);
      expect(ev.some((e) => e.type === 'bounce')).toBe(false);
      return;
    }
    throw new Error('no closing merge found');
  });

  it('never drops below the 2 m/s floor, even braking forever (Law 1, LOCKED)', () => {
    const sim = emptySim();
    run(sim, 2, { ...NO_INPUT, brake: true });
    expect(sim.giant.speed).toBeCloseTo(TUNING.giant.speedFloor, 5);
    expect(sim.stats.minSpeed).toBeGreaterThanOrEqual(TUNING.giant.speedFloor);
  });

  it('tiers up Jog → Stride → Rampage on schedule; braking > 0.4s drops a tier', () => {
    const sim = emptySim();
    run(sim, 2.35);
    expect(sim.giant.tier).toBe(1);
    run(sim, 3.8);
    expect(sim.giant.tier).toBe(2);
    const ev = run(sim, 0.45, { ...NO_INPUT, brake: true });
    expect(ev.some((e) => e.type === 'tierDown' && e.reason === 'brake')).toBe(true);
  });
});

describe('smash-across and unsmashable hits (v0.3)', () => {
  /** Change lanes into a prop placed beside the giant. */
  const across = (tier: number, cls: Prop['cls']) => {
    const sim = emptySim();
    setTier(sim, tier);
    const target = sim.giant.lane + 1;
    // Long enough to be in the swept path when the change starts.
    const p = placeProp(sim, 'car', cls, sim.giant.s + 2.5, target);
    p.hl = 3;
    const ev = sim.step({ ...NO_INPUT, lane: 1 }).concat(run(sim, 0.6));
    return { sim, ev, from: target - 1 };
  };
  const table: [number, Prop['cls'], 'smash' | 'bounce'][] = [
    [0, 'medium', 'bounce'], [1, 'medium', 'smash'], [2, 'medium', 'smash'],
    [0, 'heavy', 'bounce'], [1, 'heavy', 'bounce'], [2, 'heavy', 'smash'],
  ];
  for (const [tier, cls, expected] of table) {
    it(`lane change into ${cls} at ${TUNING.tiers[tier].name} → ${expected}`, () => {
      const { ev } = across(tier, cls);
      expect(ev.some((e) => e.type === expected)).toBe(true);
      if (expected === 'smash') expect(ev.some((e) => e.type === 'smash' && e.across)).toBe(true);
    });
  }

  it('an unsmashable hit: −1 tier, 0.3s stumble, knocked back to the previous lane, never stopped', () => {
    const { ev, sim, from } = across(1, 'heavy');
    const b = ev.find((e) => e.type === 'bounce');
    expect(b && b.type === 'bounce' && b.toLane).toBe(from);
    expect(ev.some((e) => e.type === 'tierDown' && e.reason === 'impact')).toBe(true);
    expect(sim.giant.lane).toBe(from);
    expect(sim.stats.minSpeed).toBeGreaterThanOrEqual(TUNING.giant.speedFloor);
  });

  it('head-on into something unsmashable knocks you into a clear lane', () => {
    const sim = emptySim();
    setTier(sim, 1);
    const lane = sim.giant.lane;
    placeProp(sim, 'car', 'heavy', sim.giant.s + 8, lane);
    const ev = run(sim, 1.2);
    expect(ev.some((e) => e.type === 'bounce')).toBe(true);
    expect(sim.giant.lane).not.toBe(lane);
    expect(sim.giant.stumble).toBe(0);
  });

  it('Shoulder Check lifts the smash class by one (Stride vs heavy, head-on)', () => {
    const sim = emptySim();
    setTier(sim, 1);
    placeProp(sim, 'car', 'heavy', sim.giant.s + 4, sim.giant.lane);
    const ev = sim.step({ ...NO_INPUT, shoulder: true }).concat(run(sim, 0.4));
    expect(ev.some((e) => e.type === 'smash' && e.cls === 'heavy')).toBe(true);
  });
});

describe('run cycle (v0.3)', () => {
  it('cadence stays within the band at every speed, and step length = speed ÷ cadence', () => {
    for (let v = 2; v <= 18; v += 0.25) {
      const c = cadenceAt(v);
      expect(c).toBeGreaterThanOrEqual(TUNING.gait.cadenceMin);
      expect(c).toBeLessThanOrEqual(TUNING.gait.cadenceMax);
      expect(stepLengthAt(v) * c).toBeCloseTo(v, 9);
    }
    for (const T of TUNING.tiers) expect(cadenceAt(T.topSpeed)).toBeCloseTo(T.cadence, 9);
  });

  it('measured footfall cadence stays in the band at every tier (bot runs, 20 seeds)', () => {
    const byTier: number[][] = [[], [], []];
    for (let seed = 1; seed <= 20; seed++) {
      const sim = new Sim({ seed });
      const bot = new Bot(sim);
      let last = -1;
      for (let i = 0; i < 60 * HZ; i++) {
        for (const e of sim.step(bot.input())) {
          if (e.type !== 'footfall') continue;
          if (last >= 0) byTier[e.tier].push(1 / (e.t - last));
          last = e.t;
        }
      }
    }
    for (let t = 0; t < 3; t++) {
      expect(byTier[t].length, `tier ${t} sampled`).toBeGreaterThan(50);
      expect(Math.min(...byTier[t])).toBeGreaterThanOrEqual(TUNING.gait.cadenceMin - 1e-6);
      expect(Math.max(...byTier[t])).toBeLessThanOrEqual(TUNING.gait.cadenceMax + 1e-6);
    }
  });
});

describe('determinism', () => {
  it('same seed + same inputs = same state', () => {
    const a = new Sim({ seed: 7 });
    const b = new Sim({ seed: 7 });
    for (let i = 0; i < 1200; i++) {
      const input: SimInput = { lane: i % 97 === 0 ? 1 : i % 131 === 0 ? -1 : 0, brake: i % 400 < 10, shoulder: i % 180 === 0 };
      a.step(input);
      b.step(input);
    }
    expect([a.giant.s, a.giant.d, a.giant.speed, a.giant.tier]).toEqual([b.giant.s, b.giant.d, b.giant.speed, b.giant.tier]);
  });
});
