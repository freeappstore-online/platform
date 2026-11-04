// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { offlineAssets, startPwa } from './pwa.js';
import { pwaOptions } from './pwa-config.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});
async function setup() {
  const serviceWorker = new EventTarget() as ServiceWorkerContainer;
  const oldController = {} as ServiceWorker;
  Object.defineProperty(serviceWorker, 'controller', { value: oldController, writable: true });
  const waiting = { postMessage: vi.fn() };
  const registration = Object.assign(new EventTarget(), { waiting, installing: null });
  Object.assign(serviceWorker, { register: vi.fn().mockResolvedValue(registration) });
  Object.defineProperty(navigator, 'serviceWorker', { value: serviceWorker, configurable: true });
  const reload = vi.fn();
  const pwa = startPwa({ reload });
  cleanups.push(pwa.dispose);
  await pwa.ready;
  return { pwa, serviceWorker, waiting, reload };
}
it('defers activation with dirty forms and active recordings, and checks again before reload', async () => {
  const { pwa, serviceWorker, waiting, reload } = await setup();
  let dirty = true;
  let recording = false;
  pwa.addBusyGuard(() => dirty);
  pwa.addBusyGuard(() => recording);
  expect(pwa.activate()).toBe(false);
  dirty = false;
  recording = true;
  expect(pwa.activate()).toBe(false);
  expect(waiting.postMessage).not.toHaveBeenCalled();
  recording = false;
  expect(pwa.activate()).toBe(true);
  expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
  expect(pwa.reload()).toBe(false);
  Object.defineProperty(serviceWorker, 'controller', { value: {}, writable: true });
  serviceWorker.dispatchEvent(new Event('controllerchange'));
  expect(reload).not.toHaveBeenCalled();
  dirty = true;
  expect(pwa.reload()).toBe(false);
  dirty = false;
  expect(pwa.reload()).toBe(true);
  expect(reload).toHaveBeenCalledOnce();
});
it('does not reload when a legacy autoUpdate worker or another tab activates', async () => {
  const { serviceWorker, reload } = await setup();
  Object.defineProperty(serviceWorker, 'controller', { value: {} });
  serviceWorker.dispatchEvent(new Event('controllerchange'));
  expect(reload).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain('Reload when your work is saved');
});
it('blocks actions when a busy guard throws and cleans up listeners', async () => {
  const { pwa, serviceWorker } = await setup();
  const remove = pwa.addBusyGuard(() => {
    throw new Error('unavailable');
  });
  expect(pwa.activate()).toBe(false);
  remove();
  expect(pwa.activate()).toBe(true);
  pwa.dispose();
  serviceWorker.dispatchEvent(new Event('controllerchange'));
  expect(document.body.children).toHaveLength(0);
});
it('enforces prompt activation and preserves custom cache/denylist settings', () => {
  const runtimeCaching = [{ handler: 'NetworkOnly', urlPattern: /^\/private/ }];
  const config = pwaOptions({
    registerType: 'autoUpdate',
    workbox: { skipWaiting: true, runtimeCaching, navigateFallbackDenylist: [/^\/oauth/] },
  });
  expect(config.registerType).toBe('prompt');
  expect(config.injectRegister).toBe(false);
  expect(config.workbox.skipWaiting).toBe(false);
  expect(config.workbox.runtimeCaching).toEqual(runtimeCaching);
  expect(config.workbox.navigateFallbackDenylist.some((rule) => rule.test('/api/private'))).toBe(
    true,
  );
  expect(config.workbox.navigateFallbackDenylist.some((rule) => rule.test('/oauth'))).toBe(true);
  expect(config.workbox.globPatterns.join()).not.toMatch(/json|wasm|mp4/);
});
it('reports optional assets ready only when every asset is cached and refuses private responses', async () => {
  const entries = new Map<string, Response>();
  const cache = {
    match: vi.fn(async (url: string) => entries.get(url)),
    put: vi.fn(async (url: string, response: Response) => {
      entries.set(url, response);
    }),
  };
  vi.stubGlobal('caches', { open: async () => cache, delete: async () => entries.clear() });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('asset')));
  const assets = offlineAssets('model-v1', ['/model.bin', '/vocab.txt']);
  expect(await assets.ready()).toBe(false);
  await assets.download();
  expect(await assets.ready()).toBe(true);
  expect(fetch).toHaveBeenCalledWith(expect.any(String), {
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
  });
  entries.delete(new URL('/model.bin', location.href).href);
  expect(await assets.ready()).toBe(false);
  vi.mocked(fetch).mockResolvedValue(
    new Response('secret', { headers: { 'cache-control': 'private' } }),
  );
  await expect(assets.download()).rejects.toThrow('not publicly cacheable');
  expect(() => offlineAssets('bad', ['https://elsewhere.test/model'])).toThrow('same-origin');
  expect(() => offlineAssets('bad', ['/model?token=secret'])).toThrow('queries');
});

it('allows retry after a worker rejects the activation message', async () => {
  const { pwa, waiting } = await setup();
  waiting.postMessage.mockImplementationOnce(() => {
    throw new Error('worker gone');
  });
  expect(pwa.activate()).toBe(false);
  expect(pwa.activate()).toBe(true);
});

it('renders honest offline status and install UI without claiming cloud availability', async () => {
  await setup();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  window.dispatchEvent(new Event('offline'));
  // A waiting update takes priority; use a registration without a waiting worker.
  const register = vi.mocked(navigator.serviceWorker.register);
  register.mockResolvedValue(
    Object.assign(new EventTarget(), {
      waiting: null,
      installing: null,
    }) as unknown as ServiceWorkerRegistration,
  );
  const pwa = startPwa();
  cleanups.push(pwa.dispose);
  await pwa.ready;
  expect(document.body.textContent).toContain('Only the downloaded app shell');
  expect(document.body.textContent).toContain(
    'Cloud, media and model features require a connection',
  );
  const event = new Event('beforeinstallprompt', { cancelable: true });
  const prompt = vi.fn().mockResolvedValue(undefined);
  Object.assign(event, { prompt });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  const buttons = [...document.querySelectorAll('button')];
  buttons
    .filter((button) => button.textContent === 'Install app')
    .at(-1)!
    .click();
  expect(prompt).toHaveBeenCalledOnce();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

it.each(['private', 'no-store', 'vary-cookie', 'vary-authorization', 'vary-*'])(
  'rejects unsafe asset policy %s',
  async (policy) => {
    const put = vi.fn();
    vi.stubGlobal('caches', { open: async () => ({ put }) });
    const headers = policy.startsWith('vary-')
      ? { vary: policy.slice(5) }
      : { 'cache-control': policy };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('secret', { headers })));
    await expect(offlineAssets('unsafe', ['/asset']).download()).rejects.toThrow(
      'not publicly cacheable',
    );
    expect(put).not.toHaveBeenCalled();
  },
);

it('keeps partial downloads unready and propagates quota failures', async () => {
  const entries = new Map();
  const cache = {
    match: async (url: string) => entries.get(url),
    put: vi.fn(async (url: string, response: Response) => {
      entries.set(url, response);
    }),
  };
  vi.stubGlobal('caches', { open: async () => cache });
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(new Response('first'))
      .mockRejectedValueOnce(new Error('offline')),
  );
  const assets = offlineAssets('partial', ['/one', '/two']);
  await expect(assets.download()).rejects.toThrow('offline');
  expect(await assets.ready()).toBe(false);
  vi.mocked(fetch).mockResolvedValue(new Response('retry'));
  cache.put.mockRejectedValueOnce(new Error('quota'));
  await expect(assets.download()).rejects.toThrow('quota');
  expect(await assets.ready()).toBe(false);
});

it('routes unvisited deep links to the shell while excluding API and custom paths', () => {
  const config = pwaOptions({ workbox: { navigateFallbackDenylist: [/^\/oauth/] } });
  const denied = (path: string) =>
    config.workbox!.navigateFallbackDenylist!.some((rule) => rule.test(path));
  expect(config.workbox!.navigateFallback).toBe('/index.html');
  expect(denied('/never-visited/deep-link')).toBe(false);
  for (const path of ['/api', '/api/private', '/v1/account', '/oauth/callback'])
    expect(denied(path)).toBe(true);
  expect(config.workbox!.runtimeCaching).toBeUndefined();
  expect(() => pwaOptions({ strategies: 'injectManifest' })).toThrow('generateSW');
});
