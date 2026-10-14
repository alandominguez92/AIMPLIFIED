// The moneyline record counts a play as it was posted, and measures prices
// against Pinnacle's closing line (2026-10-12).
//
// Posted: buildMlRecord picked posted rows by tier, which every read
// overwrites, so it counted a play by its close-time tier. A T2 that drifted to
// pass by first pitch was never in the record; a pass that ticked up to T3 at
// the close was, graded at a morning price it was never posted at. Rows logged
// since 9c7701e (entry_at set) carry the play as shown, so for them:
//   - posted means posted_at is set, counted at posted_tier, graded at posted_price
//   - the latest tier does not decide it either way
// Older rows keep the old rule as their own legacy line, never mixed into the
// headline.
//
// Against the close: EV% = close fair x decimal(price) - 1, Pinnacle closes
// only. Rows logged before close_fair existed rebuild it from the close read's
// edge and price, which one read wrote together -- but only when the rebuilt
// number agrees with that read's rounded win_prob. fair_source is the ENTRY
// read's: if Pinnacle had dropped out by the close, the close's edge was the
// log5 model against the soft books, and edge + implied is not a fair at all.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });

const base = { opp: 'OPP', is_home: 0, model_ver: 'v', team_score: 1, opp_score: 0 };
const AT = '2026-10-11T18:00:00.000Z';
const ml = [
  // Forward rows.
  { ...base, date: '2026-10-11', game_id: 'f1', team: 'A', tier: 'pass', win_prob: 52, edge: 0.4, entry_price: -110, close_price: -130, result: 'win',
    fair_source: 'pinnacle', entry_at: AT, entry_tier: 'pass', posted_at: AT, posted_tier: '2', posted_price: -120, posted_win_prob: 55, posted_edge: 2.6,
    close_fair: 0.55, close_fair_source: 'pinnacle' },
  { ...base, date: '2026-10-11', game_id: 'f2', team: 'B', tier: '1', win_prob: 50, edge: 4.2, entry_price: 100, close_price: 100, result: 'loss',
    fair_source: 'pinnacle', entry_at: AT, entry_tier: 'pass', posted_at: null, posted_tier: null, posted_price: null,
    close_fair: 0.5, close_fair_source: 'pinnacle' },
  { ...base, date: '2026-10-12', game_id: 'f3', team: 'C', tier: 'pass', win_prob: 60, edge: 0.1, entry_price: -150, close_price: -150, result: 'win',
    fair_source: 'pinnacle', entry_at: AT, entry_tier: 'pass', posted_at: null, close_fair: 0.6, close_fair_source: 'dkfd' },
  // Legacy rows: no entry_at, no close_fair.
  { ...base, date: '2026-09-20', game_id: 'l1', team: 'D', tier: '3', win_prob: 54, edge: 2.0, entry_price: 100, close_price: -110, result: 'win', fair_source: 'pinnacle' },
  { ...base, date: '2026-09-21', game_id: 'l2', team: 'E', tier: 'pass', win_prob: 42, edge: -3.0, entry_price: 120, close_price: 120, result: 'loss', fair_source: 'pinnacle' },
  // Entered on Pinnacle, closed on the soft-book fallback: edge 5 is model vs soft.
  { ...base, date: '2026-09-22', game_id: 'l3', team: 'F', tier: '2', win_prob: 50, edge: 5.0, entry_price: -105, close_price: -110, result: 'loss', fair_source: 'pinnacle' },
  { ...base, date: '2026-09-23', game_id: 'l4', team: 'G', tier: '1', win_prob: 58, edge: 4.5, entry_price: -125, close_price: -130, result: 'win', fair_source: 'dkfd' },
];
const rl = [
  { ...base, date: '2026-09-20', game_id: 'r1', team: 'D', tier: 'pass', win_prob: 40, edge: 0, entry_price: 150, close_price: 150, result: 'win', fair_source: 'pinnacle' },
  { ...base, date: '2026-09-21', game_id: 'r2', team: 'E', tier: 'pass', win_prob: 60, edge: 0, entry_price: -140, close_price: -140, result: 'loss', fair_source: 'pinnacle' },
];
const db = { prepare: (sql) => { const st = { sql, args: [], bind: (...a) => { st.args = a; return st; },
  run: async () => ({ meta: { changes: 0 } }), first: async () => null,
  all: async () => ({ results: /^SELECT \* FROM mlpicks$/i.test(sql.trim()) ? ml : /^SELECT \* FROM rlpicks$/i.test(sql.trim()) ? rl : [] }) }; return st; },
batch: async () => [] };

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), { DB: db }, { waitUntil() {} })).json();
const tr = await get('/api/track-record');
const m = tr.ml || {};
const v = m.vsSharpClose || {};
console.log(`  headline ${m.record} (${m.tracked}) · legacy ${m.legacy && m.legacy.record} · since ${m.forwardSince}`);
console.log(`  vs close: posted ${JSON.stringify(v.posted)}\n            legacy ${JSON.stringify(v.legacyPosted)}\n            all ${JSON.stringify(v.all)}`);

let fail = 0;
const ok = (c, msg) => { console.log((c ? '  PASS  ' : '  FAIL  ') + msg); if (!c) fail++; };

console.log('\n-- posted, as shown --');
ok(m.tracked === 1 && m.record === '1–0', `the headline is the forward posted rows only (${m.record})`);
const t2 = (m.tierBreakdown || []).find((t) => t.tier === '2');
ok(t2 && t2.n === 1 && !(m.tierBreakdown || []).some((t) => t.tier === '1'),
  'a row whose latest tier is pass but was posted at T2 counts as a T2 play');
ok(m.units === Math.round(100 / 120 * 10) / 10, `graded at the price it posted at, -120, not its entry or close (${m.units}u)`);
ok(!(m.tierBreakdown || []).some((t) => t.tier === '1'), 'a row at T1 now but never posted does not count');
ok(m.forwardSince === '2026-10-11', `the headline says when it starts (${m.forwardSince})`);

console.log('\n-- legacy, on the old rule, beside it --');
ok(m.legacy && m.legacy.tracked === 3 && m.legacy.record === '2–1', `the older rows keep the latest-tier rule (${m.legacy && m.legacy.record})`);
ok(m.legacy && m.tracked + m.legacy.tracked === 4, 'and are never added into the headline');

console.log('\n-- against Pinnacle\'s close --');
ok(v.posted && v.posted.n === 1 && v.posted.median === 0.83 && v.posted.mean === 0.83,
  `close fair 0.55 at the posted -120 is +0.83% (${v.posted && v.posted.median})`);
ok(v.posted && v.posted.above === 100, 'and it beat the close');
ok(v.all && v.all.n === 4, `every graded row with a Pinnacle close, posted or not, and no soft-book close (${v.all && v.all.n})`);
ok(v.all && v.all.rebuilt === 2 && v.legacyPosted && v.legacyPosted.n === 1 && v.legacyPosted.rebuilt === 1,
  'older rows rebuild the close fair from edge + implied(close price), and say so');
// Rebuilt fairs: edge/100 + implied(close price).
const fairL1 = 0.02 + 110 / 210;    // 0.5438 beside win_prob 54
const fairL2 = -0.03 + 100 / 220;   // 0.4245 beside win_prob 42
ok(v.legacyPosted && Math.abs(v.legacyPosted.median - Math.round((fairL1 * 2 - 1) * 10000) / 100) < 0.011,
  `a legacy T3 at +100 against its rebuilt close (${v.legacyPosted && v.legacyPosted.median}%)`);
ok(v.rejected === 1, 'a rebuilt fair that disagrees with its own read\'s win chance (57.4 vs 50) is dropped, not guessed');
const expected = (0.55 + 0.5 + fairL1 + fairL2) / 4 * 100;
ok(v.all && v.all.won === 50 && Math.abs(v.all.expected - expected) < 0.1,
  `won beside the close's own expectation (${v.all && v.all.won}% vs ${v.all && v.all.expected}%)`);

console.log('\n-- the run line still counts every row --');
ok(tr.rl && tr.rl.tracked === 2, `rl rows are all counted, pass included (${tr.rl && tr.rl.tracked})`);

console.log('\n-- the summary --');
const S = await get('/api/track-record?summary=1');
ok(S.ml && S.ml.vsSharpClose && S.ml.vsSharpClose.posted && S.ml.legacy && S.ml.forwardSince,
  'scheduled checks get the close measure, the legacy line and the start date');

// ---- on the page --------------------------------------------------------------------
// "ML by price" counts every graded row, pass included (it sums to 880 where
// the posted record says 219), and says so; under it, one read against the
// close. Lifted out of app.js, so this runs what ships.
console.log('\n-- on the page --');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
function lift(name) {
  let at = app.indexOf(`function ${name}(`);
  const isConst = at < 0;
  if (isConst) at = app.indexOf(`const ${name} =`);
  if (at < 0) throw new Error(`app.js has no ${name}`);
  let depth = 0, seen = false;
  for (let i = at; i < app.length; i++) {
    const c = app[i];
    if (c === '{' || c === '(' || c === '[') { depth++; seen = true; }
    else if (c === '}' || c === ')' || c === ']') depth--;
    if (seen && depth === 0) {
      if (!isConst && c === '}') return app.slice(at, i + 1);
      if (isConst && app[i + 1] === ';') return app.slice(at, i + 2);
    }
  }
  throw new Error(`could not close ${name}`);
}
const P = new Function('esc', ['ML_BAND_SHORT', 'shortDay', 'mlPriceTable', 'mlCloseLine'].map(lift).join('\n') + '\nreturn { mlPriceTable };')((s) => String(s));
const html = P.mlPriceTable(tr.ml.byPriceBand, tr.ml).replace(/\s+/g, ' ');
const nBands = Object.values(tr.ml.byPriceBand).reduce((s, b) => s + b.n, 0);
console.log('  ' + (html.match(/<p class="ml-close">.*$/) || [''])[0].replace(/<[^>]+>/g, ' | ').replace(/( \| )+/g, ' | '));
ok(html.includes(`Every graded moneyline, pass included (${nBands})`), `the table says it counts every graded row (${nBands})`);
ok(html.includes(`vs Pinnacle's closing line:</b> median +0.4% · beat it on 50% of 4`), 'one line of every row against the close');
ok(html.includes('Posted plays since Oct 11: median +0.8% · beat it on 100% of 1'), 'then the posted plays, from when they were logged as shown');
ok(html.includes('before, by close-time tier: median +8.8% · beat it on 100% of 1'), 'with the older posted rows as their own clause');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
