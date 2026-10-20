import { describe, expect, it } from 'vitest';
import { ghExitError } from './logs.js';

// #283: a gh killed by a signal (exit code null) counted as success.
describe('ghExitError', () => {
  it('is null only for exit code 0', () => {
    expect(ghExitError(0, null)).toBeNull();
  });

  it('fails on a non-zero code', () => {
    expect(ghExitError(1, null)?.message).toBe('gh exited with code 1');
  });

  it('fails when gh was killed by a signal', () => {
    expect(ghExitError(null, 'SIGTERM')?.message).toBe('gh was stopped by SIGTERM');
  });
});
