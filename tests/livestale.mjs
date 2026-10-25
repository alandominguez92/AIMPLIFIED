// Live Now reads the freshest of ESPN's two NBA scoreboards (2026-10-25).
//
// ESPN's cdn answers the dated scoreboard (?date=YYYYMMDD), the one Live
// asked, from a lagging copy at times. At 2:55 PM Pacific on Oct 25 it had
// Lakers @ Jazz not yet started, 55 minutes after tip, so Live showed nothing
// though the Lakers moneyline was on Picks of the day and the game was in the
// 2nd quarter. Two minutes later it was stuck at 9:54 of the 2nd, 53-35,
// while the undated scoreboard -- today's games -- had 8:11, 55-43. Live now
// reads both and takes each game from whichever is further on.
//
// Both scoreboards are the real ones, recorded together
// (tests/fixtures/espn-nba-stale-20261025.json). The Lakers leg is the list's,
// as it stood that day. Real SQLite, the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const REC = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'espn-nba-stale-20261025.json'), 'utf8'));
const RealDate = Date;
const NOW = RealDate.parse(REC.at);
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
let undated = true;                                            // whether the undated scoreboard answers
globalThis.fetch = async (u) => {
  const url = String(u);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url === 'https://cdn.espn.com/core/nba/scoreboard?xhr=1&date=20261025') return J(REC.dated);
  if (url === 'https://cdn.espn.com/core/nba/scoreboard?xhr=1') return undated ? J(REC.current) : new Response('{}', { status: 503 });
  if (url.includes('statsapi.mlb.com')) return J({ dates: [] });
  return new Response('{}', { status: 404 });
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
const env = { DB };
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

await get('/api/picks');                                        // the tables
const ev = REC.current.content.sbData.events.find((e) => e.id === '401909861');
const stale = REC.dated.content.sbData.events.find((e) => e.id === '401909861');
ok(stale.status.displayClock === '9:54' && ev.status.displayClock === '8:11', `the recording: the dated board at ${stale.status.displayClock} of the 2nd, the undated at ${ev.status.displayClock}`);
sq.prepare(`INSERT INTO daypicks (date, leg_id, kind, src_date, game_id, market, team, label, p, commence, rank, on_list, seen_at)
  VALUES ('2026-10-25', 'nba:ml:evLAL:away', 'nba_ml', '2026-10-25', 'evLAL', 'h2h', 'Los Angeles Lakers', 'Lakers ML', 68.5, ?, 7, 1, '2026-10-25T20:55:00Z')`).run(ev.date.replace(/Z$/, ':00Z'));
sq.prepare(`INSERT INTO gmpicks (sport, date, game_id, market, league, commence, side, pick, home, away, win_prob, entry_price, close_price)
  VALUES ('nba', '2026-10-25', 'evLAL', 'h2h', 'reg', ?, 'away', 'Los Angeles Lakers', 'Utah Jazz', 'Los Angeles Lakers', 68.5, -210, -210)`).run(ev.date.replace(/Z$/, ':00Z'));

const lal = (cards) => cards.find((c) => c.name === 'Lakers ML');
let c = lal(await get('/api/live-now'));
console.log('  ' + (c ? `${c.name} ${c.stat} ${c.vs} [${c.matchup} · ${c.inning}] ${c.state}` : 'no card'));
ok(c && c.inning === 'Q2 8:11' && c.matchup === 'LAL 43 – UTAH 55' && c.stat === '43–55' && c.vs === 'down 12',
  'the card is the current score, from the undated board: Lakers 43-55, Q2 8:11, down 12');
ok(c && c.state === 'cooling', `trailing: ${c && c.state}`);

undated = false;
c = lal(await get('/api/live-now'));
ok(c && c.inning === 'Q2 9:54' && c.stat === '35–53', `with the undated board down, the dated one still serves: ${c && c.stat} at ${c && c.inning}`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
