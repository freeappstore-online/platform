import { Command } from 'commander';
import { bearer, dieFromHttp, requireSession, resolveAppIdOrExit } from './secret.js';

interface AllowlistRule {
  pattern: string;
  injectKind: 'query' | 'header' | 'bearer' | 'oauth2_cc' | 'user_key';
  injectName: string;
  secretName: string;
  secretName2?: string;
  tokenUrl?: string;
  methods: string[];
  createdAt: number;
}

/**
 * Parse the --inject flag's "kind:name" form. `query:appid` → query param,
 * `header:X-API-Key` → custom header, `bearer` → Authorization: Bearer <secret>.
 */
export function parseInject(s: string): {
  kind: 'query' | 'header' | 'bearer' | 'oauth2_cc';
  name: string;
} {
  if (s === 'bearer') return { kind: 'bearer', name: '' };
  if (s === 'oauth2_cc') return { kind: 'oauth2_cc', name: '' };
  const m = /^(query|header):(.+)$/.exec(s);
  if (!m) {
    throw new Error(
      `--inject must be 'bearer', 'oauth2_cc', 'query:<name>', or 'header:<name>' (got ${s})`,
    );
  }
  return { kind: m[1] as 'query' | 'header', name: m[2]! };
}

/**
 * What `fas proxy allow` sends for the injection. `--user-key` declares a
 * key-vault provider host (api.openai.com, ...): the proxy spends the signed-in
 * user's own key, so there is no secret to name. Every other rule needs both
 * `--secret` and `--inject`.
 */
export function resolveAllowInjection(opts: {
  userKey?: boolean;
  secret?: string;
  inject?: string;
}): {
  injectKind: string;
  injectName: string;
  secretName: string;
} {
  if (opts.userKey) {
    if (opts.secret || opts.inject) {
      throw new Error('--user-key cannot be combined with --secret or --inject');
    }
    return { injectKind: 'user_key', injectName: '', secretName: '' };
  }
  if (!opts.secret || !opts.inject) {
    throw new Error(
      '--secret and --inject are required (or --user-key for a key-vault provider host)',
    );
  }
  const inject = parseInject(opts.inject);
  return { injectKind: inject.kind, injectName: inject.name, secretName: opts.secret };
}

export const proxyCommand = new Command('proxy')
  .description(
    'Manage the URL allowlist for the per-app proxy. The proxy refuses every host that is not on it.',
  )
  .addCommand(
    new Command('allow')
      .description(
        'Allow the app to call URLs starting with <pattern> through the proxy, injecting <secret> or the user key.',
      )
      .argument('<pattern>', 'URL prefix (must start with https://)')
      .option('--secret <name>', 'name of a previously stored secret')
      .option(
        '--inject <spec>',
        "how to inject: 'query:<name>', 'header:<name>', 'bearer', or 'oauth2_cc'",
      )
      .option(
        '--user-key',
        "key-vault provider host (api.openai.com, api.anthropic.com, ...): spend the signed-in user's own key; no secret",
      )
      .option('--secret2 <name>', 'second secret (client_secret for oauth2_cc)')
      .option('--token-url <url>', 'OAuth2 token endpoint (required for oauth2_cc)')
      .option('--methods <list>', 'comma-separated HTTP methods', 'GET')
      .option('--app <id>', 'app id (defaults to package.json name in cwd)')
      .action(
        async (
          pattern: string,
          opts: {
            secret?: string;
            secret2?: string;
            tokenUrl?: string;
            inject?: string;
            userKey?: boolean;
            methods: string;
            app?: string;
          },
        ) => {
          const cfg = await requireSession();
          const appId = await resolveAppIdOrExit(opts.app);
          let inject;
          try {
            inject = resolveAllowInjection(opts);
          } catch (err) {
            process.stderr.write(`fas: ${(err as Error).message}\n`);
            process.exit(1);
          }
          const res = await fetch(`${cfg.apiBase}/v1/apps/${appId}/allowlist`, {
            method: 'PUT',
            headers: bearer(cfg),
            body: JSON.stringify({
              pattern,
              ...inject,
              ...(opts.secret2 ? { secretName2: opts.secret2 } : {}),
              ...(opts.tokenUrl ? { tokenUrl: opts.tokenUrl } : {}),
              methods: opts.methods
                .split(',')
                .map((m) => m.trim())
                .filter(Boolean),
            }),
          });
          if (!res.ok) await dieFromHttp(res, 'add allowlist rule');
          process.stdout.write(`✓ allowed ${pattern} for ${appId}\n`);
        },
      ),
  )
  .addCommand(
    new Command('list')
      .alias('ls')
      .description('Show the proxy allowlist for an app.')
      .option('--app <id>', 'app id (defaults to package.json name in cwd)')
      .option('--json', 'Output JSON.')
      .action(async (opts: { app?: string; json?: boolean }) => {
        const cfg = await requireSession();
        const appId = await resolveAppIdOrExit(opts.app);
        const res = await fetch(`${cfg.apiBase}/v1/apps/${appId}/allowlist`, {
          headers: bearer(cfg),
        });
        if (!res.ok) await dieFromHttp(res, 'list allowlist');
        const { rules } = (await res.json()) as { rules: AllowlistRule[] };
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(rules, null, 2)}\n`);
          return;
        }
        if (rules.length === 0) {
          process.stdout.write(`No allowlist rules for ${appId}.\n`);
          return;
        }
        for (const r of rules) {
          const inject =
            r.injectKind === 'bearer' || r.injectKind === 'oauth2_cc' || r.injectKind === 'user_key'
              ? r.injectKind
              : `${r.injectKind}:${r.injectName}`;
          let line = `${r.pattern}\n  ${r.secretName ? `secret=${r.secretName}  ` : ''}inject=${inject}  methods=${r.methods.join(',')}`;
          if (r.secretName2) line += `  secret2=${r.secretName2}`;
          if (r.tokenUrl) line += `\n  token-url=${r.tokenUrl}`;
          process.stdout.write(`${line}\n`);
        }
      }),
  )
  .addCommand(
    new Command('deny')
      .alias('rm')
      .description('Remove an allowlist rule by pattern.')
      .argument('<pattern>', 'exact pattern to remove')
      .option('--app <id>', 'app id (defaults to package.json name in cwd)')
      .action(async (pattern: string, opts: { app?: string }) => {
        const cfg = await requireSession();
        const appId = await resolveAppIdOrExit(opts.app);
        const res = await fetch(`${cfg.apiBase}/v1/apps/${appId}/allowlist`, {
          method: 'DELETE',
          headers: bearer(cfg),
          body: JSON.stringify({ pattern }),
        });
        if (!res.ok) await dieFromHttp(res, 'remove allowlist rule');
        process.stdout.write(`✓ removed ${pattern} from ${appId}\n`);
      }),
  );
