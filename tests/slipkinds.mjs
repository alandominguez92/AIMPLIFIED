// Four phone-check fixes (2026-10-20).
//
// 1. The slip offered "1-pick Power" and "1-pick Flex" for a single PrizePicks
//    leg. A PrizePicks entry is 2 to 6 picks and Flex starts at 3, so the slip
//    now offers only what exists, and saving refuses an entry that cannot.
// 2. The add-an-entry-by-hand form ran 5px past a 375px phone: its boxes kept
//    their own width inside a two-column grid, and the right column was clipped.
// 3. The Entries empty state said "Star legs on the MLB board" when every board
//    can add to the slip.
// 4. The top card said "Tonight's best leg" for a noon kickoff.
//
// entryKinds and entryKind are lifted out of app.js, so the test runs what
// ships. The layout was measured in the browser at 375px as well: every box
// ends inside the screen.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
const src = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const css = fs.readFileSync(BOARD + '/style.css', 'utf8').replace(/\r\n/g, '\n');

function lift(name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`app.js has no ${name}`);
  let depth = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`could not close ${name}`);
}
const state = { logKind: { pp: null, dk: null } };
const F = new Function('state', ['defaultKind', 'entryKinds', 'entryKind'].map(lift).join('\n')
  + '\nreturn { entryKinds, entryKind };')(state);
const names = (book, n) => F.entryKinds(book, n).map(([k]) => k).join(',');

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

console.log('-- PrizePicks entry types --');
ok(names('pp', 1) === '' && F.entryKind('pp', 1) === null, 'one leg: no PrizePicks entry type, and nothing to save');
ok(names('pp', 2) === 'power', `two legs: Power only, Flex starts at 3 (${names('pp', 2)})`);
ok(names('pp', 3) === 'power,flex' && F.entryKind('pp', 3) === 'flex', 'three: both, Flex by default');
ok(names('pp', 6) === 'power,flex' && names('pp', 7) === '', 'six is the most PrizePicks takes');
state.logKind.pp = 'flex';
ok(F.entryKind('pp', 2) === 'power', 'a Flex chosen on three legs falls back to Power when one is removed');
state.logKind.pp = null;
ok(names('dk', 1) === 'straight,parlay', 'DraftKings is unchanged');
ok(/const kind = entryKind\(book, legs\.length\);\s*if \(!kind\) \{ toast\(/.test(src), 'saving refuses an entry PrizePicks cannot take');
ok(/PrizePicks needs at least 2 picks — star another leg\./.test(src), 'and the slip says why instead of offering a type');

console.log('\n-- the hand-entry form fits a phone --');
ok(/\.mf-leg input, \.mf-leg select \{ width:100%; min-width:0; box-sizing:border-box; \}/.test(css), 'each box fills its cell and no wider');
ok(/@media \(max-width:640px\) \{[\s\S]*?\.mf-leg \{ grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\); \}/.test(css),
  'and the phone grid lets its columns shrink below their content');

console.log('\n-- copy --');
ok(/Star legs on any board, then log the entry from your slip/.test(src) && !/Star legs on the MLB board/.test(src),
  'the Entries empty state names every board, not only MLB');
// And by the leg's own day (2026-10-21): the list looks a day ahead, so the
// first leg is often tomorrow's.
// (Since 2026-10-21 a sport tab's card also names its sport: tests/faces.mjs.)
ok(/const kicker = legDay === ptDayOf\(Date\.now\(\)\) \? `Today's \$\{what\}`\s*: \(legDay === ptDayOf\(Date\.now\(\) \+ 864e5\) \? `Tomorrow's \$\{what\}`/.test(src)
  && /<span class="hl-kicker">\$\{kicker\}<\/span>/.test(src) && !/Tonight's best leg/.test(src),
  'the top card says Today\'s or Tomorrow\'s by the leg\'s own day, and never Tonight\'s');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
