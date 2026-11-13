import assert from "node:assert/strict";
import axios from "axios";
import { createRefreshCoordinator, refreshTokensWithDedupe } from "../src/utils/refreshCoordinator";
import type { AuthRefreshAttemptContext, RefreshTokens } from "../src/utils/refreshCoordinator";

// A device that sleeps (or loses the network) while a refresh is out: the
// server rotates, the reply never arrives, and the next refresh comes minutes
// later with the same old token. Web and desktop used to send no installation
// id, so only the server's 10 s in-memory grace could answer that replay and
// the user was logged out after every lid close.

function networkError(): Error {
  return new Error("Network Error");
}

function authError(): Error {
  const error = new Error("Request failed with status code 401") as Error & { response: { status: number } };
  error.response = { status: 401 };
  return error;
}

// The server's durable replay contract (sessionService.refreshSessionWithDurableReplay):
// with an installation id, a rotation leaves a receipt; replaying the same old
// token with the same attempt and installation ids returns the successor, at
// any later time, until the successor itself rotates.
function durableServer() {
  let live = "rt_0";
  let n = 0;
  const receipts = new Map<string, { attemptId: string; installationId: string; tokens: RefreshTokens }>();
  return {
    refresh(refreshToken: string, context: AuthRefreshAttemptContext): RefreshTokens {
      if (refreshToken === live) {
        n += 1;
        const tokens = { accessToken: `at_${n}`, refreshToken: `rt_${n}` };
        live = tokens.refreshToken;
        if (context.authRefreshAttemptId && context.authRefreshInstallationId) {
          receipts.set(refreshToken, {
            attemptId: context.authRefreshAttemptId,
            installationId: context.authRefreshInstallationId,
            tokens,
          });
        }
        return tokens;
      }
      const receipt = receipts.get(refreshToken);
      if (
        receipt
        && receipt.tokens.refreshToken === live
        && receipt.attemptId === context.authRefreshAttemptId
        && receipt.installationId === context.authRefreshInstallationId
      ) {
        return receipt.tokens;
      }
      throw authError();
    },
  };
}

function sleepingDevice() {
  let storedAccessToken = "at_0";
  let storedRefreshToken = "rt_0";
  let attemptSlot: { refreshToken: string; attemptId: string } | null = null;
  let nextAttempt = 0;
  const server = durableServer();
  const requests: AuthRefreshAttemptContext[] = [];
  let asleep = true;
  let rotationReachedServer = false;
  const coordinator = () => createRefreshCoordinator({
    readAccessToken: () => storedAccessToken,
    readRefreshToken: () => storedRefreshToken,
    writeTokens: (tokens) => {
      storedAccessToken = tokens.accessToken;
      storedRefreshToken = tokens.refreshToken;
    },
    rotatedTokenWaitMs: 5,
    rotatedTokenPollMs: 1,
    createAuthRefreshAttemptId: () => `arf_${String(++nextAttempt).padStart(16, "0")}`,
    attemptIdForRefreshToken: (refreshToken, create) => {
      if (attemptSlot?.refreshToken !== refreshToken) attemptSlot = { refreshToken, attemptId: create() };
      return attemptSlot.attemptId;
    },
    readInstallationId: () => `ari_${"a".repeat(32)}`,
    requestRefresh: async (refreshToken, context) => {
      requests.push(context);
      if (asleep) {
        if (!rotationReachedServer) {
          rotationReachedServer = true;
          server.refresh(refreshToken, context); // rotated; the reply is lost
        }
        throw networkError();
      }
      return server.refresh(refreshToken, context);
    },
  });
  return {
    coordinator,
    requests,
    wake: () => { asleep = false; },
    stored: () => ({ accessToken: storedAccessToken, refreshToken: storedRefreshToken }),
  };
}

test("a refresh whose reply was lost while asleep is recovered on wake, even after a page reload", async () => {
  const device = sleepingDevice();

  await assert.rejects(device.coordinator().refresh(), /Network Error/);
  assert.equal(device.stored().refreshToken, "rt_0", "a transient failure keeps the session");

  device.wake();
  // A new coordinator: the page may have been reloaded meanwhile.
  assert.deepEqual(await device.coordinator().refresh(), { accessToken: "at_1", refreshToken: "rt_1" });
  assert.deepEqual(device.stored(), { accessToken: "at_1", refreshToken: "rt_1" });

  const attemptIds = new Set(device.requests.map((context) => context.authRefreshAttemptId));
  assert.deepEqual([...attemptIds], ["arf_0000000000000001"], "every try of rt_0 is the same attempt");
  assert.ok(device.requests.every((context) => context.authRefreshInstallationId === `ari_${"a".repeat(32)}`));
});

test("the tries of one refresh share one attempt id; a new token gets a new one", async () => {
  let storedRefreshToken = "rt_1";
  let calls = 0;
  let nextAttempt = 0;
  const attemptIds: Array<string | undefined> = [];
  const coordinator = createRefreshCoordinator({
    readRefreshToken: () => storedRefreshToken,
    writeTokens: (tokens) => { storedRefreshToken = tokens.refreshToken; },
    createAuthRefreshAttemptId: () => `arf_${String(++nextAttempt).padStart(16, "0")}`,
    requestRefresh: async (_refreshToken, context) => {
      attemptIds.push(context.authRefreshAttemptId);
      calls += 1;
      if (calls < 3) throw networkError();
      return { accessToken: `at_${calls}`, refreshToken: `rt_${calls}` };
    },
  });

  await coordinator.refresh();
  assert.deepEqual(attemptIds, ["arf_0000000000000001", "arf_0000000000000001", "arf_0000000000000001"]);

  await coordinator.refresh();
  assert.equal(attemptIds.at(-1), "arf_0000000000000002");
});

test("an installation id is only sent with an attempt id", async () => {
  const contexts: AuthRefreshAttemptContext[] = [];
  const coordinator = createRefreshCoordinator({
    readRefreshToken: () => "rt_1",
    writeTokens: () => undefined,
    createAuthRefreshAttemptId: () => { throw new Error("no entropy"); },
    readInstallationId: () => `ari_${"b".repeat(32)}`,
    requestRefresh: async (_refreshToken, context) => {
      contexts.push(context);
      return { accessToken: "at_2", refreshToken: "rt_2" };
    },
  });

  await coordinator.refresh();
  assert.equal(contexts[0].authRefreshAttemptId, undefined);
  assert.equal(contexts[0].authRefreshInstallationId, undefined);
});

test("a retry uses a session stored meanwhile instead of resending the old token", async () => {
  let storedAccessToken = "at_1";
  let storedRefreshToken = "rt_1";
  let calls = 0;
  const coordinator = createRefreshCoordinator({
    readAccessToken: () => storedAccessToken,
    readRefreshToken: () => storedRefreshToken,
    writeTokens: (tokens) => {
      storedAccessToken = tokens.accessToken;
      storedRefreshToken = tokens.refreshToken;
    },
    requestRefresh: async () => {
      calls += 1;
      // Another window rotates while this try is out, then this try fails.
      storedAccessToken = "at_other";
      storedRefreshToken = "rt_other";
      throw networkError();
    },
  });

  assert.deepEqual(await coordinator.refresh(), { accessToken: "at_other", refreshToken: "rt_other" });
  assert.equal(calls, 1);
});

type StubStore = Record<string, string>;

function stubLocalStorage(initial: StubStore): { store: StubStore; restore: () => void } {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const store: StubStore = { ...initial };
  const stub: Storage = {
    get length() {
      return Object.keys(store).length;
    },
    clear: () => {
      for (const key of Object.keys(store)) delete store[key];
    },
    getItem: (key) => store[key] ?? null,
    key: (index) => Object.keys(store)[index] ?? null,
    removeItem: (key) => {
      delete store[key];
    },
    setItem: (key, value) => {
      store[key] = value;
    },
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: stub });
  return {
    store,
    restore: () => {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else Reflect.deleteProperty(globalThis, "localStorage");
    },
  };
}

test("the browser refresh sends a stable installation id and replays a failed attempt with the same id", async () => {
  const ls = stubLocalStorage({ slock_access_token: "at_1", slock_refresh_token: "rt_1" });
  const originalAdapter = axios.defaults.adapter;
  const sent: Array<{ attemptId: unknown; installationId: unknown; refreshToken: unknown }> = [];
  let failNext = 3; // the first refresh fails all three tries

  try {
    axios.defaults.adapter = async (config) => {
      sent.push({
        attemptId: config.headers?.get("X-Slock-Auth-Refresh-Attempt-Id"),
        installationId: config.headers?.get("X-Slock-Auth-Installation-Id"),
        refreshToken: JSON.parse(String(config.data)).refreshToken,
      });
      if (failNext > 0) {
        failNext -= 1;
        throw Object.assign(new Error("Network Error"), { isAxiosError: true, config });
      }
      const n = sent.length;
      return { config, data: { accessToken: `at_${n}`, refreshToken: `rt_${n}` }, headers: {}, status: 200, statusText: "OK" };
    };

    await assert.rejects(refreshTokensWithDedupe(), /Network Error/);
    await refreshTokensWithDedupe();
    await refreshTokensWithDedupe();

    const installationIds = new Set(sent.map((request) => request.installationId));
    assert.equal(installationIds.size, 1);
    assert.match(String([...installationIds][0]), /^ari_[0-9a-f]{32}$/);
    assert.equal(ls.store.slock_auth_installation_id, [...installationIds][0]);

    const forRt1 = sent.filter((request) => request.refreshToken === "rt_1");
    assert.equal(forRt1.length, 4, "three failed tries, then the replay that succeeds");
    assert.equal(new Set(forRt1.map((request) => request.attemptId)).size, 1, "all tries of rt_1 are one attempt");
    assert.match(String(forRt1[0].attemptId), /^arf_[0-9a-f]{16}$/);

    const next = sent.at(-1)!;
    assert.equal(next.refreshToken, "rt_4");
    assert.notEqual(next.attemptId, forRt1[0].attemptId, "a new token starts a new attempt");
    assert.ok(!ls.store.slock_auth_refresh_attempt?.includes("rt_"), "the attempt slot holds no token");
  } finally {
    axios.defaults.adapter = originalAdapter;
    ls.restore();
  }
}, 10_000);

test("a failed refresh's verdict trace says what asked for the refresh", async () => {
  const { shouldLogoutAfterRefreshFailure } = await import("../src/utils/authSessionPolicy");
  const {
    __resetAuthTraceForTest,
    setAuthTraceFetchForTest,
    setAuthTraceServerIdGetter,
  } = await import("../src/utils/webAuthTrace");
  __resetAuthTraceForTest({ traceUrl: "https://trace.example.test" });
  setAuthTraceServerIdGetter(() => "server-abc");
  const ls = stubLocalStorage({ slock_access_token: "at_1", slock_refresh_token: "rt_1" });
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  const posts: Array<{ events?: Array<{ name?: string; attrs?: Record<string, unknown> }> }> = [];
  try {
    setAuthTraceFetchForTest((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/scope-attestation")) return Promise.resolve(json({ attestation: "att" }));
      if (url.includes("/api/web-traces")) posts.push(JSON.parse(String(init?.body)));
      return Promise.resolve(json({ ok: true }));
    });

    assert.equal(shouldLogoutAfterRefreshFailure({ status: 401, hasRefreshToken: true, trigger: "socket_reconnect" }), true);
    const deadline = Date.now() + 2_000;
    while (!posts.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));

    const verdict = posts.flatMap((post) => post.events ?? []).find((record) => record.name === "slock.auth.verdict");
    assert.equal(verdict?.attrs?.refreshTrigger, "socket_reconnect");
    assert.equal(verdict?.attrs?.authVerdict, "logout");
  } finally {
    ls.restore();
    setAuthTraceFetchForTest(null);
    setAuthTraceServerIdGetter(() => undefined);
    __resetAuthTraceForTest();
  }
});
