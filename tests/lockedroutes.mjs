// Who can spend the credits (2026-11-04).
//
// Only the entries log and the typed soccer lines checked a key, and the repo is public: anyone
// could run the NFL capture or a probe, start a backtest, or void games in the record. What has to
// hold: those forms answer 403 and run nothing without ADMIN_KEY, with no secret set they answer to
// no one, the reads stay open, the page calls none of them, and a made-up query can't make the MLB
// boards buy their prices again. Nothing here needs a recorded response: the point is that no
// request leaves and no handler runs.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');

const keysAsked = [];
let cacheHit = null;
globalThis.caches = { default: { match: async (r) => { keysAsked.push(r.url); return cacheHit ? cacheHit.clone() : undefined; }, put: async () => {} } };
const upstream = [];
globalThis.fetch = async (u) => {
  upstream.push(String(u));
  return new Response('[]', { status: 200, headers: { 'content-type': 'application/json', 'x-requests-last': '0', 'x-requests-remaining': '999' } });
};

const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const exec = (sql, args, mode) => { const st = sq.prepare(sql); const a = args.map(norm);
  if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
  return { success: true, meta: { changes: Number(st.run(...a).changes) } }; };
const DB = { prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
  all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
  run: async () => exec(s.sql, s.args, 'run') }; return s; }, batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')) };

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const call = (u, env, key) => mod.default.fetch(new Request('https://x' + u, key == null ? undefined : { headers: { 'x-admin-key': key } }), env, { waitUntil() {} });

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

const LOCKED = ['/api/nfl-capture', '/api/nfl-capture?dry=1', '/api/nfl-ingest', '/api/nfl-ingest?dedupe=1', '/api/soccer-ingest', '/api/mlb-void-moved', '/api/mlb-void-moved?since=2026-07-01',
  '/api/links-probe?sport=nba', '/api/fair-probe?sport=nhl', '/api/sports-list', '/api/ml-debug', '/api/nfl-grade',
  '/api/hist-backtest?job=nhl&run=1', '/api/hist-props?job=nba&start=1', '/api/hist-props?job=nba&stop=1', '/api/hist-props?job=nba&regrade=1', '/api/hist-props?job=nba&probe=2026-01-15'];
const tables = () => sq.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n;

console.log('\n-- locked: nothing runs without the key --');
const set = { DB, ODDS_API_KEY: 'k', ADMIN_KEY: 'right' }, unset = { DB, ODDS_API_KEY: 'k' }, blank = { DB, ODDS_API_KEY: 'k', ADMIN_KEY: '' };
for (const u of LOCKED) {
  const none = await call(u, set), wrong = await call(u, set, 'wrong'), noSecret = await call(u, unset, 'right'), empty = await call(u, blank, '');
  ok([none, wrong, noSecret, empty].every((r) => r.status === 403), `${u}: 403 with no key, a wrong key, no secret set, and a blank one (${[none, wrong, noSecret, empty].map((r) => r.status)})`);
}
ok(upstream.length === 0, `no request left the Worker: ${upstream.length}`);
ok(tables() === 0, `no handler ran: not one table was made (${tables()})`);
ok(keysAsked.length === 0, 'and the shared cache was never asked');
const body = await (await call('/api/mlb-void-moved', set)).json();
ok(/admin key/.test(body.error), `it says why: ${body.error}`);

console.log('\n-- the key opens them --');
const started = await (await call('/api/hist-props?job=nba&start=1', set, 'right')).json();
ok(started.job === 'nba' && started.active === true, `the right key starts a job: ${JSON.stringify({ job: started.job, active: started.active })}`);
await call('/api/hist-props?job=nba&stop=1', set, 'right');
const probed = await call('/api/fair-probe?sport=nhl', set, 'right');
ok(probed.status === 200 && upstream.some((x) => x.includes('/sports/icehockey_nhl/events?')), 'the right key reaches the probe');
const voided = await call('/api/mlb-void-moved', set, 'right');
ok(voided.status === 200, `and the repair: ${voided.status}`);

console.log('\n-- the reads stay open --');
for (const u of ['/api/hist-props?job=nba', '/api/hist-props?job=nba&lines=1', '/api/hist-props?job=nba&form=1', '/api/hist-props?job=nba&rows=1', '/api/hist-backtest?job=nhl', '/api/nfl-grade?probe=1']) {
  const r = await call(u, unset);
  ok(r.status === 200, `${u}: ${r.status}, no key`);
}

console.log('\n-- the page calls none of them --');
const page = ['app.js', 'track-record.js', 'nfl-priors.js'].map((f) => fs.readFileSync(path.join(BOARD, f), 'utf8')).join('\n');
const called = new Set([...page.matchAll(/['"`](\/api\/[a-z-]+)/g)].map((m) => m[1]));
const lockedPaths = new Set(LOCKED.map((u) => u.split('?')[0]));
const both = [...called].filter((p) => lockedPaths.has(p) && p !== '/api/hist-props' && p !== '/api/hist-backtest');
ok(called.size > 15 && both.length === 0, `${called.size} routes on the page, locked among them: ${both.join(', ') || 'none'}`);
ok(!called.has('/api/hist-props') && !called.has('/api/hist-backtest'), 'nor the backtests');

console.log('\n-- a made-up query is not a new read of the MLB boards --');
cacheHit = new Response('{"rows":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
const before = upstream.length;
const keyOf = async (u) => { keysAsked.length = 0; await call(u, unset); return keysAsked[0]; };
ok(await keyOf('/api/board?t=1') === 'https://x/api/board', 'the board, ?t=1: the plain entry');
ok(await keyOf('/api/board?summary=1&t=2') === 'https://x/api/board?summary=1', 'the board, ?summary=1&t=2: the summary entry');
ok(await keyOf('/api/batters?t=3') === 'https://x/api/batters', 'the batters, ?t=3: the plain entry');
ok(await keyOf('/api/batters?summary=1') === 'https://x/api/batters?summary=1', 'the batters, ?summary=1: the summary entry');
ok(await keyOf('/api/hot-players?sport=nba') === 'https://x/api/hot-players?sport=nba', 'a route whose answer turns on its query keeps it');
ok(upstream.length === before, 'and none of that bought anything');

console.log('\n-- what the site serves --');
const ignored = fs.readFileSync(path.join(BOARD, '.assetsignore'), 'utf8').split(/\r?\n/);
for (const x of ['tests/', '*.md', 'finalpreview.html', 'worker.js', 'wrangler.toml', 'tools/']) ok(ignored.includes(x), `${x} is not served`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
