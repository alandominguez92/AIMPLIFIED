// The moneyline gap on Picks, and the price chart's key (2026-11-27, the PrizePicks payouts doc's
// fixes; the owner: "Lets keep that measure with Pinnacle's as main").
//
// The doc: "'6.3 short' on Juventus: the card shows an 82% chance against the 85.2% the book
// needs, which is 3.1 short. Salzburg and Lyon do the same. Above 80% the figure seems to use
// about 79%." It did: the gap was measured from kellyP, the chance the stake is sized on (the one
// shown, brought toward how legs like it have landed), not from the one shown. And the chart under
// a leg named its two lines only in a title, which a phone never shows. What has to hold:
//   - the leg card's "Book at ... needs" tile and the bar under a moneyline measure the gap from
//     the chance shown, and the bar's fill is that chance
//   - where the stake's chance sits under it, a title on both names it; where they agree, none
//   - the chart under a leg names its lines: a swatch of each line's colour beside its numbers,
//     and the title stays
//
// Real data: production's /api/picks of Nov 13 at 08:02 UTC (tests/fixtures/picks-20261113.json):
// Scotland at -575, 81.3% shown and 77.8% on its record, with its three reads of price and fair
// (the doc's Juventus was a Nov 26 favourite at the same -575, 82% shown); and of Nov 27 at 10:49
// UTC (tests/fixtures/picks-ml-20261127.json): the Nuggets at -435, 79.3% shown and 76.8% on the
// NBA favourites' record, and the Pistons at -370, where the two are the same.
//
//   node tests/mlgap.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const src = read('app.js'), css = read('style.css');
const D13 = JSON.parse(read('tests/fixtures/picks-20261113.json'));
const D27 = JSON.parse(read('tests/fixtures/picks-ml-20261127.json'));
const RealDate = Date;
let NOW = RealDate.parse(D13.asOf);
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
// The text from `at` to the bracket that closes what it opens (as tests/legcard.mjs lifts the card).
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
const rp = lift('renderPicks');
const lrAt = rp.indexOf('const legRow = (x, compact, foot, best) =>');
const legRowSrc = lrAt < 0 ? null : closeFrom(rp, lrAt, true);
const names = ['TEAM_COLORS', 'MLB_TEAM_ID', 'NHL_PHOTO_SEASON', 'headshotUrl', 'teamMarkUrl', 'initialsOf', 'avatarHtml', 'LEG_OFFERS', 'offerLeg',
  'PICK_BOARD', 'PICK_SPORT', 'pickLeg', 'pct0', 'AM', 'soccerKick', 'pickIsTeam', 'pickTeamCode', 'pickTeamTag', 'miniBar', 'projLineHtml', 'mlChanceLineHtml', 'mlStakeTitle', 'pickBarHtml', 'RING_C', 'chanceRingSvg', 'pickFace', 'ptDayOf', 'pickMoved',
  'trendTag', 'readAgeTag', 'INJ_ROLE_WORD', 'injRoleText', 'injuryTag', 'goalieNote', 'PROP_MIN_MOVE', 'legMinutes', 'toiText', 'minutesTagHtml', 'trendBarsHtml', 'impPct', 'priceSparkHtml', 'LINK_BOOK', 'STATE_SLOT', 'betLinkHtml', 'legLink', 'stakeTxt', 'moneyTxt', 'pickEdgeHtml',
  'nbCdf', 'r1', 'ppLineOf', 'ppChanceAt', 'pickAtLine', 'ppLineStepHtml', 'pickLineSetTag', 'shortDay', 'recSinceText',
  'PP_BREAK_EVEN', 'BOOK_LABEL', 'bkLabel', 'booksHtml', 'PICK_SAME', 'pickGameKey', 'pickShortName', 'PICK_TOP', 'pickDayWord', 'PICK_OPEN', 'legCardHtml'];
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const state = { slip: {} };
let F;
try {
  if (!legRowSrc) throw new Error('renderPicks has no legRow(x, compact, foot, best)');
  F = new Function('state', 'esc', names.filter((n) => src.includes(`function ${n}(`) || src.includes(`const ${n} =`)).map(lift).join('\n')
    + `\n${legRowSrc}\nreturn { legRow, mlChanceLineHtml, priceSparkHtml };`)(state, esc);
} catch (e) { console.log(`  FAIL  the card lifts out of app.js (${e.message})`); console.log('\n1 FAILED'); process.exit(1); }

const tilesOf = (h) => [...h.matchAll(/<div class="lc-tile"(?: title="([^"]*)")?><span class="lc-tk">([^<]*)<\/span><b class="lc-tv([^"]*)">([^<]*)<\/b>(?:<span class="lc-ts">([\s\S]*?)<\/span>)?<\/div>/g)]
  .map((m) => ({ title: m[1] || '', key: m[2], cls: m[3].trim(), value: m[4], sub: text(m[5] || '') }));
const tile = (h, re) => tilesOf(h).find((t) => re.test(t.key)) || {};
const need = (am) => (am < 0 ? -am / (-am + 100) : 100 / (am + 100)) * 100;
const r1 = (v) => Math.round(v * 10) / 10;
const barTitle = (h) => (/<span class="pp-projbar"(?: title="([^"]*)")?>/.exec(h) || [])[1] || '';

console.log('-- Scotland at -575, Nov 13: the doc\'s Juventus --');
const scot = D13.legs.find((x) => x.title === 'Scotland ML');
console.log(`        p ${scot.p}, kellyP ${scot.kellyP}, ${scot.odds} needs ${r1(need(scot.odds))}; old gap ${r1(scot.kellyP - need(scot.odds))}, new ${r1(scot.p - need(scot.odds))}`);
ok(scot && scot.kind === 'soccer_fav' && scot.p === 81.3 && scot.kellyP === 77.8 && scot.odds === -575, 'a soccer favourite over 80%: 81.3% shown, 77.8% on its record, at -575');
const S = F.legRow(scot, false), st = tile(S, /^Book at -575 needs$/);
console.log(`        [${st.key}: ${st.value} / ${st.sub}]`);
ok(st.value === '85.2%' && st.sub === '3.9 short' && st.cls === '', `the tile: -575 needs 85.2%, the 81.3% shown is 3.9 short ("${st.sub}")`);
ok(!/7\.4 short/.test(S), 'not the 7.4 its record-adjusted 77.8% made it');
ok(st.title === 'The stake is sized on 77.8%: the 81.3% shown, brought toward how legs like it have landed', `the tile's title names the stake's chance ("${st.title}")`);
const sb = F.mlChanceLineHtml(scot);
console.log('        ' + text(sb));
ok(text(sb) === 'chance 81.3% · -575 needs 85.2% · 3.9 points short', `the bar under it says the same: "${text(sb)}"`);
ok(/class="uz" style="width:81\.3%"/.test(sb) && /class="tick" style="left:85\.1\d*%"/.test(sb), 'its fill runs to the 81.3% shown, its tick to the 85.2% the price needs');
ok(barTitle(sb) === st.title, 'and its title names the stake\'s chance too');

console.log('\n-- the Nuggets at -435 and the Pistons at -370, Nov 27 --');
NOW = RealDate.parse(D27.asOf);
const nug = D27.legs.find((x) => x.title === 'Nuggets ML'), pis = D27.legs.find((x) => x.title === 'Pistons ML');
ok(nug.p === 79.3 && nug.kellyP === 76.8 && pis.p === 76.3 && pis.kellyP === 76.3, 'the Nuggets: 79.3% shown, 76.8% on the record; the Pistons: 76.3% both');
const N = F.legRow(nug, false), nt = tile(N, /^Book at -435 needs$/);
ok(nt.value === '81.3%' && nt.sub === '2 short' && /76\.8%: the 79\.3% shown/.test(nt.title), `the Nuggets' tile: 81.3% needed, "${nt.sub}" (was 4.5), titled with 76.8%`);
ok(text(F.mlChanceLineHtml(nug)) === 'chance 79.3% · -435 needs 81.3% · 2 points short', `their bar: "${text(F.mlChanceLineHtml(nug))}"`);
const P = F.legRow(pis, false), pt = tile(P, /^Book at -370 needs$/);
ok(pt.value === '78.7%' && pt.sub === '2.4 short' && pt.title === '' && barTitle(F.mlChanceLineHtml(pis)) === '',
  `the Pistons, the two chances one: "${pt.sub}", and no title on the tile or the bar`);

console.log('\n-- the chart\'s key --');
NOW = RealDate.parse(D13.asOf);
const h = F.priceSparkHtml(scot.hist);
console.log('        ' + text(h));
ok(scot.hist.length === 3 && text(h) === 'price opened -550 → -575 now · fair 80% → 81.3%', `Scotland's three reads: "${text(h)}"`);
ok(/<i class="sp-key sp-key-px" aria-hidden="true"><\/i>price /.test(h) && /<i class="sp-key sp-key-fair" aria-hidden="true"><\/i>fair /.test(h),
  'a swatch before each line\'s numbers: the price\'s, the fair\'s');
const rule = (sel) => (css.match(new RegExp(`^${sel.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`, 'm')) || [])[1] || '';
const col = (sel, prop) => (new RegExp(`${prop}:([^;]+);`).exec(rule(sel)) || [])[1];
ok(col('.pk-spark .sp-key-px', 'background') === col('.pk-spark .sp-px', 'stroke') && col('.pk-spark .sp-px', 'stroke') === 'var(--accentFill)'
  && col('.pk-spark .sp-key-fair', 'background') === col('.pk-spark .sp-fair', 'stroke') && col('.pk-spark .sp-fair', 'stroke') === 'var(--positive)',
  'each swatch is its line\'s colour: gold the price, teal the fair');
ok(/the gold line is the chance the price needs, the teal the sharp books' fair chance/.test(h), 'the title stays');
ok(S.includes(h), 'the leg card carries the chart with its key');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
