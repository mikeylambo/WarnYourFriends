import { TUNING } from './tuning';
import { CLASS_RANK, type Sim } from './sim/sim';
import type { SimEvent } from './sim/types';

/**
 * Onboarding (Mike, 2026-11-17: "let's improve the onboarding"). How to Play gives the five-line idea before the
 * first broadcast; these prompts teach the rest at the moment it matters, once each (per browser). Plain
 * instructions with the button on them, never a voice or a quote (the producer notes were cut on 2026-11-16).
 * At most one on screen, `gap` s apart. Presentation only: reads the sim, never writes it.
 */
export type PromptId = 'blocked' | 'meter' | 'ready' | 'hit' | 'ram' | 'rampage' | 'audience' | 'kite' | 'boxed' | 'caught' | 'exit' | 'ability';

/** v2: the Rampage loop (2026-11-17) teaches new lessons, so everyone sees them once. */
const STORE = 'wyf.prompts.v2';

/** Builds the prompt text with the current device's buttons (HTML: <kbd> for keys). */
export type PromptText = (id: PromptId) => string;

export class Onboarding {
  private seen: Set<PromptId>;
  private showing: { id: PromptId; until: number } | null = null;
  private lastAt = -Infinity;
  private queued: PromptId | null = null;
  enabled = true;

  constructor(private el: HTMLElement, private text: PromptText) {
    let saved: PromptId[] = [];
    try {
      saved = JSON.parse(localStorage.getItem(STORE) ?? '[]') as PromptId[];
    } catch {
      /* storage unavailable or corrupt: show them again */
    }
    this.seen = new Set(Array.isArray(saved) ? saved : []);
  }

  /** Forget what's been shown (Settings: Replay Tips). */
  reset() {
    this.seen.clear();
    this.save();
  }

  private save() {
    try {
      localStorage.setItem(STORE, JSON.stringify([...this.seen]));
    } catch {
      /* storage unavailable: they show again next time */
    }
  }

  /** Ask for a prompt; it shows if it's new and the screen is free (else it waits a moment for its turn). */
  private want(id: PromptId) {
    if (this.seen.has(id) || this.showing?.id === id) return;
    if (!this.queued) this.queued = id;
  }

  /** Sim events that start a lesson. */
  observe(e: SimEvent, sim: Sim) {
    if (e.type === 'tell' && e.kind === 'cruiser') this.want('ram');
    else if (e.type === 'tell' && e.kind === 'net') this.want('boxed');
    else if (e.type === 'meterFull') this.want('ready');
    else if (e.type === 'rampageStart') {
      // Fired it without being told: the "ready" lesson is learned; now what Rampage does.
      if (!this.seen.has('ready')) {
        this.seen.add('ready');
        this.save();
      }
      this.want('rampage');
    } else if (e.type === 'meterLoss') this.want('hit');
    else if (e.type === 'exitOpen') this.want('exit');
    void sim;
  }

  /** Every frame (real time `now`, s): states that start a lesson, and showing / hiding. */
  update(sim: Sim, now: number, live: boolean) {
    const O = TUNING.onboarding;
    if (!this.enabled || !live) {
      this.hide();
      this.queued = null;
      return;
    }
    const g = sim.giant;
    // Something he can't smash at this gear in his lane, a second or two out.
    if (!this.seen.has('blocked') && sim.time > O.quietStart) {
      const rank = sim.smashRank();
      const c = sim.track.laneCenter(g.lane);
      const ahead = sim.track.propsBetween(g.s + g.speed * 0.8, g.s + g.speed * O.blockedLead);
      if (ahead.some((p) => p.alive && CLASS_RANK[p.cls] > rank && Math.abs(p.d - c) < p.hw + 1)) this.want('blocked');
    }
    // The meter's first fill: what it is (once he's smashed something, so the bar is moving when he looks).
    if (!this.seen.has('meter') && g.meter > 0 && sim.time > O.quietStart) this.want('meter');
    // The audience draining with nothing happening.
    if (sim.show.ratings < O.audienceBelow && sim.time > TUNING.show.decayGrace) this.want('audience');
    // A police car alongside him with something solid ahead in its lane: kite it.
    if (!this.seen.has('kite')) {
      for (const u of sim.pursuit.units) {
        if (!u.alive || u.unit !== 'cruiser' || u.phase !== 'approach' || Math.abs(u.s - g.s) > 4 || Math.abs(u.lane - g.lane) !== 1) continue;
        const c = sim.track.laneCenter(u.lane);
        if (sim.track.propsBetween(u.s + u.hl, u.s + O.kiteAhead).some((p) => p.alive && p.cls !== 'light' && p.cls !== 'medium' && Math.abs(p.d - c) < p.hw + u.hw)) this.want('kite');
      }
    }
    // Crawling with police coming up behind: let go.
    if (sim.caught() || (g.speed < TUNING.pursuit.caught.below && sim.pursuit.onHisTail().length)) this.want('caught');
    if (sim.ability && sim.time > O.quietStart) this.want('ability');

    if (this.showing && now >= this.showing.until) this.hide();
    if (!this.showing && this.queued && now - this.lastAt >= O.gap) {
      const id = this.queued;
      this.queued = null;
      if (this.seen.has(id)) return;
      this.seen.add(id);
      this.save();
      this.showing = { id, until: now + O.hold };
      this.lastAt = now;
      this.el.innerHTML = this.text(id);
      this.el.hidden = false;
      this.el.classList.remove('in');
      void this.el.offsetWidth;
      this.el.classList.add('in');
    }
  }

  private hide() {
    if (!this.showing) return;
    this.showing = null;
    this.el.hidden = true;
  }
}
