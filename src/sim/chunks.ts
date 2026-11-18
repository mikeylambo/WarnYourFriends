import { TUNING } from '../tuning';
import type { PropKind } from './types';

/**
 * Authored traffic chunks (Mike, 2026-11-18: "make it an authored run"; random rows kept cheating him on 2- and
 * 3-lane roads). A chunk is a short stretch of hand-placed traffic for one lane count: rows at `ds` metres from
 * its start, one character per lane, left to right:
 *   .  empty     s  small thing (sawhorse / cart / scooter / fence: crumbles underfoot)
 *   c  car       v  van        n  rival news van (the one vehicle worth hitting)
 *   d  bulldozer b  concrete   f  food truck
 * Every chunk must pass `solve` from every entry lane (chunks.test.ts): there is always a line through at full
 * sprint, with only lane changes he has time to make. Pure data + maths: no DOM, no three.
 */
export interface Chunk {
  id: string;
  lanes: number;
  /** 1 (gentle) .. 5 (hard). The story's districts and endless mode pick by level. */
  level: number;
  rows: [number, string][];
  /** Only on these zones (absent: any). */
  zones?: string[];
}

export const CHUNKS: Chunk[] = [
  // --- Two lanes (bridges, tunnels) --------------------------------------------------------
  { id: 'two-slalom', lanes: 2, level: 1, rows: [[0, 'c.'], [34, '.c'], [68, 'c.'], [102, '.v']] },
  { id: 'two-trail', lanes: 2, level: 1, rows: [[0, 'c.'], [14, '.s'], [24, '.s'], [34, '.s'], [60, '.c'], [74, 's.'], [84, 's.']] },
  { id: 'two-pairs', lanes: 2, level: 1, rows: [[0, '.c'], [10, '.c'], [44, 'c.'], [54, 'v.']] },
  { id: 'two-van', lanes: 2, level: 2, rows: [[0, '.n'], [30, 'c.'], [58, '.v'], [72, 's.'], [100, '.c']] },
  { id: 'two-quick', lanes: 2, level: 2, rows: [[0, 'c.'], [28, '.v'], [56, 'c.'], [84, '.c'], [112, 'v.']] },
  { id: 'two-dozer', lanes: 2, level: 3, rows: [[0, 'd.'], [28, '.c'], [40, 's.'], [68, 'c.'], [82, '.s']] },
  { id: 'two-tight', lanes: 2, level: 4, rows: [[0, 'c.'], [25, '.c'], [50, 'c.'], [75, '.c'], [100, 'c.']] },
  { id: 'two-walls', lanes: 2, level: 5, rows: [[0, 'b.'], [24, '.v'], [48, 'd.'], [72, '.c'], [96, 'v.'], [120, '.d']] },

  // --- Three lanes (avenues) ------------------------------------------------------------------
  { id: 'three-gate', lanes: 3, level: 1, rows: [[0, 'c.c'], [32, '.c.'], [64, 'c.v']] },
  { id: 'three-trail', lanes: 3, level: 1, rows: [[0, '.c.'], [12, 's.s'], [24, 's.s'], [36, '.v.'], [62, 'c..']] },
  { id: 'three-steps', lanes: 3, level: 2, rows: [[0, 'cc.'], [32, '.cc'], [64, 'cc.']] },
  { id: 'three-market', lanes: 3, level: 2, zones: ['avenue'], rows: [[0, 'f.f'], [34, '.f.'], [46, 's.s'], [76, 'f.f']] },
  { id: 'three-rival', lanes: 3, level: 2, rows: [[0, 'c.c'], [26, 'cn.'], [52, '.cv'], [78, 's.s']] },
  { id: 'three-dozers', lanes: 3, level: 3, rows: [[0, 'd.c'], [30, '.v.'], [60, 'c.d'], [90, '.c.']] },
  { id: 'three-weave', lanes: 3, level: 4, rows: [[0, 'cv.'], [28, '.cv'], [56, 'c.v'], [84, 'vc.'], [112, '.cc']] },
  { id: 'three-gauntlet', lanes: 3, level: 5, rows: [[0, 'b.d'], [26, '.cc'], [52, 'd.c'], [78, '.vb'], [104, 'c.d']] },

  // --- Four lanes (highways) ------------------------------------------------------------------
  { id: 'four-scatter', lanes: 4, level: 1, rows: [[0, 'c..v'], [30, '.c..'], [60, '..vc'], [90, 'c...']] },
  { id: 'four-cones', lanes: 4, level: 1, rows: [[0, '.cc.'], [14, 's..s'], [26, 's..s'], [38, '.vv.'], [64, 'c..c']] },
  { id: 'four-dozers', lanes: 4, level: 2, rows: [[0, 'd..d'], [32, '.cc.'], [64, 'd..d']] },
  { id: 'four-rival', lanes: 4, level: 2, rows: [[0, 'cv.c'], [32, '.cnv'], [64, 'c.vc'], [92, 's.s.']] },
  { id: 'four-wall', lanes: 4, level: 3, rows: [[0, 'cvc.'], [36, '.cvc'], [72, 'cv.c']] },
  { id: 'four-zig', lanes: 4, level: 4, rows: [[0, 'ccc.'], [38, '.ccc'], [76, 'ccc.'], [114, 'c.cc']] },
  { id: 'four-blockade', lanes: 4, level: 5, rows: [[0, 'bdc.'], [34, 'c.vd'], [64, '.cbd'], [94, 'cv.d'], [124, 'd.cv']] },
];

/** The letters a chunk row may use, and what each places (`s` picks a small thing). */
export const CHUNK_KINDS: Record<string, PropKind | 'small'> = { c: 'car', v: 'van', n: 'newsvan', d: 'dozer', b: 'barricade', f: 'foodtruck', s: 'small' };
export const SMALL_KINDS: PropKind[] = ['sawhorse', 'cart', 'scooter', 'fence'];

export function chunkLength(c: Chunk): number {
  return c.rows[c.rows.length - 1][0];
}

/**
 * Can he get through? Rows block the lanes holding something he can't break in Stride (anything but `.`, `s` and
 * `n`). Between two rows `ds` apart he can shift `floor((ds − clear) / speed − react) / change)` lanes, where
 * `clear` is the room the props and his body take up. Starts from every lane, `lead` metres before the first row.
 * Returns the entry lanes that have no way through (empty: fair).
 */
export function solve(c: Chunk, opts = SOLVE): number[] {
  const free = (row: string, l: number) => row[l] === '.' || row[l] === 's' || row[l] === 'n';
  const shift = (ds: number) => Math.max(0, Math.floor(((ds - opts.clear) / opts.speed - opts.react) / opts.change));
  const stuck: number[] = [];
  for (let start = 0; start < c.lanes; start++) {
    let at = new Set([start]);
    let prev = -opts.lead;
    for (const [ds, row] of c.rows) {
      const k = shift(ds - prev);
      const next = new Set<number>();
      for (const l of at) for (let m = Math.max(0, l - k); m <= Math.min(c.lanes - 1, l + k); m++) if (free(row, m)) next.add(m);
      at = next;
      prev = ds;
      if (!at.size) break;
    }
    if (!at.size) stuck.push(start);
  }
  return stuck;
}

/**
 * Is there a line through these rows (`ds` from where he is, the lanes each one blocks) starting from `lane`?
 * Same lane-shift rule as `solve`. The prototype bot plans with it.
 */
export function pathFrom(lanes: number, lane: number, rows: { ds: number; blocked: Set<number> }[], opts = SOLVE): boolean {
  const shift = (ds: number) => Math.max(0, Math.floor(((ds - opts.clear) / opts.speed - opts.react) / opts.change));
  let at = new Set([lane]);
  let prev = 0;
  for (const r of rows) {
    const k = r.ds - prev < opts.clear ? 0 : shift(r.ds - prev + opts.clear * 0.5);
    const next = new Set<number>();
    for (const l of at) for (let m = Math.max(0, l - k); m <= Math.min(lanes - 1, l + k); m++) if (!r.blocked.has(m)) next.add(m);
    if (!next.size) return false;
    at = next;
    prev = r.ds;
  }
  return true;
}

/** The solver's assumptions: his top speed in a full sprint, Stride's lane change, a human's reaction, the gap before a chunk. */
export const SOLVE = {
  speed: TUNING.tiers[1].topSpeed + TUNING.proto.sprintBonus,
  change: TUNING.tiers[1].laneChangeTime,
  react: TUNING.proto.chunkReact,
  /** Car length plus his body (m): two rows closer than this are one wall. */
  clear: 8,
  lead: TUNING.proto.chunkGap,
};
