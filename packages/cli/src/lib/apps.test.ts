import { describe, expect, it } from 'vitest';
import { APPS, urlFor } from './apps.js';

describe('urlFor', () => {
  it('returns the registered subdomain for known apps', () => {
    expect(urlFor('music')).toBe('https://music.freeappstore.online');
    expect(urlFor('freeappstore')).toBe('https://freeappstore.online');
  });

  it('falls back to <id>.freeappstore.online', () => {
    expect(urlFor('todo')).toBe('https://todo.freeappstore.online');
  });
});

describe('APPS registry', () => {
  it('all entries have non-empty subdomain', () => {
    for (const [id, record] of Object.entries(APPS)) {
      expect(record.subdomain, `subdomain for ${id}`).toBeTruthy();
    }
  });
});
