"""Build nba-priors.json: every NBA player's per-game threes, assists and
rebounds from the last completed regular season, and the team he is on now.

The NBA PrizePicks log projects each leg from a player's recent games blended
with this prior, weighted toward the recent games as they accumulate (see
NBA_PRIOR_K in worker.js). On opening night there are no recent games, so the
prior IS the projection; by mid-November it is a small share of it.

Sources, both free and both ESPN:
  - season averages: site.web.api.espn.com .../statistics/byathlete
    (season=2026 is the 2025-26 season; seasontype=2 is the regular season)
  - current rosters: site.api.espn.com .../teams/{id}/roster, one per team, so
    a player traded or signed in the summer is filed under his new club

Run from the repo root:
    python tools/build-nba-priors.py            # writes nba-priors.json
    python tools/build-nba-priors.py --season 2026 --out nba-priors.json
"""
import argparse, json, sys, time, urllib.request, datetime

UA = {'User-Agent': 'Mozilla/5.0 (aimplified nba priors builder)', 'Accept': 'application/json'}


def get(url, tries=3):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                return json.load(r)
        except Exception as e:  # transient ESPN hiccups
            if i == tries - 1:
                raise
            time.sleep(1.5 * (i + 1))


def season_averages(season):
    base = ('https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics/byathlete'
            f'?season={season}&seasontype=2&limit=200')
    first = get(base + '&page=1')
    cats = {c['name']: c.get('names') or [] for c in first.get('categories', [])}
    pages = (first.get('pagination') or {}).get('pages', 1)
    rows = list(first.get('athletes', []))
    for p in range(2, pages + 1):
        rows += get(base + f'&page={p}').get('athletes', [])

    def stat(a, cat, name):
        names = cats.get(cat, [])
        for c in a.get('categories', []):
            if c.get('name') != cat:
                continue
            vals = c.get('totals') or c.get('values') or []
            if name in names:
                i = names.index(name)
                try:
                    return float(str(vals[i]).replace(',', ''))
                except (ValueError, IndexError):
                    return None
        return None

    out = {}
    for a in rows:
        ath = a.get('athlete') or {}
        aid = str(ath.get('id') or '')
        if not aid:
            continue
        gp = stat(a, 'general', 'gamesPlayed')
        out[aid] = {
            'n': ath.get('displayName'),
            'tm25': ath.get('teamShortName') or None,
            'gp': int(gp) if gp is not None else 0,
            'min': stat(a, 'general', 'avgMinutes'),
            'threes': stat(a, 'offensive', 'avgThreePointFieldGoalsMade'),
            'ast': stat(a, 'offensive', 'avgAssists'),
            'reb': stat(a, 'general', 'avgRebounds'),
        }
    return out


def current_teams():
    teams = get('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams')
    lst = teams['sports'][0]['leagues'][0]['teams']
    on = {}
    for t in lst:
        team = t['team']
        abbr = team.get('abbreviation')
        ro = get(f"https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/{team['id']}/roster")
        for ath in ro.get('athletes', []):
            # Some responses group athletes by position; flatten either shape.
            items = ath.get('items') if isinstance(ath, dict) and 'items' in ath else [ath]
            for it in items:
                if it.get('id'):
                    on[str(it['id'])] = {'tm': abbr, 'n': it.get('displayName')}
        time.sleep(0.2)
    return on


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--season', type=int, default=2026, help='ESPN season year (2026 = 2025-26)')
    ap.add_argument('--out', default='nba-priors.json')
    a = ap.parse_args()

    avgs = season_averages(a.season)
    rosters = current_teams()
    players = {}
    for aid, p in avgs.items():
        cur = rosters.get(aid)
        players[aid] = {**p, 'tm': cur['tm'] if cur else None}
    # Players on a roster now with no line last season (rookies, returners):
    # listed with no averages, so the log knows them and projects nothing yet.
    for aid, cur in rosters.items():
        if aid not in players:
            players[aid] = {'n': cur['n'], 'tm': cur['tm'], 'tm25': None, 'gp': 0, 'min': None, 'threes': None, 'ast': None, 'reb': None}

    doc = {
        'season': f'{a.season - 1}-{str(a.season)[2:]}',
        'built': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'source': 'ESPN season averages (regular season) + current ESPN rosters',
        'counts': {'players': len(players), 'withAverages': sum(1 for p in players.values() if p['gp']),
                   'onARosterNow': sum(1 for p in players.values() if p['tm'])},
        'players': players,
    }
    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump(doc, f, separators=(',', ':'))
    print(json.dumps(doc['counts']), '->', a.out)


if __name__ == '__main__':
    sys.exit(main())
