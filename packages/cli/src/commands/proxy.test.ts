import { describe, expect, it } from 'vitest';
import { parseInject, proxyCommand, resolveAllowInjection } from './proxy.js';

describe('parseInject', () => {
  it('recognizes bearer (no name)', () => {
    expect(parseInject('bearer')).toEqual({ kind: 'bearer', name: '' });
  });

  it('recognizes oauth2_cc (no name)', () => {
    expect(parseInject('oauth2_cc')).toEqual({ kind: 'oauth2_cc', name: '' });
  });

  it('parses query:<name>', () => {
    expect(parseInject('query:appid')).toEqual({ kind: 'query', name: 'appid' });
  });

  it('parses header:<name> with hyphens preserved', () => {
    expect(parseInject('header:X-API-Key')).toEqual({ kind: 'header', name: 'X-API-Key' });
  });

  it('rejects empty string', () => {
    expect(() => parseInject('')).toThrow(/--inject/);
  });

  it('rejects unknown kinds', () => {
    expect(() => parseInject('cookie:session')).toThrow(/--inject/);
    expect(() => parseInject('basic:user:pass')).toThrow(/--inject/);
  });

  it('rejects "query" without a name', () => {
    expect(() => parseInject('query')).toThrow(/--inject/);
    expect(() => parseInject('query:')).toThrow(/--inject/);
  });

  it('keeps colons inside the name (for headers like X-Forwarded-For)', () => {
    expect(parseInject('header:X-Some:Weird-Name')).toEqual({
      kind: 'header',
      name: 'X-Some:Weird-Name',
    });
  });
});

/**
 * The Inject parser is a private function inside proxy.ts. Rather than
 * exporting it just for tests, we drive it through the public commander
 * surface and assert on the action's behavior. We don't actually run the
 * action here — we just verify the command tree is wired up.
 */
describe('proxyCommand wiring', () => {
  it('exposes the three subcommands', () => {
    const names = proxyCommand.commands.map((c) => c.name()).sort();
    expect(names).toEqual(['allow', 'deny', 'list']);
  });

  it('aliases list→ls and deny→rm', () => {
    const list = proxyCommand.commands.find((c) => c.name() === 'list');
    const deny = proxyCommand.commands.find((c) => c.name() === 'deny');
    expect(list?.aliases()).toContain('ls');
    expect(deny?.aliases()).toContain('rm');
  });

  it('offers --user-key on `allow`', () => {
    const allow = proxyCommand.commands.find((c) => c.name() === 'allow')!;
    expect(allow.options.map((o) => o.long)).toContain('--user-key');
  });

  it('defaults `methods` to GET on `allow`', () => {
    const allow = proxyCommand.commands.find((c) => c.name() === 'allow')!;
    const methods = allow.options.find((o) => o.long === '--methods');
    expect(methods?.defaultValue).toBe('GET');
  });
});

describe('resolveAllowInjection (#466)', () => {
  it('needs --secret and --inject for an app-secret rule', () => {
    expect(resolveAllowInjection({ secret: 'K', inject: 'query:appid' })).toEqual({
      injectKind: 'query',
      injectName: 'appid',
      secretName: 'K',
    });
    expect(() => resolveAllowInjection({})).toThrow(/--user-key/);
    expect(() => resolveAllowInjection({ secret: 'K' })).toThrow(/--secret and --inject/);
    expect(() => resolveAllowInjection({ inject: 'bearer' })).toThrow(/--secret and --inject/);
  });

  it('declares a key-vault provider host with --user-key and no secret', () => {
    expect(resolveAllowInjection({ userKey: true })).toEqual({
      injectKind: 'user_key',
      injectName: '',
      secretName: '',
    });
  });

  it('refuses --user-key together with --secret or --inject', () => {
    expect(() => resolveAllowInjection({ userKey: true, secret: 'K' })).toThrow(
      /cannot be combined/,
    );
    expect(() => resolveAllowInjection({ userKey: true, inject: 'bearer' })).toThrow(
      /cannot be combined/,
    );
  });
});
