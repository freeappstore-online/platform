// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import {
  getPwaInstallState,
  offlineAssets,
  requestPwaInstall,
  startPwa,
  subscribePwaInstall,
} from './pwa.js';
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
it('keeps the update notice stuck to the viewport bottom, dismissible until the state changes (#580)', async () => {
  const { serviceWorker } = await setup();
  const panel = document.body.querySelector('aside') as HTMLElement;
  expect(panel.style.position).toBe('sticky');
  expect(panel.hidden).toBe(false);
  const later = [...panel.querySelectorAll('button')].find((b) => b.textContent === 'Later');
  later?.click();
  expect(panel.hidden).toBe(true);
  Object.defineProperty(serviceWorker, 'controller', { value: {} });
  serviceWorker.dispatchEvent(new Event('controllerchange'));
  expect(panel.hidden).toBe(false);
});
it('checks for a new build when the tab becomes visible and stops after dispose (#580)', async () => {
  const { pwa, serviceWorker } = await setup();
  const registration = await (serviceWorker.register as ReturnType<typeof vi.fn>).mock.results[0]
    ?.value;
  registration.update = vi.fn().mockResolvedValue(undefined);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(registration.update).toHaveBeenCalledOnce();
  pwa.dispose();
  document.dispatchEvent(new Event('visibilitychange'));
  expect(registration.update).toHaveBeenCalledOnce();
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

it('keeps default installation and offline promotion out of the app footer', async () => {
  await setup();
  vi.mocked(navigator.serviceWorker.register).mockResolvedValue(
    Object.assign(new EventTarget(), {
      waiting: null,
      installing: null,
    }) as unknown as ServiceWorkerRegistration,
  );
  const pwa = startPwa();
  cleanups.push(pwa.dispose);
  await pwa.ready;
  const panel = document.querySelector('aside:last-child') as HTMLElement;
  expect(panel.hidden).toBe(true);
  const event = new Event('beforeinstallprompt', { cancelable: true });
  const prompt = vi.fn().mockResolvedValue(undefined);
  Object.assign(event, { prompt });
  const changed = vi.fn();
  const unsubscribe = subscribePwaInstall(changed);
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(getPwaInstallState()).toBe('available');
  expect(panel.hidden).toBe(true);
  expect(document.body.textContent).not.toContain('Install this app');
  expect(await requestPwaInstall()).toBe(true);
  expect(await requestPwaInstall()).toBe(false);
  expect(prompt).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenCalled();
  expect(getPwaInstallState()).toBe('unavailable');
  unsubscribe();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  window.dispatchEvent(new Event('offline'));
  expect(panel.hidden).toBe(true); // Shell/custom frames own neutral connectivity feedback.
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

it('shows only app-declared offline feature descriptions', async () => {
  await setup();
  vi.mocked(navigator.serviceWorker.register).mockResolvedValue(
    Object.assign(new EventTarget(), {
      waiting: null,
      installing: null,
    }) as unknown as ServiceWorkerRegistration,
  );
  const pwa = startPwa({ offlineFeatures: ['saved notes'] });
  cleanups.push(pwa.dispose);
  await pwa.ready;
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  window.dispatchEvent(new Event('offline'));
  const panel = document.querySelector('aside:last-child') as HTMLElement;
  expect(panel.hidden).toBe(false);
  expect(panel.textContent).toContain('Available: saved notes.');
  expect(panel.textContent).not.toContain('Cloud, media');
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

it('clears a failed install prompt and notifies its owning controller', async () => {
  await setup();
  const onError = vi.fn();
  const pwa = startPwa({ onError });
  cleanups.push(pwa.dispose);
  const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
    prompt: vi.fn().mockRejectedValue(new Error('prompt unavailable')),
  });
  window.dispatchEvent(event);
  expect(await requestPwaInstall()).toBe(false);
  expect(onError).toHaveBeenCalledOnce();
  expect(getPwaInstallState()).toBe('unavailable');
});

it('does not offer installation in an already installed app', async () => {
  await setup();
  const media = vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
  try {
    const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt: vi.fn(),
    });
    window.dispatchEvent(event);
    expect(getPwaInstallState()).toBe('unavailable');
    expect(await requestPwaInstall()).toBe(false);
    expect(event.prompt).not.toHaveBeenCalled();
  } finally {
    media.mockRestore();
  }
});

it('drops a disposed controller prompt without clearing a newer install offer', async () => {
  const first = await setup();
  let finish!: () => void;
  window.dispatchEvent(
    Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    }),
  );
  const pending = requestPwaInstall();
  expect(getPwaInstallState()).toBe('prompting');
  first.pwa.dispose();
  expect(getPwaInstallState()).toBe('unavailable');
  const second = await setup();
  window.dispatchEvent(
    Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
      prompt: vi.fn().mockResolvedValue(undefined),
    }),
  );
  finish();
  await pending;
  expect(getPwaInstallState()).toBe('available');
  window.dispatchEvent(new Event('appinstalled'));
  expect(getPwaInstallState()).toBe('unavailable');
  second.pwa.dispose();
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
  expect(config.workbox!.runtimeCaching).toHaveLength(2);
  for (const rule of config.workbox!.runtimeCaching!) {
    expect((rule.urlPattern as RegExp).test('https://api.freeappstore.online/v1/private')).toBe(
      false,
    );
  }
  expect(() => pwaOptions({ strategies: 'injectManifest' })).toThrow('generateSW');
});

it('can be disabled without DOM, registration or install listeners while preserving controller methods', async () => {
  const register = vi.fn();
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register } });
  const pwa = startPwa({ enabled: false });
  await pwa.ready;
  expect(register).not.toHaveBeenCalled();
  expect(document.body.children).toHaveLength(0);
  const event = new Event('beforeinstallprompt', { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
  expect(pwa.activate()).toBe(false);
  expect(pwa.reload()).toBe(false);
  const guard = vi.fn();
  pwa.addBusyGuard(guard)();
  expect(guard).not.toHaveBeenCalled();
  pwa.dispose();
});
