/**
 * Onboarding (Mike: "weak in onboarding/UI on getting us to those payoff states"): one-line
 * producer notes, each shown once. They're collected while it matters and handed over on the
 * recap, never over the road (HUD cleanup, Mike 2026-11-16). Presentation only: it reads the
 * sim, never writes it. Seen notes are remembered per browser; turning Producer Tips back on
 * in Settings replays them.
 */
export type TipId = 'gear' | 'stride' | 'rampage' | 'bounce' | 'dodge' | 'dozer' | 'losing' | 'exit' | 'budget' | 'net' | 'carrier' | 'armored';

export const TIP_TEXT: Record<TipId, string> = {
  gear: 'Keep him at top speed and he shifts up a gear.',
  stride: 'At Stride, the small stuff smashes.',
  rampage: 'At Rampage, cars smash and every viewer pays double.',
  bounce: 'Some things are too heavy for his gear. Go round, or gear up first.',
  dodge: 'Close calls pay. Viewers love a late cut.',
  dozer: 'Nothing smashes a bulldozer. Go round.',
  losing: "When we're losing them, smash something.",
  exit: 'When the exit opens, take it to sign off.',
  budget: 'Stunts and chains pay the budget. Spend it between segments.',
  net: 'Police net: Shoulder Check a car beside you, or brake and drop back.',
  carrier: 'A car carrier drops its load. Weave through, or flatten it at Rampage.',
  armored: 'Nothing smashes the armored truck. Find the gap.',
};

const KEY = 'gal.tips.seen.v1';

export class Tips {
  private seen = new Set<TipId>();
  /** Notes this broadcast earned, in the order they came up. */
  private queue: TipId[] = [];

  constructor() {
    try {
      for (const id of JSON.parse(localStorage.getItem(KEY) ?? '[]') as TipId[]) this.seen.add(id);
    } catch {
      /* storage unavailable: tips show once per session */
    }
  }

  /** Forget what's been seen (Settings → Producer Tips back on). */
  reset() {
    this.seen.clear();
    this.save();
  }

  /** A note became relevant; ignored if already seen or queued. */
  want(id: TipId) {
    if (this.seen.has(id) || this.queue.includes(id)) return;
    this.queue.push(id);
  }

  /** Drop pending notes (a new broadcast, the menus). */
  clear() {
    this.queue.length = 0;
  }

  /** The recap's notes: up to `max` of this broadcast's, marked seen (the rest wait for a later recap). */
  take(max: number): string[] {
    const out = this.queue.splice(0, max);
    this.queue.length = 0;
    for (const id of out) this.seen.add(id);
    if (out.length) this.save();
    return out.map((id) => TIP_TEXT[id]);
  }

  private save() {
    try {
      localStorage.setItem(KEY, JSON.stringify([...this.seen]));
    } catch {
      /* storage unavailable */
    }
  }
}
