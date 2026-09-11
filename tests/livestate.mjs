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
const box = { teams: {
  away: {
    pitchers: [696062, 694753, 699008],
    players: Object.fromEntries([
      arm(696062, 'Wilber Dotel', 1, '2.0', 38, 1),
      arm(694753, 'Khristian Curtis', 0, '3.0', 62, 0),
      arm(699008, 'Antwone Kelly', 0, '1.0', 17, 0),
    ]),
  },
  home: {
    pitchers: [684007],
    players: Object.fromEntries([arm(684007, 'Shota Imanaga', 1, '6.0', 100, 4)]),
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
const db = { prepare: (sql) => ({
  bind: () => ({
    all: async () => ({ results: /FROM picks/i.test(sql) ? picks : [] }),
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
const iD = cards.findIndex((x) => x.name === 'W. Dotel');
const iI = cards.findIndex((x) => x.name === 'S. Imanaga');
ok(iI < iD, `Imanaga (${iI}) ranks above the pulled Dotel (${iD})`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
