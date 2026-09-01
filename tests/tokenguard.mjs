// Guards the two-theme token contract.
//
// The failure this catches: a token declared in the dark block and forgotten in
// the light block. Nothing errors — the dark value simply inherits onto a white
// page, so a "subtle border" becomes a black line and dim text becomes invisible.
// It only shows up if someone flips the theme on the exact surface that used it,
// which is why it needs to be a check rather than a review habit.
//
// Font stacks are deliberately theme-independent: declared once, inherited by
// light. They are listed here so the exemption is explicit rather than implied.
import fs from 'node:fs';
import path from 'node:path';

const BOARD = path.join(import.meta.dirname, '..');
const css = fs.readFileSync(BOARD + '/style.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const li = css.indexOf('[data-theme="light"]');
const dark = css.slice(0, li);
const light = css.slice(li, css.indexOf('}', css.indexOf('{', li)) + 1);

const grab = (s) => {
  const o = {};
  for (const m of s.matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g)) o[m[1]] = m[2].trim();
  return o;
};
const D = grab(dark), L = grab(light);

// Typography is intentionally declared once and inherited by both themes.
const THEME_INDEPENDENT = new Set(['--display', '--sans', '--mono']);

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

console.log(`dark tokens: ${Object.keys(D).length}   light tokens: ${Object.keys(L).length}`);

const missing = Object.keys(D).filter((k) => !THEME_INDEPENDENT.has(k) && !(k in L));
console.log('\n-- every colour token needs both themes --');
ok(missing.length === 0,
  missing.length ? `these are declared dark-only: ${missing.join(', ')}` : 'no dark-only colour tokens');

const orphan = Object.keys(L).filter((k) => !(k in D));
ok(orphan.length === 0,
  orphan.length ? `declared light-only (no dark value): ${orphan.join(', ')}` : 'no light-only tokens');

console.log('\n-- typography is declared once, not per theme --');
for (const t of THEME_INDEPENDENT) {
  ok(t in D && !(t in L), `${t} is in the base block only`);
}

// A light value identical to its dark value is almost always a copy-paste miss.
// Genuine exceptions get listed here so the check stays meaningful.
const SAME_ON_PURPOSE = new Set([]);
console.log('\n-- light values should differ from dark --');
const identical = Object.keys(L).filter((k) => D[k] === L[k] && !SAME_ON_PURPOSE.has(k));
ok(identical.length === 0,
  identical.length ? `same value in both themes: ${identical.join(', ')}` : 'every light token differs from its dark value');

console.log('\n-- font stacks are tokenised, not inlined --');
const inlineMono = (css.match(/font-family:\s*'IBM Plex Mono'/g) || []).length;
const inlineSans = (css.match(/font-family:\s*'Archivo'/g) || []).length;
ok(inlineMono === 0, `no inline mono stacks in a font-family (found ${inlineMono})`);
ok(inlineSans === 0, `no inline Archivo stacks in a font-family (found ${inlineSans})`);

console.log('\n-- no var() points at a token that was never declared --');
const declared = new Set([...css.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)].map((m) => m[1]));
const undef = [...new Set([...css.matchAll(/var\((--[A-Za-z0-9-]+)/g)].map((m) => m[1]))]
  .filter((u) => !declared.has(u));
ok(undef.length === 0, undef.length ? `undeclared: ${undef.join(', ')}` : 'all var() references resolve');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
