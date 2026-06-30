const CACHE = "vibecode-v2";

self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  if (e.request.method !== "GET") return;
  if (url.hostname !== self.location.hostname) return;
  if (url.pathname.startsWith("/session/")) return;

  // Network-first with 3s timeout — fall back to cache if network hangs
  e.respondWith(
    new Promise((resolve) => {
      let resolved = false;
      function settle(response) {
        if (resolved) return;
        resolved = true;
        resolve(response);
      }

      const timer = setTimeout(() => {
        caches.match(e.request).then((cached) => {
          if (cached) settle(cached);
        });
      }, 3000);

      fetch(e.request)
        .then((res) => {
          clearTimeout(timer);
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone));
          }
          settle(res);
        })
        .catch(() => {
          clearTimeout(timer);
          caches.match(e.request).then((cached) => {
            settle(cached || new Response("Offline", { status: 503 }));
          });
        });
    })
  );
});

self.addEventListener("push", (e) => {
  const message = e.data ? e.data.text() : "Your build is ready!";
  const isError = message.startsWith("Build failed");
  e.waitUntil(
    self.registration.showNotification(isError ? "Build Failed" : "VibeCode", {
      body: message,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: "vibecode-build",
      renotify: true,
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin)) {
          return client.focus();
        }
      }
      return self.clients.openWindow("/");
    })
  );
});
