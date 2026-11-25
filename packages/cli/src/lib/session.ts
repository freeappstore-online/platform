import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isValidAppId } from './app-id.js';
import { type FasConfig, readConfig } from './config.js';

// Session and HTTP helpers shared by the authenticated commands (secret, proxy, db, admin, quality).

export async function requireSession(): Promise<FasConfig> {
  const cfg = await readConfig();
  if (!cfg.session?.token) {
    process.stdout.write('\n⚠  Not signed in. Run: fas login\n');
    process.exit(1);
  }
  return cfg;
}

export function bearer(cfg: FasConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${cfg.session!.token}`,
    'Content-Type': 'application/json',
  };
}

export async function resolveAppIdOrExit(explicit: string | undefined): Promise<string> {
  if (explicit) {
    if (!isValidAppId(explicit)) {
      process.stderr.write(`fas: invalid app id "${explicit}".\n`);
      process.exit(1);
    }
    return explicit;
  }
  // Same convention as `fas publish` — derive from the cwd's package.json.
  try {
    const raw = await readFile(join(process.cwd(), 'package.json'), 'utf8');
    const name = (JSON.parse(raw) as { name?: string }).name;
    if (name && isValidAppId(name)) return name;
  } catch {
    // fall through
  }
  process.stderr.write(
    'fas: no app id. Pass --app <id> or run from a directory whose package.json `name` is the app id.\n',
  );
  process.exit(1);
}

export async function dieFromHttp(
  res: Response,
  action: string,
  sensitiveValue?: string,
): Promise<never> {
  const text = await res.text();
  let msg = text;
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (parsed.error) msg = parsed.error;
  } catch {
    // not JSON; use raw body
  }
  if (sensitiveValue) msg = msg.split(sensitiveValue).join('[redacted]');
  process.stderr.write(`fas: ${action} failed (${res.status}): ${msg}\n`);
  process.exit(1);
}
