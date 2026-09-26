"""Build nfl-model-priors.json from nflverse data.

The Aug 15 build that produced the first file was not kept. Its definitions were
recovered on 2026-09-26 by reproducing it exactly from raw 2025 play-by-play
(Trey McBride, Kyle Pitts, Bijan Robinson and Puka Nacua to the last decimal):

  team pass plays = the team's pass == 1 plays in every REG week the player was
                    on its weekly roster (inactive weeks included: a share is a
                    per-week expectation, so a week he sat counts against it)
  team rush plays = the same with rush == 1
  rp       = pass plays he was on the field for / team pass plays
  recShare = receptions / team pass plays        ypr = receiving yards / rec
  carShare = carries / team rush plays           ypc = rushing yards / carries
  g        = games he was on the field

2026 adds current-season reps. nflverse has no 2026 participation file, so the
2026 part of rp comes from PFR offensive snap share, scaled by a factor fitted
on 2025 where both exist.

Blending (the w25 weight was chosen by backtest; see --backtest):
  same club both seasons  -> 2025 counts x w25 pooled with 2026 counts
  new club, or a rookie   -> role (shares, rp) from 2026 alone, and only with
                             MIN_NEW_GAMES games for the new club; efficiency
                             (ypr, ypc) still pools with 2025, because yards per
                             catch travels with a player and his role does not

Usage:
  python tools/build-nfl-priors.py --data DIR                 # write the file
  python tools/build-nfl-priors.py --data DIR --backtest      # weight check
Files in DIR (nflverse-data releases): play_by_play_{2025,2026}.csv.gz,
pbp_participation_2025.csv, roster_weekly_{2025,2026}.csv,
snap_counts_{2025,2026}.csv
"""
import argparse, collections, csv, gzip, io, json, math, os, datetime

POS = {'WR', 'TE', 'RB', 'FB'}
TEAM_FIX = {'AZ': 'ARI'}                 # the board writes ARI; one source wrote AZ
MIN_NEW_GAMES = 3               # a new club needs three games of reps; two was unvalidated (Sep 26)
LEAGUE_KEYS = ('yprCohort', 'ypcCohort', 'playsPerTeamGame', 'passRate')


def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def team(t):
    return TEAM_FIX.get(t, t)


def load_pbp(path, max_week=None):
    plays = []
    for r in csv.DictReader(io.TextIOWrapper(gzip.open(path), encoding='utf-8')):
        if r['season_type'] != 'REG' or not r['posteam']:
            continue
        wk = int(r['week'])
        if max_week is not None and wk > max_week:
            continue
        plays.append({
            'gid': r['game_id'], 'pid': r['play_id'], 'wk': wk, 'tm': team(r['posteam']),
            'pass': r['pass'] == '1', 'rush': r['rush'] == '1',
            'cp': r['complete_pass'] == '1', 'rec': r['receiver_player_id'], 'recyd': num(r['receiving_yards']),
            'ra': r['rush_attempt'] == '1', 'rusher': r['rusher_player_id'], 'rushyd': num(r['rushing_yards']),
        })
    return plays


def load_rosters(path, max_week=None):
    """(gsis, week) -> team, plus the latest name/position/pfr id per player."""
    wk_team, info = {}, {}
    for r in csv.DictReader(open(path, encoding='utf-8')):
        if r.get('game_type', 'REG') != 'REG' or not r.get('gsis_id'):
            continue
        wk = int(r['week'])
        if max_week is not None and wk > max_week:
            continue
        wk_team[(r['gsis_id'], wk)] = team(r['team'])
        prev = info.get(r['gsis_id'])
        if not prev or wk >= prev['wk']:
            info[r['gsis_id']] = {'wk': wk, 'n': r['full_name'], 'pos': r['position'], 'tm': team(r['team']),
                                  'pfr': r.get('pfr_id') or ''}
    return wk_team, info


def load_snaps(path, max_week=None):
    """(pfr_id, week) -> offense snap share."""
    out = {}
    for r in csv.DictReader(open(path, encoding='utf-8')):
        if r.get('game_type', 'REG') != 'REG':
            continue
        wk = int(r['week'])
        if max_week is not None and wk > max_week:
            continue
        pct = num(r.get('offense_pct'))
        if pct > 0:
            out[(r['pfr_player_id'], wk)] = pct
    return out


def season_agg(plays, wk_team, info, onfield=None, snaps=None, snap_k=1.0):
    """Per player: the counts every prior is a ratio of."""
    tp, tr = collections.Counter(), collections.Counter()
    for p in plays:
        if p['pass']:
            tp[(p['tm'], p['wk'])] += 1
        if p['rush']:
            tr[(p['tm'], p['wk'])] += 1
    agg = collections.defaultdict(lambda: collections.Counter())
    games = collections.defaultdict(set)
    for (gsis, wk), tm in wk_team.items():
        a = agg[gsis]
        a['tp'] += tp[(tm, wk)]
        a['tr'] += tr[(tm, wk)]
    for p in plays:
        if p['cp'] and p['rec']:
            agg[p['rec']]['rec'] += 1
        if p['rec']:
            agg[p['rec']]['recyd'] += p['recyd']
        if p['ra'] and p['rusher']:
            agg[p['rusher']]['car'] += 1
            agg[p['rusher']]['rushyd'] += p['rushyd']
    if onfield is not None:
        # 2025: real participation.
        for p in plays:
            ids = onfield.get((p['gid'], p['pid']))
            if not ids:
                continue
            for gsis in ids:
                games[gsis].add(p['gid'])
                if p['pass']:
                    agg[gsis]['onf'] += 1
    else:
        # 2026: snap share x the team's pass plays that week, scaled to what
        # participation would have said.
        for (gsis, wk), tm in wk_team.items():
            pfr = (info.get(gsis) or {}).get('pfr')
            pct = snaps.get((pfr, wk)) if pfr else None
            if pct:
                games[gsis].add(wk)
                agg[gsis]['onf'] += min(1.0, pct * snap_k) * tp[(tm, wk)]
    for gsis, s in games.items():
        agg[gsis]['g'] = len(s)
    return agg, tp, tr


def fit_snap_k(agg25, wk_team25, info25, snaps25, plays25):
    """Participation / (snap share x team pass plays), pooled over receivers."""
    tp = collections.Counter()
    for p in plays25:
        if p['pass']:
            tp[(p['tm'], p['wk'])] += 1
    num_, den = 0.0, 0.0
    for (gsis, wk), tm in wk_team25.items():
        i = info25.get(gsis)
        if not i or i['pos'] not in POS:
            continue
        pct = snaps25.get((i['pfr'], wk))
        if pct:
            den += pct * tp[(tm, wk)]
    for gsis, a in agg25.items():
        i = info25.get(gsis)
        if i and i['pos'] in POS:
            num_ += a['onf']
    return num_ / den if den else 1.0


def blend(a25, a26, i25, i26, w25):
    """One player's prior, or None when there is nothing usable."""
    tm25 = i25['tm'] if i25 else None
    tm26 = i26['tm'] if i26 else None
    has25 = a25 is not None and a25['tp'] > 0
    has26 = a26 is not None and a26['tp'] > 0 and a26['g'] > 0
    same = has25 and tm26 is not None and tm25 == tm26
    if same:
        w = w25
        role = {k: w * a25[k] + (a26[k] if has26 else 0) for k in ('tp', 'tr', 'onf', 'rec', 'car')}
        status = 'same-team'
    elif has26 and a26['g'] >= MIN_NEW_GAMES:
        role = {k: a26[k] for k in ('tp', 'tr', 'onf', 'rec', 'car')}
        status = 'moved-current' if has25 else 'rookie-current'
    elif has25:
        # Not eligible yet: written with last season's numbers because the NFL
        # priors page shows movers and absentees, and the status says why the
        # model skips them.
        role = {k: a25[k] for k in ('tp', 'tr', 'onf', 'rec', 'car')}
        status = 'moved' if tm26 else 'rookie-or-absent'
        has26 = False
    else:
        return None, 'rookie-or-absent'
    w = w25 if has25 else 0.0
    eff = {k: (w * a25[k] if has25 else 0) + (a26[k] if has26 else 0) for k in ('rec', 'recyd', 'car', 'rushyd')}
    rec_eff = eff['rec']
    car_eff = eff['car']
    # Sample sizes stay raw. recN and carN feed the volume gates (12 catches,
    # 20 carries), the ypr/ypc shrinkage and the confidence tier, and all three
    # ask how much evidence there is, not how recent it is. Weighting them too
    # dropped half the receivers out of the gate at w25=0.15.
    raw = lambda k: (a25[k] if has25 else 0) + (a26[k] if has26 else 0)
    p = {
        'rp': round(role['onf'] / role['tp'], 4) if role['tp'] else 0,
        'recShare': round(role['rec'] / role['tp'], 5) if role['tp'] else 0,
        'ypr': round(eff['recyd'] / rec_eff, 3) if rec_eff else 0,
        'recN': int(raw('rec')),
        'carShare': round(role['car'] / role['tr'], 5) if role['tr'] else 0,
        'ypc': round(eff['rushyd'] / car_eff, 3) if car_eff else 0,
        'carN': int(raw('car')),
    }
    return p, status


def league_consts(plays):
    games = collections.defaultdict(set)
    for p in plays:
        games[p['tm']].add(p['gid'])
    team_games = sum(len(s) for s in games.values())
    n_pass = sum(1 for p in plays if p['pass'])
    n_rush = sum(1 for p in plays if p['rush'])
    rec = [p for p in plays if p['cp'] and p['rec']]
    car = [p for p in plays if p['ra'] and p['rusher']]
    return {
        'yprCohort': round(sum(p['recyd'] for p in rec) / len(rec), 3),
        'ypcCohort': round(sum(p['rushyd'] for p in car) / len(car), 3),
        'playsPerTeamGame': round((n_pass + n_rush) / team_games, 2),
        'passRate': round(n_pass / (n_pass + n_rush), 4),
    }


def build(D, w25, through26=None):
    plays25 = load_pbp(D + '/play_by_play_2025.csv.gz')
    wk25, info25 = load_rosters(D + '/roster_weekly_2025.csv')
    onfield = collections.defaultdict(set)
    keys = {(p['gid'], p['pid']) for p in plays25}
    for r in csv.DictReader(open(D + '/pbp_participation_2025.csv', encoding='utf-8')):
        k = (r['nflverse_game_id'], r['play_id'])
        if k in keys:
            onfield[k] = {x for x in (r.get('offense_players') or '').split(';') if x}
    agg25, _, _ = season_agg(plays25, wk25, info25, onfield=onfield)
    snaps25 = load_snaps(D + '/snap_counts_2025.csv')
    snap_k = fit_snap_k(agg25, wk25, info25, snaps25, plays25)

    plays26 = load_pbp(D + '/play_by_play_2026.csv.gz', through26)
    last26 = max(p['wk'] for p in plays26)
    wk26, info26 = load_rosters(D + '/roster_weekly_2026.csv', last26)
    snaps26 = load_snaps(D + '/snap_counts_2026.csv', last26)
    agg26, _, _ = season_agg(plays26, wk26, info26, snaps=snaps26, snap_k=snap_k)

    players, statuses = {}, collections.Counter()
    for gsis in set(agg25) | set(agg26):
        i25, i26 = info25.get(gsis), info26.get(gsis)
        pos = (i26 or i25 or {}).get('pos')
        if pos not in POS:
            continue
        a25 = agg25.get(gsis)
        a26 = agg26.get(gsis)
        # Anyone with a touch in either season. The model's own gates (12 catches,
        # 20 carries, rp 0.5) decide who is projected; the priors page shows the
        # thin ones too, bucketed as thin.
        if not ((a25 and (a25['rec'] or a25['car'])) or (a26 and (a26['rec'] or a26['car']))):
            continue
        prior, status = blend(a25, a26, i25, i26, w25)
        statuses[status] += 1
        if prior is None:
            continue
        g25 = a25['g'] if a25 else 0
        g26 = a26['g'] if a26 else 0
        g = g25 + g26 if status == 'same-team' else (g26 if status.endswith('-current') else g25)
        players[gsis] = {
            'n': (i26 or i25)['n'], 'pos': 'RB' if pos == 'FB' else pos,
            'tm': i25['tm'] if i25 else None, 'tm26': (i26 or i25)['tm'], 'status': status, 'g': g, **prior,
        }
    # League constants. Pace and pass rate from both seasons, 2025 weighted the
    # same as the players'. The two cohort rates are pooled over the players in
    # the file, which is how the original defined them: it reproduces its
    # 10.922 yards per catch and 4.372 per carry exactly, where league-wide
    # play-by-play gives 10.897 and 4.347.
    l25, l26 = league_consts(plays25), league_consts(plays26)
    wt = w25 * 17 / (w25 * 17 + last26)
    league = {k: round(wt * l25[k] + (1 - wt) * l26[k], 4) for k in ('playsPerTeamGame', 'passRate')}
    rec_n = sum(p['recN'] for p in players.values() if p['recN'] > 0)
    car_n = sum(p['carN'] for p in players.values() if p['carN'] > 0)
    league['yprCohort'] = round(sum(p['ypr'] * p['recN'] for p in players.values() if p['recN'] > 0) / rec_n, 3)
    league['ypcCohort'] = round(sum(p['ypc'] * p['carN'] for p in players.values() if p['carN'] > 0) / car_n, 3)
    meta = {'builtFrom': '2025+2026', 'through2026Week': last26, 'w25': w25, 'snapK': round(snap_k, 4),
            'built': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'league': league,
            'statusCounts': dict(statuses)}
    return meta, players, (plays26, wk26, info26)


def backtest(D, weights):
    """Build from 2025 + weeks before W, predict week W with the team's actual
    plays, so game script is out of it and only the prior is being judged."""
    out = []
    plays26_all = load_pbp(D + '/play_by_play_2026.csv.gz')
    for W in sorted({p['wk'] for p in plays26_all}):
        if W < 2:
            continue
        target = [p for p in plays26_all if p['wk'] == W]
        tpW, trW = collections.Counter(), collections.Counter()
        act = collections.defaultdict(lambda: collections.Counter())
        for p in target:
            if p['pass']:
                tpW[p['tm']] += 1
            if p['rush']:
                trW[p['tm']] += 1
            if p['rec']:
                act[p['rec']]['recyd'] += p['recyd']
            if p['ra'] and p['rusher']:
                act[p['rusher']]['rushyd'] += p['rushyd']
        wkW, infoW = load_rosters(D + '/roster_weekly_2026.csv', W)
        for label, w, thru in [('2025 only (current file)', None, None)] + [(f'w25={w}', w, W - 1) for w in weights]:
            if w is None:
                pri = json.load(open(os.path.join(os.path.dirname(__file__), '..', 'nfl-model-priors.json'), encoding='utf-8'))
                players, league = pri['players'], pri['league']
                elig = lambda p: p.get('status') == 'same-team'
            else:
                meta, players, _ = build(D, w, thru)
                league = meta['league']
                elig = lambda p: p.get('status') in ('same-team', 'moved-current', 'rookie-current')
            preds = {}
            for gsis, p in players.items():
                if not elig(p):
                    continue
                tm = team(p.get('tm26') or p.get('tm'))
                if (gsis, W) not in wkW or team(wkW[(gsis, W)]) != tm or tm not in tpW:
                    continue
                if p['recN'] >= 12 and p['rp'] >= 0.5:
                    ypr = (p['ypr'] * p['recN'] + 12 * league['yprCohort']) / (p['recN'] + 12) * 1.05
                    preds[('rec', gsis)] = (tpW[tm] * p['recShare'] * ypr, act[gsis]['recyd'])
                if p['carN'] >= 20:
                    ypc = (p['ypc'] * p['carN'] + 15 * league['ypcCohort']) / (p['carN'] + 15) * 1.05
                    preds[('rush', gsis)] = (trW[tm] * p['carShare'] * ypc, act[gsis]['rushyd'])
            out.append((W, label, preds))
    # Scored on the players every variant projects, so the error compares the
    # priors and not who happened to clear a gate; coverage is reported apart.
    res = []
    for W in sorted({o[0] for o in out}):
        rows = [o for o in out if o[0] == W]
        common = set.intersection(*[set(o[2]) for o in rows])
        for _, label, preds in rows:
            for mk in ('rec', 'rush'):
                ks = [k for k in common if k[0] == mk]
                mae = sum(abs(preds[k][0] - preds[k][1]) for k in ks) / len(ks) if ks else None
                bias = sum(preds[k][0] - preds[k][1] for k in ks) / len(ks) if ks else None
                cov = sum(1 for k in preds if k[0] == mk)
                res.append((W, label, mk, len(ks), round(mae, 2) if mae is not None else None,
                            round(bias, 2) if bias is not None else None, cov))
    return res


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True)
    ap.add_argument('--w25', type=float, default=0.5)
    ap.add_argument('--out', default=os.path.join(os.path.dirname(__file__), '..', 'nfl-model-priors.json'))
    ap.add_argument('--backtest', action='store_true')
    a = ap.parse_args()
    if a.backtest:
        print('week  priors                      market  common  MAE     bias   projected')
        for W, label, mk, n, mae, bias, cov in backtest(a.data, [0.15, 0.3, 0.5, 1.0]):
            print(f'{W:>4}  {label:<26}  {mk:<6} {n:>6} {str(mae):>7} {str(bias):>7} {cov:>8}')
    else:
        meta, players, _ = build(a.data, a.w25)
        json.dump({**meta, 'players': players}, open(a.out, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)
        print(json.dumps({k: v for k, v in meta.items() if k != 'league'}), 'players', len(players))
