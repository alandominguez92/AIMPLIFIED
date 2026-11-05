// Who an NHL player is playing against, on the NHL tab (2026-11-05).
//
// The owner, after the NBA tab got it the same day: "yes add the opponent to NHL too."
// A leg carries the NHL's team code and the odds feed's full names, and nothing ties
// the two: "NJD" is the Devils, "TBL" the Lightning, "VGK" the Golden Knights. What has
// to hold:
//   - every real game and code pair names the other team, away with an @, home with a v
//   - all 32 codes, and the two-word nicknames shortened as they are on the Hot list
//   - a code the page doesn't know still shows the game, rather than a guess
//   - the row says it, in the list the tab really draws
//
// Real data: every leg /api/nhl-pp sent on Nov 5, 2026 (tests/fixtures/nhl-pp-opp-20261105.json).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.join(HERE, '..');
const { legs } = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'nhl-pp-opp-20261105.json'), 'utf8'));

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
const ui = { slip: {} };
const CARD = ['TEAM_COLORS', 'MLB_TEAM_ID', 'NHL_PHOTO_SEASON', 'headshotUrl', 'teamMarkUrl', 'initialsOf', 'avatarHtml', 'miniBar', 'projLineHtml', 'LEG_OFFERS', 'offerLeg',
  'ptDayOf', 'soccerKick', 'AM', 'NBA_MK', 'NHL_MK', 'PP_MORE_MIN', 'ppMoreP', 'ppMoreMk', 'ppMoreLeg', 'shortDay', 'readAgeTag', 'injuryTag', 'nbaCardInjTag',
  'nbaNick', 'NBA_CODE_NICK', 'NHL_CODE_NICK', 'legOppText', 'ppMoreListHtml'];
let C;
try {
  C = new Function('state', 'esc', CARD.map(lift).join('\n') + '\nreturn { NHL_CODE_NICK, legOppText, ppMoreListHtml };')(ui, esc);
} catch (e) { console.log(`  FAIL  the list lifts out of app.js (${e.message})`); process.exit(1); }
const text = (h) => h.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const say = (team, game) => C.legOppText({ team, game }, C.NHL_CODE_NICK);

console.log('\n-- every pair the feed really sent --');
const pairs = [...new Map(legs.map((x) => [`${x.team}|${x.game}`, x])).values()];
ok(pairs.length >= 15, `${pairs.length} pairs, from ${legs.length} legs`);
let wrong = 0;
const nick = (n) => n.split(' ').pop();
for (const x of pairs) {
  const [away, home] = x.game.split(' @ ');
  const said = C.legOppText(x, C.NHL_CODE_NICK);
  const want = C.NHL_CODE_NICK[x.team] === nick(home) ? `v ${nick(away)}` : `@ ${nick(home)}`;
  if (said !== want || ![nick(away), nick(home)].includes(C.NHL_CODE_NICK[x.team])) { wrong++; console.log(`        ${x.team} in ${x.game}: "${said}"`); }
}
ok(!wrong, `each names the other team, and no code sat on a game without its nickname (${wrong} wrong)`);
ok(Object.keys(C.NHL_CODE_NICK).length === 32, 'all 32 clubs');

console.log('\n-- the odd ones --');
ok(say('TBL', 'Chicago Blackhawks @ Tampa Bay Lightning') === 'v Blackhawks', 'TBL at home: v Blackhawks');
ok(say('CHI', 'Chicago Blackhawks @ Tampa Bay Lightning') === '@ Lightning', 'CHI away, a home side of three words');
ok(say('CBJ', 'Dallas Stars @ Columbus Blue Jackets') === 'v Stars' && say('DAL', 'Dallas Stars @ Columbus Blue Jackets') === '@ Jackets', 'the Blue Jackets, either way');
ok(say('VGK', 'Vegas Golden Knights @ Detroit Red Wings') === '@ Wings' && say('DET', 'Vegas Golden Knights @ Detroit Red Wings') === 'v Knights', 'two two-word nicknames in one game');
ok(say('MTL', 'Utah Mammoth @ Montréal Canadiens') === 'v Mammoth' && say('UTA', 'Utah Mammoth @ Montréal Canadiens') === '@ Canadiens', 'the accent is no trouble');
ok(say('NYI', 'Carolina Hurricanes @ New York Islanders') === 'v Hurricanes' && say('NYR', 'New York Rangers @ New York Islanders') === '@ Islanders', 'the two New York clubs');
ok(say('XYZ', 'Dallas Stars @ Columbus Blue Jackets') === 'Stars @ Jackets', 'a code it does not know: the game, not a guess');
ok(say('NJD', '') === '', 'no game: nothing');

console.log('\n-- on the tab --');
const html = C.ppMoreListHtml(legs.slice(0, 8), 'nhl');
const rows = html.split('<li>').slice(1);
ok(rows.length === 8, `${rows.length} rows drawn`);
rows.forEach((r, i) => {
  const x = legs[i];
  ok(text(r).includes(`${x.team} · ${C.legOppText(x, C.NHL_CODE_NICK)} · Over ${x.point}`), `${x.player}: "${x.team} · ${C.legOppText(x, C.NHL_CODE_NICK)} · Over ${x.point}"`);
});
const nba = C.ppMoreListHtml([{ player: 'Jay Huff', team: 'IND', market: 'blk', point: 0.5, model_under: 40, proj: 1.2, game: 'Indiana Pacers @ Chicago Bulls', game_id: 'g1', commence: '2026-11-05T00:40:00Z', player_id: '1' }], 'nba');
ok(text(nba).includes('IND · @ Bulls · Over 0.5'), 'and the NBA list still reads its own codes');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
