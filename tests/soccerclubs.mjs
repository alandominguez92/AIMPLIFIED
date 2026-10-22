// Soccer games that never graded (2026-10-21).
//
// The grader finds a game's final by club name, and five clubs are spelled
// differently by the odds feed and by ESPN:
//   Inter Milan / Internazionale, Sporting Lisbon / Sporting CP,
//   Slavia Praha / Slavia Prague, Bodø/Glimt / Bodo/Glimt (the ø was dropped,
//   leaving "bodglimt"), and Brighton and Hove Albion / Brighton & Hove Albion.
// One more match, Rayo Vallecano and Athletic Club on Oct 10, was abandoned,
// and nothing voided it. Sixteen rows across eight games sat pending; the same
// names cost two Picks-of-the-day legs their crests.
//
// The rows are the sixteen exported from production that day
// (tests/fixtures/gmpicks-soc-unmatched-oct.json); the scoreboards are ESPN's,
// from the cdn host the Worker grades from (espn-soc-unmatched-oct.json). Real
// SQLite and the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const RealDate = Date;
const NOW = RealDate.parse('2026-10-21T15:00:00Z');   // Wednesday morning Pacific
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
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
const env = { DB, ASSETS: { fetch: async () => new Response('{}', { status: 404 }) } };

const FIX = path.join(BOARD, 'tests', 'fixtures');
const SB = JSON.parse(fs.readFileSync(path.join(FIX, 'espn-soc-unmatched-oct.json'), 'utf8'));
const ROWS = JSON.parse(fs.readFileSync(path.join(FIX, 'gmpicks-soc-unmatched-oct.json'), 'utf8')).rows;
const asked = [];
globalThis.fetch = async (u) => {
  const url = String(u);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('cdn.espn.com/core/soccer/scoreboard')) { asked.push(url); return J(SB[url] || { content: { sbData: { events: [] } } }); }
  return new Response('{}', { status: 404 });
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const hit = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// ---- the names, on their own ----------------------------------------------------------
const lift = (name) => {
  const s = src.replace(/\r\n/g, '\n');
  let at = s.indexOf(`function ${name}(`);
  if (at < 0) { at = s.indexOf(`const ${name} =`); const end = s.indexOf(';\n', at); return s.slice(at, end + 1); }
  let depth = 0;
  for (let i = s.indexOf('{', at); i < s.length; i++) {
    if (s[i] === '{') depth++; else if (s[i] === '}' && --depth === 0) return s.slice(at, i + 1);
  }
  throw new Error('could not close ' + name);
};
const C = new Function(['CLUB_NOISE', 'TEAM_ALIAS', 'CLUB_LETTERS', 'clubKey', 'clubMatch'].map(lift).join('\n') + '\nreturn { clubMatch };')();
console.log('-- names --');
for (const [a, b] of [['Inter Milan', 'Internazionale'], ['Sporting Lisbon', 'Sporting CP'], ['Slavia Praha', 'Slavia Prague'],
  ['Bodø/Glimt', 'Bodo/Glimt'], ['Brighton and Hove Albion', 'Brighton & Hove Albion']]) {
  ok(C.clubMatch(a, b), `the feed's "${a}" is ESPN's "${b}"`);
}
// The Europa League (2026-10-22), as the odds feed and ESPN spelled them on
// its first capture: the four of eighteen fixtures that did not match.
for (const [a, b] of [['Union Saint-Gilloise', 'Union St.-Gilloise'], ['Rennes', 'Stade Rennais'], ['Omonoia FC', 'Omonia Nicosia'],
  ['Olympiakos Piraeus', 'Olympiacos']]) {
  ok(C.clubMatch(a, b), `the feed's "${a}" is ESPN's "${b}"`);
}
// And the fourteen that matched as they were, including the accented ones.
for (const [a, b] of [['Ferencváros TC', 'Ferencvaros'], ['Lech Poznań', 'Lech Poznan'], ['Jagiellonia Białystok', 'Jagiellonia Bialystok'],
  ['Viktoria Plzeň', 'Viktoria Plzen'], ['Salzburg', 'RB Salzburg'], ['Besiktas JK', 'Besiktas'], ['PFC Levski Sofia', 'Levski Sofia'],
  ["Hapoel Be'er Sheva", "Hapoel Be'er"], ['FC Ararat-Armenia', 'Ararat-Armenia']]) {
  ok(C.clubMatch(a, b), `"${a}" still matches "${b}"`);
}
ok(!C.clubMatch('Rennes', 'Stade Reims') && !C.clubMatch('Olympiakos Piraeus', 'Olympique Lyonnais') && !C.clubMatch('Celtic', 'Celta Vigo'),
  'and the new names join no club they should not');
ok(C.clubMatch('Bournemouth', 'AFC Bournemouth') && C.clubMatch('Malaga', 'Málaga') && C.clubMatch('Bosnia and Herzegovina', 'Bosnia-Herzegovina'),
  'and the pairs that matched before still do');
ok(!C.clubMatch('Inter Milan', 'AC Milan') && !C.clubMatch('Sporting Lisbon', 'Sporting Kansas City') && !C.clubMatch('Inter Miami CF', 'Internazionale'),
  'without joining clubs that only share a word');

// ---- graded from the real scoreboards -------------------------------------------------
await hit('/api/gmpicks-export?sport=soccer');        // the table
const cols = Object.keys(ROWS[0]).filter((k) => k !== 'result' && k !== 'away_score' && k !== 'home_score');
const ins = sq.prepare(`INSERT INTO gmpicks (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
for (const r of ROWS) ins.run(...cols.map((k) => norm(r[k])));
await hit('/api/track-record');

const got = (home, date, market, side) => sq.prepare('SELECT result, home_score, away_score, home, away FROM gmpicks WHERE sport = ? AND home = ? AND date = ? AND market = ? AND side = ?')
  .get('soccer', home, date, market, side) || {};
console.log('\n-- graded --');
const want = [
  ['Sunderland', '2026-10-10', 'fav', 'away', 'win', 'Brighton won 2-0 at Sunderland'],
  ['Sunderland', '2026-10-10', 'h2h', 'draw', 'loss', '(not a draw)'],
  ['RC Lens', '2026-10-13', 'fav', 'home', 'loss', 'Lens lost 0-2 to Sporting CP'],
  ['Bologna', '2026-10-17', 'fav', 'away', 'win', 'Inter won 3-1 at Bologna'],
  ['Brighton and Hove Albion', '2026-10-18', 'fav', 'home', 'win', 'Brighton beat Palace 5-0'],
];
for (const [home, d, mk, side, res, why] of want) {
  const r = got(home, d, mk, side);
  ok(r.result === res, `${d} ${r.away} @ ${r.home}, ${mk} ${side}: ${r.result} -- ${why}`);
}
const byGame = (home) => sq.prepare("SELECT market, side, result, home_score, away_score FROM gmpicks WHERE home = ? AND date < '2026-10-19'").all(home);
const inter = byGame('Inter Milan').find((r) => r.market === 'fav');
ok(inter && inter.result === 'loss' && inter.home_score === 3 && inter.away_score === 4, 'Inter Milan lost 3-4 at home to Club Brugge');
const sabah = byGame('Sabah FK').find((r) => r.market === 'fav');
ok(sabah && sabah.result === 'loss' && sabah.home_score === 2, 'Slavia Praha lost 0-2 at Sabah');
const bodo = byGame('Bodø/Glimt').find((r) => r.market === 'fav');
ok(bodo && bodo.result === 'loss' && bodo.home_score === 1 && bodo.away_score === 0, 'Dortmund lost 0-1 at Bodø/Glimt');
const rayo = byGame('Rayo Vallecano');
ok(rayo.length === 2 && rayo.every((r) => r.result === 'void' && r.home_score == null),
  `the abandoned Rayo Vallecano - Athletic match is void, both rows (${rayo.map((r) => r.result).join(', ')})`);
const left = sq.prepare("SELECT COUNT(*) AS n FROM gmpicks WHERE result IS NULL").get().n;
ok(left === 0, `all sixteen rows settle (${left} still pending)`);
ok(asked.length > 0 && asked.every((u) => u.includes('cdn.espn.com')), 'graded from the cdn host, as in production');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
