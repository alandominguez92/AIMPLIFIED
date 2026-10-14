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
const css = fs.readFileSync(BOARD + '/style.css', 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');

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
// Since 2026-10-13 the Play/Pass chip shares the pick's line: on the name line
// it cost ~60px, and with the star's 44px hit area "B. Williamson" pushed the
// game time onto a line of its own. The pick still never shares with a price.
const pickLines = lines.filter((l) => l.includes('pick'));
ok(pickLines.length === 1 && pickLines[0].every((a) => a === 'pick' || a === 'tier') && pickLines[0][0] === 'pick',
  'the pick\'s line holds the pick and at most its Play/Pass chip');
ok(lines.some((l) => l.includes('odds')) && !lines.some((l) => l.includes('odds') && l.includes('pick')),
  'and the price sits on another line');
const nameLine = lines.find((l) => l.includes('matchup')) || [];
ok(nameLine.length && nameLine.every((a) => a === 'matchup'), `the name line is the name's alone (${nameLine.join(' ')})`);

const pick = phoneRules('.board.view-batter .board-row:not(.expanded) .fade-pick').join(';');
ok(pick && !/white-space:\s*nowrap/.test(pick), 'on its line the pick may wrap rather than run into the chip');

// The name line: star, name, team and time on one line. Tighter gaps, and
// past that the name ends in "…" before the time is pushed down.
const head = phoneRules('.board.view-batter .board-row:not(.expanded) .mc-head').join(';');
const name = phoneRules('.board.view-batter .board-row:not(.expanded) .mc-head > b').join(';');
ok(/flex-wrap:\s*nowrap/.test(head) && /text-overflow:\s*ellipsis/.test(name) && /min-width:\s*0/.test(name),
  'the name line never wraps the time down; a long name ends in "…" first');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
