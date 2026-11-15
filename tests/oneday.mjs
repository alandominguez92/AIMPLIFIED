// Each entry is one day's games (2026-11-14, the owner's "do all three").
//
// Saturday Nov 14: the PrizePicks entry was the best legs starting in the next 24 hours, so from
// 10 AM Sunday's NFL legs (the Jaguars at 83%, three passing-TD Unders at 65-68%) took four of its
// six places, and Saturday's later legs (Pastrnak, Collins, Hughes, Karlsson, 55-58%) left it
// before their games. The day logged two legs, and no 6-Flex, the entry the owner plays most; the
// moneyline entry logged four. What has to hold:
//   - each entry is the first day's (Pacific) legs with any still to start: today's until the
//     last of them starts, then tomorrow's; the list ("Most likely to land") keeps its 24 hours
//   - the route says when the next day's takes over, and a short entry says so on the page
//   - the log keeps a full day: Saturday's six, none of Sunday's
//   - the "Last night" box shows the 6-Flex beside the Top 2 Power and Top 3 Flex, and says when
//     a day logged short of six legs; the day cards name it too
//
// Real data: Saturday's NHL legs as logged at 12:30 AM (tests/fixtures/nhl-pp-20261114.json), the
// game lines of Nov 14 and 15 as production had them at 10 PM Saturday (tests/fixtures/
// gm-20261114-15.json), and production's /api/picks at 10 PM Saturday (tests/fixtures/
// picks-20261114-2200.json) for the box. Real SQLite, the real worker, app.js's own functions.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const fx = (f) => JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', f), 'utf8'));
const N = fx('nhl-pp-20261114.json'), G = fx('gm-20261114-15.json'), P = fx('picks-20261114-2200.json');
const RealDate = Date;
let NOW = RealDate.parse('2026-11-14T19:00:00Z');        // 11 AM Pacific, Saturday
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
globalThis.fetch = async () => new Response('{}', { status: 404 });
const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const exec = (sql, args, mode) => { const st = sq.prepare(sql); const a = args.map(norm);
  if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
  return { success: true, meta: { changes: Number(st.run(...a).changes) } }; };
const DB = { prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
  all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
  run: async () => exec(s.sql, s.args, 'run') }; return s; }, batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')) };
const env = { DB };
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const get = async (u) => (await mod.default.fetch(new Request('https://x' + u), env, { waitUntil: () => {} })).json();
let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };
const pt = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new RealDate(iso));
const titles = (l) => (l || []).map((x) => `${x.title} ${x.p}`);

await get('/api/picks'); await get('/api/nhl-pp'); await get('/api/gmpicks-export');   // the tables
const lins = sq.prepare(`INSERT INTO nhlpp (date, game_id, player, market, commence, home, away, team, player_id, point, model_under, proj, toi_proj, captured_at)
  VALUES ('2026-11-14', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
for (const l of N.legs) { const [away, home] = l.game.split(' @ '); lins.run(l.game_id, l.player, l.market, l.commence, home, away, l.team, l.player_id, l.point, l.model_under, l.proj, l.toi_proj, l.first_at); }
// The game lines as they stood: no score yet for a game still to start.
const cols = Object.keys(G.rows[0]);
const gins = sq.prepare(`INSERT INTO gmpicks (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
for (const r of G.rows) {
  const ahead = RealDate.parse(r.commence) > NOW;
  gins.run(...cols.map((k) => (ahead && (k === 'result' || k === 'away_score' || k === 'home_score') ? null : r[k])));
}

console.log('-- Saturday, 11 AM --');
let p = await get('/api/picks');
console.log('  list:      ' + titles(p.legs).join(' | '));
console.log('  entry:     ' + titles(p.ppPool).join(' | '));
console.log('  moneyline: ' + titles(p.mlPool).join(' | '));
ok(p.legs.some((x) => pt(x.commence) === '2026-11-15') && p.legs.some((x) => x.title === 'Jaguars ML'), "the list keeps its 24 hours: Sunday's Jaguars on it");
ok(p.ppPool.length === 6 && p.ppPool.every((x) => pt(x.commence) === '2026-11-14'), "the PrizePicks entry: six legs, all Saturday's");
ok(!p.ppPool.some((x) => /^nfl_/.test(x.kind)) && ['Matthew Tkachuk Over 0.5 AST', 'Jackson LaCombe Over 0.5 AST', 'David Pastrnak Over 0.5 AST', 'Jack Hughes Over 0.5 AST', 'Erik Karlsson Over 0.5 AST'].every((t) => p.ppPool.some((x) => x.title === t)),
  "Pastrnak, Hughes and Karlsson keep their places; no Sunday NFL leg in Saturday's entry");
ok(p.mlPool.length >= 2 && p.mlPool.every((x) => pt(x.commence) === '2026-11-14') && !p.mlPool.some((x) => ['Jaguars ML', 'Rams ML', 'Bills ML', 'France ML'].includes(x.title)),
  "the moneyline entry: Saturday's too, not Sunday's Jaguars, Rams, Bills or France");
const satLast = (kinds) => new RealDate(Math.max(...p.legs.concat(p.ppPool, p.mlPool).filter((x) => kinds(x) && pt(x.commence) === '2026-11-14').map((x) => RealDate.parse(x.commence)))).toISOString();
const lastNhl = new RealDate(Math.max(...N.legs.filter((l) => 100 - l.model_under >= 55).map((l) => RealDate.parse(l.commence)))).toISOString();
console.log(`  next at: ${p.ppNextAt} (entry), ${p.mlNextAt} (moneyline)`);
ok(p.ppNextAt === lastNhl, `the route says when Sunday's entry takes over: the last start of Saturday's legs, ${p.ppNextAt}`);
ok(typeof p.mlNextAt === 'string' && pt(p.mlNextAt) === '2026-11-14' && p.mlNextAt >= satLast((x) => /_ml$|soccer_fav/.test(x.kind)), "and the moneyline entry's, its own last Saturday start");
const pooled = sq.prepare("SELECT date, label FROM daypicks WHERE in_pool = 1 ORDER BY date, pool_rank").all();
ok(pooled.length === 6 && pooled.every((r) => r.date === '2026-11-14'), `the log: six of Saturday's in the entry, none of Sunday's (${pooled.length})`);

// Through the afternoon: each start freezes its leg, and nothing of Sunday's takes a place.
for (const at of ['2026-11-14T23:30:00Z', '2026-11-15T00:30:00Z', '2026-11-15T02:00:00Z']) { NOW = RealDate.parse(at); await get('/api/picks'); }
console.log('\n-- after the last of Saturday\'s starts --');
NOW = RealDate.parse(p.ppNextAt) + 60e3;
p = await get('/api/picks');
console.log('  entry:     ' + titles(p.ppPool).join(' | '));
ok(p.ppPool.length >= 2 && p.ppPool.every((x) => pt(x.commence) === '2026-11-15') && p.ppPool.some((x) => x.title === 'Jaguars ML'), "now Sunday's: the Jaguars and the passing-TD Unders");
ok(p.ppNextAt == null, 'nothing later waiting: no next time');
const sat = sq.prepare("SELECT label FROM daypicks WHERE date = '2026-11-14' AND in_pool = 1").all();
console.log('  Saturday logged: ' + sat.map((r) => r.label).join(' | '));
ok(sat.length >= 6, `Saturday's entry logged whole, every leg kept at its start (${sat.length})`);

// ---- the page --------------------------------------------------------------------------------
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
function lift(name) {
  let at = app.search(new RegExp(`\\n  (async )?function ${name}\\(`));
  if (at >= 0) { at++; let d = 0; for (let i = app.indexOf(') {', at) + 2; i < app.length; i++) { if (app[i] === '{') d++; else if (app[i] === '}' && --d === 0) return app.slice(at, i + 1); } }
  throw new Error(`app.js has no ${name}`);
}
const constLine = (name) => { const m = app.match(new RegExp(`\\n  (const ${name} = [^]*?;)\\n`)); if (!m) throw new Error(`app.js has no ${name}`); return m[1]; };
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const text = (x) => x.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const store = {};
const penv = {
  esc, Date: globalThis.Date,
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
  AM: (n) => (n == null ? '—' : (n > 0 ? '+' + n : String(n))), bkLabel: (k) => ({ draftkings: 'DK', fanduel: 'FD' }[k] || String(k).toUpperCase()),
  ptDayOf: (ms) => (ms ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new RealDate(ms)) : null),
  shortDay: (ymd) => new RealDate(ymd + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
};
const C = new Function(...Object.keys(penv), `let recapSeenAtLoad = null;\n${constLine('RECAP_ENTRY_MAX')}\n${constLine('propDayName')}\n${constLine('propDayTitle')}\n`
  + `${['shortLeg', 'recapDay', 'entryNextHtml'].map(lift).join('\n')}\nreturn { recapDay, entryNextHtml };`)(...Object.values(penv));

console.log('\n-- the "Last night" box, Saturday 10 PM --');
NOW = RealDate.parse('2026-11-15T06:00:00Z');
const box = C.recapDay(P.record.history, P.edgeRecord, '2026-11-13', false);
const blocks = box.split('<div class="rc-ent">').slice(1).map(text);
blocks.forEach((b) => console.log('  ' + b.slice(0, 200)));
const ml = blocks.find((b) => /^Moneyline entry/.test(b)) || '', pp = blocks.find((b) => /^PrizePicks entry/.test(b)) || '';
ok(/Top 2 Power \+2\.00u Top 3 Flex \+1\.25u Top 6 Flex \+24\.00u/.test(ml), "Friday's moneyline entry: 6 of 6, Top 6 Flex +24.00u beside the Top 2 and Top 3");
ok(/Top 3 Flex \+1\.25u Top 6 Flex 5 legs logged/.test(pp), 'the PrizePicks entry logged five legs: "Top 6 Flex 5 legs logged"');
const todayBlocks = C.recapDay(P.record.history, P.edgeRecord, '2026-11-14', true).split('<div class="rc-ent">').slice(1).map(text);
console.log('  today: ' + todayBlocks.map((b) => b.slice(0, 120)).join(' || '));
ok(!/Top \d/.test(todayBlocks.find((b) => /^PrizePicks/.test(b)) || 'x Top 2') && /Top 3 Flex \+1\.25u Top 6 Flex 4 legs logged/.test(todayBlocks.find((b) => /^Moneyline/.test(b)) || ''),
  "today: the PrizePicks entry waits for LaCombe, no lines; the moneyline entry's four have all graded, \"Top 6 Flex 4 legs logged\"");
ok(/\['f6', 'Top 6 Flex'\]\]/.test(constLine('HIST_DAY_KEYS')), 'the day cards name the 6-Flex too');

console.log('\n-- a short entry says when the next day\'s takes over --');
NOW = RealDate.parse('2026-11-15T02:00:00Z');             // 6 PM Saturday
const two = [{ commence: '2026-11-15T02:10:00Z' }, { commence: '2026-11-15T03:10:00Z' }];
const note = text(C.entryNextHtml('2026-11-15T03:10:00.000Z', two));
console.log('  ' + note);
ok(note === 'Today’s games only. Tomorrow’s entry shows here once today’s last leg starts, at 7:10 PM.', 'two legs left: "Tomorrow’s entry shows here once today’s last leg starts, at 7:10 PM."');
ok(C.entryNextHtml(null, two) === '' && C.entryNextHtml('2026-11-15T03:10:00.000Z', Array(6).fill(two[0])) === '', 'nothing waiting, or six legs: no note');
ok(/entryNextHtml\(d\.ppNextAt, ppLegs\)/.test(app) && /entryNextHtml\(d\.mlNextAt, mlLegs\)/.test(app), 'under both entries');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
