export interface AdminGithubDeployStatus {
  status: string | null;
  conclusion: string | null;
  at: string | null;
  sha: string | null;
  url?: string | null;
  branch?: string | null;
  neverDeployed?: boolean;
}

export interface AdminFailingDeployApp {
  id: string;
  name?: string | null;
  owner?: string | null;
  ownerDisplayName?: string | null;
  appUrl?: string | null;
  domain?: string | null;
  latestSession?: {
    deployed?: boolean;
    deployState?: { phase?: string | null } | null;
  } | null;
  sessionCount?: number;
}

export interface AdminFailingDeploySession {
  sessionId: string;
  userId?: string | null;
  userLogin?: string | null;
  userDisplayName?: string | null;
  name?: string | null;
  appId: string | null;
  deployState?: { phase?: string | null; error?: string | null } | null;
  deployLog?: { phase?: string | null; detail?: string | null; timestamp?: string | null }[];
  updatedAt?: string | number | null;
}

export interface FailingDeployRow {
  key: string;
  source: "github" | "session";
  appId: string;
  appLabel: string;
  appUrl: string | null;
  ownerLogin: string;
  errorSummary: string;
  failedAt: string | number | null;
  actionsUrl: string | null;
  sessionId?: string;
}

export function githubActionsUrl(appId: string | null | undefined): string | null {
  return appId ? `https://github.com/freeappstore-online/${appId}/actions` : null;
}

export function appPublicUrl(app: AdminFailingDeployApp | undefined, appId: string): string | null {
  if (app?.appUrl) return app.appUrl;
  if (app?.domain) return `https://${app.domain}`;
  return appId ? `https://${appId}.freeappstore.online` : null;
}

export function deployStatusForApp(
  app: AdminFailingDeployApp,
  statuses: Record<string, AdminGithubDeployStatus>,
): string {
  const gh = statuses[app.id];
  if (gh) return deployStatusLabel(gh);
  if (app.latestSession?.deployed) return "deployed";
  return app.latestSession?.deployState?.phase || (app.sessionCount ? "draft" : "none");
}

export function buildFailingDeployRows({
  sessions,
  statuses,
  apps,
}: {
  sessions: AdminFailingDeploySession[];
  statuses: Record<string, AdminGithubDeployStatus>;
  apps: AdminFailingDeployApp[];
}): FailingDeployRow[] {
  const appsById = new Map(apps.map((app) => [app.id, app]));
  const sessionByApp = new Map<string, AdminFailingDeploySession>();
  const sessionOnly: AdminFailingDeploySession[] = [];

  for (const session of sessions) {
    if (session.deployState?.phase !== "error") continue;
    const appId = session.appId;
    if (!appId) {
      sessionOnly.push(session);
      continue;
    }
    const current = sessionByApp.get(appId);
    if (!current || comparableTime(session.updatedAt) > comparableTime(current.updatedAt)) {
      sessionByApp.set(appId, session);
    }
  }

  const rows: FailingDeployRow[] = [];
  const appsWithGhFailure = new Set<string>();

  for (const [appId, status] of Object.entries(statuses)) {
    if (status.conclusion !== "failure") continue;
    appsWithGhFailure.add(appId);
    const app = appsById.get(appId);
    const session = sessionByApp.get(appId);
    rows.push({
      key: `github:${appId}`,
      source: "github",
      appId,
      appLabel: app?.name || appId,
      appUrl: appPublicUrl(app, appId),
      ownerLogin: ownerFor(app, session),
      errorSummary: summarizeError(sessionError(session) || githubFailureSummary(status)),
      failedAt: status.at || session?.updatedAt || null,
      actionsUrl: status.url || githubActionsUrl(appId),
      sessionId: session?.sessionId,
    });
  }

  for (const session of [...sessionByApp.values(), ...sessionOnly]) {
    const appId = session.appId || session.sessionId;
    if (session.appId && appsWithGhFailure.has(session.appId)) continue;
    const app = session.appId ? appsById.get(session.appId) : undefined;
    rows.push({
      key: `session:${session.sessionId}`,
      source: "session",
      appId,
      appLabel: app?.name || session.name || appId,
      appUrl: session.appId ? appPublicUrl(app, session.appId) : null,
      ownerLogin: ownerFor(app, session),
      errorSummary: summarizeError(sessionError(session) || "VibeCode deploy failed"),
      failedAt: session.updatedAt || null,
      actionsUrl: githubActionsUrl(session.appId),
      sessionId: session.sessionId,
    });
  }

  return rows.sort((a, b) => comparableTime(b.failedAt) - comparableTime(a.failedAt));
}

function deployStatusLabel(status: AdminGithubDeployStatus): string {
  if (status.neverDeployed) return "not deployed";
  if (status.status === "in_progress" || status.status === "queued" || status.status === "waiting") return status.status;
  if (status.conclusion) return status.conclusion;
  return status.status || "unknown";
}

function ownerFor(app: AdminFailingDeployApp | undefined, session: AdminFailingDeploySession | undefined): string {
  return app?.owner || session?.userLogin || session?.userId || app?.ownerDisplayName || "unknown";
}

function sessionError(session: AdminFailingDeploySession | undefined): string {
  if (!session) return "";
  if (session.deployState?.error) return session.deployState.error;
  const lastError = [...(session.deployLog || [])].reverse().find((entry) => entry.phase === "error" && entry.detail);
  return lastError?.detail || "";
}

function githubFailureSummary(status: AdminGithubDeployStatus): string {
  const suffix = [status.branch, status.sha].filter(Boolean).join(" ");
  return suffix ? `GitHub Actions concluded failure (${suffix})` : "GitHub Actions concluded failure";
}

function summarizeError(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 120) || "Deploy failed";
}

function comparableTime(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return value < 10_000_000_000 ? value * 1000 : value;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}
