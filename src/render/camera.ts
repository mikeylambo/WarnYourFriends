import * as THREE from 'three';
import { TUNING, type CameraAngle } from '../tuning';
import { approach } from '../sim/math';
import { Rng } from '../sim/rng';
import type { SimEvent } from '../sim/types';

/**
 * Oblique news-chopper camera with v0.3 broadcast angle cuts.
 *
 * Each angle (Chase High, Wide Side, Long Lens) is a placement relative to the
 * direction of travel: yaw off-axis, pitch, distance, FOV. The rig frames a
 * point `speed × lookAheadTime` ahead of the giant with position/look lag and
 * wobble. Three rules are enforced after everything else, every frame:
 *
 *  1. Screen-up law (LOCKED): the direction of travel points up the screen
 *     within ±35°. Yaw is clamped analytically per angle, then the measured
 *     on-screen angle is corrected if lag or wobble push it out.
 *  2. The giant never sits below 85% of the screen height (look target pulled in).
 *  3. Line of sight: climb rather than cut through anything solid.
 *
 * Cuts are hard: the director picks the moment (event-driven, never during a
 * lane change; see Director) and the rig snaps to the new angle with no lag.
 * Uses only three.js math, so it runs headless in tests.
 */

export interface Occluder {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  top: number;
}

/** What the camera follows each frame. */
export interface CameraTarget {
  x: number;
  z: number;
  /** Direction of travel: the road's heading at the giant (not lateral lane-change motion). */
  travel: number;
  speed: number;
  tier: number;
}

export interface CameraFrameInfo {
  angle: CameraAngle['name'];
  /** Signed angle between travel on screen and the law direction: screen-up (or screen-down head-on), deg. */
  screenUpDeg: number;
  /** Giant's screen position from the far edge: 0 top .. 1 bottom behind him; mirrored head-on. */
  giantScreenY: number;
  /** Road visible ahead of the giant along its travel, to the top edge of the frame (m, s). */
  aheadMetres: number;
  aheadSeconds: number;
  lookAhead: number;
  /** Yaw actually used after the screen-up clamp (deg). */
  yawDeg: number;
  raise: number;
  pitchDeg: number;
  insideBuilding: boolean;
  losBlocked: boolean;
  /** Travel points down the screen right now (Head-On, or past halfway through a swoop): lane input mirrors. */
  travelDown: boolean;
  /** Mid-swoop: camera rules suspended for at most `swoop.time`. */
  transition: boolean;
}

const DEG = Math.PI / 180;
const smoothstep = (t: number) => t * t * (3 - 2 * t);

/** Max yaw off the travel direction that keeps travel within `limitDeg` of screen-up at `pitchDeg`. */
export function maxYawForScreenUp(limitDeg: number, pitchDeg: number): number {
  return Math.atan(Math.tan(limitDeg * DEG) * Math.sin(pitchDeg * DEG)) / DEG;
}

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  reducedMotion = false;
  /** Shell setting: screen shake intensity (0..1). */
  shakeScale = 1;
  readonly info: CameraFrameInfo = { angle: 'Chase High', screenUpDeg: 0, giantScreenY: 0, aheadMetres: 0, aheadSeconds: 0, lookAhead: 0, yawDeg: 0, raise: 0, pitchDeg: 0, insideBuilding: false, losBlocked: false, travelDown: false, transition: false };

  private angleIndex = 0;
  /** Which side an off-axis angle sits on (+1 camera left of the road, looking right). */
  private side = 1;
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private tierScale: number = TUNING.tiers[0].cameraDistanceScale;
  private tierFrom: number = this.tierScale;
  private tierTo: number = this.tierScale;
  private tierT = 1;
  private pullOut = 0;
  private leadCap = Infinity;
  private raise = 0;
  private occluders: Occluder[] = [];
  private shakes: { px: number; t: number; max: number }[] = [];
  private time = 0;
  private w = 1280;
  private h = 720;
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private tmpC = new THREE.Vector3();
  private ray = new THREE.Raycaster();
  private ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private ndcTop = new THREE.Vector2(0, 1);
  private ndcBottom = new THREE.Vector2(0, -1);
  /** Phase 0c: the swoop out of Head-On (null when not swooping). */
  private swoop: { t: number; relYaw: number; dYaw: number; pitch: number; dist: number; fov: number; lookOff: THREE.Vector3 } | null = null;

  /** +1 behind him (travel points up the screen), −1 head-on (travel points down). */
  get facing(): 1 | -1 {
    return this.angle.headOn ? -1 : 1;
  }

  /** A swoop between shots is in progress (the camera rules are suspended for its bounded length). */
  get inTransition(): boolean {
    return this.swoop !== null;
  }

  constructor() {
    this.camera = new THREE.PerspectiveCamera(TUNING.camera.angles[0].fov, this.w / this.h, 1, 1200);
  }

  get angle(): CameraAngle {
    return TUNING.camera.angles[this.angleIndex];
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
    const target = TUNING.tiers[tier].cameraDistanceScale;
    if (target === this.tierTo) return;
    this.tierFrom = this.tierScale;
    this.tierTo = target;
    this.tierT = 0;
  }

  tierUpPulse() {
    this.pullOut = TUNING.camera.tierUpPullOut;
  }

  /** Screen jolt in CSS px (§10 impact scale; v0.3 footfall pulse). */
  jolt(px: number, time: number = TUNING.camera.joltTime) {
    if (this.reducedMotion || px <= 0 || this.shakeScale <= 0) return;
    this.shakes.push({ px: px * this.shakeScale, t: 0, max: time });
  }

  /**
   * Phase 0c swoop to an angle: orbit round the giant's shoulder (the side the
   * current shot is offset to) and crane up over him, landing exactly on the new
   * angle's framing. Used out of Head-On.
   */
  swoopTo(index: number, side: number, t: CameraTarget) {
    const cam = this.camera;
    const v = this.tmpA.copy(cam.position).sub(this.look);
    const hb = Math.hypot(v.x, v.z);
    const fromYaw = Math.atan2(-v.z, -v.x) / DEG - t.travel / DEG;
    const relYaw = ((((fromYaw + 180) % 360) + 360) % 360) - 180;
    const lookOff = new THREE.Vector3(this.look.x - t.x, 0, this.look.z - t.z);
    const from = { relYaw, pitch: Math.atan2(v.y, hb) / DEG, dist: v.length(), fov: cam.fov };
    this.angleIndex = index;
    this.side = side;
    this.leadCap = this.solveLeadCap(t);
    let dYaw = this.yaw() - from.relYaw;
    dYaw = ((((dYaw + 180) % 360) + 360) % 360) - 180;
    this.swoop = { t: 0, relYaw: from.relYaw, dYaw, pitch: from.pitch, dist: from.dist, fov: from.fov, lookOff };
    this.raise = 0;
  }

  private updateSwoop(dt: number, t: CameraTarget) {
    const sw = this.swoop!;
    const S = TUNING.camera.swoop;
    sw.t += dt;
    const u = Math.min(1, sw.t / S.time);
    const e = u * u * u * (u * (u * 6 - 15) + 10); // smootherstep: eases in and out like a pilot
    const d = this.desired(t);
    const toPitch = this.pitch();
    const toDist = this.distance();
    const relYaw = (sw.relYaw + sw.dYaw * e) * DEG;
    const bump = Math.max(0, S.apexPitchDeg - Math.max(sw.pitch, toPitch));
    const pitch = (sw.pitch + (toPitch - sw.pitch) * e + bump * Math.sin(Math.PI * e)) * DEG;
    const dist = sw.dist + (toDist - sw.dist) * e;
    const toOff = this.tmpB.set(d.look.x - t.x, 0, d.look.z - t.z);
    this.look.set(t.x + sw.lookOff.x + (toOff.x - sw.lookOff.x) * e, 0, t.z + sw.lookOff.z + (toOff.z - sw.lookOff.z) * e);
    const yaw = t.travel + relYaw;
    this.pos.set(this.look.x - Math.cos(yaw) * dist * Math.cos(pitch), dist * Math.sin(pitch), this.look.z - Math.sin(yaw) * dist * Math.cos(pitch));
    const fov = sw.fov + (this.angle.fov - sw.fov) * e;
    if (this.camera.fov !== fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.orient(t, this.look);
    if (u >= 1) {
      this.swoop = null;
      this.pos.copy(d.pos);
      this.look.copy(d.look);
      this.applyLens();
      this.orient(t, this.look);
    }
  }

  /** Hard cut to an angle (no lag). */
  cut(index: number, side: number, t: CameraTarget) {
    this.swoop = null;
    this.angleIndex = index;
    this.side = side;
    this.raise = 0;
    this.applyLens();
    this.leadCap = this.solveLeadCap(t);
    const d = this.desired(t);
    this.pos.copy(d.pos);
    this.look.copy(d.look);
  }

  /**
   * Largest look-ahead whose un-lagged framing keeps the giant at or above the
   * screen limit, for this angle and speed. Used on cuts so the first frame of a
   * new angle is already framed (no pitch-down while the feedback catches up).
   */
  private solveLeadCap(t: CameraTarget): number {
    const C = TUNING.camera;
    const full = t.speed * this.leadTime();
    let lo = 0;
    let hi = full;
    const fits = (cap: number) => {
      this.leadCap = cap;
      const d = this.desired(t);
      this.camera.position.copy(d.pos);
      this.camera.lookAt(d.look);
      this.camera.updateMatrixWorld();
      return this.frameY(t) <= C.giantMaxScreenY - 0.01;
    };
    if (fits(full)) return full;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /** Start of a run. */
  snap(t: CameraTarget) {
    this.tierScale = this.tierFrom = this.tierTo = TUNING.tiers[t.tier].cameraDistanceScale;
    this.tierT = 1;
    this.pullOut = 0;
    this.cut(0, 1, t);
  }

  /** Yaw off the travel direction for the current angle, clamped by the screen-up law. */
  private yaw(): number {
    const C = TUNING.camera;
    const a = this.angle;
    const lim = maxYawForScreenUp(C.screenUpMaxDeg - C.screenUpMarginDeg, this.pitch());
    return Math.max(-lim, Math.min(lim, a.yawDeg)) * this.side + (a.headOn ? 180 : 0);
  }

  /** Look-ahead time for the current angle (cut-aways frame less ahead, more of the chase behind). */
  private leadTime(): number {
    return this.angle.lookAheadTime ?? TUNING.camera.lookAheadTime;
  }

  private distance(): number {
    return this.angle.distance * this.tierScale + this.pullOut;
  }

  private pitch(): number {
    return this.angle.pitchDeg;
  }

  private desired(t: CameraTarget) {
    const dist = this.distance();
    const lookAhead = Math.max(0, Math.min(t.speed * this.leadTime(), this.leadCap));
    const fx = Math.cos(t.travel);
    const fz = Math.sin(t.travel);
    const look = new THREE.Vector3(t.x + fx * lookAhead, 0, t.z + fz * lookAhead);
    const yaw = t.travel + this.yaw() * DEG;
    const p = this.pitch() * DEG;
    const back = dist * Math.cos(p);
    const pos = new THREE.Vector3(look.x - Math.cos(yaw) * back, dist * Math.sin(p), look.z - Math.sin(yaw) * back);
    return { pos, look, lookAhead };
  }

  private fov(): number {
    return this.angle.fov;
  }

  private applyLens() {
    if (this.camera.fov !== this.fov()) {
      this.camera.fov = this.fov();
      this.camera.updateProjectionMatrix();
    }
  }

  /** Does the segment a→b pass through any occluder box? */
  private blocked(a: THREE.Vector3, b: THREE.Vector3): boolean {
    for (const o of this.occluders) {
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

  /** Signed on-screen angle of the travel direction from screen-up (deg), with the current camera. */
  measureScreenUp(t: CameraTarget): number {
    const cam = this.camera;
    cam.updateMatrixWorld();
    const a = this.tmpA.set(t.x, 0, t.z).project(cam);
    const b = this.tmpB.set(t.x + Math.cos(t.travel) * 8, 0, t.z + Math.sin(t.travel) * 8).project(cam);
    const dx = (b.x - a.x) * this.w;
    const dy = (b.y - a.y) * this.h; // NDC y is up
    return Math.atan2(dx, dy) / DEG;
  }

  /**
   * Giant's screen position measured from the edge the action comes from: 0 = the
   * far edge, 1 = the near edge (bottom when behind, top when head-on).
   */
  private frameY(t: CameraTarget): number {
    const y = this.giantY(t);
    return this.facing > 0 ? y : 1 - y;
  }

  /** Signed angle between travel on screen and the law direction (screen-up, or screen-down head-on). */
  lawDeg(t: CameraTarget): number {
    const a = this.measureScreenUp(t);
    if (this.facing > 0) return a;
    return a - 180 * Math.sign(a || 1);
  }

  private giantY(t: CameraTarget): number {
    const g = this.tmpC.set(t.x, 1.6, t.z).project(this.camera);
    return (1 - g.y) / 2;
  }

  private orient(t: CameraTarget, look: THREE.Vector3) {
    const C = TUNING.camera;
    const cam = this.camera;
    cam.position.set(this.pos.x, this.pos.y + this.raise, this.pos.z);
    cam.lookAt(look);
    if (!this.reducedMotion) {
      const w = C.wobbleDeg * DEG;
      const ph = this.time * Math.PI * 2 * C.wobbleHz;
      cam.rotateX(Math.sin(ph) * w);
      cam.rotateY(Math.sin(ph * 0.73 + 1.3) * w);
      cam.rotateZ(Math.sin(ph * 0.51 + 2.1) * w * 0.6);
    }
    cam.updateMatrixWorld();
    void t;
  }

  update(dt: number, t: CameraTarget) {
    const C = TUNING.camera;
    this.time += dt;
    this.applyLens();
    this.setTier(t.tier);
    if (this.tierT < 1) {
      this.tierT = Math.min(1, this.tierT + dt / C.distanceEase);
      this.tierScale = this.tierFrom + (this.tierTo - this.tierFrom) * smoothstep(this.tierT);
    }
    this.pullOut *= Math.exp(-dt / (C.tierUpPullOutTime / 3));

    if (this.swoop) {
      this.updateSwoop(dt, t);
      this.applyShake(dt);
      this.measure(t, 0);
      return;
    }

    const d = this.desired(t);
    this.pos.lerp(d.pos, approach(dt, C.positionLag));
    this.look.lerp(d.look, approach(dt, C.lookLag));

    // Line of sight: climb until clear, never cut through.
    let need = 0;
    if (this.occluders.length) {
      const head = this.tmpA.set(t.x, 2.6, t.z);
      const eye = this.tmpB;
      while (need <= C.occlusionMaxRaise) {
        eye.set(this.pos.x, this.pos.y + need, this.pos.z);
        if (!this.blocked(eye, head)) break;
        need += C.occlusionRaiseStep;
      }
    }
    this.raise += (need - this.raise) * approach(dt, need > this.raise ? C.occlusionRaiseLag : C.occlusionLowerLag);

    this.orient(t, this.look);

    // Hard rules, after lag and wobble. Framing first, then the LOCKED screen-up law
    // last so nothing can undo it; one more framing pass in case the orbit moved the giant.
    const enforceFraming = () => {
      if (this.frameY(t) > C.giantMaxScreenY) {
        const fx = Math.cos(t.travel);
        const fz = Math.sin(t.travel);
        // Current look-ahead along travel, then bisect toward the giant.
        // Search only between the giant and the current look point: looking behind
        // the giant would turn the shot around.
        let hi = Math.max(0, (this.look.x - t.x) * fx + (this.look.z - t.z) * fz);
        let lo = 0;
        const lat = { x: this.look.x - t.x - fx * hi, z: this.look.z - t.z - fz * hi };
        const lookAt = (a: number) => this.tmpB.set(t.x + lat.x + fx * a, 0, t.z + lat.z + fz * a);
        for (let i = 0; i < 18; i++) {
          const mid = (lo + hi) / 2;
          this.orient(t, lookAt(mid));
          if (this.frameY(t) > C.giantMaxScreenY - 0.002) hi = mid;
          else lo = mid;
        }
        const fixed = lookAt(lo);
        this.look.copy(fixed);
        this.orient(t, this.look);
      }
    };
    const enforceScreenUp = () => {
      const limit = C.screenUpMaxDeg - 0.5;
      for (let i = 0; i < 12; i++) {
        const ang = this.lawDeg(t);
        if (Math.abs(ang) <= limit) break;
        const rot = -Math.sign(ang) * Math.min(6, Math.abs(ang) - limit + 0.5) * DEG;
        // Orbit position about the vertical axis through the look point.
        const ox = this.pos.x - this.look.x;
        const oz = this.pos.z - this.look.z;
        const c = Math.cos(rot);
        const s = Math.sin(rot);
        // Sign chosen by trying: if it made things worse, flip.
        const nx = ox * c - oz * s;
        const nz = ox * s + oz * c;
        this.pos.x = this.look.x + nx;
        this.pos.z = this.look.z + nz;
        this.orient(t, this.look);
        if (Math.abs(this.lawDeg(t)) > Math.abs(ang)) {
          this.pos.x = this.look.x + (ox * c + oz * s);
          this.pos.z = this.look.z + (-ox * s + oz * c);
          this.orient(t, this.look);
        }
      }
    };
    // Framing before the hard clamp: the look-ahead feedback learns from this, so the
    // steady-state shot satisfies the limit by itself and the clamp only catches transients.
    const yBeforeClamp = this.frameY(t);
    enforceFraming();
    enforceScreenUp();
    if (this.frameY(t) > C.giantMaxScreenY + 0.001) {
      enforceFraming();
      enforceScreenUp();
    }

    this.applyShake(dt);

    this.measure(t, d.lookAhead);

    // Look-ahead feedback: remember how far ahead framing allowed, so the next frame starts there.
    if (dt > 0) {
      const err = C.giantMaxScreenY - 0.01 - yBeforeClamp;
      const full = t.speed * this.leadTime();
      if (!Number.isFinite(this.leadCap)) this.leadCap = full;
      this.leadCap = Math.max(0, Math.min(full + 2, this.leadCap + err * 3 * this.distance() * dt));
    }
  }

  /** Pixel shake on top (§10, v0.3 footfall pulse). */
  private applyShake(dt: number) {
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
    if (ox || oy) this.camera.setViewOffset(this.w, this.h, ox, oy, this.w, this.h);
    else this.camera.clearViewOffset();

  }

  private measure(t: CameraTarget, lookAhead: number) {
    const cam = this.camera;
    const info = this.info;
    info.angle = this.angle.name;
    info.screenUpDeg = this.lawDeg(t);
    const raw = this.measureScreenUp(t);
    info.travelDown = Math.abs(raw) > 90;
    info.transition = this.swoop !== null;
    info.giantScreenY = this.frameY(t);
    // Road ahead runs to the top edge behind him, to the bottom edge head-on.
    this.ray.setFromCamera(this.facing > 0 ? this.ndcTop : this.ndcBottom, cam);
    const hit = this.ray.ray.intersectPlane(this.ground, this.tmpB);
    const ahead = hit ? (hit.x - t.x) * Math.cos(t.travel) + (hit.z - t.z) * Math.sin(t.travel) : Infinity;
    info.aheadMetres = ahead;
    info.aheadSeconds = ahead / Math.max(t.speed, 0.01);
    info.lookAhead = lookAhead;
    info.yawDeg = this.yaw();
    info.raise = this.raise;
    const dir = cam.getWorldDirection(this.tmpB);
    info.pitchDeg = Math.asin(-dir.y) / DEG;
    const c = cam.position;
    info.insideBuilding = this.occluders.some((o) => c.x > o.minX && c.x < o.maxX && c.z > o.minZ && c.z < o.maxZ && c.y < o.top);
    info.losBlocked = this.occluders.length > 0 && this.blocked(c, this.tmpA.set(t.x, 2.6, t.z));
  }
}

/** Phase 0c: the only things allowed to cut the camera away from Chase High. */
export type CutTrigger = 'rampage' | 'heavy' | 'merge';

/** Map a sim event to the cut trigger it is, if any. */
export function cutTriggerFor(e: SimEvent): CutTrigger | null {
  if (e.type === 'tierUp' && e.tier === TUNING.tiers.length - 1) return 'rampage';
  if (e.type === 'smash' && e.cls === 'heavy') return 'heavy';
  if (e.type === 'merge' && e.from !== e.to) return 'merge';
  return null;
}

export interface CutDecision {
  index: number;
  side: number;
  /** What caused it: a trigger for a cut-away, 'home' for the return to Chase High. */
  reason: CutTrigger | 'home';
}

/**
 * The broadcast director (Phase 0c): event-driven, not timed.
 *
 * Chase High is home. It cuts away only on a trigger (reaching Rampage, a Heavy
 * smash, a lane-count merge), returns home after 6–10s, keeps ≥15s between
 * cut-aways, never cuts away twice in a row on the same trigger, and never cuts
 * (away or home) while a lane change is in progress. A trigger that lands
 * mid-lane-change waits up to `triggerPending` for the move to finish.
 * Seeded per run so headless tests are reproducible.
 */
export class Director {
  private rng: Rng;
  /** Sim time since the last cut-away. */
  private sinceAway = Infinity;
  private awayFor = 0;
  private hold = 0;
  private pending: { kind: CutTrigger; ttl: number } | null = null;
  private lastAwayAngle = 0;
  /** Trigger of the most recent cut-away. */
  lastTrigger: CutTrigger | null = null;
  /** Cuts on/off (setting). Off holds Chase High. */
  enabled = true;
  /** Dev: hold a forced angle until released (?angle=, screenshots). */
  pinned = false;
  current: number = TUNING.camera.homeAngle;
  side = 1;
  cuts = 0;
  awayCuts = 0;

  constructor(seed: number) {
    this.rng = new Rng((seed ^ 0xc0ffee) >>> 0);
  }

  get home(): boolean {
    return this.current === TUNING.camera.homeAngle;
  }

  /** A cut-worthy event happened. Returns whether it was accepted (pending a cut). */
  trigger(kind: CutTrigger): boolean {
    if (!this.enabled || this.pinned || !this.home || this.pending) return false;
    if (this.sinceAway < TUNING.camera.cutMinInterval) return false;
    if (kind === this.lastTrigger) return false;
    this.pending = { kind, ttl: TUNING.camera.triggerPending };
    return true;
  }

  /** Advance in sim time; returns a cut to make now, else null. */
  update(dt: number, laneBusy: boolean): CutDecision | null {
    const C = TUNING.camera;
    this.sinceAway += dt;
    if (this.pinned) return null;
    if (!this.home) {
      this.awayFor += dt;
      if ((this.awayFor >= this.hold || !this.enabled) && !laneBusy) {
        this.current = C.homeAngle;
        this.side = 1;
        this.cuts++;
        return { index: this.current, side: this.side, reason: 'home' };
      }
      return null;
    }
    if (!this.pending) return null;
    if (laneBusy) {
      this.pending.ttl -= dt;
      if (this.pending.ttl <= 0) this.pending = null;
      return null;
    }
    const kind = this.pending.kind;
    this.pending = null;
    // Each trigger has preferred angles (picked at random, seeded); never the same away angle twice running.
    const prefs = C.cutAngles[kind].filter((i) => i !== this.lastAwayAngle && i !== C.homeAngle && i < C.angles.length);
    const away: number[] = [];
    for (let i = 0; i < C.angles.length; i++) if (i !== C.homeAngle && i !== this.lastAwayAngle) away.push(i);
    this.current = prefs.length ? prefs[this.rng.int(0, prefs.length - 1)] : away[this.rng.int(0, away.length - 1)];
    this.lastAwayAngle = this.current;
    this.side = this.rng.chance(0.5) ? 1 : -1;
    this.hold = this.rng.range(C.awayHold[0], C.awayHold[1]);
    this.awayFor = 0;
    this.sinceAway = 0;
    this.lastTrigger = kind;
    this.cuts++;
    this.awayCuts++;
    return { index: this.current, side: this.side, reason: kind };
  }

  /** Force an angle (dev/screenshots only: C key, ?angle=, __GAME.setAngle). Pinned until released. */
  force(index: number, side = 1, pin = true) {
    this.current = index;
    this.side = side;
    this.pending = null;
    this.pinned = pin && index !== TUNING.camera.homeAngle;
  }
}
