import * as THREE from 'three';
import { TUNING } from '../tuning';
import type { GaitFrame, Vec3 } from '../anim/gait';
import { PALETTE } from './palette';
import { blobTexture, rimToon } from './toon';

/**
 * Greybox giant (Phase 0b). A placeholder that swaps without touching logic
 * (§23): it reads the sim pose and the gait frame and draws; nothing writes back.
 *
 * Identity per §13 (provisional): armored warlord, violet-and-bone, horned
 * pauldrons, braided white topknot, wrapped forearms, and (v0.3) a KNEE-LENGTH
 * cape so it never hides the run.
 *
 * v0.3 run: legs are drawn from the gait's IK (hip → knee → planted foot), so a
 * planted foot never slides. Low, forward-driving posture, arms trailing, head
 * steady. The torso model faces +X; the root is yawed to the heading.
 */

const CAPE_SEGS = 6;
/** Knee length: from the shoulders (~3.0m) to about the knee (~1.0m). */
const CAPE_LEN = 1.9;
/** Ink outline thickness (m): ~2px at Chase High distance. */
const OUTLINE_WIDTH = 0.06;

export interface GiantPose {
  x: number;
  z: number;
  /** Body facing (radians, world): road heading plus a little lean into a lane change. */
  heading: number;
  /** Direction of travel along the road (radians). */
  travel: number;
  /** Lateral velocity across the road (m/s, + = right). */
  lateralVel: number;
  speed: number;
  tier: number;
  braking: boolean;
  stumble: number;
  stepPos: number;
}

function box(w: number, h: number, d: number, color: number): THREE.Mesh {
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), rimToon(color));
}

const UP = new THREE.Vector3(0, 1, 0);

export class GiantView {
  readonly root = new THREE.Group();
  private hips = new THREE.Group();
  private torso = new THREE.Group();
  private head = new THREE.Group();
  private armL = new THREE.Group();
  private armR = new THREE.Group();
  private braid: THREE.Mesh[] = [];
  private shadow: THREE.Mesh;
  private legs = new THREE.Group();
  private legParts: { thigh: THREE.Mesh; shin: THREE.Mesh; knee: THREE.Mesh; boot: THREE.Mesh }[] = [];

  private cape: THREE.Mesh;
  private capePts: THREE.Vector3[] = [];
  private capeHistory: THREE.Vector3[] = [];
  private capeGeo: THREE.BufferGeometry;

  private lean = 0;
  private bank = 0;
  private shoulderAnim = 0;
  private tierFlare = 0;
  private stumbleWobble = 0;
  private time = 0;
  private tmp = new THREE.Vector3();

  constructor() {
    this.root.add(this.hips);

    const pelvis = box(0.62, 0.42, 0.95, PALETTE.giantArmor);
    this.hips.add(pelvis);

    // Torso pivots at the hips so the lean reads as a body lean, not a slide.
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
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.85, 6), rimToon(PALETTE.giantBone));
      horn.position.set(0.1, 1.85, side * 1.02);
      horn.rotation.x = side * -0.75;
      horn.rotation.z = -0.25;
      this.torso.add(pauldron, horn);
    }

    // Arms (trail behind the body).
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
    }

    // Legs: world-space segments driven by the gait IK. Unit geometry along +Y.
    const seg = (w: number, color: number) => {
      const g = new THREE.BoxGeometry(w, 1, w);
      g.translate(0, 0.5, 0);
      return new THREE.Mesh(g, rimToon(color));
    };
    for (let i = 0; i < 2; i++) {
      const thigh = seg(0.44, PALETTE.giantBody);
      const shin = seg(0.38, PALETTE.giantBody);
      const knee = box(0.46, 0.24, 0.46, PALETTE.giantBone);
      const boot = box(0.72, 0.32, 0.5, PALETTE.giantArmor);
      this.legs.add(thigh, shin, knee, boot);
      this.legParts.push({ thigh, shin, knee, boot });
    }

    // Cape: knee length, follows the anchor's path.
    this.capeGeo = new THREE.BufferGeometry();
    this.capeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((CAPE_SEGS + 1) * 2 * 3), 3));
    const idx: number[] = [];
    for (let i = 0; i < CAPE_SEGS; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.capeGeo.setIndex(idx);
    this.cape = new THREE.Mesh(this.capeGeo, rimToon(PALETTE.giantCape, THREE.DoubleSide));
    this.cape.frustumCulled = false;
    for (let i = 0; i <= CAPE_SEGS; i++) this.capePts.push(new THREE.Vector3());

    const sg = new THREE.PlaneGeometry(1, 1);
    sg.rotateX(-Math.PI / 2);
    this.shadow = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false }));
    this.shadow.scale.set(3.2, 1, 3.2);
    this.addOutlines();
  }

  /**
   * Phase 0c ink outline: an inverted hull (back faces of each part grown by a few
   * cm) so the giant's shape holds against a lit road even where his bone and
   * hair parts are light. The cape is already the darkest thing on screen.
   */
  private addOutlines() {
    const mat = new THREE.MeshBasicMaterial({ color: PALETTE.giantOutline, side: THREE.BackSide });
    const t = OUTLINE_WIDTH;
    const parts: THREE.Mesh[] = [];
    for (const o of [this.root, this.legs, ...this.braid]) o.traverse((m) => (m as THREE.Mesh).isMesh && parts.push(m as THREE.Mesh));
    for (const m of parts) {
      const g = m.geometry.clone();
      g.computeBoundingBox();
      const c = g.boundingBox!.getCenter(new THREE.Vector3());
      const p = g.getAttribute('position');
      for (let i = 0; i < p.count; i++) {
        p.setXYZ(i, p.getX(i) + Math.sign(p.getX(i) - c.x) * t, p.getY(i) + Math.sign(p.getY(i) - c.y) * t, p.getZ(i) + Math.sign(p.getZ(i) - c.z) * t);
      }
      const hull = new THREE.Mesh(g, mat);
      hull.userData.outline = true;
      m.add(hull);
    }
  }

  get objects(): THREE.Object3D[] {
    return [this.root, this.legs, this.cape, this.shadow, ...this.braid];
  }

  /** The giant's body without his ground shadow (silhouette test). */
  get bodyObjects(): THREE.Object3D[] {
    return [this.root, this.legs, this.cape, ...this.braid];
  }

  reset() {
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

  private placeSegment(mesh: THREE.Mesh, a: Vec3, b: Vec3) {
    const dir = this.tmp.set(b.x - a.x, b.y - a.y, b.z - a.z);
    const len = dir.length();
    mesh.position.set(a.x, a.y, a.z);
    mesh.quaternion.setFromUnitVectors(UP, dir.divideScalar(len || 1));
    mesh.scale.set(1, len, 1);
  }

  update(dt: number, p: GiantPose, gait: GaitFrame) {
    this.time += dt;
    const T = TUNING.tiers[p.tier];
    const k = (tau: number) => 1 - Math.exp(-dt / tau);

    this.root.position.set(p.x, 0, p.z);
    this.root.rotation.y = -p.heading;
    this.hips.position.y = gait.hipY;
    this.shadow.position.set(p.x + 0.4, 0.07, p.z + 0.4);

    // Low, forward-driving lean; more while braking upright; shoulder windup then lunge.
    this.shoulderAnim = Math.max(0, this.shoulderAnim - dt / 0.35);
    const sh = this.shoulderAnim;
    const shoulderLean = sh > 0.85 ? ((1 - sh) / 0.15) * 0.35 : sh * 0.35;
    const targetLean = (T.leanDeg * Math.PI) / 180 + (p.braking ? -0.3 : 0) + shoulderLean;
    this.lean += (targetLean - this.lean) * k(0.12);
    // Bank into a lane change (roll about the forward axis).
    const targetBank = -p.lateralVel * 0.025;
    this.bank += (targetBank - this.bank) * k(0.08);

    // Stumble wobble (v0.3: −1 tier, 0.3s stumble): heavy, embarrassing, never a stop.
    this.stumbleWobble = Math.max(this.stumbleWobble - dt / 0.45, p.stumble > 0 ? 0.8 : 0);
    const wob = Math.sin(this.time * 32) * this.stumbleWobble * 0.3;

    // Torso twist with the stride (opposite shoulder drives forward).
    const ph = p.stepPos * Math.PI;
    const twist = Math.sin(ph) * 0.14 * (0.6 + p.tier * 0.35); // shoulders roll against the hips
    this.torso.rotation.set(this.bank + wob, twist + (sh > 0 ? -0.5 * sh : 0), -this.lean);
    this.hips.rotation.set(this.bank * 0.4, -twist * 0.5, -this.lean * 0.2);

    // Head steady: counter the lean and most of the plant drop so the eyes stay level.
    this.head.rotation.set(-this.bank * 0.8, -twist, this.lean * 0.85);
    this.head.position.y = 1.6 + TUNING.tiers[p.tier].bodyDrop * gait.drop * 0.6;

    // Arm pump opposite the legs: the lead fist drives forward at shoulder height, the other
    // pulls back. Snapped so the arms hold the strong poses and move fast through the middle.
    const raw = Math.sin(ph);
    const pump = Math.sign(raw) * Math.pow(Math.abs(raw), TUNING.gait.poseSnap) * T.armSwing;
    // The lean tips the shoulders forward; compensate so "forward" stays forward in the world.
    const lean = this.lean * 0.6;
    this.armL.rotation.set(0.18, 0, T.armBase - pump + lean);
    this.armR.rotation.set(-0.18, 0, T.armBase + pump + lean);
    if (sh > 0) this.armL.rotation.set(0.6 * sh, 0, 0.9 * sh);

    this.root.updateMatrixWorld(true);

    // Legs from the gait IK (world space).
    for (let i = 0; i < 2; i++) {
      const L = gait.legs[i];
      const P = this.legParts[i];
      this.placeSegment(P.thigh, L.hip, L.knee);
      this.placeSegment(P.shin, L.knee, L.foot);
      P.knee.position.set(L.knee.x, L.knee.y, L.knee.z);
      P.knee.rotation.set(0, -p.heading, 0);
      P.boot.position.set(L.foot.x + Math.cos(p.heading) * 0.12, Math.max(0.16, L.foot.y + 0.06), L.foot.z + Math.sin(p.heading) * 0.12);
      P.boot.rotation.set(0, -p.heading, L.planted ? 0 : 0.35);
    }

    // Braid trails from the topknot.
    const knotWorld = this.head.localToWorld(new THREE.Vector3(-0.15, 0.72, 0));
    let prev = knotWorld;
    const back = new THREE.Vector3(-Math.cos(p.travel), 0, -Math.sin(p.travel));
    this.braid.forEach((b, i) => {
      const target = prev.clone().addScaledVector(back, 0.22 + p.speed * 0.012).add(new THREE.Vector3(0, -0.12 - (1 - p.speed / 15) * 0.12, 0));
      b.position.lerp(target, k(0.04 + i * 0.02));
      if (b.position.distanceToSquared(target) > 4) b.position.copy(target);
      prev = b.position;
    });

    this.updateCape(dt, p);
  }

  private capeAnchor(side: number): THREE.Vector3 {
    return this.torso.localToWorld(new THREE.Vector3(-0.55, 1.35, side * 0.7));
  }

  /** Kinematic knee-length cape: follows the anchor's recent path, flares with speed. */
  private updateCape(dt: number, p: GiantPose) {
    this.tierFlare = Math.max(0, this.tierFlare - dt / 0.6);
    const left = this.capeAnchor(1);
    const right = this.capeAnchor(-1);
    const anchor = left.clone().add(right).multiplyScalar(0.5);
    const hist = this.capeHistory;
    const lastH = hist[hist.length - 1];
    if (!lastH || lastH.distanceToSquared(anchor) > 0.0025) hist.push(anchor.clone());
    if (hist.length > 60) hist.shift();
    // Teleports (new run, knock-back) break the path: start it again.
    if (lastH && lastH.distanceToSquared(anchor) > 25) {
      hist.length = 0;
      hist.push(anchor.clone());
    }

    const segLen = CAPE_LEN / CAPE_SEGS;
    const speedK = Math.min(1, p.speed / 15);
    const droop = (1 - speedK) * 1.1 + 0.45 - this.tierFlare * 0.3;
    const horiz = Math.cos(droop);
    const vert = Math.sin(droop);
    const back = new THREE.Vector3(-Math.cos(p.travel), 0, -Math.sin(p.travel));
    let walked = 0;
    let h = hist.length - 1;
    let from = anchor.clone();
    for (let i = 0; i <= CAPE_SEGS; i++) {
      const want = i * segLen * horiz;
      while (walked < want && h > 0) {
        const step = from.distanceTo(hist[h - 1]);
        if (walked + step >= want) {
          from = from.clone().lerp(hist[h - 1], (want - walked) / Math.max(step, 1e-6));
          walked = want;
          break;
        }
        walked += step;
        from = hist[h - 1].clone();
        h--;
      }
      const pt = this.capePts[i];
      pt.copy(from);
      if (walked < want) pt.addScaledVector(back, want - walked);
      const flutter = i === 0 ? 0 : Math.sin(this.time * (5 + p.speed * 0.8) + i * 1.1) * 0.05 * i * (0.3 + speedK);
      pt.y = Math.max(0.6, anchor.y - i * segLen * vert + flutter);
    }
    const pos = this.capeGeo.getAttribute('position') as THREE.BufferAttribute;
    const side = right.clone().sub(left).setY(0).normalize();
    for (let i = 0; i <= CAPE_SEGS; i++) {
      const c = this.capePts[i];
      const w = 0.42 + (i / CAPE_SEGS) * 0.12; // narrow: the legs must read past it (v0.3)
      const tatter = i === CAPE_SEGS ? Math.sin(this.time * 11) * 0.1 : 0;
      pos.setXYZ(i * 2, c.x - side.x * w, c.y + tatter, c.z - side.z * w);
      pos.setXYZ(i * 2 + 1, c.x + side.x * w, c.y - tatter, c.z + side.z * w);
    }
    pos.needsUpdate = true;
    this.capeGeo.computeVertexNormals();
    this.capeGeo.computeBoundingSphere();
  }
}
