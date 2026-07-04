// Cloudflare Worker entrypoint.
// Serves the static site via the ASSETS binding and proxies real data on /api/*:
//   /api/scores  -> The Odds API — live MLB scores        (needs ODDS_API_KEY)
//   /api/odds    -> The Odds API — MLB moneyline + totals  (needs ODDS_API_KEY)
//   /api/hitters -> MLB StatsAPI — season hitting leaders  (no key required)
// Secrets stay server-side; the browser only ever sees shaped JSON.

const ODDS = 'https://api.the-odds-api.com/v4/sports/baseball_mlb';
const STATS = 'https://statsapi.mlb.com/api/v1';

export default {
  async fetch(request, env) {
    const p = new URL(request.url).pathname;

    if (p === '/api/odds' || p === '/api/scores' || p === '/api/hitters') {
      if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

      if (p === '/api/hitters') return hitters();

      const key = env.ODDS_API_KEY;
      if (!key) return err('ODDS_API_KEY is not configured', 500);
      const upstream = p === '/api/odds'
        ? `${ODDS}/odds?apiKey=${key}&regions=us&markets=h2h,totals&oddsFormat=american&dateFormat=iso`
        : `${ODDS}/scores?apiKey=${key}&daysFrom=1&dateFormat=iso`;
      return proxy(upstream);
    }

    // Everything else: serve the static site.
    return env.ASSETS.fetch(request);
  },
};

// -------------------------------------------------------------------------
// /api/hitters — real season hitting leaders (by OPS) from MLB StatsAPI.
// Shaped to match what the Hottest Hitters cards expect. Returns [] on any
// upstream trouble so the page falls back to its built-in sample data.
// -------------------------------------------------------------------------
async function hitters() {
  const season = new Date().getUTCFullYear();
  const api = `${STATS}/stats?stats=season&group=hitting&gameType=R`
    + `&season=${season}&sportId=1&playerPool=Qualified&limit=300`;

  let r;
  try {
    r = await fetch(api, { headers: { accept: 'application/json' } });
  } catch (e) {
    return cors(json([], 30)); // network trouble -> let the page use mock data
  }
  if (!r.ok) return cors(json([], 30));

  let data;
  try { data = await r.json(); } catch (e) { return cors(json([], 30)); }

  const splits = (data.stats && data.stats[0] && data.stats[0].splits) || [];
  const rows = splits
    .map((s) => {
      const st = s.stat || {};
      return {
        name: shortName((s.player || {}).fullName),
        team: teamAbbr(s.team),
        ops: toNum(st.ops),
        pa: toNum(st.plateAppearances),
        statVal: avg3(st.ops),
        statLabel: 'OPS · season',
        streak: avg3(st.avg) + ' AVG',
        hrs: typeof st.homeRuns === 'number' ? st.homeRuns : toNum(st.homeRuns),
      };
    })
    .filter((x) => x.name && x.ops > 0 && x.pa >= 150)
    .sort((a, b) => b.ops - a.ops)
    .slice(0, 10);

  return cors(json(rows, 300)); // cache 5 min — season stats move slowly
}

function shortName(full) {
  if (!full) return '';
  const parts = String(full).trim().split(/\s+/);
  if (parts.length < 2) return String(full);
  return parts[0][0] + '. ' + parts.slice(1).join(' ');
}
function toNum(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
function avg3(v) {
  if (v === undefined || v === null || v === '') return '—';
  let s = String(v);
  if (s.startsWith('0.')) s = s.slice(1);   // 0.312 -> .312
  return s;
}
function teamAbbr(team) {
  if (!team) return '';
  if (team.abbreviation) return team.abbreviation;
  return TEAM_ABBR_BY_NAME[team.name]
    || String(team.name || '').split(' ').pop().slice(0, 3).toUpperCase();
}
const TEAM_ABBR_BY_NAME = {
  'Arizona Diamondbacks': 'ARI', 'Atlanta Braves': 'ATL', 'Baltimore Orioles': 'BAL',
  'Boston Red Sox': 'BOS', 'Chicago Cubs': 'CHC', 'Chicago White Sox': 'CWS',
  'Cincinnati Reds': 'CIN', 'Cleveland Guardians': 'CLE', 'Colorado Rockies': 'COL',
  'Detroit Tigers': 'DET', 'Houston Astros': 'HOU', 'Kansas City Royals': 'KC',
  'Los Angeles Angels': 'LAA', 'Los Angeles Dodgers': 'LAD', 'Miami Marlins': 'MIA',
  'Milwaukee Brewers': 'MIL', 'Minnesota Twins': 'MIN', 'New York Mets': 'NYM',
  'New York Yankees': 'NYY', 'Oakland Athletics': 'ATH', 'Athletics': 'ATH',
  'Philadelphia Phillies': 'PHI', 'Pittsburgh Pirates': 'PIT', 'San Diego Padres': 'SD',
  'San Francisco Giants': 'SF', 'Seattle Mariners': 'SEA', 'St. Louis Cardinals': 'STL',
  'Tampa Bay Rays': 'TB', 'Texas Rangers': 'TEX', 'Toronto Blue Jays': 'TOR',
  'Washington Nationals': 'WSH',
};

// -------------------------------------------------------------------------
// Shared helpers
// -------------------------------------------------------------------------
async function proxy(upstream) {
  let r;
  try {
    r = await fetch(upstream, { headers: { accept: 'application/json' } });
  } catch (e) {
    return err('upstream fetch failed: ' + e, 502);
  }
  const body = await r.text();
  return cors(new Response(body, {
    status: r.status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=30',
      'x-requests-remaining': r.headers.get('x-requests-remaining') || '',
      'x-requests-used': r.headers.get('x-requests-used') || '',
    },
  }));
}

function json(obj, maxAge) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${maxAge || 30}` },
  });
}
function err(message, status) {
  return cors(new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}
function cors(resp) {
  resp.headers.set('access-control-allow-origin', '*');
  resp.headers.set('access-control-allow-methods', 'GET,OPTIONS');
  resp.headers.set('access-control-expose-headers', 'x-requests-remaining,x-requests-used');
  return resp;
}
