import { TUNING } from '../tuning';
import type { BustReason, GainType, PinCause, ShowState, SimEvent, StuntType } from './types';

/**
 * Phase 2 broadcast state (§12): Ratings (the score source and the life bar),
 * banked score, Heat, Pin, and how the segment ends. Pure, deterministic.
 */
export class Show {
  ratings: number = TUNING.show.startRatings;
  /** Score: spectacle points banked from finished chains (Mike, 2026-11-15). */
  banked = 0;
  /** The live chain: stunts in it, points waiting (before its multiplier), time of the last stunt. */
  chain = { count: 0, pending: 0, last: -Infinity };
  /** Longest chain this segment (stunts) and the biggest single chain banked (points). */
  bestChain = 0;
  bestChainPoints = 0;
  heat = 1;
  pin = 0;
  state: ShowState = 'live';
  reason: BustReason | null = null;
  peak: number = TUNING.show.startRatings;
  /** Segment index (0-based): sets the decay rate (§12) and the starting Heat (§19). */
  segment = 0;
  /** Phase 3 passives: Showman's fresh-type multiplier, Second Wind's Pin drain multiplier. */
  freshMult: number = TUNING.show.freshMult;
  pinDrainMult = 1;
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

  /** Start of a segment: §19 later segments start one Heat higher. */
  startSegment(segment: number) {
    this.segment = segment;
    this.heat = Math.min(5, 1 + segment);
  }

  /** Apply a §12 gain with the variety rule; returns the delta actually added. */
  gain(type: GainType, time: number, outnumbered: boolean, out: SimEvent[], base?: number): number {
    if (this.state !== 'live') return 0;
    const S = TUNING.show;
    let amount: number = base ?? (type === 'pose' ? 0 : S.gain[type]);
    if (type !== 'rampage' && type !== 'pose') {
      this.recent = this.recent.filter((r) => time - r.t <= S.repeatWindow);
      const repeats = this.recent.filter((r) => r.type === type).length;
      const mult = this.seen.has(type) ? S.repeatMult[Math.min(repeats, S.repeatMult.length - 1)] : this.freshMult;
      amount *= mult;
      this.recent.push({ type, t: time });
      this.seen.add(type);
    }
    if (outnumbered) amount *= S.outnumberedMult;
    const before = this.ratings;
    this.ratings = Math.min(S.max, this.ratings + amount);
    // Sustained Rampage is a trickle against decay, not a reason to hold it off (balance 2026-11-16):
    // otherwise +1/s at Rampage resets the 3s timer forever and Ratings can't fall while he runs.
    if (type !== 'rampage') this.lastGain = time;
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
    if (tier === TUNING.tiers.length - 1 && S.gain.rampage > 0) {
      this.rampageAcc += dt;
      while (this.rampageAcc >= 1) {
        this.rampageAcc -= 1;
        this.gain('rampage', time, outnumbered, out);
      }
    } else this.rampageAcc = 0;
    if (time > S.decayGrace && time - Math.max(this.lastGain, S.decayGrace - S.decayAfter) > S.decayAfter) {
      this.ratings = Math.max(0, this.ratings - S.decayRate[Math.min(this.segment, S.decayRate.length - 1)] * dt);
    }
    if (this.chain.count > 0 && time - this.chain.last > TUNING.spectacle.window) this.endChain(false, out);
    if (time >= this.nextHeatT) {
      this.nextHeatT += S.heatEvery;
      if (this.heat < 5) {
        this.heat++;
        out.push({ type: 'heat', heat: this.heat });
      }
    }
    if (this.ratings <= 0) this.bust('ratings', out);
  }

  /** What filled the meter last (the HUD label, the slip's headline). */
  pinCause: PinCause = 'net';

  /**
   * v0.3 box-in, and caught: fill while boxed and slow, or while police are on his tail as he crawls; drain
   * when fast, or once he's free of both and back above a crawl.
   */
  stepPin(dt: number, boxed: boolean, caught: boolean, speed: number, out: SimEvent[]) {
    if (this.state !== 'live') return;
    const S = TUNING.show;
    if (boxed && speed < S.pinBelow) {
      this.pin = Math.min(100, this.pin + S.pinFill * dt);
      this.pinCause = 'net';
    } else if (caught) {
      this.pin = Math.min(100, this.pin + TUNING.pursuit.caught.fill * dt);
      this.pinCause = 'caught';
    } else if (speed > S.pinDrainAbove || (!boxed && speed >= TUNING.pursuit.caught.below)) this.pin = Math.max(0, this.pin - S.pinDrain * this.pinDrainMult * dt);
    if (this.pin >= 100) {
      // Police Net: the first catch in a segment he slips (a gear and Ratings, the caller applies them); the next busts him.
      // Caught (police ran him down while he dawdled): busted the first time.
      if (this.netSlips < (this.pinCause === 'caught' ? TUNING.pursuit.caught.slips : 1)) {
        this.netSlips++;
        this.pin = 0;
        const before = this.ratings;
        this.ratings = Math.max(1, this.ratings - TUNING.pursuit.net.slipRatings);
        out.push({ type: 'netSlip', ratings: this.ratings - before, cause: this.pinCause });
      } else this.bust('pin', out);
    }
  }
  /** Police Net catches slipped this segment. */
  netSlips = 0;

  /** Phase 3 Pose for the Camera: spend Heat, take a Ratings spike (the one way Heat falls). */
  pose(time: number, out: SimEvent[]): number {
    const P = TUNING.abilities.pose;
    const gain = P.ratingsPerHeat * this.heat;
    const before = this.heat;
    const delta = this.gain('pose', time, false, out, gain);
    this.heat = Math.max(1, this.heat - P.heatCost);
    if (this.heat !== before) out.push({ type: 'heat', heat: this.heat });
    return delta;
  }

  /** Chain multiplier for a chain of `count` stunts. */
  static chainMult(count: number): number {
    const C = TUNING.spectacle;
    return Math.min(C.maxMult, 1 + Math.floor(Math.max(0, count - 1) / C.stepEvery));
  }

  /** A stunt joins the chain: points × gear × audience (multiplied by the chain when it banks). */
  stunt(cause: StuntType, time: number, gear: number, out: SimEvent[], base?: number) {
    if (this.state !== 'live') return;
    const C = TUNING.spectacle;
    if (this.chain.count > 0 && time - this.chain.last > C.window) this.endChain(false, out);
    const pts = (base ?? (C.points as Record<string, number>)[cause] ?? 0) * TUNING.show.bankMult[gear] * C.audienceMult[this.tier];
    if (pts <= 0) return;
    this.chain.count++;
    this.chain.pending += pts;
    this.chain.last = time;
    this.bestChain = Math.max(this.bestChain, this.chain.count);
    out.push({ type: 'chain', count: this.chain.count, mult: Show.chainMult(this.chain.count), pending: this.chain.pending, add: pts, cause });
  }

  /** Bank the chain: at its multiplier, or at ×1 if it was dropped (bounce, spikes, a ram that connects). */
  endChain(dropped: boolean, out: SimEvent[]) {
    const c = this.chain;
    if (c.count === 0) return;
    const mult = dropped ? 1 : Show.chainMult(c.count);
    const points = Math.round(c.pending * mult);
    this.banked += points;
    this.bestChainPoints = Math.max(this.bestChainPoints, points);
    out.push({ type: 'chainEnd', count: c.count, mult, points, dropped });
    this.chain = { count: 0, pending: 0, last: -Infinity };
  }

  bust(reason: BustReason, out: SimEvent[]) {
    if (this.state !== 'live') return;
    this.endChain(true, out); // busted mid-chain: what's in it banks at ×1
    this.state = 'busted';
    this.reason = reason;
    out.push({ type: 'busted', reason });
  }

  clear(out: SimEvent[]) {
    if (this.state !== 'live') return;
    this.endChain(false, out); // signed off mid-chain: it banks in full
    this.state = 'cleared';
    out.push({ type: 'signOff', ratings: this.ratings, banked: this.banked });
  }
}
