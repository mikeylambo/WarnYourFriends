import { TUNING } from '../tuning';
import BANK from './viewers.json';

/**
 * Phase 2 broadcast escalation (presentation only, DOM). The coverage grows with
 * the §21 Ratings tier, so the player feels their power through the news getting louder:
 *
 *  - cold open: a grainy traffic cam, then the chopper finds him and LIVE slams in (§4);
 *  - AT LARGE: a second chopper ("SKY 2"), viewer video unlocks, the viewer ticker starts;
 *  - RAMPAGE: split screen with the anchor desk;
 *  - CITY IN CHAOS: simulcast, every (invented) station's bug on screen.
 * Never covers the giant: everything lives on the frame's edges (§21 hierarchy).
 */
export class Coverage {
  private root: HTMLElement;
  private label: HTMLElement;
  private desk: HTMLElement;
  private ticker: HTMLElement;
  private tickerText: HTMLElement;
  private rivals: HTMLElement;
  private cold: HTMLElement;
  private tier = -1;
  private coldUntil = 0;
  private deskUntil = 0;
  private tickerPool: string[] = [];
  private time = 0;

  constructor() {
    const $ = (id: string) => document.getElementById(id)!;
    this.root = $('hud');
    this.label = $('coverage');
    this.desk = $('desk');
    this.ticker = $('ticker');
    this.tickerText = this.ticker.querySelector('span')!;
    this.rivals = $('rivals');
    this.cold = $('coldopen');
    this.rivals.innerHTML = BANK.rivals.map((r) => `<span>${r}</span>`).join('');
    this.tickerText.addEventListener('animationiteration', () => this.nextTicker());
  }

  /** New run: cold open on the traffic cam. */
  reset() {
    this.tier = -1;
    this.time = 0;
    this.coldUntil = TUNING.coverage.coldOpen;
    this.deskUntil = 0;
    this.root.className = '';
    this.cold.hidden = false;
    this.cold.classList.remove('found');
    document.documentElement.classList.add('coldopen');
    this.desk.hidden = true;
    this.ticker.hidden = true;
  }

  private nextTicker() {
    const pool = BANK.texts.filter(([, t]) => (t as number) <= Math.max(1, this.tier)).map(([s]) => s as string);
    if (!this.tickerPool.length) this.tickerPool = pool.slice().sort(() => Math.random() - 0.5);
    const a = this.tickerPool.pop() ?? pool[0];
    const b = this.tickerPool.pop() ?? pool[1];
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
      this.root.className = `cov${ratingsTier}`;
      this.label.textContent = ['CHOPPER 6', 'CHOPPER 6 · SKY 2', 'CHOPPER 6 · SKY 2 · DESK', 'SIMULCAST · ALL STATIONS'][ratingsTier];
      if (ratingsTier >= 1 && this.ticker.hidden) {
        this.ticker.hidden = false;
        this.nextTicker();
      }
      if (up && ratingsTier >= 2) this.deskUntil = this.time + TUNING.coverage.deskTime;
    }
    // The anchor desk cuts in on RAMPAGE and above, then steps aside.
    this.desk.hidden = !(this.time < this.deskUntil);
  }

  /** The broadcast ended: the desk takes the shot. */
  end() {
    this.deskUntil = this.time + 99;
    this.desk.hidden = false;
  }
}
