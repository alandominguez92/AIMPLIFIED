// The NBA moneyline is recorded: captured on the cron, logged, and graded.
//
// Started 2026-10-03 with the first preseason game. The coverage probe that day
// found the moneyline and nothing else (Pinnacle, DraftKings, FanDuel and
// BetRivers on h2h; no book on any player prop), so this is the NFL log's
// shape: the side the sharp books rate likelier to win, at the best price.
//
// The parts that would be wrong quietly:
//   - preseason has one sharp book. Holding it to the two-book rule logs
//     nothing at all; Pinnacle alone is the fallback, and labelled as such.
//   - ESPN's NBA scoreboard ignores ?dates= and answers with tonight's game,
//     exactly as soccer's does. Only ?date= returns the day asked for.
//   - ESPN writes "LA Clippers"; the odds feed writes "Los Angeles Clippers".
//   - preseason plays neutral sites, and the feeds can disagree on "home".
// The ESPN side is two recorded days (tests/fixtures/espn-nba-2025100{4,9}.json),
// not an invented payload: stubs written from assumption let four bugs through.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = path.join(BOARD, 'tests', 'fixtures');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const HOUR = 3600e3;
const RealDate = Date;
let NOW = RealDate.parse('2026-10-03T09:00:00Z');   // Saturday 2 AM Pacific
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const iso = (ms) => new RealDate(ms).toISOString();

// ---- the odds feed ------------------------------------------------------------------------
const TIP_MIA = '2026-10-03T23:00:00Z';                // Heat at Raptors, 4 PM Pacific
const TIP_LAC = '2026-10-04T02:00:00Z';                // 7 PM Pacific, same day
const TIP_DEN = '2026-10-04T23:00:00Z';                // 38h out: outside the window
const TIP_NOSHARP = '2026-10-04T00:00:00Z';
const book = (key, home, away, hp, ap) => ({ key, title: key, markets: [{ key: 'h2h',
  outcomes: [{ name: home, price: hp }, { name: away, price: ap }] }] });
let execMia = { draftkings: [-145, 122], fanduel: [-140, 118], betrivers: [-150, 125] };
const preEvents = () => [
  { id: 'n1', sport_key: 'basketball_nba_preseason', commence_time: TIP_MIA, home_team: 'Toronto Raptors', away_team: 'Miami Heat',
    // Pinnacle is the only sharp book, as it was on the day.
    bookmakers: [book('pinnacle', 'Toronto Raptors', 'Miami Heat', -150, 130),
      ...Object.entries(execMia).map(([k, [h, a]]) => book(k, 'Toronto Raptors', 'Miami Heat', h, a))] },
  { id: 'n2', sport_key: 'basketball_nba_preseason', commence_time: TIP_LAC, home_team: 'Golden State Warriors', away_team: 'Los Angeles Clippers',
    bookmakers: [book('pinnacle', 'Golden State Warriors', 'Los Angeles Clippers', 120, -140),
      book('lowvig', 'Golden State Warriors', 'Los Angeles Clippers', 118, -136),
      book('betonlineag', 'Golden State Warriors', 'Los Angeles Clippers', 122, -142),
      book('draftkings', 'Golden State Warriors', 'Los Angeles Clippers', 115, -135),
      book('fanduel', 'Golden State Warriors', 'Los Angeles Clippers', 112, -130)] },
  { id: 'n3', sport_key: 'basketball_nba_preseason', commence_time: TIP_NOSHARP, home_team: 'Utah Jazz', away_team: 'Phoenix Suns',
    bookmakers: [book('draftkings', 'Utah Jazz', 'Phoenix Suns', -110, -110), book('fanduel', 'Utah Jazz', 'Phoenix Suns', -112, -108)] },
  { id: 'n4', sport_key: 'basketball_nba_preseason', commence_time: TIP_DEN, home_team: 'Denver Nuggets', away_team: 'Utah Jazz',
    bookmakers: [book('pinnacle', 'Denver Nuggets', 'Utah Jazz', -300, 250), book('draftkings', 'Denver Nuggets', 'Utah Jazz', -290, 240)] },
];
const regEvents = () => [{ id: 'r1', sport_key: 'basketball_nba', commence_time: '2026-10-20T23:30:00Z', home_team: 'New York Knicks', away_team: 'Boston Celtics', bookmakers: [] }];

// ---- ESPN, as ESPN actually answers -------------------------------------------------------
const ESPN_DAYS = {
  20251004: JSON.parse(fs.readFileSync(path.join(FIX, 'espn-nba-20251004.json'), 'utf8')),
  20251009: JSON.parse(fs.readFileSync(path.join(FIX, 'espn-nba-20251009.json'), 'utf8')),
};
// What ?dates= really returns: tonight's game, whatever day was asked for.
const TONIGHT = { content: { sbData: { events: [{ id: '999', date: TIP_MIA, status: { type: { name: 'STATUS_SCHEDULED' } },
  competitions: [{ competitors: [
    { homeAway: 'home', score: '0', team: { displayName: 'Toronto Raptors', abbreviation: 'TOR' } },
    { homeAway: 'away', score: '0', team: { displayName: 'Miami Heat', abbreviation: 'MIA' } }] }] }] } } };

let oddsCalls = [], espnCalls = [];
globalThis.fetch = async (u) => {
  const url = String(u);
  const J = (x, h) => new Response(JSON.stringify(x), { status: 200,
    headers: { 'content-type': 'application/json', 'x-requests-remaining': '99000', 'x-requests-last': '1', ...(h || {}) } });
  if (url.includes('api.the-odds-api.com')) {
    oddsCalls.push(url);
    const m = new URL(url).pathname.match(/^\/v4\/sports\/([a-z_]+)\/(odds|events)$/);
    if (m && m[1] === 'basketball_nba_preseason') {
      const evs = preEvents();
      return J(m[2] === 'events' ? evs.map(({ bookmakers, ...e }) => e) : evs, m[2] === 'events' ? { 'x-requests-last': '0' } : {});
    }
    if (m && m[1] === 'basketball_nba') return J(m[2] === 'events' ? regEvents().map(({ bookmakers, ...e }) => e) : regEvents());
    return J([]);
  }
  if (url.includes('cdn.espn.com')) {
    espnCalls.push(url);
    const q = new URL(url).searchParams;
    if (/\/nba\/scoreboard/.test(url)) {
      if (!q.get('date')) return J(TONIGHT);                 // ?dates= is ignored
      return J(ESPN_DAYS[q.get('date')] || { content: { sbData: { events: [] } } });
    }
    return J({ content: { sbData: { events: [] } } });
  }
  return new Response('{}', { status: 404 });
};

// ---- D1 stub ---------------------------------------------------------------------------------
const gm = new Map();
const cache = new Map();
const gmKey = (a) => `${a[0]}|${a[1]}|${a[2]}|${a[3] || 'h2h'}`;
const run = (sql, a) => {
  if (/^\s*INSERT OR IGNORE INTO gmpicks/i.test(sql)) {
    const c = ['sport', 'date', 'game_id', 'market', 'league', 'week', 'commence', 'side', 'point', 'pick', 'home', 'away', 'win_prob', 'implied', 'edge', 'entry_price', 'close_price', 'book', 'fair_src', 'sharp_n', 'model_ver'];
    const row = Object.fromEntries(c.map((k, i) => [k, a[i]]));
    const k = gmKey([row.sport, row.date, row.game_id, row.market]);
    if (!gm.has(k)) gm.set(k, { ...row, result: null, home_score: null, away_score: null });
  } else if (/^\s*UPDATE gmpicks SET close_price/i.test(sql)) {
    const [cp, edge, wp, imp, sport, date, gid, mkt, side] = a;
    const r = gm.get(gmKey([sport, date, gid, mkt]));
    if (r && r.side === side) { r.close_price = cp; r.edge = edge; r.win_prob = wp; r.implied = imp; }
  } else if (/^\s*UPDATE gmpicks SET result=\?, home_score=\?, away_score=\?/i.test(sql)) {
    const [res, hs, as, sport, date, gid, mkt] = a;
    const r = gm.get(gmKey([sport, date, gid, mkt])); if (r) { r.result = res; r.home_score = hs; r.away_score = as; }
  } else if (/^INSERT OR IGNORE INTO feed_cache/i.test(sql)) {
    if (!cache.has(a[0])) cache.set(a[0], { data: null, updated_at: 0 });
  } else if (/^INSERT OR REPLACE INTO feed_cache/i.test(sql)) {
    cache.set(a[0], { data: a[1], updated_at: a[2] });
  }
  return { meta: { changes: 1 } };
};
const db = {
  prepare: (sql) => {
    const st = { sql, args: [], bind: (...x) => { st.args = x; return st; },
      run: async () => run(sql, st.args),
      first: async () => {
        if (/FROM feed_cache WHERE key=\?/i.test(sql)) {
          const c = cache.get(st.args[0]);
          return c && c.data ? { data: c.data, updated_at: c.updated_at } : null;
        }
        return null;
      },
      all: async () => {
        if (/FROM gmpicks/i.test(sql)) {
          let rs = [...gm.values()];
          if (/result IS NULL/i.test(sql)) rs = rs.filter((r) => r.result == null && r.date < st.args[0]);
          return { results: rs };
        }
        return { results: [] };
      } };
    return st;
  },
  batch: async (l) => (l || []).map((x) => run(x.sql, x.args)),
};
const env = { ODDS_API_KEY: 'k', DB: db };

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const tick = async () => { const held = []; await mod.default.scheduled({}, env, { waitUntil: (p) => held.push(p) }); await Promise.allSettled(held); };
const hit = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();
const nbaOdds = () => oddsCalls.filter((u) => /basketball_nba(_preseason)?\/odds/.test(u));

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// ---- capture ---------------------------------------------------------------------------------
console.log('-- the cron captures the preseason moneyline, once --');
await tick();
const paid = nbaOdds();
ok(paid.length === 1 && /basketball_nba_preseason\/odds/.test(paid[0]),
  `one paid call, for the league with a game inside 36h (${paid.map((u) => new URL(u).pathname).join(', ')})`);
const q = paid[0] ? new URL(paid[0]).searchParams : new URLSearchParams();
ok(q.get('markets') === 'h2h' && q.get('bookmakers').split(',').length <= 10,
  `h2h only, from ten or fewer named books — one credit (${q.get('markets')}, ${q.get('bookmakers') && q.get('bookmakers').split(',').length} books)`);
ok(oddsCalls.some((u) => /basketball_nba\/events/.test(u)) && !oddsCalls.some((u) => /basketball_nba\/odds/.test(u)),
  'the regular season is asked (free) and, with nothing inside the window, not bought');

const rows = [...gm.values()].filter((r) => r.sport === 'nba');
console.log('  logged: ' + rows.map((r) => `${r.pick} ${r.win_prob}% @ ${r.entry_price} ${r.book} (${r.fair_src}/${r.sharp_n})`).join(' | '));
const mia = rows.find((r) => r.game_id === 'n1');
ok(mia && mia.side === 'home' && mia.pick === 'Toronto Raptors',
  `Heat-Raptors logs Pinnacle's favourite, Toronto (${mia && mia.pick})`);
ok(mia && mia.fair_src === 'pinnacle' && mia.sharp_n === 1,
  `on Pinnacle alone, labelled as such — the two-book rule would have logged nothing (${mia && mia.fair_src}/${mia && mia.sharp_n})`);
ok(mia && mia.entry_price === -140 && mia.book === 'fanduel',
  `at the best price that could be taken, never Pinnacle's (${mia && mia.entry_price} ${mia && mia.book})`);
ok(mia && mia.date === '2026-10-03' && mia.league === 'pre' && (mia.market || 'h2h') === 'h2h',
  `dated by its own tip, Pacific, and filed as preseason (${mia && mia.date}, ${mia && mia.league})`);
const lac = rows.find((r) => r.game_id === 'n2');
ok(lac && lac.fair_src === 'sharp-pool' && lac.sharp_n === 3 && lac.pick === 'Los Angeles Clippers' && lac.entry_price === -130,
  `with two or more sharp books it is the pooled fair (${lac && lac.fair_src}/${lac && lac.sharp_n}, ${lac && lac.pick} ${lac && lac.entry_price})`);
ok(!rows.some((r) => r.game_id === 'n3'), 'a game no sharp book prices logs nothing');
ok(!rows.some((r) => r.game_id === 'n4'), 'and a game outside the 36h window waits for its own day');

console.log('\n-- the next tick buys nothing; the close is bought near tip --');
await tick();
ok(nbaOdds().length === 1, `five minutes later: no second purchase (${nbaOdds().length} total)`);
NOW = RealDate.parse('2026-10-03T21:00:00Z');                      // 2h before the Heat-Raptors tip
execMia = { draftkings: [-160, 135], fanduel: [-155, 130], betrivers: [-165, 138] };
await tick();
ok(nbaOdds().length === 2, `inside 3h of a tip, the close is captured (${nbaOdds().length} total)`);
const miaClose = [...gm.values()].find((r) => r.game_id === 'n1');
ok(miaClose && miaClose.entry_price === -140 && miaClose.close_price === -155,
  `the entry stands and the close moves (${miaClose && miaClose.entry_price} -> ${miaClose && miaClose.close_price})`);
await tick();
ok(nbaOdds().length === 2, 'and two a day is the cap');

// ---- grade -----------------------------------------------------------------------------------
console.log('\n-- graded off the recorded ESPN days --');
const seed = (id, date, home, away, side) => gm.set(gmKey(['nba', date, id, 'h2h']), {
  sport: 'nba', date, game_id: id, market: 'h2h', league: 'pre', week: null, commence: `${date}T23:00:00Z`,
  side, point: null, pick: side === 'home' ? home : away, home, away, win_prob: 60, implied: 58, edge: 2,
  entry_price: -140, close_price: -140, book: 'fanduel', fair_src: 'pinnacle', sharp_n: 1,
  result: null, home_score: null, away_score: null, model_ver: 'gm-v1' });
// Abu Dhabi: ESPN lists the 76ers at home. Logged the other way round here.
seed('g_nyk', '2025-10-04', 'New York Knicks', 'Philadelphia 76ers', 'home');
seed('g_mia', '2025-10-04', 'Miami Heat', 'Orlando Magic', 'home');
seed('g_lac', '2025-10-09', 'Los Angeles Clippers', 'Guangzhou Loong-Lions', 'home');
seed('g_none', '2025-10-04', 'Boston Celtics', 'Utah Jazz', 'home');
// A passing-TD row in the same table, which this grader must leave alone.
gm.set(gmKey(['nflptd', '2025-10-04', 'q1', 'pass_tds']), { sport: 'nflptd', date: '2025-10-04', game_id: 'q1', market: 'pass_tds',
  league: 'REG', week: 4, pick: 'Some Arm under 1.5', side: 'under', point: 1.5, result: null });
espnCalls = [];
cache.clear();
const tr = await hit('/api/track-record');
const g = (id) => [...gm.values()].find((r) => r.game_id === id) || {};
ok(g('g_nyk').result === 'win' && g('g_nyk').home_score === 113 && g('g_nyk').away_score === 104,
  `a neutral-site game logged "the other way round" is found, and the score stored our way (${g('g_nyk').result} ${g('g_nyk').home_score}-${g('g_nyk').away_score})`);
ok(g('g_mia').result === 'loss', `Orlando won 126-118 at Miami: a loss for the Heat pick (${g('g_mia').result})`);
ok(g('g_lac').result === 'win' && g('g_lac').home_score === 142,
  `"Los Angeles Clippers" finds ESPN's "LA Clippers" (${g('g_lac').result} ${g('g_lac').home_score})`);
ok(g('g_none').result == null, 'a game not on the board stays pending, where it can be seen');
const nbaCalls = espnCalls.filter((u) => /\/nba\/scoreboard/.test(u));
ok(nbaCalls.length > 0 && nbaCalls.every((u) => /[?&]date=\d{8}/.test(u) && !/[?&]dates=/.test(u)),
  `asked with ?date=, the parameter ESPN honours (${nbaCalls.length} calls)`);
ok(!espnCalls.some((u) => /soccer\/scoreboard/.test(u)),
  'and a passing-TD row no longer sends the grader to the Premier League');

// ---- record ----------------------------------------------------------------------------------
const rec = tr.nbaMl || {};
console.log('  nbaMl: ' + JSON.stringify({ n: rec.n, record: rec.record, units: rec.units, pending: rec.pending, byLeague: rec.byLeague }));
ok(rec.n === 3 && rec.record === '2–1', `the NBA moneyline keeps its own record (${rec.record})`);
ok(rec.byLeague && rec.byLeague.pre && rec.byLeague.pre.n === 3 && !rec.byLeague.reg,
  'split by preseason and regular season, so the two are never read as one');
cache.clear();
const sum = await hit('/api/track-record?summary=1');
ok(sum.nbaMl && sum.nbaMl.record === '2–1' && sum.nbaMl.byLeague,
  'and the compact read a scheduled check uses carries it');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
