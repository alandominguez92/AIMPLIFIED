// "Last night", the entry ticket, and the chance ring (2026-10-28).
//
// The owner asked for a flashier page, saw mockups of three ideas, and asked
// for all three: a recap of yesterday at the top of Picks, the PrizePicks
// entry as a ticket to screenshot, and the top leg's chance as a ring that
// fills in. What has to hold:
//   - "Last night" is yesterday's legs graded -- the PrizePicks entry's from
//     the day its pool was first logged, the list's before -- its count, the
//     entry's units, the edge bets' day, and what left before the start; open
//     the first time a day shows on this device, folded after
//   - the ticket is the pool's top n legs (3 to start: the 3-pick Flex), More
//     or Less at each line, the chance all land, PrizePicks' payouts, the
//     worker's edge and stake for that size; 2 to 6 by a tap; no edge or stake
//     once a leg of it has started; Save image draws it for the phone
//   - the ring is the chance, gold at 75%+, green where a sportsbook price
//     beats its line; it fills from empty once a page load, after the tab's
//     first draws settle
//
// Real data: production's /api/picks at 1:47 PM Pacific on Oct 28
// (tests/fixtures/picks-entry-20261028.json: its pool, entries and day
// record) and its list at 1:50 AM (tests/fixtures/picks-ml-20261028.json).
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
const F = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'picks-entry-20261028.json'), 'utf8'));
const ML = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'picks-ml-20261028.json'), 'utf8'));
const RealDate = Date;
const NOW = RealDate.parse('2026-10-28T20:47:36Z');

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const css = fs.readFileSync(BOARD + '/style.css', 'utf8').replace(/\r\n/g, '\n');
function lift(name) {
  let at = app.search(new RegExp(`\\n  (async )?function ${name}\\(`));
  if (at >= 0) { at++; let d = 0; for (let i = app.indexOf(') {', at) + 2; i < app.length; i++) { if (app[i] === '{') d++; else if (app[i] === '}' && --d === 0) return app.slice(at, i + 1); } }
  at = app.search(new RegExp(`\\n  (const|let) ${name}\\b`));
  if (at < 0) throw new Error(`app.js has no ${name}`);
  at++; let d = 0;
  for (let i = at; i < app.length; i++) { const c = app[i]; if ('{(['.includes(c)) d++; else if ('})]'.includes(c)) d--; else if (c === ';' && d === 0) return app.slice(at, i + 1); }
  throw new Error(`could not lift ${name}`);
}
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const store = {};
const env = {
  esc, Date: class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } },
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
  state: { bank: { amount: null, cap: 5 }, ticketN: null },
  // The recap's edge bets name their price and book (2026-10-30).
  AM: (n) => (n == null ? '—' : (n > 0 ? '+' + n : String(n))), bkLabel: (k) => ({ draftkings: 'DK', fanduel: 'FD', betmgm: 'MGM' }[k] || String(k).toUpperCase()),
  ptDayOf: (ms) => (ms ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new RealDate(ms)) : null),
  shortDay: (ymd) => new RealDate(ymd + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
  pct0: (v) => (typeof v === 'number' ? `${Math.round(v)}%` : '—'),
  pickFace: (x) => `<i class="face" data-who="${esc((x.spec || {}).player || x.title)}"></i>`,
};
const names = ['pickIsTeam', 'moneyTxt', 'stakeTxt', 'recapSeenAtLoad', 'shortLeg', 'recapHtml', 'PP_PAY', 'ticketData', 'ticketHtml', 'RING_C', 'chanceRingSvg'];
let P;
// The seen-day read sits on the line after its declaration.
const seenRead = (app.match(/\n  (let recapSeenAtLoad = null;\n  try \{ recapSeenAtLoad = localStorage\.getItem\('aimplified_recap_seen'\); \} catch \(e\) \{[^}]*\})/) || [])[1];
if (!seenRead) { console.log('  FAIL  the seen-day read is not in app.js'); process.exit(1); }
const build = () => new Function(...Object.keys(env), names.map((n) => (n === 'recapSeenAtLoad' ? seenRead : lift(n))).join('\n')
  + `\nreturn { ${names.filter((n) => !/^[A-Z]/.test(n) && n !== 'recapSeenAtLoad').join(', ')} };`)(...Object.values(env));
try { P = build(); } catch (e) { console.log(`  FAIL  the pieces lift out of app.js (${e.message})`); process.exit(1); }

// ---- Last night ----------------------------------------------------------------------------------
console.log('-- Last night, Oct 28 for Oct 27 --');
const h = F.history;
const r1 = P.recapHtml(h, null);
console.log('  ' + text(r1));
ok(/<details class="pk-recap" open>/.test(r1) && store.aimplified_recap_seen === '2026-10-27', 'open the first time the day shows, and remembered');
ok(text(r1).startsWith('Last night Oct 27 2 of 3 ✓✓✗') && /✓ Celtics ✓ AS Roma ✗ Ducks/.test(text(r1)),
  "Tuesday's list: the Celtics and Roma landed, the Ducks lost");
ok(/Top 2 Power \+2\.00u/.test(text(r1)) && /Top 3 Flex \+0\.25u/.test(text(r1)) && /Off before the start: Harper U1\.5 3PM, would have landed/.test(text(r1)),
  "its units, and Dylan Harper's pulled under, which would have landed");
P = build();                                                  // a later page load on the same device
ok(/<details class="pk-recap">/.test(P.recapHtml(h, null)) && !/ open>/.test(P.recapHtml(h, null)), 'folded on the next load');
const eb = { byDay: { '2026-10-27': { n: 4, hit: 3, units: 7.5, clvN: 4, beat: 4 } } };
ok(/Edge bets 3 of 4 · \+7\.50u · beat the close 4 of 4/.test(text(P.recapHtml(h, eb))), "and the edge bets' day, where it has one (the worker's byDay: tests/edgebets.mjs)");
// Which bets (2026-10-30): the worker's byDay carries each one now.
const eb2 = { byDay: { '2026-10-27': { ...eb.byDay['2026-10-27'], n: 2, hit: 1, bets: [{ label: 'Blazers ML', price: 400, book: 'draftkings', result: 'hit', beat: true }, { label: 'Over 2.5 goals', price: -105, book: 'fanduel', result: 'miss', beat: false }] } } };
ok(/Edge bets: ✓ Blazers \+400 DK, beat the close · ✗ Over 2\.5 goals -105 FD, missed the close/.test(text(P.recapHtml(h, eb2))), 'each bet by name, price and book, and whether it beat the close');
ok(P.shortLeg('Wendell Carter Jr Under 2.5 AST') === 'Carter Jr U2.5 AST' && P.shortLeg('Kyshawn George Over 0.5 BLK') === 'George O0.5 BLK' && P.shortLeg('Celtics ML') === 'Celtics',
  'legs by short names: "Carter Jr U2.5 AST", "George O0.5 BLK", "Celtics"');
ok(P.recapHtml({ days: h.days.filter((d) => d.date !== '2026-10-27') }, null) === '', 'nothing when yesterday has no day');

// The first night of the entry, at 12:15 AM on Oct 29: its NHL legs not yet
// graded, and the edge bets' first day (tests/fixtures/picks-record-20261029.json).
console.log('\n-- Last night, 12:15 AM Oct 29 for Oct 28 --');
const G = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'picks-record-20261029.json'), 'utf8'));
env.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [RealDate.parse(G.asOf)])); } static now() { return RealDate.parse(G.asOf); } };
P = build();
const r2 = P.recapHtml(G.history, G.edgeRecord);
console.log('  ' + text(r2));
const d28 = G.history.days.find((d) => d.date === '2026-10-28');
const pend = d28.pool.filter((x) => x.result == null).length;
ok(text(r2).startsWith(`Last night Oct 28 2 of 3 ${pend} still to grade`) && /✓ George O0\.5 BLK · Lehkonen O0\.5 PTS ✗ VanVleet U2\.5 3PM/.test(text(r2)),
  `the entry's legs, and the ${pend} NHL legs still to grade said so`);
ok(/<li><span>Edge bets<\/span><b>1 of 5 · <i class="o">−2\.25u<\/i> · beat the close 4 of 5<\/b><\/li>/.test(r2) && /The list 9 of 9/.test(text(r2)),
  "the edge bets' first day: 1 of 5 and down, red on the units only -- 4 of 5 beat the close; the list 9 of 9");
env.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
P = build();
ok(/\.rc-lines li > span \{ white-space:nowrap; \}/.test(css), '"Edge bets" on one line on a phone');

// ---- the entry ticket -----------------------------------------------------------------------------
console.log('\n-- the ticket --');
const pool = F.ppPool;
let t = P.ticketData({ entries: F.entries }, pool, true);
console.log('  ' + text(P.ticketHtml(t)));
const e3 = F.entries.find((e) => e.legs === 3);
ok(t.n === 3 && t.name === '3-pick Flex' && t.legs.map((l) => l.short).join() === 'Carter Jr,Flagg,George' && t.legs.map((l) => l.pick).join() === 'Less 2.5 AST,Less 6.5 AST,More 0.5 BLK',
  'it opens on the 3-pick Flex: Carter Less 2.5 AST, Flagg Less 6.5 AST, George More 0.5 BLK');
ok(Math.round(t.all * 10) / 10 === e3.allLand && t.pays === '3 of 3 2.25x · 2 of 3 1.25x' && t.ev === e3.ev && t.stake === 2 && t.capped,
  `all three land ${Math.round(t.all)}% (the worker's ${e3.allLand}), pays 2.25x and 1.25x, +${t.ev}% at the 2% cap`);
env.state.ticketN = 2; t = P.ticketData({ entries: F.entries }, pool, true);
ok(t.name === '2-pick Power' && t.pays === 'both land 3x' && t.ev === F.entries.find((e) => e.legs === 2).ev && t.legs.length === 2, `a tap on 2: the Power, +${t.ev}%`);
env.state.ticketN = 6; t = P.ticketData({ entries: F.entries }, pool, true);
ok(t.legs.length === 6 && t.pays === '6 of 6 25x · 5 of 6 2x · 4 of 6 0.4x' && t.sizes.join() === '2,3,4,5,6' && /data-n="6" aria-pressed="true"/.test(P.ticketHtml(t)), 'on 6: every leg, and each size a tap away');
env.state.ticketN = null;
t = P.ticketData({ entries: F.entries }, pool, false);
ok(t.ev == null && !/¼ Kelly/.test(text(P.ticketHtml(t))) && !/edge/.test(text(P.ticketHtml(t))), 'once a leg has started, no edge or stake: the worker priced the whole pool');
env.state.bank = { amount: 500, cap: 5 };
ok(/¼ Kelly \$10 \(2%\) cap/.test(text(P.ticketHtml(P.ticketData({ entries: F.entries }, pool, true)))), 'the stake in dollars against a bankroll');
env.state.bank = { amount: null, cap: 5 };
ok(P.ticketData({ entries: F.entries }, pool.slice(0, 1), true) === null, 'no ticket for one leg');
ok(/case 'ticket-n': state\.ticketN = Number\(target\.dataset\.n\) \|\| 3; renderPicks\(\); break;/.test(app) && /case 'ticket-save': saveTicketImage\(\); break;/.test(app)
  && /cv\.toBlob\(/.test(lift('saveTicketImage')) && /navigator\.canShare && navigator\.canShare\(\{ files: \[file\] \}\)/.test(lift('saveTicketImage')),
  'Save image draws it on a canvas, to the share sheet where the phone has one, else a download');
ok(/\+ ticketHtml\(ticketData\(d, ppLegs, whole\)\)/.test(lift('renderPicks')), "on the entry's card, under its legs");

// ---- the chance ring ------------------------------------------------------------------------------
console.log('\n-- the ring --');
const C = 2 * Math.PI * 34;
const off = (p) => Math.round(C * (1 - p / 100) * 10) / 10;
const carter = pool[0], hou = ML.legs.find((x) => /^Rockets ML/.test(x.title)), nyk = ML.legs.find((x) => /^Knicks ML/.test(x.title));
const rc = P.chanceRingSvg(carter), rh = P.chanceRingSvg(hou), rn = P.chanceRingSvg(nyk);
ok(/class="hl-ring gold"/.test(rc) && rc.includes(`stroke-dashoffset:${off(carter.p)}`), `Carter at ${carter.p}%: gold, filled to ${carter.p}%`);
ok(/class="hl-ring edge"/.test(rh) && hou.ev > 0, `the Rockets at -305 (+${hou.ev}% EV): green, the price beats the line`);
ok(/class="hl-ring"/.test(rn) && nyk.ev < 0 && nyk.p < 75, `the Knicks at ${nyk.p}%, short of their price: the plain ring`);
ok(/<div class="hl-p ring\$\{good \? ' good' : ''\}"><span class="hl-pct">\$\{pct0\(x\.p\)\}<\/span><span class="hl-pk">chance<\/span>\$\{chanceRingSvg\(x\)\}<\/div>/.test(lift('heroLegHtml')),
  'round the top leg\'s number');
ok(/picksAnimate\(grid\);\n  \}/.test(app) && /grid\.classList\.add\('pk-pre'\);[\s\S]*?setTimeout\(\(\) => \{\s*picksAnimDone = true;\s*grid\.classList\.remove\('pk-pre'\);\s*grid\.classList\.add\('bars-in'\);/.test(lift('picksAnimate'))
  && /\.pk-pre \.hl-ring \.rg-f \{ stroke-dashoffset:var\(--rc\) !important; \}/.test(css) && /\.bars-in \.hl-ring \.rg-f \{ animation:ringIn/.test(css),
  'it fills once a page load, held empty until the first draws settle');
ok(/@media \(max-width:560px\)[^}]*\{[^]*?\.pk-entries-ev li/.test(css) && /\.tk-legs \{ display:grid; grid-template-columns:repeat\(auto-fill, minmax\(80px, 1fr\)\)/.test(css), 'three legs across on a phone');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
