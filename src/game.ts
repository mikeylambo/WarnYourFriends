import * as THREE from 'three';
import { TUNING, type UpgradeId } from './tuning';
import { RunState, ABILITIES } from './sim/run';
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
import { registerGlyphs, padFamily, type GlyphAction } from './glyphs';
import { readFlags } from './debug';
import { loadSettings, saveSettings } from './settings';
import { applyStoredTuning, mountTuningPanel } from './tuningPanel';
import { createGameApp, type InputDeviceFamily, type CoreSettings, type FrameAssembly, type GenreFrame, type RendererAdapter, type SLUWebShell } from '@slu/web-shell';

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
const segEl = $('segno');
const abilEl = $('abil');
const abilName = abilEl.querySelector('.nm') as HTMLElement;
const abilKey = abilEl.querySelector('.key') as HTMLElement;
const abilCd = abilEl.querySelector('.cd i') as HTMLElement;
const abilBtn = $<HTMLButtonElement>('btn-ability');
const controlsEl = $('controls');

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
const input = new Input(canvas, $('btn-shoulder'), $('btn-pause'), $('btn-ability'));
/** Phase 3: the five-segment run (null in a single broadcast or the attract loop). */
let run: RunState | null = null;
/** Phase 3: the hijacked car under the giant while he rides it. */
let rideMesh: THREE.Group | null = null;
let poseAnim = 0;
let bulbT = 0;
let bulbFrames = 0;

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

function newRun(seed: number, segment = 0, upgrades: UpgradeId[] = []) {
  if (highway) scene.remove(highway.group);
  if (giant) for (const o of giant.objects) scene.remove(o);
  if (cruisers) scene.remove(cruisers.group);
  if (units) scene.remove(units.group);
  if (rideMesh) scene.remove(rideMesh);
  rideMesh = null;
  poseAnim = 0;
  endedAt = -1;
  recapShown = false;
  document.documentElement.classList.remove('ended');
  hideRecap();
  coverage.reset();
  pip.reset();
  Object.assign(runStats, { heavy: 0, units: 0, lost: 0, dodged: 0, nearMiss: 0, best: null, bestRatings: -1 });
  $('coldts').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  sim = new Sim({ seed, segment, upgrades });
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
  news = new Newsroom(seed, sim.show.heat);
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
let hapticsOn = true;
function haptic(ms: number, strength: number) {
  if (ms <= 0 || !hapticsOn) return;
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
/** What an ability just did, beside its chip: the payoff has to read even when the chopper is far out. */
const abilPop = $('abilpop');
let abilPopT = 0;
function abilityPop(text: string, dud = false) {
  if (attract) return;
  abilPop.textContent = text;
  abilPop.classList.toggle('dud', dud);
  abilPop.classList.remove('show');
  void abilPop.offsetWidth;
  abilPop.classList.add('show');
  abilPopT = TUNING.abilities.popTime;
}

/** Impact pass: Ratings gains pop under the meter as they land, so every hit and dodge pays visibly. */
const VIEWERS_PER_POINT = TUNING.show.viewersPerPoint;
const gainPopEl = $('gainpop');
let gainPopT = 0;
let gainPopSum = 0;
let gainPopLabel = '';
const GAIN_LABEL: Partial<Record<string, string>> = { nearMiss: 'Close call', lostTrack: 'Shook one', medium: '', heavy: '' };
function gainPop(delta: number, cause: string) {
  if (attract) return;
  const I = TUNING.impact;
  const merging = gainPopT > I.popTime - I.popMerge;
  gainPopSum = merging ? gainPopSum + delta : delta;
  const label = GAIN_LABEL[cause] ?? '';
  if (!merging || label) gainPopLabel = label;
  gainPopEl.textContent = `${gainPopLabel ? gainPopLabel + ' ' : ''}+${Math.round((gainPopSum * VIEWERS_PER_POINT) / 1000)}K`;
  gainPopEl.classList.remove('show');
  void gainPopEl.offsetWidth;
  gainPopEl.classList.add('show');
  gainPopT = I.popTime;
}

/** The Stare: a pale glare sweeps up his lane and the lanes either side, then fades. */
const glares: { mesh: THREE.Mesh; t: number }[] = [];
const glareMat = new THREE.MeshBasicMaterial({ color: 0xbfd6ff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
function glare(s0: number, d: number) {
  const A = TUNING.abilities.stare;
  const W = TUNING.lanes.width * (A.lanesEitherSide + 0.5);
  const N = 24;
  const verts = new Float32Array((N + 1) * 2 * 3);
  const p = new THREE.Vector3();
  for (let i = 0; i <= N; i++) {
    const s = s0 + 3 + (A.reach * i) / N;
    for (let k = 0; k < 2; k++) {
      sim.track.posAt(s, d + (k ? W : -W), p);
      verts.set([p.x, 0.12, p.z], (i * 2 + k) * 3);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < N; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, glareMat.clone());
  mesh.renderOrder = 2;
  scene.add(mesh);
  glares.push({ mesh, t: 0 });
}
function updateAbilityFx(dt: number) {
  const A = TUNING.abilities.stare;
  for (let i = glares.length - 1; i >= 0; i--) {
    const gl = glares[i];
    gl.t += dt;
    const k = gl.t / A.glareTime;
    // Sweeps in from the giant (draw range grows), then fades.
    const total = gl.mesh.geometry.index!.count;
    gl.mesh.geometry.setDrawRange(0, Math.ceil(Math.min(1, k * 3) * total / 6) * 6);
    (gl.mesh.material as THREE.MeshBasicMaterial).opacity = (settings.reduceFlashes ? 0.18 : 0.35) * Math.max(0, 1 - k);
    if (k >= 1) {
      scene.remove(gl.mesh);
      gl.mesh.geometry.dispose();
      (gl.mesh.material as THREE.Material).dispose();
      glares.splice(i, 1);
    }
  }
  if (abilPopT > 0 && (abilPopT -= dt) <= 0) abilPop.classList.remove('show');
  if (gainPopT > 0 && (gainPopT -= dt) <= 0) gainPopEl.classList.remove('show');
}

/** A new recap/meeting card ignores accept for a moment: one press must not open it and choose on it. */
let recapArmedAt = 0;
const recapArmed = () => performance.now() >= recapArmedAt;
const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Phase 3 (§4, §17): the Producer's Meeting. Three pitches paid from the purse, or skip. */
function showMeeting() {
  if (!run) return;
  const r = run;
  const offers = r.offers();
  const held = r.ability;
  recapEl.innerHTML = `<div class="card meeting">
    <div class="kicker">PRODUCER'S MEETING · BEFORE SEGMENT ${r.segment + 2} OF ${TUNING.run.segments}</div>
    <div class="purse">Budget <b>${r.purse.toLocaleString()}</b></div>
    <div class="pitches">${offers
      .map((id) => {
        const u = TUNING.upgrades[id];
        const swap = u.kind === 'ability' && held ? `<small class="swap">Replaces ${esc(TUNING.upgrades[held].label)}</small>` : '';
        return `<button class="pitch ${u.kind}" data-id="${id}" ${r.canAfford(id) ? '' : 'disabled'}>
          <span class="tag">${u.kind === 'ability' ? 'ABILITY' : 'PASSIVE'}</span>
          <b>${esc(u.label)}</b><span class="blurb">${esc(u.blurb)}</span>${swap}<span class="price">${u.price.toLocaleString()}</span></button>`;
      })
      .join('')}</div>
    <div class="row"><button class="go alt" id="skip">Skip</button></div>
    <div class="padhint"></div>
  </div>`;
  recapArmedAt = performance.now() + 250;
  for (const b of recapEl.querySelectorAll<HTMLButtonElement>('.pitch')) b.onclick = () => r.buy(b.dataset.id as UpgradeId) && nextSegment();
  ($('skip') as HTMLButtonElement).onclick = () => r.nextSegment() && nextSegment();
  (recapEl.querySelector<HTMLButtonElement>('.pitch:not([disabled])') ?? $<HTMLButtonElement>('skip')).focus();
}

/** The next segment of the run: a new road, Heat starts higher, the upgrades come along. */
function nextSegment() {
  if (!run) return;
  newRun(run.segmentSeed(), run.segment, run.owned);
  bot = flags.bot ? new Bot(sim) : null;
  menuGuard = 10;
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
  const viewers = (r: number) => (r * VIEWERS_PER_POINT >= 1e6 ? `${((r * VIEWERS_PER_POINT) / 1e6).toFixed(2)}M` : `${Math.round((r * VIEWERS_PER_POINT) / 1000)}K`);
  const t = Math.floor(sim.time);
  const N = TUNING.run.segments;
  const segLabel = run ? ` · SEGMENT ${run.segment + 1} OF ${N}` : '';
  const runStatsHtml = run && run.phase !== 'meeting'
    ? `<span>Run score <b>${Math.round(run.earned).toLocaleString()}</b></span><span>Segments cleared <b>${run.results.filter((x) => x.cleared).length} / ${N}</b></span>`
    : run ? `<span>Run so far <b>${Math.round(run.earned).toLocaleString()}</b></span><span>Budget <b>${run.purse.toLocaleString()}</b></span>` : '';
  const buttons = run?.phase === 'meeting'
    ? `<button class="go" id="meet">Producer's Meeting</button>`
    : run
      ? `<button class="go" id="again">Run it again</button><button class="go alt" id="tomenu">Menu</button>`
      : `<button class="go" id="again">Run it again</button><button class="go alt" id="same">Same road</button><button class="go alt" id="tomenu">Menu</button>`;
  recapEl.innerHTML = `<div class="card">
    <div class="kicker">THE 11 O'CLOCK RECAP · WYF 6${segLabel}</div>
    <h2>${esc(last?.text ?? (cleared ? 'Giant Takes The Exit' : 'Suspect In Custody'))}</h2>
    <span class="outcome ${cleared ? 'cleared' : ''}">${run?.phase === 'won' ? 'FULL BROADCAST · SIGNED OFF' : cleared ? 'SIGNED OFF' : reason === 'pin' ? 'BUSTED · BOXED IN' : reason === 'ratings' ? 'BUSTED · CUT TO COMMERCIAL' : 'BUSTED · MISSED THE EXIT'}</span>
    ${best ? `<div class="best"><small>TONIGHT'S TOP STORY</small>${esc(best.text)}</div>` : ''}
    <div class="stats">
      <span>Peak audience <b>${viewers(sh.peak)}</b></span><span>Score banked <b>${Math.round(sh.banked).toLocaleString()}</b></span>
      <span>On air <b>${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}</b></span><span>Rampage time <b>${Math.round(sim.stats.timeAtTier[2])}s</b></span>
      <span>Things flattened <b>${sim.stats.smashes}</b></span><span>Police cars smashed <b>${runStats.units}</b></span>
      <span>Pursuers shaken <b>${runStats.lost}</b></span><span>Heat reached <b>${'★'.repeat(sh.heat)}</b></span>
      ${runStatsHtml}
      ${!run && lastBest ? `<span>Best score <b>${lastBest.bestBanked.toLocaleString()}</b></span><span>Signed off <b>${lastBest.signOffs} / ${lastBest.broadcasts}</b></span>` : ''}
    </div>
    <p class="anchor">${esc(anchorLine)}</p>
    <div class="row">${buttons}</div>
    <div class="padhint"></div>
  </div>`;
  recapEl.hidden = false;
  recapArmedAt = performance.now() + 250;
  const btn = (id: string) => document.getElementById(id) as HTMLButtonElement | null;
  if (btn('meet')) btn('meet')!.onclick = () => showMeeting();
  if (btn('again')) btn('again')!.onclick = () => restart(false);
  if (btn('same')) btn('same')!.onclick = () => restart(true);
  if (btn('tomenu')) btn('tomenu')!.onclick = () => recapToMenu();
  (recapEl.querySelector('.row button') as HTMLButtonElement).focus();
}

/** Recap buttons go through the shell's results flow (retry / menu). */
let restartFresh = false;
function restart(sameRoad: boolean) {
  if (!app) return;
  restartFresh = !sameRoad;
  app.flow.onActivate('results', 'retry');
}
function recapToMenu() {
  if (!app) return;
  enterAttract();
  app.flow.onActivate('results', 'menu');
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
      // Swat it off his line: out to whichever side of him it was on.
      const side = Math.sign(e.d - g.d) || (Math.random() < 0.5 ? -1 : 1);
      if (e.propId >= 1_000_000) {
        runStats.units++;
        units.smash(e.propId, dirX, dirZ, e.speed, side);
      }
      else highway.smash(e.propId, dirX, dirZ, e.speed, side);
      giant.onSmash(e.cls === 'heavy', side);
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
      audio.whoosh();
      break;
    case 'dodge': {
      runStats.nearMiss++;
      audio.whoosh();
      rig.jolt(I.dodge.shake, 0.1);
      haptic(I.dodge.haptic, I.dodge.hapticStrength);
      sim.track.posAt(e.s, e.d, pos);
      highway.ring(pos.x, pos.z, 3.5, 0xffffff, 0.35, 0.45);
      break;
    }
    case 'ratings':
      if (e.cause !== 'rampage' && e.cause !== 'pose' && e.delta > 0) gainPop(e.delta, e.cause);
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
    case 'ability':
      if (!e.ok) {
        audio.dud();
        if (e.id === 'hijack') abilityPop('No car in reach', true);
      }
      else if (e.id === 'leap') {
        audio.leap();
        rig.jolt(1.5, 0.1);
        rig.tierUpPulse(); // the chopper pulls out so the arc reads
      }
      abilEl.classList.remove('fire');
      void abilEl.offsetWidth;
      abilEl.classList.add('fire');
      break;
    case 'leapLand': {
      sim.track.posAt(e.s, e.d, pos);
      highway.ring(pos.x, pos.z, 11, 0xffffff, 0.55, 0.9);
      highway.ring(pos.x, pos.z, 6, PALETTE.dust, 0.7, 0.7);
      highway.crack(pos.x, pos.z, h);
      highway.spawnDebris(pos.x, pos.z, Math.cos(h), Math.sin(h), 4, 14, [PALETTE.dust, 0x8d8579], [0.15, 0.4], 1.5);
      audio.land();
      hitstop = Math.max(hitstop, TUNING.impact.heavy.hitstop);
      rig.jolt(TUNING.impact.heavy.shake * 1.3, TUNING.camera.joltTime);
      flash(TUNING.impact.heavy.flashFrames);
      haptic(160, 0.9);
      if (e.smashed) pip.trigger(sim, sim.show.tier);
      abilityPop(e.smashed ? `Flattened ×${e.smashed}` : 'Stuck the landing');
      break;
    }
    case 'stare': {
      audio.stare();
      for (const m of e.moved) highway.slide(m.id);
      sim.track.posAt(g.s + 10, g.d, pos);
      highway.ring(pos.x, pos.z, 9, 0xbfd6ff, 0.8, 0.35);
      glare(g.s, sim.track.laneCenter(g.lane));
      hitstop = Math.max(hitstop, TUNING.impact.heavy.hitstop);
      rig.jolt(2, 0.15);
      haptic(80, 0.5);
      abilityPop([e.moved.length ? `Road clears ×${e.moved.length}` : 'Road already clear', e.backedOff ? `Police back off ×${e.backedOff}` : ''].filter(Boolean).join(' · '));
      break;
    }
    case 'hijack': {
      audio.hijack();
      const p = sim.track.props.find((q) => q.id === e.propId);
      if (p) {
        highway.drop(e.propId); // the parked view goes: it's under him now
        rideMesh = highway.vehicleMesh(p);
        scene.add(rideMesh);
      }
      rig.jolt(2, 0.12);
      haptic(90, 0.6);
      abilityPop('Car commandeered');
      break;
    }
    case 'hijackBail': {
      if (rideMesh) {
        sim.track.posAt(e.s, e.d, pos);
        highway.spawnDebris(pos.x, pos.z, Math.cos(h), Math.sin(h), g.speed, 16, rideMesh.userData.colors ?? [0x888888], [0.2, 0.55], 1.2);
        scene.remove(rideMesh);
        rideMesh = null;
      }
      audio.smash('heavy');
      rig.jolt(TUNING.impact.heavy.shake, TUNING.camera.joltTime);
      flash(TUNING.impact.heavy.flashFrames);
      haptic(120, 0.8);
      break;
    }
    case 'pose':
      audio.pose();
      pip.trigger(sim, sim.show.tier, true);
      abilityPop(`Ratings +${Math.round(e.gain)} · Heat −${TUNING.abilities.pose.heatCost}`);
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

// --- Pause, focus, start (the SLU Web Shell owns the flow) ----------------------
/**
 * Behind the title and menus the bot runs a live broadcast ("attract"). Play loads a
 * level: a fresh broadcast with the player driving. Pause, settings, restart and quit
 * come from the shell; the game reacts through the renderer adapter below.
 */
let attract = false;
let nextSeed: number | null = flags.seedFixed ? flags.seed : null;

function setPaused(p: boolean) {
  if (!started || p === paused) return;
  paused = p;
  audio.setPaused(p);
  if (!p) menuGuard = 10; // §8 10f menu guard after any screen transition
}

function start() {
  started = true;
  paused = false;
  document.documentElement.classList.add('playing');
  try {
    audio.unlock(); // audio must never block the run from starting
  } catch (e) {
    console.warn('Audio unavailable:', e);
  }
  menuGuard = 10;
}

/** Shell "load level": a new broadcast with the player at the controls. */
function beginBroadcast(mode = 'broadcast') {
  attract = false;
  document.documentElement.classList.remove('attract');
  const seed = nextSeed ?? (Math.random() * 1e9) | 0;
  nextSeed = null;
  if (mode === 'run') {
    run = new RunState(seed);
    newRun(run.segmentSeed(), 0, []);
  } else {
    run = null;
    newRun(seed, Math.max(0, Math.min(TUNING.run.segments - 1, flags.seg ?? 0)), flags.ability ? [flags.ability] : []);
  }
  bot = flags.bot ? new Bot(sim) : null;
  start();
}

/** Back to the menus: the bot takes over a fresh broadcast behind them. */
function enterAttract() {
  attract = true;
  document.documentElement.classList.add('attract');
  run = null;
  // Behind the menus the bot shows off a random ability.
  const seed = (Math.random() * 1e9) | 0;
  newRun(seed, 0, [ABILITIES[seed % ABILITIES.length]]);
  bot = new Bot(sim);
  start();
  audio.setPaused(false);
}

input.onAnyInput = () => {
  try {
    audio.unlock();
  } catch {
    /* audio unavailable */
  }
};
/** Pause requests from the game (Esc/Start/II, focus loss, pad unplugged) go through the shell. */
function requestPause() {
  if (app && app.shell.session.phase === 'playing' && !attract && sim.live) app.flow.showPause();
}
input.onPadDisconnect = requestPause;
window.addEventListener('blur', requestPause); // §20 focus loss auto-pauses
document.addEventListener('visibilitychange', () => document.hidden && requestPause());

function applyDebug() {
  debugEl.hidden = !settings.debug;
}
applyDebug();
window.addEventListener('keydown', (e) => {
  if (e.code === 'Backquote' || e.code === 'F3') {
    settings.debug = !settings.debug;
    applyDebug();
    saveSettings(settings);
    e.preventDefault();
  }
  if (e.code === 'KeyT') tunePanel.toggle();
  if (!recapEl.hidden && (e.code === 'Enter' || e.code === 'Space')) {
    e.preventDefault();
    // The shell's accept action clicks the focused button; this only covers nothing being focused.
    const focused = document.activeElement;
    if (!(focused instanceof HTMLButtonElement && recapEl.contains(focused)) && recapArmed() && !e.repeat) (recapEl.querySelector('button:not([disabled])') as HTMLButtonElement | null)?.click();
    return;
  }
  const playing = started && !paused && !attract;
  if (e.code === 'KeyH' && playing) toggleHeadOn(); // dev: preview Head-On and the swoop home
  if (e.code === 'KeyC' && playing) setAngle(director.current + 1, director.side); // dev: next angle (held until C comes back to Chase High)
  if (e.code === 'KeyR' && playing) {
    nextSeed = flags.seedFixed ? flags.seed : null;
    beginBroadcast(run ? 'run' : 'broadcast');
  }
});

// The shell: title → main menu → mode select → broadcast → pause / settings → results.
const wyfAssembly = (shell: SLUWebShell<CoreSettings>): FrameAssembly => {
  const frame: GenreFrame = {
    id: 'arcade',
    label: 'Live Broadcast',
    menuFlow: [],
    modes: [
      { id: 'run', label: 'Full Broadcast', description: 'Five segments. Spend your ratings between them.', leaderboardKey: 'runScore' },
      { id: 'broadcast', label: 'Single Segment', description: 'Keep the ratings up. Take the exit before the chopper runs out of fuel.', leaderboardKey: 'banked' },
    ],
    statKeys: ['broadcasts', 'signOffs', 'bestBanked', 'bestPeak'],
    challengeCategories: [],
    recommendedModules: [],
  };
  return { id: 'wyf', frame, modules: [], install: () => shell.modes.register(frame.modes) };
};
const onOff = (b: boolean) => (b ? 'On' : 'Off');
const rendererAdapter: RendererAdapter = {
  id: 'wyf-three',
  loadLevel: (id) => beginBroadcast(id),
  unloadLevel: () => enterAttract(),
  suspend: () => setPaused(true),
  resume: () => setPaused(false),
  resize: () => resize(),
};
let app: Awaited<ReturnType<typeof createGameApp>> | null = null;
// --- Resize -------------------------------------------------------------------
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  rig.resize(w, h);
}
window.addEventListener('resize', resize);
resize();

enterAttract();
app = await createGameApp({
  gameId: 'warn-your-friends',
  gameName: 'Warn Your Friends',
  version: '0.2.0',
  renderer: rendererAdapter,
  root: $('ui'),
  assemblies: [(shell) => wyfAssembly(shell)],
  capabilities: { stageSelect: false, characterSelect: false, vehicleSelect: false, loadout: false, difficulty: false },
  mobileViewport: false,
  pwa: false,
  flow: {
    settingsExtension: {
      choices: () => [
        { id: 'wyf-cuts', label: `Camera Cuts: ${onOff(settings.cameraCuts)}`, description: 'Off holds the Chase High shot' },
        { id: 'wyf-livetime', label: `LIVE TIME: ${onOff(settings.liveTime)}`, description: 'Lighting follows your clock; off is always night' },
        { id: 'wyf-flashes', label: `Reduce Flashes: ${onOff(settings.reduceFlashes)}` },
        { id: 'wyf-debug', label: `Debug Overlay: ${onOff(settings.debug)}` },
      ],
      handle: (id) => {
        if (id === 'wyf-cuts') settings.cameraCuts = director.enabled = !settings.cameraCuts;
        else if (id === 'wyf-livetime') {
          settings.liveTime = !settings.liveTime;
          forcedLook = null;
          applyLook();
        } else if (id === 'wyf-flashes') settings.reduceFlashes = lighting.reduceFlashes = cruisers.reduceFlashes = units.reduceFlashes = !settings.reduceFlashes;
        else if (id === 'wyf-debug') {
          settings.debug = !settings.debug;
          applyDebug();
        } else return false;
        saveSettings(settings);
        return true;
      },
    },
  },
});
registerGlyphs(app.shell.production.glyphs);
// Only what exists: no challenges or credits yet; the tagline is approved fiction (§21).
app.ui.updateScreen('title', { subtitle: 'Giant At Large. Warn Your Friends.' });
app.ui.updateScreen('main-menu', { choices: [{ id: 'play', label: 'Play' }, { id: 'settings', label: 'Settings' }] });
// Core settings drive the game: reduced motion, shake, vibration, volume.
const applyCore = (c: CoreSettings) => {
  rig.reducedMotion = settings.reducedMotion = c.reducedMotion;
  rig.shakeScale = c.screenShake;
  hapticsOn = c.vibration;
  audio.setVolumes(c.muted ? 0 : c.masterVolume, c.musicVolume, c.sfxVolume);
};
if (settings.reducedMotion && !app.settings.get('reducedMotion')) await app.settings.patch({ reducedMotion: true }); // carry over the 0c setting
applyCore(app.settings.snapshot());
app.settings.events.on('changed', applyCore);
// Pause → Restart replays the same road; the recap's "Run it again" asks for a fresh one.
app.shell.events.on('game:restart', () => {
  nextSeed = restartFresh ? null : (run?.seed ?? sim.seed);
  restartFresh = false;
});
// Dev/test flags skip the menus straight into a broadcast.
if (flags.bot || flags.autostart) {
  app.flow.onActivate('title', 'start');
  app.flow.onActivate('mode-select', flags.mode);
}

// --- Loop -----------------------------------------------------------------------
const SIM_DT = 1 / TUNING.sim.hz;
let last = performance.now();

function frame(now: number) {
  requestAnimationFrame(frame);
  const realDt = Math.min(0.1, (now - last) / 1000);
  last = now;

  if (input.consumePause()) requestPause();
  touchUi.hidden = input.device !== 'touch' || attract || !sim.live;
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
      const human = input.sample(); // always drain edges, even while the bot drives
      let inp = bot ? bot.input() : human;
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
    // Phase 3: Leap arc, standing on the hijacked car's roof, the pose.
    const A = TUNING.abilities;
    const u = g.airDur > 0 && g.air > 0 ? 1 - g.air / g.airDur : 0;
    const roof = rideMesh ? (rideMesh.userData.roof as number) : 0;
    const lift = u > 0 ? 4 * A.leap.height * u * (1 - u) : roof;
    poseAnim += ((g.pose > 0 ? 1 : 0) - poseAnim) * Math.min(1, animDt / 0.08);
    giant.update(animDt, { x: t.x, z: t.z, heading, travel: t.travel, lateralVel, speed: g.speed, tier: g.tier, braking: g.braking, stumble: g.stumble, stepPos, lift, leap: u, pose: poseAnim }, gf);
    if (rideMesh) {
      rideMesh.position.set(t.x, 0, t.z);
      rideMesh.rotation.y = -heading;
    }
    // Pose: flash bulbs from the crowd and the press. A soft pulse, at most 3 a second (photosensitivity).
    bulbT = Math.max(0, bulbT - animDt);
    updateAbilityFx(animDt);
    if (g.pose > 0 && bulbT === 0 && !settings.reduceFlashes) {
      bulbT = 1 / 3;
      bulbFrames = 3;
    }
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
    if (attract) enterAttract(); // behind the menus: just roll another broadcast
    else {
      if (run) run.finishSegment(sim.show);
      if (run?.phase !== 'meeting') {
        app?.shell.session.setPhase('results');
        void recordStats();
      }
      showRecap();
    }
  }
  // Controller parity on the recap: left/right to move, A to choose.
  if (!recapEl.hidden && app) {
    const btns = ([...recapEl.querySelectorAll('button')] as HTMLButtonElement[]).filter((b) => !b.disabled);
    const i = Math.max(0, btns.indexOf(document.activeElement as HTMLButtonElement));
    if (app.shell.input.wasPressed('ui_right') || app.shell.input.wasPressed('ui_down')) btns[(i + 1) % btns.length].focus();
    if (app.shell.input.wasPressed('ui_left') || app.shell.input.wasPressed('ui_up')) btns[(i + btns.length - 1) % btns.length].focus();
    if (app.shell.input.wasPressed('ui_accept') && recapArmed() && document.activeElement instanceof HTMLButtonElement && btns.includes(document.activeElement)) document.activeElement.click();
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

  flashEl.style.opacity = flashFrames > 0 ? '0.85' : bulbFrames > 0 ? '0.18' : '0';
  if (bulbFrames > 0) bulbFrames--;
  if (flashFrames > 0) flashFrames--;
  camTagT = Math.max(0, camTagT - realDt);
  if (camTagT === 0) camTag.classList.remove('show');

  if (flags.posecam) {
    // Dev: side-on, chest height, 9m out on his right, tracking him (judge the run pose).
    const rx = -Math.sin(t.travel);
    const rz = Math.cos(t.travel);
    poseCam.aspect = rig.camera.aspect;
    poseCam.updateProjectionMatrix();
    poseCam.position.set(t.x + rx * 9 + Math.cos(t.travel) * 0.5, 2.0, t.z + rz * 9 + Math.sin(t.travel) * 0.5);
    poseCam.lookAt(t.x + Math.cos(t.travel) * 0.5, 1.5, t.z + Math.sin(t.travel) * 0.5);
    renderer.render(scene, poseCam);
  } else renderer.render(scene, rig.camera);
  pip.render(renderer, scene);
  updateHud(realDt);
  updateGlyphs();
}

/**
 * Button labels follow the device in use (PS4/PS5 pads show L1/R1/L2/✕). Shown on the ability
 * chip, on a controls strip for the first seconds of each segment, and under recap/meeting cards.
 */
let glyphFamily: InputDeviceFamily | null = null;
function glyph(action: GlyphAction): string {
  return app?.shell.production.glyphs.resolve(action, glyphFamily ?? 'keyboard-mouse')?.label ?? '';
}
function updateGlyphs() {
  if (!app) return;
  const fam: InputDeviceFamily = input.device === 'gamepad' ? padFamily(input.padId) : input.device === 'touch' ? 'touch' : 'keyboard-mouse';
  if (fam !== glyphFamily) {
    glyphFamily = fam;
    app.shell.production.glyphs.setFamily(fam);
    abilKey.textContent = glyph('ability');
    const key = (a: GlyphAction, what: string) => `<span><kbd>${esc(glyph(a))}</kbd>${what}</span>`;
    controlsEl.innerHTML = fam === 'touch'
      ? `<span>Swipe to change lanes · hold down to brake</span>`
      : key('lanes', 'Lane') + key('brake', 'Brake') + key('shoulder', 'Shoulder') + key('pause', 'Pause');
    recapEl.dataset.fam = '';
  }
  controlsEl.hidden = attract || !sim.live || sim.time > TUNING.input.controlsHintTime;
  const hint = recapEl.querySelector<HTMLElement>('.padhint');
  if (hint && recapEl.dataset.fam !== fam) {
    recapEl.dataset.fam = fam;
    hint.innerHTML = fam === 'touch' ? '' : `<kbd>${esc(glyph('move'))}</kbd> Move <kbd>${esc(glyph('accept'))}</kbd> Choose`;
  }
}

/** Render one frame now and measure the giant's silhouette (E2E / evidence). */
function silhouette() {
  renderer.render(scene, rig.camera);
  return measureSilhouette(renderer, scene, rig.camera, giant.bodyObjects, rig.angle.name === TUNING.camera.angles[TUNING.camera.homeAngle].name ? 48 : 40);
}

let lastRatings = 0;
const poseCam = new THREE.PerspectiveCamera(40, 16 / 9, 0.5, 500);

/** Persist the bests (shell storage, per game id). */
async function recordStats() {
  if (!app) return;
  const st = app.storage;
  const sh = sim.show;
  const best = (await st.get<Stats>('wyf.stats')) ?? { broadcasts: 0, signOffs: 0, bestBanked: 0, bestPeak: 0 };
  best.broadcasts++;
  if (sh.state === 'cleared') best.signOffs++;
  best.bestBanked = Math.max(best.bestBanked, Math.round(sh.banked));
  best.bestPeak = Math.max(best.bestPeak, sh.peak);
  if (run) {
    best.runs = (best.runs ?? 0) + 1;
    if (run.phase === 'won') best.runsWon = (best.runsWon ?? 0) + 1;
    best.bestRun = Math.max(best.bestRun ?? 0, Math.round(run.earned));
  }
  await st.set('wyf.stats', best);
  lastBest = best;
}
/** Stored bests. Phase 3 fields are optional so older saves load unchanged. */
type Stats = { broadcasts: number; signOffs: number; bestBanked: number; bestPeak: number; runs?: number; runsWon?: number; bestRun?: number };
let lastBest: Stats | null = null;
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
  const viewers = Math.round(sh.ratings * VIEWERS_PER_POINT);
  viewersEl.textContent = viewers >= 1e6 ? `${(viewers / 1e6).toFixed(2)}M` : `${Math.round(viewers / 1000)}K`;
  ratingsBar.style.width = `${sh.ratings.toFixed(1)}%`;
  for (let k = 1; k <= 3; k++) ratingsEl.classList.toggle(`t${k}`, sh.tier === k);
  ratingsEl.classList.toggle('danger', sh.ratings < 8 && sim.live);
  const falling = sim.live && sh.ratings < lastRatings - 1e-6;
  trendEl.textContent = falling ? '▼' : '';
  lastRatings = sh.ratings;
  heatStars.forEach((el, i) => el.classList.toggle('on', i < sh.heat));
  // Phase 3: segment number and the ability chip (cooldown fills back up).
  segEl.hidden = !run;
  if (run) segEl.textContent = `${run.segment + 1}/${TUNING.run.segments}`;
  const ab = sim.ability;
  abilEl.hidden = !ab || attract;
  abilBtn.disabled = !ab;
  if (ab) {
    const A = TUNING.abilities[ab];
    const label = TUNING.upgrades[ab].label;
    if (abilName.textContent !== label) {
      abilName.textContent = label;
      abilBtn.textContent = label.split(' ')[0].toUpperCase().slice(0, 5);
      abilBtn.setAttribute('aria-label', label);
    }
    const ready = g.abilityCd <= 0;
    abilCd.style.width = `${((1 - g.abilityCd / A.cooldown) * 100).toFixed(1)}%`;
    abilEl.classList.toggle('ready', ready);
    abilBtn.classList.toggle('ready', ready);
  }
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
  /** A player broadcast is running (not the attract loop behind the menus). */
  get started() {
    return started && !attract;
  },
  get attract() {
    return attract;
  },
  get phase() {
    return app?.shell.session.phase;
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
  /** Dev: leave (or enter) step mode, e.g. to fast-forward to an event and then watch it in slow motion. */
  setStepMode(v: boolean) {
    flags.stepMode = v;
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
    return { worstSlide: worst, plants, cadence: measure.cadence.map((c) => ({ ...c })), band: [TUNING.gait.cadenceMin, TUNING.gait.cadenceMax] };
  },
  state() {
    const g = sim.giant;
    return { time: sim.time, tick: sim.tick, s: g.s, d: g.d, lane: g.lane, lanes: sim.track.lanesAt(g.s), laneBusy: sim.laneBusy, speed: g.speed, tier: g.tier, stats: sim.stats, fps: perf.fps };
  },
  events: recentEvents,
  /** Phase 3: the run (null in a single broadcast). */
  run: () => (run ? { segment: run.segment, phase: run.phase, purse: run.purse, earned: run.earned, owned: [...run.owned], offers: run.phase === 'meeting' ? run.offers() : [], results: run.results.slice() } : null),
  meeting: () => (recapEl.querySelector('.meeting') ? [...recapEl.querySelectorAll<HTMLButtonElement>('.pitch')].map((b) => ({ id: b.dataset.id, disabled: b.disabled })) : null),
  ability: () => ({ id: sim.ability, cd: sim.giant.abilityCd, air: sim.giant.air, ride: sim.giant.ride, pose: sim.giant.pose, chip: !abilEl.hidden }),
};
