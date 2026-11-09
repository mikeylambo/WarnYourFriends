# Camera rework evidence (2026-11-10)

Production build in headless Chromium (software GL), seed 5, `?debug=1&reducedmotion=1` (wobble off so shots are comparable), real-time play with keyboard input. The overlay's last line is the camera's own measurement.

| Shot | Tier | Speed | Giant screen Y (0 top, 1 bottom) | Road visible ahead | Look-ahead used | Notes |
|---|---|---|---|---|---|---|
| `1-jog-straight.png` | Jog | 6 m/s | 0.80 | 4.3s (26m) | 9.6m (full 1.6s) | |
| `2-stride-straight.png` | Stride | 10 m/s | 0.85 | 3.4s (34m) | 13.4m (capped) | |
| `3-rampage-straight.png` | Rampage | 15 m/s | 0.85 | 3.0s (45m) | 17.6m (capped) | |
| `4-corner-entry.png` | Rampage | 15 m/s | 0.85 | 2.9s | 17.0m | 90° right turn onto the cross street, no bounce |
| `5-corner-apex.png` | Rampage | 15 m/s | 0.85 | 3.0s | 18.3m | building blocked the line of sight; camera climbed 10m |
| `6-corner-exit.png` | Rampage | 15 m/s | 0.85 | 3.0s | 17.6m | settled back (climb 0.4m) |
| `7-sustained-turn-swung.png` | Rampage | 15 m/s | 0.85 | 2.9s | 16.9m | after holding a left turn: side swung +1 → −1 |

Side over the sustained turn, `[sim time, side]`: held from t=17.8; swing starts ~t=19.6 (≈2s of sustained turning), reaches −1 at ~t=21.8 (≈2.5s ease):
`[17.77,1] [19.57,1] [19.88,0.86] [20.33,0.41] [20.88,-0.24] [21.30,-0.68] [21.78,-0.98] [23.53,-1]`

E2E bot run (30s, erratic steering): camera inside a building 0/154 samples; giant hidden by a building 4/154 (brief, while climbing); worst-case road ahead 1.3s and giant Y 0.91 during sharp swerves while the lagged camera catches up.

`live-bot-run.png`: the deployed build at https://warn-your-friends.vercel.app/ (asset `index-8FzMCEN4.js`) after `E2E_URL=… npm run e2e` passed: start via click/tap/key, no failed requests, bot at Rampage with the new camera; camera inside a building 0/155 samples, giant hidden 5/155.
