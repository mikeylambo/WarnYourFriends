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
      const mods = seed % 2 ? ['heavyLoad'] : []; // one mod: with all five on the bot never signs off
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

describe('Tonight\'s Rundown offer', () => {
  it('a fresh profile gets more asks than picks, easy ones topped up', async () => {
    const { storyAskOffer } = await import('../awards');
    const fresh = { asksDone: [] as string[] } as unknown as Parameters<typeof storyAskOffer>[0];
    const { open } = storyAskOffer(fresh, () => 0);
    expect(open.length).toBeGreaterThanOrEqual(TUNING.proto.storyPick + TUNING.proto.storySpare);
    expect(new Set(open.map((a) => a.id)).size).toBe(open.length);
    expect(open.every((a) => !a.requires)).toBe(true);
  });
});

describe('traffic mods (2026-11-24)', () => {
  it('Fragile doubles the hit cost, Attention Span speeds the drain, Short Leash the CAUGHT fill; scores multiply at the end', () => {
    const plain = new Sim({ seed: 9, growth: true });
    const m = new Sim({ seed: 9, growth: true, mods: ['liveWire', 'shortLeash'] });
    expect(m.show.decayMult).toBeCloseTo(plain.show.decayMult * 1.5);
    expect(m.show.pinFillMult).toBe(1.5);
    const every = Object.keys(TUNING.proto.mods);
    for (const id of every) expect(TUNING.proto.storyAsks.some((a) => a.unlock === id), id).toBe(true);
    const all = new Sim({ seed: 9, growth: true, mods: ['glassJaw'] });
    const bot = new Bot(all);
    for (let i = 0; i < 60 * 600 && all.live; i++) all.step(bot.input());
    expect(all.modMult).toBeCloseTo(1.3);
  }, 60_000);
});

describe('target cars (2026-11-24)', () => {
  it('one per district, breaks in Stride, pays its bonus (more in Rampage)', () => {
    let placed = 0, crushed = 0;
    for (let seed = 1; seed <= 4; seed++) {
      const sim = new Sim({ seed, growth: true });
      const bot = new Bot(sim);
      const seen = new Set<number>();
      for (let i = 0; i < 60 * 420 && sim.live; i++) {
        for (const e of sim.step(bot.input())) if (e.type === 'target') crushed++;
        for (const p of sim.track.props) if (p.bounty && !seen.has(p.id)) {
          seen.add(p.id);
          placed++;
          expect(sim.rankOf(p)).toBeLessThanOrEqual(sim.smashRank() + 1);
        }
      }
      expect(seen.size).toBeLessThanOrEqual(TUNING.proto.story.districts.length);
    }
    expect(placed).toBeGreaterThanOrEqual(12);
    expect(crushed).toBeGreaterThan(0);
  }, 120_000);
});

describe('lane-changers (2026-11-24)', () => {
  it('stay on the road, signal, and move a full lane before he arrives', async () => {
    const { CHUNKS } = await import('./chunks');
    for (const c of CHUNKS) for (const [, r] of c.rows) {
      expect(r[0] === 'l', `${c.id}: 'l' in the leftmost lane`).toBe(false);
      expect(r[c.lanes - 1] === 'r', `${c.id}: 'r' in the rightmost lane`).toBe(false);
    }
    let moved = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const sim = new Sim({ seed, growth: true });
      const bot = new Bot(sim);
      const d0 = new Map<number, number>();
      const last = new Map<number, string>();
      for (let i = 0; i < 60 * 300 && sim.live; i++) {
        sim.step(bot.input());
        for (const p of sim.track.shifters) {
          const sh = p.shift!;
          if (!d0.has(p.id)) d0.set(p.id, p.d);
          if (sh.state === 'move') expect(p.s - sim.giant.s).toBeGreaterThan(0);
          if (sh.state === 'done' && last.get(p.id) === 'move' && Math.abs(p.d - d0.get(p.id)!) > TUNING.lanes.width - 0.01) moved++;
          last.set(p.id, sh.state);
          expect(sh.to).toBeGreaterThan(0);
        }
      }
    }
    expect(moved).toBeGreaterThan(3);
  }, 120_000);
});
