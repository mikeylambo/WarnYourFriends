import { describe, expect, it } from 'vitest';
import { TUNING, enableProto } from '../tuning';
import { Sim } from '../sim/sim';
import { Bot } from '../sim/bot';
import { RunState } from '../sim/run';
import type { SimInput } from '../sim/types';
import { dailyDay, dailySeed, encodeInputs, verify } from './verify';
import { handle, memoryStore } from '../../server/leaderboard';

// The pivot loop is the game (2026-11-24): the server runs enableProto() and re-plays Story and Endless.
enableProto();

function playLogged(sim: Sim): SimInput[] {
  const bot = new Bot(sim);
  const log: SimInput[] = [];
  for (let i = 0; i < 75000 && sim.live; i++) {
    const inp = bot.input();
    log.push(inp);
    sim.step(inp);
  }
  for (let i = 0; i < 90; i++) log.push({ lane: 0, brake: false, shoulder: false });
  return log;
}

describe('leaderboard under the pivot loop', () => {
  it('Story with asks and a traffic mod verifies to the same score', () => {
    const asks = TUNING.proto.storyAsks.slice(0, 3).map((a) => a.id);
    const mods = Object.keys(TUNING.proto.mods).slice(0, 1);
    const run = new RunState(41, undefined, 0);
    const sim = new Sim({ seed: run.segmentSeed(), segment: 0, upgrades: [], levels: {}, growth: true, edition: 0, asks, mods });
    const seg = encodeInputs(playLogged(sim));
    run.finishSegment(sim.show);
    const r = verify({ mode: 'run', seed: 41, growth: true, segments: [seg], buys: [], asks, mods, claimed: Math.round(run.earned) });
    expect(r).toMatchObject({ ok: true, score: Math.round(run.earned) });
    // Dropping the mod changes the replay: the board scores what the sim says.
    const r2 = verify({ mode: 'run', seed: 41, growth: true, segments: [seg], buys: [], asks, claimed: 0 });
    expect(r2.ok && r2.score).not.toBe(Math.round(run.earned));
  }, 60_000);
  it('Endless verifies, and runs longer than one classic segment fit', () => {
    const sim = new Sim({ seed: 205, growth: true, endless: true });
    const log = playLogged(sim);
    expect(sim.live).toBe(false);
    const r = verify({ mode: 'endless', seed: 205, growth: true, segments: [encodeInputs(log)], buys: [], claimed: Math.round(sim.show.banked) });
    expect(r).toMatchObject({ ok: true, score: Math.round(sim.show.banked) });
  }, 60_000);

  it('Daily: one road per UTC day, no ticket, today or yesterday only, its own board', async () => {
    const now = Date.UTC(2026, 10, 24, 12);
    const day = dailyDay(now);
    expect(dailySeed(day)).toBe(dailySeed(day));
    expect(dailySeed(day)).not.toBe(dailySeed(day + 1));
    const sim = new Sim({ seed: dailySeed(day), growth: true, endless: true });
    const seg = encodeInputs(playLogged(sim));
    const sub = { mode: 'daily' as const, day, seed: dailySeed(day), growth: true, segments: [seg], buys: [], claimed: Math.round(sim.show.banked) };
    expect(verify({ ...sub, seed: 12345 })).toEqual({ ok: false, error: 'seed' });
    const store = memoryStore();
    const id = { player: '0123456789abcdef', secret: 'secretsecretsecretsecret01', name: 'Daily' };
    const post = await handle(store, 'POST', {}, { ...sub, ...id }, '1.1.1.1', now);
    expect(post.status).toBe(200);
    expect((await handle(store, 'POST', {}, { ...sub, ...id }, '1.1.1.1', now + 86_400_000)).status).toBe(200); // past midnight: yesterday's still posts
    expect((await handle(store, 'POST', {}, { ...sub, ...id }, '1.1.1.1', now + 2 * 86_400_000)).body).toEqual({ error: 'day' });
    const today = await handle(store, 'GET', { mode: 'daily', player: id.player }, null, '1.1.1.1', now);
    expect((today.body as { top: unknown[] }).top.length).toBe(1);
    const tomorrow = await handle(store, 'GET', { mode: 'daily', player: id.player }, null, '1.1.1.1', now + 86_400_000);
    expect((tomorrow.body as { top: unknown[] }).top.length).toBe(0);
    const endless = await handle(store, 'GET', { mode: 'endless', player: id.player }, null, '1.1.1.1', now);
    expect((endless.body as { top: unknown[] }).top.length).toBe(0);
  }, 60_000);
});
