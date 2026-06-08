import type { Auth } from './auth.js';

/**
 * Platform logger -- captures errors, SDK API calls, and custom events.
 *
 * Three storage layers:
 * 1. In-memory ring buffer (last 200 entries, always available)
 * 2. localStorage (last 500 entries, survives page refresh)
 * 3. Server-side (batched upload to /v1/apps/:appId/logs, survives everything)
 *
 * Automatic captures:
 * - Uncaught errors (window.onerror)
 * - Unhandled promise rejections
 * - SDK API call results (proxy, kv, collections, etc.)
 * - Network failures
 *
 * Manual: fas.log.info/warn/error/debug(message, data?)
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  category: string;
  message: string;
  data?: unknown;
  /** Build metadata, attached to first entry of each session */
  build?: BuildMeta;
}

export interface BuildMeta {
  appVersion?: string | undefined;
  commitSha?: string | undefined;
  buildDate?: string | undefined;
  sdkVersion: string;
  userAgent: string;
  url: string;
  viewport: string;
  theme?: string | undefined;
}

// Must track package.json version — bumped on release. Guarded by version.test.ts
// so a forgotten bump fails CI instead of silently misattributing telemetry.
export const SDK_VERSION = '0.14.13';
const MEMORY_LIMIT = 200;
const STORAGE_LIMIT = 500;
const STORAGE_KEY_PREFIX = 'fas_logs:';
const UPLOAD_BATCH_SIZE = 50;
const UPLOAD_INTERVAL_MS = 30_000; // 30s

export class Logger {
  private buffer: LogEntry[] = [];
  private uploadTimer: ReturnType<typeof setInterval> | null = null;
  private sessionLogged = false;
  // Upload watermark over the logical entry stream. `evicted` counts entries
  // dropped off the front of the ring buffer; `uploadedThrough` counts stream
  // entries confirmed uploaded. Together they let uploadBatch() send each entry
  // exactly once without disturbing the recent()/entries() view held in `buffer`.
  private uploadedThrough = 0;
  private evicted = 0;

  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: Auth,
  ) {
    if (typeof window !== 'undefined') {
      this.installGlobalHandlers();
      this.loadFromStorage();
      this.startUploadTimer();
    }
  }

  // ── Public API ────────────────────────────────────────────────

  debug(message: string, data?: unknown) {
    this.add('debug', 'app', message, data);
  }
  info(message: string, data?: unknown) {
    this.add('info', 'app', message, data);
  }
  warn(message: string, data?: unknown) {
    this.add('warn', 'app', message, data);
  }
  error(message: string, data?: unknown) {
    this.add('error', 'app', message, data);
  }

  /** Get all in-memory log entries (newest first). */
  entries(): LogEntry[] {
    return [...this.buffer].reverse();
  }

  /** Dump all logs as a formatted string (for console or clipboard). */
  dump(): string {
    return this.entries()
      .map((e) => {
        const time = new Date(e.ts).toISOString().slice(11, 23);
        const data = e.data ? ` ${JSON.stringify(e.data)}` : '';
        return `${time} [${e.level.toUpperCase().padEnd(5)}] ${e.category}: ${e.message}${data}`;
      })
      .join('\n');
  }

  /** Clear all logs (memory + localStorage). */
  clear() {
    this.buffer = [];
    this.uploadedThrough = 0;
    this.evicted = 0;
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(`${STORAGE_KEY_PREFIX}${this.appId}`);
    }
  }

  /** Force upload pending logs to server now. */
  async flush(): Promise<void> {
    await this.uploadBatch();
  }

  /** Get build metadata for the current session. */
  getBuildMeta(): BuildMeta {
    const env = typeof import.meta !== 'undefined' ? ((import.meta as any).env ?? {}) : {};
    return {
      appVersion: env.VITE_APP_VERSION ?? undefined,
      commitSha: env.VITE_COMMIT_SHA ?? undefined,
      buildDate: env.VITE_BUILD_DATE ?? undefined,
      sdkVersion: SDK_VERSION,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
      url: typeof location !== 'undefined' ? location.href : 'unknown',
      viewport:
        typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight}` : 'unknown',
      theme: typeof document !== 'undefined' ? document.documentElement.dataset.theme : undefined,
    };
  }

  // ── Internal: used by SDK modules to log API calls ────────────

  /** @internal Log an SDK API call result. */
  _api(method: string, path: string, status: number, durationMs: number, error?: string) {
    this.add(
      error ? 'error' : 'info',
      'sdk',
      `${method} ${path} ${status} (${durationMs}ms)`,
      error ? { error } : undefined,
    );
  }

  // ── Private ───────────────────────────────────────────────────

  private add(level: LogLevel, category: string, message: string, data?: unknown) {
    const entry: LogEntry = { ts: Date.now(), level, category, message, data };

    // Attach build meta to first entry
    if (!this.sessionLogged) {
      entry.build = this.getBuildMeta();
      this.sessionLogged = true;
    }

    this.buffer.push(entry);
    if (this.buffer.length > MEMORY_LIMIT) {
      const drop = this.buffer.length - MEMORY_LIMIT;
      this.buffer = this.buffer.slice(drop);
      this.evicted += drop;
    }

    this.saveToStorage();
  }

  private installGlobalHandlers() {
    window.addEventListener('error', (e) => {
      this.add('error', 'uncaught', e.message, {
        filename: e.filename?.split('/').slice(-2).join('/'),
        line: e.lineno,
        col: e.colno,
      });
    });

    window.addEventListener('unhandledrejection', (e) => {
      const reason = e.reason instanceof Error ? e.reason.message : String(e.reason);
      this.add('error', 'promise', reason);
    });
  }

  private saveToStorage() {
    if (typeof localStorage === 'undefined') return;
    try {
      const entries = this.buffer.slice(-STORAGE_LIMIT);
      localStorage.setItem(`${STORAGE_KEY_PREFIX}${this.appId}`, JSON.stringify(entries));
    } catch {
      // Storage full or unavailable, ignore
    }
  }

  private loadFromStorage() {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(`${STORAGE_KEY_PREFIX}${this.appId}`);
      if (raw) {
        const entries = JSON.parse(raw) as LogEntry[];
        if (Array.isArray(entries)) {
          this.buffer = entries.slice(-MEMORY_LIMIT);
        }
      }
    } catch {
      // Corrupted, ignore
    }
  }

  private startUploadTimer() {
    this.uploadTimer = setInterval(() => {
      this.uploadBatch().catch(() => {});
    }, UPLOAD_INTERVAL_MS);
  }

  private async uploadBatch(): Promise<void> {
    if (!this.auth.token) return;

    // Send the oldest not-yet-uploaded entries (a watermark over the stream),
    // so each entry uploads exactly once instead of re-sending the tail every
    // tick (which previously created duplicate rows server-side every 30s).
    const startIdx = Math.max(0, this.uploadedThrough - this.evicted);
    const batch = this.buffer.slice(startIdx, startIdx + UPLOAD_BATCH_SIZE);
    if (batch.length === 0) return;
    try {
      const res = await fetch(`${this.apiBase}/v1/apps/${encodeURIComponent(this.appId)}/logs`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.auth.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ entries: batch }),
      });
      // On failure leave the watermark untouched and retry next interval.
      if (!res.ok) return;
      this.uploadedThrough = this.evicted + startIdx + batch.length;
    } catch {
      // Network failure, watermark unchanged — will retry next interval
    }
  }

  destroy() {
    if (this.uploadTimer) clearInterval(this.uploadTimer);
  }
}
