import * as THREE from 'three';
import { TUNING } from '../tuning';
import type { Sim } from '../sim/sim';
import type { Segment } from '../sim/track';
import type { Prop, PropKind } from '../sim/types';
import { Rng } from '../sim/rng';
import { KIND_COLORS, MATERIAL_DEBRIS, PALETTE } from './palette';
import { crackTexture, toon } from './toon';

/**
 * Highway presentation: streams segment meshes (road, lane paint, walls, merge
 * signage, roadside scenery) and lane props as the sim generates them, plus
 * pooled debris, dust rings and Rampage crack decals. Reads sim state only.
 */

type Part = [x: number, y: number, z: number, w: number, h: number, d: number, color: number | 'kind'];

/** Box parts per prop kind, in prop-local space: x along the road, z across it. */
function partsFor(p: Prop): Part[] {
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
      }
    }
    for (const [i, g] of this.segViews) {
      if (!live.has(i)) {
        this.group.remove(g);
        g.traverse((o) => (o as THREE.Mesh).geometry !== this.box && (o as THREE.Mesh).geometry?.dispose());
        this.segViews.delete(i);
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
    const add = (geo: THREE.BufferGeometry, color: number, basic = false) => {
      const m = new THREE.Mesh(geo, basic ? new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }) : toon(color, { side: THREE.DoubleSide }));
      group.add(m);
      return m;
    };
    // Verges, road, edge lines.
    add(this.sweep(seg, () => [[-8, 0], [-0.9, 0.01]]), PALETTE.verge);
    add(this.sweep(seg, (_i, _s, w) => [[w + 0.9, 0.01], [w + 8, 0]]), PALETTE.verge);
    add(this.sweep(seg, (_i, _s, w) => [[-0.9, 0.02], [w + 0.9, 0.02]]), PALETTE.road);
    add(this.sweep(seg, () => [[0.15, 0.035], [0.35, 0.035]]), PALETTE.edgeLineLeft, true);
    add(this.sweep(seg, (_i, _s, w) => [[w - 0.35, 0.035], [w - 0.15, 0.035]]), PALETTE.edgeLineRight, true);
    // Concrete walls (barriers) on both edges.
    add(this.sweep(seg, () => [[-0.4, 0], [-0.4, wallH], [-0.9, wallH], [-0.9, 0]]), PALETTE.wall);
    add(this.sweep(seg, (_i, _s, w) => [[w + 0.4, 0], [w + 0.4, wallH], [w + 0.9, wallH], [w + 0.9, 0]]), PALETTE.wall);

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
      const m = new THREE.InstancedMesh(dashGeo, new THREE.MeshBasicMaterial({ color: PALETTE.roadLine }), dashes.length);
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
      const board = new THREE.Mesh(this.box, toon(PALETTE.signWarn));
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
          const chev = new THREE.Mesh(dashGeo, new THREE.MeshBasicMaterial({ color: PALETTE.roadLine }));
          chev.position.set(this.pos.x, 0.036, this.pos.z);
          chev.rotation.y = -this.sim.track.headingAt(s) - 0.6;
          chev.scale.set(2.2, 1, 0.3);
          group.add(chev);
        }
      }
    }

    // Roadside scenery (cosmetic, seeded per segment): light poles, trees, the odd building, gantries.
    const rng = new Rng((seg.index * 2654435761) >>> 0);
    const s = seg.s0 + 20;
    const w = this.sim.track.widthAt(s);
    const h = this.sim.track.headingAt(s);
    const side = seg.index & 1 ? -1 : 1;
    this.sim.track.posAt(s, side > 0 ? w + 1.6 : -1.6, this.pos);
    const pole = new THREE.Mesh(this.box, toon(PALETTE.pole));
    pole.scale.set(0.2, 9, 0.2);
    pole.position.set(this.pos.x, 4.5, this.pos.z);
    group.add(pole);
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
    void side;
    return group;
  }

  private buildProp(p: Prop): THREE.Group {
    const g = new THREE.Group();
    const colors = KIND_COLORS[p.kind];
    const kc = colors[p.variant % colors.length];
    for (const [x, y, z, w, h, d, c] of partsFor(p)) {
      const m = new THREE.Mesh(this.box, toon(c === 'kind' ? kc : c));
      m.position.set(x, y, z);
      m.scale.set(w, h, d);
      g.add(m);
    }
    this.sim.track.posAt(p.s, p.d, this.pos);
    g.position.set(this.pos.x, 0, this.pos.z);
    g.rotation.y = -this.sim.track.headingAt(p.s);
    g.userData.colors = [kc, ...partsFor(p).map((q) => (q[6] === 'kind' ? kc : q[6]))];
    return g;
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

  update(dt: number, focusX: number, focusZ: number) {
    this.ground.position.x = focusX;
    this.ground.position.z = focusZ;
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
