// "Picks of the day" (2026-11-16, step 6 of the page brief): the card the Picks page opens on.
// Last night's PrizePicks entry and moneyline entry side by side, each leg a hit or a miss, the
// units, the edge bets' night and their run against the close since they were first logged, a
// link to the full track record; today's legs as they finish fold under it. The page's heading
// is the card's now, so index.html no longer carries one.
//
// Read on the Picks payload recorded on Nov 16 at 09:10 UTC (1:10 AM PT): last night is Nov 15,
// its PrizePicks entry 4 of 6, its moneyline entry 5 of 6, the edge bets 1 of 5.
//
//   node tests/podcard.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const src = read('app.js'), css = read('style.css'), html = read('index.html');
const D = JSON.parse(read('tests/fixtures/picks-20261116-0040.json'));
const RealDate = Date;
const NOW = RealDate.parse(D.asOf);
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
function closeFrom(text, at, isConst) {
  let depth = 0, seen = false;
  for (let i = at; i < text.length; i++) {
    const c = text[i];
    if (c === '{' || c === '(' || c === '[') { depth++; seen = true; }
    else if (c === '}' || c === ')' || c === ']') depth--;
    if (seen && depth === 0) {
      if (!isConst && c === '}') return text.slice(at, i + 1);
      if (isConst && (text[i + 1] === ';' || text[i + 1] === '\n')) return text.slice(at, i + 2);
    }
  }
  return null;
}
function lift(name) {
  let at = src.indexOf(`function ${name}(`);
  const isConst = at < 0;
  if (isConst) at = src.indexOf(`const ${name} =`);
  if (at < 0) throw new Error(`app.js has no ${name}`);
  const out = closeFrom(src, at, isConst);
  if (!out) throw new Error(`could not close ${name}`);
  return out;
}
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } };
let F;
try {
  F = new Function('esc', 'let recapSeenAtLoad = null;\n' + ['ptDayOf', 'shortDay', 'AM', 'BOOK_LABEL', 'bkLabel', 'shortLeg', 'RECAP_ENTRY_MAX', 'recapDay', 'recapHtml', 'PICKS_HEAD']
    .map(lift).join('\n') + '\nreturn { recapHtml, PICKS_HEAD };')(esc);
} catch (e) { console.log(`  FAIL  the card lifts out of app.js (${e.message})`); console.log('\n1 FAILED'); process.exit(1); }

const h = F.recapHtml(D.record.history, D.edgeRecord), t = text(h);
console.log('        ' + t.slice(0, 220));

console.log('\n-- 1. the card --');
ok(/^<section class="pk-pod" aria-labelledby="pkPodH"><div class="pod-h"><h2 id="pkPodH">Picks of the day<\/h2><span class="pod-meta">Last night · Nov 15 · logged as shown<\/span><button type="button" class="pod-tg" data-action="pod-min" aria-expanded="true">Minimize<\/button><\/div>/.test(h),
  'PICKS OF THE DAY, "Last night · Nov 15 · logged as shown"');
const cols = (/<div class="pod-cols">([\s\S]*?)<\/div><ul class="rc-lines pod-lines pod-more">/.exec(h) || [])[1] || '';
ok((cols.match(/<div class="rc-ent">/g) || []).length === 2, 'two columns: the PrizePicks entry and the moneyline entry');
ok(/<div class="rc-cw"><b>PrizePicks entry<\/b><span class="rc-n">4 of 6<\/span><\/div>/.test(cols) && /<div class="rc-cw"><b>Moneyline entry<\/b><span class="rc-n">5 of 6<\/span><\/div>/.test(cols),
  'each with its count: 4 of 6 and 5 of 6');
ok((cols.match(/class="rc-chip rc-hit"/g) || []).length === 9 && (cols.match(/class="rc-chip rc-miss"/g) || []).length === 3, 'each leg a chip, hit or missed: 9 and 3');
ok(/Top 2 Power[\s\S]*?\+2\.00u[\s\S]*?Top 3 Flex[\s\S]*?\+1\.25u[\s\S]*?Top 6 Flex[\s\S]*?−0\.60u/.test(cols), 'the units: Top 2 Power +2.00u, Top 3 Flex +1.25u, Top 6 Flex −0.60u');
ok(/Edge bets 1 of 5 · −3\.02u · beat the close 4 of 5/.test(t), 'the edge bets’ night: 1 of 5, −3.02u, beat the close 4 of 5');
ok(/<p class="pod-edge">Since Oct 28 the edge bets have beaten the close 59 of 85 · <a href="\/track-record">Full track record<\/a><\/p>/.test(h),
  'their run against the close since Oct 28, and the full track record');
ok(!/<details class="pk-recap" open><summary><span class="rc-h">Last night/.test(h) && !/rc-h">Last night/.test(h), 'last night is the card, not a fold');
ok(!/Today so far/.test(h), 'at 1:10 AM nothing has finished today: no fold for it');
const hist = structuredClone(D.record.history);
const today = hist.days.find((x) => x.date === '2026-11-16');
(today.pool && today.pool.length ? today.pool : today.ml)[0].result = 'hit';
ok(/<\/p><details class="pk-recap"><summary><span class="rc-h">Today so far<\/span>/.test(F.recapHtml(hist, D.edgeRecord)), 'once a leg finishes, today folds under it, after the record link');
ok(h.endsWith('</section>'), 'all of it one card');

console.log('\n-- 2. before a night is graded --');
const bare = F.recapHtml({ days: [] }, D.edgeRecord);
ok(/<span class="pod-meta">logged as shown<\/span>/.test(bare) && /Last night’s legs show here once they are graded, after midnight PT\./.test(text(bare)), 'says when they will show');
ok(/beaten the close 59 of 85 · <a href="\/track-record">Full track record<\/a>/.test(bare), 'the record link is there regardless');
ok(/^<section class="pk-pod"/.test(F.recapHtml(null, null)) && /<a href="\/track-record">Full track record<\/a>/.test(F.recapHtml(null, null)), 'and with no history at all');

console.log('\n-- 3. on the page --');
const rp = lift('renderPicks');
ok(/grid\.innerHTML = recapHtml\(d\.record && d\.record\.history, d\.edgeRecord, state\.podMin\) \+ mlbUnreadHtml\(d\) \+ legsCols/.test(rp), 'the card first, then today’s legs');
ok(!/<h2>Picks of the day<\/h2>/.test(html) && !/id="picksCount"/.test(html) && /<section id="picksBoard">\n\s+<div id="picksGrid"><\/div>/.test(html), 'index.html carries no heading of its own now');
ok(F.PICKS_HEAD === '<section class="pk-pod"><div class="pod-h"><h2>Picks of the day</h2></div></section>'
  && /const PICKS_SKELETON = PICKS_HEAD\n/.test(src) && /grid\.innerHTML = PICKS_HEAD \+ `<div class="nfl-empty">Picks unavailable/.test(rp), 'the heading while it loads, and over an error');
ok(/\.pod-cols \{ display:grid; grid-template-columns:repeat\(auto-fit, minmax\(min\(100%, 320px\), 1fr\)\);/.test(css), 'side by side where they fit, stacked on a phone');
ok(/\.pod-edge a \{ color:var\(--accent\);/.test(css), 'the link in the accent');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
