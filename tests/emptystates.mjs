// Repetition and empty states (2026-10-12).
//
//   - Today's card printed a level's record under every leg, so three legs at
//     one level read "Legs at 50-55% have landed 175 of 365 (48%)" three
//     times. Each level now prints once, under the list.
//   - A night with no plays showed "Under plays 0 · Best edge —". It says so
//     in one line: "No plays yet tonight · 18 batters priced · 2 watching".
//   - Picks of the day was a blank area while /api/picks loaded: skeleton rows.
//   - An empty slip was a whole card of instructions: one line beside its title.
//
// The functions are lifted out of app.js, so the test runs what ships.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
const src = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
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
      if (isConst && (src[i + 1] === ';' || src[i + 1] === '\n')) return src.slice(at, i + 2);
    }
  }
  throw new Error(`could not close ${name}`);
}
const names = ['isPlayTier', 'todayBandClass', 'todayLegBand', 'todayBandLine', 'todayLevelLines', 'slateSummaryVisible', 'noPlaysLine', 'renderBatterSlateSummary'];
const F = new Function('state', 'el', names.map(lift).join('\n') + '\nreturn { todayLevelLines, renderBatterSlateSummary };');
const state = { sport: 'mlb', topLegs: { legBands: {
  batter: [{ lo: 50, hi: 55, n: 365, hit: 175, hitRate: 47.9 }, { lo: 75, hi: null, n: 8, hit: 7, hitRate: 87.5 }],
  K: [{ lo: 50, hi: 55, n: 54, hit: 25, hitRate: 46.3 }] } } };
const el = { slateSummary: { innerHTML: '', hidden: true } };
const A = F(state, el);

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const count = (html, s) => html.split(s).length - 1;

console.log("-- Today's card levels --");
const three = A.todayLevelLines([{ prob: 52, view: 'batter' }, { prob: 53, view: 'batter' }, { prob: 54, view: 'batter' }]);
ok(count(three, 'have landed') === 1 && three.includes('Legs at 50–55% have landed 175 of 365 (48%)'), 'three legs at one level: its record once');
const two = A.todayLevelLines([{ prob: 88, view: 'batter' }, { prob: 52, view: 'batter' }, { prob: 86, view: 'batter' }]);
ok(count(two, 'have landed') === 2 && two.indexOf('75+%') < two.indexOf('50–55%'), 'two levels: one line each, in the order the legs reach them');
const kb = A.todayLevelLines([{ prob: 52, view: 'batter' }, { prob: 52, view: 'kprops' }]);
ok(count(kb, 'have landed') === 2 && kb.includes('Strikeout legs at 50–55% have landed 25 of 54'), 'a strikeout leg at the same level keeps its own record, and says so');
const body = lift('renderTodayCard');
ok(!/bandLine/.test(body) && /todayLevelLines\(top\)/.test(body), 'and no leg carries the line itself');

console.log('\n-- a night with no plays --');
const r = (o) => ({ tier: 'pass', odds: -110, edge: 0, ...o });
state.liveBatters = [...Array(18)].map(() => r({})).concat([r({ odds: null, tier: 'model' }), r({ odds: null, tier: 'model' }), r({ pulled: true })]);
A.renderBatterSlateSummary();
const line = el.slateSummary.innerHTML.replace(/<[^>]+>/g, '');
console.log('  ' + line);
ok(line.startsWith('No plays yet tonight · 18 batters priced · 2 watching · 1 pulled') && !/Under plays|Best edge/.test(line), 'one line, not "Under plays 0 · Best edge —"');
state.liveBatters = state.liveBatters.concat([r({ tier: '2', edge: 3.1 })]);
A.renderBatterSlateSummary();
ok(/Under plays/.test(el.slateSummary.innerHTML) && /\+3\.1%/.test(el.slateSummary.innerHTML), 'with a play, the four stats are back');
ok(/function renderSlateSummary[\s\S]*?if \(!plays\.length\) \{\s*el\.slateSummary\.innerHTML = noPlaysLine/.test(src), 'the strikeout and moneyline strip says it the same way');

console.log('\n-- Picks of the day loading --');
const picks = lift('renderPicks');
ok(/if \(!d\) \{ grid\.innerHTML = PICKS_SKELETON; return; \}/.test(picks) && /pk-skel-row/.test(lift('PICKS_SKELETON')), 'skeleton rows, not a blank area or a bare "Loading…"');
ok(/async function refreshPicks\(\) \{\s*if \(!LIVE_MODE\) return;\s*if \(!state\.picks\) renderPicks\(\);/.test(src), 'drawn before the fetch, so the first open is never empty');

console.log('\n-- an empty slip --');
const slip = lift('renderSlip');
ok(/classList\.toggle\('slip-is-empty', n === 0\)/.test(slip) && !/slip-empty"/.test(slip), 'one line beside the title, no card');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
