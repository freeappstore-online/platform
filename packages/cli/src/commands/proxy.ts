import { Command } from 'commander';
import { requireSession, resolveAppIdOrExit, bearer, dieFromHttp } from './secret.js';

interface AllowlistRule {
  pattern: string;
  injectKind: 'query' | 'header' | 'bearer';
  injectName: string;
  secretName: string;
  methods: string[];
  createdAt: number;
}

/**
 * Parse the --inject flag's "kind:name" form. `query:appid` → query param,
 * `header:X-API-Key` → custom header, `bearer` → Authorization: Bearer <secret>.
 */
export function parseInject(s: string): {
  kind: 'query' | 'header' | 'bearer';
  name: string;
} {
  if (s === 'bearer') return { kind: 'bearer', name: '' };
  const m = /^(query|header):(.+)$/.exec(s);
  if (!m) {
    throw new Error(`--inject must be 'bearer', 'query:<name>', or 'header:<name>' (got ${s})`);
  }
  return { kind: m[1] as 'query' | 'header', name: m[2]! };
}

export const proxyCommand = new Command('proxy')
  .description('Manage the URL allowlist for the per-app secret-injecting proxy.')
  .addCommand(
    new Command('allow')
      .description('Allow the proxy to inject <secret> when calling URLs starting with <pattern>.')
      .argument('<pattern>', 'URL prefix (must start with https://)')
      .requiredOption('--secret <name>', 'name of a previously stored secret')
      .requiredOption(
        '--inject <spec>',
        "where to inject the secret: 'query:<name>', 'header:<name>', or 'bearer'",
      )
      .option('--methods <list>', 'comma-separated HTTP methods', 'GET')
      .option('--app <id>', 'app id (defaults to package.json name in cwd)')
      .action(
        async (
          pattern: string,
          opts: { secret: string; inject: string; methods: string; app?: string },
        ) => {
          const cfg = await requireSession();
          const appId = await resolveAppIdOrExit(opts.app);
          let inject;
          try {
            inject = parseInject(opts.inject);
          } catch (err) {
            process.stderr.write(`fas: ${(err as Error).message}\n`);
            process.exit(1);
          }
          const res = await fetch(`${cfg.apiBase}/v1/apps/${appId}/allowlist`, {
            method: 'PUT',
            headers: bearer(cfg),
            body: JSON.stringify({
              pattern,
              injectKind: inject.kind,
              injectName: inject.name,
              secretName: opts.secret,
              methods: opts.methods.split(',').map((m) => m.trim()).filter(Boolean),
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
          process.stdout.write(JSON.stringify(rules, null, 2) + '\n');
          return;
        }
        if (rules.length === 0) {
          process.stdout.write(`No allowlist rules for ${appId}.\n`);
          return;
        }
        for (const r of rules) {
          const inject =
            r.injectKind === 'bearer' ? 'bearer' : `${r.injectKind}:${r.injectName}`;
          process.stdout.write(
            `${r.pattern}\n  secret=${r.secretName}  inject=${inject}  methods=${r.methods.join(',')}\n`,
          );
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
