// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { getPreference, setPreference } from '../persist/prefs.js';
import { mountBackupExample } from './example-ui.js';
import type { ImportMode } from './import.js';

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe('backup example UI', () => {
  it('requires a preview and an explicit mode, and unmounting does not erase saved data', () => {
    expect(setPreference('notes', 'draft', { text: 'keep' }).ok).toBe(true);
    const host = document.createElement('div');
    document.body.append(host);
    const imports: ImportMode[] = [];
    let cancelled = 0;
    let files = 0;
    const view = mountBackupExample(host, {
      onExport() {},
      onShare() {},
      onFile() {
        files += 1;
      },
      onImport(mode) {
        imports.push(mode);
      },
      onCancel() {
        cancelled += 1;
      },
    });

    const section = host.querySelector('section');
    expect(section?.getAttribute('aria-labelledby')).toBeTruthy();
    expect(host.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe('polite');
    const titleId = section?.getAttribute('aria-labelledby');
    expect(host.querySelector(`#${titleId}`)?.textContent).toBe('Backup');
    expect(host.textContent).toContain(
      'If importing and restoring both fail, some data may have changed.',
    );
    expect(host.querySelector('button')?.textContent).toBe('Export backup');

    const importButton = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Import backup',
    );
    expect(importButton).toBeInstanceOf(HTMLButtonElement);
    if (!(importButton instanceof HTMLButtonElement)) return;
    expect(importButton.disabled).toBe(true);
    expect(importButton.getAttribute('aria-disabled')).toBe('true');
    importButton.click();
    expect(imports).toEqual([]);

    const replace = host.querySelector<HTMLInputElement>('input[value="replace"]');
    replace?.click();
    expect(importButton.disabled).toBe(true);
    view.setPreview({
      version: 1,
      appId: 'notes',
      exportedAt: '2026-11-04T00:00:00.000Z',
      byteLength: 40,
      counts: { notes: 2 },
    });
    expect(host.textContent).toContain('notes: 2');
    expect(importButton.disabled).toBe(false);
    importButton.click();
    expect(imports).toEqual(['replace']);

    view.setStatus('Import failed and the previous data was restored.');
    expect(host.querySelector('[role="status"]')?.textContent).toContain('restored');
    view.setStatus('Import failed: rollback failed; stored data may be partial.');
    expect(host.querySelector('[role="status"]')?.textContent).toContain('partial');

    const file = new File(['{}'], 'backup.json', { type: 'application/json' });
    const input = host.querySelector('input[type="file"]');
    expect(input?.getAttribute('aria-label')).toBe('Choose backup file');
    if (input instanceof HTMLInputElement) {
      Object.defineProperty(input, 'files', { value: [file] });
      input.dispatchEvent(new Event('change'));
    }
    expect(files).toBe(1);

    const cancel = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Cancel import',
    );
    cancel?.click();
    expect(cancelled).toBe(1);
    expect(importButton.disabled).toBe(true);
    expect(getPreference('notes', 'draft')).toEqual({ ok: true, value: { text: 'keep' } });

    view.destroy();
    expect(host.querySelector('section')).toBeNull();
    expect(getPreference('notes', 'draft')).toEqual({ ok: true, value: { text: 'keep' } });
  });
});
