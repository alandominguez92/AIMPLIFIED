// "How the list did": each day's units under the entry they belong to (2026-11-12, the owner's
// "do both").
//
// A day's line reads the list's count, then the day's Power and Flex units. Since Oct 28 those
// units are the PrizePicks entry's, not the list's, and nothing said so: Nov 12 read "6 of 6
// landed" beside "Top 2 Power −1.00u · Top 3 Flex −1.00u" in amber. The moneyline entry, which
// won at every size that day (+2.00u, +1.25u), was nowhere on the card. What has to hold:
//   - the units sit under the entry's name: the PrizePicks entry's, then the moneyline entry's
//   - a day with no moneyline entry (before Nov 1), or none graded yet, has no row for it
//   - a day from before the PrizePicks entry, whose units were the list's, says "The list"
//
// Real data: production's /api/picks at 9:56 PM Pacific on Nov 12 (tests/fixtures/
// picks-20261112.json), drawn by the page's own function.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
const app = fs.readFileSync(path.join(BOARD, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const P = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'picks-20261112.json'), 'utf8'));
const h = P.record.history;

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
const card = new Function('esc', ['shortDay', 'pct0', 'HIST_DAY_KEYS', 'HIST_DAYS_SHOWN', 'movedLineHtml', 'ppEntryRecordHtml', 'pickHistoryHtml'].map(lift).join('\n') + '\nreturn pickHistoryHtml;')(esc);
const txt = (x) => x.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
// Each day's face: what its summary says, by date.
const faces = (html) => [...html.matchAll(/<details class="pk-day"><summary>([^]*?)<\/summary>/g)].map((m) => txt(m[1]));
const face = (all, day) => all.find((f) => f.startsWith(day + ' ')) || '';

const shown = faces(card(h, false));
for (const f of shown) console.log('  ' + f);
console.log();
ok(face(shown, 'Nov 12') === 'Nov 12 6 of 6 landed · 4 off before the start PrizePicks entry Top 2 Power −1.00u Top 3 Flex −1.00u Moneyline entry Top 2 Power +2.00u Top 3 Flex +1.25u',
  "Nov 12: the list's 6 of 6, the PrizePicks entry's units under its name, and the moneyline entry's beside them");
ok(face(shown, 'Nov 11') === 'Nov 11 2 of 3 landed · 5 off before the start PrizePicks entry Top 2 Power −1.00u Top 3 Flex −1.00u Moneyline entry Top 2 Power +2.00u Top 3 Flex +0.25u',
  "Nov 11: the moneyline entry's Top 3 Flex paid 2 of 3, +0.25u");
ok(face(shown, 'Nov 10') === 'Nov 10 6 of 9 landed · 4 off before the start PrizePicks entry Top 2 Power −1.00u Top 3 Flex −1.00u Moneyline entry Top 2 Power +2.00u',
  'Nov 10: two moneylines in that entry, the Heat and the Magic, so only its Power');
ok(face(shown, 'Nov 13') === 'Nov 13 6 still to play', 'tomorrow, nothing graded: no units for either entry');
const html = card(h, false);
const nov12 = html.slice(html.indexOf('<b>Nov 12</b>'), html.indexOf('</summary>', html.indexOf('<b>Nov 12</b>')));
ok(/<span class="pk-dg"><span class="pk-dw">PrizePicks entry<\/span><span class="pk-du"><span class="pk-de pk-down">Top 2 Power −1\.00u<\/span><span class="pk-de pk-down">Top 3 Flex −1\.00u<\/span><\/span><\/span><span class="pk-dg"><span class="pk-dw">Moneyline entry<\/span><span class="pk-du"><span class="pk-de pk-up">Top 2 Power \+2\.00u<\/span><span class="pk-de pk-up">Top 3 Flex \+1\.25u<\/span><\/span><\/span>/.test(nov12),
  'one row an entry, its name then its units, amber down and teal up as before');

const every = faces(card(h, true));
ok(/^Oct 31 .*PrizePicks entry Top 2 Power −1\.00u Top 3 Flex −1\.00u$/.test(face(every, 'Oct 31')) && !/Moneyline entry/.test(face(every, 'Oct 31')),
  `Oct 31, before the moneyline entry: its PrizePicks units alone ("${face(every, 'Oct 31')}")`);
// Before Oct 28 a day's units were the list's own top legs', and it had no pool.
const old = { ...h, days: [{ ...h.days.find((d) => d.date === '2026-10-31'), pool: undefined }] };
ok(/The list Top 2 Power −1\.00u Top 3 Flex −1\.00u$/.test(faces(card(old, false))[0] || ''), `a day before the PrizePicks entry says whose units they were: "${faces(card(old, false))[0]}"`);

console.log('\n-- the page --');
const css = fs.readFileSync(path.join(BOARD, 'style.css'), 'utf8');
ok(/\.pk-des \{ display:grid; grid-template-columns:auto minmax\(0, 1fr\);/.test(css) && /\.pk-dg \{ display:contents; \}/.test(css) && /\.pk-du \{ display:flex; flex-wrap:wrap;/.test(css),
  'name | units in two columns, so a unit that wraps on a phone lines up under the first');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
