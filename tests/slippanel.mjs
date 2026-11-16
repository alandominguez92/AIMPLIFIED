// The slip beside today's legs (2026-11-16, step 5 of the page brief): hidden until a leg is
// starred, with a hint until then; each starred leg with its chance, the chance all of them land
// on those chances and on the record of legs like them, a leg whose game has started flagged to
// come off; on a PC a panel pinned beside the legs, on a phone a bar that opens it as a sheet.
// "Save entry image" draws the slip as the PrizePicks ticket's picture does. The slip's old card
// (the log form) stays off Picks until "Log this entry" asks for it.
//
// Read on the Picks payload recorded on Nov 16 at 09:10 UTC: Jabari Smith Jr's blocks More
// (62.1, legs like it 60.3), Derik Queen's rebounds Less (56.1, 52.6), the Nuggets (79.5, 80.9).
//
//   node tests/slippanel.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8').replace(/\r\n/g, '\n');
const src = read('app.js'), css = read('style.css');
const D = JSON.parse(read('tests/fixtures/picks-20261116-0040.json'));
const NOW = Date.parse(D.asOf);

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
const state = { slip: {} };
let F;
try {
  F = new Function('state', 'esc', ['PICK_BOARD', 'pickIsTeam', 'pickTeamCode', 'pickLeg', 'pct0', 'slipRows', 'slipAll', 'slipPanelHtml'].map(lift).join('\n')
    + '\nreturn { pickLeg, slipRows, slipPanelHtml };')(state, esc);
} catch (e) { console.log(`  FAIL  the slip lifts out of app.js (${e.message})`); console.log('\n1 FAILED'); process.exit(1); }

const all = [...D.legs, ...D.ppPool, ...D.mlPool];
const leg = (t) => all.find((x) => x.title === t);
const jabari = leg('Jabari Smith Jr Over 0.5 BLK'), queen = leg('Derik Queen Under 6 REB'), nuggets = leg('Nuggets ML');
const star = (...xs) => { state.slip = {}; for (const x of xs) { const l = x.legId ? F.pickLeg(x) : x; state.slip[l.id] = l; } };

console.log('\n-- 1. a starred leg keeps what the panel shows --');
const jl = F.pickLeg(jabari);
ok(jl.p === 62.1 && jl.rec && jl.rec.hitRate === 60.3 && jl.rec.n === 78 && jl.commence === '2026-11-17T00:40:00Z',
  `its chance, its record and its start: ${jl.p}, ${jl.rec && jl.rec.hitRate} of ${jl.rec && jl.rec.n}, ${jl.commence}`);
ok(jl.spec === jabari.spec && jl.title === jabari.title, 'and the spec the log form builds from, as before');

console.log('\n-- 2. each leg, named short, with its chance --');
star(jabari, queen, nuggets);
const rows = F.slipRows(D, NOW);
ok(rows.map((r) => r.name).join(' | ') === 'Smith Jr over 0.5 BLK | Queen under 6 REB | Nuggets to win', `as the mock names them: ${rows.map((r) => r.name).join(' | ')}`);
ok(rows.map((r) => r.p).join(',') === '62.1,56.1,79.5' && rows.map((r) => r.rec).join(',') === '60.3,52.6,80.9', 'chance and record from today’s list');
ok(rows.map((r) => r.pick).join(' | ') === 'More 0.5 BLK | Less 6 REB | to win' && rows[0].who === 'Jabari Smith Jr' && rows[2].who === 'Nuggets',
  'the picture’s words: who, and the pick as PrizePicks says it');
ok(rows.every((r) => !r.started), 'none started at 09:10 UTC');
// A leg no longer on the list keeps the chance it was starred at.
state.slip.gone = { ...F.pickLeg(queen), id: 'gone', p: 58 };
ok(F.slipRows(D, NOW).find((r) => r.id === 'gone').p === 58, 'a leg that has left the list keeps the chance it had when starred');
// Today's number wins over the stored one while the leg is listed.
state.slip[jl.id] = { ...jl, p: 50 };
ok(F.slipRows(D, NOW).find((r) => r.id === jl.id).p === 62.1, 'while it is listed, today’s chance, not the one it was starred at');

console.log('\n-- 3. the panel --');
state.slip = {};
ok(F.slipPanelHtml(D, NOW) === '', 'nothing starred: no panel and no bar');
star(jabari, queen, nuggets);
const h = F.slipPanelHtml(D, NOW), t = text(h);
ok(/^<aside class="pks" id="pksPanel" aria-labelledby="pksH">/.test(h) && /<h2 id="pksH">My slip<\/h2><span class="pks-n">3 legs<\/span>/.test(h), 'My slip, 3 legs');
ok(/Smith Jr over 0\.5 BLK 62% ✕ Queen under 6 REB 56% ✕ Nuggets to win 80% ✕/.test(t), 'each leg with its chance and a way off');
ok(/All 3 land, on the chances shown 28%/.test(t), `all three land on their chances: .621 x .561 x .795 = 28% (${(t.match(/chances shown (\d+%)/) || [])[1]})`);
ok(/On the record of legs like these 26%/.test(t), 'and on the record: .603 x .526 x .809 = 26%');
ok(h.includes('data-action="slip-save">Save entry image</button>') && h.includes('data-action="slip-log">Log this entry</button>') && h.includes('data-action="clear-slip"'),
  'save the image, log the entry, clear the slip');
ok(!/payout/i.test(h), 'no payout field: step 12');
ok(h.includes('data-leg="' + esc(jl.id) + '" aria-label="Remove Smith Jr over 0.5 BLK from your slip"'), 'the ✕ removes that leg, and says which');
ok(/<div class="pks-bar">[\s\S]*<b>My slip · 3 legs<\/b><span>All 3 land 28%<\/span>[\s\S]*data-action="slip-sheet" data-open="1" aria-controls="pksPanel" aria-expanded="false">Open slip<\/button>/.test(h),
  'the phone’s bar: My slip · 3 legs, All 3 land 28%, Open slip');
ok(/<div class="pks-dim" data-action="slip-sheet" data-open="0"><\/div>/.test(h) && /class="pks-x" data-action="slip-sheet" data-open="0" aria-label="Close the slip"/.test(h),
  'the sheet closes from its ✕ or the dimmed page');
state.slipOpen = true;
ok(/^<aside class="pks open"/.test(F.slipPanelHtml(D, NOW)) && /aria-expanded="true"/.test(F.slipPanelHtml(D, NOW)), 'an open sheet stays open through a redraw');
state.slipOpen = false;

console.log('\n-- 4. a started leg, a leg with no chance, one leg --');
state.slip[jl.id] = { ...jl };
const later = Date.parse('2026-11-17T00:45:00Z');
const hs = F.slipPanelHtml(D, later), ts = text(hs);
ok(/<li class="pks-leg started"><span class="pks-nm">Smith Jr over 0\.5 BLK<span class="pks-st"> · started<\/span>/.test(hs), 'Jabari’s game began at 00:40: greyed, "· started"');
ok(/Smith Jr over 0\.5 BLK has started\. Remove it or swap for a leg still to play\./.test(ts) && /class="pks-warn" role="status"/.test(hs), 'and a warning to remove or swap it');
ok(/All 3 land 28% · a leg has started/.test(ts), 'the bar says so too');
ok(text(F.slipPanelHtml(D, Date.parse('2026-11-17T02:15:00Z'))).includes('3 legs have started.'), 'all three under way, counted');
state.slip.k = { id: 'k', board: 'K Prop', title: 'Gerrit Cole Under 6.5 K', sub: 'NYY @ BOS', odds: -120, spec: { side: 'Under', market: 'K' } };
const hk = text(F.slipPanelHtml(D, NOW));
ok(/Cole under 6\.5 K — ✕/.test(hk), 'a leg starred on another tab has no chance here: a dash, not a borrowed number');
ok(/All 3 with a chance land 28%/.test(hk) && /On the record, the 3 with one 26%/.test(hk), 'the sums say they are over the legs that have one');
ok(!/Save entry image/.test(hk), 'no picture of an entry with a leg it cannot price');
star(nuggets);
const h1 = F.slipPanelHtml(D, NOW);
ok(/A PrizePicks entry takes two legs or more: star another\./.test(text(h1)) && !/Save entry image/.test(h1), 'one leg: star another, no picture yet');
ok(/My slip · 1 leg<\/b><span>80% to land<\/span>/.test(h1), 'the bar for one leg');
star(...[...new Map(all.map((x) => [x.legId, x])).values()].slice(0, 7));
ok(Object.keys(state.slip).length === 7 && /six legs at most: remove one/.test(text(F.slipPanelHtml(D, NOW))), 'seven legs: one too many for PrizePicks');

console.log('\n-- 5. on the page --');
const rp = lift('renderPicks');
ok(/\(Object\.keys\(state\.slip\)\.length \? '' : '<p class="pks-hint">Tap the star on any leg to start your slip\.<\/p>'\)/.test(rp), 'the hint, until a leg is starred');
ok(/const slipPanel = slipPanelHtml\(d\);\n\s+const legsCols = slipPanel \? `<div class="pk-cols">\$\{todayCard\}\$\{slipPanel\}<\/div>` : todayCard;/.test(rp)
  && /mlbUnreadHtml\(d\) \+ legsCols \+ bankHtml\(\)/.test(rp), 'the panel beside today’s legs, only once a leg is starred');
ok(/syncSlipSection\(\);/.test(rp) && /placeRail\(\);\n\s+syncSlipSection\(\);/.test(lift('setSport')), 'the old slip card hides on Picks and comes back on the other tabs');
const sync = lift('syncSlipSection');
ok(/ss\.hidden = state\.sport === 'picks' && !!document\.querySelector\('#picksGrid \.pk-today'\) && !state\.slipLog;/.test(sync), 'off Picks only while the list is drawn and the log was not asked for');
ok(/case 'slip-log': \{\n\s+state\.slipLog = true;\n\s+slipSheet\(false\);\n\s+syncSlipSection\(\);/.test(src), '"Log this entry" brings the log form back');
ok(/case 'slip-save': saveSlipImage\(\); break;/.test(src) && /case 'slip-sheet': slipSheet\(target\.dataset\.open === '1'\); break;/.test(src), 'save and the sheet wired up');
ok(/if \(e\.key === 'Escape'\) \{ closeCtlSheet\(\); if \(state\.slipOpen\) slipSheet\(false\); \}/.test(src), 'Escape closes the sheet');
ok(/renderSlip\(\);\n\s+if \(!Object\.keys\(next\)\.length\) state\.slipOpen = false;\n\s+if \(state\.sport === 'picks'\) renderPicks\(\);/.test(lift('removeLeg'))
  && /if \(state\.sport === 'picks'\) renderPicks\(\);/.test(lift('clearSlip')), 'the ✕ and Clear redraw the panel');
const sv = lift('saveSlipImage');
ok(/if \(n < 2 \|\| n > 6 \|\| rows\.some\(\(r\) => r\.p == null\)\) return;/.test(sv) && /entryImage\(\{/.test(sv), 'the picture: two to six legs, each with a chance, drawn as the ticket is');
ok(/entryImage\(\{/.test(lift('saveTicketImage')) && /: ppEntryLegs\(d\);/.test(lift('saveTicketImage')), 'the ticket’s own picture is unchanged in what it draws');

console.log('\n-- 6. styles --');
ok(/@media \(min-width: 1000px\) \{\n\s+\.pk-cols \{ display:grid; grid-template-columns:minmax\(0, 1fr\) 300px;/.test(css), 'on a PC the panel is a 300px column beside the legs');
ok(/\.pks \{ position:sticky; top:calc\(var\(--hdrH\) \+ var\(--sportsH\) \+ 16px\);/.test(css), 'pinned under the tabs while the legs scroll');
ok(/@media \(max-width: 999\.98px\) \{\n\s+\.pks \{ display:none; \}/.test(css) && /\.pks-bar \{ display:flex; position:fixed;/.test(css) && /\.pks\.open \{ display:block; position:fixed;/.test(css),
  'below that, a bar fixed at the bottom that opens the panel as a sheet');
for (const sel of ['.pks-rm', '.pks-x']) ok(new RegExp(`\\${sel} \\{[^}]*width:44px; height:44px;`).test(css), `${sel} is a 44px target`);
ok(/\.pks-open \{[^}]*min-height:44px;/.test(css) && /\.pks-more button \{[^}]*min-height:44px;/.test(css) && /\.pks-save \{[^}]*min-height:48px;/.test(css), 'the buttons are 44px or more');
ok(/#picksGrid:has\(\.pks-bar\) \{ padding-bottom:88px; \}/.test(css), 'room under the last card for the bar');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
