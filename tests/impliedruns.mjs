// Implied team runs move the H+R+RBI projection — and nothing else.
//
// Backtest (2026-09-17, see ITT_BETA in worker.js): actual H+R+RBI rose 33% from
// the lowest-scoring offenses to the highest while the projection rose 10%, and
// adding implied team runs at beta 0.5 improved held-out accuracy (p~0.001). Total
// Bases showed no out-of-sample gain and is deliberately left alone.
//
// The fixture is three games of IDENTICAL hitters — same season line, same
// opposing arm, same park — so the only thing that differs is the game line ESPN
// reports. Any gap between their projections is the new input and nothing else.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const START = NOW + 5 * 3600e3;
// A: the favourite in a high total. B: the underdog in a low total. C: no line posted.
const GAMES = [
  { key: 'A', away: 'LAD', home: 'CIN', awayName: 'Los Angeles Dodgers', homeName: 'Cincinnati Reds', total: 11, awayML: '-200', homeML: '+170' },
  { key: 'B', away: 'ATH', home: 'TB', awayName: 'Athletics', homeName: 'Tampa Bay Rays', total: 7, awayML: '+240', homeML: '-290' },
  { key: 'C', away: 'SEA', home: 'LAA', awayName: 'Seattle Mariners', homeName: 'Los Angeles Angels', total: null },
];
const teamId = (gi, side) => 700 + gi * 2 + side;
const games = GAMES.map((g, i) => ({
  gamePk: 950000 + i, gameDate: iso(START), status: { abstractGameState: 'Preview' }, venue: { name: 'Neutral Park' },
  teams: {
    away: { team: { id: teamId(i, 0), abbreviation: g.away, name: g.awayName }, probablePitcher: { id: 8800 + i * 2, fullName: `Arm ${i}a` } },
    home: { team: { id: teamId(i, 1), abbreviation: g.home, name: g.homeName }, probablePitcher: { id: 8801 + i * 2, fullName: `Arm ${i}h` } },
  },
}));
// One identical hitter per club.
const hitter = (gi, side) => `${GAMES[gi][side ? 'home' : 'away']} Bat`;
const statSplits = [];
GAMES.forEach((g, gi) => [0, 1].forEach((side) => statSplits.push({
  player: { id: 900000 + gi * 10 + side, fullName: hitter(gi, side) },
  team: { id: teamId(gi, side), abbreviation: g[side ? 'home' : 'away'] },
  stat: { gamesPlayed: 140, plateAppearances: 600, atBats: 540, hits: 150, runs: 80, rbi: 75, homeRuns: 20, totalBases: 250, strikeOuts: 120, baseOnBalls: 55, avg: '.278', slg: '.463' },
})));

const espnBoard = {
  content: { sbData: { events: GAMES.map((g, i) => ({
    id: String(990000 + i), date: iso(START),
    competitions: [{
      competitors: [
        { homeAway: 'away', team: { abbreviation: g.away } },
        { homeAway: 'home', team: { abbreviation: g.home } },
      ],
      odds: g.total == null ? [] : [{
        overUnder: g.total,
        moneyline: { away: { close: { odds: g.awayML } }, home: { close: { odds: g.homeML } } },
      }],
    }],
  })) } },
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const url = String(u);
  const J = (x, st) => new Response(JSON.stringify(x), { status: st || 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('/schedule?')) return J({ dates: [{ games }] });
  if (url.includes('/stats?stats=season') && url.includes('group=hitting')) return J({ stats: [{ splits: statSplits }] });
  if (url.includes('/people?')) {
    const ids = decodeURIComponent((url.match(/personIds=([^&]*)/) || [])[1] || '');
    return J({ people: ids.split(',').filter(Boolean).map((id) => ({
      id: Number(id), fullName: 'Arm ' + id, pitchHand: { code: 'R' },
      // Every opposing arm identical, so the pitcher factor cannot separate them.
      stats: [{ splits: [{ stat: { battersFaced: 600, hits: 150, homeRuns: 18, doubles: 30, triples: 3, runs: 70 } }] }],
    })) });
  }
  if (url.includes('cdn.espn.com')) return J(espnBoard);
  if (url.includes('api.the-odds-api.com')) {
    // One priced game, so a pick is logged and the column can be read back. The
    // low-scoring club's hitter: he leans under, and the board only shows under
    // leans, so a priced over-lean would simply not be on it.
    if (/\/events\?/.test(url)) return J([{ id: 'gamea', commence_time: iso(START), away_team: GAMES[1].awayName, home_team: GAMES[1].homeName }]);
    if (/\/events\/gamea\/odds/.test(url)) {
      return J({ bookmakers: ['draftkings', 'fanduel'].map((key) => ({ key, markets: [{
        key: 'batter_hits_runs_rbis',
        outcomes: [{ name: 'Over', description: hitter(1, 0), point: 1.5, price: -110 }, { name: 'Under', description: hitter(1, 0), point: 1.5, price: -110 }],
      }] })) });
    }
    return J({ bookmakers: [] });
  }
  if (url.includes('statsapi.mlb.com')) return J({});
  return realFetch(u, o);
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const logged = [];
const db = {
  prepare: (sql) => { const st = { sql, args: [], bind: (...a) => { st.args = a; return st; }, run: async () => ({ meta: { changes: 0 } }), first: async () => null, all: async () => ({ results: [] }) }; return st; },
  batch: async (l) => { for (const x of (l || [])) if (/INSERT OR IGNORE INTO bpicks/i.test(x.sql)) logged.push(x); return []; },
};
const pending = [];
const res = await mod.default.fetch(new Request('https://x/api/batters'), { ODDS_API_KEY: 'k', DB: db }, { waitUntil: (pr) => pending.push(pr) });
await Promise.all(pending);
const rows = (await res.json()).rows || [];

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const row = (gi, side) => rows.find((r) => r.team === GAMES[gi][side ? 'home' : 'away']);
const proj = (r, metric) => r && ((r.batterMarkets || []).find((m) => m.metric === metric) || {}).proj;

const hi = row(0, 0), lo = row(1, 0), none = row(2, 0);
console.log(`rows ${rows.length}`);
console.log(`  LAD (fav, total 11): implied ${hi && hi.impliedRuns}  x${hi && hi.impliedRunsAdj}  HRR ${proj(hi, 'hrr')}  TB ${proj(hi, 'tb')}`);
console.log(`  ATH (dog, total 7):  implied ${lo && lo.impliedRuns}  x${lo && lo.impliedRunsAdj}  HRR ${proj(lo, 'hrr')}  TB ${proj(lo, 'tb')}`);
console.log(`  SEA (no line):       implied ${none && none.impliedRuns}  x${none && none.impliedRunsAdj}  HRR ${proj(none, 'hrr')}  TB ${proj(none, 'tb')}\n`);

ok(hi && lo && none, 'all three identical hitters are on the board');
ok(hi && hi.impliedRuns > 5.5 && lo && lo.impliedRuns < 2.8,
  `implied runs split the total by the moneyline (${hi && hi.impliedRuns} of 11, ${lo && lo.impliedRuns} of 7)`);
ok(proj(hi, 'hrr') > proj(none, 'hrr') && proj(none, 'hrr') > proj(lo, 'hrr'),
  'H+R+RBI projects highest for the high-scoring club, lowest for the low-scoring one');
const expected = Math.min(1.30, Math.sqrt(hi.impliedRuns / 4.17)) / Math.max(0.75, Math.sqrt(lo.impliedRuns / 4.17));
const got = proj(hi, 'hrr') / proj(lo, 'hrr');
ok(Math.abs(got / expected - 1) < 0.03, `by the fitted strength, beta 0.5 with its clamps (ratio ${got.toFixed(3)} vs ${expected.toFixed(3)})`);
ok(proj(hi, 'tb') === proj(lo, 'tb') && proj(lo, 'tb') === proj(none, 'tb'),
  `Total Bases does not move (${proj(hi, 'tb')}, ${proj(lo, 'tb')}, ${proj(none, 'tb')})`);
ok(none.impliedRuns === null && none.impliedRunsAdj === 1,
  'no line posted -> neutral, exactly like every other missing input');
ok(hi.impliedRunsAdj <= 1.30 && lo.impliedRunsAdj >= 0.75, 'the multiplier stays inside its clamps');

// Logged at entry, so the betting effect can be measured directly next time
// rather than reconstructed from ESPN.
const ins = logged.find((x) => /impl_runs/.test(x.sql));
const cols = ins ? ins.sql.match(/\(([^)]*)\)/)[1].split(',').map((c) => c.trim()) : [];
const at = ins ? ins.args[cols.indexOf('impl_runs')] : undefined;
ok(!!ins && lo && Math.abs(at - lo.impliedRuns) < 0.01,
  `the logged pick carries its implied team runs (${at} for the ${lo && lo.impliedRuns} on the board)`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
