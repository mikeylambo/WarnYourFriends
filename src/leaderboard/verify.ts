import { Sim } from '../sim/sim';
import { ALL_UPGRADES, RunState } from '../sim/run';
import { NO_INPUT, type SimInput } from '../sim/types';
import { TUNING, type UpgradeId } from '../tuning';

/**
 * Leaderboard (§29 "shared leaderboard server-side"). The sim is deterministic for
 * (seed, segment, upgrades, inputs), so a score is checked by playing the inputs again
 * on the server: the board records what the sim says, never what the client says.
 * Pure: no DOM, no network. Shared by the game (encode) and the API (decode + verify).
 */

export type BoardMode = 'run' | 'broadcast';

export interface Submission {
  mode: BoardMode;
  seed: number;
  /** Giant size setting (TUNING.growth): growth on, or the fixed giant. */
  growth: boolean;
  /** Each segment's inputs, run-length encoded (encodeInputs). Single Segment: one. */
  segments: string[];
  /** Full Broadcast: what was bought at each meeting (null = walked out). */
  buys: (UpgradeId | null)[];
  /** The upgrades this player could be offered (Awards unlock the rest); absent = all. Must match the client's run. */
  pool?: UpgradeId[];
  /** The score the client showed; only compared, never stored. */
  claimed: number;
}

/** 3 lane × 2 brake × 2 shoulder × 2 ability = 24 symbols, one letter each. */
const sym = (i: SimInput) => (Math.sign(i.lane) + 1) * 8 + (i.brake ? 4 : 0) + (i.shoulder ? 2 : 0) + (i.ability ? 1 : 0);
const A = 'a'.charCodeAt(0);

/** Run-length encode an input log: a letter per input, then its repeat count when > 1 ("a3600e2a…"). */
export function encodeInputs(log: readonly SimInput[]): string {
  let out = '';
  for (let i = 0; i < log.length; ) {
    const s = sym(log[i]);
    let n = 1;
    while (i + n < log.length && sym(log[i + n]) === s) n++;
    out += String.fromCharCode(A + s) + (n > 1 ? n : '');
    i += n;
  }
  return out;
}

/** Decode encodeInputs; null when malformed or longer than `max` inputs. */
export function decodeInputs(str: string, max: number = TUNING.leaderboard.maxTicks): SimInput[] | null {
  if (!/^([a-x]\d*)*$/.test(str)) return null;
  const out: SimInput[] = [];
  for (const m of str.matchAll(/([a-x])(\d*)/g)) {
    const s = m[1].charCodeAt(0) - A;
    const n = m[2] ? Number(m[2]) : 1;
    if (!Number.isSafeInteger(n) || n < 1 || out.length + n > max) return null;
    const inp: SimInput = { lane: Math.floor(s / 8) - 1, brake: !!(s & 4), shoulder: !!(s & 2), ability: !!(s & 1) };
    for (let k = 0; k < n; k++) out.push(inp);
  }
  return out;
}

export type VerifyResult = { ok: true; score: number; segments: number; won: boolean } | { ok: false; error: string };

/** Play one segment's inputs; the sim must have finished (cleared or busted) by the end of them. */
function playSegment(sim: Sim, inputs: SimInput[]): boolean {
  for (const inp of inputs) {
    if (!sim.live) break;
    sim.step(inp);
  }
  return !sim.live;
}

/** Re-simulate a submission and return the score the sim gives it. */
export function verify(sub: Submission): VerifyResult {
  if (sub.mode !== 'run' && sub.mode !== 'broadcast') return { ok: false, error: 'mode' };
  if (!Number.isSafeInteger(sub.seed)) return { ok: false, error: 'seed' };
  if (!Array.isArray(sub.segments) || !sub.segments.length || sub.segments.length > TUNING.run.segments) return { ok: false, error: 'segments' };
  const logs = sub.segments.map((s) => (typeof s === 'string' ? decodeInputs(s) : null));
  if (logs.some((l) => !l)) return { ok: false, error: 'inputs' };

  if (sub.mode === 'broadcast') {
    if (logs.length !== 1) return { ok: false, error: 'segments' };
    const sim = new Sim({ seed: sub.seed, segment: 0, upgrades: [], growth: !!sub.growth });
    if (!playSegment(sim, logs[0]!)) return { ok: false, error: 'unfinished' };
    return { ok: true, score: Math.round(sim.show.banked), segments: 1, won: sim.show.state === 'cleared' };
  }

  const pool = Array.isArray(sub.pool) ? sub.pool.filter((u) => (ALL_UPGRADES as string[]).includes(u)) : ALL_UPGRADES;
  const run = new RunState(sub.seed, pool);
  const buys = Array.isArray(sub.buys) ? sub.buys : [];
  for (let i = 0; i < logs.length; i++) {
    if (run.phase !== 'live') return { ok: false, error: 'segments' };
    const sim = new Sim({ seed: run.segmentSeed(), segment: run.segment, upgrades: run.owned, levels: run.levels, growth: !!sub.growth });
    if (!playSegment(sim, logs[i]!)) return { ok: false, error: 'unfinished' };
    run.finishSegment(sim.show);
    if ((run.phase as string) === 'meeting') {
      const b = buys[i] ?? null;
      if (b !== null && !run.buy(b)) return { ok: false, error: 'buy' };
      if (b === null) run.nextSegment();
    }
  }
  // A run on the board is a finished one: won, or busted.
  if (run.phase !== 'won' && run.phase !== 'lost') return { ok: false, error: 'unfinished' };
  return { ok: true, score: Math.round(run.earned), segments: run.results.length, won: run.phase === 'won' };
}

/** Names on the board: 2–14 letters, digits, spaces, dot, dash, underscore; collapsed spaces. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > TUNING.leaderboard.nameMax || !/^[A-Za-z0-9 ._-]+$/.test(name)) return null;
  const flat = name.toLowerCase().replace(/[^a-z]/g, '');
  if (TUNING.leaderboard.blocked.some((w) => flat.includes(w))) return null;
  return name;
}

export { NO_INPUT };
