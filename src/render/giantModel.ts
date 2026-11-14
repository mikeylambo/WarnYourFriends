import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GaitFrame, Vec3 } from '../anim/gait';
import { TUNING } from '../tuning';
import { PALETTE } from './palette';
import { rimToonMap } from './toon';
import runClips from '../assets/giant/runs.json';

/**
 * The Meshy giant (Mike's character sheet → image edit without the cape → image-to-3D →
 * rigging). A presentation skin over the greybox rig: GiantView still computes every pose
 * (gait IK, hip height and bound, steady head, flex); the model plays an authored Meshy run clip
 * per tier (Jog "Run 2", Stride "Lean Forward Sprint", Rampage "Male Head-down Charge"),
 * crossfaded on tier changes and time-locked to the stride. Feet: while the gait has a foot
 * planted, that leg blends into IK onto the gait's plant spot, so nothing slides; in swing the
 * clip's foot arc leads. The Pose, the Shoulder Check and Leap take the arms back to the
 * procedural pose. Until (or unless) it loads, the greybox shows.
 */

/** What the greybox pose gives this frame (world space). */
export interface GreyboxPose {
  root: THREE.Object3D;
  hips: THREE.Object3D;
  torso: THREE.Object3D;
  head: THREE.Object3D;
  /** Greybox arms by side (+1 = his right, the torso's +Z): shoulder group, elbow group, fist offset. */
  arms: { side: number; shoulder: THREE.Object3D; elbow: THREE.Object3D }[];
  gait: GaitFrame;
  /** Foot pitch per gait leg (rad): toes down while swinging. */
  footPitch: [number, number];
  /** Continuous step position (two steps = one clip cycle) and tier. */
  stepPos: number;
  tier: number;
  /** The greybox torso's forward lean and bank (rad), without its stride twist (the clip has its own sway). */
  lean: number;
  bank: number;
  /** Frame time (s), for the crossfades and plant blends. */
  dt: number;
  /** Pose, Shoulder Check or Leap: arms follow the procedural pose instead of the clip. */
  armsProcedural: boolean;
}

interface Chain {
  side: number;
  upper: THREE.Bone;
  lower: THREE.Bone;
  end: THREE.Bone;
}

const v = (p: Vec3, out = new THREE.Vector3()) => out.set(p.x, p.y, p.z);

export class GiantModel {
  /** Added to the scene by GiantView; empty until the model loads. */
  readonly group = new THREE.Group();
  loaded = false;
  private bones = new Map<string, THREE.Bone>();
  private rest = new Map<THREE.Bone, { local: THREE.Quaternion; world: THREE.Quaternion; dir: THREE.Vector3 }>();
  private legs: Chain[] = [];
  private arms: Chain[] = [];
  /** Hips bone relative to the leg roots' midpoint, in the rest frame (scaled). */
  private hipsOffset = new THREE.Vector3();
  private scale = 1;
  /** Mesh-local units per world metre (for the outline push). */
  unitsPerMetre = 1;
  /** Turns the model (built facing +Z) to face the greybox's +X. */
  private readonly face = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  private q = [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()];
  private mixer: THREE.AnimationMixer | null = null;
  /** One run clip per tier: its action, length, and the clip time at which its left foot is down. */
  private runs: { action: THREE.AnimationAction; len: number; leftPlant: number; weight: number }[] = [];
  /** Per model leg (Left, Right): how far the leg is blended onto the gait's planted foot. */
  private plantW = [0, 0];
  private gaitLeftPhase = 0;
  private leftWasPlanted = false;
  private armBlend = 0;
  /** Thigh and shin lengths in the world (scaled), for the leg IK. */
  private segLen = new Map<THREE.Bone, number>();
  private p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

  load(url: string, onReady: () => void) {
    new GLTFLoader().load(
      url,
      (gltf) => {
        try {
          this.build(gltf.scene);
          this.loaded = true;
          onReady();
        } catch (e) {
          console.warn('Giant model rejected, keeping the greybox:', e);
        }
      },
      undefined,
      (e) => console.warn('Giant model failed to load, keeping the greybox:', e),
    );
  }

  private build(scene: THREE.Object3D) {
    const M = TUNING.giantModel;
    scene.traverse((o) => {
      if ((o as THREE.Bone).isBone) this.bones.set(o.name, o as THREE.Bone);
    });
    const b = (name: string) => {
      const bone = this.bones.get(name);
      if (!bone) throw new Error(`missing bone ${name}`);
      return bone;
    };
    // Rest frame: the model faces +X at the origin, unscaled, so the leg length can be measured.
    this.group.add(scene);
    this.group.quaternion.copy(this.face);
    this.group.updateMatrixWorld(true);
    const wp = (bone: THREE.Bone) => bone.getWorldPosition(new THREE.Vector3());
    const legLen = wp(b('LeftUpLeg')).distanceTo(wp(b('LeftLeg'))) + wp(b('LeftLeg')).distanceTo(wp(b('LeftFoot')));
    // Same leg length as the gait's IK, so planted feet land exactly where the gait put them.
    this.scale = (TUNING.gait.thigh + TUNING.gait.shin) / legLen;
    this.group.scale.setScalar(this.scale);
    this.group.updateMatrixWorld(true);

    for (const bone of this.bones.values()) {
      const child = bone.children.find((c) => (c as THREE.Bone).isBone);
      this.rest.set(bone, {
        local: bone.quaternion.clone(),
        world: bone.getWorldQuaternion(new THREE.Quaternion()),
        dir: child ? child.position.clone().normalize() : new THREE.Vector3(0, 1, 0),
      });
    }
    // Sides from the rest pose: +Z is his right when he faces +X.
    const sideOf = (bone: THREE.Bone) => Math.sign(wp(bone).z) || 1;
    for (const s of ['Left', 'Right']) {
      this.legs.push({ side: sideOf(b(`${s}UpLeg`)), upper: b(`${s}UpLeg`), lower: b(`${s}Leg`), end: b(`${s}Foot`) });
      this.arms.push({ side: sideOf(b(`${s}Arm`)), upper: b(`${s}Arm`), lower: b(`${s}ForeArm`), end: b(`${s}Hand`) });
    }
    for (const s of ['Left', 'Right']) {
      this.segLen.set(b(`${s}UpLeg`), wp(b(`${s}UpLeg`)).distanceTo(wp(b(`${s}Leg`))));
      this.segLen.set(b(`${s}Leg`), wp(b(`${s}Leg`)).distanceTo(wp(b(`${s}Foot`))));
    }
    const mid = wp(b('LeftUpLeg')).add(wp(b('RightUpLeg'))).multiplyScalar(0.5);
    this.hipsOffset.copy(wp(b('Hips'))).sub(mid);

    // Authored run clips (rotations only), one per tier: find each one's left plant (lowest left foot)
    // so it can be locked to the gait.
    this.mixer = new THREE.AnimationMixer(scene);
    const clipJson = runClips as unknown as Record<string, THREE.AnimationClipJSON>;
    for (const key of ['jog', 'stride', 'rampage']) {
      const clip = THREE.AnimationClip.parse(clipJson[key]);
      const action = this.mixer.clipAction(clip);
      action.play();
      this.runs.push({ action, len: clip.duration, leftPlant: 0, weight: 0 });
    }
    for (const run of this.runs) {
      for (const r of this.runs) r.action.setEffectiveWeight(r === run ? 1 : 0);
      let low = Infinity;
      for (let i = 0; i < 48; i++) {
        const t = (run.len * i) / 48;
        run.action.time = t;
        this.mixer.update(0);
        scene.updateMatrixWorld(true);
        const y = wp(b('LeftFoot')).y;
        if (y < low) {
          low = y;
          run.leftPlant = t;
        }
      }
    }
    for (const [bone, r] of this.rest) bone.quaternion.copy(r.local);
    scene.updateMatrixWorld(true);

    // Toon shading over the Meshy texture, the night rim, and an ink hull that follows the skin.
    const meshes: THREE.SkinnedMesh[] = [];
    scene.traverse((o) => (o as THREE.SkinnedMesh).isSkinnedMesh && meshes.push(o as THREE.SkinnedMesh));
    for (const mesh of meshes) {
      const src = mesh.material as THREE.MeshStandardMaterial;
      if (src.map) src.map.colorSpace = THREE.SRGBColorSpace;
      const mat = src.map ? rimToonMap(src.map) : new THREE.MeshToonMaterial({ color: PALETTE.giantBody });
      mat.color.setScalar(M.tint); // §23: the giant stays the darkest thing on screen
      mesh.material = mat;
      mesh.frustumCulled = false;
      const ink = new THREE.MeshBasicMaterial({ color: PALETTE.giantOutline, side: THREE.BackSide });
      // The skinned vertices live in the mesh's own units (Meshy's armature may scale them), so size
      // the push from the measured local → world ratio, not the group scale alone.
      // Units per metre in skinning space: the thigh's length there (from the bind pose) over its
      // length in the world (the rest frame, scaled to the gait).
      const sk = mesh.skeleton;
      const bindPos = (bone: THREE.Bone) => {
        const i = sk.bones.indexOf(bone);
        return new THREE.Vector3().setFromMatrixPosition(mesh.bindMatrixInverse.clone().multiply(sk.boneInverses[i].clone().invert()));
      };
      const bindLen = bindPos(b('LeftUpLeg')).distanceTo(bindPos(b('LeftLeg')));
      const worldThigh = wp(b('LeftUpLeg')).distanceTo(wp(b('LeftLeg')));
      this.unitsPerMetre = bindLen / Math.max(worldThigh, 1e-6);
      const width = M.outline * this.unitsPerMetre;
      ink.onBeforeCompile = (sh) => {
        sh.vertexShader = sh.vertexShader.replace('#include <skinning_vertex>', `#include <skinning_vertex>\ntransformed += normalize(objectNormal) * ${width.toFixed(4)};`);
      };
      const hull = new THREE.SkinnedMesh(mesh.geometry, ink);
      hull.bind(mesh.skeleton, mesh.bindMatrix);
      hull.frustumCulled = false;
      mesh.parent!.add(hull);
    }
  }

  /** Set a bone's world rotation (parents already posed). */
  private setWorld(bone: THREE.Bone, world: THREE.Quaternion) {
    const parent = bone.parent!.getWorldQuaternion(this.q[3]);
    bone.quaternion.copy(parent.invert().multiply(world));
    bone.updateMatrixWorld(true);
  }

  /** Rotate a bone from its rest (relative to its posed parent) so its child points along `dir` (world). */
  private aim(bone: THREE.Bone, dir: THREE.Vector3) {
    const r = this.rest.get(bone)!;
    const parent = bone.parent!.getWorldQuaternion(this.q[2]);
    const restWorld = this.q[1].copy(parent).multiply(r.local);
    const cur = this.p[3].copy(r.dir).applyQuaternion(restWorld);
    const delta = this.q[0].setFromUnitVectors(cur, this.p[2].copy(dir).normalize());
    this.setWorld(bone, delta.multiply(restWorld));
  }

  update(g: GreyboxPose) {
    if (!this.loaded) return;
    const b = (n: string) => this.bones.get(n)!;
    const rootQ = g.root.getWorldQuaternion(new THREE.Quaternion());
    const right = new THREE.Vector3(0, 0, 1).applyQuaternion(rootQ);
    this.group.position.copy(g.root.getWorldPosition(new THREE.Vector3()));
    this.group.quaternion.copy(rootQ).multiply(this.face);
    this.group.updateMatrixWorld(true);

    const L = g.gait.legs;
    const M = TUNING.giantModel;
    // Lock the clips to the stride: the gait's left plant lines up with each clip's.
    const leftIdx = Math.sign(this.p[1].copy(v(L[0].hip)).sub(this.group.position).dot(right)) < 0 ? 0 : 1;
    const leftPlanted = L[leftIdx].planted;
    if (leftPlanted && !this.leftWasPlanted) this.gaitLeftPhase = ((g.stepPos % 2) + 2) % 2;
    this.leftWasPlanted = leftPlanted;
    const phase = ((((g.stepPos - this.gaitLeftPhase) % 2) + 2) % 2) / 2;
    const fade = Math.min(1, g.dt / M.clipFade);
    this.runs.forEach((r, i) => {
      r.weight += ((i === g.tier ? 1 : 0) - r.weight) * fade;
      r.action.setEffectiveWeight(r.weight);
      r.action.time = (r.leftPlant + phase * r.len) % r.len;
    });
    this.mixer!.update(0);
    this.armBlend += ((g.armsProcedural ? 1 : 0) - this.armBlend) * 0.25;

    // Hips: at the gait's hip height (bound, plant drop), turned by the clip, banked into lane changes.
    const mid = v(L[0].hip).add(v(L[1].hip, this.p[0])).multiplyScalar(0.5);
    mid.y += M.hipRaise;
    const hips = b('Hips');
    hips.position.copy(hips.parent!.worldToLocal(mid.clone().add(this.hipsOffset.clone().applyQuaternion(rootQ))));
    hips.updateMatrixWorld(true);
    const bank = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0).applyQuaternion(rootQ), g.bank);
    this.setWorld(hips, hips.getWorldQuaternion(new THREE.Quaternion()).premultiply(bank));

    // Legs: two-bone IK from his hip to a foot target. Planted (by the gait), the target is the gait's
    // plant spot and the foot lies flat, so nothing slides; in swing it's the clip's own foot arc.
    // Knees bend the way the clip bends them.
    const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(rootQ);
    const plantFade = Math.min(1, g.dt / M.plantBlend);
    this.legs.forEach((c, li) => {
      const gi = Math.sign(this.p[1].copy(v(L[0].hip)).sub(this.group.position).dot(right)) === c.side ? 0 : 1;
      const leg = L[gi];
      this.plantW[li] += ((leg.planted ? 1 : 0) - this.plantW[li]) * plantFade;
      const w = this.plantW[li];
      const hip = c.upper.getWorldPosition(new THREE.Vector3());
      const clipKnee = c.lower.getWorldPosition(new THREE.Vector3());
      const clipFoot = c.end.getWorldPosition(new THREE.Vector3());
      clipFoot.y = Math.max(clipFoot.y, M.ankleHeight);
      const clipFootQ = c.end.getWorldQuaternion(new THREE.Quaternion());
      const target = clipFoot.lerp(v(leg.foot).setY(Math.max(leg.foot.y, M.ankleHeight)), w);
      const a = this.segLen.get(c.upper)!, bl = this.segLen.get(c.lower)!;
      const toFoot = target.clone().sub(hip);
      const d = Math.min(toFoot.length(), (a + bl) * 0.999);
      const u = toFoot.normalize();
      const cosA = (a * a + d * d - bl * bl) / (2 * a * d);
      const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
      const pole = clipKnee.sub(hip).lerp(fwd, 0.3);
      const n = pole.addScaledVector(u, -pole.dot(u)).normalize();
      const knee = hip.clone().addScaledVector(u, a * cosA).addScaledVector(n, a * sinA);
      this.aim(c.upper, knee.clone().sub(hip));
      this.aim(c.lower, hip.addScaledVector(u, d).sub(knee));
      const flat = new THREE.Quaternion().copy(rootQ).multiply(this.rest.get(c.end)!.world);
      this.setWorld(c.end, clipFootQ.slerp(flat, w));
    });
    // Pose / Shoulder Check / Leap: arms along the greybox arm (upper arm to the elbow, forearm to the fist).
    if (this.armBlend < 0.02) return;
    for (const c of this.arms) {
      const a = g.arms.find((x) => x.side === c.side);
      if (!a) continue;
      const sh = a.shoulder.getWorldPosition(new THREE.Vector3());
      const el = a.elbow.getWorldPosition(new THREE.Vector3());
      const fist = a.elbow.localToWorld(new THREE.Vector3(0, -0.7, 0));
      const clipUpper = c.upper.quaternion.clone();
      this.aim(c.upper, el.clone().sub(sh));
      c.upper.quaternion.copy(clipUpper.slerp(c.upper.quaternion, this.armBlend));
      c.upper.updateMatrixWorld(true);
      const clipLower = c.lower.quaternion.clone();
      this.aim(c.lower, fist.sub(el));
      c.lower.quaternion.copy(clipLower.slerp(c.lower.quaternion, this.armBlend));
      c.lower.updateMatrixWorld(true);
    }
  }
}
