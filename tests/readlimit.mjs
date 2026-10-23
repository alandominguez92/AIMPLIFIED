// Guards the database reads that ran D1's free-tier daily row-read allowance
// out on 2026-10-22 (23:41 UTC) as on 2026-09-13: every read failed until
// midnight UTC, so Picks of the day, the boards and the cron all failed with
// it. tests/readpaths.mjs holds the September fixes; this holds October's.
//
// D1 bills rows SCANNED, not rows returned, and nothing in a query's answer
// shows what it read. So, as in readpaths.mjs: the real worker on a real SQLite
// at production-like size, the plan of every statement it runs recorded, and no
// ANALYZE (D1 keeps no statistics). What the cron and the boards read:
//   - the NFL capture ran the /api/nfl-ingest handler, whose readback for a
//     manual caller counts the whole of nfl_lines three ways; the cron threw
//     it away, and the pre-start reads made that up to ten captures a Sunday
//   - each capture's read of current prices took every market of each event,
//     props and all, to compare against the few it had bought
//   - the passing-TD log read nfl_lines whole after every props capture
//   - the NFL board counted every upcoming quote to learn whether one existed
//   - the soccer board scanned every price ever stored, after every capture
//   - the five-minute graders (entry legs, entries, NBA box scores, soccer
//     props, the day's picks) and the hourly NHL one scanned their tables for
//     the few open rows, or read three sports of gmpicks to find one game
//   - the soccer context read every box score once per league
//
// And none of it may change an answer, so each rewritten read is also run
// against the statement it replaced on the indexes that existed before, and
// the rows must match, in order: several of these keep the last row per key,
// or the first match, and tied rows come out in whatever order the plan gave.
//
// The NFL payloads are the Odds API's documented v4 shape: the key is a Worker
// secret, so production's cannot be recorded (as tests/nhl.mjs explains).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const RealDate = Date;
let NOW = RealDate.parse('2026-10-25T08:00:00Z');            // Sunday, 1 AM Pacific
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const iso = (ms) => new RealDate(ms).toISOString();
const D = 864e5, H = 3600e3;

const sq = new DatabaseSync(':memory:');
let recording = false;
const seen = [];
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
function exec(sql, args, mode) {
  args = args.map(norm);
  if (recording && /^\s*(SELECT|WITH|UPDATE|DELETE)/i.test(sql)) {
    let plan = [];
    try { plan = sq.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map((r) => r.detail); } catch (e) { plan = ['?']; }
    seen.push({ sql: sql.replace(/\s+/g, ' ').trim(), args, plan });
  }
  const st = sq.prepare(sql);
  if (mode === 'all') return { results: st.all(...args), meta: {} };
  if (mode === 'first') return st.get(...args) || null;
  return { success: true, meta: { changes: Number(st.run(...args).changes) } };
}
const DB = {
  prepare: (sql) => { const s = { sql, args: [], bind: (...a) => { s.args = a; return s; },
    all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
    run: async () => exec(s.sql, s.args, 'run') }; return s; },
  batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')),
};

// ---- the NFL slate the cron sees ------------------------------------------------
// Six games at 1 PM Eastern, inside the 36 hours that start a capture, and ten
// more through the ten-day horizon.
const KICK = RealDate.parse('2026-10-25T17:00:00Z');
const CLUBS = [['Buffalo Bills', 'Kansas City Chiefs'], ['Detroit Lions', 'Green Bay Packers'], ['Philadelphia Eagles', 'Dallas Cowboys'],
  ['Baltimore Ravens', 'Cincinnati Bengals'], ['Houston Texans', 'Tennessee Titans'], ['Miami Dolphins', 'New York Jets'],
  ['Denver Broncos', 'Las Vegas Raiders'], ['Seattle Seahawks', 'Los Angeles Rams'], ['Minnesota Vikings', 'Chicago Bears'],
  ['Atlanta Falcons', 'Carolina Panthers'], ['Pittsburgh Steelers', 'Cleveland Browns'], ['Arizona Cardinals', 'San Francisco 49ers'],
  ['Tampa Bay Buccaneers', 'New Orleans Saints'], ['Washington Commanders', 'New York Giants'], ['Indianapolis Colts', 'Jacksonville Jaguars'],
  ['Los Angeles Chargers', 'New England Patriots']];
const UPCOMING = CLUBS.map(([home, away], i) => ({ id: 'up' + String(i).padStart(2, '0'), home, away,
  commence: iso(i < 6 ? KICK : KICK + (1 + (i % 8)) * D) }));
const NFL_BOOKS = ['pinnacle', 'lowvig', 'betonlineag', 'draftkings', 'fanduel', 'betmgm'];
const gameMarkets = (ev, shift) => [
  { key: 'h2h', outcomes: [{ name: ev.home, price: -150 + shift }, { name: ev.away, price: 130 - shift }] },
  { key: 'spreads', outcomes: [{ name: ev.home, price: -110, point: -3.5 }, { name: ev.away, price: -110, point: 3.5 }] },
  { key: 'totals', outcomes: [{ name: 'Over', price: -108, point: 44.5 }, { name: 'Under', price: -112, point: 44.5 }] },
];
const qbs = (ev) => [`${ev.home} QB`, `${ev.away} QB`];
const propMarkets = (ev, shift) => [
  { key: 'player_pass_tds', outcomes: qbs(ev).flatMap((p) => [{ name: 'Over', description: p, price: -125 + shift, point: 1.5 }, { name: 'Under', description: p, price: 100 - shift, point: 1.5 }]) },
  { key: 'player_reception_yds', outcomes: [1, 2, 3].flatMap((k) => [{ name: 'Over', description: `${ev.home} WR${k}`, price: -114 + shift, point: 50.5 + k }, { name: 'Under', description: `${ev.home} WR${k}`, price: -114, point: 50.5 + k }]) },
];
const oddsCalls = [];
let oddsDown = true;                                         // while the tables are made, below
const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json', 'x-requests-last': '1', 'x-requests-remaining': '80000' } });
globalThis.fetch = async (u) => {
  const url = String(u);
  if (!url.startsWith('https://api.the-odds-api.com/')) return new Response('{}', { status: 404 });
  if (oddsDown) return new Response('[]', { status: 500 });
  oddsCalls.push(url);
  const shift = Math.round((NOW - KICK) / H);                // prices move between captures
  if (/americanfootball_nfl\/events\?/.test(url)) return J(UPCOMING.map((e) => ({ id: e.id, sport_key: 'americanfootball_nfl', commence_time: e.commence, home_team: e.home, away_team: e.away })));
  if (/americanfootball_nfl\/odds\?/.test(url)) {
    return J(UPCOMING.map((e) => ({ id: e.id, sport_key: 'americanfootball_nfl', commence_time: e.commence, home_team: e.home, away_team: e.away,
      bookmakers: NFL_BOOKS.map((key) => ({ key, title: key, markets: gameMarkets(e, shift) })) })));
  }
  const ev = /americanfootball_nfl\/events\/([^/]+)\/odds/.exec(url);
  if (ev) {
    const e = UPCOMING.find((x) => x.id === ev[1]);
    return J({ id: e.id, sport_key: 'americanfootball_nfl', commence_time: e.commence, home_team: e.home, away_team: e.away,
      bookmakers: NFL_BOOKS.map((key) => ({ key, title: key, markets: propMarkets(e, shift) })) });
  }
  return J([]);                                              // every other league: nothing coming
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const ASSETS = { fetch: async (req) => {
  try { return new Response(fs.readFileSync(path.join(BOARD, decodeURIComponent(new URL(req.url).pathname)))); } catch (e) { return new Response('', { status: 404 }); }
} };
const env = { DB, ODDS_API_KEY: 'k', ASSETS };
const hit = async (p) => { const held = []; const r = await mod.default.fetch(new Request('https://x' + p), env, { waitUntil: (x) => held.push(x) }); await Promise.allSettled(held); return r.json(); };
const tick = async () => { const held = []; await mod.default.scheduled({ cron: '*/5 * * * *', scheduledTime: NOW }, env, { waitUntil: (x) => held.push(x) }); await Promise.allSettled(held); };

// Every table, through the worker's own ensure* functions, with the odds feed
// down so that nothing is captured before the rows below exist.
await tick();
for (const p of ['/api/nfl-board', '/api/soccer-board', '/api/soccer-props', '/api/picks', '/api/nhl-pp', '/api/nba-pp']) await hit(p);
oddsDown = false;

// ---- fill to production-like size ------------------------------------------------
// A second database with the same schema and rows, untouched by the cron, is
// where each rewritten read is compared with the one it replaced.
const ref = new DatabaseSync(':memory:');
for (const { sql } of sq.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all()) ref.exec(sql);
sq.exec('DELETE FROM feed_cache');                          // the setup's cron gates, so the real ticks run everything
// Named columns only, so schema defaults apply; a short fill fails the run
// (readpaths.mjs: a fixture that can fail silently proves nothing).
function fill(table, rows) {
  const cols = Object.keys(rows[0]);
  for (const db of [sq, ref]) {
    const ins = db.prepare(`INSERT INTO ${table} (${cols.map((c) => '"' + c + '"').join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
    db.exec('BEGIN');
    for (const r of rows) ins.run(...cols.map((c) => norm(r[c])));
    db.exec('COMMIT');
    const got = db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
    if (got < rows.length) { console.log(`FIXTURE FAILED: ${table} has ${got} rows, expected ${rows.length}`); process.exit(1); }
  }
}
const range = (n) => [...Array(n).keys()];

// nfl_lines: every quote that moved, for 110 played games and the 16 to come,
// game lines and props in one table. One capture writes every event under one
// stamp, so rows tie on captured_at across events; events are written in the
// order the feed listed them, which is not id order; and a quarterback can have
// two points at one book.
const nflLines = [];
const nflRow = (ev, market, player, point, book, cap, over, under) => ({ season: 2026, week: 1, season_type: 'REG', event_id: ev.id, commence: ev.commence,
  home: ev.home, away: ev.away, market, player, point, book, over, under, captured_at: cap });
const capture = (events, cap, shift) => {
  for (const ev of events) for (const bk of NFL_BOOKS) {
    for (const m of gameMarkets(ev, shift)) {
      if (m.key === 'totals') nflLines.push(nflRow(ev, 'totals', null, 44.5, bk, cap, -108, -112));
      else for (const o of m.outcomes) nflLines.push(nflRow(ev, m.key, o.name, o.point ?? null, bk, cap, o.price, null));
    }
    for (const [i, qb] of qbs(ev).entries()) {
      for (const pt of (i ? [2.5, 1.5] : [1.5])) nflLines.push(nflRow(ev, 'player_pass_tds', qb, pt, bk, cap, -125 + shift + pt, 100 - shift));
    }
    for (const k of [1, 2, 3, 4, 5, 6]) nflLines.push(nflRow(ev, 'player_reception_yds', `${ev.home} WR${k}`, 50.5 + k, bk, cap, -114 + shift, -114));
    for (const k of [1, 2, 3]) nflLines.push(nflRow(ev, 'player_rush_yds', `${ev.away} RB${k}`, 40.5 + k, bk, cap, -112, -112 + shift));
  }
};
const PLAYED = range(110).map((i) => ({ id: 'pl' + String(i).padStart(3, '0'), home: CLUBS[i % 16][0], away: CLUBS[i % 16][1],
  commence: iso(RealDate.parse('2026-09-10T17:00:00Z') + i * 0.4 * D) }));
for (let w = 0; w < 7; w++) {
  const wk = PLAYED.filter((e) => Math.floor((RealDate.parse(e.commence) - RealDate.parse('2026-09-10T17:00:00Z')) / (7 * D)) === w);
  for (let c = 0; c < 4; c++) capture([...wk].reverse(), iso(RealDate.parse('2026-09-04T12:00:00Z') + w * 7 * D + c * D), c);
}
for (let c = 0; c < 4; c++) capture([...UPCOMING].reverse(), iso(NOW - (4 - c) * 18 * H), c);
fill('nfl_lines', nflLines);

// nfl_proj: frozen projections, graded but for one game that went final last night.
fill('nfl_proj', range(2600).map((i) => {
  const open = i >= 2560;
  const commence = open ? iso(NOW - 20 * H) : iso(RealDate.parse('2026-09-10T17:00:00Z') + (i % 110) * 0.4 * D);
  return { season: 2026, week: 1, event_id: open ? 'pl109' : 'pl' + String(i % 110).padStart(3, '0'), player: 'Player ' + i, market: i % 2 ? 'receiving' : 'rushing',
    game: 'KC @ BUF', commence, proj: 50, actual: open ? null : 40, graded_at: open ? null : commence };
}));

// soccer_lines: eight leagues, forty fixtures each, four captures a fixture;
// a league's capture stamps every fixture it read alike. Mostly played.
const SOC_LG = ['epl', 'laliga', 'ucl', 'uel', 'seriea', 'ligamx', 'mls', 'uefanl'];
const socLines = [];
for (let f = 39; f >= 0; f--) for (const lg of SOC_LG) {
  const commence = iso(NOW + (f - 34) * 2 * D);               // the last five still to come
  for (let c = 0; c < 4; c++) {
    const cap = iso(RealDate.parse(commence) - (4 - c) * 12 * H - SOC_LG.indexOf(lg) * 60e3);
    for (const bk of ['pinnacle', 'lowvig', 'betonlineag', 'draftkings', 'fanduel']) {
      for (const [sel, price] of [['Home FC', 150 + c], ['Draw', 240], ['Away FC', 180 - c]]) socLines.push({ league: lg, event_id: `${lg}${f}`, commence, home: 'Home FC', away: 'Away FC', market: 'h2h', selection: sel, point: null, book: bk, price, captured_at: cap });
      for (const sel of ['Over', 'Under']) socLines.push({ league: lg, event_id: `${lg}${f}`, commence, home: 'Home FC', away: 'Away FC', market: 'totals', selection: sel, point: 2.5, book: bk, price: -110 + c, captured_at: cap });
    }
  }
}
fill('soccer_lines', socLines);

// gmpicks: three sports' graded moneylines -- and a fixture that moved, listed
// and voided on the 18th, played on the 20th. Its later row went in first.
const GM = range(3000).map((i) => ({ sport: ['soccer', 'nba', 'nhl'][i % 3], date: iso(RealDate.parse('2026-08-01T12:00:00Z') + (i % 80) * D).slice(0, 10),
  game_id: 'ev' + i, market: 'h2h', side: 'home', pick: 'Home', home: 'Home', away: 'Away', win_prob: 60, entry_price: -130, result: i % 4 ? 'win' : 'loss', home_score: 2, away_score: 1 }));
GM.push({ sport: 'soccer', date: '2026-10-20', game_id: 'moved1', market: 'h2h', side: 'home', pick: 'Home', home: 'Home', away: 'Away', win_prob: 66, entry_price: -180, result: 'win', home_score: 2, away_score: 0 });
GM.push({ sport: 'soccer', date: '2026-10-18', game_id: 'moved1', market: 'h2h', side: 'home', pick: 'Home', home: 'Home', away: 'Away', win_prob: 66, entry_price: -180, result: 'void', home_score: null, away_score: null });
fill('gmpicks', GM);

// Entries: three hundred settled, one open whose legs only the logs can settle.
fill('entries', range(301).map((i) => ({ id: 'e' + i, created_at: iso(NOW - (301 - i) * H), date: '2026-10-' + String(1 + (i % 24)).padStart(2, '0'),
  book: i === 300 ? 'dk' : 'pp', kind: 'power', legs_n: 2, stake: 5, status: i === 300 ? 'open' : 'settled' })));
fill('entry_legs', [
  { entry_id: 'e300', idx: 0, sport: 'soccer', date: '2026-10-20', game_id: 'moved1', player: 'Home', team: 'Home', market: 'ml', side: 'home', price: -180 },
  { entry_id: 'e300', idx: 1, sport: 'nba', date: '2026-08-02', game_id: 'ev1', player: 'Home', team: 'Home', market: 'ml', side: 'home', price: -130 },
  { entry_id: 'e300', idx: 2, sport: 'nfl', date: '2026-10-24', game_id: 'KC @ BUF|2026-10-24', player: 'Unknown Receiver', market: 'rec_yds', line: 50.5, side: 'Under' },
]);

// daypicks: a fortnight of the list, a few legs still open.
fill('daypicks', range(1500).map((i) => {
  const open = i % 25 === 7;
  const commence = iso(NOW - (2 + (i * 37) % 300) * H);
  return { date: commence.slice(0, 10), leg_id: 'leg' + i, kind: 'nba_ml', src_date: commence.slice(0, 10), game_id: 'nogame' + i, label: 'Leg ' + i,
    p: 70, commence, rank: 1, on_list: i % 3 ? 1 : 0, seen_at: commence, result: open ? null : 'hit' };
}));

// nhlpp: the log, graded, and last night's legs.
fill('nhlpp', range(2030).map((i) => ({ date: i >= 2000 ? '2026-10-24' : iso(RealDate.parse('2026-10-01T12:00:00Z') + (i % 23) * D).slice(0, 10),
  game_id: 'nh' + (i % 300), player: 'Skater ' + i, market: i % 2 ? 'pts' : 'ast', point: 0.5, model_under: 60, result: i >= 2000 ? null : 'under' })));

// nba_box_games: a season of games read, three not yet, found out of date order.
fill('nba_box_games', range(1003).map((i) => ({ game_id: 'nb' + i, date: i >= 1000 ? `2026-10-2${4 - (i - 1000)}` : iso(RealDate.parse('2025-10-21T12:00:00Z') + (i % 190) * D).slice(0, 10),
  season_type: 2, done: i >= 1000 ? 0 : 1 })));

// Soccer box scores and the props graded from them: 400 matches read, 250
// props on finished matches waiting for the grader's 200-row batches.
fill('soc_box_games', range(400).map((i) => ({ game_id: 'sg' + i, league: SOC_LG[i % 5], date: iso(RealDate.parse('2026-08-10T12:00:00Z') + (i % 70) * D).slice(0, 10), home: 'H' + (i % 20), away: 'A' + (i % 20), done: 1, tries: 0 })));
fill('soc_box', range(11000).map((i) => ({ game_id: 'sg' + (i % 400), league: SOC_LG[(i % 400) % 5], date: iso(RealDate.parse('2026-08-10T12:00:00Z') + ((i % 400) % 70) * D).slice(0, 10),
  player_id: 'p' + i, team: i % 2 ? 'H' + (i % 20) : 'A' + (i % 20), starter: 1, min: 90, shots: i % 4, passes: 30 })));
fill('socprops', range(3250).map((i) => ({ date: iso(RealDate.parse('2026-08-10T12:00:00Z') + (i % 70) * D).slice(0, 10), game_id: 'sg' + ((i * 7) % 400), player_id: 'p' + i,
  market: 'shots', line: 1.5, p_under: 55, p_over: 45, result: i >= 3000 ? null : 'under' })));

// ---- what the cron and the boards read ----------------------------------------
const tables = new Set(sq.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
const partial = new Set(sq.prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql LIKE '% WHERE %'").all().map((r) => r.name));
const tableOf = (sql, name) => (tables.has(name) ? name : ((new RegExp(`(?:FROM|JOIN)\\s+(\\w+)\\s+(?:AS\\s+)?${name}\\b`, 'i').exec(sql) || [])[1] || name));
// A plan step that SCANs a table reads all of it -- through a full index too,
// which is still one entry per row. A partial index holds only its own rows.
const fullScans = (e) => e.plan.map((d) => /^SCAN (\w+)(?: USING (?:COVERING )?INDEX (\w+))?/.exec(d))
  .filter((m) => m && !(m[2] && partial.has(m[2]))).map((m) => tableOf(e.sql, m[1])).filter((t) => tables.has(t));
const count = (t) => sq.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const record = async (fn) => { seen.length = 0; recording = true; await fn(); recording = false; return [...seen]; };
const short = (e) => e.sql.slice(0, 96) + (e.sql.length > 96 ? '…' : '');

console.log('-- a cron tick that captures the NFL slate --');
oddsCalls.length = 0;
const cron = await record(tick);
ok(oddsCalls.some((u) => /americanfootball_nfl\/odds\?/.test(u)) && oddsCalls.some((u) => /americanfootball_nfl\/events\/up00\/odds/.test(u)),
  'it bought the game lines and the props (the capture this guards ran)');
const onNfl = cron.filter((e) => /FROM nfl_lines/.test(e.sql));
ok(!onNfl.some((e) => /COUNT\(\*\)/.test(e.sql) || /GROUP BY week/.test(e.sql)),
  `no count of nfl_lines, whole or by week, rides the capture (${count('nfl_lines')} rows): ${onNfl.filter((e) => /COUNT\(\*\)|GROUP BY/.test(e.sql)).map(short).join(' ;; ') || 'none'}`);
const ptd = cron.filter((e) => /market = 'player_pass_tds'/.test(e.sql));
ok(ptd.length === 1 && ptd[0].plan.some((d) => /nfl_lines_ptd/.test(d)), 'the passing-TD read goes through nfl_lines_ptd: ' + ptd.map((e) => e.plan.join(' | ')).join(' ;; '));
const cur = cron.filter((e) => /SELECT event_id, market, player, point, book, over, under, captured_at FROM nfl_lines WHERE event_id IN/.test(e.sql));
ok(cur.length >= 2 && cur.every((e) => /AND market IN/.test(e.sql) && e.plan.some((d) => /market=\?/.test(d))),
  `both captures' current-price reads ask for their own markets only (${cur.length}): ${cur.map((e) => e.plan.join(' | ')).join(' ;; ')}`);
const reg = cron.filter((e) => /FROM nfl_lines WHERE season_type='REG'/.test(e.sql));
ok(reg.length >= 1 && reg.every((e) => /LIMIT 1$/.test(e.sql) && !/COUNT/.test(e.sql)), 'the board asks whether a regular-season quote exists, LIMIT 1, rather than counting them');
const scans = cron.filter((e) => fullScans(e).length);
ok(scans.length === 0, `nothing on the tick reads a table whole: ${scans.map((e) => `${short(e)} → ${e.plan.join(' | ')}`).join(' ;; ') || 'none'}`);
const legs = sq.prepare("SELECT idx, result FROM entry_legs WHERE entry_id = 'e300' ORDER BY idx").all();
ok(legs[0].result === 'void', `the leg on the moved fixture settles off its first row, the void, as before (${legs[0].result})`);
ok(legs[1].result === 'win', `and the NBA moneyline leg off its graded row (${legs[1].result})`);

console.log('\n-- the pre-kickoff capture, 70 minutes out --');
NOW = KICK - 70 * 60e3;
oddsCalls.length = 0;
const pre = await record(tick);
ok(oddsCalls.filter((u) => /americanfootball_nfl\/odds\?/.test(u)).length === 1 && !oddsCalls.some((u) => /events\/[^/]+\/odds/.test(u)),
  `it read the game lines again, and no props (${oddsCalls.length} odds call(s))`);
ok(!pre.some((e) => /FROM nfl_lines/.test(e.sql) && /COUNT\(\*\)|GROUP BY week/.test(e.sql)), 'and counted nothing on the way out');
const preScans = pre.filter((e) => fullScans(e).length);
ok(preScans.length === 0, `nothing on it reads a table whole: ${preScans.map((e) => `${short(e)} → ${e.plan.join(' | ')}`).join(' ;; ') || 'none'}`);

console.log('\n-- the boards --');
const soc = await record(() => hit('/api/soccer-board'));
const socQ = soc.filter((e) => /FROM soccer_lines/.test(e.sql));
ok(socQ.length === 1 && socQ[0].plan.some((d) => /SEARCH soccer_lines USING INDEX soccer_lines_lg \(league=\? AND commence>\?\)/.test(d)) && !fullScans(socQ[0]).length,
  `the soccer board searches each league by kickoff (${count('soccer_lines')} rows stored): ${socQ.map((e) => e.plan.join(' | ')).join(' ;; ')}`);
const props = await record(() => hit('/api/soccer-props'));
const ctx = props.filter((e) => /FROM soc_box WHERE league = \?/.test(e.sql));
ok(ctx.length >= 5 && ctx.every((e) => e.plan.some((d) => /soc_box_league/.test(d))), `the soccer context reads each league through soc_box_league (${ctx.length} leagues)`);
const nfl = await record(() => hit('/api/nfl-board'));
ok(!nfl.some((e) => /COUNT\(\*\) AS n FROM nfl_lines/.test(e.sql)), 'the NFL board counts nothing to choose its season type');
// Not reached above (no final box score here); asked for directly, using the
// statement's own text from worker.js.
const upd = (src.match(/UPDATE nfl_proj SET actual=\?, graded_at=\? WHERE event_id=\? AND player=\? AND market=\? AND graded_at IS NULL/) || [])[0];
const updPlan = upd ? sq.prepare('EXPLAIN QUERY PLAN ' + upd).all(1, 'x', 'e', 'p', 'm').map((r) => r.detail) : ['?'];
ok(updPlan.some((d) => /nfl_proj_open/.test(d)), `the NFL grader's per-row UPDATE reads only open projections: ${updPlan.join(' | ')}`);

// ---- the same answers ----------------------------------------------------------
// Each read the worker now runs, against the statement it replaced, on the
// untouched copy: the new one with the new indexes, the old one inside a
// transaction that drops them, so it runs on the plan it always had.
console.log('\n-- each rewritten read returns what the old one did --');
const NEW_INDEXES = ['nfl_lines_ptd', 'nfl_proj_open', 'nfl_proj_graded', 'nba_box_games_todo', 'nhlpp_ungraded', 'daypicks_open',
  'entries_open', 'gmpicks_game', 'socprops_open', 'soc_pp_lines_open', 'soc_box_league'];
const all = [...cron, ...pre, ...soc, ...props, ...nfl];
const ran = (re) => all.find((e) => re.test(e.sql));
const runOld = (sql, args) => {
  ref.exec('BEGIN');
  try { for (const i of NEW_INDEXES) ref.exec('DROP INDEX IF EXISTS ' + i); return ref.prepare(sql).all(...args); }
  finally { ref.exec('ROLLBACK'); }
};
const same = (label, re, oldSql, oldArgs, opts = {}) => {
  const e = ran(re);
  if (!e) { ok(false, `${label}: the worker ran no such read`); return; }
  let got = ref.prepare(e.sql).all(...e.args), want = runOld(oldSql, oldArgs || e.args);
  if (opts.filter) want = want.filter(opts.filter);
  if (opts.unordered) { const k = (r) => JSON.stringify(r); got = got.map(k).sort(); want = want.map(k).sort(); }
  ok(got.length > 0 && JSON.stringify(got) === JSON.stringify(want), `${label}: ${got.length} row(s), identical${opts.unordered ? ' as a set' : ', in order'}`);
};
const GAME = ['h2h', 'spreads', 'totals'], PROP = ['player_reception_yds', 'player_rush_yds', 'player_pass_tds', 'player_pass_yds'];
same('passing TDs', /market = 'player_pass_tds' AND commence > \?/,
  `SELECT event_id, commence, home, away, market, player, point, book, over, under, week, season_type
     FROM nfl_lines WHERE market = 'player_pass_tds' AND commence > ? ORDER BY captured_at ASC`);
const evIn = (e) => e.args.filter((x) => /^up/.test(String(x)));
const curOld = (ids) => `SELECT event_id, market, player, point, book, over, under, captured_at FROM nfl_lines WHERE event_id IN (${ids.map(() => '?').join(',')})`;
const gl = cron.find((e) => /FROM nfl_lines WHERE event_id IN .* AND market IN \(\?,\?,\?\)$/.test(e.sql));
same('game-line capture: current prices', /FROM nfl_lines WHERE event_id IN .* AND market IN \(\?,\?,\?\)$/, curOld(gl ? evIn(gl) : []), gl ? evIn(gl) : [], { filter: (r) => GAME.includes(r.market), unordered: true });
const pr = cron.find((e) => /FROM nfl_lines WHERE event_id IN .* AND market IN \(\?,\?,\?,\?\)$/.test(e.sql));
same('props capture: current prices', /FROM nfl_lines WHERE event_id IN .* AND market IN \(\?,\?,\?,\?\)$/, curOld(pr ? evIn(pr) : []), pr ? evIn(pr) : [], { filter: (r) => PROP.includes(r.market), unordered: true });
const exists = ran(/FROM nfl_lines WHERE season_type='REG'/);
ok(!!exists && !!ref.prepare(exists.sql).get(...exists.args) === (runOld("SELECT COUNT(*) AS n FROM nfl_lines WHERE season_type='REG' AND commence > ?", exists.args)[0].n > 0),
  'the season-type check answers as the count did');
same('soccer board', /FROM soccer_lines WHERE league IN/,
  `SELECT league, event_id, commence, home, away, market, selection, point, book, price, captured_at
     FROM soccer_lines WHERE commence > ? ORDER BY captured_at ASC`);
same('entry legs: their games in the log', /FROM gmpicks WHERE \+sport IN/,
  "SELECT sport, game_id, result, home_score, away_score FROM gmpicks WHERE sport IN ('soccer','nba','nhl') AND result IS NOT NULL AND game_id IN (?,?)");
same('entry legs: graded projections', /FROM nfl_proj WHERE graded_at IS NOT NULL/,
  'SELECT player, market, game, commence, actual, graded_at FROM nfl_proj WHERE graded_at IS NOT NULL AND commence >= ? AND commence < ?');
same('NFL grader: pending', /FROM nfl_proj WHERE graded_at IS NULL/,
  'SELECT event_id, player, market, game, commence, season, week FROM nfl_proj WHERE graded_at IS NULL AND commence IS NOT NULL AND commence < ? ORDER BY commence');
same('open entries', /FROM entries WHERE status = 'open'/, "SELECT * FROM entries WHERE status = 'open'");
same('NBA box scores still to read', /FROM nba_box_games WHERE done = 0/, 'SELECT game_id, date, season_type FROM nba_box_games WHERE done = 0 LIMIT ?');
same('listed legs to grade', /FROM daypicks WHERE on_list = 1 AND result IS NULL/, 'SELECT * FROM daypicks WHERE on_list = 1 AND result IS NULL AND commence < ?');
same('soccer props to grade (a 200-row batch)', /FROM socprops s CROSS JOIN/,
  'SELECT s.date, s.game_id, s.player_id, s.market, s.line FROM socprops s JOIN soc_box_games g ON g.game_id = s.game_id WHERE s.result IS NULL AND g.done = 1 LIMIT 200');
// The NHL grader groups its open legs by day and grades each on its own, so
// only the set matters (the old order was the key's, the new one the index's).
same('NHL legs to grade', /FROM nhlpp WHERE result IS NULL/, 'SELECT * FROM nhlpp WHERE result IS NULL AND date < ?', null, { unordered: true });
const ctxQ = ran(/FROM soc_box WHERE league = \?/);
same('soccer context', /FROM soc_box WHERE league = \?/, ctxQ ? ctxQ.sql : 'x');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
