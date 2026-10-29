// A logged side keeps its own price after it loses the board's lead
// (2026-10-28).
//
// The game-line log refreshed a row's close only while its side was still
// the board's lead: a capture that led with another side wrote nothing for
// it, so the row stood at the price of the last read that led with it.
// FC Cincinnati's +410 stood 33 hours on Oct 27's 5 AM read. The 12:45 PM
// read on Oct 28 gave the CF Montreal game's lead to the draw, and the edge
// card went on listing CF Montreal +450 (+3.9%) at a price that read had at
// +360 (-4.8%). A favourite that stopped being one would have stayed on
// Picks at its old chance the same way. What has to hold:
//   - every capture hands the writer its quotes for every side (soccer's three
//     ways and both goals sides, the NBA's, NHL's and NFL's two clubs)
//   - a row whose side is not the one led with takes its own side's price and
//     fair from them, at that read; a goals total only at the same line
//   - a row whose side is still the lead updates as it always did, and the
//     entry price and pick stay as logged
//   - the edge card then prices CF Montreal at +360, and leaves it off
//
// Real data: production's MLS rows at 12:45 PM Pacific on Oct 28
// (tests/fixtures/gm-mls-20261028.json) and its MLS board from the read at
// 12:45 PM (tests/fixtures/soccer-board-mls-20261028.json). Real SQLite, the
// real worker, and its own writer.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const ROWS = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'gm-mls-20261028.json'), 'utf8')).rows;
const SB = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'soccer-board-mls-20261028.json'), 'utf8'));
const RealDate = Date;
let NOW = RealDate.parse('2026-10-28T19:46:00Z');
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
globalThis.fetch = async () => new Response('{}', { status: 404 });
const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const exec = (sql, args, mode) => { const st = sq.prepare(sql); const a = args.map(norm);
  if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
  return { success: true, meta: { changes: Number(st.run(...a).changes) } }; };
const DB = { prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
  all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
  run: async () => exec(s.sql, s.args, 'run') }; return s; }, batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')) };
const env = { DB };
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// The writer, lifted from worker.js with what it calls.
// From the body's brace: soccerBoardData's `opts = {}` is in its signature.
const fnOf = (name) => { const at = src.search(new RegExp(`(async )?function ${name}\\(`)); let d = 0;
  for (let i = src.indexOf(') {', at) + 2; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) return src.slice(at, i + 1); } };
const constOf = (name) => { const at = src.indexOf(`const ${name} =`); let d = 0;
  for (let i = at; i < src.length; i++) { const c = src[i]; if ('{(['.includes(c)) d++; else if ('})]'.includes(c)) d--; else if (c === ';' && d === 0) return src.slice(at, i + 1); } };
const W = new Function('ensureGamePickSchema', [constOf('GM_MODEL_VER'), constOf('ML_PRICE_GAP'), constOf('ML_PRICE_MAX'), fnOf('amProb'), fnOf('round1'),
  fnOf('mlPriceSane'), constOf('bookPricesJson'), constOf('soc1x2Quotes'), fnOf('logGamePicks')].join('\n') + '\nreturn { logGamePicks, soc1x2Quotes };')(async () => {});

// ---- production's rows at 12:45 PM ----------------------------------------------------------
await get('/api/gmpicks-export');                                  // the table
const cols = Object.keys(ROWS[0]);
const ins = sq.prepare(`INSERT INTO gmpicks (sport, ${cols.join(',')}) VALUES ('soccer', ${cols.map(() => '?').join(',')})`);
for (const r of ROWS) ins.run(...cols.map((k) => r[k]));
const rowOf = (pick, market = 'h2h') => sq.prepare('SELECT * FROM gmpicks WHERE pick = ? AND market = ?').get(pick, market);
const cfm0 = rowOf('CF Montreal'), cin0 = rowOf('FC Cincinnati');
console.log(`-- 12:45 PM: CF Montreal ${cfm0.close_price} on ${cfm0.win_prob}% (read ${cfm0.close_at}), FC Cincinnati ${cin0.close_price} (read ${cin0.close_at}) --`);

// ---- the 12:45 PM read, written as the board writes it --------------------------------------
// soccerBoardData's three lists (the side led with, the favourite, the goals
// total), from the board's games.
const game = (team) => SB.games.find((g) => g.home === team || g.away === team);
const sideOf = (g, sel) => (sel === 'Draw' ? 'draw' : sel === g.home ? 'home' : 'away');
const lead = SB.games.filter((g) => g.lead && g.lead.price != null && g.lead.fair != null).map((g) => ({
  game_id: g.id, league: g.league, commence: g.commence, side: sideOf(g, g.lead.selection), pick: g.lead.selection, home: g.home, away: g.away,
  win_prob: g.lead.fair, implied: g.lead.implied, edge: g.lead.value, price: g.lead.price, book: g.lead.book, fair_src: g.fairSrc, sharp_n: g.sharpN, quotes: W.soc1x2Quotes(g) }));
const fav = SB.games.filter((g) => g.fav && g.fav.price != null && g.fav.fair != null).map((g) => ({
  game_id: g.id, market: 'fav', league: g.league, commence: g.commence, side: sideOf(g, g.fav.selection), pick: g.fav.selection, home: g.home, away: g.away,
  win_prob: g.fav.fair, implied: g.fav.implied, edge: g.fav.value, price: g.fav.price, book: g.fav.book, fair_src: g.fairSrc, sharp_n: g.sharpN, quotes: W.soc1x2Quotes(g) }));
const logged = await W.logGamePicks(DB, 'soccer', '2026-10-28', [...lead, ...fav]);
ok(logged === lead.length + fav.length, `the writer counts what it logged: ${logged} sides, not its statements`);

console.log('\n-- after the read --');
const cfm = rowOf('CF Montreal'), cin = rowOf('FC Cincinnati'), nyrb = rowOf('New York Red Bulls');
const q = (team) => game(team).oneXtwo.find((p) => p.selection === team);
for (const r of [cfm, cin, nyrb]) console.log(`  ${r.pick}: ${r.close_price} on ${r.win_prob}%, read ${r.close_at} (the board led with ${game(r.pick).lead.selection})`);
ok(game('CF Montreal').lead.selection === 'Draw' && cfm.close_price === q('CF Montreal').price && cfm.win_prob === q('CF Montreal').fair && cfm.close_at === new RealDate(NOW).toISOString(),
  `CF Montreal's row takes its own side's read though the board now leads with the draw: +${cfm.close_price} on ${cfm.win_prob}%, not +450`);
ok(cfm.implied === Math.round(100 / (cfm.close_price + 100) * 1000) / 10 && cfm.edge === Math.round((cfm.win_prob - cfm.implied) * 10) / 10,
  `its implied chance and edge with it (${cfm.implied}%, ${cfm.edge})`);
ok(cin.close_price === q('FC Cincinnati').price && cin.win_prob === q('FC Cincinnati').fair && nyrb.close_price === q('New York Red Bulls').price,
  `and FC Cincinnati's, 33 hours behind, catches up: +${cin.close_price} on ${cin.win_prob}% (the Red Bulls +${nyrb.close_price})`);
ok(cfm.pick === 'CF Montreal' && cfm.entry_price === cfm0.entry_price && cfm.side === 'away', 'the side, the pick and the entry price stay as logged');
const draw = sq.prepare("SELECT * FROM gmpicks WHERE market = 'h2h' AND game_id = ?").get(game('Atlanta United FC').id);
ok(draw.side === 'draw' && draw.close_price === game('Atlanta United FC').oneXtwo[1].price && draw.win_prob === game('Atlanta United FC').oneXtwo[1].fair,
  `a draw row, its game now led by Atlanta: the draw's own read (+${draw.close_price} on ${draw.win_prob}%)`);
const tor = rowOf('Toronto FC', 'fav');
ok(tor.close_price === game('Toronto FC').fav.price && tor.win_prob === game('Toronto FC').fav.fair && tor.close_at === new RealDate(NOW).toISOString(), 'a side still led with updates as it always did');
const stale = sq.prepare('SELECT COUNT(*) AS n FROM gmpicks WHERE close_at < ?').get(new RealDate(NOW).toISOString()).n;
ok(stale === 0, `every row of the read's games is at this read (${stale} behind)`);

// ---- a goals total at another line ----------------------------------------------------------
sq.prepare(`INSERT INTO gmpicks (sport, date, game_id, market, league, commence, side, point, pick, home, away, win_prob, entry_price, close_price, close_at)
  VALUES ('soccer', '2026-10-28', ?, 'totals', 'mls', ?, 'over', 2.5, 'Over 2.5', ?, ?, 50, 100, 100, '2026-10-28T19:00:00.000Z')`).run(game('CF Montreal').id, game('CF Montreal').commence, game('CF Montreal').home, game('CF Montreal').away);
const t = game('CF Montreal').total;
await W.logGamePicks(DB, 'soccer', '2026-10-28', [{ game_id: game('CF Montreal').id, market: 'totals', league: 'mls', commence: game('CF Montreal').commence, side: 'under', point: t.point,
  pick: `Under ${t.point}`, home: game('CF Montreal').home, away: game('CF Montreal').away, win_prob: t.underFair, price: t.underPrice, book: t.underBook,
  quotes: { over: { price: t.overPrice, fair: t.overFair }, under: { price: t.underPrice, fair: t.underFair } } }]);
const tot = sq.prepare("SELECT * FROM gmpicks WHERE market = 'totals' AND game_id = ?").get(game('CF Montreal').id);
ok(t.point !== 2.5 && tot.close_price === 100 && tot.close_at === '2026-10-28T19:00:00.000Z', `an Over 2.5 row is not priced from a read of the ${t.point} line`);

// (Each quote has carried its link and every book's price since 2026-10-29: tests/betlinks.mjs.)
// ---- every capture hands over its quotes ----------------------------------------------------------
ok((fnOf('soccerBoardData').match(/quotes: soc1x2Quotes\(g\)/g) || []).length === 2 && /quotes: \{ over: \{ price: t\.overPrice, fair: t\.overFair[^}]*\},\s*under: \{ price: t\.underPrice, fair: t\.underFair[^}]*\} \}/.test(fnOf('soccerBoardData'))
  && /quotes: \{ home: \{ price: g\.homePrice, fair: g\.homeFair[^}]*\},\s*away: \{ price: g\.awayPrice, fair: g\.awayFair[^}]*\} \}/.test(fnOf('h2hEntries'))
  && /quotes: \{ home: \{ price: g\.home_price, fair: g\.home_fair \}, away: \{ price: g\.away_price, fair: g\.away_fair \} \}/.test(fnOf('nflBoardData')),
  "soccer's three ways and goals sides, and the NBA's, NHL's and NFL's two clubs");

// ---- the edge card ----------------------------------------------------------------------------
console.log('\n-- the edge card at 12:47 PM --');
NOW = RealDate.parse('2026-10-28T19:47:00Z');
const p = await get('/api/picks');
const mls = (p.evBets || []).filter((b) => / · MLS$/.test(b.sub));
console.log('  ' + (mls.map((b) => `${b.label} ${b.price} +${b.ev}%`).join(' | ') || 'no MLS bets'));
ok(!mls.some((b) => /CF Montreal/.test(b.label)) && Math.round((cfm.win_prob / 100 * (1 + cfm.close_price / 100) - 1) * 1000) / 10 < 0,
  `CF Montreal is off the card: +${cfm.close_price} on ${cfm.win_prob}% is ${Math.round((cfm.win_prob / 100 * (1 + cfm.close_price / 100) - 1) * 1000) / 10}%`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
