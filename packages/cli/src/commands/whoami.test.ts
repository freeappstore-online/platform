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

  it('is active with unknown expiry for a token saved without a timestamp', () => {
    expect(sessionStatus({ github, session: { token: 't' } } as never)).toBe(
      'Session: active (expiry unknown)',
    );
  });

  it('counts down and reports expiry', () => {
    expect(
      sessionStatus({ github, session: { token: 't', obtainedAt: Date.now() - DAY } } as never),
    ).toMatch(/^Session: active, expires in \d+ days\.$/);
    expect(
      sessionStatus({
        github,
        session: { token: 't', obtainedAt: Date.now() - 400 * DAY },
      } as never),
    ).toBe('Session: expired — run `fas login` to refresh.');
  });
});
