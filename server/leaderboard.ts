import { TUNING } from '../src/tuning';
import { cleanName, verify, type BoardMode, type Submission } from '../src/leaderboard/verify';

/**
 * Leaderboard API (bundled to api/leaderboard.js by tools/build-api.mjs).
 *   GET  /api/leaderboard?mode=run|broadcast[&player=id]  → { top: [{ rank, name, score }], you?: { rank, score } }
 *   POST /api/leaderboard  { player, name, ...Submission }  → { ok, score, rank, best }
 * One row per player per mode (their best). The score stored is the server's re-simulation.
 */

export interface Store {
  /** Redis commands, run in order; one result per command. */
  run(cmds: (string | number)[][]): Promise<unknown[]>;
}

/** Upstash Redis over REST (Vercel Marketplace). Either naming the integration uses works. */
export function redisFromEnv(env: Record<string, string | undefined>): Store | null {
  const url = env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return {
    async run(cmds) {
      const r = await fetch(`${url}/pipeline`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(cmds) });
      if (!r.ok) throw new Error(`redis ${r.status}`);
      const out = (await r.json()) as { result?: unknown; error?: string }[];
      return out.map((o) => {
        if (o.error) throw new Error(o.error);
        return o.result;
      });
    },
  };
}

/** In-memory store for tests and local dev (the handful of commands this file uses). */
export function memoryStore(): Store {
  const z = new Map<string, Map<string, number>>();
  const h = new Map<string, Map<string, string>>();
  const n = new Map<string, number>();
  const zset = (k: string) => z.get(k) ?? z.set(k, new Map()).get(k)!;
  const hash = (k: string) => h.get(k) ?? h.set(k, new Map()).get(k)!;
  const sorted = (k: string) => [...zset(k)].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1));
  return {
    async run(cmds) {
      return cmds.map(([c, ...a]) => {
        const k = String(a[0]);
        switch (String(c).toUpperCase()) {
          case 'ZADD': {
            // ZADD key GT CH score member
            const score = Number(a[3]);
            const m = String(a[4]);
            const old = zset(k).get(m);
            if (old === undefined || score > old) {
              zset(k).set(m, score);
              return 1;
            }
            return 0;
          }
          case 'ZSCORE': {
            const v = zset(k).get(String(a[1]));
            return v === undefined ? null : String(v);
          }
          case 'ZREVRANK': {
            const i = sorted(k).findIndex(([m]) => m === String(a[1]));
            return i < 0 ? null : i;
          }
          case 'ZRANGE': {
            // ZRANGE key start stop REV WITHSCORES
            return sorted(k).slice(Number(a[1]), Number(a[2]) + 1).flatMap(([m, s]) => [m, String(s)]);
          }
          case 'HSET':
            hash(k).set(String(a[1]), String(a[2]));
            return 1;
          case 'HMGET':
            return a.slice(1).map((f) => hash(k).get(String(f)) ?? null);
          case 'INCR':
            n.set(k, (n.get(k) ?? 0) + 1);
            return n.get(k);
          case 'EXPIRE':
            return 1;
          default:
            throw new Error(`memoryStore: ${c}`);
        }
      });
    },
  };
}

export interface Reply {
  status: number;
  body: unknown;
}

// Season 1 boards were the bare `wyf:lb:<mode>` keys; later seasons get their own (old scores were earned under other rules).
const KEY = (mode: BoardMode) => (TUNING.leaderboard.season > 1 ? `wyf:lb:s${TUNING.leaderboard.season}:${mode}` : `wyf:lb:${mode}`);
const NAMES = 'wyf:lb:names';
const isMode = (m: unknown): m is BoardMode => m === 'run' || m === 'broadcast';
const isPlayer = (p: unknown): p is string => typeof p === 'string' && /^[a-z0-9]{16,32}$/.test(p);

async function board(store: Store, mode: BoardMode, player?: string) {
  const [flat, rank, score] = await store.run([
    ['ZRANGE', KEY(mode), 0, TUNING.leaderboard.top - 1, 'REV', 'WITHSCORES'],
    ['ZREVRANK', KEY(mode), player ?? '-'],
    ['ZSCORE', KEY(mode), player ?? '-'],
  ]);
  const rows = flat as string[];
  const ids = rows.filter((_, i) => i % 2 === 0);
  const names = ids.length ? ((await store.run([['HMGET', NAMES, ...ids]]))[0] as (string | null)[]) : [];
  const top = ids.map((id, i) => ({ rank: i + 1, name: names[i] ?? '—', score: Number(rows[i * 2 + 1]), you: id === player }));
  const you = player && rank !== null && rank !== undefined ? { rank: Number(rank) + 1, score: Number(score) } : null;
  return { top, you };
}

export async function handle(store: Store | null, method: string, query: Record<string, unknown>, body: unknown, ip: string, now = Date.now()): Promise<Reply> {
  if (!store) return { status: 503, body: { error: 'leaderboard not configured' } };
  if (method === 'GET') {
    const mode = query.mode;
    if (!isMode(mode)) return { status: 400, body: { error: 'mode' } };
    const player = isPlayer(query.player) ? query.player : undefined;
    return { status: 200, body: await board(store, mode, player) };
  }
  if (method !== 'POST') return { status: 405, body: { error: 'method' } };

  const rl = `wyf:rl:${ip}:${Math.floor(now / 60000)}`;
  const [count] = await store.run([['INCR', rl], ['EXPIRE', rl, 120]]);
  if (Number(count) > TUNING.leaderboard.perMinute) return { status: 429, body: { error: 'slow down' } };

  const b = (typeof body === 'string' ? safeJson(body) : body) as Partial<Submission & { player: string; name: string }> | null;
  if (!b || typeof b !== 'object') return { status: 400, body: { error: 'body' } };
  if (!isPlayer(b.player)) return { status: 400, body: { error: 'player' } };
  const name = cleanName(b.name);
  if (!name) return { status: 400, body: { error: 'name' } };
  if (!isMode(b.mode)) return { status: 400, body: { error: 'mode' } };
  const res = verify(b as Submission);
  if (!res.ok) return { status: 422, body: { error: res.error } };
  const claimed = Number(b.claimed);
  if (!(Math.abs(res.score - claimed) <= Math.max(1, claimed * TUNING.leaderboard.tolerance))) {
    // Counted so a real cross-browser divergence would show up, not just be refused.
    await store.run([['INCR', 'wyf:lb:mismatch']]);
    return { status: 422, body: { error: 'mismatch', score: res.score } };
  }
  await store.run([
    ['ZADD', KEY(b.mode), 'GT', 'CH', res.score, b.player],
    ['HSET', NAMES, b.player, name],
  ]);
  const out = await board(store, b.mode, b.player);
  return { status: 200, body: { ok: true, score: res.score, won: res.won, best: out.you?.score ?? res.score, rank: out.you?.rank ?? null, top: out.top } };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
