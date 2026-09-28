import { type ReactNode, useEffect } from 'react';

/**
 * Set the tab title for the current screen. Call it once in each routed screen;
 * the title follows the value while the screen is mounted. Runs after Shell
 * applies a nav item's `title`, so the screen's own title wins on that route.
 *
 * ```tsx
 * useDocumentTitle(`${note.title} — Notes`)
 * ```
 */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);
}

export interface PageHeaderProps {
  /** The screen's heading, rendered as its single `<h1>`. */
  title: ReactNode;
  /** Optional line under the heading. */
  description?: ReactNode;
  /** Optional controls aligned with the heading (e.g. a primary button). */
  actions?: ReactNode;
}

/**
 * The screen's heading: renders the page's one `<h1>` the same way on every
 * screen. Shell moves focus to it after a client-side navigation, so keyboard
 * and screen-reader users land on the new page.
 */
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="fas-page-header">
      <div>
        <h1 className="fas-page-header__title" tabIndex={-1} data-fas-page-heading="">
          {title}
        </h1>
        {description && <p className="fas-page-header__description">{description}</p>}
      </div>
      {actions && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>{actions}</div>
      )}
    </div>
  );
}
