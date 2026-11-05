import { expect, it } from 'vitest';
import { getTemplateFiles } from '../packages/cli/src/lib/starter-foundation.js';
import { checkClaudeMdSlim } from '../packages/compliance/src/checks/claude-md-slim.js';
import { checkCssDiscipline } from '../packages/compliance/src/checks/css-discipline.js';
import { checkPwaOffline } from '../packages/compliance/src/checks/pwa-offline.js';
import { mapFileSource } from '../packages/compliance/src/lib/file-source.js';

for (const preset of ['standalone', 'connected'] as const)
  it(`${preset} canonical guidance, styles and PWA options agree with compliance`, async () => {
    const files = getTemplateFiles(
      { store: 'apps', nounPlural: 'apps', r2Bucket: 'fas-apps' },
      'generic',
      preset,
    );
    const source = mapFileSource(new Map(Object.entries(files)));
    for (const check of [checkPwaOffline, checkCssDiscipline, checkClaudeMdSlim])
      expect(await check(source)).toMatchObject({ status: 'pass' });
    expect(files['.gitignore']).toContain('/web/public/favicon.ico');
    expect(files['.gitignore']).toContain('*.tsbuildinfo');
  });
