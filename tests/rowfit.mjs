// A compact batter row never paints its pick over the price (2026-10-12).
//
// On phones the compact row put the pick, the price, the model's chance and
// the edge on one line, with the pick in the flexible column and nowrap. At
// 375px that column is ~97px; "Under 1.5 H+R+RBI", the lead on most rows
// since H+R+RBI became the posted market, is 112px, so it ran 15px into the
// price and "+115" read "115" (14 of 31 compact rows on a HEALTHY slate).
// Nothing errored. The pick now has a line of its own, and may wrap there.
//
// Static, like intervalguard: no browser. Measured in the browser too, at 320,
// 375 and 430px: no pick's text box meets another cell's.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
const css = fs.readFileSync(BOARD + '/style.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// Every rule for a selector inside @media (max-width:640px) blocks.
function phoneRules(selector) {
  const out = [];
  const re = /@media\s*\(max-width:\s*640px\)\s*\{/g;
  let m;
  while ((m = re.exec(css))) {
    let depth = 1, i = re.lastIndex;
    for (; i < css.length && depth; i++) { if (css[i] === '{') depth++; else if (css[i] === '}') depth--; }
    const block = css.slice(re.lastIndex, i - 1);
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const r of block.matchAll(new RegExp('(?:^|[},])\\s*' + esc + '\\s*\\{([^}]*)\\}', 'g'))) out.push(r[1]);
  }
  return out;
}

const row = phoneRules('.board.view-batter .board-row:not(.expanded)').join(';');
const areas = (row.match(/grid-template-areas:\s*((?:"[^"]*"\s*)+)/) || [])[1] || '';
const lines = [...areas.matchAll(/"([^"]*)"/g)].map((x) => x[1].trim().split(/\s+/));
console.log('  compact row areas: ' + lines.map((l) => l.join(' ')).join(' / '));
const pickLines = lines.filter((l) => l.includes('pick'));
ok(pickLines.length === 1 && pickLines[0].every((a) => a === 'pick'),
  'the pick has a line to itself: nothing shares its line to be painted over');
ok(lines.some((l) => l.includes('odds')) && !lines.some((l) => l.includes('odds') && l.includes('pick')),
  'and the price sits on another line');

const pick = phoneRules('.board.view-batter .board-row:not(.expanded) .fade-pick').join(';');
ok(pick && !/white-space:\s*nowrap/.test(pick), 'on its line it may wrap rather than run past the row');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
