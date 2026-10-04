// NFL and soccer legs in your entries, graded on their own.
//
// The slip began taking them on 2026-10-04 (NFL moneylines and yardage, soccer
// home/draw/away). The entry log stored them but graded only MLB, so every one
// waited for a tap. They are graded from rows this site has ALREADY graded --
// the game-line log's final scores (gmpicks) and the NFL projections' box-score
// actuals (nfl_proj) -- so no new fetch, and no second set of matching rules.
//
// Real SQLite underneath, like tests/entries.mjs: this is SQL, and a regex stub
// would only prove the stub agrees with itself.
//
// What has to hold:
//   - a moneyline grades from the final score, either side; an NFL tie pushes
//   - soccer's draw is a side, and a fixture the log voided voids the leg
//   - a yardage leg grades its line from the actual; a player graded with no
//     stat line (did not play) is void, never a free under
//   - a leg whose game the site never graded stays open for its tap
//   - entries settle and pay on these legs like any other
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

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
// No network at all: the point is that these grade from stored rows.
let fetches = 0;
globalThis.fetch = async () => { fetches++; return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); };

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const env = { DB };
const ctx = { waitUntil: (p) => { if (p && p.then) p.catch(() => {}); } };
const KEY = 'phone-key-0123456789abcdef';
const call = async (method, body) => {
  const r = await mod.default.fetch(new Request('https://x/api/entries', { method,
    headers: { 'content-type': 'application/json', 'x-entry-key': KEY }, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  return r.json();
};
const create = async (entry) => (await call('POST', { action: 'create', entry })).id;

// Schemas through the worker's own ensure functions.
await mod.default.fetch(new Request('https://x/api/gmpicks-export'), env, ctx);
await mod.default.fetch(new Request('https://x/api/nfl-grade'), env, ctx);
await call('GET');

// ---- what the site had already graded ---------------------------------------------------------
const KO = '2026-10-05T00:20:00Z';            // Lions at Panthers, 5:20 PM Pacific, Sunday Oct 4
const gm = sq.prepare(`INSERT INTO gmpicks (sport,date,game_id,market,league,week,commence,side,pick,home,away,win_prob,entry_price,close_price,result,home_score,away_score,model_ver)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,60,-150,-150,?,?,?,'gm-v1')`);
gm.run('nfl', '2026-10-04', 'evDC', 'h2h', 'REG', 4, KO, 'away', 'DET', 'CAR', 'DET', 'win', 20, 27);       // DET won 27-20 away
gm.run('nfl', '2026-10-04', 'evTIE', 'h2h', 'REG', 4, '2026-10-04T17:00:00Z', 'home', 'BUF', 'BUF', 'NE', 'push', 17, 17);
gm.run('soccer', '2026-10-03', 'sx1', 'fav', 'uefanl', null, '2026-10-03T18:45:00Z', 'away', 'England', 'Croatia', 'England', 'loss', 1, 1);
gm.run('soccer', '2026-10-03', 'sx1', 'h2h', 'uefanl', null, '2026-10-03T18:45:00Z', 'draw', 'Draw', 'Croatia', 'England', 'win', 1, 1);
gm.run('soccer', '2026-09-26', 'sx2', 'fav', 'mls', null, '2026-09-26T23:30:00Z', 'away', 'St. Louis City SC', 'New York Red Bulls', 'St. Louis City SC', 'void', null, null);
const proj = sq.prepare(`INSERT INTO nfl_proj (season, week, event_id, player, market, team, pos, game, commence, proj, actual, captured_at, graded_at)
  VALUES (2026, 4, 'evDC', ?, ?, ?, 'X', 'DET @ CAR', ?, 60, ?, '1', '2026-10-05T05:30:00Z')`);
proj.run('Jahmyr Gibbs', 'rushing', 'DET', KO, 112);
proj.run('Amon-Ra St. Brown', 'receiving', 'DET', KO, 64);
proj.run('Sam LaPorta', 'receiving', 'DET', KO, null);      // graded, no stat line: did not play
proj.run('Tetairoa McMillan', 'receiving', 'CAR', KO, 71);

const nfl = (o) => ({ sport: 'nfl', date: '2026-10-04', gamePk: 'DET @ CAR|2026-10-04', ...o });
const A = await create({ book: 'dk', kind: 'parlay', stake: 10, legs: [
  nfl({ player: 'DET', team: 'DET', market: 'ml', side: 'away', price: -180 }),                 // DET won -> win
  nfl({ player: 'Jahmyr Gibbs', team: 'DET', market: 'rush_yds', line: 88.5, side: 'Under', price: -112 }),  // 112 -> loss
] });
const B = await create({ book: 'pp', kind: 'power', stake: 10, legs: [
  nfl({ player: 'Amon-Ra St. Brown', team: 'DET', market: 'rec_yds', line: 70.5, side: 'Under' }),  // 64 -> win
  { sport: 'soccer', date: '2026-10-03', gamePk: 'sx1', player: 'Draw', market: 'ml', side: 'draw' },  // 1-1 -> win
] });
const C = await create({ book: 'dk', kind: 'straight', stake: 10, legs: [
  nfl({ player: 'Sam LaPorta', team: 'DET', market: 'rec_yds', line: 40.5, side: 'Under', price: -115 }) ] });   // DNP -> void
const D = await create({ book: 'dk', kind: 'parlay', stake: 10, legs: [
  { sport: 'soccer', date: '2026-09-26', gamePk: 'sx2', player: 'St. Louis City SC', team: 'STL', market: 'ml', side: 'away', price: -105 },  // voided fixture
  nfl({ player: 'Tetairoa McMillan', team: 'CAR', market: 'rec_yds', line: 64.5, side: 'Over', price: -110 }),   // 71 -> win
] });
const E = await create({ book: 'dk', kind: 'parlay', stake: 10, legs: [
  { sport: 'nfl', date: '2026-10-04', gamePk: 'NE @ BUF|2026-10-04', player: 'BUF', team: 'BUF', market: 'ml', side: 'home', price: -290 },  // tie -> push
  { sport: 'nfl', date: '2026-10-05', gamePk: 'ATL @ NO|2026-10-05', player: 'ATL', team: 'ATL', market: 'ml', side: 'away', price: -150 },  // not graded yet
] });

fetches = 0;
await call('GET');      // the read grades what it can, as the cron does
const legsOf = (id) => sq.prepare('SELECT idx, market, result, actual, graded_by FROM entry_legs WHERE entry_id=? ORDER BY idx').all(id);
const entry = (id) => sq.prepare('SELECT status, payout FROM entries WHERE id=?').get(id);

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

console.log('-- NFL --');
const a = legsOf(A);
ok(a[0].result === 'win' && a[0].graded_by === 'auto', `Detroit to win at Carolina, won 27-20: the moneyline wins (${a[0].result})`);
ok(a[1].result === 'loss' && a[1].actual === 112, `Gibbs ran for 112 against an under 88.5: a loss, with the yards kept (${a[1].result}, ${a[1].actual})`);
ok(entry(A).status === 'settled' && entry(A).payout === 0, `and the parlay settles at nothing (${entry(A).status}, ${entry(A).payout})`);
const c = legsOf(C)[0];
ok(c.result === 'void' && c.actual == null, `LaPorta was graded with no stat line: void, never a free under (${c.result})`);
ok(entry(C).status === 'settled' && entry(C).payout === 10, `so the straight bet refunds (${entry(C).payout})`);
const e = legsOf(E);
ok(e[0].result === 'push', `an NFL tie pushes the moneyline (${e[0].result})`);
ok(e[1].result == null && entry(E).status === 'open', 'a game the site has not graded leaves its leg, and the entry, open for later');

console.log('\n-- soccer --');
const b = legsOf(B);
ok(b[0].result === 'win' && b[0].actual === 64, `St. Brown 64 against an under 70.5 wins (${b[0].result})`);
ok(b[1].result === 'win', `the draw is a side, and a 1-1 wins it (${b[1].result})`);
ok(entry(B).status === 'settled' && entry(B).payout === 30, `a 2-pick power across two sports pays 3x (${entry(B).payout})`);
const d = legsOf(D);
ok(d[0].result === 'void', `a fixture the log voided (listed, then moved) voids the leg (${d[0].result})`);
ok(d[1].result === 'win' && entry(D).status === 'settled' && entry(D).payout === Math.round(10 * (1 + 100 / 110) * 100) / 100,
  `and the parlay pays on what is left (${d[1].result}, ${entry(D).payout})`);

console.log('\n-- from stored rows only --');
ok(fetches === 0, `graded without a single fetch (${fetches})`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
