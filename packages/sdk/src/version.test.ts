import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { SDK_VERSION } from './logger.js';

describe('SDK_VERSION', () => {
  it('matches package.json version (prevents telemetry drift on release)', () => {
    expect(SDK_VERSION).toBe(pkg.version);
  });
});
