/**
 * Onboarding (Mike: "weak in onboarding/UI on getting us to those payoff states"): one-line
 * producer notes, each shown once, the first time it matters. Presentation only: it reads the
 * sim, never writes it. Seen notes are remembered per browser; turning Producer Tips back on
 * in Settings replays them.
 */
export type TipId = 'gear' | 'stride' | 'rampage' | 'bounce' | 'dodge' | 'dozer' | 'losing' | 'exit' | 'budget';

export const TIP_TEXT: Record<TipId, string> = {
  gear: 'Keep him at top speed. He shifts up a gear.',
  stride: 'Stride. The small stuff smashes now.',
  rampage: 'Rampage. Cars smash now, and every viewer pays double.',
  bounce: 'Too heavy for that gear. Go round it, or gear up first.',
  dodge: 'Close call. Viewers love a late cut.',
  dozer: 'Bulldozer ahead. Nothing smashes that. Go round.',
  losing: "We're losing them. Smash something.",
  exit: "Exit's open. Take it to sign off.",
  budget: 'Stunts and chains pay the budget. Spend it between segments.',
};

const KEY = 'gal.tips.seen.v1';

export class Tips {
  private seen = new Set<TipId>();
  private queue: TipId[] = [];
  private showing: TipId | 'say' | null = null;
  /** One-off producer lines (asks landing): shown ahead of tips, never remembered. */
  private says: string[] = [];
  private t = 0;
  private gap = 0;

  constructor(private el: HTMLElement, private readonly showTime: number, private readonly minGap: number) {
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

  /** Ask for a tip; ignored if already seen or queued. */
  want(id: TipId) {
    if (this.seen.has(id) || this.queue.includes(id) || this.showing === id) return;
    this.queue.push(id);
  }

  /** A one-off line from the producer (not an onboarding tip): shown next, not remembered. */
  say(text: string) {
    this.says.push(text);
  }

  /** Drop pending tips and hide (a new broadcast, the menus). */
  clear() {
    this.queue.length = 0;
    this.says.length = 0;
    this.showing = null;
    this.el.classList.remove('show');
  }

  update(dt: number, enabled: boolean) {
    if (!enabled) {
      this.clear();
      return;
    }
    if (this.showing) {
      this.t -= dt;
      if (this.t <= 0) {
        this.showing = null;
        this.el.classList.remove('show');
        this.gap = this.minGap;
      }
      return;
    }
    this.gap = Math.max(0, this.gap - dt);
    const line = this.says.shift();
    if (line) {
      this.showing = 'say';
      this.t = this.showTime * 0.6;
      this.el.querySelector('.txt')!.textContent = line;
      this.el.classList.remove('show');
      void this.el.offsetWidth;
      this.el.classList.add('show');
      return;
    }
    const next = this.queue.shift();
    if (!next || this.gap > 0) {
      if (next) this.queue.unshift(next);
      return;
    }
    this.showing = next;
    this.t = this.showTime;
    this.seen.add(next);
    this.save();
    this.el.querySelector('.txt')!.textContent = TIP_TEXT[next];
    this.el.classList.remove('show');
    void this.el.offsetWidth;
    this.el.classList.add('show');
  }

  private save() {
    try {
      localStorage.setItem(KEY, JSON.stringify([...this.seen]));
    } catch {
      /* storage unavailable */
    }
  }
}
