import type { AbilityId, MassClass } from '../tuning';

export type Material = 'wood' | 'glass' | 'metal' | 'fruit' | 'concrete' | 'paper';

export type PropKind = 'sawhorse' | 'cart' | 'fence' | 'scooter' | 'car' | 'van' | 'barricade' | 'dozer' | 'cruiser' | 'compact';

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
  /** Impact pass: already judged as passed (dodge or not). */
  judged?: boolean;
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

  // --- Phase 3 abilities ---
  abilityCd: number;
  abilityBuffer: number;
  /** Leap: time left airborne (s), and its total. */
  air: number;
  airDur: number;
  /** Hijack Hop: time left riding (s). */
  ride: number;
  /** Pose for the Camera: time left holding the pose (s). */
  pose: number;
}

export interface SimInput {
  /** Lane input edge: −1 left, +1 right, 0 none. */
  lane: number;
  brake: boolean;
  /** True on the frame the button was pressed. */
  shoulder: boolean;
  /** Phase 3: ability button (edge), 5f buffer. */
  ability?: boolean;
}

export const NO_INPUT: SimInput = { lane: 0, brake: false, shoulder: false, ability: false };

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
  | { type: 'escortJoin'; id: number; behind: number }
  // --- Phase 2 (core playable) ---
  /** A pursuer enters (spawned ≥40m away, off camera). `eta` = seconds until it reaches the giant's frame. */
  | { type: 'unitSpawn'; id: number; kind: UnitKind; s: number; d: number; lanes: number[] }
  /** A threat starts its tell (windup). */
  | { type: 'tell'; id: number; kind: UnitKind; lane: number; time: number }
  /** A cruiser swerves into the giant's lane. */
  | { type: 'ram'; id: number; hit: boolean }
  | { type: 'nearMiss'; id: number }
  /** Passed close by something that would have bounced him (impact pass). */
  | { type: 'dodge'; propId: number; s: number; d: number; gap: number }
  | { type: 'lostTrack'; id: number; kind: UnitKind }
  | { type: 'spiked'; id: number }
  | { type: 'ratings'; delta: number; cause: GainType; ratings: number }
  | { type: 'heat'; heat: number }
  | { type: 'exitOpen'; s: number; segment: number; lane: number }
  | { type: 'exitMissed'; s: number }
  | { type: 'signOff'; ratings: number; banked: number }
  | { type: 'busted'; reason: BustReason }
  /** Phase 3: an ability fired (ok) or the button was pressed with nothing to do (e.g. no car to hijack). */
  | { type: 'ability'; id: AbilityId; ok: boolean }
  | { type: 'leapLand'; s: number; d: number; smashed: number }
  | { type: 'stare'; moved: { id: number; from: number; to: number }[]; backedOff: number }
  | { type: 'hijack'; propId: number; kind: PropKind; variant: number }
  | { type: 'hijackBail'; s: number; d: number }
  | { type: 'pose'; gain: number; heat: number }
  /** Phase 2 road variety: the giant enters a new stretch of road. */
  | { type: 'zone'; zone: 'highway' | 'avenue' | 'bridge' | 'tunnel'; name: string };

export type UnitKind = 'cruiser' | 'rolling' | 'roadblock' | 'spike';
/** §12 gain sources. */
export type GainType = 'medium' | 'heavy' | 'nearMiss' | 'lostTrack' | 'rampage' | 'pose';
export type BustReason = 'ratings' | 'pin' | 'missed';
export type ShowState = 'live' | 'cleared' | 'busted';

/** A pursuer or police hazard. Solid units collide like props (same class rules). */
export interface Unit extends Prop {
  unit: UnitKind;
  /** approach → tell (windup) → act → leave. */
  phase: 'approach' | 'tell' | 'act' | 'leave';
  phaseT: number;
  speed: number;
  /** Lane it occupies or moves toward; for spikes and roadblocks, the lane it covers. */
  lane: number;
  fromD: number;
  toD: number;
  /** Rolling/static roadblock row this car belongs to. */
  group: number;
  solid: boolean;
  /** Rams: the lane it will swerve into. */
  target: number;
  hit: boolean;
  nearMissed: boolean;
  lost: boolean;
}
