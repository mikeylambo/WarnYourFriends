import { describe, expect, it } from 'vitest';
import BANK from './viewers.json';

describe('viewer ticker bank', () => {
  it('every text is "message — attribution" with a coverage tier of 1–3, and none repeat', () => {
    const seen = new Set<string>();
    for (const [text, tier] of BANK.texts as [string, number][]) {
      expect(text, text).toMatch(/^\S.* — \S.*$/);
      expect([1, 2, 3], text).toContain(tier);
      expect(seen.has(text), `duplicate: ${text}`).toBe(false);
      seen.add(text);
    }
  });
  it('the earliest coverage tier has enough lines not to repeat quickly', () => {
    expect(BANK.texts.filter(([, t]) => t === 1).length).toBeGreaterThanOrEqual(10);
  });
});
