// Out players last on the NBA tab, and the 2-pick Power read a leg at a time (2026-11-16, the
// owner's "do 3 and 6").
//
// A review of the site found Klay Thompson Under 0.5 steals the top NBA under at 76% while ESPN
// listed them out (ankle soreness, Nov 13): Picks leaves an out player off and the props cards'
// Strongest list did from Nov 13, but the tab's own lists still sorted by chance. And the entry
// table read "Top 2 power · 39% both · needs 33%" above "Top 3 flex · 60% a leg · needs 59.1%". What
// has to hold:
//   - on the unders card an out player goes below everyone else, so a top-five card leaves them
//     off; the rest keep their order
//   - the same for the blocks Mores and in a game's list on the props card, where they stay,
//     flagged, at the bottom
//   - a player listed questionable (GTD) is not out and keeps their place
//   - the 2-pick Power rows read a leg, as the Flex rows do: the pair's geometric mean against
//     57.7%, with the both-land chance and its 33% in the title; the EV beside it is unchanged
//
// Real data: production's /api/nba-pp and /api/picks at 12:40 AM Pacific on Nov 16
// (tests/fixtures/nba-pp-20261116.json, picks-20261116-0040.json), and /api/nba-props at 11:47 PM
// on Nov 13 (nba-props-20261113-2347.json), when ESPN had Klay out. On Nov 16 ESPN listed no one
// out among the card's rotation legs, so the unders and blocks checks give the Nov 16 rows the
// report Klay had on Nov 13, exactly as recorded then.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The unders card's rows are leg cards since 2026-11-17 (the page brief's step 7): the card's helpers.
const NBA7 = ['TEAM_COLORS', 'MLB_TEAM_ID', 'NHL_PHOTO_SEASON', 'headshotUrl', 'teamMarkUrl', 'initialsOf', 'avatarHtml', 'LEG_OFFERS', 'offerLeg',
  'PICK_BOARD', 'PICK_SPORT', 'pickLeg', 'pct0', 'AM', 'soccerKick', 'pickIsTeam', 'pickTeamCode', 'pickTeamTag', 'miniBar', 'projLineHtml', 'mlChanceLineHtml', 'pickBarHtml', 'RING_C', 'chanceRingSvg', 'pickFace', 'ptDayOf', 'pickMoved',
  'trendTag', 'readAgeTag', 'INJ_ROLE_WORD', 'injRoleText', 'injuryTag', 'goalieNote', 'legMinutes', 'toiText', 'minutesTagHtml', 'trendBarsHtml', 'impPct', 'priceSparkHtml', 'LINK_BOOK', 'STATE_SLOT', 'betLinkHtml', 'legLink', 'stakeTxt', 'moneyTxt', 'pickEdgeHtml',
  'nbCdf', 'r1', 'ppLineOf', 'ppChanceAt', 'pickAtLine', 'ppLineStepHtml', 'pickLineSetTag', 'shortDay', 'recSinceText',
  'PP_BREAK_EVEN', 'dfsLinesHtml', 'BOOK_LABEL', 'bkLabel', 'booksHtml', 'PICK_SAME', 'pickGameKey', 'pickShortName', 'PICK_TOP', 'pickDayWord', 'PICK_OPEN', 'legCardHtml',
  'propData', 'propVals', 'propTrend', 'sameGameMap', 'pickLegView', 'PP_LINE_MARKETS', 'nbaLegAtLine', 'NBA_SHARP_BOOKS', 'sharpAtLine', 'NBA_BANDS', 'NBA_BAND_MIN', 'nbaModelBit', 'sharpBooksText', 'nbaNick',
  'NBA_SHARP_BANDS', 'NBA_PROVEN_N', 'NBA_MORE_MODEL_W', 'nbaRot', 'nbaUnderRecord', 'nbaGameSub', 'nbaUnderCardLeg', 'nbaBlkCardLeg', 'nbaPicksProps', 'nbaUnderLegs', 'nbaBlkLegs', 'nbaBlkMoreHtml'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.join(HERE, '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', f), 'utf8'));
const PP = read('nba-pp-20261116.json'), PK = read('picks-20261116-0040.json'), PR = read('nba-props-20261113-2347.json');
let NOW = Date.parse(PK.asOf);
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
// A name the code on HEAD doesn't have yet is left out, so the checks below fail rather than the lift.
const have = (n) => app.includes(`function ${n}(`) || app.includes(`const ${n} =`);
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const KLAY_INJ = PR.players.find((p) => p.name === 'Klay Thompson').inj;

// ---- the unders card and its blocks Mores ----
const ui = { nbaPp: null, slip: {}, legView: 'detailed' };
const CARD = ['TEAM_COLORS', 'MLB_TEAM_ID', 'NHL_PHOTO_SEASON', 'headshotUrl', 'teamMarkUrl', 'initialsOf', 'avatarHtml',
  'miniBar', 'projLineHtml', 'LEG_OFFERS', 'offerLeg', 'ptDayOf', 'soccerKick', 'AM', 'MARKET_SHORT', 'NBA_ROTATION_MIN', 'NBA_MK', 'nbaPpLeg', 'nbaOversLineHtml', 'ppMovedTag',
  'ppCloseLineHtml', 'dfsLinesHtml', 'sharpBooksText', 'sharpTag', 'ppBookLine', 'ppGameLineHtml', 'PP_MORE_MIN', 'injOut', 'outLast', 'ppMoreP', 'ppMoreMk', 'ppMoreLeg', 'ppMoreTop', 'ppMoreListHtml',
  'shortDay', 'recSinceText', 'ppMoreLineHtml', 'nbaBlkMoreHtml', 'nbCdf', 'r1', 'pct0', 'PP_LINE_MARKETS', 'ppLineOf', 'ppChanceAt', 'nbaLegAtLine', 'NBA_SHARP_BOOKS', 'sharpAtLine', 'readAgeTag', 'INJ_ROLE_WORD', 'injRoleText', 'injuryTag', 'nbaCardInjTag', 'ppLineTags', 'ppLineStepHtml',
  'NBA_BANDS', 'NBA_BAND_MIN', 'nbaBandLandedHtml', 'nbaSharpLandedHtml', 'nbaModelBit', 'nbaNick', 'NBA_CODE_NICK', 'NHL_CODE_NICK', 'legOppText', 'nbaPpCardHtml'].filter(have);
let C;
try {
  C = new Function('state', 'esc', CARD.concat(NBA7).filter((n, i, a) => a.indexOf(n) === i).map(lift).join('\n') + '\nreturn { nbaPpCardHtml, ppMoreTop };')(ui, esc);
} catch (e) { console.log(`  FAIL  the card lifts out of app.js (${e.message})`); process.exit(1); }
const withOut = (names) => ({ ...PP, legs: PP.legs.map((l) => (names.includes(l.player) ? { ...l, inj: KLAY_INJ } : l)) });
// The rows are leg cards since 2026-11-17 (the page brief's step 7), the blocks Mores in a group of their own.
const cardNames = (d) => { ui.nbaPp = d; const h = C.nbaPpCardHtml().split('<div class="pk-grp nba-blk">')[0];
  return h.split('<li class="lc').slice(1).map((li) => (li.match(/<span class="lc-name"><b>([^<]+)<\/b>/) || [])[1]); };

console.log('-- the real legs --');
const rot = PP.legs.filter((l) => l.min_proj >= 20);
ok(rot[0].player === 'Klay Thompson' && rot[0].market === 'stl' && rot[0].model_under === 75.6 && rot[0].inj && rot[0].inj.status === null,
  'Nov 16: Klay Thompson Under steals at 75.6% leads the rotation legs, ESPN listing nothing for them');
ok(KLAY_INJ.out === true && KLAY_INJ.status === 'OUT' && KLAY_INJ.what === 'ankle soreness', "Nov 13's report on Klay: out, ankle soreness");
const tyson = rot.find((l) => l.player === 'Jaylon Tyson');
ok(tyson && tyson.inj.status === 'GTD' && tyson.inj.out === false, 'Jaylon Tyson listed questionable (ankle), not out');

// The card is in the sharp books' order since 2026-11-16 (tests/sharpcard.mjs), out players still
// last: Klay, with no sharp line, is off the five either way, so the one listed out here is the
// sharp list's leader.
console.log('\n-- the unders card --');
// Fred VanVleet, fourth by the sharp chance (53.9), was listed out on Nov 16 (knee) and is last.
const isOut = (l) => !!(l.inj && l.inj.out);
const sharpRot = rot.filter((l) => typeof l.sharp_under === 'number').sort((a, b) => isOut(a) - isOut(b) || b.sharp_under - a.sharp_under);
ok(sharpRot[sharpRot.length - 1].player === 'Fred VanVleet' && rot.filter(isOut).length === 1, 'Fred VanVleet, listed out, is the one out among them');
const before = cardNames(PP);
ok(JSON.stringify(before) === JSON.stringify(sharpRot.slice(0, 5).map((l) => l.player)) && !before.includes('Fred VanVleet'), `the top five by the sharp chance, VanVleet off it (${before.join(', ')})`);
const lead = sharpRot[0].player;
const after = cardNames(withOut([lead]));
ok(!after.includes(lead), `${lead} listed out: off the five (${after.join(', ')})`);
ok(JSON.stringify(after) === JSON.stringify(sharpRot.slice(1, 6).map((l) => l.player)), 'the next five move up, in their order');
const third = sharpRot[2].player;
const gtd = cardNames({ ...PP, legs: PP.legs.map((l) => (l.player === third ? { ...l, inj: tyson.inj } : l)) });
ok(JSON.stringify(gtd) === JSON.stringify(before), `${third} given Tyson's questionable report keeps their place`);
const top8 = sharpRot.slice(0, 8).map((l) => l.player).filter((n) => n !== third);
const outN = new Set(top8);
const legs6 = cardNames(withOut(top8));
ok(legs6.length === 5 && (legs6.every((n) => !outN.has(n)) || legs6.findIndex((n) => outN.has(n)) > legs6.findLastIndex((n) => !outN.has(n))), `with seven of the top eight out, none ahead of a player who isn't (${legs6.join(', ')})`);
ok(!cardNames(withOut(['Klay Thompson'])).includes('Klay Thompson') && !before.includes('Klay Thompson'), 'Klay, with no sharp line, is off the five, out or not');

console.log('\n-- blocks Mores --');
const blk = (d) => C.ppMoreTop(d.legs.filter((l) => l.min_proj >= 20), (x) => x.market === 'blk', 3).map((x) => x.player);
const b0 = blk(PP), b1 = blk(withOut(['Jabari Smith Jr']));
ok(b0[0] === 'Jabari Smith Jr', `the best blocks More: Jabari Smith Jr (${b0.join(', ')})`);
ok(b1[0] !== 'Jabari Smith Jr' && b1[b1.length - 1] === 'Jabari Smith Jr', `listed out, they go last (${b1.join(', ')})`);

// ---- a game's list on the props card ----
NOW = Date.parse(PR.at);
const st = { slip: {}, props: { nba: PR }, prStat: { nba: 'threes' }, prTopAll: { nba: true } };
const PCARD = ['LEG_OFFERS', 'offerLeg', 'pct0', 'r1', 'miniBar', 'projLineHtml', 'trendBarsHtml', 'soccerKick', 'shortDay', 'INJ_ROLE_WORD', 'injRoleText', 'injuryTag', 'nbaCardInjTag', 'injOut',
  'nbaNick', 'nhlNick', 'NBA_CODE_NICK', 'NHL_CODE_NICK', 'NFL_CODE_NICK', 'legOppText', 'propStartTag', 'PROP_STATS', 'PROP_NOTE', 'propNick', 'propCodes', 'PROP_STRONG', 'PROP_TOP_N', 'propKey', 'propData', 'propVals', 'propView', 'propLeg', 'propFind', 'propSlipSync',
  'propSaveHtml', 'PROP_AGAINST', 'propAgainstTag', 'PROP_MIN_MOVE', 'propMinTag', 'legMinutes', 'toiText', 'minutesTagHtml', 'propLateTag', 'PROP_PARTS', 'propFairAt', 'propDisagreeTag', 'propRow', 'spBarHtml', 'ptDayOf', 'PROP_GAME_HOURS', 'propDay', 'propDayName', 'propDayTitle', 'propDayWait', 'propKick', 'propsCardHtml'].filter(have);
let P;
try {
  P = new Function('state', 'esc', 'persistSlip', 'renderSlip', PCARD.map(lift).join('\n') + '\nreturn { propsCardHtml };')(st, esc, () => {}, () => {});
} catch (e) { console.log(`  FAIL  the props card lifts out of app.js (${e.message})`); process.exit(1); }
console.log('\n-- the props card, Nov 13 --');
const klay = PR.players.find((p) => p.name === 'Klay Thompson'), heat = PR.games[klay.g];
st.prMatch = { [heat.id]: true };
const h = P.propsCardHtml('nba');
const at = h.indexOf(`<div class="sp-match" data-mid="${heat.id}"`), next = h.indexOf('<div class="sp-match"', at + 10);
const game = h.slice(at, next > 0 ? next : h.length);
const rowsG = game.split('<li class="sp-row').slice(1);
const names = rowsG.map((r) => (r.match(/<span class="tc-l1"><b>([^<]+)<\/b>/) || [])[1]);
const outs = PR.players.filter((p) => p.g === klay.g && p.inj && p.inj.out).map((p) => p.name);
const firstOut = names.findIndex((n) => outs.includes(n));
const lastIn = names.reduce((a, n, i) => (outs.includes(n) ? a : i), -1);
const klayRow = rowsG[names.indexOf('Klay Thompson')] || '';
ok(names.length > 2 && names.every(Boolean) && /ankle soreness/.test(text(klayRow.split('sp-set')[0])),
  `Klay still in the Pistons @ Heat threes list, flagged (${names.length} rows; out: ${outs.join(', ')})`);
ok(firstOut > lastIn, `every out player below everyone who isn't (${names.map((n) => (outs.includes(n) ? `[${n}]` : n)).join(', ')})`);

// ---- the entry table ----
console.log('\n-- the 2-pick Power, a leg at a time --');
const bank = { state: { bank: null } };
const ER = ['PP_BREAK_EVEN', 'pct0', 'stakeTxt', 'entryRows'];
let E;
try {
  E = new Function('state', 'esc', ER.map(lift).join('\n') + '\nreturn { entryRows };')(bank.state, esc);
} catch (e) { console.log(`  FAIL  the entry table lifts out of app.js (${e.message})`); process.exit(1); }
const pp = PK.ppPool, ml = PK.mlPool;
ok(pp.length === 3 && pp[0].p === 63 && pp[1].p === 62.1 && PK.entries[0].ev === 14.5, `Nov 16's entry: ${pp.map((x) => `${x.title} ${x.p}`).join(', ')}; the Power priced +14.5%`);
const rowsPP = E.entryRows(pp, PK.entries).map(text);
ok(/^Top 2 power 63% a leg needs 57\.7% \+14\.5%/.test(rowsPP[0]), `"${rowsPP[0]}"`);
ok(/^Top 3 flex 60% a leg needs 59\.1%/.test(rowsPP[1]), `the Flex row as before: "${rowsPP[1]}"`);
const raw = E.entryRows(pp, PK.entries)[0];
ok(/title="Both land: 39%; it needs 33%"/.test(raw), 'the both-land chance and its bar in the title');
const rowsML = E.entryRows(ml, PK.mlEntries).map(text);
ok(/^Top 2 power 79% a leg needs 57\.7%/.test(rowsML[0]) && /^Top 2 power, 75%\+ 79% a leg needs 57\.7%/.test(rowsML[1]),
  `the moneyline entry's two Power rows: "${rowsML[0]}" / "${rowsML[1]}"`);
ok(rowsPP.concat(rowsML).every((r) => !/ both | needs 33%/.test(r)), 'no row reads "both" or "needs 33%"');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
