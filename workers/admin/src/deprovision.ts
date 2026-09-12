import {
  cfApi,
  decodeRegistry,
  encodeRegistry,
  type GhFn,
  ghApi,
  type PublishEnv,
  STORE_CONFIG,
  type Step,
  type Store,
  type StoreConfig,
} from "./publish";

/** Injectable Cloudflare API caller, mirroring GhFn. */
export type CfFn = (path: string, method?: string, body?: any) => Promise<any>;

export interface DeprovisionRequest {
  id: string;
  store: Store;
  deleteRepo?: boolean;
}

export interface DeprovisionEnv extends PublishEnv {
  /** Path B host bucket (fas-apps) — purge apps/<id>/* here. */
  APPS?: R2Bucket;
}

/** Remove the app's entry from the storefront's registry.json, retry-once on
 *  409 like writeRegistryWithRetry. Done in-process: the previous
 *  implementation fetched the worker's own public /api/unpublish URL, which
 *  goes through CF Access and was answered with a 302 to the login page — so
 *  every deprovision reported "Not in registry" while the entry stayed put. */
export async function removeRegistryEntry(gh: GhFn, id: string, config: StoreConfig): Promise<Step> {
  const registryPath = `/repos/${config.org}/${config.storeRepo}/contents/registry.json`;
  const key = config.registryKey;

  const attempt = async (): Promise<Step | null> => {
    const registryFile = await gh(registryPath);
    if (!registryFile.content) {
      return { name: "registry", status: "fail", detail: "Could not read registry.json" };
    }
    const content = decodeRegistry(registryFile);
    const items: any[] = content[key] || [];
    const remaining = items.filter((a) => a?.id !== id);
    if (remaining.length === items.length) {
      return { name: "registry", status: "skip", detail: "Not in registry" };
    }
    content[key] = remaining;
    const updateResult = await gh(registryPath, "PUT", {
      message: `Unpublish ${id}`,
      content: encodeRegistry(content),
      sha: registryFile.sha,
    });
    if (updateResult.content) return { name: "registry", status: "ok", detail: "Removed" };
    if (updateResult.__status === 409) return null;
    return { name: "registry", status: "fail", detail: updateResult.message || "Failed to update registry.json" };
  };

  const first = await attempt();
  if (first !== null) return first;
  const second = await attempt();
  if (second !== null) return second;
  return { name: "registry", status: "fail", detail: "Registry write contended twice — retry the unpublish" };
}

/** Delete the two D1 rows insertHostRoute writes: the `routes` row the host
 *  reads, AND the `apps` ownership row. Same batch so they can't drift.
 *  Until this existed nothing deleted the `apps` row at all, so an unpublished
 *  app stayed owned, listed in /v1/apps/creators, and reachable through every
 *  per-app backend feature. */
export async function deleteHostRoute(env: DeprovisionEnv, id: string, config: StoreConfig): Promise<Step> {
  if (!env.DB) {
    return { name: "hosting_route", status: "fail", detail: "D1 binding not available" };
  }
  try {
    const routesStmt = env.DB.prepare("DELETE FROM routes WHERE slug = ?1 AND zone = ?2").bind(id, config.domain);
    const appsStmt = env.DB.prepare("DELETE FROM apps WHERE id = ?1").bind(id);
    await env.DB.batch([routesStmt, appsStmt]);
    return { name: "hosting_route", status: "ok", detail: "Route + ownership row deleted" };
  } catch (e: any) {
    return { name: "hosting_route", status: "fail", detail: e?.message ?? "D1 delete failed" };
  }
}

export async function purgeR2Objects(env: DeprovisionEnv, id: string, config: StoreConfig): Promise<Step> {
  const prefix = `${config.registryKey}/${id}/`;
  if (!env.APPS) {
    return { name: "r2_objects", status: "skip", detail: "R2 binding (APPS) not available" };
  }
  try {
    let deleted = 0;
    let cursor: string | undefined;
    do {
      const listed = await env.APPS.list({ prefix, cursor });
      if (listed.objects.length > 0) {
        await env.APPS.delete(listed.objects.map((o) => o.key));
        deleted += listed.objects.length;
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
    return { name: "r2_objects", status: "ok", detail: `${deleted} object(s) under ${prefix}` };
  } catch (e: any) {
    return { name: "r2_objects", status: "fail", detail: e?.message ?? "R2 purge failed" };
  }
}

export async function deleteDnsRecords(cf: CfFn, env: DeprovisionEnv, id: string, config: StoreConfig): Promise<Step> {
  const zone = config.zoneIdFromEnv(env);
  if (!zone) return { name: "dns", status: "fail", detail: "zone id not configured" };
  try {
    const list = await cf(`/zones/${zone}/dns_records?type=CNAME&name=${id}.${config.domain}`);
    const records: { id: string }[] = list.result ?? [];
    for (const rec of records) {
      await cf(`/zones/${zone}/dns_records/${rec.id}`, "DELETE");
    }
    return { name: "dns", status: "ok", detail: `${records.length} record(s) deleted` };
  } catch (e: any) {
    return { name: "dns", status: "fail", detail: e?.message ?? "DNS delete failed" };
  }
}

/** DELETE the org repo. 404 counts as done. 403 is the token lacking the
 *  delete-repository permission — say so, because "HTTP 403" alone sent the
 *  first investigation of this step to CF Access instead of the token. */
export async function deleteRepo(gh: GhFn, id: string, config: StoreConfig): Promise<Step> {
  try {
    const res = await gh(`/repos/${config.org}/${id}`, "DELETE");
    const status: number | undefined = res.__status;
    if (status === 204 || status === 404) return { name: "delete_repo", status: "ok", detail: status === 404 ? "Already gone" : "Deleted" };
    if (status === 403) {
      return {
        name: "delete_repo",
        status: "fail",
        detail: "HTTP 403 — GITHUB_TOKEN lacks repo deletion (classic scope delete_repo / fine-grained Administration: write)",
      };
    }
    return { name: "delete_repo", status: "fail", detail: `HTTP ${status ?? "?"}${res.message ? ` ${res.message}` : ""}` };
  } catch (e: any) {
    return { name: "delete_repo", status: "fail", detail: e?.message ?? "GitHub delete failed" };
  }
}

export async function handleDeprovision(
  req: DeprovisionRequest,
  env: DeprovisionEnv,
  deps?: { gh?: GhFn; cf?: CfFn },
): Promise<{ ok: boolean; id: string; steps: Step[] }> {
  const config = STORE_CONFIG[req.store];
  if (!req.id || !config) {
    return { ok: false, id: req.id, steps: [{ name: "validation", status: "fail", detail: "id and a supported store are required" }] };
  }
  const gh: GhFn = deps?.gh ?? ((path, method, body) => ghApi(env, path, method, body));
  const cf: CfFn = deps?.cf ?? ((path, method, body) => cfApi(env, path, method, body));

  const steps: Step[] = [];
  steps.push(await removeRegistryEntry(gh, req.id, config));
  steps.push(await deleteHostRoute(env, req.id, config));
  steps.push(await purgeR2Objects(env, req.id, config));
  steps.push(await deleteDnsRecords(cf, env, req.id, config));
  if (req.deleteRepo) steps.push(await deleteRepo(gh, req.id, config));

  const ok = steps.every((s) => s.status !== "fail");
  return { ok, id: req.id, steps };
}
