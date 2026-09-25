export type OwnershipResult = { owned: boolean } | { error: string; status: number };

function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text) return res.statusText || `API ${res.status}`;
  try {
    const json = JSON.parse(text) as { error?: string; message?: string; detail?: string };
    return json.error ?? json.message ?? json.detail ?? text.slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}

export async function ownsApp(apiBase: string, token: string, appId: string): Promise<OwnershipResult> {
  let res: Response;
  try {
    res = await fetch(`${apiBase}/v1/apps/mine`, {
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    return { error: `Ownership check request failed: ${errorText(e)}`, status: 503 };
  }

  if (!res.ok) {
    return { error: await readError(res), status: res.status };
  }

  const data = (await res.json()) as { apps?: Array<{ id: string }>; error?: string };
  if (data.error) return { error: data.error, status: 502 };
  return { owned: (data.apps ?? []).some((a) => a.id === appId) };
}

export function ownershipGateText(appId: string, result: OwnershipResult): string | null {
  if ("error" in result) {
    return `Ownership check failed (${result.status}): ${result.error}`;
  }
  if (!result.owned) {
    return `You don't own "${appId}" (or it isn't published). Only the owner can update it.`;
  }
  return null;
}
