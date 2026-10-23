// Pre-start reads, and how far a Picks leg moved (2026-10-22).
//
// The moneyline boards were read twice a day: once a game was inside 36 hours,
// and once inside 3 hours of the FIRST tip. On a night of 4:00 and 7:00 starts
// the 7:00 game's price was read at about 1 PM, and a scratch at 3 PM moved
// the line without the board knowing. Now each start time gets a read about
// 75 minutes out and another about 25 minutes out -- the close -- found from
// what the last read already holds, so finding them costs nothing:
//   - NBA and NHL: the board's own snapshot has every game's tip.
//   - Soccer and the NFL: the free events list's kickoff times, kept with the
//     day's capture counter. The NFL's pre-start read is its game lines only,
//     never the props, which are priced per game.
// And the Picks list keeps each leg's first chance beside its latest, so a leg
// says how far it has moved since it joined the list, and "How the list did"
// says which way the market went before each start.
//
// Thursday 2026-10-22's real start times: NHL 4:00 and 7:00 PM Pacific, NBA
// Cavaliers @ 76ers 4:00 and Nuggets @ Thunder 6:30, the Europa League at 9:45
// AM and noon, Patriots @ Bears at 5:15. The odds payloads are the v4 shape the
// boards have parsed in production since October (the key exists only as a
// Worker secret, as tests/nhl.mjs explains), with the books those boards use.
// Real SQLite and the real worker, driven through its own cron.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const RealDate = Date;
let NOW = RealDate.parse('2026-10-22T09:00:00Z');        // Thursday 2 AM Pacific
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const Z = (s) => RealDate.parse(s);

const TITLES = { lowvig: 'LowVig.ag', betonlineag: 'BetOnline.ag', novig: 'Novig', prophetx: 'ProphetX', pinnacle: 'Pinnacle',
  draftkings: 'DraftKings', fanduel: 'FanDuel', betmgm: 'BetMGM', betrivers: 'BetRivers', williamhill_us: 'Caesars' };
const book = (key, home, away, hp, ap) => ({ key, title: TITLES[key], last_update: new RealDate(NOW).toISOString(),
  markets: [{ key: 'h2h', last_update: new RealDate(NOW).toISOString(), outcomes: [{ name: away, price: ap }, { name: home, price: hp }] }] });
const game = (sport, id, commence, home, away, quotes) => ({ id, sport_key: sport, commence_time: commence, home_team: home, away_team: away,
  bookmakers: Object.entries(quotes).map(([k, [h, a]]) => book(k, home, away, h, a)) });
const sharpAndExec = (h, a) => ({ lowvig: [h, a], betonlineag: [h, a], novig: [h, a], prophetx: [h, a], draftkings: [h - 5, a - 5], fanduel: [h - 3, a - 5] });

const NHL_4 = '2026-10-22T23:00:00Z', NHL_7 = '2026-10-23T02:00:00Z';
const NBA_4 = '2026-10-22T23:00:00Z', NBA_630 = '2026-10-23T01:30:00Z';
const UEL_945 = '2026-10-22T16:45:00Z', UEL_12 = '2026-10-22T19:00:00Z';
const TNF = '2026-10-23T00:15:00Z';
// The 76ers' price firms through the day: about 66% at 2 AM, 72% by the evening.
let phi = [-220, 184];
const feeds = {
  icehockey_nhl: () => [game('icehockey_nhl', 'h1', NHL_4, 'Boston Bruins', 'Nashville Predators', sharpAndExec(-150, 128)),
    game('icehockey_nhl', 'h2', NHL_7, 'Vancouver Canucks', 'Detroit Red Wings', sharpAndExec(-120, 102))],
  basketball_nba: () => [game('basketball_nba', 'b1', NBA_4, 'Philadelphia 76ers', 'Cleveland Cavaliers', sharpAndExec(...phi)),
    game('basketball_nba', 'b2', NBA_630, 'Oklahoma City Thunder', 'Denver Nuggets', sharpAndExec(-250, 205))],
  soccer_uefa_europa_league: () => [{ id: 'u1', sport_key: 'soccer_uefa_europa_league', commence_time: UEL_945, home_team: 'OFI Crete', away_team: 'Bayer Leverkusen', bookmakers: [] },
    { id: 'u2', sport_key: 'soccer_uefa_europa_league', commence_time: UEL_12, home_team: 'Omonoia FC', away_team: 'Benfica', bookmakers: [] }],
  americanfootball_nfl: () => [{ id: 'n1', sport_key: 'americanfootball_nfl', commence_time: TNF, home_team: 'Chicago Bears', away_team: 'New England Patriots', bookmakers: [] }],
};
let calls = [];
globalThis.fetch = async (u) => {
  const url = String(u);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json', 'x-requests-remaining': '92000', 'x-requests-last': '1' } });
  if (url.includes('api.the-odds-api.com')) {
    calls.push({ at: NOW, url });
    const m = new URL(url).pathname.match(/^\/v4\/sports\/([a-z_]+)\/(odds|events)$/);
    const f = m && feeds[m[1]];
    if (!f) return J([]);
    const evs = f().filter((e) => Z(e.commence_time) > NOW);
    return m[2] === 'events' ? J(evs.map(({ bookmakers, ...e }) => e)) : J(evs);
  }
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
const env = { ODDS_API_KEY: 'k', DB };
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const tick = async () => { const held = []; await mod.default.scheduled({}, env, { waitUntil: (p) => held.push(p) }); await Promise.allSettled(held); };
const hit = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const paid = (sport) => calls.filter((c) => c.url.includes(`/sports/${sport}/odds`)).map((c) => new RealDate(c.at).toISOString().slice(11, 16));
// Every five minutes from 2 AM to 8 PM Pacific, as the cron runs.
await hit('/api/gmpicks-export');
const pt = (iso) => new RealDate(Z(iso) - 7 * 3600e3).toISOString().slice(11, 16);
let picksEarly = null, picksLate = null;
for (let t = Z('2026-10-22T09:00:00Z'); t <= Z('2026-10-23T03:00:00Z'); t += 5 * 60e3) {
  NOW = t;
  if (t === Z('2026-10-22T18:00:00Z')) phi = [-240, 200];        // late morning
  if (t === Z('2026-10-22T21:30:00Z')) phi = [-290, 240];        // news at 2:30 PM
  await tick();
  if (t === Z('2026-10-22T09:30:00Z')) picksEarly = await hit('/api/picks');
  if (t === Z('2026-10-22T22:40:00Z')) picksLate = await hit('/api/picks');
}

console.log('-- NHL: two daily reads, then two before each start --');
const nhl = paid('icehockey_nhl');
console.log(`  paid reads (UTC): ${nhl.join(' ')}`);
const inWin = (list, start, w) => list.some((x) => { const at = Z(`${x > '12' ? '2026-10-22' : '2026-10-23'}T${x}:00Z`); return at >= Z(start) - w * 60e3 && at < Z(start); });
ok(nhl.length === 6, `six paid reads, a credit each: the two daily ones and four before the two starts (${nhl.length})`);
ok(inWin(nhl, NHL_4, 75) && inWin(nhl, NHL_4, 25) && inWin(nhl, NHL_7, 75) && inWin(nhl, NHL_7, 25),
  `inside 75 and inside 25 minutes of the ${pt(NHL_4)} and ${pt(NHL_7)} starts`);
// (The PrizePicks watch reads the free events list every two hours whatever
// the hour: that is how it finds tomorrow's games.)
ok(!calls.some((c) => c.url.includes('icehockey_nhl') && !/\/events\?/.test(c.url) && c.at >= Z(NHL_7)), 'and nothing but the free events list after the last start');

console.log('\n-- NBA: the same, and the close is the last read --');
const nba = paid('basketball_nba');
console.log(`  paid reads (UTC): ${nba.join(' ')}`);
ok(nba.length === 6 && inWin(nba, NBA_630, 25), `six reads, the last inside 25 minutes of the ${pt(NBA_630)} tip (${nba.length})`);
const b1 = sq.prepare("SELECT entry_win_prob, win_prob, close_at FROM gmpicks WHERE sport = 'nba' AND game_id = 'b1'").get();
ok(b1 && b1.entry_win_prob < 67 && b1.win_prob > 72 && Z(b1.close_at) >= Z(NBA_4) - 25 * 60e3,
  `the 76ers' row keeps its first read (${b1 && b1.entry_win_prob}%) and closes at the last one before tip (${b1 && b1.win_prob}%, ${b1 && b1.close_at})`);

console.log('\n-- soccer and the NFL --');
const uel = paid('soccer_uefa_europa_league');
console.log(`  Europa League paid reads (UTC): ${uel.join(' ')}`);
ok(inWin(uel, UEL_945, 75) && inWin(uel, UEL_945, 25) && inWin(uel, UEL_12, 75) && inWin(uel, UEL_12, 25),
  'the Europa League is read before both kickoffs, from the kickoff times its events read kept');
const nflOdds = paid('americanfootball_nfl');
const nflProps = calls.filter((c) => /americanfootball_nfl\/events\/[^/]+\/odds/.test(c.url));
const preProps = nflProps.filter((c) => c.at >= Z(TNF) - 75 * 60e3);
console.log(`  NFL game-line reads (UTC): ${nflOdds.join(' ')}; props reads ${nflProps.length}`);
ok(inWin(nflOdds, TNF, 75) && inWin(nflOdds, TNF, 25) && preProps.length === 0,
  'Thursday Night Football\'s game lines are read before kickoff, and its props are not');
const route = (r) => { try { return sq.prepare('SELECT SUM(credits) AS c, SUM(calls) AS n FROM odds_route WHERE route LIKE ?').get(r) || {}; } catch (e) { return {}; } };
console.log(`  ledger: nhl ${JSON.stringify(route('nhl:%'))}, nba ${JSON.stringify(route('nba:%'))}, uel ${JSON.stringify(route('soccer:uel%'))}`);

console.log('\n-- a Picks leg says how far it moved --');
const legE = picksEarly && (picksEarly.legs || []).find((x) => /76ers/.test(x.title));
const legL = picksLate && (picksLate.legs || []).find((x) => /76ers/.test(x.title));
ok(legE && legE.firstP === legE.p, `when it joins the list its first chance is its chance (${legE && legE.p}%)`);
ok(legL && legL.firstP === legE.p && legL.p > legE.p + 4 && Z(legL.firstAt) <= Z('2026-10-22T09:30:00Z'),
  `twenty minutes before tip it carries both: ${legL && legL.firstP}% at ${legL && legL.firstAt}, ${legL && legL.p}% now`);
const dp = sq.prepare("SELECT first_p, p, on_list FROM daypicks WHERE label LIKE '%76ers%'").get();
ok(dp && dp.first_p === legE.p && dp.p === legL.p, 'and the list\'s own log keeps the first beside the last');
// The cron fires at the top of the minute: a read at 4:00:00.000 sees a game
// that starts at 4:00, and must not take it for one still to come and mark it
// off the list (as text, "T23:00:00Z" sorts after "T23:00:00.000Z").
const thu = sq.prepare("SELECT on_list FROM daypicks WHERE label LIKE '%Thunder%'").get();
ok(dp && dp.on_list === 1 && thu && thu.on_list === 1, 'a leg is still on the list after a read at the very second its game starts');

// After the games: graded, the history says which way the legs moved and how they landed.
sq.exec("UPDATE gmpicks SET result = 'win' WHERE sport = 'nba'");
NOW = Z('2026-10-23T08:00:00Z');
await hit('/api/picks');
sq.exec("UPDATE daypicks SET result = 'hit' WHERE label LIKE '%76ers%' OR label LIKE '%Thunder%'");
const rec = (await hit('/api/picks')).record;
const mv = rec && rec.history && rec.history.moved;
console.log(`  moved: ${JSON.stringify(mv)}`);
ok(mv && mv.rose.n >= 1 && mv.rose.hit >= 1 && mv.n >= mv.rose.n, 'the history counts the legs whose chance rose before their start, and how they landed');
const day = rec.history.days.find((x) => x.date === '2026-10-22');
const l76 = day && day.legs.find((x) => /76ers/.test(x.label));
ok(l76 && l76.first === legE.p && l76.p === legL.p, 'and each day\'s legs carry their first chance beside the last');

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
const soccerKick = (iso) => (iso ? new RealDate(Z(iso) - 7 * 3600e3).toISOString().slice(11, 16) : '');
let C;
try {
  C = new Function('esc', 'soccerKick', ['shortDay', 'pct0', 'pickMoved', 'HIST_DAY_KEYS', 'movedLineHtml', 'pickHistoryHtml'].map(lift).join('\n')
    + '\nreturn { pickMoved, movedLineHtml, pickHistoryHtml };')(esc, soccerKick);
} catch (e) { console.log(`  FAIL  the card's functions lift out of app.js (${e.message})`); process.exit(1); }
const m = C.pickMoved(legL);
ok(m && m.d > 4 && m.text === `▲ ${m.d} since ${soccerKick(legL.firstAt)}`, `a leg that firmed says so: "${m && m.text}"`);
ok(C.pickMoved({ ...legL, p: legL.firstP + 0.4 }) === null && C.pickMoved({ p: 70 }) === null, 'under a point, or with no first chance, it says nothing');
ok(/▼ 3 since/.test(C.pickMoved({ p: 70, firstP: 73, firstAt: '2026-10-22T16:00:00Z' }).text), 'and one that drifted says that');
ok(/Before their start: \d+ of \d+ legs' chances rose/.test(C.movedLineHtml(mv)) && /those that rose landed \d+ of \d+/.test(C.movedLineHtml(mv)),
  'the history card says which way the legs moved and how those landed');
ok(/class="pk-lm pk-up"[^>]*>▲\d+/.test(C.pickHistoryHtml(rec.history)), 'and marks each day\'s leg that firmed');
ok(/const mv = pickMoved\(x\);\s*if \(mv\) notes\.push\(mv\.text\);/.test(app) && /const mv = pickMoved\(x\);\s*if \(mv\) tags\.push\(/.test(app),
  'the top card and the list rows both carry it');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
