import type { Auth } from './auth.js';
import { authedFetch } from './authed-fetch.js';

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
  leaseToken: string;
  /** Lease end (ms epoch). */
  leaseExpiresAt: number;
}

export type GenerationSubmissionStatus = 'pending' | 'accepted' | 'rejected' | 'superseded';

export interface GenerationSubmission {
  id: string;
  jobId: string;
  status: GenerationSubmissionStatus;
  reason: string | null;
  createdAt: number;
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

export interface ContributeOptions {
  setId?: string;
  models: GenerationModel[];
  /** Runs the app's own local model; the SDK bundles none. */
  generate: (job: GenerationJob) => Promise<{ file: Blob; meta?: unknown }>;
  signal?: AbortSignal;
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
    private readonly auth: Auth,
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

  /** Remove an artifact; its job reopens. */
  async withdraw(jobId: string): Promise<void> {
    await this.request(`/artifacts/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
  }

  /** Withdraw everything this user contributed and refuse their future submissions. */
  async blockContributor(userId: string): Promise<void> {
    await this.request(`/contributors/${encodeURIComponent(userId)}/block`, { method: 'POST' });
  }

  // ── Contributor ──

  /** Lease one open job (15 minutes), or null when there is no work for these models. */
  async claim(opts: { setId?: string; models: GenerationModel[] }): Promise<GenerationJob | null> {
    const response = await this.request('/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
    const headers: Record<string, string> = { 'X-Lease-Token': job.leaseToken };
    if (opts.attestation) headers['X-Attestation'] = opts.attestation;
    const response = await this.request(`/jobs/${encodeURIComponent(job.id)}/result`, {
      method: 'PUT',
      headers,
      body,
    });
    return (await response.json()) as { submissionId: string; status: 'pending' };
  }

  async mySubmissions(): Promise<GenerationSubmission[]> {
    return (
      (await (await this.request('/submissions', {})).json()) as {
        submissions: GenerationSubmission[];
      }
    ).submissions;
  }

  /**
   * Claim → generate → submit until there is no work, `signal` aborts, or a
   * lease expires before its result is ready (that job is abandoned).
   */
  async contribute(
    opts: ContributeOptions,
  ): Promise<{ submitted: number; stopped: 'no-work' | 'aborted' | 'lease-expired' }> {
    const { generate, signal, onProgress, ...query } = opts;
    let submitted = 0;
    while (!signal?.aborted) {
      const job = await this.claim(query);
      if (!job) return { submitted, stopped: 'no-work' };
      onProgress?.({ stage: 'generating', job, submitted });
      const { file, meta } = await generate(job);
      if (signal?.aborted) break;
      if (Date.now() >= job.leaseExpiresAt) return { submitted, stopped: 'lease-expired' };
      await this.submit(job, file, { meta });
      onProgress?.({ stage: 'submitted', job, submitted: ++submitted });
    }
    return { submitted, stopped: 'aborted' };
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

  private async request(
    suffix: string,
    init: Parameters<typeof authedFetch>[2],
  ): Promise<Response> {
    const response = await authedFetch(this.auth, this.url(suffix), init);
    if (!response.ok)
      throw new Error((await response.text()) || `Generation request failed (${response.status}).`);
    return response;
  }
}
