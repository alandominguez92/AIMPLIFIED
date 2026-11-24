// All eight sport tabs fit across a phone (2026-11-23 phone check).
//
// The phone rules were sized for seven tabs. With UFC (2026-11-20) the row was 397px at 6px a side
// and 13px, so on a 390 screen (most iPhones) Entries ran 19px past the edge, and 22px on a 320.
// Measured in the browser with these rules, using the page's own Archivo: the row is 357px at 13px
// and 4px a side (fits from 381 up), 329px at 12.5px and 3px (up to 389), and 291px at 11.5px and
// 2px (up to 340), and nothing scrolls sideways at 320, 340, 360, 361, 375, 381, 390, 430 or 640.
// A font can't be measured here, so this holds the rules that were measured.
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
ok(tabs.length >= 8 && tabs.includes('ufc') && tabs.includes('entries'), `the row has eight tabs or more, UFC and Entries among them (${tabs.join(', ')})`);

const p640 = stab('640');
ok(pad(p640) === 4 && size(p640) === 13 && /letter-spacing:\s*0/.test(p640), 'phones: 4px a side, 13px, no letter-spacing (357px, fits from 381)');
const p389 = stab('389');
ok(pad(p389) === 3 && size(p389) === 12.5, 'up to 389: 3px a side at 12.5px (329px)');
ok(!blocks['380'] || !stab('380'), 'the old 380 rule is gone, so 381-389 is not left with no room');
const p360 = stab('360');
ok(pad(p360) === 3 && size(p360) === 12 && /\.wrap\.sports-inner \{ padding:0 8px; \}/.test(blocks['360']), 'up to 360: 3px a side at 12px, the row 8px in from each edge');
const p340 = stab('340');
ok(pad(p340) === 2 && size(p340) === 11.5, 'up to 340: 2px a side at 11.5px (291px, fits a 320 screen)');
ok(/\.sports-inner \{ width:auto; justify-content:space-between; gap:0; \}/.test(blocks['640']), 'the tabs still spread across the row');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
