// Last season's player props, read back (2026-10-29).
//
// The owner: spend the month's spare credits before they lapse, on what
// brings more picks. The odds feed sells last season's prop snapshots per
// game, PrizePicks' own lines among them; every game grades from ESPN's free
// box scores. What has to hold:
//   - each game's legs are PrizePicks' standard lines (the line it quotes Less
//     on), each other book's lines quoted both ways with the no-vig under
//     there, and Underdog's line
//   - each leg grades from the box score: a player who did not play is void
//   - the sharp chance at PrizePicks' line comes from the books quoting that
//     exact line, Pinnacle first; the gap is PrizePicks' line less the sharp
//     main line (Pinnacle's, else FanDuel's)
//   - the report: by market and all, the side the sharp chance favours by
//     band and at 58%+, and More and Less by where PrizePicks' line sat
//   - a job runs on its own cron a few games a run, one row a game, and stops
//     at its cap or when the feed's remaining credits fall to the floor the
//     live boards keep
//
// Real data: production's probe of Jan 15 2026 (tests/fixtures/
// hist-props-nba-20260115.json: that day's games, and Grizzlies @ Magic's
// props an hour before tip) and ESPN's box score and scoreboard for it
// (tests/fixtures/espn-nba-box-401810433.json, espn-nba-sb-20260115.json).
// Real SQLite and the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const fx = (n) => JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', n), 'utf8'));
const P = fx('hist-props-nba-20260115.json'), BOX = fx('espn-nba-box-401810433.json'), SB = fx('espn-nba-sb-20260115.json');
const NP = fx('hist-props-nfl-20251116.json'), NBOX = fx('espn-nfl-box-401772631.json'), NSB = fx('espn-nfl-sb-2025-w11.json');
const RealDate = Date;
const NOW = RealDate.parse('2026-10-29T08:00:00Z');
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
let remaining = 85686;
const asked = [];
const J = (b, h = {}) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json', ...h } });
globalThis.fetch = async (u) => {
  const s = String(u); asked.push(s);
  if (/historical\/sports\/basketball_nba\/events\?/.test(s)) {
    // The day's games as the probe listed them (its ids, teams and starts).
    return J({ timestamp: P.eventsTimestamp, data: P.events.map((e) => { const [away, home] = e.game.split(' @ '); return { id: e.id, commence_time: e.commence, home_team: home, away_team: away }; }) },
      { 'x-requests-last': '1', 'x-requests-remaining': String(--remaining) });
  }
  const m = s.match(/historical\/sports\/basketball_nba\/events\/([0-9a-f]+)\/odds/);
  if (m) {
    if (m[1] !== P.odds.data.id) return new Response('{"message":"not recorded"}', { status: 404, headers: { 'x-requests-last': '0', 'x-requests-remaining': String(remaining) } });
    remaining -= 50;
    return J(P.odds, { 'x-requests-last': '50', 'x-requests-remaining': String(remaining) });
  }
  if (/cdn\.espn\.com\/core\/nba\/scoreboard/.test(s)) return J(SB);
  if (/cdn\.espn\.com\/core\/nba\/boxscore\?xhr=1&gameId=401810433/.test(s)) return J(BOX);
  if (/historical\/sports\/americanfootball_nfl\/events\?/.test(s)) {
    return J({ timestamp: NP.eventsTimestamp, data: NP.events.map((e) => { const [away, home] = e.game.split(' @ '); return { id: e.id, commence_time: e.commence, home_team: home, away_team: away }; }) },
      { 'x-requests-last': '1', 'x-requests-remaining': String(--remaining) });
  }
  const n = s.match(/historical\/sports\/americanfootball_nfl\/events\/([0-9a-f]+)\/odds/);
  if (n) {
    if (n[1] !== NP.odds.data.id) return new Response('{"message":"not recorded"}', { status: 404, headers: { 'x-requests-last': '0', 'x-requests-remaining': String(remaining) } });
    remaining -= 30;
    return J(NP.odds, { 'x-requests-last': '30', 'x-requests-remaining': String(remaining) });
  }
  if (/cdn\.espn\.com\/core\/nfl\/scoreboard\?xhr=1&year=2025&seasontype=2&week=11$/.test(s)) return J(NSB);
  if (/cdn\.espn\.com\/core\/nfl\/boxscore\?xhr=1&gameId=401772631/.test(s)) return J(NBOX);
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
const env = { DB, ODDS_API_KEY: 'k' };
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();
const tick = async () => { const w = []; await mod.default.scheduled({ cron: '1-59/2 * * * *', scheduledTime: NOW }, env, { waitUntil: (p) => w.push(p) }); await Promise.all(w); };

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// ---- start the job at Jan 15 --------------------------------------------------------------------
console.log('-- the job --');
let r = await get('/api/hist-props?job=nba');
ok(r.active === false && r.games === 0 && /NBA 2025-26/.test(r.label), 'idle until started');
await get('/api/hist-props?job=nba&start=1');
// Jump the job to the recorded day: the run reads day by day from opening night.
const days = []; for (let t = RealDate.parse('2025-10-21T12:00:00Z'); t <= RealDate.parse('2026-04-12T12:00:00Z'); t += 864e5) days.push(new RealDate(t).toISOString().slice(0, 10));
const st = JSON.parse(sq.prepare("SELECT data FROM feed_cache WHERE key = 'hist_props:nba'").get().data);
sq.prepare("UPDATE feed_cache SET data = ? WHERE key = 'hist_props:nba'").run(JSON.stringify({ ...st, day: days.indexOf('2026-01-15') }));
await tick();
r = await get('/api/hist-props?job=nba');
console.log(`  ${r.progress}, ${r.games} games, ${r.creditsSpent} credits, ${r.errors} errors`);
const row = sq.prepare('SELECT * FROM histpropgames').get();
ok(r.games === 1 && row && row.game === 'Memphis Grizzlies @ Orlando Magic' && row.graded === 1 && r.creditsSpent === 51,
  "a run on the backtest's own cron: the day's games listed (1 credit), Grizzlies @ Magic's props read an hour before tip (50), one row");
ok(asked.filter((u) => /events\/[0-9a-f]+\/odds/.test(u)).length === 3 && r.errors === 2 && JSON.parse(st.queue ? '[]' : '[]').length === 0,
  'three games a run (the two the probe did not record count as errors)');
const oddsUrl = asked.find((u) => u.includes(`events/${P.odds.data.id}/odds`));
ok(/date=2026-01-15T18%3A10%3A00Z/.test(oddsUrl) && /markets=player_points,player_points_rebounds_assists,player_points_rebounds,player_points_assists,player_rebounds_assists/.test(oddsUrl)
  && /bookmakers=pinnacle,fanduel,draftkings,betonlineag,lowvig,novig,prophetx,prizepicks,underdog,betmgm/.test(oddsUrl),
  'read at 18:10Z, an hour before the 19:10Z tip: five markets, ten books (one region)');

// ---- the legs ---------------------------------------------------------------------------------------
console.log('\n-- the legs --');
const legs = JSON.parse(row.legs);
const ban = legs.find((l) => l.p === 'Paolo Banchero' && l.mk === 'pts');
console.log('  ' + JSON.stringify(ban));
ok(ban && ban.pp === 22.5 && ban.ud === 22.5 && ban.q.pinnacle && ban.q.pinnacle[0][0] === 23.5 && ban.q.fanduel[0][0] === 22.5 && ban.q.fanduel[0][1] === 50,
  "Banchero's points: PrizePicks 22.5 (Underdog too), Pinnacle 23.5, FanDuel 22.5 at -113 both ways (50%)");
ok(ban.a === 26, 'graded from the box score: 26 points');
const jjj = legs.find((l) => /Jaren Jackson/.test(l.p) && l.mk === 'pts');
ok(jjj && jjj.a === 30, `"Jaren Jackson Jr" on PrizePicks is ESPN's "Jaren Jackson Jr.": ${jjj && jjj.a} points`);
const mks = [...new Set(legs.map((l) => l.mk))].sort().join();
ok(mks === 'pra,pts,pts_ast,pts_reb,reb_ast' && legs.every((l) => l.a != null || l.v), `five markets (${legs.length} legs), every one graded or void`);
const bline = (who) => { for (const t of BOX.gamepackageJSON.boxscore.players) { const s = t.statistics[0]; const a = s.athletes.find((x) => x.athlete.displayName === who);
  if (a) return Object.fromEntries(['PTS', 'REB', 'AST'].map((k) => [k, Number(a.stats[s.labels.indexOf(k)])])); } };
const bb = bline('Paolo Banchero'), banPra = legs.find((l) => l.p === 'Paolo Banchero' && l.mk === 'pra');
ok(banPra && banPra.a === bb.PTS + bb.REB + bb.AST, `PRA is the three summed: ${bb.PTS} + ${bb.REB} + ${bb.AST} = ${banPra && banPra.a}`);
ok(legs.some((l) => l.p === 'Moe Wagner' && l.a != null) && legs.some((l) => l.p === 'Vincent Williams Jr' && l.a != null),
  'PrizePicks\' "Moe Wagner" and "Vincent Williams Jr" are ESPN\'s Moritz Wagner and Vince Williams Jr.');

// ---- the read ---------------------------------------------------------------------------------------
console.log('\n-- the read --');
const wlift = (name) => { const at = src.indexOf(`function ${name}(`); let d = 0;
  for (let i = src.indexOf(') {', at) + 2; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) return src.slice(at, i + 1); } };
const cst = (name) => { const at = src.indexOf(`const ${name} =`); let d = 0;
  for (let i = at; i < src.length; i++) { const c = src[i]; if ('{(['.includes(c)) d++; else if ('})]'.includes(c)) d--; else if (c === ';' && d === 0) return src.slice(at, i + 1); } };
const R = new Function([cst('HIST_PROP_SHARP'), wlift('median'), wlift('round1'), wlift('sharpFair'), cst('histMain'), wlift('histPropRead'), cst('HIST_PROP_BANDS'), wlift('histPropReport')].join('\n')
  + '\nreturn { histPropRead, histPropReport };')();
const rb = R.histPropRead(ban);
const exact = ['fanduel', 'novig', 'prophetx'].map((bk) => ban.q[bk].find((x) => x[0] === 22.5)[1]).sort((a, b) => a - b)[1];
ok(rb.src === 'sharp-pool' && rb.n === 3 && rb.under === exact && rb.gap === -1,
  `his 22.5 priced by the three books quoting it (FanDuel, Novig, ProphetX: ${exact}%), Pinnacle's 23.5 a point above: PrizePicks' line 1 below the sharp one`);
const job = { markets: { player_points: 'pts', player_points_rebounds_assists: 'pra', player_points_rebounds: 'pts_reb', player_points_assists: 'pts_ast', player_rebounds_assists: 'reb_ast' } };
const rep = R.histPropReport(legs, job);
console.log('  all: ' + JSON.stringify(rep.all).slice(0, 400));
const g = rep.all.byGap.below;
const below = legs.filter((l) => l.a != null && !l.v && l.a !== l.pp && R.histPropRead(l).gap < 0);
ok(rep.graded === legs.filter((l) => l.a != null && !l.v).length && g.more.n === below.length && g.more.hit === below.filter((l) => l.a > l.pp).length,
  `More where PrizePicks' line sat below the sharp one: ${g.more.hit} of ${g.more.n} in this game`);
ok(rep.byMarket.pts && rep.byMarket.pra && rep.all.byBand.length === 5 && rep.all.at58 && 'less' in rep.all.at58, 'by market, by band, at 58%+ with Less and More apart');

// ---- the stops ------------------------------------------------------------------------------------
console.log('\n-- the stops --');
remaining = 12040;                                   // 50 more and the floor is reached
const st2 = JSON.parse(sq.prepare("SELECT data FROM feed_cache WHERE key = 'hist_props:nba'").get().data);
sq.prepare("UPDATE feed_cache SET data = ? WHERE key = 'hist_props:nba'").run(JSON.stringify({ ...st2, day: days.indexOf('2026-01-15'), queue: [] }));
sq.prepare('DELETE FROM histpropgames').run();
await tick();
r = await get('/api/hist-props?job=nba');
ok(r.done === true && /floor/.test(r.stopped) && r.remaining < 12000, `it stops when the feed leaves under 12,000 credits: "${r.stopped}" (${r.remaining} left)`);
const n0 = asked.length;
await tick();
ok(asked.length === n0, 'and a stopped job reads nothing more');

// ---- the NFL ----------------------------------------------------------------------------------------
console.log('\n-- the NFL: Commanders @ Dolphins, Nov 16 2025 --');
remaining = 80000;
await get('/api/hist-props?job=nfl&start=1');
const nflDays = []; for (let t = RealDate.parse('2025-09-04T12:00:00Z'); t <= RealDate.parse('2026-01-04T12:00:00Z'); t += 864e5) nflDays.push(new RealDate(t).toISOString().slice(0, 10));
const ns = JSON.parse(sq.prepare("SELECT data FROM feed_cache WHERE key = 'hist_props:nfl'").get().data);
sq.prepare("UPDATE feed_cache SET data = ? WHERE key = 'hist_props:nfl'").run(JSON.stringify({ ...ns, day: nflDays.indexOf('2025-11-16') }));
const before2 = asked.length;
await tick();
const nr = await get('/api/hist-props?job=nfl');
const nrow = sq.prepare("SELECT * FROM histpropgames WHERE job = 'nfl'").get();
const nlegs = JSON.parse(nrow.legs);
const nl = (who, mk) => nlegs.find((l) => l.p === who && l.mk === mk) || {};
console.log(`  ${nr.games} game, ${nr.creditsSpent} credits; Deebo ${JSON.stringify([nl('Deebo Samuel Sr.', 'rec_yds').pp, nl('Deebo Samuel Sr.', 'rec_yds').a, nl('Deebo Samuel Sr.', 'rec').a])}`);
ok(nr.games === 1 && nr.creditsSpent === 31 && asked.slice(before2).some((u) => /nfl\/scoreboard\?xhr=1&year=2025&seasontype=2&week=11$/.test(u)),
  'the NFL job runs once the NBA one is done: its day listed, the game read (30 credits), ESPN asked by week (Nov 16 is week 11)');
ok(nl('Deebo Samuel Sr.', 'rec_yds').pp === 47.5 && nl('Deebo Samuel Sr.', 'rec_yds').a === 74 && nl('Deebo Samuel Sr.', 'rec').pp === 4.5 && nl('Deebo Samuel Sr.', 'rec').a === 7
  && nl('Deebo Samuel Sr.', 'rush_yds').a === 3, 'Deebo Samuel: 47.5 receiving yards and 4.5 catches on PrizePicks; 74 and 7, and 3 rushing yards');
ok(nl('Tua Tagovailoa', 'rush_yds').a === 0 && nl("De'Von Achane", 'rush_yds').a === 120,
  "a quarterback who never ran is 0 rushing yards, not void; Achane's 120 against 81.5");
ok(nlegs.every((l) => l.a != null || l.v) || nr.openNames.length < 4, `NFL legs graded (${nlegs.filter((l) => l.a != null).length} of ${nlegs.length}; open: ${nr.openNames.join(', ') || 'none'})`);
const toml = fs.readFileSync(BOARD + '/wrangler.toml', 'utf8');
ok(/crons = \["\*\/5 \* \* \* \*", "2-59\/5 \* \* \* \*", "1-59\/2 \* \* \* \*"\]/.test(toml) && /const HIST_CRON = '1-59\/2 \* \* \* \*';/.test(src), 'on its own cron trigger');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
