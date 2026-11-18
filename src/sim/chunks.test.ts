import { describe, expect, it } from 'vitest';
import { CHUNKS, CHUNK_KINDS, solve } from './chunks';

describe('authored chunks', () => {
  it('are well formed', () => {
    const ids = new Set<string>();
    for (const c of CHUNKS) {
      expect(ids.has(c.id), c.id).toBe(false);
      ids.add(c.id);
      for (const [, row] of c.rows) {
        expect(row.length, `${c.id} row width`).toBe(c.lanes);
        for (const ch of row) expect(ch === '.' || ch in CHUNK_KINDS, `${c.id}: '${ch}'`).toBe(true);
        expect([...row].some((ch) => ch === '.' || ch === 's' || ch === 'n'), `${c.id}: a row closes every lane`).toBe(true);
      }
    }
    for (const lanes of [2, 3, 4]) for (let level = 1; level <= 5; level++) expect(CHUNKS.some((c) => c.lanes === lanes && c.level <= level), `${lanes} lanes, level ${level}`).toBe(true);
  });
  it('never cheat: a way through from every entry lane at full sprint', () => {
    const bad = CHUNKS.map((c) => ({ id: c.id, stuck: solve(c) })).filter((r) => r.stuck.length);
    expect(bad).toEqual([]);
  });
});
