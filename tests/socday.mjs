// The soccer table, one day at a time, as the NBA and NHL tables (2026-11-11, the owner: "yes, do the
// same for soccer"). What has to hold:
//   1. the table shows the Pacific day of the earliest fixture still to kick off; the count says which day
//   2. the next priced day's fixtures, which the worker now sends as `later`, wait behind one line saying
//      when they come up (the day's last kickoff), with a button that shows them early, and hides them
//   3. a fixture leaves the table at kickoff (it used to stay three hours on its pre-game price); once the
//      day's last has kicked off, the next day's are the table, though the worker is still on the old day
//   4. the league buttons come from the table as drawn, so a league playing only tomorrow gets one when
//      tomorrow is shown, and loses it, back to All, when tomorrow is hidden again
//   5. "Most likely to win" ranks the fixtures in the table
//
// Real data: production's /api/soccer-board?all=1 at 5:06 AM Pacific on Nov 11
// (tests/fixtures/soccer-board-all-20261111.json: Nations League on Thursday Nov 12 and Friday Nov 13,
// one La Liga fixture Friday Nov 20, fifteen in three leagues Saturday Nov 21). Each scene sends the
// tab what the worker now sends (`games` on its day, `later` the next priced day; tests/soccer.mjs pins
// that side). The real app.js's own functions.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(BOARD, f), 'utf8').replace(/\r\n/g, '\n');
const src = read('app.js');
const ALL = JSON.parse(read('tests/fixtures/soccer-board-all-20261111.json'));
const RealDate = Date;
let NOW = RealDate.parse('2026-11-11T13:06:00Z');                 // 5:06 AM Wednesday, Pacific
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

const ptDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new RealDate(iso));
const onDay = (d) => ALL.games.filter((g) => ptDay(g.commence) === d);
// What the worker sends with its matchday on `day` and the next priced day after it.
const sent = (day, laterDay) => ({ leagues: ALL.leagues, leagueList: ALL.leagueList, asOf: ALL.asOf, empty: false,
  slateDay: day, games: onDay(day), laterDay, later: onDay(laterDay) });

const leagues = { innerHTML: '' };
const el = { soccerGrid: { innerHTML: '', querySelector: () => null }, soccerCount: { textContent: '' } };
const state = { soccerLeague: 'all' };
const noop = () => '';
const ARGS = { state, el, document: { getElementById: (id) => (id === 'soccerLeagues' ? leagues : null) },
  socPropsCardHtml: noop, hotCardHtml: noop, miniBar: noop, offerStar: noop, soccerMlLeg: () => ({}), soccerDetail: noop };
const NAMES = ['esc', 'AM', 'BOOK_LABEL', 'bkLabel', 'ptDayOf', 'propDayName', 'propDayTitle', 'soccerKick', 'kickWhole',
  'mlDaySplit', 'mlLaterOpen', 'mlLaterHtml', 'mlTableGames', 'mlCountText', 'CLUB_DROP', 'shortClub',
  'renderSoccerLeagues', 'soccerEmptyHtml', 'soccerFavCard', 'soccerRow', 'renderSoccerGrid', 'renderSoccer', 'dispatchAction'];
let F = null;
try {
  F = new Function(...Object.keys(ARGS), NAMES.map(lift).join('\n') + '\nreturn { renderSoccer, dispatchAction };')(...Object.values(ARGS));
} catch (e) { ok(false, `the table comes from app.js: ${e.message}`); }

const html = () => el.soccerGrid.innerHTML;
const rows = () => [...html().matchAll(/aria-label="([^"]+) — toggle breakdown"/g)].map((m) => m[1]);
const line = () => { const m = html().match(/<div class="ml-later"><p>([^<]*)<\/p>/); return m ? m[1] : null; };
const button = () => {
  const m = html().match(/<button type="button" class="pk-days-more" data-action="ml-later" data-sport="(\w+)" data-day="([\d-]+)" aria-expanded="(\w+)">([^<]*)<\/button>/);
  return m && { sport: m[1], day: m[2], expanded: m[3], label: m[4] };
};
const chips = () => [...leagues.innerHTML.matchAll(/data-league="([^"]+)"/g)].map((m) => m[1]);
const favs = () => [...html().matchAll(/data-action="soccer-fav-jump" data-id="([^"]+)"/g)].map((m) => m[1]);
const count = () => el.soccerCount.textContent;
// A tap on the button as it is drawn, through the page's own click handler.
const tap = (b) => (b ? F.dispatchAction({ dataset: { action: 'ml-later', sport: b.sport, day: b.day }, getAttribute: (k) => (k === 'aria-expanded' ? b.expanded : null) }, null)
  : ok(false, 'there is a button to tap'));

if (F) {
  console.log('\n-- 5:06 AM Wednesday: Thursday is the matchday --');
  state.soccer = sent('2026-11-12', '2026-11-13');
  F.renderSoccer();
  let r = rows();
  ok(r.length === 7 && r.includes('Croatia at England') && !r.includes('Germany at Serbia'), `Thursday's seven, not Friday's: ${r.slice(0, 3).join(', ')}…`);
  ok(count() === '7 fixtures tomorrow', `the count says the day: "${count()}"`);
  ok(line() === 'Friday’s 10 fixtures show here once tomorrow’s last fixture kicks off, at 11:45 AM.', `under the table: "${line()}"`);
  let b = button();
  ok(b && b.sport === 'soccer' && b.label === 'Show them now' && b.expanded === 'false' && b.day === '2026-11-12', `a button to show them early: "${b && b.label}"`);
  ok(chips().length === 0, 'one league in the table: no league buttons');

  console.log('\n-- "Show them now" --');
  tap(b);
  r = rows();
  ok(r.length === 17 && r[16] && r.slice(7).every((x) => onDay('2026-11-13').some((g) => `${g.away} at ${g.home}` === x)), `Friday's ten join the table, after Thursday's (${r.length} rows)`);
  ok(line() === 'Friday’s 10 fixtures are in the table, after tomorrow’s.' && button().label === 'Hide them', `"${line()}" / "${button().label}"`);
  ok(count() === '7 fixtures tomorrow', 'the count stays the day\'s');
  tap(button());
  ok(rows().length === 7 && button().label === 'Show them now', '"Hide them": back to Thursday\'s seven');

  console.log('\n-- 10:00 AM Thursday: the two 9 AM kickoffs are under way --');
  NOW = RealDate.parse('2026-11-12T18:00:00Z');
  F.renderSoccer();
  r = rows();
  ok(r.length === 5 && !r.includes('Belgium at Turkey') && !r.includes('Cyprus at Armenia') && count() === '5 fixtures today', `kicked off, they leave the table: "${count()}"`);
  ok(line() === 'Tomorrow’s 10 fixtures show here once today’s last fixture kicks off, at 11:45 AM.', `the line waits for 11:45: "${line()}"`);

  console.log('\n-- 11:50 AM Thursday: all of Thursday has kicked off; the worker is still on Thursday --');
  NOW = RealDate.parse('2026-11-12T19:50:00Z');
  F.renderSoccer();
  r = rows();
  ok(r.length === 10 && r.includes('Germany at Serbia') && count() === '10 fixtures tomorrow', `Friday's ten are the table: "${count()}"`);
  ok(line() === null, 'no line: nothing later on the board');
  ok(favs().length === 2 && favs().every((id) => onDay('2026-11-13').some((g) => g.id === id)), `"Most likely to win" ranks Friday's two priced fixtures (${favs().length})`);

  console.log('\n-- 1:00 AM Friday Nov 20: one La Liga fixture today, three leagues tomorrow --');
  NOW = RealDate.parse('2026-11-20T09:00:00Z');
  state.soccer = sent('2026-11-20', '2026-11-21');
  F.renderSoccer();
  ok(rows().join() === 'Espanyol at Athletic Bilbao' && count() === '1 fixture today', `today's one: "${count()}"`);
  ok(line() === 'Tomorrow’s 15 fixtures show here once today’s last fixture kicks off, at 12:00 PM.', `"${line()}"`);
  ok(chips().length === 0, 'tomorrow\'s leagues get no button while tomorrow is not in the table');
  tap(button());
  ok(rows().length === 16 && chips().join() === 'all,epl,laliga,seriea' && /3 leagues/.test(leagues.innerHTML), `shown early, its leagues get buttons: ${chips().join(', ')}`);
  state.soccerLeague = 'epl';
  F.renderSoccer();
  r = rows();
  ok(r.length === 7 && r.includes('Fulham at Manchester City') && r.includes('Arsenal at Newcastle United'), `Premier League: tomorrow's seven (${r.length})`);
  ok(line() === 'Tomorrow’s 7 fixtures are in the table, after today’s.', `the line counts the league's: "${line()}"`);
  tap(button());
  ok(state.soccerLeague === 'all' && chips().length === 0 && rows().join() === 'Espanyol at Athletic Bilbao', 'hidden again, the Premier League has nothing left in the table: back to All, today\'s one');
}

console.log('\n-- the page --');
ok(/else if \(s === 'soccer'\) renderSoccer\(\)/.test(src), 'the button redraws the soccer tab');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
