// Cache name is the asset-cache generation. Bump it when changing cache
// admission rules so activate purges entries written by the old policy.
const ASSET_CACHE = "slock-assets-v2";
const HTML_FALLBACK_CONTENT_TYPE = /\btext\/html\b/i;
const CACHEABLE_ASSET_PATH = /\.(?:css|gif|ico|jpe?g|js|json|mjs|png|svg|webp|woff2?)$/i;
const CACHEABLE_ASSET_TYPES = [
  "application/javascript",
  "application/json",
  "font/",
  "image/",
  "text/css",
];

function isHtmlFallbackResponse(response) {
  return HTML_FALLBACK_CONTENT_TYPE.test(response.headers.get("content-type") || "");
}

function isCacheableAssetResponse(req, response) {
  if (!response.ok || response.redirected) return false;

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (isHtmlFallbackResponse(response)) return false;

  const url = new URL(req.url);
  if (CACHEABLE_ASSET_PATH.test(url.pathname)) return true;

  return CACHEABLE_ASSET_TYPES.some((type) => contentType.startsWith(type));
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith("slock-assets-") && k !== ASSET_CACHE).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

// Cache-first for hashed build assets (immutable by Vite's content hash).
// Lets the PWA resume from disk when Android Chrome kills the backgrounded tab.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith("/assets/")) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(ASSET_CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      const response = await fetch(req, { cache: "reload" });
      if (response.ok && isHtmlFallbackResponse(response)) {
        return new Response("", { status: 404, statusText: "Not Found" });
      }
      if (isCacheableAssetResponse(req, response)) cache.put(req, response.clone()).catch(() => {});
      return response;
    })(),
  );
});

function isSameNotificationTarget(clientUrl, targetUrl) {
  try {
    const client = new URL(clientUrl);
    const target = new URL(targetUrl, self.location.origin);
    if (client.origin !== target.origin) return false;
    if (client.pathname !== target.pathname) return false;

    return client.searchParams.get("thread") === target.searchParams.get("thread");
  } catch {
    return false;
  }
}

function getPushNotificationData(event) {
  if (!event.data) return {};

  let text;
  try {
    text = event.data.text();
  } catch {
    return {
      title: "Raft",
      body: "New activity",
    };
  }

  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return {
      title: "Raft",
      body: text,
    };
  }
}

self.addEventListener("push", (event) => {
  const data = getPushNotificationData(event);

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const targetUrl = data.url || "/";
      const shouldSuppress = !data.alwaysShow && clients.some((client) => {
        const isActive = client.focused || client.visibilityState === "visible";
        return isActive && isSameNotificationTarget(client.url, targetUrl);
      });
      if (shouldSuppress) return;

      return self.registration.showNotification(data.title || "Raft", {
        body: data.body || "New activity",
        icon: "/android-chrome-192x192.png",
        badge: "/favicon-32x32.png",
        tag: data.tag || "slock-push",
        data: { url: targetUrl },
      });
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = event.notification?.data?.url || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      const matchingClient = clients.find((client) => isSameNotificationTarget(client.url, targetUrl));
      if (matchingClient) {
        matchingClient.postMessage({ type: "RAFT_PUSH_NOTIFICATION_NAVIGATE", url: targetUrl });
        await matchingClient.focus();
        return;
      }
      await self.clients.openWindow(targetUrl);
    }),
  );
});
