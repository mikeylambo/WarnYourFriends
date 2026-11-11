# Warn Your Friends

*Giant At Large. Warn Your Friends.*

A top-down chase roguelite: a giant fugitive barrels through a city on live TV, scoring ratings for spectacle. Design: [`docs/GDD.md`](docs/GDD.md). Rules for building: [`CLAUDE.md`](CLAUDE.md). Build-time calls: [`DECISIONS.md`](DECISIONS.md).

## Status: Phase 0c, fantasy slice

Everything from 0b (the v0.3 lane runner: procedural highway, lane changes with smash-across, the heavy run cycle, broadcast angles), plus the fantasy around it:

- **Night by default**: sodium streetlights pooling on the road, head/tail lights on traffic, the chopper's spotlight on the giant, red/blue siren washes. The giant gets a rim light and an ink outline so he reads as a silhouette against the lit road. **LIVE TIME** (pause menu) follows your local clock (day / dusk / night).
- **Event-driven cuts**: Chase High is home. It cuts away only on reaching Rampage, a Heavy smash or a merge, returns after 6–10 s, ≥15 s between cut-aways, never mid-lane-change. **Camera cuts: On/Off** in the pause menu.
- **The world reacts**: a LIVE badge, station bug and a chyron that writes headlines from what actually happened (§21 grammar). Cars ahead brake, swerve and honk; Rampage footfalls bounce them on their suspension. Three cruisers trail with lights and sirens and never catch up. Rotor, sirens and a low news-theme bed.

No ratings, no pursuit AI. **Waiting on Mike's feel check.** Live: https://warn-your-friends.vercel.app

## Run it

```bash
npm install
npm run dev
```

| | Keyboard | Gamepad | Touch |
|---|---|---|---|
| Lane left / right | A / D, ← / → | Stick flick or d-pad | Swipe left / right |
| Brake | S / Space | LT | Swipe down and hold |
| Shoulder Check | Shift / W / click | RB | Red button |
| Pause | Esc | Start | II |

Dev keys: **T** tuning panel · **`** debug overlay · **C** next camera angle · **R** new road.

URL flags: `?seed=N` · `?angle=0|1|2` (hold Chase High / Wide Side / Long Lens) · `?time=night|dusk|day` · `?cuts=0` · `?timescale=0.5` · `?bot` autopilot · `?tune` · `?reducedmotion` · `?reduceflashes` · `?step` (headless, `window.__GAME.step(n)`).

## Feel check (Phase 0c exit)

> Mike plays 5 minutes and wants to keep going.

1. Watch the giant at night: is he the first thing your eye finds in every shot?
2. Hit Rampage, smash a car, ride a merge: each should cut away once, then come home to Chase High.
3. Read the chyron: every headline should be something you just did.
4. Look for the cruisers' red/blue on the road behind you, the cars braking and swerving ahead, the chopper shadow.
5. Pause: try Camera cuts Off and LIVE TIME On.
6. **T** opens the tuning panel; **Copy** exports changed numbers.

## Gates

```bash
npm run gates   # typecheck, unit tests, 200-seed headless soak, build, E2E smoke
```

The E2E smoke needs Playwright with Chromium (`npm i -D playwright && npx playwright install chromium` if it isn't installed globally).
