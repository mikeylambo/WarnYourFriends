// Prototype core loop balance (?proto=1): 40 bot runs of one segment. Usage: npx tsx tools/proto-balance.ts  (SEG=0..2, PROTO=0 for the current rules)
import { TUNING, enableProto } from '../src/tuning';
import { Sim } from '../src/sim/sim';
import { Bot } from '../src/sim/bot';
if (process.env.PROTO !== '0') enableProto();
const N = 40, seg = Number(process.env.SEG ?? 0);
const ends: Record<string, number> = {}; let ramps = 0, firstR: number[] = [], hits = 0, near = 0, smash = 0, time = 0;
for (let seed = 1; seed <= N; seed++) {
  const sim = new Sim({ seed, segment: seg, upgrades: [], growth: true });
  const bot = new Bot(sim); let fr = -1;
  for (let i = 0; i < 60 * 200 && sim.live; i++) {
    for (const e of sim.step(bot.input())) {
      if (e.type === 'rampageStart') { ramps++; if (fr < 0) fr = sim.time; }
      if (e.type === 'bounce') hits++;
      if (e.type === 'dodge') near++;
      if (e.type === 'smash') smash++;
    }
  }
  time += sim.time; if (fr >= 0) firstR.push(fr);
  const k = sim.show.state === 'cleared' ? 'signoff' : `${sim.show.reason}${sim.show.reason === 'pin' ? ':' + sim.show.pinCause : ''}`;
  ends[k] = (ends[k] ?? 0) + 1;
}
firstR.sort((a, b) => a - b);
console.log(`proto=${TUNING.proto.on} seg=${seg} ends ${JSON.stringify(ends)}`);
console.log(`rampages/min ${(ramps / (time / 60)).toFixed(2)}, first ${firstR.length}/${N} median ${firstR[firstR.length >> 1]?.toFixed(0)}s; hits/min ${(hits / (time / 60)).toFixed(1)}, dodges/min ${(near / (time / 60)).toFixed(1)}, smashes/min ${(smash / (time / 60)).toFixed(1)}`);
