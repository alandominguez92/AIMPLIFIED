// Guards the NFL priors page's colour rule and its ARI/AZ normalisation.
//
// The colour rule is the page's whole posture: nothing on it is a play, so
// nothing gets a strength colour. --positive must not appear at all, and
// --danger only on the "unrostered" flag, which marks a data state (no 2026
// roster spot) rather than a bad number. It is easy to violate later by reusing
// a .tone-good helper from the record page, and nothing would visibly break —
// the page would just start implying calls it does not make.
import fs from 'node:fs';
import path from 'node:path';

const BOARD = path.join(import.meta.dirname, '..');
const css = fs.readFileSync(BOARD + '/style.css', 'utf8');
const js = fs.readFileSync(BOARD + '/nfl-priors.js', 'utf8');
const priors = JSON.parse(fs.readFileSync(BOARD + '/nfl-model-priors.json', 'utf8'));
const sched = JSON.parse(fs.readFileSync(BOARD + '/nfl-schedule-2026.json', 'utf8'));

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// Isolate this page's block: from the NFL PRIORS banner to the NEXT section
// banner, not to end-of-file. Slicing to the end swept in whatever was appended
// afterwards and flagged the compare panel's .cmp-bad — a rule that is correct
// where it lives, on the one board that does post. A guard that reaches outside
// what it guards produces failures nobody can act on.
const BANNER = /\/\* =+\s*\n\s*([A-Z][A-Z \/-]+)/g;
const sections = [...css.matchAll(BANNER)].map((m) => ({ name: m[1].trim(), at: m.index }));
const meIdx = sections.findIndex((s) => s.name.startsWith('NFL PRIORS'));
const i = meIdx === -1 ? -1 : sections[meIdx].at;
const end = meIdx === -1 ? css.length
  : (meIdx + 1 < sections.length ? sections[meIdx + 1].at : css.length);
const block = i === -1 ? '' : css.slice(i, end);

console.log('-- colour posture: nothing here is a play --');
ok(i !== -1, 'the NFL priors CSS block is present');
const posUses = [...block.matchAll(/^\s*(\.np-[^{]*)\{[^}]*var\(--positive\)[^}]*\}/gm)].map((m) => m[1].trim());
ok(posUses.length === 0, posUses.length ? `--positive used on: ${posUses.join(', ')}` : 'no rule uses --positive');

const dangerRules = [...block.matchAll(/([^{}]*)\{([^}]*var\(--danger\)[^}]*)\}/g)].map((m) => m[1].trim().replace(/\s+/g, ' '));
const ALLOWED_DANGER = /np-flag-out|np-team-out/;
const badDanger = dangerRules.filter((s) => !ALLOWED_DANGER.test(s));
console.log('   rules using --danger:', dangerRules.length ? dangerRules.join(' | ') : 'none');
ok(badDanger.length === 0,
  badDanger.length ? `--danger outside the unrostered flag: ${badDanger.join(', ')}` : '--danger only marks the unrostered state');

// Week dots signal coverage, not quality — a posted line is not a good line.
const dotFull = block.match(/\.np-wdot-full\s*\{[^}]*\}/);
ok(dotFull && !/--positive/.test(dotFull[0]), 'the "week fully priced" dot is not green');

console.log('\n-- ARI / AZ is normalised before anything counts or joins --');
ok(/TEAM_ALIAS\s*=\s*\{\s*AZ:\s*'ARI'/.test(js), 'the alias maps AZ onto ARI');
ok(/hasMoved\s*=.*team25\(p\)\s*!==\s*team26\(p\)/s.test(js), 'a move is only a move after both sides are normalised');

// Since the Sep 26 rebuild the builder writes ARI at the source. The old file
// wrote AZ, so the model marked every Cardinal "moved" and, keyed on AZ, could
// not have found them on a board that writes ARI either: no Cardinal was
// projected all season. Guarded on the real file, plus the page's alias stays
// in case a future source reintroduces AZ.
const P = Object.values(priors.players);
const schedTeams = new Set();
for (const g of sched.games) { schedTeams.add(g.away); schedTeams.add(g.home); }
const cards = P.filter((p) => p.tm === 'ARI' && p.tm26 === 'ARI');
console.log(`   ${cards.length} Cardinals on the same club both seasons; statuses ${[...new Set(cards.map((p) => p.status))].join(',')}`);
ok(P.length > 300 && P.every((p) => p.tm !== 'AZ' && p.tm26 !== 'AZ'), 'the model file carries no AZ code — normalised at the source');
ok(cards.length >= 5 && cards.every((p) => p.status !== 'moved'), 'no Cardinal is marked as moved for a code change');
ok(P.every((p) => !p.tm26 || schedTeams.has(p.tm26)), 'every 2026 club in the file joins the schedule');

console.log('\n-- the rate guard exists and matches the stated thresholds --');
ok(/MIN_REC\s*=\s*20/.test(js) && /MIN_CAR\s*=\s*25/.test(js), 'thresholds are 20 receptions / 25 carries');
ok(/n<\s*min|n < min/.test(js.replace(/\s+/g, ' ')), 'a below-threshold rate is replaced by its denominator');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
