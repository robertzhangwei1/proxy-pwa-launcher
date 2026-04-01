const SHELL_CACHE = "proxy-pwa-shell-v3";

function scopedAsset(path) {
  return new URL(path, self.registration.scope).toString();
}

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./android.html",
  "./ios.html",
  "./styles.css",
  "./runtime-config.js",
  "./app.js",
  "./manifest-android.webmanifest",
  "./manifest-ios.webmanifest",
  "./icons/icon-192.svg",
  "./icons/icon-512.svg",
].map(scopedAsset);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  const requestUrl = new URL(event.request.url);

  if (requestUrl.pathname.includes("/api/")) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(event.request).then((networkResponse) => {
        const responseClone = networkResponse.clone();
        caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, responseClone));
        return networkResponse;
      });
    })
  );
});
