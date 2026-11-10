// Each player's place on his team in the NBA injury notes (2026-11-10, the owner's yes, after an
// example built on Nov 9's real notes). What has to hold:
//   - from our own box scores: per game, among the team's regulars (3+ games for it), the stat or
//     two where he is 1st, else 2nd, on his team; a starter who leads nothing says his minutes;
//     one who has played under half his team's games says so, since that absence is old news
//   - the places agree with ESPN's own season averages for the same team the same night
//   - a moneyline's notes carry them, the players who matter most listed first
//   - the page shows "Schroder (1st in assists)" in the tag, and the injury beside it in the title
//   - built on the cron every six hours into one row; Picks reads that row only when it has an NBA
//     moneyline; nothing touches a chance or an order of legs
//
// Real data (tests/fixtures/nba-roles-mia-uta-20261110.json): every 2026-27 regular-season game of
// the Jazz and the Heat to Nov 9, read from ESPN's cdn game feed through the worker's own
// nbaBoxRows; ESPN's per-player season averages for the Jazz the same night; and tonight's (Nov 10)
// Heat @ Jazz game feed, its injury report as ESPN had it at 12:40 AM Pacific.
// Real SQLite and the real worker.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const FX = JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', 'nba-roles-mia-uta-20261110.json'), 'utf8'));
const RealDate = Date;
const NOW = RealDate.parse('2026-11-10T08:40:00Z');
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };

const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const exec = (sql, args, mode) => { const st = sq.prepare(sql); const a = args.map(norm);
  if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
  if (/^\s*(SELECT|WITH)/i.test(sql)) return { results: st.all(...a), meta: {} };
  return { success: true, meta: { changes: Number(st.run(...a).changes) } }; };
const DB = { prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
  all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
  run: async () => exec(s.sql, s.args, 'run') }; return s; }, batch: async (sts) => sts.map((x) => exec(x.sql, x.args, 'run')) };
const env = { DB };
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
let mod;
try {
  mod = await import('data:text/javascript;base64,' + Buffer.from(src + '\nexport { nbaTeamRoles, nbaRolesTick, nbaRolesLoad, nbaLegInjury, nbaInjuriesOf, ensureNbaSchema };').toString('base64'));
} catch (e) { console.log(`  FAIL  the worker has the roles (${e.message})`); console.log('\n1 FAILED'); process.exit(1); }

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

// ---- the box scores, into nba_box as the ingest writes them -------------------------------------
await mod.ensureNbaSchema(DB);
const NAME = new Map(FX.players);
for (const [gi, pi, team, min, pts, reb, ast, threes, blk, stl, starter, dnp] of FX.rows) {
  const [gid, date] = FX.games[gi], [pid] = FX.players[pi];
  sq.prepare('INSERT INTO nba_box (game_id, date, season_type, player_id, player, team, min, pts, reb, ast, threes, blk, stl, starter, dnp) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(gid, date, 2, pid, NAME.get(pid), team, min, pts, reb, ast, threes, blk, stl, starter, dnp);
}

console.log('-- the cron builds one row of roles, and leaves it six hours --');
let reads = 0;
const counted = { prepare: (sql) => { if (/FROM nba_box/.test(sql)) reads++; return DB.prepare(sql); }, batch: DB.batch };
ok(await mod.nbaRolesTick({ DB: counted }, NOW) === true && reads === 1, 'the first tick reads the box scores once and saves');
ok(await mod.nbaRolesTick({ DB: counted }, NOW + 5 * 3600e3) === null && reads === 1, 'five hours on: the saved row stands, no read');
ok(await mod.nbaRolesTick({ DB: counted }, NOW + 6.5 * 3600e3) === true && reads === 2, 'past six hours: built again');
const roles = await mod.nbaRolesLoad(DB);
ok(Object.keys(roles).length > 10, `saved and read back (${Object.keys(roles).length} players with a role)`);

console.log('\n-- against ESPN\'s own averages for the Jazz --');
// The same rule worked from ESPN's numbers: per game, regulars (3+ games), 1st else 2nd, the floors.
const ST = ['pts', 'reb', 'ast', 'threes', 'blk', 'stl'], FLOOR = { threes: 1, blk: 0.5, stl: 0.5 };
const E = FX.espnUta, teamGp = Math.max(...E.map((p) => p.gp)), regs = E.filter((p) => p.gp >= 3);
const expectOf = (p) => {
  if (p.gp < teamGp / 2) return { gp: p.gp, of: teamGp };
  const places = ST.map((st) => { const v = p[st]; if (!(v > 0) || v < (FLOOR[st] || 0)) return null;
    return [st, 1 + regs.filter((o) => o.id !== p.id && o[st] > v).length]; }).filter((x) => x && x[1] <= 2);
  const best = places.length ? Math.min(...places.map((x) => x[1])) : null;
  if (best) return { r: best, st: places.filter((x) => x[1] === best).map((x) => x[0]).slice(0, 2) };
  return p.gs >= p.gp / 2 ? { min: Math.round(p.min) } : null;
};
let agree = 0, of = 0;
const differ = [];
for (const p of E) {
  if (!p.gp) continue;
  of++;
  const want = JSON.stringify(expectOf(p) || null), got = JSON.stringify(roles[p.id] || null);
  if (want === got) agree++; else differ.push(`${p.name} ours ${got} ESPN's ${want}`);
}
ok(agree === of, `every Jazz player's place matches what ESPN's averages give (${agree} of ${of})${differ.length ? ': ' + differ.join('; ') : ''}`);

console.log('\n-- tonight\'s report: Heat @ Jazz --');
const inj = mod.nbaInjuriesOf(FX.feed);
const byDay = new Map([['2026-11-10', [{ id: '401909963', home: 'Utah Jazz', away: 'Miami Heat', homeAb: 'UTAH', awayAb: 'MIA', at: NOW - 600e3, inj }]]]);
const leg = { spec: { sport: 'nba', market: 'ml', side: 'away', date: '2026-11-10' }, teams: { home: 'Utah Jazz', away: 'Miami Heat' } };
const got = mod.nbaLegInjury(leg, byDay, roles);
const show = (t) => `${t.team} out: ${t.out.map((p) => `${p.n}${p.role ? JSON.stringify(p.role) : ''}`).join(', ')} | GTD: ${t.gtd.map((p) => `${p.n}${p.role ? JSON.stringify(p.role) : ''}`).join(', ')}`;
console.log('        ' + got.teams.map(show).join('\n        '));
const idOf = (ln) => Object.entries(inj).find(([, i]) => i.ln === ln)[0];
const roleOf = (ln) => roles[idOf(ln)] || null;
ok(got.teams[0].team === 'Heat' && got.teams[1].team === 'Jazz', 'the picked side (the Heat) first, as before');
const heatGtd = got.teams[0].gtd.find((p) => p.n === 'Antetokounmpo');
ok(heatGtd && JSON.stringify(heatGtd.role || null) === JSON.stringify(roleOf('Antetokounmpo')) && heatGtd.what === inj[idOf('Antetokounmpo')].what,
  `Antetokounmpo (GTD) carries his place on the Heat beside his injury (${JSON.stringify(heatGtd && heatGtd.role)})`);
const jazz = got.teams[1];
ok(jazz.out.length === 3 && jazz.gtd.length === 1 && jazz.gtd[0].n === 'Markkanen', 'the Jazz: three out, Markkanen day-to-day');
for (const p of [...jazz.out, ...jazz.gtd]) ok(JSON.stringify(p.role || null) === JSON.stringify(roleOf(p.n)), `${p.n}: ${JSON.stringify(p.role || null)}, his own`);
const rank = (r) => (!r ? 3 : r.r === 1 ? 0 : r.r === 2 ? 1 : r.min ? 2 : r.gp != null ? 4 : 3);
ok(jazz.out.every((p, i, a) => i === 0 || rank(a[i - 1].role) <= rank(p.role)), `the outs in order of who matters most: ${jazz.out.map((p) => p.n).join(', ')}`);
const plain = mod.nbaLegInjury(leg, byDay);
ok(plain.teams.every((t) => [...t.out, ...t.gtd].every((p) => !('role' in p))), 'with no roles row yet: the notes as they were, no role on anyone');

console.log('\n-- the page --');
const app = fs.readFileSync(BOARD + '/app.js', 'utf8').replace(/\r\n/g, '\n');
let IT = null;
try {
  const from = app.indexOf('  const INJ_ROLE_WORD =');
  if (from < 0) throw new Error('app.js has no INJ_ROLE_WORD');
  IT = new Function('Date', app.slice(from, app.indexOf('\n  }\n', app.indexOf('  function injuryTag(')) + 4) + '\nreturn { injuryTag, injRoleText };')(globalThis.Date);
} catch (e) { ok(false, `the page's role text lifts out of app.js (${e.message})`); }
if (IT) {
  ok(IT.injRoleText({ r: 1, st: ['ast'] }) === '1st in assists' && IT.injRoleText({ r: 2, st: ['reb', 'blk'] }) === '2nd in rebounds and blocks'
    && IT.injRoleText({ min: 29 }) === 'starter, 29 min' && IT.injRoleText({ gp: 2, of: 8 }) === 'played 2 of 8' && IT.injRoleText(null) === '',
  'the words: "1st in assists", "2nd in rebounds and blocks", "starter, 29 min", "played 2 of 8"');
  const tag = IT.injuryTag({ sport: 'nba', inj: { ...got, at: new RealDate(NOW - 600e3).toISOString() } });
  console.log(`        tag: ${tag.text}\n        title: ${tag.title}`);
  const words = (ln) => IT.injRoleText(roleOf(ln));
  const jz = jazz.out.slice(0, 3).map((p) => (words(p.n) ? `${p.n} (${words(p.n)})` : p.n)).join(', ');
  ok(tag.parts.includes(`Jazz out: ${jz}`), `the Jazz's tag names each with his place: "Jazz out: ${jz}"`);
  ok(tag.parts.includes(`Heat GTD: Antetokounmpo${words('Antetokounmpo') ? ` (${words('Antetokounmpo')})` : ''}`), 'the Heat\'s too');
  const ant = inj[idOf('Antetokounmpo')];
  ok(tag.title.includes(`Antetokounmpo (${[ant.what, words('Antetokounmpo')].filter(Boolean).join('; ')})`), 'the title gives the injury and the place together');
  const old = IT.injuryTag({ sport: 'nba', inj: { ...plain, at: new RealDate(NOW - 600e3).toISOString() } });
  ok(old.parts.includes(`Jazz out: ${plain.teams[1].out.slice(0, 3).map((p) => p.n).join(', ')}`), 'no roles: the tag as it was');
}

console.log('\n-- wired in --');
ok(/ctx\.waitUntil\(nbaRolesTick\(d1Env\(env, 'nbaRolesTick'\)\)/.test(src), 'the cron runs nbaRolesTick, metered under its own name');
ok(/const roles = legs\.some\(\(l\) => l\.spec && l\.spec\.sport === 'nba' && l\.spec\.market === 'ml'\) \? await nbaRolesLoad\(db\)/.test(src)
  && /nbaLegInjury\(l, injDays, roles\)/.test(src), 'Picks reads the roles row only when it has an NBA moneyline, and hands it to the notes');
const pc = src.slice(src.indexOf('async function picksCandidates('), src.indexOf('\n}\n', src.indexOf('async function picksCandidates(')));
ok(!/role/.test(pc.replace(/const roles = [^\n]+\n/, '').replace(/nbaLegInjury\(l, injDays, roles\)/, '')), 'nothing else in Picks reads a role: no chance, no order');

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
