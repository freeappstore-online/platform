import { describe, it, expect } from 'vitest';
import { mapFileSource } from '../lib/file-source.js';
import { checkDarkMode } from './dark-mode.js';

describe('checkDarkMode', () => {
  it('passes when CSS has @media (prefers-color-scheme: dark)', async () => {
    const files = new Map([[
      'web/src/index.css',
      '@media (prefers-color-scheme: dark) { :root { --paper: #111; } }',
    ]]);
    const r = await checkDarkMode(mapFileSource(files));
    expect(r.status).toBe('pass');
  });

  it('passes when JSX uses data-theme', async () => {
    const files = new Map([[
      'web/src/App.tsx',
      'export default () => <html data-theme="dark"><body /></html>;',
    ]]);
    const r = await checkDarkMode(mapFileSource(files));
    expect(r.status).toBe('pass');
  });

  it('passes when CSS declares color-scheme', async () => {
    const files = new Map([['web/src/main.css', ':root { color-scheme: light dark; }']]);
    const r = await checkDarkMode(mapFileSource(files));
    expect(r.status).toBe('pass');
  });

  it('warns when no signal in web/src/', async () => {
    const files = new Map([['web/src/App.tsx', 'export default () => <div>hi</div>;']]);
    const r = await checkDarkMode(mapFileSource(files));
    expect(r.status).toBe('warn');
  });

  it('skips for game projects', async () => {
    const files = new Map([
      ['package.json', '{"dependencies":{"@freeappstore/games":"^0.1"}}'],
      ['web/src/App.tsx', 'export default () => <div>hi</div>;'],
    ]);
    const r = await checkDarkMode(mapFileSource(files));
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/skipped/);
  });
});
