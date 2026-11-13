# Phase 2 evidence: core playable, broadcast escalation, road variety (2026-11-12)

Production build in headless Chromium (software GL), bot driving in step mode, `?cuts=0&reducedmotion=1`. Regenerate with `node tools/shots-phase2.mjs`.

| Shot | What it shows |
|---|---|
| `tell-cruiser-ram.png` | Cruiser alongside, lights and blinker, winding up to swerve (Kessler Avenue) |
| `tell-spike-strip.png` | Officer kneeling, strip unrolling across his lane; chyron "Officers Lay Spikes Ahead Of Giant" |
| `tell-roadblock.png` | Static roadblock sliding in; the open lane glows; chyron "Police Set Up Roadblock On The Interstate" |
| `tell-rolling-roadblock.png` | Cruisers abreast ahead with brake lights |
| `zone-avenue.png`, `zone-bridge.png`, `zone-tunnel.png` | Storefront canyon with lit windows; bridge over water; cutaway tunnel |
| `exit-ramp.png` | SIGN-OFF arrow with distance, countdown clock, gantry over him faded |
| `recap.png` | The 11 O'Clock Recap after signing off |

## Headless (`npm run gates`: 200 seeds × one full segment, 165s)

- Endings: cleared 130, cut to commercial (Ratings 0) 41, missed the exit 29 (the soak bot brakes every 12s on purpose). Box-in busts are covered by unit tests (`src/sim/show.test.ts`).
- Pursuers: ~1,600 cruisers, ~250 spike strips, ~140 roadblocks, ~50 rolling roadblocks. Nearest spawn 60m (LOCKED ≥40m); 0 spawns on camera; at most 1 tell at a time; **0 tells starting off screen**; 0 camera cuts during a tell.
- Every segment ends by 165s; Heat never falls; meters in range; speed floor and no-stall hold through rams and roadblocks.
- Camera rules unchanged: screen-up ≤34.5° (mirrored for head-on angles), road ahead ≥2.06s, swoops ≤1.38s.

## In-browser (E2E)

A full broadcast in step mode ends (signed off), the recap appears, and Enter starts a new broadcast. 18/18 silhouettes pass (6 angles × night/dusk/day). Head-On lanes mirror and the swoop lands in Chase High.
