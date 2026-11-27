// The leg card on Picks (2026-11-16, step 2 of the page brief): the star on the
// left, the name with the pick beside it, the game line and its tags under
// them, the chance big on the right, then tiles for what used to be a run of
// chips -- the sharp books (or what a moneyline's price needs), the record for
// legs like this, and that record against the entry's break-even.
//
// Read on the Picks payload recorded on Nov 16 at 09:10 UTC (the one the
// preview drew): Jabari Smith Jr's blocks More, Derik Queen's rebounds Less
// above the sharp line, the Nuggets at -420.
//
//   node tests/legcard.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const src = read('app.js'), css = read('style.css');
const D = JSON.parse(read('tests/fixtures/picks-20261116-0040.json'));
const D14 = JSON.parse(read('tests/fixtures/picks-20261114-2200.json'));
const RealDate = Date;
const NOW = RealDate.parse(D.asOf);
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
// The text from `at` to the bracket that closes what it opens.
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
// legRow lives inside renderPicks.
const rp = lift('renderPicks');
const lrAt = rp.indexOf('const legRow = (x, compact, foot, best) =>');
const legRowSrc = lrAt < 0 ? null : closeFrom(rp, lrAt, true);
const names = ['TEAM_COLORS', 'MLB_TEAM_ID', 'NHL_PHOTO_SEASON', 'headshotUrl', 'teamMarkUrl', 'initialsOf', 'avatarHtml', 'LEG_OFFERS', 'offerLeg',
  'PICK_BOARD', 'PICK_SPORT', 'pickLeg', 'pct0', 'AM', 'soccerKick', 'pickIsTeam', 'pickTeamCode', 'pickTeamTag', 'miniBar', 'projLineHtml', 'mlChanceLineHtml', 'mlStakeTitle', 'pickBarHtml', 'RING_C', 'chanceRingSvg', 'pickFace', 'ptDayOf', 'pickMoved',
  'trendTag', 'readAgeTag', 'INJ_ROLE_WORD', 'injRoleText', 'injuryTag', 'goalieNote', 'PROP_MIN_MOVE', 'legMinutes', 'toiText', 'minutesTagHtml', 'trendBarsHtml', 'impPct', 'priceSparkHtml', 'LINK_BOOK', 'STATE_SLOT', 'betLinkHtml', 'legLink', 'stakeTxt', 'moneyTxt', 'pickEdgeHtml',
  'nbCdf', 'r1', 'ppLineOf', 'ppChanceAt', 'pickAtLine', 'ppLineStepHtml', 'pickLineSetTag', 'shortDay', 'recSinceText',
  'PP_BREAK_EVEN', 'BOOK_LABEL', 'bkLabel', 'booksHtml', 'PICK_SAME', 'pickGameKey', 'pickShortName', 'PICK_TOP', 'pickDayWord', 'PICK_OPEN', 'legCardHtml'];
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const state = { slip: {} };
let F;
try {
  if (!legRowSrc) throw new Error('renderPicks has no legRow(x, compact, foot, best)');
  F = new Function('state', 'esc', names.filter((n) => src.includes(`function ${n}(`) || src.includes(`const ${n} =`)).map(lift).join('\n')
    + `\n${legRowSrc}\nreturn { legRow, pickLeg, offerLeg, pct0, mlChanceLineHtml, trendBarsHtml, PICK_SAME, pickGameKey, pickShortName, PICK_TOP };`)(state, esc);
} catch (e) { console.log(`  FAIL  the card lifts out of app.js (${e.message})`); console.log('\n1 FAILED'); process.exit(1); }

const all = [...D.legs, ...D.ppPool, ...D.mlPool];
const leg = (t) => all.find((x) => x.title === t);
const jabari = leg('Jabari Smith Jr Over 0.5 BLK'), queen = leg('Derik Queen Under 6 REB'), nuggets = leg('Nuggets ML');
const tilesOf = (h) => [...h.matchAll(/<div class="lc-tile"(?: title="([^"]*)")?><span class="lc-tk">([^<]*)<\/span><b class="lc-tv([^"]*)">([^<]*)<\/b>(?:<span class="lc-ts">([\s\S]*?)<\/span>)?<\/div>/g)]
  .map((m) => ({ title: m[1] || '', key: m[2], cls: m[3].trim(), value: m[4], sub: text(m[5] || '') }));
const tile = (h, re) => tilesOf(h).find((t) => re.test(t.key)) || {};
const tagsOf = (h) => (/<span class="lc-tags">([\s\S]*?)<\/span><\/div><div class="lc-p">/.exec(h) || [])[1] || '';
for (const x of [jabari, queen, nuggets]) console.log(`        ${x.title}: p ${x.p}${x.sharp != null ? `, sharp ${x.sharp}, model ${x.modelP}` : ''}${x.odds != null ? `, ${x.odds}, kelly ${x.kellyP}` : ''}, record ${x.record.hit} of ${x.record.n} (${x.record.hitRate}%)`);

console.log('-- 1. the face of the card --');
const J = F.legRow(jabari, false);
console.log('        ' + text(J).slice(0, 160));
ok(J.startsWith('<li class="lc"><div class="lc-top"><button type="button" class="lc-star" data-action="leg-add"') && J.endsWith('</li>'), 'one card a leg, the star first');
ok(J.includes(`data-leg="${esc(F.pickLeg(jabari).id)}" aria-pressed="false" aria-label="Add ${esc(jabari.title)} to your slip">☆</button>`), 'the star adds that leg to the slip, and says so to a screen reader');
ok(/<span class="lc-name"><b>Jabari Smith Jr<\/b> <span class="lc-pick">Over 0\.5 BLK<\/span><\/span>/.test(J), 'the name, and the pick beside it: "Jabari Smith Jr" and "Over 0.5 BLK"');
ok(new RegExp(`<div class="lc-p"><b class="lc-pct">${F.pct0(jabari.p)}</b><span class="lc-pk">chance</span></div>`).test(J) && F.pct0(jabari.p) === '62%',
  `the chance Picks has always shown, big on the right: ${F.pct0(jabari.p)} (x.p, ${jabari.p})`);
ok(/<span class="lc-game">[\s\S]*<span class="pk-sport">NBA<\/span> · [^<]+ · <span class="pk-when">/.test(J), 'the game line under the name: team, sport, game, time');
const N = F.legRow(nuggets, false);
ok(/<span class="lc-name"><b>Nuggets<\/b> <span class="lc-pick">to win<\/span><\/span>/.test(N), 'a moneyline reads "Nuggets" and "to win"');
state.slip[F.offerLeg(F.pickLeg(jabari))] = true;
const Jon = F.legRow(jabari, false);
delete state.slip[F.offerLeg(F.pickLeg(jabari))];
ok(/class="lc-star on"/.test(Jon) && /aria-pressed="true" aria-label="Remove [^"]+ from your slip">★<\/button>/.test(Jon), 'on the slip: the star fills, and the label says it takes it off');

console.log('\n-- 2. tiles in place of the chips --');
const rec = (x) => ({ v: `${F.pct0(x.record.hitRate)} · ${x.record.hit} of ${x.record.n}`, d: Math.round((x.record.hitRate - 57.7) * 10) / 10 });
const jt = tilesOf(J), jr = rec(jabari);
console.log('        ' + jt.map((t) => `[${t.key}: ${t.value}${t.sub ? ' / ' + t.sub : ''}]`).join(' '));
ok(tile(J, /^Legs like this$/).value === jr.v && jr.v === '60% · 47 of 78', `the record for legs like this: "${jr.v}", the payload's own`);
ok(/since the rule \(Oct 27\): 31 of 55/.test(tile(J, /^Legs like this$/).sub), 'with its count since the rule changed, as the record line had it');
ok(tile(J, /^2-pick Power needs 57\.7%$/).value === `clears by ${jr.d}` && jr.d === 2.6 && tile(J, /2-pick/).cls === 'u', 'against a 2-pick Power\'s 57.7%: "clears by 2.6", in green');
ok(!tile(J, /^Sharp books$/).key, 'no sharp tile where the payload has no sharp chance (a blocks More)');
const Q = F.legRow(queen, false), qr = rec(queen);
console.log('        ' + tilesOf(Q).map((t) => `[${t.key}: ${t.value}${t.sub ? ' / ' + t.sub : ''}]`).join(' '));
ok(tile(Q, /^Sharp books$/).value === F.pct0(queen.sharp) && tile(Q, /^Sharp books$/).sub === `model ${F.pct0(queen.modelP)}`, `the sharp books' chance with the model's under it: ${F.pct0(queen.sharp)}, model ${F.pct0(queen.modelP)}`);
ok(tile(Q, /2-pick/).value === `record ${Math.abs(qr.d)} short` && qr.d === -5.1 && tile(Q, /2-pick/).cls === 'o', 'a record under the break-even: "record 5.1 short", in the warning colour');
ok(!/tc-sharp|>model \d+%</.test(tagsOf(Q)) && /PP \+0\.5 vs book/.test(tagsOf(Q)), 'the sharp and model chips leave the tags; "PP +0.5 vs book" stays');
// Its 56.1 is last season's rate for the kind (REB_GAP_P), not a blend: the tile's note says what it is.
ok(/last season/.test(tile(Q, /^Sharp books$/).title) && !/a quarter the model's/.test(tile(Q, /^Sharp books$/).title),
  "the rebounds leg's note says its chance is last season's rate for the kind, not a blend of these two");
const blended = { ...queen, kind: 'nba_pp', p: Math.round((0.25 * queen.modelP + 0.75 * queen.sharp) * 10) / 10 };
ok(/a quarter the model's and three quarters the sharp books'/.test(tile(F.legRow(blended, false), /^Sharp books$/).title), 'an unders leg keeps the blend note');
const same = { ...queen, kind: 'nba_pp', modelP: queen.p };
ok(tile(F.legRow(same, false), /^Sharp books$/).sub === 'at this line', 'no model figure where it is the chance itself: "at this line"');

console.log('\n-- 3. a moneyline: what its price needs --');
// Measured from the chance shown since 2026-11-27 (tests/mlgap.mjs): the Nuggets' 79.5 is both.
const need = 420 / 520 * 100, gap = Math.round((nuggets.p - need) * 10) / 10;
const nt = tile(N, /^Book at -420 needs$/);
console.log(`        [${nt.key}: ${nt.value} / ${nt.sub}]`);
ok(nt.value === `${Math.round(need * 10) / 10}%` && nt.value === '80.8%', '-420 needs 80.8%');
ok(nt.sub === `${Math.abs(gap)} short` && gap === -1.3 && /<span class="lc-ts"><span class="o">1\.3 short<\/span>/.test(N), `and the Nuggets' ${nuggets.p} sits 1.3 short of it`);
const mlBar = text(F.mlChanceLineHtml(nuggets));
ok(mlBar.includes('1.3 points short') && !N.includes(F.mlChanceLineHtml(nuggets)), 'the gap the old bar drew ("1.3 points short"), now a tile; the bar itself is gone');
const dog = { ...nuggets, odds: 150 };
ok(tile(F.legRow(dog, false), /^Book at \+150 needs$/).value === '40%' && /<span class="u">39\.5 of edge<\/span>/.test(F.legRow(dog, false)), 'at +150: needs 40%, "39.5 of edge" in green');
ok(tile(N, /^Legs like this$/).value === rec(nuggets).v && tile(N, /2-pick/).value === `clears by ${rec(nuggets).d}`, `its record and the break-even, as a prop's: ${rec(nuggets).v}, clears by ${rec(nuggets).d}`);
const jag = D14.legs.find((x) => x.title === 'Jaguars ML');
const JG = F.legRow(jag, false);
ok(!jag.record.proven && tile(JG, /^Legs like this$/).cls === 'thin' && /new$/.test(tile(JG, /^Legs like this$/).sub), "a record still short of proven is dimmed and marked new (the NFL's 17 of 21)");

console.log('\n-- 4. the entry size sets the break-even --');
state.entrySize = 6;
const J6 = F.legRow(jabari, false), Q6 = F.legRow(queen, false);
delete state.entrySize;
ok(tile(J6, /^6-pick Flex needs 54\.2%$/).value === 'clears by 6.1' && tile(Q6, /^6-pick Flex needs 54\.2%$/).value === 'record 1.6 short', 'a 6-pick Flex: Jabari clears 54.2% by 6.1, Queen\'s record is 1.6 short');
ok(!!tile(J, /^2-pick Power needs 57\.7%$/).key, 'with none picked yet, the 2-pick Power');

console.log('\n-- 5. what opens under the tiles --');
const more = (h) => (/<div class="lc-more">([\s\S]*?)<\/div>(?=<div class="pp-step|<\/li>|$)/.exec(h) || [])[1] || '';
ok(/pp-projbar/.test(J) && J.includes(F.trendBarsHtml(jabari.trend)), 'a full card keeps the projection bar and the last ten games');
ok(/class="sp-line pp-line"/.test(Q) && /data-action="pp-line"/.test(Q) && !/sp-line pp-line/.test(J), 'the rebounds leg keeps its line stepper ("PP shows − 6 +"); the blocks leg has none');
const NC = F.legRow(nuggets, true), JC = F.legRow(jabari, true);
// compact is the Simple view since step 4: the top row alone.
ok(!/lc-more|lc-tiles/.test(NC) && !/lc-more|lc-tiles|sp-line/.test(JC) && tilesOf(NC).length === 0, 'Simple (compact): the top row alone, no tiles, nothing under them');
ok(NC.includes('<b class="lc-pct">80%</b>') && /<span class="lc-name"><button type="button" class="lc-nb" data-action="leg-open"[^>]*><b>Nuggets<\/b>/.test(NC) && /data-action="leg-add"/.test(NC), 'and that row keeps the star, the name and pick, and the chance');
ok(/<span class="tc-gap"[^>]*>over in 7 of last 10<\/span>/.test(tagsOf(JC)) && !/over in 7 of last 10/.test(tagsOf(J)), "his run against the line is a tag in Simple, where his last games aren't drawn");
ok(/pk-books/.test(N) && !/pk-books/.test(NC), 'every book folds under a full moneyline card');

console.log('\n-- 6. today\'s legs: one list, a size to read it at (step 3) --');
// Nov 14's 00:04 payload has Seth Jarvis's points More in the PrizePicks pool and the Hurricanes in
// the moneyline pool: the same game, Kraken @ Hurricanes.
const D4 = JSON.parse(read('tests/fixtures/picks-20261114-0004.json'));
const jarvis = D4.ppPool.find((x) => /^Seth Jarvis/.test(x.title)), canes = D4.mlPool.find((x) => x.title === 'Hurricanes ML');
ok(F.pickGameKey(jarvis) === F.pickGameKey(canes) && F.pickGameKey(jarvis) !== F.pickGameKey(D4.ppPool[0]), 'a player leg and a moneyline from one game share its key (the feed\'s game id)');
F.PICK_SAME.set(F.pickLeg(jarvis).id, F.pickShortName(canes));
const JV = F.legRow(jarvis, false);
F.PICK_SAME.clear();
console.log('        ' + (/<span class="tc-wait"[^>]*>(Same game as [^<]+)</.exec(JV) || [])[1]);
ok(/<span class="tc-wait" title="Legs from one game tend to land or miss together">Same game as Hurricanes<\/span>/.test(tagsOf(JV)), 'the second leg from a game says whose game it shares, in amber');
ok(!/Same game/.test(F.legRow(jarvis, false)), 'and only while the list has the other one');
const rpSrc = rp;
ok(/for \(const x of \[\.\.\.ppLegs, \.\.\.mlLegs, \.\.\.legs\]\) \{\n\s+const id = x\.legId \|\| x\.title;\n\s+if \(seenLeg\.has\(id\)\) continue;/.test(rpSrc) && /\(pickIsTeam\(x\) \? allMls : allProps\)\.push\(x\);/.test(rpSrc),
  'the PrizePicks pool, the moneyline pool and the likeliest legs, each once, a team pick among the moneylines');
ok(/const byChance = \(a, b\) => \(b\.p \|\| 0\) - \(a\.p \|\| 0\);/.test(rpSrc) && /const sortKey = \['record', 'time'\]\.includes\(state\.legSort\) \? state\.legSort : 'chance';/.test(rpSrc), 'best chance first in each group, until another order is picked');
ok(/\[2, 3, 4, 5, 6\]\.map\(\(n\) => `<button type="button" class="pk-sz\$\{n === size \? ' on' : ''\}" data-action="entry-size" data-n="\$\{n\}" aria-pressed="\$\{n === size\}">\$\{n\}<\/button>`\)/.test(rpSrc)
  && /Entry size · \$\{esc\(sizeName\)\} needs \$\{sizeBe\[1\]\}% a leg/.test(rpSrc), 'five buttons, 2 to 6, the chosen one pressed, its break-even named above them');
ok(/Entry size only changes the break-even on each leg\. Every prop and moneyline stays listed\./.test(rpSrc), 'and it says no leg leaves the list');
ok(/case 'entry-size': \{\n\s+const n = Number\(target\.dataset\.n\);\n\s+if \(PP_BREAK_EVEN\[n\]\) \{ state\.entrySize = n; try \{ localStorage\.setItem\('aimplified_entry_size', String\(n\)\);/.test(src)
  && /const n = Number\(localStorage\.getItem\('aimplified_entry_size'\)\);\n\s+if \(n >= 2 && n <= 6\) state\.entrySize = n;/.test(src), 'a tap sets it and keeps it for the next visit');
ok(/\.pk-sz \{[^}]*min-height:44px;/.test(css) && /\.pk-sz\.on \{[^}]*border-color:var\(--accentFill\);[^}]*background:var\(--tintAccent\);/.test(css), 'the buttons are 44px, the chosen one gold');

console.log('\n-- 7. Simple or Detailed, a sport, an order (step 4) --');
ok(/case 'leg-view': \{\n\s+state\.legView = target\.dataset\.view === 'simple' \? 'simple' : 'detailed';\n\s+try \{ localStorage\.setItem\('aimplified_leg_view', state\.legView\); \}/.test(src)
  && /const v = localStorage\.getItem\('aimplified_leg_view'\);\n\s+if \(v === 'simple' \|\| v === 'detailed'\) state\.legView = v;/.test(src), 'the reader\'s choice of view is kept for the next visit');
ok(/const pickLegView = \(\) => state\.legView \|\| \(window\.matchMedia && window\.matchMedia\('\(max-width: 640px\)'\)\.matches \? 'simple' : 'detailed'\);/.test(src),
  'until they choose: Simple on a phone, Detailed on a wide screen');
ok(/const simple = pickLegView\(\) === 'simple';\n\s+const itemHtml = \(x\) => legRow\(x, simple\);/.test(rpSrc) && /\(best \? legRow\(best, false, '', true\)/.test(rpSrc),
  'every list card follows it; the best leg stays in full');
ok(/data-action="leg-view" data-view="\$\{v\}" aria-pressed="\$\{v === view\}"/.test(rpSrc), 'two buttons, the one in force pressed');
ok(/const sports = \['nba', 'nhl', 'nfl', 'soccer', 'mlb'\]\.filter\(\(s\) => \[\.\.\.allProps, \.\.\.allMls\]\.some\(\(x\) => x\.sport === s\)\);/.test(rpSrc)
  && /const sport = sports\.includes\(state\.legSport\) \? state\.legSport : 'all';/.test(rpSrc), 'the filter offers the sports on the list, and falls back to all of them');
ok(/const props = allProps\.filter\(shown\)\.sort\(byChance\);\n\s+const best = props\[0\] \|\| null;\n\s+const rest = props\.slice\(1\)\.sort\(bySort\);\n\s+const mls = allMls\.filter\(shown\)\.sort\(bySort\);/.test(rpSrc),
  'the large card is the best prop by chance; the order is the rest\'s, props and moneylines each');
const sortSrc = (/const bySort = [\s\S]*?: byChance;/.exec(rpSrc) || [''])[0];
const hitOf = (x) => (x.record && typeof x.record.hitRate === 'number' && x.record.n ? x.record.hitRate : -1);
const byChance = (a, b) => (b.p || 0) - (a.p || 0);
const sortWith = (key) => new Function('sortKey', 'hitOf', 'byChance', `${sortSrc}\nreturn bySort;`)(key, hitOf, byChance);
const pool = [...D.mlPool];
const byTime = pool.slice().sort(sortWith('time')).map((x) => x.commence);
ok(byTime.every((t, i) => i === 0 || Date.parse(byTime[i - 1]) <= Date.parse(t)), `Start time: earliest first (${byTime.map((t) => t.slice(11, 16)).join(', ')})`);
const recPool = [jabari, queen, nuggets, jag];
ok(recPool.slice().sort(sortWith('record')).map((x) => x.record.hitRate).join(',') === '81,80.9,60.3,52.6', 'Legs like this: the best record first (81, 80.9, 60.3, 52.6)');
ok(/if \(t\.dataset\.action === 'leg-sport'\) \{ state\.legSport = t\.value \|\| 'all'; renderPicks\(\); \}/.test(src) && /if \(t\.dataset\.action === 'leg-sort'\) \{ state\.legSort = t\.value \|\| 'chance'; renderPicks\(\); \}/.test(src),
  'either one redraws the list, and the slip keeps what is starred');
ok(/\.pk-vw \{[^}]*min-height:44px;/.test(css) && /\.pk-sel \{[^}]*height:44px;/.test(css), 'the buttons and the dropdowns are 44px');

console.log('\n-- 8. the styles --');
ok(/\.lc-star \{[^}]*width:44px;[^}]*height:44px;/.test(css), 'the star is a 44px target');
ok(/\.lc-tiles \{[^}]*grid-template-columns:repeat\(auto-fit, ?minmax\(140px, ?1fr\)\)/.test(css), 'tiles sit side by side and wrap at 140px');
ok(/\.lc-pct \{[^}]*font-family:var\(--display\)/.test(css) && /@media \(max-width:520px\) \{[^@]*\.lc-pct \{ font-size:28px; \}/.test(css), 'the chance in the display face, a size down on a phone');
ok(/\[data-theme="light"\] \.pk-card \.tc-legs li\.lc \{ box-shadow:var\(--lift\); \}/.test(css), 'lifted off the page in light');
ok(!/#[0-9a-fA-F]{3,8}\b/.test((css.slice(css.indexOf('li.lc')) || '')), 'colours from the theme tokens only');

console.log('\n-- 9. step 6: today\'s best leg, the card at full size --');
// The mock's big card: gold border, always open, the game across the top, four tiles (projection,
// legs like this, break-even, market), the last games, and a full-width button for the slip.
state.entrySize = 2;
const B = F.legRow(jabari, true, '', true);
ok(/^<article class="lc lc-best" aria-labelledby="lcBestH"><div class="lc-bh"><h3 class="lc-kick" id="lcBestH">Today’s best leg<\/h3>/.test(B) && B.endsWith('</article>'),
  'an article of its own, "Today’s best leg": Jabari plays at 4:40 PM PT on Nov 16, read at 1:10 AM that day');
ok(/<span class="lc-meta"><b class="tc-team">HOU<\/b> · <span class="pk-sport">NBA<\/span> · Rockets @ Heat · <span class="pk-when">/.test(B), 'the game across the top');
ok(!/class="lc-star/.test(B) && /<button type="button" class="lc-add" data-action="leg-add" data-leg="[^"]+" aria-pressed="false">Add to slip<\/button><\/article>$/.test(B),
  'no star: a full-width "Add to slip"');
ok(/<b class="lc-bn">Jabari Smith Jr<\/b><span class="lc-bp">Over 0\.5 BLK<\/span>/.test(B) && /<b class="lc-pct">62%<\/b><span class="lc-pk">chance<\/span>/.test(B), 'his name large, the pick under it, the chance');
ok(/class="lc-tiles"/.test(B) && /class="lc-more"/.test(B), 'always open: Simple does not fold it');
const bt = tilesOf(B);
ok(bt.map((t) => t.key).join(' | ') === 'Projection | Legs like this | 2-pick Power needs 57.7% | Market', `four tiles in the mock's order: ${bt.map((t) => t.key).join(' | ')}`);
ok(tile(B, /^Projection/).value === '1 vs line 0.5' && tile(B, /^Projection/).sub === '0.5 cushion', 'projection 1 against a 0.5 line: 0.5 of cushion');
ok(tile(B, /^Market/).value === 'PrizePicks 0.5' && tile(B, /^Market/).sub === 'no sharp price at this line', 'no sharp book on his blocks: the market tile says so');
const QB = F.legRow(queen, false, '', true);
ok(tile(QB, /^Projection/).value === '5.7 vs line 6' && tile(QB, /^Projection/).sub === '0.3 cushion', 'an Under: 5.7 projected under a 6 line is 0.3 of cushion');
ok(tile(QB, /^Market/).value === 'PrizePicks 6' && tile(QB, /^Market/).sub === 'sharp books 45% · model 51%' && /last season's rate for rebounds Less/.test(tile(QB, /^Market/).title),
  'the sharp books on the market tile, with the note on what the chance is');
ok(!tilesOf(QB).some((t) => t.key === 'Sharp books'), 'and not twice');
ok(/data-action="pp-line"/.test(QB), 'a rebounds Less keeps its line stepper');
const wrong = F.legRow({ ...jabari, proj: 0.3 }, false, '', true);
ok(tile(wrong, /^Projection/).sub === '0.2 under the line' && tile(wrong, /^Projection/).cls === 'o', 'a projection on the wrong side says by how much, in amber');
// The tile in the bar's own numbers (2026-11-19): Bouchard's card read "1.1 vs line 0.5, 0.6
// cushion" over the bar's "proj 1.05 · line 0.5 · 0.55 cushion". Matthew Tkachuk's assists More in
// the pool recorded Nov 14 at 22:00 UTC, projected 1.09, is the same case.
const tkc = D14.ppPool.find((x) => x.title === 'Matthew Tkachuk Over 0.5 AST');
const TK = F.legRow(tkc, false, '', true);
ok(tile(TK, /^Projection/).value === '1.09 vs line 0.5' && tile(TK, /^Projection/).sub === '0.59 cushion' && text(TK).includes('proj 1.09 · line 0.5 · 0.59 cushion'),
  `Tkachuk's 1.09 against 0.5: the tile says what the bar under it says (tile "${tile(TK, /^Projection/).value}, ${tile(TK, /^Projection/).sub}")`);
state.slip[F.offerLeg(F.pickLeg(jabari))] = true;
ok(/class="lc-add on" data-action="leg-add" data-leg="[^"]+" aria-pressed="true">On your slip · tap to remove<\/button>/.test(F.legRow(jabari, false, '', true)), 'on the slip: "On your slip · tap to remove"');
delete state.slip[F.offerLeg(F.pickLeg(jabari))];
const L = F.legRow(jabari, false);
ok(/^<li class="lc">/.test(L) && !tilesOf(L).some((t) => /^Projection|^Market/.test(t.key)), 'the list cards stay as they were: no projection or market tile');
F.PICK_TOP.ml = F.pickLeg(nuggets).id;
ok(/<span class="lc-tags"><span class="lc-bestml">Today’s best moneyline<\/span>/.test(F.legRow(nuggets, false)), 'the best moneyline is tagged first');
ok(!/lc-bestml/.test(F.legRow(jabari, false)), 'and only it');
F.PICK_TOP.ml = null;
ok(/PICK_TOP\.ml = mls\.length \? pickLeg\(\[\.\.\.mls\]\.sort\(byChance\)\[0\]\)\.id : null;/.test(rp), 'by chance, whatever the sort');
ok(/\.lc-best \{[^}]*border:1px solid var\(--accentFill\);/.test(css) && /\.lc-add \{[^}]*min-height:48px;/.test(css), 'gold border; a 48px button');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
