import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fsFileSource } from '../lib/file-source.js';
import { checkNoAds } from './no-ads.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fas-compliance-'));
  await mkdir(join(dir, 'web', 'src'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const run = () => checkNoAds(fsFileSource(dir));
const write = (path: string, content: string) => writeFile(join(dir, path), content);

// FreeAppStore apps show no ads.
describe('checkNoAds', () => {
  it('passes ordinary code that uses ad-like words', async () => {
    await write(
      'web/src/App.tsx',
      [
        "const ads = ['Classified ads', 'Ad hoc', 'adsense revenue calculator'];",
        'function adBreak(minutes: number) { return minutes * 60; }',
        'adBreak(5);',
        'const adConfig = { padding: 4 };',
        '<span onDoubleClick={() => edit()} />;',
        "const banner = 'Sponsored by nobody';",
        "const googletag = 'x'; googletag.cmd = [];",
        "const pbjs = { version: 1 }; const apstag = 'id';",
        "const note = 'Read about media.net and outbrain in the news';",
        "const keywords = ['adsense', 'taboola'];",
      ].join('\n'),
    );
    await write(
      'web/package.json',
      JSON.stringify({ dependencies: { react: '^19.0.0', 'react-chatgpt': '^1.0.0' } }),
    );
    expect((await run()).status).toBe('pass');
  });

  it('does not treat Google Tag Manager (tracking check territory) as an ad network', async () => {
    await write(
      'web/index.html',
      '<script async src="https://www.googletagmanager.com/gtag/js?id=G-X"></script>',
    );
    expect((await run()).status).toBe('pass');
  });

  it.each([
    [
      'Google AdSense',
      '<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1234567890123456" crossorigin="anonymous"></script>',
    ],
    ['Google AdSense', '<ins class="adsbygoogle" data-ad-slot="1"></ins>'],
    ['Google AdSense', '(window.adsbygoogle = window.adsbygoogle || []).push({});'],
    ['Google AdSense', "import AdSense from 'react-adsense';"],
    ['Google AdSense', "import { AdsenseModule } from '@ctrl/ngx-adsense';"],
    [
      'Google Ad Manager (GPT)',
      '<script async src="https://securepubads.g.doubleclick.net/tag/js/gpt.js"></script>',
    ],
    [
      'Google Ad Manager (GPT)',
      "googletag.cmd.push(() => { googletag.defineSlot('/1/x', [300, 250], 'd').addService(googletag.pubads()); });",
    ],
    ['Google IMA SDK', "s.src = 'https://imasdk.googleapis.com/js/sdkloader/ima3.js';"],
    ['Google IMA SDK', 'const loader = new google.ima.AdsLoader(container);'],
    ['Google H5 Games Ads / AdMob', "adBreak({ type: 'next', name: 'level-done' });"],
    ['Google H5 Games Ads / AdMob', "adConfig({ preloadAdBreaks: 'on' });"],
    ['Google H5 Games Ads / AdMob', "import { AdMob } from '@capacitor-community/admob';"],
    [
      'Amazon Publisher Services',
      "s.src = 'https://c.amazon-adsystem.com/aax2/apstag.js'; apstag.init({ pubID: 'x' });",
    ],
    ['Amazon Publisher Services', 'apstag.fetchBids({ slots }, cb);'],
    ['Prebid.js', 'pbjs.que.push(() => pbjs.requestBids({ bidsBackHandler }));'],
    ['Media.net', "s.src = 'https://contextual.media.net/dmedianet.js?cid=8CU';"],
    [
      'Carbon Ads',
      '<script async src="//cdn.carbonads.com/carbon.js?serve=X&placement=y" id="_carbonads_js"></script>',
    ],
    ['BuySellAds', "s.src = '//m.servedby-buysellads.com/monetization.js';"],
    [
      'EthicalAds',
      '<script async src="https://media.ethicalads.io/media/client/ethicalads.min.js"></script>',
    ],
    ['EthicalAds', '<div data-ea-publisher="me" data-ea-type="image"></div>'],
    ['Ezoic', '<script src="//www.ezojs.com/ezoic/sa.min.js"></script>'],
    ['PropellerAds', "s.src = 'https://propellerads.com/tag.js';"],
    ['Adsterra', "s.src = '//www.highperformanceformat.com/abc/invoke.js';"],
    [
      'Taboola',
      "window._taboola = window._taboola || []; s.src = '//cdn.taboola.com/libtrc/x/loader.js';",
    ],
    ['Outbrain', '<script async src="//widgets.outbrain.com/outbrain.js"></script>'],
    ['Poki SDK ads', 'PokiSDK.commercialBreak().then(resume);'],
    ['CrazyGames SDK ads', "window.CrazyGames.SDK.ad.requestAd('midgame', cbs);"],
    ['GameDistribution SDK', "gdsdk.showAd('rewarded');"],
    ['GameMonetize SDK', "s.src = 'https://api.gamemonetize.com/sdk.js';"],
  ])('fails on %s: %s', async (name, code) => {
    const file = code.trimStart().startsWith('<') ? 'web/index.html' : 'web/src/ads.ts';
    await write(file, code);
    const r = await run();
    expect(r.status).toBe('fail');
    expect(r.detail).toContain(name);
    expect(r.suggestions?.join(' ')).toContain('no ads');
  });

  it.each([
    ['react-adsense', '^2.0.0'],
    ['prebid.js', '^9.0.0'],
    ['@capacitor-community/admob', '^6.0.0'],
    ['videojs-ima', '^2.3.0'],
  ])('fails on an ad SDK dependency in package.json: %s', async (dep, version) => {
    await write(
      'web/package.json',
      JSON.stringify({ dependencies: { [dep]: version, react: '^19.0.0' } }, null, 2),
    );
    expect((await run()).status).toBe('fail');
  });

  it('ignores ad networks that are only mentioned in comments or tests', async () => {
    await write(
      'web/src/App.tsx',
      '// No ads: never load pagead2.googlesyndication.com or adsbygoogle here\nexport const x = 1;',
    );
    await write('web/index.html', '<!-- no <script src="https://cdn.carbonads.com/carbon.js"> -->');
    await mkdir(join(dir, 'web', 'e2e'), { recursive: true });
    await write('web/e2e/no-ads.spec.ts', 'expect(window.adsbygoogle).toBeUndefined();');
    await write(
      'web/src/ads.test.ts',
      "expect(html).not.toContain('securepubads.g.doubleclick.net');",
    );
    expect((await run()).status).toBe('pass');
  });
});
