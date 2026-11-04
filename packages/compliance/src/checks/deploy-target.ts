import { parse } from '@babel/parser';
import type { FileSource } from '../lib/file-source.js';
import type { CheckResult } from '../types.js';

type AstNode = Record<string, unknown>;
function walk(value: unknown, visit: (node: AstNode) => void): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const child of value) walk(child, visit);
    return;
  }
  const node = value as AstNode;
  if (typeof node.type === 'string') visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (
      ![
        'loc',
        'tokens',
        'comments',
        'leadingComments',
        'trailingComments',
        'innerComments',
        'extra',
      ].includes(key)
    )
      walk(child, visit);
  }
}

function analyseModule(content: string): {
  imports: string[];
  ids: (string | null)[];
  starter: boolean;
} {
  const tree = parse(content, { sourceType: 'unambiguous', plugins: ['typescript', 'jsx'] });
  const names = new Set<string>();
  const namespaces = new Set<string>();
  const imports: string[] = [];
  for (const item of tree.program.body) {
    if (item.type === 'ImportDeclaration') {
      if (item.importKind !== 'type') imports.push(item.source.value);
      if (item.source.value === '@freeappstore/sdk') {
        for (const spec of item.specifiers) {
          if (spec.type === 'ImportNamespaceSpecifier') namespaces.add(spec.local.name);
          if (
            spec.type === 'ImportSpecifier' &&
            spec.imported.type === 'Identifier' &&
            spec.imported.name === 'initApp'
          )
            names.add(spec.local.name);
        }
      }
    }
  }
  const ids: (string | null)[] = [];
  let starter = false;
  walk(tree.program, (node) => {
    if (
      node.type === 'JSXAttribute' &&
      (node.value as AstNode | null)?.value === 'Edit web/src/App.tsx to get started.'
    )
      starter = true;
    if (
      ['ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(
        String(node.type),
      )
    ) {
      const value = (node.source as AstNode | undefined)?.value;
      if (typeof value === 'string') imports.push(value);
    }
    if (node.type !== 'CallExpression') return;
    const callee = node.callee as AstNode;
    const args = node.arguments as AstNode[];
    if (callee.type === 'Import' && typeof args[0]?.value === 'string') imports.push(args[0].value);
    const sdkCall =
      (callee.type === 'Identifier' && names.has(String(callee.name))) ||
      (callee.type === 'MemberExpression' &&
        namespaces.has(String((callee.object as AstNode).name)) &&
        ((callee.property as AstNode).name === 'initApp' ||
          (callee.property as AstNode).value === 'initApp'));
    if (!sdkCall) return;
    const props = args[0]?.type === 'ObjectExpression' ? (args[0].properties as AstNode[]) : [];
    const identityProps = props.filter(
      (p) =>
        (p.key as AstNode | undefined)?.name === 'appId' ||
        (p.key as AstNode | undefined)?.value === 'appId',
    );
    const value = identityProps[0]?.value as AstNode | undefined;
    ids.push(
      identityProps.length !== 1 ||
        props.some((p) => p.type === 'SpreadElement' || p.computed) ||
        value?.type !== 'StringLiteral'
        ? null
        : String(value.value),
    );
  });
  return { imports, ids, starter };
}

export interface DeployTarget {
  appId: string;
  root: string;
  command: string;
  output: string;
  smoke: { selector: string; text: string; path?: string };
}

export function safeProjectPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[\w./-]+$/.test(value) &&
    !value.includes('\\') &&
    !value.startsWith('/') &&
    !value.includes(':') &&
    !value.split('/').some((part) => part === '..' || part === '')
  );
}

export function parseDeployTarget(raw: string): DeployTarget | null {
  const config = JSON.parse(raw);
  if (!config.deploy) return null;
  const d = config.deploy;
  if (
    !/^[a-z][a-z0-9-]{0,29}[a-z0-9]$/.test(config.appId ?? '') ||
    !safeProjectPath(d.root) ||
    !safeProjectPath(d.output) ||
    typeof d.command !== 'string' ||
    !d.command.trim() ||
    typeof d.smoke?.selector !== 'string' ||
    !d.smoke.selector.trim() ||
    typeof d.smoke?.text !== 'string' ||
    !d.smoke.text.trim() ||
    (d.smoke.path !== undefined && (!d.smoke.path.startsWith('/') || d.smoke.path.startsWith('//')))
  ) {
    throw new Error(
      'fas.json needs appId and deploy.{root,command,output,smoke:{selector,text,path?}}; paths must stay inside the repository',
    );
  }
  if (['my-app', 'appname', 'appid'].includes(config.appId))
    throw new Error('Replace the placeholder appId in fas.json');
  if (d.output === '.' || d.root === d.output || d.root.startsWith(`${d.output}/`))
    throw new Error('deploy.output must not contain the app source root');
  if (d.smoke.text === 'REPLACE_WITH_A_REAL_FEATURE')
    throw new Error('Set deploy.smoke.text to a real product feature before release');
  return { ...d, appId: config.appId };
}

function resolveImport(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const parts = from.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.') parts.push(part);
  }
  return parts.join('/');
}

/** Follow only the HTML entry and its relative module imports, never demos elsewhere. */
export async function deploymentModules(
  source: FileSource,
  root: string,
): Promise<Map<string, string>> {
  const prefix = root === '.' ? '' : `${root}/`;
  const html = await source.read(`${prefix}index.html`);
  const queue = [
    ...(html ?? '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g),
  ].map((m) => (m[1]!.startsWith('/') ? `${prefix}${m[1]!.slice(1)}` : `${prefix}${m[1]!}`));
  const modules = new Map<string, string>();
  while (queue.length) {
    const requested = queue.shift()!;
    let path = requested;
    let content = await source.read(path);
    if (content === null) {
      for (const ext of ['.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.js']) {
        content = await source.read(requested + ext);
        if (content !== null) {
          path = requested + ext;
          break;
        }
      }
    }
    if (content === null || modules.has(path) || !/\.[cm]?[jt]sx?$/.test(path)) continue;
    modules.set(path, content);
    for (const specifier of analyseModule(content).imports) {
      const next = resolveImport(path, specifier);
      if (next) queue.push(next);
      else if (/^(?:@\/|~\/|#)/.test(specifier)) {
        throw new Error(
          `${path}: cannot trace bundler alias ${specifier}; keep SDK initialization reachable through relative imports`,
        );
      }
    }
  }
  return modules;
}

export async function checkDeployTarget(
  source: FileSource,
  expectedId?: string,
): Promise<CheckResult> {
  const name = 'deploy-target';
  const fail = (detail: string): CheckResult => ({
    name,
    status: 'fail',
    detail,
    suggestions: [
      'Set fas.json appId and deploy.root/command/output to the app you intend to ship; run fas buildcheck before upload.',
    ],
  });
  let target: DeployTarget | null = null;
  try {
    const raw = await source.read('fas.json');
    if (raw) target = parseDeployTarget(raw);
  } catch (error) {
    return fail(String(error));
  }
  if (target && expectedId && target.appId !== expectedId)
    return fail(`fas.json appId ${target.appId} does not match deployed id ${expectedId}`);
  const root = target?.root ?? 'web';
  const prefix = root === '.' ? '' : `${root}/`;
  if (target && !(await source.read(`${prefix}package.json`)))
    return fail(`No package.json at declared app root ${root}`);
  if (target && !(await source.read(`${prefix}index.html`)))
    return fail(`No HTML entry at ${prefix}index.html`);
  let modules: Map<string, string>;
  try {
    modules = await deploymentModules(source, root);
  } catch (error) {
    return fail(`Cannot trace ${prefix}index.html: ${String(error)}`);
  }
  const identity = target?.appId ?? expectedId;
  for (const [path, content] of modules) {
    const analysis = analyseModule(content);
    if (analysis.starter) {
      const alternatives: string[] = [];
      for await (const file of source.list()) {
        if (
          file.endsWith('/package.json') &&
          !file.startsWith(prefix) &&
          !/^(?:examples|test|tests|fixtures|docs)\//.test(file)
        )
          alternatives.push(file);
      }
      return fail(
        `${path}: deploy entry still contains the untouched starter. ${alternatives.length ? `Other package roots (${alternatives.join(', ')}) may contain the developed app but are outside this target. ` : ''}Choose the intended deploy.root and a real rendered feature.`,
      );
    }
    for (const id of analysis.ids) {
      if (!id)
        return fail(
          `${path}: initApp appId is unresolved; use the deployed literal id so identity can be verified`,
        );
      if (['my-app', 'APPNAME', 'APPID'].includes(id) || (identity && id !== identity)) {
        return fail(
          `${path}: initApp appId "${id}" does not match ${identity ?? 'a resolved deployed app id'}`,
        );
      }
    }
  }
  if (!target)
    return {
      name,
      status: 'warn',
      detail:
        'No explicit deploy contract; legacy web/ target only. Add fas.json deploy and a rendered feature smoke assertion.',
    };
  if (modules.size === 0) return fail(`No reachable script modules from ${prefix}index.html`);
  return {
    name,
    status: 'pass',
    detail: `${target.appId}: ${root}/index.html -> ${modules.size} modules; run "${target.command}" in ${root} -> ${target.output}; smoke ${target.smoke.selector}`,
  };
}
