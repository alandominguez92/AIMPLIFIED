// A leg's star sits in its card's top-right corner (2026-10-12).
//
// Today's card, Picks of the day, the NBA PrizePicks card and the soccer card
// each put a 40px bordered star box beside every leg, in a flex row with an
// 8px gap: 48px of a 375px screen, and the leg's lines wrapped to three.
// The star now sits in the corner, its hit area still 44px (the floor set
// when a near-miss on a small star opened the row instead of tracking the
// pick), and the first line leaves room for it. Measured at 375px: each leg
// 263 -> 311px wide, the star 44x44 flush in the corner, the leg's number
// clear of it.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
const css = fs.readFileSync(BOARD + '/style.css', 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim().split('\n').pop().trim(), body: m[2] }));
const of = (sel) => rules.filter((r) => r.sel === sel).map((r) => r.body).join(';');
const px = (body, prop) => Number(((body.match(new RegExp('(?:^|;)\\s*' + prop + ':\\s*(\\d+)px')) || [])[1]) || 0);

const star = of('.tc-add');
ok(/position:\s*absolute/.test(star) && /top:\s*0/.test(star) && /right:\s*0/.test(star), 'the star is placed in the corner, not in a column beside the leg');
ok(px(star, 'width') >= 44 && px(star, 'height') >= 44, `and keeps a 44px hit area (${px(star, 'width')}x${px(star, 'height')})`);
ok(/border:\s*0/.test(star) && !/border:\s*1px/.test(star), 'with no box of its own');

const lis = rules.filter((r) => /\.tc-legs li$/.test(r.sel));
ok(lis.length && lis.every((r) => !/display:\s*flex/.test(r.body)) && lis.some((r) => /position:\s*relative/.test(r.body)),
  `no card lays its legs out as a star column (${lis.map((r) => r.sel).join(', ')})`);
ok(px(of('.tc-legs li .tc-l1'), 'padding-right') >= 30, 'the first line leaves room, so the leg\'s number sits left of the star');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
