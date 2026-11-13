import { TUNING } from '../tuning';

/**
 * v0.3 run cycle, pure math (no three, no DOM) so it can be tested headless.
 *
 * The sim owns the phase: `stepPos` advances by distance ÷ step length, so the
 * animation is locked to distance travelled. This module turns that phase into
 * foot, knee and hip positions in world space:
 *
 *  - A foot plants at each step boundary, ahead of the hip by half the stance
 *    distance, and is PINNED in world space until it lifts. Pinned feet can't
 *    slide. If the body moves so far that the leg can't reach the pinned foot
 *    (a lane change mid-stance), the foot lifts early rather than sliding.
 *  - Stance distance is limited by leg reach; the rest of each step is hang
 *    (a flight phase that grows with stride).
 *  - The body drops on each plant, holds 1–2 frames, then rises into the hang.
 *  - Legs are a two-bone IK chain (thigh, shin) bending forward at the knee.
 */

export interface GaitPose {
  /** Body (pelvis centre) ground position, world. */
  x: number;
  z: number;
  /** Direction of travel on the ground (unit), world. */
  fx: number;
  fz: number;
  speed: number;
  /** Continuous step position: integer part = steps taken, fraction = progress through this step. */
  stepPos: number;
  /** Current step length (m). */
  stepLen: number;
  tier: number;
  /** Seconds since the previous update (for the time-based contact hold). */
  dt: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Leg {
  hip: Vec3;
  knee: Vec3;
  /** Where the foot actually is (IK-resolved). */
  foot: Vec3;
  planted: boolean;
}

export interface GaitFrame {
  /** Pelvis height above ground. */
  hipY: number;
  /** 0..1: how far into the plant drop the body is (1 = fully dropped). */
  drop: number;
  /** True only on the update where a foot plants. */
  plantedNow: -1 | 0 | 1;
  legs: [Leg, Leg];
}

export interface PlantRecord {
  foot: 0 | 1;
  tier: number;
  /** Largest distance the (IK-resolved) foot moved while planted (m). */
  slide: number;
  /** Ground distance the body covered while this foot was down (m). */
  stanceDistance: number;
  liftedEarly: boolean;
}

interface FootState {
  planted: boolean;
  /** Pinned world position while planted. */
  px: number;
  pz: number;
  /** Where the actual foot was at contact, to measure slide. */
  cx: number;
  cz: number;
  slide: number;
  bodyAtContact: number;
  liftedEarly: boolean;
  /** Lift-off world position (start of swing). */
  lx: number;
  lz: number;
  liftOdo: number;
  /** Step index this foot planted on. */
  step: number;
}

const v = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
const smoothstep = (t: number) => t * t * (3 - 2 * t);

export class Gait {
  readonly records: PlantRecord[] = [];
  /** Keep only the most recent records (for long sessions). */
  maxRecords = 4000;
  private feet: [FootState, FootState];
  private lastStep = -1;
  private odo = 0;
  private lastX = NaN;
  private lastZ = NaN;
  private sinceContact = 1;
  private frame: GaitFrame;

  constructor() {
    const mk = (): FootState => ({ planted: false, px: 0, pz: 0, cx: 0, cz: 0, slide: 0, bodyAtContact: 0, liftedEarly: false, lx: 0, lz: 0, liftOdo: 0, step: -1 });
    this.feet = [mk(), mk()];
    const leg = (): Leg => ({ hip: v(), knee: v(), foot: v(), planted: false });
    this.frame = { hipY: 1.5, drop: 0, plantedNow: -1, legs: [leg(), leg()] };
  }

  /** Stance distance for a step length: leg-reach limited, always leaving some hang. */
  static stanceDistance(stepLen: number): number {
    const G = TUNING.gait;
    return Math.min(G.stanceMaxDistance, stepLen * G.stanceMaxShare);
  }

  /** Forget foot history (teleport, new run). */
  reset() {
    this.feet.forEach((f) => {
      f.planted = false;
      f.step = -1;
    });
    this.lastStep = -1;
    this.lastX = NaN;
  }

  update(p: GaitPose): GaitFrame {
    const G = TUNING.gait;
    const T = TUNING.tiers[p.tier];
    const out = this.frame;
    out.plantedNow = -1;

    // Body odometer in world space (includes lateral motion).
    if (!Number.isNaN(this.lastX)) this.odo += Math.hypot(p.x - this.lastX, p.z - this.lastZ);
    this.lastX = p.x;
    this.lastZ = p.z;

    const rx = -p.fz; // right of forward
    const rz = p.fx;
    const step = Math.floor(p.stepPos);
    const frac = p.stepPos - step;
    const stance = Gait.stanceDistance(p.stepLen);

    // A new step: the foot for this step plants, pinned in world space.
    if (this.lastStep < 0) this.lastStep = step;
    while (this.lastStep < step) {
      this.lastStep++;
      const k = this.lastStep;
      const fi = (k & 1) as 0 | 1;
      const f = this.feet[fi];
      if (f.planted) this.lift(fi, p.tier, false); // never happens with stance < step, but be safe
      // Body has moved `frac × stepLen` past the exact plant moment.
      const back = frac * p.stepLen;
      const side = fi === 0 ? -1 : 1;
      f.planted = true;
      f.step = k;
      f.px = p.x + p.fx * (stance / 2 - back) + rx * side * G.footSpread;
      f.pz = p.z + p.fz * (stance / 2 - back) + rz * side * G.footSpread;
      f.slide = 0;
      f.bodyAtContact = this.odo - back;
      f.liftedEarly = false;
      f.cx = NaN;
      out.plantedNow = fi;
      this.sinceContact = 0;
    }
    this.sinceContact += p.dt;

    // Body drop: fast drop at contact, hold 1–2 frames, rise through stance into the hang.
    const holdT = G.contactHoldFrames / TUNING.sim.hz;
    const dropIn = 1 / TUNING.sim.hz;
    let drop: number;
    if (this.sinceContact < dropIn) drop = this.sinceContact / dropIn;
    else if (this.sinceContact < dropIn + holdT) drop = 1;
    else {
      const stanceFrac = stance / p.stepLen;
      const u = (frac - (dropIn + holdT) * (p.speed / p.stepLen)) / Math.max(0.05, stanceFrac);
      drop = 1 - smoothstep(Math.min(1, Math.max(0, u)));
    }
    out.drop = drop;
    // Bound: once both feet are off the ground, the hips arc up and come down into the next plant.
    const stanceShare = Math.min(0.95, stance / p.stepLen);
    const hang = frac > stanceShare ? (frac - stanceShare) / (1 - stanceShare) : 0;
    out.hipY = T.hipHeight - T.bodyDrop * drop + T.flightLift * Math.sin(Math.PI * hang);

    // Legs.
    const reach = G.thigh + G.shin - 0.02;
    for (let fi = 0 as 0 | 1; fi < 2; fi = (fi + 1) as 0 | 1) {
      const f = this.feet[fi];
      const side = fi === 0 ? -1 : 1;
      const leg = out.legs[fi];
      leg.hip.x = p.x + rx * side * 0.3;
      leg.hip.y = out.hipY;
      leg.hip.z = p.z + rz * side * 0.3;

      // Lift at the end of stance (distance-based), or early if the leg can't reach.
      if (f.planted) {
        const travelled = this.odo - f.bodyAtContact;
        const dx = f.px - leg.hip.x;
        const dz = f.pz - leg.hip.z;
        const dist = Math.hypot(dx, dz, leg.hip.y - 0.1);
        if (travelled >= stance) this.lift(fi, p.tier, false);
        else if (dist > reach) this.lift(fi, p.tier, true);
      }

      let tx: number;
      let ty: number;
      let tz: number;
      if (f.planted) {
        tx = f.px;
        ty = 0.1;
        tz = f.pz;
      } else {
        // Swing toward where this foot will plant next (its next step boundary).
        const nextStep = f.step < 0 ? step + 1 + ((step + 1 - fi) & 1) : f.step + 2;
        const stepsAway = Math.max(0, nextStep - p.stepPos);
        const ahead = stepsAway * p.stepLen + stance / 2;
        const nx = p.x + p.fx * ahead + rx * side * G.footSpread;
        const nz = p.z + p.fz * ahead + rz * side * G.footSpread;
        if (f.step < 0) {
          f.lx = p.x + rx * side * G.footSpread;
          f.lz = p.z + rz * side * G.footSpread;
          f.liftOdo = this.odo;
          f.step = nextStep - 2;
        }
        const total = Math.max(0.01, this.odo - f.liftOdo + stepsAway * p.stepLen);
        const t = Math.min(1, (this.odo - f.liftOdo) / total);
        // Heel kicks up early and the foot hangs back (knee tucked), then whips forward to plant.
        const e = smoothstep(Math.pow(t, G.swingLag));
        tx = f.lx + (nx - f.lx) * e;
        tz = f.lz + (nz - f.lz) * e;
        ty = 0.1 + T.footLift * Math.sin(Math.PI * Math.pow(t, G.swingPeakEarly));
      }

      this.solveLeg(leg, tx, ty, tz, p.fx, p.fz);
      leg.planted = f.planted;

      if (f.planted) {
        if (Number.isNaN(f.cx)) {
          f.cx = leg.foot.x;
          f.cz = leg.foot.z;
        } else {
          f.slide = Math.max(f.slide, Math.hypot(leg.foot.x - f.cx, leg.foot.z - f.cz));
        }
      }
    }
    return out;
  }

  private lift(fi: 0 | 1, tier: number, early: boolean) {
    const f = this.feet[fi];
    f.planted = false;
    f.lx = f.px;
    f.lz = f.pz;
    f.liftOdo = this.odo;
    this.records.push({ foot: fi, tier, slide: f.slide, stanceDistance: this.odo - f.bodyAtContact, liftedEarly: early });
    if (this.records.length > this.maxRecords) this.records.splice(0, this.records.length - this.maxRecords);
  }

  /** Two-bone IK in the vertical plane through hip and target; the knee bends forward. */
  private solveLeg(leg: Leg, tx: number, ty: number, tz: number, fx: number, fz: number) {
    const G = TUNING.gait;
    const a = G.thigh;
    const b = G.shin;
    const hx = leg.hip.x;
    const hy = leg.hip.y;
    const hz = leg.hip.z;
    let dx = tx - hx;
    let dy = ty - hy;
    let dz = tz - hz;
    let d = Math.hypot(dx, dy, dz);
    const maxD = a + b - 1e-4;
    if (d > maxD) {
      const k = maxD / d;
      dx *= k;
      dy *= k;
      dz *= k;
      d = maxD;
    }
    leg.foot.x = hx + dx;
    leg.foot.y = hy + dy;
    leg.foot.z = hz + dz;
    // Angle at the hip between hip→foot and hip→knee (law of cosines).
    const cosA = Math.min(1, Math.max(-1, (a * a + d * d - b * b) / (2 * a * d)));
    const alpha = Math.acos(cosA);
    // Unit hip→foot, and a bend direction: forward, made perpendicular to it.
    const ux = dx / d;
    const uy = dy / d;
    const uz = dz / d;
    const dot = fx * ux + fz * uz;
    let px = fx - dot * ux;
    let py = -dot * uy;
    let pz = fz - dot * uz;
    const pl = Math.hypot(px, py, pz) || 1;
    px /= pl;
    py /= pl;
    pz /= pl;
    const ca = Math.cos(alpha);
    const sa = Math.sin(alpha);
    leg.knee.x = hx + a * (ux * ca + px * sa);
    leg.knee.y = hy + a * (uy * ca + py * sa);
    leg.knee.z = hz + a * (uz * ca + pz * sa);
  }
}
