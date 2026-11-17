import type { UpgradeId } from './tuning';
import leap from './assets/upgrades/leap.webp';
import stare from './assets/upgrades/stare.webp';
import breakaway from './assets/upgrades/breakaway.webp';
import primeTime from './assets/upgrades/primeTime.webp';
import thickSkin from './assets/upgrades/thickSkin.webp';
import secondWind from './assets/upgrades/secondWind.webp';
import crowdPleaser from './assets/upgrades/crowdPleaser.webp';
import slipstream from './assets/upgrades/slipstream.webp';
import shoulder from './assets/upgrades/shoulder.webp';
import overdrive from './assets/upgrades/overdrive.webp';
import shortFuse from './assets/upgrades/shortFuse.webp';
import groundZero from './assets/upgrades/groundZero.webp';

/**
 * Card art for the Producer's Meeting and the ability chip (Mike's sheet, docs/refs/broadcast-and-upgrades-sheet.webp).
 * Pool v2 (2026-11-17) reads each image afresh: flying over traffic → Breakaway, the camera on him → Prime Time, the
 * armored shin → Thick Skin, the breath → Second Wind, the filmstrip → Crowd Pleaser, the cape in the wind → Slipstream.
 */
/** Rampage upgrades (2026-11-17): Shoulder Check (the charge through concrete), Overdrive (the stopwatch), Short Fuse (the lit fuse), Ground Zero (the shockwave). */
export const UPGRADE_ART: Record<UpgradeId, string> = { leap, stare, breakaway, primeTime, shoulder, thickSkin, secondWind, crowdPleaser, slipstream, overdrive, shortFuse, groundZero };
