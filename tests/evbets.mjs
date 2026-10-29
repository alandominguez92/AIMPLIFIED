// Bets with an edge, and entries from the legs PrizePicks takes (2026-10-27).
//
// Picks of the day ranks by how likely a leg is to land, and on Oct 27 none
// of its moneylines was +EV at the best US price. Sharp betting asks the other
// question: where does a price beat the sharp line? What has to hold:
//   - /api/picks carries evBets: every side the logs price, starting in the
//     next 36 hours, whose best price beats its sharp fair by 1.5%+ (game
//     lines) or 3%+ (props), best edge first, each with its EV, its quarter-
//     Kelly stake and the price it breaks even at, and how old its price is
//   - both sides of each NBA and NHL game count (the boards' snapshots), the
//     soccer and NFL sides the boards logged, and NBA unders where
//     PrizePicks' line is the book's, priced on the sharp chance
//   - nothing is bought to do it
//   - the list's entries are built only from legs PrizePicks takes (its
//     player picks, one NFL team pick an entry), so their EV and stake are an
//     entry that can be placed
//   - the page shows the card, and the entry table says which legs it used
//
// Real data (tests/fixtures/evbets-20261027.json): production's NBA and NHL
// boards at 1:50 PM Pacific on Oct 27 (the 7 AM UTC captures), its ungraded
// soccer rows for Oct 27-28 and its NBA props legs with a sharp chance. Real
// SQLite and the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const F = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'evbets-20261027.json'), 'utf8'));
const RealDate = Date;
const NOW = RealDate.parse('2026-10-27T21:00:00Z');
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
const mod = await import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(BOARD + '/worker.js', 'utf8')).toString('base64'));
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// ---- the logs as production had them ------------------------------------------------------------
await get('/api/gmpicks-export'); await get('/api/nba-pp'); await get('/api/picks');      // the tables
for (const [k, b] of [['nba_board:reg', F.nbaBoard], ['nhl_board:reg', F.nhlBoard]]) {
  sq.prepare('INSERT OR REPLACE INTO feed_cache (key, data, updated_at, claimed_until) VALUES (?, ?, ?, 0)').run(k, JSON.stringify(b), RealDate.parse(b.asOf));
}
const gcols = Object.keys(F.gm[0]);
const gins = sq.prepare(`INSERT OR IGNORE INTO gmpicks (${gcols.join(',')}) VALUES (${gcols.map(() => '?').join(',')})`);
for (const r of F.gm) gins.run(...gcols.map((k) => r[k]));
const ptDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new RealDate(iso));
const pins = sq.prepare(`INSERT INTO nbapp (date, game_id, player, market, commence, home, away, team, player_id, point, proj, model_under, min_proj, book_line, book_under,
  sharp_under, sharp_n, sharp_src, captured_at, model_ver) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'nbapp-v1')`);
for (const l of F.ppLegs) {
  const [away, home] = l.game.split(' @ ');
  pins.run(...[ptDay(l.commence), l.game_id, l.player, l.market, l.commence, home, away, l.team, l.player_id, l.point, l.proj, l.model_under, l.min_proj,
    l.book_line, typeof l.book_under === 'number' ? l.book_under : null, l.sharp_under, l.sharp_n, l.sharp_src, l.first_at].map(norm));
}

// What the edge should be, worked out here from the recorded rows.
const dec = (a) => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);
const imp = (a) => (a < 0 ? -a / (-a + 100) : 100 / (a + 100));
const within = (t) => { const x = RealDate.parse(t); return x > NOW && x - NOW <= 36 * 3600e3; };
const cands = [];
for (const [sport, b] of [['nba', F.nbaBoard], ['nhl', F.nhlBoard]]) {
  for (const g of b.games) for (const [fair, price] of [[g.homeFair, g.homePrice], [g.awayFair, g.awayPrice]]) cands.push({ sport, fair, price, prop: false, t: g.commence });
}
// A soccer row its league's latest read did not refresh is left off since
// 2026-10-28 (tests/edgebets.mjs): its side had lost the board's lead, and
// its price was that of the read that last had it.
const readAt = (r) => r.close_at || r.entry_at;
const latestRead = {};
for (const r of F.gm) if (!(readAt(r) <= latestRead[r.league])) latestRead[r.league] = readAt(r);
const currentRow = (r) => RealDate.parse(readAt(r)) >= RealDate.parse(latestRead[r.league]) - 5 * 60e3;
for (const r of F.gm.filter(currentRow)) cands.push({ sport: 'soccer', fair: r.win_prob, price: r.close_price != null ? r.close_price : r.entry_price, prop: false, t: r.commence });
for (const l of F.ppLegs) if (l.book_line === l.point && l.market !== 'reb' && l.market !== 'blk' && l.market !== 'stl') cands.push({ sport: 'nba', fair: l.sharp_under, price: l.book_under, prop: true, t: l.commence });
const want = cands.filter((c) => c.fair != null && typeof c.price === 'number' && within(c.t) && Math.abs(c.price) >= 100 && Math.abs(c.price) <= 600
  && Math.abs(c.fair - imp(c.price) * 100) <= 25 && (c.fair / 100 * dec(c.price) - 1) * 100 >= (c.prop ? 3 : 1.5))
  .map((c) => Math.round((c.fair / 100 * dec(c.price) - 1) * 1000) / 10).sort((a, b) => b - a);

console.log('-- 2 PM Pacific, Oct 27 --');
const p = await get('/api/picks');
const E = p.evBets || [];
for (const b of E) console.log(`  ${b.label} (${b.sub}) ${b.price} ${b.book}: fair ${b.fair}% -> edge +${b.ev}%, quarter Kelly ${b.stake}%, bet at ${b.betAt} or better, priced ${b.asOf}`);
ok(E.length === want.length && E.map((b) => b.ev).join() === want.join() && want.length >= 1,
  `every side whose price beats its sharp fair by enough, best first: ${E.map((b) => '+' + b.ev + '%').join(', ')}`);
const tij = E.find((b) => /Tijuana/.test(b.label));
ok(tij && tij.price === 600 && tij.fair === 14.6 && tij.ev === 2.2 && tij.stake === 0.1 && tij.betAt === 585,
  `Tijuana +600 on a 14.6% sharp chance: +${tij && tij.ev}%, a quarter of Kelly (${tij && tij.stake}%), a bet at +${tij && tij.betAt} or better`);
// The card listed FC Cincinnati +410 here until 2026-10-28: its row had kept
// the 5 AM price after the 1:30 PM read gave its game's lead to another side.
ok(!E.some((b) => /Cincinnati/.test(b.label)) && readAt(F.gm.find((r) => r.pick === 'FC Cincinnati')) === '2026-10-27T12:05:55.302Z' && latestRead.mls === '2026-10-27T20:30:33.154Z',
  "FC Cincinnati's +410 is left off: its price was the 5 AM read's, the MLS's latest 1:30 PM");
ok(!E.some((b) => /Knicks|Lakers/.test(b.label)), 'the Knicks at -155 (+0.5%) and the Lakers at -135 (+0.1%) are under the 1.5% bar');
ok(E.every((b) => b.asOf && b.commence && b.sub && typeof b.stake === 'number'), 'each says how old its price is');
ok(!asked.some((u) => u.includes('the-odds-api.com')), `nothing bought (${asked.length} feed reads)`);

// A price that does beat it on an NBA game and an NBA under: the Knicks at
// +130 on 61.1%, and Paul George's 4.5 rebounds under had it been threes at
// +140 on 47.9%.
const snap = JSON.parse(JSON.stringify(F.nbaBoard));
snap.games.find((g) => g.home === 'New York Knicks').homePrice = 130;
sq.prepare("UPDATE feed_cache SET data = ? WHERE key = 'nba_board:reg'").run(JSON.stringify(snap));
const pg = F.ppLegs.find((l) => l.player === 'Paul George' && l.market === 'reb');
sq.prepare("INSERT INTO nbapp (date, game_id, player, market, commence, home, away, point, model_under, min_proj, book_line, book_under, sharp_under, captured_at) VALUES (?, ?, 'Paul George', 'threes', ?, 'X', 'Y', 4.5, 50, 30, 4.5, 140, 47.9, ?)")
  .run(ptDay(pg.commence), pg.game_id, pg.commence, pg.first_at);
const p2 = await get('/api/picks');
const kn = (p2.evBets || []).find((b) => b.label === 'Knicks ML'), geo = (p2.evBets || []).find((b) => /Paul George/.test(b.label));
ok(kn && kn.ev === Math.round((0.611 * 2.3 - 1) * 1000) / 10 && kn.sport === 'nba', `the Knicks at +130 on 61.1%: +${kn && kn.ev}%, listed`);
ok(geo && geo.ev === Math.round((0.479 * 2.4 - 1) * 1000) / 10 && geo.label === 'Paul George Under 4.5 3PM', `an NBA under priced on the sharp chance: ${geo && geo.label} +${geo && geo.ev}%`);

// ---- entries from the legs PrizePicks takes -------------------------------------------------------
console.log('\n-- the list\'s entries --');
console.log('  ' + p.legs.map((l) => `${l.title} [${l.kind}${l.ppOk ? ', PrizePicks' : ''}]`).join(' | '));
const pp = p.legs.filter((l) => l.ppOk);
ok(p.legs.filter((l) => /^(nba|nhl|mlb)_ml$|^soccer_fav$/.test(l.kind)).every((l) => !l.ppOk) && pp.every((l) => /_pp$|^nfl_ptd$|^nfl_ml$/.test(l.kind)),
  'NBA, NHL, MLB and soccer moneylines are sportsbook bets; PrizePicks legs are its player picks and one NFL team pick');
ok(p.entries.length === Math.max(0, pp.length - 1), `entries come only from those legs (${pp.length} of ${p.legs.length}: ${p.entries.length} entries)`);

// ---- the page -------------------------------------------------------------------------------------------
console.log('\n-- the page --');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const lift = (name) => { const at = app.indexOf(`function ${name}(`); let d = 0;
  for (let i = app.indexOf('{', at); i < app.length; i++) { if (app[i] === '{') d++; else if (app[i] === '}' && --d === 0) return app.slice(at, i + 1); } };
const AM = (o) => (o > 0 ? '+' + o : String(o));
// The stakes read against a bankroll and its daily cap since 2026-10-28
// (tests/edgebets.mjs); none set here, so a stake reads as a share.
const liftConst = (name) => { const at = app.indexOf(`const ${name} =`); return app.slice(at, app.indexOf(';\n', at) + 1); };
const card = new Function('esc', 'AM', 'pct0', 'soccerKick', 'PICK_SPORT', 'state', 'shortDay',
  [liftConst('BOOK_LABEL'), liftConst('bkLabel'), liftConst('moneyTxt'), liftConst('stakeTxt'), liftConst('LINK_BOOK'), liftConst('STATE_SLOT'), lift('betLinkHtml'), liftConst('impPct'), lift('priceSparkHtml'), lift('evBetsHtml'), lift('edgeRecordHtml'), lift('pickemHtml')].join('\n') + '\nreturn evBetsHtml;')((s) => String(s), AM, (v) => `${Math.round(v)}%`, (t) => t,
  { nba: 'NBA', nhl: 'NHL', soccer: 'Soccer', nfl: 'NFL' }, { bank: { amount: null, cap: 5 } }, (d) => d);
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const html = card(p);
console.log('  ' + text(html).slice(0, 420));
ok(/Bets with an edge/.test(html) && (html.match(/<li>/g) || []).length === E.length && /Tijuana ML \+2\.2%/.test(text(html)) && /\+600 .*fair 15% \(\+585\) · ¼ Kelly 0\.1%/.test(text(html)),
  'the card: each bet, its edge, the price and the fair, its stake');
ok(new RegExp(`¼ Kelly total ${Math.round(E.reduce((s, b) => s + b.stake, 0) * 10) / 10}%`).test(text(html)), "and the day's total stake");
ok(/No price beats the sharp line/.test(card({ evBets: [] })), 'and says so when nothing does');
// The boards' book names (2026-10-28): Pelicans +165 printed "betmgm".
ok(/\+600 MGM · fair/.test(text(card({ evBets: E.map((b) => ({ ...b, book: 'betmgm' })) }))) && /\+600 CZR · fair/.test(text(card({ evBets: E.map((b) => ({ ...b, book: 'williamhill_us' })) }))),
  'each book by the name the boards use: MGM, CZR');
ok(/evBetsHtml\(d\) \+ after;/.test(app) && /As a PrizePicks entry/.test(app) && /const ppLegs = allPool\.filter\(\(x\) => Date\.parse\(x\.commence\) > Date\.now\(\)\);/.test(app),
  'on the Picks tab under the list, with the entry table on the legs PrizePicks takes');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
