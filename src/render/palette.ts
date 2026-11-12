import type { Material, PropKind } from '../sim/types';

/**
 * §23 value rule: the world sits light, the giant is always the darkest thing,
 * props are mid-value. Sun-bleached, slightly toy-like by day. Phase 0c makes
 * night the default look (the v0.3 reference footage): albedos stay the same and
 * the LOOKS below set the light. At night the road is lit in sodium pools and the
 * chopper's spotlight, and the giant reads as a dark silhouette with a rim.
 */
export const PALETTE = {
  sky: 0xf1ebdf,
  grass: 0xd5d6ad,
  verge: 0xe2dcc8,
  road: 0xb4aea3,
  roadLine: 0xf8f4e8,
  edgeLineLeft: 0xf0c64a,
  edgeLineRight: 0xf8f4e8,
  wall: 0xdcd5c7,
  wallTop: 0xece6d9,
  pole: 0x9a9690,
  sign: 0x3f7f5a,
  signWarn: 0xe8a33a,
  tree: [0x9fb87a, 0x8aa86a, 0xb2c48a],
  trunk: 0x8a6a4e,
  buildings: [0xf0e6d2, 0xdfe6e3, 0xf2d9c9, 0xe5e0ee, 0xf3ecc9, 0xd7e3d0],
  dust: 0xd8cfbd,
  /** Phase 2 zones. */
  sidewalk: 0xc9c3b6,
  curb: 0xe2ddd2,
  water: 0x1d3550,
  deck: 0x6f6a64,
  tunnelWall: 0x8f8c86,
  tunnelTrim: 0xc7a24a,
  storefronts: [0xd9c2a3, 0xb7c4c9, 0xc9a9a0, 0xa9b39a, 0xd6cfb8, 0xb3a6c4],
  awnings: [0xd7263d, 0x2f6f8f, 0xe8a33a, 0x3f7f5a],
  crack: 0x2e2a33,

  giantBody: 0x2b1446,
  giantArmor: 0x3a1c5c,
  giantCape: 0x1c0b30,
  giantBone: 0xe6dcc3,
  giantHair: 0xfaf7f0,
  giantSkin: 0x6b4a5e,
  giantBand: 0xd9ccb0,
  /** Phase 0c ink outline around the giant. */
  giantOutline: 0x07030f,
};

export const KIND_COLORS: Record<PropKind, number[]> = {
  sawhorse: [0xf08a24, 0xe8e2d4],
  cart: [0xf28c28, 0xe4412b, 0x7cbf3a],
  fence: [0x8a9099],
  scooter: [0xd64545, 0x3d8fd1, 0xe8b931],
  car: [0xcf4b3e, 0x3b8ea5, 0xd9a43b, 0x6b8f5a, 0x4a5d8c],
  van: [0xf2efe8, 0xd3dbe0, 0xe9d7a8],
  barricade: [0xd3cec4],
  cruiser: [0x15151b],
  compact: [0x1c2a4a],
};

export const MATERIAL_DEBRIS: Record<Material, number[]> = {
  wood: [0xa67c52, 0xc89b6d, 0x8a6240],
  glass: [0xbfe3ef, 0xdff3f8, 0x9fcfe0],
  metal: [0x8c939b, 0xb0b5ba, 0x6d737a],
  fruit: [0xf28c28, 0xe4412b, 0x7cbf3a, 0xf5d33b],
  concrete: [0xcfcac0, 0xb5b0a6, 0xe0dbd1],
  paper: [0xf4f0e6, 0xe8e2d4, 0x333333],
};

export type TimeOfDay = 'night' | 'dusk' | 'day';

/** Light rig per time of day. Intensities are three.js physical units (point/spot in candela). */
export interface Look {
  sky: number;
  fog: number;
  fogNear: number;
  fogFar: number;
  hemiSky: number;
  hemiGround: number;
  hemi: number;
  sunColor: number;
  sun: number;
  /** Sun/moon direction (from). */
  sunPos: [number, number, number];
  /** Glow decals and halos (0 = off). */
  glow: number;
  lamp: number;
  spot: number;
  siren: number;
  rim: number;
  /** Faint chopper-shadow opacity. */
  shadow: number;
  /** Emissive "lit window" level on buildings. */
  windows: number;
}

export const LOOKS: Record<TimeOfDay, Look> = {
  night: { sky: 0x0a0c18, fog: 0x0a0c18, fogNear: 90, fogFar: 320, hemiSky: 0x5a6aa8, hemiGround: 0x1a1622, hemi: 0.16, sunColor: 0x8fa2ff, sun: 0.16, sunPos: [30, 100, 40], glow: 1, lamp: 38, spot: 300, siren: 32, rim: 0.55, shadow: 0.2, windows: 1 },
  dusk: { sky: 0x4a3a5e, fog: 0x6a4f6a, fogNear: 110, fogFar: 380, hemiSky: 0xd89a80, hemiGround: 0x3a3040, hemi: 0.7, sunColor: 0xff9a5a, sun: 0.75, sunPos: [-90, 30, -20], glow: 0.55, lamp: 20, spot: 200, siren: 30, rim: 0.45, shadow: 0.25, windows: 0.6 },
  day: { sky: 0xf1ebdf, fog: 0xf1ebdf, fogNear: 160, fogFar: 420, hemiSky: 0xfff7e8, hemiGround: 0xb8b0a0, hemi: 1.5, sunColor: 0xffffff, sun: 1.7, sunPos: [-40, 100, -25], glow: 0, lamp: 0, spot: 0, siren: 18, rim: 0.2, shadow: 0.32, windows: 0 },
};
