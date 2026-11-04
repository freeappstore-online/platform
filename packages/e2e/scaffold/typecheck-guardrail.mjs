import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const appRoot = resolve(process.argv[2] ?? '.');
const fixture = join(appRoot, 'web/src/TypecheckGuardrailFixture.tsx');

function typecheck(cwd = appRoot) {
  const result = spawnSync('pnpm', ['run', '--if-present', 'typecheck'], {
    cwd,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

try {
  await writeFile(
    fixture,
    `import { useState } from 'react';

export function CustomLayout() {
  const [screen, setScreen] = useState<'overview' | 'settings'>('overview');
  return <div className="custom-layout">
    <aside aria-label="Workspace">
      <button onClick={() => setScreen('overview')}>Overview</button>
      <button onClick={() => setScreen('settings')}>Settings</button>
    </aside>
    <main data-screen={screen}>{screen}</main>
  </div>;
}
`,
  );
  const custom = typecheck();
  assert.equal(
    custom.status,
    0,
    `A valid app-owned custom layout should typecheck:\n${custom.output}`,
  );

  await writeFile(
    fixture,
    `import { openStore, putRecord } from '@freeappstore/sdk/persist';

export async function invalidPersistenceCalls() {
  const store = await openStore('pitstop');
  return putRecord(store, 'entries', []);
}
`,
  );
  const invalidSdk = typecheck();
  assert.notEqual(
    invalidSdk.status,
    0,
    'Invalid published SDK persistence calls must fail the configured typecheck.',
  );
  assert.match(
    invalidSdk.output,
    /error TS\d+/,
    `Expected actionable TypeScript diagnostics:\n${invalidSdk.output}`,
  );

  const legacyRoot = await mkdtemp(join(tmpdir(), 'fas-typecheck-legacy-'));
  try {
    await writeFile(
      join(legacyRoot, 'package.json'),
      '{"name":"legacy-app","scripts":{"build":"vite build"}}\n',
    );
    const legacy = typecheck(legacyRoot);
    assert.equal(
      legacy.status,
      0,
      `Apps without a typecheck script must remain deployable:\n${legacy.output}`,
    );
  } finally {
    await rm(legacyRoot, { recursive: true, force: true });
  }
} finally {
  await rm(fixture, { force: true });
}
