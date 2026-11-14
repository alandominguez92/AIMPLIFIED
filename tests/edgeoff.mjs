// Edge bets at +300 or longer leave the card, logged still (2026-11-14, the owner's "do both").
//
// From Oct 28 to Nov 13 the edge bets at +300 or longer went 0 of 6 (−6u) on the half stake, every
// shorter price 16 of 25 (+4.56u), and last season's game-model backtest had the biggest gaps
// from Pinnacle's line losing. What has to hold, from the rule's day:
//   - a bet past the bar at +300 or longer is not on the card; a shorter one is, as before
//   - it is logged all the same, marked off, and closes and grades as any bet does
//   - the record counts only what the card showed; the ones left off have a line of their own
//   - one that shortens onto the card is shown from then on
//   - the bets still to play when the rule came in (Czech Republic +500 for Nov 15, logged at
//     12:01 AM Nov 14) join the ones left off
//   - the card says so, and the price checker says so of a long price
//
// Real data: production's Oct 27 boards, rows and finals (as tests/edgebets.mjs, which keeps that
// day before the rule), here with the rule's day set to Oct 27; the four prices raised there to
// clear the bar are the Blazers +400, the Canucks +300, Sassuolo +400 and Lazio +150. And
// production's /api/picks at 12:04 AM Pacific on Nov 14 (tests/fixtures/picks-20261114-0004.json),
// for the Czech Republic bet as it was logged. Real SQLite and the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const F = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'evbets-20261027.json'), 'utf8'));
const FIN = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'edgebets-finals-20261027.json'), 'utf8')).rows;
const NOV14 = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'picks-20261114-0004.json'), 'utf8'));
const RealDate = Date;
let NOW = RealDate.parse('2026-10-27T17:21:00Z');
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
let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const dec = (am) => (am > 0 ? 1 + am / 100 : 1 + 100 / -am);
const r1 = (v) => Math.round(v * 10) / 10;

// The worker, with the rule's day the fixtures' own.
const real = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
ok(/const EDGE_OFF_PRICE = 300;/.test(real) && /const EDGE_OFF_SINCE = '2026-11-14';/.test(real), 'the rule: +300 or longer, from Nov 14 (Pacific)');
const src = real.replace("const EDGE_OFF_SINCE = '2026-11-14';", "const EDGE_OFF_SINCE = '2026-10-27';");
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();

// ---- the log as production had it before the rule, with a bet still to play -------------------
// The edgebets table without its off column, and Czech Republic +500 as logged at 12:01 AM Nov 14,
// here dated the fixtures' next day.
sq.exec(`CREATE TABLE edgebets (date TEXT NOT NULL, key TEXT NOT NULL, sport TEXT, market TEXT, label TEXT, sub TEXT, commence TEXT,
  book TEXT, fair_src TEXT, prop INTEGER, grade TEXT, first_at TEXT, first_price INTEGER, first_fair REAL, first_ev REAL, first_stake REAL,
  last_at TEXT, last_price INTEGER, last_fair REAL, last_ev REAL, close_at TEXT, close_price INTEGER, close_fair REAL, result TEXT, graded_at TEXT,
  PRIMARY KEY (date, key))`);
const cz = NOV14.evBets.find((b) => b.label === 'Czech Republic ML');
ok(cz && cz.price === 500 && cz.fair === 17.9 && cz.book === 'fanduel' && cz.commence === '2026-11-15T19:45:00Z',
  'the real bet: Czech Republic +500 at FanDuel on a 17.9% fair, for Nov 15');
const old = sq.prepare(`INSERT INTO edgebets (date, key, sport, market, label, sub, commence, book, fair_src, prop, grade, first_at, first_price, first_fair, first_ev, first_stake,
  last_at, last_price, last_fair, last_ev, close_at, close_price, close_fair) VALUES (?,?,?,?,?,?,?,?,?,0,'null',?,?,?,?,?,?,?,?,?,?,?,?)`);
const czDay = '2026-10-28', czAt = '2026-10-28T19:45:00Z';
old.run(czDay, 'soc:cz-hr:res:Czech Republic', cz.sport, cz.market, cz.label, cz.sub, czAt, cz.book, cz.fairSrc, cz.asOf, cz.price, cz.fair, cz.ev, cz.stake,
  cz.asOf, cz.price, cz.fair, cz.ev, cz.asOf, cz.price, cz.fair);
// And one already graded before the rule, at +330, which stays in the card's record.
old.run('2026-10-26', 'soc:old:res:Draw', 'soccer', 'ml', 'Draw', 'x @ y', '2026-10-26T19:00:00Z', 'fanduel', 'pinnacle', '2026-10-26T08:00:00Z', 330, 25, 7.5, 0.3,
  '2026-10-26T08:00:00Z', 330, 25, 7.5, '2026-10-26T08:00:00Z', 330, 25);
sq.prepare("UPDATE edgebets SET result = 'miss', graded_at = '2026-10-27T08:00:00Z' WHERE key = 'soc:old:res:Draw'").run();

// ---- 10:21 AM Oct 27: the 7 AM boards and the Serie A pair, four prices raised --------------
await get('/api/gmpicks-export'); await get('/api/nba-pp');
const board = (b, fix) => ({ ...b, games: b.games.map((g) => fix(g) || g) });
const putBoard = (k, b) => sq.prepare('INSERT OR REPLACE INTO feed_cache (key, data, updated_at, claimed_until) VALUES (?, ?, ?, 0)').run(k, JSON.stringify(b), RealDate.parse(b.asOf));
const LAL = '82afe4e0', ANA = '5f16cb74';
putBoard('nba_board:reg', board(F.nbaBoard, (g) => g.id.startsWith(LAL) && { ...g, awayPrice: 400, awayBook: 'draftkings' }));
putBoard('nhl_board:reg', board(F.nhlBoard, (g) => g.id.startsWith(ANA) && { ...g, awayPrice: 300, awayBook: 'draftkings' }));
const gcols = Object.keys(F.gm[0]);
const gins = sq.prepare(`INSERT OR IGNORE INTO gmpicks (${gcols.join(',')}) VALUES (${gcols.map(() => '?').join(',')})`);
const SAS = F.gm.find((r) => r.home === 'Sassuolo').game_id;
for (const r of F.gm.filter((x) => x.game_id === SAS)) gins.run(...gcols.map((k) => (k === 'close_price' ? (r.market === 'h2h' ? 400 : 150) : r[k])));
for (const f of FIN.filter((x) => x.sport !== 'soccer')) {
  const g = [...F.nbaBoard.games, ...F.nhlBoard.games].find((x) => x.id === f.game_id);
  sq.prepare(`INSERT OR IGNORE INTO gmpicks (sport, date, market, league, commence, away, home, side, pick, win_prob, entry_price, close_price, game_id, model_ver)
    VALUES (?, ?, 'h2h', 'reg', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'gm-v2')`).run(f.sport, f.date, g.commence, f.away, f.home, f.side, f.pick,
    f.side === 'home' ? g.homeFair : g.awayFair, f.side === 'home' ? g.homePrice : g.awayPrice, f.side === 'home' ? g.homePrice : g.awayPrice, f.game_id);
}

console.log('-- 10:21 AM Pacific, the rule\'s day --');
let p = await get('/api/picks');
for (const b of p.evBets) console.log(`  on the card: ${b.label} ${b.price} +${b.ev}%`);
const log = () => sq.prepare('SELECT * FROM edgebets').all();
let rows = log();
const row = (re) => rows.find((r) => re.test(r.label)) || {};
ok(p.evBets.map((b) => `${b.label} ${b.price}`).join() === 'Lazio ML 150', `only the shorter price is on the card: ${p.evBets.map((b) => `${b.label} ${b.price}`).join(', ')}`);
ok(['Blazers', 'Canucks', 'Sassuolo'].every((t) => row(new RegExp(t)).off === 1) && row(/Lazio/).off === 0
  && row(/Blazers/).first_price === 400 && row(/Canucks/).first_price === 300 && row(/Sassuolo/).first_price === 400,
  'the three long shots are logged at the price they read, marked off; Lazio on the card, not');
ok(row(/Czech/).off === 1 && row(/^Draw$/).off == null, 'Czech Republic +500, still to play when the rule came in, joins them; a bet graded before it stays the card\'s');
ok(p.kelly && p.kelly.offPrice === 300, 'the page is told the price: kelly.offPrice 300');

// ---- the closes and the grades -------------------------------------------------------------------
NOW = RealDate.parse('2026-10-28T01:30:00Z');
const closeBoard = (b) => ({ ...b, asOf: '2026-10-28T01:15:00Z', games: b.games.map((g) => {
  const f = FIN.find((x) => x.game_id === g.id);
  if (!f) return g;
  const home = f.side === 'home' ? f.win_prob : r1(100 - f.win_prob);
  return { ...g, homeFair: home, awayFair: r1(100 - home), ...(f.side === 'home' ? { homePrice: f.close_price } : { awayPrice: f.close_price }) };
}) });
putBoard('nba_board:reg', closeBoard(F.nbaBoard));
putBoard('nhl_board:reg', closeBoard(F.nhlBoard));
await get('/api/picks');
rows = log();
ok(row(/Canucks/).close_fair != null && row(/Sassuolo/).close_fair != null && row(/Canucks/).off === 1, 'the ones left off close as any bet does');
// The Blazers' closing read had them at +122, past the bar and on the card: the card's bet from
// then, at the first price it showed (tests/edgebets.mjs: "+122 on the close").
ok(row(/Blazers/).off === 0 && row(/Blazers/).first_price === 122 && row(/Blazers/).close_price === 122 && row(/Blazers/).first_at === new RealDate(NOW).toISOString(),
  `the Blazers shortened onto the card at the close: its bet is +122, the first price the card showed (${row(/Blazers/).first_price})`);
for (const f of FIN) {
  sq.prepare('UPDATE gmpicks SET result = ?, home_score = ?, away_score = ? WHERE game_id = ? AND market = ? AND pick = ?')
    .run(f.result, f.home_score, f.away_score, f.game_id, f.market, f.pick);
}
NOW = RealDate.parse('2026-10-28T15:00:00Z');
p = await get('/api/picks');
rows = log();
console.log('  ' + rows.map((r) => `${r.label} ${r.first_price} ${r.result} off=${r.off}`).join(' | '));
ok(row(/Blazers/).result === 'hit' && row(/Canucks/).result === 'hit' && row(/Sassuolo/).result === 'miss' && row(/Lazio/).result === 'hit',
  'they grade as before: the Blazers and the Canucks landed, Sassuolo lost, Lazio won');
const R = p.edgeRecord;
console.log('  record ' + JSON.stringify(R));
ok(R.n === 3 && R.hit === 2 && R.units === Math.round((dec(150) - 1 + dec(122) - 1 - 1) * 100) / 100,
  `the card's record: Lazio, the Blazers at +122 and the earlier Draw, 2 of 3 (${R.units}u)`);
ok(R.byDay['2026-10-27'] && R.byDay['2026-10-27'].bets.map((b) => `${b.label} ${b.price}`).sort().join() === 'Blazers ML 122,Lazio ML 150', 'its day for "Last night": Lazio, and the Blazers at +122');
ok(R.offCard && R.offCard.price === 300 && R.offCard.from === '2026-10-27' && R.offCard.n === 2 && R.offCard.hit === 1 && R.offCard.units === 3 - 1,
  `the ones left off on their own line, the Canucks +300 and Sassuolo +400: ${R.offCard && `${R.offCard.hit} of ${R.offCard.n}, +${R.offCard.units}u`}`);

// ---- one that shortens onto the card ---------------------------------------------------------------
console.log('\n-- a long price that shortens --');
NOW = RealDate.parse('2026-10-27T17:30:00Z');
sq.prepare("UPDATE edgebets SET result = NULL, graded_at = NULL WHERE label = 'Canucks ML'").run();
putBoard('nhl_board:reg', board({ ...F.nhlBoard, asOf: '2026-10-27T17:29:00Z' }, (g) => g.id.startsWith(ANA) && { ...g, awayPrice: 290, awayBook: 'draftkings' }));
p = await get('/api/picks');
rows = log();
ok(p.evBets.some((b) => b.label === 'Canucks ML' && b.price === 290) && row(/Canucks/).off === 0 && row(/Canucks/).first_price === 290 && row(/Canucks/).last_price === 290,
  'the Canucks at +290: on the card, the bet at +290, and the card\'s from then on');
NOW = RealDate.parse('2026-10-27T17:35:00Z');
putBoard('nhl_board:reg', board({ ...F.nhlBoard, asOf: '2026-10-27T17:34:00Z' }, (g) => g.id.startsWith(ANA) && { ...g, awayPrice: 320, awayBook: 'draftkings' }));
p = await get('/api/picks');
rows = log();
ok(!p.evBets.some((b) => b.label === 'Canucks ML') && row(/Canucks/).off === 0 && row(/Canucks/).first_price === 290 && row(/Canucks/).last_price === 320,
  'back out to +320: off the card again, still the card\'s bet at +290');

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
  [aconst('BOOK_LABEL'), aconst('bkLabel'), aconst('moneyTxt'), aconst('stakeTxt'), alift('bankHtml'), aconst('LINK_BOOK'), aconst('STATE_SLOT'), alift('betLinkHtml'), alift('legLink'), alift('booksHtml'), alift('priceCheckHtml'), alift('priceCheckText'), aconst('impPct'), alift('priceSparkHtml'), alift('evBetsHtml'), alift('edgeRecordHtml'), alift('pickemHtml')].join('\n') + '\nreturn { evBetsHtml, edgeRecordHtml, priceCheckText };')(
  esc, (o) => (o > 0 ? '+' + o : String(o)), (v) => `${Math.round(v)}%`, (t) => t, { nba: 'NBA', nhl: 'NHL', soccer: 'Soccer', nfl: 'NFL' }, ui,
  (d) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new RealDate(d + 'T12:00:00Z')));
const live = { ...R, offCard: { ...R.offCard, from: '2026-11-14', n: 0, hit: 0, units: 0 } };
ok(text(P.edgeRecordHtml(live)).endsWith('+300 or longer: left off since Nov 14, 0 of 6 before · still logged, to see if they come back'),
  `the record says so, before any has graded: "${text(P.edgeRecordHtml(live)).split(' +300')[1] ? '+300' + text(P.edgeRecordHtml(live)).split(' +300')[1] : ''}"`);
ok(/· since then <b>1 of 2<\/b> · \+2\.00u at 1 unit each/.test(P.edgeRecordHtml(R)), 'and once some have: "since then 1 of 2 · +2.00u"');
ok(/3%\+ on props, shorter than \+300\. A quarter/.test(P.evBetsHtml({ evBets: [], edgeRecord: R, kelly: p.kelly })), 'the card: "3%+ on props, shorter than +300"');
NOW = RealDate.parse('2026-10-27T17:30:00Z');
const priced = [{ key: 'k', sport: 'soccer', label: 'Czech Republic ML', sub: 'x', commence: '2026-10-28T19:45:00Z', fair: 17.9 },
  { key: 'c', sport: 'nhl', label: 'Canucks ML', sub: 'x', commence: '2026-10-28T02:00:00Z', fair: 30 }];
const chk = (key, price) => text(P.priceCheckText({ priced, kelly: p.kelly }, { key, price }));
ok(/\+300 or longer: the list leaves these off \(0 of 6\)/.test(chk('k', '+500')) && !/leaves these off/.test(chk('c', '+290')) && /half: \+200 or longer/.test(chk('c', '+290')),
  `the price checker on a long price: "${chk('k', '+500')}"; at +290 the half stake alone`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
