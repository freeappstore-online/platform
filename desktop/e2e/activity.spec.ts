import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { _electron, expect, test } from '@playwright/test';
import { homeWindow } from './home.js';

test('AI activity survives an Electron restart and explicit clearing is durable (#859)', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'fas-activity-e2e-'));
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({ openAtLogin: false, autoUpdate: false }),
  );
  const launch = () =>
    _electron.launch({
      args: ['.'],
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, FAS_DESKTOP_USER_DATA: userData, FAS_DESKTOP_PORT: '47897' } as Record<
        string,
        string
      >,
    });
  let electron = await launch();
  try {
    let home = await homeWindow(electron);
    await expect(home.getByTestId('status')).toBeVisible();
    const client = new Client({ name: 'activity-test', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://127.0.0.1:47897/mcp'), {
        requestInit: {
          headers: {
            Authorization: `Bearer ${readFileSync(join(userData, 'mcp-token'), 'utf8').trim()}`,
          },
        },
      }),
    );
    await client.callTool({ name: 'list_open_apps', arguments: {} });
    await client.close();
    await electron.close();
    electron = await launch();
    home = await homeWindow(electron);
    await home.getByRole('button', { name: 'Activity', exact: true }).click();
    await expect(home.getByText('list_open_apps', { exact: true })).toBeVisible();
    await home.getByRole('button', { name: 'Clear history', exact: true }).click();
    await home
      .getByRole('dialog')
      .getByRole('button', { name: 'Clear history', exact: true })
      .click();
    await expect(home.getByText('list_open_apps', { exact: true })).toHaveCount(0);
    expect(JSON.parse(readFileSync(join(userData, 'ai-activity.json'), 'utf8')).entries).toEqual(
      [],
    );
    await electron.close();
    electron = await launch();
    home = await homeWindow(electron);
    await home.getByRole('button', { name: 'Activity', exact: true }).click();
    await expect(home.getByText('No AI calls yet')).toBeVisible();
  } finally {
    await electron.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
