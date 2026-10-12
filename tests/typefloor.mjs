// No text on the site is set below 11px (2026-10-12).
//
// At 1100px, 196 of 546 visible text elements (36%) were under 11px: 9 to
// 10.5px, mostly uppercase letter-spaced mono -- column heads, SHOW/SORT,
// source tags, team codes, "4 rows pulled". Sizes now come from tokens
// declared once in :root (--fsXs is the floor), and a literal below it
// anywhere -- the stylesheet, the CSS app.js injects, an inline style, an
// HTML page -- fails here.
//
// Also: the "sharp" / "model" / "needs price" tag under an edge was the only
// contrast failure measured, 2.5:1 in --textGhost. It reads in --textDim.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const files = ['style.css', 'app.js', 'index.html', 'track-record.html', 'methodology.html', 'legal.html', 'nfl-priors.html'];

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

const css = strip(fs.readFileSync(BOARD + '/style.css', 'utf8'));
const base = css.slice(0, css.indexOf('[data-theme="light"]'));
ok(/--fsXs:\s*11px;/.test(base) && /--fsSm:\s*12px;/.test(base), 'the size tokens are declared in the base block: --fsXs 11px, --fsSm 12px');

console.log('\n-- no literal below the floor --');
for (const f of files) {
  const src = strip(fs.readFileSync(BOARD + '/' + f, 'utf8'));
  const small = [...src.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].filter((m) => Number(m[1]) < 11);
  const svg = [...src.matchAll(/font-size="(\d+(?:\.\d+)?)"/g)].filter((m) => Number(m[1]) < 11);
  const all = small.concat(svg);
  ok(!all.length, all.length ? `${f}: ${all.length} below 11px (first: ${all[0][0]})` : `${f}: none`);
}

console.log('\n-- contrast --');
const tag = (css.match(/\.cell-src\s*\{([^}]*)\}/) || [])[1] || '';
ok(tag && !/--textGhost/.test(tag) && /--textDim/.test(tag), 'the sharp/model tag is in --textDim, not --textGhost');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
