// What each range has really landed, beside the model's percentage on the NBA
// tab (2026-11-04).
//
// The owner asked whether a higher percentage on the NBA tab meant a likelier
// hit than Picks. It doesn't: the tab shows the model's raw chance, and its
// top range runs ahead of the record (70%+ landed 42 of 78, under the 65-70
// range's 70 of 112). So each leg says what legs in its range have landed. What
// has to hold:
//   - each leg reads its own range, on the same edges as the record it reads
//     (PP_BANDS in worker.js), from the unrounded chance
//   - a tapped PrizePicks line moves the chance, so it moves the range too
//   - a range with few legs, or no record at all, says nothing
//   - Blocks More keeps the record of its own and doesn't carry the line
//
// Real data (tests/fixtures/nba-pp-bands-20261104.json): /api/nba-pp on the
// morning of Nov 4, 2026, its whole record and a slice of its legs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The unders card's rows are leg cards since 2026-11-17 (the page brief's step 7): the card's helpers.
const NBA7 = ['TEAM_COLORS', 'MLB_TEAM_ID', 'NHL_PHOTO_SEASON', 'headshotUrl', 'teamMarkUrl', 'initialsOf', 'avatarHtml', 'LEG_OFFERS', 'offerLeg',
  'PICK_BOARD', 'PICK_SPORT', 'pickLeg', 'pct0', 'AM', 'soccerKick', 'pickIsTeam', 'pickTeamCode', 'pickTeamTag', 'miniBar', 'projLineHtml', 'mlChanceLineHtml', 'pickBarHtml', 'RING_C', 'chanceRingSvg', 'pickFace', 'ptDayOf', 'pickMoved',
  'trendTag', 'readAgeTag', 'INJ_ROLE_WORD', 'injRoleText', 'injuryTag', 'goalieNote', 'PROP_MIN_MOVE', 'legMinutes', 'toiText', 'minutesTagHtml', 'trendBarsHtml', 'impPct', 'priceSparkHtml', 'LINK_BOOK', 'STATE_SLOT', 'betLinkHtml', 'legLink', 'stakeTxt', 'moneyTxt', 'pickEdgeHtml',
  'nbCdf', 'r1', 'ppLineOf', 'ppChanceAt', 'pickAtLine', 'ppLineStepHtml', 'pickLineSetTag', 'shortDay', 'recSinceText',
  'PP_BREAK_EVEN', 'BOOK_LABEL', 'bkLabel', 'booksHtml', 'PICK_SAME', 'pickGameKey', 'pickShortName', 'PICK_TOP', 'pickDayWord', 'PICK_OPEN', 'legCardHtml',
  'propData', 'propVals', 'propTrend', 'sameGameMap', 'pickLegView', 'PP_LINE_MARKETS', 'nbaLegAtLine', 'NBA_SHARP_BOOKS', 'sharpAtLine', 'NBA_BANDS', 'NBA_BAND_MIN', 'nbaModelBit', 'sharpBooksText', 'nbaNick',
  'NBA_SHARP_BANDS', 'NBA_PROVEN_N', 'NBA_MORE_MODEL_W', 'nbaRot', 'nbaUnderRecord', 'nbaGameSub', 'nbaUnderCardLeg', 'nbaBlkCardLeg', 'nbaPicksProps', 'nbaUnderLegs', 'nbaBlkLegs', 'nbaBlkMoreHtml'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.join(HERE, '..');
const b = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'nba-pp-bands-20261104.json'), 'utf8'));

const NOW = Date.parse('2026-11-04T20:00:00Z');
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const app = fs.readFileSync(path.join(BOARD, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
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
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ui = { nbaPp: b, slip: {}, legView: 'detailed' };
const CARD = ['TEAM_COLORS', 'MLB_TEAM_ID', 'NHL_PHOTO_SEASON', 'headshotUrl', 'teamMarkUrl', 'initialsOf', 'avatarHtml',
  'miniBar', 'projLineHtml', 'LEG_OFFERS', 'offerLeg', 'ptDayOf', 'soccerKick', 'AM', 'MARKET_SHORT', 'NBA_ROTATION_MIN', 'NBA_MK', 'nbaPpLeg', 'nbaOversLineHtml', 'ppMovedTag',
  'ppCloseLineHtml', 'sharpBooksText', 'sharpTag', 'ppBookLine', 'ppGameLineHtml', 'PP_MORE_MIN', 'ppMoreP', 'ppMoreMk', 'ppMoreLeg', 'ppMoreTop', 'ppMoreListHtml',
  'shortDay', 'recSinceText', 'ppMoreLineHtml', 'nbaBlkMoreHtml', 'nbCdf', 'r1', 'pct0', 'PP_LINE_MARKETS', 'ppLineOf', 'ppChanceAt', 'nbaLegAtLine', 'NBA_SHARP_BOOKS', 'sharpAtLine', 'readAgeTag', 'INJ_ROLE_WORD', 'injRoleText', 'injuryTag', 'nbaCardInjTag', 'injOut', 'outLast', 'ppLineTags', 'ppLineStepHtml',
  'NBA_BANDS', 'NBA_BAND_MIN', 'nbaBandLandedHtml', 'nbaSharpLandedHtml', 'nbaModelBit', 'nbaNick', 'NBA_CODE_NICK', 'NHL_CODE_NICK', 'legOppText', 'nbaRebHeldHtml', 'nbaPpCardHtml'];
let C;
try {
  C = new Function('state', 'esc', CARD.concat(NBA7).filter((n, i, a) => a.indexOf(n) === i).map(lift).join('\n') + '\nreturn { NBA_BANDS, nbaBandLandedHtml, nbaPpCardHtml, nbaLegAtLine };')(ui, esc);
} catch (e) { console.log(`  FAIL  the card lifts out of app.js (${e.message})`); process.exit(1); }
const text = (h) => h.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').replace(/&lt;/g, '<').trim();
const r = b.record;
const landed = (p) => text(C.nbaBandLandedHtml(r, p));

console.log('\n-- each range, from the real record --');
ok(landed(80.7) === "70%+ legs landed 54% (42 of 78)", `Ajay Mitchell at 80.7: "${landed(80.7)}"`);
ok(landed(69.2) === "65-70% legs landed 63% (70 of 112)", `Anthony Davis at 69.2: "${landed(69.2)}"`);
ok(landed(62) === "60-65% legs landed 55% (104 of 188)", `at 62: "${landed(62)}"`);
ok(landed(57) === "55-60% legs landed 53% (177 of 334)", `at 57: "${landed(57)}"`);
ok(landed(40) === "<55% legs landed 50% (845 of 1689)", `at 40: "${landed(40)}"`);

console.log('\n-- on the edges the record uses --');
const worker = fs.readFileSync(path.join(BOARD, 'worker.js'), 'utf8');
const bands = JSON.parse(worker.match(/const PP_BANDS = (\[.*\]);/)[1].replace(/'/g, '"'));
ok(JSON.stringify(C.NBA_BANDS) === JSON.stringify(bands), `the page's ranges are the worker's PP_BANDS: ${JSON.stringify(bands)}`);
ok(/42 of 78/.test(landed(70)) && /70 of 112/.test(landed(69.9)), '70 is the top range, 69.9 the one below');
ok(/70 of 112/.test(landed(65)) && /104 of 188/.test(landed(64.9)), '65 and 64.9');
ok(/104 of 188/.test(landed(60)) && /177 of 334/.test(landed(59.9)), '60 and 59.9');
ok(/177 of 334/.test(landed(55)) && /845 of 1689/.test(landed(54.9)), '55 and 54.9');

console.log('\n-- says nothing when it has nothing to say --');
ok(C.nbaBandLandedHtml(null, 80) === '' && C.nbaBandLandedHtml({}, 80) === '', 'no record');
ok(C.nbaBandLandedHtml(r, null) === '' && C.nbaBandLandedHtml(r, undefined) === '', 'no chance');
const thin = { byBand: { '70+': { n: 29, hit: 16, hitRate: 55.2 }, '65-70': { n: 30, hit: 19, hitRate: 63.3 } } };
ok(C.nbaBandLandedHtml(thin, 75) === '', 'a range of 29 legs');
ok(text(C.nbaBandLandedHtml(thin, 66)) === "65-70% legs landed 63% (19 of 30)", 'a range of 30 does');
ok(C.nbaBandLandedHtml({ byBand: { '70+': { n: 0, hit: 0, hitRate: null } } }, 75) === '', 'an empty range');

// Since 2026-11-16 the card leads with the sharp books' chance (tests/sharpcard.mjs): the line
// under the big number is the sharp range's, and the model's range rides with its chance on the
// third line ("model 81% (its 70%+ landed 54%)"). Since 2026-11-17 the rows are leg cards (step 7):
// the model's bit sits in the Sharp books tile, or among the tags where the books haven't priced it.
console.log('\n-- on the card, beside the model\'s chance --');
const before = (html, name) => (html.split(`<b>${name}</b>`)[1] || '').split('<li class="lc')[0];
const card = C.nbaPpCardHtml();
const unders = card.split('<h3 class="pk-gh">Blocks: More</h3>')[0];
const shown = [...unders.matchAll(/<span class="lc-name"><b>([^<]+)<\/b>/g)].map((m) => m[1]);
const top = shown.map((n) => b.legs.find((x) => x.player === n));
const modelBit = (html) => (html.match(/<span class="tc-model"[^>]*>[^<]*<\/span>/) || [''])[0];
const rangeOf = (p) => (landed(p).match(/^(.*?) legs landed (\d+)% \((\d+ of \d+)\)$/) || []).slice(1);
ok(top.length === 5 && top.every(Boolean) && (unders.match(/class="tc-model"/g) || []).length === top.length, `each of the ${top.length} legs carries one: ${shown.join(', ')}`);
for (const x of top) {
  const bit = modelBit(before(unders, x.player));
  const [what, rate, count] = rangeOf(x.model_under);
  ok(text(bit) === `model ${Math.round(x.model_under)}% (its ${what === '<55%' ? 'under 55%' : what} landed ${rate}%)` && bit.includes(count),
    `${x.player} at ${x.model_under}: "${text(bit)}", ${count} on hover`);
}
const ajay = before(unders, 'Ajay Mitchell'), davion = before(unders, 'Davion Mitchell');
ok(ajay.indexOf('no sharp line yet') >= 0 && ajay.indexOf('no sharp line yet') < ajay.indexOf('class="tc-model"') && ajay.indexOf('class="tc-model"') < ajay.indexOf('class="lc-p"'), 'not priced: among the tags, after "no sharp line yet"');
ok(/<span class="lc-tk">Sharp books<\/span><b class="lc-tv">54%<\/b><span class="lc-ts"><span class="tc-model"/.test(davion), "priced: under the sharp books' chance, in their tile");

console.log('\n-- a tapped line moves the range --');
const reed = b.legs.find((x) => x.player === 'Paul Reed Jr');
ok(shown.includes(reed.player), 'Paul Reed Jr is on the card');
const key = `nbapp:${reed.game_id}:${reed.player}:${reed.market}`;
const line2 = reed.point - 3;
ui.ppLines = { [key]: { line: line2, at: NOW + 1000, commence: reed.commence } };
const moved = C.nbaLegAtLine(reed);
ok(moved.point === line2 && moved.model_under < 70, `Reed's rebounds set at ${line2}: the model says ${moved.model_under}`);
const tapped = C.nbaPpCardHtml().split('<h3 class="pk-gh">Blocks: More</h3>')[0];
const tappedBit = text(modelBit(before(tapped, reed.player)));
const [w2, rate2] = rangeOf(moved.model_under);
ok(tappedBit === `model ${Math.round(moved.model_under)}% (its ${w2 === '<55%' ? 'under 55%' : w2} landed ${rate2}%)` && !/70%\+/.test(tappedBit), `the range follows: "${tappedBit}"`);
ui.ppLines = {};

console.log('\n-- the rest of the card --');
const more = card.split('<h3 class="pk-gh">Blocks: More</h3>')[1] || '';
ok(more.length > 0 && !/tc-landed/.test(more) && !/tc-model/.test(more), 'Blocks More keeps its own record and no range line');
ui.nbaPp = { ...b, record: null };
const noRecord = C.nbaPpCardHtml();
ok(/<b>Ajay Mitchell<\/b>/.test(noRecord) && !/tc-landed/.test(noRecord) && /class="tc-model"[^>]*>model 81%<\/span>/.test(noRecord), 'with no record the legs still show, the model\'s chance without its range');
ui.nbaPp = b;

console.log('\n-- the style --');
const css = fs.readFileSync(path.join(BOARD, 'style.css'), 'utf8').replace(/\r\n/g, '\n');
const rule = (css.match(/\.tc-landed \{[^}]*\}/) || [''])[0];
ok(/display:block/.test(rule) && /text-align:right/.test(rule), `its own line, under the number: ${rule}`);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
