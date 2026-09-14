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

const unused = [...captured].filter((m) => !projectedMarkets.has(m));
ok(unused.length === 0,
  unused.length ? `CAPTURED BUT NEVER PROJECTED (credits and rows for nothing): ${unused.join(', ')}` : 'every captured market is one the model projects');

const missing = [...projectedMarkets].filter((m) => !captured.has(m));
ok(missing.length === 0,
  missing.length ? `PROJECTED BUT NOT CAPTURED (no line to grade against): ${missing.join(', ')}` : 'every projected market is captured, so each projection has a line to grade against');

ok(!captured.has('player_receptions'), 'player_receptions stays out');
ok(!captured.has('player_anytime_td'), 'player_anytime_td stays out — no under side is quoted, so no fair line exists');
ok(![...captured].some((m) => /pass/.test(m)), 'no passing market — the model is not allowed to post it');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
