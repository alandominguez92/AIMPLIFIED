// A player ESPN lists out leaves the props card's Strongest list (2026-11-13, the owner's "do both
// fixes").
//
// The phone check on Friday night found Klay Thompson at the top of the NBA card's "Strongest
// threes", Under 3.5 at 56%, with "expected starter" beside "Out: ankle soreness": ESPN had them
// out for Saturday, and the starter tag counted their last five starts (4 of 5). What has to hold:
//   - an out player is off the Strongest list, on a stat and on Best, and out of its count, the
//     stat button's and the game's
//   - in their game's own list they stay, flagged out, the number not drawn as a strong one
//   - "expected starter" (or "started n of last 5") doesn't show beside an out flag
//   - a player listed questionable (GTD) is not out: their tags and place stand
//
// Real data: production's /api/nba-props at 11:47 PM Pacific on Nov 13
// (tests/fixtures/nba-props-20261113-2347.json), drawn by the page's own functions.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.join(HERE, '..');
const D = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'nba-props-20261113-2347.json'), 'utf8'));
const NOW = Date.parse(D.at);
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
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const state = { slip: {}, props: { nba: D }, prStat: { nba: 'threes' }, prTopAll: { nba: true } };
const CARD = ['LEG_OFFERS', 'offerLeg', 'pct0', 'r1', 'miniBar', 'projLineHtml', 'trendBarsHtml', 'soccerKick', 'shortDay', 'INJ_ROLE_WORD', 'injRoleText', 'injuryTag', 'nbaCardInjTag',
  'nbaNick', 'nhlNick', 'NBA_CODE_NICK', 'NHL_CODE_NICK', 'NFL_CODE_NICK', 'legOppText', 'propStartTag', 'PROP_STATS', 'PROP_NOTE', 'propNick', 'propCodes', 'PROP_STRONG', 'PROP_TOP_N', 'propKey', 'propData', 'propVals', 'propView', 'propLeg', 'propFind', 'propSlipSync',
  'propSaveHtml', 'PROP_AGAINST', 'propAgainstTag', 'PROP_MIN_MOVE', 'propMinTag', 'propLateTag', 'propRow', 'spBarHtml', 'ptDayOf', 'PROP_GAME_HOURS', 'propDay', 'propDayName', 'propDayTitle', 'propDayWait', 'propKick', 'propsCardHtml'];
let C;
try {
  C = new Function('state', 'esc', 'persistSlip', 'renderSlip', CARD.map(lift).join('\n') + '\nreturn { propsCardHtml, propStartTag, PROP_STRONG };')(state, esc, () => {}, () => {});
} catch (e) { console.log(`  FAIL  the card lifts out of app.js (${e.message})`); process.exit(1); }
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const rowsOf = (h) => h.split('<li class="sp-row').slice(1);
const rowFor = (h, name) => rowsOf(h).find((r) => text(r.split('sp-set')[0]).includes(name));
// The Strongest list: between its heading and the day's games.
const topOf = (h) => h.slice(h.indexOf('data-anchor="top"'), h.indexOf('data-anchor="games"'));
// One game's list, by its id.
const gameOf = (h, id) => { const at = h.indexOf(`<div class="sp-match" data-mid="${id}"`); return at < 0 ? '' : h.slice(at, h.indexOf('<div class="sp-match"', at + 10) > 0 ? h.indexOf('<div class="sp-match"', at + 10) : h.length); };
const P = (name) => D.players.find((p) => p.name === name);

console.log('-- the real night --');
const klay = P('Klay Thompson'), heat = D.games[klay.g];
ok(klay.team === 'MIA' && klay.inj && klay.inj.out === true && klay.inj.status === 'OUT' && klay.inj.what === 'ankle soreness'
  && JSON.stringify(klay.st) === '[4,5]' && klay.lines.threes.l === 3.5 && klay.lines.threes.u === 55.5,
  'Klay Thompson: ESPN lists them out (ankle soreness), 4 of the last 5 started, Under 3.5 threes at 55.5% sharp');
ok(/Pistons/.test(heat.away) && /Heat/.test(heat.home) && P('Jalen Smith').inj.status === 'GTD' && !P('Jalen Smith').inj.out,
  'Pistons @ Heat on Saturday; Jalen Smith (CHI) listed questionable, not out');

console.log('\n-- Strongest threes --');
let h = C.propsCardHtml('nba');
const top = topOf(h);
ok(top.length > 0 && !rowFor(top, 'Klay Thompson'), 'Klay is off the Strongest threes list');
const topRows = rowsOf(top).length;
const badge = (top.match(/Strongest Threes<span class="sp-badge">(\d+) at 54%\+<\/span>/) || [])[1];
ok(badge != null && Number(badge) === topRows, `its count is the rows it lists (${badge}, ${topRows})`);
const chipN = (h.match(/data-stat="threes"[^>]*>Threes(?:<span class="sp-n">(\d+)<\/span>)?<\/button>/) || [])[1] || '0';
ok(Number(chipN) === topRows, `the Threes button counts the same (${chipN})`);

console.log('\n-- in his game --');
state.prMatch = { [heat.id]: true };
h = C.propsCardHtml('nba');
const game = gameOf(h, heat.id);
const row = rowFor(game, 'Klay Thompson');
ok(!!row && /Out: ankle soreness|ankle soreness/.test(text(row.split('sp-set')[0])), `still in the Pistons @ Heat list, flagged: "${row && text(row.split('sp-set')[0]).slice(0, 120)}"`);
ok(row && !/expected starter|started \d of last/.test(row), 'no "expected starter" beside the out flag');
ok(row && /<span class="tc-p">56%<\/span>/.test(row), 'their number shows, not drawn as a strong one');
const gBadge = (game.match(/<span class="sp-mc">\d+ players? <span class="sp-badge">(\d+) at 54%\+<\/span>/) || [])[1] || '0';
ok(Number(gBadge) === (game.match(/tc-p sp-strong/g) || []).length, `the game's own count leaves them out too (${gBadge})`);

console.log('\n-- Best --');
state.prStat = { nba: 'best' };
h = C.propsCardHtml('nba');
ok(!rowFor(topOf(h), 'Klay Thompson') && !rowFor(topOf(h), 'Pelle Larsson'), 'not on Strongest, any stat, either; nor Pelle Larsson, out with an illness');

console.log('\n-- the starter tag --');
ok(C.propStartTag('nba', klay) === '' && C.propStartTag('nba', P('Zach Edey')) === '', 'out: no starter tag for Klay (4 of 5) or Zach Edey (4 of 5)');
ok(/expected starter/.test(C.propStartTag('nba', P('Jalen Smith'))), 'questionable is not out: Jalen Smith (5 of 5) still "expected starter"');
ok(/expected starter/.test(C.propStartTag('nba', { ...klay, inj: undefined })), 'the same row with no report: "expected starter", as before');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
