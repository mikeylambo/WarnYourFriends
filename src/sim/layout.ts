import { TUNING, type MassClass } from '../tuning';
import { Rng } from './rng';
import type { Material, Ped, Prop, PropKind } from './types';

/**
 * Phase 0 test block: a seeded grid of 60m cells with buildings, alleys,
 * plazas and lots, dressed with breakable props. Not the §16 procedural
 * block assembler yet (that is Phase 1); just enough city to run through.
 */

interface PropDef {
  cls: MassClass;
  mat: Material;
  hw: number;
  hd: number;
  h: number;
  variants: number;
}

export const PROP_DEFS: Record<PropKind, PropDef> = {
  bin: { cls: 'light', mat: 'metal', hw: 0.35, hd: 0.35, h: 1.0, variants: 2 },
  mailbox: { cls: 'light', mat: 'metal', hw: 0.3, hd: 0.3, h: 1.25, variants: 1 },
  newsbox: { cls: 'light', mat: 'paper', hw: 0.35, hd: 0.3, h: 1.1, variants: 3 },
  cart: { cls: 'light', mat: 'fruit', hw: 0.8, hd: 0.5, h: 1.1, variants: 3 },
  planter: { cls: 'light', mat: 'wood', hw: 0.45, hd: 0.45, h: 0.8, variants: 1 },
  stall: { cls: 'medium', mat: 'fruit', hw: 1.6, hd: 1.1, h: 2.4, variants: 4 },
  fence: { cls: 'medium', mat: 'wood', hw: 2.5, hd: 0.15, h: 1.2, variants: 1 },
  bench: { cls: 'medium', mat: 'wood', hw: 1.0, hd: 0.35, h: 0.6, variants: 1 },
  bikerack: { cls: 'medium', mat: 'metal', hw: 1.3, hd: 0.3, h: 0.9, variants: 1 },
  car: { cls: 'heavy', mat: 'metal', hw: 2.2, hd: 0.95, h: 1.5, variants: 5 },
  van: { cls: 'heavy', mat: 'metal', hw: 2.7, hd: 1.1, h: 2.3, variants: 3 },
  barricade: { cls: 'heavy', mat: 'concrete', hw: 1.8, hd: 0.35, h: 0.95, variants: 1 },
  pillar: { cls: 'immovable', mat: 'concrete', hw: 0.6, hd: 0.6, h: 4.5, variants: 1 },
  building: { cls: 'immovable', mat: 'concrete', hw: 1, hd: 1, h: 10, variants: 6 },
  wall: { cls: 'immovable', mat: 'concrete', hw: 1, hd: 1, h: 3, variants: 1 },
};

export interface Layout {
  props: Prop[];
  peds: Ped[];
  half: number;
  spawn: { x: number; z: number; heading: number };
  /** Cosmetic: which cells are buildings / plaza / lot, for ground paint. */
  cells: { cx: number; cz: number; type: 'building' | 'plaza' | 'lot' }[];
}

export function generateLayout(seed: number): Layout {
  const rng = new Rng(seed);
  const B = TUNING.block;
  const n = B.cellsPerSide;
  const half = (n * B.cell) / 2;
  const props: Prop[] = [];
  const spawn = { x: B.cell / 2, z: 0, heading: -Math.PI / 2 };
  const spawnClear = 9;

  const overlaps = (x: number, z: number, hw: number, hd: number, pad: number) => {
    if (Math.abs(x - spawn.x) < hw + spawnClear && Math.abs(z - spawn.z) < hd + spawnClear) return true;
    for (const p of props) {
      if (Math.abs(p.x - x) < p.hw + hw + pad && Math.abs(p.z - z) < p.hd + hd + pad) return true;
    }
    return false;
  };

  const add = (kind: PropKind, x: number, z: number, rotated = false, size?: { hw: number; hd: number; h: number }, pad = 0.25): Prop | null => {
    const d = PROP_DEFS[kind];
    let hw = size?.hw ?? d.hw;
    let hd = size?.hd ?? d.hd;
    if (rotated) [hw, hd] = [hd, hw];
    if (Math.abs(x) + hw > half - 1 || Math.abs(z) + hd > half - 1) return null;
    if (overlaps(x, z, hw, hd, pad)) return null;
    const p: Prop = {
      id: props.length,
      kind,
      cls: d.cls,
      mat: d.mat,
      x,
      z,
      hw,
      hd,
      h: size?.h ?? d.h,
      variant: rng.int(0, d.variants - 1),
      alive: true,
      deadT: 0,
    };
    props.push(p);
    return p;
  };

  // Boundary walls first (they are allowed to bypass the in-bounds check).
  const wallT = 1.5;
  for (const [x, z, hw, hd] of [
    [0, -half - wallT, half + wallT * 2, wallT],
    [0, half + wallT, half + wallT * 2, wallT],
    [-half - wallT, 0, wallT, half + wallT * 2],
    [half + wallT, 0, wallT, half + wallT * 2],
  ] as const) {
    props.push({ id: props.length, kind: 'wall', cls: 'immovable', mat: 'concrete', x, z, hw, hd, h: 3, variant: 0, alive: true, deadT: 0 });
  }

  const cells: Layout['cells'] = [];
  const centre = Math.floor(n / 2);
  const bs = B.buildingSize / 2;

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const cx = -half + B.cell * (i + 0.5);
      const cz = -half + B.cell * (j + 0.5);
      let type: 'building' | 'plaza' | 'lot' = 'building';
      if (i === centre && j === centre) type = 'plaza';
      else if (rng.chance(B.openCellChance)) type = rng.chance(0.6) ? 'plaza' : 'lot';
      cells.push({ cx, cz, type });

      if (type === 'building') {
        const split = rng.next();
        const hgt = () => rng.range(B.buildingHeight[0], B.buildingHeight[1]);
        if (split < 0.35) {
          // Tight alley for escapes (§16), north-south.
          const alley = 5;
          add('building', cx - (bs + alley) / 2, cz, false, { hw: (bs - alley) / 2, hd: bs, h: hgt() }, 0);
          add('building', cx + (bs + alley) / 2, cz, false, { hw: (bs - alley) / 2, hd: bs, h: hgt() }, 0);
        } else if (split < 0.6) {
          const alley = 5;
          add('building', cx, cz - (bs + alley) / 2, false, { hw: bs, hd: (bs - alley) / 2, h: hgt() }, 0);
          add('building', cx, cz + (bs + alley) / 2, false, { hw: bs, hd: (bs - alley) / 2, h: hgt() }, 0);
        } else {
          add('building', cx, cz, false, { hw: bs, hd: bs, h: hgt() }, 0);
        }
      } else if (type === 'plaza') {
        // Market rows: stalls, carts, benches, planters, with a pillar or two.
        for (let r = -2; r <= 2; r++) {
          for (let c = -2; c <= 2; c++) {
            const x = cx + c * 6.5 + rng.range(-0.8, 0.8);
            const z = cz + r * 6.5 + rng.range(-0.8, 0.8);
            const roll = rng.next();
            if (roll < 0.35) add('stall', x, z, rng.chance(0.3));
            else if (roll < 0.55) add('cart', x, z, rng.chance(0.5));
            else if (roll < 0.7) add('bench', x, z, rng.chance(0.5));
            else if (roll < 0.82) add('planter', x, z);
            else if (roll < 0.86) add('pillar', x, z);
          }
        }
        // Fence line along one side.
        const side = rng.int(0, 3);
        for (let k = -3; k <= 3; k++) {
          const off = bs - 1;
          if (side === 0) add('fence', cx + k * 5.1, cz - off, false, undefined, 0.05);
          if (side === 1) add('fence', cx + k * 5.1, cz + off, false, undefined, 0.05);
          if (side === 2) add('fence', cx - off, cz + k * 5.1, true, undefined, 0.05);
          if (side === 3) add('fence', cx + off, cz + k * 5.1, true, undefined, 0.05);
        }
      } else {
        // Parking lot: rows of cars and vans.
        for (let r = -2; r <= 2; r += 2) {
          for (let c = -3; c <= 3; c++) {
            if (rng.chance(0.25)) continue;
            add(rng.chance(0.2) ? 'van' : 'car', cx + c * 4.6, cz + r * 5, true);
          }
        }
      }

      // Sidewalk dressing around the cell perimeter.
      const sw = bs + B.sidewalk / 2;
      const light: PropKind[] = ['bin', 'mailbox', 'newsbox', 'planter', 'bin', 'cart'];
      const medium: PropKind[] = ['bench', 'bikerack'];
      for (let edge = 0; edge < 4; edge++) {
        let t = -bs + rng.range(1, 6);
        while (t < bs) {
          const kind = rng.chance(0.7) ? rng.pick(light) : rng.pick(medium);
          const horiz = edge < 2;
          const x = horiz ? cx + t : cx + (edge === 2 ? -sw : sw);
          const z = horiz ? cz + (edge === 0 ? -sw : sw) : cz + t;
          add(kind, x, z, !horiz);
          t += rng.range(5, 11);
        }
      }

      // Curbside parking along the street.
      const curb = bs + B.sidewalk + 1.3;
      for (let edge = 0; edge < 4; edge++) {
        for (let t = -bs + 4; t < bs - 2; t += 6) {
          if (!rng.chance(0.28)) continue;
          const horiz = edge < 2;
          const x = horiz ? cx + t : cx + (edge === 2 ? -curb : curb);
          const z = horiz ? cz + (edge === 0 ? -curb : curb) : cz + t;
          add(rng.chance(0.15) ? 'van' : 'car', x, z, !horiz);
        }
      }
    }
  }

  // Occasional barricade lines across street segments (risky at Jog/Stride).
  const streets = n - 1;
  for (let k = 0; k < streets; k++) {
    for (let m = 0; m < n; m++) {
      if (!rng.chance(0.12)) continue;
      const lineX = -half + B.cell * (k + 1);
      const along = -half + B.cell * (m + 0.5) + rng.range(-12, 12);
      const vertical = rng.chance(0.5);
      for (let q = -1; q <= 1; q++) {
        if (rng.chance(0.3)) continue; // leave a gap sometimes
        if (vertical) add('barricade', lineX + q * 4, along);
        else add('barricade', along, lineX + q * 4, true);
      }
    }
  }

  // Pedestrians on sidewalks and plazas.
  const peds: Ped[] = [];
  let guard = 0;
  while (peds.length < B.pedestrians && guard++ < 5000) {
    const x = rng.range(-half + 3, half - 3);
    const z = rng.range(-half + 3, half - 3);
    if (Math.hypot(x - spawn.x, z - spawn.z) < 14) continue;
    let blocked = false;
    for (const p of props) {
      if (Math.abs(p.x - x) < p.hw + 0.6 && Math.abs(p.z - z) < p.hd + 0.6) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    peds.push({ id: peds.length, x, z, vx: 0, vz: 0, heading: rng.range(-Math.PI, Math.PI), state: 'walk', t: rng.range(0, 3), spin: 0, variant: rng.int(0, 7) });
  }

  return { props, peds, half, spawn, cells };
}
