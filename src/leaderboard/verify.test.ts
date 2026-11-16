import { describe, expect, it } from 'vitest';
import { Sim } from '../sim/sim';
import { Bot } from '../sim/bot';
import { RunState } from '../sim/run';
import type { SimInput } from '../sim/types';
import type { UpgradeId } from '../tuning';
import { cleanName, decodeInputs, encodeInputs, verify, type Submission } from './verify';
import { handle, memoryStore } from '../../server/leaderboard';

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

function botRun(seed: number): Submission {
  const run = new RunState(seed);
  const segments: string[] = [];
  const buys: (UpgradeId | null)[] = [];
  while (run.phase === 'live') {
    const sim = new Sim({ seed: run.segmentSeed(), segment: run.segment, upgrades: run.owned, growth: true });
    segments.push(encodeInputs(playLogged(sim)));
    run.finishSegment(sim.show);
    if ((run.phase as string) === 'meeting') {
      const pick = run.offers().find((u) => run.canAfford(u)) ?? null;
      buys.push(pick);
      if (pick) run.buy(pick);
      else run.nextSegment();
    }
  }
  return { mode: 'run', seed, growth: true, segments, buys, claimed: Math.round(run.earned) };
}

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
  it('stores the verified best per player and ranks it', async () => {
    const store = memoryStore();
    const sub = botRun(81);
    const post = await handle(store, 'POST', {}, { ...sub, player, name: 'Tester' }, '1.1.1.1');
    expect(post.status).toBe(200);
    expect(post.body).toMatchObject({ ok: true, score: sub.claimed, rank: 1 });
    const other = await handle(store, 'POST', {}, { ...botRun(82), player: 'fedcba9876543210', name: 'Other' }, '1.1.1.2');
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
    const sub = botRun(83);
    const r = await handle(store, 'POST', {}, { ...sub, claimed: sub.claimed * 2, player, name: 'Cheat' }, '1.1.1.1');
    expect(r.status).toBe(422);
    expect((await store.run([['INCR', 'wyf:lb:mismatch']]))[0]).toBe(2);
  });

  it('rate-limits, and says when it is not configured', async () => {
    const store = memoryStore();
    for (let i = 0; i < 12; i++) await handle(store, 'POST', {}, {}, '9.9.9.9', 0);
    expect((await handle(store, 'POST', {}, {}, '9.9.9.9', 0)).status).toBe(429);
    expect((await handle(null, 'GET', { mode: 'run' }, null, '1')).status).toBe(503);
  });
});
