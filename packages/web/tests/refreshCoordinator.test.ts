import assert from "node:assert/strict";
import test from "node:test";
import { authRefreshAttemptIdFromError } from "../src/utils/authErrors.js";
import { createRefreshCoordinator } from "../src/utils/refreshCoordinator.js";
import {
  __resetAuthTraceForTest,
  setAuthTraceFetchForTest,
  setAuthTraceServerIdGetter,
} from "../src/utils/webAuthTrace.ts";

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

function createQueuedLock() {
  let tail = Promise.resolve();
  return async <T>(callback: () => Promise<T>): Promise<T> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  };
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

test("concurrent refresh callers share one rotated refresh request", async () => {
  let storedRefreshToken = "rt_1";
  let callCount = 0;
  const attemptIds: string[] = [];

  const coordinator = createRefreshCoordinator({
    readRefreshToken: () => storedRefreshToken,
    writeTokens: (tokens) => {
      storedRefreshToken = tokens.refreshToken;
    },
    requestRefresh: async (refreshToken, context) => {
      callCount += 1;
      attemptIds.push(context.authRefreshAttemptId);
      assert.equal(refreshToken, "rt_1");
      await Promise.resolve();
      return {
        accessToken: "at_2",
        refreshToken: "rt_2",
      };
    },
    createAuthRefreshAttemptId: () => `arf_${String(callCount + 1).padStart(16, "0")}`,
  });

  const [first, second] = await Promise.all([
    coordinator.refresh(),
    coordinator.refresh(),
  ]);

  assert.equal(callCount, 1);
  assert.deepEqual(attemptIds, ["arf_0000000000000001"]);
  assert.deepEqual(first, {
    accessToken: "at_2",
    refreshToken: "rt_2",
  });
  assert.deepEqual(second, first);
  assert.equal(storedRefreshToken, "rt_2");
});

test("a later refresh call uses the newly rotated token", async () => {
  let storedRefreshToken = "rt_1";
  const seenTokens: string[] = [];

  const coordinator = createRefreshCoordinator({
    readRefreshToken: () => storedRefreshToken,
    writeTokens: (tokens) => {
      storedRefreshToken = tokens.refreshToken;
    },
    requestRefresh: async (refreshToken) => {
      seenTokens.push(refreshToken);
      if (refreshToken === "rt_1") {
        return {
          accessToken: "at_2",
          refreshToken: "rt_2",
        };
      }
      return {
        accessToken: "at_3",
        refreshToken: "rt_3",
      };
    },
  });

  await coordinator.refresh();
  await coordinator.refresh();

  assert.deepEqual(seenTokens, ["rt_1", "rt_2"]);
});

test("refresh coordinator publishes token rotation to other tabs", async () => {
  let storedRefreshToken = "rt_1";
  const published: Array<{ accessToken: string; refreshToken: string }> = [];

  const coordinator = createRefreshCoordinator({
    readRefreshToken: () => storedRefreshToken,
    writeTokens: (tokens) => {
      storedRefreshToken = tokens.refreshToken;
    },
    onTokensRefreshed: (tokens) => {
      published.push(tokens);
    },
    requestRefresh: async () => ({
      accessToken: "at_2",
      refreshToken: "rt_2",
    }),
  });

  await coordinator.refresh();

  assert.deepEqual(published, [{ accessToken: "at_2", refreshToken: "rt_2" }]);
});

test("cross-tab refresh lock makes losers adopt the winner token pair before spending stale refresh", async () => {
  let storedAccessToken = "at_1";
  let storedRefreshToken = "rt_1";
  let callCount = 0;
  const requestRefreshLock = createQueuedLock();

  function makeCoordinator(tab: "first" | "second") {
    return createRefreshCoordinator({
      readAccessToken: () => storedAccessToken,
      readRefreshToken: () => storedRefreshToken,
      writeTokens: (tokens) => {
        storedAccessToken = tokens.accessToken;
        storedRefreshToken = tokens.refreshToken;
      },
      requestRefreshLock,
      requestRefresh: async (refreshToken) => {
        callCount += 1;
        assert.equal(refreshToken, "rt_1", `${tab} should not call /refresh with the winner's token`);
        await Promise.resolve();
        return { accessToken: "at_2", refreshToken: "rt_2" };
      },
    });
  }

  const [first, second] = await Promise.all([
    makeCoordinator("first").refresh(),
    makeCoordinator("second").refresh(),
  ]);

  assert.equal(callCount, 1);
  assert.deepEqual(first, { accessToken: "at_2", refreshToken: "rt_2" });
  assert.deepEqual(second, first);
  assert.equal(storedAccessToken, "at_2");
  assert.equal(storedRefreshToken, "rt_2");
});

test("separate tab coordinators recover when another tab rotated the refresh token first", async () => {
  let storedRefreshToken = "rt_1";
  const seenTokens: string[] = [];
  let firstRequestReleased = false;

  async function waitForFirstRequestRelease() {
    while (!firstRequestReleased) {
      await Promise.resolve();
    }
  }

  function makeCoordinator() {
    return createRefreshCoordinator({
      readRefreshToken: () => storedRefreshToken,
      writeTokens: (tokens) => {
        storedRefreshToken = tokens.refreshToken;
      },
      requestRefresh: async (refreshToken) => {
        seenTokens.push(refreshToken);
        if (seenTokens.length === 1) {
          firstRequestReleased = true;
        } else if (refreshToken === "rt_1") {
          await waitForFirstRequestRelease();
          await Promise.resolve();
        }
        if (refreshToken !== storedRefreshToken) {
          const error: any = new Error("Invalid or expired refresh token");
          error.response = { status: 401 };
          throw error;
        }
        const version = Number(refreshToken.slice("rt_".length)) + 1;
        return {
          accessToken: `at_${version}`,
          refreshToken: `rt_${version}`,
        };
      },
    });
  }

  const firstTab = makeCoordinator();
  const secondTab = makeCoordinator();

  const [first, second] = await Promise.all([
    firstTab.refresh(),
    secondTab.refresh(),
  ]);

  assert.deepEqual(first, {
    accessToken: "at_2",
    refreshToken: "rt_2",
  });
  assert.deepEqual(second, {
    accessToken: "at_3",
    refreshToken: "rt_3",
  });
  assert.equal(storedRefreshToken, "rt_3");
  assert.deepEqual(seenTokens, ["rt_1", "rt_1", "rt_2"]);
});

test("separate tab coordinators adopt an observed token pair instead of rotating again", async () => {
  let storedAccessToken = "at_1";
  let storedRefreshToken = "rt_1";
  const seenTokens: string[] = [];
  let firstRequestReleased = false;

  async function waitForFirstRequestRelease() {
    while (!firstRequestReleased) {
      await Promise.resolve();
    }
  }

  function makeCoordinator() {
    return createRefreshCoordinator({
      readAccessToken: () => storedAccessToken,
      readRefreshToken: () => storedRefreshToken,
      writeTokens: (tokens) => {
        storedAccessToken = tokens.accessToken;
        storedRefreshToken = tokens.refreshToken;
      },
      requestRefresh: async (refreshToken) => {
        seenTokens.push(refreshToken);
        if (seenTokens.length === 1) {
          firstRequestReleased = true;
        } else if (refreshToken === "rt_1") {
          await waitForFirstRequestRelease();
          await Promise.resolve();
        }
        if (refreshToken !== storedRefreshToken) {
          const error: any = new Error("Invalid or expired refresh token");
          error.response = { status: 401 };
          throw error;
        }
        const version = Number(refreshToken.slice("rt_".length)) + 1;
        return {
          accessToken: `at_${version}`,
          refreshToken: `rt_${version}`,
        };
      },
    });
  }

  const firstTab = makeCoordinator();
  const secondTab = makeCoordinator();

  const [first, second] = await Promise.all([
    firstTab.refresh(),
    secondTab.refresh(),
  ]);

  assert.deepEqual(first, {
    accessToken: "at_2",
    refreshToken: "rt_2",
  });
  assert.deepEqual(second, first);
  assert.equal(storedAccessToken, "at_2");
  assert.equal(storedRefreshToken, "rt_2");
  assert.deepEqual(seenTokens, ["rt_1", "rt_1"]);
});

test("separate tab coordinators wait for a just-rotated token before logging out", async () => {
  let storedRefreshToken = "rt_1";
  const seenTokens: string[] = [];
  let releaseFirstRotation!: () => void;
  const firstRotationWritten = new Promise<void>((resolve) => {
    releaseFirstRotation = resolve;
  });

  const firstTab = createRefreshCoordinator({
    readRefreshToken: () => storedRefreshToken,
    writeTokens: (tokens) => {
      storedRefreshToken = tokens.refreshToken;
      releaseFirstRotation();
    },
    requestRefresh: async (refreshToken) => {
      seenTokens.push(`first:${refreshToken}`);
      assert.equal(refreshToken, "rt_1");
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { accessToken: "at_2", refreshToken: "rt_2" };
    },
  });

  const secondTab = createRefreshCoordinator({
    readRefreshToken: () => storedRefreshToken,
    writeTokens: (tokens) => {
      storedRefreshToken = tokens.refreshToken;
    },
    requestRefresh: async (refreshToken) => {
      seenTokens.push(`second:${refreshToken}`);
      if (refreshToken === "rt_1") {
        const error: any = new Error("Invalid or expired refresh token");
        error.response = { status: 401 };
        return Promise.reject(error);
      }
      assert.equal(refreshToken, "rt_2");
      return { accessToken: "at_3", refreshToken: "rt_3" };
    },
  });

  const [first, second] = await Promise.all([
    firstTab.refresh(),
    secondTab.refresh(),
  ]);
  await firstRotationWritten;

  assert.deepEqual(first, { accessToken: "at_2", refreshToken: "rt_2" });
  assert.deepEqual(second, { accessToken: "at_3", refreshToken: "rt_3" });
  assert.equal(storedRefreshToken, "rt_3");
  assert.deepEqual(seenTokens, ["first:rt_1", "second:rt_1", "second:rt_2"]);
});

test("refresh coordinator emits urgent cross-tab timeout evidence before surfacing stale refresh 401", async () => {
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  setAuthTraceServerIdGetter(() => "server-abc");
  const ls = stubLocalStorage({ slock_access_token: "at_1", slock_refresh_token: "rt_1" });

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

    const coordinator = createRefreshCoordinator({
      readAccessToken: () => localStorage.getItem("slock_access_token"),
      readRefreshToken: () => localStorage.getItem("slock_refresh_token"),
      writeTokens: () => {
        throw new Error("unexpected write");
      },
      requestRefresh: async () => {
        const err: any = new Error("invalid_refresh_token");
        err.response = { status: 401 };
        throw err;
      },
      rotatedTokenWaitMs: 20,
      rotatedTokenPollMs: 5,
      createAuthRefreshAttemptId: () => "arf_deadbeef00000001",
    });

    await assert.rejects(async () => {
      try {
        await coordinator.refresh();
      } catch (error) {
        assert.equal(authRefreshAttemptIdFromError(error), "arf_deadbeef00000001");
        throw error;
      }
    }, /invalid_refresh_token/);
    await waitFor(() => tracePosts.some((post) =>
      post.records?.some((record) => record.attrs?.crossTabSyncPhase === "wait_timeout")
    ));

    const timeoutRecord = tracePosts
      .flatMap((post) => post.records ?? [])
      .find((record) => record.attrs?.crossTabSyncPhase === "wait_timeout");

    assert.equal(timeoutRecord?.name, "slock.auth.cross_tab_sync");
    assert.equal(timeoutRecord?.attrs?.routeFamily, "auth_refresh");
    assert.equal(timeoutRecord?.attrs?.status, 401);
    assert.equal(timeoutRecord?.attrs?.statusBucket, "auth_401_403");
    assert.equal(timeoutRecord?.attrs?.authRefreshAttemptId, "arf_deadbeef00000001");
    assert.equal(timeoutRecord?.attrs?.tokenObservation, "none");
    assert.match(String(timeoutRecord?.attrs?.waitElapsedBucket), /^(<100ms|100-999ms)$/);
    assert.equal(timeoutRecord?.attrs?.rotatedTokenWaitMs, 20);
    assert.equal(timeoutRecord?.attrs?.retryIndex, 0);
  } finally {
    ls.restore();
    setAuthTraceFetchForTest(null);
    setAuthTraceServerIdGetter(() => undefined);
    __resetAuthTraceForTest();
  }
});
