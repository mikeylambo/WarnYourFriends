import { KEY_ACTIONS, RESERVED_KEYS, type KeyAction } from './input';

/** §37 persistence (settings only in Phase 0). Corrupt save resets to defaults. */
export interface Settings {
  reducedMotion: boolean;
  reduceFlashes: boolean;
  debug: boolean;
  /** Phase 0c: event-driven broadcast cuts. Off holds Chase High. */
  cameraCuts: boolean;
  /** Phase 0c LIVE TIME: lighting follows the local clock. Off = always night. */
  liveTime: boolean;
  /** Onboarding: one-line producer notes the first time each thing matters. */
  /** HUD colours (Mike, 2026-11-15): 'wyf' = the station's own (purple, ink, cream, red 6), 'network' = red / blue / white. */
  hudColors: 'wyf' | 'network';
  /** Kept for saves written while Giant Size was a setting (2026-11-15); the size is committed now. */
  giantSize: 'growth' | 'fixed' | 'big';
  /** Set when the player turns the debug overlay on themselves (older saves defaulted it on). */
  debugChosen?: boolean;
  /** Accessibility (2026-11-17). Brake toggles on a press instead of holding. */
  brakeToggle: boolean;
  /** HUD size multiplier (1, 1.15, 1.3). */
  hudSize: number;
  /** Game speed (1, 0.9, 0.8, 0.7). Below 1 the leaderboard is off (it's an assist). */
  gameSpeed: number;
  /** Rampage loop (2026-11-17): fire Rampage the moment the meter is full (default on for touch screens). */
  autoRampage: boolean;
  /** Rebound keyboard keys, one per action; null = the defaults. */
  keys: Record<KeyAction, string> | null;
}

export const HUD_SIZES = [1, 1.15, 1.3];
export const GAME_SPEEDS = [1, 0.9, 0.8, 0.7];

function readKeys(v: unknown): Record<KeyAction, string> | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const out = {} as Record<KeyAction, string>;
  for (const a of KEY_ACTIONS) {
    const k = o[a];
    if (typeof k !== 'string' || !/^[A-Za-z0-9]+$/.test(k) || RESERVED_KEYS.includes(k)) return null;
    out[a] = k;
  }
  // Every action needs its own key.
  return new Set(Object.values(out)).size === KEY_ACTIONS.length ? out : null;
}

const KEY = 'wyf.settings.v1';
const DEFAULTS: Settings = { reducedMotion: false, reduceFlashes: false, debug: false, cameraCuts: true, liveTime: false, hudColors: 'wyf', giantSize: 'growth', brakeToggle: false, hudSize: 1, gameSpeed: 1, autoRampage: false, keys: null };
/** Touch screens default to Auto Rampage (one less thing to reach for). */
const coarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS, autoRampage: coarse() };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      reducedMotion: typeof parsed.reducedMotion === 'boolean' ? parsed.reducedMotion : DEFAULTS.reducedMotion,
      reduceFlashes: typeof parsed.reduceFlashes === 'boolean' ? parsed.reduceFlashes : DEFAULTS.reduceFlashes,
      // The overlay used to default on for everyone: keep it only if the player chose it.
      debug: parsed.debugChosen === true && parsed.debug === true,
      debugChosen: parsed.debugChosen === true,
      cameraCuts: typeof parsed.cameraCuts === 'boolean' ? parsed.cameraCuts : DEFAULTS.cameraCuts,
      liveTime: typeof parsed.liveTime === 'boolean' ? parsed.liveTime : DEFAULTS.liveTime,
      hudColors: parsed.hudColors === 'network' ? 'network' : 'wyf',
      giantSize: parsed.giantSize === 'fixed' || parsed.giantSize === 'big' ? parsed.giantSize : 'growth',
      brakeToggle: parsed.brakeToggle === true,
      hudSize: HUD_SIZES.includes(parsed.hudSize as number) ? (parsed.hudSize as number) : 1,
      gameSpeed: GAME_SPEEDS.includes(parsed.gameSpeed as number) ? (parsed.gameSpeed as number) : 1,
      autoRampage: typeof parsed.autoRampage === 'boolean' ? parsed.autoRampage : coarse(),
      keys: readKeys(parsed.keys),
    };
  } catch {
    console.warn('Settings were unreadable and have been reset to defaults.');
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* storage unavailable */
    }
    return { ...DEFAULTS, autoRampage: coarse() };
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: settings last for this session only */
  }
}
