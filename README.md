# Warn Your Friends

*Giant At Large. Warn Your Friends.*

A top-down chase roguelite: a giant fugitive barrels through a city on live TV, scoring ratings for spectacle. Design: [`docs/GDD.md`](docs/GDD.md). Rules for building: [`CLAUDE.md`](CLAUDE.md). Build-time calls: [`DECISIONS.md`](DECISIONS.md).

## Status: Phase 0b, lane-runner thesis proof

The v0.3 pivot ([`docs/GDD-v0.3-lane-runner.md`](docs/GDD-v0.3-lane-runner.md)): the giant auto-runs down a procedural highway (straights, curves, merges, 2–4 lanes), you pick lanes and smash across them. Run cycle with long strides, flat cadence and planted feet; broadcast camera cutting between Chase High, Wide Side and Long Lens. No ratings, no cops. **Waiting on Mike's feel check.** Live: https://warn-your-friends.vercel.app

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

URL flags: `?seed=N` · `?angle=0|1|2` (start on Chase High / Wide Side / Long Lens) · `?timescale=0.5` · `?bot` autopilot · `?tune` · `?reducedmotion` · `?reduceflashes` · `?step` (headless, `window.__GAME.step(n)`).

## Feel check (Phase 0b exit)

> Mike plays 5 minutes and wants to keep going. (v0.3 §40)

1. Watch the feet at each tier: few, huge steps, planted, a hang between them at Rampage.
2. At Stride, change lanes into a sawhorse or cart: it's smashed across. At Rampage, do it into a car.
3. At Jog, change lanes into a car: −1 tier, stumble, knocked back to your lane.
4. Ride a merge: the closing lane pushes you over.
5. Wait for the cuts (every 7–12 s, never mid-lane-change); press **C** to flip angles yourself.
6. **T** opens the tuning panel; **Copy** exports changed numbers.

## Gates

```bash
npm run gates   # typecheck, unit tests, 200-seed headless soak, build, E2E smoke
```

The E2E smoke needs Playwright with Chromium (`npm i -D playwright && npx playwright install chromium` if it isn't installed globally).
