import assert from "node:assert/strict";
import test from "node:test";
import { getProtectedRequestAuthFailureAction } from "../src/utils/protectedRequestAuthPolicy.js";
import {
  __resetAuthTraceForTest,
  setAuthTraceFetchForTest,
  setAuthTraceServerIdGetter,
} from "../src/utils/webAuthTrace.js";

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

async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 1000, intervalMs = 5 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (!predicate()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

test("protected request keeps the session on transient refresh failure", () => {
  assert.equal(
    getProtectedRequestAuthFailureAction({
      status: 502,
      hasRefreshToken: true,
      initialized: true,
      restoreState: "authenticated",
    }),
    "keep-session",
  );
});

test("protected request logs out on refresh auth failure while auth bootstrap is still restoring", () => {
  assert.equal(
    getProtectedRequestAuthFailureAction({
      status: 401,
      hasRefreshToken: true,
      initialized: false,
      restoreState: "booting",
    }),
    "logout",
  );

  assert.equal(
    getProtectedRequestAuthFailureAction({
      status: 401,
      hasRefreshToken: true,
      initialized: true,
      restoreState: "restoring_auth",
    }),
    "logout",
  );
});

test("protected request logs out on explicit auth failure once restore is settled", () => {
  assert.equal(
    getProtectedRequestAuthFailureAction({
      status: 401,
      hasRefreshToken: true,
      initialized: true,
      restoreState: "authenticated",
    }),
    "logout",
  );
});

test("protected request terminal verdict carries auth refresh attempt join id", async () => {
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  setAuthTraceServerIdGetter(() => "server-abc");
  const ls = stubLocalStorage({ slock_access_token: "tok" });
  const tracePosts: Array<{ records?: Array<{ name?: string; attrs?: Record<string, unknown> }> }> = [];

  try {
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

    assert.equal(
      getProtectedRequestAuthFailureAction({
        status: 401,
        hasRefreshToken: true,
        initialized: true,
        restoreState: "authenticated",
        authRefreshAttemptId: "arf_deadbeef00000001",
      }),
      "logout",
    );

    await waitFor(() => tracePosts.length >= 1);
    const verdict = tracePosts[0]?.records?.[0];
    assert.equal(verdict?.name, "slock.auth.verdict");
    assert.equal(verdict?.attrs?.authVerdict, "logout");
    assert.equal(verdict?.attrs?.authRefreshAttemptId, "arf_deadbeef00000001");
  } finally {
    ls.restore();
    setAuthTraceFetchForTest(null);
    setAuthTraceServerIdGetter(() => undefined);
    __resetAuthTraceForTest();
  }
});

test("missing refresh token still logs out once restore is settled", () => {
  assert.equal(
    getProtectedRequestAuthFailureAction({
      status: undefined,
      hasRefreshToken: false,
      initialized: true,
      restoreState: "authenticated",
    }),
    "logout",
  );
});
