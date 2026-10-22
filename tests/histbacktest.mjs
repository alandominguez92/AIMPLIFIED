// Last season's moneylines, read back (2026-10-22).
//
// /api/hist-backtest?job=nhl|nba|uel&run=1 reads one past snapshot of the
// sharp books' h2h prices per 2025-26 game day (10 credits each), finds each
// game's fair favourite the way the live boards do, and grades it from the
// free scores; without run=1 it reports what has been read. What has to hold:
//   - the scores are read first, and a day with no games buys nothing
//   - the snapshot is the job's hour (16:00 UTC for NHL and NBA), or an hour
//     before the first kickoff of a Europa League match day
//   - the fair line is the median Shin de-vig of two or more sharp books, else
//     Pinnacle alone, labelled; one non-Pinnacle book is no line at all
//   - hockey's h2h includes overtime and the shootout (the final score carries
//     the deciding goal); soccer's is the 1X2, and a draw loses for either side
//   - it continues where it stopped, stops at its credit cap, and is never
//     served from the edge cache (each run moves on)
//
// The scores are real (tests/fixtures/hist-scores-2025.json: the NHL's feed for
// opening night 2025 and the night after, two shootouts among them; ESPN's
// NBA opening nights; ESPN's first Europa League match day, two draws among
// them). The odds snapshots are the v4 historical shape ({timestamp, data:
// [events]}, each event the /odds shape) -- the key exists only as a Worker
// secret -- with the odds feed's club names. Real SQLite, the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const SCORES = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'hist-scores-2025.json'), 'utf8'));

const book = (key, home, away, hp, ap, dp) => ({ key, title: key, last_update: '2025-10-07T15:59:00Z',
  markets: [{ key: 'h2h', outcomes: [{ name: home, price: hp }, { name: away, price: ap }, ...(dp != null ? [{ name: 'Draw', price: dp }] : [])] }] });
const ev = (id, commence, home, away, quotes) => ({ id, commence_time: commence, home_team: home, away_team: away,
  bookmakers: Object.entries(quotes).map(([k, q]) => book(k, home, away, ...q)) });
const pool = (h, a, d) => ({ pinnacle: [h, a, d], lowvig: [h, a, d], novig: [h, a, d] });
const SNAP = {
  // 2025-10-07, 16:00 UTC: three games that night, and one two days out.
  'icehockey_nhl|2025-10-07T16:00:00Z': [
    ev('n1', '2025-10-07T23:00:00Z', 'Florida Panthers', 'Chicago Blackhawks', pool(-170, 145)),
    ev('n2', '2025-10-08T00:00:00Z', 'New York Rangers', 'Pittsburgh Penguins', pool(-140, 120)),
    ev('n3', '2025-10-08T02:30:00Z', 'Los Angeles Kings', 'Colorado Avalanche', { novig: [110, -130] }),      // one book: no line
    ev('n9', '2025-10-09T23:00:00Z', 'Boston Bruins', 'Washington Capitals', pool(-120, 100)),               // two days out
  ],
  'icehockey_nhl|2025-10-08T16:00:00Z': [
    ev('n4', '2025-10-08T23:00:00Z', 'Toronto Maple Leafs', 'Montréal Canadiens', pool(-240, 200)),
    ev('n5', '2025-10-08T23:30:00Z', 'Washington Capitals', 'Boston Bruins', { pinnacle: [-130, 110] }),     // Pinnacle alone
    ev('n6', '2025-10-09T02:00:00Z', 'Edmonton Oilers', 'Calgary Flames', pool(-205, 172)),
    ev('n7', '2025-10-09T02:30:00Z', 'Vegas Golden Knights', 'Los Angeles Kings', pool(-150, 128)),
  ],
  'basketball_nba|2025-10-21T16:00:00Z': [
    ev('b1', '2025-10-21T23:30:00Z', 'Oklahoma City Thunder', 'Houston Rockets', pool(-260, 215)),
    ev('b2', '2025-10-22T02:00:00Z', 'Los Angeles Lakers', 'Golden State Warriors', pool(-120, 100)),
  ],
  'basketball_nba|2025-10-22T16:00:00Z': [
    ev('b3', '2025-10-22T23:00:00Z', 'New York Knicks', 'Cleveland Cavaliers', pool(-130, 110)),
    ev('b4', '2025-10-23T02:00:00Z', 'Utah Jazz', 'LA Clippers', pool(250, -310)),
  ],
  // Europa League match day 1, read an hour before its 16:45 UTC kickoffs.
  'soccer_uefa_europa_league|2025-09-24T15:45:00Z': [
    ev('u1', '2025-09-24T16:45:00Z', 'FC Midtjylland', 'Sturm Graz', pool(-150, 380, 300)),
    ev('u2', '2025-09-24T19:00:00Z', 'PAOK', 'Maccabi Tel Aviv', pool(-180, 450, 320)),
    ev('u3', '2025-09-24T19:00:00Z', 'Real Betis', 'Nottingham Forest', pool(-110, 300, 260)),
    ev('u4', '2025-09-24T19:00:00Z', 'Nice', 'AS Roma', pool(260, 105, 250)),
  ],
};
const calls = [];
let spent = 0;
globalThis.fetch = async (u) => {
  const url = String(u);
  const J = (x, h) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json', ...(h || {}) } });
  if (url.includes('api.the-odds-api.com')) {
    calls.push(url);
    const q = new URL(url);
    const sport = q.pathname.split('/')[4];
    const data = SNAP[`${sport}|${q.searchParams.get('date')}`] || [];
    spent += 10;
    return J({ timestamp: q.searchParams.get('date'), data }, { 'x-requests-last': '10', 'x-requests-remaining': String(90000 - spent) });
  }
  if (SCORES[url]) return J(SCORES[url]);
  if (url.startsWith('https://api-web.nhle.com/v1/score/')) return J({ games: [] });
  if (url.startsWith('https://cdn.espn.com/core/')) return J({ content: { sbData: { events: [] } } });
  return new Response('{}', { status: 404 });
};

const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
function exec(sql, args, mode) {
  const st = sq.prepare(sql);
  const a = args.map(norm);
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
const env = { ODDS_API_KEY: 'k', DB };
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const get = async (u) => { const r = await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} }); return { cc: r.headers.get('cache-control'), body: await r.json() }; };
const row = (job, id) => sq.prepare('SELECT * FROM histml WHERE job = ? AND event_id = ?').get(job, id) || {};

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

console.log('-- NHL --');
let r = await get('/api/hist-backtest?job=nhl&run=1');
let d = r.body;
const nhlCalls = calls.filter((u) => u.includes('icehockey_nhl'));
ok(nhlCalls.length === 2 && d.progress === '20 of 192 days' && d.creditsSpent === 20,
  `twenty days scanned in a run, two with games: two snapshots, 20 credits (${nhlCalls.length} calls, ${d.progress}, ${d.creditsSpent})`);
const q = new URL(nhlCalls[0]).searchParams;
ok(new URL(nhlCalls[0]).pathname === '/v4/historical/sports/icehockey_nhl/odds' && q.get('date') === '2025-10-07T16:00:00Z' && q.get('markets') === 'h2h'
  && q.get('bookmakers').split(',').length <= 10, 'the historical h2h snapshot at 16:00 UTC, ten books or fewer (one region)');
ok(r.cc === 'no-store', 'never cached: each run moves on');
ok(row('nhl', 'n1').won === 1 && row('nhl', 'n1').fav_side === 'home' && row('nhl', 'n1').fair_src === 'sharp-pool' && row('nhl', 'n1').fav_p > 60,
  `Panthers ${row('nhl', 'n1').fav_p}% beat the Blackhawks 3-2: a win`);
ok(row('nhl', 'n2').won === 0, 'the Rangers lost 0-3 at home to the Penguins: a loss');
ok(!row('nhl', 'n3').event_id && !row('nhl', 'n9').event_id, 'one non-Pinnacle book is no line, and a game two days out waits for its own day');
ok(row('nhl', 'n5').fair_src === 'pinnacle' && row('nhl', 'n5').sharp_n === 1 && row('nhl', 'n5').won === 0, 'Pinnacle alone is used and labelled: the Capitals lost 1-3 to the Bruins');
ok(row('nhl', 'n6').won === 0 && row('nhl', 'n6').home_score === 3 && row('nhl', 'n6').away_score === 4,
  'the Oilers lost in a shootout, 3-4 with the deciding goal: the favourite lost');
ok(row('nhl', 'n4').won === 1 && row('nhl', 'n4').fav_p >= 65, `the Maple Leafs at ${row('nhl', 'n4').fav_p}% won 5-2`);
const b65 = d.report.at65;
ok(b65.n === 2 && b65.won === 1, `65%+ favourites: the Leafs won, the Oilers lost (${b65.won} of ${b65.n}, stated ${b65.stated}%)`);
ok(d.report.byBand.reduce((a, x) => a + x.n, 0) === d.report.games && d.report.games === 6, 'every graded game sits in one band (six graded)');

// The next run continues from day 21. At the cap it stops, and a finished job
// spends nothing.
sq.prepare("UPDATE feed_cache SET data = json_set(data, '$.credits', 2195) WHERE key = 'hist_job:nhl'").run();
SNAP['icehockey_nhl|2025-10-30T16:00:00Z'] = SNAP['icehockey_nhl|2025-10-07T16:00:00Z'];
SCORES['https://api-web.nhle.com/v1/score/2025-10-30'] = SCORES['https://api-web.nhle.com/v1/score/2025-10-07'];
r = await get('/api/hist-backtest?job=nhl&run=1');
const afterCap = calls.length;
ok(calls.filter((u) => u.includes('icehockey_nhl')).length === 3 && /date=2025-10-30T16/.test(calls[calls.length - 1]),
  'the next run continues from day 21, and buys only the day with games (Oct 30)');
ok(r.body.done === true && r.body.creditsSpent === 2205, `it stops at its cap (${r.body.creditsSpent} of ${r.body.cap}, done ${r.body.done})`);
r = await get('/api/hist-backtest?job=nhl&run=1');
ok(calls.length === afterCap && r.body.done === true, 'and a finished job buys nothing more');
r = await get('/api/hist-backtest?job=nhl');
ok(r.body.report && r.body.report.games >= 6 && !r.body.ran, 'without run=1 it only reports');

console.log('\n-- NBA --');
r = await get('/api/hist-backtest?job=nba&run=1');
ok(row('nba', 'b1').won === 1 && row('nba', 'b1').fav_p >= 70, `the Thunder (${row('nba', 'b1').fav_p}%) beat the Rockets 125-124`);
ok(row('nba', 'b2').won === 0 && row('nba', 'b4').won === 0 && row('nba', 'b4').fav_side === 'away',
  'the Lakers lost to the Warriors, and the Clippers, away favourites, lost 108-129 at Utah ("LA Clippers" on both feeds)');
ok(row('nba', 'b3').won === 1, 'the Knicks beat the Cavaliers');

console.log('\n-- Europa League --');
r = await get('/api/hist-backtest?job=uel&run=1');
const uq = calls.find((u) => u.includes('soccer_uefa_europa_league'));
ok(uq && new URL(uq).searchParams.get('date') === '2025-09-24T15:45:00Z', `read an hour before the first kickoff (${uq && new URL(uq).searchParams.get('date')})`);
ok(row('uel', 'u1').won === 1, 'FC Midtjylland beat Sturm Graz 2-0 ("Sturm Graz" is ESPN\'s "SK Sturm Graz")');
ok(row('uel', 'u2').won === 0 && row('uel', 'u2').home_score === 0 && row('uel', 'u2').away_score === 0, 'PAOK drew 0-0: a draw loses for the favourite');
ok(row('uel', 'u3').won === 0, 'Real Betis drew 2-2 with Forest: a loss');
ok(row('uel', 'u4').fav_side === 'away' && row('uel', 'u4').won === 1, 'Roma, away favourites, won 2-1 at Nice');
const p1 = row('uel', 'u1').fav_p;
ok(p1 > 50 && p1 < 62, `the 1X2 is de-vigged three ways: Midtjylland at -150 with the draw at +300 is ${p1}%, not a two-way 60%`);

console.log('\n-- guard --');
r = await get('/api/hist-backtest?job=mlb&run=1');
ok(/job is one of nhl, nba, uel/.test(r.body.error || ''), 'only the three jobs exist');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
