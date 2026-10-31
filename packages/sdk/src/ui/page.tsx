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
    <div className="fas-page-header mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1
          className="fas-page-header__title m-0 text-2xl font-bold leading-[1.2] text-ink focus:outline-none"
          tabIndex={-1}
          data-fas-page-heading=""
        >
          {title}
        </h1>
        {description && (
          <p className="fas-page-header__description mb-0 mt-1 text-[0.9rem] text-muted">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
