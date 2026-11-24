// Story balance: the bot plays N full Story runs; finish rate, how runs end, and hits / dodges per district.
// Usage: npx tsx tools/story-balance.ts [N]  (default 50). Run before tuning difficulty; compare before/after.
import { TUNING, enableProto } from '../src/tuning';
import { Sim } from '../src/sim/sim';
import { Bot } from '../src/sim/bot';

enableProto();
const N = Number(process.argv[2] ?? 50);
const D = TUNING.proto.story.districts;
const per = D.map(() => ({ hits: 0, secs: 0, reached: 0 }));
const ends: Record<string, number> = {};
let cleared = 0;
const scores: number[] = [];
for (let seed = 1000; seed < 1000 + N; seed++) {
  const sim = new Sim({ seed, growth: true });
  const bot = new Bot(sim);
  const seen = new Set<number>();
  for (let i = 0; i < 60 * 600 && sim.live; i++) {
    const d = sim.track.segmentAt(sim.giant.s).district ?? 0;
    if (!seen.has(d)) { seen.add(d); per[d].reached++; }
    per[d].secs += 1 / 60;
    for (const e of sim.step(bot.input())) if (e.type === 'bounce') per[d].hits++;
  }
  const why = sim.show.state === 'cleared' ? 'signed off' : `${sim.show.state}${sim.show.pinCause ? ' (' + sim.show.pinCause + ')' : ''}`;
  ends[why] = (ends[why] ?? 0) + 1;
  if (sim.show.state === 'cleared') cleared++;
  scores.push(Math.round(sim.show.banked));
}
scores.sort((a, b) => a - b);
console.log(`Story x${N}: signed off ${((cleared / N) * 100).toFixed(0)}%  ends ${JSON.stringify(ends)}  score median ${scores[N >> 1]}`);
D.forEach((d, i) => console.log(`  ${String(i + 1)}. ${(d.name ?? d.zone).padEnd(26)} reached ${String(per[i].reached).padStart(3)}/${N}  hits/min ${(per[i].hits / Math.max(1e-9, per[i].secs / 60)).toFixed(2)}`));
