import * as THREE from 'three';
import { TUNING } from '../tuning';
import type { GaitFrame, Vec3 } from '../anim/gait';
import { PALETTE } from './palette';
import { blobTexture, rimToon } from './toon';

/**
 * Greybox giant (Phase 0b). A placeholder that swaps without touching logic
 * (§23): it reads the sim pose and the gait frame and draws; nothing writes back.
 *
 * Identity (Mike's sheet, model pass): armored warlord in plum with cream bone
 * plates, ONE horned pauldron, the cape clasped under it and slung across the
 * back, braided white topknot, wrapped forearms. The cape is knee length (v0.3):
 * it hangs heavy at Jog and snaps out almost horizontal at Rampage.
 *
 * v0.3 run: legs are drawn from the gait's IK (hip → knee → planted foot), so a
 * planted foot never slides. Low, forward-driving posture, arms trailing, head
 * steady. The torso model faces +X; the root is yawed to the heading.
 */

const CAPE_SEGS = 8;
/** The pauldron (and the clasp under it) sits on the torso's +Z shoulder. */
const PAULDRON_SIDE = 1;
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
  /** Phase 3: height off the road (Leap arc, riding a hijacked car's roof). */
  lift?: number;
  /** Leap progress 0..1 while airborne (0 on the ground): legs tuck, the shadow shrinks. */
  leap?: number;
  /** Phase 3: Pose for the Camera, 0..1 (arms up, chest out, facing the chopper). */
  pose?: number;
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
  private elbowL = new THREE.Group();
  private elbowR = new THREE.Group();
  private braid: THREE.Mesh[] = [];
  private shadow: THREE.Mesh;
  private legs = new THREE.Group();
  private legParts: { thigh: THREE.Mesh; shin: THREE.Mesh; knee: THREE.Mesh; boot: THREE.Mesh }[] = [];

  private cape: THREE.Mesh;
  private capePts: THREE.Vector3[] = [];
  private capeGeo: THREE.BufferGeometry;
  private capeAngle = 0;
  private capePhase = 0;

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
    // Cream bone plates on plum: breastplate and a backplate the cape swings clear of.
    const plate = box(0.2, 0.8, 1.0, PALETTE.giantBone);
    plate.position.set(0.48, 0.8, 0);
    const back = box(0.14, 0.7, 0.8, PALETTE.giantBone);
    back.position.set(-0.5, 0.85, 0);
    const belt = box(1.0, 0.18, 1.4, PALETTE.giantBone);
    belt.position.y = 0.12;
    this.torso.add(chest, plate, back, belt);

    // ONE horned pauldron (the top-down silhouette): a big plate over a lame, two horns sweeping back.
    const S = PAULDRON_SIDE;
    const pauldron = box(1.15, 0.44, 0.8, PALETTE.giantBone);
    pauldron.position.set(0, 1.46, S * 0.82);
    pauldron.rotation.x = S * 0.28;
    const lame = box(0.9, 0.2, 0.62, PALETTE.giantBone);
    lame.position.set(0, 1.18, S * 0.98);
    lame.rotation.x = S * 0.42;
    const horn = new THREE.Mesh(new THREE.ConeGeometry(0.2, 1.1, 6), rimToon(PALETTE.giantBone));
    horn.position.set(0.05, 1.98, S * 1.12);
    horn.rotation.set(S * -0.7, 0, -0.45);
    const horn2 = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.62, 6), rimToon(PALETTE.giantBone));
    horn2.position.set(-0.38, 1.82, S * 1.05);
    horn2.rotation.set(S * -0.55, 0, 0.6);
    // The bare shoulder carries only the cape strap.
    const pad = box(0.62, 0.16, 0.36, PALETTE.giantArmor);
    pad.position.set(0, 1.36, -S * 0.72);
    // Strap across the chest from the far shoulder down to the clasp under the pauldron.
    const strap = box(0.08, 1.15, 0.16, PALETTE.giantArmor);
    strap.position.set(0.6, 1.05, -S * 0.08);
    strap.rotation.x = S * -0.95;
    const clasp = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.09, 10), rimToon(PALETTE.giantClasp));
    clasp.rotation.z = Math.PI / 2;
    clasp.position.set(0.62, 0.86, S * 0.5);
    this.torso.add(pauldron, lame, horn, horn2, pad, strap, clasp);

    // Arms: shoulder + elbow, so the run can hold a bent-arm guard (fists forward at the chest).
    for (const [arm, elbow, z] of [[this.armL, this.elbowL, 0.86], [this.armR, this.elbowR, -0.86]] as const) {
      arm.position.set(0, 1.25, z);
      const upper = box(0.34, 0.85, 0.34, PALETTE.giantBody);
      upper.position.y = -0.42;
      elbow.position.y = -0.85;
      const fore = box(0.3, 0.75, 0.3, PALETTE.giantSkin);
      fore.position.y = -0.25;
      const band1 = box(0.33, 0.1, 0.33, PALETTE.giantBand);
      band1.position.y = -0.1;
      const band2 = band1.clone();
      band2.position.y = -0.35;
      const fist = box(0.34, 0.3, 0.34, PALETTE.giantSkin);
      fist.position.y = -0.7;
      elbow.add(fore, band1, band2, fist);
      arm.add(upper, elbow);
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
      const b = box(0.15 - i * 0.015, 0.15 - i * 0.015, 0.15 - i * 0.015, PALETTE.giantHair);
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

    // Cape: knee length, clasped under the pauldron.
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
    this.capeAngle = 0;
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

  /** A leg pulled up under the hip (knee forward and up, foot under the seat) by `t` (0..1). */
  private tucked(L: GaitFrame['legs'][number], t: number): GaitFrame['legs'][number] {
    const mix = (a: number, b: number) => a + (b - a) * t;
    const fx = L.hip.x + (L.knee.x - L.hip.x) * 0.2, fz = L.hip.z + (L.knee.z - L.hip.z) * 0.2;
    return {
      ...L,
      knee: { x: mix(L.knee.x, L.hip.x + (L.knee.x - L.hip.x) * 1.4), y: mix(L.knee.y, L.hip.y - 0.35), z: mix(L.knee.z, L.knee.z) },
      foot: { x: mix(L.foot.x, fx), y: mix(L.foot.y, L.hip.y - 0.9), z: mix(L.foot.z, fz) },
      planted: false,
    };
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

    const lift = p.lift ?? 0;
    this.root.position.set(p.x, lift, p.z);
    this.legs.position.y = lift;
    this.root.rotation.y = -p.heading;
    this.hips.position.y = gait.hipY;
    this.shadow.position.set(p.x + 0.4, 0.07, p.z + 0.4);
    // Off the ground (Leap): the shadow shrinks and fades, so height reads from straight above.
    const air = p.leap ? Math.min(1, lift / 4) : 0;
    this.shadow.scale.setScalar(3.2 * (1 - 0.45 * air)).setY(1);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = 1 - 0.5 * air;

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

    // Big, exaggerated arm pump opposite the legs (Mike's call): the lead fist drives forward and
    // up, the other arm drives back. Snapped so it holds the strong poses. Angles are against the
    // world (the lean is compensated), so "forward" stays forward however low he leans.
    const raw = Math.sin(ph);
    const pump = Math.sign(raw) * Math.pow(Math.abs(raw), TUNING.gait.poseSnap) * T.armSwing;
    const lean = this.lean;
    const aL = T.armBase - pump;
    const aR = T.armBase + pump;
    this.armL.rotation.set(0.18, 0, aL + lean);
    this.armR.rotation.set(-0.18, 0, aR + lean);
    // The arm driving forward folds (fist up near the chin); the arm swinging back straightens.
    this.elbowL.rotation.set(0, 0, T.elbowBend * 0.5 + Math.max(0, aL) * 0.65);
    this.elbowR.rotation.set(0, 0, T.elbowBend * 0.5 + Math.max(0, aR) * 0.65);
    const po = p.pose ?? 0;
    if (po > 0) {
      // Double flex for the chopper: upper arms out and up, forearms folded to the head.
      this.armL.rotation.set(1.5 * po, 0, 0.25 * po);
      this.armR.rotation.set(-1.5 * po, 0, 0.25 * po);
      this.elbowL.rotation.set(0, 0, 1.9 * po);
      this.elbowR.rotation.set(0, 0, 1.9 * po);
      this.torso.rotation.z += this.lean * po * 0.8; // stand up for it
    }
    if (sh > 0) {
      this.armL.rotation.set(0.6 * sh, 0, 0.9 * sh);
      this.elbowL.rotation.set(0, 0, 0.3 * (1 - sh));
    }

    this.root.updateMatrixWorld(true);

    // Legs from the gait IK (world space). In the air (Leap) the feet tuck up under him.
    const tuck = p.leap ? Math.min(1, Math.sin(Math.PI * p.leap) * 1.6) : 0;
    for (let i = 0; i < 2; i++) {
      const G = gait.legs[i];
      const L = tuck > 0 ? this.tucked(G, tuck) : G;
      const P = this.legParts[i];
      this.placeSegment(P.thigh, L.hip, L.knee);
      this.placeSegment(P.shin, L.knee, L.foot);
      P.knee.position.set(L.knee.x, L.knee.y, L.knee.z);
      P.knee.rotation.set(0, -p.heading, 0);
      P.boot.position.set(L.foot.x + Math.cos(p.heading) * 0.12, Math.max(0.16, L.foot.y + 0.06), L.foot.z + Math.sin(p.heading) * 0.12);
      P.boot.rotation.set(0, -p.heading, L.planted ? 0 : 0.35);
    }

    // Braid: a chain from the topknot. Each link chases its rest spot behind the one before,
    // then is pulled back to a fixed link length, so it trails without ever coming apart.
    const M = TUNING.giantModel;
    const knotWorld = this.head.localToWorld(new THREE.Vector3(-0.15, 0.72, 0));
    let prev = knotWorld;
    const back = new THREE.Vector3(-Math.cos(p.travel), 0, -Math.sin(p.travel));
    const hang = 1 - Math.min(1, p.speed / 15);
    this.braid.forEach((b, i) => {
      const rest = prev.clone().addScaledVector(back, M.braidLink * (1 - hang * 0.6)).add(new THREE.Vector3(0, -M.braidLink * (0.45 + hang * 0.9), 0));
      if (b.position.distanceToSquared(rest) > 4) b.position.copy(rest);
      b.position.lerp(rest, k(M.braidFollow * (1 + i * 0.4)));
      const off = this.tmp.subVectors(b.position, prev);
      b.position.copy(prev).addScaledVector(off.normalize(), M.braidLink);
      prev = b.position;
    });

    this.updateCape(dt, p);
  }

  /** Cape top corners: the clasp side sits low under the pauldron, the far side over the bare shoulder. */
  private capeAnchor(clasp: boolean): THREE.Vector3 {
    const S = PAULDRON_SIDE;
    return this.torso.localToWorld(clasp ? new THREE.Vector3(-0.66, 1.2, S * 0.62) : new THREE.Vector3(-0.66, 1.4, -S * 0.6));
  }

  /**
   * Kinematic cape. The angle from hanging straight down is per tier (tuning): heavy at
   * Jog, out behind at Stride, almost horizontal at Rampage. A wave runs down it, sharper
   * per tier so Rampage snaps; it swings out opposite a lane change and flares on a tier-up.
   */
  private updateCape(dt: number, p: GiantPose) {
    const M = TUNING.giantModel;
    const T = TUNING.tiers[p.tier];
    this.tierFlare = Math.max(0, this.tierFlare - dt / 0.6);
    const k = 1 - Math.exp(-dt / M.capeAngleTime);
    // Slow below the tier's top speed eases it toward hanging (a brake drops it).
    const speedK = Math.min(1, p.speed / T.topSpeed);
    const want = (T.capeAngle * speedK + M.capeTierFlare * this.tierFlare) * (Math.PI / 180);
    this.capeAngle += (want - this.capeAngle) * k;
    this.capePhase += dt * T.capeFlutterHz * Math.PI * 2;

    const a = this.capeAnchor(true);
    const b = this.capeAnchor(false);
    const top = a.clone().add(b).multiplyScalar(0.5);
    const halfTop = a.clone().sub(b).multiplyScalar(0.5);
    const side = halfTop.clone().setY(0).normalize();
    const back = new THREE.Vector3(-Math.cos(p.travel), 0, -Math.sin(p.travel));
    const segLen = M.capeLength / CAPE_SEGS;
    const snap = M.capeSnapPow[p.tier];
    const pos = this.capeGeo.getAttribute('position') as THREE.BufferAttribute;
    const c = this.tmp.copy(top);
    for (let i = 0; i <= CAPE_SEGS; i++) {
      const f = i / CAPE_SEGS;
      if (i > 0) {
        // The hem rides a little flatter than the top: the cloth bellies out behind him.
        // The top rows drape over his leaning back (never inside it), then the cloth takes its own angle.
        const drape = (this.lean + M.capeBackClear) * Math.max(0, 1 - f / M.capeDrapeShare);
        const th = Math.min(1.5, Math.max(drape, this.capeAngle * (0.85 + 0.3 * f)));
        c.addScaledVector(back, Math.sin(th) * segLen);
        c.y -= Math.cos(th) * segLen;
        c.addScaledVector(side, -p.lateralVel * M.capeLateralLag * (segLen / M.capeLength));
      }
      const pt = this.capePts[i].copy(c);
      const w = Math.sin(this.capePhase - f * 4.2);
      const wave = Math.sign(w) * Math.pow(Math.abs(w), snap) * T.capeFlutterAmp * Math.pow(f, 1.4);
      // Flutter across the cloth (perpendicular to it, in the travel plane).
      const th = this.capeAngle;
      pt.addScaledVector(back, -Math.cos(th) * wave);
      pt.y += Math.sin(th) * wave;
      pt.y = Math.max(0.3, pt.y);
      // Top edge keeps the clasp's slant; lower rows level out and widen to the hem.
      const hw = M.capeHalfWidthTop + (M.capeHalfWidthHem - M.capeHalfWidthTop) * f;
      const slant = halfTop.y * (1 - f);
      const tatter = i === CAPE_SEGS ? Math.sin(this.capePhase * 1.7) * 0.06 * (0.5 + p.tier) : 0;
      pos.setXYZ(i * 2, pt.x + side.x * hw, pt.y + slant + tatter, pt.z + side.z * hw);
      pos.setXYZ(i * 2 + 1, pt.x - side.x * hw, pt.y - slant - tatter, pt.z - side.z * hw);
    }
    pos.needsUpdate = true;
    this.capeGeo.computeVertexNormals();
    this.capeGeo.computeBoundingSphere();
  }
}
