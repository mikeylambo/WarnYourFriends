import { describe, expect, it } from 'vitest';
import { AWARDS, LOCKED_UPGRADES, outfitUnlocked, record, upgradePool, type Profile } from './awards';
import { ALL_UPGRADES } from './sim/run';

const fresh = (): Profile => ({ counts: { signOffs: 0, policeWrecked: 0, objects: 0, bestSegment: 0, runsWon: 0 }, won: [], outfit: 'classic' });
const seg = (o: Partial<Parameters<typeof record>[1]> = {}) => ({ signedOff: false, policeWrecked: 0, objects: 0, segment: 1, runWon: false, ...o });

describe('Local News Awards', () => {
  it('Breakaway and Slipstream start locked; everything else is in the meeting', () => {
    expect(LOCKED_UPGRADES.sort()).toEqual(['breakaway', 'slipstream']);
    const pool = upgradePool(fresh());
    expect(pool).not.toContain('breakaway');
    expect(pool).not.toContain('slipstream');
    expect(pool.length).toBe(ALL_UPGRADES.length - 2);
  });

  it('reaching segment 3 unlocks Breakaway; 10 police crashes unlock Slipstream', () => {
    const p = fresh();
    expect(record(p, seg({ segment: 2 })).map((a) => a.id)).toEqual([]);
    expect(record(p, seg({ segment: 3 })).map((a) => a.id)).toEqual(['specialReport']);
    expect(upgradePool(p)).toContain('breakaway');
    record(p, seg({ policeWrecked: 6 }));
    expect(upgradePool(p)).not.toContain('slipstream');
    expect(record(p, seg({ policeWrecked: 4 })).map((a) => a.id)).toContain('pursuitOfTheYear');
    expect(upgradePool(p)).toContain('slipstream');
  });

  it('outfits unlock with their awards; each award is won once', () => {
    const p = fresh();
    expect(outfitUnlocked(p, 'midnight')).toBe(false);
    for (let i = 0; i < 3; i++) record(p, seg({ signedOff: true }));
    expect(outfitUnlocked(p, 'midnight')).toBe(true);
    expect(record(p, seg({ signedOff: true })).length).toBe(0);
    expect(p.won.filter((id) => id === 'regularFixture').length).toBe(1);
    expect(record(p, seg({ runWon: true })).map((a) => a.id)).toContain('seasonFinale');
    expect(outfitUnlocked(p, 'gold')).toBe(true);
    expect(AWARDS.length).toBe(7);
  });
});
