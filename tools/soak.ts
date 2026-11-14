/**
 * Headless soak (§41), Phase 0b. N seeds, bot-driven, sim + gait + camera together.
 *
 * Sim invariants
 *   - speed never below 2 m/s (Law 1, LOCKED); no NaN; giant stays on the road
 *   - never stalls: path travelled over any 3s ≥ 75% of what the speed floor implies
 * Run cycle (v0.3)
 *   - cadence within the gait band (TUNING.gait) at every tier; foot slide < 5cm per plant
 * Camera (v0.3)
 *   - screen-up law (LOCKED): travel within ±35° of screen-up, every frame
 *   - Phase 0c director: cut-aways only on Rampage / Heavy smash / merge, each
 *     backed by that event; ≥15s between cut-aways; never the same trigger twice
 *     in a row; home (Chase High) after 6–10s; no cut during a lane change;
 *     zero cuts with the setting off
 * Escort (Phase 0c)
 *   - cruisers join ≥40m back (LOCKED) and off camera; never closer than the gap floor
 *   - giant never below 85% of the screen; ≥ 2s of road visible ahead
 *
 * Usage: tsx tools/soak.ts [seeds=200] [seconds=60]
 */
import { Sim } from '../src/sim/sim';
import { Bot } from '../src/sim/bot';
import { Gait } from '../src/anim/gait';
import { CameraRig, Director, cutTriggerFor, type CutTrigger } from '../src/render/camera';
import * as THREE from 'three';
import { TUNING, type UpgradeId } from '../src/tuning';
import { ABILITIES } from '../src/sim/run';

const seeds = Number(process.argv[2] ?? 200);
// Phase 2: one full segment (150s + 15s grace, LOCKED) per seed.
const seconds = Number(process.argv[3] ?? 165);
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
const cuts = { away: 0, home: 0, byTrigger: { rampage: 0, heavy: 0, merge: 0 } as Record<CutTrigger, number>, minAwayGap: Infinity, minAwayHold: Infinity, maxAwayHold: 0, offCuts: 0, triggersSeen: 0 };
const esc = { joins: 0, minJoinBehind: Infinity, joinsOnCamera: 0, minGap: Infinity, ahead: 0 };
const ndc = new THREE.Vector3();
// A few seeds with cuts switched off: Chase High must hold the whole run.
const OFF_SEEDS = new Set([7, 77, 177]);
const swoop = { n: 0, frames: 0, maxLen: 0 };
const p3 = { segments: [0, 0, 0, 0, 0], uses: {} as Record<string, number>, duds: 0, leapLands: 0, leapSmash: 0, stareMoved: 0, hijackBails: 0, poseGain: 0, maxPose: 0, maxAir: 0 };
const p2 = { tellsOffscreen: 0, spawns: {} as Record<string, number>, tells: {} as Record<string, number>, minSpawnDist: Infinity, spawnOnCamera: 0, maxTells: 0, ramHits: 0, ramMisses: 0, spiked: 0, nearMiss: 0, lostTrack: 0, maxPin: 0, ends: {} as Record<string, number>, endTime: 0, peak: 0, banked: 0 };
const stepSamples: number[] = [];
let maxStepMs = 0;
const t0 = performance.now();

for (let seed = 1; seed <= seeds; seed++) {
  // Phase 3: every seed plays a segment of the run with an ability and a seeded set of passives.
  const passives: UpgradeId[] = (['ironShins', 'secondWind', 'showman', 'tailwind'] as UpgradeId[]).filter((_, k) => ((seed >> 2) >> k) & 1);
  const loadout: UpgradeId[] = seed % 9 === 0 ? passives : [ABILITIES[seed % 4], ...passives];
  const sim = new Sim({ seed, segment: seed % TUNING.run.segments, upgrades: loadout });
  p3.segments[seed % TUNING.run.segments]++;
  if (sim.show.heat !== Math.min(5, 1 + (seed % TUNING.run.segments))) fail(`seed ${seed}: segment ${seed % 5} started at Heat ${sim.show.heat}`);
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
  let lastAway = -Infinity;
  let swoopRun = 0;
  let lastAwayTrigger: CutTrigger | null = null;
  const lastSeen: Record<CutTrigger, number> = { rampage: -Infinity, heavy: -Infinity, merge: -Infinity };
  const cutsOff = OFF_SEEDS.has(seed);
  director.enabled = !cutsOff;
  const dt = sim.dt;

  const seenUnits = new Set<number>();
  let lastHeat = 1;
  for (let i = 0; i < ticks; i++) {
    if (!sim.live) break;
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
      const trig = cutTriggerFor(e);
      if (trig) {
        lastSeen[trig] = sim.time;
        cuts.triggersSeen++;
        director.trigger(trig);
      }
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
    const cutTo = director.update(dt, sim.laneBusy || sim.tellActive);
    if (cutTo && sim.tellActive) fail(`seed ${seed}: camera cut during a tell at t=${sim.time.toFixed(2)}`);
    if (cutTo) {
      if (sim.laneBusy) cam.cutsDuringLane++;
      if (cutsOff) cuts.offCuts++;
      cam.cuts++;
      cam.minCutGap = Math.min(cam.minCutGap, sim.time - lastCut);
      if (cutTo.reason === 'home') {
        cuts.home++;
        const held = sim.time - lastAway;
        cuts.minAwayHold = Math.min(cuts.minAwayHold, held);
        cuts.maxAwayHold = Math.max(cuts.maxAwayHold, held);
        if (cutTo.index !== TUNING.camera.homeAngle) fail(`seed ${seed}: 'home' cut went to angle ${cutTo.index}`);
      } else {
        cuts.away++;
        cuts.byTrigger[cutTo.reason]++;
        const age = sim.time - lastSeen[cutTo.reason];
        if (!(age <= TUNING.camera.triggerPending + dt * 1.5)) fail(`seed ${seed}: cut-away on '${cutTo.reason}' with no such event in the last ${TUNING.camera.triggerPending}s (age ${age.toFixed(2)}s) at t=${sim.time.toFixed(2)}`);
        if (cutTo.reason === lastAwayTrigger) fail(`seed ${seed}: two cut-aways in a row on '${cutTo.reason}'`);
        if (cutTo.index === TUNING.camera.homeAngle) fail(`seed ${seed}: cut-away to the home angle`);
        cuts.minAwayGap = Math.min(cuts.minAwayGap, sim.time - lastAway);
        lastAway = sim.time;
        lastAwayTrigger = cutTo.reason;
      }
      lastCut = sim.time;
      if (cutTo.reason === 'home' && rig.angle.swoopHome) {
        rig.swoopTo(cutTo.index, cutTo.side, tg);
        swoop.n++;
      } else rig.cut(cutTo.index, cutTo.side, tg);
    }
    rig.update(dt, tg);
    const info = rig.info;
    // A swoop out of Head-On suspends the camera rules; it must be short and land in the home shot.
    const inSwoop = info.transition;
    if (inSwoop) {
      swoopRun += dt;
      swoop.frames++;
      swoop.maxLen = Math.max(swoop.maxLen, swoopRun);
      if (swoopRun > TUNING.camera.swoop.time + dt * 1.5) fail(`seed ${seed}: swoop running ${swoopRun.toFixed(2)}s`);
    } else swoopRun = 0;
    if (!inSwoop) {
    cam.frames++;
    cam.perAngle[info.angle] = (cam.perAngle[info.angle] ?? 0) + 1;
    cam.maxScreenUp = Math.max(cam.maxScreenUp, Math.abs(info.screenUpDeg));
    cam.maxGiantY = Math.max(cam.maxGiantY, info.giantScreenY);
    cam.minAhead = Math.min(cam.minAhead, info.aheadSeconds);
    if (info.aheadSeconds < TUNING.camera.minRoadAheadSeconds) {
      cam.aheadUnder2++;
      const key = `${info.angle}/${TUNING.tiers[g.tier].name}${sim.laneBusy ? '/lane' : ''}${g.ride > 0 ? '/ride' : ''}${g.air > 0 ? '/air' : ''}${g.pose > 0 ? '/pose' : ''}${g.abilityCd > 0 ? '/cd:' + sim.ability : ''}`;
      aheadBy[key] = Math.min(aheadBy[key] ?? Infinity, info.aheadSeconds);
    }
    }
    // Escort: joined ≥40m back and off camera; never closer than the gap floor.
    for (const e of events) {
      if (e.type !== 'escortJoin') continue;
      const c = sim.escort.cruisers[e.id];
      esc.joins++;
      esc.minJoinBehind = Math.min(esc.minJoinBehind, e.behind);
      if (e.behind < 40) fail(`seed ${seed}: cruiser joined ${e.behind.toFixed(1)}m back (LOCKED ≥40m)`);
      sim.track.posAt(c.s, c.d, pos);
      // Any part of a car-sized box (±3m, 0–2m up) in the frame counts as on camera.
      let seen = false;
      for (const [ox, oy, oz] of [[0, 0, 0], [3, 0, 3], [-3, 0, -3], [3, 2, -3], [-3, 2, 3]]) {
        ndc.set(pos.x + ox, oy, pos.z + oz).project(rig.camera);
        if (ndc.z > -1 && ndc.z < 1 && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1) seen = true;
      }
      if (seen) {
        esc.joinsOnCamera++;
        fail(`seed ${seed}: cruiser ${e.id} joined on camera (${info.angle})`);
      }
    }
    for (const c of sim.escort.cruisers) {
      if (!c.active) continue;
      const gap = g.s - c.s;
      esc.minGap = Math.min(esc.minGap, gap);
      if (gap < TUNING.escort.minGap - 1e-6) {
        esc.ahead++;
        fail(`seed ${seed}: cruiser ${c.id} within ${gap.toFixed(2)}m at tick ${i}`);
      }
    }
    // Phase 2: pursuers spawn ≥40m away (LOCKED) and off camera; one tell at a time; meters in range.
    for (const u of sim.pursuit.units) {
      if (seenUnits.has(u.id)) continue;
      seenUnits.add(u.id);
      p2.spawns[u.unit] = (p2.spawns[u.unit] ?? 0) + 1;
      const dist = Math.abs(u.s - g.s);
      p2.minSpawnDist = Math.min(p2.minSpawnDist, dist);
      if (dist < 40) fail(`seed ${seed}: ${u.unit} spawned ${dist.toFixed(1)}m away (LOCKED ≥40m)`);
      sim.track.posAt(u.s, u.d, pos);
      for (const [ox, oy, oz] of [[0, 0, 0], [3, 0, 3], [-3, 0, -3], [3, 2, -3], [-3, 2, 3]]) {
        ndc.set(pos.x + ox, oy, pos.z + oz).project(rig.camera);
        if (ndc.z > -1 && ndc.z < 1 && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1) {
          p2.spawnOnCamera++;
          fail(`seed ${seed}: ${u.unit} spawned on camera (${info.angle}) at t=${sim.time.toFixed(1)}`);
          break;
        }
      }
    }
    const tells = new Set<number>();
    for (const u of sim.pursuit.units) {
      if (!u.alive) continue;
      const sliding = u.unit === 'roadblock' && u.phase === 'act' && u.phaseT < TUNING.pursuit.roadblock.tell;
      if (u.phase === 'tell' || sliding) tells.add(u.group >= 0 ? -1 - u.group : u.id);
    }
    p2.maxTells = Math.max(p2.maxTells, tells.size);
    if (tells.size > 1) fail(`seed ${seed}: ${tells.size} tells at once at t=${sim.time.toFixed(2)}`);
    for (const e of events) {
      if (e.type === 'ability') {
        if (e.ok) p3.uses[e.id] = (p3.uses[e.id] ?? 0) + 1;
        else p3.duds++;
      }
      if (e.type === 'leapLand') {
        p3.leapLands++;
        p3.leapSmash += e.smashed;
      }
      if (e.type === 'stare') p3.stareMoved += e.moved.length;
      if (e.type === 'hijackBail') p3.hijackBails++;
      if (e.type === 'pose') p3.poseGain += e.gain;
      if (e.type === 'tell') {
        p2.tells[e.kind] = (p2.tells[e.kind] ?? 0) + 1;
        // A tell nobody can see isn't a tell: it must start inside the frame.
        const u = sim.pursuit.units.find((x) => x.id === e.id);
        if (u && !inSwoop) {
          sim.track.posAt(u.s, sim.track.laneCenter(e.lane), pos);
          ndc.set(pos.x, 0.5, pos.z).project(rig.camera);
          const seen = ndc.z > -1 && ndc.z < 1 && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1;
          if (!seen) {
            p2.tellsOffscreen++;
            fail(`seed ${seed}: ${e.kind} tell started off screen (${info.angle}, ${(u.s - g.s).toFixed(0)}m ahead)`);
          }
        }
      }
      if (e.type === 'ram') p2[e.hit ? 'ramHits' : 'ramMisses']++;
      if (e.type === 'spiked') p2.spiked++;
      if (e.type === 'nearMiss') p2.nearMiss++;
      if (e.type === 'lostTrack') p2.lostTrack++;
      if (e.type === 'tell' && e.kind === 'roadblock') {
        const L = sim.track.lanesAt(sim.pursuit.units.find((u) => u.id === e.id)!.s);
        const cars = sim.pursuit.units.filter((u) => u.alive && u.unit === 'roadblock' && u.group === sim.pursuit.units.find((x) => x.id === e.id)!.group).length;
        if (cars > L - 1) fail(`seed ${seed}: roadblock with no gap (${cars} cars, ${L} lanes)`);
      }
    }
    const sh = sim.show;
    if (sh.ratings < 0 || sh.ratings > 100 || sh.pin < 0 || sh.pin > 100 || !Number.isFinite(sh.banked)) fail(`seed ${seed}: meter out of range (ratings ${sh.ratings}, pin ${sh.pin})`);
    // Heat never falls within a segment (§12), except when Pose for the Camera spends it (§17).
    if (sh.heat < lastHeat && !events.some((e) => e.type === 'pose')) fail(`seed ${seed}: Heat fell ${lastHeat} → ${sh.heat}`);
    lastHeat = sh.heat;
    p2.maxPin = Math.max(p2.maxPin, sh.pin);
    // Phase 3: the pose is a deliberate stop of at most 1s (§2) and never below the LOCKED floor.
    p3.maxPose = Math.max(p3.maxPose, g.pose);
    p3.maxAir = Math.max(p3.maxAir, g.air);
    if (g.pose > 1) fail(`seed ${seed}: pose held ${g.pose.toFixed(2)}s`);
    if (!inSwoop && Math.abs(info.screenUpDeg) > TUNING.camera.screenUpMaxDeg) fail(`seed ${seed}: screen-up law broken (${info.screenUpDeg.toFixed(1)}°, ${info.angle}) at tick ${i}`);
    if (!inSwoop && info.giantScreenY > TUNING.camera.giantMaxScreenY + 0.005) fail(`seed ${seed}: giant at ${info.giantScreenY.toFixed(3)} of screen (${info.angle}) at tick ${i}`);
  }

  // LOCKED segment shape: every segment ends by 150s + 15s grace.
  if (sim.live) fail(`seed ${seed}: segment still live at ${sim.time.toFixed(1)}s`);
  const endKey = sim.show.state + (sim.show.reason ? `:${sim.show.reason}` : '');
  p2.ends[endKey] = (p2.ends[endKey] ?? 0) + 1;
  p2.endTime = Math.max(p2.endTime, sim.time);
  p2.peak += sim.show.peak;
  p2.banked += sim.show.banked;
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

console.log(
  `  cuts (Phase 0c): ${cuts.away} cut-aways (rampage ${cuts.byTrigger.rampage}, heavy ${cuts.byTrigger.heavy}, merge ${cuts.byTrigger.merge}) from ${cuts.triggersSeen} trigger events; ` +
    `${cuts.home} returns home; min gap between cut-aways ${cuts.minAwayGap.toFixed(2)}s; away held ${cuts.minAwayHold.toFixed(2)}–${cuts.maxAwayHold.toFixed(2)}s; ` +
    `cuts with the setting off ${cuts.offCuts} (${OFF_SEEDS.size} seeds)`,
);
console.log(`  swoops home: ${swoop.n}, longest ${swoop.maxLen.toFixed(2)}s (limit ${TUNING.camera.swoop.time}s), ${((swoop.frames / (cam.frames + swoop.frames)) * 100).toFixed(2)}% of frames`);
console.log(
  `  segment (Phase 2): ends ${JSON.stringify(p2.ends)}, latest end ${p2.endTime.toFixed(1)}s; peak Ratings avg ${(p2.peak / seeds).toFixed(1)}, banked avg ${(p2.banked / seeds).toFixed(0)}; ` +
    `spawns ${JSON.stringify(p2.spawns)}, nearest spawn ${p2.minSpawnDist.toFixed(1)}m, on camera ${p2.spawnOnCamera}; tells ${JSON.stringify(p2.tells)}, max at once ${p2.maxTells}, off screen ${p2.tellsOffscreen}; ` +
    `rams hit ${p2.ramHits} / missed ${p2.ramMisses}; spiked ${p2.spiked}; near-misses ${p2.nearMiss}; lost track ${p2.lostTrack}; max Pin ${p2.maxPin.toFixed(0)}`,
);
console.log(`  run (Phase 3): segments ${p3.segments.join('/')}; ability uses ${JSON.stringify(p3.uses)}, no-target presses ${p3.duds}; leap landings ${p3.leapLands} (smashed ${p3.leapSmash}); stare pulled over ${p3.stareMoved}; hijack bails ${p3.hijackBails}; pose Ratings +${p3.poseGain.toFixed(0)}`);
console.log(`  escort: ${esc.joins} joins, nearest join ${esc.minJoinBehind.toFixed(1)}m back, ${esc.joinsOnCamera} on camera; closest gap ever ${esc.minGap.toFixed(2)}m (floor ${TUNING.escort.minGap}m)`);
if (Object.keys(aheadBy).length) console.log('  road-ahead shortfalls (min s by angle/tier):', JSON.stringify(Object.fromEntries(Object.entries(aheadBy).map(([k, v]) => [k, +v.toFixed(2)]))));
for (let t = 0; t < 3; t++) {
  if (cad[t].n < 20) fail(`too few cadence samples at ${TUNING.tiers[t].name} (${cad[t].n})`);
  if (cad[t].min < TUNING.gait.cadenceMin - 1e-6 || cad[t].max > TUNING.gait.cadenceMax + 1e-6) fail(`cadence out of band at ${TUNING.tiers[t].name}: ${cad[t].min}–${cad[t].max}`);
  if (slide[t] >= TUNING.gait.maxFootSlide) fail(`foot slide ${slide[t]}m at ${TUNING.tiers[t].name}`);
}
if (cam.cutsDuringLane > 0) fail(`${cam.cutsDuringLane} camera cuts during a lane change`);
if (cuts.minAwayGap < TUNING.camera.cutMinInterval - 1e-6) fail(`cut-aways only ${cuts.minAwayGap.toFixed(2)}s apart`);
if (cuts.away < seeds) fail(`too few cut-aways to test (${cuts.away})`);
for (const k of ['rampage', 'heavy', 'merge'] as CutTrigger[]) if (cuts.byTrigger[k] === 0) fail(`no cut-away on '${k}' in ${seeds} seeds`);
if (cuts.minAwayHold < TUNING.camera.awayHold[0] - 1e-6) fail(`returned home after only ${cuts.minAwayHold.toFixed(2)}s`);
if (cuts.maxAwayHold > TUNING.camera.awayHold[1] + 2) fail(`stayed away ${cuts.maxAwayHold.toFixed(2)}s`);
if (swoop.n < seeds / 4) fail(`too few swoops to test (${swoop.n})`);
for (const k of ['cruiser', 'spike', 'rolling', 'roadblock']) if (!p2.tells[k]) fail(`no ${k} tell in ${seeds} seeds`);
for (const k of ABILITIES) if (!p3.uses[k]) fail(`ability ${k} never used in ${seeds} seeds`);
if (cuts.offCuts > 0) fail(`${cuts.offCuts} cuts with Camera cuts: Off`);
if (esc.joins < seeds) fail(`too few escort joins (${esc.joins})`);
if (cam.aheadUnder2 > 0) fail(`road ahead under 2s in ${cam.aheadUnder2} frames (min ${cam.minAhead.toFixed(2)}s)`);
if (p99 > 2) fail(`sim step p99 ${p99.toFixed(2)}ms exceeds the 2ms budget`);
if (agg.reachedRampage < seeds * 0.5) fail(`bot reached Rampage in only ${agg.reachedRampage}/${seeds} seeds`);
if (agg.merges < seeds) fail(`a run had no merge`);

if (failures.length) {
  console.error(`soak FAILED (${failures.length}${failures.length >= 40 ? '+' : ''}):\n  ` + failures.slice(0, 25).join('\n  '));
  process.exit(1);
}
console.log('soak OK');
