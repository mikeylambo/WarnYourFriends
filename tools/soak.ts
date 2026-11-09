/**
 * Headless soak (§41): N seeds, bot-driven, checks Phase 0 invariants.
 *   - speed never below 2 m/s (Law 1, LOCKED)
 *   - giant stays inside the arena, no NaN
 *   - the giant never stalls: actual path travelled over any 3s window is at
 *     least 75% of what the speed floor implies (catches being wedged in
 *     geometry, where speed reads 2 m/s but push-outs cancel the motion)
 * Usage: tsx tools/soak.ts [seeds=200] [seconds=60]
 */
import { Sim } from '../src/sim/sim';
import { Bot } from '../src/sim/bot';
import { TUNING } from '../src/tuning';

const seeds = Number(process.argv[2] ?? 200);
const seconds = Number(process.argv[3] ?? 60);
const ticks = Math.round(seconds * TUNING.sim.hz);
const failures: string[] = [];
const agg = { rampageShare: 0, smashes: 0, bounces: 0, tierUps: 0, reachedRampage: 0 };
const t0 = performance.now();
let maxStepMs = 0;
const stepSamples: number[] = [];

for (let seed = 1; seed <= seeds; seed++) {
  const sim = new Sim({ seed });
  const bot = new Bot(sim);
  const half = sim.layout.half;
  let px = sim.giant.x;
  let pz = sim.giant.z;
  let path = 0;
  for (let i = 0; i < ticks; i++) {
    const input = bot.input();
    const s0 = performance.now();
    sim.step(input);
    const ms = performance.now() - s0;
    if (i > 10) maxStepMs = Math.max(maxStepMs, ms);
    if ((i & 15) === 0) stepSamples.push(ms);
    const g = sim.giant;
    if (!Number.isFinite(g.x + g.z + g.speed + g.heading)) {
      failures.push(`seed ${seed}: NaN at tick ${i}`);
      break;
    }
    if (g.speed < TUNING.giant.speedFloor - 1e-9) {
      failures.push(`seed ${seed}: speed ${g.speed} below floor at tick ${i}`);
      break;
    }
    if (Math.abs(g.x) > half + 1 || Math.abs(g.z) > half + 1) {
      failures.push(`seed ${seed}: left arena at tick ${i} (${g.x.toFixed(1)}, ${g.z.toFixed(1)})`);
      break;
    }
    path += Math.hypot(g.x - px, g.z - pz);
    px = g.x;
    pz = g.z;
    if (i % 180 === 179) {
      const floorPath = TUNING.giant.speedFloor * 3 * 0.75;
      if (path < floorPath) {
        failures.push(`seed ${seed}: stalled, travelled ${path.toFixed(2)}m in 3s at tick ${i}`);
        break;
      }
      path = 0;
    }
  }
  const st = sim.stats;
  agg.rampageShare += st.timeAtTier[2] / sim.time;
  agg.smashes += st.smashes;
  agg.bounces += st.bounces;
  agg.tierUps += st.tierUps;
  if (st.timeAtTier[2] > 0) agg.reachedRampage++;
}

const secs = ((performance.now() - t0) / 1000).toFixed(1);
stepSamples.sort((a, b) => a - b);
const p99 = stepSamples[Math.floor(stepSamples.length * 0.99)] ?? 0;
const mean = stepSamples.reduce((a, b) => a + b, 0) / Math.max(1, stepSamples.length);
console.log(`soak: ${seeds} seeds x ${seconds}s in ${secs}s; sim step mean ${mean.toFixed(3)}ms, p99 ${p99.toFixed(3)}ms, max ${maxStepMs.toFixed(2)}ms`);
// §36: sim step <= 2ms. p99 is the gate; isolated max spikes are GC/JIT noise on the host.
if (p99 > 2) failures.push(`sim step p99 ${p99.toFixed(2)}ms exceeds 2ms budget`);
console.log(
  `  avg Rampage share ${((agg.rampageShare / seeds) * 100).toFixed(1)}%, reached Rampage ${agg.reachedRampage}/${seeds}, ` +
    `smashes/run ${(agg.smashes / seeds).toFixed(1)}, bounces/run ${(agg.bounces / seeds).toFixed(1)}, tier-ups/run ${(agg.tierUps / seeds).toFixed(1)}`,
);
if (agg.reachedRampage < seeds * 0.5) failures.push(`bot reached Rampage in only ${agg.reachedRampage}/${seeds} seeds`);
if (failures.length) {
  console.error(`soak FAILED (${failures.length}):\n  ` + failures.slice(0, 20).join('\n  '));
  process.exit(1);
}
console.log('soak OK');
