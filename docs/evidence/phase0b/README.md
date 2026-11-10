# Phase 0b evidence: lane runner (2026-11-10)

Production build in headless Chromium (software GL, so the fps in the overlay isn't representative), seed 5, bot driving in real time, `?debug=1&reducedmotion=1`. Each shot's overlay shows the game's own measurements; `shots.json` has the numbers.

| Shot | Tier | Speed | Step | Cadence | Angle | Travel vs screen-up | Giant screen Y | Road ahead |
|---|---|---|---|---|---|---|---|---|
| `tier-1-jog.png` | Jog | 6.0 m/s | 3.00 m | 2.00 /s | Chase High | 0.0° | 0.77 | 5.2 s |
| `tier-2-stride.png` | Stride | 10.0 m/s | 4.76 m | 2.10 /s | Chase High | 0.0° | 0.84 | 3.7 s |
| `tier-3-rampage.png` | Rampage | 15.0 m/s | 6.52 m | 2.30 /s | Chase High | 0.0° | 0.83 | 2.8 s |
| `angle-1-chase-high.png` | Rampage | 15.0 m/s | 6.52 m | 2.30 /s | Chase High (yaw 0°) | 0.0° | 0.84 | 2.9 s |
| `angle-2-wide-side.png` | Rampage | 15.0 m/s | 6.52 m | 2.30 /s | Wide Side (yaw clamped 35° → 25.3°) | 28.7° | 0.85 | 3.2 s |
| `angle-3-long-lens.png` | Rampage | 14.3 m/s | 6.29 m | 2.27 /s | Long Lens (yaw 15°, FOV 22) | 22–23° | 0.85 | 3.3–3.4 s |

Angle shots were forced with the dev hook `__GAME.setAngle()` so each angle could be captured; in play, the director picks cuts (no lane change in progress, ≥7 s apart).

## Headless numbers (`npm run gates`, 200 seeds × 60 s, sim + gait + camera)

- Cadence (steps/s): Jog 2.000–2.200 · Stride 2.000–2.205 · Rampage 2.077–2.300 (≈25,000 footfalls).
- Foot slide per plant: 0.00 cm at every tier (≈25,000 plants; feet are pinned while planted). 5.0% of plants lift early, when a lane change carries the hip out of the leg's reach; that's the foot lifting, not sliding.
- Screen-up law: max 34.50° over 720,000 frames (limit 35°).
- Camera cuts: 1,170; during a lane change 0; minimum gap 7.02 s.
- Giant lowest on screen 0.850; road ahead min 2.51 s; 0 frames under 2 s.
- Law 1: speed never below 2 m/s; bot reached Rampage in 200/200 seeds; 14.5 lane changes, 11.6 smashes (2.3 across) per minute.

## In-browser numbers (E2E smoke, production build, 30 s bot run)

Screen-up max 31.37°; giant lowest 0.849; road ahead min 2.54 s; 3 cuts (0 during a lane change, ≥7.33 s apart); cadence 2.00 / 2.01–2.10 / 2.13–2.30; slide 0.00 cm.

## Live URL, played (https://warn-your-friends.vercel.app/, build `index-Cb3K0b63.js`)

- `E2E_URL=… npm run e2e` passed against the live site: click/tap/key start, lane input, no failed requests or errors; camera max 31.72°, giant lowest 0.850, road ahead ≥ 2.52 s, 3 cuts (0 mid-lane-change); cadence in band; slide 0.00 cm.
- `live-played.png`: 37 s driven by keyboard (A/D/arrows, S brake, Shift/W Shoulder Check), seed 11. 20 lane changes, 9 wall bumps, 6 smashes (1 across), a brake tier drop, a 4→3 merge, 4 cuts (0 during a lane change), screen-up max 32.41°, giant lowest 0.851, road ahead ≥ 2.7 s, cadence 2.00 / 2.01–2.19 / 2.10–2.30, slide 0.00 cm, no console errors.
