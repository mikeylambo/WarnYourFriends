# CLAUDE.md — Warn Your Friends

This file is the law for anyone (human or agent) building this repo. The design source of truth is [`docs/GDD.md`](docs/GDD.md) (Build Handoff v0.2). Build-time calls go in [`DECISIONS.md`](DECISIONS.md).

## Current phase

**Phase 0 — Thesis proof. STOPPED for Mike's feel check.** Do not start Phase 1 (§40) until Mike signs off that the run feels great in an empty block. If asked to continue, confirm the feel check happened first.

## Rules

1. **Protect the run's feel first, the broadcast joke second** (§44–45). When in doubt, pick the option that keeps the giant moving and readable.
2. **Design Laws (§1) are hard constraints:** the giant never stops unless the player chooses to (speed floor 2 m/s, LOCKED); every destruction is readable from the chopper; the chyron never lies; pursuers never spawn on camera or within 40m (LOCKED); no combat system.
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
src/sim/             pure TS simulation (no three/DOM): sim.ts, layout.ts, bot.ts, rng.ts
src/render/          three.js views: world, giant, camera rig, palette
src/audio.ts         Web Audio, music/sfx/voice buses (synth placeholders)
src/input.ts         KBM, gamepad, touch → SimInput
src/main.ts          boot, fixed-step loop, event presentation, window.__GAME
tools/soak.ts        headless N-seed soak with invariants
tools/e2e-smoke.mjs  headless Chromium smoke against the built game
```

## Commands

```bash
npm install
npm run dev        # play locally
npm run gates      # everything that must pass before a commit
```
