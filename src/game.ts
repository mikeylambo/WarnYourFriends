import * as THREE from 'three';
import { RIM } from './render/toon';
import { TUNING, type AbilityId, type UpgradeId, type OutfitId, enableProto } from './tuning';
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
import { Vfx } from './render/vfx';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
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
import { dailyDay, dailySeed, encodeInputs, type BoardMode, type Submission } from './leaderboard/verify';
import { mountBoard, prefetchSeed, takeSeed } from './leaderboardClient';
import { Onboarding, type PromptId } from './onboarding';
import { AWARDS, loadProfile, modUnlocked, storyAskOffer, outfitUnlocked, record, rewardLine, saveProfile, upgradePool, type Award } from './awards';
import { GAME_SPEEDS, HUD_SIZES, loadSettings, saveSettings } from './settings';
import { applyStoredTuning, mountTuningPanel, tuningChanged } from './tuningPanel';
import { createGameApp, type InputDeviceFamily, type CoreSettings, type FrameAssembly, type GenreFrame, type RendererAdapter, type SLUWebShell } from '@slu/web-shell';

applyStoredTuning();
/** The pivot core loop (DECISIONS 2026-11-18) is the game (2026-11-24); ?classic=1 brings back the old loop for comparison. */
const PROTO = !new URLSearchParams(location.search).has('classic');
/** Playtest tools (play data export, live tuning on T): ?playtest=1 only, hidden from players (release pass, 2026-11-24). */
const PLAYTEST = new URLSearchParams(location.search).has('playtest');
/** No brake in the pivot loop (TUNING.proto.noBrake): its prompts, hints and binds are hidden. */
const NOBRAKE = PROTO && TUNING.proto.noBrake;
if (PROTO) {
  enableProto();
  document.documentElement.classList.add('proto');
}

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
const rampSlam = $('rampslam');
/** Fork taken (Mike, 2026-11-18): a station wipe names the new road, so the cut reads as TV, not a glitch. */
const forkWipe = $('forkwipe');
let forkSwap: { at: number; swap: () => void } | null = null;
forkWipe.addEventListener('animationend', () => forkWipe.classList.remove('in'));
// The slam plays once: drop its class when it ends, so a re-shown HUD never replays it over the recap.
rampSlam.addEventListener('animationend', () => rampSlam.classList.remove('in'));
/** Rampage tells (TUNING.rampageFx): the rim light heats, the screen edges glow. `rampK` eases 0..1. */
let rampK = 0;
let auraAcc = 0;
let lineAcc = 0;
let rimBaseStrength = RIM.strength.value;
const rimBaseColor = RIM.color.value.clone();
const rimHot = new THREE.Color(TUNING.rampageFx.rimColor);
function updateRampageFx(dt: number, now: number) {
  const F = TUNING.rampageFx;
  const want = sim.inRampage && !attract ? 1 : 0;
  rampK += (want - rampK) * Math.min(1, dt / F.ease);
  if (rampK < 0.002) rampK = 0;
  if (rampK === 0) rimBaseStrength = RIM.strength.value; // the look owns it while he's not in Rampage
  else {
    const throb = settings.reduceFlashes ? 1 : 1 + F.pulseAmp * Math.sin(now * Math.PI * 2 * F.pulseHz);
    // At night the rim heats right up; at dusk and in daylight it only tints (a bright rim there lifts his dark
    // silhouette off the bright road: the readability check caught it at 2.5:1). The edges and the swell carry it.
    const boost = lighting.mode === 'night' ? Math.max(rimBaseStrength * F.rimBoost, F.rimFloor) : rimBaseStrength * F.rimBoostLit;
    const hot = boost * throb;
    RIM.strength.value = rimBaseStrength + (hot - rimBaseStrength) * rampK;
  }
  RIM.color.value.copy(rimBaseColor).lerp(rimHot, rampK);
  // Never over the recap or the meeting (he can still be in Rampage when the broadcast ends).
  document.documentElement.classList.toggle('rampage', rampK > 0.5 && recapEl.hidden);
  document.documentElement.classList.toggle('reduceflashes', settings.reduceFlashes);
}
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
/** Ability levels on cards and the chip. */
const ROMAN = ['', 'I', 'II', 'III'];
const STUNT_LABEL: Record<string, string> = { rival: 'RIVAL NEWS VAN', medium: 'SMASH', heavy: 'HEAVY SMASH', unit: 'POLICE CAR', policeCrash: 'POLICE CRASH', collateral: 'COLLATERAL', nearMiss: 'NEAR MISS', ramDodge: 'DODGED', lostTrack: 'SHOOK ONE', chopperShaken: 'LOST THE CHOPPER', leapLand: 'LANDING', breakawayLand: 'BREAKAWAY', scoop: 'SCOOP', target: 'TARGET' };
let chainResultT = 0;
const gearPips = [...gearsEl.querySelectorAll('i')] as HTMLElement[];
const gearName = gearsEl.querySelector('.nm') as HTMLElement;
/** A shockwave waits for the first footfall after a gear-up (it lands with his foot). */
let gearShockPending = false;
const tierName = tierbar.querySelector('.name') as HTMLElement;
const tierMeter = tierbar.querySelector('.meter i') as HTMLElement;
const touchUi = $('touch-ui');
const camTag = $('camtag');
const clockEl = $('clock');
const clockLbl = $('clocklbl');
/** Chopper fuel (Mike, 2026-11-18: "no meter, it snuck up on me"): the whole segment drains a visible tank. */
const fuelEl = $('fuel');
const fuelBar = fuelEl.querySelector('i') as HTMLElement;
const brakeOnEl = $('brakeon');
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
/** Story run: the district title card. */
const districtEl = $('district');
districtEl.addEventListener('animationend', () => districtEl.classList.remove('in'));
let firstCardShown = false;
/** Prototype endless mode for the broadcast being played. */
let endlessMode = false;
/** Daily Endless (2026-11-24): today's road, the same for everyone, on its own board. */
let dailyMode = false;
function showDistrict(d: number) {
  const D = TUNING.proto.story.districts;
  districtEl.innerHTML = `<small>${d === D.length - 1 ? 'FINAL DISTRICT' : `DISTRICT ${d + 1} OF ${D.length}`}</small><b>${esc(D[d].name)}</b>`;
  districtEl.classList.remove('in');
  void districtEl.offsetWidth;
  districtEl.classList.add('in');
}
const abilEl = $('abil');
const abilName = abilEl.querySelector('.nm') as HTMLElement;
const abilIcon = abilEl.querySelector('.ic') as HTMLImageElement;
const abilKey = abilEl.querySelector('.key') as HTMLElement;
const abilCd = abilEl.querySelector('.cd i') as HTMLElement;
const abilBtn = $<HTMLButtonElement>('btn-ability');
/** Abilities stack (2026-11-17): slot 2's chip and touch button. */
const abil2El = $('abil2');
const chip2 = { el: abil2El, name: abil2El.querySelector('.nm') as HTMLElement, icon: abil2El.querySelector('.ic') as HTMLImageElement, key: abil2El.querySelector('.key') as HTMLElement, cd: abil2El.querySelector('.cd i') as HTMLElement, btn: $<HTMLButtonElement>('btn-ability2') };
const controlsEl = $('controls');

// --- Renderer ---------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
const RES = TUNING.look.resolution;
/** Adaptive resolution (phones): the pixel ratio steps down while frames drop and back up once they hold. */
const res = { max: Math.min(window.devicePixelRatio, RES.maxRatio), ratio: Math.min(window.devicePixelRatio, RES.maxRatio), slow: 0, fast: 0 };
renderer.setPixelRatio(res.ratio);
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Optional bloom (review #66; Settings → Bloom): lights, sparks and embers glow. Built on first use.
let composer: { c: EffectComposer; pass: RenderPass; bloom: UnrealBloomPass } | null = null;
function draw(cam: THREE.Camera) {
  if (!settings.bloom) {
    renderer.render(scene, cam);
    return;
  }
  if (!composer) {
    const c = new EffectComposer(renderer);
    const pass = new RenderPass(scene, cam);
    c.addPass(pass);
    const B = TUNING.look.bloom;
    const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), B.night.strength, B.radius, B.night.threshold);
    c.addPass(bloom);
    c.addPass(new OutputPass());
    c.setPixelRatio(renderer.getPixelRatio());
    c.setSize(window.innerWidth, window.innerHeight);
    composer = { c, pass, bloom };
  }
  composer.pass.camera = cam;
  // Bloom by the look: in daylight the road and cars are bright enough that night's threshold makes everything glow.
  const L = TUNING.look.bloom[lighting.mode];
  composer.bloom.strength = L.strength;
  composer.bloom.threshold = L.threshold;
  composer.c.render();
}
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
/** The Local News Awards: lifetime counters, awards won, the outfit worn (src/awards.ts). */
const profile = loadProfile();
/** Awards this broadcast just won (the recap shows them). */
let newAwards: Award[] = [];
let gait: Gait;
let director: Director;
let cruisers: CruiserView;
let units: UnitViews;
/** Phase 2: the broadcast has ended (busted or signed off); the recap follows. */
/** Seconds of (unpaused, time-scaled) play since the broadcast ended; -1 while it's on. */
let endedFor = -1;
let recapShown = false;
/** Editions: the edition a won run just unlocked (-1: none). */
let editionUnlocked = -1;
/** Story (prototype): the asks picked on the pre-show card for this run, and what finishing them unlocked. */
let storyPick: string[] = [];
let newUnlocks: string[] = [];
let modMult = 1;
/**
 * Sign-off outro (Mike, 2026-11-16: he ran "through the grass, not on the road"): after the exit the sim runs him
 * straight on, so he's drawn along the ramp's centreline instead (presentation only), while the chopper swivels into
 * Head-On; then the recap cuts in.
 */
let outro: { seg: ReturnType<Sim['track']['segmentAt']>; d: number; v: number; t: number } | null = null;
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
const vfx = new Vfx();
scene.add(vfx.group);
vfx.reduceFlashes = settings.reduceFlashes;
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
const input = new Input(canvas, $('btn-shoulder'), $('btn-pause'), $('btn-ability'), document.getElementById('btn-ability2'));
$('btn-cam').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  input.pressCamera();
});
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
  const ab2 = sim.ability2 ? TUNING.upgrades[sim.ability2] : null;
  const fire = settings.autoRampage ? 'it fires by itself' : `press ${k('shoulder')}`;
  const lines: Record<PromptId, string> = {
    lanes: PROTO ? `Change lanes ${k('lanes')}: weave through the traffic` : `Change lanes ${k('lanes')} and smash the traffic`,
    blocked: PROTO ? `Cars and trucks don't break until Rampage. Dodge them ${k('lanes')}` : `Bulldozers and armored trucks don't break. Change lanes ${k('lanes')}`,
    concrete: `Concrete and yellow-roof police lines only break in <b>RAMPAGE</b>. Save it, or go round`,
    meter: PROTO ? `Close dodges and yellow <b>SCOOPS</b> win the <b>AUDIENCE</b>. Full audience: <b>RAMPAGE</b>` : `Smash and dodge to fill the <b>RAMPAGE</b> meter`,
    ready: `<b>RAMPAGE READY</b> ${settings.autoRampage ? 'Here it goes' : `Press ${k('shoulder')}`}`,
    hit: PROTO ? `Hits lose the audience, and the police close in` : `Hits cost Rampage meter`,
    ram: `Police swerving in: dodge ${k('lanes')}`,
    rampage: `<b>RAMPAGE</b> Run through anything. Keep smashing to make it last`,
    audience: `Audience dropping: smash something`,
    kite: `Steer the police car beside you into what's ahead of it`,
    boxed: `Boxed in: ${k('brake')} and drop out the back, or Rampage through (${fire})`,
    caught: NOBRAKE ? 'Police on your tail: get back up to speed' : settings.brakeToggle ? `Police on your tail: press ${k('brake')} again and run` : `Police on your tail: let go of ${k('brake')} and run`,
    exit: `Exit open: get to the far-right lane`,
    ability: ab ? `<b>${esc(ab.label.toUpperCase())}</b> ${k('ability')} ${esc(ab.blurb)}` : '',
    ability2: ab2 ? `<b>${esc(ab2.label.toUpperCase())}</b> ${k('ability2')} ${esc(ab2.blurb)}` : '',
  };
  return lines[id];
});
/** Phase 3: the five-segment run (null in a single broadcast or the attract loop). */
let run: RunState | null = null;
let bulbT = 0;
let bulbFrames = 0;

const prev = { s: 0, d: 0, stepPos: 0 };
let started = false;
let paused = false;
/** A frame has been drawn since pausing (or resizing): skip rendering until unpaused. */
let pausedDrawn = false;
/** Half-seconds left in Rampage's warning, for its tick (-1 when not ending). */
let rampTick = -1;
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
let simOpts: { seed: number; segment: number; upgrades: UpgradeId[]; levels: Partial<Record<AbilityId, number>>; growth: boolean; guided?: boolean; edition?: number; endless?: boolean; asks?: string[]; mods?: string[] } = { seed: 0, segment: 0, upgrades: [], levels: {}, growth: false };
const inputLog: SimInput[] = [];
/** Leaderboard: this broadcast's (or run's) seed, each segment's inputs and the meeting buys, for the server to re-play. */
let lb: { mode: BoardMode; day?: number; seed: number; segments: string[]; buys: UpgradeId[][]; pool: UpgradeId[]; guided?: boolean; edition?: number } = { mode: 'broadcast', seed: 0, segments: [], buys: [], pool: [] };
/** Why this browser's scores can't go on the board (a setting that changes the sim), or null. */
const lbBlocked = () =>
  !PROTO
    ? 'Classic rules: this score stays off the board.'
    : flags.bot || flags.seg !== null || flags.ability || flags.heat !== null || flags.nodecay || flags.god || (flags.size !== null && flags.size !== 'growth') || tuningChanged()
    ? 'Debug or tuning settings are on, so this score stays off the board.'
    : settings.gameSpeed < 1
      ? 'Game Speed is below 100%, so this score stays off the board.'
      : null;
type Moment = { t: number; score: number; kind: string; event: SimEvent; headline: Headline | null };
let moment: Moment | null = null;
let replayRate = 1;
const replayEl = $('replay');
type Parked = { sim: Sim; highway: HighwayView; gait: Gait; cruisers: CruiserView; units: UnitViews; director: Director; news: Newsroom; bot: Bot | null; prev: typeof prev; runStats: typeof runStats; propKinds: Map<number, PropKind>; recent: SimEvent[] };
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

function newRun(seed: number, segment = 0, upgrades: UpgradeId[] = [], levels: Partial<Record<AbilityId, number>> = {}, guided = false) {
  firstCardShown = false;
  forkSwap = null; // a fork wipe from the last broadcast never swaps this one's road
  forkWipe.classList.remove('in');
  if (replay) {
    // A new broadcast mid-replay: drop the replay (its views go below) and the parked live ones.
    replay = null;
    replayRate = 1;
    document.documentElement.classList.remove('replay');
    replayEl.hidden = true;
  }
  if (highway) {
    scene.remove(highway.group);
    disposeTree(highway.group);
  }
  if (giant) {
    unplaceGiant();
    for (const o of giant.objects) giantSpace.remove(o);
  }
  if (cruisers) {
    scene.remove(cruisers.group);
    disposeTree(cruisers.group);
  }
  if (units) {
    scene.remove(units.group);
    disposeTree(units.group);
  }
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
  const edition = run?.edition ?? 0;
  const story = PROTO && !!run && !endlessMode && !attract && !flags.bot;
  const askOpts = story && storyPick.length ? { asks: [...storyPick] } : {};
  const modOpts = story && profile.mods.length ? { mods: [...profile.mods] } : {};
  sim = new Sim({ seed, segment, upgrades, levels, growth, guided, edition, ...(endlessMode ? { endless: true } : {}), ...askOpts, ...modOpts });
  document.documentElement.classList.toggle('endless', endlessMode);
  simOpts = { seed, segment, upgrades: [...upgrades], levels: { ...levels }, growth, guided, edition, ...(endlessMode ? { endless: true } : {}), ...askOpts, ...modOpts };
  // A fresh giant space for the new road: no anchor carried over, his starting size outright.
  gScale = sizeFor(0);
  gAnchor.x = gAnchor.z = 0;
  rig.giantScale = gScale;
  playLog.reset();
  inputLog.length = 0;
  input.resetLatches();
  audio.setGear(0, true);
  moment = null;
  preroll = null;
  recapShot = null;
  dropClip();
  highway = new HighwayView(sim);
  highway.onHonk = (v, at) => audio.honk(v, at);
  highway.onBrush = (at) => audio.scrape(at);
  giant = new GiantView();
  giant.setOutfit(profile.outfit);
  gait = new Gait();
  director = new Director(seed);
  director.enabled = settings.cameraCuts;
  cruisers = new CruiserView(sim);
  cruisers.reduceFlashes = settings.reduceFlashes;
  units = new UnitViews(sim, highway);
  vfx.reset();
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
  else {
    // Mike (2026-11-17): every broadcast opens on High Head-On, then swoops home (TUNING.camera.openingAngle).
    const open = director.open();
    if (open !== null) rig.cut(open, director.side, targetAt(g.s, g.d));
  }
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
  // Only his own run shakes the pad: never the attract broadcast behind the menus or a replay (Mike, 2026-11-24).
  if (ms <= 0 || !hapticsOn || attract || replay || !started) return;
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

/** The ability callouts ("Stuck the landing") are gone (Mike, 2026-11-17: excess copy); #abilpop stays hidden. */
const abilPop = $('abilpop');
let abilPopT = 0;

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
    const s = s0 + 3 + (A.reach[Math.max(0, sim.abilityLevel - 1)] * i) / N;
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
  app?.ui.show('gameplay-placeholder');
  const k = (a: GlyphAction) => (glyph(a) ? `<kbd>${esc(glyph(a))}</kbd>` : '');
  const at = TUNING.segment.exitOpensAt;
  const clock = `${Math.floor(at / 60)}:${String(at % 60).padStart(2, '0')}`;
  // First time (Mike, 2026-11-17: the first-time experience): three essentials, then the guided broadcast teaches
  // the rest as it happens. From the menu, the full How to Play.
  if (goLive) {
    recapEl.innerHTML = `<div class="card briefing first">
    <div class="kicker">YOU'RE GOING LIVE</div>
    <ol class="steps">
      <li><b>Run.</b> He never stops. ${k('lanes')} change lanes.</li>
      ${PROTO ? `<li><b>Dodge.</b> Weave through the traffic. Close calls win the audience; hits lose it, and the police close in.</li>
      <li><b>Rampage.</b> Full audience? ${settings.autoRampage ? 'It fires by itself' : `Press ${k('shoulder')}`} and he smashes everything.</li>` : `<li><b>Smash.</b> Run through the traffic. Go round bulldozers.</li>
      <li><b>Rampage.</b> Smashing fills the meter. Full? ${settings.autoRampage ? 'It fires by itself' : `Press ${k('shoulder')}`} and he runs through everything.</li>`}
    </ol>
    <p class="how">The producer will tell you the rest as it happens. Full rules: How to Play, on the menu.</p>
    <div class="row"><button class="go" id="brief-go">Go live</button></div>
  </div>`;
  } else
    recapEl.innerHTML = `<div class="card briefing">
    <div class="kicker">HOW TO PLAY</div>
    <ol class="steps">
      <li><b>Run.</b> He never stops. ${k('lanes')} change lanes, ${k('brake')} brake.</li>
      <li><b>Smash.</b> He flattens cars, carts and police cars. Bulldozers, armored trucks and a police car swerving into you don't break: go round. Concrete and yellow-roof police lines break only in Rampage. Hitting any of them costs Rampage meter.</li>
      <li><b>Rampage.</b> Smashes, close calls and combos fill the Rampage meter. When it's full, ${settings.autoRampage ? 'Rampage fires by itself' : `press ${k('shoulder')}`}: for 8 seconds he runs through everything, at double score. Keep smashing to make it last.</li>
      <li><b>Keep them watching.</b> Smashes, close calls and combos fill the audience bar. Empty, they cut to commercial.</li>
      <li><b>Lose the police.</b> Run a car beside you into whatever is in its lane. Slow down and they catch you: busted. Boxed in by the armored truck, brake out the back or Rampage through it.</li>
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
      // Seen once he goes live from it (a refresh on the briefing shows it again).
      try {
        localStorage.setItem(BRIEF_KEY, '1');
      } catch {
        /* storage unavailable: it shows again next time */
      }
      document.documentElement.classList.remove('briefing');
      hideRecap();
      resolve();
    };
    $<HTMLButtonElement>('brief-go').onclick = () => briefingClose?.();
    $<HTMLButtonElement>('brief-go').focus();
  });
}

/** The Local News Awards (main menu): every award, its progress and what it gives, and the outfit picker. */
/**
 * Story pre-show (Mike, 2026-11-19): the producer's asks for the whole run, picked before going live (up to
 * `storyPick`), and the traffic mods he's unlocked. Resolves true to go live, false for Back.
 */
function openPreShow(): Promise<boolean> {
  const P = TUNING.proto;
  const offer = storyAskOffer(profile, (n) => Math.floor(Math.random() * n)); // cosmetic order
  const picked = new Set(offer.open.filter((a) => !profile.asksDone.includes(a.id)).slice(0, P.storyPick).map((a) => a.id));
  for (const a of offer.open) if (picked.size < P.storyPick) picked.add(a.id);
  const tierName = ['', 'EASY', 'MEDIUM', 'HARD'];
  const draw = () => {
    const ask = (a: (typeof P.storyAsks)[number], locked: boolean) => {
      const on = picked.has(a.id);
      const done = profile.asksDone.includes(a.id);
      const req = a.requires ? P.storyAsks.find((x) => x.id === a.requires) : null;
      const reward = a.unlock ? `Unlocks ${P.mods[a.unlock].label}` : '';
      const sub = locked ? `First: ${req?.text.replace('{n}', String(req.n)) ?? ''}` : [done ? 'Done before' : '', reward].filter(Boolean).join(' · ');
      return `<button class="go alt ask t${a.tier}${on ? ' on' : ''}${locked ? ' locked' : ''}" data-a="${a.id}" ${locked ? 'disabled' : ''}><em>${tierName[a.tier]}</em><b>${esc(a.text.replace('{n}', String(a.n)))}</b>${sub ? `<small>${esc(sub)}</small>` : ''}<i>${locked ? '🔒' : on ? '✓' : ''}</i></button>`;
    };
    const mods = Object.entries(P.mods).map(([id, m]) => {
      const open = PLAYTEST || modUnlocked(profile, id); // ?playtest=1: every mod open to try
      const on = profile.mods.includes(id);
      const by = P.storyAsks.find((a) => a.unlock === id);
      return `<button class="go alt mod${on ? ' on' : ''}" data-m="${id}" ${open ? '' : 'disabled'}><b>${esc(m.label)}</b><small>${open ? `${esc(m.how)} · ×${m.score}` : `🔒 ${esc(by?.text.replace('{n}', String(by.n)) ?? '')}`}</small></button>`;
    }).join('');
    const mult = profile.mods.reduce((k, m) => k * P.mods[m].score, 1);
    recapEl.innerHTML = `<div class="card briefing preshow">
      <div class="kicker">TONIGHT'S RUNDOWN · PICK ${P.storyPick}</div>
      <p class="how">The producer wants these on air before the sign-off. They last the whole run.</p>
      <div class="asks-pick">${offer.open.map((a) => ask(a, false)).join('')}${offer.locked.map((a) => ask(a, true)).join('')}</div>
      <div class="kicker sub">TRAFFIC MODS${mult !== 1 ? ` · SCORE ×${mult.toFixed(2).replace(/\.?0+$/, '')}` : ''}</div>
      <div class="mods">${mods}</div>
      <div class="row"><button class="go" id="ps-go">Go Live</button><button class="go alt" id="ps-back">Back</button></div>
    </div>`;
    for (const b of recapEl.querySelectorAll<HTMLButtonElement>('.ask'))
      b.onclick = () => {
        const id = b.dataset.a!;
        if (picked.has(id)) picked.delete(id);
        else if (picked.size < P.storyPick) picked.add(id);
        draw();
        recapEl.querySelector<HTMLButtonElement>(`.ask[data-a="${id}"]`)?.focus();
      };
    for (const b of recapEl.querySelectorAll<HTMLButtonElement>('.mod'))
      b.onclick = () => {
        const id = b.dataset.m!;
        profile.mods = profile.mods.includes(id) ? profile.mods.filter((x) => x !== id) : [...profile.mods, id];
        saveProfile(profile);
        draw();
        recapEl.querySelector<HTMLButtonElement>(`.mod[data-m="${id}"]`)?.focus();
      };
    $<HTMLButtonElement>('ps-go').onclick = () => finish(true);
    $<HTMLButtonElement>('ps-back').onclick = () => finish(false);
  };
  let finish: (go: boolean) => void = () => {};
  app?.ui.show('gameplay-placeholder');
  recapEl.hidden = false;
  recapArmedAt = performance.now() + 250;
  document.documentElement.classList.add('briefing');
  draw();
  $<HTMLButtonElement>('ps-go').focus();
  return new Promise((resolve) => {
    finish = (go: boolean) => {
      briefingClose = null;
      storyPick = P.storyAsks.filter((a) => picked.has(a.id)).map((a) => a.id);
      document.documentElement.classList.remove('briefing');
      hideRecap();
      resolve(go);
    };
    briefingClose = () => finish(false);
  });
}

function openAwards(): Promise<void> {
  const fmt = (n: number) => Math.round(n).toLocaleString();
  const portraits = outfitPortraits();
  const draw = () => {
    const C = profile.counts;
    const rows = AWARDS.map((a) => {
      const won = profile.won.includes(a.id);
      const have = Math.min(a.n, C[a.stat]);
      const reward = rewardLine(a);
      const pct = won ? 100 : (have / a.n) * 100;
      return `<li class="${won ? 'won' : ''}"><i class="medal" style="--p:${pct.toFixed(1)}%"><b>${won ? '★' : `${Math.floor(pct)}%`}</b></i><div><b>${esc(a.title)}</b><span>${esc(a.how)}</span>${reward ? `<em class="reward">${esc(reward)}</em>` : ''}${won ? '' : `<small>${fmt(have)} / ${fmt(a.n)}</small>`}</div></li>`;
    }).join('');
    const outfits = (Object.keys(TUNING.outfits) as OutfitId[])
      .map((id) => {
        const open = outfitUnlocked(profile, id);
        const by = AWARDS.find((a) => a.outfit === id);
        const O = TUNING.outfits[id];
        const pic = portraits[id];
        const left = by && !open ? `${fmt(Math.min(by.n, C[by.stat]))} / ${fmt(by.n)}` : '';
        return `<button class="go alt outfit${profile.outfit === id ? ' on' : ''}${open ? '' : ' locked'}" data-o="${id}" ${open ? '' : 'disabled'}>
          <span class="pic">${pic ? `<img src="${pic}" alt="">` : ''}${O.plate !== null ? '<i class="tag">ARMOR</i>' : ''}${open ? '' : '<i class="lock">🔒</i>'}</span>
          <b>${esc(O.label)}</b>${open ? (profile.outfit === id ? '<small>Wearing</small>' : '') : `<small>${esc(by?.title ?? '')} · ${left}</small>`}</button>`;
      })
      .join('');
    recapEl.innerHTML = `<div class="card briefing awards">
      <div class="kicker">THE LOCAL NEWS AWARDS</div>
      <div class="kicker sub">WARDROBE</div>
      <div class="outfits">${outfits}</div>
      <div class="kicker sub">AWARDS · ${profile.won.length} / ${AWARDS.length}</div>
      <ul class="aw">${rows}</ul>
      <div class="row"><button class="go" id="aw-back">Back</button></div>
    </div>`;
    for (const b of recapEl.querySelectorAll<HTMLButtonElement>('.outfit'))
      b.onclick = () => {
        profile.outfit = b.dataset.o as typeof profile.outfit;
        saveProfile(profile);
        giant.setOutfit(profile.outfit);
        draw();
        recapEl.querySelector<HTMLButtonElement>(`.outfit[data-o="${profile.outfit}"]`)?.focus();
      };
    $<HTMLButtonElement>('aw-back').onclick = () => close?.();
  };
  app?.ui.show('gameplay-placeholder');
  recapEl.hidden = false;
  recapArmedAt = performance.now() + 250;
  document.documentElement.classList.add('briefing');
  let close: (() => void) | null = null;
  draw();
  $<HTMLButtonElement>('aw-back').focus();
  return new Promise((resolve) => {
    close = briefingClose = () => {
      briefingClose = null;
      document.documentElement.classList.remove('briefing');
      hideRecap();
      resolve();
    };
  });
}

/** Settings → Controls: rebind the keyboard (accessibility, 2026-11-17). One key per action; a key taken by another action swaps. */
function openControls(): Promise<void> {
  const NAMES: Record<KeyAction, string> = { left: 'Lane left', right: 'Lane right', brake: 'Brake', shoulder: 'Rampage', ability: 'Ability', ability2: 'Ability 2' };
  const current = (): Record<KeyAction, string> => settings.keys ?? (Object.fromEntries(KEY_ACTIONS.map((a) => [a, DEFAULT_KEYS[a][0]])) as Record<KeyAction, string>);
  let waiting: KeyAction | null = null;
  const draw = () => {
    const K = current();
    recapEl.innerHTML = `<div class="card briefing controls">
      <div class="kicker">CONTROLS · KEYBOARD</div>
      <ul class="binds">${KEY_ACTIONS.filter((a) => !(NOBRAKE && a === 'brake')).map((a) => `<li><span>${NAMES[a]}</span><button class="go alt bind" data-a="${a}">${waiting === a ? 'Press a key…' : `<kbd>${esc(keyLabel(K[a]))}</kbd>`}</button></li>`).join('')}</ul>
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

/** Upgrades still locked behind an award: shown dimmed under the offers, with the award and the progress to it. */
function lockedCards(): string {
  const locked = AWARDS.filter((a) => a.upgrade && !profile.won.includes(a.id));
  if (!locked.length) return '';
  return `<div class="locked"><div class="hd">Locked · win an award to add it to the meeting</div><div class="row">${locked
    .map((a) => {
      const u = TUNING.upgrades[a.upgrade!];
      const have = Math.min(profile.counts[a.stat], a.n);
      return `<div class="lock"><span class="art"><img src="${UPGRADE_ART[a.upgrade!]}" alt="" /></span><div><b>${esc(u.label)}</b><small>${esc(a.title)}: ${esc(a.how)} · ${have.toLocaleString()}/${a.n.toLocaleString()}</small><i style="--p:${((have / a.n) * 100).toFixed(0)}%"></i></div></div>`;
    })
    .join('')}</div></div>`;
}

function showMeeting(focusId?: string) {
  if (!run) return;
  const r = run;
  const offers = r.offers();
  const held = r.abilities;
  const slots = TUNING.run.abilitySlots;
  // Mike (2026-11-17): the meeting stays open: buy what the budget allows (each pitch once), then go live.
  recapEl.innerHTML = `<div class="card meeting">
    <div class="kicker">PRODUCER'S MEETING · BEFORE SEGMENT ${r.segment + 2} OF ${TUNING.run.segments}</div>
    <div class="purse">Budget <b>${r.purse.toLocaleString()}</b></div>
    <p class="how">Your stunts pay for these. Buy as many as you can afford; spending never lowers your score. Abilities stack: up to ${slots}, each on its own button.</p>
    <div class="pitches">${offers
      .map((id) => {
        const u = TUNING.upgrades[id];
        const bought = r.bought.includes(id);
        // An ability you hold comes back as its next level.
        const lv = u.kind === 'ability' ? r.levelOf(id as AbilityId) : 0;
        const next = bought ? lv : lv ? lv + 1 : 0;
        const slot = u.kind === 'ability' && !lv && !bought ? `<small class="swap">Ability slot ${held.length + 1} of ${slots}</small>` : '';
        const price = r.priceOf(id);
        const title = next > 1 ? `${u.label} ${ROMAN[next]}` : u.label;
        const blurb = next > 1 && u.levels ? u.levels[next - 1] : u.blurb;
        const can = !bought && r.canAfford(id);
        return `<button class="pitch ${u.kind}${next > 1 ? ' levelup' : ''}${bought ? ' bought' : ''}" data-id="${id}" ${can ? '' : 'disabled'}>
          <span class="art"><img src="${UPGRADE_ART[id]}" alt="" /><span class="tag">${bought ? 'BOUGHT' : next > 1 ? `LEVEL ${ROMAN[next]}` : u.kind === 'ability' ? 'ABILITY' : 'PASSIVE'}</span></span>
          <b>${esc(title)}</b><span class="blurb">${esc(blurb)}</span>${slot}${bought ? '<span class="price">Bought ✓</span>' : `<span class="price">${price.toLocaleString()}</span>${can ? '' : `<small class="need">Need ${(price - r.purse).toLocaleString()} more</small>`}`}</button>`;
      })
      .join('')}</div>
    ${lockedCards()}
    <div class="row"><button class="go" id="skip">Go live</button></div>
    <div class="padhint"></div>
  </div>`;
  recapArmedAt = performance.now() + 250;
  const got = (lb.buys[r.segment] ??= []);
  for (const b of recapEl.querySelectorAll<HTMLButtonElement>('.pitch'))
    b.onclick = () => {
      const id = b.dataset.id as UpgradeId;
      if (!r.buy(id)) return;
      got.push(id);
      audio.tierUp(1);
      showMeeting(id);
    };
  ($('skip') as HTMLButtonElement).onclick = () => r.nextSegment() && nextSegment();
  const keep = focusId ? recapEl.querySelector<HTMLButtonElement>(`.pitch[data-id="${focusId}"]:not([disabled])`) : null;
  (keep ?? recapEl.querySelector<HTMLButtonElement>('.pitch:not([disabled])') ?? $<HTMLButtonElement>('skip')).focus();
}

/** The next segment of the run: a new road, Heat starts higher, the upgrades come along. */
function nextSegment() {
  if (!run) return;
  newRun(run.segmentSeed(), run.segment, run.owned, run.levels);
  bot = flags.bot ? new Bot(sim) : null;
  menuGuard = 10;
}

/** Always a next goal (Mike, 2026-11-17: "no reason to play more"): the closest award not yet won, with progress. */
function nextAwardLine(): string {
  if (bot) return '';
  const left = AWARDS.filter((a) => !profile.won.includes(a.id)).map((a) => ({ a, have: Math.min(profile.counts[a.stat], a.n) })).sort((x, y) => y.have / y.a.n - x.have / x.a.n);
  const next = left[0];
  if (!next) return '';
  const reward = rewardLine(next.a);
  return `<div class="rc-next"><small>NEXT AWARD</small><b>${esc(next.a.title)}</b><span>${esc(next.a.how)} · ${next.have.toLocaleString()}/${next.a.n.toLocaleString()}${reward ? ` · ${esc(reward)}` : ''}</span><i style="--p:${((next.have / next.a.n) * 100).toFixed(0)}%"></i></div>`;
}

/** The 11 O'Clock Recap (§20: results as the evening news). */
/**
 * The unlock stinger (Mike, 2026-11-24: "more lively unlocks (pop-up screens)"): one card per new award or traffic mod,
 * full screen over the replay's last frame, with its art, a slam-in, a shine, a sting and a rumble. A press moves on;
 * each card also moves on by itself after `unlockHold` s. Never for the bot or in step mode (tests and evidence).
 */
function showUnlocks(done: () => void, force = false) {
  const items: { kicker: string; title: string; sub: string; art: string }[] = [];
  // An outfit shows as its colours (cape cloth over its plates, the hem band): a portrait render needs him in shot.
  const hex = (c: number | null | undefined, d: number) => `#${(c ?? d).toString(16).padStart(6, '0')}`;
  const swatch = (o: OutfitId) => {
    const O = TUNING.outfits[o];
    return `<span class="u-swatch" style="--cloth:${hex(O.cape ?? O.cloth ?? O.full, PALETTE.giantCape)};--plate:${hex(O.plate ?? O.full, PALETTE.giantBone)};--band:${hex(O.band, PALETTE.giantBone)}"></span>`;
  };
  for (const a of newAwards) {
    const art = a.outfit ? swatch(a.outfit) : a.upgrade ? `<img src="${UPGRADE_ART[a.upgrade]}" alt="" />` : '<i>★</i>';
    items.push({ kicker: a.outfit ? 'NEW OUTFIT' : a.upgrade ? 'NEW UPGRADE' : 'AWARD', title: a.outfit ? TUNING.outfits[a.outfit].label : a.title, sub: a.outfit || a.upgrade ? a.title : a.how, art });
  }
  for (const m of newUnlocks) items.push({ kicker: 'TRAFFIC MOD', title: TUNING.proto.mods[m].label, sub: `${TUNING.proto.mods[m].how} · score ×${TUNING.proto.mods[m].score}`, art: `<i>×${TUNING.proto.mods[m].score}</i>` });
  if (!items.length || (!force && (bot || flags.stepMode || attract))) return done();
  const el = document.createElement('div');
  el.id = 'unlock';
  document.body.appendChild(el);
  let i = -1;
  let timer = 0;
  const step = () => {
    clearTimeout(timer);
    i++;
    if (i >= items.length) {
      el.remove();
      removeEventListener('keydown', press, true);
      el.removeEventListener('pointerdown', press);
      clearInterval(pad);
      done();
      return;
    }
    const it = items[i];
    el.innerHTML = `<div class="u-card"><small>UNLOCKED · ${esc(it.kicker)}</small><div class="u-art">${it.art}</div><b>${esc(it.title)}</b><span>${esc(it.sub)}</span></div>`;
    audio.chainTick(4);
    setTimeout(() => audio.chainTick(6), 140);
    haptic(220, 0.8);
    timer = window.setTimeout(step, TUNING.replay.unlockHold * 1000);
  };
  const armedAt = performance.now() + 400;
  const press = (e: Event) => {
    if (performance.now() < armedAt) return;
    e.preventDefault();
    e.stopPropagation();
    step();
  };
  addEventListener('keydown', press, true);
  el.addEventListener('pointerdown', press);
  let held = true;
  const pad = window.setInterval(() => {
    const down = [...(navigator.getGamepads?.() ?? [])].some((g) => g?.buttons[0]?.pressed);
    if (down && !held && performance.now() >= armedAt) step();
    held = down;
  }, 50);
  step();
}

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
  // Three ways to lose, each its own package (review pick 1): the police, the audience, the exit.
  const lost = reason === 'pin' ? 'busted' : reason === 'ratings' ? 'commercial' : 'signal';
  const stamp = won ? 'FULL BROADCAST' : cleared ? 'SIGNED OFF' : lost === 'busted' ? 'BUSTED' : lost === 'commercial' ? 'CUT TO COMMERCIAL' : 'SIGNAL LOST';
  // A win needs no caption (Mike, 2026-11-24: no excessive copy); a loss says what ended it.
  const why = won || cleared ? '' : reason === 'pin' ? (sim.show.pinCause === 'caught' ? 'The police caught up.' : 'Boxed in by the police.') : reason === 'ratings' ? 'The viewers changed the channel.' : 'He missed the exit.';
  // Hero numbers: what this screen is about. A run segment reports the budget; a finished run, the run.
  const hero = run && run.phase === 'meeting'
    ? Math.round(sh.banked) === run.purse ? [['Budget', n(run.purse), 'score']] : [['Added to budget', `+${n(sh.banked)}`, 'score'], ['Budget', n(run.purse), '']]
    : run
      ? [['Run score', n(run.earned), 'score'], ['Segments cleared', `${run.results.filter((x) => x.cleared).length}<small>/${N}</small>`, '']]
      : [['Score', n(sh.banked), 'score'], ['Peak audience', viewers(sh.peak), '']];
  const tiles: [string, string][] = [
    // Endless: how far he got is the headline stat.
    ...(sim.endless ? [['Distance', `${(sim.giant.s / 1000).toFixed(2)} km`] as [string, string]] : []),
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
  rampSlam.classList.remove('in');
  document.documentElement.classList.remove('rampage');
  recapEl.innerHTML = `<div class="rc ${cleared || won ? 'cleared' : 'busted'}">
    ${run ? `<header class="rc-top"><div class="kicker">SEGMENT ${run.segment + 1} OF ${N}</div></header>` : ''}
    <section class="rc-lead">
      <div class="rc-stamp"><span class="outcome ${cleared || won ? 'cleared' : lost}">${stamp}</span>${why ? `<span class="why">${why}</span>` : ''}</div>
      <div class="rc-hero">${hero.map(([k, v, c]) => `<div class="${c}"><small>${k}</small><b>${v}</b></div>`).join('')}</div>
      <div class="rc-tiles">${tiles.map(([k, v]) => `<div><b>${v}</b><small>${k}</small></div>`).join('')}</div>
      ${newAwards.map((a) => `<div class="rc-award"><small>AWARD</small><b>${esc(a.title)}</b>${rewardLine(a) ? `<span>${esc(rewardLine(a))}</span>` : ''}</div>`).join('')}
      ${newUnlocks.map((m) => `<div class="rc-award"><small>TRAFFIC MOD UNLOCKED</small><b>${esc(TUNING.proto.mods[m].label)}</b><span>${esc(TUNING.proto.mods[m].how)}. Score ×${TUNING.proto.mods[m].score}. Switch it on before you go live.</span></div>`).join('')}
      ${modMult !== 1 ? `<div class="rc-award"><small>TRAFFIC MODS</small><b>Score ×${modMult.toFixed(2).replace(/\.?0+$/, '')}</b><span>${esc(sim.mods.map((m) => TUNING.proto.mods[m].label).join(' · '))}</span></div>` : ''}
      ${editionUnlocked > 0 ? `<div class="rc-award"><small>NEW EDITION</small><b>${esc(TUNING.editions[editionUnlocked].name)}</b><span>Harder, score ×${TUNING.editions[editionUnlocked].score}. Pick it on the main menu.</span></div>` : ''}
      ${nextAwardLine()}
    </section>
    <aside class="rc-side">
      ${shot}
      ${asks.length ? `<div class="rc-asks"><div class="hd">Producer's asks <span>${asks.filter((a) => a.done).length}/${asks.length}</span></div><ul>${asks.map((a) => `<li class="${a.done ? 'done' : a.failed ? 'failed' : ''}"><i>${a.done ? '✓' : a.failed ? '✕' : ''}</i><span>${esc(a.text)}</span>${a.done && a.reward ? `<b>+${n(a.reward)}</b>` : ''}</li>`).join('')}</ul></div>` : ''}
      ${over ? '<div class="rc-board" hidden></div>' : ''}
      <blockquote class="anchor">“${esc(viewer.text)}”${viewer.who ? `<cite>${esc(viewer.who)}</cite>` : ''}</blockquote>
    </aside>
    <footer class="rc-foot">
      <div class="row">${buttons}</div>
      <div class="rc-meta"><span class="bests"></span></div>
      <div class="padhint"></div>
    </footer>
  </div>
  ${PLAYTEST ? '<button class="playdata" id="playdata">Copy play data</button>' : ''}`;
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
      : { mode: lb.mode, seed: lb.seed, growth: simOpts.growth, segments: lb.segments, buys: lb.buys, pool: lb.pool, ...(lb.guided ? { guided: true } : {}), ...(lb.edition ? { edition: lb.edition } : {}), ...(lb.day !== undefined ? { day: lb.day } : {}), ...(simOpts.asks ? { asks: simOpts.asks } : {}), ...(simOpts.mods ? { mods: simOpts.mods } : {}), claimed: Math.round(run ? run.earned : sim.show.banked) };
    mountBoard(boardEl, lb.mode, sub, blocked ?? undefined, lb.day);
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
  chyKicker.classList.toggle('busted', ['BUSTED', 'CUT TO COMMERCIAL', 'SIGNAL LOST'].includes(h.kicker));
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
      // Light things (yellow items, Scoops) get the light impact: no hitstop (Mike, 2026-11-24: pickups lagged).
      const k = e.cls === 'heavy' ? I.heavy : e.cls === 'light' ? I.light : I.medium;
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
      {
        // Smoke on a heavy, a little dust on a medium; sparks off metal (review #64).
        const V = TUNING.vfx;
        sim.track.posAt(e.s, e.d, pos);
        const [n, size, life, alpha] = e.cls === 'heavy' ? V.heavySmoke : V.mediumDust;
        if (e.cls === 'heavy' || e.cls === 'medium') vfx.puff(pos.x, 0.6, pos.z, n, e.cls === 'heavy' ? 0x8b857c : 0xa49987, size, life, alpha);
        if (e.mat === 'metal') vfx.spark(pos.x, 1, pos.z, dirX, dirZ, e.cls === 'heavy' ? V.metalSparks : V.metalSparks / 2);
      }
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
      vfx.spark(pos.x, 1.2, pos.z, -Math.cos(h), -Math.sin(h), TUNING.vfx.bounceSparks);
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
      if (e.cause !== 'rampage' && e.delta > 0) gainFlash();
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
    case 'target': {
      // Target car crushed: a burst of orange rings, the chain sting twice, a solid rumble (bigger in Rampage).
      sim.track.posAt(e.s, e.d, pos);
      highway.ring(pos.x, pos.z, e.rampage ? 14 : 10, 0xff7a1a, 0.6, 0.95);
      highway.ring(pos.x, pos.z, e.rampage ? 8 : 6, 0xffffff, 0.45, 0.9);
      audio.chainTick(6);
      setTimeout(() => audio.chainTick(8), 120);
      haptic(e.rampage ? 260 : 180, e.rampage ? 1 : 0.8);
      break;
    }
    case 'scoop':
      // Prototype collectible: a bright ding (the chain tick, a step up), the smash event already threw its confetti.
      audio.chainTick(3);
      break;
    case 'zone': {
      // Story run: a title card as he enters each district (never covers the road; fades on its own).
      const d = PROTO && !replay ? sim.track.segmentAt(sim.giant.s).district : undefined;
      if (d !== undefined && !attract) showDistrict(d);
      break;
    }
    case 'exitOpen':
      highway.rebuild([e.segment - 1, e.segment, e.segment + 1, e.segment + 2]);
      break;
    case 'forkOpen':
      // The ramp opens on segments already built ahead; the exit sign on the gantry calls it.
      highway.rebuild([e.segment - 1, e.segment, e.segment + 1, e.segment + 2]);
      break;
    case 'fork':
      if (e.taken) {
        // The station wipes to the avenue: the last frame holds under the incoming wipe, and the road is rebuilt and the
        // camera cut once the wipe covers the screen (Mike, 2026-11-18: the bare cut read as a glitch).
        const swap = () => {
          highway.rebuildFrom(e.from);
          gait.reset();
          prev.s = sim.giant.s;
          prev.d = sim.giant.d;
          prev.stepPos = sim.giant.stepPos;
          rig.cut(director.current, director.side, targetAt(sim.giant.s, sim.giant.d));
          showCamTag();
        };
        if (replay || attract || flags.stepMode) {
          swap();
          flash(TUNING.camera.cutFlashFrames);
        } else {
          (forkWipe.querySelector('span') as HTMLElement).textContent = e.name.toUpperCase();
          forkWipe.classList.remove('in');
          void forkWipe.offsetWidth;
          forkWipe.classList.add('in');
          forkSwap = { at: performance.now() / 1000 + TUNING.camera.forkWipeCover, swap };
        }
      }
      break;
    case 'signOff': {
      const ex = sim.exit;
      const seg = ex ? sim.track.segments.find((x) => x.index === ex.segment) : undefined;
      // Start the outro where he is, moving as he was (a lane change onto the ramp keeps its sideways speed).
      if (seg) outro = { seg, d: sim.giant.d, v: (sim.giant.d - prev.d) / SIM_DT, t: 0 };
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
      if (!e.ok) audio.dud();
      else if (e.id === 'leap' || e.id === 'breakaway') {
        if (e.id === 'leap') audio.leap();
        else audio.breakaway();
        // Takeoff: a ring and a burst of dust off the road where he left it.
        sim.track.posAt(g.s, g.d, pos);
        highway.ring(pos.x, pos.z, 7, PALETTE.dust, 0.5, 0.8);
        highway.spawnDebris(pos.x, pos.z, Math.cos(h), Math.sin(h), 3, 16, [PALETTE.dust, 0x8d8579], [0.15, 0.4], 1.2);
        rig.jolt(1.5, 0.1);
        rig.tierUpPulse(); // the chopper pulls out so the arc reads
      }
      {
        const chip = e.slot === 2 ? abil2El : abilEl;
        chip.classList.remove('fire');
        void chip.offsetWidth;
        chip.classList.add('fire');
      }
      break;
    case 'groundZero': {
      // Ground Zero (passive): the blast as Rampage fires, twelve metres round.
      sim.track.posAt(e.s, e.d, pos);
      const R = TUNING.passives.groundZeroRadius;
      highway.ring(pos.x, pos.z, R * 1.1, 0xffb070, 0.6, 0.9);
      highway.ring(pos.x, pos.z, R * 0.6, 0xffffff, 0.5, 0.8);
      highway.crack(pos.x, pos.z, h);
      audio.land();
      break;
    }
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
      break;
    }
    case 'breakawayLand': {
      sim.track.posAt(e.s, e.d, pos);
      highway.ring(pos.x, pos.z, 13, 0xffffff, 0.55, 0.9);
      highway.ring(pos.x, pos.z, 7, PALETTE.dust, 0.7, 0.7);
      highway.crack(pos.x, pos.z, h);
      highway.spawnDebris(pos.x, pos.z, Math.cos(h), Math.sin(h), 6, 18, [PALETTE.dust, 0x8d8579], [0.15, 0.45], 1.6);
      audio.land();
      hitstop = Math.max(hitstop, TUNING.impact.heavy.hitstop);
      rig.jolt(TUNING.impact.heavy.shake * 1.4, TUNING.camera.joltTime);
      flash(TUNING.impact.heavy.flashFrames);
      haptic(170, 0.9);
      pip.trigger(sim, sim.show.tier);
      break;
    }
    case 'primeTime':
      document.documentElement.classList.toggle('prime', e.on);
      if (e.on) {
        audio.primeTime();
        pip.trigger(sim, sim.show.tier, true);
      }
      break;
    case 'thickSkin':
      audio.knock();
      gearsEl.classList.remove('skin');
      void gearsEl.offsetWidth;
      gearsEl.classList.add('skin');
      break;
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
      // Readable from the chopper (Mike, 2026-11-24: "hard to tell when cars are kited into a crash"; on the bridge
      // they seemed to vanish): the cruiser tumbles where it crashed instead of flying out of frame, under a
      // siren-coloured flash and a column of smoke.
      units.smash(e.id, Math.cos(h), Math.sin(h), Math.min(e.speed, TUNING.vfx.crashTumble), side);
      sim.track.posAt(e.s, e.d, pos);
      highway.ring(pos.x, pos.z, 10, 0xff2b3a, 0.55, 0.9);
      highway.ring(pos.x, pos.z, 6, 0x3a6bff, 0.7, 0.9);
      if (e.propSmashed) (e.propId >= 1_000_000 ? units : highway).smash(e.propId, Math.cos(h), Math.sin(h), e.speed * 0.6, side);
      audio.smash('heavy', where(e.s, e.d));
      {
        // The wreck: sparks off the bodywork, a cloud, and tyre marks where it braked (review #64).
        const V = TUNING.vfx;
        sim.track.posAt(e.s, e.d, pos);
        const [n, size, life, alpha] = V.crashSmoke;
        vfx.puff(pos.x, 0.7, pos.z, n, 0x77716a, size, life, alpha);
        vfx.spark(pos.x, 0.9, pos.z, Math.cos(h), Math.sin(h), V.crashSparks);
        sim.track.posAt(e.s - 4, e.d, pos);
        vfx.skid(pos.x, pos.z, h, 7);
      }
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
    case 'meterFull':
      audio.tierUp(1);
      break;
    case 'rampageStart': {
      // Activation (Mike, 2026-11-17: "a bit more prominence"): a beat of hit-pause, a slam across the screen, a
      // flash, a jolt and a rumble, on top of the gear-up's shockwave, punch and stinger.
      const R = TUNING.rampageFx;
      if (!attract && !replay) {
        hitstop = Math.max(hitstop, R.slamHitstop);
        rampSlam.classList.remove('in');
        void rampSlam.offsetWidth;
        rampSlam.classList.add('in');
        flash(R.slamFlash);
        haptic(R.slamHaptic, 0.9);
      }
      rig.jolt(R.slamShake, 0.25);
      break;
    }
    case 'meterLoss':
      gearsEl.classList.remove('lost');
      void gearsEl.offsetWidth;
      gearsEl.classList.add('lost');
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
    if (!['BUSTED', 'CUT TO COMMERCIAL', 'SIGNAL LOST', 'SIGN-OFF'].includes(h.kicker) && sim.show.ratings >= runStats.bestRatings) {
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
/**
 * Run end (Mike, 2026-11-19: "Dissolve transition FX on run end"): the last live frame breaks up block by block, in
 * random order, over what comes next. Copied in the same task as a render (the drawing buffer is still there).
 */
function dissolveOut() {
  const R = TUNING.replay;
  renderer.render(scene, rig.camera);
  const rect = canvas.getBoundingClientRect();
  const c = document.createElement('canvas');
  c.width = canvas.width;
  c.height = canvas.height;
  const g = c.getContext('2d');
  if (!g) return;
  g.drawImage(canvas, 0, 0);
  Object.assign(c.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, zIndex: '40', pointerEvents: 'none' });
  document.body.appendChild(c);
  const B = Math.max(4, Math.round(R.dissolveBlock * (canvas.width / Math.max(1, rect.width))));
  const cols = Math.ceil(c.width / B);
  const order = Array.from({ length: cols * Math.ceil(c.height / B) }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1)); // cosmetic
    [order[i], order[j]] = [order[j], order[i]];
  }
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const t0 = performance.now();
  let done = 0;
  const tick = () => {
    const k = Math.min(1, (performance.now() - t0) / (R.dissolve * 1000));
    if (reduce) c.style.opacity = String(1 - k);
    else {
      // Eased: a few blocks first, then it goes all at once (a signal giving out).
      const upto = Math.floor(order.length * k * k);
      for (; done < upto; done++) g.clearRect((order[done] % cols) * B, Math.floor(order[done] / cols) * B, B, B);
    }
    if (k < 1) requestAnimationFrame(tick);
    else c.remove();
  };
  requestAnimationFrame(tick);
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
    case 'breakawayLand': sc = S.breakawayLand + e.smashed + e.shaken; break;
    case 'nearMiss': sc = S.nearMiss; break;
    case 'ram': sc = e.hit ? 0 : S.ramMiss; break;
  }
  if (sc > 0 && (!moment || sc >= moment.score)) moment = { t: sim.time, score: sc, kind: e.type, event: e, headline: null };
}

function replayInput(): SimInput {
  return replay ? inputLog[replay.sim.tick] ?? NO_INPUT : NO_INPUT;
}

/**
 * Free a dropped view's GPU buffers (geometries and materials; textures are shared and stay).
 * Safe on shared ones: three re-uploads anything disposed that is drawn again.
 */
function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) for (const x of mat) x.dispose();
    else mat?.dispose();
  });
}

/** The replay's sim, fast-forwarded toward its lead-in during the outro (review #82: it was one synchronous burst). */
let preroll: { sim: Sim; tick: number; target: number; m: Moment } | null = null;
function prerollReplay(budgetMs: number) {
  const m = moment!;
  if (!preroll || preroll.m !== m) {
    const rs = new Sim(simOpts);
    preroll = { sim: rs, tick: 0, target: Math.min(inputLog.length, Math.round(Math.max(0, m.t - TUNING.replay.lead) / rs.dt)), m };
  }
  const p = preroll;
  const until = performance.now() + budgetMs;
  while (p.tick < p.target) {
    p.sim.step(inputLog[p.tick++]);
    if ((p.tick & 63) === 0 && performance.now() > until) break;
  }
}

function startReplay(done: () => void) {
  const R = TUNING.replay;
  const m = moment!;
  prerollReplay(Infinity); // whatever the outro didn't get to
  const rs = preroll!.sim;
  preroll = null;
  const live: Parked = { sim, highway, gait, cruisers, units, director, news, bot, prev: { ...prev }, runStats: { ...runStats }, propKinds: new Map(propKinds), recent: recentEvents.slice() };
  scene.remove(highway.group, cruisers.group, units.group);
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
  for (const g of [highway.group, cruisers.group, units.group]) disposeTree(g); // the replay's views are done with
  const L = r.live;
  ({ sim, highway, gait, cruisers, units, director, news, bot } = L);
  scene.add(highway.group, cruisers.group, units.group);
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
  // Paused: the producer's asks come back up beside the pause menu (Mike, 2026-11-17).
  document.documentElement.classList.toggle('paused', p && !attract);
  if (!p) menuGuard = 10; // §8 10f menu guard after any screen transition
}

function start() {
  started = true;
  paused = false;
  document.documentElement.classList.add('playing');
  try {
    // Only after a real gesture: the attract broadcast starts at page load, and an AudioContext made then is
    // refused (and nags the console on every resume). The first key, click or tap unlocks it (input.onAnyInput).
    const nav = navigator as Navigator & { userActivation?: { hasBeenActive: boolean } };
    if (nav.userActivation ? nav.userActivation.hasBeenActive : !attract) audio.unlock(); // audio must never block the run from starting
  } catch (e) {
    console.warn('Audio unavailable:', e);
  }
  menuGuard = 10;
}

/** Shell "load level": a new broadcast with the player at the controls. */
function beginBroadcast(mode = 'broadcast') {
  attract = false;
  document.documentElement.classList.remove('attract');
  dailyMode = PROTO && mode === 'daily';
  endlessMode = PROTO && (mode === 'endless' || dailyMode);
  if (endlessMode) mode = 'broadcast'; // one long broadcast, no run around it
  const day = dailyDay(Date.now());
  const seed = dailyMode ? dailySeed(day) : nextSeed ?? takeSeed() ?? (Math.random() * 1e9) | 0;
  nextSeed = null;
  // The very first broadcast a player goes live in is the guided one (TUNING.guided): its first segment opens calm.
  const guided = !flags.bot && !flags.autostart && !briefingSeen();
  const edition = 0; // Editions off (2026-11-19)
  lb = { mode: dailyMode ? 'daily' : endlessMode ? 'endless' : mode === 'run' ? 'run' : 'broadcast', ...(dailyMode ? { day } : {}), seed, segments: [], buys: [], pool: upgradePool(profile), ...(guided ? { guided } : {}), ...(edition ? { edition } : {}) };
  if (mode === 'run') {
    run = new RunState(seed, lb.pool, edition); // Awards unlock the rest of the pool
    newRun(run.segmentSeed(), 0, [], {}, guided);
  } else {
    run = null;
    newRun(seed, Math.max(0, Math.min(TUNING.run.segments - 1, flags.seg ?? 0)), flags.ability ? [flags.ability] : [], flags.ability ? { [flags.ability]: flags.level } : {}, guided);
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

// The graphics context can vanish mid-broadcast (a GPU reset, too many tabs, a phone backgrounding the browser).
// Pause behind a station card and wait: three rebuilds its GPU state when the browser hands the context back.
let contextLost = false;
const standby = Object.assign(document.createElement('div'), { id: 'standby', hidden: true, innerHTML: '<div class="card"><b>PLEASE STAND BY</b><span>We are experiencing technical difficulties.</span><small>The picture will be right back.</small></div>' });
document.body.appendChild(standby);
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault(); // without this the browser never restores it
  contextLost = true;
  standby.hidden = false;
  requestPause();
});
canvas.addEventListener('webglcontextrestored', () => {
  contextLost = false;
  standby.hidden = true;
  pausedDrawn = false;
  resize();
});
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
  if (e.code === 'KeyT' && (PLAYTEST || flags.tune)) tunePanel.toggle();
  // Typing in a field (the leaderboard name): Enter submits that form, nothing else.
  if (e.target instanceof HTMLInputElement) return;
  if (!recapEl.hidden && (e.code === 'Enter' || e.code === 'Space')) {
    e.preventDefault();
    // The shell's accept action clicks the focused button; this only covers nothing being focused.
    const focused = document.activeElement;
    if (!(focused instanceof HTMLButtonElement && recapEl.contains(focused)) && recapArmed() && !e.repeat) (recapEl.querySelector('button:not([disabled])') as HTMLButtonElement | null)?.click();
    return;
  }
  const playing = started && !paused && !attract;
  if (e.code === 'KeyH' && playing && PLAYTEST) toggleHeadOn(); // dev: preview Head-On and the swoop home
  if (e.code === 'KeyC' && playing) input.pressCamera(); // next angle (held until it comes back round to Chase High)
  if (e.code === 'KeyR' && playing) {
    nextSeed = flags.seedFixed ? flags.seed : null;
    beginBroadcast(run ? 'run' : dailyMode ? 'daily' : endlessMode ? 'endless' : 'broadcast');
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
      { id: 'endless', label: 'Endless', description: 'One road that never ends. How far can he get?', leaderboardKey: 'banked' },
      { id: 'daily', label: 'Daily', description: "Today's road, the same for everyone.", leaderboardKey: 'banked' },
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
function adaptResolution(fps: number) {
  res.slow = fps < RES.lowFps ? res.slow + 1 : 0;
  res.fast = fps > RES.highFps ? res.fast + 1 : 0;
  let next = res.ratio;
  if (res.slow >= RES.downAfter) next = Math.max(RES.minRatio, res.ratio - RES.step);
  else if (res.fast >= RES.upAfter) next = Math.min(res.max, res.ratio + RES.step);
  if (next === res.ratio) return;
  res.ratio = next;
  res.slow = res.fast = 0;
  renderer.setPixelRatio(next);
  composer?.c.setPixelRatio(next);
  resize();
}

function resize() {
  pausedDrawn = false;
  // HUD scale (Direction B): the top-of-screen pieces are drawn for 1280×720 and zoomed by this.
  // Accessibility: HUD Size scales it up (Settings), within what still fits beside the road.
  const hs = Math.max(TUNING.hud.minScale, Math.min(TUNING.hud.maxScale, Math.min(window.innerWidth / 1280, window.innerHeight / 720))) * settings.hudSize;
  document.documentElement.style.setProperty('--hs', hs.toFixed(3));
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  composer?.c.setSize(w, h);
  rig.resize(w, h);
}
window.addEventListener('resize', resize);
resize();

enterAttract();
prefetchSeed(); // the first broadcast's road, ready before Go Live
type SettingsTab = 'game' | 'controls' | 'display' | 'audio';
type UIChoiceLite = { id: string; label: string; description?: string };
const SETTINGS_TABS: [SettingsTab, string][] = [['game', 'Game'], ['controls', 'Controls'], ['display', 'Display'], ['audio', 'Audio']];
let settingsTab: SettingsTab = 'game';
/** The shell's own settings, by tab (they always render last in its list; the others are hidden and skipped). */
const SHELL_SETTING_TAB: Record<string, SettingsTab> = { 'master-down': 'audio', 'master-up': 'audio', vibration: 'audio', 'reduced-motion': 'display', 'screen-shake': 'display', fullscreen: 'display' };
function settingsTabsDom(root: HTMLElement) {
  const screen = root.querySelector<HTMLElement>('[data-screen-id="settings"]');
  if (!screen) return;
  screen.classList.add('wyf-tabbed');
  for (const b of screen.querySelectorAll<HTMLButtonElement>('[data-choice-id]')) {
    const id = b.dataset.choiceId ?? '';
    if (id.startsWith('wyf-tab-')) {
      b.classList.add('wyf-tab');
      b.classList.toggle('on', id === `wyf-tab-${settingsTab}`);
    }
    const tab = SHELL_SETTING_TAB[id];
    if (tab && tab !== settingsTab) {
      b.hidden = true;
      b.disabled = true; // out of gamepad / arrow-key focus too
    }
  }
}
new MutationObserver(() => settingsTabsDom($('ui'))).observe($('ui'), { childList: true, subtree: true });
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
      // Tabbed (Mike, 2026-11-18): a tab row, then only that tab's settings. The shell's own settings (volume,
      // motion, shake, vibration, fullscreen) are filed under their tabs by settingsTabsDom.
      choices: () => {
        const all: (UIChoiceLite & { tab: SettingsTab })[] = [
          { tab: 'game', id: 'wyf-auto', label: `Auto Rampage: ${onOff(settings.autoRampage)}`, description: 'Rampage fires by itself the moment the meter is full' },
          { tab: 'game', id: 'wyf-speed', label: `Game Speed: ${Math.round(settings.gameSpeed * 100)}%`, description: 'Slower gives more time to react. Below 100% scores stay off the leaderboard' },
          { tab: 'game', id: 'wyf-howto', label: 'How to Play' },
          { tab: 'game', id: 'wyf-tips', label: 'Replay Tips', description: 'Show the in-game control tips again' },
          // Playtest (Mike, 2026-11-17: "missed copying the run data"): every broadcast's numbers, any time. ?playtest=1 only.
          ...(PLAYTEST ? [{ tab: 'game' as SettingsTab, id: 'wyf-playdata', label: 'Copy Play Data', description: 'Copies every broadcast you have played (or saves a file)' }] : []),
          { tab: 'controls', id: 'wyf-controls', label: 'Rebind Keys' },
          ...(NOBRAKE ? [] : [{ tab: 'controls' as SettingsTab, id: 'wyf-brake', label: `Brake: ${settings.brakeToggle ? 'Toggle' : 'Hold'}`, description: 'Toggle: press once to brake, again to run' }]),
          { tab: 'display', id: 'wyf-hudsize', label: `HUD Size: ${Math.round(settings.hudSize * 100)}%` },
          { tab: 'display', id: 'wyf-colors', label: `HUD Colours: ${settings.hudColors === 'network' ? 'Network' : 'WYF 6'}`, description: 'The station\'s purple and cream, or network red, blue and white' },
          { tab: 'display', id: 'wyf-cuts', label: `Camera Cuts: ${onOff(settings.cameraCuts)}`, description: 'Off holds the Chase High shot' },
          { tab: 'display', id: 'wyf-livetime', label: `LIVE TIME: ${onOff(settings.liveTime)}`, description: 'Lighting follows your clock; off is always night' },
          { tab: 'display', id: 'wyf-bloom', label: `Bloom: ${onOff(settings.bloom)}`, description: 'Glow on lights, sparks and Rampage. Off is lighter on phones.' },
          { tab: 'display', id: 'wyf-flashes', label: `Reduce Flashes: ${onOff(settings.reduceFlashes)}` },
          // Dev only: the overlay's switch shows with ?debug (or for a player who already turned it on).
          ...(flags.debug !== null || settings.debugChosen ? [{ tab: 'display' as const, id: 'wyf-debug', label: `Debug Overlay: ${onOff(settings.debug)}` }] : []),
        ];
        return [
          ...SETTINGS_TABS.map(([t, label]) => ({ id: `wyf-tab-${t}`, label })),
          ...all.filter((c) => c.tab === settingsTab).map(({ tab: _t, ...c }) => c),
        ];
      },
      handle: async (id) => {
        if (id.startsWith('wyf-tab-')) {
          settingsTab = id.slice(8) as SettingsTab;
          return true; // the shell redraws Settings on the new tab
        }
        if (id === 'wyf-howto') {
          await openBriefing(false);
          return true; // the shell shows Settings again
        }
        if (id === 'wyf-tips') {
          onboarding.reset();
          return true;
        }
        if (id === 'wyf-playdata') {
          await exportLog();
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
        else if (id === 'wyf-auto') settings.autoRampage = !settings.autoRampage;
        if (id === 'wyf-brake' || id === 'wyf-hudsize' || id === 'wyf-speed' || id === 'wyf-auto') {
          saveSettings(settings);
          return true;
        }
        if (id === 'wyf-cuts') settings.cameraCuts = director.enabled = !settings.cameraCuts;
        else if (id === 'wyf-livetime') {
          settings.liveTime = !settings.liveTime;
          forcedLook = null;
          applyLook();
        } else if (id === 'wyf-bloom') settings.bloom = !settings.bloom;
        else if (id === 'wyf-flashes') settings.reduceFlashes = lighting.reduceFlashes = cruisers.reduceFlashes = units.reduceFlashes = vfx.reduceFlashes = !settings.reduceFlashes;
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
function refreshMainMenu() {
  app!.ui.updateScreen('main-menu', {
    title: 'Giant\nat Large',
    choices: [
      // The modes on the menu (Mike, 2026-11-17: Single Segment adds no challenge; 2026-11-24: Daily Endless is in).
      // 'broadcast' (one segment) stays reachable by ?mode=broadcast for tests and evidence tools.
      // No subcopy (Mike, 2026-11-18): the labels say it.
      { id: 'run', label: PROTO ? 'Story' : 'Go Live' },
      ...(PROTO ? [{ id: 'endless', label: 'Endless' }, { id: 'daily', label: 'Daily' }] : []),
      { id: 'awards', label: 'Awards' },
      { id: 'howto', label: 'How to Play' },
      { id: 'settings', label: 'Settings' },
    ],
  });
}
refreshMainMenu();
// The shell's main menu knows neither the modes nor How to Play: catch them before the flow does.
{
  const flowActivate = app.flow.onActivate.bind(app.flow);
  app.flow.onActivate = (screen: string, choice: string) => {
    if (screen === 'main-menu' && choice === 'howto') void openBriefing(false).then(() => app!.ui.show('main-menu'));
    else if (screen === 'main-menu' && choice === 'awards') void openAwards().then(() => app!.ui.show('main-menu'));
    else if (screen === 'main-menu' && choice === 'run' && PROTO) void openPreShow().then((go) => (go ? flowActivate('mode-select', 'run') : app!.ui.show('main-menu')));
    else if (screen === 'main-menu' && (choice === 'run' || choice === 'endless' || choice === 'daily' || choice === 'broadcast')) flowActivate('mode-select', choice);
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
  // Next camera angle from any device (Mike, 2026-11-24: keyboard had it, pad and touch didn't).
  if (input.consumeCamera() && started && !paused && !attract && !replay) setAngle(director.current + 1, director.side);
  touchUi.hidden = input.device !== 'touch' || attract || !sim.live;
  document.documentElement.classList.toggle('touch', input.device === 'touch');

  let frozen = false;
  if (started && !paused && !flags.stepMode && hitstop > 0) {
    // Hitstop runs on the wall clock (review #90: it was counted in sim ticks, so a slower Game Speed stretched every freeze).
    // Presses during it stay latched and land on the first tick after.
    hitstop = Math.max(0, hitstop - realDt * 60 * flags.timescale);
    frozen = true;
  } else if (started && !paused && !flags.stepMode) {
    acc += realDt * flags.timescale * replayRate * settings.gameSpeed;
    let steps = 0;
    while (acc >= SIM_DT && steps < 8) {
      acc -= SIM_DT;
      const human = input.sample(); // always drain edges, even while the bot drives
      let inp = replay ? replayInput() : bot ? bot.input() : human;
      // Lane input follows the screen: when travel points down (Head-On, or past halfway through
      // the swoop), his left is screen-right, so mirror it.
      if (!replay && !bot && rig.info.travelDown && inp.lane) inp = { ...inp, lane: -inp.lane };
      // Auto Rampage: a full meter fires itself (an input like any press, so recorded runs replay the same).
      if (!replay && !bot && settings.autoRampage && sim.giant.meter >= 100 && !sim.inRampage) inp = { ...inp, shoulder: true };
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
    // Mike (2026-11-17: "sign-off lane change still not smooth"): at the gore the ramp's centreline is already
    // ~7m right of his lane, and snapping onto it jumped him sideways. Now he eases onto it: a critically damped
    // follow of the centreline, from where he was and as fast as he was moving across, eased in.
    const O = TUNING.segment;
    const odt = paused || frozen ? 0 : realDt * flags.timescale * settings.gameSpeed;
    if (odt > 0) {
      outro.t += odt;
      const R = O.rampFollow * Math.min(1, outro.t / O.rampFollowIn);
      const rd = sim.track.widthAt(s) + sim.track.exitOffset(outro.seg, s);
      outro.v += (R * R * (rd - outro.d) - 2 * R * outro.v) * odt;
      outro.d += outro.v * odt;
    }
    d = outro.d;
    rampSlope = outro.v / Math.max(4, g.speed); // his heading follows how he's actually moving across
  }
  const stepPos = prev.stepPos + (g.stepPos - prev.stepPos) * alpha;
  const t = targetAt(s, d);
  lastGiantAt = t;
  t.travel += Math.atan(rampSlope); // on the ramp: he (and the chopper) follow its curve
  const lateralVel = outro && !replay ? 0 : (g.d - prev.d) / SIM_DT;
  const heading = t.travel + Math.atan2(lateralVel, Math.max(4, g.speed)) * 0.5;

  if (replay) updateReplay();
  const animDt = paused || frozen ? 0 : realDt * flags.timescale * replayRate * settings.gameSpeed;
  audio.setRotor(g.tier / 2);

  if (animDt > 0) {
    // Giant size: ease toward this gear's size, then run the gait in his space.
    // A Leap or a Breakaway dive looms toward the chopper at its apex (height reads from straight above).
    const airU = g.airDur > 0 && g.air > 0 ? 1 - g.air / g.airDur : 0;
    const want = sizeFor(g.tier) * (1 + TUNING.abilities.leap.loom * Math.sin(Math.PI * airU));
    setGiantScale(Math.abs(want - gScale) < 1e-3 ? want : gScale + (want - gScale) * Math.min(1, animDt / TUNING.growth.ease), t.x, t.z);
    rig.giantScale = gScale;
    const lt = toGiant(t.x, t.z);
    const gf = gait.update({ x: lt.x, z: lt.z, fx: Math.cos(t.travel), fz: Math.sin(t.travel), speed: g.speed / gScale, stepPos, stepLen: g.stepLen / gScale, tier: g.tier, dt: animDt });
    if (gf.plantedNow === 0 || gf.plantedNow === 1) {
      // v0.3 footfall: dust ring, 2px camera pulse, bass thump; Rampage adds a crack decal.
      const lf = gf.legs[gf.plantedNow as 0 | 1].foot;
      const f = fromGiant(lf.x, lf.z);
      const G = TUNING.gear;
      // Rampage loop: the build-up rides the last stretch of the meter (the steps swell and tick toward READY).
      const build = sim.live && !sim.inRampage && g.meter >= G.meterBuildFrom && g.meter < 100 ? (g.meter - G.meterBuildFrom) / (100 - G.meterBuildFrom) : 0;
      // No ring under each step (Mike, 2026-11-24); the build-up is the tick, the dust and the meter.
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
      const puffs = TUNING.vfx.stepDust[g.tier] ?? 0;
      if (puffs) vfx.puff(f.x + kx * 0.6, 0.25, f.z + kz * 0.6, puffs, 0x8d7f6c, TUNING.vfx.stepDustSize * gScale, 0.6, 0.3, 0.5);
      if (kick) highway.spawnDebris(f.x, f.z, kx, kz, 2 + g.tier * 1.5, kick, [0x6e6152, 0x857664, 0x4a4038], [0.16, 0.34 + g.tier * 0.1], 0.4); // darker than the lit pool he runs in
      rig.jolt(TUNING.footfall.pulsePx, TUNING.footfall.pulseTime);
      audio.footfall(g.tier);
      if (g.tier === 2) {
        highway.crack(f.x, f.z, t.travel);
        highway.stomp(f.x, f.z); // nearby cars bounce on their suspension
        haptic(30, 0.15); // §27 light pulse per footfall at Rampage only
      }
    }
    // Phase 3: the Leap arc, and Breakaway's long low dive (in his space: they scale with him).
    const A = TUNING.abilities;
    const u = g.airDur > 0 && g.air > 0 ? 1 - g.air / g.airDur : 0;
    const lift = u > 0 ? 4 * (g.airKind === 'breakaway' ? A.breakaway.height : A.leap.height) * u * (1 - u) : 0;
    unplaceGiant();
    giant.update(animDt, { x: lt.x, z: lt.z, heading, travel: t.travel, lateralVel, speed: g.speed, tier: g.tier, braking: g.braking, stumble: g.stumble, stepPos, lift, leap: u, pose: 0 }, gf);
    placeGiant();
    // Prime Time: flash bulbs from the crowd and the press. A soft pulse, at most 3 a second (photosensitivity).
    bulbT = Math.max(0, bulbT - animDt);
    updateAbilityFx(animDt);
    if (g.prime > 0 && bulbT === 0 && !settings.reduceFlashes) {
      bulbT = 1 / 3;
      bulbFrames = 3;
    }
  }
  highway.update(animDt, t.x, t.z, s, d);
  cruisers.update(animDt);
  units.update(animDt);
  vfx.update(animDt);
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
  // While the outro holds, fast-forward the replay a few ms a frame so starting it doesn't hitch.
  if (endedFor >= 0 && !recapShown && !attract && !replay && moment && flags.replay) prerollReplay(TUNING.replay.prerollMs);
  if (endedFor >= 0 && !recapShown && endedFor > (sim.show.state === 'cleared' ? TUNING.camera.signOffHold : 2.2)) {
    recapShown = true;
    if (attract) enterAttract(); // behind the menus: just roll another broadcast
    else {
      lb.segments.push(encodeInputs(inputLog));
      // Story: finished asks unlock things (the sim already multiplied the score for traffic mods).
      newUnlocks = [];
      modMult = sim.modMult; // the sim banked it when the broadcast ended
      if (!bot && simOpts.asks) {
        for (const a of sim.asks.list) if (a.done && !profile.asksDone.includes(a.id)) {
          profile.asksDone.push(a.id);
          const u = TUNING.proto.storyAsks.find((x) => x.id === a.id)?.unlock;
          if (u) newUnlocks.push(u);
        }
      }
      if (run) run.finishSegment(sim.show);
      // The Local News Awards: this segment's tally (a player's, not the bot's).
      newAwards = bot
        ? []
        : record(profile, { signedOff: sim.show.state === 'cleared', policeWrecked: runStats.crashes, objects: sim.stats.smashes + runStats.crashes, segment: run ? run.segment + 1 : 1, runWon: run?.phase === 'won' });
      // Editions are off (Mike, 2026-11-19): every run is the Evening News.
      editionUnlocked = -1;
      saveProfile(profile);
      if (run?.phase !== 'meeting') {
        app?.shell.session.setPhase('results');
        statsReady = recordStats();
      }
      if (!flags.stepMode) dissolveOut();
      // Tonight's top moment first, then the recap.
      // Unlocks get their own moment before the recap (Mike, 2026-11-24: "more lively unlocks").
      const next = () => showUnlocks(showRecap);
      if (moment && flags.replay && !flags.stepMode) startReplay(next);
      else next();
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
    // The opening hero shot is a cinematic like the swoop (no cut yet, still on the opening angle).
    const opening = cutLog.length === 0 && director.current === TUNING.camera.openingAngle;
    if (info.transition) measure.swoopFrames++;
    else if (!opening) {
      // Camera rules hold on every frame outside a swoop (its length is bounded and soak-checked).
      measure.maxScreenUp = Math.max(measure.maxScreenUp, Math.abs(info.screenUpDeg));
      measure.maxGiantY = Math.max(measure.maxGiantY, info.giantScreenY);
      if (g.speed > 5.5) measure.minAhead = Math.min(measure.minAhead, info.aheadSeconds);
    }
  }

  updateRampageFx(paused ? 0 : realDt, performance.now() / 1000);
  // Rampage aura: embers lift off him and speed lines streak past while it lasts (review #65).
  if (rampK > 0 && !paused && sim.live && !attract) {
    const V = TUNING.vfx;
    auraAcc += realDt * V.emberRate * rampK;
    const n = Math.floor(auraAcc);
    auraAcc -= n;
    if (n) vfx.ember(t.x, 4.5 * gScale, t.z, 1.6 * gScale, n);
    if (!settings.reducedMotion) {
      lineAcc += realDt * V.speedLineRate * rampK;
      const fx = Math.cos(t.travel), fz = Math.sin(t.travel);
      for (; lineAcc >= 1; lineAcc--) {
        const ahead = 6 + Math.random() * 22;
        const side = (Math.random() < 0.5 ? -1 : 1) * (2.5 + Math.random() * 7) * gScale;
        vfx.speedLine(t.x + fx * ahead - fz * side, 0.4 + Math.random() * 3.5 * gScale, t.z + fz * ahead + fx * side, fx, fz, 4 + Math.random() * 5, 0.35 + rampK * 0.3);
      }
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
  } else if (forkSwap && performance.now() / 1000 < forkSwap.at) {
    // Fork wipe coming in: the last frame holds (the road is about to be swapped under the wipe).
  } else if (contextLost || (paused && !attract && pausedDrawn)) {
    // Paused: the last frame stays on the canvas; no 3D work until something changes.
  } else if (updateTitleShot(realDt, t)) draw(titleCam);
  else {
    if (forkSwap) {
      forkSwap.swap();
      forkSwap = null;
    }
    draw(rig.camera);
  }
  pausedDrawn = paused && !attract;
  // The recap's picture: the replay's own frame just as the moment lands (before the viewer-video window draws).
  if (replay && !recapShot && moment && (replay.grab || replay.sim.time >= moment.t + TUNING.replay.shotAfter)) grabShot();
  if ((!paused || attract) && !contextLost) pip.render(renderer, scene);
  updateHud(realDt);
  updateGlyphs();
  if (paused && started && !attract) onboarding.pause(performance.now() / 1000);
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
    if (action === 'brake' || action === 'shoulder' || action === 'ability' || action === 'ability2') return keyLabel(K[action]);
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
    chip2.key.textContent = glyph('ability2');
    const key = (a: GlyphAction, what: string) => `<span><kbd>${esc(glyph(a))}</kbd>${what}</span>`;
    controlsEl.innerHTML = fam === 'touch'
      ? `<span>Swipe to change lanes${NOBRAKE ? '' : ' · hold down to brake'}</span>`
      : key('lanes', 'Lane') + (NOBRAKE ? '' : key('brake', 'Brake')) + key('shoulder', 'Rampage') + key('camera', 'Camera') + key('pause', 'Pause');
    recapEl.dataset.fam = '';
  }
  controlsEl.hidden = attract || !sim.live || sim.time > TUNING.input.controlsHintTime;
  // In the head-on opening he runs at the top of the frame: the strip moves down out of his way.
  controlsEl.classList.toggle('low', !!rig.angle.headOn);
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
    } else {
      applyLook();
      // Going live from the cover art: straight into the broadcast's own opening shot, no glide down.
      if (document.documentElement.classList.contains('cover')) titleK = 0;
    }
  }
  const idle = (performance.now() - lastInputAt) / 1000;
  // Mike (2026-11-17): the cover art is the backdrop for every menu, not just the title, so the game isn't
  // spoiled before Go Live; the live attract shot only slides in after `idleToAttract` s with no input.
  // How to Play before the first broadcast sits on the art too (the broadcast behind it hasn't gone live yet).
  const briefingFirst = !started && !attract; // a broadcast that hasn't gone live yet (How to Play is up, or about to be)
  const cover = (inMenus && idle < T.idleToAttract) || briefingFirst;
  coverEl.hidden = !inMenus && !briefingFirst;
  void onTitle;
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
/** Where he was drawn last frame (the Awards screen photographs him there). */
let lastGiantAt: { x: number; z: number; travel: number } | null = null;

/**
 * The Awards screen's outfit portraits (Mike, 2026-11-19: "could be more visual, esp with armor unlock"): the giant
 * as he is right now, three-quarter front at chest height, once per outfit. Copied in the same task as each render.
 */
function outfitPortraits(): Partial<Record<OutfitId, string>> {
  const out: Partial<Record<OutfitId, string>> = {};
  const t = lastGiantAt;
  if (!t || contextLost) return out;
  const fx = Math.cos(t.travel), fz = Math.sin(t.travel);
  const rx = -fz, rz = fx;
  poseCam.aspect = canvas.width / Math.max(1, canvas.height);
  poseCam.updateProjectionMatrix();
  poseCam.position.set(t.x + fx * 8 + rx * 4, 3.4, t.z + fz * 8 + rz * 4);
  poseCam.lookAt(t.x, 2.9, t.z);
  const h = canvas.height;
  const w = Math.round(h * 0.62);
  const c = document.createElement('canvas');
  c.width = Math.min(360, w);
  c.height = Math.round(c.width / 0.62);
  const g = c.getContext('2d');
  if (!g) return out;
  for (const id of Object.keys(TUNING.outfits) as OutfitId[]) {
    giant.setOutfit(id);
    renderer.render(scene, poseCam);
    g.drawImage(canvas, (canvas.width - w) / 2, 0, w, h, 0, 0, c.width, c.height);
    out[id] = c.toDataURL('image/jpeg', 0.85);
  }
  giant.setOutfit(profile.outfit);
  return out;
}

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
    if (kind === 'caught') boxedHow.innerHTML = settings.brakeToggle ? (glyphFamily === 'touch' ? 'Swipe ▼ again · Run' : `<kbd>${esc(glyph('brake'))}</kbd> again · Run`) : glyphFamily === 'touch' ? 'Let go of ▼ · Run' : `Let go of <kbd>${esc(glyph('brake'))}</kbd> · Run`;
    else boxedHow.innerHTML = glyphFamily === 'touch' ? 'Tap ● Rampage · hold ▼ Brake' : `<kbd>${esc(glyph('shoulder'))}</kbd>Rampage · <kbd>${esc(glyph('brake'))}</kbd>Brake`;
  }
}

function updateHud(dt: number) {
  updateBoxed();
  const g = sim.giant;
  // LIVE clock; once the exit is open it counts down to the end of the grace period.
  const X = TUNING.segment;
  const counting = sim.time >= X.exitOpensAt && sim.live && !sim.endless;
  const secs = counting ? Math.max(0, Math.ceil(X.length + X.grace - sim.time)) : Math.floor(sim.time);
  clockEl.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  clockEl.classList.toggle('count', counting);
  if (clockLbl.hidden === counting) clockLbl.hidden = !counting;
  // Fuel: full at the cold open, empty when the grace runs out (the segment's hard end). Amber once the exit is open,
  // red and pulsing for the last `hud.fuelCritical` s.
  const total = X.length + X.grace;
  const fuel = Math.max(0, Math.min(1, 1 - sim.time / total));
  fuelBar.style.transform = `scaleX(${fuel.toFixed(4)})`;
  fuelEl.classList.toggle('low', counting);
  fuelEl.classList.toggle('crit', sim.live && total - sim.time <= TUNING.hud.fuelCritical);
  const brakeShown = input.brakeLatched && sim.live;
  if (brakeOnEl.hidden === brakeShown) brakeOnEl.hidden = !brakeShown;
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
  // Rampage meter (2026-11-17): fills in Stride; full, it shows the button; in Rampage it's the clock running down.
  const ramp = sim.inRampage;
  const ready = !ramp && g.meter >= 100;
  gearPips[0].style.setProperty('--fill', (ramp ? Math.min(1, g.rampT / TUNING.rampage.duration) : g.meter / 100).toFixed(3));
  gearsEl.classList.toggle('ready', ready);
  gearsEl.dataset.tier = String(g.tier);
  // Readability pass (Mike, 2026-11-17): the number says where it is; full, the button; in Rampage, the seconds left.
  const nm = ramp ? `${g.rampT.toFixed(1)}s` : ready ? (settings.autoRampage ? 'READY!' : `<kbd>${esc(glyph('shoulder'))}</kbd> GO!`) : `${Math.floor(g.meter)}%`;
  if (gearName.innerHTML !== nm) gearName.innerHTML = nm;
  gearsEl.classList.toggle('ramp', ramp);
  // Prototype: a clean run builds the sprint (it shows on the meter's label).
  if (PROTO) gearsEl.classList.toggle('sprint', !ramp && g.sprint >= 1);
  // Rampage's last moments (review pick 2): red edges, the chip blinks, a tick each half second.
  const ending = ramp && sim.live && g.rampT <= TUNING.hud.rampWarn;
  document.documentElement.classList.toggle('rampend', ending);
  const tick = ending ? Math.ceil(g.rampT * 2) : -1;
  if (tick !== rampTick) {
    if (tick >= 0 && !replay) audio.gearTick(1 - g.rampT / TUNING.hud.rampWarn);
    rampTick = tick;
  }
  heatStars.forEach((el, i) => el.classList.toggle('on', i < sh.heat));
  // The asks: at the top of a segment and when one lands, then out of the way (HUD triage, 2026-11-17).
  asksEl.classList.toggle('show', sim.live && sim.time < Math.max(asksUntil, TUNING.hud.asksIntro));
  // Phase 3: segment number and the ability chip (cooldown fills back up).
  segEl.hidden = !run;
  if (run) {
    // Story run: the first district's card once the cold open has swung home.
    if (PROTO && !attract && !replay && !firstCardShown && sim.time > TUNING.onboarding.lanesAfter && sim.time < TUNING.onboarding.lanesAfter + 3) {
      firstCardShown = true;
      showDistrict(0);
    }
    // Story run (prototype): the district he's in, of the five.
    const dIdx = PROTO ? sim.track.segmentAt(g.s).district : undefined;
    segEl.textContent = dIdx !== undefined ? `${dIdx + 1}/${TUNING.proto.story.districts.length}` : `${run.segment + 1}/${TUNING.run.segments}`;
  }
  const ab = sim.ability;
  abilEl.hidden = !ab || attract;
  abilBtn.disabled = !ab;
  if (ab) {
    const A = TUNING.abilities[ab];
    const label = TUNING.upgrades[ab].label + (sim.abilityLevel > 1 ? ` ${ROMAN[sim.abilityLevel]}` : '');
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
  const ab2 = sim.ability2;
  chip2.el.hidden = !ab2 || attract;
  chip2.btn.disabled = !ab2;
  if (ab2) {
    const A2 = TUNING.abilities[ab2];
    const lv = sim.levelOf(ab2);
    const label = TUNING.upgrades[ab2].label + (lv > 1 ? ` ${ROMAN[lv]}` : '');
    if (chip2.name.textContent !== label) {
      chip2.name.textContent = label;
      chip2.icon.src = UPGRADE_ART[ab2];
      chip2.btn.style.backgroundImage = `url(${UPGRADE_ART[ab2]})`;
      chip2.btn.textContent = label.split(' ')[0].toUpperCase().slice(0, 5);
      chip2.btn.setAttribute('aria-label', label);
    }
    const ready = g.ability2Cd <= 0;
    chip2.cd.style.width = `${((1 - g.ability2Cd / A2.cooldown) * 100).toFixed(1)}%`;
    chip2.el.classList.toggle('ready', ready);
    chip2.btn.classList.toggle('ready', ready);
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
    if (started && !paused && !attract && !replay) adaptResolution(perf.fps);
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
  recap: () => (recapEl.hidden ? null : { title: recapEl.querySelector('.why')?.textContent ?? recapEl.querySelector('.outcome')?.textContent, outcome: recapEl.querySelector('.outcome')?.textContent, clip: !!recapEl.querySelector('.rc-shot video') && !(recapEl.querySelector('.rc-shot video') as HTMLVideoElement).paused }),
  /** Recap REPLAY: playing now (sim time, end, rate), and the moment it picked. */
  replay: () => ({ playing: !!replay, t: replay?.sim.time ?? null, end: replay?.end ?? null, rate: replayRate, moment }),
  show: () => ({ ...sim.show, tier: sim.show.tier, exit: sim.exit, live: sim.live, units: sim.pursuit.units.map((u) => ({ id: u.id, unit: u.unit, phase: u.phase, gap: u.s - sim.giant.s, lane: u.lane })) }),
  coverage: () => ({ cls: document.getElementById('hud')!.className, desk: !document.getElementById('desk')!.hidden, ticker: !document.getElementById('ticker')!.hidden, pip: pip.active, cold: !document.getElementById('coldopen')!.hidden }),
  /** Dev: roll viewer video now. */
  viewerVideo: () => pip.trigger(sim, 3, true),
  /** Evidence: show the unlock stinger for these awards / traffic mods. */
  previewUnlocks(awards: string[], mods: string[] = []) {
    newAwards = AWARDS.filter((a) => awards.includes(a.id));
    newUnlocks = mods;
    showUnlocks(() => {}, true);
  },
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
  ability: () => ({ id: sim.ability, level: sim.abilityLevel, cd: sim.giant.abilityCd, air: sim.giant.air, airKind: sim.giant.airKind, prime: sim.giant.prime, chip: !abilEl.hidden }),
};
