import * as THREE from 'three';
import { TUNING } from './tuning';
import { Sim } from './sim/sim';
import { Bot } from './sim/bot';
import { NO_INPUT, type SimEvent, type SimInput } from './sim/types';
import { angleDiff } from './sim/math';
import { WorldView } from './render/world';
import { GiantView } from './render/giant';
import { CameraRig } from './render/camera';
import { PALETTE } from './render/palette';
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
const stickEl = $('stick');
const stickKnob = $('stick-knob');

// --- Renderer ---------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.sky);
scene.fog = new THREE.Fog(PALETTE.sky, 90, 220);
scene.add(new THREE.HemisphereLight(0xfff7e8, 0xb8b0a0, 1.5));
const sun = new THREE.DirectionalLight(0xffffff, 1.7);
sun.position.set(-40, 100, -25);
scene.add(sun);

const rig = new CameraRig();
rig.reducedMotion = settings.reducedMotion;
const tunePanel = mountTuningPanel(() => {
  rig.camera.fov = TUNING.camera.fov;
  rig.camera.updateProjectionMatrix();
});
if (flags.tune) tunePanel.toggle();

// --- Game state -------------------------------------------------------------
let sim: Sim;
let world: WorldView;
let giant: GiantView;
let bot: Bot | null = null;
const audio = new Audio();
const input = new Input(canvas, $('btn-shoulder'), $('btn-pause'));

const prev = { x: 0, z: 0, heading: 0, travel: 0 };
let started = false;
let paused = false;
let hitstop = 0;
let flashFrames = 0;
let menuGuard = 0;
let acc = 0;
let lastScrape = 0;
let lastShove = 0;
const recentEvents: SimEvent[] = [];
const perf = { fps: 0, frames: 0, t: 0, simMs: 0 };

function newRun(seed: number) {
  if (world) scene.remove(world.group);
  if (giant) for (const o of giant.objects) scene.remove(o);
  sim = new Sim({ seed });
  world = new WorldView(sim);
  giant = new GiantView();
  scene.add(world.group, ...giant.objects);
  giant.reset(sim.giant);
  rig.snap(sim.giant.x, sim.giant.z, sim.giant.tier);
  bot = flags.bot ? new Bot(sim) : null;
  prev.x = sim.giant.x;
  prev.z = sim.giant.z;
  prev.heading = sim.giant.heading;
  prev.travel = sim.giant.travel;
  acc = 0;
  hitstop = 0;
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

function present(e: SimEvent) {
  recentEvents.push(e);
  if (recentEvents.length > 64) recentEvents.shift();
  const I = TUNING.impact;
  switch (e.type) {
    case 'footfall': {
      audio.footfall(e.tier);
      rig.jolt(TUNING.camera.footfallShakePx[e.tier], 0.08);
      if (e.tier === 2) {
        world.ring(e.x, e.z, 2.6, 0xcfc6b4, 0.5);
        haptic(30, 0.15); // §27 light pulse per footfall at Rampage only
      }
      break;
    }
    case 'knock': {
      const p = sim.props[e.propId];
      world.smashDebris(p, e.dirX, e.dirZ, e.speed);
      world.writeProp(p);
      audio.knock();
      break;
    }
    case 'smash': {
      const p = sim.props[e.propId];
      const k = e.cls === 'heavy' ? I.heavy : I.medium;
      world.smashDebris(p, e.dirX, e.dirZ, e.speed);
      world.writeProp(p);
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
      world.spawnDebris(e.x, e.z, e.nx, e.nz, 3, 6, [0xd9d2c4, 0xbdb6aa], [0.1, 0.3]);
      break;
    }
    case 'scrape': {
      if (sim.time - lastScrape > 0.2) {
        audio.scrape();
        lastScrape = sim.time;
      }
      break;
    }
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
    case 'shoulder':
      giant.onShoulder();
      audio.shoulder();
      world.ring(e.x + e.dirX * 2, e.z + e.dirZ * 2, TUNING.shoulderCheck.shoveRadius, 0xffffff, 0.35, 0.8);
      rig.jolt(2, 0.1);
      haptic(80, 0.5);
      break;
    case 'shove':
      if (sim.time - lastShove > 0.08) {
        audio.shove();
        lastShove = sim.time;
      }
      break;
    case 'respawn':
      world.writeProp(sim.props[e.propId]);
      break;
  }
}

function stepSim(inp: SimInput) {
  const g = sim.giant;
  prev.x = g.x;
  prev.z = g.z;
  prev.heading = g.heading;
  prev.travel = g.travel;
  const t0 = performance.now();
  const events = sim.step(inp);
  perf.simMs = performance.now() - t0;
  for (const e of events) present(e);
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
  // Audio must never block the run from starting.
  try {
    audio.unlock();
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
const proj = new THREE.Vector3();
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
      let inp = bot ? bot.input() : input.sample(SIM_DT);
      if (menuGuard > 0) {
        menuGuard--;
        inp = { ...inp, shoulder: false };
      }
      stepSim(inp);
      steps++;
    }
    if (steps >= 8) acc = 0;
  } else if (!started) {
    input.sample(SIM_DT); // drain edges while on the title
  }

  const g = sim.giant;
  const alpha = flags.stepMode ? 1 : Math.min(1, acc / SIM_DT);
  const x = prev.x + (g.x - prev.x) * alpha;
  const z = prev.z + (g.z - prev.z) * alpha;
  const heading = prev.heading + angleDiff(prev.heading, g.heading) * alpha;
  const travel = prev.travel + angleDiff(prev.travel, g.travel) * alpha;

  const animDt = paused || frozen ? 0 : realDt * flags.timescale;
  if (Math.abs(g.angVel) > 1.2 && animDt > 0) audio.capeWhip(Math.min(1, Math.abs(g.angVel) / 2.5));
  audio.setRotor(g.tier / 2);
  giant.update(animDt, x, z, heading, g);
  world.update(animDt, alpha);
  rig.setTier(g.tier);
  rig.update(paused ? 0 : realDt, x, z, travel);

  // Mouse-direction steering needs the giant on screen.
  proj.set(x, 1.6, z).project(rig.camera);
  input.giantScreen.x = (proj.x * 0.5 + 0.5) * window.innerWidth;
  input.giantScreen.y = (-proj.y * 0.5 + 0.5) * window.innerHeight;

  // Flash.
  flashEl.style.opacity = flashFrames > 0 ? '0.85' : '0';
  if (flashFrames > 0) flashFrames--;

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

  const t = input.touchStick;
  if (t && input.device === 'touch') {
    stickEl.style.display = 'block';
    stickEl.style.left = `${t.sx}px`;
    stickEl.style.top = `${t.sy}px`;
    const dx = Math.max(-40, Math.min(40, t.x - t.sx));
    const dy = Math.max(-40, Math.min(40, t.y - t.sy));
    stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
    stickEl.classList.toggle('braking', g.braking);
  } else {
    stickEl.style.display = 'none';
  }

  perf.frames++;
  perf.t += dt;
  if (perf.t >= 0.5) {
    perf.fps = perf.frames / perf.t;
    perf.frames = 0;
    perf.t = 0;
  }
  if (settings.debug) {
    const drift = (angleDiff(g.travel, g.heading) * 180) / Math.PI;
    debugEl.textContent =
      `seed ${sim.seed}  t ${sim.time.toFixed(1)}s  ${perf.fps.toFixed(0)} fps  sim ${perf.simMs.toFixed(2)}ms\n` +
      `tier ${T.name}  speed ${g.speed.toFixed(2)} m/s  top ${T.topSpeed}\n` +
      `tier-up ${Number.isFinite(T.tierUpAfter) ? `${g.tierTimer.toFixed(2)}/${T.tierUpAfter}s` : '—'}  drift ${drift.toFixed(0)}°\n` +
      `brake ${g.braking ? 'ON' : '-'}  stumble ${g.stumble.toFixed(2)}  shoulder cd ${g.shoulderCd.toFixed(1)}\n` +
      `smash ${sim.stats.smashes}  knock ${sim.stats.knocks}  bounce ${sim.stats.bounces}  shove ${sim.stats.shoves}\n` +
      `input ${input.device}${bot ? ' (BOT)' : ''}  timescale ${flags.timescale}`;
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
  /** Step mode: advance N ticks with a fixed input (or the bot). */
  step(n: number, inp?: SimInput) {
    for (let i = 0; i < n; i++) stepSim(inp ?? (bot ? bot.input() : NO_INPUT));
  },
  state() {
    const g = sim.giant;
    return { time: sim.time, tick: sim.tick, x: g.x, z: g.z, speed: g.speed, tier: g.tier, heading: g.heading, stats: sim.stats, fps: perf.fps };
  },
  events: recentEvents,
};
