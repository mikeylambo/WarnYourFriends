import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TUNING } from '../tuning';
import type { Sim } from '../sim/sim';
import type { Segment } from '../sim/track';
import type { Prop, PropKind } from '../sim/types';
import { Rng } from '../sim/rng';
import { KIND_COLORS, MATERIAL_DEBRIS, PALETTE } from './palette';
import { crackTexture, isToonCached, toon, toonRamp } from './toon';
import { GLOW, facade } from './glow';
import type { LampPos } from './lighting';
import { TILE, groundTexture, hasTexture, type GroundTex } from './textures';

const basicMats = new Map<number, THREE.MeshBasicMaterial>();
/** Unlit double-sided colour, one material per colour (was one per sweep). */
function basicDouble(color: number): THREE.MeshBasicMaterial {
  let m = basicMats.get(color);
  if (!m) basicMats.set(color, (m = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })));
  return m;
}

/** A unit cone (trees), scaled per tree (review #48: a new ConeGeometry per tree). Shared: never disposed. */
const UNIT_CONE = new THREE.ConeGeometry(1, 1, 6);
/** Round trees (art pass): a faceted ball, squashed per tree. Shared: never disposed. */
const UNIT_ICO = new THREE.IcosahedronGeometry(1, 0);
const batchable = (m: THREE.Mesh) => ((m.userData.batch = true), m);

/** One flat 1×1 plane (lane dashes, light pools, chevrons, throws), scaled per mesh. Shared: never disposed. */
const FLAT_PLANE = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const LENS = new THREE.MeshBasicMaterial({ color: 0xffc27a });
const TAIL = new THREE.MeshBasicMaterial({ color: 0xd01818 });
const HEAD = new THREE.MeshBasicMaterial({ color: 0xfff2d8 });

/**
 * A segment view leaving the road: free its own geometry, and its own fading materials (tunnel roofs,
 * overpasses, gantries are per-instance so each fades alone). Shared geometry and cached materials stay.
 */
function freeSegment(g: THREE.Object3D, box: THREE.BufferGeometry) {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if ((m as THREE.InstancedMesh).isInstancedMesh) (m as THREE.InstancedMesh).dispose();
    if (m.geometry && m.geometry !== box && m.geometry !== FLAT_PLANE && m.geometry !== UNIT_CONE && m.geometry !== UNIT_ICO) m.geometry.dispose();
    const mat = m.material as THREE.Material | undefined;
    if (mat && !Array.isArray(mat) && mat.transparent && !isToonCached(mat)) mat.dispose();
  });
}

/** The sign-off board's red (the station's red, as on the HUD). */
const SIGNOFF_RED = '#b3122a';
const signTex = new Map<string, THREE.Texture>();
/** Exit sign faces: "EXIT 6 / SIGN-OFF" for the sign-off, "EXIT 6A / {road}" for a fork. Drawn once each. */
function signTexture(fork?: string): THREE.Texture {
  const key = fork ?? '';
  const hit = signTex.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 176;
  const g = c.getContext('2d')!;
  // A fork is an ordinary green highway exit; the sign-off is the station's own red board (Mike, 2026-11-18: a fork
  // read as the sign-off), so the two never look alike.
  g.fillStyle = fork ? '#1e6b3a' : SIGNOFF_RED;
  g.fillRect(0, 0, 256, 176);
  g.strokeStyle = '#f4f4ee';
  g.lineWidth = 6;
  g.strokeRect(8, 8, 240, 160);
  g.fillStyle = '#f4f4ee';
  g.textAlign = 'center';
  g.font = '800 30px system-ui, sans-serif';
  g.fillText(fork ? 'EXIT 6A' : 'WYF 6', 128, 52);
  const big = fork ? fork.toUpperCase() : 'SIGN-OFF';
  let px = 40;
  do g.font = `900 ${px--}px system-ui, sans-serif`;
  while (px > 16 && g.measureText(big).width > 228);
  g.fillText(big, 128, 104);
  g.font = '800 44px system-ui, sans-serif';
  g.fillText('\u2198', 128, 156);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  signTex.set(key, tex);
  return tex;
}

/** Prototype: the double yellow line on a two-way stretch. */
const TWO_WAY_LINE = new THREE.MeshBasicMaterial({ color: 0xf2b705 });

/** Prototype: the ring under small smashables (one geometry and material for all of them). */
export const SMASH_RING_GEO = new THREE.RingGeometry(0.78, 1, 28);
export const SMASH_RING_MAT = new THREE.MeshBasicMaterial({ color: 0xffd23c, transparent: true, opacity: 0.85, depthWrite: false });
/** Target car (2026-11-24): a thicker ring in hot orange that pulses, so it reads as "go for this one". */
const TARGET_RING_GEO = new THREE.RingGeometry(0.62, 1, 32);
const TARGET_RING_MAT = new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.95, depthWrite: false });

/** Road paint is retroreflective: a little self-light so lanes read at night outside the pools. */
const PAINT_GLOW = 0x303030;

/** Per-car presentation state for Phase 0c traffic reactions (never written back to the sim). */
interface CarFx {
  prop: Prop;
  group: THREE.Group;
  body: THREE.Group;
  tails: THREE.Sprite[];
  hazards: THREE.Sprite[];
  braking: boolean;
  /** Swerve progress (s since it started), or −1 if it hasn't. */
  swerveT: number;
  swerveDir: number;
  honked: boolean;
  bounceY: number;
  bounceV: number;
  /** He brushed past it (his body sweeps over the next lane): time since, or −1; and which way it rocks. */
  brushT: number;
  brushDir: number;
}

/**
 * Highway presentation: streams segment meshes (road, lane paint, walls, merge
 * signage, roadside scenery) and lane props as the sim generates them, plus
 * pooled debris, dust rings and Rampage crack decals. Reads sim state only.
 */

/** A box (or a wheel: a cylinder across the vehicle, w = h = diameter, d = tyre width), optionally tilted about its across axis (rad). */
export type Part = [x: number, y: number, z: number, w: number, h: number, d: number, color: number | 'kind', shape?: 'wheel', tilt?: number];

const GLASS = 0x1d2633;
const TYRE = 0x18181b;
const TRIM = 0x2b2b2e;
/** Four (or six) wheels under a body of length L and width W: diameter `dia`, axles at these fractions of L. */
function wheels(L: number, W: number, dia: number, axles: number[]): Part[] {
  const out: Part[] = [];
  for (const a of axles) for (const side of [-1, 1]) out.push([a * L, dia / 2, side * (W / 2 - 0.14), dia, dia, 0.3, TYRE, 'wheel']);
  return out;
}
/** A sedan-like car (cars, cruisers, compacts): body, shoulder line, glass cabin with a tilted windscreen, roof, bumpers, wheels. */
function sedan(L: number, W: number, body: number | 'kind', roof: number | 'kind'): Part[] {
  return [
    [0, 0.6, 0, L, 0.55, W, body],
    [-0.02 * L, 0.93, 0, 0.94 * L, 0.14, 0.97 * W, body],
    [-0.06 * L, 1.26, 0, 0.5 * L, 0.52, 0.84 * W, GLASS],
    [0.21 * L, 1.15, 0, 0.14 * L, 0.42, 0.82 * W, GLASS, undefined, -0.75],
    [-0.34 * L, 1.15, 0, 0.12 * L, 0.4, 0.82 * W, GLASS, undefined, 0.7],
    [-0.06 * L, 1.26, 0, 0.05 * L, 0.52, 0.86 * W, roof],
    [-0.07 * L, 1.56, 0, 0.46 * L, 0.09, 0.87 * W, roof],
    [L / 2 + 0.03, 0.42, 0, 0.1, 0.2, 0.98 * W, TRIM],
    [-L / 2 - 0.03, 0.42, 0, 0.1, 0.2, 0.98 * W, TRIM],
    ...wheels(L, W, 0.66, [0.31, -0.31]),
  ];
}

/** Box parts per prop kind, in prop-local space: x along the road, z across it. */
export function partsFor(p: Prop): Part[] {
  const L = p.hl * 2;
  const W = p.hw * 2;
  switch (p.kind as PropKind) {
    case 'scoop':
      // A Water Bottle (Mike, 2026-11-26: Exclusives become Water Bottles): a giant's bottle lying across the road
      // (round: the wheel cylinder), with a white label and the station's red band, so it reads from the chopper.
      return [[0, 0.5, -0.15, 0.9, 0.9, 1.0, 'kind', 'wheel'], [0, 0.5, -0.15, 0.93, 0.93, 0.42, 0xf3f1ea, 'wheel'], [0, 0.5, -0.15, 0.95, 0.95, 0.12, 0xb3122a, 'wheel'], [0, 0.5, 0.45, 0.5, 0.5, 0.2, 'kind', 'wheel'], [0, 0.5, 0.62, 0.42, 0.42, 0.14, 0xf3f1ea, 'wheel']];
    case 'sawhorse':
      return [[0, 0.75, 0, L, 0.28, W, 'kind'], [0, 0.4, W * 0.4, L * 0.8, 0.8, 0.12, 0x8a6240], [0, 0.4, -W * 0.4, L * 0.8, 0.8, 0.12, 0x8a6240]];
    case 'cart':
      return [[0, 0.55, 0, L, 0.7, W, 0xa67c52], [0, 1.05, 0, L * 0.9, 0.35, W * 0.85, 'kind'], [0, 2.0, 0, L * 1.1, 0.08, W * 1.4, 'kind'], [0, 1.4, 0, 0.08, 1.2, 0.08, 0x8a6240]];
    case 'fence':
      return [[0, 0.75, 0, 0.08, 1.3, W, 'kind'], [0, 0.06, W * 0.45, 0.6, 0.12, 0.3, 0x6d737a], [0, 0.06, -W * 0.45, 0.6, 0.12, 0.3, 0x6d737a]];
    case 'scooter':
      // Step-through scooter: deck and seat, front apron and bars, two small wheels.
      return [[0, 0.42, 0, L * 0.7, 0.18, W * 0.8, 'kind'], [-L * 0.15, 0.72, 0, L * 0.42, 0.42, W, 'kind'], [-L * 0.15, 0.98, 0, L * 0.36, 0.1, W * 0.9, 0x333333], [L * 0.34, 0.7, 0, 0.16, 0.7, W * 0.9, 'kind'], [L * 0.38, 1.1, 0, 0.08, 0.08, W * 1.8, 0x8c939b], [L * 0.38, 0.28, 0, 0.5, 0.5, 0.16, TYRE, 'wheel'], [-L * 0.36, 0.28, 0, 0.5, 0.5, 0.16, TYRE, 'wheel']];
    case 'car':
      return sedan(L, W, 'kind', 'kind');
    case 'van':
      // Box truck: chassis, cab with a tilted windscreen, cargo box with the red stripe, three axles.
      return [
        [0, 0.48, 0, L, 0.3, W * 0.94, TRIM],
        [-L * 0.12, 1.5, 0, L * 0.74, 1.95, W, 'kind'],
        [-L * 0.12, 1.05, 0, L * 0.745, 0.2, W * 1.01, 0xd94f4f],
        [L * 0.37, 1.08, 0, L * 0.24, 1.3, W * 0.96, 0xe8e4dc],
        [L * 0.47, 1.45, 0, 0.12, 0.55, W * 0.84, GLASS, undefined, -0.35],
        [L * 0.5 + 0.03, 0.55, 0, 0.1, 0.25, W * 0.98, TRIM],
        ...wheels(L, W, 0.82, [0.36, -0.16, -0.36]),
      ];
    case 'newsvan':
      // A rival station's van: livery box, white band, cab, and a mast with a satellite dish on the roof (reads from above).
      return [
        [0, 0.48, 0, L, 0.3, W * 0.94, TRIM],
        [-L * 0.1, 1.45, 0, L * 0.78, 1.8, W, 'kind'],
        [-L * 0.1, 1.2, 0, L * 0.785, 0.3, W * 1.01, 0xf2efe8],
        [L * 0.4, 1.05, 0, L * 0.2, 1.2, W * 0.96, 'kind'],
        [L * 0.49, 1.4, 0, 0.12, 0.5, W * 0.84, GLASS, undefined, -0.35],
        [-L * 0.25, 2.55, 0, 0.14, 0.7, 0.14, 0x8c939b],
        [-L * 0.25, 2.95, 0, 0.9, 0.14, 0.9, 0xf2efe8, undefined, 0.5],
        [L * 0.05, 2.42, 0, L * 0.35, 0.08, W * 0.7, 0x2a2a30],
        ...wheels(L, W, 0.82, [0.36, -0.3]),
      ];
    case 'barricade':
      return [[0, 0.38, 0, L, 0.75, W, 'kind'], [0, 0.86, 0, L * 0.8, 0.2, W, 0xf08a24]];
    case 'dozer':
      // Tracked body, cab, and a wide blade facing the giant: reads as "not going through that".
      return [[0, 0.35, W * 0.38, L * 0.95, 0.7, W * 0.22, TRIM], [0, 0.35, -W * 0.38, L * 0.95, 0.7, W * 0.22, TRIM], [0.1, 1.05, 0, L * 0.7, 0.75, W * 0.7, 'kind'], [-0.35, 1.9, 0, L * 0.35, 0.95, W * 0.5, 'kind'], [-0.35, 1.95, 0, L * 0.3, 0.6, W * 0.52, GLASS], [-0.35, 2.4, 0, L * 0.4, 0.08, W * 0.56, TRIM], [0.45, 2.05, W * 0.22, 0.12, 0.9, 0.12, TRIM], [-L * 0.55, 0.6, 0, 0.22, 1.1, W * 1.12, 0x8c939b], [-L * 0.5, 0.5, 0, 0.3, 0.12, W * 0.9, TRIM, undefined, 0.6]];
    case 'tollgate':
      // A striped boom arm across the lane on a post at its left end.
      return [[0, 1.0, 0, 0.14, 0.14, W, 'kind'], [0, 1.0, -W * 0.25, 0.15, 0.15, W * 0.16, 0xd64545], [0, 1.0, W * 0.15, 0.15, 0.15, W * 0.16, 0xd64545], [0, 0.6, -W * 0.5, 0.3, 1.2, 0.3, 0x6d737a]];
    case 'foodtruck':
      // Step van: painted box, cream band, serving hatch with a propped awning on his right side, cab windscreen, roof sign.
      return [
        [0, 0.5, 0, L * 0.95, 0.3, W * 0.92, TRIM],
        [-L * 0.06, 1.75, 0, L * 0.86, 2.2, W, 'kind'],
        [-L * 0.06, 1.0, 0, L * 0.865, 0.22, W * 1.01, 0xf2efe8],
        [L * 0.41, 1.45, 0, L * 0.16, 1.6, W * 0.96, 'kind'],
        [L * 0.49, 1.85, 0, 0.12, 0.7, W * 0.84, GLASS, undefined, -0.25],
        [-L * 0.08, 1.95, W * 0.505, L * 0.46, 0.75, 0.06, 0x2a2230],
        [-L * 0.08, 2.5, W * 0.66, L * 0.5, 0.06, 0.6, 0xf2efe8, undefined, 0],
        [-L * 0.1, 3.1, 0, L * 0.42, 0.5, 0.12, 0xf5d33b],
        ...wheels(L, W, 0.8, [0.33, -0.3]),
      ];
    case 'armored': {
      // Armoured police truck: slab-sided body, slit windows, a ram plate up front, three axles. Nothing smashes it.
      return [
        [0, 0.55, 0, L * 0.98, 0.4, W * 0.94, TRIM],
        [-L * 0.08, 1.75, 0, L * 0.8, 2.1, W, 'kind'],
        [L * 0.38, 1.4, 0, L * 0.22, 1.4, W * 0.98, 'kind'],
        [L * 0.47, 1.85, 0, 0.12, 0.35, W * 0.8, GLASS, undefined, -0.3],
        [-L * 0.08, 2.35, W * 0.505, L * 0.5, 0.18, 0.04, GLASS],
        [-L * 0.08, 2.35, -W * 0.505, L * 0.5, 0.18, 0.04, GLASS],
        [-L * 0.08, 1.35, 0, L * 0.805, 0.2, W * 1.01, 0xf1f1ee],
        [L * 0.5 + 0.15, 0.85, 0, 0.25, 1.0, W * 1.05, 0x8c939b],
        ...wheels(L, W, 0.95, [0.33, -0.12, -0.36]),
      ];
    }
    case 'carrier': {
      // Car carrier: cab, two-deck open trailer, a load of cars on both decks (decoration: the drops are real props).
      const deck = (y: number): Part[] => [[-L * 0.14, y, 0, L * 0.7, 0.12, W, 0x6d737a]];
      const cars: Part[] = [];
      const load = [0xcf4b3e, 0x3b8ea5, 0xd9a43b, 0x6b8f5a, 0x4a5d8c, 0xe9d7a8];
      for (let i = 0; i < 3; i++) {
        cars.push([-L * 0.4 + i * L * 0.2, 1.5, 0, L * 0.16, 0.6, W * 0.82, load[i]], [-L * 0.4 + i * L * 0.2, 2.9, 0, L * 0.16, 0.6, W * 0.82, load[i + 3]]);
      }
      return [
        [L * 0.38, 1.35, 0, L * 0.2, 1.9, W * 0.96, 'kind'],
        [L * 0.47, 1.75, 0, 0.12, 0.7, W * 0.84, GLASS, undefined, -0.3],
        [0, 0.55, 0, L * 0.98, 0.3, W * 0.9, TRIM],
        ...deck(1.1),
        ...deck(2.5),
        [-L * 0.14, 1.8, W * 0.48, L * 0.7, 1.4, 0.1, 0x8c939b],
        [-L * 0.14, 1.8, -W * 0.48, L * 0.7, 1.4, 0.1, 0x8c939b],
        ...cars,
        ...wheels(L, W, 0.9, [0.4, 0.25, -0.2, -0.32, -0.44]),
      ];
    }
    case 'cruiser':
    case 'compact':
      // Black-and-white police car (white doors and roof read from the chopper), push bar up front.
      return [...sedan(L, W, 'kind', 0xf1f1ee), [0.05, 0.66, 0, L * 0.42, 0.42, W * 1.01, 0xf1f1ee], [L / 2 + 0.12, 0.6, 0, 0.1, 0.45, W * 0.7, TRIM]];
  }
}

/**
 * Vehicle and prop bodies: every part of one model merged into a single vertex-coloured mesh, the geometry
 * cached per kind, colour and size and shared by every prop like it. More detail than the old separate
 * boxes for fewer draw calls (one per prop). Never disposed: it's shared.
 */
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const UNIT_WHEEL = new THREE.CylinderGeometry(0.5, 0.5, 1, 12).rotateX(Math.PI / 2); // axis across the vehicle
const bodyGeos = new Map<string, THREE.BufferGeometry>();
/** Textured ground (art pass): one shared toon material per colour and texture, the UVs in metres scaled by its tile. */
const groundMats = new Map<string, THREE.MeshToonMaterial>();
function groundMat(color: number, name: GroundTex): THREE.MeshToonMaterial {
  const key = `${color}:${name}`;
  let m = groundMats.get(key);
  if (!m) {
    const map = groundTexture(name).clone();
    map.repeat.set(1 / TILE[name], 1 / TILE[name]);
    map.needsUpdate = true;
    groundMats.set(key, (m = new THREE.MeshToonMaterial({ color, map, gradientMap: toonRamp(), side: THREE.DoubleSide })));
  }
  return m;
}
/**
 * Art pass (2026-11-24): the giant's ink outline on every vehicle, so the world and he read as one style. Each part's
 * box grown by `inkWidth` m per side, drawn back-faces-only in ink; merged into the body's geometry as a second group,
 * so it's one extra draw per vehicle, not one per part.
 */
const INK = new THREE.MeshBasicMaterial({ color: PALETTE.giantOutline, side: THREE.BackSide });
/** An outline for a box-shaped mesh (buildings, pylons): an ink copy grown `look.inkWidth` m per side, batched with it. */
function inkBox(m: THREE.Mesh, group: THREE.Group): THREE.Mesh {
  const w = TUNING.look.inkWidth * 2;
  const h = new THREE.Mesh(m.geometry, INK);
  h.position.copy(m.position);
  h.rotation.copy(m.rotation);
  h.scale.set(m.scale.x + w * 2, m.scale.y + w * 2, m.scale.z + w * 2);
  h.userData.batch = m.userData.batch;
  group.add(h);
  return m;
}
export function propBody(p: Pick<Prop, 'kind' | 'hl' | 'hw'>, kc: number): THREE.Mesh {
  const key = `${p.kind}:${kc}:${p.hl}:${p.hw}`;
  let geo = bodyGeos.get(key);
  if (!geo) {
    const col = new THREE.Color();
    const t = TUNING.look.inkWidth;
    const body: THREE.BufferGeometry[] = [];
    const hull: THREE.BufferGeometry[] = [];
    const all = partsFor(p as Prop);
    // Thin things (fences, toll arms) are all thin parts: outline every part so the hull is never empty.
    const thinOnly = all.every(([, , , w, h, d, , shape]) => Math.min(w, h, d) < 0.2 && shape !== 'wheel');
    for (const [x, y, z, w, h, d, c, shape, tilt] of all) {
      const make = (grow: number) => {
        const g = (shape === 'wheel' ? UNIT_WHEEL : UNIT_BOX).clone();
        g.scale(w + grow * 2, h + grow * 2, d + grow * 2);
        if (tilt) g.rotateZ(tilt);
        g.translate(x, y, z);
        return g;
      };
      const g = make(0);
      col.setHex(c === 'kind' ? kc : c);
      const n = g.getAttribute('position').count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) arr.set([col.r, col.g, col.b], i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      body.push(g);
      // Thin parts (glass, stripes, trim) sit on the body: only the bigger shapes get an outline, so it stays a silhouette.
      if (thinOnly || Math.min(w, h, d) >= 0.2 || shape === 'wheel') {
        const hg = make(t);
        hg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(hg.getAttribute('position').count * 3), 3));
        hull.push(hg);
      }
    }
    const b = mergeGeometries(body)!;
    const hl = mergeGeometries(hull)!;
    geo = mergeGeometries([b, hl], true)!;
    bodyGeos.set(key, geo);
  }
  return new THREE.Mesh(geo, [toon(0xffffff, { vertexColors: true }), INK]);
}

interface Debris {
  active: boolean;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  rx: number; ry: number; rz: number;
  wx: number; wy: number; wz: number;
  s: number; life: number;
}

const MAX_DEBRIS = 400; // §36: max 400 dynamic debris objects, pooled.

export class HighwayView {
  readonly group = new THREE.Group();
  private segViews = new Map<number, THREE.Group>();
  /** Test probe: the drawn group for a prop id (dev / test builds read it through __GAME). */
  propView(id: number): THREE.Group | undefined {
    return this.propViews.get(id);
  }
  private propViews = new Map<number, THREE.Group>();
  private twoWayLines: THREE.Mesh[] = [];
  private ground: THREE.Mesh;
  private debris: Debris[] = [];
  private debrisMesh: THREE.InstancedMesh;
  private debrisCursor = 0;
  private rings: { mesh: THREE.Mesh; t: number; max: number; scale: number; opacity: number }[] = [];
  private ringPool: THREE.Mesh[] = [];
  private cracks: { mesh: THREE.Mesh; t: number }[] = [];
  private crackCursor = 0;
  private tmp = new THREE.Object3D();
  private color = new THREE.Color();
  private box = new THREE.BoxGeometry(1, 1, 1);
  private ringGeo = (() => {
    const g = new THREE.RingGeometry(0.75, 1, 40);
    g.rotateX(-Math.PI / 2);
    return g;
  })();
  private pos = { x: 0, z: 0 };
  private cars = new Map<number, CarFx>();
  /** Smashed props and units: the real body tumbles off his line and comes to rest as a wreck. */
  private wrecks: { g: THREE.Object3D; vx: number; vy: number; vz: number; wx: number; wy: number; wz: number; half: number; t: number; bounced: number; ox: number; oz: number; sx: number; sz: number; wall: number }[] = [];
  private lampList: LampPos[] = [];
  private overpasses: { s: number; mat: THREE.MeshToonMaterial }[] = [];
  /** Tunnel roof beams: hidden near the giant (cheaper than fading; wrecks tumble there). */
  private tunnelBeams: { s: number; mesh: THREE.Mesh }[] = [];
  private lampsDirty = true;
  private fxTime = 0;
  private honkCd = 0;
  /** Called when a car honks (volume 0..1). */
  onHonk: ((vol: number, at: { x: number; z: number }) => void) | null = null;

  constructor(private sim: Sim) {
    const groundGeo = new THREE.PlaneGeometry(3000, 3000);
    groundGeo.rotateX(-Math.PI / 2);
    this.ground = new THREE.Mesh(groundGeo, toon(PALETTE.grass));
    this.ground.position.y = -0.05;
    this.group.add(this.ground);

    this.debrisMesh = new THREE.InstancedMesh(this.box, toon(0xffffff), MAX_DEBRIS);
    this.debrisMesh.frustumCulled = false;
    for (let i = 0; i < MAX_DEBRIS; i++) {
      this.debris.push({ active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, rz: 0, wx: 0, wy: 0, wz: 0, s: 0, life: 0 });
      this.debrisMesh.setColorAt(i, this.color.setHex(0xffffff));
      this.tmp.scale.set(0, 0, 0);
      this.tmp.updateMatrix();
      this.debrisMesh.setMatrixAt(i, this.tmp.matrix);
    }
    this.group.add(this.debrisMesh);

    const crackMat = new THREE.MeshBasicMaterial({ map: crackTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    const crackGeo = new THREE.PlaneGeometry(1, 1);
    crackGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < TUNING.footfall.crackMax; i++) {
      const m = new THREE.Mesh(crackGeo, crackMat.clone());
      m.visible = false;
      this.group.add(m);
      this.cracks.push({ mesh: m, t: Infinity });
    }
    this.sync();
  }

  // --- Streaming --------------------------------------------------------------------

  /** Build views for new segments/props and drop the ones the sim has pruned. */
  sync() {
    const track = this.sim.track;
    const live = new Set<number>();
    // Hold back the last two segments: a segment's merge warning needs the next two to exist.
    const ready = track.segments.slice(0, Math.max(0, track.segments.length - 2));
    for (const seg of track.segments) live.add(seg.index);
    // Lead-in road behind the start line while the first segment is still around (the opening High Head-On shot
    // looks back past him; without it the road began in a void). Render-only, negative indexes.
    if (track.segments[0]?.index === 0) {
      for (let k = 1; k <= TUNING.track.leadInSegments; k++) {
        live.add(-k);
        if (!this.segViews.has(-k)) {
          const g = this.buildSegment(this.leadIn(k));
          this.segViews.set(-k, g);
          this.group.add(g);
          this.lampsDirty = true;
        }
      }
    }
    // Perf (2026-11-25, simulated mid-range Android): building a segment (an avenue's storefronts most of all) is the
    // frame's biggest spike, so new ones are built `segBuildsPerFrame` at a time (all at once only on the first frame).
    // Segments are generated far ahead of the camera, so the spread never shows. Props wait for their segment.
    const first = this.segViews.size === 0;
    let built = 0;
    let lastBuilt = -1;
    for (const seg of ready) {
      if (!this.segViews.has(seg.index)) {
        // Anything near him is built now whatever the budget (replays and tests step the sim many ticks per render).
        if (!first && built >= TUNING.track.segBuildsPerFrame && seg.s0 > this.sim.giant.s + 150) break;
        const g = this.buildSegment(seg);
        this.segViews.set(seg.index, g);
        this.group.add(g);
        this.lampsDirty = true;
        built++;
      }
      lastBuilt = seg.index;
    }
    for (const [i, g] of this.segViews) {
      if (!live.has(i)) {
        this.group.remove(g);
        freeSegment(g, this.box);
        this.segViews.delete(i);
        this.lampsDirty = true;
      }
    }
    const liveProps = new Set<number>();
    const lastReady = lastBuilt;
    for (const p of track.props) {
      if (p.segment > lastReady) continue;
      // A prop that just died keeps its view: its smash/hijack event claims the body this frame.
      liveProps.add(p.id);
      if (!p.alive) continue;
      if (!this.propViews.has(p.id)) {
        const g = this.buildProp(p);
        this.propViews.set(p.id, g);
        this.group.add(g);
      }
    }
    // Prototype two-way stretches: a double yellow line between the directions (built once, ahead of him).
    // Built as the road is (Mike, 2026-11-24: in the tunnel it waited for the whole 640m district to exist first).
    for (const tw of track.twoWay) {
      const to = Math.min(tw.s1, track.end);
      const from = tw.builtTo ?? tw.s0;
      if (to <= from) continue;
      tw.builtTo = to;
      const W = TUNING.lanes.width;
      for (let s = from; s < to; s += 3) {
        for (const off of [-0.18, 0.18]) {
          const m = new THREE.Mesh(this.box, TWO_WAY_LINE);
          track.posAt(s, tw.split * W + off, this.pos);
          m.position.set(this.pos.x, 0.03, this.pos.z);
          m.rotation.y = -track.headingAt(s);
          m.scale.set(3.1, 0.02, 0.12); // solid: pieces overlap
          m.userData.twoWay = tw.s1;
          this.group.add(m);
          this.twoWayLines.push(m);
        }
      }
    }
    for (let i = this.twoWayLines.length - 1; i >= 0; i--) {
      if (this.twoWayLines[i].userData.twoWay < this.sim.giant.s - TUNING.track.keepBehind) {
        this.group.remove(this.twoWayLines[i]);
        this.twoWayLines.splice(i, 1);
      }
    }
    // Prototype moving traffic: built like the rest, then moved with the sim every frame (oncoming cars face him).
    for (const p of track.movers) {
      if (p.segment > lastReady) continue;
      liveProps.add(p.id);
      if (!p.alive) continue;
      let g = this.propViews.get(p.id);
      if (!g) {
        g = this.buildProp(p);
        this.propViews.set(p.id, g);
        this.group.add(g);
      }
      track.posAt(p.s, p.d, this.pos);
      g.position.set(this.pos.x, 0, this.pos.z);
      g.rotation.y = -track.headingAt(p.s) + (p.oncoming ? Math.PI : 0);
    }
    // Lane-changers (2026-11-24): follow the sim across, the blinker on the side it's going, a little steer into it.
    const blink = Math.sin(performance.now() / 120) > 0;
    for (const p of track.shifters) {
      const g = this.propViews.get(p.id);
      const c = this.cars.get(p.id);
      if (!g || !p.alive || !p.shift) continue;
      const sh = p.shift;
      track.posAt(p.s, p.d, this.pos);
      g.position.set(this.pos.x, 0, this.pos.z);
      const dir = Math.sign(sh.to - p.d);
      const steer = sh.state === 'move' ? TUNING.traffic.shiftYawDeg * (Math.PI / 180) * dir * Math.sin(Math.PI * Math.min(1, sh.t / TUNING.proto.shift.time)) : 0;
      const h = track.headingAt(p.s);
      // Which body side faces +d: the body's local +z in the world against the road's +d direction.
      g.rotation.y = -h - steer;
      if (c) {
        const across = { x: -Math.sin(h), z: Math.cos(h) };
        const zSide = Math.sin(g.rotation.y) * across.x + Math.cos(g.rotation.y) * across.z > 0 ? 1 : 0;
        const side = dir > 0 ? zSide : 1 - zSide;
        const on = (sh.state === 'signal' || sh.state === 'move') && blink;
        c.hazards.forEach((hz, i) => (hz.visible = on && i === side));
      }
    }
    for (const [id, g] of this.propViews) {
      if (!liveProps.has(id)) {
        this.group.remove(g);
        this.propViews.delete(id);
        this.cars.delete(id);
      }
    }
  }

  /**
   * The road's built width at s (walls, verge, pavement, scenery): the lane width smoothed, a max over
   * ±`edgeSmooth` m and then a ±`edgeSmooth` m average. A lane opening or closing then reads as a shoulder
   * becoming a lane (only the paint angles), not the whole road kinking (Mike, 2026-11-16: "angled edges").
   * Never narrower than the lanes. Needs the track `2 × edgeSmooth` ahead: segments are built two behind its end.
   */
  private edgeW(s: number): number {
    const key = Math.round(s * 4);
    const hit = this.edgeCache.get(key);
    if (hit !== undefined) return hit;
    const track = this.sim.track;
    const R = TUNING.track.edgeSmooth;
    const n = 8;
    let sum = 0;
    for (let k = 0; k <= n; k++) {
      const x = s - R + (2 * R * k) / n;
      let m = 0;
      for (let j = 0; j <= n; j++) m = Math.max(m, track.widthAt(x - R + (2 * R * j) / n));
      sum += m;
    }
    const w = sum / (n + 1);
    // Evict the oldest entries a few at a time (review #51: clearing 20,000 at once spiked one frame).
    if (this.edgeCache.size > 20000) {
      let n = 0;
      for (const k of this.edgeCache.keys()) {
        this.edgeCache.delete(k);
        if (++n >= 64) break;
      }
    }
    this.edgeCache.set(key, w);
    return w;
  }
  private edgeCache = new Map<number, number>();

  /** Sweep cross-sections along the segment's samples into one geometry. */
  private sweep(seg: Segment, section: (i: number, s: number, w: number) => [number, number][], from = 0, to = seg.length): THREE.BufferGeometry {
    const verts: number[] = [];
    const uvs: number[] = [];
    const idx: number[] = [];
    let k = 0;
    let prevCount = -1;
    for (let i = from; i <= to; i++) {
      const s = seg.s0 + i;
      const w = this.sim.track.widthAt(Math.min(s, seg.s0 + seg.length - 1e-6));
      const sec = section(i, s, w);
      const h = seg.hs[i];
      const rx = -Math.sin(h);
      const rz = Math.cos(h);
      for (const [d, y] of sec) {
        verts.push(seg.xs[i] + rx * d, y, seg.zs[i] + rz * d);
        uvs.push(d + y, s); // metres (d + y so walls get a vertical axis too); textures scale by their tile size
      }
      if (prevCount === sec.length) {
        const n = sec.length;
        const a0 = k - n;
        for (let j = 0; j < n - 1; j++) idx.push(a0 + j, k + j, a0 + j + 1, a0 + j + 1, k + j, k + j + 1);
      }
      prevCount = sec.length;
      k += sec.length;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  /** A straight segment `k` back from the start line, continuing the first one's heading and lanes. */
  private leadIn(k: number): Segment {
    const first = this.sim.track.segments[0];
    const L = TUNING.track.segmentLength;
    const s0 = first.s0 - k * L;
    const h = first.hs[0];
    const xs = new Float64Array(L + 1);
    const zs = new Float64Array(L + 1);
    const hs = new Float64Array(L + 1).fill(h);
    for (let i = 0; i <= L; i++) {
      const back = s0 + i - first.s0;
      xs[i] = first.xs[0] + Math.cos(h) * back;
      zs[i] = first.zs[0] + Math.sin(h) * back;
    }
    return { ...first, index: -k, s0, length: L, h0: h, h1: h, xs, zs, hs, lanes0: first.lanes0, lanes1: first.lanes0, kind: 'straight', zoneStart: false, overpass: false, landmark: undefined, landmarkName: undefined, exit: false, fork: undefined };
  }

  private buildSegment(seg: Segment): THREE.Group {
    const group = new THREE.Group();
    const W = TUNING.lanes.width;
    const wallH = TUNING.track.wallHeight;
    const add = (geo: THREE.BufferGeometry, color: number, basic = false, paint = false, tex?: GroundTex) => {
      const m = new THREE.Mesh(geo, tex && hasTexture(tex) ? groundMat(color, tex) : basic ? basicDouble(color) : toon(color, paint ? { side: THREE.DoubleSide, emissive: PAINT_GLOW } : { side: THREE.DoubleSide }));
      group.add(m);
      return m;
    };
    // Ground either side, by zone (Phase 2 road variety).
    const zone = seg.zone;
    if (zone === 'highway') {
      add(this.sweep(seg, () => [[-8, 0], [-0.9, 0.01]]), PALETTE.verge, false, false, 'verge');
      add(this.sweep(seg, (_i, s) => [[this.edgeW(s) + 0.9, 0.01], [this.edgeW(s) + 8, 0]]), PALETTE.verge, false, false, 'verge');
    } else if (zone === 'avenue') {
      // Sidewalks with a curb face.
      add(this.sweep(seg, () => [[-6, 0.16], [-0.9, 0.16], [-0.9, 0]]), PALETTE.sidewalk, false, false, 'paving');
      add(this.sweep(seg, (_i, s) => [[this.edgeW(s) + 0.9, 0], [this.edgeW(s) + 0.9, 0.16], [this.edgeW(s) + 6, 0.16]]), PALETTE.sidewalk, false, false, 'paving');
    } else if (zone === 'bridge') {
      // Open water under a deck slab.
      add(this.sweep(seg, (_i, s) => [[-160, -0.03], [this.edgeW(s) + 160, -0.03]]), PALETTE.water, false, false, 'water');
      add(this.sweep(seg, (_i, s) => [[-1.4, 0.02], [-1.4, -1.6], [this.edgeW(s) + 1.4, -1.6], [this.edgeW(s) + 1.4, 0.02]]), PALETTE.deck, false, false, 'concrete');
    } else {
      add(this.sweep(seg, (_i, s) => [[-1.6, 0.01], [this.edgeW(s) + 1.6, 0.01]]), PALETTE.deck);
    }
    add(this.sweep(seg, (_i, s) => [[-0.9, 0.02], [this.edgeW(s) + 0.9, 0.02]]), PALETTE.road, false, false, 'asphalt');
    add(this.sweep(seg, () => [[0.15, 0.035], [0.35, 0.035]]), PALETTE.edgeLineLeft, false, true);
    add(this.sweep(seg, (_i, _s, w) => [[w - 0.35, 0.035], [w - 0.15, 0.035]]), PALETTE.edgeLineRight, false, true);
    // Edge barriers (the sim's walls): concrete on the highway, a curb on the avenue,
    // a parapet on the bridge, the tunnel's own tiled walls.
    const [eh, ec] = zone === 'avenue' ? [0.3, PALETTE.curb] : zone === 'bridge' ? [0.9, PALETTE.deck] : zone === 'tunnel' ? [5.5, PALETTE.tunnelWall] : [wallH, PALETTE.wall];
    // No ink on the barrier walls: they run right beside his lane, and the line ate his night Head-On silhouette (E2E).
    const wallTex: GroundTex | undefined = zone === 'tunnel' ? 'tunnelTile' : zone === 'avenue' ? undefined : 'concrete';
    add(this.sweep(seg, () => [[-0.4, 0], [-0.4, eh], [-0.9, eh], [-0.9, 0]]), ec, false, false, wallTex);
    const exitSeg = this.exitFor(seg);
    if (exitSeg) this.buildRamp(seg, exitSeg, group);
    else add(this.sweep(seg, (_i, s) => [[this.edgeW(s) + 0.4, 0], [this.edgeW(s) + 0.4, eh], [this.edgeW(s) + 0.9, eh], [this.edgeW(s) + 0.9, 0]]), ec, false, false, wallTex);
    const nextExit = this.sim.track.segments.find((x) => (x.exit || x.fork) && x.index === seg.index + 1);
    if (nextExit) this.signGantry(seg, seg.s0 + 6, group, nextExit.fork?.name);

    // Dashed lane lines (3m dash, 6m gap), only where both lanes exist: an opening lane gets its line once it's
    // nearly full width (a line hugging the tapering edge read as a mistake; Mike, 2026-11-16).
    const dashGeo = FLAT_PLANE;
    const dashes: [number, number, number][] = [];
    for (let i = 0; i < seg.length; i++) {
      const s = seg.s0 + i + 0.5;
      if (((s % 9) + 9) % 9 >= 3) continue;
      const w = this.sim.track.widthAt(s);
      for (let b = 1; b < TUNING.lanes.max; b++) {
        if (b * W > w - W * TUNING.track.laneLineAt) break;
        dashes.push([s, b * W, this.sim.track.headingAt(s)]);
      }
    }
    if (dashes.length) {
      const m = new THREE.InstancedMesh(dashGeo, toon(PALETTE.roadLine, { emissive: PAINT_GLOW }), dashes.length);
      dashes.forEach(([s, d, h], j) => {
        this.sim.track.posAt(s, d, this.pos);
        this.tmp.position.set(this.pos.x, 0.035, this.pos.z);
        this.tmp.rotation.set(0, -h, 0);
        this.tmp.scale.set(1.02, 1, 0.18);
        this.tmp.updateMatrix();
        m.setMatrixAt(j, this.tmp.matrix);
      });
      group.add(m);
    }

    // Telegraphed merges: warning signs on the shoulder before the merge, chevrons in the closing lane.
    const merge = this.sim.track.segments.find((x) => x.kind === 'merge' && x.index >= seg.index && x.index <= seg.index + 2);
    if (merge) {
      const closing = merge.lanes1 < merge.lanes0;
      const sAt = merge.index === seg.index ? seg.s0 + 2 : seg.s0 + 20;
      const w = this.edgeW(sAt);
      // On a bridge the shoulder is open water: the sign stands on the parapet (Mike, 2026-11-17).
      this.sim.track.posAt(sAt, w + (zone === 'bridge' ? TUNING.look.bridgeMount : 2.5), this.pos);
      const sign = new THREE.Group();
      const post = new THREE.Mesh(this.box, toon(PALETTE.pole));
      post.scale.set(0.15, 3, 0.15);
      post.position.y = 1.5;
      // Reflective sign face: merges stay telegraphed at night.
      const board = new THREE.Mesh(this.box, toon(PALETTE.signWarn, { emissive: 0x6a3c08 }));
      board.scale.set(0.12, 1.6, 1.6);
      board.rotation.x = Math.PI / 4;
      board.position.y = 3.4;
      sign.add(post, board);
      sign.position.set(this.pos.x, 0, this.pos.z);
      sign.rotation.y = -this.sim.track.headingAt(sAt);
      group.add(sign);
      if (merge.index === seg.index && closing) {
        // Chevrons painted in the closing lane, pointing into the next lane.
        const lane = merge.lanes0 - 1;
        for (let i = 4; i < seg.length - 4; i += 7) {
          const s = seg.s0 + i;
          this.sim.track.posAt(s, (lane + 0.4) * W, this.pos);
          const chev = new THREE.Mesh(dashGeo, toon(PALETTE.roadLine, { emissive: 0x606060 }));
          chev.position.set(this.pos.x, 0.036, this.pos.z);
          chev.rotation.y = -this.sim.track.headingAt(s) - 0.6;
          chev.scale.set(2.2, 1, 0.3);
          group.add(chev);
        }
      }
    }

    // Roadside scenery (cosmetic, seeded per segment): sodium streetlights, trees, the odd building, gantries.
    const rng = new Rng((seg.index * 2654435761) >>> 0);
    const s = seg.s0 + 20;
    const w = this.edgeW(s);
    const h = this.sim.track.headingAt(s);
    group.userData.lamps = zone === 'tunnel' ? this.buildTunnel(seg, group) : this.buildLamps(seg, group);
    if (zone === 'avenue') this.buildStorefronts(seg, group, rng);
    if (zone === 'bridge') this.buildBridge(seg, group);
    if (seg.overpass) this.buildOverpass(seg, group);
    if (seg.landmark) this.buildLandmark(seg, group);
    if (zone === 'highway') {
    for (let t = 0; t < 7; t++) {
      const left = rng.chance(0.5);
      const off = rng.range(12, 40);
      const ss = seg.s0 + rng.range(0, seg.length);
      this.sim.track.posAt(ss, left ? -off : this.edgeW(ss) + off, this.pos);
      const scale = rng.range(0.8, 1.5);
      // Art pass (2026-11-24): pines (two stacked cones) and round trees (a faceted ball), each with the giant's ink
      // outline (a back-face copy grown a touch). All batched: a handful of instanced draws per segment.
      const tint = rng.pick(PALETTE.tree);
      const parts: [THREE.BufferGeometry, number, number, number][] = rng.chance(0.55)
        ? [[UNIT_CONE, 2.6, 3.6, 2.6], [UNIT_CONE, 1.9, 3.0, 4.6]] // [geo, radius, height, y]
        : [[UNIT_ICO, 2.3, 2.0, 3.6]];
      for (const [geo, r, hh, y] of parts) {
        const crown = new THREE.Mesh(geo, toon(tint));
        crown.scale.set(r * scale, hh * scale, r * scale);
        crown.position.set(this.pos.x, y * scale, this.pos.z);
        const ink = new THREE.Mesh(geo, INK);
        ink.scale.copy(crown.scale).multiplyScalar(1.04);
        ink.position.copy(crown.position);
        crown.userData.batch = ink.userData.batch = true;
        group.add(crown, ink);
      }
      const trunk = new THREE.Mesh(this.box, toon(PALETTE.trunk));
      trunk.userData.batch = true;
      trunk.scale.set(0.45, 2.2 * scale, 0.45);
      trunk.position.set(this.pos.x, 1.1 * scale, this.pos.z);
      group.add(trunk);
    }
    if (rng.chance(0.35)) {
      const left = rng.chance(0.5);
      const ss = seg.s0 + 20;
      this.sim.track.posAt(ss, left ? -rng.range(45, 70) : this.edgeW(ss) + rng.range(45, 70), this.pos);
      // Off-road blocks: lit windows like the avenue's, a roof cap and a rooftop unit.
      const b = new THREE.Mesh(this.box, facade(rng.pick(PALETTE.buildings), toonRamp()));
      const bh = rng.range(6, 16);
      const bw = rng.range(14, 26);
      const bd = rng.range(14, 26);
      b.scale.set(bw, bh, bd);
      b.position.set(this.pos.x, bh / 2, this.pos.z);
      b.rotation.y = -h;
      inkBox(b, group);
      const cap = new THREE.Mesh(this.box, toon(PALETTE.roofCap));
      cap.scale.set(bw + 0.4, 0.5, bd + 0.4);
      cap.position.set(this.pos.x, bh + 0.25, this.pos.z);
      cap.rotation.y = -h;
      const unit = new THREE.Mesh(this.box, toon(PALETTE.roofUnit));
      unit.scale.set(3, 1.4, 2.4);
      unit.position.set(this.pos.x + 2, bh + 1.2, this.pos.z - 1.5);
      unit.rotation.y = -h;
      group.add(b, cap, unit);
    }
    if (seg.index % 6 === 4) {
      // Overhead gantry with green signs (the reference footage has these).
      const g = new THREE.Group();
      const span = w + 3;
      const leftPos = this.sim.track.posAt(s, -1.5, { x: 0, z: 0 });
      const rightPos = this.sim.track.posAt(s, w + 1.5, { x: 0, z: 0 });
      for (const pp of [leftPos, rightPos]) {
        const post = new THREE.Mesh(this.box, toon(PALETTE.pole));
        post.scale.set(0.35, 7.5, 0.35);
        post.position.set(pp.x, 3.75, pp.z);
        g.add(post);
      }
      const mid = this.sim.track.posAt(s, w / 2, { x: 0, z: 0 });
      const beam = new THREE.Mesh(this.box, toon(PALETTE.pole));
      beam.scale.set(0.4, 0.4, span);
      beam.position.set(mid.x, 7.4, mid.z);
      beam.rotation.y = -h;
      g.add(beam);
      const lanes = this.sim.track.lanesAt(s);
      for (let l = 0; l < Math.min(lanes, 3); l++) {
        const sp = this.sim.track.posAt(s, (l + 0.5) * W + (lanes > 3 ? W / 2 : 0), { x: 0, z: 0 });
        const board = new THREE.Mesh(this.box, toon(PALETTE.sign));
        board.scale.set(0.15, 1.6, 3.2);
        board.position.set(sp.x, 6.4, sp.z);
        board.rotation.y = -h;
        g.add(board);
      }
      group.add(g);
    }
    }
    this.batchStatic(group);
    return group;
  }

  /** Phase 2 avenue: storefronts shoulder to shoulder, lit windows at night, awnings at street level. */
  /**
   * Static set dressing marked `batch` (storefronts, trees, festoon bulbs) is merged into one instanced draw
   * per geometry and material (review #48/#49: an avenue segment was 120–250 draw calls).
   */
  private batchStatic(group: THREE.Group) {
    const sets = new Map<string, THREE.Mesh[]>();
    const keys = new Map<object, number>();
    const id = (o: object) => keys.get(o) ?? (keys.set(o, keys.size), keys.size - 1);
    for (const o of group.children) {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.userData.batch || Array.isArray(m.material)) continue;
      const k = `${id(m.geometry)}:${id(m.material)}`;
      let list = sets.get(k);
      if (!list) sets.set(k, (list = []));
      list.push(m);
    }
    for (const list of sets.values()) {
      if (list.length < 3) continue;
      const inst = new THREE.InstancedMesh(list[0].geometry, list[0].material as THREE.Material, list.length);
      list.forEach((m, i) => {
        m.updateMatrix();
        inst.setMatrixAt(i, m.matrix);
        group.remove(m);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.computeBoundingSphere();
      group.add(inst);
    }
  }

  private buildStorefronts(seg: Segment, group: THREE.Group, rng: Rng) {
    const track = this.sim.track;
    // An exit ramp curves out through the right-hand plots: leave them empty near it.
    const ramp = this.nearRamp(seg);
    for (const left of [true, false]) {
      if (!left && ramp) continue;
      let a = 0;
      while (a < seg.length) {
        const wid = rng.range(9, 15);
        const sMid = seg.s0 + a + wid / 2;
        if (sMid > seg.s0 + seg.length) break;
        const w = this.edgeW(sMid);
        const depth = rng.range(10, 16);
        const ht = rng.range(8, 20);
        const d = left ? -6 - depth / 2 : w + 6 + depth / 2;
        track.posAt(sMid, d, this.pos);
        const color = rng.pick(PALETTE.storefronts);
        const rot = -track.headingAt(sMid);
        const at = (dd: number) => track.posAt(sMid, d + (left ? -1 : 1) * dd, { x: 0, z: 0 });
        const put = (m: THREE.Mesh, sx: number, sy: number, sz: number, y: number, p: { x: number; z: number }) => {
          m.scale.set(sx, sy, sz);
          m.position.set(p.x, y, p.z);
          m.rotation.y = rot;
          m.userData.batch = true;
          group.add(m);
          return m;
        };
        // Tall ones step back above the fifth floor or so; every roof gets a parapet and a unit or two.
        const setback = ht > 14;
        const lowH = setback ? ht * 0.68 : ht;
        inkBox(put(new THREE.Mesh(this.box, facade(color, toonRamp())), wid - 0.6, lowH, depth, lowH / 2, at(0)), group);
        put(new THREE.Mesh(this.box, toon(PALETTE.roofCap)), wid - 0.3, 0.45, depth + 0.3, lowH + 0.22, at(0));
        let roofY = lowH + 0.45;
        if (setback) {
          const upH = ht - lowH;
          inkBox(put(new THREE.Mesh(this.box, facade(color, toonRamp())), (wid - 0.6) * 0.7, upH, depth * 0.65, lowH + upH / 2, at(depth * 0.12)), group);
          put(new THREE.Mesh(this.box, toon(PALETTE.roofCap)), (wid - 0.6) * 0.7 + 0.3, 0.4, depth * 0.65 + 0.3, ht + 0.2, at(depth * 0.12));
          roofY = ht + 0.4;
        }
        for (let k = 0; k < rng.int(1, 2); k++) put(new THREE.Mesh(this.box, toon(PALETTE.roofUnit)), rng.range(1.4, 2.4), 1.1, rng.range(1.4, 2.4), roofY + 0.55, at(rng.range(1, depth * 0.5)));
        // Street level: awning, and a lit sign band above it (it reads as a shop from the chopper).
        const front = track.posAt(sMid, left ? -6.6 : w + 6.6, { x: 0, z: 0 });
        put(new THREE.Mesh(this.box, toon(rng.pick(PALETTE.awnings))), wid - 1.5, 0.25, 1.6, 3.2, front);
        const sign = track.posAt(sMid, left ? -6.05 : w + 6.05, { x: 0, z: 0 });
        const sc = rng.pick(PALETTE.signs);
        put(new THREE.Mesh(this.box, toon(sc, { emissive: sc, emissiveIntensity: 0.55 })), (wid - 0.6) * rng.range(0.45, 0.75), 0.9, 0.2, 4.4, sign);
        a += wid;
      }
    }
  }

  /** Phase 2 bridge: suspension towers at the start of the span and cables running along it. */
  private buildBridge(seg: Segment, group: THREE.Group) {
    const track = this.sim.track;
    const H = 38;
    const tower = (s: number) => {
      const w = this.edgeW(s);
      for (const d of [-2.4, w + 2.4]) {
        const p = track.posAt(s, d, { x: 0, z: 0 });
        const m = new THREE.Mesh(this.box, toon(0x8a6f62));
        m.scale.set(2, H, 2);
        m.position.set(p.x, H / 2 - 1.6, p.z);
        group.add(m);
        inkBox(m, group);
      }
      const mid = track.posAt(s, w / 2, { x: 0, z: 0 });
      const beam = new THREE.Mesh(this.box, toon(0x8a6f62));
      beam.scale.set(1.6, 1.6, w + 6.8);
      beam.position.set(mid.x, H - 3, mid.z);
      beam.rotation.y = -track.headingAt(s);
      group.add(beam);
      inkBox(beam, group);
    };
    if (seg.zoneStart) tower(seg.s0 + 6);
    // Main cables sagging along the span, one per side.
    for (const side of [0, 1]) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= seg.length; i += 4) {
        const s = seg.s0 + i;
        const w = this.edgeW(s);
        const p = track.posAt(s, side ? w + 2.4 : -2.4, { x: 0, z: 0 });
        const k = (i / seg.length) * Math.PI;
        pts.push(new THREE.Vector3(p.x, H - 4 - Math.sin(k) * 26 * (seg.zoneStart ? 0.5 : 1), p.z));
      }
      const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.18, 4);
      group.add(new THREE.Mesh(geo, toon(0xb7a89a)));
    }
  }

  /** Phase 2 tunnel (cutaway: the chopper sees in): roof beams, orange wall lights, portals. Returns its lights as lamps. */
  private buildTunnel(seg: Segment, group: THREE.Group): LampPos[] {
    const track = this.sim.track;
    const lamps: LampPos[] = [];
    for (let i = 4; i < seg.length; i += 10) {
      const s = seg.s0 + i;
      const w = this.edgeW(s);
      const h = track.headingAt(s);
      const mid = track.posAt(s, w / 2, { x: 0, z: 0 });
      const beam = new THREE.Mesh(this.box, toon(PALETTE.tunnelWall));
      this.tunnelBeams.push({ s, mesh: beam }); // hidden around him so the tumble stays readable
      beam.scale.set(0.5, 0.6, w + 1.8);
      beam.position.set(mid.x, 5.6, mid.z);
      beam.rotation.y = -h;
      group.add(beam);
      for (const d of [-0.35, w + 0.35]) {
        const p = track.posAt(s, d, { x: 0, z: 0 });
        const strip = new THREE.Mesh(this.box, LENS);
        strip.scale.set(2.4, 0.18, 0.12);
        strip.position.set(p.x, 4.4, p.z);
        strip.rotation.y = -h;
        const halo = new THREE.Sprite(GLOW.lampHalo);
        halo.position.set(p.x, 4.4, p.z);
        halo.scale.set(3, 2, 1);
        group.add(strip, halo);
      }
      lamps.push({ x: mid.x, y: 5.2, z: mid.z });
    }
    // Portals: a roofed mouth where the tunnel starts and ends.
    const next = track.segments.find((x) => x.index === seg.index + 1);
    const portal = (s: number) => {
      const w = this.edgeW(s);
      const mid = track.posAt(s, w / 2, { x: 0, z: 0 });
      const roofMat = new THREE.MeshToonMaterial({ color: PALETTE.tunnelWall, gradientMap: toonRamp(), transparent: true });
      this.overpasses.push({ s, mat: roofMat }); // fades like an overpass while he passes under
      const roof = new THREE.Mesh(this.box, roofMat);
      roof.scale.set(4, 2.2, w + 6);
      roof.position.set(mid.x, 6.6, mid.z);
      roof.rotation.y = -track.headingAt(s);
      const trim = new THREE.Mesh(this.box, toon(PALETTE.tunnelTrim, { emissive: 0x3a2a08 }));
      trim.scale.set(4.2, 0.35, w + 6.2);
      trim.position.set(mid.x, 5.55, mid.z);
      trim.rotation.y = roof.rotation.y;
      group.add(roof, trim);
    };
    if (seg.zoneStart) portal(seg.s0 + 2);
    if (next && next.zone !== 'tunnel') portal(seg.s0 + seg.length - 2);
    return lamps;
  }

  /**
   * Content pass landmarks (TUNING.landmarks): scenery that says what the set piece is from the chopper.
   * The lane props are the sim's; this only reads them (where the toll's open lane is, which lane is closed).
   */
  private buildLandmark(seg: Segment, group: THREE.Group) {
    const track = this.sim.track;
    const lanes = seg.lanes0;
    const W = TUNING.lanes.width;
    const props = track.props.filter((p) => p.segment === seg.index);
    const add = (s: number, d: number, y: number, sx: number, sy: number, sz: number, mat: THREE.Material) => {
      track.posAt(s, d, this.pos);
      const m = new THREE.Mesh(this.box, mat);
      m.scale.set(sx, sy, sz);
      m.position.set(this.pos.x, y, this.pos.z);
      m.rotation.y = -track.headingAt(s);
      group.add(m);
      return m;
    };
    switch (seg.landmark) {
      case 'toll': {
        const gates = props.filter((p) => p.kind === 'tollgate');
        const s = gates[0]?.s ?? seg.s0 + 22;
        const shut = new Set(gates.map((p) => Math.floor(p.d / W)));
        const w = lanes * W;
        // A canopy on posts over the plaza (fades like an overpass while he's under it), booths on the islands.
        const roof = new THREE.MeshToonMaterial({ color: 0xd8d2c4, gradientMap: toonRamp(), transparent: true, opacity: 1 });
        add(s, w / 2, 6.4, 7, 0.6, w + 6, roof);
        add(s + 3.4, w / 2, 5.9, 0.3, 0.5, w + 6, new THREE.MeshToonMaterial({ color: 0x1e6b3a, gradientMap: toonRamp(), transparent: true }));
        for (const d of [-2.2, w + 2.2]) add(s, d, 3.1, 0.6, 6.2, 0.6, toon(0x9a948a));
        for (let k = 1; k < lanes; k++) add(s, k * W, 1.2, 2.6, 2.4, 0.7, toon(0xf2efe8));
        // A light over each lane: green over the open one, red over the gates.
        for (let l = 0; l < lanes; l++) add(s - 3.6, (l + 0.5) * W, 5.85, 0.2, 0.45, 0.9, toon(shut.has(l) ? 0xd01818 : 0x2bd15a, { emissive: shut.has(l) ? 0x8a0a0a : 0x14a83a }));
        this.overpasses.push({ s, mat: roof });
        break;
      }
      case 'foodtrucks': {
        // Festoon lights strung across the street.
        const w = this.edgeW(seg.s0 + 20);
        const bulbs = [0xffd27a, 0xff9a5a, 0xfff2c4];
        for (const s of [seg.s0 + 4, seg.s0 + 19, seg.s0 + 34]) {
          add(s, w / 2, 6.6, 0.05, 0.05, w + 12, toon(0x2a2230));
          for (let d = -5; d <= w + 5; d += 1.6) batchable(add(s, d, 6.45 - 0.25 * Math.sin(((d + 5) / (w + 10)) * Math.PI), 0.22, 0.22, 0.22, toon(bulbs[Math.abs(Math.round(d * 3)) % 3], { emissive: 0xc98a2a })));
        }
        break;
      }
      case 'works': {
        const bar = props.find((p) => p.kind === 'barricade');
        const closed = bar ? Math.floor(bar.d / W) : 0;
        const edge = closed === 0 ? W : closed * W; // the lane line beside the closed lane
        const inward = closed === 0 ? -0.5 : 0.5;
        // Arrow board at the start of the closure, cones along the line from there on.
        add(seg.s0 + 1, (closed + 0.5) * W, 1.9, 0.3, 1.8, 2.6, toon(0x2b2b2e));
        add(seg.s0 + 0.8, (closed + 0.5) * W, 2.1, 0.1, 0.9, 2.0, toon(0xf08a24, { emissive: 0xc05a10 }));
        add(seg.s0 + 1, (closed + 0.5) * W, 0.5, 0.6, 1.0, 0.25, toon(0x6d737a));
        for (let s = seg.s0 + 3; s < seg.s0 + seg.length; s += 3.5) add(s, edge + inward, 0.4, 0.4, 0.8, 0.4, toon(0xf08a24));
        break;
      }
      case 'jam':
        break; // the stalled cars are the set piece (their brake lights are already on)
    }
  }

  /** Phase 2 overpass: a road bridge crossing overhead. Its deck fades when the giant passes under (never hides him). */
  private buildOverpass(seg: Segment, group: THREE.Group) {
    const track = this.sim.track;
    const s = seg.s0 + 20;
    const w = this.edgeW(s);
    const h = track.headingAt(s);
    const mat = new THREE.MeshToonMaterial({ color: 0x9a948a, gradientMap: toonRamp(), transparent: true, opacity: 1 });
    const mid = track.posAt(s, w / 2, { x: 0, z: 0 });
    const deck = new THREE.Mesh(this.box, mat);
    deck.scale.set(11, 1.3, w + 40);
    deck.position.set(mid.x, 8, mid.z);
    deck.rotation.y = -h;
    const rail = new THREE.Mesh(this.box, mat);
    rail.scale.set(0.4, 1, w + 40);
    rail.position.set(mid.x, 9.1, mid.z);
    rail.rotation.y = -h;
    group.add(deck, rail);
    for (const d of [-3, w + 3]) {
      const p = track.posAt(s, d, { x: 0, z: 0 });
      const pier = new THREE.Mesh(this.box, mat);
      pier.scale.set(3, 7.4, 2.2);
      pier.position.set(p.x, 3.7, p.z);
      pier.rotation.y = -h;
      group.add(pier);
    }
    this.overpasses.push({ s, mat });
  }

  /**
   * Phase 0c sodium streetlights, every `lampSpacing` metres on alternating sides:
   * pole, arm over the road, lamp head with a halo, and a light pool on the road.
   */
  private buildLamps(seg: Segment, group: THREE.Group): LampPos[] {
    const lamps: LampPos[] = [];
    const sp = TUNING.look.lampSpacing;
    const track = this.sim.track;
    const pool = FLAT_PLANE;
    for (let s = Math.ceil(seg.s0 / sp) * sp; s < seg.s0 + seg.length; s += sp) {
      const w = this.edgeW(s);
      const h = track.headingAt(s);
      const left = Math.round(s / sp) % 2 === 0;
      if (!left && (this.exitFor(seg) || this.nearRamp(seg))) continue; // the ramp peels off on the right
      // Downtown (Mike, 2026-11-25: "random lines through the middle" of buildings): a 9m pole on the sidewalk is
      // drawn across the facade behind it from the chopper. There the lamps hang off the building fronts instead:
      // no pole, the arm reaching out from the wall (storefronts start 6m out and are 8m+ tall).
      const wall = seg.zone === 'avenue';
      const out = wall ? 6 : seg.zone === 'bridge' ? TUNING.look.bridgeMount : 1.6; // bridge lamps stand on the parapet, not the water
      const baseD = left ? -out : w + out;
      const headD = left ? 2.0 : w - 2.0;
      const H = wall ? 6.5 : 9;
      const base = track.posAt(s, baseD, { x: 0, z: 0 });
      const head = track.posAt(s, headD, { x: 0, z: 0 });
      const pole = new THREE.Mesh(this.box, toon(PALETTE.pole));
      pole.scale.set(0.22, H, 0.22);
      pole.position.set(base.x, H / 2, base.z);
      const arm = new THREE.Mesh(this.box, toon(PALETTE.pole));
      const mid = track.posAt(s, (baseD + headD) / 2, { x: 0, z: 0 });
      arm.scale.set(0.16, 0.16, Math.abs(headD - baseD));
      arm.position.set(mid.x, H, mid.z);
      arm.rotation.y = -h;
      const housing = new THREE.Mesh(this.box, toon(0x3a3a40));
      housing.scale.set(1.0, 0.22, 0.5);
      housing.position.set(head.x, H - 0.05, head.z);
      housing.rotation.y = -h;
      const lens = new THREE.Mesh(this.box, LENS);
      lens.scale.set(0.8, 0.05, 0.36);
      lens.position.set(head.x, H - 0.18, head.z);
      lens.rotation.y = -h;
      const halo = new THREE.Sprite(GLOW.lampHalo);
      halo.scale.set(3.4, 3.4, 1);
      halo.position.set(head.x, H - 0.3, head.z);
      const p = new THREE.Mesh(pool, GLOW.lampPool);
      const pc = track.posAt(s, left ? Math.min(headD + 1.5, w / 2) : Math.max(headD - 1.5, w / 2), { x: 0, z: 0 });
      p.position.set(pc.x, 0.05, pc.z);
      p.rotation.y = -h;
      p.scale.set(17, 1, 14);
      p.renderOrder = 1;
      group.add(arm, housing, lens, halo, p);
      if (!wall) group.add(pole);
      lamps.push({ x: head.x, y: H, z: head.z });
    }
    return lamps;
  }

  /** An exit ramp leaves within a segment before or two after this one (its path out crosses the right side). */
  private nearRamp(seg: Segment): boolean {
    return this.sim.track.segments.some((x) => (x.exit || x.fork) && x.index >= seg.index - 2 && x.index <= seg.index + 1);
  }

  /** The exit (sign-off or fork) segment this segment's ramp belongs to (the exit segment itself or the one after it). */
  private exitFor(seg: Segment): Segment | null {
    return this.sim.track.segments.find((x) => (x.exit || x.fork) && (x.index === seg.index || x.index === seg.index - 1)) ?? null;
  }

  /** A fork was taken: every segment view from `from` on is stale (the road there was rebuilt). */
  rebuildFrom(from: number) {
    this.rebuild([...this.segViews.keys()].filter((i) => i >= from));
  }

  /** Rebuild segment views (the exit opens on segments already built ahead). */
  rebuild(indices: number[]) {
    for (const i of indices) {
      const g = this.segViews.get(i);
      if (!g) continue;
      this.group.remove(g);
      freeSegment(g, this.box);
      this.segViews.delete(i);
    }
    this.lampsDirty = true;
    this.sync();
  }

  /** Phase 2 sign-off ramp: a lane peeling away right, its outer barrier, a gore barrier and chevrons. */
  private buildRamp(seg: Segment, ex: Segment, group: THREE.Group) {
    const track = this.sim.track;
    const wallH = TUNING.track.wallHeight;
    const c = (s: number, w: number) => w + track.exitOffset(ex, s);
    const mat = (color: number) => toon(color, { side: THREE.DoubleSide });
    group.add(new THREE.Mesh(this.sweep(seg, (_i, s, w) => [[c(s, w) - 2.4, 0.022], [c(s, w) + 2.4, 0.022]]), mat(PALETTE.road)));
    group.add(new THREE.Mesh(this.sweep(seg, (_i, s, w) => [[c(s, w) + 2.6, 0], [c(s, w) + 2.6, wallH], [c(s, w) + 3.1, wallH], [c(s, w) + 3.1, 0]]), mat(PALETTE.wall)));
    group.add(new THREE.Mesh(this.sweep(seg, (_i, s, w) => [[c(s, w) + 2.0, 0.036], [c(s, w) + 2.2, 0.036]]), toon(PALETTE.edgeLineRight, { side: THREE.DoubleSide, emissive: 0x303030 })));
    // Gore barrier once the ramp has pulled clear of the road.
    let i0 = -1;
    for (let i = 0; i <= seg.length; i++) {
      const s = seg.s0 + i;
      if (c(s, track.widthAt(s)) - 2.6 > track.widthAt(s) + 0.4) {
        i0 = i;
        break;
      }
    }
    if (i0 >= 0 && i0 < seg.length) {
      group.add(new THREE.Mesh(this.sweep(seg, (_i, _s, w) => [[w + 0.4, 0], [w + 0.4, wallH], [w + 0.9, wallH], [w + 0.9, 0]], i0), mat(PALETTE.wall)));
      group.add(new THREE.Mesh(this.sweep(seg, (_i, s, w) => [[c(s, w) - 2.9, 0], [c(s, w) - 2.9, wallH], [c(s, w) - 2.4, wallH], [c(s, w) - 2.4, 0]], i0), mat(PALETTE.wall)));
    }
    // Gore chevrons where the ramp splits.
    if (seg === ex) {
      const dash = FLAT_PLANE;
      for (let k = 0; k < 4; k++) {
        const s = seg.s0 + TUNING.segment.goreAt - 6 + k * 3;
        const w = track.widthAt(s);
        track.posAt(s, (w + c(s, w) - 2.4) / 2, this.pos);
        const chev = new THREE.Mesh(dash, toon(0xf0c64a, { emissive: 0x806010 }));
        chev.position.set(this.pos.x, 0.04, this.pos.z);
        chev.rotation.y = -track.headingAt(s) + 0.6;
        chev.scale.set(2.4, 1, 0.35);
        group.add(chev);
      }
      this.signGantry(seg, seg.s0 + 4, group, ex.fork?.name);
    }
  }

  /** Green overhead sign over the rightmost lane: "SIGN-OFF / EXIT 6". */
  private signGantry(seg: Segment, s: number, group: THREE.Group, fork?: string) {
    const track = this.sim.track;
    const w = track.widthAt(s);
    const h = track.headingAt(s);
    const lane = track.lanesAt(s) - 1;
    const post = track.posAt(s, w + 1.6, { x: 0, z: 0 });
    const p = new THREE.Mesh(this.box, toon(PALETTE.pole));
    p.scale.set(0.35, 7.5, 0.35);
    p.position.set(post.x, 3.75, post.z);
    const mid = track.posAt(s, track.laneCenter(lane), { x: 0, z: 0 });
    const arm = new THREE.Mesh(this.box, toon(PALETTE.pole));
    const armMid = track.posAt(s, (track.laneCenter(lane) + w + 1.6) / 2, { x: 0, z: 0 });
    arm.scale.set(0.3, 0.3, w + 1.6 - track.laneCenter(lane) + 1.6);
    arm.position.set(armMid.x, 7.4, armMid.z);
    arm.rotation.y = -h;
    // Fades like an overpass while he runs under it.
    const green = new THREE.MeshToonMaterial({ color: fork ? 0x1e6b3a : SIGNOFF_RED, gradientMap: toonRamp(), transparent: true });
    const face = new THREE.MeshBasicMaterial({ map: signTexture(fork), transparent: true });
    this.overpasses.push({ s, mat: green }, { s, mat: face as unknown as THREE.MeshToonMaterial });
    const board = new THREE.Mesh(this.box, [green, face, green, green, green, green]);
    board.scale.set(0.2, 2.6, 3.8);
    board.position.set(mid.x, 6.3, mid.z);
    // The sign face (box −X side, material 1) faces back down the road toward the giant and the chopper.
    board.rotation.y = -h;
    group.add(p, arm, board);
    void seg;
  }

  /** Every streetlight head currently built (for the real lights in the rig). */
  get lamps(): LampPos[] {
    if (this.lampsDirty) {
      this.lampList.length = 0;
      for (const g of this.segViews.values()) this.lampList.push(...((g.userData.lamps as LampPos[]) ?? []));
      this.lampsDirty = false;
    }
    return this.lampList;
  }

  /** Phase 3: a stand-alone vehicle body (the hijacked car under the giant). Not tracked as a prop. */
  vehicleMesh(p: Prop): THREE.Group {
    const g = new THREE.Group();
    const colors = KIND_COLORS[p.kind];
    const kc = colors[p.variant % colors.length];
    g.add(propBody(p, kc));
    g.userData.colors = [kc];
    g.userData.roof = Math.max(...partsFor(p).map((q) => q[1] + q[4] / 2));
    return g;
  }

  /** Phase 3: remove a prop's view without debris (the hijacked car becomes the ride mesh). */
  drop(propId: number) {
    const g = this.propViews.get(propId);
    if (g) this.group.remove(g);
    this.propViews.delete(propId);
    this.cars.delete(propId);
  }

  /** Phase 3 The Stare: a prop the sim moved over a lane glides there (0.5s) with its hazards on. */
  private slides: { g: THREE.Group; fx: number; fz: number; tx: number; tz: number; t: number }[] = [];
  slide(propId: number) {
    const g = this.propViews.get(propId);
    const p = this.sim.track.props.find((q) => q.id === propId);
    if (!g || !p) return;
    this.sim.track.posAt(p.s, p.d, this.pos);
    this.slides.push({ g, fx: g.position.x, fz: g.position.z, tx: this.pos.x, tz: this.pos.z, t: 0 });
    const car = this.cars.get(propId);
    if (car) for (const h of car.hazards) h.visible = true;
  }

  private buildProp(p: Prop): THREE.Group {
    const g = new THREE.Group();
    // Parts sit on a body group so cars can swerve and bounce without moving the prop's root.
    const body = new THREE.Group();
    g.add(body);
    const colors = KIND_COLORS[p.kind];
    const kc = colors[p.variant % colors.length];
    body.add(propBody(p, kc));
    this.sim.track.posAt(p.s, p.d, this.pos);
    g.position.set(this.pos.x, 0, this.pos.z);
    g.rotation.y = -this.sim.track.headingAt(p.s);
    g.userData.colors = [kc, ...partsFor(p).map((q) => (q[6] === 'kind' ? kc : q[6]))];
    if (p.kind === 'car' || p.kind === 'van' || p.kind === 'newsvan') this.addCarLights(p, g, body);
    // Prototype (dodge until you can smash): what crumbles underfoot in Stride wears a bright ring on the road, so it
    // reads from the chopper at a glance: ring = crunch it, no ring = dodge it.
    // Rival vans break in Stride too, so they wear it as well (Mike, 2026-11-19: the giant seemed to go through cars).
    if (p.kind === 'scoop' || (TUNING.proto.on && p.kind === 'newsvan')) {
      const ring = new THREE.Mesh(SMASH_RING_GEO, SMASH_RING_MAT);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.04;
      const r = Math.max(p.hw, p.hl) + 0.5;
      ring.scale.set(r, r, 1);
      g.add(ring);
    }
    if (p.bounty) {
      const ring = new THREE.Mesh(TARGET_RING_GEO, TARGET_RING_MAT);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.05;
      const r = Math.max(p.hw, p.hl) + 1.2;
      ring.scale.set(r, r, 1);
      ring.onBeforeRender = () => {
        const k = 1 + 0.12 * Math.sin(performance.now() / 160);
        ring.scale.set(r * k, r * k, 1);
      };
      g.add(ring);
      // A flashing amber beacon on the roof and a gold stripe down the sides.
      const beacon = new THREE.Sprite(GLOW.hazardHalo);
      beacon.position.set(0, p.h + 0.5, 0);
      beacon.onBeforeRender = () => beacon.scale.setScalar(Math.sin(performance.now() / 110) > 0 ? 2.8 : 1.4);
      body.add(beacon);
      const stripe = new THREE.Mesh(this.box, toon(0xf2b632));
      stripe.scale.set(p.hl * 2 + 0.04, 0.22, p.hw * 2 + 0.04);
      stripe.position.y = p.h * 0.55;
      body.add(stripe);
    }
    return g;
  }

  /** Phase 0c: head and tail lights (lens + halo), a headlight throw on the road, hidden hazards. */
  private addCarLights(p: Prop, g: THREE.Group, body: THREE.Group) {
    const L = p.hl * 2;
    const W = p.hw * 2;
    const y = p.kind === 'van' ? 0.95 : 0.72;
    const tails: THREE.Sprite[] = [];
    const hazards: THREE.Sprite[] = [];
    for (const side of [-1, 1]) {
      const z = side * W * 0.36;
      const tl = new THREE.Mesh(this.box, TAIL);
      tl.scale.set(0.06, 0.2, 0.38);
      tl.position.set(-L / 2 - 0.02, y, z);
      const hl = new THREE.Mesh(this.box, HEAD);
      hl.scale.set(0.06, 0.18, 0.36);
      hl.position.set(L / 2 + 0.02, y - 0.05, z);
      const th = new THREE.Sprite(GLOW.tailHalo);
      th.position.set(-L / 2 - 0.15, y, z);
      th.scale.set(1.3, 1.3, 1);
      const hh = new THREE.Sprite(GLOW.headHalo);
      hh.position.set(L / 2 + 0.2, y - 0.05, z);
      hh.scale.set(1.6, 1.6, 1);
      body.add(tl, hl, th, hh);
      tails.push(th);
      // Hazards at the rear corners only: the chopper sees cars from behind.
      const hz = new THREE.Sprite(GLOW.hazardHalo);
      hz.position.set(-L / 2 - 0.1, y + 0.12, side * W * 0.5);
      hz.scale.set(1.1, 1.1, 1);
      hz.visible = false;
      body.add(hz);
      hazards.push(hz);
    }
    // Two throws, one per headlight, on the body so they move with the car (Mike, 2026-11-24: one cone looked tacky).
    for (const side of [-1, 1]) {
      const beam = new THREE.Mesh(FLAT_PLANE, GLOW.headPool);
      beam.position.set(L / 2 + 5.6, 0.055, side * W * 0.36);
      beam.scale.set(11, 1, 3.6);
      beam.renderOrder = 1;
      body.add(beam);
    }
    void g;
    this.cars.set(p.id, { prop: p, group: g, body, tails, hazards, braking: false, swerveT: -1, swerveDir: 1, honked: false, bounceY: 0, bounceV: 0, brushT: -1, brushDir: 1 });
  }

  /** Rampage footfall: cars nearby bounce on their suspension (presentation only). */
  stomp(x: number, z: number) {
    const T = TUNING.traffic;
    const omega = T.bounceHz * Math.PI * 2;
    for (const c of this.cars.values()) {
      const dx = c.group.position.x - x;
      const dz = c.group.position.z - z;
      const d = Math.hypot(dx, dz);
      if (d > T.bounceRadius) continue;
      const fall = 1 - d / T.bounceRadius;
      c.bounceV -= T.bounceDrop * omega * fall * (0.8 + Math.random() * 0.4);
    }
  }

  /**
   * Traffic reacts to the giant coming up behind (presentation only; the sim hitbox
   * never moves): brake lights and hazards, then a swerve inside the car's own
   * footprint and a honk. Returns the number of honks this frame (for audio).
   */
  private updateTraffic(dt: number, giantS: number, giantD: number) {
    const T = TUNING.traffic;
    const omega = T.bounceHz * Math.PI * 2;
    this.fxTime += dt;
    this.honkCd = Math.max(0, this.honkCd - dt);
    this.alarmT = Math.max(0, this.alarmT - dt);
    const blink = this.fxTime * 3 % 1 < 0.55;
    for (const c of this.cars.values()) {
      const p = c.prop;
      const ds = p.s - giantS;
      const dd = p.d - giantD;
      const inReach = ds > 0 && Math.abs(dd) < T.lateralReach;
      if (inReach && ds < (this.alarmT > 0 ? TUNING.gear.trafficAlarmBrakeAt : T.brakeAt) && !c.braking) {
        c.braking = true;
        for (const t of c.tails) {
          t.material = GLOW.brakeHalo;
          t.scale.set(1.9, 1.9, 1);
        }
      }
      if (inReach && ds < T.swerveAt && c.swerveT < 0) {
        c.swerveT = 0;
        c.swerveDir = Math.sign(dd) || (p.id & 1 ? 1 : -1);
        if (!c.honked && this.honkCd <= 0) {
          c.honked = true;
          this.honkCd = T.honkGap;
          this.onHonk?.(Math.max(0.25, 1 - ds / T.swerveAt), this.sim.track.posAt(p.s, p.d, { x: 0, z: 0 }));
        }
      }
      // Brushed: his shoulders and arms sweep over the next lane, so a car he passes close to takes the hit
      // visibly (a hard rock away from him, a jolt, a puff) though the lane's hitbox never moves.
      if (c.brushT < 0 && Math.abs(ds) < p.hl + T.brushAlong && Math.abs(dd) < p.hw + T.brushReach) {
        c.brushT = 0;
        c.brushDir = Math.sign(dd) || 1;
        c.bounceV += T.brushKick;
        this.sim.track.posAt(p.s, p.d - c.brushDir * p.hw, this.pos);
        this.spawnDebris(this.pos.x, this.pos.z, -Math.sin(this.sim.track.headingAt(p.s)) * c.brushDir, Math.cos(this.sim.track.headingAt(p.s)) * c.brushDir, 3, 6, [0xd9d2c4, 0x9fa4ad], [0.08, 0.2], 0.8);
        this.onBrush?.({ x: this.pos.x, z: this.pos.z });
      }
      // A lane-changer's blinker is set with its move (above); don't overwrite it while it signals or moves.
      const sh = p.shift;
      if (!sh || sh.state === 'wait' || sh.state === 'done') for (const hz of c.hazards) hz.visible = (c.braking || c.brushT >= 0) && blink;
      let off = 0;
      let yaw = 0;
      if (c.swerveT >= 0) {
        c.swerveT += dt;
        const k = Math.min(1, c.swerveT / 0.9);
        off = T.swerveOffset * c.swerveDir * (1 - (1 - k) ** 3);
        yaw = T.swerveYawDeg * (Math.PI / 180) * c.swerveDir * Math.sin(Math.PI * k) * Math.exp(-c.swerveT);
      }
      // Suspension: damped spring on the body's height, a little pitch with it.
      const acc = -omega * omega * c.bounceY - 2 * T.bounceDamping * omega * c.bounceV;
      c.bounceV += acc * dt;
      c.bounceY += c.bounceV * dt;
      // Brush: roll away from him (rotation.x is roll; the car's length runs along local X), then settle.
      let roll = 0;
      if (c.brushT >= 0) {
        c.brushT += dt;
        const k = c.brushT / T.brushTime;
        roll = k < 1 ? c.brushDir * T.brushRollDeg * (Math.PI / 180) * Math.sin(Math.PI * k) * Math.exp(-1.5 * k) : 0;
        off += c.brushDir * T.brushShove * Math.min(1, k * 3);
      }
      c.body.position.set(0, c.bounceY, off);
      c.body.rotation.set(c.bounceY * 0.25 + roll, -yaw, c.braking ? -0.02 : 0);
    }
  }

  // --- Effects ------------------------------------------------------------------

  /** A car took a brush from him (audio hook). */
  onBrush?: (at: { x: number; z: number }) => void;

  /** Gear-up: traffic further ahead notices and brakes early for a moment. */
  private alarmT = 0;
  alarm() {
    this.alarmT = TUNING.gear.trafficAlarm;
  }

  /** Debris spray from a smash, biased along `dir` (world). */
  spawnDebris(x: number, z: number, dirX: number, dirZ: number, speed: number, count: number, colors: number[], size: [number, number], height = 1) {
    for (let k = 0; k < count; k++) {
      const i = this.debrisCursor;
      this.debrisCursor = (this.debrisCursor + 1) % MAX_DEBRIS;
      const d = this.debris[i];
      const ang = Math.atan2(dirZ, dirX) + (Math.random() - 0.5) * 1.8;
      const sp = (0.45 + Math.random() * 0.8) * (speed + 4);
      d.active = true;
      d.x = x + (Math.random() - 0.5) * 1.2;
      d.z = z + (Math.random() - 0.5) * 1.2;
      d.y = 0.3 + Math.random() * height;
      d.vx = Math.cos(ang) * sp;
      d.vz = Math.sin(ang) * sp;
      d.vy = 5 + Math.random() * 9;
      d.rx = Math.random() * 6; d.ry = Math.random() * 6; d.rz = Math.random() * 6;
      d.wx = (Math.random() - 0.5) * 20; d.wy = (Math.random() - 0.5) * 20; d.wz = (Math.random() - 0.5) * 20;
      d.s = size[0] + Math.random() * (size[1] - size[0]);
      d.life = 1.6 + Math.random() * 1.2;
      this.debrisMesh.setColorAt(i, this.color.setHex(colors[Math.floor(Math.random() * colors.length)]));
    }
    if (this.debrisMesh.instanceColor) this.debrisMesh.instanceColor.needsUpdate = true;
  }

  /** A prop is smashed: its body is swatted off his line (a wreck), with debris sprayed to the side. */
  smash(propId: number, dirX: number, dirZ: number, speed: number, side = 1) {
    const p = this.sim.track.props.find((q) => q.id === propId);
    const g = this.propViews.get(propId);
    if (g) {
      this.propViews.delete(propId);
      this.cars.delete(propId);
    }
    if (!p) {
      if (g) this.group.remove(g);
      return;
    }
    this.sim.track.posAt(p.s, p.d, this.pos);
    const colors = [...((g?.userData.colors as number[]) ?? []), ...MATERIAL_DEBRIS[p.mat]];
    const heavy = p.cls === 'heavy';
    const W = this.sim.track.widthAt(p.s);
    if (g) this.launchWreck(g, dirX, dirZ, speed, heavy, side, p.h, (side > 0 ? W - p.d : p.d) - p.hw);
    const sx = -dirZ * side, sz = dirX * side;
    this.spawnDebris(this.pos.x, this.pos.z, dirX + sx * 1.4, dirZ + sz * 1.4, speed * 0.5, heavy ? 28 : 14, colors, heavy ? [0.3, 0.9] : [0.2, 0.6], p.h);
    if (heavy) this.spawnDebris(this.pos.x, this.pos.z, dirX - sx * 0.8, dirZ - sz * 0.8, speed * 0.35, 10, MATERIAL_DEBRIS.glass, [0.1, 0.25], p.h);
  }

  /**
   * Swat a body off the giant's line: it flies out to `side` (slower forward than he runs, so he
   * passes it), tumbles, bounces and slides to rest. Units hand their body over here too.
   */
  launchWreck(g: THREE.Object3D, dirX: number, dirZ: number, speed: number, heavy: boolean, side: number, height = 1.5, wall = Infinity) {
    const W = TUNING.impact.wreck;
    const L = heavy ? W.heavy : W.medium;
    if (g.parent !== this.group) this.group.add(g);
    const sx = -dirZ * side, sz = dirX * side;
    const fwd = speed * L.forward;
    const lat = L.lateral[0] + Math.random() * (L.lateral[1] - L.lateral[0]);
    g.scale.y *= W.crumple;
    this.wrecks.push({
      g,
      vx: dirX * fwd + sx * lat,
      vz: dirZ * fwd + sz * lat,
      vy: L.up[0] + Math.random() * (L.up[1] - L.up[0]),
      // Roll away from him about the travel axis, with some yaw.
      wx: dirX * L.spin * side + (Math.random() - 0.5) * 2,
      wz: dirZ * L.spin * side + (Math.random() - 0.5) * 2,
      wy: (Math.random() - 0.5) * L.spin,
      half: Math.max(0.3, height * 0.5 * W.crumple),
      t: 0,
      bounced: 0,
      // Road-edge wall, measured out along the fling: wrecks bounce off it, never through it.
      ox: g.position.x,
      oz: g.position.z,
      sx,
      sz,
      wall: Math.max(0, wall),
    });
    if (this.wrecks.length > W.max) {
      const old = this.wrecks.shift()!;
      this.group.remove(old.g);
    }
  }

  private updateWrecks(dt: number, focusX: number, focusZ: number) {
    const W = TUNING.impact.wreck;
    const q = new THREE.Quaternion();
    const axis = new THREE.Vector3();
    for (let i = this.wrecks.length - 1; i >= 0; i--) {
      const w = this.wrecks[i];
      w.t += dt;
      const g = w.g;
      const airborne = g.position.y > w.half + 0.01 || w.vy > 0;
      if (airborne) w.vy -= W.gravity * dt;
      g.position.x += w.vx * dt;
      g.position.y += w.vy * dt;
      g.position.z += w.vz * dt;
      const out = (g.position.x - w.ox) * w.sx + (g.position.z - w.oz) * w.sz;
      if (out > w.wall) {
        g.position.x -= w.sx * (out - w.wall);
        g.position.z -= w.sz * (out - w.wall);
        const vOut = w.vx * w.sx + w.vz * w.sz;
        if (vOut > 0) {
          w.vx -= w.sx * vOut * (1 + W.wallBounce);
          w.vz -= w.sz * vOut * (1 + W.wallBounce);
        }
      }
      if (g.position.y < w.half) {
        g.position.y = w.half;
        if (w.vy < -2 && w.bounced < 2) {
          w.vy = -w.vy * W.bounce;
          w.bounced++;
        } else w.vy = 0;
        const f = Math.max(0, 1 - W.friction * dt);
        w.vx *= f;
        w.vz *= f;
        w.wx *= f;
        w.wy *= f;
        w.wz *= f;
      }
      const spin = Math.hypot(w.wx, w.wy, w.wz);
      if (spin > 1e-3) {
        q.setFromAxisAngle(axis.set(w.wx / spin, w.wy / spin, w.wz / spin), spin * dt);
        g.quaternion.premultiply(q);
      }
      const far = Math.hypot(g.position.x - focusX, g.position.z - focusZ) > W.cullDistance;
      if (far || w.t > W.life) {
        this.group.remove(g);
        this.wrecks.splice(i, 1);
      }
    }
  }

  /** Expanding ground ring: footfall dust, Shoulder Check shockwave. */
  ring(x: number, z: number, scale: number, color: number, time = 0.45, opacity = 0.5) {
    // Pooled (review #47): a finished ring's mesh and material wait in `ringPool` for the next footfall.
    const mesh = this.ringPool.pop() ?? new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
    const m = mesh.material as THREE.MeshBasicMaterial;
    m.color.setHex(color);
    m.opacity = opacity;
    mesh.scale.set(1, 1, 1);
    mesh.position.set(x, 0.06, z);
    this.group.add(mesh);
    this.rings.push({ mesh, t: 0, max: time, scale, opacity });
  }

  /** v0.3 Rampage ground-crack decal under a plant. */
  crack(x: number, z: number, yaw: number) {
    const c = this.cracks[this.crackCursor];
    this.crackCursor = (this.crackCursor + 1) % this.cracks.length;
    c.t = 0;
    c.mesh.visible = true;
    c.mesh.position.set(x, 0.04, z);
    c.mesh.rotation.y = yaw + Math.random() * Math.PI;
    const s = 2.2 + Math.random() * 0.8;
    c.mesh.scale.set(s, 1, s);
  }

  /** Car Carrier: a dropped car falls off the deck (0.4s, a small bounce) once its view exists. */
  private drops = new Map<number, number>();
  dropIn(propId: number) {
    this.drops.set(propId, 0);
  }

  update(dt: number, focusX: number, focusZ: number, giantS = 0, giantD = 0) {
    this.ground.position.x = focusX;
    this.ground.position.z = focusZ;
    for (const [id, t0] of this.drops) {
      const g = this.propViews.get(id);
      if (!g) continue;
      const t = Math.min(1, t0 + dt / 0.4);
      // From the upper deck to the road, with a little bounce at the end.
      g.position.y = t < 0.8 ? 3.0 * (1 - (t / 0.8) ** 2) : 0.25 * Math.sin(((t - 0.8) / 0.2) * Math.PI);
      if (t >= 1) {
        g.position.y = 0;
        this.drops.delete(id);
      } else this.drops.set(id, t);
    }
    if (dt > 0) this.updateTraffic(dt, giantS, giantD);
    if (dt > 0) this.updateWrecks(dt, focusX, focusZ);
    for (let i = this.slides.length - 1; i >= 0; i--) {
      const m = this.slides[i];
      m.t = Math.min(1, m.t + dt / 0.5);
      const e = m.t * m.t * (3 - 2 * m.t);
      m.g.position.x = m.fx + (m.tx - m.fx) * e;
      m.g.position.z = m.fz + (m.tz - m.fz) * e;
      if (m.t >= 1) this.slides.splice(i, 1);
    }
    // Overpasses fade while the giant is near them so the chopper never loses him.
    for (const o of this.overpasses) {
      const near = Math.abs(o.s - giantS) < 16;
      o.mat.opacity += ((near ? 0.1 : 1) - o.mat.opacity) * Math.min(1, dt * 8);
      o.mat.depthWrite = o.mat.opacity > 0.95;
    }
    if (this.overpasses.length > 24) this.overpasses.splice(0, this.overpasses.length - 24);
    const B = TUNING.impact.wreck.beamClear;
    for (const b of this.tunnelBeams) b.mesh.visible = b.s < giantS - B[0] || b.s > giantS + B[1];
    while (this.tunnelBeams.length && this.tunnelBeams[0].s < giantS - 200) this.tunnelBeams.shift();
    const g = 30;
    for (let i = 0; i < MAX_DEBRIS; i++) {
      const d = this.debris[i];
      if (!d.active) continue;
      d.life -= dt;
      if (d.life <= 0) {
        d.active = false;
        this.tmp.scale.set(0, 0, 0);
        this.tmp.updateMatrix();
        this.debrisMesh.setMatrixAt(i, this.tmp.matrix);
        continue;
      }
      d.vy -= g * dt;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.z += d.vz * dt;
      if (d.y < d.s / 2) {
        d.y = d.s / 2;
        d.vy = Math.abs(d.vy) * 0.3;
        d.vx *= 0.55;
        d.vz *= 0.55;
        d.wx *= 0.5; d.wy *= 0.5; d.wz *= 0.5;
      }
      d.rx += d.wx * dt; d.ry += d.wy * dt; d.rz += d.wz * dt;
      const fade = Math.min(1, d.life / 0.4);
      this.tmp.position.set(d.x, d.y, d.z);
      this.tmp.rotation.set(d.rx, d.ry, d.rz);
      this.tmp.scale.setScalar(d.s * fade);
      this.tmp.updateMatrix();
      this.debrisMesh.setMatrixAt(i, this.tmp.matrix);
    }
    this.debrisMesh.instanceMatrix.needsUpdate = true;

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.t += dt;
      const k = r.t / r.max;
      if (k >= 1) {
        this.group.remove(r.mesh);
        this.ringPool.push(r.mesh);
        this.rings.splice(i, 1);
        continue;
      }
      const s = r.scale * (0.3 + 0.7 * Math.sqrt(k));
      r.mesh.scale.set(s, 1, s);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = r.opacity * (1 - k);
    }

    const life = TUNING.footfall.crackLife;
    for (const c of this.cracks) {
      if (!c.mesh.visible) continue;
      c.t += dt;
      if (c.t >= life) {
        c.mesh.visible = false;
        continue;
      }
      (c.mesh.material as THREE.MeshBasicMaterial).opacity = Math.min(1, (life - c.t) / 1.2) * 0.9;
    }
  }
}
