// The NFL's bet links (2026-10-29, the owner's call): the moneylines and the
// passing-TD unders, the two NFL sides the edge bets name, carry a link to the
// book's slip as the NBA's, NHL's and soccer's do (tests/betlinks.mjs). What
// has to hold:
//   - the game-line and props reads ask for the links (includeLinks, which
//     costs nothing); each team's link is kept beside its price, a passing-TD
//     line's beside its Over and Under; the other prop markets keep none
//   - a link the last row lacks is written once; then an unchanged read
//     writes nothing
//   - the board's side carries its best price's link and every book's price
//     with its hold, and so does the row it logs
//   - the passing-TD log reads the capture's own rows: it ran before they were
//     written, so each capture logged the one before's prices
//   - an NFL edge bet, moneyline or passing-TD under, carries its book's link
//     and every book's price; its book is the one its latest price is at
//
// Real data: production's /api/links-probe reads of 12:27 PM Pacific, Oct 29
// -- the NFL's first two games at the capture's ten books
// (tests/fixtures/odds-nfl-links-20261029.json) and Panthers @ Packers'
// passing-TD props at the props capture's (tests/fixtures/odds-nfl-ptd-links-
// 20261029.json). The last reads raise two prices to clear the edge bar, as
// tests/edgebets.mjs does: BetMGM's Packers to -150, FanDuel's Bryce Young
// under to +120. Real SQLite and the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const fx = (f) => JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', f), 'utf8'));
const GL = fx('odds-nfl-links-20261029.json').events;
const PTD = fx('odds-nfl-ptd-links-20261029.json').event;
const RealDate = Date;
let NOW = RealDate.parse('2026-10-29T19:27:00Z');
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
let games = GL, props = PTD;
const asked = [];
const hdr = { 'x-requests-last': '1', 'x-requests-remaining': '35000', 'x-requests-used': '65000' };
globalThis.fetch = async (u) => {
  const url = String(u);
  if (!/api\.the-odds-api\.com/.test(url)) return new Response('{}', { status: 404 });
  asked.push(url);
  const ev = url.match(/americanfootball_nfl\/events\/([0-9a-f]+)\/odds/);
  const body = ev ? (ev[1] === PTD.id ? props : { ...GL.find((e) => e.id === ev[1]), bookmakers: [] })
    : /americanfootball_nfl\/events\?/.test(url) ? GL.map(({ bookmakers, ...e }) => e)
      : /americanfootball_nfl\/odds/.test(url) ? games : null;
  return body ? new Response(JSON.stringify(body), { status: 200, headers: hdr }) : new Response('{}', { status: 404 });
};
const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const exec = (sql, args, mode) => { const st = sq.prepare(sql); const a = args.map(norm);
  if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
  if (/^\s*(SELECT|WITH)/i.test(sql)) return { results: st.all(...a), meta: {} };
  return { success: true, meta: { changes: Number(st.run(...a).changes) } }; };
const DB = { prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
  all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
  run: async () => exec(s.sql, s.args, 'run') }; return s; }, batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')) };
const env = { DB, ODDS_API_KEY: 'test-key' };
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const rows = (sql, ...a) => { try { return sq.prepare(sql).all(...a); } catch (e) { return []; } };
const hold = (...am) => Math.round((am.reduce((s, x) => s + (x > 0 ? 100 / (x + 100) : -x / (-x + 100)), 0) - 1) * 1000) / 10;
const [TNF] = GL;
const out = (ev, bk, name, desc) => ev.bookmakers.find((b) => b.key === bk).markets[0].outcomes.find((o) => o.name === name && (!desc || o.description === desc));
const strip = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'link' || k === 'sid' ? undefined : v)));
const raise = (ev, bk, name, desc, price) => ({ ...ev, bookmakers: ev.bookmakers.map((b) => (b.key !== bk ? b : { ...b, markets: b.markets.map((m) => ({ ...m,
  outcomes: m.outcomes.map((o) => (o.name === name && (!desc || o.description === desc) ? { ...o, price } : o)) })) })) });

console.log('-- the game lines --');
await get('/api/gmpicks-export'); await get('/api/picks');      // the tables
// A minute between reads: each read's rows carry its own captured_at, and the
// latest is the current one.
const later = () => { NOW += 60e3; };
games = strip(GL);
const g0 = await get('/api/nfl-ingest');
games = GL; later();
const g1 = await get('/api/nfl-ingest'); later();
const g2 = await get('/api/nfl-ingest');
console.log(`  wrote ${g0.wrote} with no links, then ${g1.wrote} once links came, then ${g2.wrote} (${g2.unchanged} unchanged)`);
ok(asked.some((u) => /americanfootball_nfl\/odds\?/.test(u) && /[?&]includeLinks=true/.test(u)), 'the game-line read asks the feed for its bet links');
ok(g0.wrote === 40 && g1.wrote === 28 && g2.wrote === 0 && g2.unchanged === 40,
  'a link the last row lacks is written once -- the 28 quotes of the seven books that send one; Pinnacle, BetOnline and LowVig send none -- then an unchanged read writes nothing');
const lnk = rows("SELECT player, book, over, link_over FROM nfl_lines WHERE event_id = ? AND market = 'h2h' AND link_over IS NOT NULL ORDER BY captured_at DESC", TNF.id);
ok(lnk.find((r) => r.player === 'Green Bay Packers' && r.book === 'draftkings').link_over === out(TNF, 'draftkings', 'Green Bay Packers').link
  && !lnk.some((r) => r.book === 'pinnacle'), "each team's link is kept beside its price, where the book sends one (Pinnacle sends none)");

console.log('\n-- the board and its log --');
const nb = await get('/api/nfl-board');
const gb = (nb.games || []).find((x) => x.id === TNF.id);
console.log(`  ${gb ? `${gb.away} ${gb.away_price} ${gb.away_book} @ ${gb.home} ${gb.home_price} ${gb.home_book}, fair ${gb.away_fair}/${gb.home_fair} (${gb.fairSrc}), pick ${gb.pickTeam}` : JSON.stringify(nb).slice(0, 300)}`);
ok(gb && gb.home_book === 'draftkings' && gb.home_link === out(TNF, 'draftkings', 'Green Bay Packers').link
  && gb.away_book === 'fanduel' && gb.away_link === out(TNF, 'fanduel', 'Carolina Panthers').link, "the Packers' best price is DraftKings' -185, the Panthers' FanDuel's +166, each with its own link");
ok(gb && gb.home_books.betmgm[0] === -200 && gb.home_books.betmgm[1] === hold(165, -200) && gb.home_books.pinnacle[1] === hold(169, -189), "every book's price of each side, with its hold");
const row = () => sq.prepare("SELECT side, pick, book, close_price, link, book_prices FROM gmpicks WHERE sport = 'nfl' AND game_id = ?").get(TNF.id);
ok(row() && row().pick === 'GB' && row().link === gb.home_link && JSON.parse(row().book_prices).draftkings[0] === -185, 'the logged Packers row carries the link and the books');

console.log('\n-- the passing TDs --');
props = strip(PTD); later();
const p0 = await get('/api/nfl-capture');
props = PTD; later();
const p1 = await get('/api/nfl-capture');
later();
const p2 = await get('/api/nfl-capture');
console.log(`  wrote ${p0.wrote} with no links (logged ${p0.passTdsLogged}), then ${p1.wrote} (logged ${p1.passTdsLogged}), then ${p2.wrote} (${p2.unchanged} unchanged)`);
ok(asked.some((u) => new RegExp(`events/${PTD.id}/odds`).test(u) && /[?&]includeLinks=true/.test(u)), 'the props read asks for the links too');
ok(p0.passTdsLogged === 2, `the first capture logs its own two quarterbacks -- it read the rows before writing them, and logged nothing (${p0.passTdsLogged})`);
const by = (bk, desc, side) => out(PTD, bk, side, desc).link;
const ln = rows("SELECT player, point, book, link_over, link_under FROM nfl_lines WHERE market = 'player_pass_tds' AND book = 'fanduel' AND link_under IS NOT NULL");
ok(p1.wrote === rows("SELECT * FROM nfl_lines WHERE market = 'player_pass_tds' AND (link_over IS NOT NULL OR link_under IS NOT NULL)").length && p2.wrote === 0
  && ln.find((r) => r.player === 'Bryce Young').link_under === by('fanduel', 'Bryce Young', 'Under') && ln.find((r) => r.player === 'Bryce Young').link_over === by('fanduel', 'Bryce Young', 'Over'),
  "a passing-TD line keeps its Over's and its Under's link, written once when they come");
const ptd = (who) => sq.prepare("SELECT pick, book, close_price, link, book_prices FROM gmpicks WHERE sport = 'nflptd' AND game_id = ?").get(`${PTD.id}|${who}`);
console.log(`  ${['Bryce Young', 'Jordan Love'].map((w) => { const r = ptd(w); return r ? `${r.pick} ${r.close_price} ${r.book}` : w + ': none'; }).join(' | ')}`);
ok(ptd('Bryce Young') && ptd('Bryce Young').book === 'fanduel' && ptd('Bryce Young').link === by('fanduel', 'Bryce Young', 'Under')
  && ptd('Jordan Love').link === by('fanduel', 'Jordan Love', 'Under'), "each under's row carries its best book's link: FanDuel's -122 and +125");
const ybp = JSON.parse(ptd('Bryce Young').book_prices);
ok(ybp.draftkings[0] === -128 && ybp.draftkings[1] === hold(100, -128) && ybp.pinnacle[0] === -122 && !('prizepicks' in ybp), "and every book's under, with its hold; PrizePicks is not a book");

console.log('\n-- the edge bets --');
NOW += 5 * 60e3;
games = GL.map((e) => (e.id !== TNF.id ? e : raise(e, 'betmgm', 'Green Bay Packers', null, -150)));
await get('/api/nfl-ingest'); await get('/api/nfl-board');
props = raise(PTD, 'fanduel', 'Under', 'Bryce Young', 120);
await get('/api/nfl-capture');
const d = await get('/api/picks');
const ml = (d.evBets || []).find((b) => b.label === 'GB ML'), un = (d.evBets || []).find((b) => /^Bryce Young Under 1\.5/.test(b.label));
for (const b of [ml, un]) if (b) console.log(`  ${b.label} ${b.price} ${b.book} · fair ${b.fair} · EV +${b.ev}% · ${b.link} · ${(b.books || []).map((x) => `${x.book} ${x.price}`).join(', ')}`);
if (!ml || !un) console.log('  ' + JSON.stringify(d.evBets) + ' ' + (d.evError || ''));
ok(ml && ml.price === -150 && ml.book === 'betmgm' && ml.link === out(TNF, 'betmgm', 'Green Bay Packers').link,
  "BetMGM's -150 on the Packers is an edge bet, at BetMGM, with BetMGM's link -- not DraftKings', the row's first book");
ok(ml && ml.books && ml.books[0].book === 'betmgm' && ml.books.find((b) => b.book === 'pinnacle').sharp && ml.books.filter((b) => b.link).length === 1,
  'its books, best first, the sharp one marked; the one link the row keeps is its best price\'s');
ok(un && un.price === 120 && un.book === 'fanduel' && un.link === by('fanduel', 'Bryce Young', 'Under') && un.books && un.books[0].book === 'fanduel',
  "FanDuel's +120 on Bryce Young's under is one too, with FanDuel's link and every book's under");

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
