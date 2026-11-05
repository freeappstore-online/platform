import { describe, expect, it } from 'vitest';
import { mapFileSource } from '../lib/file-source.js';
import { checkArtifactIcons } from './artifact-icons.js';
import { validateBuildTarget } from './build-target.js';

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32"/></svg>';
function source(html: string) {
  return new Map([
    [
      'fas.json',
      JSON.stringify({ appId: 'carry-kit', applicationRoot: 'client', outputPath: 'release/site' }),
    ],
    ['package.json', JSON.stringify({ scripts: { build: 'pnpm --dir client build' } })],
    ['client/index.html', '<script src="/app.js"></script>'],
    ['client/app.js', 'console.log("source")'],
    ['release/site/index.html', `${html}<script src="/app.js"></script>`],
    ['release/site/app.js', 'console.log("App ready")'],
    ['release/site/icon.svg', svg],
    [
      'release/site/assets/app.webmanifest',
      JSON.stringify({ icons: [{ src: './icons/logo.svg', sizes: 'any' }] }),
    ],
    ['release/site/assets/icons/logo.svg', svg],
  ]);
}
describe('declared artifact icons', () => {
  it('supports custom output and relative manifest icon paths', async () => {
    const files = source(
      '<link rel="icon" href="/icon.svg"><link href="assets/app.webmanifest" rel="manifest">',
    );
    expect(await checkArtifactIcons(mapFileSource(files), 'release/site')).toMatchObject({
      status: 'pass',
      detail: expect.stringContaining('2 local'),
    });
    expect((await validateBuildTarget(mapFileSource(files), { artifact: true })).status).toBe(
      'pass',
    );
  });
  it('resolves a deployment base without requiring its prefix in the build directory', async () => {
    const files = source('<base href="/cue-scroll/"><link rel="icon" href="icon.svg">');
    expect((await checkArtifactIcons(mapFileSource(files), 'release/site')).status).toBe('pass');
  });
  it('rejects missing or fake assets in the existing build-target validator', async () => {
    const files = source('<link rel="icon" href="/icon.svg">');
    files.delete('release/site/icon.svg');
    expect((await validateBuildTarget(mapFileSource(files), { artifact: true })).detail).toContain(
      'Missing or empty icon',
    );
    files.set('release/site/icon.svg', '<html>Fallback</html>');
    expect((await checkArtifactIcons(mapFileSource(files), 'release/site')).status).toBe('fail');
  });
  it('reports external and undeclared icons without fetching or claiming browser verification', async () => {
    expect(
      await checkArtifactIcons(
        mapFileSource(source('<link rel="icon" href="https://cdn.example/icon.svg">')),
        'release/site',
      ),
    ).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('1 external declarations not fetched'),
    });
    expect(
      (
        await checkArtifactIcons(
          mapFileSource(source('<!-- <link rel="icon" href="/missing.svg"> -->')),
          'release/site',
        )
      ).status,
    ).toBe('warn');
  });
  it('checks actual PNG header dimensions against declarations', async () => {
    const files = source('<link rel="apple-touch-icon" sizes="180x180" href="/touch.png">');
    const base = mapFileSource(files);
    const png = new Uint8Array(45);
    png.set([137, 80, 78, 71, 13, 10, 26, 10]);
    png.set(new TextEncoder().encode('IHDR'), 12);
    new DataView(png.buffer).setUint32(16, 192);
    new DataView(png.buffer).setUint32(20, 192);
    const bytes = { ...base, readBytes: async () => png };
    expect((await checkArtifactIcons(bytes, 'release/site')).detail).toContain('dimensions differ');
    expect(
      (
        await checkArtifactIcons(
          { ...base, readBytes: async () => new TextEncoder().encode('<html>fallback</html>') },
          'release/site',
        )
      ).detail,
    ).toContain('Invalid PNG');
  });
});
