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
const p3 = { segments: [0, 0, 0, 0, 0], uses: {} as Record<string, number>, duds: 0, leapLands: 0, leapSmash: 0, stareMoved: 0, breakawayLands: 0, shaken: 0, primeTimes: 0, skins: 0, maxAir: 0 };
const p2 = { tellsOffscreen: 0, spawns: {} as Record<string, number>, tells: {} as Record<string, number>, minSpawnDist: Infinity, spawnOnCamera: 0, maxTells: 0, ramHits: 0, ramMisses: 0, spotlights: 0, choppersShaken: 0, policeCrash: 0, crashOffAir: 0, policeSmash: 0, crashOffscreen: 0, spiked: 0, nearMiss: 0, dodges: 0, lostTrack: 0, maxPin: 0, ends: {} as Record<string, number>, endTime: 0, peak: 0, banked: 0 };
/** The producer's asks: offered and finished, per ask. */
const asksAgg: Record<string, { offered: number; done: number }> = {};
/** Forks: opened, taken, stayed. */
const forks = { opened: 0, taken: 0, stayed: 0 };
const landmarks: Record<string, number> = {};
// Police Net, Rolling Blockade, Car Carrier (2026-11-16).
const nets = { spawned: 0, tells: 0, escaped: 0, slipped: 0, busted: 0, maxPerSegment: 0 };
const carriers = { spawned: 0, drops: 0, minLead: Infinity, bad: 0, smashed: 0 };
let landmarkSmashes = 0;
const stepSamples: number[] = [];
let maxStepMs = 0;
const t0 = performance.now();

for (let seed = 1; seed <= seeds; seed++) {
  // Phase 3: every seed plays a segment of the run with an ability and a seeded set of passives.
  const passives: UpgradeId[] = (['thickSkin', 'secondWind', 'crowdPleaser', 'slipstream'] as UpgradeId[]).filter((_, k) => ((seed >> 2) >> k) & 1);
  const loadout: UpgradeId[] = seed % 9 === 0 ? passives : [ABILITIES[seed % 4], ...passives];
  // Giant size: two in three seeds play with growth (the default), the rest at the fixed size.
  const growth = seed % 3 !== 0;
  // Ability levels cycle I–III across seeds.
  const sim = new Sim({ seed, segment: seed % TUNING.run.segments, upgrades: loadout, levels: { [ABILITIES[seed % 4]]: 1 + ((seed >> 4) % 3) }, growth });
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
  // Every broadcast opens on the opening angle (High Head-On), held like a cut-away, then swoops home.
  const opening = director.open();
  if (opening !== null) rig.cut(opening, director.side, target());
  /** The opening hero shot is a cinematic like the swoop: bounded, and exempt from the framing rules. */
  let inOpening = opening !== null;

  const seenUnits = new Set<number>();
  let segNets = 0;
  let lastForkAt = -Infinity;
  let lastHeat = 1;
  for (let i = 0; i < ticks; i++) {
    if (!sim.live) break;
    // Brake now and then so every tier is sampled.
    const braking = i % 720 > 560 && i % 720 < 650;
    // Invariants, not survival (that's tools/balance.ts): the timed braking costs Rampage, and with no Rampage
    // trickle (2026-11-16) the audience would end most segments before the late-segment systems (the Net) play out.
    if (sim.show.ratings < 20) sim.show.ratings = 20;
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
    // Nothing gets him through a bulldozer except a Leap (Mike's report: "running through bulldozers").
    if (g.air <= 0) for (const p of sim.track.propsBetween(g.s - 3, g.s + 3)) {
      if (p.cls === 'immovable' && p.alive && Math.abs(g.s - p.s) < p.hl * 0.6 && Math.abs(g.d - p.d) < p.hw * 0.6) fail(`seed ${seed}: inside a bulldozer at t=${sim.time.toFixed(2)}`);
    }
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
      // A fork taken: the broadcast cuts away while the road ahead is rebuilt (a jump, not a slide).
      if (e.type === 'fork' && e.taken) {
        forks.taken++;
        lastForkAt = sim.time;
        gait.reset();
        rig.cut(director.current, director.side, target());
      } else if (e.type === 'fork') forks.stayed++;
      if (e.type === 'forkOpen') forks.opened++;
      if (e.type === 'landmark') landmarks[e.kind] = (landmarks[e.kind] ?? 0) + 1;
      if (e.type === 'unitSpawn' && e.kind === 'net') { nets.spawned++; segNets++; nets.maxPerSegment = Math.max(nets.maxPerSegment, segNets); }
      if (e.type === 'tell' && e.kind === 'net') nets.tells++;
      if (e.type === 'netEscape') nets.escaped++;
      if (e.type === 'netSlip') nets.slipped++;
      if (e.type === 'busted' && e.reason === 'pin') nets.busted++;
      if (e.type === 'unitSpawn' && e.kind === 'carrier') carriers.spawned++;
      if (e.type === 'carrierDrop') {
        carriers.drops++;
        const lead = (e.s - g.s) / Math.max(g.speed, 0.1);
        carriers.minLead = Math.min(carriers.minLead, lead);
        // Never a drop he couldn't see coming, never one that closes every lane there.
        if (lead < TUNING.pursuit.carrier.dropLead - 0.05) { carriers.bad++; fail(`seed ${seed}: carrier drop ${lead.toFixed(2)}s ahead`); }
        const W = TUNING.lanes.width;
        const blocked = new Set(sim.track.propsBetween(e.s - 5, e.s + 5).map((p) => Math.floor(p.d / W)));
        if (blocked.size >= sim.track.lanesAt(e.s)) { carriers.bad++; fail(`seed ${seed}: carrier drop closed every lane at t=${sim.time.toFixed(1)}`); }
      }
      if (e.type === 'smash' && sim.pursuit.units.find((u) => u.id === e.propId)?.unit === 'carrier') carriers.smashed++;
      if (e.type === 'smash' && sim.track.segmentAt(sim.giant.s).landmark) landmarkSmashes++;
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
      if (cutTo.reason === 'home' && inOpening) {
        // The opening's swing home: held exactly openingHold (plus a lane change at most), not a cut-away's 6–10s.
        inOpening = false;
        if (sim.time > TUNING.camera.openingHold + TUNING.camera.triggerPending + 0.05) fail(`seed ${seed}: opening held ${sim.time.toFixed(2)}s`);
      } else if (cutTo.reason === 'home') {
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
    rig.giantScale = growth ? TUNING.growth.scale[sim.giant.tier] : 1;
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
    if (!inSwoop && !inOpening) {
    cam.frames++;
    cam.perAngle[info.angle] = (cam.perAngle[info.angle] ?? 0) + 1;
    cam.maxScreenUp = Math.max(cam.maxScreenUp, Math.abs(info.screenUpDeg));
    cam.maxGiantY = Math.max(cam.maxGiantY, info.giantScreenY);
    cam.minAhead = Math.min(cam.minAhead, info.aheadSeconds);
    // Airborne (a Leap or a Breakaway dive) he can't be hit, so the reaction-time rule waits for the landing.
    if (info.aheadSeconds < TUNING.camera.minRoadAheadSeconds && g.air <= 0) {
      cam.aheadUnder2++;
      const key = `${info.angle}/${TUNING.tiers[g.tier].name}${sim.laneBusy ? '/lane' : ''}${g.air > 0 ? '/' + g.airKind : ''}${g.prime > 0 ? '/prime' : ''}${g.abilityCd > 0 ? '/cd:' + sim.ability : ''}`;
      aheadBy[key] = Math.min(aheadBy[key] ?? Infinity, info.aheadSeconds);
      if (process.env.SOAK_VERBOSE) console.log(`  ahead ${info.aheadSeconds.toFixed(2)}s seed ${seed} t=${sim.time.toFixed(2)} since fork ${(sim.time - lastForkAt).toFixed(2)}s zone ${sim.track.segmentAt(g.s).zone}`);
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
      // Caught: while he crawls the lead cruiser runs him down to `caught.escortGap` (then drops back to the trail).
      if (gap < TUNING.pursuit.caught.escortGap - 0.05) {
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
      if (e.type === 'breakawayLand') {
        p3.breakawayLands++;
        p3.shaken += e.shaken;
      }
      if (e.type === 'primeTime' && e.on) p3.primeTimes++;
      if (e.type === 'thickSkin') p3.skins++;
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
      if (e.type === 'spotlight') p2.spotlights++;
      if (e.type === 'lostTrack' && e.kind === 'chopper') p2.choppersShaken++;
      if (e.type === 'policeSmash') p2.policeSmash++;
      if (e.type === 'policeCrash' && !e.onAir) p2.crashOffAir++;
      if (e.type === 'policeCrash' && e.onAir) {
        p2.policeCrash++;
        // Every destruction is readable from the chopper (§1): a police crash happens in frame.
        if (e.onAir && e.s < g.s - TUNING.pursuit.crash.visibleBehind - 0.5) fail(`seed ${seed}: police crash ${(g.s - e.s).toFixed(1)}m behind the giant`);
        sim.track.posAt(e.s, e.d, pos);
        ndc.set(pos.x, 0.5, pos.z).project(rig.camera);
        if (!(ndc.z > -1 && ndc.z < 1 && Math.abs(ndc.x) <= 1.05 && Math.abs(ndc.y) <= 1.05)) {
          p2.crashOffscreen++;
          if (process.env.SOAK_VERBOSE) console.log(`  crash off frame: seed ${seed} ${info.angle} behind ${(g.s - e.s).toFixed(1)}m ndc ${ndc.x.toFixed(2)},${ndc.y.toFixed(2)}`);
        }
      }
      if (e.type === 'spiked') p2.spiked++;
      if (e.type === 'nearMiss') p2.nearMiss++;
      if (e.type === 'dodge') p2.dodges++;
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
    if (sh.heat < lastHeat) fail(`seed ${seed}: Heat fell ${lastHeat} → ${sh.heat}`);
    lastHeat = sh.heat;
    p2.maxPin = Math.max(p2.maxPin, sh.pin);
    p3.maxAir = Math.max(p3.maxAir, g.air);
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
  // Merges he ran through (the track drops segments behind him, so count the events, not what's left in memory).
  const hadMerge = sim.stats.merges > 0;
  agg.merges += hadMerge ? 1 : 0;
  if (!hadMerge && process.env.SOAK_VERBOSE) console.log(`  no merge: seed ${seed}, ended ${sim.time.toFixed(1)}s ${sim.show.state}:${sim.show.reason}, s=${sim.giant.s.toFixed(0)}`);
  for (const x of sim.asks.list) {
    asksAgg[x.id] ??= { offered: 0, done: 0 };
    asksAgg[x.id].offered++;
    if (x.done) asksAgg[x.id].done++;
  }
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
    `rams hit ${p2.ramHits} / missed ${p2.ramMisses}; spotlight locks ${p2.spotlights}, choppers shaken ${p2.choppersShaken}; police crashes ${p2.policeCrash} on air (${p2.crashOffscreen} outside the frame) + ${p2.crashOffAir} behind the frame, ploughed through ${p2.policeSmash}; spiked ${p2.spiked}; near-misses ${p2.nearMiss}; traffic dodges ${p2.dodges}; lost track ${p2.lostTrack}; max Pin ${p2.maxPin.toFixed(0)}`,
);
console.log(`  run (Phase 3): segments ${p3.segments.join('/')}; ability uses ${JSON.stringify(p3.uses)}, no-target presses ${p3.duds}; leap landings ${p3.leapLands} (smashed ${p3.leapSmash}); stare pulled over ${p3.stareMoved}; breakaway landings ${p3.breakawayLands} (police shaken ${p3.shaken}); prime times ${p3.primeTimes}; thick skin saves ${p3.skins}`);
console.log(`  forks: opened ${forks.opened}, taken ${forks.taken}, stayed ${forks.stayed}`);
console.log(`  police net: ${nets.spawned} spawned, ${nets.tells} closed in, ${nets.escaped} escaped, ${nets.slipped} slipped (1st catch), ${nets.busted} busted (2nd); max ${nets.maxPerSegment} a segment`);
console.log(`  car carrier: ${carriers.spawned} spawned, ${carriers.drops} drops (closest ${carriers.minLead.toFixed(2)}s ahead), ${carriers.smashed} carriers smashed`);
console.log(`  landmarks passed: ${Object.entries(landmarks).sort().map(([k, v]) => `${k} ${v}`).join(', ')}; smashes inside them ${landmarkSmashes}`);
console.log(`  producer's asks (offered → done): ${Object.entries(asksAgg).sort().map(([k, v]) => `${k} ${v.done}/${v.offered}`).join(', ')}`);
console.log(`  escort: ${esc.joins} joins, nearest join ${esc.minJoinBehind.toFixed(1)}m back, ${esc.joinsOnCamera} on camera; closest gap ever ${esc.minGap.toFixed(2)}m (floor ${TUNING.escort.minGap}m)`);
if (Object.keys(aheadBy).length) console.log('  road-ahead shortfalls (min s by angle/tier):', JSON.stringify(Object.fromEntries(Object.entries(aheadBy).map(([k, v]) => [k, +v.toFixed(2)]))));
// Rampage loop: Jog (tier 0) is gone; Stride and Rampage carry the run.
for (let t = 1; t < 3; t++) {
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
for (const k of ['cruiser', 'spike', 'rolling', 'roadblock', 'chopper']) if (!p2.tells[k]) fail(`no ${k} tell in ${seeds} seeds`);
if (nets.maxPerSegment > Math.max(...TUNING.pursuit.net.perSegment)) fail(`police net: ${nets.maxPerSegment} in one segment`);
if (!nets.tells || !nets.escaped) fail(`police net never played out (${JSON.stringify(nets)})`);
if (!carriers.drops) fail('car carrier never dropped a car');
if (Object.keys(landmarks).length < 4) fail(`landmarks: only ${Object.keys(landmarks).join(', ')} passed in ${seeds} seeds`);
if (!forks.taken || !forks.stayed) fail(`forks: taken ${forks.taken}, stayed ${forks.stayed} in ${seeds} seeds`);
if (!p2.choppersShaken) fail(`no police chopper was ever shaken in ${seeds} seeds`);
if (!p2.policeCrash) fail(`no police crash in ${seeds} seeds`);
if (p2.crashOffscreen > p2.policeCrash * 0.1) fail(`${p2.crashOffscreen}/${p2.policeCrash} police crashes outside the frame`);
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
