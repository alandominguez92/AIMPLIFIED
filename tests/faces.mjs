// Faces on the legs, and the night's best leg drawn large (2026-10-14).
//
// Today's card, Picks of the day and the NBA PrizePicks card show each leg's
// player: MLB serves headshots by MLB id (and a silhouette for an unknown id),
// ESPN serves NBA and soccer headshots by ESPN athlete id (404 when it has
// none). A team leg shows the club's mark: MLB's by team id, and ESPN's for
// NBA, NFL and soccer, by the path the worker puts on the leg (spec.logo).
// Initials in the team's colours sit under every image and show only when
// there is no photo.
//
// The top card is the first leg of Picks of the day, large: on the Picks tab
// and above Today's card on the MLB board, which the site opens on. Gold is the
// bet (the pick, the add button); the chance is green only when legs like it
// have cleared PrizePicks' 2-pick break-even (57.7%) over five or more.
//
// The functions are lifted out of app.js, so the test runs what ships. The
// club logos are checked against ESPN's own recorded payloads
// (tests/fixtures/espn-team-logos.json): its NBA and NFL team lists, and two
// soccer scoreboards from the host the worker reads.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const src = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const css = fs.readFileSync(BOARD + '/style.css', 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
const html = fs.readFileSync(BOARD + '/index.html', 'utf8').replace(/\r\n/g, '\n');
const worker = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
function lift(name, from = src) {
  let at = from.indexOf(`function ${name}(`);
  const isConst = at < 0;
  if (isConst) at = from.indexOf(`const ${name} =`);
  if (at < 0) throw new Error(`${from === src ? 'app.js' : 'worker.js'} has no ${name}`);
  let depth = 0, seen = false;
  for (let i = at; i < from.length; i++) {
    const c = from[i];
    if (c === '{' || c === '(' || c === '[') { depth++; seen = true; }
    else if (c === '}' || c === ')' || c === ']') depth--;
    if (seen && depth === 0) {
      if (!isConst && c === '}') return from.slice(at, i + 1);
      if (isConst && (from[i + 1] === ';' || from[i + 1] === '\n')) return from.slice(at, i + 2);
    }
  }
  throw new Error(`could not close ${name}`);
}
const names = ['TEAM_COLORS', 'MLB_TEAM_ID', 'headshotUrl', 'teamMarkUrl', 'initialsOf', 'avatarHtml', 'LEG_OFFERS', 'offerLeg',
  'PICK_BOARD', 'PICK_SPORT', 'pickLeg', 'pct0', 'AM', 'soccerKick', 'pickIsTeam', 'pickFace', 'ptDayOf', 'heroLegHtml'];
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const state = { slip: {} };
const F = new Function('state', 'esc', names.map((n) => lift(n)).join('\n')
  + '\nreturn { headshotUrl, teamMarkUrl, initialsOf, avatarHtml, heroLegHtml };')(state, esc);

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

console.log('-- where a face comes from --');
ok(/img\.mlbstatic\.com\/.*\/people\/592450\/headshot/.test(F.headshotUrl('mlb', 592450)), 'an MLB player by MLB id');
ok(/espncdn\.com\/combiner\/i\?img=\/i\/headshots\/nba\/players\/full\/3934672\.png/.test(F.headshotUrl('nba', '3934672')), 'an NBA player by ESPN id');
ok(F.headshotUrl('nfl', 1) === null && F.headshotUrl('mlb', null) === null && F.headshotUrl('nba', '') === null, 'nothing where there is no id or no source');
ok(/\/people\/123\/headshot/.test(F.headshotUrl('mlb', '123"><script>')), 'only the id\'s digits ever reach the URL');
ok(/team-logos\/119\.svg$/.test(F.teamMarkUrl('mlb', 'LAD')) && F.teamMarkUrl('mlb', 'XYZ') === null && F.teamMarkUrl('soccer', 'LIV') === null,
  'a club\'s mark for MLB teams, by team id; none for another club the worker found no logo for');
ok(F.teamMarkUrl('nba', 'Warriors', 'nba/500/gs.png') === 'https://a.espncdn.com/combiner/i?img=/i/teamlogos/nba/500/gs.png&w=128&h=128'
  && /teamlogos\/countries\/500\/ger\.png&w=128/.test(F.teamMarkUrl('soccer', 'Germany', 'countries/500/ger.png')),
  'any other club\'s mark from ESPN, by the path the worker sends, at 128px');
ok(['nba/500/gs.png"><script>', 'https://evil.example/x.png', '../../x.png', 'nba/500/gs.svg', 'mlb/500/lad.png']
  .every((p) => F.teamMarkUrl('nba', 'x', p) === null), 'and nothing else of that path reaches the URL');
// NHL clubs' marks since the NHL board (2026-10-20). Before this the path was
// refused, so every hockey club would have shown initials only.
ok(F.teamMarkUrl('nhl', 'Canadiens', 'nhl/500/mtl.png') === 'https://a.espncdn.com/combiner/i?img=/i/teamlogos/nhl/500/mtl.png&w=128&h=128',
  'an NHL club\'s mark from ESPN by the same path rule');
// The NBA and NHL boards draw each club's mark beside its name, kept with the
// name as one unit so a wrapped phone row never strands a logo.
ok(/const club = \(team, logo\) => `<span class="mc-club">\$\{avatarHtml\(\{ sport, isTeam: true[\s\S]{0,120}\}\)\}<b>/.test(lift('mlTabRow'))
  && /\$\{club\(g\.away, g\.awayLogo\)\}<span class="at-sep">@<\/span>\$\{club\(g\.home, g\.homeLogo\)\}/.test(lift('mlTabRow')),
  'the NBA and NHL boards show both clubs\' marks, each beside its own name');

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
// They hide only once the photo has arrived: hidden from the start, a slow
// photo sat as a plain team-coloured dot (2026-10-15).
ok(/\.hs\.hs-loaded \.hs-mono \{ visibility:hidden; \}/.test(css) && !/\.hs:not\(\.hs-none\) \.hs-mono/.test(css),
  'the initials hide under a photo, which can be transparent, but only once it has loaded');
ok(/document\.addEventListener\('load', \(e\) => \{[\s\S]*?hs-img[\s\S]*?classList\.add\('hs-loaded'\);[\s\S]*?\}, true\);/.test(src),
  'a loaded photo marks its circle (capture phase: load does not bubble either)');

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
const nbaMl = F.heroLegHtml({ ...pp, kind: 'nba_ml', sport: 'nba', title: 'Celtics ML', odds: -330,
  spec: { sport: 'nba', team: 'Celtics', market: 'ml', logo: 'nba/500/bos.png' } });
const socMl = F.heroLegHtml({ ...pp, kind: 'soccer_fav', sport: 'soccer', title: 'Arsenal ML', odds: -250,
  spec: { sport: 'soccer', team: 'Arsenal', market: 'ml', logo: 'soccer/500/359.png' } });
ok(/class="hs hs-team" style="--hs-size:64px"[^>]*><span class="hs-mono">CEL<\/span><img class="hs-img" src="https:\/\/a\.espncdn\.com\/combiner\/i\?img=\/i\/teamlogos\/nba\/500\/bos\.png/.test(nbaMl)
  && /teamlogos\/soccer\/500\/359\.png/.test(socMl) && /hs-mono">ARS</.test(socMl),
  'an NBA or soccer moneyline: the club\'s ESPN mark over its initials (they were initials alone)');
ok(/\.hl-pick \{[^}]*color:var\(--accent\)/.test(css) && /\.hl-p\.good \.hl-pct \{ color:var\(--positive\); \}/.test(css), 'gold is the pick; green is the record clearing break-even');
// On a sport tab the card names its sport (2026-10-21).
ok(/Today's best NBA leg/.test(F.heroLegHtml(nbaMlToday(), { link: true, sport: 'nba' })) && /Today's best leg/.test(F.heroLegHtml(nbaMlToday(), {})),
  'on a sport tab it reads "Today\'s best NBA leg"; on the Picks tab, "Today\'s best leg"');
function nbaMlToday() { return { ...pp, kind: 'nba_ml', sport: 'nba', title: 'Celtics ML', odds: -330, commence: new Date(Date.now() + 60e3).toISOString(),
  spec: { sport: 'nba', team: 'Celtics', market: 'ml', logo: 'nba/500/bos.png' } }; }

// Each sport tab heads with ITS best leg (2026-10-21). The MLB tab showed the
// whole list's best, so a soccer favourite headed the MLB board.
const T = new Function(['TOP_HOST', 'topLegFor'].map((n) => lift(n)).join('\n') + '\nreturn { topLegFor };')();
const now = Date.now(), soon = new Date(now + 36e5).toISOString(), gone = new Date(now - 6e4).toISOString();
const list = { legs: [
  { sport: 'soccer', title: 'Inter Milan ML', commence: soon },
  { sport: 'nba', title: 'Raptors ML', commence: soon },
  { sport: 'nba', title: 'Rockets ML', commence: soon },
  { sport: 'mlb', title: 'LAD ML', commence: gone },
] };
const pick = (s) => { const l = T.topLegFor(list, s, now); return l ? l.title : null; };
ok(pick('nba') === 'Raptors ML' && pick('soccer') === 'Inter Milan ML', `each sport tab gets its own best leg, the first of its sport on the list (NBA: ${pick('nba')})`);
ok(pick('mlb') === null, 'MLB, whose only leg has started, gets no card, not another sport\'s');
ok(pick('nhl') === null && pick('nfl') === null, 'nor does a sport with nothing on the list (NHL until it has a record)');
ok(pick('picks') === null && pick('entries') === null, 'and the Picks and Entries tabs get none: Picks draws its own');
ok(T.topLegFor({ error: 'unreachable', legs: list.legs }, 'nba', now) === null && T.topLegFor(null, 'nba', now) === null, 'or while the list is unread');

console.log('\n-- where it sits --');
ok(/<div id="topCard" class="top-card" hidden><\/div>\s*<div id="todayCard"/.test(html), 'above Today\'s card on the MLB board');
// On the MLB tab only (2026-10-21): on the others the card sits on their board.
ok(/const top = document\.getElementById\('topCard'\);\s*if \(top && state\.sport === 'mlb' && slate\.firstElementChild !== top\) slate\.prepend\(top\);/.test(src),
  'and kept above it when the rail hands Today\'s card back on a phone, on the MLB tab');
// The page opens on Picks (2026-10-20), in a microtask after the script, so
// the consts exist; since 2026-10-21 setSport reads the list for every tab
// that shows a card, so the start needs no read of its own.
ok(/queueMicrotask\(\(\) => \{\s*state\.sport = null;\s*setSport\(START_SPORT\);\s*\}\);/.test(src)
  && /if \(TOP_HOST\[s\] && \(!state\.picks \|\| Date\.now\(\) - \(state\.picksAt \|\| 0\) > 120e3\)\) refreshPicks\(\);/.test(src),
  'loaded with the page, after the script, and read by whichever tab opens');
ok(/const hero = heroLegHtml\(legs\[0\], \{ size: 52 \}\);[\s\S]*?legs\.slice\(1\)\.map/.test(lift('renderPicks')), 'on the Picks tab it is the list\'s first leg, and the rest follow');

// ---- the worker: which logo a moneyline leg carries (2026-10-14) ----------------------
// ESPN's file names are its own codes. Guessed ones fail quietly: uta.png and
// nop.png 404, sas.png is the Spurs' wordmark and la.png the Rams' alternate.
console.log('\n-- each club\'s ESPN logo --');
const FX = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'espn-team-logos.json'), 'utf8'));
const W = new Function(['NFL_ABBR', 'lastWord', 'NBA_LOGO', 'NFL_LOGO', 'NHL_LOGO', 'moneylineLogo', 'withLogos'].map((n) => lift(n, worker)).join('\n')
  + '\nreturn { moneylineLogo, NFL_ABBR, withLogos };')();
const espnTeams = (lg) => FX[`https://site.api.espn.com/apis/site/v2/sports/${lg}/teams`].sports[0].leagues[0].teams.map((t) => t.team);
const logoPath = (href) => href.replace('https://a.espncdn.com/i/teamlogos/', '');
const nbaT = espnTeams('basketball/nba');
const nbaBad = nbaT.filter((t) => W.moneylineLogo('nba', t.displayName) !== logoPath(t.logos[0].href));
ok(nbaT.length === 30 && !nbaBad.length && W.moneylineLogo('nba', 'Los Angeles Clippers') === 'nba/500/lac.png',
  `all 30 NBA clubs, by nickname, to the logo ESPN lists for each (wrong: ${nbaBad.map((t) => t.displayName).join(', ') || 'none'})`);
const nflT = espnTeams('football/nfl');
const nflBad = Object.entries(W.NFL_ABBR).filter(([full, code]) => {
  const t = nflT.find((x) => x.displayName === full);
  return !t || W.moneylineLogo('nfl', code) !== logoPath(t.logos[0].href);
});
ok(Object.keys(W.NFL_ABBR).length === 32 && !nflBad.length,
  `all 32 NFL clubs, by the site's code: WAS is ESPN's wsh, LA its lar (wrong: ${nflBad.map(([f]) => f).join(', ') || 'none'})`);
ok(W.moneylineLogo('nfl', 'Las Vegas Raiders') === null && W.moneylineLogo('nba', 'Hapoel Jerusalem') === null,
  'a club neither table knows gets no logo, so its initials show');
// NHL (2026-10-20), held to ESPN's recorded NHL team list the same way.
const nhlT = espnTeams('hockey/nhl');
const nhlBad = nhlT.filter((t) => W.moneylineLogo('nhl', t.displayName) !== logoPath(t.logos[0].href));
ok(nhlT.length === 32 && !nhlBad.length,
  `all 32 NHL clubs, by nickname, to the logo ESPN lists for each (wrong: ${nhlBad.map((t) => t.displayName).join(', ') || 'none'})`);
// As the odds feed actually spells them on the live board (read 2026-10-20).
ok(W.moneylineLogo('nhl', 'Montréal Canadiens') === 'nhl/500/mtl.png' && W.moneylineLogo('nhl', 'St Louis Blues') === 'nhl/500/stl.png'
  && W.moneylineLogo('nhl', 'Columbus Blue Jackets') === 'nhl/500/cbj.png' && W.moneylineLogo('nhl', 'Vegas Golden Knights') === 'nhl/500/vgk.png',
  'the odds feed\'s spellings find theirs: an accented Montréal, "St Louis" with no stop, and the two-word nicknames');
ok(W.moneylineLogo('nhl', 'HC Davos') === null && W.moneylineLogo('nhl', '') === null,
  'a club the NHL table does not know gets no logo, so its initials show');
const board = W.withLogos({ games: [{ home: 'New York Islanders', away: 'Anaheim Ducks' }] }, 'nhl');
ok(board.games[0].homeLogo === 'nhl/500/nyi.png' && board.games[0].awayLogo === 'nhl/500/ana.png',
  'the board sends both clubs\' paths with each game');

// /api/picks end to end: real SQLite, the real worker, and ESPN's recorded
// scoreboards from cdn.espn.com (the host the worker reads) for soccer.
console.log('\n-- on the Picks list --');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const RealDate = Date;
let NOW = RealDate.parse('2026-10-18T09:00:00Z');       // a Sunday, 2 AM Pacific
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const reads = [];
globalThis.fetch = async (u) => {
  const url = String(u);
  if (url.startsWith('https://cdn.espn.com/core/soccer/scoreboard')) {
    reads.push(url);
    if (url.includes('league=esp.1')) await new Promise((r) => setTimeout(r, 6000));     // ESPN, slow
    return new Response(JSON.stringify(FX[url] || { content: { sbData: { events: [] } } }), { status: 200 });
  }
  return new Response('{}', { status: 404 });
};
const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
function exec(sql, args, mode) {
  const st = sq.prepare(sql);
  const a = args.map(norm);
  if (mode === 'all') return { results: st.all(...a), meta: {} };
  if (mode === 'first') return st.get(...a) || null;
  return { success: true, meta: { changes: Number(st.run(...a).changes) } };
}
const DB = {
  prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
    all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
    run: async () => exec(s.sql, s.args, 'run') }; return s; },
  batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')),
};
const mod = await import('data:text/javascript;base64,' + Buffer.from(worker).toString('base64'));
const picks = async () => (await mod.default.fetch(new Request('https://x/api/picks'), { DB }, { waitUntil: () => {} })).json();
await picks();                                           // creates the tables
const ptDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new RealDate(iso));
const gm = (sport, gid, market, league, commence, side, pick, home, away, wp, price) => sq.prepare(
  'INSERT INTO gmpicks (sport, date, game_id, market, league, commence, side, pick, home, away, win_prob, entry_price, close_price) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .run(sport, ptDay(commence), gid, market, league, commence, side, pick, home, away, wp, price, price);
// Kickoffs as ESPN lists them on Oct 18. The odds feed writes "Bournemouth";
// ESPN writes "AFC Bournemouth". Chelsea is not on ESPN's Oct 18 card at all.
gm('nba', 'evBOS', 'h2h', 'reg', '2026-10-18T23:30:00Z', 'home', 'Boston Celtics', 'Boston Celtics', 'Detroit Pistons', 78, -330);
gm('nfl', 'evWAS', 'h2h', 'REG', '2026-10-18T17:00:00Z', 'home', 'WAS', 'WAS', 'NYG', 70, -240);
gm('soccer', 'evNFO', 'fav', 'epl', '2026-10-18T15:30:00Z', 'away', 'Arsenal', 'Nottingham Forest', 'Arsenal', 72, -250);
gm('soccer', 'evBOU', 'fav', 'epl', '2026-10-18T13:00:00Z', 'home', 'Bournemouth', 'Bournemouth', 'Sunderland', 68, -200);
gm('soccer', 'evCHE', 'fav', 'epl', '2026-10-18T14:00:00Z', 'home', 'Chelsea', 'Chelsea', 'Brentford', 66, -180);
const legOf = (d, t) => (d.legs || []).find((x) => x.title === t) || { spec: {} };
let d1 = await picks();
console.log('  ' + (d1.legs || []).map((x) => `${x.title} ${x.spec.logo || '-'}`).join(' | '));
ok(legOf(d1, 'Celtics ML').spec.logo === 'nba/500/bos.png' && legOf(d1, 'WAS ML').spec.logo === 'nfl/500/wsh.png',
  'an NBA and an NFL moneyline carry their club\'s logo path');
ok(legOf(d1, 'Arsenal ML').spec.logo === 'soccer/500/359.png' && legOf(d1, 'Bournemouth ML').spec.logo === 'soccer/500/349.png',
  'a soccer favourite carries the logo ESPN lists for that side of the fixture, matched as the grader matches clubs ("AFC Bournemouth")');
ok(legOf(d1, 'Chelsea ML').title && legOf(d1, 'Chelsea ML').spec.logo == null, 'a fixture ESPN does not list that day: no logo, so initials');
ok(reads.length === 1 && reads[0].endsWith('league=eng.1&date=20261018'), `one scoreboard read for the Premier League's day, not one per leg (${reads.length})`);
await picks();
ok(reads.length === 1, `and none on another page read inside ten minutes (${reads.length})`);

// A late kickoff: Juárez at Cruz Azul, 03:10Z on Oct 18, is 8:10 PM Pacific on
// the 17th, and ESPN files it under the 17th. Asked for the UTC day, it is not there.
NOW = RealDate.parse('2026-10-17T20:00:00Z');
gm('soccer', 'evCAZ', 'fav', 'ligamx', '2026-10-18T03:10:00Z', 'home', 'Cruz Azul', 'Cruz Azul', 'FC Juarez', 67, -190);
const dMx = await picks();
ok(legOf(dMx, 'Cruz Azul ML').spec.logo === 'soccer/500/218.png' && reads.at(-1).endsWith('league=mex.1&date=20261017'),
  `a late kickoff is looked up on the leg's Pacific day, where ESPN files it (${legOf(dMx, 'Cruz Azul ML').spec.logo})`);

// National teams: their marks live under countries/. The feed's "Turkey" is
// ESPN's "Türkiye", and at a neutral ground the two can disagree which side is
// home -- the grader flips such a fixture back, and so does this.
NOW = RealDate.parse('2024-11-16T10:00:00Z');
gm('soccer', 'evGER', 'fav', 'uefanl', '2024-11-16T19:45:00Z', 'home', 'Germany', 'Germany', 'Bosnia and Herzegovina', 80, -900);
gm('soccer', 'evTUR', 'fav', 'uefanl', '2024-11-16T17:00:00Z', 'away', 'Turkey', 'Wales', 'Turkey', 66, -170);
const d2 = await picks();
ok(legOf(d2, 'Germany ML').spec.logo === 'countries/500/ger.png' && legOf(d2, 'Turkey ML').spec.logo === 'countries/500/tur.png',
  `a national team carries its country's mark, home or away in either feed (${legOf(d2, 'Germany ML').spec.logo}, ${legOf(d2, 'Turkey ML').spec.logo})`);

// ESPN slow to answer: the list does not wait for it.
NOW = RealDate.parse('2026-10-18T09:00:00Z');
gm('soccer', 'evRMA', 'fav', 'laliga', '2026-10-18T19:00:00Z', 'home', 'Real Madrid', 'Real Madrid', 'Sevilla', 75, -300);
const t0 = performance.now();
const d3 = await picks();
const took = performance.now() - t0;
ok(took < 4000 && legOf(d3, 'Real Madrid ML').title && legOf(d3, 'Real Madrid ML').spec.logo == null && legOf(d3, 'Arsenal ML').spec.logo === 'soccer/500/359.png',
  `a slow ESPN holds the list ${(took / 1000).toFixed(1)}s at most, not the 6s it takes: that leg shows initials, the rest their marks`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
