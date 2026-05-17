import { describe, expect, it } from 'vitest';
import { APPS, cfProjectFor, urlFor } from './apps.js';

describe('cfProjectFor', () => {
  it('returns the registered cfProject for known legacy names', () => {
    expect(cfProjectFor('music')).toBe('freemusic');
    expect(cfProjectFor('puzzle')).toBe('freepuzzle');
    expect(cfProjectFor('freeappstore')).toBe('freeappstore');
  });

  it('returns the registered cfProject for known convention-following names', () => {
    expect(cfProjectFor('chess')).toBe('freechessapp');
    expect(cfProjectFor('quiz')).toBe('freequizapp');
  });

  it('falls back to free<id>app convention for unknown apps', () => {
    expect(cfProjectFor('whateverapp')).toBe('freewhateverappapp');
    expect(cfProjectFor('todo')).toBe('freetodoapp');
  });
});

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
  it('all entries have non-empty cfProject and subdomain', () => {
    for (const [id, record] of Object.entries(APPS)) {
      expect(record.cfProject, `cfProject for ${id}`).toBeTruthy();
      expect(record.subdomain, `subdomain for ${id}`).toBeTruthy();
    }
  });
});
