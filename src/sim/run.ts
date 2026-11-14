import { TUNING, type AbilityId, type UpgradeId } from '../tuning';
import { Rng } from './rng';
import type { Show } from './show';

/**
 * Phase 3 run (§4, §17): five segments, a Producer's Meeting between each.
 * Pure and seeded. The score is everything banked across the run (§6); upgrades
 * are paid from what's banked and not yet spent (the purse), so spending never
 * lowers the score. A bust ends the run; signing off segment 5 wins it.
 */
export type RunPhase = 'live' | 'meeting' | 'won' | 'lost';

export const ABILITIES: AbilityId[] = ['leap', 'stare', 'hijack', 'pose'];

export class RunState {
  segment = 0;
  phase: RunPhase = 'live';
  earned = 0;
  spent = 0;
  owned: UpgradeId[] = [];
  /** Per-segment results, for the recap. */
  readonly results: { segment: number; cleared: boolean; banked: number; peak: number }[] = [];
  private rng: Rng;
  private offerCache: UpgradeId[] | null = null;

  constructor(readonly seed: number) {
    this.rng = new Rng((seed ^ 0x52554e) >>> 0);
  }

  get purse(): number {
    return Math.floor(this.earned - this.spent);
  }

  get ability(): AbilityId | null {
    return (this.owned.find((u) => (ABILITIES as string[]).includes(u)) as AbilityId | undefined) ?? null;
  }

  /** Seed for a segment's road and police. */
  segmentSeed(i = this.segment): number {
    return (this.seed + Math.imul(i + 1, 0x9e3779b1)) >>> 0;
  }

  /** A segment ended: bank it, then meeting / won / lost. */
  finishSegment(show: Show) {
    const cleared = show.state === 'cleared';
    this.earned += show.banked;
    this.results.push({ segment: this.segment, cleared, banked: show.banked, peak: show.peak });
    if (!cleared) this.phase = 'lost';
    else if (this.segment >= TUNING.run.segments - 1) this.phase = 'won';
    else {
      this.phase = 'meeting';
      this.offerCache = null;
    }
  }

  /** §17: three pitches. Passives you own aren't offered again; neither is the ability you hold. */
  offers(): UpgradeId[] {
    if (this.offerCache) return this.offerCache;
    const pool = (Object.keys(TUNING.upgrades) as UpgradeId[]).filter((u) => !this.owned.includes(u));
    const out: UpgradeId[] = [];
    while (out.length < TUNING.run.offers && pool.length) out.push(pool.splice(this.rng.int(0, pool.length - 1), 1)[0]);
    return (this.offerCache = out);
  }

  canAfford(id: UpgradeId): boolean {
    return this.purse >= TUNING.upgrades[id].price;
  }

  /** Buy one pitch (abilities replace the equipped one, §17). Returns false if it can't. */
  buy(id: UpgradeId): boolean {
    if (this.phase !== 'meeting' || !this.offers().includes(id) || !this.canAfford(id)) return false;
    this.spent += TUNING.upgrades[id].price;
    if (TUNING.upgrades[id].kind === 'ability') this.owned = this.owned.filter((u) => !(ABILITIES as string[]).includes(u));
    this.owned.push(id);
    return this.nextSegment();
  }

  /** Leave the meeting (with or without buying) for the next segment. */
  nextSegment(): boolean {
    if (this.phase !== 'meeting') return false;
    this.segment++;
    this.phase = 'live';
    return true;
  }
}
