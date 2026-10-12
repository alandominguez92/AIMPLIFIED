// One style for section titles (2026-10-12).
//
// Section titles came in three styles: "Today's card" in Barlow Condensed
// mixed case (.tc-title), TONIGHT'S BOARD / TRACK RECORD / MY SLIP / PICKS OF
// THE DAY in Archivo 800 uppercase (.sec-head h2), and mono subtitles beside
// them. A card title is now set like a section title, subtitles are Archivo,
// and Today's card's record wraps under its title rather than squeezing it
// onto two lines (it was a nowrap item in a flex row: 375px, and the 1100px
// rail).
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
const css = fs.readFileSync(BOARD + '/style.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
// The first top-level rule for a selector, as {prop: value}.
const rule = (sel) => {
  const m = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((x) => x[1].trim().split('\n').pop().trim() === sel);
  const o = {};
  if (m) for (const d of m[2].split(';')) { const i = d.indexOf(':'); if (i > 0) o[d.slice(0, i).trim()] = d.slice(i + 1).trim(); }
  return o;
};

const h2 = rule('.sec-head h2'), card = rule('.tc-title');
for (const p of ['font-family', 'font-weight', 'text-transform', 'letter-spacing']) {
  ok(h2[p] && card[p] === h2[p], `a card title's ${p} is a section title's (${card[p]} / ${h2[p]})`);
}
ok(!/--display/.test(card['font-family'] || ''), 'and no longer the condensed display face');

const head = rule('.tc-head'), rec = rule('.tc-rec');
ok(head['flex-wrap'] === 'wrap', 'the card head wraps');
ok(rec['white-space'] !== 'nowrap', 'so its record goes under the title instead of squeezing it');

for (const sel of ['.sec-head .count', '.tc-rec']) {
  ok(rule(sel)['font-family'] === 'var(--sans)', `${sel} subtitle is Archivo, not mono`);
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
