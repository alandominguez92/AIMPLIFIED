// The Hot players section in the first weeks (2026-11-02, the owner's call: start from a
// player's previous 5 games, move to 10). What has to hold:
//   - with 5 to 9 games, a player is listed on his last five or more above last season's
//     average in that stat, 20+ minutes over his last five, 20+ games last season
//   - with 10+ it is the tested rule, his own average, unchanged, whichever his team has played
//   - teams are ranked on 5+ games until 20 teams have played 10, and the list says which
//   - fewer than 5 games, no prior, too few minutes last five, under 20 games last year: not listed
//   - nothing early claims a side. The tested numbers stay on 10+ games against full ranks
//   - minutes up 5+ on last season is flagged a bigger role, and sorts with everyone else
//   - it costs no credits, and a missing priors file costs the early names, not the section
//
// Real data: every real box row of the 92 league games to Nov 1 2026 (nba-box-league-to-20261101),
// the real slate of Nov 2, the real nba-priors.json, a real report entry and a real PrizePicks
// log row. The mid-season scene is the real league to Jan 15 2026, a year on. Every run, rank and
// count is worked out here the long way and held against the real worker on real SQLite.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = path.join(BOARD, 'tests', 'fixtures');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const read = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const LEAGUE = read('nba-box-league-to-20261101.json'), SB = read('espn-nba-sb-20261102.json'), NBAPP = read('nbapp-20261101.json');
const OLD = read('nba-box-league-to-20260115.json'), OLD_SB = read('espn-nba-sb-20260115.json');
const INJ = read('espn-nba-game-injuries-20261101.json').games;
const PRIORS_TEXT = fs.readFileSync(path.join(BOARD, 'nba-priors.json'), 'utf8'), PRIORS = JSON.parse(PRIORS_TEXT).players;
const expandFrom = (L, shift = (d) => d) => L.rows.map((r) => ({ game_id: L.games[r[0]][0], date: shift(L.games[r[0]][1]), player_id: L.players[r[1]][0], player: L.players[r[1]][1], team: r[2], min: r[3], pts: r[4], reb: r[5], ast: r[6], threes: r[7] }));
const NOW_ROWS = expandFrom(LEAGUE);
const yearOn = (s) => String(s).replace(/2026-01-(\d\d)/g, '2027-01-$1').replace(/2025-(1[0-2])/g, '2026-$1');
const OLD_ROWS = expandFrom(OLD, yearOn);

const RealDate = Date;
let NOW = 0;
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
const feedOf = (teams) => ({ gamepackageJSON: { injuries: Object.entries(teams).map(([displayName, injuries]) => ({ team: { displayName }, injuries })) } });
const entries = Object.values(INJ).flatMap((f) => (f.gamepackageJSON || f).injuries || []).flatMap((t) => t.injuries || []);
const realOut = entries.find((i) => i.status === 'Out' && i.details && i.details.fantasyStatus && i.details.fantasyStatus.abbreviation === 'OUT');
const listed = (real, id, name) => { const e = JSON.parse(JSON.stringify(real)); Object.assign(e.athlete, { id, displayName: name, lastName: name.split(' ').pop() }); return e; };

let S = null;
function scene({ rows = NOW_ROWS, assets = true, report = {}, sb = SB, sbDay = '20261102' } = {}) {
  const sq = new DatabaseSync(':memory:');
  const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
  const exec = (sql, args, mode) => { const st = sq.prepare(sql); const a = args.map(norm);
    if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
    if (/^\s*(SELECT|WITH)/i.test(sql)) return { results: st.all(...a), meta: {} };
    return { success: true, meta: { changes: Number(st.run(...a).changes) } }; };
  const DB = { prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
    all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
    run: async () => exec(s.sql, s.args, 'run') }; return s; }, batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')) };
  const ASSETS = { fetch: async (r) => (new URL(r.url).pathname === '/nba-priors.json' ? new Response(PRIORS_TEXT, { status: 200 }) : new Response('nope', { status: 404 })) };
  return { sq, env: { DB, ...(assets ? { ASSETS } : {}) }, rows, report, sb, sbDay, oddsCalls: 0 };
}
globalThis.fetch = async (u) => {
  const url = String(u);
  if (/the-odds-api\.com/.test(url)) { S.oddsCalls++; return new Response('{}', { status: 404 }); }
  const sb = url.match(/cdn\.espn\.com\/core\/nba\/scoreboard\?xhr=1&date=(\d+)/);
  if (sb) {
    if (sb[1] !== S.sbDay) return J({ content: { sbData: { events: [] } } });
    return J(S.sb);
  }
  const inj = url.match(/\/nba\/game\?xhr=1&gameId=(\d+)/);
  if (inj) return J(S.report[inj[1]] || feedOf({}));
  return new Response('{}', { status: 404 });
};
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
let mod = null, scenes = 0;
const loadWorker = async () => { mod = await import('data:text/javascript;base64,' + Buffer.from(`${src}\n// scene ${++scenes}`).toString('base64')); };
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), S.env, { waitUntil: () => {} })).json();
const tick = async () => { const held = []; await mod.default.scheduled({ cron: '*/5 * * * *', scheduledTime: NOW }, S.env, { waitUntil: (p) => held.push(p) }); await Promise.all(held); };
const insBox = (rows) => { const ins = S.sq.prepare('INSERT INTO nba_box (game_id, date, season_type, player_id, player, team, min, pts, reb, ast, threes, dnp) VALUES (?,?,2,?,?,?,?,?,?,?,?,0)');
  for (const r of rows) ins.run(r.game_id, r.date, r.player_id, r.player, r.team, r.min, r.pts, r.reb, r.ast, r.threes); };
const begin = async (at) => { await loadWorker(); await get('/api/nba-pp'); insBox(S.rows); NOW = at; await tick(); NOW += 5 * 60e3; await tick(); };

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// ---- The long way, from the box rows and the priors ---------------------------------------
const STAT = { pts: (r) => r.pts, pra: (r) => r.pts + r.reb + r.ast, pts_reb: (r) => r.pts + r.reb, pts_ast: (r) => r.pts + r.ast, reb_ast: (r) => r.reb + r.ast, reb: (r) => r.reb, threes: (r) => r.threes };
const round1 = (v) => Math.round(v * 10) / 10;
const lastYear = (pr, mk) => round1(STAT[mk](pr));
const haveAll = (pr, mk) => Number.isFinite(STAT[mk](pr)) && !['pts', 'reb', 'ast', 'threes'].some((k) => pr[k] == null && String(STAT[mk]).includes(`r.${k}`));
function allowedTable(rows, mk) {
  const games = new Map();
  for (const r of rows) { if (!games.has(r.game_id)) games.set(r.game_id, new Map()); const g = games.get(r.game_id); g.set(r.team, (g.get(r.team) || 0) + STAT[mk](r)); }
  const t = new Map();
  for (const g of games.values()) { const [a, b] = [...g.keys()]; if (b == null) continue;
    for (const [me, them] of [[a, b], [b, a]]) { const c = t.get(me) || { n: 0, sum: 0 }; c.n++; c.sum += g.get(them); t.set(me, c); } }
  return t;
}
function posOf(rows, team, mk, min) {
  const list = [...allowedTable(rows, mk)].filter(([, c]) => c.n >= min).map(([k, c]) => [k, c.sum / c.n]).sort((a, b) => b[1] - a[1]);
  const i = list.findIndex(([k]) => k === team);
  if (i < 0) return null;
  // Six games in, teams tie: any place among the tied is right.
  const same = list.map(([, v], j) => (v === list[i][1] ? j + 1 : 0)).filter(Boolean);
  return { lo: same[0], hi: same[same.length - 1], of: list.length };
}
const gamesOf = (rows, id) => rows.filter((r) => r.player_id === id);
function expectedEarly(rows, slate, min = 5) {
  const out = [];
  for (const [team, opp] of slate.flatMap(([a, b]) => [[a, b], [b, a]])) {
    for (const id of new Set(rows.filter((r) => r.team === team).map((r) => r.player_id))) {
      const gs = gamesOf(rows, id);
      if (gs[gs.length - 1].team !== team || gs.length < 5 || gs.length >= 10) continue;
      if (gs.slice(-5).reduce((a, r) => a + r.min, 0) / 5 < 20) continue;
      const pr = PRIORS[id];
      if (!pr || !(pr.gp >= 20)) continue;
      for (const mk of Object.keys(STAT)) {
        if (!haveAll(pr, mk)) continue;
        const base = lastYear(pr, mk);
        let run = 0;
        for (let j = gs.length - 1; j >= 0 && STAT[mk](gs[j]) > base; j--) run++;
        const p = posOf(rows, opp, mk, min);
        if (run >= 5 && p) out.push({ id, name: gs[gs.length - 1].player, mk, run, base, ...p });
      }
    }
  }
  return out;
}
const flat = (hot) => hot.players.flatMap((p) => p.markets.map((m) => ({ ...m, id: p.id, name: p.name, team: p.team, role: p.role, player: p })));
const key = (x) => `${x.name}|${x.mk || x.market}|${x.run}|${x.of}|${x.base ?? x.lastSeason}`;
const SLATE = SB.content.sbData.events.map((e) => { const c = e.competitions[0].competitors; return [c.find((x) => x.homeAway === 'home').team.abbreviation, c.find((x) => x.homeAway === 'away').team.abbreviation]; });
const MORNING = Date.parse('2026-11-02T17:00:00Z');

console.log('-- the priors --');
const withAverages = Object.values(PRIORS).filter((p) => p.gp > 0);
ok(withAverages.length === 578 && withAverages.every((p) => typeof p.pts === 'number'), 'last season\'s points for each of the 578 players with averages');
ok(fs.readFileSync(BOARD + '/tools/build-nba-priors.py', 'utf8').includes("'pts': stat(a, 'offensive', 'avgPoints')"), 'and the builder keeps them');

console.log('\n-- tonight, on this season\'s real games --');
NOW = MORNING;
S = scene();
await begin(NOW);
let hot = (await get('/api/nba-pp')).hot;
ok(S.oddsCalls === 0, 'not one call to the odds feed');
const teamsAt5 = [...allowedTable(NOW_ROWS, 'pts')].filter(([, c]) => c.n >= 5).length;
ok(hot && hot.ready === true && hot.early === true && hot.gamesNeeded === 5 && hot.teamsReady === teamsAt5 && teamsAt5 === 29, `ready, on the early ranks: ${hot && hot.teamsReady} teams with 5 games, counted the long way`);
const want = expectedEarly(NOW_ROWS, SLATE);
console.log(`  ${hot.players.length} players: ${hot.players.map((p) => `${p.name}${p.role ? ' (role)' : ''} ${p.markets.map((m) => `${m.market} ${m.run}x ${m.third}`).join(', ')}`).join(' | ')}`.slice(0, 1200));
ok(want.length >= 40 && JSON.stringify(flat(hot).map(key).sort()) === JSON.stringify(want.map(key).sort()), `every run and last season's number, worked out the long way: ${want.length}`);
ok(flat(hot).every((x) => { const w = want.find((y) => y.id === x.id && y.mk === x.market); return w && x.pos >= w.lo && x.pos <= w.hi; }), 'and where the team he plays ranks for that stat, ties allowed for');
const row = (name, mk, h = hot) => flat(h).find((x) => x.name === name && x.market === mk);
const wig = row('Aaron Wiggins', 'pts');
ok(wig && wig.run === 7 && wig.lastSeason === PRIORS[wig.id].pts && wig.last5 === round1(gamesOf(NOW_ROWS, wig.id).slice(-5).reduce((a, r) => a + r.pts, 0) / 5), `Wiggins, ${wig && wig.run} in a row above last season's ${wig && wig.lastSeason} points, ${wig && wig.last5} over his last five`);
ok(flat(hot).every((x) => x.read === null && x.seasonAvg == null), 'not one early row claims a side, or a season average it has not got');
ok(flat(hot).every((x) => x.seen >= 5 && x.seen < 10 && gamesOf(NOW_ROWS, x.id).length === x.seen), 'each says how many games it has');
ok(!flat(hot).some((x) => gamesOf(NOW_ROWS, x.id).length >= 10), 'no one here has 10 games');
ok(flat(hot).every((x) => { const v = gamesOf(NOW_ROWS, x.id).map(STAT[x.market]); return JSON.stringify(x.last10) === JSON.stringify(v) && JSON.stringify(x.up) === JSON.stringify(v.map((y) => (y > x.lastSeason ? 1 : 0))); }), 'each run has its games, and which beat last season, the long way');
ok(flat(hot).every((x) => x.up.slice(-x.run).every((u) => u === 1) && (x.run >= x.up.length || x.up[x.up.length - x.run - 1] !== 1)), 'the last filled boxes are the run itself, and the one before it is not');
const noPrior = [...new Set(NOW_ROWS.map((r) => r.player_id))].filter((id) => !(PRIORS[id] && PRIORS[id].gp >= 20) && gamesOf(NOW_ROWS, id).length >= 5 && gamesOf(NOW_ROWS, id).slice(-5).reduce((a, r) => a + r.min, 0) / 5 >= 20);
ok(noPrior.length >= 10 && !hot.players.some((p) => noPrior.includes(p.id)), `no real prior, no early listing: ${noPrior.length} rotation players with no 20 games last season, rookies among them`);

console.log('\n-- bigger roles --');
const beringer = hot.players.find((p) => p.name === 'Joan Beringer');
const min5Of = (id) => gamesOf(NOW_ROWS, id).slice(-5).reduce((a, r) => a + r.min, 0) / 5;
ok(beringer && beringer.role && beringer.role.min === round1(min5Of(beringer.id)) && beringer.role.before === PRIORS[beringer.id].min, `Beringer: ${beringer && beringer.role.min} minutes, ${beringer && beringer.role.before} last season, flagged`);
ok(hot.players.every((p) => !!p.role === (min5Of(p.id) - PRIORS[p.id].min >= 5)), 'and each player flagged only at 5+ minutes up, the long way');
const softOnes = hot.players.filter((p) => p.markets[0].third === 'soft');
const runOf = (p) => Math.max(...p.markets.map((m) => m.run));
ok(softOnes.every((p, i) => !i || runOf(softOnes[i - 1]) >= runOf(p)) && hot.players.findIndex((p) => p.markets[0].third !== 'soft') === softOnes.length, 'soft teams first, then the longest run');
const roleAhead = softOnes.findIndex((p, i) => p.role && softOnes.slice(i + 1).some((q) => !q.role));
ok(roleAhead >= 0, `a bigger role is not sorted down: ${softOnes[roleAhead] && softOnes[roleAhead].name} is ahead of a player on steady minutes`);

console.log('\n-- who is not listed --');
const wid = wig.id, wiggins = NOW_ROWS.filter((r) => r.player_id === wid);
const cut = (id, keep) => { const mine = NOW_ROWS.filter((r) => r.player_id === id); const drop = new Set(mine.slice(keep).map((r) => r.game_id)); return NOW_ROWS.filter((r) => r.player_id !== id || !drop.has(r.game_id)); };
NOW = MORNING;
S = scene({ rows: cut(wid, 4) });
await begin(NOW);
ok(!(await get('/api/nba-pp')).hot.players.some((p) => p.id === wid), `Wiggins with 4 of his ${wiggins.length} games: not listed`);
const levelled = NOW_ROWS.map((r) => (r.player_id === wid && r.game_id === wiggins[wiggins.length - 3].game_id ? { ...r, pts: 0, reb: 0, ast: 0, threes: 0 } : r));
S = scene({ rows: levelled });
await begin(MORNING);
hot = (await get('/api/nba-pp')).hot;
ok(!row('Aaron Wiggins', 'pts', hot), 'one poor game in his last five: the run is over');
const lowMin = NOW_ROWS.map((r) => (r.player_id === wid ? { ...r, min: 19 } : r));
S = scene({ rows: lowMin });
await begin(MORNING);
ok(!(await get('/api/nba-pp')).hot.players.some((p) => p.id === wid), 'under 20 minutes over his last five: not listed');

console.log('\n-- too early for ranks --');
const firstWeek = NOW_ROWS.filter((r) => r.date <= '2026-10-26');
const teamsThen = [...allowedTable(firstWeek, 'pts')].filter(([, c]) => c.n >= 5).length;
S = scene({ rows: firstWeek });
await begin(MORNING);
hot = (await get('/api/nba-pp')).hot;
ok(teamsThen < 20 && hot.ready === false && hot.players.length === 0 && hot.teamsReady === teamsThen && hot.gamesNeeded === 5, `the league's first week: ${teamsThen} teams with 5 games, none listed, and it says how far off`);

console.log('\n-- on the newest report, and with nothing to read --');
const report = { [SB.content.sbData.events.find((e) => e.competitions[0].competitors.some((c) => c.team.abbreviation === 'ATL')).id]: feedOf({ 'Atlanta Hawks': [listed(realOut, wid, 'Aaron Wiggins')] }) };
S = scene({ report });
await begin(MORNING);
hot = (await get('/api/nba-pp')).hot;
ok(!hot.players.some((p) => p.id === wid), 'ESPN lists him out: he leaves the list');
S = scene({ assets: false });
await begin(MORNING);
hot = (await get('/api/nba-pp')).hot;
ok(hot && hot.ready === true && hot.players.length === 0, 'no priors file: no early names, the section still there');

console.log('\n-- a PrizePicks number, against the games he has --');
S = scene();
await begin(MORNING);
hot = (await get('/api/nba-pp')).hot;
const rebRow = flat(hot).find((x) => x.market === 'reb' && x.team === 'MIN');
const ppRow = NBAPP.legs.find((r) => r.market === 'reb');
S.sq.prepare(`INSERT INTO nbapp (date, game_id, player, market, league, commence, home, away, team, player_id, point, proj, model_under, min_proj, captured_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('2026-11-02', 'ev1', rebRow.name, 'reb', 'reg', rebRow.player.commence, 'Minnesota Timberwolves', 'Milwaukee Bucks', 'MIN', rebRow.id, ppRow.first.line, ppRow.proj, ppRow.first.under, ppRow.min_proj, new RealDate(NOW).toISOString());
hot = (await get('/api/nba-pp')).hot;
const rebNow = flat(hot).find((x) => x.name === rebRow.name && x.market === 'reb');
const clearedLong = gamesOf(NOW_ROWS, rebRow.id).slice(-10).filter((r) => r.reb > ppRow.first.line).length;
ok(rebNow.line === ppRow.first.line && rebNow.cleared === clearedLong && rebNow.read === null, `${rebNow.name}'s rebounds number ${rebNow.line}, cleared ${rebNow.cleared} of his ${rebNow.seen}, and still no side`);
ok(S.oddsCalls === 0, 'still no odds call');

console.log('\n-- mid-season: 10+ games the tested rule, 5 to 9 the early one --');
const TIP = Date.parse('2027-01-16T01:30:00Z');
const OLD_SB_ON = JSON.parse(yearOn(JSON.stringify(OLD_SB)).replace(/2026-01-16/g, '2027-01-16'));
for (const e of OLD_SB_ON.content.sbData.events) { e.status.type.name = 'STATUS_SCHEDULED'; e.date = '2027-01-16T01:30Z'; }
S = scene({ rows: OLD_ROWS, sb: OLD_SB_ON, sbDay: '20270115' });
NOW = TIP - 8 * 3600e3;
await begin(NOW);
hot = (await get('/api/nba-pp')).hot;
const longRows = flat(hot).filter((x) => x.lastSeason == null), earlyRows = flat(hot).filter((x) => x.lastSeason != null);
ok(hot.ready === true && hot.early === false && hot.gamesNeeded === 10 && hot.teamsReady === 30, 'all 30 teams at 10 games: the full ranks');
ok(longRows.length >= 8 && longRows.every((x) => x.read && typeof x.read.rate === 'number' && x.seen === 10 && x.seasonAvg != null), `${longRows.length} runs on the tested rule, each with what last season said`);
ok(earlyRows.every((x) => { const n = gamesOf(OLD_ROWS, x.id).length; return n >= 5 && n < 10 && x.read === null; }), 'anyone with 5 to 9 games stays early, no side');
// A real run, the same player as if back from injury: only his last seven games left.
const back = longRows.find((x) => { const pr = PRIORS[x.id]; return pr && pr.gp >= 20 && gamesOf(OLD_ROWS, x.id).slice(-5).every((r) => STAT[x.market](r) > lastYear(pr, x.market)); });
const backGames = new Set(gamesOf(OLD_ROWS, back.id).slice(-7).map((r) => r.game_id));
S = scene({ rows: OLD_ROWS.filter((r) => r.player_id !== back.id || backGames.has(r.game_id)), sb: OLD_SB_ON, sbDay: '20270115' });
await begin(TIP - 8 * 3600e3);
hot = (await get('/api/nba-pp')).hot;
const backRow = flat(hot).find((x) => x.id === back.id && x.market === back.market);
ok(hot.early === false && backRow && backRow.lastSeason === lastYear(PRIORS[back.id], back.market) && backRow.read === null && backRow.seen === 7, `${back.name} with 7 games: last season's ${backRow && backRow.lastSeason}, no side`);
ok(flat(hot).some((x) => x.id !== back.id && x.read && x.lastSeason == null), 'beside others on the tested rule, each with its numbers');

console.log('\n-- the tested rule on early ranks: no side --');
const MID = '2026-11-08';
const midRows = OLD_ROWS.filter((r) => r.date <= MID);
const teams10 = [...allowedTable(midRows, 'pts')].filter(([, c]) => c.n >= 10).length;
const has10 = new Set([...new Set(midRows.map((r) => r.player_id))].filter((id) => gamesOf(midRows, id).length >= 10));
// Daniels and Hachimura have 10 games and a run by then: Hawks and Lakers play.
const midSb = JSON.parse(JSON.stringify(OLD_SB_ON));
midSb.content.sbData.events = midSb.content.sbData.events.filter((e) => ['401810440', '401810441'].includes(e.id));
S = scene({ rows: midRows, sb: midSb, sbDay: '20270115' });
await begin(NOW);
hot = (await get('/api/nba-pp')).hot;
console.log(`  to ${MID}: ${teams10} teams at 10 games, ${has10.size} players at 10, ${flat(hot).length} runs`);
ok(teams10 < 20 && hot.early === true && hot.gamesNeeded === 5, `${teams10} teams at 10 games: still the early ranks`);
const ownEarly = flat(hot).filter((x) => x.lastSeason == null);
ok(ownEarly.length >= 2 && ownEarly.every((x) => x.seasonAvg != null && x.seen === 10 && gamesOf(midRows, x.id).length >= 10), `the tested rule found ${[...new Set(ownEarly.map((x) => x.name))].join(', ')}, on 10 games`);
const onTen = ownEarly.filter((x) => gamesOf(midRows, x.id).length === 10);
ok(onTen.length >= 1 && onTen.every((x) => x.up.slice(0, 5).every((u) => u === null) && x.up.slice(5).every((u) => u === 1)), 'with exactly 10 games, the first five are too early to count, not misses');
ok(flat(hot).every((x) => x.read === null), 'but no row claims a side while teams are ranked on so few games');

console.log('\n-- the page --');
S = scene();
await begin(MORNING);
const payload = (await get('/api/nba-pp')).hot;
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const sect = app.slice(app.indexOf('  // ---- Hot players'), app.indexOf('  function renderNba('));
const state = { nbaPp: { hot: payload }, nbaHotAll: false };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const nbaNick = (name) => String(name || '').trim().split(/\s+/).pop();
const sharpTag = (p) => (typeof p === 'number' ? `<span class="tc-sharp">sharp ${Math.round(p)}%</span>` : '');
const card = new Function('state', 'esc', 'nbaNick', 'sharpTag', 'avatarHtml', 'soccerKick', 'nbaCardInjTag', `${sect}\nreturn nbaHotCardHtml;`)(
  state, esc, nbaNick, sharpTag, (o) => `<span class="hs" data-id="${o.playerId}"></span>`, () => '5:10 PM', (x) => (x.inj ? ' FLAG' : ''));
let html = card();
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const liOf = (h, name) => h.split('<li>').find((x) => x.includes(name)) || '';
console.log(`  ${text(html).slice(0, 1100)}`);
ok(/Early in the season: five or more games in a row above last season's average, with the team he plays ranked for that stat on 5\+ games/.test(html) && /At 10 games a player moves to his own average/.test(html) && /Replayed on last season's games, that leaned neither way \(the Under hit 46\.9%, sharp books 50\.5\), so no side/.test(html) && !/been tested|A lead/.test(html), 'it says what the early list is, what comes next, and what the replay found');
ok(!/the Under beat the Over/.test(html), 'and leaves last season\'s finding, which is about the other rule, for when that rule applies');
ok(!/tonight/.test(html), 'and no "tonight": on a night with no games the list is already on tomorrow\'s');
ok((html.match(/<li>/g) || []).length === Math.min(5, softOnes.length), 'soft teams first, five at most');
const boxesOf = (m) => m.last10.map((v, i) => `<i class="${m.up[i] === 1 ? 'h' : m.up[i] === 0 ? 'm' : 'n'}">${v}</i>`).join('');
const sets = html.split('<li>').slice(1).map((li) => (li.match(/class="tb-boxes"/g) || []).length);
ok(sets.length >= 2 && sets.every((n) => n === 1) && /oldest → latest · filled: above last season's [\d.]+/.test(html), 'one set of boxes a player, against last season');
const firstSoft = payload.players.filter((p) => p.markets[0].third === 'soft')[0];
ok(liOf(html, firstSoft.name).includes(boxesOf(firstSoft.markets[0])), `${firstSoft.name}'s top run, each game in its place`);
ok(/in a row · [\d.]+ last five, [\d.]+ last season/.test(html), 'each run against last season, in those words');
ok(/No PrizePicks number yet · no lean last season, so no side/.test(html) && !/Lean |Slight |No side:|[Nn]ot tested/.test(html), 'no side anywhere, on one short line');
ok(!/read about an hour before tip/.test(html), 'and it does not promise a read no one is paying for');
// One run a player before the tap (2026-11-03): every soft run took five players to 3,020px on
// a phone, one of them six rows saying the same thing.
const MK = new Function(`${app.match(/const NBA_HOT_MK = \{[^}]*\};/)[0]} return NBA_HOT_MK;`)();
const softOf = (p) => p.markets.filter((m) => m.third === 'soft');
const runsEach = (h) => h.split('<li>').slice(1).map((li) => (li.match(/class="hot-mk"/g) || []).length);
ok(runsEach(html).length >= 2 && runsEach(html).every((n) => n === 1), 'one run a player before the tap');
const several = payload.players.filter((p) => softOf(p).length > 1 && liOf(html, p.name))[0];
ok(several && liOf(html, several.name).includes(`Also on a run: ${softOf(several).slice(1).map((m) => MK[m.market]).join(', ')}`), `the rest named in a line: ${several && several.name}`);
const single = payload.players.filter((p) => p.markets.length === 1 && liOf(html, p.name))[0];
ok(!single || !/Also on a run/.test(liOf(html, single.name)), 'and no such line for a player with one run');
const later = softOf(several)[1];
state.nbaPp.hot = { ...payload, players: payload.players.map((p) => (p.id !== several.id ? p : { ...p, markets: p.markets.map((m) => (m === later ? { ...m, line: 4.5, cleared: 3 } : m)) })) };
ok(/PP 4\.5 · cleared it 3/.test(liOf(card(), several.name)) && liOf(card(), several.name).includes(boxesOf(later)) && liOf(card(), several.name).includes(`Also on a run: ${MK[softOf(several)[0].market]}`), 'the run with a PrizePicks number goes first, ahead of a longer one with none');
state.nbaPp.hot = payload;
state.nbaHotAll = true;
html = card();
ok(/Bigger role: 20 minutes a game, 8 last season/.test(liOf(html, 'Joan Beringer')), 'a bigger role, in plain words');
ok((html.match(/class="tb-boxes"/g) || []).length === flat(payload).length, 'the tap: a set of boxes for every run');
const oneTooEarly = { ...payload, players: [{ ...payload.players[0], markets: [{ ...payload.players[0].markets[0], up: payload.players[0].markets[0].up.map((u, i) => (i ? u : null)) }] }] };
state.nbaPp.hot = oneTooEarly;
ok(/<span class="tb-boxes"[^>]*><i class="n">/.test(card()), 'a game too early to count looks like neither a hit nor a miss');
state.nbaPp.hot = payload;
ok(!/Bigger role/.test(liOf(html, 'Aaron Wiggins')), 'and steady minutes do not say it');
const pts = flat(payload).find((x) => x.market === 'reb');
state.nbaPp.hot = { ...payload, players: payload.players.map((p) => ({ ...p, markets: p.markets.map((m) => (m.market === 'reb' ? { ...m, line: 4.5, cleared: 3 } : m)) })) };
ok(new RegExp(`PP 4\\.5 · cleared it 3 of his last ${pts.seen}`).test(card()) && /No lean last season, so no side/.test(card()), `the number, against the ${pts.seen} games he has, and still no side`);
const ownAverage = (line) => ({ ...payload, players: payload.players.map((p) => ({ ...p, markets: p.markets.map(({ lastSeason, ...m }) => ({ ...m, seasonAvg: 5, ...line })) })) });
state.nbaPp.hot = ownAverage({});
ok(/No PrizePicks number yet · not tested, so no side/.test(card()) && !/no lean last season/i.test(card()), 'ten games while teams are ranked on five: not what the replay covered, so not what it found');
state.nbaPp.hot = ownAverage({ line: 4.5, cleared: 3 });
ok(/Not tested, so no side/.test(card()) && !/no lean last season/i.test(card()), 'and the same once a number is in');
state.nbaPp.hot = { ...payload, early: false, gamesNeeded: 10 };
ok(/the Under beat the Over/.test(card()) && /Under 10 games: five or more in a row above last season's average\. Replayed on last season's games, that leaned neither way/.test(card()) && !/Early in the season/.test(card()), 'with the full ranks, the tested rule first, and a line for anyone still under 10');
ok(!/tonight/.test(card()), 'nor with the full ranks');
state.nbaPp.hot = { ...payload, ready: false, teamsReady: 12, players: [] };
ok(/A player needs 5 games, and opponents are ranked once 20 teams have played 5: 12 have so far/.test(card()), 'too early: how far off, in the right numbers');
state.nbaHotAll = false;
const css = fs.readFileSync(BOARD + '/style.css', 'utf8');
ok(/\.hot-role \{/.test(css), 'styled');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
