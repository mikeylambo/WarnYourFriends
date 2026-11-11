import { TUNING } from '../tuning';
import { Rng } from '../sim/rng';
import type { PropKind, SimEvent } from '../sim/types';
import BANK from './headlines.json';

/**
 * Phase 0c headline generator (GDD §21). Pure TS, seeded, no DOM.
 *
 * Grammar: [tier phrase] + [act] + [place]. Events are queued as they happen and
 * published at most every 4s; tier changes interrupt immediately as BREAKING.
 * The chyron never lies: every headline is built from events that happened,
 * places are facts about the giant right now (heading, lane, mile), counts are
 * exact. Anti-repeat: no verb or place reused within the last 5 headlines.
 */

/** Facts about the giant right now, for places and subjects. */
export interface NewsContext {
  time: number;
  tier: number;
  /** 0-based lane from the left. */
  lane: number;
  lanes: number;
  /** Road heading (radians; forward = (cos h, sin h) on XZ, −Z is north). */
  heading: number;
  /** Distance along the road (m). */
  s: number;
}

export interface Headline {
  t: number;
  kicker: string;
  text: string;
  breaking: boolean;
  verb: string | null;
  place: string | null;
  /** Events this headline reports (for the "chyron never lies" check). */
  sources: SimEvent[];
}

type Item = { kind: 'spotted' | 'tierUp' | 'tierDown' | 'smash' | 'bounce' | 'wall' | 'merge' | 'escort'; t: number; prio: number; events: SimEvent[] };

const PRIO = { spotted: 70, tierUp: 100, escort: 60, merge: 55, bounce: 45, tierDown: 40, wall: 10 } as const;

/** Compass direction of travel: −Z is north, +X is east. */
export function compass(heading: number): 'North' | 'East' | 'South' | 'West' {
  const north = -Math.sin(heading);
  const east = Math.cos(heading);
  const b = (Math.atan2(east, north) * 180) / Math.PI; // 0 = north, 90 = east
  const n = (((Math.round(b / 90) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
  return (['North', 'East', 'South', 'West'] as const)[n];
}

export class Newsroom {
  readonly history: Headline[] = [];
  private queue: Item[] = [];
  private rng: Rng;
  private lastPublish = -Infinity;
  private atLargeDone = false;
  private spottedDone = false;
  private escortCount = 0;
  private rampages = 0;

  constructor(seed: number) {
    this.rng = new Rng((seed ^ 0x6e657773) >>> 0);
  }

  /** Feed every sim event. */
  observe(e: SimEvent, time: number) {
    switch (e.type) {
      case 'tierUp':
        this.queue.push({ kind: 'tierUp', t: time, prio: PRIO.tierUp, events: [e] });
        break;
      case 'tierDown':
        this.queue.push({ kind: 'tierDown', t: time, prio: PRIO.tierDown, events: [e] });
        break;
      case 'smash': {
        const open = this.queue.find((q) => q.kind === 'smash' && time - q.t <= TUNING.broadcast.tallyWindow);
        if (open) open.events.push(e);
        else this.queue.push({ kind: 'smash', t: time, prio: 0, events: [e] });
        break;
      }
      case 'bounce':
        this.queue.push({ kind: 'bounce', t: time, prio: PRIO.bounce, events: [e] });
        break;
      case 'wallBump':
        if (!e.forced) this.queue.push({ kind: 'wall', t: time, prio: PRIO.wall, events: [e] });
        break;
      case 'merge':
        this.queue.push({ kind: 'merge', t: time, prio: PRIO.merge, events: [e] });
        break;
      case 'escortJoin':
        this.queue.push({ kind: 'escort', t: time, prio: PRIO.escort, events: [e] });
        break;
    }
  }

  /** Publish a headline if one is due; returns it, else null. */
  update(ctx: NewsContext, propKind: (id: number) => PropKind | undefined): Headline | null {
    const B = TUNING.broadcast;
    const now = ctx.time;
    if (!this.spottedDone && now >= B.openAt) {
      this.spottedDone = true;
      this.queue.push({ kind: 'spotted', t: now, prio: PRIO.spotted, events: [] });
    }
    // Stale news is dropped, not shown late.
    this.queue = this.queue.filter((q) => now - q.t <= 6 || q.kind === 'tierUp');
    if (!this.queue.length) return null;

    // Tier changes interrupt immediately (BREAKING); everything else waits for the 4s cadence.
    const tierUp = this.queue.find((q) => q.kind === 'tierUp');
    if (!tierUp && now - this.lastPublish < B.headlineEvery) return null;
    // Smash tallies keep counting until their window closes or the slot would otherwise go empty.
    const ready = this.queue.filter((q) => q.kind !== 'smash' || now - q.t >= B.tallyWindow || this.queue.length === 1 || now - q.t >= 1.5);
    const pick = tierUp ?? ready.sort((a, b) => this.prioOf(b) - this.prioOf(a) || b.t - a.t)[0];
    if (!pick) return null;
    this.queue.splice(this.queue.indexOf(pick), 1);
    const h = this.compose(pick, ctx, propKind);
    if (!h) return null;
    this.lastPublish = now;
    this.history.push(h);
    if (this.history.length > 50) this.history.shift();
    return h;
  }

  private prioOf(q: Item): number {
    if (q.kind !== 'smash') return q.prio;
    const heavy = q.events.some((e) => e.type === 'smash' && e.cls === 'heavy');
    return (heavy ? 50 : 30) + q.events.length;
  }

  private recent(): Headline[] {
    return this.history.slice(-TUNING.broadcast.antiRepeat);
  }

  /** Pick a word not used as a verb in the last 5 headlines (null if all were). */
  private freshVerb(options: string[]): string | null {
    const used = new Set(this.recent().map((h) => h.verb));
    const ok = options.filter((v) => !used.has(v));
    return ok.length ? this.rng.pick(ok) : null;
  }

  /** A [verb, template] line whose verb wasn't used in the last 5 headlines. */
  private freshLine(lines: string[][]): string[] | null {
    const used = new Set(this.recent().map((h) => h.verb));
    const ok = lines.filter((l) => !used.has(l[0]));
    return ok.length ? this.rng.pick(ok) : null;
  }

  /** True places for the giant right now, minus any used in the last 5 headlines. */
  private freshPlace(ctx: NewsContext): string | null {
    const P = BANK.places;
    const all = [...P.road, P.bound.replace('{dir}', compass(ctx.heading)), P.lane.replace('{n}', String(ctx.lane + 1)), P.mile.replace('{m}', (ctx.s / 1609.344).toFixed(1))];
    if (ctx.lanes > 1 && ctx.lane === 0) all.push(P.fast);
    if (ctx.lanes > 1 && ctx.lane === ctx.lanes - 1) all.push(P.slow);
    const used = new Set(this.recent().map((h) => h.place));
    const ok = all.filter((p) => !used.has(p));
    return ok.length ? this.rng.pick(ok) : null;
  }

  private subject(tier: number): string {
    return this.rng.pick(BANK.subject[Math.min(tier, BANK.subject.length - 1)]);
  }

  private fill(tpl: string, vars: Record<string, string | null>): string {
    return tpl
      .replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? '')
      .replace(/\s+/g, ' ')
      .replace(/\s+([;,.])/g, '$1')
      .trim();
  }

  private compose(q: Item, ctx: NewsContext, propKind: (id: number) => PropKind | undefined): Headline | null {
    const L = BANK.lines;
    const V = BANK.verbs;
    const kicker = BANK.kicker[Math.min(ctx.tier, BANK.kicker.length - 1)];
    const mk = (text: string, verb: string | null, place: string | null, breaking = false): Headline => ({ t: ctx.time, kicker: breaking ? 'BREAKING' : kicker, text, breaking, verb, place, sources: q.events });
    switch (q.kind) {
      case 'spotted': {
        const place = this.freshPlace(ctx);
        return mk(this.fill(L.spotted, { subject: this.subject(0), place }), 'Spotted', place);
      }
      case 'tierUp': {
        const e = q.events[0] as Extract<SimEvent, { type: 'tierUp' }>;
        if (e.tier === 1 && !this.atLargeDone) {
          this.atLargeDone = true;
          return mk(L.atLarge, 'At Large', null, true);
        }
        // Tier changes always break in; with every phrasing used recently, a verbless line keeps anti-repeat true.
        const place = this.freshPlace(ctx);
        // "Returns"/"Resumes" only once Rampage has actually happened before.
        const pool = e.tier >= 2 ? L.rampage.filter((l) => this.rampages > 0 || !['Returns', 'Resumes'].includes(l[0])) : L.stride;
        if (e.tier >= 2) this.rampages++;
        const line = this.freshLine(pool);
        if (!line) return mk(e.tier >= 2 ? L.rampageFallback : `${this.subject(e.tier)}: ${BANK.kicker[1]}`, null, null, true);
        return mk(this.fill(line[1], { subject: this.subject(e.tier), place }), line[0], place, true);
      }
      case 'tierDown': {
        const verb = this.freshVerb(V.slow);
        if (!verb) return null;
        const place = this.freshPlace(ctx);
        return mk(this.fill(L.slowed, { subject: this.subject(ctx.tier), verb, place }), verb, place);
      }
      case 'smash': {
        // Report the heaviest kind smashed in the window, with its exact count.
        const smashes = q.events as Extract<SimEvent, { type: 'smash' }>[];
        const counts = new Map<PropKind, { n: number; heavy: boolean; across: boolean }>();
        for (const e of smashes) {
          const k = propKind(e.propId);
          if (!k) continue;
          const c = counts.get(k) ?? { n: 0, heavy: e.cls === 'heavy', across: false };
          c.n++;
          c.across ||= e.across;
          counts.set(k, c);
        }
        const best = [...counts.entries()].sort((a, b) => Number(b[1].heavy) - Number(a[1].heavy) || b[1].n - a[1].n)[0];
        if (!best) return null;
        const [kind, c] = best;
        const nouns = BANK.nouns[kind];
        const verbs = c.n === 1 && c.across ? V.across : c.heavy ? V.heavy : V.medium;
        const verb = this.freshVerb(verbs) ?? this.freshVerb(c.heavy ? V.heavy : V.medium);
        if (!verb) return null;
        const place = this.freshPlace(ctx);
        const text = c.n === 1 ? this.fill(L.smashOne, { subject: this.subject(ctx.tier), verb, noun: nouns[0], place }) : this.fill(L.smashMany, { subject: this.subject(ctx.tier), verb, count: String(c.n), nouns: nouns[1], place });
        // Only the smashes of the reported kind are this headline's sources.
        const h = mk(text, verb, place);
        h.sources = smashes.filter((e) => propKind(e.propId) === kind);
        return h;
      }
      case 'bounce': {
        const e = q.events[0] as Extract<SimEvent, { type: 'bounce' }>;
        const k = propKind(e.propId);
        const verb = this.freshVerb(V.bounce);
        if (!k || !verb) return null;
        const place = this.freshPlace(ctx);
        return mk(this.fill(L.bounce, { subject: this.subject(ctx.tier), verb, noun: BANK.nouns[k][0], place }), verb, place);
      }
      case 'wall': {
        const verb = this.freshVerb(V.wall);
        if (!verb) return null;
        const place = this.freshPlace(ctx);
        return mk(this.fill(L.wall, { subject: this.subject(ctx.tier), verb, place }), verb, place);
      }
      case 'merge': {
        const e = q.events[0] as Extract<SimEvent, { type: 'merge' }>;
        const lanes = String(e.to);
        const line = this.freshLine(e.to < e.from ? L.narrows : L.widens);
        if (!line) return mk(this.fill(L.mergeFallback, { lanes }), null, null);
        return mk(this.fill(line[1], { lanes }), line[0], null);
      }
      case 'escort': {
        const [verb, tpl] = L.escort[Math.min(this.escortCount++, L.escort.length - 1)];
        if (this.recent().some((h) => h.verb === verb)) return null;
        const place = tpl.includes('{place}') ? this.freshPlace(ctx) : null;
        return mk(this.fill(tpl, { place }), verb, place);
      }
    }
  }
}
