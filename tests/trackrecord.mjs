// Exercises the new /api/track-record fields against the LIVE D1 record, before
// any page is built on them. Reads only — no Odds API call, so it costs nothing
// while the quota is out.
//
// The point is not "does it return JSON" but "do the numbers agree with each
// other": the headline, the interval, the tier table and the era table are all
// slices of one population, and if they disagree the page will state two
// different records on one screen.
const BASE = 'https://aimplified.delexe.workers.dev';
const j = await (await fetch(`${BASE}/api/track-record?cb=${Math.random()}`)).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const bu = j.batterUnders, tiers = j.buTierBreakdown || [], eras = j.eraBreakdown || [], log = j.log || [];

console.log('batterUnders:', JSON.stringify(bu));
console.log('\ntier breakdown:');
tiers.forEach((t) => console.log(`   T${t.tier}  n=${String(t.n).padStart(5)}  ${t.record.padEnd(12)} roi ${String(t.roi).padStart(6)}%  p ${t.p}`));
console.log('\nera breakdown:');
eras.forEach((e) => console.log(`   ${String(e.era).padEnd(12)} ${String(e.tag || '-').padEnd(13)} n=${String(e.n).padStart(5)}  ${e.record.padEnd(12)} roi ${String(e.roi).padStart(6)}%  p ${e.p}`));
console.log(`\nlog rows: ${log.length}`);
if (log.length) console.log('   newest:', JSON.stringify(log[0]));

console.log('\n-- the headline is internally consistent --');
ok(bu != null, 'batterUnders present');
if (bu) {
  const [w, l] = bu.record.split('–').map(Number);
  ok(w + l === bu.n, `record ${bu.record} sums to n=${bu.n}`);
  ok(near(round1(w / bu.n * 100), bu.winRate, 0.11), `winRate ${bu.winRate}% matches the record`);
  ok(bu.medianPrice != null, `median price present (${bu.medianPrice})`);
  ok(bu.avgPrice === undefined, 'avgPrice is NOT published — averaging American odds is meaningless');
  // Break-even must be the mean of PER-BET break-evens, recomputed here from the
  // log rather than trusted. The wrong method (break-even of the mean price) is
  // asserted against explicitly, because it fails quietly and always flatters.
  const payout = (p) => (p > 0 ? p / 100 : 100 / Math.abs(p));
  const logPrices = log.map((r) => r.price).filter((p) => typeof p === 'number');
  if (logPrices.length) {
    const meanOfBe = logPrices.map((p) => 100 / (1 + payout(p))).reduce((s, x) => s + x, 0) / logPrices.length;
    const meanPrice = logPrices.reduce((s, x) => s + x, 0) / logPrices.length;
    const beOfMean = 100 * Math.abs(meanPrice) / (Math.abs(meanPrice) + 100);
    console.log(`   [log sample] mean-of-break-evens ${meanOfBe.toFixed(1)}%  vs  break-even-of-mean-price ${beOfMean.toFixed(1)}%`);
    ok(Math.abs(bu.breakEven - beOfMean) > 2,
      `published break-even (${bu.breakEven}%) is NOT the invalid break-even-of-the-mean-price (~${beOfMean.toFixed(1)}%)`);
    ok(bu.breakEven > 45 && bu.breakEven < 65, `break-even ${bu.breakEven}% is in a plausible range for juiced unders`);
  }
  ok(bu.roiP === null || (bu.roiP >= 0 && bu.roiP <= 1), `ROI carries its own p-value (${bu.roiP})`);
  ok(bu.ci && bu.ci.lo < bu.winRate && bu.ci.hi > bu.winRate, `hit rate sits inside its own CI (${bu.ci && bu.ci.lo}–${bu.ci && bu.ci.hi})`);
  // The claim the page makes in prose must match the arithmetic. Guarded rather
  // than assumed: a missing field should report as a failed assertion, not take
  // the whole run down with a TypeError and hide the checks below it.
  if (bu.ci && bu.breakEven != null) {
    const straddles = bu.ci.lo <= bu.breakEven && bu.ci.hi >= bu.breakEven;
    ok(straddles ? bu.beatsBreakEven === null : bu.beatsBreakEven !== null,
      straddles
        ? 'CI straddles break-even, so beatsBreakEven is null ("cannot yet tell")'
        : 'CI clears break-even, so beatsBreakEven is decided');
  } else {
    ok(false, 'cannot check beatsBreakEven — ci or breakEven missing');
  }
}

console.log('\n-- the tier table is a partition of the same rows --');
const tierN = tiers.reduce((s, t) => s + t.n, 0);
ok(bu && tierN === bu.n, `tier rows sum to the headline n (${tierN} vs ${bu && bu.n})`);
const tierU = tiers.reduce((s, t) => s + t.units, 0);
ok(bu && near(tierU, bu.units, 0.6), `tier units sum to the headline units (${round1(tierU)} vs ${bu && bu.units})`);

console.log('\n-- the era table is the same partition, sliced differently --');
const eraN = eras.reduce((s, e) => s + e.n, 0);
ok(bu && eraN === bu.n, `era rows sum to the headline n (${eraN} vs ${bu && bu.n})`);
const eraU = eras.reduce((s, e) => s + e.units, 0);
ok(bu && near(eraU, bu.units, 0.6), `era units sum to the headline units (${round1(eraU)} vs ${bu && bu.units})`);
ok(eras.every((e) => e.n >= 1), 'no empty era rows');

console.log('\n-- p-values are usable or explicitly absent --');
ok(tiers.every((t) => t.p === null || (t.p >= 0 && t.p <= 1)), 'tier p-values are null or in [0,1]');
ok(eras.every((e) => e.p === null || (e.p >= 0 && e.p <= 1)), 'era p-values are null or in [0,1]');
const anySig = tiers.some((t) => t.p != null && t.p < 0.05);
console.log(`   (any tier clearing p<0.05: ${anySig ? 'YES' : 'no'} — the page must not rank tiers if no)`);

console.log('\n-- the log is real and ordered --');
ok(log.length > 0, `log returns rows (${log.length})`);
if (log.length) {
  const dates = log.map((r) => r.date);
  ok(dates.every((d, i) => i === 0 || dates[i - 1] >= d), 'newest first');
  ok(log.every((r) => r.player && r.date), 'every row has a player and a date');
  ok(log.every((r) => r.result === 'win' || r.result === 'loss' || r.result === 'push'), 'every row is graded');
  ok(log.every((r) => r.side === 'Under'), 'log is posted unders only');
  ok(log.every((r) => r.tier !== 'pass'), 'no passes in the log — a pass was never a play');
  const withClv = log.filter((r) => r.clv != null).length;
  console.log(`   rows carrying CLV: ${withClv} of ${log.length} (nulls are line-moved or unpriced closes)`);
}

function round1(x) { return Math.round(x * 10) / 10; }
console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
