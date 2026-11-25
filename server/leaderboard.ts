import { createHash, randomInt } from 'node:crypto';
import { TUNING } from '../src/tuning';
import { LOCKED_UPGRADES } from '../src/awards';
import { ALL_UPGRADES } from '../src/sim/run';
import { cleanName, dailyDay, verify, type BoardMode, type Submission } from '../src/leaderboard/verify';

/**
 * Leaderboard API (bundled to api/leaderboard.js by tools/build-api.mjs).
 *   GET  /api/leaderboard?mode=run|broadcast[&player=id]  → { top: [{ rank, name, score }], you?: { rank, score } }
 *   GET  /api/leaderboard?ticket=1&player=id  → { seed }: a road issued to this player (only issued roads rank)
 *   POST /api/leaderboard  { player, secret, name, ...Submission }  → { ok, score, rank, best }
 * A player id is owned by the first secret that posts for it (later posts must carry the same one).
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
          case 'HINCRBY': {
            const v = Number(hash(k).get(String(a[1])) ?? 0) + Number(a[2]);
            hash(k).set(String(a[1]), String(v));
            return v;
          }
          case 'HGETALL':
            return [...hash(k)].flat();
          case 'ZREM':
            return zset(k).delete(String(a[1])) ? 1 : 0;
          case 'HDEL':
            return hash(k).delete(String(a[1])) ? 1 : 0;
          case 'HMGET':
            return a.slice(1).map((f) => hash(k).get(String(f)) ?? null);
          case 'INCR':
            n.set(k, (n.get(k) ?? 0) + 1);
            return n.get(k);
          case 'EXPIRE':
            return 1;
          case 'SET':
            hash('__kv').set(k, String(a[1]));
            return 'OK';
          case 'EXISTS':
            return hash('__kv').has(k) ? 1 : 0;
          case 'HSETNX': {
            if (hash(k).has(String(a[1]))) return 0;
            hash(k).set(String(a[1]), String(a[2]));
            return 1;
          }
          case 'HGET':
            return hash(k).get(String(a[1])) ?? null;
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
const KEY = (mode: BoardMode, day?: number) =>
  mode === 'daily' ? `wyf:lb:s${TUNING.leaderboard.season}:daily:${day}` : TUNING.leaderboard.season > 1 ? `wyf:lb:s${TUNING.leaderboard.season}:${mode}` : `wyf:lb:${mode}`;
const NAMES = 'wyf:lb:names';
const isMode = (m: unknown): m is BoardMode => m === 'run' || m === 'broadcast' || m === 'endless' || m === 'daily';
const isPlayer = (p: unknown): p is string => typeof p === 'string' && /^[a-z0-9]{16,32}$/.test(p);
const isSecret = (s: unknown): s is string => typeof s === 'string' && /^[a-z0-9]{24,64}$/.test(s);
const OWNERS = 'wyf:lb:owner';
const GUIDED = 'wyf:lb:guided';
/** The key that marks `seed` as issued to `player` (exported for tests). */
export const ticketKey = (player: string, seed: number) => `wyf:lb:t:${player}:${seed}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** Upgrades every pool has (the rest are Awards unlocks). */
const BASE_POOL = ALL_UPGRADES.filter((u) => !LOCKED_UPGRADES.includes(u));

async function board(store: Store, mode: BoardMode, player?: string, day?: number) {
  const [flat, rank, score] = await store.run([
    ['ZRANGE', KEY(mode, day), 0, TUNING.leaderboard.top - 1, 'REV', 'WITHSCORES'],
    ['ZREVRANK', KEY(mode, day), player ?? '-'],
    ['ZSCORE', KEY(mode, day), player ?? '-'],
  ]);
  const rows = flat as string[];
  const ids = rows.filter((_, i) => i % 2 === 0);
  const names = ids.length ? ((await store.run([['HMGET', NAMES, ...ids]]))[0] as (string | null)[]) : [];
  const top = ids.map((id, i) => ({ rank: i + 1, name: names[i] ?? '—', score: Number(rows[i * 2 + 1]), you: id === player }));
  const you = player && rank !== null && rank !== undefined ? { rank: Number(rank) + 1, score: Number(score) } : null;
  return { top, you };
}

const BANNED = 'wyf:lb:banned';
const ALL_MODES: BoardMode[] = ['run', 'broadcast', 'endless', 'daily'];

/**
 * Moderation (2026-11-24): POST { admin, action: 'ban' | 'unban' | 'rename', player, name? } with the LB_ADMIN_KEY
 * env secret (never in the client). Ban removes the player from every board (today's daily too) and refuses their posts.
 */
async function moderate(store: Store, b: Record<string, unknown>, adminKey: string | undefined, now: number): Promise<Reply> {
  if (!adminKey || typeof b.admin !== 'string' || sha(b.admin) !== sha(adminKey)) return { status: 403, body: { error: 'admin' } };
  if (!isPlayer(b.player)) return { status: 400, body: { error: 'player' } };
  const p = b.player;
  if (b.action === 'ban') {
    const day = dailyDay(now);
    await store.run([['HSET', BANNED, p, now], ...ALL_MODES.filter((m) => m !== 'daily').map((m) => ['ZREM', KEY(m), p]), ['ZREM', KEY('daily', day), p], ['ZREM', KEY('daily', day - 1), p], ['HSET', NAMES, p, '—']]);
    return { status: 200, body: { ok: true, banned: p } };
  }
  if (b.action === 'unban') {
    await store.run([['HDEL', BANNED, p]]);
    return { status: 200, body: { ok: true } };
  }
  if (b.action === 'rename') {
    const name = cleanName(b.name);
    if (!name) return { status: 400, body: { error: 'name' } };
    await store.run([['HSET', NAMES, p, name]]);
    return { status: 200, body: { ok: true } };
  }
  return { status: 400, body: { error: 'action' } };
}

export async function handle(store: Store | null, method: string, query: Record<string, unknown>, body: unknown, ip: string, now = Date.now(), adminKey?: string): Promise<Reply> {
  if (!store) return { status: 503, body: { error: 'leaderboard not configured' } };
  if (method === 'GET' && query.ticket !== undefined) {
    // A road for the next broadcast, issued to this player. Run Again on it ranks; a seed chosen by hand doesn't.
    if (!isPlayer(query.player)) return { status: 400, body: { error: 'player' } };
    const rl = `wyf:rl:t:${query.player}:${Math.floor(now / 60000)}`;
    const [count] = await store.run([['INCR', rl], ['EXPIRE', rl, 120]]);
    if (Number(count) > TUNING.leaderboard.ticketsPerMinute) return { status: 429, body: { error: 'slow down' } };
    const seed = randomInt(1, 1e9);
    await store.run([['SET', ticketKey(query.player, seed), 1, 'EX', TUNING.leaderboard.ticketTtl]]);
    return { status: 200, body: { seed } };
  }
  if (method === 'GET') {
    const mode = query.mode;
    if (!isMode(mode)) return { status: 400, body: { error: 'mode' } };
    const player = isPlayer(query.player) ? query.player : undefined;
    const day = mode === 'daily' ? (Number.isSafeInteger(Number(query.day)) && query.day !== undefined ? Number(query.day) : dailyDay(now)) : undefined;
    return { status: 200, body: await board(store, mode, player, day) };
  }
  if (method !== 'POST') return { status: 405, body: { error: 'method' } };

  const rl = `wyf:rl:${ip}:${Math.floor(now / 60000)}`;
  const [count] = await store.run([['INCR', rl], ['EXPIRE', rl, 120]]);
  if (Number(count) > TUNING.leaderboard.perMinute) return { status: 429, body: { error: 'slow down' } };
  const all = `wyf:rl:all:${Math.floor(now / 60000)}`;
  const [total] = await store.run([['INCR', all], ['EXPIRE', all, 120]]);
  if (Number(total) > TUNING.leaderboard.perMinuteAll) return { status: 429, body: { error: 'busy' } };

  const b = (typeof body === 'string' ? safeJson(body) : body) as Partial<Submission & { player: string; name: string }> | null;
  if (!b || typeof b !== 'object') return { status: 400, body: { error: 'body' } };
  if ((b as Record<string, unknown>).admin !== undefined) return moderate(store, b as Record<string, unknown>, adminKey, now);
  if (!isPlayer(b.player)) return { status: 400, body: { error: 'player' } };
  // Per player too (an IP can be shared, a player id can hop IPs).
  const prl = `wyf:rl:p:${b.player}:${Math.floor(now / 60000)}`;
  const [pcount] = await store.run([['INCR', prl], ['EXPIRE', prl, 120]]);
  if (Number(pcount) > TUNING.leaderboard.perPlayerMinute) return { status: 429, body: { error: 'slow down' } };
  if ((await store.run([['HGET', BANNED, b.player]]))[0]) return { status: 403, body: { error: 'banned' } };
  const name = cleanName(b.name);
  if (!name) return { status: 400, body: { error: 'name' } };
  if (!isMode(b.mode)) return { status: 400, body: { error: 'mode' } };
  // Ownership: the first secret to post for a player id owns it (nobody else can post as them or rename them).
  const secret = (b as { secret?: unknown }).secret;
  if (!isSecret(secret)) return { status: 400, body: { error: 'secret' } };
  await store.run([['HSETNX', OWNERS, b.player, sha(secret)]]);
  const [owner] = await store.run([['HGET', OWNERS, b.player]]);
  if (owner !== sha(secret)) return { status: 403, body: { error: 'player' } };
  // Ranked rules: the road was issued to this player; the pool has every base upgrade.
  // Daily: today's road (or yesterday's, for a run that crossed midnight UTC), the same for everyone; no ticket.
  const today = dailyDay(now);
  if (b.mode === 'daily') {
    if (b.day !== today && b.day !== today - 1) return { status: 422, body: { error: 'day' } };
  } else if (!Number.isSafeInteger(b.seed) || !(await store.run([['EXISTS', ticketKey(b.player, b.seed as number)]]))[0]) return { status: 422, body: { error: 'seed' } };
  if (Array.isArray(b.pool) && !BASE_POOL.every((u) => (b.pool as string[]).includes(u))) return { status: 422, body: { error: 'pool' } };
  // The guided (calmer) first broadcast ranks once per player (checked before the costly re-play).
  if (b.guided && (await store.run([['HGET', GUIDED, b.player]]))[0]) return { status: 422, body: { error: 'guided' } };
  const res = verify(b as Submission);
  if (!res.ok) return { status: 422, body: { error: res.error } };
  const claimed = Number(b.claimed);
  if (!(Math.abs(res.score - claimed) <= Math.max(1, claimed * TUNING.leaderboard.tolerance))) {
    // Counted so a real cross-browser divergence would show up, not just be refused.
    await store.run([['INCR', 'wyf:lb:mismatch']]);
    return { status: 422, body: { error: 'mismatch', score: res.score } };
  }
  if (b.guided) await store.run([['HSETNX', GUIDED, b.player, 1]]);
  const day = b.mode === 'daily' ? (b.day as number) : undefined;
  await store.run([
    ['ZADD', KEY(b.mode, day), 'GT', 'CH', res.score, b.player],
    ['HSET', NAMES, b.player, name],
    ...(day !== undefined ? [['EXPIRE', KEY(b.mode, day), TUNING.leaderboard.dailyKeep]] : []),
  ]);
  const out = await board(store, b.mode, b.player, day);
  return { status: 200, body: { ok: true, score: res.score, won: res.won, best: out.you?.score ?? res.score, rank: out.you?.rank ?? null, top: out.top } };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
