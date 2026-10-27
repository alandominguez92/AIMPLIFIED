// NHL PrizePicks points and assists unders, logged (2026-10-22).
//
// The Oct 22 check found PrizePicks offering Less on NHL points and assists at
// its standard -137, on DraftKings' number; two seasons of box scores put the
// under at 59.5% (points) and 67.4% (assists) for regular skaters, and showed
// that on 0.5 lines the scoring rate decides it. So each game's PrizePicks
// points and assists lines are read (about 2 credits a read), priced by
// Poisson at the skater's rate this season blended with last season's, and
// graded from the NHL's own box scores by player id. Since 2026-10-23 a game
// is read when PrizePicks posts it and again inside 90 minutes of puck drop
// (tests/ppearly.mjs); here each capture is that pre-tip read. What has to hold:
//   - the capture is the cron's, from the NHL board's snapshot, once a game
//     inside 90 minutes, from ten or fewer books (one region)
//   - the line is the one PrizePicks takes an Under on, never an over-only one
//   - the rate is this season's blended with last season's, NHL_PRIOR_K games
//     of it; a skater under 15 minutes a night, or not in the NHL's stats, is
//     not logged
//   - a leg grades from the box score by NHL id: under, over, or void when
//     the player is missing from a finished day
//   - /api/nhl-pp shows tonight's legs and the record both ways; ?raw=1 the
//     last payload
//
// Real NHL data (tests/fixtures/nhl-pp-20261021.json): the score feed and the
// Flyers at Sabres box score for Oct 21, and the stats API's 2025-26 and
// 2026-27 skater summaries for the players in it. That game's odds payload is
// the v4 event shape with those players' names (the key exists only as a Worker
// secret); the first real NHL capture, Mammoth @ Kraken on Oct 22, is then
// replayed as production received it (odds-nhl-pp-ec5f71ec-20261022.json) and
// must log what production logged. Real SQLite, the real worker, its own cron.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const REC = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'nhl-pp-20261021.json'), 'utf8'));
// And the first real capture (tests/fixtures/odds-nhl-pp-ec5f71ec-20261022.json):
// Mammoth @ Kraken as the odds feed sent it, with its players' NHL stats.
const REAL = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'odds-nhl-pp-ec5f71ec-20261022.json'), 'utf8'));
let STATS = {};
const RealDate = Date;
let NOW = RealDate.parse('2026-10-21T22:30:00Z');        // an hour before Flyers @ Sabres
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const PUCK = '2026-10-21T23:30:00Z';
const o = (name, desc, point, price) => ({ name, description: desc, point, price });
const PAYLOAD = { id: 'e-phi-buf', sport_key: 'icehockey_nhl', commence_time: PUCK, home_team: 'Buffalo Sabres', away_team: 'Philadelphia Flyers',
  bookmakers: [
    { key: 'prizepicks', title: 'PrizePicks', markets: [
      { key: 'player_points', outcomes: [
        o('Over', 'Tage Thompson', 1.5, 100),                 // an over-only line first: not the one to log
        o('Over', 'Tage Thompson', 0.5, -137), o('Under', 'Tage Thompson', 0.5, -137),
        o('Over', 'Sean Couturier', 0.5, -137), o('Under', 'Sean Couturier', 0.5, -137),
        o('Over', 'Matvei Michkov', 0.5, -137), o('Under', 'Matvei Michkov', 0.5, -137),
        o('Over', 'Jacob Gaucher', 0.5, -137), o('Under', 'Jacob Gaucher', 0.5, -137),   // 9-11 minutes a night: not a regular
        o('Over', 'Unknown Skater', 0.5, -137), o('Under', 'Unknown Skater', 0.5, -137), // not in the NHL's stats
      ] },
      { key: 'player_assists', outcomes: [
        o('Over', 'Rasmus Dahlin', 0.5, -137), o('Under', 'Rasmus Dahlin', 0.5, -137),
        o('Over', 'Owen Power', 0.5, -137), o('Under', 'Owen Power', 0.5, -137),
      ] },
    ] },
    { key: 'draftkings', title: 'DraftKings', markets: [
      { key: 'player_points', outcomes: [o('Over', 'Tage Thompson', 0.5, -160), o('Under', 'Tage Thompson', 0.5, 125)] },
    ] },
  ] };
const calls = [];
globalThis.fetch = async (u) => {
  const url = String(u);
  const J = (x, h) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json', ...(h || {}) } });
  if (url.includes('api.the-odds-api.com')) {
    calls.push(url);
    if (url.includes('/events/e-phi-buf/odds')) return J(PAYLOAD, { 'x-requests-last': '2', 'x-requests-remaining': '92000' });
    if (url.includes(`/events/${REAL.payload.id}/odds`)) return J(REAL.payload, { 'x-requests-last': '2', 'x-requests-remaining': '92000' });
    // The events list (free), which the PrizePicks watch reads: both games,
    // as it lists them, until they start.
    if (/\/sports\/icehockey_nhl\/events\?/.test(url)) {
      return J([PAYLOAD, REAL.payload].filter((e) => RealDate.parse(e.commence_time) > NOW).map(({ bookmakers, ...e }) => e), { 'x-requests-last': '0' });
    }
    return J([], { 'x-requests-last': '0' });
  }
  if (STATS[url]) return J(STATS[url]);
  if (REC[url]) return J(REC[url]);
  if (url.startsWith('https://api-web.nhle.com/') || url.startsWith('https://api.nhle.com/')) return J({ games: [], data: [] });
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
// The NHL reads were paused on 2026-10-25 (NHL_PP_PAUSED); this tests them as
// they run when switched back on. tests/weekchanges.mjs holds the pause itself.
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8')
  .replace('const NHL_PP_PAUSED = true;', 'const NHL_PP_PAUSED = false;');
if (!src.includes('const NHL_PP_PAUSED = false;')) throw new Error('worker.js has no NHL_PP_PAUSED to lift');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const tick = async () => { const held = []; await mod.default.scheduled({}, env, { waitUntil: (p) => held.push(p) }); await Promise.allSettled(held); };
const hit = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

console.log('-- the capture --');
await hit('/api/nhl-pp');                                     // the tables
// The feed cache, by the worker's own CREATE TABLE.
sq.exec(src.replace(/\r\n/g, '\n').match(/CREATE TABLE IF NOT EXISTS feed_cache \([^)]*\)/)[0]);
sq.prepare('INSERT OR REPLACE INTO feed_cache (key, data, updated_at, claimed_until) VALUES (?,?,?,0)')
  .run('nhl_board:reg', JSON.stringify({ asOf: '2026-10-21T21:00:00Z', games: [{ id: 'e-phi-buf', commence: PUCK, home: 'Buffalo Sabres', away: 'Philadelphia Flyers' }] }), NOW);
await tick();
const paid = calls.filter((u) => u.includes('/events/e-phi-buf/odds'));
const q = paid[0] ? new URL(paid[0]).searchParams : new URLSearchParams();
ok(paid.length === 1 && q.get('markets') === 'player_points,player_assists' && q.get('bookmakers').split(',').length <= 10 && q.get('bookmakers').includes('prizepicks'),
  `one call, points and assists, ten books or fewer: one region, about 2 credits (${paid.length} calls)`);
await tick();
ok(calls.filter((u) => u.includes('/events/e-phi-buf/odds')).length === 1, 'and a game is read once');
const rows = sq.prepare('SELECT * FROM nhlpp ORDER BY player, market').all();
const r = (p, m) => rows.find((x) => x.player === p && x.market === m);
console.log('  ' + rows.map((x) => `${x.player} ${x.market} u${x.point} ${x.model_under}% (rate ${x.proj}, ${x.toi_proj} min)`).join(' | '));
ok(rows.length === 5 && r('Tage Thompson', 'pts') && r('Sean Couturier', 'pts') && r('Matvei Michkov', 'pts') && r('Rasmus Dahlin', 'ast') && r('Owen Power', 'ast'),
  'five legs: three points, two assists');
ok(!r('Jacob Gaucher', 'pts') && !r('Unknown Skater', 'pts'), 'a skater under 15 minutes a night, or not in the NHL\'s stats, is not logged');
ok(r('Tage Thompson', 'pts').point === 0.5, 'the line is the one PrizePicks takes an Under on (0.5), not the over-only 1.5 ahead of it');
// Thompson: 81 points in 81 games last season, 9 in 10 this one: (9 + 5 x 1.0) / (10 + 5).
const sk = (s, name) => REC[Object.keys(REC).find((u) => u.includes(s))].data.find((x) => x.skaterFullName === name);
const pr = sk('20252026', 'Tage Thompson'), cu = sk('20262027', 'Tage Thompson');
const rate = (cu.points + 5 * pr.points / pr.gamesPlayed) / (cu.gamesPlayed + 5);
ok(Math.abs(r('Tage Thompson', 'pts').proj - rate) < 0.006 && Math.abs(r('Tage Thompson', 'pts').model_under - Math.exp(-rate) * 100) < 0.06,
  `this season's rate blended with last season's, and the under is Poisson's chance of none: ${rate.toFixed(3)} a game, ${(Math.exp(-rate) * 100).toFixed(1)}%`);
ok(r('Tage Thompson', 'pts').player_id === String(pr.playerId) && r('Tage Thompson', 'pts').team === 'BUF', 'with the NHL id the box score grades by, and his current team');
ok(r('Tage Thompson', 'pts').book_line === 0.5 && r('Tage Thompson', 'pts').book_under === 125 && r('Sean Couturier', 'pts').book_line == null,
  'beside the DraftKings number where it quotes the player');

console.log('\n-- the board, before puck drop --');
let b = await hit('/api/nhl-pp');
ok(b.legs.length === 5 && b.legs[0].model_under >= b.legs[4].model_under && b.legs.find((x) => x.player === 'Tage Thompson').vsBook === 0,
  'tonight\'s legs, best under first');
const raw = await hit('/api/nhl-pp?raw=1');
// The last read with PrizePicks on it: Mammoth @ Kraken, the next night's game,
// which the watch reads as soon as PrizePicks has it up.
ok([ 'e-phi-buf', REAL.payload.id ].includes(raw.game) && raw.body && raw.body.id === raw.game && raw.body.bookmakers.some((x) => x.key === 'prizepicks'),
  `and ?raw=1 keeps the last payload with PrizePicks on it, for a test to replay (${raw.game})`);

console.log('\n-- graded from the box score --');
sq.prepare("INSERT INTO nhlpp (date, game_id, player, market, commence, player_id, point, model_under, result) VALUES ('2026-10-21', 'e-phi-buf', 'Scratched Skater', 'pts', ?, '99999', 0.5, 70, NULL)").run(PUCK);
NOW = RealDate.parse('2026-10-22T16:00:00Z');
await tick();
const g = (p, m) => sq.prepare('SELECT result, actual FROM nhlpp WHERE player = ? AND market = ?').get(p, m) || {};
ok(g('Tage Thompson', 'pts').result === 'under' && g('Tage Thompson', 'pts').actual === 0, 'Thompson: no points, the under landed');
ok(g('Matvei Michkov', 'pts').result === 'over' && g('Matvei Michkov', 'pts').actual === 1, 'Michkov: an assist, so a point, the over');
ok(g('Rasmus Dahlin', 'ast').result === 'under' && g('Owen Power', 'ast').result === 'under', 'Dahlin and Power: no assists');
ok(g('Scratched Skater', 'pts').result === 'void', 'a logged skater missing from a finished day did not play: void, never a free under');
b = await hit('/api/nhl-pp');
ok(b.record.graded === 5 && b.record.hit === 4 && b.record.byMarket.pts.n === 3 && b.record.byMarket.ast.hit === 2,
  `the record: unders 4 of 5, by market (${JSON.stringify(b.record.byMarket)})`);
ok(b.record.overs && b.record.overs.graded >= 1, 'and the over side kept as the NBA log keeps it');

console.log('\n-- the first real capture, replayed --');
// Mammoth @ Kraken, Oct 22: production logged these six from this payload.
STATS = Object.fromEntries(Object.entries(REAL).filter(([u]) => u.startsWith('https://api.nhle.com/')));
sq.prepare("DELETE FROM feed_cache WHERE key LIKE 'nhl_sk:%' OR key LIKE 'nhl_pp_done:%'").run();
NOW = RealDate.parse('2026-10-23T01:10:00Z');                 // an hour before its 7:10 PM puck drop
sq.prepare('INSERT OR REPLACE INTO feed_cache (key, data, updated_at, claimed_until) VALUES (?,?,?,0)')
  .run('nhl_board:reg', JSON.stringify({ asOf: '2026-10-23T00:00:00Z', games: [{ id: REAL.payload.id, commence: REAL.payload.commence_time,
    home: REAL.payload.home_team, away: REAL.payload.away_team }] }), NOW);
await tick();
const real = sq.prepare('SELECT player, market, point, model_under, book_line FROM nhlpp WHERE game_id = ? ORDER BY model_under DESC').all(REAL.payload.id);
console.log('  ' + real.map((x) => `${x.player} ${x.market} ${x.model_under}%`).join(' | '));
const want = { 'Vincent Trocheck': ['pts', 58.8], 'Vince Dunn': ['pts', 52.3], 'Jordan Eberle': ['pts', 49.9], 'Jared McCann': ['pts', 45.4],
  'Chandler Stephenson': ['pts', 44.7], 'Mikhail Sergachev': ['ast', 47.6] };
ok(real.length === 6 && real.every((x) => want[x.player] && want[x.player][0] === x.market && Math.abs(want[x.player][1] - x.model_under) < 0.15),
  'PrizePicks\' five points lines and one assists line, at the chances production logged');
ok(real.every((x) => x.point === 0.5 && x.book_line === 0.5), 'every one at 0.5, on DraftKings\' number');

console.log('\n-- the page --');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
// The card, drawn from the replayed capture's /api/nhl-pp answer.
function liftApp(name) {
  let at = app.indexOf(`function ${name}(`);
  const isConst = at < 0;
  if (isConst) at = app.indexOf(`const ${name} =`);
  if (at < 0) throw new Error(`app.js has no ${name}`);
  let depth = 0;
  for (let i = at; i < app.length; i++) {
    const c = app[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') { depth--; if (!isConst && c === '}' && depth === 0) return app.slice(at, i + 1); }
    else if (isConst && c === ';' && depth === 0 && app[i + 1] === '\n') return app.slice(at, i + 1);
  }
  throw new Error(`could not close ${name}`);
}
const ui = { nhlPp: await hit('/api/nhl-pp'), slip: {} };
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
let card;
try {
  card = new Function('state', 'esc', ['TEAM_COLORS', 'MLB_TEAM_ID', 'NHL_PHOTO_SEASON', 'headshotUrl', 'teamMarkUrl', 'initialsOf', 'avatarHtml',
    'LEG_OFFERS', 'offerLeg', 'ptDayOf', 'soccerKick', 'AM', 'NBA_MK', 'NHL_MK', 'PP_MORE_MIN', 'ppMoreP', 'ppMoreMk', 'ppMoreLeg', 'ppMoreTop', 'ppMoreListHtml',
    'ppMoreLineHtml', 'nhlPpCardHtml'].map(liftApp).join('\n')
    + '\nreturn nhlPpCardHtml;')(ui, esc);
} catch (e) { console.log(`  FAIL  the card lifts out of app.js (${e.message})`); process.exit(1); }
// Since 2026-10-27 the card lists the More side at 55%+ (tests/morelegs.mjs).
// This capture's six legs lean Under (45-59%); to fill the card, each is read
// 20 points further toward More (25-39% under, so 61-75% More).
ui.nhlPp = { ...ui.nhlPp, legs: ui.nhlPp.legs.map((x) => ({ ...x, model_under: x.model_under - 20 })) };
let html = card();
const shown = ui.nhlPp.legs.filter((x) => 100 - x.model_under >= 55).sort((a, b) => a.model_under - b.model_under);
const order = [...new Set(shown.map((x) => x.player))].slice(0, 5);
ok((html.match(/<li>/g) || []).length === 5 && order.every((p) => html.includes(`/${shown.find((x) => x.player === p).player_id}.png`)),
  "the best five, each with the NHL's own photo of the skater");
ok(!/same game/.test(html), 'one game\'s legs on a quiet night carry no "same game" tag on every row');
// Legs from three games: the warning comes back for the games with two or more.
// The five shown, best first, spread as ga, ga, gb, gc, gc.
const gid = Object.fromEntries(order.map((p, i) => [p, ['ga', 'ga', 'gb', 'gc', 'gc'][i]]));
ui.nhlPp = { ...ui.nhlPp, legs: ui.nhlPp.legs.map((x) => ({ ...x, game_id: gid[x.player] || 'gz' })) };
html = card();
ok(order.length === 5 && (html.match(/same game/g) || []).length === 4, 'with three games on the card, the legs that share one are marked');
ok(/const rec = nhlRecordHtml\(d\.record\) \+ nhlPpCardHtml\(\);/.test(app) && /fetchJson\('\/api\/nhl-pp'\)/.test(app),
  'the NHL tab reads /api/nhl-pp and draws the card under the moneyline record');
ok(/id: `\$\{sport\}pp:\$\{x\.game_id\}:\$\{x\.player\}:\$\{x\.market\}:over`/.test(app) && /market: x\.market, side: 'Over'/.test(app),
  'each leg stars into the slip as a PrizePicks Over, under its own id');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
