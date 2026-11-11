import { describe, expect, it } from 'vitest';
import { Sim } from '../sim/sim';
import { Bot } from '../sim/bot';
import type { PropKind, SimEvent } from '../sim/types';
import { TUNING } from '../tuning';
import { Newsroom, compass, type Headline, type NewsContext } from './headlines';

function run(seed: number, seconds: number) {
  const sim = new Sim({ seed });
  const bot = new Bot(sim);
  const news = new Newsroom(seed);
  const kinds = new Map<number, PropKind>();
  const log = new Set<SimEvent>();
  const out: { h: Headline; ctx: NewsContext }[] = [];
  for (let i = 0; i < seconds * 60; i++) {
    for (const p of sim.track.props) kinds.set(p.id, p.kind);
    const braking = i % 900 > 700 && i % 900 < 760;
    const events = sim.step({ ...bot.input(), brake: braking });
    for (const e of events) {
      log.add(e);
      news.observe(e, sim.time);
    }
    const g = sim.giant;
    const ctx: NewsContext = { time: sim.time, tier: g.tier, lane: g.lane, lanes: sim.track.lanesAt(g.s), heading: sim.track.headingAt(g.s), s: g.s };
    const h = news.update(ctx, (id) => kinds.get(id));
    if (h) out.push({ h, ctx });
  }
  return { out, log };
}

describe('headlines (§21)', () => {
  it('compass: −Z is north, +X is east', () => {
    expect(compass(-Math.PI / 2)).toBe('North');
    expect(compass(0)).toBe('East');
    expect(compass(Math.PI / 2)).toBe('South');
    expect(compass(Math.PI)).toBe('West');
  });

  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`seed ${seed}: cadence, anti-repeat and the chyron never lies`, () => {
      const { out, log } = run(seed, 120);
      expect(out.length).toBeGreaterThan(10);
      expect(out[0].h.text).toMatch(/Spotted/);
      let last = -Infinity;
      out.forEach(({ h, ctx }, i) => {
        // Cadence: at most one every 4s, unless it's a BREAKING tier change.
        if (!h.breaking) expect(h.t - last).toBeGreaterThanOrEqual(TUNING.broadcast.headlineEvery - 1e-9);
        last = h.t;
        // Anti-repeat: no verb or place from the previous 5.
        const prev = out.slice(Math.max(0, i - TUNING.broadcast.antiRepeat), i).map((x) => x.h);
        if (h.verb) expect(prev.map((p) => p.verb)).not.toContain(h.verb);
        if (h.place) expect(prev.map((p) => p.place)).not.toContain(h.place);
        // Never lies: sources happened; counts are exact; places are true now.
        if (!/Spotted/.test(h.text)) expect(h.sources.length).toBeGreaterThan(0);
        for (const e of h.sources) expect(log.has(e)).toBe(true);
        const n = h.text.match(/ (\d+) [A-Z][a-z]+s\b/);
        if (n && !/Lanes/.test(h.text)) expect(h.sources.length).toBe(Number(n[1]));
        const lane = h.place?.match(/^In Lane (\d)$/);
        if (lane) expect(ctx.lane + 1).toBe(Number(lane[1]));
        if (h.place === 'In The Fast Lane') expect(ctx.lane).toBe(0);
        if (h.place?.endsWith('bound')) expect(h.place).toBe(`${compass(ctx.heading)}bound`);
        if (h.breaking) expect(h.sources[0].type).toBe('tierUp');
      });
      // Tier changes break in on the same tick.
      for (const e of log) {
        if (e.type !== 'tierUp') continue;
        expect(out.some(({ h }) => h.breaking && h.sources[0] === e)).toBe(true);
      }
      // "Giant At Large. Warn Your Friends." fires once, on the first Stride.
      expect(out.filter(({ h }) => h.text === 'Giant At Large. Warn Your Friends.').length).toBe(1);
    });
  }
});
