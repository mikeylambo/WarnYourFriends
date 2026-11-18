import { enableProto } from '../src/tuning';
import { Sim } from '../src/sim/sim';
import { Bot } from '../src/sim/bot';
enableProto();
const out: number[] = []; const why: Record<string, number> = {};
for (let seed = 1; seed <= 30; seed++) {
  const sim = new Sim({ seed, growth: true, endless: true }); const bot = new Bot(sim);
  for (let i = 0; i < 60 * 900 && sim.live; i++) sim.step(bot.input());
  out.push(sim.time); why[sim.show.reason ?? 'alive'] = (why[sim.show.reason ?? 'alive'] ?? 0) + 1;
}
out.sort((a, b) => a - b);
console.log('endless survival s: median', out[15].toFixed(0), 'p10', out[3].toFixed(0), 'p90', out[27].toFixed(0), why);
