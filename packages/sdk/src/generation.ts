import { authedFetch, type SessionAuth } from './authed-fetch.js';

/** `contribute` extends a lease this close to its expiry while `generate` still runs (#783). */
const LEASE_MARGIN_MS = 5 * 60_000;
/** An upload must start at least this long before its lease runs out (as on the phones). */
const UPLOAD_MARGIN_MS = 30_000;
/** How long a claim keeps retrying a transient failure (#819 parity). */
const CLAIM_WINDOW_MS = 60_000;
/** A lease extension that failed transiently is tried again after this long. */
const EXTEND_RETRY_MS = 30_000;

/** A failed API call: its HTTP status, and `Retry-After` in milliseconds when the server sent one. */
export class GenerationError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'GenerationError';
  }
}

/**
 * The wait before trying a failed call again (`attempt` from 0), or null when the failure is
 * final, as the phone runners do (#819): a network failure (fetch's `TypeError`), a `5xx` or `408`
 * after 2 s doubling to 60 s (or `Retry-After`), and a `429` only when it says when (`Retry-After`;
 * without it, it is the daily limit). Any other failure is final.
 */
export function generationRetryDelay(err: unknown, attempt: number): number | null {
  const backoff = Math.min(60_000, 2_000 * 2 ** Math.min(attempt, 5));
  if (err instanceof TypeError) return backoff;
  if (!(err instanceof GenerationError)) return null;
  if (err.status === 429) return err.retryAfterMs;
  if (err.status >= 500 || err.status === 408) return err.retryAfterMs ?? backoff;
  return null;
}

function retryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

/** Resolves after `ms`, or rejects with the signal's reason as soon as it aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const RUNNER_KEY = 'fas:generation-runner';
let sessionRunner: string | undefined;

/**
 * This browser's runner id (#825), sent as `X-Runner-Id` so each of a user's
 * devices holds its own lease: random once per install (localStorage), or once
 * per page load where storage is unavailable.
 */
function runnerId(): string {
  try {
    let id = localStorage.getItem(RUNNER_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(RUNNER_KEY, id);
    }
    return id;
  } catch {
    sessionRunner ??= crypto.randomUUID();
    return sessionRunner;
  }
}

export type GenerationFormat = 'audio/mp4' | 'audio/ogg' | 'audio/wav';

/** A local model a device can run. */
export interface GenerationModel {
  model: string;
  modelVersion: string;
}

/** What the app owner asks devices to generate. */
export interface GenerationSetOptions extends GenerationModel {
  kind: 'tts';
  params: Record<string, unknown>;
  formats: GenerationFormat[];
  maxBytes: number;
  /** Distinct users who must each pass verification and agree (1-3). */
  replicas: 1 | 2 | 3;
  requireAttestation?: boolean;
  /**
   * BCP 47 tag of the input text (`en`, `es`, `zh`, `zh-Hans`, …). Verification takes the default
   * characters-per-second band from it (`zh` 2-9, `ja` 3-15, others 8-30). Sets, claimed jobs and
   * `openWork` echo it, `null` when none.
   */
  language?: string | null;
  /** Verification overrides: the characters-per-second band (default by `language`). */
  minCharsPerSecond?: number;
  maxCharsPerSecond?: number;
}

/** What the contributor's device said of its own upload (#831): good or not, an optional note. */
export interface GenerationReport {
  good: boolean;
  note: string | null;
  at: number;
}

/** The owner's review of one exact artifact version (#787, #831); `by` is the reviewer's login. */
export interface GenerationReview {
  status: 'reviewed' | 'needs_changes';
  note: string | null;
  by: string;
  at: number;
}

export interface GenerationSet extends GenerationSetOptions {
  id: string;
}

/** A claimed job: generate `input` with exactly this model, then `submit` before the lease expires. */
export interface GenerationJob extends GenerationModel {
  id: string;
  setId: string;
  key: string;
  input: { text: string };
  params: Record<string, unknown>;
  formats: GenerationFormat[];
  maxBytes: number;
  /** The set's BCP 47 language tag, or null when it names none. */
  language: string | null;
  leaseToken: string;
  /** Lease end (ms epoch). */
  leaseExpiresAt: number;
}

export type GenerationSubmissionStatus = 'pending' | 'accepted' | 'rejected' | 'superseded';

/** One of the caller's own submissions (`mySubmissions`). */
export interface GenerationSubmission {
  submissionId: string;
  jobId: string;
  setId: string;
  key: string;
  status: GenerationSubmissionStatus;
  reason: string | null;
  bytes: number;
  contentType: GenerationFormat;
  createdAt: number;
  decidedAt: number | null;
  /** Audio duration verification measured; null until verified. */
  durationMs: number | null;
  /** This user's own Good / Not good for the upload (`report`), or null. */
  report: GenerationReport | null;
  /** The job's input, as the claim returned it. */
  input: { text: string };
  /**
   * The job's accepted artifact (absolute URLs; `metaUrl` null when it has no meta), or null while
   * none is. It may be another user's: it is this submission's only when `status` is `accepted`.
   */
  artifact: { url: string; metaUrl: string | null } | null;
}

/** A verified, write-once artifact. `url` and `metaUrl` are absolute. */
export interface GenerationArtifact extends GenerationModel {
  key: string;
  jobId: string;
  url: string;
  metaUrl?: string;
  bytes: number;
  contentType: GenerationFormat;
  durationMs: number;
  sha256: string;
  acceptedAt: number;
}

/** Who contributed; null once their account is deleted. */
export interface GenerationContributor {
  id: string;
  login: string | null;
}

/** A set with its progress (`listSets`). */
export interface GenerationSetSummary extends GenerationSet {
  createdAt: number;
  counts: {
    jobs: number;
    /** Jobs by status. */
    open: number;
    accepted: number;
    /** Live leases. */
    leased: number;
    /** Submissions by outcome; `withdrawn` are those the owner withdrew. */
    pending: number;
    rejected: number;
    withdrawn: number;
  };
}

/** How a job attempt ended on the device (#813), the same on every runner; `submitted`: it uploaded. */
export type GenerationEndReason =
  | 'submitted'
  | 'user_stop'
  | 'unplugged'
  | 'thermal'
  | 'background_expired'
  | 'network'
  | 'lease_403'
  | 'lease_cap'
  | 'model_missing'
  | 'model_error'
  | 'encode_error'
  | 'too_large'
  | 'unsupported'
  | 'server_4xx'
  | 'server_5xx'
  | 'other';

/**
 * What a device measured while it ran one leased job (#827), as `POST …/generation/events` takes
 * it: numbers and context only, no text or audio. Times in milliseconds; battery 0-100; `rtf` is
 * synthesis time over audio duration; `cpuMs` and `peakMemMb` only where the platform exposes them.
 */
export interface GenerationAttemptRecord {
  runner: 'android' | 'ios' | 'browser' | 'desktop';
  reason: GenerationEndReason;
  error?: string;
  appVersion?: string;
  os?: string;
  device?: string;
  network?: string;
  /** Whether it ran in the background at any point. */
  background?: boolean;
  thermalStart?: string;
  thermalEnd?: string;
  batteryStart?: number;
  batteryEnd?: number;
  chargingStart?: boolean;
  chargingEnd?: boolean;
  startedAt?: number;
  wallMs?: number;
  loadMs?: number;
  synthMs?: number;
  encodeMs?: number;
  uploadMs?: number;
  cpuMs?: number;
  peakMemMb?: number;
  rtf?: number;
  bytes?: number;
  durationMs?: number;
}

/** An attempt record as the owner sees it, with when the server received it. */
export type GenerationAttempt = GenerationAttemptRecord & { createdAt: number };

/** A job as the owner sees it (`listJobs`). */
export interface GenerationJobSummary {
  id: string;
  key: string;
  status: 'open' | 'accepted';
  /** The first 200 characters of the input text. */
  inputPreview: string;
  inputChars: number;
  createdAt: number;
  artifact: {
    url: string;
    /** The submission this version came from: `review` names it. */
    submissionId: string;
    durationMs: number | null;
    bytes: number;
    contributor: GenerationContributor | null;
    acceptedAt: number;
    /** Null: not reviewed. A version generated again starts unreviewed. */
    review: GenerationReview | null;
  } | null;
  /** The 5 latest, newest first. */
  submissions: {
    id: string;
    contributor: GenerationContributor | null;
    deviceKind: 'web' | 'native';
    attestation: 'none' | 'unverified' | 'verified';
    status: GenerationSubmissionStatus;
    reason: string | null;
    durationMs: number | null;
    createdAt: number;
    decidedAt: number | null;
    /** The contributor's own Good / Not good, or null. */
    report: GenerationReport | null;
    /** The device's attempt record for this upload (#827), or null when it sent none. */
    record: GenerationAttempt | null;
  }[];
  /** The 5 latest attempts that ended without an upload (#827). */
  attempts: (GenerationAttempt & { contributor: GenerationContributor | null })[];
}

/** One job with its whole input (`getJob`). */
export interface GenerationJobDetail extends GenerationJobSummary {
  input: { text: string };
  /** Every review the owner recorded on any version of the job, newest first (#791). */
  reviews: (GenerationReview & { submissionId: string })[];
}

/** A set with jobs the caller could claim now (`openWork`). */
export interface GenerationOpenSet extends GenerationModel {
  setId: string;
  kind: 'tts';
  params: Record<string, unknown>;
  formats: GenerationFormat[];
  maxBytes: number;
  /** The set's BCP 47 language tag, or null when it names none. */
  language: string | null;
  /** Jobs this user could claim. */
  open: number;
}

/** An app with open work, as `GET /v1/generation/open` lists them for a console session or device. */
export interface GenerationOpenApp {
  appId: string;
  oneliner: string | null;
  sets: GenerationOpenSet[];
}

/** The lease of the job being generated, as `contribute` hands it to `generate`. */
export interface GenerationLease {
  /**
   * Extend the lease now if it is within 5 minutes of expiry (otherwise nothing). `contribute`
   * also does this on a timer; a generator that calls it as it makes progress (e.g. on every
   * message from its worker) keeps the lease even where the page's timers are throttled, as in a
   * background tab. Never rejects.
   */
  renew(): Promise<void>;
}

export interface ContributeOptions {
  setId?: string;
  models: GenerationModel[];
  /** Runs the app's own local model; the SDK bundles none. */
  generate: (job: GenerationJob, lease: GenerationLease) => Promise<{ file: Blob; meta?: unknown }>;
  signal?: AbortSignal;
  /** Claim at most this many jobs, then stop with `limit`. */
  limit?: number;
  onProgress?: (event: {
    stage: 'generating' | 'submitted';
    job: GenerationJob;
    submitted: number;
  }) => void;
}

/**
 * Community generation: the app owner publishes jobs, signed-in users' devices
 * generate them with a local model, and the server verifies each upload before
 * it becomes a public, write-once artifact.
 */
export class Generation {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: SessionAuth,
  ) {}

  // ── Owner ──

  async createSet(opts: GenerationSetOptions): Promise<GenerationSet> {
    return ((await this.json('/sets', 'POST', opts)) as { set: GenerationSet }).set;
  }

  /** 1-500 jobs per call. Re-adding a key with a different input is a 409. */
  async addJobs(
    setId: string,
    jobs: { key: string; input: { text: string } }[],
  ): Promise<{ id: string; key: string; status: string }[]> {
    const path = `/sets/${encodeURIComponent(setId)}/jobs`;
    return (
      (await this.json(path, 'POST', { jobs })) as {
        jobs: { id: string; key: string; status: string }[];
      }
    ).jobs;
  }

  /** The app's sets, newest first, with progress counts. */
  async listSets(): Promise<GenerationSetSummary[]> {
    return ((await (await this.request('/sets', {})).json()) as { sets: GenerationSetSummary[] })
      .sets;
  }

  /**
   * A page of a set's jobs by key; pass `nextCursor` back as `cursor` for the next page. `review`
   * keeps the accepted jobs whose current version has that review (#787).
   */
  async listJobs(
    setId: string,
    opts: {
      status?: 'open' | 'accepted';
      review?: 'unreviewed' | GenerationReview['status'];
      cursor?: string;
      limit?: number;
    } = {},
  ): Promise<{ jobs: GenerationJobSummary[]; nextCursor: string | null }> {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(opts))
      if (value !== undefined) query.set(name, String(value));
    const qs = query.toString();
    const path = `/sets/${encodeURIComponent(setId)}/jobs${qs ? `?${qs}` : ''}`;
    return (await (await this.request(path, {})).json()) as {
      jobs: GenerationJobSummary[];
      nextCursor: string | null;
    };
  }

  /** One job as `listJobs` shows it, with its whole input (e.g. to follow its audio's sentence timings). */
  async getJob(setId: string, jobId: string): Promise<GenerationJobDetail> {
    const path = `/sets/${encodeURIComponent(setId)}/jobs/${encodeURIComponent(jobId)}`;
    return ((await (await this.request(path, {})).json()) as { job: GenerationJobDetail }).job;
  }

  /** Remove an artifact; its job reopens. */
  async withdraw(jobId: string): Promise<void> {
    await this.request(`/artifacts/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
  }

  /**
   * Mark the job's current artifact `reviewed` or `needs_changes` (#787), with an optional note of
   * at most 500 characters. `submissionId` (`artifact.submissionId`) names the exact version; a
   * `409` means the artifact is another version now. Console sessions of the owner only. A review
   * never publishes or withdraws anything.
   */
  async review(
    jobId: string,
    submissionId: string,
    status: GenerationReview['status'],
    note?: string,
  ): Promise<GenerationReview> {
    const path = `/artifacts/${encodeURIComponent(jobId)}/review`;
    const body = { submissionId, status, note };
    return ((await this.json(path, 'PUT', body)) as { review: GenerationReview }).review;
  }

  /** Withdraw everything this user contributed and refuse their future submissions. */
  async blockContributor(userId: string): Promise<void> {
    await this.request(`/contributors/${encodeURIComponent(userId)}/block`, { method: 'POST' });
  }

  // ── Contributor ──

  /**
   * Lease one open job (15 minutes), or null when there is no work for these models. A new claim
   * releases this browser's previous lease; other devices keep theirs, up to 4 per user (then 429).
   */
  async claim(opts: { setId?: string; models: GenerationModel[] }): Promise<GenerationJob | null> {
    const response = await this.request('/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Runner-Id': runnerId() },
      body: JSON.stringify(opts),
    });
    if (response.status === 204) return null;
    return ((await response.json()) as { job: GenerationJob }).job;
  }

  /** Upload a result against the job's lease. It stays private until verified. */
  async submit(
    job: GenerationJob,
    file: Blob,
    opts: { meta?: unknown; attestation?: string } = {},
  ): Promise<{ submissionId: string; status: 'pending' }> {
    const body = new FormData();
    body.append('file', file);
    if (opts.meta !== undefined) body.append('meta', JSON.stringify(opts.meta));
    const headers: Record<string, string> = {
      'X-Lease-Token': job.leaseToken,
      'X-Runner-Id': runnerId(),
    };
    if (opts.attestation) headers['X-Attestation'] = opts.attestation;
    const response = await this.request(`/jobs/${encodeURIComponent(job.id)}/result`, {
      method: 'PUT',
      headers,
      body,
    });
    return (await response.json()) as { submissionId: string; status: 'pending' };
  }

  /**
   * Extend the job's lease while still generating: to 15 minutes from now, at
   * most 2 hours after the claim. Updates and returns `job.leaseExpiresAt`;
   * throws once the cap is reached (409) or the lease is no longer valid (403).
   */
  async extendLease(job: GenerationJob): Promise<number> {
    const response = await this.request(`/jobs/${encodeURIComponent(job.id)}/lease`, {
      method: 'POST',
      headers: { 'X-Lease-Token': job.leaseToken, 'X-Runner-Id': runnerId() },
    });
    job.leaseExpiresAt = ((await response.json()) as { leaseExpiresAt: number }).leaseExpiresAt;
    return job.leaseExpiresAt;
  }

  /** This app's sets with jobs the user could claim now. The device picks the models it can run. */
  async openWork(): Promise<GenerationOpenSet[]> {
    const url = `${this.apiBase}/v1/generation/open?appId=${encodeURIComponent(this.appId)}`;
    const { apps } = (await (await this.send(url, {})).json()) as {
      apps: { sets: GenerationOpenSet[] }[];
    };
    return apps[0]?.sets ?? [];
  }

  /**
   * Report how attempts at jobs this user leased went (#827), 1-50 at a time; one record per
   * lease, a resend replaces it. Returns how many were recorded (jobs never leased are ignored).
   */
  async recordAttempts(events: (GenerationAttemptRecord & { jobId: string })[]): Promise<number> {
    return ((await this.json('/events', 'POST', { events })) as { recorded: number }).recorded;
  }

  /**
   * Say whether one of the caller's own uploads is good (#831), with an optional note of at most
   * 500 characters; the owner sees it. Sending again changes it.
   */
  async report(submissionId: string, good: boolean, note?: string): Promise<GenerationReport> {
    const path = `/submissions/${encodeURIComponent(submissionId)}/report`;
    return ((await this.json(path, 'PUT', { good, note })) as { report: GenerationReport }).report;
  }

  /** The caller's 100 newest submissions to this app, newest first. */
  async mySubmissions(): Promise<GenerationSubmission[]> {
    return (
      (await (await this.request('/submissions', {})).json()) as {
        submissions: GenerationSubmission[];
      }
    ).submissions;
  }

  /**
   * Claim → generate → submit until there is no work, `signal` aborts, `limit` jobs were claimed,
   * or a lease expires before its result is ready (that job is abandoned). While `generate` runs,
   * the lease is extended within 5 minutes of its expiry (on a timer and whenever `generate` calls
   * `lease.renew()`); a job is abandoned only once its lease can't be extended (the 2-hour cap, or
   * the lease is gone). As on the phones (#819), a claim that fails transiently (see
   * `generationRetryDelay`) is tried again for up to a minute, and an upload sends the same file
   * again, extending the lease as due, until 30 s before the lease ends; then the last failure is
   * thrown. Nothing is generated twice.
   */
  async contribute(opts: ContributeOptions): Promise<{
    submitted: number;
    stopped: 'no-work' | 'aborted' | 'lease-expired' | 'limit';
  }> {
    const { generate, signal, onProgress, limit = Infinity, ...query } = opts;
    let submitted = 0;
    let claimed = 0;
    try {
      while (!signal?.aborted) {
        if (claimed >= limit) return { submitted, stopped: 'limit' };
        const window = Date.now() + CLAIM_WINDOW_MS;
        const job = await this.retrying(
          () => this.claim(query),
          () => window,
          signal,
        );
        if (!job) return { submitted, stopped: 'no-work' };
        claimed++;
        onProgress?.({ stage: 'generating', job, submitted });
        const lease = this.keepLeased(job);
        try {
          const { file, meta } = await generate(job, lease);
          if (signal?.aborted) break;
          await lease.renew();
          const deadline = () => job.leaseExpiresAt - UPLOAD_MARGIN_MS;
          if (Date.now() >= deadline()) return { submitted, stopped: 'lease-expired' };
          await this.retrying(
            () => this.submit(job, file, { meta }),
            deadline,
            signal,
            lease.renew,
          );
        } finally {
          lease.stop();
        }
        submitted++;
        onProgress?.({ stage: 'submitted', job, submitted });
      }
    } catch (err) {
      if (!signal?.aborted) throw err;
    }
    return { submitted, stopped: 'aborted' };
  }

  /**
   * `call`, tried again after `generationRetryDelay` (then `beforeRetry`) while the wait ends
   * before `until()`; otherwise its failure is thrown. Waiting stops as soon as `signal` aborts.
   */
  private async retrying<T>(
    call: () => Promise<T>,
    until: () => number,
    signal?: AbortSignal,
    beforeRetry?: () => Promise<void>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call();
      } catch (err) {
        const wait = generationRetryDelay(err, attempt);
        if (wait === null || signal?.aborted || Date.now() + wait >= until()) throw err;
        await sleep(wait, signal);
        await beforeRetry?.();
      }
    }
  }

  /**
   * Keeps `job` leased while it is generated: `renew` extends it once within 5 minutes of expiry,
   * also called by a timer. A `403` (lease gone) or `409` (2-hour cap) ends extending; any other
   * failure is tried again at the next `renew`, or by the timer after 30 s.
   */
  private keepLeased(job: GenerationJob): GenerationLease & { stop(): void } {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let extendable = true;
    let retryAt = 0;
    let pending: Promise<void> | null = null;
    const schedule = () => {
      clearTimeout(timer);
      if (stopped || !extendable) return;
      const at = Math.max(job.leaseExpiresAt - LEASE_MARGIN_MS, retryAt);
      timer = setTimeout(() => void renew(), Math.max(0, at - Date.now()));
    };
    const renew = (): Promise<void> => {
      const now = Date.now();
      // Not due yet, or already over (the server refuses an expired lease)
      const due = now >= job.leaseExpiresAt - LEASE_MARGIN_MS && now < job.leaseExpiresAt;
      if (stopped || !extendable || !due) return Promise.resolve();
      pending ??= this.extendLease(job)
        .then(
          () => {},
          (err) => {
            if (err instanceof GenerationError && (err.status === 403 || err.status === 409))
              extendable = false;
            else retryAt = Date.now() + EXTEND_RETRY_MS;
          },
        )
        .finally(() => {
          pending = null;
          schedule();
        });
      return pending;
    };
    schedule();
    return {
      renew,
      stop: () => {
        stopped = true;
        clearTimeout(timer);
      },
    };
  }

  // ── Public ──

  /** Accepted artifacts of a set, with absolute URLs. No sign-in needed. */
  async manifest(setId: string): Promise<GenerationArtifact[]> {
    const response = await fetch(this.url(`/sets/${encodeURIComponent(setId)}/manifest`));
    if (!response.ok) throw new Error(`generation.manifest failed: ${response.status}`);
    const { artifacts } = (await response.json()) as { artifacts: GenerationArtifact[] };
    return artifacts.map((artifact) => ({
      ...artifact,
      url: new URL(artifact.url, this.apiBase).href,
      ...(artifact.metaUrl && { metaUrl: new URL(artifact.metaUrl, this.apiBase).href }),
    }));
  }

  private url(suffix: string): string {
    return `${this.apiBase}/v1/apps/${encodeURIComponent(this.appId)}/generation${suffix}`;
  }

  private async json(suffix: string, method: string, body: unknown): Promise<unknown> {
    const response = await this.request(suffix, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.json();
  }

  private request(suffix: string, init: Parameters<typeof authedFetch>[2]): Promise<Response> {
    return this.send(this.url(suffix), init);
  }

  private async send(url: string, init: Parameters<typeof authedFetch>[2]): Promise<Response> {
    const response = await authedFetch(this.auth, url, init);
    if (!response.ok)
      throw new GenerationError(
        (await response.text()) || `Generation request failed (${response.status}).`,
        response.status,
        retryAfter(response.headers.get('Retry-After')),
      );
    return response;
  }
}
