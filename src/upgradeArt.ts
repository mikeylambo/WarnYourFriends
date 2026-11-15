import type { UpgradeId } from './tuning';
import leap from './assets/upgrades/leap.webp';
import stare from './assets/upgrades/stare.webp';
import hijack from './assets/upgrades/hijack.webp';
import pose from './assets/upgrades/pose.webp';
import ironShins from './assets/upgrades/ironShins.webp';
import secondWind from './assets/upgrades/secondWind.webp';
import showman from './assets/upgrades/showman.webp';
import tailwind from './assets/upgrades/tailwind.webp';

/** Card art for the Producer's Meeting and the ability chip (Mike's sheet, docs/refs/broadcast-and-upgrades-sheet.webp). */
export const UPGRADE_ART: Record<UpgradeId, string> = { leap, stare, hijack, pose, ironShins, secondWind, showman, tailwind };
