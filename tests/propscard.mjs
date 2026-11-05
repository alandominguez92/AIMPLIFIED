// The props card on the NBA tab, as the page draws it (2026-11-05).
//
// The owner uses the soccer card "basically comparing which stats are available and
// comparing them to what is being analyzed, One stat at a time", so this one opens on a
// stat, with the search right there. They chose the sharp books' chance at PrizePicks'
// number as the big figure. What has to hold:
//   - it opens on Points, not Best, with every stat a chip and the search above them
//   - a row reads who, against whom, the side and number, the sharp figure, the projection
//     and how often he cleared that number; sharp numbers first
//   - no sharp quote at that number: no percentage, nothing made up in its place
//   - a line changed on the row re-reads the figure where a sharp book quotes it, and
//     says what their line is where none does
//   - a row with no PrizePicks number can't be starred at the app's guess
//   - a starred leg carries what the row shows, and follows the row when it changes
//   - both sides can be taken; nothing is ever drawn from the model as a percentage
//
// Real data: the board the worker built from a real payload (tests/propsnba.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.join(HERE, '..');
const D = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'nba-props-board-20261105.json'), 'utf8'));
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
const state = { slip: {}, props: { nba: D } };
const persisted = [];
const persistSlip = () => persisted.push(1);
const renderSlip = () => {};
const CARD = ['LEG_OFFERS', 'offerLeg', 'pct0', 'r1', 'miniBar', 'projLineHtml', 'trendBarsHtml', 'soccerKick', 'shortDay', 'injuryTag', 'nbaCardInjTag',
  'nbaNick', 'NBA_CODE_NICK', 'NHL_CODE_NICK', 'legOppText', 'PROP_STATS', 'PROP_STRONG', 'propKey', 'propData', 'propVals', 'propView', 'propLeg', 'propFind', 'propSlipSync',
  'propSaveHtml', 'propRow', 'propsCardHtml'];
let C;
try {
  C = new Function('state', 'esc', 'persistSlip', 'renderSlip', CARD.map(lift).join('\n') + '\nreturn { propsCardHtml, propView, propLeg, propSlipSync, propKey, LEG_OFFERS };')(state, esc, persistSlip, renderSlip);
} catch (e) { console.log(`  FAIL  the card lifts out of app.js (${e.message})`); process.exit(1); }
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const rowsOf = (h) => h.split('<li class="sp-row').slice(1);
const rowFor = (h, name) => rowsOf(h).find((r) => text(r.split('sp-set')[0]).includes(name));
const G = D.games[0];
const P = (name) => D.players.find((p) => p.name === name);
const key = (name, s) => C.propKey('nba', G, P(name), s);
const card = () => C.propsCardHtml('nba');

console.log('\n-- it opens on a stat --');
let h = card();
ok(/sp-chip on"[^>]*data-stat="pts"/.test(h), 'on Points, not Best');
const chips = [...h.matchAll(/data-action="pr-stat"[^>]*data-stat="([a-z_0-9]+)"/g)].map((m) => m[1]);
ok(chips.length === 13 && chips[chips.length - 1] === 'best' && ['pts', 'reb', 'ast', 'pra', 'pts_reb', 'pts_ast', 'reb_ast', 'threes', 'blk', 'stl', 'blk_stl', 'tov'].every((s) => chips.includes(s)), `twelve stats, then Best: ${chips.join(' ')}`);
ok(h.indexOf('sp-search') < h.indexOf('sp-chips'), 'the search above them');
ok(/sharp books’ chance at PrizePicks’ exact number/.test(h) && /off Picks until 100/.test(h), 'it says what the number is, and that these stay off Picks');

console.log('\n-- a row --');
const rows = rowsOf(h);
ok(rows.length > 10, `${rows.length} rows on Points, the one game open`);
const black = text(rowFor(h, 'Anthony Black'));
ok(/Anthony Black ORL 56%/.test(black), `the side the sharp books favour, its chance: ${black.slice(0, 60)}`);
ok(/v Grizzlies · Over 15\.5 points/.test(black), 'who he plays, the side, the number, the stat');
ok(/proj 15\.7/.test(black) && /over 15\.5 in 3 of last 4/.test(black), 'the projection, and how often he cleared it, to read beside it');
ok(/sp-strong/.test(rowFor(h, 'Anthony Black')), 'teal at 54% and up');
ok(!/sp-strong/.test(rowFor(h, 'Franz Wagner')), 'and not at 51');
const firstThree = rows.slice(0, 3).map((r) => { const m = /tc-p[^>]*>(\d+)%/.exec(r); return m ? Number(m[1]) : null; });
ok(firstThree.every((x) => x != null) && firstThree[0] >= firstThree[1] && firstThree[1] >= firstThree[2], `strongest first: ${firstThree.join(', ')}`);
const lastRow = rows[rows.length - 1];
ok(!/tc-p/.test(lastRow), 'players with no figure last');

console.log('\n-- no sharp quote, no percentage --');
const cam = rowFor(h, 'Cam Spencer');
ok(!/class="tc-p/.test(cam), `Spencer at PrizePicks' 13, Pinnacle at 13.5: no percentage (${text(cam).slice(0, 70)})`);
ok(/Under 13 points/.test(text(cam)), 'the number is still there');
ok(/OUT|Out/.test(text(cam)), 'with ESPN\'s flag on him');
state.prOpen = { [key('Cam Spencer', 'pts')]: true };
ok(/No sharp price at 13: theirs is 13\.5/.test(text(rowFor(card(), 'Cam Spencer'))), 'tapped: it says where they are');
state.prLines = { [key('Cam Spencer', 'pts')]: 13.5 };
const camSet = text(rowFor(card(), 'Cam Spencer'));
ok(/Cam Spencer MEM 54%/.test(camSet) && /Sharp: Under 53\.5% · Over 46\.5%/.test(camSet), `set to 13.5: their figure there (${camSet.slice(0, 60)})`);
state.prLines = { [key('Cam Spencer', 'pts')]: 14 };
const camOff = rowFor(card(), 'Cam Spencer');
ok(!/class="tc-p/.test(camOff) && /No sharp price at 14: theirs is 13\.5/.test(text(camOff)), 'set to 14, where no one quotes him: no figure again');
state.prLines = {}; state.prOpen = {};

console.log('\n-- no PrizePicks number --');
const edey = rowFor(card(), 'Zach Edey');
ok(/no PrizePicks number yet/.test(text(edey)) && !/class="tc-p/.test(edey), `Edey, no read yet: says so, no percentage (${text(edey).slice(0, 70)})`);
ok(/data-action="pr-row"/.test(edey.split('tc-leg')[0]) && !/data-action="leg-add"/.test(edey), 'its star opens the line setter, and can\'t take the app\'s guess');
state.prLines = { [key('Zach Edey', 'pts')]: 9.5 };
const edeySet = rowFor(card(), 'Zach Edey');
ok(/data-action="leg-add"/.test(edeySet) && !/no PrizePicks number yet/.test(text(edeySet)), 'with PrizePicks\' number set, it can be starred');
state.prLines = {};
const rec = text(card());
ok(!/model/i.test(rec), 'the word "model" appears nowhere on it');

console.log('\n-- the other stats --');
state.prStat = { nba: 'pra' };
h = card();
ok(/Banchero ORL 52%/.test(text(rowFor(h, 'Paolo Banchero'))) && /Over 36\.5 PRA/.test(text(rowFor(h, 'Paolo Banchero'))), 'PRA: Banchero Over 36.5 at 52, the sharp books\' side');
ok(/proj 36\.6/.test(text(rowFor(h, 'Paolo Banchero'))), 'his projection there');
state.prStat = { nba: 'tov' };
h = card();
const tov = rowFor(h, 'Cameron Boozer');
ok(tov && !/class="tc-p/.test(tov) && /no PrizePicks number yet/.test(text(tov)) && /proj /.test(text(tov)), 'Turnovers, which no read has: the projection and his log, for a number set by hand');
state.prStat = { nba: 'best' };
h = card();
const best = rowsOf(h);
ok(best.length > 5 && best.every((r) => /class="tc-p/.test(r)), `Best: only rows with a sharp figure (${best.length})`);
ok(new Set(best.map((r) => /<b>([^<]+)<\/b>/.exec(r)[1])).size === best.length, 'one a player');
ok(/Cedric Coward/.test(best.map(text).slice(0, 3).join(' ')), `the strongest number near the top: ${text(best[0]).slice(0, 44)}`);
state.prQuery = { nba: 'zzz' };
ok(/No player matches “zzz”/.test(card()), 'a search that finds no one says so');
state.prQuery = { nba: 'banch' };
ok(rowsOf(card()).length >= 3 && rowsOf(card()).every((r) => /Paolo Banchero/.test(r)), 'Best and a search: that player\'s every sharp number');
state.prQuery = {}; state.prStat = {};

console.log('\n-- a star --');
const k = key('Anthony Black', 'pts');
const v = C.propView('nba', D, G, P('Anthony Black'), 'pts');
const leg = C.propLeg('nba', G, P('Anthony Black'), 'pts', v);
ok(leg.id === `prp:${k}` && leg.spec.sport === 'nba' && leg.spec.market === 'pts' && leg.spec.side === 'Over' && leg.spec.pp.line === 15.5 && leg.spec.pp.under === 43.9, 'the leg: Over 15.5, the sharp under behind it');
ok(leg.spec.gamePk === G.id && leg.spec.date === G.date && leg.spec.player === 'Anthony Black' && leg.spec.playerId === P('Anthony Black').id, 'graded by the day and player, keyed to the game as the moneylines are');
state.slip = { [leg.id]: leg };
ok(/aria-pressed="true"/.test(rowFor(card(), 'Anthony Black')), 'drawn on');
state.prSide = { [k]: 'Under' };
C.propSlipSync(k);
ok(state.slip[leg.id].spec.side === 'Under' && /Under 15\.5/.test(state.slip[leg.id].title), 'the other side taken: the slip follows');
ok(/tc-p[^>]*>44%/.test(rowFor(card(), 'Anthony Black')), 'and the row reads that side\'s chance, 44');
state.prLines = { [k]: 16 };
C.propSlipSync(k);
ok(state.slip[leg.id].spec.pp.line === 16 && state.slip[leg.id].spec.pp.under == null, 'a line changed: the slip has the new number, and no figure where no sharp book is');
ok(persisted.length >= 2, 'and it\'s kept');
state.prLines = {}; state.prSide = {}; state.slip = {};

console.log('\n-- tapped open --');
state.prOpen = { [k]: true };
h = rowFor(card(), 'Anthony Black');
ok(/data-prl="[^"]+"/.test(h) && /data-action="pr-line"[^>]*data-d="-0\.5"/.test(h) && /data-d="0\.5"/.test(h), 'the stepper and the box, in half points');
ok(/data-action="pr-side"[^>]*data-side="Under"/.test(h) && /pr-side on"[^>]*data-side="Over"/.test(h), 'both sides, the one taken lit');
ok(/Read Thu /.test(text(h)) && !/data-action="pr-save"/.test(h), 'PrizePicks\' number as read needs no saving: it says when it was read');
ok(/pk-trend/.test(h) && /over 15\.5 in 3 of last 4/.test(text(h)), 'his last games, against the line');
state.prOpen = {};

console.log('\n-- the record --');
const withRec = { ...D, record: { graded: 40, need: 100, bands: {}, byMarket: {}, at54: { n: 12, hit: 8 } } };
state.props = { nba: withRec };
const top = card();
ok(/Sharp 54%\+:/.test(top) && /8 of 12/.test(top) && /40 graded of 100/.test(top), 'what 54%+ has landed, and how near to the 100');
state.props = { nba: { ...D, games: [] } };
ok(/No games in the next day and a half/.test(card()), 'no games: it says so');
state.props = {};
ok(card() === '', 'not loaded: nothing');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
