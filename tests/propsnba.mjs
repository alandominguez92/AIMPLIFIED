// The NBA props card: its one read a game, its log and its grading (2026-11-05).
//
// The owner: "Let's do the same thing we did for Soccer for NBA, NFL and NHL ... For NBA
// we can add points, Rebounds, Assists, PRA, etc." They chose PrizePicks' number read
// automatically (about 50 credits a day) and the sharp books' chance at that number as the
// big figure, since replayed at PrizePicks' real lines the soccer formula rated 70%+ landed
// 51% on points. What has to hold:
//   - one read a game, inside four hours of it, only once PrizePicks is known to be up, on
//     a named-book call of the five markets the log doesn't read; never again for that game
//     unless it found no PrizePicks line, and then once, near the game; not when credits are low
//   - the figure is the tested one: only quotes at PrizePicks' exact number, Pinnacle first.
//     A number no sharp book quotes has none
//   - the board costs nothing, carries no model percentage, flags and drops players by the
//     injury report, and never shows a line typed on a phone
//   - a typed line is behind the entries key, holds until the game starts, survives a later
//     read and grades at that number
//   - grading voids a player who sat, waits on one who may yet appear, and the record is
//     added to, never counted twice or re-scanned
//
// Real data: Grizzlies @ Magic's odds payload (hist-props-nba-20260115.json, its kickoff moved
// to the test's day) and the two clubs' box scores, Oct 21 to Nov 1 2026.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.join(HERE, '..');
const fx = (f) => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', f), 'utf8'));
const EVENT = fx('hist-props-nba-20260115.json').odds.data;
const { rows: BOX } = fx('nba-props-box-20261105.json');
const PRIORS = fs.readFileSync(path.join(BOARD, 'nba-priors.json'), 'utf8');

globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const TIP = Date.parse('2026-11-06T02:10:00Z');       // 6:10 PM Pacific, Nov 5
const DAY = '2026-11-05';
let NOW = TIP - 5 * 3600e3;
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const scans = [];
function exec(sql, args, mode) {
  if (/FROM nba_box\s+WHERE date >= /.test(sql)) scans.push(sql);
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
const env = { DB, ODDS_API_KEY: 'k', ASSETS: { fetch: async (r) => (new URL(r.url).pathname === '/nba-priors.json'
  ? new Response(PRIORS, { status: 200 }) : new Response('{}', { status: 404 })) } };

// ---- the feeds ----------------------------------------------------------------------------
const GAME = EVENT.id;
const ev = () => ({ ...EVENT, commence_time: new RealDate(TIP).toISOString() });
const list = () => [{ id: GAME, sport_key: 'basketball_nba', commence_time: new RealDate(TIP).toISOString(), home_team: EVENT.home_team, away_team: EVENT.away_team }];
let oddsReads = [], remaining = 59000, answer = () => ev(), upstream = 0;
globalThis.fetch = async (u) => {
  const url = String(u);
  upstream++;
  if (/the-odds-api\.com\/v4\/sports\/basketball_nba\/events\?/.test(url)) return new Response(JSON.stringify(list()), { status: 200 });
  if (/the-odds-api\.com\/v4\/sports\/basketball_nba\/events\/.+\/odds/.test(url)) {
    oddsReads.push(url);
    remaining -= 5;
    return new Response(JSON.stringify(answer()), { status: 200, headers: { 'x-requests-last': '5', 'x-requests-remaining': String(remaining) } });
  }
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
const row = (player, market) => sq.prepare('SELECT * FROM pp_props WHERE player = ? AND market = ?').get(player, market);
const save = (k, data) => sq.prepare('INSERT OR REPLACE INTO feed_cache (key, data, updated_at, claimed_until) VALUES (?,?,?,0)').run(k, JSON.stringify(data), NOW);

// ---- the tables, the box scores, the slate --------------------------------------------------
await hit('/api/nba-props');
const cols = ['game_id', 'date', 'season_type', 'player_id', 'player', 'team', 'min', 'pts', 'reb', 'ast', 'threes', 'stl', 'blk', 'tov', 'starter', 'dnp'];
const addBox = (r) => sq.prepare(`INSERT OR REPLACE INTO nba_box (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => norm(r[c])));
for (const r of BOX) addBox(r);
for (const id of new Set(BOX.map((r) => r.game_id))) sq.prepare('INSERT OR IGNORE INTO nba_box_games (game_id, date, season_type, done) VALUES (?,?,2,1)').run(id, BOX.find((r) => r.game_id === id).date);
const idOf = (name) => BOX.find((r) => r.player === name).player_id;
const REPORT = {
  [idOf('Jalen Suggs')]: { name: 'Jalen Suggs', ln: 'Suggs', tm: 'Orlando Magic', s: 'Out', f: 'OUT', what: 'knee', ret: null, upd: '2026-11-05T18:00Z' },
  [idOf('Ty Jerome')]: { name: 'Ty Jerome', ln: 'Jerome', tm: 'Memphis Grizzlies', s: 'Day-To-Day', f: 'GTD', what: 'calf', ret: null, upd: '2026-11-05T18:00Z' },
  [idOf('Cam Spencer')]: { name: 'Cam Spencer', ln: 'Spencer', tm: 'Memphis Grizzlies', s: 'Out', f: 'OUT', what: 'back', ret: null, upd: '2026-11-05T18:00Z' },
};
const slate = () => save(`nba_inj:${DAY}`, { sbAt: NOW, games: [{ id: '401900001', home: EVENT.home_team, away: EVENT.away_team, homeAb: 'ORL', awayAb: 'MEM', commence: new RealDate(TIP).toISOString(), at: TIP - 6 * 3600e3, inj: REPORT }] });
slate();
// The PrizePicks log's own rows for this game, as a re-read left them.
const nbapp = (player, market, point, bookUnders, extra = {}) => {
  const c = { date: DAY, game_id: GAME, player, market, league: 'reg', commence: new RealDate(TIP).toISOString(), home: EVENT.home_team, away: EVENT.away_team, team: BOX.find((r) => r.player === player)?.team || null,
    player_id: BOX.find((r) => r.player === player)?.player_id || null, point, proj: 1, model_under: 60, n_recent: 5, prior_gp: 50, min_proj: 30, captured_at: new RealDate(TIP - 7 * 3600e3).toISOString(), book_unders: bookUnders, ...extra };
  const k = Object.keys(c);
  sq.prepare(`INSERT OR REPLACE INTO nbapp (${k.join(', ')}) VALUES (${k.map(() => '?').join(',')})`).run(...k.map((x) => norm(c[x])));
};
const reread = (close_point) => ({ close_point, close_under: 61, close_at: new RealDate(TIP - 5 * 3600e3).toISOString() });
nbapp('Paolo Banchero', 'reb', 8.5, JSON.stringify({ fanduel: [9.5, 49.1], pinnacle: [8.5, 55.2], novig: [8.5, 53.7] }), reread(8.5));
nbapp('Franz Wagner', 'ast', 3.5, JSON.stringify({ fanduel: [4.5, 50.0], novig: [4, 47.4] }), reread(3.5));
nbapp('Desmond Bane', 'threes', 2.5, JSON.stringify({ pinnacle: [2.5, 48.0] }), reread(3.5));
nbapp('Anthony Black', 'threes', 1.5, JSON.stringify({ pinnacle: [1.5, 50.0] }));      // the re-read didn't find him: PrizePicks took him down

console.log('\n-- one read a game --');
await tick();
ok(!oddsReads.length, 'five hours out: no read');
NOW = TIP - 3.9 * 3600e3;
await tick();
ok(!oddsReads.length, 'inside four hours, and nothing has seen PrizePicks up: no read, nothing to hold the sharp books against');
save('nba_pp_games', { [GAME]: { commence: new RealDate(TIP).toISOString(), first: NOW - 3600e3 } });
remaining = 200;
sq.prepare('CREATE TABLE IF NOT EXISTS odds_usage (day TEXT PRIMARY KEY, remaining INTEGER, low INTEGER, calls INTEGER, updated_at TEXT)').run();
sq.prepare("INSERT OR REPLACE INTO odds_usage (day, remaining, low, calls, updated_at) VALUES (?,?,?,1,?)").run(new RealDate(NOW).toISOString().slice(0, 10), 200, 200, 'x');
await tick();
ok(!oddsReads.length, 'with credits short of the month\'s reserve: no read');
remaining = 59000;
sq.prepare('UPDATE odds_usage SET remaining = ?').run(59000);
await tick();
ok(oddsReads.length === 1, `PrizePicks up and four hours out: one read (${oddsReads.length})`);
const asked = new URL(oddsReads[0]);
const marketsAsked = asked.searchParams.get('markets').split(','), books = asked.searchParams.get('bookmakers').split(',');
ok(marketsAsked.length === 5 && ['player_points', 'player_points_rebounds_assists', 'player_points_rebounds', 'player_points_assists', 'player_rebounds_assists'].every((m) => marketsAsked.includes(m)),
  'of the five markets the PrizePicks log does not read');
ok(books.includes('prizepicks') && books.includes('pinnacle') && books.length <= 10, `${books.length} named books, which bill as one region: ${books.join(', ')}`);
await tick(); await tick();
ok(oddsReads.length === 1, 'and never again for that game');
const usage = sq.prepare("SELECT route, credits FROM odds_route WHERE route LIKE '%props%'").all();
ok(usage.length === 1 && usage[0].route === 'nba:reg:props' && usage[0].credits === 5, `billed to its own line on the meter (${usage.map((x) => `${x.route} ${x.credits}`).join(', ')})`);

const due = new Function(`const PP_PROP_READ_MS = 4 * 3600e3, PP_PROP_RETRY_MS = 90 * 60e3;\n${fnOf('ppPropReadDue')}\nreturn ppPropReadDue;`)();
const iso = new RealDate(TIP).toISOString(), seen = { first: 1 };
ok(!due(iso, { ok: false, tries: 1 }, seen, TIP - 3 * 3600e3), 'a read that found no line waits until near the game');
ok(due(iso, { ok: false, tries: 1 }, seen, TIP - 3600e3), 'and goes once more there');
ok(!due(iso, { ok: false, tries: 2 }, seen, TIP - 3600e3), 'and not a third time');
ok(!due(iso, { ok: true, tries: 1 }, seen, TIP - 3600e3), 'one that found its lines never goes again');
ok(!due(iso, null, seen, TIP + 60e3), 'nor once the game has started');

console.log('\n-- the figure is the tested one --');
const n = sq.prepare('SELECT COUNT(*) AS n FROM pp_props').get().n;
ok(n >= 60, `${n} rows from the real payload`);
const pra = row('Paolo Banchero', 'pra');
const wantPra = Math.round(shin(-108, -123) * 1000) / 10;
ok(pra && pra.read_point === 36.5 && pra.read_sharp === wantPra, `Banchero PRA 36.5: Pinnacle's own price there, Under -108 / Over -123, de-vigged to ${wantPra} (${pra && pra.read_sharp})`);
ok(pra.sharp_src === 'pinnacle', 'Pinnacle first');
const spencer = row('Cam Spencer', 'pts');
ok(spencer && spencer.read_point === 13 && spencer.read_sharp == null && spencer.gap === -0.5, `Spencer points at PrizePicks' 13, Pinnacle's line 13.5: no figure, half a point below theirs (${spencer && spencer.read_sharp}, gap ${spencer && spencer.gap})`);
const fairs = JSON.parse(spencer.fairs);
ok(fairs.some((f) => f[0] === 13.5 && f[1] === Math.round(shin(-133, 100) * 1000) / 10), `their chance at 13.5 is kept for a line set there: ${JSON.stringify(fairs)}`);
ok(row('Paolo Banchero', 'reb').read_sharp === 55.2, 'the log\'s rebounds: its main line at the same number, Pinnacle first (55.2, not the median)');
ok(row('Franz Wagner', 'ast').read_sharp == null, 'its assists, with no sharp book at 3.5: none');
ok(row('Desmond Bane', 'threes').read_point === 3.5 && row('Desmond Bane', 'threes').read_sharp == null, 'a re-read\'s 3.5 stands, and a quote at the old 2.5 is not carried to it');
ok(!row('Anthony Black', 'threes'), 'a leg PrizePicks has taken down since is not carried over');
ok(!sq.prepare("SELECT 1 FROM pp_props WHERE market NOT IN ('pts','pra','pts_reb','pts_ast','reb_ast','reb','ast','threes','blk','stl')").get(), 'no stat outside the card\'s');

console.log('\n-- the form row --');
scans.length = 0;
await tick();
ok(scans.length === 0, 'the box scores aren\'t re-read each tick');
const form0 = JSON.parse(sq.prepare("SELECT data FROM feed_cache WHERE key = 'pp_props_form:nba'").get().data);
ok(form0 && form0.players.length > 20, `${form0.players.length} players on one row`);
const was = NOW;
NOW = was + 2.1 * 3600e3;
await tick();
ok(scans.length === 0, 'two hours on and no game in: still not');
sq.prepare('INSERT OR IGNORE INTO nba_box_games (game_id, date, season_type, done) VALUES (?,?,2,1)').run('401900000', '2026-11-04');
await tick();
ok(scans.length === 1, 'a game in: once');
NOW = was;
slate();

console.log('\n-- the board --');
upstream = 0;
const b = await hit('/api/nba-props');
ok(upstream === 0, 'it calls no one');
ok(b.games.length === 1 && b.games[0].id === GAME && b.games[0].homeAb === 'ORL' && b.games[0].date === DAY, 'the game, under the odds feed\'s id, as the moneylines key it');
ok(!/model_under|model_prob|"over"/.test(JSON.stringify(b)), 'no model percentage anywhere in it');
const P = (name) => b.players.find((p) => p.name === name);
const pb = P('Paolo Banchero');
ok(pb && pb.team === 'ORL' && pb.g === 0 && pb.lines.pra.l === 36.5 && pb.lines.pra.u === wantPra && pb.lines.pts.l === 22.5, 'Banchero: ORL, PRA 36.5 with the figure, points 22.5');
const mine = BOX.filter((r) => r.player === 'Paolo Banchero' && !r.dnp).sort((a, c) => (a.date < c.date ? 1 : -1)).slice(0, 10);
const mineP = JSON.parse(PRIORS).players[idOf('Paolo Banchero')];
const wantProj = Math.round((mine.reduce((a, r) => a + r.pts, 0) + 5 * mineP.pts) / (mine.length + 5) * 10) / 10;
ok(pb.proj.pts === wantProj, `his projection: the last ${mine.length} plus five of last season (${pb.proj.pts}, by hand ${wantProj})`);
const part = (s) => (mine.reduce((a, r) => a + r[s], 0) + 5 * mineP[s]) / (mine.length + 5);
ok(pb.proj.pra === Math.round((part('pts') + part('reb') + part('ast')) * 10) / 10, `PRA, its parts added up (${pb.proj.pra})`);
ok(pb.log.length === mine.length && pb.log[pb.log.length - 1][b.cols.indexOf('pts')] === mine[0].pts && pb.log[0][b.cols.indexOf('pts')] === mine[mine.length - 1].pts, 'his log, oldest first');
ok(pb.proj.tov != null ? mine.length >= 3 : mine.length < 3, 'turnovers, with no prior: his own games once he has three');
ok(b.cols.includes('tov') && b.sums.pra.length === 3, 'and the page can add up any stat from the log');
ok(pb.lines.reb.l === 8.5 && pb.lines.reb.u === 55.2, 'the log\'s stats at their own numbers');
ok(P('Desmond Bane').lines.threes.l === 3.5, 'at the newest number the log read');
ok(!P('Jalen Suggs') || Object.keys(P('Jalen Suggs').lines).length > 0, 'ruled out with no number up: off the card');
const cam = P('Cam Spencer');
ok(cam && cam.inj && cam.inj.out && cam.inj.status === 'OUT' && cam.lines.pts.l === 13, 'ruled out with a number still up: on it, flagged');
const ty = P('Ty Jerome');
ok(!ty || (ty.inj && ty.inj.status === 'GTD'), 'questionable: flagged');
const bench = form0.players.find((p) => p.team === 'MEM' && p.min < 12);
ok(bench && !P(bench.name), `${bench && bench.name}, ${bench && bench.min} minutes and no number: not listed`);
const moe = b.players.find((p) => p.name === 'Moe Wagner');
ok(moe && moe.log.length === 0 && moe.lines.pts.l === 7.5, 'PrizePicks has a player up with no box score: on the card from the read alone');
ok(b.record && b.record.graded === 0 && b.record.need === 100, 'nothing graded of the 100');

console.log('\n-- who to expect, and a number before PrizePicks posts --');
// The owner asked for picks ahead of time, as the soccer card's expected rows (2026-11-05): the
// starters marked, and before PrizePicks' number is up a side against the books' line or its last
// number for him, never a percentage.
const orlRows = BOX.filter((r) => r.team === 'ORL' && !r.dnp).sort((a, c) => (a.date < c.date ? 1 : -1));
const orlLast5 = [...new Set(orlRows.map((r) => r.game_id))].slice(0, 5);
const startsOf = (name) => orlLast5.filter((g) => orlRows.some((r) => r.game_id === g && r.player === name && r.starter)).length;
ok(P('Franz Wagner').st.join() === '5,5' && P('Desmond Bane').st.join() === '5,5', `the Magic's starters: 5 of their last 5 (${P('Franz Wagner').st}, ${P('Desmond Bane').st})`);
ok(P('Paolo Banchero').st.join() === `${startsOf('Paolo Banchero')},5` && startsOf('Paolo Banchero') < 4, `Banchero, who missed games: ${P('Paolo Banchero').st}, by hand ${startsOf('Paolo Banchero')} of 5`);
const benchP = b.players.find((p) => p.team === 'ORL' && p.st && p.st[0] === 0);
ok(!!benchP && orlLast5.some((g) => orlRows.some((r) => r.game_id === g && r.player === benchP.name)), `${benchP && benchP.name}: played, started none of 5`);
ok(b.players.every((p) => !p.last), 'no number from an earlier game yet');
// Earlier games' numbers: the card's own log (a number typed there over the one read), and the
// unders log at its re-read.
const BEFORE = '2026-11-03';
const addProp = (player, market, read, typed) => sq.prepare('INSERT INTO pp_props (sport, date, pkey, market, player, read_point, typed_line, result) VALUES (?,?,?,?,?,?,?,?)')
  .run('nba', BEFORE, P(player).k, market, player, read, typed, 'over');
addProp('Franz Wagner', 'pts', 21.5, null);
addProp('Desmond Bane', 'pts', 17.5, 18.5);
addProp('Franz Wagner', 'pra', 34.5, null);
sq.prepare('INSERT INTO pp_props (sport, date, pkey, market, player, read_point, result) VALUES (?,?,?,?,?,?,?)').run('nba', '2026-10-10', P('Franz Wagner').k, 'pts_reb', 'Franz Wagner', 30.5, 'under');
nbapp('Wendell Carter Jr.', 'reb', 7.5, '{}', { date: BEFORE, game_id: 'g-1103', close_point: 8.5, close_under: 55, close_at: new RealDate(TIP - 49 * 3600e3).toISOString() });
const old0 = JSON.parse(sq.prepare("SELECT data FROM feed_cache WHERE key = 'pp_props_form:nba'").get().data);
ok(old0.v === 2, 'the form row says which shape it is');
delete old0.v;
save('pp_props_form:nba', old0);
scans.length = 0;
await tick();
ok(scans.length === 1, 'a form row saved before starts and numbers: built again at once');
const form1 = JSON.parse(sq.prepare("SELECT data FROM feed_cache WHERE key = 'pp_props_form:nba'").get().data);
const F1 = (n) => form1.players.find((p) => p.name === n);
ok(F1('Franz Wagner').last.pts.join() === `21.5,${BEFORE}` && F1('Franz Wagner').last.pra[0] === 34.5, `Wagner's last numbers: ${JSON.stringify(F1('Franz Wagner').last)}`);
ok(F1('Desmond Bane').last.pts[0] === 18.5, 'a number typed on the card over the one read');
ok(F1('Wendell Carter Jr.').last.reb[0] === 8.5, 'the unders log at its re-read');
ok(!F1('Franz Wagner').last.pts_reb, 'three weeks back is too far');
ok(!F1('Franz Wagner').last.ast, 'today\'s own numbers are not his last');
sq.prepare('DELETE FROM pp_props WHERE date < ?').run(DAY);
sq.prepare('DELETE FROM nbapp WHERE date < ?').run(DAY);
// The day after tomorrow: ESPN's game, two days out, listed with no PrizePicks number.
const DAY2 = '2026-11-07', TIP2 = new RealDate(TIP + 42 * 3600e3).toISOString();
save(`nba_inj:${DAY2}`, { sbAt: NOW, games: [{ id: '401900002', home: EVENT.away_team, away: EVENT.home_team, homeAb: 'MEM', awayAb: 'ORL', commence: TIP2, at: 0, inj: {} }] });
const b2 = await hit('/api/nba-props');
const g2 = b2.games.findIndex((g) => g.date === DAY2);
const w2 = b2.players.find((p) => p.name === 'Franz Wagner' && p.g === g2);
ok(g2 > 0 && b2.games[g2].homeAb === 'MEM', `two days out, as soccer's expected rows: ${b2.games.map((g) => `${g.awayAb}@${g.homeAb} ${g.date}`).join(', ')}`);
ok(w2 && !Object.keys(w2.lines).length && w2.last.pts[0] === 21.5 && w2.st.join() === '5,5', 'Wagner there: no number yet, his last one and his starts');
save(`nba_inj:${DAY2}`, { sbAt: NOW, games: [{ id: '401900002', home: EVENT.away_team, away: EVENT.home_team, homeAb: 'MEM', awayAb: 'ORL', commence: new RealDate(TIP + 49 * 3600e3).toISOString(), at: 0, inj: {} }] });
ok(!(await hit('/api/nba-props')).games.some((g) => g.date === DAY2), 'and not past two days');
sq.prepare("DELETE FROM feed_cache WHERE key = ?").run(`nba_inj:${DAY2}`);

console.log('\n-- a line set on the card --');
const orl = { sport: 'nba', gameId: GAME, player: 'Paolo Banchero', playerId: idOf('Paolo Banchero'), team: 'ORL', stat: 'tov', line: 3.5 };
ok((await line(orl, null)).status === 401, 'no key: refused');
ok((await line({ ...orl, stat: 'dunks' })).status === 400, 'a stat that isn\'t one: refused');
ok((await line({ ...orl, line: 3.3 })).status === 400, 'a line that isn\'t a whole or half number: refused');
ok((await line({ ...orl, sport: 'cricket' })).status === 400, 'a sport that isn\'t one: refused');
ok((await line({ ...orl, gameId: 'nope' })).status === 409, 'a game that isn\'t on the card: refused');
const r1 = await (await line(orl)).json();
ok(r1.ok && r1.line === 3.5 && r1.sharp == null, 'turnovers, which no read has: saved, with no figure');
const r2 = await (await line({ ...orl, player: 'Cam Spencer', playerId: idOf('Cam Spencer'), team: 'MEM', stat: 'pts', line: 13.5 })).json();
ok(r2.ok && r2.sharp === Math.round(shin(-133, 100) * 1000) / 10, `Spencer moved to Pinnacle's 13.5: the figure there (${r2.sharp})`);
const listed = await (await res('/api/prop-lines', { headers: { 'x-entry-key': KEY } })).json();
ok(listed.lines.length === 2 && listed.lines.some((x) => x.market === 'pts' && x.typed_line === 13.5), 'a reload gets both back');
ok((await res('/api/prop-lines', { headers: { 'x-entry-key': 'another-key-0123456789' } })).status === 403, 'and no other key does');
const pub = await hit('/api/nba-props');
ok(pub.players.find((p) => p.name === 'Cam Spencer').lines.pts.l === 13 && !JSON.stringify(pub).includes('typed'), 'the public board still has what was read');
sq.prepare("DELETE FROM feed_cache WHERE key = 'pp_props_reads'").run();
await tick();
ok(oddsReads.length === 2, 'read again in the test');
const s2 = row('Cam Spencer', 'pts');
ok(s2.typed_line === 13.5 && s2.typed_sharp === r2.sharp && s2.read_point === 13, 'a later read leaves the line standing, and keeps the figure at it');
NOW = TIP + 60e3;
ok((await line({ ...orl, line: 2.5 })).status === 409, 'once the game has started: locked');
NOW = was;

console.log('\n-- grading --');
// Last night's box: real rows of these players, on the game's day.
const boxed = (name, stats, extra = {}) => addBox({ ...BOX.find((r) => r.player === name), game_id: '401900001', date: DAY, dnp: 0, ...stats, ...extra });
const legs = sq.prepare("SELECT player, market, read_point, read_sharp FROM pp_props WHERE player = 'Paolo Banchero' AND read_point IS NOT NULL").all();
boxed('Paolo Banchero', { pts: 30, reb: 10, ast: 5, threes: 2, stl: 1, blk: 1, tov: 4 });        // PRA 45: over 36.5
boxed('Cam Spencer', { pts: 13, reb: 2, ast: 3, threes: 1, stl: 1, blk: 0, tov: 1 });              // 13: under the 13.5 he set
boxed('Franz Wagner', { pts: 0, reb: 0, ast: 0, threes: 0, stl: 0, blk: 0, tov: 0, min: 0 }, { dnp: 1 });
sq.prepare("INSERT OR REPLACE INTO nba_box_games (game_id, date, season_type, done) VALUES ('401900001', ?, 2, 1)").run(DAY);
sq.prepare("INSERT OR REPLACE INTO nba_box_games (game_id, date, season_type, done) VALUES ('401900002', ?, 2, 0)").run(DAY);
NOW = TIP + 4 * 3600e3;
await tick('4-59/10 * * * *');
const g = (p, m) => { const r = row(p, m); return r && `${r.result}|${r.actual}`; };
ok(g('Paolo Banchero', 'pra') === 'over|45', `Banchero's PRA, 45 against 36.5: ${g('Paolo Banchero', 'pra')}`);
ok(g('Paolo Banchero', 'tov') === 'over|4', `his turnovers at the 3.5 set on the card: ${g('Paolo Banchero', 'tov')}`);
ok(g('Cam Spencer', 'pts') === 'under|13', `Spencer's 13 against the 13.5 set, not the 13 read (a push): ${g('Cam Spencer', 'pts')}`);
ok(g('Franz Wagner', 'pts') === 'void|null', `a player who sat: ${g('Franz Wagner', 'pts')}`);
ok(row('Anthony Black', 'pts').result == null, 'a player not in the box, with a game still to read: he waits');
const rec1 = (await hit('/api/nba-props')).record;
const finished = sq.prepare("SELECT market, result, read_sharp, typed_line, typed_sharp FROM pp_props WHERE result IN ('under','over')").all();
ok(rec1.graded === finished.length && finished.length > 3, `the record: ${rec1.graded} decided, pushes and voids not among them`);
let n54 = 0, h54 = 0;
for (const r of finished) {
  const u = r.typed_line != null ? r.typed_sharp : r.read_sharp;
  if (u == null) continue;
  const under = u >= 50;
  if ((under ? u : 100 - u) >= 54) { n54++; if ((r.result === 'under') === under) h54++; }
}
ok(rec1.at54.n === n54 && rec1.at54.hit === h54, `54%+ on the side the sharp books took, by hand: ${h54} of ${n54} (${rec1.at54.hit} of ${rec1.at54.n})`);
await tick('4-59/10 * * * *');
ok((await hit('/api/nba-props')).record.graded === rec1.graded, 'grading again counts nothing twice');
sq.prepare("UPDATE nba_box_games SET done = 1 WHERE game_id = '401900002'").run();
NOW = TIP + 24 * 3600e3;
await mod.default.scheduled({ cron: '4-59/10 * * * *' }, env, { waitUntil: () => {} });
const held = [];
await mod.default.scheduled({ cron: '*/5 * * * *' }, env, { waitUntil: (p) => held.push(p) });
await Promise.allSettled(held);
ok(row('Anthony Black', 'pts').result === 'void', `the next day, every game read and he isn't in one: void (${row('Anthony Black', 'pts').result})`);
void legs;

if (process.env.PROPS_DUMP) fs.writeFileSync(process.env.PROPS_DUMP, JSON.stringify(b));
console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
