import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fsFileSource, validateBuildTarget } from '@freeappstore/compliance';
import { readConfig } from '../lib/config.js';

export type CheckStatus = 'pass' | 'fail' | 'warn';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

/**
 * Runs every local + remote health check, in parallel where it's safe to.
 * Returns the full result list. The CLI's `fas doctor` and the TUI's
 * Doctor screen both render this same data.
 */
export async function runDoctor(
  options: { offline?: boolean; root?: string } = {},
): Promise<CheckResult[]> {
  const checks = await Promise.all([
    checkNodeVersion(),
    checkBinary('git'),
    checkBinary('pnpm'),
    checkPackageManager(options.root ?? process.cwd()),
    ...(!options.offline ? [checkConfigFile(), checkSignedIn(), checkApiReachable()] : []),
    validateBuildTarget(fsFileSource(options.root ?? process.cwd())),
  ]);
  return checks;
}

async function checkNodeVersion(): Promise<CheckResult> {
  const v = process.versions.node;
  const major = Number(v.split('.')[0]);
  if (Number.isNaN(major)) {
    return { name: 'Node version', status: 'warn', detail: `Could not parse: ${v}` };
  }
  if (major < 22) {
    return {
      name: 'Node version',
      status: 'fail',
      detail: `${v} (need ≥ 22 to run the templates)`,
    };
  }
  return { name: 'Node version', status: 'pass', detail: v };
}

async function checkBinary(name: string): Promise<CheckResult> {
  const found = await which(name);
  return found
    ? { name: `${name} installed`, status: 'pass', detail: found }
    : { name: `${name} installed`, status: 'fail', detail: `${name} not on PATH` };
}

async function checkPackageManager(root: string): Promise<CheckResult> {
  const pkgPath = join(root, 'package.json');
  try {
    const raw = await readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(raw);
    if (!pkg.packageManager) {
      return {
        name: 'packageManager field',
        status: 'fail',
        detail: 'Missing in package.json — CI will fail. Add: "packageManager": "pnpm@10.30.3"',
      };
    }
    return {
      name: 'packageManager field',
      status: /^pnpm@\d+\.\d+\.\d+$/.test(pkg.packageManager) ? 'pass' : 'fail',
      detail: /^pnpm@\d+\.\d+\.\d+$/.test(pkg.packageManager)
        ? pkg.packageManager
        : 'Unrecognized packageManager value; use an exact pnpm version',
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        name: 'packageManager field',
        status: 'warn',
        detail: 'No package.json in current directory',
      };
    }
    return { name: 'packageManager field', status: 'warn', detail: 'Could not read package.json' };
  }
}

async function checkConfigFile(): Promise<CheckResult> {
  const path = join(homedir(), '.fas', 'config.json');
  try {
    const raw = await readFile(path, 'utf8');
    JSON.parse(raw);
    return { name: 'Config file', status: 'pass', detail: path };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { name: 'Config file', status: 'warn', detail: 'No config yet — run `fas login`.' };
    }
    return {
      name: 'Config file',
      status: 'fail',
      detail: `${path}: could not read valid JSON; inspect locally`,
    };
  }
}

async function checkSignedIn(): Promise<CheckResult> {
  try {
    const config = await readConfig();
    if (!config.session?.token) {
      return { name: 'Signed in', status: 'warn', detail: 'Not signed in. Run `fas login`.' };
    }
    if (!config.github?.login) {
      return {
        name: 'Signed in',
        status: 'warn',
        detail: 'Session present but missing GitHub login — run `fas login` again.',
      };
    }
    return {
      name: 'Signed in',
      status: 'pass',
      detail: /^[a-zA-Z0-9-]{1,39}$/.test(config.github.login)
        ? `@${config.github.login}`
        : 'Session present; account identity unavailable',
    };
  } catch {
    return {
      name: 'Signed in',
      status: 'fail',
      detail: 'Could not read account configuration',
    };
  }
}

async function checkApiReachable(): Promise<CheckResult> {
  try {
    const config = await readConfig();
    const started = Date.now();
    const res = await fetch(`${config.apiBase}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    const ms = Date.now() - started;
    if (res.ok) {
      return {
        name: 'API reachable',
        status: 'pass',
        detail: `Platform health responded (${ms}ms)`,
      };
    }
    return {
      name: 'API reachable',
      status: 'fail',
      detail: `Platform health returned HTTP ${res.status}`,
    };
  } catch (err) {
    const msg =
      err instanceof Error && err.message.includes('ENOTFOUND')
        ? 'ENOTFOUND: platform health host unavailable'
        : 'Platform health unavailable; check connection/API configuration';
    return { name: 'API reachable', status: 'fail', detail: msg };
  }
}

/** The PATH lookup command: Windows has `where`, not `which` (#281). */
export function pathLookupCommand(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'where' : 'which';
}

function which(cmd: string): Promise<string | null> {
  return new Promise((resolveFn) => {
    const child = spawn(pathLookupCommand(), [cmd], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    child.stdout.on('data', (chunk: Buffer) => (buf += chunk.toString()));
    // `where` lists every match, one per line; the first is the one that runs.
    child.on('close', (code) =>
      resolveFn(code === 0 ? (buf.trim().split(/\r?\n/)[0] ?? null) : null),
    );
    child.on('error', () => resolveFn(null));
  });
}
