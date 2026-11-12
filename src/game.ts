import * as THREE from 'three';
import { TUNING } from './tuning';
import { Sim } from './sim/sim';
import { Bot } from './sim/bot';
import { NO_INPUT, type SimEvent, type SimInput } from './sim/types';
import { HighwayView } from './render/highway';
import { GiantView } from './render/giant';
import { CameraRig, Director, cutTriggerFor, type CameraTarget, type CutDecision } from './render/camera';
import { PALETTE, type TimeOfDay } from './render/palette';
import { Lighting, timeOfDayAt } from './render/lighting';
import { CruiserView } from './render/cruisers';
import { UnitViews } from './render/units';
import { ViewerVideo } from './render/pip';
import { Coverage } from './broadcast/coverage';
import VIEWERS from './broadcast/viewers.json';
import { measureSilhouette } from './render/silhouette';
import { Newsroom, type Headline } from './broadcast/headlines';
import type { PropKind } from './sim/types';
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
if (flags.cuts !== null) settings.cameraCuts = flags.cuts;

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
const clockEl = $('clock');
const chyKicker = document.querySelector('#chyron .kicker') as HTMLElement;
const chyText = document.querySelector('#chyron .text') as HTMLElement;
const breakingEl = $('breaking');
const viewersEl = $('viewers');
const ratingsEl = $('ratings');
const ratingsBar = $('ratingsbar');
const trendEl = $('trend');
const heatStars = [...document.querySelectorAll('#heat em')] as HTMLElement[];
const signoffEl = $('signoff');
const exitDistEl = $('exitdist');
const signoffArrow = signoffEl.querySelector('.arrow') as HTMLElement;

// --- Renderer ---------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
// Phase 0c: night by default; LIVE TIME follows the local clock; ?time= forces a look.
const lighting = new Lighting(scene);
lighting.reduceFlashes = settings.reduceFlashes;
let forcedLook: TimeOfDay | null = flags.time;
function currentLook(): TimeOfDay {
  if (forcedLook) return forcedLook;
  if (!settings.liveTime) return 'night';
  const now = new Date();
  return timeOfDayAt(now.getHours() + now.getMinutes() / 60);
}
function applyLook() {
  const m = currentLook();
  if (m !== lighting.mode) lighting.setMode(m);
}
applyLook();
setInterval(applyLook, 30_000);

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
let cruisers: CruiserView;
let units: UnitViews;
/** Phase 2: the broadcast has ended (busted or signed off); the recap follows. */
let endedAt = -1;
let recapShown = false;
/** Phase 2 Pin meter: a red ring on the ground around the giant, only above 0 (§21). */
const pinRing = (() => {
  const g = new THREE.RingGeometry(2.0, 2.45, 64, 1);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xff2a3a, transparent: true, opacity: 0.9, depthWrite: false }));
  m.renderOrder = 3;
  m.visible = false;
  return m;
})();
scene.add(pinRing);
const recapEl = $('recap');
const coverage = new Coverage();
const pip = new ViewerVideo($('pip'));
/** Run stats for the recap, counted from sim events. */
const runStats = { heavy: 0, units: 0, lost: 0, dodged: 0, nearMiss: 0, best: null as Headline | null, bestRatings: -1 };
let news: Newsroom;
/** Prop kinds by id, recorded when a smash/bounce happens (the prop may be pruned before the headline). */
const propKinds = new Map<number, PropKind>();
/** Every cut this run, for E2E: sim time, reason, angle. */
const cutLog: { t: number; reason: CutDecision['reason']; index: number; laneBusy: boolean }[] = [];
const triggerLog: { t: number; kind: string }[] = [];
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
  swoopFrames: 0,
};

const pos = { x: 0, z: 0 };
function targetAt(s: number, d: number): CameraTarget {
  sim.track.posAt(s, d, pos);
  return { x: pos.x, z: pos.z, travel: sim.track.headingAt(s), speed: sim.giant.speed, tier: sim.giant.tier };
}

function newRun(seed: number) {
  if (highway) scene.remove(highway.group);
  if (giant) for (const o of giant.objects) scene.remove(o);
  if (cruisers) scene.remove(cruisers.group);
  if (units) scene.remove(units.group);
  endedAt = -1;
  recapShown = false;
  document.documentElement.classList.remove('ended');
  hideRecap();
  coverage.reset();
  pip.reset();
  Object.assign(runStats, { heavy: 0, units: 0, lost: 0, dodged: 0, nearMiss: 0, best: null, bestRatings: -1 });
  $('coldts').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  sim = new Sim({ seed });
  highway = new HighwayView(sim);
  highway.onHonk = (v) => audio.honk(v);
  giant = new GiantView();
  gait = new Gait();
  director = new Director(seed);
  director.enabled = settings.cameraCuts;
  cruisers = new CruiserView(sim);
  cruisers.reduceFlashes = settings.reduceFlashes;
  units = new UnitViews(sim, highway);
  units.reduceFlashes = settings.reduceFlashes;
  news = new Newsroom(seed);
  propKinds.clear();
  cutLog.length = 0;
  triggerLog.length = 0;
  chyKicker.textContent = 'SPOTTED';
  chyText.innerHTML = '<span>&nbsp;</span>';
  scene.add(highway.group, cruisers.group, units.group, ...giant.objects);
  giant.reset();
  const g = sim.giant;
  prev.s = g.s;
  prev.d = g.d;
  prev.stepPos = g.stepPos;
  rig.snap(targetAt(g.s, g.d));
  if (flags.angle !== null) setAngle(flags.angle, 1);
  // Compile every shader now (cruisers included, before they join) so the run never hitches on first sight.
  cruisers.showAll(true);
  renderer.compile(scene, rig.camera);
  cruisers.showAll(false);
  bot = flags.bot ? new Bot(sim) : null;
  acc = 0;
  hitstop = 0;
}

/** Dev (H): cut to Head-On and hold it; H again releases it with the swoop home. */
function toggleHeadOn() {
  const H = TUNING.camera.angles.findIndex((a) => a.headOn);
  const tg = targetAt(sim.giant.s, sim.giant.d);
  if (director.current === H) {
    director.force(TUNING.camera.homeAngle, 1, false);
    rig.swoopTo(TUNING.camera.homeAngle, 1, tg);
  } else {
    director.force(H, director.side, true);
    rig.cut(H, director.side, tg);
    flash(TUNING.camera.cutFlashFrames);
  }
  showCamTag();
}

function setAngle(index: number, side: number, pin = true) {
  const n = TUNING.camera.angles.length;
  const i = ((index % n) + n) % n;
  director.force(i, side, pin);
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

function hideRecap() {
  recapEl.hidden = true;
}
/** The 11 O'Clock Recap (§20: results as the evening news). */
function showRecap() {
  const sh = sim.show;
  const cleared = sh.state === 'cleared';
  const reason = cleared ? 'cleared' : (sh.reason ?? 'ratings');
  const lines = (VIEWERS.signoff as Record<string, string[]>)[reason];
  const anchorLine = lines[Math.floor(Math.random() * lines.length)];
  const last = news.history[news.history.length - 1];
  const best = runStats.best;
  const viewers = (r: number) => (r * 18_500 >= 1e6 ? `${((r * 18_500) / 1e6).toFixed(2)}M` : `${Math.round((r * 18_500) / 1000)}K`);
  const t = Math.floor(sim.time);
  const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  recapEl.innerHTML = `<div class="card">
    <div class="kicker">THE 11 O'CLOCK RECAP · WYF 6</div>
    <h2>${esc(last?.text ?? (cleared ? 'Giant Takes The Exit' : 'Suspect In Custody'))}</h2>
    <span class="outcome ${cleared ? 'cleared' : ''}">${cleared ? 'SIGNED OFF' : reason === 'pin' ? 'BUSTED · BOXED IN' : reason === 'ratings' ? 'BUSTED · CUT TO COMMERCIAL' : 'BUSTED · MISSED THE EXIT'}</span>
    ${best ? `<div class="best"><small>TONIGHT'S TOP STORY</small>${esc(best.text)}</div>` : ''}
    <div class="stats">
      <span>Peak audience <b>${viewers(sh.peak)}</b></span><span>Score banked <b>${Math.round(sh.banked).toLocaleString()}</b></span>
      <span>On air <b>${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}</b></span><span>Rampage time <b>${Math.round(sim.stats.timeAtTier[2])}s</b></span>
      <span>Things flattened <b>${sim.stats.smashes}</b></span><span>Police cars smashed <b>${runStats.units}</b></span>
      <span>Pursuers shaken <b>${runStats.lost}</b></span><span>Heat reached <b>${'★'.repeat(sh.heat)}</b></span>
    </div>
    <p class="anchor">${esc(anchorLine)}</p>
    <div class="row"><button class="go" id="again">Run it again</button><button class="go alt" id="same">Same road</button></div>
  </div>`;
  recapEl.hidden = false;
  ($('again') as HTMLButtonElement).onclick = () => restart(false);
  ($('same') as HTMLButtonElement).onclick = () => restart(true);
  ($('again') as HTMLButtonElement).focus();
}

function restart(sameRoad: boolean) {
  newRun(sameRoad ? sim.seed : (Math.random() * 1e9) | 0);
  if (flags.bot) bot = new Bot(sim);
  menuGuard = 10;
}

/** §21 chyron: show a headline; tier changes break in with the BREAKING wipe and stinger. */
function showHeadline(h: Headline) {
  chyKicker.textContent = h.kicker;
  chyKicker.classList.toggle('breaking', h.breaking);
  const span = document.createElement('span');
  span.textContent = h.text;
  span.className = 'in';
  chyText.replaceChildren(span);
  if (h.breaking) {
    audio.breaking();
    breakingEl.classList.toggle('soft', settings.reduceFlashes);
    breakingEl.classList.remove('go');
    void breakingEl.offsetWidth;
    breakingEl.classList.add('go');
  }
}

function present(e: SimEvent) {
  recentEvents.push(e);
  if (recentEvents.length > 64) recentEvents.shift();
  if (e.type === 'smash' || e.type === 'bounce') {
    const p = sim.track.props.find((q) => q.id === e.propId) ?? sim.pursuit.units.find((q) => q.id === e.propId);
    if (p) propKinds.set(p.id, p.kind);
  }
  news.observe(e, sim.time);
  const trig = cutTriggerFor(e);
  if (trig) {
    triggerLog.push({ t: sim.time, kind: trig });
    director.trigger(trig);
  }
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
      if (e.cls === 'heavy') {
        runStats.heavy++;
        pip.trigger(sim, sim.show.tier);
      }
      if (e.propId >= 1_000_000) {
        runStats.units++;
        units.smash(e.propId, dirX, dirZ, e.speed);
      }
      else highway.smash(e.propId, dirX, dirZ, e.speed);
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
    case 'unitSpawn':
      audio.whoop();
      break;
    case 'lostTrack':
      runStats.lost++;
      break;
    case 'nearMiss':
      runStats.nearMiss++;
      pip.trigger(sim, sim.show.tier);
      break;
    case 'ram':
      if (!e.hit) runStats.dodged++;
      pip.trigger(sim, sim.show.tier);
      break;
    case 'tell':
      audio.tell(e.kind);
      break;
    case 'spiked':
      audio.bounce();
      giant.onBounce();
      rig.jolt(3, 0.15);
      haptic(110, 0.6);
      break;
    case 'exitOpen':
      highway.rebuild([e.segment - 1, e.segment, e.segment + 1]);
      break;
    case 'busted':
    case 'signOff':
      endedAt = performance.now();
      coverage.end();
      audio.ending(e.type === 'signOff');
      if (e.type === 'busted') document.documentElement.classList.add('ended');
      bot = null;
      break;
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
  // Phase 0c director: event-driven cut-aways, home after 6–10s, never during a lane change.
  // Never cut during a lane change or a tell (v0.3 §15).
  const cut = director.update(sim.dt, sim.laneBusy || sim.tellActive);
  if (cut) {
    measure.cuts++;
    if (sim.laneBusy) measure.cutsDuringLane++;
    if (cut.reason !== 'home') {
      measure.minCutGap = Math.min(measure.minCutGap, sim.time - measure.lastCutAt);
      measure.lastCutAt = sim.time;
    }
    cutLog.push({ t: sim.time, reason: cut.reason, index: cut.index, laneBusy: sim.laneBusy });
    if (cut.reason === 'home' && rig.angle.swoopHome) {
      rig.swoopTo(cut.index, cut.side, targetAt(g.s, g.d)); // out of Head-On: a swoop, not a cut
    } else {
      rig.cut(cut.index, cut.side, targetAt(g.s, g.d));
      flash(TUNING.camera.cutFlashFrames);
    }
    showCamTag();
  }
  const h = news.update({ time: sim.time, tier: g.tier, lane: g.lane, lanes: sim.track.lanesAt(g.s), heading: sim.track.headingAt(g.s), s: g.s, ratingsTier: sim.show.tier, heat: sim.show.heat, zone: sim.track.segmentAt(g.s).zone, zoneName: sim.track.segmentAt(g.s).zoneName }, (id) => propKinds.get(id));
  if (h) {
    showHeadline(h);
    // Tonight's top story: the biggest headline that wasn't the ending itself.
    if (!['BUSTED', 'SIGN-OFF'].includes(h.kicker) && sim.show.ratings >= runStats.bestRatings) {
      runStats.best = h;
      runStats.bestRatings = sim.show.ratings;
    }
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
  document.documentElement.classList.add('playing');
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
const optCuts = $<HTMLInputElement>('opt-cuts');
const optLive = $<HTMLInputElement>('opt-livetime');
optCuts.checked = settings.cameraCuts;
optLive.checked = settings.liveTime;
optCuts.addEventListener('change', () => {
  settings.cameraCuts = director.enabled = optCuts.checked;
  saveSettings(settings);
});
optLive.addEventListener('change', () => {
  settings.liveTime = optLive.checked;
  forcedLook = null;
  applyLook();
  saveSettings(settings);
});
optReduced.checked = settings.reducedMotion;
optFlashes.checked = settings.reduceFlashes;
optDebug.checked = settings.debug;
debugEl.hidden = !settings.debug;
optReduced.addEventListener('change', () => {
  settings.reducedMotion = rig.reducedMotion = optReduced.checked;
  saveSettings(settings);
});
optFlashes.addEventListener('change', () => {
  settings.reduceFlashes = lighting.reduceFlashes = cruisers.reduceFlashes = units.reduceFlashes = optFlashes.checked;
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
  if (!recapEl.hidden && (e.code === 'Enter' || e.code === 'Space')) {
    e.preventDefault();
    restart(false);
    return;
  }
  if (e.code === 'KeyH' && started && !paused) toggleHeadOn(); // dev: preview Head-On and the swoop home
  if (e.code === 'KeyC' && started && !paused) setAngle(director.current + 1, director.side); // dev: next angle (held until C comes back to Chase High)
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
  document.documentElement.classList.toggle('touch', input.device === 'touch');

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
      // Lane input follows the screen: when travel points down (Head-On, or past halfway through
      // the swoop), his left is screen-right, so mirror it.
      if (!bot && rig.info.travelDown && inp.lane) inp = { ...inp, lane: -inp.lane };
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
        highway.stomp(f.x, f.z); // nearby cars bounce on their suspension
        haptic(30, 0.15); // §27 light pulse per footfall at Rampage only
      }
    }
    giant.update(animDt, { x: t.x, z: t.z, heading, travel: t.travel, lateralVel, speed: g.speed, tier: g.tier, braking: g.braking, stumble: g.stumble, stepPos }, gf);
  }
  highway.update(animDt, t.x, t.z, s, d);
  cruisers.update(animDt);
  units.update(animDt);
  // Broadcast graphics run on wall-clock time (a slow frame must not stretch the cold open).
  coverage.update(paused ? 0 : (now - lastCoverage) / 1000, sim.show.tier, started);
  lastCoverage = now;
  pip.update(animDt, t);
  // Pin ring (only above 0).
  pinRing.visible = sim.show.pin > 0.5 && sim.live;
  if (pinRing.visible) {
    pinRing.position.set(t.x, 0.1, t.z);
    pinRing.geometry.setDrawRange(0, Math.ceil((sim.show.pin / 100) * 64) * 6);
  }
  if (endedAt >= 0 && !recapShown && performance.now() - endedAt > (sim.show.state === 'cleared' ? 2600 : 2200)) {
    recapShown = true;
    showRecap();
  }
  rig.update(paused ? 0 : realDt * flags.timescale, t);
  lighting.update(animDt, { giantX: t.x, giantZ: t.z, travel: t.travel, speed: g.speed, camera: rig.camera, lamps: highway.lamps, sirens: cruisers.sirens, facing: rig.facing });
  audio.setSirens(sim.escort.cruisers.map((c) => (c.active ? Math.max(0.25, Math.min(1, 1 - (g.s - c.s - 8) / 60)) : 0)));

  const info = rig.info;
  if (started && !paused) {
    measure.frames++;
    if (info.transition) measure.swoopFrames++;
    else {
      // Camera rules hold on every frame outside a swoop (its length is bounded and soak-checked).
      measure.maxScreenUp = Math.max(measure.maxScreenUp, Math.abs(info.screenUpDeg));
      measure.maxGiantY = Math.max(measure.maxGiantY, info.giantScreenY);
      if (g.speed > 5.5) measure.minAhead = Math.min(measure.minAhead, info.aheadSeconds);
    }
  }

  flashEl.style.opacity = flashFrames > 0 ? '0.85' : '0';
  if (flashFrames > 0) flashFrames--;
  camTagT = Math.max(0, camTagT - realDt);
  if (camTagT === 0) camTag.classList.remove('show');

  renderer.render(scene, rig.camera);
  pip.render(renderer, scene);
  updateHud(realDt);
}

/** Render one frame now and measure the giant's silhouette (E2E / evidence). */
function silhouette() {
  renderer.render(scene, rig.camera);
  return measureSilhouette(renderer, scene, rig.camera, giant.bodyObjects, rig.angle.name === TUNING.camera.angles[TUNING.camera.homeAngle].name ? 48 : 40);
}

let lastRatings = 0;
let lastCoverage = performance.now();

/** Edge arrow to the sign-off ramp (§21), pointing at the gore from wherever it is. */
function updateSignOff() {
  const ex = sim.exit;
  signoffEl.hidden = !ex || !sim.live;
  if (!ex || !sim.live) return;
  const gp = sim.track.posAt(ex.gore, sim.track.laneCenter(ex.lane), { x: 0, z: 0 });
  const v = new THREE.Vector3(gp.x, 1, gp.z).project(rig.camera);
  const behind = v.z > 1;
  let nx = behind ? -v.x : v.x;
  let ny = behind ? -v.y : v.y;
  const onScreen = !behind && Math.abs(nx) < 0.9 && Math.abs(ny) < 0.8;
  const k = onScreen ? 1 : 0.86 / Math.max(Math.abs(nx), Math.abs(ny) / 0.9, 1e-6);
  nx = Math.max(-0.86, Math.min(0.86, nx * k));
  ny = Math.max(-0.72, Math.min(0.78, ny * k));
  const w = window.innerWidth;
  const h = window.innerHeight;
  signoffEl.style.left = `${((nx + 1) / 2) * w}px`;
  signoffEl.style.top = `${((1 - ny) / 2) * h - (onScreen ? 40 : 0)}px`;
  const ang = Math.atan2(-(v.y - ny) || -v.y, (v.x - nx) || v.x);
  signoffArrow.style.transform = onScreen ? 'rotate(90deg)' : `rotate(${ang}rad)`;
  exitDistEl.textContent = `${Math.max(0, Math.round(ex.gore - sim.giant.s))}m`;
}

function updateHud(dt: number) {
  const g = sim.giant;
  // LIVE clock; once the exit is open it counts down to the end of the grace period.
  const X = TUNING.segment;
  const counting = sim.time >= X.exitOpensAt && sim.live;
  const secs = counting ? Math.max(0, Math.ceil(X.length + X.grace - sim.time)) : Math.floor(sim.time);
  clockEl.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  clockEl.classList.toggle('count', counting);
  // Ratings as a viewer count (§21), with its tier colour, decay arrow and danger pulse.
  const sh = sim.show;
  const viewers = Math.round(sh.ratings * 18_500);
  viewersEl.textContent = viewers >= 1e6 ? `${(viewers / 1e6).toFixed(2)}M` : `${Math.round(viewers / 1000)}K`;
  ratingsBar.style.width = `${sh.ratings.toFixed(1)}%`;
  for (let k = 1; k <= 3; k++) ratingsEl.classList.toggle(`t${k}`, sh.tier === k);
  ratingsEl.classList.toggle('danger', sh.ratings < 8 && sim.live);
  const falling = sim.live && sh.ratings < lastRatings - 1e-6;
  trendEl.textContent = falling ? '▼' : '';
  lastRatings = sh.ratings;
  heatStars.forEach((el, i) => el.classList.toggle('on', i < sh.heat));
  updateSignOff();
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
      `cam ${info.angle}  up ${info.screenUpDeg.toFixed(1)}°  yaw ${info.yawDeg.toFixed(1)}°  ahead ${info.aheadSeconds.toFixed(1)}s  giant y ${info.giantScreenY.toFixed(2)}  cuts ${measure.cuts}${director.enabled ? '' : ' (OFF)'}${cutLog.length ? `  last: ${cutLog[cutLog.length - 1].reason}` : ''}\n` +
      `ratings ${sim.show.ratings.toFixed(1)} (peak ${sim.show.peak.toFixed(0)})  banked ${sim.show.banked.toFixed(0)}  heat ${sim.show.heat}  pin ${sim.show.pin.toFixed(0)}  ${sim.show.state}${sim.show.reason ? ':' + sim.show.reason : ''}  units ${sim.pursuit.units.length}${sim.tellActive ? ' TELL' : ''}\n` +
      `look ${lighting.mode}${settings.liveTime ? ' (LIVE TIME)' : ''}  cruisers ${sim.escort.cruisers.filter((c) => c.active).map((c) => (g.s - c.s).toFixed(0) + 'm').join(' ') || '-'}\n` +
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
    // A dev step jumps the sim ahead: put the camera where it would be, not where it was.
    rig.cut(director.current, director.side, targetAt(sim.giant.s, sim.giant.d));
  },
  /** Phase 0c: force a look ('night' | 'dusk' | 'day'), or null to follow the setting. */
  setLook(m: TimeOfDay | null) {
    forcedLook = m;
    if (m) lighting.setMode(m);
    else applyLook();
  },
  look: () => lighting.mode,
  silhouette,
  headlines: () => news.history.map((h) => ({ t: h.t, kicker: h.kicker, text: h.text, breaking: h.breaking, sources: h.sources.map((e) => e.type) })),
  chyron: () => ({ kicker: chyKicker.textContent, text: chyText.textContent }),
  cutLog: () => cutLog.slice(),
  triggerLog: () => triggerLog.slice(),
  director: () => ({ enabled: director.enabled, current: director.current, pinned: director.pinned, awayCuts: director.awayCuts }),
  toggleHeadOn,
  /** Dev: slow motion (camera included), for filmstrips. */
  recap: () => (recapEl.hidden ? null : { title: recapEl.querySelector('h2')?.textContent, outcome: recapEl.querySelector('.outcome')?.textContent }),
  show: () => ({ ...sim.show, tier: sim.show.tier, exit: sim.exit, live: sim.live, units: sim.pursuit.units.map((u) => ({ id: u.id, unit: u.unit, phase: u.phase, gap: u.s - sim.giant.s, lane: u.lane })) }),
  coverage: () => ({ cls: document.getElementById('hud')!.className, desk: !document.getElementById('desk')!.hidden, ticker: !document.getElementById('ticker')!.hidden, pip: pip.active, cold: !document.getElementById('coldopen')!.hidden }),
  /** Dev: roll viewer video now. */
  viewerVideo: () => pip.trigger(sim, 3, true),
  setTimescale(v: number) {
    flags.timescale = v;
  },
  facing: () => rig.facing,
  setCuts(on: boolean) {
    settings.cameraCuts = director.enabled = on;
  },
  escort: () => sim.escort.cruisers.map((c) => ({ active: c.active, gap: sim.giant.s - c.s, d: c.d })),
  camera() {
    return { ...rig.info, cuts: measure.cuts, cutsDuringLane: measure.cutsDuringLane, minCutGap: measure.minCutGap, maxScreenUp: measure.maxScreenUp, maxGiantY: measure.maxGiantY, minAhead: measure.minAhead, swoopFrames: measure.swoopFrames };
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
