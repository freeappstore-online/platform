/** Auditor fixture router. The external module keeps the fixture CSP-clean. */
const params = new URLSearchParams(location.search);
const scenario = params.get('scenario') || '';

const scenarios = {
  fits: { html: '<div class="fixture-padded"><h2>Fits cleanly</h2><p>Trivial layout that fits at every reference viewport.</p></div>', expect: 'all viewports pass; clipping=[]; score=99' },
  'scroll-x': { html: '<div class="content"><h2>Horizontal scroll</h2><p>9999px wide.</p></div>', expect: 'scrollsX=true at every viewport' },
  'scroll-y': { html: '<div class="content"><h2>Vertical scroll</h2><p>9999px tall.</p></div>', expect: 'scrollsY=true at every viewport' },
  'clip-inner': { html: '<div class="fixture-padded"><h2>Inner horizontal clip</h2><div class="clipper"><div class="child">9999px wide child inside an overflow:hidden 100px parent.</div></div></div>', expect: 'document fits; clipping[].length >= 1; clipsX=true' },
  'clip-inner-y': { html: '<div class="fixture-padded"><h2>Inner vertical clip</h2><div class="clipper"><div class="child">999px tall child inside a 50px parent.</div></div></div>', expect: 'document fits; clipping[].length >= 1; clipsY=true' },
  'vh-bug': { html: '<div class="full"><h2>100vh container</h2><p>iOS Safari URL-bar bug — at the URL-bar-visible viewport this scrolls.</p></div>', expect: 'scrollsY=true when iframe height < 100vh resolved value' },
  'gap-mid': { html: '<div class="gap"><h2>Gap in the middle</h2><div class="force">Forces overflow at 600-768 widths only.</div></div>', expect: 'fails at 600/768 portrait; passes elsewhere → score reflects bucket gap' },
  'landscape-only-bad': { html: '<div class="ok"><h2>Landscape-only bug</h2><p>Portrait perfect; landscape forces 1500px width.</p></div>', expect: 'portrait=99; landscape low; overall=min' },
  'no-reporter': { html: '<div class="fixture-padded"><h2>Non-cooperative</h2><p>This scenario does NOT import @freeappstore/quality. Dashboard should time out → "?" cell.</p></div>', expect: 'no postMessage ever; dashboard shows opt-out badge' },
  'large-scrollwidth-fp': { html: `<div class="grid">${Array(20).fill('<div></div>').join('')}</div>`, expect: 'no clipping reported (within 1px tolerance)' },
};

const escapeHtml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

if (!scenario) {
  document.body.innerHTML = `<div class="index"><h1>Auditor Fixture</h1><div class="meta">Deliberately-broken control cases. Each verifies the platform auditor flags a specific class of layout bug.</div><div class="banner"><strong>Not a real app.</strong> Each scenario reproduces a known bug. Don't use these as templates.</div><ul>${Object.entries(scenarios).map(([id, value]) => `<li><a href="?scenario=${id}"><code>?scenario=${id}</code></a> — ${value.expect}</li>`).join('')}</ul><p class="index-foot">See live audit output at <a href="/quality?app=auditor-fixture">/quality?app=auditor-fixture</a>.</p></div>`;
} else if (!scenarios[scenario]) {
  document.body.innerHTML = `<div class="index"><h1>Unknown scenario</h1><p>?scenario=${escapeHtml(scenario)} is not defined.</p><p><a href="?">All scenarios</a></p></div>`;
} else {
  document.body.dataset.scenario = scenario;
  document.body.insertAdjacentHTML('afterbegin', `<div class="scenario-banner">FIXTURE: ${scenario}</div>`);
  document.body.insertAdjacentHTML('beforeend', scenarios[scenario].html);

  // The intentional opt-out is the only scenario that must not report.
  if (scenario !== 'no-reporter') {
    import('https://esm.sh/@freeappstore/quality@0.1.0')
      .then(({ initQualityReporter }) => initQualityReporter())
      .catch((error) => console.warn('[fixture] reporter import failed:', error));
  }
}
