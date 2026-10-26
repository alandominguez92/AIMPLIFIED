// NFL moneylines go on Picks of the day at 75%+, not 65%+ (2026-10-26).
//
// Through Week 7 the NFL log's favourites at 75%+ won 11 of 14 (78.5%
// stated), while those at 65-75% won 6 of 12 (about 70% stated). On Oct 25
// the list carried four NFL favourites and two lost: the Texans (80.9%) and
// the Jets (65.6%). The owner raised the bar ("too many losses"). What has to
// hold:
//   - an NFL favourite under 75% is not on the list; one at 75%+ is
//   - the NFL kind's record ("Legs like this") counts its 75%+ favourites only
//   - the other sports keep their 65% bar
//   - the NFL tab's record line leads with 75%+ and keeps the 65-75% band it
//     left beside it, marked off Picks; the NHL tab's line is as it was
//
// Real data: production's NFL moneyline rows as /api/gmpicks-export served
// them at 1:31 PM Pacific on Oct 26, Sunday graded
// (tests/fixtures/gmpicks-nfl-20261026.json). For the list, Sunday's rows are
// set back to ungraded and the clock to 9 AM that morning, before the early
// kickoffs. Real SQLite and the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const REC = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'gmpicks-nfl-20261026.json'), 'utf8'));
const RealDate = Date;
let NOW = RealDate.parse(REC.at);
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
globalThis.fetch = async () => new Response('{}', { status: 404 });
const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
function exec(sql, args, mode) {
  const st = sq.prepare(sql);
  const a = args.map(norm);
  if (mode === 'all') return { results: st.all(...a), meta: {} };
  if (mode === 'first') return st.get(...a) || null;
  return { success: true, meta: { changes: Number(st.run(...a).changes) } };
}
const DB = {
  prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
    all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
    run: async () => exec(s.sql, s.args, 'run') }; return s; },
  batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')),
};
const env = { DB };
const mod = await import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(BOARD + '/worker.js', 'utf8')).toString('base64'));
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const rec = (l) => `${l.filter((r) => r.result === 'win').length} of ${l.length}`;

await get('/api/gmpicks-export'); await get('/api/picks'); await get('/api/nfl-board');   // the tables
const cols = Object.keys(REC.rows[0]);
const ins = sq.prepare(`INSERT INTO gmpicks (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
for (const r of REC.rows) ins.run(...cols.map((k) => r[k]));
const graded = REC.rows.filter((r) => r.result === 'win' || r.result === 'loss');
const top = graded.filter((r) => r.win_prob >= 75), mid = graded.filter((r) => r.win_prob >= 65 && r.win_prob < 75);
console.log(`  the log: 75%+ ${rec(top)}, 65-75% ${rec(mid)}`);
ok(rec(top) === '11 of 14' && rec(mid) === '6 of 12', 'the record the bar was moved on: 75%+ 11 of 14, 65-75% 6 of 12');

// ---- the NFL tab's record ---------------------------------------------------------------------
console.log('\n-- /api/nfl-board --');
const r = (await get('/api/nfl-board?cb=1')).record || {};
const bb = r.byBand || {};
console.log(`  bar ${r.bar} · 75+ ${JSON.stringify(bb['75+'])} · 65-75 ${JSON.stringify(bb['65-75'])}`);
ok(r.bar === 75 && bb['75+'] && bb['75+'].n === 14 && bb['75+'].record === '11–3' && bb['65-75'] && bb['65-75'].n === 12 && bb['65-75'].record === '6–6',
  'its bar is 75, with its 75%+ and 65-75% favourites');
ok(bb['65+'] && bb['65+'].n === 26, 'and the 65%+ band it had, still there');

// ---- Picks of the day, Sunday morning -----------------------------------------------------------
console.log('\n-- Picks of the day, 9 AM Sunday --');
const sunday = REC.rows.filter((x) => x.date === '2026-10-25');
sq.prepare("UPDATE gmpicks SET result = NULL, home_score = NULL, away_score = NULL WHERE date = '2026-10-25'").run();
NOW = RealDate.parse('2026-10-25T16:00:00Z');
const p = await get('/api/picks');
const nfl = (p.legs || []).filter((l) => l.kind === 'nfl_ml');
const want = sunday.filter((x) => x.win_prob >= 75).map((x) => `${x.pick} ML`);
console.log('  NFL legs: ' + nfl.map((l) => `${l.title} ${l.p}`).join(', '));
ok(want.join() === 'HOU ML' && nfl.map((l) => l.title).join() === want.join(), 'the Texans alone, at 80.9%');
for (const t of ['MIN', 'DEN', 'NYJ']) {
  const x = sunday.find((s) => s.pick === t);
  ok(x && x.win_prob >= 65 && x.win_prob < 75 && !nfl.some((l) => l.title === `${t} ML`), `${t} at ${x && x.win_prob}%: off the list`);
}
const k = (p.kinds || {}).nfl_ml || {};
const before = graded.filter((x) => x.date !== '2026-10-25' && x.win_prob >= 75);
ok(k.min === 75 && k.record && k.record.n === before.length && k.record.hit === before.filter((x) => x.result === 'win').length,
  `its record counts 75%+ favourites only: ${k.record && k.record.hit} of ${k.record && k.record.n}`);
ok(['nba_ml', 'nhl_ml', 'soccer_fav', 'mlb_ml'].every((x) => p.kinds[x] && p.kinds[x].min === 65), 'NBA, NHL, soccer and MLB favourites stay at 65%+');
ok(/NFL moneyline favourite, 75%\+/.test(JSON.stringify(p.rules)), 'the rules say so');

// ---- the page --------------------------------------------------------------------------------------
console.log('\n-- the page --');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const lift = (name) => { const at = app.indexOf(`function ${name}(`); let depth = 0;
  for (let i = app.indexOf('{', at); i < app.length; i++) { if (app[i] === '{') depth++; else if (app[i] === '}' && --depth === 0) return app.slice(at, i + 1); } };
const gmRecordHtml = new Function('esc', lift('gmRecordHtml') + '\nreturn gmRecordHtml;')((s) => String(s == null ? '' : s));
const text = (h) => h.replace(/<[^>]+>/g, '').trim();
const line = text(gmRecordHtml(r, 'none'));
console.log('  NFL: ' + line);
ok(new RegExp(`^Record so far [\\d–]+ · favourites at 75%\\+ 11 of 14 \\(78\\.5% expected\\) · at 65–75% 6 of 12 \\(69\\.5% expected\\), off Picks$`).test(line),
  'the NFL tab: 75%+ first, the band it left beside it');
const nhl = { n: 39, record: '22–17', bar: 65, byBand: { '65+': { n: 7, record: '3–4', expected: 68.1 } } };
ok(text(gmRecordHtml(nhl, 'none')) === 'Record so far 22–17 · favourites at 65%+ 3 of 7 (68.1% expected)', 'the NHL tab, as it was');
ok(text(gmRecordHtml({ ...nhl, bar: undefined }, 'none')) === text(gmRecordHtml(nhl, 'none')), 'and a record cached before the bar was sent reads 65%+');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
