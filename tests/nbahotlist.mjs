// The Hot players section on the NBA tab (2026-11-02, the owner's call: they expected to see
// the players the hot-run log follows, and it showed them nowhere). What has to hold:
//   - a player is listed on 5+ games in a row above his own average, with 10+ games and 20+
//     minutes over his last five, the team he plays ranked for that stat
//   - it costs no credits: the cron builds it from the box scores, with no odds call at all
//   - no page reads a box score: the cron keeps one row, three hours at a time
//   - tonight's number comes from what the reads stored: the hot log's read, the later, else
//     the PrizePicks log's on rebounds and threes; held against his last ten when there is one
//   - each run says what last season said of a run like it, by the opponent's third and how
//     often he cleared the number. The Over only where the streak log's cause is behind it
//   - on the newest report: out, he leaves the list; day-to-day, he is flagged
//   - too few games, it says how far off (tests/nbahotearly.mjs has the first weeks); a list it
//     cannot read costs the section, not the tab
//   - the page shows soft teams first and the rest behind a tap, and offers no star
//
// Real data: the league's real box rows to Jan 15 2026 (nba-box-league-to-20260115.json), that
// day's real ESPN slate, real report entries, a real PrizePicks log row. The odds payload is the
// one the repo has from that night, with names swapped as in tests/nbahot.mjs. Everything a
// year on. Every run, rank and count is worked out here the long way, from the box rows, and
// held against what the worker says. Real SQLite and the real worker.
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
const NBAPP = read('nbapp-20261101.json');
const expand = (r) => ({ game_id: LEAGUE.games[r[0]][0], date: yearOn(LEAGUE.games[r[0]][1]), player_id: LEAGUE.players[r[1]][0], player: LEAGUE.players[r[1]][1], team: r[2], min: r[3], pts: r[4], reb: r[5], ast: r[6], threes: r[7] });
const HISTORY = LEAGUE.rows.map(expand);
const MAVS = '401810438', MAGIC = '401810433';
const MAVS_EVENT = P.events.find((e) => /Utah Jazz/.test(e.game)).id, MAGIC_EVENT = P.odds.data.id;
const TIP = { [MAVS]: Date.parse('2027-01-16T01:30:00Z'), [MAGIC]: Date.parse('2027-01-15T19:00:00Z') };
const TEAMS = { [MAVS]: ['DAL', 'UTAH'], [MAGIC]: ['ORL', 'MEM'] };

const RealDate = Date;
let NOW = 0;
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
const J = (x, h = {}) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json', ...h } });

// Real report entries, the player swapped: one Out both ways, one day-to-day.
const entries = Object.values(INJ).flatMap((f) => (f.gamepackageJSON || f).injuries || []).flatMap((t) => t.injuries || []);
const realOut = entries.find((i) => i.status === 'Out' && i.details && i.details.fantasyStatus && i.details.fantasyStatus.abbreviation === 'OUT');
const realGtd = entries.find((i) => i.details && i.details.fantasyStatus && i.details.fantasyStatus.abbreviation === 'GTD');
const listed = (real, id, name) => { const e = JSON.parse(JSON.stringify(real)); Object.assign(e.athlete, { id, displayName: name, lastName: name.split(' ').pop() }); return e; };
const feedOf = (teams) => ({ gamepackageJSON: { injuries: Object.entries(teams).map(([displayName, injuries]) => ({ team: { displayName }, injuries })) } });

const SWAPS = { 'Cam Spencer': 'Naji Marshall', 'Paolo Banchero': 'Cody Williams', 'Cedric Coward': 'Ryan Nembhard', 'Jock Landale': 'Anthony Davis',
  'Tristan da Silva': 'Jusuf Nurkic', 'Noah Penda': 'Daniel Gafford', 'Desmond Bane': 'Klay Thompson' };
const mavsBody = () => { let text = JSON.stringify(shifted(P.odds.data));
  for (const [a, b] of Object.entries(SWAPS)) text = text.split(a).join(b);
  return { ...JSON.parse(text), id: MAVS_EVENT, home_team: 'Dallas Mavericks', away_team: 'Utah Jazz', commence_time: '2027-01-16T01:40:00Z' }; };
const magicBody = () => shifted(P.odds.data);

let S = null;
function scene({ games, report = {}, body = () => mavsBody(), rows = HISTORY, key = 'k' }) {
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
  return { sq, sqls, env: { DB, ...(key ? { ODDS_API_KEY: key } : {}) }, games, report, body, rows, reads: [], oddsCalls: 0 };
}
globalThis.fetch = async (u) => {
  const url = String(u);
  if (/the-odds-api\.com/.test(url)) S.oddsCalls++;
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
    S.reads.push({ id: ev[1] });
    return J(S.body(ev[1]), { 'x-requests-last': '7', 'x-requests-remaining': '60000' });
  }
  if (/\/sports\/basketball_nba\/events\?/.test(url)) {
    return J(P.events.map((e) => { const [away, home] = e.game.split(' @ '); return { id: e.id, commence_time: yearOn(e.commence), home_team: home, away_team: away }; }), { 'x-requests-last': '0' });
  }
  return new Response('{}', { status: 404 });
};
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
let mod = null, scenes = 0;
const loadWorker = async () => { mod = await import('data:text/javascript;base64,' + Buffer.from(`${src}\n// scene ${++scenes}`).toString('base64')); };
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), S.env, { waitUntil: () => {} })).json();
const tick = async () => { const held = []; await mod.default.scheduled({ cron: '*/5 * * * *', scheduledTime: NOW }, S.env, { waitUntil: (p) => held.push(p) }); await Promise.all(held); };
const insBox = (rows) => { const ins = S.sq.prepare('INSERT INTO nba_box (game_id, date, season_type, player_id, player, team, min, pts, reb, ast, threes, dnp) VALUES (?,?,2,?,?,?,?,?,?,?,?,0)');
  for (const r of rows) ins.run(r.game_id, r.date, r.player_id, r.player, r.team, r.min, r.pts, r.reb, r.ast, r.threes); };
// The first tick reads the slate and the second, with the report in, can build from it.
const begin = async (at) => { await loadWorker(); await get('/api/nba-pp'); insBox(S.rows); NOW = at; await tick(); NOW += 5 * 60e3; await tick(); };

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// ---- The long way, from the box rows ------------------------------------------------------
const STAT = { pts: (r) => r.pts, pra: (r) => r.pts + r.reb + r.ast, pts_reb: (r) => r.pts + r.reb, pts_ast: (r) => r.pts + r.ast, reb_ast: (r) => r.reb + r.ast, reb: (r) => r.reb, threes: (r) => r.threes };
const played = HISTORY.filter((r) => r.min > 0);
const gamesOf = (id, rows = played) => rows.filter((r) => r.player_id === id);
function runOf(id, mk) {
  const v = gamesOf(id).map(STAT[mk]);
  let run = 0;
  for (let j = v.length - 1; j >= 5; j--) { if (v[j] > v.slice(0, j).reduce((a, x) => a + x, 0) / j) run++; else break; }
  return run;
}
function allowedTable(mk, rows = played) {
  const games = new Map();
  for (const r of rows) { if (!games.has(r.game_id)) games.set(r.game_id, new Map()); const g = games.get(r.game_id); g.set(r.team, (g.get(r.team) || 0) + STAT[mk](r)); }
  const t = new Map();
  for (const g of games.values()) { const [a, b] = [...g.keys()]; if (b == null) continue;
    for (const [me, them] of [[a, b], [b, a]]) { const c = t.get(me) || { n: 0, sum: 0 }; c.n++; c.sum += g.get(them); t.set(me, c); } }
  return t;
}
// 1 allows the most. Of the teams with 10+ games.
function posOf(team, mk) {
  const list = [...allowedTable(mk)].filter(([, c]) => c.n >= 10).map(([k, c]) => [k, c.sum / c.n]).sort((a, b) => b[1] - a[1]);
  return { pos: list.findIndex(([k]) => k === team) + 1, of: list.length };
}
function expectedFor(game, oppOf) {
  const out = [];
  for (const team of TEAMS[game]) {
    const ids = new Set(played.filter((r) => r.team === team).map((r) => r.player_id));
    for (const id of ids) {
      const gs = gamesOf(id);
      if (gs[gs.length - 1].team !== team || gs.length < 10) continue;
      if (gs.slice(-5).reduce((a, r) => a + r.min, 0) / 5 < 20) continue;
      for (const mk of Object.keys(STAT)) { const run = runOf(id, mk); if (run >= 5) out.push({ id, name: gs[gs.length - 1].player, mk, run, ...posOf(oppOf[team], mk) }); }
    }
  }
  return out;
}
const flat = (hot) => hot.players.flatMap((p) => p.markets.map((m) => ({ ...m, id: p.id, name: p.name, team: p.team, player: p })));
const of = (hot, name, mk) => flat(hot).find((x) => x.name === name && x.market === mk);
const key = (x) => `${x.name}|${x.mk || x.market}|${x.run}|${x.pos}/${x.of}`;
const LIST_SCAN = /SELECT game_id, date, player_id, player, team, min, pts, reb, ast, threes FROM nba_box/;

console.log('-- the morning of the game: from the box scores, no credits --');
NOW = TIP[MAVS] - 8 * 3600e3;
S = scene({ games: [MAVS], key: null });
await begin(NOW);
let board = await get('/api/nba-pp');
let hot = board.hot;
ok(S.oddsCalls === 0, 'not one call to the odds feed, with no key to make one');
ok(hot && hot.ready === true && hot.teamsReady === 30, `ready: ${hot && hot.teamsReady} teams with 10 games`);
const wantMavs = expectedFor(MAVS, { DAL: 'UTAH', UTAH: 'DAL' });
console.log(`  ${flat(hot).map((x) => `${x.name} ${x.market} ${x.run} in a row, ${x.pos} of ${x.of} (${x.third})`).join(' | ')}`);
ok(wantMavs.length >= 8 && JSON.stringify(flat(hot).map(key).sort()) === JSON.stringify(wantMavs.map(key).sort()), `every run of 5+ in Jazz @ Mavericks, its rank, worked out the long way: ${wantMavs.length} of them`);
const marshall = of(hot, 'Naji Marshall', 'pts');
ok(marshall.pos === 1 && marshall.third === 'soft' && marshall.run === 5 && marshall.last5 === 18.4 && marshall.seasonAvg === 13.8, 'Marshall: 5 in a row, 18.4 over five against 13.8, and Utah allows the most points');
const player = hot.players.find((p) => p.name === 'Naji Marshall');
ok(player.team === 'DAL' && player.isHome === true && player.oppName === 'Utah Jazz' && Date.parse(player.commence) === TIP[MAVS], 'Marshall at home to the Jazz, at the real tip');
ok(marshall.line === null && marshall.cleared === null && marshall.sharp === null, 'no number read yet, and none made up');
ok(marshall.read.side === 'Under' && marshall.read.rate === 57 && marshall.read.sharp === 50.5 && marshall.read.n === 741 && marshall.read.clears === true, 'until there is one: what soft teams went, the Under 57.0% to the sharp books 50.5');
// A chance on each run (2026-11-03): the table typed out here, each run's games counted here.
const floor5 = (v) => Math.floor(v / 5) * 5;
const goesLong = (x) => {
  const gp = gamesOf(x.id).length, gap = (x.last5 - x.seasonAvg) / x.seasonAvg;
  const rate = gp >= 40 ? (gap < 0.3 ? 205 / 416 : gap < 0.5 ? 399 / 645 : 1244 / 1654) : gp >= 20 ? (gap < 0.3 ? 200 / 420 : gap < 0.5 ? 350 / 593 : 796 / 1120) : gap < 0.3 ? 182 / 326 : 318 / 526;
  return floor5(rate * 100 + (x.market === 'threes' ? -13 : 0));
};
console.log(`  goes on: ${flat(hot).slice(0, 6).map((x) => `${x.name} ${x.market} ${gamesOf(x.id).length} games ${x.last5} v ${x.seasonAvg}: ${x.goesOn && x.goesOn.pct}`).join(' | ')}`);
ok(flat(hot).length >= 8 && flat(hot).every((x) => x.goesOn && x.goesOn.pct === goesLong(x) && x.goesOn.n > 100), 'every run says how often runs like it went on, by his games and how far his last five sit above his average');
const goesOnOf = new Function(`${/const NBA_HOTLIST_GOES_ON = [\s\S]*?\nfunction nbaHotGoesOn\(m\) \{[\s\S]*?\n\}\n/.exec(src)[0]}\nreturn nbaHotGoesOn;`)();
const pctOf = (m) => (goesOnOf(m) || {}).pct;
ok(pctOf({ market: 'pra', last5: 20, lastSeason: 11.3 }) === 80 && pctOf({ market: 'reb_ast', last5: 11.8, lastSeason: 8.7 }) === 70, 'under 10 games, against last season: 77% above about 80, 36% above about 70');
ok(pctOf({ market: 'threes', last5: 3.8, lastSeason: 2.7 }) === 55, 'threes run 13 points lower');
ok([[15, 12], [15, 16], [25, 12], [25, 14], [25, 16], [50, 12], [50, 14], [50, 16]].map(([gp, last5]) => pctOf({ market: 'pts', gp, last5, seasonAvg: 10 })).join() === '55,60,45,55,70,45,60,75', 'it climbs with his games: 50%+ above is about 60 at 15 games, 70 at 25, 75 at 50');
ok(goesOnOf({ market: 'pts', last5: 20, seasonAvg: 10 }) === null, 'a list built before this has no games to go by: no percentage, not a wrong one');
ok(goesOnOf({ market: 'pts', gp: 8, last5: 20, seasonAvg: 10 }) === null && goesOnOf({ market: 'threes', last5: 1, lastSeason: 0 }) === null, 'nor under 10 games on his own average, nor against an average of nothing');
const williams = of(hot, 'Cody Williams', 'pts_ast');
ok(williams.third === 'middle' && williams.read.rate === 53.5 && williams.read.clears === false, 'Williams against the middle third: the Under 53.5%, short of what a flex needs');
const softFirst = hot.players.map((p) => p.markets[0].third === 'soft');
ok(softFirst[0] && softFirst.every((x, i) => !i || softFirst[i - 1] >= x), 'soft teams first');
ok(hot.players[0].name === 'Cody Williams' && hot.players[0].markets[0].run === 8, 'the longest run leads: Williams, 8 in a row');
ok(hot.players.every((p) => p.markets.every((m, i, a) => !i || (a[i - 1].third === 'soft') >= (m.third === 'soft'))), "and each player's soft runs ahead of the rest");
const boxesLong = (x) => { const v = gamesOf(x.id).map(STAT[x.market]), from = Math.max(0, v.length - 10);
  return { last10: v.slice(from), up: v.slice(from).map((y, i) => (from + i >= 5 ? (y > v.slice(0, from + i).reduce((a, n) => a + n, 0) / (from + i) ? 1 : 0) : null)) }; };
ok(flat(hot).every((x) => JSON.stringify({ last10: x.last10, up: x.up }) === JSON.stringify(boxesLong(x))), 'each run has its last ten games, and which beat his average to that point, the long way');
ok(flat(hot).every((x) => x.up.slice(-x.run).every((u) => u === 1) && (x.run >= x.up.length || x.up[x.up.length - x.run - 1] !== 1)), 'the last filled boxes are the run itself, and the one before it is not');

console.log('\n-- what it reads, and how often --');
const scans = () => S.sqls.filter((q) => LIST_SCAN.test(q)).length;
const built = scans();
ok(built === 1, `the season's box rows read once to build it: ${built}`);
S.sqls.length = 0;
await get('/api/nba-pp');
ok(scans() === 0, 'the page asks: no box score read');
ok(S.sqls.filter((q) => /nba_hot_list/.test(q) || /key=\?/.test(q)).length >= 1, 'it reads the kept row');
const planHot = S.sq.prepare("EXPLAIN QUERY PLAN SELECT player_id, market, pp_line, sharp_under FROM nbahot WHERE date = '2027-01-15'").all().map((r) => r.detail).join(' ');
ok(/nbahot_date/.test(planHot), `tonight's numbers from an index, not the whole log: ${planHot}`);
const hourOn = NOW + 3600e3;
NOW = hourOn;
await tick();
ok(scans() === 0, 'a tick an hour on: not rebuilt');
NOW = TIP[MAVS] - 8 * 3600e3 + 3 * 3600e3 + 10 * 60e3;
await tick();
ok(scans() === 1, 'three hours on: rebuilt once');
NOW += 5 * 60e3;
await tick();
ok(scans() === 1, 'and the next tick leaves it');

console.log('\n-- tonight\'s number: the log\'s read, an hour before tip --');
NOW = TIP[MAVS] - 8 * 3600e3;
S = scene({ games: [MAVS] });
await begin(NOW);
ok(of((await get('/api/nba-pp')).hot, 'Naji Marshall', 'pts').line === null, 'nothing yet in the morning');
NOW = TIP[MAVS] - 55 * 60e3;
await tick();
hot = (await get('/api/nba-pp')).hot;
ok(S.reads.length === 1 && S.reads[0].id === MAVS_EVENT, 'the one read the hot log already makes: this section adds none');
const logged = S.sq.prepare("SELECT * FROM nbahot WHERE run >= 5").all();
const clearedOf = (name, mk, line) => { const id = played.find((r) => r.player === name).player_id; return gamesOf(id).slice(-10).filter((r) => STAT[mk](r) > line).length; };
const onHot = logged.map((r) => ({ r, x: of(hot, r.player, r.market) }));
ok(logged.length >= 8 && onHot.every(({ r, x }) => x && x.line === r.pp_line && x.sharp === r.sharp_under && x.cleared === clearedOf(r.player, r.market, r.pp_line)), `each run the read found: the number, the sharp chance, and how often he cleared it, counted the long way (${logged.length})`);
const mPts = of(hot, 'Naji Marshall', 'pts'), mPra = of(hot, 'Naji Marshall', 'pra');
console.log(`  Marshall pts ${mPts.line}: ${mPts.cleared} of 10, read ${JSON.stringify(mPts.read)} | pra ${mPra.line}: ${mPra.cleared} of 10, ${JSON.stringify(mPra.read)}`);
ok(mPts.line === 13 && mPts.cleared === 7 && mPts.read.side === 'Under' && mPts.read.rate === 53.5 && mPts.read.sharp === 50.6 && mPts.read.clears === false, 'Marshall at 13 points, cleared 7 of 10: a soft team, still clearing it: Under 53.5%, short of a flex');
ok(mPra.cleared === 3 && mPra.read.rate === 59.3 && mPra.read.sharp === 50.4 && mPra.read.clears === true, 'Marshall at his PRA number, 3 of 10: the number has caught up: Under 59.3% to 50.4');
const wPts = of(hot, 'Cody Williams', 'pts');
ok(wPts.cleared === 0 && wPts.third === 'middle' && wPts.read.rate === 58.5 && wPts.read.sharp === 50.8, 'Williams 0 of 10 against the middle: Under 58.5% to 50.8');
const nPts = of(hot, 'Jusuf Nurkic', 'pts');
ok(nPts.third === 'middle' && nPts.cleared === 9 && nPts.read.side === null && nPts.read.rate === 48.5 && nPts.read.sharp === 50.3, 'Nurkic 9 of 10 against the middle: no side at all, the Under 48.5% to 50.3');
ok(!/hotRun/.test(fs.readFileSync(BOARD + '/app.js', 'utf8')), 'the log\'s record stays off the page');

console.log('\n-- tonight\'s number: the PrizePicks log, hours earlier, on rebounds --');
NOW = TIP[MAVS] - 8 * 3600e3;
S = scene({ games: [MAVS], key: null });
await begin(NOW);
const gafford = (await get('/api/nba-pp')).hot.players.find((p) => p.name === 'Daniel Gafford');
ok(gafford && gafford.markets.some((m) => m.market === 'reb' && m.run >= 5), 'Gafford on a run in rebounds, a market the PrizePicks log reads');
// A real rebounds row from production's log, as this player's.
const ppRow = NBAPP.legs.find((r) => r.market === 'reb');
const logRow = (eventId, name, team, id, home, away, commence) => S.sq.prepare(`INSERT INTO nbapp (date, game_id, player, market, league, commence, home, away, team, player_id, point, proj, model_under, min_proj, captured_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('2027-01-15', eventId, name, 'reb', 'reg', commence, home, away, team, id, ppRow.first.line, ppRow.proj, ppRow.first.under, ppRow.min_proj, new RealDate(NOW).toISOString());
logRow(MAVS_EVENT, 'Daniel Gafford', 'DAL', gafford.id, 'Dallas Mavericks', 'Utah Jazz', '2027-01-16T01:40:00Z');
const gReb = of((await get('/api/nba-pp')).hot, 'Daniel Gafford', 'reb');
ok(gReb.line === ppRow.first.line && gReb.cleared === clearedOf('Daniel Gafford', 'reb', ppRow.first.line), `his rebounds number from the log, ${gReb.line}, cleared ${gReb.cleared} of 10, counted the long way`);
ok(gReb.third === 'soft' && gReb.cleared >= 6 && gReb.read.rate === 53.5, 'and what last season said of that: a soft team, still clearing it');
ok(S.oddsCalls === 0, 'still no odds call');

console.log('\n-- on the newest report --');
NOW = TIP[MAVS] - 8 * 3600e3;
const nurkicId = played.find((r) => r.player === 'Jusuf Nurkic').player_id, marshallId = played.find((r) => r.player === 'Naji Marshall').player_id;
S = scene({ games: [MAVS], key: null });
await begin(NOW);
ok((await get('/api/nba-pp')).hot.players.some((p) => p.name === 'Jusuf Nurkic'), 'Nurkic is listed on a clean report');
S.report[MAVS] = feedOf({ 'Utah Jazz': [listed(realOut, nurkicId, 'Jusuf Nurkic')], 'Dallas Mavericks': [listed(realGtd, marshallId, 'Naji Marshall')] });
NOW += 45 * 60e3;
await tick();
ok(scans() === 1, 'the report changed, the list not rebuilt');
hot = (await get('/api/nba-pp')).hot;
ok(!hot.players.some((p) => p.name === 'Jusuf Nurkic'), 'ESPN lists him out: he leaves the list, on the report as it stands now');
const gtd = hot.players.find((p) => p.name === 'Naji Marshall');
ok(gtd && gtd.inj && gtd.inj.status === 'GTD' && !gtd.inj.out, 'day-to-day: Marshall stays, flagged');

console.log('\n-- the one place the Over held: a streak with a cause --');
NOW = TIP[MAGIC] - 7 * 3600e3;
S = scene({ games: [MAGIC], body: magicBody, report: { [MAGIC]: feedOf({ 'Memphis Grizzlies': [listed(realOut, '4279888', 'Ja Morant')] }) } });
await begin(NOW);
NOW += 3 * 3600e3 + 10 * 60e3;
await tick();
NOW = TIP[MAGIC] - 55 * 60e3;
await tick();
hot = (await get('/api/nba-pp')).hot;
const wantMagic = expectedFor(MAGIC, { ORL: 'MEM', MEM: 'ORL' });
ok(JSON.stringify(flat(hot).map(key).sort()) === JSON.stringify(wantMagic.map(key).sort()), `Grizzlies @ Magic, the long way too: ${wantMagic.length} runs`);
const caused = hot.players.filter((p) => p.outs && p.outs.includes('Ja Morant'));
const passed = S.sq.prepare('SELECT DISTINCT player FROM nbacause').all().map((r) => r.player);
console.log(`  cause: ${caused.map((p) => p.name).join(', ')} | streak log: ${passed.join(', ')} | ${flat(hot).filter((x) => x.player.outs).map((x) => `${x.name} ${x.market} ${x.cleared}: ${x.read.side}`).join(', ')}`);
ok(caused.every((p) => passed.includes(p.name)), 'whoever carries a cause here is one the streak log itself passed');
ok(caused.some((p) => p.name === 'Jock Landale'), 'Landale, on a run with Morant out');
ok(of(hot, 'Jock Landale', 'reb').line === null && of(hot, 'Jock Landale', 'reb').read.side === 'Under', 'no number on his rebounds: what the opponent says, the Under');
const lid = caused.find((p) => p.name === 'Jock Landale').id;
logRow(MAGIC_EVENT, 'Jock Landale', 'MEM', lid, 'Orlando Magic', 'Memphis Grizzlies', '2027-01-15T19:10:00Z');
const withLine = (await get('/api/nba-pp')).hot;
const lReb = of(withLine, 'Jock Landale', 'reb');
console.log(`  Landale reb ${lReb.line}: ${lReb.cleared} of 10, ${lReb.third}, ${JSON.stringify(lReb.read)}`);
ok(lReb.cleared === clearedOf('Jock Landale', 'reb', ppRow.first.line) && lReb.cleared >= 6, `a number he has been clearing, ${lReb.cleared} of 10, counted the long way`);
ok(lReb.read.side === 'Over' && lReb.read.rate === 56.5 && lReb.read.sharp === 49.8 && lReb.read.n === 168 && lReb.read.clears === true, 'with the cause behind him, the Over: 56.5% to 49.8');
const overPayload = withLine;
const noCause = flat(withLine).filter((x) => !x.player.outs && x.cleared != null);
ok(noCause.length > 0 && noCause.every((x) => x.read.side !== 'Over'), 'no cause, no Over: Marshall at 7 of 10 above had the Under, Nurkic at 9 no side');
const causeLow = flat(withLine).filter((x) => x.player.outs && x.cleared != null && x.cleared < 6);
ok(causeLow.every((x) => x.read.side === 'Under'), 'the cause with 5 or fewer of 10 stays with the Under, where the numbers have it');

console.log('\n-- too few games --');
NOW = TIP[MAVS] - 8 * 3600e3;
const EARLY = '2026-10-27';
const earlyRows = HISTORY.filter((r) => r.date <= EARLY);
S = scene({ games: [MAVS], rows: earlyRows, key: null });
await begin(NOW);
hot = (await get('/api/nba-pp')).hot;
const readyLong = [...allowedTable('pts', earlyRows.filter((r) => r.min > 0))].filter(([, c]) => c.n >= 5).length;
ok(hot && hot.ready === false && hot.players.length === 0, 'the box scores to Oct 27: nothing listed');
ok(hot.teamsReady === readyLong && readyLong < 20 && hot.teamsNeeded === 20 && hot.gamesNeeded === 5, `and it says how far off: ${hot.teamsReady} teams of the 20 needed, counted the long way`);

console.log('\n-- what it cannot read --');
NOW = TIP[MAVS] - 8 * 3600e3;
S = scene({ games: [MAVS], key: null });
await begin(NOW);
S.sq.exec('DROP TABLE nbahot');
board = await get('/api/nba-pp');
ok(board.hot && board.hot.players.length > 0 && !board.error, 'the log unreadable: the runs still show, without numbers');
S.sq.prepare("UPDATE feed_cache SET data = '{not json' WHERE key = 'nba_hot_list_v3'").run();
board = await get('/api/nba-pp');
ok(board.hot === null && !board.error && Array.isArray(board.legs), 'the list unreadable: no section, the tab as it was');
NOW = TIP[MAVS] - 8 * 3600e3;
S = scene({ games: [], key: null });
await begin(NOW);
ok((await get('/api/nba-pp')).hot === null, 'no games and no list yet: nothing to show');

console.log('\n-- the games have started --');
NOW = TIP[MAVS] - 8 * 3600e3;
S = scene({ games: [MAVS, MAGIC], key: null });
await begin(NOW);
hot = (await get('/api/nba-pp')).hot;
ok(hot.players.some((p) => p.team === 'DAL') && hot.players.some((p) => p.team === 'ORL' || p.team === 'MEM'), 'both games to come: both listed');
NOW = TIP[MAGIC] + 60e3;
hot = (await get('/api/nba-pp')).hot;
ok(hot.players.some((p) => p.team === 'DAL') && !hot.players.some((p) => p.team === 'ORL' || p.team === 'MEM'), 'Magic underway: that game leaves, Dallas stays');
NOW = TIP[MAVS] + 11 * 60e3;
hot = (await get('/api/nba-pp')).hot;
ok(hot.ready === true && hot.players.length === 0, 'all started: empty, and still ready');

console.log('\n-- the page --');
NOW = TIP[MAVS] - 55 * 60e3;
S = scene({ games: [MAVS] });
await begin(TIP[MAVS] - 8 * 3600e3);
NOW = TIP[MAVS] - 55 * 60e3;
await tick();
const payload = (await get('/api/nba-pp')).hot;
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const sect = app.slice(app.indexOf('  // ---- Hot players'), app.indexOf('  function renderNba('));
const state = { nbaPp: { hot: payload }, nbaHotAll: false };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const nbaNick = (name) => String(name || '').trim().split(/\s+/).pop();
const sharpTag = (p) => (typeof p === 'number' ? `<span class="tc-sharp">sharp ${Math.round(p)}%</span>` : '');
const miniBar = new Function(`${app.match(/  function miniBar\(fill, tick, axisPct\) \{[\s\S]*?\n  \}\n/)[0]} return miniBar;`)();
const card = new Function('state', 'esc', 'nbaNick', 'sharpTag', 'miniBar', 'avatarHtml', 'soccerKick', 'nbaCardInjTag', `${sect}\nreturn nbaHotCardHtml;`)(
  state, esc, nbaNick, sharpTag, miniBar, (o) => `<span class="hs" data-id="${o.playerId}"></span>`, () => '5:40 PM', (x) => (x.inj ? ' FLAG' : ''));
let html = card();
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const softPlayers = payload.players.filter((p) => p.markets.some((m) => m.third === 'soft'));
console.log(`  ${text(html).slice(0, 900)}`);
ok(/Hot players/.test(html) && /A lead, not a pick/.test(html), 'titled, and says what it is');
const boxesOf = (m) => m.last10.map((v, i) => `<i class="${m.up[i] === 1 ? 'h' : m.up[i] === 0 ? 'm' : 'n'}">${v}</i>`).join('');
const sets = html.split('<li>').slice(1).map((li) => (li.match(/class="tb-boxes"/g) || []).length);
ok(sets.length >= 1 && sets.every((n) => n === 1) && /oldest → latest · filled: above his average to that point/.test(html), 'one set of boxes a player, against his average to that point');
ok(html.includes(boxesOf(softPlayers[0].markets.filter((m) => m.third === 'soft')[0])), 'his top run, each game in its place');
ok(/Naji Marshall/.test(html) && /<b class="tc-team">DAL<\/b> · v Jazz · 5:40 PM/.test(html), 'Marshall, at home to the Jazz');
ok(/<b>Points<\/b> · 5 in a row · 18\.4 last five, 13\.8 season/.test(html), 'the run, against his season');
ok(/Jazz allow the most points/.test(html) && /soft team/.test(html), 'the opponent in plain words');
ok(/PP 13 · cleared it 7 of his last 10/.test(html), 'the number and how often he cleared it');
ok(/Chance at PrizePicks' number: Under about 54%<\/span>/.test(html) && /tick: a flex needs <b>54\.2%<\/b> · sharp books 50\.6/.test(html), 'a side short of break-even says so');
ok(/Chance at PrizePicks' number: <b>Under about 59%<\/b><\/span>/.test(html) && /tick: a flex needs <b>54\.2%<\/b> · sharp books 50\.4/.test(html), 'and one past it leans');
// A bar on the chance (2026-11-03, the owner's call): the fill the chance, the tick what a flex needs.
const barAfter = (h, said) => { const i = h.indexOf(said); return i < 0 ? '' : (h.slice(i).match(/<span class="uz" style="width:[\d.]+%"><\/span><span class="tick" style="left:[\d.]+%">/) || [''])[0]; };
ok(barAfter(html, '<b>Under about 59%</b>').includes('width:59.3%') && barAfter(html, '<b>Under about 59%</b>').includes('left:54.2%'), 'the bar fills past the tick when the chance clears it');
ok(barAfter(html, 'Under about 54%</span>').includes('width:53.5%') && barAfter(html, 'Under about 54%</span>').includes('left:54.2%'), 'and stops short when it does not');
ok((html.match(/class="bmini"/g) || []).length === (html.match(/class="hot-mk"/g) || []).length, 'a bar on every run shown');
ok(/With 10\+ games, last season's November and December landed about 4 points under the chance shown/.test(html), 'and it says those months ran lower');
ok(/Run goes on: about <b>\d+%<\/b>/.test(html) && (html.match(/Run goes on:/g) || []).length === (html.match(/class="hot-mk"/g) || []).length, 'each run shown says how often runs like it went on');
ok(/Last season runs like these went on about 64% of the time, but the Over at PrizePicks' number landed 45%: the number has usually moved up by then/.test(html), 'and that a run going on is not the bet');
ok(!/data-action="leg-add"|tc-add/.test(html), 'no star: a lead does not go on a slip from here');
const liCount = (h) => (h.match(/<li>/g) || []).length;
ok(liCount(html) === Math.min(5, softPlayers.length) && softPlayers.length >= 1, `soft teams only, five at most: ${liCount(html)} of ${payload.players.length}`);
ok(payload.players.every((p) => p.markets[0].third === 'soft') && /data-action="nba-hot-all"/.test(html) && /Show every run \(4 players\)/.test(html), 'all four men have a soft run, and the tap is still there: Williams has runs against the middle too');
const liOf = (h, name) => h.split('<li>').find((x) => x.includes(name)) || '';
ok(/Pts\+Reb\+Ast/.test(liOf(html, 'Cody Williams')) && !/<b>Points<\/b>/.test(liOf(html, 'Cody Williams')), "Williams's runs against the soft third, his others waiting for the tap");
state.nbaHotAll = true;
html = card();
ok(liCount(html) === payload.players.length, `the tap: all ${payload.players.length}`);
ok(/<b>Points<\/b>/.test(liOf(html, 'Cody Williams')) && /Soft teams only/.test(html), 'his every run, and the way back');
ok(/Chance at PrizePicks' number: about even, the Under about 49%<\/span>/.test(liOf(html, 'Jusuf Nurkic')) && /width:48\.5%/.test(liOf(html, 'Jusuf Nurkic')) && /sharp books 50\.3/.test(liOf(html, 'Jusuf Nurkic')), 'no side says so');
state.nbaPp.hot = overPayload;
ok(/Chance at PrizePicks' number: <b>Over about 57%<\/b><\/span>/.test(liOf(card(), 'Jock Landale')) && /sharp books 49\.8 · minutes up, Ja Morant out/.test(liOf(card(), 'Jock Landale')), 'the Over names who is behind it');
ok(/Memphis|<b class="tc-team">MEM<\/b> · @ Magic/.test(liOf(card(), 'Jock Landale')), 'and an away game reads @');
state.nbaHotAll = false;
state.nbaPp.hot = { ...payload, ready: false, early: true, gamesNeeded: 5, teamsReady: 12, players: [] };
ok(/Not enough games yet/.test(card()) && /12 have so far/.test(card()) && /5 games/.test(card()), 'too early: how far off, in the numbers');
state.nbaPp.hot = { ...payload, players: [] };
ok(/No one is on a run of 5 or more/.test(card()), 'no one on a run: it says so');
state.nbaPp.hot = { ...payload, players: payload.players.map((p) => ({ ...p, markets: p.markets.map((m) => ({ ...m, third: 'tough' })) })) };
ok(/No one is on a run against a soft team/.test(card()) && /Show every run/.test(card()), 'runs, none against a soft team: it says so, and offers them');
const onlySoft = payload.players.map((p) => ({ ...p, markets: p.markets.filter((m) => m.third === 'soft') }));
state.nbaPp.hot = { ...payload, players: onlySoft };
ok(onlySoft.some((p) => p.markets.length > 1) && /data-action="nba-hot-all"/.test(card()), 'a second soft run is more to see: the tap stays');
state.nbaPp.hot = { ...payload, players: onlySoft.map((p) => ({ ...p, markets: p.markets.slice(0, 1) })) };
ok(!/data-action="nba-hot-all"/.test(card()), 'nothing more to see: no tap');
state.nbaPp.hot = { ...payload, players: Array.from({ length: 7 }, (_, i) => ({ ...onlySoft[0], id: String(i), name: `Player ${i}` })) };
ok(liCount(card()) === 5 && /Show every run \(7 players\)/.test(card()), 'a heavy night: five, and a tap to all seven');
state.nbaPp.hot = null;
ok(card() === '', 'no list: no section');
state.nbaPp = null;
ok(card() === '', 'nothing loaded: no section');
const render = app.slice(app.indexOf('  function renderNba('), app.indexOf('  // The NBA and NHL moneyline tabs draw one table'));
// The props card moved up under the best leg (2026-11-05, the owner's pick); the list stays under the PrizePicks cards.
ok((render.match(/propsCardHtml\('nba'\) \+ nbaPpCardHtml\(\) \+ nbaHotCardHtml\(\)/g) || []).length === 2, 'on the tab, under the PrizePicks cards, with games or without');
ok(/case 'nba-hot-all': \{\n\s+state\.nbaHotAll = !state\.nbaHotAll;\n\s+renderNba\(\);/.test(app), 'the tap redraws the tab');
const css = fs.readFileSync(BOARD + '/style.css', 'utf8');
ok(/\.hot-mk \{/.test(css) && /\.hot-read\.up b \{/.test(css) && /\.hot-goes b \{/.test(css), 'styled');
ok(/\.hot-mk \.hot-read\.up b \{ color:var\(--positive\)/.test(css), 'a chance past the tick stays green: first in its block, the white rule for a first line would take it');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
