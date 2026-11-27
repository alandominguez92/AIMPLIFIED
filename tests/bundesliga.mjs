// The Bundesliga in for the Europa League (2026-11-27, the owner's call).
//
// The Europa League's two-book rule priced a handful of its fixtures a matchday, so the soccer tab
// showed a few of its clubs and not the rest. From Nov 27 (Pacific) the Bundesliga is read in its
// place. What has to hold:
//   - the captures: the Bundesliga's events list and odds, on the reads every league gets (two a
//     day while a fixture is inside 36 hours, one 75 and one 25 minutes before each kickoff time),
//     and nothing at all for the Europa League; before Nov 27 the other way round
//   - the board names the Bundesliga among its leagues and not the Europa League, and leaves off
//     what a Europa League read stored before: no read will move those prices again
//   - a Bundesliga game grades from ESPN's ger.1 scoreboard: without the slug the grader asks the
//     Premier League's and never finds it. The Europa League's logged games still grade from
//     uefa.europa (tests/socuel.mjs)
//   - ESPN's "FC Cologne" is Köln as a German feed spells it
//
// Real data: ESPN's cdn scoreboards (tests/fixtures/espn-ger1-20261127.json): the Bundesliga's
// Nov 20-22 finals and this weekend's fixtures (Nov 27-29, nine games at six kickoff times), and
// the Europa League's Nov 26 and Dec 10 matchdays. The odds payloads are the v4 shape the boards
// have parsed in production, as tests/prestart.mjs builds them (the key is only a Worker secret),
// with ESPN's fixtures and no prices: what is asked, and when, is the point. Real SQLite and the
// real worker, driven through its own cron every five minutes as production's is.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const RealDate = Date;
let NOW = RealDate.parse('2026-11-23T15:00:00Z');
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
const Z = (s) => RealDate.parse(s);

const REC = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'espn-ger1-20261127.json'), 'utf8'));
const CDN = (lg, d) => `https://cdn.espn.com/core/soccer/scoreboard?xhr=1&league=${lg}&date=${d}`;
const evsOf = (lg, ...days) => days.flatMap((d) => REC[CDN(lg, d)].content.sbData.events);
// ESPN's fixtures as the odds feed lists them.
const feedOf = (sport, evs) => evs.map((e) => {
  const team = (s) => e.competitions[0].competitors.find((c) => c.homeAway === s).team.displayName;
  return { id: `${sport}-${e.id}`, sport_key: sport, commence_time: new RealDate(Z(e.date)).toISOString().replace('.000', ''), home_team: team('home'), away_team: team('away'), bookmakers: [] };
});
const BUND = feedOf('soccer_germany_bundesliga', evsOf('ger.1', '20261127', '20261128', '20261129'));
const UEL = feedOf('soccer_uefa_europa_league', evsOf('uefa.europa', '20261126', '20261210'));
const FEEDS = { soccer_germany_bundesliga: BUND, soccer_uefa_europa_league: UEL };

const calls = [], fetchedEspn = [];
globalThis.fetch = async (u) => {
  const url = String(u);
  const J = (x, last = '0') => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json', 'x-requests-remaining': '48000', 'x-requests-last': last } });
  if (url.includes('api.the-odds-api.com')) {
    calls.push({ at: NOW, url });
    const m = new URL(url).pathname.match(/^\/v4\/sports\/([a-z_]+)\/(odds|events)$/);
    const f = m && FEEDS[m[1]];
    if (!f) return J([]);
    const evs = f.filter((e) => Z(e.commence_time) > NOW);
    // A soccer odds read is two credits (h2h and totals at five books); the events list is free.
    return m[2] === 'events' ? J(evs.map(({ bookmakers, ...e }) => e)) : J(evs, '2');
  }
  if (url.includes('cdn.espn.com/core/soccer/scoreboard')) { fetchedEspn.push(url); return J(REC[url] || { content: { sbData: { events: [] } } }); }
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
const env = { ODDS_API_KEY: 'k', DB };
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const tick = async () => { const held = []; await mod.default.scheduled({}, env, { waitUntil: (p) => held.push(p) }); await Promise.allSettled(held); };
const hit = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();
const run = async (from, to) => { for (let t = Z(from); t < Z(to); t += 5 * 60e3) { NOW = t; await tick(); } };

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const asked = (sport, kind, from, to) => calls.filter((c) => c.url.includes(`/sports/${sport}/${kind}`) && c.at >= Z(from) && c.at < Z(to));
const hhmm = (l) => l.map((c) => new RealDate(c.at).toISOString().slice(11, 16)).join(' ');
const before = (l, kick, mins) => l.some((c) => c.at >= Z(kick) - mins * 60e3 && c.at < Z(kick));

// ---- grading: last weekend's finals -------------------------------------------------------------
console.log('-- a Bundesliga game grades from ESPN\'s ger.1 scoreboard --');
await hit('/api/gmpicks-export?sport=soccer');                      // the table
const fav = (date, home, away, side, pick, commence, id) => ({ sport: 'soccer', date, market: 'fav', league: 'bundesliga', week: null, commence, away, home, side, point: null, pick,
  win_prob: 70, implied: 68, edge: 2, entry_price: -200, close_price: -200, book: 'draftkings', fair_src: 'sharp-pool', sharp_n: 3, game_id: id, model_ver: 'gm-v1' });
const rows = [
  // Leverkusen 4-0 Paderborn and Leipzig's 5-1 at Union Berlin, Saturday Nov 21.
  fav('2026-11-21', 'Bayer Leverkusen', 'SC Paderborn 07', 'home', 'Bayer Leverkusen', '2026-11-21T14:30:00Z', 'bund-b04-pad'),
  fav('2026-11-21', '1. FC Union Berlin', 'RB Leipzig', 'away', 'RB Leipzig', '2026-11-21T14:30:00Z', 'bund-fcu-rbl'),
  // Bayern 1-1 Köln, Friday Nov 20: ESPN's "FC Cologne", the German feed's "1. FC Köln".
  fav('2026-11-20', 'Bayern Munich', '1. FC Köln', 'home', 'Bayern Munich', '2026-11-20T19:30:00Z', 'bund-fcb-koe'),
];
for (const row of rows) { const cols = Object.keys(row); sq.prepare(`INSERT INTO gmpicks (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((k) => norm(row[k]))); }
await hit('/api/track-record');
const g = (id) => sq.prepare('SELECT result, home_score, away_score FROM gmpicks WHERE game_id = ?').get(id) || {};
ok(['20261120', '20261121'].every((d) => fetchedEspn.some((u) => u === CDN('ger.1', d))) && !fetchedEspn.some((u) => u.includes('league=eng.1')),
  'the grader asks ESPN\'s ger.1 scoreboard for each day, and not the Premier League\'s');
ok(g('bund-b04-pad').result === 'win' && g('bund-b04-pad').home_score === 4 && g('bund-b04-pad').away_score === 0, `Leverkusen 4-0 Paderborn: a win (${JSON.stringify(g('bund-b04-pad'))})`);
ok(g('bund-fcu-rbl').result === 'win' && g('bund-fcu-rbl').home_score === 1 && g('bund-fcu-rbl').away_score === 5, `Leipzig 5-1 at Union Berlin: a win (${JSON.stringify(g('bund-fcu-rbl'))})`);
ok(g('bund-fcb-koe').result === 'loss' && g('bund-fcb-koe').home_score === 1 && g('bund-fcb-koe').away_score === 1, `Bayern 1-1 Köln, found as ESPN's FC Cologne: the favourite's draw is a loss (${JSON.stringify(g('bund-fcb-koe'))})`);

// ---- Thursday Nov 26: the Europa League's last matchday read --------------------------------------
console.log('\n-- Thursday Nov 26 (Pacific): the Europa League, as before --');
// What a read stores for a fixture weeks out, if the books have posted it: Besiktas at Leverkusen,
// Dec 10 (ESPN's fixture; DraftKings' prices are stand-ins).
NOW = Z('2026-11-26T08:00:00Z');
await hit('/api/soccer-board?all=1');                                // the table
const ins = sq.prepare('INSERT INTO soccer_lines (league,event_id,commence,home,away,market,selection,point,book,price,link,captured_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
const lev = UEL.find((e) => e.home_team === 'Bayer Leverkusen');
for (const [sel, price] of [[lev.home_team, -250], ['Draw', 380], [lev.away_team, 600]]) ins.run('uel', lev.id, lev.commence_time, lev.home_team, lev.away_team, 'h2h', sel, null, 'draftkings', price, null, '2026-11-26T08:00:00.000Z');
await run('2026-11-26T08:00:00Z', '2026-11-27T08:00:00Z');
const uel26 = asked('soccer_uefa_europa_league', 'odds', '2026-11-26T08:00:00Z', '2026-11-27T08:00:00Z');
const uelKicks = [...new Set(evsOf('uefa.europa', '20261126').map((e) => e.date))].map((d) => new RealDate(Z(d)).toISOString());
console.log(`  Europa League reads (UTC): ${hhmm(uel26)}; kickoffs ${uelKicks.map((k) => k.slice(11, 16)).join(', ')}`);
ok(uel26.length === 6 && uelKicks.every((k) => before(uel26, k, 75) && before(uel26, k, 25)),
  'six reads, as production made that day (12 credits): two in the morning and two before each of its kickoff times');
ok(!calls.some((c) => c.url.includes('soccer_germany_bundesliga')), 'the Bundesliga not asked at all, its events list included');
NOW = Z('2026-11-26T23:00:00Z');
let b = await hit('/api/soccer-board?all=1');
ok(b.leagueList.some((l) => l.key === 'uel') && !b.leagueList.some((l) => l.key === 'bundesliga') && b.games.some((x) => x.id === lev.id),
  `the board: the Europa League among its leagues, Besiktas at Leverkusen on it (${b.leagueList.map((l) => l.key).join(', ')})`);

// ---- Friday Nov 27 to Sunday Nov 29: the Bundesliga -------------------------------------------------
console.log('\n-- Nov 27 to 29 (Pacific): the Bundesliga in its place --');
await run('2026-11-27T08:00:00Z', '2026-11-30T08:00:00Z');
const from = '2026-11-27T08:00:00Z', to = '2026-11-30T08:00:00Z';
ok(!calls.some((c) => c.url.includes('soccer_uefa_europa_league') && c.at >= Z(from)), 'from midnight Nov 27 the Europa League is not asked at all: no odds, no events list');
const kicks = [...new Set(BUND.map((e) => e.commence_time))].sort();
const days = [['Friday', '2026-11-27T08:00:00Z', '2026-11-28T08:00:00Z'], ['Saturday', '2026-11-28T08:00:00Z', '2026-11-29T08:00:00Z'], ['Sunday', '2026-11-29T08:00:00Z', '2026-11-30T08:00:00Z']];
const per = days.map(([name, a, z]) => {
  const l = asked('soccer_germany_bundesliga', 'odds', a, z), k = kicks.filter((t) => Z(t) >= Z(a) && Z(t) < Z(z));
  console.log(`  ${name}: ${l.length} reads (UTC ${hhmm(l)}), kickoffs ${k.map((t) => t.slice(11, 16)).join(', ')}`);
  return { l, k };
});
ok(kicks.length === 6 && per.every(({ l, k }) => l.length === 2 + 2 * k.length && k.every((t) => before(l, t, 75) && before(l, t, 25))),
  'each day two reads, and one inside 75 and one inside 25 minutes of each kickoff time: 4, 6 and 8');
ok(asked('soccer_germany_bundesliga', 'events', from, to).length > 0 && asked('soccer_germany_bundesliga', 'odds', '2026-11-30T08:00:00Z', '2026-12-01T08:00:00Z').length === 0,
  'its kickoff times from the free events list');
const ledger = sq.prepare("SELECT SUM(credits) AS c, SUM(calls) AS n FROM odds_route WHERE route LIKE 'soccer:bundesliga%'").get() || {};
ok(ledger.c === 36, `the weekend's reads cost ${ledger.c} credits (${ledger.n} calls, the events lists free)`);
NOW = Z('2026-11-27T18:00:00Z');
b = await hit('/api/soccer-board?all=1');
ok(b.leagueList.some((l) => l.key === 'bundesliga' && l.label === 'Bundesliga' && l.country === 'Germany') && !b.leagueList.some((l) => l.key === 'uel'),
  `the board: the Bundesliga among its leagues, the Europa League not (${b.leagueList.map((l) => l.key).join(', ')})`);
ok(!b.games.some((x) => x.league === 'uel'), 'and Besiktas at Leverkusen, from a read no longer made, is off it');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
