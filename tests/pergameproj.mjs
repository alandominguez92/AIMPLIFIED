// A game the books have not quoted still reaches the batter board.
//
// The model-only fallback used to be all-or-nothing across the slate: it ran
// only when NOTHING was priced, so the first quoted game switched it off for
// every other game. Those games then had no rows at all — not a row without a
// price, no row — which on the board is indistinguishable from "the model passed
// on them". On 2026-09-15 it hid every hitter facing Yamamoto and Misiorowski.
//
// The fixture is the case that broke: a slate where SOME games are quoted. The
// control is the quoted game — its hitters must still come from the book's list,
// not be topped up from the schedule, or the board would show players nobody can
// price alongside ones they can.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
// A real (if tiny) stand-in for the edge cache, keyed by request URL the way
// Cloudflare's is. The worker builds its own cache key and DROPS the query string
// on most routes, so an always-miss stub could not see a ?summary=1 request being
// served the full board's cached body — which is exactly the bug that hit
// /api/nfl-compare (see comparesummary.mjs).
const edge = new Map();
globalThis.caches = {
  default: {
    match: async (req) => {
      const hit = edge.get(typeof req === 'string' ? req : req.url);
      return hit ? hit.clone() : undefined;
    },
    put: async (req, res) => { edge.set(typeof req === 'string' ? req : req.url, res.clone()); },
  },
};

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
// 3 games, 5 hours out: inside the 12h window, so pricing is not what is measured.
// Real clubs, because the matchup string is built from the league's own
// abbreviations — and these are the two games the bug actually hid.
const GAMES = [
  { id: 'quoted', away: 'SEA', home: 'LAA', awayName: 'Seattle Mariners', homeName: 'Los Angeles Angels', quoted: true },
  { id: 'dark1', away: 'LAD', home: 'CIN', awayName: 'Los Angeles Dodgers', homeName: 'Cincinnati Reds', quoted: false },
  { id: 'dark2', away: 'MIL', home: 'PIT', awayName: 'Milwaukee Brewers', homeName: 'Pittsburgh Pirates', quoted: false },
];
const HITTERS = 10;                       // per club; only the top 9 by PA are seeded
const teamId = (gi, side) => 400 + gi * 2 + side;
const hitterName = (gi, side, n) => `${GAMES[gi][side ? 'home' : 'away']} Hitter ${n}`;

const games = GAMES.map((g, i) => ({
  gamePk: 930000 + i,
  gameDate: iso(NOW + 5 * 3600e3),
  status: { abstractGameState: 'Preview' },
  venue: { name: 'Park' },
  teams: {
    away: { team: { id: teamId(i, 0), abbreviation: g.away, name: g.awayName }, probablePitcher: { id: 8000 + i * 2, fullName: `Away Arm ${i}` } },
    home: { team: { id: teamId(i, 1), abbreviation: g.home, name: g.homeName }, probablePitcher: { id: 8001 + i * 2, fullName: `Home Arm ${i}` } },
  },
}));
const events = GAMES.map((g, i) => ({
  id: g.id, commence_time: iso(NOW + 5 * 3600e3),
  away_team: g.awayName, home_team: g.homeName,
}));

// Season hitting pool: every hitter of every club, all comfortably past the
// gp/PA minimums, so nothing is filtered for sample size.
const statSplits = [];
GAMES.forEach((g, gi) => [0, 1].forEach((side) => {
  for (let n = 1; n <= HITTERS; n++) {
    statSplits.push({
      player: { id: 500000 + gi * 100 + side * 20 + n, fullName: hitterName(gi, side, n) },
      team: { id: teamId(gi, side), abbreviation: GAMES[gi][side ? 'home' : 'away'] },
      stat: {
        gamesPlayed: 140, plateAppearances: 600 - n, atBats: 540, hits: 150, runs: 80, rbi: 75,
        homeRuns: 20, totalBases: 250, strikeOuts: 120, baseOnBalls: 55, avg: '.278', slg: '.463',
      },
    });
  }
}));

// Only two hitters of the quoted game are on a book. The third one below is
// deliberately NOT quoted: it is the control for "a quoted game is not topped up".
const QUOTED = [hitterName(0, 0, 1), hitterName(0, 1, 1)];
const UNQUOTED_IN_QUOTED_GAME = hitterName(0, 0, 2);

let perEventCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const url = String(u);
  const J = (x, s) => new Response(JSON.stringify(x), { status: s || 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('/schedule?')) return J({ dates: [{ games }] });
  if (url.includes('/stats?stats=season') && url.includes('group=hitting')) return J({ stats: [{ splits: statSplits }] });
  if (url.includes('/teams/stats')) {
    return J({ stats: [{ splits: games.flatMap((g) => [g.teams.away.team.id, g.teams.home.team.id]).map((id) => ({
      team: { id }, stat: { hits: 1300, plateAppearances: 6000, strikeOuts: 1330, inningsPitched: '1400.0' },
    })) }] });
  }
  if (url.includes('/people?')) {
    const ids = decodeURIComponent((url.match(/personIds=([^&]*)/) || [])[1] || '');
    return J({ people: ids.split(',').filter(Boolean).map((id) => ({
      id: Number(id), fullName: 'Person ' + id, pitchHand: { code: 'R' },
      stats: [{ splits: [{ stat: { strikeoutsPer9Inn: 9, hitsPer9Inn: 8, inningsPitched: '150.0', gamesStarted: 25, era: '3.50', battersFaced: 600, hits: 150, homeRuns: 18, totalBases: 240, runs: 70 } }] }],
    })) });
  }
  if (url.includes('cdn.espn.com')) return J({ content: { sbData: { events: [] } } });
  if (url.includes('api.the-odds-api.com')) {
    if (/\/events\?/.test(url)) return J(events);
    const m = url.match(/\/events\/([a-z0-9]+)\/odds/);
    if (m) {
      perEventCalls++;
      const g = GAMES.find((x) => x.id === m[1]);
      if (!g || !g.quoted) return J({ bookmakers: [] });      // books have not posted this game
      return J({ bookmakers: ['draftkings', 'fanduel'].map((key) => ({
        key,
        markets: [{
          key: 'batter_total_bases',
          outcomes: QUOTED.flatMap((n) => ([
            { name: 'Over', description: n, point: 1.5, price: -115 },
            { name: 'Under', description: n, point: 1.5, price: -105 },
          ])),
        }],
      })) });
    }
    return J([]);
  }
  if (url.includes('statsapi.mlb.com')) return J({});
  return realFetch(u, o);
};

// D1 stub: records what the track record would be asked to store, so "a row with
// no price never becomes a pick" is asserted against the statements themselves.
// logBatterPicks builds statements and hands them to db.batch, so the batch is
// where the record is actually written — a stub that only watched run() would
// see nothing and pass no matter what the board logged.
const logged = [];
const note = (sql, args) => { if (/INTO bpicks/i.test(sql)) logged.push(args); };
const db = {
  prepare: (sql) => {
    const st = {
      sql, args: [],
      bind: (...a) => { st.args = a; return st; },
      run: async () => { note(st.sql, st.args); return { meta: { changes: 1 } }; },
      first: async () => null,
      all: async () => ({ results: [] }),
    };
    return st;
  },
  batch: async (list) => (list || []).map((x) => { note(x.sql, x.args); return { meta: { changes: 1 } }; }),
};

const pending = [];
const ctx = { waitUntil: (p) => { if (p && p.then) pending.push(p.catch(() => {})); } };
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const res = await mod.default.fetch(new Request('https://x/api/batters'), { ODDS_API_KEY: 'k', DB: db }, ctx);
const body = await res.json();
await Promise.all(pending.splice(0));
const rows = body.rows || [];

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const forGame = (gi) => rows.filter((r) => r.matchup === `${GAMES[gi].away} @ ${GAMES[gi].home}`);

console.log(`slate: 1 quoted game, 2 the books have not posted — ${rows.length} rows\n`);

console.log('-- the unquoted games are on the board --');
ok(forGame(1).length > 0, `the first unquoted game has rows (${forGame(1).length})`);
ok(forGame(2).length > 0, `the second unquoted game has rows (${forGame(2).length})`);
// Each of these re-checks the row count: `[].every(...)` is true, so without it
// the whole block would pass on the very code it is here to catch.
ok(forGame(1).length > 0 && forGame(2).length > 0
  && forGame(1).every((r) => r.odds == null) && forGame(2).every((r) => r.odds == null),
  'every one of them carries a projection and no price');
ok(forGame(1).length > 0 && forGame(1).every((r) => r.projVal != null),
  'the projection itself is present, not a blank row');
ok(forGame(1).length > 0 && forGame(1).length <= 18 && forGame(2).length <= 18,
  `and only the likely starters, not the whole roster (${forGame(1).length}, ${forGame(2).length} of ${HITTERS * 2})`);

console.log('\n-- the quoted game still comes from the book --');
const q = forGame(0);
ok(q.length > 0, `the quoted game has rows (${q.length})`);
ok(q.some((r) => r.odds != null), 'with a price on them');
ok(!q.some((r) => /Hitter (?!1$)/.test(r.name || '')),
  `a hitter the book did not quote is NOT added to a quoted game (${UNQUOTED_IN_QUOTED_GAME})`);

console.log('\n-- it costs nothing extra --');
ok(perEventCalls === GAMES.length,
  `still one paid call per game (${perEventCalls} for ${GAMES.length} games) — seeding is local arithmetic`);

console.log('\n-- and never reaches the record --');
// The guard that matters. A projection with no line is not a pick; if one of
// these were logged it would be graded and counted like something we posted.
const loggedNames = logged.flat().filter((v) => typeof v === 'string');
ok(logged.length > 0, `the priced rows DID log (${logged.length} bpicks writes) — so this check is not vacuous`);
// Asserted on the TEAM column rather than the player name: display names are
// shortened to an initial, and "L. Hitter 1" is both an Angel and a Dodger here.
const loggedTeams = loggedNames.filter((v) => /^[A-Z]{2,3}$/.test(v));
ok(loggedTeams.length === 2 && loggedTeams.every((t) => t === 'SEA' || t === 'LAA'),
  `and only from the quoted game (${loggedTeams.join(', ') || 'none'})`);
ok(!loggedTeams.some((t) => ['LAD', 'CIN', 'MIL', 'PIT'].includes(t)),
  'no hitter from an unquoted game reached the record');

// ---- ?summary=1 ---------------------------------------------------------------
// The same board, counted instead of listed, for the scheduled checks: they have
// to read whatever they fetch, and a full board is ~80 rows of detail to answer
// "is it up, and how much of it has a line".
{
  const sres = await mod.default.fetch(new Request('https://x/api/batters?summary=1'), { ODDS_API_KEY: 'k', DB: db }, ctx);
  await Promise.all(pending.splice(0));
  const sum = await sres.json();
  console.log('\n-- ?summary=1 --');
  ok(!Array.isArray(sum.rows) && sum.rows === rows.length,
    `it counts the board instead of listing it (rows ${JSON.stringify(sum.rows)} vs ${rows.length})`);
  ok(sum.games === 3 && sum.gamesWithALine === 1,
    `every game is represented, priced or not (${sum.games} games, ${sum.gamesWithALine} with a line)`);
  ok(Array.isArray(sum.byGame) && sum.byGame.length === 3
    && sum.byGame.every((g) => g.matchup && typeof g.rows === 'number'),
    'each game carries its own row and price counts');
  ok(JSON.stringify(sum).length < JSON.stringify({ rows, slate: null }).length / 5,
    `and it is far smaller (${JSON.stringify(sum).length} bytes vs ${JSON.stringify(rows).length})`);
  // Named plays and pulls, for the check that runs after lineups post. Counted
  // against the full board so the summary cannot drift from what the page shows.
  const fullPlays = rows.filter((r) => !r.pulled && r.odds != null
    && (r.tier === 'play' || ['1', '2', '3'].includes(String(r.tier))));
  ok(sum.playCount === fullPlays.length && Array.isArray(sum.plays)
    && sum.plays.length === Math.min(20, fullPlays.length),
    `plays match the board (${sum.playCount} vs ${fullPlays.length}, listed ${sum.plays && sum.plays.length})`);
  ok(sum.plays.every((p, i, a) => p.name && p.pick && typeof p.odds === 'number' && (i === 0 || (a[i - 1].edge ?? -99) >= (p.edge ?? -99))),
    'each play is named, priced, and they run best edge first');
  ok(sum.pulled === rows.filter((r) => r.pulled).length && Array.isArray(sum.pulledPlays)
    && sum.pulledPlays.length <= 15
    && Array.isArray(sum.pulledNames) && sum.pulledNames.length === sum.pulled,
    `pulled count matches the board (${sum.pulled})`);
  ok(sum.byGame.every((g) => typeof g.plays === 'number' && typeof g.pulled === 'number' && typeof g.inLineup === 'number'),
    'each game says how many plays, pulls and lineup batters it has');
  // The collision guard. Same path, different query — if the cache key dropped
  // the query, this would come back as the full board.
  ok(sum.byGame !== undefined, 'a summary request is not served the full board from cache');
  const full2 = await (await mod.default.fetch(new Request('https://x/api/batters'), { ODDS_API_KEY: 'k', DB: db }, ctx)).json();
  ok(Array.isArray(full2.rows) && full2.rows.length === rows.length,
    'and the full board is not served the summary either');
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
