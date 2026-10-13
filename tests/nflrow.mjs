// The NFL board on a phone (2026-10-12).
//
// Each row showed two unlabeled numbers, the projection ("79.6 yds") and the
// median in blue ("71.5"); on the desktop board their column heads say which
// is which, and the stacked phone card dropped the heads. They now label
// themselves on one line: "proj 79.6 yds · median 71.5".
//
// And the "Sort" label was a loose sibling of the sort buttons, so when the
// buttons wrapped it was left at the end of the filter row. It is grouped
// with them now and wraps with them.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8');
const html = fs.readFileSync(BOARD + '/index.html', 'utf8');
const css = fs.readFileSync(BOARD + '/style.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

console.log('-- the two numbers --');
ok(/<span class="np-proj"><i class="np-k">proj<\/i>\$\{r\.proj\}<i>yds<\/i><\/span>/.test(app), 'the projection carries a "proj" label');
ok(/<span class="interval-cell" style="color:var\(--model\)"><i class="np-k">median<\/i>\$\{r\.p50\}<\/span>/.test(app), 'the median carries a "median" label');
ok(/(^|\})\s*\.np-k\s*\{\s*display:none;/.test(css), 'hidden where the column heads already say it');
const block = (css.match(/@media \(max-width:900px\)\s*\{\s*\.board\.view-nflprops \.board-row \{([\s\S]*?)\n\}/) || [])[1] || '';
const areas = [...((block.match(/grid-template-areas:\s*((?:"[^"]*"\s*)+)/) || [])[1] || '').matchAll(/"([^"]*)"/g)].map((m) => m[1].trim().split(/\s+/));
ok(areas.some((l) => l.includes('proj') && l.includes('median')), `and on a phone the two share a line (${areas.map((l) => l.join(' ')).join(' / ')})`);
ok(/\.board\.view-nflprops \.np-k \{ display:inline;/.test(block) && /\.interval-cell \.np-k::before \{ content:'· '; \}/.test(block),
  'shown there, "proj 79.6 yds · median 71.5"');

console.log('\n-- the Sort label --');
ok(!/<span class="sort-label">Sort<\/span>\s*<span class="sort-chips" id="nflSorts">/.test(html), 'not a loose sibling of the buttons');
ok(/<span class="sort-group nfl-sort-group"><span class="sort-lead">Sort<\/span><span class="sort-chips" id="nflSorts"><\/span><\/span>/.test(html),
  'grouped with them, so it wraps with them');
// The buttons wrap inside the group: unwrapped, at 320px they ran 27px off the
// screen and the page scrolled sideways.
ok(/\.nfl-sort-group \.sort-chips \{[^}]*flex-wrap:wrap;[^}]*min-width:0;/.test(css) && /\.nfl-sort-group \{[^}]*max-width:100%;/.test(css),
  'and its buttons wrap inside it rather than past the screen');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
