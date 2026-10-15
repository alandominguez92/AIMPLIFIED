// Guards that the NFL capture buys only markets the model projects.
//
// Odds API bills per market per event, so every market in NFL_PROP_MARKETS costs
// credits on every capture and adds rows to nfl_lines, which the NFL pages read.
// `player_receptions` was captured from launch but never projected: no row joined
// to it, graded against it, or showed on the board. On the Week 1 Sunday capture
// it was 1,869 of 4,827 prop rows and a third of the 42 credits — spent and read
// back for nothing, and invisible, because an unused market breaks nothing.
//
// Deliberately a source check. The two lists live 3,500 lines apart and cannot
// share a definition (NFL_PROJ_TO_ODDS is declared after the capture constant, so
// referencing it there throws at module load), which is exactly how they drifted.
import fs from 'node:fs';
import path from 'node:path';
const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'worker.js'), 'utf8');

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

const capM = src.match(/const NFL_PROP_MARKETS = '([^']*)'/);
const projM = src.match(/const NFL_PROJ_TO_ODDS = (\{[^}]*\})/);
ok(!!capM && !!projM, 'found both the capture list and the projection map');

const captured = new Set((capM ? capM[1] : '').split(',').map((s) => s.trim()).filter(Boolean));
// Passing yards ride the same call, but only inside the day-of window, so they
// are named in a constant of their own. A guard that read only the main list
// would pass while the market was being bought.
const pydM = src.match(/const NFL_PASS_YDS_MARKET = '([^']*)'/);
if (pydM) captured.add(pydM[1]);
const projected = new Set(projM ? [...projM[1].matchAll(/'([a-z_]+)'\s*[,}]/g)].map((m) => m[1]) : []);
// The map's VALUES are the odds market keys; its keys are 'receiving'/'rushing'.
const projectedMarkets = new Set([...projected].filter((m) => m.startsWith('player_')));

console.log(`\n   captured:  ${[...captured].join(', ')}`);
console.log(`   projected: ${[...projectedMarkets].join(', ')}\n`);

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
  unused.length ? `CAPTURED BUT NEVER PROJECTED OR MEASURED (credits and rows for nothing): ${unused.join(', ')}` : 'every captured market is projected, or captured deliberately to be measured');
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
  ok(/nearKick \? ',' \+ NFL_PASS_YDS_MARKET : ''/.test(src), 'and the window is what adds the market to a call');
}

const missing = [...projectedMarkets].filter((m) => !captured.has(m));
ok(missing.length === 0,
  missing.length ? `PROJECTED BUT NOT CAPTURED (no line to grade against): ${missing.join(', ')}` : 'every projected market is captured, so each projection has a line to grade against');

ok(!captured.has('player_receptions'), 'player_receptions stays out');
ok(!captured.has('player_anytime_td'), 'player_anytime_td stays out — no under side is quoted, so no fair line exists');
// The passing-yards PROJECTION is the one that stays out. It failed its own
// premise in both backtested seasons (42.0% and 49.5% under-mean) because
// summing ~20 completions flattens the right skew the model trades. The line is
// bought now, to measure PrizePicks against the books, never to project.
ok(!projectedMarkets.has('player_pass_yds'),
  'passing yards are never projected — 42.0% and 49.5% under-mean, the thesis does not hold');
ok(!captured.has('player_pass_yds_alternate'), 'and their alternate lines are not bought');
ok(!captured.has('player_pass_longest_completion'),
  'longest completion stays out — probed 2026-09-22, only DK and BetMGM quote it, so there is no sharp book to de-vig against');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
