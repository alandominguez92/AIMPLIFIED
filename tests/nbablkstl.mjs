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
//   - the Odds API's answer to the first live capture, Celtics @ Pistons on
//     opening night (tests/fixtures/odds-nba-pp-26b036ff-20261020.json, read
//     back from /api/nba-pp?raw=1; it billed 5 credits, one per market).
//     PrizePicks quoted blocks for one player and steals for six, all at 0.5
//     and -137 a side; DraftKings and FanDuel quoted other players at 1.5.
//     What production logged from it at 08:01 PT is what this has to log.
//   - nba-priors.json, rebuilt from ESPN's 2025-26 season totals (blocks and
//     steals per game) and opening-night rosters
//   - ESPN's recorded box score for 401810437 (Spurs 119, Bucks 101: Wembanyama
//     2 blocks, Keldon Johnson 3 steals, Bismack Biyombo did-not-play) and that
//     day's recorded scoreboard, served for a later night. The fetch stub
//     answers only the exact requests the cron should make.
//
// What has to hold:
//   - the one paid call per game asks for blocks and steals with the other three
//   - a blocks or steals leg is projected from his games this season blended
//     with last season's rate, at the fitted dispersions (blocks 1.15, steals 1.1)
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
// Production read this payload at 8:01 AM Pacific; replayed here as the
// pre-tip read, an hour before the noon Pacific tip: one full read, with no
// PrizePicks-only check ahead of it (since 2026-10-23).
let NOW = RealDate.parse('2026-10-20T18:00:00Z');
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
const ODDS = JSON.parse(fs.readFileSync(path.join(FIX, 'odds-nba-pp-26b036ff-20261020.json'), 'utf8'));
const EV = ODDS.id;
const finalOn = new Set();                     // the days ESPN has the recorded game final on
const ODDS_URL = `https://api.the-odds-api.com/v4/sports/basketball_nba/events/${EV}/odds?apiKey=k`
  + '&markets=player_threes,player_assists,player_rebounds,player_blocks,player_steals&oddsFormat=american&dateFormat=iso'
  + '&bookmakers=prizepicks,underdog,pick6,draftkings,fanduel';
// (Underdog and Pick6 are asked for since 2026-10-22; this payload was recorded before, with neither.)
// The recorded payload with one point added: an over-only 1.5 for Cunningham's
// blocks, ahead of his 0.5 -- how a PrizePicks demon comes (the NFL passing-
// yards capture, 2026-10-15). It must change nothing.
const served = structuredClone(ODDS);
const ppBlk = served.bookmakers.find((b) => b.key === 'prizepicks').markets.find((m) => m.key === 'player_blocks');
ppBlk.outcomes.unshift({ name: 'Over', description: 'Cade Cunningham', price: 100, point: 1.5 });
let paid = 0;
globalThis.fetch = async (u) => {
  const url = String(u);
  const J = (x, h) => new Response(typeof x === 'string' ? x : JSON.stringify(x), { status: 200,
    headers: { 'content-type': 'application/json', ...(h || {}) } });
  for (const d of finalOn) if (url === `https://cdn.espn.com/core/nba/scoreboard?xhr=1&date=${d}`) return J(SCORE);
  if (finalOn.size && url === 'https://cdn.espn.com/core/nba/boxscore?xhr=1&gameId=401810437') return J(BOX);
  if (url === ODDS_URL) { paid++; return J(served, { 'x-requests-last': '5', 'x-requests-remaining': '92942' }); }
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
const [, wemby] = prior('Victor Wembanyama');
ok(wemby.blk === 3.08 && wemby.stl === 1.03, `from the season totals, to two places: Wembanyama ${wemby.blk} blocks, ${wemby.stl} steals a game (197 and 66 in 64)`);

// ---- capture, projection, log -----------------------------------------------------------
console.log('\n-- opening night: captured with the other three, projected, logged --');
await tick();                                            // tables made; nothing in the window yet
// One game this season for Queta (2 steals), which must feed his projection.
// Everyone else has none, as on opening night.
const [quetaId, queta] = prior('Neemias Queta');
sq.prepare(`INSERT INTO nba_box (game_id, date, season_type, player_id, player, team, min, threes, ast, reb, blk, stl, starter, dnp)
  VALUES ('r1', '2026-10-19', 2, ?, 'Neemias Queta', 'BOS', 26, 0, 1, 9, 1, 2, 1, 0)`).run(quetaId);
sq.prepare('INSERT OR REPLACE INTO feed_cache (key, data, updated_at) VALUES (?, ?, ?)').run('nba_board:reg',
  JSON.stringify({ asOf: iso(NOW), games: [{ id: EV, league: 'reg', commence: ODDS.commence_time, home: ODDS.home_team, away: ODDS.away_team }] }), NOW);
await tick();
ok(paid === 1, `one paid call, asking for blocks and steals with threes, assists and rebounds (${paid})`);
const rows = sq.prepare('SELECT * FROM nbapp ORDER BY model_under DESC').all();
const leg = (p, m) => rows.find((l) => l.player === p && l.market === m) || {};
const by = (m) => rows.filter((l) => l.market === m).length;
console.log('  logged blocks/steals: ' + rows.filter((l) => l.market === 'blk' || l.market === 'stl')
  .map((l) => `${l.player} ${l.market} u${l.point} proj ${l.proj} (${l.n_recent}) ${l.model_under}%`).join(' | '));
// Production logged 29; the 30th is Ron Holland's rebounds, whose name found no
// prior until the alias (tests/nbaalias.mjs).
ok(rows.length === 30 && by('blk') === 1 && by('stl') === 6 && by('threes') === 6 && by('ast') === 5 && by('reb') === 12,
  `every PrizePicks line on a player the priors know, as production logged them plus Ron Holland: 30 = 1 blocks, 6 steals, 6 threes, 5 assists, 12 rebounds (${rows.length} = ${['blk', 'stl', 'threes', 'ast', 'reb'].map(by).join(', ')})`);
// What production logged at 08:01 PT from this payload: player, market, proj, chance.
const PROD = [['Cade Cunningham', 'blk', 0.8, 45.7], ['Duncan Robinson', 'stl', 0.6, 58.1], ['Jordan Walsh', 'stl', 0.7, 50.3],
  ['Payton Pritchard', 'stl', 0.7, 49.9], ['Jalen Duren', 'stl', 0.8, 46.2], ['Kevin Huerter', 'stl', 0.9, 42.0],
  ['Jayson Tatum', 'ast', 5.3, 57.0], ['Derrick White', 'threes', 2.7, 50.6], ['Jalen Duren', 'reb', 10.5, 41.3]];
const off = PROD.filter(([p, m, pj, mu]) => leg(p, m).proj !== pj || leg(p, m).model_under !== mu);
ok(!off.length, `the same projection and chance production logged, leg for leg (${off.map(([p, m]) => `${p} ${m}: ${leg(p, m).proj}/${leg(p, m).model_under}`).join(', ') || '9 of 9'})`);
const cade = leg('Cade Cunningham', 'blk');
const [, cadeP] = prior('Cade Cunningham');
ok(cade.point === 0.5, `the line is the one PrizePicks takes the under on, 0.5, not the over-only 1.5 listed ahead of it (${cade.point})`);
ok(cade.n_recent === 0 && cade.model_under === r1(nbCdf(0, cadeP.blk, 1.15) * 100),
  `no games yet: last season's ${cadeP.blk} blocks a game, at the blocks dispersion 1.15 (${cade.model_under}%)`);
const rob = leg('Duncan Robinson', 'stl');
const [, robP] = prior('Duncan Robinson');
ok(rob.model_under === r1(nbCdf(0, robP.stl, 1.1) * 100), `steals at 1.1: Duncan Robinson ${robP.stl} a game, ${rob.model_under}% he has none`);
const qs = leg('Neemias Queta', 'stl');
const qProj = (2 + 5 * queta.stl) / (1 + 5);
ok(qs.n_recent === 1 && qs.proj === r1(qProj) && qs.model_under === r1(nbCdf(0, qProj, 1.1) * 100),
  `a game this season blends with last season as five games' worth: Queta's 2 steals and ${queta.stl} a game (${qs.proj}, want ${r1(qProj)}; ${qs.model_under}%)`);
ok(rows.filter((l) => l.market === 'blk' || l.market === 'stl').every((l) => l.book_line == null) && leg('Jayson Tatum', 'ast').book_line === 5.5
  && leg('Jayson Tatum', 'ast').book_under === -104,
  "no book line beside PrizePicks' blocks and steals here -- the books quoted other players -- and the book's beside the assists, as before");
ok(cade.date === '2026-10-20' && cade.team === 'DET' && cade.min_proj === 33.9, `dated by tip, with his team and minutes (${cade.date}, ${cade.team}, ${cade.min_proj})`);

// ---- the card --------------------------------------------------------------------------------
console.log('\n-- the NBA card --');
const card = await hit('/api/nba-pp');
const cm = new Set((card.legs || []).map((l) => l.market));
ok(cm.has('blk') && cm.has('stl') && cm.has('threes'), `the card's legs include blocks and steals (${[...cm].join(', ')})`);
ok(/blocks, steals/.test(card.note || ''), 'and its note names them');
const appSrc = fs.readFileSync(path.join(BOARD, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const lift = (name) => { const m = new RegExp(`const ${name} = (\\{[\\s\\S]*?\\});`).exec(appSrc); return m ? Function(`return ${m[1]}`)() : {}; };
const NBA_MK = lift('NBA_MK'), SHORT = lift('MARKET_SHORT');
ok(NBA_MK.blk === 'blocks' && NBA_MK.stl === 'steals', `the card reads "Under 0.5 blocks", "Under 0.5 steals" (${NBA_MK.blk}, ${NBA_MK.stl})`);
ok(SHORT.blk === 'Blk' && SHORT.stl === 'Stl', `and the slip and your entries name them (${SHORT.blk}, ${SHORT.stl})`);
ok(/Threes, assists, rebounds, blocks, steals; rotation players only/.test(appSrc), 'the card says which markets it logs');

// ---- the payload, kept --------------------------------------------------------------------
console.log('\n-- the last payload, kept --');
const raw = await hit('/api/nba-pp?raw=1');
ok(raw.game === EV && raw.credits === 5 && raw.body && raw.body.bookmakers.some((b) => b.key === 'prizepicks'),
  `/api/nba-pp?raw=1 is the capture's payload as it came, with what it cost (${raw.credits} credits)`);
const again = await hit('/api/nba-pp');
ok(Array.isArray(again.legs) && !again.body, 'and has its own cache entry: the board is still the board');
ok(paid === 1, 'reading either costs nothing');

// ---- Picks of the day --------------------------------------------------------------------
console.log('\n-- Picks of the day: blocks and steals stay off --');
// Another game tonight with a blocks and a steals leg far above the bar, and a
// threes leg under both; rotation players.
const np = (date, gid, player, market, mu, result, commence) => sq.prepare(
  `INSERT INTO nbapp (date, game_id, player, market, league, commence, home, away, team, point, proj, model_under, n_recent, min_proj, result)
   VALUES (?, ?, ?, ?, 'reg', ?, 'Utah Jazz', 'Denver Nuggets', 'DEN', 0.5, 0.2, ?, 5, 30, ?)`).run(date, gid, player, market, commence, mu, result);
const late = iso(NOW + 9 * 3600e3);
np('2026-10-20', 'evOTHER', 'Other Big', 'blk', 95, null, late);
np('2026-10-20', 'evOTHER', 'Other Guard', 'stl', 92, null, late);
np('2026-10-20', 'evOTHER', 'Other Shooter', 'threes', 80, null, late);
// Graded last night: a threes under that landed and a steals under that did not.
np('2026-10-19', 'evOLD', 'Old Shooter', 'threes', 80, 'under', iso(NOW - 20 * 3600e3));
np('2026-10-19', 'evOLD', 'Old Guard', 'stl', 80, 'over', iso(NOW - 20 * 3600e3));
const picks = await hit('/api/picks');
const pl = picks.legs || [];
console.log('  ' + pl.map((x) => `${x.rank}. ${x.title} ${x.p}% [${x.kind}]`).join(' | '));
ok(pl.some((x) => x.title === 'Other Shooter Under 0.5 3PM') && !pl.some((x) => / (BLK|STL|blk|stl)$/.test(x.title)),
  "that game's leg is the threes under, not the higher blocks or steals one; no blocks or steals leg is on the list");
ok(/3PM, AST, REB/.test((picks.kinds.nba_pp || {}).label || ''), `the kind says what it carries (${(picks.kinds.nba_pp || {}).label})`);
const kr = (picks.kinds.nba_pp || {}).record || {};
ok(kr.n === 1 && kr.hit === 1, `its NBA record is the threes under alone, not the steals one that missed (${kr.hit} of ${kr.n})`);

// ---- graded ---------------------------------------------------------------------------------
console.log('\n-- graded from the box score --');
// The Spurs and Bucks on a later night, logged as the capture logs them.
const gl = (player, id, market, point, min) => sq.prepare(
  `INSERT INTO nbapp (date, game_id, player, market, league, commence, home, away, player_id, point, proj, model_under, min_proj)
   VALUES ('2026-10-21', 'evSAMIL', ?, ?, 'reg', '2026-10-22T00:30:00Z', 'San Antonio Spurs', 'Milwaukee Bucks', ?, ?, 1, 60, ?)`).run(player, market, id, point, min);
gl('Victor Wembanyama', '5104157', 'blk', 1.5, 29); gl('Myles Turner', '3133628', 'blk', 0.5, 27); gl('Bismack Biyombo', '6427', 'blk', 0.5, 6);
gl('Keldon Johnson', '4395723', 'stl', 2.5, 24); gl('Giannis Antetokounmpo', '3032977', 'stl', 1.5, 29);
gl('Ryan Rollins', '4591725', 'stl', 0.5, 32); gl('Stephon Castle', '4845367', 'stl', 0.5, 30);
NOW = RealDate.parse('2026-10-22T18:00:00Z');           // the morning after
edge.clear();                                            // every cached response has long expired
finalOn.add('20261021');
await tick();
const g = (p, m) => sq.prepare("SELECT result, actual FROM nbapp WHERE game_id = 'evSAMIL' AND player = ? AND market = ?").get(p, m) || {};
// From the box score (STL, BLK): Wembanyama 0, 2; Turner 0, 0; Keldon Johnson 3, 0;
// Giannis 2, 0; Rollins 1, 1; Castle 0, 0; Biyombo did not play.
const want = [['Victor Wembanyama', 'blk', 'over', 2], ['Myles Turner', 'blk', 'under', 0], ['Keldon Johnson', 'stl', 'over', 3],
  ['Giannis Antetokounmpo', 'stl', 'over', 2], ['Ryan Rollins', 'stl', 'over', 1], ['Stephon Castle', 'stl', 'under', 0]];
const got = want.map(([p, m]) => g(p, m));
ok(want.every(([, , res, act], i) => got[i].result === res && got[i].actual === act),
  `each graded from its own column: ${want.map(([p, m], i) => `${p.split(' ').pop()} ${m} ${got[i].result} ${got[i].actual}`).join(', ')}`);
ok(g('Bismack Biyombo', 'blk').result === 'void', `a did-not-play is void, never a free under (${g('Bismack Biyombo', 'blk').result})`);
ok(sq.prepare(`SELECT COUNT(*) AS n FROM nbapp WHERE game_id = '${EV}' AND result IS NOT NULL`).get().n === 0,
  'and opening night, whose box score has not been read, waits rather than voiding');
const after = await hit('/api/nba-pp');
const bm = (after.record || {}).byMarket || {};
ok(bm.blk && bm.blk.n === 2 && bm.blk.hitRate === 50 && bm.stl && bm.stl.n === 5 && bm.stl.hitRate === 20,
  `the card's record splits them out, rotation players only: blocks ${JSON.stringify(bm.blk)}, steals ${JSON.stringify(bm.stl)}`);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
