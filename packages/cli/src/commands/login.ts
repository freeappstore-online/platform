import { Command } from 'commander';
import { readConfig, writeConfig } from '../lib/config.js';
import { startDeviceFlow } from '../lib/github.js';

// Public client_id for the FreeAppStore CLI's GitHub OAuth App
// (https://github.com/organizations/freeappstore-online/settings/applications/3576238).
// Device-flow client_ids are not secret — the user_code/device_code is
// what authenticates the session. Override at runtime via FAS_GITHUB_CLIENT_ID.
const DEFAULT_CLIENT_ID = process.env.FAS_GITHUB_CLIENT_ID ?? 'Ov23liuUpYPXc1ikEFm2';

/**
 * Runs the full login flow: GitHub device-authorization, then exchanges the
 * GitHub access token for a fas session token. Persists both to the config
 * file. Exported so other commands (e.g. `fas start`) can call it inline.
 */
export async function runLogin(): Promise<{ login: string }> {
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

  // Swap the GitHub user-access-token for a fas session token. Subsequent
  // CLI commands authenticate via the fas session, not the GitHub token.
  const exchangeUrl = `${config.apiBase}/v1/auth/exchange`;
  const exchangeRes = await fetch(exchangeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ githubToken: accessToken }),
  });
  if (!exchangeRes.ok) {
    // Include the URL we tried so misconfigured-apiBase failures are
    // self-diagnosing. The default apiBase is https://api.freeappstore.online;
    // a 404 from anywhere else almost always means a stale value in
    // ~/.fas/config.json or the FAS_API_BASE env var.
    throw new Error(
      `Auth exchange failed (${exchangeRes.status} from ${exchangeUrl}): ${await exchangeRes.text()}\n` +
        `If the URL above isn't https://api.freeappstore.online/v1/auth/exchange, check ~/.fas/config.json's apiBase and any FAS_API_BASE env var.`,
    );
  }
  const { sessionToken } = (await exchangeRes.json()) as { sessionToken: string };

  await writeConfig({
    ...config,
    github: { accessToken, login, obtainedAt: Date.now() },
    session: { token: sessionToken, obtainedAt: Date.now() },
  });
  process.stdout.write(
    `\n✓ Signed in as @${login}\n` +
      `  Your session is good for 30 days. Run \`fas login\` again to refresh it.\n` +
      `  You're all set to \`fas publish\` — every signed-in account can publish, no extra permission needed.\n`,
  );
  return { login };
}

export const loginCommand = new Command('login')
  .description('Sign in with GitHub.')
  // Discard runLogin's return value so commander gets the void-returning
  // signature it expects.
  .action(async () => {
    await runLogin();
  });
