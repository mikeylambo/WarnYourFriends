import { describe, expect, it } from 'vitest';
import { Show } from './show';
import { Sim } from './sim';
import { Bot } from './bot';
import { TUNING } from '../tuning';
import type { SimEvent } from './types';

describe('show (§12 Ratings, Heat, Pin)', () => {
  it('Police Net: the first full box-in slips (Ratings lost, not busted), the second busts', () => {
    const sh = new Show();
    const ev: SimEvent[] = [];
    sh.ratings = 60;
    for (let i = 0; i < 60 * 4; i++) sh.stepPin(1 / 60, true, false, 2, ev);
    expect(ev.some((e) => e.type === 'netSlip')).toBe(true);
    expect(sh.state).toBe('live');
    expect(sh.ratings).toBe(60 - TUNING.pursuit.net.slipRatings);
    for (let i = 0; i < 60 * 4; i++) sh.stepPin(1 / 60, true, false, 2, ev);
    expect(sh.state).toBe('busted');
    expect(sh.reason).toBe('pin');
  });

  it('starts at 20; first-of-type pays ×1.5, repeats within 10s pay ×0.5 then ×0.25', () => {
    const sh = new Show();
    const ev: SimEvent[] = [];
    expect(sh.ratings).toBe(20);
    const H = TUNING.show.gain.heavy;
    const M = TUNING.show.gain.medium;
    expect(sh.gain('heavy', 1, false, ev)).toBeCloseTo(H * 1.5);
    expect(sh.gain('heavy', 2, false, ev)).toBeCloseTo(H * 0.5);
    expect(sh.gain('heavy', 3, false, ev)).toBeCloseTo(H * 0.25);
    expect(sh.gain('heavy', 20, false, ev)).toBeCloseTo(H); // window passed
    expect(sh.gain('medium', 21, true, ev)).toBeCloseTo(M * 1.5 * 1.25); // outnumbered
  });

  it('decays after 3s without a gain and busts at 0 (network cuts to commercial)', () => {
    const sh = new Show();
    const ev: SimEvent[] = [];
    for (let t = 0; t < 30 && sh.state === 'live'; t += 1 / 60) sh.step(1 / 60, t, 0, false, ev);
    expect(sh.state).toBe('busted');
    expect(sh.reason).toBe('ratings');
    // 20 Ratings at 2/s after the 3s grace: about 13s.
    const at = ev.findIndex((e) => e.type === 'busted');
    expect(at).toBeGreaterThanOrEqual(0);
  });

  it('Heat rises at 30/50/70/90 and every 45s, never falls, caps at 5', () => {
    const sh = new Show();
    const ev: SimEvent[] = [];
    sh.ratings = 29;
    sh.gain('heavy', 0, false, ev);
    expect(sh.heat).toBe(2);
    let heat = sh.heat;
    for (let t = 0; t < 400; t += 0.5) {
      sh.gain('medium', t, false, ev);
      sh.step(0.5, t, 2, false, ev);
      expect(sh.heat).toBeGreaterThanOrEqual(heat);
      heat = sh.heat;
    }
    expect(sh.heat).toBe(5);
  });

  it('Pin fills only when boxed and slow, drains when fast, busts at 100', () => {
    const sh = new Show();
    const ev: SimEvent[] = [];
    sh.stepPin(1, true, false, 6, ev);
    expect(sh.pin).toBe(0); // boxed but not slow
    sh.stepPin(1, true, false, 3, ev);
    expect(sh.pin).toBe(TUNING.show.pinFill);
    sh.stepPin(0.5, false, false, 9, ev);
    expect(sh.pin).toBe(TUNING.show.pinFill - TUNING.show.pinDrain * 0.5);
    for (let i = 0; i < 10; i++) sh.stepPin(1, true, false, 2, ev);
    expect(sh.state).toBe('busted');
    expect(sh.reason).toBe('pin');
  });
});

describe('segment (LOCKED 150s + 15s grace)', () => {
  it('a player who never takes the exit is busted by 165s', () => {
    const sim = new Sim({ seed: 4 });
    const bot = new Bot(sim);
    while (sim.live && sim.time < 200) {
      // Bot, but always steering for the far-left lane: never the exit.
      const inp = bot.input();
      sim.step({ ...inp, lane: sim.giant.lane > 0 ? -1 : 0 });
    }
    expect(sim.live).toBe(false);
    expect(sim.time).toBeLessThanOrEqual(TUNING.segment.length + TUNING.segment.grace + 1e-6);
    expect(sim.show.state).toBe('busted');
  });

  it('the exit opens on time and within reach (the road ahead is planned ramp-friendly)', () => {
    let late = 0;
    let unreachable = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const sim = new Sim({ seed, growth: true });
      const bot = new Bot(sim);
      while (sim.live && sim.time < 140) {
        for (const e of sim.step(bot.input())) {
          if (e.type !== 'exitOpen') continue;
          if (sim.time > TUNING.segment.exitOpensAt + 1) late++;
          const left = TUNING.segment.length + TUNING.segment.grace - sim.time;
          if (sim.giant.speed > 8 && e.s - sim.giant.s > sim.giant.speed * left - 20) unreachable++;
        }
      }
    }
    expect(late).toBe(0);
    expect(unreachable).toBe(0);
  }, 20_000); // many seeds of full sim: ~3s alone, over 5s under a parallel run

  it('the bot takes the exit ramp and signs off', () => {
    const sim = new Sim({ seed: 2 });
    const bot = new Bot(sim);
    const events: SimEvent[] = [];
    while (sim.live && sim.time < 200) events.push(...sim.step(bot.input()));
    expect(events.some((e) => e.type === 'exitOpen')).toBe(true);
    expect(sim.show.state).toBe('cleared');
    expect(sim.time).toBeGreaterThan(TUNING.segment.exitOpensAt);
  });
});

describe('spectacle chain (Mike, 2026-11-15)', () => {
  const C = TUNING.spectacle;
  it('stunts inside the window chain; the multiplier steps up every few stunts; a timeout banks at the multiplier', () => {
    const sh = new Show();
    const ev: SimEvent[] = [];
    for (let i = 0; i < 5; i++) sh.stunt('medium', i * 1.0, 0, ev);
    expect(sh.chain.count).toBe(5);
    expect(Show.chainMult(5)).toBe(1 + Math.floor(4 / C.stepEvery));
    expect(sh.banked).toBe(0); // nothing banks until the chain ends
    sh.step(1 / 60, 4 + C.window + 0.1, 0, false, ev);
    const end = ev.find((e) => e.type === 'chainEnd');
    expect(end && end.type === 'chainEnd' && !end.dropped).toBe(true);
    expect(sh.banked).toBe(Math.round(5 * C.points.medium * Show.chainMult(5)));
  });

  it('a bounce drops the chain: its points bank at ×1', () => {
    const sh = new Show();
    const ev: SimEvent[] = [];
    for (let i = 0; i < 6; i++) sh.stunt('heavy', i * 0.5, 0, ev);
    sh.endChain(true, ev);
    expect(sh.banked).toBe(6 * C.points.heavy);
  });

  it('gear and audience multiply each stunt; the multiplier is capped', () => {
    const sh = new Show();
    const ev: SimEvent[] = [];
    sh.ratings = 95; // CITY IN CHAOS
    sh.stunt('heavy', 0, 2, ev);
    const c = ev.find((e) => e.type === 'chain');
    expect(c && c.type === 'chain' && c.add).toBe(C.points.heavy * TUNING.show.bankMult[2] * C.audienceMult[3]);
    expect(Show.chainMult(999)).toBe(C.maxMult);
  });

  it('a bot broadcast banks points only through chains, asks and distance, and the score spreads with play', () => {
    const scores: number[] = [];
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const sim = new Sim({ seed });
      const bot = new Bot(sim);
      let fromChains = 0;
      while (sim.live && sim.time < 200) for (const e of sim.step(bot.input())) if (e.type === 'chainEnd') fromChains += e.points;
      const fromDistance = sim.stats.distancePoints;
      // Score = chains + the producer's asks that landed + distance (Rampage loop, 2026-11-17).
      expect(Math.abs(sim.show.banked - (fromChains + fromDistance + sim.asks.list.reduce((n, x) => n + (x.done ? x.reward : 0), 0)))).toBeLessThan(2);
      scores.push(sim.show.banked);
    }
    expect(Math.max(...scores)).toBeGreaterThan(Math.min(...scores) * 1.2);
  });
});

