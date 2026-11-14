# Warn Your Friends

*Giant At Large. Warn Your Friends.*

A top-down chase roguelite: a giant fugitive barrels through a city on live TV, scoring ratings for spectacle. Design: [`docs/GDD.md`](docs/GDD.md). Rules for building: [`CLAUDE.md`](CLAUDE.md). Build-time calls: [`DECISIONS.md`](DECISIONS.md).

## Status: Phase 3, depth

**Full Broadcast:** five segments, each opening hotter. Between them, the Producer's Meeting pitches three upgrades, paid from the Ratings you banked: abilities (Leap, The Stare, Hijack Hop, Pose for the Camera) and passives (Iron Shins, Second Wind, Showman, Tailwind). **Single Segment** is one broadcast.

Each segment, start to finish: The giant runs a procedural road at night: highway, avenues, bridges, tunnels. You pick lanes and smash across them while the station's coverage escalates with the Ratings.

- **Keep the Ratings up** (a viewer count, top left): smashes, near-misses and shaking off pursuers feed it; it decays when nothing happens. At 0 the network cuts to commercial.
- **Police in your lanes:** cruisers swerve in after a blinker, spike strips unroll, roadblocks slide in (one lane stays open and glows), rolling roadblocks crawl ahead (smash the small car). Rampage smashes police cars.
- **Sign off:** at 2:10 an exit ramp opens; be in the right lane at the gore before the clock runs out.
- **The broadcast:** traffic-cam cold open, LIVE, a second chopper, viewer video, a viewer ticker, the anchor desk, a simulcast at CITY IN CHAOS, a chyron that writes headlines from what happened, and the 11 O'Clock Recap.
- **Cameras:** Chase High home; event-driven cut-aways (Wide Side, Long Lens, Head-On, High Head-On, Overhead) with a swoop home.

Live: https://warn-your-friends.vercel.app

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
| Ability | E / Q | LB or Y | Ability button |
| Pause | Esc | Start | II |

Dev keys: **H** cut to Head-On / swoop home · **T** tuning panel · **`** debug overlay · **C** next camera angle · **R** new road.

URL flags: `?seed=N` · `?angle=0..5` (hold Chase High / Wide Side / Long Lens / Head-On / High Head-On / Overhead) · `?time=night|dusk|day` · `?cuts=0` · `?timescale=0.5` · `?bot` autopilot · `?tune` · `?reducedmotion` · `?reduceflashes` · `?step` (headless, `window.__GAME.step(n)`).

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
