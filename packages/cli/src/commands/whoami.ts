import { Command } from 'commander';
import { type FasConfig, readConfig, sessionDaysRemaining } from '../lib/config.js';

export const whoamiCommand = new Command('whoami')
  .description('Show the currently signed-in user and session status.')
  .action(async () => {
    const config = await readConfig();
    if (!config.github?.login) {
      process.stdout.write('Not signed in. Run: fas login\n');
      process.exit(1);
    }
    process.stdout.write(`@${config.github.login}\n`);

    // Surface session health so an expired token is self-diagnosable here
    // rather than as a surprise 401 mid-publish.
    process.stdout.write(`${sessionStatus(config)}\n`);
  });

/**
 * The session line. sessionDaysRemaining() is null both when there's no
 * session token and when an older CLI saved one without a timestamp; only
 * the second is active (#283).
 */
export function sessionStatus(config: FasConfig): string {
  if (!config.session?.token) return 'Session: none — run `fas login` to sign in to the API.';
  const daysLeft = sessionDaysRemaining(config);
  if (daysLeft === null) return 'Session: active (expiry unknown)';
  if (daysLeft <= 0) return 'Session: expired — run `fas login` to refresh.';
  return `Session: active, expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`;
}
