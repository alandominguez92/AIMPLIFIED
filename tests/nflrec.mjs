// NFL catches, logged (2026-11-01, the owner's call). Last season's backtest
// had PrizePicks' catches unders landing 55.7% where the sharp books said
// 51.9% (671 priced legs): the one NFL lean it found. Logged, not listed, to
// see whether it holds. What has to hold:
//   - the game-day props read asks for catches beside passing yards, and only
//     inside that window
//   - each player PrizePicks takes an under on is one row: PrizePicks' line,
//     the books' and the sharp books' main lines, and the sharp books' chance
//     of the under at PrizePicks' own line (Pinnacle's first)
//   - their quotes stay out of nfl_lines
//   - each grades from ESPN's box score: under, over or push at PrizePicks'
//     line; a player the box does not have, and no one with his surname, void
//   - the record: how the unders did, against what the sharp books said
//
// Real data: Commanders @ Dolphins, Nov 16 2025, as the props backtest read it
// an hour before kickoff (tests/fixtures/hist-props-nfl-20251116.json -- the
// historical feed's event, the live event read's shape), ESPN's Week 11
// scoreboard and the game's box score (espn-nfl-sb-2025-w11.json,
// espn-nfl-box-401772631.json). Real SQLite and the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = path.join(BOARD, 'tests', 'fixtures');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const read = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const EV = read('hist-props-nfl-20251116.json').odds.data;
const SB = read('espn-nfl-sb-2025-w11.json'), BOX = read('espn-nfl-box-401772631.json');
const RealDate = Date;
let NOW = RealDate.parse(EV.commence_time) - 3 * 3600e3;
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
const asked = [];
globalThis.fetch = async (u) => {
  const url = String(u);
  asked.push(url);
  const J = (x, h) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json', 'x-requests-remaining': '90000', ...(h || {}) } });
  if (new RegExp(`americanfootball_nfl/events/${EV.id}/odds`).test(url)) return J(EV, { 'x-requests-last': '4' });
  if (/americanfootball_nfl\/events\?/.test(url)) return J([(({ bookmakers, ...e }) => e)(EV)], { 'x-requests-last': '0' });
  if (url === 'https://cdn.espn.com/core/nfl/scoreboard?xhr=1&year=2025&seasontype=2&week=11') return J(SB);
  if (url === 'https://cdn.espn.com/core/nfl/boxscore?xhr=1&gameId=401772631') return J(BOX);
  return new Response('{}', { status: 404 });
};
const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const exec = (sql, args, mode) => { const st = sq.prepare(sql); const a = args.map(norm);
  if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
  return { success: true, meta: { changes: Number(st.run(...a).changes) } }; };
const DB = { prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
  all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
  run: async () => exec(s.sql, s.args, 'run') }; return s; }, batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')) };
const env = { DB, ODDS_API_KEY: 'k' };
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const hit = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

console.log('-- 6:30 AM Pacific, three hours before kickoff --');
const cap = await hit('/api/nfl-capture');
const propsUrl = asked.find((u) => new RegExp(`events/${EV.id}/odds`).test(u));
ok(propsUrl && new URL(propsUrl).searchParams.get('markets').split(',').includes('player_receptions'), 'the game-day read asks for catches, beside passing yards');
const rows = sq.prepare('SELECT * FROM nflrec').all();
// PrizePicks' standard lines: those it takes an under on.
const pp = EV.bookmakers.find((b) => b.key === 'prizepicks').markets.find((m) => m.key === 'player_receptions');
const ppUnders = [...new Set(pp.outcomes.filter((o) => o.name === 'Under').map((o) => o.description))];
console.log(`  ${cap.recLogged} rows: ${rows.map((r) => `${r.player} ${r.pp_line} (sharp ${r.sharp_under}%)`).join(' | ')}`);
ok(cap.recLogged === ppUnders.length && rows.length === ppUnders.length, `one row for each player PrizePicks takes an under on (${rows.length})`);
const ds = rows.find((r) => r.player === 'Deebo Samuel Sr.');
const pin = EV.bookmakers.find((b) => b.key === 'pinnacle').markets.find((m) => m.key === 'player_receptions').outcomes.filter((o) => o.description === 'Deebo Samuel Sr.' && o.point === 4.5);
const shin = (u, o) => { const pu = 1 / (u > 0 ? 1 + u / 100 : 1 + 100 / -u), po = 1 / (o > 0 ? 1 + o / 100 : 1 + 100 / -o); return pu / (pu + po); };
const pinU = pin.length === 2 ? Math.round(shin(pin.find((o) => o.name === 'Under').price, pin.find((o) => o.name === 'Over').price) * 1000) / 10 : null;
ok(ds && ds.pp_line === 4.5 && ds.sharp_src === 'pinnacle' && pinU != null && Math.abs(ds.sharp_under - pinU) <= 0.2,
  `Deebo Samuel: PrizePicks 4.5 catches, the sharp books' under at 4.5 Pinnacle's ${ds && ds.sharp_under}% (no-vig ${pinU}%)`);
ok(sq.prepare("SELECT COUNT(*) AS n FROM nfl_lines WHERE market = 'player_receptions'").get().n === 0 && sq.prepare("SELECT COUNT(*) AS n FROM nfl_lines WHERE market = 'player_reception_yds'").get().n > 0,
  'their quotes stay out of nfl_lines; receiving yards go in as before');

console.log('\n-- two days later: the box score --');
// The worker reads this season's schedule for the week; Nov 16 2025 is last season's Week 11.
sq.prepare('UPDATE nflrec SET week = 11').run();
NOW = RealDate.parse('2025-11-18T18:00:00Z');
const tr = await hit('/api/track-record');
const graded = sq.prepare('SELECT player, pp_line, actual, result FROM nflrec').all();
console.log('  ' + graded.map((r) => `${r.player} ${r.actual} vs ${r.pp_line}: ${r.result}`).join(' | '));
// His catches from the box, read here from its receiving category.
const recOf = (name) => { for (const t of (BOX.gamepackageJSON || BOX).boxscore.players) for (const c of t.statistics) if (c.name === 'receiving') {
  const i = c.labels.map((l) => l.toUpperCase()).indexOf('REC'); const a = c.athletes.find((x) => x.athlete.displayName === name); if (a) return Number(a.stats[i]); } return null; };
const dsg = graded.find((r) => r.player === 'Deebo Samuel Sr.');
ok(dsg && dsg.actual === recOf('Deebo Samuel Sr.') && dsg.actual === 7 && dsg.result === 'over', `Deebo Samuel's 7 catches against 4.5: over`);
ok(graded.every((r) => r.result != null) && graded.filter((r) => r.result !== 'void').every((r) => r.result === (r.actual === r.pp_line ? 'push' : r.actual < r.pp_line ? 'under' : 'over')),
  'every row graded at PrizePicks\' line');
const R = tr.nflRec;
const g = graded.filter((r) => r.result === 'under' || r.result === 'over');
ok(R && R.n === g.length && R.hit === g.filter((r) => r.result === 'under').length && R.priced && R.priced.sharpSaid != null,
  `the record on the track record: ${R && R.hit} of ${R && R.n} under, the sharp books having said ${R && R.priced && R.priced.sharpSaid}%`);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
