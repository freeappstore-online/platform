// @vitest-environment happy-dom
// Modal / ConfirmDialog dialog semantics and focus management (#194).
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog, Modal } from './components.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const press = async (key: string, opts: { shiftKey?: boolean } = {}) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(event);
  });
  return event;
};
const focusedText = () =>
  (document.activeElement as HTMLElement | null)?.getAttribute('aria-label') ??
  document.activeElement?.textContent;

/** An opener button, then whatever the test renders after it. */
function Page({ children }: { children?: ReactNode }) {
  return (
    <>
      <button type="button" id="opener">
        Open
      </button>
      {children}
    </>
  );
}

async function openFrom(node: ReactNode) {
  await render(<Page />);
  document.getElementById('opener')?.focus();
  await render(<Page>{node}</Page>);
}

describe('Modal semantics', () => {
  it('is a modal dialog labelled by its title', async () => {
    await render(
      <Modal open onClose={() => {}} title="Settings">
        <p>body</p>
      </Modal>,
    );
    const d = dialog();
    expect(d).not.toBeNull();
    expect(d?.getAttribute('aria-modal')).toBe('true');
    const labelId = d?.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId as string)?.textContent).toBe('Settings');
    expect(d?.tagName).toBe('DIV');
  });

  it('uses ariaLabel as the name when there is no title', async () => {
    await render(
      <Modal open onClose={() => {}} ariaLabel="Image preview">
        <p>body</p>
      </Modal>,
    );
    expect(dialog()?.getAttribute('aria-label')).toBe('Image preview');
    expect(dialog()?.hasAttribute('aria-labelledby')).toBe(false);
  });

  it('renders nothing while closed', async () => {
    await render(
      <Modal open={false} onClose={() => {}} title="x">
        body
      </Modal>,
    );
    expect(dialog()).toBeNull();
  });
});

describe('Modal focus', () => {
  it('focuses the first focusable element in the content on open', async () => {
    await openFrom(
      <Modal open onClose={() => {}} title="Rename">
        <input aria-label="Name" />
        <button type="button">Save</button>
      </Modal>,
    );
    expect(focusedText()).toBe('Name');
  });

  it('prefers an element marked data-autofocus', async () => {
    await openFrom(
      <Modal open onClose={() => {}} title="Rename">
        <input aria-label="Name" />
        <button type="button" data-autofocus>
          Save
        </button>
      </Modal>,
    );
    expect(focusedText()).toBe('Save');
  });

  it('falls back to the close button, then to the dialog itself', async () => {
    await openFrom(
      <Modal open onClose={() => {}} title="Info">
        <p>Nothing to press here.</p>
      </Modal>,
    );
    expect(focusedText()).toBe('Close');

    await act(async () => root.unmount());
    root = createRoot(container);
    await openFrom(
      <Modal open onClose={() => {}} ariaLabel="Info">
        <p>Nothing to press here.</p>
      </Modal>,
    );
    expect(document.activeElement).toBe(dialog());
  });

  it('traps Tab and Shift-Tab inside the dialog', async () => {
    await openFrom(
      <Modal open onClose={() => {}} title="Rename">
        <input aria-label="Name" />
        <button type="button">Save</button>
      </Modal>,
    );
    // Order inside: Close (header), Name, Save.
    const save = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (b) => b.textContent === 'Save',
    ) as HTMLButtonElement;
    await act(async () => save.focus());
    const forward = await press('Tab');
    expect(forward.defaultPrevented).toBe(true);
    expect(focusedText()).toBe('Close'); // wrapped from last to first

    const back = await press('Tab', { shiftKey: true });
    expect(back.defaultPrevented).toBe(true);
    expect(focusedText()).toBe('Save'); // wrapped from first to last
  });

  it('leaves Tab alone between the first and last elements', async () => {
    await openFrom(
      <Modal open onClose={() => {}} title="Rename">
        <input aria-label="Name" />
        <button type="button">Save</button>
      </Modal>,
    );
    expect(focusedText()).toBe('Name');
    const middle = await press('Tab');
    expect(middle.defaultPrevented).toBe(false);
  });

  it('pulls focus back in if it lands outside', async () => {
    await openFrom(
      <Modal open onClose={() => {}} title="Rename">
        <input aria-label="Name" />
      </Modal>,
    );
    await act(async () => document.getElementById('opener')?.focus());
    expect(dialog()?.contains(document.activeElement)).toBe(true);
  });

  it('returns focus to the opener when closed', async () => {
    const onClose = vi.fn();
    await openFrom(
      <Modal open onClose={onClose} title="Rename">
        <input aria-label="Name" />
      </Modal>,
    );
    expect(focusedText()).toBe('Name');
    await render(
      <Page>
        <Modal open={false} onClose={onClose} title="Rename">
          <input aria-label="Name" />
        </Modal>
      </Page>,
    );
    expect(document.activeElement?.id).toBe('opener');
  });

  it("doesn't move focus when re-rendered with a new inline onClose", async () => {
    const view = (n: number) => (
      <Page>
        <Modal open onClose={() => n} title="Rename">
          <input aria-label="Name" />
          <button type="button">Save</button>
        </Modal>
      </Page>
    );
    await openFrom(view(0).props.children);
    const save = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (b) => b.textContent === 'Save',
    ) as HTMLButtonElement;
    await act(async () => save.focus());
    await render(view(1));
    await render(view(2));
    expect(focusedText()).toBe('Save');
  });
});

describe('Modal Esc', () => {
  it('closes on Esc', async () => {
    const onClose = vi.fn();
    await openFrom(
      <Modal open onClose={onClose} title="Rename">
        <input aria-label="Name" />
      </Modal>,
    );
    await press('Escape');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('ignores Esc when closeOnEscape is false', async () => {
    const onClose = vi.fn();
    await openFrom(
      <Modal open onClose={onClose} title="Saving" closeOnEscape={false}>
        <input aria-label="Name" />
      </Modal>,
    );
    await press('Escape');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes only the innermost of nested dialogs', async () => {
    const outer = vi.fn();
    const inner = vi.fn();
    await openFrom(
      <Modal open onClose={outer} title="Outer">
        <input aria-label="Outer field" />
        <Modal open onClose={inner} title="Inner">
          <input aria-label="Inner field" />
        </Modal>
      </Modal>,
    );
    expect(focusedText()).toBe('Inner field');
    await press('Escape');
    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
  });
});

describe('ConfirmDialog', () => {
  const confirm = (props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) => (
    <ConfirmDialog
      open
      onConfirm={() => {}}
      onCancel={() => {}}
      title="Delete recording?"
      message="This can't be undone."
      confirmLabel="Delete"
      variant="danger"
      {...props}
    />
  );

  it('is a modal dialog labelled by its title, with focus on Cancel', async () => {
    await openFrom(confirm());
    const d = dialog();
    expect(d?.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(d?.getAttribute('aria-labelledby') as string)?.textContent).toBe(
      'Delete recording?',
    );
    expect(focusedText()).toBe('Cancel');
  });

  it('Esc cancels, unless closeOnEscape is false', async () => {
    const onCancel = vi.fn();
    await openFrom(confirm({ onCancel }));
    await press('Escape');
    expect(onCancel).toHaveBeenCalledOnce();

    const stay = vi.fn();
    await render(<Page>{confirm({ onCancel: stay, closeOnEscape: false })}</Page>);
    await press('Escape');
    expect(stay).not.toHaveBeenCalled();
  });

  it('its buttons are type="button" so they never submit a surrounding form', async () => {
    await openFrom(confirm());
    for (const b of document.querySelectorAll('[role="dialog"] button')) {
      expect(b.getAttribute('type')).toBe('button');
    }
  });
});
