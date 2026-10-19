// Every NBA box-score stat stored, and gradable (2026-10-15).
//
// nba_box kept minutes, threes, assists and rebounds -- the three markets the
// PrizePicks log captures. To find out which other market is worth logging
// before the season opens, the ingest now keeps the whole box score line:
// points, offensive and defensive rebounds, field goals and threes made and
// attempted, free throws made and attempted, steals, blocks, turnovers and
// fouls. The three logged markets must grade exactly as they did.
//
// Real SQLite underneath (node:sqlite), real ESPN payloads: a recorded
// regular-season box score (tests/fixtures/espn-nba-box-401810437.json --
// Spurs 119, Bucks 101, 2026-01-15, Bismack Biyombo did-not-play) and that
// day's recorded scoreboard. The fetch stub answers only those two requests.
//
// What has to hold:
//   - an nba_box table made before this change gains the columns, and the rows
//     already in it keep what they were read with: nothing is rewritten, and a
//     stat they were never read with is null, not 0
//   - each stat is read from its own column of the box score line, made and
//     attempted from the right side of "7-12", and a column ESPN did not send
//     is null rather than 0
//   - the log and your entries grade any of those markets, combos as the sum
//     of their parts; a leg on a stat a row does not have is void, never a
//     free under; threes, assists and rebounds grade as before
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = path.join(BOARD, 'tests', 'fixtures');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const RealDate = Date;
let NOW = RealDate.parse('2026-01-16T18:00:00Z');        // 10am Pacific, the morning after the game
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};

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
const env = { DB, ASSETS: { fetch: async () => new Response('{}', { status: 404 }) } };

// ---- the feeds: exactly the two requests the ingest should make ---------------------
const SCORE = fs.readFileSync(path.join(FIX, 'espn-nba-20260115.json'), 'utf8');
const BOX_TEXT = fs.readFileSync(path.join(FIX, 'espn-nba-box-401810437.json'), 'utf8');
let scoreboardOpen = false;
const asked = [];
globalThis.fetch = async (u) => {
  const url = String(u);
  asked.push(url);
  const J = (x) => new Response(x, { status: 200, headers: { 'content-type': 'application/json' } });
  if (scoreboardOpen && url === 'https://cdn.espn.com/core/nba/scoreboard?xhr=1&date=20260115') return J(SCORE);
  if (url === 'https://cdn.espn.com/core/nba/boxscore?xhr=1&gameId=401810437') return J(BOX_TEXT);
  return new Response('{}', { status: 404 });
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const tick = async () => { const held = []; await mod.default.scheduled({}, env, { waitUntil: (p) => held.push(p) }); await Promise.allSettled(held); };

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// ---- a table from before this change -------------------------------------------------
// The CREATE production ran from 2026-10-06, and a game read under it: the same
// day, so the graders meet both kinds of row side by side.
sq.exec(`CREATE TABLE nba_box (
    game_id TEXT NOT NULL, date TEXT NOT NULL, season_type INTEGER,
    player_id TEXT NOT NULL, player TEXT, team TEXT,
    min REAL, threes INTEGER, ast INTEGER, reb INTEGER, starter INTEGER, dnp INTEGER,
    PRIMARY KEY (game_id, player_id)
  )`);
sq.exec(`CREATE TABLE nba_box_games (game_id TEXT PRIMARY KEY, date TEXT, season_type INTEGER, done INTEGER DEFAULT 0)`);
sq.exec(`INSERT INTO nba_box (game_id, date, season_type, player_id, player, team, min, threes, ast, reb, starter, dnp)
  VALUES ('old1', '2026-01-15', 2, '9001', 'Early Read', 'NY', 31, 2, 6, 7, 1, 0)`);
sq.exec("INSERT INTO nba_box_games (game_id, date, season_type, done) VALUES ('old1', '2026-01-15', 2, 1)");
const before = JSON.stringify(sq.prepare("SELECT game_id, date, season_type, player_id, player, team, min, threes, ast, reb, starter, dnp FROM nba_box WHERE game_id = 'old1'").get());

console.log('-- an existing table, forward only --');
await tick();                                            // the scan finds nothing yet
const cols = sq.prepare('PRAGMA table_info(nba_box)').all().map((c) => c.name);
const want = ['pts', 'oreb', 'dreb', 'fgm', 'fga', 'fg3a', 'ftm', 'fta', 'stl', 'blk', 'tov', 'pf'];
ok(want.every((c) => cols.includes(c)), `the existing table gains every new column (missing: ${want.filter((c) => !cols.includes(c)).join(', ') || 'none'})`);
const old = sq.prepare("SELECT * FROM nba_box WHERE game_id = 'old1'").get();
const oldNow = JSON.stringify(sq.prepare("SELECT game_id, date, season_type, player_id, player, team, min, threes, ast, reb, starter, dnp FROM nba_box WHERE game_id = 'old1'").get());
ok(oldNow === before, 'the row read before keeps exactly what it was read with');
ok(want.every((c) => old[c] === null), `and has no value for a stat it was never read with -- null, not 0 (${want.map((c) => old[c]).join(',')})`);

// ---- the recorded game in --------------------------------------------------------------
console.log('\n-- a box score line, every stat --');
const nbappCols = '(date, game_id, player, market, player_id, point, model_under, min_proj)';
// Logged legs for that night, as the log will write them once it captures
// more markets: the grader has to read each from the box score.
const legRows = [
  ['Victor Wembanyama', 'pts', '5104157', 21.5], ['Stephon Castle', 'pra', '4845367', 30.5],
  ['Kyle Kuzma', 'fg3a', '3134907', 12.5], ['Julian Champagnie', 'reb_ast', '4592479', 11.5],
  ['Keldon Johnson', 'blk_stl', '4395723', 3], ['Early Read', 'pts', '9001', 18.5], ['Early Read', 'threes', '9001', 2.5],
  ['Victor Wembanyama', 'reb', '5104157', 10.5], ['Bismack Biyombo', 'blk', '6427', 0.5],
];
for (const [p, m, id, pt] of legRows) {
  sq.prepare(`INSERT INTO nbapp ${nbappCols} VALUES ('2026-01-15', 'evMILSA', ?, ?, ?, ?, 60, 28)`).run(p, m, id, pt);
}
NOW = RealDate.parse('2026-01-16T20:00:00Z');            // past the hourly scan throttle, same Pacific day
scoreboardOpen = true;
await tick();
const row = (p) => sq.prepare('SELECT * FROM nba_box WHERE player = ?').get(p) || {};
const line = (r) => ['min', 'pts', 'fgm', 'fga', 'threes', 'fg3a', 'ftm', 'fta', 'reb', 'oreb', 'dreb', 'ast', 'stl', 'blk', 'tov', 'pf'].map((k) => r[k]).join(' ');
// From the box score: MIN PTS FG 3PT FT REB AST TO STL BLK OREB DREB PF
//   Wembanyama 22 22 7-12 5-6 3-3 10 1 1 0 2 1 9 2
const wemby = row('Victor Wembanyama');
ok(line(wemby) === '22 22 7 12 5 6 3 3 10 1 9 1 0 2 1 2',
  `Wembanyama: 22 min, 22 pts, 7-12 FG, 5-6 3PT, 3-3 FT, 10 reb (1 off, 9 def), 1 ast, 0 stl, 2 blk, 1 TO, 2 PF (${line(wemby)})`);
//   Castle 26 19 6-9 1-2 6-6 1 10 0 0 0 1 0 2
const castle = row('Stephon Castle');
ok(line(castle) === '26 19 6 9 1 2 6 6 1 1 0 10 0 0 0 2', `Castle: 19 pts on 6-9, 6-6 FT, 10 ast, no turnovers (${line(castle)})`);
//   Kuzma 21 18 6-17 5-13 1-1 3 2 0 1 0 1 2 0
const kuz = row('Kyle Kuzma');
ok(kuz.fga === 17 && kuz.fg3a === 13 && kuz.threes === 5 && kuz.fgm === 6, `Kuzma: 17 shots, 13 of them threes, 5 made (${kuz.fga}, ${kuz.fg3a}, ${kuz.threes})`);
//   Keldon Johnson 21 7 1-3 1-3 4-4 8 2 2 3 0 1 7 3
const kj = row('Keldon Johnson');
ok(kj.stl === 3 && kj.pf === 3 && kj.tov === 2 && kj.fta === 4, `Keldon Johnson: 3 steals, 3 fouls, 2 turnovers, 4 free throws (${kj.stl}, ${kj.pf}, ${kj.tov}, ${kj.fta})`);
const played = sq.prepare("SELECT * FROM nba_box WHERE game_id = '401810437' AND dnp = 0").all();
ok(played.length === 28 && played.every((r) => r.oreb + r.dreb === r.reb && r.fgm <= r.fga && r.threes <= r.fg3a && r.ftm <= r.fta
  && r.pts === 2 * (r.fgm - r.threes) + 3 * r.threes + r.ftm),
  `for all ${played.length} who played: offensive + defensive = rebounds, made <= attempted, and points = 2s + 3s + free throws`);
const biy = row('Bismack Biyombo');
ok(biy.dnp === 1 && ['min', ...want, 'threes', 'ast', 'reb'].every((k) => biy[k] === null), 'Biyombo did not play: a did-not-play, with every stat null');

// A column ESPN did not send is no stat. The cron's own parser, lifted, on the
// recorded game with the BLK column taken out of every line.
const a = src.indexOf('function nbaBoxRows('), b = src.indexOf('\n}\n', a);
const nbaBoxRows = new Function(`${src.slice(a, b + 2)}\nreturn nbaBoxRows;`)();
const cut = JSON.parse(BOX_TEXT);
for (const t of cut.gamepackageJSON.boxscore.players) {
  const st = t.statistics[0];
  const i = st.labels.indexOf('BLK');
  st.labels.splice(i, 1); st.names.splice(i, 1); st.keys.splice(i, 1);
  for (const x of st.athletes) if (x.stats.length) x.stats.splice(i, 1);
}
const cutRows = nbaBoxRows(cut, '401810437', '2026-01-15', 2);
const cw = cutRows.find((r) => r.player === 'Victor Wembanyama') || {};
ok(cutRows.length === 29 && cw.blk === null && cw.pts === 22 && cw.oreb === 1,
  `without a BLK column, blocks are null rather than 0, and the rest still line up (${cw.blk}, ${cw.pts}, ${cw.oreb})`);

// ---- the log grades them ----------------------------------------------------------------
console.log('\n-- the log grades any market --');
const g = (p, m) => sq.prepare('SELECT result, actual FROM nbapp WHERE player = ? AND market = ?').get(p, m) || {};
const gs = (p, m) => `${g(p, m).result} ${g(p, m).actual}`;
ok(gs('Victor Wembanyama', 'pts') === 'over 22', `Wembanyama 22 points against 21.5: over (${gs('Victor Wembanyama', 'pts')})`);
ok(gs('Stephon Castle', 'pra') === 'under 30', `Castle 19+1+10 = 30 against 30.5 pts+rebs+asts: under (${gs('Stephon Castle', 'pra')})`);
ok(gs('Kyle Kuzma', 'fg3a') === 'over 13', `Kuzma 13 threes attempted against 12.5: over (${gs('Kyle Kuzma', 'fg3a')})`);
ok(gs('Julian Champagnie', 'reb_ast') === 'over 12', `Champagnie 11+1 = 12 against 11.5 rebs+asts: over (${gs('Julian Champagnie', 'reb_ast')})`);
ok(gs('Keldon Johnson', 'blk_stl') === 'push 3', `Keldon Johnson 0 blocks + 3 steals against 3: a push (${gs('Keldon Johnson', 'blk_stl')})`);
ok(gs('Early Read', 'pts') === 'void null', `a row read before points were kept has no points: void, not a free under (${gs('Early Read', 'pts')})`);
ok(gs('Early Read', 'threes') === 'under 2' && gs('Victor Wembanyama', 'reb') === 'under 10',
  `threes and rebounds grade as before, on old rows and new (${gs('Early Read', 'threes')}; ${gs('Victor Wembanyama', 'reb')})`);
ok(gs('Bismack Biyombo', 'blk') === 'void null', `a did-not-play is void on a new market too (${gs('Bismack Biyombo', 'blk')})`);

// ---- your entries grade them --------------------------------------------------------------
console.log('\n-- an entry on any market --');
const KEY = 'phone-key-0123456789abcdef';
const entries = async (method, body) => (await mod.default.fetch(new Request('https://x/api/entries', { method,
  headers: { 'content-type': 'application/json', 'x-entry-key': KEY }, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil: () => {} })).json();
const leg = (player, market, line, side = 'Under') => ({ sport: 'nba', date: '2026-01-15', gamePk: 'evMILSA', player, team: 'SA', market, line, side });
const e1 = await entries('POST', { action: 'create', entry: { book: 'pp', kind: 'flex', stake: 10, legs: [
  leg('Victor Wembanyama', 'pts', 22.5), leg('Stephon Castle', 'pts_ast', 29), leg('Victor Wembanyama', 'blk_stl', 1.5),
  leg('Kyle Kuzma', 'fga', 17.5), leg("De'Aaron Fox", 'tov', 3.5), leg('Julian Champagnie', 'dreb', 10.5)] } });
const e2 = await entries('POST', { action: 'create', entry: { book: 'pp', kind: 'flex', stake: 10, legs: [
  leg('Victor Wembanyama', 'oreb', 1.5), leg("De'Aaron Fox", 'ftm', 3.5), leg('Victor Wembanyama', 'fgm', 7.5),
  leg('Stephon Castle', 'pts_reb', 20.5), leg('Early Read', 'pts', 10.5), leg('Early Read', 'ast', 5.5, 'Over')] } });
await entries('GET');
const res = (id) => sq.prepare('SELECT market, result, actual FROM entry_legs WHERE entry_id = ? ORDER BY idx').all(id).map((x) => `${x.market}:${x.result}:${x.actual}`).join(' ');
ok(res(e1.id) === 'pts:win:22 pts_ast:push:29 blk_stl:loss:2 fga:win:17 tov:loss:4 dreb:loss:11',
  `points, pts+asts (a push on 29), blks+stls, shots, turnovers, defensive rebounds (${res(e1.id)})`);
ok(res(e2.id) === 'oreb:win:1 ftm:win:3 fgm:win:7 pts_reb:win:20 pts:void:null ast:win:6',
  `offensive rebounds, free throws made, FG made, pts+rebs; points on a row without them void; an over on assists from it wins (${res(e2.id)})`);

ok(asked.every((u) => !/the-odds-api/.test(u)), 'and not one Odds API request');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
