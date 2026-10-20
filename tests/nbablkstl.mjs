// NBA PrizePicks blocks and steals (2026-10-20): captured, projected, logged
// and graded exactly as threes, assists and rebounds are -- and kept off Picks
// of the day until they have a graded record of their own.
//
// The two-season backtest (tools/nba-market-backtest.md) found blocks and
// steals the only Odds API markets whose under held up at a line set at the
// median of a player's last ten (62.8%, 57.9%). The user approved logging them
// at +2 credits a game.
//
// Real SQLite underneath (node:sqlite, as tests/nbapp.mjs). Real payloads:
//   - nba-priors.json, rebuilt from ESPN's 2025-26 season totals (blocks and
//     steals per game) and opening-night rosters
//   - ESPN's recorded box score for 401810437 (Spurs 119, Bucks 101: Wembanyama
//     2 blocks, Keldon Johnson 3 steals, Bismack Biyombo did-not-play) and that
//     day's recorded scoreboard, served for the night the captured game is
//     played. The fetch stub answers only the exact requests the cron should make.
//   - the Odds API payload is its per-event shape, as the 2026-10-20 probe of
//     BOS @ DET returned it: PrizePicks quotes player_steals two-sided at -137
//     a side, description = player, name = Over/Under. To be replaced by the
//     first capture's own payload (/api/nba-pp?raw=1) once one is recorded.
//
// What has to hold:
//   - the one paid call per game asks for blocks and steals with the other three
//   - a blocks or steals leg is projected from his recent games blended with
//     last season's rate, at the fitted dispersions (blocks 1.15, steals 1.1)
//   - the line is the point PrizePicks takes an under on: an over-only point
//     (a demon) listed first is not it
//   - graded from the box score; a player who did not play is void
//   - the NBA card shows them, with labels; Picks of the day does not, and its
//     NBA record is threes, assists and rebounds only
//   - the last payload is kept, free to read, under its own cache entry
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = path.join(BOARD, 'tests', 'fixtures');

// A working edge cache, keyed by URL as the Worker's is: ?raw=1 must not be
// answered with the board, or the board with the payload.
const edge = new Map();
globalThis.caches = { default: {
  match: async (req) => (edge.has(req.url) ? new Response(edge.get(req.url), { status: 200, headers: { 'content-type': 'application/json' } }) : undefined),
  put: async (req, res) => { edge.set(req.url, await res.text()); },
} };

const RealDate = Date;
let NOW = RealDate.parse('2026-10-22T19:00:00Z');        // Thursday noon Pacific
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const iso = (ms) => new RealDate(ms).toISOString();

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
const PRIORS = fs.readFileSync(path.join(BOARD, 'nba-priors.json'), 'utf8');
const priors = JSON.parse(PRIORS).players;
const prior = (name) => Object.entries(priors).find(([, p]) => p.n === name);
const env = { DB, ODDS_API_KEY: 'k', ASSETS: { fetch: async (r) => (new URL(r.url).pathname === '/nba-priors.json'
  ? new Response(PRIORS, { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('{}', { status: 404 })) } };

// ---- the feeds -----------------------------------------------------------------------------
const SCORE = fs.readFileSync(path.join(FIX, 'espn-nba-20260115.json'), 'utf8');
const BOX = fs.readFileSync(path.join(FIX, 'espn-nba-box-401810437.json'), 'utf8');
const finalOn = new Set();                     // the days ESPN has the recorded game final on
const TIP = iso(NOW + 3 * 3600e3);              // 3 PM Pacific, inside the four-hour window
const ODDS_URL = 'https://api.the-odds-api.com/v4/sports/basketball_nba/events/evSAMIL/odds?apiKey=k'
  + '&markets=player_threes,player_assists,player_rebounds,player_blocks,player_steals&oddsFormat=american&dateFormat=iso'
  + '&bookmakers=prizepicks,draftkings,fanduel';
const ou = (player, point, over = -137, under = -137) => [
  { name: 'Over', description: player, price: over, point }, { name: 'Under', description: player, price: under, point }];
const PAYLOAD = { id: 'evSAMIL', sport_key: 'basketball_nba', commence_time: TIP, home_team: 'San Antonio Spurs', away_team: 'Milwaukee Bucks', bookmakers: [
  { key: 'prizepicks', title: 'PrizePicks', markets: [
    { key: 'player_blocks', outcomes: [
      // A demon: over-only, listed ahead of the line PrizePicks takes an under on.
      { name: 'Over', description: 'Victor Wembanyama', price: 100, point: 4.5 },
      ...ou('Victor Wembanyama', 3.5), ...ou('Myles Turner', 1.5), ...ou('Keldon Johnson', 0.5), ...ou('Bismack Biyombo', 0.5)] },
    { key: 'player_steals', outcomes: [...ou('Keldon Johnson', 1.5), ...ou('Giannis Antetokounmpo', 1.5), ...ou('Ryan Rollins', 1.5)] },
    { key: 'player_threes', outcomes: ou('Stephon Castle', 2.5) },
  ] },
  { key: 'draftkings', title: 'DraftKings', markets: [
    { key: 'player_blocks', outcomes: ou('Victor Wembanyama', 3.5, -105, -125) },
    { key: 'player_steals', outcomes: ou('Keldon Johnson', 1.5, -140, 110) },
  ] },
] };
let paid = 0;
globalThis.fetch = async (u) => {
  const url = String(u);
  const J = (x, h) => new Response(typeof x === 'string' ? x : JSON.stringify(x), { status: 200,
    headers: { 'content-type': 'application/json', ...(h || {}) } });
  for (const d of finalOn) if (url === `https://cdn.espn.com/core/nba/scoreboard?xhr=1&date=${d}`) return J(SCORE);
  if (finalOn.size && url === 'https://cdn.espn.com/core/nba/boxscore?xhr=1&gameId=401810437') return J(BOX);
  if (url === ODDS_URL) { paid++; return J(PAYLOAD, { 'x-requests-last': '5', 'x-requests-remaining': '92000' }); }
  return new Response('{}', { status: 404 });
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const tick = async () => { const held = []; await mod.default.scheduled({}, env, { waitUntil: (p) => held.push(p) }); await Promise.allSettled(held); };
const hit = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const r1 = (x) => Math.round(x * 10) / 10;
// worker.js negBinomCdf, P(X <= k) at mean m, dispersion (variance / mean) phi.
const nbCdf = (k, m, phi) => {
  const r = m / (phi - 1), q = m / (r + m);
  let t = Math.pow(r / (r + m), r), s = t;
  for (let i = 1; i <= k; i++) { t *= (r + i - 1) / i * q; s += t; }
  return Math.min(1, s);
};

// ---- the priors ---------------------------------------------------------------------------
console.log('-- last season, per game --');
const withAvg = Object.values(priors).filter((p) => p.gp >= 5);
ok(withAvg.length > 500 && withAvg.every((p) => typeof p.blk === 'number' && typeof p.stl === 'number'),
  `every player with 5+ games last season has a blocks and a steals rate (${withAvg.filter((p) => typeof p.blk === 'number').length} of ${withAvg.length})`);
const [wembyId, wemby] = prior('Victor Wembanyama');
ok(wemby.blk === 3.08 && wemby.stl === 1.03, `from the season totals, to two places: Wembanyama ${wemby.blk} blocks, ${wemby.stl} steals a game (197 and 66 in 64)`);

// ---- capture, projection, log -----------------------------------------------------------
console.log('\n-- captured with the other three, projected, logged --');
await tick();                                            // tables made; no game is final yet
// One regular-season game each, the night before: these must feed the projection.
const [kjId] = prior('Keldon Johnson');
sq.prepare(`INSERT INTO nba_box (game_id, date, season_type, player_id, player, team, min, threes, ast, reb, blk, stl, starter, dnp)
  VALUES ('r1', '2026-10-21', 2, ?, 'Victor Wembanyama', 'SA', 32, 2, 3, 12, 5, 1, 1, 0),
         ('r1', '2026-10-21', 2, ?, 'Keldon Johnson', 'SA', 25, 1, 1, 6, 0, 2, 0, 0)`).run(wembyId, kjId);
sq.prepare('INSERT OR REPLACE INTO feed_cache (key, data, updated_at) VALUES (?, ?, ?)').run('nba_board:reg',
  JSON.stringify({ asOf: iso(NOW), games: [{ id: 'evSAMIL', league: 'reg', commence: TIP, home: 'San Antonio Spurs', away: 'Milwaukee Bucks' }] }), NOW);
await tick();
ok(paid === 1, `one paid call, asking for blocks and steals with threes, assists and rebounds (${paid})`);
const rows = sq.prepare('SELECT * FROM nbapp ORDER BY model_under DESC').all();
const leg = (p, m) => rows.find((l) => l.player === p && l.market === m) || {};
console.log('  logged: ' + rows.map((l) => `${l.player} ${l.market} u${l.point} proj ${l.proj} (${l.n_recent}) ${l.model_under}%`).join(' | '));
const wb = leg('Victor Wembanyama', 'blk');
const wbProj = (5 + 5 * wemby.blk) / (1 + 5);
ok(wb.point === 3.5, `the line is the one PrizePicks takes the under on, 3.5, not the over-only 4.5 listed first (${wb.point})`);
ok(wb.proj === r1(wbProj) && wb.n_recent === 1, `last night's 5 blocks blend with last season's ${wemby.blk} as five games' worth (${wb.proj}, want ${r1(wbProj)}, ${wb.n_recent} recent)`);
ok(wb.model_under === r1(nbCdf(3, wbProj, 1.15) * 100), `the chance of the under is the negative binomial at the blocks dispersion, 1.15 (${wb.model_under}%)`);
ok(wb.book_line === 3.5 && wb.book_under === -125 && wb.date === '2026-10-22', `with DraftKings' line and under price beside it (${wb.book_line} ${wb.book_under}), dated by tip`);
const [, kj] = prior('Keldon Johnson');
const ks = leg('Keldon Johnson', 'stl');
const ksProj = (2 + 5 * kj.stl) / (1 + 5);
ok(ks.proj === r1(ksProj) && ks.n_recent === 1 && ks.model_under === r1(nbCdf(1, ksProj, 1.1) * 100),
  `steals the same way, at 1.1: Keldon Johnson u1.5, proj ${ks.proj} (want ${r1(ksProj)}), ${ks.model_under}% (want ${r1(nbCdf(1, ksProj, 1.1) * 100)})`);
const [, gi] = prior('Giannis Antetokounmpo');
const gs = leg('Giannis Antetokounmpo', 'stl');
ok(gs.proj === r1(gi.stl) && gs.n_recent === 0, `no games yet: last season's rate is the projection (${gs.proj} vs ${gi.stl})`);
ok(['Myles Turner', 'Keldon Johnson', 'Bismack Biyombo'].every((p) => leg(p, 'blk').point === 0.5 || leg(p, 'blk').point === 1.5)
  && leg('Ryan Rollins', 'stl').point === 1.5 && leg('Stephon Castle', 'threes').point === 2.5, 'every PrizePicks line is logged, threes beside them as before');

// ---- the card --------------------------------------------------------------------------------
console.log('\n-- the NBA card --');
const card = await hit('/api/nba-pp');
const cm = new Set((card.legs || []).map((l) => l.market));
ok(cm.has('blk') && cm.has('stl') && cm.has('threes'), `the card's legs include blocks and steals (${[...cm].join(', ')})`);
ok(/blocks, steals/.test(card.note || ''), 'and its note names them');
const appSrc = fs.readFileSync(path.join(BOARD, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const lift = (name) => { const m = new RegExp(`const ${name} = (\\{[\\s\\S]*?\\});`).exec(appSrc); return m ? Function(`return ${m[1]}`)() : {}; };
const NBA_MK = lift('NBA_MK'), SHORT = lift('MARKET_SHORT');
ok(NBA_MK.blk === 'blocks' && NBA_MK.stl === 'steals', `the card reads "Under 0.5 blocks", "Under 1.5 steals" (${NBA_MK.blk}, ${NBA_MK.stl})`);
ok(SHORT.blk === 'Blk' && SHORT.stl === 'Stl', `and the slip and your entries name them (${SHORT.blk}, ${SHORT.stl})`);
ok(/Threes, assists, rebounds, blocks, steals; rotation players only/.test(appSrc), 'the card says which markets it logs');

// ---- the payload, kept --------------------------------------------------------------------
console.log('\n-- the last payload, kept --');
const raw = await hit('/api/nba-pp?raw=1');
ok(raw.game === 'evSAMIL' && raw.credits === 5 && raw.body && raw.body.bookmakers[0].markets.some((m) => m.key === 'player_blocks'),
  `/api/nba-pp?raw=1 is the capture's payload as it came, with what it cost (${raw.game}, ${raw.credits} credits)`);
const again = await hit('/api/nba-pp');
ok(Array.isArray(again.legs) && !again.body, 'and has its own cache entry: the board is still the board');
ok(paid === 1, 'reading either costs nothing');

// ---- Picks of the day --------------------------------------------------------------------
console.log('\n-- Picks of the day: blocks and steals stay off --');
// A blocks and a steals leg in another game, far above the bar, rotation players.
const np = (date, gid, player, market, mu, result, commence) => sq.prepare(
  `INSERT INTO nbapp (date, game_id, player, market, league, commence, home, away, team, point, proj, model_under, n_recent, min_proj, result)
   VALUES (?, ?, ?, ?, 'reg', ?, 'Utah Jazz', 'Denver Nuggets', 'DEN', 0.5, 0.2, ?, 5, 30, ?)`).run(date, gid, player, market, commence, mu, result);
np('2026-10-22', 'evOTHER', 'Other Big', 'blk', 95, null, iso(NOW + 5 * 3600e3));
np('2026-10-22', 'evOTHER', 'Other Guard', 'stl', 92, null, iso(NOW + 5 * 3600e3));
// And a graded steals leg from last night, which must not count as an NBA PrizePicks hit or miss.
np('2026-10-21', 'evOLD', 'Old Guard', 'stl', 80, 'over', iso(NOW - 20 * 3600e3));
const kb = leg('Keldon Johnson', 'blk'), c3 = leg('Stephon Castle', 'threes');
ok(kb.model_under > c3.model_under && c3.model_under >= 70 && kb.min_proj >= 20,
  `precondition: in the Spurs game the blocks under (${kb.model_under}%) tops the threes under (${c3.model_under}%), both rotation and over the bar`);
const picks = await hit('/api/picks');
const pl = picks.legs || [];
console.log('  ' + pl.map((x) => `${x.rank}. ${x.title} ${x.p}% [${x.kind}]`).join(' | '));
ok(pl.some((x) => x.title === 'Stephon Castle Under 2.5 3PM') && !pl.some((x) => / (BLK|STL|blk|stl)$/.test(x.title)),
  "the Spurs game's leg is the threes under, not the higher blocks one, and no blocks or steals leg is on the list");
ok(!pl.some((x) => x.sub === 'Nuggets @ Jazz'), 'a game whose only legs are blocks and steals is not on it at all');
ok(/3PM, AST, REB/.test((picks.kinds.nba_pp || {}).label || ''), `the kind says what it carries (${(picks.kinds.nba_pp || {}).label})`);

// ---- graded ---------------------------------------------------------------------------------
console.log('\n-- graded from the box score --');
NOW = RealDate.parse('2026-10-23T18:00:00Z');           // the next morning
edge.clear();                                            // every cached response has long expired
finalOn.add('20261022');
await tick();
const g = (p, m) => sq.prepare('SELECT result, actual FROM nbapp WHERE player = ? AND market = ?').get(p, m) || {};
// From the box score (STL, BLK): Wembanyama 0, 2; Turner 0, 0; Keldon Johnson 3, 0;
// Giannis 2, 0; Rollins 1, 1; Castle 1-2 from three; Biyombo did not play.
const want = [['Victor Wembanyama', 'blk', 'under', 2], ['Myles Turner', 'blk', 'under', 0], ['Keldon Johnson', 'blk', 'under', 0],
  ['Keldon Johnson', 'stl', 'over', 3], ['Giannis Antetokounmpo', 'stl', 'over', 2], ['Ryan Rollins', 'stl', 'under', 1],
  ['Stephon Castle', 'threes', 'under', 1]];
const got = want.map(([p, m]) => g(p, m));
ok(want.every(([, , res, act], i) => got[i].result === res && got[i].actual === act),
  `each graded from its own column: ${want.map(([p, m], i) => `${p.split(' ').pop()} ${m} ${got[i].result} ${got[i].actual}`).join(', ')}`);
ok(g('Bismack Biyombo', 'blk').result === 'void', `a did-not-play is void, never a free under (${g('Bismack Biyombo', 'blk').result})`);
const after = await hit('/api/nba-pp');
const bm = (after.record || {}).byMarket || {};
ok(bm.blk && bm.blk.n === 3 && bm.blk.hitRate === 100 && bm.stl && bm.stl.n === 4 && bm.stl.hitRate === 25,
  `the card's record splits them out: blocks ${JSON.stringify(bm.blk)}, steals ${JSON.stringify(bm.stl)}`);
const kinds = (await hit('/api/picks')).kinds || {};
const kr = (kinds.nba_pp || {}).record || {};
ok(kr.n === 1 && kr.hit === 1, `Picks of the day's NBA record is the threes under alone, not the blocks under or the steals over (${kr.hit} of ${kr.n})`);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
