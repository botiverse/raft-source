import { test } from "node:test";
import assert from "node:assert/strict";

import {
  authStatusBucket,
  authBootBrowserBucketFromUserAgent,
  authBootLastSeenAgeBucket,
  authBootTokenPresenceBucket,
  buildAuthTraceRecord,
  emitAuthTrace,
  emitAuthTraceAndFlush,
  emitWebTraceAndFlushBeforeUnload,
  flushAuthTraces,
  readAuthBootInitTraceAttrs,
  setAuthTracePrincipalIdGetter,
  setAuthTraceServerIdGetter,
  setAuthTraceFetchForTest,
  __resetAuthTraceForTest,
} from "../src/utils/webAuthTrace";

test("authStatusBucket maps to the contract closed set", () => {
  assert.equal(authStatusBucket(401), "auth_401_403");
  assert.equal(authStatusBucket(403), "auth_401_403");
  assert.equal(authStatusBucket(500), "server_5xx");
  assert.equal(authStatusBucket(503), "server_5xx");
  assert.equal(authStatusBucket(undefined), "network_undefined");
  assert.equal(authStatusBucket(null), "network_undefined");
  assert.equal(authStatusBucket(400), "other");
  assert.equal(authStatusBucket(200), "other");
});

test("buildAuthTraceRecord produces a valid web-surface span with closed-set attrs", () => {
  const record = buildAuthTraceRecord("slock.auth.session_cleared", {
    clearSessionCaller: "logout",
    logoutTrigger: "restore_timeout",
    statusBucket: "network_undefined",
    authVerdict: undefined, // must be dropped, not serialized
  });

  assert.equal(record.type, "span");
  assert.equal(record.schema_version, 1);
  assert.equal(record.surface, "web");
  assert.equal(record.name, "slock.auth.session_cleared");
  assert.match(record.trace_id, /^[0-9a-f]{32}$/);
  assert.match(record.span_id, /^[0-9a-f]{16}$/);
  assert.equal(typeof record.start_time, "string");
  assert.equal(typeof record.end_time, "string");

  const attrs = record.attrs ?? {};
  assert.equal(attrs.clearSessionCaller, "logout");
  assert.equal(attrs.logoutTrigger, "restore_timeout");
  assert.equal(attrs.statusBucket, "network_undefined");
  // common attrs always present
  assert.ok(typeof attrs.tabId === "string" && (attrs.tabId as string).length > 0);
  assert.ok("releaseSha" in attrs);
  assert.ok("deploymentEnv" in attrs);
  assert.ok("appVersion" in attrs);
  assert.ok("webAssetId" in attrs);
  // undefined attrs are dropped, not serialized as undefined
  assert.equal("authVerdict" in attrs, false);
});

test("buildAuthTraceRecord includes the loaded web asset filename without a raw URL", () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const fakeScript = {
    src: "https://app.slock.ai/assets/index-DSoU2CKZ.js?cache=1",
    getAttribute: (name: string) => name === "src" ? "/assets/index-DSoU2CKZ.js?cache=1" : null,
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { scripts: [fakeScript] },
  });

  try {
    const record = buildAuthTraceRecord("slock.auth.verdict", { authVerdict: "logout" });
    assert.equal(record.attrs?.webAssetId, "index-DSoU2CKZ.js");
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("auth boot-init includes useful raw diagnostics without exposing raw tokens", () => {
  const record = buildAuthTraceRecord("slock.auth.boot_init", {
    routeFamily: "bootstrap",
    bootTokenPresence: "token_pair",
    bootStorageAccess: "readable_writable",
    bootBrowser: "safari",
    bootLastSeenAge: ">=7d",
    bootUserAgentRaw: "Mozilla/5.0 Version/17.0 Safari/605.1.15",
    bootLastSeenAgeMs: 691_200_000,
  });

  const attrs = record.attrs ?? {};
  assert.equal(record.name, "slock.auth.boot_init");
  assert.equal(attrs.routeFamily, "bootstrap");
  assert.equal(attrs.bootTokenPresence, "token_pair");
  assert.equal(attrs.bootStorageAccess, "readable_writable");
  assert.equal(attrs.bootBrowser, "safari");
  assert.equal(attrs.bootLastSeenAge, ">=7d");
  assert.equal(attrs.bootUserAgentRaw, "Mozilla/5.0 Version/17.0 Safari/605.1.15");
  assert.equal(attrs.bootLastSeenAgeMs, 691_200_000);
  assert.equal(Object.values(attrs).includes("tok-secret"), false);
});

test("auth boot-init pure bucketers classify token, browser, and age without raw values", () => {
  assert.equal(authBootTokenPresenceBucket("access", "refresh"), "token_pair");
  assert.equal(authBootTokenPresenceBucket("access", null), "access_only");
  assert.equal(authBootTokenPresenceBucket(null, "refresh"), "refresh_only");
  assert.equal(authBootTokenPresenceBucket(null, null), "none");

  assert.equal(
    authBootBrowserBucketFromUserAgent("Mozilla/5.0 Version/17.0 Safari/605.1.15"),
    "safari",
  );
  assert.equal(
    authBootBrowserBucketFromUserAgent("Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/120 Mobile/15E148 Safari/604.1"),
    "ios_webkit",
  );
  assert.equal(
    authBootBrowserBucketFromUserAgent("Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36"),
    "chrome",
  );
  assert.equal(authBootBrowserBucketFromUserAgent(""), "unknown");

  const now = 1_700_000_000_000;
  assert.equal(authBootLastSeenAgeBucket(null, now), "unknown");
  assert.equal(authBootLastSeenAgeBucket(String(now - 30 * 60 * 1000), now), "<1h");
  assert.equal(authBootLastSeenAgeBucket(String(now - 3 * 60 * 60 * 1000), now), "1-24h");
  assert.equal(authBootLastSeenAgeBucket(String(now - 3 * 24 * 60 * 60 * 1000), now), "1-7d");
  assert.equal(authBootLastSeenAgeBucket(String(now - 8 * 24 * 60 * 60 * 1000), now), ">=7d");
  assert.equal(authBootLastSeenAgeBucket("not-a-number", now), "invalid");
});

test("emitAuthTrace is fire-and-forget: never throws, even with odd input (no-op when receiver env unset)", () => {
  __resetAuthTraceForTest();
  // VITE_WEB_TRACE_URL is unset under node:test -> producer is a no-op, but the
  // call must still be exception-safe.
  assert.doesNotThrow(() => emitAuthTrace("slock.auth.verdict", { authVerdict: "logout" }));
  assert.doesNotThrow(() => emitAuthTrace("slock.auth.restore", {}));
  // @ts-expect-error intentionally malformed attrs to prove isolation
  assert.doesNotThrow(() => emitAuthTrace("slock.auth.refresh", { status: "weird" }));
});

test("flushAuthTraces never throws when disabled / empty", async () => {
  __resetAuthTraceForTest();
  await assert.doesNotReject(() => flushAuthTraces());
});

test("emitAuthTraceAndFlush (immediate clear-session path) is fire-and-forget and never throws", () => {
  __resetAuthTraceForTest();
  // Even with a registered serverId getter that throws, the emit must not throw.
  setAuthTraceServerIdGetter(() => {
    throw new Error("boom");
  });
  assert.doesNotThrow(() =>
    emitAuthTraceAndFlush("slock.auth.session_cleared", {
      clearSessionCaller: "logout",
      logoutTrigger: "terminal_verdict",
    }),
  );
  setAuthTraceServerIdGetter(() => undefined);
});

test("generic before-unload transport sends an update-gate record through the urgent path", async () => {
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  setAuthTraceServerIdGetter(() => "server-abc");
  setAuthTracePrincipalIdGetter(() => "user-a");
  const ls = stubLocalStorage({ slock_access_token: "tok" });
  const requests: Array<{ url: string; body: unknown; keepalive: RequestInit["keepalive"] }> = [];
  try {
    setAuthTraceFetchForTest(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requests.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        keepalive: init?.keepalive,
      });
      return url.endsWith("/scope-attestation")
        ? jsonResponse({ attestation: "urgent-att" })
        : jsonResponse({ ok: true });
    });
    await emitWebTraceAndFlushBeforeUnload("slock.update_gate.decision", {
      eventKind: "decision",
      outcome: "decided",
      action: "recovery_finished",
      reason: "cleanup_completed",
      triggerSource: "error_boundary",
      cleanupFailureCount: 0,
    });

    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((request) => request.keepalive), [true, true]);
    assert.match(requests[1]!.url, /\/api\/web-traces$/);
    const records = (requests[1]!.body as { records: Array<{ name: string; attrs?: Record<string, unknown> }> }).records;
    assert.equal(records[0]?.name, "slock.update_gate.decision");
    assert.equal(records[0]?.attrs?.action, "recovery_finished");
  } finally {
    ls.restore();
    setAuthTraceFetchForTest(null);
    setAuthTraceServerIdGetter(() => undefined);
    setAuthTracePrincipalIdGetter(() => undefined);
    __resetAuthTraceForTest();
  }
});

// --- Concurrent flush race + missing-credential drop (review #2503 round 2) ---
//
// These tests exercise the urgent-clear-session path under conditions the
// previous batched-flush design silently lost data on:
//   (a) a regular flush is mid-fetch (`flushing === true`) → the urgent send
//       must still go out using credentials captured at emit-time.
//   (b) urgent emit-time credentials are missing → the call must TRULY drop
//       (no enqueue, no scheduled retry), so logged-out state doesn't spin
//       the scheduled-flush retry loop forever.
//
// Both tests stub globalThis.localStorage so the module's synchronous token
// read returns a deterministic value; they inject a controlled `fetch`
// implementation via `setAuthTraceFetchForTest`.

type StubStore = Record<string, string>;
function stubLocalStorage(initial: StubStore): { restore: () => void } {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const store: StubStore = { ...initial };
  const stub: Storage = {
    get length() {
      return Object.keys(store).length;
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
    getItem: (k: string) => (k in store ? store[k]! : null),
    key: (i: number) => Object.keys(store)[i] ?? null,
    removeItem: (k: string) => {
      delete store[k];
    },
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: stub,
  });
  return {
    restore: () => {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else Reflect.deleteProperty(globalThis, "localStorage");
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("readAuthBootInitTraceAttrs snapshots storage state into bounded buckets", () => {
  __resetAuthTraceForTest();
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgent: "Mozilla/5.0 Version/17.0 Safari/605.1.15",
    },
  });
  const now = 1_700_000_000_000;
  const ls = stubLocalStorage({
    slock_access_token: "tok-secret",
    slock_refresh_token: "refresh-secret",
    slock_auth_boot_last_seen_at: String(now - 8 * 24 * 60 * 60 * 1000),
  });

  try {
    const attrs = readAuthBootInitTraceAttrs({ nowMs: now });

    assert.deepEqual(attrs, {
      routeFamily: "bootstrap",
      bootBrowser: "safari",
      bootUserAgentRaw: "Mozilla/5.0 Version/17.0 Safari/605.1.15",
      bootTokenPresence: "token_pair",
      bootStorageAccess: "readable_writable",
      bootLastSeenAge: ">=7d",
      bootLastSeenAgeMs: 691_200_000,
    });
    assert.equal(globalThis.localStorage.getItem("slock_auth_boot_last_seen_at"), String(now));
    assert.equal(Object.values(attrs).includes("tok-secret"), false);
    assert.equal(Object.values(attrs).includes("refresh-secret"), false);
  } finally {
    ls.restore();
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("readAuthBootInitTraceAttrs reports storage read errors without throwing", () => {
  __resetAuthTraceForTest();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const brokenStorage = {
    getItem: () => {
      throw new DOMException("blocked", "SecurityError");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: brokenStorage,
  });

  try {
    const attrs = readAuthBootInitTraceAttrs({ nowMs: 1_700_000_000_000 });

    assert.equal(attrs.routeFamily, "bootstrap");
    assert.equal(attrs.bootTokenPresence, "unknown");
    assert.equal(attrs.bootStorageAccess, "read_error");
    assert.equal(attrs.bootLastSeenAge, "unknown");
    assert.equal(attrs.bootStorageErrorName, "SecurityError");
    assert.equal(attrs.bootStorageErrorMessage, "blocked");
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("authStore.loadUser emits boot-init trace exactly once before BOOT restore", async () => {
  __resetAuthTraceForTest();
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgent: "Mozilla/5.0 Version/17.0 Safari/605.1.15",
    },
  });
  const ls = stubLocalStorage({
    slock_auth_boot_last_seen_at: String(Date.now() - 30 * 60 * 1000),
  });
  const bootInitEvents: Array<{ name: string; attrs?: Record<string, unknown> }> = [];

  try {
    const moduleUrl = `../src/store/authStore?boot-init-runtime-test=${Date.now()}`;
    const {
      __resetAuthBootInitTraceForTest,
      __setAuthBootInitTraceEmitterForTest,
      useAuthStore,
    } = await import(moduleUrl);
    __setAuthBootInitTraceEmitterForTest((name, attrs) => {
      bootInitEvents.push({ name, attrs: attrs as Record<string, unknown> });
    });
    useAuthStore.setState({
      user: null,
      accessToken: null,
      refreshToken: null,
      loading: false,
      initialized: false,
    });

    await useAuthStore.getState().loadUser();
    await useAuthStore.getState().loadUser();

    assert.equal(bootInitEvents.length, 1);
    assert.equal(useAuthStore.getState().initialized, true);
    assert.equal(bootInitEvents[0]?.name, "slock.auth.boot_init");
    assert.equal(bootInitEvents[0]?.attrs?.bootBrowser, "safari");
    assert.equal(bootInitEvents[0]?.attrs?.bootUserAgentRaw, "Mozilla/5.0 Version/17.0 Safari/605.1.15");
    assert.equal(bootInitEvents[0]?.attrs?.bootTokenPresence, "none");
    assert.equal(bootInitEvents[0]?.attrs?.bootLastSeenAge, "<1h");
    assert.equal(typeof bootInitEvents[0]?.attrs?.bootLastSeenAgeMs, "number");
    assert.ok((bootInitEvents[0]?.attrs?.bootLastSeenAgeMs as number) >= 30 * 60 * 1000);

    __resetAuthBootInitTraceForTest((name, attrs) => {
      bootInitEvents.push({ name, attrs: attrs as Record<string, unknown> });
    });
    await useAuthStore.getState().loadUser();

    assert.equal(bootInitEvents.length, 2);
    assert.equal(bootInitEvents[1]?.name, "slock.auth.boot_init");

    // The production authStore registration must bind queued records to the
    // access-token subject (never the raw token). Rotate between two real JWTs
    // for the same subject before flush: a raw-token getter would misclassify
    // that normal rotation as a principal change and drop the record.
    __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
    setAuthTraceServerIdGetter(() => "server-abc");
    const token1 = `header.${btoa(JSON.stringify({ type: "access", sub: "user-a", rotation: 1 }))}.signature`;
    const token2 = `header.${btoa(JSON.stringify({ type: "access", sub: "user-a", rotation: 2 }))}.signature`;
    localStorage.setItem("slock_access_token", token1);
    const transportCalls: Array<{ url: string; headers: HeadersInit | undefined; body: string }> = [];
    setAuthTraceFetchForTest((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      transportCalls.push({ url, headers: init?.headers, body: String(init?.body ?? "") });
      return Promise.resolve(url.endsWith("/scope-attestation")
        ? jsonResponse({ attestation: "att" })
        : jsonResponse({ ok: true }));
    });
    emitAuthTrace("slock.auth.restore", { restoreState: "authenticated" });
    localStorage.setItem("slock_access_token", token2);
    await flushAuthTraces();
    assert.equal(transportCalls.length, 2, "authStore must register the access-token subject as queue principal");
    assert.equal((transportCalls[0]!.headers as Record<string, string>).Authorization, `Bearer ${token2}`);
    assert.equal(transportCalls[1]!.body.includes(token1), false, "receiver body must not retain the old token");
    assert.equal(transportCalls[1]!.body.includes(token2), false, "receiver body must not contain the rotated token");
    await flushAuthTraces();
    assert.equal(transportCalls.length, 2, "same-subject rotated record must send exactly once");
  } finally {
    const { __resetAuthBootInitTraceForTest } = await import("../src/store/authStore");
    __resetAuthBootInitTraceForTest();
    setAuthTraceFetchForTest(null);
    setAuthTraceServerIdGetter(() => undefined);
    setAuthTracePrincipalIdGetter(() => undefined);
    __resetAuthTraceForTest();
    ls.restore();
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

// Wait until `predicate()` returns true or the deadline elapses. Yields the
// event loop with setTimeout(0) between checks so awaited fetches, their
// awaited `.json()` parses, and queued microtasks all get to run on CI's
// slower scheduling. The previous fixed `await Promise.resolve()` x4 drain
// was non-deterministic on CI (cross DRI catch msg=c13efab7) — the urgent
// path's att.json() + the chained traces POST collectively need more turns
// than a fixed microtask count can guarantee.
async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 1000, intervalMs = 5 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (!predicate()) {
    throw new Error(`waitFor timed out after ${timeoutMs}ms`);
  }
}

test("emitAuthTraceAndFlush sends the urgent clear-session trace even when a scheduled flush is in-flight (concurrent-flush race fix)", async () => {
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  setAuthTraceServerIdGetter(() => "server-abc");
  setAuthTracePrincipalIdGetter(() => "user-a");
  const ls = stubLocalStorage({ slock_access_token: "tok-pre-removeItem" });

  try {
    // Fixture: first fetch (the scheduled flush's attestation) stalls forever
    // so `flushing === true` stays latched. Second fetch is the urgent path's
    // attestation; third is the urgent path's web-traces POST. Both resolve
    // OK. The urgent path is exercised AFTER the scheduled flush has set
    // `flushing = true` and is mid-attestation.
    const calls: Array<{ url: string; auth: string | null }> = [];
    let stalledFirst: (() => void) | null = null;
    const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const auth =
        (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? null;
      calls.push({ url, auth });

      if (calls.length === 1) {
        // Scheduled-flush attestation: never resolve.
        return new Promise<Response>((resolve) => {
          stalledFirst = () => resolve(jsonResponse({ attestation: "scheduled-att" }));
        });
      }
      if (calls.length === 2) {
        // Urgent-path attestation: resolve immediately.
        return Promise.resolve(jsonResponse({ attestation: "urgent-att" }));
      }
      // Urgent-path web-traces POST.
      return Promise.resolve(jsonResponse({ ok: true }));
    };
    setAuthTraceFetchForTest(fetchImpl);

    // Step 1: enqueue a normal trace + fire a scheduled flush. The first
    // fetch (attestation) stalls, leaving `flushing = true`.
    emitAuthTrace("slock.auth.verdict", { authVerdict: "logout" });
    void flushAuthTraces();
    // Wait for the scheduled flush to issue its (stalled) fetch. Polling
    // instead of fixed `await Promise.resolve()` x N because CI's scheduler
    // doesn't reliably collapse the await chain inside one microtask turn.
    await waitFor(() => calls.length >= 1);
    assert.equal(calls.length, 1, "scheduled flush should have issued exactly one (stalled) fetch by now");

    // Step 2: now `flushing === true`. Caller invokes emitAuthTraceAndFlush
    // and immediately "removes" the token. The urgent send must have captured
    // the token before this removeItem.
    emitAuthTraceAndFlush("slock.auth.session_cleared", {
      clearSessionCaller: "logout",
      logoutTrigger: "terminal_verdict",
    });
    ls.restore();
    // Re-stub with token absent — emulates the post-removeItem world.
    const ls2 = stubLocalStorage({});
    try {
      // Wait for the urgent path to issue BOTH its attestation AND the
      // chained /api/web-traces POST. Three fetches total expected:
      // [stalled scheduled att, urgent att, urgent traces POST]. Polling
      // with timeout because the urgent path awaits attestation -> json() ->
      // chains into the traces POST, which is more microtask turns than a
      // fixed drain can portably guarantee on CI (cross msg=c13efab7).
      await waitFor(() => calls.length >= 3);
      assert.equal(calls.length, 3, `expected 3 fetches (stalled scheduled att + urgent att + urgent traces); got ${calls.length}`);
      // The urgent attestation (call #2) must use the pre-removeItem token,
      // even though the scheduled flush's guard would otherwise have
      // short-circuited any flushAuthTraces() invocation.
      assert.equal(
        calls[1]?.auth,
        "Bearer tok-pre-removeItem",
        "urgent attestation must carry the token snapshotted before removeItem",
      );
      // The urgent traces POST is fired to the trace URL (call #3).
      assert.ok(
        calls[2]?.url.includes("/api/web-traces"),
        `urgent traces POST should target /api/web-traces; got ${calls[2]?.url}`,
      );
    } finally {
      ls2.restore();
      // Unstall the scheduled fetch so the lingering promise resolves cleanly.
      stalledFirst?.();
    }
  } finally {
    setAuthTraceFetchForTest(null);
    setAuthTraceServerIdGetter(() => undefined);
    setAuthTracePrincipalIdGetter(() => undefined);
    __resetAuthTraceForTest();
  }
});

test("urgent terminal verdict is sent immediately and mirrored onto terminal session_cleared", async () => {
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  setAuthTraceServerIdGetter(() => "server-abc");
  const ls = stubLocalStorage({ slock_access_token: "tok-terminal-verdict" });

  try {
    const tracePosts: Array<{ records?: Array<{ name?: string; attrs?: Record<string, unknown> }> }> = [];
    setAuthTraceFetchForTest((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/scope-attestation")) {
        return Promise.resolve(jsonResponse({ attestation: `att-${tracePosts.length}` }));
      }
      if (url.includes("/api/web-traces")) {
        tracePosts.push(JSON.parse(String(init?.body)));
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    emitAuthTraceAndFlush("slock.auth.verdict", {
      signalType: "refresh_failed",
      status: 401,
      statusBucket: "auth_401_403",
      hasRefreshToken: true,
      initialized: true,
      restoreState: "authenticated",
      authVerdict: "logout",
      routeFamily: "auth_refresh",
    });
    await waitFor(() => tracePosts.length >= 1);

    emitAuthTraceAndFlush("slock.auth.session_cleared", {
      clearSessionCaller: "logout",
      logoutTrigger: "terminal_verdict",
    });
    await waitFor(() => tracePosts.length >= 2);

    const verdict = tracePosts[0]?.records?.[0];
    assert.equal(verdict?.name, "slock.auth.verdict");
    assert.equal(verdict?.attrs?.authVerdict, "logout");
    assert.equal(verdict?.attrs?.statusBucket, "auth_401_403");
    assert.equal(verdict?.attrs?.routeFamily, "auth_refresh");

    const terminalClear = tracePosts[1]?.records?.[0];
    assert.equal(terminalClear?.name, "slock.auth.session_cleared");
    assert.equal(terminalClear?.attrs?.clearSessionCaller, "logout");
    assert.equal(terminalClear?.attrs?.logoutTrigger, "terminal_verdict");
    assert.equal(terminalClear?.attrs?.authVerdict, "logout");
    assert.equal(terminalClear?.attrs?.statusBucket, "auth_401_403");
    assert.equal(terminalClear?.attrs?.hasRefreshToken, true);
    assert.equal(terminalClear?.attrs?.restoreState, "authenticated");
    assert.equal(terminalClear?.attrs?.routeFamily, "auth_refresh");

    emitAuthTraceAndFlush("slock.auth.session_cleared", {
      clearSessionCaller: "logout",
      logoutTrigger: "terminal_verdict",
    });
    await waitFor(() => tracePosts.length >= 3);
    const secondTerminalClear = tracePosts[2]?.records?.[0];
    assert.equal(secondTerminalClear?.name, "slock.auth.session_cleared");
    assert.equal(secondTerminalClear?.attrs?.logoutTrigger, "terminal_verdict");
    assert.equal(
      "authVerdict" in (secondTerminalClear?.attrs ?? {}),
      false,
      "terminal verdict attrs must be mirrored once, not reused for later terminal clears",
    );

    emitAuthTraceAndFlush("slock.auth.session_cleared", {
      clearSessionCaller: "logout",
      logoutTrigger: "explicit_user_logout",
    });
    await waitFor(() => tracePosts.length >= 4);
    const explicitClear = tracePosts[3]?.records?.[0];
    assert.equal(explicitClear?.name, "slock.auth.session_cleared");
    assert.equal(explicitClear?.attrs?.logoutTrigger, "explicit_user_logout");
    assert.equal(
      "authVerdict" in (explicitClear?.attrs ?? {}),
      false,
      "explicit user logout must not inherit stale terminal-verdict attrs",
    );
  } finally {
    ls.restore();
    setAuthTraceFetchForTest(null);
    setAuthTraceServerIdGetter(() => undefined);
    __resetAuthTraceForTest();
  }
});

test("emitAuthTraceAndFlush truly drops when credentials are missing — no enqueue, no logged-out retry spin", async () => {
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  setAuthTraceServerIdGetter(() => undefined); // no active server
  const ls = stubLocalStorage({}); // no token

  try {
    const calls: string[] = [];
    setAuthTraceFetchForTest((input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      return Promise.resolve(jsonResponse({}));
    });

    // Fire an urgent emit in logged-out state — must not enqueue, not fetch,
    // not schedule. Specifically: no fetch call AT ALL, and a subsequent
    // explicit flushAuthTraces() must remain a no-op (queue was never grown).
    emitAuthTraceAndFlush("slock.auth.session_cleared", {
      clearSessionCaller: "logout",
      logoutTrigger: "terminal_verdict",
    });
    // Give the scheduler a chance to issue any (incorrect) fetch — must
    // remain zero. A small dwell beats a fixed microtask drain on CI.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 0, "urgent emit with missing creds must NOT issue any fetch");

    // Now explicitly flush — should also be a no-op, proving the urgent emit
    // did not silently enqueue the record (which would cause infinite
    // retries via the scheduled flush's `finally { if (queue.length) reschedule }`).
    await flushAuthTraces();
    assert.equal(calls.length, 0, "no enqueue: flush after a credentialless urgent emit must still issue zero fetches");
  } finally {
    ls.restore();
    setAuthTraceFetchForTest(null);
    setAuthTraceServerIdGetter(() => undefined);
    __resetAuthTraceForTest();
  }
});

test("scheduled flush preserves a pre-eligibility record, then sends it exactly once after server/token hydration", async () => {
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  setAuthTraceServerIdGetter(() => undefined);
  let principalId: string | undefined;
  setAuthTracePrincipalIdGetter(() => principalId);
  const ls = stubLocalStorage({});

  try {
    const calls: Array<{ url: string; body: unknown; keepalive: RequestInit["keepalive"] }> = [];
    setAuthTraceFetchForTest((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        keepalive: init?.keepalive,
      });
      return Promise.resolve(url.endsWith("/scope-attestation")
        ? jsonResponse({ attestation: "att" })
        : jsonResponse({ ok: true }));
    });

    emitAuthTrace("slock.auth.boot_init");
    await flushAuthTraces();
    assert.equal(calls.length, 0, "ineligible flush must not issue a request");

    ls.restore();
    const ls2 = stubLocalStorage({ slock_access_token: "tok" });
    setAuthTraceServerIdGetter(() => "server-abc");
    principalId = "user-a";

    try {
      await flushAuthTraces();
      assert.deepEqual(calls.map((call) => call.url), [
        "/api/servers/server-abc/scope-attestation",
        "https://trace.example.test/api/web-traces",
      ]);
      assert.deepEqual(calls.map((call) => call.keepalive), [undefined, undefined]);
      const records = (calls[1]!.body as { records: Array<{ name: string }> }).records;
      assert.deepEqual(records.map((record) => record.name), ["slock.auth.boot_init"]);

      await flushAuthTraces();
      assert.equal(calls.length, 2, "eligible record must be sent exactly once");
    } finally {
      ls2.restore();
    }
  } finally {
    setAuthTraceFetchForTest(null);
    setAuthTraceServerIdGetter(() => undefined);
    setAuthTracePrincipalIdGetter(() => undefined);
    __resetAuthTraceForTest();
  }
});

test("scheduled flush never binds a pre-principal non-boot record to a later principal", async () => {
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  setAuthTraceServerIdGetter(() => undefined);
  let principalId: string | undefined;
  setAuthTracePrincipalIdGetter(() => principalId);
  const ls = stubLocalStorage({});

  try {
    let fetchCalls = 0;
    setAuthTraceFetchForTest(() => {
      fetchCalls++;
      return Promise.resolve(jsonResponse({ attestation: "att" }));
    });

    emitAuthTrace("slock.auth.restore", { restoreState: "restoring_auth" });
    await flushAuthTraces();
    assert.equal(fetchCalls, 0, "pre-principal non-boot record must remain ineligible");

    ls.restore();
    const hydrated = stubLocalStorage({ slock_access_token: "token-b" });
    setAuthTraceServerIdGetter(() => "server-abc");
    principalId = "user-b";
    try {
      await flushAuthTraces();
      assert.equal(fetchCalls, 0, "non-boot record must not bind to a later principal");
    } finally {
      hydrated.restore();
    }
  } finally {
    setAuthTraceFetchForTest(null);
    setAuthTraceServerIdGetter(() => undefined);
    setAuthTracePrincipalIdGetter(() => undefined);
    __resetAuthTraceForTest();
  }
});

test("scheduled flush drops a server-bound record instead of sending it under a different server", async () => {
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  let activeServerId: string | undefined = "server-a";
  setAuthTraceServerIdGetter(() => activeServerId);
  setAuthTracePrincipalIdGetter(() => "user-a");
  const ls = stubLocalStorage({ slock_access_token: "tok" });

  try {
    let fetchCalls = 0;
    setAuthTraceFetchForTest(() => {
      fetchCalls++;
      return Promise.resolve(jsonResponse({ attestation: "att" }));
    });

    emitAuthTrace("slock.auth.restore", { restoreState: "authenticated" });
    activeServerId = "server-b";
    await flushAuthTraces();
    assert.equal(fetchCalls, 0, "server-a record must never use server-b attestation");
  } finally {
    ls.restore();
    setAuthTraceFetchForTest(null);
    setAuthTraceServerIdGetter(() => undefined);
    setAuthTracePrincipalIdGetter(() => undefined);
    __resetAuthTraceForTest();
  }
});

test("scheduled flush retains a server-bound record across a missing-token eligibility gap without retaining the token", async () => {
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  setAuthTraceServerIdGetter(() => "server-abc");
  setAuthTracePrincipalIdGetter(() => "user-a");
  const ls = stubLocalStorage({});

  try {
    const calls: Array<{ url: string; headers: HeadersInit | undefined; body: string }> = [];
    setAuthTraceFetchForTest((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, headers: init?.headers, body: String(init?.body ?? "") });
      return Promise.resolve(url.endsWith("/scope-attestation")
        ? jsonResponse({ attestation: "att" })
        : jsonResponse({ ok: true }));
    });

    emitAuthTrace("slock.auth.restore", { restoreState: "restoring_auth" });
    await flushAuthTraces();
    assert.equal(calls.length, 0);

    ls.restore();
    const ls2 = stubLocalStorage({ slock_access_token: "sensitive-token" });
    try {
      await flushAuthTraces();
      assert.equal(calls.length, 2);
      assert.equal((calls[0]!.headers as Record<string, string>).Authorization, "Bearer sensitive-token");
      assert.equal(calls[1]!.body.includes("sensitive-token"), false, "receiver body must not contain the access token");
      assert.equal(calls[1]!.body.includes("slock.auth.restore"), true);
    } finally {
      ls2.restore();
    }
  } finally {
    setAuthTraceFetchForTest(null);
    setAuthTraceServerIdGetter(() => undefined);
    setAuthTracePrincipalIdGetter(() => undefined);
    __resetAuthTraceForTest();
  }
});

test("scheduled flush drops a queued record when the same server changes principal across a token gap", async () => {
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  let principalId: string | undefined = "user-a";
  setAuthTraceServerIdGetter(() => "server-abc");
  setAuthTracePrincipalIdGetter(() => principalId);
  const ls = stubLocalStorage({ slock_access_token: "token-a" });

  try {
    let fetchCalls = 0;
    setAuthTraceFetchForTest(() => {
      fetchCalls++;
      return Promise.resolve(jsonResponse({ attestation: "att" }));
    });

    emitAuthTrace("slock.auth.restore", { restoreState: "authenticated" });
    ls.restore();
    const gap = stubLocalStorage({});
    await flushAuthTraces();
    assert.equal(fetchCalls, 0, "token gap must retain without sending");

    gap.restore();
    const nextSession = stubLocalStorage({ slock_access_token: "token-b" });
    principalId = "user-b";
    try {
      await flushAuthTraces();
      assert.equal(fetchCalls, 0, "user-a record must not mint or send under user-b on the same server");
    } finally {
      nextSession.restore();
    }
  } finally {
    setAuthTraceFetchForTest(null);
    setAuthTraceServerIdGetter(() => undefined);
    setAuthTracePrincipalIdGetter(() => undefined);
    __resetAuthTraceForTest();
  }
});

test("scheduled flush sends exactly once after same-principal access-token rotation without retaining either token", async () => {
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  setAuthTraceServerIdGetter(() => "server-abc");
  setAuthTracePrincipalIdGetter(() => "user-a");
  const oldSession = stubLocalStorage({ slock_access_token: "token-old" });

  try {
    const calls: Array<{ url: string; headers: HeadersInit | undefined; body: string }> = [];
    setAuthTraceFetchForTest((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push({ url, headers: init?.headers, body: String(init?.body ?? "") });
      return Promise.resolve(url.endsWith("/scope-attestation")
        ? jsonResponse({ attestation: "att" })
        : jsonResponse({ ok: true }));
    });

    emitAuthTrace("slock.auth.restore", { restoreState: "authenticated" });
    oldSession.restore();
    const rotatedSession = stubLocalStorage({ slock_access_token: "token-new" });
    try {
      await flushAuthTraces();
      assert.equal(calls.length, 2);
      assert.equal((calls[0]!.headers as Record<string, string>).Authorization, "Bearer token-new");
      assert.equal(calls[1]!.body.includes("token-old"), false);
      assert.equal(calls[1]!.body.includes("token-new"), false);
      await flushAuthTraces();
      assert.equal(calls.length, 2, "rotated same-principal record must send exactly once");
    } finally {
      rotatedSession.restore();
    }
  } finally {
    setAuthTraceFetchForTest(null);
    setAuthTraceServerIdGetter(() => undefined);
    setAuthTracePrincipalIdGetter(() => undefined);
    __resetAuthTraceForTest();
  }
});

test("scheduled eligibility retries are bounded and permanently ineligible records stop", async () => {
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  setAuthTraceServerIdGetter(() => undefined);
  setAuthTracePrincipalIdGetter(() => undefined);
  const ls = stubLocalStorage({});

  try {
    let fetchCalls = 0;
    setAuthTraceFetchForTest(() => {
      fetchCalls++;
      return Promise.resolve(jsonResponse({ attestation: "att" }));
    });

    emitAuthTrace("slock.auth.boot_init");
    for (let attempt = 0; attempt < 10; attempt++) await flushAuthTraces();

    ls.restore();
    const ls2 = stubLocalStorage({ slock_access_token: "tok" });
    setAuthTraceServerIdGetter(() => "server-abc");
    try {
      await flushAuthTraces();
      assert.equal(fetchCalls, 0, "record must be gone after the bounded eligibility window");
    } finally {
      ls2.restore();
    }
  } finally {
    setAuthTraceFetchForTest(null);
    setAuthTraceServerIdGetter(() => undefined);
    setAuthTracePrincipalIdGetter(() => undefined);
    __resetAuthTraceForTest();
  }
});
