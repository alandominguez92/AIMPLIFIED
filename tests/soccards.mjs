// The leg card on the soccer tab (2026-11-17, the page brief's step 7: "Roll the leg card out to NHL,
// then NBA, NFL, Soccer. Keep stat buttons and Hot players"; the owner: "do soccer next"). The tab in
// the NHL, NBA and NFL tabs' order: today's legs, the props card with its stat buttons, the
// moneylines over every fixture's prices, Hot players. What has to hold:
//   - soccer's props stay off Picks (the owner's call), so its legs are Picks' favourites to win: the
//     best one large, the others as the moneylines' cards, none drawn twice, each Picks' own
//   - "Most likely to win" gives way to them: its record is the tab's first line
//   - a day with none, and Picks not loaded yet, say so
//   - the league buttons stay above the tab: they filter the props card and the table both
//
// Read on the Picks payload recorded at 00:04 PT Nov 14 (Norway 77.9 and Sweden 66.7 to win in the
// Nations League, 17:00 and 19:45 UTC) and the favourites' record read at 01:31 PT Nov 17 (279-203).
//
//   node tests/soccards.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const src = read('app.js');
const PK = JSON.parse(read('tests/fixtures/picks-20261114-0004.json'));
const TR = JSON.parse(read('tests/fixtures/track-soccerfav-20261117.json'));
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
  'trendTag', 'readAgeTag', 'INJ_ROLE_WORD', 'injRoleText', 'injuryTag', 'goalieNote', 'PROP_MIN_MOVE', 'legMinutes', 'toiText', 'minutesTagHtml',
  'trendBarsHtml', 'impPct', 'priceSparkHtml', 'LINK_BOOK', 'STATE_SLOT', 'betLinkHtml', 'legLink', 'stakeTxt', 'moneyTxt', 'pickEdgeHtml',
  'nbCdf', 'r1', 'ppLineOf', 'ppChanceAt', 'pickAtLine', 'ppLineStepHtml', 'pickLineSetTag', 'shortDay', 'recSinceText',
  'PP_BREAK_EVEN', 'BOOK_LABEL', 'bkLabel', 'booksHtml', 'PICK_SAME', 'pickGameKey', 'pickShortName', 'PICK_TOP', 'pickDayWord', 'PICK_OPEN', 'legCardHtml',
  'sameGameMap', 'pickLegView', 'tabLegViewHtml', 'tabLegSizeHtml', 'tabTodayHtml', 'tabMlHtml', 'tabMlCardLegs', 'socTodayParts', 'socRecordHtml'];
const state = { slip: {}, picks: PK, legView: 'detailed', entrySize: 6, ppLines: {}, trackRecord: TR };
let F;
try {
  if (!/function socTodayParts\(/.test(src)) throw new Error('app.js has no socTodayParts');
  F = new Function('state', 'esc', names.map(lift).join('\n') + '\nreturn { socTodayParts, socRecordHtml };')(state, esc);
} catch (e) { console.log(`  FAIL  the soccer cards lift out of app.js (${e.message})`); console.log('\n1 FAILED'); process.exit(1); }
const cards = (h) => h.split('<li class="lc').slice(1);
const nameOf = (h) => (/<b>([^<]+)<\/b>/.exec(h) || [])[1];
const tilesOf = (h) => [...h.matchAll(/<div class="lc-tile"(?: title="[^"]*")?><span class="lc-tk">([^<]*)<\/span><b class="lc-tv[^"]*">([^<]*)<\/b>(?:<span class="lc-ts">([\s\S]*?)<\/span>)?<\/div>/g)]
  .map((m) => `${m[1]}: ${m[2]}${m[3] ? ` (${text(m[3])})` : ''}`);
const pkAll = [...PK.legs, ...(PK.mlPool || [])];

console.log('-- 1. today\'s legs: the best favourite Picks lists, large --');
let parts = F.socTodayParts();
const best = (/<article class="lc lc-best"[\s\S]*?<\/article>/.exec(parts.top) || [''])[0];
ok(parts.top.startsWith('<section class="nba-pp pk-card pk-today tab-legs" aria-labelledby="soccerTodayH">') && /<h2 class="pk-h2" id="soccerTodayH">Today’s legs<\/h2>/.test(parts.top),
  'a "Today\'s legs" section, as on Picks and the other tabs');
ok(/data-action="leg-view" data-view="simple"/.test(parts.top) && /<span class="pk-tl" id="soccerSizeLbl">Entry size · 6-pick Flex needs 54\.2% a leg<\/span>/.test(parts.top), 'Simple / Detailed and the entry size');
ok(/Soccer props stay off Picks: the props card is under this\./.test(parts.top), 'it says why there is no prop in it');
ok(/<h3 class="lc-kick" id="lcBestH-soccer">Best Soccer leg still open<\/h3>/.test(best) && /<b class="lc-bn">Norway<\/b><span class="lc-bp">to win<\/span>/.test(best),
  'the large card: "Best Soccer leg still open", Norway to win');
console.log('        ' + tilesOf(best).join(' | '));
const norway = pkAll.find((x) => x.title === 'Norway ML');
ok(/<b class="lc-pct">78%<\/b>/.test(best) && norway.p === 77.9 && /Nations League/.test(best), "Picks' own chance, 77.9, and the league on its game line");
ok(tilesOf(best).some((t) => /^Legs like this: \d+% · \d+ of \d+/.test(t)) && tilesOf(best).some((t) => /^Book at -\d+ needs/.test(t)), "its tiles: the price's break-even and how legs like it landed, Picks' record");

console.log('\n-- 2. the moneylines: the other favourites, over the table --');
const ml = parts.ml('<div class="board">TABLE</div>');
console.log('        ' + cards(ml).map(nameOf).join(' | '));
ok(ml.startsWith('<section class="nba-pp pk-card pk-today tab-legs tab-ml" aria-labelledby="soccerMlH">') && cards(ml).map(nameOf).join() === 'Sweden',
  'Sweden as a card, Norway not twice');
ok(ml.indexOf('Every game’s price') > ml.indexOf('Sweden') && ml.endsWith('<div class="board">TABLE</div></section>'), "every fixture's prices under it");
ok(!/lc-bestml/.test(ml + parts.top), 'no "best moneyline" tag: the best one is the large card');

console.log('\n-- 3. a day with none, and before Picks --');
NOW = RealDate.parse('2026-11-14T20:00:00Z');
parts = F.socTodayParts();
ok(text(parts.top).includes('No soccer favourite on Picks yet: it lists the fixtures kicking off within a day, at 65%+.') && !/lc-best/.test(parts.top), 'both kicked off: the tab says none, and why');
ok(text(parts.ml('')).includes('No favourite at 65%+ in the fixtures kicking off within a day.'), 'the moneylines too');
NOW = RealDate.parse(PK.asOf);
state.picks = null;
parts = F.socTodayParts();
ok(text(parts.top).includes('The soccer legs show once Picks has loaded.') && text(parts.ml('')).includes('The moneylines that clear the bar show once Picks has loaded.'), 'before Picks has loaded: says it will show');
state.picks = PK;

console.log('\n-- 4. the favourites\' record, as "Most likely to win" had it --');
console.log('        ' + text(F.socRecordHtml()));
ok(F.socRecordHtml() === '<p class="soc-note">Favourites so far <b>279–203</b> · +18.4u, tracked from Sep 26.</p>', 'the tab\'s first line');
state.trackRecord = null;
ok(text(F.socRecordHtml()) === 'Favourites tracked from Sep 26.', 'before the record has loaded');

console.log('\n-- 5. the tab, in order --');
const grid = src.slice(src.indexOf('function renderSoccerGrid('), src.indexOf('function socTodayParts('));
ok(/const tab = \(table\) => socRecordHtml\(\) \+ parts\.top \+ socPropsCardHtml\(\) \+ parts\.ml\(table\) \+ hotCardHtml\('soccer'\);/.test(grid),
  'the record, today\'s legs, the props card, the moneylines over the table, Hot players');
ok((grid.match(/el\.soccerGrid\.innerHTML = tab\(/g) || []).length === 3 && !/soccerFavCard\(/.test(grid), 'every state draws it so (no lines, no fixture, the table); "Most likely to win" off it');
ok(/const LEG_CARD_TABS = new Set\(\['nhl', 'nba', 'nfl', 'soccer'\]\);/.test(src), "the tab's old top card is off it");
const rp = src.slice(src.indexOf("The NHL, NBA, NFL and soccer tabs' best leg"));
ok(/^The NHL, NBA, NFL and soccer tabs' best leg[^\n]*\n(\s+if \(state\.sport === '\w+'\) render\w+\(\);\n){3}\s+if \(state\.sport === 'soccer'\) renderSoccer\(\);/.test(rp), 'redrawn when Picks loads');
ok(/case 'leg-view': \{[\s\S]*?if \(state\.sport === 'soccer'\) renderSoccer\(\);[\s\S]*?break;/.test(src) && /case 'leg-open': \{[\s\S]*?if \(state\.sport === 'soccer'\) renderSoccer\(\);/.test(src)
  && /state\.entrySize = n;[^\n]*if \(state\.sport === 'soccer'\) renderSoccer\(\);/.test(src), 'and on Simple / Detailed, a tap to open a leg, the entry size');
ok(/soccer: 'soccerGrid' \}\[state\.sport\]/.test(src), 'a tapped name keeps the focus on the soccer tab');
const html = read('index.html');
ok(html.indexOf('id="soccerLeagues"') < html.indexOf('id="soccerGrid"'), 'the league buttons above it all: they filter the props card and the table');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
