/** public/sw.js: the app's HTML kept by the service worker (boot-shell.md, "Kept by the service worker"). */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const ORIGIN = "https://raft.example";
// The tag forms a production build writes (vite + bootShellPlugin.injectBootScript):
// the entry script, its modulepreloads, and the stylesheet moved behind the content.
const HTML = (assets: string[], urgent = false) => {
  const [entry, ...rest] = assets.filter((path) => path.endsWith(".js"));
  const css = assets.filter((path) => path.endsWith(".css"));
  return `<!doctype html><html><head>${urgent ? '<meta name="raft-shell" content="urgent">' : ""}`
    + (entry ? `<script type="module" crossorigin src="${entry}"></script>` : "")
    + rest.map((path) => `<link rel="modulepreload" crossorigin href="${path}">`).join("")
    + `</head><body><div id="root"><div data-boot-shell="" class="contents"></div></div>${css.map((path) => `<link rel="stylesheet" crossorigin href="${path}">`).join("")}</body></html>`;
};

function htmlResponse(body: string) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "script-src 'self'", "content-encoding": "br" },
  });
}

async function harness(network: Record<string, () => Response>, now = { value: 1_000_000 }) {
  const listeners = new Map<string, (event: unknown) => void>();
  const stores = new Map<string, Map<string, Response>>();
  const fetched: string[] = [];
  const messages: unknown[] = [];
  // Paths whose cache.put fails (a full or broken store).
  const failingPuts = new Set<string>();
  const cacheOf = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    const key = (request: Request | string) => new URL(typeof request === "string" ? request : request.url, ORIGIN).href;
    return {
      match: async (request: Request | string) => store.get(key(request))?.clone(),
      put: async (request: Request | string, response: Response) => {
        if (failingPuts.has(new URL(key(request)).pathname)) throw new DOMException("quota", "QuotaExceededError");
        store.set(key(request), response.clone());
      },
      delete: async (request: Request | string) => store.delete(key(request)),
      keys: async () => [...store.keys()].map((url) => new Request(url)),
    };
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined, matchAll: async () => [], openWindow: async () => undefined, get: async () => ({ postMessage: (message: unknown) => messages.push(message) }) },
    registration: { showNotification: async () => undefined },
  };
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  vm.runInNewContext(source, {
    URL, Request, Response, Headers, self,
    Date: { now: () => now.value },
    caches: { open: async (name: string) => cacheOf(name), keys: async () => [...stores.keys()], delete: async (name: string) => stores.delete(name) },
    fetch: async (input: Request | string) => {
      const url = new URL(typeof input === "string" ? input : input.url, ORIGIN);
      fetched.push(url.pathname);
      const respond = network[url.pathname] ?? network["*"];
      if (!respond) throw new TypeError("offline");
      return respond();
    },
  });

  async function navigate(path: string) {
    const waits: Promise<unknown>[] = [];
    let response: Promise<Response> | undefined;
    const request = { url: `${ORIGIN}${path}`, method: "GET", mode: "navigate" };
    listeners.get("fetch")!({ request, resultingClientId: "client-1", respondWith: (promise: Promise<Response>) => (response = promise), waitUntil: (promise: Promise<unknown>) => waits.push(promise) });
    const result = response ? await response : undefined;
    await Promise.all(waits);
    // waitUntil may be called while the first wait runs.
    await Promise.all(waits);
    return result;
  }
  /** The page telling the worker its display locale (i18n/serviceWorkerLocale.ts). */
  async function tell(locale: string) {
    const waits: Promise<unknown>[] = [];
    listeners.get("message")!({ data: { type: "raft:display-locale", locale }, waitUntil: (promise: Promise<unknown>) => waits.push(promise) });
    await Promise.all(waits);
  }
  return { navigate, tell, fetched, messages, stores, now, failingPuts };
}

const asset = (body: string, type = "application/javascript") => () => new Response(body, { status: 200, headers: { "content-type": type } });

test("the first open goes to the network and keeps the HTML once its files are cached; the next open is served from it", async () => {
  const v1 = HTML(["/assets/index-AAAA.js", "/assets/vendor-react-DDDD.js", "/assets/app-shell-BBBB.css"]);
  const h = await harness({
    "/s/dev/channel/c1": () => htmlResponse(v1),
    "/assets/index-AAAA.js": asset("js"),
    "/assets/vendor-react-DDDD.js": asset("js"),
    "/assets/app-shell-BBBB.css": asset("css", "text/css"),
  });
  const first = await h.navigate("/s/dev/channel/c1");
  assert.equal(await first!.text(), v1);
  assert.deepEqual(h.fetched, ["/s/dev/channel/c1", "/assets/index-AAAA.js", "/assets/vendor-react-DDDD.js", "/assets/app-shell-BBBB.css"]);

  h.fetched.length = 0;
  const second = await h.navigate("/s/dev/channel/c2");
  assert.equal(await second!.text(), v1, "served from the kept copy");
  assert.equal(second!.headers.get("content-security-policy"), "script-src 'self'", "its CSP comes with it");
  assert.equal(second!.headers.get("content-encoding"), null, "the body is kept decoded");
  // Revalidated in the background.
  assert.deepEqual(h.fetched, ["/s/dev/channel/c2"]);
});

test("keeping a new release drops the older release's files from the asset cache; the same release again drops nothing", async () => {
  let html = HTML(["/assets/index-AAAA.js", "/assets/app-shell-BBBB.css"]);
  const h = await harness({
    "*": () => htmlResponse(html),
    "/assets/index-AAAA.js": asset("a"),
    "/assets/app-shell-BBBB.css": asset("css", "text/css"),
    "/assets/index-CCCC.js": asset("c"),
  });
  await h.navigate("/");
  // A route the old release loaded on demand.
  await h.stores.get("slock-assets-v2")!.set(`${ORIGIN}/assets/route-OLD1.js`, new Response("old route"));
  const cached = () => [...h.stores.get("slock-assets-v2")!.keys()].map((url) => new URL(url).pathname).sort();

  await h.navigate("/");
  assert.deepEqual(cached(), ["/assets/app-shell-BBBB.css", "/assets/index-AAAA.js", "/assets/route-OLD1.js"], "the same release: nothing dropped");

  html = HTML(["/assets/index-CCCC.js", "/assets/app-shell-BBBB.css"]);
  await h.navigate("/");
  assert.deepEqual(cached(), ["/assets/app-shell-BBBB.css", "/assets/index-CCCC.js"], "only the new release's first-paint files stay; an unchanged file is kept");
});

test("a new release is kept for the next open, with its files fetched first", async () => {
  let html = HTML(["/assets/index-AAAA.js"]);
  const h = await harness({ "*": () => htmlResponse(html), "/assets/index-AAAA.js": asset("a"), "/assets/index-CCCC.js": asset("c") });
  await h.navigate("/");
  html = HTML(["/assets/index-CCCC.js"]);
  const stale = await h.navigate("/");
  assert.match(await stale!.text(), /index-AAAA/, "this open still runs the kept release");
  assert.ok(h.fetched.includes("/assets/index-CCCC.js"), "the new release's files are cached before its HTML is kept");
  assert.deepEqual(JSON.parse(JSON.stringify(h.messages)), [{ type: "raft:shell-superseded" }], "the page running the older release is told");
  const next = await h.navigate("/");
  assert.match(await next!.text(), /index-CCCC/);
  assert.equal(h.messages.length, 1, "the same release again is not news");
});

test("a new release the network delivers but this browser can't store retires the older copy, so the next open runs the new release from the network; the page is told the step (#triage:#165)", async () => {
  let html = HTML(["/assets/index-AAAA.js"]);
  const h = await harness({ "*": () => htmlResponse(html), "/assets/index-AAAA.js": asset("a"), "/assets/index-CCCC.js": asset("c") });
  await h.navigate("/");
  html = HTML(["/assets/index-CCCC.js"]);
  h.failingPuts.add("/assets/index-CCCC.js");
  const stale = await h.navigate("/");
  assert.match(await stale!.text(), /index-AAAA/, "this open still runs the kept release");
  assert.deepEqual(JSON.parse(JSON.stringify(h.messages)), [{ type: "raft:shell-keep-failed", step: "asset_store", servedKept: true }]);

  const next = await h.navigate("/");
  assert.match(await next!.text(), /index-CCCC/, "network first: the older copy is no longer opened from");
  assert.deepEqual(JSON.parse(JSON.stringify(h.messages[1])), { type: "raft:shell-keep-failed", step: "asset_store", servedKept: false });

  h.failingPuts.clear();
  await h.navigate("/");
  h.fetched.length = 0;
  const kept = await h.navigate("/");
  assert.match(await kept!.text(), /index-CCCC/);
  assert.deepEqual(h.fetched, ["/"], "kept again once keeping works: served from the copy, revalidated in the background");
});

test("a new release whose files the network can't deliver keeps the older copy, which still works; the page is told the step", async () => {
  let html = HTML(["/assets/index-AAAA.js"]);
  let newFiles: () => Response = () => new Response("gone", { status: 404 });
  const h = await harness({ "*": () => htmlResponse(html), "/assets/index-AAAA.js": asset("a"), "/assets/index-CCCC.js": () => newFiles() });
  await h.navigate("/");
  html = HTML(["/assets/index-CCCC.js"]);
  await h.navigate("/");
  newFiles = () => { throw new TypeError("connection reset"); };
  const again = await h.navigate("/");
  assert.match(await again!.text(), /index-AAAA/, "a page from the network would fail on the same files: the older copy stays");
  assert.deepEqual(JSON.parse(JSON.stringify(h.messages)), [
    { type: "raft:shell-keep-failed", step: "asset_response", servedKept: true },
    { type: "raft:shell-keep-failed", step: "asset_fetch", servedKept: true },
  ]);
});

test("a retired copy is still the offline fallback; the same release again is not retired", async () => {
  let html = HTML(["/assets/index-AAAA.js"]);
  let online = true;
  const h = await harness({
    "*": () => { if (!online) throw new TypeError("offline"); return htmlResponse(html); },
    "/assets/index-AAAA.js": asset("a"),
    "/assets/index-CCCC.js": asset("c"),
  });
  await h.navigate("/");
  html = HTML(["/assets/index-CCCC.js"]);
  h.failingPuts.add("/assets/index-CCCC.js");
  await h.navigate("/");
  online = false;
  const offline = await h.navigate("/");
  assert.match(await offline!.text(), /index-AAAA/, "offline, the older release still opens");

  // The same release again: its files are cached, a failure to store the HTML has nothing to escape from.
  online = true;
  h.failingPuts.clear();
  html = HTML(["/assets/index-AAAA.js"]);
  await h.navigate("/");
  h.failingPuts.add("/");
  h.fetched.length = 0;
  await h.navigate("/");
  assert.deepEqual(h.fetched, ["/"], "served from the kept copy, revalidated in the background");
  h.fetched.length = 0;
  await h.navigate("/");
  assert.deepEqual(h.fetched, ["/"], "still served from it: not retired");
});

test("offline, the kept copy is served and stays: an HTML fetch that fails is not a release that can't be kept", async () => {
  let online = true;
  const h = await harness({ "*": () => { if (!online) throw new TypeError("offline"); return htmlResponse(HTML(["/assets/index-AAAA.js"])); }, "/assets/index-AAAA.js": asset("a") });
  await h.navigate("/");
  online = false;
  const offline = await h.navigate("/");
  assert.match(await offline!.text(), /index-AAAA/);
  assert.deepEqual(h.messages, []);
  assert.equal(h.stores.get("slock-shell-v1")?.size, 1, "the copy stays");
});

test("an Artifact page visit doesn't replace the kept shell", async () => {
  // The Pages Worker rewrites a public Artifact's page (its title, preview tags, a hidden article) and marks it.
  const shell = HTML(["/assets/index-AAAA.js"]);
  const artifactPage = shell.replace("<head>", "<head><title>Q3 report | Raft</title>").replace('<div id="root">', '<div id="root"><article data-raft-artifact-preview>Q3</article>');
  const artifact = () => {
    const response = htmlResponse(artifactPage);
    response.headers.set("x-raft-artifact-preview", "1");
    return response;
  };
  const h = await harness({ "/artifacts/pt_1": artifact, "*": () => htmlResponse(shell), "/assets/index-AAAA.js": asset("a") });
  // First open on an Artifact page: the network's page is shown, nothing kept.
  const first = await h.navigate("/artifacts/pt_1");
  assert.equal(await first!.text(), artifactPage);
  assert.equal(h.stores.get("slock-shell-v1")?.size ?? 0, 0, "the rewritten page is not kept");
  // The plain shell is kept from another page.
  await h.navigate("/s/dev/channel/c1");
  // An Artifact visit served from the kept shell revalidates against the rewritten page: no superseded, the shell stays.
  const again = await h.navigate("/artifacts/pt_1");
  assert.equal(await again!.text(), shell, "served from the kept shell");
  assert.deepEqual(h.messages, [], "no false raft:shell-superseded");
  const next = await h.navigate("/s/dev/channel/c2");
  const kept = await next!.text();
  assert.equal(kept, shell);
  assert.ok(!kept.includes("Q3"), "no Artifact's title or article in the shell");
});

test("a kept copy whose files are gone from the cache, or that is too old, is not served", async () => {
  const h = await harness({ "*": () => htmlResponse(HTML(["/assets/index-AAAA.js"])), "/assets/index-AAAA.js": asset("a") });
  await h.navigate("/");
  h.stores.get("slock-assets-v2")!.clear();
  h.fetched.length = 0;
  await h.navigate("/");
  assert.equal(h.fetched[0], "/", "network first when an asset is missing");

  h.now.value += 8 * 24 * 60 * 60 * 1000;
  h.fetched.length = 0;
  await h.navigate("/");
  assert.equal(h.fetched[0], "/", "network first when the copy is older than a week");
});

test("an urgent release drops the kept copy and tells the page that just opened", async () => {
  let html = HTML(["/assets/index-AAAA.js"]);
  const h = await harness({ "*": () => htmlResponse(html), "/assets/index-AAAA.js": asset("a") });
  await h.navigate("/");
  html = HTML(["/assets/index-AAAA.js"], true);
  await h.navigate("/");
  assert.deepEqual(JSON.parse(JSON.stringify(h.messages)), [{ type: "raft:shell-urgent" }]);
  h.fetched.length = 0;
  await h.navigate("/");
  assert.equal(h.fetched[0], "/", "the next open goes to the network");
});

test("the server's own pages, built files and file paths are never answered with the HTML", async () => {
  const h = await harness({ "*": () => htmlResponse(HTML([])) });
  for (const path of [
    "/api/auth/google/callback",
    "/internal/x",
    "/oidc/acme/api/oauth/authorize",
    "/share/abc",
    "/health",
    "/livez",
    "/.well-known/change-password",
    "/feedback/",
    "/robots.txt",
    "/socket.io/",
  ]) {
    assert.equal(await h.navigate(path), undefined, path);
  }
});

test("every top-level path the server routes is one the worker leaves to the network", async () => {
  const { readdir } = await import("node:fs/promises");
  const serverSrc = new URL("../../server/src/", import.meta.url);
  const files = (await readdir(serverSrc, { recursive: true })).filter((file) => /\.ts$/.test(file) && !/\.test\.ts$/.test(file));
  const sw = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  const notAppPage = new RegExp(/const NOT_APP_PAGE = \/(.+)\/;/.exec(sw)![1]);
  const prefixes = new Set<string>();
  for (const file of files) {
    const code = await readFile(new URL(file, serverSrc), "utf8");
    // app.get("/x...") and app.use(["/x", "/y"], ...): the first segment of each path.
    for (const match of code.matchAll(/\bapp\.(?:get|use|all|post|route)\(\s*(\[[^\]]*\]|["'`]\/[^"'`]*["'`])/g)) {
      for (const path of match[1].matchAll(/["'`](\/[^"'`/]*)/g)) prefixes.add(path[1]);
    }
  }
  assert.ok(prefixes.has("/api") && prefixes.has("/oidc") && prefixes.has("/metrics"), [...prefixes].join(", "));
  for (const prefix of prefixes) {
    if (prefix === "/" || /\.[a-z]+$/.test(prefix)) continue;
    assert.ok(notAppPage.test(prefix), `${prefix} is a server route the worker would answer with the app's HTML`);
  }
});

test("a 200 HTML page that is not our app (maintenance, CDN challenge, captive portal) is never kept", async () => {
  let html = "<!doctype html><html><head><title>Down for maintenance</title></head><body>Back soon</body></html>";
  const h = await harness({ "*": () => htmlResponse(html), "/assets/index-AAAA.js": asset("a") });
  await h.navigate("/");
  // Ours, but with no entry script either.
  html = '<!doctype html><html><body><div id="root"><div data-boot-shell=""></div></div></body></html>';
  await h.navigate("/");
  h.fetched.length = 0;
  await h.navigate("/");
  assert.equal(h.fetched[0], "/", "still the network: nothing was kept");
  assert.equal(h.stores.get("slock-shell-v1")?.size ?? 0, 0);
});

test("offline, the kept copy answers even when it is old", async () => {
  let online = true;
  const h = await harness({
    "*": () => {
      if (!online) throw new TypeError("offline");
      return htmlResponse(HTML(["/assets/index-AAAA.js"]));
    },
    "/assets/index-AAAA.js": asset("a"),
  });
  await h.navigate("/");
  online = false;
  h.now.value += 30 * 24 * 60 * 60 * 1000;
  const response = await h.navigate("/");
  assert.match(await response!.text(), /index-AAAA/);
});


// A release's catalog chunks are named only in its JSON map (bootShellPlugin), not as src/href.
const WITH_CATALOGS = (assets: string[], catalogs: Record<string, string>) =>
  HTML(assets).replace("<head>", `<head><script type="application/json" id="raft-locale-catalogs">${JSON.stringify(catalogs)}</script>`);
const CATALOGS_N = { en: "/assets/en-N1111111.js", ja: "/assets/ja-N1111111.js", "zh-cn": "/assets/zh-cn-N1111111.js" };
const CATALOGS_N1 = { en: "/assets/en-N2222222.js", ja: "/assets/ja-N2222222.js", "zh-cn": "/assets/zh-cn-N2222222.js" };

function offline(network: Record<string, () => Response>) {
  for (const key of Object.keys(network)) delete network[key];
}

test("a release is kept with the display locale's catalog; an update then an offline open runs it with its own catalog", async () => {
  let html = WITH_CATALOGS(["/assets/index-AAAA.js"], CATALOGS_N);
  const network: Record<string, () => Response> = {
    "*": () => htmlResponse(html),
    "/assets/index-AAAA.js": asset("a"),
    "/assets/index-CCCC.js": asset("c"),
    "/assets/zh-cn-N1111111.js": asset("zh n"),
    "/assets/zh-cn-N2222222.js": asset("zh n+1"),
    "/assets/en-N1111111.js": asset("en n"),
    "/assets/en-N2222222.js": asset("en n+1"),
  };
  const h = await harness(network);
  await h.tell("zh-cn");
  await h.navigate("/");
  assert.ok(h.fetched.includes("/assets/zh-cn-N1111111.js"), "release N kept with its zh-cn catalog");
  assert.ok(!h.fetched.some((path) => path.startsWith("/assets/en-")), "zh-cn is complete: no en");

  // N+1 ships (a changed en.ts and zh-cn): an online open runs kept N and keeps N+1 with N+1's catalog.
  html = WITH_CATALOGS(["/assets/index-CCCC.js"], CATALOGS_N1);
  const online = await h.navigate("/");
  assert.match(await online!.text(), /index-AAAA/);
  assert.ok(h.fetched.includes("/assets/zh-cn-N2222222.js"), "N+1's catalog cached before N+1 is kept");
  const cached = [...h.stores.get("slock-assets-v2")!.keys()].map((url) => new URL(url).pathname).sort();
  assert.deepEqual(cached, ["/assets/index-CCCC.js", "/assets/zh-cn-N2222222.js"], "N's files go; N+1's catalog stays beside its files");

  offline(network);
  const next = await h.navigate("/");
  assert.match(await next!.text(), /index-CCCC/, "offline, N+1 opens: its files and its catalog are all cached");
});

test("a partial locale keeps en beside its own catalog; never the other locales", async () => {
  const html = WITH_CATALOGS(["/assets/index-AAAA.js"], CATALOGS_N);
  const h = await harness({ "*": () => htmlResponse(html), "/assets/index-AAAA.js": asset("a"), "/assets/ja-N1111111.js": asset("ja"), "/assets/en-N1111111.js": asset("en"), "/assets/zh-cn-N1111111.js": asset("zh") });
  await h.tell("ja");
  await h.navigate("/");
  assert.deepEqual(h.fetched.filter((path) => /\/assets\/(en|ja|zh-cn)-/.test(path)).sort(), ["/assets/en-N1111111.js", "/assets/ja-N1111111.js"]);
});

test("a release whose catalogs ship in parts is kept with every part of each catalog the locale is shown from", async () => {
  const parts: Record<string, string> = {};
  for (const locale of ["en", "ja", "zh-cn"]) {
    parts[locale] = `/assets/${locale}-first-P1111111.js`;
    parts[`${locale}:boot`] = `/assets/${locale}-boot-P1111111.js`;
    parts[`${locale}:rest`] = `/assets/${locale}-rest-P1111111.js`;
  }
  const html = WITH_CATALOGS(["/assets/index-AAAA.js"], parts);
  const network: Record<string, () => Response> = { "*": () => htmlResponse(html), "/assets/index-AAAA.js": asset("a") };
  for (const path of Object.values(parts)) network[path] = asset(path);
  const h = await harness(network);
  await h.tell("ja");
  await h.navigate("/");
  assert.deepEqual(h.fetched.filter((path) => /\/assets\/(en|ja|zh-cn)-/.test(path)).sort(), [
    "/assets/en-boot-P1111111.js",
    "/assets/en-first-P1111111.js",
    "/assets/en-rest-P1111111.js",
    "/assets/ja-boot-P1111111.js",
    "/assets/ja-first-P1111111.js",
    "/assets/ja-rest-P1111111.js",
  ]);
  offline(network);
  assert.match(await (await h.navigate("/"))!.text(), /index-AAAA/, "offline: the kept release has every part it needs");
});

test("not knowing the display locale yet, a release with catalogs is kept with en's; once told, and on a switch, that locale's are cached", async () => {
  const html = WITH_CATALOGS(["/assets/index-AAAA.js"], CATALOGS_N);
  const network: Record<string, () => Response> = { "*": () => htmlResponse(html), "/assets/index-AAAA.js": asset("a"), "/assets/ja-N1111111.js": asset("ja"), "/assets/en-N1111111.js": asset("en"), "/assets/zh-cn-N1111111.js": asset("zh") };
  const h = await harness(network);
  await h.navigate("/");
  assert.ok(h.stores.get("slock-shell-v1")?.get(`${ORIGIN}/`), "kept with en's catalog");
  assert.deepEqual(h.fetched.filter((path) => /\/assets\/(en|ja|zh-cn)-/.test(path)), ["/assets/en-N1111111.js"]);

  // The reader switches to ja: the kept release's ja (and en) catalogs are cached at once.
  await h.tell("ja");
  assert.ok(h.fetched.includes("/assets/ja-N1111111.js"));
  offline(network);
  const next = await h.navigate("/");
  assert.match(await next!.text(), /index-AAAA/, "offline in ja: the kept release and both its catalogs are there");
});

test("upgrading from a release before the map: the old page never tells its locale, the new release is kept anyway", async () => {
  // Release N: no catalog map (en was in its app shell), so its page never sends raft:display-locale.
  let html = HTML(["/assets/index-AAAA.js"]);
  const network: Record<string, () => Response> = {
    "*": () => htmlResponse(html),
    "/assets/index-AAAA.js": asset("a"),
    "/assets/index-CCCC.js": asset("c"),
    "/assets/en-N2222222.js": asset("en n+1"),
    "/assets/zh-cn-N2222222.js": asset("zh n+1"),
  };
  const h = await harness(network);
  await h.navigate("/");
  assert.equal(await h.stores.get("slock-shell-v1")?.get(`${ORIGIN}/__raft/display-locale`), undefined, "no stored locale");

  // N+1 ships with the map: an online open runs kept N, keeps N+1 (with en's catalog) and says so.
  html = WITH_CATALOGS(["/assets/index-CCCC.js"], CATALOGS_N1);
  const online = await h.navigate("/");
  assert.match(await online!.text(), /index-AAAA/);
  assert.deepEqual(JSON.parse(JSON.stringify(h.messages)), [{ type: "raft:shell-superseded" }], "the page on N learns N+1 is kept");
  const next = await h.navigate("/");
  assert.match(await next!.text(), /index-CCCC/, "the next open runs N+1");

  // N+1 boots in zh-cn and tells the worker: its catalog is cached for the kept release.
  await h.tell("zh-cn");
  assert.ok(h.fetched.includes("/assets/zh-cn-N2222222.js"));
  offline(network);
  const offlineOpen = await h.navigate("/");
  assert.match(await offlineOpen!.text(), /index-CCCC/, "offline in zh-cn: N+1 with its zh-cn catalog");
});

test("a kept release whose display-locale catalog is gone from the cache is not served", async () => {
  const html = WITH_CATALOGS(["/assets/index-AAAA.js"], CATALOGS_N);
  const h = await harness({ "*": () => htmlResponse(html), "/assets/index-AAAA.js": asset("a"), "/assets/zh-cn-N1111111.js": asset("zh") });
  await h.tell("zh-cn");
  await h.navigate("/");
  h.stores.get("slock-assets-v2")!.delete(`${ORIGIN}/assets/zh-cn-N1111111.js`);
  h.fetched.length = 0;
  await h.navigate("/");
  assert.equal(h.fetched[0], "/", "network first: the kept copy would stall on its catalog");
});
