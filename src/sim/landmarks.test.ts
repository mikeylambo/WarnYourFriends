import { describe, expect, it } from 'vitest';
import { Track } from './track';
import { TUNING } from '../tuning';
import type { LandmarkKind } from './types';

/** Content pass: landmark set pieces are fair (a lane always open) and keep clear of ramps. */
describe('landmarks', () => {
  it('every landmark row leaves a lane open, on a straight full-width segment in its zone, never a ramp', () => {
  const seen: Record<LandmarkKind, number> = { toll: 0, foodtrucks: 0, works: 0, jam: 0 };
  for (let seed = 1; seed <= 200; seed++) {
    const track = new Track(seed);
    track.ensure(3000);
    for (const seg of track.segments) {
      if (!seg.landmark) continue;
      seen[seg.landmark]++;
      const lanes = seg.lanes0;
      expect(seg.lanes1).toBe(lanes);
      expect(seg.kind).toBe('straight');
      expect(TUNING.landmarks.zones[seg.landmark]).toContain(seg.zone);
      expect(track.exitEligible(seg)).toBe(false);
      const props = track.props.filter((p) => p.segment === seg.index);
      expect(props.length).toBeGreaterThan(0);
      // Rows: props within 3m of each other along the road.
      const rows: (typeof props)[] = [];
      for (const p of [...props].sort((a, b) => a.s - b.s)) {
        const row = rows[rows.length - 1];
        if (row && p.s - row[0].s < 3) row.push(p);
        else rows.push([p]);
      }
      let prevOpen: number[] | null = null;
      for (const row of rows) {
        const blocked = new Set(row.map((p) => Math.floor(p.d / TUNING.lanes.width)));
        const open = [...Array(lanes).keys()].filter((l) => !blocked.has(l));
        expect(open.length).toBeGreaterThanOrEqual(1);
        // Jam: the open lane is reachable from the last one (at most one lane over).
        if (seg.landmark === 'jam' && prevOpen) expect(open.some((o) => prevOpen!.some((q) => Math.abs(o - q) <= 1))).toBe(true);
        prevOpen = open;
      }
    }
  }
    for (const k of Object.keys(seen) as LandmarkKind[]) expect(seen[k]).toBeGreaterThan(20);
  });
});
