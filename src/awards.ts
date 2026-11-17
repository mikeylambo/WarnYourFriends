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
}

const KEY = 'wyf.awards.v1';
const fresh = (): Profile => ({ counts: { signOffs: 0, policeWrecked: 0, objects: 0, bestSegment: 0, runsWon: 0 }, won: [], outfit: 'classic' });

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

/** The meeting's pool for this player: everything but the upgrades still locked. */
export function upgradePool(p: Profile): UpgradeId[] {
  return ALL_UPGRADES.filter((u) => !LOCKED_UPGRADES.includes(u) || AWARDS.some((a) => a.upgrade === u && p.won.includes(a.id)));
}

export function outfitUnlocked(p: Profile, id: OutfitId): boolean {
  return id === 'classic' || AWARDS.some((a) => a.outfit === id && p.won.includes(a.id));
}

/** What an award gives, in a line ("Breakaway joins the Producer's Meeting"). */
export function rewardLine(a: Award): string {
  if (a.upgrade) return `${TUNING.upgrades[a.upgrade].label} joins the Producer's Meeting`;
  if (a.outfit) return `New outfit: ${TUNING.outfits[a.outfit].label}`;
  return '';
}
