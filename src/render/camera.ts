import * as THREE from 'three';
import { TUNING } from '../tuning';
import { approach } from '../sim/math';

/**
 * §15 oblique news-chopper camera (rev 2026-11-10).
 *
 * High, angled and offset to one side, looking down the street ahead. It frames
 * a point `speed × lookAheadTime` in front of the giant (capped so the giant
 * stays in the lower third), sits `sideAngleDeg` off the heading, and only
 * swaps sides after a sustained turn, slowly, like a pilot repositioning.
 * If a building blocks the line of sight to the giant, the camera climbs
 * rather than cutting through. Impact shake and the tier-up pull-out sit on top.
 */

export interface Occluder {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Top of the box (metres). */
  top: number;
}

export interface CameraFrameInfo {
  /** Giant's screen height position, 0 top .. 1 bottom. */
  giantScreenY: number;
  /** Road visible ahead of the giant along its travel, to the top edge of the frame (m). */
  aheadMetres: number;
  /** Same, in seconds at the current speed. */
  aheadSeconds: number;
  /** Look-ahead actually used (m), after the lower-third cap. */
  lookAhead: number;
  /** Current side, -1 .. 1 (+1: camera left of the path, looking right). */
  side: number;
  /** Current occlusion climb (m). */
  raise: number;
  /** Actual camera tilt below horizontal (deg), after lag and climb. */
  pitchDeg: number;
  /** Final camera position is inside a building (must never happen). */
  insideBuilding: boolean;
  /** A building blocks the final camera's view of the giant this frame (transient while climbing). */
  losBlocked: boolean;
}

const DEG = Math.PI / 180;
const smoothstep = (t: number) => t * t * (3 - 2 * t);

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  reducedMotion = false;
  readonly info: CameraFrameInfo = { giantScreenY: 0, aheadMetres: 0, aheadSeconds: 0, lookAhead: 0, side: 1, raise: 0, pitchDeg: 0, insideBuilding: false, losBlocked: false };

  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private distance: number = TUNING.tiers[0].cameraDistance;
  private distFrom: number = this.distance;
  private distTo: number = this.distance;
  private distT = 1;
  private pullOut = 0;

  private side = 1;
  private sideFrom = 1;
  private sideTo = 1;
  private sideT = 1;
  private turnDir = 0;
  private turnTime = 0;
  private turnGrace = 0;

  private raise = 0;
  private occluders: Occluder[] = [];
  /**
   * Look-ahead ceiling (m), corrected every frame from where the giant actually
   * lands on screen. A closed-form cap misses the position/look lag at speed,
   * so the framing is measured, not predicted.
   */
  private leadCap = Infinity;

  private shakes: { px: number; t: number; max: number }[] = [];
  private time = 0;
  private w = 1;
  private h = 1;

  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private ray = new THREE.Raycaster();
  private ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  constructor() {
    this.camera = new THREE.PerspectiveCamera(TUNING.camera.fov, 1, 1, 800);
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setOccluders(list: Occluder[]) {
    this.occluders = list;
  }

  setTier(tier: number) {
    const target = TUNING.tiers[tier].cameraDistance;
    if (target === this.distTo) return;
    this.distFrom = this.distance;
    this.distTo = target;
    this.distT = 0;
  }

  tierUpPulse() {
    this.pullOut = TUNING.camera.tierUpPullOut;
  }

  /** Screen jolt in CSS px (§10 impact scale, §15 heavy smash jolt). */
  jolt(px: number, time: number = TUNING.camera.joltTime) {
    if (this.reducedMotion || px <= 0) return;
    this.shakes.push({ px, t: 0, max: time });
  }

  /** Jump straight to the framing for this pose (run start). */
  snap(x: number, z: number, travel: number, speed: number, tier: number) {
    this.distance = this.distFrom = this.distTo = TUNING.tiers[tier].cameraDistance;
    this.distT = 1;
    this.side = this.sideFrom = this.sideTo = 1;
    this.sideT = 1;
    this.turnDir = this.turnTime = this.turnGrace = 0;
    this.raise = 0;
    this.pullOut = 0;
    this.leadCap = this.maxLookAhead(this.distance, 1);
    const d = this.desired(x, z, travel, speed);
    this.pos.copy(d.pos);
    this.look.copy(d.look);
  }

  /** Maximum look-ahead (m) that keeps the giant at or above giantMaxScreenY. */
  private maxLookAhead(dist: number, sideAbs: number): number {
    const C = TUNING.camera;
    const p = C.pitchDeg * DEG;
    const tanTheta = (2 * C.giantMaxScreenY - 1) * Math.tan((this.camera.fov * DEG) / 2);
    const along = (tanTheta * dist) / Math.max(0.05, Math.sin(p) - tanTheta * Math.cos(p));
    return along / Math.max(0.2, Math.cos(sideAbs * C.sideAngleDeg * DEG));
  }

  private desired(x: number, z: number, travel: number, speed: number) {
    const C = TUNING.camera;
    const dist = this.distance + this.pullOut;
    const lookAhead = Math.max(0, Math.min(speed * C.lookAheadTime, this.leadCap));
    const fx = Math.cos(travel);
    const fz = Math.sin(travel);
    const look = new THREE.Vector3(x + fx * lookAhead, 0, z + fz * lookAhead);
    const yaw = travel + this.side * C.sideAngleDeg * DEG;
    const p = C.pitchDeg * DEG;
    const back = dist * Math.cos(p);
    const pos = new THREE.Vector3(look.x - Math.cos(yaw) * back, dist * Math.sin(p), look.z - Math.sin(yaw) * back);
    return { pos, look, lookAhead };
  }

  /** Sustained turns (> sideSwitchAfter, one direction) swing the camera to the outside of the turn. */
  private updateSide(dt: number, angVel: number) {
    const C = TUNING.camera;
    if (Math.abs(angVel) > C.sideSwitchMinTurnDegPerSec * DEG) {
      const dir = Math.sign(angVel);
      if (dir === this.turnDir) this.turnTime += dt;
      else {
        this.turnDir = dir;
        this.turnTime = dt;
      }
      this.turnGrace = 0;
    } else {
      // Brief straightening inside a long turn doesn't reset it; a real straight does.
      this.turnGrace += dt;
      if (this.turnGrace > 0.3) {
        this.turnDir = 0;
        this.turnTime = 0;
      }
    }
    // Turning right (heading increasing) → sit on the left, looking across the turn.
    const want = this.turnDir;
    if (this.turnTime > C.sideSwitchAfter && want !== 0 && want !== this.sideTo) {
      this.sideFrom = this.side;
      this.sideTo = want;
      this.sideT = 0;
    }
    if (this.sideT < 1) {
      this.sideT = Math.min(1, this.sideT + dt / C.sideSwitchTime);
      this.side = this.sideFrom + (this.sideTo - this.sideFrom) * smoothstep(this.sideT);
    }
  }

  /** Does the segment a→b pass through any building? */
  private blocked(a: THREE.Vector3, b: THREE.Vector3): boolean {
    for (const o of this.occluders) {
      // Slab test on the 3D box [minX,maxX]×[0,top]×[minZ,maxZ].
      let t0 = 0;
      let t1 = 1;
      const d = [b.x - a.x, b.y - a.y, b.z - a.z];
      const s = [a.x, a.y, a.z];
      const lo = [o.minX, 0, o.minZ];
      const hi = [o.maxX, o.top, o.maxZ];
      let hit = true;
      for (let k = 0; k < 3; k++) {
        if (Math.abs(d[k]) < 1e-9) {
          if (s[k] < lo[k] || s[k] > hi[k]) {
            hit = false;
            break;
          }
        } else {
          let ta = (lo[k] - s[k]) / d[k];
          let tb = (hi[k] - s[k]) / d[k];
          if (ta > tb) [ta, tb] = [tb, ta];
          t0 = Math.max(t0, ta);
          t1 = Math.min(t1, tb);
          if (t0 > t1) {
            hit = false;
            break;
          }
        }
      }
      if (hit) return true;
    }
    return false;
  }

  update(dt: number, x: number, z: number, travel: number, speed: number, angVel: number) {
    const C = TUNING.camera;
    this.time += dt;
    if (this.camera.fov !== C.fov) {
      this.camera.fov = C.fov;
      this.camera.updateProjectionMatrix();
    }

    if (this.distT < 1) {
      this.distT = Math.min(1, this.distT + dt / C.distanceEase);
      this.distance = this.distFrom + (this.distTo - this.distFrom) * smoothstep(this.distT);
    }
    this.pullOut *= Math.exp(-dt / (C.tierUpPullOutTime / 3));
    this.updateSide(dt, angVel);

    const d = this.desired(x, z, travel, speed);
    this.pos.lerp(d.pos, approach(dt, C.positionLag));
    this.look.lerp(d.look, approach(dt, C.lookLag));

    // Line of sight to the giant: climb until clear, never cut through.
    const head = this.tmpA.set(x, 2.6, z);
    let need = 0;
    if (this.occluders.length) {
      const eye = this.tmpB;
      while (need <= C.occlusionMaxRaise) {
        eye.set(this.pos.x, this.pos.y + need, this.pos.z);
        if (!this.blocked(eye, head)) break;
        need += C.occlusionRaiseStep;
      }
    }
    this.raise += (need - this.raise) * approach(dt, need > this.raise ? C.occlusionRaiseLag : C.occlusionLowerLag);

    const cam = this.camera;
    cam.position.set(this.pos.x, this.pos.y + this.raise, this.pos.z);
    cam.lookAt(this.look);
    if (!this.reducedMotion) {
      const w = C.wobbleDeg * DEG;
      const ph = this.time * Math.PI * 2 * C.wobbleHz;
      cam.rotateX(Math.sin(ph) * w);
      cam.rotateY(Math.sin(ph * 0.73 + 1.3) * w);
      cam.rotateZ(Math.sin(ph * 0.51 + 2.1) * w * 0.6);
    }
    cam.updateMatrixWorld();

    // Pixel shake on top (§10).
    let ox = 0;
    let oy = 0;
    for (let i = this.shakes.length - 1; i >= 0; i--) {
      const s = this.shakes[i];
      s.t += dt;
      if (s.t >= s.max) {
        this.shakes.splice(i, 1);
        continue;
      }
      const k = 1 - s.t / s.max;
      ox += (Math.random() * 2 - 1) * s.px * k;
      oy += (Math.random() * 2 - 1) * s.px * k;
    }
    if (ox || oy) cam.setViewOffset(this.w, this.h, ox, oy, this.w, this.h);
    else cam.clearViewOffset();

    this.measure(x, z, travel, speed, d.lookAhead);

    // Framing feedback: pull the look-ahead in when the giant sits below the
    // lower-third limit, let it back out when there's room.
    if (dt > 0) {
      const err = C.giantMaxScreenY - this.info.giantScreenY; // < 0: giant too low
      const gain = 3 * (this.distance + this.pullOut); // metres of lead per unit of screen error per second
      const full = speed * C.lookAheadTime;
      if (!Number.isFinite(this.leadCap)) this.leadCap = full;
      this.leadCap = Math.max(0, Math.min(full + 2, this.leadCap + err * gain * dt));
    }
  }

  private measure(x: number, z: number, travel: number, speed: number, lookAhead: number) {
    const cam = this.camera;
    const g = this.tmpA.set(x, 1.6, z).project(cam);
    this.info.giantScreenY = (1 - g.y) / 2;
    this.ray.setFromCamera(new THREE.Vector2(0, 1), cam);
    const hit = this.ray.ray.intersectPlane(this.ground, this.tmpB);
    const ahead = hit ? (hit.x - x) * Math.cos(travel) + (hit.z - z) * Math.sin(travel) : Infinity;
    this.info.aheadMetres = ahead;
    this.info.aheadSeconds = ahead / Math.max(speed, 0.01);
    this.info.lookAhead = lookAhead;
    this.info.side = this.side;
    this.info.raise = this.raise;
    const dir = cam.getWorldDirection(this.tmpB);
    this.info.pitchDeg = Math.asin(-dir.y) / DEG;
    const c = cam.position;
    this.info.insideBuilding = this.occluders.some((o) => c.x > o.minX && c.x < o.maxX && c.z > o.minZ && c.z < o.maxZ && c.y < o.top);
    this.info.losBlocked = this.blocked(c, this.tmpA.set(x, 2.6, z));
  }

  /** Ground point under a screen position (CSS px), or null if it misses the ground. */
  screenToGround(px: number, py: number): { x: number; z: number } | null {
    const ndc = new THREE.Vector2((px / this.w) * 2 - 1, -(py / this.h) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const hit = this.ray.ray.intersectPlane(this.ground, new THREE.Vector3());
    return hit ? { x: hit.x, z: hit.z } : null;
  }

  /**
   * Screen-space direction → world heading. Stick and touch steer relative to
   * what the player sees: up on the stick is "into the shot".
   */
  screenDirToHeading(sx: number, sy: number): number {
    const cam = this.camera;
    const f = cam.getWorldDirection(new THREE.Vector3());
    const fx = f.x;
    const fz = f.z;
    const fl = Math.hypot(fx, fz) || 1;
    const r = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const rl = Math.hypot(r.x, r.z) || 1;
    const wx = (r.x / rl) * sx + (fx / fl) * -sy;
    const wz = (r.z / rl) * sx + (fz / fl) * -sy;
    return Math.atan2(wz, wx);
  }
}
