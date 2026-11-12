// The NBA and NHL moneyline tables, one day at a time (2026-11-11, the owner: "start with the games of
// the day then follow up by showing the games of the next day once all the games of the day take
// place"). What has to hold:
//   1. the table shows the Pacific day of the earliest game still to start; the count says which day
//   2. the next day's games wait behind one line saying when they come up (the day's last start), with
//      a button that shows them early, and hides them again
//   3. as the day's games start they leave the table, as before; once the last has started, the next
//      day's are the table
//   4. a board with one day on it draws no line
//   5. showing them early lasts the day it was opened on
//
// Real data: production's /api/nhl-board and /api/nba-board at 12:30 AM Pacific on Nov 11
// (tests/fixtures/nhl-board-20261111.json: six games Wednesday and Hurricanes @ Kraken at 9 AM Thursday,
// in Helsinki; nba-board-20261111.json: ten games, all Wednesday). The real app.js's own functions,
// the real style.css.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(BOARD, f), 'utf8').replace(/\r\n/g, '\n');
const src = read('app.js'), css = read('style.css');
const NHL = JSON.parse(read('tests/fixtures/nhl-board-20261111.json'));
const NBA = JSON.parse(read('tests/fixtures/nba-board-20261111.json'));
const RealDate = Date;
let NOW = RealDate.parse('2026-11-11T08:30:00Z');                 // 12:30 AM Wednesday, Pacific
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
const state = { nhl: NHL, nba: NBA };
const noop = () => '';
const ARGS = { state, document: { getElementById: elOf }, nhlRecordHtml: noop, propsCardHtml: noop, nhlPpCardHtml: noop, hotCardHtml: noop,
  nbaPpCardHtml: noop, nbaHotCardHtml: noop, offerStar: noop, miniBar: noop, avatarHtml: noop, nbaMlLeg: () => ({}), nhlMlLeg: () => ({}), mlTabDetail: noop };
const NAMES = ['esc', 'AM', 'BOOK_LABEL', 'bkLabel', 'impliedPct', 'r1', 'soccerKick', 'kickWhole', 'nbaNick', 'nhlNick', 'ptDayOf', 'propDayName', 'propDayTitle',
  'ML_TABS', 'mlTabRow', 'mlDaySplit', 'mlLaterOpen', 'mlLaterHtml', 'mlTableGames', 'mlCountText', 'renderNba', 'renderNhl', 'dispatchAction'];
let F = null;
try {
  F = new Function(...Object.keys(ARGS), NAMES.map(lift).join('\n') + '\nreturn { renderNba, renderNhl, dispatchAction, mlLaterOpen };')(...Object.values(ARGS));
} catch (e) { ok(false, `the tables come from app.js: ${e.message}`); }

const teams = (id) => [...els[id].innerHTML.matchAll(/aria-label="([^"]+) — toggle breakdown"/g)].map((m) => m[1]);
const line = (id) => { const m = els[id].innerHTML.match(/<div class="ml-later"><p>([^<]*)<\/p>/); return m ? m[1] : null; };
const button = (id) => {
  const m = els[id].innerHTML.match(/<button type="button" class="pk-days-more" data-action="ml-later" data-sport="(\w+)" data-day="([\d-]+)" aria-expanded="(\w+)">([^<]*)<\/button>/);
  return m && { sport: m[1], day: m[2], expanded: m[3], label: m[4] };
};
// A tap on the button as it is drawn, through the page's own click handler.
const tap = (b) => F.dispatchAction({ dataset: { action: 'ml-later', sport: b.sport, day: b.day }, getAttribute: (k) => (k === 'aria-expanded' ? b.expanded : null) }, null);

if (F) {
  console.log('\n-- 12:30 AM Wednesday: the NHL tab --');
  F.renderNhl();
  let t = teams('nhlGrid');
  ok(t.length === 6 && !t.some((x) => /Hurricanes/.test(x)), `Wednesday's six: ${t.join(', ')}`);
  ok(els.nhlCount.textContent === '6 games today', `the count says the day: "${els.nhlCount.textContent}"`);
  ok(line('nhlGrid') === 'Tomorrow’s game shows here once today’s last game starts, at 7:10 PM.', `under the table: "${line('nhlGrid')}"`);
  let b = button('nhlGrid');
  ok(b && b.label === 'Show it now' && b.expanded === 'false' && b.day === '2026-11-11', `a button to show it early: "${b && b.label}"`);

  console.log('\n-- "Show it now" --');
  tap(b);
  t = teams('nhlGrid');
  ok(t.length === 7 && /Hurricanes/.test(t[6]), `Thursday's game joins the table, last: ${t[6]}`);
  ok(line('nhlGrid') === 'Tomorrow’s game is in the table, after today’s.' && button('nhlGrid').label === 'Hide it', `"${line('nhlGrid')}" / "${button('nhlGrid').label}"`);
  ok(els.nhlCount.textContent === '6 games today', 'the count stays the day\'s');
  ok(!F.mlLaterOpen('nhl', { day: '2026-11-12' }), 'opened on Wednesday, it does not carry into Thursday');
  tap(button('nhlGrid'));
  ok(teams('nhlGrid').length === 6 && button('nhlGrid').label === 'Show it now', '"Hide it": back to Wednesday\'s six');

  console.log('\n-- 4:15 PM: the first puck has dropped --');
  NOW = RealDate.parse('2026-11-12T00:15:00Z');
  F.renderNhl();
  t = teams('nhlGrid');
  ok(t.length === 5 && !t.some((x) => /Lightning/.test(x)) && els.nhlCount.textContent === '5 games today', `Lightning @ Sabres has left, as a started game always has: ${els.nhlCount.textContent}`);
  ok(/once today’s last game starts, at 7:10 PM/.test(line('nhlGrid') || ''), 'the line still waits for 7:10');

  console.log('\n-- 7:15 PM: the last two have started --');
  NOW = RealDate.parse('2026-11-12T03:15:00Z');
  F.renderNhl();
  t = teams('nhlGrid');
  ok(t.length === 1 && /Hurricanes/.test(t[0]) && els.nhlCount.textContent === '1 game tomorrow', `Thursday's game is the table: ${t[0]} · "${els.nhlCount.textContent}"`);
  ok(line('nhlGrid') === null, 'no line: nothing later on the board');
  NOW = RealDate.parse('2026-11-12T17:05:00Z');
  F.renderNhl();
  ok(/No NHL games in the next day and a half/.test(els.nhlGrid.innerHTML), 'and once it has started, the board is empty until the next capture, as before');

  console.log('\n-- the NBA tab: ten games, all Wednesday --');
  NOW = RealDate.parse('2026-11-11T08:30:00Z');
  F.renderNba();
  ok(teams('nbaGrid').length === 10 && els.nbaCount.textContent === '10 games today', `all ten: "${els.nbaCount.textContent}"`);
  ok(!/class="ml-later"/.test(els.nbaGrid.innerHTML), 'one day on the board: no line');
}

console.log('\n-- the page --');
ok(/^\.ml-later \{ margin-top:12px; \}/m.test(css) && /^\.ml-later p \{[^}]*color:var\(--textDim\)/m.test(css), 'the line is dimmed text over the "show more" button the Picks tab uses');
ok(/case 'ml-later': \{/.test(src), 'the button is wired');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
