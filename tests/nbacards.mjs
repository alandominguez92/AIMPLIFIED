// The leg card on the NBA tab (2026-11-17, the page brief's step 7: "Roll the leg card out to NHL,
// then NBA ... Keep stat buttons and Hot players"). The tab's legs drawn as Picks draws them, in the
// NHL tab's order: today's best NBA leg Picks lists, large; the log's five unders by the sharp
// chance (as since Nov 16) and the unders Picks lists beyond them; the blocks Mores; then the
// moneylines Picks lists, with every game's prices under them. The props card (the stat buttons)
// and Hot players are untouched. What has to hold:
//   - an under from the log reads as the card read it: the sharp books' chance the big number,
//     green at 54%+, the model's beside it with what its range has landed, the sharp range's record
//   - a leg Picks lists is Picks' own leg, its chance and its record, wherever it shows on the tab
//   - the best card is the best Picks lists whose player isn't out, and isn't drawn twice
//   - rebounds and assists take a line set on them; the tags the old rows had stay
//   - a player ESPN lists is flagged and the rest say nothing, as on the old rows
//
// Read on the NBA log and the Picks payload recorded together on Nov 16 at 09:10 UTC, with Nov 8's
// props card for his last games: Picks listed Jabari Smith Jr's blocks More at 62.1 and Derik
// Queen's rebounds Less at 56.1 (above the sharp line); the log's best five by the sharp chance were
// Paul George 57, Payton Pritchard 54.7, Jayson Tatum 54.2, Aaron Gordon 53.5 and Jabari Smith Jr's
// rebounds at 53.4, Fred VanVleet (53.9) listed out.
//
//   node tests/nbacards.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const src = read('app.js');
const PP = JSON.parse(read('tests/fixtures/nba-pp-20261116.json'));
const PK = JSON.parse(read('tests/fixtures/picks-20261116-0040.json'));
const PR = JSON.parse(read('tests/fixtures/nba-props-board-20261108.json'));
const RealDate = Date;
const NOW = RealDate.parse(PK.asOf);
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
// Ends a const at the semicolon that closes it (a bracket-only close takes in the next const too).
function lift(name) {
  let at = src.indexOf(`function ${name}(`);
  const isConst = at < 0;
  if (isConst) at = src.indexOf(`const ${name} =`);
  if (at < 0) throw new Error(`app.js has no ${name}`);
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') { depth--; if (!isConst && c === '}' && depth === 0) return src.slice(at, i + 1); }
    else if (isConst && c === ';' && depth === 0 && src[i + 1] === '\n') return src.slice(at, i + 1);
  }
  throw new Error(`could not close ${name}`);
}
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const names = ['TEAM_COLORS', 'MLB_TEAM_ID', 'NHL_PHOTO_SEASON', 'headshotUrl', 'teamMarkUrl', 'initialsOf', 'avatarHtml', 'LEG_OFFERS', 'offerLeg',
  'PICK_BOARD', 'PICK_SPORT', 'pickLeg', 'pct0', 'AM', 'soccerKick', 'pickIsTeam', 'pickTeamCode', 'pickTeamTag', 'miniBar', 'projLineHtml', 'mlChanceLineHtml', 'pickBarHtml', 'RING_C', 'chanceRingSvg', 'pickFace', 'ptDayOf', 'pickMoved',
  'trendTag', 'readAgeTag', 'INJ_ROLE_WORD', 'injRoleText', 'injuryTag', 'goalieNote', 'PROP_MIN_MOVE', 'legMinutes', 'toiText', 'minutesTagHtml', 'trendBarsHtml', 'impPct', 'priceSparkHtml', 'LINK_BOOK', 'STATE_SLOT', 'betLinkHtml', 'legLink', 'stakeTxt', 'moneyTxt', 'pickEdgeHtml',
  'nbCdf', 'r1', 'ppLineOf', 'ppChanceAt', 'pickAtLine', 'ppLineStepHtml', 'pickLineSetTag', 'shortDay', 'recSinceText',
  'PP_BREAK_EVEN', 'dfsLinesHtml', 'BOOK_LABEL', 'bkLabel', 'booksHtml', 'PICK_SAME', 'pickGameKey', 'pickShortName', 'PICK_TOP', 'pickDayWord', 'PICK_OPEN', 'legCardHtml',
  'NBA_MK', 'NHL_MK', 'MARKET_SHORT', 'PP_MORE_MIN', 'ppMoreP', 'ppMoreMk', 'ppMoreLeg', 'ppMoreTop', 'injOut', 'outLast', 'ppMoreLineHtml', 'propData', 'propVals', 'propTrend', 'sameGameMap', 'pickLegView',
  'tabLegViewHtml', 'tabLegSizeHtml', 'tabTodayHtml', 'tabMlHtml', 'tabMlCardLegs',
  'NBA_ROTATION_MIN', 'nbaPpLeg', 'nbaOversLineHtml', 'ppMovedTag', 'ppCloseLineHtml', 'sharpBooksText', 'ppGameLineHtml', 'PP_LINE_MARKETS', 'nbaLegAtLine', 'NBA_SHARP_BOOKS', 'sharpAtLine',
  'NBA_BANDS', 'NBA_BAND_MIN', 'nbaModelBit', 'nbaNick', 'sharpTag', 'ppBookLine', 'ppLineTags',
  'NBA_SHARP_BANDS', 'NBA_PROVEN_N', 'NBA_MORE_MODEL_W', 'nbaRot', 'nbaUnderRecord', 'nbaGameSub', 'nbaUnderCardLeg', 'nbaBlkCardLeg', 'nbaPicksProps', 'nbaUnderLegs', 'nbaBlkLegs',
  'nbaPpCardHtml', 'nbaBlkMoreHtml', 'nbaTodayParts'];
const state = { slip: {}, nbaPp: PP, picks: PK, props: { nba: PR }, legView: 'detailed', entrySize: 2, ppLines: {} };
let F;
try {
  if (!/function nbaTodayParts\(/.test(src)) throw new Error('app.js has no nbaTodayParts');
  F = new Function('state', 'esc', names.map(lift).join('\n')
    + '\nreturn { nbaPicksProps, nbaUnderLegs, nbaBlkLegs, nbaUnderCardLeg, nbaTodayParts, nbaPpCardHtml, PICK_OPEN };')(state, esc);
} catch (e) { console.log(`  FAIL  the NBA cards lift out of app.js (${e.message})`); console.log('\n1 FAILED'); process.exit(1); }
const cards = (h) => h.split('<li class="lc').slice(1);
const cardOf = (h, name, pick) => cards(h).find((r) => r.includes(`<b>${name}</b>`) && (!pick || r.includes(pick))) || '';
const tilesOf = (h) => [...h.matchAll(/<div class="lc-tile"(?: title="[^"]*")?><span class="lc-tk">([^<]*)<\/span><b class="lc-tv[^"]*">([^<]*)<\/b>(?:<span class="lc-ts">([\s\S]*?)<\/span>)?<\/div>/g)]
  .map((m) => `${m[1]}: ${m[2]}${m[3] ? ` (${text(m[3])})` : ''}`);
const tagsOf = (h) => text((/<span class="lc-tags">([\s\S]*?)<\/span><\/div><div class="lc-p">/.exec(h) || ['', ''])[1]);
const bigOf = (h) => (/<b class="lc-pct([^"]*)"(?: title="[^"]*")?>(\d+)%<\/b>/.exec(h) || []).slice(1);

console.log('-- 1. the legs, as the card reads them --');
const picks = F.nbaPicksProps();
ok(picks.map((x) => `${x.title} ${x.p}`).join(' | ') === 'Jabari Smith Jr Over 0.5 BLK 62.1 | Derik Queen Under 6 REB 56.1', "Picks' NBA props: Jabari Smith Jr's blocks More, Derik Queen's rebounds Less");
const unders = F.nbaUnderLegs(picks);
console.log('        ' + unders.map((x) => `${x.title} ${x.p}`).join(' | '));
ok(unders.map((x) => x.title).join(' | ') === 'Paul George Under 1.5 Stl | Payton Pritchard Under 2.5 3PM | Jayson Tatum Under 2.5 3PM | Aaron Gordon Under 2.5 Ast | Jabari Smith Jr Under 6.5 Reb | Derik Queen Under 6 REB'
  && unders.map((x) => x.p).join(',') === '57,54.7,54.2,53.5,53.4,56.1', 'the five by the sharp chance, then the one Picks lists beyond them');
const pg = unders[0], gLeg = PP.legs.find((x) => x.player === 'Paul George' && x.market === 'stl');
ok(pg.kind === 'nba_pp' && pg.pIsSharp && pg.sharp === 57 && pg.modelP === gLeg.model_under && pg.legId === `nbapp:${gLeg.game_id}:Paul George:stl`,
  "an under: the sharp books' chance the one shown, the model's beside it, under the id Picks and the slip know it by");
ok(JSON.stringify(pg.record) === JSON.stringify({ n: 111, hit: 64, hitRate: 57.7, proven: true }), "legs like this: the sharp books' 54-58 range, 64 of 111");
ok(pg.spec.side === 'Under' && pg.spec.pp.line === 1.5 && pg.spec.pp.under === gLeg.model_under && pg.spec.playerId === gLeg.player_id, "it stars as the Under at PrizePicks' line, the model's chance in its spec as the entry log reads it");
ok(unders[5] === picks[1], "Derik Queen is Picks' own leg: its chance, its record");
ok(!unders.some((x) => /VanVleet/.test(x.title)), 'Fred VanVleet, listed out, is not among the five');
const blk = F.nbaBlkLegs(picks);
ok(blk.map((x) => `${x.title} ${x.p}`).join(' | ') === 'Jabari Smith Jr Over 0.5 BLK 62.1 | Andrew Wiggins Over 0.5 blocks 55.5' && blk[0] === picks[0], "the blocks Mores: Picks' Jabari, then Andrew Wiggins at 55.5");

console.log('\n-- 2. today\'s legs: the best one large, then the unders and blocks Mores --');
const parts = F.nbaTodayParts();
const top = parts.top;
ok(top.startsWith('<section class="nba-pp pk-card pk-today tab-legs" aria-labelledby="nbaTodayH">') && /<h2 class="pk-h2" id="nbaTodayH">Today’s legs<\/h2>/.test(top), 'a "Today\'s legs" section, as on Picks and the NHL tab');
ok(/data-action="leg-view" data-view="simple"/.test(top) && /<span class="pk-tl" id="nbaSizeLbl">Entry size · 2-pick Power needs 57\.7% a leg<\/span>/.test(top), 'Simple / Detailed and the entry size');
const best = (/<article class="lc lc-best"[\s\S]*?<\/article>/.exec(top) || [''])[0];
ok(/<h3 class="lc-kick" id="lcBestH-nba">Best NBA leg still open<\/h3>/.test(best) && /<b class="lc-bn">Jabari Smith Jr<\/b><span class="lc-bp">Over 0\.5 BLK<\/span>/.test(best),
  'the large card: "Best NBA leg still open", Jabari Smith Jr\'s blocks More');
console.log('        ' + tilesOf(best).join(' | '));
ok(tilesOf(best).join(' | ') === 'Projection: 1 vs line 0.5 (0.5 cushion) | Legs like this: 60% · 47 of 78 (since the rule (Oct 27): 31 of 55 (56%)) | 2-pick Power needs 57.7%: clears by 2.6 (on its record) | Market: PrizePicks 0.5 (no sharp price at this line)',
  "its four tiles, Picks' own: projection, legs like this, the break-even, the market");
const ul = top.slice(top.indexOf('<h3 class="pk-gh">PrizePicks unders</h3>'), top.indexOf('<div class="pk-grp nba-blk">'));
const bl = top.slice(top.indexOf('<div class="pk-grp nba-blk">'));
ok(/<div class="tc-head"><h3 class="pk-gh">PrizePicks unders<\/h3><span class="tc-rec"[^>]*>Sharp 54%\+: <b>\d+ of \d+<\/b><\/span><\/div>/.test(top) && /A leg Picks lists shows Picks' own chance\./.test(ul),
  "the unders' head keeps its record, and says whose chance a leg Picks lists shows");
ok(cards(ul).length === 6 && cards(bl).length === 1 && cardOf(bl, 'Andrew Wiggins') && !cardOf(bl, 'Jabari Smith Jr'), 'six unders and one blocks More under it, the best not twice');
const pgc = cardOf(ul, 'Paul George');
console.log('        ' + tilesOf(pgc).join(' | ') + ' || ' + tagsOf(pgc));
ok(bigOf(pgc).join(',') === ' tc-band-good,57' && /title="FanDuel[^"]*: their price at PrizePicks' line, de-vigged, the middle of them"/.test(pgc), "George: the sharp 57% large, green at a 6-Flex's 54%+, whose number on hover");
ok(tilesOf(pgc)[0] === 'Sharp books: 57% (model 49% (its under 55% landed 51%))' && tilesOf(pgc)[1] === 'Legs like this: 58% · 64 of 111', "the model's beside it with its range, then the sharp range's record");
// His minutes first since 2026-11-17 (tests/minutes.mjs), off the props card the tab has loaded.
ok(tagsOf(pgc) === '30.6 min last 5, usually 30.5 book u1.5 -118 · season: under 3 of 10' && /under 1\.5 in 2 of last 8/.test(text(pgc)), 'his minutes, the book\'s line and his season, as the old row had them; his last games drawn');
ok(bigOf(cardOf(ul, 'Aaron Gordon')).join(',') === ',54' && bigOf(cardOf(ul, 'Jabari Smith Jr')).join(',') === ',53', 'under 54%: plain');
const gc = cardOf(ul, 'Aaron Gordon');
ok(/PP line read 4h ago: check the app/.test(tagsOf(gc)) && /<span class="sp-lbl">PP shows<\/span>/.test(gc) && !/PP shows/.test(pgc), 'assists: how old the read is, and the line to set; steals neither');
ok(/Same game as Paul George/.test(tagsOf(cardOf(ul, 'Payton Pritchard'))) && /Same player as another leg/.test(tagsOf(cardOf(ul, 'Jabari Smith Jr'))) && !/Same/.test(tagsOf(pgc)),
  'the second leg from a game says so; Jabari\'s rebounds, under his own blocks More, say "Same player"');
const qc = cardOf(ul, 'Derik Queen');
ok(bigOf(qc)[1] === '56' && /PP \+0\.5 vs book/.test(tagsOf(qc)) && tilesOf(qc)[0] === 'Sharp books: 45% (model 51%)' && /<span class="sp-lbl">PP shows<\/span>/.test(qc), "Queen, Picks' rebounds Less: its 56%, PrizePicks above the book, the sharp and model numbers, the line to set");
ok(/<b class="lc-pct">56%<\/b>/.test(cardOf(bl, 'Andrew Wiggins')) && /Blocks: where the model leaned More/.test(bl), "Wiggins' More at 56%; the Mores' record line kept");

console.log('\n-- 3. the moneylines, with every game\'s prices under them --');
const ml = parts.ml('<div class="board view-moneyline">TABLE</div>');
ok(/<h3 class="pk-gh" id="nbaMlH">Moneylines<\/h3>/.test(ml) && cards(ml).map((r) => (/<b>([^<]+)<\/b>/.exec(r) || [])[1]).join(',') === 'Nuggets,Cavaliers,Celtics,76ers', 'the four Picks lists, best first');
ok(/<span class="lc-bestml">Today’s best NBA moneyline<\/span>/.test(cardOf(ml, 'Nuggets')) && (ml.match(/lc-bestml/g) || []).length === 1, '"Today\'s best NBA moneyline" on the Nuggets alone');
ok(/Same game as Aaron Gordon/.test(cardOf(ml, 'Nuggets')), 'and the Nuggets name the leg from their game above');
ok(/<h3 class="pk-gh">Every game’s price<\/h3><div class="board view-moneyline">TABLE<\/div><\/section>$/.test(ml), 'and the table of every game under them, kept');

console.log('\n-- 4. the reader\'s choices --');
state.entrySize = 6;
ok(/6-pick Flex needs 54\.2%: clears by 3\.5/.test(tilesOf(cardOf(F.nbaTodayParts().top, 'Paul George')).join(' | ')), "entry size 6: George's record clears a 6-Flex's 54.2% by 3.5");
state.entrySize = 2;
state.legView = 'simple';
const sp = F.nbaTodayParts();
ok(/<article class="lc lc-best"/.test(sp.top) && cards(sp.top).every((r) => /data-action="leg-open"/.test(r) && !/lc-tiles/.test(r) && !/PP shows/.test(r)), 'Simple: the best card stays open, every other leg its top row, a tap away');
F.PICK_OPEN.add(unders[3].legId);
ok(/lc-tiles/.test(cardOf(F.nbaTodayParts().top, 'Aaron Gordon')) && /PP shows/.test(cardOf(F.nbaTodayParts().top, 'Aaron Gordon')), 'a tapped leg opens where it is, its line to set with it');
F.PICK_OPEN.clear();
state.legView = 'detailed';
const gl = PP.legs.find((x) => x.player === 'Aaron Gordon' && x.market === 'ast');
state.ppLines = { [unders[3].legId]: { line: 3.5, at: NOW + 1000, commence: gl.commence } };
const set = cardOf(F.nbaTodayParts().top, 'Aaron Gordon');
console.log('        ' + text(set).slice(0, 200));
ok(/Under 3\.5 Ast/.test(set) && /you set 3\.5, read 2\.5/.test(tagsOf(set)) && /<span class="sp-lbl">You set<\/span>/.test(set) && /Back to 2\.5/.test(set), 'Gordon set at 3.5: the leg reads 3.5, says so, and goes back to 2.5');
ok(Number(bigOf(set)[1]) > 54 && !/PP line read/.test(tagsOf(set)), 'his chance worked out again at 3.5, and no read age: the number is the one in front of you');
// The old rows said "PP 2.5 → 3.5" here too, as if PrizePicks had moved it (ppMovedTag reads the line on the leg).
ok(!/PP 2\.5 → 3\.5/.test(tagsOf(set)) && /PP \+1 vs book/.test(tagsOf(set)), "a line set isn't PrizePicks moving it; it does sit a point above the book's");
state.ppLines = {};

console.log('\n-- 5. who is out, and who is listed --');
const outPk = { ...PK, ppPool: PK.ppPool.map((x) => (x.kind === 'nba_blk_more' ? { ...x, inj: { status: 'Out', out: true, what: 'ankle', at: PK.asOf } } : x)),
  legs: PK.legs.map((x) => (x.kind === 'nba_blk_more' ? { ...x, inj: { status: 'Out', out: true, what: 'ankle', at: PK.asOf } } : x)) };
state.picks = outPk;
const ob = (/<article class="lc lc-best"[\s\S]*?<\/article>/.exec(F.nbaTodayParts().top) || [''])[0];
ok(/<b class="lc-bn">Derik Queen<\/b>/.test(ob) && /Out: ankle/.test(F.nbaTodayParts().top), 'Jabari listed out: the best card is Queen, and Jabari stays listed, flagged');
state.picks = PK;
const listed = PP.legs.filter((x) => x.inj && x.inj.status && !x.inj.out && x.min_proj >= 18);
const tabLeg = F.nbaUnderCardLeg(PP.legs.find((x) => x.player === 'Paul George' && x.market === 'stl'), PP.record);
ok(tabLeg.inj === null && tabLeg.injUnread === true && !/injur/i.test(tagsOf(pgc)), "not listed: George's card says nothing of injuries, as the old rows didn't");
if (listed.length) {
  const q = F.nbaUnderCardLeg(listed[0], PP.record);
  ok(q.inj === listed[0].inj, `${listed[0].player}, listed ${listed[0].inj.status}: the report comes with the leg`);
}

console.log('\n-- 6. without Picks loaded --');
state.picks = null;
const np = F.nbaTodayParts();
ok(!/lc-best/.test(np.top) && cards(np.top).length === 7 && cardOf(np.top, 'Jabari Smith Jr', 'blocks'), "no best card; the tab's own five unders and two blocks Mores");
ok(/The moneylines that clear the bar show once Picks has loaded\./.test(np.ml('')), 'the moneylines say they wait for Picks');
state.picks = PK;

console.log('\n-- 7. on the page --');
const rn = lift('renderNba');
ok(/grid\.innerHTML = parts\.top \+ propsCardHtml\('nba'\) \+ parts\.ml\(table\) \+ nbaHotCardHtml\(\);/.test(rn),
  "the NHL tab's order: today's legs, the props card and its stat buttons, the moneylines and the table, Hot players");
ok(/const LEG_CARD_TABS = new Set\(\['nhl', 'nba', 'nfl', 'soccer'\]\);/.test(src), 'the old top card stays off the tab: its own best card replaces it');
ok(/\/\/ The NHL, NBA, NFL and soccer tabs' best leg, moneyline cards and goalies are Picks' \(step 7\)\.\n\s+if \(state\.sport === 'nhl'\) renderNhl\(\);\n\s+if \(state\.sport === 'nba'\) renderNba\(\);/.test(src), 'Picks arriving redraws the tab');
for (const c of ['leg-view', 'entry-size', 'leg-open']) {
  const body = (new RegExp(`case '${c}': \\{[\\s\\S]*?break;\\n\\s+\\}`).exec(src) || [''])[0];
  ok(/if \(state\.sport === 'nba'\) renderNba\(\);/.test(body), `${c} redraws the NBA tab too`);
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
