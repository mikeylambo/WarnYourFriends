import type { MassClass } from '../tuning';

export type Material = 'wood' | 'glass' | 'metal' | 'fruit' | 'concrete' | 'paper';

export type PropKind = 'sawhorse' | 'cart' | 'fence' | 'scooter' | 'car' | 'van' | 'barricade';

/** A prop in a lane, in track space: `s` along the road, `d` across it from the left edge. */
export interface Prop {
  id: number;
  kind: PropKind;
  cls: MassClass;
  mat: Material;
  s: number;
  d: number;
  /** Half length along the road, half width across it. */
  hl: number;
  hw: number;
  /** Visual height. */
  h: number;
  variant: number;
  alive: boolean;
  /** Segment index it belongs to (for streaming). */
  segment: number;
}

export type LaneMove = 'change' | 'knock' | 'wallBump' | null;

export interface GiantState {
  /** Distance along the track (m). */
  s: number;
  /** Lateral offset from the road's left edge (m). */
  d: number;
  /** Lane the giant is in, or heading into during a move. */
  lane: number;
  /** Lane before the most recent lane change ("previous lane" for knock-backs). */
  prevLane: number;
  move: LaneMove;
  /** Lateral move progress 0..1 (1 = idle). */
  moveT: number;
  moveDur: number;
  moveFromD: number;
  moveToD: number;
  /** Lane the current move started in. */
  moveFromLane: number;
  /** Wall bump direction (−1 left, +1 right). */
  bumpDir: number;
  /** One queued lane input (−1, +1) or 0. */
  laneQueue: number;
  /** Buffered lane input that couldn't be taken yet, and frames left. */
  laneBufferDir: number;
  laneBufferFrames: number;

  speed: number;
  tier: number;
  tierTimer: number;
  stumble: number;
  brakeHeld: number;
  braking: boolean;
  shoulderT: number;
  shoulderCd: number;
  shoulderBuffer: number;

  /** Steps taken (integer part) plus progress through the current step: phase locked to distance. */
  stepPos: number;
  /** Current step length (m) = speed ÷ cadence. */
  stepLen: number;
  /** Total distance run (m). */
  odometer: number;
}

export interface SimInput {
  /** Lane input edge: −1 left, +1 right, 0 none. */
  lane: number;
  brake: boolean;
  /** True on the frame the button was pressed. */
  shoulder: boolean;
}

export const NO_INPUT: SimInput = { lane: 0, brake: false, shoulder: false };

export type TierDropReason = 'impact' | 'brake';

export type SimEvent =
  | { type: 'smash'; propId: number; cls: MassClass; mat: Material; s: number; d: number; across: boolean; speed: number }
  | { type: 'bounce'; propId: number; cls: MassClass; s: number; d: number; toLane: number; speed: number }
  | { type: 'laneChange'; from: number; to: number; dur: number }
  | { type: 'wallBump'; dir: number; forced: boolean }
  | { type: 'tierUp'; tier: number }
  | { type: 'tierDown'; tier: number; reason: TierDropReason }
  /** `t` is the exact sim time of the plant (sub-tick), for cadence measurement. */
  | { type: 'footfall'; tier: number; foot: 0 | 1; step: number; t: number; s: number; d: number; speed: number; stepLen: number }
  | { type: 'shoulder'; s: number; d: number }
  /** Phase 0c: the giant enters a merge segment (lane count changes from `from` to `to`). */
  | { type: 'merge'; from: number; to: number; s: number }
  /** Phase 0c: an escort cruiser joins the chase, `behind` metres back. */
  | { type: 'escortJoin'; id: number; behind: number };
