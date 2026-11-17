// "Books disagree" on the NHL props card (2026-11-17, the owner's "tag it books disagree").
//
// Every assist and every goal is a point too, so at one number a points Under can't land more often
// than the same player's assists Under or goals Under. On the Nov 17 read the sharp books had Jackson
// LaCombe's points Under 0.5 at 71.1% and his assists Under 0.5 at 55.55%: one of the two quotes was
// off, and the read doesn't keep which book's. The owner chose a tag over dropping the number. What
// has to hold:
//   - the points row says "books disagree", and on hover both numbers and why
//   - its number stays as read; the assists row, and every row with nothing to compare, say nothing
//   - a point of slack for the de-vigging's rounding; a goals Under counts as assists' does
//   - a line set elsewhere, where the books have no assists price, has nothing to compare
//   - the NBA card has no such check
//
// Real data: /api/nhl-props on Nov 17, 2026 at 09:06 UTC, LaCombe's game (Ducks @ Blues), every
// player the board had in it (tests/fixtures/nhl-props-board-20261117.json). Across the whole board
// his was the one player with a points and an assists price at the same number.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.join(HERE, '..');
const D = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'nhl-props-board-20261117.json'), 'utf8'));
const NOW = Date.parse(D.games[0].commence) - 3 * 3600e3;
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
const state = { slip: {}, props: { nhl: D }, prStat: { nhl: 'pts' }, prMatch: { [D.games[0].id]: true } };
const CARD = ['LEG_OFFERS', 'offerLeg', 'pct0', 'r1', 'miniBar', 'projLineHtml', 'trendBarsHtml', 'soccerKick', 'shortDay', 'INJ_ROLE_WORD', 'injRoleText', 'injuryTag', 'nbaCardInjTag', 'injOut', 'outLast',
  'nbaNick', 'nhlNick', 'NBA_CODE_NICK', 'NHL_CODE_NICK', 'NFL_CODE_NICK', 'legOppText', 'propStartTag', 'PROP_STATS', 'PROP_NOTE', 'propNick', 'propCodes', 'PROP_STRONG', 'PROP_TOP_N', 'propKey', 'propData', 'propVals', 'propView', 'propLeg', 'propFind', 'propSlipSync',
  'propSaveHtml', 'PROP_AGAINST', 'propAgainstTag', 'PROP_MIN_MOVE', 'propMinTag', 'propLateTag', 'PROP_PARTS', 'propFairAt', 'propDisagreeTag', 'propRow', 'spBarHtml', 'ptDayOf', 'PROP_GAME_HOURS', 'propDay', 'propDayName', 'propDayTitle', 'propDayWait', 'propKick', 'propsCardHtml'];
let C;
try {
  if (!/function propDisagreeTag\(/.test(app)) throw new Error('app.js has no propDisagreeTag');
  C = new Function('state', 'esc', 'persistSlip', 'renderSlip', CARD.map(lift).join('\n') + '\nreturn { propsCardHtml, propView, propDisagreeTag };')(state, esc, () => {}, () => {});
} catch (e) { console.log(`  FAIL  the card lifts out of app.js (${e.message})`); console.log('\n1 FAILED'); process.exit(1); }
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const rowsOf = (h) => h.split('<li class="sp-row').slice(1);
const rowFor = (h, name) => rowsOf(h).find((r) => text(r.split('sp-set')[0]).includes(name)) || '';
const G = D.games[0];
const LC = D.players.find((p) => p.name === 'Jackson LaCombe');
const tag = (p, s, lines) => { const q = lines ? { ...p, lines } : p; return C.propDisagreeTag('nhl', q, s, C.propView('nhl', D, G, q, s)); };

console.log('-- the read --');
ok(LC.lines.pts.l === 0.5 && LC.lines.pts.u === 71.1 && LC.lines.ast.l === 0.5 && LC.lines.ast.u === 55.55, "LaCombe, Nov 17: points Under 0.5 at 71.1, assists Under 0.5 at 55.55, both read at 04:00 UTC");
ok(D.players.filter((p) => p.lines && p.lines.pts && (p.lines.ast || p.lines.goals)).length === 1, 'the only player in his game priced on points and a part of it');

console.log('\n-- the tag --');
const t = tag(LC, 'pts');
console.log(`  ${t.trim()}`);
ok(/>books disagree<\/span>$/.test(t) && /class="tc-wait"/.test(t), 'his points row: "books disagree", in amber');
ok(/points Under 0\.5 at 71%/.test(t) && /assists Under 0\.5 at 56%/.test(t) && /Every assist is a point too/.test(t), 'on hover: both numbers, and why they cannot both be right');
ok(tag(LC, 'ast') === '', 'not on his assists row: the points row carries it, the one the owner asked about');
ok(D.players.filter((p) => p !== LC).every((p) => Object.keys(PROP_STATS_NHL()).every((s) => tag(p, s) === '')), 'no other row in the game: nothing to compare');
const at = (pts, part, s = 'ast') => tag(LC, 'pts', { pts: { ...LC.lines.pts, u: pts, fairs: [[0.5, pts]] }, [s]: { ...LC.lines.ast, u: part, fairs: [[0.5, part]] } });
ok(at(56.5, 55.55) === '' && at(56.6, 55.55) !== '', 'a point of slack: 56.5 against 55.55 says nothing, 56.6 does');
ok(at(48, 55.55) === '', 'a points Under below the assists Under, as it should be: nothing');
ok(/goals Under 0\.5 at 60%/.test(at(71.1, 60, 'goals')) && /Every goal is a point too/.test(at(71.1, 60, 'goals')), 'a goals Under counts the same');

console.log('\n-- on the card --');
const h = C.propsCardHtml('nhl');
const row = rowFor(h, 'Jackson LaCombe');
ok(/books disagree/.test(row) && /<span class="tc-p[^"]*">71%<\/span>/.test(row), 'his points row on the card: tagged, its 71% kept as read');
state.prStat = { nhl: 'ast' };
ok(!/books disagree/.test(rowFor(C.propsCardHtml('nhl'), 'Jackson LaCombe')), 'on Assists, his row says nothing');
state.prStat = { nhl: 'best' };
const best = rowFor(C.propsCardHtml('nhl'), 'Jackson LaCombe');
ok(/Under 0\.5 points/.test(text(best)) && /books disagree/.test(best), 'on Best, where his strongest number is the points one, the tag comes with it');
state.prStat = { nhl: 'pts' };
state.prLines = { [`nhl:${G.date}:${LC.k}:pts`]: 1.5 };
ok(!/books disagree/.test(rowFor(C.propsCardHtml('nhl'), 'Jackson LaCombe')), 'set at 1.5, where the books price neither: nothing to compare');
state.prLines = {};

console.log('\n-- the NBA card --');
ok(/const PROP_PARTS = \{ nhl: \{ pts: \['ast', 'goals'\] \} \};/.test(app), "the NHL's points only");

function PROP_STATS_NHL() { return { pts: 1, ast: 1, sog: 1, goals: 1, blocks: 1, hits: 1, saves: 1 }; }

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
