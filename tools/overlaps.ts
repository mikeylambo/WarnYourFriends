// Vehicle overlap census: every step of N Story runs (bot), every pair of vehicles whose footprints overlap
// (moving traffic, parked cars, police units, the escort). Prints the worst pairs by kind so fixes can target them.
// Usage: npx tsx tools/overlaps.ts [N]   (default 20)
import { TUNING, enableProto } from '../src/tuning';
import { Sim } from '../src/sim/sim';
import { Bot } from '../src/sim/bot';

enableProto();
const N = Number(process.argv[2] ?? 20);
const VEH = new Set(['car', 'van', 'newsvan', 'foodtruck', 'compact', 'cruiser', 'suv', 'truck', 'bus', 'armored', 'carrier']);
type Box = { tag: string; s: number; d: number; hl: number; hw: number; moving: boolean };
const pairs = new Map<string, number>();
let frames = 0, bad = 0;
for (let seed = 3000; seed < 3000 + N; seed++) {
  const sim = new Sim({ seed, growth: true });
  const bot = new Bot(sim);
  for (let i = 0; i < 60 * 420 && sim.live; i++) {
    sim.step(bot.input());
    if (i % 6) continue;
    frames++;
    const g = sim.giant;
    const boxes: Box[] = [];
    for (const p of sim.track.propsBetween(g.s - 40, g.s + 120)) if (p.alive && VEH.has(p.kind)) boxes.push({ tag: (p.mover ? (p.oncoming ? 'oncoming ' : 'mover ') : 'parked ') + p.kind, s: p.s, d: p.d, hl: p.hl, hw: p.hw, moving: !!p.mover?.active });
    for (const u of sim.pursuit.units) if (u.alive && u.unit !== 'chopper' && u.unit !== 'spike' && Math.abs(u.s - g.s) < 120) boxes.push({ tag: 'police ' + u.unit, s: u.s, d: u.d, hl: u.hl, hw: u.hw, moving: true });
    for (const c of sim.escort.cruisers) if (c.active) boxes.push({ tag: 'escort', s: c.s, d: c.d, hl: TUNING.escort.hl, hw: TUNING.escort.hw, moving: true });
    let any = false;
    for (let a = 0; a < boxes.length; a++)
      for (let b = a + 1; b < boxes.length; b++) {
        const A = boxes[a], B = boxes[b];
        if (!A.moving && !B.moving) continue;
        if (Math.abs(A.s - B.s) < (A.hl + B.hl) * 0.85 && Math.abs(A.d - B.d) < (A.hw + B.hw) * 0.85) {
          const k = [A.tag, B.tag].sort().join(' × ');
          pairs.set(k, (pairs.get(k) ?? 0) + 1);
          any = true;
        }
      }
    if (any) bad++;
  }
}
console.log(`overlap in ${bad} of ${frames} sampled frames (${((bad / frames) * 100).toFixed(2)}%)`);
for (const [k, v] of [...pairs].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${String(v).padStart(5)}  ${k}`);
