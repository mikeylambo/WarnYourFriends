import { describe, expect, it } from 'vitest';
import { RunState, ABILITIES } from './run';
import { Sim, CLASS_RANK } from './sim';
import { Bot } from './bot';
import { TUNING, type UpgradeId } from '../tuning';
import type { SimEvent } from './types';

const playSegment = (run: RunState) => {
  const sim = new Sim({ seed: run.segmentSeed(), segment: run.segment, upgrades: run.owned });
  const bot = new Bot(sim);
  while (sim.live && sim.time < 170) sim.step(bot.input());
  return sim;
};

describe('run (§4, §17)', () => {
  it('pitches 3 distinct upgrades, never a passive you own; abilities replace the slot', () => {
    const run = new RunState(7);
    run.phase = 'meeting';
    run.earned = 100_000;
    const offers = run.offers();
    expect(offers.length).toBe(3);
    expect(new Set(offers).size).toBe(3);
    run.owned = ['leap', 'ironShins'];
    run['offerCache'] = null;
    expect(run.offers()).not.toContain('ironShins');
    expect(run.offers()).not.toContain('leap');
    const ab = run.offers().find((u) => (ABILITIES as string[]).includes(u));
    if (ab) {
      expect(run.buy(ab)).toBe(true);
      expect(run.ability).toBe(ab);
      expect(run.owned.filter((u) => (ABILITIES as string[]).includes(u)).length).toBe(1);
      expect(run.owned).toContain('ironShins');
    }
  });

  it("can't buy what it can't afford; spending lowers the purse, not the score", () => {
    const run = new RunState(3);
    run.phase = 'meeting';
    run.earned = 1000;
    const id = run.offers()[0];
    expect(run.buy(id)).toBe(false);
    run.earned = 50_000;
    expect(run.buy(id)).toBe(true);
    expect(run.purse).toBe(50_000 - TUNING.upgrades[id].price);
    expect(run.earned).toBe(50_000);
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

  it('Pose: a deliberate stop at the floor (never below 2 m/s) that spends Heat for Ratings', () => {
    const sim = new Sim({ seed: 5, segment: 3, upgrades: ['pose'] });
    run(sim, 300);
    const heat = sim.show.heat;
    const r0 = sim.show.ratings;
    const ev = run(sim, 1, { ability: true });
    expect(ev.some((e) => e.type === 'pose')).toBe(true);
    expect(sim.show.heat).toBe(Math.max(1, heat - 1));
    expect(sim.show.ratings).toBeGreaterThan(r0);
    for (let i = 0; i < 60; i++) {
      run(sim, 1);
      expect(sim.giant.speed).toBeGreaterThanOrEqual(TUNING.giant.speedFloor);
    }
  });

  it('Iron Shins: Medium never bounces you, even at Jog; Tailwind tiers up sooner', () => {
    expect(new Sim({ seed: 1, upgrades: ['ironShins'] }).smashRank()).toBeGreaterThanOrEqual(CLASS_RANK.medium);
    expect(new Sim({ seed: 1 }).smashRank()).toBeLessThan(CLASS_RANK.medium);
    const tierUpAt = (ups: UpgradeId[]) => {
      const sim = new Sim({ seed: 1, upgrades: ups });
      for (let i = 0; i < 1200; i++) for (const e of sim.step({ lane: 0, brake: false, shoulder: false })) if (e.type === 'tierUp') return sim.time;
      return Infinity;
    };
    expect(tierUpAt(['tailwind'])).toBeLessThan(tierUpAt([]));
  });
});
