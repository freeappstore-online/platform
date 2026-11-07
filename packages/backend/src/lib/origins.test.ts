import { describe, expect, it } from 'vitest';
import { isAllowedOrigin, isAllowedReturnTo, sessionAudience } from './origins.js';

describe('isAllowedReturnTo binds return_to to the app id (#495)', () => {
  it('allows an app only on its own subdomain of a platform zone', () => {
    expect(isAllowedReturnTo('https://chess.freeappstore.online/auth/done', 'chess')).toBe(true);
    expect(isAllowedReturnTo('https://chess.agentcoder.space/', 'chess')).toBe(true);
    expect(isAllowedReturnTo('https://notes.freeappstore.online/', 'chess')).toBe(false);
    expect(isAllowedReturnTo('https://a.chess.freeappstore.online/', 'chess')).toBe(false);
    expect(isAllowedReturnTo('https://freeappstore.online/', 'chess')).toBe(false);
  });

  it("rejects other stores' zones for any app id (#536)", () => {
    for (const zone of [
      'freegamestore.online',
      'progamestore.online',
      'proappstore.online',
      'freeagentstore.online',
      'proagentstore.online',
      'freeideastore.online',
      'proideastore.online',
    ]) {
      expect(isAllowedReturnTo(`https://chess.${zone}/`, 'chess')).toBe(false);
      expect(isAllowedReturnTo(`https://${zone}/`, 'chess')).toBe(false);
    }
  });

  it('rejects http on the production domain', () => {
    expect(isAllowedReturnTo('http://chess.freeappstore.online/', 'chess')).toBe(false);
  });

  it('allows localhost for an app in dev (http and https, any port)', () => {
    expect(isAllowedReturnTo('http://localhost:5173/', 'chess')).toBe(true);
    expect(isAllowedReturnTo('https://localhost:8443/x', 'chess')).toBe(true);
    expect(isAllowedReturnTo('http://127.0.0.1:8787/cb', 'chess')).toBe(true);
  });

  it('never delivers a first-party session to localhost', () => {
    for (const id of ['console', 'store', 'fas-admin', 'keys', 'mcp']) {
      expect(isAllowedReturnTo('http://localhost:5173/', id)).toBe(false);
    }
  });

  it('allows the first-party ids only on their own origins', () => {
    expect(isAllowedReturnTo('https://freeappstore.online/app/', 'console')).toBe(true);
    expect(isAllowedReturnTo('https://console.freeappstore.online/', 'console')).toBe(true);
    expect(isAllowedReturnTo('https://freeappstore.online/apps/chess', 'store')).toBe(true);
    expect(isAllowedReturnTo('https://admin.freeappstore.online/', 'fas-admin')).toBe(true);
    expect(isAllowedReturnTo('https://mcp.freeappstore.online/callback?nonce=n', 'mcp')).toBe(true);
    // A first-party id anywhere else is exactly the token-theft shape.
    expect(isAllowedReturnTo('https://chess.freeappstore.online/', 'console')).toBe(false);
    expect(isAllowedReturnTo('https://console.freegamestore.online/', 'console')).toBe(false);
    expect(isAllowedReturnTo('https://console.proappstore.online/', 'console')).toBe(false);
    expect(isAllowedReturnTo('https://chess.freeappstore.online/', 'store')).toBe(false);
    expect(isAllowedReturnTo('https://evil.freeappstore.online/', 'fas-admin')).toBe(false);
    expect(isAllowedReturnTo('https://freeappstore.online/', 'fas-admin')).toBe(false);
    expect(isAllowedReturnTo('https://mcp.freegamestore.online/', 'mcp')).toBe(false);
  });

  it('pins keys to the key-management page itself', () => {
    expect(isAllowedReturnTo('https://api.freeappstore.online/v1/keys', 'keys')).toBe(true);
    expect(
      isAllowedReturnTo('https://api.freeappstore.online/v1/keys?provider=openai&app=x', 'keys'),
    ).toBe(true);
    expect(isAllowedReturnTo('https://api.freeappstore.online/v1/apps/x/kv', 'keys')).toBe(false);
    expect(isAllowedReturnTo('https://api.freeappstore.online/', 'keys')).toBe(false);
    expect(isAllowedReturnTo('https://api.freeappstore.online/v1/keys/x', 'keys')).toBe(false);
  });

  it('refuses reserved and malformed app ids, so an aud can never read as a platform value', () => {
    for (const id of ['legacy', 'cli', 'admin', 'platform', 'template-x']) {
      expect(isAllowedReturnTo(`https://${id}.freeappstore.online/`, id)).toBe(false);
      expect(isAllowedReturnTo('http://localhost:5173/', id)).toBe(false);
    }
    expect(isAllowedReturnTo('https://x.freeappstore.online/', '#legacy')).toBe(false);
    expect(isAllowedReturnTo('https://Chess.freeappstore.online/', 'Chess')).toBe(false);
  });

  it('rejects userinfo and non-default ports', () => {
    expect(isAllowedReturnTo('https://u:p@chess.freeappstore.online/', 'chess')).toBe(false);
    expect(isAllowedReturnTo('https://evil.com@chess.freeappstore.online/', 'chess')).toBe(false);
    expect(isAllowedReturnTo('https://chess.freeappstore.online:8443/', 'chess')).toBe(false);
    expect(isAllowedReturnTo('https://freeappstore.online:444/app/', 'console')).toBe(false);
    expect(isAllowedReturnTo('https://chess.freeappstore.online:443/', 'chess')).toBe(true);
  });

  it('allows the explicit alias and custom-domain exceptions', () => {
    expect(isAllowedReturnTo('https://hanzi.freeappstore.online/', 'hanzi-practice')).toBe(true);
    expect(isAllowedReturnTo('https://yi.freeappstore.online/', 'hanzi-associations')).toBe(true);
    expect(isAllowedReturnTo('https://hanzi.freeappstore.online/', 'chess')).toBe(false);
    expect(isAllowedReturnTo('https://agentcoder.space/', 'agentcoder')).toBe(true);
    expect(isAllowedReturnTo('https://www.agentcoder.space/x', 'agentcoder')).toBe(true);
    expect(isAllowedReturnTo('https://agentcoder.space/', 'chess')).toBe(false);
    expect(isAllowedReturnTo('https://freeagentstore.online/console/', 'fags-console')).toBe(true);
    expect(isAllowedReturnTo('https://freeagentstore.online/console/', 'chess')).toBe(false);
  });

  it('allows the OFO Copilot Chrome identity redirect for the extension app only', () => {
    const redirect = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/ofo-copilot';
    expect(isAllowedReturnTo(redirect, 'ofo-copilot-extension')).toBe(true);
    expect(isAllowedReturnTo(redirect, 'store')).toBe(false);
    expect(isAllowedReturnTo(redirect, 'chess')).toBe(false);
    expect(isAllowedReturnTo(redirect, '')).toBe(false);
  });

  it('rejects malformed Chrome identity redirect lookalikes', () => {
    expect(
      isAllowedReturnTo(
        'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/other',
        'ofo-copilot-extension',
      ),
    ).toBe(false);
    expect(
      isAllowedReturnTo(
        'https://abcdefghijklmnopabcdefghijklmnop.evilchromiumapp.org/ofo-copilot',
        'ofo-copilot-extension',
      ),
    ).toBe(false);
    expect(
      isAllowedReturnTo(
        'http://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/ofo-copilot',
        'ofo-copilot-extension',
      ),
    ).toBe(false);
  });

  it('no longer allows the retired FreeIdeaStore MCP workers.dev callback', () => {
    const callback = 'https://freeideastore-mcp.serge-the-dev.workers.dev/oauth/callback';
    expect(isAllowedReturnTo(callback, 'mcp')).toBe(false);
  });

  it('rejects unrelated origins', () => {
    expect(isAllowedReturnTo('https://evil.com/', 'chess')).toBe(false);
    expect(isAllowedReturnTo('https://attacker.example/?x=y', 'console')).toBe(false);
  });

  it('rejects look-alike origins that suffix without a dot', () => {
    expect(isAllowedReturnTo('https://evilfreeappstore.online/', 'store')).toBe(false);
    expect(isAllowedReturnTo('https://chess.evilfreeappstore.online/', 'chess')).toBe(false);
  });

  it('rejects malformed URLs and non-http(s) schemes', () => {
    expect(isAllowedReturnTo('not a url', 'chess')).toBe(false);
    expect(isAllowedReturnTo('', 'chess')).toBe(false);
    expect(isAllowedReturnTo('javascript:alert(1)', 'chess')).toBe(false);
    expect(isAllowedReturnTo('file:///etc/passwd', 'chess')).toBe(false);
    expect(isAllowedReturnTo('ftp://chess.freeappstore.online/', 'chess')).toBe(false);
  });
});

describe('sessionAudience', () => {
  it('is console for every first-party id and the app id otherwise', () => {
    for (const id of ['console', 'store', 'fas-admin', 'keys', 'mcp']) {
      expect(sessionAudience(id)).toBe('console');
    }
    expect(sessionAudience('chess')).toBe('chess');
    expect(sessionAudience('fags-console')).toBe('fags-console');
    expect(sessionAudience('ofo-copilot-extension')).toBe('ofo-copilot-extension');
  });
});

describe('isAllowedOrigin (CORS allowlist)', () => {
  it('allows the apex over https', () => {
    expect(isAllowedOrigin('https://freeappstore.online')).toBe(true);
  });

  it('allows arbitrary subdomains over https', () => {
    expect(isAllowedOrigin('https://chess.freeappstore.online')).toBe(true);
  });

  it('allows the FAS app custom domain apex + subdomains', () => {
    expect(isAllowedOrigin('https://agentcoder.space')).toBe(true);
    expect(isAllowedOrigin('https://www.agentcoder.space')).toBe(true);
  });

  it("rejects other stores' zones, apex and subdomains (#536)", () => {
    for (const zone of [
      'freegamestore.online',
      'progamestore.online',
      'proappstore.online',
      'freeagentstore.online',
      'proagentstore.online',
      'freeideastore.online',
      'proideastore.online',
    ]) {
      expect(isAllowedOrigin(`https://chess.${zone}`)).toBe(false);
    }
    for (const zone of [
      'freegamestore.online',
      'proappstore.online',
      'proagentstore.online',
      'freeideastore.online',
      'proideastore.online',
    ]) {
      expect(isAllowedOrigin(`https://${zone}`)).toBe(false);
    }
    expect(isAllowedOrigin('https://freeideastore-mcp.serge-the-dev.workers.dev')).toBe(false);
  });

  it('allows only the exact fags-console exception host from the agent store (#536)', () => {
    expect(isAllowedOrigin('https://freeagentstore.online')).toBe(true);
    expect(isAllowedOrigin('https://evil.freeagentstore.online')).toBe(false);
    expect(isAllowedOrigin('http://freeagentstore.online')).toBe(false);
  });

  it('allows localhost / 127.0.0.1 dev origins', () => {
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:8787')).toBe(true);
  });

  it('rejects look-alike origins (suffix without dot)', () => {
    expect(isAllowedOrigin('https://evilfreeappstore.online')).toBe(false);
  });

  it('rejects unrelated origins', () => {
    expect(isAllowedOrigin('https://evil.com')).toBe(false);
  });

  it('rejects malformed origins', () => {
    expect(isAllowedOrigin('not a url')).toBe(false);
    expect(isAllowedOrigin('')).toBe(false);
  });

  it('rejects all pages.dev origins (no longer used)', () => {
    expect(isAllowedOrigin('https://abc123.freeappstore-create.pages.dev')).toBe(false);
    expect(isAllowedOrigin('https://evil-project.pages.dev')).toBe(false);
    expect(isAllowedOrigin('https://attacker-site.pages.dev')).toBe(false);
  });

  it('does not allow Chrome identity URLs as CORS origins', () => {
    expect(isAllowedOrigin('https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org')).toBe(false);
  });
});
