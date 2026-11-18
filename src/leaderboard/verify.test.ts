import { describe, expect, it } from 'vitest';
import { Sim } from '../sim/sim';
import { Bot } from '../sim/bot';
import { RunState } from '../sim/run';
import type { SimInput } from '../sim/types';
import type { UpgradeId } from '../tuning';
import { cleanName, dailySeed, dayKey, decodeInputs, encodeInputs, verify, type Submission } from './verify';
import { handle, memoryStore, ticketKey } from '../../server/leaderboard';

/** Play a segment with the bot the way the game does: every step's input logged, plus a short outro. */
function playLogged(sim: Sim): SimInput[] {
  const bot = new Bot(sim);
  const log: SimInput[] = [];
  for (let i = 0; i < 12000 && sim.live; i++) {
    const inp = bot.input();
    log.push(inp);
    sim.step(inp);
  }
  for (let i = 0; i < 90; i++) log.push({ lane: 0, brake: false, shoulder: false });
  return log;
}

function botRun(seed: number, pool?: UpgradeId[]): Submission {
  const run = new RunState(seed, pool);
  const segments: string[] = [];
  const buys: UpgradeId[][] = [];
  while (run.phase === 'live') {
    const sim = new Sim({ seed: run.segmentSeed(), segment: run.segment, upgrades: run.owned, levels: run.levels, growth: true });
    segments.push(encodeInputs(playLogged(sim)));
    run.finishSegment(sim.show);
    if ((run.phase as string) === 'meeting') {
      // Buy what the budget allows (the meeting stays open), then go live.
      const got: UpgradeId[] = [];
      for (const u of run.offers()) if (run.canAfford(u) && run.buy(u)) got.push(u);
      buys.push(got);
      run.nextSegment();
    }
  }
  return { mode: 'run', seed, growth: true, segments, buys, claimed: Math.round(run.earned), ...(pool ? { pool } : {}) };
}

describe('leaderboard: editions and the second ability (2026-11-17)', () => {
  it('round-trips the second ability button', () => {
    const log: SimInput[] = [{ lane: 0, brake: false, shoulder: false, ability2: true }, { lane: 1, brake: true, shoulder: true, ability: true, ability2: true }, { lane: 0, brake: false, shoulder: false }];
    const back = decodeInputs(encodeInputs(log))!;
    expect(back.map((b) => !!b.ability2)).toEqual([true, true, false]);
    expect(back[1].lane).toBe(1);
  });
});

describe('leaderboard inputs', () => {
  it('round-trips every input combination', () => {
    const log: SimInput[] = [];
    for (const lane of [-1, 0, 1]) for (const brake of [false, true]) for (const shoulder of [false, true]) for (const ability of [false, true]) for (let k = 0; k < 1 + lane + 2; k++) log.push({ lane, brake, shoulder, ability });
    const back = decodeInputs(encodeInputs(log))!;
    expect(back.length).toBe(log.length);
    back.forEach((b, i) => expect([b.lane, b.brake, b.shoulder, !!b.ability]).toEqual([log[i].lane, log[i].brake, log[i].shoulder, !!log[i].ability]));
  });

  it('refuses malformed or oversized input strings', () => {
    expect(decodeInputs('a3z')).toBeNull();
    expect(decodeInputs('a99999999')).toBeNull();
    expect(decodeInputs('')).toEqual([]);
  });
});

describe('leaderboard verify', () => {
  it('re-simulates a Single Segment to the same score', () => {
    const sim = new Sim({ seed: 4242, segment: 0, upgrades: [], growth: true });
    const segments = [encodeInputs(playLogged(sim))];
    const r = verify({ mode: 'broadcast', seed: 4242, growth: true, segments, buys: [], claimed: sim.show.banked });
    expect(r).toEqual({ ok: true, score: Math.round(sim.show.banked), segments: 1, won: sim.show.state === 'cleared' });
  });

  it('re-simulates a Full Broadcast, meetings included, to the same score', () => {
    const sub = botRun(77);
    const r = verify(sub);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.score).toBe(sub.claimed);
      expect(r.segments).toBe(sub.segments.length);
    }
  });

  it('a run played with locked upgrades replays with the same pool (Awards)', () => {
    const pool: UpgradeId[] = ['leap', 'stare', 'primeTime', 'thickSkin', 'secondWind', 'crowdPleaser'];
    const sub = botRun(84, pool);
    const r = verify(sub);
    expect(r.ok && r.score).toBe(sub.claimed);
  });

  it('a different seed, or tampered inputs, give a different score', () => {
    const sub = botRun(78);
    const other = verify({ ...sub, seed: 79 });
    expect(other.ok && other.score === sub.claimed).toBe(false);
  });

  it('refuses a run that never finished', () => {
    const sub = botRun(80);
    const cut = { ...sub, segments: [sub.segments[0].slice(0, 40)] };
    expect(verify(cut)).toEqual({ ok: false, error: 'unfinished' });
  });

  it('cleans names', () => {
    expect(cleanName('  Giant   Fan ')).toBe('Giant Fan');
    expect(cleanName('x')).toBeNull();
    expect(cleanName('<script>')).toBeNull();
    expect(cleanName('a'.repeat(15))).toBeNull();
    expect(cleanName('Sh1t.Fu-ck')).toBeNull();
    expect(cleanName('B1G-STOMP_99')).toBe('B1G-STOMP_99');
  });
});

describe('leaderboard API', () => {
  const player = 'abcdef0123456789';
  const secret = 'secretsecretsecretsecret01';
  /** A submission on a road the server issued to `who`. */
  const issued = async <S extends { seed: number }>(store: ReturnType<typeof memoryStore>, who: string, sub: S): Promise<S> => {
    await store.run([['SET', ticketKey(who, sub.seed), 1]]);
    return sub;
  };
  it('stores the verified best per player and ranks it', async () => {
    const store = memoryStore();
    const sub = await issued(store, player, botRun(81));
    const post = await handle(store, 'POST', {}, { ...sub, player, secret, name: 'Tester' }, '1.1.1.1');
    expect(post.status).toBe(200);
    expect(post.body).toMatchObject({ ok: true, score: sub.claimed, rank: 1 });
    const other = await handle(store, 'POST', {}, { ...(await issued(store, 'fedcba9876543210', botRun(82))), player: 'fedcba9876543210', secret: 'othersecretothersecret0123', name: 'Other' }, '1.1.1.2');
    expect(other.status).toBe(200);
    const get = await handle(store, 'GET', { mode: 'run', player }, null, '1.1.1.1');
    const body = get.body as { top: { name: string; score: number; you: boolean }[]; you: { rank: number } };
    expect(body.top.length).toBe(2);
    expect(body.top[0].score).toBeGreaterThanOrEqual(body.top[1].score);
    expect(body.top.find((r) => r.you)?.name).toBe('Tester');
    expect(body.you.rank).toBeGreaterThan(0);
  });

  it('refuses an inflated claim, and counts it', async () => {
    const store = memoryStore();
    const sub = await issued(store, player, botRun(83));
    const r = await handle(store, 'POST', {}, { ...sub, claimed: sub.claimed * 2, player, secret, name: 'Cheat' }, '1.1.1.1');
    expect(r.status).toBe(422);
    expect((await store.run([['INCR', 'wyf:lb:mismatch']]))[0]).toBe(2);
  });

  it('only ranks roads it issued, to the player it issued them to', async () => {
    const store = memoryStore();
    const t = await handle(store, 'GET', { ticket: '1', player }, null, '1.1.1.1');
    expect(t.status).toBe(200);
    const seed = (t.body as { seed: number }).seed;
    expect((await store.run([['EXISTS', ticketKey(player, seed)]]))[0]).toBe(1);
    const sub = botRun(84);
    expect((await handle(store, 'POST', {}, { ...sub, player, secret, name: 'Picker' }, '1.1.1.1')).body).toEqual({ error: 'seed' });
    await issued(store, 'fedcba9876543210', sub);
    expect((await handle(store, 'POST', {}, { ...sub, player, secret, name: 'Picker' }, '1.1.1.1')).body).toEqual({ error: 'seed' });
  });

  it('lets only the first secret post for a player id', async () => {
    const store = memoryStore();
    const sub = await issued(store, player, botRun(85));
    expect((await handle(store, 'POST', {}, { ...sub, player, secret, name: 'Owner' }, '1.1.1.1')).status).toBe(200);
    const r = await handle(store, 'POST', {}, { ...sub, player, secret: 'impostorimpostorimpostor00', name: 'Impostor' }, '1.1.1.2');
    expect(r.status).toBe(403);
    expect((await handle(store, 'POST', {}, { ...sub, player, name: 'NoKey' }, '1.1.1.3')).status).toBe(400);
  });

  it('refuses a pool missing base upgrades, and ranks the guided broadcast once', async () => {
    const store = memoryStore();
    const sub = await issued(store, player, botRun(86));
    expect((await handle(store, 'POST', {}, { ...sub, pool: ['leap'], player, secret, name: 'Thin' }, '1.1.1.1')).body).toEqual({ error: 'pool' });
    await store.run([['HSETNX', 'wyf:lb:guided', player, 1]]);
    expect((await handle(store, 'POST', {}, { ...sub, guided: true, player, secret, name: 'Again' }, '1.1.1.1')).body).toEqual({ error: 'guided' });
  });

  it('rate-limits, and says when it is not configured', async () => {
    const store = memoryStore();
    for (let i = 0; i < 12; i++) await handle(store, 'POST', {}, {}, '9.9.9.9', 0);
    expect((await handle(store, 'POST', {}, {}, '9.9.9.9', 0)).status).toBe(429);
    expect((await handle(null, 'GET', { mode: 'run' }, null, '1')).status).toBe(503);
  });

  it('ranks the Daily Broadcast on its own board for the day, with no ticket', async () => {
    const store = memoryStore();
    const now = Date.UTC(2026, 10, 18, 12);
    const day = dayKey(now);
    expect(day).toBe('2026-11-18');
    expect(dailySeed(day)).toBe(dailySeed('2026-11-18'));
    expect(dailySeed(day)).not.toBe(dailySeed('2026-11-19'));
    const sub = { ...botRun(dailySeed(day)), mode: 'daily' as const };
    const post = await handle(store, 'POST', {}, { ...sub, player, secret, name: 'Tester' }, '1.1.1.1', now);
    expect(post.status).toBe(200);
    // Still open just after midnight UTC (a run that started yesterday); gone the day after.
    const late = await handle(store, 'GET', { mode: 'daily', day, player }, null, '1', now + 13 * 3600_000);
    expect((late.body as { you: { rank: number } }).you.rank).toBe(1);
    const tomorrow = await handle(store, 'GET', { mode: 'daily', player }, null, '1', now + 86_400_000);
    expect((tomorrow.body as { top: unknown[] }).top.length).toBe(0);
    // Any other road, or a harder edition, is refused; the daily score never lands on the run board.
    expect((await handle(store, 'POST', {}, { ...sub, seed: sub.seed + 1, player, secret, name: 'Tester' }, '1.1.1.3', now)).status).toBe(422);
    expect((await handle(store, 'POST', {}, { ...sub, edition: 1, player, secret, name: 'Tester' }, '1.1.1.4', now)).status).toBe(422);
    expect(((await handle(store, 'GET', { mode: 'run', player }, null, '1', now)).body as { top: unknown[] }).top.length).toBe(0);
  });
});
