// Two players with the same name are two players.
//
// Books quote hitters by name, so the batter board matches by name — and it used
// to keep ONE season line per name, the last one read. On 2026-09-17 the Athletics'
// Max Muncy overwrote the Dodgers' Max Muncy, so the Dodger's H+R+RBI line in
// LAD @ CIN was priced off the other man's season, at Tropicana Field, against
// Tampa's starter, with the Athletics' implied runs — and posted as a play at +104.
//
// The fixture is that night: a Muncy on each club, in different games, with
// deliberately different season lines so a mix-up shows in the numbers.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const START = NOW + 5 * 3600e3;
const GAMES = [
  { id: 'ladcin', pk: 960001, away: [119, 'LAD', 'Los Angeles Dodgers'], home: [113, 'CIN', 'Cincinnati Reds'], venue: 'Great American Ball Park' },
  { id: 'athtb', pk: 960002, away: [133, 'ATH', 'Athletics'], home: [139, 'TB', 'Tampa Bay Rays'], venue: 'Tropicana Field' },
];
const games = GAMES.map((g) => ({
  gamePk: g.pk, gameDate: iso(START), status: { abstractGameState: 'Preview' }, venue: { name: g.venue },
  teams: {
    away: { team: { id: g.away[0], abbreviation: g.away[1], name: g.away[2] }, probablePitcher: { id: g.pk * 10 + 1, fullName: `Arm ${g.away[1]}` } },
    home: { team: { id: g.home[0], abbreviation: g.home[1], name: g.home[2] }, probablePitcher: { id: g.pk * 10 + 2, fullName: `Arm ${g.home[1]}` } },
  },
}));
const line = (pa, hits, runs, rbi, tb) => ({ gamesPlayed: 140, plateAppearances: pa, atBats: pa - 60, hits, runs, rbi, homeRuns: 20, totalBases: tb, strikeOuts: 120, baseOnBalls: 55, avg: '.260', slg: '.450' });
// Dodger Muncy: big run producer. Athletics Muncy: much lighter. Read the Athletics
// line FIRST and the Dodger second, then the reverse — the old bug kept whichever
// came last, so each order has to be tried or the test passes by luck of ordering.
const DODGER = { player: { id: 571970, fullName: 'Max Muncy' }, team: { id: 119, abbreviation: 'LAD', name: 'Los Angeles Dodgers' }, stat: line(600, 150, 95, 100, 280) };
const ATHLETIC = { player: { id: 691777, fullName: 'Max Muncy' }, team: { id: 133, abbreviation: 'ATH', name: 'Athletics' }, stat: line(600, 130, 55, 45, 190) };
let statOrder = [DODGER, ATHLETIC];

const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const url = String(u);
  const J = (x, st) => new Response(JSON.stringify(x), { status: st || 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('/schedule?')) return J({ dates: [{ games }] });
  if (url.includes('/stats?stats=season') && url.includes('group=hitting')) return J({ stats: [{ splits: statOrder }] });
  if (url.includes('/people?')) {
    const ids = decodeURIComponent((url.match(/personIds=([^&]*)/) || [])[1] || '');
    return J({ people: ids.split(',').filter(Boolean).map((id) => ({ id: Number(id), fullName: 'P' + id, pitchHand: { code: 'R' }, stats: [] })) });
  }
  if (url.includes('cdn.espn.com')) return J({ content: { sbData: { events: [] } } });
  if (url.includes('api.the-odds-api.com')) {
    if (/\/events\?/.test(url)) return J(GAMES.map((g) => ({ id: g.id, commence_time: iso(START), away_team: g.away[2], home_team: g.home[2] })));
    const m = url.match(/\/events\/([a-z]+)\/odds/);
    if (m) {
      // Both games quote a "Max Muncy" — the Dodger in one, the Athletic in the other.
      return J({ bookmakers: ['draftkings', 'fanduel'].map((key) => ({ key, markets: [{
        key: 'batter_hits_runs_rbis',
        // Lines set high enough that both lean UNDER — the board only shows under
        // leans, so an over-leaning Muncy would never appear and his half of the
        // test would pass on any code.
        outcomes: [{ name: 'Over', description: 'Max Muncy', point: 4.5, price: -110 }, { name: 'Under', description: 'Max Muncy', point: 4.5, price: -110 }],
      }] })) });
    }
    return J([]);
  }
  if (url.includes('statsapi.mlb.com')) return J({});
  return realFetch(u, o);
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const board = async () => {
  const res = await mod.default.fetch(new Request('https://x/api/batters'), { ODDS_API_KEY: 'k' }, { waitUntil() {} });
  return (await res.json()).rows || [];
};
// A priced row only reaches the board if it leans under; the model-only view
// shows everything. Read every row the payload carries, priced or not.
const hrrProj = (r) => ((r.batterMarkets || []).find((m) => m.metric === 'hrr') || {}).proj;

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

for (const [label, order] of [['Dodger read first', [DODGER, ATHLETIC]], ['Athletic read first', [ATHLETIC, DODGER]]]) {
  statOrder = order;
  const rows = await board();
  const muncys = rows.filter((r) => /Muncy/.test(r.name || ''));
  console.log(`\n-- ${label}: ${muncys.map((r) => `${r.team} in ${r.matchup} id=${r.playerId} park=${r.park} hrr=${hrrProj(r)}`).join(' | ') || 'no Muncy rows'}`);
  for (const r of muncys) {
    const [a, h] = r.matchup.split(' @ ');
    ok([a, h].includes(r.team), `${r.name} in ${r.matchup} is on a club in that game (${r.team})`);
    const wantId = r.matchup === 'LAD @ CIN' ? DODGER.player.id : ATHLETIC.player.id;
    ok(r.playerId === wantId, `and is the right person (id ${r.playerId}, expected ${wantId})`);
    const wantPark = r.matchup === 'LAD @ CIN' ? 'Great American Ball Park' : 'Tropicana Field';
    ok(r.park === wantPark, `priced at his own game's park (${r.park})`);
  }
  const dodger = muncys.find((r) => r.matchup === 'LAD @ CIN'), athletic = muncys.find((r) => r.matchup === 'ATH @ TB');
  ok(!!dodger && !!athletic, `both Muncys are on the board, one per game (${muncys.length} rows)`);
  if (dodger && athletic) ok(hrrProj(dodger) > hrrProj(athletic), `the two keep their own season lines (${hrrProj(dodger)} vs ${hrrProj(athletic)})`);
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
