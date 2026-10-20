// The NHL moneyline is recorded: captured on the cron, logged, graded (2026-10-20).
//
// The NBA log on another league. Shots on goal had no sharp fair line on the
// Oct 14 probe; the moneyline does. The Oct 20 probe (three games, per-event)
// found lowvig, betonlineag, Novig and ProphetX on every game, and DraftKings,
// FanDuel, BetMGM, BetRivers and Caesars too -- Pinnacle had not posted yet.
//
// The parts that would be wrong quietly:
//   - the fair line must come from the sharp books and the price from the
//     books being bet, never the other way round.
//   - h2h in hockey includes overtime and the shootout, so a row grades on the
//     final winner. A shootout winner's score carries the deciding goal.
//   - ESPN has no NHL scoreboard on the cdn host a Worker reaches (404), so
//     grading reads api-web.nhle.com/v1/score/{date}, one day per request.
//   - two clubs can meet on consecutive nights (Avalanche at Stars on Oct 13,
//     Stars at Avalanche on Oct 14), so a row is graded off its own day only.
//   - the odds feed writes "Montréal Canadiens" and "St Louis Blues"; the NHL
//     writes "Canadiens" and "Blues".
//
// The NHL side is three recorded days (tests/fixtures/nhle-score-2026-10-1{3,4}
// and -20, trimmed), served only for the exact URL. The Odds API side is NOT a
// recorded payload: the key exists only as a Worker secret. It is the v4 /odds
// shape as the-odds-api.com documents it (id, sport_key, commence_time,
// home_team, away_team, bookmakers[key,title,last_update,markets[key,
// outcomes[name,price]]]), the shape the NBA board has parsed in production
// since Oct 3, with the team spellings and books the Oct 14 and Oct 20
// production probes returned. Real SQLite underneath, like tests/entries.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = path.join(BOARD, 'tests', 'fixtures');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const RealDate = Date;
let NOW = RealDate.parse('2026-10-20T09:00:00Z');   // Tuesday 2 AM Pacific
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};

// ---- the odds feed, in the documented v4 shape ----------------------------------------------
const PUCK = '2026-10-20T23:00:00Z';                  // 4 PM Pacific, the slate's first wave
const book = (key, title, home, away, hp, ap) => ({ key, title, last_update: '2026-10-20T08:55:00Z',
  markets: [{ key: 'h2h', last_update: '2026-10-20T08:55:00Z', outcomes: [{ name: away, price: ap }, { name: home, price: hp }] }] });
const TITLES = { lowvig: 'LowVig.ag', betonlineag: 'BetOnline.ag', novig: 'Novig', prophetx: 'ProphetX', pinnacle: 'Pinnacle',
  draftkings: 'DraftKings', fanduel: 'FanDuel', betmgm: 'BetMGM', betrivers: 'BetRivers', williamhill_us: 'Caesars' };
const game = (id, commence, home, away, quotes) => ({ id, sport_key: 'icehockey_nhl', sport_title: 'NHL', commence_time: commence,
  home_team: home, away_team: away, bookmakers: Object.entries(quotes).map(([k, [h, a]]) => book(k, TITLES[k], home, away, h, a)) });
let mtlExec = { draftkings: [-155, 130], fanduel: [-160, 136], betmgm: [-150, 125], betrivers: [-165, 138], williamhill_us: [-158, 132] };
const oddsEvents = () => [
  // Four sharp books, no Pinnacle -- as the Oct 20 probe found. LowVig's -140 is
  // the best number on the board and must never be the price logged.
  game('e1', PUCK, 'Montréal Canadiens', 'San Jose Sharks',
    { lowvig: [-140, 120], betonlineag: [-152, 132], novig: [-145, 135], prophetx: [-148, 128], ...mtlExec }),
  game('e2', PUCK, 'New Jersey Devils', 'Colorado Avalanche',
    { lowvig: [118, -138], betonlineag: [120, -140], novig: [125, -135], prophetx: [122, -142],
      draftkings: [115, -135], fanduel: [112, -132], betmgm: [120, -145], williamhill_us: [118, -140] }),
  // One sharp book that is not Pinnacle: no fair line, so nothing is logged.
  game('e3', PUCK, 'New York Islanders', 'Anaheim Ducks',
    { novig: [-130, 115], draftkings: [-135, 114], fanduel: [-132, 112] }),
  // Pinnacle alone: the NBA preseason's fallback, labelled.
  game('e4', PUCK, 'Columbus Blue Jackets', 'Toronto Maple Leafs',
    { pinnacle: [105, -125], draftkings: [102, -122], fanduel: [100, -120] }),
  // Thursday's game, 39 hours out: waits for its own day.
  game('e5', '2026-10-22T00:00:00Z', 'Boston Bruins', 'Detroit Red Wings',
    { lowvig: [-200, 170], novig: [-195, 175], draftkings: [-205, 170] }),
];

// ---- the NHL's scores, as the league actually answers ----------------------------------------
const NHL_DAYS = Object.fromEntries(['2026-10-13', '2026-10-14', '2026-10-20']
  .map((d) => [d, JSON.parse(fs.readFileSync(path.join(FIX, `nhle-score-${d}.json`), 'utf8'))]));

let oddsCalls = [], nhlCalls = [], espnNhl = [];
globalThis.fetch = async (u) => {
  const url = String(u);
  const J = (x, h) => new Response(JSON.stringify(x), { status: 200,
    headers: { 'content-type': 'application/json', 'x-requests-remaining': '92944', 'x-requests-last': '1', ...(h || {}) } });
  if (url.includes('api.the-odds-api.com')) {
    oddsCalls.push(url);
    const m = new URL(url).pathname.match(/^\/v4\/sports\/([a-z_]+)\/(odds|events)$/);
    if (m && m[1] === 'icehockey_nhl') {
      const evs = oddsEvents();
      return m[2] === 'events' ? J(evs.map(({ bookmakers, ...e }) => e), { 'x-requests-last': '0' }) : J(evs);
    }
    return J([], { 'x-requests-last': '0' });
  }
  // Only the exact request the grader should make: one day, by path.
  const nhl = url.match(/^https:\/\/api-web\.nhle\.com\/v1\/score\/(\d{4}-\d{2}-\d{2})$/);
  if (nhl) { nhlCalls.push(nhl[1]); return NHL_DAYS[nhl[1]] ? J(NHL_DAYS[nhl[1]]) : new Response('{}', { status: 404 }); }
  if (url.includes('api-web.nhle.com')) { nhlCalls.push('BAD ' + url); return new Response('{}', { status: 404 }); }
  if (/cdn\.espn\.com\/core\/nhl\//.test(url)) { espnNhl.push(url); return new Response('{"status":404}', { status: 404 }); }
  return new Response('{}', { status: 404 });
};

// ---- D1 as SQLite ---------------------------------------------------------------------------
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
const tick = async () => { const held = []; await mod.default.scheduled({}, env, { waitUntil: (p) => held.push(p) }); await Promise.allSettled(held); };
const hit = async (u, init) => (await mod.default.fetch(new Request('https://x' + u, init), env, { waitUntil: () => {} })).json();
const nhlOdds = () => oddsCalls.filter((u) => /icehockey_nhl\/odds/.test(u));
const rowsOf = (sport) => { try { return sq.prepare('SELECT * FROM gmpicks WHERE sport = ? ORDER BY game_id').all(sport); } catch (e) { return []; } };

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// ---- capture ---------------------------------------------------------------------------------
console.log('-- the cron captures the NHL moneyline, once --');
await hit('/api/gmpicks-export');                    // the table, through the worker's own schema
await tick();
const evIdx = oddsCalls.findIndex((u) => /icehockey_nhl\/events/.test(u));
const paid = nhlOdds();
ok(paid.length === 1 && evIdx >= 0 && evIdx < oddsCalls.indexOf(paid[0]),
  `the free events list first, then one paid call (${paid.length} paid, events at ${evIdx})`);
const q = paid[0] ? new URL(paid[0]).searchParams : new URLSearchParams();
const books = (q.get('bookmakers') || '').split(',').filter(Boolean);
ok(q.get('markets') === 'h2h' && books.length > 0 && books.length <= 10,
  `h2h only, from ten or fewer named books -- one region, one credit (${q.get('markets')}, ${books.length} books)`);
const route = (r) => { try { return sq.prepare('SELECT credits, calls FROM odds_route WHERE route = ?').get(r) || {}; } catch (e) { return {}; } };
ok(route('nhl:reg:odds').calls === 1 && route('nhl:reg:odds').credits === 1 && route('nhl:reg:events').credits === 0,
  `the usage ledger books it to its own route: nhl:reg:odds ${JSON.stringify(route('nhl:reg:odds'))}, events ${JSON.stringify(route('nhl:reg:events'))}`);

const rows = rowsOf('nhl');
console.log('  logged: ' + rows.map((r) => `${r.pick} ${r.win_prob}% @ ${r.entry_price} ${r.book} (${r.fair_src}/${r.sharp_n})`).join(' | '));
const mtl = rows.find((r) => r.game_id === 'e1');
ok(mtl && mtl.side === 'home' && mtl.pick === 'Montréal Canadiens' && mtl.fair_src === 'sharp-pool' && mtl.sharp_n === 4,
  `Sharks at Canadiens logs the sharp pool's favourite, from four books (${mtl && mtl.pick}, ${mtl && mtl.fair_src}/${mtl && mtl.sharp_n})`);
ok(mtl && mtl.entry_price === -150 && mtl.book === 'betmgm',
  `at the best price a bettable book offers -- BetMGM -150, never LowVig's -140 (${mtl && mtl.entry_price} ${mtl && mtl.book})`);
ok(mtl && mtl.win_prob > 57 && mtl.win_prob < 60 && mtl.edge != null,
  `its chance is the de-vigged sharp fair, about 58% (${mtl && mtl.win_prob}%, edge ${mtl && mtl.edge})`);
ok(mtl && mtl.date === '2026-10-20' && mtl.league === 'reg' && mtl.market === 'h2h',
  `dated by its own puck drop, Pacific, under league 'reg', market h2h (${mtl && mtl.date}, ${mtl && mtl.league}, ${mtl && mtl.market})`);
const col = rows.find((r) => r.game_id === 'e2');
ok(col && col.side === 'away' && col.pick === 'Colorado Avalanche' && col.entry_price === -132 && col.book === 'fanduel',
  `an away favourite logs too, at its best price (${col && col.pick} ${col && col.entry_price} ${col && col.book})`);
const cbj = rows.find((r) => r.game_id === 'e4');
ok(cbj && cbj.fair_src === 'pinnacle' && cbj.sharp_n === 1 && cbj.pick === 'Toronto Maple Leafs',
  `Pinnacle alone is the labelled fallback (${cbj && cbj.fair_src}/${cbj && cbj.sharp_n}, ${cbj && cbj.pick})`);
ok(!rows.some((r) => r.game_id === 'e3'), 'one sharp book that is not Pinnacle is no fair line: nothing logged');
ok(!rows.some((r) => r.game_id === 'e5'), 'and a game outside the 36h window waits for its own day');
ok(rowsOf('nba').length === 0, 'none of it lands in the NBA log');

console.log('\n-- the next tick buys nothing; the close is bought near puck drop --');
await tick();
ok(nhlOdds().length === 1, `five minutes later: no second purchase (${nhlOdds().length} total)`);
NOW = RealDate.parse('2026-10-20T21:00:00Z');                 // two hours before puck drop
mtlExec = { draftkings: [-170, 145], fanduel: [-172, 150], betmgm: [-165, 140], betrivers: [-175, 150], williamhill_us: [-170, 145] };
await tick();
ok(nhlOdds().length === 2, `inside 3h of puck drop, the close is captured (${nhlOdds().length} total)`);
const mtlClose = rowsOf('nhl').find((r) => r.game_id === 'e1');
ok(mtlClose && mtlClose.entry_price === -150 && mtlClose.close_price === -165,
  `the entry stands and the close moves (${mtlClose && mtlClose.entry_price} -> ${mtlClose && mtlClose.close_price})`);
NOW = RealDate.parse('2026-10-20T22:30:00Z');
await tick();
ok(nhlOdds().length === 2, `and two a day is the cap (${nhlOdds().length} total)`);

// ---- the board ---------------------------------------------------------------------------
console.log('\n-- /api/nhl-board reads the captures --');
const before = oddsCalls.length;
const board = await hit('/api/nhl-board');
const bg = (id) => (board.games || []).find((x) => x.id === id) || {};
console.log('  board: ' + (board.games || []).map((x) => `${x.away}@${x.home} ${x.fairSrc} ${x.awayPrice}/${x.homePrice}`).join(' | '));
ok(bg('e1').pickSide === 'home' && bg('e1').homePrice === -165 && bg('e1').awayPrice === 150 && bg('e1').awayBook === 'fanduel',
  `Canadiens carry the fair and BOTH sides' best price from the latest capture (${bg('e1').homePrice} / ${bg('e1').awayPrice} ${bg('e1').awayBook})`);
ok(bg('e3').fairSrc === 'MKT' && bg('e3').pickSide == null && bg('e3').homePrice != null,
  'a game with no fair line is listed with its prices, not dropped');
ok(board.asOf === '2026-10-20T21:00:00.000Z' && (board.games || []).every((x) => Date.parse(x.commence) > Date.now()),
  `it says how old the prices are (${board.asOf}), and lists only games not yet started`);
ok(oddsCalls.length === before, `a read buys nothing (${oddsCalls.length - before} calls)`);
let nbaSnap = null;
try { nbaSnap = sq.prepare("SELECT key FROM feed_cache WHERE key LIKE 'nba_board:%'").all(); } catch (e) { nbaSnap = []; }
ok(nbaSnap.length === 0, 'and its snapshot is its own: no NBA board key was written');

// ---- grade -----------------------------------------------------------------------------------
console.log('\n-- graded off the recorded NHL days --');
const seed = sq.prepare(`INSERT INTO gmpicks (sport,date,game_id,market,league,commence,side,pick,home,away,win_prob,implied,edge,entry_price,close_price,book,fair_src,sharp_n,model_ver)
  VALUES ('nhl',?,?,'h2h','reg',?,?,?,?,?,?,55,2,-140,-140,'draftkings','sharp-pool',4,'gm-v1')`);
const S = (date, id, home, away, side, wp, t) => seed.run(date, id, `${t || date + 'T23:30:00Z'}`, side, side === 'home' ? home : away, home, away, wp);
S('2026-10-13', 'n90', 'Detroit Red Wings', 'New Jersey Devils', 'home', 62);      // Devils 5-4 in overtime
S('2026-10-13', 'n92', 'Montréal Canadiens', 'Buffalo Sabres', 'home', 66);        // Canadiens 4-3 in a shootout
S('2026-10-13', 'n94', 'Philadelphia Flyers', 'Seattle Kraken', 'home', 53);       // Kraken 3-2 in a shootout
S('2026-10-13', 'n96', 'Ottawa Senators', 'St Louis Blues', 'away', 68);           // Blues 7-2
S('2026-10-13', 'n100', 'Dallas Stars', 'Colorado Avalanche', 'away', 58);         // Avalanche 3-2 at Dallas
S('2026-10-13', 'n101', 'Nashville Predators', 'Vegas Golden Knights', 'away', 64); // Golden Knights 5-2
S('2026-10-13', 'n102', 'Utah Mammoth', 'Toronto Maple Leafs', 'home', 57, '2026-10-14T01:00:00Z');  // Mammoth 5-4, 6 PM Pacific
S('2026-10-14', 'n107', 'Colorado Avalanche', 'Dallas Stars', 'home', 67);         // the next night: Stars 3-2 in a shootout
// Ids are the odds feed's (hex in production): never a leading 'g', which the
// entry grader reads as the NFL's key form.
// Canadiens at Capitals was played on the 14th. Logged on the 13th, it must not
// be graded off the 14th's game.
S('2026-10-13', 'nX', 'Washington Capitals', 'Montréal Canadiens', 'home', 61);
// An NBA row in the same table goes to ESPN, not to the NHL.
sq.prepare(`INSERT INTO gmpicks (sport,date,game_id,market,league,commence,side,pick,home,away,win_prob,entry_price,close_price,model_ver)
  VALUES ('nba','2026-10-13','b1','h2h','pre','2026-10-13T23:00:00Z','home','Boston Celtics','Boston Celtics','Utah Jazz',60,-150,-150,'gm-v1')`).run();
nhlCalls = []; espnNhl = [];
NOW = RealDate.parse('2026-10-21T16:00:00Z');                // the next morning
const tr = await hit('/api/track-record');
const g = (id) => sq.prepare("SELECT * FROM gmpicks WHERE game_id = ?").get(id) || {};
ok(g('n90').result === 'loss' && g('n90').home_score === 4 && g('n90').away_score === 5,
  `Devils won 5-4 in overtime: the Red Wings pick loses -- overtime is in the price (${g('n90').result} ${g('n90').home_score}-${g('n90').away_score})`);
ok(g('n92').result === 'win' && g('n92').home_score === 4 && g('n92').away_score === 3,
  `"Montréal Canadiens" finds the NHL's "Canadiens", and a shootout win is a win (${g('n92').result} ${g('n92').home_score}-${g('n92').away_score})`);
ok(g('n94').result === 'loss', `the Kraken won the shootout at Philadelphia: the Flyers pick loses (${g('n94').result})`);
ok(g('n96').result === 'win' && g('n96').away_score === 7, `"St Louis Blues" finds "Blues" (${g('n96').result} ${g('n96').away_score})`);
ok(g('n101').result === 'win' && g('n102').result === 'win',
  `"Golden Knights" and "Mammoth" match too (${g('n101').result}, ${g('n102').result})`);
ok(g('n100').result === 'win' && g('n100').home_score === 2 && g('n100').away_score === 3,
  `Avalanche at Stars on the 13th: the Avalanche won 3-2 there (${g('n100').result} ${g('n100').home_score}-${g('n100').away_score})`);
ok(g('n107').result === 'loss' && g('n107').home_score === 2 && g('n107').away_score === 3,
  `and the same clubs the next night grade off that night: Stars won the shootout in Denver (${g('n107').result} ${g('n107').home_score}-${g('n107').away_score})`);
ok(g('nX').result == null, `a game not played on the row's day stays pending, rather than taking the next night's score (${g('nX').result})`);
ok(nhlCalls.length === 3 && ['2026-10-13', '2026-10-14', '2026-10-20'].every((d) => nhlCalls.includes(d)),
  `one request per day with rows, by path, and no other day (${nhlCalls.join(', ')})`);
ok(['e1', 'e2', 'e4'].every((id) => g(id).result == null),
  'last night as recorded before puck drop (every game FUT) grades nothing: those rows wait');
ok(espnNhl.length === 0, `and never ESPN's NHL scoreboard, which 404s (${espnNhl.length})`);
ok(g('b1').result == null, 'the NBA row is left to the NBA grader');

// ---- record ----------------------------------------------------------------------------------
console.log('\n-- the record, by band --');
const rec = tr.nhlMl || {};
const b65 = (rec.byBand || {})['65+'] || {};
console.log('  nhlMl: ' + JSON.stringify({ n: rec.n, record: rec.record, pending: rec.pending, byBand: rec.byBand }));
ok(rec.n === 8 && rec.record === '5–3', `the NHL moneyline keeps its own record (${rec.record}, n ${rec.n})`);
ok(b65.n === 3 && b65.record === '2–1' && b65.expected === 67,
  `65%+ favourites, the bar Picks of the day lists favourites at: 2-1 against 67% expected (${b65.record}, ${b65.expected})`);
ok(rec.byBand && rec.byBand['60-65'].record === '1–1' && rec.byBand['55-60'].record === '2–0' && rec.byBand['under 55'].record === '0–1',
  'and every band below it');
ok(/NHL \(api-web\.nhle\.com\)/.test(rec.note || ''), 'its note says where the finals come from');
sq.prepare("DELETE FROM feed_cache WHERE key = 'track-record:v1'").run();
const sum = await hit('/api/track-record?summary=1');
ok(sum.nhlMl && sum.nhlMl.record === '5–3' && sum.nhlMl.byBand && sum.nhlMl.byBand['65+'].record === '2–1',
  'the compact read a scheduled check uses carries it, bands included');
const nb = await hit('/api/nhl-board');
ok(nb.record && nb.record.n === 8 && nb.record.byBand['65+'].record === '2–1',
  `the NHL tab gets the same record (${nb.record && nb.record.record})`);

// ---- entries -------------------------------------------------------------------------------
// The tab's star puts an NHL moneyline on the slip, keyed by the odds feed's
// event id -- the id the log keeps -- so a logged entry grades from the log.
console.log('\n-- an NHL leg in an entry grades from the log --');
const KEY = 'local-test-key-0123456789abcdef';
const entries = async (method, body) => hit('/api/entries', { method,
  headers: { 'content-type': 'application/json', 'x-entry-key': KEY }, body: body ? JSON.stringify(body) : undefined });
await entries('GET');
const leg = (id, team, side, price) => ({ sport: 'nhl', date: '2026-10-13', gamePk: id, player: team, team: team.split(' ').pop(), market: 'ml', side, price });
const made = await entries('POST', { action: 'create', entry: { book: 'pp', kind: 'power', stake: 10,
  legs: [leg('n92', 'Montréal Canadiens', 'home', -150), leg('n96', 'St Louis Blues', 'away', -200)] } });
const lost = await entries('POST', { action: 'create', entry: { book: 'dk', kind: 'straight', stake: 10,
  legs: [leg('n94', 'Philadelphia Flyers', 'home', -110)] } });
await entries('GET');
const legsOf = (id) => sq.prepare('SELECT result, graded_by FROM entry_legs WHERE entry_id = ? ORDER BY idx').all(id);
const won = legsOf(made.id), lo = legsOf(lost.id);
ok(won.length === 2 && won.every((l) => l.result === 'win' && l.graded_by === 'auto'),
  `Canadiens and Blues legs win on their own (${won.map((l) => l.result).join(', ')})`);
ok(lo.length === 1 && lo[0].result === 'loss', `the Flyers leg loses (${lo.map((l) => l.result).join(', ')})`);
const settled = sq.prepare('SELECT status, payout FROM entries WHERE id = ?').get(made.id) || {};
ok(settled.status === 'settled' && settled.payout === 30, `and the 2-pick power settles at 3x (${settled.status}, ${settled.payout})`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
