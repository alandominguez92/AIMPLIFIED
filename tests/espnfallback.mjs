// Guards the ESPN probable-pitcher fallback.
//
// StatsAPI publishes probables late and backfills. Measured 2026-09-12 it was
// missing 2 of 30 sides that day and 4 of 30 the next, where ESPN had 29 and
// 30. A missing probable is SILENT -- projFor() returns null, the arm drops off
// the K board, the batter board quietly models everyone against a league-average
// opposing arm, and nothing errors. That is the shape of bug this file exists
// for: not a crash, an absence.
//
// The contract is fallback ONLY. The feeds genuinely disagree (CWS read Sean
// Newcomb on StatsAPI and Luis Castillo on ESPN the day this was written), and
// swapping out a pitcher the model has already projected is worse than showing
// none. Most of what follows is about the ways a name can go wrong on the way
// back to a StatsAPI person id, because a WRONG id is the one outcome worse
// than an empty one -- it hangs another player's season line on the projection.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const NOW = Date.now();
const soon = (h) => new Date(NOW + h * 3600000).toISOString();
let pid = 500;
const team = (id, abbr, name) => ({ id, abbreviation: abbr, name });
const arm = (id, full) => ({ id, fullName: full });

// away/home probables: null means StatsAPI has not posted one.
const GAMES = [
  // MIL unannounced; ESPN has Kyle Harrison. The headline case.
  ['CIN', 'MIL', arm(671922, 'Brady Singer'), null],
  // CWS already named by StatsAPI. ESPN says someone else entirely and must
  // lose -- this is the whole "fallback only" rule in one row.
  ['CWS', 'STL', arm(669854, 'Sean Newcomb'), arm(669357, 'Kyle Leahy')],
  // MIA unannounced; ESPN says "Eury Perez", which matches a pitcher AND a left
  // fielder. The position filter settles that one, so it SHOULD fill.
  ['LAD', 'MIA', arm(607192, 'Tyler Glasnow'), null],
  // SEA unannounced; ESPN says "Luis Garcia", which is two different pitchers.
  // Nothing can settle that, so it must stay empty.
  ['SEA', 'ATH', null, arm(676440, 'Gage Jump')],
  // AZ unannounced; ESPN spells the club ARI.
  ['TEX', 'AZ', arm(682243, 'Kumar Rocker'), null],
  // LAA unannounced; ESPN writes the name without its accent.
  ['LAA', 'WSH', null, arm(663474, 'Andrew Alvarez')],
  // MIN plays twice on the card (doubleheader), so ESPN carries the club on two
  // events and nothing says which start is which.
  ['CLE', 'MIN', arm(669022, 'Daniel Espino'), null],
];
const games = GAMES.map(([a, h, ap, hp], i) => ({
  gamePk: 900000 + i,
  gameDate: soon(3),
  status: { abstractGameState: 'Preview' },
  venue: { name: 'Some Park' },
  teams: {
    away: { team: team(100 + i * 2, a, a + ' Club'), probablePitcher: ap },
    home: { team: team(101 + i * 2, h, h + ' Club'), probablePitcher: hp },
  },
}));

// ESPN's scoreboard. Note MIN twice, ARI rather than AZ, and the unaccented
// spelling of the Angels starter.
const espnEvent = (pairs) => ({
  competitions: [{
    competitors: pairs.map(([abbr, nm]) => ({
      team: { abbreviation: abbr },
      probables: nm ? [{ athlete: { id: 1, displayName: nm } }] : [],
    })),
  }],
});
const espn = { content: { sbData: { events: [
  espnEvent([['CIN', 'Brady Singer'], ['MIL', 'Kyle Harrison']]),
  espnEvent([['CHW', 'Luis Castillo'], ['STL', 'Kyle Leahy']]),
  espnEvent([['LAD', 'Tyler Glasnow'], ['MIA', 'Eury Perez']]),
  espnEvent([['TEX', 'Kumar Rocker'], ['ARI', 'Merrill Kelly']]),
  espnEvent([['LAA', 'Walbert Urena'], ['WSH', 'Andrew Alvarez']]),
  espnEvent([['CLE', 'Daniel Espino'], ['MIN', 'Joe Ryan']]),
  espnEvent([['CLE', 'Tanner Bibee'], ['MIN', 'Bailey Ober']]),   // game two
  espnEvent([['SEA', 'Luis Garcia'], ['ATH', 'Gage Jump']]),
] } } };

// StatsAPI name search. Deliberately returns the accented spelling for the name
// that was asked for unaccented, and two people for 'Eury Perez'.
const SEARCH = [
  { id: 690986, fullName: 'Kyle Harrison', primaryPosition: { abbreviation: 'P' } },
  { id: 691587, fullName: 'Eury Pérez', primaryPosition: { abbreviation: 'P' } },
  { id: 516811, fullName: 'Eury Pérez', primaryPosition: { abbreviation: 'LF' } },
  { id: 518876, fullName: 'Merrill Kelly', primaryPosition: { abbreviation: 'P' } },
  { id: 700712, fullName: 'Walbert Ureña', primaryPosition: { abbreviation: 'P' } },
  // Two real, distinct pitchers share this name. No filter can pick one.
  { id: 677651, fullName: 'Luis Garcia', primaryPosition: { abbreviation: 'P' } },
  { id: 472610, fullName: 'Luis Garcia', primaryPosition: { abbreviation: 'P' } },
];

const seen = { espn: [], search: [] };
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const url = String(u);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('cdn.espn.com')) { seen.espn.push(url); return J(espn); }
  if (url.includes('/people/search')) { seen.search.push(url); return J({ people: SEARCH }); }
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
  if (url.includes('api.the-odds-api.com')) return new Response('{}', { status: 401 });
  if (url.includes('statsapi.mlb.com')) return J({});
  return realFetch(u, o);
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const res = await mod.default.fetch(new Request('https://x/api/board'), { ODDS_API_KEY: 'k' }, { waitUntil: () => {} });
const rows = await res.json();
const arms = Object.fromEntries(rows.flatMap((r) => r.pitchers || []).map((p) => [p.team, p]));

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

console.log('-- the hole StatsAPI left is filled --');
ok(!!arms.MIL, 'MIL now projects an arm where StatsAPI named nobody');
ok(arms.MIL && arms.MIL.id === 690986, `resolved to the StatsAPI person id, not ESPN's (${arms.MIL && arms.MIL.id})`);
ok(arms.MIL && arms.MIL.probableSource === 'espn', 'and is labelled as coming from the fallback');

console.log('\n-- fallback only: a named side is never overridden --');
ok(arms.CWS && arms.CWS.id === 669854,
  `CWS keeps StatsAPI's Sean Newcomb (${arms.CWS && arms.CWS.id}) though ESPN says Luis Castillo`);
ok(arms.CWS && arms.CWS.probableSource === 'statsapi', 'and is still labelled statsapi');
ok(rows.flatMap((r) => r.pitchers || []).filter((p) => p.probableSource === 'statsapi').length >= 5,
  'the sides StatsAPI did publish all keep their own source');

console.log('\n-- the date parameter is `date`, not `dates` --');
// site.api uses `dates`; the CDN ACCEPTS it, ignores it, and serves a cached
// current-day scoreboard. That returns real-looking probables for the wrong day,
// which is the worst possible failure here and is invisible in the output.
const espnUrl = seen.espn[0] || '';
ok(/[?&]date=\d{8}(&|$)/.test(espnUrl), `singular date= with YYYYMMDD: ${espnUrl}`);
ok(!/[?&]dates=/.test(espnUrl), 'never the plural form that is silently ignored');

console.log('\n-- position settles a name shared with a non-pitcher --');
ok(arms.MIA && arms.MIA.id === 691587,
  `'Eury Perez' resolves to the pitcher (${arms.MIA && arms.MIA.id}), not the left fielder`);
ok(!rows.flatMap((r) => r.pitchers || []).some((p) => p.id === 516811),
  'the left fielder is never attached to a pitching projection');

console.log('\n-- but two pitchers sharing a name cannot be settled, so it is skipped --');
ok(!arms.SEA, "SEA stays empty: 'Luis Garcia' is two different pitchers");
ok(!rows.flatMap((r) => r.pitchers || []).some((p) => p.id === 677651 || p.id === 472610),
  'neither is guessed at -- a wrong id hangs another player season line on the projection');

console.log('\n-- team spellings are normalised --');
ok(arms.AZ && arms.AZ.id === 518876, `ESPN's ARI maps to StatsAPI's AZ (${arms.AZ && arms.AZ.id})`);

console.log('\n-- accents do not break the join --');
ok(arms.LAA && arms.LAA.id === 700712,
  `ESPN 'Walbert Urena' matches StatsAPI 'Walbert Ureña' (${arms.LAA && arms.LAA.id})`);

console.log('\n-- a doubleheader is dropped rather than guessed at --');
ok(!arms.MIN, 'MIN appears on two ESPN events, so neither start is claimed');
ok(!(seen.search[0] || '').includes('Joe Ryan'), 'and the ambiguous club is never even looked up');

console.log('\n-- one search call covers every name --');
ok(seen.search.length === 1, `people/search called once (${seen.search.length})`);
ok(seen.espn.length >= 1 && seen.espn.length <= 2, `ESPN fetched per board pass (${seen.espn.length})`);

// The cost guard. On a day where StatsAPI has posted everything, this whole
// path must cost nothing -- no ESPN call, no search.
console.log('\n-- no holes means no request at all --');
games.forEach((g, i) => {
  if (!g.teams.away.probablePitcher) g.teams.away.probablePitcher = arm(800 + i, 'Filled Away ' + i);
  if (!g.teams.home.probablePitcher) g.teams.home.probablePitcher = arm(850 + i, 'Filled Home ' + i);
  delete g.teams.away.probableSource; delete g.teams.home.probableSource;
});
seen.espn.length = 0; seen.search.length = 0;
const res2 = await mod.default.fetch(new Request('https://x/api/board?nocache=1'), { ODDS_API_KEY: 'k' }, { waitUntil: () => {} });
await res2.json();
ok(seen.espn.length === 0, `ESPN not fetched when every probable is posted (${seen.espn.length})`);
ok(seen.search.length === 0, `and no name lookup either (${seen.search.length})`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
