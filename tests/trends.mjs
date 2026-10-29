// Players on a run (2026-10-29, the owner's call): "keep players that are
// constantly reaching a favorable stat in mind" -- points, assists, shots,
// touchdowns. The NBA's bars read its box scores (tests/betlinks.mjs); these
// are the NHL's and the NFL's. What has to hold:
//   - an NHL leg's last games come from the NHL's own game log: its points,
//     assists or shots, oldest first, the last ten, against the leg's line --
//     read once and kept six hours, so a page load does not ask the NHL again
//   - a passing-TD under's come from the log's own graded games, the
//     quarterback's touchdowns, one a game even where a game was logged under
//     two dates
//   - a leg with neither gets none
//   - on the page, a run is named: seven in ten the leg's way, or three or
//     fewer against it, from five games on
//
// Real data: the NHL's game logs of Dylan Strome, Erik Karlsson and Lane
// Hutson on Oct 29, three of that day's NHL Mores on Picks
// (tests/fixtures/nhl-gamelog-20261029.json), and production's passing-TD log
// on Oct 27, Weeks 3-7 (tests/fixtures/gmpicks-nflptd-20261027.json).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const fx = (f) => JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', f), 'utf8'));
const NHL = fx('nhl-gamelog-20261029.json').logs;
const PTD = fx('gmpicks-nflptd-20261027.json').rows;
const RealDate = Date;
let NOW = RealDate.parse('2026-10-29T19:45:00Z');
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
const asked = [];
globalThis.fetch = async (u) => {
  const m = String(u).match(/^https:\/\/api-web\.nhle\.com\/v1\/player\/(\d+)\/game-log\/now$/);
  asked.push(String(u));
  return m && NHL[m[1]] ? new Response(JSON.stringify(NHL[m[1]]), { status: 200 }) : new Response('{}', { status: 404 });
};
const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const exec = (sql, args, mode) => { const st = sq.prepare(sql); const a = args.map(norm);
  if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
  return { success: true, meta: { changes: Number(st.run(...a).changes) } }; };
const DB = { prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
  all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
  run: async () => exec(s.sql, s.args, 'run') }; return s; }, batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')) };

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const wlift = (name) => { let at = src.indexOf(`function ${name}(`); if (at < 0) throw new Error(`worker.js has no ${name}`); if (src.slice(at - 6, at) === 'async ') at -= 6; let dd = 0;
  for (let i = src.indexOf(') {', at) + 2; i < src.length; i++) { if (src[i] === '{') dd++; else if (src[i] === '}' && --dd === 0) return src.slice(at, i + 1); } };
const cst = (name) => { const at = src.indexOf(`const ${name} =`); if (at < 0) throw new Error(`worker.js has no ${name}`); return src.slice(at, src.indexOf(';\n', at) + 1); };
let W;
try {
  W = new Function(['TREND_N', 'NHL_LOG_TTL_MS', 'NHL_LOG_STAT', 'NFL_NAME_SUFFIX', 'nflBaseName', 'NFL_PASS_TD_LINE'].map(cst)
    .concat(['trendOf', 'ensureFeedCacheSchema', 'loadFeedCache', 'saveFeedCache', 'nhlGameLog', 'nhlTrends', 'normName', 'ptdTrends'].map(wlift)).join('\n')
    + '\nreturn { nhlTrends, ptdTrends };')();
} catch (e) { console.log(`  FAIL  the trends lift out of worker.js (${e.message})`); process.exit(1); }

console.log('-- the NHL Mores --');
const leg = (id, market, line, name) => ({ legId: `nhl:${name}:${market}`, kind: 'nhl_more', spec: { sport: 'nhl', playerId: id, player: name, market, side: 'Over', pp: { line } } });
const legs = [leg('8478440', 'pts', 0.5, 'Dylan Strome'), leg('8474578', 'ast', 0.5, 'Erik Karlsson'), leg('8483457', 'pts', 0.5, 'Lane Hutson'),
  { legId: 'nba', kind: 'nba_pp', spec: { sport: 'nba', playerId: '1', market: 'pts', side: 'Under', pp: { line: 20.5 } } }];
const t = await W.nhlTrends(DB, legs);
for (const [k, v] of t) console.log(`  ${k}: ${v.vals.join(',')} · ${v.side} in ${v.hit}`);
const log = (id, f) => NHL[id].gameLog.slice(0, 10).reverse().map((g) => g[f]);
const st = t.get('nhl:Dylan Strome:pts');
ok(st && st.vals.join() === log('8478440', 'points').join() && st.vals.length === 10 && st.vals[st.vals.length - 1] === 3,
  "Strome's points in his last ten games, oldest first -- the 3 on Oct 28 last");
ok(st && st.hit === st.vals.filter((v) => v > 0.5).length && st.side === 'over' && st.line === 0.5, 'against the leg\'s line, the Mores that went over');
ok(t.get('nhl:Erik Karlsson:ast').vals.join() === log('8474578', 'assists').join(), "Karlsson's assists, for his assists leg");
ok(t.size === 3 && !t.has('nba'), 'an NBA leg is not the NHL\'s');
ok(asked.filter((u) => /game-log/.test(u)).length === 3, 'one read a player');
NOW += 3600e3;
await W.nhlTrends(DB, legs);
ok(asked.filter((u) => /game-log/.test(u)).length === 3, 'an hour on, the kept logs answer: no read');
NOW += 6 * 3600e3;
await W.nhlTrends(DB, legs);
ok(asked.filter((u) => /game-log/.test(u)).length === 6, 'past six hours, each is read again');

console.log('\n-- the passing-TD unders --');
sq.prepare('CREATE TABLE gmpicks (sport TEXT, date TEXT, game_id TEXT, market TEXT, result TEXT, home_score INTEGER, PRIMARY KEY (sport, date, game_id, market))').run();
for (const r of PTD) sq.prepare('INSERT INTO gmpicks VALUES (?,?,?,?,?,?)').run(r.sport, r.date, r.game_id, r.market, r.result, r.home_score);
const qb = (name) => ({ legId: `ptd:${name}`, kind: 'nfl_ptd', spec: { sport: 'nfl', player: name, market: 'pass_tds', side: 'Under', pp: { line: 1.5 } } });
const p = await W.ptdTrends(DB, [qb('Jordan Love'), qb('Josh Allen'), qb('Nobody Here')]);
for (const [k, v] of p) console.log(`  ${k}: ${v.vals.join(',')} · under in ${v.hit}`);
const tds = (name) => [...new Map(PTD.filter((r) => r.game_id.endsWith(`|${name}`) && ['win', 'loss', 'push'].includes(r.result)).sort((a, b) => (a.date < b.date ? -1 : 1))
  .map((r) => [r.game_id, r.home_score])).values()];
ok(p.get('ptd:Jordan Love').vals.join() === '2,2,2,1,2' && p.get('ptd:Jordan Love').hit === 1, "Jordan Love's touchdowns, Weeks 3-7: 2, 2, 2, 1, 2 -- under 1.5 once");
ok(p.get('ptd:Josh Allen').vals.length === tds('Josh Allen').length && p.get('ptd:Josh Allen').vals.length === 4,
  "Josh Allen's Week 3, logged under Sep 24 and Sep 27, counts once: four games, not five");
ok(!p.has('ptd:Nobody Here'), 'a quarterback with no graded games gets none');

console.log('\n-- the page --');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const at = app.indexOf('  function trendTag(');
const tag = new Function(app.slice(at, app.indexOf('\n  }\n', at) + 4) + '\nreturn trendTag;')();
const tt = (vals, line, side) => { const v = vals; return tag({ vals: v, line, side, hit: v.filter((x) => (side === 'under' ? x < line : x > line)).length }); };
ok(JSON.stringify(tt(log('8478440', 'points'), 0.5, 'over')) === JSON.stringify(st.hit / 10 >= 0.7 ? { good: true, text: `over in ${st.hit} of last 10` } : st.hit / 10 <= 0.3 ? { good: false, text: `over in only ${st.hit} of last 10` } : null),
  `Strome's run, named as it is (${JSON.stringify(tt(log('8478440', 'points'), 0.5, 'over'))})`);
ok(JSON.stringify(tt([2, 2, 2, 1, 2], 1.5, 'under')) === JSON.stringify({ good: false, text: 'under in only 1 of last 5' }), "Love's under: only 1 of 5, against the pick");
ok(JSON.stringify(tt([1, 0, 1, 1, 0, 1, 1], 1.5, 'under')) === JSON.stringify({ good: true, text: 'under in 7 of last 7' }), 'seven of seven its way');
ok(tt([0, 1, 0, 1], 1.5, 'under') === null && tt([1, 2, 1, 2, 1, 2], 1.5, 'under') === null, 'fewer than five games, or no run either way: nothing');
ok(/const tt = trendTag\(x\.trend\);\n\s+if \(tt\) tags\.push/.test(app) && /const tt = trendTag\(x\.trend\);\n\s+if \(tt\) notes\.push\(tt\.text\);/.test(app), 'on the list\'s rows and the hero');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
