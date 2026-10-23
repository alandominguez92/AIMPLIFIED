// Picks of the day stands through a refused database read (2026-10-22).
//
// At 23:56 Pacific on Oct 22, D1 answered one of /api/picks' reads with
// "D1_ERROR: out of memory: SQLITE_NOMEM". The records are read inside the
// same try as the list, so the whole answer became {error}, legs: [] -- and
// it was a 200, so the edge kept it for two minutes and every viewer was served
// "Picks unavailable". The next read was fine. Now:
//   - a refused record read (the kinds' records, the list's own record and
//     history) leaves the legs standing, without the records, and says so
//   - an answer carrying an error is kept at the edge for seconds, not two
//     minutes
//   - the page keeps the list it already has when a refresh comes back failed
//
// The error is D1's own text from that read, thrown by the database the
// worker is given for the queries it refused; everything else is real SQLite
// and the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const RealDate = Date;
const NOW = RealDate.parse('2026-10-23T07:00:00Z');
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
globalThis.fetch = async () => new Response('{}', { status: 404 });
const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const NOMEM = 'D1_ERROR: out of memory: SQLITE_NOMEM';
let refuse = null;                                            // a pattern of SQL the database refuses
function exec(sql, args, mode) {
  if (refuse && refuse.test(sql)) throw new Error(NOMEM);
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
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const get = async (u) => { const r = await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} }); return { cc: r.headers.get('cache-control'), body: await r.json() }; };

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

await get('/api/gmpicks-export');                              // the table
// Friday's two late games, as the NBA log has them (the real Oct 23 prices).
const ins = sq.prepare(`INSERT INTO gmpicks (sport, date, game_id, market, league, commence, side, pick, home, away, win_prob, entry_price, close_price, book, fair_src, sharp_n, model_ver)
  VALUES ('nba', '2026-10-23', ?, 'h2h', 'reg', ?, 'home', ?, ?, ?, ?, ?, ?, 'draftkings', 'sharp-pool', 5, 'gm-v1')`);
ins.run('b1', '2026-10-24T02:10:00Z', 'Los Angeles Lakers', 'Los Angeles Lakers', 'LA Clippers', 76.9, -360, -360);
ins.run('b2', '2026-10-23T23:10:00Z', 'Indiana Pacers', 'Indiana Pacers', 'Dallas Mavericks', 67.8, -215, -215);

let r = await get('/api/picks');
ok(r.body.legs.length === 2 && !r.body.error && r.body.record && r.cc === 'public, max-age=120', 'a good read: the list, its record, kept two minutes');

console.log('\n-- the records refused --');
refuse = /FROM daypicks WHERE on_list = 1|FROM mlpicks WHERE result IN/;
r = await get('/api/picks');
ok(r.body.legs.length === 2 && r.body.legs[0].title === 'Lakers ML' && !r.body.error, `the legs stand (${r.body.legs.map((x) => x.title).join(', ')})`);
ok(r.body.record == null && r.body.recordError === NOMEM, 'without the records, and it says why');
ok(r.cc === 'public, max-age=5', `and the edge keeps it for seconds (${r.cc})`);

console.log('\n-- the list itself refused --');
refuse = /FROM gmpicks WHERE sport IN/;
r = await get('/api/picks');
ok(r.body.error === NOMEM && r.cc === 'public, max-age=5', `a failed list is an error, kept for seconds (${r.cc})`);
refuse = null;

console.log('\n-- the page keeps what it has --');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const at = app.indexOf('async function refreshPicks(');
let depth = 0, end = -1;
for (let i = app.indexOf('{', at); i < app.length; i++) { if (app[i] === '{') depth++; else if (app[i] === '}' && --depth === 0) { end = i + 1; break; } }
const state = { sport: 'nba', picks: null };
let answer = null;
const refresh = new Function('state', 'LIVE_MODE', 'fetchJson', 'renderPicks', 'renderTopCard', 'socSavedLoad',
  app.slice(at, end) + '\nreturn refreshPicks;')(state, true, async () => { if (answer instanceof Error) throw answer; return answer; }, () => {}, () => {}, async () => {});
answer = { legs: [{ title: 'Lakers ML' }], record: {} };
await refresh();
const good = state.picks;
answer = { legs: [], error: NOMEM };
await refresh();
ok(state.picks === good, 'a refresh answered with an error keeps the list on the page');
answer = new Error('network');
await refresh();
ok(state.picks === good, 'and so does one that never arrives');
state.picks = null;
answer = { legs: [], error: NOMEM };
await refresh();
ok(state.picks && state.picks.error === NOMEM, 'with nothing to keep, it says what failed');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
