import { describe, expect, it } from 'vitest';
import { adminApiBase, adminCommand, formatTransferFailure } from './admin.js';

describe('adminApiBase', () => {
  it('derives the admin host from the platform API host', () => {
    expect(adminApiBase('https://api.freeappstore.online', {})).toBe(
      'https://admin.freeappstore.online',
    );
  });

  it('lets FAS_ADMIN_BASE override, and strips a trailing slash', () => {
    expect(
      adminApiBase('https://api.freeappstore.online', { FAS_ADMIN_BASE: 'http://127.0.0.1:8787/' }),
    ).toBe('http://127.0.0.1:8787');
  });

  it('does not guess a production admin URL for an unrelated API base', () => {
    expect(adminApiBase('http://127.0.0.1:8787', {})).toBeNull();
  });
});

describe('formatTransferFailure', () => {
  it('includes the current owner on a compare-and-set refusal', () => {
    const msg = formatTransferFailure(
      409,
      JSON.stringify({ error: 'owner mismatch', owner_login: 'mathanghial' }),
    );
    expect(msg).toBe('transfer-owner failed (409): owner mismatch (current owner is mathanghial)');
  });

  it('names an unknown login', () => {
    expect(
      formatTransferFailure(400, JSON.stringify({ error: 'unknown login', login: 'nope' })),
    ).toBe('transfer-owner failed (400): unknown login: nope');
  });
});

describe('fas admin transfer-owner', () => {
  const cmd = adminCommand.commands.find((c) => c.name() === 'transfer-owner');

  it('is registered with the compare-and-set flags', () => {
    expect(cmd).toBeDefined();
    expect(cmd!.registeredArguments.map((arg) => arg.name())).toEqual(['app']);
    const flags = cmd!.options.map((option) => option.long);
    expect(flags).toEqual(expect.arrayContaining(['--from', '--to', '--reason', '--json']));
    for (const name of ['--from', '--to', '--reason']) {
      expect(cmd!.options.find((option) => option.long === name)?.required).toBe(true);
    }
  });
});
