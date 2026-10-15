// PrizePicks' soccer lines, saved and graded (2026-10-15).
//
// No feed carries PrizePicks' soccer props, so the soccer card has priced each
// starter at a default line (the half point above the projection), and only
// that line was logged and graded (socprops). The number the user typed in to
// match the app lived in the phone's memory and was never graded. Now each
// line set on the card is saved to the worker and graded at that number, in a
// table of its own -- the record that decides whether soccer props join Picks
// of the day (not yet: that waits for 100-150 legs graded at real lines).
//
// Real SQLite (node:sqlite) and real ESPN payloads: tests/fixtures/
// espn-soc-740870.json, Fulham v Tottenham with both lineups (the summary
// /api/soccer-props reads), and the real soccer-priors.json. The card's own
// functions are lifted out of app.js and run against the worker in-process.
//
// What has to hold:
//   - the lines are private the way the entries log is: no key, no access; the
//     key that opens the log opens them, another does not; never cached, never
//     readable cross-origin, answered before the shared edge cache
//   - only a row the model logged (a starter on a posted lineup) takes a line,
//     a line is a whole or half number, and kickoff locks it
//   - the chance stored is the one the card showed at that line, and the side
//     the one it favours; a later change replaces the line, not the first time
//   - graded from the same box scores at the PrizePicks number, beside the
//     model's own row at its default line, which is never relabelled
//   - /api/soccer-props?summary=1 reports the record at PrizePicks' lines by
//     stat and by band, with fouls called out on their own
//   - the card saves a line a moment after the last tap (one request for a run
//     of taps), marks it saved, and after a reload shows the saved lines again
//     -- without making a key on a device that has none
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const cacheHits = [];
globalThis.caches = { default: {
  match: async (k) => { cacheHits.push(String(k.url || k)); return undefined; },
  put: async (k) => { cacheHits.push(String(k.url || k)); },
} };

const RealDate = Date;
let NOW = RealDate.parse('2026-03-08T23:00:00Z');   // a week after the recorded match
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const iso = (ms) => new RealDate(ms).toISOString();

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
const PRIORS = fs.readFileSync(path.join(BOARD, 'soccer-priors.json'), 'utf8');
const env = { DB, ASSETS: { fetch: async (r) => (new URL(r.url).pathname === '/soccer-priors.json'
  ? new Response(PRIORS, { status: 200 }) : new Response('{}', { status: 404 })) } };

// ---- the feeds: the recorded lineup, kicking off in 45 minutes --------------------------
const REC = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'espn-soc-740870.json'), 'utf8'));
const SUMMARY = Object.entries(REC).find(([u]) => u.includes('/summary'))[1];
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new RealDate(NOW)).replace(/-/g, '');
const KICK = NOW + 45 * 60e3;
const FEED = {
  [`https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard?dates=${day}`]: { events: [{ id: 'NEXT1', date: iso(KICK),
    status: { type: { state: 'pre', completed: false } },
    competitions: [{ competitors: [{ id: '370', homeAway: 'home', team: { abbreviation: 'FUL', displayName: 'Fulham' } },
      { id: '367', homeAway: 'away', team: { abbreviation: 'TOT', displayName: 'Tottenham Hotspur' } }] }] }] },
  'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event=NEXT1': SUMMARY,
};
globalThis.fetch = async (u) => {
  const url = String(u);
  if (FEED[url]) return new Response(JSON.stringify(FEED[url]), { status: 200 });
  if (url.includes('/scoreboard?dates=')) return new Response(JSON.stringify({ events: [] }), { status: 200 });
  return new Response('{}', { status: 404 });
};
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const ctx = { waitUntil: () => {} };
const hit = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, ctx)).json();
const KEY = 'phone-key-0123456789abcdef', OTHER = 'someone-elses-key-0000000000';
const lines = async (method, body, key = KEY, route = '/api/soc-lines') => {
  const headers = { 'content-type': 'application/json' };
  if (key) headers['x-entry-key'] = key;
  const r = await mod.default.fetch(new Request('https://x' + route, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, ctx);
  return { status: r.status, headers: r.headers, body: await r.json() };
};

// The card's chance, lifted from app.js: what the user saw.
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
function lift(name) {
  let at = app.indexOf(`function ${name}(`);
  const isConst = at < 0;
  if (isConst) at = app.indexOf(`const ${name} =`);
  if (at < 0) throw new Error(`app.js has no ${name}`);
  if (app.lastIndexOf('async ', at) === at - 6) at -= 6;
  let depth = 0, seen = false;
  for (let i = at; i < app.length; i++) {
    const c = app[i];
    if (c === '{' || c === '(' || c === '[') { depth++; seen = true; }
    else if (c === '}' || c === ')' || c === ']') depth--;
    if (seen && depth === 0) {
      if (!isConst && c === '}') return app.slice(at, i + 1);
      if (isConst && (app[i + 1] === ';' || app[i + 1] === '\n')) return app.slice(at, i + 2);
    }
  }
  throw new Error(`could not close ${name}`);
}
const card = new Function(lift('nbCdf') + '\n' + lift('socChanceAt') + '\nreturn { socChanceAt };')();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// ---- the card, logged -------------------------------------------------------------------
const board = await hit('/api/soccer-props');
const m1 = (board.matches || []).find((m) => m.id === 'NEXT1') || { rows: [] };
const row = (name, stat) => m1.rows.find((r) => r.player === name && r.stat === stat);
console.log(`-- NEXT1 ${m1.lineup}, ${m1.rows.length} rows --`);
const leno = row('Bernd Leno', 'saves'), lenoPass = row('Bernd Leno', 'passes');
const jim = m1.rows.find((r) => r.player === 'Raúl Jiménez');
const fouler = m1.rows.find((r) => r.stat === 'fouls' && r.team === 'FUL' && r.player !== 'Raúl Jiménez');
const tackler = m1.rows.find((r) => r.stat === 'tackles' && r.team === 'TOT');
ok(leno && lenoPass && jim && fouler && tackler, `the rows this test plays are on the card (${[leno, lenoPass, jim, fouler, tackler].map((r) => r && r.player + ' ' + r.stat).join(', ')})`);
const modelBefore = JSON.stringify(sq.prepare('SELECT * FROM socprops ORDER BY player_id, market').all());

// ---- private ----------------------------------------------------------------------------
console.log('\n-- private, like the entries log --');
const body = (r, line) => ({ gameId: 'NEXT1', playerId: r.id, stat: r.stat, line, proj: r.proj });
ok((await lines('POST', body(leno, 3), null)).status === 401, 'no key, no line saved');
const first = await lines('POST', body(leno, 3));
ok(first.status === 200 && first.body.ok, `the first key saves (and claims the log) (${first.status} ${JSON.stringify(first.body)})`);
ok((await lines('GET', null, OTHER)).status === 403 && (await lines('POST', body(leno, 4), OTHER)).status === 403,
  'a second key can neither read the lines nor save one');
ok((await lines('GET', null, KEY, '/api/entries')).status === 200 && (await lines('GET', null, OTHER, '/api/entries')).status === 403,
  'one owner: the key that saved the line opens the entries log, and the other key opens neither');
ok(first.headers.get('cache-control') === 'private, no-store' && !first.headers.get('access-control-allow-origin'),
  `never cached, never readable from another site (${first.headers.get('cache-control')})`);
await lines('GET');
ok(!cacheHits.some((u) => u.includes('/api/soc-lines')), `answered before the shared edge cache (${cacheHits.filter((u) => u.includes('soc-lines')).length} cache touches)`);

// ---- what a line can be -----------------------------------------------------------------
console.log('\n-- what a line can be --');
ok((await lines('POST', { ...body(leno, 3), stat: 'goals' })).status === 400, 'a stat the card does not price is refused');
ok((await lines('POST', body(leno, 2.3))).status === 400 && (await lines('POST', body(leno, -1))).status === 400,
  'a line is a whole or half number, not below 0');
ok((await lines('POST', { gameId: 'NEXT1', playerId: '999999', stat: 'shots', line: 1.5 })).status === 404
  && (await lines('POST', { gameId: 'NEXT1', playerId: leno.id, stat: 'shots', line: 0.5 })).status === 404,
  'only a row the model logged takes a line (a stranger, or shots for a goalkeeper, are refused)');

// ---- the chance the card showed ---------------------------------------------------------
console.log('\n-- saved at the card\'s chance --');
const saved = (r) => sq.prepare('SELECT * FROM soc_pp_lines WHERE game_id = ? AND player_id = ? AND market = ?').get('NEXT1', r.id, r.stat);
const s1 = saved(leno);
const at3 = card.socChanceAt(3, leno.proj, leno.phi);
const r1 = (x) => Math.round(x * 10) / 10;
ok(s1 && s1.line === 3 && Math.abs(s1.p_under - r1(at3.under)) < 0.051 && Math.abs(s1.p_over - r1(at3.over)) < 0.051,
  `Leno's saves at 3: the chance the card shows there (under ${s1 && s1.p_under} vs card ${r1(at3.under)}, over ${s1 && s1.p_over} vs ${r1(at3.over)})`);
ok(s1 && s1.side === (at3.under >= at3.over ? 'Under' : 'Over') && s1.p === (s1.side === 'Under' ? s1.p_under : s1.p_over),
  `the side is the one the card favours, its chance kept with it (${s1 && s1.side} ${s1 && s1.p})`);
ok(s1 && s1.default_line === leno.line && s1.commence === iso(KICK) && s1.player === 'Bernd Leno' && s1.edits === 1,
  `the default line, kickoff and player ride along from the model's row (default ${s1 && s1.default_line}, kickoff ${s1 && s1.commence})`);
// The box score below gives Leno floor(default) saves: under at the default
// line, a push at a whole-number PrizePicks line of the same number.
const A = Math.floor(leno.line);
NOW += 60e3;
await lines('POST', body(leno, A));
const s2 = saved(leno);
ok(s2.line === A && s2.edits === 2 && s2.first_at === s1.first_at && s2.entered_at > s1.entered_at,
  `a change replaces the line and keeps when it was first set (${s1.line} -> ${s2.line}, edits ${s2.edits})`);
const passLine = Math.floor(lenoPass.proj) + 2.5;
for (const [r, l] of [[lenoPass, passLine], [fouler, 0.5], [jim, Math.floor(jim.proj) + 0.5]]) await lines('POST', body(r, l));
ok(sq.prepare('SELECT COUNT(*) AS n FROM soc_pp_lines').get().n === 4, 'four lines saved, one row each');
// Every one at the card's side and chance -- two of them lean over (Leno's 2
// saves, a fouls line of 0.5), so a side that is always Under shows here.
const sides = [leno, lenoPass, fouler, jim].map((r) => {
  const s = saved(r), c = card.socChanceAt(s.line, r.proj, r.phi), side = c.under >= c.over ? 'Under' : 'Over';
  return { r, s, side, p: r1(side === 'Under' ? c.under : c.over) };
});
ok(sides.every((x) => x.s.side === x.side && Math.abs(x.s.p - x.p) < 0.051) && sides.some((x) => x.side === 'Over') && sides.some((x) => x.side === 'Under'),
  `each saved line keeps the side and chance the card drew (${sides.map((x) => `${x.r.stat} ${x.s.line} ${x.s.side} ${x.s.p}`).join(', ')})`);
ok(JSON.stringify(sq.prepare('SELECT * FROM socprops ORDER BY player_id, market').all()) === modelBefore,
  'the model\'s own rows are untouched by a saved line');

// ---- the card saving --------------------------------------------------------------------
console.log('\n-- the card saving it --');
const ENTRY_KEY_STORE = (app.match(/const ENTRY_KEY_STORE = '([^']+)'/) || [])[1];
const store = new Map();
const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
const sent = [], toasts = [], timers = new Map();
let tid = 0;
const setTimeout = (fn) => { const id = ++tid; timers.set(id, fn); return id; };
const clearTimeout = (id) => timers.delete(id);
const flush = async () => { const fns = [...timers.values()]; timers.clear(); for (const fn of fns) await fn(); };
const pageFetch = async (u, o) => { sent.push({ url: u, method: o.method, key: o.headers['x-entry-key'], body: o.body ? JSON.parse(o.body) : null });
  return mod.default.fetch(new Request('https://x' + u, o), env, ctx); };
const nodes = new Map();
const el = { soccerGrid: { querySelector: (sel) => nodes.get(sel) || null } };
const CSS = { escape: (s) => s };
const state = { socProps: board, socLines: {}, socSaved: {}, socSaving: {}, slip: {} };
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
let renders = 0;
const P = new Function('state', 'esc', 'el', 'CSS', 'localStorage', 'fetch', 'setTimeout', 'clearTimeout', 'toast', 'renderSoccer', 'ENTRY_KEY_STORE',
  ['entryKey', 'entriesFetch', 'socSaveTimers', 'socLineSave', 'socLineSend', 'socSaveHtml', 'socSaveMark', 'socSavedLoad'].map(lift).join('\n')
  + '\nreturn { socLineSave, socSaveHtml, socSavedLoad };')(state, esc, el, CSS, localStorage, pageFetch, setTimeout, clearTimeout,
  (t) => toasts.push(t), () => { renders++; }, ENTRY_KEY_STORE);
const tk = `NEXT1:${tackler.id}:tackles`;
// A device with no key yet: a reload asks for nothing, and makes no key.
await P.socSavedLoad();
ok(!sent.length && !store.size, 'a device without a key does not ask for saved lines, and is not given a key by looking');
// Three taps on the stepper.
store.set(ENTRY_KEY_STORE, KEY);
nodes.set(`input[data-socp="${tk}"]`, { value: '2.5' });   // what the redrawn input shows after the taps
nodes.set(`[data-socs="${tk}"]`, { outerHTML: '' });
for (const l of [1.5, 2, 2.5]) P.socLineSave(tk, l);
ok(/Saving/.test(P.socSaveHtml(tk, 2.5)), 'a set line reads "Saving…" while it is on its way');
await flush();
const posts = sent.filter((x) => x.method === 'POST');
ok(posts.length === 1 && posts[0].url === '/api/soc-lines' && posts[0].key === KEY && posts[0].body.line === 2.5
  && posts[0].body.gameId === 'NEXT1' && posts[0].body.playerId === tackler.id && posts[0].body.stat === 'tackles' && posts[0].body.proj === tackler.proj,
  `a run of three taps is one save, at the last line, under the entries key (${posts.length} POST, ${JSON.stringify(posts[0] && posts[0].body)})`);
ok(saved(tackler) && saved(tackler).line === 2.5 && state.socSaved[tk] === 2.5, 'the worker holds it and the card knows');
ok(/PP line/.test(nodes.get(`[data-socs="${tk}"]`).outerHTML) && /✓/.test(P.socSaveHtml(tk, 2.5)) && !/<button/.test(P.socSaveHtml(tk, 2.5)),
  'marked saved in place once it lands');
ok(/<button[^>]*data-action="socp-save"[^>]*data-line="3"/.test(P.socSaveHtml(tk, 3)), 'a line the worker does not hold offers a Save tap instead');
// A save the worker refuses says so, and is not marked.
store.set(ENTRY_KEY_STORE, OTHER);
P.socLineSave(tk, 3);
await flush();
ok(toasts.length === 1 && /not saved/i.test(toasts[0]) && state.socSaved[tk] === 2.5 && saved(tackler).line === 2.5,
  `a refused save is said, and nothing is marked (${toasts[0]})`);
store.set(ENTRY_KEY_STORE, KEY);
// A reload: the lines come back, and one set on the page since keeps its number.
state.socLines = { [`NEXT1:${leno.id}:saves`]: 9 }; state.socSaved = {};
await P.socSavedLoad();
ok(state.socLines[`NEXT1:${lenoPass.id}:passes`] === passLine && state.socLines[tk] === 2.5 && state.socLines[`NEXT1:${leno.id}:saves`] === 9
  && state.socSaved[`NEXT1:${leno.id}:saves`] === A && renders > 0,
  'after a reload the saved lines show again; a line set since on this page keeps its own number');

// ---- kickoff locks it -------------------------------------------------------------------
console.log('\n-- kickoff --');
const listed = (await lines('GET')).body.lines || [];
ok(listed.length === 5 && listed.some((x) => x.player_id === leno.id && x.market === 'saves' && x.line === A),
  `the open lines are listed for the card (${listed.length})`);
NOW = KICK + 60e3;
const late = await lines('POST', body(leno, A + 3));
ok(late.status === 409 && saved(leno).line === A, `after kickoff a line is locked (${late.status}: ${late.body.error})`);

// ---- graded -----------------------------------------------------------------------------
console.log('\n-- graded at the PrizePicks number --');
NOW += 3 * 3600e3;
const date = sq.prepare("SELECT date FROM socprops WHERE game_id = 'NEXT1' LIMIT 1").get().date;
sq.prepare("INSERT INTO soc_box_games (game_id, league, date, home, away, home_cid, away_cid, done, tries) VALUES ('NEXT1','epl',?, 'FUL','TOT','370','367',1,1)").run(date);
const boxRow = (r, vals) => sq.prepare(`INSERT INTO soc_box (game_id, league, date, player_id, player, team, opp, starter, min, sub_off, gk, shots, sot, passes, tackles, clear, fouls, saves)
  VALUES ('NEXT1','epl',?,?,?,?,?,1,90,0,?,?,?,?,?,?,?,?)`).run(date, r.id, r.player, r.team, r.opp, r.stat === 'saves' ? 1 : 0,
  ...['shots', 'sot', 'passes', 'tackles', 'clear', 'fouls', 'saves'].map((s) => vals[s] || 0));
boxRow(leno, { passes: Math.ceil(passLine) + 4, saves: A });
boxRow(fouler, { fouls: 0 });
boxRow(tackler, { tackles: 1 });
const held = [];
await mod.default.scheduled({ cron: '2-59/5 * * * *' }, env, { waitUntil: (p) => held.push(p) });
await Promise.allSettled(held);
const g = (r) => saved(r) || {};
console.log('  ' + [leno, lenoPass, fouler, jim, tackler].map((r) => `${r.player} ${r.stat} ${g(r).side} ${g(r).line} -> ${g(r).result} (${g(r).actual})`).join(' | '));
ok(g(leno).result === 'push' && g(leno).actual === A, `Leno's ${A} saves at a line of ${A}: a push`);
const model = sq.prepare("SELECT line, result FROM socprops WHERE game_id = 'NEXT1' AND player_id = ? AND market = 'saves'").get(leno.id);
ok(model.line === leno.line && model.result === 'under', `while the model's own row grades at its default line ${model.line}: ${model.result}, never relabelled`);
ok(g(lenoPass).result === 'over' && g(fouler).result === 'under' && g(tackler).result === 'under', 'above the line an over, below it an under');
ok(g(jim).result === 'void' && g(jim).actual == null, 'a starter missing from the box score is void, never a free under');

// ---- the record -------------------------------------------------------------------------
console.log('\n-- the record, in the summary --');
const sm = await hit('/api/soccer-props?summary=1');
const pr = sm.ppRecord || {};
console.log('  ' + JSON.stringify({ saved: pr.saved, graded: pr.graded, hit: pr.hit, void: pr.void, byMarket: pr.byMarket && { passes: pr.byMarket.passes, fouls: pr.byMarket.fouls, tackles: pr.byMarket.tackles }, exFouls: pr.exFouls }));
const won = (r) => (g(r).result === (g(r).side === 'Under' ? 'under' : 'over') ? 1 : 0);
const decided = [lenoPass, fouler, tackler];
ok(pr.saved === 5 && pr.void === 1 && pr.open === 0 && pr.graded === 3 && pr.hit === decided.reduce((a, r) => a + won(r), 0),
  `the side shown at each saved line, graded: ${pr.hit} of ${pr.graded} (a push and a void do not count)`);
ok(pr.byMarket && pr.byMarket.passes.n === 1 && pr.byMarket.passes.hit === won(lenoPass) && pr.byMarket.saves.n === 0 && pr.byMarket.tackles.n === 1,
  'by stat');
const bandOf = (p) => (p < 55 ? '<55' : p < 60 ? '55-60' : p < 65 ? '60-65' : p < 70 ? '65-70' : '70+');
const bands = {};
for (const r of decided) bands[bandOf(g(r).p)] = (bands[bandOf(g(r).p)] || 0) + 1;
ok(pr.byBand && Object.entries(bands).every(([k, n]) => pr.byBand[k].n === n) && Object.values(pr.byBand).reduce((a, c) => a + c.n, 0) === 3,
  `by band of the chance shown (${JSON.stringify(bands)})`);
ok(pr.fouls && pr.fouls.atPP.n === 1 && pr.fouls.atPP.hit === won(fouler) && JSON.stringify(pr.fouls.atDefault) === JSON.stringify(sm.record.byMarket.fouls)
  && /fouls/i.test(pr.fouls.note) && pr.exFouls.n === 2 && pr.exFouls.hit === won(lenoPass) + won(tackler),
  `fouls called out on their own, at both lines, and the record without them (${pr.exFouls && pr.exFouls.hit} of ${pr.exFouls && pr.exFouls.n})`);
ok(pr.picksGate && pr.picksGate.have === pr.graded && pr.picksGate.need >= 100, `how far from the Picks of the day decision (${pr.picksGate && pr.picksGate.have} of ${pr.picksGate && pr.picksGate.need})`);
ok(sm.record && sm.record.graded > 0 && JSON.stringify(sm).length < 6000, `beside the default line's record (${sm.record && sm.record.hit} of ${sm.record && sm.record.graded}), in a compact body`);
ok(!((await lines('GET')).body.lines || []).length, 'graded lines leave the open list');
// On the card, a record is green only once it clears PrizePicks' 2-pick
// break-even (57.7%) over five or more -- a first "1 of 3" is not a result.
const { socRecB } = new Function(lift('socRecB') + '\nreturn { socRecB };')();
const css = fs.readFileSync(BOARD + '/style.css', 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
const flatRule = (css.match(/\.tc-rec b\.sp-rec-flat\s*\{([^}]*)\}/) || [])[1] || '';
ok(/sp-rec-flat/.test(socRecB(3, 4)) && /sp-rec-flat/.test(socRecB(4, 8)) && !/sp-rec-flat/.test(socRecB(5, 8)) && !/sp-rec-flat/.test(socRecB(62, 88))
  && /color:\s*var\(--text\)/.test(flatRule),
  `the card's record is green only past break-even over five or more (3 of 4 and 4 of 8 neutral; 5 of 8 and 62 of 88 green)`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
