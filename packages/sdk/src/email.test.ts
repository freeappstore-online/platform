import { afterEach, describe, expect, it, vi } from 'vitest';
import { Email } from './email.js';

function fakeAuth(token: string | null) {
  return { token, handleUnauthorized: vi.fn() };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).fetch;
});

describe('Email.send', () => {
  it('posts the message with the bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
    globalThis.fetch = fetchMock;
    await new Email('my app', 'https://api.example', fakeAuth('tok')).send('a@b.c', 'Hi', {
      text: 'hello',
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example/v1/apps/my%20app/email/send');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toEqual({ to: 'a@b.c', subject: 'Hi', text: 'hello' });
  });

  it('requires a body and a session', async () => {
    const email = new Email('a', 'https://api.example', fakeAuth('tok'));
    await expect(email.send('a@b.c', 'Hi', {})).rejects.toThrow(/html or text/);
    const signedOut = new Email('a', 'https://api.example', fakeAuth(null));
    await expect(signedOut.send('a@b.c', 'Hi', { text: 'x' })).rejects.toThrow('Not signed in.');
  });

  it('drops an expired session on 401', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    const auth = fakeAuth('tok');
    const email = new Email('a', 'https://api.example', auth);
    await expect(email.send('a@b.c', 'Hi', { text: 'x' })).rejects.toThrow('Not signed in.');
    expect(auth.handleUnauthorized).toHaveBeenCalledWith('tok');
  });

  it('surfaces the server error', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: 'daily limit' }), { status: 429 }));
    const email = new Email('a', 'https://api.example', fakeAuth('tok'));
    await expect(email.send('a@b.c', 'Hi', { text: 'x' })).rejects.toThrow('daily limit');
  });
});
