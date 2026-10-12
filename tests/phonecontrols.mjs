// Phone controls (2026-10-12).
//
// Six rows of controls and notes sat above the first batter on a phone: the
// market switch, "Prices pinned to...", "191 graded this era...", search +
// Compare, Show, Sort -- 227px between the market switch and the first row at
// 375px. Search and Compare stay; Show and Sort move into a sheet behind one
// "Filter · Sort" row that says what is set; the two notes move into "How
// these are priced". 113px after.
//
// placePhoneControls() is lifted out of app.js and run against a small fake
// DOM whose insertBefore throws like the real one. Its first version found
// the toolbar with querySelector('.board-controls'), which is the NFL board's
// (earlier in the page): at desktop width it threw at load, uncaught.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
const src = fs.readFileSync(BOARD + '/app.js', 'utf8');
const html = fs.readFileSync(BOARD + '/index.html', 'utf8');
const css = fs.readFileSync(BOARD + '/style.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
function lift(name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`app.js has no ${name}`);
  let depth = 0, seen = false;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === '{') { depth++; seen = true; } else if (c === '}') depth--;
    if (seen && depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`could not close ${name}`);
}

// A node tree just big enough: ids, classes, children, and a strict insertBefore.
class N {
  constructor(id, cls) { this.id = id || ''; this.className = cls || ''; this.children = []; this.parentNode = null; this.hidden = false; }
  append(...ns) { for (const n of ns) { if (n.parentNode) n.parentNode.children.splice(n.parentNode.children.indexOf(n), 1); n.parentNode = this; this.children.push(n); } }
  insertBefore(n, ref) {
    if (ref && ref.parentNode !== this) throw new Error("NotFoundError: Failed to execute 'insertBefore'");
    if (n.parentNode) n.parentNode.children.splice(n.parentNode.children.indexOf(n), 1);
    n.parentNode = this; this.children.splice(ref ? this.children.indexOf(ref) : this.children.length, 0, n);
  }
  setAttribute() {}
}
function page() {
  const nflControls = new N('', 'board-controls');      // the NFL board's, first in the page
  const tabrow = new N('', 'tabrow'), how = new N('', 'how-priced');
  const controls = new N('', 'board-controls'), sheetBody = new N('ctlSheetBody'), sheet = new N('ctlSheet');
  const fg = new N('filterGroup'), div = new N('toolbarDiv'), sg = new N('sortGroup'), cmp = new N('compareModeBtn');
  controls.append(fg, div, sg, cmp);
  const pin = new N('pinNote', 'pin-note'), era = new N('eraNote', 'era-note');
  tabrow.append(new N('', 'tabnote'), pin, era);
  sheet.append(sheetBody); sheet.hidden = true;
  const byId = { ctlSheetBody: sheetBody, ctlSheet: sheet, filterGroup: fg, toolbarDiv: div, sortGroup: sg, compareModeBtn: cmp, pinNote: pin, eraNote: era };
  const document = {
    getElementById: (id) => byId[id] || null,
    querySelector: (s) => (s === '.board-controls' ? nflControls : s === '.how-priced' ? how : s === '#slate .tabrow' || s === '.tabrow' ? tabrow : null),
  };
  return { document, el: { pinNote: pin, eraNote: era }, controls, nflControls, sheetBody, how, tabrow, fg, sg, div, cmp, pin, era };
}
const make = (P, phone) => new Function('PHONE_MQ', 'document', 'el', 'let ctlSheetFrom = null;\n' + [lift('placePhoneControls'), lift('closeCtlSheet')].join('\n')
  + '\nreturn placePhoneControls;')({ matches: phone }, P.document, P.el);

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const order = (n) => n.children.map((c) => c.id || c.className).join(' > ');

console.log('-- at desktop width --');
const D = page();
let threw = null;
try { make(D, false)(); } catch (e) { threw = e.message; }
ok(!threw, `nothing throws at load${threw ? ': ' + threw : ''}`);
ok(order(D.controls) === 'filterGroup > toolbarDiv > sortGroup > compareModeBtn' && !D.nflControls.children.length,
  `Show and Sort stay in the MLB toolbar, not the NFL one (${order(D.controls)})`);
ok(D.pin.parentNode === D.tabrow && D.era.parentNode === D.tabrow, 'the notes stay in the tab row');

console.log('\n-- on a phone --');
const P = page();
make(P, true)();
ok(order(P.sheetBody) === 'filterGroup > sortGroup' && order(P.controls) === 'toolbarDiv > compareModeBtn',
  `Show and Sort move into the sheet; Compare stays beside search (${order(P.controls)})`);
ok(P.pin.parentNode === P.how && P.era.parentNode === P.how, 'the two notes move into "How these are priced"');
make(P, false)();
ok(order(P.controls) === 'filterGroup > toolbarDiv > sortGroup > compareModeBtn' && P.pin.parentNode === P.tabrow,
  'and back where they were when the screen widens');

console.log('\n-- the markup --');
ok(/id="ctlSheetBtn" data-action="open-ctl-sheet"/.test(html) && /<span class="ctl-sum" id="ctlSheetSum">/.test(html),
  'one "Filter · Sort" button, with a slot saying what is set');
ok(/id="ctlSheet" hidden/.test(html) && /role="dialog" aria-modal="true"/.test(html) && /class="ctl-sheet-done" data-action="close-ctl-sheet"/.test(html),
  'a sheet, hidden until opened, with a Done button');
ok(/case 'open-ctl-sheet'/.test(src) && /case 'close-ctl-sheet'/.test(src) && /e\.key === 'Escape'\) closeCtlSheet\(\)/.test(src), 'opened and closed by action, and Escape closes it');
ok(/\.ctl-sheet-btn\s*\{\s*display:none;/.test(css) && /@media \(max-width:640px\)\s*\{\s*#slate \.tabrow\s*\{\s*display:none;/.test(css),
  'the button shows on a phone only, and the emptied tab row goes');
// The toolbar rules are the MLB board's. Unscoped, ".board-toolbar >
// .board-controls { flex:none }" also caught the NFL toolbar, whose filter and
// sort chips then could not wrap: 240px of sideways scroll on the NFL board.
const phoneBlock = (css.match(/\.ctl-sheet\[hidden\][\s\S]*?@media \(max-width:640px\)\s*\{([\s\S]*?)\n\}/) || [])[1] || '';
const toolbarSels = [...phoneBlock.matchAll(/^\s*([^{}\n]*(?:board-search|board-controls|tabrow)[^{}\n]*)\{/gm)].map((m) => m[1].trim());
ok(toolbarSels.length >= 3 && toolbarSels.every((s) => s.startsWith('#slate ')),
  `every phone toolbar rule is scoped to the MLB board (${toolbarSels.join(' | ')})`);
ok(/function placePhoneControlsSafe\(\)\s*\{\s*try \{ placePhoneControls\(\); \} catch/.test(src) && !/^\s*placePhoneControls\(\);/m.test(src),
  'and every call goes through a guard, so a layout move can never halt the page');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
