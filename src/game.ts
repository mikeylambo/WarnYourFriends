import * as THREE from 'three';
import { TUNING } from './tuning';
import { Sim } from './sim/sim';
import { Bot } from './sim/bot';
import { NO_INPUT, type SimEvent, type SimInput } from './sim/types';
import { HighwayView } from './render/highway';
import { GiantView } from './render/giant';
import { CameraRig, Director, type CameraTarget } from './render/camera';
import { PALETTE } from './render/palette';
import { Gait } from './anim/gait';
import { Audio } from './audio';
import { Input } from './input';
import { readFlags } from './debug';
import { loadSettings, saveSettings } from './settings';
import { applyStoredTuning, mountTuningPanel } from './tuningPanel';

applyStoredTuning();

const flags = readFlags(location.search);
const settings = loadSettings();
if (flags.reducedMotion !== null) settings.reducedMotion = flags.reducedMotion;
if (flags.reduceFlashes !== null) settings.reduceFlashes = flags.reduceFlashes;
if (flags.debug !== null) settings.debug = flags.debug;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('view');
const flashEl = $('flash');
const debugEl = $('debug');
const tierbar = $('tierbar');
const tierName = tierbar.querySelector('.name') as HTMLElement;
const tierMeter = tierbar.querySelector('.meter i') as HTMLElement;
const titleEl = $('title');
const pausedEl = $('paused');
const touchUi = $('touch-ui');
const camTag = $('camtag');

// --- Renderer ---------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.sky);
scene.fog = new THREE.Fog(PALETTE.sky, 160, 420);
scene.add(new THREE.HemisphereLight(0xfff7e8, 0xb8b0a0, 1.5));
const sun = new THREE.DirectionalLight(0xffffff, 1.7);
sun.position.set(-40, 100, -25);
scene.add(sun);

const rig = new CameraRig();
rig.reducedMotion = settings.reducedMotion;
const tunePanel = mountTuningPanel();
if (flags.tune) tunePanel.toggle();

// --- Game state -------------------------------------------------------------
let sim: Sim;
let highway: HighwayView;
let giant: GiantView;
let gait: Gait;
let director: Director;
let bot: Bot | null = null;
const audio = new Audio();
const input = new Input(canvas, $('btn-shoulder'), $('btn-pause'));

const prev = { s: 0, d: 0, stepPos: 0 };
let started = false;
let paused = false;
let hitstop = 0;
let flashFrames = 0;
let menuGuard = 0;
let acc = 0;
let camTagT = 0;
const recentEvents: SimEvent[] = [];
const perf = { fps: 0, frames: 0, t: 0, simMs: 0 };
/** Browser-side measurements, exposed for E2E. */
const measure = {
  cadence: [0, 1, 2].map(() => ({ min: Infinity, max: 0, n: 0 })),
  lastFoot: -1,
  cuts: 0,
  cutsDuringLane: 0,
  lastCutAt: -Infinity,
  minCutGap: Infinity,
  maxScreenUp: 0,
  maxGiantY: 0,
  minAhead: Infinity,
  frames: 0,
};

const pos = { x: 0, z: 0 };
function targetAt(s: number, d: number): CameraTarget {
  sim.track.posAt(s, d, pos);
  return { x: pos.x, z: pos.z, travel: sim.track.headingAt(s), speed: sim.giant.speed, tier: sim.giant.tier };
}

function newRun(seed: number) {
  if (highway) scene.remove(highway.group);
  if (giant) for (const o of giant.objects) scene.remove(o);
  sim = new Sim({ seed });
  highway = new HighwayView(sim);
  giant = new GiantView();
  gait = new Gait();
  director = new Director(seed);
  scene.add(highway.group, ...giant.objects);
  giant.reset();
  const g = sim.giant;
  prev.s = g.s;
  prev.d = g.d;
  prev.stepPos = g.stepPos;
  rig.snap(targetAt(g.s, g.d));
  if (flags.angle !== null) setAngle(flags.angle, 1);
  bot = flags.bot ? new Bot(sim) : null;
  acc = 0;
  hitstop = 0;
}

function setAngle(index: number, side: number) {
  const n = TUNING.camera.angles.length;
  const i = ((index % n) + n) % n;
  director.force(i, side);
  rig.cut(i, side, targetAt(sim.giant.s, sim.giant.d));
  showCamTag();
}

newRun(flags.seed);

// --- Presentation of sim events ---------------------------------------------
function haptic(ms: number, strength: number) {
  if (ms <= 0) return;
  const pads = navigator.getGamepads?.() ?? [];
  for (const p of pads) {
    const act = (p as (Gamepad & { vibrationActuator?: { playEffect?: (t: string, o: object) => Promise<unknown> } }) | null)?.vibrationActuator;
    act?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: strength, weakMagnitude: strength * 0.6 }).catch(() => {});
  }
  if (input.device === 'touch' && 'vibrate' in navigator) navigator.vibrate(ms);
}

function flash(frames: number) {
  if (frames <= 0 || settings.reduceFlashes) return;
  flashFrames = Math.max(flashFrames, frames);
}

/** v0.3 cut graphic: a subtle "CAM n · NAME" tag. */
function showCamTag() {
  const i = director.current;
  camTag.textContent = `CAM ${i + 1} · ${TUNING.camera.angles[i].name.toUpperCase()}`;
  camTag.classList.remove('show');
  void camTag.offsetWidth;
  camTag.classList.add('show');
  camTagT = 1.6;
}

function present(e: SimEvent) {
  recentEvents.push(e);
  if (recentEvents.length > 64) recentEvents.shift();
  const I = TUNING.impact;
  const g = sim.giant;
  const h = sim.track.headingAt(g.s);
  switch (e.type) {
    case 'footfall': {
      // Visuals and audio fire from the gait plant (exactly where the foot lands); here we only measure.
      if (measure.lastFoot >= 0) {
        const c = 1 / (e.t - measure.lastFoot);
        const m = measure.cadence[e.tier];
        m.min = Math.min(m.min, c);
        m.max = Math.max(m.max, c);
        m.n++;
      }
      measure.lastFoot = e.t;
      break;
    }
    case 'smash': {
      const k = e.cls === 'heavy' ? I.heavy : I.medium;
      // Debris flies along the run, and sideways on a smash-across.
      const lat = e.across ? Math.sign(e.d - g.d || 1) * 0.9 : 0;
      const dirX = Math.cos(h) - Math.sin(h) * lat;
      const dirZ = Math.sin(h) + Math.cos(h) * lat;
      highway.smash(e.propId, dirX, dirZ, e.speed);
      audio.smash(e.cls);
      hitstop = Math.max(hitstop, k.hitstop);
      rig.jolt(k.shake, e.cls === 'heavy' ? TUNING.camera.joltTime : 0.08);
      flash(k.flashFrames);
      haptic(k.haptic, k.hapticStrength);
      break;
    }
    case 'bounce': {
      const k = I.bounce;
      audio.bounce();
      giant.onBounce();
      hitstop = Math.max(hitstop, k.hitstop);
      rig.jolt(k.shake, 0.15);
      haptic(k.haptic, k.hapticStrength);
      sim.track.posAt(e.s, e.d, pos);
      highway.spawnDebris(pos.x, pos.z, -Math.cos(h), -Math.sin(h), 3, 6, [0xd9d2c4, 0xbdb6aa], [0.1, 0.3]);
      break;
    }
    case 'wallBump': {
      const k = I.wall;
      audio.scrape();
      rig.jolt(k.shake, 0.1);
      haptic(k.haptic, k.hapticStrength);
      break;
    }
    case 'laneChange':
      audio.capeWhip(0.5 + g.tier * 0.25);
      break;
    case 'tierUp': {
      rig.tierUpPulse();
      audio.tierUp(e.tier);
      giant.onTierUp();
      tierbar.classList.remove('flick');
      void tierbar.offsetWidth;
      tierbar.classList.add('flick');
      break;
    }
    case 'tierDown':
      audio.tierDown();
      break;
    case 'shoulder': {
      giant.onShoulder();
      audio.shoulder();
      sim.track.posAt(e.s + 2, e.d, pos);
      highway.ring(pos.x, pos.z, 6, 0xffffff, 0.35, 0.8);
      rig.jolt(2, 0.1);
      haptic(80, 0.5);
      break;
    }
  }
}

function stepSim(inp: SimInput) {
  const g = sim.giant;
  prev.s = g.s;
  prev.d = g.d;
  prev.stepPos = g.stepPos;
  const t0 = performance.now();
  const events = sim.step(inp);
  perf.simMs = performance.now() - t0;
  for (const e of events) present(e);
  // The director cuts in sim time, only when no lane change is in progress.
  const cut = director.update(sim.dt, sim.laneBusy);
  if (cut) {
    measure.cuts++;
    if (sim.laneBusy) measure.cutsDuringLane++;
    measure.minCutGap = Math.min(measure.minCutGap, sim.time - measure.lastCutAt);
    measure.lastCutAt = sim.time;
    rig.cut(cut.index, cut.side, targetAt(g.s, g.d));
    flash(TUNING.camera.cutFlashFrames);
    showCamTag();
  }
}

// --- Pause, focus, start ------------------------------------------------------
function setPaused(p: boolean) {
  if (!started || p === paused) return;
  paused = p;
  pausedEl.hidden = !p;
  audio.setPaused(p);
  if (!p) menuGuard = 10; // §8 10f menu guard after any screen transition
}

function start() {
  if (started) return;
  started = true;
  titleEl.hidden = true;
  try {
    audio.unlock(); // audio must never block the run from starting
  } catch (e) {
    console.warn('Audio unavailable:', e);
  }
  menuGuard = 10;
}

titleEl.addEventListener('click', start);
titleEl.addEventListener('touchend', (e) => {
  e.preventDefault();
  start();
});
input.onAnyInput = () => {
  if (!started) start();
  try {
    audio.unlock();
  } catch {
    /* audio unavailable */
  }
};
input.onPadDisconnect = () => setPaused(true);
window.addEventListener('blur', () => setPaused(true)); // §20 focus loss auto-pauses
document.addEventListener('visibilitychange', () => document.hidden && setPaused(true));
$('resume').addEventListener('click', () => setPaused(false));

const optReduced = $<HTMLInputElement>('opt-reduced');
const optFlashes = $<HTMLInputElement>('opt-flashes');
const optDebug = $<HTMLInputElement>('opt-debug');
optReduced.checked = settings.reducedMotion;
optFlashes.checked = settings.reduceFlashes;
optDebug.checked = settings.debug;
debugEl.hidden = !settings.debug;
optReduced.addEventListener('change', () => {
  settings.reducedMotion = rig.reducedMotion = optReduced.checked;
  saveSettings(settings);
});
optFlashes.addEventListener('change', () => {
  settings.reduceFlashes = optFlashes.checked;
  saveSettings(settings);
});
optDebug.addEventListener('change', () => {
  settings.debug = optDebug.checked;
  debugEl.hidden = !settings.debug;
  saveSettings(settings);
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'Backquote' || e.code === 'F3') {
    settings.debug = !settings.debug;
    optDebug.checked = settings.debug;
    debugEl.hidden = !settings.debug;
    saveSettings(settings);
    e.preventDefault();
  }
  if (e.code === 'KeyT') tunePanel.toggle();
  if (e.code === 'KeyC' && started && !paused) setAngle(director.current + 1, director.side); // dev: next angle
  if (e.code === 'KeyR' && started && !paused) newRun(flags.seedFixed ? flags.seed : (Math.random() * 1e9) | 0);
});

if (flags.bot || flags.autostart) start();

// --- Resize -------------------------------------------------------------------
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  rig.resize(w, h);
}
window.addEventListener('resize', resize);
resize();

// --- Loop -----------------------------------------------------------------------
const SIM_DT = 1 / TUNING.sim.hz;
let last = performance.now();

function frame(now: number) {
  requestAnimationFrame(frame);
  const realDt = Math.min(0.1, (now - last) / 1000);
  last = now;

  if (input.consumePause()) setPaused(!paused);
  touchUi.hidden = input.device !== 'touch';

  let frozen = false;
  if (started && !paused && !flags.stepMode) {
    acc += realDt * flags.timescale;
    let steps = 0;
    while (acc >= SIM_DT && steps < 8) {
      acc -= SIM_DT;
      if (hitstop > 0) {
        hitstop--;
        frozen = true;
        continue;
      }
      let inp = bot ? bot.input() : input.sample();
      if (menuGuard > 0) {
        menuGuard--;
        inp = { ...inp, shoulder: false, lane: 0 };
      }
      stepSim(inp);
      steps++;
    }
    if (steps >= 8) acc = 0;
  } else if (!started) {
    input.sample(); // drain edges while on the title
  }
  highway.sync();

  const g = sim.giant;
  const alpha = flags.stepMode ? 1 : Math.min(1, acc / SIM_DT);
  const s = prev.s + (g.s - prev.s) * alpha;
  const d = prev.d + (g.d - prev.d) * alpha;
  const stepPos = prev.stepPos + (g.stepPos - prev.stepPos) * alpha;
  const t = targetAt(s, d);
  const lateralVel = (g.d - prev.d) / SIM_DT;
  const heading = t.travel + Math.atan2(lateralVel, Math.max(4, g.speed)) * 0.5;

  const animDt = paused || frozen ? 0 : realDt * flags.timescale;
  audio.setRotor(g.tier / 2);

  if (animDt > 0) {
    const gf = gait.update({ x: t.x, z: t.z, fx: Math.cos(t.travel), fz: Math.sin(t.travel), speed: g.speed, stepPos, stepLen: g.stepLen, tier: g.tier, dt: animDt });
    if (gf.plantedNow === 0 || gf.plantedNow === 1) {
      // v0.3 footfall: dust ring, 2px camera pulse, bass thump; Rampage adds a crack decal.
      const f = gf.legs[gf.plantedNow as 0 | 1].foot;
      highway.ring(f.x, f.z, 1.6 + g.tier * 0.7, PALETTE.dust, 0.5, 0.55);
      rig.jolt(TUNING.footfall.pulsePx, TUNING.footfall.pulseTime);
      audio.footfall(g.tier);
      if (g.tier === 2) {
        highway.crack(f.x, f.z, t.travel);
        haptic(30, 0.15); // §27 light pulse per footfall at Rampage only
      }
    }
    giant.update(animDt, { x: t.x, z: t.z, heading, travel: t.travel, lateralVel, speed: g.speed, tier: g.tier, braking: g.braking, stumble: g.stumble, stepPos }, gf);
  }
  highway.update(animDt, t.x, t.z);
  rig.update(paused ? 0 : realDt, t);

  const info = rig.info;
  if (started && !paused) {
    measure.frames++;
    measure.maxScreenUp = Math.max(measure.maxScreenUp, Math.abs(info.screenUpDeg));
    measure.maxGiantY = Math.max(measure.maxGiantY, info.giantScreenY);
    if (g.speed > 5.5) measure.minAhead = Math.min(measure.minAhead, info.aheadSeconds);
  }

  flashEl.style.opacity = flashFrames > 0 ? '0.85' : '0';
  if (flashFrames > 0) flashFrames--;
  camTagT = Math.max(0, camTagT - realDt);
  if (camTagT === 0) camTag.classList.remove('show');

  renderer.render(scene, rig.camera);
  updateHud(realDt);
}

function updateHud(dt: number) {
  const g = sim.giant;
  const T = TUNING.tiers[g.tier];
  tierName.textContent = T.name.toUpperCase();
  tierbar.classList.toggle('t1', g.tier === 1);
  tierbar.classList.toggle('t2', g.tier === 2);
  const fill = Number.isFinite(T.tierUpAfter) ? Math.min(1, g.tierTimer / T.tierUpAfter) : 1;
  tierMeter.style.width = `${(fill * 100).toFixed(1)}%`;

  perf.frames++;
  perf.t += dt;
  if (perf.t >= 0.5) {
    perf.fps = perf.frames / perf.t;
    perf.frames = 0;
    perf.t = 0;
  }
  if (settings.debug) {
    const info = rig.info;
    const worst = [0, 0, 0];
    for (const r of gait.records) worst[r.tier] = Math.max(worst[r.tier], r.slide);
    debugEl.textContent =
      `seed ${sim.seed}  t ${sim.time.toFixed(1)}s  ${perf.fps.toFixed(0)} fps  sim ${perf.simMs.toFixed(2)}ms\n` +
      `tier ${T.name}  speed ${g.speed.toFixed(2)} m/s  step ${g.stepLen.toFixed(2)}m  cadence ${(g.speed / g.stepLen).toFixed(2)}/s\n` +
      `lane ${g.lane + 1}/${sim.track.lanesAt(g.s)}  ${g.move ?? '-'}  queue ${g.laneQueue || '-'}  stumble ${g.stumble.toFixed(2)}  brake ${g.braking ? 'ON' : '-'}\n` +
      `tier-up ${Number.isFinite(T.tierUpAfter) ? `${g.tierTimer.toFixed(2)}/${T.tierUpAfter}s` : '—'}  shoulder cd ${g.shoulderCd.toFixed(1)}\n` +
      `smash ${sim.stats.smashes} (across ${sim.stats.smashesAcross})  bounce ${sim.stats.bounces}  wall ${sim.stats.wallBumps}\n` +
      `cam ${info.angle}  up ${info.screenUpDeg.toFixed(1)}°  yaw ${info.yawDeg.toFixed(1)}°  ahead ${info.aheadSeconds.toFixed(1)}s  giant y ${info.giantScreenY.toFixed(2)}  cuts ${measure.cuts}\n` +
      `slide max ${worst.map((w) => (w * 100).toFixed(1)).join('/')}cm  input ${input.device}${bot ? ' (BOT)' : ''}  timescale ${flags.timescale}`;
  }
}

requestAnimationFrame(frame);

// --- Dev hook for headless tests (§29 rule 5) -----------------------------------
declare global {
  interface Window {
    __GAME: unknown;
  }
}
window.__GAME = {
  get sim() {
    return sim;
  },
  flags,
  get started() {
    return started;
  },
  get paused() {
    return paused;
  },
  start,
  pause: () => setPaused(true),
  resume: () => setPaused(false),
  newRun,
  setBot(on: boolean) {
    bot = on ? new Bot(sim) : null;
  },
  /** Dev/screenshots only: cut to an angle now, ignoring the director's rules. */
  setAngle,
  /** Step mode: advance N ticks with a fixed input (or the bot). */
  step(n: number, inp?: SimInput) {
    for (let i = 0; i < n; i++) stepSim(inp ?? (bot ? bot.input() : NO_INPUT));
  },
  camera() {
    return { ...rig.info, cuts: measure.cuts, cutsDuringLane: measure.cutsDuringLane, minCutGap: measure.minCutGap, maxScreenUp: measure.maxScreenUp, maxGiantY: measure.maxGiantY, minAhead: measure.minAhead };
  },
  gait() {
    const worst = [0, 0, 0];
    const plants = [0, 0, 0];
    for (const r of gait.records) {
      worst[r.tier] = Math.max(worst[r.tier], r.slide);
      plants[r.tier]++;
    }
    return { worstSlide: worst, plants, cadence: measure.cadence.map((c) => ({ ...c })) };
  },
  state() {
    const g = sim.giant;
    return { time: sim.time, tick: sim.tick, s: g.s, d: g.d, lane: g.lane, lanes: sim.track.lanesAt(g.s), laneBusy: sim.laneBusy, speed: g.speed, tier: g.tier, stats: sim.stats, fps: perf.fps };
  },
  events: recentEvents,
};
