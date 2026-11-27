// Two folds on Picks (2026-11-16, the owner: "for the picks of the day where the prize picks are
// and money line entry are let's make it so we can minimize it and enlarge it", and "if we click on
// a player we can get the detailed version of it rather than having to go all the way back up").
//
//   1. In Simple, a tap on a leg -- props and moneylines alike -- opens that one card in full where
//      it is, the tiles and everything under them as Detailed draws it; a second tap folds it. The
//      name is a button for keyboards and screen readers; the star still only stars.
//   2. "Picks of the day" minimizes to a line an entry (its name, count, dots and its largest
//      entry's units) and enlarges again, kept between visits.
//
// Read on the Picks payload recorded on Nov 16 at 09:10 UTC: Jabari Smith Jr's blocks More, the
// Nuggets at -420; last night (Nov 15) the PrizePicks entry 4 of 6, the moneyline entry 5 of 6.
//
//   node tests/foldcards.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const src = read('app.js'), css = read('style.css');
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

const rp = lift('renderPicks');
const lrAt = rp.indexOf('const legRow = (x, compact, foot, best) =>');
const legRowSrc = lrAt < 0 ? null : closeFrom(rp, lrAt, true);
const names = ['TEAM_COLORS', 'MLB_TEAM_ID', 'NHL_PHOTO_SEASON', 'headshotUrl', 'teamMarkUrl', 'initialsOf', 'avatarHtml', 'LEG_OFFERS', 'offerLeg',
  'PICK_BOARD', 'PICK_SPORT', 'pickLeg', 'pct0', 'AM', 'soccerKick', 'pickIsTeam', 'pickTeamCode', 'pickTeamTag', 'miniBar', 'projLineHtml', 'mlChanceLineHtml', 'mlStakeTitle', 'pickBarHtml', 'RING_C', 'chanceRingSvg', 'pickFace', 'ptDayOf', 'pickMoved',
  'trendTag', 'readAgeTag', 'INJ_ROLE_WORD', 'injRoleText', 'injuryTag', 'goalieNote', 'PROP_MIN_MOVE', 'legMinutes', 'toiText', 'minutesTagHtml', 'trendBarsHtml', 'impPct', 'priceSparkHtml', 'LINK_BOOK', 'STATE_SLOT', 'betLinkHtml', 'legLink', 'stakeTxt', 'moneyTxt', 'pickEdgeHtml',
  'nbCdf', 'r1', 'ppLineOf', 'ppChanceAt', 'pickAtLine', 'ppLineStepHtml', 'pickLineSetTag', 'shortDay', 'recSinceText',
  'PP_BREAK_EVEN', 'dfsLinesHtml', 'BOOK_LABEL', 'bkLabel', 'booksHtml', 'PICK_SAME', 'pickGameKey', 'pickShortName', 'PICK_TOP', 'pickDayWord', 'PICK_OPEN', 'legCardHtml'];
const state = { slip: {} };
let F, R;
try {
  if (!legRowSrc) throw new Error('renderPicks has no legRow(x, compact, foot, best)');
  if (!/const PICK_OPEN = /.test(src)) throw new Error('app.js has no PICK_OPEN');
  F = new Function('state', 'esc', names.filter((n) => src.includes(`function ${n}(`) || src.includes(`const ${n} =`)).map(lift).join('\n')
    + `\n${legRowSrc}\nreturn { legRow, pickLeg, PICK_OPEN };`)(state, esc);
  R = new Function('esc', 'let recapSeenAtLoad = null;\n' + ['ptDayOf', 'shortDay', 'AM', 'BOOK_LABEL', 'bkLabel', 'shortLeg', 'RECAP_ENTRY_MAX', 'recapDay', 'recapHtml']
    .map(lift).join('\n') + '\nreturn { recapHtml };')(esc);
} catch (e) { console.log(`  FAIL  the cards lift out of app.js (${e.message})`); console.log('\n1 FAILED'); process.exit(1); }

const all = [...D.legs, ...D.ppPool, ...D.mlPool];
const leg = (t) => all.find((x) => x.title === t);
const jabari = leg('Jabari Smith Jr Over 0.5 BLK'), nuggets = leg('Nuggets ML');
const tiles = (h) => (h.match(/<div class="lc-tile"/g) || []).length;

console.log('-- 1. Simple: a tap on the player opens his card where it is --');
const jid = F.pickLeg(jabari).id, nid = F.pickLeg(nuggets).id;
const JC = F.legRow(jabari, true);
console.log('        ' + text(JC).slice(0, 120));
ok(JC.startsWith('<li class="lc"><div class="lc-top" data-action="leg-open" data-leg="' + esc(jid) + '">'), 'the top row is the tap, by the leg’s id');
ok(JC.includes(`<button type="button" class="lc-nb" data-action="leg-open" data-leg="${esc(jid)}" aria-expanded="false"><b>Jabari Smith Jr</b> <span class="lc-pick">Over 0.5 BLK</span></button>`),
  'the name is the button, folded: aria-expanded false');
ok(/<span class="lc-chev" aria-hidden="true">more ▾<\/span>/.test(JC) && tiles(JC) === 0 && !/lc-more/.test(JC), 'folded: "more ▾" under the chance, no tiles, nothing under them');
ok(/<button type="button" class="lc-star" data-action="leg-add"/.test(JC), 'the star keeps its own action, so a tap on it stars and does not open');

F.PICK_OPEN.add(jid);
const JO = F.legRow(jabari, true), JD = F.legRow(jabari, false);
ok(JO.startsWith('<li class="lc lc-opened"><div class="lc-top" data-action="leg-open"'), 'opened: marked, and the row still folds it again');
ok(/aria-expanded="true"/.test(JO) && /<span class="lc-chev" aria-hidden="true">less ▴<\/span>/.test(JO), 'aria-expanded true, "less ▴"');
const body = (h) => h.slice(h.indexOf('<div class="lc-tiles">'));
ok(tiles(JO) === tiles(JD) && tiles(JO) >= 2 && body(JO) === body(JD), 'the tiles and all under them exactly as Detailed draws them');
ok(/pp-projbar/.test(JO), 'his projection bar and his last games with them');
const QC = F.legRow(leg('Derik Queen Under 6 REB'), true);
ok(tiles(QC) === 0 && /aria-expanded="false"/.test(QC) && !/lc-opened/.test(QC), 'only that card: the next leg stays folded');

const NC = F.legRow(nuggets, true);
ok(NC.includes(`<button type="button" class="lc-nb" data-action="leg-open" data-leg="${esc(nid)}" aria-expanded="false"><b>Nuggets</b> <span class="lc-pick">to win</span></button>`) && tiles(NC) === 0,
  'a moneyline opens the same way');
F.PICK_OPEN.add(nid);
const NO = F.legRow(nuggets, true);
ok(tiles(NO) === tiles(F.legRow(nuggets, false)) && /pk-books/.test(NO), 'opened: its price tile and every book');
F.PICK_OPEN.delete(jid);
ok(tiles(F.legRow(jabari, true)) === 0 && /aria-expanded="false"/.test(F.legRow(jabari, true)), 'a second tap folds it again');
F.PICK_OPEN.clear();

ok(!/leg-open|lc-nb|lc-chev/.test(F.legRow(jabari, false)), 'Detailed has nothing to open: every card is open');
ok(!/leg-open|lc-nb|lc-chev/.test(F.legRow(jabari, true, '', true)), 'nor the best card, always open');

console.log('\n-- 2. the tap on the page --');
const leCase = (/case 'leg-open': \{[\s\S]*?break;\n\s+\}/.exec(src) || [''])[0];
ok(/if \(PICK_OPEN\.has\(id\)\) PICK_OPEN\.delete\(id\); else PICK_OPEN\.add\(id\);/.test(leCase) && /renderPicks\(\);/.test(leCase), 'it opens or folds that leg and redraws Picks');
ok(/again\.focus\(\{ preventScroll: true \}\)/.test(leCase), 'from the keyboard, the focus stays on the name, the page where it was');
ok(/const PICK_OPEN = new Set\(\);/.test(src), 'which cards are open lives in state, so the five-minute redraws keep them');
ok(/\.lc-nb \{[^}]*font:inherit;[^}]*background:none; border:0;/.test(css) && /\.lc-top\[data-action\] \{ cursor:pointer; \}/.test(css), 'the name looks as it did; the row shows it can be tapped');

console.log('\n-- 3. "Picks of the day": minimize and enlarge --');
const big = R.recapHtml(D.record.history, D.edgeRecord, false), min = R.recapHtml(D.record.history, D.edgeRecord, true);
ok(/^<section class="pk-pod" /.test(big) && big.includes('<button type="button" class="pod-tg" data-action="pod-min" aria-expanded="true">Minimize</button>'), 'in full: a Minimize button');
ok(/^<section class="pk-pod min" /.test(min) && min.includes('<button type="button" class="pod-tg" data-action="pod-min" aria-expanded="false">Enlarge</button>'), 'minimized: marked, and Enlarge');
const sums = [...min.matchAll(/<div class="rc-cw"><b>([^<]+)<\/b><span class="rc-n">([^<]*)<\/span><\/div><div class="pod-sum">([\s\S]*?)<\/div><div class="pod-body">/g)]
  .map((m) => `${m[1]} ${m[2]} ${text(m[3])}`);
console.log('        ' + sums.join(' | '));
ok(sums.length === 2 && /^PrizePicks entry 4 of 6 [✓✗]{6} Top 6 Flex −0\.60u$/.test(sums[0]) && /^Moneyline entry 5 of 6 [✓✗]{6} Top 6 Flex /.test(sums[1]),
  'each entry one line: its name, its count, its dots, its 6-Flex units');
ok((sums[0].match(/✓/g) || []).length === 4 && (sums[1].match(/✓/g) || []).length === 5, 'the dots are its legs: 4 and 5 landed');
ok(/<div class="pod-sum"><span class="rc-dots">[✓✗]+<\/span><span>Top 6 Flex <b class="o">−0\.60u<\/b><\/span><\/div>/.test(min), 'a losing night in the caution colour');
ok((min.match(/<div class="pod-body"><div class="rc-chips">/g) || []).length === 2, 'the chips and units rows sit in the part that folds');
ok(/<ul class="rc-lines pod-lines pod-more">/.test(min) && /<div class="rc-off rc-ebets pod-more">Edge bets: /.test(min), 'the edge bets’ night folds with them');
ok(/<p class="pod-edge">Since Oct 28 the edge bets have beaten the close 59 of 85 · <a href="\/track-record">Full track record<\/a><\/p>/.test(min), 'the edge line and the track record link stay');
ok(min.replace('pk-pod min', 'pk-pod').replace('aria-expanded="false">Enlarge', 'aria-expanded="true">Minimize') === big,
  'the same card either way: only the mark and the button differ, so it folds in place');
const bare = R.recapHtml({ days: [] }, D.edgeRecord, true);
ok(!/pod-tg/.test(bare) && /^<section class="pk-pod" /.test(bare), 'nothing graded yet: nothing to fold, no button');
ok(/\.pk-pod\.min \.pod-body, \.pk-pod\.min \.pod-more \{ display:none; \}/.test(css) && /\.pk-pod:not\(\.min\) \.pod-sum \{ display:none; \}/.test(css), 'the stylesheet folds it');
ok(/\.pod-tg \{ min-height:44px;/.test(css), 'a 44px button for a thumb');

console.log('\n-- 4. kept between visits --');
ok(/state\.podMin = localStorage\.getItem\('aimplified_pod_min'\) === '1';/.test(src), 'read at load');
const pmCase = (/case 'pod-min': \{[\s\S]*?break;\n\s+\}/.exec(src) || [''])[0];
ok(/state\.podMin = !state\.podMin;/.test(pmCase) && /localStorage\.setItem\('aimplified_pod_min', state\.podMin \? '1' : '0'\)/.test(pmCase), 'saved on the tap');
ok(/pod\.classList\.toggle\('min', state\.podMin\)/.test(pmCase) && !/renderPicks/.test(pmCase), 'folded in place, no redraw');
ok((rp.match(/recapHtml\(d\.record && d\.record\.history, d\.edgeRecord, state\.podMin\)/g) || []).length === 2, 'and Picks draws it as it was left, with legs and with none');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
