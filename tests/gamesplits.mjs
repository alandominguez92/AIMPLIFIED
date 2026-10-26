// Two records split by the game (2026-10-26).
//
//   - NBA PrizePicks unders by how lopsided their game was: the moneyline
//     log's chance for the same game's favourite, 75%+ against under 60%, all
//     rotation legs and starters (28+ projected minutes) apart. Starters sit
//     late in a blowout, which an under should like.
//   - NHL home favourites at 60%+, logged beside the 65%+ bar: by Oct 25 the
//     NHL's 65%+ favourites were 2 of 5 and its 55-65% ones 13 of 18, home
//     sides 17 of 26 and away ones 5 of 13. Not on Picks of the day.
//
// The games are production's: its NBA and NHL moneyline rows as
// /api/gmpicks-export served them at 11:40 PM Pacific on Oct 25
// (tests/fixtures/gmpicks-nba-nhl-20261025.json). The NBA unders are legs of
// those games, written as the grader leaves them. Real SQLite, the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const REC = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'gmpicks-nba-nhl-20261025.json'), 'utf8'));
const RealDate = Date;
const NOW = RealDate.parse(REC.at);
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

await get('/api/gmpicks-export'); await get('/api/nba-pp');      // the tables
const cols = Object.keys(REC.rows[0]);
const ins = sq.prepare(`INSERT INTO gmpicks (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
for (const r of REC.rows) ins.run(...cols.map((k) => r[k]));

// ---- NHL home favourites at 60%+ --------------------------------------------------------------
console.log('-- NHL --');
const nhl = (await get('/api/nhl-board')).record || {};
const graded = REC.rows.filter((r) => r.sport === 'nhl' && (r.result === 'win' || r.result === 'loss'));
const home60 = graded.filter((r) => r.side === 'home' && r.win_prob >= 60);
const won = home60.filter((r) => r.result === 'win').length;
console.log(`  65%+ ${nhl.byBand && nhl.byBand['65+'].record} · home 60%+ ${nhl.homeFav60 && nhl.homeFav60.record} (${nhl.homeFav60 && nhl.homeFav60.expected}% expected)`);
ok(nhl.homeFav60 && nhl.homeFav60.n === home60.length && nhl.homeFav60.record === `${won}–${home60.length - won}` && home60.length > 0,
  `home favourites at 60%+ from the log itself: ${won} of ${home60.length}`);
ok(nhl.byBand && nhl.byBand['65+'].n === graded.filter((r) => r.win_prob >= 65).length, 'beside the 65%+ bar, which stays as it was');

// ---- NBA unders by the game ---------------------------------------------------------------------
console.log('\n-- NBA unders by how lopsided the game was --');
const games = REC.rows.filter((r) => r.sport === 'nba' && r.market === 'h2h' && r.win_prob != null);
const lop = games.filter((g) => g.win_prob >= 75), mid = games.filter((g) => g.win_prob >= 60 && g.win_prob < 75), close = games.filter((g) => g.win_prob < 60);
ok(lop.length >= 2 && mid.length >= 1 && close.length >= 2, `real games of each kind: ${lop.length} at 75%+, ${mid.length} at 60-75, ${close.length} under 60`);
const leg = sq.prepare(`INSERT INTO nbapp (date, game_id, player, market, point, model_under, min_proj, result) VALUES (?, ?, ?, 'ast', 4.5, 60, ?, ?)`);
// In two lopsided games: three starters' unders land, one misses, a bench leg misses.
leg.run(lop[0].date, lop[0].game_id, 'Starter A', 34, 'under'); leg.run(lop[0].date, lop[0].game_id, 'Starter B', 31, 'under');
leg.run(lop[1].date, lop[1].game_id, 'Starter C', 33, 'under'); leg.run(lop[1].date, lop[1].game_id, 'Starter D', 30, 'over');
leg.run(lop[1].date, lop[1].game_id, 'Bench E', 22, 'over');
// In two close games: one of three starters lands; one in between; one with no line.
leg.run(close[0].date, close[0].game_id, 'Starter F', 35, 'over'); leg.run(close[0].date, close[0].game_id, 'Starter G', 32, 'under');
leg.run(close[1].date, close[1].game_id, 'Starter H', 29, 'over');
leg.run(mid[0].date, mid[0].game_id, 'Starter I', 33, 'under');
leg.run('2026-10-24', 'no-such-game', 'Starter J', 30, 'under');
leg.run(lop[0].date, lop[0].game_id, 'Pushed K', 30, 'push');
const g = (await get('/api/nba-pp')).record.byGame;
console.log('  starters ' + JSON.stringify(g.starters));
ok(g.starters['75+'].n === 4 && g.starters['75+'].hit === 3 && g.all['75+'].n === 5 && g.all['75+'].hit === 3,
  'lopsided: starters 3 of 4; with the bench leg, 3 of 5; the push left out');
ok(g.starters['under 60'].n === 3 && g.starters['under 60'].hit === 1 && g.starters['60-75'].n === 1 && g.starters['no line'].n === 1,
  'close: 1 of 3; in between, and a game with no moneyline logged, kept apart');

// ---- the page ---------------------------------------------------------------------------------------
console.log('\n-- the page --');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const lift = (name) => { const at = app.indexOf(`function ${name}(`); let depth = 0;
  for (let i = app.indexOf('{', at); i < app.length; i++) { if (app[i] === '{') depth++; else if (app[i] === '}' && --depth === 0) return app.slice(at, i + 1); } };
const esc = (s) => String(s == null ? '' : s);
const P = new Function('esc', [lift('gmRecordHtml'), lift('ppGameLineHtml')].join('\n') + '\nreturn { gmRecordHtml, ppGameLineHtml };')(esc);
const text = (h) => h.replace(/<[^>]+>/g, '').trim();
const line = text(P.gmRecordHtml(nhl, 'none'));
ok(new RegExp(`home favourites at 60%\\+ ${won} of ${home60.length} \\(`).test(line), `the NHL tab: "${line}"`);
ok(text(P.gmRecordHtml({ n: 3, record: '2–1', byBand: { '65+': { n: 1, record: '1–0', expected: 70 } } }, 'none')).indexOf('home favourites') < 0, 'and only where the log has one: not on the NFL tab');
const card = text(P.ppGameLineHtml(g));
ok(card === "Starters' unders: in a lopsided game (favourite 75%+) 3 of 4 · in a close one (under 60%) 1 of 3", `the NBA card: "${card}"`);
ok(P.ppGameLineHtml({ starters: { '75+': { n: 0 }, 'under 60': { n: 0 } } }) === '' && P.ppGameLineHtml(null) === '', 'nothing before either has graded');
ok(/nbaOversLineHtml\(r\.overs\) \+ ppCloseLineHtml\(r\) \+ ppGameLineHtml\(r\.byGame\)/.test(app), 'on the NBA card, under its other record lines');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
