import * as THREE from 'three';
import { TUNING } from '../tuning';
import type { Sim } from '../sim/sim';
import type { Unit } from '../sim/types';
import { KIND_COLORS, MATERIAL_DEBRIS } from './palette';
import { GLOW } from './glow';
import { toon } from './toon';
import { propBody, SMASH_RING_GEO, SMASH_RING_MAT, type HighwayView } from './highway';

/**
 * Phase 2 pursuer views. Reads `sim.pursuit.units` each frame; never writes.
 * Every tell is a shape or motion readable from the chopper (§11):
 *  - cruiser ram: amber blinker on the side it will swerve, headlights flare;
 *  - rolling roadblock: brake lights blaze across the row;
 *  - spike strip: an officer kneels on the shoulder; a jagged strip unrolls across the lane;
 *  - static roadblock: cars slide in from the shoulders; the open lane glows.
 *  - police chopper: a cool white pool and beam sweep across the road onto him; locked, his lane
 *    lights up ahead of him (marked for units) and the pool lags each lane change.
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
  /** Chopper: ground pool, beam, and the marked-lane stripe. */
  pool?: THREE.Mesh;
  beam?: THREE.Mesh;
  mark?: THREE.Mesh;
  group: number;
  phase: number;
}

const BOX = new THREE.BoxGeometry(1, 1, 1);
const DISC = (() => {
  const g = new THREE.PlaneGeometry(1, 1);
  g.rotateX(-Math.PI / 2);
  return g;
})();
const POOL_GEO = (() => {
  const g = new THREE.CircleGeometry(1, 32);
  g.rotateX(-Math.PI / 2);
  return g;
})();
/** Open cone, apex at +y. Scaled to (radius, length, radius) and aimed apex-to-pool. */
const BEAM_GEO = (() => {
  const g = new THREE.CylinderGeometry(0.02, 1, 1, 24, 1, true);
  g.translate(0, -0.5, 0);
  return g;
})();
const add = (color: number, opacity: number) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3 });
const UP = new THREE.Vector3(0, 1, 0);
/** Light-bar lenses, shared by every unit (review #50: two new materials per unit). */
const BAR_RED = new THREE.MeshBasicMaterial({ color: 0xff2030 });
const BAR_BLUE = new THREE.MeshBasicMaterial({ color: 0x2a5cff });
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
    if (u.unit === 'chopper') {
      const pool = new THREE.Mesh(POOL_GEO, add(0xdfe9ff, 0.4));
      pool.renderOrder = 3;
      const beam = new THREE.Mesh(BEAM_GEO, add(0xcfe0ff, 0.07));
      beam.renderOrder = 3;
      const mark = new THREE.Mesh(DISC, add(0xbcd4ff, 0.2));
      mark.renderOrder = 2;
      mark.visible = false;
      this.group.add(pool, beam, mark);
      v.pool = pool;
      v.beam = beam;
      v.mark = mark;
      return v;
    }
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
      // Road flare: a flashing red light so the tell reads from chopper height.
      const flare = new THREE.Sprite(GLOW.sirenRedHalo);
      flare.scale.set(3.4, 3.4, 1);
      flare.position.set(0, 0.4, 0);
      flare.visible = false;
      officer.add(body, head, hat, flare);
      officer.userData.flare = flare;
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
    body.add(propBody(u, kc));
    root.add(body);
    // Prototype: a Rolling Blockade's compacts crunch in Stride, so they wear the smash ring (ring = crunch it).
    if (TUNING.proto.on && u.unit === 'rolling' && u.kind === 'compact') {
      const ring = new THREE.Mesh(SMASH_RING_GEO, SMASH_RING_MAT);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.04;
      const r = Math.max(u.hw, u.hl) + 0.5;
      ring.scale.set(r, r, 1);
      root.add(ring);
    }
    const L = u.hl * 2;
    const W = u.hw * 2;
    // Light bar on the roof (the armoured truck's sits higher); the car carrier is traffic: no lights.
    const roof = u.kind === 'compact' ? 1.45 : u.kind === 'armored' ? 2.8 : 1.62;
    const police = u.unit !== 'carrier';
    for (const [arr, mat, z] of police ? ([[v.red, GLOW.sirenRedHalo, -0.38], [v.blue, GLOW.sirenBlueHalo, 0.38]] as const) : []) {
      const bar = new THREE.Mesh(BOX, mat === GLOW.sirenRedHalo ? BAR_RED : BAR_BLUE);
      bar.scale.set(0.3, 0.14, 0.66);
      bar.position.set(-0.2, roof + 0.1, z);
      const sp = new THREE.Sprite(mat);
      sp.position.set(-0.2, roof + 0.25, z);
      sp.scale.set(2.1, 2.1, 1);
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
    // Rampage-only police (roadblock and blockade cruisers): a hazard-yellow roof and a heavy push bar, so from the
    // chopper they don't read as the ordinary cruisers Stride flattens.
    if (u.rampOnly) {
      const hazard = toon(0xf2c200, { emissive: 0x3a2c00 });
      const roofPanel = new THREE.Mesh(BOX, hazard);
      roofPanel.scale.set(L * 0.42, 0.06, W * 0.86);
      roofPanel.position.set(-0.2, roof + 0.02, 0);
      const pushBar = new THREE.Mesh(BOX, toon(0x1a1a1f));
      pushBar.scale.set(0.35, 0.55, W * 1.08);
      pushBar.position.set(L / 2 + 0.15, 0.55, 0);
      const stripe = new THREE.Mesh(BOX, hazard);
      stripe.scale.set(0.37, 0.14, W * 1.1);
      stripe.position.set(L / 2 + 0.15, 0.62, 0);
      body.add(roofPanel, pushBar, stripe);
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
  smash(id: number, dirX: number, dirZ: number, speed: number, side = 1) {
    const v = this.views.get(id);
    if (!v) return;
    this.drop(v);
    this.views.delete(id);
    const p = v.root.position.clone();
    // The cruiser itself is swatted off his line (the highway owns wrecks from here).
    this.group.remove(v.root);
    const u = this.sim.pursuit.units.find((q) => q.id === id);
    const W = u ? this.sim.track.widthAt(u.s) : Infinity;
    this.highway.launchWreck(v.root, dirX, dirZ, speed, true, side, 1.5, u ? (side > 0 ? W - u.d : u.d) - u.hw : Infinity);
    const sx = -dirZ * side, sz = dirX * side;
    this.highway.spawnDebris(p.x, p.z, dirX + sx * 1.4, dirZ + sz * 1.4, speed * 0.5, 30, [0x15151b, 0xf1f1ee, 0x1d2633, 0xff2030, 0x2a5cff, ...MATERIAL_DEBRIS.glass], [0.3, 0.9], 1.6);
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
      if (u.unit === 'chopper') {
        this.updateChopper(u, v, h);
        continue;
      }
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
        (v.officer!.userData.flare as THREE.Sprite).visible = u.phase !== 'approach' && (this.reduceFlashes || (this.time * 4) % 1 < 0.6);
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
      this.drop(v);
      this.views.delete(id);
    }
  }

  private drop(v: View) {
    this.group.remove(v.root);
    for (const m of [v.glow, v.pool, v.beam, v.mark]) if (m) this.group.remove(m);
  }

  private beamFrom = new THREE.Vector3();
  private beamTo = new THREE.Vector3();

  private updateChopper(u: Unit, v: View, h: number) {
    const track = this.sim.track;
    const H = TUNING.pursuit.chopper;
    const fade = u.phase === 'leave' ? Math.max(0, 1 - u.phaseT / H.leaveTime) : u.phase === 'approach' ? 0.6 : 1;
    const lock = u.phase === 'act';
    // Tight on him when locked, a wider searching pool while it sweeps.
    const r = lock ? 3.2 : 4.2;
    track.posAt(u.s, u.d, this.pos);
    v.pool!.position.set(this.pos.x, 0.09, this.pos.z);
    v.pool!.scale.set(r, 1, r);
    (v.pool!.material as THREE.MeshBasicMaterial).opacity = (lock ? 0.45 : 0.32) * fade;
    // The beam comes down from the police chopper, high and ahead (it isn't the news chopper).
    this.beamTo.set(this.pos.x, 0, this.pos.z);
    track.posAt(u.s + 30, u.d < track.widthAt(u.s) / 2 ? -14 : track.widthAt(u.s) + 14, this.pos);
    this.beamFrom.set(this.pos.x, 46, this.pos.z);
    const dir = this.beamTo.clone().sub(this.beamFrom);
    const len = dir.length();
    v.beam!.position.copy(this.beamFrom);
    v.beam!.quaternion.setFromUnitVectors(UP, dir.normalize().negate());
    v.beam!.scale.set(r, len, r);
    (v.beam!.material as THREE.MeshBasicMaterial).opacity = (lock ? 0.09 : 0.06) * fade;
    // Locked: his lane is marked for units, a pulsing stripe running ahead of him.
    v.mark!.visible = lock;
    if (lock) {
      const ahead = 14;
      track.posAt(u.s + ahead, track.laneCenter(u.lane), this.pos);
      v.mark!.position.set(this.pos.x, 0.07, this.pos.z);
      v.mark!.rotation.y = -h;
      v.mark!.scale.set(ahead * 2, 1, TUNING.lanes.width * 0.75);
      const pulse = this.reduceFlashes ? 0.18 : 0.14 + 0.08 * Math.sin(this.time * 5);
      (v.mark!.material as THREE.MeshBasicMaterial).opacity = pulse;
    }
  }
}
