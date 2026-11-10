/**
 * Headless soak (§41), Phase 0b. N seeds, bot-driven, sim + gait + camera together.
 *
 * Sim invariants
 *   - speed never below 2 m/s (Law 1, LOCKED); no NaN; giant stays on the road
 *   - never stalls: path travelled over any 3s ≥ 75% of what the speed floor implies
 * Run cycle (v0.3)
 *   - cadence within 2.0–2.3 steps/s at every tier; foot slide < 5cm per plant
 * Camera (v0.3)
 *   - screen-up law (LOCKED): travel within ±35° of screen-up, every frame
 *   - no cut while a lane change is in progress; cuts ≥ 7s apart
 *   - giant never below 85% of the screen; ≥ 2s of road visible ahead
 *
 * Usage: tsx tools/soak.ts [seeds=200] [seconds=60]
 */
import { Sim } from '../src/sim/sim';
import { Bot } from '../src/sim/bot';
import { Gait } from '../src/anim/gait';
import { CameraRig, Director } from '../src/render/camera';
import { TUNING } from '../src/tuning';

const seeds = Number(process.argv[2] ?? 200);
const seconds = Number(process.argv[3] ?? 60);
const ticks = Math.round(seconds * TUNING.sim.hz);
const failures: string[] = [];
const fail = (m: string) => failures.length < 40 && failures.push(m);

const agg = { rampageShare: 0, reachedRampage: 0, smashes: 0, across: 0, bounces: 0, wallBumps: 0, laneChanges: 0, merges: 0 };
const cad = [
  { min: Infinity, max: 0, n: 0 },
  { min: Infinity, max: 0, n: 0 },
  { min: Infinity, max: 0, n: 0 },
];
const slide = [0, 0, 0];
const plants = [0, 0, 0];
let earlyLifts = 0;
const aheadBy: Record<string, number> = {};
const cam = { frames: 0, maxScreenUp: 0, maxGiantY: 0, minAhead: Infinity, aheadUnder2: 0, cuts: 0, cutsDuringLane: 0, minCutGap: Infinity, perAngle: {} as Record<string, number> };
const stepSamples: number[] = [];
let maxStepMs = 0;
const t0 = performance.now();

for (let seed = 1; seed <= seeds; seed++) {
  const sim = new Sim({ seed });
  const bot = new Bot(sim);
  const gait = new Gait();
  const rig = new CameraRig();
  rig.resize(1280, 720);
  const director = new Director(seed);
  const pos = { x: 0, z: 0 };
  const target = () => {
    const g = sim.giant;
    sim.track.posAt(g.s, g.d, pos);
    return { x: pos.x, z: pos.z, travel: sim.track.headingAt(g.s), speed: g.speed, tier: g.tier };
  };
  rig.snap(target());
  let path = 0;
  let lastFoot = -1;
  let lastCut = -Infinity;
  const dt = sim.dt;

  for (let i = 0; i < ticks; i++) {
    // Brake now and then so every tier is sampled.
    const braking = i % 720 > 560 && i % 720 < 650;
    const input = { ...bot.input(), brake: braking };
    const s0 = sim.giant.s;
    const d0 = sim.giant.d;
    const t1 = performance.now();
    const events = sim.step(input);
    const ms = performance.now() - t1;
    if (i > 10) maxStepMs = Math.max(maxStepMs, ms);
    if ((i & 15) === 0) stepSamples.push(ms);
    const g = sim.giant;

    if (!Number.isFinite(g.s + g.d + g.speed)) {
      fail(`seed ${seed}: NaN at tick ${i}`);
      break;
    }
    if (g.speed < TUNING.giant.speedFloor - 1e-9) fail(`seed ${seed}: speed ${g.speed} below floor at tick ${i}`);
    const w = sim.track.widthAt(g.s);
    if (g.d < TUNING.giant.radius - TUNING.lanes.wallBumpDepth - 0.01 || g.d > w - TUNING.giant.radius + TUNING.lanes.wallBumpDepth + 0.01) {
      fail(`seed ${seed}: off the road d=${g.d.toFixed(2)} width=${w.toFixed(2)} at tick ${i}`);
    }
    path += Math.hypot(g.s - s0, g.d - d0);
    if (i % 180 === 179) {
      if (path < TUNING.giant.speedFloor * 3 * 0.75) fail(`seed ${seed}: stalled, ${path.toFixed(2)}m in 3s at tick ${i}`);
      path = 0;
    }

    for (const e of events) {
      if (e.type === 'footfall') {
        if (lastFoot >= 0) {
          const c = 1 / (e.t - lastFoot);
          const k = cad[e.tier];
          k.min = Math.min(k.min, c);
          k.max = Math.max(k.max, c);
          k.n++;
        }
        lastFoot = e.t;
      }
    }

    // Gait at the sim rate (the unit test also covers 144 Hz interpolated).
    const tg = target();
    gait.update({ x: tg.x, z: tg.z, fx: Math.cos(tg.travel), fz: Math.sin(tg.travel), speed: g.speed, stepPos: g.stepPos, stepLen: g.stepLen, tier: g.tier, dt });

    // Camera + director.
    const cutTo = director.update(dt, sim.laneBusy);
    if (cutTo) {
      if (sim.laneBusy) cam.cutsDuringLane++;
      cam.cuts++;
      cam.minCutGap = Math.min(cam.minCutGap, sim.time - lastCut);
      lastCut = sim.time;
      rig.cut(cutTo.index, cutTo.side, tg);
    }
    rig.update(dt, tg);
    const info = rig.info;
    cam.frames++;
    cam.perAngle[info.angle] = (cam.perAngle[info.angle] ?? 0) + 1;
    cam.maxScreenUp = Math.max(cam.maxScreenUp, Math.abs(info.screenUpDeg));
    cam.maxGiantY = Math.max(cam.maxGiantY, info.giantScreenY);
    cam.minAhead = Math.min(cam.minAhead, info.aheadSeconds);
    if (info.aheadSeconds < TUNING.camera.minRoadAheadSeconds) {
      cam.aheadUnder2++;
      const key = `${info.angle}/${TUNING.tiers[g.tier].name}${sim.laneBusy ? '/lane' : ''}`;
      aheadBy[key] = Math.min(aheadBy[key] ?? Infinity, info.aheadSeconds);
    }
    if (Math.abs(info.screenUpDeg) > TUNING.camera.screenUpMaxDeg) fail(`seed ${seed}: screen-up law broken (${info.screenUpDeg.toFixed(1)}°, ${info.angle}) at tick ${i}`);
    if (info.giantScreenY > TUNING.camera.giantMaxScreenY + 0.005) fail(`seed ${seed}: giant at ${info.giantScreenY.toFixed(3)} of screen (${info.angle}) at tick ${i}`);
  }

  for (const r of gait.records) {
    slide[r.tier] = Math.max(slide[r.tier], r.slide);
    plants[r.tier]++;
    if (r.liftedEarly) earlyLifts++;
  }
  const st = sim.stats;
  agg.rampageShare += st.timeAtTier[2] / sim.time;
  if (st.timeAtTier[2] > 0) agg.reachedRampage++;
  agg.smashes += st.smashes;
  agg.across += st.smashesAcross;
  agg.bounces += st.bounces;
  agg.wallBumps += st.wallBumps;
  agg.laneChanges += st.laneChanges;
  agg.merges += sim.track.segments.filter((s) => s.kind === 'merge').length > 0 ? 1 : 0;
}

const secs = ((performance.now() - t0) / 1000).toFixed(1);
stepSamples.sort((a, b) => a - b);
const p99 = stepSamples[Math.floor(stepSamples.length * 0.99)] ?? 0;
const totalPlants = plants[0] + plants[1] + plants[2];
console.log(`soak: ${seeds} seeds x ${seconds}s in ${secs}s; sim step p99 ${p99.toFixed(3)}ms, max ${maxStepMs.toFixed(2)}ms`);
console.log(
  `  run: Rampage share ${((agg.rampageShare / seeds) * 100).toFixed(1)}%, reached Rampage ${agg.reachedRampage}/${seeds}; per run: ` +
    `${(agg.laneChanges / seeds).toFixed(1)} lane changes, ${(agg.smashes / seeds).toFixed(1)} smashes (${(agg.across / seeds).toFixed(1)} across), ` +
    `${(agg.bounces / seeds).toFixed(1)} bounces, ${(agg.wallBumps / seeds).toFixed(1)} wall bumps`,
);
console.log(`  cadence steps/s: ` + cad.map((c, i) => `${TUNING.tiers[i].name} ${c.min.toFixed(3)}–${c.max.toFixed(3)} (n=${c.n})`).join(', '));
console.log(`  foot slide max: ` + slide.map((s, i) => `${TUNING.tiers[i].name} ${(s * 100).toFixed(2)}cm (${plants[i]} plants)`).join(', ') + `; early lifts ${((earlyLifts / Math.max(1, totalPlants)) * 100).toFixed(1)}%`);
console.log(
  `  camera: ${cam.frames} frames; |screen-up| max ${cam.maxScreenUp.toFixed(2)}°; giant lowest ${cam.maxGiantY.toFixed(3)}; road ahead min ${cam.minAhead.toFixed(2)}s ` +
    `(${((cam.aheadUnder2 / cam.frames) * 100).toFixed(2)}% of frames under 2s); cuts ${cam.cuts}, during lane change ${cam.cutsDuringLane}, min gap ${cam.minCutGap.toFixed(2)}s; ` +
    Object.entries(cam.perAngle).map(([k, v]) => `${k} ${((v / cam.frames) * 100).toFixed(0)}%`).join(', '),
);

if (Object.keys(aheadBy).length) console.log('  road-ahead shortfalls (min s by angle/tier):', JSON.stringify(Object.fromEntries(Object.entries(aheadBy).map(([k, v]) => [k, +v.toFixed(2)]))));
for (let t = 0; t < 3; t++) {
  if (cad[t].n < 20) fail(`too few cadence samples at ${TUNING.tiers[t].name} (${cad[t].n})`);
  if (cad[t].min < TUNING.gait.cadenceMin - 1e-6 || cad[t].max > TUNING.gait.cadenceMax + 1e-6) fail(`cadence out of band at ${TUNING.tiers[t].name}: ${cad[t].min}–${cad[t].max}`);
  if (slide[t] >= TUNING.gait.maxFootSlide) fail(`foot slide ${slide[t]}m at ${TUNING.tiers[t].name}`);
}
if (cam.cutsDuringLane > 0) fail(`${cam.cutsDuringLane} camera cuts during a lane change`);
if (cam.minCutGap < TUNING.camera.cutMinInterval - 1e-6) fail(`cuts only ${cam.minCutGap.toFixed(2)}s apart`);
if (cam.cuts < seeds) fail(`too few cuts to test (${cam.cuts})`);
if (cam.aheadUnder2 > 0) fail(`road ahead under 2s in ${cam.aheadUnder2} frames (min ${cam.minAhead.toFixed(2)}s)`);
if (p99 > 2) fail(`sim step p99 ${p99.toFixed(2)}ms exceeds the 2ms budget`);
if (agg.reachedRampage < seeds * 0.5) fail(`bot reached Rampage in only ${agg.reachedRampage}/${seeds} seeds`);
if (agg.merges < seeds) fail(`a run had no merge`);

if (failures.length) {
  console.error(`soak FAILED (${failures.length}${failures.length >= 40 ? '+' : ''}):\n  ` + failures.slice(0, 25).join('\n  '));
  process.exit(1);
}
console.log('soak OK');
