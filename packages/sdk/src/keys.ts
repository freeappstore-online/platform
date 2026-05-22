import type { Auth } from './auth.js';

/**
 * User API Key management. Keys are stored encrypted on the platform and
 * injected server-side when apps call `fas.proxy.fetch()`. Apps never see
 * the plaintext key.
 *
 * Key management happens on a platform-hosted page, not in the app UI.
 * Apps use `fas.keys.manage()` to redirect users there.
 */
export class Keys {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: Auth,
  ) {}

  /**
   * Open the platform's key management page. If a provider is specified,
   * that provider's card will be highlighted on the page.
   *
   * The user manages their keys on the platform page and is redirected
   * back to the app when done.
   *
   * @param provider - Optional provider to highlight (e.g. 'openai')
   */
  manage(provider?: string): void {
    const params = new URLSearchParams();
    params.set('app', this.appId);
    params.set('return', window.location.href);
    if (provider) params.set('provider', provider);
    window.location.href = `${this.apiBase}/v1/keys?${params}`;
  }

  /**
   * Check which providers the current user has keys configured for.
   * Useful for showing "configure your API key" prompts in the app.
   */
  async status(): Promise<Array<{ provider: string; label: string | null; createdAt: number; lastUsedAt: number | null }>> {
    if (!this.auth.token) return [];
    const res = await fetch(`${this.apiBase}/v1/keys/status`, {
      headers: { Authorization: `Bearer ${this.auth.token}`, Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { keys: Array<{ provider: string; label: string | null; createdAt: number; lastUsedAt: number | null }> };
    return data.keys;
  }

  /**
   * Check if the user has a key for a specific provider.
   */
  async has(provider: string): Promise<boolean> {
    const keys = await this.status();
    return keys.some((k) => k.provider === provider);
  }
}
