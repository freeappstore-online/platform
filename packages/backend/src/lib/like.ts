/**
 * Make `value` literal inside a SQLite LIKE pattern.
 *
 * `%` and `_` are wildcards, and `\` is only an escape when the query says
 * `ESCAPE '\'`. Callers must add that clause — without it the backslashes
 * are ordinary characters and the wildcards still match.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/** Starts-with pattern for `LIKE ? ESCAPE '\'`. */
export function likePrefix(prefix: string): string {
  return `${escapeLike(prefix)}%`;
}
