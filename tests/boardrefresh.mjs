// The sport tabs read their game lines again (2026-11-10, the owner's report: "for games taking place
// the next day in this case the NBA or NHL it doesnt show the team stats in terms of the Money Line ...
// it seems to only be available in the mobile view"). Each tab read its board once a page load. A page
// left open (the desktop; a phone opens the site fresh) kept the first read: its games dropped off as
// they started, the next day's never came, and the tab said "No NBA games in the next day and a half"
// while production had six. On the desktop the rows also never said which day a game was.
// What has to hold:
//   1. a tab reads its board on the first visit and again once that read is five minutes old, from the
//      tab switch and from a one-minute timer -- never twice inside the five minutes
//   2. the timer waits while the page is out of sight and reads the moment it is back; it leaves a tab
//      alone while something in it is being typed into; Picks, MLB and Entries keep their own reads
//   3. each read is stamped when it starts, so a slow one is not sent again before it lands
//   4. NBA, NHL, NFL and soccer rows say the day and time on the desktop, where the head line's time is
//      hidden; a shut phone row shows the time once
//
// Real data: production's /api/nba-board and /api/nhl-board at 2:24 AM Pacific on Nov 10
// (tests/fixtures/nba-board-20261110.json, nhl-board-20261110.json: six and seven games that evening),
// the NFL board of Oct 25 and the MLS board of Oct 28. The next day's NBA read is the same read moved a
// day on. The real app.js's own functions and the real style.css.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(BOARD, f), 'utf8').replace(/\r\n/g, '\n');
const src = read('app.js'), css = read('style.css');
const NBA = JSON.parse(read('tests/fixtures/nba-board-20261110.json'));
const NHL = JSON.parse(read('tests/fixtures/nhl-board-20261110.json'));
const NFL = JSON.parse(read('tests/fixtures/nfl-board-20261025.json')).board;
const SOC = JSON.parse(read('tests/fixtures/soccer-board-mls-20261028.json'));
const RealDate = Date;
let NOW = RealDate.parse('2026-11-10T10:24:00Z');                 // 2:24 AM Pacific, when the boards were read
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
const MIN = 60e3;
const settle = () => new Promise((r) => setImmediate(r));

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

// The page: a document whose elements are made on first ask, the tab's state, and the server.
const els = {};
const elOf = (id) => (els[id] ||= { id, innerHTML: '', textContent: '', hidden: false, contains: (a) => !!a && a.inside === id });
const doc = { hidden: false, body: { tagName: 'BODY' }, getElementById: elOf };
doc.activeElement = doc.body;
const state = { sport: 'nba' };
const server = { '/api/nba-board': NBA, '/api/nhl-board': NHL, '/api/nfl-board': NFL, '/api/soccer-board': SOC };
const reads = [];
let hold = null;                                                   // a read that has not come back yet
const fetchJson = (u) => {
  reads.push(u);
  if (hold && u === hold.path) return hold.p;
  return server[u] ? Promise.resolve(structuredClone(server[u])) : Promise.reject(new Error('not read in this test'));
};
const boardReads = (p) => reads.filter((u) => u === p).length;
const drawn = { nhl: 0, soccer: 0, nfl: 0 };
const noop = () => '';

const HELPERS = ['esc', 'AM', 'BOOK_LABEL', 'bkLabel', 'signed', 'impliedPct', 'r1', 'soccerKick', 'kickWhole', 'nbaNick', 'nflNick', 'nhlNick', 'ML_TABS', 'ptDayOf', 'propDayName', 'propDayTitle', 'mlDaySplit', 'mlLaterOpen', 'mlLaterHtml', 'mlTableGames', 'mlCountText',
  'mlTabRow', 'renderNba', 'nflMlBar', 'nflRow', 'soccerRow'];
const ARGS = { state, document: doc, LIVE_MODE: true, fetchJson,
  renderNhl: () => { drawn.nhl++; }, renderSoccer: () => { drawn.soccer++; }, renderNfl: () => { drawn.nfl++; }, renderSlip: noop,
  propSavedLoad: noop, socSavedLoad: noop, propsCardHtml: noop, nbaPpCardHtml: noop, nbaHotCardHtml: noop,
  offerStar: noop, miniBar: noop, avatarHtml: noop, shortClub: (n) => n,
  nbaMlLeg: () => ({}), nhlMlLeg: () => ({}), nflMlLeg: () => ({}), soccerMlLeg: () => ({}), mlTabDetail: noop, nflDetail: noop, soccerDetail: noop };
const build = (names, extra, ret) => new Function(...Object.keys(ARGS), [...names.map(lift), ...extra].join('\n') + `\nreturn { ${ret} };`)(...Object.values(ARGS));

let R = null;
try { R = build(HELPERS, [], 'soccerKick, mlTabRow, renderNba, nflRow, soccerRow'); } catch (e) { ok(false, `the rows come from app.js: ${e.message}`); }
let B = null;
try {
  const stale = src.match(/const BOARD_STALE_MS = [^;\n]+;/);
  if (!stale) throw new Error('app.js has no BOARD_STALE_MS');
  B = build([...HELPERS, 'BOARD_READ', 'BOARD_BOX', 'boardStale', 'boardReadStart', 'boardTick'],
    [stale[0], ...['refreshNba', 'refreshNhl', 'refreshSoccer', 'refreshNfl'].map((n) => 'async ' + lift(n))],
    'BOARD_STALE_MS, boardStale, boardTick, refreshNba');
} catch (e) { ok(false, `the board reads come from app.js: ${e.message}`); }

const rowCount = () => (els.nbaGrid.innerHTML.match(/<div class="board-row/g) || []).length;
const subsOf = (html) => [...html.matchAll(/<span class="matchup-sub">([^<]*)<\/span>/g)].map((m) => m[1]);

// A row's time, held on one line: "Tue 4:40 PM" with no space a line can break at.
const NB = ' ';
const whole = (iso) => R.soccerKick(iso).replace(/\s/g, NB);

if (B && R) {
  console.log('\n-- 2:24 AM: the NBA tab opens --');
  ok(B.BOARD_STALE_MS === 5 * MIN, 'five minutes is old');
  ok(B.boardStale('nba'), 'a board never read is due');
  await B.refreshNba();
  ok(boardReads('/api/nba-board') === 1 && state.nba.games.length === 6, `one read: ${state.nba.games.length} games`);
  ok(rowCount() === 6 && els.nbaCount.textContent === '6 games today', `the table draws them: ${els.nbaCount.textContent}`);

  console.log('\n-- inside five minutes the timer leaves it; past five it reads --');
  NOW += 2 * MIN;
  ok(B.boardTick() === false && boardReads('/api/nba-board') === 1, '2 minutes on: no read');
  NOW += 3 * MIN - 1000;
  ok(B.boardTick() === false && !B.boardStale('nba'), 'a second short of five: still none');
  NOW += 2000;
  ok(B.boardTick() === true && boardReads('/api/nba-board') === 2, 'a second past five: read again');
  await settle();
  const lastRead = NOW;

  console.log('\n-- 9:30 PM: every game on that read has tipped --');
  NOW = RealDate.parse('2026-11-11T05:30:00Z');
  R.renderNba();
  ok(/No NBA games in the next day and a half/.test(els.nbaGrid.innerHTML) && rowCount() === 0,
    'drawn from the 2:24 AM read, the tab says what the desktop said: "No NBA games in the next day and a half"');
  const DAY = 24 * 60 * MIN;
  server['/api/nba-board'] = { ...structuredClone(NBA), asOf: new RealDate(RealDate.parse(NBA.asOf) + DAY).toISOString(),
    games: NBA.games.map((g) => ({ ...structuredClone(g), commence: new RealDate(RealDate.parse(g.commence) + DAY).toISOString() })) };
  ok(B.boardStale('nba') && NOW - lastRead > 5 * MIN, 'that read is hours old, so it is due');
  ok(B.boardTick() === true, 'the timer reads');
  await settle();
  const subs = subsOf(els.nbaGrid.innerHTML);
  ok(rowCount() === 6 && els.nbaCount.textContent === '6 games tomorrow' && !/No NBA games/.test(els.nbaGrid.innerHTML), `the next day's six games are on the tab: ${els.nbaCount.textContent}`);
  ok(subs.length === 6 && subs.every((s) => new RegExp(` · Wed${NB}\\d`).test(s)), `each says it is Wednesday's: "${subs[0]}"`);

  console.log('\n-- out of sight, and typing --');
  NOW += 6 * MIN;
  doc.hidden = true;
  const n0 = reads.length;
  ok(B.boardTick() === false && reads.length === n0, 'a hidden page is not read');
  doc.hidden = false;
  ok(B.boardTick() === true && boardReads('/api/nba-board') === 4, 'back on screen it reads at once (the visibilitychange listener runs boardTick)');
  await settle();
  NOW += 6 * MIN;
  const n1 = reads.length;
  doc.activeElement = { tagName: 'INPUT', inside: 'nbaBoard' };
  ok(B.boardTick() === false, 'typing in the tab ("Find a player") holds the read, so the redraw does not take the cursor');
  doc.activeElement = { tagName: 'SELECT', inside: 'nbaBoard' };
  ok(B.boardTick() === false && reads.length === n1, 'a menu open in the tab holds it too');
  doc.activeElement = { tagName: 'INPUT', inside: 'header' };
  ok(B.boardTick() === true, 'the search box above the tabs does not');
  doc.activeElement = doc.body;
  await settle();

  console.log('\n-- a slow read --');
  NOW += 6 * MIN;
  let release;
  hold = { path: '/api/nba-board', p: new Promise((r) => { release = r; }) };
  const n2 = boardReads('/api/nba-board');
  ok(B.boardTick() === true, 'the read goes out');
  NOW += 90e3;
  ok(B.boardTick() === false && boardReads('/api/nba-board') === n2 + 1, 'a minute and a half later, not back yet: not sent again');
  release(structuredClone(server['/api/nba-board']));
  hold = null;
  await settle();
  ok(rowCount() === 6, 'it lands and draws');

  console.log('\n-- the other tabs --');
  const n3 = reads.length;
  for (const s of ['picks', 'mlb', 'entries']) { state.sport = s; NOW += 6 * MIN; ok(B.boardTick() === false, `${s}: left to its own reads`); }
  ok(reads.length === n3, 'none of them read a game-line board');
  state.sport = 'nhl';
  ok(B.boardTick() === true, 'NHL, never read: reads');
  await settle();
  ok(boardReads('/api/nhl-board') === 1 && state.nhl.games.length === 7 && drawn.nhl === 1, `NHL: ${state.nhl.games.length} games, drawn`);
  NOW += 3 * MIN;
  ok(B.boardTick() === false, 'NHL inside five minutes: no read');
  state.sport = 'soccer';
  ok(B.boardTick() === true, 'soccer reads');
  await settle();
  ok(boardReads('/api/soccer-board') === 1 && state.soccer.games.length === SOC.games.length && drawn.soccer === 1, `soccer: ${state.soccer.games.length} games, drawn`);
  state.sport = 'nfl';
  ok(B.boardTick() === true, 'NFL reads');
  await settle();
  ok(boardReads('/api/nfl-board') === 1 && state.nfl.games.length === NFL.games.length && drawn.nfl === 1, `NFL: ${state.nfl.games.length} games, drawn`);
}

console.log('\n-- the wiring --');
const sw = (() => { try { return lift('setSport'); } catch (e) { return ''; } })();
for (const [s, fn] of [['nba', 'refreshNba'], ['nhl', 'refreshNhl'], ['soccer', 'refreshSoccer']]) {
  ok(new RegExp(`if \\(s === '${s}' && boardStale\\('${s}'\\)\\) ${fn}\\(\\);`).test(sw) && !new RegExp(`!state\\.${s}\\) ${fn}`).test(sw),
    `switching to ${s.toUpperCase()} reads its board once it is five minutes old, not only the first time`);
}
ok(/if \(nfl && boardStale\('nfl'\)\) refreshNfl\(\);/.test(sw) && !/!state\.nfl\) refreshNfl/.test(sw), 'switching to NFL too');
ok(/setInterval\(boardTick, 60000\);/.test(src), 'the timer looks once a minute');
ok(/document\.addEventListener\('visibilitychange', \(\) => \{ if \(!document\.hidden\) boardTick\(\); \}\);/.test(src), 'and when the page comes back on screen');
for (const n of ['refreshNba', 'refreshNhl', 'refreshSoccer', 'refreshNfl']) {
  const s = (() => { try { return lift(n); } catch (e) { return ''; } })();
  const sp = { refreshNba: 'nba', refreshNhl: 'nhl', refreshSoccer: 'soccer', refreshNfl: 'nfl' }[n];
  ok(new RegExp(`if \\(!LIVE_MODE\\) return;\\n\\s*boardReadStart\\('${sp}'\\);`).test(s), `${n} stamps its read before it asks`);
}

console.log('\n-- the start time on a desktop row --');
if (R) {
  const show = (s) => s.replace(/ /g, ' ');
  const nbaSubs = subsOf(NBA.games.map((g) => R.mlTabRow(g, 'nba')).join(''));
  ok(nbaSubs.length === 6 && NBA.games.every((g, i) => nbaSubs[i] === `${g.away} at ${g.home} · ${whole(g.commence)}`) && nbaSubs.every((s) => new RegExp(` · Tue${NB}\\d`).test(s)),
    `NBA: "${show(nbaSubs[0] || '')}"`);
  ok(nbaSubs.every((s) => !/\s/.test(s.split(' · ').pop().replace(/ /g, ''))),
    'the time holds together: a wrapped sub-line breaks before "Tue 4:40 PM", not inside it');
  const nhlSubs = subsOf(NHL.games.map((g) => R.mlTabRow(g, 'nhl')).join(''));
  ok(nhlSubs.length === 7 && NHL.games.every((g, i) => nhlSubs[i] === `${g.away} at ${g.home} · ${whole(g.commence)}`),
    `NHL: "${show(nhlSubs[0] || '')}"`);
  const nflSubs = NFL.games.map((g) => (R.nflRow(g).match(/<span class="matchup-sub">([^<]*)<\/span>/) || [])[1] || '');
  ok(NFL.games.length > 0 && NFL.games.every((g, i) => nflSubs[i].includes(` · ${whole(g.commence)} · `) || nflSubs[i].startsWith(whole(g.commence))),
    `NFL: "${show(nflSubs[0])}"`);
  const socSubs = SOC.games.map((g) => (R.soccerRow(g).match(/<span class="matchup-sub">([^<]*)<\/span>/) || [])[1] || '');
  ok(SOC.games.length > 0 && SOC.games.every((g, i) => socSubs[i].startsWith(`${g.leagueLabel} · ${whole(g.commence)}`)), `soccer: "${show(socSubs[0])}"`);
}
ok(/^\.board-row \.row-when \{ display:none \}/m.test(css), 'the head line time is hidden on the desktop, which is why the sub-line carries it');
const phone = [...css.matchAll(/@media \(max-width:900px\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join('\n');
ok(/\.board-row:not\(\.expanded\) \.row-when \{ display:inline/.test(phone) && /\.board-row:not\(\.expanded\) \.matchup-sub,[\s\S]*?\{ display:none \}/.test(phone),
  'a shut phone row shows the head line time and hides the sub-line, so the time shows once');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
