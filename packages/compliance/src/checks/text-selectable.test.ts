import { describe, expect, it } from 'vitest';
import { mapFileSource } from '../lib/file-source.js';
import { checkTextSelectable } from './text-selectable.js';

function source(files: Record<string, string>) {
  return mapFileSource(new Map(Object.entries(files)));
}

describe('checkTextSelectable', () => {
  it('passes when no user-select: none on body', async () => {
    const r = await checkTextSelectable(source({
      'web/src/index.css': 'body { color: red; }',
    }));
    expect(r.status).toBe('pass');
  });

  it('passes when user-select: none is scoped to buttons', async () => {
    const r = await checkTextSelectable(source({
      'web/src/index.css': 'button, nav, [role="button"] { user-select: none; }',
    }));
    expect(r.status).toBe('pass');
  });

  it('warns on body user-select: none', async () => {
    const r = await checkTextSelectable(source({
      'web/src/index.css': 'body {\n  user-select: none;\n}',
    }));
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('user-select: none');
  });

  it('warns on html user-select: none', async () => {
    const r = await checkTextSelectable(source({
      'web/src/index.css': 'html { -webkit-user-select: none; user-select: none; }',
    }));
    expect(r.status).toBe('warn');
  });

  it('warns on body with -webkit-user-select: none', async () => {
    const r = await checkTextSelectable(source({
      'web/src/index.css': 'body {\n  -webkit-user-select: none;\n  user-select: none;\n}',
    }));
    expect(r.status).toBe('warn');
  });

  it('passes when no CSS files exist', async () => {
    const r = await checkTextSelectable(source({
      'web/src/App.tsx': 'export default function App() { return <div>hi</div>; }',
    }));
    expect(r.status).toBe('pass');
  });

  it('ignores user-select: none in non-body selectors', async () => {
    const r = await checkTextSelectable(source({
      'web/src/index.css': '.header { user-select: none; }\n.toolbar { -webkit-user-select: none; }',
    }));
    expect(r.status).toBe('pass');
  });

  it('warns on * { user-select: none }', async () => {
    const r = await checkTextSelectable(source({
      'web/src/index.css': '* { user-select: none; }',
    }));
    expect(r.status).toBe('warn');
  });

  it('warns on html, body combined selector', async () => {
    const r = await checkTextSelectable(source({
      'web/src/index.css': 'html, body { user-select: none; }',
    }));
    expect(r.status).toBe('warn');
  });

  it('warns on body after other rules (not first in file)', async () => {
    const r = await checkTextSelectable(source({
      'web/src/index.css': 'h1 { color: red; }\nbody { -webkit-user-select: none; user-select: none; }',
    }));
    expect(r.status).toBe('warn');
  });

  it('scans scss files too', async () => {
    const r = await checkTextSelectable(source({
      'web/src/styles.scss': 'body {\n  user-select: none;\n}',
    }));
    expect(r.status).toBe('warn');
  });
});
