// The Europa League on the soccer tab (2026-10-22): the moneyline board and
// the props card.
//
// Board: its 1X2 is read from the odds feed like the other leagues' (the same
// two-book rule), so its favourites are logged and, at 65% or more, join Picks
// of the day. A logged game grades from ESPN's uefa.europa scoreboard: without
// the slug the grader falls back to the Premier League's and never finds it.
//
// Props: read the way the Champions League is. Its clubs come from every
// league, so what an opponent allows is read from its own league, and a club
// from a league the card does not read (Lech Poznan) has no player data and no
// rate: its starters get no rows, and it moves nothing for the other side.
//
// Real SQLite, the real worker, the real priors, and ESPN's recorded responses
// for the 2026-10-15 matchday (tests/fixtures/espn-uel-20261015.json): Juventus
// at Celta Vigo and Bayer Leverkusen at Lech Poznan, the scoreboard, both
// summaries with their lineups, and the cdn scoreboards the grader reads. The
// betting feed spells Juventus and Celta Vigo as ESPN does (both graded in
// Serie A and La Liga). The clock is set before each kickoff for the card, and
// the next morning for grading.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const RealDate = Date;
let NOW = RealDate.parse('2026-10-15T16:15:00Z');      // half an hour before Leverkusen at Lech
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
const PRIORS = fs.readFileSync(path.join(BOARD, 'soccer-priors.json'), 'utf8');
const pri = JSON.parse(PRIORS);
const env = { DB, ASSETS: { fetch: async (r) => (new URL(r.url).pathname === '/soccer-priors.json'
  ? new Response(PRIORS, { status: 200 }) : new Response('{}', { status: 404 })) } };

const REC = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'espn-uel-20261015.json'), 'utf8'));
const SITE = 'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.europa';
const SB_URL = `${SITE}/scoreboard?dates=20261015`;
// Before kickoff, as the scoreboard read it that morning.
const SB = JSON.parse(JSON.stringify(REC[SB_URL]));
for (const e of SB.events) e.status.type = { name: 'STATUS_SCHEDULED', state: 'pre', completed: false };
const LECH = '401915576', CELTA = '401915560';
const sum = (id) => REC[`${SITE}/summary?event=${id}`];
// What a club allows in its own league, as a ratio to that league's average.
const want = (abbr, slug, s) => Math.round(pri.teams[slug][abbr].conc[s] / pri.leagueAvg[slug][s] * 100) / 100;

let quiet = true;     // the first call only builds the schema
const asked = [];
globalThis.fetch = async (u) => {
  const url = String(u);
  asked.push(url);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('cdn.espn.com/core/soccer/scoreboard')) return J(REC[url] || { content: { sbData: { events: [] } } });
  if (!quiet && url === SB_URL) return J(SB);
  for (const id of [LECH, CELTA]) if (!quiet && url === `${SITE}/summary?event=${id}`) return J(sum(id));
  if (/\/scoreboard\?/.test(url)) return J({ events: [] });
  return J({});
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const hit = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

console.log('-- the board --');
const block = (name) => (src.replace(/\r\n/g, '\n').match(new RegExp(`const ${name} = \\{[\\s\\S]*?\\n\\};`)) || [''])[0];
ok(/\n  uel: \{ key: 'soccer_uefa_europa_league', label: 'Europa League', country: 'UEFA' \},/.test(block('SOCCER_LEAGUES')),
  'the Europa League is one of the board\'s leagues, read from the odds feed\'s soccer_uefa_europa_league');
ok(!/uel: \{[^}]*pinnacleFallback/.test(block('SOCCER_LEAGUES')), 'with the two-book rule (no Pinnacle-alone fallback)');

// A logged favourite grades the next morning from ESPN's Europa League scoreboard.
await hit('/api/gmpicks-export?sport=soccer');        // the table
const row = { sport: 'soccer', date: '2026-10-15', market: 'fav', league: 'uel', week: null, commence: '2026-10-15T19:00:00Z',
  away: 'Juventus', home: 'Celta Vigo', side: 'away', point: null, pick: 'Juventus', win_prob: 48.1, implied: 47.6, edge: 0.5,
  entry_price: 110, close_price: 110, book: 'draftkings', fair_src: 'sharp-pool', sharp_n: 3, game_id: 'uel-test-juv-cel', model_ver: 'gm-v1' };
const cols = Object.keys(row);
sq.prepare(`INSERT INTO gmpicks (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((k) => norm(row[k])));
NOW = RealDate.parse('2026-10-16T15:00:00Z');
quiet = false;
await hit('/api/track-record');
const g = sq.prepare("SELECT result, home_score, away_score FROM gmpicks WHERE game_id = 'uel-test-juv-cel'").get();
ok(asked.some((u) => u.includes('league=uefa.europa&date=20261015')), 'the grader asks ESPN\'s uefa.europa scoreboard for the day');
ok(g.result === 'win' && g.home_score === 1 && g.away_score === 2, `Juventus won 2-1 at Celta Vigo: the favourite's row is a win (${g.result} ${g.home_score}-${g.away_score})`);

console.log('\n-- the props card --');
NOW = RealDate.parse('2026-10-15T16:15:00Z');
quiet = true;
await hit('/api/soccer-props');                       // schema
sq.exec('DELETE FROM feed_cache');
// The clubs' own leagues, as the box-score ingest records them. Juventus's
// latest match in the table is a Europa League one: a cup is never a club's league.
const sg = sq.prepare('INSERT INTO soc_box_games (game_id, league, date, home, away, home_cid, away_cid, done, tries) VALUES (?,?,?,?,?,?,?,1,0)');
sg.run('d1', 'seriea', '2026-10-04', 'JUV', 'MIL', '111', '103');
sg.run('d2', 'laliga', '2026-10-05', 'CEL', 'RMA', '85', '86');
sg.run('d3', 'bundesliga', '2026-10-04', 'B04', 'SCP', '131', '3307');
sg.run('d4', 'uel', '2026-10-08', 'JUV', 'XYZ', '111', '9999');
quiet = false;

let d = await hit('/api/soccer-props');
const lech = (d.matches || []).find((x) => x.id === LECH);
console.log(`  ${lech && lech.label} ${lech && lech.away} @ ${lech && lech.home}, lineup ${lech && lech.lineup}, ${lech && lech.rows.length} rows`);
ok(d.leagues && d.leagues.uel === 'Europa League', 'the card names the Europa League among its leagues');
ok(asked.includes(SB_URL), 'its fixtures are read from ESPN\'s uefa.europa scoreboard');
ok(!!lech && lech.league === 'uel' && lech.label === 'Europa League' && lech.lineup === 'posted', 'Leverkusen at Lech Poznan is on the card with its lineups read');
const lechStarters = sum(LECH).rosters.find((t) => t.team.abbreviation === 'LECH').roster.filter((p) => p.starter);
// One Lech starter played last season in a league the card reads, and his
// priors are keyed by player, so he projects wherever he plays now.
const lechCovered = lechStarters.filter((p) => pri.players[p.athlete.id]).map((p) => p.athlete.id);
const lechRows = lech ? lech.rows.filter((r) => r.team === 'LECH') : [];
ok(lech && lech.rows.some((r) => r.team === 'B04') && lechCovered.length === 1 && lechRows.length > 0 && lechRows.every((r) => lechCovered.includes(r.id)),
  `Lech's starters with no player data get no rows; the one with priors from a covered league does, and Leverkusen's do (${lechRows.length} Lech rows, ${lech ? lech.rows.length - lechRows.length : 0} Leverkusen)`);
ok(lech && lech.rows.filter((r) => r.team === 'B04').every((r) => r.ctx == null), 'Lech, with no rate of its own, moves nothing for Leverkusen');
const lechShots = lechRows.find((r) => r.stat === 'shots');
ok(lechShots && lechShots.ctx === want('B04', 'ger.1', 'shots'), `and Leverkusen is read from the Bundesliga for him (${lechShots && lechShots.player}, shots ${lechShots && lechShots.ctx})`);

NOW = RealDate.parse('2026-10-15T18:30:00Z');         // half an hour before Juventus at Celta
sq.exec('DELETE FROM feed_cache');
d = await hit('/api/soccer-props');
const cel = (d.matches || []).find((x) => x.id === CELTA);
console.log(`  ${cel && cel.label} ${cel && cel.away} @ ${cel && cel.home}, lineup ${cel && cel.lineup}, ${cel && cel.rows.length} rows`);
ok(!!cel && cel.lineup === 'posted' && cel.rows.some((r) => r.team === 'JUV') && cel.rows.some((r) => r.team === 'CEL'),
  'Juventus at Celta Vigo: both sides project, each from its own league\'s priors');
const juvRow = cel && cel.rows.find((r) => r.team === 'JUV' && r.stat === 'passes');
const celRow = cel && cel.rows.find((r) => r.team === 'CEL' && r.stat === 'passes');
ok(juvRow && juvRow.ctx === want('CEL', 'esp.1', 'passes'), `Celta is read from La Liga for Juventus's players (${juvRow && juvRow.ctx} vs ${want('CEL', 'esp.1', 'passes')})`);
ok(celRow && celRow.ctx === want('JUV', 'ita.1', 'passes'),
  `and Juventus from Serie A, not from its latest match in the table, a Europa League one (${celRow && celRow.ctx})`);
const logged = sq.prepare("SELECT COUNT(*) AS n, MIN(league) AS lo, MAX(league) AS hi FROM socprops WHERE game_id IN (?, ?)").get(LECH, CELTA);
ok(logged.n === lech.rows.length + cel.rows.length && logged.lo === 'uel' && logged.hi === 'uel',
  `each row is logged under the Europa League, to be graded like any other (${logged.n})`);
ok(/uel: 'uefa\.europa'/.test(src.match(/const SOC_PROP_LEAGUES = \{[^}]*\}/)[0]), 'and the box-score ingest walks the same league list, so they grade');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
