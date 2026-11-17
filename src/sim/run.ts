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

export const ABILITIES: AbilityId[] = ['leap', 'stare', 'breakaway', 'primeTime', 'shoulder'];
/** Every upgrade, in pool order (the offers draw from this, minus what's locked). */
export const ALL_UPGRADES = Object.keys(TUNING.upgrades) as UpgradeId[];

export class RunState {
  segment = 0;
  phase: RunPhase = 'live';
  earned = 0;
  spent = 0;
  owned: UpgradeId[] = [];
  /** Ability levels I–III (the equipped one's level carries into each segment). */
  levels: Partial<Record<AbilityId, number>> = {};
  /** Per-segment results, for the recap. */
  readonly results: { segment: number; cleared: boolean; banked: number; peak: number }[] = [];
  private rng: Rng;
  private offerCache: UpgradeId[] | null = null;

  /**
   * `pool`: the upgrades this player can be offered (Awards unlock the rest; src/awards.ts). The leaderboard
   * replays a run with the same pool, so the offers match.
   */
  constructor(readonly seed: number, readonly pool: readonly UpgradeId[] = ALL_UPGRADES, readonly edition = 0) {
    this.rng = new Rng((seed ^ 0x52554e) >>> 0);
  }

  /** Level an ability is at (0 if not held). */
  levelOf(id: AbilityId): number {
    return this.owned.includes(id) ? (this.levels[id] ?? 1) : 0;
  }

  /** What buying `id` costs now: an ability you hold levels up at `levelPrice` of its price. */
  priceOf(id: UpgradeId): number {
    const u = TUNING.upgrades[id];
    return u.kind === 'ability' && this.owned.includes(id) ? Math.round(u.price * TUNING.levelPrice) : u.price;
  }

  get purse(): number {
    return Math.floor(this.earned - this.spent);
  }

  get ability(): AbilityId | null {
    return this.abilities[0] ?? null;
  }

  /** Abilities held, in the order bought (they stack, up to `run.abilitySlots`). */
  get abilities(): AbilityId[] {
    return this.owned.filter((u): u is AbilityId => (ABILITIES as string[]).includes(u));
  }

  /** Seed for a segment's road and police. */
  segmentSeed(i = this.segment): number {
    return (this.seed + Math.imul(i + 1, 0x9e3779b1)) >>> 0;
  }

  /** A segment ended: bank it, then meeting / won / lost. */
  finishSegment(show: Show) {
    const cleared = show.state === 'cleared';
    // Edition (TUNING.editions): harder broadcasts pay more.
    this.earned += show.banked * TUNING.editions[Math.max(0, Math.min(TUNING.editions.length - 1, this.edition))].score;
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
    // Passives you own aren't offered again; the ability you hold comes back as its next level until it's maxed.
    // Abilities stack (2026-11-17): a new one only while a slot is free; one you hold comes back as its next level.
    const free = this.abilities.length < TUNING.run.abilitySlots;
    const pool = ALL_UPGRADES.filter((u) => this.pool.includes(u) && (TUNING.upgrades[u].kind === 'ability' ? (this.levelOf(u as AbilityId) ? this.levelOf(u as AbilityId) < TUNING.maxLevel : free) : !this.owned.includes(u)));
    const out: UpgradeId[] = [];
    while (out.length < TUNING.run.offers && pool.length) out.push(pool.splice(this.rng.int(0, pool.length - 1), 1)[0]);
    return (this.offerCache = out);
  }

  canAfford(id: UpgradeId): boolean {
    return this.purse >= this.priceOf(id);
  }

  /** Buy one pitch (abilities replace the equipped one, §17). Returns false if it can't. */
  buy(id: UpgradeId): boolean {
    if (this.phase !== 'meeting' || !this.offers().includes(id) || !this.canAfford(id) || this.bought.includes(id)) return false;
    this.spent += this.priceOf(id);
    if (TUNING.upgrades[id].kind === 'ability') {
      const a = id as AbilityId;
      const held = this.levelOf(a);
      if (held) this.levels[a] = held + 1; // the one you hold levels up
      else if (this.abilities.length < TUNING.run.abilitySlots) {
        this.owned.push(id); // abilities stack (Mike, 2026-11-17)
        this.levels[a] = 1;
      } else return false;
    } else this.owned.push(id);
    // The meeting stays open (Mike, 2026-11-17): buy as many as the budget allows, then go live.
    this.bought.push(id);
    return true;
  }

  /** Bought at the current meeting (each pitch once). */
  bought: UpgradeId[] = [];


  /** Leave the meeting (with or without buying) for the next segment. */
  nextSegment(): boolean {
    if (this.phase !== 'meeting') return false;
    this.bought = [];
    this.segment++;
    this.phase = 'live';
    return true;
  }
}
