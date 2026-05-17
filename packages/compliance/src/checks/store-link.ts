import type { FileSource } from '../lib/file-source.js';
import { isGameProject } from '../lib/project-type.js';
import type { CheckResult } from '../types.js';

/**
 * Apps and games should link back to their storefront — it's how
 * visitors discover the rest of the catalog from inside any single
 * app. The check passes if any source file under `web/src/` references
 * the appropriate domain:
 *
 *   - games  → freegamestore.online
 *   - apps   → freeappstore.online
 *
 * The link can be in JSX (`<a href="https://freeappstore.online">`),
 * a string constant, or even a footer comment — we don't enforce a
 * specific component, just that the link exists somewhere visible.
 */
export async function checkStoreLink(source: FileSource): Promise<CheckResult> {
  const isGame = await isGameProject(source);
  const domain = isGame ? 'freegamestore.online' : 'freeappstore.online';

  for await (const path of source.list()) {
    if (!path.startsWith('web/src/')) continue;
    const content = await source.read(path);
    if (content?.includes(domain)) {
      return { name: 'Store link', status: 'pass', detail: `${domain} referenced in ${path}` };
    }
  }
  return {
    name: 'Store link',
    status: 'warn',
    detail: `no link to ${domain} found in web/src/`,
    suggestions: [
      `Add a small "Built for ${domain}" link in the footer or about screen.`,
      'It helps visitors find the rest of the catalog — and it counts for storefront ranking.',
    ],
  };
}
