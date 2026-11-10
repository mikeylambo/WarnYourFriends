# Warn Your Friends — v0.3 Lane Runner

> Transcribed from `v0.3_Lane_Runner.pdf` (Mike, 2026-11-10). It supersedes the listed sections of [GDD.md](GDD.md) (Build Handoff v0.2); those sections carry a pointer here. **Build notes** at the end record how Phase 0b resolved the places where the numbers conflict; every call is also in [DECISIONS.md](../DECISIONS.md).

**Status:** Pivot, supersedes the listed sections of Build Handoff v0.2. Every section not listed here stands unchanged. Numbers provisional unless LOCKED.

**Why:** real chase footage is a highway seen from a chopper. A lane runner matches it, removes free-steering camera problems and building occlusion, and cuts scope. (Reference stills: [`refs/README.md`](refs/README.md).)

## Distinctness from Sticker Runners (LOCKED)

Sticker Runners is speed, grace and a rival. Warn Your Friends is weight, destruction and spectacle: lanes are something you smash across, pursuers fight you for lanes, and the score is the broadcast. If a playtester can't tell the two apart in one sentence, stop and merge them.

## §0 Pitch (replaces)

A lane-based chase runner where a giant fugitive plows down highways and city streets on live TV, scoring ratings for spectacle while the broadcast writes headlines about exactly what he did.

**The Bet:** *Does a heavy giant smashing across lanes, framed like real chopper footage, feel great with nothing else in the game?*

## §7–9 Verbs, Controls, Movement (replaces)

The giant runs forward automatically. The player picks lanes.

| Verb | Gamepad | KBM | Touch |
|---|---|---|---|
| Lane left/right | Stick flick / d-pad | A/D or ←/→ | Swipe left/right |
| Brake | LT | S / Space | Swipe down and hold |
| Shoulder Check | RB | Shift / W | Tap right button |
| Ability | LB | E | Tap upper button |

- **Roads:** 2–4 lanes, 4m wide. Highway 4, avenue 3, bridge/tunnel 2. Lane counts change at telegraphed merges.
- **Speeds (unchanged):** Jog 6, Stride 10, Rampage 15 m/s; floor 2 m/s (LOCKED). Tier-up after 2s / 3s at top speed.
- **Lane change time:** Jog 0.22s, Stride 0.30s, Rampage 0.40s. Heavier tiers commit longer. One queued input max (5f buffer).
- **Smash-across:** a lane change at Stride or above smashes any Medium object in the swept path; at Rampage, Heavy too. This is the core spectacle verb.
- **Tier drops:** hitting something you can't smash (−1 tier, 0.3s stumble, knocked back to your previous lane); braking >0.4s (−1 tier). The sharp-turn rule is removed.
- **Road edges:** walls and barriers bounce you back into the lane, no stumble.

## §10 The Run Cycle (replaces the Run entry)

The run is the brand. Few, huge steps; never a jogger.

| Tier | Stride length | Cadence | Feel |
|---|---|---|---|
| Jog | 2.5 m | 2.0 steps/s | Heavy, deliberate |
| Stride | 4.0 m | 2.1 steps/s | Driving, leaning |
| Rampage | 6.0 m | 2.3 steps/s | Lunging, near-airborne |

- Speed comes from stride length, not leg speed. Cadence stays nearly flat.
- Each footfall: body drops, 1–2 frame hold on contact, dust ring, 2px camera pulse, bass thump. Rampage adds a ground crack decal.
- Between plants the body hangs, as if every step is a lunge.
- Posture: low and forward-driving, arms trailing behind, head steady.
- Cape shortened to knee length so it never hides the run.

## §11 Pursuit (amends)

Pursuers fight for lanes. **Box-in:** Pin fills when both adjacent lanes are blocked and a unit is within 8m ahead while you're below 4 m/s.

| Threat | Lane behavior | Tell | Counter |
|---|---|---|---|
| Cruiser | Pulls alongside, then swerves into your lane | Blinker + 0.6s drift | Change away, or Rampage through |
| Rolling roadblock | 2–3 cruisers abreast ahead, slowing | Brake lights, 1.5s | Shoulder Check the weakest car |
| Spike strip | Covers one lane | Officer kneels, 1.2s | Change lanes or Leap |
| Static roadblock | Covers all lanes but one | Cars slide in, 2.0s; gap glows | Hit the gap, or smash at Rampage |
| Chopper spotlight | Marks your lane for units | Cone sweeps, 1.5s | Change lanes twice to shake it |

## §15 Camera: Broadcast Angles (replaces)

Oblique news-chopper framing, cutting between angles like a live broadcast.

- **Screen-up law (LOCKED):** in every angle, the direction of travel points up the screen within ±35°. Lanes never flip left/right relative to input.
- **Angles:** Chase High (behind, 48° pitch, 40m), Wide Side (35° off-axis, 52° pitch, 55m), Long Lens (behind-side, FOV 22, 70m).
- **Cuts:** only when no lane change is in progress and no tell is active; at most one cut per 7s; hard cut with a 1-frame flash and a subtle angle-change graphic.
- **Framing:** giant in the lower third, never below 85% down the screen; at least 2s of road visible ahead at every tier.

## §16 World (replaces)

Procedural road built from 40m segments on gentle splines (max curvature 8° per segment). Segment types: highway straight, highway curve, merge (lane count change), overpass, tunnel, surface avenue with storefronts, bridge, exit ramp. v1 target 12 segment types. Landmark set pieces become segments (toll plaza, bridge collapse-proof jump, food-truck avenue).

## §4 Loop (amends)

The sign-off zone becomes an **exit ramp** that opens at 130s; take it before 165s to clear the segment.

## §40 Build Order (replaces Phase 0)

**Phase 0b, Lane-runner thesis proof:** greybox procedural highway (straights, curves, one merge), lane changes with smash-across, the run cycle above, Chase High camera plus one cut angle, Medium and Heavy props in lanes. No ratings, no cops. *Exit:* Mike plays 5 minutes and wants to keep going.

## §47 Decisions

| Date | Decision | Reason |
|---|---|---|
| 2026-11-09 | Pivot to 2–4 lane runner | Matches real chase footage; cuts camera and scope problems |
| 2026-11-09 | Broadcast angle cuts with screen-up law | Fiction fit; protects lane input |
| 2026-11-09 | Heavy run: long strides, flat cadence | Previous cycle read as a jogger |
| 2026-11-09 | Cape to knee length | Run cycle must stay visible |
| 2026-11-09 | Chrome start failure = WebGL disabled on Mike's machine | Confirmed via the new error card |

---

## Build notes (Phase 0b)

How the build resolved the spec where it conflicts with itself. Details and dates in [DECISIONS.md](../DECISIONS.md).

1. **Stride × cadence vs speeds.** The §10 table's stride × cadence is 5.0 / 8.4 / 13.8 m/s, but §7–9 keeps speeds at 6 / 10 / 15. With the feet locked to distance, cadence = speed ÷ stride, so only two of the three can hold. The build keeps the **speeds** and the **cadence band** (it's tested) and **derives stride length**: 3.0 / 4.8 / 6.5 m at top speed. Cadence rises with speed (2.0 at Jog top, 2.1 at Stride top, 2.3 at Rampage top) and never leaves 2.0–2.3.
2. **Wide Side vs the screen-up law.** At 52° pitch, a camera yawed 35° off the travel direction shows travel ~42° off screen-up, breaking the LOCKED ±35° law. Every angle's yaw is clamped so the on-screen angle stays inside the law (Wide Side lands at ~27° of yaw), and the measured angle is enforced every frame.
3. **"Direction of travel"** for the law is the road's direction at the giant, not the momentary sideways velocity of a lane change (at Jog that's ~18 m/s sideways against 6 m/s forward).
4. **Phase 0b scope:** §40 asks for Chase High plus one cut angle; the build request asked for all three. All three are built.
5. **No tells exist in Phase 0b**, so "no tell is active" is trivially true; the director already has the hook.
6. **Highway starts at 4 lanes** (§7–9 "Highway 4"); the merge takes it to 3 (or back up), within 2–4. Merges are telegraphed with signs and painted arrows ahead.
