import { handle, redisFromEnv } from './leaderboard';

/** Vercel Node function entry (bundled to api/leaderboard.js by tools/build-api.mjs). */
interface Req {
  method?: string;
  query?: Record<string, unknown>;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}
interface Res {
  status(code: number): Res;
  setHeader(k: string, v: string): void;
  json(body: unknown): void;
}

const store = redisFromEnv(process.env);

export default async function leaderboard(req: Req, res: Res) {
  const fwd = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  try {
    const r = await handle(store, req.method ?? 'GET', req.query ?? {}, req.body, ip);
    res.setHeader('Cache-Control', req.method === 'GET' ? 'public, s-maxage=10, stale-while-revalidate=30' : 'no-store');
    res.status(r.status).json(r.body);
  } catch (e) {
    console.error('leaderboard', e);
    res.status(500).json({ error: 'server' });
  }
}
