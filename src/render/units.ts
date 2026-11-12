import * as THREE from 'three';
import { TUNING } from '../tuning';
import type { Sim } from '../sim/sim';
import type { Unit } from '../sim/types';
import { KIND_COLORS, MATERIAL_DEBRIS } from './palette';
import { GLOW } from './glow';
import { toon } from './toon';
import { partsFor, type HighwayView } from './highway';

/**
 * Phase 2 pursuer views. Reads `sim.pursuit.units` each frame; never writes.
 * Every tell is a shape or motion readable from the chopper (§11):
 *  - cruiser ram: amber blinker on the side it will swerve, headlights flare;
 *  - rolling roadblock: brake lights blaze across the row;
 *  - spike strip: an officer kneels on the shoulder; a jagged strip unrolls across the lane;
 *  - static roadblock: cars slide in from the shoulders; the open lane glows.
 */
interface View {
  root: THREE.Group;
  red: THREE.Sprite[];
  blue: THREE.Sprite[];
  heads: THREE.Sprite[];
  tails: THREE.Sprite[];
  blink: THREE.Sprite[];
  strip?: THREE.Group;
  officer?: THREE.Group;
  glow?: THREE.Mesh;
  group: number;
  phase: number;
}

const BOX = new THREE.BoxGeometry(1, 1, 1);
const DISC = (() => {
  const g = new THREE.PlaneGeometry(1, 1);
  g.rotateX(-Math.PI / 2);
  return g;
})();
const GAP_GLOW = new THREE.MeshBasicMaterial({ color: 0x7dffb0, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 });

export class UnitViews {
  readonly group = new THREE.Group();
  private views = new Map<number, View>();
  private time = 0;
  private pos = { x: 0, z: 0 };
  reduceFlashes = false;

  constructor(private sim: Sim, private highway: HighwayView) {}

  private build(u: Unit): View {
    const root = new THREE.Group();
    const v: View = { root, red: [], blue: [], heads: [], tails: [], blink: [], group: u.group, phase: (u.id % 7) / 7 };
    if (u.unit === 'spike') {
      // Officer on the near shoulder, and the strip (rolled up until the tell).
      const officer = new THREE.Group();
      const body = new THREE.Mesh(BOX, toon(0x1d2a4a));
      body.scale.set(0.45, 1.2, 0.45);
      body.position.y = 0.6;
      const head = new THREE.Mesh(BOX, toon(0xd9b38c));
      head.scale.set(0.3, 0.3, 0.3);
      head.position.y = 1.4;
      const hat = new THREE.Mesh(BOX, toon(0x10182e));
      hat.scale.set(0.36, 0.1, 0.36);
      hat.position.y = 1.6;
      officer.add(body, head, hat);
      const strip = new THREE.Group();
      for (let i = 0; i < 18; i++) {
        const tooth = new THREE.Mesh(BOX, toon(i % 2 ? 0x2a2a2e : 0xc9c9c9));
        tooth.scale.set(0.5, 0.12, 0.22);
        tooth.position.set(i % 2 ? 0.12 : -0.12, 0.08, i * 0.22 - 1.9);
        tooth.rotation.y = i % 2 ? 0.5 : -0.5;
        strip.add(tooth);
      }
      root.add(officer, strip);
      v.officer = officer;
      v.strip = strip;
      return v;
    }
    const body = new THREE.Group();
    const kc = KIND_COLORS[u.kind][0];
    for (const [x, y, z, w, h, d, c] of partsFor(u)) {
      const m = new THREE.Mesh(BOX, toon(c === 'kind' ? kc : c));
      m.position.set(x, y, z);
      m.scale.set(w, h, d);
      body.add(m);
    }
    root.add(body);
    const L = u.hl * 2;
    const W = u.hw * 2;
    const roof = u.kind === 'compact' ? 1.45 : 1.62;
    for (const [arr, mat, z] of [[v.red, GLOW.sirenRedHalo, -0.38], [v.blue, GLOW.sirenBlueHalo, 0.38]] as const) {
      const bar = new THREE.Mesh(BOX, new THREE.MeshBasicMaterial({ color: mat === GLOW.sirenRedHalo ? 0xff2030 : 0x2a5cff }));
      bar.scale.set(0.3, 0.14, 0.66);
      bar.position.set(-0.2, roof + 0.1, z);
      const sp = new THREE.Sprite(mat);
      sp.position.set(-0.2, roof + 0.25, z);
      sp.scale.set(2.8, 2.8, 1);
      body.add(bar, sp);
      (arr as THREE.Sprite[]).push(sp);
    }
    for (const side of [-1, 1]) {
      const hh = new THREE.Sprite(GLOW.headHalo);
      hh.position.set(L / 2 + 0.2, 0.68, side * W * 0.36);
      hh.scale.set(1.5, 1.5, 1);
      const th = new THREE.Sprite(GLOW.tailHalo);
      th.position.set(-L / 2 - 0.15, 0.75, side * W * 0.36);
      th.scale.set(1.2, 1.2, 1);
      const bl = new THREE.Sprite(GLOW.hazardHalo);
      bl.position.set(0, 0.8, side * (W / 2 + 0.15));
      bl.scale.set(1.6, 1.6, 1);
      bl.visible = false;
      bl.userData.side = side;
      body.add(hh, th, bl);
      v.heads.push(hh);
      v.tails.push(th);
      v.blink.push(bl);
    }
    // One glowing gap per roadblock row.
    if (u.unit === 'roadblock' && ![...this.views.values()].some((o) => o.glow && o.group === u.group)) {
      const glow = new THREE.Mesh(DISC, GAP_GLOW);
      glow.visible = false;
      glow.renderOrder = 2;
      this.group.add(glow);
      v.glow = glow;
    }
    return v;
  }

  /** A unit was smashed: drop its view, spray debris. */
  smash(id: number, dirX: number, dirZ: number, speed: number) {
    const v = this.views.get(id);
    if (!v) return;
    this.group.remove(v.root);
    if (v.glow) this.group.remove(v.glow);
    this.views.delete(id);
    const p = v.root.position;
    this.highway.spawnDebris(p.x, p.z, dirX, dirZ, speed, 34, [0x15151b, 0xf1f1ee, 0x1d2633, 0xff2030, 0x2a5cff, ...MATERIAL_DEBRIS.glass], [0.3, 0.9], 1.6);
  }

  update(dt: number) {
    this.time += dt;
    const sim = this.sim;
    const track = sim.track;
    const live = new Set<number>();
    const hz = this.reduceFlashes ? TUNING.look.sirenHz * 0.35 : TUNING.look.sirenHz;
    for (const u of sim.pursuit.units) {
      if (!u.alive) continue;
      live.add(u.id);
      let v = this.views.get(u.id);
      if (!v) {
        v = this.build(u);
        this.views.set(u.id, v);
        this.group.add(v.root);
      }
      const h = track.headingAt(u.s);
      if (u.unit === 'spike') {
        // Officer stands at the shoulder beside the lane; the strip unrolls across it during the tell.
        const w = track.widthAt(u.s);
        const nearLeft = u.d < w / 2;
        track.posAt(u.s, u.d, this.pos);
        v.root.position.set(this.pos.x, 0, this.pos.z);
        v.root.rotation.y = -h;
        const off = (nearLeft ? -1 : 1) * (Math.abs((nearLeft ? 0 : w) - u.d) + 1.6);
        v.officer!.position.set(0, 0, off);
        const k = u.phase === 'approach' ? 0 : u.phase === 'tell' ? Math.min(1, u.phaseT / TUNING.pursuit.spike.tell) : 1;
        v.officer!.scale.y = 1 - 0.4 * Math.min(1, k * 3); // kneels
        v.strip!.scale.z = Math.max(0.001, k);
        v.strip!.position.z = (nearLeft ? -1 : 1) * 1.9 * (1 - k);
        continue;
      }
      track.posAt(u.s, u.d, this.pos);
      v.root.position.set(this.pos.x, 0, this.pos.z);
      // Yaw into a swerve so the motion reads.
      const lat = u.phase === 'act' && u.unit === 'cruiser' ? Math.sign(u.toD - u.fromD) * 0.35 : 0;
      v.root.rotation.y = -(h + lat);
      const ph = (this.time * hz + v.phase) % 1;
      const red = ph < 0.5;
      for (const sp of v.red) sp.visible = this.reduceFlashes || red;
      for (const sp of v.blue) sp.visible = this.reduceFlashes || !red;
      // Tells.
      const tell = u.phase === 'tell';
      if (u.unit === 'cruiser') {
        const dir = Math.sign(track.laneCenter(Math.max(0, u.target)) - u.d);
        const on = tell && (this.time * 3) % 1 < 0.55;
        for (const b of v.blink) b.visible = on && b.userData.side === dir;
        for (const hh of v.heads) hh.scale.setScalar(tell || u.phase === 'act' ? 2.6 : 1.5);
      }
      if (u.unit === 'rolling') {
        const brake = u.phase !== 'approach';
        for (const t of v.tails) {
          t.material = brake ? GLOW.brakeHalo : GLOW.tailHalo;
          t.scale.setScalar(brake ? 2.2 : 1.2);
        }
      }
      if (v.glow) {
        // The open lane glows from the moment the cars start to slide.
        v.glow.visible = u.phase === 'act';
        if (v.glow.visible) {
          track.posAt(u.s - 4, track.laneCenter(u.target), this.pos);
          v.glow.position.set(this.pos.x, 0.08, this.pos.z);
          v.glow.rotation.y = -h;
          v.glow.scale.set(18, 1, TUNING.lanes.width * 0.8);
          (v.glow.material as THREE.MeshBasicMaterial).opacity = 0.25 + 0.15 * Math.sin(this.time * 6);
        }
      }
    }
    for (const [id, v] of this.views) {
      if (live.has(id)) continue;
      this.group.remove(v.root);
      if (v.glow) this.group.remove(v.glow);
      this.views.delete(id);
    }
  }
}
