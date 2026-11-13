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

// The app's HTML, kept so a reopened page paints without waiting for the
// network (docs/frontend/boot-shell.md, "Kept by the service worker"). Its own
// cache: recovery and asset-cache bumps clear it separately.
const SHELL_CACHE = "slock-shell-v1";
const SHELL_KEY = "/";
const SHELL_SAVED_AT = "x-raft-shell-saved-at";
const SHELL_ASSETS = "x-raft-shell-assets";
// Set on a kept copy no longer opened from (retireKeptShell): it is only the offline fallback.
const SHELL_RETIRED = "x-raft-shell-retired";
// Keeping failures after the network delivered the release's files: a page
// loaded from the network works, so the older copy is retired.
const RETIRE_ON_STEPS = new Set(["asset_store", "catalogs", "shell_store"]);
// Older than this, the network answers first (the copy is still the fallback offline).
const SHELL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Paths the app's HTML never answers: the server's own pages when it shares
// the origin (tests/serviceWorkerShell.test.ts keeps this in step with
// packages/server/src/app.ts), the socket, the daemon, built files.
const NOT_APP_PAGE = /^\/(?:api|internal|oidc|share|health|livez|metrics|socket\.io|daemon|assets|feedback|\.well-known)(?:\/|$)/;
const FILE_PATH = /\/[^/]*\.[a-z0-9]+$/i;
// A release built with RAFT_SHELL_URGENT=1 carries this; see shellUrgent below.
const SHELL_URGENT_META = /<meta name="raft-shell" content="urgent"/;
const SHELL_ASSET_REF = /(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/g;
// Our HTML, not any 200 text/html (a maintenance page, a CDN challenge, a
// captive portal): the prerendered boot shell and an entry script from /assets.
const SHELL_MARKER = /data-boot-shell=/;
const SHELL_ENTRY = /<script type="module"[^>]*\ssrc="\/assets\/[^"]+\.js"/;

// The display locale's catalog chunks (i18n/messages/index.ts): every
// catalog, en included, is a lazy chunk the boot script modulepreloads from
// the page's JSON map (boot/bootInlineScript.ts), so the HTML names none of
// them as src/href. The page tells the worker its locale (raft:display-locale,
// i18n/serviceWorkerLocale.ts); the kept HTML needs that locale's catalog, and
// en under a partial one, in the asset cache, or an offline open would wait
// for a file it cannot get; en's alone while the locale is not known yet.
// Never every locale: one release would download all.
const LOCALE_CATALOG_MAP = /<script type="application\/json" id="raft-locale-catalogs">([^<]*)<\/script>/;
// Must equal DISPLAY_LOCALES in packages/shared (tests/serviceWorkerLocales.test.ts).
const DISPLAY_LOCALES = ["en", "es", "pt-br", "ru", "ko", "ja", "zh-cn", "zh-tw"];
const COMPLETE_LOCALES = ["en", "zh-cn"];
const DISPLAY_LOCALE_KEY = "/__raft/display-locale";
const BUILT_JS = /^\/assets\/[^"<>?#]+\.js$/;

function catalogMapOf(html) {
  const json = LOCALE_CATALOG_MAP.exec(html)?.[1];
  if (!json) return null;
  try {
    const map = JSON.parse(json);
    return map && typeof map === "object" ? map : null;
  } catch {
    return null;
  }
}

/**
 * The catalog files `locale` is shown from, per the page's map; null when the
 * map lacks one. A build that splits each catalog (i18n/messages/catalogParts.ts)
 * names its first part under the locale and the others under `<locale>:boot`
 * and `<locale>:rest`: all are kept, so a page opened offline has its words too.
 */
function catalogPathsFor(map, locale) {
  const locales = COMPLETE_LOCALES.includes(locale) ? [locale] : [locale, "en"];
  const paths = locales.map((name) => map[name]);
  for (const part of ["boot", "rest"]) for (const name of locales) if (map[`${name}:${part}`] !== undefined) paths.push(map[`${name}:${part}`]);
  return paths.every((path) => typeof path === "string" && BUILT_JS.test(path)) ? paths : null;
}

async function displayLocale() {
  const stored = await (await caches.open(SHELL_CACHE)).match(DISPLAY_LOCALE_KEY);
  const locale = stored ? (await stored.text()).trim() : "";
  return DISPLAY_LOCALES.includes(locale) ? locale : null;
}

// Caches the files a release's first paint loads. Returns null once they are
// all in, else the step that failed ("asset_fetch", "asset_response",
// "asset_store"), which keepShell reports.
async function cacheAssets(paths) {
  const assets = await caches.open(ASSET_CACHE);
  for (const path of paths) {
    const url = new URL(path, self.location.origin).href;
    if (await assets.match(url)) continue;
    let asset;
    try {
      asset = await fetch(url, { cache: "reload" });
    } catch {
      return "asset_fetch";
    }
    if (!isCacheableAssetResponse(new Request(url), asset)) return "asset_response";
    try {
      await assets.put(url, asset);
    } catch {
      return "asset_store";
    }
  }
  return null;
}

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

function isAppNavigation(req, url) {
  return req.mode === "navigate"
    && url.origin === self.location.origin
    && !NOT_APP_PAGE.test(url.pathname)
    && !FILE_PATH.test(url.pathname);
}

// The cached HTML is served only while every file its first paint loads is in
// the asset cache: an old page whose files are gone from the server would stay blank.
async function usableShell() {
  const shell = await (await caches.open(SHELL_CACHE)).match(SHELL_KEY);
  if (!shell || shell.headers.has(SHELL_RETIRED)) return null;
  const savedAt = Number(shell.headers.get(SHELL_SAVED_AT) || 0);
  if (!(Date.now() - savedAt < SHELL_MAX_AGE_MS)) return null;
  const assets = await caches.open(ASSET_CACHE);
  const paths = (shell.headers.get(SHELL_ASSETS) || "").split(" ").filter(Boolean);
  if (paths.length === 0) return null;
  const map = catalogMapOf(await shell.clone().text());
  if (map) {
    const catalogs = catalogPathsFor(map, (await displayLocale()) ?? "en");
    if (!catalogs) return null;
    paths.push(...catalogs);
  }
  const present = await Promise.all(paths.map((path) => assets.match(new URL(path, self.location.origin).href)));
  return present.every(Boolean) ? shell : null;
}

// Keeps the HTML the network just sent, once the files its first paint loads
// are in the asset cache (fetched now if needed), so the next open can run it
// offline from the server. Returns "urgent" when the release asks to take
// effect at once, "kept" when it was kept, "failed" with the step when it is
// our HTML but could not be kept (#triage:#165), otherwise null (not our
// HTML: a maintenance page, a CDN challenge, an Artifact's page).
async function keepShell(response) {
  if (!response.ok || response.redirected || !isHtmlFallbackResponse(response)) return null;
  // A public Artifact's page, rewritten for it by the Pages Worker (_worker.js
  // ARTIFACT_PREVIEW_HEADER): its title, preview tags and article belong to
  // that page alone, never the shell every page opens from.
  if (response.headers.has("x-raft-artifact-preview")) return null;
  const html = await response.text();
  const shellCache = await caches.open(SHELL_CACHE);
  if (!SHELL_MARKER.test(html) || !SHELL_ENTRY.test(html)) return null;
  if (SHELL_URGENT_META.test(html)) {
    await shellCache.delete(SHELL_KEY);
    return { verdict: "urgent", html };
  }
  const paths = [...new Set([...html.matchAll(SHELL_ASSET_REF)].map((match) => match[1]))];
  // A release with a catalog map is kept only with the display locale's
  // catalogs cached beside its files. Not knowing the locale yet (a page from
  // before the map never tells it), en's: the release is kept as usual, and
  // once it boots and tells its locale, the message handler below caches that
  // locale's catalogs for it.
  const map = catalogMapOf(html);
  let catalogs = [];
  if (map) {
    catalogs = catalogPathsFor(map, (await displayLocale()) ?? "en");
    if (!catalogs) return { verdict: "failed", step: "catalogs", html };
  }
  const failedStep = await cacheAssets([...paths, ...catalogs]);
  if (failedStep) return { verdict: "failed", step: failedStep, html };
  const previous = await shellCache.match(SHELL_KEY);
  const headers = new Headers(response.headers);
  // The body is stored decoded.
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set(SHELL_SAVED_AT, String(Date.now()));
  headers.set(SHELL_ASSETS, paths.join(" "));
  try {
    await shellCache.put(SHELL_KEY, new Response(html, { status: response.status, statusText: response.statusText, headers }));
  } catch {
    return { verdict: "failed", step: "shell_store", html };
  }
  // The display locale's catalogs stay too: usableShell needs them offline.
  if (previous && previous.headers.get(SHELL_ASSETS) !== paths.join(" ")) {
    await dropOldReleaseAssets(await caches.open(ASSET_CACHE), [...paths, ...catalogs]);
  }
  return { verdict: "kept", html };
}

// A new release is kept: the asset cache drops every file the new HTML
// doesn't load at first paint, other than the display locale's catalogs. Without this each release left a whole set
// of files behind (only a cache-name bump cleared them). The new release's
// other files (routes loaded on demand) come back the next time they load
// (fillAssetCache); a page still open on the old release is told it was
// superseded and reloads onto the new one when a file fails.
async function dropOldReleaseAssets(assets, keptPaths) {
  const kept = new Set(keptPaths);
  const requests = await assets.keys();
  await Promise.all(
    requests
      .filter((request) => !kept.has(new URL(request.url).pathname))
      .map((request) => assets.delete(request)),
  );
}

// Tells the page that just opened from the kept HTML what the network said
// (main.tsx): "raft:shell-urgent", a release that must take effect at once;
// "raft:shell-superseded", a newer release is now kept;
// "raft:shell-keep-failed" with the step, the network's HTML could not be kept
// (the page reports it). A superseded page's
// files loaded on demand may be gone from the server; it reloads onto the
// kept release when one fails instead of showing the refresh screen.
// The kept copy stops being opened from (usableShell) and stays the
// offline fallback. Only while it is still the copy that was served: another
// open may have kept a newer release since.
async function retireKeptShell(servedSavedAt) {
  const shellCache = await caches.open(SHELL_CACHE);
  const current = await shellCache.match(SHELL_KEY);
  if (!current || current.headers.get(SHELL_SAVED_AT) !== servedSavedAt) return;
  const headers = new Headers(current.headers);
  headers.set(SHELL_RETIRED, "1");
  try {
    await shellCache.put(SHELL_KEY, new Response(await current.text(), { status: current.status, statusText: current.statusText, headers }));
  } catch {
    await shellCache.delete(SHELL_KEY);
  }
}

async function tellPage(clientId, type, detail = {}) {
  const client = clientId ? await self.clients.get(clientId) : null;
  client?.postMessage({ type, ...detail });
}

function respondWithShell(event, url) {
  event.respondWith(
    (async () => {
      const shell = await usableShell().catch(() => null);
      if (shell) {
        const served = shell.clone();
        const servedSavedAt = shell.headers.get(SHELL_SAVED_AT);
        event.waitUntil(
          (async () => {
            const kept = await keepShell(await fetch(url.href, { cache: "no-store", credentials: "same-origin" }));
            if (kept?.verdict === "urgent") await tellPage(event.resultingClientId, "raft:shell-urgent");
            else if (kept?.verdict === "kept" && kept.html !== (await served.text())) {
              await tellPage(event.resultingClientId, "raft:shell-superseded");
            } else if (kept?.verdict === "failed") {
              // The network has a newer release and this browser can't keep it:
              // the copy just served must not stay "usable", or every open runs
              // it again until it is a week old (#triage:#165). Only when the
              // network delivered the files: if it can't (asset_fetch,
              // asset_response), a page loaded from it would fail on the same
              // files, and the older copy still works, so it stays (Tenny). The
              // same release again has nothing to escape from.
              if (RETIRE_ON_STEPS.has(kept.step) && kept.html !== (await served.text())) await retireKeptShell(servedSavedAt);
              await tellPage(event.resultingClientId, "raft:shell-keep-failed", { step: kept.step, servedKept: true });
            }
          })().catch(() => {}),
        );
        return shell;
      }
      try {
        const response = await fetch(event.request);
        event.waitUntil(
          (async () => {
            const kept = await keepShell(response.clone());
            if (kept?.verdict === "failed") await tellPage(event.resultingClientId, "raft:shell-keep-failed", { step: kept.step, servedKept: false });
          })().catch(() => {}),
        );
        return response;
      } catch (error) {
        const offline = await (await caches.open(SHELL_CACHE)).match(SHELL_KEY).catch(() => null);
        if (offline) return offline;
        throw error;
      }
    })(),
  );
}

// The page's display locale (raft:display-locale): kept for the next HTML,
// and its catalogs for the HTML already kept, so a language switch works offline too.
// Called from the one "message" listener (below, with the notification messages).
function handleDisplayLocaleMessage(event, data) {
  if (!DISPLAY_LOCALES.includes(data.locale)) return;
  event.waitUntil?.((async () => {
    await (await caches.open(SHELL_CACHE)).put(DISPLAY_LOCALE_KEY, new Response(data.locale, { headers: { "content-type": "text/plain" } }));
    const shell = await (await caches.open(SHELL_CACHE)).match(SHELL_KEY);
    const map = shell ? catalogMapOf(await shell.text()) : null;
    const catalogs = map ? catalogPathsFor(map, data.locale) : null;
    if (catalogs) await cacheAssets(catalogs);
  })().catch(() => {}));
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => (k.startsWith("slock-assets-") && k !== ASSET_CACHE) || (k.startsWith("slock-shell-") && k !== SHELL_CACHE))
          .map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

// Hashed build assets (immutable by Vite's content hash) are read from the
// browser's HTTP cache while online: the worker doesn't answer, so a warm
// open costs no worker round trip, and the HTTP cache keeps the compressed
// bytes (Cache Storage keeps them decoded: app-shell.js 3 MB against 850 KB),
// read in parallel instead of one caches.open/match after another (#proj-frontend,
// InNOut's warm-load timings: 68-451ms per file through the worker, 0-40ms without).
// The asset cache stays filled, in the background, for two jobs: the kept
// HTML is served only while its files are there (usableShell), and offline
// (the PWA resumed from disk after Android Chrome killed the backgrounded
// tab) the worker answers from it.
const ASSET_FILL_DELAY_MS = 5_000;

async function fillAssetCache(req) {
  const cache = await caches.open(ASSET_CACHE);
  if (await cache.match(req)) return;
  // After the page's own request has put it in the HTTP cache, so this reads
  // from disk rather than downloading the file a second time.
  await new Promise((resolve) => setTimeout(resolve, ASSET_FILL_DELAY_MS));
  if (await cache.match(req)) return;
  const response = await fetch(req, { cache: "force-cache" });
  if (isCacheableAssetResponse(req, response)) await cache.put(req, response);
}

async function assetFromCacheFirst(req) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  const response = await fetch(req, { cache: "reload" });
  if (response.ok && isHtmlFallbackResponse(response)) {
    return new Response("", { status: 404, statusText: "Not Found" });
  }
  if (isCacheableAssetResponse(req, response)) cache.put(req, response.clone()).catch(() => {});
  return response;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (isAppNavigation(req, url)) {
    respondWithShell(event, url);
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith("/assets/")) return;

  if (self.navigator?.onLine !== false) {
    // Not answered: the browser loads it as if there were no worker.
    event.waitUntil(fillAssetCache(req).catch(() => {}));
    return;
  }
  event.respondWith(assetFromCacheFirst(req));
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


// The page waiting on a test notification (docs/contracts/notifications.md §6)
// learns from this whether it was displayed; it acks the server.
async function tellWindowsNotificationShown(testId, shown) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of clients) client.postMessage({ type: "RAFT_NOTIFICATION_SHOWN", testId, shown });
}

// Renders the notification envelope (§4.4): `groupKey` is the tag, so a newer
// notification of the same conversation replaces the older one; `seq` and
// `groupKey` stay in `data` for retraction. Older payloads (title, body, tag,
// url) render as before.
self.addEventListener("push", (event) => {
  const data = getPushNotificationData(event);

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      const targetUrl = data.url || "/";
      const testId = typeof data.testId === "string" && data.testId ? data.testId : null;
      // A test notification is always shown: it is how the user checks this device.
      const shouldSuppress = !data.alwaysShow && !testId && clients.some((client) => {
        const isActive = client.focused || client.visibilityState === "visible";
        return isActive && isSameNotificationTarget(client.url, targetUrl);
      });
      if (shouldSuppress) return;

      const groupKey = typeof data.groupKey === "string" && data.groupKey ? data.groupKey : null;
      const tag = groupKey || (typeof data.tag === "string" && data.tag ? data.tag : null);
      const options = {
        body: data.body || "New activity",
        icon: "/android-chrome-192x192.png",
        badge: "/favicon-32x32.png",
        tag: tag || "slock-push",
        silent: data.silent === true,
        data: {
          url: targetUrl,
          groupKey,
          seq: typeof data.seq === "number" ? data.seq : null,
          id: typeof data.id === "string" ? data.id : null,
          testId,
        },
      };
      // Replacing a notification with the same tag alerts again.
      if (tag) options.renotify = true;

      try {
        await self.registration.showNotification(data.title || "Raft", options);
      } catch (error) {
        if (testId) await tellWindowsNotificationShown(testId, false).catch(() => {});
        throw error;
      }
      if (testId) await tellWindowsNotificationShown(testId, true).catch(() => {});
    }),
  );
});

// A window client does not expose its display mode, so an installed-app window
// tells us about itself (RAFT_CLIENT_DISPLAY_MODE). The ids are kept in a cache
// because this worker's memory does not survive between events.
const CLIENT_STATE_CACHE = "raft-client-state-v1";
const STANDALONE_CLIENTS_KEY = "/__raft/standalone-clients";
// The last pushsubscriptionchange, for the next page to report (the worker has
// no bearer token): src/notifications/webPushLifecycle.ts reads and clears it.
const PUSH_SUBSCRIPTION_CHANGE_KEY = "/__raft/push-subscription-change";

async function readStandaloneClientIds() {
  try {
    const cache = await caches.open(CLIENT_STATE_CACHE);
    const response = await cache.match(STANDALONE_CLIENTS_KEY);
    const ids = response ? await response.json() : [];
    return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

async function rememberClientDisplayMode(clientId, standalone) {
  const liveClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const liveIds = new Set(liveClients.map((client) => client.id));
  const ids = new Set((await readStandaloneClientIds()).filter((id) => liveIds.has(id)));
  if (standalone) ids.add(clientId);
  else ids.delete(clientId);
  const cache = await caches.open(CLIENT_STATE_CACHE);
  await cache.put(
    STANDALONE_CLIENTS_KEY,
    new Response(JSON.stringify([...ids]), { headers: { "Content-Type": "application/json" } }),
  );
}

// Read on another device (socket notification:retract, forwarded by a page
// without a registration of its own; retractConsumer.ts closes them directly
// otherwise): close this conversation's notifications up to throughSeq (null:
// all of them). The tag is the groupKey, so only the group is listed.
async function retractNotifications(groupKey, throughSeq) {
  const notifications = await self.registration.getNotifications({ tag: groupKey });
  for (const notification of notifications) {
    const data = notification.data || {};
    if (data.groupKey !== groupKey) continue;
    if (throughSeq !== null && !(typeof data.seq === "number" && data.seq <= throughSeq)) continue;
    notification.close();
  }
}

// The one "message" listener: every page -> worker message is told apart here.
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "raft:display-locale") {
    handleDisplayLocaleMessage(event, data);
    return;
  }
  if (data.type === "RAFT_CLIENT_DISPLAY_MODE") {
    const clientId = event.source && event.source.id;
    if (typeof clientId !== "string") return;
    event.waitUntil(rememberClientDisplayMode(clientId, data.standalone === true).catch(() => {}));
    return;
  }
  if (data.type === "RAFT_NOTIFICATION_RETRACT") {
    if (typeof data.groupKey !== "string" || !data.groupKey) return;
    const throughSeq = typeof data.throughSeq === "number" ? data.throughSeq : null;
    event.waitUntil(retractNotifications(data.groupKey, throughSeq).catch(() => {}));
  }
});

// The push service rotated or dropped the subscription: subscribe again with
// the same key, and leave the old endpoint for the next page to report
// (POST /push/subscribe {oldEndpoint}); an open page is told now.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const oldSubscription = event.oldSubscription || null;
      const oldEndpoint = (oldSubscription && oldSubscription.endpoint) || null;
      let subscription = event.newSubscription || null;
      if (!subscription) {
        const applicationServerKey = oldSubscription && oldSubscription.options && oldSubscription.options.applicationServerKey;
        if (applicationServerKey) {
          subscription = await self.registration.pushManager
            .subscribe({ userVisibleOnly: true, applicationServerKey })
            .catch(() => null);
        }
      }
      const cache = await caches.open(CLIENT_STATE_CACHE);
      await cache.put(
        PUSH_SUBSCRIPTION_CHANGE_KEY,
        new Response(
          JSON.stringify({ oldEndpoint, endpoint: (subscription && subscription.endpoint) || null, at: Date.now() }),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clients) client.postMessage({ type: "RAFT_PUSH_SUBSCRIPTION_CHANGED", oldEndpoint });
    })().catch(() => {}),
  );
});

// A Raft page: same origin, and a path the app's HTML answers.
function appClientPathname(clientUrl) {
  try {
    const url = new URL(clientUrl);
    if (url.origin !== self.location.origin) return null;
    if (NOT_APP_PAGE.test(url.pathname) || FILE_PATH.test(url.pathname)) return null;
    return url.pathname;
  } catch {
    return null;
  }
}

function serverSlugOf(pathname) {
  const match = /^\/s\/([^/]+)(?:\/|$)/.exec(pathname || "");
  return match ? match[1] : null;
}

// The installed-app window first, then the focused one, then any.
function preferredClient(candidates, standaloneIds) {
  return candidates.find((client) => standaloneIds.has(client.id))
    || candidates.find((client) => client.focused)
    || candidates[0]
    || null;
}

// Like Slack, Discord and Gmail on the web: a click reuses a Raft window and
// routes it in-app (RAFT_PUSH_NOTIFICATION_NAVIGATE, no reload). In order:
// the window already on the target; a window on the target's server; any
// Raft window; a new window only when there is none.
async function notificationClickClient(clients, targetUrl) {
  const exact = clients.find((client) => isSameNotificationTarget(client.url, targetUrl));
  if (exact) return exact;
  let target;
  try {
    target = new URL(targetUrl, self.location.origin);
  } catch {
    return null;
  }
  // Somewhere else than this app: a window of its own.
  if (target.origin !== self.location.origin) return null;
  const raftClients = clients.filter((client) => appClientPathname(client.url) !== null);
  if (raftClients.length === 0) return null;
  const standaloneIds = new Set(await readStandaloneClientIds());
  const targetSlug = serverSlugOf(target.pathname);
  const onServer = targetSlug
    ? raftClients.filter((client) => serverSlugOf(appClientPathname(client.url)) === targetSlug)
    : [];
  return preferredClient(onServer, standaloneIds) || preferredClient(raftClients, standaloneIds);
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = event.notification?.data?.url || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      const client = await notificationClickClient(clients, targetUrl);
      if (client) {
        client.postMessage({ type: "RAFT_PUSH_NOTIFICATION_NAVIGATE", url: targetUrl });
        await client.focus();
        return;
      }
      await self.clients.openWindow(targetUrl);
    }),
  );
});
