# Ground texture prompts (for GPT image generation)

The game draws these three in code today (`src/render/textures.ts`). A painted one replaces the code version with **no code change**: save it as `src/assets/tex/<name>.webp` (or `.png` / `.jpg`), then build.

## Rules every texture must follow
The game tints each texture with the scene's own colour and lighting (night, dusk, day), so the image has to be **near-white and greyscale**. A coloured or dark texture would fight the lighting.

- Square, **1024 × 1024**, **seamlessly tileable** on all four edges (it repeats across the road).
- **Straight top-down, orthographic**: no perspective, no horizon.
- **Greyscale, light**: mostly 85–100% white, details in light-to-mid grey. No pure black.
- **No baked lighting**: no shadows, highlights or vignette.
- **Stylized, hand-painted, flat cel-shaded look** (matching a toon-shaded game), not photoreal.
- No text, logos, lane markings, arrows or symbols.

Paste the "Rules" block above into each prompt if GPT drifts.

---

### 1. `asphalt` (the road, one tile = 8 m)
> Seamless tileable texture, 1024x1024, straight top-down orthographic view of a stylized road asphalt surface. Hand-painted, flat cel-shaded style like a modern stylized video game. Greyscale only, very light: near-white base (about 92% white) with fine light-grey aggregate speckle, two or three faint wandering hairline cracks, and one subtle rectangular patch of slightly different asphalt. Low contrast, calm, readable from high above. No lane markings, no paint, no text, no shadows, no lighting, no perspective, no vignette. Edges must tile seamlessly.

### 2. `verge` (the grass beside the highway, one tile = 10 m)
> Seamless tileable texture, 1024x1024, straight top-down orthographic view of short roadside grass. Stylized hand-painted, flat cel-shaded style: soft clumps and a few simple blade strokes, gentle variation, no individual realistic blades. Greyscale only, very light: near-white base (about 90% white) with clumps in light grey. Low contrast. No flowers, no rocks, no text, no shadows, no lighting, no perspective, no vignette. Edges must tile seamlessly.

### 3. `paving` (Downtown sidewalks, one tile = 4 m)
> Seamless tileable texture, 1024x1024, straight top-down orthographic view of a city sidewalk made of a 4 by 4 grid of square concrete slabs. Stylized hand-painted, flat cel-shaded style. Greyscale only, light: slabs near-white with slight tone variation between them, thin mid-grey joints, one or two slabs with a faint crack or stain. The grid lines must line up across the tile edges so it tiles seamlessly. No text, no manholes, no shadows, no lighting, no perspective, no vignette.

---

## After you have them
1. Convert to `.webp` if you can (smaller), keep 1024 × 1024.
2. Drop them in `src/assets/tex/` as `asphalt.webp`, `verge.webp`, `paving.webp`.
3. Tell me and I'll check them in game at night, dusk and day and tune the tile sizes in `TILE` if needed.

## Set 2: walls, tunnel, water (wired: drop them in and they're used)
Same rules as above. Until a file exists, these surfaces stay flat colour.

### 4. `concrete` (highway barrier walls and the bridge deck, one tile = 3 m)
> Seamless tileable texture, 1024x1024, flat front-on orthographic view of a poured concrete highway barrier surface. Stylized hand-painted, flat cel-shaded style like a modern stylized video game. Greyscale only, very light: near-white base (about 92% white) with soft light-grey mottling, a few tiny pores, faint horizontal form-board seams, one or two subtle water-stain streaks running down. Low contrast. No graffiti, no text, no shadows, no lighting, no perspective, no vignette. Edges must tile seamlessly.

### 5. `tunnelTile` (Old Harbor Tunnel walls, one tile = 2 m)
> Seamless tileable texture, 1024x1024, flat front-on orthographic view of a road-tunnel wall made of small rectangular ceramic tiles in a running-bond (brick) pattern, about 8 tiles across and 16 rows. Stylized hand-painted, flat cel-shaded style. Greyscale only, light: tiles near-white with slight tone variation, thin mid-grey grout lines, a few tiles faintly grimy toward the bottom edge of the image. The grout pattern must line up across the tile edges so it tiles seamlessly. No text, no signs, no lights, no shadows, no lighting, no perspective, no vignette.

### 6. `water` (under Saltmarsh Bridge, one tile = 24 m)
> Seamless tileable texture, 1024x1024, straight top-down orthographic view of calm harbour water. Stylized hand-painted, flat cel-shaded style: simple soft ripple shapes and a few short wavy highlight strokes, like a stylized game's water, not photoreal. Greyscale only, light: near-white base (about 88% white) with ripples in light grey and highlights in pure white. Low contrast, calm. No boats, no foam lines along edges, no reflections of objects, no text, no shadows, no lighting, no perspective, no vignette. Edges must tile seamlessly.

After you have them: same as before, `src/assets/tex/concrete.webp`, `tunnelTile.webp`, `water.webp`. I'll check them at night, dusk and day, and lighten them if the giant's silhouette check needs it (as with set 1).
