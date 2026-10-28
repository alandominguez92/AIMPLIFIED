// PrizePicks lines read as soon as they are posted, and again before the start
// (2026-10-23).
//
// The NBA and NHL PrizePicks unders were read once, about four hours (NBA) or
// 100 minutes (NHL) before the start. The user builds entries the day before,
// and PrizePicks posts NBA lines by midnight, so the card had nothing for them
// when they sat down to build. Now each game is watched from 36 hours out:
//   - a PrizePicks-only check of one market every two hours, free while
//     PrizePicks has posted nothing (an empty answer is not billed)
//   - the full read the tick PrizePicks answers: its lines are each leg's
//     first line, the one the record grades, as before
//   - one more full read inside 90 minutes of the start, which updates each
//     leg's line and chance, adds any leg posted since, and takes off the card
//     a leg PrizePicks has taken down
//   - the card shows the line as it stands, and what moved ("PP 10 → 11");
//     Picks of the day lists it at that line and grades it at the line it
//     showed; the record adds how legs did at the pre-tip line
//
// The payloads are the real ones: Celtics @ Pistons as production read it on
// Oct 20 (tests/fixtures/odds-nba-pp-26b036ff-20261020.json) and Mammoth @
// Kraken on Oct 22 (tests/fixtures/odds-nhl-pp-ec5f71ec-20261022.json), with
// that game's players' NHL stats. The check's answer is the same payload cut to
// PrizePicks and the one market asked for, as the feed answers such a call; the
// unposted answer is the event with no bookmakers -- the worker reads only
// whether PrizePicks is in it. The pre-tip payloads are the real ones with the
// moves written in. Grading is from a real box score (Bucks @ Spurs,
// tests/fixtures/espn-nba-box-401810437.json). Real SQLite, the real worker,
// its own cron.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = path.join(BOARD, 'tests', 'fixtures');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const RealDate = Date;
let NOW = 0;
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const iso = (ms) => new RealDate(ms).toISOString();
const H = 3600e3;

const NBA = JSON.parse(fs.readFileSync(path.join(FIX, 'odds-nba-pp-26b036ff-20261020.json'), 'utf8'));
const NHL_REC = JSON.parse(fs.readFileSync(path.join(FIX, 'odds-nhl-pp-ec5f71ec-20261022.json'), 'utf8'));
const NHL = NHL_REC.payload;
const STATS = Object.fromEntries(Object.entries(NHL_REC).filter(([u]) => u.startsWith('https://api.nhle.com/')));
const SCORE = fs.readFileSync(path.join(FIX, 'espn-nba-20260115.json'), 'utf8');
const BOX = fs.readFileSync(path.join(FIX, 'espn-nba-box-401810437.json'), 'utf8');
const PRIORS = fs.readFileSync(path.join(BOARD, 'nba-priors.json'), 'utf8');

const ODDS = 'https://api.the-odds-api.com/v4/sports';
const NBA_READ = `${ODDS}/basketball_nba/events/${NBA.id}/odds?apiKey=k`
  + '&markets=player_threes,player_assists,player_rebounds,player_blocks,player_steals&oddsFormat=american&dateFormat=iso'
  + '&bookmakers=prizepicks,underdog,pick6,draftkings,fanduel,pinnacle,lowvig,betonlineag,novig,prophetx';
const NBA_CHECK = `${ODDS}/basketball_nba/events/${NBA.id}/odds?apiKey=k&markets=player_rebounds&oddsFormat=american&dateFormat=iso&bookmakers=prizepicks`;
const NHL_CHECK = `${ODDS}/icehockey_nhl/events/${NHL.id}/odds?apiKey=k&markets=player_points&oddsFormat=american&dateFormat=iso&bookmakers=prizepicks`;

// PrizePicks' lines moved, as a pre-tip read finds them. `moves`: player ->
// market -> new point, or null for a line taken down; `add`: lines posted since.
function moved(body, moves, add = []) {
  const b = structuredClone(body);
  const pp = b.bookmakers.find((x) => x.key === 'prizepicks');
  for (const m of pp.markets) {
    m.outcomes = m.outcomes.flatMap((o) => {
      const to = moves[o.description] && moves[o.description][m.key];
      if (to === undefined) return [o];
      return to === null ? [] : [{ ...o, point: to }];
    });
  }
  for (const [market, player, point] of add) {
    let m = pp.markets.find((x) => x.key === market);
    if (!m) pp.markets.push(m = { key: market, outcomes: [] });
    m.outcomes.push({ name: 'Over', description: player, price: -137, point }, { name: 'Under', description: player, price: -137, point });
  }
  return b;
}
const unposted = (b) => ({ id: b.id, sport_key: b.sport_key, sport_title: b.sport_title, commence_time: b.commence_time,
  home_team: b.home_team, away_team: b.away_team, bookmakers: [] });
const ppOnly = (b, market) => ({ ...b, bookmakers: b.bookmakers.filter((x) => x.key === 'prizepicks')
  .map((x) => ({ ...x, markets: x.markets.filter((m) => m.key === market) })) });

// What the feed has up for each game right now.
const feed = { [NBA.id]: { posted: false, body: NBA }, [NHL.id]: { posted: false, body: NHL } };
const calls = [];
const finalOn = new Set();
const listed = new Set([NBA.id]);                       // the games the events list has; the NHL one joins in its section
globalThis.fetch = async (u) => {
  const url = String(u);
  const J = (x, h) => new Response(typeof x === 'string' ? x : JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json', ...(h || {}) } });
  const ev = url.startsWith(ODDS) && (url.match(/\/events\/(\w+)\/odds\?/) || [])[1];
  if (ev && feed[ev]) {
    const g = feed[ev], check = /&bookmakers=prizepicks$/.test(url);
    calls.push({ ev, check, url, at: NOW });
    if (!g.posted) return J(unposted(g.body), { 'x-requests-last': '0' });
    if (check) return J(ppOnly(g.body, new URL(url).searchParams.get('markets')), { 'x-requests-last': '1' });
    return J(g.body, { 'x-requests-last': ev === NBA.id ? '5' : '2' });
  }
  // The events list (free), which the watch reads: each game, as it lists them.
  const evl = url.startsWith(ODDS) && (url.match(/\/sports\/(\w+)\/events\?/) || [])[1];
  if (evl) return J([NBA, NHL].filter((x) => x.sport_key === evl && listed.has(x.id)).map(({ bookmakers, ...e }) => e), { 'x-requests-last': '0' });
  if (url.startsWith(ODDS)) return J([], { 'x-requests-last': '0' });
  for (const d of finalOn) if (url === `https://cdn.espn.com/core/nba/scoreboard?xhr=1&date=${d}`) return J(SCORE);
  if (finalOn.size && url === 'https://cdn.espn.com/core/nba/boxscore?xhr=1&gameId=401810437') return J(BOX);
  if (STATS[url]) return J(STATS[url]);
  if (url.startsWith('https://api-web.nhle.com/') || url.startsWith('https://api.nhle.com/')) return J({ games: [], data: [] });
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
const env = { DB, ODDS_API_KEY: 'k', ASSETS: { fetch: async (r) => (new URL(r.url).pathname === '/nba-priors.json'
  ? new Response(PRIORS, { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('{}', { status: 404 })) } };
// The NHL reads were paused on 2026-10-25 (NHL_PP_PAUSED); this tests them as
// they run when switched back on. tests/weekchanges.mjs holds the pause itself.
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n')
  .replace('const NHL_PP_PAUSED = true;', 'const NHL_PP_PAUSED = false;');
if (!src.includes('const NHL_PP_PAUSED = false;')) throw new Error('worker.js has no NHL_PP_PAUSED to lift');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const tick = async () => { const held = []; await mod.default.scheduled({}, env, { waitUntil: (p) => held.push(p) }); await Promise.allSettled(held); };
const hit = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();
const board = (key, g) => sq.prepare('INSERT OR REPLACE INTO feed_cache (key, data, updated_at) VALUES (?, ?, ?)')
  .run(key, JSON.stringify({ asOf: iso(NOW), games: [{ id: g.id, league: 'reg', commence: g.commence_time, home: g.home_team, away: g.away_team }] }), NOW);

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const since = (n) => calls.slice(n);
const say = (l) => l.map((c) => (c.check ? 'check' : 'read')).join(', ') || 'none';

// ---- NBA: watched, then read when PrizePicks posts ------------------------------------------
const TIP = RealDate.parse(NBA.commence_time);              // noon Pacific, Oct 20
console.log('-- Celtics @ Pistons, watched from 36 hours out --');
NOW = TIP - 40 * H;
await tick();                                               // tables made
board('nba_board:reg', NBA);
let n = calls.length;
await tick();
ok(since(n).length === 0, `40 hours out: not watched yet (${say(since(n))})`);

NOW = TIP - 34 * H;                                          // 10 PM Pacific, the night before the night before
n = calls.length;
await tick();
ok(since(n).length === 1 && since(n)[0].url === NBA_CHECK, `34 hours out: one PrizePicks-only check of rebounds (${say(since(n))})`);
ok(sq.prepare('SELECT COUNT(*) AS n FROM nbapp').get().n === 0, 'PrizePicks has nothing up: nothing logged, and the empty answer costs nothing');
n = calls.length;
NOW += H; await tick();
ok(since(n).length === 0, `an hour later: no check, the last was inside two hours (${say(since(n))})`);
NOW += H; n = calls.length; await tick();
ok(since(n).length === 1 && since(n)[0].check, `two hours on: checked again (${say(since(n))})`);

feed[NBA.id].posted = true;                                  // PrizePicks posts the game
NOW = TIP - 30 * H;                                          // 6 AM Pacific, the day before
n = calls.length;
await tick();
ok(say(since(n)) === 'check, read' && since(n)[1].url === NBA_READ,
  `PrizePicks is up: the check sees it and the full read follows in the same tick, as it was always asked for (${say(since(n))})`);
let rows = sq.prepare('SELECT * FROM nbapp WHERE game_id = ?').all(NBA.id);
const row = (p, m) => rows.find((r) => r.player === p && r.market === m) || {};
ok(rows.length === 30 && rows.every((r) => r.close_point == null && r.captured_at === iso(NOW)),
  `the 30 legs production logged from this payload, a day and a half early, each its first line (${rows.length})`);
ok(row('Jalen Duren', 'reb').point === 10 && row('Cade Cunningham', 'ast').point === 9, 'Duren under 10 rebounds, Cunningham under 9 assists');
let b = await hit('/api/nba-pp');
ok(b.legs.length === 30 && b.legs.every((x) => x.first_point === x.point && x.close_at == null),
  `the card has them now, for tomorrow (${b.legs.length}), nothing moved yet`);
NOW += 4 * H; n = calls.length; await tick();
ok(since(n).length === 0, `and nothing more is bought until the pre-tip read (${say(since(n))})`);
// No leg of this game clears Picks' 70% at its first line. One that did, as
// the first read writes it, so Picks has a leg for PrizePicks to take down.
sq.prepare(`INSERT INTO nbapp (date, game_id, player, market, league, commence, home, away, team, point, proj, model_under, n_recent, min_proj, captured_at)
  SELECT date, game_id, 'Ausar Thompson', 'ast', league, commence, home, away, 'DET', 4.5, 2.6, 80, 0, 30, captured_at FROM nbapp WHERE game_id = ? LIMIT 1`).run(NBA.id);

// ---- the pre-tip read ---------------------------------------------------------------------
console.log('\n-- an hour before tip: PrizePicks has moved --');
// Duren's rebounds and Tatum's assists raised, Cunningham's assists lowered,
// White's threes and Thompson's assists taken down, Duren's assists posted since.
feed[NBA.id].body = moved(NBA, { 'Jalen Duren': { player_rebounds: 11 }, 'Cade Cunningham': { player_assists: 8 },
  'Jayson Tatum': { player_assists: 7.5 }, 'Derrick White': { player_threes: null } }, [['player_assists', 'Jalen Duren', 1.5]]);
NOW = TIP - H;
n = calls.length;
await tick();
ok(say(since(n)) === 'read' && since(n)[0].url === NBA_READ, `one full read, no check first (${say(since(n))})`);
rows = sq.prepare('SELECT * FROM nbapp WHERE game_id = ?').all(NBA.id);
const du = row('Jalen Duren', 'reb'), cc = row('Cade Cunningham', 'ast');
ok(du.point === 10 && du.close_point === 11 && du.close_under > du.model_under && du.close_book_line === 10.5 && du.close_at === iso(NOW),
  `Duren keeps his first line, 10, with the pre-tip 11 beside it, at a better chance (${du.model_under}% → ${du.close_under}%) and the book's 10.5`);
ok(cc.point === 9 && cc.close_point === 8 && cc.close_under < cc.model_under, `Cunningham 9 → 8, a harder under (${cc.model_under}% → ${cc.close_under}%)`);
ok(row('Derrick White', 'threes').close_point == null && row('Derrick White', 'reb').close_point === 3.5 && row('Ausar Thompson', 'ast').close_point == null,
  "White's threes and Thompson's assists, taken down, have no pre-tip line; White's rebounds do");
const dua = row('Jalen Duren', 'ast');
ok(dua.point === 1.5 && dua.close_point === 1.5 && rows.length === 32, `Duren's assists, posted since, are logged with the pre-tip line as their first (${rows.length} legs)`);
ok(rows.filter((r) => r.close_point != null && r.close_point === r.point).length === 27, 'the other 26 legs and the new one read the same line again');
b = await hit('/api/nba-pp');
const bl = (p, m) => b.legs.find((x) => x.player === p && x.market === m);
const bdu = bl('Jalen Duren', 'reb');
ok(bdu && bdu.point === 11 && bdu.first_point === 10 && bdu.model_under === du.close_under && bdu.book_line === 10.5 && bdu.vsBook === 0.5,
  `the card shows the line that can be played now: under 11, PP 10 → 11, +0.5 on the book (${bdu && [bdu.point, bdu.first_point, bdu.vsBook].join(', ')})`);
ok(!bl('Derrick White', 'threes') && !bl('Ausar Thompson', 'ast') && bl('Derrick White', 'reb') && b.legs.length === 30,
  `the legs PrizePicks took down are off the card (${b.legs.length} legs)`);
ok(b.legs.every((x, i) => i === 0 || b.legs[i - 1].model_under >= x.model_under), 'best under first, at the current chance');
NOW += 5 * 60e3; n = calls.length; await tick();
ok(since(n).length === 0, `the pre-tip read is taken once (${say(since(n))})`);

// Picks of the day lists the legs at the current line, and not the one taken down.
const picks = await hit('/api/picks');
const np = (picks.legs || []).filter((x) => x.kind === 'nba_pp');
console.log('  ' + np.map((x) => `${x.title} ${x.p}%`).join(' | '));
const cur = (x) => b.legs.find((l) => `${l.player} Under ${l.point} ` === x.title.slice(0, `${l.player} Under ${l.point} `.length));
const ta = np.find((x) => /^Jayson Tatum Under /.test(x.title));
// Since 2026-10-27 the chance shown blends the model's with the sharp books'
// where they priced him (a quarter and three quarters); qualifying is still the
// model's 70%+.
const shown = (l) => (l.sharp_under != null ? Math.round((0.25 * l.model_under + 0.75 * l.sharp_under) * 10) / 10 : l.model_under);
ok(ta && ta.title === 'Jayson Tatum Under 7.5 AST' && ta.modelP === bl('Jayson Tatum', 'ast').model_under && ta.modelP >= 70 && ta.p === shown(bl('Jayson Tatum', 'ast')),
  `Tatum's assists, raised to 7.5, clear the bar and are listed at 7.5 (${ta && ta.title} ${ta && ta.p}%, model ${ta && ta.modelP}%; ${row('Jayson Tatum', 'ast').model_under}% at 5.5)`);
ok(np.length > 0 && np.every((x) => cur(x) && x.modelP === cur(x).model_under && x.p === shown(cur(x)) && x.spec.pp.line === cur(x).point),
  `every NBA leg on Picks is at the line the card shows, its chance the card's blended with the sharp books' (${np.length})`);
ok(!np.some((x) => /^Ausar Thompson/.test(x.title)), 'and the 80% leg PrizePicks took down is not on it');

// ---- the card --------------------------------------------------------------------------------
console.log('\n-- the card --');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
function lift(name) {
  let at = app.indexOf(`function ${name}(`);
  const isConst = at < 0;
  if (isConst) at = app.indexOf(`const ${name} =`);
  if (at < 0) throw new Error(`app.js has no ${name}`);
  let depth = 0;
  for (let i = at; i < app.length; i++) {
    const c = app[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') { depth--; if (!isConst && c === '}' && depth === 0) return app.slice(at, i + 1); }
    else if (isConst && c === ';' && depth === 0 && app[i + 1] === '\n') return app.slice(at, i + 1);
  }
  throw new Error(`could not close ${name}`);
}
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ui = { nbaPp: b, slip: {} };
let C;
try {
  C = new Function('state', 'esc', ['TEAM_COLORS', 'MLB_TEAM_ID', 'NHL_PHOTO_SEASON', 'headshotUrl', 'teamMarkUrl', 'initialsOf', 'avatarHtml',
    'miniBar', 'projLineHtml', 'LEG_OFFERS', 'offerLeg', 'ptDayOf', 'soccerKick', 'AM', 'MARKET_SHORT', 'NBA_ROTATION_MIN', 'NBA_MK', 'nbaPpLeg', 'nbaOversLineHtml', 'ppMovedTag', 'ppCloseLineHtml', 'dfsLinesHtml', 'sharpTag', 'ppBookLine', 'ppGameLineHtml', 'NHL_MK', 'PP_MORE_MIN', 'ppMoreP', 'ppMoreMk', 'ppMoreLeg', 'ppMoreTop', 'ppMoreListHtml', 'ppMoreLineHtml', 'nbaBlkMoreHtml', 'nbaPpCardHtml']
    .map(lift).join('\n') + '\nreturn { ppMovedTag, ppCloseLineHtml, nbaPpCardHtml };')(ui, esc);
} catch (e) { console.log(`  FAIL  the card lifts out of app.js (${e.message})`); process.exit(1); }
const text = (h) => h.replace(/<[^>]+>/g, '').trim();
const tdu = C.ppMovedTag(bdu), tcc = C.ppMovedTag(bl('Cade Cunningham', 'ast'));
ok(text(tdu) === 'PP 10 → 11' && /class="tc-gap"/.test(tdu), `raised: "${text(tdu)}", in the easier colour`);
ok(text(tcc) === 'PP 9 → 8' && /class="tc-gap lower"/.test(tcc), `lowered: "${text(tcc)}", in the caution colour`);
ok(C.ppMovedTag(bl('Jalen Duren', 'ast')) === '' && C.ppMovedTag(bl('Payton Pritchard', 'threes')) === '', 'a line that did not move carries no tag');
const card = C.nbaPpCardHtml();
ok(/<span class="tc-title">PrizePicks unders<\/span>/.test(card) && !/Tonight/.test(card), 'the card is "PrizePicks unders": its legs can be tomorrow\'s');
// The NHL card lists Mores since 2026-10-27 (tests/morelegs.mjs): the moved tag
// and the pre-tip record are the unders', so they stay on the NBA card alone.
ok(/\$\{gap\}\$\{ppMovedTag\(x\)\}/.test(lift('nbaPpCardHtml')) && /ppCloseLineHtml\(r\)/.test(lift('nbaPpCardHtml')),
  'the NBA card draws the tag on each leg and the pre-tip record under the head');
ui.nbaPp = { ...b, legs: [] };
ok(/read as soon as it does/.test(C.nbaPpCardHtml()), 'with nothing posted yet, the card says the lines come as soon as PrizePicks posts them');

// ---- graded, at both lines ---------------------------------------------------------------------
console.log('\n-- graded from the box score, at the first line and the pre-tip one --');
// Bucks @ Spurs on a later night, logged as the two reads leave them. From the
// box score: Wembanyama 10 rebounds, Castle 10 assists, Rollins 7 rebounds,
// Keldon Johnson 8 rebounds, Champagnie 11 rebounds, Giannis 1 assist.
const gl = (player, id, market, point, close) => sq.prepare(
  `INSERT INTO nbapp (date, game_id, player, market, league, commence, home, away, player_id, point, proj, model_under, min_proj, close_point, close_under, close_at)
   VALUES ('2026-10-21', 'evSAMIL', ?, ?, 'reg', '2026-10-22T00:30:00Z', 'San Antonio Spurs', 'Milwaukee Bucks', ?, ?, 1, 60, 30, ?, ?, ?)`)
  .run(player, market, id, point, close, close == null ? null : 62, close == null ? null : '2026-10-21T23:15:00Z');
gl('Victor Wembanyama', '5104157', 'reb', 10.5, 11.5);       // raised
gl('Stephon Castle', '4845367', 'ast', 10.5, 9.5);           // lowered
gl('Ryan Rollins', '4591725', 'reb', 6.5, 6.5);              // kept
gl('Keldon Johnson', '4395723', 'reb', 8.5, null);           // no pre-tip read
gl('Julian Champagnie', '4592479', 'reb', 10.5, 11);         // raised, to a push
gl('Giannis Antetokounmpo', '3032977', 'ast', 5.5, 5.5);     // kept
// Picks of the day showed four of them, each at the line it last showed.
const dp = sq.prepare(`INSERT INTO daypicks (date, leg_id, kind, src_date, game_id, player_key, market, label, p, commence, rank, on_list, seen_at)
  VALUES ('2026-10-21', ?, 'nba_pp', '2026-10-21', 'evSAMIL', ?, ?, ?, 72, '2026-10-22T00:30:00Z', 1, 1, '2026-10-21T23:20:00Z')`);
dp.run('nbapp:evSAMIL:Stephon Castle:ast', 'Stephon Castle', 'ast', 'Stephon Castle Under 9.5 AST');                // after the pre-tip read
dp.run('nbapp:evSAMIL:Julian Champagnie:reb', 'Julian Champagnie', 'reb', 'Julian Champagnie Under 10.5 REB');     // before it
dp.run('nbapp:evSAMIL:Victor Wembanyama:reb', 'Victor Wembanyama', 'reb', 'Victor Wembanyama Under 11.5 REB');
dp.run('nbapp:evSAMIL:Giannis Antetokounmpo:ast', 'Giannis Antetokounmpo', 'ast', 'Giannis Antetokounmpo Under 5.5 AST');
NOW = RealDate.parse('2026-10-22T18:00:00Z');               // the morning after
finalOn.add('20261021');
await tick();
await hit('/api/picks');
const g = (p) => sq.prepare("SELECT result, actual, close_result FROM nbapp WHERE game_id = 'evSAMIL' AND player = ?").get(p) || {};
const want = [['Victor Wembanyama', 'under', 'under'], ['Stephon Castle', 'under', 'over'], ['Ryan Rollins', 'over', 'over'],
  ['Keldon Johnson', 'under', null], ['Julian Champagnie', 'over', 'push'], ['Giannis Antetokounmpo', 'under', 'under']];
ok(want.every(([p, r, c]) => g(p).result === r && g(p).close_result === c),
  `each graded at its first line, and at its pre-tip line where one was read: ${want.map(([p]) => `${p.split(' ').pop()} ${g(p).result}/${g(p).close_result}`).join(', ')}`);
const pr = (id) => (sq.prepare("SELECT result FROM daypicks WHERE leg_id = ?").get(id) || {}).result;
ok(pr('nbapp:evSAMIL:Stephon Castle:ast') === 'miss' && pr('nbapp:evSAMIL:Julian Champagnie:reb') === 'miss'
  && pr('nbapp:evSAMIL:Victor Wembanyama:reb') === 'hit' && pr('nbapp:evSAMIL:Giannis Antetokounmpo:ast') === 'hit',
  `Picks grades each at the line it showed: Castle under 9.5 a miss (his first line, 10.5, landed), Champagnie under 10.5 a miss (not the pre-tip push) (${['Stephon Castle:ast', 'Julian Champagnie:reb', 'Victor Wembanyama:reb', 'Giannis Antetokounmpo:ast'].map((k) => pr('nbapp:evSAMIL:' + k)).join(', ')})`);
const rec = (await hit('/api/nba-pp')).record || {};
console.log('  atClose ' + JSON.stringify(rec.atClose) + '\n  moved ' + JSON.stringify(rec.moved));
ok(rec.atClose && rec.atClose.n === 4 && rec.atClose.hit === 2, 'the record at the pre-tip line: 2 of 4, the push out');
ok(rec.moved && rec.moved.raised.n === 2 && rec.moved.raised.hit === 1 && rec.moved.lowered.n === 1 && rec.moved.lowered.hit === 1
  && rec.moved.kept.n === 2 && rec.moved.kept.hit === 1, 'and the first line\'s under where PrizePicks then raised it (1 of 2), lowered it (1 of 1), kept it (1 of 2)');
ok(rec.graded === 6, `the record itself still grades the first line, every leg (${rec.graded})`);
ok(text(C.ppCloseLineHtml(rec)) === 'At the pre-tip line: 2 of 4 · first line, where PP then raised it: 1 of 2', `the card: "${text(C.ppCloseLineHtml(rec))}"`);
ok(C.ppCloseLineHtml({}) === '' && C.ppCloseLineHtml({ atClose: { n: 0 } }) === '', 'nothing before a pre-tip read has graded');

// ---- NHL: the same, two credits a read ------------------------------------------------------------
console.log('\n-- Mammoth @ Kraken --');
const PUCK = RealDate.parse(NHL.commence_time);             // 7:10 PM Pacific, Oct 22
NOW = PUCK - 20 * H;
listed.add(NHL.id);
// The clock goes back from the NBA grading above: the events lists it kept
// would look fresh for hours, so they go.
sq.prepare("DELETE FROM feed_cache WHERE key LIKE '%_pp_events:%'").run();
board('nhl_board:reg', NHL);
n = calls.length;
await tick();
ok(since(n).length === 1 && since(n)[0].url === NHL_CHECK, `20 hours out: one PrizePicks-only check of points (${say(since(n))})`);
feed[NHL.id].posted = true;
NOW = PUCK - 18 * H;
n = calls.length;
await tick();
ok(say(since(n)) === 'check, read', `posted: checked and read in the same tick (${say(since(n))})`);
let nh = sq.prepare('SELECT * FROM nhlpp WHERE game_id = ?').all(NHL.id);
ok(nh.length === 6 && nh.every((r) => r.point === 0.5 && r.close_point == null), `the six legs production logged, 18 hours early (${nh.map((r) => r.player.split(' ').pop()).join(', ')})`);
feed[NHL.id].body = moved(NHL, { 'Vincent Trocheck': { player_points: 1.5 }, 'Vince Dunn': { player_points: null } });
NOW = PUCK - H;
n = calls.length;
await tick();
ok(say(since(n)) === 'read', `the pre-tip read (${say(since(n))})`);
nh = sq.prepare('SELECT * FROM nhlpp WHERE game_id = ?').all(NHL.id);
const tro = nh.find((r) => r.player === 'Vincent Trocheck') || {};
ok(tro.point === 0.5 && tro.close_point === 1.5 && tro.close_under > tro.model_under, `Trocheck 0.5 → 1.5 points, a far easier under (${tro.model_under}% → ${tro.close_under}%)`);
const nb = await hit('/api/nhl-pp');
const btro = nb.legs.find((x) => x.player === 'Vincent Trocheck');
ok(btro && btro.point === 1.5 && btro.first_point === 0.5 && !nb.legs.some((x) => x.player === 'Vince Dunn') && nb.legs.length === 5,
  `the card: Trocheck at 1.5 with the move beside it, Dunn's line taken down and off (${nb.legs.length} legs)`);
const nhlCalls = calls.filter((c) => c.ev === NHL.id);
ok(nhlCalls.filter((c) => !c.check).length === 2 && nhlCalls.filter((c) => c.check).length === 2,
  `in all: two checks (the first free) and two reads, about 5 credits for the game (${say(nhlCalls)})`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
