import assert from "node:assert/strict";
import { getProtectedRequestAuthFailureAction } from "../src/utils/protectedRequestAuthPolicy";
import {
  __resetAuthTraceForTest,
  setAuthTraceFetchForTest,
  setAuthTraceServerIdGetter,
} from "../src/utils/webAuthTrace";

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
      hasAccessToken: true,
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
      hasAccessToken: true,
      initialized: false,
      restoreState: "booting",
    }),
    "logout",
  );

  assert.equal(
    getProtectedRequestAuthFailureAction({
      status: 401,
      hasRefreshToken: true,
      hasAccessToken: true,
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
      hasAccessToken: true,
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
  const tracePosts: Array<{ events?: Array<{ name?: string; attrs?: Record<string, unknown> }> }> = [];

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
    const verdict = tracePosts[0]?.events?.[0];
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

test("a 401 and a 403 share statusBucket auth_401_403 but keep their exact status apart", async () => {
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  setAuthTraceServerIdGetter(() => "server-abc");
  const ls = stubLocalStorage({ slock_access_token: "tok" });
  const tracePosts: Array<{ events?: Array<{ name?: string; attrs?: Record<string, unknown> }> }> = [];

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

    for (const status of [401, 403]) {
      assert.equal(
        getProtectedRequestAuthFailureAction({
          status,
          hasRefreshToken: true,
          hasAccessToken: true,
          initialized: true,
          restoreState: "authenticated",
        }),
        "logout",
      );
    }

    await waitFor(() => tracePosts.length >= 2);
    const verdicts = tracePosts.flatMap((post) => post.events ?? []).filter((event) => event.name === "slock.auth.verdict");
    assert.deepEqual(verdicts.map((event) => event.attrs?.statusBucket), ["auth_401_403", "auth_401_403"]);
    assert.deepEqual(verdicts.map((event) => event.attrs?.status).sort(), [401, 403]);
  } finally {
    ls.restore();
    setAuthTraceFetchForTest(null);
    setAuthTraceServerIdGetter(() => undefined);
    __resetAuthTraceForTest();
  }
});

test("missing refresh token still logs out once restore is settled — a session existed", () => {
  // task #632 split this case in two. Here the access token is present, so a
  // session DID exist and could not be refreshed: ending it is correct.
  assert.equal(
    getProtectedRequestAuthFailureAction({
      status: undefined,
      hasRefreshToken: false,
      hasAccessToken: true,
      initialized: true,
      restoreState: "authenticated",
    }),
    "logout",
  );
});

test("task #632: neither token means the caller never had a session — reject, do not log out", () => {
  // The visitor case (found via task #115 / PR #8112): someone who never signed
  // in hits a protected request on a public page. The 401 is the ordinary answer
  // to an unauthenticated request; treating it as a session ending cleared their
  // storage and redirected them off the page they were reading.
  //
  // `signed_out` is what a visitor actually boots to (`BOOT` with
  // `hasStoredSession: false`), and the distinction matters — see the sibling
  // test below, where the same token inputs carry `authenticated` instead.
  assert.equal(
    getProtectedRequestAuthFailureAction({
      status: 401,
      hasRefreshToken: false,
      hasAccessToken: false,
      initialized: true,
      restoreState: "signed_out",
    }),
    "no-session",
  );
});

test("POSITIVE CONTROL: a tab whose sibling logged out still ends its session (@Josh's review)", () => {
  // The second-order case Josh found: tab A logs out and clears storage, so
  // tab B presents EXACTLY the visitor's token inputs — both absent — because
  // a deletion does not propagate (authTokenSync emits only when both tokens
  // are present; its channel carries `tokens-updated` only).
  //
  // Without the `authenticated` term, tab B would stop being redirected and
  // would sit on a page that looks signed in while every request 401s. Its
  // restore state is the fact the tokens no longer carry.
  assert.equal(
    getProtectedRequestAuthFailureAction({
      status: 401,
      hasRefreshToken: false,
      hasAccessToken: false,
      initialized: true,
      restoreState: "authenticated",
    }),
    "logout",
  );
});

test("task #632: an access token with no refresh token is still a session, even mid-restore", () => {
  // Guards the over-correction: the new branch must key on "were there ever any
  // tokens", not on "did the refresh fail". Anything that still holds a token
  // keeps the old behaviour.
  assert.equal(
    getProtectedRequestAuthFailureAction({
      status: 401,
      hasRefreshToken: false,
      hasAccessToken: true,
      initialized: false,
      restoreState: "booting",
    }),
    "logout",
  );
});

test("task #632: a transient failure with no tokens still does not log out", () => {
  // A visitor hitting a 502 must not be redirected either. Before the change the
  // verdict layer answered "keep-session" here, which happened to be harmless;
  // now the reason is stated rather than accidental.
  assert.equal(
    getProtectedRequestAuthFailureAction({
      status: 502,
      hasRefreshToken: false,
      hasAccessToken: false,
      initialized: true,
      restoreState: "signed_out",
    }),
    "no-session",
  );
});
