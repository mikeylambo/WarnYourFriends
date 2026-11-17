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
   * interpolated by speed between tiers, so it never leaves the gait band (2.6–3.1).
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
  name: 'Chase High' | 'Wide Side' | 'Long Lens' | 'Head-On' | 'High Head-On' | 'Overhead' | 'Sign-Off';
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
  /** Only the sign-off outro uses it (never a cut-away). */
  outro?: boolean;
  /** Frame a point this far (m) behind him instead of ahead: he sits low and the road ahead stays out of shot. */
  lookBehind?: number;
}

export const TUNING = {
  sim: {
    /** §29 fixed step. */
    hz: 60,
  },

  /**
   * Giant size (Mike, 2026-11-15). Deviation from GDD §9's 3.6m: he is 1.3× (4.7m), body and hit-box,
   * at every gear. Growing with the gear (1.0 / 1.15 / 1.3) was tried first: he rarely loses a gear,
   * so it barely showed, and Mike liked the max size ("commit to 1.3× always"). The per-gear table
   * stays so growth can come back after the balance pass. The hit-box (1.43m) never reaches the next
   * lane (1.9m to the nearest prop edge there), so every row still leaves a lane. ?size=fixed compares
   * the old 3.6m giant.
   */
  growth: {
    /** Scale per gear (Jog, Stride, Rampage), body and collision radius. */
    scale: [1.3, 1.3, 1.3] as [number, number, number],
    /** The fixed-size alternative to compare in playtest (?size=big): Rampage size all the time, look only. */
    big: 1.3,
    /** Grow/shrink ease time constant (s): a swell, not a pop. */
    ease: 0.12,
    /** How much of his extra size the chopper pulls out for (1 = in proportion; less keeps cars readable). */
    cameraFollow: 0.25,
  },

  giant: {
    /** §9 the giant is 3.6m tall (his Jog size; see growth). */
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
  /**
   * Shoulder Check animation (Mike: "we need an attack animation for shoulder"), presentation only over the
   * sim's 0.25s burst. `time` s in all: a wind-up (shoulders turn away, a drop) for `windup` of it, then the
   * drive (pauldron shoulder leads: a hard twist, a deep lean, that arm tucked across the chest, the other
   * flung back), held to `strikeEnd`, then the recovery. Angles in radians, the drop in metres.
   */
  shoulderAnim: { time: 0.5, windup: 0.18, strikeEnd: 0.6, twistBack: 0.45, twistDrive: -1.15, leanDrive: 0.55, leanBack: -0.12, drop: 0.22, armTuck: 1.25, armFling: 1.1 },

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
    /** Share of the cape's length that is the cream Greek-key hem (Mike's sheet). */
    capeHemShare: 0.2,
    /** Meshy model on authored run clips (Mike: the hybrid "still reads as jank"): crossfade between tiers' clips (s), and how fast a leg blends onto / off the gait's planted foot (s). */
    clipFade: 0.3,
    plantBlend: 0.06,
    /** Ankle bone height above the road (m): feet never sink into it. */
    ankleHeight: 0.12,
    /** Unused since the authored clips (kept for the greybox-driven arm fallback). */
    clipLean: 1,
    /** His hips ride this much above the gait's (m): straighter legs on a realistic body; the IK still lands the feet. */
    hipRaise: 0.12,
    armAmp: [0.8, 1.05, 1.3],
    /** Meshy model: texture multiplier, so his silhouette holds ≥3:1 against a lit road (§23, silhouette test). */
    tint: 0.75,
    /** Meshy model: ink outline thickness around the skinned mesh (m), as the greybox hull. */
    outline: 0.05,
  },

  /** Momentum tiers: v0.2 speeds, v0.3 lane-change times and run cycle. Impact pass: smashes and dodges also feed the tier-up timer (collision.tierFeed). */
  tiers: [
    // Pose pass (Mike's reference stills + clip): deep lean, legs cycling under a gliding torso
    // (little bob), knee drive and heel kick, a big exaggerated arm pump (Mike: "exaggerated a bit"). Speeds, cadence
    // and stride are unchanged.
    { name: 'Jog', topSpeed: 6, accel: 8, tierUpAfter: 2.0, smashes: 'light', laneChangeTime: 0.22, cadence: 2.6, specStrideLength: 2.5, leanDeg: 20, hipHeight: 1.68, bodyDrop: 0.12, footLift: 0.45, cameraDistanceScale: 0.9, armSwing: 0.9, armBase: -0.1, flightLift: 0.03, elbowBend: 1.2, capeAngle: 20, capeFlutterHz: 1.3, capeFlutterAmp: 0.05 },
    { name: 'Stride', topSpeed: 10, accel: 6, tierUpAfter: 3.0, smashes: 'medium', laneChangeTime: 0.3, cadence: 2.8, specStrideLength: 4.0, leanDeg: 30, hipHeight: 1.64, bodyDrop: 0.18, footLift: 0.75, cameraDistanceScale: 1.0, armSwing: 1.25, armBase: -0.05, flightLift: 0.07, elbowBend: 1.4, capeAngle: 52, capeFlutterHz: 3.2, capeFlutterAmp: 0.12 },
    { name: 'Rampage', topSpeed: 15, accel: 4, tierUpAfter: Infinity, smashes: 'heavy', laneChangeTime: 0.4, cadence: 3.1, specStrideLength: 6.0, leanDeg: 40, hipHeight: 1.6, bodyDrop: 0.24, footLift: 1.05, cameraDistanceScale: 1.2, armSwing: 1.6, armBase: 0, flightLift: 0.11, elbowBend: 1.6, capeAngle: 80, capeFlutterHz: 6.5, capeFlutterAmp: 0.2 },
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
    /** A knock-back needs its lane clear this far past what he hit (m): just enough to get by, not the next row. */
    knockClearPast: 1,
  },

  collision: {
    /** Speed kept after bouncing off something you can't smash. Never a stop. */
    bounceSpeedKeep: 0.55,
    /** Speed lost on a smash, by class. Smash "must never stall momentum" (§10). */
    smashSpeedLoss: { light: 0, medium: 0.02, heavy: 0.06, immovable: 0 } as Record<MassClass, number>,
    /** Impact pass: passing within this gap (m) of something that would have bounced him is a dodge (scores as a near-miss). */
    dodgeGap: 1.2,
    /** Impact pass: seconds added to the tier-up timer per smash / dodge, so playing rough is the fast way to Rampage. */
    tierFeed: {} as Partial<Record<'medium' | 'heavy' | 'nearMiss', number>>, // off until Mike's call; { medium: 0.5, heavy: 1.0, nearMiss: 1.0 } tested: needs a Head-On framing fix first
  },

  /** §10 impact scale (hitstop in 60 Hz frames, shake in px, haptic ms). */
  impact: {
    // Impact pass: every hit at least 3× the 2px footfall pulse (Medium was 2px, the same as a step).
    light: { hitstop: 0, shake: 0, flashFrames: 0, haptic: 0, hapticStrength: 0 },
    medium: { hitstop: 4, shake: 6, flashFrames: 0, haptic: 70, hapticStrength: 0.45 },
    heavy: { hitstop: 7, shake: 11, flashFrames: 1, haptic: 140, hapticStrength: 0.95 },
    landmark: { hitstop: 10, shake: 14, flashFrames: 2, haptic: 250, hapticStrength: 1 },
    bounce: { hitstop: 7, shake: 10, flashFrames: 0, haptic: 160, hapticStrength: 0.8 },
    /** A dodge: a small kick and a buzz, no freeze (it must not interrupt the line he's taking). */
    dodge: { hitstop: 0, shake: 3, flashFrames: 0, haptic: 40, hapticStrength: 0.25 },
    wall: { hitstop: 0, shake: 2, flashFrames: 0, haptic: 50, hapticStrength: 0.3 },
    /**
     * Impact pass (Mike: hits "don't have much impact"): a smashed body is swatted off his line
     * instead of vanishing. Speeds in m/s: forward is a share of his speed (under 1, so he passes it),
     * lateral flings it out of his lane, up lofts it; spin in rad/s.
     */
    wreck: {
      medium: { forward: 0.55, lateral: [9, 13] as [number, number], up: [7, 10] as [number, number], spin: 9 },
      heavy: { forward: 0.5, lateral: [6, 9] as [number, number], up: [5, 7] as [number, number], spin: 6 },
      gravity: 26,
      bounce: 0.35,
      /** Off the road-edge wall (share of the outward speed kept): wrecks stay on the road, in view, even in tunnels. */
      wallBounce: 0.3,
      /** Tunnel roof beams this far behind / ahead of him (m) are hidden, so wrecks tumbling past stay in view. */
      beamClear: [30, 8] as [number, number],
      /** Ground friction (1/s) on speed and spin. */
      friction: 3.2,
      /** Squash on impact (height scale): it reads as crumpled. */
      crumple: 0.72,
      /** Wrecks stay this long (s) unless culled behind; at most this many at once. */
      life: 10,
      max: 24,
      cullDistance: 160,
    },
  },

  /** v0.3 procedural highway. */
  track: {
    /** A lane line is painted only where the lane beyond it is at least this share of a full lane (an opening lane gets its line late, not as a sliver). */
    laneLineAt: 0.9,
    /** The built road edge (walls, verge, pavement) smooths lane-count changes over ±this many m, twice (max, then average): a ~3° drift, not a 40m S-bend. */
    edgeSmooth: 40,
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

  /**
   * Content pass (Mike, 2026-11-15): landmark set pieces (v0.3 §16 "landmark set pieces become segments"),
   * one 40m segment each, built from verbs he already has. Every row leaves a lane open.
   * - toll: gate arms (Medium) across every lane but one open booth lane. Smash them for points, or take the open lane.
   * - foodtrucks (avenue): two rows of food trucks (Heavy) and carts (Medium), a different lane open each row.
   * - works: one edge lane closed by concrete barricades (Heavy) behind an arrow board; merge out, or smash down it at Rampage.
   * - jam: three rows of stalled cars (Heavy) across all but one lane; the open lane moves at most one lane a row.
   */
  landmarks: {
    /** First landmark no earlier than this segment (after the opening runway and the first props). */
    firstAt: 7,
    /** Segments between landmarks: about one every 25–40 s at Stride. */
    every: [7, 11] as [number, number],
    /** Which zones each one appears in, and how often it's picked. */
    zones: { toll: ['highway'], foodtrucks: ['avenue'], works: ['highway'], jam: ['highway'] } as Record<'toll' | 'foodtrucks' | 'works' | 'jam', ('highway' | 'avenue' | 'bridge' | 'tunnel')[]>,
    weight: { toll: 1, foodtrucks: 1, works: 1, jam: 1 } as Record<'toll' | 'foodtrucks' | 'works' | 'jam', number>,
    /** Where the rows sit inside the 40m segment (m from its start). */
    rows: { toll: [22], foodtrucks: [10, 28], works: [6, 13, 20, 27, 34], jam: [6, 20, 34] } as Record<'toll' | 'foodtrucks' | 'works' | 'jam', number[]>,
    /** Food-truck rows: share of blocked lanes that are trucks (the rest carts). */
    truckShare: 0.6,
    /** Invented names for the headlines (the zone's first-name bank supplies the rest). */
    suffix: { toll: 'Toll Plaza', foodtrucks: 'Night Market', works: 'Roadworks', jam: 'Rush Hour' } as Record<'toll' | 'foodtrucks' | 'works' | 'jam', string>,
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
    /**
     * Impact pass: chance a blocked lane slot is a dozer (immovable: bounces him at any tier),
     * from this far in. Before it, Rampage made every obstacle confetti, so dodging meant nothing.
     */
    immovableChance: 0.2,
    immovableFrom: 250,
    /** Max fraction of lanes a row may block (always leaves ≥1 lane open). */
    maxBlockedShare: 0.67,
  },

  /** v0.3 run cycle. Feet are pinned while planted; phase is locked to distance. */
  gait: {
    /** Cadence never leaves this band (steps/s). Step-rate pass (Mike, 2026-11-14): 2.6–3.1, up from 2.0–2.3, toward his reference clip (~3.1). */
    cadenceMin: 2.6,
    cadenceMax: 3.1,
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

  /**
   * Gear tells (presentation): the natural speed build has to be seen. The last `buildUp` s before a
   * gear-up the footfalls swell and tick upward; on the gear-up a shockwave ring, a brief lens punch
   * (wider FOV, off under Reduced Motion), traffic ahead brakes early, and a tag rides the chyron.
   * Stride and Rampage kick dust back off every step (particles per footfall by tier).
   */
  gear: { buildUp: 1.0, buildRingScale: 0.9, fovPunch: 0.14, fovPunchTime: 0.5, shockRadius: 10, trafficAlarm: 1.6, trafficAlarmBrakeAt: 85, dustKick: [0, 3, 8] },

  /**
   * Recap REPLAY (presentation): the night's top moment, re-simulated from the recorded inputs and
   * played back before the recap card. Starts `lead` s before the moment at full speed, slows to `slow`×
   * from `slowBefore` s before to `slowAfter` s after, and ends `after` s after. Scores pick the moment
   * (the highest wins; ties go to the later one). Shot from a cut-away angle.
   */
  replay: {
    lead: 2.2, slow: 0.35, slowBefore: 0.35, slowAfter: 1.0, after: 1.6, angle: 'Long Lens',
    /** The recap's picture: grabbed this long after the moment (debris in the air), at this width in px (a still, not a screenshot). */
    shotAfter: 0.2, shotWidth: 960,
    /** The recap's looping clip: recorded off the canvas during the replay at this frame rate and bitrate; under `clipMin` s (skipped early) the still stays. */
    clipFps: 30, clipBitrate: 2_500_000, clipMin: 1.5,
    /** Between plays of the clip, the still (the moment as it lands) holds this long (s). Mike: "alternate photos and clips". */
    clipStillHold: 3,
    score: { policeCrash: 10, unitSmash: 7, leapLand: 4, hijackBail: 5, heavyAcross: 6, heavy: 4, nearMiss: 4, ramMiss: 4, pose: 3 },
  },

  /**
   * Spectacle score (Mike, 2026-11-15; replaces §12 "banked = Ratings × gear per second", which sat at the
   * 100 cap ~2/3 of a broadcast so nothing great play did could add score). Ratings stay the life bar.
   * Each stunt pays `points` × gear (`show.bankMult`) × audience (by Ratings tier), into the chain.
   * A stunt within `window` s of the last extends the chain; its multiplier steps up every `stepEvery`
   * stunts to `maxMult`. Chain times out → banks at its multiplier. Bounce, spikes or a ram that connects
   * → it drops: the points bank at ×1, the multiplier is lost. Smash-across pays `acrossBonus`×.
   */
  spectacle: {
    points: { medium: 100, heavy: 250, unit: 500, policeCrash: 750, collateral: 100, nearMiss: 200, ramDodge: 200, lostTrack: 250, chopperShaken: 300, leapLand: 150, hijackBail: 300, posePerHeat: 100 },
    acrossBonus: 1.5,
    audienceMult: [1, 1.25, 1.5, 2],
    window: 2.5,
    stepEvery: 2,
    maxMult: 6,
  },

  /**
   * The producer's asks (Mike, 2026-11-15): each segment opens with `perSegment` seeded requests from
   * this pool; finishing one banks `reward` points straight into the score (not the chain). `n` is the
   * target; `fromSegment` holds an ask back until later segments; `zone` asks are only offered when
   * that kind of road comes up within `zoneLookahead` m (so every ask is possible). Text is the
   * producer's line ({n} is the target).
   */
  asks: {
    perSegment: 3,
    zoneLookahead: 1500,
    pool: [
      { id: 'units', text: 'Flatten {n} police cars', n: 6, reward: 30000 },
      { id: 'crash', text: 'Get a police car to crash', n: 1, reward: 30000 },
      { id: 'roadblock', text: 'Smash through a roadblock', n: 1, reward: 25000 },
      { id: 'chain', text: 'Combo {n} stunts', n: 12, reward: 35000 },
      { id: 'across', text: '{n} smashes across lanes', n: 8, reward: 25000 },
      { id: 'heavy', text: 'Flatten {n} cars or vans', n: 15, reward: 20000 },
      { id: 'bridge', text: 'Smash {n} things on the bridge', n: 4, reward: 25000, zone: 'bridge' },
      { id: 'tunnel', text: 'Smash {n} things in the tunnel', n: 4, reward: 25000, zone: 'tunnel' },
      { id: 'chopper', text: 'Shake the police chopper', n: 1, reward: 25000, fromSegment: 1 },
      { id: 'dodge', text: "Dodge a cruiser's swerve", n: 1, reward: 20000 },
      { id: 'clean', text: 'Sign off without a bounce', n: 1, reward: 35000 },
      { id: 'rampage', text: 'Hold Rampage for {n} seconds', n: 60, reward: 25000 },
    ] as { id: string; text: string; n: number; reward: number; zone?: 'bridge' | 'tunnel' | 'avenue'; fromSegment?: number }[],
  },

  /**
   * Forks (Mike, 2026-11-15): on a highway, an exit ramp to an avenue opens `distance` m ahead (like the
   * sign-off ramp). Rightmost lane at the gore takes it: the broadcast cuts away and the road ahead
   * becomes that avenue (denser, more to smash); chasing police can't follow (each one engaged is shaken).
   * Staying keeps the highway. Forks open at these broadcast times (s), never within `clearOfExit` m of
   * the sign-off or after `lastAt` s; a missed window waits for the next highway stretch.
   */
  forks: { at: [30, 58, 86] as number[], lastAt: 108, distance: [150, 330] as [number, number], clearOfExit: 320, propsAfter: 35 },

  /** HUD scale (Direction B): pieces are laid out for 1280×720 and zoomed by min(w/1280, h/720), clamped. */
  /**
   * HUD triage (Mike, 2026-11-17): the producer's asks show for `asksIntro` s at the top of a segment and
   * `asksFlash` s when one lands, then get out of the way (the recap lists them). Heat stars are off the HUD.
   */
  hud: { minScale: 0.5, maxScale: 1.3, asksIntro: 8, asksFlash: 3 },

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
      { name: 'Head-On', yawDeg: 12, pitchDeg: 44, distance: 108, fov: 16, headOn: true, swoopHome: true },
      // Mike: a higher head-on. Steeper means more road per screen, so further out to keep ≥2s below him.
      { name: 'High Head-On', yawDeg: 10, pitchDeg: 58, distance: 122, fov: 17, headOn: true, swoopHome: true },
      // Mike: almost directly above. Travel stays screen-up; shows lanes, merges and the convoy like a map.
      { name: 'Overhead', yawDeg: 0, pitchDeg: 82, distance: 70, fov: 30, swoopHome: true },
      // Mike (2026-11-17): the sign-off sweeps deeper into a head-on, low and close, looking back down the road he came
      // along; framed behind him so the end of the ramp ahead of him is out of shot. Outro only.
      { name: 'Sign-Off', yawDeg: 16, pitchDeg: 20, distance: 46, fov: 24, headOn: true, outro: true, lookBehind: 9 },
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
    /** Sign-off outro: the chopper swivels into Head-On as he takes the ramp (the swoop's 1.4s), holds, then the recap cuts in (s). */
    signOffHold: 2.4,
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
    /** The ramp's stretch of road is planned this long before it opens (s), and kept ramp-friendly for this far (m). */
    planAhead: 30,
    planLength: 450,
    /** If no eligible segment sits inside that window, search up to this far. */
    exitSearchMax: 330,
    /** The ramp splits from the right edge this far into its segment (the gore point). */
    goreAt: 26,
    /** Keep the exit lane clear of props this far before the gore (m). */
    exitClear: 40,
    /** ...and this far past it: he crosses the exit lane while the ramp pulls clear (no collisions after sign-off). */
    exitClearAfter: 40,
    /** Steering onto a ramp (sign-off or fork) up to this long after passing the gore still takes it (s): forgiving, the ramp is still beside him. */
    lateTake: 0.35,
  },

  /** §12 Ratings / Heat / Pin. */
  show: {
    /** §4/§12: Ratings start at 20 each segment; 0..100. */
    startRatings: 20,
    max: 100,
    /** §12 gains. Sustained Rampage is per second. */
    /** Police crash (a cruiser he led into something Heavy): the best TV of the chase, above lost track. Collateral: police plough through something Medium. */
    /** Rampage 0 (Mike, 2026-11-16, deviation from §12's +1/s): the trickle was invisible and half of all gains; the audience now moves only for what he does. */
    gain: { medium: 2, heavy: 5, nearMiss: 3, lostTrack: 6, rampage: 0, policeCrash: 8, collateral: 2 },
    /** HUD: viewers shown per Ratings point ("370K WATCHING" at the starting 20). */
    viewersPerPoint: 18_500,
    /** §12 decay: after 3s with no gain; segment 1 rate (2.0/2.75/3.5/4.25/5.0 by segment). */
    decayAfter: 3,
    decayRate: [2.0, 2.75, 3.5, 4.25, 5.0],
    /** No decay in a segment's opening seconds (cold open, the prop-free run-up, Jog can't score): balance 2026-11-16, later segments otherwise bust at ~9s before he can reach anything. */
    decayGrace: 12,
    /** §12 variety: repeats within 10s pay ×0.5 then ×0.25; a type unseen this segment pays ×1.5. */
    repeatWindow: 10,
    repeatMult: [1, 0.5, 0.25],
    freshMult: 1.5,
    /** §12 outnumbered: 6+ pursuers chasing → ×1.25 all gains. */
    outnumberedAt: 6,
    outnumberedMult: 1.25,
    /** Gear multiplier on spectacle points (was §12's per-second banking multiplier). */
    bankMult: [1, 1.5, 2],
    /** §12 Heat: rises at these Ratings, and +1 every 45s; never falls in a segment. */
    heatAt: [30, 50, 70, 90],
    heatEvery: 45,
    /** v0.3 §11 box-in (Pin): fills when both adjacent lanes are blocked and a unit is within 8m ahead below 4 m/s. */
    /** Police Net: about 2.5s boxed and slow to fill (was 25/s, 4s, when nothing could box him). */
    pinFill: 40,
    pinDrain: 30,
    /** Police Net: pressed behind the truck he bounces between 2 and ~5 m/s, so "slow" is anything under Jog speed. */
    pinBelow: 6,
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
      { cadence: 6, cap: 3, kinds: ['cruiser', 'spike', 'rolling', 'chopper'] },
      { cadence: 5, cap: 4, kinds: ['cruiser', 'spike', 'rolling', 'roadblock', 'chopper', 'net'] },
      { cadence: 4, cap: 5, kinds: ['cruiser', 'spike', 'rolling', 'roadblock', 'chopper', 'net'] },
      { cadence: 4, cap: 5, kinds: ['cruiser', 'spike', 'rolling', 'roadblock', 'chopper', 'net'] },
    ] as { cadence: number; cap: number; kinds: ('cruiser' | 'spike' | 'rolling' | 'roadblock' | 'chopper' | 'net')[] }[],
    weights: { cruiser: 3, spike: 2, rolling: 1.5, roadblock: 1.5, chopper: 1, net: 6 },
    /** LOCKED (§1): never spawn within 40m. Behind spawns also sit behind every camera. */
    spawnBehind: 100,
    spawnAheadMin: 110,
    /** Cruiser ram (v0.3: blinker + 0.6s drift, then swerve into your lane). */
    cruiser: {
      closeSpeed: 7, tell: 0.6, drift: 0.6, swerve: 0.35, fallBack: 6, sideSpeed: 5,
      /** Alongside him it holds its lane whatever is ahead (Mike, 2026-11-17: kiting works anywhere, not just at the road edge). */
      fixated: true,
      /** A ram that connects costs a gear even at Rampage (Mike, 2026-11-16: Rampage is defended, not kept); a Shoulder Check into it still flattens it. */
      ramBeatsRampage: true,
      /**
       * Kiting (Mike, 2026-11-16: "still not able to kite the following police"): with no room beside him a cruiser
       * tails him `gap` m back in his lane, steering at `sideSpeed` m/s for where he was `react` s ago; it gives up
       * after `giveUp` s. It doesn't watch the road, so a late sidestep round a Heavy or a bulldozer crashes it.
       */
      tail: { gap: 2, react: 0.3, sideSpeed: 4, giveUp: 14 },
    },
    /** Rolling roadblock (v0.3: brake lights 1.5s, 2–3 cruisers abreast slowing). */
    /** Tells start inside the visible road (the frame shows ≥2s ahead; capped at 28m for the faster Hijack ride), or nobody sees them. */
    rolling: { cruiseFactor: 0.55, tellAhead: 1.9, tellMin: 25, tellMax: 28, tell: 1.5, decel: 6, crawl: 3, actMax: 12 },
    /** Spike strip (v0.3: officer kneels, 1.2s, covers one lane). Crossing it: −1 tier, keep 70% speed, stumble. */
    spike: { aheadTime: 4.5, aheadMin: 60, tellAhead: 1.9, tellMax: 28, tell: 1.2, speedKeep: 0.7 },
    /** Static roadblock (v0.3: cars slide in 2.0s, all lanes but one; the gap glows). */
    roadblock: { aheadTime: 7.5, slideAhead: 1.9, slideMax: 28, tell: 2.0 },
    /**
     * Police chopper spotlight (v0.3 §11: cone sweeps 1.5s, marks your lane for units; change lanes
     * twice to shake it). It waits off the top of the frame until no other tell is live, sweeps in to
     * `tellAhead` (on screen, like every tell), then the cone sweeps onto him. Locked: police arrive
     * `spawnBoost`× as fast. Two lane changes with under `shakeWindow` between them shake it (+lost track);
     * a tunnel breaks line of sight; after `lockMax` it gives up (no award). At most one per `every` s:
     * it's a set piece, not traffic.
     */
    chopper: { holdAhead: 3.2, holdMin: 70, sweepInSpeed: 40, tellAhead: 1.9, tellMax: 28, tell: 1.5, trackSpeed: 7, shakeWindow: 3, shakes: 2, lockMax: 12, spawnBoost: 2, leaveTime: 1.5, giveUp: 12, every: 25 },
    /**
     * Police crashes: a cruiser chasing in a lane hits what's in it. It watches the giant, not the road,
     * so it only reacts `react` m ahead (swerving to a clear lane that isn't his). Medium and lighter: it
     * ploughs through (keeps `plowKeep` of its speed). Heavy or immovable: it crashes out of the chase, and
     * a Heavy prop goes flying with it. Only within `visibleBehind` m behind him and ahead of that, so every
     * crash is in the chopper's frame (§1).
     */
    /** avoidLook: behind the frame (not news), a cruiser looks this many seconds ahead and steers round solid things; avoidHold s before it rejoins his path. */
    crash: { react: 6, plowKeep: 0.8, visibleBehind: 5, avoidLook: 0.7, avoidHold: 0.8 },
    /**
     * Police Net (Mike, 2026-11-16: "a real box-in", one goal and two threats). From Heat 3, at most
     * `perSegment[heat - 1]` a segment, `minGap` s apart. An armoured truck (nothing smashes it) takes his
     * lane ahead while two flankers (only a Shoulder Check breaks them) come up alongside; the truck then
     * brakes into him. Boxed and slow, the Pin meter fills: the first time it fills in a segment he slips
     * the net (a gear and `slipRatings` lost), the second time he's busted. Ways out: Shoulder Check a
     * flanker (Stride+), brake and drop back behind them, take the gap before they close, Leap, the Stare.
     * The truck cruises like a rolling roadblock until its tell (on screen, like every tell), then brakes.
     */
    net: { perSegment: [0, 0, 1, 2, 2] as number[], minGap: 30, cruiseFactor: 0.55, tellAhead: 1.9, tellMin: 25, tellMax: 28, /** The crew breaks off if its truck gets this far ahead before closing (spawns ≤120m ahead; he slowed and it never waits). */ giveUpAhead: 145, tell: 1.5, decel: 7, crawl: 3.5, flankClose: 9, flankAccel: 8, flankDecel: 5, flankHold: 14, flankSide: 3, actMax: 10, escapeAfter: 1.5, slipRatings: 15 },
    /**
     * Rolling Blockade (the rolling roadblock, upgraded): from `armoredFrom` Heat, one car in the line is the
     * armoured truck; and with 3+ lanes the gap moves: every `shiftEvery` s a car next to it slides over
     * (`shiftTime` s, blinker first), so the open lane is a moving target. The compact is still the weak link.
     */
    blockade: { armoredFrom: 3, shiftEvery: 2.2, shiftTime: 0.8 },
    /**
     * Car Carrier Spill (traffic, not police): a carrier in a lane ahead, cruising at `cruiseFactor` of his
     * speed until it's in the frame (its tell), then holds station near the top of the frame and drops `drops`
     * stalled cars, one every `dropEvery` s, into its lane or the next; never a drop he couldn't see coming
     * (`dropLead` s), never one that closes the last open lane. Heavy: Rampage (or a Stride Shoulder Check) smashes the carrier itself.
     */
    carrier: { firstAt: 30, every: [40, 60] as [number, number], cruiseFactor: 0.62, tellAhead: 1.9, tellMin: 25, tellMax: 28, firstDrop: 0.8, drops: 6, dropEvery: 0.9, dropLead: 1.2, leaveSpeed: 8 },
    /**
     * Caught (Mike, 2026-11-16: "the run doesn't end when police catch up"). Every segment, no Heat gate: while he
     * crawls under `below` m/s (braking; Jog's top is 6), any cruiser within `from` m behind pulls up to `gap` m off
     * his back (police further back close at `runDown` m/s over his speed, not the usual 7), and police within
     * `reach` m of him fill the meter at `fill`/s (≈3.3s). The first fill in a segment
     * he shakes them (they drop back for `backOff` s; a gear, a stumble and `net.slipRatings` lost), the second busts.
     */
    /** `slips`: catches shaken off before one busts him. 0 (Mike, 2026-11-17: "if they catch the giant once it's game over"). */
    caught: { below: 4, from: 20, gap: 2.5, reach: 3.5, fill: 30, backOff: 2.5, runDown: 14, slips: 0 },
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
   * passives stack. Prices are paid from banked spectacle points (the run score is what you earned,
   * spending doesn't lower it). Working default (×7.5 when spectacle points replaced per-second banking, 2026-11-15): a cleared segment banks ~180k median with the bot (p10 120k, p90 245k), so one
   * segment affords the cheaper half; saving up for Leap/Hijack is a real choice.
   */
  upgrades: {
    leap: { kind: 'ability', price: 195000, label: 'Leap', blurb: 'Hop lanes of trouble. The landing flattens what you land on.', pitch: 'Get a clean shot of him clearing the spike strip.' },
    stare: { kind: 'ability', price: 160000, label: 'The Stare', blurb: 'Traffic and police ahead pull out of your lane.', pitch: 'Stay tight on the eyes. We have time.' },
    hijack: { kind: 'ability', price: 225000, label: 'Hijack Hop', blurb: 'Ride a car through everything, then bail at Rampage.', pitch: 'Follow him across the car roofs. Keep it wide.' },
    pose: { kind: 'ability', price: 160000, label: 'Pose for the Camera', blurb: 'Stop for the cameras. Heat becomes a Ratings spike.', pitch: 'Hold the close-up. He’s giving us a usable still.' },
    ironShins: { kind: 'passive', price: 125000, label: 'Iron Shins', blurb: 'Medium objects never bounce you.', pitch: 'Keep rolling. The street furniture won’t slow him down.' },
    secondWind: { kind: 'passive', price: 125000, label: 'Second Wind', blurb: 'The box-in meter drains 50% faster.', pitch: 'Stay with him. He’s slipping out of the box-in faster.' },
    showman: { kind: 'passive', price: 165000, label: 'Showman', blurb: 'Something new on air pays double.', pitch: 'Double the variety bonus when he gives us something we haven’t aired.' },
    tailwind: { kind: 'passive', price: 140000, label: 'Tailwind', blurb: 'Tier up 30% sooner.', pitch: 'Cue the wide shot. He’s hitting the next speed tier 30% sooner.' },
  } as Record<UpgradeId, { kind: 'ability' | 'passive'; price: number; label: string; blurb: string; /** The producer's line on the meeting card (flavour). */ pitch: string }>,

  /**
   * Leaderboard (§29: shared, server-side). Scores are re-simulated from the inputs on the server.
   */
  leaderboard: {
    /** Inputs per segment a submission may carry: 165s segment + the outro, with room (60 Hz). */
    maxTicks: 20000,
    /** Longest name on the board (fits the recap row at phone width). */
    nameMax: 14,
    /** Rows shown on the recap board. */
    top: 10,
    /** Claimed vs re-simulated score: allowed gap (fraction). Rounding only; anything more is rejected and counted. */
    tolerance: 0.005,
    /** Submissions per IP per minute (the server's own guard; a run takes minutes). */
    perMinute: 12,
    /** Never on the board (rule 10: never mean). Matched inside the name's letters. */
    blocked: ['fuck', 'shit', 'cunt', 'nigg', 'fag', 'rape', 'nazi', 'hitler', 'retard', 'whore', 'slut', 'bitch', 'cock', 'pussy', 'kike', 'chink', 'spic', 'tranny'],
  },

  /**
   * Onboarding prompts (Mike, 2026-11-17). Each once per browser, one at a time, `gap` s apart, held `hold` s.
   * quietStart: nothing in the first seconds (the cold open). blockedLead: an unsmashable thing within this many
   * seconds of him. gearAfter: still at Jog this long in. audienceBelow: audience bar under this. kiteAhead: m of
   * road ahead of a police car alongside him.
   */
  onboarding: { quietStart: 4, blockedLead: 2.2, gearAfter: 14, audienceBelow: 12, kiteAhead: 30, gap: 7, hold: 4.5 },

  /** Smash sample levels by class: the light/medium takes are ~16 dB quieter than heavy, so they play hotter. */
  sfxLevels: { light: 1.1, medium: 1.6, heavy: 1 },

  /**
   * Rampage on air (Mike, 2026-11-16: "embellish it"). Placeholder synth until the Suno stems land; the API
   * (Audio.setGear) stays. A music layer drops in at Rampage and cuts on losing it, with a power-down sweep.
   */
  rampageAudio: {
    /** Layer level on the music bus, fade in (s), fade out on loss (s). */
    layer: 0.9,
    fadeIn: 0.25,
    fadeOut: 0.12,
    /** Sub thump under each footfall at Rampage: start/end Hz, length (s), level. */
    subFrom: 52,
    subTo: 28,
    subTime: 0.32,
    subVol: 0.5,
  },

  /** Phase 3 abilities (lane-runner versions of §17's pool). 5f input buffer (§8). */
  abilities: {
    bufferFrames: 5,
    /** Leap: airborne this long (no collisions), apex height (m), landing shockwave radius (m) smashing up to Heavy. Mike's playtest: 3.2m / 0.9s didn't read from the chopper. */
    leap: { time: 1.1, height: 5.5, shockRadius: 6.5, cooldown: 6 },
    /** The Stare: the road parts this far ahead: his lane pulls over, the lanes either side move one further out; police winding up back off. */
    stare: { reach: 90, lanesEitherSide: 1, time: 0.6, cooldown: 10, glareTime: 0.9 },
    /** Hijack Hop: a vehicle within this far ahead (your lane or next to it); ride speed (just under Rampage top so every camera keeps ≥2s of road ahead), reached at `accel`, ride time, then bail at Rampage. */
    hijack: { reach: 20, speed: 14, accel: 8, time: 3, cooldown: 12 },
    /** Pose: speed held at the floor this long (a deliberate stop, §2: ≤1s); Ratings per Heat level; Heat spent. */
    pose: { time: 0.8, ratingsPerHeat: 7, heatCost: 1, cooldown: 12 },
    /** How long the "what it did" callout stays beside the ability chip (s). */
    popTime: 1.8,
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
    /**
     * Brush (presentation): his shoulders and arms reach over the next lane, so a car he passes within
     * `brushReach` m of its side (and `brushAlong` m of its ends) rocks away from him: a roll up to
     * `brushRollDeg`, a `brushShove` m nudge inside its own footprint, a suspension kick. The hitbox never moves.
     */
    brushReach: 1.6, brushAlong: 0.6, brushRollDeg: 24, brushShove: 0.3, brushKick: 1.6, brushTime: 0.9,
    /** Rampage footfalls bounce cars within this radius (m) on their suspension. */
    bounceRadius: 16,
    /** Suspension spring: peak drop (m) at the foot, frequency (Hz), damping ratio. */
    bounceDrop: 0.18,
    bounceHz: 2.2,
    bounceDamping: 0.25,
  },

  /** Phase 0c broadcast (§21). */
  broadcast: {
    /**
     * Each headline holds at least 12s (§21 said 4; Mike, 2026-11-16: 7 still "feels excessive"). Broadcast lower thirds hold
     * ~8–15s (read twice); a cable news banner holds far longer. Tier changes still interrupt with BREAKING.
     */
    headlineEvery: 12,
    /** Headline priority for reaching Rampage, and for losing it: above routine news (35–75), under the player's abilities (84–88), sightings and exits (90+). */
    rampagePrio: 83,
    rampageLostPrio: 80,
    /** §21: no verb or place reused within the last 5 headlines. */
    antiRepeat: 5,
    /** Smashes inside one headline window are counted together ("3 Cars"). */
    tallyWindow: 4,
    /** Opening headline after this long. */
    openAt: 1.2,
    /** Queued news older than this is dropped, not shown late (s). */
    staleAfter: 14,
    /** ...except the player's own ability moments (Leap, Stare, Hijack, Pose): they wait longer for a slot. */
    staleAfterAbility: 18,
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
    /** Roadside furniture on a bridge (signs, gantry posts, lamps) stands this far outside the edge: on the parapet, never over the water. */
    bridgeMount: 0.45,
    lampSpacing: 20,
    /** Real point lights reused on the nearest lamps (the rest are glow decals). Each light costs every lit pixel. */
    lampLights: 2,
    /** Chopper spotlight: ground pool radius (m), lag following the giant (s), wander (m). */
    spotRadius: 7.5,
    spotLag: 0.25,
    spotWander: 1.2,
    /** Chopper shadow crosses the road every this many seconds (random in range). */
    chopperShadowEvery: [16, 32] as [number, number],
    /** Siren flash rate (Hz). */
    sirenHz: 2.2,
  },

  /** Title screen chopper shot (Mike's visual direction): metres relative to the giant's travel. */
  title: {
    back: 14,
    left: 6,
    height: 12,
    lookAhead: 7,
    lookLeft: 6.5,
    lookHeight: 1,
    fov: 42,
    /** Leaving the title, the camera glides down into the chase over this long (s). */
    glideTime: 1.6,
    /** The cover art holds this long without input, then the live attract shot slides in (s). */
    idleToAttract: 12,
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
