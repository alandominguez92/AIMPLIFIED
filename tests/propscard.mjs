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
let CLOCK = null; // the day-of tests move the clock; everything else runs at NOW
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [CLOCK ?? NOW])); }
  static now() { return CLOCK ?? NOW; }
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
  'nbaNick', 'nhlNick', 'NBA_CODE_NICK', 'NHL_CODE_NICK', 'NFL_CODE_NICK', 'legOppText', 'propStartTag', 'PROP_STATS', 'PROP_NOTE', 'propNick', 'propCodes', 'PROP_STRONG', 'PROP_TOP_N', 'propKey', 'propData', 'propVals', 'propView', 'propLeg', 'propFind', 'propSlipSync',
  'propSaveHtml', 'PROP_AGAINST', 'propAgainstTag', 'PROP_MIN_MOVE', 'propMinTag', 'propLateTag', 'propRow', 'spBarHtml', 'ptDayOf', 'PROP_GAME_HOURS', 'propDay', 'propDayName', 'propDayTitle', 'propDayWait', 'propKick', 'propsCardHtml'];
let C;
try {
  C = new Function('state', 'esc', 'persistSlip', 'renderSlip', CARD.map(lift).join('\n') + '\nreturn { propsCardHtml, propView, propLeg, propSlipSync, propKey, propAgainstTag, LEG_OFFERS };')(state, esc, persistSlip, renderSlip);
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

console.log('\n-- the NHL card --');
const N = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'nhl-props-board-20261105.json'), 'utf8'));
state.props = { nhl: N };
state.prStat = {}; state.prLines = {}; state.prOpen = {}; state.prSide = {};
const NG = N.games[0], NP = (name) => N.players.find((p) => p.name === name);
const nkey = (name, s) => C.propKey('nhl', NG, NP(name), s);
const ncard = () => C.propsCardHtml('nhl');
let n = ncard();
ok(/sp-chip on"[^>]*data-stat="pts"/.test(n), 'it opens on Points');
const nchips = [...n.matchAll(/data-action="pr-stat"[^>]*data-stat="([a-z_0-9]+)"/g)].map((m) => m[1]);
ok(nchips.join() === 'pts,ast,sog,goals,blocks,hits,saves,best', `the stats in the order asked for: ${nchips.join()}`);
ok(/Canadiens @ Sabres/.test(text(n)), `the game by its nicknames: ${text(n).match(/[A-Za-z]+ @ [A-Za-z]+/)}`);
ok(/landed 54%, on few games/.test(n) && !/landed 57%/.test(n), 'the NHL\'s own replay in the note, not the NBA\'s');
const dem = text(rowFor(n, 'Ivan Demidov'));
ok(/@ Sabres · (Under|Over) 0\.5 points/.test(dem) && /Ivan Demidov MTL \d+%/.test(dem), `who he plays, the number, the figure: ${dem.slice(0, 70)}`);
ok(/v Canadiens/.test(text(rowFor(n, 'Tage Thompson'))), 'a Sabre at home plays the Canadiens');

state.prStat = { nhl: 'sog' };
n = ncard();
const tt = rowFor(n, 'Tage Thompson');
ok(/no PrizePicks number yet/.test(text(tt)) && !/class="tc-p/.test(tt), `shots with no number of PrizePicks': no percentage, and it says so (${text(tt).slice(0, 80)})`);
ok(/ 3\.5 shots on goal/.test(text(tt)), 'the setter stands at the sharp books\' main line');
ok(/data-action="pr-row"/.test(tt.split('tc-leg')[0]) && !/data-action="leg-add"/.test(tt), 'and its star opens the setter');
state.prOpen = { [nkey('Tage Thompson', 'sog')]: true };
const ttOpen = text(rowFor(ncard(), 'Tage Thompson'));
ok(/Sharp: Under 6[0-9.]+% · Over 3[0-9.]+%/.test(ttOpen), `open, their split is there to read: ${(ttOpen.match(/Sharp: [^ ]+ [^ ]+ · [^ ]+ [^ ]+/) || [])[0]}`);
state.prLines = { [nkey('Tage Thompson', 'sog')]: 3.5 };
const ttSet = rowFor(ncard(), 'Tage Thompson');
ok(/class="tc-p/.test(ttSet) && /Tage Thompson BUF 6\d%/.test(text(ttSet)) && /data-action="leg-add"/.test(ttSet), `set to 3.5: the figure, the side, and a star that takes it (${text(ttSet).slice(0, 60)})`);
state.prLines = { [nkey('Tage Thompson', 'sog')]: 4 };
const ttOff = rowFor(ncard(), 'Tage Thompson');
ok(!/class="tc-p/.test(ttOff), 'set where no sharp book quotes him: no figure');
state.prLines = {}; state.prOpen = {};

state.prStat = { nhl: 'saves' };
n = ncard();
ok(/Colten Ellis BUF \d+%/.test(text(rowFor(n, 'Colten Ellis'))) && /23\.5 saves/.test(text(rowFor(n, 'Colten Ellis'))), `goalies on saves, at 23.5: ${text(rowFor(n, 'Colten Ellis')).slice(0, 70)}`);
ok(!rowFor(n, 'Tage Thompson'), 'and no skater');
state.prStat = { nhl: 'goals' };
n = ncard();
const goalsRow = rowFor(n, 'Tage Thompson');
ok(goalsRow && !/class="tc-p/.test(goalsRow) && /proj /.test(text(goalsRow)), 'goals, which no read has: the projection and his log, no percentage');
ok(!rowFor(n, 'Colten Ellis'), 'and no goalie');
state.prOpen = { [nkey('Tage Thompson', 'goals')]: true };
ok(/No sharp price here/.test(text(rowFor(ncard(), 'Tage Thompson'))), 'tapped: it says there\'s none');
state.prOpen = {};
state.prStat = { nhl: 'hits' };
const hitsRow = rowFor(ncard(), 'Tage Thompson');
ok(!hitsRow || !/in \d+ of last \d\d/.test(text(hitsRow)), 'hits count only the games that have them');
state.prStat = { nhl: 'best' };
n = ncard();
ok(rowsOf(n).every((r) => /class="tc-p/.test(r)), 'Best lists only rows with a figure at PrizePicks\' number');
ok(!rowFor(n, 'Tage Thompson') || !/shots on goal/.test(text(rowFor(n, 'Tage Thompson'))), 'so not a shots row with no number set');
const sogLeg = C.propLeg('nhl', NG, NP('Tage Thompson'), 'sog', C.propView('nhl', N, NG, NP('Tage Thompson'), 'sog'));
ok(sogLeg.spec.sport === 'nhl' && sogLeg.spec.market === 'sog' && sogLeg.spec.playerId === NP('Tage Thompson').id, 'a leg carries the sport, the stat and his NHL id, which is how it grades');
state.prStat = {};

console.log('\n-- the NFL card --');
const NF = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'nfl-props-board-20261105.json'), 'utf8'));
state.props = { nfl: NF };
state.prStat = {}; state.prLines = {}; state.prOpen = {}; state.prSide = {};
const FG = NF.games[0], FP = (name) => NF.players.find((p) => p.name === name);
const fkey = (name, s) => C.propKey('nfl', FG, FP(name), s);
const fcard = () => C.propsCardHtml('nfl');
let f = fcard();
// It opens on the stat with the most 54%+ numbers (2026-11-06, the owner's pick): on this board,
// three days out, Passing yards has no PrizePicks number and Rush yards has the one 54%+.
ok(/sp-chip on"[^>]*data-stat="rush_yds"/.test(f) && /data-stat="rush_yds"[^>]*>Rush yards<span class="sp-n">1<\/span>/.test(f), 'it opens on Rush yards, the stat with the 54%+ number, not an empty Passing yards');
state.prStat = { nfl: 'pass_yds' };
f = fcard();
ok(/sp-chip on"[^>]*data-stat="pass_yds"/.test(f), 'a stat picked stays picked');
const fchips = [...f.matchAll(/data-action="pr-stat"[^>]*data-stat="([a-z_0-9]+)"/g)].map((m) => m[1]);
ok(fchips.join() === 'pass_yds,rec_yds,rush_yds,rec,rush_rec,pass_td,best', `the stats in the order asked for: ${fchips.join()}`);
ok(/Commanders @ Dolphins/.test(text(f)), `the game by its nicknames: ${text(f).match(/[A-Za-z]+ @ [A-Za-z]+/)}`);
ok(/landed 56% on receiving/.test(f) && !/landed 57%/.test(f), 'the NFL\'s own replay in the note');
ok(/from the site’s NFL reads/.test(f) && !/hours before each game/.test(f), 'it says where the numbers come from, with no read time of its own');
const willis = rowFor(f, 'Malik Willis');
ok(willis && /Malik Willis MIA/.test(text(willis)) && /v Commanders/.test(text(willis)) && /181\.1/.test(text(willis)), `a quarterback, whom he plays and his projection: ${text(willis || '').slice(0, 80)}`);
ok(/no PrizePicks number yet/.test(text(willis)) && !/class="tc-p/.test(willis), 'before passing yards come in: no number, no percentage, and it says so');
ok(!rowFor(f, 'Malik Washington'), 'a receiver isn\'t on passing yards');

state.prStat = { nfl: 'rec_yds' };
f = fcard();
const wash = rowFor(f, 'Malik Washington');
ok(/Malik Washington MIA \d+%/.test(text(wash)) && /v Commanders · (Under|Over) 29\.5 receiving yards/.test(text(wash)), `receiving yards with the figure at his number: ${text(wash).slice(0, 80)}`);
ok(!rowFor(f, 'Malik Willis'), 'a quarterback isn\'t');
const line0 = rowFor(f, 'Jaylen Waddle');
ok(line0 && /78\.5 receiving yards/.test(text(line0)) && !/undefined|null/.test(text(line0)), `a player with a number and no game this season reads clean: ${text(line0).slice(0, 80)}`);

state.prStat = { nfl: 'rec' };
f = fcard();
ok(/(Under|Over) 2\.5 catches/.test(text(rowFor(f, 'Greg Dulcich'))), 'catches, under what the site calls them');
const ertz = rowFor(f, 'Zach Ertz');
ok(ertz && / 4 catches/.test(text(ertz)) && !/class="tc-p/.test(ertz), 'PrizePicks at 4, which no sharp book quotes: the number, no percentage');
state.prOpen = { [fkey('Zach Ertz', 'rec')]: true };
ok(/No sharp price at 4: theirs is/.test(text(rowFor(fcard(), 'Zach Ertz'))), 'tapped: it says what the sharp books do quote');
state.prOpen = {};
const mar = rowFor(f, 'Marcus Mariota');
ok(!mar, 'a quarterback isn\'t on catches');

state.prStat = { nfl: 'rush_rec' };
f = fcard();
const ach = rowFor(f, 'De\'Von Achane');
ok(ach && /93\.8/.test(text(ach)) && !/class="tc-p/.test(ach), `Rush + Rec: his two projections added, no percentage (${text(ach || '').slice(0, 80)})`);
ok(/data-action="pr-row"/.test(ach.split('tc-leg')[0]) && !/data-action="leg-add"/.test(ach), 'with no number its star opens the setter');
state.prLines = { [fkey('De\'Von Achane', 'rush_rec')]: 110.5 };
const achSet = rowFor(fcard(), 'De\'Von Achane');
ok(/110\.5 rush \+ rec yards/.test(text(achSet)) && !/class="tc-p/.test(achSet) && /data-action="leg-add"/.test(achSet), `set by hand: the star takes it, still no made-up figure (${text(achSet).slice(0, 80)})`);
state.prLines = {};

state.prStat = { nfl: 'best' };
f = fcard();
ok(rowsOf(f).length > 0 && rowsOf(f).every((r) => /class="tc-p/.test(r)), 'Best lists only rows with a figure at PrizePicks\' number');
const recLeg = C.propLeg('nfl', FG, FP('Malik Washington'), 'rec_yds', C.propView('nfl', NF, FG, FP('Malik Washington'), 'rec_yds'));
ok(recLeg.spec.sport === 'nfl' && recLeg.spec.market === 'rec_yds' && recLeg.spec.playerId === FP('Malik Washington').id && recLeg.spec.gamePk === FG.id, 'a leg carries the sport, the stat, his ESPN id and the odds feed\'s game, which is how it grades');
state.prStat = {};

console.log('\n-- before PrizePicks posts --');
// The owner asked for picks ahead of time, as the soccer card's expected rows, and chose a side with
// no percentage (2026-11-05): against the sharp books' line, else PrizePicks' last number for him;
// with neither, the projection alone. Starters marked; a player who's been missing says so.
const bare = D.players.find((p) => !Object.keys(p.lines).length && p.proj.pts > 10);
const early = { ...bare, last: { pts: [21.5, '2026-11-03'] }, st: [5, 5] };
state.props = { nba: { ...D, players: [early, ...D.players.filter((p) => p !== bare)] } };
state.prStat = { nba: 'pts' };
const er = rowFor(C.propsCardHtml('nba'), bare.name);
const wantSide = bare.proj.pts > 21.5 ? 'Over' : 'Under';
ok(new RegExp(`${wantSide} 21\\.5 points`).test(text(er)) && /PrizePicks’ last, Nov 3/.test(text(er)), `PrizePicks' last number, the side his projection ${bare.proj.pts} takes: ${text(er).slice(0, 110)}`);
ok(!/class="tc-p/.test(er) && /cushion|short of|right on/.test(text(er)) && /in \d+ of last \d+/.test(text(er)), 'no percentage; how far off and how often he cleared it');
ok(/data-action="pr-row"/.test(er.split('tc-leg')[0]) && !/data-action="leg-add"/.test(er), 'its star opens the setter, at that number: not taken for this game\'s');
ok(/expected starter/.test(text(er)) && /title="Started 5 of his team’s last 5"/.test(er), 'started 5 of the last 5: an expected starter');
state.props = { nba: { ...D, players: [{ ...early, st: [0, 5] }, ...D.players.filter((p) => p !== bare)] } };
ok(!/expected starter|played \d/.test(text(rowFor(C.propsCardHtml('nba'), bare.name))), 'off the bench: no tag');
state.props = { nba: { ...D, players: [{ ...bare, st: [5, 5] }, ...D.players.filter((p) => p !== bare)] } };
const none = text(rowFor(C.propsCardHtml('nba'), bare.name));
ok(!/(Over|Under) \d/.test(none) && /no PrizePicks number yet/.test(none) && new RegExp(`proj ${bare.proj.pts}`).test(none), `no line of any kind: no side, the projection: ${none.slice(0, 100)}`);
ok(/the side is the projection against the books’ line or PrizePicks’ last number for him/.test(C.propsCardHtml('nba')), 'the note says so');
state.props = { nhl: { ...N, record: { ...N.record, graded: 130, need: 100 } } };
state.prStat = { nhl: 'sog' };
const tts = rowFor(C.propsCardHtml('nhl'), 'Tage Thompson');
const ttSide = NP('Tage Thompson').proj.sog > 3.5 ? 'Over' : 'Under';
ok(new RegExp(`${ttSide} 3\\.5 shots on goal`).test(text(tts)) && /books’ line · no PrizePicks number yet/.test(text(tts)) && !/class="tc-p/.test(tts),
  `the sharp books' line: the side his projection takes, not theirs (${text(tts).slice(0, 90)})`);
ok(/130 have graded: they join Picks only when you say/.test(C.propsCardHtml('nhl')), 'past the 100: the note says it is the owner\'s call');
state.props = { nhl: { ...N, players: N.players.map((p) => (p.name === 'Colten Ellis' ? { ...p, gl: 'Confirmed' } : p.name === 'Tage Thompson' ? { ...p, st: [2, 5] } : p)) } };
state.prStat = { nhl: 'saves' };
ok(/confirmed starter/.test(text(rowFor(C.propsCardHtml('nhl'), 'Colten Ellis'))), 'ESPN\'s confirmed goalie says so');
state.prStat = { nhl: 'sog' };
ok(/played 2 of last 5/.test(text(rowFor(C.propsCardHtml('nhl'), 'Tage Thompson'))), 'a skater who\'s missed games says so');
state.props = { nfl: { ...NF, players: NF.players.map((p) => (p.name === 'Malik Willis' ? { ...p, qb1: true, st: [5, 5] } : p)) } };
state.prStat = { nfl: 'pass_yds' };
const wq = text(rowFor(C.propsCardHtml('nfl'), 'Malik Willis'));
ok(/expected starter/.test(wq) && !/(Over|Under) \d/.test(wq), `the passer to expect, and with no line yet no side: ${wq.slice(0, 90)}`);
state.prStat = {};

console.log('\n-- on a phone --');
// The owner's phone check (2026-11-05): the note folded behind a tap, the header past the 100
// without "of 100", an NBA player in and out of the lineup tagged as NHL's and NFL's are, and no
// number split from its word at the end of a line.
state.props = { nba: D };
let ph = C.propsCardHtml('nba');
ok(/<button type="button" class="pr-how" data-action="pr-how" data-sport="nba" aria-expanded="false">How to read this ▸<\/button><div class="tc-sub" hidden>The percentage/.test(ph), 'the note folded: a tap opens it');
state.prHow = { nba: true };
ok(/aria-expanded="true">How to read this ▾<\/button><div class="tc-sub">The percentage/.test(C.propsCardHtml('nba')), 'and open once tapped');
state.prHow = {};
state.props = { nhl: { ...N, record: { ...N.record, graded: 130, need: 100 } } };
ok(/· 130 graded<\/span>/.test(C.propsCardHtml('nhl')), 'past the 100: "130 graded", not "130 graded of 100"');
state.props = { nba: { ...D, players: [{ ...early, st: [3, 5] }, ...D.players.filter((p) => p !== bare)] } };
state.prStat = { nba: 'pts' };
const inOut = rowFor(C.propsCardHtml('nba'), bare.name);
ok(/started 3 of last 5/.test(text(inOut)) && /class="tc-wait" title="Started 3 of his team’s last 5"/.test(inOut), 'started 3 of the last 5: says so, as NHL and NFL do');
ok(/<span class="bw-cush dots"><span class="dots-in"><span>proj <b>[\d.]+<\/b><\/span> <span><span class="dot">·<\/span> line 21\.5<\/span> <span><span class="dot">·<\/span> <b class="[uo]">[\d.]+ (cushion|short of the line|over the line)<\/b><\/span>/.test(inOut),
  'the projection line in bits that wrap whole: the cushion stays with its number');
state.props = { nba: { ...D, players: [{ ...early, st: [0, 5] }, ...D.players.filter((p) => p !== bare)] } };
ok(!/started \d/.test(text(rowFor(C.propsCardHtml('nba'), bare.name))), 'off the bench, still no tag');
state.props = { nba: { ...D, players: [{ ...bare, st: [5, 5] }, ...D.players.filter((p) => p !== bare)] } };
ok(/<span class="pr-clear dots"><span class="dots-in"><span>proj <b>[\d.]+<\/b><\/span> <span><span class="dot">·<\/span> avg [\d.]+ in last \d+<\/span>/.test(rowFor(C.propsCardHtml('nba'), bare.name)),
  'no number yet: "avg 23.4 in last 8", one bit, no number alone on a line');
// The stats as buttons (2026-11-05, the owner's picks): each says how many 54%+ numbers it has,
// counted here from the recorded lines -- PrizePicks' number and the sharp books' chance at it.
state.props = { nba: D };
const fairAt = (ln) => (ln && ln.l != null ? (ln.u != null ? ln.u : ((ln.fairs || []).find((f) => f[0] === ln.l) || [])[1]) : null);
const wantN = {};
let wantBest = 0;
for (const pl of D.players.filter((x) => Date.parse(D.games[x.g].commence) > NOW)) {
  let any = false;
  for (const s of Object.keys(pl.lines)) { const f = fairAt(pl.lines[s]); if (f != null && Math.max(f, 100 - f) >= 54) { wantN[s] = (wantN[s] || 0) + 1; any = true; } }
  if (any) wantBest++;
}
const chipsOf = (h) => Object.fromEntries([...h.matchAll(/data-stat="(\w+)"[^>]*>[^<]*(?:<span class="sp-n">(\d+)<\/span>)?<\/button>/g)].map((m) => [m[1], Number(m[2] || 0)]));
const got = chipsOf(card());
console.log('  ' + Object.entries(got).map(([s, n]) => `${s} ${n}`).join(' · '));
ok(wantBest > 0 && Object.keys(got).length === 13 && Object.keys(got).every((s) => got[s] === (s === 'best' ? wantBest : wantN[s] || 0)),
  `each stat's 54%+ count, and Best's players with any: ${wantBest} (${JSON.stringify(wantN)})`);
ok(Object.keys(wantN).every((s) => new RegExp(`data-stat="${s}"[^>]*aria-label="[^"]+, ${wantN[s]} at 54%\\+"`).test(card())), 'and says so to a screen reader');
ok(!/<span class="sp-n">0<\/span>/.test(card()) && Object.keys(got).some((s) => !got[s]), 'a stat with none shows no number');
const css = fs.readFileSync(path.join(HERE, '..', 'style.css'), 'utf8');
ok(/\.sp-chips \{ display:flex; flex-wrap:wrap;/.test(css) && !/\.sp-chips \{[^}]*overflow-x:auto/.test(css), 'they wrap into rows: no row scrolling sideways, every stat in sight on a phone');
state.props = { nba: D };
state.prOpen = { [k]: true };
ok(/<span class="tb-head dots"><span class="dots-in"><span><b class="[uo]">over 15\.5 in 3 of last 4<\/b><\/span> <span><span class="dot">·<\/span> avg [\d.]+<\/span>/.test(rowFor(card(), 'Anthony Black')),
  'his last games: the average its own bit, its dot never starting a line');
state.prOpen = {}; state.prStat = {};

console.log('\n-- the strongest above the games, each game a bar to tap (2026-11-06) --');
// The owner: "It doesn't seem like you can select any of these", of the games folded one line each.
// They chose the stat's 54%+ players from every game above the games, and each game a shaded bar
// with an arrow. The recorded board has one game; its Grizzlies go to a second game an hour later
// so the list has two to draw from. Their lines and chances are the recorded ones.
const G2 = { ...D.games[0], id: `${D.games[0].id}-2`, commence: new RealDate(Date.parse(D.games[0].commence) + 3600e3).toISOString() };
const D2 = { ...D, games: [D.games[0], G2], players: D.players.map((p) => (p.team === 'MEM' ? { ...p, g: 1 } : p)) };
const ALL_GAMES = '<div class="sp-sec" data-anchor="games">Today’s games</div>';
const secOf = (h) => (h.includes(ALL_GAMES) ? h.slice(h.indexOf('<div class="sp-sec" data-anchor="top">'), h.indexOf(ALL_GAMES)) : '');
ok(!/sp-sec/.test(card()), 'one game, open already: no list above it');
state.props = { nba: D2 };
h = card();
let sec = secOf(h);
const strongRows = rowsOf(sec);
const ptsWant = D2.players.filter((p) => { const f = fairAt(p.lines.pts); return f != null && Math.max(f, 100 - f) >= 54; }).map((p) => p.name).sort();
console.log(`  Points at 54%+: ${ptsWant.join(', ')}`);
ok(ptsWant.length >= 1 && /Strongest Points<span class="sp-badge">\d+ at 54%\+<\/span>/.test(sec) && sec.includes(`${ptsWant.length} at 54%+`), `two games: "Strongest Points", ${ptsWant.length} at 54%+`);
ok(strongRows.length === ptsWant.length && strongRows.map((r) => /<b>([^<]+)<\/b>/.exec(r)[1]).sort().join() === ptsWant.join(), 'its rows are those players, before any game is opened');
ok(h.indexOf('sp-sec') > h.indexOf('sp-chips') && h.indexOf('Today’s games') < h.indexOf('class="sp-match"'), 'under the stat buttons, above the games');
ok((h.match(/class="sp-mh"[^>]*aria-expanded="false"/g) || []).length === 2, 'the games stay folded');
state.prStat = { nba: 'best' };
sec = secOf(card());
const bestNames = rowsOf(sec).map((r) => /<b>([^<]+)<\/b>/.exec(r)[1]);
const pctOf = (r) => Number((/tc-p[^>]*>(\d+)%/.exec(r) || [])[1]);
ok(/Strongest, any stat<span class="sp-badge">/.test(sec) && bestNames.length === wantBest && new Set(bestNames).size === bestNames.length, `Best: each player once, at his strongest (${bestNames.join(', ')})`);
const teamOf = (name) => (D2.players.find((p) => p.name === name) || {}).team;
ok(bestNames.some((x) => teamOf(x) === 'ORL') && bestNames.some((x) => teamOf(x) === 'MEM'), 'from both games');
ok(rowsOf(sec).every((r, i, a) => pctOf(r) >= 54 && (!i || pctOf(a[i - 1]) >= pctOf(r))), `strongest first: ${rowsOf(sec).map(pctOf).join(', ')}`);
const C2 = new Function('state', 'esc', 'persistSlip', 'renderSlip', CARD.map((x) => (x === 'PROP_TOP_N' ? 'const PROP_TOP_N = 2;' : lift(x))).join('\n') + '\nreturn { propsCardHtml };')(state, esc, persistSlip, renderSlip);
const two = secOf(C2.propsCardHtml('nba'));
ok(rowsOf(two).length === 2 && new RegExp(`data-action="pr-top-all"[^>]*>All ${wantBest}</button>`).test(two), `past its first few, an "All ${wantBest}" button`);
state.prTopAll = { nba: true };
ok(rowsOf(secOf(C2.propsCardHtml('nba'))).length === wantBest && !/pr-top-all/.test(C2.propsCardHtml('nba')), 'tapped: every one');
state.prTopAll = {};
state.prStat = { nba: 'tov' };
ok(/<span class="sp-badge">0 at 54%\+<\/span>/.test(card()) && /No Turnovers number at 54%\+ right now\./.test(card()), 'a stat with none says so');
state.prStat = {};
state.prQuery = { nba: 'black' };
ok(!/sp-sec/.test(card()), 'a search lists its players in place');
state.prQuery = {};
const bar = (card().match(/<button type="button" class="sp-mh"[\s\S]*?<\/button>/) || [''])[0];
ok(/<span class="sp-chev" aria-hidden="true"><\/span><\/button>$/.test(bar) && !/[▸▾]/.test(bar), 'each game: an arrow in a ring, not a small ▸ in the text');
ok(/<span class="sp-badge">\d+ at 54%\+<\/span>/.test(card().split('class="sp-match"').slice(1).join('')), 'its 54%+ count a badge');
ok(/\.sp-mh \{[^}]*background:color-mix[^}]*border:1px solid var\(--border\); border-radius:10px;/.test(css) && /\.sp-mh\[aria-expanded="true"\] \.sp-chev::before \{[^}]*rotate\(45deg\)/.test(css),
  'a shaded bar with a border, its arrow turning down when open');
ok(/\.sp-chip \{[^}]*background:color-mix/.test(css), 'and the stat buttons filled, to read as buttons');
state.props = { nba: D };

console.log('\n-- the projection the other way (2026-11-06) --');
// The owner asked why a row reads Under when his projection is over the line. Last season's NBA
// replay at 54%+: the projection's side lost where they split (44%), but with it 15% or more the
// other way the sharp side landed only half on points (50 of 100). They asked for a caution tag.
// No recorded NBA row is 54%+ with the projection that far the other way, so Franz Wagner's
// recorded 51.1% Under 16.5 points goes to 58 on a copy; his projection (20.1) is the recorded one.
const fw = D.players.find((p) => p.name === 'Franz Wagner');
const DW = { ...D, players: D.players.map((p) => (p === fw ? { ...p, lines: { ...p.lines, pts: { ...p.lines.pts, u: 58, fairs: p.lines.pts.fairs.map((f) => (f[0] === 16.5 ? [16.5, 58] : f)) } } } : p)) };
state.props = { nba: DW }; state.prStat = {};
const fwRow = rowFor(card(), 'Franz Wagner');
ok(/Franz Wagner ORL 58%/.test(text(fwRow)) && /Under 16\.5 points/.test(text(fwRow)) && /proj 20\.1/.test(text(fwRow)), `the sharp side and its chance stay: ${text(fwRow).slice(0, 70)}`);
ok(/<span class="tc-wait" title="His projection says Over, 15% or more from the line">projection disagrees<\/span>/.test(fwRow), 'with the caution tag: his projection says Over, 22% from the line');
ok(!/projection disagrees/.test(rowFor(card(), 'Anthony Black')), 'not where they agree (Black, Over 15.5, projection 15.7)');
state.prStat = { nba: 'pts_reb' };
ok(!/projection disagrees/.test(rowFor(card(), 'Cedric Coward')), 'nor a hair the other way (Coward, Under 20.5 at 55.5, projection 20.8)');
state.prStat = {};
state.prSide = { [C.propKey('nba', G, fw, 'pts')]: 'Over' };
ok(!/projection disagrees/.test(rowFor(card(), 'Franz Wagner')), 'Over taken by hand, with his projection: no tag');
state.prSide = {};
state.props = { nba: D };
ok(!/projection disagrees/.test(rowFor(card(), 'Franz Wagner')), 'at the recorded 51%, under 54: no tag');
const vx = { p: 60, side: 'Under', line: 20, proj: 23.5 };
ok(/projection disagrees/.test(C.propAgainstTag('nba', vx)) && !C.propAgainstTag('nba', { ...vx, proj: 22.5 }), '15% of the line: 23.5 against 20 tags (17.5%), 22.5 does not (12.5%)');
ok(!C.propAgainstTag('nfl', vx) && !C.propAgainstTag('nhl', vx), 'NBA only: NFL\'s sharp side held up there (35 of 63), the NHL had too few');
ok(/“Projection disagrees”: his projection is 15% or more the other way\. Last season those landed 52% \(119 of 229\), below what an entry needs\./.test(card()), 'How to read this says what the tag means, and what it landed (replayed on the minutes projection)');

console.log('\n-- read before a teammate was ruled out (2026-11-06) --');
// The worker puts on a row's line the rotation players ESPN first listed out after its sharp price
// was read (tests/propsnba.mjs). Here, Anthony Black's recorded Over 15.5 points (56.1%) on a copy,
// with Franz Wagner named.
const ab = D.players.find((p) => p.name === 'Anthony Black');
const withLate = (late, ln = {}) => ({ ...D, players: D.players.map((p) => (p === ab ? { ...p, lines: { ...p.lines, pts: { ...p.lines.pts, late, ...ln } } } : p)) });
state.props = { nba: withLate(['Franz Wagner']) }; state.prStat = {};
let abRow = rowFor(card(), 'Anthony Black');
ok(/Anthony Black ORL 56%/.test(text(abRow)) && /read before Franz Wagner was ruled out/.test(text(abRow)), `the row keeps its number and says so: ${text(abRow).slice(0, 90)}`);
ok(/<span class="tc-wait" title="This price was read [^"]+, before ESPN listed Franz Wagner out\. The books have most likely moved since: check the line before you use this number\.">/.test(abRow), 'its title says when it was read and what to do');
ok(abRow.indexOf('read before') < abRow.indexOf('pr-clear'), 'on the side line, beside the other tags');
state.props = { nba: withLate(['Franz Wagner', 'Desmond Bane']) };
ok(/read before Franz Wagner and Desmond Bane were ruled out/.test(text(rowFor(card(), 'Anthony Black'))), 'two: both, "were"');
state.props = { nba: withLate(['Franz Wagner', 'Desmond Bane', 'Paolo Banchero']) };
abRow = rowFor(card(), 'Anthony Black');
ok(/read before Franz Wagner, Desmond Bane \+1 were ruled out/.test(text(abRow)) && /listed Franz Wagner, Desmond Bane, Paolo Banchero out/.test(abRow), 'three: two and a count, all three in the title');
state.props = { nba: withLate(['Franz Wagner'], { u: null, fairs: [] }) };
ok(!/read before/.test(rowFor(card(), 'Anthony Black')), 'no percentage on the row: nothing to doubt, no tag');
state.props = { nba: D };
ok(!/read before/.test(card()), 'the recorded board, with no one ruled out late: none');
ok(/“Read before … ruled out”: a teammate was ruled out after this price was read, so the books have likely moved\. Check the line before you use it\./.test(card()), 'How to read this says what it means');

console.log('\n-- minutes moving (2026-11-07) --');
// The owner: "we need to adjust to what's happening specially in minutes". The worker projects his
// rate a minute times his last five games' minutes and sends his usual minutes beside them (mw,
// tests/propsnba.mjs); the row says so when the two are 4 or more apart. Anthony Black on a copy.
const withMin = (min, mw) => ({ ...D, players: D.players.map((p) => (p === ab ? { ...p, min, ...(mw === undefined ? {} : { mw }) } : p)) });
state.props = { nba: withMin(31.4, 26.2) };
abRow = rowFor(card(), 'Anthony Black');
ok(/playing more: 31\.4 min, usually 26\.2/.test(text(abRow)) && abRow.indexOf('playing more') < abRow.indexOf('pr-clear'), `5.2 more: said, beside the other tags: ${text(abRow).slice(0, 110)}`);
ok(/title="More minutes over his last five games \(31\.4\) than usual \(26\.2\)\. The projection uses the last five\."/.test(abRow), 'its title says what the two numbers are');
state.props = { nba: withMin(20.1, 26.2) };
ok(/playing less: 20\.1 min, usually 26\.2/.test(text(rowFor(card(), 'Anthony Black'))), '6.1 fewer: "playing less"');
state.props = { nba: withMin(29.9, 26.2) };
ok(!/playing (more|less)/.test(rowFor(card(), 'Anthony Black')), '3.7 apart: nothing');
state.props = { nba: withMin(31.4) };
ok(!/playing (more|less)/.test(rowFor(card(), 'Anthony Black')), 'no usual minutes sent (a board from before): nothing');
state.props = { nba: D };
ok(/The projection is his rate a minute times his minutes over his last five games; “playing more” or “playing less” means those minutes are 4 or more off his usual\./.test(card()), 'How to read this says how the projection is made');

console.log('\n-- the stat bar that stays under the tabs (2026-11-06) --');
// The owner: keep the stats in reach while scrolling the games, gone once past them. They chose a
// slim bar with the phone's own list over pinning all the buttons (five rows on a phone). The page
// shows it once the buttons have scrolled away (spStickSync, checked in the browser); here, what it
// draws and what the page reads to keep the reader's place on a switch.
state.props = { nba: D2 }; state.prStat = {}; state.spBarOn = {};
h = card();
const sbar = (h.match(/<div class="sp-stick[^"]*">[\s\S]*?<\/select><\/span><\/div><\/div>/) || [''])[0];
const opts = [...sbar.matchAll(/<option value="(\w+)"( selected)?>([^<]+)<\/option>/g)].map((m) => ({ v: m[1], sel: !!m[2], t: m[3] }));
console.log('  ' + opts.map((o) => `${o.t}${o.sel ? '*' : ''}`).join(' | '));
ok(/^<div class="sp-stick">/.test(sbar) && h.indexOf('sp-stick') > h.indexOf('sp-chips') && h.indexOf('sp-stick') < h.indexOf('data-anchor="top"'), 'under the buttons, above the lists, hidden until the page shows it');
ok(opts.length === 13 && opts.map((o) => o.v).join() === [...chips].join() && opts.filter((o) => o.sel).map((o) => o.v).join() === 'pts', 'every stat and Best, in the buttons\' order, the one showing picked');
ok(opts.find((o) => o.v === 'pts').t === 'Points · 1' && opts.find((o) => o.v === 'tov').t === 'Turnovers' && opts.find((o) => o.v === 'best').t === `Best · ${wantBest}`, 'each with its 54%+ count, none where there is none');
ok(/<span class="sp-bar-v">Points · <b>1<\/b> at 54%\+<\/span>/.test(sbar) && /data-spsel="nba"/.test(sbar), 'the bar reads "Points · 1 at 54%+", its list keyed to the NBA card');
state.prStat = { nba: 'reb_ast' };
ok(/<option value="reb_ast" selected>/.test(card()) && /<span class="sp-bar-v">Reb \+ Ast/.test(card()), 'a stat picked: the bar says so');
state.prStat = {};
state.spBarOn = { nba: true };
ok(/<div class="sp-stick on">/.test(card()), 'redrawn while showing, it stays showing');
state.spBarOn = {};
// The same bar on every sport at every width (2026-11-08, the owner: "keep it similar"). Until then a
// wide window pinned the buttons wherever they fit on one row: NBA's did, soccer's longer names wrapped.
ok(!/sp-one|spOne/.test(app) && !/sp-one/.test(css) && /const on = chips\.getBoundingClientRect\(\)\.bottom < top && card\.getBoundingClientRect\(\)\.bottom > top \+ 60;/.test(app),
  'no one-row exception: the bar shows on every sport once the buttons scroll away, however wide the window');
ok((h.match(/class="sp-match" data-mid="[^"]+"/g) || []).length === 2 && /data-anchor="top"/.test(h) && /data-anchor="games"/.test(h), 'each game and both headings marked, to keep the place on a switch');
ok(/\.sp-stick \{ position:sticky; top:calc\(var\(--hdrH\) \+ var\(--sportsH\)\); height:0;/.test(css) && /\.sp-sel \{[^}]*font-size:16px/.test(css),
  'sticky under the tabs inside the card, taking no room; 16px so iOS doesn\'t zoom');

console.log('\n-- an open game\'s bar stays under the stat bar (2026-11-08) --');
// The owner: once a game is open, keep its bar below the stat bar so it closes from there, not from
// the top of its list. CSS sticks it; spKeepMatch keeps it where it was tapped when it closes.
state.prMatch = { [D2.games[0].id]: true };
const openG = card().match(/<div class="sp-match" data-mid="([^"]+)"><button type="button" class="sp-mh"[^>]*aria-expanded="true">/);
ok(!!openG, 'an open game\'s bar is the first thing in its game, which is what it sticks inside');
state.prMatch = {};
const stickR = (css.match(/\.sp-match > \.sp-mh\[aria-expanded="true"\] \{([^}]*)\}/) || [])[1] || '';
ok(/position:sticky;/.test(stickR) && /top:calc\(var\(--hdrH\) \+ var\(--sportsH\) \+ 52px\)/.test(stickR) && /z-index:4;/.test(stickR) && /background:color-mix\(in srgb, var\(--text\) 5%, var\(--card\)\)/.test(stickR),
  'it sticks just under the 46px stat bar, beneath it (4 to its 5), opaque so the rows pass under');
ok(/\.sp-match > \.sp-mh\.stuck \{ box-shadow:/.test(css) && /h\.classList\.toggle\('stuck', h\.parentElement\.getBoundingClientRect\(\)\.top < h\.getBoundingClientRect\(\)\.top - 1\)/.test(app),
  'with the stat bar\'s shadow only while pinned');
ok(/case 'pr-match': \{[\s\S]{0,120}spKeepMatch\(sp, id, \(\) => \{/.test(app) && /case 'socp-match': \{[\s\S]{0,80}spKeepMatch\('soccer', id, \(\) => \{/.test(app),
  'the NBA, NHL and NFL cards and the soccer card all close it through spKeepMatch');
{
  // A pinned bar sits 96px down; closed, its game's natural place is 900px above the screen.
  let top = 96, scrolled = null, synced = 0;
  const fakeDoc = { querySelector: (s) => (/\.sp-match\[data-mid="g1"\] > \.sp-mh$/.test(s) ? { getBoundingClientRect: () => ({ top }) } : null) };
  const keep = new Function('document', 'window', 'CSS', 'spStickSync', lift('spKeepMatch') + '\nreturn spKeepMatch;')(
    fakeDoc, { scrollBy: (o) => { scrolled = o; } }, { escape: (x) => x }, () => { synced++; });
  keep('nba', 'g1', () => { top = -804; });
  ok(scrolled && scrolled.top === -900 && scrolled.behavior === 'instant' && synced === 1,
    `closed from under the stat bar, the page moves up to keep the bar where it was tapped (${scrolled && scrolled.top}px)`);
  top = 300; keep('nba', 'g1', () => {});
  ok(scrolled.top === 0, 'closed where it sits in the list, nothing moves');
}
state.props = { nba: D };

console.log('\n-- only the day\'s games, the next day\'s once its last is over (2026-11-08) --');
// The owner: "only add the teams that play the day of. Once the final game ends, we can start
// getting the teams for the next day." The board recorded at 1:36 AM PT Sunday Nov 8 lists
// Sunday's 7 games and Monday's 8. `asWorker` cuts it the way the worker sends it at a moment:
// the games to come, their players, and the ones started in the last four hours as `underway`.
{
  const D8 = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'nba-props-board-20261108.json'), 'utf8'));
  const asWorker = (ms) => {
    const keep = D8.games.map((g, i) => ({ g, i })).filter((x) => Date.parse(x.g.commence) > ms);
    const at = new Map(keep.map((x, j) => [x.i, j]));
    return { ...D8, games: keep.map((x) => x.g), players: D8.players.filter((p) => at.has(p.g)).map((p) => ({ ...p, g: at.get(p.g) })),
      underway: D8.games.filter((g) => { const t = Date.parse(g.commence); return t <= ms && t > ms - 4 * 3600e3; })
        .map(({ id, date, commence, home, away }) => ({ id, date, commence, home, away })) };
  };
  const sunday = D8.games.filter((g) => g.date === '2026-11-08').map((g) => g.id);
  const monday = D8.games.filter((g) => g.date === '2026-11-09').map((g) => g.id);
  const bars = (h) => [...h.matchAll(/<div class="sp-match" data-mid="([^"]+)"/g)].map((m) => m[1]);
  const anyOf = (h, ids) => ids.some((id) => h.includes(esc(id)));
  const at = (iso) => { CLOCK = Date.parse(iso); state.props = { nba: asWorker(CLOCK) }; state.prMatch = {}; state.prStat = {}; return card(); };
  ok(sunday.length === 7 && monday.length === 8, `the recorded board: ${sunday.length} Sunday games, ${monday.length} Monday`);

  h = at(D8.at);
  ok(bars(h).length === 7 && bars(h).every((id) => sunday.includes(id)), `1:36 AM Sunday: Sunday's 7 games, none of Monday's (${bars(h).length} bars)`);
  ok(!anyOf(h, monday), 'no Monday game anywhere on the card');
  // A search opens every game it reaches, so each player row of the day is drawn.
  state.prQuery = { nba: 'a' };
  const found = card();
  state.prQuery = {};
  ok(found.includes('data-key="nba:2026-11-08:') && !found.includes('data-key="nba:2026-11-09:'),
    `a search reaches Sunday's players only (Lakers in both days' games): ${(found.match(/data-key="nba:2026-11-08:/g) || []).length} Sunday rows, ${(found.match(/data-key="nba:2026-11-09:/g) || []).length} Monday`);
  ok(h.includes('<div class="sp-sec" data-anchor="games">Today’s games</div>'), 'headed "Today’s games"');
  // One day's card: each bar gives the time alone, no weekday (2026-11-08, the owner's yes).
  const whens = [...h.matchAll(/<span class="pk-when">([^<]*)<\/span>/g)].map((m) => m[1]);
  ok(whens.length === 7 && whens.every((w) => /^\d{1,2}:\d{2}\s?[AP]M$/.test(w)), `each game's bar gives its time alone (${whens.slice(0, 3).join(', ')} …)`);

  h = at('2026-11-09T00:00:00Z');
  ok(bars(h).length === 5 && bars(h).every((id) => sunday.includes(id)) && !anyOf(h, monday), `4:00 PM, two under way: the 5 still to tip, none of Monday's (${bars(h).length} bars)`);

  h = at('2026-11-09T02:11:00Z');
  ok(!bars(h).length && !anyOf(h, monday), '6:11 PM, all 7 under way: Monday\'s still held');
  ok(text(h).includes('All of today’s games are under way. Tomorrow’s 8 games show here once the last one is over, by about 9:10 PM.'),
    `and it says when they come: "${(/All of[^<]+/.exec(h) || [''])[0]}"`);

  h = at('2026-11-09T05:09:00Z');
  ok(!bars(h).length, '9:09 PM, the last two still inside their three hours: still held');
  h = at('2026-11-09T05:11:00Z');
  ok(bars(h).length === 8 && bars(h).every((id) => monday.includes(id)) && !anyOf(h, sunday), `9:11 PM, Sunday's last over: Monday's 8 (${bars(h).length} bars)`);
  ok(h.includes('<div class="sp-sec" data-anchor="games">Tomorrow’s games</div>'), 'headed "Tomorrow’s games" before midnight');
  h = at('2026-11-09T08:30:00Z');
  ok(h.includes('<div class="sp-sec" data-anchor="games">Today’s games</div>'), 'and "Today’s games" after it');

  // The NHL's, NFL's and soccer's lists drop a game once it's over, before its three hours are up;
  // the next day comes then.
  CLOCK = Date.parse('2026-11-09T04:30:00Z');
  state.props = { nba: { ...asWorker(CLOCK), underway: [] } };
  ok(bars(card()).length === 8, 'with nothing under way left on the list, the next day\'s show at once');
  CLOCK = null;
  state.props = { nba: D }; state.prMatch = {}; state.prStat = {};
}
const wk = fs.readFileSync(path.join(BOARD, 'worker.js'), 'utf8').replace(/\r\n/g, '\n');
ok(/const all = await c\.slate\(db, now, PP_PROP_UNDERWAY_MS\);[\s\S]{0,200}out\.underway = all\.filter\(\(g\) => Date\.parse\(g\.commence\) <= now\)/.test(wk),
  'the worker sends the NBA, NHL and NFL games under way beside the ones to come');
ok(/const all = await socUpcoming\(env, now, PP_PROP_UNDERWAY_MS\);[\s\S]{0,260}out\.underway = all\.filter\(\(f\) => Date\.parse\(f\.commence\) <= now\)/.test(wk),
  'and the soccer matches under way');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
