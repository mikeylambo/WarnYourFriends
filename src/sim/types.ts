import type { AbilityId, MassClass } from '../tuning';

export type Material = 'wood' | 'glass' | 'metal' | 'fruit' | 'concrete' | 'paper';

export type PropKind = 'sawhorse' | 'cart' | 'fence' | 'scooter' | 'car' | 'van' | 'barricade' | 'dozer' | 'cruiser' | 'compact' | 'tollgate' | 'foodtruck' | 'armored' | 'carrier' | 'newsvan' | 'scoop';

/** Content pass (Mike, 2026-11-15): landmark set pieces, one per segment (v0.3 §16: landmarks become segments). */
export type LandmarkKind = 'toll' | 'foodtrucks' | 'works' | 'jam';

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
  /** The closest it came to him alongside (m, edge to hit-box), for the close-call judgement. */
  closest?: number;
  /** A target car: breaks in Stride, pays `proto.target` points (doubled in Rampage). */
  bounty?: boolean;
  /** Segment index it belongs to (for streaming). */
  segment: number;
  /** Rampage timing (2026-11-17): breaks only in Rampage (concrete, police roadblocks); unbreakable until then. */
  rampOnly?: boolean;
  /**
   * Prototype moving traffic: its speed along the road (m/s; negative drives at him), the spot it's meant to pass
   * him (`meet`), and the chunk it stays inside [`min`, `max`]. It waits until he's `wake` metres out, then drives.
   */
  /** Drives toward him (presentation turns it round). */
  oncoming?: boolean;
  mover?: { v: number; meet: number; min: number; max: number; active: boolean };
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
  /** Prototype sprint, 0..1: built by clean running, reset by a hit or the brake. */
  sprint: number;
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
  /** The second ability slot's cooldown and input buffer. */
  ability2Cd: number;
  ability2Buffer: number;
  /** Leap / Breakaway: time left airborne (s), and its total; which one it is. */
  air: number;
  airDur: number;
  airKind: 'leap' | 'breakaway';
  /** Prime Time: time left on air (s). */
  prime: number;
  /** Thick Skin: gear-costing hits left to shrug off this segment. */
  skin: number;
  /** Second Wind: the highest gear he's had this segment. */
  peakTier: number;
  /** Rampage meter 0..100: stunts in Stride fill it; full, the Rampage button fires it. */
  meter: number;
  /** Rampage: seconds left (0 when not in Rampage), and how long this one has run. */
  rampT: number;
  rampElapsed: number;
}

export interface SimInput {
  /** Lane input edge: −1 left, +1 right, 0 none. */
  lane: number;
  brake: boolean;
  /** True on the frame the button was pressed. The Rampage button (it was Shoulder Check; the field keeps its name for recorded inputs). */
  shoulder: boolean;
  /** Phase 3: ability button (edge), 5f buffer. */
  ability?: boolean;
  /** Abilities stack (2026-11-17): the second ability slot's button. */
  ability2?: boolean;
}

export const NO_INPUT: SimInput = { lane: 0, brake: false, shoulder: false, ability: false };

export type TierDropReason = 'impact' | 'brake' | 'slip' | 'rampageEnd';

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
  /** Rampage loop (2026-11-17): the meter filled; Rampage fired (how long it lasts); a hit cost meter (how much). */
  | { type: 'meterFull' }
  | { type: 'rampageStart'; time: number }
  | { type: 'rampageEnd' }
  /** A rival station's news van flattened (2026-11-17: something worth aiming for, Rampage most of all). */
  | { type: 'rival'; s: number; d: number }
  | { type: 'target'; s: number; d: number; rampage: boolean }
  /** Prototype: he ran through a Scoop (a collectible), worth audience and points. */
  | { type: 'scoop'; s: number; d: number }
  /** Ground Zero (passive): the blast when Rampage fires, and how much it flattened. */
  | { type: 'groundZero'; s: number; d: number; smashed: number }
  | { type: 'meterLoss'; amount: number; reason: TierDropReason }
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
  /** A fork's exit ramp opens ahead (gore at `s`), to the road `name`. */
  | { type: 'forkOpen'; s: number; segment: number; zone: string; name: string }
  /** He reached the fork: took the exit (`taken`) or stayed. Taking it rebuilds the road from segment `from`. */
  | { type: 'fork'; taken: boolean; zone: string; name: string; from: number; shaken: number }
  | { type: 'signOff'; ratings: number; banked: number }
  /** Spectacle chain (Mike's score): a stunt joined the chain. `add` is this stunt's points (before the chain multiplier). */
  | { type: 'chain'; count: number; mult: number; pending: number; add: number; cause: StuntType }
  /** A producer's ask moved: progress toward `n`; `done` banks `reward`; `failed` is for good. */
  | { type: 'ask'; id: string; progress: number; n: number; done: boolean; failed: boolean; reward: number }
  /** The chain ended: banked `points` (pending × mult, or × 1 when `dropped`). */
  | { type: 'chainEnd'; count: number; mult: number; points: number; dropped: boolean }
  | { type: 'busted'; reason: BustReason }
  /** Phase 3: an ability fired (ok) or the button was pressed with nothing to do. `level` I–III. */
  | { type: 'ability'; id: AbilityId; ok: boolean; level: number; slot?: 1 | 2 }
  | { type: 'leapLand'; s: number; d: number; smashed: number }
  | { type: 'stare'; moved: { id: number; from: number; to: number }[]; backedOff: number; crashed: number }
  /** Breakaway landed: what the slam smashed, and how many police behind lost him. */
  | { type: 'breakawayLand'; s: number; d: number; smashed: number; shaken: number }
  /** Prime Time on air (and off again). */
  | { type: 'primeTime'; on: boolean; time: number }
  /** Thick Skin shrugged off a hit (no gear lost). */
  | { type: 'thickSkin'; left: number }
  /** Police chopper spotlight locks onto the giant's lane (police arrive faster until shaken). */
  | { type: 'spotlight'; id: number; lane: number }
  /** A chasing cruiser ploughs through a Medium (or lighter) prop in its lane. */
  | { type: 'policeSmash'; id: number; propId: number; cls: MassClass; mat: Material; s: number; d: number; speed: number }
  /** A chasing cruiser crashes into something Heavy or immovable and is out of the chase; a Heavy prop goes with it. */
  | { type: 'policeCrash'; id: number; propId: number; propKind: PropKind; propCls: MassClass; propSmashed: boolean; s: number; d: number; speed: number; /** In the chopper's frame: news (Ratings, stunt, headline). */ onAir: boolean; /** It ran over a spike strip. */ spikes?: boolean; /** It left the road (The Stare III): it hit nothing in particular. */ offRoad?: boolean }
  /** Phase 2 road variety: the giant enters a new stretch of road. */
  | { type: 'zone'; zone: 'highway' | 'avenue' | 'bridge' | 'tunnel'; name: string }
  | { type: 'landmark'; kind: LandmarkKind; name: string; s: number }
  /** Police Net (2026-11-16): the first catch in a segment costs a gear and Ratings; the second busts him. */
  | { type: 'netSlip'; ratings: number; cause: PinCause }
  /** He broke out of a Police Net (it disperses). */
  | { type: 'netEscape'; id: number }
  /** A car carrier drops a car into a lane (presentation animates it off the deck). */
  | { type: 'carrierDrop'; carrierId: number; propId: number; s: number; d: number }

export type UnitKind = 'cruiser' | 'rolling' | 'roadblock' | 'spike' | 'chopper' | 'net' | 'carrier';
/** §12 gain sources. */
export type GainType = 'medium' | 'heavy' | 'nearMiss' | 'lostTrack' | 'rampage' | 'policeCrash' | 'collateral' | 'rival' | 'scoop' | 'target';
/** Spectacle stunts (score, not Ratings). */
export type StuntType = 'medium' | 'heavy' | 'unit' | 'policeCrash' | 'collateral' | 'nearMiss' | 'ramDodge' | 'lostTrack' | 'chopperShaken' | 'leapLand' | 'breakawayLand' | 'rival' | 'scoop' | 'target';
export type BustReason = 'ratings' | 'pin' | 'missed';
/** What filled the meter: boxed in by a Police Net, or caught crawling with police on his tail. */
export type PinCause = 'net' | 'caught';
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
  /** Caught: seconds it stays dropped back after he shook it off. */
  backOff?: number;
  /** Cruiser: seconds spent riding alongside him (it winds up only after `cruiser.holdAlongside`). */
  alongT?: number;
  /** Rams: the lane it will swerve into. */
  target: number;
  hit: boolean;
  nearMissed: boolean;
  lost: boolean;
  /** Chopper: lane changes counted toward shaking it, and time since the last one. */
  shakes: number;
  shakeT: number;
  /** Police Net flanker: nothing breaks it but a Shoulder Check (it counts as Heavy only during one). */
  ram?: boolean;
  /** Cruiser: seconds left holding a dodge (behind the frame) before rejoining his path. */
  avoid?: number;
  /** Car carrier: cars left to drop, and time to the next one. */
  drops?: number;
  dropT?: number;
}
