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
export type UpgradeId = 'leap' | 'stare' | 'breakaway' | 'primeTime' | 'shoulder' | 'thickSkin' | 'secondWind' | 'crowdPleaser' | 'slipstream' | 'overdrive' | 'shortFuse' | 'groundZero';
export type AbilityId = 'leap' | 'stare' | 'breakaway' | 'primeTime' | 'shoulder';
export type OutfitId = 'classic' | 'midnight' | 'parade' | 'gold';

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
  /**
   * PROTOTYPE core loop (Mike, 2026-11-18: "the core loop of running down the street is weak"), behind ?proto=1.
   * Dodge until you can smash: in Stride only light things break (cones, carts, signs) and rival vans; every other
   * vehicle is a hit (stumble, audience lost). Clean running builds a sprint over `sprintBuild` s (+`sprintBonus`
   * m/s, ×`sprintPoints` distance score). Police catch him whenever he's under `caughtBelow` m/s (a stumble), not
   * only when braking. One bar: the audience IS the Rampage meter; at `max` it's ready, after Rampage it drops to
   * `afterRampage`. Dodges (near misses) feed it at `gain`. Off by default; `enableProto()` turns it on.
   */
  proto: {
    on: false as boolean,
    sprintBuild: 4,
    sprintBonus: 4,
    sprintPoints: 1,
    hitAudience: 12,
    caughtBelow: 9,
    /** A hit with police within `tail` m behind him adds `hitPin` to the CAUGHT meter (100 = busted): three sloppy hits with the police on you and it's over. */
    /** Track: rows closer than this (m, ~2s) keep a lane the last row left open; 4+ lane roads block at least this many lanes a row. */
    /** The small things that crumble underfoot in Stride (anything with wheels and an engine is a hit). */
    small: ['sawhorse', 'cart', 'fence', 'scooter', 'tollgate'] as string[],
    /** Authored chunks (src/sim/chunks.ts): the gap between two chunks (m), and the reaction time the solver allows (s). */
    chunkGap: 34,
    /** First traffic this far down the road (m): he reaches ~115m as the 6s opening hero shot swoops home, so the first cars come after it, in Chase High. */
    /** No brake (Mike, 2026-11-24: "no real reason to use the slow down mechanic, scrap it"): brake input is ignored, its prompts and binds are hidden, and the Police Net (escaped by braking) is off. */
    /** Target cars (2026-11-24): one per district at `share` of the way in; `score` points, ×`rampMult` in Rampage on top of Rampage's own double; `gain` audience. Endless: one every `endlessEvery` m. */
    target: { share: 0.4, score: 2500, rampMult: 2, gain: 20, endlessEvery: 900 },
    /** District set pieces: the first lands this long after he enters (after the title card); the theme's spawn weight ×. */
    themeDelay: 6,
    themeWeight: 4,
    /** Lane-changers: signal when he's `at` m out (~3.5s at Stride), for `signal` s, then move a lane over in `time` s; done well before he arrives, so what he reads is what he meets. */
    shift: { at: 70, signal: 0.7, time: 1.1 },
    /** The finale roadblock is queued this far before the course end (m): ~500m before the exit opens, so it finds a quiet moment (not over a blockade still out ahead). */
    finaleAt: 900,
    noBrake: true,
    firstChunk: 150,
    chunkReact: 0.45,
    /** Chunk level climbs one step every this many metres (and one per run segment). */
    levelEvery: 700,
    /** Moving traffic: oncoming cars (m/s toward him), slow box trucks (m/s his way), and how far ahead of him they wake (m, off camera). */
    /**
     * After a Car Carrier leaves, no Net, Blockade or carrier for this long (s). The build Mike liked had carriers
     * that lingered (a bug: they drove through traffic) and so held those events off; this keeps that breather on purpose.
     */
    eventGap: 0,
    /**
     * One police unit fewer at a time than the default rules. In the build Mike liked, a Car Carrier that never left
     * (a bug: it drove through traffic) took one of the slots for good; this keeps that pressure on purpose.
     */
    capLess: 0,
    /** Car Carriers in the prototype: rarer and lighter (drops each, seconds between). The build Mike liked had carriers that barely dropped (a bug); working ones at the default rate were too much. */
    carrierDrops: 3,
    carrierEvery: [70, 100] as [number, number],
    oncomingSpeed: 12,
    truckSpeed: 7,
    moverWake: 150,
    /** Moving traffic stops this far short of whatever's in front of it in its lane (m). */
    moverGap: 1.5,
    /** Endless: the audience drain grows by its base rate every this many seconds (×2 at 2 min, ×3 at 4). */
    endlessRamp: 120,
    /**
     * The story run (Mike, 2026-11-18: "an authored run through the different districts... with an end"; one unbroken
     * run). Five districts in order, each its own road (lane count by zone), name and chunk level; the sign-off ramp is
     * at the end of the last. `segments` are 40m road segments (~2.3s each at Stride with some sprint). The chopper's
     * fuel (`fuel` s, plus the usual grace) is the run's clock: a sloppy run can run dry before the end.
     */
    story: {
      fuel: 345,
      districts: [
        { zone: 'highway', name: 'Mile Zero Interstate', segments: 30, level: 1, theme: 'carrier' },
        { zone: 'bridge', name: 'Saltmarsh Bridge', segments: 16, level: 3, theme: 'spike' }, // level 3: the harder two-lane chunks (2026-11-19)
        { zone: 'avenue', name: 'Downtown', segments: 32, level: 3, theme: 'roadblock' },
        // Four lanes, two directions (Mike, 2026-11-19): the oncoming side comes at him inside the walls.
        { zone: 'tunnel', name: 'Old Harbor Tunnel', segments: 16, level: 4, lanes: 4, oncoming: 2, theme: 'cruiser' },
        // The finale opens out to six lanes (Mike, 2026-11-18: the cover art's six-lane highway).
        { zone: 'highway', name: 'Uptown Expressway', segments: 34, level: 5, lanes: 6, oncoming: 3, peak: true, pace: 1.4, theme: 'rolling' },
      ] as { zone: 'highway' | 'avenue' | 'bridge' | 'tunnel'; name: string; segments: number; level: number; lanes?: number; /** Two-way for the whole district (2026-11-19): its left `oncoming` lanes come at him, every chunk. */ oncoming?: number; /** The run's peak (2026-11-24): only top-level chunks, no breathers from below. */ peak?: boolean; /** Police spawn pace in this district (×). */ pace?: number; /** Its set piece (2026-11-24): one guaranteed `themeDelay` s in, and the police lean to it (`themeWeight`). */ theme?: 'carrier' | 'spike' | 'roadblock' | 'cruiser' | 'rolling' }[],
    },
    /**
     * Story asks (Mike, 2026-11-19): the producer's asks span the whole run. Before going live he picks up to
     * `storyPick` from what's offered (`storyOffer` per tier). A tier-2/3 ask needs `requires` done first (in any
     * earlier run); one with `unlock` unlocks that traffic mod the first time it's done. `district` is the
     * district index it's about. No score: the reward is the unlock (prototype scores are off the board).
     */
    storyPick: 3,
    /** Asks offered beyond the picks, at least: a fresh profile still gets a choice (topped up with easy asks). */
    storySpare: 1,
    storyOffer: [2, 2, 2],
    storyAsks: [
      { id: 's-scoops', tier: 1, kind: 'scoops', n: 8, text: 'Grab {n} Exclusives' },
      { id: 's-rampage', tier: 1, kind: 'rampage', n: 3, text: 'Go Rampage {n} times' },
      { id: 's-rivals', tier: 1, kind: 'rivals', n: 2, text: 'Flatten {n} rival news vans' },
      { id: 's-near', tier: 1, kind: 'nearMiss', n: 12, text: '{n} near misses' },
      { id: 's-bridge', tier: 2, kind: 'cleanDistrict', district: 1, n: 1, text: 'Cross Saltmarsh Bridge without a hit', requires: 's-scoops', unlock: 'heavyLoad' },
      { id: 's-crash', tier: 2, kind: 'crashBefore', district: 3, n: 2, text: 'Crash {n} police cars before the tunnel', requires: 's-rampage', unlock: 'hotPursuit' },
      { id: 's-chain', tier: 2, kind: 'chain', n: 15, text: 'Combo {n} stunts', requires: 's-near', unlock: 'glassJaw' },
      { id: 's-target', tier: 1, kind: 'targets', n: 2, text: 'Crush {n} target cars' },
      { id: 's-target-ramp', tier: 3, kind: 'rampTargets', n: 2, text: 'Crush {n} target cars in Rampage', requires: 's-target' },
      { id: 's-rampsmash', tier: 2, kind: 'rampsmash', n: 12, text: 'Smash {n} things in one Rampage', requires: 's-rivals' },
      { id: 's-finish', tier: 1, kind: 'finish', n: 1, text: 'Make it to the sign-off' }, // Easy (Mike, 2026-11-24: it was a Medium that felt easy)
      { id: 's-tunnel', tier: 3, kind: 'cleanDistrict', district: 3, n: 1, text: 'Through the tunnel without a hit', requires: 's-bridge' },
      { id: 's-units', tier: 3, kind: 'units', n: 4, text: 'Flatten {n} police cars', requires: 's-crash', unlock: 'shortLeash' },
      // Replaces 'Shake the police chopper' (Mike, 2026-11-24: there's no real way to lose it).
      { id: 's-scoops20', tier: 3, kind: 'scoops', n: 20, text: 'Grab {n} Exclusives', requires: 's-scoops', unlock: 'liveWire' },
      { id: 's-clean', tier: 3, kind: 'cleanRun', n: 1, text: 'Sign off without a single hit', requires: 's-tunnel' },
      { id: 's-modded', tier: 3, kind: 'finishModded', n: 1, text: 'Sign off with a traffic mod on', requires: 's-finish' },
    ] as { id: string; tier: 1 | 2 | 3; kind: string; n: number; text: string; district?: number; requires?: string; unlock?: string }[],
    /** Traffic mods (unlocked by story asks): harder runs on purpose, for a score multiplier. Both keep every chunk solver-proven. */
    mods: {
      heavyLoad: { label: 'Heavy Load', how: 'Harder traffic everywhere, no easy stretches', score: 1.3 },
      hotPursuit: { label: 'Hot Pursuit', how: '50% more police on his tail', score: 1.3, pace: 1.5 },
      // More mods (Mike, 2026-11-24: "traffic mods yes"): each leans on a different pressure, none touches the solver.
      // Labels renamed by Mike (2026-11-24); ids kept so saved unlocks carry over.
      glassJaw: { label: 'Fragile', how: 'Hits cost twice the audience', score: 1.3, hit: 2 },
      liveWire: { label: 'Attention Span', how: 'The audience tunes out half again as fast', score: 1.25, drain: 1.5 },
      shortLeash: { label: 'Short Leash', how: 'Slow down and the police catch him half again as fast', score: 1.2, catch: 1.5 },
    } as Record<string, { label: string; how: string; score: number; pace?: number; /** × audience lost per hit */ hit?: number; /** × audience drain */ drain?: number; /** × CAUGHT fill */ catch?: number }>,
    reachGap: 36,
    wideMinBlocked: 2,
    tail: 22,
    hitPin: 20,
    afterRampage: 55,
    /** Dodges are the Stride verb, so they skip the variety rule; the near-miss window is wider (m); the drain is gentler. */
    dodgeGap: 2.2,
    decayMult: 0.6,
    startRatings: 40,
    gain: { scoop: 7, nearMiss: 6.5, rival: 10, policeCrash: 12, lostTrack: 8, collateral: 1, target: 20 } as Record<string, number>,
  },

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
    /** Rampage swells him (2026-11-17, a Rampage tell; he runs through everything then, so the bigger hit-box only smashes more). */
    scale: [1.3, 1.3, 1.45] as [number, number, number],
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
    /** Cape clasp height on the torso (m, torso space; the far corner 0.2 higher): across the upper back (was 1.2, the low back). */
    capeClaspY: 1.6,
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
    // Mike (2026-11-17): "his rampage speed should be his default speed, game feels slow without it". Stride runs at
    // 15 m/s with the full-speed run (the old Rampage pose and framing); a quicker lane change keeps it light on its feet.
    { name: 'Stride', topSpeed: 15, accel: 6, tierUpAfter: Infinity, smashes: 'heavy', laneChangeTime: 0.3, cadence: 3.1, specStrideLength: 6.0, leanDeg: 38, hipHeight: 1.6, bodyDrop: 0.24, footLift: 1.05, cameraDistanceScale: 1.2, armSwing: 1.5, armBase: 0, flightLift: 0.11, elbowBend: 1.6, capeAngle: 78, capeFlutterHz: 6.0, capeFlutterAmp: 0.18 },
    // Rampage is a state now, not a faster gear: same speed, a deeper lean, a wilder arm pump and cape, the chopper a little further out (plus the tells in TUNING.rampageFx).
    { name: 'Rampage', topSpeed: 15, accel: 6, tierUpAfter: Infinity, smashes: 'heavy', laneChangeTime: 0.32, cadence: 3.1, specStrideLength: 6.0, leanDeg: 46, hipHeight: 1.58, bodyDrop: 0.28, footLift: 1.15, cameraDistanceScale: 1.3, armSwing: 1.9, armBase: 0.05, flightLift: 0.13, elbowBend: 1.7, capeAngle: 86, capeFlutterHz: 8, capeFlutterAmp: 0.26 },
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

  /**
   * The Rampage loop (Mike, 2026-11-17: "keep it in Stride, remove the Jog state, make Rampage the payoff").
   * Deviation from v0.3 §7–9's three gears built by running. Stride is the base gear (every segment opens on a
   * short run-up from `giant.startSpeed`); stunts in Stride fill the meter (`gain`, points per stunt, a full
   * meter is 100); full, the Rampage button (the old Shoulder Check button) fires Rampage for `duration` s,
   * each smash adding `perSmash` s up to `maxDuration` in all. In Rampage he runs through everything
   * (bulldozers, police, the Net's truck) and spikes don't touch him. A hit in Stride costs `bounceCost` of the
   * meter instead of a gear. Score: `distancePoints` a metre at all times (× the gear's bankMult).
   */
  rampage: {
    /** At 15 m/s (2026-11-17) Stride meets more per second: gains ×0.8 keep Rampage about a quarter of the run. */
    gain: { scoop: 6, rival: 25, target: 30, medium: 7, heavy: 10, unit: 13, policeCrash: 16, collateral: 5, nearMiss: 8, ramDodge: 10, lostTrack: 10, chopperShaken: 12, leapLand: 8, breakawayLand: 10 } as Record<string, number>,
    duration: 8,
    perSmash: 0.3,
    maxDuration: 12,
    bounceCost: 25,
    distancePoints: 4,
    /** Second Wind: a Rampage ends with the meter this full. */
    secondWindKeep: 33,
    bufferFrames: 5,
  },

  /**
   * Rampage tells (presentation, 2026-11-17: "we just need a stronger tell for the rampage state"). His rim light
   * heats from the look's lilac to `rimColor` at `rimBoost`× strength (eased over `ease` s, a slow `pulseHz`
   * throb), a hot vignette at the screen edges (CSS), plus the size swell (growth.scale), the pose, the music layer
   * and the meter's countdown. All under 3 Hz; Reduce Flashes holds the throb still.
   */
  /** Activation: hit-pause frames, a one-frame flash (off under Reduce Flashes), a camera jolt (px) and a rumble (ms). */
  rampageFx: {
    /**
     * Gold aura (Mike, 2026-11-24: "Hercules glow / SSJ aura", gold): halo + flame tongues behind him, additive.
     * height: aura height per unit of his size (m, a head above him); behind: pushed away from the camera (m) so he
     * stays in front; flicker/lick under 3 Hz (photosensitivity); burst: the gold shockwave rings when it fires.
     */
    aura: { color: 0xffc83a, height: 4.8, behind: 0.8, haloScale: 1.25, haloOpacity: 0.55, flames: 5, flameWidth: 0.42, flameHeight: 0.95, flameLick: 0.25, flameOpacity: 0.6, flicker: 0.12, flickerHz: 2.2, lickHz: 2.6, burst: [[16, 0.7, 0.95], [10, 0.5, 0.9], [22, 0.9, 0.6]] as [number, number, number][] },
    rimColor: 0xffc23a, rimBoost: 2.4, rimFloor: 0.5, /** Dusk and day: barely brighter, just hotter in colour. */ rimBoostLit: 1.15, ease: 0.25, pulseHz: 1.6, pulseAmp: 0.25, slamHitstop: 6, slamFlash: 2, slamShake: 7, slamHaptic: 220 },

  shoulderCheck: {
    /** §7 0.25s burst that smashes one mass class up (unchanged in v0.3). */
    duration: 0.25,
    cooldown: 3,
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
    /** Rampage crush reach (m, from his centre): his drawn body at Rampage size; a lane is 4m, a car in the next lane starts 3m out, so it never reaches across. */
    rampageReach: 2.4,
    /** Light things (yellow-ringed smashables, Scoops) break within this reach at any gear: his feet and shins, not just the hit-box. */
    lightReach: 1.8,
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
    light: { hitstop: 0, shake: 0, flashFrames: 0, haptic: 35, hapticStrength: 0.3 }, // a short tick on every yellow item (Mike, 2026-11-24)
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
    /** Render-only road behind the start line (segments), so the opening head-on shot has road behind him. */
    leadInSegments: 6,
    /** Perf (2026-11-25): new road segments built per rendered frame (the first frame builds all), so no frame pays for several. */
    segBuildsPerFrame: 1,
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
    rowChance: { highway: 1, avenue: 1, bridge: 0.85, tunnel: 0.8 },
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

  /**
   * Pacing pass (Mike, 2026-11-17: "a stretch of like 6s with nothing to do"; "bored around segment 3").
   * - `maxEmpty`: never more than this many metres without a prop row (~2.5s at Rampage, ~4s at Stride),
   *   whatever the random rolls said (landmarks and the sign-off's clear lane still win).
   * - Later segments get busier rather than only harsher: rows closer together and landmarks more often.
   */
  pacing: {
    maxEmpty: 38,
    /** Scales the random part of `props.rowGap` above its minimum (16m stays: closer rows can trap him between bulldozers). */
    rowGapScale: [1, 0.88, 0.76, 0.66, 0.58] as number[],
    landmarkEveryScale: [1, 0.9, 0.8, 0.7, 0.65] as number[],
  },

  /**
   * Difficulty curve (Mike, 2026-11-17: "a difficulty curve across the five segments"), by segment of the run:
   * - `dozer`: chance a blocked lane slot is a bulldozer (nothing breaks it but Rampage or a Leap).
   * - `concrete`: chance a Heavy slot is a concrete barricade (breaks only in Rampage: Stride bounces off it).
   * - `hardPerRow`: most of those in one row (a lane always stays open).
   * - `meterGain`: Rampage meter gains × this (later segments make you earn it).
   * - Police scale with Heat (each segment starts one higher, §19); segment 5 ends with a roadblock at the exit.
   */
  difficulty: {
    dozer: [0.14, 0.18, 0.22, 0.26, 0.3] as number[],
    concrete: [0.12, 0.18, 0.24, 0.3, 0.36] as number[],
    hardPerRow: [1, 1, 1, 2, 2] as number[],
    meterGain: [1, 1, 0.95, 0.9, 0.85] as number[],
    /** Last segment: a police roadblock spawns when the exit opens (it's ≥40m ahead and off camera, as always). */
    finaleRoadblock: true,
    /** ...placed when no other tell is live; given up inside this many metres of the gore. */
    finaleGiveUp: 150,
  },

  /**
   * The guided first broadcast (Mike, 2026-11-17: the first-time experience). The very first broadcast a player
   * goes live in opens calm: no audience drain and no police for `calmFor` s, and nothing he can't smash (bulldozers,
   * concrete) for the first `clearFor` m, while the onboarding prompts walk him through lanes, smashing and Rampage.
   * Landmarks keep their own patterns. The flag rides the leaderboard submission so the server replays it the same.
   */
  /** meterGain: Rampage meter gains × this during the calm, so a first-timer's first Rampage lands inside it (bot: 21s → ~12s). */
  /** rampageBy: if Rampage hasn't fired by this sim time (s), the audience tops up so the first one lands in the first minute. */
  guided: { calmFor: 25, clearFor: 400, meterGain: 1.8, rampageBy: 55 },

  /**
   * Things worth aiming for (Mike, 2026-11-17: "not enough to do during the runs, especially during Rampage").
   * - Rival news vans (a rival station's van, dish on the roof): `newsvanChance` of Heavy traffic slots. Flattening one
   *   pays big (spectacle `rival`, Ratings, Rampage meter).
   * - Rampage surge: firing Rampage packs the road `ahead`…`ahead + length` m out (past the frame, so nothing pops in)
   *   with rows of traffic every `rowGap` m, `fill` lanes a row (always one open), rival vans at `surgeVanChance`:
   *   Rampage is a spree to steer, not an empty road.
   */
  targets: { newsvanChance: 0.05, ahead: 70, length: 120, rowGap: [12, 16] as [number, number], fill: [1, 1] as [number, number], surgeVanChance: 0.15 },

  /**
   * Editions (Mike, 2026-11-17: "after one five-segment run I felt no reason to play more"; the design pillar: never a
   * waste of time). Winning a full run unlocks the next edition of the news; each is harder (cumulative) and pays
   * more: `decay` × the audience drain, `heat` police start this much hotter, `meter` × Rampage meter gains,
   * `hard` × bulldozer/concrete chances; `score` × the run's score. Picked on the main menu.
   */
  editions: [
    { name: 'Evening News', decay: 1, heat: 0, meter: 1, hard: 1, score: 1 },
    { name: 'Late Edition', decay: 1.1, heat: 0, meter: 1, hard: 1, score: 1.25 },
    { name: 'Night Owl', decay: 1.1, heat: 1, meter: 1, hard: 1, score: 1.5 },
    { name: 'Breaking Coverage', decay: 1.1, heat: 1, meter: 0.85, hard: 1, score: 1.75 },
    { name: '24-Hour News', decay: 1.1, heat: 1, meter: 0.85, hard: 1.5, score: 2 },
  ] as { name: string; decay: number; heat: number; meter: number; hard: number; score: number }[],

  /** v0.3 props in lanes: Medium and Heavy only, densities tunable. */
  props: {
    /** No props before this distance (runway). */
    startAt: 45,
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
    /** Superseded by TUNING.difficulty.dozer (by segment). */
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
  gear: { buildUp: 1.0, buildRingScale: 0.9, fovPunch: 0.14, fovPunchTime: 0.5, shockRadius: 10, trafficAlarm: 1.6, trafficAlarmBrakeAt: 85, dustKick: [0, 3, 8], /** Rampage loop: the build-up plays over the meter's last stretch, from this %. */ meterBuildFrom: 85 },

  /**
   * Recap REPLAY (presentation): the night's top moment, re-simulated from the recorded inputs and
   * played back before the recap card. Starts `lead` s before the moment at full speed, slows to `slow`×
   * from `slowBefore` s before to `slowAfter` s after, and ends `after` s after. Scores pick the moment
   * (the highest wins; ties go to the later one). Shot from a cut-away angle.
   */
  replay: {
    /** Run end dissolves to the replay/recap (Mike, 2026-11-19): length (s) and block size (px) of the broadcast-glitch dissolve. */
    /** Each unlock card holds this long before moving on by itself (s). */
    unlockHold: 3,
    dissolve: 0.8,
    dissolveBlock: 24,
    lead: 2.2, slow: 0.35, slowBefore: 0.35, slowAfter: 1.0, after: 1.6, angle: 'Long Lens',
    /** Outro frames spend up to this long (ms) fast-forwarding the replay's sim, so starting it doesn't hitch. */
    prerollMs: 4,
    /** The recap's picture: grabbed this long after the moment (debris in the air), at this width in px (a still, not a screenshot). */
    shotAfter: 0.2, shotWidth: 960,
    /** The recap's looping clip: recorded off the canvas during the replay at this frame rate and bitrate; under `clipMin` s (skipped early) the still stays. */
    clipFps: 30, clipBitrate: 2_500_000, clipMin: 1.5,
    score: { policeCrash: 10, unitSmash: 7, leapLand: 4, breakawayLand: 5, heavyAcross: 6, heavy: 4, nearMiss: 4, ramMiss: 4 },
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
    points: { scoop: 300, rival: 800, target: 2500, medium: 100, heavy: 250, unit: 500, policeCrash: 750, collateral: 100, nearMiss: 200, ramDodge: 200, lostTrack: 250, chopperShaken: 300, leapLand: 150, breakawayLand: 250 },
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
      { id: 'units', text: 'Flatten {n} police cars', n: 3, reward: 30000 },
      { id: 'crash', text: 'Get a police car to crash', n: 1, reward: 30000 },
      { id: 'roadblock', text: 'Smash through a roadblock', n: 1, reward: 25000 },
      { id: 'chain', text: 'Combo {n} stunts', n: 12, reward: 35000 },
      { id: 'across', text: '{n} smashes across lanes', n: 8, reward: 25000 },
      { id: 'heavy', text: 'Flatten {n} cars or vans', n: 15, reward: 20000 },
      { id: 'bridge', text: 'Smash {n} things on the bridge', n: 4, reward: 25000, zone: 'bridge' },
      { id: 'tunnel', text: 'Smash {n} things in the tunnel', n: 4, reward: 25000, zone: 'tunnel' },
      { id: 'chopper', text: 'Shake the police chopper', n: 1, reward: 25000, fromSegment: 1 },
      // 'dodge' (dodge a cruiser's swerve) is out of the pool (2026-11-17): on the busier road a ram rarely gets to swerve (soak: 0 of 48).
      { id: 'clean', text: 'Sign off without a bounce', n: 1, reward: 35000 },
      { id: 'rampage', text: 'Go Rampage {n} times', n: 4, reward: 25000 },
      { id: 'rampsmash', text: 'Smash {n} things in one Rampage', n: 10, reward: 30000 },
      { id: 'rivals', text: 'Flatten {n} rival news vans', n: 2, reward: 30000 },
    ] as { id: string; text: string; n: number; reward: number; zone?: 'bridge' | 'tunnel' | 'avenue'; fromSegment?: number }[],
  },

  /**
   * Forks (Mike, 2026-11-15): on a highway, an exit ramp to an avenue opens `distance` m ahead (like the
   * sign-off ramp). Rightmost lane at the gore takes it: the broadcast cuts away and the road ahead
   * becomes that avenue (denser, more to smash); chasing police can't follow (each one engaged is shaken).
   * Staying keeps the highway. Forks open at these broadcast times (s), never within `clearOfExit` m of
   * the sign-off or after `lastAt` s; a missed window waits for the next highway stretch.
   */
  /** Forks off (Mike, 2026-11-18: the cut to a new section "is unneeded; it'll force us to author locations more"). Were [30, 58, 86]. */
  forks: { at: [] as number[], lastAt: 108, distance: [150, 330] as [number, number], clearOfExit: 320, propsAfter: 35 },

  /** HUD scale (Direction B): pieces are laid out for 1280×720 and zoomed by min(w/1280, h/720), clamped. */
  /**
   * HUD triage (Mike, 2026-11-17): the producer's asks show for `asksIntro` s at the top of a segment and
   * `asksFlash` s when one lands, then get out of the way (the recap lists them). Heat stars are off the HUD.
   */
  /** `rampWarn`: Rampage's last this-many seconds pulse red and tick (review pick 2: see it ending). */
  hud: {
    /** Chopper fuel gauge: red and pulsing for this many seconds before the segment's hard end. */
    fuelCritical: 15, minScale: 0.5, maxScale: 1.3, asksIntro: 8, asksFlash: 3, rampWarn: 1.5 },

  /** Footfall presentation (v0.3). */
  /**
   * Impact effects (review #64/#65): pooled smoke/dust puffs, metal sparks and skid marks. Puffs stay soft and
   * low so they never hide his next move (rule 2: readable from the chopper).
   */
  vfx: {
    puffMax: 72, sparkMax: 220,
    /** Rampage aura (review #65): embers a second off him (× how far into Rampage), and speed lines streaking past (off under Reduced Motion). */
    emberRate: 45, speedLineRate: 22, speedLineMax: 48, skidMax: 12, skidLife: 6, skidAlpha: 0.55,
    /** Heavy smash: puffs, size (m), life (s), alpha. */ heavySmoke: [5, 3.6, 1.4, 0.68] as number[],
    /** Medium smash: a little dust. */ mediumDust: [3, 2.2, 0.9, 0.5] as number[],
    /** Police crash: puffs and sparks (a bigger column: readable from the chopper, 2026-11-24). */ crashSmoke: [10, 5, 2.4, 0.8] as number[], crashSparks: 24,
    /** A police crash's wreck launch speed cap (m/s): it tumbles on the spot, readable, not out of frame. */
    crashTumble: 7,
    /** Metal smashed, and a bounce off something he can't break. */ metalSparks: 12, bounceSparks: 8,
    /** Stride / Rampage footfall dust puffs (per tier), size (m, scales with him). */ stepDust: [0, 1, 2] as number[], stepDustSize: 1.7,
  },

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
    /** Fork wipe: seconds until the wipe covers the screen; the road swap and the cut happen then, under it. */
    forkWipeCover: 0.28,
    angles: [
      { name: 'Chase High', yawDeg: 0, pitchDeg: 48, distance: 40, fov: 35 },
      // Cut-aways look less far ahead so the escort behind the giant is in shot (≥2s of road ahead still enforced).
      { name: 'Wide Side', yawDeg: 35, pitchDeg: 52, distance: 55, fov: 35, lookAheadTime: 0.5 },
      { name: 'Long Lens', yawDeg: 15, pitchDeg: 40, distance: 70, fov: 22, lookAheadTime: 0.7 },
      // Mike: head-on as a cut-away, from higher up (44° vs the 18° experiment). Far and telephoto so ≥2s of road ahead fits below him.
      { name: 'Head-On', yawDeg: 12, pitchDeg: 44, distance: 128, fov: 16, headOn: true, swoopHome: true },
      // Mike: a higher head-on. Steeper means more road per screen, so further out to keep ≥2s below him.
      { name: 'High Head-On', yawDeg: 10, pitchDeg: 58, distance: 140, fov: 17, headOn: true, swoopHome: true },
      // Mike: almost directly above. Travel stays screen-up; shows lanes, merges and the convoy like a map.
      { name: 'Overhead', yawDeg: 0, pitchDeg: 82, distance: 80, fov: 30, swoopHome: true },
      // Mike (2026-11-17): the sign-off sweeps deeper into a head-on, low and close, looking back down the road he came
      // along; framed behind him so the end of the ramp ahead of him is out of shot. Outro only.
      { name: 'Sign-Off', yawDeg: 16, pitchDeg: 20, distance: 46, fov: 24, headOn: true, outro: true, lookBehind: 9, swoopHome: true },
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
    /**
     * Mike (2026-11-17, "think how SA2 starts City Escape", then his screenshot of the shot he meant): every
     * broadcast opens on High Head-On (he runs down the screen at you), held `openingHold` s (the cold open is
     * part of it), then the chopper pivots round behind him into Chase High in one move (the swoop). It counts as a cut-away, so
     * the next one waits the usual `cutMinInterval`. Off when camera cuts are off. Like the swoop, the hero shot
     * is exempt from the ≥2s-of-road framing rule: nothing is placed within 45m of the start or spawns before 12s.
     */
    openingAngle: 4,
    openingHold: 6, // Mike 2026-11-24: "longer cinematic view at game start" (was 3.5)
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
    /** The giant never sits lower than this fraction of the screen height (0 top, 1 bottom). Mike (2026-11-24): 0.85 put him under the chyron in landscape. */
    giantMaxScreenY: 0.7,
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
    /** Oncoming cars count as in the way from this far ahead (m): they close at both speeds. */
    oncomingLook: 60,
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
    /** Escort cruiser footprint (half length / half width, m): matches the 4.8 × 1.95 m body drawn. */
    hl: 2.4,
    hw: 0.98,
    /** Bumper gap the chase convoy (escort + pursuing cruisers) keeps nose-to-tail (Mike, 2026-11-19: "cars still drive over one another"). */
    convoyGap: 1.2,
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
    planAhead: 40, // Rampage loop: 40 (was 30): at Stride pace the road 30s out was already generated (480m ahead), so the plan came too late
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
    /** Sign-off outro: he eases onto the ramp's centreline (critically damped, this rate in 1/s), eased in over `rampFollowIn` s. */
    rampFollow: 4,
    rampFollowIn: 0.8,
  },

  /** §12 Ratings / Heat / Pin. */
  show: {
    /** §4/§12: Ratings start at 20 each segment; 0..100. */
    startRatings: 20,
    max: 100,
    /** §12 gains. Sustained Rampage is per second. */
    /** Police crash (a cruiser he led into something Heavy): the best TV of the chase, above lost track. Collateral: police plough through something Medium. */
    /** Rampage 0 (Mike, 2026-11-16, deviation from §12's +1/s): the trickle was invisible and half of all gains; the audience now moves only for what he does. */
    /** Difficulty pass (2026-11-17): Medium 1.5, Heavy 3.5 (were 2 / 5): at 15 m/s smashing alone held the audience at 100. */
    gain: { rival: 4, medium: 1.5, heavy: 3.5, nearMiss: 3, lostTrack: 6, rampage: 0, policeCrash: 8, collateral: 2, scoop: 4, target: 8 },
    /** HUD: viewers shown per Ratings point ("370K WATCHING" at the starting 20). */
    viewersPerPoint: 18_500,
    /** §12 decay: after 3s with no gain; segment 1 rate (2.0/2.75/3.5/4.25/5.0 by segment). */
    decayAfter: 3,
    /** Difficulty pass (2026-11-17, human-ish balance harness): segment clears ~98/94/89/67/53%, a full run ~29%. */
    decayRate: [3.6, 4.7, 5.8, 6.9, 8.0],
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
    /** Rampage loop: Rampage pays double Stride. */
    bankMult: [1, 1, 1.5],
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
      /** Kiting window (Mike, 2026-11-17: "still not able to kite cops into bulldozers"): alongside him it rides beside him this long before winding up a ram (it used to wind up at once). */
      holdAlongside: 3,
      /** A ram never beats Rampage: at Rampage he flattens a ramming cruiser (Mike, 2026-11-17, reversing 2026-11-16). Outside Rampage only a Shoulder Check does. */
      ramBeatsRampage: false,
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
    /** aheadTime 5.5, aheadMin 75 (were 4.5 / 60): with the Rampage swell the chopper pulls out, and the soak caught one spawning in view. */
    spike: { aheadTime: 5.5, aheadMin: 75, tellAhead: 1.9, tellMax: 28, tell: 1.2, speedKeep: 0.7 },
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
    crash: { react: 6, plowKeep: 0.8, visibleBehind: 3, avoidLook: 0.7, avoidHold: 0.8 },
    /**
     * Police Net (Mike, 2026-11-16: "a real box-in", one goal and two threats). From Heat 3, at most
     * `perSegment[heat - 1]` a segment, `minGap` s apart. An armoured truck (nothing smashes it) takes his
     * lane ahead while two flankers (only a Shoulder Check breaks them) come up alongside; the truck then
     * brakes into him. Boxed and slow, the Pin meter fills: the first time it fills in a segment he slips
     * the net (a gear and `slipRatings` lost), the second time he's busted. Ways out: Shoulder Check a
     * flanker (Stride+), brake and drop back behind them, take the gap before they close, Leap, the Stare.
     * The truck cruises like a rolling roadblock until its tell (on screen, like every tell), then brakes.
     */
    /** Difficulty pass: a Net from segment 2 (was 3). */ net: { perSegment: [0, 1, 1, 2, 2] as number[], minGap: 30, cruiseFactor: 0.55, tellAhead: 1.9, tellMin: 25, tellMax: 28, /** The crew breaks off if its truck gets this far ahead before closing (spawns ≤120m ahead; he slowed and it never waits). */ giveUpAhead: 145, tell: 1.5, decel: 7, crawl: 3.5, flankClose: 9, flankAccel: 8, flankDecel: 5, flankHold: 14, flankSide: 3, actMax: 10, escapeAfter: 1.5, slipRatings: 15 },
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
    carrier: { /** Its lane is cleared this far ahead when it spawns (m); after that it clears its lane as it goes, off frame (offFrame). */ clearAhead: 200, /** A leaving carrier clears its lane only this far ahead of him (m: out of the frame). */ offFrame: 70, /** Safety net: seconds it holds station before it leaves, whatever it dropped (its drops take ~5s). */ actMax: 12, firstAt: 30, every: [40, 60] as [number, number], cruiseFactor: 0.62, tellAhead: 1.9, tellMin: 25, tellMax: 28, firstDrop: 0.8, drops: 6, dropEvery: 0.9, dropLead: 1.2, leaveSpeed: 8 },
    /**
     * Caught (Mike, 2026-11-16: "the run doesn't end when police catch up"). Every segment, no Heat gate: while he
     * crawls under `below` m/s (braking; Jog's top is 6), any cruiser within `from` m behind pulls up to `gap` m off
     * his back (police further back close at `runDown` m/s over his speed, not the usual 7), and police within
     * `reach` m of him fill the meter at `fill`/s (≈3.3s). The first fill in a segment
     * he shakes them (they drop back for `backOff` s; a gear, a stumble and `net.slipRatings` lost), the second busts.
     */
    /** `slips`: catches shaken off before one busts him. 0 (Mike, 2026-11-17: "if they catch the giant once it's game over"). */
    /** `escortGap`: the escort's lead cruiser runs him down to this centre-to-centre gap (m) while he crawls (2026-11-17). */
    caught: { below: 4, from: 20, gap: 2.5, reach: 3.5, fill: 30, backOff: 2.5, runDown: 14, slips: 0, escortGap: 4.2 },
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
    /** Abilities stack (Mike, 2026-11-17): hold up to this many, each on its own button. */
    abilitySlots: 2,
  },

  /**
   * Upgrade pool v2 (Mike, 2026-11-17: "a winning set"; art from his sheet, each card's image reused). Abilities
   * share the one slot; offered again, the one you hold levels up (I → III, `levels`) at `levelPrice` × its price;
   * a different one replaces it. Passives stack. Prices are paid from banked spectacle points (spending never lowers
   * the score). Breakaway and Slipstream start locked (Awards unlock them, src/awards.ts).
   */
  /** Prices (Mike's playtest, 2026-11-17: "couldn't buy an upgrade after round 1"; his segments banked ~110k median): 70–125k, so an average segment buys one and a good one two or three (the meeting stays open). */
  upgrades: {
    leap: { kind: 'ability', price: 110000, label: 'Leap', blurb: 'Hop lanes of trouble. The landing flattens what you land on.', pitch: 'Get a clean shot of him clearing the spike strip.', levels: ['', 'Longer jump, bigger landing.', 'The landing flattens anything, armored trucks too.'] },
    stare: { kind: 'ability', price: 95000, label: 'The Stare', blurb: 'Traffic and police ahead pull out of your lane.', pitch: 'Stay tight on the eyes. We have time.', levels: ['', 'Reaches half again as far.', 'Police that pull over crash out.'] },
    breakaway: { kind: 'ability', price: 125000, label: 'Breakaway', blurb: 'Dive over everything ahead. The police behind lose you.', pitch: 'Get the long lens on him. He’s about to leave them all behind.', levels: ['', 'Longer dive, bigger slam.', 'Lands straight into Rampage.'] },
    primeTime: { kind: 'ability', price: 105000, label: 'Prime Time', blurb: 'For a few seconds the audience can’t drop and every smash counts double.', pitch: 'Every station is taking our feed. Make it count.', levels: ['', 'Lasts 8 seconds.', 'Lasts 10 seconds.'] },
    thickSkin: { kind: 'passive', price: 80000, label: 'Thick Skin', blurb: 'Shrug off the first hit each segment: no meter lost.', pitch: 'He walked through that like a turnstile.' },
    secondWind: { kind: 'passive', price: 70000, label: 'Second Wind', blurb: 'Each Rampage ends with the meter a third full.', pitch: 'He’s catching his breath. Stay on him, he’s coming back.' },
    crowdPleaser: { kind: 'passive', price: 85000, label: 'Crowd Pleaser', blurb: 'At Rampage the audience drains 40% slower.', pitch: 'Keep rolling. Nobody can look away.' },
    slipstream: { kind: 'passive', price: 90000, label: 'Slipstream', blurb: 'Police crashes pay double: Ratings and points.', pitch: 'Anyone chasing him ends up in the scenery. Keep it wide.' },
    // Rampage upgrades (Mike, 2026-11-17: "upgrades built around Rampage"). Card art: Mike's (2026-11-17), in the cards' flat low-poly style.
    shoulder: { kind: 'ability', price: 85000, label: 'Shoulder Check', blurb: 'A short charge that breaks concrete and police lines without Rampage.', pitch: 'He’s dropping the shoulder. Stay wide, this one goes through the barrier.', levels: ['', 'Charges for longer.', 'Every smash in the charge fills the Rampage meter.'] },
    overdrive: { kind: 'passive', price: 85000, label: 'Overdrive', blurb: 'Rampage lasts 3 seconds longer.', pitch: 'Don’t cut away. He’s not done yet.' },
    shortFuse: { kind: 'passive', price: 75000, label: 'Short Fuse', blurb: 'The Rampage meter fills 25% faster.', pitch: 'He’s wound tight tonight. It won’t take much.' },
    groundZero: { kind: 'passive', price: 100000, label: 'Ground Zero', blurb: 'Going Rampage flattens everything within 12m.', pitch: 'Get the wide shot ready for when he goes off.' },
  } as Record<UpgradeId, { kind: 'ability' | 'passive'; price: number; label: string; blurb: string; /** The producer's line on the meeting card (flavour). */ pitch: string; /** Abilities: what levels II and III add ([0] unused). */ levels?: string[] }>,
  /** Ability level-up price, as a share of the ability's price; highest level. */
  levelPrice: 0.8,
  maxLevel: 3,

  /**
   * Leaderboard (§29: shared, server-side). Scores are re-simulated from the inputs on the server.
   */
  leaderboard: {
    /** Board season: bumped when the rules change what a score means (2: the Rampage loop, 2026-11-17; 3: the pivot loop is the game, 2026-11-24). Old boards stay in the store, unread. */
    season: 3,
    /** Inputs per segment a submission may carry (60 Hz): Endless runs to ~1200s at worst (feel baseline cap), Story ~345s + outro. */
    maxTicks: 80000,
    /** Daily Endless boards are kept this long (s) after their last post: a week of looking back, then gone. */
    dailyKeep: 8 * 86400,
    /** Longest name on the board (fits the recap row at phone width). */
    nameMax: 14,
    /** Rows shown on the recap board. */
    top: 10,
    /** Claimed vs re-simulated score: allowed gap (fraction). Rounding only; anything more is rejected and counted. */
    tolerance: 0.005,
    /** Submissions per IP per minute (the server's own guard; a run takes minutes). */
    perMinute: 12,
    /** Submissions per minute across everyone (each one re-plays up to five segments on the server). */
    perMinuteAll: 120,
    /** A road the server hands out stays rankable for this player this long (s): Run Again on it counts, a road picked by hand doesn't. */
    ticketTtl: 6 * 3600,
    /** Roads handed out per player per minute. */
    ticketsPerMinute: 10,
    /** Submissions per player id per minute (a broadcast takes minutes; this only stops scripted bursts). */
    perPlayerMinute: 4,
    /** Names that pass as staff are refused (no impersonating the station or the developer). Matched like `blocked`. */
    /** Innocent words that contain a blocked one (the Scunthorpe problem): taken out before matching. */
    allowed: ['grape', 'drape', 'scrape', 'trapeze', 'peacock', 'hancock', 'cockpit', 'shuttlecock', 'woodcock', 'scunthorpe', 'shitake', 'fagan'],
    reserved: ['admin', 'moderator', 'official', 'wyfnews', 'wyf6', 'staff', 'developer', 'support', 'anthropic', 'claude'],
    /** Never on the board (rule 10: never mean). Matched inside the name's letters. */
    blocked: ['fuck', 'shit', 'cunt', 'nigg', 'fag', 'rape', 'nazi', 'hitler', 'retard', 'whore', 'slut', 'bitch', 'cock', 'pussy', 'kike', 'chink', 'spic', 'tranny', 'dyke', 'wetback', 'beaner', 'gook', 'raghead', 'towelhead', 'kkk', 'jizz', 'penis', 'vagina', 'porn', 'molest', 'pedo', 'twat', 'wank'],
  },

  /**
   * Onboarding prompts (Mike, 2026-11-17). Each once per browser, one at a time, `gap` s apart, held `hold` s.
   * quietStart: nothing in the first seconds (the cold open). blockedLead: an unsmashable thing within this many
   * seconds of him. audienceBelow: audience bar under this. kiteAhead: m of
   * road ahead of a police car alongside him.
   */
  /** lanesAfter: the first lesson waits for the opening's head-on shot and swing home (mirrored steering) to end. */
  onboarding: { lanesAfter: 7.8, quietStart: 4, blockedLead: 2.2, audienceBelow: 12, kiteAhead: 30, gap: 7, hold: 4.5, /** The RAMPAGE READY prompt holds until he fires, up to this many s. */ readyHold: 15 },

  /**
   * Outfits (Awards, Mike 2026-11-17: "recolors for now"): the Meshy texture's plum cloth takes `hue` (deg) with
   * saturation × `sat` and lightness × `light`; the bone plates blend `plateMix` toward `plate` (null = as painted).
   * Every one stays dark against the road (§23: the giant is the darkest thing on screen).
   */
  outfits: {
    // Colourblind-readable (Mike, 2026-11-19: "his costumes all look similar"): each one differs in lightness, not only
    // hue. Classic mid plum; Midnight near-black with silver plates; Parade nearly all white; Gold head to toe.
    classic: { label: 'Classic', hue: 285, sat: 1, light: 1, plate: null, plateMix: 0, cape: null, band: null },
    midnight: { label: 'Midnight', hue: 218, sat: 0.9, light: 1, cloth: 0x15192a, plate: 0xdfe4ec, plateMix: 0.85, cape: 0x080a12, band: 0xdfe4ec },
    parade: { label: 'Parade White', hue: 0, sat: 0, light: 1, cloth: 0xf4f1ea, plate: 0x2a2a30, plateMix: 0.6, cape: 0xfaf8f2, band: 0xc8102e },
    gold: { label: 'Solid Gold', hue: 45, sat: 1, light: 1, full: 0xf2c440, plate: null, plateMix: 0, cape: 0xd9a520, band: 0xfff0b0 },
  } as Record<OutfitId, { label: string; hue: number; sat: number; light: number; /** Cloth colour (replaces the hue shift). */ cloth?: number; /** Tint the whole body (a statue). */ full?: number; plate: number | null; plateMix: number; /** Cape cloth and hem band (null = the classic plum and cream). */ cape: number | null; band: number | null }>,

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
    /** Never land inside something unflattenable: the flight stretches up to this much longer (s) to clear it. */
    landExtendMax: 0.8,
    /** Per-level numbers are [I, II, III]. Leap: airborne this long (no collisions), apex height (m), landing shockwave radius (m) smashing up to Heavy (III: anything). Mike's playtest: 3.2m / 0.9s didn't read from the chopper. */
    /** height (presentation): 9m (was 5.5; Mike: "Leap doesn't have an animation", it didn't read from the chopper); loom: he swells this much at the apex (toward the lens). */
    leap: { time: [1.1, 1.3, 1.3], height: 9, loom: 0.28, shockRadius: [6.5, 9, 9], cooldown: 6 },
    /** The Stare: the road parts this far ahead: his lane pulls over, the lanes either side move one further out; police winding up back off (III: they crash out). */
    stare: { reach: [90, 135, 135], lanesEitherSide: 1, time: 0.6, cooldown: 10, glareTime: 0.9 },
    /** Breakaway: a low forward dive, `boost` m/s over his speed, airborne (no collisions); a landing slam smashing up to Heavy; every police car behind him loses track. III lands in Rampage. */
    breakaway: { time: [1.0, 1.3, 1.3], height: 3, boost: 4, shockRadius: [6, 8, 8], cooldown: 14 },
    /** Prime Time: this long, the audience can't drop and smashes count `mult` × (Ratings and points). */
    primeTime: { time: [6, 8, 10], mult: 2, cooldown: 30 },
    /** Shoulder Check as an ability (2026-11-17): a charge of `time` s (by level), +`burst` m/s, breaking concrete and police lines (not bulldozers); III: each smash in it adds `meterPerSmash`. */
    shoulder: { time: [0.5, 0.8, 0.8], burst: 3, cooldown: 4, meterPerSmash: 10 }, // balance 2026-11-17: 8s every 20s was 40% uptime with no drain
    /** How long the "what it did" callout stays beside the ability chip (s). */
    popTime: 1.8,
  },

  /** Passives v2 (2026-11-17). Thick Skin: meter-costing hits shrugged off per segment. Second Wind: unused since the Rampage loop (see rampage.secondWindKeep). Crowd Pleaser: audience drain × this at Rampage. Slipstream: police crash Ratings and points × this. */
  /** Rampage upgrades: Overdrive's extra seconds (and cap), Short Fuse's meter multiplier, Ground Zero's blast radius (m). */
  passives: { thickSkinHits: 1, secondWindTierUp: 0.6, crowdPleaserDecay: 0.6, slipstreamMult: 2, overdriveTime: 3, shortFuseMult: 1.25, groundZeroRadius: 12 },

  /** Phase 0c traffic reactions (presentation): cars ahead brake, swerve and honk as he approaches. */
  traffic: {
    /** Brake lights and hazards come on when the giant is this close behind (m). */
    brakeAt: 45,
    /** Swerve and honk inside this distance (m). */
    swerveAt: 26,
    /** Only cars within this many metres across the road react. */
    lateralReach: 7,
    /** Visual swerve: lateral nudge (m) and yaw (deg) inside the car's own footprint; the hitbox doesn't move. */
    /** A lane-changer steers into its move by this much at mid-move (deg). */
    shiftYawDeg: 9,
    swerveOffset: 0, // off (Mike, 2026-11-24: the half-swerve looked tacky; cars hold their lane)
    swerveYawDeg: 0,
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
    /** Anchor desk window shown at all (Mike, 2026-11-24: off for now; it fought the CAM button, and the chopper shot is the show). */
    anchorDesk: false,
    /** Viewer video (picture-in-picture): length, minimum gap, minimum Ratings tier. */
    /** Viewer video's far plane (m): it frames him from ~10–25m, and drawing the city to 500m tripled the frame's draw calls (release pass, 2026-11-24). */
    pipFar: 80,
    pipTime: 3.2,
    pipGap: 12,
    pipTier: 1,
  },

  /** Phase 0c look: night by default; LIVE TIME follows the local clock. */
  look: {
    /** Art pass (2026-11-24): the ink outline on vehicles (m per side), matching the giant's. */
    inkWidth: 0.06,
    /** Bloom (Settings; review #66): only the brightest things glow (lights, sparks, embers, lit windows at night). */
    /** By look: daylight lifts the road and cars near white, so the day threshold sits above them (Mike, 2026-11-18: "entirely too much"). */
    bloom: { radius: 0.35, night: { strength: 0.55, threshold: 0.82 }, dusk: { strength: 0.35, threshold: 0.9 }, day: { strength: 0.15, threshold: 0.97 } },
    /**
     * Adaptive resolution (phones): every 0.5s window under `lowFps` counts; `downAfter` in a row drops the pixel
     * ratio by `step` (not below `minRatio`); `upAfter` windows over `highFps` raise it again (not past the device's,
     * capped at `maxRatio`). Slow to rise so it doesn't hunt; fast enough to drop that a stutter lasts ~1s.
     */
    resolution: { maxRatio: 2, minRatio: 1, step: 0.25, lowFps: 50, highFps: 57, downAfter: 2, upAfter: 12 },
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
    spotRadius: 8.5, // 7.5 → 8.5 (2026-11-25): more lit road around him at night, so his silhouette holds in the head-on angles
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
    swipeMinPx: 48,
    swipeMaxTime: 0.35,
    /** Swipe down and hold to brake: downward drag past this many px. */
    swipeDownBrakePx: 40,
    /** The controls strip shows for this long at the start of each segment (s). */
    controlsHintTime: 7,
  },
} as const;

export type Tuning = typeof TUNING;

/** Turn the prototype core loop on (before any Sim is built): its rules plus the shorter, simpler run around it. */
export function enableProto() {
  const t = TUNING as unknown as { proto: { on: boolean }; run: { segments: number; abilitySlots: number }; show: { gain: Record<string, number> } };
  t.proto.on = true;
  // The story run: one unbroken run (no Producer's Meeting), the fuel tank as its clock; the exit opens at the end of
  // the last district (Sim.stepExit), not on the clock.
  t.run.segments = 1;
  (TUNING as unknown as { lanes: { max: number } }).lanes.max = Math.max(TUNING.lanes.max, ...TUNING.proto.story.districts.map((d) => d.lanes ?? 0));
  t.run.abilitySlots = 1;
  const seg = (TUNING as unknown as { segment: { length: number; exitOpensAt: number } }).segment;
  seg.length = TUNING.proto.story.fuel;
  seg.exitOpensAt = TUNING.proto.story.fuel - 30; // the HUD's SIGN-OFF IN countdown; the sim opens the exit by distance
  for (const [k, v] of Object.entries(TUNING.proto.gain)) t.show.gain[k] = v;
  const car = (TUNING as unknown as { pursuit: { carrier: { drops: number; every: [number, number] } } }).pursuit.carrier;
  car.drops = TUNING.proto.carrierDrops;
  car.every = TUNING.proto.carrierEvery;
}
