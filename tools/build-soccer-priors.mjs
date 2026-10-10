// Soccer player-prop priors: each player's per-start averages from the last
// completed season, and each club's concession rates, for the props the site
// projects (shots, shots on target, passes, tackles, clearances, fouls,
// goalkeeper saves).
//
//   node tools/build-soccer-priors.mjs fetch <espn-slug> <fromYYYYMMDD> <toYYYYMMDD> <cacheDir>
//   node tools/build-soccer-priors.mjs build <cacheDir> <out.json> <slug>[:<season>] ...
//
// fetch reads ESPN for free and caches one file per finished match:
//   - the scoreboard, a day at a time (the soccer scoreboard refuses a range);
//   - each club's match roster from sports.core.api.espn.com, and each player
//     who appeared, his full match statistics. That is ~30 requests a match:
//     passes and tackles exist only per player, not on any match-level feed.
// build turns the cache into soccer-priors.json.
//
// Built 2026-10-10 from 2025-26 Premier League, La Liga, Serie A and
// Bundesliga, and the 2026 MLS season to Oct 9 (MLS is mid-season, so its
// "prior" is this season so far).
import fs from 'node:fs';
import path from 'node:path';

const [cmd, ...args] = process.argv.slice(2);
const UA = { 'user-agent': 'Mozilla/5.0', accept: 'application/json' };
async function get(u, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(u, { headers: UA }); if (r.ok) return await r.json(); if (r.status === 404) return null; } catch (e) { /* retry */ }
    await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
  }
  return null;
}
const num = (cats, cat, name) => {
  const c = (cats || []).find((x) => x.name === cat); const s = c && (c.stats || []).find((x) => x.name === name);
  return s ? Number(s.value) || 0 : 0;
};

async function fetchSeason(slug, from, to, cache) {
  const D = path.join(cache, slug);
  fs.mkdirSync(D, { recursive: true });
  const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const events = new Map();
  const days = [];
  for (let d = new Date(`${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6)}T00:00:00Z`); ymd(d) <= to; d.setUTCDate(d.getUTCDate() + 1)) days.push(ymd(d));
  const dq = [...days];
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (dq.length) {
      const j = await get(`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${dq.shift()}`);
      for (const e of ((j && j.events) || [])) if (e.status && e.status.type && e.status.type.completed) events.set(e.id, e);
    }
  }));
  const todo = [...events.values()].filter((e) => !fs.existsSync(path.join(D, e.id + '.json')));
  console.log(slug, 'finished matches', events.size, 'to fetch', todo.length);
  const one = async (e) => {
    const comp = e.competitions[0];
    const out = { id: e.id, date: e.date, players: [] };
    for (const c of comp.competitors) {
      if (c.homeAway === 'home') { out.home = c.team.abbreviation; out.hs = Number(c.score); } else { out.away = c.team.abbreviation; out.as = Number(c.score); }
    }
    for (const c of comp.competitors) {
      const ro = await get(`https://sports.core.api.espn.com/v2/sports/soccer/leagues/${slug}/events/${e.id}/competitions/${e.id}/competitors/${c.id}/roster`);
      for (const p of ((ro && ro.entries) || [])) {
        const subOn = p.subbedIn && p.subbedIn.didSub, subOff = p.subbedOut && p.subbedOut.didSub;
        if (!p.starter && !subOn) continue;
        const st = p.statistics && p.statistics.$ref ? await get(p.statistics.$ref.replace('http://', 'https://')) : null;
        const cats = st && st.splits && st.splits.categories;
        if (!cats) continue;
        out.players.push({ pid: p.playerId, team: c.team.abbreviation, side: c.homeAway, starter: !!p.starter,
          subOn: !!subOn, subOff: !!subOff, min: num(cats, 'general', 'minutes'),
          shots: num(cats, 'offensive', 'totalShots'), sot: num(cats, 'offensive', 'shotsOnTarget'),
          passes: num(cats, 'offensive', 'totalPasses'), tackles: num(cats, 'defensive', 'totalTackles'),
          clear: num(cats, 'defensive', 'totalClearance'), fouls: num(cats, 'general', 'foulsCommitted'),
          saves: num(cats, 'goalKeeping', 'saves') });
      }
    }
    fs.writeFileSync(path.join(D, e.id + '.json'), JSON.stringify(out));
  };
  const q = [...todo];
  let done = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (q.length) { const e = q.shift(); try { await one(e); } catch (err) { console.log('fail', e.id); } if (++done % 50 === 0) console.log('  ', done, '/', todo.length); }
  }));
}

const STATS = ['shots', 'sot', 'passes', 'tackles', 'clear', 'fouls', 'saves'];
const r2 = (x) => Math.round(x * 100) / 100;
function build(cache, out, specs) {
  const players = {}, teams = {}, leagueAvg = {}, leagues = {};
  for (const spec of specs) {
    const [slug, season] = spec.split(':');
    const D = path.join(cache, slug);
    const matches = fs.readdirSync(D).filter((f) => /^\d+\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(D, f), 'utf8')))
      .sort((a, b) => a.date.localeCompare(b.date));
    leagues[slug] = { season: season || null, matches: matches.length, from: matches[0] && matches[0].date.slice(0, 10), to: matches.length ? matches[matches.length - 1].date.slice(0, 10) : null };
    // A goalkeeper is a role, not a match: one who made no save in a game is still one.
    const gk = new Set();
    for (const m of matches) for (const p of m.players) if (p.saves > 0) gk.add(p.pid);
    const conc = {};   // team -> stat -> [sum of the OTHER side's totals, games]
    for (const m of matches) {
      const tot = {};
      for (const p of m.players) { tot[p.team] = tot[p.team] || {}; for (const s of STATS) tot[p.team][s] = (tot[p.team][s] || 0) + (p[s] || 0); }
      const ts = Object.keys(tot);
      for (const t of ts) {
        const o = ts.find((x) => x !== t);
        conc[t] = conc[t] || {};
        for (const s of STATS) { const c = conc[t][s] || [0, 0]; c[0] += (tot[o] || {})[s] || 0; c[1]++; conc[t][s] = c; }
      }
      for (const p of m.players) {
        const k = String(p.pid);
        const pl = players[k] = players[k] || { lg: slug, tm: p.team, gk: 0, starts: 0, apps: 0, minSum: 0, early: 0, sum: {}, last: '' };
        pl.apps++;
        if (m.date >= pl.last) { pl.last = m.date; pl.lg = slug; pl.tm = p.team; }
        if (gk.has(p.pid)) pl.gk = 1;
        if (!p.starter) continue;
        pl.starts++; pl.minSum += p.min || 0;
        if (p.subOff && p.min < 70) pl.early++;
        for (const s of STATS) pl.sum[s] = (pl.sum[s] || 0) + (p[s] || 0);
      }
    }
    teams[slug] = {};
    const lg = Object.fromEntries(STATS.map((s) => [s, [0, 0]]));
    for (const [t, c] of Object.entries(conc)) {
      teams[slug][t] = { games: c.shots ? c.shots[1] : 0, conc: Object.fromEntries(STATS.map((s) => [s, c[s] ? r2(c[s][0] / c[s][1]) : null])) };
      for (const s of STATS) if (c[s]) { lg[s][0] += c[s][0]; lg[s][1] += c[s][1]; }
    }
    leagueAvg[slug] = Object.fromEntries(STATS.map((s) => [s, lg[s][1] ? r2(lg[s][0] / lg[s][1]) : null]));
  }
  const outP = {};
  for (const [k, pl] of Object.entries(players)) {
    if (pl.starts < 3) continue;
    outP[k] = { lg: pl.lg, tm: pl.tm, gk: pl.gk, starts: pl.starts, min: r2(pl.minSum / pl.starts), early: r2(pl.early / pl.starts),
      ...Object.fromEntries(STATS.map((s) => [s, r2((pl.sum[s] || 0) / pl.starts)])) };
  }
  const doc = { built: new Date().toISOString(), source: 'ESPN per-player match statistics (sports.core.api.espn.com), per start', leagues,
    note: 'Per-start averages; a player is listed with 3+ starts. teams.conc is what a club allowed its opponents per game; leagueAvg is the per-team-game mean.',
    leagueAvg, teams, players: outP };
  fs.writeFileSync(out, JSON.stringify(doc));
  console.log('players', Object.keys(outP).length, 'of', Object.keys(players).length, '| leagues', Object.entries(leagues).map(([k, v]) => `${k} ${v.matches}`).join(', '), '|', (fs.statSync(out).size / 1024).toFixed(0) + 'KB');
}

if (cmd === 'fetch') await fetchSeason(args[0], args[1], args[2], args[3]);
else if (cmd === 'build') build(args[0], args[1], args.slice(2));
else console.log('usage: fetch <slug> <from> <to> <cacheDir> | build <cacheDir> <out.json> <slug>[:season] ...');
