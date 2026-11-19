// The NBA tab's PrizePicks unders card leads with the sharp books' chance (2026-11-16, the
// owner's "yes build it").
//
// A replay of 783 graded legs (Oct 20 to Nov 15) had the card's number, the model's chance,
// at 61.7% shown and 51.5% landed, every range landing about the same: 70%+ no better than
// under 55%. The sharp books' chance at PrizePicks' line climbed with its ranges instead
// (54-58% landed 57.7%, 64 of 111). The props cards already lead with it. What has to hold:
//   - the big number on each row is the sharp chance, and the card's order follows it; a leg
//     the sharp books haven't priced goes below them, marked, and an out player still goes last
//   - under the big number, what legs in its sharp range have landed (the record's own ranges)
//   - the model's chance stays, small, on the third line with what its range has landed
//   - the head counts the sharp 54%+ legs; the model's 65%+ moves to the record line
//   - a line set on the leg carries the sharp chance to the new number from the sharp books'
//     own lines, as the worker prices PrizePicks' line, rather than dropping it
//   - nothing else reads the moved number: Picks and the blocks Mores are as they were
//
// Real data: production's /api/nba-pp at 12:40 AM Pacific on Nov 16
// (tests/fixtures/nba-pp-20261116.json), with the time from /api/picks a minute later.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The unders card's rows are leg cards since 2026-11-17 (the page brief's step 7): the card's helpers.
const NBA7 = ['TEAM_COLORS', 'MLB_TEAM_ID', 'NHL_PHOTO_SEASON', 'headshotUrl', 'teamMarkUrl', 'initialsOf', 'avatarHtml', 'LEG_OFFERS', 'offerLeg',
  'PICK_BOARD', 'PICK_SPORT', 'pickLeg', 'pct0', 'AM', 'soccerKick', 'pickIsTeam', 'pickTeamCode', 'pickTeamTag', 'miniBar', 'projLineHtml', 'mlChanceLineHtml', 'pickBarHtml', 'RING_C', 'chanceRingSvg', 'pickFace', 'ptDayOf', 'pickMoved',
  'trendTag', 'readAgeTag', 'INJ_ROLE_WORD', 'injRoleText', 'injuryTag', 'goalieNote', 'PROP_MIN_MOVE', 'legMinutes', 'toiText', 'minutesTagHtml', 'trendBarsHtml', 'impPct', 'priceSparkHtml', 'LINK_BOOK', 'STATE_SLOT', 'betLinkHtml', 'legLink', 'stakeTxt', 'moneyTxt', 'pickEdgeHtml',
  'nbCdf', 'r1', 'ppLineOf', 'ppChanceAt', 'pickAtLine', 'ppLineStepHtml', 'pickLineSetTag', 'shortDay', 'recSinceText',
  'PP_BREAK_EVEN', 'dfsLinesHtml', 'BOOK_LABEL', 'bkLabel', 'booksHtml', 'PICK_SAME', 'pickGameKey', 'pickShortName', 'PICK_TOP', 'pickDayWord', 'PICK_OPEN', 'legCardHtml',
  'propData', 'propVals', 'propTrend', 'sameGameMap', 'pickLegView', 'PP_LINE_MARKETS', 'nbaLegAtLine', 'NBA_SHARP_BOOKS', 'sharpAtLine', 'NBA_BANDS', 'NBA_BAND_MIN', 'nbaModelBit', 'sharpBooksText', 'nbaNick',
  'NBA_SHARP_BANDS', 'NBA_PROVEN_N', 'NBA_MORE_MODEL_W', 'nbaRot', 'nbaUnderRecord', 'nbaGameSub', 'nbaUnderCardLeg', 'nbaBlkCardLeg', 'nbaPicksProps', 'nbaUnderLegs', 'nbaBlkLegs', 'nbaBlkMoreHtml'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.join(HERE, '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', f), 'utf8'));
const PP = read('nba-pp-20261116.json'), PK = read('picks-20261116-0040.json');
const NOW = Date.parse(PK.asOf);
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fail++; };

const app = fs.readFileSync(path.join(BOARD, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const worker = fs.readFileSync(path.join(BOARD, 'worker.js'), 'utf8').replace(/\r\n/g, '\n');
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
  throw new Error(`could not close ${name}`);
}
// A name the code on HEAD doesn't have yet is left out, so the checks below fail rather than the lift.
const have = (n) => app.includes(`function ${n}(`) || app.includes(`const ${n} =`);
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/&lt;/g, '<').replace(/&amp;/g, '&').trim();

const ui = { nbaPp: PP, slip: {}, ppLines: {}, legView: 'detailed' };
const CARD = ['TEAM_COLORS', 'MLB_TEAM_ID', 'NHL_PHOTO_SEASON', 'headshotUrl', 'teamMarkUrl', 'initialsOf', 'avatarHtml',
  'miniBar', 'projLineHtml', 'LEG_OFFERS', 'offerLeg', 'ptDayOf', 'soccerKick', 'AM', 'MARKET_SHORT', 'NBA_ROTATION_MIN', 'NBA_MK', 'nbaPpLeg', 'nbaOversLineHtml', 'ppMovedTag',
  'ppCloseLineHtml', 'dfsLinesHtml', 'sharpBooksText', 'sharpTag', 'ppBookLine', 'ppGameLineHtml', 'PP_MORE_MIN', 'injOut', 'outLast', 'ppMoreP', 'ppMoreMk', 'ppMoreLeg', 'ppMoreTop', 'ppMoreListHtml',
  'shortDay', 'recSinceText', 'ppMoreLineHtml', 'nbaBlkMoreHtml', 'nbCdf', 'r1', 'pct0', 'PP_LINE_MARKETS', 'ppLineOf', 'ppChanceAt', 'nbaLegAtLine', 'NBA_SHARP_BOOKS', 'sharpAtLine', 'readAgeTag', 'INJ_ROLE_WORD', 'injRoleText', 'injuryTag', 'nbaCardInjTag', 'ppLineTags', 'ppLineStepHtml',
  'NBA_BANDS', 'NBA_BAND_MIN', 'nbaBandLandedHtml', 'nbaSharpLandedHtml', 'nbaModelBit', 'nbaNick', 'NBA_CODE_NICK', 'NHL_CODE_NICK', 'legOppText', 'nbaRebHeldHtml', 'nbaPpCardHtml'].filter(have);
let C;
try {
  C = new Function('state', 'esc', CARD.concat(NBA7).filter((n, i, a) => a.indexOf(n) === i).map(lift).join('\n')
    + `\nreturn { nbaPpCardHtml, nbaLegAtLine, ${['sharpAtLine', 'nbaSharpLandedHtml', 'nbaModelBit', 'NBA_SHARP_BOOKS'].map((n) => (have(n) ? n : `${n}: null`)).join(', ')} };`)(ui, esc);
} catch (e) { console.log(`  FAIL  the card lifts out of app.js (${e.message})`); process.exit(1); }

// The card's rows, each as its own html: leg cards since 2026-11-17 (the page brief's step 7).
const rowsOf = (h) => { const ol = h.slice(h.indexOf('<ol class="tc-legs pk-pool">'), h.indexOf('</ol>')); return ol.split('<li class="lc').slice(1); };
const nameOf = (li) => (li.match(/<span class="lc-name">(?:<button[^>]*>)?<b>([^<]+)<\/b>/) || [])[1];
const bigOf = (li) => (li.match(/<b class="lc-pct( [^"]*)?"(?: title="([^"]*)")?>(\d+)%<\/b>/) || []).slice(1);
// What legs in its range have landed: the card's "Legs like this" tile.
const landedOf = (li) => text((li.match(/<span class="lc-tk">Legs like this<\/span><b class="lc-tv[^"]*">[^<]*<\/b>/) || [''])[0]);
const modelOf = (li) => text((li.match(/<span class="tc-model"[^>]*>[^<]*<\/span>/) || [''])[0]);
const draw = (d) => { ui.nbaPp = d; const h = C.nbaPpCardHtml(); ui.nbaPp = PP; return h; };

console.log('-- the real legs, Nov 16 --');
const rot = PP.legs.filter((l) => l.min_proj >= 20 && Date.parse(l.commence) > NOW);
const modelTop = rot.slice(0, 4);
ok(modelTop.map((l) => `${l.player} ${l.model_under}`).join(', ') === "Klay Thompson 75.6, Peyton Watson 67.9, Jaylon Tyson 65, De'Anthony Melton 64.5" && modelTop.every((l) => l.sharp_under == null),
  `the model's top four have no sharp price: ${modelTop.map((l) => `${l.player} ${l.model_under}`).join(', ')}`);
const vv = rot.find((l) => l.player === 'Fred VanVleet');
ok(vv.sharp_under === 53.9 && vv.inj.out === true, 'Fred VanVleet Under threes, fourth by the sharp chance at 53.9, listed out (knee)');

console.log('\n-- the card, in the sharp order --');
const card = draw(PP);
const unders = card.split('<h3 class="pk-gh">Blocks: More</h3>')[0];
const rows = rowsOf(unders);
const want = ['Paul George', 'Payton Pritchard', 'Jayson Tatum', 'Aaron Gordon', 'Jabari Smith Jr'];
ok(JSON.stringify(rows.map(nameOf)) === JSON.stringify(want), `top five by the sharp chance, VanVleet out and off: ${rows.map(nameOf).join(', ')}`);
const shown = rows.map((li) => [nameOf(li), ...bigOf(li)]);
const legOf = (n, mk) => rot.find((l) => l.player === n && (mk ? l.market === mk : typeof l.sharp_under === 'number'));
const wantLegs = [['Paul George', 'stl'], ['Payton Pritchard', 'threes'], ['Jayson Tatum', 'threes'], ['Aaron Gordon', 'ast'], ['Jabari Smith Jr', 'reb']].map(([n, mk]) => legOf(n, mk));
ok(wantLegs.map((l) => l.sharp_under).join(',') === '57,54.7,54.2,53.5,53.4' && rows.every((li, i) => text(li).includes(`Under ${wantLegs[i].point} `)),
  `the legs: ${wantLegs.map((l) => `${l.player} ${l.market} ${l.sharp_under}`).join(', ')}`);
ok(shown.every(([, , , p], i) => p != null && Number(p) === Math.round(wantLegs[i].sharp_under)), `the big number is the sharp chance: ${shown.map(([n, , , p]) => `${n} ${p}%`).join(', ')}`);
ok(shown[0][1] === ' tc-band-good' && shown[1][1] === ' tc-band-good' && shown[3][1] === undefined, 'green at 54% and up, the 6-Flex break-even; plain below it');
ok(/FanDuel, Novig, ProphetX: their price at PrizePicks' line, de-vigged/.test(shown[0][2] || ''), `and on hover, whose: "${shown[0][2]}"`);
ok(landedOf(rows[0]) === 'Legs like this 58% · 64 of 111' && landedOf(rows[3]) === 'Legs like this 54% · 375 of 695',
  `beside it, what its sharp range has landed: "${landedOf(rows[0])}", "${landedOf(rows[3])}"`);
const pp = rows[1];
ok(modelOf(pp) === 'model 64% (its 60-65% landed 52%)' && /195 of 374/.test(pp), `the model's chance stays, small: Pritchard "${modelOf(pp)}"`);
ok(/<span class="lc-tk">Sharp books<\/span><b class="lc-tv">55%<\/b><span class="lc-ts"><span class="tc-model"/.test(pp) && !/class="tc-sharp/.test(pp), 'under the sharp books\' number, in their tile');
ok(modelOf(rows[0]) === 'model 49% (its under 55% landed 51%)', `Paul George: the model leaned the other way, "${modelOf(rows[0])}"`);

console.log('\n-- its record lines --');
const headRec = text((unders.match(/<span class="tc-rec"[^>]*>.*?<\/span>/) || [''])[0]);
ok(headRec === 'Sharp 54%+: 75 of 131', `the head: "${headRec}" (54-58 and 58+)`);
ok(/Unders: the model's 65%\+ <b>191 of 330<\/b>/.test(unders) && !/Top 3 a day/.test(unders), "the model's 65%+ moves to the record line");
const sub = text((unders.match(/<div class="tc-sub">.*?<\/div>/) || [''])[0]);
ok(/^The sharp books' chance the under lands at PrizePicks' line/.test(sub) && /a leg they haven't priced yet goes below/.test(sub)
  && /If PrizePicks shows another number on rebounds or assists, set it on the leg\./.test(sub) && !/\d/.test(sub), 'the card says what it leads with, and no number of its own to go stale');

console.log('\n-- a leg the sharp books have not priced --');
const keep = (l) => (l.player === 'Paul George' && l.market === 'stl') || (l.player === 'Jayson Tatum' && l.market === 'threes');
const two = { ...PP, legs: PP.legs.map((l) => (keep(l) ? l : { ...l, sharp_under: null, sharp_src: null })) };
const twoRows = rowsOf(draw(two));
ok(JSON.stringify(twoRows.map(nameOf)) === JSON.stringify(['Paul George', 'Jayson Tatum', 'Klay Thompson', 'Peyton Watson', 'Jaylon Tyson']),
  `two priced: they lead, the rest follow in the model's order (${twoRows.map(nameOf).join(', ')})`);
ok(twoRows.slice(2).every((li) => bigOf(li).length === 0 && /no sharp line yet/.test(li) && !/tc-landed/.test(li) && /class="tc-model"[^>]*>model \d+%/.test(li)),
  "below them: no big number, \"no sharp line yet\", the model's chance on the third line");
ok(twoRows.slice(0, 2).every((li) => !/no sharp line yet/.test(li)), 'the priced ones say nothing of the kind');

console.log('\n-- the books, the worker\'s --');
const wSharp = JSON.parse(worker.match(/const NBA_SHARP = (\[[^\]]*\]);/)[1].replace(/'/g, '"'));
ok(JSON.stringify(C.NBA_SHARP_BOOKS) === JSON.stringify(['fanduel', ...wSharp]) && /const NBA_PROP_SHARP = \['fanduel', \.\.\.NBA_SHARP\];/.test(worker),
  `the page's books are NBA_PROP_SHARP: ${JSON.stringify(C.NBA_SHARP_BOOKS)}`);
const atRead = PP.legs.filter((l) => typeof l.sharp_under === 'number' && l.bookUnders
  && l.sharp_src.split(',').every((b) => { const v = JSON.parse(l.bookUnders)[b]; return v && v[0] === l.point; }));
// The books' chances are kept to a tenth, so the median of two (Oso Ighodaro's 47.5 and 47.4) can
// round a tenth away from the worker's, taken from the unrounded prices.
const off = C.sharpAtLine ? atRead.filter((l) => { const s = C.sharpAtLine(l.bookUnders, l.point, l.disp); return !s || Math.abs(s.under - l.sharp_under) > 0.1 + 1e-9; }) : atRead;
ok(atRead.length === 46 && off.length === 0, `at PrizePicks' own line it gives the worker's number: ${atRead.length - off.length} of ${atRead.length} legs whose sharp books' main line is PrizePicks'${off.length ? ` (off: ${off.slice(0, 3).map((l) => l.player).join(', ')})` : ''}`);
ok(C.sharpAtLine && C.sharpAtLine(null, 2.5, 1.2) === null && C.sharpAtLine('{', 2.5, 1.2) === null && C.sharpAtLine('{"draftkings":[2.5,55]}', 2.5, 1.2) === null
  && C.sharpAtLine('{"novig":[2.5,57.3]}', 2.5, 0) === null, 'nothing to go on, a broken record, only a soft book, or no spread: no number');

console.log('\n-- a line set on the leg --');
const gordon = legOf('Aaron Gordon');
const key = `nbapp:${gordon.game_id}:${gordon.player}:${gordon.market}`;
ui.ppLines = { [key]: { line: 3.5, at: NOW + 1000, commence: gordon.commence } };
const moved = C.nbaLegAtLine(gordon);
const expect = C.sharpAtLine ? C.sharpAtLine(gordon.bookUnders, 3.5, gordon.disp) : null;
ok(moved.point === 3.5 && expect && moved.sharp_under === expect.under && moved.sharp_under > 70 && moved.sharp_src === 'fanduel,novig,prophetx',
  `Gordon's assists set at 3.5 (read at 2.5, 53.5%): the sharp chance is carried there, ${moved.sharp_under}%, not dropped`);
const movedRows = rowsOf(C.nbaPpCardHtml());
const [mTone, mTitle, mBig] = bigOf(movedRows[0]);
ok(nameOf(movedRows[0]) === 'Aaron Gordon' && Number(mBig) === Math.round(moved.sharp_under) && mTone === ' tc-band-good',
  `and leads the card at ${mBig}%`);
ok(/carried from their own lines to the one you set/.test(mTitle || ''), `saying so on hover: "${mTitle}"`);
ui.ppLines = { [key]: { line: 1.5, at: NOW + 1000, commence: gordon.commence } };
const lower = C.nbaLegAtLine(gordon);
ok(lower.sharp_under < 35 && !rowsOf(C.nbaPpCardHtml()).map(nameOf).includes('Aaron Gordon'), `set at 1.5 it falls to ${lower.sharp_under}% and off the five`);
ui.ppLines = {};
const plain = { ...gordon, bookUnders: null };
ui.ppLines = { [key]: { line: 3.5, at: NOW + 1000, commence: gordon.commence } };
ok(C.nbaLegAtLine(plain).sharp_under === null, 'with no books kept on the leg there is nothing to carry, and it goes, as before');
ui.ppLines = {};

console.log('\n-- nothing else reads it --');
ok((app.match(/nbaLegAtLine\(/g) || []).length === 2 && (app.match(/sharpAtLine\(/g) || []).length === 2,
  'the moved leg is the card\'s alone: nbaLegAtLine and sharpAtLine are called nowhere else, so Picks is as it was');
// The unders and the blocks Mores read one rotation list (nbaRot) since the leg cards (2026-11-17).
ok(/nbaRot\(d, Date\.now\(\)\)\.map\(\(x0, i\) => \(\{ x: nbaLegAtLine\(x0\), i \}\)\)/.test(lift('nbaUnderLegs'))
  && /ppMoreTop\(nbaRot\(d, Date\.now\(\)\), \(x\) => x\.market === 'blk', 3\)/.test(lift('nbaBlkLegs')), 'the blocks Mores read the same rotation list as before, in its order');
ok(/spec: \{ \.\.\.leg\.spec, playerId: x\.player_id \|\| null \}/.test(lift('nbaUnderCardLeg')), 'the leg card stars it with that spec, his face added');
ok(/spec: \{[\s\S]*?pp: \{ line: x\.point, under: x\.model_under \} \} \};/.test(lift('nbaPpLeg')), 'a starred leg still goes on the slip with the model\'s chance, as the entry log reads it');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
