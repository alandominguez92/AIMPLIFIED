// The NHL's Hot players (2026-11-02, the owner's call: each league they follow, from a player's
// previous 5 games, moving to 10). What has to hold:
//   - the NHL's own box scores come in free: a backfill from the season's start, then the last
//     two days, a few games a tick, one row a skater who played, read once
//   - with 10+ games a skater is listed on five or more in a row above his own average; with 5
//     to 9, above last season's. 15+ minutes over his last five, 20+ games last season
//   - the team he plays ranked for that stat; a skater who missed his team's last game is left off
//   - nothing claims a side: this has not been tested in the NHL
//   - no call to the odds feed, and no page reads a box score: the cron keeps one row
//   - on the idle two-minute trigger, not the five-minute one that grades and captures
//
// Real data: every real skater line of the 223 games to Nov 1 2026, the real slate of Nov 2,
// the NHL's real season tables and real score pages. Every run, rank and count is worked out here
// the long way from those rows and held against the real worker on real SQLite.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = path.join(BOARD, 'tests', 'fixtures');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const read = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const LEAGUE = read('nhl-box-league-to-20261101.json'), PRIOR = read('nhl-skaters-20252026.json'), CUR = read('nhl-skaters-20262027.json');
const SLATE = read('nhl-score-20261102.json'), SCORE_NOV1 = read('nhl-score-20261101.json'), REAL_BOX = read('nhl-box-2025020740.json');
const ROWS = LEAGUE.rows.map((r) => ({ game_id: LEAGUE.games[r[0]][0], date: LEAGUE.games[r[0]][1], player_id: LEAGUE.players[r[1]][0], player: LEAGUE.players[r[1]][1], team: r[2], opp: r[3], min: r[4], goals: r[5], ast: r[6], pts: r[7], sog: r[8] }));

const RealDate = Date;
let NOW = Date.parse('2026-11-02T17:00:00Z');
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });

let S = null;
function scene({ rows = ROWS, score = {}, statsDown = false } = {}) {
  const sq = new DatabaseSync(':memory:');
  const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
  const sqls = [];
  const exec = (sql, args, mode) => { sqls.push(sql); const st = sq.prepare(sql); const a = args.map(norm);
    if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
    if (/^\s*(SELECT|WITH)/i.test(sql)) return { results: st.all(...a), meta: {} };
    return { success: true, meta: { changes: Number(st.run(...a).changes) } }; };
  const DB = { prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
    all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
    run: async () => exec(s.sql, s.args, 'run') }; return s; }, batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')) };
  return { sq, sqls, env: { DB }, rows, score: { '2026-11-02': SLATE, ...score }, statsDown, oddsCalls: 0, boxCalls: [], scoreCalls: [], statsCalls: 0 };
}
globalThis.fetch = async (u) => {
  const url = String(u);
  if (/the-odds-api\.com/.test(url)) { S.oddsCalls++; return new Response('{}', { status: 404 }); }
  const sc = url.match(/api-web\.nhle\.com\/v1\/score\/(\d{4}-\d{2}-\d{2})/);
  if (sc) { S.scoreCalls.push(sc[1]); return J(S.score[sc[1]] || { games: [] }); }
  const bx = url.match(/gamecenter\/(\d+)\/boxscore/);
  if (bx) { S.boxCalls.push(bx[1]); return J(REAL_BOX); }
  if (/api\.nhle\.com\/stats\/rest\/en\/skater\/summary/.test(url)) {
    S.statsCalls++;
    if (S.statsDown) return new Response('nope', { status: 500 });
    return J(/seasonId=20252026/.test(url) ? PRIOR : CUR);
  }
  return new Response('{}', { status: 404 });
};
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
let mod = null, scenes = 0;
const loadWorker = async () => { mod = await import('data:text/javascript;base64,' + Buffer.from(`${src}\n// scene ${++scenes}`).toString('base64')); };
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), S.env, { waitUntil: () => {} })).json();
const tick = async () => { const held = []; await mod.default.scheduled({ cron: '1-59/2 * * * *', scheduledTime: NOW }, S.env, { waitUntil: (p) => held.push(p) }); await Promise.all(held); };
const insBox = (rows) => { const ins = S.sq.prepare('INSERT INTO nhl_box (game_id, date, player_id, player, team, opp, min, goals, ast, pts, sog) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (const r of rows) ins.run(r.game_id, r.date, r.player_id, r.player, r.team, r.opp, r.min, r.goals, r.ast, r.pts, r.sog); };
// Up to date, so the ingest has nothing to do: the list is all that is under test.
const begin = async () => { await loadWorker(); await tick(); insBox(S.rows);
  S.sq.prepare("DELETE FROM feed_cache WHERE key = 'hot_list_v2:nhl'").run(); S.sq.prepare("DELETE FROM nhl_box_games").run();
  S.sq.prepare("INSERT OR REPLACE INTO feed_cache (key, data, updated_at) SELECT 'nhl_box_scan', ?, ? ").run(JSON.stringify({ from: '2026-11-01', checked: NOW }), NOW);
  await tick(); };

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// ---- The long way, from the box rows and last season's table ------------------------------
const MK = ['pts', 'ast', 'goals', 'sog'], PF = { pts: 'points', ast: 'assists', goals: 'goals', sog: 'shots' };
const priorOf = new Map(PRIOR.data.map((x) => [String(x.playerId), x]));
const round2 = (v) => Math.round(v * 100) / 100;
const mean = (xs) => xs.reduce((a, x) => a + x, 0) / xs.length;
function allowedTable(rows, mk) {
  const t = new Map();
  for (const r of rows) { const g = t.get(r.opp) || new Map(); g.set(r.game_id, (g.get(r.game_id) || 0) + r[mk]); t.set(r.opp, g); }
  return t;
}
function posRange(rows, team, mk, min = 10) {
  const list = [...allowedTable(rows, mk)].filter(([, g]) => g.size >= min).map(([k, g]) => [k, mean([...g.values()])]).sort((a, b) => b[1] - a[1]);
  const i = list.findIndex(([k]) => k === team);
  if (i < 0) return null;
  const same = list.map(([, v], j) => (v === list[i][1] ? j + 1 : 0)).filter(Boolean);
  return { lo: same[0], hi: same[same.length - 1], of: list.length };
}
function expected(rows, slate) {
  const out = [], seen = new Set();
  for (const g of slate) for (const [team, opp] of [[g.homeTeam.abbrev, g.awayTeam.abbrev], [g.awayTeam.abbrev, g.homeTeam.abbrev]]) {
    const teamDates = new Set(rows.filter((r) => r.team === team).map((r) => r.date));
    for (const id of new Set(rows.filter((r) => r.team === team).map((r) => r.player_id))) {
      const gs = rows.filter((r) => r.player_id === id);
      if (gs[gs.length - 1].team !== team || gs.length < 5 || seen.has(id)) continue;
      if ([...teamDates].some((d) => d > gs[gs.length - 1].date)) continue;
      if (mean(gs.slice(-5).map((r) => r.min)) < 15) continue;
      let any = false;
      for (const mk of MK) {
        const v = gs.map((r) => r[mk]), pr = priorOf.get(id);
        let run = 0, base = null;
        if (v.length >= 10) { for (let j = v.length - 1; j >= 5; j--) { if (v[j] > mean(v.slice(0, j))) run++; else break; } }
        else { if (!pr || pr.gamesPlayed < 20) continue; base = pr[PF[mk]] / pr.gamesPlayed; for (let j = v.length - 1; j >= 0 && v[j] > base; j--) run++; }
        const p = posRange(rows, opp, mk);
        if (run >= 5 && p) { out.push({ id, mk, run, base, ...p }); any = true; }
      }
      if (any) seen.add(id);
    }
  }
  return out;
}
const flat = (hot) => hot.players.flatMap((p) => p.markets.map((m) => ({ ...m, id: p.id, name: p.name, team: p.team, role: p.role, inGames: rowsOf(p.id).length })));
const rowsOf = (id, rows = ROWS) => rows.filter((r) => r.player_id === id);
const key = (x) => `${x.id}|${x.mk || x.market}|${x.run}`;

console.log('-- tonight, on this season\'s real games --');
S = scene();
await begin();
let hot = (await get('/api/hot-players?sport=nhl')).hot;
ok(S.oddsCalls === 0, 'not one call to the odds feed');
const teams10 = [...allowedTable(ROWS, 'pts')].filter(([, g]) => g.size >= 10).length;
ok(hot && hot.ready === true && hot.early === false && hot.gamesNeeded === 10 && hot.teamsReady === teams10 && hot.teamsNeeded === 22 && teams10 === 32, `all ${teams10} teams at 10 games, counted the long way: the full ranks`);
const want = expected(ROWS, SLATE.games);
console.log(`  ${hot.players.length} skaters: ${hot.players.map((p) => `${p.name} (${p.team}${p.role ? ', role' : ''}) ${p.markets.map((m) => `${m.market} ${m.run}x ${m.third}`).join(', ')}`).join(' | ')}`.slice(0, 1000));
ok(want.length >= 1 && JSON.stringify(flat(hot).map(key).sort()) === JSON.stringify(want.map(key).sort()), `every run on tonight's four games, the long way: ${want.length}`);
ok(flat(hot).every((x) => { const w = want.find((y) => y.id === x.id && y.mk === x.market); return w && x.pos >= w.lo && x.pos <= w.hi && x.of === w.of; }), 'and where the team he plays ranks for that stat');
ok(flat(hot).every((x) => !('read' in x) && !('line' in x)), 'nothing claims a side, or a number it has not got');
ok(flat(hot).every((x) => (x.inGames >= 10 ? x.seasonAvg != null && x.lastSeason === undefined : x.lastSeason != null && x.seasonAvg === undefined)), '10+ games against his season, under 10 against last season');
ok(flat(hot).every((x) => x.seen === x.inGames), 'each says how many games it has');
const boxesLong = (x) => { const v = rowsOf(x.id).map((r) => r[x.market]), from = Math.max(0, v.length - 10), pr = priorOf.get(x.id);
  return { last10: v.slice(from), up: v.slice(from).map((y, i) => (v.length < 10 ? (y > pr[PF[x.market]] / pr.gamesPlayed ? 1 : 0) : from + i >= 5 ? (y > mean(v.slice(0, from + i)) ? 1 : 0) : null)) }; };
ok(flat(hot).every((x) => JSON.stringify({ last10: x.last10, up: x.up }) === JSON.stringify(boxesLong(x))), 'each run has its last ten games, and which beat what it is measured by, the long way');
ok(flat(hot).every((x) => x.up.slice(-x.run).every((u) => u === 1) && (x.run >= x.up.length || x.up[x.up.length - x.run - 1] !== 1)), 'the last filled boxes are the run itself, and the one before it is not');
ok(hot.players.every((p) => p.name.includes(' ') && !/^[A-Z]\. /.test(p.name)), 'full names, not the box score\'s initials');
const players = hot.players;
ok(players.every((p) => p.oppNick && /^[A-Z]/.test(p.oppNick) && p.commence), 'each with who he plays and when');

console.log('\n-- who is not listed --');
const sample = players[0];
const sampleDates = rowsOf(sample.id).map((r) => r.date);
S = scene({ rows: ROWS.filter((r) => !(r.player_id === sample.id && r.date === sampleDates[sampleDates.length - 1])) });
await begin();
hot = (await get('/api/hot-players?sport=nhl')).hot;
ok(!hot.players.some((p) => p.id === sample.id), `${sample.name} left out of his team's last game: taken to be out`);
S = scene({ rows: ROWS.map((r) => (r.player_id === sample.id ? { ...r, min: 14.5 } : r)) });
await begin();
hot = (await get('/api/hot-players?sport=nhl')).hot;
ok(!hot.players.some((p) => p.id === sample.id), 'under 15 minutes over his last five: left off');

console.log('\n-- five to nine games, against last season --');
const eight = '2026-10-16';
const earlyRows = ROWS.filter((r) => r.date <= eight);
const at10 = [...allowedTable(earlyRows, 'pts')].filter(([, g]) => g.size >= 10).length;
S = scene({ rows: earlyRows });
await begin();
hot = (await get('/api/hot-players?sport=nhl')).hot;
const wantEarly = (() => {
  const out = [];
  for (const g of SLATE.games) for (const [team, opp] of [[g.homeTeam.abbrev, g.awayTeam.abbrev], [g.awayTeam.abbrev, g.homeTeam.abbrev]]) {
    const dates = new Set(earlyRows.filter((r) => r.team === team).map((r) => r.date));
    for (const id of new Set(earlyRows.filter((r) => r.team === team).map((r) => r.player_id))) {
      const gs = earlyRows.filter((r) => r.player_id === id), pr = priorOf.get(id);
      if (gs[gs.length - 1].team !== team || gs.length < 5 || gs.length >= 10 || !pr || pr.gamesPlayed < 20) continue;
      if ([...dates].some((d) => d > gs[gs.length - 1].date) || mean(gs.slice(-5).map((r) => r.min)) < 15) continue;
      for (const mk of MK) { const base = pr[PF[mk]] / pr.gamesPlayed; let run = 0; for (let j = gs.length - 1; j >= 0 && gs[j][mk] > base; j--) run++;
        if (run >= 5 && posRange(earlyRows, opp, mk, 5)) out.push({ id, mk, run, base }); }
    }
  }
  return out;
})();
console.log(`  to ${eight}: ${at10} teams at 10 games, ${hot.players.length} skaters, ${flat(hot).length} runs`);
ok(at10 < 22 && hot.early === true && hot.gamesNeeded === 5 && hot.ready === true, `${at10} teams at 10 games: teams are ranked on 5+`);
ok(wantEarly.length >= 1 && JSON.stringify(flat(hot).filter((x) => x.lastSeason != null).map(key).sort()) === JSON.stringify(wantEarly.map(key).sort()), `every run against last season, the long way: ${wantEarly.length}`);
ok(flat(hot).filter((x) => x.lastSeason != null).every((x) => x.lastSeason === round2(wantEarly.find((y) => y.id === x.id && y.mk === x.market).base)), 'at last season\'s real average');
S = scene({ rows: ROWS.filter((r) => r.date <= '2026-10-08') });
await begin();
hot = (await get('/api/hot-players?sport=nhl')).hot;
ok(hot.ready === false && hot.players.length === 0 && hot.teamsNeeded === 22, `the first week: ${hot.teamsReady} teams with 5 games, none listed`);

console.log('\n-- what it cannot read --');
S = scene({ statsDown: true });
await begin();
hot = (await get('/api/hot-players?sport=nhl')).hot;
ok(hot && hot.players.every((p) => flat({ players: [p] }).every((x) => x.lastSeason === undefined)), 'no season tables: the 10-game rule still lists, the early one cannot');
S = scene();
await begin();
S.sq.prepare("UPDATE feed_cache SET data = '{not json' WHERE key = 'hot_list_v2:nhl'").run();
ok((await get('/api/hot-players?sport=nhl')).hot === null, 'the list unreadable: no section');
ok((await get('/api/hot-players?sport=mlb')).hot === null, 'a league with no list: no section');

console.log('\n-- how often --');
S = scene();
await begin();
const scans = () => S.sqls.filter((q) => /FROM nhl_box WHERE date/.test(q)).length;
const statsBefore = S.statsCalls, scanBefore = scans();
ok(scanBefore >= 1, 'it read the box scores to build it');
NOW += 30 * 60e3; await tick();
ok(scans() === scanBefore, 'half an hour on: the row kept');
NOW += 2 * 3600e3; await tick();
ok(scans() === scanBefore, 'still inside six hours, nothing coming in: the row kept');
await get('/api/hot-players?sport=nhl');
ok(scans() === scanBefore, 'no page reads a box score');
NOW += 4 * 3600e3; await tick();
ok(scans() === scanBefore + 1, 'six hours on: built again');
ok(S.statsCalls <= statsBefore + 1, 'last season\'s table kept for good: at most this season\'s is read again');
NOW = Date.parse('2026-11-02T17:00:00Z');

console.log('\n-- the box scores come in --');
S = scene({ rows: [], score: { '2026-10-01': { games: [{ id: 2026010001, gameType: 1, gameState: 'OFF' }, { id: 2026020001, gameType: 2, gameState: 'OFF', gameDate: '2026-10-01' }] }, '2026-10-02': { games: [{ id: 2026020002, gameType: 2, gameState: 'FUT' }] }, '2026-11-01': SCORE_NOV1 } });
await loadWorker();
await tick();
const gamesDb = () => S.sq.prepare('SELECT * FROM nhl_box_games ORDER BY game_id').all();
ok(S.scoreCalls.filter((d) => d < '2026-10-04').length === 3, 'a backfill walks the season three days a tick');
ok(gamesDb().map((g) => g.game_id).join() === '2026020001', 'finished regular-season games only: not the preseason, not one to come');
const boxRow = S.sq.prepare('SELECT * FROM nhl_box ORDER BY player_id').all();
const realLine = [...REAL_BOX.playerByGameStats.awayTeam.forwards, ...REAL_BOX.playerByGameStats.awayTeam.defense].find((x) => x.toi && x.toi !== '00:00');
const inDb = boxRow.find((r) => r.player_id === String(realLine.playerId));
const [mm, ss] = realLine.toi.split(':').map(Number);
ok(S.boxCalls.join() === '2026020001' && inDb && inDb.team === REAL_BOX.awayTeam.abbrev && inDb.opp === REAL_BOX.homeTeam.abbrev && inDb.pts === realLine.points && inDb.sog === realLine.sog && inDb.ast === realLine.assists && inDb.goals === realLine.goals && Math.abs(inDb.min - (mm + ss / 60)) < 0.01, 'the real box score parsed: a skater\'s team, opponent, time and counts');
const skaters = ['awayTeam', 'homeTeam'].flatMap((s) => [...REAL_BOX.playerByGameStats[s].forwards, ...REAL_BOX.playerByGameStats[s].defense]);
ok(boxRow.length === skaters.filter((x) => x.toi && x.toi !== '00:00').length && !boxRow.some((r) => REAL_BOX.playerByGameStats.awayTeam.goalies.some((g) => String(g.playerId) === r.player_id)), `one row a skater who played, no goalies: ${boxRow.length}`);
ok(gamesDb()[0].done === 1, 'and the game marked read');
const callsThen = S.boxCalls.length, START_READ = NOW;
for (let i = 0; i < 12; i++) { NOW += 5 * 60e3; await tick(); }
ok(S.boxCalls.length === callsThen + 5, 'every finished game read once, at most four a tick');
ok(new Set(S.boxCalls).size === S.boxCalls.length, 'none twice');
const atEnd = S.scoreCalls.length;
const scanRow = () => JSON.parse(S.sq.prepare("SELECT data FROM feed_cache WHERE key = 'nhl_box_scan'").get().data);
ok(scanRow().from > '2026-11-01', 'the backfill reached yesterday');
ok(scanRow().readAt > START_READ, 'and it says when it last read a game, which is what brings the list up to date');
NOW += 10 * 60e3; await tick();
ok(S.scoreCalls.length === atEnd, 'then no scan inside the hour');
NOW += 3600e3; await tick();
ok(S.scoreCalls.length >= atEnd + 2 && S.scoreCalls.slice(atEnd).includes('2026-11-01'), 'then yesterday and today, once an hour');
NOW = Date.parse('2026-11-02T17:00:00Z');

console.log('\n-- on its own request budget --');
S = scene({ rows: [], score: { '2026-10-01': { games: [{ id: 2026020001, gameType: 2, gameState: 'OFF' }] } } });
await loadWorker();
const five = []; await mod.default.scheduled({ cron: '*/5 * * * *', scheduledTime: NOW }, S.env, { waitUntil: (p) => five.push(p.catch(() => null)) }); await Promise.all(five);
ok(S.boxCalls.length === 0 && !S.statsCalls && !S.scoreCalls.some((d) => d < '2026-10-05'), 'the five-minute cron does not read these');
await tick();
ok(S.boxCalls.length === 1, 'the two-minute one does');
NOW = Date.parse('2026-11-02T17:00:00Z');

console.log('\n-- the page --');
S = scene();
await begin();
const payload = (await get('/api/hot-players?sport=nhl')).hot;
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const sect = app.slice(app.indexOf('  // ---- Hot players'), app.indexOf('  function renderNba('));
const state = { hot: { nhl: payload }, hotAll: {} };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const card = new Function('state', 'esc', 'nbaNick', 'sharpTag', 'avatarHtml', 'soccerKick', 'nbaCardInjTag', `${sect}\nreturn hotCardHtml;`)(
  state, esc, (n) => n, () => '', (o) => `<span class="hs" data-sport="${o.sport}" data-id="${o.playerId}"></span>`, () => '5:10 PM', () => '');
let html = card('nhl');
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const softAny = payload.players.filter((p) => p.markets.some((m) => m.third === 'soft'));
ok(/Hot players/.test(html) && /Not tested in the NHL, so it shows no side/.test(html) && /off Picks and out of the entries/.test(html), 'titled, and says it is untested and off Picks');
ok((html.match(/<li>/g) || []).length === Math.min(5, softAny.length), 'soft teams first, five at most');
state.hotAll = { nhl: true };
html = card('nhl');
const boxesOf = (m) => m.last10.map((v, i) => `<i class="${m.up[i] === 1 ? 'h' : m.up[i] === 0 ? 'm' : 'n'}">${v}</i>`).join('');
ok((html.match(/class="tb-boxes"/g) || []).length === flat(payload).length && flat(payload).every((m) => html.includes(boxesOf(m))) && /oldest → latest · filled: above (last season's [\d.]+|his average to that point)/.test(html), 'the tap: a set of boxes for every run, each game in its place');
console.log(`  ${text(html).slice(0, 700)}`);
ok(/data-sport="nhl"/.test(html), 'each face from the NHL\'s photos');
ok(/ in a row · [\d.]+ last five, [\d.]+ (season|last season)/.test(html), 'the run in plain words');
ok(/allow the (\d+\w\w )?(most|fewest) /.test(html) && /(soft|middle|tough) team/.test(html), 'and the team he plays');
ok(!/Lean |Slight |No side:|PP \d/.test(html), 'no side, no number');
ok((html.match(/<li>/g) || []).length === payload.players.length && /Soft teams only/.test(html), `the tap: all ${payload.players.length}`);
state.hotAll = {};
state.hot.nhl = { ...payload, ready: false, teamsReady: 12, teamsNeeded: 22, gamesNeeded: 5, players: [] };
ok(/opponents are ranked once 22 teams have played 5, and 12 have so far/.test(card('nhl')), 'too early: how far off');
state.hot.nhl = { ...payload, players: [] };
ok(/No one is on a run of 5 or more/.test(card('nhl')), 'no one on a run: it says so');
state.hot.nhl = null;
ok(card('nhl') === '', 'no list: no section');
const render = app.slice(app.indexOf('  function renderNhl('), app.indexOf('  function renderNhl(') + 900);
ok(/nhlPpCardHtml\(\) \+ hotCardHtml\('nhl'\)/.test(render), 'on the tab, under the PrizePicks card');
ok(/fetchJson\('\/api\/hot-players\?sport=nhl'\)/.test(app), 'and fetched with it');
ok(/case 'hot-all': \{[\s\S]{0,200}renderNhl\(\)/.test(app), 'the tap redraws the tab');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
