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
  const zones: { t: number; zone: string }[] = [];
  for (let i = 0; i < seconds * 60 && sim.live; i++) {
    for (const p of sim.track.props) kinds.set(p.id, p.kind);
    const braking = i % 900 > 700 && i % 900 < 760;
    // The newsroom is under test, not survival: the timed braking costs Rampage, and with no Rampage trickle
    // (2026-11-16) that would end most broadcasts early. Keep the audience in so every broadcast runs long.
    if (sim.show.ratings < 25) sim.show.ratings = 25;
    const events = sim.step({ ...bot.input(), brake: braking });
    for (const e of events) {
      log.add(e);
      news.observe(e, sim.time);
    }
    const g = sim.giant;
    const seg = sim.track.segmentAt(g.s);
    const ctx: NewsContext = { time: sim.time, tier: g.tier, lane: g.lane, lanes: sim.track.lanesAt(g.s), heading: sim.track.headingAt(g.s), s: g.s, ratingsTier: sim.show.tier, heat: sim.show.heat, zone: seg.zone, zoneName: seg.zoneName };
    zones.push({ t: sim.time, zone: seg.zone });
    tiers.push({ t: sim.time, tier: sim.show.tier });
    const h = news.update(ctx, (id) => kinds.get(id));
    if (h) out.push({ h, ctx });
  }
  return { out, log, tiers, zones };
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
        // Never lies: sources happened; counts are exact; places are true where it happened.
        if (!/Spotted/.test(h.text)) expect(h.sources.length).toBeGreaterThan(0);
        for (const e of h.sources) expect(log.has(e)).toBe(true);
        const n = h.text.match(/ (\d+) [A-Z][a-z]+s\b/);
        if (n && !/Lanes/.test(h.text)) expect(h.sources.length).toBe(Number(n[1]));
        // Places are facts about where it happened (the headline carries that moment's context).
        const at = h.at ?? ctx;
        const lane = h.place?.match(/^In Lane (\d)$/);
        if (lane) expect(at.lane + 1).toBe(Number(lane[1]));
        if (h.place === 'In The Fast Lane') expect(at.lane).toBe(0);
        if (h.place?.endsWith('bound')) expect(h.place).toBe(`${compass(at.heading)}bound`);
        if (h.place === 'On Highway' || h.place === 'On The Interstate') expect(at.zone ?? 'highway').toBe('highway');
        // BREAKING: a Ratings tier, the exit, the ending, or the new road after a fork (the station cut away).
        if (h.breaking) expect(['ratings', 'exitOpen', 'busted', 'signOff', 'zone', 'netSlip']).toContain(h.sources[0].type);
        if (h.breaking && h.sources[0].type === 'zone') expect(log.has(h.sources[0]) && [...log].some((e) => e.type === 'fork' && e.taken)).toBe(true);
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

  it('never puts him on a highway when he was somewhere else (place words follow the zone he was in)', () => {
    const road = /\b(interstate|highway|freeway|expressway)\b/i;
    let checked = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { out, zones } = run(seed, 150);
      for (const { h } of out) {
        // Zone names ("On Ninth Expressway") are facts about the zone itself; strip the place they came from.
        const text = h.place && /^(On|In) /.test(h.place) && !['On Highway', 'On The Interstate'].includes(h.place) ? h.text.replace(h.place, '') : h.text;
        if (!road.test(text) || h.kicker === 'BUSTED' || h.kicker === 'SIGN-OFF') continue;
        checked++;
        // The event is at most `staleAfter` old: he must have been on a highway then.
        const window = zones.filter((z) => z.t <= h.t && z.t >= h.t - TUNING.broadcast.staleAfter - 0.1);
        expect(window.some((z) => z.zone === 'highway'), `"${h.text}" at ${h.t.toFixed(1)}s, zones ${[...new Set(window.map((z) => z.zone))].join('/')}`).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
