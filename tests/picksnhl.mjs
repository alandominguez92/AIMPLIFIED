// NHL favourites on Picks of the day at 65% (2026-10-22).
//
// The NHL moneyline was logged and graded from Oct 20 but kept off Picks of
// the day until its 65%+ favourites had a record. Last season's backtest
// (/api/hist-backtest?job=nhl: 2025-26 favourites the sharp books made 65%+
// won 114 of 171, 66.7% against a stated 69.1%) gave it one, and the owner put
// it on. What has to hold:
//   - a regular-season NHL favourite at 65%+ is listed, one leg a game, under
//     the NHL board's own leg id (nhl:ml:<event>:<side>) so a star here is the
//     board's star, by nickname (two words for the Golden Knights), with its crest
//   - a 64.9% favourite is not
//   - the leg grades from the NHL log the way the other moneylines grade from
//     theirs, and its kind keeps its own record at 65%+
//   - the page names the sport and says to check the goalie
//
// The rows are written into the worker's own game-line log (gmpicks) as the
// NHL capture leaves them, with Thursday Oct 22's real prices: Ducks @ Devils
// 66.3%, Golden Knights @ Blues 54.2% for St. Louis's opponent, Wild @ Flames
// 65.6%, Jets @ Stars 64.6%. Real SQLite and the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const RealDate = Date;
let NOW = RealDate.parse('2026-10-22T21:00:00Z');        // Thursday 2 PM Pacific
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
globalThis.fetch = async () => new Response('{}', { status: 404 });
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
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const hit = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

await hit('/api/gmpicks-export');                            // the table
const ins = sq.prepare(`INSERT INTO gmpicks (sport, date, game_id, market, league, commence, side, pick, home, away, win_prob, implied, edge,
  entry_price, close_price, book, fair_src, sharp_n, model_ver, entry_win_prob, result)
  VALUES ('nhl', ?, ?, 'h2h', 'reg', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draftkings', 'sharp-pool', 4, 'gm-v1', ?, ?)`);
const row = (date, id, commence, side, home, away, p, price, result = null) =>
  ins.run(date, id, commence, side, side === 'home' ? home : away, home, away, p, null, null, price, price, p, result);
row('2026-10-22', 'h1', '2026-10-22T23:10:00Z', 'home', 'New Jersey Devils', 'Anaheim Ducks', 66.3, -213);
row('2026-10-22', 'h2', '2026-10-23T01:10:00Z', 'away', 'Calgary Flames', 'Minnesota Wild', 65.6, -200);
row('2026-10-22', 'h3', '2026-10-23T00:10:00Z', 'home', 'Dallas Stars', 'Winnipeg Jets', 64.6, -192);
row('2026-10-22', 'h4', '2026-10-23T00:10:00Z', 'away', 'St Louis Blues', 'Vegas Golden Knights', 69.0, -240);   // priced up for the test
// Graded history for the kind's own record: two 65%+ favourites, one under.
row('2026-10-20', 'g1', '2026-10-20T23:00:00Z', 'home', 'Boston Bruins', 'Chicago Blackhawks', 70.1, -255, 'win');
row('2026-10-20', 'g2', '2026-10-20T23:00:00Z', 'home', 'Florida Panthers', 'Ottawa Senators', 66.0, -210, 'loss');
row('2026-10-20', 'g3', '2026-10-20T23:00:00Z', 'home', 'Toronto Maple Leafs', 'Montréal Canadiens', 60.0, -160, 'win');

let d = await hit('/api/picks');
const nhl = (d.legs || []).filter((x) => x.kind === 'nhl_ml');
const leg = (t) => nhl.find((x) => x.title === t);
console.log('  ' + nhl.map((x) => `${x.title} ${x.p}% (${x.sub})`).join(' | '));
ok(d.kinds && d.kinds.nhl_ml && d.kinds.nhl_ml.min === 65 && d.kinds.nhl_ml.sport === 'nhl', 'NHL favourites are a Picks kind, at 65%');
ok(nhl.length === 3 && leg('Devils ML') && leg('Wild ML') && leg('Golden Knights ML') && !nhl.some((x) => /Stars/.test(x.title)),
  'the Devils (66.3%), the Wild (65.6%) and the Golden Knights are listed; the Stars at 64.6% are not');
const vgk = leg('Golden Knights ML');
ok(vgk && vgk.legId === 'nhl:ml:h4:away' && vgk.sub === 'Golden Knights @ Blues' && vgk.spec.logo === 'nhl/500/vgk.png' && vgk.spec.sport === 'nhl',
  `the NHL board's own leg id and nicknames, with its crest (${vgk && vgk.legId}, ${vgk && vgk.sub}, ${vgk && vgk.spec.logo})`);
ok(d.kinds.nhl_ml.record.n === 2 && d.kinds.nhl_ml.record.hit === 1, `the kind's record is its 65%+ favourites only (${JSON.stringify(d.kinds.nhl_ml.record)})`);
ok(leg('Devils ML').record.n === 2 && leg('Devils ML').odds === -213, 'each leg carries that record and its price');

// The Devils win; the list grades the leg from the NHL log.
NOW = RealDate.parse('2026-10-23T15:00:00Z');
sq.prepare("UPDATE gmpicks SET result = 'win' WHERE game_id = 'h1'").run();
sq.prepare("UPDATE gmpicks SET result = 'loss' WHERE game_id = 'h2'").run();
d = await hit('/api/picks');
const dp = (id) => sq.prepare('SELECT result, on_list FROM daypicks WHERE leg_id = ?').get(id) || {};
ok(dp('nhl:ml:h1:home').result === 'hit' && dp('nhl:ml:h2:away').result === 'miss' && dp('nhl:ml:h1:home').on_list === 1,
  'on the list at puck drop, graded from the NHL log: the Devils a hit, the Wild a miss');

console.log('\n-- the page --');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
ok(/const PICK_SPORT = \{[^}]*nhl: 'NHL'/.test(app) && /const PICK_BOARD = \{[^}]*nhl_ml: 'NHL ML'/.test(app), 'the page names the sport: "Today\'s best NHL leg"');
ok(/\(x\.sport \|\| s\.sport\) === 'nhl'\) notes\.push\('check the goalie'\)/.test(app) && /x\.sport === 'nhl'\) tags\.push\('<span class="tc-wait">check the goalie<\/span>'\)/.test(app),
  'and an NHL leg says to check the goalie, on the top card and in the list');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
