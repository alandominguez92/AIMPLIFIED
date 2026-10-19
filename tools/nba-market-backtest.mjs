// Which NBA PrizePicks market's under is worth aiming for: every market,
// replayed over two regular seasons of ESPN box scores (free), against a line
// set at the player's last-ten-game average rounded to the nearest .5 -- the
// method behind the threes/assists/rebounds choice (see NBA_PP_MARKETS in
// worker.js). It is a proxy for PrizePicks' number, not PrizePicks' number.
//
//   node tools/nba-market-backtest.mjs fetch <cacheDir> [espnSeason ...]
//   node tools/nba-market-backtest.mjs report <cacheDir> [out.json]
//
// fetch reads ESPN's scoreboard a day at a time (it refuses a date range) and
// each finished regular-season game's box score from cdn.espn.com -- the host
// and the parser the cron uses: nbaBoxRows is lifted from worker.js, so a
// stat means here exactly what it means in nba_box. One small file per game.
// espnSeason 2025 is 2024-25, 2026 is 2025-26 (the default: both).
//
// report prints the tables tools/nba-market-backtest.md was written from, and
// with out.json also writes them as data.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const [cmd, cache, ...rest] = process.argv.slice(2);
if (!cmd || !cache) {
  console.error('usage: nba-market-backtest.mjs fetch <cacheDir> [season ...] | report <cacheDir> [out.json]');
  process.exit(2);
}
const UA = { 'user-agent': 'Mozilla/5.0', accept: 'application/json' };
async function get(u, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(u, { headers: UA }); if (r.ok) return await r.json(); if (r.status === 404) return null; } catch (e) { /* retry */ }
    await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
  }
  return null;
}

// The cron's own box-score parser, so the backtest cannot drift from nba_box.
function liftNbaBoxRows() {
  const src = fs.readFileSync(path.join(ROOT, 'worker.js'), 'utf8').replace(/\r\n/g, '\n');
  const a = src.indexOf('function nbaBoxRows(');
  const b = src.indexOf('\n}\n', a);
  if (a < 0 || b < 0) throw new Error('nbaBoxRows not found in worker.js');
  return new Function(`${src.slice(a, b + 2)}\nreturn nbaBoxRows;`)();
}

// The thirty clubs: an All-Star or Rising Stars game is filed as regular season.
const CLUBS = new Set(['ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GS', 'HOU', 'IND', 'LAC', 'LAL', 'MEM',
  'MIA', 'MIL', 'MIN', 'NO', 'NY', 'OKC', 'ORL', 'PHI', 'PHX', 'POR', 'SAC', 'SA', 'TOR', 'UTAH', 'WSH']);
const SEASON_DAYS = { 2025: ['2024-10-01', '2025-04-30'], 2026: ['2025-10-01', '2026-04-30'] };

async function fetchSeason(season) {
  const [from, to] = SEASON_DAYS[season] || [];
  if (!from) throw new Error(`no date range for season ${season}`);
  const D = path.join(cache, String(season));
  fs.mkdirSync(D, { recursive: true });
  const days = [];
  for (let d = new Date(from + 'T12:00:00Z'); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
  const games = [];
  const dq = [...days];
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (dq.length) {
      const day = dq.shift();
      const j = await get(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${day.replace(/-/g, '')}`);
      for (const e of ((j && j.events) || [])) {
        const comp = (e.competitions || [])[0] || {};
        const ab = (comp.competitors || []).map((c) => c.team && c.team.abbreviation);
        if (!(e.season && e.season.type === 2) || !(e.status && e.status.type && e.status.type.completed)) continue;
        if (ab.length !== 2 || !ab.every((x) => CLUBS.has(x))) continue;
        games.push({ id: e.id, day, utc: e.date, teams: ab });
      }
    }
  }));
  const todo = games.filter((g) => !fs.existsSync(path.join(D, g.id + '.json')));
  console.log(`season ${season}: ${games.length} regular-season games, ${todo.length} to fetch`);
  const nbaBoxRows = liftNbaBoxRows();
  let done = 0, empty = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (todo.length) {
      const g = todo.shift();
      const sum = await get(`https://cdn.espn.com/core/nba/boxscore?xhr=1&gameId=${g.id}`);
      const rows = nbaBoxRows(sum, g.id, g.day, 2);
      if (!rows.length) { empty++; continue; }
      fs.writeFileSync(path.join(D, g.id + '.json'), JSON.stringify({ ...g, rows }));
      if (++done % 200 === 0) console.log(`  ${done} read`);
    }
  }));
  console.log(`season ${season}: ${done} read, ${empty} with no box score`);
}

// ---- report ---------------------------------------------------------------------
// The markets, with their keys in nba_box (worker.js NBA_BOX_STATS / NBA_COMBOS).
// Free throws attempted and Fantasy Score are extras: the Odds API carries
// both (player_frees_attempts, player_fantasy_points), so they could be logged.
// Fantasy Score is PrizePicks' scoring: points 1, rebounds 1.2, assists 1.5,
// blocks 3, steals 3, turnovers -1.
const MARKETS = [
  ['pts', 'Points', ['pts']], ['reb', 'Rebounds', ['reb']], ['ast', 'Assists', ['ast']],
  ['threes', '3-PT made', ['threes']], ['fg3a', '3-PT attempted', ['fg3a']],
  ['fga', 'FG attempted (shots)', ['fga']], ['fgm', 'FG made', ['fgm']], ['ftm', 'Free throws made', ['ftm']],
  ['stl', 'Steals', ['stl']], ['blk', 'Blocks', ['blk']], ['blk_stl', 'Blks+Stls', ['blk', 'stl']], ['tov', 'Turnovers', ['tov']],
  ['pra', 'Pts+Rebs+Asts', ['pts', 'reb', 'ast']], ['pts_reb', 'Pts+Rebs', ['pts', 'reb']], ['pts_ast', 'Pts+Asts', ['pts', 'ast']],
  ['reb_ast', 'Rebs+Asts', ['reb', 'ast']], ['oreb', 'Offensive rebounds', ['oreb']], ['dreb', 'Defensive rebounds', ['dreb']],
  ['fta', 'Free throws attempted (extra)', ['fta']],
  ['fantasy', 'Fantasy Score (extra)', [['pts', 1], ['reb', 1.2], ['ast', 1.5], ['blk', 3], ['stl', 3], ['tov', -1]]],
];
const statOf = (parts) => (x) => {
  let s = 0;
  for (const p of parts) {
    const [k, w] = Array.isArray(p) ? p : [p, 1];
    if (x[k] == null) return null;
    s += w * x[k];
  }
  return Math.round(s * 10) / 10;
};
const BREAK_EVEN = [['5/6-flex', 54.2], ['2-power', 57.7], ['3-flex', 59.1]];
const ROTATION = 20;
const MIN_BANDS = [['<20', 0, 20], ['20-25', 20, 25], ['25-30', 25, 30], ['30-35', 30, 35], ['35+', 35, 99]];

// Line bands sized to each market's scale: the line levels PrizePicks posts.
function lineBands(key) {
  const cuts = {
    pts: [10, 15, 20, 25, 30], pra: [15, 22, 30, 38, 45], pts_reb: [12, 18, 24, 30, 36], pts_ast: [12, 18, 24, 30, 36],
    reb: [4, 6, 8, 10, 12], ast: [2, 4, 6, 8, 10], reb_ast: [5, 8, 11, 14, 17], dreb: [3, 5, 7, 9],
    fga: [8, 11, 14, 17, 20], fgm: [3, 5, 7, 9], fg3a: [3, 5, 7, 9], threes: [1, 2, 3, 4],
    ftm: [1, 2, 3, 5], stl: [1, 1.5, 2], blk: [1, 1.5, 2], blk_stl: [1, 2, 3], tov: [1, 2, 3, 4], oreb: [1, 2, 3],
    fta: [2, 3, 4, 6], fantasy: [15, 20, 25, 30, 40, 50],
  }[key];
  const out = [];
  let lo = 0;
  for (const c of cuts) { out.push([lo === 0 ? `<${c}` : `${lo}-${c - 0.5}`, lo, c]); lo = c; }
  out.push([`${lo}+`, lo, 999]);
  return out;
}

function wilson(k, n) {
  if (!n) return [null, null];
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [100 * (c - h), 100 * (c + h)];
}
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

function loadSeason(season) {
  const D = path.join(cache, String(season));
  if (!fs.existsSync(D)) return [];
  const games = fs.readdirSync(D).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(D, f), 'utf8')));
  games.sort((a, b) => (a.utc < b.utc ? -1 : a.utc > b.utc ? 1 : 0));
  return games;
}

// One sample per (player-game, market): the player's ten previous games this
// season he played in, their average rounded to the nearest .5 as the line,
// and what he did tonight. A game he did not play is no sample (PrizePicks
// voids it) and does not count among his ten.
//
// Each sample also carries the result at a second line: the MEDIAN of the ten,
// rounded the same way. A count like blocks is skewed -- a few big nights pull
// the average above the typical night -- so an under against the average wins
// more than half the time with no information at all. The books set a line
// nearer the typical night, and PrizePicks follows the books, so the median
// line is the harder and likelier test of what is left once that is priced.
function samples(season) {
  const out = [];
  const hist = new Map();
  const side = (actual, line) => (line < 0.5 ? null : actual < line ? 'u' : actual > line ? 'o' : 'p');
  for (const g of loadSeason(season)) {
    for (const r of g.rows) {
      if (r.dnp || r.min == null) continue;
      const h = hist.get(r.player_id) || [];
      if (h.length >= 10) {
        const last = h.slice(-10);
        const projMin = last.reduce((a, x) => a + x.min, 0) / 10;
        for (const [key, , parts] of MARKETS) {
          const val = statOf(parts);
          const vals = last.map(val);
          const actual = val(r);
          if (actual == null || vals.some((v) => v == null)) continue;
          const avg = vals.reduce((a, v) => a + v, 0) / 10;
          const line = Math.round(avg * 2) / 2;
          if (line < 0.5) continue;              // nobody posts a zero
          const s = [...vals].sort((a, b) => a - b);
          const med = Math.round((s[4] + s[5])) / 2;   // (5th + 6th) / 2, to the nearest .5
          out.push({ season, key, line, avg, projMin, actual, res: side(actual, line), medRes: side(actual, med), player: r.player });
        }
      }
      h.push(r);
      hist.set(r.player_id, h);
    }
  }
  return out;
}

function cell(list, f = 'res') {
  list = list.filter((s) => s[f] != null);
  const u = list.filter((s) => s[f] === 'u').length, o = list.filter((s) => s[f] === 'o').length;
  const p = list.length - u - o, n = u + o;
  const [lo, hi] = wilson(u, n);
  return { n, under: n ? r1(100 * u / n) : null, lo: r1(lo), hi: r1(hi), push: list.length ? r1(100 * p / list.length) : null };
}

function report() {
  const seasons = rest.length && !rest[0].endsWith('.json') ? rest.filter((x) => !x.endsWith('.json')) : ['2025', '2026'];
  const outJson = rest.find((x) => x.endsWith('.json'));
  const all = seasons.flatMap((s) => samples(s));
  const games = Object.fromEntries(seasons.map((s) => [s, loadSeason(s).length]));
  const rot = all.filter((s) => s.projMin >= ROTATION);
  const res = { built: new Date().toISOString(), seasons, games, rotationMin: ROTATION, markets: {} };
  for (const [key, label] of MARKETS) {
    const m = rot.filter((s) => s.key === key);
    const all1 = all.filter((s) => s.key === key);
    res.markets[key] = {
      label,
      rotation: cell(m),
      halfLinesOnly: cell(m.filter((s) => s.line % 1 !== 0)),
      medianLine: cell(m, 'medRes'),
      everyone: cell(all1),
      bySeason: Object.fromEntries(seasons.map((s) => [s, cell(m.filter((x) => x.season === s))])),
      byLine: Object.fromEntries(lineBands(key).map(([k, lo, hi]) => [k, cell(m.filter((s) => s.line >= lo && s.line < hi))])),
      byMinutes: Object.fromEntries(MIN_BANDS.map(([k, lo, hi]) => [k, cell(all1.filter((s) => s.projMin >= lo && s.projMin < hi))])),
    };
  }
  if (outJson) fs.writeFileSync(outJson, JSON.stringify(res, null, 1));

  const pct = (c) => (c.under == null ? '–' : `${c.under.toFixed(1)}%`);
  // "Clears" by the bottom of the 95% interval, not the middle of it.
  const clears = (c) => BREAK_EVEN.filter(([, be]) => c.lo != null && c.lo >= be).map(([k]) => k).join(', ') || '–';
  console.log(`games: ${JSON.stringify(games)}; rotation = ${ROTATION}+ projected (last-10) minutes\n`);
  console.log('| market | rotation games | under | 95% CI | push | .5 lines only | 2024-25 | 2025-26 | clears (CI low) | at the median line |');
  console.log('| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: |');
  const order = Object.entries(res.markets).sort((a, b) => b[1].rotation.under - a[1].rotation.under);
  for (const [, m] of order) {
    const c = m.rotation;
    console.log(`| ${m.label} | ${c.n.toLocaleString('en-US')} | ${pct(c)} | ${c.lo}–${c.hi} | ${c.push}% | ${pct(m.halfLinesOnly)} | ${pct(m.bySeason['2025'] || {})} | ${pct(m.bySeason['2026'] || {})} | ${clears(c)} | ${pct(m.medianLine)} (${m.medianLine.n.toLocaleString('en-US')}) |`);
  }
  console.log('\nby line level (rotation):');
  for (const [, m] of order) {
    console.log(`  ${m.label.padEnd(22)} ` + Object.entries(m.byLine).map(([k, c]) => `${k}: ${pct(c)} (${c.n})`).join(' · '));
  }
  console.log('\nby projected minutes (everyone):');
  for (const [, m] of order) {
    console.log(`  ${m.label.padEnd(22)} ` + Object.entries(m.byMinutes).map(([k, c]) => `${k}: ${pct(c)} (${c.n})`).join(' · '));
  }
}

if (cmd === 'fetch') {
  for (const s of (rest.length ? rest : ['2025', '2026'])) await fetchSeason(Number(s));
} else if (cmd === 'report') report();
else { console.error('unknown command ' + cmd); process.exit(2); }
