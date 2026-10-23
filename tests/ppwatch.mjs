// The PrizePicks watch finds its games in the feed's free events list, not
// only in the moneyline board's snapshot (2026-10-23).
//
// The early reads watch each game from 36 hours out. Their game list was the
// moneyline board's snapshot, which holds only games the books have priced:
// at 2:40 PM Pacific on Friday Oct 23 it had none of Saturday's NBA games, so
// nothing for Saturday was checked, and a Saturday entry built Friday night
// would have found the card empty even with PrizePicks posted. The events
// list has every scheduled game, and reading it costs nothing. What has to hold:
//   - a game on the events list is watched even when the snapshot is empty
//   - the list is read once every two hours, not every tick, and kept as it
//     came (?raw=events)
//   - a failed read keeps the last list and waits the two hours
//   - a game on both the list and the snapshot is checked once
//   - the NHL watch the same way
//
// The games are the real ones: the event fields of the recorded Celtics @
// Pistons and Thunder @ Spurs payloads (Oct 20) and Mammoth @ Kraken (Oct 22),
// served as the events list serves them -- id, sport_key, sport_title,
// commence_time, home_team, away_team, no bookmakers. Their odds are the
// recorded payloads. Real SQLite, the real worker, its own cron.
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
const H = 3600e3;
const read = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
const BOS = read('odds-nba-pp-26b036ff-20261020.json');      // tips 19:00Z Oct 20
const OKC = read('odds-nba-pp-bccd283d-20261020.json');      // tips 01:30Z Oct 21
const NHL_REC = read('odds-nhl-pp-ec5f71ec-20261022.json');
const UTA = NHL_REC.payload;                                  // drops 02:10Z Oct 23
const STATS = Object.fromEntries(Object.entries(NHL_REC).filter(([u]) => u.startsWith('https://api.nhle.com/')));
const PRIORS = fs.readFileSync(path.join(BOARD, 'nba-priors.json'), 'utf8');
const asEvent = (b) => ({ id: b.id, sport_key: b.sport_key, sport_title: b.sport_title, commence_time: b.commence_time, home_team: b.home_team, away_team: b.away_team });

const ODDS = 'https://api.the-odds-api.com/v4/sports';
const feed = {
  events: { basketball_nba: [asEvent(BOS), asEvent(OKC)], basketball_nba_preseason: [], icehockey_nhl: [asEvent(UTA)] },
  eventsFail: false,
  posted: { [BOS.id]: BOS, [UTA.id]: UTA },                   // what PrizePicks has up
};
const calls = [];
globalThis.fetch = async (u) => {
  const url = String(u);
  const J = (x, h, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json', ...(h || {}) } });
  const evList = url.match(/^https:\/\/api\.the-odds-api\.com\/v4\/sports\/(\w+)\/events\?apiKey=k&dateFormat=iso$/);
  if (evList) {
    calls.push({ kind: 'events', sport: evList[1], at: NOW });
    if (feed.eventsFail) return J({ message: 'rate limited' }, { 'x-requests-last': '0', 'x-requests-remaining': '88000' }, 429);
    return J(feed.events[evList[1]] || [], { 'x-requests-last': '0', 'x-requests-remaining': '88000' });
  }
  const ev = url.startsWith(ODDS) && (url.match(/\/events\/(\w+)\/odds\?/) || [])[1];
  if (ev) {
    const check = /&bookmakers=prizepicks$/.test(url);
    calls.push({ kind: check ? 'check' : 'read', ev, at: NOW });
    const body = feed.posted[ev];
    const all = [...feed.events.basketball_nba, ...feed.events.icehockey_nhl];
    if (!body) { const e = all.find((x) => x.id === ev); return J({ ...e, bookmakers: [] }, { 'x-requests-last': '0', 'x-requests-remaining': '88000' }); }
    const m = new URL(url).searchParams.get('markets');
    const out = check ? { ...body, bookmakers: body.bookmakers.filter((b) => b.key === 'prizepicks').map((b) => ({ ...b, markets: b.markets.filter((x) => x.key === m) })) } : body;
    return J(out, { 'x-requests-last': check ? '1' : '5', 'x-requests-remaining': '88000' });
  }
  if (url.startsWith(ODDS)) return J([], { 'x-requests-last': '0', 'x-requests-remaining': '88000' });
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
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const tick = async () => { const held = []; await mod.default.scheduled({}, env, { waitUntil: (p) => held.push(p) }); await Promise.allSettled(held); };
const hit = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();
const snapshot = (key, games) => sq.prepare('INSERT OR REPLACE INTO feed_cache (key, data, updated_at) VALUES (?, ?, ?)')
  .run(key, JSON.stringify({ asOf: new RealDate(NOW).toISOString(), games: games.map((b) => ({ id: b.id, league: 'reg', commence: b.commence_time, home: b.home_team, away: b.away_team })) }), NOW);

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const since = (n, f = () => true) => calls.slice(n).filter(f);
const say = (l) => l.map((c) => (c.kind === 'events' ? `events(${c.sport})` : `${c.kind} ${c.ev === BOS.id ? 'BOS' : c.ev === OKC.id ? 'OKC' : c.ev === UTA.id ? 'UTA' : c.ev}`)).join(', ') || 'none';
const nba = (c) => c.kind !== 'events' && (c.ev === BOS.id || c.ev === OKC.id);
// The moneyline ingest reads the same events URL on its own hourly gate, so
// the watch's own reads are counted from its line on the usage ledger.
const watchReads = async (route) => Object.values((await hit('/api/usage')).routes || {}).flat()
  .filter((r) => r.route === route).reduce((a, r) => a + r.calls, 0);

console.log('-- the board has priced nothing; the events list has both games --');
NOW = RealDate.parse('2026-10-19T20:00:00Z');                 // Monday 1 PM Pacific: Celtics 23h out, Thunder 29.5h
const saved = feed.events;
feed.events = {};                                               // tables made, nothing scheduled yet
NOW -= 3 * H; await tick(); NOW += 3 * H;
feed.events = saved;
snapshot('nba_board:reg', []);                                  // the moneyline board: no game priced yet
let n = calls.length, w = await watchReads('nba:reg:pp-events');
await tick();
const first = since(n, nba);
console.log('  ' + say(first));
ok(await watchReads('nba:reg:pp-events') === w + 1 && await watchReads('nba:pre:pp-events') === 2, 'the events list is read for the watch, the regular season and the preseason');
ok(first.some((c) => c.kind === 'check' && c.ev === BOS.id) && first.some((c) => c.kind === 'check' && c.ev === OKC.id),
  'both games are checked though the board has neither');
ok(first.some((c) => c.kind === 'read' && c.ev === BOS.id) && !first.some((c) => c.kind === 'read' && c.ev === OKC.id),
  'PrizePicks has the Celtics up: read in full; the Thunder, not yet: checked only');
const rows = sq.prepare('SELECT COUNT(*) AS n FROM nbapp WHERE game_id = ?').get(BOS.id).n;
ok(rows === 30, `the Celtics' 30 legs are logged, 23 hours out (${rows})`);
const b = await hit('/api/nba-pp');
ok(b.legs.length === 30 && b.legs.every((x) => x.game === 'Boston Celtics @ Detroit Pistons'), `and on the card (${b.legs.length})`);
const raw = await hit('/api/nba-pp?raw=events');
ok(raw.at === new RealDate(NOW).toISOString() && JSON.stringify(raw.events) === JSON.stringify(feed.events.basketball_nba),
  'the list is kept as it came (?raw=events), so a real one can be recorded');
const u = await hit('/api/usage');
const route = ((u.routes || {})['2026-10-19'] || []).find((r) => r.route === 'nba:reg:pp-events');
ok(route && route.credits === 0 && route.calls === 2, `on the ledger as nba:reg:pp-events, no credits (${JSON.stringify(route)})`);

console.log('\n-- the next ticks --');
w = await watchReads('nba:reg:pp-events');
NOW += 5 * 60e3; n = calls.length; await tick();
ok(since(n, nba).length === 0 && await watchReads('nba:reg:pp-events') === w, `five minutes on: no events read, no check (${say(since(n, nba))})`);
NOW += H; n = calls.length; await tick();
ok(since(n, nba).length === 0 && await watchReads('nba:reg:pp-events') === w, `an hour on: still nothing (${say(since(n, nba))})`);
NOW += H; n = calls.length; await tick();
ok(say(since(n, nba)) === 'check OKC' && await watchReads('nba:reg:pp-events') === w + 1,
  `two hours on: the list again, and the Thunder checked again (${say(since(n, nba))})`);

console.log('\n-- the board prices both; the list read fails --');
snapshot('nba_board:reg', [BOS, OKC]);
feed.eventsFail = true;
NOW += 2 * H + 60e3; n = calls.length; w = await watchReads('nba:reg:pp-events'); await tick();
const t3 = since(n, nba);
ok(say(t3) === 'check OKC' && await watchReads('nba:reg:pp-events') === w + 1, `a game on both is checked once (${say(t3)})`);
const raw2 = await hit('/api/nba-pp?raw=events');
ok(raw2.failed === true && JSON.stringify(raw2.events) === JSON.stringify(feed.events.basketball_nba), 'a failed read keeps the last list');
w = await watchReads('nba:reg:pp-events');
NOW += 5 * 60e3; await tick();
ok(await watchReads('nba:reg:pp-events') === w, 'and waits two hours, not a tick, to try again');
feed.eventsFail = false;

console.log('\n-- NHL --');
NOW = RealDate.parse(UTA.commence_time) - 18 * H;              // 18 hours before Mammoth @ Kraken
snapshot('nhl_board:reg', []);
n = calls.length; w = await watchReads('nhl:reg:pp-events');
await tick();
const nh = since(n, (c) => c.ev === UTA.id);
ok(say(nh) === 'check UTA, read UTA' && await watchReads('nhl:reg:pp-events') === w + 1,
  `the NHL board has nothing priced; the list has the game: checked and read (${say(nh)})`);
const nl = sq.prepare('SELECT COUNT(*) AS n FROM nhlpp WHERE game_id = ?').get(UTA.id).n;
ok(nl === 6, `the six legs production logged from it (${nl})`);
const nraw = await hit('/api/nhl-pp?raw=events');
ok(JSON.stringify(nraw.events) === JSON.stringify(feed.events.icehockey_nhl), 'its list kept too (/api/nhl-pp?raw=events)');

// ---- the real lists ---------------------------------------------------------------------------
// As production first read them, at 2:55 PM Pacific on Friday Oct 23
// (tests/fixtures/odds-{nba,nhl}-events-20261023.json, from ?raw=events): the
// NBA's has Friday's twelve games, the one under way included, and then the
// Christmas Day games -- no Saturday yet; the NHL's has Friday's two and
// Saturday's twelve. Nothing PrizePicks has posted, both boards empty.
console.log('\n-- the real lists, Friday afternoon --');
const NBA_EV = read('odds-nba-events-20261023.json'), NHL_EV = read('odds-nhl-events-20261023.json');
feed.events = { basketball_nba: NBA_EV.events, basketball_nba_preseason: [], icehockey_nhl: NHL_EV.events };
feed.posted = {};
NOW = RealDate.parse(NHL_EV.at);
sq.prepare("DELETE FROM feed_cache WHERE key LIKE '%_pp_events:%' OR key IN ('nba_pp_games', 'nhl_pp_games')").run();
snapshot('nba_board:reg', []); snapshot('nhl_board:reg', []);
n = calls.length;
for (let i = 0; i < 6; i++) { await tick(); NOW += 5 * 60e3; }
const checked = new Set(since(n, (c) => c.kind === 'check').map((c) => c.ev));
const reads = since(n, (c) => c.kind === 'read');
const startOf = (id) => RealDate.parse([...NBA_EV.events, ...NHL_EV.events].find((e) => e.id === id).commence_time);
const within = (list) => list.filter((e) => { const t = RealDate.parse(e.commence_time); return t > RealDate.parse(NHL_EV.at) && t - RealDate.parse(NHL_EV.at) <= 36 * H; });
const nbaWant = within(NBA_EV.events), nhlWant = within(NHL_EV.events);
const seen = (id) => checked.has(id) || reads.some((c) => c.ev === id);
ok(nbaWant.length === 11 && nbaWant.every((e) => seen(e.id)), `half an hour of ticks: every NBA game still to come tonight is checked, or read if it tips inside 90 minutes (${nbaWant.filter((e) => seen(e.id)).length} of ${nbaWant.length})`);
ok(nhlWant.length === 14 && nhlWant.every((e) => checked.has(e.id)),
  `and every NHL game in the next 36 hours, Saturday's twelve with tonight's two (${nhlWant.filter((e) => checked.has(e.id)).length} of ${nhlWant.length})`);
ok(!NBA_EV.events.some((e) => /^2026-12-2[56]/.test(e.commence_time) && checked.has(e.id)) && !checked.has(NBA_EV.events[0].id),
  'never the Christmas games, two months out, nor the game under way');
ok(reads.length === 5 && reads.every((c) => startOf(c.ev) - c.at <= 90 * 60e3),
  `the only full reads are the pre-tip ones, the five 4:10 PM tips; everything else is a free check (${reads.length})`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
