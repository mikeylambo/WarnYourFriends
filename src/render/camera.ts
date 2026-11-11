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
  /** Signed angle between the direction of travel on screen and screen-up (deg). */
  screenUpDeg: number;
  /** Giant's screen height position, 0 top .. 1 bottom. */
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
  readonly info: CameraFrameInfo = { angle: 'Chase High', screenUpDeg: 0, giantScreenY: 0, aheadMetres: 0, aheadSeconds: 0, lookAhead: 0, yawDeg: 0, raise: 0, pitchDeg: 0, insideBuilding: false, losBlocked: false };

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
    if (this.reducedMotion || px <= 0) return;
    this.shakes.push({ px, t: 0, max: time });
  }

  /** Hard cut to an angle (no lag). */
  cut(index: number, side: number, t: CameraTarget) {
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
      return this.giantY(t) <= C.giantMaxScreenY - 0.01;
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
    const lim = maxYawForScreenUp(C.screenUpMaxDeg - C.screenUpMarginDeg, a.pitchDeg);
    return Math.max(-lim, Math.min(lim, a.yawDeg)) * this.side;
  }

  /** Look-ahead time for the current angle (cut-aways frame less ahead, more of the chase behind). */
  private leadTime(): number {
    return this.angle.lookAheadTime ?? TUNING.camera.lookAheadTime;
  }

  private distance(): number {
    return this.angle.distance * this.tierScale + this.pullOut;
  }

  private desired(t: CameraTarget) {
    const a = this.angle;
    const dist = this.distance();
    const lookAhead = Math.max(0, Math.min(t.speed * this.leadTime(), this.leadCap));
    const fx = Math.cos(t.travel);
    const fz = Math.sin(t.travel);
    const look = new THREE.Vector3(t.x + fx * lookAhead, 0, t.z + fz * lookAhead);
    const yaw = t.travel + this.yaw() * DEG;
    const p = a.pitchDeg * DEG;
    const back = dist * Math.cos(p);
    const pos = new THREE.Vector3(look.x - Math.cos(yaw) * back, dist * Math.sin(p), look.z - Math.sin(yaw) * back);
    return { pos, look, lookAhead };
  }

  private applyLens() {
    if (this.camera.fov !== this.angle.fov) {
      this.camera.fov = this.angle.fov;
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
      if (this.giantY(t) > C.giantMaxScreenY) {
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
          if (this.giantY(t) > C.giantMaxScreenY - 0.002) hi = mid;
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
        const ang = this.measureScreenUp(t);
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
        if (Math.abs(this.measureScreenUp(t)) > Math.abs(ang)) {
          this.pos.x = this.look.x + (ox * c + oz * s);
          this.pos.z = this.look.z + (-ox * s + oz * c);
          this.orient(t, this.look);
        }
      }
    };
    // Framing before the hard clamp: the look-ahead feedback learns from this, so the
    // steady-state shot satisfies the limit by itself and the clamp only catches transients.
    const yBeforeClamp = this.giantY(t);
    enforceFraming();
    enforceScreenUp();
    if (this.giantY(t) > C.giantMaxScreenY + 0.001) {
      enforceFraming();
      enforceScreenUp();
    }

    // Pixel shake on top (§10, v0.3 footfall pulse).
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

    this.measure(t, d.lookAhead);

    // Look-ahead feedback: remember how far ahead framing allowed, so the next frame starts there.
    if (dt > 0) {
      const err = C.giantMaxScreenY - 0.01 - yBeforeClamp;
      const full = t.speed * this.leadTime();
      if (!Number.isFinite(this.leadCap)) this.leadCap = full;
      this.leadCap = Math.max(0, Math.min(full + 2, this.leadCap + err * 3 * this.distance() * dt));
    }
  }

  private measure(t: CameraTarget, lookAhead: number) {
    const cam = this.camera;
    const info = this.info;
    info.angle = this.angle.name;
    info.screenUpDeg = this.measureScreenUp(t);
    info.giantScreenY = this.giantY(t);
    this.ray.setFromCamera(this.ndcTop, cam);
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
    // Alternate the away angles so two cut-aways in a row look different.
    const away: number[] = [];
    for (let i = 0; i < C.angles.length; i++) if (i !== C.homeAngle) away.push(i);
    const pool = away.length > 1 ? away.filter((i) => i !== this.lastAwayAngle) : away;
    this.current = pool[this.rng.int(0, pool.length - 1)];
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
