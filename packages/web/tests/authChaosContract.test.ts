import assert from "node:assert/strict";
import test from "node:test";
import {
  getAuthBootstrapView,
  nextAuthRestoreStateAfterExternalTokenSync,
  shouldRetryAuthRestore,
} from "../src/utils/authRestoreMachine.js";
import { getProtectedRequestAuthFailureAction } from "../src/utils/protectedRequestAuthPolicy.js";
import { createRefreshCoordinator } from "../src/utils/refreshCoordinator.js";
import { shouldLogoutAfterPostRefreshLoadUserFailure } from "../src/utils/authSessionPolicy.js";
import {
  resolveSocketRefreshOutcome,
  shouldAttemptSocketTokenRefresh,
} from "../src/utils/socketSessionPolicy.js";

type RestoreSignal = {
  name: string;
  verdict: () => "keep-session" | "defer-to-auth-restore" | "logout";
};

const restoreWindowHardAuthSignals: RestoreSignal[] = [
  {
    name: "post-refresh /auth/me 401",
    verdict: () => shouldLogoutAfterPostRefreshLoadUserFailure({
      status: 401,
      initialized: true,
      restoreState: "restoring_auth",
    }) ? "logout" : "keep-session",
  },
];

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) =>
    permutations(items.filter((_, i) => i !== index)).map((rest) => [item, ...rest]),
  );
}

test("restore window defers non-authoritative auth-looking signals", () => {
  for (const order of permutations(restoreWindowHardAuthSignals)) {
    const verdicts = order.map((signal) => signal.verdict());

    assert.ok(
      verdicts.every((verdict) => verdict !== "logout"),
      `expected no logout for order: ${order.map((signal) => signal.name).join(" -> ")}`,
    );
  }
});

test("refresh endpoint auth failures are terminal during restore", () => {
  assert.equal(
    getProtectedRequestAuthFailureAction({
      status: 401,
      hasRefreshToken: true,
      initialized: true,
      restoreState: "restoring_auth",
    }),
    "logout",
  );
  assert.equal(
    resolveSocketRefreshOutcome({
      refreshSucceeded: false,
      hasRefreshToken: false,
      initialized: true,
      restoreState: "restoring_auth",
    }),
    "logout",
  );
});

test("transient weak-network failures are evidence, not logout authority", () => {
  for (const status of [undefined, 429, 500, 503]) {
    assert.equal(
      getProtectedRequestAuthFailureAction({
        status,
        hasRefreshToken: true,
        initialized: true,
        restoreState: "authenticated",
      }),
      "keep-session",
      `protected request status ${String(status)} should keep session`,
    );
    assert.equal(
      shouldLogoutAfterPostRefreshLoadUserFailure({
        status,
        initialized: true,
        restoreState: "authenticated",
      }),
      false,
      `post-refresh /auth/me status ${String(status)} should not logout`,
    );
  }

  assert.equal(
    shouldAttemptSocketTokenRefresh({ message: "websocket timeout", refreshInFlight: false }),
    false,
  );
  assert.equal(
    resolveSocketRefreshOutcome({
      refreshSucceeded: false,
      hasRefreshToken: true,
      initialized: true,
      restoreState: "authenticated",
    }),
    "keep-session",
  );
});

test("cross-tab token rotation is monotonic and does not disturb an authenticated tab", async () => {
  let storedAccessToken = "at_1";
  let storedRefreshToken = "rt_1";
  const seenRefreshTokens: string[] = [];

  const firstTab = createRefreshCoordinator({
    readAccessToken: () => storedAccessToken,
    readRefreshToken: () => storedRefreshToken,
    writeTokens: (tokens) => {
      storedAccessToken = tokens.accessToken;
      storedRefreshToken = tokens.refreshToken;
    },
    requestRefresh: async (refreshToken) => {
      seenRefreshTokens.push(refreshToken);
      assert.equal(refreshToken, "rt_1");
      return { accessToken: "at_2", refreshToken: "rt_2" };
    },
  });

  const secondTab = createRefreshCoordinator({
    readAccessToken: () => storedAccessToken,
    readRefreshToken: (() => {
      let reads = 0;
      return () => {
        reads += 1;
        return reads === 1 ? "rt_1" : storedRefreshToken;
      };
    })(),
    writeTokens: (tokens) => {
      storedAccessToken = tokens.accessToken;
      storedRefreshToken = tokens.refreshToken;
    },
    requestRefresh: async (refreshToken) => {
      seenRefreshTokens.push(refreshToken);
      if (refreshToken === "rt_1") {
        const error: any = new Error("Invalid or expired refresh token");
        error.response = { status: 401 };
        throw error;
      }
      assert.equal(refreshToken, "rt_2");
      return { accessToken: "at_3", refreshToken: "rt_3" };
    },
  });

  await firstTab.refresh();
  const secondTokens = await secondTab.refresh();
  const restoredState = nextAuthRestoreStateAfterExternalTokenSync("authenticated");

  assert.deepEqual(secondTokens, { accessToken: "at_2", refreshToken: "rt_2" });
  assert.deepEqual(seenRefreshTokens, ["rt_1"]);
  assert.equal(restoredState, "authenticated");
  assert.equal(getAuthBootstrapView({ initialized: true, restoreState: restoredState }), "ready");
  assert.equal(
    shouldRetryAuthRestore({
      initialized: true,
      restoreState: restoredState,
      hasStoredSession: true,
    }),
    false,
  );
});
