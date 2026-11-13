// The page trims of 2026-11-10 (the owner's "let's do the recommended", after a phone check found
// Picks eleven screens long). What has to hold:
//   1. the hero card: a moneyline's injury report takes a line a side, off the game line it ran
//      into once each name carried its place on the team
//   2. Most likely to land: each leg a short row (the pick, when, its chance; beside a moneyline
//      the gap its full bar names), which opens to the full leg and closes again. The entry cards
//      above still draw their legs in full
//   3. How the list did: the newest five days, the rest behind one button; the totals unchanged
//   4. MLB out of season: its tab sits after the sports that are playing, ahead of Entries, and
//      the board's controls give way to one line; a game on the slate brings the board back
//
// Real data: production's /api/picks at 12:57 AM Pacific on Nov 10, whole
// (tests/fixtures/picks-20261110.json): six legs on the list, fourteen days of history, the
// Heat @ Jazz injury report with roles. The real app.js's own functions, the real index.html
// and style.css.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(BOARD, f), 'utf8').replace(/\r\n/g, '\n');
const src = read('app.js'), html = read('index.html'), css = read('style.css');
const D = JSON.parse(read('tests/fixtures/picks-20261110.json'));
const RealDate = Date;
let NOW = RealDate.parse('2026-11-10T08:57:12Z');
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
function lift(name) {
  let at = src.indexOf(`function ${name}(`);
  const isConst = at < 0;
  if (isConst) at = src.indexOf(`const ${name} =`);
  if (at < 0) throw new Error(`app.js has no ${name}`);
  let depth = 0, seen = false;
  for (let i = at; i < src.length; i++) {
    const c = src[i];
    if (c === '{' || c === '(' || c === '[') { depth++; seen = true; }
    else if (c === '}' || c === ')' || c === ']') depth--;
    if (seen && depth === 0) {
      if (!isConst && c === '}') return src.slice(at, i + 1);
      if (isConst && (src[i + 1] === ';' || src[i + 1] === '\n')) return src.slice(at, i + 2);
    }
  }
  throw new Error(`could not close ${name}`);
}
const names = ['TEAM_COLORS', 'MLB_TEAM_ID', 'NHL_PHOTO_SEASON', 'headshotUrl', 'teamMarkUrl', 'initialsOf', 'avatarHtml', 'LEG_OFFERS', 'offerLeg',
  'PICK_BOARD', 'PICK_SPORT', 'pickLeg', 'pct0', 'AM', 'soccerKick', 'pickIsTeam', 'pickTeamCode', 'pickTeamTag', 'miniBar', 'projLineHtml', 'mlChanceLineHtml', 'pickBarHtml', 'RING_C', 'chanceRingSvg', 'pickFace', 'ptDayOf', 'pickMoved',
  'trendTag', 'readAgeTag', 'INJ_ROLE_WORD', 'injRoleText', 'injuryTag', 'goalieNote', 'trendBarsHtml', 'impPct', 'priceSparkHtml', 'LINK_BOOK', 'STATE_SLOT', 'betLinkHtml', 'legLink', 'stakeTxt', 'moneyTxt', 'pickEdgeHtml',
  'nbCdf', 'r1', 'ppLineOf', 'ppChanceAt', 'pickAtLine', 'ppLineStepHtml', 'pickLineSetTag', 'shortDay', 'recSinceText', 'heroInjLine', 'heroLegHtml',
  'likelyRowHtml', 'HIST_DAY_KEYS', 'HIST_DAYS_SHOWN', 'movedLineHtml', 'ppEntryRecordHtml', 'pickHistoryHtml', 'mlbInSeason', 'placeMlbTab', 'mlbOffSync'];
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
// The page, as much of it as the MLB pieces touch: the tab row in index.html's own order, the
// slate and its note.
const tabOrder = [...html.matchAll(/class="stab[^"]*"[^>]*data-sport="([a-z]+)"/g)].map((m) => m[1]);
let row = [], slateCls = new Set(), note = { hidden: true }, games = [];
const mkTab = (sport) => ({ dataset: { sport }, get nextElementSibling() { return row[row.indexOf(this) + 1] || null; },
  before(n) { row.splice(row.indexOf(n), 1); row.splice(row.indexOf(this), 0, n); } });
const resetPage = () => { row = tabOrder.map(mkTab); slateCls = new Set(); note = { hidden: true }; };
const document = {
  querySelector: (sel) => { const m = /^\.stab\[data-sport="([a-z]+)"\]$/.exec(sel); return m ? row.find((t) => t.dataset.sport === m[1]) || null : null; },
  getElementById: (id) => (id === 'slate' ? { classList: { toggle: (c, on) => { if (on) slateCls.add(c); else slateCls.delete(c); } } } : id === 'mlbOff' ? note : null),
};
const state = { slip: {} };
let F;
try {
  F = new Function('state', 'esc', 'document', 'slateGames', names.map(lift).join('\n')
    + '\nreturn { heroLegHtml, injuryTag, mlChanceLineHtml, pickLeg, pickFace, likelyRowHtml, pickHistoryHtml, shortDay, pct0, mlbInSeason, placeMlbTab, mlbOffSync, HIST_DAYS_SHOWN };')(state, esc, document, () => games);
} catch (e) { console.log(`  FAIL  the pieces lift out of app.js (${e.message})`); console.log('\n1 FAILED'); process.exit(1); }

console.log('-- 1. the hero card: a line a side --');
const heat = D.legs.find((x) => x.title === 'Heat ML');
const tag = F.injuryTag(heat);
const hero = F.heroLegHtml(heat, { link: true, sport: 'nba' });
const inj = (/<span class="hl-inj"[^>]*>([\s\S]*?)<\/span><\/span>/.exec(hero) || [])[0] || '';
const lines = [...inj.matchAll(/<span><b>([^<]+)<\/b>([^<]*)<\/span>/g)].map((m) => [m[1], m[2]]);
console.log('        ' + lines.map((l) => l[0] + l[1]).join('\n        '));
ok(tag.parts.length === 3 && lines.length === 3 && lines.map((l) => l[0]).join('|') === 'Heat GTD:|Jazz out:|Jazz GTD:', 'the Heat @ Jazz report is three lines, each led by its side: Heat GTD, Jazz out, Jazz GTD');
ok(lines.every((l, i) => esc(tag.parts[i]) === l[0] + l[1]), 'each line is the report\'s own, word for word, places and all');
const game = text((/<span class="hl-game">([\s\S]*?)<\/span>(?=<span class="hl-inj"|<span class="pp-projbar")/.exec(hero) || [])[1] || '');
console.log('        game line: ' + game);
ok(/^Heat @ Jazz/.test(game) && !/out:|GTD:/.test(game), 'and the game line under the name no longer carries it');
ok(new RegExp(`<span class="hl-inj" title="${esc(tag.title).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(hero), 'pressing it still gives the full report, every injury beside the place');
const suzuki = D.legs.find((x) => /Suzuki/.test(x.title));
ok(!/hl-inj/.test(F.heroLegHtml(suzuki, {})), 'a hockey leg has no such block');
const clear = F.heroLegHtml({ ...heat, inj: { ...heat.inj, teams: heat.inj.teams.map((t) => ({ ...t, out: [], gtd: [] })) } }, {});
ok(!/hl-inj/.test(clear) && /no injuries listed/.test(clear), 'the same game with nobody listed: "no injuries listed" on the game line, as before');
ok(/\.hl-inj \{ grid-column:1 \/ -1; display:grid;/.test(css), 'the lines span the card and stack');

console.log('\n-- 2. Most likely to land: short rows that open --');
const full = (foot) => `<li>FULL${foot}</li>`;
const rows = D.legs.map((x) => F.likelyRowHtml(x, false, full));
for (const r of rows) console.log('        ' + text(r));
ok(D.legs.length === 6 && rows.every((r, i) => r.startsWith('<li class="pk-lk"><button type="button" class="pk-lk-row" data-action="likely-toggle"')
  && r.includes(`data-leg="${esc(F.pickLeg(D.legs[i]).id)}"`) && r.includes('aria-expanded="false"')), 'each of the six legs is one button row, keyed by its leg, closed');
ok(rows.every((r, i) => r.includes(`<b>${esc(D.legs[i].title)}</b>`) && r.includes(`<span class="tc-p">${F.pct0(D.legs[i].p)}</span>`)), 'with its pick and its chance');
ok(rows.every((r) => !/pp-projbar|tb-boxes|tc-wait|tc-gap|pk-rec|tc-add/.test(r.replace(/class="pk-lk[^"]*"/g, ''))), 'and none of the full leg\'s bars, boxes, tags, record or star');
// The logo stays (2026-11-13, the owner's ask): the row leads with the same face the full leg has.
ok(rows.every((r, i) => r.includes(`aria-expanded="false">${F.pickFace(D.legs[i])}<span class="pk-lk-t">`)),
  'each row leads with its logo, or the player\'s face, the same one the full leg draws');
const rowOf = (title) => rows[D.legs.findIndex((l) => l.title === title)];
const markOf = (r) => (/<span class="hs hs-team"[^>]*><span class="hs-mono">[^<]*<\/span><img class="hs-img" src="([^"]+)"/.exec(r) || [])[1] || '';
console.log(`        Heat ${markOf(rowOf('Heat ML'))} · Magic ${markOf(rowOf('Magic ML'))}`);
ok(/teamlogos\/nba\/500\/mia\.png/.test(markOf(rowOf('Heat ML'))) && /teamlogos\/nba\/500\/orl\.png/.test(markOf(rowOf('Magic ML'))),
  "a moneyline row shows its team's mark: the Heat's and the Magic's logos");
ok(/<span class="hs"[^>]*><span class="hs-mono">NS<\/span><img class="hs-img" src="[^"]*nhl[^"]*"/.test(rowOf('Nick Suzuki Over 0.5 PTS')), "a player's row, the player's face: Suzuki's NHL photo");
ok(/ · <span class="pk-lk-g">-\d+ <b class="o">[\d.]+ short<\/b><\/span>/.test(rowOf('Heat ML')) && /\.pk-lk-g \{ white-space:nowrap; \}/.test(css),
  'the price and its gap wrap as one: the logo narrows the row, and "short" had begun a line of its own');
// A moneyline's gap, worked out here from its price and chance, and read off the full leg's bar.
for (const x of D.legs.filter((l) => /ML$/.test(l.title))) {
  const need = (x.odds < 0 ? -x.odds / (-x.odds + 100) : 100 / (x.odds + 100)) * 100;
  const short = Math.round((need - x.kellyP) * 10) / 10;
  const bar = text(F.mlChanceLineHtml(x));
  const r = text(F.likelyRowHtml(x, false, full));
  ok(short > 0 && r.includes(`${x.odds} ${short} short`) && bar.includes(`${short} points short`), `${x.title}: "${x.odds} ${short} short", the gap its full bar names (${(/[\d.]+ points short/.exec(bar) || [])[0]})`);
}
const better = { ...heat, odds: heat.books.reduce((b, k) => Math.max(b, k.price), -1e9) };
ok(/short<\/b>/.test(F.likelyRowHtml(better, false, full)), `at the best price any of its ${heat.books.length} books has (${better.odds}) the Heat are still short`);
const dog = { ...heat, odds: 150 };
ok(text(F.likelyRowHtml(dog, false, full)).includes(`+150 ${Math.round((heat.kellyP - 40) * 10) / 10} of edge`) && /<b class="u">/.test(F.likelyRowHtml(dog, false, full)), 'a price its chance beats reads "of edge", in the bar\'s green');
ok(D.legs.filter((l) => !/ML$/.test(l.title)).every((x) => { const r = text(F.likelyRowHtml(x, false, full)); return !/short|edge|[+-]\d{3}/.test(r) && r.includes('NHL') && r.includes(x.spec.team || '\u0000'); }),
  'a player leg: his team, the sport, the time, no price');
const opened = F.likelyRowHtml(heat, true, full);
ok(opened === `<li>FULL<button type="button" class="pk-lk-less" data-action="likely-toggle" data-leg="${esc(F.pickLeg(heat).id)}" aria-expanded="true">Show less</button></li>`, 'open: the full leg, its way back inside it');
const rp = lift('renderPicks');
ok(/const likelyRow = \(x\) => likelyRowHtml\(x, !!\(state\.likelyOpen && state\.likelyOpen\[pickLeg\(x\)\.id\]\), \(foot\) => legRow\(x, false, foot\)\);/.test(rp)
  && /<ol class="tc-legs pk-lks">\$\{legs\.map\(likelyRow\)\.join\(''\)\}<\/ol>/.test(rp), 'the list draws them, the open ones through the same full row as the entry\'s');
ok(/\+ `<\/div>\$\{foot \|\| ''\}<\/li>`;/.test(rp), 'which takes the way back as its foot');
ok(/ppLegs\.slice\(1\)\.map\(itemHtml\)/.test(rp) && /mlLegs\.map\(\(x\) => legRow\(x, true\)\)/.test(rp), 'the PrizePicks entry and the moneyline entry draw their legs as they did');
ok(/case 'likely-toggle': \{ const o = state\.likelyOpen \|\| \(state\.likelyOpen = \{\}\); const k = target\.dataset\.leg; if \(o\[k\]\) delete o\[k\]; else o\[k\] = true; renderPicks\(\); break; \}/.test(src),
  'a tap opens or closes that one leg, kept in state so a redraw leaves it');
ok(/\.pk-lk-row \{[^}]*min-height:48px/.test(css) && /\[data-theme="light"\] \.pk-lk-row \{ box-shadow:var\(--lift\); \}/.test(css), 'the row is a full-size tap target, lifted in light mode like the other cards');

console.log('\n-- 3. How the list did: five days, the rest behind a button --');
const H = D.record.history;
const dayDates = (h) => [...h.matchAll(/<details class="pk-day"><summary><span class="pk-dd"><b>([^<]+)<\/b>/g)].map((m) => m[1]);
const shut = F.pickHistoryHtml(H), all = F.pickHistoryHtml(H, true);
ok(H.days.length === 14 && F.HIST_DAYS_SHOWN === 5 && dayDates(shut).join('|') === H.days.slice(0, 5).map((d) => F.shortDay(d.date)).join('|'),
  `fourteen days graded or playing; the card shows the newest five (${dayDates(shut).join(', ')})`);
ok(/<button type="button" class="pk-days-more" data-action="days-all" aria-expanded="false">Show all 14 days<\/button>/.test(shut), 'and a button for all fourteen');
ok(dayDates(all).join('|') === H.days.map((d) => F.shortDay(d.date)).join('|') && /aria-expanded="true">Show the last 5 days<\/button>/.test(all), 'tapped: all fourteen, newest first, and the way back');
const upTo = (h) => h.slice(0, h.indexOf('<div class="pk-days">'));
ok(upTo(shut) === upTo(all) && /Top 2 Power/.test(upTo(shut)), 'the totals above them count every day either way');
const five = F.pickHistoryHtml({ ...H, days: H.days.slice(0, 5) });
ok(dayDates(five).length === 5 && !/pk-days-more/.test(five), 'with five days or fewer there is no button');
ok(/const after = socBestStripHtml\(\) \+ pickHistoryHtml\(d\.record && d\.record\.history, !!state\.daysAll\);/.test(src)
  && /case 'days-all': state\.daysAll = !state\.daysAll; renderPicks\(\); break;/.test(src), 'the tap is kept in state too');

console.log('\n-- 4. MLB out of season --');
ok(tabOrder.join(' ') === 'picks mlb nfl nba nhl soccer entries', `index.html's own row: ${tabOrder.join(' ')}`);
const order = () => row.map((t) => t.dataset.sport).join(' ');
resetPage(); games = [];
ok(F.mlbInSeason() === false, 'Nov 10: out of season');
F.placeMlbTab();
ok(order() === 'picks nfl nba nhl soccer mlb entries', `its tab moves behind the sports that are playing, ahead of Entries: ${order()}`);
F.placeMlbTab();
ok(order() === 'picks nfl nba nhl soccer mlb entries', 'and stays there on a second call');
F.mlbOffSync();
ok(slateCls.has('mlb-off') && note.hidden === false, 'no game on the slate: the board gives way to the one line');
games = [{ gamePk: 1 }];
F.mlbOffSync();
ok(!slateCls.has('mlb-off') && note.hidden === true, 'a game on the slate (a World Series night in November) brings the board back');
NOW = RealDate.parse('2027-07-04T19:00:00Z');
resetPage(); games = [];
F.placeMlbTab(); F.mlbOffSync();
ok(F.mlbInSeason() && order() === tabOrder.join(' ') && !slateCls.has('mlb-off') && note.hidden === true, 'July 4: the row as written, and an empty slate keeps the board\'s own words');
NOW = RealDate.parse('2026-11-10T08:57:12Z');
// The line, and what it hides, in the page itself.
const sAt = html.indexOf('<section id="slate"'), slate = html.slice(sAt, html.indexOf('</section>', sAt));
ok(/<div class="mlb-off-note" id="mlbOff" hidden><b>MLB is back in spring\.<\/b> No games to price until then\. Last season's record is below\.<\/div>/.test(slate), 'the line is in the MLB board, hidden until it is called for');
// Direct children of the slate: a tag walk, comments and void tags skipped.
const kids = [];
{ let depth = 0;
  const body = slate.replace(/<!--[\s\S]*?-->/g, '');
  for (const m of body.matchAll(/<(\/?)([a-zA-Z0-9]+)((?:"[^"]*"|[^>"])*)>/g)) {
    const [, close, tagName, attrs] = m;
    if (/^(input|br|img|hr|meta|link|path|circle|ellipse|line|rect)$/i.test(tagName) || /\/$/.test(attrs)) continue;
    if (close) { depth--; continue; }
    if (depth === 1) kids.push({ id: (/\bid="([^"]+)"/.exec(attrs) || [])[1] || '', cls: ((/\bclass="([^"]+)"/.exec(attrs) || [])[1] || '').split(/\s+/) });
    depth++;
  } }
const rule = (/#slate\.mlb-off > :is\(([^)]+)\) \{ display:none; \}/.exec(css) || [])[1] || '';
const sels = rule.split(',').map((s) => s.trim()).filter(Boolean);
const hits = (s) => kids.filter((k) => (s[0] === '#' ? k.id === s.slice(1) : k.cls.includes(s.slice(1))));
ok(sels.length >= 12 && sels.every((s) => hits(s).length > 0), `each of the ${sels.length} things the rule hides is a direct child of the slate${sels.filter((s) => !hits(s).length).length ? ' (missing: ' + sels.filter((s) => !hits(s).length).join(' ') + ')' : ''}`);
const hidden = new Set(sels.flatMap((s) => hits(s)));
const left = kids.filter((k) => !hidden.has(k)).map((k) => (k.id ? '#' + k.id : '.' + k.cls.join('.')));
console.log('        left showing: ' + left.join(' '));
ok(left.includes('#mlbOff') && left.includes('#topCard') && left.includes('#todayCard') && !left.some((k) => /board|tabrow|sec-head|how-priced/.test(k)), 'the line itself and the best-leg cards are left; no board furniture is');
const rb = lift('renderBoard');
ok(/renderSlateSummary\(\);\n    mlbOffSync\(\);/.test(rb) && /placeMlbTab\(\);\n  mlbOffSync\(\);/.test(src), 'set when the page loads and again on every draw of the board');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
