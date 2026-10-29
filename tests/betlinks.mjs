// Bet at the book, how a price moved, and a player's last games (2026-10-29,
// the owner's call, from the comparison with Pinnacle, BetMGM, Caesars,
// FanDuel and Unabated). What has to hold:
//   - the moneyline and soccer reads ask the feed for its bet links
//     (includeLinks, which costs nothing), and each side carries the link of
//     the book its best price is at -- a side whose best price moves to
//     another book takes that book's link
//   - soccer keeps each quote's link beside its price; a link the last row
//     lacks is written once, and an unchanged read writes nothing
//   - every side a game-line read prices leaves a point in its price history;
//     a read that moves neither its fair nor its price writes nothing, and
//     soccer's lead and favourite rows of one read leave one point a side
//   - an edge bet carries its link and its history; the history key stays in
//     the worker
//   - an NBA player leg's last games, oldest first, against its line
//   - every book's price of a side, best first, with the book's hold on that
//     market; the sharp books marked; a row's book is the one its latest price
//     and link are at, not its first read's
//   - every side priced goes to the page's price checker, with the stake rule
//   - on the page: DraftKings' and FanDuel's links open as sent; BetMGM's,
//     Caesars' and BetRivers' wait for the state, then name it; BetRivers'
//     slip placeholders give way to its event page; a link that is not https
//     is no link; the price line names its first and latest price; the bars
//     colour the games that went the pick's way
//
// Real data: production's /api/links-probe reads of Oct 29 -- the NBA's first
// two games (tests/fixtures/odds-nba-links-20261029.json) and the Premier
// League's (tests/fixtures/odds-epl-links-20261029.json), DraftKings, FanDuel,
// BetMGM, Caesars and BetRivers -- and ESPN's box scores of the Hawks' five
// games to Oct 28 (tests/fixtures/espn-nba-box-atl-202610.json). The probe
// reads no sharp book, so one book's real prices stand in for Pinnacle's:
// BetRivers' in the NBA, BetMGM's in soccer (where it is not a book the board
// bets). On the third NBA read BetMGM's Hawks price is raised to +120, as the
// edge-bet test raises prices to clear the bar. Real SQLite and the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const fx = (f) => JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', f), 'utf8'));
const NBA = fx('odds-nba-links-20261029.json').events;
const EPL = fx('odds-epl-links-20261029.json').events;
const ATL = fx('espn-nba-box-atl-202610.json').games;
const RealDate = Date;
let NOW = RealDate.parse('2026-10-29T10:27:00Z');
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
const relabel = (evs, from) => evs.map((e) => ({ ...e, bookmakers: e.bookmakers.map((b) => (b.key === from ? { ...b, key: 'pinnacle', title: 'Pinnacle' } : b)) }));
let nbaEvents = relabel(NBA, 'betrivers'), eplEvents = relabel(EPL, 'betmgm');
const asked = [];
globalThis.fetch = async (u) => {
  const url = String(u);
  const body = /\/v4\/sports\/basketball_nba\/odds/.test(url) ? nbaEvents : /\/v4\/sports\/soccer_epl\/odds/.test(url) ? eplEvents : null;
  if (!body) return new Response('{}', { status: 404 });
  asked.push(url);
  return new Response(JSON.stringify(body), { status: 200, headers: { 'x-requests-last': '1', 'x-requests-remaining': '75000', 'x-requests-used': '25000' } });
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
const all = (sql, ...a) => { try { return sq.prepare(sql).all(...a); } catch (e) { return []; } };
const linkOf = (evs, bk, team) => evs.flatMap((e) => e.bookmakers).filter((b) => b.key === bk).flatMap((b) => b.markets[0].outcomes).find((o) => o.name === team).link;
const [HAWKS] = NBA;
const DK_ATL = linkOf([HAWKS], 'draftkings', 'Atlanta Hawks'), FD_ATL = linkOf([HAWKS], 'fanduel', 'Atlanta Hawks');
const FD_CLE = linkOf([HAWKS], 'fanduel', 'Cleveland Cavaliers'), MGM_ATL = linkOf([HAWKS], 'betmgm', 'Atlanta Hawks');

console.log('-- 3:27 AM: the NBA read --');
await get('/api/gmpicks-export'); await get('/api/nba-pp'); await get('/api/picks');      // the tables
const capture = async () => { sq.prepare("DELETE FROM feed_cache WHERE key = 'nba_board:reg'").run(); await get('/api/nba-board'); };
await capture();
ok(asked.some((u) => /basketball_nba\/odds/.test(u) && /[?&]includeLinks=true/.test(u)), 'the NBA read asks the feed for its bet links');
const snap = () => JSON.parse(sq.prepare("SELECT data FROM feed_cache WHERE key = 'nba_board:reg'").get().data);
let g = snap().games.find((x) => x.id === HAWKS.id);
console.log(`  ${g.away} @ ${g.home}: ${g.homePrice} ${g.homeBook} / ${g.awayPrice} ${g.awayBook}, fair ${g.homeFair} (${g.fairSrc})`);
ok(g.homeBook === 'fanduel' && g.homeLink === FD_ATL && g.awayLink === FD_CLE, "both sides' best price is FanDuel's -108, and each carries FanDuel's own link for it");
ok(g.links && g.links.home.draftkings === DK_ATL && g.links.home.betmgm === MGM_ATL && Object.keys(g.links.away).length === 5, "every book's link is kept beside it, side by side");
const row = () => sq.prepare("SELECT side, link, close_price FROM gmpicks WHERE sport = 'nba' AND game_id = ?").get(HAWKS.id);
ok(row() && row().side === 'home' && row().link === FD_ATL, "the logged side's row carries its best price's link");
const ph = (id, side) => all('SELECT at, fair, price FROM pricehist WHERE event_id = ? AND side = ? ORDER BY at', id, side);
ok(ph(HAWKS.id, 'ml:home').length === 1 && ph(HAWKS.id, 'ml:away').length === 1 && ph(HAWKS.id, 'ml:home')[0].fair === 50 && ph(HAWKS.id, 'ml:home')[0].price === -108,
  'each side leaves a point in its price history: fair 50%, -108');
ok(ph(NBA[1].id, 'ml:away').length === 1, 'the other game too, both sides');

console.log('\n-- 3:30 AM: the same prices again --');
NOW += 3 * 60e3;
await capture();
ok(ph(HAWKS.id, 'ml:home').length === 1 && ph(HAWKS.id, 'ml:away').length === 1 && all('SELECT * FROM pricehist').length === 4, 'a read that moves nothing writes nothing');

console.log('\n-- 3:33 AM: BetMGM goes to +120 on the Hawks --');
NOW += 3 * 60e3;
nbaEvents = relabel(NBA, 'betrivers').map((e) => (e.id !== HAWKS.id ? e : { ...e, bookmakers: e.bookmakers.map((b) => (b.key !== 'betmgm' ? b
  : { ...b, markets: b.markets.map((m) => ({ ...m, outcomes: m.outcomes.map((o) => (o.name === 'Atlanta Hawks' ? { ...o, price: 120 } : o)) })) })) }));
await capture();
g = snap().games.find((x) => x.id === HAWKS.id);
ok(g.homeBook === 'betmgm' && g.homeLink === MGM_ATL && g.awayLink === FD_CLE, "the Hawks' best price moves to BetMGM, and so does its link; the Cavaliers keep FanDuel's");
ok(row().link === MGM_ATL && row().close_price === 120, "the logged row's link follows its price");
ok(ph(HAWKS.id, 'ml:home').map((p) => p.price).join(',') === '-108,120' && ph(HAWKS.id, 'ml:away').length === 1, "the Hawks' history has the move; the Cavaliers' still one point");

console.log('\n-- /api/picks: the edge bet --');
const d = await get('/api/picks');
const bet = (d.evBets || []).find((b) => b.label === 'Hawks ML');
console.log(`  ${bet ? `${bet.label} ${bet.price} ${bet.book} · fair ${bet.fair} · EV +${bet.ev}% · link ${bet.link} · hist ${JSON.stringify(bet.hist)}` : JSON.stringify(d.evBets) + ' ' + (d.evError || '')}`);
ok(bet && bet.price === 120 && bet.ev === 10 && bet.link === MGM_ATL, 'the Hawks at +120 are an edge bet, with BetMGM\'s link');
ok(bet && Array.isArray(bet.hist) && bet.hist.length === 2 && bet.hist[0][1] === 50 && bet.hist[0][2] === -108 && bet.hist[1][2] === 120, 'and its history: -108 at 3:27, +120 at 3:33, fair 50% throughout');
ok(bet && !('hk' in bet) && !('grade' in bet), "the history key stays in the worker");
ok(Array.isArray(d.legs) && !d.error, 'the list still reads');
// A Picks moneyline's books (2026-10-29): every book's own link, from the
// board's snapshot -- its row keeps only the best price's.
const pel = (d.legs || []).find((l) => /^Pelicans ML/.test(l.title));
const pelLinks = pel && pel.books ? pel.books.filter((b) => b.link) : [];
console.log(`  ${pel ? `${pel.title} ${pel.odds}: ${pel.books.map((b) => `${b.book} ${b.price}${b.link ? ' link' : ''}`).join(', ')}` : 'no Pelicans leg'}`);
ok(pel && pelLinks.length === 4 && ['draftkings', 'fanduel', 'betmgm', 'williamhill_us'].every((bk) => pelLinks.find((b) => b.book === bk).link === linkOf([NBA[1]], bk, 'New Orleans Pelicans')),
  "the Pelicans on Picks: DraftKings', FanDuel's, BetMGM's and Caesars' own links, not only the best price's");

console.log('\n-- every book, side by side --');
const hold = (...am) => Math.round((am.reduce((s, x) => s + (x > 0 ? 100 / (x + 100) : -x / (-x + 100)), 0) - 1) * 1000) / 10;
console.log('  ' + (bet && bet.books || []).map((b) => `${b.book} ${b.price} (${b.hold}%)${b.sharp ? ' sharp' : ''}${b.link ? ' link' : ''}`).join(' | '));
ok(bet && bet.books && bet.books.map((b) => b.book).join(',') === 'betmgm,fanduel,draftkings,williamhill_us,pinnacle', "the Hawks' books, best price first: BetMGM's +120, FanDuel's -108, then the -110s");
ok(bet && bet.books[0].hold === hold(120, -110) && bet.books[1].hold === hold(-108, -108) && bet.books[2].hold === hold(-110, -110), `each with its hold on the game: BetMGM's ${hold(120, -110)}% at the raised +120, FanDuel's ${hold(-108, -108)}%, DraftKings' ${hold(-110, -110)}%`);
ok(bet && bet.books.find((b) => b.book === 'pinnacle').sharp === true && bet.books.filter((b) => b.sharp).length === 1, 'the fair\'s own book is marked sharp');
ok(bet && bet.books.every((b) => b.book === 'pinnacle' ? !b.link : b.link === linkOf([HAWKS], b.book, 'Atlanta Hawks')), "and every book's own link to the Hawks; the sharp one none");
const bp = JSON.parse(sq.prepare("SELECT book_prices FROM gmpicks WHERE sport = 'nba' AND game_id = ?").get(HAWKS.id).book_prices);
ok(bp.betmgm[0] === 120 && bp.fanduel[0] === -108 && bp.fanduel[1] === hold(-108, -108), "the logged row keeps them too, as last read");

console.log('\n-- the price checker --');
const hk = (d.priced || []).find((x) => x.label === 'Hawks ML');
ok((d.priced || []).length === 4 && hk && hk.fair === 50 && !('grade' in hk), 'every side priced goes to the checker (two games, both sides), with its fair');
ok(d.kelly && d.kelly.fraction === 0.25 && d.kelly.propCap === 1 && d.kelly.minLine === 1.5 && d.kelly.minProp === 3, 'and the stake rule: a quarter Kelly, props held to 1%, the bars');

console.log('\n-- the Premier League: links kept beside the prices --');
const strip = (evs) => evs.map((e) => ({ ...e, bookmakers: e.bookmakers.map((b) => ({ ...b, markets: b.markets.map((m) => ({ ...m, outcomes: m.outcomes.map(({ link, sid, ...o }) => o) })) })) }));
eplEvents = strip(relabel(EPL, 'betmgm'));
const ing0 = await get('/api/soccer-ingest?league=epl');
eplEvents = relabel(EPL, 'betmgm');
const ing1 = await get('/api/soccer-ingest?league=epl');
const ing2 = await get('/api/soccer-ingest?league=epl');
console.log(`  wrote ${ing0.wrote} with no links, then ${ing1.wrote} once links came, then ${ing2.wrote} (${ing2.unchanged} unchanged)`);
ok(asked.some((u) => /soccer_epl\/odds/.test(u) && /[?&]includeLinks=true/.test(u)), 'the soccer read asks for the links too');
ok(ing0.wrote === 30 && ing1.wrote === 30 && ing2.wrote === 0 && ing2.unchanged === 30, "a link the last row lacks is written once; then an unchanged read writes nothing");
const DK_CHE = linkOf(EPL, 'draftkings', 'Chelsea'), FD_LEE = linkOf(EPL, 'fanduel', 'Leeds United');
const sb = await get('/api/soccer-board?league=epl');
const che = (sb.games || []).find((x) => x.home === 'Chelsea'), bou = (sb.games || []).find((x) => x.home === 'Bournemouth');
console.log(`  ${che ? che.oneXtwo.map((p) => `${p.selection} ${p.price} ${p.book}`).join(' | ') : JSON.stringify(sb).slice(0, 300)}`);
ok(che && che.oneXtwo[0].book === 'draftkings' && che.oneXtwo[0].link === DK_CHE, "Chelsea's best price is DraftKings' -120, with DraftKings' link");
ok(bou && bou.oneXtwo[2].book === 'fanduel' && bou.oneXtwo[2].link === FD_LEE, "Leeds' is FanDuel's +260, with FanDuel's");
const srow = sq.prepare("SELECT side, link FROM gmpicks WHERE sport = 'soccer' AND game_id = ? AND market = 'h2h'").get(che.id);
const lead = che.oneXtwo.find((p) => p.selection === che.lead.selection);
ok(srow && srow.link === lead.link && !!srow.link, `the logged lead row (${che.lead.selection}) carries its link`);
ok(['ml:home', 'ml:draw', 'ml:away'].every((s) => ph(che.id, s).length === 1), 'one point a side, the lead and favourite rows of one read together');
const sbp = JSON.parse(srow && sq.prepare("SELECT book_prices FROM gmpicks WHERE sport = 'soccer' AND game_id = ? AND market = 'h2h'").get(che.id).book_prices);
ok(sbp.draftkings[0] === 295 && sbp.draftkings[1] === hold(-120, 295, 300) && sbp.pinnacle[1] === hold(-120, 290, 300), "the draw's books, each with its three-way hold");

console.log('\n-- the Hawks\' last games, against a line --');
const wlift = (name) => { let at = src.indexOf(`function ${name}(`); if (at < 0) throw new Error(`worker.js has no ${name}`); if (src.slice(at - 6, at) === "async ") at -= 6; let dd = 0;
  for (let i = src.indexOf(') {', at) + 2; i < src.length; i++) { if (src[i] === '{') dd++; else if (src[i] === '}' && --dd === 0) return src.slice(at, i + 1); } };
const cst = (name) => { const at = src.indexOf(`const ${name} =`); if (at < 0) throw new Error(`worker.js has no ${name}`); return src.slice(at, src.indexOf(';\n', at) + 1); };
let T;
try {
  T = new Function('db', ['NBA_BOX_STATS', 'NBA_COMBOS', 'NBA_SEASON_FROM', 'TREND_N', 'nbaPropMarket'].map(cst).concat(['nbaStat', 'nbaBoxRows', 'trendOf', 'nbaTrends'].map(wlift)).join('\n')
    + '\nreturn { nbaTrends, nbaBoxRows };')();
} catch (e) { console.log(`  FAIL  the trend lifts out of worker.js (${e.message})`); process.exit(1); }
ok(all("SELECT name FROM sqlite_master WHERE name = 'nba_box_player'").length === 1, "nba_box keeps a player's own games in an index");

console.log('\n-- a row\'s latest price, at its own book --');
let RP;
try {
  RP = new Function(['LINK_BOOKS', 'linkBook', 'parseJsonOr', 'SHARP_MARK'].map(cst).concat(['amProb', 'booksOf', 'rowPriceNow'].map(wlift)).join('\n') + '\nreturn rowPriceNow;')();
} catch (e) { console.log(`  FAIL  rowPriceNow lifts out of worker.js (${e.message})`); process.exit(1); }
const hrow = sq.prepare("SELECT * FROM gmpicks WHERE sport = 'nba' AND game_id = ?").get(HAWKS.id);
const now_ = RP(hrow);
console.log(`  first read ${hrow.entry_price} ${hrow.book}; now ${now_.price} ${now_.book}`);
ok(hrow.book === 'fanduel' && now_.price === 120 && now_.book === 'betmgm', "the Hawks' row was first read at FanDuel's -108; its +120 now is BetMGM's, as its link says");
ok(RP({ ...hrow, link: null }).book === 'betmgm' && RP({ ...hrow, link: 'https://sportsbook.draftkings.com/?outcomes=x' }).book === 'betmgm',
  'with no link, or one whose book is not at that price, the book in its price list at +120');
ok(RP({ ...hrow, link: null, book_prices: null }).book === 'fanduel', "with neither, the row's own book");
for (const gm of ATL) for (const r of T.nbaBoxRows(gm, gm.gameId, gm.date, gm.seasonType)) {
  const cols = Object.keys(r);
  sq.prepare(`INSERT OR REPLACE INTO nba_box (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((k) => norm(r[k])));
}
// Jalen Johnson: his points, rebounds and assists in each game, from the box itself.
const jj = ATL.map((gm) => { for (const t of gm.gamepackageJSON.boxscore.players) for (const a of t.statistics[0].athletes) if (a.athlete.displayName === 'Jalen Johnson') {
  const L = t.statistics[0].labels; return a.stats.length ? ['PTS', 'REB', 'AST'].reduce((s, k) => s + Number(a.stats[L.indexOf(k)]), 0) : null; } return null; }).filter((v) => v != null);
const jid = sq.prepare("SELECT player_id FROM nba_box WHERE player = 'Jalen Johnson'").get().player_id;
const leg = (market, side, line) => ({ legId: `t:${market}:${side}`, spec: { sport: 'nba', playerId: jid, market, side, pp: { line } } });
const tr = await T.nbaTrends(DB, [leg('pra', 'Under', 38.5), leg('blk', 'Over', 0.5), { legId: 'x', spec: { sport: 'nhl', playerId: jid, market: 'pts', side: 'Under', pp: { line: 1 } } }]);
const t = tr.get('t:pra:Under');
console.log(`  PRA ${JSON.stringify(t)} · box ${jj.join(', ')}`);
ok(t && t.vals.join(',') === jj.join(',') && t.vals.length === 5, "his five games' points + rebounds + assists, oldest first");
ok(t && t.hit === jj.filter((v) => v < 38.5).length && t.side === 'under' && t.line === 38.5, 'the unders it would have hit, at the leg\'s own line');
ok(tr.has('t:blk:Over') && tr.get('t:blk:Over').side === 'over' && !tr.has('x'), 'a More counts the games over its line; an NHL leg has none here');

console.log('\n-- the page --');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
// A function ends at its own closing brace, two spaces in: betLinkHtml's
// '{state}' and its placeholder pattern would fool a brace count.
const alift = (name) => { let at = app.indexOf(`  function ${name}(`); const isConst = at < 0; if (isConst) at = app.indexOf(`  const ${name} =`);
  if (at < 0) throw new Error(`app.js has no ${name}`);
  const end = isConst ? app.indexOf(';\n', at) + 1 : app.indexOf('\n  }\n', at) + 4;
  return app.slice(at, end); };
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const state = { bank: { amount: null, cap: 5 } };
let P;
try {
  P = new Function('esc', 'state', 'soccerKick', ['AM', 'BOOK_LABEL', 'bkLabel', 'moneyTxt', 'stakeTxt', 'LINK_BOOK', 'STATE_SLOT', 'betLinkHtml', 'booksHtml', 'priceCheckText', 'impPct', 'priceSparkHtml', 'trendBarsHtml'].map(alift).join('\n')
    + '\nreturn { betLinkHtml, booksHtml, priceCheckText, priceSparkHtml, trendBarsHtml };')(esc, state, (iso) => iso);
} catch (e) { console.log(`  FAIL  the page's pieces lift out of app.js (${e.message})`); process.exit(1); }
const href = (h) => ((h.match(/href="([^"]*)"/) || [])[1] || '').replace(/&amp;/g, '&');
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const BR = linkOf([HAWKS], 'betrivers', 'Atlanta Hawks'), CZR = linkOf([HAWKS], 'williamhill_us', 'Atlanta Hawks');
let h = P.betLinkHtml(DK_ATL);
ok(href(h) === DK_ATL && text(h) === 'Bet at DraftKings ↗' && /target="_blank" rel="noopener noreferrer"/.test(h), "DraftKings' link opens as sent, in a new tab");
ok(href(P.betLinkHtml(FD_ATL)) === FD_ATL, "FanDuel's too");
h = P.betLinkHtml(MGM_ATL);
ok(!/href=/.test(h) && /data-action="bank-open"/.test(h) && text(h) === 'Set your state to open BetMGM', 'BetMGM waits for the state, and says so');
state.bank.state = 'nj';
ok(href(P.betLinkHtml(MGM_ATL)) === MGM_ATL.replace('{state}', 'nj'), "with it, BetMGM's link names it");
ok(href(P.betLinkHtml(CZR)) === CZR.replace('{state}', 'nj'), "Caesars' too");
ok(href(P.betLinkHtml(BR)) === 'https://nj.betrivers.com/?page=sportsbook#event/1028754108', "BetRivers' slip wants a bet type and a stake: its event page instead");
ok(P.betLinkHtml('javascript:alert(1)') === '' && P.betLinkHtml(null) === '' && P.betLinkHtml('http://x.com') === '', 'a link that is not https is no link');
h = P.priceSparkHtml(bet && bet.hist);
console.log(`  ${text(h)}`);
ok((h.match(/<path /g) || []).length === 2 && text(h) === 'opened -108 → +120 now · fair 50%', 'the price line: two lines, the first price and the latest, the fair it held');
ok(P.priceSparkHtml([[bet && bet.hist[0][0], 50, -108]]) === '' && P.priceSparkHtml(null) === '', 'one point is no line');
h = P.trendBarsHtml(t);
console.log(`  ${text(h)}`);
// A box a game since the evening of 2026-10-29: the owner's pick of three.
ok((h.match(/<i class="h">/g) || []).length === t.hit && (h.match(/<i class="[hm]">/g) || []).length === 5 && /class="tb-boxes"/.test(h)
  && (h.match(/<i class="[hm]">(\d+)<\/i>/g) || []).map((x) => x.replace(/<[^>]+>/g, '')).join(',') === jj.join(','), 'a box a game, oldest first, his number in each, the unders filled');
ok(text(h) === `under 38.5 in ${t.hit} of last 5 · avg ${Math.round(jj.reduce((s, v) => s + v, 0) / 5 * 10) / 10} ${jj.join(' ')} oldest → latest`, 'and named: the line, how many went under, his average');
// The bars' own line was .tr-line from the morning of 2026-10-29 until that
// evening: the track record's class for a pick's line, which it pushed out of
// place there. One rule of that name, and it is the track record's.
const css = fs.readFileSync(BOARD + '/style.css', 'utf8').replace(/\r\n/g, '\n');
const trl = css.match(/^\.tr-line \{[^}]*\}/gm) || [];
ok(trl.length === 1 && !/position|border/.test(trl[0]) && !/class="tr-/.test(h), 'the boxes take nothing of the track record\'s tr- classes');
h = P.booksHtml(bet && bet.books);
console.log(`  ${text(h)}`);
ok(/^<details class="pk-books">/.test(h) && text(h).startsWith(`Every book (5) · best MGM +120 · lowest hold MGM ${hold(120, -110).toFixed(1)}%`), 'the fold names the best price and the lowest hold');
ok((h.match(/<span class="bk-r best">/g) || []).length === 1 && (h.match(/<span class="bk-r sh">/g) || []).length === 1 && (h.match(/class="bet-at sm"/g) || []).length === 4,
  'one best row, the sharp one marked, a small bet link on each of the four books');
// Rows of its own since the evening of 2026-10-29: as list items, the Picks
// list's .nba-pp .tc-legs li rule set them to block and the columns ran together.
ok(!/<li\b/.test(h) && /<span class="bk-r bk-h"><span>Book<\/span><span>Price<\/span><span>Hold<\/span>/.test(h) && /<b>\+120<\/b><span class="hd">-2\.2%<\/span>/.test(h),
  'its own rows under a Book, Price, Hold header, each hold a bare percentage');
const chk = (key, price) => text(P.priceCheckText(d, { key, price }));
console.log(`  ${chk(hk.key, '+150')}`);
ok(chk(hk.key, '') === 'Hawks ML: fair 50%, which breaks even at -100 . Type a price to check it.', 'with no price: the fair, and what breaks even');
ok(chk(hk.key, '+150') === 'At +150 : EV +25.0% on a 50% fair · ¼ Kelly 4.2% . Breaks even at -100.', 'a +150 boost on the Hawks: +25% EV, 4.2% at a quarter Kelly');
ok(chk(hk.key, '+200') === 'At +200 : EV +50.0% on a 50% fair · ¼ Kelly 6.3% · more than your 5% daily cap. Breaks even at -100.', 'a stake past the daily cap says so');
ok(chk(hk.key, '-120') === 'At -120 : EV -8.3% · no bet. Hawks ML needs -100 or better.', 'at -120: no bet, and the price it needs');
ok(/under the 1\.5% the list asks of a game line/.test(chk(hk.key, '+102')), 'an edge under the bar says so');
state.bank.amount = 500;
ok(/¼ Kelly \$21 \(4\.2%\)/.test(chk(hk.key, '+150')), 'in dollars once a bankroll is set');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
