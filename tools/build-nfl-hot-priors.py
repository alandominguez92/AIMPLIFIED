"""Build nfl-hot-priors.json: every NFL player's per-game passing, rushing and
receiving numbers from the last completed regular season, by ESPN id, the id
the box scores use.

The Hot players section on the NFL tab holds a player with 5 to 9 games against
these (see NFL_HOT_MARKETS in worker.js). A season is 17 games, so that is most
of it. (The yardage projections' nfl-priors-2025.json, removed 2026-11-08, was
by the other id, and had no passing.)

Source, free: site.web.api.espn.com .../football/nfl/statistics/byathlete
(season=2025 is the 2025 season; seasontype=2 is the regular season). Each list
is by category and carries a player's whole line, so a player on two is the same.

Run from the repo root:
    python tools/build-nfl-hot-priors.py
    python tools/build-nfl-hot-priors.py --season 2025 --out nfl-hot-priors.json
"""
import argparse, json, sys, time, urllib.request, datetime

UA = {'User-Agent': 'Mozilla/5.0 (aimplified nfl priors builder)', 'Accept': 'application/json'}


def get(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                return json.load(r)
        except Exception:  # transient ESPN hiccups
            if i == tries - 1:
                raise
            time.sleep(1.5 * (i + 1))


def num(s):
    try:
        return float(str(s).replace(',', ''))
    except ValueError:
        return 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--season', type=int, default=2025)
    ap.add_argument('--out', default='nfl-hot-priors.json')
    a = ap.parse_args()
    base = ('https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/statistics/byathlete'
            f'?region=us&lang=en&contentorigin=espn&isqualified=false&limit=100&season={a.season}&seasontype=2')
    players = {}
    for cat in ('passing', 'rushing', 'receiving'):
        q = f'{base}&category=offense%3A{cat}&sort={cat}.{cat}Yards%3Adesc'
        first = get(q + '&page=1')
        names = {c['name']: c.get('names') or [] for c in first.get('categories', [])}
        pages = (first.get('pagination') or {}).get('pages', 1)
        rows = list(first.get('athletes', []))
        for p in range(2, pages + 1):
            rows += get(f'{q}&page={p}').get('athletes', [])
            time.sleep(0.1)

        def stat(x, c, n):
            for k in x.get('categories', []):
                if k.get('name') == c and n in names.get(c, []):
                    vals = k.get('totals') or []
                    i = names[c].index(n)
                    return num(vals[i]) if i < len(vals) else 0.0
            return 0.0
        for x in rows:
            ath = x.get('athlete') or {}
            pid = str(ath.get('id') or '')
            g = stat(x, 'general', 'gamesPlayed')
            if not pid or not g or pid in players:
                continue
            per = lambda c, n: round(stat(x, c, n) / g, 2)
            players[pid] = {
                'n': ath.get('displayName'), 'tm': ath.get('teamShortName'), 'pos': (ath.get('position') or {}).get('abbreviation'), 'g': int(g),
                'pass_att': per('passing', 'passingAttempts'), 'pass_yds': per('passing', 'passingYards'), 'pass_td': per('passing', 'passingTouchdowns'),
                'car': per('rushing', 'rushingAttempts'), 'rush_yds': per('rushing', 'rushingYards'),
                'tgt': per('receiving', 'receivingTargets'), 'rec': per('receiving', 'receptions'), 'rec_yds': per('receiving', 'receivingYards'),
            }
    doc = {
        'season': a.season,
        'built': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'ESPN season totals (regular season), per game played, by ESPN id',
        'players': players,
    }
    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump(doc, f, separators=(',', ':'), ensure_ascii=False)
    print(len(players), 'players ->', a.out)


if __name__ == '__main__':
    sys.exit(main())
