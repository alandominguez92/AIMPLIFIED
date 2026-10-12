// The moneyline log keeps the pick as it stood, not only as it ended.
//
// Until 2026-10-11 every read overwrote win_prob, edge and tier with the
// latest, while entry_price stayed the first: the log compared close-time
// chances with morning prices, so the edge a play had when it was shown, and
// its closing-line value, could not be read back (the improvement analysis's
// "gap at entry" table was built on exactly that mix). Now:
//   entry_*  the first read, written once
//   posted_* the first read at a posted tier (1-3), written once
//   close_at when the latest read was taken
// and the latest-read columns still move, as before.
//
// Real SQLite (node:sqlite) under the board; the fixture is tests/mlcheck.mjs's.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
function exec(sql, args, mode) {
  const st = sq.prepare(sql); const a = args.map(norm);
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

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const START = NOW + 5 * 3600e3;
const CLUBS = [
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
// Read 1: game 0 has a small gap to Pinnacle on the dog (a posted tier); game 1
// prices DK/FD level with Pinnacle (a pass).
// Read 2: game 0's DK price shortens toward Pinnacle; game 1's dog drifts out,
// opening a small gap -- a pass at first sight, posted at the second.
let books = null;
const READ1 = [
  [['pinnacle', -150, 140], ['draftkings', -155, 155], ['fanduel', -160, 150]],
  [['pinnacle', -150, 140], ['draftkings', -160, 135], ['fanduel', -162, 134]],
];
const READ2 = [
  [['pinnacle', -150, 140], ['draftkings', -155, 143], ['fanduel', -160, 141]],
  [['pinnacle', -150, 140], ['draftkings', -155, 155], ['fanduel', -160, 150]],
];
globalThis.fetch = async (u) => {
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
  if (url.includes('api.the-odds-api.com')) {
    if (!/markets=h2h/.test(url)) return J([]);
    return J(CLUBS.map(([a, h], i) => ({ id: 'e' + i, commence_time: iso(START), home_team: h[2], away_team: a[2],
      bookmakers: books[i].map(([k, hp, ap]) => h2h(k, h[2], a[2], hp, ap)) })));
  }
  return J({});
};
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
async function read(b) {
  books = b;
  try { sq.prepare('DELETE FROM feed_cache').run(); } catch (e) { /* first read: no table yet */ }
  const held = [];
  const rows = await (await mod.default.fetch(new Request('https://x/api/board?cb=' + Math.random()), { ODDS_API_KEY: 'k', DB }, { waitUntil: (p) => held.push(p) })).json();
  await Promise.allSettled(held);
  return rows;
}

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const show = (r) => r && `${r.team} tier ${r.tier}/${r.entry_tier}/${r.posted_tier} edge ${r.edge}/${r.entry_edge}/${r.posted_edge} price ${r.close_price}/${r.entry_price}/${r.posted_price}`;
const row = (gi) => sq.prepare('SELECT * FROM mlpicks WHERE game_id = ?').get('g' + (980001 + gi));

const b1 = await read(READ1);
const r0 = row(0), r1 = row(1);
console.log('  read 1: ' + show(r0) + ' | ' + show(r1));
ok(r0 && r0.entry_at && r0.entry_win_prob === r0.win_prob && r0.entry_edge === r0.edge && r0.entry_tier === r0.tier && r0.entry_fair_source === r0.fair_source,
  'the first read is kept beside the latest: chance, edge, tier and fair source');
ok(r0 && ['1', '2', '3'].includes(r0.tier) && r0.posted_at && r0.posted_price === r0.entry_price && r0.posted_edge === r0.edge,
  `a play posted at first sight is snapshotted as posted (tier ${r0 && r0.tier})`);
ok(r1 && r1.tier === 'pass' && r1.posted_at == null, 'a pass is not');

const b2 = await read(READ2);
const s0 = row(0), s1 = row(1);
console.log('  read 2: ' + show(s0) + ' | ' + show(s1));
ok(s0.close_price !== r0.close_price && s0.edge !== r0.edge, 'the latest read still moves the close price and the edge, as before');
ok(s0.entry_edge === r0.entry_edge && s0.entry_win_prob === r0.entry_win_prob && s0.entry_tier === r0.entry_tier && s0.entry_at === r0.entry_at,
  'while the first read stays as it was');
ok(s0.posted_at === r0.posted_at && s0.posted_price === r0.posted_price && s0.posted_edge === r0.posted_edge,
  'and so does the play as it was posted');
ok(s0.close_at && s0.close_at >= r0.close_at, 'the latest read says when it was taken');
ok(s1.entry_tier === 'pass' && ['1', '2', '3'].includes(s1.tier) && s1.posted_at && s1.posted_price === s1.close_price && s1.posted_tier === s1.tier,
  `a pass that becomes a play is snapshotted when it first posts, with the price it posted at (${s1.posted_tier} at ${s1.posted_price})`);

// The close's fair number, unrounded (2026-10-12). win_prob is rounded to a
// whole point, which at even money moves EV against the close by up to ~1%:
// too coarse to read a median of -1.5%. The same read now keeps the chosen
// side's fair to 4 dp and which book it came from.
const g0 = (b2 || []).find((g) => g.id === 'g980001');
const fp = g0 && g0.ml && g0.ml.fairProb;
ok(typeof fp === 'number' && Math.round(fp * 10000) === fp * 10000 && Math.round(fp * 100) === g0.ml.winProb,
  `the board's moneyline carries the pick's unrounded fair (${fp} beside ${g0 && g0.ml && g0.ml.winProb}%)`);
ok(s0.close_fair === fp && s0.close_fair_source === 'pinnacle',
  `the close read logs it with its source (${s0.close_fair} ${s0.close_fair_source})`);
const implied = (p) => (p < 0 ? -p / (-p + 100) : 100 / (p + 100));
ok(Math.abs(s0.close_fair * 100 - s0.win_prob) <= 0.5 && Math.abs(s0.close_fair - (s0.edge / 100 + implied(s0.close_price))) < 0.0006,
  'and it is the number the same read took its edge and price from');

const ex = await (await mod.default.fetch(new Request('https://x/api/mlpicks-export'), { DB }, { waitUntil() {} })).json();
ok(ex && ex.cols.includes('posted_edge') && ex.cols.includes('entry_at') && ex.cols.includes('close_at'), 'the export carries the new columns');
ok(ex && ex.cols.includes('close_fair') && ex.cols.includes('close_fair_source'), 'and the close fair');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
