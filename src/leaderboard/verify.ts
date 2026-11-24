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

/** run = Story (or the classic Full Broadcast), broadcast = one segment, endless = Endless, daily = today's Endless road. */
export type BoardMode = 'run' | 'broadcast' | 'endless' | 'daily';

/** Daily Endless (2026-11-24): the UTC day number for a time (ms). */
export const dailyDay = (ms: number) => Math.floor(ms / 86_400_000);
/** Daily Endless: everyone's road for that day (1..1e9), the same on every client and on the server. */
export function dailySeed(day: number): number {
  let h = (day ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return 1 + (h % 999_999_999);
}

export interface Submission {
  mode: BoardMode;
  seed: number;
  /** Giant size setting (TUNING.growth): growth on, or the fixed giant. */
  growth: boolean;
  /** Each segment's inputs, run-length encoded (encodeInputs). Single Segment: one. */
  segments: string[];
  /** Full Broadcast: what was bought at each meeting, in order (null or [] = walked out; one id = the old single buy). */
  buys: (UpgradeId[] | UpgradeId | null)[];
  /** The upgrades this player could be offered (Awards unlock the rest); absent = all. Must match the client's run. */
  pool?: UpgradeId[];
  /** The guided first broadcast (its first segment opens calm, TUNING.guided). */
  guided?: boolean;
  /** Edition of the news (TUNING.editions). */
  edition?: number;
  /** Daily: the UTC day (dailyDay) whose road this is. */
  day?: number;
  /** Story: the producer's asks picked before going live (TUNING.proto.storyAsks ids). */
  asks?: string[];
  /** Story: traffic mods on (TUNING.proto.mods ids); they change the score multiplier. */
  mods?: string[];
  /** The score the client showed; only compared, never stored. */
  claimed: number;
}

/** 3 lane × 2 brake × 2 shoulder × 2 ability = 24 symbols, one letter each; with the second ability pressed, the same in capitals. */
const sym = (i: SimInput) => (Math.sign(i.lane) + 1) * 8 + (i.brake ? 4 : 0) + (i.shoulder ? 2 : 0) + (i.ability ? 1 : 0);
const A = 'a'.charCodeAt(0);
const CAP = 'A'.charCodeAt(0);
const letter = (i: SimInput) => String.fromCharCode((i.ability2 ? CAP : A) + sym(i));

/** Run-length encode an input log: a letter per input, then its repeat count when > 1 ("a3600e2a…"). */
export function encodeInputs(log: readonly SimInput[]): string {
  let out = '';
  for (let i = 0; i < log.length; ) {
    const s = letter(log[i]);
    let n = 1;
    while (i + n < log.length && letter(log[i + n]) === s) n++;
    out += s + (n > 1 ? n : '');
    i += n;
  }
  return out;
}

/** Decode encodeInputs; null when malformed or longer than `max` inputs. */
export function decodeInputs(str: string, max: number = TUNING.leaderboard.maxTicks): SimInput[] | null {
  if (!/^([a-xA-X]\d*)*$/.test(str)) return null;
  const out: SimInput[] = [];
  for (const m of str.matchAll(/([a-xA-X])(\d*)/g)) {
    const upper = m[1] < 'a';
    const s = m[1].charCodeAt(0) - (upper ? CAP : A);
    const n = m[2] ? Number(m[2]) : 1;
    if (!Number.isSafeInteger(n) || n < 1 || out.length + n > max) return null;
    const inp: SimInput = { lane: Math.floor(s / 8) - 1, brake: !!(s & 4), shoulder: !!(s & 2), ability: !!(s & 1), ...(upper ? { ability2: true } : {}) };
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
  if (sub.mode !== 'run' && sub.mode !== 'broadcast' && sub.mode !== 'endless' && sub.mode !== 'daily') return { ok: false, error: 'mode' };
  if (sub.mode === 'daily' && (!Number.isSafeInteger(sub.day) || sub.seed !== dailySeed(sub.day!))) return { ok: false, error: 'seed' };
  if (!Number.isSafeInteger(sub.seed)) return { ok: false, error: 'seed' };
  if (!Array.isArray(sub.segments) || !sub.segments.length || sub.segments.length > TUNING.run.segments) return { ok: false, error: 'segments' };
  const logs = sub.segments.map((s) => (typeof s === 'string' ? decodeInputs(s) : null));
  if (logs.some((l) => !l)) return { ok: false, error: 'inputs' };

  const strs = (v: unknown, known: Record<string, unknown> | readonly { id: string }[]) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && (Array.isArray(known) ? known.some((k) => k.id === x) : x in known)).slice(0, 8) : [];
  const asks = strs(sub.asks, TUNING.proto.storyAsks);
  const mods = strs(sub.mods, TUNING.proto.mods);
  const story = { ...(asks.length ? { asks } : {}), ...(mods.length ? { mods } : {}) };

  if (sub.mode === 'endless' || sub.mode === 'daily') {
    if (logs.length !== 1) return { ok: false, error: 'segments' };
    const sim = new Sim({ seed: sub.seed, segment: 0, upgrades: [], growth: !!sub.growth, guided: !!sub.guided, edition: 0, endless: true });
    if (!playSegment(sim, logs[0]!)) return { ok: false, error: 'unfinished' };
    return { ok: true, score: Math.round(sim.show.banked), segments: 1, won: false };
  }

  if (sub.mode === 'broadcast') {
    if (logs.length !== 1) return { ok: false, error: 'segments' };
    const sim = new Sim({ seed: sub.seed, segment: 0, upgrades: [], growth: !!sub.growth, guided: !!sub.guided, edition: sub.edition ?? 0 });
    if (!playSegment(sim, logs[0]!)) return { ok: false, error: 'unfinished' };
    return { ok: true, score: Math.round(sim.show.banked), segments: 1, won: sim.show.state === 'cleared' };
  }

  const pool = Array.isArray(sub.pool) ? sub.pool.filter((u) => (ALL_UPGRADES as string[]).includes(u)) : ALL_UPGRADES;
  const edition = Number.isSafeInteger(sub.edition) && sub.edition! >= 0 && sub.edition! < TUNING.editions.length ? sub.edition! : 0;
  const run = new RunState(sub.seed, pool, edition);
  const buys = Array.isArray(sub.buys) ? sub.buys : [];
  for (let i = 0; i < logs.length; i++) {
    if (run.phase !== 'live') return { ok: false, error: 'segments' };
    const sim = new Sim({ seed: run.segmentSeed(), segment: run.segment, upgrades: run.owned, levels: run.levels, growth: !!sub.growth, guided: !!sub.guided && i === 0, edition, ...story });
    if (!playSegment(sim, logs[i]!)) return { ok: false, error: 'unfinished' };
    run.finishSegment(sim.show);
    if ((run.phase as string) === 'meeting') {
      const b = buys[i] ?? null;
      // The meeting always shows its pitches (drawing them moves the run's RNG), bought from or not.
      run.offers();
      // Several buys per meeting (2026-11-17), then go live.
      for (const id of b === null ? [] : Array.isArray(b) ? b : [b]) if (!run.buy(id)) return { ok: false, error: 'buy' };
      run.nextSegment();
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
