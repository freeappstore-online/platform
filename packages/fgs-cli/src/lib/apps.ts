/**
 * Canonical mapping for apps published on freeappstore.online.
 *
 * Most apps follow the convention `app_id` → CF Pages project `free<id>app`,
 * which is what we infer when an entry isn't here. But several legacy
 * projects use ad-hoc names (music, puzzle, freeappstore itself) and CF
 * Pages project names cannot be renamed after creation, so we have to keep
 * a hand-maintained override list.
 *
 * This is the registry the audit recommended (P2 in the original review),
 * scoped to just the dev tooling for now. Long-term it should live in the
 * storefront repo and be fetched at runtime so it never goes stale.
 */
export interface AppRecord {
  cfProject: string;
  subdomain: string;
}

export const APPS: Record<string, AppRecord> = {
  // Convention-following entries (cfProject === `free${id}app`) are listed
  // for documentation / completeness; the cfProject() helper would derive
  // them anyway. Add new apps here when they don't follow the convention.
  chess: { cfProject: 'freechessapp', subdomain: 'chess.freeappstore.online' },
  language: { cfProject: 'freelanguageapp', subdomain: 'language.freeappstore.online' },
  math: { cfProject: 'freemathapp', subdomain: 'math.freeappstore.online' },
  quiz: { cfProject: 'freequizapp', subdomain: 'quiz.freeappstore.online' },
  books: { cfProject: 'freebooksapp', subdomain: 'books.freeappstore.online' },

  // Legacy / non-conventional names — cannot be renamed.
  music: { cfProject: 'freemusic', subdomain: 'music.freeappstore.online' },
  puzzle: { cfProject: 'freepuzzle', subdomain: 'puzzle.freeappstore.online' },
  freeappstore: { cfProject: 'freeappstore', subdomain: 'freeappstore.online' },
};

/**
 * Returns the CF Pages project name for an app id. Prefers the registry,
 * falls back to the `free<id>app` convention.
 */
export function cfProjectFor(appId: string): string {
  return APPS[appId]?.cfProject ?? `free${appId}app`;
}

/**
 * Returns the public URL for an app id.
 */
export function urlFor(appId: string): string {
  const subdomain = APPS[appId]?.subdomain ?? `${appId}.freeappstore.online`;
  return `https://${subdomain}`;
}
