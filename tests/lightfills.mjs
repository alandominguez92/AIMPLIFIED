// Light mode fills with the fill gold, never the text gold (2026-10-21).
//
// Light mode has two golds: --accent, darkened so gold TEXT reads on white
// (#8a610a), and --accentFill, the real gold for surfaces (#E8B33A). Dark mode
// uses one gold for both, so a fill written with --accent looks right there and
// wrong only in light mode, which is the one the user mostly uses. Three had
// slipped through: the slip's Save entry button (dark brown under near-black
// type, about 3:1), the NFL tab's selected market chip, and the top card's tint,
// mixed from the text gold into a grey beige.
//
// This holds every rule that FILLS with --accent to a short list of small
// marks that carry no text, and pins the light-mode fixes that came with it.
import fs from 'node:fs';
import path from 'node:path';
const css = fs.readFileSync(path.join(import.meta.dirname, '..', 'style.css'), 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// Dots, a checkbox and a play icon: nothing is written on them.
const TEXTLESS = new Set(['.livecard-dot.live', '.hitter-card .checkbox.selected', '.play', '.calibration-dot', '.np-dot']);
const fills = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
  .filter(([, , body]) => /(?:^|;)\s*background(?:-color)?\s*:\s*var\(--accent\)\s*(?:;|$)/.test(body))
  .map(([, sel]) => sel.trim());
const wrong = fills.filter((sel) => !sel.split(',').every((x) => TEXTLESS.has(x.trim())));
ok(wrong.length === 0, `no surface with text on it is filled with the text gold (${wrong.join(' | ') || 'none'})`);

// The rule whose selector is exactly `sel`, at the start of a line: ".hero-leg"
// must not find ".pk-card .hero-leg".
const rule = (sel) => { const m = css.match(new RegExp('(?:^|\\n)\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}')); return m ? m[1] : ''; };
ok(/background:var\(--accentFill\)/.test(rule('.le-save')), 'the slip\'s Save entry button is the bright gold');
ok(/background:var\(--accentFill\)/.test(rule('.nflm.is-on')), 'and so is the NFL tab\'s selected market chip');
ok(/--hl-tc:var\(--accentFill\)/.test(rule('.hero-leg')), 'the top card\'s tint is mixed from the fill gold, not the text gold');
ok(/color:var\(--accentDim\)/.test(rule('[data-theme="light"] .ctx-banner.nfl-banner .ctx-banner-tag')),
  'the NFL banner tag takes the darker gold on its blue tint in light mode');
ok(/border-color:transparent;\s*background:transparent/.test(rule('[data-theme="light"] .nba-pp.pk-card')),
  'and in light mode the Picks list drops the outer box around its own white cards');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
