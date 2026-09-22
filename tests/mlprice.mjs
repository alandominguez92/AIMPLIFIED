// A moneyline price the book could not have been offering must not score.
//
// The log holds one such row: AZ +1500 on 2026-07-21, closing -118, on a game
// the model made 55% and scored as a 1-point edge. It won. At +1500 that paid
// 15 units into a posted record whose whole profit was 8.3 — so every other
// pick combined lost money and the page still read +4.0% ROI. The edge and the
// win probability were computed against the real number; only the stored price
// was garbage.
//
// Pinned here: such a row is never logged again, and if one is already in the
// table it grades at the close instead of paying out.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// The real row, plus the ordinary ones it has to leave alone.
const rows = [
  { date: '2026-07-21', game_id: 'g1', team: 'AZ',  tier: '3', win_prob: 55, edge: 1,   entry_price: 1500, close_price: -118, result: 'win' },
  { date: '2026-07-22', game_id: 'g2', team: 'BOS', tier: '1', win_prob: 58, edge: 6,   entry_price: -130, close_price: -140, result: 'win' },
  { date: '2026-07-23', game_id: 'g3', team: 'SF',  tier: '2', win_prob: 44, edge: 4,   entry_price: 168,  close_price: 155,  result: 'loss' },
  { date: '2026-07-24', game_id: 'g4', team: 'ATH', tier: '3', win_prob: 41, edge: 3,   entry_price: 230,  close_price: 240,  result: 'win' },
];
const db = { prepare: () => ({ bind: () => ({ run: async () => ({ meta: { changes: 1 } }), first: async () => null, all: async () => ({ results: rows }) }),
  run: async () => ({ meta: { changes: 1 } }), first: async () => null, all: async () => ({ results: rows }) }), batch: async () => [] };

const tr = await (await mod.default.fetch(new Request('https://x/api/track-record'), { DB: db }, { waitUntil() {} })).json();
const ml = tr.ml || {};
console.log(`  record ${ml.record}  units ${ml.units}  roi ${ml.roi}%\n`);

// -118 pays 0.847; +230 pays 2.30; -130 pays 0.769; the +168 loss is -1.
const expected = 100 / 118 + 2.30 + 100 / 130 - 1;
ok(ml.units != null && Math.abs(ml.units - expected) < 0.15,
  `the +1500 row grades at its close, not its price (${ml.units}u, expected ~${expected.toFixed(1)}u; at +1500 it would be ~${(expected + 15 - 100 / 118).toFixed(1)}u)`);
ok(ml.record === '3–1', `it is still counted as a win — the result was real, the price was not (${ml.record})`);

// And the ordinary rows must be untouched: same call, without the bad row.
const db2 = { ...db, prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: rows.slice(1) }) }),
  run: async () => ({}), first: async () => null, all: async () => ({ results: rows.slice(1) }) }) };
const tr2 = await (await mod.default.fetch(new Request('https://x/api/track-record'), { DB: db2 }, { waitUntil() {} })).json();
const exp2 = 2.30 + 100 / 130 - 1;
ok(tr2.ml && Math.abs(tr2.ml.units - exp2) < 0.05,
  `a normal price is graded at entry exactly as before (${tr2.ml && tr2.ml.units}u vs ${exp2.toFixed(2)}u)`);

// The gate itself, at the values that matter.
const sane = [
  [-118, 55, true,  'the price the game actually closed at'],
  [1500, 55, false, 'the garbled one'],
  [304,  42, true,  'the longest real dog in the log'],
  [-261, 72, true,  'the shortest real favourite in the log'],
  [250,  60, false, 'a price disagreeing with the model by 31 points'],
  [-105, 52, true,  'a coin flip'],
];
for (const [price, wp, want, what] of sane) {
  const got = /* through the record: a row that grades at entry iff the price is sane */ (() => {
    const one = [{ date: 'd', game_id: 'g', team: 'T', tier: '3', win_prob: wp, edge: 1, entry_price: price, close_price: -110, result: 'win' }];
    return one;
  })();
  const dbx = { prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: got }) }),
    run: async () => ({}), first: async () => null, all: async () => ({ results: got }) }), batch: async () => [] };
  const t = await (await mod.default.fetch(new Request('https://x/api/track-record'), { DB: dbx }, { waitUntil() {} })).json();
  const r1 = (x) => Math.round(x * 10) / 10;
  const atEntry = r1(t.ml && t.ml.units) === r1(price > 0 ? price / 100 : 100 / -price);
  ok(atEntry === want, `${want ? 'kept' : 'rejected'}: ${what} (${price} @ ${wp}%)`);
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
