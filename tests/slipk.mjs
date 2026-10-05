// Guards strikeout legs in the slip, and the slip's parlay read.
//
// Strikeout props had no way into the slip after the post-pivot cut stars from
// every view but the batter board; 2026-10-03 put them back (the row star, a
// per-starter add in the breakdown, and a star on every Today's-card leg). The
// first run of that work turned up an older bug: kSpec read the row's pick TEXT
// for "Over", but the pick abbreviates ("H. Smith O 4.5 Ks"), so every starred
// K over was recorded as an under — in the parlay read and as the entry log's
// default side. Nothing errored; the wrong side was just quietly the default.
//
// The functions are lifted out of app.js itself, not re-implemented here, so the
// test runs what ships. Static, like intervalguard: no browser, no slate.
import fs from 'node:fs';
import path from 'node:path';

const BOARD = path.join(import.meta.dirname, '..');
const src = fs.readFileSync(BOARD + '/app.js', 'utf8');

// Pull a top-level `function name(...) {...}` or `const name = ...;` out of the
// source by balancing brackets from where it starts.
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
      if (isConst && src[i + 1] === ';') return src.slice(at, i + 2);
    }
  }
  throw new Error(`could not close ${name}`);
}
const names = ['ptDayOf', 'pkOf', 'pct1', 'kLeadOf', 'kSpec', 'buildKPropLeg', 'kLegIdFor', 'buildKPitcherLeg',
  'entryLegFrom', 'PP_BREAK_EVEN', 'slipReadHtml', 'impliedPct', 'r1', 'nflGameKey', 'nflMlLeg', 'nflYardsLeg', 'soccerMlLeg', 'gameStarted'];
const body = names.map(lift).join('\n');
const make = new Function('state', 'esc', `${body}\nreturn { kSpec, buildKPropLeg, buildKPitcherLeg, slipReadHtml, nflMlLeg, nflYardsLeg, soccerMlLeg, gameStarted };`);
const state = { logSides: {}, logPrices: {}, logLines: {}, logBook: 'pp', slip: {} };
const esc = (s) => String(s == null ? '' : s);
const F = make(state, esc);

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// A K row the way refreshBoard hands it over: the API's pitchers as projRows.
const smith = { id: 1001, name: 'H. Smith', fullName: 'Hagen Smith', team: 'CWS',
  market: { line: 4.5, side: 'Over', price: -105, edge: 29.8, modelOver: 78.6 }, pp: { point: 4.5, modelUnder: 28.1 } };
const messick = { id: 1002, name: 'P. Messick', fullName: 'Parker Messick', team: 'CLE',
  market: { line: 6.5, side: 'Under', price: 110, edge: 3.2, modelOver: 44 }, pp: { point: 6, modelUnder: 49.1 } };
const row = { id: 'g849829', matchup: 'CWS @ CLE', pick: 'H. Smith O 4.5 Ks', odds: -105, edge: 29.8,
  timeMs: Date.parse('2026-10-03T17:08:00Z'), projRows: [smith, messick] };

console.log('-- the side comes from the market, not from reading the pick text --');
const lead = F.buildKPropLeg(row);
ok(lead.spec.side === 'Over', `"H. Smith O 4.5 Ks" is an over (${lead.spec.side})`);
ok(lead.id === 'kprops:g849829' && lead.spec.player === 'Hagen Smith' && lead.spec.book.price === -105,
  `the row star takes the arm the row headlines, at the row's price (${lead.id}, ${lead.spec.player}, ${lead.spec.book.price})`);
const noMarket = { ...row, pick: 'H. Smith O 4.5 Ks', projRows: [{ ...smith, market: null }, messick] };
ok(F.kSpec(noMarket).side === 'Over', 'with no market on the arm, the abbreviated text still reads as an over');
const under = { ...row, pick: 'P. Messick U 6.5 Ks', odds: 110, projRows: [smith, messick] };
ok(F.kSpec(under).side === 'Under', 'and an abbreviated under reads as an under');

console.log('\n-- either starter can go in, each as its own leg --');
const second = F.buildKPitcherLeg(row, messick);
ok(second.id === 'kprops:g849829:1002', `the second arm has his own id (${second.id})`);
ok(second.spec.side === 'Under' && second.spec.book.line === 6.5 && second.spec.book.price === 110 && second.odds === 110,
  `at his own side, line and price — not the headliner's (${second.spec.side} ${second.spec.book.line} @ ${second.spec.book.price})`);
ok(second.title === 'P. Messick U 6.5 Ks', `titled the way the row writes it (${second.title})`);
ok(F.buildKPitcherLeg(row, smith).id === lead.id, 'the headliner from the breakdown is the same leg as the row star, never a second copy');

console.log('\n-- the parlay read --');
const batter = (id, player, team, under) => ({ id, board: 'PrizePicks', title: player, spec: { sport: 'mlb', date: '2026-10-03',
  gamePk: 849829, playerId: id, player, team, market: 'tb', side: 'Under', book: { line: 0.5, price: null, under: null },
  pp: { line: 0.5, under } } });
const kanes = batter(501, 'Steven Kwan', 'CLE', 62);
const read1 = F.slipReadHtml([lead, kanes]);
ok(/2 legs from one game/.test(read1), 'legs sharing a game are named as moving together');
ok(/Smith over and the hitters facing him under point the same way/.test(read1),
  'a K over beside the opposing hitters’ unders is read as pointing the same way');
state.logSides = { [lead.id]: 'Under' };
const read2 = F.slipReadHtml([lead, kanes]);
ok(/Smith under points against the hitters facing him/.test(read2),
  'switched to the under, the same pair is read as pulling apart');
state.logSides = {};
const ownTeam = F.slipReadHtml([{ ...lead, spec: { ...lead.spec, team: 'CLE' } }, kanes]);
ok(!/point the same way|points against/.test(ownTeam), 'his own lineup’s at-bats are not read against his strikeouts');

const two = F.slipReadHtml([kanes, batter(502, 'Jose Ramirez', 'CLE', 58)]);
ok(/PrizePicks needs two teams/.test(two), 'two legs from one club trip PrizePicks’ two-team rule');
ok(/a 2-pick power needs <b>57.7%<\/b>/.test(two) && /Model.s average leg <b>60%<\/b>/.test(two),
  'and the read gives the model’s average leg against what a 2-pick power needs');
state.logBook = 'dk';
ok(!/PrizePicks needs two teams/.test(F.slipReadHtml([kanes, batter(502, 'Jose Ramirez', 'CLE', 58)])),
  'on DraftKings the two-team rule does not apply and is not shown');
ok(F.slipReadHtml([kanes]) === '', 'a single leg has nothing to read');

console.log('\n-- a moneyline beside the props in its game --');
// The moneyline star came back the same day, for DraftKings parlays.
const ml = (team) => ({ id: `ml:g849829:${team}`, board: 'ML', title: `${team} ML`, odds: -150,
  spec: { sport: 'mlb', date: '2026-10-03', gamePk: 849829, player: team, team, market: 'ml', side: 'home', book: { line: null, price: -150, win: 58 } } });
const cws = batter(503, 'Andrew Benintendi', 'CWS', 55);
const messickOver = { ...F.buildKPitcherLeg(row, messick), spec: { ...F.buildKPitcherLeg(row, messick).spec, side: 'Over' } };
const readMl = F.slipReadHtml([ml('CLE'), kanes, cws, messickOver, lead]);
ok(/CLE to win pulls against Kwan/.test(readMl), 'a team to win pulls against its own hitters going under');
ok(/CLE to win points the same way as [^.]*Benintendi/.test(readMl) && /CLE to win points the same way as [^.]*Messick/.test(readMl),
  'and points the same way as the other club’s hitters under and its own starter over');
ok(/CLE to win pulls against [^.]*Smith/.test(readMl), 'while the other starter’s strikeout over pulls against it');
ok(/both teams are here to win/i.test(F.slipReadHtml([ml('CLE'), ml('CWS')])), 'both sides of one game are called out: one of them loses');
// PrizePicks offers moneylines now (the user, 2026-10-04), so a moneyline leg
// counts toward the entry's break-even read at its sharp fair win %.
state.logBook = 'pp';
ok(/Model.s average leg <b>59%<\/b> · a 2-pick power/.test(F.slipReadHtml([ml('CLE'), batter(504, 'Some Bat', 'NYY', 60)])),
  'a moneyline leg on PrizePicks counts toward the break-even read at its fair win %');

console.log('\n-- legs from the NFL and soccer boards (2026-10-04) --');
state.logBook = 'dk'; state.logSides = {};
const nflGame = { id: 'ev1', away: 'DET', home: 'CAR', commence: '2026-10-05T00:20:00Z', pickTeam: 'DET', pickPrice: -180,
  pickFair: 63.9, away_price: -180, home_price: 168, away_fair: 63.9, home_fair: 36.1 };
const detMl = F.nflMlLeg(nflGame, 'DET'), carMl = F.nflMlLeg(nflGame, 'CAR');
ok(detMl.spec.sport === 'nfl' && detMl.spec.market === 'ml' && detMl.spec.side === 'away' && detMl.odds === -180 && detMl.spec.book.win === 63.9,
  `an NFL moneyline leg carries its side, price and the sharp fair (${detMl.title} ${detMl.odds}, ${detMl.spec.book.win}%)`);
ok(carMl.odds === 168 && carMl.spec.book.win === 36.1 && carMl.edge === r(36.1 - 100 / 268 * 100),
  `the other side at its own price and fair, with its own value (${carMl.odds}, edge ${carMl.edge})`);
function r(v) { return Math.round(v * 10) / 10; }
const gibbs = F.nflYardsLeg({ player: 'Jahmyr Gibbs', team: 'DET', game: 'DET @ CAR', commence: nflGame.commence, line: 88.5, underPrice: -112 }, 'rushing');
ok(gibbs.spec.market === 'rush_yds' && gibbs.spec.side === 'Under' && gibbs.spec.book.line === 88.5 && gibbs.odds === -112,
  `a yardage leg is the under at the captured line and its price (${gibbs.title} ${gibbs.odds})`);
ok(gibbs.spec.gamePk === detMl.spec.gamePk, `and shares a game key with that game's moneyline (${gibbs.spec.gamePk})`);
const nflRead = F.slipReadHtml([detMl, gibbs]);
ok(/2 legs from one game/.test(nflRead) && !/points the same way|pulls against/.test(nflRead),
  'an NFL side beside its own player gets the same-game warning, and no baseball direction read');
ok(/both teams are here to win/i.test(F.slipReadHtml([detMl, carMl])), 'both NFL sides of one game are called out');
const fx = { id: 'sx1', away: 'England', home: 'Croatia', commence: '2026-10-03T18:45:00Z' };
const eng = F.soccerMlLeg(fx, { selection: 'England', price: -120, fair: 55, value: -0.5 });
const drw = F.soccerMlLeg(fx, { selection: 'Draw', price: 280, fair: 24.4, value: -1.9 });
ok(eng.spec.side === 'away' && drw.spec.side === 'draw' && drw.spec.team === null && drw.title.startsWith('Draw'),
  `soccer sides are home, away or the draw (${eng.title}; ${drw.title})`);
ok(/only one result happens/i.test(F.slipReadHtml([eng, drw])), 'a side and the draw of one fixture are called out: only one result happens');
ok(!/win or lose together/.test(F.slipReadHtml([eng, drw])), 'and are not said to win or lose together, which opposite results cannot');
state.logBook = 'pp';
const mlbMia = batter(601, 'Kyle Stowers', 'MIA', 55);
const nflMia = { ...gibbs, id: 'nfl:x', spec: { ...gibbs.spec, team: 'MIA', player: 'De\'Von Achane', gamePk: 'MIA @ BUF|2026-10-04' } };
ok(!/PrizePicks needs two teams/.test(F.slipReadHtml([mlbMia, nflMia])),
  'Miami’s baseball and football clubs are two teams, not one');
ok(!/legs from one game/.test(F.slipReadHtml([{ ...detMl, spec: { ...detMl.spec, gamePk: 849829 } }, kanes])),
  'and an NFL leg never shares a game with an MLB leg, whatever its id');

console.log('\n-- warmup is not a start --');
// 2026-10-05, 1:44 PM: Cleveland was in Warmup for a 2:00 first pitch, which
// StatsAPI reports as abstract "Live", and the moneyline star refused it as
// started. Started is a final, or a live game past its scheduled first pitch.
const pitch = Date.now() + 16 * 60e3;
ok(!F.gameStarted({ status: 'Live', time: pitch }), 'a Live (warmup) game before its scheduled first pitch has not started');
ok(F.gameStarted({ status: 'Live', time: Date.now() - 60e3 }), 'a Live game past its first pitch has');
ok(F.gameStarted({ status: 'Final', time: pitch }) && !F.gameStarted({ status: 'Preview', time: Date.now() - 60e3 }),
  'a final always has; a preview never has, even running late');
ok(F.gameStarted({ status: 'Live', timeMs: Date.now() - 60e3 }), 'and the batter rows’ timeMs is read as well as the board rows’ time');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
