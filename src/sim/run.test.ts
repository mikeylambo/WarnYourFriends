import { describe, expect, it } from 'vitest';
import { RunState, ABILITIES } from './run';
import { Sim } from './sim';
import { Bot } from './bot';
import { TUNING, type UpgradeId } from '../tuning';
import type { SimEvent } from './types';

const playSegment = (run: RunState) => {
  const sim = new Sim({ seed: run.segmentSeed(), segment: run.segment, upgrades: run.owned, levels: run.levels });
  const bot = new Bot(sim);
  while (sim.live && sim.time < 170) sim.step(bot.input());
  return sim;
};

describe('run (§4, §17)', () => {
  it('pitches 3 distinct upgrades, never a passive you own; abilities replace the slot', () => {
    const run = new RunState(7);
    run.phase = 'meeting';
    run.earned = 1_000_000;
    const offers = run.offers();
    expect(offers.length).toBe(3);
    expect(new Set(offers).size).toBe(3);
    run.owned = ['leap', 'thickSkin'];
    run.levels = { leap: 3 };
    run['offerCache'] = null;
    expect(run.offers()).not.toContain('thickSkin');
    expect(run.offers()).not.toContain('leap'); // maxed at III
    const ab = run.offers().find((u) => (ABILITIES as string[]).includes(u));
    if (ab) {
      expect(run.buy(ab)).toBe(true);
      expect(run.ability).toBe(ab);
      expect(run.owned.filter((u) => (ABILITIES as string[]).includes(u)).length).toBe(1);
      expect(run.owned).toContain('thickSkin');
      expect(run.levelOf(ab as never)).toBe(1);
    }
  });

  it('the ability you hold comes back as its next level, at the level-up price; locked upgrades never show', () => {
    const run = new RunState(9, ['leap', 'stare', 'primeTime', 'thickSkin', 'secondWind', 'crowdPleaser']);
    run.phase = 'meeting';
    run.earned = 5_000_000;
    run.owned = ['stare'];
    run.levels = { stare: 1 };
    for (let k = 0; k < 40; k++) {
      run['offerCache'] = null;
      run['rng'] = new (run['rng'].constructor as new (s: number) => typeof run['rng'])(k);
      const offers = run.offers();
      expect(offers).not.toContain('breakaway');
      expect(offers).not.toContain('slipstream');
      if (offers.includes('stare')) {
        expect(run.priceOf('stare')).toBe(Math.round(TUNING.upgrades.stare.price * TUNING.levelPrice));
        expect(run.buy('stare')).toBe(true);
        expect(run.levelOf('stare')).toBe(2);
        return;
      }
    }
    throw new Error('the held ability was never re-offered');
  });

  it("can't buy what it can't afford; spending lowers the purse, not the score", () => {
    const run = new RunState(3);
    run.phase = 'meeting';
    run.earned = 1000;
    const id = run.offers()[0];
    expect(run.buy(id)).toBe(false);
    run.earned = 500_000;
    expect(run.buy(id)).toBe(true);
    expect(run.purse).toBe(500_000 - TUNING.upgrades[id].price);
    expect(run.earned).toBe(500_000);
    expect(run.segment).toBe(1);
  });

  it('a full run plays to won or lost; later segments start hotter', () => {
    const run = new RunState(11);
    let guard = 0;
    while ((run.phase === 'live' || run.phase === 'meeting') && guard++ < 10) {
      if (run.phase === 'meeting') {
        const affordable = run.offers().find((u) => run.canAfford(u));
        if (affordable) run.buy(affordable);
        else run.nextSegment();
        continue;
      }
      const sim = playSegment(run);
      expect(sim.live).toBe(false);
      run.finishSegment(sim.show);
    }
    expect(['won', 'lost']).toContain(run.phase);
    expect(run.results.length).toBeGreaterThan(0);
    for (let seg = 0; seg < TUNING.run.segments; seg++) expect(new Sim({ seed: 1, segment: seg }).show.heat).toBe(Math.min(5, 1 + seg));
  });
});

describe('abilities and passives (§17)', () => {
  const run = (sim: Sim, n: number, inp: Partial<{ ability: boolean; brake: boolean; lane: number }> = {}) => {
    const ev: SimEvent[] = [];
    for (let i = 0; i < n; i++) ev.push(...sim.step({ lane: 0, brake: false, shoulder: false, ability: false, ...inp }));
    return ev;
  };

  it('Leap: airborne, then lands with a shockwave; cooldown applies', () => {
    const sim = new Sim({ seed: 5, upgrades: ['leap'] });
    run(sim, 120);
    const ev = run(sim, 1, { ability: true });
    expect(ev.some((e) => e.type === 'ability' && e.id === 'leap' && e.ok)).toBe(true);
    expect(sim.giant.air).toBeGreaterThan(0);
    const later = run(sim, 70);
    expect(later.some((e) => e.type === 'leapLand')).toBe(true);
    expect(run(sim, 1, { ability: true }).some((e) => e.type === 'ability')).toBe(false); // cooling down
  });

  it('Leap III flattens an armored truck on landing; Leap I does not', () => {
    for (const level of [1, 3]) {
      const sim = new Sim({ seed: 5, upgrades: ['leap'], levels: { leap: level } });
      run(sim, 120);
      run(sim, 1, { ability: true });
      const g = sim.giant;
      const truck = { id: 9001, kind: 'armored' as const, cls: 'immovable' as const, mat: 'metal' as const, s: g.s + g.speed * g.air + 1, d: g.d + 3, hl: 2.9, hw: 1.25, h: 2.9, variant: 0, alive: true, segment: 0 };
      sim.track.props.push(truck);
      sim.track.props.sort((a, b) => a.s - b.s);
      run(sim, 90);
      expect(truck.alive).toBe(level < 3);
    }
  });

  it('Breakaway: a dive faster than his top speed, a slam, and the police behind him lose track', () => {
    const sim = new Sim({ seed: 5, upgrades: ['breakaway'] });
    run(sim, 300);
    const cop = (sim.pursuit as unknown as { make: (k: string, u: string, s: number, d: number, l: number) => { speed: number; lost: boolean } }).make('cruiser', 'cruiser', sim.giant.s - 12, sim.giant.d, sim.giant.lane);
    cop.speed = sim.giant.speed;
    run(sim, 1, { ability: true });
    let maxSpeed = 0;
    const ev: SimEvent[] = [];
    for (let i = 0; i < 90; i++) {
      ev.push(...run(sim, 1));
      maxSpeed = Math.max(maxSpeed, sim.giant.speed);
    }
    expect(maxSpeed).toBeGreaterThan(sim.tierTuning.topSpeed);
    const land = ev.find((e) => e.type === 'breakawayLand');
    expect(land && land.type === 'breakawayLand' && land.shaken).toBeGreaterThanOrEqual(1);
    expect(cop.lost).toBe(true);
  });

  it('Prime Time: no drain while it runs, and a smash pays double', () => {
    const sim = new Sim({ seed: 5, upgrades: ['primeTime'] });
    run(sim, 60 * 14); // past the opening grace
    sim.show.ratings = 50;
    run(sim, 1, { ability: true });
    expect(sim.show.prime).toBe(true);
    const r0 = sim.show.ratings;
    run(sim, 60 * 5);
    expect(sim.show.ratings).toBeGreaterThanOrEqual(r0 - 1e-9);
    const smash = (prime: boolean) => {
      const s2 = new Sim({ seed: 5 });
      s2.show.ratings = 20;
      s2.show.prime = prime;
      return s2.show.gain('heavy', 1, false, []);
    };
    expect(smash(true)).toBeCloseTo(smash(false) * TUNING.abilities.primeTime.mult, 5);
    run(sim, 60 * 10);
    expect(sim.show.prime).toBe(false);
  });

  it('Thick Skin shrugs off the first hit each segment (no meter lost); Second Wind ends a Rampage with the meter a third full', () => {
    const hit = (ups: UpgradeId[]) => {
      const sim = new Sim({ seed: 1, upgrades: ups });
      sim.giant.meter = 80;
      (sim as unknown as { hit: (r: string) => void }).hit('impact');
      return sim.giant.meter;
    };
    expect(hit(['thickSkin'])).toBe(80);
    expect(hit([])).toBe(80 - TUNING.rampage.bounceCost);
    const after = (ups: UpgradeId[]) => {
      const sim = new Sim({ seed: 1, upgrades: ups });
      sim.giant.meter = 100;
      sim.step({ lane: 0, brake: false, shoulder: true });
      for (let i = 0; i < 60 * (TUNING.rampage.maxDuration + 1) && sim.inRampage; i++) sim.step({ lane: 0, brake: false, shoulder: false });
      return sim.giant.meter;
    };
    expect(after(['secondWind'])).toBe(TUNING.rampage.secondWindKeep);
    expect(after([])).toBe(0);
  });

  it('Crowd Pleaser slows the drain at Rampage; Slipstream doubles a police crash', () => {
    const drain = (ups: UpgradeId[]) => {
      const sim = new Sim({ seed: 1, upgrades: ups });
      const sh = sim.show;
      sh.ratings = 60;
      for (let i = 0; i < 60 * 3; i++) sh.step(1 / 60, 20 + i / 60, 2, false, []);
      return 60 - sh.ratings;
    };
    expect(drain(['crowdPleaser'])).toBeCloseTo(drain([]) * TUNING.passives.crowdPleaserDecay, 5);
    const crash = (ups: UpgradeId[]) => {
      const sim = new Sim({ seed: 1, upgrades: ups });
      sim.show.ratings = 20;
      return sim.show.gain('policeCrash', 1, false, []);
    };
    expect(crash(['slipstream'])).toBeCloseTo(crash([]) * 2, 5);
  });
});
