import * as THREE from 'three';
import { TUNING } from '../tuning';
import type { Sim } from '../sim/sim';
import type { Segment } from '../sim/track';
import type { Prop, PropKind } from '../sim/types';
import { Rng } from '../sim/rng';
import { KIND_COLORS, MATERIAL_DEBRIS, PALETTE } from './palette';
import { crackTexture, toon, toonRamp } from './toon';
import { GLOW, facade } from './glow';
import type { LampPos } from './lighting';

const LENS = new THREE.MeshBasicMaterial({ color: 0xffc27a });
const TAIL = new THREE.MeshBasicMaterial({ color: 0xd01818 });
const HEAD = new THREE.MeshBasicMaterial({ color: 0xfff2d8 });

let signTex: THREE.Texture | null = null;
/** "SIGN-OFF" exit sign face, drawn once. */
function signTexture(): THREE.Texture {
  if (signTex) return signTex;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 176;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1e6b3a';
  g.fillRect(0, 0, 256, 176);
  g.strokeStyle = '#f4f4ee';
  g.lineWidth = 6;
  g.strokeRect(8, 8, 240, 160);
  g.fillStyle = '#f4f4ee';
  g.textAlign = 'center';
  g.font = '800 30px system-ui, sans-serif';
  g.fillText('EXIT 6', 128, 52);
  g.font = '900 40px system-ui, sans-serif';
  g.fillText('SIGN-OFF', 128, 104);
  g.font = '800 44px system-ui, sans-serif';
  g.fillText('\u2198', 128, 156);
  signTex = new THREE.CanvasTexture(c);
  signTex.colorSpace = THREE.SRGBColorSpace;
  return signTex;
}

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
}

/**
 * Highway presentation: streams segment meshes (road, lane paint, walls, merge
 * signage, roadside scenery) and lane props as the sim generates them, plus
 * pooled debris, dust rings and Rampage crack decals. Reads sim state only.
 */

export type Part = [x: number, y: number, z: number, w: number, h: number, d: number, color: number | 'kind'];

/** Box parts per prop kind, in prop-local space: x along the road, z across it. */
export function partsFor(p: Prop): Part[] {
  const L = p.hl * 2;
  const W = p.hw * 2;
  switch (p.kind as PropKind) {
    case 'sawhorse':
      return [[0, 0.75, 0, L, 0.28, W, 'kind'], [0, 0.4, W * 0.4, L * 0.8, 0.8, 0.12, 0x8a6240], [0, 0.4, -W * 0.4, L * 0.8, 0.8, 0.12, 0x8a6240]];
    case 'cart':
      return [[0, 0.55, 0, L, 0.7, W, 0xa67c52], [0, 1.05, 0, L * 0.9, 0.35, W * 0.85, 'kind'], [0, 2.0, 0, L * 1.1, 0.08, W * 1.4, 'kind'], [0, 1.4, 0, 0.08, 1.2, 0.08, 0x8a6240]];
    case 'fence':
      return [[0, 0.75, 0, 0.08, 1.3, W, 'kind'], [0, 0.06, W * 0.45, 0.6, 0.12, 0.3, 0x6d737a], [0, 0.06, -W * 0.45, 0.6, 0.12, 0.3, 0x6d737a]];
    case 'scooter':
      return [[0, 0.45, 0, L, 0.5, W, 'kind'], [-L * 0.15, 0.8, 0, L * 0.4, 0.15, W * 0.9, 0x333333], [L * 0.4, 0.95, 0, 0.1, 0.5, W * 1.6, 0x8c939b]];
    case 'car':
      return [[0, 0.68, 0, L, 0.85, W, 'kind'], [-L * 0.05, 1.38, 0, L * 0.55, 0.55, W * 0.88, 0xa9cfe0], [-L * 0.05, 1.68, 0, L * 0.5, 0.07, W * 0.9, 'kind']];
    case 'van':
      return [[0, 1.25, 0, L, 1.9, W, 'kind'], [L * 0.42, 1.55, 0, L * 0.18, 0.6, W * 0.9, 0xa9cfe0], [0, 1.0, 0, L * 1.01, 0.2, W * 1.01, 0xd94f4f]];
    case 'barricade':
      return [[0, 0.38, 0, L, 0.75, W, 'kind'], [0, 0.86, 0, L * 0.8, 0.2, W, 0xf08a24]];
    case 'cruiser':
    case 'compact':
      // Black-and-white police car (white doors and roof read from the chopper).
      return [[0, 0.62, 0, L, 0.72, W, 'kind'], [0.1, 0.66, 0, L * 0.42, 0.5, W * 1.01, 0xf1f1ee], [-0.25, 1.28, 0, L * 0.5, 0.55, W * 0.86, 0x1d2633], [-0.25, 1.58, 0, L * 0.48, 0.06, W * 0.88, 0xf1f1ee]];
  }
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
  private propViews = new Map<number, THREE.Group>();
  private ground: THREE.Mesh;
  private debris: Debris[] = [];
  private debrisMesh: THREE.InstancedMesh;
  private debrisCursor = 0;
  private rings: { mesh: THREE.Mesh; t: number; max: number; scale: number; opacity: number }[] = [];
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
  private lampList: LampPos[] = [];
  private overpasses: { s: number; mat: THREE.MeshToonMaterial }[] = [];
  private lampsDirty = true;
  private fxTime = 0;
  private honkCd = 0;
  /** Called when a car honks (volume 0..1). */
  onHonk: ((vol: number) => void) | null = null;

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
    for (const seg of ready) {
      if (!this.segViews.has(seg.index)) {
        const g = this.buildSegment(seg);
        this.segViews.set(seg.index, g);
        this.group.add(g);
        this.lampsDirty = true;
      }
    }
    for (const [i, g] of this.segViews) {
      if (!live.has(i)) {
        this.group.remove(g);
        g.traverse((o) => (o as THREE.Mesh).geometry !== this.box && (o as THREE.Mesh).geometry?.dispose());
        this.segViews.delete(i);
        this.lampsDirty = true;
      }
    }
    const liveProps = new Set<number>();
    const lastReady = ready.length ? ready[ready.length - 1].index : -1;
    for (const p of track.props) {
      if (!p.alive || p.segment > lastReady) continue;
      liveProps.add(p.id);
      if (!this.propViews.has(p.id)) {
        const g = this.buildProp(p);
        this.propViews.set(p.id, g);
        this.group.add(g);
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

  /** Sweep cross-sections along the segment's samples into one geometry. */
  private sweep(seg: Segment, section: (i: number, s: number, w: number) => [number, number][], from = 0, to = seg.length): THREE.BufferGeometry {
    const verts: number[] = [];
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
      for (const [d, y] of sec) verts.push(seg.xs[i] + rx * d, y, seg.zs[i] + rz * d);
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
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  private buildSegment(seg: Segment): THREE.Group {
    const group = new THREE.Group();
    const W = TUNING.lanes.width;
    const wallH = TUNING.track.wallHeight;
    const add = (geo: THREE.BufferGeometry, color: number, basic = false, paint = false) => {
      const m = new THREE.Mesh(geo, basic ? new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }) : toon(color, paint ? { side: THREE.DoubleSide, emissive: PAINT_GLOW } : { side: THREE.DoubleSide }));
      group.add(m);
      return m;
    };
    // Ground either side, by zone (Phase 2 road variety).
    const zone = seg.zone;
    if (zone === 'highway') {
      add(this.sweep(seg, () => [[-8, 0], [-0.9, 0.01]]), PALETTE.verge);
      add(this.sweep(seg, (_i, _s, w) => [[w + 0.9, 0.01], [w + 8, 0]]), PALETTE.verge);
    } else if (zone === 'avenue') {
      // Sidewalks with a curb face.
      add(this.sweep(seg, () => [[-6, 0.16], [-0.9, 0.16], [-0.9, 0]]), PALETTE.sidewalk);
      add(this.sweep(seg, (_i, _s, w) => [[w + 0.9, 0], [w + 0.9, 0.16], [w + 6, 0.16]]), PALETTE.sidewalk);
    } else if (zone === 'bridge') {
      // Open water under a deck slab.
      add(this.sweep(seg, (_i, _s, w) => [[-160, -0.03], [w + 160, -0.03]]), PALETTE.water);
      add(this.sweep(seg, (_i, _s, w) => [[-1.4, 0.02], [-1.4, -1.6], [w + 1.4, -1.6], [w + 1.4, 0.02]]), PALETTE.deck);
    } else {
      add(this.sweep(seg, (_i, _s, w) => [[-1.6, 0.01], [w + 1.6, 0.01]]), PALETTE.deck);
    }
    add(this.sweep(seg, (_i, _s, w) => [[-0.9, 0.02], [w + 0.9, 0.02]]), PALETTE.road);
    add(this.sweep(seg, () => [[0.15, 0.035], [0.35, 0.035]]), PALETTE.edgeLineLeft, false, true);
    add(this.sweep(seg, (_i, _s, w) => [[w - 0.35, 0.035], [w - 0.15, 0.035]]), PALETTE.edgeLineRight, false, true);
    // Edge barriers (the sim's walls): concrete on the highway, a curb on the avenue,
    // a parapet on the bridge, the tunnel's own tiled walls.
    const [eh, ec] = zone === 'avenue' ? [0.3, PALETTE.curb] : zone === 'bridge' ? [0.9, PALETTE.deck] : zone === 'tunnel' ? [5.5, PALETTE.tunnelWall] : [wallH, PALETTE.wall];
    add(this.sweep(seg, () => [[-0.4, 0], [-0.4, eh], [-0.9, eh], [-0.9, 0]]), ec);
    const exitSeg = this.exitFor(seg);
    if (exitSeg) this.buildRamp(seg, exitSeg, group);
    else add(this.sweep(seg, (_i, _s, w) => [[w + 0.4, 0], [w + 0.4, eh], [w + 0.9, eh], [w + 0.9, 0]]), ec);
    if (this.sim.track.segments.some((x) => x.exit && x.index === seg.index + 1)) this.signGantry(seg, seg.s0 + 6, group);

    // Dashed lane lines (3m dash, 6m gap), only where both lanes exist.
    const dashGeo = new THREE.PlaneGeometry(1, 1);
    dashGeo.rotateX(-Math.PI / 2);
    const dashes: [number, number, number][] = [];
    for (let i = 0; i < seg.length; i++) {
      const s = seg.s0 + i + 0.5;
      if (((s % 9) + 9) % 9 >= 3) continue;
      const w = this.sim.track.widthAt(s);
      for (let b = 1; b < TUNING.lanes.max; b++) {
        if (b * W > w - 1.5) break;
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
      const w = this.sim.track.widthAt(sAt);
      this.sim.track.posAt(sAt, w + 2.5, this.pos);
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
    const w = this.sim.track.widthAt(s);
    const h = this.sim.track.headingAt(s);
    group.userData.lamps = zone === 'tunnel' ? this.buildTunnel(seg, group) : this.buildLamps(seg, group);
    if (zone === 'avenue') this.buildStorefronts(seg, group, rng);
    if (zone === 'bridge') this.buildBridge(seg, group);
    if (seg.overpass) this.buildOverpass(seg, group);
    if (zone === 'highway') {
    for (let t = 0; t < 7; t++) {
      const left = rng.chance(0.5);
      const off = rng.range(12, 40);
      const ss = seg.s0 + rng.range(0, seg.length);
      this.sim.track.posAt(ss, left ? -off : this.sim.track.widthAt(ss) + off, this.pos);
      const scale = rng.range(0.8, 1.5);
      const crown = new THREE.Mesh(new THREE.ConeGeometry(2.2 * scale, 5 * scale, 6), toon(rng.pick(PALETTE.tree)));
      crown.position.set(this.pos.x, 3.5 * scale, this.pos.z);
      const trunk = new THREE.Mesh(this.box, toon(PALETTE.trunk));
      trunk.scale.set(0.4, 1.5 * scale, 0.4);
      trunk.position.set(this.pos.x, 0.75 * scale, this.pos.z);
      group.add(crown, trunk);
    }
    if (rng.chance(0.35)) {
      const left = rng.chance(0.5);
      const ss = seg.s0 + 20;
      this.sim.track.posAt(ss, left ? -rng.range(45, 70) : this.sim.track.widthAt(ss) + rng.range(45, 70), this.pos);
      const b = new THREE.Mesh(this.box, toon(rng.pick(PALETTE.buildings)));
      const bh = rng.range(6, 16);
      b.scale.set(rng.range(14, 26), bh, rng.range(14, 26));
      b.position.set(this.pos.x, bh / 2, this.pos.z);
      b.rotation.y = -h;
      group.add(b);
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
    return group;
  }

  /** Phase 2 avenue: storefronts shoulder to shoulder, lit windows at night, awnings at street level. */
  private buildStorefronts(seg: Segment, group: THREE.Group, rng: Rng) {
    const track = this.sim.track;
    for (const left of [true, false]) {
      let a = 0;
      while (a < seg.length) {
        const wid = rng.range(9, 15);
        const sMid = seg.s0 + a + wid / 2;
        if (sMid > seg.s0 + seg.length) break;
        const w = track.widthAt(sMid);
        const depth = rng.range(10, 16);
        const ht = rng.range(8, 20);
        const d = left ? -6 - depth / 2 : w + 6 + depth / 2;
        track.posAt(sMid, d, this.pos);
        const b = new THREE.Mesh(this.box, facade(rng.pick(PALETTE.storefronts), toonRamp()));
        b.scale.set(wid - 0.6, ht, depth);
        b.position.set(this.pos.x, ht / 2, this.pos.z);
        b.rotation.y = -track.headingAt(sMid);
        const aw = new THREE.Mesh(this.box, toon(rng.pick(PALETTE.awnings)));
        track.posAt(sMid, left ? -6.6 : w + 6.6, this.pos);
        aw.scale.set(wid - 1.5, 0.25, 1.6);
        aw.position.set(this.pos.x, 3.2, this.pos.z);
        aw.rotation.y = b.rotation.y;
        group.add(b, aw);
        a += wid;
      }
    }
  }

  /** Phase 2 bridge: suspension towers at the start of the span and cables running along it. */
  private buildBridge(seg: Segment, group: THREE.Group) {
    const track = this.sim.track;
    const H = 38;
    const tower = (s: number) => {
      const w = track.widthAt(s);
      for (const d of [-2.4, w + 2.4]) {
        const p = track.posAt(s, d, { x: 0, z: 0 });
        const m = new THREE.Mesh(this.box, toon(0x8a6f62));
        m.scale.set(2, H, 2);
        m.position.set(p.x, H / 2 - 1.6, p.z);
        group.add(m);
      }
      const mid = track.posAt(s, w / 2, { x: 0, z: 0 });
      const beam = new THREE.Mesh(this.box, toon(0x8a6f62));
      beam.scale.set(1.6, 1.6, w + 6.8);
      beam.position.set(mid.x, H - 3, mid.z);
      beam.rotation.y = -track.headingAt(s);
      group.add(beam);
    };
    if (seg.zoneStart) tower(seg.s0 + 6);
    // Main cables sagging along the span, one per side.
    for (const side of [0, 1]) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= seg.length; i += 4) {
        const s = seg.s0 + i;
        const w = track.widthAt(s);
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
      const w = track.widthAt(s);
      const h = track.headingAt(s);
      const mid = track.posAt(s, w / 2, { x: 0, z: 0 });
      const beam = new THREE.Mesh(this.box, toon(PALETTE.tunnelWall));
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
      const w = track.widthAt(s);
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

  /** Phase 2 overpass: a road bridge crossing overhead. Its deck fades when the giant passes under (never hides him). */
  private buildOverpass(seg: Segment, group: THREE.Group) {
    const track = this.sim.track;
    const s = seg.s0 + 20;
    const w = track.widthAt(s);
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
    const pool = new THREE.PlaneGeometry(1, 1);
    pool.rotateX(-Math.PI / 2);
    for (let s = Math.ceil(seg.s0 / sp) * sp; s < seg.s0 + seg.length; s += sp) {
      const w = track.widthAt(s);
      const h = track.headingAt(s);
      const left = Math.round(s / sp) % 2 === 0;
      if (!left && this.exitFor(seg)) continue; // the ramp peels off on the right
      const baseD = left ? -1.6 : w + 1.6;
      const headD = left ? 2.0 : w - 2.0;
      const H = 9;
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
      group.add(pole, arm, housing, lens, halo, p);
      lamps.push({ x: head.x, y: H, z: head.z });
    }
    return lamps;
  }

  /** The sign-off exit segment this segment's ramp belongs to (the exit segment itself or the one after it). */
  private exitFor(seg: Segment): Segment | null {
    return this.sim.track.segments.find((x) => x.exit && (x.index === seg.index || x.index === seg.index - 1)) ?? null;
  }

  /** Rebuild segment views (the exit opens on segments already built ahead). */
  rebuild(indices: number[]) {
    for (const i of indices) {
      const g = this.segViews.get(i);
      if (!g) continue;
      this.group.remove(g);
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
      const dash = new THREE.PlaneGeometry(1, 1);
      dash.rotateX(-Math.PI / 2);
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
      this.signGantry(seg, seg.s0 + 4, group);
    }
  }

  /** Green overhead sign over the rightmost lane: "SIGN-OFF / EXIT 6". */
  private signGantry(seg: Segment, s: number, group: THREE.Group) {
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
    const green = new THREE.MeshToonMaterial({ color: 0x1e6b3a, gradientMap: toonRamp(), transparent: true });
    const face = new THREE.MeshBasicMaterial({ map: signTexture(), transparent: true });
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

  private buildProp(p: Prop): THREE.Group {
    const g = new THREE.Group();
    // Parts sit on a body group so cars can swerve and bounce without moving the prop's root.
    const body = new THREE.Group();
    g.add(body);
    const colors = KIND_COLORS[p.kind];
    const kc = colors[p.variant % colors.length];
    for (const [x, y, z, w, h, d, c] of partsFor(p)) {
      const m = new THREE.Mesh(this.box, toon(c === 'kind' ? kc : c));
      m.position.set(x, y, z);
      m.scale.set(w, h, d);
      body.add(m);
    }
    this.sim.track.posAt(p.s, p.d, this.pos);
    g.position.set(this.pos.x, 0, this.pos.z);
    g.rotation.y = -this.sim.track.headingAt(p.s);
    g.userData.colors = [kc, ...partsFor(p).map((q) => (q[6] === 'kind' ? kc : q[6]))];
    if (p.kind === 'car' || p.kind === 'van') this.addCarLights(p, g, body);
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
    const throwGeo = new THREE.PlaneGeometry(1, 1);
    throwGeo.rotateX(-Math.PI / 2);
    const beam = new THREE.Mesh(throwGeo, GLOW.headPool);
    beam.position.set(L / 2 + 6.5, 0.055, 0);
    beam.scale.set(13, 1, 6.5);
    beam.renderOrder = 1;
    g.add(beam);
    this.cars.set(p.id, { prop: p, group: g, body, tails, hazards, braking: false, swerveT: -1, swerveDir: 1, honked: false, bounceY: 0, bounceV: 0 });
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
    const blink = this.fxTime * 3 % 1 < 0.55;
    for (const c of this.cars.values()) {
      const p = c.prop;
      const ds = p.s - giantS;
      const dd = p.d - giantD;
      const inReach = ds > 0 && Math.abs(dd) < T.lateralReach;
      if (inReach && ds < T.brakeAt && !c.braking) {
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
          this.onHonk?.(Math.max(0.25, 1 - ds / T.swerveAt));
        }
      }
      for (const hz of c.hazards) hz.visible = c.braking && blink;
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
      c.body.position.set(0, c.bounceY, off);
      c.body.rotation.set(c.bounceY * 0.25, -yaw, c.braking ? -0.02 : 0);
    }
  }

  // --- Effects ------------------------------------------------------------------

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

  /** A prop is smashed: hide its view, spray debris in the direction of the hit. */
  smash(propId: number, dirX: number, dirZ: number, speed: number) {
    const p = this.sim.track.props.find((q) => q.id === propId);
    const g = this.propViews.get(propId);
    if (g) {
      this.group.remove(g);
      this.propViews.delete(propId);
      this.cars.delete(propId);
    }
    if (!p) return;
    this.sim.track.posAt(p.s, p.d, this.pos);
    const colors = [...((g?.userData.colors as number[]) ?? []), ...MATERIAL_DEBRIS[p.mat]];
    const heavy = p.cls === 'heavy';
    this.spawnDebris(this.pos.x, this.pos.z, dirX, dirZ, speed, heavy ? 32 : 16, colors, heavy ? [0.3, 0.9] : [0.2, 0.6], p.h);
    if (heavy) this.spawnDebris(this.pos.x, this.pos.z, dirX, dirZ, speed * 0.5, 10, MATERIAL_DEBRIS.glass, [0.1, 0.25], p.h);
  }

  /** Expanding ground ring: footfall dust, Shoulder Check shockwave. */
  ring(x: number, z: number, scale: number, color: number, time = 0.45, opacity = 0.5) {
    const mesh = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
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

  update(dt: number, focusX: number, focusZ: number, giantS = 0, giantD = 0) {
    this.ground.position.x = focusX;
    this.ground.position.z = focusZ;
    if (dt > 0) this.updateTraffic(dt, giantS, giantD);
    // Overpasses fade while the giant is near them so the chopper never loses him.
    for (const o of this.overpasses) {
      const near = Math.abs(o.s - giantS) < 16;
      o.mat.opacity += ((near ? 0.1 : 1) - o.mat.opacity) * Math.min(1, dt * 8);
      o.mat.depthWrite = o.mat.opacity > 0.95;
    }
    if (this.overpasses.length > 24) this.overpasses.splice(0, this.overpasses.length - 24);
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
        (r.mesh.material as THREE.Material).dispose();
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
