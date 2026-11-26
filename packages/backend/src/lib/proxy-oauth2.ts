/**
 * OAuth2 client_credentials token cache for the proxy.
 *
 * Worker global memory (per-isolate). Tokens are cached for
 * (expires_in - 60s) to avoid using a token that's about to expire.
 *
 * Only plain data is shared across requests. Concurrent refreshes are NOT
 * deduplicated through a shared in-flight promise: Workers drop a promise's
 * settlement in any request other than the one that created it, so a second
 * awaiter throws once the first request ends (1101, #639, #641).
 */

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

// Per-isolate in-memory cache keyed by the caller's cacheKey plus a hash of
// tokenUrl and the credentials, so a rotated secret or a changed tokenUrl
// never reuses a token minted for the old ones (#769).
const tokenCache = new Map<string, CachedToken>();

/**
 * Get a valid OAuth2 access token, refreshing if expired or missing.
 * Uses the worker memory cache; a cache miss refreshes in this request.
 */
export async function getOAuth2Token(opts: {
  cacheKey: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}): Promise<string> {
  const { tokenUrl, clientId, clientSecret } = opts;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify([tokenUrl, clientId, clientSecret])),
  );
  const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  const cacheKey = `${opts.cacheKey}:${hash}`;

  // Check memory cache
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.accessToken;
  }

  try {
    const { accessToken, expiresIn } = await refreshToken(tokenUrl, clientId, clientSecret);
    // Cache with 60s safety margin, minimum 10s to avoid tight refresh loops
    const ttlSeconds = Math.max(10, expiresIn - 60);
    tokenCache.set(cacheKey, { accessToken, expiresAt: Date.now() + ttlSeconds * 1000 });
    return accessToken;
  } catch (err) {
    // Clear the stale cache on failure so the next request retries
    tokenCache.delete(cacheKey);
    throw err;
  }
}

async function refreshToken(
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
    },
    body: 'grant_type=client_credentials',
    // The client credentials go to tokenUrl only, never to a redirect target (#562).
    redirect: 'manual',
  });

  if (!res.ok) {
    // Log details server-side but don't surface upstream error body to the client
    const text = await res.text().catch(() => '');
    console.error(`OAuth2 token refresh failed: ${res.status} ${text.slice(0, 500)}`);
    throw new Error(`OAuth2 token request failed (${res.status})`);
  }

  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    token_type?: string;
  };

  if (!data.access_token) {
    throw new Error('OAuth2 token response missing access_token');
  }

  return {
    accessToken: data.access_token,
    // Default to 30 min if not provided (common for OAuth2)
    expiresIn: data.expires_in ?? 1800,
  };
}
