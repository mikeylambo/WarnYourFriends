/**
 * Anonymous play telemetry, client side (2026-11-25). Fire-and-forget counters only (see server/telemetry.ts): no
 * ids, names or scores leave the browser. Off when the player turns it off (Settings → Game) or the browser sends
 * Do Not Track. Never for the bot, tests or local dev.
 */
export type TelemetryEvent =
  | { t: 'session'; touch: boolean }
  | { t: 'end'; mode: string; reason: string; district: number; secs: number; firstRamp: number; mods: number; guided: boolean }
  | { t: 'quit'; mode: string; district: number; secs: number };

let enabled = true;
export function setTelemetry(on: boolean) {
  enabled = on;
}
function allowed(): boolean {
  if (!enabled) return false;
  const nav = navigator as Navigator & { doNotTrack?: string; webdriver?: boolean };
  if (nav.doNotTrack === '1' || nav.webdriver) return false;
  return location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';
}
export function track(e: TelemetryEvent) {
  if (!allowed()) return;
  const body = JSON.stringify({ events: [e] });
  try {
    // sendBeacon survives the tab closing (the quit event depends on it).
    if (navigator.sendBeacon?.('/api/telemetry', new Blob([body], { type: 'application/json' }))) return;
    void fetch('/api/telemetry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
  } catch {
    /* telemetry never breaks the game */
  }
}
