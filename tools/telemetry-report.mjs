// Read the anonymous play telemetry (server/telemetry.ts) and print it summed over the last N days.
// Usage: LB_ADMIN_KEY=... node tools/telemetry-report.mjs [days=14] [https://warn-your-friends.vercel.app]
const days = Number(process.argv[2] ?? 14);
const base = process.argv[3] ?? 'https://warn-your-friends.vercel.app';
const key = process.env.LB_ADMIN_KEY;
if (!key) throw new Error('set LB_ADMIN_KEY (the same value as in Vercel)');
const r = await fetch(`${base}/api/telemetry?days=${days}`, { headers: { 'x-admin-key': key } });
if (!r.ok) throw new Error(`telemetry ${r.status}`);
const { days: byDay } = await r.json();
const sum = {};
for (const d of Object.values(byDay)) for (const [k, v] of Object.entries(d)) sum[k] = (sum[k] ?? 0) + v;
const group = (prefix) => Object.entries(sum).filter(([k]) => k.startsWith(prefix)).sort((a, b) => b[1] - a[1]);
console.log(`Last ${days} days (${Object.keys(byDay).length} with data)\n`);
for (const [title, prefix] of [['Sessions', 'sessions'], ['How broadcasts end', 'end:'], ['Quits mid-broadcast', 'quit:'], ['First Rampage (s in)', 'firstRamp:'], ['Traffic mods on', 'mods:'], ['First broadcast ever', 'guided:']]) {
  console.log(title);
  for (const [k, v] of group(prefix)) console.log(`  ${k.padEnd(34)} ${v}`);
  console.log('');
}
