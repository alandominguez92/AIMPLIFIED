// What the week of Oct 19-25 changed (2026-10-25).
//
//   - Picks of the day's legs at 75%+ landed 28 of 31 from Oct 10 to 24, those
//     at 65-75% 20 of 29. The record now keeps a Top 2 Power of the day's two
//     best legs at 75%+ beside the plain Top 2 (skipping a day without two),
//     and the entry table shows it for the list still to play.
//   - Underdog's and Pick6's line on the same under ride beside PrizePicks' on
//     the NBA card and on Picks of the day. The NBA read has carried them since
//     Oct 22 at no extra credit; a higher number there is an easier under.
//   - NHL PrizePicks reads are paused: 39 of 84 unders landed at PrizePicks'
//     lines against the backtest's 59-67%. The logged legs still grade.
//
// Real data: production's Picks of the day record as /api/picks served it at
// 9 PM Pacific on Oct 25 (tests/fixtures/picks-history-20261025.json), and the
// Hawks @ Rockets NBA read production took at 5:40 PM, Underdog's lines with it
// (odds-nba-pp-b57695c1-20261025.json). Real SQLite, the real worker as shipped.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const read = (f) => JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', f), 'utf8'));
const HIST = read('picks-history-20261025.json'), HOU = read('odds-nba-pp-b57695c1-20261025.json');
const RealDate = Date;
let NOW = RealDate.parse(HIST.at);
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const READ_URL = `https://api.the-odds-api.com/v4/sports/basketball_nba/events/${HOU.id}/odds?apiKey=k`
  + '&markets=player_threes,player_assists,player_rebounds,player_blocks,player_steals&oddsFormat=american&dateFormat=iso'
  + '&bookmakers=prizepicks,underdog,pick6,draftkings,fanduel';
const calls = [];
globalThis.fetch = async (u) => {
  const url = String(u);
  calls.push(url);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json', 'x-requests-last': '0', 'x-requests-remaining': '86000' } });
  if (url === READ_URL) return J(HOU);
  if (url.startsWith('https://api.the-odds-api.com/')) return J([]);
  if (url.includes('statsapi.mlb.com')) return J({ dates: [] });
  return new Response('{}', { status: 404 });
};
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
const PRIORS = fs.readFileSync(path.join(BOARD, 'nba-priors.json'), 'utf8');
const env = { DB, ODDS_API_KEY: 'k', ASSETS: { fetch: async (r) => (new URL(r.url).pathname === '/nba-priors.json'
  ? new Response(PRIORS, { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('{}', { status: 404 })) } };
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();
const tick = async () => { const held = []; await mod.default.scheduled({}, env, { waitUntil: (p) => held.push(p) }); await Promise.allSettled(held); };

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// ---- the 75%+ Top 2 Power ---------------------------------------------------------------------
console.log('-- the list, Oct 10 to 25, as production kept it --');
await get('/api/picks');                                        // the tables
const ins = sq.prepare(`INSERT INTO daypicks (date, leg_id, kind, label, p, first_p, commence, rank, on_list, seen_at, result)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`);
for (const d of HIST.history.days) {
  d.legs.forEach((x, i) => ins.run(d.date, `leg:${d.date}:${i}`, x.kind, x.label, x.p, x.first, `${d.date}T20:00:00Z`, i + 1, `${d.date}T19:00:00Z`, x.result));
}
const h = (await get('/api/picks')).record.history;
const e = (k) => h.entries.find((x) => x.key === k) || {};
const p2 = HIST.history.entries.find((x) => x.key === 'p2');
ok(e('p2').days === p2.days && e('p2').won === p2.won && e('p2').units === p2.units, `the plain Top 2 Power is production's: ${e('p2').won} of ${e('p2').days}, ${e('p2').units}u`);
// Each day's two best legs at 75%+, both graded, as a 2-pick Power (3x).
let days = 0, won = 0, units = 0;
for (const d of HIST.history.days) {
  const hi = d.legs.filter((x) => x.p >= 75).sort((a, b) => b.p - a.p).slice(0, 2);
  if (hi.length < 2 || hi.some((x) => x.result !== 'hit' && x.result !== 'miss')) continue;
  days++; const w = hi.every((x) => x.result === 'hit'); if (w) won++; units += (w ? 3 : 0) - 1;
}
const h75 = e('p2h');
console.log(`  75%+: ${h75.won} of ${h75.days}, ${h75.units}u (${h75.roi}%) · plain: ${e('p2').won} of ${e('p2').days}, ${e('p2').units}u (${e('p2').roi}%)`);
ok(h75.label === 'Top 2 Power, 75%+' && h75.days === days && h75.won === won && h75.units === units && days > 0,
  `the 75%+ Power, each day's two best legs at 75% or better: won ${won} of ${days} days, ${units}u`);
ok(h75.days < e('p2').days, `a day without two legs at 75%+ has no such entry (${h75.days} days against ${e('p2').days})`);

// ---- Underdog beside PrizePicks ----------------------------------------------------------------
console.log('\n-- Hawks @ Rockets, read an hour before tip --');
NOW = RealDate.parse(HOU.commence_time) - 45 * 60e3;
await tick();                                                   // the cron's tables
calls.length = 0;
sq.prepare('INSERT OR REPLACE INTO feed_cache (key, data, updated_at) VALUES (?, ?, ?)').run('nba_board:reg',
  JSON.stringify({ asOf: new RealDate(NOW).toISOString(), games: [{ id: HOU.id, league: 'reg', commence: HOU.commence_time, home: HOU.home_team, away: HOU.away_team }] }), NOW);
// An NHL game in the watch window too, for the pause below.
sq.prepare('INSERT OR REPLACE INTO feed_cache (key, data, updated_at) VALUES (?, ?, ?)').run('nhl_board:reg',
  JSON.stringify({ asOf: new RealDate(NOW).toISOString(), games: [{ id: 'nhl1', league: 'reg', commence: new RealDate(NOW + 5 * 3600e3).toISOString(), home: 'Seattle Kraken', away: 'Minnesota Wild' }] }), NOW);
await tick();
ok(calls.includes(READ_URL), 'the read: the same URL, Underdog and Pick6 asked with PrizePicks as since Oct 22');
const ptDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new RealDate(iso));
const ud = HOU.bookmakers.find((b) => b.key === 'underdog'), pp = HOU.bookmakers.find((b) => b.key === 'prizepicks');
const under = (bk, mk, name) => { const m = bk.markets.find((x) => x.key === mk); const o = m && m.outcomes.find((x) => x.name === 'Under' && x.description === name); return o ? o.point : null; };
const MK = { player_threes: 'threes', player_assists: 'ast', player_rebounds: 'reb', player_blocks: 'blk', player_steals: 'stl' };
const rows = sq.prepare('SELECT player, market, point, ud_line, p6_line FROM nbapp WHERE game_id = ?').all(HOU.id);
const both = rows.filter((r) => r.ud_line != null);
const want = rows.map((r) => ({ r, u: under(ud, Object.keys(MK).find((k) => MK[k] === r.market), r.player) }));
console.log(`  ${rows.length} legs logged, ${both.length} with Underdog's line: ` + both.slice(0, 5).map((r) => `${r.player} ${r.market} PP ${r.point} UD ${r.ud_line}`).join(' | '));
ok(rows.length > 0 && both.length > 0 && want.every(({ r, u }) => (r.ud_line == null ? u == null : r.ud_line === u)),
  "each logged leg carries Underdog's line where Underdog quoted the same under, and none where it did not");
ok(rows.every((r) => r.p6_line == null), 'Pick6 had not posted this game: no Pick6 line on any leg');
const board = await get('/api/nba-pp');
const bl = board.legs.find((x) => x.ud_line != null);
ok(bl && typeof bl.ud_line === 'number' && 'p6_line' in bl, `the card's legs carry them (${bl && `${bl.player} PP ${bl.point}, UD ${bl.ud_line}`})`);

// On Picks of the day too: a leg of that game at the bar, as the pre-tip read
// leaves it, with Underdog a point above PrizePicks.
sq.prepare(`INSERT INTO nbapp (date, game_id, player, market, league, commence, home, away, team, player_id, point, proj, model_under, n_recent, min_proj,
  book_line, book_under, captured_at, close_point, close_under, close_book_line, close_book_under, close_at, ud_line)
  VALUES (?, ?, 'Test Shooter', 'threes', 'reg', ?, ?, ?, 'HOU', '1', 1.5, 0.6, 80, 5, 30, 1.5, -130, ?, 1.5, 80, 1.5, -130, ?, 2.5)`)
  .run(ptDay(HOU.commence_time), HOU.id, HOU.commence_time, HOU.home_team, HOU.away_team, new RealDate(NOW).toISOString(), new RealDate(NOW).toISOString());
const pl = ((await get('/api/picks')).legs || []).find((x) => x.title === 'Test Shooter Under 1.5 3PM');
ok(pl && pl.dfs && pl.dfs.ud === 2.5 && pl.dfs.p6 === null, `and Picks of the day's leg carries them to the page (${pl && JSON.stringify(pl.dfs)})`);

console.log('\n-- the page --');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const lift = (name, from = app) => {
  let at = from.indexOf(`function ${name}(`);
  const isConst = at < 0;
  if (isConst) at = from.indexOf(`const ${name} =`);
  let depth = 0;
  for (let i = at; i < from.length; i++) {
    const c = from[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') { depth--; if (!isConst && c === '}' && depth === 0) return from.slice(at, i + 1); }
    else if (isConst && c === ';' && depth === 0 && from[i + 1] === '\n') return from.slice(at, i + 1);
  }
  throw new Error('could not lift ' + name);
};
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const dfs = new Function('esc', lift('dfsLinesHtml') + '\nreturn dfsLinesHtml;')(esc);
const text = (x) => x.replace(/<[^>]+>/g, '').trim();
ok(/class="tc-gap"/.test(dfs(5.5, 6.5, null)) && text(dfs(5.5, 6.5, null)) === 'UD 6.5', 'Underdog a point higher: tagged as the easier under');
ok(/class="tc-dfs"/.test(dfs(5.5, 5.5, 5)) && text(dfs(5.5, 5.5, 5)).replace(/\s+/g, ' ') === 'UD 5.5 P6 5' && dfs(5.5, null, null) === '', 'level or lower: shown plain; none quoted: nothing');
ok(/\$\{ppMovedTag\(x\)\}\$\{dfsLinesHtml\(x\.point, x\.ud_line, x\.p6_line\)\}/.test(lift('nbaPpCardHtml'))
  && /dfsLinesHtml\(x\.spec\.pp\.line, x\.dfs\.ud, x\.dfs\.p6\)/.test(app), 'on the NBA card beside each leg, and on Picks of the day');
ok(/const hi = legs\.filter\(\(x\) => x\.p >= 75\)\.slice\(0, 2\);/.test(app) && /Top 2 \$\{esc\(kind\)\}, 75%\+/.test(app),
  "the entry table's 75%+ Power, for the list still to play");

// ---- NHL reads paused ------------------------------------------------------------------------------
console.log('\n-- NHL PrizePicks reads paused --');
ok(!calls.some((u) => /icehockey_nhl\/events\/[^/]+\/odds/.test(u)), 'an NHL game five hours out: no PrizePicks read, no check');
const nb = await get('/api/nhl-pp');
ok(nb.paused === '2026-10-25', `the board says so (${nb.paused})`);
const note = new Function('state', 'esc', ['TEAM_COLORS', 'MLB_TEAM_ID', 'NHL_PHOTO_SEASON', 'headshotUrl', 'teamMarkUrl', 'initialsOf', 'avatarHtml',
  'LEG_OFFERS', 'offerLeg', 'ptDayOf', 'soccerKick', 'AM', 'NHL_MK', 'nhlPpLeg', 'nbaOversLineHtml', 'ppMovedTag', 'ppCloseLineHtml', 'nhlPpCardHtml'].map((n) => lift(n)).join('\n')
  + '\nreturn nhlPpCardHtml;')({ nhlPp: { paused: '2026-10-25', legs: [], record: { graded: 84, hit: 39 } }, slip: {} }, esc)();
ok(/Paused on Oct 25/.test(note) && /39 of 84/.test(note) && !/has not posted/.test(note), `the card: "${text(note).slice(-170)}"`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
