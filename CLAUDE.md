# CLAUDE.md — Warn Your Friends

This file is the law for anyone (human or agent) building this repo. The design source of truth is [`docs/GDD-v0.3-lane-runner.md`](docs/GDD-v0.3-lane-runner.md) (v0.3 Lane Runner), which supersedes the listed sections of [`docs/GDD.md`](docs/GDD.md) (Build Handoff v0.2); everything else in v0.2 stands. Build-time calls go in [`DECISIONS.md`](DECISIONS.md).

## Current phase

**Phase 2 — Core playable** (one full broadcast: pursuit, Ratings/Heat/Pin, exit-ramp sign-off, busted, recap), plus broadcast escalation and road variety. The 0c feel check passed (Mike, 2026-11-12). Phase 1 Foundation: the game now runs inside the SLU Web Shell (private repo, pinned by commit; see DECISIONS 2026-11-13). The shell's AGENTS.md constitution applies. Never vendor the shell into this public repo.

## Rules

1. **Protect the run's feel first, the broadcast joke second** (§44–45). When in doubt, pick the option that keeps the giant moving and readable.
2. **Design Laws (§1) are hard constraints:** the giant never stops unless the player chooses to (speed floor 2 m/s, LOCKED); every destruction is readable from the chopper; the chyron never lies; pursuers never spawn on camera or within 40m (LOCKED); no combat system. **Screen-up law (LOCKED, v0.3):** travel points up the screen within ±35° in every camera angle. **Distinctness from Sticker Runners (LOCKED, v0.3):** weight, destruction, spectacle; lanes are smashed across.
3. **All gameplay numbers live in `src/tuning.ts`** with a one-line reason. No magic numbers in sim or presentation code for anything the GDD specifies. LOCKED values (§31) change only with a GDD revision.
4. **Sim is independent of rendering** (§29): `src/sim/**` must not import `three`, the DOM or `window`. 60 Hz fixed step. Seeded `Rng` inside the sim; `Math.random()` only for cosmetics.
5. **Events drive presentation.** The sim emits `SimEvent`s; renderer, audio, camera and haptics react. Presentation never writes sim state.
6. **Placeholders swap without touching logic.** Greybox meshes and synth audio live behind `GiantView`, `WorldView` and `Audio`.
7. **`npm run gates` must pass before every commit** (typecheck, unit tests, 200-seed headless soak, build, E2E smoke).
8. **Prove exit conditions in a running build** (§41): screenshots, soak output or E2E evidence, not just passing unit tests.
9. **Open questions** (§46): use the working default and log it in `DECISIONS.md`. Same for any deviation from the GDD.
10. **No borrowed IP.** The giant, station, anchors and all identifiers are original. No real network branding. Tone: deadpan, never mean, never gory; nobody is ever shown hurt.

## Layout

```
src/tuning.ts        every number, with reasons
src/sim/             pure TS simulation (no three/DOM): sim.ts, track.ts (road zones + props), pursuit.ts (police units), show.ts (Ratings/Heat/Pin), escort.ts, bot.ts, rng.ts
src/anim/gait.ts     run cycle: pinned feet, two-bone IK, phase locked to distance (pure math, tested)
src/render/          three.js views: highway (zones, ramp), units (police), giant, cruisers, pip (viewer video), camera rig + director, lighting (night/dusk/day), glow, silhouette test, palette, toon
src/broadcast/       headline generator (§21) + headlines.json word bank (pure TS, tested); coverage.ts (escalation ladder), viewers.json
src/audio.ts         Web Audio, music/sfx/voice buses (synth placeholders)
src/input.ts         KBM, gamepad, touch → SimInput
src/main.ts          bootstrap: WebGL check, then loads game.ts; boot errors shown on screen
src/game.ts          fixed-step loop, event presentation, window.__GAME
tools/soak.ts        headless N-seed soak: sim + gait + camera invariants (cadence, foot slide, screen-up, cuts, framing)
tools/e2e-smoke.mjs  headless Chromium smoke against the production build (E2E_URL= for a deployed URL)
tools/shots.mjs      evidence screenshots + silhouette numbers per angle and look
tools/shots-phase2.mjs  Phase 2 evidence: tells, zones, exit, recap
```

## Commands

```bash
npm install
npm run dev        # play locally
npm run gates      # everything that must pass before a commit
```
