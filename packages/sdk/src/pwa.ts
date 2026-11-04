/** Update activation and page reload are deliberately separate user actions. */
export interface PwaOptions {
  swUrl?: string;
  /** Describe only features which actually work without a server. */
  offlineFeatures?: string[];
  /** Called at the moment of each action. Throwing also blocks the action. */
  isBusy?: () => boolean;
  onError?: (error: unknown) => void;
  reload?: () => void;
}

interface InstallPrompt extends Event {
  prompt(): Promise<unknown>;
}

export function startPwa(options: PwaOptions = {}) {
  const guards = new Set<() => boolean>();
  if (options.isBusy) guards.add(options.isBusy);
  let registration: ServiceWorkerRegistration | undefined;
  let disposed = false;
  let activated = false;
  let activating = false;
  let installPrompt: InstallPrompt | undefined;
  let controller = navigator.serviceWorker?.controller;
  const panel = document.createElement('aside');
  panel.setAttribute('aria-label', 'App installation and updates');
  panel.style.cssText =
    'position:relative;margin:1rem;max-width:30rem;box-sizing:border-box;padding:1rem;padding-bottom:max(1rem,env(safe-area-inset-bottom));background:Canvas;color:CanvasText;border:1px solid;overflow-wrap:anywhere;font:inherit';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const action = document.createElement('button');
  action.type = 'button';
  action.style.cssText = 'font:inherit;min-height:44px;max-width:100%;white-space:normal';
  const install = document.createElement('button');
  install.type = 'button';
  install.textContent = 'Install app';
  install.style.cssText = action.style.cssText;
  install.onclick = () => {
    const prompt = installPrompt;
    installPrompt = undefined;
    void prompt?.prompt().catch((error: unknown) => options.onError?.(error));
    render();
  };
  panel.append(status, action, install);
  document.body.append(panel);
  const busy = () => {
    try {
      return [...guards].some((guard) => guard());
    } catch {
      return true;
    }
  };
  function render() {
    if (disposed) return;
    const waiting = Boolean(registration?.waiting);
    panel.hidden = !waiting && !activated && navigator.onLine && !installPrompt;
    status.textContent = activated
      ? 'Update activated. Reload when your work is saved.'
      : waiting
        ? 'An update is ready. Save edits and finish recordings before updating.'
        : navigator.onLine
          ? 'Install this app for easier access. Installation does not make cloud features available offline.'
          : `Offline. ${options.offlineFeatures?.length ? `Available: ${options.offlineFeatures.join(', ')}.` : 'Only the downloaded app shell is available.'} Cloud, media and model features require a connection unless explicitly downloaded and verified by this app.`;
    install.hidden = !installPrompt;
    action.hidden = !waiting && !activated;
    action.textContent = activated
      ? 'Reload app'
      : activating
        ? 'Activating update…'
        : 'Activate update';
    action.disabled = activating;
  }
  function activate() {
    if (disposed || activating || busy() || !registration?.waiting) return false;
    activating = true;
    try {
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    } catch (error) {
      activating = false;
      options.onError?.(error);
      render();
      return false;
    }
    render();
    return true;
  }
  function reload() {
    if (disposed || !activated || busy()) return false;
    (options.reload ?? (() => window.location.reload()))();
    return true;
  }
  action.onclick = () => {
    if (activated) reload();
    else activate();
  };
  const changed = () => {
    // Also handles an old autoUpdate worker taking control. Never reload here.
    const next = navigator.serviceWorker.controller;
    if (controller && next !== controller) {
      activated = true;
      activating = false;
    }
    controller = next;
    render();
  };
  const watched = new Set<ServiceWorker>();
  const watch = () => {
    const worker = registration?.installing;
    if (worker && !watched.has(worker)) {
      watched.add(worker);
      worker.addEventListener('statechange', render);
    }
    render();
  };
  window.addEventListener('online', render);
  window.addEventListener('offline', render);
  const beforeInstall = (event: Event) => {
    event.preventDefault();
    installPrompt = event as InstallPrompt;
    render();
  };
  const installed = () => {
    installPrompt = undefined;
    render();
  };
  window.addEventListener('beforeinstallprompt', beforeInstall);
  window.addEventListener('appinstalled', installed);
  navigator.serviceWorker?.addEventListener('controllerchange', changed);
  const ready = navigator.serviceWorker
    ? navigator.serviceWorker
        .register(options.swUrl ?? '/sw.js')
        .then((value) => {
          if (disposed) return;
          registration = value;
          registration.addEventListener('updatefound', watch);
          watch();
        })
        .catch((error: unknown) => {
          options.onError?.(error);
        })
    : Promise.resolve();
  render();
  return {
    ready,
    activate,
    reload,
    /** Register dirty forms, active recorders, transfers or other work. */
    addBusyGuard(guard: () => boolean) {
      guards.add(guard);
      return () => {
        guards.delete(guard);
      };
    },
    dispose() {
      disposed = true;
      panel.remove();
      window.removeEventListener('online', render);
      window.removeEventListener('offline', render);
      window.removeEventListener('beforeinstallprompt', beforeInstall);
      window.removeEventListener('appinstalled', installed);
      navigator.serviceWorker?.removeEventListener('controllerchange', changed);
      registration?.removeEventListener('updatefound', watch);
      for (const worker of watched) worker.removeEventListener('statechange', render);
    },
  };
}

/** Optional public assets only. Readiness is checked against actual cached bytes. */
export function offlineAssets(id: string, paths: string[]) {
  const name = `fas-offline-${encodeURIComponent(id)}`;
  const urls = paths.map((path) => {
    const url = new URL(path, location.href);
    if (url.origin !== location.origin || url.username || url.password || url.search || url.hash)
      throw new Error(
        'Offline assets must be public same-origin URLs without credentials or queries.',
      );
    return url.href;
  });
  if (!urls.length) throw new Error('Declare at least one offline asset.');
  return {
    async ready() {
      const cache = await caches.open(name);
      return (await Promise.all(urls.map((url) => cache.match(url)))).every(Boolean);
    },
    async download() {
      const cache = await caches.open(name);
      for (const url of urls) {
        const response = await fetch(url, {
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
        });
        if (
          !response.ok ||
          response.type === 'opaque' ||
          /private|no-store/i.test(response.headers.get('cache-control') ?? '') ||
          /cookie|authorization|\*/i.test(response.headers.get('vary') ?? '')
        )
          throw new Error(`Asset is not publicly cacheable: ${url}`);
        await cache.put(url, response);
      }
    },
    async read(path: string) {
      const url = new URL(path, location.href).href;
      if (!urls.includes(url)) throw new Error('Undeclared offline asset.');
      return (await caches.open(name)).match(url);
    },
    remove: () => caches.delete(name),
  };
}
