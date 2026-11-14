import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GaitFrame, Vec3 } from '../anim/gait';
import { TUNING } from '../tuning';
import { PALETTE } from './palette';
import { rimToonMap } from './toon';

/**
 * The Meshy giant (Mike's character sheet → image edit without the cape → image-to-3D →
 * rigging). A presentation skin over the greybox rig: GiantView still computes every pose
 * (gait IK legs, lean, twist, arm pump, flex, steady head); this only aims the skinned bones
 * along it each frame, so feel and the pinned feet are untouched. Meshy's own run clip is
 * not used. Until (or unless) it loads, the greybox shows.
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
    const mid = wp(b('LeftUpLeg')).add(wp(b('RightUpLeg'))).multiplyScalar(0.5);
    this.hipsOffset.copy(wp(b('Hips'))).sub(mid);

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

  /** Greybox pose relative to the root, applied to a bone's rest world rotation. */
  private follow(bone: THREE.Bone, obj: THREE.Object3D, rootInv: THREE.Quaternion, rootQ: THREE.Quaternion, amount = 1) {
    const rel = obj.getWorldQuaternion(new THREE.Quaternion()).premultiply(rootInv);
    if (amount < 1) rel.slerp(new THREE.Quaternion(), 1 - amount);
    this.setWorld(bone, rel.premultiply(rootQ).multiply(this.rest.get(bone)!.world));
  }

  update(g: GreyboxPose) {
    if (!this.loaded) return;
    const b = (n: string) => this.bones.get(n)!;
    const rootQ = g.root.getWorldQuaternion(new THREE.Quaternion());
    const rootInv = rootQ.clone().invert();
    const right = new THREE.Vector3(0, 0, 1).applyQuaternion(rootQ);
    this.group.position.copy(g.root.getWorldPosition(new THREE.Vector3()));
    this.group.quaternion.copy(rootQ).multiply(this.face);
    this.group.updateMatrixWorld(true);

    // Hips: at the gait's hip midpoint, turned like the greybox pelvis.
    const L = g.gait.legs;
    const mid = v(L[0].hip).add(v(L[1].hip, this.p[0])).multiplyScalar(0.5);
    const hipsRel = g.hips.getWorldQuaternion(new THREE.Quaternion()).premultiply(rootInv);
    const hips = b('Hips');
    hips.position.copy(hips.parent!.worldToLocal(mid.clone().add(this.hipsOffset.clone().applyQuaternion(rootQ).applyQuaternion(hipsRel))));
    this.follow(hips, g.hips, rootInv, rootQ);
    // Spine: the torso's lean, bank and twist, spread up the back; head steady like the greybox.
    this.follow(b('Spine'), g.torso, rootInv, rootQ, 0.5);
    this.follow(b('Spine01'), g.torso, rootInv, rootQ, 0.8);
    this.follow(b('Spine02'), g.torso, rootInv, rootQ);
    this.follow(b('Head'), g.head, rootInv, rootQ);

    // Legs along the gait IK: thigh to the knee, shin to the foot, foot flat (toes down in swing).
    for (const c of this.legs) {
      const gi = Math.sign(this.p[1].copy(v(L[0].hip)).sub(this.group.position).dot(right)) === c.side ? 0 : 1;
      const leg = L[gi];
      this.aim(c.upper, v(leg.knee).sub(v(leg.hip, this.p[1])));
      this.aim(c.lower, v(leg.foot).sub(v(leg.knee, this.p[1])));
      const pitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -g.footPitch[gi]);
      this.setWorld(c.end, pitch.premultiply(rootQ).multiply(this.rest.get(c.end)!.world));
    }
    // Arms along the greybox arm: upper arm to the elbow, forearm to the fist.
    for (const c of this.arms) {
      const a = g.arms.find((x) => x.side === c.side);
      if (!a) continue;
      const sh = a.shoulder.getWorldPosition(new THREE.Vector3());
      const el = a.elbow.getWorldPosition(new THREE.Vector3());
      const fist = a.elbow.localToWorld(new THREE.Vector3(0, -0.7, 0));
      this.aim(c.upper, el.clone().sub(sh));
      this.aim(c.lower, fist.sub(el));
    }
  }
}
