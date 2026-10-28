// The edge bets' own record, fresh prices behind them, and Picks in the order
// the night asks (2026-10-28).
//
// "Bets with an edge" named bets and kept nothing: nobody could say whether
// its edges were real. And the page led with its likeliest leg -- the Spurs
// at -520, 2.4 points short of the price and a leg PrizePicks does not take.
// The owner's call: log and grade the edge bets with their closing-line
// value, refresh a price shown on an old read, lead with the PrizePicks
// entry, and read the stakes in dollars. What has to hold:
//   - each edge bet is logged the first time the card shows it, at that price,
//     fair, EV and stake; a read with nothing changed writes nothing
//   - its close is the last read of the same side before the start, whether
//     or not it still clears the bar
//   - it grades from the game's own log: a moneyline by the final (the dog's
//     side of a row that logged the favourite as well), a soccer side by the
//     score, three ways
//   - the record: won and lost, units flat and at quarter Kelly, and how many
//     beat the close (EV at the first price on the closing fair)
//   - a bet shown on a price over four hours old buys one read of its league,
//     at most once per league every three hours and eight a day
//   - Picks leads with the PrizePicks entry, then the sportsbook bets, then the
//     likeliest legs; the stakes read in dollars against a bankroll, and the
//     day's sportsbook bets together keep to its daily cap
//
// Real data: production at 1:50 PM Pacific on Oct 27 (tests/fixtures/
// evbets-20261027.json: the NBA and NHL boards, the soccer and NBA props logs)
// and its Oct 27 finals with their closing fairs and prices (tests/fixtures/
// edgebets-finals-20261027.json). FC Cincinnati +410 and Tijuana +600 are the
// card's own bets that day; they play later. The four graded here are real
// games at prices raised to clear the bar -- had a book posted the Blazers at
// +400, the Canucks at +300, Como at +150 and the Torino-Como draw at +400 --
// read at 9 AM, before the Serie A kickoffs. A closing read keeps the
// underdog's 7 AM price, which the export does not carry. Real SQLite and the
// real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const F = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'evbets-20261027.json'), 'utf8'));
const FIN = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'edgebets-finals-20261027.json'), 'utf8')).rows;
const RealDate = Date;
let NOW = RealDate.parse('2026-10-27T16:00:00Z');
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
const dec = (am) => (am > 0 ? 1 + am / 100 : 1 + 100 / -am);
const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;

// ---- the logs at 9 AM, with the four prices raised ------------------------------------------
await get('/api/gmpicks-export'); await get('/api/nba-pp'); await get('/api/picks');      // the tables
const board = (b, fix) => ({ ...b, games: b.games.map((g) => fix(g) || g) });
const putBoard = (k, b) => sq.prepare('INSERT OR REPLACE INTO feed_cache (key, data, updated_at, claimed_until) VALUES (?, ?, ?, 0)').run(k, JSON.stringify(b), RealDate.parse(b.asOf));
const LAL = '82afe4e0', ANA = '5f16cb74';
putBoard('nba_board:reg', board(F.nbaBoard, (g) => g.id.startsWith(LAL) && { ...g, awayPrice: 400, awayBook: 'draftkings' }));
putBoard('nhl_board:reg', board(F.nhlBoard, (g) => g.id.startsWith(ANA) && { ...g, awayPrice: 300, awayBook: 'draftkings' }));
const gcols = Object.keys(F.gm[0]);
const gins = sq.prepare(`INSERT OR IGNORE INTO gmpicks (${gcols.join(',')}) VALUES (${gcols.map(() => '?').join(',')})`);
for (const r of F.gm) gins.run(...gcols.map((k) => r[k]));
const TOR = F.gm.find((r) => r.home === 'Torino').game_id;
sq.prepare("UPDATE gmpicks SET close_price = 150 WHERE game_id = ? AND market = 'fav'").run(TOR);
sq.prepare("UPDATE gmpicks SET close_price = 400 WHERE game_id = ? AND market = 'h2h'").run(TOR);
// The NBA, NHL and soccer rows the finals export grades: the boards' own logs.
for (const f of FIN.filter((x) => x.sport !== 'soccer')) {
  const g = [...F.nbaBoard.games, ...F.nhlBoard.games].find((x) => x.id === f.game_id);
  sq.prepare(`INSERT OR IGNORE INTO gmpicks (sport, date, market, league, commence, away, home, side, pick, win_prob, entry_price, close_price, game_id, model_ver)
    VALUES (?, ?, 'h2h', 'reg', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'gm-v2')`).run(f.sport, f.date, g.commence, f.away, f.home, f.side, f.pick,
    f.side === 'home' ? g.homeFair : g.awayFair, f.side === 'home' ? g.homePrice : g.awayPrice, f.side === 'home' ? g.homePrice : g.awayPrice, f.game_id);
}

console.log('-- 9 AM Pacific, Oct 27 --');
let p = await get('/api/picks');
for (const b of p.evBets) console.log(`  ${b.label} ${b.price}: fair ${b.fair}% -> +${b.ev}%, stake ${b.stake}%`);
const log = () => sq.prepare('SELECT * FROM edgebets ORDER BY first_ev DESC').all();
let rows = log();
const row = (re) => rows.find((r) => re.test(r.label)) || {};
const want = ['Blazers ML', 'Canucks ML', 'Como ML', 'Draw', 'FC Cincinnati ML', 'Tijuana ML'];
ok(rows.length === p.evBets.length && want.every((w) => rows.some((r) => r.label === w)) && p.evBets.every((b) => rows.some((r) => r.label === b.label && r.first_price === b.price && r.first_fair === b.fair && r.first_ev === b.ev && r.first_stake === b.stake)),
  `each bet on the card is logged at the price, fair, EV and stake it showed (${rows.map((r) => r.label).join(', ')})`);
const cin = row(/FC Cincinnati/), tij = row(/Tijuana/);
ok(cin.first_price === 410 && cin.first_fair === 20.7 && cin.first_ev === 5.6 && tij.first_price === 600 && tij.first_fair === 14.6,
  "the card's own bets that day, as production priced them: FC Cincinnati +410 on 20.7%, Tijuana +600 on 14.6%");
ok(!('key' in p.evBets[0]) && !('grade' in p.evBets[0]), 'the page is sent the bets, not how they grade');

const before = JSON.stringify(rows.map((r) => [r.last_at, r.close_at]));
NOW = RealDate.parse('2026-10-27T16:15:00Z');
await get('/api/picks');
rows = log();
ok(JSON.stringify(rows.map((r) => [r.last_at, r.close_at])) === before, 'a read a quarter-hour later with nothing changed writes nothing');

// ---- the closes ---------------------------------------------------------------------------------
console.log('\n-- the closing reads --');
// Before the Serie A kickoffs: the rows as the export left them.
NOW = RealDate.parse('2026-10-27T17:20:00Z');
for (const f of FIN.filter((x) => x.sport === 'soccer')) {
  sq.prepare('UPDATE gmpicks SET win_prob = ?, close_price = ?, close_at = ? WHERE game_id = ? AND market = ? AND pick = ?').run(f.win_prob, f.close_price, f.close_at, f.game_id, f.market, f.pick);
}
await get('/api/picks');
// Before the NHL and NBA late games: each game's closing fair from its row,
// the favourite's closing price, the underdog's 7 AM one.
NOW = RealDate.parse('2026-10-28T01:30:00Z');
const closeBoard = (b) => ({ ...b, asOf: '2026-10-28T01:15:00Z', games: b.games.map((g) => {
  const f = FIN.find((x) => x.game_id === g.id);
  if (!f) return g;
  const home = f.side === 'home' ? f.win_prob : r1(100 - f.win_prob);
  return { ...g, homeFair: home, awayFair: r1(100 - home), ...(f.side === 'home' ? { homePrice: f.close_price } : { awayPrice: f.close_price }) };
}) });
putBoard('nba_board:reg', closeBoard(F.nbaBoard));
putBoard('nhl_board:reg', closeBoard(F.nhlBoard));
p = await get('/api/picks');
rows = log();
for (const r of rows) console.log(`  ${r.label}: first ${r.first_price} on ${r.first_fair}% -> close ${r.close_price} on ${r.close_fair}%`);
const fin = (re, mk) => FIN.find((x) => re.test(`${x.away} @ ${x.home}`) && (!mk || x.market === mk));
ok(row(/Blazers/).close_fair === r1(100 - fin(/Lakers/).win_prob) && row(/Blazers/).close_price === 122 && row(/Canucks/).close_fair === r1(100 - fin(/Ducks/).win_prob),
  `the close is the last read of the side, off the card or not: the Blazers closed on ${row(/Blazers/).close_fair}% (the Lakers ${fin(/Lakers/).win_prob}%), the Canucks on ${row(/Canucks/).close_fair}%`);
ok(row(/Como ML/).close_fair === fin(/Torino/, 'fav').win_prob && row(/Como ML/).close_price === fin(/Torino/, 'fav').close_price && row(/^Draw$/).close_fair === fin(/Torino/, 'h2h').win_prob,
  'and a soccer side closes at its row\'s last read, before its kickoff');
ok(!p.evBets.some((b) => /Canucks|Como|Draw/.test(b.label)) && row(/Canucks/).first_price === 300, 'off the card by then, the first read still stands as the bet');

// ---- graded, the next morning -----------------------------------------------------------------
console.log('\n-- Oct 28, graded --');
for (const f of FIN) {
  sq.prepare('UPDATE gmpicks SET result = ?, home_score = ?, away_score = ? WHERE game_id = ? AND market = ? AND pick = ?')
    .run(f.result, f.home_score, f.away_score, f.game_id, f.market, f.pick);
}
NOW = RealDate.parse('2026-10-28T15:00:00Z');
p = await get('/api/picks');
rows = log();
for (const r of rows) console.log(`  ${r.label}: ${r.result}`);
ok(row(/Blazers/).result === 'hit' && row(/Canucks/).result === 'hit',
  "the underdogs by the favourites' rows: the Lakers lost 136-129 and the Ducks 6-5, so the Blazers and the Canucks landed");
ok(row(/Como ML/).result === 'hit' && row(/^Draw$/).result === 'miss', 'soccer by the score, three ways: Como won 3-1 at Torino, so the draw missed');
ok(row(/FC Cincinnati/).result == null && row(/Tijuana/).result == null, 'the two still to play stay open');

const graded = rows.filter((r) => r.result === 'hit' || r.result === 'miss');
const flat = r2(graded.reduce((s, r) => s + (r.result === 'hit' ? dec(r.first_price) - 1 : -1), 0));
const clv = graded.map((r) => (r.close_fair / 100 * dec(r.first_price) - 1) * 100);
const R = p.edgeRecord;
console.log('  record ' + JSON.stringify(R));
ok(R && R.n === 4 && R.hit === 3 && R.units === flat && R.since === '2026-10-27',
  `the record: 3 of 4 won, ${flat}u at a unit each`);
ok(R.kellyUnits === r2(graded.reduce((s, r) => s + r.first_stake * (r.result === 'hit' ? dec(r.first_price) - 1 : -1), 0)), `and ${R.kellyUnits}% of the bankroll at the quarter-Kelly stakes shown`);
ok(R.clv.n === 4 && R.clv.beat === clv.filter((v) => v > 0).length && R.clv.avg === r1(clv.reduce((a, v) => a + v, 0) / 4),
  `beat the close ${R.clv.beat} of ${R.clv.n}, by ${R.clv.avg}% on average (EV at the first price on the closing fair)`);

// ---- fresh prices ---------------------------------------------------------------------------------
console.log('\n-- fresh prices --');
const wlift = (name) => { const at = src.indexOf(`async function ${name}(`); let d = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) return src.slice(at, i + 1); } };
const consts = ['EDGE_STALE_MS', 'EDGE_REFRESH_GAP_MS', 'EDGE_REFRESH_MAX'].map((n) => src.slice(src.indexOf(`const ${n} =`), src.indexOf(';\n', src.indexOf(`const ${n} =`)) + 1)).join('\n');
const reads = [], store = {};
const refresh = new Function('h2hCapture', 'soccerIngest', 'ingestNflLines', 'nflBoardData', 'loadFeedCache', 'saveFeedCache', 'ptDateOf', 'NBA_ML', 'NHL_ML', 'SOCCER_LEAGUES',
  consts + '\n' + wlift('refreshEdgePrices') + '\nreturn refreshEdgePrices;')(
  async (e, cfg, lg) => reads.push(`${cfg.sport}:${lg}`), async (e, u) => reads.push(`soccer:${u.searchParams.get('league')}`), async () => reads.push('nfl'), async () => {},
  async (db, k) => (k in store ? { present: true, data: store[k] } : { present: false }), async (db, k, v) => { store[k] = JSON.parse(JSON.stringify(v)); },
  (t) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new RealDate(t)), { sport: 'nba' }, { sport: 'nhl' }, { mls: {}, ligamx: {} });
const at = RealDate.parse('2026-10-27T21:00:00Z');
const scan = { bets: [{ sport: 'soccer', league: 'mls', asOf: '2026-10-27T12:05:55.302Z' }, { sport: 'soccer', league: 'ligamx', asOf: '2026-10-27T20:30:32.836Z' },
  { sport: 'nba', asOf: '2026-10-27T07:00:37.980Z', prop: true }] };
await refresh({ ODDS_API_KEY: 'k' }, scan, at);
ok(reads.join() === 'soccer:mls', "FC Cincinnati's +410, nine hours old at 2 PM, buys one MLS read; Tijuana's, half an hour old, and a prop's buy none");
await refresh({ ODDS_API_KEY: 'k' }, scan, at + 3600e3);
await refresh({ ODDS_API_KEY: 'k' }, scan, at + 3 * 3600e3 + 1);
ok(reads.join() === 'soccer:mls,soccer:mls', 'not again within three hours; again after');
// Every league stale at once, three times through the same Pacific day.
reads.length = 0;
for (const k of Object.keys(store)) delete store[k];
const old = '2026-10-27T00:00:00Z';
const every = { bets: [{ sport: 'nba', asOf: old }, { sport: 'nhl', asOf: old }, { sport: 'nfl', asOf: old }, { sport: 'soccer', league: 'mls', asOf: old }, { sport: 'soccer', league: 'ligamx', asOf: old }] };
for (const t of [at, at + 3 * 3600e3 + 1, at + 6 * 3600e3 + 2]) await refresh({ ODDS_API_KEY: 'k' }, every, t);
ok(reads.length === 8 && reads.slice(0, 5).join() === 'nba:reg,nhl:reg,nfl,soccer:mls,soccer:ligamx', `eight reads a day at most, then none (${reads.join(', ')})`);

// ---- the page ------------------------------------------------------------------------------------
console.log('\n-- the page --');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const alift = (name) => { const at2 = app.indexOf(`function ${name}(`); let d = 0;
  for (let i = app.indexOf('{', at2); i < app.length; i++) { if (app[i] === '{') d++; else if (app[i] === '}' && --d === 0) return app.slice(at2, i + 1); } };
const aconst = (name) => { const a = app.indexOf(`const ${name} =`); return app.slice(a, app.indexOf(';\n', a) + 1); };
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const ui = { bank: { amount: null, cap: 5 } };
const P = new Function('esc', 'AM', 'pct0', 'soccerKick', 'PICK_SPORT', 'state', 'shortDay',
  [aconst('moneyTxt'), aconst('stakeTxt'), alift('bankHtml'), alift('evBetsHtml'), alift('edgeRecordHtml'), alift('pickemHtml')].join('\n') + '\nreturn { evBetsHtml, edgeRecordHtml, bankHtml };')(
  esc, (o) => (o > 0 ? '+' + o : String(o)), (v) => `${Math.round(v)}%`, (t) => t, { nba: 'NBA', nhl: 'NHL', soccer: 'Soccer', nfl: 'NFL' }, ui,
  (d) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new RealDate(d + 'T12:00:00Z')));
ok(text(P.edgeRecordHtml(R)) === `These bets since Oct 27: 3 of 4 won · +${flat.toFixed(2)}u at 1 unit each · beat the closing line ${R.clv.beat} of 4 (average ${R.clv.avg > 0 ? '+' : ''}${R.clv.avg}%)`,
  `the card's record line: "${text(P.edgeRecordHtml(R))}"`);
ok(/Logged from Oct 28/.test(P.edgeRecordHtml({ n: 0, clv: { n: 0 } })), 'and before any has graded, that they are being kept');
// The four at 9 AM, as the card showed them, against a $500 bankroll.
NOW = RealDate.parse('2026-10-27T16:00:00Z');
const nine = log().map((r) => ({ label: r.label, sub: r.sub, sport: r.sport, commence: r.commence, price: r.first_price, fair: r.first_fair, ev: r.first_ev, stake: r.first_stake, betAt: 0, book: r.book }));
const raw = nine.reduce((s, b) => s + b.stake, 0);
ui.bank = { amount: 500, cap: 5 };
const h = text(P.evBetsHtml({ evBets: nine, edgeRecord: R }));
console.log('  ' + h.slice(0, 900));
const scale = 5 / raw, blz = nine.find((b) => /Blazers/.test(b.label));
const blzStake = Math.round(blz.stake * scale * 100) / 100;
const blzUsd = (500 * blzStake / 100).toFixed(2);   // under $10, to the cent
ok(raw > 5 && new RegExp(`Held to your 5% daily cap: each stake is ${Math.round(scale * 100)}% of its Kelly`).test(h)
  && h.includes(`¼ Kelly $${blzUsd} (${blzStake}%)`) && /¼ Kelly total \$25 \(5%\)/.test(h),
  `the day's bets together (${r1(raw)}% of Kelly) held to the 5% cap, each in dollars: the Blazers $${blzUsd}, $25 in all`);
ok(/Bankroll <b>\$500<\/b> · daily cap 5% \(\$25\)/.test(P.bankHtml()) && /data-action="bank-amount"/.test(P.bankHtml()), 'the bankroll and its cap fold above the cards');
ui.bank = { amount: null, cap: 5 };
ok(/Set your bankroll to see each stake in dollars/.test(P.bankHtml()) && /¼ Kelly \d+(\.\d+)?%/.test(text(P.evBetsHtml({ evBets: [nine[4]] }))), 'without one, a stake reads as a share');
const rp = alift('renderPicks');
ok(/grid\.innerHTML = bankHtml\(\) \+ ppCard \+ evBetsHtml\(d\) \+ listCard \+ after;/.test(rp) && /<span class="tc-title">Your PrizePicks entry<\/span>/.test(rp) && /<span class="tc-title">Most likely to land<\/span>/.test(rp),
  'Picks leads with the PrizePicks entry, then the sportsbook bets, then the likeliest legs');
ok(/if \(t\.dataset\.action === 'bank-amount' \|\| t\.dataset\.action === 'bank-cap'\)/.test(app) && /localStorage\.setItem\('aimplified_bankroll'/.test(app), 'the bankroll is kept on the device');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
