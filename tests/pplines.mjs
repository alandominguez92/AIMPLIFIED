// PrizePicks' line as its app shows it, and a log of when it moves (2026-11-01).
//
// The owner: Day'Ron Sharpe read Under 8.5 on the site and 8 on PrizePicks. The
// site's number was the first read, from before any book had posted. What has to
// hold:
//   - the log: a row for each leg as first read, and another only when PrizePicks'
//     line, the books' or the sharp books' has changed, with the time and which
//     read; no extra odds calls. /api/pp-lines reads a day back, with its moves
//   - a line set on a leg works out the chance at that number from his projection
//     and spread, at once. A whole number can tie, and a tie takes the leg out of
//     the entry; the chance counts it as a miss, as the worker's read does, so
//     a set line and the next read agree, and the tie's share is shown beside it
//   - the leg then carries that number everywhere: its title, the slip, the moved
//     tag. What was true of the old number goes (the sharp chance, his season)
//   - it is kept on the device until the start, and a later read knows better
//   - rebounds and assists only: 0 of 436 threes, blocks and steals moved
//   - a rebounds or assists line with no book up says half of those move
//   - on Picks a rebounds Less stands on its line sitting above the sharp books':
//     set level with them, it leaves the entry and the edge is no longer quoted
//
// Real data: the real Celtics @ Pistons read as production took it on Oct 20
// (tests/fixtures/odds-nba-pp-26b036ff-20261020.json), with the moves written in
// as tests/pprefresh.mjs writes them; production's NBA card on Nov 1, Sharpe among
// it (tests/fixtures/pplines-20261101.json); and production's rebounds rows of Oct
// 29, Dyson Daniels' 6 over the sharp 5.5 (tests/fixtures/nbapp-reb-20261027-29.json).
// Real SQLite, the real worker and its own cron, and the real app.js's functions.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = path.join(BOARD, 'tests', 'fixtures');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const RealDate = Date;
let NOW = 0;
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
const H = 3600e3, M = 60e3;
const NBA = JSON.parse(fs.readFileSync(path.join(FIX, 'odds-nba-pp-26b036ff-20261020.json'), 'utf8'));
const CARD = JSON.parse(fs.readFileSync(path.join(FIX, 'pplines-20261101.json'), 'utf8'));
const REB = JSON.parse(fs.readFileSync(path.join(FIX, 'nbapp-reb-20261027-29.json'), 'utf8')).days;
const PRIORS = fs.readFileSync(path.join(BOARD, 'nba-priors.json'), 'utf8');
const ODDS = 'https://api.the-odds-api.com/v4/sports';

// PrizePicks' lines moved: player -> market -> new point.
function moved(body, moves) {
  const b = structuredClone(body);
  for (const m of b.bookmakers.find((x) => x.key === 'prizepicks').markets) {
    m.outcomes = m.outcomes.map((o) => { const to = moves[o.description] && moves[o.description][m.key]; return to === undefined ? o : { ...o, point: to }; });
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
  if (/^\s*(SELECT|WITH)/i.test(sql)) return { results: st.all(...a), meta: {} };
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

// ---- the log ----------------------------------------------------------------------------------
console.log('-- the log: Celtics @ Pistons --');
const TIP = RealDate.parse(NBA.commence_time);
const DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new RealDate(TIP));
const legRows = (d, p, m) => d.rows.filter((r) => r.player === p && r.market === m);
NOW = TIP - 30 * H;
await tick();
let d = await hit(`/api/pp-lines?day=${DAY}`);
const logged = sq.prepare('SELECT * FROM nbapp WHERE game_id = ?').all(NBA.id);
const firstN = d.n;
ok(firstN === logged.length && logged.length > 20 && d.rows.every((r) => r.read === 'first' && r.sport === 'nba' && r.at === new RealDate(NOW).toISOString()), `the first read: one row a leg (${firstN}), stamped with its time`);
ok(d.moves.length === 0, 'and nothing has moved');
const cade = legRows(d, 'Cade Cunningham', 'ast')[0], cadeRow = logged.find((r) => r.player === 'Cade Cunningham' && r.market === 'ast');
const bu = JSON.parse(cadeRow.book_unders || '{}');
ok(cade.line === 9 && cade.book_line === cadeRow.book_line && cade.sharp_line === (bu.pinnacle || bu.fanduel)[0] && cade.ud_line === cadeRow.ud_line,
  `Cunningham: PrizePicks ${cade.line}, the book ${cade.book_line}, the sharp books ${cade.sharp_line}, as the same read has them`);

NOW = TIP - 8 * H + 5 * M; await tick();
d = await hit(`/api/pp-lines?day=${DAY}`);
ok(d.n === firstN, 'a re-read that finds the same lines adds no row');

feed.body = moved(NBA, { 'Cade Cunningham': { player_assists: 8.5 } });
const reread = TIP - 5 * H + 5 * M;
NOW = reread; await tick();
d = await hit(`/api/pp-lines?day=${DAY}`);
let cr = legRows(d, 'Cade Cunningham', 'ast');
ok(d.n === firstN + 1 && cr.length === 2 && cr[1].line === 8.5 && cr[1].read === 'refresh' && cr[1].at === new RealDate(reread).toISOString(), 'PrizePicks lowers his line: one new row, his, with the read and the time');
const mv = d.moves[0] || {};
ok(d.moves.length === 1 && mv.player === 'Cade Cunningham' && mv.market === 'ast' && mv.from === 9 && mv.to === 8.5 && mv.at === cr[1].at && mv.was === cr[0].at && mv.book_before === cade.book_line && mv.sharp_before === cade.sharp_line,
  'and it reads back as a move, with when, and where the books stood');

// The books move and PrizePicks does not: the case the log is there to time.
const bookLeg = logged.find((r) => r.market === 'reb' && r.player !== 'Cade Cunningham' && r.book_line != null);
const dk = structuredClone(feed.body);
for (const m of dk.bookmakers.find((x) => x.key === 'draftkings').markets) {
  if (m.key !== 'player_rebounds') continue;
  m.outcomes = m.outcomes.map((o) => (o.description === bookLeg.player ? { ...o, point: o.point + 1 } : o));
}
feed.body = dk;
const close = TIP - 85 * M;
NOW = close; await tick();
d = await hit(`/api/pp-lines?day=${DAY}`);
const br = legRows(d, bookLeg.player, 'reb');
ok(br.length === 2 && br[0].line === br[1].line && br[1].book_line === br[0].book_line + 1 && br[1].read === 'close', `the book moves and PrizePicks does not (${bookLeg.player}): a row for that, from the pre-tip read`);
ok(d.moves.length === 1, 'not a move of PrizePicks\' own');
ok(calls.filter((c) => !c.check).length === 4, 'no odds call of its own: the four reads the game had anyway (first, two re-reads, pre-tip)');
ok((await hit('/api/pp-lines')).error && (await hit('/api/pp-lines?day=2026-1-1')).error, 'a day has to be named');
ok((await hit(`/api/pp-lines?day=2020-01-01`)).n === 0, 'a day with nothing is empty');
ok(/\|\| p === '\/api\/pp-lines';/.test(src), "and each day is cached by its own address, not all as one");
// A failure here must not lose the read it follows.
ok(/await logPpLines\(env\.DB, 'nba', read, [^\n]*\)\.catch\(\(\) => \{\}\);/.test(src), 'a failure in the log does not stop the read');

console.log('\n-- what the page gets --');
NOW = TIP - 80 * M;
const cardNow = await hit('/api/nba-pp');
const dispOf = (mk) => (cardNow.legs.find((x) => x.market === mk) || {}).disp;
const DISP = { threes: 1.15, ast: 1.25, reb: 1.2, blk: 1.15, stl: 1.1 };
ok(new RegExp(`const NBA_DISP = \\{ threes: ${DISP.threes}, ast: ${DISP.ast}, reb: ${DISP.reb}, blk: ${DISP.blk}, stl: ${DISP.stl} \\}`).test(src) && dispOf('reb') === 1.2 && dispOf('ast') === 1.25, 'each leg carries the spread its chance is worked out with');

// ---- the page ---------------------------------------------------------------------------------
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
function lift(name) {
  let at = app.indexOf(`function ${name}(`);
  if (at >= 0) {
    let dp = 0;
    for (let i = app.indexOf(') {', at) + 2; i < app.length; i++) { if (app[i] === '{') dp++; else if (app[i] === '}' && --dp === 0) return app.slice(at, i + 1); }
  }
  at = app.indexOf(`const ${name} =`);
  if (at < 0) throw new Error(`could not lift ${name}`);
  let dp = 0;
  for (let i = at; i < app.length; i++) { const c = app[i]; if ('{(['.includes(c)) dp++; else if ('})]'.includes(c)) dp--; else if (c === ';' && dp === 0) return app.slice(at, i + 1); }
  throw new Error(`could not lift ${name}`);
}
const store = {};
const penv = {
  esc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  state: { slip: {}, ppLines: {}, sport: 'nba' },
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
  LEG_OFFERS: new Map(), persistSlip: () => { penv.persisted++; }, renderSlip: () => {}, renderPicks: () => { penv.drawn++; }, renderNba: () => { penv.drawn++; },
  MARKET_SHORT: { reb: 'REB', ast: 'AST', blk: 'BLK', threes: '3PM' }, ptDayOf: (ms) => new RealDate(ms).toISOString().slice(0, 10), persisted: 0, drawn: 0,
};
const names = ['nbCdf', 'r1', 'pct0', 'PP_LINE_MARKETS', 'PP_LINE_STORE', 'ppLinesLoad', 'ppLineOf', 'ppLineSet', 'ppChanceAt', 'nbaLegAtLine', 'pickAtLine', 'ppPoolAtLines', 'readAgeTag', 'injuryTag', 'nbaCardInjTag', 'ppLineTags', 'ppLineStepHtml', 'nbaPpLeg', 'pickLineSetTag', 'ppMovedTag'];
let P;
try {
  P = new Function(...Object.keys(penv), names.map(lift).join('\n') + `\nreturn { ${names.filter((n) => !/^[A-Z]/.test(n)).join(', ')} };`)(...Object.values(penv));
} catch (e) { console.log(`  FAIL  the pieces lift out of app.js (${e.message})`); process.exit(1); }
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

console.log("\n-- Day'Ron Sharpe, Nov 1, 1:30 AM --");
NOW = RealDate.parse(CARD._recorded);
const withDisp = (x) => ({ ...x, disp: DISP[x.market] });
const sharpe = withDisp(CARD.legs.find((x) => x.player === "Day'Ron Sharpe" && x.market === 'reb'));
const key = `nbapp:${sharpe.game_id}:${sharpe.player}:reb`;
ok(sharpe.point === 8.5 && sharpe.model_under === 75.9 && sharpe.book_line == null && sharpe.first_at === '2026-11-01T02:16:04.149Z', 'as production has him: Under 8.5 at 75.9%, read 7:16 PM Saturday, no book up');
// The negative binomial by its own recurrence, worked out here.
const pmf = (mean, phi) => { const r = mean / (phi - 1), q = mean / (r + mean); const out = [Math.pow(r / (r + mean), r)]; for (let i = 1; i < 60; i++) out.push(out[i - 1] * (r + i - 1) / i * q); return out; };
const nb = pmf(6.7, 1.2), upto = (k) => nb.slice(0, k + 1).reduce((a, b) => a + b, 0);
const under8 = upto(7) * 100, tie8 = nb[8] * 100;
console.log(`  at 8: under ${under8.toFixed(1)}%, tie ${tie8.toFixed(1)}%; at 8.5 by the rounded projection ${(upto(8) * 100).toFixed(1)}%`);
ok(Math.abs(upto(8) * 100 - 75.9) < 1, 'the page holds his projection to a tenth, and it lands within a point of the 75.9 the worker worked out');
ok(P.nbaLegAtLine(sharpe) === sharpe, 'no line set: the leg as read');
P.ppLineSet(key, 8, 8.5, sharpe.commence);
let x = P.nbaLegAtLine(sharpe);
console.log(`  ${x.player} Under ${x.point}: ${x.model_under}%; ${text(P.ppLineStepHtml(key, x.point, 8.5, x.lineSet, x.commence))}`);
ok(x.point === 8 && Math.abs(x.model_under - under8) < 0.06 && Math.abs(x.lineSet.tie - tie8) < 0.01 && Math.abs(x.lineSet.under + x.lineSet.over + x.lineSet.tie - 100) < 1e-6, `set to 8: ${x.model_under}%, a tie counted as a miss, and both sides and the tie add to 100`);
// What production's own read said at 8 that afternoon, /api/nba-pp?day=2026-11-01: 64.7.
// The stepper had 72% when it left ties out.
ok(Math.abs(x.model_under - 64.7) < 1, `and that is what the worker's read at 8 said: ${x.model_under}% against 64.7`);
ok(sharpe.point === 8.5, 'the leg as read is untouched');
const moved8 = text(P.ppMovedTag(x));
ok(/8\.5/.test(moved8) && /8/.test(moved8) && /lower/.test(P.ppMovedTag(x)), `marked as moved: "${moved8}", in the colour of a harder under`);
const half = P.ppChanceAt(9.5, 6.7, 1.2);
ok(half.tie < 1e-9 && Math.abs(half.under - upto(9) * 100) < 1e-6, 'at a half point nothing can tie, and the chance is the plain one');
const stepSet = P.ppLineStepHtml(key, x.point, 8.5, x.lineSet, x.commence);
ok(/You set/.test(stepSet) && /Back to 8\.5/.test(stepSet) && /Less 64% · More 25%/.test(text(stepSet)) && /an exact 8 voids the leg \(11%\)/.test(text(stepSet)), 'the row says what was set, both sides, and what an exact 8 does');
const stepOff = P.ppLineStepHtml(key, 8.5, 8.5, null, sharpe.commence);
ok(/PP shows/.test(stepOff) && !/Back to/.test(stepOff) && !/Less/.test(stepOff) && (stepOff.match(/data-action="pp-line"/g) || []).length === 2 && /data-d="-0\.5"/.test(stepOff) && /data-d="0\.5"/.test(stepOff), 'with none set: a label and half-point steps, one tap each');
ok(/case 'pp-line': ppLineSet\(target\.dataset\.key, Math\.max\(0\.5, Number\(target\.dataset\.line\) \+ Number\(target\.dataset\.d\)\), Number\(target\.dataset\.read\), target\.dataset\.commence\); break;/.test(app) && /case 'pp-line-reset': ppLineSet\(target\.dataset\.key, null\); break;/.test(app), 'both wired up');

const seasoned = withDisp({ ...sharpe, sharp_under: 61, sharp_src: 'pinnacle', l10_n: 5, l10_under: 5 });
const clean = P.nbaLegAtLine(seasoned);
ok(clean.sharp_under == null && clean.l10_n === 0, "the sharp chance and his season against the line were at the old number, and go");
const bookLegX = withDisp(CARD.legs.find((l) => l.market === 'reb' && l.book_line != null));
P.ppLineSet(`nbapp:${bookLegX.game_id}:${bookLegX.player}:reb`, bookLegX.point + 0.5, bookLegX.point, bookLegX.commence);
ok(P.nbaLegAtLine(bookLegX).vsBook === 0.5, 'against the book, the gap is worked out at the new number');

console.log('\n-- the slip --');
const leg8 = P.nbaPpLeg(x);
ok(leg8.title === "Day'Ron Sharpe Under 8 REB" && leg8.spec.pp.line === 8 && leg8.spec.pp.under === x.model_under && leg8.id === key, 'starred after: the leg goes in at 8, with its chance');
penv.state.slip = { [key]: P.nbaPpLeg(sharpe) };
penv.LEG_OFFERS.set(key, leg8);
penv.persisted = 0;
P.ppLineSet(key, 8, 8.5, sharpe.commence);
ok(penv.state.slip[key].spec.pp.line === 8 && penv.persisted === 1, 'starred before: the one in the slip moves with it');
penv.state.slip = {}; penv.LEG_OFFERS.clear();

console.log('\n-- kept, and let go --');
const saved = JSON.parse(store.aimplified_pp_lines);
ok(saved[key].line === 8 && saved[key].commence === sharpe.commence, 'kept on this device with its start');
ok(P.ppLinesLoad()[key].line === 8, 'and there after a reload');
const tipped = NOW;
NOW = RealDate.parse(sharpe.commence) + M;
ok(P.ppLinesLoad()[key] === undefined, 'gone once his game has started');
NOW = tipped;
ok(/state\.ppLines = ppLinesLoad\(\);/.test(app), 'read when the page loads');
// Found in the browser, not by the lifted copies above: the load runs as the page
// starts, so the store's name has to be declared above it, or the read throws
// inside its own try and a reload forgets every line.
const loadAt = app.indexOf('state.ppLines = ppLinesLoad();');
ok(app.indexOf('const PP_LINE_STORE =') > -1 && app.indexOf('const PP_LINE_STORE =') < loadAt, 'with the name it reads declared above that load');
// A row with a book, the sharp chance and his season pushed a 375px phone to 447.
ok(/\.nba-pp \.tc-book \{ white-space:normal;/.test(fs.readFileSync(BOARD + '/style.css', 'utf8')), 'and the book line wraps on the card, so a long one does not widen the page');
const later = new RealDate(NOW + H).toISOString();
ok(P.nbaLegAtLine({ ...sharpe, close_at: later, point: 7.5 }).point === 7.5 && P.nbaLegAtLine({ ...sharpe, close_at: later, point: 7.5 }).lineSet === undefined, 'a read after it knows better: 7.5 from the feed, not the 8 set before');
ok(P.nbaLegAtLine({ ...sharpe, point: 8 }).lineSet === undefined, 'and one that has caught up is simply the read');
P.ppLineSet(key, 8.5, 8.5, sharpe.commence);
ok(penv.state.ppLines[key] === undefined && JSON.parse(store.aimplified_pp_lines)[key] === undefined && P.nbaLegAtLine(sharpe) === sharpe, 'stepped back to the read: nothing kept, and the leg as it was');
P.ppLineSet(key, 8, 8.5, sharpe.commence); P.ppLineSet(key, null);
ok(penv.state.ppLines[key] === undefined, 'and the same from the Back button');

console.log('\n-- the tags --');
const tagOf = (mk) => text(P.ppLineTags(withDisp(CARD.legs.find((l) => l.market === mk && l.book_line == null))));
console.log(`  ${tagOf('reb')}`);
ok(/no book yet: half of these move/.test(tagOf('reb')) && /no book yet: half of these move/.test(tagOf('ast')), 'rebounds and assists with no book up say so');
ok(/PP line read 7h ago: check the app/.test(tagOf('reb')), 'and how old the read is: 7:16 PM to 1:30 AM');
ok(tagOf('blk') === '' && tagOf('threes') === '', 'threes and blocks say nothing: none has moved');
const withB = text(P.ppLineTags(bookLegX));
ok(!/no book yet/.test(withB), 'nor a line with a book up');
P.ppLineSet(key, 8, 8.5, sharpe.commence);
ok(P.ppLineTags(P.nbaLegAtLine(sharpe)) === '', 'and with a line set, the number is the one in front of you');
P.ppLineSet(key, null);
// Half of them, as the tag says, Oct 20-31: 193 of 382 against 45 of 617.
ok(/193 of 382/.test(lift('ppLineTags')) && /45 of 617/.test(lift('ppLineTags')), 'its reason on the tag');
const cardSrc = lift('nbaPpCardHtml');
ok(/const x = nbaLegAtLine\(x0\);/.test(cardSrc) && /PP_LINE_MARKETS\.has\(x\.market\) \? ppLineStepHtml\(leg\.id, x\.point, x0\.point, x\.lineSet, x\.commence\)/.test(cardSrc) && /\$\{ppLineTags\(x\)\}/.test(cardSrc), "on the NBA card's legs");
ok(/If PrizePicks shows another number on rebounds or assists, set it on the leg\./.test(cardSrc), 'and the card says how');

// ---- Picks ------------------------------------------------------------------------------------
console.log('\n-- on Picks: Dyson Daniels, Oct 29 --');
NOW = RealDate.parse('2026-10-29T22:45:00Z');
sq.prepare('DELETE FROM nbapp').run();
sq.prepare('DELETE FROM daypicks').run();
await hit('/api/picks');
for (const l of REB['2026-10-29']) {
  const [away, home] = l.game.split(' @ ');
  sq.prepare(`INSERT OR REPLACE INTO nbapp (date, game_id, player, market, league, commence, home, away, team, point, proj, model_under, min_proj, book_line, book_under, sharp_under, captured_at,
      close_point, close_under, close_book_line, close_book_under, close_sharp_under, close_at, book_unders)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('2026-10-29', l.game_id, l.player, 'reb', 'reg', l.commence, home, away, l.team,
    l.first.line, l.proj, l.first.under, l.min_proj, l.first.book, l.first.book_under, l.first.sharp, l.first.at,
    l.tip ? l.tip.line : null, l.tip ? l.tip.under : null, l.tip ? l.tip.book : null, l.tip ? l.tip.book_under : null, l.tip ? l.tip.sharp : null, l.tip ? l.tip.at : null, l.bookUnders);
}
const picks = await hit('/api/picks');
const dan = (picks.ppPool || []).find((l) => l.title.startsWith('Dyson Daniels'));
ok(dan && dan.kind === 'nba_reb_gap' && dan.spec.pp.line === 6 && dan.vsBook === 0.5 && dan.p === 56.1 && dan.disp === 1.2, "the worker's real leg: 6 over the sharp 5.5, at 56.1%, with its spread");
const poolN = picks.ppPool.length;
ok(P.pickAtLine(dan) === dan, 'no line set: as read');
penv.state.sport = 'picks';
P.ppLineSet(dan.legId, 6.5, 6, dan.commence);
let dx = P.pickAtLine(dan);
console.log(`  ${dx.title}: ${dx.p}%, model ${dx.modelP}%, ${text(P.pickLineSetTag(dx))}`);
ok(dx.title === 'Dyson Daniels Under 6.5 REB' && dx.spec.pp.line === 6.5 && dx.vsBook === 1 && dx.p === 56.1 && !dx.lineSet.off, 'set to 6.5, still over the sharp 5.5: on the entry at the same rate, a point over');
ok(typeof dx.modelP === 'number' && dx.modelP !== dan.modelP && dx.sharp == null && dx.trend == null, "the model's chance at the new number; the sharp chance and his run at the old one go");
ok(P.ppPoolAtLines(picks.ppPool).length === poolN && P.pickAtLine(dx) === dx, 'in the pool, and done twice is the same');
P.ppLineSet(dan.legId, 5.5, 6, dan.commence);
dx = P.pickAtLine(dan);
console.log(`  ${dx.title}: ${text(P.pickLineSetTag(dx))}`);
ok(dx.lineSet.off && dx.vsBook === 0 && /off the entry: 5\.5 is not above the sharp 5\.5/.test(text(P.pickLineSetTag(dx))), 'set to 5.5, level with the sharp books: the rule it stood on is gone, and it says so');
ok(dx.p === dx.modelP && dx.p < 50, `its number is the model's ${dx.p}%, not the 56.1% of the rule it lost`);
const after = P.ppPoolAtLines(picks.ppPool);
ok(after.length === poolN - 1 && !after.some((l) => l.legId === dan.legId), 'off the entry');
const rp = lift('renderPicks');
ok(/const ppLegs = ppPoolAtLines\(allPool\)\.filter/.test(rp) && /const whole = ppLegs\.length === allPool\.length;/.test(rp), "and the worker's edge is no longer quoted: it priced the pool as it stood");
ok(/\(ml \? all : ppPoolAtLines\(all\)\)\.filter/.test(lift('saveTicketImage')), 'the saved ticket the same');
ok(/\(d\.legs \|\| \[\]\)\.map\(pickAtLine\)\.filter/.test(rp) && /!compact && x\.kind === 'nba_reb_gap' && x\.spec && x\.spec\.pp \? ppLineStepHtml\(/.test(rp), 'the rows carry the number and the steps');
const hero = lift('heroLegHtml');
ok(/const x = pickAtLine\(x0\);/.test(hero) && /x\.kind === 'nba_reb_gap' && s\.pp \? ppLineStepHtml\(/.test(hero), 'and so does the best leg at the top');
penv.state.ppLines = { nhlx: { line: 1.5, at: NOW, commence: dan.commence } };
const nhlLeg = { kind: 'nhl_more', legId: 'nhlx', title: 'Connor McDavid Over 0.5 PTS', spec: { pp: { line: 0.5 } } };
ok(P.pickAtLine(nhlLeg) === nhlLeg, 'the NHL is left alone: 242 of 242 kept their line');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
