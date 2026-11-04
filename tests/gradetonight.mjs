// Results as games finish (2026-11-04).
//
// Every log graded `date < today`, so a game that ended at 7 PM read pending until midnight Pacific:
// Tuesday's picks were still pending at 11:54 PM with all but one game over. What has to hold:
//   - a trigger of its own grades today's rows once their game could be over, game lines and the NBA
//     and NHL legs alike, from the real finals, and reads nothing before then
//   - the five-minute invocation still doesn't: its request budget stays as it was
//   - a game still being played, or an NHL box not yet official, stays open
//   - today a player missing from the box scores proves nothing. His game may not have started, so
//     nothing is voided by absence, nor is a soccer fixture counted as moved, until the day is over
//   - the day's legs and edge bets follow, and the day's entries join the totals only when it closes,
//     since a later game can still put a leg above the two that finished
//   - a box from before the final buzzer is not taken for the final one
//
// Recorded: Tuesday Nov 3's NHL scores and two box scores, its Champions League board, Monday Nov 2's
// NBA board and the Cavaliers-Thunder box, and Week 3's Falcons-Packers. All were final by the time
// they were recorded, so the middle of the evening is those responses with only the state of the
// later games set back.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = (f) => JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', f), 'utf8'));

const RealDate = Date;
let NOW = RealDate.parse('2026-11-04T04:30:00Z');        // Tuesday 8:30 PM Pacific
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const NHL_SCORE = FIX('nhl-score-final-20261103.json');
const nhlBoxes = { 2026020238: FIX('nhl-box-2026020238.json'), 2026020239: FIX('nhl-box-2026020239.json') };
const UCL = FIX('espn-ucl-sb-final-20261103.json');
const NBA_SB = FIX('espn-nba-sb-final-20261102.json');
const NBA_BOX = FIX('espn-nba-box-final-401909907.json');
const NFL_WK3 = FIX('espn-nfl-2026-wk3-scoreboard.json');
const NFL_BOX = FIX('espn-nfl-boxscore-401872948.json');

// The evening as it stood: state by NHL away team, NBA event ids still being played.
let nhlStates = {};
let nbaFinal = null;
let nhlBoxDown = false;
let nbaBoxPayload = NBA_BOX;
const asked = [];
globalThis.fetch = async (u) => {
  const url = String(u);
  asked.push(url);
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('api-web.nhle.com/v1/score/2026-11-03')) {
    return json({ games: NHL_SCORE.games.map((g) => ({ ...g, gameState: nhlStates[g.awayTeam.abbrev] || g.gameState })) });
  }
  const box = url.match(/gamecenter\/(\d+)\/boxscore/);
  if (box) {
    if (nhlBoxDown) return new Response('', { status: 503 });
    return json(nhlBoxes[box[1]] || { playerByGameStats: {} });
  }
  if (url.includes('cdn.espn.com') && url.includes('league=uefa.champions') && url.includes('date=20261103')) return json(UCL);
  if (url.includes('cdn.espn.com') && url.includes('nba/scoreboard') && url.includes('date=20261102')) {
    const events = NBA_SB.content.sbData.events.map((e) => (nbaFinal == null || nbaFinal.includes(e.id) ? e
      : { ...e, status: { type: { name: 'STATUS_IN_PROGRESS', state: 'in', completed: false } } }));
    return json({ content: { sbData: { events } } });
  }
  if (url.includes('boxscore') && url.includes('gameId=401909907')) return json(nbaBoxPayload);
  if (url.includes('nfl/scoreboard') && url.includes('week=3')) return json(NFL_WK3);
  if (url.includes('boxscore') && url.includes('gameId=401872948')) return json(NFL_BOX);
  if (url.includes('cdn.espn.com') && url.includes('scoreboard')) return json({ content: { sbData: { events: [] } } });
  return new Response('{}', { status: 404 });
};

const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const exec = (sql, args, mode) => { const st = sq.prepare(sql); const a = args.map(norm);
  if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
  return { success: true, meta: { changes: Number(st.run(...a).changes) } }; };
const DB = { prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
  all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
  run: async () => exec(s.sql, s.args, 'run') }; return s; }, batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')) };
const env = { DB, ODDS_API_KEY: '' };

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const toml = fs.readFileSync(BOARD + '/wrangler.toml', 'utf8');
const CRONS = JSON.parse((toml.match(/^crons = (\[.*\])/m) || [])[1] || '[]');
const GRADE_CRON = (src.match(/const GRADE_CRON = '([^']+)'/) || [])[1];

const fire = async (cron) => {
  const jobs = [];
  await mod.default.scheduled({ cron, scheduledTime: NOW }, env, { waitUntil: (p) => jobs.push(p) });
  await Promise.allSettled(jobs);
};
const tonight = () => fire(GRADE_CRON);

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const hit = (u) => mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} });

console.log('-- its own trigger --');
ok(!!GRADE_CRON && CRONS.includes(GRADE_CRON), `wrangler.toml carries it: ${GRADE_CRON}`);
ok(CRONS.length <= 5, `within the free plan's five triggers: ${CRONS.length}`);
ok(new Set(CRONS).size === CRONS.length, 'none twice');

await hit('/api/gmpicks-export');        // the tables
await hit('/api/nhl-pp');
await hit('/api/nba-pp');
await hit('/api/picks');

const gm = sq.prepare(`INSERT INTO gmpicks (sport, date, game_id, market, league, commence, side, pick, home, away, win_prob, entry_price, book, fair_src, sharp_n, model_ver, result)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 70, -200, 'draftkings', 'sharp-pool', 4, 'gm-v1', ?)`);
const gmRow = (sport, date, id, league, commence, side, home, away, result = null) =>
  gm.run(sport, date, id, 'h2h', league, commence, side, side === 'home' ? home : away, home, away, result);
const gmOf = (id) => sq.prepare('SELECT result, home_score, away_score FROM gmpicks WHERE game_id = ?').get(id);

const nhl = sq.prepare('INSERT INTO nhlpp (date, game_id, player, market, commence, home, away, team, player_id, point, model_under) VALUES (?,?,?,?,?,?,?,?,?,?,60)');
const nhlOf = (p, m) => sq.prepare('SELECT result, actual FROM nhlpp WHERE player = ? AND market = ?').get(p, m);

// ---- Game lines ----------------------------------------------------------------------------------
console.log('\n-- Tuesday 8:30 PM: the game lines --');
const TUE = '2026-11-03';
nhlStates = { ANA: 'LIVE' };
gmRow('nhl', TUE, 'det-tbl', 'reg', '2026-11-04T00:00:00Z', 'home', 'Tampa Bay Lightning', 'Detroit Red Wings');
gmRow('nhl', TUE, 'edm-njd', 'reg', '2026-11-04T00:30:00Z', 'away', 'New Jersey Devils', 'Edmonton Oilers');
gmRow('nhl', TUE, 'ana-van', 'reg', '2026-11-04T02:00:00Z', 'home', 'Vancouver Canucks', 'Anaheim Ducks');
gmRow('soccer', TUE, 'bar-avl', 'ucl', '2026-11-03T20:00:00Z', 'home', 'Barcelona', 'Aston Villa');
// A kickoff the feed listed and moved, as St. Louis and the Red Bulls were: the same pairing, graded later.
gmRow('soccer', TUE, 'moved-a', 'ucl', '2026-11-03T20:00:00Z', 'home', 'Club Brugge', 'Benfica');
gmRow('soccer', '2026-11-04', 'moved-b', 'ucl', '2026-11-04T20:00:00Z', 'home', 'Club Brugge', 'Benfica', 'win');

await fire('*/5 * * * *');
ok(gmOf('det-tbl').result == null && gmOf('bar-avl').result == null, 'the five-minute invocation still leaves today alone');
asked.length = 0;
await tonight();
ok(gmOf('det-tbl').result === 'win' && gmOf('det-tbl').home_score === 4 && gmOf('det-tbl').away_score === 2, `Lightning 4-2, final: ${JSON.stringify(gmOf('det-tbl'))}`);
ok(gmOf('edm-njd').result === 'loss' && gmOf('edm-njd').home_score === 4, `Oilers lost 4-3 at the Devils: ${JSON.stringify(gmOf('edm-njd'))}`);
ok(gmOf('bar-avl').result === 'win' && gmOf('bar-avl').home_score === 3, `Barcelona 3-0, full time: ${JSON.stringify(gmOf('bar-avl'))}`);
ok(gmOf('ana-van').result == null, 'Ducks at Canucks still being played: open');
ok(gmOf('moved-a').result == null, 'a fixture not on the board today is not called moved before the day is over');

console.log('\n-- too soon: nothing is asked for --');
sq.prepare("DELETE FROM gmpicks WHERE game_id IN ('ana-van', 'moved-a', 'moved-b')").run();
gmRow('nhl', TUE, 'late', 'reg', '2026-11-04T03:30:00Z', 'home', 'Vancouver Canucks', 'Anaheim Ducks');
asked.length = 0;
await tonight();
const graderAsked = () => asked.filter((u) => !u.includes('hockey/nhl/scoreboard')).length;
ok(graderAsked() === 0, `a game an hour old, and the graders ask for nothing: ${graderAsked()}`);
sq.prepare("DELETE FROM gmpicks WHERE game_id = 'late'").run();

// ---- NHL legs ------------------------------------------------------------------------------------
console.log('\n-- Tuesday 8:30 PM: the NHL legs --');
nhlStates = { ANA: 'LIVE', CAR: 'FINAL' };
nhl.run(TUE, 'det-tbl', 'Brayden Point', 'pts', '2026-11-04T00:00:00Z', 'Tampa Bay Lightning', 'Detroit Red Wings', 'TBL', '8478010', 1.5);
nhl.run(TUE, 'edm-njd', 'Nico Hischier', 'ast', '2026-11-04T00:30:00Z', 'New Jersey Devils', 'Edmonton Oilers', 'NJD', '8480002', 0.5);
nhl.run(TUE, 'det-tbl', 'A Scratch', 'pts', '2026-11-04T00:00:00Z', 'Tampa Bay Lightning', 'Detroit Red Wings', 'TBL', '1', 0.5);
nhl.run(TUE, 'car-nsh', 'Not Official', 'pts', '2026-11-04T01:00:00Z', 'Nashville Predators', 'Carolina Hurricanes', 'NSH', '2', 0.5);
nhl.run(TUE, 'ana-van', 'Still Playing', 'pts', '2026-11-04T02:00:00Z', 'Vancouver Canucks', 'Anaheim Ducks', 'VAN', '3', 0.5);
sq.prepare("DELETE FROM feed_cache WHERE key = 'nhl_pp_grade'").run();
asked.length = 0;
await tonight();
ok(nhlOf('Brayden Point', 'pts').result === 'over' && nhlOf('Brayden Point', 'pts').actual === 2, `Point, 2 points over 1.5: ${JSON.stringify(nhlOf('Brayden Point', 'pts'))}`);
ok(nhlOf('Nico Hischier', 'ast').result === 'over' && nhlOf('Nico Hischier', 'ast').actual === 1, `Hischier, 1 assist over 0.5: ${JSON.stringify(nhlOf('Nico Hischier', 'ast'))}`);
ok(nhlOf('A Scratch', 'pts').result == null, 'a player missing from a finished box: open, not void, until the day is over');
ok(nhlOf('Not Official', 'pts').result == null, 'a game final but not yet official: open');
ok(nhlOf('Still Playing', 'pts').result == null, 'a game being played: open');
const nhlBoxesRead = asked.filter((u) => u.includes('/boxscore') && u.includes('gamecenter')).map((u) => u.match(/gamecenter\/(\d+)/)[1]);
ok(nhlBoxesRead.length === 2 && nhlBoxesRead.includes('2026020238') && nhlBoxesRead.includes('2026020239'), `only the boxes a leg waits on, of nine official games: ${nhlBoxesRead.join(', ')}`);
ok(sq.prepare("SELECT key FROM feed_cache WHERE key = 'nhl_pp_grade'").get() === undefined, 'and the hourly pass keeps its own gate');
// Every game over, one not yet official, whose box this pass does not read: its players are not absent.
nhlStates = { CAR: 'FINAL' };
await tonight();
ok(nhlOf('Not Official', 'pts').result == null && nhlOf('A Scratch', 'pts').result == null, 'with every game over but one not official: still open');

// ---- The day closes -----------------------------------------------------------------------------
console.log('\n-- after midnight, the day is over --');
NOW = RealDate.parse('2026-11-04T08:30:00Z');            // Wednesday 12:30 AM Pacific
nhlStates = {};
nhlBoxDown = true;
sq.prepare("DELETE FROM feed_cache WHERE key = 'nhl_pp_grade'").run();
await fire('*/5 * * * *');
ok(nhlOf('A Scratch', 'pts').result == null, 'a box that would not load voids no one: the grade waits for the next pass');
nhlBoxDown = false;
sq.prepare("DELETE FROM feed_cache WHERE key = 'nhl_pp_grade'").run();
await fire('*/5 * * * *');
ok(nhlOf('A Scratch', 'pts').result === 'void', `and with it read, absence is a void: ${nhlOf('A Scratch', 'pts').result}`);
ok(nhlOf('Not Official', 'pts').result === 'void' && nhlOf('Still Playing', 'pts').result === 'void', 'the hourly pass reads the rest as it always did');
gmRow('soccer', TUE, 'moved-a', 'ucl', '2026-11-03T20:00:00Z', 'home', 'Club Brugge', 'Benfica');
gmRow('soccer', '2026-11-04', 'moved-b', 'ucl', '2026-11-04T20:00:00Z', 'home', 'Club Brugge', 'Benfica', 'win');
await fire('*/5 * * * *');
ok(gmOf('moved-a').result === 'void', `and the moved fixture is voided now: ${gmOf('moved-a').result}`);

// ---- NBA legs ------------------------------------------------------------------------------------
console.log('\n-- Monday 7:10 PM: the NBA legs --');
NOW = RealDate.parse('2026-11-03T03:10:00Z');
const MON = '2026-11-02';
nbaFinal = ['401909907'];
const nba = sq.prepare('INSERT INTO nbapp (date, game_id, player, market, league, commence, home, away, team, player_id, point, model_under) VALUES (?,?,?,?,?,?,?,?,?,?,?,60)');
const nbaOf = (p) => sq.prepare('SELECT result, actual FROM nbapp WHERE player = ?').get(p);
nba.run(MON, 'cle-okc', 'Shai Gilgeous-Alexander', 'threes', 'reg', '2026-11-03T00:00:00Z', 'Oklahoma City Thunder', 'Cleveland Cavaliers', 'OKC', '4278073', 3.5);
nba.run(MON, 'cle-okc', 'Tristan Enaruna', 'reb', 'reg', '2026-11-03T00:00:00Z', 'Oklahoma City Thunder', 'Cleveland Cavaliers', 'CLE', '4431734', 2.5);
// Sacramento's game started two hours ago and is still on: nothing of his is in the box scores yet.
nba.run(MON, 'dal-sac', 'Domantas Sabonis', 'reb', 'reg', '2026-11-03T01:00:00Z', 'Sacramento Kings', 'Dallas Mavericks', 'SAC', '3155942', 12.5);
// Los Angeles at Miami has only just tipped.
nba.run(MON, 'lal-mia', 'Bam Adebayo', 'reb', 'reg', '2026-11-03T03:00:00Z', 'Miami Heat', 'Los Angeles Lakers', 'MIA', '4066261', 9.5);
await fire('*/5 * * * *');
ok(nbaOf('Shai Gilgeous-Alexander').result == null, 'the five-minute invocation still leaves today alone');
sq.prepare("DELETE FROM feed_cache WHERE key = 'nba_box_scan'").run();
sq.prepare('DELETE FROM nba_box_games').run(); sq.prepare('DELETE FROM nba_box').run();

console.log('-- a box from before the final buzzer --');
const early = JSON.parse(JSON.stringify(NBA_BOX));
early.gamepackageJSON.header.competitions[0].status = { type: { name: 'STATUS_IN_PROGRESS', state: 'in', completed: false } };
nbaBoxPayload = early;
await tonight();
ok(nbaOf('Shai Gilgeous-Alexander').result == null, 'its numbers are not taken');
ok(sq.prepare('SELECT done FROM nba_box_games WHERE game_id = ?').get('401909907')?.done === 0, 'and it is read again next pass');
nbaBoxPayload = NBA_BOX;

console.log('-- the real one --');
await tonight();
ok(nbaOf('Shai Gilgeous-Alexander').result === 'over' && nbaOf('Shai Gilgeous-Alexander').actual === 4, `Gilgeous-Alexander, 4 threes over 3.5: ${JSON.stringify(nbaOf('Shai Gilgeous-Alexander'))}`);
ok(nbaOf('Tristan Enaruna').result === 'void', `a DNP in a finished box is void at once: ${nbaOf('Tristan Enaruna').result}`);
ok(nbaOf('Domantas Sabonis').result == null, 'Sacramento still being played, no box yet, every game read so far is in: open, not void');
ok(nbaOf('Bam Adebayo').result == null, 'nor one that has only just tipped');

console.log('-- a quiet evening reads nothing --');
sq.prepare('UPDATE nbapp SET result = ? WHERE result IS NULL', ).run('void');
sq.prepare("DELETE FROM feed_cache WHERE key = 'nba_box_scan'").run();
asked.length = 0;
await tonight();
ok(graderAsked() === 0, `no legs waiting, no scoreboard: ${graderAsked()} requests`);

// ---- The day's legs and edge bets ------------------------------------------------------------------
console.log('\n-- the record follows --');
NOW = RealDate.parse('2026-11-04T02:30:00Z');            // Tuesday 6:30 PM Pacific
sq.prepare('DELETE FROM gmpicks').run();
nhlStates = {};
gmRow('nhl', TUE, 'det-tbl', 'reg', '2026-11-04T00:15:00Z', 'home', 'Tampa Bay Lightning', 'Detroit Red Wings');
gmRow('nhl', TUE, 'edm-njd', 'reg', '2026-11-04T00:15:00Z', 'home', 'New Jersey Devils', 'Edmonton Oilers');
gmRow('nhl', TUE, 'ana-van', 'reg', '2026-11-04T03:30:00Z', 'home', 'Vancouver Canucks', 'Anaheim Ducks');
const leg = sq.prepare(`INSERT INTO daypicks (date, leg_id, kind, src_date, game_id, market, team, label, p, commence, rank, on_list, in_pool, pool_p, seen_at, result)
  VALUES (?, ?, 'nhl_ml', ?, ?, 'h2h', ?, ?, ?, ?, 1, 1, 1, ?, ?, ?)`);
const addLeg = (date, id, game, team, p, commence, result = null) => leg.run(date, id, date, game, team, team, p, commence, p, commence, result);
sq.prepare('DELETE FROM daypicks').run();
addLeg(TUE, 'a', 'det-tbl', 'Lightning', 70, '2026-11-04T00:15:00Z');
addLeg(TUE, 'b', 'edm-njd', 'Devils', 68, '2026-11-04T00:15:00Z');
addLeg(TUE, 'c', 'ana-van', 'Canucks', 66, '2026-11-04T03:30:00Z');
addLeg('2026-11-02', 'y1', 'x1', 'Celtics', 80, '2026-11-03T00:00:00Z', 'hit');
addLeg('2026-11-02', 'y2', 'x2', 'Knicks', 75, '2026-11-03T00:00:00Z', 'hit');
sq.prepare(`INSERT INTO edgebets (date, key, sport, market, label, commence, book, grade, first_price, first_fair, first_stake)
  VALUES (?, 'e1', 'nhl', 'h2h', 'Lightning', '2026-11-04T00:15:00Z', 'draftkings', ?, -150, 62, 0.01)`).run(TUE, JSON.stringify({ t: 'row', sport: 'nhl', game_id: 'det-tbl', market: 'h2h', pick: 'Tampa Bay Lightning' }));
await tonight();
const dp = (id) => sq.prepare('SELECT result FROM daypicks WHERE leg_id = ?').get(id).result;
ok(dp('a') === 'hit' && dp('b') === 'hit', `2 hours 15 after the start, the day's legs read the graded lines: ${dp('a')}, ${dp('b')}`);
ok(dp('c') == null, 'the late game stays open');
const eb = sq.prepare("SELECT result FROM edgebets WHERE key = 'e1'").get().result;
ok(eb === 'hit', `and the edge bet: ${eb}`);

const read = async () => (await (await hit('/api/picks')).json()).record.history;
let h = await read();
const today = h.days.find((d) => d.date === TUE);
ok(today && today.hit === 2 && today.decided === 2 && today.pending === 1, `today's card has them: ${today && `${today.hit} of ${today.decided}, ${today.pending} to go`}`);
const p2 = (x) => x.entries.find((e) => e.key === 'p2');
ok(p2(h).days === 1 && p2(h).won === 1, `today's top two both landed, and the totals wait for the day to close: ${p2(h).won} of ${p2(h).days}`);
NOW = RealDate.parse('2026-11-04T08:30:00Z');
h = await read();
ok(p2(h).days === 2 && p2(h).won === 2, `after midnight they count: ${p2(h).won} of ${p2(h).days}`);

// ---- NFL ---------------------------------------------------------------------------------------------
console.log('\n-- Thursday night, Week 3: the NFL game line and passing touchdowns --');
NOW = RealDate.parse('2026-09-25T04:00:00Z');            // 9 PM Pacific; the recorded Falcons-Packers kicked off at 5:15
const THU = '2026-09-24';
const nflRow = sq.prepare(`INSERT INTO gmpicks (sport, date, game_id, market, league, week, commence, side, pick, point, home, away, win_prob, entry_price, book, fair_src, sharp_n, model_ver)
  VALUES (?, ?, ?, ?, 'REG', 3, ?, ?, ?, ?, 'Green Bay Packers', 'Atlanta Falcons', 60, -120, 'draftkings', 'sharp-pool', 4, 'gm-v1')`);
nflRow.run('nfl', THU, 'atl-gb', 'h2h', '2026-09-25T00:15:00Z', 'away', 'Atlanta Falcons', null);
nflRow.run('nflptd', THU, 'atl-gb', 'pass_tds', '2026-09-25T00:15:00Z', 'under', 'Michael Penix Jr. under 1.5', 1.5);
await tonight();
ok(gmOf('atl-gb') && sq.prepare("SELECT result, away_score FROM gmpicks WHERE sport = 'nfl' AND game_id = 'atl-gb'").get().result === 'win', 'Falcons 35-14, final');
const ptd = sq.prepare("SELECT result, home_score FROM gmpicks WHERE sport = 'nflptd' AND game_id = 'atl-gb'").get();
ok(ptd.result === 'win' && ptd.home_score === 1, `Penix threw one, under 1.5: ${JSON.stringify(ptd)}`);

// ---- The query --------------------------------------------------------------------------------------
console.log('\n-- the read stays on the open rows --');
const plan = (sql, ...a) => sq.prepare('EXPLAIN QUERY PLAN ' + sql).all(...a).map((r) => r.detail).join('; ');
const graderSql = [...src.matchAll(/'(SELECT \* FROM (?:nhlpp|nbapp) WHERE result IS NULL AND date = \? AND commence < \?)'|"(SELECT \* FROM gmpicks WHERE [^"]*date = \? AND commence < \?)"/g)].map((m) => m[1] || m[2]);
ok(graderSql.length >= 4, `the graders' same-day reads: ${graderSql.length}`);
for (const s of graderSql) {
  const p = plan(s, TUE, '2026-11-04');
  ok(/USING (COVERING )?INDEX (gmpicks_ungraded|nhlpp_ungraded|nbapp_ungraded)/.test(p), `${s.slice(14, 21)}: ${p}`);
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
