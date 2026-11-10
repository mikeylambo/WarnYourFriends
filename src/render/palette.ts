import type { Material, PropKind } from '../sim/types';

/**
 * §23 value rule: the world sits light, the giant is always the darkest thing,
 * props are mid-value. Sun-bleached, slightly toy-like. (The v0.3 references are
 * night footage; a night look is an open question for Mike, not built.)
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
  crack: 0x2e2a33,

  giantBody: 0x2b1446,
  giantArmor: 0x3a1c5c,
  giantCape: 0x1c0b30,
  giantBone: 0xe6dcc3,
  giantHair: 0xfaf7f0,
  giantSkin: 0x6b4a5e,
  giantBand: 0xd9ccb0,
};

export const KIND_COLORS: Record<PropKind, number[]> = {
  sawhorse: [0xf08a24, 0xe8e2d4],
  cart: [0xf28c28, 0xe4412b, 0x7cbf3a],
  fence: [0x8a9099],
  scooter: [0xd64545, 0x3d8fd1, 0xe8b931],
  car: [0xcf4b3e, 0x3b8ea5, 0xd9a43b, 0x6b8f5a, 0x4a5d8c],
  van: [0xf2efe8, 0xd3dbe0, 0xe9d7a8],
  barricade: [0xd3cec4],
};

export const MATERIAL_DEBRIS: Record<Material, number[]> = {
  wood: [0xa67c52, 0xc89b6d, 0x8a6240],
  glass: [0xbfe3ef, 0xdff3f8, 0x9fcfe0],
  metal: [0x8c939b, 0xb0b5ba, 0x6d737a],
  fruit: [0xf28c28, 0xe4412b, 0x7cbf3a, 0xf5d33b],
  concrete: [0xcfcac0, 0xb5b0a6, 0xe0dbd1],
  paper: [0xf4f0e6, 0xe8e2d4, 0x333333],
};
