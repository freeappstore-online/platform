import { describe, it, expect } from 'vitest';
import { proxyCommand } from './proxy.js';

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

  it('requires --secret and --inject on `allow`', () => {
    const allow = proxyCommand.commands.find((c) => c.name() === 'allow')!;
    const required = allow.options.filter((o) => o.required).map((o) => o.long);
    expect(required).toEqual(expect.arrayContaining(['--secret', '--inject']));
  });

  it('defaults `methods` to GET on `allow`', () => {
    const allow = proxyCommand.commands.find((c) => c.name() === 'allow')!;
    const methods = allow.options.find((o) => o.long === '--methods');
    expect(methods?.defaultValue).toBe('GET');
  });
});
