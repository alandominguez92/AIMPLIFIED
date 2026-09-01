// Guards the mobile fix for `.interval-cell`.
//
// The original bug: one unscoped `display:none` inside the <=900px block deleted
// the cell on every board. On the batter board that cell is secondary, but on the
// other five it IS the board's model number — Win Prob, the 80% interval, Cover %,
// the projection median. Nothing errors when it vanishes; the number is just gone,
// and only on a phone, so it survived a long time.
//
// Static check, deliberately: it fails at read time rather than needing a browser
// and a slate of games, so it still runs when the odds feed is dead.
import fs from 'node:fs';
import path from 'node:path';

const BOARD = path.join(import.meta.dirname, '..');
// Comments are stripped first: they sit between the previous `}` and the
// selector, so an uncommented selector regex matches the comment text instead and
// the check passes on a file that has the bug. That happened here.
const css = fs.readFileSync(BOARD + '/style.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8');

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// Every rule that hides .interval-cell, with its selector.
const hides = [];
const re = /([^{}]*\.interval-cell[^{}]*)\{([^}]*)\}/g;
let m;
while ((m = re.exec(css))) {
  if (/display\s*:\s*none/.test(m[2])) hides.push(m[1].trim().replace(/\s+/g, ' '));
}

console.log('rules hiding .interval-cell:', hides.length);
hides.forEach((h) => console.log('   ' + h));

console.log('\n-- the hide must name the board it was written for --');
ok(hides.length > 0, 'the batter-board hide still exists (it is intentional there)');
ok(hides.every((h) => h.includes('.view-batter')),
  'every hide is scoped to .view-batter — an unscoped one deletes five other boards\' model numbers');
ok(!hides.some((h) => /^\s*\.board-row\s*>\s*\.interval-cell/.test(h)),
  'no bare `.board-row > .interval-cell` hide (the original bug, exactly)');

// Which boards put their model number in this cell? Any interval-cell rendered
// with var(--model) is a model number by the codebase's own colour convention.
const modelCells = (app.match(/class="interval-cell"[^`]*?var\(--model\)/g) || []).length;
console.log('\n-- how many boards rely on this cell --');
console.log('   interval-cell renders coloured var(--model):', modelCells);
ok(modelCells >= 4, `at least four boards use it as their model number (found ${modelCells}) — so the hide must stay scoped`);

console.log('\n-- context boards must have somewhere to put it --');
ok(/\.board:not\(\.view-batter\)\s*\.board-row\s*\{[^}]*grid-template-areas[^}]*interval/.test(css.replace(/\s+/g, ' ')),
  'non-batter boards declare an `interval` grid area (an unplaced cell auto-flows and breaks the card)');
ok(/\.board:not\(\.view-batter\)[^{]*\.interval-cell\s*\{[^}]*grid-area\s*:\s*interval/.test(css.replace(/\s+/g, ' ')),
  'the cell is assigned to that area');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
