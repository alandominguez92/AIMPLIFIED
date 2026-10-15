// Passing yards: PrizePicks' number against the books', logged and graded, nothing posted.
//
// The projection stays rejected (42.0% and 49.5% under its own mean in the two
// backtested seasons). This is a different question with no model in it: does
// PrizePicks' under land below PrizePicks' number, and more often where that
// number sits above the books'? Receiving and rushing unders did 30 of 51 there.
//
// What this pins:
//   - the market is bought only inside the day-of window, so each game costs
//     about 2 credits rather than one on every capture across a ten-day horizon
//   - a row is logged on the FIRST capture that sees a game. The passing-TD log
//     reads nfl_lines back before the capture writes to it, so a game seen once
//     is never logged; this one logs from the payload it just bought
//   - each book's main number is its two-sided point nearest even money, so a
//     PrizePicks demon (over-only) or a book's alternate does not stand in for it
//   - the open is kept and the last pre-kick number is what grades
//   - graded from the box score; a quarterback who did not throw is void, never
//     a free under
//   - the record splits by where PrizePicks sat against the books, and will not
//     call it worth posting until the interval clears the flex break-even
//
// Real SQLite (node:sqlite) rather than a stub: the logging is an upsert whose
// WHERE clause is the whole argument that a graded row is never rewritten.
// ESPN is the recorded Week 3 ATL @ GB game (Penix 256 yards, Love 312). The
// odds payload is the Odds API per-event shape; the 2026-10-15 probe of SEA @
// DEN confirmed PrizePicks returns player_pass_yds in it, two-sided, with
// description = player and name = Over/Under, like every other book.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const RealDate = Date;
let NOW = RealDate.parse('2026-09-24T12:00:00Z');   // Thursday 5 AM Pacific
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const ptDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new RealDate(ms));
const KICK = '2026-09-25T00:15:00Z';       // Thursday 5:15 PM Pacific, ~12h out
const KICK_SUN = '2026-09-27T17:00:00Z';   // Sunday, ~77h out: outside the window
const EV1 = { id: 'e1', commence_time: KICK, home_team: 'Green Bay Packers', away_team: 'Atlanta Falcons' };
const EV2 = { id: 'e2', commence_time: KICK_SUN, home_team: 'Buffalo Bills', away_team: 'Los Angeles Chargers' };

// [player, point, over, under] per book. Books' main numbers: Penix 245.5
// (median of 244.5-246.5), Love 315.5. PrizePicks: Penix 250.5 with a 270.5
// demon beside it, Love 320.5, and Kirk Cousins -- who will not throw a pass.
const BOOK_LINES = {
  pinnacle:    [['Michael Penix Jr.', 245.5, -112, -112], ['Jordan Love', 315.5, -110, -114]],
  novig:       [['Michael Penix Jr.', 246.5, -105, -105], ['Jordan Love', 316.5, -104, -106]],
  prophetx:    [['Michael Penix Jr.', 244.5, -110, -110], ['Jordan Love', 314.5, -112, -108]],
  betonlineag: [['Michael Penix Jr.', 245.5, -115, -115], ['Jordan Love', 315.5, -115, -115]],
  draftkings:  [['Michael Penix Jr.', 244.5, -114, -114], ['Michael Penix Jr.', 224.5, -300, 220],
                ['Jordan Love', 315.5, -112, -116], ['Kirk Cousins', 150.5, -110, -120], ['Some Backup', 99.5, -110, -110]],
  fanduel:     [['Michael Penix Jr.', 245.5, -114, -114], ['Jordan Love', 314.5, -114, -114]],
  betmgm:      [['Michael Penix Jr.', 246.5, -115, -115], ['Jordan Love', 316.5, -115, -115]],
};
let ppLines = [['Michael Penix Jr.', 250.5, -137, -137], ['Michael Penix Jr.', 270.5, 120, null],
  ['Jordan Love', 320.5, -137, -137], ['Kirk Cousins', 150.5, -137, -137]];
const market = (lines) => ({
  key: 'player_pass_yds',
  outcomes: lines.flatMap(([who, point, over, under]) => [
    ...(over == null ? [] : [{ name: 'Over', description: who, point, price: over }]),
    ...(under == null ? [] : [{ name: 'Under', description: who, point, price: under }]),
  ]),
});
const oddsFor = (want) => ({
  bookmakers: [...Object.entries(BOOK_LINES), ['prizepicks', ppLines]].map(([key, lines]) => ({
    key, markets: want.includes('player_pass_yds') ? [market(lines)] : [],
  })),
});

const FIX = path.join(BOARD, 'tests', 'fixtures');
const ESPN_WEEK = JSON.parse(fs.readFileSync(path.join(FIX, 'espn-nfl-2026-wk3-scoreboard.json'), 'utf8'));
const ESPN_BOX = JSON.parse(fs.readFileSync(path.join(FIX, 'espn-nfl-boxscore-401872948.json'), 'utf8'));

const oddsCalls = [], espnCalls = [];
globalThis.fetch = async (u) => {
  const url = String(u);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json', 'x-requests-remaining': '100', 'x-requests-last': '1' } });
  if (url.includes('cdn.espn.com')) {
    espnCalls.push(url);
    const q = new URL(url).searchParams;
    if (/\/boxscore/.test(url)) return J(q.get('gameId') === '401872948' ? ESPN_BOX : {});
    const ours = q.get('year') === '2026' && q.get('seasontype') === '2' && q.get('week') === '3';
    return J(ours ? ESPN_WEEK : { content: { sbData: { events: [] } } });
  }
  if (url.includes('api.the-odds-api.com')) {
    oddsCalls.push(url);
    if (/\/events\?/.test(url)) return J([EV1, EV2]);
    const m = url.match(/\/events\/(e\d)\/odds/);
    // Answers with only the markets asked for, as the real API does.
    if (m) return J(oddsFor((new URL(url).searchParams.get('markets') || '').split(',')));
    return J([]);
  }
  return new Response('{}', { status: 404 });
};

// ---- D1 over a real SQLite -------------------------------------------------------------
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
const env = {
  ODDS_API_KEY: 'k', DB,
  ASSETS: { fetch: async (r) => {
    const file = path.join(BOARD, new URL(r.url).pathname);
    if (!fs.existsSync(file)) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(fs.readFileSync(file, 'utf8'), { status: 200, headers: { 'content-type': 'application/json' } });
  } },
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const held = [];
const hit = async (u) => {
  const r = await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: (p) => held.push(p) });
  const j = await r.json();
  await Promise.allSettled(held.splice(0));
  return j;
};
const rows = () => { try { return sq.prepare('SELECT * FROM nflpyd ORDER BY player').all(); } catch (e) { return []; } };
const row = (who) => rows().find((r) => r.player === who) || {};

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// ---- first capture ---------------------------------------------------------------------
const cap1 = await hit('/api/nfl-capture');
const call = (id) => oddsCalls.find((u) => u.includes(`/events/${id}/odds`)) || '';
const mk = (id) => (new URL(call(id) || 'https://x').searchParams.get('markets') || '').split(',');
console.log(`  capture 1: ${cap1.passYdsEvents} event(s) bought passing yards, ${cap1.passYdsLogged} rows logged; e1 asked [${mk('e1')}], e2 [${mk('e2')}]\n`);

ok(mk('e1').includes('player_pass_yds'), 'a game inside the day-of window buys passing yards');
ok(call('e2') && !mk('e2').includes('player_pass_yds'),
  'a game three days out does not -- it would be bought again on every capture until kickoff');
ok(mk('e1').includes('player_pass_tds') && mk('e1').includes('player_rush_yds'), 'and the markets already bought are still bought');
ok((new URL(call('e1')).searchParams.get('bookmakers') || '').split(',').length === 10, 'still ten books, so still one region');

ok(rows().length === 3 && cap1.passYdsLogged === 3,
  `logged on the first capture that sees the game, one row per quarterback PrizePicks quotes (${rows().map((r) => r.player).join(', ')})`);
ok(!rows().some((r) => r.player === 'Some Backup'), 'a quarterback only the books quote is not logged -- there is no PrizePicks number to grade');
ok(!rows().some((r) => r.event_id === 'e2'), 'nothing from the game outside the window');

const p1 = row('Michael Penix Jr.');
ok(p1.pp_line === 250.5 && p1.pp_open === 250.5,
  `PrizePicks' number is its two-sided line, not the over-only demon beside it (${p1.pp_line})`);
ok(p1.book_line === 245.5 && p1.book_n === 7,
  `the books' line is the median of seven books' main numbers (${p1.book_line} from ${p1.book_n})`);
ok(p1.dk_line === 244.5, `DraftKings' main number, not its -300 alternate at 224.5 (${p1.dk_line})`);
ok(p1.sharp_line === 245.5 && p1.sharp_n === 4, `the sharp books' median line on its own (${p1.sharp_line} from ${p1.sharp_n})`);
ok(p1.week === 3 && p1.season === 2026 && p1.season_type === 'REG' && p1.date === ptDay(RealDate.parse(KICK)),
  `stored by season and week, which is how the NFL scoreboard is asked, and dated by kickoff (${p1.season} wk ${p1.week}, ${p1.date})`);
const q = JSON.parse(p1.quotes || '{}');
ok(q.prizepicks && q.prizepicks.length === 2 && q.draftkings && q.draftkings.length === 2,
  'every quote is kept, alternates included, for whatever the record asks later');

// ---- second capture, five hours on: PrizePicks moves Penix down ---------------------------
const firstAt = p1.first_at;
NOW += 5 * 3600e3;
ppLines = ppLines.map((l) => (l[0] === 'Michael Penix Jr.' && l[1] === 250.5 ? [l[0], 240.5, -137, -137] : l));
const cap2 = await hit('/api/nfl-capture');
const p2 = row('Michael Penix Jr.');
ok(rows().length === 3, `a second capture updates the rows rather than adding (${rows().length})`);
ok(p2.pp_line === 240.5 && p2.pp_open === 250.5,
  `the last number before kickoff is what grades; the open is kept (${p2.pp_open} -> ${p2.pp_line})`);
ok(p2.first_at === firstAt && p2.last_at !== firstAt, 'first seen stays first seen');
ok(cap2.passYdsLogged === 3, `(capture 2 logged ${cap2.passYdsLogged})`);

// ---- grade, the next day -----------------------------------------------------------------
NOW = RealDate.parse('2026-09-25T19:00:00Z');   // Friday noon Pacific
const tr = await hit('/api/track-record');
console.log('\n  graded: ' + rows().map((r) => `${r.player} ${r.actual ?? '-'} vs PP ${r.pp_line} -> ${r.result}`).join(' | ') + '\n');
ok(row('Michael Penix Jr.').result === 'over' && row('Michael Penix Jr.').actual === 256,
  `Penix threw for 256 against PrizePicks' 240.5: the under lost (${row('Michael Penix Jr.').result})`);
ok(row('Jordan Love').result === 'under' && row('Jordan Love').actual === 312,
  `Love threw for 312 against 320.5: the under won (${row('Jordan Love').result})`);
ok(row('Kirk Cousins').result === 'void',
  `a quarterback PrizePicks quoted who did not throw a pass is void, never a free under (${row('Kirk Cousins').result})`);
ok(espnCalls.some((u) => /boxscore\?xhr=1&gameId=401872948/.test(u)), 'graded from the box score, which carries every passer');

const rec = tr.nflPassYds || {};
console.log('  record: ' + JSON.stringify({ n: rec.n, hit: rec.hit, byLineGap: rec.byLineGap, ppHigherBy5: rec.ppHigherBy5, controlAtBookLine: rec.controlAtBookLine, verdict: rec.verdict }) + '\n');
ok(rec.logged === 3 && rec.voided === 1 && rec.n === 2 && rec.hit === 1,
  `the record counts what graded, voids apart (${rec.hit} of ${rec.n}, ${rec.voided} void)`);
ok(rec.byLineGap && rec.byLineGap.ppHigher.n === 1 && rec.byLineGap.ppHigher.hit === 1
  && rec.byLineGap.ppLower.n === 1 && rec.byLineGap.ppLower.hit === 0,
  "split by where PrizePicks' number sat against the books' (Love above, Penix below)");
ok(rec.ppHigherBy5 && rec.ppHigherBy5.n === 1, 'and by a gap of five yards or more');
ok(rec.controlAtBookLine && rec.controlAtBookLine.n === 2 && rec.controlAtBookLine.hit === 1,
  "with the books' own under at the books' own number beside it, as a control");
ok(/too few/.test(rec.verdict || ''), `one graded row is no verdict (${rec.verdict})`);
ok(/LOGGED ONLY/.test(rec.note || '') && /nothing posted/.test(rec.note || ''), 'and it says nothing here is posted');

const sum = await hit('/api/track-record?summary=1');
ok(sum.nflPassYds && sum.nflPassYds.n === 2 && sum.nflPassYds.byLineGap && /too few/.test(sum.nflPassYds.verdict || ''),
  'the summary the scheduled checks read carries it');

// ---- the verdict, at sample sizes that can carry one ----------------------------------------
// Lifted from worker.js so the test runs what ships.
const lift = (name) => {
  const s = src.replace(/\r\n/g, '\n');
  const at = s.indexOf(name);
  if (at < 0) throw new Error('worker.js has no ' + name);
  let depth = 0, end = -1;
  for (let i = s.indexOf('{', at); i < s.length; i++) {
    if (s[i] === '{') depth++; else if (s[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  return s.slice(at, end);
};
const S = src.replace(/\r\n/g, '\n');
const constLine = (name) => (S.match(new RegExp(`const ${name} = [^\\n]*`)) || [''])[0];
const build = new Function(
  [lift('function round1('), constLine('PP_BANDS'), lift('function ppSplitRecord('), constLine('PYD_MIN_N'),
    lift('function buildPassYdsRecord(')].join('\n') + '\nreturn buildPassYdsRecord;')();
const synth = (n, unders) => Array.from({ length: n }, (_, i) => ({
  pp_line: 250.5, book_line: 245.5, sharp_line: 245.5,
  result: i < unders ? 'under' : 'over', actual: i < unders ? 230 : 270,
}));
const v = (n, u) => build(synth(n, u)).verdict;
ok(/^worth posting/.test(v(40, 30)), `30 of 40 above the books clears the flex break-even: ${v(40, 30)}`);
ok(/^inconclusive/.test(v(40, 22)), `22 of 40 does not prove anything either way: ${v(40, 22)}`);
ok(/^not worth posting/.test(v(100, 40)), `40 of 100 is below it: ${v(100, 40)}`);
ok(/^too few/.test(v(29, 29)), `29 of 29 is still too few to read: ${v(29, 29)}`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exitCode = fail ? 1 : 0;
