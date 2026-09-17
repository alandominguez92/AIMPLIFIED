// projCalSuggest measures the projection bias of the constants NOW in force.
//
// It multiplies measured actual/proj by the current BATTER_PROJ_CAL, so it is only
// right when every row it measures was projected under that same constant. It used
// to select rows by week (2026-W33 on), which held until the 2026-09-17 H+R+RBI
// change moved 1.00 -> 1.11: a month of rows projected at 1.00 would then be read
// as if projected at 1.11, and the report would have recommended ~1.25 on its next
// read — a large over-correction from no new information. The boundary that
// actually marks "rows this constant produced" is model_ver, stamped at log time.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const VER = (src.match(/const BATTER_MODEL_VER = '([^']+)'/) || [])[1];
const CAL = Number((src.match(/const BATTER_PROJ_CAL = \{[^}]*hrr:\s*([\d.]+)/) || [])[1]);

// Old era: projected low (1.6 vs 1.8). Current era: already corrected (1.8 vs 1.8).
const row = (ver, date, proj, actual, i) => ({
  date, game_id: 'g' + i, player_id: i, player: 'P' + i, team: 'T', market: 'hrr',
  line: 1.5, side: 'Under', price: -120, proj, model_over: 45, edge: 1, tier: 'play',
  actual, result: actual < 2 ? 'win' : 'loss', entry_over: 0.47, close_line: 1.5, close_price: -120,
  close_over: 0.47, fair_src: 'sharp', model_ver: ver,
});
let TABLE = [];
const setTable = (withCurrent) => {
  TABLE = [];
  for (let i = 0; i < 400; i++) TABLE.push(row('sharp-shin-nb-evgate', '2026-09-0' + (1 + (i % 9)), 1.6, 1.8, i));
  if (withCurrent) for (let i = 0; i < 400; i++) TABLE.push(row(VER, '2026-09-18', 1.8, 1.8, 10000 + i));
};
const db = {
  prepare: (sql) => {
    const st = {
      bind: () => st,
      run: async () => ({ meta: { changes: 0 } }),
      first: async () => null,
      all: async () => ({ results: /FROM bpicks/i.test(sql) ? TABLE : [] }),
    };
    return st;
  },
  batch: async () => [],
};
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const suggest = async () => {
  const d = await (await mod.default.fetch(new Request('https://x/api/batter-debug'), { DB: db }, { waitUntil() {} })).json();
  if (d.error) throw new Error(d.error);
  return (d.projCalSuggest.markets || []).find((m) => m.market === 'HRR');
};

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
console.log(`current version ${VER}, H+R+RBI constant ${CAL}\n`);

setTable(true);
const both = await suggest();
console.log('-- a month under the old constant, plus rows under the current one --');
ok(both.n === 400, `only the current version's rows are measured (${both.n} of ${TABLE.length})`);
ok(both.k === 1, `they are already on target (k=${both.k})`);
ok(both.suggestedAt85 === CAL, `so it suggests holding at ${CAL} (${both.suggestedAt85}), not compounding the old bias onto the new constant`);

setTable(false);
const none = await suggest();
console.log('\n-- the new version has nothing graded yet --');
ok(none.n === 0 && /no graded rows/.test(none.note || ''),
  `it says so (${none.note}) instead of re-reading the old era`);
ok(none.suggestedAt85 === undefined, 'and suggests no value from rows it should not be reading');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
