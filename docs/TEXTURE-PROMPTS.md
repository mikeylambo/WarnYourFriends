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

## Optional next set (not wired yet; say if you want them)
- `concrete` (barrier walls and the bridge deck), `tunnelTile` (tunnel walls), `water` (under Saltmarsh Bridge, a stylized ripple pattern).
