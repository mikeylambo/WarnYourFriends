import type { SimEvent } from './sim/types';
import type { Sim } from './sim/sim';

/**
 * Playtest export (Mike, 2026-11-15): every broadcast's numbers, kept in this browser (last 100),
 * copied from the recap as JSON so tuning (prices, asks, chains) can use real play, not the bot.
 * Presentation only: it reads sim events and state, never writes them. Hide before release.
 */
const KEY = 'gal.playlog.v1';
const MAX = 100;

export interface PlayEntry {
  v: 1;
  at: string;
  seed: number;
  mode: 'run' | 'single';
  segment: number;
  upgrades: string[];
  outcome: string;
  seconds: number;
  score: number;
  peakRatings: number;
  heat: number;
  /** Seconds at Jog / Stride / Rampage. */
  gearSeconds: number[];
  /** Share of live time with Ratings at the 100 cap. */
  ratingsCapShare: number;
  smashes: number;
  smashesAcross: number;
  bounces: number;
  laneChanges: number;
  chains: { n: number; mult: number; pts: number; dropped: boolean }[];
  /** Base points (before chain multipliers) by stunt. */
  stuntPoints: Record<string, number>;
  asks: { id: string; progress: number; n: number; done: boolean }[];
  forks: { opened: number; taken: number };
  police: { crashes: number; smashed: number; shaken: number; rams: number; ramHits: number; spiked: number };
  abilityUses: number;
  /** Rampage loop (2026-11-17): Rampages fired, and hits that cost meter. */
  rampages?: number;
  meterLosses?: number;
  /** Ticks per input device (keyboard / gamepad / touch). */
  input: Record<string, number>;
}

/** Collects one broadcast. */
export class PlayLog {
  private chains: PlayEntry['chains'] = [];
  private stuntPoints: Record<string, number> = {};
  private forks = { opened: 0, taken: 0 };
  private police = { crashes: 0, smashed: 0, shaken: 0, rams: 0, ramHits: 0, spiked: 0 };
  private abilityUses = 0;
  private rampages = 0;
  private meterLosses = 0;
  private capTicks = 0;
  private liveTicks = 0;
  private input: Record<string, number> = {};

  reset() {
    this.chains = [];
    this.stuntPoints = {};
    this.forks = { opened: 0, taken: 0 };
    this.police = { crashes: 0, smashed: 0, shaken: 0, rams: 0, ramHits: 0, spiked: 0 };
    this.abilityUses = 0;
    this.rampages = 0;
    this.meterLosses = 0;
    this.capTicks = 0;
    this.liveTicks = 0;
    this.input = {};
  }

  observe(e: SimEvent) {
    switch (e.type) {
      case 'chain': this.stuntPoints[e.cause] = Math.round((this.stuntPoints[e.cause] ?? 0) + e.add); break;
      case 'chainEnd': this.chains.push({ n: e.count, mult: e.mult, pts: e.points, dropped: e.dropped }); break;
      case 'forkOpen': this.forks.opened++; break;
      case 'fork': if (e.taken) this.forks.taken++; break;
      case 'policeCrash': this.police.crashes++; break;
      case 'smash': if (e.propId >= 1_000_000) this.police.smashed++; break;
      case 'lostTrack': this.police.shaken++; break;
      case 'ram': this.police.rams++; if (e.hit) this.police.ramHits++; break;
      case 'spiked': this.police.spiked++; break;
      case 'ability': if (e.ok) this.abilityUses++; break;
      case 'rampageStart': this.rampages++; break;
      case 'meterLoss': this.meterLosses++; break;
    }
  }

  /** Per tick while live. */
  tick(sim: Sim, device: string) {
    this.liveTicks++;
    if (sim.show.ratings >= 99.9) this.capTicks++;
    this.input[device] = (this.input[device] ?? 0) + 1;
  }

  entry(sim: Sim, seed: number, mode: PlayEntry['mode'], segment: number, upgrades: string[]): PlayEntry {
    const sh = sim.show;
    const st = sim.stats;
    return {
      v: 1,
      at: new Date().toISOString(),
      seed,
      mode,
      segment,
      upgrades,
      outcome: sh.state === 'cleared' ? 'signedOff' : `busted:${sh.reason ?? '?'}`,
      seconds: Math.round(sim.time * 10) / 10,
      score: Math.round(sh.banked),
      peakRatings: Math.round(sh.peak),
      heat: sh.heat,
      gearSeconds: st.timeAtTier.map((x) => Math.round(x)),
      ratingsCapShare: this.liveTicks ? Math.round((1000 * this.capTicks) / this.liveTicks) / 1000 : 0,
      smashes: st.smashes,
      smashesAcross: st.smashesAcross,
      bounces: st.bounces,
      laneChanges: st.laneChanges,
      chains: this.chains,
      stuntPoints: this.stuntPoints,
      asks: sim.asks.list.map((a) => ({ id: a.id, progress: a.progress, n: a.n, done: a.done })),
      forks: this.forks,
      police: this.police,
      abilityUses: this.abilityUses,
      rampages: this.rampages,
      meterLosses: this.meterLosses,
      input: this.input,
    };
  }
}

export function loadLog(): PlayEntry[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as PlayEntry[];
  } catch {
    return [];
  }
}

export function appendLog(e: PlayEntry): number {
  const all = loadLog();
  all.push(e);
  while (all.length > MAX) all.shift();
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable: this broadcast is still copyable */
  }
  return all.length;
}

/** Copy every logged broadcast to the clipboard; if that's blocked, download it as a file. */
export async function exportLog(extra?: PlayEntry): Promise<'copied' | 'downloaded'> {
  const all = loadLog();
  if (extra && !all.some((x) => x.at === extra.at)) all.push(extra);
  const text = JSON.stringify({ game: 'giant-at-large', exported: new Date().toISOString(), broadcasts: all });
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = `giant-at-large-playdata-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return 'downloaded';
  }
}
