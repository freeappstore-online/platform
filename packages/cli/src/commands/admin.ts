import { Command } from 'commander';
import { isValidAppId } from '../lib/app-id.js';
import { normalizeApiBase } from '../lib/config.js';
import { requireSession } from './secret.js';

/**
 * Admin worker origin for a platform API base.
 * `https://api.freeappstore.online` → `https://admin.freeappstore.online`.
 * `FAS_ADMIN_BASE` wins. A custom API host that isn't `api.<domain>` returns
 * null so we don't guess and hit production by accident.
 */
export function adminApiBase(apiBase: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.FAS_ADMIN_BASE?.trim();
  if (override) return normalizeApiBase(override);
  if (apiBase.includes('://api.')) return normalizeApiBase(apiBase.replace('://api.', '://admin.'));
  return null;
}

/** One line for stderr. Includes the current owner on a compare-and-set refusal. */
export function formatTransferFailure(status: number, text: string): string {
  let msg = text.trim() || 'empty response';
  try {
    const parsed = JSON.parse(text) as { error?: string; owner_login?: string; login?: string };
    if (parsed.error) {
      if (parsed.owner_login) msg = `${parsed.error} (current owner is ${parsed.owner_login})`;
      else if (parsed.login) msg = `${parsed.error}: ${parsed.login}`;
      else msg = parsed.error;
    }
  } catch {
    // Body wasn't JSON; keep the raw text.
  }
  return `transfer-owner failed (${status}): ${msg}`;
}

export const adminCommand = new Command('admin')
  .description('Platform admin operations. Requires an admin session from `fas login`.')
  .addCommand(
    new Command('transfer-owner')
      .description('Transfer an app to a new owner. Refused unless --from is the current owner.')
      .argument('<app>', 'app id')
      .requiredOption('--from <login>', 'current owner login (compare-and-set)')
      .requiredOption('--to <login>', 'new owner login')
      .requiredOption('--reason <text>', 'why the owner is changing (stored in the audit record)')
      .option('--json', 'print the response JSON')
      .action(
        async (app: string, opts: { from: string; to: string; reason: string; json?: boolean }) => {
          if (!isValidAppId(app)) {
            process.stderr.write(`fas: invalid app id "${app}".\n`);
            process.exit(1);
          }
          const cfg = await requireSession();
          const base = adminApiBase(cfg.apiBase);
          if (!base) {
            process.stderr.write(
              'fas: set FAS_ADMIN_BASE to the admin worker URL (could not derive it from the API base).\n',
            );
            process.exit(1);
          }
          const res = await fetch(`${base}/api/apps/transfer-owner`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${cfg.session!.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              app_id: app,
              from_login: opts.from,
              to_login: opts.to,
              reason: opts.reason,
            }),
          });
          const text = await res.text();
          if (!res.ok) {
            process.stderr.write(`fas: ${formatTransferFailure(res.status, text)}\n`);
            process.exit(1);
          }
          if (opts.json) {
            process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
            return;
          }
          const body = JSON.parse(text) as { app_id: string; from_login: string; to_login: string };
          process.stdout.write(
            `✓ ${body.app_id} owner is now ${body.to_login} (was ${body.from_login})\n`,
          );
        },
      ),
  );
