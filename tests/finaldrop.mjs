// A game that has gone Final leaves the board.
//
// The whole risk in this change is WHERE the filter sits. The board's rows array
// is the same object logPicks / logMlPicks / logRlPicks / saveProjLog write from,
// so filtering one line too early would mean a game that ended before anyone
// opened the page never reached the track record at all: no pick, no grade, no
// row, and nothing on the page to show it was missing. That failure is invisible
// and permanent, which is why most of this file is about the record rather than
// about what is displayed.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const team = (id, abbr) => ({ id, abbreviation: abbr, name: abbr + ' Club' });
const arm = (id, full) => ({ id, fullName: full });

// One of each state. The Final game is the subject; the other two are the
// control that proves the filter is selective rather than just emptying the board.
const GAMES = [
  { abbr: ['DONE', 'OVER'], state: 'Final', t: NOW - 5 * 3600e3, pk: 910001 },
  { abbr: ['NOWA', 'NOWH'], state: 'Live', t: NOW - 1 * 3600e3, pk: 910002 },
  { abbr: ['SOON', 'LATE'], state: 'Preview', t: NOW + 4 * 3600e3, pk: 910003 },
];
const mkGame = (i, abbr, state, t, pk) => ({
  gamePk: pk,
  gameDate: iso(t),
  status: { abstractGameState: state },
  venue: { name: 'Park' },
  linescore: { teams: { away: { runs: 3 }, home: { runs: 5 } } },
  teams: {
    away: { team: team(200 + i * 2, abbr[0]), score: 3, probablePitcher: arm(9000 + i * 2, `Away Arm ${i}`) },
    home: { team: team(201 + i * 2, abbr[1]), score: 5, probablePitcher: arm(9001 + i * 2, `Home Arm ${i}`) },
  },
});
const games = GAMES.map((g, i) => mkGame(i, g.abbr, g.state, g.t, g.pk));

const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const url = String(u);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('/schedule?')) return J({ dates: [{ games }] });
  if (url.includes('/teams/stats')) {
    return J({ stats: [{ splits: games.flatMap((g) => [g.teams.away.team.id, g.teams.home.team.id]).map((id) => ({
      team: { id }, stat: { hits: 1300, plateAppearances: 6000, strikeOuts: 1330, inningsPitched: '1400.0' },
    })) }] });
  }
  if (url.includes('/people?')) {
    const ids = (url.match(/personIds=([^&]*)/) || [])[1] || '';
    return J({ people: ids.split(',').filter(Boolean).map((id) => ({
      id: Number(id), fullName: 'Arm ' + id, pitchHand: { code: 'R' },
      stats: [{ splits: [{ stat: {
        strikeoutsPer9Inn: 9, hitsPer9Inn: 8, inningsPitched: '150.0', gamesStarted: 25, era: '3.50',
      } }] }],
    })) });
  }
  if (url.includes('cdn.espn.com')) return J({ content: { sbData: { events: [] } } });
  if (url.includes('api.the-odds-api.com')) return new Response('{}', { status: 401 });
  if (url.includes('statsapi.mlb.com')) return J({});
  return realFetch(u, o);
};

// D1 stub that records which game ids were written, so "did the Final game still
// reach the record" is asserted against the actual statements rather than assumed.
const written = { picks: new Set(), proj: new Set(), any: [] };
const db = {
  prepare: (sql) => {
    const st = {
      sql, args: [],
      bind: (...a) => { st.args = a; return st; },
      run: async () => { record(st.sql, st.args); return { meta: { changes: 1 } }; },
      first: async () => null,
      all: async () => ({ results: [] }),
    };
    return st;
  },
  batch: async (list) => list.map((x) => { record(x.sql, x.args); return { meta: { changes: 1 } }; }),
};
function record(sql, args) {
  written.any.push({ sql, args });
  const gid = (args || []).find((v) => typeof v === 'string' && /^g9100\d\d$/.test(v));
  if (!gid) return;
  if (/INTO picks/i.test(sql)) written.picks.add(gid);
  if (/INTO proj_log/i.test(sql)) written.proj.add(gid);
}

const pending = [];
const ctx = { waitUntil: (p) => { if (p && p.then) pending.push(p.catch(() => {})); } };

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const res = await mod.default.fetch(new Request('https://x/api/board'), { ODDS_API_KEY: 'k', DB: db }, ctx);
const rows = await res.json();
await Promise.all(pending.splice(0));

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const has = (m) => rows.some((r) => r.matchup === m);

console.log('-- the finished game leaves the board --');
ok(!has('DONE @ OVER'), 'the Final game is gone');
ok(rows.length === 2, `the other two remain (${rows.length} rows)`);

console.log('\n-- and only the finished one --');
ok(has('NOWA @ NOWH'), 'a game in progress still shows');
ok(has('SOON @ LATE'), 'a game not yet started still shows');
ok(rows.every((r) => r.status !== 'Final'), 'no row left on the board reads Final');

console.log('\n-- but it still reached the record --');
// The assertion the change exists to protect. A board that filtered one line
// earlier would pass every check above and fail this one, with nothing visible
// anywhere to say a night of work had been dropped.
//
// Asserted on proj_log rather than picks. logPicks only writes rows carrying a
// PRICE, and the Odds API is stubbed to 401 here, so no pick can exist in this
// fixture — an assertion on `picks` would pass vacuously for every game. proj_log
// writes one row per probable starter regardless of pricing, so it covers all
// three games and is a true read on whether the array reached the writes intact.
// The log calls are adjacent in the source and all precede the filter, so this
// pins the ordering for the whole block.
ok(written.proj.has('g910001'),
  `the Final game still wrote its projections (${[...written.proj].join(', ') || 'none'})`);
ok(written.proj.has('g910002') && written.proj.has('g910003'),
  'so did the unfinished games, so logging is not selective');
ok(written.proj.size === 3, `all three games logged (${written.proj.size}) while only two are displayed`);

console.log('\n-- the batter board follows the same rule --');
const pending2 = [];
const ctx2 = { waitUntil: (p) => { if (p && p.then) pending2.push(p.catch(() => {})); } };
const bres = await mod.default.fetch(new Request('https://x/api/batters'), { ODDS_API_KEY: 'k', DB: db }, ctx2);
const bod = await bres.json();
await Promise.all(pending2.splice(0));
const brows = (bod && bod.rows) || [];
ok(Array.isArray(brows), 'the batter board answered');
ok(brows.every((r) => r.status !== 'Final'), `no Final row on the batter board (${brows.length} rows)`);

// TTL matters because it decides how long a finished game lingers before the
// board is rebuilt without it. With a first pitch four hours out the far window
// is correct and the fixture above gets 900s. The case worth pinning is the one
// late in a slate: nothing upcoming, only games in progress. soonestStart then
// finds no future start and ttlForSoonest falls to the near window, so each game
// clears within five minutes of going Final instead of up to fifteen.
console.log('\n-- late in the slate, the board refreshes on the near window --');
const cc1 = res.headers.get('cache-control') || '';
ok(/max-age=900/.test(cc1), `a first pitch 4h out still uses the far window: ${cc1}`);

games.length = 0;
games.push(mkGame(0, ['DONE', 'OVER'], 'Final', NOW - 5 * 3600e3, 910001));
games.push(mkGame(1, ['NOWA', 'NOWH'], 'Live', NOW - 1 * 3600e3, 910002));
const res2 = await mod.default.fetch(new Request('https://x/api/board?x=2'), { ODDS_API_KEY: 'k', DB: db },
  { waitUntil: (q) => { if (q && q.then) q.catch(() => {}); } });
const rows2 = await res2.json();
const cc2 = res2.headers.get('cache-control') || '';
ok(rows2.length === 1 && rows2[0].matchup === 'NOWA @ NOWH', `only the live game remains (${rows2.length})`);
ok(/max-age=300/.test(cc2), `nothing upcoming falls to the near window: ${cc2}`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
