// Chyron census: the bot plays N Story runs through the real Newsroom; every headline that airs, by kicker and line.
// Usage: npx tsx tools/chyron-census.ts [N]  (default 30). Run after any word-bank change: what airs, how often.
import { enableProto } from '../src/tuning';
import { Sim } from '../src/sim/sim';
import { Bot } from '../src/sim/bot';
import { Newsroom } from '../src/broadcast/headlines';
import type { PropKind } from '../src/sim/types';

enableProto();
const N = Number(process.argv[2] ?? 30);
const kickers: Record<string, number> = {};
const lines: Record<string, { n: number; ex: string }> = {};
let total = 0;
for (let seed = 2000; seed < 2000 + N; seed++) {
  const sim = new Sim({ seed, growth: true });
  const bot = new Bot(sim);
  const news = new Newsroom(seed, sim.show.heat);
  const kinds = new Map<number, PropKind>();
  for (let i = 0; i < 60 * 600 && (sim.live || i % 60 !== 0); i++) {
    for (const e of sim.step(bot.input())) {
      if (e.type === 'smash' || e.type === 'bounce' || e.type === 'policeSmash' || e.type === 'policeCrash') {
        const p = sim.track.props.find((q) => q.id === e.propId) ?? sim.pursuit.units.find((q) => q.id === e.propId);
        if (p) kinds.set(p.id, p.kind as PropKind);
      }
      news.observe(e, sim.time);
    }
    const g = sim.giant;
    const seg = sim.track.segmentAt(g.s);
    const h = news.update({ time: sim.time, tier: g.tier, lane: g.lane, lanes: sim.track.lanesAt(g.s), heading: sim.track.headingAt(g.s), s: g.s, ratingsTier: sim.show.tier, heat: sim.show.heat, zone: seg.zone, zoneName: seg.zoneName }, (id) => kinds.get(id));
    if (h) {
      total++;
      kickers[h.kicker] = (kickers[h.kicker] ?? 0) + 1;
      const key = `${h.sources[0]?.type ?? 'open'} · ${h.verb ?? '-'}`;
      (lines[key] ??= { n: 0, ex: h.text }).n++;
    }
    if (!sim.live) break;
  }
}
console.log(`Chyron x${N}: ${total} headlines`);
console.log('Red side:', JSON.stringify(kickers));
for (const [k, v] of Object.entries(lines).sort((a, b) => b[1].n - a[1].n)) console.log(`${String(v.n).padStart(5)}  ${k.padEnd(32)} ${v.ex}`);
