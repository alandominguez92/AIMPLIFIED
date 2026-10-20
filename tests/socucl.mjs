// The Champions League on the soccer props card (2026-10-20).
//
// The card read five leagues; the Champions League joins them. ESPN serves its
// lineups, rosters and per-player statistics in the same shape, so fixtures,
// lineups and box scores come the same way. What is different is the
// opponent: its clubs come from every league, so what one allows is read from
// its OWN league (this season's box scores, else last season's priors) as a
// ratio to that league's average. A club is found by abbreviation AND ESPN
// team id, because abbreviations repeat across leagues: "SCP" is St. Pauli in
// the Bundesliga and Sporting CP in Europe.
//
// Real SQLite, the real worker, the real priors, and ESPN's recorded responses
// for Real Madrid at Roma (2026-10-14): the scoreboard and the summary with
// both lineups (tests/fixtures/espn-ucl-401915414.json). The clock is set half
// an hour before kickoff and the recorded match marked not yet started.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const RealDate = Date;
const KICK = RealDate.parse('2026-10-14T19:00:00Z');
const NOW = KICK - 30 * 60e3;
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

const REC = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'espn-ucl-401915414.json'), 'utf8'));
const SB_URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard?dates=20261014';
const SUM_URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/summary?event=401915414';
// Before kickoff, as the scoreboard read it that morning.
const SB = JSON.parse(JSON.stringify(REC[SB_URL]));
SB.events[0].status.type = { state: 'pre', completed: false };
const SUMMARY = REC[SUM_URL];

let quiet = true;     // the first call only builds the schema
const asked = [];
globalThis.fetch = async (u) => {
  const url = String(u);
  asked.push(url);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  if (!quiet && url === SB_URL) return J(SB);
  if (!quiet && url === SUM_URL) return J(SUMMARY);
  if (/\/scoreboard\?/.test(url)) return J({ events: [] });
  return J({});
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const hit = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

await hit('/api/soccer-props');                       // schema
sq.exec('DELETE FROM feed_cache');
// The clubs' own leagues, as the box-score ingest records them: abbreviation
// and ESPN team id. St. Pauli is the Bundesliga's "SCP".
const g = sq.prepare('INSERT INTO soc_box_games (game_id, league, date, home, away, home_cid, away_cid, done, tries) VALUES (?,?,?,?,?,?,?,1,0)');
g.run('d1', 'seriea', '2026-10-05', 'ROMA', 'GEN', '104', '3263');
g.run('d2', 'laliga', '2026-10-05', 'SEV', 'RMA', '243', '86');
g.run('d3', 'bundesliga', '2026-10-04', 'SCP', 'FCU', '3307', '598');
quiet = false;

const d = await hit('/api/soccer-props');
const m = (d.matches || []).find((x) => x.id === '401915414');
console.log(`  match: ${m && m.label} ${m && m.away} @ ${m && m.home}, lineup ${m && m.lineup}, ${m && m.rows.length} rows\n`);

ok(d.leagues && d.leagues.ucl === 'Champions League', 'the card names the Champions League among its leagues');
ok(asked.includes(SB_URL), 'its fixtures are read from ESPN\'s uefa.champions scoreboard');
ok(!!m && m.league === 'ucl' && m.label === 'Champions League' && m.home === 'ROMA' && m.away === 'RMA',
  'Real Madrid at Roma is on the card, under the Champions League');
ok(!!m && m.lineup === 'posted' && m.rows.length > 0, `both lineups read, and starters projected (${m ? m.rows.length : 0} rows)`);

const who = (name) => (m ? m.rows.filter((r) => r.player === name) : []);
const gk = SUMMARY.rosters.find((t) => t.team.abbreviation === 'ROMA').roster.find((p) => p.starter && p.position && p.position.abbreviation === 'G');
ok(!!gk && !pri.players[gk.athlete.id] && who(gk.athlete.displayName).length === 0,
  `a starter with no prior and no starts gets no row (${gk && gk.athlete.displayName})`);
const mb = who('Kylian Mbappé').find((r) => r.stat === 'shots');
ok(!!mb && mb.priorStarts > 0, `a Real Madrid starter projects from his La Liga priors (Mbappé shots ${mb && mb.proj})`);

// What Roma allows, as a ratio to Serie A's average -- from last season's
// priors here, since no Serie A match this season has been read in the test.
const want = (abbr, slug, s) => Math.round(pri.teams[slug][abbr].conc[s] / pri.leagueAvg[slug][s] * 100) / 100;
ok(mb && mb.ctx === want('ROMA', 'ita.1', 'shots'),
  `the opponent is read from its own league: Roma's shots allowed against Serie A's average (${mb && mb.ctx} vs ${want('ROMA', 'ita.1', 'shots')})`);
const romaRow = m && m.rows.find((r) => r.team === 'ROMA' && r.stat === 'passes');
ok(romaRow && romaRow.ctx === want('RMA', 'esp.1', 'passes'),
  `and the other way, Real Madrid's against La Liga's (${romaRow && romaRow.ctx})`);

const logged = sq.prepare("SELECT COUNT(*) AS n, MIN(league) AS lg FROM socprops WHERE game_id = '401915414'").get();
ok(logged.n === m.rows.length && logged.lg === 'ucl', `each row is logged under the Champions League, to be graded like any other (${logged.n})`);

// The club lookup, run against the same database.
const lift = (name) => {
  const s = src.replace(/\r\n/g, '\n');
  const at = s.indexOf(`async function ${name}(`) >= 0 ? s.indexOf(`async function ${name}(`) : s.indexOf(`function ${name}(`);
  if (at < 0) throw new Error('worker.js has no ' + name);
  let depth = 0;
  for (let i = s.indexOf('{', at); i < s.length; i++) {
    if (s[i] === '{') depth++; else if (s[i] === '}' && --depth === 0) return s.slice(at, i + 1);
  }
  throw new Error('could not close ' + name);
};
const teamLeague = new Function(lift('socTeamLeague') + '\nreturn socTeamLeague;')();
ok(await teamLeague(DB, 'ROMA', '104') === 'seriea' && await teamLeague(DB, 'RMA', '86') === 'laliga', 'each club is found in its own league');
ok(await teamLeague(DB, 'SCP', '2250') === null && await teamLeague(DB, 'SCP', '3307') === 'bundesliga',
  'by abbreviation AND team id: Sporting CP (SCP, 2250) is not St. Pauli (SCP, 3307)');
ok(/ucl: 'uefa\.champions'/.test(src.match(/const SOC_PROP_LEAGUES = \{[^}]*\}/)[0]),
  'the box-score ingest walks the same league list, so these legs grade');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
