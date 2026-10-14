// Faces on the legs, and the night's best leg drawn large (2026-10-14).
//
// Today's card, Picks of the day and the NBA PrizePicks card show each leg's
// player: MLB serves headshots by MLB id (and a silhouette for an unknown id),
// ESPN serves NBA and soccer headshots by ESPN athlete id (404 when it has
// none). A team leg shows the club's mark (MLB, by team id). Initials in the
// team's colours sit under every image and show only when there is no photo.
//
// The top card is the first leg of Picks of the day, large: on the Picks tab
// and above Today's card on the MLB board, which the site opens on. Gold is the
// bet (the pick, the add button); the chance is green only when legs like it
// have cleared PrizePicks' 2-pick break-even (57.7%) over five or more.
//
// The functions are lifted out of app.js, so the test runs what ships.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
const src = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const css = fs.readFileSync(BOARD + '/style.css', 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
const html = fs.readFileSync(BOARD + '/index.html', 'utf8').replace(/\r\n/g, '\n');
const worker = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
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
const names = ['TEAM_COLORS', 'MLB_TEAM_ID', 'headshotUrl', 'teamMarkUrl', 'initialsOf', 'avatarHtml', 'LEG_OFFERS', 'offerLeg',
  'PICK_BOARD', 'PICK_SPORT', 'pickLeg', 'pct0', 'AM', 'soccerKick', 'pickIsTeam', 'pickFace', 'heroLegHtml'];
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const state = { slip: {} };
const F = new Function('state', 'esc', names.map(lift).join('\n')
  + '\nreturn { headshotUrl, teamMarkUrl, initialsOf, avatarHtml, heroLegHtml };')(state, esc);

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

console.log('-- where a face comes from --');
ok(/img\.mlbstatic\.com\/.*\/people\/592450\/headshot/.test(F.headshotUrl('mlb', 592450)), 'an MLB player by MLB id');
ok(/espncdn\.com\/combiner\/i\?img=\/i\/headshots\/nba\/players\/full\/3934672\.png/.test(F.headshotUrl('nba', '3934672')), 'an NBA player by ESPN id');
ok(F.headshotUrl('nfl', 1) === null && F.headshotUrl('mlb', null) === null && F.headshotUrl('nba', '') === null, 'nothing where there is no id or no source');
ok(/\/people\/123\/headshot/.test(F.headshotUrl('mlb', '123"><script>')), 'only the id\'s digits ever reach the URL');
ok(/team-logos\/119\.svg$/.test(F.teamMarkUrl('mlb', 'LAD')) && F.teamMarkUrl('mlb', 'XYZ') === null && F.teamMarkUrl('soccer', 'LIV') === null,
  'a club\'s mark for MLB teams, by team id');

console.log('\n-- initials, under every face --');
const cases = [['Aaron Judge', null, 'AJ'], ['B. Williamson', null, 'BW'], ['LAD', 'LAD', 'LAD'], ['Liverpool', 'Liverpool', 'LIV'],
  ['Nashville SC', 'Nashville SC', 'NAS'], ['Sporting Kansas City', 'x', 'SKC'], ['Los Angeles FC', 'x', 'LA']];
for (const [name, team, want] of cases) ok(F.initialsOf(name, team) === want, `${name} -> ${F.initialsOf(name, team)}`);
const a = F.avatarHtml({ sport: 'mlb', playerId: 605141, team: 'LAD', name: 'Mookie Betts' });
ok(/class="hs-mono">MB</.test(a) && /class="hs-img" src="https:\/\/img\.mlbstatic/.test(a) && /loading="lazy"/.test(a),
  'a face: initials, then the photo over them, loaded lazily');
ok(/--hs-bg:#005A9C/i.test(a), 'in the team\'s colours');
const none = F.avatarHtml({ sport: 'soccer', team: 'Liverpool', name: 'Liverpool', isTeam: true });
ok(/hs-none/.test(none) && !/<img/.test(none) && /hs-mono">LIV</.test(none), 'with no image source, initials alone');
ok(/document\.addEventListener\('error', \(e\) => \{[\s\S]*?hs-img[\s\S]*?t\.remove\(\);[\s\S]*?classList\.add\('hs-none'\)[\s\S]*?\}, true\);/.test(src),
  'a photo that fails is removed and the initials show (capture phase: image errors do not bubble)');
ok(/\.hs:not\(\.hs-none\) \.hs-mono \{ visibility:hidden; \}/.test(css), 'and the initials hide under a photo, which can be transparent');

console.log('\n-- the legs that carry one --');
ok(/class="tc-leg has-hs" data-action="today-jump"[^`]*\$\{face\}/.test(lift('renderTodayCard')), 'Today\'s card');
ok(/<div class="tc-leg has-hs">\$\{pickFace\(x\)\}/.test(lift('renderPicks')), 'Picks of the day');
ok(/avatarHtml\(\{ sport: 'nba', playerId: x\.player_id/.test(lift('nbaPpCardHtml')), 'the NBA PrizePicks card, by its ESPN id');
ok(/playerId: r\.player_id \|\| null, player: r\.player/.test(worker), 'and /api/picks passes an NBA leg\'s ESPN id along (it was null)');

console.log('\n-- the night\'s best leg --');
const pp = { kind: 'mlb_pp', sport: 'mlb', title: 'B. Williamson Under 1.5 H+R+RBI', sub: 'MIL @ LAD', p: 78.4, commence: new Date(Date.now() + 3e6).toISOString(),
  odds: null, lineup: 'in', legId: 'pp:b1:hrr', record: { n: 16, hit: 12, hitRate: 75, proven: false },
  spec: { sport: 'mlb', playerId: 680757, player: 'Bryan Williamson', team: 'TB', market: 'hrr' } };
const h = F.heroLegHtml(pp, { link: true });
ok(/class="hl-name">B\. Williamson</.test(h) && /class="hl-pick">Under 1\.5 H\+R\+RBI</.test(h), 'the player large, the pick under him');
ok(/hl-p good"><span class="hl-pct">78%</.test(h), 'the chance in green: legs like it landed 12 of 16, above 57.7%');
ok(/Legs like this: <b>12 of 16<\/b> landed \(75%\)/.test(h) && /lineup in/.test(h), 'with its record and its lineup status');
ok(/data-action="leg-add" data-leg="pp:b1:hrr"/.test(h) && /data-action="set-sport" data-sport="picks"/.test(h), 'one tap adds it; the link opens the whole list');
ok(/people\/680757\/headshot/.test(h), 'with his face');
const thin = F.heroLegHtml({ ...pp, record: { n: 3, hit: 3, hitRate: 100 } });
ok(/class="hl-p"><span class="hl-pct">/.test(thin) && !/data-sport="picks"/.test(thin), 'under five graded legs, no green; and no link on the Picks tab itself');
const ml = F.heroLegHtml({ ...pp, kind: 'mlb_ml', title: 'LAD ML', odds: -150, spec: { sport: 'mlb', team: 'LAD', market: 'ml' } });
ok(/class="hl-name">LAD</.test(ml) && /Moneyline <span class="hl-odds">-150</.test(ml) && /team-logos\/119\.svg/.test(ml), 'a moneyline: the club, its mark and price');
ok(/\.hl-pick \{[^}]*color:var\(--accent\)/.test(css) && /\.hl-p\.good \.hl-pct \{ color:var\(--positive\); \}/.test(css), 'gold is the pick; green is the record clearing break-even');

console.log('\n-- where it sits --');
ok(/<div id="topCard" class="top-card" hidden><\/div>\s*<div id="todayCard"/.test(html), 'above Today\'s card on the MLB board');
ok(/const top = document\.getElementById\('topCard'\);\s*if \(top && slate\.firstElementChild !== top\) slate\.prepend\(top\);/.test(src),
  'and kept above it when the rail hands Today\'s card back on a phone');
ok(/setTimeout\(refreshPicks, 0\);/.test(src), 'loaded with the page, a tick late so the Picks renderer\'s consts exist');
ok(/const hero = heroLegHtml\(legs\[0\], \{ size: 52 \}\);[\s\S]*?legs\.slice\(1\)\.map/.test(lift('renderPicks')), 'on the Picks tab it is the list\'s first leg, and the rest follow');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
