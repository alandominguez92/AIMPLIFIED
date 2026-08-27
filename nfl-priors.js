/* NFL Priors — the 2025 usage inputs behind the NFL projections.
 *
 * Reads the two repo files directly. No API call, so this page costs nothing
 * against the odds quota and works while the feed is out.
 *
 * It is deliberately NOT a board. Neither file contains a model output, a fair
 * line or a book price, so a board shell here would be columns with nothing
 * behind them. Everything below exists to make the inputs checkable, including
 * the four places where the raw data will mislead you if taken at face value.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  // Thresholds below which a rate is not a rate. A yards-per-carry built on one
  // attempt is a single play wearing a percentage sign.
  var MIN_REC = 20, MIN_CAR = 25, MIN_G = 8;
  var KICKOFF = Date.parse('2026-09-09T20:20:00-07:00');

  // nflverse writes Arizona as ARI in the 2025 play-by-play and AZ in the 2026
  // rosters, while the schedule file uses ARI throughout. Left alone this does
  // two separate kinds of damage, so it is normalised once, here, before any
  // count or join touches the data:
  //   - eight players read as having changed teams when they did not
  //   - every player whose 2026 team is Arizona fails a join on team code,
  //     which is ten players, not eight: two genuinely moved there
  var TEAM_ALIAS = { AZ: 'ARI' };
  var team26 = function (p) { return p.tm26 ? (TEAM_ALIAS[p.tm26] || p.tm26) : null; };
  var team25 = function (p) { return p.tm ? (TEAM_ALIAS[p.tm] || p.tm) : null; };
  // A move is a move only after normalising both sides.
  var hasMoved = function (p) { return p.status === 'moved' && team25(p) !== team26(p); };
  var isRename = function (p) { return p.status === 'moved' && team25(p) === team26(p); };

  var SURFACE = { grass: 'grass', fieldturf: 'field turf', matrixturf: 'matrix turf', a_turf: 'a-turf',
    sportturf: 'sport turf', astroturf: 'astro turf', astroplay: 'astro play', dessograss: 'desso grass' };
  var surfaceName = function (s) { return SURFACE[s] || String(s || '—').replace(/_/g, ' '); };

  var pct = function (v) { return (v * 100).toFixed(1) + '%'; };
  var t12 = function (t) {
    var parts = String(t).split(':'), h = +parts[0], m = parts[1];
    return (h % 12 === 0 ? 12 : h % 12) + ':' + m + (h >= 12 ? 'pm' : 'am');
  };
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var mdy = function (d) { var p = String(d).split('-'); return MONTHS[+p[1] - 1] + ' ' + (+p[2]); };

  try {
    var saved = localStorage.getItem('aimplified-theme');
    if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
  } catch (e) { /* private mode — the default is fine */ }
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-action="toggle-theme"]');
    if (!t) return;
    var next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('aimplified-theme', next); } catch (err) { /* not essential */ }
  });

  var S = { pos: 'all', qual: 'all', team: 'all', sort: 'tgt', q: '', week: 1 };
  var PRIORS = null, SCHED = null, PLAYERS = [];

  Promise.all([
    fetch('nfl-model-priors.json').then(function (r) { return r.json(); }),
    fetch('nfl-schedule-2026.json').then(function (r) { return r.json(); }),
  ]).then(function (both) {
    PRIORS = both[0]; SCHED = both[1];
    PLAYERS = Object.keys(PRIORS.players).map(function (k) { return PRIORS.players[k]; });
    boot();
  }).catch(function (err) {
    $('npEyebrow').textContent = 'the priors did not load';
    $('npStrip').innerHTML = '<div class="tr-err">The input files did not load ('
      + esc(err && err.message ? err.message : String(err))
      + '). Nothing is rendered rather than filled with a guess — this page exists to be checked, '
      + 'so a partial version of it would defeat its purpose.</div>';
  });

  // Which sample bucket a player falls in. A player with no 2026 roster spot is
  // its own case, not a thin one: the issue is not sample size, it is that there
  // is nothing to carry the prior forward to.
  function bucket(p) {
    if (!team26(p)) return 'noteam';
    if (p.g >= MIN_G && (p.recN >= MIN_REC || p.carN >= MIN_CAR)) return 'usable';
    return 'thin';
  }

  function boot() {
    var moved = PLAYERS.filter(hasMoved).length;
    var renamed = PLAYERS.filter(isRename).length;
    var noTeam = PLAYERS.filter(function (p) { return !team26(p); }).length;
    var thin = PLAYERS.filter(function (p) { return bucket(p) === 'thin'; }).length;
    var usable = PLAYERS.filter(function (p) { return bucket(p) === 'usable'; }).length;
    var byPos = { WR: 0, RB: 0, TE: 0 };
    PLAYERS.forEach(function (p) { if (byPos[p.pos] != null) byPos[p.pos]++; });

    var games = SCHED.games || [];
    var priced = games.filter(function (g) { return g.spread != null; }).length;
    var days = Math.max(0, Math.ceil((KICKOFF - Date.now()) / 864e5));

    $('npEyebrow').textContent = days + ' days to week 1 · 2025 priors · nothing priced';

    $('npStrip').innerHTML = [
      { k: 'Players carried', v: String(PLAYERS.length),
        note: 'WR ' + byPos.WR + ' · RB ' + byPos.RB + ' · TE ' + byPos.TE + ' — from 2025 play-by-play, participation and weekly rosters.' },
      { k: 'Changed teams', v: String(moved), tone: 'caution',
        note: 'Their share was earned in another offence, so it is flagged on the row and never carried forward.'
          + (renamed ? ' A further ' + renamed + ' are only a team-code change, not a move.' : '') },
      { k: 'Games with a line', v: priced + ' / ' + games.length,
        note: 'A lookahead spread and total from nflverse. Not a book quote, and nothing here is priced against it.' },
      { k: 'Plays posted', v: '0', tone: 'dim',
        note: 'No fair line and no graded NFL record. The MLB record does not transfer.' },
    ].map(function (c) {
      return '<div class="tr-cell"><div class="tr-k">' + esc(c.k) + '</div>'
        + '<div class="tr-v' + (c.tone ? ' np-tone-' + c.tone : '') + '">' + esc(c.v) + '</div>'
        + '<div class="tr-n">' + esc(c.note) + '</div></div>';
    }).join('');

    // The four caveats, each carrying its own live count so the page cannot
    // claim a number the file no longer contains.
    var azNames = PLAYERS.filter(isRename).map(function (p) { return p.n; });
    var azJoin = PLAYERS.filter(function (p) { return p.tm26 && TEAM_ALIAS[p.tm26]; }).length;
    var lowCar = PLAYERS.filter(function (p) { return p.carN > 0 && p.carN <= 5; }).length;
    var negCar = PLAYERS.filter(function (p) { return p.ypc < 0; }).length;
    var wk = weekCounts(games);
    var fullWeeks = Object.keys(wk).filter(function (w) { return wk[w].lines === wk[w].n; }).length;
    var partial = Object.keys(wk).filter(function (w) { return wk[w].lines && wk[w].lines < wk[w].n; })
      .map(function (w) { return 'week ' + w + ' at ' + wk[w].lines + ' of ' + wk[w].n; });

    $('npLimits').innerHTML = [
      ['01', 'A share is a share of the team he left',
        moved + ' players changed teams. A target share is a fraction of one offence’s passing volume, '
        + 'so carrying it to a new team silently re-points it at a different denominator. Moved rows keep the '
        + 'old team visible and render the share amber rather than pretending it transfers.'],
      ['02', 'Arizona is ARI in one file and AZ in another',
        'The 2025 play-by-play writes ARI, the 2026 rosters write AZ, and the schedule uses ARI throughout. '
        + 'Taken raw, ' + azNames.length + ' players read as transfers when they never moved — and joining priors '
        + 'to the schedule on team code drops <b>' + azJoin + '</b> players, not ' + azNames.length + ', because two '
        + 'genuinely moved to Arizona and share the broken code. Normalised here before any count or join.'],
      ['03', 'Rate stats die on small denominators',
        lowCar + ' players’ yards-per-carry rests on five carries or fewer and ' + negCar + ' are negative — '
        + 'Chris Olave’s −3.0 is one carry for −3 yards. Below ' + MIN_REC + ' receptions or ' + MIN_CAR
        + ' carries the rate blanks and the cell shows the sample instead. ' + thin + ' of ' + PLAYERS.length
        + ' rows are thin by that test; ' + noTeam + ' have no 2026 team at all.'],
      ['04', 'Those lines are not our prices',
        'nflverse ships a lookahead spread and total for ' + priced + ' games — ' + fullWeeks + ' weeks complete'
        + (partial.length ? ', ' + partial.join(' and ') : '') + ', and nothing after. They are not book quotes, '
        + 'nothing has computed a fair line against them, and no edge is shown because none exists yet.'],
    ].map(function (l) {
      return '<div class="np-limit"><div class="np-limit-head"><span class="np-limit-n">' + l[0] + '</span>'
        + '<span class="np-limit-k">' + esc(l[1]) + '</span></div>'
        + '<div class="np-limit-d">' + l[2] + '</div></div>';
    }).join('');

    $('npScope').textContent = usable + ' usable · ' + thin + ' thin · ' + noTeam + ' unrostered';
    $('npSchedScope').textContent = priced + ' of ' + games.length + ' games carry a lookahead number';

    $('npProv').innerHTML = 'Source: <b>nfl-model-priors.json</b> (built ' + esc(String(PRIORS.built).slice(0, 10))
      + ' from ' + esc(String(PRIORS.builtFrom)) + ' play-by-play, participation and weekly rosters) and '
      + '<b>nfl-schedule-2026.json</b> (built ' + esc(String(SCHED.built).slice(0, 10)) + '). League baselines behind '
      + 'the deltas: ' + PRIORS.league.yprCohort.toFixed(2) + ' yards per reception, ' + PRIORS.league.ypcCohort.toFixed(2)
      + ' per carry, ' + PRIORS.league.playsPerTeamGame + ' plays per team game, '
      + (PRIORS.league.passRate * 100).toFixed(1) + '% pass rate. Both files are read straight from the repo — '
      + 'no value on this page is hand-entered.';

    wireControls(usable, thin, noTeam);
    renderTable();
    renderWeeks();
    renderSchedule();
  }

  function weekCounts(games) {
    var wk = {};
    games.forEach(function (g) {
      if (!wk[g.wk]) wk[g.wk] = { n: 0, lines: 0 };
      wk[g.wk].n++;
      if (g.spread != null) wk[g.wk].lines++;
    });
    return wk;
  }

  // ---- controls ---------------------------------------------------------
  function chips(host, items, current, onPick) {
    $(host).innerHTML = items.map(function (it) {
      return '<button type="button" class="np-chip' + (it.key === current ? ' active' : '') + '"'
        + ' data-key="' + esc(it.key) + '" title="' + esc(it.title || '') + '">' + esc(it.label)
        + (it.n != null ? '<span class="chip-count">' + it.n + '</span>' : '') + '</button>';
    }).join('');
    $(host).onclick = function (e) {
      var b = e.target.closest('.np-chip');
      if (b) { onPick(b.dataset.key); }
    };
  }

  function wireControls(usable, thin, noTeam) {
    var redraw = function () { renderTable(); };
    chips('npPos', [
      { key: 'all', label: 'All', title: 'Every position in the file' },
      { key: 'WR', label: 'WR' }, { key: 'RB', label: 'RB' }, { key: 'TE', label: 'TE' },
    ], S.pos, function (k) { S.pos = k; wireControls(usable, thin, noTeam); redraw(); });

    chips('npQual', [
      { key: 'all', label: 'All', n: PLAYERS.length, title: 'No sample filter' },
      { key: 'usable', label: 'Usable', n: usable, title: MIN_G + '+ games and a real rate denominator' },
      { key: 'thin', label: 'Thin', n: thin, title: 'Too few games or attempts for a stable rate' },
      { key: 'noteam', label: 'Unrostered', n: noTeam, title: 'No 2026 team in the file' },
    ], S.qual, function (k) { S.qual = k; wireControls(usable, thin, noTeam); redraw(); });

    chips('npSort', [
      { key: 'tgt', label: 'Tgt share' }, { key: 'car', label: 'Car share' },
      { key: 'rp', label: 'Routes' }, { key: 'name', label: 'Name' },
    ], S.sort, function (k) { S.sort = k; wireControls(usable, thin, noTeam); redraw(); });

    // Normalised codes, so choosing Arizona returns all ten of its players
    // rather than the subset whose row happened to spell it ARI.
    var teams = {};
    PLAYERS.forEach(function (p) { var t = team26(p); if (t) teams[t] = 1; });
    var sel = $('npTeam');
    if (sel.options.length === 0) {
      sel.innerHTML = '<option value="all">all 2026 teams</option>'
        + Object.keys(teams).sort().map(function (t) { return '<option value="' + esc(t) + '">' + esc(t) + '</option>'; }).join('');
      sel.onchange = function () { S.team = sel.value; redraw(); };
      $('npSearch').oninput = function () { S.q = $('npSearch').value; redraw(); };
    }
  }

  function filtered() {
    var q = S.q.trim().toLowerCase();
    var out = PLAYERS.filter(function (p) {
      if (S.pos !== 'all' && p.pos !== S.pos) return false;
      if (S.qual !== 'all' && bucket(p) !== S.qual) return false;
      if (S.team !== 'all' && team26(p) !== S.team) return false;
      if (q && String(p.n).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    out.sort(function (a, b) {
      if (S.sort === 'car') return b.carShare - a.carShare;
      if (S.sort === 'rp') return b.rp - a.rp;
      if (S.sort === 'name') return String(a.n).localeCompare(String(b.n));
      return b.recShare - a.recShare;
    });
    return out;
  }

  // A rate, or the reason there isn't one. Below the threshold the cell shows
  // the denominator instead of a number, because "n=3" is honest where "12.0"
  // would be three receptions pretending to be a rate.
  function rateCell(val, n, min, league) {
    if (!n) return '<span class="tr-dash">—</span>';
    if (n < min) return '<span class="np-thin">n=' + n + '<i>below ' + min + '</i></span>';
    var d = val - league;
    // Grey in BOTH directions. Above the league rate is not a bet, and this page
    // has no prices to bet into — a green delta would imply a call it never makes.
    return '<span class="np-rate">' + val.toFixed(1)
      + '<i>' + (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(1) + ' vs lg</i></span>';
  }

  var CAP = 60;
  function renderTable() {
    var all = filtered();
    var rows = all.slice(0, CAP);
    var L = PRIORS.league;

    var head = ['Player', 'Routes', 'Tgt share', 'Y/rec', 'Car share', 'Y/car', 'Sample'];
    var html = '<div class="tr-thead">' + head.map(function (h, i) {
      return '<span' + (i === 0 ? '' : ' class="tr-r"') + '>' + esc(h) + '</span>';
    }).join('') + '</div>';

    if (!rows.length) {
      html += '<div class="np-empty"><b>' + (S.q ? 'No player matches “' + esc(S.q) + '”' : 'Nothing in this slice')
        + '</b><span>' + (S.q
          ? 'The file carries ' + PLAYERS.length + ' pass-catchers and backs with 2025 usage. Rookies with no 2025 snaps are not in it at all.'
          : 'That combination of position, sample and team has no rows. The filter is working — this is not an empty board.')
        + '</span></div>';
    } else {
      html += rows.map(function (p) {
        var mv = hasMoved(p), bk = bucket(p);
        var t26 = team26(p);
        var flag = bk === 'noteam' ? '<span class="np-flag np-flag-out">unrostered</span>'
          : mv ? '<span class="np-flag np-flag-moved">moved</span>' : '';
        var sub = bk === 'noteam'
          ? 'On no 2026 roster in the file — 2025 line only, nothing to carry forward'
          : mv ? 'Share below was earned in ' + esc(team25(p)) + ' · new offence, new denominator'
          : bk === 'thin' ? 'Thin 2025 sample — rates blank, share is not stable'
          : esc(team25(p)) + ' in 2025 · same team in 2026';
        // The share itself goes amber on a moved player: the number is real, but
        // it describes an offence he is no longer in.
        var shareCls = bk === 'noteam' ? 'np-share-out' : mv ? 'np-share-moved' : '';
        return '<div class="tr-tr">'
          + '<div class="np-p"><div class="np-p-head">'
            + '<span class="np-name">' + esc(p.n) + '</span>'
            + '<span class="np-pos">' + esc(p.pos) + '</span>'
            + '<span class="np-team' + (t26 ? (mv ? ' np-team-moved' : '') : ' np-team-out') + '">'
            + esc(t26 || 'no 2026 tm') + '</span></div>'
            + '<div class="np-p-sub">' + flag + '<span>' + sub + '</span></div></div>'
          + '<span class="tr-r' + (p.g >= MIN_G ? '' : ' np-dim') + '">' + pct(p.rp) + '</span>'
          + '<span class="tr-r ' + shareCls + '">' + (p.recShare ? pct(p.recShare) : '<span class="tr-dash">—</span>') + '</span>'
          + '<span class="tr-r">' + rateCell(p.ypr, p.recN, MIN_REC, L.yprCohort) + '</span>'
          + '<span class="tr-r ' + shareCls + '">' + (p.carShare ? pct(p.carShare) : '<span class="tr-dash">—</span>') + '</span>'
          + '<span class="tr-r">' + rateCell(p.ypc, p.carN, MIN_CAR, L.ypcCohort) + '</span>'
          + '<span class="tr-r np-sample">' + p.g + 'g · ' + p.recN + 'r' + (p.carN ? ' · ' + p.carN + 'c' : '') + '</span>'
          + '</div>';
      }).join('');
    }
    $('npTable').innerHTML = html;

    $('npCount').textContent = 'showing ' + rows.length + ' of ' + all.length + ' rows'
      + (all.length > rows.length ? ' (top ' + CAP + ')' : '') + ' · ' + PLAYERS.length + ' in the file';
    $('npGuard').textContent = 'rates blank below ' + MIN_REC + ' rec / ' + MIN_CAR + ' car';
  }

  // ---- schedule ---------------------------------------------------------
  function renderWeeks() {
    var wk = weekCounts(SCHED.games);
    $('npWeeks').innerHTML = Object.keys(wk).map(Number).sort(function (a, b) { return a - b; }).map(function (w) {
      var c = wk[w];
      // The dot states line coverage at a glance: filled when the whole week has
      // a number, amber when partial, hollow when the file carries none.
      var state = !c.lines ? 'none' : c.lines === c.n ? 'full' : 'part';
      return '<button type="button" class="np-week' + (S.week === w ? ' active' : '') + '" data-w="' + w + '"'
        + ' title="' + (c.lines ? 'Week ' + w + ' — ' + c.lines + ' of ' + c.n + ' games carry a lookahead line'
          : 'Week ' + w + ' — no line in the file') + '">'
        + w + '<span class="np-wdot np-wdot-' + state + '"></span></button>';
    }).join('');
    $('npWeeks').onclick = function (e) {
      var b = e.target.closest('.np-week');
      if (!b) return;
      S.week = +b.dataset.w;
      renderWeeks(); renderSchedule();
    };
  }

  function renderSchedule() {
    var games = SCHED.games.filter(function (g) { return g.wk === S.week; });
    var lines = games.filter(function (g) { return g.spread != null; }).length;

    // Never assert a market fact the file cannot see. A week with no number says
    // the number is absent, not that the game is a pick'em.
    var banner = '';
    if (!lines) {
      banner = 'Week ' + S.week + ' carries no lookahead number. The calendar is fixed, so the '
        + games.length + ' games are listed — the spread and total columns hold a dash rather than a guess.';
    } else if (lines < games.length) {
      banner = 'Week ' + S.week + ' is partial: ' + lines + ' of ' + games.length + ' games have a lookahead '
        + 'number. The other ' + (games.length - lines) + ' are blank in the file, not pick’em.';
    }
    $('npWeekBanner').innerHTML = banner;
    $('npWeekBanner').hidden = !banner;

    var head = ['Kickoff', 'Matchup', 'Lookahead', 'Total', 'Venue'];
    $('npSched').innerHTML = '<div class="tr-thead">' + head.map(function (h, i) {
      return '<span' + (i < 2 ? '' : ' class="tr-r"') + '>' + esc(h) + '</span>';
    }).join('') + '</div>'
      + games.map(function (g) {
        var has = g.spread != null;
        // A positive spread favours the home side in this file's convention.
        var fav = has ? (g.spread > 0 ? g.home : g.away) : null;
        var mag = has ? Math.abs(g.spread) : null;
        return '<div class="tr-tr">'
          + '<span class="np-when">' + esc(g.dow + ' ' + mdy(g.d) + ' · ' + t12(g.t)) + '</span>'
          + '<span class="np-match"><span class="np-away">' + esc(g.away) + '</span>'
            + '<span class="np-at">at</span><span class="np-home">' + esc(g.home) + '</span>'
            + (g.standalone ? '<span class="np-flag np-flag-dim">standalone</span>' : '') + '</span>'
          + '<span class="tr-r">' + (has ? esc(fav + ' −' + (mag % 1 === 0 ? mag : mag.toFixed(1))) : '<span class="tr-dash">—</span>') + '</span>'
          + '<span class="tr-r">' + (has ? esc(String(g.total)) : '<span class="tr-dash">—</span>') + '</span>'
          + '<span class="tr-r np-venue">' + esc(g.roof === 'outdoors' ? surfaceName(g.surface) : g.roof) + '</span>'
          + '</div>';
      }).join('');

    $('npSchedFoot').textContent = 'week ' + S.week + ' · ' + games.length + ' games · ' + lines
      + ' with a number · favourite shown with the spread, home team in white';
  }
})();
