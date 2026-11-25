import type { Auth } from './auth.js';
import { authedFetch } from './authed-fetch.js';

/** Companion state for the signed-in user, as this app sees it. */
export interface NativeStatus {
  /** This app is a reviewed recipient of companion location. */
  available: boolean;
  /** The user turned this app on in the FreeAppStore phone app. */
  enabled: boolean;
  /** Newest point kept for this app (ms epoch), or null. */
  lastPointAt: number | null;
}

/** One location the companion recorded and shared with this app. */
export interface NativePoint {
  id: string;
  /** Recorded at (ms epoch). */
  at: number;
  lat: number;
  lng: number;
  /** Horizontal accuracy in metres. */
  accuracy: number;
}

/** Pass back to `locations()` to continue after the last point returned. */
export interface NativeCursor {
  after: number;
  afterId: string;
}

const PAGE = 500;

/**
 * Locations from the FreeAppStore phone app (native companion), which keeps
 * recording with the phone locked. Only reviewed apps receive them, only for
 * the signed-in user, and only after that user turns the app on in the
 * companion. Points are kept for 7 days.
 */
export class Native {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: Auth,
  ) {}

  /** Link that opens this app's location disclosure in the companion, if installed. */
  get setupUrl(): string {
    return `freeappstore://native/apps/${encodeURIComponent(this.appId)}`;
  }

  async status(): Promise<NativeStatus> {
    return (await this.get('status')) as NativeStatus;
  }

  /**
   * Points after `cursor` in recording order, up to 500 per call. Keep the
   * returned `cursor` for the next read; `more` means call again now.
   */
  async locations(
    cursor?: NativeCursor,
  ): Promise<{ points: NativePoint[]; cursor: NativeCursor | undefined; more: boolean }> {
    const params = cursor ? { after: String(cursor.after), afterId: cursor.afterId } : undefined;
    const { points } = (await this.get('locations', params)) as {
      points: (NativePoint & { grantId: string; cursorId: string })[];
    };
    const last = points.at(-1);
    return {
      points: points.map(({ id, at, lat, lng, accuracy }) => ({ id, at, lat, lng, accuracy })),
      cursor: last ? { after: last.at, afterId: last.cursorId } : cursor,
      more: points.length === PAGE,
    };
  }

  private async get(path: string, params?: Record<string, string>): Promise<unknown> {
    const url = new URL(`/v1/apps/${encodeURIComponent(this.appId)}/native/${path}`, this.apiBase);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
    const response = await authedFetch(this.auth, url);
    if (!response.ok) throw new Error(`native.${path} failed: ${response.status}`);
    return response.json();
  }
}
