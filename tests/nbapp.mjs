// NBA PrizePicks unders: box scores in, PrizePicks lines captured, projected,
// logged, graded.
//
// The MLB Today's card ranks the under by the model's chance at PrizePicks'
// line, with no sharp book involved; this is the NBA version (2026-10-06),
// built in preseason so it is tested before opening night.
//
// Real SQLite underneath (node:sqlite, as tests/entries.mjs), because the
// pipeline is mostly SQL. Real ESPN payloads: a recorded box score
// (tests/fixtures/espn-nba-box-401812483.json -- Knicks 113, 76ers 104, with
// Kyle Lowry and Eric Gordon did-not-play) and a recorded scoreboard day. The
// priors are the real nba-priors.json. The Odds API payload is its documented
// per-event shape: bookmakers -> markets -> Over/Under outcomes keyed by player.
//
// What has to hold:
//   - a box score reads minutes, threes, rebounds and assists, and a DNP is a DNP
//   - preseason games never feed a projection; regular-season ones do, blended
//     with last season as NBA_PRIOR_K games' worth
//   - each game's PrizePicks lines are captured ONCE, inside four hours of tip
//   - a leg grades under/over from the box score; a player who did not play,
//     or is missing from a fully-read day, is void, never a free under
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = path.join(BOARD, 'tests', 'fixtures');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const RealDate = Date;
let NOW = RealDate.parse('2026-10-21T19:00:00Z');        // a Wednesday, noon Pacific, opening week
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const iso = (ms) => new RealDate(ms).toISOString();
const ptDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new RealDate(ms));

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
const priorOf = (name) => Object.entries(priors).find(([, p]) => p.n === name);
const env = { DB, ODDS_API_KEY: 'k', ASSETS: { fetch: async (r) => {
  const u = new URL(r.url);
  if (u.pathname === '/nba-priors.json') return new Response(PRIORS, { status: 200, headers: { 'content-type': 'application/json' } });
  return new Response('{}', { status: 404 });
} } };

// ---- the feeds ------------------------------------------------------------------------
const SCORE = JSON.parse(fs.readFileSync(path.join(FIX, 'espn-nba-20251004.json'), 'utf8'));
const BOX = fs.readFileSync(path.join(FIX, 'espn-nba-box-401812483.json'), 'utf8');
// Each requested day gets the recorded slate under its own ids, so two days do
// not collide on one game id.
const dayOf = {};
const slateFor = (ymd) => ({ content: { sbData: { events: (SCORE.content.sbData.events).map((e) => ({ ...e, id: e.id + '-' + ymd })) } } });
let ppCalls = 0;
let ppPayload = null;
globalThis.fetch = async (u) => {
  const url = String(u);
  const J = (x, h) => new Response(typeof x === 'string' ? x : JSON.stringify(x), { status: 200,
    headers: { 'content-type': 'application/json', 'x-requests-remaining': '90000', 'x-requests-last': '3', ...(h || {}) } });
  if (url.includes('cdn.espn.com/core/nba/scoreboard')) {
    const d = new URL(url).searchParams.get('date');
    return J(dayOf[d] ? slateFor(d) : { content: { sbData: { events: [] } } });
  }
  if (url.includes('cdn.espn.com/core/nba/boxscore')) return J(BOX);
  if (url.includes('api.the-odds-api.com')) {
    if (/\/events\/[^/]+\/odds/.test(url)) { ppCalls++; return J(ppPayload); }
    return J([]);
  }
  return new Response('{}', { status: 404 });
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const tick = async () => { const held = []; await mod.default.scheduled({}, env, { waitUntil: (p) => held.push(p) }); await Promise.allSettled(held); };
const hit = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// ---- box scores -------------------------------------------------------------------------
console.log('-- box scores in --');
const yday = ptDay(NOW - 86400e3).replace(/-/g, '');
dayOf[yday] = true;
await tick();
const anunoby = sq.prepare("SELECT * FROM nba_box WHERE player = 'OG Anunoby' LIMIT 1").get();
ok(anunoby && anunoby.min === 17 && anunoby.threes === 3 && anunoby.reb === 2 && anunoby.ast === 1 && anunoby.dnp === 0,
  `a box score line reads minutes, threes, rebounds and assists (${anunoby && [anunoby.min, anunoby.threes, anunoby.reb, anunoby.ast].join('/')})`);
const lowry = sq.prepare("SELECT * FROM nba_box WHERE player = 'Kyle Lowry' LIMIT 1").get();
ok(lowry && lowry.dnp === 1 && lowry.threes == null, 'and a did-not-play is recorded as one, with no stat line');
const games = sq.prepare('SELECT COUNT(*) AS n, SUM(done) AS d FROM nba_box_games').get();
ok(games.n === 5 && games.d === 4, `a few box scores a tick, not a whole slate at once (${games.d} of ${games.n} read)`);
await tick();
ok(sq.prepare('SELECT SUM(done) AS d FROM nba_box_games').get().d === 5, 'and the rest on the next tick');
ok(anunoby && anunoby.season_type === 1, 'the recorded game is preseason, and is stored as such');

// ---- capture, projection, log ------------------------------------------------------------
console.log('\n-- PrizePicks lines captured, projected and logged --');
// Two regular-season games for Anunoby, which DO feed his projection.
const [anId, anPrior] = priorOf('OG Anunoby');
sq.prepare(`INSERT INTO nba_box (game_id, date, season_type, player_id, player, team, min, threes, ast, reb, starter, dnp)
  VALUES ('r1', '2026-10-19', 2, ?, 'OG Anunoby', 'NY', 34, 5, 2, 6, 1, 0), ('r2', '2026-10-20', 2, ?, 'OG Anunoby', 'NY', 30, 1, 1, 4, 1, 0)`).run(anId, anId);
// Tonight's game, from the board's snapshot: it tips inside the four-hour window.
const TIP = iso(NOW + 3 * 3600e3);
sq.prepare("INSERT OR REPLACE INTO feed_cache (key, data, updated_at) VALUES (?, ?, ?)").run('nba_board:reg',
  JSON.stringify({ asOf: iso(NOW), games: [{ id: 'evNYK', league: 'reg', commence: TIP, home: 'Philadelphia 76ers', away: 'New York Knicks' },
    { id: 'evLATE', league: 'reg', commence: iso(NOW + 9 * 3600e3), home: 'Los Angeles Lakers', away: 'Golden State Warriors' }] }), NOW);
const ou = (player, point, over = -120, under = -110) => [
  { name: 'Over', description: player, price: over, point }, { name: 'Under', description: player, price: under, point }];
ppPayload = { id: 'evNYK', commence_time: TIP, home_team: 'Philadelphia 76ers', away_team: 'New York Knicks', bookmakers: [
  { key: 'prizepicks', markets: [
    { key: 'player_threes', outcomes: [...ou('OG Anunoby', 2.5), ...ou('Kyle Lowry', 0.5), ...ou('Nobody Known', 1.5)] },
    { key: 'player_assists', outcomes: ou('Jalen Brunson', 6.5) },
    { key: 'player_rebounds', outcomes: ou('Josh Hart', 7.5) },
  ] },
  { key: 'draftkings', markets: [{ key: 'player_threes', outcomes: ou('OG Anunoby', 2.5, 105, -135) },
    // PrizePicks hangs Hart a point above DraftKings: its under is the easier one.
    { key: 'player_rebounds', outcomes: ou('Josh Hart', 6.5, -115, -105) }] },
] };
await tick();
const legs = sq.prepare('SELECT * FROM nbapp ORDER BY model_under DESC').all();
const leg = (p, m) => legs.find((l) => l.player === p && l.market === m) || {};
console.log('  logged: ' + legs.map((l) => `${l.player} ${l.market} u${l.point} proj ${l.proj} (${l.n_recent} recent) ${l.model_under}%`).join(' | '));
ok(ppCalls === 1, `one paid call, for the game inside the window and not the late one (${ppCalls})`);
const an = leg('OG Anunoby', 'threes');
const wantProj = Math.round(((5 + 1) + 5 * anPrior.threes) / (2 + 5) * 10) / 10;
ok(an.proj === wantProj && an.n_recent === 2,
  `two regular-season games blend with last season's ${anPrior.threes} a game as five games' worth (${an.proj}, want ${wantProj}); the preseason game is ignored`);
ok(an.model_under > 0 && an.model_under < 100 && an.book_line === 2.5 && an.book_under === -135 && an.date === ptDay(RealDate.parse(TIP)),
  `with the model's chance of the under (${an.model_under}%), the book's line and under price beside it (${an.book_line} ${an.book_under}), dated by tip`);
const br = leg('Jalen Brunson', 'ast');
const [, brPrior] = priorOf('Jalen Brunson');
ok(br.proj === Math.round(brPrior.ast * 10) / 10 && br.n_recent === 0, `no games yet: the projection is last season's (${br.proj} vs ${brPrior.ast})`);
ok(!legs.some((l) => l.player === 'Nobody Known'), 'a player the priors do not know is skipped, not guessed');
// Minutes ride along, so the card can show rotation players only: the highest
// under-chance here is Lowry's u0.5, and Lowry barely plays.
const lo = leg('Kyle Lowry', 'threes');
const anMinWant = Math.round(((34 + 30) + 5 * anPrior.min) / 7 * 10) / 10;
ok(an.min_proj === anMinWant && lo.min_proj != null && lo.min_proj < 20,
  `projected minutes are logged, blended like the stat (Anunoby ${an.min_proj}, want ${anMinWant}; Lowry ${lo.min_proj})`);
await tick();
ok(ppCalls === 1, 'the next tick does not buy the same game again');

// ---- the board -------------------------------------------------------------------------
const board = await hit('/api/nba-pp');
ok(board.legs.length === legs.length && board.legs[0].model_under >= board.legs[board.legs.length - 1].model_under,
  `the endpoint lists tonight's legs, best under first (${board.legs.length})`);
const bl = (p) => board.legs.find((x) => x.player === p) || {};
ok(bl('Josh Hart').vsBook === 1 && bl('OG Anunoby').vsBook === 0 && bl('Jalen Brunson').vsBook === null,
  `each leg says how PrizePicks' number sits against the book's: Hart +1, Anunoby level, Brunson no book (${bl('Josh Hart').vsBook}, ${bl('OG Anunoby').vsBook}, ${bl('Jalen Brunson').vsBook})`);

// ---- grading -----------------------------------------------------------------------------
console.log('\n-- graded from the box scores --');
NOW += 86400e3;                                   // the next day; the leg's day is now yesterday
dayOf[ptDay(NOW - 86400e3).replace(/-/g, '')] = true;
await tick(); await tick();                       // five box scores, four a tick
const after = sq.prepare('SELECT player, market, point, actual, result FROM nbapp').all();
const res = (p) => after.find((l) => l.player === p) || {};
ok(res('OG Anunoby').result === 'over' && res('OG Anunoby').actual === 3, `Anunoby made 3 against under 2.5: an over (${res('OG Anunoby').result}, ${res('OG Anunoby').actual})`);
ok(res('Jalen Brunson').result === 'under' && res('Jalen Brunson').actual === 2, `Brunson had 2 assists against under 6.5: an under (${res('Jalen Brunson').result})`);
ok(res('Kyle Lowry').result === 'void', `Lowry did not play: void, never a free under (${res('Kyle Lowry').result})`);
ok(res('Josh Hart').result === 'void', `Hart is in no box score of a fully-read day: void (${res('Josh Hart').result})`);
const rec = (await hit('/api/nba-pp')).record;
ok(rec && rec.graded === 2 && rec.byMarket.threes.n === 1 && rec.byMarket.ast.hitRate === 100,
  `and the record counts what graded, by market (${JSON.stringify(rec && rec.byMarket)})`);

// The record by the model's band and by PrizePicks' number against the book's.
// In MLB the model's chance said nothing below 65% at PrizePicks' lines, so one
// average would hide the only part that held up. Graded rows from an earlier
// night, written the way the grader leaves them:
const past = (player, model_under, point, book_line, min_proj, result) => sq.prepare(
  `INSERT INTO nbapp (date, game_id, player, market, point, model_under, book_line, min_proj, result, actual)
   VALUES ('2026-10-21', 'evOLD', ?, 'reb', ?, ?, ?, ?, ?, 0)`).run(player, point, model_under, book_line, min_proj, result);
past('Band Seventy', 72, 9.5, 8.5, 31, 'under');     // 70+, PrizePicks a point above the book: hit
past('Band SixtySix', 66, 5.5, 6.5, 28, 'over');     // 65-70, PrizePicks a point below: miss
past('Pushed Leg', 61, 7, 7, 30, 'push');            // neither a hit nor a miss
past('Bench Guy', 91, 0.5, null, 12, 'under');       // tops any ranking, and is not on the card
const r2 = (await hit('/api/nba-pp')).record;
console.log('  byBand ' + JSON.stringify(r2.byBand) + '\n  byLineGap ' + JSON.stringify(r2.byLineGap));
ok(r2.graded === 4 && /rotation/.test(r2.scope || ''),
  `the record is over rotation players, as the card is: the bench leg and the push are out (${r2.graded} graded)`);
ok(r2.byBand['70+'].n === 1 && r2.byBand['70+'].hit === 1 && r2.byBand['65-70'].n === 1 && r2.byBand['65-70'].hit === 0,
  'by band: the 72% leg hit, the 66% leg missed');
ok(r2.byLineGap.ppHigher.n === 1 && r2.byLineGap.ppHigher.hit === 1 && r2.byLineGap.ppLower.n === 1 && r2.byLineGap.ppLower.hit === 0
  && r2.byLineGap.same.n === 1 && r2.byLineGap.noBook.n === 1 && r2.byLineGap.noBook.hit === 1,
  "by PrizePicks' number against the book's: above (hit), below (miss), level (Anunoby's over), no book (Brunson's under)");

// ---- your entries ------------------------------------------------------------------------
// A PrizePicks entry built from the card grades from the same box scores.
console.log('\n-- an entry with NBA legs --');
const KEY = 'phone-key-0123456789abcdef';
const entries = async (method, body) => (await mod.default.fetch(new Request('https://x/api/entries', { method,
  headers: { 'content-type': 'application/json', 'x-entry-key': KEY }, body: body ? JSON.stringify(body) : undefined }), env, { waitUntil: () => {} })).json();
const legDay = ptDay(RealDate.parse(TIP));
const nbaLeg = (player, market, line) => ({ sport: 'nba', date: legDay, gamePk: 'evNYK', player, team: 'NY', market, line, side: 'Under' });
const made = await entries('POST', { action: 'create', entry: { book: 'pp', kind: 'flex', stake: 10, legs: [
  nbaLeg('OG Anunoby', 'threes', 2.5), nbaLeg('Jalen Brunson', 'ast', 6.5), nbaLeg('Kyle Lowry', 'threes', 0.5), nbaLeg('Mikal Bridges', 'reb', 3.5)] } });
await entries('GET');
const el = sq.prepare('SELECT player, result, actual FROM entry_legs WHERE entry_id = ? ORDER BY idx').all(made.id);
const er = (p) => el.find((x) => x.player === p) || {};
ok(er('OG Anunoby').result === 'loss' && er('Jalen Brunson').result === 'win' && er('Mikal Bridges').result === 'win',
  `under 2.5 threes on 3 loses, under 6.5 assists on 2 wins, under 3.5 rebounds on 2 wins (${el.map((x) => x.result).join(', ')})`);
ok(er('Kyle Lowry').result === 'void', 'and a player who did not play voids his leg in your entry too');
const ent = sq.prepare('SELECT status, payout FROM entries WHERE id = ?').get(made.id);
ok(ent.status === 'settled', `the entry settles, reduced to the three that played (${ent.status}, $${ent.payout})`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
