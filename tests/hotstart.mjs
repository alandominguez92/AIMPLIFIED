// Hot players: when the game is (2026-11-13, the owner's "do all three").
//
// Two things the page check found on the Hot cards:
//   - the NFL card named next week's game by its weekday alone. The Bears have no game this week,
//     so Luther Burden III read "v Saints · Sun 10:00 AM", for Nov 22, while the Saints play the
//     Panthers this Sunday. A game six or more days out now carries its date.
//   - the NBA and NHL cards took the time from ESPN and the NHL's schedule, which list the hour
//     (Rangers @ Canucks 6:00 PM), while the odds feed and the tables beside the card have the
//     puck drop (6:10). Where the feed has the game, the card shows its time, as the props cards
//     have since Nov 6. Which games are still to come still goes by the list's own time.
//
// Real data, all from production at about 12:10 AM Pacific on Nov 13: /api/hot-players?sport=nfl
// and ?sport=nhl (tests/fixtures/hot-nfl-20261113.json, hot-nhl-20261113.json), and the NHL board
// (nhl-board-20261113.json), whose games are the odds feed's events, kept here as the worker keeps
// that list (the shape of tests/fixtures/odds-nhl-events-20261023.json). The NBA's is in
// tests/nbahotlist.mjs, on its real January events list.
process.env.TZ = 'America/Los_Angeles';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = path.join(BOARD, 'tests', 'fixtures');
const read = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const NFL = read('hot-nfl-20261113.json').hot, NHL = read('hot-nhl-20261113.json').hot, NHL_BOARD = read('nhl-board-20261113.json');
const SHAPE = read('odds-nhl-events-20261023.json');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const RealDate = Date;
let NOW = RealDate.parse('2026-11-13T08:10:00Z');
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// ---- the date ----------------------------------------------------------------------------------
console.log('-- the NFL card, early Friday --');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const kickSrc = (app.match(/\n  (const soccerKick = \(iso\) => \{[\s\S]*?\n  \};)/) || [])[1];
const soccerKick = new Function(`${kickSrc}\nreturn soccerKick;`)();
const who = (name) => NFL.players.find((p) => p.name === name);
const burden = who('Luther Burden III'), vele = who('Devaughn Vele'), daniels = who('Jayden Daniels'), harris = who("Tre' Harris");
ok(burden.commence === '2026-11-22T18:00Z' && burden.oppNick === 'Saints' && vele.oppNick === 'Panthers' && vele.commence === '2026-11-15T18:00Z',
  'the real list: Burden v the Saints on Nov 22, Vele and the Saints v the Panthers this Sunday');
ok(soccerKick(burden.commence) === 'Sun, Nov 22, 10:00 AM', `Burden's game nine days out carries its date: "${soccerKick(burden.commence)}"`);
ok(soccerKick(vele.commence) === 'Sun 10:00 AM', `this Sunday's stays a weekday: "${soccerKick(vele.commence)}"`);
ok(soccerKick(daniels.commence) === 'Mon, Nov 23, 5:15 PM' && soccerKick(harris.commence) === 'Mon 5:15 PM',
  `Monday nights: Daniels' after the bye dated ("${soccerKick(daniels.commence)}"), this Monday's not ("${soccerKick(harris.commence)}")`);
ok(soccerKick('2026-11-19T01:15:00Z') === 'Wed 5:15 PM' && soccerKick('2026-11-20T01:15:00Z') === 'Thu, Nov 19, 5:15 PM',
  'five days out a weekday, six a date');
ok(soccerKick('2026-10-23T02:00:00Z') === 'Thu 7:00 PM', 'a past game as before: the recorded fixtures read as they did');

const sect = app.slice(app.indexOf('  // ---- Hot players'), app.indexOf('  function renderNba('));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const card = new Function('state', 'esc', 'nbaNick', 'sharpTag', 'avatarHtml', 'soccerKick', 'nbaCardInjTag', `${sect}\nreturn hotCardHtml;`)(
  { hot: { nfl: NFL }, hotAll: { nfl: true } }, esc, (n) => n, () => '', () => '', soccerKick, () => '');
const nflCard = text(card('nfl'));
ok(/Luther Burden III CHI · v Saints · Sun, Nov 22, 10:00 AM/.test(nflCard) && /Devaughn Vele NO · v Panthers · Sun 10:00 AM/.test(nflCard),
  'on the card: "v Saints · Sun, Nov 22, 10:00 AM" and "v Panthers · Sun 10:00 AM"');

// ---- the feed's start --------------------------------------------------------------------------
console.log('\n-- the NHL card: the feed\'s puck drop --');
let S = null;
function scene() {
  const sq = new DatabaseSync(':memory:');
  sq.exec('CREATE TABLE feed_cache (key TEXT PRIMARY KEY, data TEXT, updated_at INTEGER, claimed_until INTEGER)');
  const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
  const exec = (sql, args, mode) => { const st = sq.prepare(sql); const a = args.map(norm);
    if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
    if (/^\s*(SELECT|WITH)/i.test(sql)) return { results: st.all(...a), meta: {} };
    return { success: true, meta: { changes: Number(st.run(...a).changes) } }; };
  const DB = { prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
    all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
    run: async () => exec(s.sql, s.args, 'run') }; return s; }, batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')) };
  // The list as the cron keeps it (`hot_list_v2:nhl`), from what the route served.
  const list = { builtAt: NOW, teamsReady: NHL.teamsReady, teamsNeeded: NHL.teamsNeeded, ranksFrom: NHL.gamesNeeded, players: NHL.players };
  sq.prepare("INSERT INTO feed_cache (key, data, updated_at) VALUES ('hot_list_v2:nhl', ?, ?)").run(JSON.stringify(list), NOW);
  return { sq, env: { DB } };
}
const keep = (events) => S.sq.prepare("INSERT OR REPLACE INTO feed_cache (key, data, updated_at) VALUES ('nhl_pp_events:reg', ?, ?)").run(JSON.stringify({ at: new RealDate(NOW).toISOString(), events }), NOW);
const feedEvents = NHL_BOARD.games.map((g) => ({ ...Object.fromEntries(Object.keys(SHAPE.events[0]).map((k) => [k, SHAPE.events[0][k]])), id: g.id, commence_time: g.commence, home_team: g.home, away_team: g.away }));
globalThis.fetch = async () => new Response('{}', { status: 404 });
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), S.env, { waitUntil: () => {} })).json();
const startOf = (hot) => Object.fromEntries(hot.players.map((p) => [p.name, p.commence]));

S = scene();
ok(NHL.players.filter((p) => p.commence === '2026-11-14T02:00:00Z').length === 4 && NHL_BOARD.games.some((g) => g.away === 'New York Rangers' && g.home === 'Vancouver Canucks' && g.commence === '2026-11-14T02:10:00Z'),
  "the real pair: the NHL's schedule has Rangers @ Canucks at 6:00 PM, the odds feed at 6:10");
let hot = (await get('/api/hot-players?sport=nhl')).hot;
ok(startOf(hot)['J.T. Miller'] === '2026-11-14T02:00:00Z', 'no events list kept yet: the schedule\'s time, as before');
keep(feedEvents);
hot = (await get('/api/hot-players?sport=nhl')).hot;
console.log('  ' + hot.players.map((p) => `${p.name} ${p.isHome ? 'v' : '@'} ${p.oppNick} ${p.commence}`).join(' | '));
ok(['J.T. Miller', 'Tye Kartye', 'Brock Boeser', 'Jonathan Lekkerimaki'].every((n) => startOf(hot)[n] === '2026-11-14T02:10:00Z'),
  'Rangers @ Canucks, both teams\' players: 6:10, the feed\'s');
ok(['Nick Perbix', 'Tomas Hertl'].every((n) => startOf(hot)[n] === '2026-11-14T03:10:00Z'), 'Predators @ Golden Knights: 7:10');
ok(hot.players.length === NHL.players.length && hot.players.every((p, i) => p.name === NHL.players[i].name && JSON.stringify(p.markets) === JSON.stringify(NHL.players[i].markets)),
  'the same players, in the same order, with the same runs: only the time moved');
keep(feedEvents.map((e) => ({ ...e, commence_time: new RealDate(RealDate.parse(e.commence_time) + 864e5).toISOString().replace('.000', '') })));
ok(startOf((await get('/api/hot-players?sport=nhl')).hot)['J.T. Miller'] === '2026-11-14T02:00:00Z', 'the same teams a day later are another game: the schedule\'s time stands');
NOW = RealDate.parse('2026-11-14T02:05:00Z');
keep(feedEvents);
hot = (await get('/api/hot-players?sport=nhl')).hot;
ok(!hot.players.some((p) => /Rangers|Canucks/.test(p.oppNick)) && startOf(hot)['Tomas Hertl'] === '2026-11-14T03:10:00Z',
  "who is still to come goes by the list's own time: at 6:05, the Rangers' and Canucks' players are gone");

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
