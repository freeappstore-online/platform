import { Command } from 'commander';
import { bearer, dieFromHttp, requireSession, resolveAppIdOrExit } from './secret.js';

async function setShared(collection: string, shared: boolean, app: string | undefined) {
  const cfg = await requireSession();
  const appId = await resolveAppIdOrExit(app);
  const res = await fetch(
    `${cfg.apiBase}/v1/apps/${appId}/collections/${encodeURIComponent(collection)}`,
    { method: 'PUT', headers: bearer(cfg), body: JSON.stringify({ shared }) },
  );
  if (!res.ok) await dieFromHttp(res, `${shared ? 'share' : 'unshare'} ${collection}`);
  process.stdout.write(
    shared
      ? `✓ ${collection} is shared: every user of ${appId} can read its documents (owners still write)\n`
      : `✓ ${collection} is private: each user reads only their own documents\n`,
  );
}

export const dbCommand = new Command('db')
  .description(
    'Choose which fas.collections collections other users can read. Collections are private (owner-only) by default.',
  )
  .addCommand(
    new Command('share')
      .description('Let every user of the app read the documents in <collection>.')
      .argument('<collection>', 'collection name')
      .option('--app <id>', 'app id (defaults to package.json name in cwd)')
      .action((collection: string, opts: { app?: string }) =>
        setShared(collection, true, opts.app),
      ),
  )
  .addCommand(
    new Command('unshare')
      .description('Make <collection> private again: each user reads only their own documents.')
      .argument('<collection>', 'collection name')
      .option('--app <id>', 'app id (defaults to package.json name in cwd)')
      .action((collection: string, opts: { app?: string }) =>
        setShared(collection, false, opts.app),
      ),
  )
  .addCommand(
    new Command('list')
      .alias('ls')
      .description('Show the collections of an app that are shared.')
      .option('--app <id>', 'app id (defaults to package.json name in cwd)')
      .option('--json', 'Output JSON.')
      .action(async (opts: { app?: string; json?: boolean }) => {
        const cfg = await requireSession();
        const appId = await resolveAppIdOrExit(opts.app);
        const res = await fetch(`${cfg.apiBase}/v1/apps/${appId}/collections`, {
          headers: bearer(cfg),
        });
        if (!res.ok) await dieFromHttp(res, 'list collections');
        const { shared } = (await res.json()) as { shared: Array<{ collection: string }> };
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(shared, null, 2)}\n`);
          return;
        }
        if (shared.length === 0) {
          process.stdout.write(`No shared collections for ${appId}: all are private.\n`);
          return;
        }
        for (const s of shared) process.stdout.write(`${s.collection}\n`);
      }),
  );
