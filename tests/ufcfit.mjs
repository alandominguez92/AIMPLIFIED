// UFC numbers where DraftKings has none (2026-11-27, the PrizePicks payouts doc's fixes): "UFC
// fallbacks: Machado Garry vs Amosov, a 3-round fight, shows 'DraftKings 4.5 rounds: Over 0%'.
// Most fights show 'Decision 36.3%', and fights with no DraftKings line show 'More 57.1%'. Show
// 'no line yet' instead." What has to hold:
//   - a DraftKings rounds line the fight can't reach shows no chance and says why, and the
//     PrizePicks stepper starts inside the fight, not at DraftKings' 22.5 minutes
//   - a fight DraftKings hasn't priced (no rounds line that fits, no goes-the-distance) has no
//     curve, and its PrizePicks row says so; a line typed on it is saved, and priced only once
//     DraftKings prices the bout
//   - with no goes-the-distance price, "How it ends" says so instead of the UFC's averages (from
//     2026-11-28, one with a rounds line that fits takes it from that line: tests/ufcdist.mjs)
//   - the fights DraftKings prices read as they did
//   - the record leaves out a rounds line the fight couldn't reach, and an ending DraftKings
//     didn't price
//
// Real data: ESPN's UFC scoreboard and fight center for the Dec 5 card (UFC Fight Night:
// Adesanya vs Magomedov), read Nov 27 at 11:08 UTC (tests/fixtures/ufc-sb-20261127.json,
// ufc-fc-600062700.json): 14 bouts; DraftKings' goes-the-distance OFF on every one, its total
// rounds on 13, 4.5 on Machado Garry v Amosov, three rounds on ESPN's scoreboard, and nothing on
// Tulio v Park. Two stand-ins, said where they are: DraftKings pricing Tulio v Park later (the
// real prices it has on Satybaldiev v Gnizditskiy), and two results for the record, the card not
// being fought yet. And the Nov 20 board (tests/fixtures/ufc-board-20261120.json) for an ending
// DraftKings did price.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = (f) => JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', f), 'utf8'));
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const RealDate = Date;
let NOW = RealDate.parse('2026-11-27T11:10:00Z');
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

const SB = FIX('ufc-sb-20261127.json'), FC = FIX('ufc-fc-600062700.json');
const MGA = '401933596', TULIO = '401933603', SPIVAC = '401933597', MAIN = '401933595', SATY = '401933602';
globalThis.fetch = async (u) => {
  const url = String(u);
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.startsWith('https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard')) return json(url.includes('dates=') ? { events: [] } : SB);
  if (url.startsWith('https://site.api.espn.com/apis/common/v3/sports/mma/ufc/fightcenter/600062700')) return json(FC);
  return new Response('{}', { status: 404 });
};
const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const exec = (sql, args, mode) => { const st = sq.prepare(sql); const a = args.map(norm);
  if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
  return { success: true, meta: { changes: Number(st.run(...a).changes) } }; };
const DB = { prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
  all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
  run: async () => exec(s.sql, s.args, 'run') }; return s; }, batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')) };
const env = { DB };
const wsrc = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(wsrc).toString('base64'));
const call = (u, init) => mod.default.fetch(new Request('https://x' + u, init), env, { waitUntil: () => {} });
const get = async (u) => (await call(u)).json();
const KEY = 'k'.repeat(24);
const line = async (boutId, l) => { const r = await call('/api/ufc-lines', { method: 'POST', headers: { 'content-type': 'application/json', 'x-entry-key': KEY }, body: JSON.stringify({ boutId, line: l }) });
  return { status: r.status, body: await r.json() }; };

// The page's pieces, lifted from app.js.
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
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
  let at = app.indexOf(`function ${name}(`);
  const isConst = at < 0;
  if (isConst) at = app.indexOf(`const ${name} =`);
  if (at < 0) throw new Error(`app.js has no ${name}`);
  return closeFrom(app, at, isConst);
}
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const state = {};
let P;
try {
  P = new Function('state', 'esc', ['ufcClock', 'ufcLineOf', 'ufcOverAt', 'ufcTimeHtml', 'ufcEndsHtml', 'ufcPpHtml'].map(lift).join('\n')
    + '\nreturn { ufcLineOf, ufcTimeHtml, ufcEndsHtml, ufcPpHtml };')(state, esc);
} catch (e) { console.log(`  FAIL  the UFC rows lift out of app.js (${e.message})`); console.log('\n1 FAILED'); process.exit(1); }
const page = (b) => text(P.ufcTimeHtml(b) + P.ufcEndsHtml(b) + P.ufcPpHtml(b));
const names = (b) => b.fighters.map((f) => f.name).join(' v ');

console.log('-- the Dec 5 card as ESPN had it on Nov 27 --');
let d = await get('/api/ufc-board');
const bout = (id) => d.bouts.find((x) => x.id === id) || {};
ok(d.event && d.event.id === '600062700' && d.bouts.length === 14, `${d.event && d.event.name}: ${d.bouts.length} bouts`);
ok(d.bouts.every((b) => b.dk === null || !b.dk.dist) && d.bouts.filter((b) => b.dk && b.dk.rounds).length === 13,
  'DraftKings\' goes-the-distance is off on all 14, its total rounds on 13');

console.log('\n-- Machado Garry v Amosov: 4.5 rounds on a three-round fight --');
let m = bout(MGA);
console.log(`        ${names(m)}: ${m.rounds} rounds, DraftKings ${m.dk && m.dk.rounds && m.dk.rounds.line} (Over ${m.dk && m.dk.rounds && m.dk.rounds.over})`);
ok(m.rounds === 3 && m.dk.rounds.line === 4.5 && m.dk.rounds.over === -215, 'ESPN\'s scoreboard has it at 3 rounds; DraftKings\' line is 4.5, Over -215');
ok(m.time && m.time.fits === false && m.time.pOver === null && m.time.line === 4.5, `no chance at a line it can't reach (was "Over 0%"): ${JSON.stringify(m.time)}`);
ok(m.priced === false && m.curve === null, 'DraftKings has not priced it in a way that fits: no curve');
let t = page(m);
console.log(`        ${t}`);
ok(/^Fight time DraftKings’ 4\.5 rounds line doesn’t fit a 3-round fight: no chance shown/.test(t) && !/Over 0%/.test(t), 'the card says why there is no number');
ok(/PrizePicks time − 7\.5 \+ min no DraftKings line yet/.test(t) && !/More \d/.test(t), 'the PrizePicks stepper starts at 7.5, half the fight, not 22.5, with no chance');

console.log('\n-- Tulio v Park: no DraftKings line --');
const tp = bout(TULIO);
ok(tp.dk === null && tp.time === null && tp.priced === false && tp.curve === null, `${names(tp)}: no DraftKings price, no curve`);
t = page(tp);
console.log(`        ${t}`);
ok(/^Fight time No DraftKings rounds line yet/.test(t) && /PrizePicks time − 7\.5 \+ min no DraftKings line yet/.test(t) && !/More \d/.test(t),
  'no rounds line yet, and the PrizePicks row says DraftKings has none (was "More 57.1%")');

console.log('\n-- How it ends, with no goes-the-distance price --');
// From 2026-11-28 (tests/ufcdist.mjs) a bout with a rounds line that fits takes its decision chance
// from that line, and says so; the two with no line that fits still say there is no price.
const fromLine = d.bouts.filter((b) => b.ends && b.ends.src === 'rounds');
ok(d.bouts.every((b) => b.ends && b.ends.src !== 'dk') && fromLine.length === 12
  && fromLine.every((b) => /^How it ends KO\/TKO [\d.]+% Sub [\d.]+% Decision [\d.]+% No goes-the-distance price yet: the decision chance is from DraftKings’ rounds line$/.test(text(P.ufcEndsHtml(b))))
  && [MGA, TULIO].every((id) => text(P.ufcEndsHtml(bout(id))) === 'How it ends No DraftKings goes-the-distance price yet'),
  `no UFC averages: 12 from DraftKings' rounds line ("${text(P.ufcEndsHtml(bout(SPIVAC)))}"), the other two "No DraftKings goes-the-distance price yet"`);
const nov20 = FIX('ufc-board-20261120.json'), priced = nov20.bouts.find((b) => b.ends && b.ends.src === 'dk');
const pe = text(P.ufcEndsHtml(priced));
ok(/^How it ends KO\/TKO [\d.]+% Sub [\d.]+% Decision [\d.]+%$/.test(pe) && pe.includes(`Decision ${priced.ends.dec}%`), `one DraftKings priced, Nov 20: "${pe}"`);

console.log('\n-- the fights DraftKings prices, as they were --');
const sv = bout(SPIVAC), me = bout(MAIN);
ok(sv.priced === true && sv.time.line === 1.5 && sv.time.pOver === sv.dk.rounds.pOver && sv.curve.length === 29, `${names(sv)}: Over 1.5 rounds ${sv.time.pOver}%, DraftKings' own, a curve over 15 minutes`);
t = page(sv);
ok(/^Fight time DraftKings 1\.5 rounds \(7:30\): Over 63\.1%/.test(t) && /PrizePicks time − 7\.5 \+ min More 63\.1% · Less 36\.9%/.test(t), `the card: "${t}"`);
ok(me.rounds === 5 && me.priced === true && me.time.line === 3.5 && me.curve.length === 49 && Math.abs(me.time.pOver - me.dk.rounds.pOver) < 0.15,
  `the main event, five rounds: 3.5 rounds at ${me.time.pOver}%, its curve over 25 minutes`);

console.log('\n-- a PrizePicks line typed on Tulio v Park --');
let r = await line(TULIO, 7.5);
ok(r.status === 200 && r.body.line === 7.5 && r.body.pOver === null, `saved, unpriced: ${JSON.stringify(r.body)}`);
const row = (id) => sq.prepare('SELECT * FROM ufcbouts WHERE bout_id = ?').get(id);
ok(row(TULIO).pp_line === 7.5 && row(TULIO).pp_p_over === null, 'the log holds the line and no chance');
// Stand-in: DraftKings posts it, at the prices it has on Satybaldiev v Gnizditskiy.
const fcBout = (id) => Object.values(FC.cards).flatMap((g) => g.competitions || []).find((c) => String(c.id) === id);
fcBout(TULIO).bets = JSON.parse(JSON.stringify(fcBout(SATY).bets));
NOW += 16 * 60e3;                                          // past the card's 15-minute cache
d = await get('/api/ufc-board');
const tp2 = bout(TULIO);
ok(tp2.priced === true && tp2.time && tp2.time.line === 1.5 && tp2.curve && tp2.curve.length === 29, `DraftKings prices it: ${tp2.time && tp2.time.line} rounds, Over ${tp2.time && tp2.time.pOver}%`);
ok(row(TULIO).pp_p_over === tp2.curve[14] && typeof row(TULIO).pp_p_over === 'number', `and the next read prices the typed 7.5 from it: ${row(TULIO).pp_p_over}%`);
ok(row(MGA).pp_p_over === null, 'Machado Garry v Amosov, still unpriced, has none');

console.log('\n-- the record (stand-in results: the card is on Dec 5) --');
const at = new RealDate(NOW).toISOString();
sq.prepare("UPDATE ufcbouts SET method = 'dec', minutes = 15, graded_at = ? WHERE bout_id = ?").run(at, MGA);
sq.prepare("UPDATE ufcbouts SET method = 'ko', minutes = 3.2, graded_at = ? WHERE bout_id = ?").run(at, SPIVAC);
const logged = sq.prepare('SELECT bout_id, rounds, dk_line, p_over, p_dist FROM ufcbouts WHERE bout_id IN (?, ?)').all(MGA, SPIVAC);
console.log(`        logged: ${logged.map((x) => `${x.bout_id} ${x.rounds} rounds, DraftKings ${x.dk_line} at ${x.p_over}%, distance ${x.p_dist}`).join('; ')}`);
d = await get('/api/ufc-board');
const rec = d.record || {};
ok(rec.bouts === 2 && rec.timeAtDk.n === 1 && rec.timeAtDk.hit === 0,
  `fight time at DraftKings' line counts Spivac v Pinto (the Over 1.5 lost at 3:12), not 4.5 rounds on a 15-minute fight: ${rec.timeAtDk && rec.timeAtDk.hit} of ${rec.timeAtDk && rec.timeAtDk.n}`);
ok(rec.ends && rec.ends.n === 1 && rec.ends.fromRounds && rec.ends.fromRounds.n === 1,
  `and the likeliest ending counts Spivac v Pinto's, from DraftKings' rounds line (tests/ufcdist.mjs), not Machado Garry's, which nothing DraftKings has fits (${rec.ends && rec.ends.n})`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
