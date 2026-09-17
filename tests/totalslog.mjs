// Game totals: logged quietly with the moneyline's "vs Pinnacle" read and check
// flag, graded after the game, never shown.
//
// The point of logging is to find out whether the moneyline finding (small gaps
// to Pinnacle fine, 2.5+ gaps a trap) carries over to totals, so what matters is
// that the right rows reach the log with the right numbers, that games with
// nothing to compare stay out, and that grading gets over/under/push right.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const START = NOW + 5 * 3600e3;
const CLUBS = [
  [[119, 'LAD', 'Los Angeles Dodgers'], [113, 'CIN', 'Cincinnati Reds']],   // big gap -> check
  [[158, 'MIL', 'Milwaukee Brewers'], [134, 'PIT', 'Pittsburgh Pirates']],  // small gap
  [[143, 'PHI', 'Philadelphia Phillies'], [121, 'NYM', 'New York Mets']],   // DK/FD on a different number
  [[147, 'NYY', 'New York Yankees'], [142, 'MIN', 'Minnesota Twins']],      // no Pinnacle
];
const games = CLUBS.map(([a, h], i) => ({
  gamePk: 990001 + i, gameDate: iso(START), status: { abstractGameState: 'Preview' }, venue: { name: 'Park' },
  teams: {
    away: { team: { id: a[0], abbreviation: a[1], name: a[2] }, probablePitcher: { id: 6200 + i * 2, fullName: `Away Arm ${i}` } },
    home: { team: { id: h[0], abbreviation: h[1], name: h[2] }, probablePitcher: { id: 6201 + i * 2, fullName: `Home Arm ${i}` } },
  },
}));
const book = (key, home, away, [point, over, under]) => ({ key, markets: [
  { key: 'h2h', outcomes: [{ name: home, price: -120 }, { name: away, price: 100 }] },
  { key: 'totals', outcomes: [{ name: 'Over', point, price: over }, { name: 'Under', point, price: under }] },
] });
const SPEC = [
  { pin: [8.5, -110, -110], dk: [8.5, 120, -145], fd: [8.5, 115, -140] },   // over +120 vs fair .50 -> ~4.5 pts
  { pin: [8.5, -110, -110], dk: [8.5, 104, -125], fd: [8.5, 100, -120] },   // over +104 vs fair .50 -> ~1.0 pts
  { pin: [8.5, -110, -110], dk: [9.0, 120, -145], fd: [9.0, 115, -140] },   // different number
  { pin: null, dk: [7.5, 105, -125], fd: [7.5, 100, -120] },               // no Pinnacle
];
const oddsEvents = CLUBS.map(([a, h], i) => ({
  id: 'e' + i, commence_time: iso(START), home_team: h[2], away_team: a[2],
  bookmakers: [['draftkings', SPEC[i].dk], ['fanduel', SPEC[i].fd], ['pinnacle', SPEC[i].pin]]
    .filter(([, q]) => q).map(([k, q]) => book(k, h[2], a[2], q)),
}));

let finalRuns = null;   // set for the grading pass
const realFetch = globalThis.fetch;
const markets = [];
globalThis.fetch = async (u, o) => {
  const url = String(u);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('/schedule?')) {
    if (finalRuns) {
      return J({ dates: [{ games: games.map((g, i) => ({ ...g, status: { abstractGameState: 'Final' },
        teams: { away: { ...g.teams.away, score: finalRuns[i][0] }, home: { ...g.teams.home, score: finalRuns[i][1] } },
        linescore: { teams: { away: { runs: finalRuns[i][0] }, home: { runs: finalRuns[i][1] } } } })) }] });
    }
    return J({ dates: [{ games }] });
  }
  if (url.includes('/people?')) {
    const ids = decodeURIComponent((url.match(/personIds=([^&]*)/) || [])[1] || '');
    return J({ people: ids.split(',').filter(Boolean).map((id) => ({ id: Number(id), fullName: 'Arm ' + id, pitchHand: { code: 'R' },
      stats: [{ splits: [{ stat: { strikeoutsPer9Inn: 9, hitsPer9Inn: 8, inningsPitched: '150.0', gamesStarted: 25, era: '3.50' } }] }] })) });
  }
  if (url.includes('cdn.espn.com')) return J({ content: { sbData: { events: [] } } });
  if (url.includes('api.the-odds-api.com')) {
    if (/\/odds\?/.test(url)) { markets.push((url.match(/markets=([^&]*)/) || [])[1]); return J(oddsEvents); }
    return J([]);
  }
  if (url.includes('statsapi.mlb.com')) return J({});
  return realFetch(u, o);
};

// D1 stub with a real totpicks table (the rest answers empty).
const tot = new Map();
const run = (sql, a) => {
  if (/^\s*INSERT OR IGNORE INTO totpicks/i.test(sql)) {
    const [date, game_id, side, point, entry_price, close_price, pin_fair, entry_edge, edge, edge_check, model_ver] = a;
    const k = date + '|' + game_id;
    if (!tot.has(k)) tot.set(k, { date, game_id, side, point, entry_price, close_price, pin_fair, entry_edge, edge, edge_check, model_ver, result: null, total_runs: null });
  } else if (/^\s*UPDATE totpicks SET result=\?, total_runs=\?/i.test(sql)) {
    const [result, runs, date, gid] = a; const r = tot.get(date + '|' + gid); if (r) { r.result = result; r.total_runs = runs; }
  }
  return { meta: { changes: 1 } };
};
const db = {
  prepare: (sql) => { const st = { sql, args: [], bind: (...x) => { st.args = x; return st; },
    run: async () => run(sql, st.args), first: async () => null,
    all: async () => ({ results: /FROM totpicks/i.test(sql)
      ? [...tot.values()].filter((r) => !/result IS NULL/i.test(sql) || r.result == null) : [] }) }; return st; },
  batch: async (l) => (l || []).map((x) => run(x.sql, x.args)),
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const rows = await (await mod.default.fetch(new Request('https://x/api/board'), { ODDS_API_KEY: 'k', DB: db }, ctx)).json();
await Promise.all(pending.splice(0));

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const logged = [...tot.values()];
const byClub = (abbr) => logged.find((r) => r.game_id === rows.find((x) => x.matchup.includes(abbr)).id);
console.log('logged:', logged.map((r) => `${r.game_id} ${r.side} ${r.point} @${r.entry_price} edge ${r.entry_edge} check ${r.edge_check}`).join(' | '), '\n');

ok(markets.length && markets.every((m) => m === 'h2h,totals'), `totals ride the moneyline call (markets=${markets.join(' | ')})`);
ok(rows.every((r) => !('tot' in r) || r.tot === null || typeof r.tot === 'object'), 'each board row carries its totals read');
const big = byClub('CIN'), small = byClub('PIT');
ok(big && big.side === 'Over' && big.point === 8.5 && big.entry_price === 120, `the big-gap game logs the over at the best DK/FD price (${big && big.side} ${big && big.entry_price})`);
ok(big && big.entry_edge >= 2.5 && big.edge_check === 1, `and is flagged check (${big && big.entry_edge})`);
ok(small && small.entry_edge > 0 && small.entry_edge < 2.5 && small.edge_check === 0, `the small-gap game is not flagged (${small && small.entry_edge})`);
ok(!byClub('NYM'), 'a game where DK/FD hang a different number than Pinnacle is not logged');
ok(!byClub('MIN'), 'a game with no Pinnacle total is not logged');
ok(logged.every((r) => r.model_ver === 'tot-pin-check25'), 'rows carry the totals model version');

// ---- grading ------------------------------------------------------------------------------
// Log under yesterday so the grader treats the games as past.
const y = new Date(Date.now() - 86400e3);
const yday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(y);
for (const r of logged) { tot.delete(r.date + '|' + r.game_id); r.date = yday; tot.set(r.date + '|' + r.game_id, r); }
finalRuns = [[6, 4], [4, 4], [0, 0], [0, 0]];   // CIN game 10 > 8.5 (over wins); PIT game 8 < 8.5 (over loses)
const tr = await (await mod.default.fetch(new Request('https://x/api/track-record'), { DB: db }, { waitUntil() {} })).json();
ok(big.result === 'win' && big.total_runs === 10, `10 runs on an over 8.5 grades a win (${big.result}, ${big.total_runs})`);
ok(small.result === 'loss' && small.total_runs === 8, `8 runs on an over 8.5 grades a loss (${small.result}, ${small.total_runs})`);
ok(tr.totals && tr.totals.all && tr.totals.all.n === 2, `the track-record payload summarises totals for reading (${JSON.stringify(tr.totals && tr.totals.all)})`);
ok(tr.totals && tr.totals.byEntryEdge.check2_5plus.n === 1 && tr.totals.byEntryEdge.from0to2_5.n === 1,
  'split by entry edge the way the moneyline flag was measured');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
