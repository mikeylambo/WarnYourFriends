import { TUNING, type MassClass } from '../tuning';
import { Rng } from './rng';
import { DEG, clamp } from './math';
import type { Material, Prop, PropKind } from './types';

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
  /** Phase 2 road variety: which stretch of road this is, and its (invented) name. */
  zone: ZoneKind;
  zoneName: string;
  /** First segment of its zone. */
  zoneStart: boolean;
  /** Highway only: a road bridge crosses overhead (presentation). */
  overpass: boolean;
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
}

/** Lane props: Medium and Heavy (v0.3), plus the immovable dozer (impact pass). */
export const PROP_DEFS: Record<PropKind, PropDef> = {
  sawhorse: { cls: 'medium', mat: 'wood', hl: 0.3, hw: 1.4, h: 1.1, variants: 2 },
  cart: { cls: 'medium', mat: 'fruit', hl: 0.9, hw: 0.6, h: 1.3, variants: 3 },
  fence: { cls: 'medium', mat: 'metal', hl: 0.15, hw: 1.8, h: 1.4, variants: 1 },
  scooter: { cls: 'medium', mat: 'metal', hl: 0.9, hw: 0.35, h: 1.1, variants: 3 },
  car: { cls: 'heavy', mat: 'metal', hl: 2.2, hw: 0.95, h: 1.5, variants: 5 },
  van: { cls: 'heavy', mat: 'metal', hl: 2.7, hw: 1.1, h: 2.3, variants: 3 },
  barricade: { cls: 'heavy', mat: 'concrete', hl: 0.35, hw: 1.8, h: 0.95, variants: 1 },
  // Impact pass: the one lane prop nothing smashes (bounces him at any tier). Leap clears it.
  dozer: { cls: 'immovable', mat: 'metal', hl: 2.3, hw: 1.35, h: 2.4, variants: 1 },
  // Phase 2 police units (never placed as lane props; pursuit spawns them).
  cruiser: { cls: 'heavy', mat: 'metal', hl: 2.4, hw: 0.98, h: 1.7, variants: 1 },
  compact: { cls: 'medium', mat: 'metal', hl: 1.8, hw: 0.85, h: 1.4, variants: 1 },
};

const MEDIUM: PropKind[] = ['sawhorse', 'cart', 'fence', 'scooter'];
const HEAVY: PropKind[] = ['car', 'car', 'van', 'barricade'];

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
  private nextRowS: number;
  private propId = 0;
  private readonly rng: Rng;

  constructor(readonly seed: number) {
    this.rng = new Rng((seed ^ 0x7f4a7c15) >>> 0);
    const T = TUNING.track;
    this.nextMerge = T.runwaySegments + this.rng.int(T.mergeEvery[0], T.mergeEvery[1]);
    this.nextRowS = TUNING.props.startAt;
    this.zoneName = this.nameFor('highway');
    this.zoneLeft = T.runwaySegments + this.rng.int(TUNING.zones.length.highway[0], TUNING.zones.length.highway[1]);
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
  prune(s: number) {
    const keep = s - TUNING.track.keepBehind;
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
    const lanes0 = prev ? prev.lanes1 : L.start;
    const x0 = prev ? prev.xs[prev.xs.length - 1] : -(L.start * L.width) / 2; // road centred on x=0 at start
    const z0 = prev ? prev.zs[prev.zs.length - 1] : 0;
    const rng = this.rng;

    let kind: SegmentKind = 'straight';
    let h1 = h0;
    let lanes1 = lanes0;
    const Z = TUNING.zones;
    // Zones: when one runs out, pick the next; merge one lane per segment until its lane count is reached.
    if (index >= T.runwaySegments && this.zoneLeft <= 0 && !this.nextZone) {
      const options = (Object.keys(Z.lanes) as ZoneKind[]).filter((z) => z !== this.zone);
      this.nextZone = this.pickZone(options);
      this.zoneTarget = this.nextZone === 'highway' ? (rng.chance(0.7) ? 4 : 3) : Z.lanes[this.nextZone];
    }
    if (this.nextZone && lanes0 === this.zoneTarget) {
      this.zone = this.nextZone;
      this.zoneName = this.nameFor(this.zone);
      this.nextZone = null;
      this.zoneLeft = rng.int(Z.length[this.zone][0], Z.length[this.zone][1]);
      this.zoneJustStarted = true;
    }
    if (index >= T.runwaySegments) {
      if (this.nextZone && lanes0 !== this.zoneTarget) {
        kind = 'merge';
        lanes1 = lanes0 + Math.sign(this.zoneTarget - lanes0);
      } else if (this.zone === 'highway' && index >= this.nextMerge && this.zoneLeft > 1) {
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
    const overpass = zone === 'highway' && kind !== 'merge' && index >= T.runwaySegments && rng.chance(Z.overpassChance);
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
    const seg: Segment = { index, kind, s0, length: n, h0, h1, lanes0, lanes1, xs, zs, hs, zone, zoneName: this.zoneName, zoneStart, overpass };
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

  /** Can the sign-off ramp leave from this segment? (Not a merge; not into or out of a tunnel.) */
  exitEligible(seg: Segment): boolean {
    const next = this.segments.find((x) => x.index === seg.index + 1);
    return seg.kind !== 'merge' && seg.lanes0 === seg.lanes1 && seg.zone !== 'tunnel' && (!next || next.zone !== 'tunnel');
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
    const P = TUNING.props;
    if (seg.index < TUNING.track.runwaySegments) return;
    const rng = this.rng;
    const end = seg.s0 + seg.length;
    while (this.nextRowS < end) {
      const rowS = this.nextRowS;
      this.nextRowS += rng.range(P.rowGap[0], P.rowGap[1]);
      if (rowS < seg.s0 || !rng.chance(P.rowChance)) continue;
      // Only lanes usable through the whole row, so nothing sits in a closing merge lane.
      if (!rng.chance(TUNING.zones.rowChance[seg.zone])) continue;
      const lanes = Math.min(this.lanesAt(rowS - 6), this.lanesAt(rowS), this.lanesAt(Math.min(rowS + 6, end - 0.01)));
      if (lanes < 2) continue;
      const maxBlocked = Math.max(1, Math.min(lanes - 1, Math.floor(lanes * P.maxBlockedShare)));
      const k = rng.int(1, maxBlocked);
      const order = Array.from({ length: lanes }, (_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = rng.int(0, i);
        [order[i], order[j]] = [order[j], order[i]];
      }
      let dozers = 0;
      for (const lane of order.slice(0, k)) {
        const mw = TUNING.zones.mediumWeight[seg.zone];
        const heavy = rng.next() >= mw;
        // One immovable per row at most, never in the opening stretch.
        const immovable = dozers === 0 && P.immovableChance > 0 && rowS >= P.immovableFrom && rng.chance(P.immovableChance);
        if (immovable) dozers++;
        const kind: PropKind = immovable ? 'dozer' : rng.pick(heavy ? HEAVY : MEDIUM);
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
          alive: true,
          segment: seg.index,
        });
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
    return out;
  }
}
