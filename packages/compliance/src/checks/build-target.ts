import type { FileSource } from '../lib/file-source.js';
import { stripCommentsOnly, stripHtmlComments } from '../lib/strip.js';
import type { CheckResult } from '../types.js';

export interface BuildTarget {
  appId: string;
  applicationRoot: string;
  outputPath: string;
  buildCommand: string;
}

function safePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(?:\.|[\w.-]+(?:\/[\w.-]+)*)$/.test(value) &&
    !value.split('/').includes('..')
  );
}

/** Paths are repo-relative; configuration is data, never shell interpolation. */
export async function readBuildTarget(source: FileSource): Promise<BuildTarget> {
  const raw = await source.read('fas.json');
  const config = raw ? JSON.parse(raw) : {};
  const pkg = JSON.parse((await source.read('package.json')) ?? '{}');
  const target: BuildTarget = {
    appId:
      config.appId ??
      (pkg.name?.startsWith('@') ? pkg.name.slice(1).split('/')[0] : pkg.name) ??
      '',
    applicationRoot: config.applicationRoot ?? 'web',
    outputPath:
      config.outputPath ??
      (config.applicationRoot === '.' ? 'dist' : `${config.applicationRoot ?? 'web'}/dist`),
    buildCommand: config.buildCommand ?? 'pnpm build',
  };
  if (!safePath(target.applicationRoot) || !safePath(target.outputPath)) {
    throw new Error(
      'fas.json applicationRoot/outputPath must be repository-relative paths without traversal',
    );
  }
  if (
    typeof target.appId !== 'string' ||
    !/^[a-z][a-z0-9-]*$/.test(target.appId) ||
    ['my-app', 'APPNAME', 'appname'].includes(target.appId)
  ) {
    throw new Error(
      'Set fas.json appId to the provisioned application ID; unresolved starter identity',
    );
  }
  if (typeof target.buildCommand !== 'string' || !target.buildCommand.trim()) {
    throw new Error('fas.json buildCommand must be a non-empty command');
  }
  return target;
}

const at = (root: string, path: string) => (root === '.' ? path : `${root}/${path}`);

/** Trace only entry-reachable local modules, leaving example/demo text alone. */
async function reachable(
  source: FileSource,
  entry: string,
  strict = false,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  async function visit(path: string): Promise<void> {
    if (result.has(path)) return;
    const raw = await source.read(path);
    if (raw === null) return;
    const text = path.endsWith('.html') ? stripHtmlComments(raw) : stripCommentsOnly(raw);
    result.set(path, text);
    const refs = path.endsWith('.html')
      ? [...text.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)].map((m) => m[1]!)
      : [
          ...text
            .replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '')
            .matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g),
        ].map((m) => m[1]!);
    for (let ref of refs) {
      if (path.endsWith('.html') && !/^(?:[a-z]+:|\/\/|\/|\.)/i.test(ref)) ref = `./${ref}`;
      if (!ref.startsWith('.') && !ref.startsWith('/')) continue;
      ref = ref.split(/[?#]/)[0]!;
      const parts = (
        ref.startsWith('/')
          ? `${entry.slice(0, entry.lastIndexOf('/') + 1)}${ref.slice(1)}`
          : `${path.slice(0, path.lastIndexOf('/') + 1)}${ref}`
      ).split('/');
      const normalized: string[] = [];
      for (const part of parts) {
        if (part === '..') normalized.pop();
        else if (part !== '.') normalized.push(part);
      }
      const base = normalized.join('/');
      let found = false;
      for (const suffix of [
        '',
        '.tsx',
        '.ts',
        '.jsx',
        '.js',
        '.mjs',
        '.cjs',
        '/index.tsx',
        '/index.ts',
        '/index.jsx',
        '/index.js',
      ]) {
        if ((await source.read(base + suffix)) !== null) {
          found = true;
          await visit(base + suffix);
          break;
        }
      }
      if (strict && !found)
        throw new Error(
          `${path} references missing release module ${base}; rebuild the declared output`,
        );
    }
  }
  await visit(entry);
  return result;
}

export async function validateBuildTarget(
  source: FileSource,
  options: { artifact?: boolean | undefined; expectedAppId?: string | undefined } = {},
): Promise<CheckResult> {
  const name = 'Build/deploy target';
  try {
    const target = await readBuildTarget(source);
    const { appId, applicationRoot, outputPath, buildCommand } = target;
    if (options.expectedAppId && appId !== options.expectedAppId) {
      throw new Error(
        `fas.json appId ${appId} differs from deployment ID ${options.expectedAppId}`,
      );
    }
    const entry = at(applicationRoot, 'index.html');
    const graph = await reachable(source, entry);
    if (!graph.has(entry) || graph.size < 2)
      throw new Error(`${entry} must load a local application module`);
    for (const [path, text] of graph) {
      for (const match of text.matchAll(
        /\binitApp\s*\(\s*\{[^}]*?\bappId\s*:\s*['"]([^'"]+)['"]/g,
      )) {
        if (match[1] !== appId)
          throw new Error(
            `${path}: SDK appId '${match[1]}' differs from '${appId}'; update initApp`,
          );
      }
    }
    const pkg = JSON.parse((await source.read('package.json')) ?? '{}');
    const build = buildCommand === 'pnpm build' ? (pkg.scripts?.build ?? '') : buildCommand;
    const rootPkg = JSON.parse((await source.read(at(applicationRoot, 'package.json'))) ?? '{}');
    const workspace = (await source.read('pnpm-workspace.yaml')) ?? '';
    const tokens = (build.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []).map((token: string) =>
      token
        .replace(/["']/g, '')
        .replace(/^(?:--filter|--dir|--prefix|--workspace)=/, '')
        .replace(/^\.\//, ''),
    );
    const selected =
      (applicationRoot === '.' && build.trim().length > 0) ||
      tokens.includes(applicationRoot) ||
      (rootPkg.name && tokens.includes(rootPkg.name)) ||
      (/(?:^|\s)(?:-r|--recursive)(?:\s|$)/.test(build) &&
        (workspace.includes(applicationRoot) ||
          workspace.includes(`${applicationRoot.split('/')[0]}/*`)));
    if (!selected)
      throw new Error(
        `Build '${build}' does not establish a path to ${applicationRoot}. Set buildCommand to an explicit filtered/root build and align deploy CI.`,
      );
    for (const workflowName of ['.github/workflows/deploy.yml', '.github/workflows/deploy.yaml']) {
      const workflow = ((await source.read(workflowName)) ?? '').replace(/^\s*#.*$/gm, '');
      const upload = /aws\s+s3\s+sync\s+["']?(?:\.\/)?([\w./-]+)/.exec(workflow);
      if (upload?.[1] && upload[1] !== outputPath) {
        throw new Error(
          `${workflowName} uploads ${upload[1]} but fas.json declares ${outputPath}; align the actual upload with the selected build output`,
        );
      }
    }
    // A second app is suspicious only when the selected app is still a starter.
    const starter = [...graph.values()].some((text) =>
      /Welcome to (?:your |the )?(?:FreeAppStore|FAS)|Edit\s+(?:web\/)?src\/App\.tsx/.test(text),
    );
    if (starter) {
      const alternatives: string[] = [];
      for await (const path of source.list()) {
        if (
          path.endsWith('/index.html') &&
          !path.startsWith(`${applicationRoot}/`) &&
          !/\b(?:examples?|demos?|fixtures?|test)\//.test(path)
        )
          alternatives.push(path);
      }
      if (alternatives.length)
        throw new Error(
          `Selected ${entry} still renders starter UI while ${alternatives.join(', ')} is outside the deployed entry. Select the developed app in fas.json and CI.`,
        );
    }
    if (options.artifact) {
      const artifactEntry = at(outputPath, 'index.html');
      const artifact = await reachable(source, artifactEntry, true);
      if (!artifact.has(artifactEntry) || artifact.size < 2)
        throw new Error(
          `${artifactEntry} missing or has no readable local JavaScript; build the declared output before deployment`,
        );
      if (
        [...artifact.values()].some((text) =>
          /APPNAME|Welcome to (?:your |the )?(?:FreeAppStore|FAS)|Edit\s+(?:web\/)?src\/App\.tsx/.test(
            text,
          ),
        )
      ) {
        throw new Error(
          `${outputPath} contains starter UI or unresolved APPNAME. Replace the release entry, rebuild, and smoke-test a real feature.`,
        );
      }
    }
    return {
      name,
      status: 'pass',
      detail: `${appId}: ${buildCommand} -> ${entry} -> ${outputPath}`,
    };
  } catch (error) {
    return { name, status: 'fail', detail: error instanceof Error ? error.message : String(error) };
  }
}
