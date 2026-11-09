/**
 * Every gameplay number lives here, each with its reason (GDD §31).
 * Units: metres, seconds, degrees unless noted. Sim runs at a 60 Hz fixed tick.
 *
 * LOCKED values are marked and must not change without a GDD revision:
 *   - segment shape (150s + 15s grace)
 *   - Law 1 speed floor (2 m/s)
 *   - no-spawn-on-screen distance (40m)
 */

export type MassClass = 'light' | 'medium' | 'heavy' | 'immovable';

export interface TierTuning {
  name: 'Jog' | 'Stride' | 'Rampage';
  /** §9 top speed. */
  topSpeed: number;
  /** §9 acceleration toward top speed. */
  accel: number;
  /** §9 max turn rate. */
  turnRateDeg: number;
  /** §9 seconds held at top speed before tiering up. Infinity = top tier. */
  tierUpAfter: number;
  /**
   * How quickly the direction of travel catches up to the facing (1/s).
   * Lower = more drift. §9 table: Jog tight, Stride wide, Rampage "very wide, drifty".
   */
  grip: number;
  /**
   * Time constant for turn rate to reach the requested rate. Gives the
   * "committed, slightly late on turns" feel (§9) without feeling unresponsive.
   */
  turnLag: number;
  /** Highest mass class this tier smashes (§9 collision table). */
  smashes: MassClass | null;
  /** Gait stride length: distance per footfall pair. Grows per tier (§10). */
  strideLength: number;
  /** Forward lean for the run cycle, degrees (§10, §24). */
  leanDeg: number;
  /** §15 camera distance (slant, camera to framed point) for this tier. */
  cameraDistance: number;
}

export const TUNING = {
  sim: {
    /** §29 fixed step. */
    hz: 60,
  },

  giant: {
    /** §9 the giant is 3.6m tall. */
    height: 3.6,
    /** Collision circle. Roughly shoulder width; reads as huge next to 1.8m people. */
    radius: 1.1,
    /** LOCKED (§9, Law 1): the giant always runs; speed never below 2 m/s. */
    speedFloor: 2,
    /** Starting tier index and speed: drop in already jogging. */
    startSpeed: 4,
    /** A tier counts as "at top speed" within this fraction of it. Avoids float flicker. */
    topSpeedEpsilon: 0.98,
    /** When a tier drops, excess speed bleeds off at this rate (not a brake; feels like a gear-down). */
    overspeedDecel: 7,
  },

  /** §9 momentum tiers. */
  tiers: [
    { name: 'Jog', topSpeed: 6, accel: 8, turnRateDeg: 220, tierUpAfter: 2.0, grip: 16, turnLag: 0.06, smashes: 'light', strideLength: 2.2, leanDeg: 10, cameraDistance: 30 },
    { name: 'Stride', topSpeed: 10, accel: 6, turnRateDeg: 140, tierUpAfter: 3.0, grip: 7.5, turnLag: 0.09, smashes: 'medium', strideLength: 3.2, leanDeg: 18, cameraDistance: 38 },
    { name: 'Rampage', topSpeed: 15, accel: 4, turnRateDeg: 85, tierUpAfter: Infinity, grip: 3.6, turnLag: 0.13, smashes: 'heavy', strideLength: 4.4, leanDeg: 28, cameraDistance: 50 },
  ] as TierTuning[],

  tierDrop: {
    /** §9 turning more than this within the window drops a tier. */
    sharpTurnDeg: 110,
    sharpTurnWindow: 0.5,
    /** An aim yank re-arms once the aim comes back within this of the facing. */
    yankReleaseDeg: 60,
    /** §9 braking longer than this drops a tier (repeats while held). */
    brakeHold: 0.4,
    /** §9 stumble length after an unsmashable impact. */
    stumbleTime: 0.3,
    /** During a stumble, turning is sluggish (wobble), never a full stop. */
    stumbleTurnMul: 0.35,
  },

  brake: {
    /** §9 brake deceleration. */
    decel: 14,
    /** §7 turn rate multiplier while braking. */
    turnMul: 1.6,
    /** §7 brake floor equals the Law 1 floor. */
    floor: 2,
  },

  shoulderCheck: {
    /** §7 0.25s burst that smashes one mass class up. */
    duration: 0.25,
    cooldown: 3,
    /** Extra speed during the burst; must feel like a lunge, not a dash. */
    burstSpeed: 3,
    /** §8 5-frame input buffer. */
    bufferFrames: 5,
    /** Pedestrian shove radius of the shockwave ring (§10 "pedestrians fan out"). */
    shoveRadius: 6,
  },

  collision: {
    /** Speed kept after bouncing off something you can't smash. Never a stop. */
    bounceSpeedKeep: 0.55,
    /** Speed lost on a smash, by class. Smash "must never stall momentum" (§10). */
    smashSpeedLoss: { light: 0, medium: 0.02, heavy: 0.06, immovable: 0 } as Record<MassClass, number>,
    /** How far knocked light props fly (m/s impulse scale). Cosmetic. */
    knockImpulse: 1.0,
  },

  /** §10 impact scale (hitstop in 60 Hz frames, shake in px, haptic ms). */
  impact: {
    light: { hitstop: 0, shake: 0, flashFrames: 0, haptic: 0, hapticStrength: 0 },
    medium: { hitstop: 3, shake: 2, flashFrames: 0, haptic: 60, hapticStrength: 0.35 },
    heavy: { hitstop: 6, shake: 5, flashFrames: 1, haptic: 120, hapticStrength: 0.9 },
    landmark: { hitstop: 10, shake: 8, flashFrames: 2, haptic: 250, hapticStrength: 1 },
    bounce: { hitstop: 2, shake: 3, flashFrames: 0, haptic: 90, hapticStrength: 0.5 },
  },

  /**
   * §15 oblique news-chopper camera (rev 2026-11-10): high, angled, offset to
   * one side, looking down the street ahead like a real broadcast shot.
   */
  camera: {
    /** Tilt below horizontal. Oblique, not top-down: you see the street ahead. */
    pitchDeg: 48,
    /** Slightly telephoto; flattens the city like a long lens. */
    fov: 35,
    /** The camera sits this far off the giant's heading, to one side. */
    sideAngleDeg: 25,
    /** Swing sides only after turning one way this long: a pilot repositioning, not a twitch. */
    sideSwitchAfter: 2,
    /** Turning slower than this (deg/s) doesn't count toward a side swing. */
    sideSwitchMinTurnDegPerSec: 25,
    /** How long the swing to the other side takes (eased). */
    sideSwitchTime: 2.5,
    /** Frame the point this many seconds ahead of the giant (speed × time). */
    lookAheadTime: 1.6,
    /**
     * Cap on the look-ahead so the giant never sits lower than this fraction of
     * the screen height (0 top, 1 bottom). Keeps it in the lower third with room
     * for what's behind it. At §15 distances the cap binds at Stride and Rampage.
     */
    giantMaxScreenY: 0.85,
    /** Distance changes between tiers ease over this long. */
    distanceEase: 0.8,
    /** Lag on the camera's position and on its look target. */
    positionLag: 0.35,
    lookLag: 0.2,
    wobbleDeg: 0.3,
    wobbleHz: 0.4,
    /** Line-of-sight: raise the camera (never cut through) when a building blocks the giant. */
    occlusionRaiseStep: 2,
    occlusionMaxRaise: 60,
    /** Raise fast so the giant is never hidden for long; settle back slowly. */
    occlusionRaiseLag: 0.15,
    occlusionLowerLag: 0.8,
    /** §15 heavy smash jolt. */
    joltPx: 5,
    joltTime: 0.1,
    /** §10 tier-up: brief camera pull-out (extra metres of distance, decays). */
    tierUpPullOut: 6,
    tierUpPullOutTime: 0.5,
    /** Footfall micro-shake by tier, px. Rampage footfalls must be felt. */
    footfallShakePx: [0, 0.6, 1.6],
  },

  /** Phase 0 test block (§16 block size; §40 "one block of breakable props"). */
  block: {
    /** §16 hand-built 60×60m blocks. */
    cell: 60,
    /** Phase 0 test area, cells per side. Big enough to sustain Rampage between corners. */
    cellsPerSide: 5,
    /** Building footprint inside a cell; the rest is street and sidewalk. */
    buildingSize: 36,
    sidewalk: 4,
    buildingHeight: [6, 18] as [number, number],
    /** Fraction of cells that are open plazas or lots instead of buildings. */
    openCellChance: 0.3,
    /** Destroyed props respawn after this long, only when far from the giant (off camera). */
    respawnAfter: 20,
    respawnMinDistance: 40,
    pedestrians: 70,
  },

  pedestrian: {
    /** §9 pedestrians are 1.8m. */
    height: 1.8,
    radius: 0.35,
    walkSpeed: 1.4,
    fleeSpeed: 5.5,
    /** Start diving clear when the giant is this close and heading their way. */
    fleeRadius: 11,
    /** Comic tumble after a shove; nobody is ever shown hurt (§9). */
    tumbleTime: 1.4,
    shoveSpeed: 9,
  },
} as const;

export type Tuning = typeof TUNING;
