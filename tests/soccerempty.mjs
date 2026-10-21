// The soccer board's empty state names the right thing (2026-10-21).
//
// With All selected and no fixture to show, the tab said "No fixtures on the
// next matchday for this league" -- a chip filter's message, on no filter. The
// worker sends nextDay only when it holds an upcoming fixture; with nothing
// stored at all it sends none, and that fell through to the league message.
//
// tests/fixtures/soccer-board-empty.json is /api/soccer-board as the worker
// answers it with nothing stored (read through tests/outageserver.mjs).
// soccerEmptyHtml is lifted out of app.js, so the test runs what ships.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
const src = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const empty = JSON.parse(fs.readFileSync(BOARD + '/tests/fixtures/soccer-board-empty.json', 'utf8'));

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

const at = src.indexOf('function soccerEmptyHtml(');
if (at < 0) { console.log('  FAIL  app.js has a soccerEmptyHtml'); process.exit(1); }
let depth = 0, end = -1;
for (let i = src.indexOf('{', at); i < src.length; i++) {
  if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
}
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const soccerKick = (iso) => new Date(iso).toISOString().slice(11, 16);
const html = new Function('esc', 'soccerKick', src.slice(at, end) + '\nreturn soccerEmptyHtml;')(esc, soccerKick);
const text = (h) => h.replace(/<[^>]*>/g, '');

ok(empty.games.length === 0 && !empty.nextDay, 'the recorded board is empty, with no day to name');
ok(text(html(empty, 'all')) === 'No fixtures in the next day and a half.', `All, nothing stored: "${text(html(empty, 'all'))}"`);
ok(!/this league/.test(html(empty, 'all')), 'and it does not speak of a league nobody picked');
const read = { ...empty, asOf: '2026-10-21T19:53:00Z' };
ok(text(html(read, 'all')) === 'No fixtures in the next day and a half — lines last read 19:53.', 'with the time the lines were last read, when there is one');
// The two that were right stay as they were.
const ahead = { ...empty, nextDay: '2026-10-24', gamesAllUpcoming: 12 };
ok(/^No fixtures in the next day and a half\. Next matchday is .+ — 12 fixtures are already priced\.$/.test(text(html(ahead, 'all'))) && /<b>[^<]*24[^<]*<\/b>/.test(html(ahead, 'all')),
  `a later matchday is named: "${text(html(ahead, 'all'))}"`);
ok(text(html(empty, 'mls')) === 'No fixtures on the next matchday for this league.' && /for this league/.test(html(ahead, 'epl')),
  'a league chip with nothing on it still says so, with or without a day ahead');
ok(/if \(!games\.length\) \{ el\.soccerGrid\.innerHTML = props \+ soccerEmptyHtml\(d, state\.soccerLeague\); return; \}/.test(src),
  'and the board draws it');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
