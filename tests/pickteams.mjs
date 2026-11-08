// A player's team on Picks (2026-11-04).
//
// The owner: "for the picks its hard to tell which team the players play for".
// A leg read "Jake Sanderson Over 0.5 AST ... Senators @ Sabres": both clubs and
// not which is his. What has to hold:
//   - a player leg leads with his team's code, as the NBA and NHL tabs' rows do:
//     on the list's rows, the PrizePicks pool's, the hero card, the entry's
//     ticket and the slip
//   - a moneyline's title already says, so it carries no code
//   - a quarterback's team, which the passing-TD log doesn't keep, is the club in
//     his last graded games of the two in this one, rematches included
//
// Real data: /api/picks on the morning of Nov 4, 2026
// (tests/fixtures/picks-pool-teams-20261104.json) and production's passing-TD
// log on Oct 27 (tests/fixtures/gmpicks-nflptd-20261027.json).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const BOARD = path.join(import.meta.dirname, '..');
const fx = (f) => JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', f), 'utf8'));
const { ppPool, legs: mlLegs } = fx('picks-pool-teams-20261104.json');
const PTD = fx('gmpicks-nflptd-20261027.json').rows;

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
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
const names = ['TEAM_COLORS', 'MLB_TEAM_ID', 'NHL_PHOTO_SEASON', 'headshotUrl', 'teamMarkUrl', 'initialsOf', 'avatarHtml',
  'LEG_OFFERS', 'offerLeg', 'PICK_BOARD', 'PICK_SPORT', 'pickLeg', 'pct0', 'AM', 'soccerKick', 'pickIsTeam', 'pickTeamCode', 'pickTeamTag', 'miniBar', 'projLineHtml', 'mlChanceLineHtml', 'pickBarHtml', 'RING_C', 'chanceRingSvg', 'pickFace', 'ptDayOf', 'pickMoved',
  'trendTag', 'readAgeTag', 'injuryTag', 'goalieNote', 'trendBarsHtml', 'impPct', 'priceSparkHtml', 'LINK_BOOK', 'STATE_SLOT', 'betLinkHtml', 'legLink', 'stakeTxt', 'moneyTxt', 'pickEdgeHtml',
  'nbCdf', 'r1', 'ppLineOf', 'ppChanceAt', 'pickAtLine', 'ppLineStepHtml', 'pickLineSetTag', 'shortDay', 'recSinceText', 'heroLegHtml'];
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
let P;
try {
  P = new Function('state', 'esc', names.map(lift).join('\n')
    + '\nreturn { pickTeamCode, pickTeamTag, pickLeg, heroLegHtml };')({ slip: {} }, esc);
} catch (e) { console.log(`  FAIL  the Picks helpers lift out of app.js (${e.message})`); process.exit(1); }

console.log('\n-- a player leg names his team --');
const cade = ppPool.find((x) => x.spec.player === 'Cade Cunningham');
const sanderson = ppPool.find((x) => x.spec.player === 'Jake Sanderson');
const boozer = ppPool.find((x) => x.spec.player === 'Cameron Boozer');
ok(P.pickTeamCode(cade) === 'DET' && P.pickTeamCode(sanderson) === 'OTT' && P.pickTeamCode(boozer) === 'MEM', "today's pool: DET, OTT, MEM");
ok(P.pickTeamTag(sanderson) === '<b class="tc-team">OTT</b> · ', `the tag: ${P.pickTeamTag(sanderson)}`);
ok(P.pickLeg(sanderson).sub === 'OTT · Senators @ Sabres', `on the slip: "${P.pickLeg(sanderson).sub}"`);
ok(P.pickLeg(sanderson).title === sanderson.title && P.pickLeg(sanderson).id === sanderson.legId, 'its title and id unchanged: a leg already on a slip stays the same leg');
const hero = P.heroLegHtml(cade, { link: true });
ok(/<span class="hl-game"><b class="tc-team">DET<\/b> · 76ers @ Pistons/.test(hero), 'on the hero card, leading the game line');
ok(P.pickTeamTag({ kind: 'nba_blk_more', spec: { team: '<i>' } }) === '<b class="tc-team">&lt;i&gt;</b> · ', 'escaped');

console.log('\n-- a moneyline, and a leg with no team --');
const celtics = mlLegs.find((x) => x.title === 'Celtics ML');
ok(celtics && celtics.spec.team && P.pickTeamCode(celtics) === '' && P.pickTeamTag(celtics) === '', `"Celtics ML" already says, though its spec has ${celtics && celtics.spec.team}`);
ok(P.pickLeg(celtics).sub === celtics.sub, `its slip line is untouched: "${P.pickLeg(celtics).sub}"`);
ok(!/tc-team/.test(P.heroLegHtml(celtics, { link: true })), 'nor on its hero card');
const noTeam = { ...cade, spec: { ...cade.spec, team: null } };
ok(P.pickTeamTag(noTeam) === '' && P.pickLeg(noTeam).sub === cade.sub, 'no team known: the leg reads as it did');

console.log('\n-- the rows and the ticket draw it --');
ok(/<span class="tc-l2"><span>\$\{pickTeamTag\(x\)\}<span class="pk-sport">/.test(app), "the list's rows and the pool's lead with it");
ok(/<b>\$\{esc\(l\.short\)\}<\/b>\$\{pickTeamCode\(l\.x\) \? `<span class="tk-team">/.test(lift('ticketHtml')), "the entry's ticket has it under the name");
const css = fs.readFileSync(BOARD + '/style.css', 'utf8').replace(/\r\n/g, '\n');
ok(/\.hl-game \.tc-team \{[^}]*color:var\(--text\)/.test(css) && /\.tk-leg \.tk-team \{[^}]*color:var\(--textDim\)/.test(css), 'and both are styled');

console.log("\n-- a quarterback's team, from his log --");
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const wlift = (name) => {
  let at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`worker.js has no ${name}`);
  if (src.slice(at - 6, at) === 'async ') at -= 6;
  let dd = 1;
  for (let i = src.indexOf(') {', at) + 3; i < src.length; i++) { if (src[i] === '{') dd++; else if (src[i] === '}' && --dd === 0) return src.slice(at, i + 1); }
  throw new Error(`could not close ${name}`);
};
const cst = (name) => { const at = src.indexOf(`const ${name} =`); if (at < 0) throw new Error(`worker.js has no ${name}`); return src.slice(at, src.indexOf(';\n', at) + 1); };
let W;
try {
  W = new Function(['NFL_NAME_SUFFIX', 'nflBaseName', 'NFL_ABBR', 'nflAbbr'].map(cst).concat(['normName', 'ptdTeams'].map(wlift)).join('\n') + '\nreturn { ptdTeams };')();
} catch (e) { console.log(`  FAIL  ptdTeams lifts out of worker.js (${e.message})`); process.exit(1); }
const sq = new DatabaseSync(':memory:');
sq.exec('CREATE TABLE gmpicks (sport TEXT, date TEXT, game_id TEXT, home TEXT, away TEXT, result TEXT)');
const ins = sq.prepare('INSERT INTO gmpicks VALUES (?, ?, ?, ?, ?, ?)');
for (const r of PTD) ins.run(r.sport, r.date, r.game_id, r.home, r.away, r.result == null ? null : r.result);
let reads = 0;
const DB = { prepare: (sql) => ({ all: async () => { reads++; return { results: sq.prepare(sql).all() }; } }) };
const qb = (player, game) => ({ kind: 'nfl_ptd', legId: `ptd:${player}`, spec: { sport: 'nfl', player, team: null, gamePk: `${game}|2026-11-08`, market: 'pass_tds' } });
const love = qb('Jordan Love', 'GB @ MIN'), allen = qb('Josh Allen', 'NE @ BUF'), mahomes = qb('Patrick Mahomes', 'LAC @ KC');
const rematch = qb('Jordan Love', 'DET @ GB'), nobody = qb('Nobody Here', 'DAL @ NYG');
const known = { ...qb('Bo Nix', 'DEN @ KC'), spec: { ...qb('Bo Nix', 'DEN @ KC').spec, team: 'XXX' } };
const other = { kind: 'nba_blk_more', legId: 'x', spec: { player: 'Cade Cunningham', team: null, gamePk: 'x' } };
await W.ptdTeams(DB, [love, allen, mahomes, rematch, nobody, known, other]);
ok(love.spec.team === 'GB', `Jordan Love, away at Minnesota: ${love.spec.team}`);
ok(allen.spec.team === 'BUF', `Josh Allen, at home to the Patriots he has played: ${allen.spec.team}`);
ok(mahomes.spec.team === 'KC', `Patrick Mahomes, at home to the Chargers he has played: ${mahomes.spec.team}`);
ok(rematch.spec.team === 'GB', `Love against the Lions he played in Week 7: ${rematch.spec.team}`);
ok(nobody.spec.team === null, 'a quarterback with no graded game: none');
ok(known.spec.team === 'XXX' && other.spec.team === null, "a team already known stands, and it's the passing-TD legs alone");
ok(reads === 1, 'one read of the log');
reads = 0;
await W.ptdTeams(DB, [other]);
ok(reads === 0, 'no passing-TD leg on the card: no read at all');
ok(/await ptdTeams\((env\.DB|legDb), onCard\)/.test(src) && src.search(/await ptdTeams\((env\.DB|legDb), onCard\)/) < src.indexOf('const shown = (l, i) =>'), 'and it runs before the legs are shown');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
