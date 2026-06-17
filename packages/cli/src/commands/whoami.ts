import { Command } from 'commander';
import { readConfig, sessionDaysRemaining } from '../lib/config.js';

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
    const daysLeft = sessionDaysRemaining(config);
    if (daysLeft === null) {
      process.stdout.write('Session: active\n');
    } else if (daysLeft <= 0) {
      process.stdout.write('Session: expired — run `fas login` to refresh.\n');
    } else {
      process.stdout.write(
        `Session: active, expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.\n`,
      );
    }
  });
