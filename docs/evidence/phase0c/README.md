# Phase 0c evidence: fantasy slice (2026-11-11)

Production build in headless Chromium (software GL, 1280×720, so frame rates aren't representative). Seed 5, bot driving in real time, `?reducedmotion=1&cuts=0`. Each angle is held with the dev hook `__GAME.setAngle()` and each look forced with `__GAME.setLook()`. `shots.json` has the numbers. In play, Chase High is home and the director cuts away only on events.

## Silhouette test (`src/render/silhouette.ts`)

Pass = ≥48px tall at 720p (§13) **and** ≥3:1 contrast between the giant's and his surround's median luminance **and** ≥60% of outline pixel pairs differing by ≥0.12 luma. The thresholds were set before measuring.

| Look | Chase High | Wide Side | Long Lens |
|---|---|---|---|
| Night (default) | 123px · 8.6:1 · 97% ✅ | 81px · 5.7:1 · 93% ✅ | 110px · 7.4:1 · 97% ✅ |
| Dusk | 121px · 5.4:1 · 90% ✅ | 82px · 4.7:1 · 82% ✅ | 105px · 5.1:1 · 90% ✅ |
| Day | 134px · 6.8:1 · 97% ✅ | 87px · 7.3:1 · 97% ✅ | 97px · 6.6:1 · 93% ✅ |

In every shot the giant is dark on a lighter surround (the §23 value rule). The first night pass, before the ink outline, failed Chase High at 44–48% edge: the bone horns, white topknot and siren-lit head disappeared into the lit spotlight pool. The fix is the inverted-hull outline plus a dimmer pool.

## Headless (`npm run gates`: 200 seeds × 60s)

- Cut-aways: 557, all event-backed (Rampage 320, Heavy 173, merge 64, from 2,019 trigger events). Min gap between cut-aways 15.02s; away held 6.03–10.00s; 0 cuts during a lane change; 0 cuts on the 3 seeds run with Camera cuts Off.
- Escort: 600 joins, every one 100m back and 0 on camera; closest gap ever 7.00m (floor 7m).
- Unchanged from 0b: screen-up max 34.50°, giant lowest 0.850, road ahead ≥2.24s (was 2.51s; cut-aways now look less far ahead), cadence in band, 0.00cm foot slide.

## In-browser (E2E smoke, production build, 30s bot run at 3×)

Cuts 5.9s Rampage → 12.3s home → 26.3s Heavy (≥15s apart, none mid-lane-change). 3 cruisers trailing at 8.8 / 13.8 / 22.2m. Headlines: *Giant Spotted Northbound · BREAKING Giant At Large. Warn Your Friends. · BREAKING Giant Reaches Full Rampage Near Mile 0.0 · Police Join Pursuit In Lane 3 · … · Unstoppable Giant Punts Sedan In Lane 4*. All 9 angle/look silhouettes pass.
