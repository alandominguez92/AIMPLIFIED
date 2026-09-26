// Moneyline edges: a big gap to Pinnacle is flagged, and the two kinds of edge
// are told apart.
//
// Graded record through 2026-09-16, priced against Pinnacle: edges 0-2.5 went
// about 41-25, edges 2.5+ went 22-38, and underdogs at 2.5+ went 8-26 (-42.4%).
// Those big gaps were the TOP tier. And when Pinnacle has no line the same Edge
// column holds a different number — our model vs DK/FD — with nothing to say so.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const START = NOW + 5 * 3600e3;
const CLUBS = [
  [[119, 'LAD', 'Los Angeles Dodgers'], [113, 'CIN', 'Cincinnati Reds']],
  [[158, 'MIL', 'Milwaukee Brewers'], [134, 'PIT', 'Pittsburgh Pirates']],
  [[143, 'PHI', 'Philadelphia Phillies'], [121, 'NYM', 'New York Mets']],
];
const games = CLUBS.map(([a, h], i) => ({
  gamePk: 980001 + i, gameDate: iso(START), status: { abstractGameState: 'Preview' }, venue: { name: 'Park' },
  teams: {
    away: { team: { id: a[0], abbreviation: a[1], name: a[2] }, probablePitcher: { id: 6100 + i * 2, fullName: `Away Arm ${i}` } },
    home: { team: { id: h[0], abbreviation: h[1], name: h[2] }, probablePitcher: { id: 6101 + i * 2, fullName: `Home Arm ${i}` } },
  },
}));
const h2h = (key, home, away, hp, ap) => ({ key, markets: [{ key: 'h2h', outcomes: [{ name: home, price: hp }, { name: away, price: ap }] }] });
// Game 0: Pinnacle -150/+140; DK/FD dangle the dog at +170 -> ~4.3-pt gap (the trap).
// Game 1: Pinnacle -150/+140; DK/FD +150 on the dog        -> ~1.3-pt gap (ordinary).
// Game 2: no Pinnacle at all                               -> model edge.
const oddsEvents = [
  { home: CLUBS[0][1][2], away: CLUBS[0][0][2], books: [['pinnacle', -150, 140], ['draftkings', -155, 170], ['fanduel', -160, 165]] },
  { home: CLUBS[1][1][2], away: CLUBS[1][0][2], books: [['pinnacle', -150, 140], ['draftkings', -155, 150], ['fanduel', -160, 145]] },
  { home: CLUBS[2][1][2], away: CLUBS[2][0][2], books: [['draftkings', -130, 110], ['fanduel', -125, 105]] },
].map((e, i) => ({ id: 'e' + i, commence_time: iso(START), home_team: e.home, away_team: e.away,
  bookmakers: e.books.map(([k, hp, ap]) => h2h(k, e.home, e.away, hp, ap)) }));

const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const url = String(u);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('/schedule?')) return J({ dates: [{ games }] });
  if (url.includes('/teams/stats') || url.includes('/standings')) return J({ records: [], stats: [] });
  if (url.includes('/people?')) {
    const ids = decodeURIComponent((url.match(/personIds=([^&]*)/) || [])[1] || '');
    return J({ people: ids.split(',').filter(Boolean).map((id) => ({ id: Number(id), fullName: 'Arm ' + id, pitchHand: { code: 'R' },
      stats: [{ splits: [{ stat: { strikeoutsPer9Inn: 9, hitsPer9Inn: 8, inningsPitched: '150.0', gamesStarted: 25, era: '3.50' } }] }] })) });
  }
  if (url.includes('cdn.espn.com')) return J({ content: { sbData: { events: [] } } });
  if (url.includes('api.the-odds-api.com')) return J(/markets=h2h/.test(url) ? oddsEvents : []);
  if (url.includes('statsapi.mlb.com')) return J({});
  return realFetch(u, o);
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const rows = await (await mod.default.fetch(new Request('https://x/api/board'), { ODDS_API_KEY: 'k' }, { waitUntil() {} })).json();
const mlFor = (abbr) => (rows.find((r) => r.matchup.includes(abbr)) || {}).ml || {};

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const trap = mlFor('CIN'), ordinary = mlFor('PIT'), model = mlFor('NYM');
for (const [label, m] of [['big gap', trap], ['small gap', ordinary], ['no Pinnacle', model]]) {
  console.log(`  ${label.padEnd(11)} pick ${m.pick}  edge ${m.edge}  tier ${m.tier}  kind ${m.edgeKind}  check ${m.edgeCheck}  source ${m.fairSource}`);
}
console.log('');

ok(trap.fairSource === 'pinnacle' && trap.edge >= 2.5, `the trap game really is a 2.5+ gap to Pinnacle (${trap.edge})`);
ok(trap.edgeCheck === true && trap.tier === 'check', `so it is flagged "check", not ranked (tier ${trap.tier})`);
ok(trap.tier !== 1 && trap.tier !== '1', 'and is no longer Tier 1');
ok(trap.edgeKind === 'sharp', 'its edge is labelled as a Pinnacle comparison');

ok(ordinary.fairSource === 'pinnacle' && ordinary.edge > 0 && ordinary.edge < 2.5, `the ordinary game is a small gap (${ordinary.edge})`);
ok(ordinary.edgeCheck === false && ordinary.tier !== 'check', `and is not flagged (tier ${ordinary.tier})`);

ok(model.fairSource === 'dkfd' && model.edgeKind === 'model', `with no Pinnacle line the edge is labelled "model" (${model.edgeKind})`);
ok(model.edgeCheck === false, 'and the Pinnacle-gap flag never applies to a model edge');

// The record keeps flagged rows out of its headline, like pass.
const recSrc = src.slice(src.indexOf('function buildMlRecord'), src.indexOf('function buildMlRecord') + 600);
ok(/r\.tier !== 'check'/.test(recSrc), 'flagged rows are graded but kept out of the moneyline headline record');

// ?summary=1: one line per game for the scheduled checks, read off the same
// board. The cache stub always misses, so this is a second full board() run.
const sum = await (await mod.default.fetch(new Request('https://x/api/board?summary=1'), { ODDS_API_KEY: 'k' }, { waitUntil() {} })).json();
ok(sum && sum.games === rows.length && Array.isArray(sum.byGame) && sum.byGame.length === rows.length,
  `the summary covers every game (${sum && sum.games} of ${rows.length})`);
const sTrap = sum && Array.isArray(sum.byGame) ? sum.byGame.find((g) => g.ml && g.ml.pick === trap.pick) : null;
ok(!!sTrap && sTrap.ml.price === trap.price && sTrap.ml.edge === trap.edge && sTrap.ml.edgeCheck === true
  && sTrap.ml.fairWinProb === trap.winProb,
  'and carries the moneyline exactly as the board has it, check flag included');
ok(!!sTrap && sTrap.ml.modelWinProb === (trap.teamAbbr === trap.homeAbbr ? trap.homeModelProb : trap.awayModelProb),
  `with the model's win probability for the side it picks (${sTrap && sTrap.ml.modelWinProb})`);
ok(!!(sum && Array.isArray(sum.byGame)) && sum.byGame.every((g) => Array.isArray(g.k) && g.k.length > 0),
  'and the strikeout read per starter');
ok(JSON.stringify(sum).length < JSON.stringify(rows).length / 2,
  `and is much smaller (${JSON.stringify(sum).length} vs ${JSON.stringify(rows).length} bytes)`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
