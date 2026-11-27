/* Track Record — the audit page for posted batter unders.
 *
 * One rule governs this file: nothing here is written as a literal. Every figure
 * and every sentence that makes a claim about the record is derived from
 * /api/track-record, so the page cannot drift away from the database the way a
 * hand-maintained "55.1%" in the markup eventually does.
 *
 * The second rule is about which way it is allowed to be wrong. Where a number
 * is ambiguous, the page states the reading that is worse for us — an interval
 * containing break-even reads "we cannot yet tell", never "we're profitable".
 */
(function () {
  'use strict';

  var base = (window.AIMPLIFIED_API_BASE || '').trim();
  var API = (base === 'same-origin' || base === '/' || base === '') ? '' : base.replace(/\/$/, '');

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var num = function (n, d) { return n == null ? '—' : Number(n).toFixed(d == null ? 1 : d); };
  var signed = function (n, d) { return n == null ? '—' : (n > 0 ? '+' : '') + Number(n).toFixed(d == null ? 1 : d); };
  var money = function (p) { return p == null ? '—' : (p > 0 ? '+' + p : String(p)); };
  var plural = function (n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); };

  // Theme toggle, kept in step with the board so a reader who set light there
  // does not land on a dark page here.
  try {
    // The board's key is aimplified_theme (underscore). This page used
    // aimplified-theme (hyphen), so light chosen on the board never reached
    // here. The board's key first; the old one as a fallback.
    var saved = localStorage.getItem('aimplified_theme') || localStorage.getItem('aimplified-theme');
    if (saved === 'light' || saved === 'dark') document.documentElement.setAttribute('data-theme', saved);
  } catch (e) { /* private mode — the default theme is fine */ }
  // The phone's status bar follows the page, as on the board (--field in each theme).
  function paintStatusBar() {
    var bar = document.querySelector('meta[name="theme-color"]');
    if (bar) bar.content = document.documentElement.getAttribute('data-theme') === 'light' ? '#F2F4F8' : '#0a0d12';
  }
  paintStatusBar();
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-action="toggle-theme"]');
    if (!t) return;
    var next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    paintStatusBar();
    try { localStorage.setItem('aimplified_theme', next); localStorage.setItem('aimplified-theme', next); } catch (err) { /* not essential */ }
  });

  fetch(API + '/api/track-record', { headers: { accept: 'application/json' } })
    .then(function (r) { return r.json(); })
    .then(render)
    .catch(function (err) {
      $('trEyebrow').textContent = 'the record could not be loaded';
      $('trStrip').innerHTML = '<div class="tr-err">The graded record did not load ('
        + esc(err && err.message ? err.message : String(err))
        + '). Nothing is shown rather than a partial or cached figure — a record you '
        + 'cannot trust to be current is worse than none.</div>';
    });

  // ---- What's on Picks, and why (2026-11-27) ------------------------------
  // Every kind of leg Picks of the day has carried, from /api/pick-rules: its record at its bar,
  // its place on the list, and each change to it, dated. As everywhere on this page, every figure
  // and every reason is the API's; this only lays them out. Its own read, so the batter-unders
  // record failing leaves it standing, and the other way round.
  fetch(API + '/api/pick-rules', { headers: { accept: 'application/json' } })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(renderRules)
    .catch(function (err) {
      $('trRules').innerHTML = '<div class="tr-err">What is on Picks did not load ('
        + esc(err && err.message ? err.message : String(err)) + ').</div>';
      $('trRulesSec').hidden = false;
    });

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // "2026-11-24" -> "Nov 24". Pacific days, read as written: through a Date they could shift a day.
  function day(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    return m ? MONTHS[Number(m[2]) - 1] + ' ' + Number(m[3]) : String(ymd || '');
  }

  function renderRules(j) {
    var kinds = (j && j.kinds) || [];
    if (!kinds.length) return;
    var flex = j.flex || {};
    var PLACE = { on: ['on Picks', 'good'], held: ['held off', 'bad'], off: ['off Picks', 'dim'] };
    $('trRules').innerHTML = kinds.map(function (k) {
      var place = PLACE[k.status] || [k.status, 'dim'];
      var tag = '<span class="tr-tag tr-tag-' + place[1] + '">' + esc(place[0] + (k.since ? ' since ' + day(k.since) : '')) + '</span>';
      var r = k.record, rec;
      if (!r) rec = 'record not read just now';
      else if (!r.n) rec = 'no graded legs yet';
      else {
        rec = 'landed <b>' + r.hit + ' of ' + r.n + '</b> (' + num(r.hitRate) + '%)';
        // A thin record says so rather than being held to a bar; a full one under the Flex's is marked.
        if (!r.proven) rec += ' <span class="tr-tag tr-tag-dim">fewer than ' + esc(j.provenN) + ' graded</span>';
        else if (flex.pct != null && r.hitRate < flex.pct) rec += ' <span class="tr-tag tr-tag-bad">under ' + num(flex.pct) + '%</span>';
        if (r.since && r.since.n) rec += ' · ' + r.since.hit + ' of ' + r.since.n + ' (' + num(r.since.hitRate) + '%) since ' + esc(day(r.since.from));
      }
      var parts = (k.parts || []).map(function (p) {
        return esc(p.label) + ' ' + p.hit + ' of ' + p.n + ' (' + num(p.hitRate) + '%)';
      }).join(' · ');
      var log = (k.changes || []).map(function (c) {
        return '<li><span class="tr-date">' + esc(day(c.date)) + '</span><span>' + esc(c.what) + '</span></li>';
      }).join('');
      return '<div class="tr-rule tr-rule-' + esc(k.status) + '">'
        + '<div class="tr-rule-head"><b>' + esc(k.label) + '</b>' + tag + '</div>'
        + '<div class="tr-rule-rec">listed at ' + esc(k.min) + '%+ · ' + rec + '</div>'
        + (parts ? '<div class="tr-rule-rec">' + parts + '</div>' : '')
        + (log ? '<ol class="tr-rule-log">' + log + '</ol>' : '')
        + '</div>';
    }).join('');
    var foot = [];
    if (flex.pct != null) {
      foot.push('<span class="tr-pill tr-pill-caution">Against ' + num(flex.pct) + '%</span> what each leg of a '
        + esc(flex.label) + ' has to land for the entry to break even at PrizePicks’ payouts.');
    }
    if (j.note) foot.push(esc(j.note));
    if (j.loggedOnly && j.loggedOnly.length) foot.push('Logged and graded, never on Picks: ' + esc(j.loggedOnly.join('; ')) + '.');
    if (j.next) foot.push('<b>' + esc(day(j.next.date)) + '</b>: ' + esc(j.next.what) + '.');
    $('trRulesFoot').innerHTML = foot.map(function (s) { return '<p>' + s + '</p>'; }).join('');
    $('trRulesSec').hidden = false;
  }

  function render(j) {
    var bu = j && j.batterUnders;
    if (!bu || !bu.n) {
      $('trEyebrow').textContent = 'no graded picks yet';
      $('trStrip').innerHTML = '<div class="tr-err">Nothing has graded yet. The record starts '
        + 'with the first posted under and only ever grows — rows are never removed.</div>';
      return;
    }

    $('trEyebrow').textContent = bu.n.toLocaleString() + ' graded picks · batter unders';

    // ---- Headline strip -------------------------------------------------
    // Median, not mean: these prices straddle zero, and an averaged American
    // price is not a number that means anything.
    var cells = [
      // "The one market we post" until Picks of the day (2026-11-27): the panel above lists the rest.
      { k: 'Graded picks', v: bu.n.toLocaleString(), note: 'Batter unders only. Nothing is removed after the fact.' },
      { k: 'Hit rate', v: num(bu.winRate) + '%', note: 'Break-even across these prices is ' + num(bu.breakEven) + '%.' },
      { k: 'Units', v: signed(bu.units), tone: bu.units > 0 ? 'good' : bu.units < 0 ? 'bad' : null,
        note: '1u flat, sportsbook pricing. ROI ' + signed(bu.roi) + '%.' },
      { k: 'Typical price', v: money(bu.medianPrice), note: 'Median posted price. Unders on the 1.5 are juiced, which is why the hit rate has to be high.' },
    ];
    $('trStrip').innerHTML = cells.map(function (c) {
      return '<div class="tr-cell"><div class="tr-k">' + esc(c.k) + '</div>'
        + '<div class="tr-v' + (c.tone ? ' tone-' + c.tone : '') + '">' + esc(c.v) + '</div>'
        + '<div class="tr-n">' + esc(c.note) + '</div></div>';
    }).join('');

    renderEdge(bu);
    renderTiers(j.buTierBreakdown || []);
    renderEras(j.eraBreakdown || []);
    renderClv(j, bu);
    renderLog(j.log || [], j.logAll || [], bu, j.logScope || { postedN: (j.log||[]).length, allN: (j.logAll||[]).length, allNote: '' });
  }

  // ---- Is the edge real? ------------------------------------------------
  // The whole section turns on beatsBreakEven, which is null when the interval
  // contains break-even. Null is the interesting case and gets the honest
  // sentence: the sample cannot distinguish a small real edge from none.
  function renderEdge(bu) {
    if (bu.ci == null || bu.breakEven == null) return;
    var verdict = bu.beatsBreakEven === true
      ? 'the interval sits entirely above break-even, so this sample does show an edge'
      : bu.beatsBreakEven === false
        ? 'the interval sits entirely below break-even, so this sample shows a real loss'
        : 'the interval contains break-even, so the honest answer is <b>we cannot yet tell</b>';

    $('trEdgeProse').innerHTML =
      'At these prices a bet has to win <b>' + num(bu.breakEven) + '%</b> of the time just to stay level. '
      + 'We are hitting <b>' + num(bu.winRate) + '%</b> over ' + bu.n.toLocaleString() + ' graded picks. '
      + 'The 95% interval on that hit rate runs ' + num(bu.ci.lo) + '% to ' + num(bu.ci.hi) + '%, and '
      + verdict + '.';

    // Domain is chosen to contain the interval and break-even with a margin,
    // then rounded outward — a fixed 50-60 window silently clips a sample that
    // wanders outside it, and a clipped interval reads as a narrower one.
    var lo = Math.floor(Math.min(bu.ci.lo, bu.breakEven, bu.winRate) - 2);
    var hi = Math.ceil(Math.max(bu.ci.hi, bu.breakEven, bu.winRate) + 2);
    var pct = function (v) { return ((v - lo) / (hi - lo)) * 100; };

    $('trCI').innerHTML =
      '<div class="ci-axis">'
      + '<div class="ci-band" style="left:' + pct(bu.ci.lo) + '%;width:' + (pct(bu.ci.hi) - pct(bu.ci.lo)) + '%"></div>'
      + '<div class="ci-mark" style="left:' + pct(bu.winRate) + '%"></div>'
      + '<div class="ci-be" style="left:' + pct(bu.breakEven) + '%"></div>'
      + '</div>'
      + '<div class="ci-lab ci-lab-be" style="left:' + pct(bu.breakEven) + '%">break-even ' + num(bu.breakEven) + '%</div>'
      + '<div class="ci-lab ci-lab-us" style="left:' + pct(bu.winRate) + '%">us ' + num(bu.winRate) + '%</div>'
      + '<div class="ci-ticks"><span>' + lo + '%</span><span>' + hi + '%</span></div>';

    $('trCINote').innerHTML = '<span class="tr-pill tr-pill-model">95% CI</span> On ' + bu.n.toLocaleString()
      + ' picks the interval runs ' + num(bu.ci.lo) + '% to ' + num(bu.ci.hi) + '%. '
      + (bu.beatsBreakEven === null
        ? 'Break-even sits inside it, so this sample cannot separate a small real edge from none at all. '
          + 'That is not evidence the edge is absent either — it is evidence the question is still open. '
        : '')
      + 'ROI over the same rows is ' + signed(bu.roi) + '%'
      + (bu.roiP != null ? ' (p ' + num(bu.roiP, 3) + ')' : '')
      + ' — the figure that already accounts for every price correctly.';
    $('trEdgeCard').hidden = false;
  }

  // ---- By tier ----------------------------------------------------------
  function renderTiers(rows) {
    if (!rows.length) return;
    var TIER_LABEL = { play: 'Play', '1': 'T1', '2': 'T2', '3': 'T3' };
    // Hit rate rather than the W–L string: these slices differ by an order of
    // magnitude in size, and a rate is the only column you can read down.
    $('trTierTable').innerHTML = tableHtml(
      ['Tier', 'Graded', 'Hit', 'Units', 'ROI', 'p'],
      rows.map(function (t) {
        var name = '<div class="tr-era"><b>' + esc(TIER_LABEL[t.tier] || t.tier) + '</b>'
          + (t.sub ? '<span class="tr-era-note">' + esc(t.sub) + '</span>' : '') + '</div>';
        return [name, t.n.toLocaleString(), num(t.hit) + '%',
          cellTone(signed(t.units), t.units), cellTone(signed(t.roi) + '%', t.roi),
          t.p == null ? '<span class="tr-dash">—</span>' : num(t.p, 2)];
      }));

    // The claim is computed, not asserted: if a tier ever does clear the bar the
    // sentence has to change, and a hardcoded one would not.
    var sig = rows.filter(function (t) { return t.p != null && t.p < 0.05 && t.roi > 0; });
    $('trTierFoot').innerHTML = '<span class="tr-pill tr-pill-caution">Read this</span> '
      + (sig.length
        ? esc(sig.map(function (t) { return TIER_LABEL[t.tier] || t.tier; }).join(', '))
          + ' clears p&lt;0.05 with a positive return. Every other tier does not.'
        : 'No tier clears p&lt;0.05. The ordering has produced no separation we can stand behind, '
          + 'which is why the board stopped ranking picks and now only says play or pass. '
          + 'Treat a tier label as a label, not a strength.');
    $('trTierSec').hidden = false;
  }

  // ---- By pricing era ---------------------------------------------------
  function renderEras(rows) {
    if (!rows.length) return;
    var TAG_CLASS = { contaminated: 'bad', unknown: 'bad', legacy: 'dim', current: 'good' };
    $('trEraTable').innerHTML = tableHtml(
      ['Era', 'Graded', 'Hit', 'Units', 'ROI', 'p'],
      rows.map(function (e) {
        var tag = e.tag ? '<span class="tr-tag tr-tag-' + (TAG_CLASS[e.tag] || 'dim') + '">' + esc(e.tag) + '</span>' : '';
        var thin = e.thin ? '<span class="tr-tag tr-tag-dim">n too small</span>' : '';
        // A thin era's ROI renders neutral rather than green or red. Colouring
        // +14.7% on seven picks green states a result the sample cannot support.
        var roiCell = e.thin
          ? '<span class="tone-dim">' + esc(signed(e.roi) + '%') + '</span>'
          : cellTone(signed(e.roi) + '%', e.roi);
        return ['<div class="tr-era"><b>' + esc(e.era) + '</b>' + tag + thin
            + (e.note ? '<span class="tr-era-note">' + esc(e.note) + '</span>' : '') + '</div>',
          e.n.toLocaleString(), num(e.hit) + '%',
          e.thin ? '<span class="tone-dim">' + esc(signed(e.units)) + '</span>' : cellTone(signed(e.units), e.units),
          roiCell,
          e.p == null ? '<span class="tr-dash">—</span>' : num(e.p, 2)];
      }), rows.map(function (e) { return e.warn ? 'row-contaminated' : ''; }));

    // The caveat is aimed at whichever era actually looks best, because that is
    // the row a reader will anchor on. If the top performer is one we cannot
    // stand behind, the footer has to say so by name rather than in general.
    var warned = rows.filter(function (e) { return e.warn; });
    // Whichever era leads on return is the row a reader anchors on, so the
    // footer addresses that row by name. There are two separate ways it can be
    // misleading and they need different sentences: the number cannot be
    // attributed, or there is not enough of it to be a number at all.
    var best = rows.reduce(function (m, e) {
      return (e.roi != null && (!m || e.roi > m.roi)) ? e : m;
    }, null);
    var lead = '';
    if (best && best.thin) {
      lead = 'The strongest return here is <b>' + esc(best.era) + '</b> at ' + signed(best.roi) + '%, '
        + 'on ' + plural(best.n, 'pick') + '. That is too few to be a result — small samples produce '
        + 'extreme numbers, which is exactly why it sits at the top. ';
    } else if (best && best.warn) {
      lead = 'The strongest return here is <b>' + esc(best.era) + '</b> at ' + signed(best.roi) + '%, '
        + 'and it is one of the rows we cannot stand behind. ';
    }

    $('trEraFoot').innerHTML = (warned.length || (best && best.thin))
      ? '<span class="tr-pill tr-pill-danger">Do not read the top row as our best era</span> ' + lead
        + (warned.length
          ? esc(warned.map(function (e) { return e.era; }).join(' and '))
            + (warned.length > 1 ? ' are flagged' : ' is flagged')
            + ' because the return cannot be attributed to a read on the market — either the fair line '
            + 'came from the same book we bet, or the pricing was never recorded. They stay on this '
            + 'page: deleting an era we do not like would flatter the record.'
          : '')
      : 'Eras are listed oldest first. Ordering them by return would hide when each one ran.';
    $('trEraSec').hidden = false;
  }

  // ---- CLV --------------------------------------------------------------
  function renderClv(j, bu) {
    if (j.clv == null || !j.clvN) return;
    var excluded = j.clvLineMoved || 0;
    $('trClvBody').innerHTML =
      '<div class="tr-big tone-model">' + signed(j.clv, 2) + '%</div>'
      + '<p>Average move in the vig-free market toward our side between posting and first pitch, '
      + 'across ' + j.clvN.toLocaleString() + ' comparable picks. '
      + (j.clvBeatRate != null ? 'The line moved our way on ' + num(j.clvBeatRate) + '% of them. ' : '')
      + '</p>'
      + (excluded
        ? '<p class="tr-note">' + excluded.toLocaleString() + ' more picks are excluded because the '
          + 'line itself moved, which makes entry and close different bets. They are left out rather '
          + 'than counted as zero — counting them would quietly pull the average toward nothing.</p>'
        : '');
    $('trClvCard').hidden = false;
  }

  // ---- The log ----------------------------------------------------------
  // Scope is stored so re-rendering after a toggle does not re-fetch. The two
  // populations are genuinely different records, not a filter on one — which is
  // exactly why switching has to change the note as well as the rows.
  var LOG_SCOPE = 'posted';
  var LOG_DATA = null;

  function renderLogScope() {
    var host = $('trLogScope');
    if (!host || !LOG_DATA) return;
    var opts = [
      { key: 'posted', label: 'Posted unders', n: LOG_DATA.scope.postedN },
      { key: 'all', label: 'Full model log', n: LOG_DATA.scope.allN },
    ];
    host.innerHTML = opts.map(function (o) {
      return '<button type="button" class="tr-scope' + (o.key === LOG_SCOPE ? ' active' : '') + '"'
        + ' data-scope="' + o.key + '">' + esc(o.label)
        + '<span class="tr-scope-n">' + o.n.toLocaleString() + '</span></button>';
    }).join('');
    host.onclick = function (e) {
      var b = e.target.closest('.tr-scope');
      if (!b || b.dataset.scope === LOG_SCOPE) return;
      LOG_SCOPE = b.dataset.scope;
      renderLogScope();
      renderLog(LOG_DATA.posted, LOG_DATA.all, LOG_DATA.bu, LOG_DATA.scope);
    };
  }

  function renderLog(posted, all, bu, scope) {
    LOG_DATA = { posted: posted, all: all, bu: bu, scope: scope };
    var rows = LOG_SCOPE === 'all' ? all : posted;
    if (!rows.length) return;
    var RESULT_TONE = { win: 'good', loss: 'bad', push: 'dim' };
    // The note carries the warning, because these rows sit under headline stats
    // they are not part of. Saying "full log" without saying that would let a
    // reader count a K prop toward a record that never included one.
    $('trLogSub').textContent = LOG_SCOPE === 'all'
      ? scope.allNote
      : 'the posted market — these are the picks every number above describes';
    renderLogScope();
    $('trLog').innerHTML = tableHtml(
      ['Date', 'Pick', 'Market', 'Price', 'Call', 'Result', 'CLV'],
      rows.map(function (r) {
        // Strikeout rows are keyed by game, not by player, so they carry a team
        // and no pitcher name. "— BAL" reads as missing data; "BAL starter" says
        // what the row actually is. A dash is for a value we expected and lack.
        var who = r.player
          ? '<b>' + esc(r.player) + '</b>'
            + (r.team ? ' <span class="tr-team">' + esc(r.team) + '</span>' : '')
          : (r.team ? '<b>' + esc(r.team) + ' starter</b>' : '<span class="tr-dash">—</span>');
        var pick = who + '<span class="tr-line">' + esc(r.side) + ' ' + esc(r.line) + '</span>';
        return [
          '<span class="tr-date">' + esc(r.date) + '</span>',
          pick,
          esc(r.market || '—'),
          money(r.price),
          // A row that was never posted says so, rather than borrowing a tier
          // chip that would imply it was once a candidate.
          r.posted === false ? '<span class="tr-dash">not posted</span>'
            : esc(r.tier === 'play' ? 'Play' : 'T' + r.tier),
          '<span class="tone-' + (RESULT_TONE[r.result] || 'dim') + '">' + esc(r.result) + '</span>',
          // Zero CLV is grey, never red: it is "the line did not move", not a loss.
          r.clv == null ? '<span class="tr-dash">—</span>' : cellTone(signed(r.clv) + '%', r.clv),
        ];
      }));
    var total = LOG_SCOPE === 'all' ? scope.allN : bu.n;
    $('trLogFoot').textContent = 'Graded from the official box score the morning after. '
      + 'Showing the most recent ' + rows.length + ' of ' + total.toLocaleString()
      + (LOG_SCOPE === 'all'
        ? ' graded model rows. Only the posted unders are in the record above.'
        : ' graded picks — the tables above describe the whole sample.');
    $('trLogSec').hidden = false;
  }

  // ---- shared -----------------------------------------------------------
  // Zero renders neutral, never red. Zero units is not a loss and a bare zero
  // never takes a minus sign.
  function cellTone(text, v) {
    var cls = v == null || v === 0 ? 'dim' : v > 0 ? 'good' : 'bad';
    return '<span class="tone-' + cls + '">' + esc(text) + '</span>';
  }

  function tableHtml(heads, rows, rowClasses) {
    return '<div class="tr-thead">' + heads.map(function (h, i) {
      return '<span' + (i === 0 ? '' : ' class="tr-r"') + '>' + esc(h) + '</span>';
    }).join('') + '</div>'
      + rows.map(function (cells, ri) {
        return '<div class="tr-tr ' + ((rowClasses && rowClasses[ri]) || '') + '">'
          + cells.map(function (c, i) { return '<span' + (i === 0 ? '' : ' class="tr-r"') + '>' + c + '</span>'; }).join('')
          + '</div>';
      }).join('');
  }
})();
