# Warn Your Friends — Concept v0.1

> Transcribed from `Concept_v0.1.pdf` (Mike, 2026-10-31). Superseded by [GDD.md](GDD.md) (Build Handoff v0.2) wherever they differ; kept for intent and history.

## Pitch

A top-down chase game shot from a news helicopter. You are an enormous, unstoppable fugitive with a swaggering power-run, barreling through a city while the live broadcast's chyron writes your legend. You are not escaping. You are chasing ratings.

**Hook line:** *"Giant At Large. Warn Your Friends."*

## Pillars

- **The run is the game.** Running in an empty room must already feel great: weight, lean, stomp, momentum.
- **The headline is the score.** All feedback flows through the broadcast: chyron, anchors, replays, ratings.
- **Boring is death.** You lose by being uneventful, not just by being caught.
- **Original giant.** A fully original character built on the archetype (massive, menacing, absurd in a mundane street). No borrowed IP.

**Platform / tech:** Browser first on the web shell (TypeScript, top-down 2D or 2.5D), mobile-friendly controls. Session length 90–180s.

## Core loop

One run = one broadcast segment. Keep ratings up until the segment ends, then cash out for upgrades.

1. **Run.** Steer a heavy, momentum-driven body through the city.
2. **Make news.** Smash, weave, outrun and cause spectacle to raise Ratings.
3. **Escalate.** Rising Ratings raise Heat: more and tougher pursuers, which create bigger news.
4. **Stay interesting.** Ratings decay when nothing happens. Hit zero and the network cuts to commercial.
5. **Survive or get cornered.** Make the segment's end and you sign off live; get pinned and it's an arrest broadcast.
6. **Producer's meeting.** Between segments, spend Ratings on run modifiers; pick the next district.

**Fail states:** cornered (immobilized by pursuers) or ratings collapse (too boring). Both end the segment.

## Systems

### Momentum tiers

| Tier | Speed | Turning | Smash power |
|---|---|---|---|
| Jog | Low | Tight | Shoves people, nudges carts |
| Stride | Medium | Wide | Breaks stalls, fences, light cars |
| Rampage | High | Very wide, drifty | Plows barricades, flips cruisers |

Tiers build by running uninterrupted; hard impacts or sharp turns drop a tier. Every corner is a risk/reward call.

### Ratings and the chyron

- Actions award Ratings: near-misses, chain smashes, crowd scatters, outrunning a unit, landmark set pieces.
- Variety multiplier: repeating the same act pays less. Novelty is rewarded.
- The chyron escalates through headline tiers as Ratings cross thresholds, e.g. *"Large Man Spotted Near Bakery"* → *"Giant At Large, Warn Your Friends"* → *"City Declares Emergency."*
- Headlines are templated from what you actually did (location + act + scale), so they read as personal.

### Heat (pursuit)

Bystanders → mall cops → cruisers → spike strips and roadblocks → SWAT van → rival police chopper fighting yours for the shot. More pursuers means more Ratings opportunities. Optional fold-in from Fiend Megacyber: power scales with how outnumbered you are.

### Abilities (upgrade pool)

- Shoulder Check: burst that knocks a lane clear.
- Leap: hop barriers and vehicles, big landing shockwave.
- The Stare: crowds part ahead of you.
- Hijack Hop: ride a vehicle briefly, then bail at speed.
- Pose for the Camera: brief stop that converts Heat into a Ratings spike.

### Structure

Roguelite segments across districts (market, financial, suburbs, waterfront, stadium). Meta progression unlocks districts, outfits and broadcast styles.

## Art, audio, broadcast

- **The giant:** original design, readable from a top-down chopper view. Silhouette and run cycle are the brand: exaggerated forward lean, heavy rhythmic stomp, cape or coat that trails.
- **Camera:** slightly wobbly news-chopper framing, zoom pulls out at higher tiers, slight lag behind the player.
- **Broadcast UI:** chyron ticker, station bug, LIVE badge, "BREAKING" stingers, split-screen anchor reaction cam, instant replays of top smashes.
- **Audio:** booming footfalls synced to the run cycle, rotor wash, sirens layered by Heat, a news-theme sting that remixes per headline tier. Original score (Mikey Lambo).
- **Tone:** deadpan local-news comedy. The anchors take it painfully seriously.

## Scope and milestones

Target: a shippable web release in 4–8 weeks, single city, procedural block layout.

1. **M0 – The Run (week 1):** greybox giant, momentum tiers, camera. Gate: running in an empty block is fun on its own.
2. **M1 – The News (weeks 2–3):** Ratings, decay, chyron headline templates, basic Heat.
3. **M2 – The Chase (weeks 3–5):** full pursuer ladder, abilities, segment structure, fail states.
4. **M3 – The Broadcast (weeks 5–8):** replays, anchor cam, audio, 2–3 districts, polish, leaderboard.

## Risks

- **One-joke game.** Mitigation: ratings decay plus variety multiplier forces creative play; headline templates keep the joke fresh.
- **Run feels floaty or sluggish.** Mitigation: M0 gate; do not build anything else until it lands.
- **IP drift.** The giant must stay original in design, name and silhouette; no references to the inspiration in marketing.
- **Readability at speed.** Mitigation: zoom-out by tier, strong pursuer silhouettes, clear danger tells.

## Open questions (as of v0.1)

- Who is the giant, and why are they running? → *Resolved in v0.2: never explained.*
- 2D sprite or 2.5D 3D-to-2D pipeline for the run cycle? → *Resolved in v0.2: 2.5D Three.js.*
- Absorb the Fiend Megacyber outnumbered-power concept? → *v0.2 folds it in as the "Outnumbered ×1.25" Ratings modifier.*
