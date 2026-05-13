import { describe, it, expect } from 'vitest';
import { mapFileSource } from '../lib/file-source.js';
import { checkStoreLink } from './store-link.js';

describe('checkStoreLink', () => {
  it('passes for an app referencing freeappstore.online in src', async () => {
    const files = new Map([[
      'web/src/Footer.tsx',
      'export default () => <a href="https://freeappstore.online">Catalog</a>;',
    ]]);
    const r = await checkStoreLink(mapFileSource(files));
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/freeappstore\.online/);
  });

  it('passes for a game referencing freegamestore.online when @freeappstore/games is present', async () => {
    const files = new Map([
      ['package.json', '{"dependencies":{"@freeappstore/games":"^0.1"}}'],
      ['web/src/Footer.tsx', 'const url = "https://freegamestore.online";'],
    ]);
    const r = await checkStoreLink(mapFileSource(files));
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/freegamestore\.online/);
  });

  it('warns for an app that links freegamestore but not freeappstore', async () => {
    const files = new Map([['web/src/About.tsx', 'const x = "freegamestore.online";']]);
    const r = await checkStoreLink(mapFileSource(files));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/freeappstore\.online/);
  });

  it('warns when no store link anywhere in web/src/', async () => {
    const files = new Map([['web/src/App.tsx', 'export default () => <div>hi</div>;']]);
    const r = await checkStoreLink(mapFileSource(files));
    expect(r.status).toBe('warn');
  });
});
