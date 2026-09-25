import { describe, expect, it } from 'vitest';
import { mapFileSource } from './file-source.js';
import { isGameProject } from './project-type.js';

const detect = (files: Record<string, string>) => isGameProject(mapFileSource(new Map(Object.entries(files))));

describe('isGameProject', () => {
  it('detects @freeappstore/games in package.json', async () => {
    expect(await detect({ 'package.json': '{"dependencies":{"@freeappstore/games":"^0.1"}}' })).toBe(true);
  });

  it('detects an import from @freeappstore/games', async () => {
    expect(await detect({ 'web/src/App.tsx': 'import { GameShell } from "@freeappstore/games";' })).toBe(true);
  });

  it('detects a FAS-generated game: local GameShell, only @freeappstore/sdk (#64)', async () => {
    expect(
      await detect({
        'web/package.json': '{"dependencies":{"@freeappstore/sdk":"^0.14.25","react":"^19"}}',
        'web/src/App.tsx': 'import { GameShell } from "./components/GameShell";\nexport default function App() {}',
        'web/src/components/GameShell.tsx': 'export function GameShell() {}',
      }),
    ).toBe(true);
  });

  it('detects type-only and multi-name GameShell imports', async () => {
    expect(await detect({ 'a.ts': "import type { GameShellProps, GameShell } from '../shell';" })).toBe(true);
    expect(await detect({ 'a.tsx': 'import {\n  Foo,\n  GameShell,\n} from "./x";' })).toBe(true);
  });

  it('does not flag a plain FAS app', async () => {
    expect(
      await detect({
        'web/package.json': '{"dependencies":{"@freeappstore/sdk":"^0.14.25"}}',
        'web/src/App.tsx': 'import { Shell } from "./components/Shell";\nconst GameShellish = 1;',
      }),
    ).toBe(false);
  });

  it('does not match a name that merely contains GameShell', async () => {
    expect(await detect({ 'a.tsx': 'import { MyGameShellThing } from "./x";' })).toBe(false);
  });
});
