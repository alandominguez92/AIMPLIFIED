// Phone fixes from the Nov 23 check (2026-11-23, the owner: "build all three"):
//   1. Picks' reference cards (Bets with an edge with Check a price in it, Soccer props, How the
//      list did with its day cards) fold: closed on a phone, open wider, the head the tap, a line
//      saying what's inside while folded, and the five-minute redraws keep each as the reader left it
//   2. the NBA unders card's note and stat lines fold behind "How to read this" (tests/nbacards.mjs
//      draws it); here, that its tap redraws the NBA tab
//   3. a cold first visit to Soccer says "Loading…": the tab sat blank for some ten seconds while
//      the props' expected starters were read
//
// Real data: the Picks payload recorded on Nov 16 at 09:10 UTC (tests/fixtures/picks-20261116-0040.json:
// two edge bets, fourteen graded days, the Top 6 Flex 3 of 14) and production's /api/soccer-props?expected=1
// read at 11:45 PM Pacific Nov 23 (tests/fixtures/soccer-props-20261124.json: Tuesday's Champions League).
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(BOARD, f), 'utf8').replace(/\r\n/g, '\n');
const app = read('app.js'), css = read('style.css');
const P = JSON.parse(read('tests/fixtures/picks-20261116-0040.json')), S = JSON.parse(read('tests/fixtures/soccer-props-20261124.json'));
const RealDate = Date;
let NOW = RealDate.parse(P.asOf);
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
function lift(name) {
  let at = app.indexOf(`function ${name}(`);
  const isConst = at < 0;
  if (isConst) at = app.indexOf(`const ${name} =`);
  if (at < 0) throw new Error(`app.js has no ${name}`);
  let depth = 0;
  for (let i = at; i < app.length; i++) {
    const c = app[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') { depth--; if (!isConst && c === '}' && depth === 0) return app.slice(at, i + 1); }
    else if (isConst && c === ';' && depth === 0 && app[i + 1] === '\n') return app.slice(at, i + 1);
  }
  throw new Error(`could not close ${name}`);
}
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const AM = (o) => (o > 0 ? '+' + o : String(o));
const state = { bank: { amount: null, cap: 5 }, slip: {}, socProps: S, socLines: {}, socSaved: {}, socSaving: {}, socOpen: {}, soccerLeague: 'all', socStat: 'best', socQuery: '' };
let C;
try {
  C = new Function('state', 'esc', 'AM', 'soccerKick', 'PICK_SPORT', [
    'BOOK_LABEL', 'bkLabel', 'moneyTxt', 'stakeTxt', 'LINK_BOOK', 'STATE_SLOT', 'betLinkHtml', 'legLink', 'booksHtml', 'priceCheckHtml', 'priceCheckText', 'impPct', 'priceSparkHtml',
    'evBetsHtml', 'edgeRecordHtml', 'pickemHtml', 'shortDay', 'pct0', 'HIST_DAY_KEYS', 'HIST_DAYS_SHOWN', 'movedLineHtml', 'ppEntryRecordHtml', 'pickHistoryHtml',
    'SOC_STAT', 'nbCdf', 'socChanceAt', 'socKey', 'socLineOf', 'socLean', 'socStatWords', 'SOC_POS', 'socPosWords', 'ptDayOf', 'pct1', 'socRankP', 'SOC_BEST_N',
    'socWeakStat', 'socBestByStat', 'initialsOf', 'headshotUrl', 'avatarHtml', 'socBestStripHtml'].map(lift).join('\n')
    + '\nreturn { evBetsHtml, pickHistoryHtml, socBestStripHtml };')(state, esc, AM, (t) => new RealDate(t).toISOString().slice(11, 16), { nba: 'NBA', nhl: 'NHL', soccer: 'Soccer', nfl: 'NFL' });
} catch (e) { console.log(`  FAIL  the cards lift out of app.js (${e.message})`); process.exit(1); }

// What a card opens with, its summary, and what shows while folded.
const opening = (h) => (h.match(/^<details [^>]*>/) || [''])[0];
const summary = (h) => (h.match(/<summary[^>]*>([\s\S]*?)<\/summary>/) || ['', ''])[1];
const foldLine = (h) => text((summary(h).match(/<span class="pk-fold-k">[\s\S]*?<\/span>/) || [''])[0]);
const draw = () => {
  NOW = RealDate.parse(P.asOf);
  const ev = C.evBetsHtml(P), hist = C.pickHistoryHtml(P.record.history, false);
  NOW = RealDate.parse(S.asOf);
  return { ev, hist, soc: C.socBestStripHtml() };
};

console.log('-- 1. on a phone (390 wide): folded --');
globalThis.window = { innerWidth: 390 };
let d = draw();
for (const [k, h] of Object.entries(d)) console.log(`        ${k}: ${opening(h)}  ${text(summary(h))}`);
ok(opening(d.ev) === '<details class="nba-pp pk-card pk-ev-card pk-fold" data-keep="ev">' && /^<span class="tc-title">Bets with an edge<\/span><span class="tc-rec">¼ Kelly total/.test(summary(d.ev)),
  'Bets with an edge: closed, its head the tap');
// "at DraftKings" since the card took DraftKings' price only (2026-11-27, tests/edgedk.mjs).
ok(foldLine(d.ev) === '2 bets at DraftKings, and Check a price' && /<div class="pk-check">/.test(d.ev.slice(d.ev.indexOf('</summary>'))), 'folded, it says what is in it; Check a price is');
ok(opening(d.hist) === '<details class="nba-pp pk-card pk-hist pk-fold" data-keep="hist">' && foldLine(d.hist) === 'Top 6 Flex won 3 of 14 days, −2.60u · each day’s legs',
  'How the list did: closed, with how the 6-Flex has gone');
ok((d.hist.match(/<details class="pk-day">/g) || []).length === 5 && d.hist.indexOf('<details class="pk-day">') > d.hist.indexOf('</summary>'), 'its day cards inside it');
ok(opening(d.soc) === '<details class="nba-pp pk-card sp-card sp-best pk-fold" data-keep="socbest">' && /^<span class="tc-title">Soccer props<\/span>/.test(summary(d.soc)) && foldLine(d.soc),
  `Soccer props: closed ("${foldLine(d.soc)}")`);
ok(Object.values(d).every((h) => !/<div/.test(summary(h)) && (h.match(/<details/g) || []).length === (h.match(/<\/details>/g) || []).length && h.endsWith('</details>')),
  'each a whole fold: spans in the summary, every details closed');

console.log('\n-- wider (1280): open --');
globalThis.window = { innerWidth: 1280 };
d = draw();
ok(opening(d.ev).endsWith(' open>') && opening(d.hist).endsWith(' open>') && opening(d.soc).endsWith(' open>'), 'all three open, as they were');
globalThis.window = { innerWidth: 640 };
ok(!opening(draw().ev).endsWith(' open>'), 'at 640 still a phone, as the page\'s other phone rules');
globalThis.window = { innerWidth: 641 };
ok(opening(draw().ev).endsWith(' open>'), 'and open from 641');
ok(/\.pk-fold\[open\] \.pk-fold-k \{ display:none; \}/.test(css) && /\.pk-fold > summary \{ min-height:44px;/.test(css) && /\.pk-fold\[open\] > summary \.tc-title::before \{ content:'▾'; \}/.test(css),
  'the line shows only folded; the head is a 44px tap with ▸ and ▾');

console.log('\n-- the redraws keep each as the reader left it --');
const rp = lift('renderPicks');
ok(/const kept = new Map\(\[\.\.\.grid\.querySelectorAll\('details\[data-keep\]'\)\]\.map\(\(x\) => \[x\.dataset\.keep, x\.open\]\)\);/.test(rp), 'every fold, open or closed, read before the redraw');
ok(rp.indexOf('const kept') < rp.indexOf('if (d.error)') && (rp.match(/keepFolds\(\);/g) || []).length === 3 && /dt\.open = o;/.test(rp), 'and put back on all three of its draws: an error, nothing to list, the list');

console.log('\n-- 2. the NBA unders note --');
const how = (/case 'pr-how': \{[\s\S]*?break;\n\s+\}/.exec(app) || [''])[0];
ok(/propRedraw\(sp === 'nba-unders' \? 'nba' : sp\)/.test(how), 'its tap redraws the NBA tab');

console.log('\n-- 3. Soccer, cold --');
const calls = [];
const never = () => new Promise(() => {});
const ui = { soccer: null };
const refresh = new Function('state', 'LIVE_MODE', 'boardReadStart', 'renderSoccer', 'fetchJson', 'renderSlip', 'socSavedLoad', 'async ' + lift('refreshSoccer') + '\nreturn refreshSoccer;')(
  ui, true, () => {}, () => calls.push(ui.soccer), never, () => {}, () => {});
refresh();
await new Promise((r) => setTimeout(r, 0));
ok(calls.length === 1 && calls[0] === null, 'the first visit draws the tab before its reads are in');
ok(/if \(!d\) \{ el\.soccerGrid\.innerHTML = '<div class="nfl-empty">Loading…<\/div>'; return; \}/.test(lift('renderSoccerGrid')), 'which, with no board yet, says "Loading…"');
calls.length = 0; ui.soccer = { games: [] };
refresh();
await new Promise((r) => setTimeout(r, 0));
ok(calls.length === 0, 'a later read keeps the board it has until the new one is in');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
