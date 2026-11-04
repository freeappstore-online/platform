import { Command } from 'commander';
import { installCapabilities, presets } from '../lib/capabilities.js';

export const addCommand = new Command('add')
  .description('Install bundled first-party browser capabilities without overwriting edits.')
  .argument('[capabilities...]', 'Capability IDs (currently: connectivity)')
  .option('--preset <name>', 'Capability list: minimal | connectivity')
  .option('--dry-run', 'Print the plan without writing files')
  .option('--update', 'Explicitly update tracked generated files if unedited')
  .action(async (ids: string[], opts: { preset?: string; dryRun?: boolean; update?: boolean }) => {
    if (opts.preset && !Object.hasOwn(presets, opts.preset))
      throw new Error(`Unknown preset: ${opts.preset}`);
    if (!ids.length && !opts.preset) throw new Error('Choose a capability or --preset.');
    const plan = await installCapabilities(
      process.cwd(),
      [...(presets[opts.preset ?? 'minimal'] ?? []), ...ids],
      opts,
    );
    process.stdout.write(`${plan.join('\n')}\n`);
  });
