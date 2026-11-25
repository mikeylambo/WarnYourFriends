import { createHash } from 'node:crypto';
import type { Store } from './leaderboard';

/**
 * Anonymous play telemetry (2026-11-25, ship plan: "where people quit, which district ends runs, mod usage").
 * No ids, no names, no IPs stored: each report only bumps daily counters (a Redis hash per UTC day), and every
 * field is checked against a fixed list, so nothing free-form ever lands in the store. Reads need LB_ADMIN_KEY.
 *
 *   POST /api/telemetry  { events: [{ t: 'end', mode, reason, district, secs, firstRamp, mods, guided } | { t: 'quit', mode, district, secs } | { t: 'session', touch }] }
 *   GET  /api/telemetry?days=14   (header x-admin-key)  → { days: { 'YYYY-MM-DD': { counter: n } } }
 */
export interface Reply {
  status: number;
  body: unknown;
}

const MODES = ['run', 'endless', 'daily', 'broadcast'];
const REASONS = ['cleared', 'won', 'pin', 'caught', 'ratings', 'missed', 'quit'];
const KEEP = 120 * 86400; // four months of days, then gone
const day = (now: number) => new Date(now).toISOString().slice(0, 10);
const key = (now: number) => `wyf:tm:${day(now)}`;
const pick = (v: unknown, list: string[]) => (typeof v === 'string' && list.includes(v) ? v : null);
const int = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.floor(v))) : null);
/** Seconds into a bucket label (so the counters stay few): 0-15, 15-30, 30-60, 60-120, 120-240, 240+. */
function bucket(s: number): string {
  const edges = [15, 30, 60, 120, 240];
  const i = edges.findIndex((e) => s < e);
  return i < 0 ? '240+' : `${i ? edges[i - 1] : 0}-${edges[i]}`;
}

/** The counters one event bumps (exported for tests). Unknown or malformed events bump nothing. */
export function countersFor(e: unknown): string[] {
  if (!e || typeof e !== 'object') return [];
  const o = e as Record<string, unknown>;
  if (o.t === 'session') return ['sessions', o.touch === true ? 'sessions:touch' : 'sessions:desktop'];
  const mode = pick(o.mode, MODES);
  const district = int(o.district, 0, 9);
  const secs = int(o.secs, 0, 36000);
  if (!mode || district === null || secs === null) return [];
  if (o.t === 'quit') return [`quit:${mode}`, `quit:${mode}:d${district}`, `quit:${mode}:t${bucket(secs)}`];
  if (o.t !== 'end') return [];
  const reason = pick(o.reason, REASONS);
  if (!reason) return [];
  const out = [`end:${mode}`, `end:${mode}:${reason}`, `end:${mode}:${reason}:d${district}`, `end:${mode}:t${bucket(secs)}`];
  const fr = int(o.firstRamp, -1, 36000);
  if (fr !== null) out.push(`firstRamp:${fr < 0 ? 'never' : bucket(fr)}`);
  const mods = int(o.mods, 0, 9);
  if (mods !== null) out.push(`mods:${mods}`);
  if (o.guided === true) out.push(`guided:${reason}`, `guided:d${district}`);
  return out;
}

export async function telemetry(store: Store | null, method: string, query: Record<string, unknown>, body: unknown, ip: string, adminKey?: string, given?: string, now = Date.now()): Promise<Reply> {
  if (!store) return { status: 503, body: { error: 'not configured' } };
  if (method === 'GET') {
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');
    if (!adminKey || !given || sha(given) !== sha(adminKey)) return { status: 403, body: { error: 'admin' } };
    const n = int(Number(query.days ?? 14), 1, 120) ?? 14;
    const keys = Array.from({ length: n }, (_, i) => key(now - i * 86400000));
    const rows = (await store.run(keys.map((k) => ['HGETALL', k]))) as (string[] | null)[];
    const days: Record<string, Record<string, number>> = {};
    rows.forEach((r, i) => {
      if (!r || !r.length) return;
      const o: Record<string, number> = {};
      for (let j = 0; j < r.length; j += 2) o[r[j]] = Number(r[j + 1]);
      days[keys[i].slice(7)] = o;
    });
    return { status: 200, body: { days } };
  }
  if (method !== 'POST') return { status: 405, body: { error: 'method' } };
  // A per-minute cap per sender: the address is only part of a short-lived rate key, never stored with the data.
  const rl = `wyf:rl:tm:${createHash('sha256').update(ip).digest('hex').slice(0, 16)}:${Math.floor(now / 60000)}`;
  const [count] = await store.run([['INCR', rl], ['EXPIRE', rl, 120]]);
  if (Number(count) > 30) return { status: 429, body: { error: 'slow down' } };
  let b = body;
  if (typeof b === 'string') {
    try {
      b = JSON.parse(b);
    } catch {
      return { status: 400, body: { error: 'body' } };
    }
  }
  const events = (b as { events?: unknown })?.events;
  if (!Array.isArray(events)) return { status: 400, body: { error: 'events' } };
  const counters = events.slice(0, 10).flatMap(countersFor);
  if (!counters.length) return { status: 204, body: null };
  const k = key(now);
  await store.run([...counters.map((c) => ['HINCRBY', k, c, 1]), ['EXPIRE', k, KEEP]]);
  return { status: 204, body: null };
}
