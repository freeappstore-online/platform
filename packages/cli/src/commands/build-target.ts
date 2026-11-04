import { appendFile } from 'node:fs/promises';
import { fsFileSource, readBuildTarget, validateBuildTarget } from '@freeappstore/compliance';
import { Command } from 'commander';

export const buildTargetCommand = new Command('build-target')
  .description('Validate the application entry, identity and build/deploy target from fas.json.')
  .option('--artifact', 'Also validate produced output before upload')
  .option('--app-id <id>', 'Expected provisioned/deployment app ID')
  .option('--github-output', 'Write validated build settings to GITHUB_OUTPUT')
  .action(async (opts: { artifact?: boolean; appId?: string; githubOutput?: boolean }) => {
    const source = fsFileSource(process.cwd());
    const result = await validateBuildTarget(source, {
      artifact: opts.artifact,
      expectedAppId: opts.appId,
    });
    process.stdout.write(`${result.status}: ${result.detail}\n`);
    if (result.status === 'fail') {
      process.exitCode = 1;
      return;
    }
    if (opts.githubOutput) {
      if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is not set');
      const target = await readBuildTarget(source);
      if (/[\r\n]/.test(target.buildCommand))
        throw new Error('CI buildCommand must be a single line');
      await appendFile(
        process.env.GITHUB_OUTPUT,
        `output-path=${target.outputPath}\nbuild-command=${target.buildCommand}\n`,
      );
    }
  });
