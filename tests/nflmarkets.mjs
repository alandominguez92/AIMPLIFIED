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
const MEASURED_ONLY = new Set(
  [...src.matchAll(/const NFL_PASS_TD_LINE = /g)].length ? ['player_pass_tds'] : []
);
const unused = [...captured].filter((m) => !projectedMarkets.has(m) && !MEASURED_ONLY.has(m));
ok(unused.length === 0,
  unused.length ? `CAPTURED BUT NEVER PROJECTED OR MEASURED (credits and rows for nothing): ${unused.join(', ')}` : 'every captured market is projected, or captured deliberately to be measured');
// The exception has to carry its own machinery, or it is just an exemption.
for (const m of MEASURED_ONLY) {
  if (!captured.has(m)) continue;
  ok(/function passTdEntries/.test(src) && /function gradePassTds/.test(src) && /function buildPassTdRecord/.test(src),
    `${m} is captured to be measured, and the logging, grading and record to measure it with all exist`);
  ok(/NFL_PASS_TD_BASE = 55\.4/.test(src),
    'and it is read against the realised rate, not against nothing');
}

const missing = [...projectedMarkets].filter((m) => !captured.has(m));
ok(missing.length === 0,
  missing.length ? `PROJECTED BUT NOT CAPTURED (no line to grade against): ${missing.join(', ')}` : 'every projected market is captured, so each projection has a line to grade against');

ok(!captured.has('player_receptions'), 'player_receptions stays out');
ok(!captured.has('player_anytime_td'), 'player_anytime_td stays out — no under side is quoted, so no fair line exists');
// Passing YARDS is the one that stays out. It failed its own premise in both
// backtested seasons (42.0% and 49.5% under-mean) because summing ~20
// completions flattens the right skew the model trades. Passing TDs is a
// different distribution and a different question, so naming the market
// precisely matters more here than matching on /pass/.
ok(!captured.has('player_pass_yds') && !captured.has('player_pass_yds_alternate'),
  'passing YARDS stays out — 42.0% and 49.5% under-mean, the thesis does not hold');
ok(!captured.has('player_pass_longest_completion'),
  'longest completion stays out — probed 2026-09-22, only DK and BetMGM quote it, so there is no sharp book to de-vig against');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
