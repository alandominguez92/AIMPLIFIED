// The bar under a moneyline on Picks of the day (2026-10-28).
//
// The owner: "let's also do the projections on the ML" -- the bar the player
// legs carry. Asked which bar gives the sharpest bet, the chance against the
// price: a moneyline is worth betting only when its chance beats what the
// price needs, and every board already draws that (fair the fill, the price
// the tick). What has to hold:
//   - under each moneyline leg on the list and the hero: the fill is the
//     chance the leg's stake is built on (kellyP), the tick the chance its
//     price needs, and the line names the edge or the shortfall in points
//   - the bar agrees with the stake: short of the price exactly where the EV
//     is negative and no stake is set, past it where both are positive
//   - a chance brought toward its record says so
//   - a player leg keeps its projection bar
//
// Real data: production's /api/picks at 1:50 AM Pacific on Oct 28
// (tests/fixtures/picks-ml-20261028.json) -- the Spurs at -520, the
// Cavaliers at -370, the Rockets at -305 and the Knicks at -250.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
const F = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'picks-ml-20261028.json'), 'utf8'));

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
function lift(name) {
  let at = app.indexOf(`function ${name}(`);
  const isConst = at < 0;
  if (isConst) at = app.indexOf(`const ${name} =`);
  if (at < 0) throw new Error(`app.js has no ${name}`);
  let depth = 0;
  for (let i = at; i < app.length; i++) {
    const c = app[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') { depth--; if (!isConst && c === '}' && depth === 0) return app.slice(at, i + 1); }
    else if (isConst && c === ';' && depth === 0 && app[i + 1] === '\n') return app.slice(at, i + 1);
  }
  throw new Error(`could not lift ${name}`);
}
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
let B;
try {
  B = new Function('esc', ['miniBar', 'projLineHtml', 'mlChanceLineHtml', 'pickIsTeam', 'pickBarHtml'].map(lift).join('\n') + '\nreturn { pickBarHtml };')(esc);
} catch (e) { console.log(`  FAIL  the bar lifts out of app.js (${e.message})`); process.exit(1); }
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const leg = (re) => F.legs.find((x) => re.test(x.title));

console.log('-- the Spurs at -520 --');
const spurs = leg(/^Spurs ML/);
const sb = B.pickBarHtml(spurs, spurs.spec);
console.log('  ' + text(sb));
ok(/class="uz" style="width:81\.5%"/.test(sb) && /class="tick" style="left:83\.8\d*%"/.test(sb),
  'the fill runs to the 81.5% its stake is built on, the tick to the 83.9% that -520 needs');
ok(text(sb) === 'chance 81.5% on its record · -520 needs 83.9% · 2.4 points short' && /title="83% as listed, brought toward how legs like it have landed"/.test(sb),
  "83% listed, 81.5% on the NBA favourites' 16 of 20: 2.4 points short of the price");

console.log('\n-- every moneyline on the list --');
const mls = F.legs.filter((x) => /_ml$/.test(x.kind));
for (const x of mls) console.log(`  ${x.title} ${x.odds}: ${text(B.pickBarHtml(x, x.spec))} (EV ${x.ev}%, stake ${x.stake}%)`);
ok(mls.length === 4 && mls.every((x) => {
  const t = text(B.pickBarHtml(x, x.spec));
  return x.ev < 0 ? /points short$/.test(t) && x.stake === 0 : /points of edge$/.test(t) && x.stake > 0;
}), 'the bar agrees with the stake: short where the EV is negative and nothing is staked, past the price where it is staked');
const hou = leg(/^Rockets ML/);
ok(text(B.pickBarHtml(hou, hou.spec)) === 'chance 75.6% · -305 needs 75.3% · 0.3 points of edge',
  'the Rockets at -305: 75.6% against 75.3%, the one moneyline staked (0.3%)');

console.log('\n-- the player legs --');
const carter = leg(/^Wendell Carter/);
ok(text(B.pickBarHtml(carter, carter.spec)) === 'proj 1.6 · line 2.5 · 0.9 cushion', "Carter's under keeps his projection bar");
ok(B.pickBarHtml({ ...spurs, odds: null }, spurs.spec) === '', 'a moneyline with no price draws none');
// The trend bars, price line and bet link follow it since 2026-10-29.
ok(/\$\{pickBarHtml\(x, x\.spec\)\}\$\{trendBarsHtml\(x\.trend\)\}/.test(app) && /\$\{pickBarHtml\(x, s\)\}\$\{trendBarsHtml\(x\.trend\)\}/.test(lift('heroLegHtml')), "on the list's rows and the hero");

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
