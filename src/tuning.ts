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
export type UpgradeId = 'leap' | 'stare' | 'hijack' | 'pose' | 'ironShins' | 'secondWind' | 'showman' | 'tailwind';
export type AbilityId = 'leap' | 'stare' | 'hijack' | 'pose';

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
  /** Arm pump amplitude (rad) about the shoulder: lead fist drives forward, the other pulls back. */
  armSwing: number;
  /** Arm rest angle (rad, negative = behind): the centre of the pump. */
  armBase: number;
  /** Bound: how high the hips rise through the airborne part of each stride (m). */
  flightLift: number;
  /** Elbow bend (rad): the forearm folds forward so the fists ride in front of the chest. */
  elbowBend: number;
  /** Model pass: cape angle from hanging straight down (deg). Heavy at Jog, near horizontal at Rampage. */
  capeAngle: number;
  /** Model pass: cape flutter (Hz) and amplitude at the hem (m). Rampage snaps. */
  capeFlutterHz: number;
  capeFlutterAmp: number;
}

export interface CameraAngle {
  name: 'Chase High' | 'Wide Side' | 'Long Lens' | 'Head-On' | 'High Head-On' | 'Overhead';
  /** Requested yaw off the direction of travel. Clamped by the screen-up law. */
  yawDeg: number;
  pitchDeg: number;
  /** Camera to framed point, before the tier scale. */
  distance: number;
  fov: number;
  /** Phase 0c: per-angle look-ahead (s); defaults to camera.lookAheadTime. */
  lookAheadTime?: number;
  /**
   * Phase 0c: the camera flies ahead and looks back, so he runs DOWN the screen at
   * you (yaw is the offset from dead ahead). The camera rules are mirrored: travel
   * within ±35° of screen-down, giant never above 15% of the frame, ≥2s of road
   * ahead (below him). Lane input follows what's on screen.
   */
  headOn?: boolean;
  /** Phase 0c: the return home from this angle is the swoop, not a hard cut. */
  swoopHome?: boolean;
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

  /** Model pass (Mike's sheet): one horned pauldron, the cape clasped under it. */
  giantModel: {
    /** Cape length from the clasp line (m): knee length at Jog (v0.3 §10). */
    capeLength: 1.9,
    /** Cape half-width at the shoulders and at the hem (m): narrow so the legs read past it. */
    capeHalfWidthTop: 0.42,
    capeHalfWidthHem: 0.62,
    /** How fast the cape angle follows a tier change (s): a gear change, so quick. */
    capeAngleTime: 0.25,
    /** The cape's top lies along his back: lean plus this clearance (rad), over this share of its length. */
    capeBackClear: 0.18,
    capeDrapeShare: 0.45,
    /** Hem lift on a tier-up (deg): the flare. */
    capeTierFlare: 18,
    /** Flutter shape: >1 sharpens the wave into a snap; scales up with tier. */
    capeSnapPow: [1, 1.6, 2.6],
    /** Cape swings out opposite a lane change (m of hem offset per m/s of lateral speed). */
    capeLateralLag: 0.09,
    /** Braid: segment length (m) and how quickly each link follows (s). */
    braidLink: 0.2,
    braidFollow: 0.05,
  },

  /** Momentum tiers: v0.2 speeds and timings, v0.3 lane-change times and run cycle. */
  tiers: [
    // Pose pass (Mike's reference stills + clip): deep lean, legs cycling under a gliding torso
    // (little bob), knee drive and heel kick, a big exaggerated arm pump (Mike: "exaggerated a bit"). Speeds, cadence
    // and stride are unchanged.
    { name: 'Jog', topSpeed: 6, accel: 8, tierUpAfter: 2.0, smashes: 'light', laneChangeTime: 0.22, cadence: 2.0, specStrideLength: 2.5, leanDeg: 20, hipHeight: 1.68, bodyDrop: 0.12, footLift: 0.45, cameraDistanceScale: 0.9, armSwing: 0.9, armBase: -0.1, flightLift: 0.03, elbowBend: 1.2, capeAngle: 20, capeFlutterHz: 1.3, capeFlutterAmp: 0.05 },
    { name: 'Stride', topSpeed: 10, accel: 6, tierUpAfter: 3.0, smashes: 'medium', laneChangeTime: 0.3, cadence: 2.1, specStrideLength: 4.0, leanDeg: 30, hipHeight: 1.64, bodyDrop: 0.18, footLift: 0.75, cameraDistanceScale: 1.0, armSwing: 1.25, armBase: -0.05, flightLift: 0.07, elbowBend: 1.4, capeAngle: 52, capeFlutterHz: 3.2, capeFlutterAmp: 0.12 },
    { name: 'Rampage', topSpeed: 15, accel: 4, tierUpAfter: Infinity, smashes: 'heavy', laneChangeTime: 0.4, cadence: 2.3, specStrideLength: 6.0, leanDeg: 40, hipHeight: 1.6, bodyDrop: 0.24, footLift: 1.05, cameraDistanceScale: 1.15, armSwing: 1.6, armBase: 0, flightLift: 0.11, elbowBend: 1.6, capeAngle: 80, capeFlutterHz: 6.5, capeFlutterAmp: 0.2 },
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

  /**
   * Phase 2 road variety (v0.3 §16, §7–9): zones with their own lane counts,
   * reached through telegraphed merges. Names are invented (headline places).
   */
  zones: {
    lanes: { highway: 4, avenue: 3, bridge: 2, tunnel: 2 },
    /** Zone length in 40m segments. */
    length: { highway: [5, 9], avenue: [4, 7], bridge: [3, 5], tunnel: [3, 5] } as Record<'highway' | 'avenue' | 'bridge' | 'tunnel', [number, number]>,
    weight: { highway: 2, avenue: 1.5, bridge: 1, tunnel: 1 },
    /** Extra row filter per zone (on top of props.rowChance): bridges and tunnels are a breather. */
    rowChance: { highway: 1, avenue: 1, bridge: 0.7, tunnel: 0.65 },
    /** Share of Medium props per zone: avenues are carts and sawhorses; tunnels are traffic. */
    mediumWeight: { highway: 0.55, avenue: 0.75, bridge: 0.5, tunnel: 0.3 },
    /** Chance a highway segment has an overpass crossing it. */
    overpassChance: 0.18,
    names: {
      first: ['Harbor', 'Quarry', 'Ninth', 'Kessler', 'Orchard', 'Lantern', 'Millbrook', 'Ashgrove', 'Redline', 'Copper', 'Dunmore', 'Saltmarsh'],
      suffix: { highway: 'Expressway', avenue: 'Avenue', bridge: 'Bridge', tunnel: 'Tunnel' },
    },
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
    /** Swing shape: the foot peaks early (heel kicks up, knee tucks) ... */
    swingPeakEarly: 0.65,
    /** ... and stays back before whipping forward to the next plant. */
    swingLag: 1.6,
    /** Pose snap for the arm pump: <1 holds the extremes (the strong poses) and moves fast between. */
    poseSnap: 0.55,
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
      // Cut-aways look less far ahead so the escort behind the giant is in shot (≥2s of road ahead still enforced).
      { name: 'Wide Side', yawDeg: 35, pitchDeg: 52, distance: 55, fov: 35, lookAheadTime: 0.5 },
      { name: 'Long Lens', yawDeg: 15, pitchDeg: 40, distance: 70, fov: 22, lookAheadTime: 0.7 },
      // Mike: head-on as a cut-away, from higher up (44° vs the 18° experiment). Far and telephoto so ≥2s of road ahead fits below him.
      { name: 'Head-On', yawDeg: 12, pitchDeg: 44, distance: 100, fov: 16, headOn: true, swoopHome: true },
      // Mike: a higher head-on. Steeper means more road per screen, so further out to keep ≥2s below him.
      { name: 'High Head-On', yawDeg: 10, pitchDeg: 58, distance: 110, fov: 17, headOn: true, swoopHome: true },
      // Mike: almost directly above. Travel stays screen-up; shows lanes, merges and the convoy like a map.
      { name: 'Overhead', yawDeg: 0, pitchDeg: 82, distance: 70, fov: 30, swoopHome: true },
    ] as CameraAngle[],
    /** Away angles each trigger can cut to (random pick, never the last away angle). Overhead suits merges: you see the lanes close. */
    cutAngles: { rampage: [3, 4, 1], heavy: [4, 3, 2], merge: [5, 1, 2] } as Record<'rampage' | 'heavy' | 'merge', number[]>,
    /**
     * Phase 0c: leaving Head-On is a swoop, not a cut: the chopper orbits round his
     * shoulder and cranes up into Chase High. Travel can't stay within ±35° of either
     * screen-up or screen-down mid-orbit; the swoop is the only exception and it's
     * bounded by `time` (soak-checked).
     */
    swoop: { time: 1.4, apexPitchDeg: 70 },
    /** LOCKED (v0.3): direction of travel points up the screen within this many degrees. */
    screenUpMaxDeg: 35,
    /** Yaw is clamped this far inside the law, for lag on curves and wobble. */
    screenUpMarginDeg: 4,
    /**
     * Phase 0c: cuts are event-driven. Chase High is home; the director cuts away
     * only on these triggers and returns home after `awayHold`.
     */
    homeAngle: 0,
    /** Phase 0c: at least 15s between cut-aways (tighter than v0.3's 7s). */
    cutMinInterval: 15,
    /** Phase 0c: return to Chase High after this long away (s, random in range). */
    awayHold: [6, 10] as [number, number],
    /**
     * A trigger that lands mid-lane-change waits this long for the move to end (s).
     * Covers a lane change plus one queued change at Rampage (0.4 + 0.4).
     */
    triggerPending: 1.0,
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

  /**
   * Phase 0c escort: 2–3 cruisers trail the giant with lights and sirens. They
   * never catch up and never attack (pursuit AI is Phase 2); they sell the chase.
   */
  escort: {
    count: 3,
    /** LOCKED (§1): pursuers never spawn within 40m. Spawning 100m back also keeps them behind every camera angle. */
    spawnBehind: 100,
    /** First cruiser joins after this long; the rest follow at these gaps (s). */
    firstJoin: [5, 8] as [number, number],
    joinGap: [3, 6] as [number, number],
    /** Gap each cruiser settles at behind the giant (m): the lead's light bar peeks into the bottom of the Chase High frame. */
    trail: [9, 14, 20],
    /** Hard floor on the gap (m). They never catch up. */
    minGap: 7,
    /** Closing speed over the giant's while catching up to the trail gap (m/s). */
    closeSpeed: 6,
    /** Time constant for holding the trail gap (s). */
    holdTau: 0.6,
    /** Side offset from the giant's path for the 2nd and 3rd cruisers (m), dropped when a prop is in the way. */
    sideOffset: 1.6,
    /** Lateral easing speed for that offset (m/s). */
    sideSpeed: 3,
  },

  /**
   * Phase 2 segment (§4, LOCKED shape): 150s broadcast + 15s grace. v0.3: the
   * sign-off is an exit ramp that opens at 130s; take it before 165s.
   */
  segment: {
    /** LOCKED (§4): segment length and grace. */
    length: 150,
    grace: 15,
    /** v0.3 §4: the exit ramp opens at 130s. */
    exitOpensAt: 130,
    /** §4: the sign-off spawns 150–250m away. */
    exitDistance: [150, 250] as [number, number],
    /** If no eligible segment sits inside that window, search up to this far. */
    exitSearchMax: 330,
    /** The ramp splits from the right edge this far into its segment (the gore point). */
    goreAt: 26,
    /** Keep the exit lane clear of props this far before the gore (m). */
    exitClear: 40,
  },

  /** §12 Ratings / Heat / Pin. */
  show: {
    /** §4/§12: Ratings start at 20 each segment; 0..100. */
    startRatings: 20,
    max: 100,
    /** §12 gains. Sustained Rampage is per second. */
    gain: { medium: 2, heavy: 5, nearMiss: 3, lostTrack: 6, rampage: 1 },
    /** §12 decay: after 3s with no gain; segment 1 rate (2.0/2.75/3.5/4.25/5.0 by segment). */
    decayAfter: 3,
    decayRate: [2.0, 2.75, 3.5, 4.25, 5.0],
    /** §12 variety: repeats within 10s pay ×0.5 then ×0.25; a type unseen this segment pays ×1.5. */
    repeatWindow: 10,
    repeatMult: [1, 0.5, 0.25],
    freshMult: 1.5,
    /** §12 outnumbered: 6+ pursuers chasing → ×1.25 all gains. */
    outnumberedAt: 6,
    outnumberedMult: 1.25,
    /** §12 banking: each second banks Ratings × tier multiplier. */
    bankMult: [1, 1.5, 2],
    /** §12 Heat: rises at these Ratings, and +1 every 45s; never falls in a segment. */
    heatAt: [30, 50, 70, 90],
    heatEvery: 45,
    /** v0.3 §11 box-in (Pin): fills when both adjacent lanes are blocked and a unit is within 8m ahead below 4 m/s. */
    pinFill: 25,
    pinDrain: 30,
    pinBelow: 4,
    pinDrainAbove: 8,
    pinUnitAhead: 8,
    /** §21 headline tiers by Ratings: SPOTTED / AT LARGE / RAMPAGE / CITY IN CHAOS. */
    tiers: [0, 30, 60, 90],
  },

  /**
   * Phase 2 pursuit, lane-runner version (v0.3 §11 tells). Units spawn ≥40m away
   * (LOCKED) and off camera, one tell at a time, and always leave a way through.
   */
  pursuit: {
    /** §19: nothing spawns before this (cold open), then cadence/cap/kinds by Heat. */
    firstAt: 12,
    byHeat: [
      { cadence: 8, cap: 2, kinds: ['cruiser'] },
      { cadence: 6, cap: 3, kinds: ['cruiser', 'spike', 'rolling'] },
      { cadence: 5, cap: 4, kinds: ['cruiser', 'spike', 'rolling', 'roadblock'] },
      { cadence: 4, cap: 5, kinds: ['cruiser', 'spike', 'rolling', 'roadblock'] },
      { cadence: 4, cap: 5, kinds: ['cruiser', 'spike', 'rolling', 'roadblock'] },
    ] as { cadence: number; cap: number; kinds: ('cruiser' | 'spike' | 'rolling' | 'roadblock')[] }[],
    weights: { cruiser: 3, spike: 2, rolling: 1.5, roadblock: 1.5 },
    /** LOCKED (§1): never spawn within 40m. Behind spawns also sit behind every camera. */
    spawnBehind: 100,
    spawnAheadMin: 110,
    /** Cruiser ram (v0.3: blinker + 0.6s drift, then swerve into your lane). */
    cruiser: { closeSpeed: 7, tell: 0.6, drift: 0.6, swerve: 0.35, fallBack: 6, sideSpeed: 5 },
    /** Rolling roadblock (v0.3: brake lights 1.5s, 2–3 cruisers abreast slowing). */
    /** Tells start inside the visible road (the frame shows ≥2s ahead; capped at 28m for the faster Hijack ride), or nobody sees them. */
    rolling: { cruiseFactor: 0.55, tellAhead: 1.9, tellMin: 25, tellMax: 28, tell: 1.5, decel: 6, crawl: 3, actMax: 12 },
    /** Spike strip (v0.3: officer kneels, 1.2s, covers one lane). Crossing it: −1 tier, keep 70% speed, stumble. */
    spike: { aheadTime: 4.5, aheadMin: 60, tellAhead: 1.9, tellMax: 28, tell: 1.2, speedKeep: 0.7 },
    /** Static roadblock (v0.3: cars slide in 2.0s, all lanes but one; the gap glows). */
    roadblock: { aheadTime: 7.5, slideAhead: 1.9, slideMax: 28, tell: 2.0 },
    /** Near-miss (§12): a pursuer passes within 1.5m without contact. */
    nearMiss: 1.5,
    /** A unit this far behind the giant has lost track (§12) and leaves. */
    lostBehind: 30,
    removeBehind: 60,
  },

  /**
   * Phase 3 run (§4, §17): five segments with a Producer's Meeting between each.
   * Later segments start one Heat higher (§19) and decay faster (§12 decayRate by segment).
   */
  run: {
    segments: 5,
    /** Offers per meeting (§17: pick 1 of 3). */
    offers: 3,
  },

  /**
   * §17 v1 upgrade pool (8). Abilities share the one ability slot (a new one replaces it);
   * passives stack. Prices are paid from banked Ratings (the run score is what you earned,
   * spending doesn't lower it). Working default: a cleared segment banks ~24k with the bot, so one
   * segment affords the cheaper half; saving up for Leap/Hijack is a real choice.
   */
  upgrades: {
    leap: { kind: 'ability', price: 26000, label: 'Leap', blurb: 'Hop lanes of trouble. The landing flattens what you land on.' },
    stare: { kind: 'ability', price: 21000, label: 'The Stare', blurb: 'Traffic and police ahead pull out of your lane.' },
    hijack: { kind: 'ability', price: 30000, label: 'Hijack Hop', blurb: 'Ride a car through everything, then bail at Rampage.' },
    pose: { kind: 'ability', price: 21000, label: 'Pose for the Camera', blurb: 'Stop for the cameras. Heat becomes a Ratings spike.' },
    ironShins: { kind: 'passive', price: 17000, label: 'Iron Shins', blurb: 'Medium objects never bounce you.' },
    secondWind: { kind: 'passive', price: 17000, label: 'Second Wind', blurb: 'The box-in meter drains 50% faster.' },
    showman: { kind: 'passive', price: 22000, label: 'Showman', blurb: 'Something new on air pays double.' },
    tailwind: { kind: 'passive', price: 19000, label: 'Tailwind', blurb: 'Tier up 30% sooner.' },
  } as Record<UpgradeId, { kind: 'ability' | 'passive'; price: number; label: string; blurb: string }>,

  /** Phase 3 abilities (lane-runner versions of §17's pool). 5f input buffer (§8). */
  abilities: {
    bufferFrames: 5,
    /** Leap: airborne this long (no collisions), apex height (m), landing shockwave radius (m) smashing up to Heavy. */
    leap: { time: 0.9, height: 3.2, shockRadius: 4.5, cooldown: 6 },
    /** The Stare: vehicles in your lane up to this far ahead pull over into a free neighbouring lane; police winding up back off. */
    stare: { reach: 70, time: 0.6, cooldown: 10 },
    /** Hijack Hop: a vehicle within this far ahead (your lane or next to it); ride speed (just under Rampage top so every camera keeps ≥2s of road ahead), reached at `accel`, ride time, then bail at Rampage. */
    hijack: { reach: 14, speed: 14, accel: 8, time: 3, cooldown: 12 },
    /** Pose: speed held at the floor this long (a deliberate stop, §2: ≤1s); Ratings per Heat level; Heat spent. */
    pose: { time: 0.8, ratingsPerHeat: 7, heatCost: 1, cooldown: 12 },
  },

  /** Phase 3 passives. */
  passives: {
    /** Second Wind: Pin drain multiplier. */
    secondWindDrain: 1.5,
    /** Showman: a type unseen this segment pays this (instead of §12's ×1.5). */
    showmanFresh: 2.0,
    /** Tailwind: tier-up time multiplier. */
    tailwindTierUp: 0.7,
  },

  /** Phase 0c traffic reactions (presentation): cars ahead brake, swerve and honk as he approaches. */
  traffic: {
    /** Brake lights and hazards come on when the giant is this close behind (m). */
    brakeAt: 45,
    /** Swerve and honk inside this distance (m). */
    swerveAt: 26,
    /** Only cars within this many metres across the road react. */
    lateralReach: 7,
    /** Visual swerve: lateral nudge (m) and yaw (deg) inside the car's own footprint; the hitbox doesn't move. */
    swerveOffset: 0.35,
    swerveYawDeg: 7,
    /** At most one honk this often (s). */
    honkGap: 0.45,
    /** Rampage footfalls bounce cars within this radius (m) on their suspension. */
    bounceRadius: 16,
    /** Suspension spring: peak drop (m) at the foot, frequency (Hz), damping ratio. */
    bounceDrop: 0.18,
    bounceHz: 2.2,
    bounceDamping: 0.25,
  },

  /** Phase 0c broadcast (§21). */
  broadcast: {
    /** §21: a new headline at most every 4s; tier changes interrupt with BREAKING. */
    headlineEvery: 4,
    /** §21: no verb or place reused within the last 5 headlines. */
    antiRepeat: 5,
    /** Smashes inside one headline window are counted together ("3 Cars"). */
    tallyWindow: 4,
    /** Opening headline after this long. */
    openAt: 1.2,
  },

  /** Phase 2 broadcast escalation (presentation). */
  coverage: {
    /** §4 cold open: the traffic cam holds this long before the chopper finds him. */
    coldOpen: 2.2,
    /** The anchor desk split screen holds this long when a higher tier hits. */
    deskTime: 4.5,
    /** Viewer video (picture-in-picture): length, minimum gap, minimum Ratings tier. */
    pipTime: 3.2,
    pipGap: 12,
    pipTier: 1,
  },

  /** Phase 0c look: night by default; LIVE TIME follows the local clock. */
  look: {
    /** Local hours (24h): day from dayStart, dusk from duskStart, night from nightStart; dawn counts as dusk. */
    dawnStart: 5,
    dayStart: 7,
    duskStart: 17,
    nightStart: 20,
    /** Sodium streetlights every this many metres, alternating sides. */
    lampSpacing: 20,
    /** Real point lights reused on the nearest lamps (the rest are glow decals). Each light costs every lit pixel. */
    lampLights: 2,
    /** Chopper spotlight: ground pool radius (m), lag following the giant (s), wander (m). */
    spotRadius: 7,
    spotLag: 0.25,
    spotWander: 1.2,
    /** Chopper shadow crosses the road every this many seconds (random in range). */
    chopperShadowEvery: [16, 32] as [number, number],
    /** Siren flash rate (Hz). */
    sirenHz: 2.2,
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
    /** The controls strip shows for this long at the start of each segment (s). */
    controlsHintTime: 7,
  },
} as const;

export type Tuning = typeof TUNING;
