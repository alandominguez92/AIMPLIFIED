// A long run against a soft team, logged and nothing else (2026-11-01, the owner's idea and
// call). The Under after 5+ games in a row above his own average, against a team in the top
// third for allowing that stat, went 57.0% where the sharp books said 50.5: a lead, to be
// watched as tested. What has to hold:
//   - it shares the streak log's read: a game either log wants is read once, and a game
//     neither wants spends nothing
//   - a run is games in a row above his own average up to each one; he has 10+ games and
//     20+ minutes over his last five
//   - a team's rank is what it allowed in games before that day, 10+ of them, with 20+
//     teams ranked; 5+ in a row against the top third is what pays for a read
//   - with a read paid for, runs of 3 and 4 and runs against other teams come along too,
//     so the record can say whether the opponent and the run's length matter
//   - graded from the box scores; a leg he did not play is void
//   - nothing reaches a page: /api/nba-cause alone reads it
//
// Real data: the league's real box rows to Jan 15 2026 (nba-box-league-to-20260115.json) and
// that night's real results. Jazz @ Mavericks is the night it should fire: Naji Marshall had 5
// in a row against the softest team in the league. Grizzlies @ Magic is the night it should
// not: Cam Spencer had 5 in a row, against a team in the tough third. The only raw odds
// payload the repo has from that night is Grizzlies @ Magic's (hist-props-nba-20260115.json),
// so the Jazz @ Mavericks read is that payload with the names swapped; the sharp numbers
// asserted are what production stored for those lines. Real SQLite and the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = path.join(BOARD, 'tests', 'fixtures');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const read = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const yearOn = (s) => String(s).replace(/2026-01-1(\d)/g, '2027-01-1$1').replace(/2026-01-0(\d)/g, '2027-01-0$1').replace(/2025-(1[0-2])/g, '2026-$1');
const shifted = (x) => JSON.parse(yearOn(JSON.stringify(x)));
const P = read('hist-props-nba-20260115.json'), SB = read('espn-nba-sb-20260115.json');
const INJ = read('espn-nba-game-injuries-20261101.json').games, LEAGUE = read('nba-box-league-to-20260115.json');
const expand = (r) => ({ game_id: LEAGUE.games[r[0]][0], date: yearOn(LEAGUE.games[r[0]][1]), player_id: LEAGUE.players[r[1]][0], player: LEAGUE.players[r[1]][1], team: r[2], min: r[3], pts: r[4], reb: r[5], ast: r[6], threes: r[7] });
const HISTORY = LEAGUE.rows.map(expand);
const MAVS = '401810438', MAGIC = '401810433';
const NIGHT = { [MAVS]: LEAGUE.tonight[MAVS].map(expand), [MAGIC]: LEAGUE.tonight[MAGIC].map(expand) };
const MAVS_EVENT = P.events.find((e) => /Utah Jazz/.test(e.game)).id, MAGIC_EVENT = P.odds.data.id;
const TIP = { [MAVS]: Date.parse('2027-01-16T01:30:00Z'), [MAGIC]: Date.parse('2027-01-15T19:00:00Z') };

const RealDate = Date;
let NOW = 0;
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
const J = (x, h = {}) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json', ...h } });

// A real report entry, the player swapped.
const realEntry = Object.values(INJ).flatMap((f) => (f.gamepackageJSON || f).injuries || []).flatMap((t) => t.injuries || []).find((i) => i.status === 'Out' && i.details && i.details.fantasyStatus && i.details.fantasyStatus.abbreviation === 'OUT');
const listed = (id, name) => { const e = JSON.parse(JSON.stringify(realEntry)); Object.assign(e.athlete, { id, displayName: name, lastName: name.split(' ').pop() }); return e; };
const feedOf = (teams) => ({ gamepackageJSON: { injuries: Object.entries(teams).map(([displayName, injuries]) => ({ team: { displayName }, injuries })) } });

// The one raw payload there is, as Jazz @ Mavericks: each real name on it stands for a man in that game.
const SWAPS = { 'Cam Spencer': 'Naji Marshall', 'Paolo Banchero': 'Cody Williams', 'Cedric Coward': 'Ryan Nembhard', 'Jock Landale': 'Anthony Davis',
  'Tristan da Silva': 'Jusuf Nurkic', 'Noah Penda': 'Daniel Gafford', 'Desmond Bane': 'Klay Thompson' };
const mavsBody = () => { let text = JSON.stringify(shifted(P.odds.data));
  for (const [a, b] of Object.entries(SWAPS)) text = text.split(a).join(b);
  return { ...JSON.parse(text), id: MAVS_EVENT, home_team: 'Dallas Mavericks', away_team: 'Utah Jazz', commence_time: '2027-01-16T01:40:00Z' }; };
const magicBody = () => shifted(P.odds.data);

function scene({ games, report = {}, body = () => mavsBody(), rows = HISTORY }) {
  const sq = new DatabaseSync(':memory:');
  const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
  const exec = (sql, args, mode) => { const st = sq.prepare(sql); const a = args.map(norm);
    if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
    if (/^\s*(SELECT|WITH)/i.test(sql)) return { results: st.all(...a), meta: {} };
    return { success: true, meta: { changes: Number(st.run(...a).changes) } }; };
  const DB = { prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
    all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
    run: async () => exec(s.sql, s.args, 'run') }; return s; }, batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')) };
  return { sq, env: { DB, ODDS_API_KEY: 'k' }, games, report, body, rows, reads: [] };
}
let S = null;
globalThis.fetch = async (u) => {
  const url = String(u);
  // That day's real slate, a year on, cut to the games the scene is about. Never final: the
  // box rows go in by hand, the cron's own box read is tests/nbacause.mjs's.
  if (/cdn\.espn\.com\/core\/nba\/scoreboard\?xhr=1&date=20270115/.test(url)) {
    const j = shifted(SB);
    j.content.sbData.events = j.content.sbData.events.filter((e) => S.games.includes(String(e.id)));
    for (const e of j.content.sbData.events) { if (e.status && e.status.type) e.status.type.name = 'STATUS_SCHEDULED'; }
    return J(j);
  }
  if (/cdn\.espn\.com\/core\/nba\/scoreboard/.test(url)) return J({ content: { sbData: { events: [] } } });
  const inj = url.match(/\/nba\/game\?xhr=1&gameId=(\d+)/);
  if (inj) return J(S.report[inj[1]] || feedOf({}));
  const ev = url.match(/\/sports\/basketball_nba\/events\/([^/]+)\/odds\?(.*)$/);
  if (ev) {
    const q = new URLSearchParams(ev[2]);
    if (!(q.get('markets') || '').includes('player_points')) return J({ id: ev[1], bookmakers: [] }, { 'x-requests-last': '0', 'x-requests-remaining': '60000' });
    S.reads.push({ id: ev[1], markets: q.get('markets') });
    return J(S.body(ev[1]), { 'x-requests-last': '7', 'x-requests-remaining': '60000' });
  }
  if (/\/sports\/basketball_nba\/events\?/.test(url)) {
    return J(P.events.map((e) => { const [away, home] = e.game.split(' @ '); return { id: e.id, commence_time: yearOn(e.commence), home_team: home, away_team: away }; }), { 'x-requests-last': '0' });
  }
  return new Response('{}', { status: 404 });
};
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
// A module per scene, as a fresh isolate: the worker remembers which tables it has widened.
let mod = null, scenes = 0;
const loadWorker = async () => { mod = await import('data:text/javascript;base64,' + Buffer.from(`${src}\n// scene ${++scenes}`).toString('base64')); };
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), S.env, { waitUntil: () => {} })).json();
const tick = async () => { const held = []; await mod.default.scheduled({ cron: '*/5 * * * *', scheduledTime: NOW }, S.env, { waitUntil: (p) => held.push(p) }); await Promise.all(held); };
const all = (sql, ...a) => S.sq.prepare(sql).all(...a);
const insBox = (rows) => { const ins = S.sq.prepare('INSERT INTO nba_box (game_id, date, season_type, player_id, player, team, min, pts, reb, ast, threes, dnp) VALUES (?,?,2,?,?,?,?,?,?,?,?,0)');
  for (const r of rows) ins.run(r.game_id, r.date, r.player_id, r.player, r.team, r.min, r.pts, r.reb, r.ast, r.threes); };
const start = async (game) => { await loadWorker(); await get('/api/nba-pp'); insBox(S.rows); NOW = TIP[game] - 3 * 3600e3; await tick(); NOW = TIP[game] - 55 * 60e3; await tick(); };

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const near = (a, b, d = 0.051) => a != null && Math.abs(a - b) <= d;

console.log('-- the night: Jazz @ Mavericks, Marshall 5 in a row against the softest team --');
NOW = TIP[MAVS] - 3 * 3600e3;
S = scene({ games: [MAVS] });
await loadWorker();
await get('/api/nba-pp');
insBox(S.rows);
await tick();
ok(S.reads.length === 0, 'three hours out: nothing read yet');
NOW = TIP[MAVS] - 55 * 60e3;
await tick();
console.log(`  ${JSON.stringify(S.reads.map((r) => r.id))}`);
ok(S.reads.length === 1 && S.reads[0].id === MAVS_EVENT, 'an hour out: one read, of this game');
ok(S.reads[0] && S.reads[0].markets.split(',').length === 7, 'the same seven markets as the streak log');
ok(all('SELECT * FROM nbacause').length === 0, 'no one on the report: nothing in the streak log');
const usage = await get('/api/usage');
const usageRow = Object.values(usage.routes || {}).flat().find((x) => x.route === 'nba:reg:hot');
ok(usageRow && usageRow.credits === 7 && usageRow.calls === 1, `on the ledger under its own name: ${JSON.stringify(usageRow)}`);
const rows = all('SELECT * FROM nbahot ORDER BY player, market');
console.log(`  ${rows.map((r) => `${r.player} ${r.market} ${r.pp_line} run ${r.run} rank ${r.opp_rank}/${r.opp_rank_usual} sharp ${r.sharp_under}`).join(' | ')}`);
const leg = (who, m) => rows.find((r) => r.player === who && r.market === m);
const marshall = rows.filter((r) => r.player === 'Naji Marshall');
ok(marshall.length === 4 && marshall.every((r) => r.run === 5 && r.opp_rank === 1 && r.team === 'DAL' && r.opp === 'UTAH'), 'Marshall: points and his three combos at 5 in a row, Utah ranked last of 30, as the backtest has them');
ok(!leg('Naji Marshall', 'reb_ast'), 'no run in rebounds + assists: that leg posted, not logged');
ok(leg('Naji Marshall', 'pts_reb').opp_rank_usual === 0.966 && leg('Naji Marshall', 'pts').opp_rank_usual === 1, 'the rank allowing for who they faced is kept beside it: 0.966, as the backtest has it');
ok(leg('Naji Marshall', 'pra').sharp_under === 49.6 && leg('Naji Marshall', 'pts_reb').sharp_under === 52.5 && leg('Naji Marshall', 'pts_ast').sharp_under === 50.6, 'the sharp read production stored for those lines: 49.6, 52.5, 50.6');
ok(leg('Naji Marshall', 'pts').sharp_under === null && leg('Naji Marshall', 'pts').pp_line === 13 && leg('Naji Marshall', 'pts').gap === -0.5, 'a line no sharp book quoted: logged, unpriced');
ok(near(leg('Naji Marshall', 'pts').season_avg, 13.8) && near(leg('Naji Marshall', 'pts').last5, 18.4) && near(leg('Naji Marshall', 'pts').min5, 32.6), `what the run looked like: ${leg('Naji Marshall', 'pts').last5} over five games against a ${leg('Naji Marshall', 'pts').season_avg} season`);
const w = (m) => leg('Cody Williams', m);
ok(w('pts').run === 8 && w('pts').opp_rank === 0.621 && w('pts_ast').opp_rank === 0.552 && w('pra').opp_rank === 0.724 && w('pts_reb').opp_rank === 0.724, 'Cody Williams, 8 in a row: two of his legs against the top third, two not, the rank being by stat');
ok(leg('Ryan Nembhard', 'reb_ast').run === 3 && leg('Ryan Nembhard', 'reb_ast').opp_rank === 0.966, 'Nembhard, 3 in a row: comes along with the read');
ok(rows.some((r) => r.player === 'Anthony Davis') && rows.some((r) => r.player === 'Jusuf Nurkic'), 'Davis and Nurkic, on runs and not on the report: logged, and the box score settles it later');
ok(!rows.some((r) => r.player === 'Daniel Gafford'), 'Gafford, 5 in a row in rebounds alone, no rebounds market on this payload: no leg');
ok(!rows.some((r) => r.player === 'Klay Thompson'), 'Thompson, posted, no run: no');
ok(rows.length === 14, `the whole list, ${rows.length} legs`);
const nba = await get('/api/nba-pp');
ok(!JSON.stringify(nba).includes('nbahot') && !/nbahot|hotRun/.test(fs.readFileSync(BOARD + '/app.js', 'utf8')), 'nothing on a page');
NOW += 10 * 60e3;
await tick();
ok(S.reads.length === 1, 'read once: the next tick spends nothing');

console.log('\n-- after the game: the real results --');
NOW = TIP[MAVS] + 8 * 3600e3;
insBox(NIGHT[MAVS]);
await tick();
const graded = all('SELECT * FROM nbahot ORDER BY player, market');
const g = (who, m) => graded.find((r) => r.player === who && r.market === m);
console.log(`  ${graded.map((r) => `${r.player} ${r.market} ${r.pp_line}: ${r.actual} ${r.result}`).join(' | ')}`);
ok(g('Naji Marshall', 'pts').actual === 22 && g('Naji Marshall', 'pra').actual === 32 && g('Naji Marshall', 'pts_reb').actual === 28 && g('Naji Marshall', 'pts_ast').actual === 26, "Marshall's real night: 22 points, 6 rebounds, 4 assists");
ok(['pts', 'pra', 'pts_reb', 'pts_ast'].every((m) => g('Naji Marshall', m).result === 'over'), 'over all four');
ok(['pts', 'pra', 'pts_reb', 'pts_ast'].every((m) => g('Cody Williams', m).result === 'under') && g('Cody Williams', 'pra').actual === 19, 'Williams, 13 points and 6 rebounds against these lines: under all four');
ok(g('Ryan Nembhard', 'reb_ast').actual === 14 && g('Ryan Nembhard', 'reb_ast').result === 'over', "Nembhard's 14 against 9.5: over");
ok(graded.filter((r) => r.player === 'Anthony Davis' || r.player === 'Jusuf Nurkic').every((r) => r.result === 'void' && r.actual == null), 'Davis and Nurkic sat that night: void');
S.sq.prepare("INSERT INTO nbahot (event_id, player, market, espn_id, player_id, team, opp, date, pp_line, run, opp_rank, opp_rank_usual) VALUES (?,?,?,?,?,'DAL','UTAH','2027-01-15',?,5,1,1)").run(MAVS_EVENT, 'Ryan Nembhard', 'pts', MAVS, '4433629', 8);
NOW += 5 * 60e3;
await tick();
ok(all("SELECT result FROM nbahot WHERE player = 'Ryan Nembhard' AND market = 'pts'")[0].result === 'push', 'on the number: a push');
const body = await get('/api/nba-cause');
const rec = body.hotRun;
console.log(`  ${JSON.stringify(rec)}`);
ok(rec.logged === 15 && rec.pending === 0 && rec.voided === 5 && rec.pushed === 1, `the count: ${rec.logged} logged, ${rec.voided} void, ${rec.pushed} push`);
ok(rec.rule.n === 6 && rec.rule.games === 2 && rec.rule.under === 2 && near(rec.rule.underRate, 33.3), 'the rule: Marshall four, Williams two, two men, two unders');
const said = (49.6 + 52.5 + 50.6 + 52.1 + 48.4) / 5;
ok(rec.rule.priced.n === 5 && rec.rule.priced.underRate === 40 && near(rec.rule.priced.sharpSaid, said) && near(rec.rule.priced.beat, 40 - Math.round(said * 10) / 10), `the sharp books beside it, priced legs only: said ${rec.rule.priced.sharpSaid}, the gap ${rec.rule.priced.beat}`);
ok(rec.longRunOtherTeams.n === 2 && rec.longRunOtherTeams.under === 2, "Williams's other two legs: the same run, not the top third");
ok(rec.shortRunSoftTeam.n === 1 && rec.shortRunSoftTeam.under === 0, 'Nembhard: a short run, a soft team');
ok(rec.ruleAllowingForOpponents.n === 8 && rec.ruleAllowingForOpponents.under === 4, 'allowing for who they faced, Williams all count: eight legs, four under');
ok(body.record && body.record.logged === 0 && /Over where a streak has a cause/.test(body.record.note), 'the streak log answers as it did');
const day = await get('/api/nba-cause?day=2027-01-15');
ok(day.hotRows && day.hotRows.length === 15 && day.rows.length === 0, "?day= gives that day's rows from both");

console.log('\n-- Grizzlies @ Magic with no one on the report: a run against a tough team --');
S = scene({ games: [MAGIC], body: magicBody });
await start(MAGIC);
ok(S.reads.length === 0, 'Spencer 5 in a row against the tough third, Landale and Coward too: nothing read, nothing spent');
const noOne = JSON.parse((await S.env.DB.prepare("SELECT data FROM feed_cache WHERE key = 'nba_cause_games'").first()).data);
ok(noOne[MAGIC] && noOne[MAGIC].why === 'no one', 'and the game is done with');
ok(all('SELECT * FROM nbahot').length === 0, 'nothing logged');

console.log('\n-- the same game with Morant on the report: the streak log pays, this one comes along --');
S = scene({ games: [MAGIC], body: magicBody, report: { [MAGIC]: feedOf({ 'Memphis Grizzlies': [listed('4279888', 'Ja Morant')] }) } });
await start(MAGIC);
ok(S.reads.length === 1 && S.reads[0].id === MAGIC_EVENT, 'one read between the two logs');
const usage2 = Object.values((await get('/api/usage')).routes || {}).flat();
ok(usage2.some((x) => x.route === 'nba:reg:cause' && x.credits === 7) && !usage2.some((x) => x.route === 'nba:reg:hot'), 'seven credits, on the streak log\'s line');
ok(all('SELECT * FROM nbacause').length === 4, 'Landale in the streak log, as ever');
const along = all('SELECT * FROM nbahot ORDER BY player, market');
console.log(`  ${along.map((r) => `${r.player} ${r.market} ${r.pp_line} run ${r.run} rank ${r.opp_rank}`).join(' | ')}`);
const al = (who, m) => along.find((r) => r.player === who && r.market === m);
ok(al('Cam Spencer', 'reb_ast').run === 5 && al('Cam Spencer', 'reb_ast').opp_rank === 0.31 && al('Cam Spencer', 'reb_ast').sharp_under === 53.5, 'Spencer 5 in a row, rank 0.31, the sharp read production stored: what says whether the opponent matters');
ok(al('Noah Penda', 'pts_reb').run === 4 && al('Noah Penda', 'pts_reb').opp_rank === 0.621, 'Penda 4 in a row, 0.621, as the backtest has it');
ok(!along.some((r) => /Morant/.test(r.player)), 'Morant, out, is not a leg');
ok(along.length === 12, `the whole list, ${along.length} legs`);
NOW = TIP[MAGIC] + 8 * 3600e3;
insBox(NIGHT[MAGIC]);
await tick();
const rec2 = (await get('/api/nba-cause')).hotRun;
ok(rec2.rule.n === 0 && rec2.longRunOtherTeams.n === 1 && rec2.longRunOtherTeams.under === 0, "Spencer's 18 against 10.5: over, and it stands apart from the rule");
ok(all("SELECT * FROM nbacause WHERE result IS NOT NULL AND held = 1").length === 4, 'both logs graded, the streak log\'s teammate check still on');
ok(all("SELECT actual, result FROM nbahot WHERE player = 'Cam Spencer' AND market = 'pts_ast'")[0].result === 'under', "Spencer's 18 against 20.5: under, what production has for him");

console.log('\n-- too few teams with a rank --');
const fewTeams = new Set([...new Set(HISTORY.map((r) => r.team))].filter((t) => !['DAL', 'UTAH'].includes(t)).slice(0, 15).concat(['DAL', 'UTAH']));
S = scene({ games: [MAVS], rows: HISTORY.filter((r) => fewTeams.has(r.team)) });
await start(MAVS);
ok(S.reads.length === 0 && all('SELECT * FROM nbahot').length === 0, `${fewTeams.size} teams in the box scores: no ranks, no read`);

console.log('\n-- low on credits: it waits --');
S = scene({ games: [MAVS] });
await loadWorker();
await get('/api/nba-pp');
insBox(S.rows);
NOW = TIP[MAVS] - 3 * 3600e3;
await get('/api/usage');
await tick();
NOW = TIP[MAVS] - 55 * 60e3;
S.sq.prepare('INSERT OR REPLACE INTO odds_usage (day, remaining, low, calls, updated_at) VALUES (?,?,?,?,?)').run('2027-01-16', 5, 5, 1, new RealDate(NOW).toISOString());
await tick();
ok(S.reads.length === 0, 'five credits left: no read');
S.sq.prepare('INSERT OR REPLACE INTO odds_usage (day, remaining, low, calls, updated_at) VALUES (?,?,?,?,?)').run('2027-01-16', 50000, 5, 1, new RealDate(NOW).toISOString());
NOW += 5 * 60e3;
await tick();
ok(S.reads.length === 1, 'credits back, still inside the window: it reads');

console.log('\n-- a game that never finished --');
NOW = TIP[MAVS] + 3 * 86400e3;
await tick();
ok(all('SELECT * FROM nbahot WHERE result IS NULL').length === 14, 'no box score three days on: still open');
NOW = TIP[MAVS] + 5 * 86400e3;
await tick();
ok(all("SELECT * FROM nbahot WHERE result = 'void'").length === 14, 'five days on: postponed, void');

console.log('\n-- the bars, on the real season so far --');
const fnOf = (name) => { const a = src.indexOf(`function ${name}(`); return src.slice(a, src.indexOf('\n}\n', a) + 3); };
const consts = src.split('\n').filter((l) => /^const (NBA_CAUSE_(ROT_MIN|PRIOR)|NBA_HOT_\w+|NBA_BOX_STATS|NBA_COMBOS) = /.test(l)).join('\n');
const marketsLine = src.slice(src.indexOf('const NBA_CAUSE_MARKETS = '), src.indexOf('const NBA_CAUSE_KEY_MIN'));
const rankerLine = src.slice(src.indexOf('const nbaHotRanker = '), src.indexOf('// Who on this team is on a run tonight'));
const lib = new Function(`const round1 = (v) => Math.round(v * 10) / 10; const nbaInjOut = (i) => i.s === 'Out' && (!i.f || i.f === 'OUT');\n${consts}\n${marketsLine}\n${fnOf('nbaStat')}\n${fnOf('nbaCauseState')}\n${fnOf('nbaHotRun')}\n${fnOf('nbaHotAllowed')}\n${fnOf('nbaHotRanks')}\n${rankerLine}\n${fnOf('nbaHotCandidates')}\nreturn { nbaCauseState, nbaHotRun, nbaHotAllowed, nbaHotRanks, nbaHotRanker, nbaHotCandidates };`)();
const DAY = '2027-01-15', MARSHALL = '4278594';
const cands = (rs, team, opp, rep) => lib.nbaHotCandidates(lib.nbaCauseState(rs), lib.nbaHotRanker(lib.nbaHotAllowed(rs), DAY), team, opp, rep);
const softOn = (rs, team, opp, rep) => cands(rs, team, opp, rep).filter((c) => c.soft).map((c) => c.name).sort();
ok(softOn(HISTORY, 'DAL', 'UTAH').join() === 'Daniel Gafford,Naji Marshall', `Mavericks who pay for a read: ${softOn(HISTORY, 'DAL', 'UTAH').join(', ')}`);
ok(softOn(HISTORY, 'UTAH', 'DAL').join() === 'Cody Williams,Jusuf Nurkic', `Jazz: ${softOn(HISTORY, 'UTAH', 'DAL').join(', ')}`);
ok(softOn(HISTORY, 'MEM', 'ORL').length === 0 && softOn(HISTORY, 'ORL', 'MEM').length === 0, 'Grizzlies and Magic: no one');
const mine = HISTORY.filter((r) => r.player_id === MARSHALL);
const naive = (rs, stat) => { let run = 0; for (let j = rs.length - 1; j >= 5; j--) { const v = stat(rs[j]), before = rs.slice(0, j).reduce((a, x) => a + stat(x), 0) / j; if (v > before) run++; else break; } return run; };
ok(lib.nbaHotRun(mine, 'pts') === naive(mine, (r) => r.pts) && lib.nbaHotRun(mine, 'pts') === 5, 'his run in points, counted the long way: 5');
ok(lib.nbaHotRun(mine, 'reb_ast') === naive(mine, (r) => r.reb + r.ast) && lib.nbaHotRun(mine, 'reb_ast') < 3, `in rebounds + assists: ${lib.nbaHotRun(mine, 'reb_ast')}`);
ok(lib.nbaHotRun(mine.slice(0, 6).map((r, i) => ({ ...r, pts: i * 100 })), 'pts') === 1, 'his first five games cannot count: six rising games are a run of one');
ok(lib.nbaHotRun(mine.slice(0, 8).map((r) => ({ ...r, pts: 10 })), 'pts') === 0, 'level with his average is not above it');
const lastGame = mine[mine.length - 1].game_id;
const shorter = HISTORY.filter((r) => !(r.player_id === MARSHALL && r.game_id === lastGame));
const m4 = cands(shorter, 'DAL', 'UTAH').find((c) => c.id === MARSHALL);
ok(m4 && !m4.soft && m4.markets.pts.run === 4, 'his last game gone: 4 in a row, logged if the game is read, pays for nothing');
const OUT = { [MARSHALL]: { s: 'Out', f: 'OUT' } }, GTD = { [MARSHALL]: { s: 'Day-To-Day', f: 'GTD' } };
ok(!cands(HISTORY, 'DAL', 'UTAH', OUT).some((c) => c.id === MARSHALL), 'listed out: not a candidate');
ok(cands(HISTORY, 'DAL', 'UTAH', GTD).some((c) => c.id === MARSHALL), 'listed day-to-day: still one, and the box score voids him if he sits');
const fewMin = HISTORY.map((r) => (r.player_id === MARSHALL && mine.slice(-5).some((x) => x.game_id === r.game_id) ? { ...r, min: 19 } : r));
ok(!cands(fewMin, 'DAL', 'UTAH').some((c) => c.id === MARSHALL), 'under 20 minutes over his last five: no');
const fewGames = HISTORY.filter((r) => !(r.player_id === MARSHALL && !mine.slice(-9).some((x) => x.game_id === r.game_id)));
ok(!cands(fewGames, 'DAL', 'UTAH').some((c) => c.id === MARSHALL), 'nine games: too few');
const allowed = lib.nbaHotAllowed(HISTORY);
const ranks = lib.nbaHotRanks(allowed, DAY, 'pts', false);
ok(ranks.size === 30 && ranks.get('UTAH') === 1 && near(ranks.get('MEM'), 0.517, 0.001) && ranks.get('OKC') === 0, 'points allowed: Utah last of 30, Oklahoma City first, Memphis 0.517, as the backtest has them');
const usualRanks = lib.nbaHotRanks(allowed, DAY, 'pts', true);
ok(usualRanks.get('UTAH') === 1 && near(usualRanks.get('MEM'), 0.621, 0.001), 'allowing for who they faced, a list of its own: Memphis moves to 0.621, as the backtest has it');
const utahNine = new Map([...allowed].map(([t, list]) => [t, t === 'UTAH' ? list.slice(0, 9) : list]));
ok(!lib.nbaHotRanks(utahNine, DAY, 'pts', false).has('UTAH') && lib.nbaHotRanks(utahNine, DAY, 'pts', false).size === 29, 'nine games: Utah unranked');
const teamsN = (n) => new Map([...allowed].slice(0, n));
ok(lib.nbaHotRanks(teamsN(19), DAY, 'pts', false).size === 0 && lib.nbaHotRanks(teamsN(20), DAY, 'pts', false).size === 20, 'nineteen teams: no ranks; twenty: ranks');
const sameDay = HISTORY.concat(HISTORY.filter((r) => r.game_id === HISTORY[HISTORY.length - 1].game_id).map((r) => ({ ...r, game_id: 'today', date: DAY, pts: 200 })));
const ranksAfter = lib.nbaHotRanks(lib.nbaHotAllowed(sameDay), DAY, 'pts', false);
ok([...ranks].every(([t, v]) => ranksAfter.get(t) === v), "an early game that same day doesn't move anyone's rank");
const keyed = /const KEYED_BY_QUERY = [^;]*p === '\/api\/nba-cause'/.test(src);
ok(keyed, 'each day cached by its own address');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
