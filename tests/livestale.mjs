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
let NOW = RealDate.parse(REC.at);
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

// ---- box scores lag the same way ----------------------------------------------------------
// At 4:30 PM Pacific ESPN's boxscore for Magic @ Knicks was still the pre-game
// copy -- no players -- with the game in the 1st, so Karl-Anthony Towns, on
// Picks of the day under 3.5 assists, had no card. playbyplay carries the same
// box and was current (tests/fixtures/espn-nba-stalebox-20261025.json).
console.log('\n-- a box score behind the game --');
const BOX = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'espn-nba-stalebox-20261025.json'), 'utf8'));
NOW = RealDate.parse(BOX.at);
let pbp = true;
const asked = [];
globalThis.fetch = async (u) => {
  const url = String(u);
  asked.push(url);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url === 'https://cdn.espn.com/core/nba/scoreboard?xhr=1&date=20261025') return J(BOX.scoreboardDated);
  if (url === 'https://cdn.espn.com/core/nba/scoreboard?xhr=1') return J(BOX.scoreboard);
  if (url === 'https://cdn.espn.com/core/nba/boxscore?xhr=1&gameId=401909863') return J(BOX.boxscore);
  if (url === 'https://cdn.espn.com/core/nba/playbyplay?xhr=1&gameId=401909863') return pbp ? J(BOX.playbyplay) : new Response('{}', { status: 503 });
  if (url.includes('statsapi.mlb.com')) return J({ dates: [] });
  return new Response('{}', { status: 404 });
};
const nyk = BOX.scoreboard.content.sbData.events.find((e) => e.id === '401909863');
const tip = nyk.date.replace(/Z$/, ':00Z');
sq.prepare(`INSERT INTO nbapp (date, game_id, player, market, league, commence, home, away, team, player_id, point, proj, model_under, n_recent, min_proj, captured_at)
  VALUES ('2026-10-25', 'evNYK', 'Karl-Anthony Towns', 'ast', 'reg', ?, 'New York Knicks', 'Orlando Magic', 'NY', '3136195', 3.5, 2.6, 70.5, 6, 30, '2026-10-25T21:30:00Z')`).run(tip);
sq.prepare(`INSERT INTO daypicks (date, leg_id, kind, src_date, game_id, player_key, market, team, label, p, commence, rank, on_list, seen_at)
  VALUES ('2026-10-25', 'nbapp:evNYK:Karl-Anthony Towns:ast', 'nba_pp', '2026-10-25', 'evNYK', 'Karl-Anthony Towns', 'ast', 'NY', 'Karl-Anthony Towns Under 3.5 AST', 70.5, ?, 2, 1, '2026-10-25T22:55:00Z')`).run(tip);
ok(BOX.boxscore.gamepackageJSON.header.competitions[0].status.type.state === 'pre' && !BOX.boxscore.gamepackageJSON.boxscore.players
  && BOX.playbyplay.gamepackageJSON.header.competitions[0].status.type.shortDetail === '7:17 - 1st',
  'the recording: boxscore before tip with no players, playbyplay at 7:17 of the 1st');
const kat = (cards) => cards.find((x) => x.name === 'Karl-Anthony Towns');
const katCard = kat(await get('/api/live-now'));
console.log('  ' + (katCard ? `${katCard.name} ${katCard.stat}/${katCard.line} ${katCard.statLabel} [${katCard.inning}] ${katCard.note} ${katCard.state}` : 'no card'));
ok(katCard && katCard.onPicks && katCard.stat === 1 && katCard.line === 3.5 && katCard.note === '5 of 30 min' && katCard.inning === 'Q1 5:53',
  "Towns' card, from playbyplay's box: 1 assist in 5 minutes against under 3.5, Q1 5:53");
ok(katCard && katCard.state === 'live', `one assist six minutes in is not an under lost: ${katCard && katCard.state}`);
ok(asked.includes('https://cdn.espn.com/core/nba/playbyplay?xhr=1&gameId=401909863'), 'playbyplay was asked only because the box was behind');
pbp = false;
ok(!kat(await get('/api/live-now')), 'without it, the stale box has no line for him and there is no card -- what Live showed at 4:28');

// ---- late in the 4th: a box behind within the quarter, and when an under is "cashing" --------
// At 6:11 PM Pacific the boxscore was at 10:28 of the 4th (Towns 3 assists in
// 26 minutes), playbyplay at 5:45 (4 in 28), the scoreboard at 6:12. Live had
// read the box and called him "cashing" at 3 against under 3.5 -- the clock
// alone, with half an assist to spare and eight minutes left. The site's other
// ESPN host had his 4th by 5:56 (tests/fixtures/espn-nba-late-20261025.json).
console.log('\n-- late in the 4th --');
const LATE = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'espn-nba-late-20261025.json'), 'utf8'));
NOW = RealDate.parse(LATE.at);
let latePbp = true;
globalThis.fetch = async (u) => {
  const url = String(u);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url === 'https://cdn.espn.com/core/nba/scoreboard?xhr=1&date=20261025') return J(LATE.scoreboardDated);
  if (url === 'https://cdn.espn.com/core/nba/scoreboard?xhr=1') return J(LATE.scoreboard);
  if (url === 'https://cdn.espn.com/core/nba/boxscore?xhr=1&gameId=401909863') return J(LATE.boxscore);
  if (url === 'https://cdn.espn.com/core/nba/playbyplay?xhr=1&gameId=401909863') return latePbp ? J(LATE.playbyplay) : new Response('{}', { status: 503 });
  if (url.includes('statsapi.mlb.com')) return J({ dates: [] });
  return new Response('{}', { status: 404 });
};
ok(LATE.boxscore.gamepackageJSON.header.competitions[0].status.displayClock === '10:28' && LATE.playbyplay.gamepackageJSON.header.competitions[0].status.displayClock === '5:45',
  'the recording: the box at 10:28 of the 4th, playbyplay at 5:45, the same quarter');
let late = kat(await get('/api/live-now'));
console.log('  ' + (late ? `${late.name} ${late.stat}/${late.line} [${late.inning}] ${late.note} ${late.state}` : 'no card'));
ok(late && late.stat === 4 && late.note === '28 of 30 min' && late.state === 'cooling',
  'four minutes of play behind within the quarter, the box gives way to playbyplay: 4 assists, over 3.5, lost');
latePbp = false;
late = kat(await get('/api/live-now'));
ok(late && late.stat === 3 && late.state === 'live',
  `with the box alone, 3 against 3.5 and six minutes left is live, not cashing: his own 2.6 a game leaves about a 28% chance of another (${late && late.state})`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
