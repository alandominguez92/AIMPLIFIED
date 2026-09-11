// Guards the Live Now card states against the real worker.
//
// The bug this exists for: on 2026-09-11, Wilber Dotel started for Pittsburgh,
// was lifted after 2 innings and 38 pitches with 1 strikeout against an Over
// 1.5, and his card read "live" for the rest of the night. Nothing threw and
// nothing logged — the only cooling trigger for a pitcher was a 105-pitch
// count, which an arm pulled early never reaches, so the card kept pacing him
// toward a number he could no longer reach. That is the worst shape of failure
// here: a dead pick displayed as an active one, ranked above real ones.
//
// Scored off a real boxscore shape, so the fix is tied to the field that
// actually settles it (teams[side].pitchers, the arms used in order) rather
// than to a flag a stub invents.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const GID = 'g824631';

// PIT @ CHC as it stood in the top of the 7th. Dotel started and is out (two
// arms behind him); Imanaga is the last CHC arm listed, so he is still in.
const arm = (id, name, gs, ip, pitches, k) => [`ID${id}`, {
  person: { id, fullName: name },
  stats: { pitching: { gamesStarted: gs, inningsPitched: ip, numberOfPitches: pitches, strikeOuts: k } },
}];
// hits/runs/rbi drive the H+R+RBI market; atBats drives how much of the night
// is gone, which is what the batter states read off.
const bat = (id, name, h, r, rbi, ab) => [`ID${id}`, {
  person: { id, fullName: name },
  stats: { batting: { hits: h, doubles: 0, triples: 0, homeRuns: 0, runs: r, rbi, atBats: ab } },
}];
const box = { teams: {
  away: {
    pitchers: [696062, 694753, 699008],
    players: Object.fromEntries([
      arm(696062, 'Wilber Dotel', 1, '2.0', 38, 1),
      arm(694753, 'Khristian Curtis', 0, '3.0', 62, 0),
      arm(699008, 'Antwone Kelly', 0, '1.0', 17, 0),
      bat(693304, 'Nick Gonzales', 0, 0, 0, 2),
      bat(669707, 'Jared Triolo', 0, 0, 0, 3),
      bat(664040, 'Brandon Lowe', 0, 0, 0, 0),
    ]),
  },
  home: {
    pitchers: [684007],
    players: Object.fromEntries([
      arm(684007, 'Shota Imanaga', 1, '6.0', 100, 4),
      bat(683737, 'Michael Busch', 2, 2, 3, 4),
    ]),
  },
} };

const schedule = { dates: [{ games: [{
  gamePk: 824631,
  status: { abstractGameState: 'Live' },
  teams: { away: { team: { id: 134, abbreviation: 'PIT' }, score: 2 },
           home: { team: { id: 112, abbreviation: 'CHC' }, score: 11 } },
  linescore: { currentInningOrdinal: '7th', inningHalf: 'Top',
               teams: { away: { runs: 2 }, home: { runs: 11 } } },
}] }] };

globalThis.fetch = async (u) => {
  const url = String(u);
  const J = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('/schedule?')) return J(schedule);
  if (url.includes('/boxscore')) return J(box);
  return new Response('{}', { status: 404 });
};

// Three pitcher picks covering every branch the fix touches.
const picks = [
  { date, game_id: GID, pitcher_id: 696062, pitcher: 'W. Dotel', team: 'PIT', line: 1.5, side: 'Over', edge: 4 },
  { date, game_id: GID, pitcher_id: 694753, pitcher: 'K. Curtis', team: 'PIT', line: 1.5, side: 'Under', edge: 3 },
  { date, game_id: GID, pitcher_id: 699008, pitcher: 'A. Kelly', team: 'PIT', line: 1.5, side: 'Under', edge: 2 },
  { date, game_id: GID, pitcher_id: 684007, pitcher: 'S. Imanaga', team: 'CHC', line: 5.5, side: 'Over', edge: 5 },
];
// The four batters are the ranking cases. Gonzales and Triolo both sit on a raw
// stat of 0 -- identical fill -- but Gonzales is winning his Under and Triolo is
// losing his Over. Lowe has not batted at all. Busch has run an Under to 7,
// which is a settled loss and used to sort FIRST inside cooling.
const bpicks = [
  // Edges run the WRONG way on purpose. All three carry fill 0, so the old sort
  // fell straight through to model edge, and these values make it order them
  // Lowe, Triolo, Gonzales -- the exact reverse of what the pick states deserve.
  // With equal edges the old code preserved insertion order and happened to look
  // right, so the assertions below passed without guarding anything.
  { date, game_id: GID, player_id: 693304, player: 'N. Gonzales', team: 'PIT', market: 'hrr', line: 1.5, side: 'Under', edge: 3 },
  { date, game_id: GID, player_id: 669707, player: 'J. Triolo', team: 'PIT', market: 'hrr', line: 0.5, side: 'Over', edge: 5 },
  { date, game_id: GID, player_id: 664040, player: 'B. Lowe', team: 'PIT', market: 'hrr', line: 0.5, side: 'Over', edge: 9 },
  { date, game_id: GID, player_id: 683737, player: 'M. Busch', team: 'CHC', market: 'hrr', line: 1.5, side: 'Under', edge: 6 },
];
const db = { prepare: (sql) => ({
  bind: () => ({
    all: async () => ({ results: /FROM bpicks/i.test(sql) ? bpicks : (/FROM picks/i.test(sql) ? picks : []) }),
    run: async () => ({ meta: { changes: 0 } }), first: async () => null,
  }),
  all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 0 } }), first: async () => null,
}), batch: async (s) => s.map(() => ({ meta: { changes: 0 } })) };

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const res = await mod.default.fetch(new Request('https://x/api/live-now'), { DB: db }, { waitUntil: () => {} });
const cards = await res.json();
const by = Object.fromEntries(cards.map((c) => [c.name, c]));

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

console.log('-- a pitcher who has left the game cannot still be live --');
const d = by['W. Dotel'];
ok(!!d, 'the pulled starter still gets a card');
ok(d && d.state === 'cooling',
  `1 K against Over 1.5, pulled after 38 pitches: ${d && d.state} (was 'live' — the bug)`);
ok(d && / pulled$/.test(d.note || ''), `the note says so: "${d && d.note}"`);

console.log('\n-- and the pitch count alone would not have caught it --');
ok(d && d.stat === 1 && d.line === 1.5, 'he is genuinely short of the number');
ok(38 < 105, 'at 38 pitches the 105 threshold never fires, so pace ruled him live');

console.log('\n-- an Under is settled when the arm is out, still open when he is in --');
// Curtis and Kelly are the controlled pair: same team, same Under 1.5, both
// sitting on 0 strikeouts. The ONLY difference is that Kelly is the last arm
// Pittsburgh has used and Curtis is not. If the two come back with the same
// state, the fix is reading something other than what it claims to read.
const c = by['K. Curtis'], kel = by['A. Kelly'];
ok(c && c.state === 'cashing', `out of the game, 0 K under 1.5: ${c && c.state}`);
ok(kel && kel.state === 'live', `still pitching, same 0 K under 1.5: ${kel && kel.state}`);
ok(c && kel && c.state !== kel.state,
  'identical stat lines diverge purely on whether the arm is still in');

console.log('\n-- a pitcher still in the game is judged on pace, as before --');
const i = by['S. Imanaga'];
ok(i && !/ pulled/.test(i.note || ''), 'the last arm listed is not marked pulled');
ok(i && i.state === 'cooling',
  `4 K against Over 5.5 through 6: ${i && i.state} — pace, not the new rule`);

console.log('\n-- ranking puts the dead pick below the live one --');
const at = (n) => cards.findIndex((x) => x.name === n);
const iD = at('W. Dotel'), iI = at('S. Imanaga');
ok(iI < iD, `Imanaga (${iI}) ranks above the pulled Dotel (${iD})`);

// The Under orientation. Both of these show a raw stat of 0, so they carried
// the same fill and the old sort could only break the tie on model edge -- which
// it did, by putting the losing Over first. Nothing about that was visible: two
// cards reading 0, in an order that meant nothing.
console.log('\n-- a pick is ranked by how it is doing, not by how big the number is --');
const iG = at('N. Gonzales'), iT = at('J. Triolo');
ok(cards[iG] && cards[iG].fill === cards[iT].fill,
  `both sit at fill ${cards[iG] && cards[iG].fill} -- the old sort key could not tell them apart`);
ok(iG < iT, `0 against Under 1.5 (${iG}) outranks 0 against Over 0.5 (${iT})`);

console.log('\n-- a settled loss does not lead the cooling group --');
const iB = at('M. Busch');
ok(cards[iB] && cards[iB].state === 'cooling', '7 H+R+RBI against Under 1.5 is cooling');
ok(cards[iB] && cards[iB].fill >= cards[iD].fill,
  `it also carries the BIGGER fill (${cards[iB] && cards[iB].fill} vs ${cards[iD].fill}), which is why it used to sort first`);
ok(iB > iD && iB > iI, `now last of the cooling cards (${iB})`);
ok(iB === cards.length - 1, 'and last on the board');

console.log('\n-- a player who has not batted yet does not hold a slot --');
const iL = at('B. Lowe');
ok(cards[iL] && cards[iL].note === '0-for-0', 'Lowe has had no at-bat');
ok(iL > iT, `he ranks below Triolo (${iL} vs ${iT}) despite the identical 0 and the same line`);
ok(cards.every((c) => c._started === undefined), 'the ranking field is not leaked to the client');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
