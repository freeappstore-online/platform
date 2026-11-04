import type { BackupPreview } from './envelope.js';
import type { ImportMode } from './import.js';

/**
 * Accessible backup controls. This view does not read or write app data.
 * The app previews a file, then calls `importBackup` only after the user picks
 * merge or replace. Unmounting the view does not delete saved data.
 */
export interface BackupExampleHandlers {
  onExport: () => void;
  onShare: () => void;
  onFile: (file: File) => void;
  onImport: (mode: ImportMode) => void;
  onCancel: () => void;
}

export interface BackupExampleView {
  readonly root: HTMLElement;
  setStatus(message: string): void;
  setPreview(preview: BackupPreview | null): void;
  destroy(): void;
}

let instance = 0;

export function mountBackupExample(
  container: HTMLElement,
  handlers: BackupExampleHandlers,
): BackupExampleView {
  instance += 1;
  const titleId = `fas-backup-title-${instance}`;
  const helpId = `fas-backup-help-${instance}`;
  const previewId = `fas-backup-preview-${instance}`;
  const statusId = `fas-backup-status-${instance}`;
  const groupName = `fas-backup-mode-${instance}`;
  const listeners = new AbortController();
  const signal = listeners.signal;

  const root = container.ownerDocument.createElement('section');
  root.className = 'fas-backup-example';
  root.setAttribute('aria-labelledby', titleId);

  const title = container.ownerDocument.createElement('h2');
  title.id = titleId;
  title.textContent = 'Backup';

  const help = container.ownerDocument.createElement('p');
  help.id = helpId;
  help.textContent =
    'Choose merge or replace after previewing. If importing and restoring both fail, some data may have changed. Keep your backup file and check the reported error before retrying. Removing this screen does not delete saved data.';

  const exportButton = button(container.ownerDocument, 'Export backup', helpId);
  const shareButton = button(container.ownerDocument, 'Share or download backup', helpId);
  const fileLabel = container.ownerDocument.createElement('label');
  fileLabel.textContent = 'Choose backup file';
  const fileInput = container.ownerDocument.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'application/json,.json';
  fileInput.setAttribute('aria-label', 'Choose backup file');
  fileLabel.append(fileInput);

  const mode = container.ownerDocument.createElement('fieldset');
  const legend = container.ownerDocument.createElement('legend');
  legend.textContent = 'Import mode';
  mode.append(legend);
  const merge = radio(
    container.ownerDocument,
    groupName,
    'merge',
    'Merge with the data on this device',
  );
  const replace = radio(
    container.ownerDocument,
    groupName,
    'replace',
    'Replace the data on this device',
  );
  mode.append(merge.label, replace.label);

  const preview = container.ownerDocument.createElement('div');
  preview.id = previewId;
  preview.setAttribute('aria-live', 'polite');
  preview.setAttribute('aria-label', 'Backup preview');
  preview.textContent = 'No backup preview yet.';

  const importButton = button(container.ownerDocument, 'Import backup', `${helpId} ${previewId}`);
  importButton.disabled = true;
  importButton.setAttribute('aria-disabled', 'true');
  const cancelButton = button(container.ownerDocument, 'Cancel import', helpId);

  const status = container.ownerDocument.createElement('div');
  status.id = statusId;
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  root.append(
    title,
    help,
    exportButton,
    shareButton,
    fileLabel,
    mode,
    preview,
    importButton,
    cancelButton,
    status,
  );
  container.append(root);

  let selected: ImportMode | null = null;
  let previewReady = false;
  const syncImport = () => {
    const ready = selected !== null && previewReady;
    importButton.disabled = !ready;
    importButton.setAttribute('aria-disabled', ready ? 'false' : 'true');
  };
  const choose = (value: ImportMode) => {
    selected = value;
    syncImport();
  };

  exportButton.addEventListener('click', () => handlers.onExport(), { signal });
  shareButton.addEventListener('click', () => handlers.onShare(), { signal });
  fileInput.addEventListener(
    'change',
    () => {
      const file = fileInput.files?.[0];
      if (file) handlers.onFile(file);
    },
    { signal },
  );
  merge.input.addEventListener('change', () => choose('merge'), { signal });
  replace.input.addEventListener('change', () => choose('replace'), { signal });
  importButton.addEventListener(
    'click',
    () => {
      if (!selected || !previewReady) return;
      handlers.onImport(selected);
    },
    { signal },
  );
  cancelButton.addEventListener(
    'click',
    () => {
      selected = null;
      previewReady = false;
      merge.input.checked = false;
      replace.input.checked = false;
      preview.textContent = 'No backup preview yet.';
      syncImport();
      handlers.onCancel();
    },
    { signal },
  );

  return {
    root,
    setStatus(message: string) {
      status.textContent = message;
    },
    setPreview(next: BackupPreview | null) {
      preview.replaceChildren();
      if (!next) {
        previewReady = false;
        preview.textContent = 'No backup preview yet.';
        syncImport();
        return;
      }
      previewReady = true;
      const summary = container.ownerDocument.createElement('p');
      summary.textContent = `Version ${next.version}, ${next.byteLength} bytes, exported ${next.exportedAt}.`;
      const list = container.ownerDocument.createElement('ul');
      for (const [name, count] of Object.entries(next.counts)) {
        const item = container.ownerDocument.createElement('li');
        item.textContent = `${name}: ${count}`;
        list.append(item);
      }
      if (!list.childElementCount) {
        const item = container.ownerDocument.createElement('li');
        item.textContent = 'No counted records.';
        list.append(item);
      }
      preview.append(summary, list);
      syncImport();
    },
    destroy() {
      listeners.abort();
      root.remove();
    },
  };
}

function button(document: Document, label: string, describedBy: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.setAttribute('aria-describedby', describedBy);
  return element;
}

function radio(
  document: Document,
  name: string,
  value: ImportMode,
  label: string,
): { label: HTMLLabelElement; input: HTMLInputElement } {
  const wrap = document.createElement('label');
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = name;
  input.value = value;
  wrap.append(input, document.createTextNode(` ${label}`));
  return { label: wrap, input };
}
