import { Command } from 'commander';
import { readConfig } from '../lib/config.js';

export const publishCommand = new Command('publish')
  .description('Publish the current app to freeappstore.online.')
  .action(async () => {
    const config = await readConfig();
    if (!config.github?.accessToken) {
      throw new Error('Not signed in. Run: fas login');
    }

    const res = await fetch(`${config.apiBase}/v1/publish`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.github.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ source: 'cli' }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Publish failed (${res.status}): ${text}`);
    }
    const result = (await res.json()) as { url?: string; status?: string };
    process.stdout.write(`✓ Publish requested. ${result.url ?? ''}\n`);
  });
