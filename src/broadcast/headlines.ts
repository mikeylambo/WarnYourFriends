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
 * the only place is the road at the first sighting (and road names on zone news), counts are
 * exact. Anti-repeat: no verb or place reused within the last 5 headlines.
 */

/** Facts about the giant right now, for places and subjects. */
/** Words that put him on a highway: only true there. */
const HIGHWAY_WORDS = /\b(interstate|highway|freeway|expressway)\b/i;
const onHighway = (zone: NewsContext['zone']) => zone === undefined || zone === 'highway';

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
  /** §21 headline tier from Ratings (0 SPOTTED … 3 CITY IN CHAOS). */
  ratingsTier: number;
  heat: number;
  /** Phase 2: the stretch of road he's on (a fact: zone kind and its name). */
  zone?: 'highway' | 'avenue' | 'bridge' | 'tunnel';
  zoneName?: string;
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
  /** Where he was when it happened: the place is a fact about this, not about publish time. */
  at?: NewsContext;
}

type Kind = 'zone' | 'spotted' | 'ratingsTier' | 'tierUp' | 'tierDown' | 'smash' | 'bounce' | 'wall' | 'merge' | 'escort' | 'ramHit' | 'ramMiss' | 'lostTrack' | 'spiked' | 'heat' | 'tell' | 'exitOpen' | 'end' | 'policeCrash' | 'policeSmash' | 'forkZone' | 'landmark' | 'netSlip' | 'netEscape';
/** `at`: where he was when it happened (places come from here, not from publish time). */
type Item = { kind: Kind; t: number; prio: number; events: SimEvent[]; at?: NewsContext };

const PRIO: Partial<Record<Kind, number>> = { netSlip: 96, netEscape: 74, landmark: 60, zone: 66, spotted: 95, ratingsTier: 100, end: 200, exitOpen: 90, tell: 75, ramHit: 65, ramMiss: 58, lostTrack: 57, spiked: 62, heat: 52, escort: 60, merge: 55, forkZone: 98, policeCrash: 70, policeSmash: 35, tierUp: 50, bounce: 45, tierDown: 40, wall: 10 };
/** These break in immediately, ignoring the 4s cadence (§21: tier changes; and the end of the broadcast). */
/** These break in now; `forkZone` is the new road after a fork (the cut needs its chyron). */
const IMMEDIATE: Kind[] = ['ratingsTier', 'end', 'exitOpen', 'forkZone'];

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
  private lastTier = 0;
  private lastRatings: SimEvent | null = null;
  /** Heat as last reported: only a rise is news (the Pose spends Heat; that's the pose's story). */
  private heatSeen = 0;

  constructor(seed: number, startHeat = 0) {
    this.rng = new Rng((seed ^ 0x6e657773) >>> 0);
    this.heatSeen = startHeat;
  }

  /** Feed every sim event. */
  observe(e: SimEvent, time: number) {
    const add = (kind: Kind) => this.queue.push({ kind, t: time, prio: PRIO[kind] ?? 0, events: [e], at: this.lastCtx ?? undefined });
    switch (e.type) {
      case 'ratings':
        this.lastRatings = e;
        break;
      // Rampage starting and ending are the only gear news (Jog and Stride are gone from the loop).
      case 'tierUp': if (e.tier === TUNING.tiers.length - 1) add('tierUp'); break;
      case 'tierDown': if (e.tier === TUNING.tiers.length - 2) add('tierDown'); break;
      case 'smash': {
        const open = this.queue.find((q) => q.kind === 'smash' && time - q.t <= TUNING.broadcast.tallyWindow);
        if (open) open.events.push(e);
        else this.queue.push({ kind: 'smash', t: time, prio: 0, events: [e], at: this.lastCtx ?? undefined });
        break;
      }
      case 'bounce': add('bounce'); break;
      case 'wallBump': if (!e.forced) add('wall'); break;
      case 'merge': add('merge'); break;
      case 'escortJoin': add('escort'); break;
      case 'ram': add(e.hit ? 'ramHit' : 'ramMiss'); break;
      // The chopper's search, light and loss are off the chyron (2026-11-26: not part of the game the player sees).
      case 'lostTrack': if (e.kind !== 'chopper') add('lostTrack'); break;
      case 'policeCrash': if (e.onAir) add('policeCrash'); break;
      case 'policeSmash': add('policeSmash'); break;
      case 'netSlip': add('netSlip'); break;
      case 'netEscape': add('netEscape'); break;
      case 'spiked': add('spiked'); break;
      case 'heat':
        if (this.heatSeen && e.heat > this.heatSeen) add('heat');
        this.heatSeen = e.heat;
        break;
      // Abilities (Leap, The Stare, Breakaway, Prime Time) are out of the game: no lines for them (2026-11-26).
      // Only the warnings for events that fill the screen: a Police Net closing, a Car Carrier dropping cars. A roadblock or
      // spike strip is past him before the line could air, so the chyron would report something he never saw (2026-11-26).
      case 'tell': if (e.kind === 'net' || e.kind === 'carrier') add('tell'); break;
      case 'exitOpen': add('exitOpen'); break;
      case 'fork':
        // Off the highway: queued road news (zones, merges) is about a road he's no longer on.
        if (e.taken) {
          this.queue = this.queue.filter((q) => q.kind !== 'zone' && q.kind !== 'merge');
          this.forkZoneNext = true;
        }
        break;
      case 'landmark': add('landmark'); break;
      case 'zone':
        add(this.forkZoneNext ? 'forkZone' : 'zone');
        this.forkZoneNext = false;
        break;
      case 'signOff':
      case 'busted':
        this.queue = [];
        add('end');
        break;
    }
  }

  /** A fork was just taken: the next zone event is the new road, and it breaks in. */
  private forkZoneNext = false;
  /** Where he was on the last update (an event observed now happened here). */
  private lastCtx: NewsContext | null = null;
  /** The zone the headline being composed is placed in (highway words only on highways). */
  private placeZone: NewsContext['zone'] = undefined;

  /** Publish a headline if one is due; returns it, else null. */
  update(ctx: NewsContext, propKind: (id: number) => PropKind | undefined): Headline | null {
    const B = TUNING.broadcast;
    const now = ctx.time;
    this.lastCtx = ctx;
    if (!this.spottedDone && now >= B.openAt) {
      this.spottedDone = true;
      this.queue.push({ kind: 'spotted', t: now, prio: PRIO.spotted ?? 0, events: [] });
    }
    // §21: a Ratings tier change breaks in, sourced from the Ratings event that crossed it.
    if (ctx.ratingsTier > this.lastTier && this.lastRatings) this.queue.push({ kind: 'ratingsTier', t: now, prio: PRIO.ratingsTier!, events: [this.lastRatings] });
    this.lastTier = Math.max(this.lastTier, ctx.ratingsTier);
    // Stale news is dropped, not shown late.
    const B0 = TUNING.broadcast;
    this.queue = this.queue.filter((q) => now - q.t <= B0.staleAfter || IMMEDIATE.includes(q.kind));
    if (!this.queue.length) return null;

    const tierUp = this.queue.filter((q) => IMMEDIATE.includes(q.kind)).sort((a, b) => b.prio - a.prio)[0];
    if (!tierUp && now - this.lastPublish < B.headlineEvery) return null;
    // Nothing is news before the sighting (a Ratings tier can still break in).
    if (!tierUp && !this.spottedDone) return null;
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
    // Rampage is the show (Mike, 2026-11-16): reaching it, and losing it, beat routine news to the chyron.
    const e0 = q.events[0];
    if (q.kind === 'tierUp' && e0?.type === 'tierUp' && e0.tier === TUNING.tiers.length - 1) return TUNING.broadcast.rampagePrio;
    if (q.kind === 'tierDown' && e0?.type === 'tierDown' && e0.tier === TUNING.tiers.length - 2) return TUNING.broadcast.rampageLostPrio;
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
    // A line that names the road type ("Tears Up The Interstate") is only true on a highway.
    const ok = lines.filter((l) => !used.has(l[0]) && (onHighway(this.placeZone) || !HIGHWAY_WORDS.test(l[1])));
    return ok.length ? this.rng.pick(ok) : null;
  }

  /**
   * Places only where they're news (2026-11-26, Mike: "City/street names only ever really need to show where
   * applicable"): the road he's on at the first sighting. Lanes, miles and compass points read as filler.
   */
  private roadPlace(ctx: NewsContext): string | null {
    const P = BANK.places;
    return ctx.zone && ctx.zoneName ? P.zone[ctx.zone].replace('{name}', ctx.zoneName) : null;
  }

  /** Break-ins alternate their red label: BREAKING, then LIVE REPORT (Mike, 2026-11-26). */
  private breakKicker(): string {
    const n = this.history.filter((h) => BANK.breaking.includes(h.kicker)).length;
    return BANK.breaking[n % BANK.breaking.length];
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

  private compose(q: Item, now: NewsContext, propKind: (id: number) => PropKind | undefined): Headline | null {
    // Facts about place come from where he was when it happened; the kicker and the time are now.
    const ctx: NewsContext = q.at ? { ...q.at, time: now.time, ratingsTier: now.ratingsTier, heat: now.heat } : now;
    this.placeZone = ctx.zone;
    const L = BANK.lines;
    const V = BANK.verbs;
    // UNREAL and CITY IN CHAOS take turns from 60% Audience up (Mike, 2026-11-26: CITY IN CHAOS is an alt for UNREAL).
    const top = BANK.kicker[Math.min(ctx.ratingsTier, BANK.kicker.length - 1)];
    const kicker = top === 'UNREAL' && this.history.filter((h) => h.kicker === 'UNREAL' || h.kicker === BANK.kickerAlt).length % 2 ? BANK.kickerAlt : top;
    const mk = (text: string, verb: string | null, place: string | null, breaking = false): Headline => ({ t: ctx.time, kicker: breaking ? this.breakKicker() : kicker, text, breaking, verb, place, sources: q.events, at: ctx });
    switch (q.kind) {
      case 'spotted': {
        const place = this.roadPlace(ctx);
        return mk(this.fill(L.spotted, { subject: this.subject(0), place }), 'Spotted', place);
      }
      case 'ratingsTier': {
        // §21: "Giant At Large. Warn Your Friends." the first time a run reaches AT LARGE.
        if (ctx.ratingsTier === 1 && !this.atLargeDone) {
          this.atLargeDone = true;
          return mk(L.atLarge, 'At Large', null, true);
        }
        const line = this.freshLine(L.ratingsTier[Math.min(ctx.ratingsTier, L.ratingsTier.length - 1)]);
        return line ? mk(line[1], line[0], null, true) : null;
      }
      case 'tierUp': {
        // Rampage starting is news, not BREAKING (Audience tiers are). "Resumes" / "Returns" only from the second.
        const line = this.freshLine(L.rampage);
        return line ? mk(this.fill(line[1], { subject: this.subject(TUNING.tiers.length - 1) }), line[0], null) : null;
      }
      case 'policeCrash':
      case 'policeSmash': {
        // What the cruiser hit, by name (a fact from the event).
        const e = q.events[0] as Extract<SimEvent, { type: 'policeCrash' | 'policeSmash' }>;
        const kind = e.type === 'policeCrash' ? e.propKind : propKind(e.propId);
        if (!kind) return null;
        const line = this.freshLine(L[q.kind]);
        if (!line) return null;
        const noun = e.type === 'policeCrash' && e.spikes ? L.spikeStrip : e.type === 'policeCrash' && e.offRoad ? L.guardrail : BANK.nouns[kind][0];
        return mk(this.fill(line[1], { noun }), line[0], null);
      }
      case 'netSlip': {
        // Caught once: it breaks in (the chyron says exactly what happened).
        const line = this.freshLine(q.events[0]?.type === 'netSlip' && q.events[0].cause === 'caught' ? L.caughtSlip : L.netSlip);
        return line ? mk(line[1], line[0], null, true) : null;
      }
      case 'netEscape':
      case 'ramHit':
      case 'ramMiss':
      case 'lostTrack':
      case 'spiked':
      case 'heat': {
        const line = this.freshLine(L[q.kind]);
        return line ? mk(this.fill(line[1], { subject: this.subject(ctx.tier) }), line[0], null) : null;
      }
      case 'tell': {
        const e = q.events[0] as Extract<SimEvent, { type: 'tell' }>;
        const line = this.freshLine(e.kind === 'net' ? L.tellNet : L.tellCarrier);
        return line ? mk(line[1], line[0], null) : null;
      }
      case 'forkZone':
      case 'zone': {
        const e = q.events[0] as Extract<SimEvent, { type: 'zone' }>;
        const line = this.freshLine(L.zone[e.zone]);
        if (!line) return null;
        // Off the highway at a fork: the station cut to a new road, so it breaks in.
        return mk(this.fill(line[1], { name: e.name }), line[0], null, q.kind === 'forkZone');
      }
      case 'landmark': {
        const e = q.events[0] as Extract<SimEvent, { type: 'landmark' }>;
        const line = this.freshLine(L.landmark[e.kind]);
        if (!line) return null;
        return mk(this.fill(line[1], { name: e.name }), line[0], null);
      }
      case 'exitOpen': {
        const h = mk(L.exitOpen, null, null, true);
        h.kicker = 'SIGN-OFF';
        return h;
      }
      case 'end': {
        const e = q.events[0];
        const h = mk(e.type === 'busted' ? L.busted[e.reason] : L.signOff, null, null, true);
        h.kicker = e.type === 'busted' ? (e.reason === 'pin' ? 'CAUGHT' : e.reason === 'ratings' ? 'CUT TO COMMERCIAL' : 'SIGNAL LOST') : 'SIGN-OFF';
        return h;
      }
      case 'tierDown': {
        const line = this.freshLine(L.rampageLost);
        return line ? mk(line[1], line[0], null) : null;
      }
      case 'smash': {
        // Report the heaviest kind smashed in the window, with its exact count.
        const smashes = q.events as Extract<SimEvent, { type: 'smash' }>[];
        const counts = new Map<PropKind, { n: number; heavy: boolean; across: boolean }>();
        for (const e of smashes) {
          const k = propKind(e.propId);
          if (!k || k === 'scoop') continue; // a Water Bottle is picked up, not smashed: never "Tramples Water Bottle"
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
        const text = c.n === 1 ? this.fill(L.smashOne, { subject: this.subject(ctx.tier), verb, noun: nouns[0] }) : this.fill(L.smashMany, { subject: this.subject(ctx.tier), verb, count: String(c.n), nouns: nouns[1] });
        // Only the smashes of the reported kind are this headline's sources.
        const h = mk(text, verb, null);
        h.sources = smashes.filter((e) => propKind(e.propId) === kind);
        return h;
      }
      case 'bounce': {
        const e = q.events[0] as Extract<SimEvent, { type: 'bounce' }>;
        const k = propKind(e.propId);
        const verb = this.freshVerb(V.bounce);
        if (!k || !verb) return null;
        return mk(this.fill(L.bounce, { subject: this.subject(ctx.tier), verb, noun: BANK.nouns[k][0] }), verb, null);
      }
      case 'wall': {
        const verb = this.freshVerb(V.wall);
        if (!verb) return null;
        return mk(this.fill(L.wall, { subject: this.subject(ctx.tier), verb }), verb, null);
      }
      case 'merge': {
        const e = q.events[0] as Extract<SimEvent, { type: 'merge' }>;
        const lanes = String(e.to);
        const line = this.freshLine(e.to < e.from ? L.narrows : L.widens);
        // Widening isn't news (Mike, 2026-11-26); a narrowing with no fresh line falls back to the plain count.
        if (!line) return e.to < e.from ? mk(this.fill(L.mergeFallback, { lanes }), null, null) : null;
        return mk(this.fill(line[1], { lanes }), line[0], null);
      }
      case 'escort': {
        // The first cruiser is news; the rest are the same story.
        if (this.escortCount++ > 0) return null;
        const [verb, text] = L.escort[0];
        return mk(text, verb, null);
      }
    }
  }
}
