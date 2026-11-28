// UFC endings and fight time where DraftKings has no goes-the-distance price (2026-11-28, the
// owner's OK of the recommended fix: "let's work on recommended"). Before it, such a bout took the
// UFC's recent share (36.7% at three rounds), the same on every fight, and on three Dec 5 bouts that
// was above DraftKings' own chance of the fight getting past its rounds line (Chokheli v Dulatov,
// Over 1.5 at 36.4%): a fight that goes to the judges has to get past 1.5 rounds first, and the
// fight-time curve, bent to meet the line, came out bent as far as it goes, off DraftKings' number.
// What has to hold:
//   - with no distance price, a bout whose rounds line fits takes its decision chance from that
//     line: DraftKings' Over times the share of the UFC's fights still going there that went the
//     distance (x0.64 at 1.5 rounds and x0.88 at 2.5 of a three-round fight, x0.80 at 3.5 of a
//     five-round one, on the shares production had); never above DraftKings' Over
//   - the fight-time curve meets DraftKings' line on every such bout, the three that were off
//     among them, and falls to the decision chance at the final bell
//   - "How it ends" shows it and says where it came from; a bout with neither price says so, as
//     before
//   - a bout DraftKings prices the distance on reads that price, as before
//   - each logged bout says where its endings came from; the record counts the ones from the
//     rounds line, and on their own beside, and not a bout on the UFC's rate
//
// Real data: ESPN's scoreboard and fight center for the Dec 5 card (UFC Fight Night: Adesanya vs
// Magomedov), read Nov 27 at 11:08 UTC (tests/fixtures/ufc-sb-20261127.json, ufc-fc-600062700.json),
// and the last 180 days' distance shares production stamped on that card the same day (36.7% at
// three rounds, 31.6% at five: /api/ufc-board, 21:35 UTC). Stand-ins, said where they are:
// DraftKings' goes-the-distance on one bout (the real prices it had on Ortega v Hooker, Nov 21,
// tests/fixtures/ufc-fc-600061665.json), and results for the record, the card not being fought yet.
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

const SB = FIX('ufc-sb-20261127.json'), FC = FIX('ufc-fc-600062700.json'), FC21 = FIX('ufc-fc-600061665.json');
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
  run: async () => exec(s.sql, s.args, 'run') }; return s; },
  batch: async (sts) => sts.map((x) => exec(x.sql, x.args, /^\s*SELECT/i.test(x.sql) ? 'all' : 'run')) };
const env = { DB };
const wsrc = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(wsrc).toString('base64'));
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();

// The page's pieces, lifted from app.js.
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
function lift(name) {
  const at = app.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`app.js has no ${name}`);
  let depth = 0, seen = false;
  for (let i = at; i < app.length; i++) {
    const c = app[i];
    if (c === '{') { depth++; seen = true; } else if (c === '}') depth--;
    if (seen && depth === 0) return app.slice(at, i + 1);
  }
  throw new Error(`${name} doesn't close`);
}
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
let ufcEndsHtml;
try { ufcEndsHtml = new Function('esc', lift('ufcEndsHtml') + '\nreturn ufcEndsHtml;')(esc); }
catch (e) { console.log(`  FAIL  "How it ends" lifts out of app.js (${e.message})`); console.log('\n1 FAILED'); process.exit(1); }
const names = (b) => b.fighters.map((f) => f.name).join(' v ');

// The card's own DraftKings Over at each line, times the share still going there that went the
// distance (UFC_FINISH_SURV: 32.6% of early ends still going at 7:30 of a three-round fight, 8.1% at
// 12:30, 11.8% at 17:30 of a five-round one), on 36.7% and 31.6%.
const share = (pb, s) => pb / (pb + (1 - pb) * s);
const X15 = share(0.367, 0.326), X25 = share(0.367, 0.081), X35 = share(0.316, 0.118);
const WANT = {
  401933595: ['Adesanya v Magomedov', 61.3, X35], 401933597: ['Spivac v Pinto', 63.1, X15], 401933598: ['Chokheli v Dulatov', 36.4, X15],
  401933599: ['Santos v Abdullaev', 35.4, X25], 401933600: ['Tuchalov v Cutelaba', 55.4, X15], 401936244: ['Riley v Santos', 50, X25],
  401933601: ['Silva v Filho', 58.4, X25], 401933602: ['Satybaldiev v Gnizditskiy', 46.7, X15], 401933604: ['Andrusca v Osmanli', 58.4, X25],
  401933605: ['Rodrigues v Letho Duclos', 35.4, X15], 401933606: ['Hussein v Sosa', 56.2, X25], 401936473: ['Rębecki v Brener', 66.7, X15],
};
const OFF_BEFORE = ['401933598', '401933599', '401933605'];   // Chokheli, Santos, Rodrigues: 36.7% above DraftKings' Over
const MGA = '401933596', TULIO = '401933603', SPIVAC = '401933597', CHOK = '401933598', RODR = '401933605';

console.log('-- the Dec 5 card, with the shares production had that day --');
let d = await get('/api/ufc-board');
sq.prepare("INSERT OR REPLACE INTO feed_cache (key, data, updated_at, claimed_until) VALUES ('ufc_hist_meta', ?, ?, 0)")
  .run(JSON.stringify({ dist: { 3: 36.7, 5: 31.6 } }), NOW);
NOW += 16 * 60e3;                                          // past the card's 15-minute cache
d = await get('/api/ufc-board');
const bout = (id) => d.bouts.find((x) => x.id === String(id)) || {};
ok(d.bouts.length === 14 && d.bouts.every((b) => !b.dk || !b.dk.dist) && d.bouts.every((b) => b.distBase === (b.rounds === 5 ? 31.6 : 36.7)),
  `${d.event && d.event.name}: 14 bouts, no goes-the-distance price on any, the recent shares on each`);

console.log('\n-- the decision chance, from the rounds line --');
let good = 0;
for (const [id, [who, over, x]] of Object.entries(WANT)) {
  const b = bout(id), e = b.ends || {}, want = Math.round(over * x * 10) / 10;
  const fine = b.dk && b.dk.rounds && b.dk.rounds.pOver === over && e.src === 'rounds' && Math.abs(e.dec - want) <= 0.1 && e.dec < over
    && Math.abs(e.ko + e.sub + e.dec - 100) < 0.2;
  if (fine) good++;
  console.log(`        ${fine ? 'ok ' : 'BAD'} ${who.padEnd(26)} Over ${b.dk && b.dk.rounds && b.dk.rounds.line} at ${over}% -> decision ${e.dec}% (${e.src}), want ${want}`);
}
ok(good === 12, `all 12 bouts with a rounds line that fits (${good} of 12): 22.7% to 51.2%, not 36.7% on every one`);
ok(OFF_BEFORE.every((id) => bout(id).ends.dec < bout(id).dk.rounds.pOver),
  `the three that were above DraftKings' Over are under it now: ${OFF_BEFORE.map((id) => `${bout(id).ends.dec} < ${bout(id).dk.rounds.pOver}`).join(', ')}`);
ok([MGA, TULIO].every((id) => bout(id).ends.src === 'recent' && bout(id).ends.dec === 36.7),
  'Machado Garry v Amosov (a 4.5 line on three rounds) and Tulio v Park (no line) keep the UFC\'s rate');

console.log('\n-- the fight-time curve meets DraftKings\' line --');
const meets = Object.keys(WANT).filter((id) => { const b = bout(id); return b.time && Math.abs(b.time.pOver - b.dk.rounds.pOver) < 0.15; });
ok(meets.length === 12, `on all 12 (${meets.length}): ${OFF_BEFORE.map((id) => `${names(bout(id))} ${bout(id).time && bout(id).time.pOver}% v DraftKings ${bout(id).dk.rounds.pOver}%`).join('; ')}`);
// Half a minute from the final bell the fights still going are the decisions and the finishes in
// that last half minute (2.2% of early ends at three rounds, none at five), so the curve ends a
// little above the decision chance, never under it.
const falls = Object.keys(WANT).filter((id) => { const c = bout(id).curve, e = bout(id).ends;
  return c && c.every((v, i) => i === 0 || v <= c[i - 1]) && c[c.length - 1] >= e.dec - 0.1 && c[c.length - 1] <= e.dec + 3.5; });
ok(falls.length === 12, `each curve falls to just over the decision chance half a minute from the end (${falls.length} of 12): ${Object.keys(WANT).map((id) => `${bout(id).curve && bout(id).curve[bout(id).curve.length - 1]} v ${bout(id).ends.dec}`).join(', ')}`);

console.log('\n-- "How it ends" on the card --');
let t = text(ufcEndsHtml(bout(CHOK)));
console.log(`        ${t}`);
ok(/^How it ends KO\/TKO [\d.]+% Sub [\d.]+% Decision 23\.3% No goes-the-distance price yet: the decision chance is from DraftKings’ rounds line$/.test(t),
  'Chokheli v Dulatov: the split, and where the decision chance came from');
ok([MGA, TULIO].every((id) => text(ufcEndsHtml(bout(id))) === 'How it ends No DraftKings goes-the-distance price yet'), 'the two with no line that fits say so, as before');

console.log('\n-- DraftKings posts a goes-the-distance price (stand-in: its Nov 21 prices on Ortega v Hooker) --');
const comp = (fc, id) => Object.values(fc.cards).flatMap((g) => g.competitions || []).find((c) => String(c.id) === id);
comp(FC, SPIVAC).bets = JSON.parse(JSON.stringify(comp(FC21, '401922278').bets));
NOW += 16 * 60e3;
d = await get('/api/ufc-board');
const sv = bout(SPIVAC);
ok(sv.dk && sv.dk.dist && sv.ends.src === 'dk' && sv.ends.dec === sv.dk.dist.pYes && Math.abs(sv.time.pOver - sv.dk.rounds.pOver) < 0.15,
  `${names(sv)}: decision ${sv.ends.dec}%, DraftKings' own ${sv.dk.dist && sv.dk.dist.pYes}%; Over ${sv.dk.rounds.line} at ${sv.time.pOver}% v ${sv.dk.rounds.pOver}%`);
t = text(ufcEndsHtml(sv));
ok(/^How it ends KO\/TKO [\d.]+% Sub [\d.]+% Decision [\d.]+%$/.test(t), `no note on DraftKings' own price: "${t}"`);

console.log('\n-- the log and the record (stand-in results: the card is on Dec 5) --');
const row = (id) => sq.prepare('SELECT * FROM ufcbouts WHERE bout_id = ?').get(id);
ok(row(CHOK).ends_src === 'rounds' && row(CHOK).p_dec === bout(CHOK).ends.dec && row(SPIVAC).ends_src === 'dk' && row(MGA).ends_src === 'recent',
  `each bout logs where its endings came from: Chokheli ${row(CHOK).ends_src} at ${row(CHOK).p_dec}%, Spivac ${row(SPIVAC).ends_src}, Machado Garry ${row(MGA).ends_src}`);
const at = new RealDate(NOW).toISOString();
const res = (id, method, minutes) => sq.prepare('UPDATE ufcbouts SET method = ?, minutes = ?, graded_at = ? WHERE bout_id = ?').run(method, minutes, at, id);
res(CHOK, 'dec', 15); res(RODR, 'ko', 2.1); res(SPIVAC, 'sub', 8.4); res(MGA, 'dec', 15);
d = await get('/api/ufc-board');
const ends = (d.record || {}).ends || {}, fr = ends.fromRounds || {};
const lik = (id) => { const r = row(id); return r.p_dec >= r.p_ko && r.p_dec >= r.p_sub ? 'dec' : r.p_ko >= r.p_sub ? 'ko' : 'sub'; };
const hits = [[CHOK, 'dec'], [RODR, 'ko']].filter(([id, m]) => lik(id) === m).length;
ok(ends.n === 3 && fr.n === 2 && fr.hit === hits,
  `the likeliest ending counts Chokheli, Rodrigues (from the rounds line: ${fr.hit} of ${fr.n}) and Spivac (DraftKings' price), not Machado Garry: ${ends.n}`);
ok(fr.dec && fr.dec.stated === Math.round((row(CHOK).p_dec + row(RODR).p_dec) / 2 * 10) / 10 && fr.dec.landed === 50,
  `the decision chance from the rounds line, said v landed: ${fr.dec && fr.dec.stated}% v ${fr.dec && fr.dec.landed}%`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
