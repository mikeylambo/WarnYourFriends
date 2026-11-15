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
  producerTips: boolean;
  /** HUD colours (Mike, 2026-11-15): 'wyf' = the station's own (purple, ink, cream, red 6), 'network' = red / blue / white. */
  hudColors: 'wyf' | 'network';
  /** Set when the player turns the debug overlay on themselves (older saves defaulted it on). */
  debugChosen?: boolean;
}

const KEY = 'wyf.settings.v1';
const DEFAULTS: Settings = { reducedMotion: false, reduceFlashes: false, debug: false, cameraCuts: true, liveTime: false, producerTips: true, hudColors: 'wyf' };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      reducedMotion: typeof parsed.reducedMotion === 'boolean' ? parsed.reducedMotion : DEFAULTS.reducedMotion,
      reduceFlashes: typeof parsed.reduceFlashes === 'boolean' ? parsed.reduceFlashes : DEFAULTS.reduceFlashes,
      // The overlay used to default on for everyone: keep it only if the player chose it.
      debug: parsed.debugChosen === true && parsed.debug === true,
      debugChosen: parsed.debugChosen === true,
      cameraCuts: typeof parsed.cameraCuts === 'boolean' ? parsed.cameraCuts : DEFAULTS.cameraCuts,
      liveTime: typeof parsed.liveTime === 'boolean' ? parsed.liveTime : DEFAULTS.liveTime,
      producerTips: typeof parsed.producerTips === 'boolean' ? parsed.producerTips : DEFAULTS.producerTips,
      hudColors: parsed.hudColors === 'network' ? 'network' : 'wyf',
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
