/**
 * Every gameplay number lives here, each with its reason (GDD §31).
 * Units: metres, seconds, degrees unless noted. Sim runs at a 60 Hz fixed tick.
 * Phase 0b: lane runner (docs/GDD-v0.3-lane-runner.md).
 *
 * LOCKED values are marked and must not change without a GDD revision:
 *   - segment shape (150s + 15s grace)          (not used until Phase 2)
 *   - Law 1 speed floor (2 m/s)
 *   - no-spawn-on-screen distance (40m)          (not used until Phase 2)
 *   - screen-up law (travel points up the screen within ±35°)
 */

export type MassClass = 'light' | 'medium' | 'heavy' | 'immovable';

export interface TierTuning {
  name: 'Jog' | 'Stride' | 'Rampage';
  /** v0.2 §9 top speed (kept in v0.3). */
  topSpeed: number;
  /** v0.2 §9 acceleration toward top speed. */
  accel: number;
  /** v0.2 §9 seconds held at top speed before tiering up. Infinity = top tier. */
  tierUpAfter: number;
  /** Highest mass class this tier smashes (v0.2 §9 collision table). */
  smashes: MassClass | null;
  /** v0.3: lane change time. Heavier tiers commit longer. */
  laneChangeTime: number;
  /**
   * v0.3 run cycle: cadence (steps/s) at this tier's top speed. Cadence is
   * interpolated by speed between tiers, so it never leaves 2.0–2.3.
   */
  cadence: number;
  /**
   * v0.3 stride length as specified (m per step). Reference only: with feet
   * locked to distance, the stride actually used is speed ÷ cadence (DECISIONS.md).
   */
  specStrideLength: number;
  /** Forward lean of the torso, degrees: low and forward-driving (v0.3). */
  leanDeg: number;
  /** Hip height while running: lower = more driving posture. */
  hipHeight: number;
  /** Body drop at each plant (m). Grows per tier. */
  bodyDrop: number;
  /** Swing-foot lift at mid-swing (m). */
  footLift: number;
  /** Camera distance multiplier for this tier (zoom pulls out at higher tiers, v0.1). */
  cameraDistanceScale: number;
}

export interface CameraAngle {
  name: 'Chase High' | 'Wide Side' | 'Long Lens';
  /** Requested yaw off the direction of travel. Clamped by the screen-up law. */
  yawDeg: number;
  pitchDeg: number;
  /** Camera to framed point, before the tier scale. */
  distance: number;
  fov: number;
}

export const TUNING = {
  sim: {
    /** §29 fixed step. */
    hz: 60,
  },

  giant: {
    /** §9 the giant is 3.6m tall. */
    height: 3.6,
    /** Collision circle. Shoulder width; fits a 4m lane with room either side. */
    radius: 1.1,
    /** LOCKED (§9, Law 1): the giant always runs; speed never below 2 m/s. */
    speedFloor: 2,
    /** Drop in already jogging. */
    startSpeed: 4,
    /** A tier counts as "at top speed" within this fraction of it. Avoids float flicker. */
    topSpeedEpsilon: 0.98,
    /** When a tier drops, excess speed bleeds off at this rate (a gear-down, not a brake). */
    overspeedDecel: 7,
  },

  /** Momentum tiers: v0.2 speeds and timings, v0.3 lane-change times and run cycle. */
  tiers: [
    { name: 'Jog', topSpeed: 6, accel: 8, tierUpAfter: 2.0, smashes: 'light', laneChangeTime: 0.22, cadence: 2.0, specStrideLength: 2.5, leanDeg: 14, hipHeight: 1.5, bodyDrop: 0.12, footLift: 0.35, cameraDistanceScale: 0.9 },
    { name: 'Stride', topSpeed: 10, accel: 6, tierUpAfter: 3.0, smashes: 'medium', laneChangeTime: 0.3, cadence: 2.1, specStrideLength: 4.0, leanDeg: 22, hipHeight: 1.42, bodyDrop: 0.18, footLift: 0.5, cameraDistanceScale: 1.0 },
    { name: 'Rampage', topSpeed: 15, accel: 4, tierUpAfter: Infinity, smashes: 'heavy', laneChangeTime: 0.4, cadence: 2.3, specStrideLength: 6.0, leanDeg: 30, hipHeight: 1.34, bodyDrop: 0.26, footLift: 0.7, cameraDistanceScale: 1.15 },
  ] as TierTuning[],

  tierDrop: {
    /** §9 braking longer than this drops a tier (repeats while held). */
    brakeHold: 0.4,
    /** v0.3 stumble length after an unsmashable hit. */
    stumbleTime: 0.3,
  },

  brake: {
    /** §9 brake deceleration. */
    decel: 14,
    /** §7 brake floor equals the Law 1 floor. */
    floor: 2,
  },

  shoulderCheck: {
    /** §7 0.25s burst that smashes one mass class up (unchanged in v0.3). */
    duration: 0.25,
    cooldown: 3,
    /** Extra speed during the burst; a lunge, not a dash. */
    burstSpeed: 3,
    /** §8 5-frame input buffer. */
    bufferFrames: 5,
  },

  lanes: {
    /** v0.3: lanes are 4m wide. */
    width: 4,
    /** v0.3: 2–4 lanes. */
    min: 2,
    max: 4,
    /** v0.3 §7–9: "Highway 4". */
    start: 4,
    /** v0.3: 5f buffer on lane input when it can't be taken yet (stumbling). */
    bufferFrames: 5,
    /** v0.3: one queued lane input at most, taken as soon as the current change ends. */
    queueMax: 1,
    /** Knock-back to the previous lane after an unsmashable hit: quick, it's a shove. */
    knockbackTime: 0.22,
    /** Wall bump: how far toward the wall before bouncing back (m), no stumble. */
    wallBumpDepth: 0.9,
  },

  collision: {
    /** Speed kept after bouncing off something you can't smash. Never a stop. */
    bounceSpeedKeep: 0.55,
    /** Speed lost on a smash, by class. Smash "must never stall momentum" (§10). */
    smashSpeedLoss: { light: 0, medium: 0.02, heavy: 0.06, immovable: 0 } as Record<MassClass, number>,
  },

  /** §10 impact scale (hitstop in 60 Hz frames, shake in px, haptic ms). */
  impact: {
    light: { hitstop: 0, shake: 0, flashFrames: 0, haptic: 0, hapticStrength: 0 },
    medium: { hitstop: 3, shake: 2, flashFrames: 0, haptic: 60, hapticStrength: 0.35 },
    heavy: { hitstop: 6, shake: 5, flashFrames: 1, haptic: 120, hapticStrength: 0.9 },
    landmark: { hitstop: 10, shake: 8, flashFrames: 2, haptic: 250, hapticStrength: 1 },
    bounce: { hitstop: 2, shake: 3, flashFrames: 0, haptic: 90, hapticStrength: 0.5 },
    wall: { hitstop: 0, shake: 2, flashFrames: 0, haptic: 50, hapticStrength: 0.3 },
  },

  /** v0.3 procedural highway. */
  track: {
    /** v0.3: built from 40m segments. */
    segmentLength: 40,
    /** v0.3: curves turn at most 8° per segment, eased (no curvature kinks). */
    maxCurveDeg: 8,
    minCurveDeg: 3,
    curveChance: 0.4,
    /** A merge (lane count ±1) every N segments, N in this range. */
    mergeEvery: [6, 11] as [number, number],
    /** Straight, prop-free run-up at the start. */
    runwaySegments: 3,
    /** Generate this far ahead of the giant; drop segments this far behind. */
    aheadDistance: 480,
    keepBehind: 120,
    /** Concrete edge walls. */
    wallHeight: 1.0,
  },

  /** v0.3 props in lanes: Medium and Heavy only, densities tunable. */
  props: {
    /** No props before this distance (runway). */
    startAt: 90,
    /** Gap between prop rows (m). */
    rowGap: [16, 34] as [number, number],
    /** Chance a row slot actually gets props (global density). */
    rowChance: 0.85,
    /** Weight of Medium vs Heavy when filling a lane slot. */
    mediumWeight: 0.55,
    heavyWeight: 0.45,
    /** Max fraction of lanes a row may block (always leaves ≥1 lane open). */
    maxBlockedShare: 0.67,
  },

  /** v0.3 run cycle. Feet are pinned while planted; phase is locked to distance. */
  gait: {
    /** Cadence never leaves this band (steps/s). */
    cadenceMin: 2.0,
    cadenceMax: 2.3,
    /** Thigh and shin lengths (m): the giant's legs. */
    thigh: 0.95,
    shin: 0.92,
    /** Max distance the body travels over a planted foot: leg-reach limited. The rest is hang. */
    stanceMaxDistance: 1.9,
    /** Stance never exceeds this share of a step, so there's always a little hang. */
    stanceMaxShare: 0.75,
    /** Feet sit this far either side of the body line. */
    footSpread: 0.34,
    /** 1–2 frame contact hold at each plant (v0.3). */
    contactHoldFrames: 2,
    /** Foot slide budget per plant, for tests (m). */
    maxFootSlide: 0.05,
  },

  /** Footfall presentation (v0.3). */
  footfall: {
    /** 2px camera pulse on every plant. */
    pulsePx: 2,
    pulseTime: 0.07,
    /** Rampage ground-crack decals. */
    crackLife: 5,
    crackMax: 40,
  },

  /**
   * §15 oblique news-chopper camera with v0.3 broadcast angle cuts.
   */
  camera: {
    angles: [
      { name: 'Chase High', yawDeg: 0, pitchDeg: 48, distance: 40, fov: 35 },
      { name: 'Wide Side', yawDeg: 35, pitchDeg: 52, distance: 55, fov: 35 },
      { name: 'Long Lens', yawDeg: 15, pitchDeg: 40, distance: 70, fov: 22 },
    ] as CameraAngle[],
    /** LOCKED (v0.3): direction of travel points up the screen within this many degrees. */
    screenUpMaxDeg: 35,
    /** Yaw is clamped this far inside the law, for lag on curves and wobble. */
    screenUpMarginDeg: 4,
    /** v0.3: cut at most once per 7s. */
    cutMinInterval: 7,
    /** Hold an angle this long (s, random in range) before the director wants to cut. */
    cutHold: [7, 12] as [number, number],
    /** v0.3: hard cut with a 1-frame flash. */
    cutFlashFrames: 1,
    /** Frame the point this many seconds ahead of the giant (speed × time). */
    lookAheadTime: 1.6,
    /** The giant never sits lower than this fraction of the screen height (0 top, 1 bottom). */
    giantMaxScreenY: 0.85,
    /** At least this much road visible ahead, in seconds at current speed. */
    minRoadAheadSeconds: 2,
    /** Distance changes between tiers ease over this long. */
    distanceEase: 0.8,
    /** Lag on the camera's position and on its look target. */
    positionLag: 0.35,
    lookLag: 0.2,
    wobbleDeg: 0.3,
    wobbleHz: 0.4,
    /** Line-of-sight: climb rather than cut through anything solid. */
    occlusionRaiseStep: 2,
    occlusionMaxRaise: 60,
    occlusionRaiseLag: 0.15,
    occlusionLowerLag: 0.8,
    /** §15 heavy smash jolt. */
    joltPx: 5,
    joltTime: 0.1,
    /** §10 tier-up: brief camera pull-out (extra metres of distance, decays). */
    tierUpPullOut: 6,
    tierUpPullOutTime: 0.5,
  },

  /** Input gestures (v0.3). */
  input: {
    /** Stick flick: crossing this x deflection fires one lane change; must return under release. */
    flickThreshold: 0.6,
    flickRelease: 0.3,
    /** Swipe: at least this many px, within this time. */
    swipeMinPx: 40,
    swipeMaxTime: 0.35,
    /** Swipe down and hold to brake: downward drag past this many px. */
    swipeDownBrakePx: 40,
  },
} as const;

export type Tuning = typeof TUNING;
