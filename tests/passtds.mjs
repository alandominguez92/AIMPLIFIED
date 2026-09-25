// Passing touchdowns are measured, not projected.
//
// Passing YARDS is rejected and stays rejected: it failed its own premise in
// both backtested seasons (42.0% and 49.5% under-mean) because summing ~20
// completions flattens the right skew the model trades. Passing TDs is a
// different distribution — a count from 0 to 5 — and a different question.
//
// The line hangs at 1.5 and the book prices P(0 or 1) directly rather than
// setting a number near a skewed mean, so there is no gap for skew to hide in.
// Over 1,082 QB starts in 2024-25 the under landed 55.4% of the time (55.6% and
// 55.1% by season). The only question worth asking is whether the sharp pool
// prices that under cheaper than 55.4%. So: log the sharp fair and the best
// executable price, grade it, and report both against the baseline. Nothing is
// projected and nothing is posted.
//
// What this pins: the under is always the logged side (logging whichever side
// looked good would answer a question nobody asked and leave the baseline
// uncomparable), the fair comes from two or more sharp books, and the record
// says plainly when the market already has it priced.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const RealDate = Date;
const NOW = RealDate.parse('2026-09-22T19:00:00Z');   // Tuesday, noon Pacific
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const iso = (ms) => new RealDate(ms).toISOString();
const KICK = iso(NOW + 30 * 3600e3);
const ptDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new RealDate(ms));
const WEEK = 3;   // the real Week 3 fixtures below
// A second game three days later, same NFL week. One capture covers the whole
// week and a week is three slates, so this is the case that matters.
const KICK_SUN = iso(NOW + 4 * 24 * 3600e3);
const ODDS_EVENT_2 = { id: 'e2', commence_time: KICK_SUN, home_team: 'Buffalo Bills', away_team: 'Los Angeles Chargers' };
const SUN_QB = { name: 'Sunday Arm', sharpUnder: -120, sharpOver: 100, dkUnder: -118 };

// Two quarterbacks. CHEAP is priced under the realised rate, PRICED is above it.
// Three sharp books each, plus DK for execution.
const QBS = [
  { name: 'Michael Penix Jr.', sharpUnder: -118, sharpOver: -102, dkUnder: -115 },
  { name: 'Jordan Love',       sharpUnder: -150, sharpOver: +125, dkUnder: -145 },
];
const nflRows = [];
for (const qb of QBS) {
  for (const book of ['betonlineag', 'novig', 'prophetx', 'draftkings']) {
    const exec = book === 'draftkings';
    nflRows.push({
      event_id: 'e1', commence: KICK, home: 'Green Bay Packers', away: 'Atlanta Falcons',
      market: 'player_pass_tds', player: qb.name, point: 1.5, book,
      over: exec ? -105 : qb.sharpOver, under: exec ? qb.dkUnder : qb.sharpUnder,
      captured_at: iso(NOW - 3600e3), week: WEEK, season_type: 'REG',
    });
  }
}
for (const book of ['betonlineag', 'novig', 'prophetx', 'draftkings']) {
  const exec = book === 'draftkings';
  nflRows.push({
    event_id: 'e2', commence: KICK_SUN, home: 'Buffalo Bills', away: 'Los Angeles Chargers',
    market: 'player_pass_tds', player: SUN_QB.name, point: 1.5, book,
    over: exec ? -105 : SUN_QB.sharpOver, under: exec ? SUN_QB.dkUnder : SUN_QB.sharpUnder,
    captured_at: iso(NOW - 3600e3), week: WEEK, season_type: 'REG',
  });
}

// A receiving line in the same table, which must not end up in this log.
nflRows.push({ event_id: 'e1', commence: KICK, home: 'Green Bay Packers', away: 'Atlanta Falcons',
  market: 'player_reception_yds', player: 'Some Receiver', point: 64.5, book: 'draftkings',
  over: -110, under: -110, captured_at: iso(NOW - 3600e3), week: WEEK, season_type: 'REG' });

// ESPN, as ESPN actually returns it. Recorded 2026-09-25 from the Week 3
// Thursday game, Atlanta 35 at Green Bay 14, and trimmed to what the graders read.
//
// The first version of this test invented a scoreboard with passing leaders on
// each team, and the grader was written to read them there. The real payload
// hangs leaders on the competition and lists ONE passer per game — Jordan Love
// — so Penix never appeared and nothing graded, while this test passed. Stubs
// written from assumption have now let four of these through (soccer URLs,
// ESPN's ?dates=, the NFL week, this). Recorded responses cannot flatter the
// code they test.
const FIX = path.join(BOARD, 'tests', 'fixtures');
const ESPN_WEEK_REAL = JSON.parse(fs.readFileSync(path.join(FIX, 'espn-nfl-2026-wk3-scoreboard.json'), 'utf8'));
const ESPN_BOX_REAL = JSON.parse(fs.readFileSync(path.join(FIX, 'espn-nfl-boxscore-401872948.json'), 'utf8'));

// The Odds API side of the capture: one upcoming event, and the per-event prop
// odds the capture buys. player_pass_tds is bought HERE, by ingestNflProps —
// not by the game-line ingest — which is the thing this test exists to keep
// straight. Hooked onto the wrong function the readback queried a table with no
// passing row in it and logged nothing, silently, while still passing.
const ODDS_EVENT = { id: 'e1', commence_time: KICK, home_team: 'Green Bay Packers', away_team: 'Atlanta Falcons' };
const propBook = (bk, who) => ({
  key: bk,
  markets: [{
    key: 'player_pass_tds',
    outcomes: (who || QBS).flatMap((qb) => {
      const exec = bk === 'draftkings';
      return [
        { name: 'Over', description: qb.name, point: 1.5, price: exec ? -105 : qb.sharpOver },
        { name: 'Under', description: qb.name, point: 1.5, price: exec ? qb.dkUnder : qb.sharpUnder },
      ];
    }),
  }],
});

let espnCalls = [];
let oddsCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const url = String(u);
  const J = (x, h) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json', 'x-requests-remaining': '100', 'x-requests-last': '3', ...(h || {}) } });
  if (url.includes('cdn.espn.com')) {
    espnCalls.push(url);
    const q = new URL(url).searchParams;
    if (/\/boxscore/.test(url)) return J(q.get('gameId') === '401872948' ? ESPN_BOX_REAL : {});
    return J(q.get('week') === String(WEEK) ? ESPN_WEEK_REAL : { content: { sbData: { events: [] } } });
  }
  if (url.includes('api.the-odds-api.com')) {
    oddsCalls.push(url);
    if (/\/events\?/.test(url)) return J([ODDS_EVENT, ODDS_EVENT_2]);
    if (/\/events\/e1\/odds/.test(url)) {
      return J({ bookmakers: ['betonlineag', 'novig', 'prophetx', 'draftkings'].map((b) => propBook(b, QBS)) });
    }
    if (/\/events\/e2\/odds/.test(url)) {
      return J({ bookmakers: ['betonlineag', 'novig', 'prophetx', 'draftkings'].map((b) => propBook(b, [SUN_QB])) });
    }
    return J([]);
  }
  return realFetch(u, o);
};

// ---- D1 stub ---------------------------------------------------------------------------
const gm = new Map();
const key = (a) => `${a[0]}|${a[1]}|${a[2]}|${a[3] || 'h2h'}`;
const COLS = ['sport', 'date', 'game_id', 'market', 'league', 'week', 'commence', 'side', 'point', 'pick', 'home', 'away',
  'win_prob', 'implied', 'edge', 'entry_price', 'close_price', 'book', 'fair_src', 'sharp_n', 'model_ver'];
const run = (sql, a) => {
  if (/^\s*INSERT OR IGNORE INTO gmpicks/i.test(sql)) {
    const row = Object.fromEntries(COLS.map((k, i) => [k, a[i]]));
    const k = key([row.sport, row.date, row.game_id, row.market]);
    if (!gm.has(k)) gm.set(k, { ...row, result: null, home_score: null, away_score: null });
  } else if (/^\s*UPDATE gmpicks SET close_price/i.test(sql)) {
    const [cp, edge, wp, imp, sport, date, gid, mkt] = a;
    const r = gm.get(key([sport, date, gid, mkt])); if (r) { r.close_price = cp; r.edge = edge; r.win_prob = wp; r.implied = imp; }
  } else if (/^\s*UPDATE gmpicks SET result/i.test(sql)) {
    const [res, sc, date, gid, mkt] = a;
    const r = gm.get(key(['nflptd', date, gid, mkt])); if (r) { r.result = res; r.home_score = sc; }
  }
  return { meta: { changes: 1 } };
};
const db = {
  prepare: (sql) => {
    const st = { sql, args: [], bind: (...x) => { st.args = x; return st; },
      run: async () => run(sql, st.args),
      first: async () => (/COUNT\(\*\)/i.test(sql) ? { n: nflRows.length } : null),
      all: async () => {
        if (/FROM nfl_lines/i.test(sql)) {
          if (/player_pass_tds/.test(sql)) return { results: nflRows.filter((r) => r.market === 'player_pass_tds') };
          return { results: nflRows };
        }
        if (/FROM nfl_proj/i.test(sql)) return { results: [] };
        if (/FROM gmpicks/i.test(sql)) {
          let rs = [...gm.values()];
          if (/sport='nflptd'/.test(sql)) rs = rs.filter((r) => r.sport === 'nflptd');
          if (/result IS NULL/i.test(sql)) rs = rs.filter((r) => r.result == null && r.date < st.args[0]);
          return { results: rs };
        }
        return { results: [] };
      } };
    return st;
  },
  batch: async (l) => (l || []).map((x) => run(x.sql, x.args)),
};
const env = {
  ODDS_API_KEY: 'k', DB: db,
  // nflSchedule and the projection priors read off ASSETS. Neither matters to
  // the passing-TD log, but the capture will not run without them answering.
  ASSETS: { fetch: async (r) => {
    const name = new URL(r.url).pathname;
    const file = path.join(BOARD, name);
    if (!fs.existsSync(file)) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(fs.readFileSync(file, 'utf8'), { status: 200, headers: { 'content-type': 'application/json' } });
  } },
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const held = [];
const hit = async (u) => {
  const r = await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: (p) => held.push(p) });
  const j = await r.json();
  await Promise.allSettled(held.splice(0));
  return j;
};

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// ---- log -------------------------------------------------------------------------------
const cap = await hit('/api/nfl-capture');
console.log(`  capture: ${cap.wrote} line rows, ${cap.passTdsLogged} passing-TD rows logged`);
const logged = [...gm.values()];
console.log('  logged: ' + logged.map((r) => `${r.pick} fair ${r.win_prob}% @ ${r.entry_price} (${r.book}) edge ${r.edge}`).join(' | ') + '\n');

ok(logged.length === 3, `one row per quarterback quoted by two or more sharp books (${logged.length})`);
// One capture, one week, three slates. Dating every row from the first entry
// filed Sunday's quarterbacks under Thursday, which makes the per-day ranking
// in /api/top-legs read a whole week as a single day.
const thuDay = ptDay(RealDate.parse(KICK)), sunDay = ptDay(RealDate.parse(KICK_SUN));
const sun = logged.find((r) => /Sunday/.test(r.pick));
ok(thuDay !== sunDay && sun && sun.date === sunDay && logged.filter((r) => r.date === thuDay).length === 2,
  `each row is dated by its own kickoff, not by the first of the capture (${[...new Set(logged.map((r) => r.date))].sort().join(' + ')})`);
ok(logged.every((r) => r.sport === 'nflptd' && r.market === 'pass_tds'),
  'kept apart from the NFL moneyline record, which is about games');
ok(logged.every((r) => r.side === 'under' && r.point === 1.5),
  `always the under, always at 1.5 — the side the baseline is measured on (${logged.map((r) => r.side).join(',')})`);
ok(logged.every((r) => r.sharp_n >= 2 && r.win_prob > 0 && r.win_prob < 100),
  `each carries a sharp fair built from two or more books (${logged.map((r) => r.sharp_n + ':' + r.win_prob + '%').join(', ')})`);
ok(logged.every((r) => r.book === 'draftkings'),
  'priced at a number you could take, never at the sharp book');
ok(!logged.some((r) => /Receiver/.test(r.pick || '')),
  'a receiving line in the same table does not wander into this log');
ok(logged.every((r) => r.week === WEEK),
  `the week is stored, because the NFL scoreboard can only be asked by week (${logged.map((r) => r.week).join(',')})`);

// The edge is measured against the realised rate, not against a model.
const cheap = logged.find((r) => /Penix/.test(r.pick));
const priced = logged.find((r) => /Love/.test(r.pick));
ok(cheap && cheap.edge > 0 && priced && priced.edge < 0,
  `edge is the price against the 55.4% baseline: cheap ${cheap && cheap.edge}, priced ${priced && priced.edge}`);

// ---- grade -----------------------------------------------------------------------------
const yday = ptDay(NOW - 86400e3);
for (const r of [...gm.values()]) { gm.delete(key([r.sport, r.date, r.game_id, r.market])); r.date = yday; gm.set(key([r.sport, r.date, r.game_id, r.market]), r); }
const tr = await hit('/api/track-record');
console.log('\n  graded: ' + [...gm.values()].map((r) => `${r.pick} -> ${r.home_score} TD ${r.result}`).join(' | ') + '\n');

const g = (n) => [...gm.values()].find((r) => new RegExp(n).test(r.pick || ''));
ok(g('Penix').result === 'win' && g('Penix').home_score === 1,
  `Penix threw 1 against a 1.5 line — an under win (${g('Penix').result}, ${g('Penix').home_score} TD)`);
ok(g('Love').result === 'loss' && g('Love').home_score === 2,
  `Love threw 2 — a loss (${g('Love').result}, ${g('Love').home_score} TD)`);
// The specific failure: Penix is not the game's passing leader, so a grader that
// reads the scoreboard's leaders can never see him.
ok(g('Penix').result != null && espnCalls.some((u) => /boxscore\?xhr=1&gameId=401872948/.test(u)),
  'graded from the box score, which carries every passer — not from the leaders, which carry one');
const nflCalls = espnCalls.filter((u) => /\/nfl\/scoreboard/.test(u));
ok(nflCalls.length > 0 && nflCalls.every((u) => /week=/.test(u) && !/[?&]dates?=/.test(u)),
  `asked by week, never by date — the NFL scoreboard ignores a date entirely (${nflCalls.length} of ${espnCalls.length} calls)`);

// ---- report ----------------------------------------------------------------------------
const rec = tr.nflPassTds;
console.log('  record: ' + JSON.stringify({ n: rec && rec.n, record: rec && rec.record, baseline: rec && rec.baseline,
  sharpFairMean: rec && rec.sharpFairMean, verdict: rec && rec.verdict }) + '\n');
ok(!!rec && rec.baseline === 55.4, `the record names the baseline it is read against (${rec && rec.baseline}%)`);
ok(rec && rec.n === 2 && rec.record === '1–1', `and the graded result (${rec && rec.record})`);
ok(rec && rec.sharpFairMean != null && rec.bestPriceImpliedMean != null,
  `with what the sharp pool said and what the best price implied (${rec && rec.sharpFairMean}% vs ${rec && rec.bestPriceImpliedMean}%)`);
ok(rec && /priced|watch/.test(rec.verdict || ''),
  `and says in words whether the market already has it (${rec && rec.verdict})`);
ok(rec && /LOGGED ONLY/.test(rec.note || '') && /nothing posted/.test(rec.note || ''),
  'and that nothing here is posted');


// ---- rows the earlier dating bug filed twice ----------------------------------------------
// Before 2026-09-24 a capture dated every row from its first entry, so Sunday
// quarterbacks were also filed under Thursday. Those copies stay in the table —
// deleting production rows to tidy a record is not worth the risk — and the
// record keeps one per (game, player): the copy dated by its own kickoff.
const love = [...gm.values()].find((r) => /Love/.test(r.pick));
const twin = { ...love, date: '2026-09-20' };              // same game, wrong day
gm.set(key([twin.sport, twin.date, twin.game_id, twin.market]), twin);
const tr2 = await hit('/api/track-record');
ok(tr2.nflPassTds && tr2.nflPassTds.n === 2,
  `a row filed under the wrong day is not counted twice (${tr2.nflPassTds && tr2.nflPassTds.n} graded, 3 rows)`);
const tl = await hit('/api/top-legs?sport=nflptd');
ok(tl.graded === 2 && !tl.byDay.some((d) => d.date === '2026-09-20'),
  `and the per-day ranking does not grow a phantom day out of it (${tl.byDay.map((d) => d.date).join(', ')})`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exitCode = fail ? 1 : 0;
