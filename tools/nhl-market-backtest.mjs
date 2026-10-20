// Which NHL PrizePicks market's under is worth aiming for, before any hockey
// prop is logged or any Odds API credit is spent on one: every market the NHL
// box score carries, replayed over two regular seasons of api-web.nhle.com
// box scores (free, no key), against lines built from the player's own recent
// games. The NBA run (tools/nba-market-backtest.mjs) is the model; the lines
// differ because hockey's are different (see samples()). It is a proxy for
// PrizePicks' number, not PrizePicks' number.
//
//   node tools/nhl-market-backtest.mjs fetch <cacheDir> [season ...]
//   node tools/nhl-market-backtest.mjs report <cacheDir> [out.json]
//
// fetch reads /v1/score a day at a time (it honours the date; the grader in
// worker.js reads the same endpoint) for each day's finished regular-season
// games, then each game's /v1/gamecenter/{id}/boxscore. One small file per
// game, trimmed to what nhlBoxRows keeps. Season 2025 is 2024-25, 2026 is
// 2025-26 (the default: both).
//
// report prints the tables tools/nhl-market-backtest.md was written from, and
// with out.json also writes them as data.
import fs from 'node:fs';
import path from 'node:path';

const [cmd, cache, ...rest] = process.argv.slice(2);
if (!cmd || !cache) {
  console.error('usage: nhl-market-backtest.mjs fetch <cacheDir> [season ...] | report <cacheDir> [out.json]');
  process.exit(2);
}
const NHLE = 'https://api-web.nhle.com/v1';
const UA = { 'user-agent': 'Mozilla/5.0', accept: 'application/json' };
async function get(u, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(u, { headers: UA }); if (r.ok) return await r.json(); if (r.status === 404) return null; } catch (e) { /* retry */ }
    await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
  }
  throw new Error(`gave up on ${u}`);   // a lost day or game must not pass for an empty one
}

// "17:42" -> 17.7 minutes.
function toiMin(s) {
  const m = /^(\d+):(\d\d)$/.exec(String(s == null ? '' : s));
  return m ? Number(m[1]) + Number(m[2]) / 60 : null;
}
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

// Pure: one api-web.nhle.com box score in, one row per dressed player out.
// Reads only fields the box score sends (checked on 2024020706, EDM@MIN
// 2025-01-15); a field it leaves out is null, not 0. The box score has no
// faceoffs won (only a percentage), no power-play assists (so no power-play
// points) and no shorthanded points, so those PrizePicks markets are not here.
function nhlBoxRows(box) {
  const out = [];
  const p = (box && box.playerByGameStats) || {};
  for (const side of ['awayTeam', 'homeTeam']) {
    const team = box[side] && box[side].abbrev;
    const t = p[side] || {};
    for (const r of [...(t.forwards || []), ...(t.defense || [])]) {
      out.push({ id: r.playerId, name: r.name && r.name.default, team, pos: r.position, toi: toiMin(r.toi),
        g: num(r.goals), a: num(r.assists), pts: num(r.points), sog: num(r.sog), blk: num(r.blockedShots),
        hits: num(r.hits), pim: num(r.pim), ppg: num(r.powerPlayGoals) });
    }
    for (const r of (t.goalies || [])) {
      out.push({ id: r.playerId, name: r.name && r.name.default, team, pos: 'G', toi: toiMin(r.toi),
        starter: r.starter === true, sv: num(r.saves), sa: num(r.shotsAgainst), ga: num(r.goalsAgainst), dec: r.decision || null });
    }
  }
  return out;
}

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
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (dq.length) {
      const day = dq.shift();
      const j = await get(`${NHLE}/score/${day}`);
      for (const g of ((j && j.games) || [])) {
        if (g.gameType !== 2 || !['OFF', 'FINAL'].includes(g.gameState)) continue;
        if (g.gameDate !== day) continue;      // the date asked for, nothing else
        games.push({ id: g.id, day, utc: g.startTimeUTC, teams: [g.awayTeam.abbrev, g.homeTeam.abbrev] });
      }
    }
  }));
  const todo = games.filter((g) => !fs.existsSync(path.join(D, g.id + '.json')));
  console.log(`season ${season}: ${games.length} regular-season games, ${todo.length} to fetch`);
  let done = 0, empty = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (todo.length) {
      const g = todo.shift();
      const rows = nhlBoxRows(await get(`${NHLE}/gamecenter/${g.id}/boxscore`));
      if (!rows.length) { empty++; continue; }
      fs.writeFileSync(path.join(D, g.id + '.json'), JSON.stringify({ ...g, rows }));
      if (++done % 200 === 0) console.log(`  ${done} read`);
    }
  }));
  console.log(`season ${season}: ${done} read, ${empty} with no box score`);
}

// ---- report ---------------------------------------------------------------------
// [key, label, who, stat, line kind]. who: 'S' skaters, 'G' starting goalies.
// Every PrizePicks NHL market the box score carries. Time on ice is posted in
// quarter-minutes (25.25 = 25:15), the rest at .5.
const MARKETS = [
  ['sog', 'Shots on goal', 'S', (x) => x.sog, 'half'],
  ['pts', 'Points', 'S', (x) => x.pts, 'half'],
  ['g', 'Goals', 'S', (x) => x.g, 'half'],
  ['a', 'Assists', 'S', (x) => x.a, 'half'],
  ['blk', 'Blocked shots', 'S', (x) => x.blk, 'half'],
  ['hits', 'Hits', 'S', (x) => x.hits, 'half'],
  ['toi', 'Time on ice', 'S', (x) => x.toi, 'quarter'],
  ['sv', 'Goalie saves', 'G', (x) => x.sv, 'half'],
  ['ga', 'Goals against', 'G', (x) => x.ga, 'half'],
];
const BREAK_EVEN = [['5/6-flex', 54.2], ['2-power', 57.7], ['3-flex', 59.1]];
// The 0.5-line markets, and season-to-date per-game rate bands for them.
const FIXED_HALF = ['pts', 'g', 'a'];
const RATE_BANDS = {
  pts: [['<0.4', 0, 0.4], ['0.4-0.6', 0.4, 0.6], ['0.6-0.8', 0.6, 0.8], ['0.8-1.0', 0.8, 1.0], ['1.0+', 1.0, 9]],
  g: [['<0.15', 0, 0.15], ['0.15-0.25', 0.15, 0.25], ['0.25-0.35', 0.25, 0.35], ['0.35-0.5', 0.35, 0.5], ['0.5+', 0.5, 9]],
  a: [['<0.25', 0, 0.25], ['0.25-0.4', 0.25, 0.4], ['0.4-0.55', 0.4, 0.55], ['0.55-0.7', 0.55, 0.7], ['0.7+', 0.7, 9]],
};
const REGULAR = 15;                       // last-10 TOI, minutes: see the .md
const TOI_FLOORS = [0, 12, 15, 18, 21];
const TOI_BANDS = [['<12', 0, 12], ['12-15', 12, 15], ['15-18', 15, 18], ['18-21', 18, 21], ['21+', 21, 99]];
// Line levels for the by-line table: .5 lines one by one, up to a top bucket.
const LINE_BANDS = {
  sog: [0.5, 1.5, 2.5, 3.5, 4.5], pts: [0.5, 1.5], g: [0.5, 1.5], a: [0.5, 1.5], blk: [0.5, 1.5, 2.5, 3.5],
  hits: [0.5, 1.5, 2.5, 3.5, 4.5], ga: [0.5, 1.5, 2.5, 3.5],
};
// Ranges for the lines that are not small counts.
const LINE_RANGES = {
  toi: [['<14', 0, 14], ['14-17', 14, 17], ['17-20', 17, 20], ['20-23', 20, 23], ['23+', 23, 99]],
  sv: [['<21', 0, 21], ['21-23.5', 21, 24], ['24-26.5', 24, 27], ['27-29.5', 27, 30], ['30+', 30, 99]],
};
function lineBands(key) {
  if (LINE_RANGES[key]) return LINE_RANGES[key];
  const c = LINE_BANDS[key];
  return c.map((L, i) => (i === c.length - 1 ? [`${L}+`, L, 999] : [String(L), L, L + 0.01]));
}

function wilson(k, n) {
  if (!n) return [null, null];
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [100 * (c - h), 100 * (c + h)];
}
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

function loadSeason(season) {
  const D = path.join(cache, String(season));
  if (!fs.existsSync(D)) return [];
  const games = fs.readdirSync(D).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(D, f), 'utf8')));
  games.sort((a, b) => (a.utc < b.utc ? -1 : a.utc > b.utc ? 1 : a.id - b.id));
  return games;
}

// Lines, each a list of [line, weight] whose weights sum to 1.
//
// Hockey props are posted at .5 (shots 2.5, points 0.5, saves 26.5), and on
// counts this small a whole-number line is a different bet: the NBA tool's
// "round to the nearest .5, drop the pushes" turns shots 2 into "0-1 vs 3+".
// So the lines here are .5 lines:
//   avg:    the .5 line nearest the last-10 average (floor(avg) + .5). An
//           average that is a whole number sits between two; each gets half.
//   median: the .5 line that splits the last ten closest to five and five --
//           the typical night, where a book sets its number. Equal splits
//           share the weight (saves 24 and 27 in 5th and 6th: 24.5, 25.5, 26.5).
// Time on ice, posted in quarter-minutes, takes the average and the median of
// ten (5th and 6th) to the nearest .25; a push there is a 15-second tie.
function halfLinesAvg(vals) {
  const avg = mean(vals);
  if (Math.abs(avg - Math.round(avg)) < 1e-9) {
    const k = Math.round(avg);
    return k >= 1 ? [[k - 0.5, 0.5], [k + 0.5, 0.5]] : [[0.5, 1]];
  }
  return [[Math.floor(avg) + 0.5, 1]];
}
function halfLinesMedian(vals) {
  const max = Math.max(...vals);
  let best = Infinity, set = [];
  for (let L = 0.5; L <= max + 0.5; L += 1) {
    const d = Math.abs(vals.filter((v) => v < L).length / vals.length - 0.5);
    if (d < best - 1e-9) { best = d; set = [L]; } else if (Math.abs(d - best) < 1e-9) set.push(L);
  }
  return set.map((L) => [L, 1 / set.length]);
}
const q4 = (x) => Math.round(x * 4) / 4;
function median(vals) {
  const s = [...vals].sort((a, b) => a - b), k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
}

// A sample's result at a set of weighted lines: under weight, over weight
// (pushes count for neither), and how much of the last ten sat below the line
// -- what the recent games alone said the under was worth.
function score(actual, lines, recent) {
  let u = 0, o = 0, said = 0;
  for (const [L, w] of lines) {
    if (actual < L) u += w; else if (actual > L) o += w;
    said += w * recent.filter((v) => v < L).length / recent.length;
  }
  return { u, o, said, lines: lines.map(([L, w]) => [L, w, actual < L ? 'u' : actual > L ? 'o' : 'p']) };
}

// One sample per (player-game, market): the player's ten previous games this
// season (skaters: games he dressed and skated; goalies: his starts), the lines
// built from them, and what he did tonight. A game he did not play is no
// sample (PrizePicks voids it) and does not count among his ten. A goalie
// pulled in his start is still a sample: PrizePicks grades what he did.
//
// The same sample also carries:
//   seasonMed: the median .5 line over EVERY earlier game this season (10+),
//     a slower line, nearer how a book that has watched the whole season sets
//     one, so a last-10 hot streak cannot hand the under a free win;
//   nbaAvg / nbaMed: the NBA tool's rounding (nearest .5, whole lines' pushes
//     left out), for comparison with tools/nba-market-backtest.md;
//   fixed05 (goals, assists, points): the result at 0.5 whatever his form,
//     with `rate`, his per-game average over every earlier game this season.
// Players whose last-10 average is under 0.25 get none of the recent-form
// lines, as the NBA tool leaves out lines below 0.5: nobody posts them.
function samples(season) {
  const out = [];
  const hist = new Map();
  for (const g of loadSeason(season)) {
    for (const r of g.rows) {
      const goalie = r.pos === 'G';
      if (goalie ? !r.starter : !(r.toi > 0)) continue;
      const h = hist.get(r.id) || [];
      if (h.length >= 10) {
        const last = h.slice(-10);
        const projToi = mean(last.map((x) => x.toi));
        for (const [key, , who, val, kind] of MARKETS) {
          if ((who === 'G') !== goalie) continue;
          const vals = last.map(val), all = h.map(val).filter((v) => v != null);
          const actual = val(r);
          if (actual == null || vals.some((v) => v == null)) continue;
          const avg = mean(vals);
          const s = { season, key, pos: goalie ? 'G' : r.pos === 'D' ? 'D' : 'F', projToi, avg, rate: mean(all), actual, player: r.name };
          // Goals, assists and points sit at 0.5 for nearly everyone, so the
          // under is "held off the sheet" and the player's rate decides it.
          if (FIXED_HALF.includes(key)) {
            s.fixed05 = score(actual, [[0.5, 1]], vals);
            s.zeroShare = all.filter((v) => v < 0.5).length / all.length;
          }
          out.push(s);
          if (avg < 0.25) continue;
          if (kind === 'quarter') {
            s.avgL = score(actual, [[q4(avg), 1]], vals);
            s.medL = score(actual, [[q4(median(vals)), 1]], vals);
            s.seasonMed = score(actual, [[q4(median(all)), 1]], all);
          } else {
            s.avgL = score(actual, halfLinesAvg(vals), vals);
            s.medL = score(actual, halfLinesMedian(vals), vals);
            s.seasonMed = all.length >= 10 ? score(actual, halfLinesMedian(all), all) : null;
            const nl = Math.round(avg * 2) / 2;
            s.nbaAvg = nl >= 0.5 ? score(actual, [[nl, 1]], vals) : null;
            const nm = Math.round(median(vals) * 2) / 2;
            s.nbaMed = nm >= 0.5 ? score(actual, [[nm, 1]], vals) : null;
          }
        }
      }
      h.push(r);
      hist.set(r.id, h);
    }
  }
  return out;
}

// Under rate over samples. With [lo, hi), only the part of each sample's line
// weight that falls in that line range counts (a split sample is half in each).
function cell(list, f = 'medL', lo = -Infinity, hi = Infinity) {
  let u = 0, o = 0, said = 0, w = 0, rows = 0;
  for (const s of list) {
    const c = s[f];
    if (!c) continue;
    let cu = 0, co = 0, cw = 0;
    for (const [L, lw, res] of c.lines) {
      if (L < lo || L >= hi) continue;
      cw += lw;
      if (res === 'u') cu += lw; else if (res === 'o') co += lw;
    }
    if (!cw) continue;
    rows += cw;
    u += cu; o += co;
    if (cu + co > 0 && cw === 1) { said += c.said; w += 1; }
  }
  const n = u + o;
  const [ciLo, ciHi] = wilson(u, n);
  return { rows, n: Math.round(n), under: n ? r1(100 * u / n) : null, lo: r1(ciLo), hi: r1(ciHi),
    push: rows ? r1(100 * (rows - n) / rows) : null, said: w ? r1(100 * said / w) : null };
}

function report() {
  const seasons = rest.length && !rest[0].endsWith('.json') ? rest.filter((x) => !x.endsWith('.json')) : ['2025', '2026'];
  const outJson = rest.find((x) => x.endsWith('.json'));
  const all = seasons.flatMap((s) => samples(s));
  const games = Object.fromEntries(seasons.map((s) => [s, loadSeason(s).length]));
  const isReg = (s) => s.pos === 'G' || s.projToi >= REGULAR;
  const res = { built: new Date().toISOString(), seasons, games, regularToi: REGULAR, markets: {} };
  for (const [key, label, who] of MARKETS) {
    const m = all.filter((s) => s.key === key);
    const reg = m.filter(isReg);
    const byLineOf = (list, f) => Object.fromEntries(lineBands(key).map(([k, lo, hi]) => [k, cell(list, f, lo, hi)]));
    const byLine = byLineOf(reg, 'medL');
    res.markets[key] = {
      label, who,
      regular: { avg: cell(reg, 'avgL'), median: cell(reg, 'medL'), seasonMedian: cell(reg, 'seasonMed'), nbaAvg: cell(reg, 'nbaAvg'), nbaMedian: cell(reg, 'nbaMed') },
      everyone: { avg: cell(m, 'avgL'), median: cell(m, 'medL') },
      bySeason: Object.fromEntries(seasons.map((se) => [se, { avg: cell(reg.filter((x) => x.season === se), 'avgL'), median: cell(reg.filter((x) => x.season === se), 'medL') }])),
      byLine,
      // The same split at the season-long line: what is left once a hot or
      // cold last ten cannot set the number.
      byLineSeason: byLineOf(reg, 'seasonMed'),
      byPos: who === 'S' ? Object.fromEntries(['F', 'D'].map((p) => {
        const b = reg.filter((s) => s.pos === p);
        return [p, { avg: cell(b, 'avgL'), median: cell(b, 'medL'), seasonMedian: cell(b, 'seasonMed'), byLine: byLineOf(b, 'medL') }];
      })) : null,
      byToiFloor: who === 'S' ? Object.fromEntries(TOI_FLOORS.map((t) => [t, { avg: cell(m.filter((s) => s.projToi >= t), 'avgL'), median: cell(m.filter((s) => s.projToi >= t), 'medL') }])) : null,
      byToiBand: who === 'S' ? Object.fromEntries(TOI_BANDS.map(([k, lo, hi]) => [k, cell(m.filter((s) => s.projToi >= lo && s.projToi < hi), 'medL')])) : null,
      // Under 0.5 by his season-to-date rate, against how often he had been
      // held off the sheet in those earlier games (what the season said).
      fixed05: RATE_BANDS[key] ? cell(reg, 'fixed05') : null,
      byRate: RATE_BANDS[key] ? Object.fromEntries(RATE_BANDS[key].map(([k, lo, hi]) => {
        const b = reg.filter((s) => s.rate >= lo && s.rate < hi);
        return [k, { ...cell(b, 'fixed05'), seasonSaid: b.length ? r1(100 * mean(b.map((s) => s.zeroShare))) : null }];
      })) : null,
    };
  }
  // How much of the league each TOI floor keeps: skater-games with ten earlier games.
  const sk = all.filter((s) => s.key === 'toi');
  res.toiShare = Object.fromEntries(TOI_FLOORS.map((t) => [t, {
    F: r1(100 * sk.filter((s) => s.pos === 'F' && s.projToi >= t).length / sk.filter((s) => s.pos === 'F').length),
    D: r1(100 * sk.filter((s) => s.pos === 'D' && s.projToi >= t).length / sk.filter((s) => s.pos === 'D').length),
    perTeamGame: r1(sk.filter((s) => s.projToi >= t).length / (2 * Object.values(games).reduce((a, b) => a + b, 0))),
  }]));
  if (outJson) fs.writeFileSync(outJson, JSON.stringify(res, null, 1));

  const pct = (c) => (c && c.under != null ? `${c.under.toFixed(1)}%` : '–');
  const ci = (c) => (c && c.lo != null ? `${c.lo}–${c.hi}` : '–');
  const clears = (c) => BREAK_EVEN.filter(([, be]) => c.lo != null && c.lo >= be).map(([k]) => k).join(', ') || '–';
  const n = (c) => c.n.toLocaleString('en-US');
  console.log(`games: ${JSON.stringify(games)}; regular skater = ${REGULAR}+ min last-10 TOI; goalies = starters\n`);
  console.log('| market | samples | under @ avg line | 95% CI | under @ median line | 95% CI | last 10 said | clears (CI low, median) | season-median line | NBA rounding avg / median |');
  console.log('| --- | ---: | ---: | --- | ---: | --- | ---: | --- | ---: | ---: |');
  const order = Object.entries(res.markets).sort((a, b) => b[1].regular.median.under - a[1].regular.median.under);
  for (const [, m] of order) {
    const g = m.regular;
    console.log(`| ${m.label} | ${n(g.median)} | ${pct(g.avg)} | ${ci(g.avg)} | ${pct(g.median)} | ${ci(g.median)} | ${g.median.said}% | ${clears(g.median)} | ${pct(g.seasonMedian)} | ${pct(g.nbaAvg)} / ${pct(g.nbaMedian)} |`);
  }
  console.log('\nby season (regular; avg line / median line):');
  for (const [, m] of order) console.log(`  ${m.label.padEnd(15)} ` + Object.entries(m.bySeason).map(([k, c]) => `${k}: ${pct(c.avg)} / ${pct(c.median)}`).join(' · '));
  console.log('\nby median line level (regular; under, samples):');
  for (const [, m] of order) console.log(`  ${m.label.padEnd(15)} ` + Object.entries(m.byLine).map(([k, c]) => `${k}: ${pct(c)} (${c.n})`).join(' · '));
  console.log('\nby season-median line level (regular; under, samples, the season said):');
  for (const [, m] of order) console.log(`  ${m.label.padEnd(15)} ` + Object.entries(m.byLineSeason).map(([k, c]) => `${k}: ${pct(c)} (${c.n}, ${c.said == null ? '–' : c.said + '%'})`).join(' · '));
  console.log('\nby TOI floor (skaters; avg line / median line, samples):');
  for (const [, m] of order) {
    if (!m.byToiFloor) continue;
    console.log(`  ${m.label.padEnd(15)} ` + Object.entries(m.byToiFloor).map(([k, c]) => `${k}+: ${pct(c.avg)} / ${pct(c.median)} (${c.median.n})`).join(' · '));
  }
  console.log('\nby last-10 TOI band (skaters; median line):');
  for (const [, m] of order) {
    if (!m.byToiBand) continue;
    console.log(`  ${m.label.padEnd(15)} ` + Object.entries(m.byToiBand).map(([k, c]) => `${k}: ${pct(c)} (${c.n})`).join(' · '));
  }
  console.log('\nby position (regular; avg / median / season-median line; then by median line level):');
  for (const [, m] of order) {
    if (!m.byPos) continue;
    console.log(`  ${m.label.padEnd(15)} ` + Object.entries(m.byPos).map(([k, c]) => `${k}: ${pct(c.avg)} / ${pct(c.median)} / ${pct(c.seasonMedian)} (${c.median.n})`).join(' · '));
    for (const [k, c] of Object.entries(m.byPos)) console.log(`  ${''.padEnd(15)}   ${k} ` + Object.entries(c.byLine).map(([l, x]) => `${l}: ${pct(x)} (${x.n})`).join(' · '));
  }
  console.log('\nunder 0.5 by season-to-date per-game rate (regular; under, samples, season said):');
  for (const [, m] of order) {
    if (!m.byRate) continue;
    console.log(`  ${m.label.padEnd(15)} all: ${pct(m.fixed05)} (${m.fixed05.n}) · `
      + Object.entries(m.byRate).map(([k, c]) => `${k}: ${pct(c)} (${c.n}, ${c.seasonSaid}%)`).join(' · '));
  }
  console.log('\nshare of skater-games kept by each TOI floor (with 10 earlier games):');
  for (const [t, v] of Object.entries(res.toiShare)) console.log(`  ${t}+: forwards ${v.F}%, defence ${v.D}%, ${v.perTeamGame} skaters per team-game`);
}

if (cmd === 'fetch') {
  for (const s of (rest.length ? rest : ['2025', '2026'])) await fetchSeason(Number(s));
} else if (cmd === 'report') report();
else { console.error('unknown command ' + cmd); process.exit(2); }
