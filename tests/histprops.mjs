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
// The NHL (2026-11-01): production's probe of the same day (hist-props-nhl-
// 20260115.json, Canadiens @ Sabres) and the NHL's own score feed and box
// score for it (nhl-score-20260115.json, nhl-box-2025020740.json).
// Real SQLite and the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const fx = (n) => JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', n), 'utf8'));
const P = fx('hist-props-nba-20260115.json'), BOX = fx('espn-nba-box-401810433.json'), SB = fx('espn-nba-sb-20260115.json');
const NP = fx('hist-props-nfl-20251116.json'), NBOX = fx('espn-nfl-box-401772631.json'), NSB = fx('espn-nfl-sb-2025-w11.json');
const HP = fx('hist-props-nhl-20260115.json'), HSC = fx('nhl-score-20260115.json'), HBOX = fx('nhl-box-2025020740.json');
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
  if (/historical\/sports\/icehockey_nhl\/events\?/.test(s)) {
    return J({ timestamp: HP.eventsTimestamp, data: HP.events.map((e) => { const [away, home] = e.game.split(' @ '); return { id: e.id, commence_time: e.commence, home_team: home, away_team: away }; }) },
      { 'x-requests-last': '1', 'x-requests-remaining': String(--remaining) });
  }
  const h = s.match(/historical\/sports\/icehockey_nhl\/events\/([0-9a-f]+)\/odds/);
  if (h) {
    if (h[1] !== HP.odds.data.id) return new Response('{"message":"not recorded"}', { status: 404, headers: { 'x-requests-last': '0', 'x-requests-remaining': String(remaining) } });
    // The probe asked for five markets; the feed answers with those asked.
    const want = new URL(s).searchParams.get('markets').split(',');
    const data = { ...HP.odds.data, bookmakers: HP.odds.data.bookmakers.map((b) => ({ ...b, markets: b.markets.filter((m) => want.includes(m.key)) })).filter((b) => b.markets.length) };
    const n = new Set(data.bookmakers.flatMap((b) => b.markets.map((m) => m.key))).size * 10;
    remaining -= n;
    return J({ ...HP.odds, data }, { 'x-requests-last': String(n), 'x-requests-remaining': String(remaining) });
  }
  if (s === 'https://api-web.nhle.com/v1/score/2026-01-15') return J(HSC);
  if (s === 'https://api-web.nhle.com/v1/gamecenter/2025020740/boxscore') return J(HBOX);
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
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u, { headers: { 'x-admin-key': 't' } }), { ...(env), ADMIN_KEY: 't' }, { waitUntil: () => {} })).json();
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
ok(r.games === 1 && row && row.game === 'Memphis Grizzlies @ Orlando Magic' && row.graded === 2 && r.creditsSpent === 51,
  "a run on the backtest's own cron: the day's games listed (1 credit), Grizzlies @ Magic's props read an hour before tip (50), one row");
ok(asked.filter((u) => /events\/[0-9a-f]+\/odds/.test(u)).length === 3 && r.errors === 2 && JSON.parse(st.queue ? '[]' : '[]').length === 0,
  'three games a run (the two the probe did not record count as errors)');
// Which ones, and why (2026-10-29): production's three failed reads said neither.
ok(Array.isArray(r.errorLog) && r.errorLog.length === 2 && r.errorLog.every((e) => /^2026-01-15 .+ @ .+: HTTP 404$/.test(e)), `each failed read is named: ${JSON.stringify(r.errorLog)}`);
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

// ---- the reserve (2026-10-29: the credits have to last the month) --------------------------------
console.log('\n-- the reserve --');
// The quota renews on the 1st (the 3rd for a day from 2026-10-30, the plan's
// renewal date; the meter showed the reset at 00:00 UTC Nov 1).
const RV = new Function([cst('HIST_LIVE_PER_DAY'), cst('ODDS_RESET_DAY'), wlift('nextOddsReset'), cst('oddsDaysLeft'), wlift('histReserve')].join('\n') + '\nreturn histReserve;')();
ok(RV(NOW) === 5000 && RV(RealDate.parse('2026-11-01T00:00:00Z')) === 32000 && RV(RealDate.parse('2026-11-03T00:00:00Z')) === 30000 && RV(RealDate.parse('2026-11-30T20:00:00Z')) === 3000,
  'the live site keeps 1,000 a day to the renewal on the 1st, and 2,000 more: 5,000 at 1 AM Pacific Oct 29, 32,000 on Nov 1, 30,000 on Nov 3, 3,000 on Nov 30');
remaining = 5040;                                    // one more game and the reserve is reached
const st2 = JSON.parse(sq.prepare("SELECT data FROM feed_cache WHERE key = 'hist_props:nba'").get().data);
sq.prepare("UPDATE feed_cache SET data = ? WHERE key = 'hist_props:nba'").run(JSON.stringify({ ...st2, day: days.indexOf('2026-01-15'), queue: [] }));
sq.prepare('DELETE FROM histpropgames').run();
await tick();
r = await get('/api/hist-props?job=nba');
ok(r.done === false && /^reserve: the live site keeps 5000 until the quota renews$/.test(r.paused) && r.remaining < 5000 && r.reserve === 5000,
  `it pauses when the feed leaves less than the reserve: "${r.paused}" (${r.remaining} left)`);
// The odds feed: the same trigger's Hot players reads are ESPN's and the NHL's, free.
const oddsAsked = () => asked.filter((u) => /the-odds-api\.com/.test(u)).length;
const n0 = oddsAsked();
await tick();
ok(oddsAsked() === n0, 'and while the remaining stays under it, reads nothing');
// The reset: the live boards' next read records the month's new remaining.
sq.prepare("INSERT OR REPLACE INTO odds_usage (day, remaining, low, calls, updated_at) VALUES ('2026-11-01', 100000, 100000, 1, '2026-11-01T07:05:00Z')").run();
remaining = 100000;
await tick();
r = await get('/api/hist-props?job=nba');
ok(asked.length > n0 && !r.paused && r.done === false, 'once the reset lifts the remaining past it, the job goes on by itself');
await get('/api/hist-props?job=nba&stop=1');

// ---- threes, assists and rebounds, every other day (2026-10-29) ---------------------------------
console.log('\n-- threes and rebounds --');
let r3 = await get('/api/hist-props?job=nba3&start=1');
ok(r3.progress === '0 of 87 days' && r3.cap === 14000, `every other day of the season: ${r3.progress}, a 14,000 cap`);
const s3a = JSON.parse(sq.prepare("SELECT data FROM feed_cache WHERE key = 'hist_props:nba3'").get().data);
const d3 = []; for (let t = RealDate.parse('2025-10-21T12:00:00Z'); t <= RealDate.parse('2026-04-12T12:00:00Z'); t += 2 * 864e5) d3.push(new RealDate(t).toISOString().slice(0, 10));
sq.prepare("UPDATE feed_cache SET data = ? WHERE key = 'hist_props:nba3'").run(JSON.stringify({ ...s3a, day: d3.indexOf('2026-01-15') }));
const b3 = asked.length;
await tick();
const u3 = asked.slice(b3).find((u) => /basketball_nba\/events\/[0-9a-f]+\/odds/.test(u));
ok(d3.includes('2026-01-15') && u3 && new URL(u3).searchParams.get('markets') === 'player_threes,player_rebounds',
  'its own markets: threes and rebounds -- not assists, one PrizePicks line a game');
await get('/api/hist-props?job=nba3&stop=1');

// ---- turnovers, blocks + steals, free throws (2026-11-01) ---------------------------------------
console.log('\n-- turnovers, blocks + steals, free throws --');
let r4 = await get('/api/hist-props?job=nba4&start=1');
ok(r4.progress === '0 of 87 days' && r4.cap === 19000, `every other day again: ${r4.progress}, a 19,000 cap`);
const s4a = JSON.parse(sq.prepare("SELECT data FROM feed_cache WHERE key = 'hist_props:nba4'").get().data);
sq.prepare("UPDATE feed_cache SET data = ? WHERE key = 'hist_props:nba4'").run(JSON.stringify({ ...s4a, day: d3.indexOf('2026-01-15') }));
const b4 = asked.length;
await tick();
const u4 = asked.slice(b4).find((u) => /basketball_nba\/events\/[0-9a-f]+\/odds/.test(u));
ok(u4 && new URL(u4).searchParams.get('markets') === 'player_turnovers,player_blocks_steals,player_frees_made',
  'its own markets: turnovers, blocks + steals, free throws made');
await get('/api/hist-props?job=nba4&stop=1');

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
  'the NFL job runs once the NBA ones are stopped: its day listed, the game read (30 credits), ESPN asked by week (Nov 16 is week 11)');
ok(nl('Deebo Samuel Sr.', 'rec_yds').pp === 47.5 && nl('Deebo Samuel Sr.', 'rec_yds').a === 74 && nl('Deebo Samuel Sr.', 'rec').pp === 4.5 && nl('Deebo Samuel Sr.', 'rec').a === 7
  && nl('Deebo Samuel Sr.', 'rush_yds').a === 3, 'Deebo Samuel: 47.5 receiving yards and 4.5 catches on PrizePicks; 74 and 7, and 3 rushing yards');
ok(nl('Tua Tagovailoa', 'rush_yds').a === 0 && nl("De'Von Achane", 'rush_yds').a === 120,
  "a quarterback who never ran is 0 rushing yards, not void; Achane's 120 against 81.5");
ok(nlegs.every((l) => l.a != null || l.v) && nl('Nick Westbrook-Ikhine', 'rec').v === 2 && nl('John Bates', 'rec_yds').v === 2
  && nr.openNames.some((n) => /^Nick Westbrook-Ikhine/.test(n)),
  `every NFL leg graded or void: one a box read in full does not name sat out (v 2), and is listed to check (${nr.openNames.join(', ')})`);

// ---- the NHL (2026-11-01) ---------------------------------------------------------------------------
console.log('\n-- the NHL: Canadiens @ Sabres, Jan 15 2026 --');
await get('/api/hist-props?job=nfl&stop=1');
const h0 = await get('/api/hist-props?job=nhl&start=1');
const nhlDays = []; for (let t = RealDate.parse('2025-10-07T12:00:00Z'); t <= RealDate.parse('2026-04-16T12:00:00Z'); t += 2 * 864e5) nhlDays.push(new RealDate(t).toISOString().slice(0, 10));
ok(h0.progress === `0 of ${nhlDays.length} days` && h0.cap === 23000 && nhlDays.includes('2026-01-15'), `every other day of last season: ${h0.progress}, a 23,000 cap`);
const hs = JSON.parse(sq.prepare("SELECT data FROM feed_cache WHERE key = 'hist_props:nhl'").get().data);
sq.prepare("UPDATE feed_cache SET data = ? WHERE key = 'hist_props:nhl'").run(JSON.stringify({ ...hs, day: nhlDays.indexOf('2026-01-15') }));
const bh = asked.length;
await tick();
const hu = asked.slice(bh).find((u) => /icehockey_nhl\/events\/[0-9a-f]+\/odds/.test(u));
const hr = await get('/api/hist-props?job=nhl');
const hlegs = JSON.parse(sq.prepare("SELECT legs FROM histpropgames WHERE job = 'nhl'").get().legs);
const hl = (who, mk) => hlegs.find((l) => l.p === who && l.mk === mk) || {};
console.log(`  ${hr.games} game, ${hr.creditsSpent} credits: ${hlegs.map((l) => `${l.p} ${l.mk} ${l.pp}: ${l.a != null ? l.a : 'void ' + l.v}`).join(' | ')}`);
ok(hu && new URL(hu).searchParams.get('markets') === 'player_points,player_assists,player_total_saves' && hr.creditsSpent === 31
  && asked.slice(bh).includes('https://api-web.nhle.com/v1/gamecenter/2025020740/boxscore'),
  "points, assists and saves (30 credits); graded from the NHL's own box score, found on its score feed");
// The box's counts, by the box's own names.
const boxOf = (abbr, mk) => { for (const sd of ['awayTeam', 'homeTeam']) { const t = HBOX.playerByGameStats[sd];
  for (const x of [...t.forwards, ...t.defense, ...t.goalies]) if (x.name.default === abbr) return mk === 'saves' ? x.saves : mk === 'pts' ? x.points : x.assists; } return null; };
ok(hl('Colten Ellis', 'saves').pp === 23.5 && hl('Colten Ellis', 'saves').a === boxOf('C. Ellis', 'saves') && hl('Jacob Fowler', 'saves').a === boxOf('J. Fowler', 'saves'),
  `the goalies, by initial and surname: Ellis ${hl('Colten Ellis', 'saves').a} saves against 23.5, Fowler ${hl('Jacob Fowler', 'saves').a}`);
ok(hl('Lane Hutson', 'ast').a === 2 && hl('Nick Suzuki', 'ast').a === 1 && hl('Ivan Demidov', 'pts').a === 1 && hl('Ryan McLeod', 'pts').a === 0 && hl('Josh Doan', 'pts').a === 2,
  'the skaters: Hutson 2 assists, Suzuki 1; Demidov 1 point, McLeod 0, Doan 2');
ok(hl('Josh Norris', 'pts').v === 2 && hlegs.filter((l) => l.a == null).length === 1,
  'Josh Norris, priced an hour before and not in the box: void, the only leg not graded');
const hrep = hr.report.byMarket;
ok(hrep.pts && hrep.ast && hrep.saves && hr.report.all.priced >= 6, `the report by market, the sharp books' chance at PrizePicks' line on ${hr.report.all.priced} of ${hr.report.all.legs}`);

console.log('\n-- how often the Less landed at each line --');
// A later game, in the stored shape: a Less that missed, and a whole-number line that pushed.
sq.prepare("INSERT INTO histpropgames (job, event_id, date, commence, game, legs, graded) VALUES ('nhl', 'later', '2026-03-01', '2026-03-02T00:00:00Z', 'x @ y', ?, 2)")
  .run(JSON.stringify([{ p: 'A', mk: 'saves', pp: 23.5, a: 30 }, { p: 'B', mk: 'saves', pp: 24, a: 24 }]));
const hl1 = await get('/api/hist-props?job=nhl&lines=1');
const hline = (mk, x) => hl1.lines[mk].lines.find((l) => l.line === x);
console.log(`  ${JSON.stringify(hline('saves', 23.5))}`);
ok(hl1.games === 2 && hline('pts', 0.5).n === 4 && hline('pts', 0.5).less === 1 && hline('pts', 0.5).rate === 25 && hline('ast', 0.5).less === 0 && hline('ast', 0.5).n === 2,
  "points at 0.5: McLeod's the one Less of four, Norris's void not counted; assists at 0.5: none of two");
ok(hline('saves', 23.5).n === 3 && hline('saves', 23.5).less === 2 && hline('saves', 23.5).early.n === 2 && hline('saves', 23.5).early.rate === 100 && hline('saves', 23.5).late.n === 1 && hline('saves', 23.5).late.rate === 0,
  'saves at 23.5: two of three, the earlier and later games apart, so one stretch cannot pass for a line');
ok(hline('saves', 24).n === 0 && hline('saves', 24).push === 1 && hline('saves', 24).rate === null && hl1.lines.saves.all.n === 3 && hl1.lines.saves.all.push === 1,
  'a push decides nothing: counted apart, in neither the Less nor the n');
ok(hline('saves', 23.5).low === 20.8 && hl1.lines.saves.lines[0].line === 23.5, `the floor of the 95% interval (${hline('saves', 23.5).low}), and the lines in order`);
sq.prepare("DELETE FROM histpropgames WHERE job = 'nhl' AND event_id = 'later'").run();
await get('/api/hist-props?job=nhl&stop=1');

// ---- names, a run cut off, and a regrade (2026-10-29) ------------------------------------------
console.log('\n-- names --');
const nm = new Function([cst('NFL_NAME_SUFFIX'), wlift('normName'), cst('nflBaseName'), cst('nbaBaseName'), cst('NBA_NAME_ALIAS'), 'let NBA_ALIAS = null;', cst('nbaName')].join('\n') + '\nreturn nbaName;')();
ok([['Nicolas Claxton', 'Nic Claxton'], ['Carlton Carrington', 'Bub Carrington'], ['Herb Jones', 'Herbert Jones'], ['Xavier Tillman, Sr.', 'Xavier Tillman Sr.'], ["De'Andre Hunter", "De'Andre Hunter"]]
  .every(([a, b]) => nm(a) === nm(b)), "PrizePicks' Nicolas Claxton, Carlton Carrington, Herb Jones and Xavier Tillman, Sr. are ESPN's Nic, Bub, Herbert and Xavier Tillman Sr.");

console.log('\n-- a run cut off after its first game --');
remaining = 80000;
sq.prepare("DELETE FROM histpropgames WHERE job = 'nba'").run();
const s3 = JSON.parse(sq.prepare("SELECT data FROM feed_cache WHERE key = 'hist_props:nba'").get().data);
sq.prepare("UPDATE feed_cache SET data = ? WHERE key = 'hist_props:nba'").run(JSON.stringify({ ...s3, active: true, done: false, stopped: null, games: 0, credits: 0, errors: 0, day: days.indexOf('2026-01-15'), queue: [] }));
const realFetch = globalThis.fetch;
let oddsN = 0;
globalThis.fetch = async (u) => { if (/basketball_nba\/events\/[0-9a-f]+\/odds/.test(String(u)) && ++oddsN === 2) throw new Error('the run is cut off'); return realFetch(u); };
await tick();
globalThis.fetch = realFetch;
const cut = JSON.parse(sq.prepare("SELECT data FROM feed_cache WHERE key = 'hist_props:nba'").get().data);
ok(cut.games === 1 && cut.credits === 51 && sq.prepare("SELECT COUNT(*) AS n FROM histpropgames WHERE job = 'nba'").get().n === 1,
  'the game read before the cut is kept, and its credits counted: the state is saved after each game');

console.log('\n-- a regrade --');
const r0 = sq.prepare("SELECT legs FROM histpropgames WHERE job = 'nba'").get();
const broken = JSON.parse(r0.legs).map((l) => (l.p === 'Paolo Banchero' ? { ...l, a: undefined } : l));
sq.prepare("UPDATE histpropgames SET legs = ?, graded = 1 WHERE job = 'nba'").run(JSON.stringify(broken));
const rg = await get('/api/hist-props?job=nba&regrade=1');
const after = JSON.parse(sq.prepare("SELECT legs, graded FROM histpropgames WHERE job = 'nba'").get().legs);
ok(rg.regraded === 1 && after.find((l) => l.p === 'Paolo Banchero' && l.mk === 'pts').a === 26 && sq.prepare("SELECT graded FROM histpropgames WHERE job = 'nba'").get().graded === 2,
  "a stored game with a leg open is read from its box score again: Banchero's 26 back");
ok((await get('/api/hist-props?job=nba&regrade=1')).regraded === 0, 'and once regraded at this alias set, not again');
const toml = fs.readFileSync(BOARD + '/wrangler.toml', 'utf8');
ok(/crons = \[.*"1-59\/2 \* \* \* \*".*\]/.test(toml) && /const HIST_CRON = '1-59\/2 \* \* \* \*';/.test(src), 'on its own cron trigger');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
