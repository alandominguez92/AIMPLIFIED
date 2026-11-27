// The leg card on the NFL tab (2026-11-17, the page brief's step 7: "Roll the leg card out to NHL,
// then NBA, NFL, Soccer. Keep stat buttons and Hot players"). The tab's legs drawn as Picks draws
// them, in the NHL and NBA tabs' order: today's best NFL prop Picks lists, large, and its others
// under it; the props card with its stat buttons; the moneylines Picks lists as leg cards over every
// game's prices; Hot players. What has to hold:
//   - the NFL keeps no PrizePicks log of its own: every leg is Picks' own, its chance and its record
//   - the best card is the best passing-TDs Under Picks lists whose player isn't out, not drawn twice
//   - its market tile says the chance is the sharp books' (it read "no sharp price" before)
//   - between game days Picks lists none (it lists games starting within a day): the tab says so
//
// Read on the Picks payload recorded on Saturday night, Nov 14 at 22:02 PT, before Sunday's games:
// Deshaun Watson Under 1.5 passing TDs at 67.8, Daniel Jones 66.5, Geno Smith 65.1 (39 of 54 at
// 60%+); the Jaguars at 83, the Rams 79.8, the Bills 79 (17 of 21 at 75%+).
//
//   node tests/nflcards.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const src = read('app.js');
const PK = JSON.parse(read('tests/fixtures/picks-20261114-2200.json'));
const RealDate = Date;
let NOW = RealDate.parse(PK.asOf);
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
  'PICK_BOARD', 'PICK_SPORT', 'pickLeg', 'pct0', 'AM', 'soccerKick', 'pickIsTeam', 'pickTeamCode', 'pickTeamTag', 'miniBar', 'projLineHtml', 'mlChanceLineHtml', 'mlStakeTitle', 'pickBarHtml', 'RING_C', 'chanceRingSvg', 'pickFace', 'ptDayOf', 'pickMoved',
  'trendTag', 'readAgeTag', 'INJ_ROLE_WORD', 'injRoleText', 'injuryTag', 'goalieNote', 'PROP_MIN_MOVE', 'legMinutes', 'toiText', 'minutesTagHtml', 'trendBarsHtml', 'impPct', 'priceSparkHtml', 'LINK_BOOK', 'STATE_SLOT', 'betLinkHtml', 'legLink', 'stakeTxt', 'moneyTxt', 'pickEdgeHtml',
  'nbCdf', 'r1', 'ppLineOf', 'ppChanceAt', 'pickAtLine', 'ppLineStepHtml', 'pickLineSetTag', 'shortDay', 'recSinceText',
  'PP_BREAK_EVEN', 'BOOK_LABEL', 'bkLabel', 'booksHtml', 'PICK_SAME', 'pickGameKey', 'pickShortName', 'PICK_TOP', 'pickDayWord', 'PICK_OPEN', 'legCardHtml',
  'injOut', 'sameGameMap', 'pickLegView', 'tabLegViewHtml', 'tabLegSizeHtml', 'tabTodayHtml', 'tabMlHtml', 'tabMlCardLegs', 'nflPicksProps', 'nflTodayParts'];
const state = { slip: {}, picks: PK, legView: 'detailed', entrySize: 2, ppLines: {} };
let F;
try {
  if (!/function nflTodayParts\(/.test(src)) throw new Error('app.js has no nflTodayParts');
  F = new Function('state', 'esc', names.map(lift).join('\n') + '\nreturn { nflPicksProps, nflTodayParts, PICK_OPEN };')(state, esc);
} catch (e) { console.log(`  FAIL  the NFL cards lift out of app.js (${e.message})`); console.log('\n1 FAILED'); process.exit(1); }
const cards = (h) => h.split('<li class="lc').slice(1);
const cardOf = (h, name) => cards(h).find((r) => r.includes(`<b>${name}</b>`)) || '';
const tilesOf = (h) => [...h.matchAll(/<div class="lc-tile"(?: title="[^"]*")?><span class="lc-tk">([^<]*)<\/span><b class="lc-tv[^"]*">([^<]*)<\/b>(?:<span class="lc-ts">([\s\S]*?)<\/span>)?<\/div>/g)]
  .map((m) => `${m[1]}: ${m[2]}${m[3] ? ` (${text(m[3])})` : ''}`);
const tagsOf = (h) => text((/<span class="lc-tags">([\s\S]*?)<\/span><\/div><div class="lc-p">/.exec(h) || ['', ''])[1]);
const pkAll = [...PK.legs, ...(PK.ppPool || []), ...(PK.mlPool || [])];

console.log('-- 1. the legs: Picks\' own --');
const props = F.nflPicksProps();
console.log('        ' + props.map((x) => `${x.title} ${x.p}`).join(' | '));
ok(props.map((x) => `${x.title} ${x.p}`).join(' | ') === 'Deshaun Watson Under 1.5 Pass TDs 67.8 | Daniel Jones Under 1.5 Pass TDs 66.5 | Geno Smith Under 1.5 Pass TDs 65.1',
  "Picks' three passing-TDs Unders, its list's and its pool's, once each, best first");
ok(props.every((x) => pkAll.includes(x)), "each Picks' own leg: its chance, its record, its id");

console.log('\n-- 2. today\'s legs: the best one large, then the others --');
const parts = F.nflTodayParts();
const top = parts.top;
ok(top.startsWith('<section class="nba-pp pk-card pk-today tab-legs" aria-labelledby="nflTodayH">') && /<h2 class="pk-h2" id="nflTodayH">Today’s legs<\/h2>/.test(top), 'a "Today\'s legs" section, as on Picks, the NHL and NBA tabs');
ok(/data-action="leg-view" data-view="simple"/.test(top) && /<span class="pk-tl" id="nflSizeLbl">Entry size · 2-pick Power needs 57\.7% a leg<\/span>/.test(top), 'Simple / Detailed and the entry size');
const best = (/<article class="lc lc-best"[\s\S]*?<\/article>/.exec(top) || [''])[0];
ok(/<h3 class="lc-kick" id="lcBestH-nfl">Best NFL leg still open<\/h3>/.test(best) && /<b class="lc-bn">Deshaun Watson<\/b><span class="lc-bp">Under 1\.5 Pass TDs<\/span>/.test(best),
  'the large card: "Best NFL leg still open", Watson\'s passing TDs Under');
console.log('        ' + tilesOf(best).join(' | '));
ok(tilesOf(best).join(' | ') === 'Legs like this: 72% · 39 of 54 | 2-pick Power needs 57.7%: clears by 14.5 (on its record) | Market: PrizePicks 1.5 (sharp books 68%)',
  'its tiles: the record, the break-even, and the market saying the chance is the sharp books\'');
ok(!/no sharp price/.test(best), 'not "no sharp price at this line": the chance is theirs');
ok(/Texans @ Browns · check PrizePicks has 1\.5/.test(text(best)) && /under 1\.5 in 3 of last 4/.test(text(best)), "its game with Picks' reminder to check the line, and his last games");
const list = top.slice(top.indexOf('<div class="pk-grp nfl-ptd">'));
ok(/<h3 class="pk-gh">PrizePicks: passing TDs Under 1\.5<\/h3>/.test(list) && cards(list).length === 2 && cardOf(list, 'Daniel Jones') && cardOf(list, 'Geno Smith') && !cardOf(list, 'Deshaun Watson'),
  'the other two as leg cards under it, the best not twice');
ok(/<b class="lc-pct">67%<\/b>/.test(cardOf(list, 'Daniel Jones')) && /Legs like this/.test(cardOf(list, 'Daniel Jones')), 'each with its chance and its record');

console.log('\n-- 3. the moneylines, with every game\'s prices under them --');
const ml = parts.ml('<div class="board view-moneyline">TABLE</div>');
ok(/<h3 class="pk-gh" id="nflMlH">Moneylines<\/h3>/.test(ml) && cards(ml).map((r) => (/<b>([^<]+)<\/b>/.exec(r) || [])[1]).join(',') === 'Jaguars,Rams,Bills', 'the three Picks lists, best first');
console.log('        ' + (/<span class="lc-bestml">([^<]*)<\/span>/.exec(cardOf(ml, 'Jaguars')) || [])[1]);
// Read on Saturday night, so the day word is tomorrow's: Sunday's games.
ok(/<span class="lc-bestml">Tomorrow’s best NFL moneyline<\/span>/.test(cardOf(ml, 'Jaguars')) && (ml.match(/lc-bestml/g) || []).length === 1, '"Tomorrow\'s best NFL moneyline" on the Jaguars alone (read Saturday night)');
console.log('        ' + tagsOf(cardOf(ml, 'Bills')));
ok(/Same game as Geno Smith/.test(tagsOf(cardOf(ml, 'Bills'))), "the Bills name Geno Smith's Under above them: the same game");
ok(/<h3 class="pk-gh">Every game’s price<\/h3><div class="board view-moneyline">TABLE<\/div><\/section>$/.test(ml), 'and the table of every game under them, kept');

console.log('\n-- 4. the reader\'s choices --');
state.legView = 'simple';
const sp = F.nflTodayParts();
ok(/<article class="lc lc-best"/.test(sp.top) && cards(sp.top).every((r) => /data-action="leg-open"/.test(r) && !/lc-tiles/.test(r)) && cards(sp.ml('')).every((r) => /data-action="leg-open"/.test(r)),
  'Simple: the best card stays open, every other leg its top row, a tap away');
state.legView = 'detailed';
state.entrySize = 6;
ok(/6-pick Flex needs 54\.2%: clears by 18/.test(tilesOf(cardOf(F.nflTodayParts().top, 'Daniel Jones')).join(' | ')), 'entry size 6: the break-even moves on every leg');
state.entrySize = 2;

console.log('\n-- 5. who is out --');
const outPk = { ...PK, legs: PK.legs.map((x) => (/Watson/.test(x.title) ? { ...x, inj: { status: 'Out', out: true, what: 'knee', at: PK.asOf } } : x)),
  ppPool: PK.ppPool.map((x) => (/Watson/.test(x.title) ? { ...x, inj: { status: 'Out', out: true, what: 'knee', at: PK.asOf } } : x)) };
state.picks = outPk;
const ob = F.nflTodayParts().top;
ok(/<b class="lc-bn">Daniel Jones<\/b>/.test(ob) && cardOf(ob, 'Deshaun Watson'), 'Watson listed out: the best card is Jones, and Watson stays listed, last');
state.picks = PK;

console.log('\n-- 6. between game days, and before Picks has loaded --');
NOW = RealDate.parse('2026-11-17T18:00:00Z');
const tue = F.nflTodayParts();
ok(!/lc-best/.test(tue.top) && /No NFL prop on Picks yet: it lists the games starting within a day\./.test(tue.top), 'Tuesday: no legs, and the tab says why');
ok(/No NFL favourite at 75%\+ in the games starting within a day\./.test(tue.ml('')), 'nor moneylines');
NOW = RealDate.parse(PK.asOf);
state.picks = null;
const np = F.nflTodayParts();
ok(/The NFL legs show once Picks has loaded\./.test(np.top) && /The moneylines that clear the bar show once Picks has loaded\./.test(np.ml('')), 'before Picks has loaded, both say they wait for it');
state.picks = PK;

console.log('\n-- 7. on the page --');
const rn = lift('renderNflMoneyline');
ok(/grid\.innerHTML = rec \+ parts\.top \+ propsCardHtml\('nfl'\) \+ parts\.ml\(table\) \+ hotCardHtml\('nfl'\);/.test(rn),
  "the NHL and NBA tabs' order: the record, today's legs, the props card and its stat buttons, the moneylines and the table, Hot players");
ok(/const table = games\.length \? nflTable\(games\) \+ mlLaterHtml\('nfl', sp\)/.test(rn), 'the table keeps the next slate under it');
ok(/const LEG_CARD_TABS = new Set\(\['nhl', 'nba', 'nfl', 'soccer'\]\);/.test(src), 'the old top card stays off the tab: its own best card replaces it');
ok(/\/\/ The NHL, NBA, NFL and soccer tabs' best leg, moneyline cards and goalies are Picks' \(step 7\)\.\n\s+if \(state\.sport === 'nhl'\) renderNhl\(\);\n\s+if \(state\.sport === 'nba'\) renderNba\(\);\n\s+if \(state\.sport === 'nfl'\) renderNfl\(\);/.test(src), 'Picks arriving redraws the tab');
for (const c of ['leg-view', 'entry-size', 'leg-open']) {
  const body = (new RegExp(`case '${c}': \\{[\\s\\S]*?break;\\n\\s+\\}`).exec(src) || [''])[0];
  ok(/if \(state\.sport === 'nfl'\) renderNfl\(\);/.test(body), `${c} redraws the NFL tab too`);
}
ok(/nfl: 'nflMlGrid', soccer: 'soccerGrid' \}\[state\.sport\] \|\| 'picksGrid'/.test(src), 'the focus goes back to the name on the tab in view');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
