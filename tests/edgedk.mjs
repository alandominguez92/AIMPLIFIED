// Edge bets at DraftKings only (2026-11-27, the owner's call).
//
// The owner bets PrizePicks first and DraftKings second, and FanDuel not at all, while "Bets with
// an edge" took the best price of up to five books: a bet it named was often one they could not
// place at its price. What has to hold:
//   - a side is a bet at DraftKings' own price, with DraftKings' link; a side whose best price
//     clears the bar at another book, with DraftKings' short of it, is not a bet -- it is still
//     priced, for the closing line and the price checker
//   - a side DraftKings did not quote is not a bet
//   - an NBA under is a bet only at DraftKings' own line: the row's book line is DraftKings' where
//     it quotes the player and FanDuel's where it does not, and DraftKings' main line in
//     book_unders says which
//   - each bet is logged with dk = 1; one logged before at the best book and still to start is
//     the DraftKings card's from its first showing there (its price, book and time), and one the
//     card does not show stays as it was
//   - the record at the top is DraftKings'; the bets before have their own (before), dated by
//     their first and last games; "Last night" keeps every bet with its book
//   - the page: the DraftKings record line or, before any has graded, that it is being kept; the
//     line for the bets before; Picks of the day's close line
//
// Real data: production's NBA and NHL boards of the 8 AM UTC captures on Nov 10 and Nov 11
// (tests/fixtures/nba-board-20261110.json, nhl-board-20261110.json, nba-board-20261111.json,
// nhl-board-20261111.json), with every book's price and link (Hurricanes at Kraken that night was at
// BetRivers alone, with no sharp price, so the scan priced neither side: the pick of the price is
// checked on its sides, and a side DraftKings did not quote is Pritchard's under below, at FanDuel's
// line alone); and production's NBA props read of
// Nets at Celtics at 10:45 PM Pacific on Oct 26 (tests/fixtures/odds-nba-pp-raw-20261027.json),
// made into rows by the worker's own nbaPpLegs (the model's priors are stand-ins: the edge scan
// reads none of the model's numbers). Its pre-tip read is written as that read leaves a row, with
// the sharp books at 60% on three unders so they clear the bar (the read itself had them at 46 to
// 53%). The results are set on the log for the record's arithmetic. Real SQLite and the real
// worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const read = (f) => JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', f), 'utf8'));
const RealDate = Date;
let NOW = RealDate.parse('2026-11-10T08:30:00Z');
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
const asked = [];
globalThis.fetch = async (u) => { asked.push(String(u)); return new Response('{}', { status: 404 }); };
const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const exec = (sql, args, mode) => { const st = sq.prepare(sql); const a = args.map(norm);
  if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
  return { success: true, meta: { changes: Number(st.run(...a).changes) } }; };
const DB = { prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
  all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
  run: async () => exec(s.sql, s.args, 'run') }; return s; }, batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')) };
const env = { DB };
const worker = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(worker).toString('base64'));
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();
const wlift = (name) => { const fn = worker.indexOf(`\nfunction ${name}(`);
  if (fn >= 0) { let d = 0; for (let i = worker.indexOf('{', fn); i < worker.length; i++) { if (worker[i] === '{') d++; else if (worker[i] === '}' && --d === 0) return worker.slice(fn + 1, i + 1); } }
  const at = worker.search(new RegExp(`\\n(const|let) ${name} =`));
  if (at < 0) throw new Error(`worker.js has no ${name}`);
  let d = 0;
  for (let i = at + 1; i < worker.length; i++) { const c = worker[i]; if ('{(['.includes(c)) d++; else if ('})]'.includes(c)) d--; else if (c === ';' && d === 0) return worker.slice(at + 1, i + 1); } };

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const dec = (am) => (am > 0 ? 1 + am / 100 : 1 + 100 / -am);
const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;
const evAt = (fair, price) => r1((fair / 100 * dec(price) - 1) * 100);
const putBoard = (k, b) => sq.prepare('INSERT OR REPLACE INTO feed_cache (key, data, updated_at, claimed_until) VALUES (?, ?, ?, 0)').run(k, JSON.stringify(b), RealDate.parse(b.asOf));
const priced = (d, label) => (d.priced || []).find((x) => x.label === label);

await get('/api/gmpicks-export'); await get('/api/nba-pp'); await get('/api/picks');      // the tables

// ---- Nov 10: the Jazz ---------------------------------------------------------------------------
console.log('-- 12:30 AM Pacific, Nov 10 --');
const NBA10 = read('nba-board-20261110.json'), NHL10 = read('nhl-board-20261110.json');
putBoard('nba_board:reg', NBA10); putBoard('nhl_board:reg', NHL10);
let p = await get('/api/picks');
const jazz = NBA10.games.find((g) => g.home === 'Utah Jazz');
const dkJazz = jazz.bookPrices.home.draftkings[0];
console.log(`  Jazz: best ${jazz.homePrice} ${jazz.homeBook} (+${evAt(jazz.homeFair, jazz.homePrice)}%), DraftKings ${dkJazz} (${evAt(jazz.homeFair, dkJazz)}%), fair ${jazz.homeFair}%`);
ok(jazz.homeBook === 'fanduel' && jazz.homePrice === 350 && evAt(jazz.homeFair, 350) >= 1.5 && dkJazz === 321 && evAt(jazz.homeFair, dkJazz) < 1.5,
  `the Jazz on ${jazz.homeFair}%: FanDuel's +350 cleared the 1.5% bar (+${evAt(jazz.homeFair, 350)}%), DraftKings' +321 does not (${evAt(jazz.homeFair, dkJazz)}%)`);
ok(!(p.evBets || []).some((b) => /Jazz/.test(b.label)) && priced(p, 'Jazz ML') && priced(p, 'Jazz ML').fair === jazz.homeFair,
  'so the Jazz are not a bet (FanDuel\'s +350 was one until Nov 27); still priced, for the checker and the close');
ok(!asked.some((u) => u.includes('the-odds-api.com')), 'nothing bought');

// ---- Nov 11: the Bucks, and a side DraftKings did not price -------------------------------------
console.log('\n-- 12:30 AM Pacific, Nov 11 --');
NOW = RealDate.parse('2026-11-11T08:30:00Z');
const NBA11 = read('nba-board-20261111.json'), NHL11 = read('nhl-board-20261111.json');
putBoard('nba_board:reg', NBA11); putBoard('nhl_board:reg', NHL11);
p = await get('/api/picks');
const bucks = NBA11.games.find((g) => g.home === 'Milwaukee Bucks'), sea = NHL11.games.find((g) => g.home === 'Seattle Kraken');
console.log(`  Bucks: best ${bucks.homePrice} ${bucks.homeBook}, DraftKings ${bucks.bookPrices.home.draftkings[0]}; Kraken: ${Object.keys(sea.bookPrices.home).join(', ')}`);
ok(bucks.homeBook === 'fanduel' && evAt(bucks.homeFair, bucks.homePrice) >= 1.5 && !(p.evBets || []).some((b) => /Bucks/.test(b.label)) && priced(p, 'Bucks ML'),
  `the Bucks: FanDuel's +${bucks.homePrice} cleared it, DraftKings' +${bucks.bookPrices.home.draftkings[0]} did not; priced, not a bet`);

// The pick of the price, on the real Bucks side as the scan sees it.
let W;
try {
  W = new Function(['EDGE_BOOK', 'SHARP_MARK', 'amProb', 'booksOf', 'LINK_BOOKS', 'linkBook', 'atEdgeBook'].map(wlift).join('\n') + '\nreturn { atEdgeBook, booksOf };')();
} catch (e) { console.log(`  FAIL  atEdgeBook lifts out of worker.js (${e.message})`); process.exit(1); }
const bSide = { book: bucks.homeBook, price: bucks.homePrice, link: bucks.homeLink, books: W.booksOf(bucks.bookPrices.home, bucks.links.home) };
const bDk = W.atEdgeBook(bSide);
ok(bDk && bDk.price === bucks.bookPrices.home.draftkings[0] && bDk.book === 'draftkings' && bDk.link === bucks.links.home.draftkings && bucks.homeLink !== bDk.link,
  `at DraftKings: +${bDk && bDk.price}, with DraftKings' own link, not FanDuel's`);
const seaSides = ['home', 'away'].map((s) => W.atEdgeBook({ book: sea[s + 'Book'], price: sea[s + 'Price'], link: sea[s + 'Link'] || null,
  books: W.booksOf(sea.bookPrices[s], sea.links && sea.links[s]) }));
ok(Object.keys(sea.bookPrices.home).join() === 'betrivers' && Object.keys(sea.bookPrices.away).join() === 'betrivers' && seaSides.every((x) => x === null),
  'and none on either side of Hurricanes at Kraken, quoted at BetRivers alone');

// ---- Oct 27: NBA unders at DraftKings' own line ---------------------------------------------------
console.log('\n-- 3:30 PM Pacific, Oct 27: Nets at Celtics --');
sq.prepare("DELETE FROM feed_cache WHERE key IN ('nba_board:reg', 'nhl_board:reg')").run();
const RAW = read('odds-nba-pp-raw-20261027.json'), ev = RAW.payload;
let L;
try {
  L = new Function(['NBA_SHARP', 'NBA_PROP_SHARP', 'amProb', 'shinDevig', 'poissonCdf', 'negBinomCdf', 'round1', 'normName', 'NFL_NAME_SUFFIX', 'nflBaseName',
    'nbaBaseName', 'NBA_NAME_ALIAS', 'NBA_ALIAS', 'nbaName', 'nbaSharpUnder', 'NBA_DISP', 'DFS_BOOKS', 'bookUndersJson', 'NBA_PP_MARKETS', 'NBA_PRIOR_K', 'nbaPpLegs'].map(wlift).join('\n')
    + '\nreturn { nbaPpLegs, nbaName };')();
} catch (e) { console.log(`  FAIL  nbaPpLegs lifts out of worker.js (${e.message})`); process.exit(1); }
const byName = new Map();
for (const m of ev.bookmakers.find((b) => b.key === 'prizepicks').markets) for (const o of m.outcomes) byName.set(L.nbaName(o.description), { id: o.description, gp: 10, tm: null, threes: 2, ast: 4, reb: 6, blk: 1, stl: 1, min: 30 });
const legs = L.nbaPpLegs(ev, { byName }, new Map());
const leg = (player, market) => legs.find((x) => x.player === player && x.market === market);
const SHA = leg("Day'Ron Sharpe", 'ast'), WHI = leg('Derrick White', 'threes'), PRI = leg('Payton Pritchard', 'ast');
const bu = (x) => JSON.parse(x.book_unders);
console.log('  ' + [SHA, WHI, PRI].map((x) => `${x.player} ${x.market} ${x.point}: book ${x.book_line} @ ${x.book_under}, DraftKings ${JSON.stringify(bu(x).draftkings || null)}`).join(' | '));
ok(bu(SHA).draftkings[0] === SHA.book_line && bu(WHI).draftkings[0] === WHI.book_line && !bu(PRI).draftkings && bu(PRI).fanduel[0] === PRI.book_line && PRI.book_under === -128,
  "the read: DraftKings' own line on Sharpe's assists and White's threes; Pritchard's assists at FanDuel's 4.5 alone, -128");
const ptDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new RealDate(iso));
const ins = sq.prepare(`INSERT INTO nbapp (date, game_id, player, market, commence, home, away, point, model_under, min_proj, book_line, book_under, sharp_under, book_unders, captured_at, model_ver)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'nbapp-v1')`);
for (const x of legs) ins.run(...[ptDay(x.commence), x.game_id, x.player, x.market, x.commence, x.home, x.away, x.point, x.model_under, x.min_proj, x.book_line, x.book_under, x.sharp_under, x.book_unders, RAW.at].map(norm));
// The pre-tip read at 3:15 PM, as it leaves a row, the sharp books at 60%.
for (const x of [SHA, WHI, PRI]) {
  sq.prepare("UPDATE nbapp SET close_point = point, close_under = model_under, close_book_line = book_line, close_book_under = book_under, close_sharp_under = 60, close_at = '2026-10-27T22:15:00Z' WHERE player = ? AND market = ?").run(x.player, x.market);
}
// The log before Nov 27, as it had them at the 3:16 PM read: both at "DK/FD", the old book.
const keyOf = (x) => `nbapp:${x.game_id}:${x.player}:${x.market}`;
const MK = { ast: 'AST', threes: '3PM' };
const oldRow = sq.prepare(`INSERT INTO edgebets (date, key, sport, market, label, sub, commence, book, fair_src, prop, grade, first_at, first_price, first_fair, first_ev, first_stake,
  last_at, last_price, last_fair, last_ev, close_at, close_price, close_fair, off) VALUES (?,?,'nba',?,?,'Nets @ Celtics',?,'DK/FD','sharp books',1,?,?,?,60,?,0.5,?,?,60,?,?,?,60,0)`);
for (const x of [SHA, PRI]) {
  const at = '2026-10-27T22:16:00Z', e = evAt(60, x.book_under);
  oldRow.run('2026-10-27', keyOf(x), x.market, `${x.player} Under ${x.point} ${MK[x.market]}`, x.commence,
    JSON.stringify({ t: 'under', date: '2026-10-27', game_id: x.game_id, player: x.player, market: x.market, line: x.point }), at, x.book_under, e, at, x.book_under, e, at, x.book_under);
}
NOW = RealDate.parse('2026-10-27T22:30:00Z');
p = await get('/api/picks');
const E = p.evBets || [];
console.log('  ' + E.map((b) => `${b.label} ${b.price} ${b.book} +${b.ev}%`).join(' | '));
const lb = (x) => `${x.player} Under ${x.point} ${MK[x.market]}`;
const sb = E.find((b) => b.label === lb(SHA)), wb = E.find((b) => b.label === lb(WHI));
ok(sb && sb.book === 'draftkings' && sb.price === SHA.book_under && sb.ev === evAt(60, SHA.book_under) && wb && wb.book === 'draftkings' && wb.price === WHI.book_under,
  `Sharpe's and White's unders, at DraftKings' line, are bets at its prices: ${sb && sb.price} (+${sb && sb.ev}%), ${wb && wb.price} (+${wb && wb.ev}%)`);
ok(!E.some((b) => b.label === lb(PRI)) && priced(p, lb(PRI)) && evAt(60, PRI.book_under) >= 3,
  `Pritchard's, FanDuel's -128 on the same 60% (+${evAt(60, PRI.book_under)}%), is priced and not a bet: it was one until Nov 27`);
ok(E.length === 2 && E.every((b) => b.book === 'draftkings'), 'nothing else, and every bet at DraftKings');

const log = (x) => sq.prepare('SELECT * FROM edgebets WHERE key = ?').get(keyOf(x)) || {};
const nowIso = new RealDate(NOW).toISOString();
ok(log(SHA).dk === 1 && log(SHA).book === 'draftkings' && log(SHA).first_at === nowIso && log(SHA).first_price === SHA.book_under,
  `Sharpe's, logged at "DK/FD" at 3:16, is the DraftKings card's from its first showing there: book ${log(SHA).book}, dk ${log(SHA).dk}, first at ${log(SHA).first_at}`);
ok(log(WHI).dk === 1 && log(WHI).book === 'draftkings' && log(WHI).first_price === WHI.book_under && log(WHI).off === 0, "White's, new, goes in with dk = 1");
ok(log(PRI).dk == null && log(PRI).book === 'DK/FD' && log(PRI).first_at === '2026-10-27T22:16:00Z', "Pritchard's, not on the DraftKings card, stays as the log had it");

// ---- the record ------------------------------------------------------------------------------------
console.log('\n-- Oct 28, graded --');
const setRes = (x, res) => sq.prepare("UPDATE edgebets SET result = ?, graded_at = '2026-10-28T08:00:00Z' WHERE key = ?").run(res, keyOf(x));
setRes(SHA, 'hit'); setRes(WHI, 'miss'); setRes(PRI, 'hit');
NOW = RealDate.parse('2026-10-28T15:00:00Z');
p = await get('/api/picks');
const R = p.edgeRecord || {};
console.log('  record ' + JSON.stringify({ ...R, byDay: undefined }));
const clvOf = (x) => (log(x).close_fair / 100 * dec(log(x).first_price) - 1) * 100;
ok(R.book === 'draftkings' && R.bookFrom === '2026-11-27' && R.since === '2026-10-27' && R.n === 2 && R.hit === 1 && R.units === r2(dec(SHA.book_under) - 1 - 1)
  && R.clv.n === 2 && R.clv.avg === r1((clvOf(SHA) + clvOf(WHI)) / 2),
  `the record at the top is DraftKings': Sharpe's and White's, 1 of 2, ${R.units}u, beat the close ${R.clv && R.clv.beat} of ${R.clv && R.clv.n}`);
ok(R.before && R.before.n === 1 && R.before.hit === 1 && R.before.units === r2(dec(PRI.book_under) - 1) && R.before.since === '2026-10-27' && R.before.until === '2026-10-27',
  `the bet before on its own line: Pritchard's, 1 of 1, +${R.before && R.before.units}u, Oct 27 to Oct 27`);
const d27 = R.byDay && R.byDay['2026-10-27'];
ok(d27 && d27.n === 3 && d27.bets.map((b) => `${b.label}|${b.book}`).sort().join(';') === [`${lb(PRI)}|DK/FD`, `${lb(SHA)}|draftkings`, `${lb(WHI)}|draftkings`].sort().join(';'),
  `"Last night" keeps every bet the card showed, each with its book (${d27 && d27.bets.map((b) => `${b.label} ${b.book}`).join(', ')})`);

// ---- the page ---------------------------------------------------------------------------------------
console.log('\n-- the page --');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const alift = (name) => { const at2 = app.indexOf(`function ${name}(`); if (at2 < 0) throw new Error(`app.js has no ${name}`); let d = 0;
  for (let i = app.indexOf('{', at2); i < app.length; i++) { if (app[i] === '{') d++; else if (app[i] === '}' && --d === 0) return app.slice(at2, i + 1); } };
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const shortDay = (d) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new RealDate(d + 'T12:00:00Z'));
let A;
try {
  A = new Function('esc', 'AM', 'shortDay', 'ptDayOf', 'recapDay', [alift('edgeRecordHtml'), alift('recapHtml')].join('\n') + '\nreturn { edgeRecordHtml, recapHtml };')(
    esc, (o) => (o > 0 ? '+' + o : String(o)), shortDay, (t) => ptDay(new RealDate(t).toISOString()), () => '');
} catch (e) { console.log(`  FAIL  the record lines lift out of app.js (${e.message})`); process.exit(1); }
const u = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}u`;
const h = text(A.edgeRecordHtml(R));
console.log(`  ${h}`);
ok(h.startsWith(`At DraftKings since Oct 27: 1 of 2 won · ${u(R.units)} at 1 unit each · beat the closing line ${R.clv.beat} of 2 (average +${R.clv.avg}%)`)
  && h.includes(`Before, at the best book's price, Oct 27 to Oct 27: 1 of 1 won · ${u(R.before.units)} at 1 unit each`),
  'the card: the DraftKings record, then the bets before on a line of their own');
const fresh = { ...R, n: 0, hit: 0, units: 0, since: null, clv: { n: 0, beat: 0, avg: null } };
const hf = text(A.edgeRecordHtml(fresh));
ok(hf.startsWith('At DraftKings from Nov 27: each bet as first shown, its closing price, and how it went. None graded yet.') && hf.includes('Before, at the best book\'s price'),
  `before a DraftKings bet has graded: "${hf.split(' Before,')[0]}"`);
ok(text(A.edgeRecordHtml({ since: '2026-10-28', n: 1, hit: 1, units: 1, clv: { n: 1, beat: 1, avg: 2 } })).startsWith('These bets since Oct 28: 1 of 1 won'),
  'a record from a worker before DraftKings only reads as it did');
const pod = (e) => text(A.recapHtml(null, e, false));
ok(pod(R).includes(`At DraftKings since Oct 27 the edge bets have beaten the close ${R.clv.beat} of 2`), `Picks of the day: "${pod(R).split(' · ')[0].replace(/^.*?logged as shown /, '')}"`);
ok(pod(fresh).includes(`From Oct 27 to Oct 27, at the best book's price, the edge bets beat the close ${R.before.clv.beat} of ${R.before.clv.n}`),
  'and, before DraftKings has a close, the bets before, dated');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
