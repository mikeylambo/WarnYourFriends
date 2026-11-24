import { TUNING } from '../tuning';
import BANK from './viewers.json';

/**
 * Phase 2 broadcast escalation (presentation only, DOM). The coverage grows with
 * the §21 Ratings tier, so the player feels their power through the news getting louder:
 *
 *  - cold open: a grainy traffic cam, then the chopper finds him and LIVE slams in (§4);
 *  - AT LARGE: a second chopper ("SKY 2"), viewer video unlocks, the viewer ticker starts;
 *  - RAMPAGE: split screen with the anchor desk;
 *  - CITY IN CHAOS: the frame pulses red.
 * The ladder reads through the chyron kicker and these on-screen changes, not a label (HUD cleanup, 2026-11-16).
 * Never covers the giant: everything lives on the frame's edges (§21 hierarchy).
 */
export class Coverage {
  private root: HTMLElement;
  private desk: HTMLElement;
  private ticker: HTMLElement;
  private tickerText: HTMLElement;
  private cold: HTMLElement;
  private tier = -1;
  private coldUntil = 0;
  private deskUntil = 0;
  private tickerPool: string[] = [];
  private time = 0;

  constructor() {
    const $ = (id: string) => document.getElementById(id)!;
    this.root = $('hud');
    this.desk = $('desk');
    this.ticker = $('ticker');
    this.tickerText = this.ticker.querySelector('span')!;
    this.cold = $('coldopen');
    this.tickerText.addEventListener('animationiteration', () => this.nextTicker());
  }

  /** New run: cold open on the traffic cam. */
  reset() {
    this.tier = -1;
    this.time = 0;
    this.coldUntil = TUNING.coverage.coldOpen;
    this.deskUntil = 0;
    this.setTierClass(-1);
    this.tickerPool = []; // review #75: last broadcast's late-run texts must not open the next
    this.cold.hidden = false;
    this.cold.classList.remove('found');
    document.documentElement.classList.add('coldopen');
    this.desk.hidden = true;
    this.ticker.hidden = true;
    this.aired.clear();
  }

  /** Only the coverage tier class changes on the HUD root (review #76: className overwrote its other classes). */
  private setTierClass(tier: number) {
    for (let i = 0; i <= 5; i++) this.root.classList.remove(`cov${i}`);
    if (tier >= 0) this.root.classList.add(`cov${tier}`);
  }

  /** Viewer texts that already ran on the ticker this broadcast. */
  private aired = new Set<string>();

  /** One for the recap: a viewer text that didn't air (for this audience size), so it's news to the player. */
  recapComment(tier: number): { text: string; who: string } {
    const pool = BANK.texts.filter(([, t]) => (t as number) <= Math.max(1, tier)).map(([s]) => s as string);
    const fresh = pool.filter((s) => !this.aired.has(s));
    const pick = (fresh.length ? fresh : pool)[Math.floor(Math.random() * (fresh.length || pool.length))];
    const [text, who] = pick.split(' — ');
    return { text, who: who ?? '' };
  }

  private nextTicker() {
    const pool = BANK.texts.filter(([, t]) => (t as number) <= Math.max(1, this.tier)).map(([s]) => s as string);
    if (!this.tickerPool.length) {
      // Fisher–Yates (review #75: sort by a random comparator is biased). Cosmetic, so Math.random.
      const p = pool.slice();
      for (let i = p.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [p[i], p[j]] = [p[j], p[i]];
      }
      this.tickerPool = p;
    }
    const a = this.tickerPool.pop() ?? pool[0];
    const b = this.tickerPool.pop() ?? pool[1];
    this.aired.add(a).add(b);
    this.tickerText.textContent = `VIEWERS WRITE IN  ·  ${a}   ·   ${b}`;
  }

  update(dt: number, ratingsTier: number, started: boolean) {
    if (!started) return;
    this.time += dt;
    // Cold open: traffic cam, then the chopper "finds" him.
    if (!this.cold.hidden && this.time >= this.coldUntil) {
      this.cold.classList.add('found');
      document.documentElement.classList.remove('coldopen');
      if (this.time >= this.coldUntil + 0.45) this.cold.hidden = true;
    }
    if (ratingsTier !== this.tier) {
      const up = ratingsTier > this.tier;
      this.tier = ratingsTier;
      this.setTierClass(ratingsTier);
      if (ratingsTier >= 1 && this.ticker.hidden) {
        this.ticker.hidden = false;
        this.nextTicker();
      }
      if (up && ratingsTier >= 2) this.deskUntil = this.time + TUNING.coverage.deskTime;
    }
    // The anchor desk cuts in on RAMPAGE and above, then steps aside.
    this.desk.hidden = !TUNING.coverage.anchorDesk || !(this.time < this.deskUntil);
  }

  /** The broadcast ended: the desk takes the shot. */
  end() {
    this.deskUntil = this.time + 99;
    this.desk.hidden = !TUNING.coverage.anchorDesk;
  }
}
