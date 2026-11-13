/** Update activation and page reload are deliberately separate user actions. */
export interface PwaOptions {
  /** Disable initialization in development or other non-PWA contexts. Defaults to true. */
  enabled?: boolean;
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

type InstallState = 'unavailable' | 'available' | 'prompting';
let installOffer:
  | { event: InstallPrompt; owner: symbol; onError?: PwaOptions['onError'] }
  | undefined;
let installState: InstallState = 'unavailable';
let activeInstall: { owner: symbol; operation: symbol } | undefined;
const installListeners = new Set<() => void>();
function notifyInstall(state: InstallState) {
  installState = state;
  for (const listener of installListeners) listener();
}

/** Shared installation state; Profile and custom frames use the existing controller. */
export function getPwaInstallState(): InstallState {
  return installState;
}
export function subscribePwaInstall(listener: () => void): () => void {
  installListeners.add(listener);
  return () => {
    installListeners.delete(listener);
  };
}

/** True means the browser prompt opened, not that the user installed the app. */
export async function requestPwaInstall(): Promise<boolean> {
  const offer = installOffer;
  if (!offer || installState !== 'available') return false;
  installOffer = undefined;
  const operation = Symbol('install prompt');
  activeInstall = { owner: offer.owner, operation };
  notifyInstall('prompting');
  try {
    await offer.event.prompt();
    return true;
  } catch (error) {
    offer.onError?.(error);
    return false;
  } finally {
    if (activeInstall?.operation === operation) {
      activeInstall = undefined;
      notifyInstall('unavailable');
    }
  }
}

export function startPwa(options: PwaOptions = {}) {
  if (options.enabled === false)
    return {
      ready: Promise.resolve(),
      activate: () => false,
      reload: () => false,
      addBusyGuard: (_guard: () => boolean) => () => {},
      dispose() {},
    };
  const guards = new Set<() => boolean>();
  if (options.isBusy) guards.add(options.isBusy);
  let registration: ServiceWorkerRegistration | undefined;
  let disposed = false;
  let activated = false;
  let activating = false;
  const installOwner = Symbol('PWA controller');
  let controller = navigator.serviceWorker?.controller;
  const panel = document.createElement('aside');
  panel.setAttribute('aria-label', 'App installation and updates');
  // In the page flow, at the end of the body. An overlay (fixed or sticky) was
  // tried for #580 and covered the app's own controls at narrow widths with
  // enlarged text, which the notice itself asks the user to use first.
  panel.style.cssText =
    'position:relative;margin:1rem;max-width:30rem;box-sizing:border-box;padding:1rem;padding-bottom:max(1rem,env(safe-area-inset-bottom));background:Canvas;color:CanvasText;border:1px solid;overflow-wrap:anywhere;font:inherit';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const action = document.createElement('button');
  action.type = 'button';
  action.style.cssText = 'font:inherit;min-height:44px;max-width:100%;white-space:normal';
  const later = document.createElement('button');
  later.type = 'button';
  later.textContent = 'Later';
  later.style.cssText = `${action.style.cssText};margin-inline-start:0.5rem`;
  panel.append(status, action, later);
  document.body.append(panel);
  /** Hidden by the user until the next change of state. */
  let dismissed = false;
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
    panel.hidden =
      dismissed ||
      (!waiting && !activated && (navigator.onLine || !options.offlineFeatures?.length));
    status.textContent = activated
      ? 'Update activated. Reload when your work is saved.'
      : waiting
        ? 'An update is ready. Save edits and finish recordings before updating.'
        : navigator.onLine
          ? ''
          : options.offlineFeatures?.length
            ? `Offline. Available: ${options.offlineFeatures.join(', ')}.`
            : '';
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
  later.onclick = () => {
    dismissed = true;
    render();
  };
  /** A change of state the user has not seen: show the panel again. */
  const changedState = () => {
    dismissed = false;
    render();
  };
  const changed = () => {
    // Also handles an old autoUpdate worker taking control. Never reload here.
    const next = navigator.serviceWorker.controller;
    if (controller && next !== controller) {
      activated = true;
      activating = false;
    }
    controller = next;
    changedState();
  };
  const watched = new Set<ServiceWorker>();
  const watch = () => {
    const worker = registration?.installing;
    if (worker && !watched.has(worker)) {
      watched.add(worker);
      worker.addEventListener('statechange', changedState);
    }
    render();
  };
  // A long-lived tab or installed app otherwise only looks for a new build on
  // navigation, so it can run an old one for days (#580).
  const checkForUpdate = () => {
    if (document.visibilityState === 'visible') registration?.update().catch(() => {});
  };
  document.addEventListener('visibilitychange', checkForUpdate);
  const updateTimer = setInterval(checkForUpdate, 60 * 60 * 1000);
  window.addEventListener('online', changedState);
  window.addEventListener('offline', changedState);
  const beforeInstall = (event: Event) => {
    if (
      window.matchMedia?.('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone ||
      installState === 'prompting'
    )
      return;
    event.preventDefault();
    installOffer = { event: event as InstallPrompt, owner: installOwner, onError: options.onError };
    notifyInstall('available');
  };
  const installed = () => {
    installOffer = undefined;
    activeInstall = undefined;
    notifyInstall('unavailable');
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
      if (installOffer?.owner === installOwner || activeInstall?.owner === installOwner) {
        if (installOffer?.owner === installOwner) installOffer = undefined;
        if (activeInstall?.owner === installOwner) activeInstall = undefined;
        notifyInstall('unavailable');
      }
      panel.remove();
      document.removeEventListener('visibilitychange', checkForUpdate);
      clearInterval(updateTimer);
      window.removeEventListener('online', changedState);
      window.removeEventListener('offline', changedState);
      window.removeEventListener('beforeinstallprompt', beforeInstall);
      window.removeEventListener('appinstalled', installed);
      navigator.serviceWorker?.removeEventListener('controllerchange', changed);
      registration?.removeEventListener('updatefound', watch);
      for (const worker of watched) worker.removeEventListener('statechange', changedState);
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
