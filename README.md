# Warn Your Friends

*Giant At Large. Warn Your Friends.*

A top-down chase roguelite: a giant fugitive barrels through a city on live TV, scoring ratings for spectacle. Design: [`docs/GDD.md`](docs/GDD.md). Rules for building: [`CLAUDE.md`](CLAUDE.md). Build-time calls: [`DECISIONS.md`](DECISIONS.md).

## Status: Phase 0, thesis proof

Greybox giant, three momentum tiers, chopper camera, a seeded test block of breakable props and pedestrians. No ratings, no cops. **Waiting on Mike's feel check before Phase 1.**

## Run it

```bash
npm install
npm run dev
```

Open the printed URL. Any key, click or tap starts the run.

| | Keyboard / mouse | Gamepad | Touch |
|---|---|---|---|
| Steer | A/D rotate, or point the mouse | Left stick (absolute) | Drag on left half |
| Brake | Space | LT | Hold left thumb still |
| Shoulder Check | Shift / left click | RB | Red button |
| Pause | Esc | Start | II |

Dev keys: **T** tuning panel · **`** (backtick) debug overlay · **R** new layout.

URL flags: `?seed=N` fixed layout · `?timescale=0.5` · `?bot` autopilot · `?tune` open the tuning panel · `?reducedmotion` · `?reduceflashes` · `?step` (headless step mode via `window.__GAME.step(n)`).

## Feel check (Phase 0 exit)

> Mike plays 5 minutes in an empty block and wants to keep going. (§40)

Things to try:

1. Get to Rampage on a long avenue and listen to the footfalls drop in pitch at each tier.
2. Take a corner at Rampage: carry the drift, or brake (Space) and lose a tier.
3. Plow through a parked car at Rampage, then try the same car at Stride (bounce) and with a Shoulder Check (smash).
4. Run through the central plaza at Stride; stalls and benches break, people dive clear.
5. Open the tuning panel (T), change a number, feel it immediately. **Copy** gives you the changed values to send back.

## Gates

```bash
npm run gates   # typecheck, unit tests, 200-seed headless soak, build, E2E smoke
```

The E2E smoke needs Playwright with Chromium (`npm i -D playwright && npx playwright install chromium` if it isn't installed globally).
