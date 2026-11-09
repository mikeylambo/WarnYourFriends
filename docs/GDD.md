# Warn Your Friends — Build Handoff v0.2

> Transcribed from `Build_Handoff_v0.2.pdf` (Mike, 2026-11-08). The PDF is the original; this file is the working copy the build reads. Section numbers match the PDF.

**Status:** Preproduction · **Platform:** Web (KBM, gamepad, touch) · **Stack:** Web Shell + Three.js · **Universe:** Standalone · **Base repo:** Shell-generated

Numbers are provisional unless marked **LOCKED**.

## 0. Executive Summary

**Pitch:** A top-down chase roguelite where a giant fugitive barrels through a city on live TV, scoring ratings for spectacle, distinguished by a news broadcast that writes headlines about exactly what you just did.

**Tagline:** GIANT AT LARGE. WARN YOUR FRIENDS.

**Player fantasy:** an unstoppable, absurdly confident force of nature the whole city is watching.

**Core experience:** 1) steering heavy momentum through dense streets; 2) choosing spectacle over safety; 3) reading the headline your run earned.

### The Bet

*Does steering a heavy, swaggering giant through a crowded street feel great with nothing else in the game?* Phase 0 exists to answer this and nothing more.

### Competitive Position

| | Closest existing game | How we differ |
|---|---|---|
| Verb | Rampage, Goat Simulator | Committed momentum steering, not free-roam mayhem |
| Payoff | Crazy Taxi, Tony Hawk | Score is ratings; being boring is how you lose |
| Structure | GTA wanted level | The chase is the whole game, in 2–3 min broadcasts |

**Target:** 2–3 min segments, 10–20 min runs · 1 player · top-down 2.5D · chase roguelite · casual-to-midcore · KBM, gamepad, touch.

## 1. Pillars

- **The run is the game.** Running in an empty block must feel great. *Reject:* anything that stops the giant for more than 1s outside a deliberate ability.
- **The headline is the score.** All feedback flows through the broadcast. *Reject:* floating numbers, XP bars, generic popups.
- **Boring is death.** Ratings decay; novelty pays. *Reject:* safe, repeatable farming routes.

### Design Laws

1. The giant never stops unless the player chooses to.
2. Every destruction is readable from the chopper.
3. The chyron never lies: every headline reflects something that actually happened.
4. Pursuers enter from off-camera, announced by sirens. Never on top of you.
5. No combat system. You don't fight, you plow.

## 2. Anti-Pillars

Not a GTA sandbox. No story or cutscenes; the giant is never explained. No inventory or menus mid-run. No grind-gated power. No precision platforming.

## 3. Reference DNA

| Reference | Take | Do not take |
|---|---|---|
| Rampage | Joy of big-body destruction | Standing still and punching |
| Crazy Taxi | Momentum, timer pressure, arcade swagger | Navigation arrows as the core read |
| Local TV news | Chyron, anchors, BREAKING stingers, deadpan tone | Real network branding |
| Katamari | Escalating scale of what you can affect | Rolling controls |

**Calibration:** target the *feel* of a sprinting heavyweight: committed, slightly late on turns, huge on impact. No reference values copied.

## 4. Core Loop

**Moment (5–15s):** read the street → commit to a line → smash or weave → headline ticks up → pick the next spectacle.

**Segment (150s, LOCKED shape):**

1. Cold open: chopper finds you, "LIVE" slams in, Ratings start at 20.
2. 0–130s: run, make news, escalate Heat.
3. 130s: SIGN-OFF zone spawns 150–250m away, marked on the edge of the HUD.
4. Reach it before 150s + 15s grace: segment cleared, bonus scales with Ratings.
5. Ratings hit 0 or Pin meter fills: busted, run ends.

**Run:** 5 segments across districts, Producer's Meeting between each (pick 1 of 3 upgrades, paid from banked Ratings). Segment 5 ends in a finale district.

**Long-term:** unlock districts, abilities in the upgrade pool, giant outfits, broadcast styles. Power never carries between runs.

### Fiction ↔ Mechanics

| Mechanic | Fiction |
|---|---|
| Ratings | Viewers tuning in or flipping channels |
| Ratings at 0 | Network cuts to commercial |
| Pin meter | Police physically boxing you in |
| Segment | A live news block |
| Sign-off zone | The chopper's fuel is low; the shot ends somewhere |
| Producer's Meeting | The newsroom deciding what story to push next |
| Heat | City response escalating to the coverage |

## 5. Player Goals

- **Immediate:** keep momentum, find the next spectacle, avoid the box-in.
- **Segment:** reach the sign-off zone with Ratings alive.
- **Secondary:** headline tier, landmark set pieces, Rampage time.
- **Long-term:** clear all 5 segments, unlocks, leaderboard.

## 6. Rules

- **Win segment:** reach sign-off zone before 165s.
- **Lose run:** Ratings = 0, or Pin meter = 100, or sign-off missed.
- **Score:** total Ratings banked across the run (leaderboard).

**Rule budget:** 3 rules a new player holds: keep moving, keep it interesting, reach the sign-off.

## 7. Player Verbs

| Verb | Input | Function | Commitment |
|---|---|---|---|
| Steer | Stick / A-D / thumb drag | Turn the always-running giant | Low |
| Brake | Hold LT / Space / release-and-hold | Slow to 2 m/s floor, turn rate ×1.6 | Medium (loses tier) |
| Shoulder Check | RB / Shift / right button | 0.25s burst, smashes one mass class up | Medium (3s cooldown) |
| Ability | LB / E / second button | Equipped upgrade ability | Varies |

## 8. Controls

| Action | Gamepad | Keyboard/mouse | Touch |
|---|---|---|---|
| Steer | Left stick (absolute direction) | A/D rotate, or mouse direction | Drag anywhere on left half |
| Brake | LT | Space | Hold left thumb still 0.15s |
| Shoulder Check | RB | Shift / LMB | Right button |
| Ability | LB | E / RMB | Right upper button |
| Pause | Start | Esc | Pause icon |

**Input philosophy:** 5f buffer on Shoulder Check and Ability. 10f menu guard after any screen transition. Pause freezes sim and broadcast audio. Controller disconnect auto-pauses.

## 9. Movement Spec (60 Hz fixed tick, metres)

Giant is 3.6m tall; pedestrians 1.8m. The giant always runs; speed never drops below 2 m/s (Law 1).

| Tier | Top speed | Accel | Turn rate | Tier-up after |
|---|---|---|---|---|
| Jog | 6 m/s | 8 m/s² | 220°/s | 2.0s at top speed |
| Stride | 10 m/s | 6 m/s² | 140°/s | 3.0s at top speed |
| Rampage | 15 m/s | 4 m/s² | 85°/s | — |

**Tier drops:** impact with a mass class you can't smash (−1 tier, 0.3s stumble), turning >110° within 0.5s (−1 tier), braking >0.4s (−1 tier). Brake decel 14 m/s².

**Should feel:** a freight train with swagger; committed, slightly late on turns, enormous on impact. **Must not feel:** floaty, twitchy, or like a car.

**Collisions by mass class:**

| Class | Examples | Jog | Stride | Rampage |
|---|---|---|---|---|
| Light | Pedestrians, carts, mailboxes, bins | Pass through | Pass through | Pass through |
| Medium | Stalls, fences, bikes, benches | Bounce | Smash | Smash |
| Heavy | Cars, barricades, cruisers | Bounce | Bounce | Smash |
| Immovable | Buildings, walls, pillars | Bounce | Bounce | Bounce |

Pedestrians always dive clear or are shoved aside comically; nobody is ever shown hurt.

## 10. Game Feel Bible

- **The Run:** the brand. Heavy forward lean, arms trailing, ground-shaking footfalls on the beat of the cycle; stride length and shake grow per tier.
- **Tier-up:** brief camera pull-out, footfall pitch drops, chyron flickers, coat/cape flares. Must feel like a gear change.
- **Smash:** hitstop + debris spray + chopper camera jolt scaled by mass. Must never stall momentum.
- **Bounce/stumble:** a heavy, embarrassing wobble; anchors wince. Readable in 0.3s, never a full stop.
- **Shoulder Check:** 3f windup lean, burst, shockwave ring; pedestrians fan out.
- **Busted:** slow-mo, pursuers pile in, freeze-frame, chyron "SUSPECT IN CUSTODY" (deadpan, not violent).

### Impact Scale

| Event | Hitstop | Shake | Flash | Audio | Haptic |
|---|---|---|---|---|---|
| Light | 0f | 0px | none | thud | none |
| Medium smash | 3f | 2px | debris only | crunch | 60ms low |
| Heavy smash | 6f | 5px | white 1f | metal crash + bass | 120ms strong |
| Landmark set piece | 10f | 8px | white 2f + replay | stinger | 250ms pattern |

## 11. Pursuit Model

**Core relationship:** speed protects → spectacle costs speed → pursuers punish slowness. You never fight; you route, smash or out-pace.

### Counter Matrix

| Pursuer / hazard | Beaten by | Beats you when |
|---|---|---|
| Mall cops | Any speed | Never alone; they add Pin only in groups |
| Cruiser | Rampage smash, or out-turning it at Jog | You're at Stride on a long straight |
| Spike strip | Leap, or steering around | You're locked into Rampage turns |
| Roadblock | Rampage smash, Shoulder Check at Stride | You arrive at Jog |
| SWAT van + net team | Out-pacing before the net fires | You brake near them |
| Rival police chopper | Breaking line of sight (tunnels, overpasses) | You stay in the open; it marks you for units |

### Tell Table (readable from chopper height)

| Threat | Windup | Visual tell (shape/motion) | Audio | Counterplay |
|---|---|---|---|---|
| Cruiser ram | 0.6s | Car swerves wide, headlights flare | Engine rev | Turn inside it |
| Spike strip | 1.2s | Officer kneels, strip unrolls as a jagged line | Metallic rattle | Leap or route around |
| Roadblock | 2.0s | Cars slide into a wall shape across the street | Tire screech | Smash at Rampage or turn early |
| Net launcher | 0.8s | Officer braces, a widening circle on the ground | Pneumatic charge | Leave the circle |
| Chopper spotlight | 1.5s | Cone sweeps toward you, then locks | Rotor pitch rises | Break line of sight |

**Threat focus:** only threats targeting you show full tells; distant units dim 20%.

## 12. Resources

### Ratings (0–100, live meter)

- **Start:** 20 each segment. **Score:** each second banks Ratings × tier multiplier (Jog 1, Stride 1.5, Rampage 2).
- **Decay:** after 3s with no gain. Rate by segment: 2.0 / 2.75 / 3.5 / 4.25 / 5.0 per second.
- **Variety:** repeating an event type within 10s pays ×0.5, then ×0.25; a type not seen this segment pays ×1.5.

| Event | Gain |
|---|---|
| Medium smash | +2 |
| Heavy smash | +5 |
| Near-miss (pursuer within 1.5m) | +3 |
| Crowd scatter (8+ in 1s) | +4 |
| Pursuer loses track | +6 |
| Landmark set piece | +15 |
| Sustained Rampage | +1/s |
| Outnumbered: 6+ pursuers chasing | ×1.25 all gains |

### Pin (0–100, loss meter)

- **Fills** 25/s when below 4 m/s with 2+ pursuers within 6m; 40/s inside a net.
- **Drains** 30/s above 8 m/s. Full = busted.

### Heat (1–5, escalation level)

Rises when Ratings cross 30 / 50 / 70 / 90, and +1 every 45s regardless. Never falls within a segment. Sets which pursuers the spawner may use (§19).

## 13. The Giant

**Content unit:** one giant. Outfits change palette and cape only; never the silhouette or hitbox.

- **Archetype:** an armored warlord, out of time in a modern city. Never explained.
- **Identity (provisional, Mike to approve):** violet-and-bone palette, horned pauldrons, braided white topknot, tattered floor-length cape, bare forearms with wrapped bands. All identifiers original; none taken from the inspiration.
- **Readability test:** identifiable as a silhouette at 48px tall from the default chopper height; always the darkest, most saturated object on screen.
- **Audio identity:** bass footfalls, cape whip on turns, a low grunt on smashes. Never speaks.

## 14. Pursuer AI

- **Should:** look organized and escalating; box you in through teamwork you can see coming.
- **Should not:** teleport, rubber-band, or spawn on screen.
- **States:** Patrol → Alerted → Chase → Flank → Box-in → Lost.
- **Rules:** 10 Hz decision tick. Pursuers predict 1.0s ahead at Heat 1, 2.0s at Heat 5. Max 2 units in Box-in at once. All attacks use the tell windups in §11.

## 15. Camera

Top-down, 70° pitch, perspective FOV 40. Height: Jog 28m, Stride 34m, Rampage 42m, eased over 0.6s. Lags the giant 0.25s and leads 3m toward heading. Wobble ±0.3° at 0.4 Hz (off with Reduced Motion).

| Event | Response |
|---|---|
| Heavy smash | 5px jolt, 0.1s |
| Landmark set piece | Instant replay, 3s, from a low angle |
| Pin above 60 | Zoom in 4m, red vignette |
| Busted | Slow-mo 0.3×, freeze-frame |

## 16. District (v1: Downtown)

One district, 5 procedural layouts per run from hand-built 60×60m blocks (target 20 block types).

- **Fantasy:** the city's busiest street on its worst day.
- **Gameplay identity:** long avenues for Rampage, tight alleys for escape, plazas for crowd scatters.
- **Landmarks (set pieces, +15):** fountain plaza, glass bank lobby, food-truck row, parking deck, overpass jump.
- **Hazards:** construction cranes, open manholes (stumble), traffic.
- **Size:** 6×6 blocks (360m square). Crossing at Rampage takes ~24s.

## 17. Progression

- **In-run:** Producer's Meeting after each segment: pick 1 of 3 upgrades; abilities replace the equipped slot.
- **Permanent:** cosmetics and broadcast styles only (outfit palettes, chyron themes). No permanent power.

**v1 upgrade pool (8):** Leap (ability), The Stare (ability), Hijack Hop (ability), Pose for the Camera (ability), Iron Shins (Medium objects never bounce you), Second Wind (Pin drains 50% faster), Showman (variety bonus ×2.0), Tailwind (tier-up 30% sooner).

## 18. Modes

- **v1:** Broadcast (the 5-segment run). Daily Segment (one seeded segment, shared leaderboard).
- **Post-launch:** more districts, endless, custom headlines.

## 19. Difficulty and Pacing

Difficulty rises through Heat and decay, never stat inflation.

| Segment time | Heat | Active-pursuer cap | Spawn cadence | Introduced |
|---|---|---|---|---|
| 0–20s | 1 | 3 | none after first 2 | Mall cops |
| 20–60s | 1–2 | 5 | 1 per 8s | Cruisers |
| 60–100s | 2–3 | 7 | 1 per 6s | Spike strips, roadblocks |
| 100–130s | 3–4 | 9 | 1 per 5s | SWAT net team |
| 130–165s | 4–5 | 12 | 1 per 4s | Rival chopper |

**Spawn rules:** pursuers enter from outside the camera frame, at least 40m away, announced by a siren 1.5s before arrival. Later segments start 1 Heat higher.

## 20. UX Flow

Web Shell default flow (title → menu → mode select → play → pause → results). Differences: a 3s "cold open" before each segment; the Producer's Meeting screen between segments; results styled as the evening news recap with the run's best headline. Focus loss auto-pauses.

## 21. HUD

**Hierarchy:** 1) the giant and the street ahead; 2) incoming tells; 3) Ratings; 4) Pin; 5) headline.

**HUD budget:** chyron (bottom), Ratings meter (top left, styled as a viewer count), Pin meter (ring around the giant, only above 0), Heat stars in the station bug (top right), LIVE badge with segment clock, edge arrow to the sign-off zone. Nothing else.

### Headline System

The signature feature. Headlines are generated from what happened, never canned.

- **Grammar:** `[Tier phrase] + [act] + [place]`, e.g. "Giant Flattens Food-Truck Row", "Police Lose Large Man Near Bank".
- **Tiers by Ratings:** 0–29 SPOTTED · 30–59 AT LARGE · 60–89 RAMPAGE · 90–100 CITY IN CHAOS.
- **Cadence:** a new headline at most every 4s; tier changes interrupt immediately with a BREAKING stinger.
- **Anti-repeat:** no verb or place reused within the last 5 headlines.
- **The line:** "Giant At Large. Warn Your Friends." fires the first time a run reaches AT LARGE.

### Glossary

| Term | Meaning |
|---|---|
| Ratings | Live viewership meter; the score source |
| Pin | Box-in meter; full = busted |
| Heat | City response level, 1–5 |
| Segment | One 150s broadcast |
| Sign-off | The exit zone that ends a segment |
| Busted | Run over |

**Callouts:** BREAKING · EXCLUSIVE · REPLAY · SIGN-OFF · BUSTED. Tone: deadpan local news, never mean, never gory.

## 22. Onboarding

Within 60s the player learns steer, tier-up, smash and decay. Segment 1 is the tutorial: prompts fade once done; decay starts at its gentlest rate; first pursuers are mall cops only.

## 23. Visual Direction

**Thesis:** a sun-bleached, slightly toy-like city seen through a news camera, with one dark, saturated giant cutting through it.

- **Environment:** low-poly, light-to-mid values, chunky shapes that break into big readable debris.
- **Value rule:** the city sits light; the giant is always the darkest thing; pursuers are mid-value with high-contrast light bars.
- **Rendering recipe:** flat toon shading, 2-band ramp, soft shadow blobs, bloom on light bars and the LIVE badge only, slight broadcast scanline and chromatic aberration on the HUD layer.
- **Pipeline:** procedural blocks and props first; giant via Meshy or commissioned model with Mixamo-style rig; placeholders swap without touching logic.
- **Anti-targets:** gritty realism, gore, real network branding.

## 24. Animation

Priority: readability, responsiveness, personality, realism. The run cycle gets the budget: three versions (Jog, Stride, Rampage) with increasing lean and stride, plus stumble, Shoulder Check, leap, pose, busted.

## 25. VFX

Debris by material (wood, glass, metal, fruit), dust ring per footfall at Rampage, siren light washes, shockwave rings. **Signature effect:** the BREAKING wipe, a red bar slamming across the screen with a 1-frame freeze (Reduce Flashes: no freeze, softer wipe).

## 26. Audio

- **Music:** an original news-theme score that escalates with Heat (one layer per level); footfalls quantized to its tempo. Mixed with diegetic sound: sirens, rotor wash and crowd carry quieter stretches, and the score drops out for 1s before each BREAKING stinger.
- **Voice:** ElevenLabs deadpan anchors (2 voices), ~60 lines keyed to headline tiers, landmarks, busted and sign-off. Max one line per 6s; subtitles always on.
- **SFX:** distinct timbre per mass class, per pursuer type and per tell.
- **Mix:** music ducks 4 dB under anchor lines and on heavy smashes for 400ms.

## 27. Haptics

Gamepad and mobile per the Impact Scale (§10); light pulse on each footfall at Rampage only.

## 28. Content Matrix (v1)

| Item | Count |
|---|---|
| Giant model + animation set | 1 + 10 clips |
| Pursuer types | 6 |
| Block types | 20 |
| Landmarks | 5 |
| Upgrades | 8 |
| Anchor lines | ~60 |
| Music | 1 theme, 5 layers, 4 stingers |

## 29. Technical Design

**Stack:** TypeScript, Three.js, Web Shell, Vite, Vercel. **Physics:** custom 2D on the XZ plane (circle giant vs AABB props); debris is cosmetic and never affects the sim. **Audio:** Web Audio with separate music, SFX and voice buses. **Persistence:** localStorage for unlocks and settings; shared leaderboard server-side.

### Foundation and Reuse

```
node tools/create-slu-game.mjs --id warn-your-friends --name "Warn Your Friends" --renderer three --frames title,menu,play,pause,results
```

| System | Donor | Keep | Change |
|---|---|---|---|
| Shell flow, settings, input | Web-Game-Shell-v1.02 | All | Add touch steer + brake gesture |
| Shared leaderboard | Palm | Endpoint + anti-spam | Add Daily Segment seed board |
| 3D scene setup | Infinite Dragoon | Renderer, post stack | Top-down camera rig |

**Contributes back:** the headline generator (template grammar + anti-repeat) and the procedural block assembler, built generic for later games.

### Architecture

1. Sim independent of rendering, 60 Hz fixed step.
2. Seeded RNG inside the sim; `Math.random()` for cosmetics only.
3. All numbers in `tuning.ts`; headline words in `headlines.json`.
4. Events drive presentation (smash, tier change, headline, busted).
5. `window.__GAME` dev hook for headless tests.

## 30. Source of Truth

| Data | Owner |
|---|---|
| Speeds, gains, decay, spawns | `tuning.ts` |
| Ratings, Pin, Heat | sim state |
| Headline words and grammar | `headlines.json` |
| Unlocks, settings | persistence layer |

## 31. Tuning

Every number in §9, §10, §12, §15 and §19 lives in `tuning.ts` with its reason as a comment. LOCKED: segment shape (150s + 15s grace), Law 1 speed floor (2 m/s), no-spawn-on-screen distance (40m).

## 32. Debug

URL flags: `?seg=N`, `?heat=N`, `?nodecay`, `?god` (Pin off), `?seed=`, `?timescale=`. Overlay: speed, tier, Ratings gains log, pursuer AI states. Step mode for headless runs.

## 33. Telemetry

| Metric | Target |
|---|---|
| Segment 1 clear rate | 85% |
| Full-run clear rate | 15–25% |
| Busted by Pin vs by Ratings | roughly 60 / 40 |
| Time spent at Rampage | 30–45% |
| Most-farmed event share | under 35% of gains |

**Balance harness:** a bot that steers toward the nearest smashable target, run 200 seeds headless; must hit the clear-rate band.

## 34. Playtest Questions

Did the run feel great before anything else happened? Could players say why they got busted? Did anyone read a headline aloud or laugh? Where did they start farming the same thing?

## 35. Accessibility

Remapping, hold/toggle brake, subtitles on by default with sizing, Reduced Motion (no wobble, no camera jolt), Reduce Flashes, colorblind-safe tells (shape first), text size, decay assist option.

## 36. Performance

60 fps on a 2019 MacBook Pro in Chrome and on a mid-range 2022 phone. Sim step ≤ 2ms. Initial load ≤ 20MB. Max 400 dynamic debris objects, pooled.

## 37. Save

Saves unlocks, cosmetics, settings, best scores. No mid-run save in v1; quitting forfeits the run. Corrupt save resets to defaults with a notice.

## 38. Networking

None beyond the leaderboard.

## 39. Scope

- **Must ship:** the run, 5-segment Broadcast mode, Downtown district, 6 pursuer types, 8 upgrades, headline system, voiced anchors, leaderboard.
- **Should ship:** Daily Segment, instant replays, 3 outfits.
- **Nice to have:** chyron themes, photo mode.
- **Out of scope:** more districts, multiplayer, story, mid-run saves, permanent power.

## 40. Build Order

1. **Phase 0, Thesis proof:** greybox giant, three tiers, camera, one block of breakable props. No ratings, no cops. *Exit:* Mike plays 5 minutes in an empty block and wants to keep going.
2. **Phase 1, Foundation:** Shell-generated repo, tuning file, procedural block assembler, input on all three devices. *Exit:* a 6×6 Downtown layout generates from a seed.
3. **Phase 2, Core playable:** Ratings, decay, Pin, Heat, pursuers through cruisers, sign-off zone, busted. *Exit:* one full segment plays start to finish.
4. **Phase 3, Depth:** full pursuer ladder with tells, 5-segment run, Producer's Meeting, 8 upgrades.
5. **Phase 4, Content:** 20 block types, 5 landmarks, headline word bank.
6. **Phase 5, Presentation:** final giant, anchors, score, VFX, replays.
7. **Phase 6, Polish and release candidate:** balance harness bands met, performance targets, accessibility.

## 41. Verification

- **Gate command:** `npm run gates` (typecheck, unit tests, headless 200-seed soak, E2E smoke) before every commit.
- **E2E smoke:** title → Broadcast → segment 1 auto-played by bot → Producer's Meeting → results → play again.
- **Invariants:** speed never below 2 m/s; no pursuer spawns within 40m or on camera; every headline maps to a logged event; segments always terminate.
- **Acceptance:** done means proven in a running build with evidence; a deploy is done only after the live URL is played.

## 42. Definition of Done

Template §42 checklist applies in full, plus: name cleared (trademark and store search for "Warn Your Friends").

## 43. Definition of Great (Mike to sign off)

1. In an empty block with nothing to do, playtesters keep running for over a minute.
2. A new player reads a headline aloud or laughs within their first segment.
3. Players can always say why they got busted.
4. A heavy smash at Rampage gets a visibly bigger reaction than any other moment.
5. **Five-second clip test:** a silent clip of the giant running under the chyron identifies this game and no other.

## 44–45. Decision Rules and Builder Instructions

Template §44 and §45 apply unchanged. Game-specific rule: when in doubt, protect the run's feel first and the broadcast joke second.

## 46. Open Questions

| Question | Importance | Working default | Blocks build? |
|---|---|---|---|
| Giant identity details | High | Spec in §13 | No (Phase 5) |
| Title cleared? | High | Keep "Warn Your Friends" until a search says otherwise | No |
| Station name and anchor names | Medium | WYF Channel 6, two invented anchors | No |
| Touch brake gesture feel | Medium | Hold thumb still 0.15s | No |
| Model source for the giant | Medium | Meshy, Mixamo-style rig | No |

## 47. Decisions Log

| Date | Decision | Reason |
|---|---|---|
| 2026-11-08 | Giant never explained | Cheapest, funniest |
| 2026-11-08 | 2.5D Three.js, top-down | Real smash physics and chopper zoom |
| 2026-11-08 | Roguelite segments | Replay loop without content bloat |
| 2026-11-08 | Web, KBM + gamepad + touch | Web Shell reach |
| 2026-11-08 | Pin meter, no HP | Keeps the threat about movement |
| 2026-11-08 | Sign-off zone ends segments | Gives every segment a climax |
| 2026-11-08 | Decay scales by segment | Teach, then enforce |
| 2026-11-08 | Always running + brake | Pure momentum; works on touch |
| 2026-11-08 | Shoulder Check + 1 ability slot | Two buttons on touch |
| 2026-11-08 | Warlord archetype, original identifiers | Keeps the vibe without the IP |
| 2026-11-08 | v1 = one district | Expand only if the game is fun |
| 2026-11-08 | Voiced anchors; news-theme score mixed with diegetic sound | Comedy multiplier; Mike's music |

Build-time decisions are logged in [`/DECISIONS.md`](../DECISIONS.md).

## 48–49. References and Checklist

Reference images go in `docs/refs/` with a note per image. Before handoff, run the template §49 checklist; outstanding items: Definition of Great sign-off, giant identity approval, title search.

## 50. Final Directive

Build a game where steering an unstoppable giant through a panicking city feels great on its own, and the live broadcast turns every run into a story worth reading aloud.

---

### Builder prompt (from the handoff)

> Build Warn Your Friends from docs/GDD.md in this repo. CLAUDE.md is the law. Set up the foundation exactly as §29 specifies, then work through §40 phase by phase without stopping, keeping the game playable. Run npm run gates before every commit. Prove each phase's exit condition in a running build. Use the working default for any open question in §46 and log it in DECISIONS.md. Stop after Phase 0 for Mike's feel check before Phase 1.
