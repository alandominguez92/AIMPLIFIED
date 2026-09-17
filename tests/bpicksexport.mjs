// /api/bpicks-export returns graded batter rows for offline replay.
//
// What matters is narrow: it filters in SQL to one market and one model version
// (so it never ships the whole table), returns only graded rows, rejects a market
// it does not know, and is cached per query string — without that, an export of
// hrr and an export of tb would share one edge-cache entry and serve each other.
import fs from 'node:fs';
import path from 'node:path';
const BOARD = path.join(import.meta.dirname, '..');

const edge = new Map();
globalThis.caches = {
  default: {
    match: async (req) => { const h = edge.get(typeof req === 'string' ? req : req.url); return h ? h.clone() : undefined; },
    put: async (req, res) => { edge.set(typeof req === 'string' ? req : req.url, res.clone()); },
  },
};

const TABLE = [
  { date: '2026-09-10', market: 'hrr', model_ver: 'sharp-shin-nb-evgate', result: 'win', line: 1.5, side: 'Under', price: -125, proj: 1.4, model_over: 44.1, entry_over: 0.46, tier: 'play', fair_src: 'sharp', actual: 1 },
  { date: '2026-09-10', market: 'hrr', model_ver: 'sharp-shin-nb-evgate', result: null, line: 1.5, side: 'Under', price: -125, proj: 1.4, model_over: 44.1, entry_over: 0.46, tier: 'play', fair_src: 'sharp', actual: null },
  { date: '2026-09-10', market: 'tb', model_ver: 'sharp-shin-nb-evgate', result: 'loss', line: 1.5, side: 'Under', price: -150, proj: 1.6, model_over: 38, entry_over: 0.39, tier: 'play', fair_src: 'sharp', actual: 3 },
  { date: '2026-08-01', market: 'hrr', model_ver: 'sharp-shin-nb', result: 'loss', line: 1.5, side: 'Under', price: -120, proj: 1.3, model_over: 42, entry_over: 0.45, tier: '3', fair_src: 'sharp', actual: 2 },
];
const seen = [];
const db = {
  prepare: (sql) => {
    const st = {
      args: [],
      bind: (...a) => { st.args = a; return st; },
      run: async () => ({ meta: { changes: 0 } }),
      first: async () => null,
      all: async () => {
        if (!/FROM bpicks/i.test(sql)) return { results: [] };
        seen.push({ sql, args: st.args });
        const [market, ver] = st.args;
        return { results: TABLE.filter((r) => r.market === market && r.model_ver === ver && (r.result === 'win' || r.result === 'loss')) };
      },
    };
    return st;
  },
  batch: async () => [],
};

const src = fs.readFileSync(BOARD + '/worker.js', 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const get = async (q) => (await mod.default.fetch(new Request('https://x/api/bpicks-export' + q), { DB: db }, { waitUntil() {} })).json();

let fail = 0;
const ok = (c, m) => { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fail++; };

const hrr = await get('?market=hrr&ver=sharp-shin-nb-evgate');
ok(hrr.n === 1 && hrr.rows.length === 1, `one graded hrr row in that version (${hrr.n})`);
ok(Array.isArray(hrr.cols) && hrr.rows[0].length === hrr.cols.length, 'rows are positional against `cols`');
const at = (row, c) => row[hrr.cols.indexOf(c)];
ok(at(hrr.rows[0], 'proj') === 1.4 && at(hrr.rows[0], 'price') === -125 && at(hrr.rows[0], 'result') === 'win',
  'carries what a replay needs: projection, price, result');
ok(hrr.cols.includes('game_id') && hrr.cols.includes('team') && hrr.cols.includes('player_id'),
  'and the keys a replay needs to join outside data (game, team, player)');
ok(hrr.dispersion > 1 && hrr.shrink > 0 && hrr.evGate != null && hrr.calibrationInForce != null,
  'and the constants the rows were priced under');
ok(seen.some((q) => /market = \?/.test(q.sql) && /model_ver = \?/.test(q.sql) && /result IN/.test(q.sql)),
  'filtered in SQL, not after reading the whole table');

const tb = await get('?market=tb&ver=sharp-shin-nb-evgate');
ok(tb.market === 'tb' && tb.n === 1, `a tb export is not served the hrr body from cache (${tb.market}, n=${tb.n})`);

const bad = await get('?market=everything');
ok(!!bad.error, `an unknown market is refused (${bad.error})`);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
