// "Check a price" as a search box (2026-11-27): the PrizePicks doc's "player, team or market plus
// your price returns the fair chance, the value and the quarter-Kelly stake", on the owner's
// go-ahead, in place of a list of every side priced. What has to hold:
//   - a word or several find the sides whose sport, label and game hold every one of them,
//     upper or lower case, up to six shown and the rest counted
//   - a lone match is taken at once; a side the words no longer find is let go
//   - nothing found says so; nothing typed shows no list, and the line under it asks for a side
//   - a side taken reads its price as the checker always has (tests/betlinks.mjs)
//   - no <select> of every side left on the page
//
// Real data: production's /api/picks at 1:49 PM Pacific on Friday Nov 27, its priced sides and stake
// rules (tests/fixtures/picks-priced-20261127.json): 132 sides, NBA 67, NHL 34, soccer 31.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
const F = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'picks-priced-20261127.json'), 'utf8'));
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const css = fs.readFileSync(BOARD + '/style.css', 'utf8').replace(/\r\n/g, '\n');
const RealDate = Date;
const NOW = RealDate.parse(F.asOf);
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
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
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const state = { bank: { amount: null, cap: 5 } };
let P;
try {
  P = new Function('esc', 'state', 'soccerKick', ['AM', 'PICK_SPORT', 'moneyTxt', 'stakeTxt', 'chkNorm', 'priceCheckSides', 'priceCheckFind', 'priceCheckHitsHtml', 'priceCheckHtml', 'priceCheckText'].map(lift).join('\n')
    + '\nreturn { priceCheckFind, priceCheckHitsHtml, priceCheckHtml, priceCheckText };')(esc, state, () => 'Fri 4:00 PM');
} catch (e) { console.log(`  FAIL  the checker lifts out of app.js (${e.message})`); console.log('\n1 FAILED'); process.exit(1); }
const d = { priced: F.priced, kelly: F.kelly };
const labels = (q) => P.priceCheckFind(d, q).map((x) => x.label);
const hitsOf = (c) => [...P.priceCheckHitsHtml(d, c).matchAll(/data-key="([^"]*)" aria-pressed="(true|false)"/g)].map((m) => ({ key: m[1], on: m[2] === 'true' }));

console.log('-- finding a side --');
ok(P.priceCheckFind(d, 'brunson').length === 1 && labels('brunson')[0] === 'Jalen Brunson Under 6.5 AST', 'a player: "brunson" finds his one side');
ok(labels('REAVES 3pm').join() === 'Austin Reaves Under 1.5 3PM', 'two words, any case: "REAVES 3pm" finds Reaves\' threes and not his assists');
ok(labels('knicks ml').join() === 'Heat ML,Knicks ML', 'a team and a market: both sides of Heat @ Knicks');
const draws = labels('draw');
ok(draws.length > 1 && labels('draw vancouver').join() === 'Draw', `"draw" finds every draw priced (${draws.length}); "draw vancouver" the one`);
ok(labels('blackhawks').every((l, i, a) => a.length === 2) && labels('nhl blackhawks').length === 2, 'the sport counts as a word too: "nhl blackhawks"');
const knicks = P.priceCheckFind(d, 'knicks');
const many = P.priceCheckHitsHtml(d, { q: 'knicks' });
console.log(`  "knicks": ${knicks.length} sides`);
ok(knicks.length > 6 && hitsOf({ q: 'knicks' }).length === 6 && text(many).endsWith(`and ${knicks.length - 6} more: add a word`), 'six shown, the rest counted');
ok(text(P.priceCheckHitsHtml(d, { q: 'zzz' })) === 'Nothing priced here matches “zzz”.' && P.priceCheckHitsHtml(d, { q: '  ' }) === '', 'nothing found says so; nothing typed, no list');

console.log('\n-- taking one --');
const ml = P.priceCheckFind(d, 'knicks ml').find((x) => x.label === 'Knicks ML');
const two = hitsOf({ q: 'knicks ml', key: ml.key });
ok(two.length === 2 && two.find((x) => x.key === ml.key).on && two.filter((x) => x.on).length === 1, 'the side taken is marked, the other not');
console.log('  ' + text(P.priceCheckText(d, { key: ml.key, price: '' })));
ok(text(P.priceCheckText(d, { key: ml.key, price: '' })) === `Knicks ML: fair ${ml.fair}%, which breaks even at -157 . Type a price to check it.`, "the Knicks at 61.1% fair: -157 breaks even");
// By hand: 0.611 x 1.769 - 1 = +8.1%; a quarter of 0.081 / 0.769 = 2.6% of the bankroll.
const at130 = text(P.priceCheckText(d, { key: ml.key, price: '-130' }));
console.log('  ' + at130);
ok(/^At -130 : EV \+8\.1% on a 61\.1% fair · ¼ Kelly 2\.6% \. Breaks even at -157\.$/.test(at130), 'and at -130, the EV and the quarter-Kelly stake: +8.1%, 2.6%');
ok(P.priceCheckText(d, { q: 'knicks ml' }) === 'Find a side above, then type its price.' && P.priceCheckText(d, {}) === 'Find a side above, then type its price.',
  'none taken: the line asks for one, where it used to price the first side in the list');

console.log('\n-- the box --');
state.chk = { q: 'brunson', key: P.priceCheckFind(d, 'brunson')[0].key, price: '+120' };
const box = P.priceCheckHtml(d);
console.log('  ' + text(box).slice(0, 260));
ok(/<input type="search" data-action="chk-q" value="brunson" placeholder="Player, team or market"/.test(box) && !/<select/.test(box) && !/<option/.test(box),
  'a search field where the 132-row list was, keeping what was typed');
ok(/any of the 132 sides priced here/.test(text(box)) && /Jalen Brunson Under 6\.5 AST/.test(text(box)) && /At \+120 /.test(text(box)), 'it says how many sides it searches, shows the match, and prices it');

console.log('\n-- the page --');
const inputSrc = (/\/\/ The price checker's price, read as it is typed[\s\S]*?\n {2}\}\);/.exec(app) || [''])[0];
ok(/hits\.length === 1 \? hits\[0\]\.key : hits\.some\(\(x\) => x\.key === was\) \? was : null/.test(inputSrc) && /\.pk-check-hits'/.test(inputSrc),
  'typing redraws the matches and the line only: a lone match taken, a side no longer found let go');
const pick = (/case 'chk-pick': \{[\s\S]*?break;\n\s+\}/.exec(app) || [''])[0];
ok(/key: target\.dataset\.key/.test(pick) && /\[data-action="chk-price"\]/.test(pick) && /\.focus\(\)/.test(pick), 'a tap takes the side and moves to the price');
ok(!/data-action="chk-side"/.test(app) && !/'chk-side'/.test(app), 'the list and its handler are gone');
ok(/\.pk-check-f input\[type="search"\] \{ flex:1 1 200px; width:auto; min-width:0; \}/.test(css) && /\.pk-check-hit\.on \{[^}]*var\(--accent\)/.test(css), 'the field takes the row; the side taken is outlined');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
