import { describe, expect, it } from 'vitest';
import { Show } from './show';
import { Sim } from './sim';
import { Bot } from './bot';
import { TUNING } from '../tuning';
import type { SimEvent } from './types';

describe('show (§12 Ratings, Heat, Pin)', () => {
  it('starts at 20; first-of-type pays ×1.5, repeats within 10s pay ×0.5 then ×0.25', () => {
    const sh = new Show();
    const ev: SimEvent[] = [];
    expect(sh.ratings).toBe(20);
    expect(sh.gain('heavy', 1, false, ev)).toBeCloseTo(7.5);
    expect(sh.gain('heavy', 2, false, ev)).toBeCloseTo(2.5);
    expect(sh.gain('heavy', 3, false, ev)).toBeCloseTo(1.25);
    expect(sh.gain('heavy', 20, false, ev)).toBeCloseTo(5); // window passed
    expect(sh.gain('medium', 21, true, ev)).toBeCloseTo(2 * 1.5 * 1.25); // outnumbered
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
    sh.stepPin(1, true, 6, ev);
    expect(sh.pin).toBe(0); // boxed but not slow
    sh.stepPin(1, true, 3, ev);
    expect(sh.pin).toBe(TUNING.show.pinFill);
    sh.stepPin(0.5, false, 9, ev);
    expect(sh.pin).toBe(TUNING.show.pinFill - TUNING.show.pinDrain * 0.5);
    for (let i = 0; i < 10; i++) sh.stepPin(1, true, 2, ev);
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
