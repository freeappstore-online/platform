/**
 * Canonical mapping for apps published on freeappstore.online.
 *
 * Each entry maps an app ID to its public subdomain. Used by CLI commands
 * that need to resolve an app's URL (e.g. `fas open`, `fas audit`).
 */
export interface AppRecord {
  subdomain: string;
}

export const APPS: Record<string, AppRecord> = {
  chess: { subdomain: 'chess.freeappstore.online' },
  language: { subdomain: 'language.freeappstore.online' },
  math: { subdomain: 'math.freeappstore.online' },
  quiz: { subdomain: 'quiz.freeappstore.online' },
  books: { subdomain: 'books.freeappstore.online' },
  music: { subdomain: 'music.freeappstore.online' },
  puzzle: { subdomain: 'puzzle.freeappstore.online' },
  freeappstore: { subdomain: 'freeappstore.online' },
};

/**
 * Returns the public URL for an app id.
 */
export function urlFor(appId: string): string {
  const subdomain = APPS[appId]?.subdomain ?? `${appId}.freeappstore.online`;
  return `https://${subdomain}`;
}
