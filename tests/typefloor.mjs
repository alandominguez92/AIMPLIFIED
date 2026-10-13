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

// Labels are sentence-case Archivo; mono is for numbers. 79% of the page's
// text was mono, most of it uppercase letter-spaced labels. A rule that sets
// mono and uppercases its text is one of those labels coming back.
console.log('\n-- labels are Archivo, not uppercase mono --');
const rules = (s) => [...strip(s).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim().split('\n').pop().trim(), body: m[2] }));
for (const f of ['style.css', 'app.js']) {
  const bad = rules(fs.readFileSync(BOARD + '/' + f, 'utf8'))
    .filter((r) => /font-family:\s*var\(--mono\)/.test(r.body) && /text-transform:\s*uppercase/.test(r.body));
  ok(!bad.length, bad.length ? `${f}: ${bad.length} uppercase mono rules (first: ${bad[0].sel})` : `${f}: no uppercase mono label`);
}
// The sport tabs' sub-labels ("Most Likely", "Model + Picks") are labels too.
// At the 11px floor in letter-spaced mono the six tabs ran 52px past a 1280px
// screen.
const mini = rules(fs.readFileSync(BOARD + '/style.css', 'utf8')).filter((x) => x.sel === '.stab .mini' && /font-family/.test(x.body));
ok(mini.length && mini.every((x) => /font-family:\s*var\(--sans\)/.test(x.body)), 'the sport tabs\' sub-labels are Archivo');
// These four set no face of their own and inherit mono from their row.
for (const sel of ['.slate-summary .k', '.fsrc', '.pin-k', '.price-read .pr-k']) {
  const r = rules(fs.readFileSync(BOARD + '/style.css', 'utf8')).filter((x) => x.sel === sel);
  ok(r.length && r.every((x) => !/text-transform:\s*uppercase/.test(x.body)) && r.some((x) => /font-family:\s*var\(--sans\)/.test(x.body)),
    `${sel} is set in Archivo, sentence case`);
}

console.log('\n-- contrast --');
const tag = (css.match(/\.cell-src\s*\{([^}]*)\}/) || [])[1] || '';
ok(tag && !/--textGhost/.test(tag) && /--textDim/.test(tag), 'the sharp/model tag is in --textDim, not --textGhost');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
