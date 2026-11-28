import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const context = {};
runInNewContext(readFileSync(new URL('../quick-access.js', import.meta.url), 'utf8'), context);
const createStore = context.FasShortcuts.createStore;
const plain = value => JSON.parse(JSON.stringify(value));
const memory = () => { let value = null; return { getItem: () => value, setItem: (_key, next) => { value = next; } }; };

test('favourites persist and opening an app deduplicates recency; clearing history preserves stars', () => {
  const storage = memory(); const first = createStore(storage);
  first.toggle('books'); first.opened('books'); first.opened('notes'); first.opened('books');
  const next = createStore(storage);
  assert.deepEqual(plain(next.snapshot()), { favourites: ['books'], recent: ['books', 'notes'], persistent: true });
  next.clearRecent();
  assert.deepEqual(plain(createStore(storage).snapshot().recent), []);
  assert.deepEqual(plain(createStore(storage).snapshot().favourites), ['books']);
  next.toggle('books'); assert.deepEqual(plain(createStore(storage).snapshot().favourites), []);
});

test('recent history is bounded; invalid IDs and corrupt storage cannot create shortcuts', () => {
  const storage = memory(); const store = createStore(storage);
  for (let i = 0; i < 30; i++) store.opened(`app-${i}`);
  store.opened('https://evil.example'); store.toggle('../secret');
  assert.equal(store.snapshot().recent.length, 12);
  assert.equal(store.snapshot().recent[0], 'app-29');
  assert.deepEqual(plain(store.snapshot().favourites), []);
  storage.setItem('', 'broken'); assert.deepEqual(plain(createStore(storage).snapshot().recent), []);
});

test('unavailable storage leaves the page usable and reports temporary-only storage', () => {
  const store = createStore({ getItem() { throw Error('blocked'); }, setItem() { throw Error('full'); } });
  store.toggle('books'); store.opened('notes');
  assert.deepEqual(plain(store.snapshot()), { favourites: ['books'], recent: ['notes'], persistent: false });
});

test('a second tab reloads current saved favourites before changing another app', () => {
  const storage = memory(), a = createStore(storage), b = createStore(storage);
  a.toggle('books'); b.toggle('notes');
  a.reload(); assert.deepEqual(plain(a.snapshot().favourites), ['books', 'notes']);
});
