import { describe, expect, it } from 'vitest';
import { TUNING, enableProto } from '../tuning';
import { Sim } from '../sim/sim';
import { Bot } from '../sim/bot';
import { RunState } from '../sim/run';
import type { SimInput } from '../sim/types';
import { encodeInputs, verify } from './verify';

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
});
