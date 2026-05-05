import { Command } from 'commander';
import { readConfig, writeConfig } from '../lib/config.js';
import { startDeviceFlow } from '../lib/github.js';

// Public client_id for the FreeAppStore CLI's GitHub OAuth App
// (https://github.com/organizations/freeappstore-online/settings/applications/3576238).
// Device-flow client_ids are not secret — the user_code/device_code is
// what authenticates the session. Override at runtime via FAS_GITHUB_CLIENT_ID.
const DEFAULT_CLIENT_ID = process.env['FAS_GITHUB_CLIENT_ID'] ?? 'Ov23liuUpYPXc1ikEFm2';

export const loginCommand = new Command('login')
  .description('Sign in with GitHub.')
  .action(async () => {
    if (!DEFAULT_CLIENT_ID) {
      throw new Error(
        'GitHub client_id is not configured. The platform admin must register a GitHub OAuth App ' +
          'and set FAS_GITHUB_CLIENT_ID, or bake it into the published CLI build.',
      );
    }

    const flow = await startDeviceFlow(DEFAULT_CLIENT_ID);
    process.stdout.write(`\nOpen ${flow.verificationUri} and enter code: ${flow.userCode}\n\n`);
    process.stdout.write('Waiting for authorization...\n');

    const { accessToken, login } = await flow.poll();
    const config = await readConfig();
    await writeConfig({
      ...config,
      github: { accessToken, login, obtainedAt: Date.now() },
    });
    process.stdout.write(`\n✓ Signed in as @${login}\n`);
  });
