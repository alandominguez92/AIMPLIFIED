// PrizePicks' payouts as the owner checked them in the app (2026-11-27).
//
// The owner's doc "Aimplified: PrizePicks payouts and page changes": every entry size in the
// PrizePicks app (California, standard lines, entries built and not placed) matched PrizePicks'
// table of Sept 18, 2026 -- Power 2 to 6 at 3x, 6x, 10x, 20x and 37.5x; Flex 3 at 3x and 1x, 4 at
// 6x and 1.5x, 5 at 10x, 2x and 0.4x, 6 at 25x, 2x and 0.4x -- while the site still paid the old
// 3-pick Power (5x) and 3- and 4-pick Flex (2.25x and 1.25x, 5x and 1.5x). The one exception
// in the app: a 6-pick Power with two picks of one game paid 35.5x. What has to hold:
//   - the worker's tables are the app's, and the page's are the worker's
//   - every break-even the page and the worker state is the one its table gives: the chance a
//     leg needs for the entry to return its stake on average
//   - the history regrades on the new table: Nov 22's real pool paid its 3-pick Flex 3x (it
//     was counted 2.25x) and its 4-pick 6x (5x); Nov 15's 3 of 4 still 1.5x
//   - two legs of one game in the entry or the slip: PrizePicks may pay less, and its cut is
//     its own, so the ticket and the slip say so and leave the number to the app
//
// Real data: tests/fixtures/picks-history-20261127.json (production's /api/picks history days
// of Nov 22 and Nov 15, as graded on the old table) and the Oct 28 entry's legs
// (tests/fixtures/picks-entry-20261028.json). No recorded pool has two legs of one game in its
// top six, so the pair is made by giving Flagg's leg Carter's game id.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');
const worker = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
const read = (f) => JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', f), 'utf8'));
const H = read('picks-history-20261127.json');
const F = read('picks-entry-20261028.json');

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// The worker's pieces, top level.
const liftW = (name) => {
  const fn = worker.indexOf(`\nfunction ${name}(`);
  if (fn >= 0) {
    let depth = 0;
    for (let i = worker.indexOf('{', fn); i < worker.length; i++) { if (worker[i] === '{') depth++; else if (worker[i] === '}' && --depth === 0) return worker.slice(fn + 1, i + 1); }
  }
  const at = worker.search(new RegExp(`\\n(const|let) ${name} =`));
  if (at < 0) throw new Error('worker.js has no ' + name);
  let depth = 0;
  for (let i = at + 1; i < worker.length; i++) {
    const c = worker[i];
    if ('{(['.includes(c)) depth++; else if ('})]'.includes(c)) depth--;
    else if (c === ';' && depth === 0) return worker.slice(at + 1, i + 1);
  }
  throw new Error('could not lift ' + name);
};
// The page's, inside its closure (two spaces in).
function liftA(name) {
  let at = app.search(new RegExp(`\\n  (async )?function ${name}\\(`));
  if (at >= 0) { at++; let d = 0; for (let i = app.indexOf(') {', at) + 2; i < app.length; i++) { if (app[i] === '{') d++; else if (app[i] === '}' && --d === 0) return app.slice(at, i + 1); } }
  at = app.search(new RegExp(`\\n  (const|let) ${name}\\b`));
  if (at < 0) throw new Error(`app.js has no ${name}`);
  at++; let d = 0;
  for (let i = at; i < app.length; i++) { const c = app[i]; if ('{(['.includes(c)) d++; else if ('})]'.includes(c)) d--; else if (c === ';' && d === 0) return app.slice(at, i + 1); }
  throw new Error(`could not lift ${name}`);
}

const wNames = ['PP_POWER', 'PP_FLEX', 'PICKS_BREAK_EVEN', 'PICK_HIST_ENTRIES', 'histTotals', 'histDayEntries'];
let W;
try { W = new Function(wNames.map(liftW).join('\n') + `\nreturn { ${wNames.join(', ')} };`)(); }
catch (e) { console.log(`  FAIL  the worker's pieces lift out (${e.message})`); process.exit(1); }

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const env = {
  esc, state: { bank: { amount: null, cap: 5 }, ticketN: 3, logSides: {}, logBook: 'pp' },
  pct0: (v) => (typeof v === 'number' ? `${Math.round(v)}%` : '—'),
  pickFace: (x) => `<i class="face" data-who="${esc((x.spec || {}).player || x.title)}"></i>`,
  entryLegFrom: (l) => ({ modelProb: l.p }),
};
const aNames = ['PP_BREAK_EVEN', 'PP_SAME_GAME_PAY', 'PP_PAY', 'pickIsTeam', 'pickTeamCode', 'pickTeamTag', 'moneyTxt', 'stakeTxt', 'shortLeg', 'ticketData', 'ticketHtml', 'slipReadHtml'];
let A;
try { A = new Function(...Object.keys(env), aNames.map(liftA).join('\n') + `\nreturn { ${aNames.join(', ')} };`)(...Object.values(env)); }
catch (e) { console.log(`  FAIL  the page's pieces lift out (${e.message})`); process.exit(1); }

// ---- the table ------------------------------------------------------------------------------------
console.log('-- the table, as the app paid it on Nov 27 --');
const APP = { power: { 2: 3, 3: 6, 4: 10, 5: 20, 6: 37.5 }, flex: { 3: { 3: 3, 2: 1 }, 4: { 4: 6, 3: 1.5 }, 5: { 5: 10, 4: 2, 3: 0.4 }, 6: { 6: 25, 5: 2, 4: 0.4 } } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
ok(same(W.PP_POWER, APP.power), `the worker's Power: ${Object.entries(W.PP_POWER).map(([n, v]) => `${n} at ${v}x`).join(', ')}`);
ok(same(W.PP_FLEX, APP.flex), `the worker's Flex: 3 at ${W.PP_FLEX[3][3]}x/${W.PP_FLEX[3][2]}x, 4 at ${W.PP_FLEX[4][4]}x/${W.PP_FLEX[4][3]}x, 5 and 6 as they were`);
ok(same(A.PP_PAY.power, W.PP_POWER) && same(A.PP_PAY.flex, W.PP_FLEX), "the page's ticket pays the worker's table");

// ---- the break-evens ------------------------------------------------------------------------------
console.log('\n-- what a leg needs --');
const C = (n, k) => { let c = 1; for (let i = 0; i < k; i++) c = c * (n - i) / (i + 1); return c; };
const ret = (n, pay, p) => Object.entries(pay).reduce((s, [k, v]) => s + C(n, +k) * p ** +k * (1 - p) ** (n - k) * v, 0);
const solve = (n, pay) => { let lo = 0.3, hi = 0.95; for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (ret(n, pay, m) < 1) lo = m; else hi = m; } return Math.round((lo + hi) / 2 * 1000) / 10; };
const be = { 2: solve(2, { 2: APP.power[2] }), 3: solve(3, APP.flex[3]), 4: solve(4, APP.flex[4]), 5: solve(5, APP.flex[5]), 6: solve(6, APP.flex[6]) };
console.log(`  from the table: 2-pick Power ${be[2]}, Flex 3 ${be[3]}, 4 ${be[4]}, 5 ${be[5]}, 6 ${be[6]}; 3-pick Power ${solve(3, { 3: 6 })}`);
ok(be[3] === 57.7 && be[4] === 55 && be[5] === 54.3 && be[6] === 54.2 && be[2] === 57.7, 'the 3-pick Flex needs 57.7% a leg (was 59.1%), the 4-pick 55.0% (was 56.9%); 2, 5 and 6 as they were');
const stated = (t) => [2, 3, 4, 5, 6].every((n) => t[n] && t[n][1] === be[n]);
ok(stated(W.PICKS_BREAK_EVEN), "the worker's Picks bars are the table's");
ok(stated(A.PP_BREAK_EVEN), "the page's bars are the table's");
const top = (worker.match(/breakEvens: \{([^}]*)\}/) || [])[1] || '';
const topV = Object.fromEntries([...top.matchAll(/'(\d)-pick (?:flex|power)': ([\d.]+)/g)].map((m) => [m[1], Number(m[2])]));
ok([2, 3, 4, 5, 6].every((n) => topV[n] === be[n]), `the top-legs report's break-evens too (${top.trim()})`);
const note = (worker.match(/break-evens for reference: ([^']*)'/) || [])[1] || '';
ok(/3-pick flex 57\.7%, 4-pick flex 55\.0%/.test(note) && !/56\.9|59\.1/.test(note), `and the PrizePicks unders note ("${note}")`);

// ---- the history ----------------------------------------------------------------------------------
console.log('\n-- the record, regraded --');
const day = (d) => H.days.find((x) => x.date === d);
const regrade = (d) => { const tots = W.histTotals(); return { e: W.histDayEntries(d.pool.map((x) => ({ p: x.p, result: x.result })), [tots]), tots }; };
const n22 = regrade(day('2026-11-22'));
const old22 = day('2026-11-22').entries;
console.log(`  Nov 22, the Broncos and seven player legs, top six all landed: was ${Object.entries(old22).map(([k, v]) => `${k} ${v.net}`).join(', ')}; now ${Object.entries(n22.e).map(([k, v]) => `${k} ${v.net}`).join(', ')}`);
ok(old22.f3.net === 1.25 && n22.e.f3.pay === 3 && n22.e.f3.net === 2, "its 3-pick Flex landed 3 of 3: counted +1.25u at 2.25x, now +2u at 3x");
ok(old22.f4.net === 4 && n22.e.f4.pay === 6 && n22.e.f4.net === 5, 'its 4-pick Flex 4 of 4: +4u at 5x, now +5u at 6x');
ok(n22.e.p2.net === 2 && n22.e.f5.net === 9 && n22.e.f6.net === 24, 'its Power, 5- and 6-pick Flex pay as they did (+2, +9, +24)');
const n15 = regrade(day('2026-11-15'));
const old15 = day('2026-11-15').entries;
ok(old15.f3.net === 1.25 && n15.e.f3.net === 2 && n15.e.f4.wins === 3 && n15.e.f4.net === 0.5 && n15.e.f5.net === 1 && n15.e.f6.net === -0.6,
  `Nov 15: 3 of 3 now +2u; 3 of 4 still 1.5x (+0.5u), 4 of 5 2x, 4 of 6 0.4x`);
const two = W.histDayEntries([{ p: 70, result: 'hit' }, { p: 68, result: 'miss' }, { p: 66, result: 'hit' }], [W.histTotals()]);
ok(two.f3.pay === 1 && two.f3.net === 0, 'two of three is the stake back now (1x), not +0.25u');

// ---- one game, two legs ---------------------------------------------------------------------------
console.log('\n-- two legs of one game --');
const pool = F.ppPool.map((x) => JSON.parse(JSON.stringify(x)));
const carter = pool.find((x) => /Carter/.test(x.title)), flagg = pool.find((x) => /Flagg/.test(x.title));
let t = A.ticketData({ entries: F.entries }, pool, true);
ok(t.n === 3 && t.sameGame.length === 0 && !/tk-same/.test(A.ticketHtml(t)), "the Oct 28 entry's top three are three games: no note");
ok(t.pays === '3 of 3 3x · 2 of 3 1x', `and it pays "${t.pays}"`);
flagg.spec.gamePk = carter.spec.gamePk;
t = A.ticketData({ entries: F.entries }, pool, true);
const th = A.ticketHtml(t);
console.log('  ' + text(th).replace(/^.*?(Same game)/, '$1').replace(/ Save image$/, ''));
ok(t.sameGame.length === 1 && t.sameGame[0].length === 2 && /<div class="tk-same">Same game: Carter Jr and Flagg\. PrizePicks may pay less with two legs from one game: check the payout the app shows\.<\/div>/.test(th),
  'Carter and Flagg in one game: the ticket names them and says PrizePicks may pay less');
env.state.ticketN = 2;
const t2 = A.ticketData({ entries: F.entries }, pool, true);
ok(t2.sameGame.length === 1 && /tk-same/.test(A.ticketHtml(t2)), 'on the 2-pick too');
env.state.ticketN = 3;
const slipLegs = [carter, flagg].map((x) => ({ ...x, id: x.id || x.title }));
const sp = A.slipReadHtml(slipLegs);
ok(/2 legs from one game<\/b> \(Carter, Flagg\) win or lose together\. PrizePicks may pay less with two legs from one game: check the payout the app shows\./.test(sp),
  'the slip, logged as PrizePicks: the same-game note says the payout may be less, and names Carter, not "Jr"');
env.state.logBook = 'dk';
ok(!/PrizePicks may pay less/.test(A.slipReadHtml(slipLegs)), 'logged as a DraftKings parlay: no PrizePicks note');
env.state.logBook = 'pp';
ok(/a 3-pick flex needs <b>57\.7%<\/b> a leg/.test(A.slipReadHtml([carter, flagg, pool.find((x) => /George/.test(x.title))].map((x) => ({ ...x, id: x.title })))),
  "and a 3-leg slip's bar is the new 57.7%");

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
