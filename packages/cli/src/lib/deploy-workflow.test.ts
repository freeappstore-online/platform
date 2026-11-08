import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  APP_DEPLOY_CLI_VERSION,
  CODE_HEALTH_CLI_VERSION,
  DEPLOY_ACTIONS,
} from './starter-dependencies.js';
import {
  APP_DEPLOY_WORKFLOW_FILE,
  APP_STARTER_CONFIG,
  appDeployWorkflow,
  deployWorkflow,
  KEYLESS_UPLOAD,
  type StoreConfig,
} from './starter-foundation.js';

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

  it('holds no secret anywhere: the deploy job authenticates with an OIDC token', () => {
    expect(source).not.toMatch(/secrets\./);
    for (const name of R2_SECRETS) expect(source).not.toContain(name);
    expect(workflow.jobs.build!.permissions).not.toHaveProperty('id-token');
    expect(workflow.jobs.deploy!.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
  });

  it('runs no project code in the deploy job', () => {
    const deploy = workflow.jobs.deploy!;
    expect(JSON.stringify(deploy.steps)).not.toMatch(/npx|pnpm|npm |checkout|aws /);
    const download = DEPLOY_ACTIONS.downloadArtifact.split(' ')[0];
    expect(deploy.steps[0]!.uses).toBe(download);
    for (const step of deploy.steps) if (step.uses) expect(step.uses).toBe(download);
  });

  it('uploads the artifact through the store API session and commits it', () => {
    const deploy = workflow.jobs.deploy! as Job & { env: Record<string, string> };
    expect(deploy.env.DEPLOY_API).toBe(
      config.store === 'apps'
        ? 'https://api.freeappstore.online'
        : 'https://admin.freegamestore.online',
    );
    expect(deploy.steps[0]!.with).toEqual({ name: 'app', path: 'site' });
    const upload = deploy.steps.at(-1)!;
    expect(upload.run).toBe(`${KEYLESS_UPLOAD.trimEnd()}\n`);
    expect(upload.run).toContain('audience=$DEPLOY_API');
    expect(upload.run).toContain('"$DEPLOY_API/v1/deploys"');
    expect(upload.run).toContain('"$DEPLOY_URL/commit"');
    expect(upload.run).toContain('::add-mask::$DEPLOY_TOKEN');
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
    const build = workflow.jobs.build!;
    const app = build.steps.find((s) => s.name === 'Upload build artifact')!;
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions template syntax
    expect(app.with?.path).toBe('${{ steps.target.outputs.output-path }}');
    expect(app.with?.['if-no-files-found']).toBe('error');
    const report = build.steps.find((s) => s.name === 'Upload code health report')!;
    expect(report.with?.['if-no-files-found']).toBe('ignore');
    const health = workflow.jobs.deploy!.steps.find(
      (s) => s.name === 'Download code health report',
    )!;
    expect(health.with).toEqual({ name: 'code-health', path: 'site/.vcqa' });
  });

  it('stamps the build identity and the installed size the store shows', () => {
    const steps = workflow.jobs.build!.steps;
    expect(Object.keys(steps.find((s) => s.name === 'Build')!.env!)).toEqual([
      'BUILD_COMMAND',
      'VITE_APP_VERSION',
      'VITE_COMMIT_SHA',
      'VITE_BUILD_DATE',
    ]);
    const names = steps.map((s) => s.name);
    expect(names.indexOf('Write build info')).toBe(names.indexOf('Verify build output') + 1);
    expect(steps.find((s) => s.name === 'Write build info')!.run).toContain('/.buildinfo.json');
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

describe('keyless upload client: delta manifest', () => {
  const hasJq = spawnSync('jq', ['--version']).status === 0;
  it.skipIf(!hasJq)('turns sha256sum output into a path -> hash map with the real jq', () => {
    const filter = /capture\("[^']*'/.exec(KEYLESS_UPLOAD);
    const program = /jq -Rn '(\[inputs \| capture[^']*)'/.exec(KEYLESS_UPLOAD)![1]!;
    expect(filter).not.toBeNull();
    const hash = 'ab'.repeat(32);
    const out = spawnSync('jq', ['-Rn', program], {
      input: `${hash}  ./index.html\n${hash}  ./a/my file.js\n`,
      encoding: 'utf8',
    });
    expect(out.stderr).toBe('');
    expect(JSON.parse(out.stdout)).toEqual({ 'index.html': hash, 'a/my file.js': hash });
  });

  it.skipIf(!hasJq)('batches the reuse list by 100 and sends nothing when it is empty', () => {
    const program = /jq -c '(\.reuse as[^']*)'/.exec(KEYLESS_UPLOAD)![1]!;
    const run = (reuse: string[]) =>
      spawnSync('jq', ['-c', program], { input: JSON.stringify({ reuse }), encoding: 'utf8' })
        .stdout.trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l).paths.length);
    expect(run([])).toEqual([]);
    expect(run(Array.from({ length: 250 }, (_, i) => `f${i}`))).toEqual([100, 100, 50]);
  });
});

describe('appDeployWorkflow (the platform-owned app deploy, #559)', () => {
  const source = appDeployWorkflow();
  const workflow = parse(source) as Workflow & {
    on: { workflow_call: { inputs: Record<string, unknown> } };
    jobs: Record<string, Job & { if?: string; outputs?: Record<string, string> }>;
  };

  it('is the file committed at .github/workflows/app-deploy.yml', () => {
    const here = new URL('.', import.meta.url);
    const committed = readFileSync(
      new URL(`../../../../${APP_DEPLOY_WORKFLOW_FILE}`, here),
      'utf8',
    );
    expect(committed, 'regenerate the file from appDeployWorkflow()').toBe(source);
  });

  it('can only be called, and takes inputs rather than steps', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_call']);
    expect(Object.keys(workflow.on.workflow_call.inputs)).toEqual([
      'vars',
      'setup',
      'checks',
      'python-version',
      'code-health',
    ]);
    expect(source).not.toMatch(/secrets[.:]/);
  });

  it('never expands an input inside a run script (no template injection)', () => {
    for (const line of source.split('\n'))
      if (/^\s+run: /.test(line)) expect(line).not.toMatch(/\$\{\{\s*inputs\./);
    for (const job of Object.values(workflow.jobs))
      for (const step of job.steps) expect(step.run ?? '').not.toMatch(/\$\{\{/);
  });

  it('builds without an id-token and deploys the exact artifact by id', () => {
    const { build, deploy } = workflow.jobs;
    expect(build!.permissions).toEqual({ contents: 'write' });
    expect(deploy!.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(deploy!.needs).toBe('build');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions template syntax
    expect(build!.outputs!.app).toBe('${{ steps.app.outputs.artifact-id }}');
    expect(deploy!.if).toContain("needs.build.outputs.app != ''");
    const download = deploy!.steps[0]!;
    expect(download.with).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions template syntax
      'artifact-ids': '${{ needs.build.outputs.app }}',
      'merge-multiple': true,
      path: 'site',
    });
    for (const step of deploy!.steps) expect(step.with ?? {}).not.toHaveProperty('name');
    expect(JSON.stringify(deploy!.steps)).not.toMatch(/npx|pnpm|npm |checkout|aws /);
    expect(deploy!.steps.at(-1)!.run).toBe(`${KEYLESS_UPLOAD.trimEnd()}\n`);
  });

  it('keeps the validators, tests and lock rule in a fixed order', () => {
    const names = workflow.jobs.build!.steps.map((s) => s.name ?? s.uses);
    const order = [
      'Install',
      'Extra setup',
      'Resolve build target',
      'Tests (when configured)',
      'Build',
      'Verify build output',
      'App checks',
      'Retain verified dependency lock',
      'Upload build artifact',
    ].map((n) => names.indexOf(n));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    for (const pin of [DEPLOY_ACTIONS.setupPython, DEPLOY_ACTIONS.uploadArtifact])
      expect(source).toContain(pin);
  });

  const hasJq = spawnSync('jq', ['--version']).status === 0;
  it.skipIf(!hasJq)('exports only VITE_* repo variables to the build, multi-line safe', () => {
    const step = workflow.jobs.build!.steps.find(
      (s) => s.name === 'Export public build variables',
    )!;
    const program = /jq -r '([^']*)'/.exec(step.run!)![1]!;
    const out = spawnSync('jq', ['-r', program], {
      input: JSON.stringify({ VITE_GOOGLE_CLIENT_ID: 'abc', NODE_OPTIONS: 'x', VITE_KEY: 'a\nb' }),
      encoding: 'utf8',
    });
    expect(out.stdout).toBe(
      'VITE_GOOGLE_CLIENT_ID<<FAS_VAR_EOF\nabc\nFAS_VAR_EOF\nVITE_KEY<<FAS_VAR_EOF\na\nb\nFAS_VAR_EOF\n',
    );
  });
});
