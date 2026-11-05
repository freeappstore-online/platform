import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fsFileSource } from '../lib/file-source.js';
import { checkNoTracking } from './no-tracking.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fas-compliance-'));
  await mkdir(join(dir, 'web'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('checkNoTracking', () => {
  it('passes when no tracking strings anywhere', async () => {
    await writeFile(join(dir, 'web', 'app.ts'), 'export const x = 1;');
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('fails on google-analytics in source', async () => {
    await writeFile(
      join(dir, 'web', 'index.html'),
      '<script src="https://www.google-analytics.com/analytics.js"></script>',
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/google-analytics/);
  });

  it('fails on a tracker URL inside a JS string (the // is not a comment)', async () => {
    await writeFile(
      join(dir, 'web', 'app.ts'),
      "const s = document.createElement('script'); s.src = 'https://www.google-analytics.com/analytics.js';",
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('fail');
  });

  it('fails on plausible / posthog as deps even though those are privacy-respecting', async () => {
    // FreeAppStore policy is *no* analytics, even the privacy-respecting ones.
    await writeFile(join(dir, 'web', 'package.json'), '{"dependencies":{"posthog-js":"1.0.0"}}');
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/posthog/);
  });

  it('does not scan dist or node_modules (skipped by walk)', async () => {
    await mkdir(join(dir, 'node_modules', 'posthog-js'), { recursive: true });
    await writeFile(join(dir, 'node_modules', 'posthog-js', 'index.js'), '// posthog stuff');
    await mkdir(join(dir, 'dist'));
    await writeFile(join(dir, 'dist', 'bundle.js'), 'amplitude.track("x")');
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  // --- ambiguous-English-word false positives that bit billiards / pinball ---

  it('does not flag the bare word "segment" as a geometry term', async () => {
    await writeFile(
      join(dir, 'web', 'physics.ts'),
      [
        '// Closest point on segment a→b',
        'function projectOntoSegment(p, a, b) { return p; }',
        'const segment = { a, b };',
        'const collideSegment = (x) => x;',
      ].join('\n'),
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('flags Segment analytics SDK by scoped import', async () => {
    await writeFile(
      join(dir, 'web', 'analytics.ts'),
      "import { AnalyticsBrowser } from '@segment/analytics-next';",
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/segment/);
  });

  it('flags Segment analytics SDK by window.analytics.track call', async () => {
    await writeFile(
      join(dir, 'web', 'page.ts'),
      "window.analytics.track('button_click', { id: 'x' });",
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/segment/);
  });

  it('does not flag the bare word "amplitude" as an oscillation parameter', async () => {
    await writeFile(
      join(dir, 'web', 'shake.ts'),
      [
        '// tilt shake amplitude in pixels',
        'const amplitude = 6;',
        'function applyShake(t, amplitude) { return amplitude * Math.sin(t); }',
      ].join('\n'),
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('flags Amplitude SDK by scoped import', async () => {
    await writeFile(
      join(dir, 'web', 'analytics.ts'),
      "import * as amplitude from '@amplitude/analytics-browser';",
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/amplitude/);
  });

  it('flags Amplitude SDK by .init() call', async () => {
    await writeFile(
      join(dir, 'web', 'analytics.ts'),
      "amplitude.init('API_KEY', 'user@example.com');",
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/amplitude/);
  });

  it('does not flag a variable named gtag in unrelated code', async () => {
    // `gtag` as a bare identifier is extremely rare outside GA, but make sure
    // a stray variable named gtag (e.g. in a typing-game word list) doesn't trip.
    await writeFile(join(dir, 'web', 'wordlist.ts'), "const words = ['gtag', 'span', 'div'];");
    const r = await checkNoTracking(fsFileSource(dir));
    // The pattern requires `gtag(` or `window.gtag` — a string literal alone passes.
    expect(r.status).toBe('pass');
  });

  it('flags gtag config call', async () => {
    await writeFile(join(dir, 'web', 'index.html'), "<script>gtag('config', 'G-XXXX');</script>");
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/gtag/);
  });

  // --- one real install per tracker the check knows ---

  it('flags Google Analytics by a react-ga4 dependency', async () => {
    await writeFile(join(dir, 'package.json'), '{"dependencies":{"react-ga4":"^2.1.0"}}');
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/google-analytics/);
  });

  it('flags the GA4 install snippet (gtag.js loader + gtag calls)', async () => {
    await writeFile(
      join(dir, 'web', 'index.html'),
      [
        '<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXX"></script>',
        '<script>window.dataLayer = window.dataLayer || [];',
        "function gtag(){dataLayer.push(arguments);} gtag('js', new Date()); gtag('config', 'G-XXXX');</script>",
      ].join('\n'),
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/google-analytics, gtag/);
  });

  it('flags Mixpanel by mixpanel-browser import and init call', async () => {
    await writeFile(
      join(dir, 'web', 'analytics.ts'),
      "import mixpanel from 'mixpanel-browser';\nmixpanel.init('TOKEN');",
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/mixpanel/);
  });

  it('flags Mixpanel by the CDN loader URL', async () => {
    await writeFile(
      join(dir, 'web', 'index.html'),
      '<script src="https://cdn.mxpnl.com/libs/mixpanel-2-latest.min.js"></script>',
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/mixpanel/);
  });

  it('flags Segment by the cdn.segment.com snippet', async () => {
    await writeFile(
      join(dir, 'web', 'index.html'),
      '<script>t.src="https://cdn.segment.com/analytics.js/v1/KEY/analytics.min.js"</script>',
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/segment/);
  });

  it('flags the Hotjar install snippet', async () => {
    await writeFile(
      join(dir, 'web', 'index.html'),
      "<script>(function(h,o,t,j,a,r){h.hj=h.hj||function(){(h.hj.q=h.hj.q||[]).push(arguments)};h._hjSettings={hjid:123,hjsv:6};a=o.getElementsByTagName('head')[0];r=o.createElement('script');r.async=1;r.src=t+h._hjSettings.hjid+j+h._hjSettings.hjsv;a.appendChild(r);})(window,document,'https://static.hotjar.com/c/hotjar-','.js?sv=');</script>",
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/hotjar/);
  });

  it('flags Hotjar by the @hotjar/browser package', async () => {
    await writeFile(join(dir, 'web', 'hj.ts'), "import Hotjar from '@hotjar/browser';");
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/hotjar/);
  });

  it('flags the Plausible script tag', async () => {
    await writeFile(
      join(dir, 'web', 'index.html'),
      '<script defer data-domain="example.com" src="https://plausible.io/js/script.js"></script>',
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/plausible/);
  });

  it('flags Plausible by the plausible-tracker package in package.json', async () => {
    await writeFile(
      join(dir, 'web', 'package.json'),
      '{"devDependencies":{"plausible-tracker":"^0.3.9"}}',
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/plausible/);
  });

  it('flags PostHog by posthog-js import and init call', async () => {
    await writeFile(
      join(dir, 'web', 'analytics.ts'),
      "import posthog from 'posthog-js';\nposthog.init('phc_KEY', { api_host: 'https://us.i.posthog.com' });",
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/posthog/);
  });

  it('flags a tracker SDK pulled from a CDN by dynamic import', async () => {
    await writeFile(
      join(dir, 'web', 'lazy.ts'),
      "const { default: posthog } = await import('https://esm.sh/posthog-js@1.200.0');",
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/posthog/);
  });

  // --- tracker names as plain words in data are not an install ---

  it('does not flag prose containing "plausible", "segment" or "mixpanel" in a data JSON', async () => {
    await mkdir(join(dir, 'web', 'public', 'catalog'), { recursive: true });
    await writeFile(
      join(dir, 'web', 'public', 'catalog', 'the-time-machine.json'),
      JSON.stringify({
        title: 'The Time Machine',
        text: '“It sounds plausible enough tonight,” said the Medical Man; a segment of the audience, a mixpanel of doubt.',
      }),
    );
    await writeFile(join(dir, 'web', 'app.ts'), 'export const x = 1;');
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('does not flag tracker package names quoted as data in a non-package JSON', async () => {
    await writeFile(
      join(dir, 'web', 'blocklist.json'),
      '{"blocked":["posthog-js","mixpanel-browser","plausible.io","static.hotjar.com"]}',
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('does not flag tracker names in a word list string in code', async () => {
    await writeFile(
      join(dir, 'web', 'words.ts'),
      "export const words = ['plausible', 'mixpanel', 'hotjar', 'posthog', 'segment'];",
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('does not flag a package.json whose dependencies are not trackers', async () => {
    await writeFile(
      join(dir, 'web', 'package.json'),
      '{"name":"plausible-stories","description":"mixpanel of plausible tales","dependencies":{"react":"^19.0.0","@freeappstore/sdk":"^1.0.0"}}',
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  // --- comment-stripping regression guards ---

  it('ignores tracker names that only appear in a // line comment', async () => {
    await writeFile(
      join(dir, 'web', 'App.tsx'),
      '// We do NOT use google-analytics. See platform policy.\nexport {};',
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('ignores tracker names inside a /** JSDoc */ block', async () => {
    await writeFile(
      join(dir, 'web', 'lib.ts'),
      '/** Do not add @amplitude/analytics-browser here. */\nexport {};',
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });

  it('ignores tracker references inside <!-- HTML --> comments', async () => {
    await writeFile(
      join(dir, 'web', 'index.html'),
      '<!-- This site does NOT load google-analytics or @amplitude/* -->\n<body></body>',
    );
    const r = await checkNoTracking(fsFileSource(dir));
    expect(r.status).toBe('pass');
  });
});
