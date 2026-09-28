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
 * An app wrapped in the SDK's `Shell` passes too: its topbar links to
 * freeappstore.online.
 */
// `<Shell>` / `<FasShell>` rendered from @freeappstore/sdk/ui (not a local component).
const SDK_SHELL_RE =
  /from\s*['"]@freeappstore\/sdk\/ui['"][\s\S]*<(?:Fas)?Shell\b|<(?:Fas)?Shell\b[\s\S]*from\s*['"]@freeappstore\/sdk\/ui['"]/;

export async function checkStoreLink(source: FileSource): Promise<CheckResult> {
  const isGame = await isGameProject(source);
  const domain = isGame ? 'freegamestore.online' : 'freeappstore.online';

  for await (const path of source.list()) {
    if (!path.startsWith('web/src/')) continue;
    const content = await source.read(path);
    if (content?.includes(domain)) {
      return { name: 'Store link', status: 'pass', detail: `${domain} referenced in ${path}` };
    }
    if (!isGame && content && SDK_SHELL_RE.test(content)) {
      return {
        name: 'Store link',
        status: 'pass',
        detail: `${path} renders the SDK Shell, whose topbar links to ${domain}`,
      };
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
