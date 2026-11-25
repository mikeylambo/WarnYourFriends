import { TUNING } from '../tuning';
import type { PropKind } from './types';

/**
 * Authored traffic chunks (Mike, 2026-11-18: "make it an authored run"; random rows kept cheating him on 2- and
 * 3-lane roads). A chunk is a short stretch of hand-placed traffic for one lane count: rows at `ds` metres from
 * its start, one character per lane, left to right:
 *   .  empty     s  a Scoop (a collectible: run through it for audience and points)
 *   c  car       v  van        n  rival news van (the one vehicle worth hitting)
 *   d  bulldozer b  concrete   f  food truck
 *   o  oncoming car (only in `oncoming` lanes; drives at him)   t  slow box truck (his way, slower than him)
 * Oncoming lanes and a slow truck's lane are closed to the solver (he may take them, never has to): the chunk
 * must be passable on the rest alone, without crossing them. So moving traffic is a risk he chooses, never a wall.
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
  /** Two-way stretch: 'o' marks the lanes that drive toward him (e.g. 'oo..'). Absent: every lane goes his way. */
  oncoming?: string;
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
  // Harder two-lane stretches (Mike, 2026-11-19: "the two lane portions could be harder"): a switch every 24m,
  // one metre over the tightest the solver passes at full sprint (23m).
  { id: 'two-squeeze', lanes: 2, level: 3, zones: ['bridge'], rows: [[0, 'c.'], [24, '.c'], [48, 'c.'], [72, '.v'], [84, 'n.'], [98, 'c.'], [122, '.c']] },
  { id: 'two-rush', lanes: 2, level: 4, zones: ['bridge'], rows: [[0, '.v'], [24, 'c.'], [48, '.c'], [72, 'v.'], [96, '.c'], [120, 'c.'], [144, '.v']] },
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
  // Cars that commit to a lane change (Mike, 2026-11-24): they signal as he closes in, then move over and stay.
  { id: 'three-merge', lanes: 3, level: 2, rows: [[0, 'r..'], [30, '.c.'], [60, '..l'], [92, 'c..']] },
  { id: 'three-switch', lanes: 3, level: 3, rows: [[0, '.r.'], [28, 'c..'], [56, '..l'], [84, '.c.'], [112, '.l.']] },
  { id: 'four-merge', lanes: 4, level: 2, rows: [[0, 'r..c'], [30, '..l.'], [60, 'c.r.'], [92, '...l']] },
  { id: 'four-cutin', lanes: 4, level: 4, rows: [[0, 'c.r.'], [32, '.l.c'], [64, 'r..v'], [96, '.c.l'], [128, '.cr.']] },
  { id: 'four-rival', lanes: 4, level: 2, rows: [[0, 'cv.c'], [32, '.cnv'], [64, 'c.vc'], [92, 's.s.']] },
  { id: 'four-wall', lanes: 4, level: 3, rows: [[0, 'cvc.'], [36, '.cvc'], [72, 'cv.c']] },
  { id: 'four-zig', lanes: 4, level: 4, rows: [[0, 'ccc.'], [38, '.ccc'], [76, 'ccc.'], [114, 'c.cc']] },
  // Two-way expressway (Mike, 2026-11-18): the left lanes come at him. Optional lanes, so never a forced hit.
  { id: 'four-oncoming', lanes: 4, level: 4, zones: ['highway', 'tunnel'], oncoming: 'oo..', rows: [[0, 'o.c.'], [20, '.o..'], [30, 'o..c'], [48, '.o..'], [60, 'n.c.'], [76, 'o...'], [92, '.o.c']] },
  { id: 'four-oncoming-rush', lanes: 4, level: 5, zones: ['highway', 'tunnel'], oncoming: 'oo..', rows: [[0, 'o.v.'], [14, '.o..'], [30, 'o..c'], [44, '.o.s'], [62, 'oo.v'], [94, 'o.c.'], [108, '.o..']] },
  // Two-way tunnel (Mike, 2026-11-19: "one of them could be a 4 laner, with 2 directions (tunnel maybe)").
  { id: 'tunnel-two-way', lanes: 4, level: 3, zones: ['tunnel'], oncoming: 'oo..', rows: [[0, 'o.c.'], [12, '.o..'], [24, 'o..c'], [48, '.oc.'], [60, 'o...'], [72, '.o.v'], [96, 'o.c.']] },
  { id: 'tunnel-rush', lanes: 4, level: 4, zones: ['tunnel'], oncoming: 'oo..', rows: [[0, 'o.v.'], [10, '.o..'], [24, 'oo.c'], [48, '.ov.'], [58, 'o...'], [72, '.o.v'], [96, 'o.cs'], [106, '.o..'], [120, 'o.c.']] },
  // Long and slow (box trucks): its lane is closed for the chunk; he overtakes on the open side.
  { id: 'four-convoy', lanes: 4, level: 3, rows: [[0, '.t.c'], [30, 'c.c.'], [60, '..c.'], [88, 's..c']] },
  { id: 'three-truck', lanes: 3, level: 3, rows: [[0, 't.c'], [30, '.c.'], [60, '..c'], [86, 's.s']] },
  // --- Six lanes (the finale's grand expressway, Mike 2026-11-18: "cover art has a 6-lane highway") -------------
  { id: 'six-flow', lanes: 6, level: 4, rows: [[0, 'c..v.c'], [30, '.c..c.'], [60, 'c.v..c'], [90, '..c.v.']] },
  { id: 'six-convoy', lanes: 6, level: 4, rows: [[0, 'c.t.c.'], [32, '.c..cv'], [64, 'c...c.'], [94, '.c.s.c']] },
  { id: 'six-rival', lanes: 6, level: 5, rows: [[0, 'cvn.vc'], [30, '.c.c.v'], [60, 'v.c.c.'], [90, '.vncv.']] },
  { id: 'six-two-way', lanes: 6, level: 5, oncoming: 'ooo...', rows: [[0, 'o.o..v'], [22, '.o....'], [34, 'o.o.c.'], [50, '.o.s..'], [66, 'oo.v.c'], [96, 'o.o.c.'], [110, '.o....']] },
  // The finale is two-way the whole way (2026-11-19): more six-lane chunks with the left three oncoming.
  { id: 'six-two-way-flow', lanes: 6, level: 4, oncoming: 'ooo...', rows: [[0, 'o.o.c.'], [24, '.o...c'], [48, 'o.oc..'], [72, '.o..v.'], [96, 'o.o..c']] },
  { id: 'six-two-way-dense', lanes: 6, level: 5, oncoming: 'ooo...', rows: [[0, 'oo...v'], [24, '.o.v.c'], [48, 'o.oc.c'], [72, '.o..v.'], [84, 'o.o...'], [96, 'oo.c.v'], [120, '.o.vc.']] },
  // The finale is the run's peak (2026-11-24: the tunnel out-hit it): the forward side squeezed to one or two open lanes.
  { id: 'six-two-way-squeeze', lanes: 6, level: 5, oncoming: 'ooo...', rows: [[0, 'o.o.cv'], [24, '.o.c.v'], [48, 'o.ocv.'], [72, '.o.c.v'], [96, '.o..cv']] },
  { id: 'six-two-way-weave', lanes: 6, level: 5, oncoming: 'ooo...', rows: [[0, 'o.o.cc'], [28, '.o.cc.'], [56, 'o.o.cv'], [84, '.o.vc.'], [112, 'oo..vc']] },
  { id: 'four-blockade', lanes: 4, level: 5, rows: [[0, 'bdc.'], [34, 'c.vd'], [64, '.cbd'], [94, 'cv.d'], [124, 'd.cv']] },
];

/**
 * The teaching opening (Mike, 2026-11-24: "teach by doing"): the first chunk of a player's very first broadcast.
 * A car straight ahead in his starting lane (the swipe), a row of Exclusives across every lane (the pickup), then
 * single cars spaced for easy near misses. Never picked otherwise. He starts in lane floor(lanes / 2).
 */
export const TUTORIAL: Chunk[] = [
  { id: 'tutorial-4', lanes: 4, level: 0, rows: [[0, '..c.'], [50, 'ssss'], [95, '.c..'], [135, '...c'], [175, 'c...'], [210, 'ssss']] },
  { id: 'tutorial-3', lanes: 3, level: 0, rows: [[0, '.c.'], [50, 'sss'], [95, 'c..'], [135, '..c'], [175, '.c.'], [210, 'sss']] },
];

/** The letters a chunk row may use, and what each places (`s` picks a small thing). */
export const CHUNK_KINDS: Record<string, PropKind | 'small'> = { c: 'car', v: 'van', n: 'newsvan', d: 'dozer', b: 'barricade', f: 'foodtruck', s: 'scoop', o: 'car', t: 'foodtruck', l: 'car', r: 'car' };

/** Lanes the solver can't use in a chunk: its oncoming lanes and any slow truck's lane. */
export function closedLanes(c: Chunk): Set<number> {
  const out = new Set<number>();
  for (let l = 0; l < c.lanes; l++) if (c.oncoming?.[l] === 'o' || c.rows.some(([, r]) => r[l] === 't')) out.add(l);
  return out;
}

/** The same chunk with left and right swapped (endless mode: two-way stretches can run either side). */
export function mirror(c: Chunk): Chunk {
  const rev = (s: string) => [...s].reverse().join('');
  // A lane-changer mirrored moves the other way.
  const flip = (s: string) => rev(s).replace(/[lr]/g, (x) => (x === 'l' ? 'r' : 'l'));
  return { ...c, id: `${c.id}-mirrored`, rows: c.rows.map(([ds, r]) => [ds, flip(r)] as [number, string]), ...(c.oncoming ? { oncoming: rev(c.oncoming) } : {}) };
}
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
  const closed = closedLanes(c);
  // A lane-changer ('l' moves one lane left, 'r' one right) blocks its own lane and the one it moves into, for the
  // whole row: wherever it is when he gets there, the line holds (2026-11-24).
  const free = (row: string, l: number) => !closed.has(l) && (row[l] === '.' || row[l] === 's' || row[l] === 'n') && row[l + 1] !== 'l' && row[l - 1] !== 'r';
  const shift = (ds: number) => Math.max(0, Math.floor(((ds - opts.clear) / opts.speed - opts.react) / opts.change));
  const stuck: number[] = [];
  for (let start = 0; start < c.lanes; start++) {
    let at = new Set([start]);
    let prev = -opts.lead;
    for (const [ds, row] of c.rows) {
      // A row with nothing on the open side (only oncoming cars) asks nothing of him: it doesn't split the gap.
      if (Array.from({ length: c.lanes }, (_, l) => l).every((l) => closed.has(l) || free(row, l))) continue;
      const k = shift(ds - prev);
      const next = new Set<number>();
      // Never across a closed lane: a lane change through a truck or the oncoming side isn't a line he can count on.
      // (The run-up before the first row is clear: there he can cross anything.)
      const first = prev === -opts.lead;
      for (const l of at) {
        for (let m = l; m >= Math.max(0, l - k) && (first || !closed.has(m)); m--) if (free(row, m)) next.add(m);
        for (let m = l; m <= Math.min(c.lanes - 1, l + k) && (first || !closed.has(m)); m++) if (free(row, m)) next.add(m);
      }
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
