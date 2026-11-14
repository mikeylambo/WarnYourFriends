import { describe, expect, it } from 'vitest';
import { Sim } from '../sim/sim';
import { Bot } from '../sim/bot';
import type { PropKind, SimEvent } from '../sim/types';
import { TUNING, type UpgradeId } from '../tuning';
import { Newsroom, compass, type Headline, type NewsContext } from './headlines';

function run(seed: number, seconds: number, upgrades: UpgradeId[] = [], segment = 0) {
  const sim = new Sim({ seed, upgrades, segment });
  const bot = new Bot(sim);
  const news = new Newsroom(seed, sim.show.heat);
  const kinds = new Map<number, PropKind>();
  const log = new Set<SimEvent>();
  const out: { h: Headline; ctx: NewsContext }[] = [];
  const tiers: { t: number; tier: number }[] = [];
  for (let i = 0; i < seconds * 60 && sim.live; i++) {
    for (const p of sim.track.props) kinds.set(p.id, p.kind);
    const braking = i % 900 > 700 && i % 900 < 760;
    const events = sim.step({ ...bot.input(), brake: braking });
    for (const e of events) {
      log.add(e);
      news.observe(e, sim.time);
    }
    const g = sim.giant;
    const ctx: NewsContext = { time: sim.time, tier: g.tier, lane: g.lane, lanes: sim.track.lanesAt(g.s), heading: sim.track.headingAt(g.s), s: g.s, ratingsTier: sim.show.tier, heat: sim.show.heat };
    tiers.push({ t: sim.time, tier: sim.show.tier });
    const h = news.update(ctx, (id) => kinds.get(id));
    if (h) out.push({ h, ctx });
  }
  return { out, log, tiers };
}

describe('headlines (§21)', () => {
  it('compass: −Z is north, +X is east', () => {
    expect(compass(-Math.PI / 2)).toBe('North');
    expect(compass(0)).toBe('East');
    expect(compass(Math.PI / 2)).toBe('South');
    expect(compass(Math.PI)).toBe('West');
  });

  const ABIL: UpgradeId[] = ['leap', 'stare', 'hijack', 'pose'];
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    const ups: UpgradeId[] = seed > 8 ? [ABIL[seed - 9]] : [];
    it(`seed ${seed}${ups.length ? ` (${ups[0]}, segment 3)` : ''}: cadence, anti-repeat and the chyron never lies`, () => {
      const { out, log, tiers } = run(seed, 170, ups, ups.length ? 3 : 0);
      // Segment-3 broadcasts start at Heat 4 and this test brakes on a timer: they can end early.
      expect(out.length).toBeGreaterThan(ups.length ? 3 : 10);
      // The first regular headline is the sighting (a Ratings tier can break in before it).
      expect(out.find(({ h }) => !h.breaking)!.h.text).toMatch(/Spotted/);
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
        if (h.breaking) expect(['ratings', 'exitOpen', 'busted', 'signOff']).toContain(h.sources[0].type);
      });
      // §21: a Ratings tier rise breaks in on the same tick.
      let prev = 0;
      for (const x of tiers) {
        if (x.tier > prev) expect(out.some(({ h }) => h.breaking && Math.abs(h.t - x.t) < 1e-9 && h.sources[0].type === 'ratings')).toBe(true);
        prev = Math.max(prev, x.tier);
      }
      // Heat only makes news going up (a Pose spends it).
      for (const { h } of out) if (h.sources[0]?.type === 'heat') expect((h.sources[0] as Extract<SimEvent, { type: 'heat' }>).heat).toBeGreaterThan(0);
      if (ups.length && out.length > 10) expect(out.some(({ h }) => h.sources.some((e) => ['leapLand', 'stare', 'hijack', 'pose'].includes(e.type)))).toBe(true);
      // The broadcast ends with a sign-off or busted line, from the event that ended it.
      const final = out[out.length - 1].h;
      expect(["SIGN-OFF", "BUSTED"]).toContain(final.kicker);
      // "Giant At Large. Warn Your Friends." fires once, on the first Stride.
      expect(out.filter(({ h }) => h.text === 'Giant At Large. Warn Your Friends.').length).toBe(tiers.some((x) => x.tier >= 1) ? 1 : 0);
    });
  }
});
