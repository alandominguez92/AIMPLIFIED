// Blocks More since the rule was set (2026-11-04).
//
// The rule came from the log through Oct 26: 16 of 23 at 55%+. Its record on the
// page counts those same legs, so 27 of 43 (63%) flatters it: since then it's
// 11 of 20 (55%), which is what a 2-pick Power has to beat. The owner asked for
// that number beside the record, and for it in the Nov 15 check. What has to hold:
//   - the kind's record and the NBA card's both carry the legs from Oct 27 on,
//     counted exactly as the record counts them (rotation, at the bar, first line)
//   - Picks' rows, its top card and the NBA tab show it; other kinds don't
//   - a stale cached record, with no `since`, reads as it did
//
// Real data: every NBA blocks leg of Oct 20 - Nov 2, 2026, from /api/nba-pp?day=
// on Nov 4 (tests/fixtures/nba-blk-20261020-1103.json).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const BOARD = path.join(import.meta.dirname, '..');
const { rows } = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'nba-blk-20261020-1103.json'), 'utf8'));

const RealDate = Date;
const NOW = RealDate.parse('2026-11-04T10:00:00Z');
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
globalThis.fetch = async () => new Response('{}', { status: 404 });
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
function exec(sql, args, mode) {
  const st = sq.prepare(sql);
  const a = args.map(norm);
  if (mode === 'all') return { results: st.all(...a), meta: {} };
  if (mode === 'first') return st.get(...a) || null;
  return { success: true, meta: { changes: Number(st.run(...a).changes) } };
}
const DB = {
  prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
    all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
    run: async () => exec(s.sql, s.args, 'run') }; return s; },
  batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')),
};
const env = { DB };
const mod = await import('data:text/javascript;base64,' + Buffer.from(fs.readFileSync(BOARD + '/worker.js', 'utf8')).toString('base64'));
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${m}`); if (!c) fail++; };

console.log('\n-- the record, from the real legs --');
await get('/api/picks'); await get('/api/nba-pp');   // the tables
const ins = sq.prepare(`INSERT INTO nbapp (date, game_id, player, market, commence, team, point, model_under, min_proj, captured_at, actual, result, model_ver)
  VALUES (?, ?, ?, 'blk', ?, ?, ?, ?, ?, ?, ?, ?, 'nbapp-v1')`);
for (const r of rows) ins.run(r.date, r.game_id, r.player, r.commence, r.team, r.point, r.model_under, r.min_proj, r.commence, r.actual, r.result);
const kind = (await get('/api/picks')).kinds.nba_blk_more.record;
ok(kind.n === 43 && kind.hit === 27, `the kind's whole record stands: ${kind.hit} of ${kind.n}`);
ok(kind.since && kind.since.from === '2026-10-27' && kind.since.n === 20 && kind.since.hit === 11 && kind.since.hitRate === 55,
  `since Oct 27: ${kind.since && kind.since.hit} of ${kind.since && kind.since.n} (${kind.since && kind.since.hitRate})`);
const card = (await get('/api/nba-pp')).record.blkMore;
ok(card.atBar.n === 43 && card.atBar.hit === 27, `the NBA card's whole record stands: ${card.atBar.hit} of ${card.atBar.n}`);
ok(card.since && card.since.from === '2026-10-27' && card.since.n === kind.since.n && card.since.hit === kind.since.hit, `and its since matches the kind's: ${card.since && card.since.hit} of ${card.since && card.since.n}`);

console.log('\n-- only blocks --');
const all = (await get('/api/picks')).kinds;
ok(Object.entries(all).every(([k, v]) => k === 'nba_blk_more' || !(v.record && v.record.since)), 'no other kind carries one');
const nhl = (await get('/api/nhl-pp')).record;
ok(nhl && (!nhl.more || !nhl.more.since), "and the NHL card's More record doesn't");

console.log('\n-- on the page --');
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
  throw new Error(`could not close ${name}`);
}
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
let P;
try {
  P = new Function('esc', ['pct0', 'shortDay', 'recSinceText', 'ppMoreLineHtml'].map(lift).join('\n') + '\nreturn { recSinceText, ppMoreLineHtml };')(esc);
} catch (e) { console.log(`  FAIL  the page's helpers lift out of app.js (${e.message})`); process.exit(1); }
const text = (h) => h.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
ok(P.recSinceText(kind) === ' · since the rule (Oct 27): 11 of 20 (55%)', `on a Picks row: "${P.recSinceText(kind)}"`);
ok(P.recSinceText(null) === '' && P.recSinceText({ n: 43, hit: 27 }) === '', 'a record with none, or a stale cached one: nothing');
ok(P.recSinceText({ ...kind, since: { from: '2026-10-27', n: 0, hit: 0, hitRate: null } }) === '', 'none graded since: nothing');
const line = text(P.ppMoreLineHtml(card, 'Blocks'));
ok(line === 'Blocks: where the model leaned More 45 of 78 · at 55%+ 27 of 43 · since the rule (Oct 27) 11 of 20', `on the NBA tab: "${line}"`);
ok(text(P.ppMoreLineHtml({ ...card, since: undefined }, 'Blocks')) === 'Blocks: where the model leaned More 45 of 78 · at 55%+ 27 of 43', 'the NHL card, or a stale record, reads as it did');
ok(/const recTxt = r\.n \? `Legs like this: \$\{r\.hit\} of \$\{r\.n\} \(\$\{pct0\(r\.hitRate\)\}\)\$\{recSinceText\(r\)\}/.test(app), "Picks' rows show it");
ok(/landed \(\$\{pct0\(r\.hitRate\)\}\)\$\{recSinceText\(r\)\}/.test(lift('heroLegHtml')), 'and its top card');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
