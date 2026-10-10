// Picks of the day (2026-10-09): the legs most likely to land, across sports,
// one per game, for PrizePicks -- which pays the same on every leg, moneylines
// included, so the chance a leg lands is the whole question.
//
// Real SQLite underneath (node:sqlite, as tests/nbapp.mjs), because the list
// is read from the logs the site already keeps. The StatsAPI schedule is the
// recorded 2026-10-07 payload (four Division Series games, all four cards
// posted), with its first pitches moved into the next few hours so the games
// have not started.
//
// What has to hold:
//   - only kinds of leg whose stated chance held up, at their bar: moneyline
//     favourites 65%+, PrizePicks unders 70%+ (MLB TB and H+R+RBI, NBA rotation
//     players); no strikeout unders, no NBA preseason
//   - the moneyline log keeps the side the board leads with, often the dog: the
//     favourite is the other side, with the other side's chance
//   - a benched hitter never makes the list (Pham, 2026-10-07)
//   - one leg per game, the best; at most six
//   - each leg carries its kind's record at that bar, and the slip id its own
//     board uses, so a star here is the same leg as a star there
//   - the list keeps its own record: what it showed when each game started,
//     graded from the log the leg came from; an outage is not "dropped off"
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const RealDate = Date;
let NOW = RealDate.parse('2026-10-21T17:00:00Z');        // a Wednesday, 10 AM Pacific
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const iso = (ms) => new RealDate(ms).toISOString();
const ptDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new RealDate(ms));
const TODAY = ptDay(NOW), YDAY = ptDay(NOW - 86400e3);
const H = 3600e3;

const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
function exec(sql, args, mode) {
  const st = sq.prepare(sql);
  const a = args.map(norm);
  if (mode === 'all') return { results: st.all(...a), meta: {} };
  if (mode === 'first') return st.get(...a) || null;
  return { success: true, meta: { changes: Number(st.run(...a).changes) } };
}
const DB = {
  prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
    all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
    run: async () => exec(s.sql, s.args, 'run') }; return s; },
  batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')),
};
const env = { DB };

// The recorded schedule, its four games moved to 1, 3, 5 and 7 PM Pacific today.
const SCHED = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'statsapi-schedule-lineups-20261007.json'), 'utf8'));
const START = { 849833: NOW + 3 * H, 849822: NOW + 5 * H, 849838: NOW + 7 * H, 849827: NOW + 9 * H };
const today = structuredClone(SCHED);
for (const g of today.dates[0].games) { g.gameDate = iso(START[g.gamePk]); g.status.abstractGameState = 'Preview'; }
let statsDown = false;
globalThis.fetch = async (u) => {
  const url = String(u);
  if (url.includes('statsapi.mlb.com') && url.includes('/schedule')) {
    if (statsDown) return new Response('down', { status: 503 });
    const d = new URL(url).searchParams.get('date');
    return new Response(JSON.stringify(d === TODAY ? today : { dates: [] }), { status: 200 });
  }
  return new Response('{}', { status: 404 });
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const hit = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();
const tick = async (at) => { const held = []; await mod.default.scheduled({ scheduledTime: at }, env, { waitUntil: (p) => held.push(p) }); await Promise.allSettled(held); };

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

const empty = await hit('/api/picks');
ok(Array.isArray(empty.legs) && empty.legs.length === 0 && !empty.error, `an empty log lists nothing and does not fail (${empty.error || 'ok'})`);

// ---- the logs ---------------------------------------------------------------------------
const run = (sql, ...a) => sq.prepare(sql).run(...a.map(norm));
const mlRow = (date, gid, team, opp, isHome, wp, price, result) => run(
  'INSERT INTO mlpicks (date, game_id, team, opp, is_home, tier, win_prob, edge, entry_price, close_price, result) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  date, gid, team, opp, isHome, 'pass', wp, -1, price, price, result);
const ppRow = (date, gid, pid, player, team, market, mu, result, point = 0.5) => run(
  'INSERT INTO pppicks (date, game_id, player_id, player, team, market, point, model_under, close_point, close_model_under, result) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  date, gid, pid, player, team, market, point, mu, point, mu, result);
const gmRow = (sport, date, gid, market, league, commence, side, pick, home, away, wp, price, result) => run(
  'INSERT INTO gmpicks (sport, date, game_id, market, league, commence, side, pick, home, away, win_prob, entry_price, close_price, result) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  sport, date, gid, market, league, commence, side, pick, home, away, wp, price, price, result);
const npRow = (date, gid, player, team, market, point, mu, minProj, bookLine, commence, result) => run(
  "INSERT INTO nbapp (date, game_id, player, market, league, commence, home, away, team, point, model_under, min_proj, book_line, result) VALUES (?,?,?,?,'reg',?,?,?,?,?,?,?,?,?)",
  date, gid, player, market, commence, 'Boston Celtics', 'New York Knicks', team, point, mu, minProj, bookLine, result);

// MLB moneylines. The White Sox row is the board's dog at 30%: the favourite is
// Cleveland at 70. Tampa Bay is a 32% dog: the Yankees at 68. The Dodgers lead
// their own row at 66. Milwaukee at 60 is under the bar.
mlRow(TODAY, 'g849833', 'CWS', 'CLE', 1, 30, 140, null);
mlRow(TODAY, 'g849822', 'LAD', 'ATL', 0, 66, -190, null);
mlRow(TODAY, 'g849838', 'TB', 'NYY', 0, 32, 150, null);
mlRow(TODAY, 'g849827', 'MIL', 'SD', 0, 60, -145, null);
// MLB PrizePicks unders.
ppRow(TODAY, 'g849833', 502054, 'T. Pham', 'CWS', 'tb', 80, null);         // benched: on neither card
ppRow(TODAY, 'g849833', 545341, 'R. Grichuk', 'CWS', 'hrr', 74, null, 1.5); // carded: beats Cleveland's 70 for the game
ppRow(TODAY, 'g849827', 694192, 'J. Chourio', 'MIL', 'tb', 71, null);       // carded
ppRow(TODAY, 'g849827', 592518, 'M. Machado', 'SD', 'tb', 69, null);        // under the bar
ppRow(TODAY, 'g849827', 999101, 'Some Starter', 'SD', 'K', 85, null, 4.5);  // strikeout unders are out
// NBA, NFL, soccer game lines.
gmRow('nba', TODAY, 'evA', 'h2h', 'reg', iso(NOW + 2 * H), 'home', 'Boston Celtics', 'Boston Celtics', 'New York Knicks', 78, -320, null);
gmRow('nba', TODAY, 'evPRE', 'h2h', 'pre', iso(NOW + 4 * H), 'home', 'Utah Jazz', 'Utah Jazz', 'Portland Trail Blazers', 85, -500, null);
gmRow('nba', TODAY, 'evGONE', 'h2h', 'reg', iso(NOW - 1 * H), 'home', 'Miami Heat', 'Miami Heat', 'Orlando Magic', 80, -400, null);
gmRow('nfl', ptDay(NOW + 20 * H), 'evN', 'h2h', 'REG', iso(NOW + 20 * H), 'home', 'DAL', 'DAL', 'TB', 67, -220, null);
gmRow('soccer', ptDay(NOW + 30 * H), 'evS', 'fav', 'epl', iso(NOW + 30 * H), 'home', 'Arsenal', 'Arsenal', 'Leeds United', 72, -260, null);
gmRow('soccer', TODAY, 'evS2', 'fav', 'epl', iso(NOW + 6 * H), 'home', 'Chelsea', 'Chelsea', 'Brentford', 64, -170, null);
// NBA PrizePicks unders.
npRow(TODAY, 'evA', 'Jayson Tatum', 'BOS', 'reb', 9.5, 76, 36, 9.5, iso(NOW + 2 * H), null);   // same game as Boston's 78
npRow(TODAY, 'evB', 'Bench Guy', 'NY', 'threes', 0.5, 90, 10, null, iso(NOW + 8 * H), null);   // not a rotation player
npRow(TODAY, 'evB', 'Jalen Brunson', 'NY', 'ast', 6.5, 72, 35, 5.5, iso(NOW + 8 * H), null);  // PrizePicks a point above the book
// Graded history, for each kind's record at its bar.
mlRow(YDAY, 'g1', 'AAA', 'BBB', 1, 70, -240, 'win');     // favourite at 70 won: a hit
mlRow(YDAY, 'g2', 'CCC', 'DDD', 1, 30, 150, 'win');      // the dog won: its 70% favourite missed
mlRow(YDAY, 'g3', 'EEE', 'FFF', 1, 58, -130, 'loss');    // 58: under the bar, not counted
ppRow(YDAY, 'g1', 1, 'A', 'AAA', 'tb', 75, 'under');
ppRow(YDAY, 'g1', 2, 'B', 'AAA', 'hrr', 72, 'over');
ppRow(YDAY, 'g1', 3, 'C', 'AAA', 'K', 80, 'under');      // strikeouts are not a kind on the list
ppRow(YDAY, 'g1', 4, 'D', 'AAA', 'tb', 60, 'under');     // under the bar
gmRow('nba', YDAY, 'evP1', 'h2h', 'pre', iso(NOW - 20 * H), 'home', 'X', 'X', 'Y', 70, -250, 'loss');   // preseason: not counted

// ---- the list ---------------------------------------------------------------------------
console.log('\n-- the list --');
const d = await hit('/api/picks');
const L = d.legs || [];
console.log('  ' + L.map((x) => `${x.rank}. ${x.title} ${x.p}% [${x.kind}]`).join(' | '));
const leg = (t) => L.find((x) => x.title.startsWith(t));
ok(L.length === 6 && L.every((x, i) => i === 0 || L[i - 1].p >= x.p), `six legs, best first (${L.length})`);
ok(L.map((x) => x.title.split(' ')[0]).join(',') === 'Celtics,R.,Jalen,J.,NYY,DAL',
  'Boston 78, Grichuk 74, Brunson 72, Chourio 71, the Yankees 68, Dallas 67 -- and the Dodgers at 66 are seventh, off the list');
ok(leg('NYY ML') && leg('NYY ML').legId === 'ml:g849838:NYY' && leg('NYY ML').p === 68 && leg('NYY ML').spec.side === 'home',
  `the board led with Tampa Bay at 32%: the favourite is the Yankees, at 68, at home (${leg('NYY ML') && leg('NYY ML').legId})`);
ok(!L.some((x) => /Pham/.test(x.title)), 'Pham, on neither posted card, is not listed');
const gr = leg('R. Grichuk');
ok(gr && gr.lineup === 'in' && gr.legId === 'pp:b545341:hrr' && gr.spec.pp.line === 1.5,
  "Grichuk is on the card, under the batter row's slip id, at PrizePicks' number");
ok(!L.some((x) => x.title === 'CLE ML') && !L.some((x) => /Tatum/.test(x.title)),
  'one leg a game: Cleveland (70) gives way to Grichuk (74) in theirs, Tatum (76) to Boston (78) in theirs');
ok(!L.some((x) => /Starter|Machado|Bench|Jazz|Heat|Arsenal|Chelsea|MIL ML/.test(x.title)),
  'no strikeout under, nothing under its bar, no bench player, no preseason, nothing started, nothing past the next day');
const bru = leg('Jalen Brunson');
ok(bru && bru.vsBook === 1 && bru.legId === 'nbapp:evB:Jalen Brunson:ast', "an NBA under carries PrizePicks' number against the book's (+1)");
const dal = leg('DAL ML');
ok(dal && dal.legId === 'nfl:ml:evN:DAL' && dal.spec.gamePk === `TB @ DAL|${ptDay(NOW + 20 * H)}`,
  'the NFL leg keys its game by matchup and day, as the NFL board\'s star does');
ok(leg('Celtics ML') && leg('Celtics ML').legId === 'nba:ml:evA:home', 'and the NBA moneyline under the NBA board\'s id');

console.log('\n-- the records beside each leg --');
console.log('  ' + Object.entries(d.kinds).map(([k, v]) => `${k} ${v.record.hit}/${v.record.n}`).join(' | '));
ok(d.kinds.mlb_ml.record.n === 2 && d.kinds.mlb_ml.record.hit === 1,
  'MLB favourites at 65%+: the 70% favourite that won and the 70% favourite whose dog won; the 58 is not counted');
ok(d.kinds.mlb_pp.record.n === 2 && d.kinds.mlb_pp.record.hit === 1, 'MLB PrizePicks unders at 70%+, TB and H+R+RBI only');
ok(d.kinds.nba_ml.record.n === 0, 'an NBA preseason favourite is not an NBA favourite');
ok(leg('NYY ML').record && leg('NYY ML').record.n === 2 && leg('NYY ML').record.proven === false,
  'each leg carries its kind\'s record, and says when it is too thin to lean on');
const e2 = (d.entries || [])[0];
ok(e2 && e2.entry === '2-pick power' && e2.allLand === Math.round(78 * 74 / 100 * 10) / 10 && e2.perLegBreakEven === 57.7,
  `the entry read: the top two both land ${e2 && e2.allLand}% of the time, each needing 57.7% for a 2-pick power`);

// ---- the list's own record -------------------------------------------------------------
console.log('\n-- logged as shown --');
const logged = () => sq.prepare('SELECT leg_id, rank, on_list, result FROM daypicks ORDER BY rank').all();
let rows = logged();
ok(rows.filter((r) => r.on_list === 1).length === 6 && rows.find((r) => r.leg_id === 'nba:ml:evA:home').rank === 1,
  'every leg shown is logged with its rank');
// Brunson's number drops before his game; the Dodgers move up into sixth.
run("UPDATE nbapp SET model_under = 61 WHERE player = 'Jalen Brunson'");
await hit('/api/picks');
rows = logged();
const row = (id) => rows.find((r) => r.leg_id === id) || {};
ok(row('nbapp:evB:Jalen Brunson:ast').on_list === 0 && row('ml:g849822').on_list === 1,
  'a leg that drops off before its game is marked off, and the leg that replaces it is logged');
// Boston tips. Its row is no longer a candidate, and is left as it stood.
NOW += 2.5 * H;
await hit('/api/picks');
rows = logged();
ok(row('nba:ml:evA:home').on_list === 1, 'once a game starts its row is frozen: Boston was on the list at tip');
// StatsAPI goes down: the MLB legs vanish from the read, but not from the log.
statsDown = true;
const down = await hit('/api/picks');
rows = logged();
ok((down.unavailable || []).includes('mlb_pp') && row('pp:b694192:tb').on_list === 1,
  'an outage is not a leg falling off: Chourio stays logged while the schedule cannot be read');
statsDown = false;
// Boston wins; three hours on, the list grades it from the NBA log.
run("UPDATE gmpicks SET result = 'win' WHERE game_id = 'evA'");
NOW += 3 * H;
await tick(NOW);
rows = logged();
ok(row('nba:ml:evA:home').result === 'hit', `graded from the log it came from, on the cron (${row('nba:ml:evA:home').result})`);
const r2 = (await hit('/api/picks')).record;
ok(r2 && r2.legs.n === 1 && r2.legs.hit === 1 && r2.since === TODAY, `and the list's record counts it (${JSON.stringify(r2 && r2.legs)})`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
