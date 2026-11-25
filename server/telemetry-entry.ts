import { redisFromEnv } from './leaderboard';
import { telemetry } from './telemetry';

/** Vercel Node function entry (bundled to api/telemetry.js by tools/build-api.mjs). */
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
  end(): void;
}

const store = redisFromEnv(process.env);

export default async function handler(req: Req, res: Res) {
  const fwd = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
  const given = req.headers['x-admin-key'];
  try {
    const r = await telemetry(store, req.method ?? 'GET', req.query ?? {}, req.body, ip, process.env.LB_ADMIN_KEY, Array.isArray(given) ? given[0] : given);
    res.setHeader('Cache-Control', 'no-store');
    if (r.status === 204) res.status(204).end();
    else res.status(r.status).json(r.body);
  } catch (e) {
    console.error('telemetry', e);
    res.status(500).json({ error: 'server' });
  }
}
