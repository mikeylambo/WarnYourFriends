import * as THREE from 'three';
import { TUNING } from '../tuning';
import { PROP_DEFS } from '../sim/layout';
import type { Sim } from '../sim/sim';
import type { Prop, PropKind } from '../sim/types';
import { KIND_COLORS, MATERIAL_DEBRIS, PALETTE } from './palette';

/** §23 rendering recipe: flat toon shading on a 2-band ramp. */
let ramp: THREE.DataTexture | null = null;
export function toonRamp(): THREE.DataTexture {
  if (ramp) return ramp;
  const data = new Uint8Array([150, 150, 150, 255, 255, 255, 255, 255]);
  ramp = new THREE.DataTexture(data, 2, 1, THREE.RGBAFormat);
  ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
  ramp.needsUpdate = true;
  return ramp;
}

export function toon(color: number, extra: THREE.MeshToonMaterialParameters = {}): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ color, gradientMap: toonRamp(), ...extra });
}

/** Soft round shadow blob texture (§23 "soft shadow blobs"). */
let blobTex: THREE.Texture | null = null;
export function blobTexture(): THREE.Texture {
  if (blobTex) return blobTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(0,0,0,0.55)');
  grad.addColorStop(0.6, 'rgba(0,0,0,0.3)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  blobTex = new THREE.CanvasTexture(c);
  return blobTex;
}

/** A box part of a prop, in the prop's default orientation (long axis = X). */
interface Part {
  /** Size as fractions of the prop's full footprint (x, z) and absolute height. */
  sx: number;
  sz: number;
  h: number;
  y: number;
  /** Colour: 'kind' uses the kind palette by variant; a number is fixed. */
  color: 'kind' | number;
}

const PARTS: Record<Exclude<PropKind, 'building' | 'wall'>, Part[]> = {
  bin: [{ sx: 1, sz: 1, h: 0.9, y: 0, color: 'kind' }, { sx: 1.05, sz: 1.05, h: 0.12, y: 0.9, color: 0x4b5a50 }],
  mailbox: [{ sx: 1, sz: 1, h: 1.25, y: 0, color: 'kind' }],
  newsbox: [{ sx: 1, sz: 1, h: 1.1, y: 0, color: 'kind' }, { sx: 0.8, sz: 1.02, h: 0.35, y: 0.55, color: 0xf4f0e6 }],
  cart: [{ sx: 1, sz: 1, h: 0.7, y: 0.25, color: 0xa67c52 }, { sx: 0.9, sz: 0.85, h: 0.3, y: 0.95, color: 'kind' }],
  planter: [{ sx: 1, sz: 1, h: 0.5, y: 0, color: 'kind' }, { sx: 0.8, sz: 0.8, h: 0.55, y: 0.5, color: 0x6fae55 }],
  stall: [{ sx: 0.95, sz: 0.85, h: 1.0, y: 0, color: 0xa67c52 }, { sx: 1, sz: 1, h: 0.18, y: 2.2, color: 'kind' }, { sx: 0.06, sz: 0.06, h: 2.2, y: 0, color: 0x8a6240 }],
  fence: [{ sx: 1, sz: 1, h: 1.2, y: 0, color: 'kind' }],
  bench: [{ sx: 1, sz: 0.7, h: 0.45, y: 0.15, color: 'kind' }, { sx: 1, sz: 0.2, h: 0.5, y: 0.45, color: 'kind' }],
  bikerack: [{ sx: 1, sz: 0.4, h: 0.9, y: 0, color: 'kind' }, { sx: 0.25, sz: 1.6, h: 0.8, y: 0.05, color: 0x3d8fd1 }],
  car: [{ sx: 1, sz: 1, h: 0.85, y: 0.25, color: 'kind' }, { sx: 0.55, sz: 0.88, h: 0.55, y: 1.05, color: 0xa9cfe0 }, { sx: 0.5, sz: 0.9, h: 0.06, y: 1.6, color: 'kind' }],
  van: [{ sx: 1, sz: 1, h: 1.9, y: 0.3, color: 'kind' }, { sx: 0.2, sz: 0.9, h: 0.6, y: 1.3, color: 0xa9cfe0 }, { sx: 1.01, sz: 1.01, h: 0.2, y: 1.0, color: 0xd94f4f }],
  barricade: [{ sx: 1, sz: 1, h: 0.75, y: 0, color: 'kind' }, { sx: 1, sz: 0.8, h: 0.2, y: 0.75, color: 0xf08a24 }],
  pillar: [{ sx: 1, sz: 1, h: 4.5, y: 0, color: 'kind' }],
};

interface PartMesh {
  mesh: THREE.InstancedMesh;
  part: Part;
  /** Prop ids in instance order. */
  ids: number[];
}

interface Debris {
  active: boolean;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  rx: number; ry: number; rz: number;
  wx: number; wy: number; wz: number;
  s: number;
  life: number;
  max: number;
}

const MAX_DEBRIS = 400; // §36 max 400 dynamic debris objects, pooled.

export class WorldView {
  readonly group = new THREE.Group();
  private partMeshes: PartMesh[] = [];
  private propInstances = new Map<number, { pm: PartMesh; index: number }[]>();
  private pedBody!: THREE.InstancedMesh;
  private pedHead!: THREE.InstancedMesh;
  private pedShadow!: THREE.InstancedMesh;
  private debris: Debris[] = [];
  private debrisMesh!: THREE.InstancedMesh;
  private debrisCursor = 0;
  private rings: { mesh: THREE.Mesh; t: number; max: number; scale: number }[] = [];
  private tmp = new THREE.Object3D();
  private color = new THREE.Color();
  private rng = Math.random; // cosmetics only (§29 rule 2)

  constructor(private sim: Sim) {
    this.buildGround();
    this.buildBuildings();
    this.buildProps();
    this.buildPeds();
    this.buildDebris();
  }

  private buildGround() {
    const L = this.sim.layout;
    const B = TUNING.block;
    const size = L.half * 2 + 60;
    const road = new THREE.Mesh(new THREE.PlaneGeometry(size, size), toon(PALETTE.road));
    road.rotation.x = -Math.PI / 2;
    this.group.add(road);

    const padSize = B.buildingSize + B.sidewalk * 2;
    const padGeo = new THREE.BoxGeometry(padSize, 0.15, padSize);
    const fill = { building: PALETTE.sidewalk, plaza: PALETTE.plaza, lot: PALETTE.lot } as const;
    for (const type of ['building', 'plaza', 'lot'] as const) {
      const cells = L.cells.filter((c) => c.type === type);
      const m = new THREE.InstancedMesh(padGeo, toon(fill[type]), cells.length);
      cells.forEach((c, i) => {
        this.tmp.position.set(c.cx, 0.075, c.cz);
        this.tmp.rotation.set(0, 0, 0);
        this.tmp.scale.set(1, 1, 1);
        this.tmp.updateMatrix();
        m.setMatrixAt(i, this.tmp.matrix);
      });
      this.group.add(m);
    }

    // Dashed centre lines on every street.
    const n = B.cellsPerSide;
    const dashes: [number, number, boolean][] = [];
    for (let k = 1; k < n; k++) {
      const line = -L.half + B.cell * k;
      for (let t = -L.half + 2; t < L.half - 2; t += 6) {
        dashes.push([line, t, true]);
        dashes.push([t, line, false]);
      }
    }
    const dashGeo = new THREE.PlaneGeometry(0.25, 2.6);
    dashGeo.rotateX(-Math.PI / 2);
    const dm = new THREE.InstancedMesh(dashGeo, new THREE.MeshBasicMaterial({ color: PALETTE.roadLine }), dashes.length);
    dashes.forEach(([x, z, vertical], i) => {
      this.tmp.position.set(x, 0.02, z);
      this.tmp.rotation.set(0, vertical ? 0 : Math.PI / 2, 0);
      this.tmp.updateMatrix();
      dm.setMatrixAt(i, this.tmp.matrix);
    });
    this.group.add(dm);
  }

  private buildBuildings() {
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    const mats = PALETTE.buildings.map((c) => toon(c));
    const trim = toon(PALETTE.roofTrim);
    const unit = toon(PALETTE.roofUnit);
    const wallMat = toon(PALETTE.wall);
    for (const p of this.sim.props) {
      if (p.kind !== 'building' && p.kind !== 'wall') continue;
      const mesh = new THREE.Mesh(box, p.kind === 'wall' ? wallMat : mats[p.variant % mats.length]);
      mesh.position.set(p.x, 0, p.z);
      mesh.scale.set(p.hw * 2, p.h, p.hd * 2);
      this.group.add(mesh);
      if (p.kind === 'building') {
        // Roof parapet and a couple of AC units: toy-like scale cues from the chopper.
        const par = new THREE.Mesh(box, trim);
        par.position.set(p.x, p.h, p.z);
        par.scale.set(p.hw * 2 + 0.3, 0.35, p.hd * 2 + 0.3);
        this.group.add(par);
        const units = 1 + (p.id % 3);
        for (let u = 0; u < units; u++) {
          const a = new THREE.Mesh(box, unit);
          const ox = ((p.id * 7 + u * 13) % 10) / 10 - 0.5;
          const oz = ((p.id * 3 + u * 17) % 10) / 10 - 0.5;
          a.position.set(p.x + ox * p.hw, p.h + 0.35, p.z + oz * p.hd);
          a.scale.set(2.2, 1.2, 1.6);
          this.group.add(a);
        }
      }
    }
  }

  private propRotation(p: Prop): number {
    const d = PROP_DEFS[p.kind];
    const defaultLongX = d.hw >= d.hd;
    const nowLongX = p.hw >= p.hd;
    return defaultLongX === nowLongX ? 0 : Math.PI / 2;
  }

  private buildProps() {
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    const byKind = new Map<PropKind, Prop[]>();
    for (const p of this.sim.props) {
      if (p.kind === 'building' || p.kind === 'wall') continue;
      let arr = byKind.get(p.kind);
      if (!arr) byKind.set(p.kind, (arr = []));
      arr.push(p);
    }
    for (const [kind, props] of byKind) {
      const parts = PARTS[kind as keyof typeof PARTS];
      for (const part of parts) {
        const mesh = new THREE.InstancedMesh(box, toon(0xffffff), props.length);
        const pm: PartMesh = { mesh, part, ids: props.map((p) => p.id) };
        props.forEach((p, i) => {
          const c = part.color === 'kind' ? (KIND_COLORS[kind] ?? [0x999999])[p.variant % (KIND_COLORS[kind]?.length ?? 1)] : part.color;
          mesh.setColorAt(i, this.color.setHex(c));
          let list = this.propInstances.get(p.id);
          if (!list) this.propInstances.set(p.id, (list = []));
          list.push({ pm, index: i });
        });
        this.partMeshes.push(pm);
        this.group.add(mesh);
      }
    }
    for (const p of this.sim.props) this.writeProp(p);
  }

  /** Update one prop's instances (visible when alive). */
  writeProp(p: Prop) {
    const list = this.propInstances.get(p.id);
    if (!list) return;
    const d = PROP_DEFS[p.kind];
    const rot = this.propRotation(p);
    for (const { pm, index } of list) {
      const part = pm.part;
      if (!p.alive) {
        this.tmp.scale.set(0, 0, 0);
      } else {
        // Parts are authored against the default footprint, then rotated.
        this.tmp.scale.set(part.sx * d.hw * 2, part.h, part.sz * d.hd * 2);
      }
      this.tmp.position.set(p.x, part.y, p.z);
      this.tmp.rotation.set(0, rot, 0);
      this.tmp.updateMatrix();
      pm.mesh.setMatrixAt(index, this.tmp.matrix);
      pm.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Colours used by a prop's parts, for debris. */
  propColors(p: Prop): number[] {
    const out: number[] = [];
    const list = this.propInstances.get(p.id) ?? [];
    for (const { pm, index } of list) {
      pm.mesh.getColorAt(index, this.color);
      out.push(this.color.getHex());
    }
    return out;
  }

  private buildPeds() {
    const n = this.sim.peds.length;
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.pedBody = new THREE.InstancedMesh(box, toon(0xffffff), n);
    this.pedHead = new THREE.InstancedMesh(box, toon(0xffffff), n);
    const shadowGeo = new THREE.PlaneGeometry(1, 1);
    shadowGeo.rotateX(-Math.PI / 2);
    this.pedShadow = new THREE.InstancedMesh(shadowGeo, new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false }), n);
    for (const p of this.sim.peds) {
      this.pedBody.setColorAt(p.id, this.color.setHex(PALETTE.peds[p.variant % PALETTE.peds.length]));
      this.pedHead.setColorAt(p.id, this.color.setHex(PALETTE.skin[p.variant % PALETTE.skin.length]));
    }
    this.group.add(this.pedBody, this.pedHead, this.pedShadow);
  }

  private buildDebris() {
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.debrisMesh = new THREE.InstancedMesh(box, toon(0xffffff), MAX_DEBRIS);
    this.debrisMesh.frustumCulled = false;
    for (let i = 0; i < MAX_DEBRIS; i++) {
      this.debris.push({ active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, rz: 0, wx: 0, wy: 0, wz: 0, s: 0, life: 0, max: 1 });
      this.debrisMesh.setColorAt(i, this.color.setHex(0xffffff));
      this.tmp.scale.set(0, 0, 0);
      this.tmp.updateMatrix();
      this.debrisMesh.setMatrixAt(i, this.tmp.matrix);
    }
    this.group.add(this.debrisMesh);
  }

  /** Spray debris (§25) from a smash; direction biased along the giant's travel. */
  spawnDebris(x: number, z: number, dirX: number, dirZ: number, speed: number, count: number, colors: number[], size: [number, number], height = 1) {
    const r = this.rng;
    for (let k = 0; k < count; k++) {
      const i = this.debrisCursor;
      this.debrisCursor = (this.debrisCursor + 1) % MAX_DEBRIS;
      const d = this.debris[i];
      const spread = 0.9;
      const ang = Math.atan2(dirZ, dirX) + (r() - 0.5) * 2 * spread;
      const sp = (0.45 + r() * 0.8) * (speed + 4);
      d.active = true;
      d.x = x + (r() - 0.5) * 1.2;
      d.z = z + (r() - 0.5) * 1.2;
      d.y = 0.3 + r() * height;
      d.vx = Math.cos(ang) * sp;
      d.vz = Math.sin(ang) * sp;
      d.vy = 5 + r() * 9;
      d.rx = r() * 6; d.ry = r() * 6; d.rz = r() * 6;
      d.wx = (r() - 0.5) * 20; d.wy = (r() - 0.5) * 20; d.wz = (r() - 0.5) * 20;
      d.s = size[0] + r() * (size[1] - size[0]);
      d.max = d.life = 1.6 + r() * 1.2;
      this.debrisMesh.setColorAt(i, this.color.setHex(colors[Math.floor(r() * colors.length)]));
    }
    if (this.debrisMesh.instanceColor) this.debrisMesh.instanceColor.needsUpdate = true;
  }

  smashDebris(p: Prop, dirX: number, dirZ: number, speed: number) {
    const colors = [...this.propColors(p), ...MATERIAL_DEBRIS[p.mat]];
    const big = p.cls === 'heavy';
    const light = p.cls === 'light';
    const count = big ? 30 : light ? 7 : 16;
    const size: [number, number] = big ? [0.3, 0.9] : light ? [0.15, 0.45] : [0.2, 0.6];
    this.spawnDebris(p.x, p.z, dirX, dirZ, speed, count, colors, size, p.h);
    if (big) this.spawnDebris(p.x, p.z, dirX, dirZ, speed * 0.5, 10, MATERIAL_DEBRIS.glass, [0.1, 0.25], p.h);
  }

  /** Expanding ground ring: footfall dust at Rampage, Shoulder Check shockwave. */
  ring(x: number, z: number, scale: number, color: number, time = 0.45, opacity = 0.5) {
    const geo = new THREE.RingGeometry(0.75, 1, 32);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
    mesh.position.set(x, 0.05, z);
    this.group.add(mesh);
    this.rings.push({ mesh, t: 0, max: time, scale });
  }

  update(dt: number, alpha: number) {
    // Debris.
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

    // Rings.
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.t += dt;
      const k = r.t / r.max;
      if (k >= 1) {
        this.group.remove(r.mesh);
        r.mesh.geometry.dispose();
        (r.mesh.material as THREE.Material).dispose();
        this.rings.splice(i, 1);
        continue;
      }
      const s = r.scale * (0.3 + 0.7 * Math.sqrt(k));
      r.mesh.scale.set(s, 1, s);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.5 * (1 - k);
    }

    // Pedestrians (render at the latest sim state; they're small and slow).
    void alpha;
    const now = performance.now() / 1000;
    for (const p of this.sim.peds) {
      const tumbling = p.state === 'tumble';
      const fleeing = p.state === 'flee';
      const moving = Math.hypot(p.vx, p.vz);
      const bob = tumbling ? 0 : Math.abs(Math.sin(now * (fleeing ? 16 : 9) + p.id)) * (fleeing ? 0.18 : 0.06) * Math.min(1, moving);
      const tumbleK = tumbling ? Math.min(1, (TUNING.pedestrian.tumbleTime - p.t) * 4) * Math.min(1, p.t * 3) : 0;
      const yaw = -Math.atan2(p.vz, p.vx);
      // Body.
      this.tmp.position.set(p.x, 0.75 + bob - tumbleK * 0.45, p.z);
      this.tmp.rotation.set(tumbleK * (p.spin > 0 ? 1.4 : -1.4), yaw + (tumbling ? p.spin * (TUNING.pedestrian.tumbleTime - p.t) * 0.3 : 0), 0, 'YXZ');
      this.tmp.scale.set(0.45, 1.15, 0.32);
      this.tmp.updateMatrix();
      this.pedBody.setMatrixAt(p.id, this.tmp.matrix);
      // Head (offset along the body's up vector).
      const up = new THREE.Vector3(0, 0.78, 0).applyEuler(this.tmp.rotation);
      this.tmp.position.set(p.x + up.x, this.tmp.position.y + up.y, p.z + up.z);
      this.tmp.scale.set(0.34, 0.34, 0.34);
      this.tmp.updateMatrix();
      this.pedHead.setMatrixAt(p.id, this.tmp.matrix);
      // Shadow.
      this.tmp.position.set(p.x, 0.17, p.z);
      this.tmp.rotation.set(0, 0, 0);
      this.tmp.scale.set(1.1, 1, 1.1);
      this.tmp.updateMatrix();
      this.pedShadow.setMatrixAt(p.id, this.tmp.matrix);
    }
    this.pedBody.instanceMatrix.needsUpdate = true;
    this.pedHead.instanceMatrix.needsUpdate = true;
    this.pedShadow.instanceMatrix.needsUpdate = true;
  }
}
