import { describe, expect, it } from 'vitest';
import { isAllowedOrigin, isAllowedReturnTo, sessionAudience } from './origins.js';

describe('isAllowedReturnTo binds return_to to the app id (#495)', () => {
  it('allows an app only on its own subdomain of a platform zone', () => {
    expect(isAllowedReturnTo('https://chess.freeappstore.online/auth/done', 'chess')).toBe(true);
    expect(isAllowedReturnTo('https://chess.freegamestore.online/', 'chess')).toBe(true);
    expect(isAllowedReturnTo('https://chess.proappstore.online/x?y=z#hash', 'chess')).toBe(true);
    expect(isAllowedReturnTo('https://notes.freeappstore.online/', 'chess')).toBe(false);
    expect(isAllowedReturnTo('https://a.chess.freeappstore.online/', 'chess')).toBe(false);
    expect(isAllowedReturnTo('https://freeappstore.online/', 'chess')).toBe(false);
  });

  it('rejects http on the production domain', () => {
    expect(isAllowedReturnTo('http://chess.freeappstore.online/', 'chess')).toBe(false);
  });

  it('allows localhost for dev (http and https, any port)', () => {
    expect(isAllowedReturnTo('http://localhost:5173/', 'chess')).toBe(true);
    expect(isAllowedReturnTo('https://localhost:8443/x', 'console')).toBe(true);
    expect(isAllowedReturnTo('http://127.0.0.1:8787/cb', 'store')).toBe(true);
  });

  it('allows the first-party ids only on their own origins', () => {
    expect(isAllowedReturnTo('https://freeappstore.online/app/', 'console')).toBe(true);
    expect(isAllowedReturnTo('https://console.freeappstore.online/', 'console')).toBe(true);
    expect(isAllowedReturnTo('https://freeappstore.online/apps/chess', 'store')).toBe(true);
    expect(isAllowedReturnTo('https://admin.freeappstore.online/', 'fas-admin')).toBe(true);
    expect(isAllowedReturnTo('https://api.freeappstore.online/v1/keys', 'keys')).toBe(true);
    expect(isAllowedReturnTo('https://mcp.freeappstore.online/callback?nonce=n', 'mcp')).toBe(true);
    // A first-party id on an app subdomain is exactly the token-theft shape.
    expect(isAllowedReturnTo('https://chess.freeappstore.online/', 'console')).toBe(false);
    expect(isAllowedReturnTo('https://chess.freeappstore.online/', 'store')).toBe(false);
    expect(isAllowedReturnTo('https://evil.freeappstore.online/', 'fas-admin')).toBe(false);
    expect(isAllowedReturnTo('https://freeappstore.online/', 'fas-admin')).toBe(false);
  });

  it('allows the explicit alias and custom-domain exceptions', () => {
    expect(isAllowedReturnTo('https://hanzi.freeappstore.online/', 'hanzi-practice')).toBe(true);
    expect(isAllowedReturnTo('https://yi.freeappstore.online/', 'hanzi-associations')).toBe(true);
    expect(isAllowedReturnTo('https://hanzi.freeappstore.online/', 'chess')).toBe(false);
    expect(isAllowedReturnTo('https://freeagentstore.online/console/', 'fags-console')).toBe(true);
    expect(isAllowedReturnTo('https://freeagentstore.online/console/', 'chess')).toBe(false);
  });

  it('allows the OFO Copilot Chrome identity redirect for the extension app only', () => {
    const redirect = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/ofo-copilot';
    expect(isAllowedReturnTo(redirect, 'ofo-copilot-extension')).toBe(true);
    expect(isAllowedReturnTo(redirect, 'store')).toBe(false);
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

  it('allows the FreeIdeaStore MCP workers.dev callback for app_id=mcp only', () => {
    const callback = 'https://freeideastore-mcp.serge-the-dev.workers.dev/oauth/callback';
    expect(isAllowedReturnTo(callback, 'mcp')).toBe(true);
    expect(isAllowedReturnTo(callback, 'freeideastore')).toBe(false);
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
  it('is the app id for an app', () => {
    expect(sessionAudience('chess', 'https://chess.freeappstore.online/')).toBe('chess');
    expect(sessionAudience('fags-console', 'https://freeagentstore.online/console/')).toBe(
      'fags-console',
    );
  });

  it('is console for a first-party id on its own origin or localhost', () => {
    expect(sessionAudience('store', 'https://freeappstore.online/')).toBe('console');
    expect(sessionAudience('console', 'https://freeappstore.online/app/')).toBe('console');
    expect(sessionAudience('console', 'https://console.freeappstore.online/')).toBe('console');
    expect(sessionAudience('fas-admin', 'https://admin.freeappstore.online/')).toBe('console');
    expect(sessionAudience('mcp', 'https://mcp.freeappstore.online/callback')).toBe('console');
    expect(sessionAudience('console', 'http://localhost:5173/')).toBe('console');
  });

  it('is the app id for a first-party id delivered elsewhere (the FreeIdeaStore MCP worker)', () => {
    expect(
      sessionAudience('mcp', 'https://freeideastore-mcp.serge-the-dev.workers.dev/oauth/callback'),
    ).toBe('mcp');
  });
});

describe('isAllowedOrigin (CORS allowlist)', () => {
  it('allows the apex over https', () => {
    expect(isAllowedOrigin('https://freeappstore.online')).toBe(true);
  });

  it('allows arbitrary subdomains over https', () => {
    expect(isAllowedOrigin('https://chess.freeappstore.online')).toBe(true);
  });

  it('allows freegamestore.online apex + subdomains (shared FAS backend)', () => {
    expect(isAllowedOrigin('https://freegamestore.online')).toBe(true);
    expect(isAllowedOrigin('https://chess.freegamestore.online')).toBe(true);
  });

  it('allows proappstore.online apex + subdomains (shared session)', () => {
    expect(isAllowedOrigin('https://proappstore.online')).toBe(true);
    expect(isAllowedOrigin('https://carsads.proappstore.online')).toBe(true);
  });

  it('allows the idea and agent store origins that share auth', () => {
    expect(isAllowedOrigin('https://freeideastore.online')).toBe(true);
    expect(isAllowedOrigin('https://proideastore.online')).toBe(true);
    expect(isAllowedOrigin('https://freeagentstore.online')).toBe(true);
    expect(isAllowedOrigin('https://freeideastore-mcp.serge-the-dev.workers.dev')).toBe(false);
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
