// Guards NFL grading against name suffixes, and the ?regrade=dnp repair.
//
// ESPN box scores write "Kyle Pitts Sr." and "James Cook III"; the projections
// say "Kyle Pitts" and "James Cook". The grader matched on the exact name, so
// both starters were graded as did-not-play on Week 1 — along with others — and
// silently dropped out of the verdict. Nothing errored.
//
// Run against a real SQLite database rather than a stub, because the repair is an
// UPDATE whose WHERE clause is the whole safety argument: it must re-open wrongly
// marked DNP rows and never touch a row that already has a real stat line.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : v);
const exec = (sql, args, mode) => {
  const st = sq.prepare(sql); args = args.map(norm);
  if (mode === 'all') return { results: st.all(...args) };
  if (mode === 'first') return st.get(...args) || null;
  return { success: true, meta: { changes: Number(st.run(...args).changes) } };
};
const DB = {
  prepare: (sql) => { const s = { sql, args: [], bind: (...a) => { s.args = a; return s; },
    all: async () => exec(s.sql, s.args, 'all'), first: async () => exec(s.sql, s.args, 'first'),
    run: async () => exec(s.sql, s.args, 'run') }; return s; },
  batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')),
};

const KICK = new Date(Date.now() - 20 * 3600e3).toISOString();   // well past the 5h buffer
const HOME = 'Pittsburgh Steelers', AWAY = 'Atlanta Falcons';
const athlete = (name, yds) => ({ athlete: { displayName: name }, stats: ['5', String(yds)] });
const box = { gamepackageJSON: { boxscore: { players: [{
  statistics: [
    { name: 'receiving', labels: ['REC', 'YDS'], athletes: [
      athlete('Kyle Pitts Sr.', 52),
      athlete('Brian Thomas Jr.', 71),
      athlete('Sam Smith Jr.', 20),      // two players share the base name "sam smith"
      athlete('Sam Smith Sr.', 33),
      athlete('Already Done', 40),
    ] },
    { name: 'rushing', labels: ['CAR', 'YDS'], athletes: [athlete('James Cook III', 88)] },
  ],
}] } } };
globalThis.fetch = async (u) => {
  const url = String(u);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('/scoreboard')) return J({ content: { sbData: { events: [{ id: '999', competitions: [{
    competitors: [{ team: { displayName: HOME } }, { team: { displayName: AWAY } }],
    status: { type: { name: 'STATUS_FINAL' } } }] }] } } });
  if (url.includes('/boxscore')) return J(box);
  return new Response('{}', { status: 404 });
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const env = { DB };
const ctx = { waitUntil: () => {} };
const grade = async (q = '') => (await mod.default.fetch(new Request('https://x/api/nfl-grade' + q), env, ctx)).json();

await grade();   // creates the schema through the worker's own ensureNflSchema

sq.prepare(`INSERT INTO nfl_lines (event_id, commence, home, away, market, player, point, book, over, under, captured_at)
  VALUES ('ev1', ?, ?, ?, 'h2h', NULL, NULL, 'draftkings', NULL, NULL, '1')`).run(KICK, HOME, AWAY);
const proj = sq.prepare(`INSERT INTO nfl_proj (season, week, event_id, player, market, team, pos, game, commence, proj, actual, captured_at, graded_at)
  VALUES (2026, 1, 'ev1', ?, ?, 'X', 'WR', 'ATL @ PIT', ?, 50, ?, ?, ?)`);
const LOCKED = '2026-09-14T07:55:00.000Z';
// The state Week 1 was actually left in: the two suffix players wrongly written
// as DNP (actual NULL, graded_at set), a genuine DNP the same way, and one row
// that graded properly and must survive the repair untouched.
proj.run('Kyle Pitts', 'receiving', KICK, null, KICK, LOCKED);
proj.run('James Cook', 'rushing', KICK, null, KICK, LOCKED);
proj.run('Truly Inactive', 'receiving', KICK, null, KICK, LOCKED);
proj.run('Already Done', 'receiving', KICK, 40, KICK, LOCKED);
// Rows not yet graded at all.
proj.run('Brian Thomas Jr.', 'receiving', KICK, null, KICK, null);
proj.run('Sam Smith', 'receiving', KICK, null, KICK, null);

const row = (player) => sq.prepare('SELECT actual, graded_at FROM nfl_proj WHERE player=?').get(player);
let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

console.log('-- a plain run cannot repair rows already written as DNP --');
const g1 = await grade();
ok(row('Kyle Pitts').actual === null, 'Pitts is still NULL — the grader skips anything already graded');
ok(row('Brian Thomas Jr.').actual === 71, `an exact name still grades as before (${row('Brian Thomas Jr.').actual})`);
ok(row('Sam Smith').actual === null,
  'a base name two players share in the game is refused, not handed to either of them');

console.log('\n-- ?regrade=dnp re-opens only the DNP rows, and the suffix match grades them --');
const g2 = await grade('?regrade=dnp');
ok(g2.reopenedDnp >= 3, `re-opened the NULL-actual rows (${g2.reopenedDnp})`);
ok(row('Kyle Pitts').actual === 52, `"Kyle Pitts" now matches ESPN's "Kyle Pitts Sr." (${row('Kyle Pitts').actual})`);
ok(row('James Cook').actual === 88, `"James Cook" now matches "James Cook III" (${row('James Cook').actual})`);
ok(g2.matchedBySuffix >= 2, `and the response says how many matched that way (${g2.matchedBySuffix})`);

console.log('\n-- and never touches a real result --');
const done = row('Already Done');
ok(done.actual === 40 && done.graded_at === LOCKED,
  `a row with a stat line keeps its value and its original graded_at (${done.actual}, ${done.graded_at})`);
const inactive = row('Truly Inactive');
ok(inactive.actual === null && inactive.graded_at && inactive.graded_at !== LOCKED,
  'a genuine DNP is simply re-checked and written as DNP again');
ok(row('Sam Smith').actual === null, 'the ambiguous base name is still refused on the repair pass');

const g3 = await grade('?regrade=dnp');
ok(row('Kyle Pitts').actual === 52 && row('Already Done').actual === 40,
  'running the repair twice changes nothing that is already right');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
