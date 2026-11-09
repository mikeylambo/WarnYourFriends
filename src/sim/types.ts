import type { MassClass } from '../tuning';

export type Material = 'wood' | 'glass' | 'metal' | 'fruit' | 'concrete' | 'paper';

export type PropKind =
  | 'bin'
  | 'mailbox'
  | 'newsbox'
  | 'cart'
  | 'planter'
  | 'stall'
  | 'fence'
  | 'bench'
  | 'bikerack'
  | 'car'
  | 'van'
  | 'barricade'
  | 'pillar'
  | 'building'
  | 'wall';

export interface Prop {
  id: number;
  kind: PropKind;
  cls: MassClass;
  mat: Material;
  /** Centre on the XZ plane. */
  x: number;
  z: number;
  /** Half extents (AABB on XZ). */
  hw: number;
  hd: number;
  /** Visual height. */
  h: number;
  /** Cosmetic colour variant index. */
  variant: number;
  alive: boolean;
  deadT: number;
}

export type PedState = 'walk' | 'flee' | 'tumble';

export interface Ped {
  id: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  heading: number;
  state: PedState;
  t: number;
  /** Cosmetic: tumble spin and colour. */
  spin: number;
  variant: number;
}

export interface GiantState {
  x: number;
  z: number;
  /** Facing angle (radians). Forward = (cos, sin) on XZ; screen-up is -Z. */
  heading: number;
  /** Direction of travel. Lags heading by tier grip: this is the drift. */
  travel: number;
  speed: number;
  angVel: number;
  tier: number;
  /** Seconds held at top speed toward the next tier-up. */
  tierTimer: number;
  stumble: number;
  brakeHeld: number;
  braking: boolean;
  shoulderT: number;
  shoulderCd: number;
  shoulderBuffer: number;
  /** Run-cycle phase in cycles; a footfall every 0.5. */
  gaitPhase: number;
  /** Per-tick steering heading deltas over the sharp-turn window. */
  turnLog: number[];
  /** Set after an aim-yank tier drop; clears when aim returns near the facing. */
  yankLatched: boolean;
}

export interface SimInput {
  /** Relative turn, -1 (left) .. 1 (right). Used by keyboard A/D. */
  turn: number;
  /** Absolute target heading (radians) from stick / mouse / touch, or null. */
  aim: number | null;
  brake: boolean;
  /** True on the frame the button was pressed. */
  shoulder: boolean;
}

export const NO_INPUT: SimInput = { turn: 0, aim: null, brake: false, shoulder: false };

export type TierDropReason = 'impact' | 'turn' | 'brake';

export type SimEvent =
  | { type: 'smash'; propId: number; cls: MassClass; mat: Material; x: number; z: number; dirX: number; dirZ: number; speed: number }
  | { type: 'knock'; propId: number; cls: MassClass; mat: Material; x: number; z: number; dirX: number; dirZ: number; speed: number }
  | { type: 'bounce'; cls: MassClass; x: number; z: number; nx: number; nz: number; speed: number }
  | { type: 'scrape'; x: number; z: number }
  | { type: 'tierUp'; tier: number }
  | { type: 'tierDown'; tier: number; reason: TierDropReason }
  | { type: 'footfall'; tier: number; foot: 0 | 1; x: number; z: number; speed: number }
  | { type: 'shoulder'; x: number; z: number; dirX: number; dirZ: number }
  | { type: 'shove'; pedId: number; x: number; z: number }
  | { type: 'respawn'; propId: number };
