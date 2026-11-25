import { describe, expect, it } from 'vitest';
import { countersFor, telemetry } from '../../server/telemetry';
import { memoryStore } from '../../server/leaderboard';

describe('telemetry (2026-11-25)', () => {
  it('turns events into fixed counters and ignores anything off the list', () => {
    expect(countersFor({ t: 'end', mode: 'run', reason: 'caught', district: 2, secs: 95, firstRamp: 40, mods: 1, guided: true })).toEqual([
      'end:run', 'end:run:caught', 'end:run:caught:d2', 'end:run:t60-120', 'firstRamp:30-60', 'mods:1', 'guided:caught', 'guided:d2',
    ]);
    expect(countersFor({ t: 'quit', mode: 'endless', district: 0, secs: 10 })).toEqual(['quit:endless', 'quit:endless:d0', 'quit:endless:t0-15']);
    // Free text, unknown modes and odd shapes store nothing.
    for (const bad of [null, 'x', { t: 'end', mode: 'run; DROP', reason: 'won', district: 1, secs: 1 }, { t: 'end', mode: 'run', reason: 'hacked', district: 1, secs: 1 }, { t: 'quit', mode: 'run', district: 'x', secs: 1 }])
      expect(countersFor(bad)).toEqual([]);
  });
  it('counts per day, and reads only with the admin key', async () => {
    const store = memoryStore();
    const now = Date.UTC(2026, 10, 25, 12);
    expect((await telemetry(store, 'POST', {}, { events: [{ t: 'session', touch: true }, { t: 'quit', mode: 'run', district: 1, secs: 50 }] }, '1.2.3.4', 'k', undefined, now)).status).toBe(204);
    expect((await telemetry(store, 'GET', {}, null, '1.2.3.4', 'k', 'wrong', now)).status).toBe(403);
    const r = await telemetry(store, 'GET', { days: 1 }, null, '1.2.3.4', 'k', 'k', now);
    expect(r.body).toEqual({ days: { '2026-11-25': { sessions: 1, 'sessions:touch': 1, 'quit:run': 1, 'quit:run:d1': 1, 'quit:run:t30-60': 1 } } });
  });
});
