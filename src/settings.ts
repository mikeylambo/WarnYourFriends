/** §37 persistence (settings only in Phase 0). Corrupt save resets to defaults. */
export interface Settings {
  reducedMotion: boolean;
  reduceFlashes: boolean;
  debug: boolean;
}

const KEY = 'wyf.settings.v1';
const DEFAULTS: Settings = { reducedMotion: false, reduceFlashes: false, debug: true };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      reducedMotion: typeof parsed.reducedMotion === 'boolean' ? parsed.reducedMotion : DEFAULTS.reducedMotion,
      reduceFlashes: typeof parsed.reduceFlashes === 'boolean' ? parsed.reduceFlashes : DEFAULTS.reduceFlashes,
      debug: typeof parsed.debug === 'boolean' ? parsed.debug : DEFAULTS.debug,
    };
  } catch {
    console.warn('Settings were unreadable and have been reset to defaults.');
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* storage unavailable */
    }
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: settings last for this session only */
  }
}
