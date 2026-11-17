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
import { measureSilhouette } from './render/silhouette';
import { Newsroom, compass, type Headline } from './broadcast/headlines';
import type { PropKind } from './sim/types';
import { Gait } from './anim/gait';
import { Audio } from './audio';
import { DEFAULT_KEYS, Input, KEY_ACTIONS, RESERVED_KEYS, keyLabel, type KeyAction } from './input';
import { registerGlyphs, padFamily, type GlyphAction } from './glyphs';
import coverUrl from './assets/title-cover.webp';
import { UPGRADE_ART } from './upgradeArt';
import { PlayLog, appendLog, exportLog, type PlayEntry } from './playlog';
import { readFlags } from './debug';
import { encodeInputs, type Submission } from './leaderboard/verify';
import { mountBoard } from './leaderboardClient';
import { Onboarding, type PromptId } from './onboarding';
import { GAME_SPEEDS, HUD_SIZES, loadSettings, saveSettings } from './settings';
import { applyStoredTuning, mountTuningPanel, tuningChanged } from './tuningPanel';
import { createGameApp, type InputDeviceFamily, type CoreSettings, type FrameAssembly, type GenreFrame, type RendererAdapter, type SLUWebShell } from '@slu/web-shell';

applyStoredTuning();

const flags = readFlags(location.search);
const settings = loadSettings();
/** HUD colours: one layout, two palettes (CSS variables keyed off html[data-palette]). */
function applyHudColors() {
  document.documentElement.dataset.palette = settings.hudColors;
}
applyHudColors();
if (flags.reducedMotion !== null) settings.reducedMotion = flags.reducedMotion;
if (flags.reduceFlashes !== null) settings.reduceFlashes = flags.reduceFlashes;
if (flags.debug !== null) settings.debug = flags.debug;
if (flags.cuts !== null) settings.cameraCuts = flags.cuts;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('view');
const flashEl = $('flash');
const debugEl = $('debug');
const tierbar = $('tierbar');
const chyPlace = document.querySelector('#chyron .place') as HTMLElement;
const gearsEl = $('gears');
const asksEl = $('asks');
/** Sim time the asks panel shows until (set when an ask lands; the segment intro shows it too). */
let asksUntil = 0;
const asksList = asksEl.querySelector('ol') as HTMLElement;
/** Draw the producer's asks (on a new broadcast and whenever one moves). */
function renderAsks() {
  asksList.replaceChildren(
    ...sim.asks.list.map((a) => {
      const li = document.createElement('li');
      li.className = a.done ? 'done' : a.failed ? 'failed' : '';
      li.dataset.id = a.id;
      const txt = document.createElement('span');
      txt.textContent = a.text;
      const pr = document.createElement('b');
      pr.textContent = a.done ? '✓' : a.failed ? '✕' : a.n > 1 ? `${a.progress}/${a.n}` : '';
      li.append(txt, pr);
      return li;
    }),
  );
}
const chainEl = $('chain');
const chainMult = chainEl.querySelector('.mult') as HTMLElement;
const chainStunt = chainEl.querySelector('.stunt') as HTMLElement;
const chainPts = chainEl.querySelector('.pts') as HTMLElement;
const chainCnt = chainEl.querySelector('.cnt') as HTMLElement;
const chainClock = chainEl.querySelector('.clock i') as HTMLElement;
/** Spectacle stunt names on the combo counter (what just counted, so the player learns the menu). */
const STUNT_LABEL: Record<string, string> = { medium: 'SMASH', heavy: 'HEAVY SMASH', unit: 'POLICE CAR', policeCrash: 'POLICE CRASH', collateral: 'COLLATERAL', nearMiss: 'NEAR MISS', ramDodge: 'DODGED', lostTrack: 'SHOOK ONE', chopperShaken: 'LOST THE CHOPPER', leapLand: 'LANDING', hijackBail: 'BAIL OUT', pose: 'POSE' };
let chainResultT = 0;
const gearPips = [...gearsEl.querySelectorAll('i')] as HTMLElement[];
const gearName = gearsEl.querySelector('.nm') as HTMLElement;
const gearMultEl = gearsEl.querySelector('.x') as HTMLElement;
/** A shockwave waits for the first footfall after a gear-up (it lands with his foot). */
let gearShockPending = false;
const tierName = tierbar.querySelector('.name') as HTMLElement;
const tierMeter = tierbar.querySelector('.meter i') as HTMLElement;
const touchUi = $('touch-ui');
const camTag = $('camtag');
const clockEl = $('clock');
const chyKicker = document.querySelector('#chyron .kicker') as HTMLElement;
const chyText = document.querySelector('#chyron .text') as HTMLElement;
const scoreEl = $('score');
const ratingsEl = $('ratings');
const ratingsBar = $('ratingsbar');
const heatStars = [...document.querySelectorAll('#heat em')] as HTMLElement[];
const signoffEl = $('signoff');
/** Police Net: the BOXED IN meter (the Pin meter, shown while it fills), with the ways out for this device. */
const boxedEl = $('boxed');
const boxedFill = boxedEl.querySelector('u') as HTMLElement;
const boxedHow = boxedEl.querySelector('.how') as HTMLElement;
let boxedFam = '';
const exitDistEl = $('exitdist');
const signoffArrow = signoffEl.querySelector('.arrow') as HTMLElement;
const segEl = $('segno');
const abilEl = $('abil');
const abilName = abilEl.querySelector('.nm') as HTMLElement;
const abilIcon = abilEl.querySelector('.ic') as HTMLImageElement;
const abilKey = abilEl.querySelector('.key') as HTMLElement;
const abilCd = abilEl.querySelector('.cd i') as HTMLElement;
const abilBtn = $<HTMLButtonElement>('btn-ability');
const controlsEl = $('controls');

// --- Renderer ---------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
/**
 * Giant size (TUNING.growth): the giant is posed in his own space (the gait runs there: positions, speed
 * and stride divided by `gScale`), so planted feet stay pinned in the world and the step rate holds.
 * GiantView poses its parts with world-space maths (IK, cape), so its parts sit in the scene unparented and
 * unscaled while it updates; afterwards each top-level part is mapped to the world (anchor + scale × pose),
 * and that is undone before the next update. A uniform scale commutes with the rotations, so every pose
 * calculation stays consistent. When the scale changes, the anchor moves so his centre stays put.
 */
const giantSpace = scene; // his parts live in the scene unparented; `placeGiant` maps them to the world
let gPosed: { o: THREE.Object3D; p: THREE.Vector3; s: THREE.Vector3 }[] | null = null;
/** Undo the world mapping: back to his own space for the next pose. */
function unplaceGiant() {
  if (gPosed) for (const { o, p, s } of gPosed) o.position.copy(p), o.scale.copy(s);
  gPosed = null;
}
/** Map his posed parts to the world: anchor + scale × pose. */
function placeGiant() {
  unplaceGiant();
  if (gScale === 1 && gAnchor.x === 0 && gAnchor.z === 0) return;
  gPosed = giant.objects.map((o) => ({ o, p: o.position.clone(), s: o.scale.clone() }));
  for (const o of giant.objects) {
    o.position.set(gAnchor.x + o.position.x * gScale, o.position.y * gScale, gAnchor.z + o.position.z * gScale);
    o.scale.multiplyScalar(gScale);
  }
}
let gScale = 1;
const gAnchor = { x: 0, z: 0 };
// Committed size (Mike, 2026-11-15): 1.3× always; ?size=fixed compares the old 3.6m giant.
const sizeMode = () => flags.size ?? 'growth';
/** The size mode this broadcast started with: look and hit-box change together, from the next broadcast. */
let runSize: 'growth' | 'fixed' | 'big' = 'growth';
const sizeFor = (tier: number) => (runSize === 'growth' ? TUNING.growth.scale[tier] : runSize === 'big' ? TUNING.growth.big : 1);
/** World → giant space (and back) for one point. */
const toGiant = (x: number, z: number) => ({ x: (x - gAnchor.x) / gScale, z: (z - gAnchor.z) / gScale });
const fromGiant = (x: number, z: number) => ({ x: gAnchor.x + x * gScale, z: gAnchor.z + z * gScale });
function setGiantScale(k: number, cx: number, cz: number) {
  if (k === gScale) return;
  const l = toGiant(cx, cz);
  gScale = k;
  gAnchor.x = cx - l.x * k;
  gAnchor.z = cz - l.z * k;
}
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
/** Seconds of (unpaused, time-scaled) play since the broadcast ended; -1 while it's on. */
let endedFor = -1;
let recapShown = false;
/**
 * Sign-off outro (Mike, 2026-11-16: he ran "through the grass, not on the road"): after the exit the sim runs him
 * straight on, so he's drawn along the ramp's centreline instead (presentation only), while the chopper swivels into
 * Head-On; then the recap cuts in.
 */
let outro: { seg: ReturnType<Sim['track']['segmentAt']> } | null = null;
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
const runStats = { heavy: 0, units: 0, crashes: 0, bestChain: 0, lost: 0, dodged: 0, nearMiss: 0, best: null as Headline | null, bestRatings: -1 };
let news: Newsroom;
/** Prop kinds by id, recorded when a smash/bounce happens (the prop may be pruned before the headline). */
const propKinds = new Map<number, PropKind>();
/** Every cut this run, for E2E: sim time, reason, angle. */
const cutLog: { t: number; reason: CutDecision['reason']; index: number; laneBusy: boolean }[] = [];
const triggerLog: { t: number; kind: string }[] = [];
let bot: Bot | null = null;
const audio = new Audio();
const input = new Input(canvas, $('btn-shoulder'), $('btn-pause'), $('btn-ability'));
/** Accessibility settings into the input layer: rebound keys and the brake toggle. */
function applyControls() {
  input.keymap = settings.keys ? (Object.fromEntries(KEY_ACTIONS.map((a) => [a, [settings.keys![a]]])) as Record<KeyAction, string[]>) : { ...DEFAULT_KEYS };
  input.brakeToggle = settings.brakeToggle;
  glyphFamily = null; // redraw the on-screen key labels
}
applyControls();
/** One-time control prompts at the moment they matter (onboarding, 2026-11-17). */
const onboarding = new Onboarding($('prompt'), (id: PromptId) => {
  const k = (a: GlyphAction) => (glyph(a) ? `<kbd>${esc(glyph(a))}</kbd>` : '');
  const ab = sim.ability ? TUNING.upgrades[sim.ability] : null;
  const lines: Record<PromptId, string> = {
    blocked: `Too big to smash at this gear. Change lanes ${k('lanes')}`,
    gear: `Run clean to gear up. Hits and ${k('brake')} cost a gear`,
    ram: `Police swerving in: dodge ${k('lanes')} or ${k('shoulder')} into it`,
    rampage: `<b>RAMPAGE</b> Smash anything but bulldozers and armored trucks`,
    audience: `Audience dropping: smash something`,
    kite: `Steer the police car beside you into what's ahead of it`,
    boxed: `Boxed in: ${k('shoulder')} a car beside you, or ${k('brake')} and drop out the back`,
    caught: `Police on your tail: let go of ${k('brake')} and run`,
    exit: `Exit open: get to the far-right lane`,
    ability: ab ? `<b>${esc(ab.label.toUpperCase())}</b> ${k('ability')} ${esc(ab.blurb)}` : '',
  };
  return lines[id];
});
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
/** Playtest export: this broadcast's numbers (the replay never feeds it). */
const playLog = new PlayLog();
let lastEntry: PlayEntry | null = null;
// Recap REPLAY state (declared up here: newRun runs at boot). See startReplay below.
let simOpts: { seed: number; segment: number; upgrades: UpgradeId[]; growth: boolean } = { seed: 0, segment: 0, upgrades: [], growth: false };
const inputLog: SimInput[] = [];
/** Leaderboard: this broadcast's (or run's) seed, each segment's inputs and the meeting buys, for the server to re-play. */
let lb: { mode: 'run' | 'broadcast'; seed: number; segments: string[]; buys: (UpgradeId | null)[] } = { mode: 'broadcast', seed: 0, segments: [], buys: [] };
/** Why this browser's scores can't go on the board (a setting that changes the sim), or null. */
const lbBlocked = () =>
  flags.bot || flags.seg !== null || flags.ability || flags.heat !== null || flags.nodecay || flags.god || (flags.size !== null && flags.size !== 'growth') || tuningChanged()
    ? 'Debug or tuning settings are on, so this score stays off the board.'
    : settings.gameSpeed < 1
      ? 'Game Speed is below 100%, so this score stays off the board.'
      : null;
let moment: { t: number; score: number; kind: string; event: SimEvent; headline: Headline | null } | null = null;
let replayRate = 1;
const replayEl = $('replay');
type Parked = { sim: Sim; highway: HighwayView; gait: Gait; cruisers: CruiserView; units: UnitViews; director: Director; news: Newsroom; bot: Bot | null; rideMesh: THREE.Group | null; prev: typeof prev; runStats: typeof runStats; propKinds: Map<number, PropKind>; recent: SimEvent[] };
let replay: { sim: Sim; live: Parked; slowFrom: number; slowTo: number; end: number; armedAt: number; done: () => void; grab?: boolean } | null = null;

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

/** World position of a track point, for the spatial mix (a fresh object: audio keeps nothing). */
const where = (s: number, d: number) => sim.track.posAt(s, d, { x: 0, z: 0 });
const sirenRight = new THREE.Vector3();

function newRun(seed: number, segment = 0, upgrades: UpgradeId[] = []) {
  if (replay) {
    // A new broadcast mid-replay: drop the replay (its views go below) and the parked live ones.
    replay = null;
    replayRate = 1;
    document.documentElement.classList.remove('replay');
    replayEl.hidden = true;
  }
  if (highway) scene.remove(highway.group);
  if (giant) {
    unplaceGiant();
    for (const o of giant.objects) giantSpace.remove(o);
  }
  if (cruisers) scene.remove(cruisers.group);
  if (units) scene.remove(units.group);
  if (rideMesh) scene.remove(rideMesh);
  rideMesh = null;
  poseAnim = 0;
  endedFor = -1;
  recapShown = false;
  outro = null;
  document.documentElement.classList.remove('ended');
  hideRecap();
  coverage.reset();
  pip.reset();
  Object.assign(runStats, { heavy: 0, units: 0, crashes: 0, bestChain: 0, lost: 0, dodged: 0, nearMiss: 0, best: null, bestRatings: -1 });
  $('coldts').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  runSize = sizeMode();
  const growth = runSize === 'growth';
  sim = new Sim({ seed, segment, upgrades, growth });
  simOpts = { seed, segment, upgrades: [...upgrades], growth };
  // A fresh giant space for the new road: no anchor carried over, his starting size outright.
  gScale = sizeFor(0);
  gAnchor.x = gAnchor.z = 0;
  rig.giantScale = gScale;
  playLog.reset();
  inputLog.length = 0;
  input.resetLatches();
  audio.setGear(0, true);
  moment = null;
  recapShot = null;
  dropClip();
  highway = new HighwayView(sim);
  highway.onHonk = (v, at) => audio.honk(v, at);
  highway.onBrush = (at) => audio.scrape(at);
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
  renderAsks();
  asksUntil = 0;
  scene.add(highway.group, cruisers.group, units.group);
  giantSpace.add(...giant.objects);
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
  // How to Play lives in this overlay: a broadcast rolling over behind the menus must not close it.
  if (briefingClose) return;
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

/** One primary number (2026-11-16): Ratings gains no longer pop as "+K"; the audience bar flashes instead. */
function gainFlash() {
  if (attract) return;
  ratingsEl.classList.remove('gain');
  void ratingsEl.offsetWidth;
  ratingsEl.classList.add('gain');
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
}

/** A new recap/meeting card ignores accept for a moment: one press must not open it and choose on it. */
let recapArmedAt = 0;
const recapArmed = () => performance.now() >= recapArmedAt;
const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Phase 3 (§4, §17): the Producer's Meeting. Three pitches paid from the purse, or skip. */
/**
 * How to Play (Mike, 2026-11-15: "onboarding might be necessary for some"). Five lines, button
 * labels for the device in use. Shown once before the first broadcast, and from the main menu
 * and Settings. Uses the recap overlay (its controller and Enter handling come along); the shell's
 * menu is parked on its empty gameplay screen while it's open so its input can't fire behind it.
 */
const BRIEF_KEY = 'gal.briefing.seen.v1';
let briefingClose: (() => void) | null = null;
function briefingSeen(): boolean {
  try {
    return localStorage.getItem(BRIEF_KEY) === '1';
  } catch {
    return false;
  }
}
function openBriefing(goLive: boolean): Promise<void> {
  try {
    localStorage.setItem(BRIEF_KEY, '1');
  } catch {
    /* storage unavailable: it shows again next time */
  }
  app?.ui.show('gameplay-placeholder');
  const k = (a: GlyphAction) => (glyph(a) ? `<kbd>${esc(glyph(a))}</kbd>` : '');
  const at = TUNING.segment.exitOpensAt;
  const clock = `${Math.floor(at / 60)}:${String(at % 60).padStart(2, '0')}`;
  recapEl.innerHTML = `<div class="card briefing">
    <div class="kicker">HOW TO PLAY</div>
    <ol class="steps">
      <li><b>Run.</b> He never stops. ${k('lanes')} change lanes, ${k('brake')} brake.</li>
      <li><b>Gear up.</b> Hold top speed to shift: Jog, Stride, Rampage. Each gear is bigger and smashes bigger things. Bulldozers and armored trucks never break: go round.</li>
      <li><b>Keep Rampage.</b> A police car swerving in, a spike strip or anything too big to smash knocks you down a gear. Dodge the swerve, or ${k('shoulder')} shoulder-check into it.</li>
      <li><b>Keep them watching.</b> Smashes, close calls and combos fill the audience bar. Empty, they cut to commercial.</li>
      <li><b>Lose the police.</b> Run a car beside you into whatever is in its lane. Slow down and they catch you: busted. Boxed in by the armored truck, ${k('shoulder')} a car beside you or brake out the back; the second box-in is the end.</li>
      <li><b>Take the exit.</b> At ${clock} a ramp opens on the right. Be in the far-right lane when you reach it; miss it and coverage ends.</li>
    </ol>
    <div class="row"><button class="go" id="brief-go">${goLive ? 'Go live' : 'Back'}</button></div>
  </div>`;
  recapEl.hidden = false;
  recapArmedAt = performance.now() + 250;
  document.documentElement.classList.add('briefing');
  return new Promise((resolve) => {
    briefingClose = () => {
      briefingClose = null;
      document.documentElement.classList.remove('briefing');
      hideRecap();
      resolve();
    };
    $<HTMLButtonElement>('brief-go').onclick = () => briefingClose?.();
    $<HTMLButtonElement>('brief-go').focus();
  });
}

/** Settings → Controls: rebind the keyboard (accessibility, 2026-11-17). One key per action; a key taken by another action swaps. */
function openControls(): Promise<void> {
  const NAMES: Record<KeyAction, string> = { left: 'Lane left', right: 'Lane right', brake: 'Brake', shoulder: 'Shoulder Check', ability: 'Ability' };
  const current = (): Record<KeyAction, string> => settings.keys ?? (Object.fromEntries(KEY_ACTIONS.map((a) => [a, DEFAULT_KEYS[a][0]])) as Record<KeyAction, string>);
  let waiting: KeyAction | null = null;
  const draw = () => {
    const K = current();
    recapEl.innerHTML = `<div class="card briefing controls">
      <div class="kicker">CONTROLS · KEYBOARD</div>
      <ul class="binds">${KEY_ACTIONS.map((a) => `<li><span>${NAMES[a]}</span><button class="go alt bind" data-a="${a}">${waiting === a ? 'Press a key…' : `<kbd>${esc(keyLabel(K[a]))}</kbd>`}</button></li>`).join('')}</ul>
      <p class="how">${settings.keys ? 'Arrow keys no longer double as lanes once you rebind.' : 'Defaults also take the arrow keys, S / Space for Brake, W for Shoulder Check and Q for Ability.'} Pause stays on Esc or P. Pads and touch keep their own controls.</p>
      <div class="row"><button class="go" id="ctl-back">Back</button><button class="go alt" id="ctl-reset">Reset</button></div>
    </div>`;
    for (const b of recapEl.querySelectorAll<HTMLButtonElement>('.bind'))
      b.onclick = () => {
        waiting = b.dataset.a as KeyAction;
        input.capturing = true;
        draw();
        recapEl.querySelector<HTMLButtonElement>(`.bind[data-a="${waiting}"]`)?.focus();
      };
    $<HTMLButtonElement>('ctl-reset').onclick = () => {
      settings.keys = null;
      saveSettings(settings);
      applyControls();
      draw();
      $<HTMLButtonElement>('ctl-reset').focus();
    };
    $<HTMLButtonElement>('ctl-back').onclick = () => close?.();
  };
  // Capture before the shell and the game see the key (window, capture phase).
  const onKey = (e: KeyboardEvent) => {
    if (!waiting) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.code === 'Escape') {
      waiting = null;
    } else if (!RESERVED_KEYS.includes(e.code)) {
      const K = { ...current() };
      const other = KEY_ACTIONS.find((a) => a !== waiting && K[a] === e.code);
      if (other) K[other] = K[waiting]; // the key was taken: they swap
      K[waiting] = e.code;
      settings.keys = K;
      saveSettings(settings);
      applyControls();
      const was = waiting;
      waiting = null;
      draw();
      recapEl.querySelector<HTMLButtonElement>(`.bind[data-a="${was}"]`)?.focus();
      setTimeout(() => (input.capturing = false), 0);
      return;
    } else return; // reserved: keep waiting
    setTimeout(() => (input.capturing = false), 0);
    draw();
  };
  window.addEventListener('keydown', onKey, { capture: true });
  app?.ui.show('gameplay-placeholder');
  recapEl.hidden = false;
  recapArmedAt = performance.now() + 250;
  document.documentElement.classList.add('briefing');
  let close: (() => void) | null = null;
  draw();
  $<HTMLButtonElement>('ctl-back').focus();
  return new Promise((resolve) => {
    close = briefingClose = () => {
      briefingClose = null;
      waiting = null;
      input.capturing = false;
      window.removeEventListener('keydown', onKey, { capture: true });
      document.documentElement.classList.remove('briefing');
      hideRecap();
      resolve();
    };
  });
}

function showMeeting() {
  if (!run) return;
  const r = run;
  const offers = r.offers();
  const held = r.ability;
  recapEl.innerHTML = `<div class="card meeting">
    <div class="kicker">PRODUCER'S MEETING · BEFORE SEGMENT ${r.segment + 2} OF ${TUNING.run.segments}</div>
    <div class="purse">Budget <b>${r.purse.toLocaleString()}</b></div>
    <p class="how">Your stunts pay for these. Spending never lowers your score.</p>
    <div class="pitches">${offers
      .map((id) => {
        const u = TUNING.upgrades[id];
        const swap = u.kind === 'ability' && held ? `<small class="swap">Replaces ${esc(TUNING.upgrades[held].label)}</small>` : '';
        return `<button class="pitch ${u.kind}" data-id="${id}" ${r.canAfford(id) ? '' : 'disabled'}>
          <span class="art"><img src="${UPGRADE_ART[id]}" alt="" /><span class="tag">${u.kind === 'ability' ? 'ABILITY' : 'PASSIVE'}</span></span>
          <b>${esc(u.label)}</b><q class="said">${esc(u.pitch)}</q><span class="blurb">${esc(u.blurb)}</span>${swap}<span class="price">${u.price.toLocaleString()}</span>${r.canAfford(id) ? '' : `<small class="need">Need ${(u.price - r.purse).toLocaleString()} more</small>`}</button>`;
      })
      .join('')}</div>
    <div class="row"><button class="go alt" id="skip">Skip</button></div>
    <div class="padhint"></div>
  </div>`;
  recapArmedAt = performance.now() + 250;
  for (const b of recapEl.querySelectorAll<HTMLButtonElement>('.pitch')) b.onclick = () => r.buy(b.dataset.id as UpgradeId) && (lb.buys.push(b.dataset.id as UpgradeId), nextSegment());
  ($('skip') as HTMLButtonElement).onclick = () => r.nextSegment() && (lb.buys.push(null), nextSegment());
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
  audio.setGear(0, true); // a replay may have raised it
  const sh = sim.show;
  const cleared = sh.state === 'cleared';
  const reason = cleared ? 'cleared' : (sh.reason ?? 'ratings');
  const VIEWERS_PER_POINT = TUNING.show.viewersPerPoint;
  const viewers = (r: number) => (r * VIEWERS_PER_POINT >= 1e6 ? `${((r * VIEWERS_PER_POINT) / 1e6).toFixed(2)}M` : `${Math.round((r * VIEWERS_PER_POINT) / 1000)}K`);
  const N = TUNING.run.segments;
  const n = (x: number) => Math.round(x).toLocaleString();
  // The outcome stamp, and the plain-language why under it.
  const won = run?.phase === 'won';
  const stamp = won ? 'FULL BROADCAST' : cleared ? 'SIGNED OFF' : 'BUSTED';
  const why = won ? 'Every segment, start to finish.' : cleared ? 'He took the exit. Coverage complete.' : reason === 'pin' ? (sim.show.pinCause === 'caught' ? 'The police caught up.' : 'Boxed in by the police.') : reason === 'ratings' ? 'The viewers changed the channel.' : 'He missed the exit.';
  // Hero numbers: what this screen is about. A run segment reports the budget; a finished run, the run.
  const hero = run && run.phase === 'meeting'
    ? Math.round(sh.banked) === run.purse ? [['Budget', n(run.purse), 'score']] : [['Added to budget', `+${n(sh.banked)}`, 'score'], ['Budget', n(run.purse), '']]
    : run
      ? [['Run score', n(run.earned), 'score'], ['Segments cleared', `${run.results.filter((x) => x.cleared).length}<small>/${N}</small>`, '']]
      : [['Score', n(sh.banked), 'score'], ['Peak audience', viewers(sh.peak), '']];
  const tiles: [string, string][] = [
    ['Longest combo', String(runStats.bestChain)],
    // Everything he smashed (police cars he flattened included) plus the police he led into a wreck (Mike, 2026-11-17).
    ['Objects flattened', String(sim.stats.smashes + runStats.crashes)],
  ];
  if (run) tiles.splice(1, 0, ['Peak audience', viewers(sh.peak)]);
  const asks = sim.asks.list;
  // The broadcast (or the whole run) is over: its score can go on the board.
  const over = !run || run.phase === 'won' || run.phase === 'lost';
  const viewer = coverage.recapComment(sh.tier);
  if (!recapShot) {
    renderer.render(scene, rig.camera);
    grabShot();
  }
  // Tonight's top moment: the replay as a looping clip once its recording is ready (the still until then, or for good
  // where the browser can't record a canvas); the last shot when there was no replay.
  const shot = recapShot
    ? `<figure class="rc-shot"><img src="${recapShot}" alt="" /><span class="tag">${recapShotFromReplay ? 'REPLAY' : 'LAST SHOT'}</span></figure>`
    : '';
  const buttons = run?.phase === 'meeting'
    ? `<button class="go" id="meet">Producer's Meeting</button>`
    : run
      ? `<button class="go" id="again">Run Again</button><button class="go alt" id="tomenu">Menu</button>`
      : `<button class="go" id="again">Run Again</button><button class="go alt" id="tomenu">Menu</button>`; // same road: Pause → Restart
  recapEl.innerHTML = `<div class="rc ${cleared || won ? 'cleared' : 'busted'}">
    ${run ? `<header class="rc-top"><div class="kicker">SEGMENT ${run.segment + 1} OF ${N}</div></header>` : ''}
    <section class="rc-lead">
      <div class="rc-stamp"><span class="outcome ${cleared || won ? 'cleared' : ''}">${stamp}</span><span class="why">${why}</span></div>
      <div class="rc-hero">${hero.map(([k, v, c]) => `<div class="${c}"><small>${k}</small><b>${v}</b></div>`).join('')}</div>
      <div class="rc-tiles">${tiles.map(([k, v]) => `<div><b>${v}</b><small>${k}</small></div>`).join('')}</div>
    </section>
    <aside class="rc-side">
      ${shot}
      ${asks.length ? `<div class="rc-asks"><div class="hd">Producer's asks <span>${asks.filter((a) => a.done).length}/${asks.length}</span></div><ul>${asks.map((a) => `<li class="${a.done ? 'done' : ''}"><i>${a.done ? '✓' : ''}</i><span>${esc(a.text)}</span>${a.done ? `<b>+${n(a.reward)}</b>` : ''}</li>`).join('')}</ul></div>` : ''}
      ${over ? '<div class="rc-board" hidden></div>' : ''}
      <blockquote class="anchor">“${esc(viewer.text)}”${viewer.who ? `<cite>${esc(viewer.who)}</cite>` : ''}</blockquote>
    </aside>
    <footer class="rc-foot">
      <div class="row">${buttons}</div>
      <div class="rc-meta"><span class="bests"></span></div>
      <div class="padhint"></div>
    </footer>
  </div>
  <button class="playdata" id="playdata">Copy play data</button>`;
  // Bests land once storage answers (it's async): a NEW BEST tag and the lifetime line.
  void statsReady?.then((r) => {
    if (!r || recapEl.hidden) return;
    if (r.newBest) recapEl.querySelector('.rc-hero .score')?.classList.add('newbest');
    const b = recapEl.querySelector('.rc-meta .bests');
    if (b && !run) b.textContent = `Best ${n(r.best.bestBanked)} · Signed off ${r.best.signOffs} of ${r.best.broadcasts}`;
  });
  recapEl.hidden = false;
  mountClip();
  const boardEl = recapEl.querySelector<HTMLElement>('.rc-board');
  if (boardEl) {
    const blocked = lbBlocked();
    const sub: Submission | null = blocked || lb.segments.length === 0
      ? null
      : { mode: lb.mode, seed: lb.seed, growth: simOpts.growth, segments: lb.segments, buys: lb.buys, claimed: Math.round(run ? run.earned : sim.show.banked) };
    mountBoard(boardEl, lb.mode, sub, blocked ?? undefined);
  }
  // Playtest export: log this broadcast once, then copy everything logged so far.
  if (!lastEntry || lastEntry.seed !== simOpts.seed || lastEntry.segment !== simOpts.segment || lastEntry.seconds !== Math.round(sim.time * 10) / 10) {
    lastEntry = playLog.entry(sim, simOpts.seed, run ? 'run' : 'single', simOpts.segment, simOpts.upgrades);
    appendLog(lastEntry);
  }
  recapArmedAt = performance.now() + 250;
  const btn = (id: string) => document.getElementById(id) as HTMLButtonElement | null;
  if (btn('meet')) btn('meet')!.onclick = () => showMeeting();
  if (btn('again')) btn('again')!.onclick = () => restart(false);
  if (btn('tomenu')) btn('tomenu')!.onclick = () => recapToMenu();
  if (btn('playdata')) {
    const b = btn('playdata')!;
    b.onclick = async () => {
      const how = await exportLog(lastEntry ?? undefined);
      b.textContent = how === 'copied' ? 'Copied' : 'Saved as a file';
      (recapEl.querySelector('.row button') as HTMLButtonElement | null)?.focus(); // back to the real choice
    };
  }
  (recapEl.querySelector('.row button') as HTMLButtonElement).focus({ preventScroll: true });
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

/** §21 chyron: show a headline; tier changes break in with the stinger and the cream BREAKING kicker. */
function showHeadline(h: Headline) {
  chyKicker.textContent = h.kicker;
  chyKicker.classList.toggle('breaking', h.breaking);
  chyKicker.classList.toggle('busted', h.kicker === 'BUSTED');
  chyKicker.classList.toggle('signoff', h.kicker === 'SIGN-OFF');
  const span = document.createElement('span');
  span.textContent = h.text;
  span.className = 'in';
  chyText.replaceChildren(span);
  if (h.breaking) audio.breaking();
}

/** The broadcast is over (signed off or busted): graphics wind down, the recap timer starts. */
function endBroadcast(how: 'signOff' | 'busted') {
  audio.setGear(0, true);
  endedFor = 0;
  coverage.end();
  audio.ending(how === 'signOff');
  if (how === 'busted') document.documentElement.classList.add('ended');
  bot = null;
}

/** The stunt just before this chain event was a smash-across (for the counter's label). */
function recentAcross(e: SimEvent): boolean {
  const i = recentEvents.lastIndexOf(e);
  for (let k = i - 1; k >= 0 && k >= i - 4; k--) {
    const x = recentEvents[k];
    if (x.type === 'smash') return x.across;
  }
  return false;
}

function present(e: SimEvent) {
  recentEvents.push(e);
  if (recentEvents.length > 64) recentEvents.shift();
  if (e.type === 'smash' || e.type === 'bounce' || e.type === 'policeSmash' || e.type === 'policeCrash') {
    const p = sim.track.props.find((q) => q.id === e.propId) ?? sim.pursuit.units.find((q) => q.id === e.propId);
    if (p) propKinds.set(p.id, p.kind);
  }
  news.observe(e, sim.time);
  noteMoment(e);
  if (!replay && !attract) playLog.observe(e);
  if (!replay && !attract && !bot) onboarding.observe(e, sim);
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
      audio.smash(e.cls, where(e.s, e.d));
      hitstop = Math.max(hitstop, k.hitstop);
      rig.jolt(k.shake, e.cls === 'heavy' ? TUNING.camera.joltTime : 0.08);
      flash(k.flashFrames);
      haptic(k.haptic, k.hapticStrength);
      break;
    }
    case 'bounce': {
      const k = I.bounce;
      audio.bounce(where(e.s, e.d));
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
      audio.scrape(where(g.s, g.d + e.dir * 2));
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
      {
        const u = sim.pursuit.units.find((x) => x.id === e.id);
        audio.whoosh(u ? where(u.s, u.d) : undefined);
      }
      break;
    case 'dodge': {
      runStats.nearMiss++;
      audio.whoosh(where(e.s, e.d));
      rig.jolt(I.dodge.shake, 0.1);
      haptic(I.dodge.haptic, I.dodge.hapticStrength);
      sim.track.posAt(e.s, e.d, pos);
      highway.ring(pos.x, pos.z, 3.5, 0xffffff, 0.35, 0.45);
      break;
    }
    case 'ratings':
      if (e.cause !== 'rampage' && e.cause !== 'pose' && e.delta > 0) gainFlash();
      break;
    case 'ram':
      if (!e.hit) runStats.dodged++;
      pip.trigger(sim, sim.show.tier);
      break;
    case 'tell': {
      // From the unit if it's on the road already, else from its lane ahead of him.
      const u = sim.pursuit.units.find((x) => x.id === e.id);
      audio.tell(e.kind, u ? where(u.s, u.d) : where(g.s + 40, sim.track.laneCenter(e.lane)));
      break;
    }
    case 'netSlip': {
      // Caught once: a jolt and the BREAKING sting.
      audio.breaking();
      rig.jolt(TUNING.impact.heavy.shake, TUNING.camera.joltTime);
      flash(TUNING.impact.heavy.flashFrames);
      haptic(160, 0.9);
      break;
    }
    case 'netEscape':
      audio.whoosh();
      break;
    case 'carrierDrop':
      highway.dropIn(e.propId);
      audio.smash('medium', where(e.s, e.d));
      break;
    case 'spiked':
      audio.bounce();
      giant.onBounce();
      rig.jolt(3, 0.15);
      haptic(110, 0.6);
      break;
    case 'exitOpen':
      highway.rebuild([e.segment - 1, e.segment, e.segment + 1, e.segment + 2]);
      break;
    case 'forkOpen':
      // The ramp opens on segments already built ahead; the exit sign on the gantry calls it.
      highway.rebuild([e.segment - 1, e.segment, e.segment + 1, e.segment + 2]);
      break;
    case 'fork':
      if (e.taken) {
        // The station cuts away while the road ahead is rebuilt as the avenue (a jump, not a slide).
        highway.rebuildFrom(e.from);
        gait.reset();
        prev.s = sim.giant.s;
        prev.d = sim.giant.d;
        prev.stepPos = sim.giant.stepPos;
        rig.cut(director.current, director.side, targetAt(sim.giant.s, sim.giant.d));
        flash(TUNING.camera.cutFlashFrames);
        showCamTag();
      }
      break;
    case 'signOff': {
      const ex = sim.exit;
      const seg = ex ? sim.track.segments.find((x) => x.index === ex.segment) : undefined;
      if (seg) outro = { seg };
      if (!attract && !flags.stepMode) {
        const H = TUNING.camera.angles.findIndex((a) => a.name === 'Sign-Off');
        director.force(H, director.side, true);
        rig.swoopTo(H, director.side, targetAt(sim.giant.s, sim.giant.d));
      }
      endBroadcast(e.type);
      break;
    }
    case 'busted':
      endBroadcast(e.type);
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
    case 'ask': {
      renderAsks();
      if (e.done) {
        asksUntil = sim.time + TUNING.hud.asksFlash; // the panel comes back to show it landing
        audio.chainEnd(4, false);
        asksList.querySelector(`[data-id="${e.id}"]`)?.classList.add('flash');
      }
      break;
    }
    case 'chain': {
      if (e.count === 1 || (chainEl.dataset.mult ?? '1') !== String(e.mult)) {
        chainEl.classList.remove('up');
        void chainEl.offsetWidth;
        chainEl.classList.add('up');
      }
      chainEl.dataset.mult = String(e.mult);
      chainEl.classList.add('on');
      chainEl.classList.remove('banked', 'dropped');
      chainMult.textContent = `×${e.mult}`;
      chainStunt.textContent = STUNT_LABEL[e.cause] + ((e.cause === 'medium' || e.cause === 'heavy' || e.cause === 'unit') && recentAcross(e) ? ' · ACROSS' : '');
      chainPts.textContent = Math.round(e.pending).toLocaleString();
      chainCnt.textContent = e.count > 1 ? `${e.count} in a row` : '';
      runStats.bestChain = Math.max(runStats.bestChain, e.count);
      audio.chainTick(e.mult);
      break;
    }
    case 'chainEnd': {
      chainEl.classList.remove('up');
      chainEl.classList.add(e.dropped ? 'dropped' : 'banked');
      // The result takes the counter's own lines: no extra row under it.
      chainPts.textContent = e.dropped ? chainPts.textContent : `+${e.points.toLocaleString()}`;
      chainStunt.textContent = e.dropped ? 'DROPPED' : 'BANKED';
      chainCnt.textContent = e.count > 1 ? `${e.count} in a row` : '';
      chainResultT = 1.4;
      if (e.count > 1 || !e.dropped) audio.chainEnd(e.mult, e.dropped);
      break;
    }
    case 'policeSmash': {
      // A chasing cruiser ploughs through something in its lane: the prop flies along its run.
      highway.smash(e.propId, Math.cos(h), Math.sin(h), e.speed, Math.sign(e.d - g.d) || 1);
      audio.smash('medium', where(e.s, e.d));
      break;
    }
    case 'policeCrash': {
      // Out of the chase: the cruiser and (if Heavy) what it hit both go flying. Never anyone hurt (§ rule 10).
      if (e.onAir) runStats.crashes++;
      // Both go off his line, away from him.
      const side = Math.sign(e.d - g.d) || 1;
      units.smash(e.id, Math.cos(h), Math.sin(h), e.speed, side);
      if (e.propSmashed) (e.propId >= 1_000_000 ? units : highway).smash(e.propId, Math.cos(h), Math.sin(h), e.speed * 0.6, side);
      audio.smash('heavy', where(e.s, e.d));
      if (!e.onAir) break; // behind the frame: it still wrecks, it just isn't the show
      hitstop = Math.max(hitstop, TUNING.impact.medium.hitstop);
      rig.jolt(TUNING.impact.medium.shake, 0.12);
      haptic(TUNING.impact.medium.haptic, TUNING.impact.medium.hapticStrength);
      pip.trigger(sim, sim.show.tier);
      break;
    }
    case 'spotlight':
      audio.spotlightLock();
      break;
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
      rig.gearPunch();
      highway.alarm();
      gearShockPending = true;
      audio.tierUp(e.tier);
      if (!attract) audio.setGear(e.tier);
      giant.onTierUp();
      tierbar.classList.remove('flick');
      void tierbar.offsetWidth;
      tierbar.classList.add('flick');
      break;
    }
    case 'tierDown':
      audio.tierDown();
      if (!attract) audio.setGear(e.tier);
      // Lost Rampage: the gear strip flashes red (the music layer cuts with it).
      if (e.tier === TUNING.tiers.length - 2) {
        gearsEl.classList.remove('lost');
        void gearsEl.offsetWidth;
        gearsEl.classList.add('lost');
      }
      break;
    case 'shoulder': {
      giant.onShoulder();
      audio.shoulder();
      // The charge: a shockwave wedge thrown ahead of him (three rings marching forward), dust off the
      // shoulder line, a jolt and a small lens punch.
      for (const [ahead, size, op] of [[2, 6, 0.8], [5, 4.5, 0.6], [8, 3, 0.45]] as const) {
        sim.track.posAt(e.s + ahead, e.d, pos);
        highway.ring(pos.x, pos.z, size, 0xffffff, 0.3 + ahead * 0.02, op);
      }
      sim.track.posAt(e.s + 1.5, e.d, pos);
      highway.spawnDebris(pos.x, pos.z, Math.cos(h), Math.sin(h), g.speed + 6, 12, [PALETTE.dust, 0xb8ad9c, 0xf1f1ee], [0.12, 0.32], 1.4);
      rig.gearPunch();
      rig.jolt(3, 0.12);
      haptic(80, 0.5);
      break;
    }
  }
}

function stepSim(inp: SimInput) {
  if (!replay) inputLog.push(inp);
  if (!replay && !attract && sim.live) playLog.tick(sim, bot ? 'bot' : input.device);
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
  // During a replay the chyron holds what the station actually ran about the moment (never a new line).
  if (h && !replay) {
    if (moment && !moment.headline && h.sources.includes(moment.event)) moment.headline = h;
    showHeadline(h);
    // Tonight's top story: the biggest headline that wasn't the ending itself.
    if (!['BUSTED', 'SIGN-OFF'].includes(h.kicker) && sim.show.ratings >= runStats.bestRatings) {
      runStats.best = h;
      runStats.bestRatings = sim.show.ratings;
    }
  }
}


// --- Recap REPLAY: tonight's top moment, re-simulated from the recorded inputs -----------
// The sim is deterministic for (seed, segment, upgrades, inputs), so the replay is the real
// thing, not a recording of pixels: a fresh sim fast-forwards to just before the moment, then the
// normal renderer plays it from a cut-away angle in slow motion. The live views are parked and
// restored untouched; run stats and headlines from the replay are thrown away.

/** The recap's picture: a still of tonight's top moment (or the last shot when there was no replay). */
let recapShot: string | null = null;
let recapShotFromReplay = false;

/** The recap's clip: the replay recorded off the canvas as it plays (where the browser can), looped on the recap. */
let recapClip: string | null = null;
let clipRec: MediaRecorder | null = null;
function clipType(): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof canvas.captureStream !== 'function') return null;
  return ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}
function startClip() {
  dropClip();
  const type = clipType();
  if (!type) return;
  try {
    const rec = new MediaRecorder(canvas.captureStream(TUNING.replay.clipFps), { mimeType: type, videoBitsPerSecond: TUNING.replay.clipBitrate });
    const parts: Blob[] = [];
    const t0 = performance.now();
    rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    rec.onstop = () => {
      rec.stream.getTracks().forEach((k) => k.stop());
      if (clipRec !== rec || !parts.length || performance.now() - t0 < TUNING.replay.clipMin * 1000) return;
      recapClip = URL.createObjectURL(new Blob(parts, { type }));
      // The recap is usually up already (it opens as the replay ends).
      if (!recapEl.hidden) mountClip();
    };
    rec.start();
    clipRec = rec;
  } catch {
    clipRec = null;
  }
}
/** The recap card alternates: the clip plays through, then the still holds a moment, then the clip again. */
function mountClip() {
  const fig = recapEl.querySelector('.rc-shot');
  if (!fig || !recapClip || fig.querySelector('video')) return;
  const v = document.createElement('video');
  Object.assign(v, { src: recapClip, muted: true, playsInline: true });
  fig.prepend(v);
  fig.classList.add('clip');
  let hold = 0;
  const play = () => {
    fig.classList.remove('still');
    v.currentTime = 0;
    void v.play().catch(() => {});
  };
  v.addEventListener('ended', () => {
    fig.classList.add('still');
    clearTimeout(hold);
    hold = window.setTimeout(() => { if (v.isConnected) play(); }, TUNING.replay.clipStillHold * 1000);
  });
  play();
}

function stopClip() {
  if (clipRec && clipRec.state !== 'inactive') clipRec.stop();
}
function dropClip() {
  const rec = clipRec;
  clipRec = null;
  if (rec && rec.state !== 'inactive') rec.stop();
  if (recapClip) URL.revokeObjectURL(recapClip);
  recapClip = null;
}
function grabShot() {
  // Copied in the same task as the render, so the drawing buffer is still there.
  const W = Math.min(TUNING.replay.shotWidth, canvas.width);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = Math.round((W * canvas.height) / canvas.width);
  try {
    c.getContext('2d')!.drawImage(canvas, 0, 0, c.width, c.height);
    recapShot = c.toDataURL('image/jpeg', 0.84);
    recapShotFromReplay = !!replay;
  } catch {
    recapShot = null;
  }
}

function noteMoment(e: SimEvent) {
  if (replay || attract || !sim.live) return;
  const S = TUNING.replay.score;
  let sc = 0;
  switch (e.type) {
    case 'policeCrash': sc = S.policeCrash; break;
    case 'smash': sc = e.propId >= 1_000_000 ? S.unitSmash : e.cls === 'heavy' ? (e.across ? S.heavyAcross : S.heavy) : 0; break;
    case 'leapLand': sc = e.smashed > 0 ? S.leapLand + e.smashed : 0; break;
    case 'hijackBail': sc = S.hijackBail; break;
    case 'nearMiss': sc = S.nearMiss; break;
    case 'ram': sc = e.hit ? 0 : S.ramMiss; break;
    case 'pose': sc = S.pose; break;
  }
  if (sc > 0 && (!moment || sc >= moment.score)) moment = { t: sim.time, score: sc, kind: e.type, event: e, headline: null };
}

function replayInput(): SimInput {
  return replay ? inputLog[replay.sim.tick] ?? NO_INPUT : NO_INPUT;
}

function startReplay(done: () => void) {
  const R = TUNING.replay;
  const m = moment!;
  const rs = new Sim(simOpts);
  const startTick = Math.round(Math.max(0, m.t - R.lead) / rs.dt);
  for (let i = 0; i < startTick && i < inputLog.length; i++) rs.step(inputLog[i]);
  const live: Parked = { sim, highway, gait, cruisers, units, director, news, bot, rideMesh, prev: { ...prev }, runStats: { ...runStats }, propKinds: new Map(propKinds), recent: recentEvents.slice() };
  scene.remove(highway.group, cruisers.group, units.group);
  if (rideMesh) scene.remove(rideMesh);
  sim = rs;
  highway = new HighwayView(rs);
  highway.onHonk = (v, at) => audio.honk(v, at);
  highway.onBrush = (at) => audio.scrape(at);
  gait = new Gait();
  cruisers = new CruiserView(rs);
  cruisers.reduceFlashes = settings.reduceFlashes;
  units = new UnitViews(rs, highway);
  units.reduceFlashes = settings.reduceFlashes;
  news = new Newsroom(simOpts.seed, rs.show.heat);
  director = new Director(simOpts.seed);
  rideMesh = null;
  bot = null;
  scene.add(highway.group, cruisers.group, units.group);
  giant.reset();
  prev.s = rs.giant.s;
  prev.d = rs.giant.d;
  prev.stepPos = rs.giant.stepPos;
  const ang = Math.max(0, TUNING.camera.angles.findIndex((a) => a.name === R.angle));
  director.force(ang, 1, true);
  rig.cut(ang, 1, targetAt(rs.giant.s, rs.giant.d));
  document.documentElement.classList.add('replay');
  replayEl.hidden = false;
  // The chyron shows the headline that ran about this moment, or nothing.
  chyText.classList.toggle('empty', !m.headline);
  if (m.headline) showHeadline({ ...m.headline, breaking: false });
  acc = 0;
  startClip();
  replay = { sim: rs, live, slowFrom: m.t - R.slowBefore, slowTo: m.t + R.slowAfter, end: m.t + R.after, armedAt: performance.now() + 400, done };
}

function updateReplay() {
  const r = replay!;
  const t = r.sim.time;
  replayRate = t >= r.slowFrom && t <= r.slowTo ? TUNING.replay.slow : 1;
  const skip = performance.now() > r.armedAt && !!app && (app.shell.input.wasPressed('ui_accept') || app.shell.input.wasPressed('ui_cancel'));
  // Skipped before the picture was taken: take this frame for the recap, then leave on the next one.
  if (skip && !recapShot) r.grab = true;
  if (r.grab && !recapShot) return;
  if (t >= r.end || skip || r.grab || !r.sim.live) endReplay();
}

function endReplay() {
  const r = replay!;
  stopClip();
  replay = null;
  replayRate = 1;
  scene.remove(highway.group, cruisers.group, units.group);
  if (rideMesh) scene.remove(rideMesh);
  const L = r.live;
  ({ sim, highway, gait, cruisers, units, director, news, bot, rideMesh } = L);
  scene.add(highway.group, cruisers.group, units.group);
  if (rideMesh) scene.add(rideMesh);
  Object.assign(prev, L.prev);
  Object.assign(runStats, L.runStats);
  propKinds.clear();
  for (const [k, v] of L.propKinds) propKinds.set(k, v);
  recentEvents.length = 0;
  recentEvents.push(...L.recent);
  giant.reset();
  rig.snap(targetAt(sim.giant.s, sim.giant.d));
  document.documentElement.classList.remove('replay');
  chyText.classList.remove('empty');
  replayEl.hidden = true;
  acc = 0;
  r.done();
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
  lb = { mode: mode === 'run' ? 'run' : 'broadcast', seed, segments: [], buys: [] };
  if (mode === 'run') {
    run = new RunState(seed);
    newRun(run.segmentSeed(), 0, []);
  } else {
    run = null;
    newRun(seed, Math.max(0, Math.min(TUNING.run.segments - 1, flags.seg ?? 0)), flags.ability ? [flags.ability] : []);
  }
  bot = flags.bot ? new Bot(sim) : null;
  // First broadcast ever: How to Play first, then the cold open.
  if (!bot && !flags.autostart && !briefingSeen()) {
    started = false;
    void openBriefing(true).then(() => start());
  } else start();
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
  lastInputAt = performance.now();
  try {
    audio.unlock();
  } catch {
    /* audio unavailable */
  }
};
/** Pause requests from the game (Esc/Start/II, focus loss, pad unplugged) go through the shell. */
function requestPause() {
  if (app && !briefingClose && app.shell.session.phase === 'playing' && !attract && sim.live) app.flow.showPause();
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
  // HUD scale (Direction B): the top-of-screen pieces are drawn for 1280×720 and zoomed by this.
  // Accessibility: HUD Size scales it up (Settings), within what still fits beside the road.
  const hs = Math.max(TUNING.hud.minScale, Math.min(TUNING.hud.maxScale, Math.min(window.innerWidth / 1280, window.innerHeight / 720))) * settings.hudSize;
  document.documentElement.style.setProperty('--hs', hs.toFixed(3));
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
  gameName: 'Giant at Large',
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
        { id: 'wyf-howto', label: 'How to Play' },
        { id: 'wyf-controls', label: 'Controls', description: 'Rebind the keyboard' },
        { id: 'wyf-tips', label: 'Replay Tips', description: 'Show the in-game control tips again' },
        { id: 'wyf-brake', label: `Brake: ${settings.brakeToggle ? 'Toggle' : 'Hold'}`, description: 'Toggle: press once to brake, again to let go' },
        { id: 'wyf-hudsize', label: `HUD Size: ${Math.round(settings.hudSize * 100)}%` },
        { id: 'wyf-speed', label: `Game Speed: ${Math.round(settings.gameSpeed * 100)}%`, description: 'Slower gives more time to react. Below 100% scores stay off the leaderboard' },
        { id: 'wyf-cuts', label: `Camera Cuts: ${onOff(settings.cameraCuts)}`, description: 'Off holds the Chase High shot' },
        { id: 'wyf-livetime', label: `LIVE TIME: ${onOff(settings.liveTime)}`, description: 'Lighting follows your clock; off is always night' },
        { id: 'wyf-flashes', label: `Reduce Flashes: ${onOff(settings.reduceFlashes)}` },
        { id: 'wyf-colors', label: `HUD Colours: ${settings.hudColors === 'network' ? 'Network' : 'WYF 6'}`, description: 'The station\'s purple and cream, or network red, blue and white' },
        // Dev only: the overlay's switch shows with ?debug (or for a player who already turned it on).
        ...(flags.debug !== null || settings.debugChosen ? [{ id: 'wyf-debug', label: `Debug Overlay: ${onOff(settings.debug)}` }] : []),
      ],
      handle: async (id) => {
        if (id === 'wyf-howto') {
          await openBriefing(false);
          return true; // the shell shows Settings again
        }
        if (id === 'wyf-tips') {
          onboarding.reset();
          return true;
        }
        if (id === 'wyf-controls') {
          await openControls();
          return true;
        }
        const next = <T,>(list: T[], v: T) => list[(list.indexOf(v) + 1) % list.length];
        if (id === 'wyf-brake') {
          settings.brakeToggle = !settings.brakeToggle;
          applyControls();
        } else if (id === 'wyf-hudsize') {
          settings.hudSize = next(HUD_SIZES, settings.hudSize);
          resize();
        } else if (id === 'wyf-speed') settings.gameSpeed = next(GAME_SPEEDS, settings.gameSpeed);
        if (id === 'wyf-brake' || id === 'wyf-hudsize' || id === 'wyf-speed') {
          saveSettings(settings);
          return true;
        }
        if (id === 'wyf-cuts') settings.cameraCuts = director.enabled = !settings.cameraCuts;
        else if (id === 'wyf-livetime') {
          settings.liveTime = !settings.liveTime;
          forcedLook = null;
          applyLook();
        } else if (id === 'wyf-flashes') settings.reduceFlashes = lighting.reduceFlashes = cruisers.reduceFlashes = units.reduceFlashes = !settings.reduceFlashes;
        else if (id === 'wyf-colors') {
          settings.hudColors = settings.hudColors === 'network' ? 'wyf' : 'network';
          applyHudColors();
        } else if (id === 'wyf-debug') {
          settings.debug = !settings.debug;
          settings.debugChosen = true;
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
app.ui.updateScreen('title', { title: 'Giant\nat Large', subtitle: 'Warn your friends.', choices: [{ id: 'start', label: 'Press Start' }] });
// One menu (Mike: "clean up main menu/UX flow"): the two modes sit on it directly, so there's no
// separate mode screen between Start and the broadcast.
app.ui.updateScreen('main-menu', {
  title: 'Giant\nat Large',
  choices: [
    // One mode on the menu (Mike, 2026-11-17: Single Segment adds no challenge; maybe a daily mode later).
    // 'broadcast' (one segment) stays reachable by ?mode=broadcast for tests and evidence tools.
    { id: 'run', label: 'Go Live', description: 'Five segments, upgrades between them' },
    { id: 'howto', label: 'How to Play' },
    { id: 'settings', label: 'Settings' },
  ],
});
// The shell's main menu knows neither the modes nor How to Play: catch them before the flow does.
{
  const flowActivate = app.flow.onActivate.bind(app.flow);
  app.flow.onActivate = (screen: string, choice: string) => {
    if (screen === 'main-menu' && choice === 'howto') void openBriefing(false).then(() => app!.ui.show('main-menu'));
    else if (screen === 'main-menu' && (choice === 'run' || choice === 'broadcast')) flowActivate('mode-select', choice);
    else flowActivate(screen, choice);
  };
}
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
    acc += realDt * flags.timescale * replayRate * settings.gameSpeed;
    let steps = 0;
    while (acc >= SIM_DT && steps < 8) {
      acc -= SIM_DT;
      if (hitstop > 0) {
        hitstop--;
        frozen = true;
        continue;
      }
      const human = input.sample(); // always drain edges, even while the bot drives
      let inp = replay ? replayInput() : bot ? bot.input() : human;
      // Lane input follows the screen: when travel points down (Head-On, or past halfway through
      // the swoop), his left is screen-right, so mirror it.
      if (!replay && !bot && rig.info.travelDown && inp.lane) inp = { ...inp, lane: -inp.lane };
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
  let d = prev.d + (g.d - prev.d) * alpha;
  let rampSlope = 0;
  if (outro && !replay) {
    // On the ramp once it peels away from his lane: its centreline, and its curve in his heading.
    const rd = sim.track.widthAt(s) + sim.track.exitOffset(outro.seg, s);
    if (rd > d) {
      d = rd;
      rampSlope = sim.track.exitOffset(outro.seg, s + 1) - sim.track.exitOffset(outro.seg, s);
    }
  }
  const stepPos = prev.stepPos + (g.stepPos - prev.stepPos) * alpha;
  const t = targetAt(s, d);
  t.travel += Math.atan(rampSlope); // on the ramp: he (and the chopper) follow its curve
  const lateralVel = (g.d - prev.d) / SIM_DT;
  const heading = t.travel + Math.atan2(lateralVel, Math.max(4, g.speed)) * 0.5;

  if (replay) updateReplay();
  const animDt = paused || frozen ? 0 : realDt * flags.timescale * replayRate * settings.gameSpeed;
  audio.setRotor(g.tier / 2);

  if (animDt > 0) {
    // Giant size: ease toward this gear's size, then run the gait in his space.
    const want = sizeFor(g.tier);
    setGiantScale(Math.abs(want - gScale) < 1e-3 ? want : gScale + (want - gScale) * Math.min(1, animDt / TUNING.growth.ease), t.x, t.z);
    rig.giantScale = gScale;
    const lt = toGiant(t.x, t.z);
    const gf = gait.update({ x: lt.x, z: lt.z, fx: Math.cos(t.travel), fz: Math.sin(t.travel), speed: g.speed / gScale, stepPos, stepLen: g.stepLen / gScale, tier: g.tier, dt: animDt });
    if (gf.plantedNow === 0 || gf.plantedNow === 1) {
      // v0.3 footfall: dust ring, 2px camera pulse, bass thump; Rampage adds a crack decal.
      const lf = gf.legs[gf.plantedNow as 0 | 1].foot;
      const f = fromGiant(lf.x, lf.z);
      // Gear build-up: the last second before a gear-up, steps swell and tick upward.
      const G = TUNING.gear;
      const build = sim.live && sim.tierUpIn <= G.buildUp && sim.tierUpProgress > 0 ? 1 - sim.tierUpIn / G.buildUp : 0;
      highway.ring(f.x, f.z, (1.6 + g.tier * 0.7) * gScale * (1 + build * G.buildRingScale), build > 0 ? 0xfff1d6 : PALETTE.dust, 0.5 + build * 0.3, 0.55);
      if (build > 0) audio.gearTick(build);
      if (gearShockPending) {
        gearShockPending = false;
        highway.ring(f.x, f.z, G.shockRadius, 0xffffff, 0.6, 0.85);
        highway.ring(f.x, f.z, G.shockRadius * 0.55, PALETTE.dust, 0.75, 0.7);
      }
      // Stride and Rampage kick dust back off every step.
      const kick = G.dustKick[g.tier];
      // Out to the side of the planted foot and a little back: straight back would land under the chyron.
      const side = gf.plantedNow === 0 ? -1 : 1;
      const kx = -Math.cos(t.travel) * 0.4 - Math.sin(t.travel) * side;
      const kz = -Math.sin(t.travel) * 0.4 + Math.cos(t.travel) * side;
      if (kick) highway.spawnDebris(f.x, f.z, kx, kz, 2 + g.tier * 1.5, kick, [0x6e6152, 0x857664, 0x4a4038], [0.16, 0.34 + g.tier * 0.1], 0.4); // darker than the lit pool he runs in
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
    // In his space: a Leap scales with him; standing on a car roof keeps his feet on the roof.
    const lift = u > 0 ? 4 * A.leap.height * u * (1 - u) : roof / gScale;
    poseAnim += ((g.pose > 0 ? 1 : 0) - poseAnim) * Math.min(1, animDt / 0.08);
    unplaceGiant();
    giant.update(animDt, { x: lt.x, z: lt.z, heading, travel: t.travel, lateralVel, speed: g.speed, tier: g.tier, braking: g.braking, stumble: g.stumble, stepPos, lift, leap: u, pose: poseAnim }, gf);
    placeGiant();
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
  if (endedFor >= 0 && !paused) endedFor += realDt * flags.timescale;
  if (endedFor >= 0 && !recapShown && endedFor > (sim.show.state === 'cleared' ? TUNING.camera.signOffHold : 2.2)) {
    recapShown = true;
    if (attract) enterAttract(); // behind the menus: just roll another broadcast
    else {
      lb.segments.push(encodeInputs(inputLog));
      if (run) run.finishSegment(sim.show);
      if (run?.phase !== 'meeting') {
        app?.shell.session.setPhase('results');
        statsReady = recordStats();
      }
      // Tonight's top moment first, then the recap.
      if (moment && flags.replay && !flags.stepMode) startReplay(showRecap);
      else showRecap();
    }
  }
  // Back (Esc / B / Circle) closes How to Play.
  if (briefingClose && !input.capturing && app?.shell.input.wasPressed('ui_back') && recapArmed()) briefingClose();
  // Controller parity on the recap: left/right to move, A to choose.
  if (!recapEl.hidden && app && !input.capturing && !(document.activeElement instanceof HTMLInputElement)) {
    const btns = ([...recapEl.querySelectorAll('button')] as HTMLButtonElement[]).filter((b) => !b.disabled && b.id !== 'playdata');
    const i = Math.max(0, btns.indexOf(document.activeElement as HTMLButtonElement));
    if (app.shell.input.wasPressed('ui_right') || app.shell.input.wasPressed('ui_down')) btns[(i + 1) % btns.length].focus();
    if (app.shell.input.wasPressed('ui_left') || app.shell.input.wasPressed('ui_up')) btns[(i + btns.length - 1) % btns.length].focus();
    if (app.shell.input.wasPressed('ui_accept') && recapArmed() && document.activeElement instanceof HTMLButtonElement && btns.includes(document.activeElement)) document.activeElement.click();
  }
  rig.update(paused ? 0 : realDt * flags.timescale, t);
  lighting.update(animDt, { giantX: t.x, giantZ: t.z, travel: t.travel, speed: g.speed, camera: rig.camera, lamps: highway.lamps, sirens: cruisers.sirens, facing: rig.facing, giantScale: gScale });
  // Spatial mix: the giant is the listener; left/right is the camera's screen-right.
  sirenRight.setFromMatrixColumn(rig.camera.matrixWorld, 0);
  audio.setListener(t.x, t.z, sirenRight.x, sirenRight.z);
  audio.setSirens(
    sim.escort.cruisers.map((c) => (c.active ? Math.max(0.25, Math.min(1, 1 - (g.s - c.s - 8) / 60)) : 0)),
    sim.escort.cruisers.map((c) => (c.active ? where(c.s, c.d) : null)),
  );

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
  } else if (updateTitleShot(realDt, t)) renderer.render(scene, titleCam);
  else renderer.render(scene, rig.camera);
  // The recap's picture: the replay's own frame just as the moment lands (before the viewer-video window draws).
  if (replay && !recapShot && moment && (replay.grab || replay.sim.time >= moment.t + TUNING.replay.shotAfter)) grabShot();
  pip.render(renderer, scene);
  updateHud(realDt);
  updateGlyphs();
  onboarding.update(sim, performance.now() / 1000, sim.live && started && !paused && !attract && !replay && !bot);
}

/**
 * Button labels follow the device in use (PS4/PS5 pads show L1/R1/L2/✕). Shown on the ability
 * chip, on a controls strip for the first seconds of each segment, and under recap/meeting cards.
 */
let glyphFamily: InputDeviceFamily | null = null;
function glyph(action: GlyphAction): string {
  // Rebound keyboard keys (Settings → Controls) label themselves.
  if (settings.keys && (glyphFamily ?? 'keyboard-mouse') === 'keyboard-mouse') {
    const K = settings.keys;
    if (action === 'lanes') return `${keyLabel(K.left)} / ${keyLabel(K.right)}`;
    if (action === 'brake' || action === 'shoulder' || action === 'ability') return keyLabel(K[action]);
  }
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

/**
 * Title screen (Mike's chopper-feed direction): the attract broadcast behind the title is shot
 * close from behind and above, the giant in the right third under the spotlight, the night look,
 * a LIVE traffic-report bug. Leaving the title, the camera glides down into the chase.
 */
const titleCam = new THREE.PerspectiveCamera(TUNING.title.fov, 16 / 9, 0.5, 900);
const titleTmp = { q: new THREE.Quaternion(), p: new THREE.Vector3(), m: new THREE.Matrix4(), up: new THREE.Vector3(0, 1, 0) };
const titleBug = $('titlebug');
/**
 * Mike: the cover art is the start screen; the live attract shot slides in when left idle, and any
 * input brings the cover back.
 */
const coverEl = $('cover');
($('cover').querySelector('img') as HTMLImageElement).src = coverUrl;
// The cover sits under the shell's title screen; clicking or tapping anywhere on the title is Press Start.
$('ui').addEventListener('click', (e) => {
  const screen = (e.target as HTMLElement).closest('[data-screen-id="title"]');
  if (screen && !(e.target as HTMLElement).closest('button')) screen.querySelector<HTMLButtonElement>('[data-choice-id="start"]')?.click();
});
let lastInputAt = performance.now();
for (const ev of ['keydown', 'pointerdown', 'touchstart'] as const) window.addEventListener(ev, () => (lastInputAt = performance.now()), { passive: true });
const titleRoad = $('titleroad');
let titleK = 0;
let wasTitle = false;
function updateTitleShot(dt: number, t: CameraTarget): boolean {
  const T = TUNING.title;
  // The title screen shows the cover art; every menu behind it (attract) keeps the chopper shot
  // with no broadcast HUD, so the game only goes live when a broadcast starts (Mike, 2026-11-15).
  const onTitle = attract && !!document.querySelector('#ui [data-screen-id="title"]');
  const inMenus = attract;
  document.documentElement.classList.toggle('title', inMenus);
  if (inMenus !== wasTitle) {
    wasTitle = inMenus;
    if (inMenus) {
      if (!forcedLook) lighting.setMode('night');
    } else applyLook();
  }
  const idle = (performance.now() - lastInputAt) / 1000;
  const cover = onTitle && idle < T.idleToAttract;
  coverEl.hidden = !onTitle; // leaving the title, the camera glide is the transition: the art cuts away
  coverEl.classList.toggle('away', !cover);
  document.documentElement.classList.toggle('cover', cover);
  audio.setHushed(cover); // no footsteps from a giant hidden behind the cover art
  if (inMenus) {
    titleK = 1;
    const seg = sim.track.segmentAt(sim.giant.s);
    titleRoad.textContent = `${seg.zoneName} ${compass(t.travel)}bound`;
  } else titleK = Math.max(0, titleK - dt / T.glideTime);
  titleBug.hidden = !inMenus;
  if (titleK <= 0) return false;
  // The shot, relative to his travel: behind, up, and off to his left, looking ahead past him.
  const fx = Math.cos(t.travel), fz = Math.sin(t.travel);
  const rx = -fz, rz = fx; // his right
  const pos = titleTmp.p.set(t.x - fx * T.back - rx * T.left, T.height, t.z - fz * T.back - rz * T.left);
  const look = new THREE.Vector3(t.x + fx * T.lookAhead - rx * T.lookLeft, T.lookHeight, t.z + fz * T.lookAhead - rz * T.lookLeft);
  titleTmp.m.lookAt(pos, look, titleTmp.up);
  const want = titleTmp.q.setFromRotationMatrix(titleTmp.m);
  // Glide: ease from the chase camera to the title shot by titleK (1 = all title).
  const k = titleK * titleK * (3 - 2 * titleK);
  titleCam.position.lerpVectors(rig.camera.position, pos, k);
  titleCam.quaternion.copy(rig.camera.quaternion).slerp(want, k);
  titleCam.fov = rig.camera.fov + (T.fov - rig.camera.fov) * k;
  titleCam.aspect = rig.camera.aspect;
  titleCam.updateProjectionMatrix();
  return true;
}

/** Render one frame now and measure the giant's silhouette (E2E / evidence). */
function silhouette() {
  renderer.render(scene, rig.camera);
  return measureSilhouette(renderer, scene, rig.camera, giant.bodyObjects, rig.angle.name === TUNING.camera.angles[TUNING.camera.homeAngle].name ? 48 : 40);
}

const poseCam = new THREE.PerspectiveCamera(40, 16 / 9, 0.5, 500);

/** Persist the bests (shell storage, per game id). */
async function recordStats(): Promise<{ best: Stats; newBest: boolean } | null> {
  if (!app) return null;
  const st = app.storage;
  const sh = sim.show;
  const best = (await st.get<Stats>('wyf.stats')) ?? { broadcasts: 0, signOffs: 0, bestBanked: 0, bestPeak: 0 };
  const newBest = !run && best.broadcasts > 0 && Math.round(sh.banked) > best.bestBanked;
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
  return { best, newBest };
}
/** Stored bests. Phase 3 fields are optional so older saves load unchanged. */
type Stats = { broadcasts: number; signOffs: number; bestBanked: number; bestPeak: number; runs?: number; runsWon?: number; bestRun?: number };
/** The bests as this broadcast's save lands (the recap reads them when they arrive). */
let statsReady: Promise<{ best: Stats; newBest: boolean } | null> | null = null;
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

function updateBoxed() {
  const pin = sim.show.pin;
  const caught = sim.caught();
  const show = sim.live && !attract && (pin > 0.5 || caught || (sim.pursuit.netActive && sim.boxedIn()));
  boxedEl.hidden = !show;
  if (!show) return;
  boxedFill.style.width = `${Math.min(100, pin).toFixed(0)}%`;
  boxedEl.classList.toggle('pulse', pin > 50);
  // Boxed in by a net, or caught crawling with police on his tail (the way out differs: run).
  const kind = caught || (sim.show.pinCause === 'caught' && !sim.boxedIn()) ? 'caught' : 'net';
  // After one slip, the next catch busts him: say so.
  boxedEl.classList.toggle('last', sim.show.netSlips > 0);
  boxedEl.querySelector('b')!.textContent = (kind === 'caught' ? 'CAUGHT' : 'BOXED IN') + (sim.show.netSlips > 0 ? ' · LAST CHANCE' : '');
  if (boxedFam !== `${glyphFamily}:${kind}`) {
    boxedFam = `${glyphFamily}:${kind}`;
    if (kind === 'caught') boxedHow.innerHTML = glyphFamily === 'touch' ? 'Let go of ▼ · Run' : `Let go of <kbd>${esc(glyph('brake'))}</kbd> · Run`;
    else boxedHow.innerHTML = glyphFamily === 'touch' ? 'Tap ● Shoulder · hold ▼ Brake' : `<kbd>${esc(glyph('shoulder'))}</kbd>Shoulder · <kbd>${esc(glyph('brake'))}</kbd>Brake`;
  }
}

function updateHud(dt: number) {
  updateBoxed();
  const g = sim.giant;
  // LIVE clock; once the exit is open it counts down to the end of the grace period.
  const X = TUNING.segment;
  const counting = sim.time >= X.exitOpensAt && sim.live;
  const secs = counting ? Math.max(0, Math.ceil(X.length + X.grace - sim.time)) : Math.floor(sim.time);
  clockEl.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  clockEl.classList.toggle('count', counting);
  // One primary number: the score (the whole run's in Full Broadcast; spending never lowers it). Ratings is the
  // audience bar under it, with its tier colour and danger pulse; the viewer count lives on the recap.
  const sh = sim.show;
  scoreEl.textContent = Math.floor((run ? run.earned : 0) + (!run || run.phase === 'live' ? sh.banked : 0)).toLocaleString();
  ratingsBar.style.width = `${sh.ratings.toFixed(1)}%`;
  for (let k = 1; k <= 3; k++) ratingsEl.classList.toggle(`t${k}`, sh.tier === k);
  ratingsEl.classList.toggle('danger', sh.ratings < 8 && sim.live);
  // Combo counter: the clock drains over the chain window; the result lingers after it ends.
  const ch = sh.chain;
  if (ch.count > 0) chainClock.style.transform = `scaleX(${Math.max(0, 1 - (sim.time - ch.last) / TUNING.spectacle.window).toFixed(3)})`;
  chainResultT = Math.max(0, chainResultT - dt);
  if (ch.count === 0 && chainResultT <= 0 && chainEl.classList.contains('on')) chainEl.className = '';
  chainEl.hidden = attract;
  // Lower third, top band: the road he's on and which way (facts from the sim; only written on change).
  const seg = sim.track.segmentAt(g.s);
  const place = `${seg.zoneName} · ${compass(sim.track.headingAt(g.s))}bound`.toUpperCase();
  if (chyPlace.textContent !== place) chyPlace.textContent = place;
  // Gear pips: filled per gear; the next one fills as he holds top speed (the build, made visible).
  const prog = sim.tierUpProgress;
  gearPips.forEach((p, i) => {
    p.style.setProperty('--fill', i <= g.tier ? '1' : i === g.tier + 1 ? prog.toFixed(3) : '0');
    p.classList.toggle('filling', i === g.tier + 1);
    p.classList.toggle('next', i === g.tier + 1 && sim.tierUpIn <= TUNING.gear.buildUp);
  });
  gearsEl.dataset.tier = String(g.tier);
  gearName.textContent = TUNING.tiers[g.tier].name.toUpperCase();
  gearMultEl.textContent = `×${TUNING.show.bankMult[g.tier]}`;
  heatStars.forEach((el, i) => el.classList.toggle('on', i < sh.heat));
  // The asks: at the top of a segment and when one lands, then out of the way (HUD triage, 2026-11-17).
  asksEl.classList.toggle('show', sim.live && sim.time < Math.max(asksUntil, TUNING.hud.asksIntro));
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
      abilIcon.src = UPGRADE_ART[ab];
      abilBtn.style.backgroundImage = `url(${UPGRADE_ART[ab]})`;
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
  /** Render cost of the last frame (draw calls, triangles): performance evidence. */
  renderInfo: () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }),
  sfx: () => audio.loadedKinds(),
  /** Spatial mix check: pan and level of a sound `across` m to the camera's right of him and `along` m ahead. */
  sfxPlace: (across: number, along: number) => {
    const r = new THREE.Vector3().setFromMatrixColumn(rig.camera.matrixWorld, 0);
    const n = Math.hypot(r.x, r.z) || 1;
    const t = targetAt(sim.giant.s, sim.giant.d);
    return audio.placeOf(t.x + (r.x / n) * across + Math.cos(t.travel) * along, t.z + (r.z / n) * across + Math.sin(t.travel) * along);
  },
  recap: () => (recapEl.hidden ? null : { title: recapEl.querySelector('.why')?.textContent, outcome: recapEl.querySelector('.outcome')?.textContent, clip: !!recapEl.querySelector('.rc-shot video') && !(recapEl.querySelector('.rc-shot video') as HTMLVideoElement).paused }),
  /** Recap REPLAY: playing now (sim time, end, rate), and the moment it picked. */
  replay: () => ({ playing: !!replay, t: replay?.sim.time ?? null, end: replay?.end ?? null, rate: replayRate, moment }),
  show: () => ({ ...sim.show, tier: sim.show.tier, exit: sim.exit, live: sim.live, units: sim.pursuit.units.map((u) => ({ id: u.id, unit: u.unit, phase: u.phase, gap: u.s - sim.giant.s, lane: u.lane })) }),
  coverage: () => ({ cls: document.getElementById('hud')!.className, desk: !document.getElementById('desk')!.hidden, ticker: !document.getElementById('ticker')!.hidden, pip: pip.active, cold: !document.getElementById('coldopen')!.hidden }),
  /** Dev: roll viewer video now. */
  viewerVideo: () => pip.trigger(sim, 3, true),
  setTimescale(v: number) {
    flags.timescale = v;
  },
  /** Dev: leave (or enter) step mode, e.g. to fast-forward to an event and then watch it in slow motion. */
  /** Dev: act as if the title has been left idle (the attract shot slides in over the cover). */
  idleTitle() {
    lastInputAt = -1e9;
  },
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
