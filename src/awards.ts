import { TUNING, type OutfitId, type UpgradeId } from './tuning';
import { ALL_UPGRADES } from './sim/run';

/**
 * The Local News Awards (Mike, 2026-11-17: "Unlocks and Awards is cool"). Lifetime counters kept in this browser;
 * each award is a milestone on one of them, and some unlock something: an upgrade joins the Producer's Meeting
 * (variety, never raw power: the leaderboard stays fair) or an outfit (a recolor). Presentation-side: the sim never
 * reads it; the run takes the unlocked pool as an input (and the leaderboard replays it with the same pool).
 */
export type AwardId = 'liveAtEleven' | 'specialReport' | 'pursuitOfTheYear' | 'regularFixture' | 'trafficHazard' | 'seasonFinale' | 'lifetime';
type Stat = 'signOffs' | 'policeWrecked' | 'objects' | 'bestSegment' | 'runsWon';

export interface Award {
  id: AwardId;
  title: string;
  how: string;
  stat: Stat;
  n: number;
  upgrade?: UpgradeId;
  outfit?: OutfitId;
}

export const AWARDS: Award[] = [
  { id: 'liveAtEleven', title: 'Live at Eleven', how: 'Sign off once', stat: 'signOffs', n: 1 },
  { id: 'specialReport', title: 'Special Report', how: 'Reach segment 3 of a broadcast', stat: 'bestSegment', n: 3, upgrade: 'breakaway' },
  { id: 'pursuitOfTheYear', title: 'Pursuit of the Year', how: 'Lead 10 police cars into a crash', stat: 'policeWrecked', n: 10, upgrade: 'slipstream' },
  { id: 'regularFixture', title: 'Regular Fixture', how: 'Sign off 3 times', stat: 'signOffs', n: 3, outfit: 'midnight' },
  { id: 'trafficHazard', title: 'Traffic Hazard of the Year', how: 'Lead 25 police cars into a crash', stat: 'policeWrecked', n: 25, outfit: 'parade' },
  { id: 'seasonFinale', title: 'Season Finale', how: 'Finish all five segments', stat: 'runsWon', n: 1, outfit: 'gold' },
  { id: 'lifetime', title: 'Lifetime Achievement', how: 'Flatten 1,000 objects', stat: 'objects', n: 1000 },
];

/** Upgrades that start locked: an award brings each into the Producer's Meeting. */
export const LOCKED_UPGRADES: UpgradeId[] = AWARDS.flatMap((a) => (a.upgrade ? [a.upgrade] : []));

export interface Profile {
  counts: Record<Stat, number>;
  won: AwardId[];
  outfit: OutfitId;
  /** Editions (2026-11-17): the hardest unlocked (0 = Evening News), and the one picked on the menu. */
  edition: number;
  chosenEdition: number;
  /** Story asks done in any run (2026-11-19), and the traffic mods switched on. */
  asksDone: string[];
  mods: string[];
}

const KEY = 'wyf.awards.v1';
const fresh = (): Profile => ({ counts: { signOffs: 0, policeWrecked: 0, objects: 0, bestSegment: 0, runsWon: 0 }, won: [], outfit: 'classic', edition: 0, chosenEdition: 0, asksDone: [], mods: [] });

export function loadProfile(): Profile {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Profile> | null;
    if (!raw || typeof raw !== 'object') return fresh();
    const p = fresh();
    for (const k of Object.keys(p.counts) as Stat[]) {
      const v = raw.counts?.[k];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) p.counts[k] = Math.floor(v);
    }
    p.won = Array.isArray(raw.won) ? raw.won.filter((id): id is AwardId => AWARDS.some((a) => a.id === id)) : [];
    p.outfit = raw.outfit && raw.outfit in TUNING.outfits && outfitUnlocked(p, raw.outfit) ? raw.outfit : 'classic';
    const ed = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? Math.max(0, Math.min(TUNING.editions.length - 1, v)) : 0);
    p.edition = ed(raw.edition);
    p.chosenEdition = Math.min(p.edition, ed(raw.chosenEdition));
    const ids = (v: unknown, ok: (x: string) => boolean) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && ok(x)) : []);
    p.asksDone = ids(raw.asksDone, (x) => TUNING.proto.storyAsks.some((a) => a.id === x));
    p.mods = ids(raw.mods, (x) => modUnlocked(p, x));
    return p;
  } catch {
    return fresh();
  }
}

export function saveProfile(p: Profile) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable: progress lasts this session */
  }
}

/** What one broadcast segment adds to the counters. */
export interface SegmentTally {
  signedOff: boolean;
  policeWrecked: number;
  objects: number;
  /** Segment number reached (1-based). */
  segment: number;
  runWon: boolean;
}

/** Add a segment to the counters; returns the awards it won (newly). */
export function record(p: Profile, t: SegmentTally): Award[] {
  const c = p.counts;
  if (t.signedOff) c.signOffs++;
  c.policeWrecked += Math.max(0, Math.floor(t.policeWrecked));
  c.objects += Math.max(0, Math.floor(t.objects));
  c.bestSegment = Math.max(c.bestSegment, t.segment);
  if (t.runWon) c.runsWon++;
  const now: Award[] = [];
  for (const a of AWARDS) {
    if (!p.won.includes(a.id) && c[a.stat] >= a.n) {
      p.won.push(a.id);
      now.push(a);
    }
  }
  return now;
}

/** A full run won at the edition he chose: the next edition unlocks (returns its index, or -1). */
export function unlockEdition(p: Profile): number {
  if (p.chosenEdition < p.edition || p.edition >= TUNING.editions.length - 1) return -1;
  p.edition++;
  p.chosenEdition = p.edition; // straight onto the new one (the menu can step back)
  return p.edition;
}

/** The meeting's pool for this player: everything but the upgrades still locked. */
export function upgradePool(p: Profile): UpgradeId[] {
  return ALL_UPGRADES.filter((u) => !LOCKED_UPGRADES.includes(u) || AWARDS.some((a) => a.upgrade === u && p.won.includes(a.id)));
}

export function outfitUnlocked(p: Profile, id: OutfitId): boolean {
  return id === 'classic' || AWARDS.some((a) => a.outfit === id && p.won.includes(a.id));
}

/** What an award gives, in a line ("Unlocks Breakaway"). */
export function rewardLine(a: Award): string {
  if (a.upgrade) return `Unlocks ${TUNING.upgrades[a.upgrade].label}`;
  if (a.outfit) return `New outfit: ${TUNING.outfits[a.outfit].label}`;
  return '';
}

/** A traffic mod is unlocked once the story ask that unlocks it is done. */
export function modUnlocked(p: Profile, id: string): boolean {
  return TUNING.proto.storyAsks.some((a) => a.unlock === id && p.asksDone.includes(a.id));
}

/** Story asks a player can pick now (their prerequisite done), and the ones still locked. */
export function storyAskOffer(p: Profile, pickRandom: (n: number) => number): { open: typeof TUNING.proto.storyAsks; locked: typeof TUNING.proto.storyAsks } {
  const P = TUNING.proto;
  const open: typeof P.storyAsks = [];
  const locked: typeof P.storyAsks = [];
  for (const tier of [1, 2, 3] as const) {
    const all = P.storyAsks.filter((a) => a.tier === tier);
    const can = all.filter((a) => !a.requires || p.asksDone.includes(a.requires));
    // Fresh ones first, then ones he's done before; shuffled within each.
    const fresh = can.filter((a) => !p.asksDone.includes(a.id));
    const again = can.filter((a) => p.asksDone.includes(a.id));
    for (const list of [fresh, again])
      for (let i = list.length - 1; i > 0; i--) {
        const j = pickRandom(i + 1);
        [list[i], list[j]] = [list[j], list[i]];
      }
    // Done before: only offered again when there's nothing new at that tier (Mike, 2026-11-24: finished asks kept coming back).
    open.push(...(fresh.length ? fresh : again).slice(0, P.storyOffer[tier - 1]));
    locked.push(...all.filter((a) => !can.includes(a)).slice(0, 1));
  }
  // Always a real choice (release pass, 2026-11-24): a new player has few asks open, so top up with easy ones
  // until there's at least one more on offer than he picks.
  for (const a of P.storyAsks)
    if (open.length < P.storyPick + P.storySpare && a.tier === 1 && !open.includes(a)) open.splice(open.filter((x) => x.tier === 1).length, 0, a);
  return { open, locked };
}
