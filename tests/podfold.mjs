// Picks of the day folds on a phone after the first look (2026-11-27): the PrizePicks doc's "collapse
// the recap after the first visit, so the legs start on the first screen", on the owner's go-ahead.
// What has to hold:
//   - on a phone, the first time a night's recap shows on this device the card opens in full;
//     every visit after, it opens minimized
//   - Enlarge tapped on that night keeps it open on the visits after, that night only; the next
//     night's first look opens in full again
//   - a redraw in the same visit never folds it under the reader
//   - before the night has graded nothing is marked seen, so its first look is still to come
//   - a wider screen keeps the reader's own Minimize, as before (tests/foldcards.mjs)
//
// Real data: production's /api/picks at 1:10 AM Pacific on Nov 16 (tests/fixtures/picks-20261116-0040.json),
// its history graded through Nov 15 with Nov 16 begun.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
const D = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'picks-20261116-0040.json'), 'utf8'));
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
function lift(name) {
  let at = app.indexOf(`function ${name}(`);
  const isConst = at < 0;
  if (isConst) at = app.indexOf(`const ${name} =`);
  if (at < 0) throw new Error(`app.js has no ${name}`);
  let depth = 0;
  for (let i = at; i < app.length; i++) {
    const c = app[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') { depth--; if (!isConst && c === '}' && depth === 0) return app.slice(at, i + 1); }
    else if (isConst && c === ';' && depth === 0 && app[i + 1] === '\n') return app.slice(at, i + 1);
  }
  throw new Error(`could not lift ${name}`);
}
// A device: its storage, its width, and a visit's state as the page loads it.
const store = new Map();
const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); } };
const win = { innerWidth: 390 };
let P;
try {
  P = new Function('localStorage', 'window', ['ptDayOf', 'podSync'].map(lift).join('\n') + '\nreturn { podSync, ptDayOf };')(localStorage, win);
} catch (e) { console.log(`  FAIL  podSync lifts out of app.js (${e.message})`); console.log('\n1 FAILED'); process.exit(1); }
const visit = () => ({ podMin: localStorage.getItem('aimplified_pod_min') === '1' });   // as the page reads it at load
const h = D.record.history;
const NOW = Date.parse(D.asOf);
const DAY = 864e5;

console.log('-- a phone, Nov 16 at 1:10 AM Pacific: last night is Nov 15 --');
let state = visit();
P.podSync(state, h, NOW);
ok(state.podMin === false && store.get('aimplified_pod_seen') === '2026-11-15', 'the first look at Nov 15 opens in full, and is remembered');
P.podSync(state, h, NOW + 5 * 60e3);
ok(state.podMin === false, 'the five-minute redraw in the same visit leaves it open');
state = visit(); P.podSync(state, h, NOW + 2 * 3600e3);
ok(state.podMin === true, 'the next visit that night opens minimized, the legs on the first screen');
// Enlarge, as the tap saves it, then another visit.
state.podMin = false;
localStorage.setItem('aimplified_pod_pick', `${state.podNight}:open`);
state = visit(); P.podSync(state, h, NOW + 3 * 3600e3);
ok(state.podMin === false, 'Enlarge tapped on Nov 15: open on the visits after');
state = visit(); P.podSync(state, h, NOW + DAY);
ok(state.podMin === false && store.get('aimplified_pod_seen') === '2026-11-16', "the next night's first look (Nov 16) opens in full again");
state = visit(); P.podSync(state, h, NOW + DAY + 3600e3);
ok(state.podMin === true, "and its visits after are minimized: Nov 15's Enlarge was for Nov 15");

console.log('\n-- before the night has graded --');
store.clear();
state = visit(); P.podSync(state, h, NOW + 2 * DAY);   // Nov 17's recap: not in this history
ok(state.podMin === false && !store.has('aimplified_pod_seen') && state.podNight === undefined, 'nothing marked seen: its first look is still to come');

console.log('\n-- a wider screen --');
store.clear(); win.innerWidth = 1280;
localStorage.setItem('aimplified_pod_min', '1');
state = visit(); P.podSync(state, h, NOW);
ok(state.podMin === true && !store.has('aimplified_pod_seen'), "the reader's own Minimize, as before");
localStorage.setItem('aimplified_pod_min', '0');
state = visit(); P.podSync(state, h, NOW + 2 * 3600e3);
ok(state.podMin === false, 'and their Enlarge');
win.innerWidth = 640; store.clear();
state = visit(); P.podSync(state, h, NOW); state = visit(); P.podSync(state, h, NOW + 60e3);
ok(state.podMin === true, "640 wide is a phone, as the page's other folds have it");

console.log('\n-- the page --');
const rp = lift('renderPicks');
ok(/podSync\(state, d\.record && d\.record\.history\);/.test(rp) && rp.indexOf('podSync(') < rp.indexOf('recapHtml('), 'Picks syncs it before it draws the card');
const pmCase = (/case 'pod-min': \{[\s\S]*?break;\n\s+\}/.exec(app) || [''])[0];
ok(/localStorage\.setItem\('aimplified_pod_pick', `\$\{state\.podNight\}:\$\{state\.podMin \? 'min' : 'open'\}`\)/.test(pmCase) && /if \(state\.podNight\)/.test(pmCase),
  'the tap saves the choice for that night on a phone');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
