// The track record shows the batter model's own calibration (2026-10-11).
//
// Its calibration curve and per-tier table are the STRIKEOUT model's, and the
// heading said only "Model Calibration": the improvement analysis read "says
// 64%, lands 48.7%" as the batter unders. Measured, this era's batter model is
// close to honest (60-65% landed 59.9%). The record now carries the batter
// model's own table, for the posted market, this pricing era only:
//   - both sides count: a line's under either landed or did not, whichever
//     side was logged
//   - another era's rows are not in it
//   - a band shows only with 20+ lines behind it
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const ERA = (src.match(/const BATTER_MODEL_VER = '([^']+)'/) || [])[1];

const rows = [];
const add = (n, modelOver, side, wins, ver = ERA) => {
  for (let i = 0; i < n; i++) rows.push({ date: '2026-10-0' + (1 + (i % 9)), game_id: 'g' + rows.length, player_id: rows.length, player: 'P', team: 'T',
    market: 'hrr', line: 1.5, side, price: -110, proj: 1.2, model_over: modelOver, edge: 1, tier: 'pass', result: i < wins ? 'win' : 'loss',
    model_ver: ver, actual: 0, entry_over: 0.5 });
};
add(30, 38, 'Under', 18);   // the model put the under at 62%: 18 of 30 landed (60%)
add(30, 52, 'Over', 14);    // under at 48% on over rows: the over won 14, so the under landed 16 of 30
add(10, 30, 'Under', 9);    // a band with too few lines to show
add(40, 38, 'Under', 0, 'some-older-era');   // another era: not in the table
const db = { prepare: (sql) => { const st = { sql, args: [], bind: (...a) => { st.args = a; return st; },
  run: async () => ({ meta: { changes: 0 } }), first: async () => null,
  all: async () => ({ results: /FROM bpicks/i.test(sql) ? rows : [] }) }; return st; },
batch: async () => [] };
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const tr = await (await mod.default.fetch(new Request('https://x/api/track-record'), { DB: db }, { waitUntil() {} })).json();
const c = tr.calibrationBatter;
console.log('  ' + JSON.stringify(c));

let fail = 0;
const ok = (x, m) => { console.log((x ? '  PASS  ' : '  FAIL  ') + m); if (!x) fail++; };
ok(c && c.era === ERA && c.n === 70, `this era's batter lines, every side, and none from another era (${c && c.n})`);
const b60 = c && c.bins.find((b) => b.band === '60-65'), b45 = c && c.bins.find((b) => b.band === '45-50');
ok(b60 && b60.predicted === 62 && b60.actual === 60 && b60.n === 30, 'under at 62% on under rows: 18 of 30 landed');
ok(b45 && b45.predicted === 48 && b45.actual === Math.round(16 / 30 * 1000) / 10 && b45.n === 30,
  'over rows count by the under too: the over won 14 of 30, so the under landed 16');
ok(c && !c.bins.some((b) => b.band === '70-75'), 'a band with fewer than 20 lines does not show');
ok(Array.isArray(tr.calibration), 'and the strikeout curve is still there beside it');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
