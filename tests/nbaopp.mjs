// Who an NBA player is playing against, on the NBA tab (2026-11-05).
//
// The owner: "it doesn't show the team they are facing, only the team they play
// for." A leg carries ESPN's team code and the odds feed's full names, and nothing
// ties the two together: "NY" is the Knicks, "UTAH" the Jazz, "NO" the Pelicans. So
// the page holds the thirty codes. What has to hold:
//   - every real game and code pair names the other team, away with an @, home with a v
//   - a code the page doesn't know still shows the game, rather than nothing or a guess
//   - both lists on the tab say it: the unders and the Blocks Mores
// (The NHL's Mores, drawn by the same list, since the same day: tests/nhlopp.mjs.)
//
// Real data: every pair /api/nba-pp sent on Nov 4-5, 2026
// (tests/fixtures/nba-pp-opp-20261105.json), and its legs of the morning of Nov 4
// on the card (tests/fixtures/nba-pp-bands-20261104.json).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.join(HERE, '..');
const { pairs } = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'nba-pp-opp-20261105.json'), 'utf8'));
const b = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'nba-pp-bands-20261104.json'), 'utf8'));

const NOW = Date.parse('2026-11-04T20:00:00Z');
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
const ui = { nbaPp: b, slip: {} };
const CARD = ['TEAM_COLORS', 'MLB_TEAM_ID', 'NHL_PHOTO_SEASON', 'headshotUrl', 'teamMarkUrl', 'initialsOf', 'avatarHtml',
  'miniBar', 'projLineHtml', 'LEG_OFFERS', 'offerLeg', 'ptDayOf', 'soccerKick', 'AM', 'MARKET_SHORT', 'NBA_ROTATION_MIN', 'NBA_MK', 'NHL_MK', 'nbaPpLeg', 'nbaOversLineHtml', 'ppMovedTag',
  'ppCloseLineHtml', 'dfsLinesHtml', 'sharpTag', 'ppBookLine', 'ppGameLineHtml', 'PP_MORE_MIN', 'ppMoreP', 'ppMoreMk', 'ppMoreLeg', 'ppMoreTop', 'ppMoreListHtml',
  'shortDay', 'recSinceText', 'ppMoreLineHtml', 'nbaBlkMoreHtml', 'nbCdf', 'r1', 'pct0', 'PP_LINE_MARKETS', 'ppLineOf', 'ppChanceAt', 'nbaLegAtLine', 'readAgeTag', 'INJ_ROLE_WORD', 'injRoleText', 'injuryTag', 'nbaCardInjTag', 'ppLineTags', 'ppLineStepHtml',
  'NBA_BANDS', 'NBA_BAND_MIN', 'nbaBandLandedHtml', 'nbaNick', 'NBA_CODE_NICK', 'NHL_CODE_NICK', 'legOppText', 'nbaPpCardHtml'];
let C;
try {
  C = new Function('state', 'esc', CARD.map(lift).join('\n') + '\nreturn { NBA_CODE_NICK, legOppText, nbaPpCardHtml, ppMoreListHtml };')(ui, esc);
} catch (e) { console.log(`  FAIL  the card lifts out of app.js (${e.message})`); process.exit(1); }
const text = (h) => h.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

console.log('\n-- every pair the feed really sent --');
const sent = new Set(pairs.map((x) => x.team));
ok(sent.size === 28, `${pairs.length} pairs, ${sent.size} team codes (no Warriors or Magic in those two days)`);
let wrong = 0;
for (const x of pairs) {
  const [away, home] = x.game.split(' @ ');
  const said = C.legOppText(x);
  const nick = (n) => n.split(' ').pop();
  const want = C.NBA_CODE_NICK[x.team] === nick(home) ? `v ${nick(away)}` : `@ ${nick(home)}`;
  if (said !== want || !C.NBA_CODE_NICK[x.team] || ![nick(away), nick(home)].includes(C.NBA_CODE_NICK[x.team])) { wrong++; console.log(`        ${x.team} in ${x.game}: "${said}"`); }
}
ok(!wrong, `each names the other team, and no code sat on a game without its nickname (${wrong} wrong)`);
ok(Object.keys(C.NBA_CODE_NICK).length === 30 && C.NBA_CODE_NICK.GS === 'Warriors' && C.NBA_CODE_NICK.ORL === 'Magic', 'all thirty, with the two those days did not play');

console.log('\n-- the odd ones --');
const say = (team, game) => C.legOppText({ team, game });
ok(say('NY', 'Chicago Bulls @ New York Knicks') === 'v Bulls', 'NY at home: v Bulls');
ok(say('CHI', 'Chicago Bulls @ New York Knicks') === '@ Knicks', 'CHI away: @ Knicks');
ok(say('UTAH', 'Utah Jazz @ New Orleans Pelicans') === '@ Pelicans', 'UTAH away: @ Pelicans');
ok(say('POR', 'Portland Trail Blazers @ Phoenix Suns') === '@ Suns', 'POR away, a two-word nickname');
ok(say('PHX', 'Portland Trail Blazers @ Phoenix Suns') === 'v Blazers', 'PHX at home: v Blazers');
ok(say('LAL', 'Los Angeles Lakers @ Los Angeles Clippers') === '@ Clippers' && say('LAC', 'Los Angeles Lakers @ Los Angeles Clippers') === 'v Lakers', 'the two Los Angeles clubs, one city');
ok(say('XYZ', 'Chicago Bulls @ New York Knicks') === 'Bulls @ Knicks', 'a code it does not know: the game, not a guess');
ok(say('BOS', 'Chicago Bulls @ New York Knicks') === 'Bulls @ Knicks', 'a code on someone else\'s game: the same');
ok(say('NY', '') === '' && say('NY', undefined) === '', 'no game: nothing');

console.log('\n-- on the tab --');
const card = C.nbaPpCardHtml();
const [unders, mores] = card.split('<span class="tc-title">Blocks: More</span>');
const rowOf = (html, name) => text((html.split(`<b>${name}</b>`)[1] || '').split('</li>')[0]);
const legs = (b.legs || []).filter((x) => x.min_proj >= 18);
const top = legs.slice(0, 5);
for (const x of top) {
  const row = rowOf(unders, x.player);
  ok(row.includes(`${x.team} · ${C.legOppText(x)} · Under ${x.point}`), `${x.player}: "${row.slice(row.indexOf(x.team), row.indexOf(x.team) + 44)}"`);
}
const moreRows = (mores || '').split('<li>').slice(1);
ok(moreRows.length > 0, `${moreRows.length} Blocks Mores on the card`);
for (const r of moreRows) {
  const name = (r.match(/<b>([^<]+)<\/b>/) || [])[1];
  const x = b.legs.find((l) => l.player === name && l.market === 'blk');
  ok(x && text(r).includes(`${x.team} · ${C.legOppText(x)} · Over ${x.point}`), `${name}: Over, with the opponent`);
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
