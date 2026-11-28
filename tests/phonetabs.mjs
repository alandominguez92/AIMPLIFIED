// All the sport tabs fit across a phone (2026-11-23 phone check; nine since LoL, 2026-11-28).
//
// The phone rules were sized for seven tabs. With UFC (2026-11-20) the row was 397px at 6px a side
// and 13px, so on a 390 screen (most iPhones) Entries ran 19px past the edge, and 22px on a 320.
// The 2026-11-23 rules made the eight 357px at 13px and 4px a side. The ninth tab (LoL) made it
// 414px there, 24px past a 390 screen and 13px past a 320 at the old narrowest rule. Measured in the
// browser with these rules, using the page's own Archivo: the row is 414px at 13px and 4px a side
// (from 420 up), 384px at 12.5px and 3px (390 to 419), 353px at 12px and 2px (361 to 389), 333px at
// 11.5px and 2px in an 8px margin (341 to 360), and 303px at 11px and 1px (up to 340), and nothing
// scrolls sideways at 320, 340, 341, 360, 361, 375, 383, 384, 389, 390, 413, 414, 419, 420, 430 or
// 640, nor at the desktop widths in tests/sitepolish.mjs. A font can't be measured here, so this
// holds the rules that were measured.
import fs from 'node:fs';
import path from 'node:path';

const BOARD = path.join(import.meta.dirname, '..');
let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fail++; };

const css = fs.readFileSync(BOARD + '/style.css', 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
// Each @media block's body, by its max-width.
const blocks = {};
for (const m of css.matchAll(/@media \(max-width:(\d+)px\) \{/g)) {
  let depth = 1, i = m.index + m[0].length;
  for (; i < css.length && depth; i++) { if (css[i] === '{') depth++; else if (css[i] === '}') depth--; }
  blocks[m[1]] = (blocks[m[1]] || '') + css.slice(m.index + m[0].length, i - 1);
}
const stab = (w) => { const r = /(?:^|\n|\})\s*\.stab \{([^}]*)\}/.exec(blocks[w] || ''); return r ? r[1] : ''; };
const pad = (body) => { const r = /padding:\s*\d+px (\d+(?:\.\d+)?)px/.exec(body); return r ? Number(r[1]) : null; };
const size = (body) => { const r = /font-size:\s*(\d+(?:\.\d+)?)px/.exec(body); return r ? Number(r[1]) : null; };

const app = fs.readFileSync(BOARD + '/index.html', 'utf8');
const tabs = [...app.matchAll(/class="stab[^"]*"[^>]*data-sport="([a-z]+)"/g)].map((m) => m[1]);
ok(tabs.length === 9 && ['ufc', 'lol', 'entries'].every((k) => tabs.includes(k)), `the row has nine tabs, UFC, LoL and Entries among them (${tabs.join(', ')}): a tenth needs measuring again`);

const p640 = stab('640');
ok(pad(p640) === 4 && size(p640) === 13 && /letter-spacing:\s*0/.test(p640), 'phones: 4px a side, 13px, no letter-spacing (414px, from 420 up)');
const p419 = stab('419');
ok(pad(p419) === 3 && size(p419) === 12.5, 'up to 419: 3px a side at 12.5px (384px)');
const p389 = stab('389');
ok(pad(p389) === 2 && size(p389) === 12, 'up to 389: 2px a side at 12px (353px)');
ok(!blocks['380'] || !stab('380'), 'the old 380 rule is gone, so 381-389 is not left with no room');
const p360 = stab('360');
ok(pad(p360) === 2 && size(p360) === 11.5 && /\.wrap\.sports-inner \{ padding:0 8px; \}/.test(blocks['360']), 'up to 360: 2px a side at 11.5px, the row 8px in from each edge (333px)');
const p340 = stab('340');
ok(pad(p340) === 1 && size(p340) === 11, 'up to 340: 1px a side at 11px (303px, fits a 320 screen)');
ok(/\.sports-inner \{ width:auto; justify-content:space-between; gap:0; \}/.test(blocks['640']), 'the tabs still spread across the row');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
