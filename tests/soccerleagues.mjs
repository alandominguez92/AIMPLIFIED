// The soccer tab shows a league's button only when it has a game (2026-10-15).
//
// All seven leagues got a button every day -- eight with "All", four rows on a
// phone -- while Nations League plays only in the international breaks, and
// MLS and Liga MX finish in November. Now a league's button comes and goes
// with its fixtures; a league picked earlier that has nothing left falls back
// to All; and a board with one league shows no buttons, since "All" and that
// league would show the same games.
//
// renderSoccerLeagues is lifted out of app.js, so the test runs what ships.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
const src = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const at = src.indexOf('function renderSoccerLeagues(');
if (at < 0) throw new Error('app.js has no renderSoccerLeagues');
let depth = 0, end = -1;
for (let i = src.indexOf('{', at); i < src.length; i++) {
  if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
}
const box = { innerHTML: '' };
const document = { getElementById: (id) => (id === 'soccerLeagues' ? box : null) };
const esc = (s) => String(s == null ? '' : s);
const state = {};
const render = new Function('state', 'esc', 'document', src.slice(at, end) + '\nreturn renderSoccerLeagues;')(state, esc, document);

const leagueList = [
  ['epl', 'Premier League'], ['laliga', 'La Liga'], ['ucl', 'Champions League'], ['seriea', 'Serie A'],
  ['ligamx', 'Liga MX'], ['mls', 'MLS'], ['uefanl', 'Nations League'],
].map(([key, label]) => ({ key, label, country: '' }));
const games = (...lgs) => lgs.map((league, i) => ({ id: 'g' + i, league }));
const buttons = () => [...box.innerHTML.matchAll(/data-league="([^"]+)"/g)].map((m) => m[1]);

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

state.soccer = { leagueList, games: games('epl', 'epl', 'mls', 'laliga') };
state.soccerLeague = 'all';
render();
ok(buttons().join(',') === 'all,epl,laliga,mls', `a weekend: All plus the three leagues playing (${buttons().join(', ')})`);
ok(!buttons().includes('uefanl'), 'Nations League out of its window has no button');
ok(/3 leagues/.test(box.innerHTML), '"All" counts the leagues shown');

state.soccer = { leagueList, games: games('uefanl', 'uefanl', 'ligamx') };
render();
ok(buttons().includes('uefanl'), 'and it comes back when it has a fixture');

state.soccerLeague = 'uefanl';
state.soccer = { leagueList, games: games('epl', 'mls') };
render();
ok(state.soccerLeague === 'all', 'a league picked earlier with nothing left falls back to All');

state.soccer = { leagueList, games: games('ucl', 'ucl') };
render();
ok(box.innerHTML === '', 'one league is the whole board: no buttons');
state.soccer = { leagueList, games: [] };
render();
ok(box.innerHTML === '', 'and none with no games');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
