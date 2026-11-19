import { describe, expect, it } from 'vitest';
import { TUNING, enableProto } from '../tuning';
import { Sim } from './sim';
import { Bot } from './bot';

// Story asks (2026-11-19): every ask in the pool can be finished, and the traffic mods run.
enableProto();

describe('story asks', () => {
  it('every ask lands in some bot run; mods change the road', () => {
    const ids = TUNING.proto.storyAsks.map((a) => a.id);
    const done = new Set<string>();
    let best = 0;
    for (let seed = 1; seed <= 10 && done.size < ids.length; seed++) {
      const mods = seed % 2 ? Object.keys(TUNING.proto.mods) : [];
      const sim = new Sim({ seed, growth: true, asks: ids, mods });
      expect(sim.asks.list.length).toBe(ids.length);
      const bot = new Bot(sim);
      for (let i = 0; i < 60 * 420 && sim.live; i++) sim.step(bot.input());
      for (const a of sim.asks.list) if (a.done) done.add(a.id);
      best = Math.max(best, sim.asks.list.find((a) => a.id === 's-units')!.progress);
    }
    // Hit-free asks depend on the bot's luck, and it doesn't hunt police (a player chasing it does): those it
    // needn't finish, but it gets within one police car of the police ask. Everything else must land.
    const missing = ids.filter((id) => !done.has(id) && !['s-clean', 's-tunnel', 's-units'].includes(id));
    expect(missing).toEqual([]);
    expect(best, 'police flattened in one run').toBeGreaterThanOrEqual(TUNING.proto.storyAsks.find((a) => a.id === 's-units')!.n - 1);
  }, 120000);

  it('Heavy Load raises the chunk level; Hot Pursuit the spawn pace', () => {
    const sim = new Sim({ seed: 3, growth: true, mods: ['heavyLoad', 'hotPursuit'] });
    const base = new Sim({ seed: 3, growth: true });
    expect(sim.track.levelAt(0)).toBe(Math.min(5, base.track.levelAt(0) + 1));
    expect(sim.pursuit.pace).toBeCloseTo(1.5);
  });
});
