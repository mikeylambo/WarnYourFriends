import { TUNING } from '../tuning';
import type { BustReason, GainType, ShowState, SimEvent } from './types';

/**
 * Phase 2 broadcast state (§12): Ratings (the score source and the life bar),
 * banked score, Heat, Pin, and how the segment ends. Pure, deterministic.
 */
export class Show {
  ratings: number = TUNING.show.startRatings;
  /** Score (§6): Ratings × tier multiplier, banked every second. */
  banked = 0;
  heat = 1;
  pin = 0;
  state: ShowState = 'live';
  reason: BustReason | null = null;
  peak: number = TUNING.show.startRatings;
  /** Segment index (0-based): sets the decay rate. One segment per run until Phase 3. */
  segment = 0;
  /** Time of the last gain, for decay. */
  private lastGain = 0;
  private seen = new Set<GainType>();
  private recent: { type: GainType; t: number }[] = [];
  private nextHeatT: number = TUNING.show.heatEvery;
  private rampageAcc = 0;

  /** §21 headline tier from Ratings: 0 SPOTTED, 1 AT LARGE, 2 RAMPAGE, 3 CITY IN CHAOS. */
  get tier(): number {
    const T = TUNING.show.tiers;
    let k = 0;
    while (k + 1 < T.length && this.ratings >= T[k + 1]) k++;
    return k;
  }

  /** Apply a §12 gain with the variety rule; returns the delta actually added. */
  gain(type: GainType, time: number, outnumbered: boolean, out: SimEvent[]): number {
    if (this.state !== 'live') return 0;
    const S = TUNING.show;
    let amount: number = S.gain[type];
    if (type !== 'rampage') {
      this.recent = this.recent.filter((r) => time - r.t <= S.repeatWindow);
      const repeats = this.recent.filter((r) => r.type === type).length;
      const mult = this.seen.has(type) ? S.repeatMult[Math.min(repeats, S.repeatMult.length - 1)] : S.freshMult;
      amount *= mult;
      this.recent.push({ type, t: time });
      this.seen.add(type);
    }
    if (outnumbered) amount *= S.outnumberedMult;
    const before = this.ratings;
    this.ratings = Math.min(S.max, this.ratings + amount);
    this.lastGain = time;
    const delta = this.ratings - before;
    this.peak = Math.max(this.peak, this.ratings);
    out.push({ type: 'ratings', delta, cause: type, ratings: this.ratings });
    this.heatFromRatings(out);
    return delta;
  }

  private heatFromRatings(out: SimEvent[]) {
    const at = TUNING.show.heatAt;
    let h = 1;
    for (const r of at) if (this.ratings >= r) h++;
    if (h > this.heat) {
      this.heat = Math.min(5, h);
      out.push({ type: 'heat', heat: this.heat });
    }
  }

  /** Decay, banking, sustained Rampage, the 45s Heat clock and the Ratings-0 bust. */
  step(dt: number, time: number, tier: number, outnumbered: boolean, out: SimEvent[]) {
    if (this.state !== 'live') return;
    const S = TUNING.show;
    if (tier === TUNING.tiers.length - 1) {
      this.rampageAcc += dt;
      while (this.rampageAcc >= 1) {
        this.rampageAcc -= 1;
        this.gain('rampage', time, outnumbered, out);
      }
    } else this.rampageAcc = 0;
    if (time - this.lastGain > S.decayAfter) {
      this.ratings = Math.max(0, this.ratings - S.decayRate[Math.min(this.segment, S.decayRate.length - 1)] * dt);
    }
    this.banked += this.ratings * S.bankMult[tier] * dt;
    if (time >= this.nextHeatT) {
      this.nextHeatT += S.heatEvery;
      if (this.heat < 5) {
        this.heat++;
        out.push({ type: 'heat', heat: this.heat });
      }
    }
    if (this.ratings <= 0) this.bust('ratings', out);
  }

  /** v0.3 box-in: fill while boxed and slow, drain when fast. */
  stepPin(dt: number, boxed: boolean, speed: number, out: SimEvent[]) {
    if (this.state !== 'live') return;
    const S = TUNING.show;
    if (boxed && speed < S.pinBelow) this.pin = Math.min(100, this.pin + S.pinFill * dt);
    else if (speed > S.pinDrainAbove) this.pin = Math.max(0, this.pin - S.pinDrain * dt);
    if (this.pin >= 100) this.bust('pin', out);
  }

  bust(reason: BustReason, out: SimEvent[]) {
    if (this.state !== 'live') return;
    this.state = 'busted';
    this.reason = reason;
    out.push({ type: 'busted', reason });
  }

  clear(out: SimEvent[]) {
    if (this.state !== 'live') return;
    this.state = 'cleared';
    out.push({ type: 'signOff', ratings: this.ratings, banked: this.banked });
  }
}
