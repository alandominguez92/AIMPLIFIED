// The NBA and NHL moneyline tables' header and empty message (2026-11-27, the PrizePicks payouts
// doc's fixes). The doc, read on Thanksgiving: "NHL header: says '8 games tomorrow' above a list of
// 15. It counts priced games; say so." And: "NBA prices: 'No NBA games in the next day and a half'
// sits above a list of 11 Friday games."
//
// A board read takes only the games inside 36 hours of it (the worker's h2hGames), and a Pacific
// day gets two regular reads, the first once a game is inside 36 hours, the second inside 3 hours
// of a start (h2hMaybeIngest). The NHL's first read on Thanksgiving, at midnight, held the 8
// Friday games starting by noon, and nothing more came in that day; the NBA had none until Friday's
// first tip, at 4:10 PM, was 36 hours off. The props cards list each day's games from the
// schedule. What has to hold:
//   - the header counts the table's games against the props read's for that day ("8 of 15 games
//     priced tomorrow"); with every one priced, or no props read, it reads as it did
//   - an empty table with games on the props read names them and when they are read: from a day
//     and a half before each starts, the first at its time, or at midnight where the day's own
//     games have spent its two reads
//   - past that time with nothing read, it says when the lines were last read; with no props read,
//     the message it had
//
// Real data (tests/fixtures/mlday-20261127.json): production's NBA and NHL boards as captured at
// midnight Pacific on Nov 27 (11 and 15 Friday games), its props reads that morning, and the NHL's
// own schedule for Nov 25-27 (14 games Wednesday, the last at 7:00 PM Pacific; none on
// Thanksgiving; Friday's 15). Thanksgiving's boards are the Friday ones cut by the 36-hour rule at
// each read's time, as the worker cut them: the cut at midnight gives the doc's 8.
//
//   node tests/mlpriced.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const src = fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const FX = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'mlday-20261127.json'), 'utf8'));
const RealDate = Date;
let NOW = RealDate.parse('2026-11-26T09:00:00Z');
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
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
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const state = {};
let F;
try {
  F = new Function('state', 'esc', ['ptDayOf', 'propDayName', 'propDayTitle', 'soccerKick', 'mlDaySplit', 'mlCountText', 'propData',
    'mlDayTotal', 'mlPricedText', 'mlWaitHtml'].map(lift).join('\n')
    + '\nreturn { mlDaySplit, mlCountText, mlPricedText, mlWaitHtml, soccerKick };')(state, esc);
} catch (e) { console.log(`  FAIL  the helpers lift out of app.js (${e.message})`); console.log('\n1 FAILED'); process.exit(1); }

const H = 3600e3;
// A board as a read at `at` would have held it: the games starting inside 36 hours (h2hGames).
const cut = (games, at) => games.filter((g) => { const t = RealDate.parse(g.commence); return t > at && t - at <= 36 * H; });
const NBA = FX.nba, NHL = FX.nhl;
const pt = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new RealDate(ms));

console.log('-- the NHL on Thanksgiving, 1 AM Pacific --');
const thuMidnight = RealDate.parse('2026-11-26T08:00:00Z');
const nhlThu = { asOf: new RealDate(thuMidnight).toISOString(), games: cut(NHL.board.games, thuMidnight) };
ok(NHL.board.games.length === 15 && nhlThu.games.length === 8, `Friday's board, cut at Thanksgiving's midnight read: ${nhlThu.games.length} of its ${NHL.board.games.length} games, the last at ${pt(Math.max(...nhlThu.games.map((g) => RealDate.parse(g.commence))))}`);
ok(cut(NHL.board.games, thuMidnight + 3 * H).length > 8, `a read later that day would have held more (${cut(NHL.board.games, thuMidnight + 3 * H).length} at 3 AM): the 8 is midnight's`);
state.props = { nhl: NHL.props, nba: NBA.props };
let sp = F.mlDaySplit(nhlThu.games, NOW);
ok(F.mlCountText(sp, NOW) === '8 games tomorrow', `what the header said: "${F.mlCountText(sp, NOW)}"`);
ok(F.mlPricedText('nhl', sp, NOW) === '8 of 15 games priced tomorrow', `what it says now: "${F.mlPricedText('nhl', sp, NOW)}"`);

console.log('\n-- the NHL on Friday, 3 AM Pacific, every game priced --');
NOW = RealDate.parse('2026-11-27T11:00:00Z');
sp = F.mlDaySplit(NHL.board.games, NOW);
ok(F.mlPricedText('nhl', sp, NOW) === '15 games today', `all 15 on the board: "${F.mlPricedText('nhl', sp, NOW)}"`);
delete state.props;
ok(F.mlPricedText('nhl', F.mlDaySplit(nhlThu.games, RealDate.parse('2026-11-26T09:00:00Z')), RealDate.parse('2026-11-26T09:00:00Z')) === '8 games tomorrow',
  'with no props read, the header has nothing to count against and reads as it did');
state.props = { nhl: NHL.props, nba: NBA.props };

console.log('\n-- the NBA on Thanksgiving --');
NOW = RealDate.parse('2026-11-26T09:00:00Z');
const nbaFirst = Math.min(...NBA.board.games.map((g) => RealDate.parse(g.commence)));
ok(cut(NBA.board.games, thuMidnight).length === 0 && pt(nbaFirst) === 'Fri 4:10 PM', `nothing inside 36 hours of midnight: Friday's first tip is ${pt(nbaFirst)}`);
// The snapshot still holds Wednesday's games, all started: a day this message does not look at.
const nbaEmpty = { asOf: null, games: [] };
let w = text(F.mlWaitHtml('nba', nbaEmpty, NOW));
console.log(`        1 AM: "${w}"`);
ok(w === 'Tomorrow’s 11 games aren’t priced yet: each is read from a day and a half before it starts, the first from about 4:10 AM.',
  'the 11 the props card lists, and when the first is read: 4:10 AM, 36 hours before its tip');
const atFirst = nbaFirst - 36 * H + 5 * 60e3;
const nbaAt410 = { asOf: new RealDate(atFirst).toISOString(), games: cut(NBA.board.games, atFirst) };
NOW = atFirst + 60e3;
sp = F.mlDaySplit(nbaAt410.games, NOW);
ok(nbaAt410.games.length === 1 && F.mlPricedText('nba', sp, NOW) === '1 of 11 games priced tomorrow', `after that read: "${F.mlPricedText('nba', sp, NOW)}"`);
// Past 4:10 AM with no read in (a stand-in read time: the message only formats it).
NOW = RealDate.parse('2026-11-26T14:00:00Z');
const stale = { asOf: '2026-11-26T03:05:00.000Z', games: [] };
w = text(F.mlWaitHtml('nba', stale, NOW));
ok(w === `Tomorrow’s 11 games aren’t priced yet — lines last read ${F.soccerKick(stale.asOf)}.`, `past that time with nothing read, when the lines were last read: "${w}"`);

console.log('\n-- the NHL on Wednesday night, its day\'s reads spent --');
const wed = NHL.schedule.find((d) => d.date === '2026-11-25'), thu = NHL.schedule.find((d) => d.date === '2026-11-26');
const lastWed = Math.max(...wed.games.map((g) => RealDate.parse(g.startTimeUTC)));
ok(wed.games.length === 14 && thu.games.length === 0 && pt(lastWed) === 'Wed 7:00 PM', `14 games Wednesday, the last at ${pt(lastWed)}; none on Thanksgiving`);
NOW = RealDate.parse('2026-11-26T04:00:00Z');                 // 8 PM Wednesday, every game started
const nhlWed = { asOf: '2026-11-26T02:35:00.000Z', games: wed.games.map((g) => ({ id: g.id, commence: g.startTimeUTC })) };
ok(F.mlDaySplit(nhlWed.games, NOW).shown.length === 0, 'the table is empty: Wednesday\'s games have started and Friday\'s are not read');
w = text(F.mlWaitHtml('nhl', nhlWed, NOW));
console.log(`        8 PM: "${w}"`);
ok(w === 'Friday’s 15 games aren’t priced yet: each is read from a day and a half before it starts, the first from about midnight.',
  'Friday\'s first, at 10 AM, is 36 hours off at 10 PM, but Wednesday\'s two reads are spent: midnight, the read that held the 8');

console.log('\n-- with no props read --');
delete state.props;
NOW = RealDate.parse('2026-11-26T09:00:00Z');
w = text(F.mlWaitHtml('nba', { asOf: '2026-11-26T03:05:00.000Z', games: [] }, NOW));
ok(w === `No NBA games in the next day and a half — lines last read ${F.soccerKick('2026-11-26T03:05:00.000Z')}.`, `the message it had: "${w}"`);

console.log('\n-- on the tabs --');
for (const sport of ['nba', 'nhl']) {
  const body = lift(sport === 'nba' ? 'renderNba' : 'renderNhl');
  ok(body.includes(`count.textContent = mlPricedText('${sport}', sp)`) && body.includes(`mlWaitHtml('${sport}', d)`) && !/in the next day and a half/.test(body),
    `render${sport === 'nba' ? 'Nba' : 'Nhl'} heads its table with the count and empties it with the message`);
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
