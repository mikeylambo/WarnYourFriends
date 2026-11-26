# Milestones to ship

The ship gap (Mike, 2026-11-24): what a reputable studio would block on. Ticked boxes are done and proven in a running build (§41). Build-time calls still go in `DECISIONS.md`.

Status: `[ ]` todo · `[~]` in progress · `[x]` done. Last reviewed 2026-11-26.

**Left before launch:** strip the debug and playtest surfaces (below, M3). Everything else open is Mike's: the Vercel admin key, the official trademark checks, the asset provenance note, one real Android check, and the itch.io content questions.

## M1 — Now (ship blockers we're working)

### Consistency
- [x] One word per idea everywhere (HUD, menus, How to Play, recap, asks, awards, headlines). Glossary below is the law.
- [x] Model vs portraits: in-game Meshy model already has no topknot and flat pauldrons, matching the painted outfits (the DECISIONS note was about the old greybox rig).

### Leaderboard
- [x] Name filter (profanity / slurs / impersonation of staff), length and charset limits, server-side.
- [x] Rate limit per IP and per player id; reject bursts.
- [x] Moderation path: hidden admin page `/admin.html` (boards with Remove / Rename, play stats), unlocked by the `LB_ADMIN_KEY` env. **Mike: set the key in Vercel.**

### Teaching opening (first five minutes)
- [x] First broadcast teaches by doing (tutorial chunk: car in his lane → Exclusives row → spaced cars; first Exclusive / near miss prompts; Rampage guaranteed by 55s; no rules card): one swipe, one near miss, one Exclusive, the first Rampage forced, each prompted at the moment, no cards to read. Skippable for returning players.

### Hit feel audit
- [x] Every interaction has sound + particles + camera + number popup (2026-11-24 audit filled: Exclusive, police near miss, shake-off, net escape, audience full, Rampage end, ask done): smash (light/medium/heavy), near miss, Exclusive, rival van, target car, police crash, shake-off, Rampage start/end, ask complete, unlock.

### Front-screen progression
- [x] Main menu shows: best Story score, Stories finished, the next award with its bar.
- [ ] Nice to have: today's Daily on the main menu card.
- [x] Recap gives a "one more run" hook: "N short of your best" / "New best!" (Story too: it never showed a best before), plus the next award.

### Platform polish
- [x] Landscape on phones: rotate card everywhere a phone is held upright (menus included), pause behind it.
- [x] Every menu screen has a reachable way back on a landscape phone (cards scroll by touch, buttons pinned); E2E menu-flow regression covers How to Play, Awards, Credits, Settings, Rebind Keys, Rundown, Pause.
- [x] Installable (PWA manifest + icons), fullscreen landscape launch; tab title fixed (was "Giant at Large").
- [x] Audio unlocks on first tap and pauses with the game on background (iOS's silent switch can't be read by a web page).
- [x] Safe areas (2026-11-26): `tools/safe-area.mjs` (in the gates) emulates a Dynamic Island iPhone in landscape (47px sides, 21px home indicator) at two sizes and checks every visible HUD and menu element through menus, play, the viewer video and the recap. Fixed: ticker and shell panel 5–9px into the home-indicator zone; the 11 O'Clock Recap ran ~150px off a landscape phone (now scrolls, buttons pinned).
- [x] Haptics on/off setting (already there).

### Accessibility
- [x] Reduce Flashes, Reduced Motion, HUD size, rebinding.
- [x] Colour-blind check (deuteranopia, protanopia, tritanopia sims in `docs/evidence/colorblind/`): every cue has a label, a shape or brightness, not hue alone.
- [x] Tap-zone controls: Settings → Controls → Touch Lanes: Tap Sides.
- [x] Captions: not needed. The game has no spoken lines, only SFX and music; the chyron and ticker carry all the words.

## M2 — Next

### Art cohesion
- [x] Roads, trees and cars up to the giant's level: ink outlines on vehicles, trees, buildings and bridge towers; pines and round trees; painted ground textures (asphalt, verge, paving, concrete, tunnel tile, water; `docs/TEXTURE-PROMPTS.md`); Downtown streetlights wall-mounted; green verge.

### Performance
- [~] 60 fps on a mid-range Android and an older iPhone; load < 5 s; draw-call budget (`tools/perf-draws.mjs`) held.
  - Simulated Android (`tools/perf-android.mjs`, CPU 4×, Fast 4G, 2026-11-25): playable in 3.35 s (pass), 2.5 MB download (giant texture re-encoded, GLB 3.6→1.4 MB), JS heap 25 MB. Spikes fixed: segments built one per frame, shaders pre-compiled at go-live.
  - Not done: geometry compression for the giant (needs a tool that wasn't available).
  - GPU not simulatable here: needs one real-device check (any Android friend's phone, or BrowserStack's free trial).

### Telemetry
- [x] Funnel telemetry: anonymous daily counters (`server/telemetry.ts`), opt-out in Settings, readable on `/admin.html` or with `tools/telemetry-report.mjs`.
- [ ] Nice to have: crash reporting (uncaught errors to a counter).

## M3 — Release build
- [ ] Strip debug and playtest surfaces (`?tune`, `?debug`, `?playtest`, `?classic`, "Copy play data", `window.__GAME` outside dev).
- [x] Privacy policy (`public/privacy.html`, Settings → Game → Privacy Policy; contact wavelengthgamedev@gmail.com).
- [x] Credits (main menu → Credits): "Created, designed and directed by Mikey Lambo".
- [ ] Age rating: answer the content questions when publishing on itch.io (formal ratings only for consoles / app stores).
- [ ] Terms of service: not needed for a free web game; revisit for a paid or store release.
- [x] Title: "Giant at Large: Warn Your Friends" (tab, install, store); the title card's wordmark is drawn in game over text-free cover art.
- [~] Trademark: web pass found no conflict (`docs/TRADEMARK-SEARCH.md`). **Mike: the official USPTO / store checks listed there (~20 min).**
- [ ] **Mike:** asset provenance note: which paid plan and when for Meshy (giant), ElevenLabs (SFX), Suno (music: check the plan allows commercial use), and the image generator (textures, painted art). Keep receipts.
- [x] Music: Suno themes (title over the menus, in-game with a six-bar intro then a seamless loop, sign-off, busted) and a Rampage layer on the music bus.
- [x] Store assets (itch.io): cover, banner, background, screenshots, GIFs (`store/itch`, `tools/gifs.mjs`).
- [ ] **Mike:** one check on a real Android phone (frame rate; the GPU can't be simulated here).

## Glossary (one word per idea)

| Idea | Say | Never |
|---|---|---|
| The bar you fill | **Audience** | ratings, meter (in UI text) |
| Full bar mode | **Rampage** | rampage mode, frenzy |
| Squeezing past a car | **Near miss** | close call, close dodge |
| Yellow pickup | **Exclusive** | scoop |
| One play from go-live to sign-off | **Broadcast** | run, segment (in UI text) |
| The five-district mode | **Story** | full broadcast |
| The producer's goals | **Asks** | challenges, missions |
| Modifiers you switch on | **Traffic mods** | modifiers, mutators |
| The police catching you | **Caught** | busted, arrested |
| Getting to the exit | **Sign-off** | finish, escape |
