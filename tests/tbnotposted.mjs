// Total bases is priced and logged, never posted (2026-10-11, the owner's call).
//
// 685 posted total-bases unders went 330-355, -80.8u (-11.8%), while H+R+RBI
// unders held near 54% over 3,300. So a total-bases under keeps its price, its
// edge and its log row, but its tier is 'pass' -- which is what keeps it out of
// the posted record -- and the tier it would have had rides along as tierWas.
// And a row's headline goes to a posted market: an H+R+RBI play leads its row
// even where the total-bases edge is bigger.
//
// The fixture is tests/impliedruns.mjs's: identical hitters, one priced game.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const START = NOW + 5 * 3600e3;
const GAMES = [
  { away: 'ATH', home: 'TB', awayName: 'Athletics', homeName: 'Tampa Bay Rays', total: 7, awayML: '+240', homeML: '-290' },
];
const teamId = (gi, side) => 700 + gi * 2 + side;
const games = GAMES.map((g, i) => ({
  gamePk: 950000 + i, gameDate: iso(START), status: { abstractGameState: 'Preview' }, venue: { name: 'Neutral Park' },
  teams: {
    away: { team: { id: teamId(i, 0), abbreviation: g.away, name: g.awayName }, probablePitcher: { id: 8800 + i * 2, fullName: `Arm ${i}a` } },
    home: { team: { id: teamId(i, 1), abbreviation: g.home, name: g.homeName }, probablePitcher: { id: 8801 + i * 2, fullName: `Arm ${i}h` } },
  },
}));
const hitter = (side) => `${GAMES[0][side ? 'home' : 'away']} Bat`;
const statSplits = [0, 1].map((side) => ({
  player: { id: 900000 + side, fullName: hitter(side) },
  team: { id: teamId(0, side), abbreviation: GAMES[0][side ? 'home' : 'away'] },
  stat: { gamesPlayed: 140, plateAppearances: 600, atBats: 540, hits: 150, runs: 80, rbi: 75, homeRuns: 20, totalBases: 250, strikeOuts: 120, baseOnBalls: 55, avg: '.278', slg: '.463' },
}));
const espnBoard = { content: { sbData: { events: GAMES.map((g, i) => ({
  id: String(990000 + i), date: iso(START),
  competitions: [{ competitors: [{ homeAway: 'away', team: { abbreviation: g.away } }, { homeAway: 'home', team: { abbreviation: g.home } }],
    odds: [{ overUnder: g.total, moneyline: { away: { close: { odds: g.awayML } }, home: { close: { odds: g.homeML } } } }] }],
})) } } };
// Both markets on the away hitter. Scenario prices are set per run.
let prices = null;
const ou = (key, line, over, under) => ({ key, outcomes: [{ name: 'Over', description: hitter(0), point: line, price: over }, { name: 'Under', description: hitter(0), point: line, price: under }] });
globalThis.fetch = async (u) => {
  const url = String(u);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('/schedule?')) return J({ dates: [{ games }] });
  if (url.includes('/stats?stats=season') && url.includes('group=hitting')) return J({ stats: [{ splits: statSplits }] });
  if (url.includes('/people?')) {
    const ids = decodeURIComponent((url.match(/personIds=([^&]*)/) || [])[1] || '');
    return J({ people: ids.split(',').filter(Boolean).map((id) => ({ id: Number(id), fullName: 'Arm ' + id, pitchHand: { code: 'R' },
      stats: [{ splits: [{ stat: { battersFaced: 600, hits: 150, homeRuns: 18, doubles: 30, triples: 3, runs: 70 } }] }] })) });
  }
  if (url.includes('cdn.espn.com')) return J(espnBoard);
  if (url.includes('api.the-odds-api.com')) {
    if (/\/events\?/.test(url)) return J([{ id: 'gamea', commence_time: iso(START), away_team: GAMES[0].awayName, home_team: GAMES[0].homeName }]);
    if (/\/events\/gamea\/odds/.test(url)) return J({ bookmakers: ['draftkings', 'fanduel'].map((key) => ({ key, markets: prices })) });
    return J({ bookmakers: [] });
  }
  return J({});
};
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
async function board() {
  const logged = [];
  const db = {
    prepare: (sql) => { const st = { sql, args: [], bind: (...a) => { st.args = a; return st; }, run: async () => ({ meta: { changes: 0 } }), first: async () => null, all: async () => ({ results: [] }) }; return st; },
    batch: async (l) => { for (const x of (l || [])) if (/INSERT OR IGNORE INTO bpicks/i.test(x.sql)) logged.push(x); return []; },
  };
  const pending = [];
  const res = await mod.default.fetch(new Request('https://x/api/batters?cb=' + Math.random()), { ODDS_API_KEY: 'k', DB: db }, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  const rows = (await res.json()).rows || [];
  const row = rows.find((r) => r.team === GAMES[0].away);
  const cols = (x) => x.sql.match(/\(([^)]*)\)/)[1].split(',').map((c) => c.trim());
  const log = logged.map((x) => { const c = cols(x); return { market: x.args[c.indexOf('market')], side: x.args[c.indexOf('side')], tier: x.args[c.indexOf('tier')] }; });
  return { row, log, mk: (m) => (row && row.batterMarkets || []).find((x) => x.metric === m) || {} };
}

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// 1. A total-bases under with the bigger edge beside an H+R+RBI under that is a play.
prices = [ou('batter_total_bases', 1.5, -180, 150), ou('batter_hits_runs_rbis', 1.5, -140, 120)];
const a = await board();
console.log(`  row: ${a.row && a.row.pick} (${a.row && a.row.tier}); TB ${a.mk('tb').side} edge ${a.mk('tb').edge} tier ${a.mk('tb').tier} was ${a.mk('tb').tierWas}; HRR ${a.mk('hrr').side} edge ${a.mk('hrr').edge} tier ${a.mk('hrr').tier}`);
ok(a.mk('tb').side === 'Under' && a.mk('tb').edge > a.mk('hrr').edge && a.mk('hrr').tier !== 'pass',
  'the fixture: a total-bases under with the bigger edge, an H+R+RBI under that is a play');
ok(a.mk('tb').tier === 'pass' && a.mk('tb').tierWas && a.mk('tb').tierWas !== 'pass',
  `total bases is not posted, and carries what it would have been (${a.mk('tb').tierWas})`);
ok(a.row && /H\+R\+RBI/.test(a.row.pick) && a.row.tier !== 'pass', `the row leads with the posted market (${a.row && a.row.pick})`);
const tbLog = a.log.find((l) => l.market === 'tb' && l.side === 'Under');
ok(tbLog && tbLog.tier === 'pass', `and total bases still logs, as pass, which keeps it out of the posted record (${tbLog && tbLog.tier})`);
ok(a.log.some((l) => l.market === 'hrr' && l.tier !== 'pass'), 'while the H+R+RBI play logs as one');

// 2. Total bases is the only priced under: the row is not a play.
prices = [ou('batter_total_bases', 1.5, -180, 150)];
const b = await board();
console.log(`  row: ${b.row && b.row.pick} (${b.row && b.row.tier})`);
ok(b.row && b.row.tier === 'pass' && /TB/.test(b.row.pick), 'with only a total-bases under priced, the row shows it and posts nothing');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
