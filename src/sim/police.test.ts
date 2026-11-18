import { describe, expect, it } from 'vitest';
import { Sim } from './sim';
import { TUNING } from '../tuning';
import { NO_INPUT, type Prop, type SimEvent, type SimInput, type Unit } from './types';

const HZ = TUNING.sim.hz;

/** Empty road, nothing spawning on its own (tests stay under `pursuit.firstAt`). */
function emptySim(seed = 1): Sim {
  const sim = new Sim({ seed });
  sim.show.ratings = 90; // an empty road decays to a bust; keep the broadcast on air (below the cap, so gains show)
  sim.track.props.length = 0;
  (sim.track as unknown as { addProps: () => void }).addProps = () => {};
  return sim;
}

function run(sim: Sim, seconds: number, input: SimInput = NO_INPUT): SimEvent[] {
  const out: SimEvent[] = [];
  for (let i = 0; i < Math.round(seconds * HZ); i++) out.push(...sim.step(input));
  return out;
}

function placeProp(sim: Sim, cls: Prop['cls'], s: number, lane: number): Prop {
  const p: Prop = { id: 9000 + sim.track.props.length, kind: cls === 'medium' ? 'cart' : 'van', cls, mat: 'metal', s, d: sim.track.laneCenter(lane), hl: 1.2, hw: 1.0, h: 1.8, variant: 0, alive: true, segment: 0 };
  sim.track.props.push(p);
  sim.track.props.sort((a, b) => a.s - b.s);
  return p;
}

type PursuitInternals = { spawn: (k: string) => boolean; make: (kind: string, unit: string, s: number, d: number, lane: number) => Unit };
const internals = (sim: Sim) => sim.pursuit as unknown as PursuitInternals;

/** Run until the police chopper has him (cone swept in, locked). */
function locked(sim: Sim): Unit {
  sim.giant.tier = 1;
  sim.giant.speed = TUNING.tiers[1].topSpeed;
  sim.giant.tierTimer = -1e9;
  expect(internals(sim).spawn('chopper')).toBe(true);
  const ev = run(sim, 6);
  expect(ev.some((e) => e.type === 'tell' && e.kind === 'chopper')).toBe(true);
  expect(ev.some((e) => e.type === 'spotlight')).toBe(true);
  return sim.pursuit.units.find((u) => u.unit === 'chopper')!;
}

describe('police chopper spotlight (v0.3 §11)', () => {
  it('spawns ≥40m away, sweeps in with a 1.5s tell, then locks on and marks his lane', () => {
    const sim = emptySim();
    sim.giant.speed = TUNING.tiers[1].topSpeed;
    internals(sim).spawn('chopper');
    const u = sim.pursuit.units.find((x) => x.unit === 'chopper')!;
    expect(u.s - sim.giant.s).toBeGreaterThanOrEqual(40);
    let tellAt = -1;
    let lockAt = -1;
    for (let i = 0; i < 6 * HZ; i++) {
      for (const e of sim.step(NO_INPUT)) {
        if (e.type === 'tell' && e.kind === 'chopper') tellAt = sim.time;
        if (e.type === 'spotlight') lockAt = sim.time;
      }
    }
    expect(tellAt).toBeGreaterThan(0);
    expect(lockAt - tellAt).toBeCloseTo(TUNING.pursuit.chopper.tell, 1);
    expect(sim.pursuit.marked).toBe(true);
  });

  it('one lane change does not shake it; two in quick succession do (+lost track)', () => {
    const sim = emptySim();
    const u = locked(sim);
    run(sim, 0.05, { ...NO_INPUT, lane: 1 });
    run(sim, 1);
    expect(u.phase).toBe('act');
    expect(sim.pursuit.marked).toBe(true);
    sim.show.ratings = 50; // room under the cap to see the lost-track gain
    const before = sim.show.ratings;
    const ev = run(sim, 0.05, { ...NO_INPUT, lane: -1 }).concat(run(sim, 1));
    expect(ev.some((e) => e.type === 'lostTrack' && e.kind === 'chopper')).toBe(true);
    expect(sim.show.ratings).toBeGreaterThan(before);
    expect(sim.pursuit.marked).toBe(false);
  });

  it('a queued lane change counts as a shake', () => {
    const sim = emptySim();
    const u = locked(sim);
    run(sim, 1 / HZ, { ...NO_INPUT, lane: 1 });
    run(sim, 1 / HZ, { ...NO_INPUT, lane: -1 }); // queued behind the first (back, away from any wall)
    run(sim, 1);
    expect(u.phase).toBe('leave');
  });

  it('lane changes too far apart do not add up', () => {
    const sim = emptySim();
    const u = locked(sim);
    // Single-frame taps: a held key queues a second change, and every change counts (queued ones too).
    run(sim, 1 / HZ, { ...NO_INPUT, lane: 1 });
    run(sim, TUNING.pursuit.chopper.shakeWindow + 0.5);
    run(sim, 1 / HZ, { ...NO_INPUT, lane: -1 });
    run(sim, 0.6);
    expect(u.phase).toBe('act');
  });

  it('gives up after its lock time with no award', () => {
    const sim = emptySim();
    locked(sim);
    const ev = run(sim, TUNING.pursuit.chopper.lockMax + 0.5);
    expect(ev.some((e) => e.type === 'lostTrack')).toBe(false);
    expect(sim.pursuit.marked).toBe(false);
  });
});

describe('police crashes', () => {
  /** A cruiser alongside him in the outside lane (no way out away from him). */
  const alongside = (cls: Prop['cls']) => {
    const sim = emptySim();
    const g = sim.giant;
    g.tier = 1;
    g.speed = TUNING.tiers[1].topSpeed;
    g.tierTimer = -1e9;
    run(sim, 1);
    const lane = sim.track.lanesAt(g.s) - 1;
    expect(g.lane).toBe(lane - 1);
    const u = internals(sim).make('cruiser', 'cruiser', g.s - 1, sim.track.laneCenter(lane), lane);
    u.speed = g.speed;
    const p = placeProp(sim, cls, g.s + 14, lane);
    const ev = run(sim, 2.5);
    return { sim, u, p, ev };
  };

  it('a cruiser fixated on him crashes into something Heavy in its lane: out of the chase, the van goes flying, Ratings up', () => {
    const { u, p, ev } = alongside('heavy');
    const crash = ev.find((e) => e.type === 'policeCrash');
    expect(crash && crash.type === 'policeCrash' && crash.propSmashed).toBe(true);
    expect(u.alive).toBe(false);
    expect(p.alive).toBe(false);
    expect(ev.some((e) => e.type === 'ratings' && e.cause === 'policeCrash')).toBe(true);
    expect(ev.some((e) => e.type === 'lostTrack' && e.id === u.id)).toBe(false); // the crash is the award
  });

  it('it ploughs through something Medium and stays in the chase', () => {
    const { u, p, ev } = alongside('medium');
    expect(ev.some((e) => e.type === 'policeSmash')).toBe(true);
    expect(ev.some((e) => e.type === 'policeCrash')).toBe(false);
    expect(p.alive).toBe(false);
    expect(u.alive).toBe(true);
  });

  it('never crashes out of frame: a cruiser well behind him drives past instead', () => {
    const sim = emptySim();
    const g = sim.giant;
    run(sim, 1);
    const lane = g.lane + 1;
    const u = internals(sim).make('cruiser', 'cruiser', g.s - 20, sim.track.laneCenter(lane), lane);
    u.phase = 'leave';
    placeProp(sim, 'heavy', g.s - 15, lane);
    const ev = run(sim, 1.5);
    expect(ev.some((e) => e.type === 'policeCrash')).toBe(false);
  });

  it('a cruiser pulling away never parks: it keeps moving and leaves his lane', () => {
    const sim = emptySim();
    const g = sim.giant;
    run(sim, 1);
    g.tier = 0; // a gear that can't flatten it: this is about the cruiser driving off, not a smash
    g.speed = TUNING.giant.speedFloor;
    const u = internals(sim).make('cruiser', 'cruiser', g.s + 1, g.d, g.lane);
    u.phase = 'leave';
    run(sim, 1.5, { ...NO_INPUT, brake: true });
    expect(u.speed).toBeGreaterThan(0);
    expect(Math.abs(u.d - g.d)).toBeGreaterThan(TUNING.lanes.width * 0.5);
  });

  it('caught: crawling with a cruiser on his tail fills the meter, and the first catch busts him (Mike, 2026-11-17)', () => {
    const sim = emptySim(3);
    run(sim, 3);
    const g = sim.giant;
    const cop = internals(sim).make('cruiser', 'cruiser', g.s - 15, sim.track.laneCenter(Math.min(g.lane + 1, sim.track.lanesAt(g.s) - 1)), Math.min(g.lane + 1, sim.track.lanesAt(g.s) - 1));
    cop.speed = g.speed;
    const ev: SimEvent[] = [];
    for (let i = 0; i < HZ * 20 && sim.show.state === 'live'; i++) {
      sim.show.ratings = 100; // isolate the police from the audience
      ev.push(...sim.step({ ...NO_INPUT, brake: true }));
    }
    expect(ev.some((e) => e.type === 'netSlip')).toBe(false); // no shaking them off
    expect(sim.show.state).toBe('busted');
    expect(sim.show.pinCause).toBe('caught');
    expect(sim.show.reason).toBe('pin');
    expect(sim.giant.speed).toBeGreaterThanOrEqual(TUNING.giant.speedFloor - 1e-9); // Law 1 held throughout
  });

  it('caught: running at Jog with a cruiser alongside never fills the meter', () => {
    const sim = emptySim(3);
    run(sim, 3);
    const g = sim.giant;
    const lane = Math.min(g.lane + 1, sim.track.lanesAt(g.s) - 1);
    internals(sim).make('cruiser', 'cruiser', g.s - 3, sim.track.laneCenter(lane), lane).speed = g.speed;
    let maxPin = 0;
    for (let i = 0; i < HZ * 6; i++) {
      sim.step(NO_INPUT);
      maxPin = Math.max(maxPin, sim.show.pin);
    }
    expect(maxPin).toBe(0);
  });
});

describe('rams take Rampage (Mike, 2026-11-16)', () => {
  /** A cruiser alongside him, already swerving into his lane. */
  function ramming(sim: Sim): Unit {
    const g = sim.giant;
    g.tier = 2;
    g.speed = TUNING.tiers[2].topSpeed;
    g.tierTimer = -1e9;
    run(sim, 1); // settle at speed, clear of the start
    const lane = g.lane > 0 ? g.lane - 1 : g.lane + 1;
    const u = internals(sim).make('cruiser', 'cruiser', g.s, sim.track.laneCenter(lane), lane);
    u.speed = g.speed;
    u.target = g.lane;
    u.fromD = u.d;
    u.toD = sim.track.laneCenter(g.lane);
    u.phase = 'act';
    u.phaseT = 0;
    return u;
  }

  it('a ram that connects in Stride costs meter (never a gear), and the cruiser is not flattened', () => {
    const sim = emptySim();
    const u = ramming(sim);
    sim.giant.tier = 1;
    sim.giant.meter = 50;
    const ev = run(sim, 0.5);
    expect(ev.some((e) => e.type === 'meterLoss')).toBe(true);
    expect(ev.some((e) => e.type === 'tierDown')).toBe(false);
    expect(ev.some((e) => e.type === 'smash' && e.propId === u.id)).toBe(false);
    expect(sim.giant.speed).toBeGreaterThanOrEqual(TUNING.giant.speedFloor);
  });

  it('in Rampage a ram is flattened and Rampage carries on (Rampage loop: he runs through everything)', () => {
    const sim = emptySim();
    const u = ramming(sim);
    sim.giant.rampT = 5;
    const dir = Math.sign(u.d - sim.giant.d);
    const ev = run(sim, 1 / HZ, { ...NO_INPUT, lane: dir }).concat(run(sim, 0.5));
    expect(ev.some((e) => e.type === 'smash' && e.propId === u.id)).toBe(true);
    expect(ev.some((e) => e.type === 'tierDown')).toBe(false);
  });
});

describe('kiting (Mike, 2026-11-17)', () => {
  it('a cruiser alongside him holds its lane into a bulldozer and crashes on air', () => {
    const sim = emptySim();
    const g = sim.giant;
    g.tier = 1;
    g.speed = TUNING.tiers[1].topSpeed;
    g.tierTimer = -1e9;
    run(sim, 1);
    const lane = g.lane > 0 ? g.lane - 1 : g.lane + 1;
    const u = internals(sim).make('cruiser', 'cruiser', g.s - 1, sim.track.laneCenter(lane), lane);
    u.speed = g.speed;
    (sim as unknown as { tellBusy: () => boolean }).tellBusy = () => true; // no ram: this is about riding alongside
    const dozer = placeProp(sim, 'immovable', g.s + 25, lane);
    dozer.kind = 'dozer';
    const ev = run(sim, 4);
    const crash = ev.find((e) => e.type === 'policeCrash' && e.id === u.id);
    expect(crash).toBeTruthy();
    expect(crash && crash.type === 'policeCrash' && crash.onAir).toBe(true);
  });

  it('a cruiser runs over a spike strip that is down', () => {
    const sim = emptySim();
    const g = sim.giant;
    g.tier = 1;
    g.speed = TUNING.tiers[1].topSpeed;
    g.tierTimer = -1e9;
    run(sim, 1);
    const lane = g.lane > 0 ? g.lane - 1 : g.lane + 1;
    const u = internals(sim).make('cruiser', 'cruiser', g.s - 1, sim.track.laneCenter(lane), lane);
    u.speed = g.speed;
    const spike = internals(sim).make('barricade', 'spike', g.s + 20, sim.track.laneCenter(lane), lane);
    Object.assign(spike, { solid: false, hl: 0.35, hw: 1.8, cls: 'immovable', phase: 'act' });
    const ev = run(sim, 3);
    expect(ev.some((e) => e.type === 'policeCrash' && e.id === u.id && e.spikes)).toBe(true);
  });
});
