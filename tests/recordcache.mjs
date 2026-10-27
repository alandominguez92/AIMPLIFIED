// The records kept until their rows change (2026-10-27).
//
// D1's free tier allows five million rows read a day, and with one page open
// all day the records it polls came to about that: the track record reread
// every row ever logged every ten minutes (20,700 rows on Oct 27, 15,000 of
// them bpicks), Picks of the day its kinds' logs on every read of the list
// (6,500), the soccer and NBA cards their records, and Live Now the night's
// open NBA legs every 45 seconds whether or not a game was on. Measured with
// D1's own rows_read on a production-sized copy (wrangler's local D1). Each of
// those records is now kept in feed_cache and rebuilt only once a write, seen
// by a trigger on the tables it reads, can have moved it. What has to hold:
//   - nothing written, nothing reread: the second read of each record runs
//     none of its full-table SELECTs
//   - a write it depends on rebuilds it on the next read: any row of the six
//     MLB tables for the track record's MLB half; a graded row (before or
//     after the write) for the records over graded rows; an NBA moneyline for
//     the NBA card's byGame split -- and a write it does not depend on (an
//     ungraded leg's line moving) does not
//   - and it is the same answer: every response, kept or rebuilt, is
//     byte-for-byte what a worker that builds every record afresh -- the old
//     code's path, which recordCached takes whenever it has no flag -- returns
//     over the same rows
//   - a build that could not read everything is not kept; an older build's
//     copy (two racing) is not served; a new deploy, or six hours, rebuilds
//   - Live Now reads no NBA or NHL leg while no game of that league is under
//     way, and with games under way shows what it showed
//
// D1 rows are the worker's own schema, made by its own ensure* functions; the
// upstream payloads are recorded ones (ESPN's NBA scoreboard of Oct 23,
// tests/fixtures/espn-nba-live-20261023.json, and the legs /api/nba-pp served
// that morning, as tests/livesports.mjs uses them). Everything else upstream
// answers 404, as when a feed is down.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = path.join(BOARD, 'tests', 'fixtures');
const read = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const NBA = read('espn-nba-live-20261023.json');
const LEGS = read('nba-pp-board-20261023.json').legs;
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const RealDate = Date;
let NOW = RealDate.parse(NBA.at);                              // 6:27 PM Pacific, Oct 23
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const ptDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new RealDate(ms));
const TODAY = ptDay(NOW);

// The scoreboard: as recorded, or with its games under way taken out (the
// same payload before tip and after the finals, as far as Live Now can tell).
let board = 'live';
const quiet = JSON.parse(JSON.stringify(NBA.scoreboard));
const stripLive = (o) => { if (!o || typeof o !== 'object') return; if (Array.isArray(o.events)) o.events = o.events.filter((e) => e.status.type.state !== 'in'); Object.values(o).forEach(stripLive); };
stripLive(quiet);
globalThis.fetch = async (u) => {
  const url = String(u);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url === 'https://cdn.espn.com/core/nba/scoreboard?xhr=1&date=20261023') return J(board === 'live' ? NBA.scoreboard : quiet);
  const nb = url.match(/^https:\/\/cdn\.espn\.com\/core\/nba\/boxscore\?xhr=1&gameId=(\d+)$/);
  if (nb && NBA.boxes[nb[1]]) return J(NBA.boxes[nb[1]]);
  return new Response('{}', { status: 404 });
};

// Two workers, each on its own SQLite: `kept` answers batch() as D1 does, with
// each SELECT's rows, so recordCached keeps records; `fresh` answers it as the
// other tests' fakes do, so it has no flag and builds every record every time.
// Every row written below goes to both.
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
function makeDb(sq, likeD1) {
  const log = [];
  let failOnce = null;
  const exec = (sql, args, mode) => {
    const flat = sql.replace(/\s+/g, ' ').trim();
    log.push(flat);
    if (failOnce && failOnce.test(flat)) { failOnce = null; throw new Error('D1_ERROR: refused (test)'); }
    const st = sq.prepare(sql);
    const a = args.map(norm);
    if (mode === 'all') return { results: st.all(...a), meta: {} };
    if (mode === 'first') return st.get(...a) || null;
    return { success: true, meta: { changes: Number(st.run(...a).changes) } };
  };
  return {
    log, failNext: (re) => { failOnce = re; },
    prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
      all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
      run: async () => exec(s.sql, s.args, 'run') }; return s; },
    batch: async (sts) => sts.map((x) => exec(x.sql, x.args, likeD1 && /^\s*SELECT/i.test(x.sql) ? 'all' : 'run')),
  };
}
const sqK = new DatabaseSync(':memory:'), sqF = new DatabaseSync(':memory:');
const DBK = makeDb(sqK, true), DBF = makeDb(sqF, false);
const ASSETS = { fetch: async (req) => {
  try { return new Response(fs.readFileSync(path.join(BOARD, decodeURIComponent(new URL(req.url).pathname)))); } catch (e) { return new Response('', { status: 404 }); }
} };
const envK = { DB: DBK, ASSETS }, envF = { DB: DBF, ASSETS };
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
// One module each, so neither shares the other's per-isolate state.
const modK = await import('data:text/javascript;base64,' + Buffer.from(src + '\n// kept').toString('base64'));
const modF = await import('data:text/javascript;base64,' + Buffer.from(src + '\n// fresh').toString('base64'));
const call = async (mod, env, p) => { const held = []; const r = await mod.default.fetch(new Request('https://x' + p), env, { waitUntil: (x) => held.push(x) }); await Promise.allSettled(held); return r.text(); };
// The track record is also kept whole for ten minutes (trackRecordCached);
// each read here is the one after that has run out.
const get = async (p) => {
  if (p === '/api/track-record') for (const sq of [sqK, sqF]) sq.exec("CREATE TABLE IF NOT EXISTS feed_cache (key TEXT PRIMARY KEY, data TEXT, updated_at INTEGER, claimed_until INTEGER); DELETE FROM feed_cache WHERE key LIKE 'track-record%'");
  DBK.log.length = 0;
  const k = await call(modK, envK, p), f = await call(modF, envF, p);
  return { k, f, same: k === f, ran: [...DBK.log] };
};
const both = (sql, ...a) => { for (const sq of [sqK, sqF]) sq.prepare(sql).run(...a.map(norm)); };

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// ---- the tables, through the worker's own ensure* functions -----------------------
for (const p of ['/api/track-record', '/api/picks', '/api/top-legs?sport=mlb', '/api/soccer-props', '/api/nba-pp', '/api/live-now']) await get(p);
const MLB = (i, per) => ptDay(RealDate.parse('2026-07-01T19:00:00Z') + Math.floor(i / per) * 864e5);
const fill = (table, rows) => {
  const cols = Object.keys(rows[0]);
  for (const sq of [sqK, sqF]) {
    const ins = sq.prepare(`INSERT INTO ${table} (${cols.map((c) => '"' + c + '"').join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    sq.exec('BEGIN'); for (const r of rows) ins.run(...cols.map((c) => norm(r[c]))); sq.exec('COMMIT');
    const n = sq.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
    if (n < rows.length) { console.log(`FIXTURE FAILED: ${table} has ${n} rows, expected ${rows.length}`); process.exit(1); }
  }
};
const range = (n) => [...Array(n).keys()];
const open = (d) => d >= TODAY;
fill('picks', range(120).map((i) => ({ date: MLB(i, 2), game_id: 'k' + i, pitcher_id: 100 + i, pitcher: 'P' + i, team: 'T', line: 5.5, side: i % 2 ? 'over' : 'under', price: -110,
  proj: 5.2, model_over: 45 + (i % 9), edge: 3, tier: ['pass', 'lean', 'play'][i % 3], actual_k: open(MLB(i, 2)) ? null : 4 + (i % 4), result: open(MLB(i, 2)) ? null : (i % 3 ? 'win' : 'loss') })));
fill('bpicks', range(900).map((i) => ({ date: MLB(i, 8), game_id: 'b' + Math.floor(i / 8), player_id: 1000 + i, player: 'B' + i, team: 'T', market: ['tb', 'hrr', 'hits'][i % 3], line: 1.5, side: 'under',
  price: -120 + (i % 20), proj: 1.2, model_over: 38 + (i % 15), edge: 2 + (i % 6), tier: ['pass', 'lean', 'play'][i % 3], actual: open(MLB(i, 8)) ? null : i % 3, result: open(MLB(i, 8)) ? null : (i % 3 ? 'win' : 'loss'),
  entry_over: 40, close_line: 1.5, close_price: -125, close_over: 41 })));
fill('mlpicks', range(110).map((i) => ({ date: MLB(i, 1), game_id: 'm' + i, team: 'Home', opp: 'Away', is_home: 1, tier: i % 4 ? 'pass' : 'lean', win_prob: 45 + (i % 30), edge: 1 + (i % 5),
  entry_price: -150, close_price: -155, result: open(MLB(i, 1)) ? null : (i % 3 ? 'win' : 'loss'), team_score: 4, opp_score: 3 })));
fill('rlpicks', range(12).map((i) => ({ date: MLB(i * 9, 1), game_id: 'r' + i, team: 'Home', opp: 'Away', is_home: 1, point: -1.5, side: 'fav', tier: 'pass', cover_pct: 45, edge: 1, entry_price: 140, close_price: 135, result: i % 2 ? 'win' : 'loss', team_score: 5, opp_score: 2 })));
fill('totpicks', range(14).map((i) => ({ date: MLB(i * 8, 1), game_id: 't' + i, side: 'Over', point: 8.5, entry_price: -110, close_price: -112, pin_fair: 50, entry_edge: 2, edge: 2, edge_check: 1, result: i % 2 ? 'win' : 'loss', total_runs: 9 })));
fill('pppicks', range(150).map((i) => ({ date: MLB(i, 1.3), game_id: 'b' + Math.floor(i / 2), player_id: 1000 + i, player: 'B' + i, team: 'T', market: ['tb', 'hrr', 'K'][i % 3], point: 1.5,
  model_under: 50 + (i % 30), close_point: 1.5, close_model_under: 50 + (i % 31), actual: 1, result: open(MLB(i, 1.3)) ? null : (i % 2 ? 'under' : 'over') })));
const gm = [];
for (const [sport, n] of [['nba', 30], ['nhl', 16], ['soccer', 30], ['nfl', 12]]) for (const i of range(n)) {
  const d = ptDay(NOW - (n - i) * 864e5);
  gm.push({ sport, date: d, game_id: `${sport}${i}`, market: sport === 'soccer' && i % 2 ? 'fav' : 'h2h', league: sport === 'soccer' ? 'epl' : 'reg', commence: d + 'T23:00:00Z',
    side: 'home', pick: 'Home', home: 'Home', away: 'Away', win_prob: 55 + (i % 30), entry_price: -150, close_price: -160, result: i % 4 ? 'win' : 'loss', home_score: 2, away_score: 1 });
}
// Tonight's NBA moneylines, still open, on the recorded games.
for (const g of [...new Set(LEGS.map((x) => x.game_id))]) {
  const x = LEGS.find((l) => l.game_id === g); const [away, home] = x.game.split(' @ ');
  gm.push({ sport: 'nba', date: TODAY, game_id: g, market: 'h2h', league: 'reg', commence: x.commence, side: 'home', pick: home, home, away, win_prob: 62, entry_price: -170, close_price: -175, result: null, home_score: null, away_score: null });
}
fill('gmpicks', gm);
fill('nflpyd', range(6).map((i) => ({ event_id: 'e' + i, player: 'QB' + i, season: 2026, week: 1 + i, season_type: 'REG', date: ptDay(NOW - (40 - i) * 864e5), pp_line: 230.5, book_line: 228.5, actual: 240, result: i % 2 ? 'over' : 'under', graded_at: 'x' })));
// nbapp: a fortnight graded, by recorded game ids; and tonight's legs as /api/nba-pp served them.
const gids = [...new Set(LEGS.map((x) => x.game_id))];
fill('nbapp', range(280).map((i) => ({ date: ptDay(NOW - (1 + Math.floor(i / 20)) * 864e5), game_id: gids[i % gids.length] + 'p' + Math.floor(i / 20), player: 'Pl' + i, market: ['threes', 'ast', 'reb', 'blk', 'stl'][i % 5],
  commence: '2026-10-10T23:30:00Z', home: 'H', away: 'A', team: 'H', point: 1.5 + (i % 3), proj: 1.2, model_under: 40 + (i % 45), min_proj: 20 + (i % 15), book_line: 1.5 + (i % 2), sharp_under: i % 3 ? 55 : null,
  close_point: i % 4 ? null : 2.5, close_result: i % 4 ? null : 'under', result: ['under', 'over', 'under', 'push'][i % 4] })));
fill('nbapp', LEGS.map((x) => { const [away, home] = x.game.split(' @ '); return { date: ptDay(RealDate.parse(x.commence)), game_id: x.game_id, player: x.player, market: x.market, league: x.league,
  commence: x.commence, home, away, team: x.team, player_id: x.player_id, point: x.point, proj: x.proj, model_under: x.model_under, n_recent: x.n_recent, min_proj: x.min_proj,
  book_line: x.book_line, book_under: x.book_under, captured_at: x.first_at }; }));
fill('socprops', range(120).map((i) => ({ date: ptDay(NOW - (2 + (i % 20)) * 864e5), game_id: 'sg' + (i % 30), player_id: 'p' + i, market: ['shots', 'sot', 'passes', 'tackles', 'fouls'][i % 5],
  line: 1.5, p_under: 40 + (i % 30), p_over: 60 - (i % 30), result: i >= 100 ? null : ['under', 'over', 'push'][i % 3] })));
fill('daypicks', range(40).map((i) => { const d = ptDay(NOW - (i % 10) * 864e5); return { date: d, leg_id: 'leg' + i, kind: ['mlb_ml', 'nba_ml', 'soccer_fav', 'nba_pp'][i % 4], src_date: d, game_id: 'g' + i,
  label: 'Leg ' + i, p: 66 + (i % 15), first_p: 65 + (i % 15), commence: d + 'T23:00:00Z', rank: 1 + (i % 6), on_list: i % 5 ? 1 : 0, seen_at: d + 'T22:00:00Z', result: i < 4 ? null : (i % 3 ? 'hit' : 'miss') }; }));

const whole = (ran, tables) => tables.filter((t) => ran.some((s) => new RegExp(`^SELECT \\* FROM ${t}$`).test(s)));
const MLB6 = ['picks', 'bpicks', 'mlpicks', 'rlpicks', 'totpicks', 'pppicks'];
const KINDS = [/FROM mlpicks WHERE result IN \('win','loss'\)$/, /FROM pppicks WHERE result IN \('under','over'\) AND market IN/, /FROM gmpicks WHERE sport IN \('nba','nhl','nfl','soccer'\) AND result IN/, /FROM nbapp WHERE result IN \('under','over'\) AND market IN/];
const kindScans = (ran) => KINDS.filter((re) => ran.some((s) => re.test(s))).length;
const SOC = /FROM socprops WHERE result IN \('under','over','push'\)$/;
const NBAREC = /FROM nbapp WHERE result IN \('under','over','push'\)$/;
const short = (s) => s.length > 90 ? s.slice(0, 90) + '…' : s;

console.log('-- the track record --');
let r = await get('/api/track-record');
ok(whole(r.ran, MLB6).length === 6 && r.same && JSON.parse(r.k).logged > 0, `the first rebuild reads all six MLB tables (${whole(r.ran, MLB6).join(', ')}), and answers as a fresh build does`);
r = await get('/api/track-record');
ok(whole(r.ran, MLB6).length === 0 && r.ran.some((s) => /^SELECT \* FROM gmpicks$/.test(s)), `the next, nothing written: none of them (${whole(r.ran, MLB6).join(', ') || 'none'}); gmpicks and nflpyd still read`);
ok(r.same, 'and the same answer, byte for byte');
both("UPDATE bpicks SET close_price = -140 WHERE rowid = (SELECT MAX(rowid) FROM bpicks)");
r = await get('/api/track-record');
ok(whole(r.ran, MLB6).length === 6 && r.same, `a batter leg's close moves: all six read again, and the same answer (${whole(r.ran, MLB6).length})`);
const before = JSON.parse(r.k).nbaMl;
both("UPDATE gmpicks SET result = 'loss' WHERE sport = 'nba' AND game_id = 'nba1'");
r = await get('/api/track-record');
ok(whole(r.ran, MLB6).length === 0 && r.same && JSON.stringify(JSON.parse(r.k).nbaMl) !== JSON.stringify(before),
  'an NBA moneyline regraded: the MLB half stays kept, and the NBA line moves with the fresh build');
// A build that could not read the moneyline log is answered as before, without
// it, and is not kept.
DBK.failNext(/^SELECT \* FROM mlpicks$/); DBF.failNext(/^SELECT \* FROM mlpicks$/);
both("UPDATE picks SET close_price = -115 WHERE rowid = 1");
r = await get('/api/track-record');
ok(r.same && JSON.parse(r.k).ml === undefined, 'a refused read of mlpicks: answered without ml, as a fresh build is');
r = await get('/api/track-record');
ok(whole(r.ran, MLB6).length === 6 && JSON.parse(r.k).ml && r.same, 'and that build was not kept: the next reads all six again, ml and all');
// Two builds racing: the one that began first finishing last leaves its copy
// behind, a generation old. It is not served.
const kept = () => sqK.prepare("SELECT key, data FROM feed_cache WHERE key LIKE 'rec:track-mlb:%'").all();
const k0 = kept()[0];
ok(!!k0, 'the MLB half is kept in feed_cache');
if (k0) {
  const stale = JSON.parse(k0.data); stale.gen -= 1; stale.data.out.logged = -1;
  sqK.prepare('UPDATE feed_cache SET data = ? WHERE key = ?').run(JSON.stringify(stale), k0.key);
}
r = await get('/api/track-record');
ok(whole(r.ran, MLB6).length === 6 && r.same && JSON.parse(r.k).logged > 0, 'an older generation\'s copy left by a slower build is rebuilt over, never served');
// A new deploy builds its own copy and drops the last deploy's.
envK.CF_VERSION_METADATA = { id: 'v-next' };
r = await get('/api/track-record');
ok(whole(r.ran, MLB6).length === 6 && r.same && kept().length === 1 && kept()[0].key === 'rec:track-mlb:v-next', `a new deploy rebuilds, and keeps one copy (${kept().map((x) => x.key).join(', ')})`);
r = await get('/api/track-record');
ok(whole(r.ran, MLB6).length === 0 && r.same, 'which the next read serves');
NOW += 6 * 3600e3 + 1;
r = await get('/api/track-record');
ok(whole(r.ran, MLB6).length === 6 && r.same, 'and nothing is served six hours on');
NOW -= 6 * 3600e3 + 1;

console.log('\n-- Picks of the day --');
r = await get('/api/picks');
ok(kindScans(r.ran) === 4 && r.same, `the first read scans the four kinds' logs (${kindScans(r.ran)}), and answers as a fresh build does`);
r = await get('/api/picks');
ok(kindScans(r.ran) === 0 && r.same, `the next, nothing graded: none (${r.ran.filter((s) => KINDS.some((re) => re.test(s))).map(short).join(' ;; ') || 'none'}), the same answer`);
const leg = LEGS.find((x) => x.market === 'threes');
both('UPDATE nbapp SET close_point = point + 1, close_at = ? WHERE game_id = ? AND player = ? AND market = ?', iso(NOW), leg.game_id, leg.player, leg.market);
r = await get('/api/picks');
ok(kindScans(r.ran) === 0 && r.same, 'tonight\'s open leg re-read at a new line: no rebuild, as no graded row moved; the same answer');
const kinds0 = JSON.parse(r.k).kinds.nba_pp.record;
both("UPDATE nbapp SET result = 'under', actual = 0 WHERE game_id = ? AND player = ? AND market = ?", leg.game_id, leg.player, leg.market);
both("UPDATE nbapp SET min_proj = 30, model_under = 75 WHERE result = 'under' AND market = 'ast' AND rowid = (SELECT MIN(rowid) FROM nbapp WHERE result = 'under' AND market = 'ast')");
r = await get('/api/picks');
ok(kindScans(r.ran) === 4 && r.same && JSON.stringify(JSON.parse(r.k).kinds.nba_pp.record) !== JSON.stringify(kinds0),
  `legs graded and regraded: rebuilt, the NBA record moved (${JSON.stringify(kinds0)} -> ${JSON.stringify(JSON.parse(r.k).kinds.nba_pp.record)}), the same answer`);

console.log('\n-- the soccer and NBA cards --');
r = await get('/api/soccer-props');
const socFirst = r.ran.some((s) => SOC.test(s)) && r.same;
r = await get('/api/soccer-props');
ok(socFirst && !r.ran.some((s) => SOC.test(s)) && r.same, 'soccer: read once, kept while nothing grades, the same answer');
both("UPDATE socprops SET result = 'under' WHERE rowid = (SELECT MIN(rowid) FROM socprops WHERE result IS NULL)");
r = await get('/api/soccer-props');
ok(r.ran.some((s) => SOC.test(s)) && r.same, 'a soccer prop graded: rebuilt, the same answer');
r = await get('/api/nba-pp');
const nbaFirst = r.same;
r = await get('/api/nba-pp');
ok(nbaFirst && !r.ran.some((s) => NBAREC.test(s)) && r.same, 'NBA: kept while nothing grades, the same answer');
both("UPDATE gmpicks SET win_prob = 80 WHERE sport = 'nba' AND date = ? AND game_id = ?", TODAY, gids[0]);
r = await get('/api/nba-pp');
ok(r.ran.some((s) => NBAREC.test(s)) && r.same, 'an open NBA moneyline moves (byGame reads them all): rebuilt, the same answer');
both("UPDATE gmpicks SET win_prob = 70 WHERE sport = 'nhl' AND game_id = 'nhl3'");
r = await get('/api/nba-pp');
ok(!r.ran.some((s) => NBAREC.test(s)) && r.same, 'an NHL moneyline moves: not rebuilt');

console.log('\n-- the MLB top legs --');
r = await get('/api/top-legs?sport=mlb');
const lineup = JSON.parse(r.k).lineupCheck;
r = await get('/api/top-legs?sport=mlb');
ok(lineup && whole(r.ran, ['pppicks']).length === 1 && r.same, `with today's legs on the card's lineups (${lineup}): read every time, as before`);
both('DELETE FROM pppicks WHERE date >= ?', TODAY);
r = await get('/api/top-legs?sport=mlb');
ok(whole(r.ran, ['pppicks']).length === 1 && r.same && !JSON.parse(r.k).lineupCheck, 'none today: read once');
r = await get('/api/top-legs?sport=mlb');
ok(whole(r.ran, ['pppicks']).length === 0 && r.same, 'then kept, the same answer');
NOW += 864e5;
r = await get('/api/top-legs?sport=mlb');
ok(whole(r.ran, ['pppicks']).length === 1 && r.same, 'and read again the next day');
NOW -= 864e5;

console.log('\n-- Live Now --');
const NBALEGS = /FROM nbapp WHERE date IN \(\?, \?\) AND result IS NULL$/;
board = 'quiet';
r = await get('/api/live-now');
ok(!r.ran.some((s) => NBALEGS.test(s)) && r.same && !JSON.parse(r.k).some((c) => c.sport === 'nba' && c.kind !== 'ml'),
  'no NBA game under way: no leg read, no NBA card, the same answer');
// The NHL's score feed answers nothing here: no game under way there either.
ok(!r.ran.some((s) => /FROM nhlpp WHERE date IN \(\?, \?\) AND result IS NULL$/.test(s)), 'and no NHL game under way: no NHL leg read');
board = 'live';
r = await get('/api/live-now');
const cards = JSON.parse(r.k).filter((c) => c.sport === 'nba' && c.kind !== 'ml');
ok(r.ran.some((s) => NBALEGS.test(s)) && cards.length > 0 && r.same, `six games under way: the legs read, ${cards.length} NBA cards, the same answer`);

function iso(ms) { return new RealDate(ms).toISOString(); }
console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
