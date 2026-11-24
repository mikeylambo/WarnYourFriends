import { TUNING, type MassClass } from '../tuning';
import { Rng } from './rng';
import { DEG, clamp } from './math';
import type { LandmarkKind, Material, Prop, PropKind } from './types';
import { CHUNKS, CHUNK_KINDS, SMALL_KINDS, chunkLength, mirror, type Chunk } from './chunks';

/**
 * v0.3 procedural highway, built from 40m segments on gentle splines.
 *
 * Track space: `s` is distance along the road; `d` is the offset across it,
 * measured from the road's LEFT edge (looking along the direction of travel).
 * Lane i is centred at d = width × (i + 0.5). Merges add or remove the
 * right-hand lane, tapering it over one segment.
 */

export type SegmentKind = 'straight' | 'curve' | 'merge';
/** Phase 2 road variety (v0.3 §16): highway 4 lanes, avenue 3, bridge and tunnel 2. */
export type ZoneKind = 'highway' | 'avenue' | 'bridge' | 'tunnel';

export interface Segment {
  index: number;
  kind: SegmentKind;
  s0: number;
  length: number;
  /** Heading at start/end (radians). Forward = (cos h, sin h) on XZ; screen-up at start is −Z. */
  h0: number;
  h1: number;
  lanes0: number;
  lanes1: number;
  /** Phase 2: the sign-off exit ramp leaves from this segment's right edge. */
  exit?: boolean;
  /** A fork (Mike, 2026-11-15): an exit ramp to this road leaves from this segment's right edge. */
  fork?: { zone: ZoneKind; name: string };
  /** Phase 2 road variety: which stretch of road this is, and its (invented) name. */
  zone: ZoneKind;
  zoneName: string;
  /** First segment of its zone. */
  zoneStart: boolean;
  /** Highway only: a road bridge crosses overhead (presentation). */
  overpass: boolean;
  /** Content pass: a landmark set piece on this segment (its own prop pattern and scenery), and its name. */
  landmark?: LandmarkKind;
  landmarkName?: string;
  /** Story run: which district (index into TUNING.proto.story.districts). */
  district?: number;
  /** Centre-reference samples every metre: left-edge position and heading. */
  xs: Float64Array;
  zs: Float64Array;
  hs: Float64Array;
}

interface PropDef {
  cls: MassClass;
  mat: Material;
  hl: number;
  hw: number;
  h: number;
  variants: number;
  rampOnly?: boolean;
}

/** Lane props: Medium and Heavy (v0.3), plus the immovable dozer (impact pass). */
export const PROP_DEFS: Record<PropKind, PropDef> = {
  sawhorse: { cls: 'medium', mat: 'wood', hl: 0.3, hw: 1.4, h: 1.1, variants: 2 },
  cart: { cls: 'medium', mat: 'fruit', hl: 0.9, hw: 0.6, h: 1.3, variants: 3 },
  fence: { cls: 'medium', mat: 'metal', hl: 0.15, hw: 1.8, h: 1.4, variants: 1 },
  scooter: { cls: 'medium', mat: 'metal', hl: 0.9, hw: 0.35, h: 1.1, variants: 3 },
  car: { cls: 'heavy', mat: 'metal', hl: 2.2, hw: 0.95, h: 1.5, variants: 5 },
  van: { cls: 'heavy', mat: 'metal', hl: 2.7, hw: 1.1, h: 2.3, variants: 3 },
  // Rampage timing (2026-11-17): concrete only breaks in Rampage (Stride bounces off it).
  barricade: { cls: 'heavy', mat: 'concrete', hl: 0.35, hw: 1.8, h: 0.95, variants: 1, rampOnly: true },
  // Impact pass: the one lane prop nothing smashes (bounces him at any tier). Leap clears it.
  dozer: { cls: 'immovable', mat: 'metal', hl: 2.3, hw: 1.35, h: 2.4, variants: 1 },
  // Landmarks: a toll gate arm (Medium: Stride smashes it) and a food truck (Heavy: Rampage).
  tollgate: { cls: 'medium', mat: 'wood', hl: 0.15, hw: 1.7, h: 1.2, variants: 1 },
  foodtruck: { cls: 'heavy', mat: 'fruit', hl: 3.0, hw: 1.2, h: 2.9, variants: 4 },
  // A rival station's news van (dish and mast on the roof): a target worth aiming for (TUNING.targets).
  /** Prototype collectible (Mike, 2026-11-18): a news Scoop he runs through for audience and points. */
  scoop: { cls: 'light', mat: 'paper', hl: 0.65, hw: 0.65, h: 1.5, variants: 1 },
  newsvan: { cls: 'heavy', mat: 'metal', hl: 2.6, hw: 1.1, h: 2.6, variants: 2 },
  // Police Net (2026-11-16): the armoured truck nothing smashes (Leap clears it), and the car carrier (Heavy).
  armored: { cls: 'immovable', mat: 'metal', hl: 2.9, hw: 1.25, h: 2.9, variants: 1 },
  carrier: { cls: 'heavy', mat: 'metal', hl: 6.5, hw: 1.3, h: 3.6, variants: 1 },
  // Phase 2 police units (never placed as lane props; pursuit spawns them).
  cruiser: { cls: 'heavy', mat: 'metal', hl: 2.4, hw: 0.98, h: 1.7, variants: 1 },
  compact: { cls: 'medium', mat: 'metal', hl: 1.8, hw: 0.85, h: 1.4, variants: 1 },
};

const MEDIUM: PropKind[] = ['sawhorse', 'cart', 'fence', 'scooter'];
/** Heavy traffic; concrete barricades come in by the difficulty table (TUNING.difficulty.concrete). */
const HEAVY: PropKind[] = ['car', 'car', 'van'];

/** A lane is usable where at least this much of it is open (giant is 2.2m wide). */
const MIN_USABLE_LANE_WIDTH = 2.8;

const smoothstep = (t: number) => t * t * (3 - 2 * t);

export class Track {
  readonly segments: Segment[] = [];
  readonly props: Prop[] = [];
  private nextMerge: number;
  private zone: ZoneKind = 'highway';
  private zoneName = '';
  private zoneLeft: number;
  private nextZone: ZoneKind | null = null;
  private zoneTarget: number = TUNING.lanes.start;
  private zoneJustStarted = true;
  /** After a branch, the next segment starts at this many lanes outright (no merge taper). */
  private forceLanes: number | null = null;
  private nextRowS: number;
  private nextLandmark: number = TUNING.landmarks.firstAt;
  /**
   * Where the sign-off ramp will need to go (set by the sim well before it opens): inside it the road stays
   * ramp-friendly (no new tunnel or bridge, a current one wraps up, no landmark), so the exit is never
   * pushed out of reach. 11% of exits were, with a bridge or tunnel run filling the window.
   */
  private exitReserve: [number, number] | null = null;
  reserveExit(s0: number, s1: number) {
    this.exitReserve = [s0, s1];
  }
  private reserved(s: number): boolean {
    const r = this.exitReserve;
    return !!r && s >= r[0] && s <= r[1];
  }
  private propId = 0;
  private readonly rng: Rng;

  /** Last row actually placed (m), for TUNING.pacing.maxEmpty. */
  private lastRowAt: number = TUNING.props.startAt;
  /** Prototype: the lanes the last row left open (a close next row keeps one of them open). */
  private lastOpen: number[] = [];
  private readonly gapScale: number;
  private readonly landmarkScale: number;

  /** Which segment of the run this road is for (difficulty, pacing). */
  private readonly segmentNo: number;

  /** Guided first broadcast: nothing unbreakable this close to the start (m). */
  private readonly hardFrom: number;

  /** Edition: × bulldozer and concrete chances. */
  private readonly hardMult: number;

  constructor(readonly seed: number, segment = 0, guided = false, hardMult = 1, endless = false) {
    if (endless) this.district = -1;
    this.hardMult = hardMult;
    this.segmentNo = segment;
    this.hardFrom = guided ? TUNING.guided.clearFor : TUNING.props.immovableFrom;
    const Pc = TUNING.pacing;
    this.gapScale = Pc.rowGapScale[Math.min(segment, Pc.rowGapScale.length - 1)];
    this.landmarkScale = Pc.landmarkEveryScale[Math.min(segment, Pc.landmarkEveryScale.length - 1)];
    this.rng = new Rng((seed ^ 0x7f4a7c15) >>> 0);
    const T = TUNING.track;
    this.nextMerge = T.runwaySegments + this.rng.int(T.mergeEvery[0], T.mergeEvery[1]);
    this.nextRowS = TUNING.props.startAt;
    this.zoneName = this.nameFor('highway');
    this.zoneLeft = T.runwaySegments + this.rng.int(TUNING.zones.length.highway[0], TUNING.zones.length.highway[1]);
    if (this.district === 0) {
      const d0 = TUNING.proto.story.districts[0];
      this.zone = d0.zone;
      this.zoneName = d0.name;
      this.zoneLeft = T.runwaySegments + d0.segments;
    }
    this.ensure(T.aheadDistance);
  }

  get end(): number {
    const last = this.segments[this.segments.length - 1];
    return last ? last.s0 + last.length : 0;
  }

  /** Generate segments (and their props) until the track reaches `s`. */
  ensure(s: number) {
    while (this.end < s) this.addSegment();
  }

  /** Forget segments and props well behind `s`. */
  /** Prototype moving traffic (oncoming cars, slow trucks): kept apart from `props`, whose order along the road propsBetween relies on. */
  readonly movers: Prop[] = [];
  /** Two-way stretches (presentation paints a double yellow line at `split`, the lane edge between the directions). */
  readonly twoWay: { s0: number; s1: number; split: number; built?: boolean; /** Presentation: line built up to here. */ builtTo?: number; /** A whole two-way district: every chunk in it has `split` oncoming lanes on the left. */ district?: boolean }[] = [];

  /**
   * Drive the moving traffic. Each waits until he's `moverWake` m short of it, then sets off from wherever puts it
   * level with him at its `meet` spot (at his speed then), and never leaves its own chunk: an oncoming car that
   * reaches the chunk's start, or a truck its end, stops there (a stalled car in its own lane, never another's).
   */
  stepMovers(dt: number, gs: number, gv: number) {
    const P = TUNING.proto;
    const sameLane = (a: Prop, b: Prop) => Math.abs(a.d - b.d) < a.hw + b.hw;
    /** Something in its lane within `gap` of the box [s0, s1]? (other movers and standing traffic both count) */
    const blocked = (m: Prop, s0: number, s1: number, gap: number) =>
      this.propsBetween(s0 - gap - 8, s1 + gap + 8).some((q) => q !== m && q.alive && sameLane(m, q) && q.s + q.hl > s0 - gap && q.s - q.hl < s1 + gap) ||
      // Police and the escort count too (Mike, 2026-11-24: oncoming cars drove through roadblocks and the escort).
      this.vehicles(s0 - gap - 8, s1 + gap + 8).some((q) => Math.abs(m.d - q.d) < m.hw + q.hw && q.s + q.hl > s0 - gap && q.s - q.hl < s1 + gap);
    for (const m of this.movers) {
      const mv = m.mover!;
      if (!m.alive) continue;
      if (!mv.active) {
        if (gs < mv.min - P.moverWake) continue;
        mv.active = true;
        const t = Math.max(0, (mv.meet - gs) / Math.max(gv, 1));
        let start = clamp(mv.meet - mv.v * t, mv.min + m.hl, mv.max - m.hl);
        // Its lane gone there (a merge past its chunk): it never sets off.
        const lane = Math.floor(m.d / TUNING.lanes.width);
        if (!this.laneUsable(lane, start) || lane >= this.lanesAt(start)) {
          m.alive = false;
          continue;
        }
        // Never on top of anything: slide back against its direction of travel (it's all off camera) or stay home.
        const back = mv.v < 0 ? 1 : -1;
        while (blocked(m, start - m.hl, start + m.hl, 1.5) && start > mv.min + m.hl && start < mv.max - m.hl) start += back;
        if (blocked(m, start - m.hl, start + m.hl, 1.5)) {
          m.alive = false;
          continue;
        }
        m.s = start;
      }
      // Traffic sense: brakes to a stop rather than drive into what's in front of it (Mike, 2026-11-18).
      const next = clamp(m.s + mv.v * dt, mv.min + m.hl, mv.max - m.hl);
      const ahead = mv.v < 0 ? [next - m.hl, m.s - m.hl] : [m.s + m.hl, next + m.hl];
      const laneHere = Math.floor(m.d / TUNING.lanes.width);
      if (mv.v !== 0 && !blocked(m, ahead[0], ahead[1], P.moverGap) && laneHere < this.lanesAt(next)) m.s = next;
      // Never off the road: a merge past its chunk can't take its lane out from under it.
      const w = this.widthAt(m.s);
      m.d = clamp(m.d, Math.min(m.hw + 0.2, w / 2), Math.max(w / 2, w - m.hw - 0.2));
    }
  }

  prune(s: number) {
    const keep = s - TUNING.track.keepBehind;
    for (let i = this.movers.length - 1; i >= 0; i--) if (this.movers[i].s + this.movers[i].hl < keep) this.movers.splice(i, 1);
    while (this.segments.length > 2 && this.segments[0].s0 + this.segments[0].length < keep) this.segments.shift();
    let i = 0;
    while (i < this.props.length && this.props[i].s + this.props[i].hl < keep) i++;
    if (i > 0) this.props.splice(0, i);
  }

  private addSegment() {
    const T = TUNING.track;
    const L = TUNING.lanes;
    const prev = this.segments[this.segments.length - 1];
    const index = prev ? prev.index + 1 : 0;
    const s0 = prev ? prev.s0 + prev.length : 0;
    const h0 = prev ? prev.h1 : -Math.PI / 2; // start heading north (screen-up)
    const lanes0 = this.forceLanes ?? (prev ? prev.lanes1 : L.start);
    this.forceLanes = null;
    const x0 = prev ? prev.xs[prev.xs.length - 1] : -(L.start * L.width) / 2; // road centred on x=0 at start
    const z0 = prev ? prev.zs[prev.zs.length - 1] : 0;
    const rng = this.rng;

    let kind: SegmentKind = 'straight';
    let h1 = h0;
    let lanes1 = lanes0;
    const Z = TUNING.zones;
    // Zones: when one runs out, pick the next; merge one lane per segment until its lane count is reached.
    // Coming up on the reserved exit stretch inside a tunnel or on a bridge: wrap it up now (merges take a few segments).
    const nearReserve = this.reserved(s0 + 3 * T.segmentLength) || this.reserved(s0);
    if (nearReserve && (this.zone === 'tunnel' || this.zone === 'bridge') && this.zoneLeft > 0 && !this.nextZone) this.zoneLeft = 0;
    const D = TUNING.proto.story.districts;
    if (this.district >= 0 && index >= T.runwaySegments && this.zoneLeft <= 0 && !this.nextZone) {
      // Story run: the next district, in order; after the last, the road just runs on past the sign-off.
      if (this.district + 1 < D.length) {
        this.district++;
        this.nextZone = D[this.district].zone;
        this.zoneTarget = D[this.district].lanes ?? Z.lanes[this.nextZone];
      } else this.zoneLeft = 1e9;
    } else if (index >= T.runwaySegments && this.zoneLeft <= 0 && !this.nextZone) {
      const options = (Object.keys(Z.lanes) as ZoneKind[]).filter((z) => z !== this.zone && !(nearReserve && (z === 'tunnel' || z === 'bridge')));
      this.nextZone = this.pickZone(options);
      this.zoneTarget = this.nextZone === 'highway' ? (rng.chance(0.7) ? 4 : 3) : Z.lanes[this.nextZone];
    }
    if (this.nextZone && lanes0 === this.zoneTarget) {
      this.zone = this.nextZone;
      this.zoneName = this.nameFor(this.zone);
      this.nextZone = null;
      this.zoneLeft = rng.int(Z.length[this.zone][0], Z.length[this.zone][1]);
      this.zoneJustStarted = true;
      if (this.district >= 0) {
        this.zoneDistrict = this.district;
        const d = D[this.district];
        this.zoneName = d.name;
        this.zoneLeft = d.segments;
        // The last district: the course (and the sign-off) ends where it does; keep that stretch ramp-friendly.
        if (d.oncoming) this.twoWay.push({ s0, s1: s0 + d.segments * T.segmentLength, split: d.oncoming, district: true });
        this.districtSpans.push({ k: this.district, s0, s1: s0 + d.segments * T.segmentLength });
        if (this.district === D.length - 1) {
          this.courseEnd = s0 + d.segments * T.segmentLength;
          this.reserveExit(this.courseEnd - 420, this.courseEnd + 60);
        }
      }
    }
    if (index >= T.runwaySegments) {
      if (this.nextZone && lanes0 !== this.zoneTarget) {
        kind = 'merge';
        lanes1 = lanes0 + Math.sign(this.zoneTarget - lanes0);
      } else if (this.zone === 'highway' && index >= this.nextMerge && this.zoneLeft > 1 && !(this.district >= 0 && TUNING.proto.story.districts[this.zoneDistrict]?.lanes)) {
        // (a story district with its own lane count keeps it: no odd 4↔3 merge on the six-lane finale)
        // Highway only: the odd 4↔3 merge within the zone.
        kind = 'merge';
        lanes1 = lanes0 >= 4 ? 3 : 4;
        this.nextMerge = index + rng.int(T.mergeEvery[0], T.mergeEvery[1]);
      } else if (this.zone !== 'bridge' && rng.chance(T.curveChance)) {
        kind = 'curve';
        // Bias curves back toward the starting heading so the road meanders, not spirals.
        const drift = h0 + Math.PI / 2;
        const sign = Math.abs(drift) > 25 * DEG ? -Math.sign(drift) : rng.chance(0.5) ? 1 : -1;
        h1 = h0 + sign * rng.range(T.minCurveDeg, T.maxCurveDeg) * DEG;
      }
    }
    const zone = this.zone;
    const zoneStart = this.zoneJustStarted;
    this.zoneJustStarted = false;
    this.zoneLeft--;
    // Landmarks: a straight, full-width segment well inside its zone (never on a merge or a zone's last segment).
    let landmark: LandmarkKind | undefined;
    let landmarkName: string | undefined;
    if (index >= this.nextLandmark && kind !== 'merge' && !this.nextZone && this.zoneLeft >= 2 && !this.reserved(s0) && !this.reserved(s0 + T.segmentLength)) {
      landmark = this.pickLandmark(zone);
      if (landmark) {
        kind = 'straight';
        h1 = h0;
        landmarkName = `${rng.pick(TUNING.zones.names.first)} ${TUNING.landmarks.suffix[landmark]}`;
        this.nextLandmark = index + Math.max(3, Math.round(rng.int(TUNING.landmarks.every[0], TUNING.landmarks.every[1]) * this.landmarkScale));
      }
    }
    const overpass = !landmark && zone === 'highway' && kind !== 'merge' && index >= T.runwaySegments && rng.chance(Z.overpassChance);
    const n = T.segmentLength;
    const xs = new Float64Array(n + 1);
    const zs = new Float64Array(n + 1);
    const hs = new Float64Array(n + 1);
    xs[0] = x0;
    zs[0] = z0;
    hs[0] = h0;
    for (let i = 1; i <= n; i++) {
      const hPrev = h0 + (h1 - h0) * smoothstep((i - 1) / n);
      const hNow = h0 + (h1 - h0) * smoothstep(i / n);
      const hm = (hPrev + hNow) / 2;
      xs[i] = xs[i - 1] + Math.cos(hm);
      zs[i] = zs[i - 1] + Math.sin(hm);
      hs[i] = hNow;
    }
    const seg: Segment = { index, kind, s0, length: n, h0, h1, lanes0, lanes1, xs, zs, hs, zone, zoneName: this.zoneName, zoneStart, overpass, landmark, landmarkName, ...(this.district >= 0 ? { district: this.zoneDistrict } : {}) };
    this.segments.push(seg);
    this.addProps(seg);
  }

  /**
   * Phase 2 sign-off ramp: how far right of the road's right edge the ramp's centre
   * sits at `s` (it peels away from the rightmost lane on a gentle curve).
   */
  exitOffset(seg: Segment, s: number): number {
    const u = Math.max(0, (s - seg.s0) / seg.length);
    return -TUNING.lanes.width / 2 + 16 * u * u;
  }

  /** Can the sign-off ramp leave from this segment? (Not a merge; not into or out of a tunnel; not a fork.) */
  exitEligible(seg: Segment): boolean {
    const next = this.segments.find((x) => x.index === seg.index + 1);
    // Not on a bridge either: the ramp would hang over the water.
    const ok = (z: ZoneKind) => z !== 'tunnel' && z !== 'bridge';
    return seg.kind !== 'merge' && seg.lanes0 === seg.lanes1 && ok(seg.zone) && (!next || ok(next.zone)) && !seg.fork && !next?.fork && !seg.landmark && !next?.landmark;
  }

  /** Can a fork leave from this segment? Highway, no merge here or next, and the next segment is highway too. */
  forkEligible(seg: Segment): boolean {
    const next = this.segments.find((x) => x.index === seg.index + 1);
    return seg.zone === 'highway' && !!next && next.zone === 'highway' && seg.kind !== 'merge' && next.kind !== 'merge' && seg.lanes0 === seg.lanes1 && !seg.exit && !next.exit && !seg.landmark && !next.landmark;
  }

  /** A name for a road a fork leads to (seeded, from the zone name bank). */
  forkName(zone: ZoneKind): string {
    return this.nameFor(zone);
  }

  /**
   * Take a fork: the road from segment `fromIndex` on is regenerated as `zone` (from the same start
   * point, so the join is continuous), at that zone's lane count outright. Its props start `propsFrom`.
   * The caller hides the join behind a broadcast cut and moves everything on the old road.
   */
  branch(fromIndex: number, zone: ZoneKind, name: string, propsFrom: number) {
    const keep = this.segments.findIndex((x) => x.index === fromIndex);
    if (keep < 0) return;
    this.segments.length = keep;
    for (let i = this.props.length - 1; i >= 0; i--) if (this.props[i].segment >= fromIndex) this.props.splice(i, 1);
    const Z = TUNING.zones;
    this.zone = zone;
    this.zoneName = name;
    this.nextZone = null;
    this.zoneLeft = this.rng.int(Z.length[zone][0], Z.length[zone][1]);
    this.zoneTarget = Z.lanes[zone];
    this.zoneJustStarted = true;
    this.forceLanes = Z.lanes[zone];
    // The merge clock restarts from the branch, so coming back to a highway never merges at once.
    this.nextMerge = Math.max(this.nextMerge, fromIndex + this.zoneLeft + TUNING.track.mergeEvery[0]);
    this.nextRowS = propsFrom;
    this.lastRowAt = propsFrom;
  }

  /** A landmark that suits this zone (weighted), or none. */
  private pickLandmark(zone: ZoneKind): LandmarkKind | undefined {
    if (TUNING.proto.on) return undefined; // prototype: authored chunks carry the set pieces
    const LM = TUNING.landmarks;
    const options = (Object.keys(LM.zones) as LandmarkKind[]).filter((k) => LM.zones[k].includes(zone));
    if (!options.length) return undefined;
    let total = 0;
    for (const k of options) total += LM.weight[k];
    let r = this.rng.next() * total;
    for (const k of options) if ((r -= LM.weight[k]) < 0) return k;
    return options[0];
  }

  private pickZone(options: ZoneKind[]): ZoneKind {
    const W = TUNING.zones.weight;
    let total = 0;
    for (const z of options) total += W[z];
    let r = this.rng.next() * total;
    for (const z of options) if ((r -= W[z]) < 0) return z;
    return options[0];
  }

  private nameFor(zone: ZoneKind): string {
    const N = TUNING.zones.names;
    return `${this.rng.pick(N.first)} ${N.suffix[zone]}`;
  }

  /** The zone at distance s. */
  zoneAt(s: number): Segment {
    return this.segmentAt(s);
  }

  segmentAt(s: number): Segment {
    const segs = this.segments;
    // Segments are contiguous and equal length: index directly.
    const first = segs[0];
    let i = Math.floor((s - first.s0) / TUNING.track.segmentLength);
    i = clamp(i, 0, segs.length - 1);
    return segs[i];
  }

  /** Road width at s (merges taper the right-hand lane). */
  widthAt(s: number): number {
    const seg = this.segmentAt(s);
    const t = clamp((s - seg.s0) / seg.length, 0, 1);
    const lanes = seg.lanes0 + (seg.lanes1 - seg.lanes0) * smoothstep(t);
    return lanes * TUNING.lanes.width;
  }

  /** Whole lanes usable at s. */
  lanesAt(s: number): number {
    const w = this.widthAt(s);
    const W = TUNING.lanes.width;
    let n = 0;
    while (n < TUNING.lanes.max && w - n * W >= MIN_USABLE_LANE_WIDTH) n++;
    return n;
  }

  laneUsable(lane: number, s: number): boolean {
    return lane >= 0 && lane < this.lanesAt(s);
  }

  laneCenter(lane: number): number {
    return TUNING.lanes.width * (lane + 0.5);
  }

  headingAt(s: number): number {
    const seg = this.segmentAt(s);
    const u = clamp(s - seg.s0, 0, seg.length);
    const i = Math.min(Math.floor(u), seg.length - 1);
    const f = u - i;
    return seg.hs[i] + (seg.hs[i + 1] - seg.hs[i]) * f;
  }

  /** World position (x, z) of track point (s, d). */
  posAt(s: number, d: number, out: { x: number; z: number } = { x: 0, z: 0 }) {
    const first = this.segments[0];
    if (first.index === 0 && s < first.s0) {
      // Before the start line (the renderer's lead-in road, seen in the opening head-on shot): straight back
      // along the opening heading. The sim never stands here.
      const h = first.hs[0];
      const x = first.xs[0] + Math.cos(h) * (s - first.s0);
      const z = first.zs[0] + Math.sin(h) * (s - first.s0);
      out.x = x - Math.sin(h) * d;
      out.z = z + Math.cos(h) * d;
      return out;
    }
    const seg = this.segmentAt(s);
    const u = clamp(s - seg.s0, 0, seg.length);
    const i = Math.min(Math.floor(u), seg.length - 1);
    const f = u - i;
    const x = seg.xs[i] + (seg.xs[i + 1] - seg.xs[i]) * f;
    const z = seg.zs[i] + (seg.zs[i + 1] - seg.zs[i]) * f;
    const h = seg.hs[i] + (seg.hs[i + 1] - seg.hs[i]) * f;
    // Right of forward (cos h, sin h) is (−sin h, cos h).
    out.x = x - Math.sin(h) * d;
    out.z = z + Math.cos(h) * d;
    return out;
  }

  /** Lane props for one segment: rows that always leave at least one lane open. */
  private addProps(seg: Segment) {
    if (TUNING.proto.on) return this.addChunkProps(seg);
    const P = TUNING.props;
    if (seg.landmark) {
      this.addLandmarkProps(seg);
      this.lastRowAt = seg.s0 + seg.length;
      // No random rows inside a landmark, and a short breath after it.
      this.nextRowS = Math.max(this.nextRowS, seg.s0 + seg.length + P.rowGap[0]);
      return;
    }
    const rng = this.rng;
    const end = seg.s0 + seg.length;
    while (this.nextRowS < end) {
      const rowS = this.nextRowS;
      // Later segments shorten the random part of the gap; the minimum stays (rows closer than that can
      // stagger two bulldozers into a trap with no lane change between them: Law 1).
      this.nextRowS += P.rowGap[0] + (rng.range(P.rowGap[0], P.rowGap[1]) - P.rowGap[0]) * this.gapScale;
      // ...and the next slot never lands past the `maxEmpty` mark (a skipped roll can't leave a long hole).
      this.nextRowS = Math.max(rowS + P.rowGap[0], Math.min(this.nextRowS, this.lastRowAt + TUNING.pacing.maxEmpty));
      if (rowS < seg.s0) continue;
      // Pacing: the chance rolls can skip a row, but never leave more than `maxEmpty` metres of nothing.
      const overdue = rowS - this.lastRowAt >= TUNING.pacing.maxEmpty;
      const skip = !rng.chance(P.rowChance) || !rng.chance(TUNING.zones.rowChance[seg.zone]);
      if (skip && !overdue) continue;
      // Only lanes usable through the whole row, so nothing sits in a closing merge lane.
      const lanes = Math.min(this.lanesAt(rowS - 6), this.lanesAt(rowS), this.lanesAt(Math.min(rowS + 6, end - 0.01)));
      if (lanes < 2) continue;
      const prevRowAt = this.lastRowAt;
      this.lastRowAt = rowS;
      const PR = TUNING.proto;
      // Prototype (dodge in Stride): wide roads fill up (up to all but one lane, at least `wideMinBlocked` of them).
      const maxBlocked = PR.on && lanes >= 4 ? lanes - 1 : Math.max(1, Math.min(lanes - 1, Math.floor(lanes * P.maxBlockedShare)));
      const k = rng.int(PR.on && lanes >= 4 ? Math.min(maxBlocked, PR.wideMinBlocked) : 1, maxBlocked);
      const order = Array.from({ length: lanes }, (_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = rng.int(0, i);
        [order[i], order[j]] = [order[j], order[i]];
      }
      // Difficulty by segment (2026-11-17): bulldozers and concrete (what Stride can't break) thicken as the run goes on;
      // `hardPerRow` caps them in one row (every row still leaves a lane open).
      const D = TUNING.difficulty;
      const di = Math.min(this.segmentNo, D.dozer.length - 1);
      let hard = 0;
      const hardLanes: number[] = [];
      let blocked = order.slice(0, k);
      // Prototype: a row this close behind the last can't close every lane the last one left open: there's always
      // a line through without a lane change he has no time to make (Mike, 2026-11-18: forced hits on 2-lane roads).
      if (PR.on && rowS - prevRowAt < PR.reachGap && this.lastOpen.length && this.lastOpen.every((l) => blocked.includes(l))) {
        const keep = this.lastOpen.find((l) => l < lanes);
        if (keep !== undefined) blocked = blocked.filter((l) => l !== keep);
      }
      this.lastOpen = order.filter((l) => !blocked.includes(l));
      for (const lane of blocked) {
        const mw = TUNING.zones.mediumWeight[seg.zone];
        const heavy = rng.next() >= mw;
        // Never two side by side: a wall of two beside the edge lane left no way out but through one (Law 1).
        const canHard = hard < D.hardPerRow[di] && rowS >= this.hardFrom && !hardLanes.some((l) => Math.abs(l - lane) === 1);
        const immovable = canHard && rng.chance(Math.min(0.9, D.dozer[di] * this.hardMult));
        const concrete = !immovable && heavy && canHard && rng.chance(Math.min(0.9, D.concrete[di] * this.hardMult));
        if (immovable || concrete) {
          hard++;
          hardLanes.push(lane);
        }
        const kind: PropKind = immovable ? 'dozer' : concrete ? 'barricade' : heavy && rng.chance(TUNING.targets.newsvanChance) ? 'newsvan' : rng.pick(heavy ? HEAVY : MEDIUM);
        const def = PROP_DEFS[kind];
        this.props.push({
          id: this.propId++,
          kind,
          cls: def.cls,
          mat: def.mat,
          s: rowS + rng.range(-1.5, 1.5),
          d: this.laneCenter(lane) + rng.range(-0.3, 0.3),
          hl: def.hl,
          hw: def.hw,
          h: def.h,
          variant: rng.int(0, def.variants - 1),
          ...(def.rampOnly ? { rampOnly: true } : {}),
          alive: true,
          segment: seg.index,
        });
      }
    }
  }

  /** Prototype: the chunk being laid down (its start, the next row to place), and where the next may start. */
  private chunk: { c: Chunk; s0: number; row: number; last: number } | null = null;
  private nextChunkS: number = TUNING.proto.on ? TUNING.proto.firstChunk : TUNING.props.startAt;
  /** Story run: the district being generated (-1 before the course), and where the course ends (m, once known). */
  private district = TUNING.proto.on ? 0 : -1;
  courseEnd = Infinity;
  /** Story run: the district the road is in now (the counter above runs ahead of it through the merge into the next). */
  private zoneDistrict = 0;
  private lastChunkId = '';

  /** Chunk level (1–5) at `s`: climbs with distance and the run's segment. */
  /** Heavy Load (a traffic mod): every pick one level harder, capped at 5. */
  levelBonus = 0;
  /** Story districts as they're laid down (target cars go one per district). */
  readonly districtSpans: { k: number; s0: number; s1: number }[] = [];
  private targeted = new Set<number>();
  private nextTargetS: number = TUNING.proto.target.endlessEvery;

  /**
   * Target cars (Mike, 2026-11-24: "target cars to crush, even more points if done with Rampage"): one marked cash van
   * per district, in the gap between two chunks (so every chunk's fairness proof stands), on his side of a two-way
   * road. It breaks in Stride (like a rival van); Rampage doubles its bonus. Endless: one every `endlessEvery` m.
   */
  private maybeTarget(s: number) {
    const X = TUNING.proto.target;
    let due = false;
    if (this.districtSpans.length) {
      const span = this.districtSpans.find((d) => s >= d.s0 && s < d.s1);
      if (span && !this.targeted.has(span.k) && s >= span.s0 + (span.s1 - span.s0) * X.share) {
        this.targeted.add(span.k);
        due = true;
      }
    } else if (this.district < 0 && s >= this.nextTargetS) {
      this.nextTargetS = s + X.endlessEvery;
      due = true;
    }
    if (!due) return;
    const at = s + TUNING.proto.chunkGap * 0.5;
    const tw = this.twoWay.find((w) => at >= w.s0 && at <= w.s1);
    const L = this.lanesAt(at);
    const first = tw ? tw.split : 0;
    if (L - first < 1) return;
    const lane = this.rng.int(first, L - 1);
    if (!this.laneUsable(lane, at)) return;
    const p = this.drop('van', at, this.laneCenter(lane));
    p.bounty = true;
  }
  /** Heavy Load: every district takes only its top-level chunks (no breathers), like the finale. */
  allPeak = false;

  levelAt(s: number): number {
    if (this.district >= 0) return Math.min(5, TUNING.proto.story.districts[Math.min(this.district, TUNING.proto.story.districts.length - 1)].level + this.levelBonus);
    return Math.max(1, Math.min(5, 1 + this.levelBonus + this.segmentNo + Math.floor(s / TUNING.proto.levelEvery)));
  }

  /**
   * Prototype: authored chunks (src/sim/chunks.ts, each proven passable) in place of random rows. A chunk is picked
   * for the lane count where it starts; if the road changes lane count under it (a merge), it stops there and the
   * next starts a full `chunkGap` after its last row, so the solver's entry assumption always holds.
   */
  private addChunkProps(seg: Segment) {
    const end = seg.s0 + seg.length;
    const gap = TUNING.proto.chunkGap;
    for (let guard = 0; guard < 64; guard++) {
      if (!this.chunk) {
        const s0 = Math.max(this.nextChunkS, seg.s0);
        if (s0 >= end) return;
        const lanes = this.lanesAt(s0);
        const span = this.twoWay.find((w) => w.district && s0 >= w.s0 && s0 < w.s1);
        const c = this.pickChunk(lanes, this.levelAt(s0), seg.zone, span?.split ?? 0);
        if (!c) {
          this.nextChunkS = s0 + 10;
          continue;
        }
        this.chunk = { c, s0, row: 0, last: s0 };
        this.lastChunkId = c.id;
        if (c.oncoming && !span) {
          const left = c.oncoming[0] === 'o';
          const n = [...c.oncoming].filter((x) => x === 'o').length;
          this.twoWay.push({ s0: s0 - 12, s1: s0 + chunkLength(c) + 12, split: left ? n : c.lanes - n });
        }
      }
      const ch = this.chunk;
      const [ds, pattern] = ch.c.rows[ch.row];
      const s = ch.s0 + ds;
      if (s >= end) return; // the rest goes on the next segment
      const ok = [s - 6, s, s + 6].every((x) => this.lanesAt(x) === ch.c.lanes) && Array.from({ length: ch.c.lanes }, (_, l) => this.laneUsable(l, s)).every(Boolean);
      if (!ok) {
        // The road changed under it: stop this chunk; the next one waits a full gap.
        this.chunk = null;
        this.nextChunkS = ch.last + gap;
        continue;
      }
      for (let l = 0; l < pattern.length; l++) {
        const k = CHUNK_KINDS[pattern[l]];
        if (!k) continue;
        const at = s + this.rng.range(-0.6, 0.6);
        const ch2 = pattern[l];
        if (ch2 === 'o' || ch2 === 't') {
          // Moving traffic: placed now, held until he's near, confined to this chunk.
          this.place(k as PropKind, at, l, seg);
          const m = this.props.pop()!;
          const P = TUNING.proto;
          m.mover = { v: ch2 === 'o' ? -P.oncomingSpeed : P.truckSpeed, meet: at, min: ch.s0 - 2, max: ch.s0 + chunkLength(ch.c) + 6, active: false };
          if (ch2 === 'o') m.oncoming = true;
          this.movers.push(m);
        } else this.place(k === 'small' ? this.rng.pick(SMALL_KINDS) : k, at, l, seg);
      }
      ch.last = s;
      this.lastRowAt = s;
      if (++ch.row >= ch.c.rows.length) {
        this.chunk = null;
        this.nextChunkS = s + gap;
        this.maybeTarget(s);
      }
    }
  }

  private pickChunk(lanes: number, level: number, zone: string, oncoming = 0): Chunk | null {
    // Endless: two-way stretches can run either side (mirrored); the story keeps them on the left.
    const pool = this.district < 0 ? [...CHUNKS, ...CHUNKS.filter((c) => c.oncoming).map(mirror)] : CHUNKS;
    // A two-way district takes only chunks with its oncoming lanes on the left (the road commits to it the whole way).
    const left = (c: Chunk) => !oncoming || ((c.oncoming ? c.oncoming.indexOf('.') : 0) === oncoming && (!c.oncoming || !c.oncoming.slice(oncoming).includes('o')));
    const fits = pool.filter((c) => c.lanes === lanes && c.level <= level && (!c.zones || c.zones.includes(zone)) && c.id !== this.lastChunkId && left(c));
    if (!fits.length) return null;
    // Mostly at the current level, sometimes a breather from below.
    const top = fits.filter((c) => c.level >= level - 1);
    const peak = this.district >= 0 && TUNING.proto.story.districts[Math.min(this.district, TUNING.proto.story.districts.length - 1)].peak;
    const best = fits.filter((c) => c.level >= level);
    if ((peak || this.allPeak) && best.length) return this.rng.pick(best);
    return this.rng.pick(top.length && this.rng.chance(0.75) ? top : fits);
  }

  private place(kind: PropKind, s: number, lane: number, seg: Segment, jitter = 0.2) {
    const def = PROP_DEFS[kind];
    this.props.push({
      id: this.propId++,
      kind,
      cls: def.cls,
      mat: def.mat,
      s,
      d: this.laneCenter(lane) + this.rng.range(-jitter, jitter),
      hl: def.hl,
      hw: def.hw,
      h: def.h,
      variant: this.rng.int(0, def.variants - 1),
      ...(def.rampOnly ? { rampOnly: true } : {}),
      alive: true,
      segment: seg.index,
    });
  }

  /** A landmark's own pattern (see TUNING.landmarks): every row leaves at least one lane open. */
  private addLandmarkProps(seg: Segment) {
    const LM = TUNING.landmarks;
    const rng = this.rng;
    const lanes = seg.lanes0;
    const rows = LM.rows[seg.landmark!].map((r) => seg.s0 + r);
    switch (seg.landmark!) {
      case 'toll': {
        const open = rng.int(0, lanes - 1);
        for (let l = 0; l < lanes; l++) if (l !== open) this.place('tollgate', rows[0], l, seg, 0);
        break;
      }
      case 'foodtrucks': {
        let open = rng.int(0, lanes - 1);
        for (const s of rows) {
          for (let l = 0; l < lanes; l++) if (l !== open) this.place(rng.chance(LM.truckShare) ? 'foodtruck' : 'cart', s + rng.range(-1, 1), l, seg);
          open = (open + rng.int(1, lanes - 1)) % lanes; // a different lane next row
        }
        break;
      }
      case 'works': {
        const closed = rng.chance(0.5) ? 0 : lanes - 1;
        for (const s of rows) this.place('barricade', s, closed, seg, 0);
        break;
      }
      case 'jam': {
        let open = rng.int(0, lanes - 1);
        for (const s of rows) {
          for (let l = 0; l < lanes; l++) if (l !== open) this.place(rng.chance(0.75) ? 'car' : 'van', s + rng.range(-1.2, 1.2), l, seg);
          open = Math.max(0, Math.min(lanes - 1, open + rng.int(-1, 1))); // reachable: at most one lane a row
        }
        break;
      }
    }
  }

  /**
   * Car carrier: a stalled car dropped into a lane at `s`, kept in order along the road (propsBetween
   * relies on it). Returns the new prop.
   */
  drop(kind: PropKind, s: number, d: number): Prop {
    const def = PROP_DEFS[kind];
    const p: Prop = { id: this.propId++, kind, cls: def.cls, mat: def.mat, s, d, hl: def.hl, hw: def.hw, h: def.h, variant: this.rng.int(0, def.variants - 1), alive: true, segment: this.segmentAt(s).index, ...(def.rampOnly ? { rampOnly: true } : {}) };
    let i = this.props.length;
    while (i > 0 && this.props[i - 1].s > s) i--;
    this.props.splice(i, 0, p);
    return p;
  }

  /**
   * Rampage surge (TUNING.targets): rows of traffic between s0 and s1 (already generated road, past the frame),
   * `fill` lanes a row, never every lane, never on top of what's there. Rival vans at `surgeVanChance`.
   */
  /** Police hardware on the road (set by the sim), so a surge never drops traffic under a roadblock. */
  occupied: (s0: number, s1: number) => { d: number; hw: number }[] = () => [];
  /** Police units and the escort between s0 and s1 (set by the sim): moving traffic brakes for them too. */
  vehicles: (s0: number, s1: number) => { s: number; d: number; hl: number; hw: number }[] = () => [];

  surge(s0: number, s1: number) {
    const T = TUNING.targets;
    const rng = this.rng;
    for (let s = s0; s < s1; s += rng.range(T.rowGap[0], T.rowGap[1])) {
      const lanes = Math.min(this.lanesAt(s - 4), this.lanesAt(s), this.lanesAt(s + 4));
      if (lanes < 2) continue;
      const n = Math.min(lanes - 1, rng.int(T.fill[0], T.fill[1]));
      const order = Array.from({ length: lanes }, (_, i) => i).sort(() => rng.next() - 0.5);
      for (const lane of order.slice(0, n)) {
        const c = this.laneCenter(lane);
        if (this.propsBetween(s - 6, s + 6).some((p) => Math.abs(p.d - c) < p.hw + 1.2)) continue;
        if (this.occupied(s - 6, s + 6).some((p) => Math.abs(p.d - c) < p.hw + 1.2)) continue;
        const kind: PropKind = rng.chance(T.surgeVanChance) ? 'newsvan' : rng.pick(rng.chance(0.6) ? HEAVY : MEDIUM);
        this.drop(kind, s + rng.range(-1, 1), c + rng.range(-0.25, 0.25));
      }
    }
  }

  /** Live props overlapping [s0, s1] along the road. */
  propsBetween(s0: number, s1: number, out: Prop[] = []): Prop[] {
    out.length = 0;
    for (const p of this.props) {
      if (p.s - p.hl > s1 + 4) break; // rows are generated in order; ±1.5m jitter within a row
      if (p.alive && p.s + p.hl >= s0 && p.s - p.hl <= s1) out.push(p);
    }
    for (const p of this.movers) if (p.alive && p.s + p.hl >= s0 && p.s - p.hl <= s1) out.push(p);
    return out;
  }
}
