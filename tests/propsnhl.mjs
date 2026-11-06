// The NHL props card: its read, its box scores, its log and its grading (2026-11-05).
//
// The owner: "For NHL we can add points, assists, shots on target etc. Let's keep it similar to
// the soccer one." The NBA card's rules, and what is the NHL's own:
//   - one read a game of shots on goal and saves, two credits, only once PrizePicks is known to
//     be up; points and assists come from the log that reads them already
//   - PrizePicks isn't on shots on goal in the feed, so those rows hold the sharp books' numbers
//     with no number of PrizePicks': no figure until one is set by hand, then the figure there
//   - the box scores keep blocked shots and hits, and the goalies apart, so the Hot list and the
//     rest never read a goalie as a skater; the season's games are read again once, for free,
//     without any going back to unread
//   - a goalie shows only with a quote on him, a skater only with a number up or regular minutes
//   - grading at the number typed, else the one read; a row with neither is void, not a result;
//     a name with no id goes by initial and surname, since a box score shortens the first name
//   - an entry's NHL prop legs grade from the same box scores
//
// Real data: Canadiens @ Sabres' odds payload of Jan 15 2026 and that same game's box score,
// with its faceoff moved to the test's day, and the two clubs' box rows to Nov 1 2026.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.join(HERE, '..');
const fx = (f) => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', f), 'utf8'));
const EVENT = fx('hist-props-nhl-20260115.json').odds.data;
const REAL_BOX = fx('nhl-box-2025020740.json'), SCORE = fx('nhl-score-20260115.json'), LEAGUE = fx('nhl-box-league-to-20261101.json');
const SKATERS = { 20252026: fx('nhl-skaters-20252026.json'), 20262027: fx('nhl-skaters-20262027.json') };
const GOALIES = { 20252026: fx('nhl-goalies-20252026.json'), 20262027: fx('nhl-goalies-20262027.json') };

globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const TIP = Date.parse('2026-11-06T02:10:00Z');       // 6:10 PM Pacific, Nov 5
const DAY = '2026-11-05';
let NOW = TIP - 8 * 3600e3;
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const ISO = new RealDate(TIP).toISOString();

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

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
const env = { DB, ODDS_API_KEY: 'k', ASSETS: { fetch: async () => new Response('{}', { status: 404 }) } };

// ---- the feeds ----------------------------------------------------------------------------
const GAME = EVENT.id;
const THE_GAME = SCORE.games.find((g) => g.id === 2025020740);
let oddsReads = [], boxReads = [], scoreReads = 0, upstream = 0, withoutPP = false, boxDown = new Set();
// As the feed answers: only the books and markets asked for.
const answer = (url) => {
  const u = new URL(url), books = u.searchParams.get('bookmakers').split(','), markets = u.searchParams.get('markets').split(',');
  return { ...EVENT, commence_time: ISO, bookmakers: EVENT.bookmakers.filter((b) => books.includes(b.key) && !(withoutPP && b.key === 'prizepicks'))
    .map((b) => ({ ...b, markets: b.markets.filter((m) => markets.includes(m.key)) })).filter((b) => b.markets.length) };
};
const J = (x, h = {}) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json', ...h } });
globalThis.fetch = async (u) => {
  const url = String(u);
  upstream++;
  if (/the-odds-api\.com\/v4\/sports\/icehockey_nhl\/events\?/.test(url)) return J([{ id: GAME, sport_key: 'icehockey_nhl', commence_time: ISO, home_team: EVENT.home_team, away_team: EVENT.away_team }]);
  if (/the-odds-api\.com\/v4\/sports\/icehockey_nhl\/events\/.+\/odds/.test(url)) {
    oddsReads.push(url);
    return J(answer(url), { 'x-requests-last': '2', 'x-requests-remaining': '59000' });
  }
  const sc = url.match(/api-web\.nhle\.com\/v1\/score\/(\d{4}-\d{2}-\d{2})/);
  if (sc) { scoreReads++; return J({ games: sc[1] === DAY ? [{ ...THE_GAME, gameState: 'FUT', startTimeUTC: ISO }] : [] }); }
  const bx = url.match(/gamecenter\/(\d+)\/boxscore/);
  if (bx) {
    boxReads.push(bx[1]);
    return boxDown.has(bx[1]) ? new Response('{}', { status: 500 }) : J(REAL_BOX);
  }
  const season = (url.match(/seasonId=(\d+)/) || [])[1];
  if (/stats\/rest\/en\/skater\/summary/.test(url)) return J(SKATERS[season]);
  if (/stats\/rest\/en\/goalie\/summary/.test(url)) return J(GOALIES[season]);
  return new Response('{}', { status: 404 });
};

const src = fs.readFileSync(path.join(BOARD, 'worker.js'), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const ctx = { waitUntil: () => {} };
const res = (u, init) => mod.default.fetch(new Request('https://x' + u, init), env, ctx);
const hit = async (u) => (await res(u)).json();
const KEY = 'phone-key-0123456789abcdef';
const line = (body, key = KEY) => res('/api/prop-lines', { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-entry-key': key } : {}) }, body: JSON.stringify(body) });
const tick = async (cron = '1-59/2 * * * *') => {
  const held = [];
  await mod.default.scheduled({ cron }, env, { waitUntil: (p) => held.push(p) });
  await Promise.allSettled(held);
};
const lf = src.replace(/\r\n/g, '\n');
const fnOf = (name) => { const at = lf.indexOf(`function ${name}(`); return lf.slice(at, lf.indexOf('\n}\n', at) + 2); };
const shin = new Function(`${fnOf('amProb')}\n${fnOf('shinDevig')}\nreturn shinDevig;`)();
const fair = (u, o) => Math.round(shin(u, o) * 1000) / 10;
const row = (player, market) => sq.prepare('SELECT * FROM pp_props WHERE player = ? AND market = ?').get(player, market);
const save = (k, data) => sq.prepare('INSERT OR REPLACE INTO feed_cache (key, data, updated_at, claimed_until) VALUES (?,?,?,0)').run(k, JSON.stringify(data), NOW);
const cache = (k) => { const r = sq.prepare('SELECT data FROM feed_cache WHERE key = ?').get(k); return r ? JSON.parse(r.data) : null; };

// ---- the tables, the two clubs' games so far ------------------------------------------------
console.log('\n-- nothing to show yet --');
const empty = await hit('/api/nhl-props');
ok(Array.isArray(empty.players) && !empty.players.length && empty.sport === 'nhl' && empty.record.need === 100, 'a board with no slate is an empty one');
ok(upstream === 0, 'and asks no one');
save('nhl_box_reread', { done: true });
save('nhl_box_scan', { from: '2026-11-04', checked: NOW });
const old = LEAGUE.rows.map((r) => ({ game_id: LEAGUE.games[r[0]][0], date: LEAGUE.games[r[0]][1], player_id: LEAGUE.players[r[1]][0], player: LEAGUE.players[r[1]][1], team: r[2], opp: r[3], min: r[4], goals: r[5], ast: r[6], pts: r[7], sog: r[8] }))
  .filter((r) => r.team === 'BUF' || r.team === 'MTL');
const addOld = sq.prepare('INSERT INTO nhl_box (game_id, date, player_id, player, team, opp, min, goals, ast, pts, sog) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
for (const r of old) addOld.run(r.game_id, r.date, r.player_id, r.player, r.team, r.opp, r.min, r.goals, r.ast, r.pts, r.sog);
for (const id of new Set(old.map((r) => r.game_id))) sq.prepare('INSERT OR IGNORE INTO nhl_box_games (game_id, date, done) VALUES (?,?,1)').run(id, old.find((r) => r.game_id === id).date);
sq.prepare("INSERT INTO nhl_goalie_box (game_id, date, player_id, player, team, opp, min, saves, shots) VALUES ('2026020100', '2026-10-30', '8480045', 'U. Luukkonen', 'BUF', 'MTL', 60, 25, 28)").run();

console.log('\n-- the real box score --');
sq.prepare("INSERT INTO nhl_box_games (game_id, date, done) VALUES ('2025020740', '2026-11-03', 0)").run();
await tick();
ok(boxReads.join() === '2025020740', `the game read once: ${boxReads.join()}`);
const skRow = (id, g = '2025020740') => sq.prepare('SELECT * FROM nhl_box WHERE player_id = ? AND game_id = ?').get(String(id), g);
const thompson = skRow(8479420);
ok(thompson && thompson.sog === 3 && thompson.goals === 3 && thompson.blocks === 1 && thompson.hits === 0, `Tage Thompson's line, blocked shots and hits with it: ${thompson && [thompson.goals, thompson.sog, thompson.blocks, thompson.hits].join('/')}`);
ok(skRow(8477949).hits === 4 && skRow(8480839).blocks === 2, 'Tuch\'s 4 hits, Dahlin\'s 2 blocked shots');
const goalies = sq.prepare("SELECT player, team, opp, saves, shots FROM nhl_goalie_box WHERE game_id = '2025020740' ORDER BY player").all();
ok(goalies.length === 2 && goalies[0].player === 'C. Ellis' && goalies[0].team === 'BUF' && goalies[0].opp === 'MTL' && goalies[0].saves === 20 && goalies[0].shots === 23
  && goalies[1].player === 'J. Fowler' && goalies[1].saves === 22, `the two who played, not the backups at 00:00: ${goalies.map((g) => `${g.player} ${g.saves}/${g.shots}`).join(', ')}`);
ok(!sq.prepare("SELECT 1 FROM nhl_box WHERE player_id IN ('8481551', '8484170')").get(), 'and no goalie among the skaters, where the Hot list reads');

console.log('\n-- the form row --');
const slateRow = cache('pp_props_slate:nhl');
ok(slateRow && slateRow.games.length === 1 && slateRow.games[0].home === 'BUF' && slateRow.games[0].away === 'MTL' && slateRow.games[0].commence === ISO, 'the game, with the codes the box scores use');
const scoreThen = scoreReads;
await tick();
ok(scoreReads === scoreThen, 'the games list isn\'t asked for each tick');
NOW += 2.1 * 3600e3;
await tick();
ok(scoreReads > scoreThen, 'and is, two hours on');
const form = cache('pp_props_form:nhl');
const F = (n) => form.players.find((p) => p.name === n);
ok(F('Tage Thompson') && F('Tage Thompson').team === 'BUF', 'a box score\'s "T. Thompson" under his full name');
const mineTT = [...old.filter((r) => r.player_id === '8479420'), { ...thompson, date: '2026-11-03' }].sort((a, c) => (a.date < c.date ? 1 : -1)).slice(0, 10);
const ttWant = Math.round((mineTT.reduce((a, r) => a + r.sog, 0) + 5 * (272 / 81)) / (mineTT.length + 5) * 10) / 10;
ok(F('Tage Thompson').proj.sog === ttWant, `his shots: the last ${mineTT.length} plus five of last season's 272 in 81 (${F('Tage Thompson').proj.sog}, by hand ${ttWant})`);
ok(F('Tage Thompson').proj.hits == null && F('Tage Thompson').log[F('Tage Thompson').log.length - 1][5] === 0, 'hits, with one game of them and no prior: no projection yet, and the game there in his log');
ok(F('Colten Ellis') && F('Colten Ellis').goalie === true && F('Colten Ellis').proj.saves === Math.round((20 + 5 * (411 / 16)) / 6 * 10) / 10, `Ellis by his full name, a goalie, saves ${F('Colten Ellis') && F('Colten Ellis').proj.saves}`);
ok(F('Colten Ellis').proj.pts == null && Object.keys(F('Colten Ellis').proj).join() === 'saves', 'a goalie projects saves, nothing else');

console.log('\n-- one read a game --');
await tick();
ok(!oddsReads.length, 'six hours out: no read');
NOW = TIP - 3.9 * 3600e3;
await tick();
ok(!oddsReads.length, 'inside four hours, and nothing has seen PrizePicks up: no read');
save('nhl_pp_games', { [GAME]: { commence: ISO, first: NOW - 3600e3 } });
// The PrizePicks log's own rows, at PrizePicks' real numbers, with the books' real prices.
const priceOf = (book, mk, name, side, pt) => EVENT.bookmakers.find((b) => b.key === book).markets.find((m) => m.key === mk).outcomes.find((o) => o.description === name && o.name === side && o.point === pt).price;
const nhlpp = (player, market, mk, id, team) => {
  const u = fair(priceOf('pinnacle', mk, player, 'Under', 0.5), priceOf('pinnacle', mk, player, 'Over', 0.5));
  sq.prepare(`INSERT INTO nhlpp (date, game_id, player, market, commence, home, away, team, player_id, point, captured_at, book_unders) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(DAY, GAME, player, market, ISO, EVENT.home_team, EVENT.away_team, team, id, 0.5, new RealDate(NOW - 3600e3).toISOString(), JSON.stringify({ pinnacle: [0.5, u] }));
  return u;
};
const suzukiU = nhlpp('Nick Suzuki', 'ast', 'player_assists', '8480018', 'MTL');
const demidovU = nhlpp('Ivan Demidov', 'pts', 'player_points', null, 'MTL');

withoutPP = true;
await tick();
ok(oddsReads.length === 1, `PrizePicks up: one read, here finding no number of PrizePicks' on either market (${oddsReads.length})`);
const asked = new URL(oddsReads[0]), books = asked.searchParams.get('bookmakers').split(',');
ok(asked.searchParams.get('markets') === 'player_shots_on_goal,player_total_saves', `the two the log doesn't read: ${asked.searchParams.get('markets')}`);
ok(books.includes('prizepicks') && books.includes('pinnacle') && books.length <= 10, `${books.length} named books, which bill as one region`);
ok(cache('pp_props_reads')[GAME].ok === true, 'the sharp books\' numbers are a read that worked: it doesn\'t pay again');
await tick(); await tick();
ok(oddsReads.length === 1, 'and never again for that game');
const quoted = row('Colten Ellis', 'saves');
ok(quoted && quoted.read_point == null && quoted.read_sharp == null && JSON.parse(quoted.fairs).some((f) => f[0] === 23.5), 'Ellis\'s saves: their numbers kept, none of PrizePicks\'');
let b0 = await hit('/api/nhl-props');
const P0 = (n) => b0.players.find((p) => p.name === n);
ok(P0('Colten Ellis') && P0('Colten Ellis').lines.saves.l == null && P0('Colten Ellis').lines.saves.fairs.length, 'a goalie with a quote on him is on the card, which is how to tell who starts');
ok(!P0('Ukko-Pekka Luukkonen'), 'his backup, with a game this season and no quote, is not');

sq.prepare("DELETE FROM feed_cache WHERE key = 'pp_props_reads'").run();
withoutPP = false;
await tick();
ok(oddsReads.length === 2, 'read again in the test, with PrizePicks there');
const usage = sq.prepare("SELECT route, credits FROM odds_route WHERE route LIKE '%props%'").all();
ok(usage.length === 1 && usage[0].route === 'nhl:reg:props' && usage[0].credits === 4, `billed to its own line on the meter, two credits a read (${usage.map((x) => `${x.route} ${x.credits}`).join(', ')})`);

console.log('\n-- the figure --');
const ellis = row('Colten Ellis', 'saves'), fowler = row('Jacob Fowler', 'saves');
ok(ellis.read_point === 23.5 && ellis.read_sharp === fair(-108, -124) && ellis.sharp_src === 'pinnacle', `Ellis's saves at PrizePicks' 23.5: Pinnacle's Under -108 / Over -124, de-vigged to ${fair(-108, -124)} (${ellis.read_sharp})`);
ok(fowler.read_point === 23.5 && fowler.read_sharp === fair(-104, -127), `Fowler's at ${fair(-104, -127)} (${fowler.read_sharp})`);
const shots = row('Tage Thompson', 'sog');
ok(shots && shots.read_point == null && shots.read_sharp == null && shots.read_at, 'Thompson\'s shots: read, with no number of PrizePicks\' and so no figure');
ok(JSON.parse(shots.fairs).some((f) => f[0] === 3.5 && f[1] === fair(-182, 136)), `their chance at 3.5 kept for a line set there: ${shots.fairs}`);
ok(row('Nick Suzuki', 'ast').read_point === 0.5 && row('Nick Suzuki', 'ast').read_sharp === suzukiU, 'the log\'s assists at its own number');
ok(row('Ivan Demidov', 'pts').read_sharp === demidovU, 'and its points');
const stats = sq.prepare('SELECT DISTINCT market FROM pp_props').all().map((r) => r.market).sort().join();
ok(stats === 'ast,pts,saves,sog', `only the card's stats, no blocked shots or hits bought: ${stats}`);
ok(!sq.prepare("SELECT 1 FROM pp_props WHERE market = 'sog' AND (fairs IS NULL OR fairs = '[]')").get(), 'no shots row without a sharp number in it');

console.log('\n-- the board --');
upstream = 0;
const b = await hit('/api/nhl-props');
ok(upstream === 0, 'it calls no one');
ok(b.games.length === 1 && b.games[0].id === GAME && b.games[0].homeAb === 'BUF' && b.games[0].awayAb === 'MTL' && b.games[0].date === DAY && b.games[0].home === 'Buffalo Sabres', 'the game, under the odds feed\'s id, as the moneylines key it');
ok(!/model_under|model_prob/.test(JSON.stringify(b)), 'no model percentage anywhere in it');
ok(!b.games[0].inj && b.cols.includes('sog') && b.cols.includes('saves') && !Object.keys(b.sums).length, 'the columns the page needs, nothing combined');
const P = (name) => b.players.find((p) => p.name === name);
const tt = P('Tage Thompson');
ok(tt && tt.team === 'BUF' && tt.g === 0 && tt.lines.sog.l == null && tt.lines.sog.u == null && tt.lines.sog.fairs.length > 0, 'Thompson: BUF, shots with their numbers and none of PrizePicks\'');
ok(tt.log.length === mineTT.length && tt.log[tt.log.length - 1][b.cols.indexOf('sog')] === 3 && tt.log[tt.log.length - 1][b.cols.indexOf('blocks')] === 1 && tt.log[0][b.cols.indexOf('blocks')] === null, 'his log, oldest first, blocked shots there for the game that has them');
ok(P('Nick Suzuki').lines.ast.l === 0.5 && P('Nick Suzuki').lines.ast.u === suzukiU, 'Suzuki at the log\'s number, with the figure');
ok(P('Colten Ellis').lines.saves.l === 23.5 && P('Colten Ellis').lines.saves.u === fair(-108, -124), 'Ellis at 23.5, with the figure');
ok(!P('Ukko-Pekka Luukkonen'), 'the backup still off');
const fourth = form.players.find((p) => (p.team === 'BUF' || p.team === 'MTL') && !p.goalie && p.min < 15 && !P(p.name));
ok(!!fourth, `${fourth && fourth.name}, ${fourth && fourth.min} minutes and no number: not listed`);
ok(b.players.every((p) => p.g === 0) && b.record.graded === 0 && b.record.need === 100, 'nothing graded of the 100');

console.log('\n-- who to expect --');
// Ahead of time, as the soccer card's expected rows (2026-11-05): ESPN's starter in goal lists him
// with no quote on him, and each row knows how many of his team's last five he was in.
const buf5 = sq.prepare("SELECT DISTINCT game_id, date FROM nhl_box WHERE team = 'BUF' ORDER BY date DESC LIMIT 5").all().map((r) => r.game_id);
const ttIn = buf5.filter((g) => sq.prepare("SELECT 1 FROM nhl_box WHERE game_id = ? AND player_id = '8479420'").get(g)).length;
ok(tt.st && tt.st.join() === `${ttIn},${buf5.length}`, `Thompson in ${tt.st} of the Sabres' last games, by hand ${ttIn} of ${buf5.length}`);
// Fowler before the sharp books quote him: his row set aside for the moment.
const fowlerRow = sq.prepare("SELECT * FROM pp_props WHERE player = 'Jacob Fowler'").get();
sq.prepare("DELETE FROM pp_props WHERE player = 'Jacob Fowler'").run();
ok(fowlerRow && !(await hit('/api/nhl-props')).players.some((p) => p.name === 'Jacob Fowler'), 'before ESPN names anyone: a goalie with no quote stays off');
// ESPN's own entries for the two clubs: Ellis expected (Nov 4), Fowler confirmed (Nov 3).
const espnSide = (f, ab, homeAway) => ({ ...fx(f).events.flatMap((e) => e.competitions[0].competitors).find((c) => c.team.abbreviation === ab), homeAway });
const goaliesOf = new Function(`${fnOf('nhlGoaliesOf')}\nreturn nhlGoaliesOf;`)();
const named = goaliesOf([{ id: '401800000', competitions: [{ competitors: [espnSide('espn-nhl-sb-expected-20261104.json', 'BUF', 'home'), espnSide('espn-nhl-sb-confirmed-20261103.json', 'MTL', 'away')] }] }]);
ok(named[0].homeG === 'Colten Ellis' && named[0].homeS === 'Expected' && named[0].awayG === 'Jacob Fowler' && named[0].awayS === 'Confirmed', `as nhlGoalieTick keeps them: ${JSON.stringify(named[0])}`);
save(`nhl_goalies:${DAY}`, { games: named });
const bg = await hit('/api/nhl-props');
const G = (n) => bg.players.find((p) => p.name === n);
ok(G('Jacob Fowler') && !Object.keys(G('Jacob Fowler').lines).length && G('Jacob Fowler').gl === 'Confirmed' && G('Jacob Fowler').proj.saves > 0, `ESPN's confirmed starter: on the card with no quote, saves projected (${G('Jacob Fowler') && G('Jacob Fowler').proj.saves})`);
ok(G('Colten Ellis').gl === 'Expected' && G('Colten Ellis').lines.saves.l === 23.5, 'Ellis, with his quote, ESPN\'s expected starter');
ok(!G('Ukko-Pekka Luukkonen'), 'the backup still off');
ok(bg.players.length === b.players.length, `and no one else added (${bg.players.length})`);
sq.prepare('DELETE FROM feed_cache WHERE key = ?').run(`nhl_goalies:${DAY}`);
sq.prepare(`INSERT INTO pp_props (${Object.keys(fowlerRow).join(', ')}) VALUES (${Object.keys(fowlerRow).map(() => '?').join(',')})`).run(...Object.values(fowlerRow));

console.log('\n-- a line set on the card --');
const buf = { sport: 'nhl', gameId: GAME, player: 'Tage Thompson', playerId: '8479420', team: 'BUF', stat: 'sog', line: 3.5 };
ok((await line(buf, null)).status === 401, 'no key: refused');
ok((await line({ ...buf, stat: 'reb' })).status === 400, 'a stat of the NBA\'s: refused');
ok((await line({ ...buf, gameId: 'nope' })).status === 409, 'a game that isn\'t on the card: refused');
const r1 = await (await line(buf)).json();
ok(r1.ok && r1.sharp === fair(-182, 136), `his shots set at Pinnacle's 3.5: the figure there (${r1.sharp})`);
const r2 = await (await line({ ...buf, stat: 'goals', line: 0.5 })).json();
ok(r2.ok && r2.sharp == null, 'his goals, which no read has: saved, with no figure');
const r3 = await (await line({ ...buf, stat: 'hits', line: 1.5 })).json();
ok(r3.ok && r3.sharp == null, 'hits the same');
const listed = await (await res('/api/prop-lines', { headers: { 'x-entry-key': KEY } })).json();
ok(listed.lines.filter((x) => x.sport === 'nhl').length === 3, 'a reload gets them back');
ok(!JSON.stringify(await hit('/api/nhl-props')).includes('typed'), 'and the public board doesn\'t have them');

console.log('\n-- grading --');
sq.prepare("UPDATE pp_props SET player_id = NULL WHERE player = 'Jacob Fowler'").run();
sq.prepare("INSERT INTO pp_props (sport, date, pkey, market, player, game_id, home, away, commence, read_point, read_sharp, read_at) VALUES ('nhl', ?, 'alex lyon', 'saves', 'Alex Lyon', ?, ?, ?, ?, 24.5, 50, ?)").run(DAY, GAME, EVENT.home_team, EVENT.away_team, ISO, ISO);
sq.prepare("INSERT INTO nhl_box_games (game_id, date, done) VALUES ('2026020999', ?, 0), ('2026020998', ?, 0)").run(DAY, DAY);
boxDown.add('2026020998');
NOW = TIP + 4 * 3600e3;
await tick();
await tick('4-59/10 * * * *');
const g = (p, m) => { const r = row(p, m); return r && `${r.result}|${r.actual}`; };
ok(g('Tage Thompson', 'sog') === 'under|3', `Thompson's 3 shots against the 3.5 set: ${g('Tage Thompson', 'sog')}`);
ok(g('Tage Thompson', 'goals') === 'over|3', `his 3 goals against the 0.5 set: ${g('Tage Thompson', 'goals')}`);
ok(g('Tage Thompson', 'hits') === 'under|0', `no hits against the 1.5 set, a zero that counts: ${g('Tage Thompson', 'hits')}`);
ok(g('Colten Ellis', 'saves') === 'under|20', `Ellis's 20 saves against 23.5: ${g('Colten Ellis', 'saves')}`);
ok(g('Jacob Fowler', 'saves') === 'under|22', `Fowler's 22, found by initial and surname with no id: ${g('Jacob Fowler', 'saves')}`);
ok(g('Nick Suzuki', 'ast') === 'over|1', `Suzuki's assist against 0.5: ${g('Nick Suzuki', 'ast')}`);
ok(g('Cole Caufield', 'sog') === 'void|null', `shots with no PrizePicks number set: void, no result (${g('Cole Caufield', 'sog')})`);
ok(row('Alex Lyon', 'saves').result == null, 'a goalie not in the box, with a game still to read: he waits');
const rec1 = (await hit('/api/nhl-props')).record;
const finished = sq.prepare("SELECT result, read_sharp, typed_line, typed_sharp FROM pp_props WHERE sport = 'nhl' AND result IN ('under','over')").all();
ok(rec1.graded === finished.length && finished.length >= 5, `the record: ${rec1.graded} decided, voids not among them`);
let n54 = 0, h54 = 0;
for (const r of finished) {
  const u = r.typed_line != null ? r.typed_sharp : r.read_sharp;
  if (u == null) continue;
  const under = u >= 50;
  if ((under ? u : 100 - u) >= 54) { n54++; if ((r.result === 'under') === under) h54++; }
}
ok(rec1.at54.n === n54 && rec1.at54.hit === h54 && n54 > 0, `54%+ on the side the sharp books took, by hand: ${h54} of ${n54} (${rec1.at54.hit} of ${rec1.at54.n})`);
await tick('4-59/10 * * * *');
ok((await hit('/api/nhl-props')).record.graded === rec1.graded, 'grading again counts nothing twice');

console.log('\n-- an entry\'s legs --');
const entry = async (legs) => (await (await res('/api/entries', { method: 'POST', headers: { 'content-type': 'application/json', 'x-entry-key': KEY },
  body: JSON.stringify({ action: 'create', entry: { book: 'pp', kind: 'flex', stake: 10, legs } }) })).json()).id;
const leg = (player, playerId, market, ln, side) => ({ sport: 'nhl', date: DAY, gamePk: GAME, player, playerId, team: 'BUF', market, line: ln, side });
const id = await entry([leg('Tage Thompson', '8479420', 'sog', 3.5, 'Under'), leg('Colten Ellis', '8481551', 'saves', 23.5, 'Over'), leg('Jacob Fowler', null, 'saves', 22, 'Under'), leg('Alex Lyon', '8479312', 'saves', 24.5, 'Under')]);
await res('/api/entries', { headers: { 'x-entry-key': KEY } });
const legs = () => sq.prepare('SELECT player, result, actual FROM entry_legs WHERE entry_id = ? ORDER BY idx').all(id);
ok(legs()[0].result === 'win' && legs()[0].actual === 3, `Thompson's shots Under 3.5, by his id: ${legs()[0].result}`);
ok(legs()[1].result === 'loss' && legs()[1].actual === 20, `Ellis's saves Over 23.5: ${legs()[1].result}`);
ok(legs()[2].result === 'push' && legs()[2].actual === 22, `Fowler's 22 at 22, by initial and surname: ${legs()[2].result}`);
ok(legs()[3].result == null, 'a goalie not in today\'s box: open');

console.log('\n-- the next day --');
boxDown.clear();
NOW = TIP + 24 * 3600e3;
await tick();
const held = [];
await mod.default.scheduled({ cron: '*/5 * * * *' }, env, { waitUntil: (p) => held.push(p) });
await Promise.allSettled(held);
ok(row('Alex Lyon', 'saves').result === 'void', `every game read and he isn't in one: void (${row('Alex Lyon', 'saves').result})`);
await res('/api/entries', { headers: { 'x-entry-key': KEY } });
ok(legs()[3].result === 'void', `and his leg (${legs()[3].result})`);

console.log('\n-- the season read again, once --');
sq.prepare('DELETE FROM nhl_box_games').run();
sq.prepare("DELETE FROM feed_cache WHERE key = 'nhl_box_reread'").run();
for (const n of [1, 2, 3, 4, 5]) sq.prepare('INSERT INTO nhl_box_games (game_id, date, done) VALUES (?, ?, 1)').run(`202602000${n}`, '2026-10-10');
const rereadAt = cache('nhl_box_scan').readAt;
boxReads = [];
await tick();
ok(boxReads.length === 4, `four a tick (${boxReads.length})`);
ok(sq.prepare('SELECT COUNT(*) AS n FROM nhl_box_games WHERE done = 0').get().n === 0, 'with none gone back to unread, so grades and the Hot list wait on nothing');
ok(sq.prepare("SELECT COUNT(*) AS n FROM nhl_box WHERE game_id = '2026020001' AND blocks IS NOT NULL").get().n > 30 && sq.prepare("SELECT COUNT(*) AS n FROM nhl_goalie_box WHERE game_id = '2026020001'").get().n === 2, 'the blocked shots, hits and goalies saved for them');
await tick();
ok(boxReads.length === 5, 'the last one');
await tick();
ok(boxReads.length === 5 && cache('nhl_box_reread').done === true, 'then done');
ok(cache('nhl_box_scan').readAt === rereadAt, 'and the Hot list is not told a new game came in');
await tick();
ok(boxReads.length === 5, 'and it stays done');

if (process.env.PROPS_DUMP) fs.writeFileSync(process.env.PROPS_DUMP, JSON.stringify(b));
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
