// The NFL's Hot players (2026-11-02, the owner's call: each league they follow, from a player's
// previous 5 games, moving to 10). What has to hold:
//   - the NFL's own box scores come in free: the season a week a tick, then the current week once
//     an hour, a few games a tick, one row a player with a line, read once
//   - with 5 to 9 games a player is listed on five or more in a row above last season's average.
//     A regular for that stat: 15+ passes, 8+ carries or 4+ targets a game over his last five
//   - the team he plays ranked for that stat, on 5+ games until 22 teams have 10
//   - a player who missed his team's last game is left off; a bye is not a missed game
//   - a bigger role is flagged, and sorted below a steady one against the same kind of team
//   - nothing claims a side: this has not been tested in the NFL
//   - no call to the odds feed, no page reads a box score, not on the five-minute cron
//
// Real data: every real line of the 120 games of weeks 1-8, the real scoreboards of Nov 2, ESPN's
// real 2025 season totals and a real raw box score. Every run, rank and count is worked out here
// the long way from those rows and held against the real worker on real SQLite.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = path.join(BOARD, 'tests', 'fixtures');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const read = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const LEAGUE = read('nfl-box-league-to-20261102.json'), WK8 = read('espn-nfl-sb-20261102-wk8.json'), WK9 = read('espn-nfl-sb-20261102-wk9.json'), REAL_BOX = read('espn-nfl-boxscore-season.json');
const PRIORS = JSON.parse(fs.readFileSync(path.join(BOARD, 'nfl-hot-priors.json'), 'utf8'));
const ROWS = LEAGUE.rows.map((r) => ({ game_id: LEAGUE.games[r[0]][0], date: LEAGUE.games[r[0]][1], week: LEAGUE.games[r[0]][2], player_id: LEAGUE.players[r[1]][0], player: LEAGUE.players[r[1]][1], team: r[2], opp: r[3], pass_att: r[4], pass_yds: r[5], pass_td: r[6], car: r[7], rush_yds: r[8], tgt: r[9], rec: r[10], rec_yds: r[11] }));

const RealDate = Date;
const START = Date.parse('2026-11-02T17:00:00Z');
let NOW = START;
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
const EMPTY = { content: { sbData: { events: [] } } };

let S = null;
function scene({ rows = ROWS, weeks = { now: WK8, 9: WK9 }, assets = true, down = false } = {}) {
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
  const ASSETS = { fetch: async (req) => (assets && new URL(req.url).pathname === '/nfl-hot-priors.json' ? J(PRIORS) : new Response('nope', { status: 404 })) };
  return { sq, sqls, env: { DB, ASSETS }, rows, weeks, down, oddsCalls: 0, boxCalls: [], sbCalls: [] };
}
globalThis.fetch = async (u) => {
  const url = String(u);
  if (/the-odds-api\.com/.test(url)) { S.oddsCalls++; return new Response('{}', { status: 404 }); }
  const sb = url.match(/cdn\.espn\.com\/core\/nfl\/scoreboard\?xhr=1(?:&year=2026&seasontype=2&week=(\d+))?$/);
  if (sb) { S.sbCalls.push(sb[1] || 'now'); return S.down ? new Response('nope', { status: 500 }) : J(S.weeks[sb[1] || 'now'] || EMPTY); }
  const bx = url.match(/cdn\.espn\.com\/core\/nfl\/boxscore\?xhr=1&gameId=(\d+)/);
  if (bx) { S.boxCalls.push(bx[1]); return J(REAL_BOX); }
  return new Response('{}', { status: 404 });
};
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
let mod = null, scenes = 0;
const loadWorker = async () => { mod = await import('data:text/javascript;base64,' + Buffer.from(`${src}\n// scene ${++scenes}`).toString('base64')); };
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), S.env, { waitUntil: () => {} })).json();
const cron = async (c) => { const held = []; await mod.default.scheduled({ cron: c, scheduledTime: NOW }, S.env, { waitUntil: (p) => held.push(p) }); await Promise.all(held); };
const tick = () => cron('1-59/2 * * * *');
const COLS = ['game_id', 'date', 'player_id', 'player', 'team', 'opp', 'pass_att', 'pass_yds', 'pass_td', 'car', 'rush_yds', 'tgt', 'rec', 'rec_yds'];
const insBox = (rows) => { const ins = S.sq.prepare(`INSERT INTO nfl_box (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`);
  for (const r of rows) ins.run(...COLS.map((c) => r[c])); };
// Up to date, so the ingest has nothing to do: the list is all that is under test.
const begin = async () => { await loadWorker(); await tick(); S.sq.prepare('DELETE FROM nfl_box').run(); insBox(S.rows);
  S.sq.prepare("DELETE FROM feed_cache WHERE key = 'hot_list:nfl'").run(); S.sq.prepare('UPDATE nfl_box_games SET done = 1').run();
  for (const e of events(WK8)) if (/FINAL/.test(e.status.type.name)) S.sq.prepare('INSERT OR REPLACE INTO nfl_box_games (game_id, date, done) VALUES (?,?,1)').run(e.id, '2026-11-01');
  S.sq.prepare("INSERT OR REPLACE INTO feed_cache (key, data, updated_at) SELECT 'nfl_box_scan', ?, ? ").run(JSON.stringify({ week: 8, current: 8, checked: NOW }), NOW);
  await tick(); };

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// ---- The long way, from the box rows and last season's totals ------------------------------
const MK = ['pass_yds', 'pass_td', 'rush_yds', 'rec', 'rec_yds'], VOL = { pass_yds: 'pass_att', pass_td: 'pass_att', rush_yds: 'car', rec: 'tgt', rec_yds: 'tgt' }, BAR = { pass_att: 15, car: 8, tgt: 4 };
const round2 = (v) => Math.round(v * 100) / 100, round1 = (v) => Math.round(v * 10) / 10;
const mean = (xs) => xs.reduce((a, x) => a + x, 0) / xs.length;
const events = (sb) => sb.content.sbData.events;
const SLATE = [...events(WK8), ...events(WK9)].filter((e) => e.status.type.name === 'STATUS_SCHEDULED' && Date.parse(e.date) > START).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
const sides = (e) => { const c = e.competitions[0].competitors, h = c.find((x) => x.homeAway === 'home').team, a = c.find((x) => x.homeAway === 'away').team; return [[h.abbreviation, a.abbreviation], [a.abbreviation, h.abbreviation]]; };
function allowedTable(rows, mk) {
  const t = new Map();
  for (const r of rows) { const g = t.get(r.opp) || new Map(); g.set(r.game_id, (g.get(r.game_id) || 0) + (r[mk] || 0)); t.set(r.opp, g); }
  return t;
}
function posRange(rows, team, mk, min) {
  const list = [...allowedTable(rows, mk)].filter(([, g]) => g.size >= min).map(([k, g]) => [k, mean([...g.values()])]).sort((a, b) => b[1] - a[1]);
  if (list.length < 22) return null;
  const i = list.findIndex(([k]) => k === team);
  if (i < 0) return null;
  const same = list.map(([, v], j) => (v === list[i][1] ? j + 1 : 0)).filter(Boolean);
  return { lo: same[0], hi: same[same.length - 1], of: list.length };
}
function expected(rows, slate, min = 5) {
  const out = [], seen = new Set();
  for (const e of slate) for (const [team, opp] of sides(e)) {
    const dates = new Set(rows.filter((r) => r.team === team).map((r) => r.date));
    for (const id of new Set(rows.filter((r) => r.team === team).map((r) => r.player_id))) {
      const gs = rows.filter((r) => r.player_id === id);
      if (gs[gs.length - 1].team !== team || gs.length < 5 || seen.has(id) || [...dates].some((d) => d > gs[gs.length - 1].date)) continue;
      const pr = PRIORS.players[id];
      let any = false;
      for (const mk of MK) {
        const v = gs.map((r) => r[mk]).filter((x) => x != null), vol = gs.map((r) => r[VOL[mk]]).filter((x) => x != null).slice(-5);
        if (v.length < 5 || mean(vol) < BAR[VOL[mk]] || !pr || pr.g < 6 || pr[mk] == null) continue;
        let run = 0; for (let j = v.length - 1; j >= 0 && v[j] > pr[mk]; j--) run++;
        const p = posRange(rows, opp, mk, min);
        if (run >= 5 && p) { out.push({ id, mk, run, base: pr[mk], seen: v.length, last5: round2(mean(v.slice(-5))), ...p }); any = true; }
      }
      if (any) seen.add(id);
    }
  }
  return out;
}
function roleOf(id, rows) {
  const pr = PRIORS.players[id], gs = rows.filter((r) => r.player_id === id);
  if (!pr || pr.g < 6) return null;
  const last = (k) => mean(gs.map((r) => r[k]).filter((x) => x != null).slice(-5));
  const att = gs.some((r) => r.pass_att != null) ? last('pass_att') : 0;
  if (att >= 15) return att - pr.pass_att >= 10 ? { min: round1(att), before: round1(pr.pass_att), unit: 'passes' } : null;
  const t = last('car') + last('tgt'), b = pr.car + pr.tgt;
  return t - b >= 5 ? { min: round1(t), before: round1(b), unit: 'carries and targets' } : null;
}
const flat = (hot) => hot.players.flatMap((p) => p.markets.map((m) => ({ ...m, id: p.id, name: p.name, team: p.team })));
const key = (x) => `${x.id}|${x.mk || x.market}|${x.run}`;

console.log('-- this week and next, on this season\'s real games --');
S = scene();
await begin();
let hot = (await get('/api/hot-players?sport=nfl')).hot;
ok(S.oddsCalls === 0, 'not one call to the odds feed');
const teams5 = [...allowedTable(ROWS, 'rec')].filter(([, g]) => g.size >= 5).length;
ok(hot && hot.ready === true && hot.early === true && hot.gamesNeeded === 5 && hot.teamsReady === teams5 && hot.teamsNeeded === 22 && teams5 === 32, `all ${teams5} teams at 5 games, none near 10: ranked on 5+`);
const want = expected(ROWS, SLATE);
console.log(`  ${hot.players.length} players: ${hot.players.map((p) => `${p.name} (${p.team} v ${p.oppNick}${p.role ? `, role ${p.role.min} ${p.role.unit}` : ''}) ${p.markets.map((m) => `${m.market} ${m.run}x ${m.third}`).join(', ')}`).join(' | ')}`.slice(0, 1400));
ok(want.length >= 5 && JSON.stringify(flat(hot).map(key).sort()) === JSON.stringify(want.map(key).sort()), `every run on the games to come, the long way: ${want.length}`);
const wantOf = (x) => want.find((y) => y.id === x.id && y.mk === x.market);
ok(flat(hot).every((x) => { const w = wantOf(x); return w && x.pos >= w.lo && x.pos <= w.hi && x.of === w.of; }), 'and where the team he plays ranks for that stat');
ok(flat(hot).every((x) => { const w = wantOf(x); return x.lastSeason === round2(w.base) && x.seasonAvg === undefined && x.last5 === w.last5 && x.seen === w.seen; }), 'against last season\'s real average, with his last five and how many games');
ok(flat(hot).every((x) => !('read' in x) && !('line' in x)), 'nothing claims a side, or a number it has not got');
const nicks = new Set(SLATE.flatMap((e) => e.competitions[0].competitors.map((c) => c.team.name)));
ok(hot.players.every((p) => p.name.includes(' ') && nicks.has(p.oppNick) && p.commence), 'full names, who he plays by nickname, and when');
const onTheList = hot.players;
const roles = hot.players.filter((p) => p.role);
ok(hot.players.every((p) => JSON.stringify(p.role) === JSON.stringify(roleOf(p.id, ROWS))), `the bigger role worked out the long way: ${roles.length} of ${hot.players.length}`);
const soft = (p) => (p.markets[0].third === 'soft' ? 1 : 0), best = (p) => Math.max(...p.markets.map((m) => m.run));
const ordered = hot.players.every((p, i, a) => !i || soft(a[i - 1]) > soft(p) || (soft(a[i - 1]) === soft(p) && (!!a[i - 1].role < !!p.role || (!!a[i - 1].role === !!p.role && best(a[i - 1]) >= best(p)))));
ok(ordered, 'soft teams first, then no role change, then the longest run');
const chiSea = sides(SLATE[0]).map(([t]) => t);
ok(chiSea.includes('CHI') && chiSea.includes('SEA') && SLATE.length === 16, `tonight's game and next week's ${SLATE.length - 1} are on the slate`);

console.log('\n-- who is not listed --');
const sample = hot.players[0];
const sampleRows = ROWS.filter((r) => r.player_id === sample.id);
S = scene({ rows: ROWS.filter((r) => !(r.player_id === sample.id && r.date === sampleRows[sampleRows.length - 1].date)) });
await begin();
hot = (await get('/api/hot-players?sport=nfl')).hot;
ok(!hot.players.some((p) => p.id === sample.id), `${sample.name} left out of his team's last game: taken to be out`);
const byes = new Map();
for (const t of new Set(ROWS.map((r) => r.team))) byes.set(t, new Set(ROWS.filter((r) => r.team === t).map((r) => r.game_id)).size);
const hadBye = onTheList.filter((p) => byes.get(p.team) === 7);
ok(hadBye.length >= 1, `${hadBye.length} listed from teams that have had their bye: a bye is no game missed`);
const low = { rec: { tgt: 3 }, rec_yds: { tgt: 3 }, rush_yds: { car: 7 }, pass_yds: { pass_att: 14 }, pass_td: { pass_att: 14 } }[sample.markets[0].market];
S = scene({ rows: ROWS.map((r) => (r.player_id === sample.id ? { ...r, ...low } : r)) });
await begin();
hot = (await get('/api/hot-players?sport=nfl')).hot;
ok(!hot.players.some((p) => p.id === sample.id && p.markets.some((m) => m.market === sample.markets[0].market)), `just under the bar for ${sample.markets[0].market} (${JSON.stringify(low)}): not a regular for it`);

console.log('\n-- too early, and what it cannot read --');
const three = ROWS.filter((r) => r.week <= 3);
S = scene({ rows: three });
await begin();
hot = (await get('/api/hot-players?sport=nfl')).hot;
ok(hot.ready === false && hot.players.length === 0 && hot.teamsNeeded === 22 && hot.teamsReady === 0, 'three weeks in: no team has 5 games, none listed');
const six = ROWS.filter((r) => r.week <= 6);
S = scene({ rows: six });
await begin();
hot = (await get('/api/hot-players?sport=nfl')).hot;
const want6 = expected(six, SLATE);
ok(hot.ready === true && JSON.stringify(flat(hot).map(key).sort()) === JSON.stringify(want6.map(key).sort()), `six weeks in, the long way again: ${want6.length} runs`);
S = scene({ assets: false });
await begin();
hot = (await get('/api/hot-players?sport=nfl')).hot;
ok(hot && hot.ready === true && hot.players.length === 0, 'last season\'s file missing: no one under 10 games is listed');
S = scene();
await begin();
const held = S.sq.prepare("SELECT data FROM feed_cache WHERE key = 'hot_list:nfl'").get().data;
NOW += 7 * 3600e3; S.down = true; await tick();
ok(S.sq.prepare("SELECT data FROM feed_cache WHERE key = 'hot_list:nfl'").get().data === held, 'the scoreboard down: the list it has is kept');
NOW = START;
S.sq.prepare("UPDATE feed_cache SET data = '{not json' WHERE key = 'hot_list:nfl'").run();
ok((await get('/api/hot-players?sport=nfl')).hot === null, 'the list unreadable: no section');

console.log('\n-- how often --');
S = scene();
await begin();
const scans = () => S.sqls.filter((q) => /FROM nfl_box WHERE date/.test(q)).length;
const scanBefore = scans();
ok(scanBefore >= 1, 'it read the box scores to build it');
NOW += 30 * 60e3; await tick();
ok(scans() === scanBefore, 'half an hour on: the row kept');
NOW += 2 * 3600e3; await tick();
ok(scans() === scanBefore, 'still inside six hours, nothing coming in: the row kept');
await get('/api/hot-players?sport=nfl');
ok(scans() === scanBefore, 'no page reads a box score');
NOW += 4 * 3600e3; await tick();
ok(scans() === scanBefore + 1, 'six hours on: built again');
NOW = START + 3 * 24 * 3600e3;
const later = (await get('/api/hot-players?sport=nfl')).hot;
ok(later.players.every((p) => Date.parse(p.commence) > NOW) && later.players.length < flat({ players: [] }).length + 1000, 'a game that has started drops off the list');
NOW = START;

console.log('\n-- the box scores come in --');
const finals = events(WK8).filter((e) => /FINAL/.test(e.status.type.name));
const wk1 = { content: { sbData: { events: finals.slice(0, 5) } } };
const preseason = { content: { sbData: { events: [{ ...finals[5], id: '999', season: { ...finals[5].season, type: 1 } }] } } };
S = scene({ rows: [], weeks: { now: { content: { sbData: { events: events(WK8).filter((e) => !finals.slice(0, 5).includes(e)) } } }, 1: wk1, 2: preseason } });
await loadWorker();
await tick();
const gamesDb = () => S.sq.prepare('SELECT * FROM nfl_box_games ORDER BY game_id').all();
ok(S.sbCalls[0] === 'now', 'it reads the current week first, to know how far back to go');
const notYet = events(WK8).find((e) => e.status.type.name === 'STATUS_SCHEDULED');
ok(!gamesDb().some((g) => g.game_id === notYet.id) && gamesDb().length === finals.length - 5, 'finished games only: tonight\'s is not one yet');
const box = REAL_BOX.gamepackageJSON.boxscore;
const line = (cat, side, f) => { const c = box.players[side].statistics.find((x) => x.name === cat); return c.athletes.filter(f || (() => true)).map((a) => ({ id: String(a.athlete.id), name: a.athlete.displayName, s: Object.fromEntries(c.labels.map((l, i) => [l, a.stats[i]])) })); };
const gid = S.boxCalls[0];
const inDb = () => S.sq.prepare('SELECT * FROM nfl_box WHERE game_id = ?').all(gid);
const qb = line('passing', 0)[0], wr = line('receiving', 0)[0], rowQb = inDb().find((r) => r.player_id === qb.id), rowWr = inDb().find((r) => r.player_id === wr.id && r.player_id !== qb.id);
ok(rowQb && rowQb.team === box.players[0].team.abbreviation && rowQb.opp === box.players[1].team.abbreviation && rowQb.pass_att === Number(qb.s['C/ATT'].split('/')[1]) && rowQb.pass_yds === Number(qb.s.YDS) && rowQb.pass_td === Number(qb.s.TD), `the real box parsed: ${qb.name}, ${qb.s['C/ATT']} for ${qb.s.YDS} and ${qb.s.TD}`);
ok(rowWr && rowWr.pass_att === null && rowWr.pass_yds === null && rowWr.rec === Number(wr.s.REC) && rowWr.rec_yds === Number(wr.s.YDS) && rowWr.tgt === Number(wr.s.TGTS), `${wr.name}: ${wr.s.REC} catches on ${wr.s.TGTS} targets, and no passing line, not zero`);
const carrier = line('rushing', 0).find((a) => line('receiving', 0).some((b) => b.id === a.id)), rowC = carrier && inDb().find((r) => r.player_id === carrier.id);
ok(carrier && rowC.car === Number(carrier.s.CAR) && rowC.rush_yds === Number(carrier.s.YDS) && rowC.rec === Number(line('receiving', 0).find((b) => b.id === carrier.id).s.REC), `${carrier && carrier.name} on two lists is one row`);
const named = new Set(box.players.flatMap((t) => t.statistics.filter((c) => ['passing', 'rushing', 'receiving'].includes(c.name)).flatMap((c) => c.athletes.map((a) => String(a.athlete.id)))));
ok(inDb().length === named.size, `one row a player with a line: ${named.size}`);
const firstTick = S.boxCalls.length;
ok(firstTick === 4, 'four games a tick');
for (let i = 0; i < 12; i++) { NOW += 2 * 60e3; await tick(); }
const walked = S.sbCalls.filter((w) => w !== 'now' && w !== '9');
ok(walked.join() === '1,2,3,4,5,6,7', `then the season a week a tick: ${walked.join(' ')}`);
ok(!gamesDb().some((g) => g.game_id === '999'), 'the regular season only: not a preseason game');
ok(gamesDb().length === finals.length && gamesDb().every((g) => g.done === 1) && S.boxCalls.length === finals.length && new Set(S.boxCalls).size === finals.length, `every finished game read, each once: ${finals.length}`);
const sbThen = S.sbCalls.length;
NOW += 10 * 60e3; await tick();
ok(S.sbCalls.filter((w) => w !== 'now' && w !== '9').length === 7 && S.sbCalls.slice(sbThen).every((w) => w === 'now' || w === '9'), 'caught up: no week read again');
const scanRow = () => JSON.parse(S.sq.prepare("SELECT data FROM feed_cache WHERE key = 'nfl_box_scan'").get().data);
const prog = (await get('/api/hot-players?sport=nfl&ingest=1')).ingest;
ok(prog && prog.games === finals.length && prog.read === finals.length, `how far it has got, when asked: ${prog && prog.read} of ${prog && prog.games}`);
ok(scanRow().week === 8 && scanRow().current === 8, 'the cursor sits on the current week');
S.weeks.now = { content: { sbData: { events: events(WK9) } } };
NOW += 3600e3; await tick();
ok(scanRow().current === 9, 'the next week starts: the current week moves');
const before = S.sbCalls.length;
await tick();
ok(S.sbCalls.slice(before).includes('8'), 'and the week before is read once more, so a Monday night game is not lost');
NOW = START;

console.log('\n-- on its own request budget --');
S = scene({ rows: [], weeks: { now: WK8, 1: wk1 } });
await loadWorker();
await cron('*/5 * * * *');
ok(S.boxCalls.length === 0, 'the five-minute cron does not read box scores');
await tick();
ok(S.boxCalls.length === 4, 'the two-minute one does');

console.log('\n-- a backtest comes first --');
S = scene({ rows: [], weeks: { now: WK8, 1: wk1 } });
await loadWorker();
await tick();
S.sq.prepare("INSERT OR REPLACE INTO feed_cache (key, data, updated_at) VALUES ('hist_props:nba', ?, ?)").run(JSON.stringify({ active: true, done: false }), NOW);
const sb4 = S.sbCalls.length, bx4 = S.boxCalls.length;
NOW += 2 * 3600e3;
await tick();
ok(S.sbCalls.length === sb4 && S.boxCalls.length === bx4, 'a running backtest has the invocation to itself');
NOW = START;

console.log('\n-- the page --');
S = scene();
await begin();
const payload = (await get('/api/hot-players?sport=nfl')).hot;
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const sect = app.slice(app.indexOf('  // ---- Hot players'), app.indexOf('  function renderNba('));
const state = { hot: { nfl: payload }, hotAll: { nfl: true } };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const card = new Function('state', 'esc', 'nbaNick', 'sharpTag', 'avatarHtml', 'soccerKick', 'nbaCardInjTag', `${sect}\nreturn hotCardHtml;`)(
  state, esc, (n) => n, () => '', (o) => `<span class="hs" data-sport="${o.sport}" data-id="${o.playerId}"></span>`, () => 'Sun 10:00 AM', () => '');
let html = card('nfl');
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
console.log(`  ${text(html).slice(0, 900)}`);
ok(/Hot players/.test(html) && /Not tested in the NFL, so it shows no side/.test(html) && /off Picks and out of the entries/.test(html), 'titled, and says it is untested and off Picks');
ok(/ranked for that stat on 5\+ games/.test(html), 'and what the teams are ranked on');
ok(/data-sport="nfl-espn"/.test(html) && /sport === 'nfl-espn'\) return `https:\/\/a\.espncdn\.com\/combiner\/i\?img=\/i\/headshots\/nfl\/players\/full\/\$\{n\}\.png/.test(app), 'each face from ESPN\'s NFL photos, by the ESPN id');
ok(/ in a row · [\d.]+ last five, [\d.]+ last season/.test(html) && /Bigger role: \d+ (carries and targets|passes) a game, \d+ last season/.test(html), 'the run and the role in plain words');
ok(/allow the (\d+\w\w )?(most|fewest) /.test(html) && /(soft|middle|tough) team/.test(html), 'and the team he plays');
ok(!/Lean |Slight |No side:|PP \d/.test(html), 'no side, no number');
ok((html.match(/<li>/g) || []).length === payload.players.length, `the tap: all ${payload.players.length}`);
state.hot.nfl = { ...payload, ready: false, teamsReady: 12, teamsNeeded: 22, gamesNeeded: 5, players: [] };
ok(/opponents are ranked once 22 teams have played 5, and 12 have so far/.test(card('nfl')), 'too early: how far off');
state.hot.nfl = null;
ok(card('nfl') === '', 'no list: no section');
ok(/grid\.innerHTML = rec \+ hotCardHtml\('nfl'\) \+ \(games\.length/.test(app), 'on the tab, above the games');
ok(/fetchJson\('\/api\/hot-players\?sport=nfl'\)/.test(app), 'and fetched with it');
ok(/case 'hot-all': \{[\s\S]{0,260}renderNfl\(\)/.test(app), 'the tap redraws the tab');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
