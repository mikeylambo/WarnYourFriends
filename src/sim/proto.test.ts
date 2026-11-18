import { describe, expect, it } from 'vitest';
import { TUNING, enableProto } from '../tuning';
import { Sim } from './sim';
import { Bot } from './bot';

// The prototype core loop (?proto=1, DECISIONS 2026-11-18). Its own file: enableProto changes TUNING for this file only.
enableProto();

describe('prototype core loop', () => {
  it('dodge until you can smash: in Stride only light things and rival vans break; Rampage, a sprint and one bar', () => {
    let rampages = 0;
    let sprinted = false;
    for (let seed = 1; seed <= 6; seed++) {
      const sim = new Sim({ seed, segment: 0, upgrades: [], growth: true });
      const bot = new Bot(sim);
      const kinds = new Map(sim.track.props.map((p) => [p.id, p.kind]));
      for (let i = 0; i < 60 * 170 && sim.live; i++) {
        for (const p of sim.track.props) kinds.set(p.id, p.kind);
        const ramp = sim.inRampage;
        const evs = sim.step(bot.input());
        for (const e of evs) {
          if (e.type === 'rampageStart') rampages++;
          // Outside Rampage only small things (proto.small) and rival vans break, plus Law 1's stumble-through (a hit, with a bounce).
          if (e.type === 'smash' && !ramp && !sim.inRampage) {
            const stumbled = evs.some((x) => x.type === 'bounce' && x.propId === e.propId);
            expect(e.cls === 'light' || TUNING.proto.small.includes(kinds.get(e.propId) ?? '') || kinds.get(e.propId) === 'newsvan' || kinds.get(e.propId) === 'compact' || kinds.get(e.propId) === undefined || stumbled).toBe(true);
          }
        }
        if (sim.giant.sprint >= 1) sprinted = true;
        // One bar: outside Rampage the meter is the audience.
        if (!sim.inRampage && sim.live) expect(sim.giant.meter).toBe(sim.show.ratings);
        expect(sim.giant.speed).toBeGreaterThanOrEqual(TUNING.giant.speedFloor); // Law 1
      }
    }
    expect(rampages).toBeGreaterThan(0);
    expect(sprinted).toBe(true);
    expect(TUNING.run.segments).toBe(3);
  });
});
