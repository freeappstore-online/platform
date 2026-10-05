/**
 * Creator analytics dashboard for FreeAppStore.
 *
 * One page, two states:
 *   /analytics.html                — list each app you own with a small
 *                                    KPI row (7-day page views).
 *   /analytics.html?app=<id>       — full dashboard: KPIs, daily chart,
 *                                    top paths / referrers / countries /
 *                                    device split, plus a form to wire
 *                                    GA4 / Plausible / custom <head>.
 *
 * Backed by:
 *   GET  /v1/apps/mine
 *   GET  /v1/apps/:id/analytics
 *   PUT  /v1/apps/:id/analytics
 *   GET  /v1/apps/:id/analytics/stats?days=N
 *
 * Auth: shared session cookie + bearer token via fas:token in localStorage
 * (set by auth.js after sign-in). No token → render the sign-in CTA.
 */

(function () {
  var API = 'https://api.freeappstore.online';
  var TOKEN_KEY = 'fas:token';
  var root = document.getElementById('a-content');
  if (!root) return;

  function token() {
    try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; }
  }

  function fmtViews(n) {
    if (n < 1000) return String(n);
    if (n < 10000) return (n / 1000).toFixed(1) + 'k';
    if (n < 1e6) return Math.round(n / 1000) + 'k';
    return (n / 1e6).toFixed(1) + 'M';
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'class') node.className = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k === 'onclick') node.addEventListener('click', attrs[k]);
      else node.setAttribute(k, attrs[k]);
    }
    if (children) {
      if (typeof children === 'string') node.textContent = children;
      else for (var i = 0; i < children.length; i++) {
        if (children[i] != null) node.appendChild(typeof children[i] === 'string' ? document.createTextNode(children[i]) : children[i]);
      }
    }
    return node;
  }

  function call(path, opts) {
    var t = token();
    if (!t) return Promise.reject(new Error('not signed in'));
    var init = opts || {};
    init.headers = init.headers || {};
    init.headers['Authorization'] = 'Bearer ' + t;
    return fetch(API + path, init).then(function (r) {
      if (!r.ok) return r.text().then(function (msg) { throw new Error('HTTP ' + r.status + ': ' + msg.slice(0, 200)); });
      return r.json();
    });
  }

  function renderSignInCTA() {
    root.replaceChildren(el('div', { class: 'a-card' }, [
      el('p', null, 'Sign in to see analytics for your apps.'),
      el('p', { class: 'meta' }, [
        el('a', { class: 'a-signin', href: '/' }, 'Sign in on the home page'),
        ' — your dashboard will load here.'
      ])
    ]));
  }

  function renderEmpty() {
    root.replaceChildren(el('div', { class: 'a-card' }, [
      el('p', null, "You haven't published any apps yet."),
      el('p', { class: 'meta' }, [
        'Use the ',
        el('a', { class: 'a-signin', href: '/get-started.html' }, 'getting-started guide'),
        ' or VibeCode at console.freeappstore.online/create to publish one.'
      ])
    ]));
  }

  function renderList(apps) {
    if (!apps.length) return renderEmpty();
    root.replaceChildren.apply(root, apps.map(function (app) {
      var card = el('div', { class: 'a-card' }, [
        el('div', { class: 'a-header-bar' }, [
          el('div', null, [
            el('h2', null, app.id),
            el('div', { class: 'meta' }, app.appUrl + ' · ' + (app.category || 'uncategorized'))
          ]),
          el('a', { class: 'a-signin', href: '?app=' + encodeURIComponent(app.id) }, 'View →')
        ])
      ]);
      // Fire-and-forget mini KPI fetch per app
      var kpi = el('div', { class: 'a-kpis' }, [
        el('div', { class: 'a-kpi' }, [el('div', { class: 'label' }, '7d views'), el('div', { class: 'value' }, '…')]),
        el('div', { class: 'a-kpi' }, [el('div', { class: 'label' }, 'Unique paths'), el('div', { class: 'value' }, '…')]),
        el('div', { class: 'a-kpi' }, [el('div', { class: 'label' }, 'Top country'), el('div', { class: 'value' }, '…')])
      ]);
      card.appendChild(kpi);
      call('/v1/apps/' + encodeURIComponent(app.id) + '/analytics/stats?days=7')
        .then(function (r) {
          var s = r.stats;
          kpi.replaceChildren(
            el('div', { class: 'a-kpi' }, [el('div', { class: 'label' }, '7d views'), el('div', { class: 'value' }, fmtViews(s.total_views))]),
            el('div', { class: 'a-kpi' }, [el('div', { class: 'label' }, 'Unique paths'), el('div', { class: 'value' }, String(s.unique_paths))]),
            el('div', { class: 'a-kpi' }, [el('div', { class: 'label' }, 'Top country'), el('div', { class: 'value' }, (s.top_countries[0] && s.top_countries[0].country) || '—')])
          );
        })
        .catch(function () {
          kpi.replaceChildren(el('p', { class: 'meta' }, 'No data yet.'));
        });
      return card;
    }));
  }

  function labelForT(t, bucket) {
    // Hour bucket: "2026-05-21 14:00:00" → "14:00".
    // Day bucket:  "2026-05-21"          → "05-21".
    if (bucket === 'hour') return (t || '').slice(11, 16) || t || '';
    return (t || '').slice(5, 10) || t || '';
  }

  function renderChart(series, bucket) {
    bucket = bucket || 'day';
    if (!series.length) {
      return el('p', { class: 'meta' }, 'No ' + (bucket === 'hour' ? 'hourly' : 'daily') + ' data in this window.');
    }
    var W = 600, H = 100, gap = 2, slot = W / series.length;
    var maxV = Math.max(1, ...series.map(function (d) { return d.views; }));
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="width:100%;height:100px;display:block">';
    svg += '<line x1="0" x2="' + W + '" y1="' + (H - 0.5) + '" y2="' + (H - 0.5) + '" stroke="currentColor" stroke-opacity="0.15" />';
    series.forEach(function (d, i) {
      var h = (d.views / maxV) * (H - 2);
      svg += '<rect x="' + (i * slot) + '" y="' + (H - h) + '" width="' + Math.max(1, slot - gap) + '" height="' + h + '" fill="var(--accent)" opacity="' + (d.views > 0 ? 0.85 : 0.2) + '"><title>' + d.t + ': ' + d.views + ' views</title></rect>';
    });
    svg += '</svg>';
    var labels = '<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted);margin-top:4px">';
    labels += '<span>' + labelForT(series[0].t, bucket) + '</span><span>peak ' + maxV + '</span><span>' + labelForT(series[series.length - 1].t, bucket) + '</span></div>';
    return el('div', { class: 'a-chart', html: svg + labels });
  }

  function renderRanked(title, rows, onPick) {
    var max = Math.max(1, ...rows.map(function (r) { return r.value; }));
    var list = el('div', null);
    list.appendChild(el('div', { class: 'a-rank-title' }, title));
    if (!rows.length) {
      list.appendChild(el('p', { class: 'meta' }, 'No data.'));
    } else {
      rows.slice(0, 5).forEach(function (r) {
        // Inner content is the same whether the row is interactive. When
        // onPick is provided we wrap in a button — drives the path
        // drill-down on Top pages.
        var inner = [
          el('div', { class: 'label' }, [
            el('span', null, r.label || '/'),
            el('span', { class: 'meta' }, fmtViews(r.value))
          ]),
          el('div', { class: 'a-bar', html: '<div style="width:' + ((r.value / max) * 100) + '%"></div>' })
        ];
        if (typeof onPick === 'function') {
          var btn = el('button', { type: 'button', class: 'a-rank-row a-rank-row-button', title: 'Drill into ' + (r.label || '/') }, inner);
          btn.addEventListener('click', function () { onPick(r.label || '/'); });
          list.appendChild(btn);
        } else {
          list.appendChild(el('div', { class: 'a-rank-row' }, inner));
        }
      });
    }
    return list;
  }

  function renderConfigForm(appId, config) {
    var form = el('form', { class: 'a-form' });
    form.innerHTML =
      '<h3 style="font-size:0.85rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em;font-weight:700;margin-bottom:0.5rem">Add your own tags (optional)</h3>' +
      '<p class="meta" style="margin-bottom:0.75rem">Wire Google Analytics, Plausible, or a custom &lt;head&gt; snippet on top of the cookieless first-party tracking already in place.</p>';
    form.appendChild(el('label', null, [el('span', null, 'Google Analytics 4 ID'), el('input', { type: 'text', name: 'ga4', placeholder: 'G-XXXXXXXXXX', value: config.ga4 || '' })]));
    form.appendChild(el('label', null, [el('span', null, 'Plausible domain'), el('input', { type: 'text', name: 'plausible', placeholder: 'mysite.com', value: config.plausible || '' })]));
    form.appendChild(el('label', null, [el('span', null, 'Custom <head> snippet (max 4 KB)'), el('textarea', { rows: '3', name: 'custom_head', placeholder: '<meta name="custom" content="..." />' }, config.customHead || '')]));
    var status = el('span', null, '');
    var btn = el('button', { type: 'submit' }, 'Save analytics tags');
    var row = el('div', null, [btn, status]);
    form.appendChild(row);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var fd = new FormData(form);
      btn.disabled = true;
      status.className = '';
      status.textContent = 'Saving…';
      call('/v1/apps/' + encodeURIComponent(appId) + '/analytics', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ga4: fd.get('ga4') || null,
          plausible: fd.get('plausible') || null,
          custom_head: fd.get('custom_head') || null
        })
      }).then(function () {
        status.className = 'ok';
        status.textContent = 'Saved.';
        setTimeout(function () { status.textContent = ''; status.className = ''; }, 2000);
      }).catch(function (err) {
        status.className = 'err';
        status.textContent = err.message;
      }).finally(function () { btn.disabled = false; });
    });
    return form;
  }

  /**
   * Smart empty state. Replaces the placeholder "checking why..." with a
   * verdict-shaped hint after /analytics/diagnostics resolves. Different
   * verdicts surface different copy + actionable next steps.
   */
  function renderDiagnostics(slot, diag, noun, windowLabel, isCustom, kind) {
    if (!diag) return;
    if (diag.verdict === 'ok') {
      // Verdict says ok but views=0 — usually means we're viewing a custom
      // event nobody's fired yet. Just say so simply.
      var msg = isCustom
        ? 'No ' + noun + ' ' + windowLabel + '. Once your app calls window.fasAnalytics.event("' + kind + '", ...) and a visitor triggers it, the counts will appear here.'
        : 'No ' + noun + ' ' + windowLabel + ' yet.';
      slot.replaceChildren(el('p', { class: 'a-empty' }, msg));
      return;
    }

    var heading = el('h4', { class: 'a-diag-heading' }, 'No ' + noun + ' ' + windowLabel + '. Here\'s why:');
    var box = el('div', { class: 'a-diag-box' }, [heading]);
    var ul = el('ul', { class: 'a-diag-list' });
    function step(ok, content) {
      var li = el('li', { class: ok ? 'a-diag-step ok' : 'a-diag-step bad' });
      li.innerHTML = (ok ? '<span class="a-diag-mark ok">✓</span>' : '<span class="a-diag-mark bad">✕</span>') + ' ' + content;
      ul.appendChild(li);
    }
    var trailing = null;

    if (diag.verdict === 'no_dataset_binding') {
      step(diag.checks.dataset_bound, 'Workers Analytics Engine dataset bound on the backend Worker.');
      step(diag.checks.stats_queryable, 'CF Analytics SQL API credentials present.');
      trailing = el('p', { class: 'a-diag-foot', html: 'Platform-side config — the dashboard can\'t show numbers until the dataset binding is added to <code>wrangler.toml</code>. See <code>ANALYTICS-GO-LIVE.md</code> step 3.' });
    } else if (diag.verdict === 'no_stats_query') {
      step(true, 'Workers Analytics Engine dataset bound.');
      step(false, 'CF Analytics SQL API credentials missing — set <code>CF_ACCOUNT_ID</code> + <code>CF_ANALYTICS_API_TOKEN</code> as worker secrets.');
    } else if (diag.verdict === 'never_seen_event') {
      step(true, 'Backend wired (dataset bound + queryable).');
      step(false, 'No event has ever been recorded for this app — the loader script is probably missing from your HTML.');
      var paste = el('pre', { class: 'a-diag-paste' }, '<script src="' + diag.loader_url + '" defer></script>');
      trailing = el('div', null, [
        el('p', { class: 'a-diag-foot' }, 'Paste this into web/index.html <head>:'),
        paste
      ]);
    } else if (diag.verdict === 'silent_24h') {
      step(true, 'Loader has fired before (events recorded historically).');
      step(false, 'No events in the last 24 hours.');
      trailing = el('p', { class: 'a-diag-foot', html: 'Either the app has no traffic right now or the loader broke. Test directly: <a class="a-signin" href="' + diag.loader_url + '" target="_blank" rel="noreferrer"><code>' + diag.loader_url + '</code></a>' });
    }

    box.appendChild(ul);
    if (trailing) box.appendChild(trailing);
    slot.replaceChildren(box);
  }

  function renderCustomEventsPanel(eventsList, days, onPickKind) {
    var panel = el('div', { class: 'a-events-panel' });
    panel.appendChild(el('div', { class: 'a-rank-title' }, 'Custom events'));
    if (!eventsList.length) {
      var empty = el('p', { class: 'meta' });
      empty.innerHTML =
        'No custom events fired in the last ' + days + ' days. Fire one from your app code:' +
        '<code class="a-code-block">window.fasAnalytics.event(\'purchase\', {amount: 999})</code>';
      panel.appendChild(empty);
    } else {
      var list = el('ul', { class: 'a-events-list' });
      eventsList.forEach(function (ev) {
        var btn = el('button', { type: 'button', class: 'a-event-row' }, [
          el('span', { class: 'a-event-kind' }, ev.kind),
          el('span', { class: 'a-event-count' }, fmtViews(ev.count))
        ]);
        btn.addEventListener('click', function () { onPickKind(ev.kind); });
        list.appendChild(el('li', null, [btn]));
      });
      panel.appendChild(list);
    }
    return panel;
  }

  function renderDetail(appId) {
    root.replaceChildren(el('p', { class: 'a-empty' }, 'Loading ' + appId + '…'));
    var days = 7;
    var kind = 'pageview';
    // Path drill-down: empty string = no filter; non-empty = stats narrowed
    // to that single URL pathname.
    var path = '';
    var livePollerId = null;
    function isCustom() { return kind !== 'pageview'; }
    function isPathFiltered() { return path !== ''; }
    function load() {
      var qs = '?days=' + days + '&kind=' + encodeURIComponent(kind);
      if (path) qs += '&path=' + encodeURIComponent(path);
      Promise.all([
        call('/v1/apps/' + encodeURIComponent(appId) + '/analytics/stats' + qs),
        call('/v1/apps/' + encodeURIComponent(appId) + '/analytics'),
        call('/v1/apps/' + encodeURIComponent(appId) + '/analytics/events?days=' + days).catch(function () { return { events: [] }; })
      ]).then(function (results) {
        var statsRes = results[0];
        var stats = statsRes.stats;
        var bucket = statsRes.bucket || 'day';
        var config = results[1];
        var eventsList = results[2].events || [];
        var card = el('div', { class: 'a-card' });

        var headerLeft = el('div', null);
        if (isPathFiltered()) {
          var pathBackBtn = el('button', { type: 'button', class: 'a-back-link' }, '← back to all pages');
          pathBackBtn.addEventListener('click', function () { path = ''; load(); });
          headerLeft.appendChild(el('h2', null, [document.createTextNode('Path: '), el('code', { class: 'a-event-kind-h' }, path)]));
          headerLeft.appendChild(el('div', { class: 'meta' }, [
            el('a', { class: 'a-signin', href: '/analytics.html' }, '← all apps'),
            document.createTextNode(' · '),
            pathBackBtn
          ]));
        } else if (isCustom()) {
          var backBtn = el('button', { type: 'button', class: 'a-back-link' }, '← back to pageviews');
          backBtn.addEventListener('click', function () { kind = 'pageview'; load(); });
          headerLeft.appendChild(el('h2', null, [document.createTextNode('Event: '), el('code', { class: 'a-event-kind-h' }, kind)]));
          headerLeft.appendChild(el('div', { class: 'meta' }, [
            el('a', { class: 'a-signin', href: '/analytics.html' }, '← all apps'),
            document.createTextNode(' · '),
            backBtn
          ]));
        } else {
          headerLeft.appendChild(el('h2', null, appId));
          headerLeft.appendChild(el('div', { class: 'meta' }, [el('a', { class: 'a-signin', href: '/analytics.html' }, '← all apps')]));
        }

        var header = el('div', { class: 'a-header-bar' }, [
          headerLeft,
          (function () {
            var tabs = el('div', { class: 'a-tabs' });
            [1, 7, 30, 90].forEach(function (d) {
              var btn = el('button', { type: 'button' }, d + 'd');
              if (d === days) btn.className = 'active';
              btn.addEventListener('click', function () { days = d; load(); });
              tabs.appendChild(btn);
            });
            return tabs;
          })()
        ]);
        card.appendChild(header);

        var noun = isCustom() ? (kind + ' events') : 'page views';
        var windowLabel = days === 1 ? 'in the last 24h' : ('in the last ' + days + ' days');
        if (stats.total_views === 0) {
          // Render diagnostics-aware empty state. Placeholder first so the
          // dashboard structure doesn't reflow when the diag query resolves.
          var diagSlot = el('div', { class: 'a-diag-slot' }, [
            el('p', { class: 'a-empty' }, 'No ' + noun + ' ' + windowLabel + '. Checking why…')
          ]);
          card.appendChild(diagSlot);
          call('/v1/apps/' + encodeURIComponent(appId) + '/analytics/diagnostics')
            .then(function (diag) { renderDiagnostics(diagSlot, diag, noun, windowLabel, isCustom(), kind); })
            .catch(function () {
              // Diagnostics endpoint not deployed yet — leave the simple message.
            });
        } else {
          var kpiWindow = days === 1 ? '24h' : (days + 'd');
          card.appendChild(el('div', { class: 'a-kpis' }, [
            el('div', { class: 'a-kpi' }, [el('div', { class: 'label' }, kpiWindow + ' ' + (isCustom() ? 'events' : 'views')), el('div', { class: 'value' }, fmtViews(stats.total_views))]),
            el('div', { class: 'a-kpi' }, [el('div', { class: 'label' }, isCustom() ? 'Unique paths fired on' : 'Unique paths'), el('div', { class: 'value' }, String(stats.unique_paths))]),
            el('div', { class: 'a-kpi' }, [el('div', { class: 'label' }, 'Top country'), el('div', { class: 'value' }, (stats.top_countries[0] && stats.top_countries[0].country) || '—')])
          ]));
          card.appendChild(renderChart(stats.series || [], bucket));
          // Top pages list: clickable rows (drill into that path) when we're
          // looking at the aggregate. Hidden entirely when we're already
          // filtered to one path — would just show that single row.
          var gridChildren = [];
          if (!isPathFiltered()) {
            var topPagesPick = (!isCustom())
              ? function (label) { path = label; load(); }
              : undefined;
            gridChildren.push(renderRanked(isCustom() ? 'Top pages firing event' : 'Top pages', stats.top_paths.map(function (r) { return { label: r.path, value: r.views }; }), topPagesPick));
          }
          gridChildren.push(
            renderRanked('Top referrers', stats.top_referrers.map(function (r) { return { label: r.referrer || '(direct)', value: r.views }; })),
            renderRanked('Top countries', stats.top_countries.map(function (r) { return { label: r.country || '—', value: r.views }; })),
            renderRanked('Device', stats.device_split.map(function (r) { return { label: r.device, value: r.views }; }))
          );
          card.appendChild(el('div', { class: 'a-card-grid' }, gridChildren));
        }

        // Live "right now" widget — polled every 30s while this app's
        // detail view is in focus. Inserted after the chart so it's a
        // glance-able strip near the top, not buried at the bottom.
        var liveStrip = el('div', { class: 'a-live' });
        card.appendChild(liveStrip);

        // Only show the custom-events picker on the aggregate pageview view.
        // When viewing a custom event OR a path drill-down, the breadcrumb
        // back-link is the only navigation that makes sense.
        if (!isCustom() && !isPathFiltered()) {
          card.appendChild(renderCustomEventsPanel(eventsList, days, function (newKind) { kind = newKind; load(); }));
        }

        card.appendChild(renderConfigForm(appId, config));
        root.replaceChildren(card);

        // Kick off (or restart) live polling for this app. Previous timer
        // is cleared on every load() so changing tabs / kinds doesn't leak
        // intervals.
        if (livePollerId !== null) window.clearInterval(livePollerId);
        function tickLive() {
          call('/v1/apps/' + encodeURIComponent(appId) + '/analytics/live').then(function (live) {
            renderLiveStrip(liveStrip, live);
          }).catch(function () { /* endpoint not deployed yet — stay silent */ });
        }
        tickLive();
        livePollerId = window.setInterval(tickLive, 30000);
      }).catch(function (err) {
        root.replaceChildren(el('p', { class: 'a-empty' }, 'Error: ' + err.message));
      });
    }
    load();
  }

  function renderLiveStrip(node, live) {
    if (!live) return;
    var hot = '';
    if (Array.isArray(live.top_paths) && live.top_paths.length > 0) {
      hot = ' · hot now: ' + live.top_paths.slice(0, 3).map(function (p) {
        return '<span class="a-live-path">' + (p.path || '/') + '</span> <span class="meta">(' + p.views + ')</span>';
      }).join(', ');
    }
    var dotClass = live.views > 0 ? 'a-live-dot a-live-dot-on' : 'a-live-dot';
    node.innerHTML =
      '<span class="' + dotClass + '"></span>' +
      '<span><b>' + fmtViews(live.views) + '</b> page view' + (live.views === 1 ? '' : 's') +
      ' in the last 5 min' + hot + '</span>';
  }

  function main() {
    if (!token()) return renderSignInCTA();
    var urlAppId = new URLSearchParams(location.search).get('app');
    if (urlAppId) return renderDetail(urlAppId);
    call('/v1/apps/mine').then(function (r) {
      renderList(r.apps || []);
    }).catch(function (err) {
      root.replaceChildren(el('p', { class: 'a-empty' }, 'Error: ' + err.message));
    });
  }

  // The token might be set by auth.js after init runs; listen for the
  // fas:auth-ready event that auth.js fires when it finishes hydrating.
  if (token()) main();
  else {
    window.addEventListener('fas:auth-ready', main, { once: true });
    // Fallback: if the event never fires (e.g. silent failure), try again
    // after 500ms — auth.js usually finishes well within that.
    setTimeout(main, 500);
  }
})();
