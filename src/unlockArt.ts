import type { OutfitId } from './tuning';
import classic from './assets/outfits/classic.webp';
import midnight from './assets/outfits/midnight.webp';
import parade from './assets/outfits/parade.webp';
import gold from './assets/outfits/gold.webp';
import heavyLoad from './assets/mods/heavyLoad.webp';
import hotPursuit from './assets/mods/hotPursuit.webp';
import glassJaw from './assets/mods/glassJaw.webp';
import liveWire from './assets/mods/liveWire.webp';
import shortLeash from './assets/mods/shortLeash.webp';
import badge from './assets/awards/badge.webp';

/**
 * Painted unlock art (Mike, 2026-11-24): the outfit portraits (the giant without the topknot or horned pauldron), a
 * card per traffic mod (ids as in TUNING.proto.mods: Fragile is glassJaw, Attention Span liveWire), and the badge for
 * an award that unlocks nothing else. Used by the unlock stinger, the Awards wardrobe and the Rundown's mod buttons.
 */
export const OUTFIT_ART: Record<OutfitId, string> = { classic, midnight, parade, gold };
export const MOD_ART: Record<string, string> = { heavyLoad, hotPursuit, glassJaw, liveWire, shortLeash };
export const AWARD_BADGE = badge;
