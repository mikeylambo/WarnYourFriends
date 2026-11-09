import * as THREE from 'three';
import { TUNING } from '../tuning';
import { angleDiff } from '../sim/math';
import type { GiantState } from '../sim/types';
import { PALETTE } from './palette';
import { blobTexture, toon } from './world';

/**
 * Greybox giant (Phase 0). Placeholder that swaps without touching logic (§23):
 * everything here reads GiantState and animates; nothing writes back to the sim.
 *
 * Identity per §13 (provisional): armored warlord, violet-and-bone, horned
 * pauldrons, braided white topknot, tattered floor-length cape, wrapped forearms.
 * Model faces +X; the root is yawed to the giant's heading.
 */

const CAPE_SEGS = 7;
const CAPE_LEN = 3.1;

function box(w: number, h: number, d: number, color: number): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), toon(color));
}

export class GiantView {
  readonly root = new THREE.Group();
  private yaw = new THREE.Group();
  private hips = new THREE.Group();
  private torso = new THREE.Group();
  private head = new THREE.Group();
  private legL = new THREE.Group();
  private legR = new THREE.Group();
  private armL = new THREE.Group();
  private armR = new THREE.Group();
  private braid: THREE.Mesh[] = [];
  private shadow: THREE.Mesh;

  private cape: THREE.Mesh;
  private capePts: { p: THREE.Vector3 }[] = [];
  private capeHistory: THREE.Vector3[] = [];
  private capeGeo: THREE.BufferGeometry;

  private lean = 0;
  private bank = 0;
  private shoulderAnim = 0;
  private tierFlare = 0;
  private stumbleWobble = 0;
  private time = 0;

  constructor() {
    const S = TUNING.giant.height / 3.6;
    this.root.add(this.yaw);
    this.yaw.add(this.hips);
    this.hips.position.y = 1.65 * S;

    // Legs: pivot at the hip, thigh+shin as one block, heavy boot.
    for (const [leg, z] of [[this.legL, 0.3], [this.legR, -0.3]] as const) {
      leg.position.set(0, 0, z);
      const limb = box(0.42, 1.45, 0.42, PALETTE.giantBody);
      limb.position.y = -0.72;
      const boot = box(0.7, 0.32, 0.5, PALETTE.giantArmor);
      boot.position.set(0.12, -1.5, 0);
      const knee = box(0.46, 0.22, 0.46, PALETTE.giantBone);
      knee.position.set(0.05, -0.72, 0);
      leg.add(limb, boot, knee);
      this.hips.add(leg);
    }

    const pelvis = box(0.6, 0.4, 0.95, PALETTE.giantArmor);
    this.hips.add(pelvis);

    // Torso pivots at the hips so lean reads as a body lean, not a slide.
    this.hips.add(this.torso);
    const chest = box(0.95, 1.25, 1.35, PALETTE.giantBody);
    chest.position.y = 0.72;
    const plate = box(0.2, 0.8, 1.0, PALETTE.giantArmor);
    plate.position.set(0.48, 0.8, 0);
    const belt = box(1.0, 0.18, 1.4, PALETTE.giantBone);
    belt.position.y = 0.12;
    this.torso.add(chest, plate, belt);

    // Horned pauldrons: the top-down silhouette.
    for (const side of [1, -1]) {
      const pauldron = box(0.95, 0.38, 0.62, PALETTE.giantBone);
      pauldron.position.set(0, 1.42, side * 0.78);
      pauldron.rotation.x = side * 0.25;
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.85, 6), toon(PALETTE.giantBone));
      horn.position.set(0.1, 1.85, side * 1.02);
      horn.rotation.x = side * -0.75;
      horn.rotation.z = -0.25;
      this.torso.add(pauldron, horn);
    }

    // Arms.
    for (const [arm, z] of [[this.armL, 0.86], [this.armR, -0.86]] as const) {
      arm.position.set(0, 1.25, z);
      const upper = box(0.34, 0.85, 0.34, PALETTE.giantBody);
      upper.position.y = -0.42;
      const fore = box(0.3, 0.75, 0.3, PALETTE.giantSkin);
      fore.position.y = -1.1;
      const band1 = box(0.33, 0.1, 0.33, PALETTE.giantBand);
      band1.position.y = -0.95;
      const band2 = band1.clone();
      band2.position.y = -1.2;
      const fist = box(0.34, 0.3, 0.34, PALETTE.giantSkin);
      fist.position.y = -1.55;
      arm.add(upper, fore, band1, band2, fist);
      this.torso.add(arm);
    }

    // Head, bone half-helm, white topknot and braid.
    this.head.position.y = 1.6;
    this.torso.add(this.head);
    const skull = box(0.5, 0.55, 0.5, PALETTE.giantSkin);
    skull.position.y = 0.28;
    const helm = box(0.56, 0.3, 0.56, PALETTE.giantBone);
    helm.position.y = 0.45;
    const knot = box(0.24, 0.26, 0.24, PALETTE.giantHair);
    knot.position.set(-0.08, 0.72, 0);
    this.head.add(skull, helm, knot);
    for (let i = 0; i < 4; i++) {
      const b = box(0.16, 0.16, 0.16, PALETTE.giantHair);
      this.braid.push(b);
      this.root.add(b);
    }

    // Cape: a world-space verlet ribbon anchored behind the shoulders.
    this.capeGeo = new THREE.BufferGeometry();
    const verts = new Float32Array((CAPE_SEGS + 1) * 2 * 3);
    this.capeGeo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    const idx: number[] = [];
    for (let i = 0; i < CAPE_SEGS; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.capeGeo.setIndex(idx);
    this.cape = new THREE.Mesh(this.capeGeo, toon(PALETTE.giantCape, { side: THREE.DoubleSide }));
    this.cape.frustumCulled = false;
    for (let i = 0; i <= CAPE_SEGS; i++) {
      this.capePts.push({ p: new THREE.Vector3() });
    }

    // Shadow blob.
    const sg = new THREE.PlaneGeometry(1, 1);
    sg.rotateX(-Math.PI / 2);
    this.shadow = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false }));
    this.shadow.scale.set(3.4, 1, 3.4);
  }

  /** Objects to add to the scene (cape and braid live in world space). */
  get objects(): THREE.Object3D[] {
    return [this.root, this.cape, this.shadow];
  }

  reset(g: GiantState) {
    this.root.position.set(g.x, 0, g.z);
    this.yaw.rotation.y = -g.heading;
    this.root.updateMatrixWorld(true);
    this.capeHistory.length = 0;
  }

  onShoulder() {
    this.shoulderAnim = 1;
  }
  onTierUp() {
    this.tierFlare = 1;
  }
  onBounce() {
    this.stumbleWobble = 1;
  }

  private capeAnchor(side: number): THREE.Vector3 {
    // Behind the shoulders, in world space.
    const v = new THREE.Vector3(-0.55, 1.35, side * 0.7);
    return this.torso.localToWorld(v);
  }

  /**
   * @param x, z, heading  interpolated pose for this frame
   * @param g              latest sim state (tier, speed, gait, stumble, angVel)
   */
  update(dt: number, x: number, z: number, heading: number, g: GiantState) {
    this.time += dt;
    const T = TUNING.tiers[g.tier];
    const k = (tau: number) => 1 - Math.exp(-dt / tau);

    this.root.position.set(x, 0, z);
    this.yaw.rotation.y = -heading;
    this.shadow.position.set(x + 0.4, 0.18, z + 0.4);

    // Lean: tier lean, plus extra lean while accelerating, plus shoulder windup/lunge.
    this.shoulderAnim = Math.max(0, this.shoulderAnim - dt / 0.35);
    const sh = this.shoulderAnim;
    const shoulderLean = sh > 0.85 ? (1 - sh) / 0.15 * 0.35 : sh * 0.35; // 3f windup, then the lunge
    const targetLean = (T.leanDeg * Math.PI) / 180 + (g.braking ? -0.25 : 0) + shoulderLean;
    this.lean += (targetLean - this.lean) * k(0.12);
    // Bank into turns (roll about the forward axis); the drift angle adds to it.
    const slip = angleDiff(g.travel, g.heading);
    const targetBank = -g.angVel * 0.12 - slip * 0.4;
    this.bank += (targetBank - this.bank) * k(0.1);

    // Gait.
    const ph = g.gaitPhase * Math.PI * 2;
    const swing = [0.55, 0.75, 0.95][g.tier];
    const bobAmp = [0.12, 0.2, 0.3][g.tier];
    const s = Math.sin(ph);
    this.legL.rotation.z = s * swing;
    this.legR.rotation.z = -s * swing;
    // Arms trail at higher tiers (§10 "arms trailing").
    const armTrail = [0.1, 0.45, 0.9][g.tier];
    this.armL.rotation.z = -s * swing * 0.8 - armTrail;
    this.armR.rotation.z = s * swing * 0.8 - armTrail;
    this.armL.rotation.x = 0.15;
    this.armR.rotation.x = -0.15;
    if (sh > 0) {
      // Shoulder Check: lead shoulder drives forward.
      this.armL.rotation.z = 0.9 * sh;
      this.armL.rotation.x = 0.6 * sh;
    }

    // Lowest at each footfall (phase k/2), highest mid-stride.
    this.hips.position.y = 1.6 + Math.abs(s) * bobAmp;
    // Stumble wobble (§10): heavy, embarrassing, readable in 0.3s.
    this.stumbleWobble = Math.max(0, this.stumbleWobble - dt / 0.45);
    const wob = Math.sin(this.time * 32) * this.stumbleWobble * 0.35;
    this.torso.rotation.set(this.bank + wob, wob * 0.6 + (sh > 0 ? -0.5 * sh : 0), -this.lean);
    this.hips.rotation.set(this.bank * 0.4, 0, -this.lean * 0.25);
    this.head.rotation.z = this.lean * 0.6; // keep eyes on the street

    this.root.updateMatrixWorld(true);

    // Braid: trails from the topknot.
    const knotWorld = this.head.localToWorld(new THREE.Vector3(-0.15, 0.72, 0));
    let prev = knotWorld;
    const back = new THREE.Vector3(-Math.cos(g.travel), 0, -Math.sin(g.travel));
    this.braid.forEach((b, i) => {
      const target = prev.clone().addScaledVector(back, 0.22 + g.speed * 0.012).add(new THREE.Vector3(0, -0.12 - (1 - g.speed / 15) * 0.12, 0));
      b.position.lerp(target, k(0.04 + i * 0.02));
      if (b.position.distanceToSquared(target) > 4) b.position.copy(target);
      prev = b.position;
    });

    this.updateCape(dt, g);
  }

  private updateCape(dt: number, g: GiantState) {
    this.tierFlare = Math.max(0, this.tierFlare - dt / 0.6);
    const left = this.capeAnchor(1);
    const right = this.capeAnchor(-1);
    const anchor = left.clone().add(right).multiplyScalar(0.5);

    // Kinematic cape: points follow the anchor's own recent path, so the cape
    // swings wide through drifts and corners. Droop flattens with speed (it
    // flares at Rampage) and kicks out on tier-up (§10). Flutter is a visual
    // offset only, so it can never pump energy into the cape.
    const hist = this.capeHistory;
    const lastH = hist[hist.length - 1];
    if (!lastH || lastH.distanceToSquared(anchor) > 0.0025) hist.push(anchor.clone());
    if (hist.length > 80) hist.shift();

    const segLen = CAPE_LEN / CAPE_SEGS;
    const speedK = Math.min(1, g.speed / 15);
    const droop = (1 - speedK) * 1.25 + 0.3 - this.tierFlare * 0.25; // radians below horizontal
    const horiz = Math.cos(droop);
    const vert = Math.sin(droop);
    const back = new THREE.Vector3(-Math.cos(g.travel), 0, -Math.sin(g.travel));

    let walked = 0;
    let h = hist.length - 1;
    let from = anchor.clone();
    for (let i = 0; i <= CAPE_SEGS; i++) {
      const want = i * segLen * horiz;
      // Walk back along the path history to the distance we need.
      while (walked < want && h > 0) {
        const step = from.distanceTo(hist[h - 1]);
        if (walked + step >= want) {
          const t = (want - walked) / Math.max(step, 1e-6);
          from = from.clone().lerp(hist[h - 1], t);
          walked = want;
          break;
        }
        walked += step;
        from = hist[h - 1].clone();
        h--;
      }
      const p = this.capePts[i].p;
      p.copy(from);
      if (walked < want) p.addScaledVector(back, want - walked); // not enough history yet
      const flutter = i === 0 ? 0 : Math.sin(this.time * (5 + g.speed * 0.8) + i * 1.1) * 0.06 * i * (0.3 + speedK);
      p.y = Math.max(0.1, anchor.y - i * segLen * vert + flutter);
    }

    // Ribbon, slightly wider at the hem so it reads from above.
    const pos = this.capeGeo.getAttribute('position') as THREE.BufferAttribute;
    const side = right.clone().sub(left).setY(0).normalize();
    for (let i = 0; i <= CAPE_SEGS; i++) {
      const c = this.capePts[i].p;
      const t = i / CAPE_SEGS;
      const w = 0.72 + t * 0.28 * (0.5 + speedK);
      // Tattered hem: alternate the last row's edges.
      const tatter = i === CAPE_SEGS ? Math.sin(this.time * 11) * 0.12 : 0;
      pos.setXYZ(i * 2, c.x - side.x * w, c.y + tatter, c.z - side.z * w);
      pos.setXYZ(i * 2 + 1, c.x + side.x * w, c.y - tatter, c.z + side.z * w);
    }
    pos.needsUpdate = true;
    this.capeGeo.computeVertexNormals();
    this.capeGeo.computeBoundingSphere();
  }
}
