import assert from "node:assert/strict";
import {
  OFFLINE_BUNDLE_GLOBAL,
  OfflineBundleStartError,
  __resetOfflineBundleHostForTests,
  assertOfflineBundleStart,
  getOfflineBundleHost,
  mayUseServiceWorker,
  offlineBundleReadyMessage,
  parseOfflineBundleHost,
} from "../src/utils/offlineBundleHost";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { isTestPath } from "../scripts/testLocations";
import { registerPushServiceWorker } from "../src/utils/pushNotifications";
import { cleanBrowserStateForRecovery, refreshServiceWorkerForRecovery } from "../src/utils/serviceWorkerRecovery";

const injected = (value: unknown) => ({ [OFFLINE_BUNDLE_GLOBAL]: value });
const valid = { protocol: 1, bundleId: "1.17.5-abc-def", pageSessionId: "session-7" };

test("a page with no host injection is an ordinary page", () => {
  assert.deepEqual(parseOfflineBundleHost({}), { kind: "none" });
  assert.deepEqual(parseOfflineBundleHost(null), { kind: "none" });
  assert.equal(mayUseServiceWorker({ kind: "none" }), true);
  assert.equal(offlineBundleReadyMessage({ kind: "none" }), null);
  assert.doesNotThrow(() => assertOfflineBundleStart({ kind: "none" }));
});

test("a valid frozen injection is an offline load bound to its bundle and page session", () => {
  const host = parseOfflineBundleHost(injected(Object.freeze({ ...valid })));
  assert.deepEqual(host, { kind: "offline", bundleId: "1.17.5-abc-def", pageSessionId: "session-7" });
  assert.equal(mayUseServiceWorker(host), false);
  assert.deepEqual(offlineBundleReadyMessage(host), {
    name: "raft.offlineBundle.ready",
    payload: { protocol: 1, bundleId: "1.17.5-abc-def", pageSessionId: "session-7" },
  });
  assert.doesNotThrow(() => assertOfflineBundleStart(host));
});

test("a present but malformed injection is a failed offline start, never an ordinary page", () => {
  const cases: Array<[unknown, string]> = [
    [undefined, "not-an-object"],
    [null, "not-an-object"],
    ["1", "not-an-object"],
    [[valid], "not-an-object"],
    [{ ...valid, protocol: 2 }, "unsupported-protocol"],
    [{ ...valid, protocol: "1" }, "unsupported-protocol"],
    [{ bundleId: "b", pageSessionId: "s" }, "unsupported-protocol"],
    [{ ...valid, bundleId: "" }, "missing-identity"],
    [{ ...valid, pageSessionId: "   " }, "missing-identity"],
    [{ protocol: 1, bundleId: "b" }, "missing-identity"],
  ];
  for (const [value, reason] of cases) {
    const host = parseOfflineBundleHost(injected(value));
    assert.deepEqual(host, { kind: "invalid", reason }, JSON.stringify(value));
    assert.equal(mayUseServiceWorker(host), false, "a failed start must not register a worker");
    assert.equal(offlineBundleReadyMessage(host), null, "a failed start must not report ready");
    assert.throws(() => assertOfflineBundleStart(host), OfflineBundleStartError);
  }
});

function withBrowserGlobals(hostValue: { present: boolean; value?: unknown }, run: (registered: string[]) => Promise<void>) {
  const globals = globalThis as Record<string, unknown>;
  const hadWindow = "window" in globals;
  const previousWindow = globals.window;
  const windowLike: Record<string, unknown> = {};
  if (hostValue.present) windowLike[OFFLINE_BUNDLE_GLOBAL] = hostValue.value;
  globals.window = windowLike;
  windowLike.location = { origin: "https://app.raft.build" };
  // Caches as an ordinary web app on this origin would have left them.
  const cacheKeys = new Set(["slock-assets-old", "slock-assets-v2", "raft-client-state-v1"]);
  windowLike.caches = {
    keys: async () => [...cacheKeys],
    delete: async (key: string) => {
      registered.push(`cache-delete:${key}`);
      return cacheKeys.delete(key);
    },
  };
  const registered: string[] = [];
  const previousServiceWorker = Object.getOwnPropertyDescriptor(globalThis.navigator, "serviceWorker");
  Object.defineProperty(globalThis.navigator, "serviceWorker", {
    configurable: true,
    value: {
      register: async (path: string) => {
        registered.push(path);
        return { update: async () => undefined };
      },
      // One worker left over from before the host started serving a bundle.
      getRegistrations: async () => [
        { scope: "https://app.raft.build/", update: async () => { registered.push("update:existing"); } },
      ],
    },
  });
  __resetOfflineBundleHostForTests();
  return run(registered).finally(() => {
    if (previousServiceWorker) Object.defineProperty(globalThis.navigator, "serviceWorker", previousServiceWorker);
    else delete (globalThis.navigator as unknown as Record<string, unknown>).serviceWorker;
    if (hadWindow) globals.window = previousWindow;
    else delete globals.window;
    __resetOfflineBundleHostForTests();
  });
}

test("the service worker is registered on an ordinary page and not on an offline or failed-start page", async () => {
  await withBrowserGlobals({ present: false }, async (registered) => {
    assert.deepEqual(getOfflineBundleHost(), { kind: "none" });
    assert.notEqual(await registerPushServiceWorker(), null);
    assert.deepEqual(registered, ["/sw.js"]);
  });
  await withBrowserGlobals({ present: true, value: Object.freeze({ ...valid }) }, async (registered) => {
    assert.equal(getOfflineBundleHost().kind, "offline");
    assert.equal(await registerPushServiceWorker(), null);
    assert.deepEqual(registered, []);
  });
  await withBrowserGlobals({ present: true, value: { protocol: 9 } }, async (registered) => {
    assert.equal(getOfflineBundleHost().kind, "invalid");
    assert.equal(await registerPushServiceWorker(), null);
    assert.deepEqual(registered, []);
  });
});

test("the load mode is read once and does not change for the life of the document", async () => {
  await withBrowserGlobals({ present: false }, async () => {
    assert.deepEqual(getOfflineBundleHost(), { kind: "none" });
    (globalThis as unknown as { window: Record<string, unknown> }).window[OFFLINE_BUNDLE_GLOBAL] = { ...valid };
    assert.deepEqual(getOfflineBundleHost(), { kind: "none" }, "a late write cannot switch the page into offline mode");
  });
});

test("clear-cache recovery refreshes and re-registers the worker on an ordinary page only", async () => {
  await withBrowserGlobals({ present: false }, async (registered) => {
    assert.deepEqual(await refreshServiceWorkerForRecovery(), { serviceWorkerCount: 1, failureCount: 0 });
    assert.deepEqual(registered.sort(), ["/sw.js", "update:existing"]);
  });
  await withBrowserGlobals({ present: true, value: Object.freeze({ ...valid }) }, async (registered) => {
    assert.deepEqual(await refreshServiceWorkerForRecovery(), { serviceWorkerCount: 0, failureCount: 0 });
    assert.deepEqual(registered, [], "recovery must not put a worker back over the bundle, nor touch an existing one");
  });
  await withBrowserGlobals({ present: true, value: { protocol: 9 } }, async (registered) => {
    assert.deepEqual(await refreshServiceWorkerForRecovery(), { serviceWorkerCount: 0, failureCount: 0 });
    assert.deepEqual(registered, []);
  });
});

test("every service worker registration in the web source goes through an offline-bundle gate", () => {
  // An entry point that registers directly would bypass the gate without failing any test above.
  const srcRoot = join(import.meta.dirname, "..", "src");
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
  const registering = walk(srcRoot)
    .filter((path) => /serviceWorker\s*\.\s*register\s*\(/.test(readFileSync(path, "utf8")))
    .map((path) => relative(srcRoot, path))
    // Feature tests (src/features/<feature>/tests/) are not app code.
    .filter((path) => !isTestPath(`src/${path}`))
    .sort();
  assert.deepEqual(registering, ["utils/pushNotifications.ts", "utils/serviceWorkerRecovery.ts"]);
  for (const file of registering) {
    assert.match(readFileSync(join(srcRoot, file), "utf8"), /mayUseServiceWorker\(\)/, `${file} registers without the gate`);
  }
});

test("clear-cache recovery deletes the web app's asset caches on an ordinary page and nothing in offline mode", async () => {
  await withBrowserGlobals({ present: false }, async (touched) => {
    assert.deepEqual(await cleanBrowserStateForRecovery(), { serviceWorkerCount: 1, assetCacheCount: 2, failureCount: 0 });
    assert.deepEqual(touched.sort(), ["/sw.js", "cache-delete:slock-assets-old", "cache-delete:slock-assets-v2", "update:existing"]);
  });
  for (const value of [Object.freeze({ ...valid }), { protocol: 9 }]) {
    await withBrowserGlobals({ present: true, value }, async (touched) => {
      assert.deepEqual(await cleanBrowserStateForRecovery(), { serviceWorkerCount: 0, assetCacheCount: 0, failureCount: 0 });
      assert.deepEqual(touched, [], "an offline or failed-start page leaves the origin's workers and caches alone");
    });
  }
});
