// The leg card on the NHL tab (2026-11-17, the page brief's step 7: "Roll the leg card out to NHL ...
// Keep stat buttons and Hot players"). The tab's legs drawn as Picks draws them: today's best NHL leg
// still open, large; the PrizePicks Mores as leg cards; the moneylines Picks lists as leg cards, with
// every game's prices under them. The props card (the stat buttons) and Hot players are untouched.
//
// Read on the NHL log and the Picks payload recorded together on Nov 14 at 08:04 UTC, the data the
// brief's NHL mock was drawn from: Tkachuk's assists More at 66.6, Malkin 64, LaCombe 63.1, Carlsson
// 61.2, Roslovic 59.5; the Mores at 55%+ 127 of 229; the Hurricanes at -375 and the Lightning at -215.
// His last games come from the props card where he is on it: Nov 5's log and card share Slafkovsky.
//
//   node tests/nhlcards.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const src = read('app.js');
const PP = JSON.parse(read('tests/fixtures/nhl-pp-20261114.json'));
const PK = JSON.parse(read('tests/fixtures/picks-20261114-0004.json'));
const PP5 = JSON.parse(read('tests/fixtures/nhl-pp-opp-20261105.json'));
const PR5 = JSON.parse(read('tests/fixtures/nhl-props-board-20261105.json'));
const RealDate = Date;
let NOW = RealDate.parse(PK.asOf);
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
const names = ['TEAM_COLORS', 'MLB_TEAM_ID', 'NHL_PHOTO_SEASON', 'headshotUrl', 'teamMarkUrl', 'initialsOf', 'avatarHtml', 'LEG_OFFERS', 'offerLeg',
  'PICK_BOARD', 'PICK_SPORT', 'pickLeg', 'pct0', 'AM', 'soccerKick', 'pickIsTeam', 'pickTeamCode', 'pickTeamTag', 'miniBar', 'projLineHtml', 'mlChanceLineHtml', 'mlStakeTitle', 'pickBarHtml', 'RING_C', 'chanceRingSvg', 'pickFace', 'ptDayOf', 'pickMoved',
  'trendTag', 'readAgeTag', 'INJ_ROLE_WORD', 'injRoleText', 'injuryTag', 'goalieNote', 'PROP_MIN_MOVE', 'legMinutes', 'toiText', 'minutesTagHtml', 'trendBarsHtml', 'impPct', 'priceSparkHtml', 'LINK_BOOK', 'STATE_SLOT', 'betLinkHtml', 'legLink', 'stakeTxt', 'moneyTxt', 'pickEdgeHtml',
  'nbCdf', 'r1', 'ppLineOf', 'ppChanceAt', 'pickAtLine', 'ppLineStepHtml', 'pickLineSetTag', 'shortDay', 'recSinceText',
  'PP_BREAK_EVEN', 'dfsLinesHtml', 'BOOK_LABEL', 'bkLabel', 'booksHtml', 'PICK_SAME', 'pickGameKey', 'pickShortName', 'PICK_TOP', 'pickDayWord', 'PICK_OPEN', 'legCardHtml',
  'NBA_MK', 'NHL_MK', 'PP_MORE_MIN', 'ppMoreP', 'ppMoreMk', 'ppMoreLeg', 'ppMoreTop', 'injOut', 'ppMoreLineHtml', 'nhlNick',
  'NHL_PROVEN_N', 'nhlMoreRecord', 'propData', 'propVals', 'propTrend', 'nhlTrend', 'nhlGoaliesOf', 'nhlMoreCardLeg', 'nhlPicksMoreIds', 'nhlMoreLegs', 'tabMlCardLegs', 'nhlMlCardLegs', 'sameGameMap', 'pickLegView',
  'tabLegViewHtml', 'tabLegSizeHtml', 'tabTodayHtml', 'tabMlHtml', 'nhlPpCardHtml', 'nhlTodayParts'];
const state = { slip: {}, nhlPp: PP, picks: PK, props: null, legView: 'detailed', entrySize: 2 };
let F;
try {
  if (!/function nhlTodayParts\(/.test(src)) throw new Error('app.js has no nhlTodayParts');
  F = new Function('state', 'esc', names.filter((n) => src.includes(`function ${n}(`) || src.includes(`const ${n} =`)).map(lift).join('\n')
    + '\nreturn { nhlMoreLegs, nhlMoreCardLeg, nhlTrend, nhlMlCardLegs, nhlTodayParts, nhlPpCardHtml, LEG_OFFERS, PICK_OPEN };')(state, esc);
} catch (e) { console.log(`  FAIL  the NHL cards lift out of app.js (${e.message})`); console.log('\n1 FAILED'); process.exit(1); }
const cards = (h) => h.split('<li class="lc').slice(1);
const cardOf = (h, name) => cards(h).find((r) => r.includes(`<b>${name}</b>`)) || '';
const tilesOf = (h) => [...h.matchAll(/<div class="lc-tile"(?: title="[^"]*")?><span class="lc-tk">([^<]*)<\/span><b class="lc-tv[^"]*">([^<]*)<\/b>(?:<span class="lc-ts">([\s\S]*?)<\/span>)?<\/div>/g)]
  .map((m) => `${m[1]}: ${m[2]}${m[3] ? ` (${text(m[3])})` : ''}`);
const pkAll = [...PK.legs, ...(PK.ppPool || []), ...(PK.mlPool || [])];

console.log('-- 1. a More leg, as the card reads it --');
const more = F.nhlMoreLegs();
console.log('        ' + more.map((x) => `${x.title} ${x.p}`).join(' | '));
ok(more.map((x) => x.title).join(' | ') === 'Matthew Tkachuk Over 0.5 assists | Evgeni Malkin Over 0.5 points | Jackson LaCombe Over 0.5 assists | Leo Carlsson Over 0.5 assists | Jack Roslovic Over 0.5 points | Seth Jarvis Over 0.5 points | Artturi Lehkonen Over 0.5 points'
  && more.map((x) => x.p).join(',') === '66.6,64,63.1,61.2,59.5,59.5,59.2', "the tab's five, and the two others Picks lists (Jarvis, Lehkonen), best first at the model's chance");
ok(more.map((x) => x.onPicks).join(',') === 'true,true,true,false,true,true,true', 'each knows whether Picks lists it: Carlsson, in LaCombe\'s game, is not');
const tk = more[0], pkTk = pkAll.find((x) => x.kind === 'nhl_more' && /Tkachuk/.test(x.title));
ok(tk.kind === 'nhl_more' && tk.sub === 'Panthers @ Blues' && tk.legId === pkTk.legId, 'the game by nickname, and the id Picks gives the same leg: a star on one is a star on the other');
ok(JSON.stringify(tk.record) === JSON.stringify({ n: 229, hit: 127, hitRate: 55.5, proven: true }), 'legs like this: every More logged at 55%+, 127 of 229 (the mock\'s number)');
ok(JSON.stringify(tk.goalies) === JSON.stringify(pkTk.goalies) && tk.readAt === '2026-11-13T23:30:47.150Z', 'the goalies from Picks\' leg for his game; read when the log first read it');
ok(tk.spec.side === 'Over' && tk.spec.pp.line === 0.5 && tk.spec.pp.under === 33.4, 'it stars as the Over at PrizePicks\' 0.5');

console.log('\n-- 2. today\'s legs: the best one large, then the Mores --');
const parts = F.nhlTodayParts();
const top = parts.top;
console.log('        ' + text(top).slice(0, 260));
ok(top.startsWith('<section class="nba-pp pk-card pk-today tab-legs" aria-labelledby="nhlTodayH">') && /<h2 class="pk-h2" id="nhlTodayH">Today’s legs<\/h2>/.test(top), 'a "Today\'s legs" section, as on Picks');
ok(/data-action="leg-view" data-view="simple"/.test(top) && /<span class="pk-tl" id="nhlSizeLbl">Entry size · 2-pick Power needs 57\.7% a leg<\/span>/.test(top)
  && (top.match(/data-action="entry-size"/g) || []).length === 5, 'Simple / Detailed and the entry size, the same choices as Picks\'');
const best = (/<article class="lc lc-best"[\s\S]*?<\/article>/.exec(top) || [''])[0];
ok(/aria-labelledby="lcBestH-nhl"><div class="lc-bh"><h3 class="lc-kick" id="lcBestH-nhl">Best NHL leg still open<\/h3>/.test(best) && /<b class="lc-bn">Matthew Tkachuk<\/b><span class="lc-bp">Over 0\.5 assists<\/span>/.test(best),
  'the large card: "Best NHL leg still open", Tkachuk\'s assists More');
console.log('        ' + tilesOf(best).join(' | '));
ok(tilesOf(best).join(' | ') === `Projection: ${tk.proj} vs line 0.5 (${Math.round((tk.proj - 0.5) * 10) / 10} cushion) | Legs like this: 56% · 127 of 229 | 2-pick Power needs 57.7%: record 2.2 short (on its record) | Market: PrizePicks 0.5 (no sharp price at this line)`,
  'its four tiles: projection, legs like this, the break-even, the market (no sharp book prices NHL assists)');
ok(/Panthers @ Blues/.test(best) && /, expected<\/span>/.test(best), 'its game, and the goalies ESPN expects');
const list = top.slice(top.indexOf('<h3 class="pk-gh">PrizePicks: More</h3>'));
ok(cards(list).length === 6 && !cardOf(list, 'Matthew Tkachuk') && ['Evgeni Malkin', 'Jackson LaCombe', 'Leo Carlsson', 'Jack Roslovic', 'Seth Jarvis', 'Artturi Lehkonen'].every((n) => cardOf(list, n)),
  'the other six Mores as leg cards under it, the best not twice');
ok(/<b class="lc-pct">64%<\/b>/.test(cardOf(list, 'Evgeni Malkin')) && /More: where the model leaned More/.test(list), 'each with its chance; the Mores\' record line kept');
ok(/Same game as Jackson LaCombe/.test(cardOf(list, 'Leo Carlsson')) && !/Same game/.test(cardOf(list, 'Evgeni Malkin')), 'Carlsson, in LaCombe\'s game, says so');

console.log('\n-- 3. the moneylines, with every game\'s prices under them --');
const ml = parts.ml('<div class="board view-moneyline">TABLE</div>');
ok(/<h3 class="pk-gh" id="nhlMlH">Moneylines<\/h3>/.test(ml) && cards(ml).length === 2, 'two moneylines, as Picks lists them');
const car = cardOf(ml, 'Hurricanes');
console.log('        ' + tilesOf(car).join(' | '));
ok(/<span class="lc-bestml">Today’s best NHL moneyline<\/span>/.test(car) && !/lc-bestml/.test(cardOf(ml, 'Lightning')), '"Today\'s best NHL moneyline" on the Hurricanes alone');
ok(tilesOf(car).join(' | ') === 'Book at -375 needs: 78.9% (0.4 short) | Legs like this: 80% · 24 of 30 | 2-pick Power needs 57.7%: clears by 22.3 (on its record)', 'its tiles, as the mock has them');
ok(/<h3 class="pk-gh">Every game’s price<\/h3><div class="board view-moneyline">TABLE<\/div><\/section>$/.test(ml), 'and the table of every game under them, kept');

console.log('\n-- 4. the reader\'s choices --');
state.entrySize = 6;
ok(/6-pick Flex needs 54\.2%: clears by 1\.3/.test(tilesOf(F.nhlTodayParts().top).join(' | ')), 'entry size 6: "clears by 1.3" on every leg');
state.entrySize = 2;
state.legView = 'simple';
const sp = F.nhlTodayParts();
ok(/<article class="lc lc-best"/.test(sp.top) && cards(sp.top).every((r) => /data-action="leg-open"/.test(r) && !/lc-tiles/.test(r)) && cards(sp.ml('')).every((r) => /data-action="leg-open"/.test(r)),
  'Simple: the best card stays open, every other leg its top row, a tap away');
F.PICK_OPEN.add(more[1].legId);
ok(/lc-tiles/.test(cardOf(F.nhlTodayParts().top, 'Evgeni Malkin')), 'a tapped leg opens where it is');
F.PICK_OPEN.clear();
state.legView = 'detailed';

console.log('\n-- 5. when Picks lists none of the top five (as on Nov 17) --');
// Nov 17's tab: its five best were points Mores Picks holds off; Picks listed three assists Mores at
// 58-60 below them. Here Picks keeps Jarvis and Lehkonen alone.
const keep = (x) => x.kind !== 'nhl_more' || /Jarvis|Lehkonen/.test(x.title);
state.picks = { ...PK, legs: PK.legs.filter(keep), ppPool: (PK.ppPool || []).filter(keep) };
const few = F.nhlTodayParts();
const fewBest = (/<article class="lc lc-best"[\s\S]*?<\/article>/.exec(few.top) || [''])[0];
ok(/<b class="lc-bn">Seth Jarvis<\/b>/.test(fewBest), 'the large card is the best More Picks lists: Jarvis at 59.5, not Tkachuk at 66.6');
ok(cards(few.top).length === 6 && cardOf(few.top, 'Matthew Tkachuk') && cardOf(few.top, 'Artturi Lehkonen'), 'the rest stay listed under it');
state.picks = PK;

console.log('\n-- 6. without Picks loaded --');
state.picks = null;
const np = F.nhlTodayParts();
ok(cards(np.top).length === 4 && /<b class="lc-bn">Matthew Tkachuk<\/b>/.test(np.top), 'the tab\'s own five: the best of them large, four under it');
ok(!/check the goalie/.test(np.top) && !/, expected|, confirmed/.test(np.top), 'no goalies read for these games: the cards say nothing of them, rather than "none listed"');
ok(/The moneylines that clear the bar show once Picks has loaded\./.test(np.ml('')), 'the moneylines say they wait for Picks');
state.picks = PK;

console.log('\n-- 7. his last games, from the props card --');
NOW = RealDate.parse('2026-11-05T23:00:00Z');
state.props = { nhl: PR5 };
const slaf = PP5.legs.find((x) => x.player === 'Juraj Slafkovsky' && x.market === 'pts');
const t = F.nhlTrend(slaf);
ok(t && t.vals.join(',') === '2,0,2,2,0,1,0,1,0,0' && t.hit === 5 && t.side === 'over' && t.line === 0.5, 'Slafkovsky\'s points in his last ten, oldest first: over 0.5 in 5');
const sc = F.nhlMoreCardLeg(slaf, null);
ok(sc.trend && sc.trend.hit === 5, 'on his card as the boxes Picks draws');
ok(F.nhlTrend({ ...slaf, player_id: '1' }) === null, 'a skater not on the props card: none, rather than a guess');
NOW = RealDate.parse(PK.asOf);
state.props = null;

console.log('\n-- 8. on the page --');
const rn = lift('renderNhl');
ok(/grid\.innerHTML = nhlRecordHtml\(d\.record\) \+ parts\.top \+ propsCardHtml\('nhl'\) \+ parts\.ml\(table\) \+ hotCardHtml\('nhl'\);/.test(rn),
  'the mock\'s order: today\'s legs and the Mores, the props card and its stat buttons, the moneylines and the table, Hot players');
ok(/const LEG_CARD_TABS = new Set\(\['nhl', 'nba', 'nfl', 'soccer'\]\);/.test(src) && /const leg = LEG_CARD_TABS\.has\(state\.sport\) \? null : topLegFor/.test(lift('renderTopCard')), 'the old top card stays off the tab: its own best card replaces it');
ok(/renderTopCard\(\);\n\s+\/\/ The NHL, NBA, NFL and soccer tabs' best leg, moneyline cards and goalies are Picks' \(step 7\)\.\n\s+if \(state\.sport === 'nhl'\) renderNhl\(\);/.test(src), 'Picks arriving redraws the tab: its moneylines are Picks\'');
for (const c of ['leg-view', 'entry-size', 'leg-open']) {
  const body = (new RegExp(`case '${c}': \\{[\\s\\S]*?break;\\n\\s+\\}`).exec(src) || [''])[0];
  ok(/if \(state\.sport === 'nhl'\) renderNhl\(\);/.test(body), `${c} redraws the NHL tab too`);
}
ok(/const host = document\.getElementById\(\{ nhl: 'nhlGrid', nba: 'nbaGrid', nfl: 'nflMlGrid', soccer: 'soccerGrid' \}\[state\.sport\] \|\| 'picksGrid'\);/.test(src), 'the focus goes back to the name on the tab in view');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
