// Game-day re-reads of PrizePicks' lines (2026-10-31, the owner's call, about
// 140 credits a day). PrizePicks moved Kris Dunn's assists from 5.5 to 4.5 and
// Giannis' rebounds from 12.5 to 11.5 between the night-before read and the
// pre-tip one, and the card showed the old lines all day. What has to hold:
//   - inside 8 hours of the start, every 3 hours since the last read, until
//     2.5 hours out, the full read again -- nothing before the window, nothing
//     between, nothing in the last 2.5 hours but the pre-tip read
//   - each re-read moves each leg's line as it stands, with its read time
//   - a line PrizePicks has taken down is off the card at the re-read, and
//     back when it is posted again; one an earlier re-read had and the pre-tip
//     read does not find is off, not left at the earlier re-read's number
//   - the pre-tip read still comes, inside 90 minutes
//
// The payload is the real one, Celtics @ Pistons as production read it on Oct
// 20 (tests/fixtures/odds-nba-pp-26b036ff-20261020.json), with the moves
// written in as tests/ppearly.mjs writes them. Real SQLite, the real worker,
// its own cron.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = path.join(BOARD, 'tests', 'fixtures');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const RealDate = Date;
let NOW = 0;
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
const iso = (ms) => new RealDate(ms).toISOString();
const H = 3600e3, M = 60e3;
const NBA = JSON.parse(fs.readFileSync(path.join(FIX, 'odds-nba-pp-26b036ff-20261020.json'), 'utf8'));
const PRIORS = fs.readFileSync(path.join(BOARD, 'nba-priors.json'), 'utf8');
const ODDS = 'https://api.the-odds-api.com/v4/sports';

// PrizePicks' lines moved: player -> market -> new point, or null for taken down.
function moved(body, moves) {
  const b = structuredClone(body);
  const pp = b.bookmakers.find((x) => x.key === 'prizepicks');
  for (const m of pp.markets) {
    m.outcomes = m.outcomes.flatMap((o) => {
      const to = moves[o.description] && moves[o.description][m.key];
      if (to === undefined) return [o];
      return to === null ? [] : [{ ...o, point: to }];
    });
  }
  return b;
}
const ppOnly = (b, market) => ({ ...b, bookmakers: b.bookmakers.filter((x) => x.key === 'prizepicks').map((x) => ({ ...x, markets: x.markets.filter((m) => m.key === market) })) });
const feed = { body: NBA };
const calls = [];
globalThis.fetch = async (u) => {
  const url = String(u);
  const J = (x, h) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json', 'x-requests-remaining': '90000', ...(h || {}) } });
  const ev = url.startsWith(ODDS) && (url.match(/\/events\/(\w+)\/odds\?/) || [])[1];
  if (ev === NBA.id) {
    const check = /&bookmakers=prizepicks$/.test(url);
    calls.push({ check, at: NOW });
    return check ? J(ppOnly(feed.body, new URL(url).searchParams.get('markets')), { 'x-requests-last': '1' }) : J(feed.body, { 'x-requests-last': '5' });
  }
  const evl = url.startsWith(ODDS) && (url.match(/\/sports\/(\w+)\/events\?/) || [])[1];
  if (evl) return J(evl === NBA.sport_key ? [(({ bookmakers, ...e }) => e)(NBA)] : [], { 'x-requests-last': '0' });
  if (url.startsWith(ODDS)) return J([], { 'x-requests-last': '0' });
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
const env = { DB, ODDS_API_KEY: 'k', ASSETS: { fetch: async (r) => (new URL(r.url).pathname === '/nba-priors.json'
  ? new Response(PRIORS, { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('{}', { status: 404 })) } };
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const tick = async () => { const held = []; await mod.default.scheduled({}, env, { waitUntil: (p) => held.push(p) }); await Promise.allSettled(held); };
const hit = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const reads = () => calls.filter((c) => !c.check).length;
const row = (p, m) => sq.prepare('SELECT * FROM nbapp WHERE game_id = ? AND player = ? AND market = ?').get(NBA.id, p, m) || {};
const card = async (p, m) => (await hit('/api/nba-pp')).legs.find((x) => x.player === p && x.market === m);

// ---- the rule ---------------------------------------------------------------------------------
console.log('-- when a game is read --');
const cst = (n) => src.slice(src.indexOf(`const ${n} =`), src.indexOf(';\n', src.indexOf(`const ${n} =`)) + 1);
const fn = src.slice(src.indexOf('function ppReadDue('), src.indexOf('\n}\n', src.indexOf('function ppReadDue(')) + 2);
const due = new Function(['PP_WATCH_MS', 'PP_WATCH_EVERY_MS', 'PP_CLOSE_MS', 'PP_REFRESH_WINDOW_MS', 'PP_REFRESH_EVERY_MS', 'PP_REFRESH_STOP_MS'].map(cst).join('\n') + '\n' + fn + '\nreturn ppReadDue;')();
// A 7 PM Pacific tip (02:00 UTC), first read the night before.
const tip = RealDate.parse('2026-11-01T02:00:00Z'), c = iso(tip), first = tip - 26 * H;
const at = (pt) => RealDate.parse(`2026-10-31T${pt}:00-07:00`);
const steps = [['10:55', { first }], ['11:05', { first }], ['13:00', { first, refreshed: at('11:05') }], ['14:05', { first, refreshed: at('11:05') }],
  ['16:00', { first, refreshed: at('14:05') }], ['17:20', { first, refreshed: at('14:05') }], ['17:35', { first, refreshed: at('14:05') }], ['17:45', { first, refreshed: at('14:05'), close: at('17:35') }]];
const got = steps.map(([t, st]) => `${t} ${due(c, st, at(t)) || '-'}`).join(', ');
console.log('  ' + got);
ok(got === '10:55 -, 11:05 refresh, 13:00 -, 14:05 refresh, 16:00 -, 17:20 -, 17:35 close, 17:45 -',
  'a 7 PM tip: re-read at 11:05 AM and 2:05 PM, nothing after 4:30, the pre-tip read inside 90 minutes, at 5:35');
ok(due(c, { checked: at('11:05') }, at('11:30')) === null && due(c, {}, at('11:05')) === 'check', "a game PrizePicks has not posted is still only checked, every two hours");

// ---- the reads --------------------------------------------------------------------------------
console.log('\n-- Celtics @ Pistons, noon Pacific --');
const TIP = RealDate.parse(NBA.commence_time);
NOW = TIP - 30 * H;
await tick();
ok(reads() === 1 && row('Cade Cunningham', 'ast').point === 9, 'posted the day before: the first read, Cunningham under 9 assists');
const whiteThrees = row('Derrick White', 'threes').point;
NOW = TIP - 8 * H - 5 * M; let r0 = reads(); await tick();
ok(reads() === r0, 'eight hours and five minutes out: no re-read yet');

NOW = TIP - 8 * H + 5 * M; r0 = reads();
feed.body = moved(NBA, { 'Cade Cunningham': { player_assists: 8 }, 'Derrick White': { player_threes: null } });
await tick();
ok(reads() === r0 + 1, 'inside eight hours: re-read');
let cc = row('Cade Cunningham', 'ast'), cu = await card('Cade Cunningham', 'ast');
ok(cc.point === 9 && cc.close_point === 8 && cc.close_at === iso(NOW) && cu && cu.point === 8 && cu.close_at === iso(NOW),
  `PrizePicks' move to 8 is on the card at 4:05 AM, with its read time: Cunningham ${cu && cu.first_point} → ${cu && cu.point}`);
ok(!(await card('Derrick White', 'threes')) && await card('Derrick White', 'reb'), "White's threes, taken down, are off the card; his rebounds stay");

NOW += H; r0 = reads(); await tick();
ok(reads() === r0, 'an hour later: nothing');
NOW = TIP - 5 * H + 5 * M; r0 = reads();
feed.body = moved(NBA, { 'Cade Cunningham': { player_assists: 8 } });
await tick();
ok(reads() === r0 + 1 && (await card('Derrick White', 'threes') || {}).point === whiteThrees, `three hours on: re-read, and White's threes are back at ${whiteThrees}`);
NOW = TIP - 2 * H - 20 * M; r0 = reads(); await tick();
ok(reads() === r0, 'two hours and twenty minutes out: nothing but the pre-tip read to come');

NOW = TIP - 80 * M; r0 = reads();
feed.body = moved(NBA, { 'Cade Cunningham': { player_assists: 8 }, 'Derrick White': { player_threes: null } });
await tick();
ok(reads() === r0 + 1 && row('Cade Cunningham', 'ast').close_at === iso(NOW), 'the pre-tip read, inside 90 minutes');
ok(row('Derrick White', 'threes').close_point == null && !(await card('Derrick White', 'threes')),
  "White's threes, down again, are off: not left at the re-read's number");
ok(reads() === 4 && calls.filter((x) => x.check).length === 1, `four full reads for the game, about 20 credits: the first, two re-reads, the pre-tip (${reads()})`);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
