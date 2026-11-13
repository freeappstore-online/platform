import { describe, expect, it } from 'vitest';
import { sessionStatus } from './whoami.js';

const DAY = 24 * 60 * 60 * 1000;
const github = { login: 'alice', token: 'gh' };

// #283: a missing session token used to print "Session: active".
describe('sessionStatus', () => {
  it('says there is no session when the token is missing', () => {
    expect(sessionStatus({ github } as never)).toBe(
      'Session: none — run `fas login` to sign in to the API.',
    );
  });

  const tokenExpiringIn = (ms: number) =>
    `${Buffer.from(JSON.stringify({ exp: Math.floor((Date.now() + ms) / 1000) })).toString('base64url')}.sig`;

  it('is active with unknown expiry for a token whose expiry cannot be read', () => {
    expect(sessionStatus({ github, session: { token: 't' } } as never)).toBe(
      'Session: active (expiry unknown)',
    );
  });

  it('counts down and reports expiry', () => {
    expect(sessionStatus({ github, session: { token: tokenExpiringIn(29 * DAY) } } as never)).toBe(
      'Session: active, expires in 29 days.',
    );
    expect(sessionStatus({ github, session: { token: tokenExpiringIn(-DAY) } } as never)).toBe(
      'Session: expired — run `fas login` to refresh.',
    );
  });
});
