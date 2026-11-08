// Guards that the NFL capture buys only markets something reads.
//
// Odds API bills per market per event, so every market in NFL_PROP_MARKETS costs
// credits on every capture and adds rows to nfl_lines, which the NFL pages read.
// `player_receptions` was captured from launch but never projected: no row joined
// to it, graded against it, or showed on the board. On the Week 1 Sunday capture
// it was 1,869 of 4,827 prop rows and a third of the 42 credits — spent and read
// back for nothing, and invisible, because an unused market breaks nothing.
//
// Until 2026-11-08 the readers were the yardage projections (NFL_PROJ_TO_ODDS).
// The owner took those off; the NFL props card (PP_PROP_CFG.nfl, since Nov 5)
// reads the same capture, so its markets are the list now, with the logs'.
//
// Deliberately a source check. The two lists live thousands of lines apart and
// cannot share a definition, which is exactly how they drifted.
import fs from 'node:fs';
import path from 'node:path';
const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'worker.js'), 'utf8');

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

const capM = src.match(/const NFL_PROP_MARKETS = '([^']*)'/);
const projM = src.match(/\n {2}nfl: \{ fromCapture: true,[\s\S]*?\n {4}markets: (\{[^}]*\})/);
ok(!!capM && !!projM, 'found both the capture list and the NFL props card\'s markets');
ok(!/async function nflProps\(|NFL_PROJ_TO_ODDS|function nflSim\(|nfl-model-priors\.json/.test(src), 'and no yardage projection model is left to read them (2026-11-08)');

const captured = new Set((capM ? capM[1] : '').split(',').map((s) => s.trim()).filter(Boolean));
// Passing yards ride the same call, but only inside the day-of window, so they
// are named in a constant of their own. A guard that read only the main list
// would pass while the market was being bought.
const pydM = src.match(/const NFL_PASS_YDS_MARKET = '([^']*)'/);
if (pydM) captured.add(pydM[1]);
const projected = new Set(projM ? [...projM[1].matchAll(/\b(player_[a-z_]+):/g)].map((m) => m[1]) : []);
// The card's KEYS are the odds market keys; its values are its own stat names.
const projectedMarkets = projected;

console.log(`\n   captured:  ${[...captured].join(', ')}`);
console.log(`   the card reads: ${[...projectedMarkets].join(', ')}\n`);

// A market the model does not project may be captured only if it is captured to
// be MEASURED, and only if that intent is written down in the source. Today that
// is player_pass_tds: nothing projects it, nothing is posted from it, and it is
// bought so the sharp pool's under-1.5 can be read against the 55.4% the market
// has actually run at. Anything else captured-but-unprojected is the
// player_receptions mistake again — credits and rows for nothing, invisible
// because an unused market breaks nothing.
// Since 2026-10-15 player_pass_yds joins it: PrizePicks' number against the
// books', logged and graded, no projection and nothing posted.
const MEASURED_ONLY = new Set([
  ...([...src.matchAll(/const NFL_PASS_TD_LINE = /g)].length ? ['player_pass_tds'] : []),
  ...(pydM ? [pydM[1]] : []),
]);
const unused = [...captured].filter((m) => !projectedMarkets.has(m) && !MEASURED_ONLY.has(m));
ok(unused.length === 0,
  unused.length ? `CAPTURED BUT NEVER READ OR MEASURED (credits and rows for nothing): ${unused.join(', ')}` : 'every captured market is read by the card, or captured deliberately to be measured');
// The exception has to carry its own machinery, or it is just an exemption.
const MACHINERY = {
  player_pass_tds: ['passTdEntries', 'gradePassTds', 'buildPassTdRecord'],
  player_pass_yds: ['passYdsEntries', 'gradePassYds', 'buildPassYdsRecord'],
};
for (const m of MEASURED_ONLY) {
  if (!captured.has(m)) continue;
  const fns = MACHINERY[m] || ['(none named)'];
  ok(fns.every((f) => new RegExp(`function ${f.replace(/[()]/g, '\\$&')}\\(`).test(src)),
    `${m} is captured to be measured, and the logging, grading and record to measure it with all exist (${fns.join(', ')})`);
}
ok(/NFL_PASS_TD_BASE = 55\.4/.test(src),
  'passing TDs are read against the realised rate, not against nothing');
if (pydM) {
  // The cost guard. The capture prices every game inside a ten-day horizon on
  // each run, twice a slate day; bought on every call, passing yards would cost
  // each game ten-odd credits instead of two.
  const win = src.match(/const NFL_PASS_YDS_WINDOW_MS = (\d+) \* 3600 \* 1000/);
  ok(!!win && Number(win[1]) <= 24, `passing yards are bought only inside a day-of window (${win ? win[1] + 'h' : 'no window found'})`);
  // Catches ride the same window since 2026-11-01 (tests/nflrec.mjs).
  ok(/nearKick \? ',' \+ NFL_PASS_YDS_MARKET( \+ ',' \+ NFL_REC_MARKET)? : ''/.test(src), 'and the window is what adds the market to a call');
}

// Catches are bought only inside the day-of window (NFL_REC_MARKET, 2026-11-01).
const recM = src.match(/const NFL_REC_MARKET = '([^']*)'/);
const missing = [...projectedMarkets].filter((m) => !captured.has(m) && !(recM && m === recM[1]));
ok(missing.length === 0,
  missing.length ? `READ BY THE CARD BUT NOT CAPTURED (no line to read): ${missing.join(', ')}` : 'every market the card reads is captured');

ok(!captured.has('player_receptions'), 'player_receptions stays off the every-capture list (day-of window only)');
ok(!captured.has('player_anytime_td'), 'player_anytime_td stays out — no under side is quoted, so no fair line exists');
ok(!captured.has('player_pass_yds_alternate'), 'and their alternate lines are not bought');
ok(!captured.has('player_pass_longest_completion'),
  'longest completion stays out — probed 2026-09-22, only DK and BetMGM quote it, so there is no sharp book to de-vig against');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
