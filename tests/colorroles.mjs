// One meaning per colour (2026-10-12).
//
// Green marked four things on the MLB board: the best book price, a positive
// edge, a good record, and "Under plays 0". Gold marked the market label on
// every row, pass included. Now:
//   - green means a result that clears break-even, or an edge that does
//   - the best price is --text with its check mark; the check is not green
//   - the plays count is gold when there are plays, neutral at 0 -- never green
//   - a Today's-card leg's number takes its level's colour: a 55% leg whose
//     level has landed 48% is not green
//   - the pick is gold on a play row only
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
const css = fs.readFileSync(BOARD + '/style.css', 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const bodies = (sel) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter((m) => m[1].split(',').map((s) => s.trim()).includes(sel)).map((m) => m[2]);
const colorOf = (sel) => bodies(sel).map((b) => (b.match(/(?:^|;)\s*color:\s*([^;]+)/) || [])[1]).filter(Boolean).map((s) => s.trim());

console.log('-- the best price --');
ok(colorOf('.odds-books .bk.best .bk-price').length && colorOf('.odds-books .bk.best .bk-price').every((c) => c === 'var(--text)'),
  `best price in --text (${colorOf('.odds-books .bk.best .bk-price').join(', ')})`);
ok(!colorOf('.odds-books .bk-chk').includes('var(--positive)') && !colorOf('.pin-note .pin-chk').includes('var(--positive)'),
  'and its check mark, on the row and in the "best of the two" note, is not green');
ok(bodies('.odds-books .bk.best .bk-chk').some((b) => /visibility:\s*visible/.test(b)), 'the check mark still shows');

console.log('\n-- the plays count --');
const plays = (app.match(/<span class="k">Under plays<\/span><b style="[^"]*"/) || [''])[0];
ok(plays && !plays.includes('--positive') && /plays\.length \? '--accent' : '--text'/.test(plays), `gold with plays, neutral at 0, never green (${plays.slice(-60)})`);

console.log('\n-- a Today\'s-card leg\'s number --');
const at = app.indexOf('function todayBandClass(');
const fn = at >= 0 ? new Function(app.slice(at, app.indexOf('\n  }\n', at) + 4) + '\nreturn todayBandClass;')() : () => null;
ok(fn({ n: 365, hit: 175, hitRate: 47.9 }) === ' tc-band-weak', 'a level landing 48% marks its legs amber');
ok(fn({ n: 8, hit: 7, hitRate: 87.5 }) === ' tc-band-good', 'one landing 88% marks them green');
ok(fn({ n: 3, hit: 3, hitRate: 100 }) === '' && fn(null) === '', 'and under five legs, or with no level, no colour');
ok(/<span class="tc-p\$\{bandCls \|\| ' tc-band-none'\}">/.test(app), 'the leg\'s number carries that class');
ok(colorOf('.tc-p.tc-band-none').includes('var(--text)') && colorOf('.tc-p.tc-band-good').includes('var(--positive)'),
  'neutral without a level, green only from break-even');

console.log('\n-- a pass\'s edge --');
// 2026-10-13: a pass can sit above the sharp fair line and still not clear the
// price; "+4.1%" in green beside "Pass" read as a play. Green on a play only;
// a negative edge stays red. The "Sharp" caption under it follows.
ok(/edgeVal > 0 \? \(isPlayTier\(tierVal\) \? 'var\(--positive\)' : 'var\(--textDim\)'\) : 'var\(--danger\)'/.test(app),
  'a positive edge is green on a play, neutral on a pass, and a negative one red');
ok(app.indexOf('const tierVal = activeTier(g);') >= 0 && app.indexOf('const tierVal = activeTier(g);') < app.indexOf("edgeVal > 0 ? (isPlayTier(tierVal)"),
  'the row\'s tier is known before its edge is coloured');
ok(colorOf('.board-row:not(.is-play) .fsrc.sharp').includes('var(--textDim)'), 'and the "Sharp" caption under a pass\'s edge is not green');

console.log('\n-- gold is the bet --');
ok(colorOf('.fade-pick').length && !colorOf('.fade-pick').includes('var(--accent)'), `a row's pick is not gold by default (${colorOf('.fade-pick').join(', ')})`);
ok(colorOf('.board-row.is-play .fade-pick').includes('var(--accent)') && /rowClasses\.push\('is-play'\)/.test(app),
  'a play row\'s pick is');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
