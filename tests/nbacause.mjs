// A streak with a cause, logged and nothing else (2026-11-01, the owner's call: test
// it, then log it). Last season's legs at 6+ of his last ten over tonight's number, his
// minutes up 4+, a key teammate out went Over 55.4% where the sharp books said 50.0: a
// lead, to be watched as tested. What has to hold:
//   - a game is read once, about an hour before tip, and only if someone in it passes
//     all the box scores can say: a night with no one spends nothing
//   - he has 10+ games and 20+ minutes over his last five, 4+ up on the fifteen before;
//     the teammate 26+ minutes over 5+ games, gone the last 1 to 5 games, on the report
//   - every PrizePicks leg on him is logged with the sharp read as the backtest took it
//     and how often he cleared that number, so the bar can be read both ways afterwards
//   - graded from the box scores the cron already reads; `held` says the teammate really
//     sat; a leg he did not play is void; a game with no box score in four days is void
//   - low on credits it waits; PrizePicks not up yet, it tries once more
//   - nothing reaches a page: /api/nba-cause alone reads it
//
// Real data: Grizzlies @ Magic, Jan 15 2026. Ja Morant had missed Memphis's last five and
// sat again, and the repo has that game's props and box score recorded
// (hist-props-nba-20260115.json, espn-nba-box-401810433.json) and both teams' season to
// then (nba-box-mem-orl-to-20260115.json). Jock Landale's minutes were up 4.13; Cam Spencer's
// 3.80, with legs posted, is the near miss. Everything moves a year on, past the season's
// start date. No report survives from that night: the entries are real ones from Nov 1
// 2026's feed with the athlete swapped, as tests/nbainjury.mjs does. The sharp numbers
// asserted are what production stored for this game (/api/hist-props?job=nba&rows=1).
// Real SQLite and the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = path.join(BOARD, 'tests', 'fixtures');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const read = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const yearOn = (s) => String(s).replace(/2026-01-1(\d)/g, '2027-01-1$1').replace(/2026-01-0(\d)/g, '2027-01-0$1').replace(/2025-(1[0-2])/g, '2026-$1');
const shifted = (x) => JSON.parse(yearOn(JSON.stringify(x)));
const P = read('hist-props-nba-20260115.json'), SB = read('espn-nba-sb-20260115.json'), BOX = read('espn-nba-box-401810433.json');
const INJ = read('espn-nba-game-injuries-20261101.json').games, HISTORY = read('nba-box-mem-orl-to-20260115.json').rows;
const GAME = '401810433', EVENT = P.odds.data.id;
const TIP = Date.parse('2027-01-15T19:00:00Z');

const RealDate = Date;
let NOW = TIP - 3 * 3600e3;
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
const J = (x, h = {}) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json', ...h } });

// A real report entry, the player swapped.
const realEntry = Object.values(INJ).flatMap((f) => (f.gamepackageJSON || f).injuries || []).flatMap((t) => t.injuries || []).find((i) => i.status === 'Out' && i.details && i.details.fantasyStatus && i.details.fantasyStatus.abbreviation === 'OUT');
const listed = (id, name, status = 'Out', fantasy = 'OUT') => { const e = JSON.parse(JSON.stringify(realEntry));
  Object.assign(e.athlete, { id, displayName: name, lastName: name.split(' ').pop() }); e.status = status; e.details.fantasyStatus.abbreviation = fantasy; return e; };
const MORANT = listed('4279888', 'Ja Morant'), CARTER = listed('4277847', 'Wendell Carter Jr.', 'Day-To-Day', 'GTD'), WAGNER = listed('4566434', 'Franz Wagner');
const feedOf = (home, away) => ({ gamepackageJSON: { injuries: [{ team: { displayName: 'Orlando Magic' }, injuries: home }, { team: { displayName: 'Memphis Grizzlies' }, injuries: away }] } });

function scene({ report, body = () => shifted(P.odds.data) }) {
  const sq = new DatabaseSync(':memory:');
  const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
  const exec = (sql, args, mode) => { const st = sq.prepare(sql); const a = args.map(norm);
    if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
    if (/^\s*(SELECT|WITH)/i.test(sql)) return { results: st.all(...a), meta: {} };
    return { success: true, meta: { changes: Number(st.run(...a).changes) } }; };
  const DB = { prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
    all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
    run: async () => exec(s.sql, s.args, 'run') }; return s; }, batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')) };
  return { sq, env: { DB, ODDS_API_KEY: 'k' }, report, body, cause: [], boxUp: false };
}
let S = null;
globalThis.fetch = async (u) => {
  const url = String(u);
  // The scoreboard: not final until the box score is up. That day's real slate, a year on.
  if (/cdn\.espn\.com\/core\/nba\/scoreboard\?xhr=1&date=20270115/.test(url)) {
    const j = shifted(SB);
    if (!S.boxUp) for (const e of j.content.sbData.events) { if (e.status && e.status.type) e.status.type.name = 'STATUS_SCHEDULED'; }
    return J(j);
  }
  if (/cdn\.espn\.com\/core\/nba\/scoreboard/.test(url)) return J({ content: { sbData: { events: [] } } });
  if (url.includes(`/nba/game?xhr=1&gameId=${GAME}`)) return J(S.report);
  if (url.includes(`/nba/boxscore?xhr=1&gameId=${GAME}`)) return S.boxUp ? J(BOX) : new Response('{}', { status: 404 });
  const ev = url.match(/\/sports\/basketball_nba\/events\/([^/]+)\/odds\?(.*)$/);
  if (ev) {
    const q = new URLSearchParams(ev[2]);
    if (!(q.get('markets') || '').includes('player_points')) return J({ id: ev[1], bookmakers: [] }, { 'x-requests-last': '0', 'x-requests-remaining': '60000' });
    S.cause.push({ id: ev[1], markets: q.get('markets'), books: q.get('bookmakers') });
    return J(S.body(), { 'x-requests-last': '7', 'x-requests-remaining': '60000' });
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
const seed = async () => {
  await loadWorker();
  await get('/api/nba-pp');
  const ins = S.sq.prepare('INSERT INTO nba_box (game_id, date, season_type, player_id, player, team, min, pts, reb, ast, threes, dnp) VALUES (?,?,2,?,?,?,?,?,?,?,?,0)');
  for (const r of HISTORY) ins.run(r[0], yearOn(r[1]), r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9]);
};

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const near = (a, b, d = 0.051) => Math.abs(a - b) <= d;

console.log('-- the night: Morant out five games, on the report; Carter listed, and he plays --');
S = scene({ report: feedOf([CARTER, WAGNER], [MORANT]) });
await seed();
await tick();
const inj = JSON.parse((await S.env.DB.prepare("SELECT data FROM feed_cache WHERE key = 'nba_inj:2027-01-15'").first()).data || '{}');
const row = (inj.games || []).find((g) => g.id === GAME);
ok(row && row.homeAb === 'ORL' && row.awayAb === 'MEM', `the day's games know their teams as the box scores spell them: ${row && row.homeAb}, ${row && row.awayAb}`);
ok(S.cause.length === 0, 'three hours out: nothing read yet');
NOW = TIP - 3600e3 + 5 * 60e3;   // 55 minutes before tip
await tick();
console.log(`  ${JSON.stringify(S.cause.map((c) => c.markets))}`);
ok(S.cause.length === 1 && S.cause[0].id === EVENT, 'an hour out: one read, of this game');
ok(S.cause[0] && S.cause[0].markets.split(',').sort().join() === ['player_points', 'player_points_rebounds_assists', 'player_points_rebounds', 'player_points_assists', 'player_rebounds_assists', 'player_rebounds', 'player_threes'].sort().join(), 'the seven markets the backtest stands on');
ok(S.cause[0] && ['pinnacle', 'fanduel', 'novig', 'prizepicks'].every((b) => S.cause[0].books.split(',').includes(b)), 'PrizePicks and the sharp books the backtest read');
const rows = all('SELECT * FROM nbacause ORDER BY player, market');
console.log(`  ${rows.map((r) => `${r.player} ${r.market} ${r.pp_line} form ${r.form} sharp ${r.sharp_under}`).join(' | ')}`);
const leg = (who, m) => rows.find((r) => r.player === who && r.market === m);
ok(rows.filter((r) => r.player === 'Jock Landale').length === 4, 'Jock Landale, minutes up 4.13 with Morant gone: all four of his legs');
ok(!rows.some((r) => r.player === 'Cam Spencer'), 'Cam Spencer, up 3.80, legs posted: no');
ok(!rows.some((r) => /Jaren Jackson|Santi Aldama|Paolo Banchero/.test(r.player)), 'nor anyone whose minutes did not rise (Banchero, 3.73, the near miss in Orlando)');
ok(rows.some((r) => r.player === 'Noah Penda'), 'Noah Penda, up 15.5, with Carter on the report: logged, and the box score settles it later');
ok(!rows.some((r) => /Morant|Wagner/.test(r.player)), 'the players out are not legs');
const LANDALE = HISTORY.filter((r) => r[2] === '3146557');
const lastTen = LANDALE.slice(-10), mins = LANDALE.map((r) => r[5]);
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const cleared = (f, line) => lastTen.filter((r) => f(r) > line).length;
ok(leg('Jock Landale', 'pts').form === cleared((r) => r[6], 11.5) && leg('Jock Landale', 'pra').form === cleared((r) => r[6] + r[7] + r[8], 20.5), `how often he cleared that number, of his last ten: ${leg('Jock Landale', 'pts').form} at 11.5 points, ${leg('Jock Landale', 'pra').form} at 20.5 PRA`);
ok(near(leg('Jock Landale', 'pts').min5, avg(mins.slice(-5))) && near(leg('Jock Landale', 'pts').min_before, avg(mins.slice(-20, -5))), `his minutes: ${leg('Jock Landale', 'pts').min5} against ${leg('Jock Landale', 'pts').min_before}`);
ok(leg('Jock Landale', 'pts').sharp_under === 46.8 && leg('Jock Landale', 'pra').sharp_under === 48.4 && leg('Jock Landale', 'pts_reb').sharp_under === 50.4, 'the sharp read production stored for this game: 46.8, 48.4, 50.4');
ok(leg('Jock Landale', 'pts_ast').sharp_under === null && leg('Jock Landale', 'pts_ast').pp_line === 14.5, 'a line no sharp book quoted: logged, unpriced');
ok(leg('Jock Landale', 'pra').gap === -1 && leg('Jock Landale', 'pts').gap === 0, 'where PrizePicks sat against the sharp line');
const outs = JSON.parse(leg('Jock Landale', 'pts').outs);
ok(outs.length === 1 && outs[0].id === '4279888' && outs[0].missed === 5 && near(outs[0].min, 28.3, 0.11) && outs[0].status === 'OUT', `the cause is kept: ${JSON.stringify(outs)}`);
const usage = await get('/api/usage');
const usageRow = Object.values(usage.routes || {}).flat().find((x) => x.route === 'nba:reg:cause');
ok(usageRow && usageRow.credits === 7 && usageRow.calls === 1, `on the ledger under its own name: ${JSON.stringify(usageRow)}`);
const picksFor = await get('/api/nba-pp');
ok(!(picksFor.legs || []).some((l) => l.market === 'pts'), 'nothing on the NBA tab');
NOW += 10 * 60e3;
await tick();
ok(S.cause.length === 1, 'read once: the next tick spends nothing');

console.log('\n-- after the game: the real box score --');
// Two more legs, by hand: one for a man who sat (Edey, no leg posted that night), one with its line on his real count.
const edey = '4600663', jjj = '4277961';
const insLeg = S.sq.prepare("INSERT INTO nbacause (event_id, player, market, espn_id, player_id, team, date, pp_line, form, outs) VALUES (?,?,?,?,?,'MEM','2027-01-15',?,?,?)");
insLeg.run(EVENT, 'Zach Edey', 'reb', GAME, edey, 8.5, 6, leg('Jock Landale', 'pts').outs);
S.boxUp = true;
NOW = TIP + 8 * 3600e3;
await tick(); await tick();
const boxed = all('SELECT player_id, player, min, pts, reb, ast, dnp FROM nba_box WHERE game_id = ?', GAME);
ok(boxed.length > 10, `the cron's own box read: ${boxed.length} rows`);
const jj = boxed.find((b) => b.player_id === jjj);
insLeg.run(EVENT, 'Jaren Jackson Jr.', 'pts', GAME, jjj, jj.pts, 6, leg('Jock Landale', 'pts').outs);
await tick();
const graded = all('SELECT * FROM nbacause ORDER BY player, market');
const g = (who, m) => graded.find((r) => r.player === who && r.market === m);
console.log(`  ${graded.map((r) => `${r.player} ${r.market} ${r.pp_line}: ${r.actual} ${r.result} held ${r.held}`).join(' | ')}`);
ok(g('Jock Landale', 'pts').actual === 6 && g('Jock Landale', 'pts').result === 'under', "Landale's 6 points against 11.5: under, what production has for him");
ok(g('Jock Landale', 'pra').actual === 12 && g('Jock Landale', 'pra').result === 'under' && g('Jock Landale', 'pts_reb').actual === 11, 'and 12 PRA, 11 points + rebounds');
ok(g('Jock Landale', 'pts').held === 1, 'Morant really sat: the cause held');
ok(g('Noah Penda', 'pts').actual === 9 && g('Noah Penda', 'pts').result === 'over', "Penda's 9 against 5.5: over");
ok(g('Noah Penda', 'pts').held === 0, 'Carter played: it did not');
ok(g('Zach Edey', 'reb').result === 'void' && g('Zach Edey', 'reb').actual === null, 'a leg on a man who sat: void');
ok(g('Jaren Jackson Jr.', 'pts').result === 'push', 'on the number: a push');
const rec = (await get('/api/nba-cause')).record;
console.log(`  ${JSON.stringify(rec)}`);
const decided = graded.filter((r) => r.result === 'over' || r.result === 'under');
const inRule = decided.filter((r) => r.held === 1 && r.form >= 6), under = decided.filter((r) => r.held === 1 && r.form < 6);
ok(rec.logged === graded.length && rec.pending === 0 && rec.voided === 1 && rec.pushed === 1, `the count: ${rec.logged} logged, ${rec.voided} void, ${rec.pushed} push`);
ok(rec.teammatePlayed === decided.filter((r) => r.held === 0).length && rec.teammatePlayed === 3, "Penda's three legs stand apart: his teammate played");
ok(rec.rule.n === inRule.length && rec.underBar.n === under.length, `the rule ${rec.rule.n}, under its bar ${rec.underBar.n}`);
ok(rec.rule.n === 3 && rec.rule.games === 1 && rec.rule.over === 0 && rec.rule.overRate === 0, 'three of his legs at 6+ of ten, one game, all under: the rule went 0 for 3 that night');
ok(rec.underBar.n === 1 && g('Jock Landale', 'pts_ast').form === 5, 'his points + assists, 5 of ten, stands under the bar');
ok(rec.rule.priced.n === 3 && near(rec.rule.priced.sharpSaid, avg([100 - 46.8, 100 - 48.4, 100 - 50.4])) && near(rec.rule.priced.beat, 0 - avg([100 - 46.8, 100 - 48.4, 100 - 50.4])), `the sharp books beside it: said ${rec.rule.priced.sharpSaid}, the gap ${rec.rule.priced.beat}`);
ok(rec.underBar.priced.n === 0 && rec.underBar.priced.beat === null, 'a leg no sharp book priced has no gap to show');
const day = await get('/api/nba-cause?day=2027-01-15');
ok(day.rows && day.rows.length === graded.length && day.rows[0].outs && day.rows[0].outs[0].id === '4279888', "?day= gives that day's rows");
ok(/const KEYED_BY_QUERY = [^;]*p === '\/api\/nba-cause'/.test(src), 'each day cached by its own address, not all as one');

console.log('\n-- a night with no one --');
NOW = TIP - 3 * 3600e3;
S = scene({ report: feedOf([WAGNER], []) });
await seed();
await tick();
NOW = TIP - 3600e3 + 5 * 60e3;
await tick();
ok(S.cause.length === 0, 'Morant not listed, Wagner sixteen games gone: nothing read, nothing spent');
const noOne = JSON.parse((await S.env.DB.prepare("SELECT data FROM feed_cache WHERE key = 'nba_cause_games'").first()).data);
ok(noOne[GAME] && noOne[GAME].why === 'no one', 'and the game is done with');
ok(all('SELECT * FROM nbacause').length === 0, 'nothing logged');

console.log('\n-- PrizePicks not up: once more, then it stops --');
NOW = TIP - 3 * 3600e3;
const noPP = () => { const b = shifted(P.odds.data); b.bookmakers = b.bookmakers.filter((x) => x.key !== 'prizepicks'); return b; };
S = scene({ report: feedOf([], [MORANT]), body: noPP });
await seed();
await tick();
NOW = TIP - 3600e3 + 5 * 60e3;
await tick();
ok(S.cause.length === 1 && all('SELECT * FROM nbacause').length === 0, 'no PrizePicks on it: nothing logged');
NOW += 10 * 60e3;
await tick();
ok(S.cause.length === 1, 'and not again for twenty minutes');
NOW += 15 * 60e3;
S.body = () => shifted(P.odds.data);
await tick();
ok(S.cause.length === 2 && all('SELECT * FROM nbacause').length === 4, 'the second try finds it: Landale logged');
await tick();
ok(S.cause.length === 2, 'and that is the last read');

console.log('\n-- low on credits: it waits --');
NOW = TIP - 3 * 3600e3;
S = scene({ report: feedOf([], [MORANT]) });
await seed();
await get('/api/usage');
await tick();
NOW = TIP - 3600e3 + 5 * 60e3;
S.sq.prepare('INSERT OR REPLACE INTO odds_usage (day, remaining, low, calls, updated_at) VALUES (?,?,?,?,?)').run('2027-01-15', 5, 5, 1, new RealDate(NOW).toISOString());
await tick();
ok(S.cause.length === 0, 'five credits left: no read');
const lean = (await S.env.DB.prepare("SELECT data FROM feed_cache WHERE key = 'nba_cause_games'").first());
ok(!lean || !(JSON.parse(lean.data)[GAME] || {}).done, 'and the game is not marked done');
S.sq.prepare('INSERT OR REPLACE INTO odds_usage (day, remaining, low, calls, updated_at) VALUES (?,?,?,?,?)').run('2027-01-15', 50000, 5, 1, new RealDate(NOW).toISOString());
NOW += 5 * 60e3;
await tick();
ok(S.cause.length === 1, 'credits back, still inside the window: it reads');

console.log('\n-- too close to tip, and a game that never finished --');
NOW = TIP - 3 * 3600e3;
S = scene({ report: feedOf([], [MORANT]) });
await seed();
await tick();
NOW = TIP - 5 * 60e3;
await tick();
ok(S.cause.length === 0, 'five minutes before tip: too late, the backtest read an hour out');
NOW = TIP - 3600e3;
await tick();
ok(S.cause.length === 1, 'an hour out it would have');
S.boxUp = false;
NOW = TIP + 3 * 86400e3;
await tick();
ok(all('SELECT * FROM nbacause WHERE result IS NULL').length === 4, 'no box score three days on: still open');
NOW = TIP + 5 * 86400e3;
await tick();
ok(all("SELECT * FROM nbacause WHERE result = 'void'").length === 4, 'five days on: postponed, void');

console.log('\n-- the bars, on the real season so far --');
const fnOf = (name) => { const a = src.indexOf(`function ${name}(`); return src.slice(a, src.indexOf('\n}\n', a) + 3); };
const consts = src.split('\n').filter((l) => /^const NBA_CAUSE_(KEY_MIN|KEY_GAMES|OUT_MAX|ROT_MIN|MIN_UP|PRIOR) = /.test(l)).join('\n');
const { state: cState, cands: cCands } = new Function(`const round1 = (v) => Math.round(v * 10) / 10; const nbaInjOut = (i) => i.s === 'Out' && (!i.f || i.f === 'OUT');\n${consts}\n${fnOf('nbaCauseState')}\n${fnOf('nbaCauseCandidates')}\nreturn { state: nbaCauseState, cands: nbaCauseCandidates };`)();
const asRows = (rs) => rs.map((r) => ({ game_id: r[0], date: r[1], player_id: r[2], player: r[3], team: r[4], min: r[5], pts: r[6], reb: r[7], ast: r[8], threes: r[9] }));
const names = (rs, rep) => cCands(cState(asRows(rs)), 'MEM', rep).map((c) => c.name).sort();
const OUT = { 4279888: { s: 'Out', f: 'OUT' } };
ok(names(HISTORY, OUT).join() === 'GG Jackson,Jock Landale,Zach Edey', `Morant on the report: ${names(HISTORY, OUT).join(', ')}`);
ok(names(HISTORY, {}).length === 0, 'not on it: no one');
ok(!names(HISTORY, { ...OUT, 3146557: { s: 'Out', f: 'OUT' } }).includes('Jock Landale'), 'a player listed out himself: not a candidate');
ok(names(HISTORY, { ...OUT, 3146557: { s: 'Day-To-Day', f: 'GTD' } }).includes('Jock Landale'), 'listed day-to-day: still one, and the box score voids him if he sits');
const memGames = [...new Set(HISTORY.filter((r) => r[4] === 'MEM').map((r) => r[0]))];
const extra = HISTORY.filter((r) => r[0] === memGames[memGames.length - 1] && r[2] !== '4279888').map((r) => ['next', '2027-01-14', ...r.slice(2)]);
ok(names([...HISTORY, ...extra], OUT).length === 0, 'one more game without him, six gone: the market has had time, no cause');
const morantGames = HISTORY.filter((r) => r[2] === '4279888').map((r) => r[0]);
const backSoon = HISTORY.filter((r) => !(r[4] === 'MEM' && !morantGames.includes(r[0]) && memGames.indexOf(r[0]) > memGames.indexOf(morantGames[morantGames.length - 1])));
ok(names(backSoon, OUT).length === 0, 'he played the last game: not gone yet, so a first night out is not this rule');
const edeyGames = HISTORY.filter((r) => r[2] === edey).map((r) => r[0]);
ok(!names(HISTORY.filter((r) => !(r[2] === edey && edeyGames.slice(0, 2).includes(r[0]))), OUT).includes('Zach Edey'), 'Edey with nine games instead of eleven: too few');
const landaleLow = HISTORY.map((r) => (r[2] === '3146557' && memGames.indexOf(r[0]) >= memGames.length - 5 ? [...r.slice(0, 5), 19, ...r.slice(6)] : r));
ok(!names(landaleLow, OUT).includes('Jock Landale'), 'under 20 minutes over his last five: no');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
