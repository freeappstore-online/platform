import { mapFileSource, runSourcePreflight } from '@freeappstore/compliance';
import { describe, expect, it } from 'vitest';
import { getTemplateFiles, substituteAppName } from './starter-foundation.js';

// The accepted starter must pass the shared preflight, or every new app would
// be blocked at its first push (#550).
describe('runSourcePreflight on the current starter output', () => {
  for (const preset of ['standalone', 'connected'] as const) {
    it(`passes the ${preset} preset`, async () => {
      const generated = getTemplateFiles(
        { store: 'apps', nounPlural: 'apps', r2Bucket: 'fas-apps' },
        'generic',
        preset,
      );
      const files = new Map(Object.entries(substituteAppName(generated, 'my-new-app', 'my-new-app')));
      const result = await runSourcePreflight(mapFileSource(files), { expectedAppId: 'my-new-app' });
      expect(result).toEqual({ ok: true, failures: [] });
    });
  }
});
