/**
 * Balance harness (§33): full five-segment runs, bot-driven, against the telemetry bands.
 *
 *   Segment 1 clear rate        85%
 *   Full-run clear rate         15–25%
 *   Busted by Pin vs Ratings    ~60 / 40
 *   Time at Rampage             30–45%
 *   Most-farmed event share     < 35% of Ratings gains
 *
 * Each seed plays a run the way the game does (RunState: segment seeds, the meeting,
 * the purse). At a meeting the bot buys the dearest offer it can afford (ability first
 * if it has none), else walks out. Report only: it never fails the gates; the bands are
 * targets for tuning, and the bot is not a person.
 *
 * Usage: tsx tools/balance.ts [seeds=200]   (JSON=1 for machine-readable output)
 */
import { Sim } from '../src/sim/sim';
import { Bot } from '../src/sim/bot';
import { RunState, ABILITIES, ALL_UPGRADES } from '../src/sim/run';
import { TUNING, type UpgradeId } from '../src/tuning';

const seeds = Number(process.argv[2] ?? 200);
/** HUMAN=1: the bot's inputs arrive REACT seconds late and it misreads MISS of its lane decisions (a person, roughly). */
const HUMAN = !!process.env.HUMAN;
const REACT = Number(process.env.REACT ?? 0.25);
const MISS = Number(process.env.MISS ?? 0.15);
const SEG = TUNING.run.segments;
const maxTicks = Math.round(200 * TUNING.sim.hz);

const seg = Array.from({ length: SEG }, () => ({ played: 0, cleared: 0, busts: { ratings: 0, pin: 0, missed: 0 } as Record<string, number>, banked: [] as number[], endT: [] as number[], peak: [] as number[], rampage: 0, ticks: 0 }));
const gains: Record<string, number> = {};
const tierTicks = [0, 0, 0];
let totalTicks = 0;
const runs = { won: 0, scores: [] as number[], reached: [] as number[] };
const bought: Record<string, number> = {};
let walkouts = 0;
const purseAtMeeting: number[] = [];
const t0 = performance.now();

for (let seed = 1; seed <= seeds; seed++) {
  // POOL=start plays with the upgrades a new player has (Awards unlock Breakaway and Slipstream).
  const run = new RunState(seed, process.env.POOL === 'start' ? ALL_UPGRADES.filter((u) => u !== 'breakaway' && u !== 'slipstream') : ALL_UPGRADES);
  while (run.phase === 'live') {
    const i = run.segment;
    const sim = new Sim({ seed: run.segmentSeed(), segment: i, upgrades: run.owned, levels: run.levels, growth: true });
    const bot = new Bot(sim);
    const queue: ReturnType<Bot['input']>[] = [];
    const delay = Math.round(REACT * TUNING.sim.hz);
    let mrng = (seed * 7919 + i * 104729) >>> 0;
    const rnd = () => ((mrng = (Math.imul(mrng, 1664525) + 1013904223) >>> 0) / 4294967296);
    const input = () => {
      const want = bot.input();
      if (!HUMAN) return want;
      if (want.lane && rnd() < MISS) want.lane = 0;
      if (want.shoulder && rnd() < MISS) want.shoulder = false;
      if (want.ability && rnd() < MISS) want.ability = false;
      queue.push(want);
      return queue.length > delay ? queue.shift()! : { lane: 0, brake: false, shoulder: false };
    };
    const S = seg[i];
    S.played++;
    for (let k = 0; k < maxTicks && sim.live; k++) {
      const ev = sim.step(input());
      for (const e of ev) if (e.type === 'ratings' && e.delta > 0) gains[e.cause] = (gains[e.cause] ?? 0) + e.delta;
      tierTicks[sim.giant.tier]++;
      totalTicks++;
      S.ticks++;
      if (sim.giant.tier === 2) S.rampage++;
    }
    const sh = sim.show;
    S.endT.push(sim.time);
    S.banked.push(sh.banked);
    S.peak.push(sh.peak);
    if (sh.state === 'cleared') S.cleared++;
    else S.busts[sh.reason ?? 'missed']++;
    run.finishSegment(sh);
    if ((run.phase as string) === 'meeting') {
      purseAtMeeting.push(run.purse);
      const offers = run.offers().filter((u) => run.canAfford(u));
      const hasAbility = !!run.ability;
      offers.sort((a, b) => {
        const pa = !hasAbility && (ABILITIES as string[]).includes(a) ? 1e9 : 0;
        const pb = !hasAbility && (ABILITIES as string[]).includes(b) ? 1e9 : 0;
        return pb + TUNING.upgrades[b].price - (pa + TUNING.upgrades[a].price);
      });
      const pick: UpgradeId | undefined = offers[0];
      if (pick && run.buy(pick)) bought[pick] = (bought[pick] ?? 0) + 1;
      else {
        walkouts++;
        run.nextSegment();
      }
    }
  }
  if (run.phase === 'won') runs.won++;
  runs.scores.push(run.earned);
  runs.reached.push(run.results.length);
}

const pct = (n: number, d: number) => (d ? (100 * n) / d : 0);
const q = (a: number[], p: number) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const k = (n: number) => `${Math.round(n / 1000)}k`;
const band = (v: number, lo: number, hi: number) => (v >= lo && v <= hi ? 'IN BAND' : v < lo ? 'LOW' : 'HIGH');

const busts = seg.reduce((a, s) => ({ ratings: a.ratings + s.busts.ratings, pin: a.pin + s.busts.pin, missed: a.missed + s.busts.missed }), { ratings: 0, pin: 0, missed: 0 });
const gainTotal = Object.values(gains).reduce((a, b) => a + b, 0);
const topGain = Object.entries(gains).sort((a, b) => b[1] - a[1]);
const s1 = pct(seg[0].cleared, seg[0].played);
const full = pct(runs.won, seeds);
const ramp = pct(tierTicks[2], totalTicks);
const pinShare = pct(busts.pin, busts.pin + busts.ratings);
const top = topGain.length ? pct(topGain[0][1], gainTotal) : 0;

const report = {
  seeds,
  seconds: ((performance.now() - t0) / 1000).toFixed(1),
  bands: {
    segment1Clear: { value: +s1.toFixed(1), target: '85%', verdict: band(s1, 80, 90) },
    fullRunClear: { value: +full.toFixed(1), target: '15–25%', verdict: band(full, 15, 25) },
    pinVsRatings: { value: `${pinShare.toFixed(0)} / ${(100 - pinShare).toFixed(0)}`, target: '~60 / 40', verdict: band(pinShare, 50, 70), missedExit: busts.missed },
    rampageTime: { value: +ramp.toFixed(1), target: '30–45%', verdict: band(ramp, 30, 45) },
    mostFarmed: { value: topGain.length ? `${topGain[0][0]} ${top.toFixed(1)}%` : '-', target: '< 35%', verdict: top < 35 ? 'IN BAND' : 'HIGH' },
  },
  segments: seg.map((s, i) => ({
    segment: i + 1,
    played: s.played,
    clear: +pct(s.cleared, s.played).toFixed(1),
    busts: s.busts,
    banked: { p10: k(q(s.banked, 0.1)), p50: k(q(s.banked, 0.5)), p90: k(q(s.banked, 0.9)) },
    peakRatings: q(s.peak, 0.5).toFixed(0),
    endTime: q(s.endT, 0.5).toFixed(0),
    rampage: +pct(s.rampage, s.ticks).toFixed(1),
  })),
  run: { scoreP10: k(q(runs.scores, 0.1)), scoreP50: k(q(runs.scores, 0.5)), scoreP90: k(q(runs.scores, 0.9)), reachedP50: q(runs.reached, 0.5) },
  meeting: { pursesP50: k(q(purseAtMeeting, 0.5)), bought, walkouts },
  gainShare: Object.fromEntries(topGain.map(([t, v]) => [t, +pct(v, gainTotal).toFixed(1)])),
  tierTime: { jog: +pct(tierTicks[0], totalTicks).toFixed(1), stride: +pct(tierTicks[1], totalTicks).toFixed(1), rampage: +ramp.toFixed(1) },
};

if (process.env.JSON) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`balance: ${seeds} full runs in ${report.seconds}s (${HUMAN ? `human-ish bot: ${REACT}s reaction, ${MISS * 100}% misreads` : 'bot'}, growth on)\n`);
  console.log('§33 bands');
  for (const [name, b] of Object.entries(report.bands)) console.log(`  ${name.padEnd(14)} ${String(b.value).padEnd(16)} target ${b.target.padEnd(9)} ${b.verdict}`);
  console.log(`  (missed-exit busts: ${busts.missed})\n`);
  console.log('per segment   played  clear  bust R/P/M   banked p10/p50/p90   peak  end s  rampage');
  for (const s of report.segments)
    console.log(`  ${String(s.segment).padEnd(11)} ${String(s.played).padStart(6)}  ${String(s.clear).padStart(5)}%  ${`${s.busts.ratings}/${s.busts.pin}/${s.busts.missed}`.padEnd(11)}  ${`${s.banked.p10}/${s.banked.p50}/${s.banked.p90}`.padEnd(19)}  ${s.peakRatings.padStart(4)}  ${s.endTime.padStart(5)}  ${s.rampage}%`);
  console.log(`\nrun score p10/p50/p90 ${report.run.scoreP10}/${report.run.scoreP50}/${report.run.scoreP90}; segments reached p50 ${report.run.reachedP50}`);
  console.log(`meeting purse p50 ${report.meeting.pursesP50}; bought ${JSON.stringify(bought)}; walked out ${walkouts}`);
  console.log(`gain share ${JSON.stringify(report.gainShare)}`);
  console.log(`tier time ${JSON.stringify(report.tierTime)}`);
}
