// Guards the database read paths that exhausted D1's free-tier daily row-read
// allowance on 2026-09-12 and 09-13.
//
// D1 bills rows SCANNED, not rows returned. So the question for every query is
// its plan: a full SCAN costs the whole table each time, an index SEARCH costs
// only the rows it lands on. Run against a real SQLite database (node:sqlite) at
// production-like size, with the plan of every executed statement recorded,
// because the failure is invisible in output — a query that scans ten thousand
// rows returns exactly the same answer as one that reads twelve.
//
// No ANALYZE is run: D1 does not collect statistics, so the planner here has to
// choose the indexes on their own merits, as it will in production.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const sq = new DatabaseSync(':memory:');
let recording = false;
const seen = [];
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
function exec(sql, args, mode) {
  args = args.map(norm);
  if (recording && /^\s*(SELECT|WITH|UPDATE)/i.test(sql)) {
    let plan = [];
    try { plan = sq.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map((r) => r.detail); } catch (e) { plan = ['?']; }
    seen.push({ sql: sql.replace(/\s+/g, ' ').trim(), plan });
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

globalThis.fetch = async (u) => {
  const url = String(u);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('/boxscore')) return J({ teams: { away: { players: {} }, home: { players: {} } } });
  if (url.includes('/schedule')) return J({ dates: [{ games: [] }] });
  return J({});
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const env = { DB, ODDS_API_KEY: 'k' };
const ctx = { waitUntil: (p) => { if (p && p.then) p.catch(() => {}); } };
const hit = async (p) => (await mod.default.fetch(new Request('https://x' + p), env, ctx)).json();

// Create every table through the worker's own ensure* functions.
await hit('/api/track-record');
await hit('/api/nfl-board');

// ---- fill to production-like size -----------------------------------------------
// A long graded history with a small open backlog, which is the real shape: the
// grading lookups exist to find the few open rows among many settled ones.
const iso = (ms) => new Date(ms).toISOString();
const day = (i) => `2026-0${7 + (i % 2)}-${String(1 + (i % 28)).padStart(2, '0')}`;
// Inserts only the columns each row names, so schema defaults apply to the rest.
// Plain INSERT, not OR IGNORE: the first version wrote an explicit NULL into
// every unnamed column, which beat the NOT NULL DEFAULT on picks.sport, and OR
// IGNORE swallowed every one of those failures. bpicks came out EMPTY, and the
// test still passed — because with no open rows the per-game lookups it exists
// to check never ran. A fixture that can fail silently cannot be trusted to
// prove anything, so a short fill now fails the run outright.
function fill(table, n, row) {
  const first = row(0);
  const cols = Object.keys(first);
  const ins = sq.prepare(`INSERT INTO ${table} (${cols.map((c) => '"' + c + '"').join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  sq.exec('BEGIN');
  for (let i = 0; i < n; i++) { const r = row(i); ins.run(...cols.map((c) => norm(r[c]))); }
  sq.exec('COMMIT');
  const got = sq.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
  if (got < n) { console.log(`FIXTURE FAILED: ${table} has ${got} rows, expected ${n}`); process.exit(1); }
}
const OPEN = (i) => i % 800 === 0;                                  // ~0.1% still ungraded
fill('picks', 2000, (i) => ({ date: day(i), game_id: 'g' + i, pitcher_id: i, result: OPEN(i) ? null : 'win' }));
fill('bpicks', 10000, (i) => ({ date: day(i), game_id: 'g' + (i % 900), player_id: i, market: 'tb',
  result: OPEN(i) ? null : 'win', actual: OPEN(i) ? null : (i % 5 === 0 ? 0 : 2),
  grade_ver: i % 2500 === 0 ? null : 'dnp-void-1' }));             // a few left for the backfill sweep
fill('mlpicks', 450, (i) => ({ date: day(i), game_id: 'g' + i, result: OPEN(i) ? null : 'win' }));
fill('rlpicks', 40, (i) => ({ date: day(i), game_id: 'g' + i, result: OPEN(i) ? null : 'win' }));
fill('proj_log', 700, (i) => ({ date: day(i), game_id: 'g' + i, pitcher_id: i, market: 'H', actual: OPEN(i) ? null : 5 }));
const NOW = Date.now();
fill('nfl_lines', 12850, (i) => ({ event_id: 'ev' + (i % 40), market: 'player_rush_yds', player: 'p' + (i % 300),
  point: 50.5, book: 'draftkings', captured_at: String(i), season_type: 'REG', season: 2026,
  commence: iso(NOW + (i % 40 < 36 ? -1 : 1) * (1 + (i % 7)) * 86400e3) }));   // mostly played games
// Tolerant of the table not existing, so this file still runs its assertions
// against code that predates the Track Record cache instead of crashing here.
try { sq.exec("DELETE FROM feed_cache WHERE key LIKE 'track-record%'"); } catch (e) { /* no cache table yet */ }

const count = (t) => sq.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
const BIG = ['picks', 'bpicks', 'mlpicks', 'rlpicks', 'proj_log', 'nfl_lines'];
// A plan step reads the whole table when it SCANs it without an index. A SCAN
// USING a *partial* index reads only that index's rows, which is the point.
const fullScans = (e) => e.plan.filter((d) => /^SCAN (\w+)/.test(d) && !/USING (COVERING )?INDEX/.test(d))
  .map((d) => d.split(' ')[1]).filter((t) => BIG.includes(t));

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const run = async (p) => { seen.length = 0; recording = true; const out = await hit(p); recording = false; return { out, stmts: [...seen] }; };

// ---- 1. NFL board ------------------------------------------------------------------
console.log('-- the NFL board reads upcoming games through the kickoff index --');
const nfl = await run('/api/nfl-board');
const nflQ = nfl.stmts.filter((e) => /FROM nfl_lines WHERE season_type/i.test(e.sql));
ok(nflQ.length === 2, `both season-type/kickoff queries ran (${nflQ.length})`);
ok(nflQ.every((e) => e.plan.some((d) => /nfl_lines_type_commence/.test(d))),
  'each uses nfl_lines_type_commence: ' + nflQ.map((e) => e.plan.join(' | ')).join(' ;; '));
ok(nfl.stmts.every((e) => fullScans(e).length === 0),
  `and nothing on the NFL board scans nfl_lines in full (${count('nfl_lines')} rows)`);

// ---- 2. grading lookups -------------------------------------------------------------
console.log('\n-- a Track Record rebuild finds open rows without reading history --');
const build = await run('/api/track-record');
const lookups = build.stmts.filter((e) => /result IS NULL|actual IS NULL|actual = 0 AND result IN/.test(e.sql));
ok(lookups.length >= 5, `the grading and backfill lookups ran (${lookups.length})`);
// The per-game lookups only run when a discovery query finds open games, so
// their presence proves the fixture actually has a backlog to grade.
const perGame = build.stmts.filter((e) => /WHERE (date=\? AND )?game_id=\?/.test(e.sql) && /result IS NULL|actual = 0/.test(e.sql));
ok(perGame.length >= 3, `the per-game lookups ran too, so there was real open work (${perGame.length})`);
for (const e of lookups) {
  const scans = fullScans(e);
  ok(scans.length === 0, `${e.sql.slice(0, 88)}…  →  ${e.plan.join(' | ')}`);
}
// The main grading passes' per-game lookups (`game_id=? AND result IS NULL`)
// only execute for games whose boxscore is final, which this fixture does not
// provide — so their plans are asked for directly, using the SQL text taken
// from worker.js itself so the check cannot drift from the code it guards.
// game_id is not the leading column of any key; before the partial indexes these
// were full-table scans, once per game.
const perGameSql = [...new Set(src.match(/SELECT \* FROM (?:picks|bpicks) WHERE game_id=\? AND result IS NULL/g) || [])];
ok(perGameSql.length === 2, `found both per-game grading lookups in worker.js (${perGameSql.length})`);
for (const q of perGameSql) {
  const plan = sq.prepare('EXPLAIN QUERY PLAN ' + q).all('g1').map((r) => r.detail);
  ok(fullScans({ plan }).length === 0 && plan.some((d) => /_ungraded/.test(d)),
    `${q}  →  ${plan.join(' | ')}`);
}
const partialUsed = new Set(build.stmts.flatMap((e) => e.plan.join(' ').match(/\w+_ungraded|bpicks_backfill_\w+/g) || []));
for (const want of ['picks_ungraded', 'bpicks_ungraded', 'mlpicks_ungraded', 'rlpicks_ungraded', 'proj_log_ungraded']) {
  ok(partialUsed.has(want), `${want} is chosen by the planner`);
}
ok([...partialUsed].some((n) => n.startsWith('bpicks_backfill_')),
  'the backfill sweep uses its own partial index, so a finished sweep costs nothing to re-check');
let indexRows = Infinity;
try { indexRows = sq.prepare("SELECT COUNT(*) n FROM bpicks INDEXED BY bpicks_ungraded WHERE result IS NULL").get().n; } catch (e) { /* index absent */ }
ok(indexRows < 50, `bpicks_ungraded holds ${indexRows} rows against ${count('bpicks')} in the table`);

// The rebuild still reads each pick table once to compute the record — that is
// the record itself, and why it must not run on every request.
const selectAll = build.stmts.filter((e) => /^SELECT \* FROM (picks|bpicks|mlpicks|rlpicks)$/i.test(e.sql));
ok(selectAll.length === 4, `a rebuild reads the four pick tables in full, once each (${selectAll.length})`);

// ---- 3. the global cache -------------------------------------------------------------
console.log('\n-- within ten minutes, no request rebuilds it --');
const again = await run('/api/track-record');
ok(again.stmts.length <= 2, `a second request runs ${again.stmts.length} statement(s): the cache read`);
ok(!again.stmts.some((e) => /FROM bpicks/i.test(e.sql)), 'and never touches bpicks');
ok(typeof again.out.cachedAgeSec === 'number', `it is served from the stored copy (age ${again.out.cachedAgeSec}s)`);
ok(again.out.logged === build.out.logged, 'with the same contents the rebuild produced');

console.log('\n-- once stale, only the request holding the lease rebuilds --');
try { sq.prepare("UPDATE feed_cache SET updated_at=?, claimed_until=? WHERE key LIKE 'track-record%'").run(NOW - 11 * 60e3, NOW + 60e3); } catch (e) { /* no cache table */ }
const held = await run('/api/track-record');
ok(!held.stmts.some((e) => /^SELECT \* FROM bpicks$/i.test(e.sql)),
  'another request holds the refresh, so this one serves the stale copy instead of rebuilding too');
ok(held.out.cachedAgeSec >= 600, `and says how old it is (${held.out.cachedAgeSec}s)`);
try { sq.prepare("UPDATE feed_cache SET claimed_until=0 WHERE key LIKE 'track-record%'").run(); } catch (e) { /* no cache table */ }
const winner = await run('/api/track-record');
ok(winner.stmts.some((e) => /^SELECT \* FROM bpicks$/i.test(e.sql)), 'with the lease free, one request rebuilds');
ok(winner.out.cachedAgeSec === 0, 'and serves what it just built');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
