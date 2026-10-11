// The moneyline posts nothing (ML_POST_BAND null, 2026-10-11), and the track
// record carries the two cuts that say why.
//
// 879 graded rows: CLV against our own close falls with the size of the gap to
// Pinnacle at entry — gaps of 1-2.5 beat the close 18% of the time, 4+ beat it
// 28% at -3.5 pts. The old Tier 3 (1-2.5) read +14% ROI on 30 bets while its
// line moved against it on 23 of 28. So: sharp-priced gaps are check or pass,
// model-fair rows are lean, nothing is 1/2/3, and /api/track-record exposes
// byFairSource and byGapBand with median CLV so re-opening the band is a read
// off the page rather than an argument.
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
  console.log(`  ${label.padEnd(11)} pick ${m.pick}  edge ${m.edge}  tier ${m.tier}  kind ${m.edgeKind}  source ${m.fairSource}`);
}
console.log('');

const ranked = (t) => ['1', '2', '3'].includes(String(t));
ok(/const ML_POST_BAND = null;/.test(src), 'the posting band is closed in source (ML_POST_BAND = null)');
ok(trap.fairSource === 'pinnacle' && trap.tier === 'check', `a 2.5+ gap to Pinnacle is still "check" (tier ${trap.tier})`);
ok(ordinary.fairSource === 'pinnacle' && ordinary.edge > 0 && ordinary.edge < 2.5 && ordinary.tier === 'pass',
  `a small gap to Pinnacle is pass, not Tier 3 (edge ${ordinary.edge}, tier ${ordinary.tier})`);
ok(model.fairSource === 'dkfd' && model.tier === 'lean', `a model-fair row (no Pinnacle) is lean, never ranked (tier ${model.tier})`);
ok(![trap, ordinary, model].some((m) => ranked(m.tier)), 'nothing on the board carries a numeric moneyline tier');
ok(ordinary.edge != null && model.edge != null, 'the edge number itself still shows — it is context, not hidden');

// The record: the headline counts posted tiers only, so lean and pass rows stay
// out of it; the cuts count every graded row and carry median CLV.
const logRows = [
  // entry -> close moves: pinnacle gap 1-2.5 lengthens, gap <0 shortens, dkfd lean lengthens.
  { date: '2026-10-01', game_id: 'g1', team: 'LAD', tier: '3',    win_prob: 58, edge: 1.8,  entry_price: -130, close_price: -120, result: 'win',  model_ver: 'ml-shin-check25', fair_source: 'pinnacle' },
  { date: '2026-10-02', game_id: 'g2', team: 'SF',  tier: '3',    win_prob: 44, edge: 1.2,  entry_price: 150,  close_price: 165,  result: 'loss', model_ver: 'ml-shin-check25', fair_source: 'pinnacle' },
  { date: '2026-10-03', game_id: 'g3', team: 'BOS', tier: 'pass', win_prob: 55, edge: -0.8, entry_price: -125, close_price: -135, result: 'win',  model_ver: 'ml-shin-nopost',  fair_source: 'pinnacle' },
  { date: '2026-10-04', game_id: 'g4', team: 'NYM', tier: 'lean', win_prob: 52, edge: 3.1,  entry_price: -110, close_price: 100,  result: 'win',  model_ver: 'ml-shin-nopost',  fair_source: 'dkfd' },
  { date: '2026-10-05', game_id: 'g5', team: 'CHC', tier: 'check', win_prob: 40, edge: 4.4, entry_price: 180,  close_price: 200,  result: 'loss', model_ver: 'ml-shin-nopost',  fair_source: 'pinnacle' },
];
const db = { prepare: () => ({ bind: () => ({ run: async () => ({ meta: { changes: 1 } }), first: async () => null, all: async () => ({ results: logRows }) }),
  run: async () => ({ meta: { changes: 1 } }), first: async () => null, all: async () => ({ results: logRows }) }), batch: async () => [] };
const tr = await (await mod.default.fetch(new Request('https://x/api/track-record'), { DB: db }, { waitUntil() {} })).json();
const ml = tr.ml || {};
console.log(`  headline ${ml.record} (${ml.tracked} tracked)  posting ${JSON.stringify(ml.posting)}\n`);

ok(ml.tracked === 2 && ml.record === '1–1', `the headline counts the two rows stamped Tier 3 and nothing else (${ml.record}, ${ml.tracked} tracked)`);
ok(ml.posting && ml.posting.band === null, 'the record says the posting band is closed');
const src1 = (ml.byFairSource || []).find((s) => s.fairSource === 'pinnacle');
const src2 = (ml.byFairSource || []).find((s) => s.fairSource === 'dkfd');
ok(src1 && src1.n === 4 && src2 && src2.n === 1, `byFairSource counts every graded row: pinnacle ${src1 && src1.n}, dkfd ${src2 && src2.n}`);
const band = Object.fromEntries((ml.byGapBand || []).map((b) => [b.band, b]));
ok(band['1 to 2.5'] && band['1 to 2.5'].n === 2 && band['1 to 2.5'].clvBeatRate === 0 && band['1 to 2.5'].medianCLVpts < 0,
  `the 1-2.5 band shows its lines moving against it (beat ${band['1 to 2.5'] && band['1 to 2.5'].clvBeatRate}%, median ${band['1 to 2.5'] && band['1 to 2.5'].medianCLVpts} pts)`);
ok(band['below 0'] && band['below 0'].n === 1 && band['below 0'].clvBeatRate === 100, 'the pass rows are the control group and are counted');
ok((ml.byGapBand || []).reduce((s, b) => s + b.n, 0) === 4, 'gap bands cover sharp-priced rows only — the dkfd lean row is not in them');
ok(band['4 and up'] && band['4 and up'].n === 1, 'check rows are graded into their band');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
