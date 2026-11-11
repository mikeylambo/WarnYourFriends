import * as THREE from 'three';
import { TUNING } from '../tuning';
import type { Sim } from '../sim/sim';
import { GLOW } from './glow';
import { toon } from './toon';
import type { SirenSource } from './lighting';

/**
 * Phase 0c escort cruisers: original black-and-white patrol cars with a red/blue
 * light bar, headlights and a siren wash on the road. Reads `sim.escort` only.
 */
const TAIL = new THREE.MeshBasicMaterial({ color: 0xd01818 });

interface View {
  root: THREE.Group;
  red: THREE.Sprite[];
  blue: THREE.Sprite[];
  barRed: THREE.MeshBasicMaterial;
  barBlue: THREE.MeshBasicMaterial;
  washRed: THREE.Mesh;
  washBlue: THREE.Mesh;
  phase: number;
  lastD: number;
  yaw: number;
}

export class CruiserView {
  readonly group = new THREE.Group();
  private views: View[] = [];
  private box = new THREE.BoxGeometry(1, 1, 1);
  private time = 0;
  private pos = { x: 0, z: 0 };
  readonly sirens: SirenSource[] = [];
  reduceFlashes = false;

  constructor(private sim: Sim) {
    const disc = new THREE.PlaneGeometry(1, 1);
    disc.rotateX(-Math.PI / 2);
    const throwGeo = disc;
    sim.escort.cruisers.forEach((_c, i) => {
      const root = new THREE.Group();
      const part = (x: number, y: number, z: number, w: number, h: number, d: number, m: THREE.Material) => {
        const mesh = new THREE.Mesh(this.box, m);
        mesh.position.set(x, y, z);
        mesh.scale.set(w, h, d);
        root.add(mesh);
        return mesh;
      };
      const L = 4.8;
      const W = 1.95;
      part(0, 0.62, 0, L, 0.72, W, toon(0x15151b));
      part(0.1, 0.66, 0, L * 0.42, 0.5, W * 1.01, toon(0xf1f1ee)); // white doors
      part(-0.25, 1.28, 0, L * 0.5, 0.55, W * 0.86, toon(0x1d2633));
      part(-0.25, 1.58, 0, L * 0.48, 0.06, W * 0.88, toon(0x15151b));
      const barRed = new THREE.MeshBasicMaterial({ color: 0xff2030 });
      const barBlue = new THREE.MeshBasicMaterial({ color: 0x2a5cff });
      part(-0.2, 1.7, -0.42, 0.34, 0.16, 0.74, barRed);
      part(-0.2, 1.7, 0.42, 0.34, 0.16, 0.74, barBlue);
      const red: THREE.Sprite[] = [];
      const blue: THREE.Sprite[] = [];
      for (const [arr, mat, z] of [[red, GLOW.sirenRedHalo, -0.42], [blue, GLOW.sirenBlueHalo, 0.42]] as const) {
        const sp = new THREE.Sprite(mat);
        sp.position.set(-0.2, 1.85, z);
        sp.scale.set(3.2, 3.2, 1);
        root.add(sp);
        (arr as THREE.Sprite[]).push(sp);
      }
      for (const side of [-1, 1]) {
        const hh = new THREE.Sprite(GLOW.headHalo);
        hh.position.set(L / 2 + 0.2, 0.68, side * W * 0.36);
        hh.scale.set(1.5, 1.5, 1);
        root.add(hh);
        const tl = new THREE.Mesh(this.box, TAIL);
        tl.position.set(-L / 2 - 0.02, 0.75, side * W * 0.36);
        tl.scale.set(0.06, 0.18, 0.34);
        root.add(tl);
      }
      const beam = new THREE.Mesh(throwGeo, GLOW.headPool);
      beam.position.set(L / 2 + 6.5, 0.055, 0);
      beam.scale.set(13, 1, 6.5);
      beam.renderOrder = 1;
      root.add(beam);
      const washRed = new THREE.Mesh(disc, GLOW.sirenRed);
      const washBlue = new THREE.Mesh(disc, GLOW.sirenBlue);
      for (const w of [washRed, washBlue]) {
        w.scale.set(24, 1, 24);
        w.position.set(4, 0.06, 0);
        w.renderOrder = 1;
        root.add(w);
      }
      root.visible = false;
      this.group.add(root);
      this.views.push({ root, red, blue, barRed, barBlue, washRed, washBlue, phase: i * 0.37, lastD: 0, yaw: 0 });
      this.sirens.push({ x: 0, z: 0, active: false, phase: i * 0.37 });
    });
  }

  /** Show every cruiser (for shader precompile only; update() restores visibility). */
  showAll(on: boolean) {
    for (const v of this.views) v.root.visible = on;
  }

  update(dt: number) {
    this.time += dt;
    const track = this.sim.track;
    const hz = this.reduceFlashes ? TUNING.look.sirenHz * 0.35 : TUNING.look.sirenHz;
    this.sim.escort.cruisers.forEach((c, i) => {
      const v = this.views[i];
      const s = this.sirens[i];
      v.root.visible = c.active;
      s.active = c.active;
      if (!c.active) return;
      track.posAt(c.s, c.d, this.pos);
      const h = track.headingAt(c.s);
      const lat = dt > 0 ? (c.d - v.lastD) / dt : 0;
      v.lastD = c.d;
      v.yaw += (Math.atan2(lat, Math.max(4, c.speed)) - v.yaw) * Math.min(1, dt * 8);
      v.root.position.set(this.pos.x, 0, this.pos.z);
      v.root.rotation.y = -(h + v.yaw);
      s.x = this.pos.x;
      s.z = this.pos.z;
      const ph = (this.time * hz + v.phase) % 1;
      const red = ph < 0.5;
      // Reduce Flashes: both halves stay lit and only the balance shifts.
      const soft = this.reduceFlashes;
      for (const sp of v.red) sp.visible = soft || red;
      for (const sp of v.blue) sp.visible = soft || !red;
      v.barRed.color.setHex(red || soft ? 0xff2030 : 0x401018);
      v.barBlue.color.setHex(!red || soft ? 0x2a5cff : 0x101840);
      v.washRed.visible = soft ? true : red;
      v.washBlue.visible = soft ? true : !red;
    });
  }
}
