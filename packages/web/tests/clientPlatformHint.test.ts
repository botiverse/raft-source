import assert from "node:assert/strict";

import { clientPlatformHint } from "../src/utils/clientPlatformHint";

// xxchan, 2026-10-22 (task #13): what the web says about itself on API
// requests (X-Raft-Client-Platform), so a signup records where it came from.
function withWindow<T>(value: unknown, run: () => T): T {
  const had = "window" in globalThis;
  const original = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = value;
  try {
    return run();
  } finally {
    if (had) (globalThis as { window?: unknown }).window = original;
    else delete (globalThis as { window?: unknown }).window;
  }
}

test("clientPlatformHint: the desktop app, the installed web app, or a browser tab", () => {
  assert.equal(withWindow(undefined, () => clientPlatformHint()), "browser", "no window: a browser");
  assert.equal(withWindow({ raftDesktop: { isDesktop: true }, navigator: {} }, () => clientPlatformHint()), "desktop_app");
  assert.equal(withWindow({ navigator: { standalone: true } }, () => clientPlatformHint()), "pwa", "iOS home-screen app");
  assert.equal(
    withWindow({ navigator: {}, matchMedia: (query: string) => ({ matches: query === "(display-mode: standalone)" }) }, () => clientPlatformHint()),
    "pwa",
    "installed on Android or a computer",
  );
  assert.equal(
    withWindow({ navigator: {}, matchMedia: (query: string) => ({ matches: query === "(display-mode: window-controls-overlay)" }) }, () => clientPlatformHint()),
    "pwa",
    "installed on a computer, its title bar the app's own (Window Controls Overlay)",
  );
  assert.equal(withWindow({ navigator: {}, matchMedia: () => ({ matches: false }) }, () => clientPlatformHint()), "browser");
});

// Task #15 in #proj-analytics: every API request names this web build's
// version (in the desktop app, its bundled build carries the desktop release's
// version), so the server's request trace can split by version.
test("clientRequestHeaders: the platform and this web build's version, in every shell", async () => {
  const { clientRequestHeaders } = await import("../src/utils/clientPlatformHint");
  const { WEB_APP_VERSION } = await import("../src/utils/webAppVersion");
  assert.ok(WEB_APP_VERSION, "a web build always has a version");
  assert.deepEqual(withWindow({ navigator: {}, matchMedia: () => ({ matches: false }) }, () => clientRequestHeaders()), {
    "X-Raft-Client-Platform": "browser",
    "X-Raft-Client-Version": WEB_APP_VERSION,
  });
  assert.deepEqual(withWindow({ raftDesktop: { isDesktop: true }, navigator: {} }, () => clientRequestHeaders()), {
    "X-Raft-Client-Platform": "desktop_app",
    "X-Raft-Client-Version": WEB_APP_VERSION,
  });
});

test("the shared API client and the token refresh both send the client headers", async () => {
  const axios = (await import("axios")).default;
  const { default: api } = await import("../src/api/client");
  const { refreshTokensWithDedupe } = await import("../src/utils/refreshCoordinator");
  const seen: Array<{ url: string; platform: unknown; version: unknown }> = [];
  const adapter = async (config: { url?: string; headers: Record<string, unknown> } & Record<string, unknown>) => {
    const headers = config.headers as { get?: (name: string) => unknown } & Record<string, unknown>;
    const read = (name: string) => (typeof headers.get === "function" ? headers.get(name) : headers[name]);
    seen.push({ url: String(config.url), platform: read("X-Raft-Client-Platform"), version: read("X-Raft-Client-Version") });
    const data = String(config.url).endsWith("/auth/refresh") ? { accessToken: "a2", refreshToken: "r2" } : {};
    return { data, status: 200, statusText: "OK", headers: {}, config };
  };
  const store = new Map<string, string>([["slock_refresh_token", "r1"]]);
  const hadStorage = "localStorage" in globalThis;
  const originalStorage = (globalThis as { localStorage?: unknown }).localStorage;
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  const originalAdapter = axios.defaults.adapter;
  axios.defaults.adapter = adapter as never;
  try {
    await api.get("/servers", { adapter: adapter as never });
    await refreshTokensWithDedupe();
  } finally {
    axios.defaults.adapter = originalAdapter;
    if (hadStorage) (globalThis as { localStorage?: unknown }).localStorage = originalStorage;
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
  assert.equal(seen.length, 2);
  for (const request of seen) {
    assert.equal(request.platform, "browser", request.url);
    assert.ok(typeof request.version === "string" && request.version.length > 0, request.url);
  }
  assert.ok(seen[1]!.url.endsWith("/auth/refresh"));
});
