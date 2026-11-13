/**
 * §32 URL flags. Phase 0b uses seed, timescale, bot, step, angle and the accessibility
 * overrides; seg/heat/nodecay/god are parsed now so links keep working, and do
 * nothing until the systems they control exist (Phase 2).
 */
export interface Flags {
  seed: number;
  seedFixed: boolean;
  timescale: number;
  bot: boolean;
  autostart: boolean;
  stepMode: boolean;
  debug: boolean | null;
  reducedMotion: boolean | null;
  reduceFlashes: boolean | null;
  seg: number | null;
  heat: number | null;
  nodecay: boolean;
  god: boolean;
  tune: boolean;
  /** Hold a camera angle (0 Chase High, 1 Wide Side, 2 Long Lens, 3 Head-On). Dev/screenshots. */
  angle: number | null;
  /** Phase 0c: override the Camera cuts setting (?cuts=0). */
  cuts: boolean | null;
  /** Dev: render from a side-on camera beside the giant to judge the run pose (?posecam=1). */
  posecam: boolean;
  /** Phase 0c: force a look (?time=night|dusk|day), overriding LIVE TIME. */
  time: 'night' | 'dusk' | 'day' | null;
}

function bool(q: URLSearchParams, k: string): boolean | null {
  if (!q.has(k)) return null;
  const v = q.get(k);
  return v === '' || v === '1' || v === 'true';
}

function num(q: URLSearchParams, k: string): number | null {
  const v = q.get(k);
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function readFlags(search: string): Flags {
  const q = new URLSearchParams(search);
  const seed = num(q, 'seed');
  return {
    seed: seed ?? (Math.random() * 1e9) | 0,
    seedFixed: seed !== null,
    timescale: Math.max(0.05, Math.min(8, num(q, 'timescale') ?? 1)),
    bot: bool(q, 'bot') ?? false,
    autostart: bool(q, 'autostart') ?? false,
    stepMode: bool(q, 'step') ?? false,
    debug: bool(q, 'debug'),
    reducedMotion: bool(q, 'reducedmotion'),
    reduceFlashes: bool(q, 'reduceflashes'),
    seg: num(q, 'seg'),
    heat: num(q, 'heat'),
    nodecay: bool(q, 'nodecay') ?? false,
    god: bool(q, 'god') ?? false,
    tune: bool(q, 'tune') ?? false,
    angle: num(q, 'angle'),
    cuts: bool(q, 'cuts'),
    posecam: bool(q, 'posecam') ?? false,
    time: ((v) => (v === 'night' || v === 'dusk' || v === 'day' ? v : null))(q.get('time')),
  };
}
