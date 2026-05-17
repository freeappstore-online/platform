import { describe, expect, it } from 'vitest';
import { extractFailedSteps } from './publish.js';

describe('extractFailedSteps', () => {
  it('returns empty when body is not an object', () => {
    expect(extractFailedSteps(null)).toEqual([]);
    expect(extractFailedSteps('plain text')).toEqual([]);
    expect(extractFailedSteps(undefined)).toEqual([]);
    expect(extractFailedSteps(42)).toEqual([]);
  });

  it('returns empty when steps is not an array', () => {
    expect(extractFailedSteps({})).toEqual([]);
    expect(extractFailedSteps({ steps: 'not-an-array' })).toEqual([]);
    expect(extractFailedSteps({ steps: { not: 'array' } })).toEqual([]);
  });

  it('returns empty when all steps are ok or skip', () => {
    const body = {
      steps: [
        { name: 'create repo', status: 'ok' },
        { name: 'create CF Pages', status: 'ok' },
        { name: 'add to registry', status: 'skip' },
      ],
    };
    expect(extractFailedSteps(body)).toEqual([]);
  });

  it('returns only the failed steps (regression: partial provisioning was silent)', () => {
    const body = {
      steps: [
        { name: 'create repo', status: 'ok', detail: 'created freeappstore-online/foo' },
        { name: 'create CF Pages', status: 'fail', detail: 'rate limited' },
        { name: 'add DNS', status: 'fail', detail: 'zone permission denied' },
        { name: 'update registry', status: 'ok' },
      ],
    };
    const failed = extractFailedSteps(body);
    expect(failed).toHaveLength(2);
    expect(failed.map((s) => s.name)).toEqual(['create CF Pages', 'add DNS']);
  });

  it('ignores entries with unexpected shapes', () => {
    const body = {
      steps: [
        null,
        'a string',
        { status: 'fail' }, // no name — still a failure entry, but valid shape
        { name: 'x' }, // no status
      ],
    };
    const failed = extractFailedSteps(body);
    // The well-formed-ish failure (no name but status:fail) is included; others are not.
    expect(failed).toHaveLength(1);
    expect(failed[0]?.status).toBe('fail');
  });
});
