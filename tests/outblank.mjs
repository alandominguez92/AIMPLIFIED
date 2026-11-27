// A player ESPN lists out shows no numbers (2026-11-21, the owner's "blank his numbers").
//
// The owner first asked for "the actual players' projections" when someone is ruled out. A replay of
// last season moving his minutes to his teammates was no help (their Overs it flipped landed 48%),
// so the change is to his own row: ESPN has him out, and a chance, a side and a projection beside an
// out tag read as a pick. What has to hold:
//   - on the props card his row keeps his name, the game, the stat and the injury tag, with no
//     percentage, no Over/Under at a line, no projection and no star, and it doesn't open
//   - a leg of his already on the slip keeps its star, to be taken off
//   - a player listed questionable (GTD) is not out: his row is as before
//   - on the NBA tab his leg card keeps its top row and the injury tag, with a dash for the chance,
//     "ruled out", no tiles, no bar, no other tags, no star and no tap to open
//
// Real data: production's /api/nba-props and /api/nba-pp at 4:36 PM Pacific on Nov 21
// (tests/fixtures/nba-props-20261121.json, nba-pp-20261121.json): ESPN listed Karl-Anthony Towns out
// with an illness for Blazers @ Knicks, his points line 20.5 with the sharp books at 49% Under. ESPN
// listed no one out among the unders log's rows, so the leg-card check gives one of them Towns's
// report, exactly as recorded.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.join(HERE, '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', f), 'utf8'));
const PR = read('nba-props-20261121.json'), PP = read('nba-pp-20261121.json');
const NOW = Date.parse(PR.at);
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fail++; };

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
const have = (n) => app.includes(`function ${n}(`) || app.includes(`const ${n} =`);
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

console.log('-- the real night --');
const kat = PR.players.find((p) => p.name === 'Karl-Anthony Towns'), knicks = PR.games[kat.g];
ok(kat.team === 'NY' && kat.inj && kat.inj.out === true && kat.inj.status === 'OUT' && kat.inj.what === 'illness'
  && kat.lines.pts.l === 20.5 && kat.lines.pts.u === 49 && kat.proj.pts === 22.8,
  'Karl-Anthony Towns: ESPN lists him out (illness), points 20.5 with the sharp books at 49% Under, projected 22.8');
ok(/Trail Blazers/.test(knicks.away) && /Knicks/.test(knicks.home) && Date.parse(knicks.commence) > NOW, 'Blazers @ Knicks, still to tip off at the read');
const achiuwa = PR.players.find((p) => p.name === 'Precious Achiuwa');
ok(achiuwa && achiuwa.inj.status === 'GTD' && !achiuwa.inj.out && PR.games[achiuwa.g].date === knicks.date && achiuwa.proj.reb != null,
  `Precious Achiuwa listed questionable for tonight, not out, projected ${achiuwa.proj.reb} rebounds`);

// ---- the props card ----
const st = { slip: {}, props: { nba: PR }, prStat: { nba: 'pts' }, prTopAll: { nba: true } };
const PCARD = ['LEG_OFFERS', 'offerLeg', 'pct0', 'r1', 'miniBar', 'projLineHtml', 'trendBarsHtml', 'soccerKick', 'shortDay', 'INJ_ROLE_WORD', 'injRoleText', 'injuryTag', 'nbaCardInjTag', 'injOut',
  'nbaNick', 'nhlNick', 'NBA_CODE_NICK', 'NHL_CODE_NICK', 'NFL_CODE_NICK', 'legOppText', 'propStartTag', 'PROP_STATS', 'PROP_NOTE', 'propNick', 'propCodes', 'PROP_STRONG', 'PROP_TOP_N', 'propKey', 'propData', 'propVals', 'propView', 'propLeg', 'propFind', 'propSlipSync',
  'propSaveHtml', 'PROP_AGAINST', 'propAgainstTag', 'PROP_MIN_MOVE', 'propMinTag', 'legMinutes', 'toiText', 'minutesTagHtml', 'propLateTag', 'PROP_PARTS', 'propFairAt', 'propDisagreeTag', 'propRow', 'spBarHtml', 'ptDayOf', 'PROP_GAME_HOURS', 'propDay', 'propDayName', 'propDayTitle', 'propDayWait', 'propKick', 'propsCardHtml'].filter(have);
let P;
try {
  P = new Function('state', 'esc', 'persistSlip', 'renderSlip', PCARD.map(lift).join('\n') + '\nreturn { propsCardHtml, propView, propLeg, offerLeg };')(st, esc, () => {}, () => {});
} catch (e) { console.log(`  FAIL  the props card lifts out of app.js (${e.message})`); process.exit(1); }
const gameOf = (h, id) => { const at = h.indexOf(`<div class="sp-match" data-mid="${id}"`); if (at < 0) return ''; const next = h.indexOf('<div class="sp-match"', at + 10); return h.slice(at, next > 0 ? next : h.length); };
const rowFor = (h, name) => h.split('<li class="sp-row').slice(1).find((r) => (r.match(/<span class="tc-l1"><b>([^<]+)<\/b>/) || [])[1] === name) || '';

console.log('\n-- his points row on the props card --');
st.prMatch = { [knicks.id]: true };
let game = gameOf(P.propsCardHtml('nba'), knicks.id);
let row = rowFor(game, 'Karl-Anthony Towns');
ok(!!row && /Out: illness/.test(text(row)) && /Blazers · points/.test(text(row)), `still in the Blazers @ Knicks points list, flagged: "${text(row).slice(0, 90)}"`);
ok(!/class="tc-p/.test(row) && !/\d%/.test(text(row)), 'no percentage (it read 51% Over)');
ok(!/\b(Over|Under) 20\.5\b/.test(text(row)) && !/20\.5/.test(text(row)), 'no Over or Under at 20.5');
ok(!/pp-projbar|proj\b|22\.8/.test(row), 'no projection (22.8)');
ok(!/class="tc-add/.test(row) && !/data-action="leg-add"/.test(row), 'no star');
ok(!/data-action="pr-row"/.test(row) && !/<button/.test(row), "nothing to tap: the row doesn't open");
st.prOpen = { [P.propView('nba', PR, knicks, kat, 'pts').key]: true };
row = rowFor(gameOf(P.propsCardHtml('nba'), knicks.id), 'Karl-Anthony Towns');
ok(!/sp-set|sp-in|pr-side/.test(row), 'left open from before: no line setter or sides');
st.prOpen = {};

console.log('\n-- a teammate, and the slip --');
const brunson = rowFor(game, 'Jalen Brunson');
ok(/<span class="tc-p[^"]*">5\d%<\/span>/.test(brunson) && /data-action="pr-row"/.test(brunson) && /class="tc-add/.test(brunson), `Jalen Brunson, not out, as before: "${text(brunson).slice(0, 70)}"`);
const v = P.propView('nba', PR, knicks, kat, 'pts'), leg = P.propLeg('nba', knicks, kat, 'pts', v);
st.slip = { [P.offerLeg(leg)]: leg };
row = rowFor(gameOf(P.propsCardHtml('nba'), knicks.id), 'Karl-Anthony Towns');
ok(/class="tc-add on" data-action="leg-add"/.test(row) && /aria-label="Remove [^"]+ from your slip"/.test(row), 'a leg of his already on the slip keeps its star, to take it off');
ok(!/class="tc-p/.test(row), 'and still no percentage');
st.slip = {};

console.log('\n-- Best --');
st.prStat = { nba: 'best' };
let bestGame = gameOf(P.propsCardHtml('nba'), knicks.id);
ok(!!rowFor(bestGame, 'Jalen Brunson') && !rowFor(bestGame, 'Karl-Anthony Towns'), "Best, each player's strongest number: Brunson listed, Towns (no number to show) not");
st.prQuery = { nba: 'towns' };
bestGame = gameOf(P.propsCardHtml('nba'), knicks.id);
ok(bestGame.split('<li class="sp-row').length - 1 === 1 && /Out: illness/.test(text(rowFor(bestGame, 'Karl-Anthony Towns'))), 'a search for him there finds his flagged row, once');
st.prQuery = {};
st.prStat = { nba: 'pts' };

console.log('\n-- questionable is not out --');
const gg = PR.games[achiuwa.g];
st.prMatch = { [gg.id]: true };
st.prStat = { nba: 'reb' };
const gRow = rowFor(gameOf(P.propsCardHtml('nba'), gg.id), 'Precious Achiuwa');
ok(!!gRow && /data-action="pr-row"/.test(gRow) && /class="tc-add/.test(gRow) && new RegExp(`proj ${achiuwa.proj.reb}`).test(text(gRow)) && /GTD|questionable/i.test(text(gRow)),
  `his row keeps its projection, its star and its tap: "${text(gRow).slice(0, 90)}"`);

// ---- the NBA tab's leg card ----
const NBA7 = ['TEAM_COLORS', 'MLB_TEAM_ID', 'NHL_PHOTO_SEASON', 'headshotUrl', 'teamMarkUrl', 'initialsOf', 'avatarHtml', 'LEG_OFFERS', 'offerLeg',
  'PICK_BOARD', 'PICK_SPORT', 'pickLeg', 'pct0', 'AM', 'soccerKick', 'pickIsTeam', 'pickTeamCode', 'pickTeamTag', 'miniBar', 'projLineHtml', 'mlChanceLineHtml', 'pickBarHtml', 'RING_C', 'chanceRingSvg', 'pickFace', 'ptDayOf', 'pickMoved',
  'trendTag', 'readAgeTag', 'INJ_ROLE_WORD', 'injRoleText', 'injuryTag', 'goalieNote', 'legMinutes', 'toiText', 'minutesTagHtml', 'trendBarsHtml', 'impPct', 'priceSparkHtml', 'LINK_BOOK', 'STATE_SLOT', 'betLinkHtml', 'legLink', 'stakeTxt', 'moneyTxt', 'pickEdgeHtml',
  'nbCdf', 'r1', 'ppLineOf', 'ppChanceAt', 'pickAtLine', 'ppLineStepHtml', 'pickLineSetTag', 'shortDay', 'recSinceText',
  'PP_BREAK_EVEN', 'BOOK_LABEL', 'bkLabel', 'booksHtml', 'PICK_SAME', 'pickGameKey', 'pickShortName', 'PICK_TOP', 'pickDayWord', 'PICK_OPEN', 'legCardHtml',
  'propData', 'propVals', 'propTrend', 'MARKET_SHORT', 'NBA_MK', 'nbaPpLeg', 'ppMovedTag', 'ppLineTags', 'ppBookLine', 'sharpBooksText', 'injOut', 'NBA_SHARP_BOOKS', 'sharpAtLine', 'PP_LINE_MARKETS', 'nbaLegAtLine',
  'NBA_BANDS', 'NBA_BAND_MIN', 'nbaModelBit', 'nbaNick', 'NBA_SHARP_BANDS', 'NBA_PROVEN_N', 'nbaUnderRecord', 'nbaGameSub', 'nbaUnderCardLeg'].filter(have).filter((n, i, a) => a.indexOf(n) === i);
const ui = { nbaPp: PP, slip: {}, legView: 'detailed' };
let L;
try {
  L = new Function('state', 'esc', NBA7.map(lift).join('\n') + '\nreturn { legCardHtml, nbaUnderCardLeg, pickLeg, offerLeg };')(ui, esc);
} catch (e) { console.log(`  FAIL  the leg card lifts out of app.js (${e.message})`); process.exit(1); }
console.log('\n-- a leg card on the NBA tab --');
const x0 = PP.legs.find((l) => l.player === 'Payton Pritchard' && l.market === 'ast');
ok(x0 && x0.point === 6.5 && x0.sharp_under === 54.4 && x0.min_proj >= 20 && !(x0.inj && x0.inj.out), 'Payton Pritchard Under 6.5 assists, sharp 54.4%, ESPN listing nothing for him');
const ctx = { sport: 'nba', same: new Map(), topMl: null };
const base = L.legCardHtml(L.nbaUnderCardLeg(x0, PP.record || {}), false, '', false, ctx);
ok(/<b class="lc-pct[^"]*"[^>]*>54%<\/b>/.test(base) && /lc-tiles/.test(base) && /data-action="leg-add"/.test(base), 'as it is: 54% large, its tiles and a star');
const outLeg = L.nbaUnderCardLeg({ ...x0, inj: kat.inj }, PP.record || {});
for (const [label, compact] of [['Detailed', false], ['Simple', true]]) {
  const h = L.legCardHtml(outLeg, compact, '', false, ctx);
  ok(!/\d%/.test(text(h)) && /<b class="lc-pct lc-out"[^>]*>—<\/b>/.test(h) && /ruled out/.test(text(h)), `${label}, listed out: a dash and "ruled out", no percentage`);
  ok(/illness/i.test(text(h)) && !/lc-tiles|lc-more|pp-projbar|sp-step/.test(h), `${label}: the injury tag, and no tiles, bar or line stepper`);
  ok(!/data-action="leg-add"/.test(h) && /lc-star-off/.test(h) && !/data-action="leg-open"/.test(h), `${label}: no star (its room kept) and no tap to open`);
  const tags = (h.match(/<span class="lc-tags">([\s\S]*?)<\/span><\/div>/) || [])[1] || '';
  ok(!/vs book|model|no sharp line|last \d|read /i.test(text(tags)), `${label}: only ESPN's tags ("${text(tags)}")`);
}
ui.slip = { [L.offerLeg(L.pickLeg(outLeg))]: L.pickLeg(outLeg) };
const onSlip = L.legCardHtml(outLeg, false, '', false, ctx);
ok(/class="lc-star on" data-action="leg-add"/.test(onSlip) && /—/.test(onSlip), 'on the slip already: its star, to take it off, and still the dash');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
