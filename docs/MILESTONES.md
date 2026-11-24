# Milestones to ship

The ship gap (Mike, 2026-11-24): what a reputable studio would block on. Ticked boxes are done and proven in a running build (§41). Build-time calls still go in `DECISIONS.md`.

Status: `[ ]` todo · `[~]` in progress · `[x]` done

## M1 — Now (ship blockers we're working)

### Consistency
- [x] One word per idea everywhere (HUD, menus, How to Play, recap, asks, awards, headlines). Glossary below is the law.
- [x] Model vs portraits: in-game Meshy model already has no topknot and flat pauldrons, matching the painted outfits (the DECISIONS note was about the old greybox rig).

### Leaderboard
- [x] Name filter (profanity / slurs / impersonation of staff), length and charset limits, server-side.
- [x] Rate limit per IP and per player id; reject bursts.
- [x] Moderation path: a way to delete an entry (admin key, not in the client). `LB_ADMIN_KEY` env still to set in Vercel.

### Teaching opening (first five minutes)
- [x] First broadcast teaches by doing (tutorial chunk: car in his lane → Exclusives row → spaced cars; first Exclusive / near miss prompts; Rampage guaranteed by 55s; no rules card): one swipe, one near miss, one Exclusive, the first Rampage forced, each prompted at the moment, no cards to read. Skippable for returning players.

### Hit feel audit
- [x] Every interaction has sound + particles + camera + number popup (2026-11-24 audit filled: Exclusive, police near miss, shake-off, net escape, audience full, Rampage end, ask done): smash (light/medium/heavy), near miss, Exclusive, rival van, target car, police crash, shake-off, Rampage start/end, ask complete, unlock.

### Front-screen progression
- [x] Main menu shows: best Story score, Stories finished, the next award with its bar. (Today's Daily on the card: todo.)
- [x] Recap gives a "one more run" hook: "N short of your best" / "New best!" (Story too: it never showed a best before), plus the next award.

### Platform polish
- [x] Landscape for play on phones (rotate card + pause).
- [x] Installable (PWA manifest + icons), fullscreen landscape launch; tab title fixed (was "Giant at Large").
- [x] Audio unlocks on first tap and pauses with the game on background (iOS's silent switch can't be read by a web page).
- [ ] Safe areas checked on notch / Dynamic Island / Android cutouts in landscape.
- [x] Haptics on/off setting (already there).

### Accessibility
- [x] Reduce Flashes, Reduced Motion, HUD size, rebinding.
- [x] Colour-blind check (deuteranopia, protanopia, tritanopia sims in `docs/evidence/colorblind/`): every cue has a label, a shape or brightness, not hue alone.
- [x] Tap-zone controls: Settings → Controls → Touch Lanes: Tap Sides.
- [ ] Captions for any voice line.

## M2 — Next

### Art cohesion
- [~] Roads, trees and cars up to the giant's level (code pass done 2026-11-24: ink outlines on vehicles and trees, pines + round trees, textured asphalt/verge/paving; painted textures pending, prompts in `docs/TEXTURE-PROMPTS.md`) (lighting stays). Options: Meshy (credits), GPT image → image-to-3D elsewhere, or a hand-authored stylized low-poly kit in code (no credits; consistent by construction).

### Performance
- [~] 60 fps on a mid-range Android and an older iPhone; load < 5 s; draw-call budget (`tools/perf-draws.mjs`) held.
  - Simulated Android (`tools/perf-android.mjs`, CPU 4×, Fast 4G, 2026-11-24): playable in 3.6 s (pass), 4.7 MB download (the giant GLB is 3.6 MB of it), JS heap 57 MB, sim step p95 0.9 ms but one 11.5 ms spike (likely road generation) to smooth out.
  - GPU not simulatable here: needs one real-device check (any Android friend's phone, or BrowserStack's free trial).

### Telemetry
- [ ] Funnel + crash reporting (where people quit, which district ends runs, mod usage). `src/playlog.ts` is the seed.

## M3 — Release build
- [ ] Strip debug and playtest surfaces (`?tune`, `?debug`, `?playtest`, `?classic`, "Copy play data", `window.__GAME` outside dev).
- [ ] Privacy policy (leaderboard names), terms, credits screen, age rating.
- [ ] Title / trademark search (DECISIONS 2026-11-09 still open).
- [ ] Asset provenance list: Meshy, ElevenLabs, painted art, made under paid accounts (keep receipts / account tier per asset).
- [ ] Music: a signature theme and a Rampage layer.

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
