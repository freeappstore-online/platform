import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  APP_DEPLOY_CLI_VERSION,
  CODE_HEALTH_CLI_VERSION,
  DEPLOY_ACTIONS,
} from './starter-dependencies.js';
import { APP_STARTER_CONFIG, deployWorkflow, type StoreConfig } from './starter-foundation.js';

const GAME_CONFIG: StoreConfig = { store: 'games', r2Bucket: 'fgs-games', nounPlural: 'games' };
const R2_SECRETS = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ACCOUNT_ID'];

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  needs?: string;
  permissions?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  name: string;
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
}

function stepText(step: Step): string {
  return JSON.stringify(step);
}

describe.each([
  ['apps', APP_STARTER_CONFIG],
  ['games', GAME_CONFIG],
])('deployWorkflow (%s)', (_store, config) => {
  const source = deployWorkflow(config);
  const workflow = parse(source) as Workflow;

  it('is valid YAML with a build job and a deploy job that needs it', () => {
    expect(workflow.name).toBe('Deploy to R2');
    expect(Object.keys(workflow.jobs)).toEqual(['build', 'deploy']);
    expect(workflow.jobs.deploy!.needs).toBe('build');
    expect(workflow.on).toHaveProperty('push');
    expect(workflow.on).toHaveProperty('workflow_dispatch');
  });

  it('pins every npx package to an exact version with --yes', () => {
    const invocations = [...source.matchAll(/\bnpx\s+(\S+)\s+(\S+)/g)];
    expect(invocations.length).toBe(config.store === 'apps' ? 3 : 0);
    for (const [, flag, pkg] of invocations) {
      expect(flag).toBe('--yes');
      expect(pkg).toMatch(/^@[\w-]+\/[\w-]+@\d+\.\d+\.\d+$/);
    }
    expect(source).not.toMatch(/npx\s+(?!--yes\s)/);
  });

  it('pins every action to a commit SHA with a version comment', () => {
    const uses = [...source.matchAll(/uses:\s*(\S+)(.*)/g)];
    expect(uses.length).toBeGreaterThanOrEqual(4);
    for (const [, ref, comment] of uses) {
      expect(ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      expect(comment!.trim()).toMatch(/^# v\d+\.\d+\.\d+$/);
      expect(Object.values(DEPLOY_ACTIONS).some((pin) => pin.startsWith(ref!))).toBe(true);
    }
  });

  it('keeps every secret out of the build job', () => {
    const build = workflow.jobs.build!;
    expect(build.steps.length).toBeGreaterThan(0);
    for (const step of build.steps) expect(stepText(step)).not.toMatch(/secrets\./);
    // The build job is the only place project code runs.
    expect(build.steps.some((s) => s.uses?.startsWith('actions/checkout@'))).toBe(true);
    expect(build.steps.at(-1)!.uses).toBe(DEPLOY_ACTIONS.uploadArtifact.split(' ')[0]);
  });

  it('gives the deploy job exactly the three R2 secrets and runs no project code', () => {
    const deploy = workflow.jobs.deploy!;
    expect(deploy.permissions).toEqual({ contents: 'read' });
    const secrets = new Set(
      [...JSON.stringify(deploy.steps).matchAll(/secrets\.(\w+)/g)].map((m) => m[1]),
    );
    expect([...secrets].sort()).toEqual([...R2_SECRETS].sort());
    const text = JSON.stringify(deploy.steps);
    expect(text).not.toMatch(/npx|pnpm|npm |checkout/);
    const download = DEPLOY_ACTIONS.downloadArtifact.split(' ')[0];
    expect(deploy.steps[0]!.uses).toBe(download);
    for (const step of deploy.steps) {
      if (step.uses) expect(step.uses).toBe(download);
      else expect(step.run).toMatch(/aws s3 (sync|cp)/);
    }
  });

  it('downloads the artifact to the declared output path and syncs it to the bucket prefix', () => {
    const deploy = workflow.jobs.deploy! as Job & { env: Record<string, string> };
    expect(deploy.env.OUTPUT_PATH).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions template syntax
      config.store === 'apps' ? '${{ needs.build.outputs.output-path }}' : 'web/dist',
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions template syntax
    expect(deploy.steps[0]!.with).toEqual({ name: 'app', path: '${{ env.OUTPUT_PATH }}' });
    const upload = deploy.steps.find((s) => s.name === 'Upload to R2')!;
    // The pinned build-target validator only accepts a non-literal upload path
    // or one equal to fas.json's outputPath; "$OUTPUT_PATH" keeps both true.
    expect(upload.run).toContain(
      `aws s3 sync "$OUTPUT_PATH" "s3://${config.r2Bucket}/${config.nounPlural}/\${GITHUB_REPOSITORY##*/}/"`,
    );
    expect(upload.run).toContain('--delete');
  });
});

describe('deployWorkflow (apps specifics)', () => {
  const source = deployWorkflow(APP_STARTER_CONFIG);
  const workflow = parse(source) as Workflow;

  it('runs the pinned build-target validator twice and the pinned code-health scan once', () => {
    expect(
      source.match(new RegExp(`@freeappstore/cli@${APP_DEPLOY_CLI_VERSION} `, 'g')),
    ).toHaveLength(2);
    expect(
      source.match(new RegExp(`@vibecodeqa/cli@${CODE_HEALTH_CLI_VERSION} `, 'g')),
    ).toHaveLength(1);
  });

  it('uploads the resolved build output and ships the code-health report as a second artifact', () => {
    const build = workflow.jobs.build! as Job & { outputs: Record<string, string> };
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions template syntax
    expect(build.outputs).toEqual({ 'output-path': '${{ steps.target.outputs.output-path }}' });
    const app = build.steps.find((s) => s.name === 'Upload build artifact')!;
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions template syntax
    expect(app.with?.path).toBe('${{ steps.target.outputs.output-path }}');
    expect(app.with?.['if-no-files-found']).toBe('error');
    const report = build.steps.find((s) => s.name === 'Upload code health report')!;
    expect(report.with?.['if-no-files-found']).toBe('ignore');
    const health = workflow.jobs.deploy!.steps.find((s) => s.name === 'Upload code health')!;
    expect(health.run).toContain('.vibe-check/report.json');
    expect(health.run).toContain('/.vcqa"');
  });

  it('matches the reviewed snapshot (bump deliberately)', () => {
    expect(source).toMatchSnapshot();
  });
});

describe('deployWorkflow (games specifics)', () => {
  it('matches the reviewed snapshot (bump deliberately)', () => {
    expect(deployWorkflow(GAME_CONFIG)).toMatchSnapshot();
  });
});
