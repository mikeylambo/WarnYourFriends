import { TUNING } from '../tuning';
import { Rng } from './rng';
import type { Track } from './track';
import type { SimEvent } from './types';

/** One of tonight's asks: progress toward `n`, done once, `reward` banked on completion. */
export interface Ask {
  id: string;
  text: string;
  n: number;
  reward: number;
  progress: number;
  done: boolean;
  /** Failed for good (e.g. "without a bounce" after a bounce). */
  failed: boolean;
}

/**
 * The producer's asks (Mike, 2026-11-15): three seeded requests per segment, counted from sim
 * events. Pure and deterministic; the Sim feeds it events and banks rewards.
 */
export class Asks {
  readonly list: Ask[];
  /** Rampage held continuously (s), for the "hold Rampage" ask. */
  /** Smashes in the current Rampage (the one-Rampage ask). */
  private rampSmashes = 0;
  private inRampage = false;

  constructor(seed: number, segment: number, track: Track) {
    const A = TUNING.asks;
    const rng = new Rng((seed ^ 0xa5c5) >>> 0);
    track.ensure(A.zoneLookahead);
    const zones = new Set(track.segments.filter((s) => s.s0 <= A.zoneLookahead).map((s) => s.zone));
    const pool = A.pool.filter((p) => (p.fromSegment ?? 0) <= segment && (!p.zone || zones.has(p.zone)));
    const out: Ask[] = [];
    while (out.length < A.perSegment && pool.length) {
      const p = pool.splice(rng.int(0, pool.length - 1), 1)[0];
      out.push({ id: p.id, text: p.text.replace('{n}', String(p.n)), n: p.n, reward: p.reward, progress: 0, done: false, failed: false });
    }
    this.list = out;
  }

  private bump(id: string, by: number, out: SimEvent[], set?: number): Ask | null {
    const a = this.list.find((x) => x.id === id);
    if (!a || a.done || a.failed) return null;
    const next = Math.min(a.n, set ?? a.progress + by);
    if (next === a.progress) return null;
    a.progress = next;
    if (a.progress >= a.n) a.done = true;
    out.push({ type: 'ask', id: a.id, progress: a.progress, n: a.n, done: a.done, failed: false, reward: a.done ? a.reward : 0 });
    return a.done ? a : null;
  }

  private fail(id: string, out: SimEvent[]) {
    const a = this.list.find((x) => x.id === id);
    if (!a || a.done || a.failed) return;
    a.failed = true;
    out.push({ type: 'ask', id: a.id, progress: a.progress, n: a.n, done: false, failed: true, reward: 0 });
  }

  /**
   * Count an event. `zone` is the road he's on; `unitKind` names the police unit a smash hit.
   * Returns the asks finished by this event (the Sim banks their rewards).
   */
  observe(e: SimEvent, zone: string, unitKind: string | null, out: SimEvent[]): Ask[] {
    const done: (Ask | null)[] = [];
    switch (e.type) {
      case 'rampageStart':
        this.inRampage = true;
        this.rampSmashes = 0;
        done.push(this.bump('rampage', 1, out));
        break;
      case 'rampageEnd': this.inRampage = false; break;
      case 'rival': done.push(this.bump('rivals', 1, out)); break;
      case 'smash':
        // Best single Rampage so far (a shorter one later never lowers it).
        if (this.inRampage && ++this.rampSmashes > (this.list.find((x) => x.id === 'rampsmash')?.progress ?? Infinity)) done.push(this.bump('rampsmash', 0, out, this.rampSmashes));
        if (e.propId >= 1_000_000) done.push(this.bump('units', 1, out));
        if (unitKind === 'roadblock' || unitKind === 'rolling') done.push(this.bump('roadblock', 1, out));
        if (e.across) done.push(this.bump('across', 1, out));
        if (e.cls === 'heavy' && e.propId < 1_000_000) done.push(this.bump('heavy', 1, out));
        if (zone === 'bridge') done.push(this.bump('bridge', 1, out));
        if (zone === 'tunnel') done.push(this.bump('tunnel', 1, out));
        break;
      case 'policeCrash': if (e.onAir) done.push(this.bump('crash', 1, out)); break;
      case 'chain': done.push(this.bump('chain', 0, out, e.count)); break;
      case 'lostTrack': if (e.kind === 'chopper') done.push(this.bump('chopper', 1, out)); break;
      case 'ram': if (!e.hit) done.push(this.bump('dodge', 1, out)); break;
      case 'bounce': this.fail('clean', out); break;
      case 'signOff': done.push(this.bump('clean', 1, out)); break;
    }
    return done.filter((a): a is Ask => a !== null);
  }

  /** Per tick (kept for callers; the Rampage asks now count events). */
  step(_dt: number, _atRampage: boolean, _out: SimEvent[]): Ask[] {
    return [];
  }
}
