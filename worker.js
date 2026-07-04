// Cloudflare Worker entrypoint.
// Serves the static site through the ASSETS binding and proxies The Odds API
// on /api/* so ODDS_API_KEY never reaches the browser. Same origin for both,
// so the page's "same-origin" mode works with no CORS setup.

const BASE = 'https://api.the-odds-api.com/v4/sports/baseball_mlb';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/odds' || url.pathname === '/api/scores') {
      if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
      const key = env.ODDS_API_KEY;
      if (!key) return err('ODDS_API_KEY is not configured', 500);
      const upstream = url.pathname === '/api/odds'
        ? `${BASE}/odds?apiKey=${key}&regions=us&markets=h2h,totals&oddsFormat=american&dateFormat=iso`
        : `${BASE}/scores?apiKey=${key}&daysFrom=1&dateFormat=iso`;
      return proxy(upstream);
    }

    // Everything else: serve the static site.
    return env.ASSETS.fetch(request);
  },
};

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
      'cache-control': 'public, max-age=30', // respect the monthly credit quota
      'x-requests-remaining': r.headers.get('x-requests-remaining') || '',
      'x-requests-used': r.headers.get('x-requests-used') || '',
    },
  }));
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
