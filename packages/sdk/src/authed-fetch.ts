/** The part of `Auth` a signed-in request needs. */
export interface SessionAuth {
  token: string | null;
  handleUnauthorized(requestToken?: string): void;
}

/**
 * @internal `fetch` with the session's bearer token. Throws `Not signed in.`
 * when there is no session, and on a 401 drops that session (so the UI reacts)
 * before throwing the same error.
 */
export async function authedFetch(
  auth: SessionAuth,
  url: string | URL,
  init: Omit<RequestInit, 'headers'> & { headers?: Record<string, string> } = {},
): Promise<Response> {
  const token = auth.token;
  if (!token) throw new Error('Not signed in.');
  const res = await fetch(url, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    auth.handleUnauthorized(token);
    throw new Error('Not signed in.');
  }
  return res;
}
