// League of Legends props (2026-11-28, the owner's OK of the recommended build, the rest of step
// one): each LCK, LPL, LEC and LCS player's kills, assists and deaths over the maps PrizePicks counts
// (maps 1-2 of a best-of-three, 1-3 of a best-of-five), against a stand-in line at his own 50/50
// point, with the Nov 27 replay's side. What has to hold:
//   - logged until the start for every best-of-three and best-of-five with a chance: each team's
//     five from its last map this season, those with ten maps or more; each stat's line is his own
//     50/50 point over the maps counted, from his last 20 maps (checked here by counting every way
//     those maps can fall; where two lines sit exactly as near, either)
//   - the side: Under on a big underdog's players (under 35% to win the series), Over on a big
//     favourite's (65%+), deaths the other way round, both teams eight maps in; none in the LPL;
//     no lines at all on a single map
//   - graded once the series is over and its counted maps are in: the sum over them; a player who
//     missed one of them is void; maps still not in two weeks on, void
//   - PrizePicks' line typed with the entries key (/api/lol-lines) until the start, graded at that
//     number, and never on the public board
//   - the board: each match's players by team and role with their three lines; the record
//
// Real data: the 2026 maps before Aug 6 (lol-games-2026.json) with each player's last 20 of them
// (lol-players-2026.json, from Leaguepedia's scoreboards read Nov 27; a player's season count here
// is those 20 plus what the reads add, which is all the ten-map rule and the line look at), and
// Leaguepedia's answers to the Worker's own queries at Aug 8 12:00, Aug 9 08:00 and Aug 9 10:00 UTC
// (lol-cargo-202608.json). Stand-ins, said where they are: August's schedule is all best-of-three,
// so a best-of-one and a best-of-five are two real series copied with the format changed; and the
// rate limit's answer, which holds the reads off for the two-week void.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const BOARD = path.join(import.meta.dirname, '..');
const FIX = (f) => JSON.parse(fs.readFileSync(path.join(BOARD, 'tests', 'fixtures', f), 'utf8'));
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
const RealDate = Date;
let NOW = RealDate.parse('2026-08-08T12:00:00Z');
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

const GAMES = FIX('lol-games-2026.json').games, PLAYERS = FIX('lol-players-2026.json').players, READS = FIX('lol-cargo-202608.json').reads;
const asked = [], unknown = [];
let refuse = false;
globalThis.fetch = async (u) => {
  const url = String(u);
  if (!url.startsWith('https://lol.fandom.com/')) return new Response('{}', { status: 404 });
  asked.push(url);
  if (refuse) return new Response(JSON.stringify({ error: { code: 'ratelimited', info: "You've exceeded your rate limit. Please wait some time and try again." } }), { status: 200 });
  const hit = READS.find((r) => r.url === url);
  if (!hit) { unknown.push(url); return new Response('{}', { status: 404 }); }
  return new Response(hit.body, { status: hit.status, headers: { 'content-type': 'application/json' } });
};
const sq = new DatabaseSync(':memory:');
const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
// D1 refuses a statement with more than 100 bound values.
let binds = 0;
const exec = (sql, args, mode) => { if (args.length > 100) throw new Error('D1: too many SQL variables (' + args.length + ')'); binds = Math.max(binds, args.length);
  const st = sq.prepare(sql); const a = args.map(norm);
  if (mode === 'all') return { results: st.all(...a), meta: {} }; if (mode === 'first') return st.get(...a) || null;
  return { success: true, meta: { changes: Number(st.run(...a).changes) } }; };
const DB = { prepare: (sql) => { const s = { sql, args: [], bind: (...x) => { s.args = x; return s; },
  all: async () => exec(s.sql, s.args, 'all'), first: async (c) => { const r = exec(s.sql, s.args, 'first'); return c && r ? r[c] : r; },
  run: async () => exec(s.sql, s.args, 'run') }; return s; },
  batch: async (sts) => sts.map((x) => exec(x.sql, x.args, /^\s*SELECT/i.test(x.sql) ? 'all' : 'run')) };
const env = { DB };
const src = fs.readFileSync(BOARD + '/worker.js', 'utf8').replace(/\r\n/g, '\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const call = async (u, init) => { try { return await mod.default.fetch(new Request('https://x' + u, init), env, { waitUntil: () => {} }); } catch (e) { return new Response(JSON.stringify({ thrown: String(e) }), { status: 599 }); } };
const get = async (u, init) => { const r = await call(u, init); return { status: r.status, body: await r.json().catch(() => null) }; };
const fire = async () => { const jobs = []; await mod.default.scheduled({ cron: '1-59/2 * * * *', scheduledTime: NOW }, env, { waitUntil: (p) => jobs.push(p) }); await Promise.allSettled(jobs); };
const tablesOf = (u) => new URL(u).searchParams.get('tables');
const KEY = 'lol-lines-test-key-0001';
const typed = (body, key = KEY) => get('/api/lol-lines', { method: 'POST', headers: { 'content-type': 'application/json', 'x-entry-key': key }, body: JSON.stringify(body) });
const iso = (ms) => new RealDate(ms).toISOString();

// What the rules say, worked out here from the stored maps.
const W = { 3: 2, 5: 3 }, STAT = { k: 'kills', a: 'assists', d: 'deaths' };
const r1 = (x) => Math.round(x * 10) / 10;
const lineMemo = new Map();
// Every way his counted maps can fall, each drawn from his last 20: the .5 lines whose share under
// sits nearest half (two when they sit exactly as near).
function fairLines(vals, w) {
  const key = vals.join(',') + '|' + w;
  if (lineMemo.has(key)) return lineMemo.get(key);
  const n = vals.length, N = n ** w, sums = new Map();
  for (let c = 0; c < N; c++) { let s = 0, x = c; for (let i = 0; i < w; i++) { s += vals[x % n]; x = Math.floor(x / n); } sums.set(s, (sums.get(s) || 0) + 1); }
  let best = Infinity, at = [];
  for (let L = 0.5; L < 60; L += 1) {
    let under = 0;
    for (const [v, c] of sums) if (v < L) under += c;
    const gap = Math.abs(2 * under - N);
    if (gap < best) { best = gap; at = [L]; } else if (gap === best) at.push(L);
  }
  lineMemo.set(key, at);
  return at;
}
const sideOf = (stat, league, pTeam, warm) => (league === 'LPL' || !warm ? null
  : pTeam < 35 ? (stat === 'd' ? 'over' : 'under') : pTeam >= 65 ? (stat === 'd' ? 'under' : 'over') : null);
function expected(at) {
  const pre = sq.prepare('SELECT * FROM lolseries WHERE graded_at IS NULL AND start > ? AND bo IN (3, 5) AND p1 IS NOT NULL').all(at);
  const last = new Map();
  for (const g of sq.prepare('SELECT game_id, league, blue, red FROM lolgames WHERE year = 2026 ORDER BY start DESC, game_id DESC').all())
    for (const t of [g.blue, g.red]) if (!last.has(`${g.league}|${t}`)) last.set(`${g.league}|${t}`, g.game_id);
  const out = new Map(), hist = new Map(), short = new Set();
  for (const s of pre) {
    const w = W[s.bo], warm = s.maps1 >= 8 && s.maps2 >= 8;
    for (const [team, pTeam] of [[s.team1, s.p1], [s.team2, r1(100 - s.p1)]]) {
      const gid = last.get(`${s.league}|${team}`);
      if (!gid) continue;
      for (const p of sq.prepare('SELECT player, role FROM lolplayers WHERE game_id = ? AND team = ?').all(gid, team)) {
        if (!hist.has(p.player)) hist.set(p.player, sq.prepare('SELECT kills, deaths, assists FROM lolplayers WHERE year = 2026 AND player = ? ORDER BY start, game_id').all(p.player));
        const h = hist.get(p.player);
        if (h.length < 10) { short.add(p.player); continue; }
        for (const [stat, col] of Object.entries(STAT))
          out.set(`${s.match_id}|${p.player}|${stat}`, { s, team, role: p.role, w, pTeam, warm, side: sideOf(stat, s.league, pTeam, warm), lines: fairLines(h.slice(-20).map((m) => m[col]), w), n: h.length });
      }
    }
  }
  return { want: out, short };
}
// The rows logged for the series still to come, against the rules.
function compare(at) {
  const { want, short } = expected(at);
  const rows = sq.prepare('SELECT p.* FROM lolprops p JOIN lolseries s ON s.match_id = p.match_id WHERE s.graded_at IS NULL AND s.start > ?').all(at);
  const got = new Map(rows.map((r) => [`${r.match_id}|${r.player}|${r.stat}`, r]));
  const bad = [], ties = [];
  for (const [k, x] of want) {
    const r = got.get(k);
    if (!r) { bad.push(`${k}: not logged`); continue; }
    if (x.lines.length > 1) ties.push(k);
    const diffs = [!x.lines.includes(r.line) && `line ${r.line} (the count says ${x.lines.join(' or ')})`, r.side !== x.side && `side ${r.side} (the rule ${x.side})`,
      r.p_team !== x.pTeam && `team chance ${r.p_team} (${x.pTeam})`, r.warm !== (x.warm ? 1 : 0) && `warm ${r.warm}`, r.maps !== x.w && `maps ${r.maps} (${x.w})`,
      r.hist_n !== x.n && `${r.hist_n} maps behind (${x.n})`, r.team !== x.team && `team ${r.team} (${x.team})`, r.role !== x.role && `role ${r.role} (${x.role})`,
      r.bo !== x.s.bo && `Bo${r.bo}`, r.league !== x.s.league && `league ${r.league}`, r.start !== x.s.start && `start ${r.start}`].filter(Boolean);
    if (diffs.length) bad.push(`${k}: ${diffs.join(', ')}`);
  }
  for (const [k, r] of got) if (!want.has(k) && r.pp_line == null) bad.push(`${k}: logged, but the rules give no line`);
  return { want, rows, bad, ties, short };
}
// A finished series' rows against its first maps.
function graded(mid) {
  const s = sq.prepare('SELECT * FROM lolseries WHERE match_id = ?').get(mid), w = W[s.bo];
  const maps = sq.prepare('SELECT game_id FROM lolgames WHERE match_id = ? ORDER BY start, game_id').all(mid).slice(0, w).map((g) => g.game_id);
  const out = { s, maps, rows: 0, voids: 0, open: 0, bad: [], sides: 0, hits: 0 };
  for (const r of sq.prepare('SELECT * FROM lolprops WHERE match_id = ?').all(mid)) {
    out.rows++;
    if (!r.graded_at) { out.open++; continue; }
    const mine = maps.length === w ? sq.prepare(`SELECT * FROM lolplayers WHERE player = ? AND game_id IN (${maps.map(() => '?').join(',')})`).all(r.player, ...maps) : [];
    const played = !s.ff && maps.length === w && mine.length === w;
    const actual = played ? mine.reduce((a, x) => a + x[STAT[r.stat]], 0) : null;
    const vs = (L) => (L == null ? null : !played ? 'void' : actual > L ? 'over' : actual < L ? 'under' : 'push');
    if (!played) out.voids++;
    if (r.side && played) { out.sides++; if (vs(r.line) === r.side) out.hits++; }
    if (r.actual !== actual || r.result !== vs(r.line) || r.pp_result !== vs(r.pp_line))
      out.bad.push(`${r.player} ${r.stat}: ${r.actual} ${r.result}/${r.pp_result}, the maps say ${actual} ${vs(r.line)}/${vs(r.pp_line)}`);
  }
  return out;
}
const openOf = (mid) => sq.prepare('SELECT COUNT(*) AS n FROM lolprops WHERE match_id = ? AND graded_at IS NULL').get(mid).n;
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
function recordOf() {
  const t0 = () => ({ n: 0, hit: 0 }), by = Object.fromEntries(Object.keys(STAT).map((k) => [k, { atLine: t0(), atPp: t0(), over: t0() }])), all = { atLine: t0(), atPp: t0() };
  for (const r of sq.prepare('SELECT * FROM lolprops WHERE graded_at IS NOT NULL').all()) {
    const b = by[r.stat];
    if (r.result === 'over' || r.result === 'under') {
      b.over.n++; if (r.result === 'over') b.over.hit++;
      if (r.side) { b.atLine.n++; all.atLine.n++; if (r.result === r.side) { b.atLine.hit++; all.atLine.hit++; } }
    }
    if (r.side && (r.pp_result === 'over' || r.pp_result === 'under')) { b.atPp.n++; all.atPp.n++; if (r.pp_result === r.side) { b.atPp.hit++; all.atPp.hit++; } }
  }
  return { byStat: by, ...all };
}
const say = (x) => x.bad.slice(0, 5).map((b) => '\n          ' + b).join('');

console.log('-- the tables, and the season to Aug 6 --');
ok((await get('/api/lol-board')).status === 200, '/api/lol-board answers');
const ins = sq.prepare('INSERT INTO lolgames (game_id, match_id, league, year, start, blue, red, winner) VALUES (?,?,?,2026,?,?,?,?)');
for (const g of GAMES) ins.run(g[0], g[1], g[2], g[3], g[4], g[5], g[6]);
const byGame = new Map(GAMES.map((g) => [g[0], g]));
const insP = sq.prepare(`INSERT INTO lolplayers (game_id, player, match_id, league, year, start, team, role, champion, kills, deaths, assists, team_kills, win)
  VALUES (?,?,?,?,2026,?,?,?,?,?,?,?,?,?)`);
for (const p of PLAYERS) { const g = byGame.get(p[0]); insP.run(p[0], p[1], g[1], g[2], g[3], p[2], p[3], p[4], p[5], p[6], p[7], p[8], p[9]); }
console.log(`        seeded ${GAMES.length} maps and ${PLAYERS.length} player lines`);

console.log('\n-- Aug 8, 12:00 UTC: each series to come, each player\'s three lines --');
await fire();
ok(asked.map(tablesOf).join(',') === 'MatchSchedule=MS,ScoreboardPlayers=SP,Tournaments=T' && unknown.length === 0, `the reads are the recorded ones (${asked.map(tablesOf).join(', ')})`);
const T1 = iso(NOW);
let c = compare(T1);
const preIds = [...new Set([...c.want.values()].map((x) => x.s.match_id))];
ok(c.rows.length > 1000 && c.bad.length === 0,
  `${c.rows.length} lines on ${preIds.length} series, each at the player's 50/50 point and the rule's side (${c.ties.length} sat exactly between two lines)${say(c)}`);
ok(c.short.size > 0 && [...c.short].every((p) => !c.rows.some((r) => r.player === p)), `the ${c.short.size} in a line-up with fewer than ten maps this season have none`);
const before = sq.prepare("SELECT match_id FROM lolseries WHERE start <= ?").all(T1).map((x) => x.match_id);
ok(before.length > 0 && before.every((id) => !sq.prepare('SELECT 1 FROM lolprops WHERE match_id = ?').get(id)), `none on the ${before.length} series already started when the log began`);
const lpl = c.rows.filter((r) => r.league === 'LPL'), elsewhere = c.rows.filter((r) => r.league !== 'LPL');
ok(lpl.length > 0 && lpl.every((r) => r.side == null), `no side in the LPL (${lpl.length} lines)`);
const sided = elsewhere.filter((r) => r.side);
ok(sided.length > 0 && sided.every((r) => (r.p_team < 35 || r.p_team >= 65) && r.warm === 1)
  && elsewhere.filter((r) => r.p_team < 35 && r.warm).every((r) => r.side === (r.stat === 'd' ? 'over' : 'under'))
  && elsewhere.filter((r) => r.p_team >= 65 && r.warm).every((r) => r.side === (r.stat === 'd' ? 'under' : 'over')),
  `elsewhere ${sided.length} of ${elsewhere.length} with a side: Under on a big underdog, Over on a big favourite, deaths reversed`);
ok(c.rows.every((r) => r.maps === 2 && r.line % 1 === 0.5), 'all best-of-three: maps 1-2 counted, every line a half');

console.log('\n-- the board at Aug 8, 12:00 --');
const C9 = 'LCS/2026 Season/Summer Season_Week 3_1';
let b = (await get('/api/lol-board')).body;
const c9 = b.matches.find((m) => m.id === C9) || {};
const ROLES = ['Top', 'Jungle', 'Mid', 'Bot', 'Support'];
const sorted = (ps) => ps.every((p, i) => i === 0 || ps[i - 1].team < p.team || (ps[i - 1].team === p.team && ROLES.indexOf(ps[i - 1].role) <= ROLES.indexOf(p.role)));
console.log(`        ${c9.teams.map((t) => `${t.name} ${t.p}%`).join(' v ')}: ${(c9.props && c9.props.players || []).map((p) => `${p.name} (${p.role}) assists ${p.a && p.a.line}${p.a && p.a.side ? ' ' + p.a.side : ''}`).join(', ')}`);
const c9n = new Set(c.rows.filter((r) => r.match_id === C9).map((r) => r.player)).size;
ok(c9.props && c9.props.maps === 2 && c9n >= 8 && c9.props.players.length === c9n && sorted(c9.props.players),
  `Cloud9 v Disguised: maps 1-2, the ${c9n} with ten maps or more by team and role (Cloud9's Tactical and Disguised's Srtty have fewer)`);
const boardRows = b.matches.flatMap((m) => (m.props ? m.props.players.flatMap((p) => Object.keys(STAT).filter((k) => p[k]).map((k) => ({ m, p, k }))) : []));
ok(boardRows.length === c.rows.filter((r) => b.matches.some((m) => m.id === r.match_id)).length
  && boardRows.every(({ m, p, k }) => { const r = c.rows.find((x) => x.match_id === m.id && x.player === p.name && x.stat === k);
    return r && p[k].line === r.line && p[k].side === r.side && p[k].actual == null && p[k].result == null && p.n === r.hist_n && (p.team === 1) === (r.team === m.teams[0].name); }),
  `every line logged in the window is on the board as logged (${boardRows.length})`);
ok(b.matches.filter((m) => m.state !== 'pre').every((m) => !m.props), 'none on a series already under way or over');
ok(b.propsRecord === null, 'no record before anything is graded');

console.log('\n-- PrizePicks\' lines typed (/api/lol-lines), Aug 8 12:05 --');
NOW = RealDate.parse('2026-08-08T12:05:00Z');
const c9mid = c9.props.players.find((p) => p.team === 1 && p.role === 'Mid'), c9bot = c9.props.players.find((p) => p.team === 1 && p.role === 'Jungle');
const dsgSup = c9.props.players.find((p) => p.team === 2 && p.role === 'Support');
ok((await get('/api/lol-lines')).status === 401, 'no key: refused');
let t = await typed({ matchId: C9, player: c9mid.name, stat: 'a', line: c9mid.a.line + 2 });
ok(t.status === 200 && t.body.ok && t.body.claimed, `${c9mid.name} assists at ${c9mid.a.line + 2}: saved (the first key opens the log)`);
t = await typed({ matchId: C9, player: c9mid.name, stat: 'a', line: c9mid.a.line + 1 });
ok(t.status === 200 && !t.body.claimed, `changed to ${c9mid.a.line + 1}`);
ok((await typed({ matchId: C9, player: c9bot.name, stat: 'k', line: Math.floor(c9bot.k.line) })).status === 200, `${c9bot.name} kills at ${Math.floor(c9bot.k.line)}, a whole number`);
ok((await typed({ matchId: C9, player: dsgSup.name, stat: 'd', line: dsgSup.d.line })).status === 200, `${dsgSup.name} deaths at ${dsgSup.d.line}`);
const refusals = [[{ matchId: C9, player: c9mid.name, stat: 'x', line: 7.5 }, 400, 'a stat that isn\'t kills, assists or deaths'],
  [{ matchId: C9, player: c9mid.name, stat: 'a', line: 7.3 }, 400, 'a line that isn\'t a whole or half number'],
  [{ matchId: C9, player: c9mid.name, stat: 'a', line: 0 }, 400, 'a line of 0'], [{ matchId: C9, player: c9mid.name, stat: 'a', line: 100 }, 400, 'a line of 100'],
  [{ matchId: C9, player: 'Nobody', stat: 'a', line: 7.5 }, 404, 'a player not in the match'],
  [{ matchId: before[before.length - 1], player: c9mid.name, stat: 'a', line: 7.5 }, 404, 'a series with no lines']];
for (const [body, want, what] of refusals) { const r = await typed(body); ok(r.status === want && r.body && r.body.error, `${what}: ${r.status} "${r.body && r.body.error}"`); }
ok((await typed({ matchId: C9, player: c9mid.name, stat: 'a', line: 5.5 }, 'another-key-0000000000')).status === 403, 'another key: refused');
let mine = await get('/api/lol-lines', { headers: { 'x-entry-key': KEY } });
const row = (p, s) => sq.prepare('SELECT * FROM lolprops WHERE match_id = ? AND player = ? AND stat = ?').get(C9, p, s);
ok(mine.status === 200 && mine.body.lines.length === 3 && mine.body.lines.some((l) => l.player === c9mid.name && l.stat === 'a' && l.pp_line === c9mid.a.line + 1)
  && row(c9mid.name, 'a').pp_edits === 2, `the key's lines: ${mine.body.lines.map((l) => `${l.player} ${l.stat} ${l.pp_line}`).join(', ')}; edited twice`);
NOW = RealDate.parse('2026-08-08T12:10:00Z');
b = (await get('/api/lol-board')).body;
ok(!/"pp/.test(JSON.stringify(b)) && b.asOf === iso(NOW), 'the public board, rebuilt, carries none of them');

console.log('\n-- Aug 9, 08:00 UTC: the night\'s series graded --');
NOW = RealDate.parse('2026-08-09T08:00:00Z');
asked.length = 0;
const t1Rows = new Map(sq.prepare('SELECT * FROM lolprops').all().map((r) => [`${r.match_id}|${r.player}|${r.stat}`, r]));
await fire();
ok(asked.map(tablesOf).join(',') === 'MatchSchedule=MS,ScoreboardPlayers=SP' && unknown.length === 0, `the recorded reads (${asked.map(tablesOf).join(', ')})`);
const T2 = iso(NOW);
const night = sq.prepare('SELECT match_id, team1, team2, bo, start FROM lolseries WHERE start > ? AND start <= ? ORDER BY start').all(T1, T2);
const done = night.map((s) => ({ s, g: graded(s.match_id) }));
const full = done.filter((x) => x.g.maps.length === 2), waiting = done.filter((x) => x.g.maps.length < 2);
for (const { s, g } of done) console.log(`        ${s.team1} v ${s.team2}: ${g.maps.length} of 2 maps in, ${g.rows - g.open} of ${g.rows} graded${g.sides ? `, the side ${g.hits} of ${g.sides}` : ''}${g.voids ? `, ${g.voids} void` : ''}`);
ok(full.length === 4 && full.every((x) => x.g.rows >= 24 && x.g.open === 0 && x.g.bad.length === 0),
  `the four with maps 1-2 in: every line graded on the sum over them${full.map((x) => say(x.g)).join('')}`);
ok(waiting.length === 2 && waiting.every((x) => x.g.rows >= 24 && x.g.open === x.g.rows),
  `the two whose maps aren't in yet wait: ${waiting.map((x) => `${x.s.team1} v ${x.s.team2} (${x.g.maps.length} in)`).join(', ')}`);
const C9g = graded(C9);
ok(C9g.maps.length === 2 && sq.prepare('SELECT COUNT(*) AS n FROM lolgames WHERE match_id = ?').get(C9).n === 3, 'Cloud9 v Disguised went three maps; the first two are counted');
const pp = [row(c9mid.name, 'a'), row(c9bot.name, 'k'), row(dsgSup.name, 'd')];
ok(pp.every((r) => r.pp_result && r.pp_result !== 'void' && r.pp_result === (r.actual > r.pp_line ? 'over' : r.actual < r.pp_line ? 'under' : 'push')),
  `the typed lines graded at their own numbers: ${pp.map((r) => `${r.player} ${STAT[r.stat]} ${r.actual} v ${r.pp_line} ${r.pp_result} (the stand-in ${r.line} ${r.result})`).join('; ')}`);
c = compare(T2);
const dropped = [...t1Rows.keys()].filter((k) => { const r = t1Rows.get(k); return Date.parse(r.start) > NOW && !c.rows.some((x) => `${x.match_id}|${x.player}|${x.stat}` === k); });
ok(c.bad.length === 0, `the series still to come re-logged at the new chances and line-ups (${c.rows.length} lines${dropped.length ? `, ${dropped.length} of a player since left out taken off` : ''})${say(c)}`);
mine = await get('/api/lol-lines', { headers: { 'x-entry-key': KEY } });
ok(mine.body.lines.length === 0, 'the typed lines graded, none left open');
const late = waiting[waiting.length - 1].s;
const lateP = sq.prepare('SELECT player FROM lolprops WHERE match_id = ? LIMIT 1').get(late.match_id).player;
t = await typed({ matchId: late.match_id, player: lateP, stat: 'k', line: 3.5 });
ok(t.status === 409, `${late.team1} v ${late.team2} has started: its lines are locked (${t.status})`);
ok((await typed({ matchId: C9, player: c9mid.name, stat: 'a', line: 9.5 })).status === 409, 'and a graded one too');
b = (await get('/api/lol-board')).body;
const c9b = b.matches.find((m) => m.id === C9);
ok(c9b.props.players.every((p) => Object.keys(STAT).every((k) => p[k].actual === row(p.name, k).actual && p[k].result === row(p.name, k).result)),
  'the board shows what each did and how the line went');
ok(b.propsRecord && JSON.stringify(canon(b.propsRecord)) === JSON.stringify(canon(recordOf())),
  `the record: at the stand-in line ${b.propsRecord && b.propsRecord.atLine.hit} of ${b.propsRecord && b.propsRecord.atLine.n} on the rule's side, at PrizePicks' ${b.propsRecord && b.propsRecord.atPp.hit} of ${b.propsRecord && b.propsRecord.atPp.n}`);

console.log('\n-- a best-of-one and a best-of-five (stand-ins: two real series with the format changed) --');
const copy = (league, bo) => { const s = sq.prepare("SELECT * FROM lolseries WHERE league = ? AND start > '2026-08-12' ORDER BY start LIMIT 1").get(league);
  sq.prepare(`INSERT INTO lolseries (match_id, league, page, year, start, date, bo, team1, team2, read_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(`stand-in Bo${bo}: ${s.match_id}`, s.league, s.page, s.year, s.start, s.date, bo, s.team1, s.team2, s.read_at);
  return `stand-in Bo${bo}: ${s.match_id}`; };
const BO5 = copy('LCK', 5), BO1 = copy('LEC', 1);

console.log('\n-- a line-up change (stand-ins: a player who has played for the team this season but not on its last map, logged as if he were in it) --');
const benchedOn = (list) => { for (const s of list) for (const team of [s.team1, s.team2]) {
  const last = sq.prepare('SELECT game_id FROM lolgames WHERE year = 2026 AND league = ? AND (blue = ? OR red = ?) ORDER BY start DESC, game_id DESC LIMIT 1').get(s.league, team, team);
  const p = last && sq.prepare(`SELECT player, role, COUNT(*) AS n FROM lolplayers WHERE year = 2026 AND league = ? AND team = ?
    AND player NOT IN (SELECT player FROM lolplayers WHERE game_id = ?) GROUP BY player ORDER BY n DESC, player LIMIT 1`).get(s.league, team, last.game_id);
  if (p) return { s, team, ...p }; } return null; };
const standIn = (x, stat, pp) => sq.prepare(`INSERT INTO lolprops (match_id, player, stat, league, year, start, team, role, bo, maps, p_team, warm, side, line, hist_n, logged_at, pp_line, pp_at, pp_edits)
    VALUES (?,?,?,?,2026,?,?,?,?,2,?,1,NULL,4.5,?,?,?,?,?)`)
  .run(x.s.match_id, x.player, stat, x.s.league, x.s.start, x.team, x.role, x.s.bo, x.team === x.s.team1 ? x.s.p1 : r1(100 - x.s.p1), x.n, T2, pp, pp == null ? null : T2, pp == null ? null : 1);
const sat = benchedOn(waiting.map((x) => sq.prepare('SELECT * FROM lolseries WHERE match_id = ?').get(x.s.match_id)));
const left = benchedOn(sq.prepare("SELECT * FROM lolseries WHERE start > '2026-08-09T10:00:00.000Z' AND bo = 3 ORDER BY start").all());
standIn(sat, 'k', 4.5);
standIn(left, 'k', null);
standIn(left, 'a', 4.5);
console.log(`        ${sat.player} (${sat.team}, ${sat.n} maps) on ${sat.s.team1} v ${sat.s.team2}, under way, his line typed;`
  + ` ${left.player} (${left.team}, ${left.n} maps) on ${left.s.team1} v ${left.s.team2}, to come, one line typed and one not`);

console.log('\n-- Aug 9, 10:00 UTC: the last maps in --');
NOW = RealDate.parse('2026-08-09T10:00:00Z');
asked.length = 0;
await fire();
ok(asked.map(tablesOf).join(',') === 'ScoreboardPlayers=SP' && unknown.length === 0, `the scoreboards only, recorded (${asked.map(tablesOf).join(', ')})`);
const T3 = iso(NOW);
for (const { s } of waiting) {
  const g = graded(s.match_id), n = sq.prepare('SELECT COUNT(*) AS n FROM lolgames WHERE match_id = ?').get(s.match_id).n;
  ok(g.maps.length === 2 && g.open === 0 && g.bad.length === 0, `${s.team1} v ${s.team2}: ${n} maps in, graded on the first two${g.sides ? ` (the side ${g.hits} of ${g.sides})` : ''}${say(g)}`);
}
const satRow = sq.prepare("SELECT * FROM lolprops WHERE match_id = ? AND player = ? AND stat = 'k'").get(sat.s.match_id, sat.player);
ok(satRow && satRow.graded_at && satRow.result === 'void' && satRow.pp_result === 'void' && satRow.actual == null,
  `${sat.player}, logged but on neither map: void at both lines`);
ok(!sq.prepare("SELECT 1 FROM lolprops WHERE match_id = ? AND player = ? AND stat = 'k'").get(left.s.match_id, left.player),
  `${left.player}'s untyped line on ${left.s.team1} v ${left.s.team2} taken off, as he isn't on his team's last map`);
const kept = sq.prepare("SELECT * FROM lolprops WHERE match_id = ? AND player = ? AND stat = 'a'").get(left.s.match_id, left.player);
ok(kept && kept.pp_line === 4.5 && !kept.graded_at && kept.logged_at === T2, 'his typed one kept as it was, to be graded (void if he sits out)');
const third = sq.prepare('SELECT match_id, team1, team2 FROM lolseries WHERE start > ? AND start <= ? ORDER BY start').all(T2, T3);
for (const s of third) {
  const g = graded(s.match_id);
  ok(g.maps.length < 2 && g.rows >= 24 && g.open === g.rows, `${s.team1} v ${s.team2}: ${g.maps.length} of 2 maps in, waits`);
}
c = compare(T3);
const bo5 = c.rows.filter((r) => r.match_id === BO5);
ok(c.bad.length === 0 && bo5.length >= 24 && bo5.every((r) => r.maps === 3 && r.bo === 5),
  `the series to come (${c.rows.length} lines), the best-of-five's counted over maps 1-3, its lines by every way three maps fall${say(c)}`);
const bo5c = sq.prepare('SELECT p1 FROM lolseries WHERE match_id = ?').get(BO5).p1, bo3c = sq.prepare('SELECT p1 FROM lolseries WHERE match_id = ?').get(BO5.replace('stand-in Bo5: ', '')).p1;
console.log(`        the best-of-five's favourite ${Math.max(bo5c, 100 - bo5c)}% against ${Math.max(bo3c, 100 - bo3c)}% over three maps`);
ok(!sq.prepare('SELECT 1 FROM lolprops WHERE match_id = ?').get(BO1), 'the best-of-one has none');

console.log('\n-- two weeks on, the reads held off (stand-in: the rate limit\'s answer) --');
NOW = RealDate.parse('2026-08-23T10:30:00Z');
refuse = true;
asked.length = 0;
await fire();
ok(asked.length === 1, 'one read, refused');
for (const s of third) {
  const g = graded(s.match_id);
  ok(g.open === 0 && g.voids === g.rows && g.bad.length === 0, `${s.team1} v ${s.team2} (${g.maps.length} of 2 maps in, more than two weeks back): void${say(g)}`);
}
const next = sq.prepare('SELECT match_id, team1, team2, start FROM lolseries WHERE start > ? ORDER BY start LIMIT 1').get(T3);
ok(openOf(next.match_id) >= 24, `${next.team1} v ${next.team2} (${next.start.slice(5, 16)}, under two weeks back): still waits`);
b = (await get('/api/lol-board')).body;
ok(b.propsRecord && JSON.stringify(canon(b.propsRecord)) === JSON.stringify(canon(recordOf())), 'the record counts no void');
ok(binds <= 100, `no statement past D1's 100 bound values (the most: ${binds})`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
