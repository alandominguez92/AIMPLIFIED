// The NFL moneyline table, one day at a time, as the NBA, NHL and soccer tables (2026-11-11, the owner:
// "do the same for the NFL table"). The worker already sent one slate day; what has to hold now:
//   1. the count says which day ("1 game tomorrow · week 10")
//   2. the next slate, which the worker now sends as `later`, waits behind one line saying when it comes
//      up (the slate's last kickoff), with a button that shows it early, and hides it again
//   3. once the slate's last game has kicked off, the next slate is the table, though the worker keeps
//      the kicked-off slate for six hours; the table used to read "No NFL games left on this slate"
//   4. games still leave the table at kickoff, as before
//
// Real data: production's /api/nfl-board at 2:36 PM Pacific on Wednesday Nov 11, right after the worker
// began sending `later` (tests/fixtures/nfl-board-20261111.json: Commanders @ Giants Thursday at 5:15 PM,
// and Sunday's twelve, Patriots @ Lions at 6:30 AM through Steelers @ Bengals at 5:20 PM). The real
// app.js's own functions.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(BOARD, f), 'utf8').replace(/\r\n/g, '\n');
const src = read('app.js');
const NFL = JSON.parse(read('tests/fixtures/nfl-board-20261111.json'));
const RealDate = Date;
let NOW = RealDate.parse('2026-11-11T22:36:00Z');                 // 2:36 PM Wednesday, Pacific
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
function lift(name) {
  let at = src.indexOf(`function ${name}(`);
  const isConst = at < 0;
  if (isConst) at = src.indexOf(`const ${name} =`);
  if (at < 0) throw new Error(`app.js has no ${name}`);
  let depth = 0, seen = false;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === '{' || c === '(' || c === '[') { depth++; seen = true; }
    else if (c === '}' || c === ')' || c === ']') depth--;
    if (seen && depth === 0) {
      if (!isConst && c === '}') return src.slice(at, i + 1);
      if (isConst && (src[i + 1] === ';' || src[i + 1] === '\n')) return src.slice(at, i + 2);
    }
  }
  throw new Error(`could not close ${name}`);
}

const els = {};
const elOf = (id) => (els[id] ||= { id, innerHTML: '', textContent: '' });
const el = { nflBoardTitle: elOf('nflBoardTitle'), nflCount: elOf('nflCount') };
const state = { nfl: NFL };
const noop = () => '';
const ARGS = { state, el, document: { getElementById: elOf }, gmRecordHtml: noop, propsCardHtml: noop, hotCardHtml: noop,
  miniBar: noop, offerStar: noop, avatarHtml: noop, nflMlLeg: () => ({}), nflDetail: noop };
const NAMES = ['esc', 'AM', 'BOOK_LABEL', 'bkLabel', 'signed', 'soccerKick', 'kickWhole', 'nbaNick', 'nflNick', 'ptDayOf', 'propDayName', 'propDayTitle',
  'mlDaySplit', 'mlLaterOpen', 'mlLaterHtml', 'mlTableGames', 'mlCountText', 'NFL_ML_COLS', 'nflTable', 'nflMlBar', 'nflRow',
  'renderNflMoneyline', 'renderNfl', 'dispatchAction'];
let F = null;
try {
  F = new Function(...Object.keys(ARGS), NAMES.map(lift).join('\n') + '\nreturn { renderNfl, dispatchAction };')(...Object.values(ARGS));
} catch (e) { ok(false, `the table comes from app.js: ${e.message}`); }

const html = () => els.nflMlGrid.innerHTML;
const rows = () => [...html().matchAll(/aria-label="([^"]+) — toggle breakdown"/g)].map((m) => m[1]);
const line = () => { const m = html().match(/<div class="ml-later"><p>([^<]*)<\/p>/); return m ? m[1] : null; };
const button = () => {
  const m = html().match(/<button type="button" class="pk-days-more" data-action="ml-later" data-sport="(\w+)" data-day="([\d-]+)" aria-expanded="(\w+)">([^<]*)<\/button>/);
  return m && { sport: m[1], day: m[2], expanded: m[3], label: m[4] };
};
const count = () => el.nflCount.textContent;
// A tap on the button as it is drawn, through the page's own click handler.
const tap = (b) => (b ? F.dispatchAction({ dataset: { action: 'ml-later', sport: b.sport, day: b.day }, getAttribute: (k) => (k === 'aria-expanded' ? b.expanded : null) }, null)
  : ok(false, 'there is a button to tap'));

if (F) {
  console.log('\n-- 2:36 PM Wednesday: Thursday night is the slate --');
  F.renderNfl();
  ok(rows().join() === 'WAS at NYG', `Thursday's one game: ${rows().join(', ')}`);
  ok(count() === '1 game tomorrow · week 10', `the count says the day: "${count()}"`);
  ok(line() === 'Sunday’s 12 games show here once tomorrow’s last game starts, at 5:15 PM.', `under the table: "${line()}"`);
  const b = button();
  ok(b && b.sport === 'nfl' && b.label === 'Show them now' && b.expanded === 'false' && b.day === '2026-11-12', `a button to show them early: "${b && b.label}"`);

  console.log('\n-- "Show them now" --');
  tap(b);
  const r = rows();
  ok(r.length === 13 && r[0] === 'WAS at NYG' && r[1] === 'NE at DET' && r[12] === 'PIT at CIN', `Sunday's twelve join the table, after Thursday's (${r.length} rows, ${r[1]} first, ${r[12]} last)`);
  ok(line() === 'Sunday’s 12 games are in the table, after tomorrow’s.' && button().label === 'Hide them', `"${line()}" / "${button() && button().label}"`);
  ok(count() === '1 game tomorrow · week 10', 'the count stays the day\'s');
  tap(button());
  ok(rows().join() === 'WAS at NYG' && (button() || {}).label === 'Show them now', '"Hide them": back to Thursday\'s one');

  console.log('\n-- 5:20 PM Thursday: kicked off; the worker keeps Thursday\'s slate till 11:15 --');
  NOW = RealDate.parse('2026-11-13T01:20:00Z');
  F.renderNfl();
  ok(rows().length === 12 && rows()[0] === 'NE at DET' && count() === '12 games Sunday · week 10', `Sunday's twelve are the table: "${count()}"`);
  ok(line() === null && !/No NFL games left/.test(html()), 'no line, and no "No NFL games left on this slate"');

  console.log('\n-- 6:35 AM Sunday: the Lions\' game has kicked off --');
  NOW = RealDate.parse('2026-11-15T14:35:00Z');
  F.renderNfl();
  ok(rows().length === 11 && !rows().includes('NE at DET') && count() === '11 games today · week 10', `it leaves the table, as before: "${count()}"`);
}

console.log('\n-- the page --');
ok(/else if \(s === 'nfl'\) renderNfl\(\)/.test(src), 'the button redraws the NFL tab');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
