// The Hot players' stats added on 2026-11-18 (the owner: "add the hot stats on all four"). What
// has to hold here, for the NBA and the NHL (the NFL's are in tests/hotnfl.mjs, soccer's in
// tests/hotsoccer.mjs):
//   - the NBA list runs on every stat the box score has: assists, steals, blocks, blocks+steals,
//     shot attempts and makes, threes attempted, free throws made, turnovers, offensive and
//     defensive rebounds, fouls; by the same rules as the seven the replay tested
//   - the new ones claim nothing: no "run goes on", no side, and the card says why
//   - the seven keep what they had, and the paid hot-run log still reads its seven alone
//   - the NHL list runs on blocked shots and hits, and goalie saves on a goalie's starts, by
//     his full name
//   - no call to the odds feed
//
// Real data: every real NBA box row of the 222 games to Nov 18 and ESPN's real Nov 19 slate;
// every real NHL skater and goalie line of the 338 games to Nov 18, the real Nov 19 slate and
// the NHL's real season tables. Every run and rank is worked out here the long way from those
// rows and held against the real worker on real SQLite.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = path.join(BOARD, 'tests', 'fixtures');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const read = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const NBA = read('nba-box-league-to-20261118.json'), NBA_SB = read('espn-nba-sb-20261119.json');
const NHL = read('nhl-box-league-to-20261118.json');
const SK_PRIOR = read('nhl-skaters-20252026.json'), SK_CUR = read('nhl-skaters-20262027.json');
const G_PRIOR = read('nhl-goalies-all-20252026-20261118.json'), G_CUR = read('nhl-goalies-all-20262027-20261118.json');
const PRIORS_TEXT = fs.readFileSync(path.join(BOARD, 'nba-priors.json'), 'utf8'), PRIORS = JSON.parse(PRIORS_TEXT).players;
const NBA_COLS = ['pts', 'reb', 'ast', 'threes', 'fg3a', 'fgm', 'fga', 'ftm', 'fta', 'oreb', 'dreb', 'stl', 'blk', 'tov', 'pf'];
const byDate = (a, b) => a.date.localeCompare(b.date) || a.game_id.localeCompare(b.game_id);
const NBA_ROWS = NBA.rows.map((r) => ({ game_id: NBA.games[r[0]][0], date: NBA.games[r[0]][1], player_id: NBA.players[r[1]][0], player: NBA.players[r[1]][1], team: r[2], min: r[3],
  ...Object.fromEntries(NBA_COLS.map((k, i) => [k, r[4 + i]])) })).sort(byDate);
const SKATERS = NHL.skaters.map((r) => ({ game_id: NHL.games[r[0]][0], date: NHL.games[r[0]][1], player_id: NHL.players[r[1]][0], player: NHL.players[r[1]][1], team: r[2], opp: r[3], min: r[4], goals: r[5], ast: r[6], pts: r[7], sog: r[8], blocks: r[9], hits: r[10] }));
const GOALIES = NHL.goalies.map((r) => ({ game_id: NHL.games[r[0]][0], date: NHL.games[r[0]][1], player_id: NHL.players[r[1]][0], player: NHL.players[r[1]][1], team: r[2], opp: r[3], min: r[4], saves: r[5], shots: r[6] }));

const RealDate = Date;
const START = Date.parse('2026-11-19T20:00:00Z');           // noon Pacific, the day after the last games read
let NOW = START;
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
const feedOf = (teams) => ({ gamepackageJSON: { injuries: Object.entries(teams).map(([displayName, injuries]) => ({ team: { displayName }, injuries })) } });

let S = null;
function scene() {
  const sq = new DatabaseSync(':memory:');
  // The NHL props card's one read-again of the season has been and gone (tests/propsnhl.mjs).
  sq.exec('CREATE TABLE feed_cache (key TEXT PRIMARY KEY, data TEXT, updated_at INTEGER, claimed_until INTEGER)');
  sq.prepare("INSERT INTO feed_cache (key, data, updated_at) VALUES ('nhl_box_reread', '{\"done\":true}', 0)").run();
  const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
  const sqls = [];
  const exec = (sql, args, mode) => { sqls.push(sql); const st = sq.prepare(sql); const a = args.map(norm);
    if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
    if (/^\s*(SELECT|WITH)/i.test(sql)) return { results: st.all(...a), meta: {} };
    return { success: true, meta: { changes: Number(st.run(...a).changes) } }; };
  const DB = { prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
    all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
    run: async () => exec(s.sql, s.args, 'run') }; return s; }, batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')) };
  const ASSETS = { fetch: async (r) => (new URL(r.url).pathname === '/nba-priors.json' ? new Response(PRIORS_TEXT, { status: 200 }) : new Response('nope', { status: 404 })) };
  return { sq, sqls, env: { DB, ASSETS }, oddsCalls: 0, boxCalls: 0 };
}
globalThis.fetch = async (u) => {
  const url = String(u);
  if (/the-odds-api\.com/.test(url)) { S.oddsCalls++; return new Response('{}', { status: 404 }); }
  const sb = url.match(/cdn\.espn\.com\/core\/nba\/scoreboard\?xhr=1&date=(\d+)/);
  if (sb) return J(sb[1] === '20261119' ? NBA_SB : { content: { sbData: { events: [] } } });
  if (/\/nba\/game\?xhr=1&gameId=\d+/.test(url)) return J(feedOf({}));
  const sc = url.match(/api-web\.nhle\.com\/v1\/score\/(\d{4}-\d{2}-\d{2})/);
  if (sc) return J(NHL.slate[sc[1]] || { games: [] });
  if (/gamecenter\/\d+\/boxscore|cdn\.espn\.com\/core\/nba\/(boxscore|game\?xhr=1&gameId)/.test(url)) { S.boxCalls++; return new Response('{}', { status: 404 }); }
  if (/api\.nhle\.com\/stats\/rest\/en\/skater\/summary/.test(url)) return J(/seasonId=20252026/.test(url) ? SK_PRIOR : SK_CUR);
  if (/api\.nhle\.com\/stats\/rest\/en\/goalie\/summary/.test(url)) return J(/seasonId=20252026/.test(url) ? G_PRIOR : G_CUR);
  return new Response('{}', { status: 404 });
};
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
let mod = null, scenes = 0;
const loadWorker = async () => { mod = await import('data:text/javascript;base64,' + Buffer.from(`${src}\n// scene ${++scenes}`).toString('base64')); };
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), S.env, { waitUntil: () => {} })).json();
const cron = async (c) => { const held = []; await mod.default.scheduled({ cron: c, scheduledTime: NOW }, S.env, { waitUntil: (p) => held.push(p) }); await Promise.all(held); };

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const mean = (xs) => xs.reduce((a, x) => a + x, 0) / xs.length;
const round1 = (v) => Math.round(v * 10) / 10;
const ptDate = (t) => new RealDate(t - 8 * 3600e3).toISOString().slice(0, 10);
// Where a team sits for a stat, 1 the most allowed: any place among the tied is right.
function placeOf(avgs, team) {
  const list = [...avgs].sort((a, b) => b[1] - a[1]), i = list.findIndex(([k]) => k === team);
  if (i < 0) return null;
  const same = list.map(([, v], j) => (v === list[i][1] ? j + 1 : 0)).filter(Boolean);
  return { lo: same[0], hi: same[same.length - 1], of: list.length };
}
const flat = (hot) => hot.players.flatMap((p) => p.markets.map((m) => ({ ...m, id: p.id, name: p.name, team: p.team, player: p })));
const key = (x) => `${x.id}|${x.mk || x.market}|${x.run}`;
const sameRuns = (got, want) => JSON.stringify(got.map(key).sort()) === JSON.stringify(want.map(key).sort())
  && got.every((x) => { const w = want.find((y) => key(y) === key(x)); return w && x.of === w.of && x.pos >= w.lo && x.pos <= w.hi; });

// ---- The NBA, the long way -----------------------------------------------------------------
const TESTED = ['pts', 'pra', 'pts_reb', 'pts_ast', 'reb_ast', 'reb', 'threes'];
const PARTS = { pra: ['pts', 'reb', 'ast'], pts_reb: ['pts', 'reb'], pts_ast: ['pts', 'ast'], reb_ast: ['reb', 'ast'], blk_stl: ['blk', 'stl'] };
const ADDED = ['ast', 'stl', 'blk', 'blk_stl', 'fga', 'fgm', 'fg3a', 'ftm', 'tov', 'oreb', 'dreb', 'pf'];
const partsOf = (mk) => PARTS[mk] || [mk];
const nbaStat = (r, mk) => partsOf(mk).reduce((a, k) => a + r[k], 0);
const played = NBA_ROWS.filter((r) => r.min > 0);
const nbaGames = (id) => played.filter((r) => r.player_id === id);
function nbaAllowed(day) {
  const games = new Map();
  for (const r of played) { if (r.date >= day) continue; if (!games.has(r.game_id)) games.set(r.game_id, new Map()); const g = games.get(r.game_id); g.set(r.team, [...(g.get(r.team) || []), r]); }
  const t = new Map();
  for (const g of games.values()) { const [a, b] = [...g.keys()]; if (b == null) continue;
    for (const [me, them] of [[a, b], [b, a]]) t.set(me, [...(t.get(me) || []), g.get(them)]); }
  return t;
}
function nbaExpected(slate, day) {
  const t = nbaAllowed(day), at = (n) => [...t.values()].filter((l) => l.length >= n).length, min = at(10) >= 20 ? 10 : 5;
  const ranked = (mk) => { const avgs = [...t].filter(([, l]) => l.length >= min).map(([k, l]) => [k, mean(l.map((rows) => rows.reduce((a, r) => a + nbaStat(r, mk), 0)))]); return avgs.length >= 20 ? avgs : []; };
  const out = [];
  for (const [team, opp] of slate.flatMap(([a, b]) => [[a, b], [b, a]])) {
    for (const id of new Set(played.filter((r) => r.team === team).map((r) => r.player_id))) {
      const gs = nbaGames(id);
      if (gs[gs.length - 1].team !== team || gs.length < 5 || mean(gs.slice(-5).map((r) => r.min)) < 20) continue;
      const pr = PRIORS[id];
      if (gs.length < 10 && !(pr && pr.gp >= 20)) continue;
      for (const mk of [...TESTED, ...ADDED]) {
        const v = gs.map((r) => nbaStat(r, mk));
        let run = 0;
        if (gs.length >= 10) { for (let j = v.length - 1; j >= 5 && v[j] > mean(v.slice(0, j)); j--) run++; }
        else {
          if (partsOf(mk).some((k) => pr[k] == null)) continue;
          const base = round1(partsOf(mk).reduce((a, k) => a + pr[k], 0));
          for (let j = v.length - 1; j >= 0 && v[j] > base; j--) run++;
        }
        const p = placeOf(ranked(mk), opp);
        if (run >= 5 && p) out.push({ id, name: gs[gs.length - 1].player, mk, run, games: gs.length, ...p });
      }
    }
  }
  return out;
}

console.log('-- the NBA: every stat on the box score --');
S = scene();
await loadWorker();
await get('/api/nba-pp');
{ const cols = ['game_id', 'date', 'season_type', 'player_id', 'player', 'team', 'min', 'dnp', ...NBA_COLS];
  const ins = S.sq.prepare(`INSERT INTO nba_box (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  for (const r of NBA_ROWS) ins.run(...cols.map((c) => (c === 'season_type' ? 2 : c === 'dnp' ? 0 : r[c]))); }
await cron('*/5 * * * *');
NOW += 5 * 60e3;
await cron('*/5 * * * *');
const nbaHot = (await get('/api/nba-pp')).hot;
const slate = NBA_SB.content.sbData.events.map((e) => { const c = e.competitions[0].competitors; return [c.find((x) => x.homeAway === 'home').team.abbreviation, c.find((x) => x.homeAway === 'away').team.abbreviation]; });
const nbaWant = nbaExpected(slate, '2026-11-19'), nbaGot = flat(nbaHot);
const count = (xs, set) => Object.fromEntries(set.map((mk) => [mk, xs.filter((x) => (x.mk || x.market) === mk).length]).filter(([, n]) => n));
console.log(`  ${slate.map((g) => g.join('-')).join(', ')}: ${nbaGot.length} runs, ${nbaHot.players.length} players | added: ${JSON.stringify(count(nbaGot, ADDED))} | tested: ${JSON.stringify(count(nbaGot, TESTED))}`);
ok(nbaHot.ready === true && nbaHot.early === false, 'all teams on 10 games: the full ranks');
ok(sameRuns(nbaGot, nbaWant), `every run on the four games, on every stat, the long way: ${nbaWant.length}`);
const nbaNew = nbaGot.filter((x) => ADDED.includes(x.market));
ok(Object.keys(count(nbaNew, ADDED)).length >= 5, `runs on the stats added Nov 18, on ${Object.keys(count(nbaNew, ADDED)).length} of them`);
ok(nbaNew.every((x) => x.tested === false && x.goesOn === null && x.read === null), 'and none claims a run going on or a side');
const nbaOld = nbaGot.filter((x) => TESTED.includes(x.market));
ok(nbaOld.length >= 1 && nbaOld.every((x) => x.tested === true && x.goesOn && typeof x.goesOn.pct === 'number' && x.read && typeof x.read.rate === 'number'), `the ${nbaOld.length} on the seven tested keep both`);
ok(nbaHot.players.every((p) => p.markets.some((m) => TESTED.includes(m.market)) || p.markets.every((m) => m.tested === false)), 'a player on new stats alone is listed, with nothing claimed');
ok(S.oddsCalls === 0, 'not one call to the odds feed');
// The paid hot-run log (mid-January) reads its seven and the box query it always had.
ok(/const boxRows = await nbaSeasonBoxRows\(env\.DB\);\n  const box = nbaCauseState\(boxRows\), allowed = nbaHotAllowed\(boxRows\);/.test(src)
  && /const hot = \[\.\.\.nbaHotCandidates\(box, rankOf, g\.homeAb, g\.awayAb, g\.inj\), \.\.\.nbaHotCandidates\(box, rankOf, g\.awayAb, g\.homeAb, g\.inj\)\];/.test(src)
  && /function nbaHotCandidates\(st, rankOf, team, opp, inj, stats = Object\.values\(NBA_CAUSE_MARKETS\)\)/.test(src), 'the hot-run log still reads its four box columns and its seven stats');
ok(S.sqls.some((q) => /SELECT game_id, date, player_id, player, team, min, pts, reb, ast, threes, fg3a, fgm, fga, ftm, fta, oreb, dreb, stl, blk, tov, pf FROM nba_box/.test(q)), 'the list reads every box column');

// ---- The NHL, the long way -----------------------------------------------------------------
const NHL_MK = ['pts', 'ast', 'goals', 'sog', 'blocks', 'hits', 'saves'];
const IN_NET = GOALIES.filter((r) => r.min >= 30);
const NHL_ROWS = [...SKATERS, ...IN_NET].sort(byDate);
const skPrior = new Map(SK_PRIOR.data.map((x) => [String(x.playerId), x]));
const gPrior = new Map(G_PRIOR.data.map((x) => [String(x.playerId), x])), gCur = new Map(G_CUR.data.map((x) => [String(x.playerId), x]));
const PRIOR_FIELD = { pts: 'points', ast: 'assists', goals: 'goals', sog: 'shots' };
const nhlStat = (r, mk) => (r[mk] == null ? null : r[mk]);
function nhlPrior(id, mk) {
  if (mk === 'saves') { const g = gPrior.get(id); return g && g.gamesPlayed >= 10 && g.saves != null ? g.saves / g.gamesPlayed : null; }
  const x = skPrior.get(id); return x && x.gamesPlayed >= 20 && PRIOR_FIELD[mk] && x[PRIOR_FIELD[mk]] != null ? x[PRIOR_FIELD[mk]] / x.gamesPlayed : null;
}
function nhlExpected(games) {
  const out = [], seen = new Set(), today = ptDate(START);
  // What each team let the other side do, a game at a time.
  const t = new Map();
  for (const r of NHL_ROWS) { if (!t.has(r.opp)) t.set(r.opp, new Map()); const g = t.get(r.opp); if (!g.has(r.game_id)) g.set(r.game_id, { date: r.date });
    for (const mk of NHL_MK) { const v = nhlStat(r, mk); if (v != null) g.get(r.game_id)[mk] = (g.get(r.game_id)[mk] || 0) + v; } }
  const at = (n) => [...t.values()].filter((g) => [...g.values()].filter((e) => e.date < today).length >= n).length;
  const min = at(10) >= 22 ? 10 : 5;
  const ranked = (mk, day) => { const avgs = [...t].map(([k, g]) => [k, [...g.values()].filter((e) => e.date < day && e[mk] != null)]).filter(([, es]) => es.length >= min).map(([k, es]) => [k, mean(es.map((e) => e[mk]))]); return avgs.length >= 22 ? avgs : []; };
  const ids = [...new Set(NHL_ROWS.map((r) => r.player_id))];
  for (const g of games) {
    const day = ptDate(Date.parse(g.startTimeUTC));
    for (const [team, opp] of [[g.homeTeam.abbrev, g.awayTeam.abbrev], [g.awayTeam.abbrev, g.homeTeam.abbrev]]) {
      const dates = new Set(NHL_ROWS.filter((r) => r.team === team).map((r) => r.date));
      for (const id of ids) {
        const gs = NHL_ROWS.filter((r) => r.player_id === id);
        if (gs[gs.length - 1].team !== team || seen.has(id) || gs.length < 5 || [...dates].some((d) => d > gs[gs.length - 1].date)) continue;
        let any = false;
        for (const mk of NHL_MK) {
          const v = gs.map((r) => nhlStat(r, mk)).filter((x) => x != null);
          if (v.length < 5 || mean(gs.slice(-5).map((r) => r.min)) < 15) continue;
          const p = placeOf(ranked(mk, day), opp);
          if (!p) continue;
          const base = v.length < 10 ? nhlPrior(id, mk) : null;
          if (v.length < 10 && base == null) continue;
          let run = 0;
          if (base != null) { for (let j = v.length - 1; j >= 0 && v[j] > base; j--) run++; }
          else { for (let j = v.length - 1; j >= 5 && v[j] > mean(v.slice(0, j)); j--) run++; }
          if (run >= 5) { out.push({ id, mk, run, ...p }); any = true; }
        }
        if (any) seen.add(id);
      }
    }
  }
  return out;
}

console.log('\n-- the NHL: blocked shots, hits and goalie saves --');
S = scene();
NOW = START;
await loadWorker();
await cron('1-59/2 * * * *');
{ const ins = S.sq.prepare('INSERT INTO nhl_box (game_id, date, player_id, player, team, opp, min, goals, ast, pts, sog, blocks, hits) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const r of SKATERS) ins.run(r.game_id, r.date, r.player_id, r.player, r.team, r.opp, r.min, r.goals, r.ast, r.pts, r.sog, r.blocks, r.hits);
  const gin = S.sq.prepare('INSERT INTO nhl_goalie_box (game_id, date, player_id, player, team, opp, min, saves, shots) VALUES (?,?,?,?,?,?,?,?,?)');
  for (const r of GOALIES) gin.run(r.game_id, r.date, r.player_id, r.player, r.team, r.opp, r.min, r.saves, r.shots); }
// Up to date, so the ingest has nothing to do: the list is all that is under test.
S.sq.prepare("DELETE FROM feed_cache WHERE key = 'hot_list_v2:nhl'").run(); S.sq.prepare('DELETE FROM nhl_box_games').run();
S.sq.prepare("INSERT OR REPLACE INTO feed_cache (key, data, updated_at) SELECT 'nhl_box_scan', ?, ? ").run(JSON.stringify({ from: '2026-11-18', checked: NOW }), NOW);
S.boxCalls = 0;
await cron('1-59/2 * * * *');
const nhlHot = (await get('/api/hot-players?sport=nhl')).hot;
const nhlGames = Object.values(NHL.slate).flatMap((d) => d.games || []).filter((g) => g.gameType === 2 && /FUT|PRE/.test(g.gameState) && Date.parse(g.startTimeUTC) > START).sort((a, b) => Date.parse(a.startTimeUTC) - Date.parse(b.startTimeUTC));
const nhlWant = nhlExpected(nhlGames), nhlGot = flat(nhlHot);
console.log(`  ${nhlGames.length} games: ${nhlGot.length} runs, ${nhlHot.players.length} players | ${JSON.stringify(count(nhlGot, NHL_MK))}`);
ok(nhlHot.ready === true, 'teams ranked');
ok(sameRuns(nhlGot, nhlWant), `every run on the ${nhlGames.length} games, the long way: ${nhlWant.length}`);
const nhlNew = count(nhlGot, ['blocks', 'hits', 'saves']);
ok(nhlNew.blocks >= 1 && nhlNew.hits >= 1 && nhlNew.saves >= 1, `on the stats added Nov 18: ${JSON.stringify(nhlNew)}`);
const goalieIds = new Set(IN_NET.map((r) => r.player_id));
const saveRuns = nhlGot.filter((x) => x.market === 'saves');
ok(saveRuns.every((x) => goalieIds.has(x.id)) && nhlGot.filter((x) => x.market !== 'saves').every((x) => !goalieIds.has(x.id)), 'saves on goalies alone, the skaters\' stats on skaters alone');
const fullName = (id) => (gCur.get(id) || gPrior.get(id) || {}).goalieFullName;
console.log(`  goalies: ${saveRuns.map((x) => `${x.name} (${IN_NET.filter((r) => r.player_id === x.id).length} starts, ${x.run} in a row)`).join(', ')}`);
ok(saveRuns.every((x) => x.name === fullName(x.id) && !/^\w\. /.test(x.name)), 'each goalie by his full name from the NHL\'s goalie table, not the box score\'s "J. Swayman"');
ok(nhlGot.every((x) => x.market !== 'saves' || x.lastSeason != null || x.seen >= 10), 'a goalie\'s starts are his games: under 10 of them, held to last season');
ok(S.oddsCalls === 0 && S.boxCalls === 0, 'not one call to the odds feed, and no box score read for it');

// ---- The page ------------------------------------------------------------------------------
console.log('\n-- the page --');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const sect = app.slice(app.indexOf('  // ---- Hot players'), app.indexOf('  function renderNba('));
const state = { nbaPp: { hot: nbaHot }, nbaHotAll: true, hot: { nhl: nhlHot }, hotAll: { nhl: true } };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const nbaNick = (name) => String(name || '').trim().split(/\s+/).pop();
const sharpTag = (p) => (typeof p === 'number' ? `<span class="tc-sharp">sharp ${Math.round(p)}%</span>` : '');
const miniBar = new Function(`${app.match(/  function miniBar\(fill, tick, axisPct\) \{[\s\S]*?\n  \}\n/)[0]} return miniBar;`)();
const OUT_FNS = new Function(app.match(/const injOut = .*\n/)[0] + app.match(/const outLast = .*\n/)[0] + 'return [injOut, outLast];')();
const [nbaCard, card] = new Function('state', 'esc', 'nbaNick', 'sharpTag', 'miniBar', 'avatarHtml', 'soccerKick', 'nbaCardInjTag', 'injOut', 'outLast', `${sect}\nreturn [nbaHotCardHtml, hotCardHtml];`)(
  state, esc, nbaNick, sharpTag, miniBar, (o) => `<span class="hs" data-id="${o.playerId}"></span>`, () => '5:00 PM', () => '', ...OUT_FNS);
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const nbaHtml = text(nbaCard());
const MK = { ast: 'Assists', stl: 'Steals', blk: 'Blocked shots', blk_stl: 'Blks+Stls', fga: 'FG attempted', fgm: 'FG made', fg3a: '3-PT attempted', ftm: 'Free throws made', tov: 'Turnovers', oreb: 'Offensive rebounds', dreb: 'Defensive rebounds', pf: 'Personal fouls' };
const ALLOW = { blk_stl: 'blocks and steals', fga: 'field-goal attempts', fgm: 'made field goals', fg3a: 'three-point attempts', ftm: 'made free throws' };
const W = String.raw`(?:\d+(?:st|nd|rd|th) )?(?:most|fewest)`;
ok(/weren't in last season's replay: no side and no “run goes on” on them/.test(nbaHtml), 'the NBA card says the new stats were not in the replay');
const nbaRowOk = (x) => new RegExp(`${MK[x.market]} · ${x.run} in a row[^·]*· [\\d.]+ last five, [\\d.]+ (season|last season) ${nbaNick(x.player.oppName)} allow the ${W} ${ALLOW[x.market] || MK[x.market].toLowerCase()} (soft|middle|tough) team`).test(nbaHtml);
console.log(`  ${nbaNew.slice(0, 3).map((x) => { const i = nbaHtml.indexOf(`${MK[x.market]} · ${x.run} in a row`); return nbaHtml.slice(i, i + 150); }).join(' | ')}`);
ok(nbaNew.every(nbaRowOk), `each of the ${nbaNew.length} new runs in words: "FG attempted", "allow the most field-goal attempts"`);
ok((nbaHtml.match(/not tested, so no side/gi) || []).length === nbaNew.length, 'each says not tested, so no side');
ok((nbaHtml.match(/Run goes on: about/g) || []).length === nbaGot.filter((x) => x.goesOn).length, 'and "run goes on" on the tested seven alone');
const nhlHtml = text(card('nhl'));
ok(/Blocked shots, hits and goalie saves weren't in that replay/.test(nhlHtml), 'the NHL card says the new stats were not in the replay');
const NHL_LABEL = { blocks: 'Blocked shots', hits: 'Hits', saves: 'Goalie saves' };
const nhlRowOk = (x) => new RegExp(`${NHL_LABEL[x.market]} · ${x.run} in a row[^·]*· [\\d.]+ last five, [\\d.]+ (season|last season) ${x.player.oppNick} ${x.market === 'saves' ? `give goalies the ${W} saves` : `allow the ${W} ${NHL_LABEL[x.market].toLowerCase()}`} (soft|middle|tough) team`).test(nhlHtml);
const nhlAdded = nhlGot.filter((x) => NHL_LABEL[x.market]);
console.log(`  ${['blocks', 'hits', 'saves'].map((mk) => { const x = nhlAdded.find((y) => y.market === mk); const i = x ? nhlHtml.indexOf(`${NHL_LABEL[mk]} · ${x.run} in a row`) : -1; return i < 0 ? `${mk}: none` : nhlHtml.slice(i, i + 140); }).join(' | ')}`);
ok(nhlAdded.length >= 3 && nhlAdded.every(nhlRowOk), `each of the ${nhlAdded.length} in words: "give goalies the most saves"`);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
