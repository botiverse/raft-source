import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldKeepSessionAfterLoadUserFailure,
  shouldLogoutAfterPostRefreshLoadUserFailure,
  shouldLogoutAfterRefreshFailure,
  shouldRetryLoadUserAfterError,
} from "../src/utils/authSessionPolicy.js";

type RequestOutcome =
  | { kind: "success" }
  | { kind: "failure"; status?: number; hasRefreshToken?: boolean };

function simulateLoadUserFlow(params: {
  initialMe: RequestOutcome;
  refresh: RequestOutcome;
  retryMe?: RequestOutcome;
  initialized?: boolean;
  restoreState?: "booting" | "signed_out" | "restoring_auth" | "authenticated";
}): "loaded" | "kept-session" | "logged-out" {
  const initialized = params.initialized ?? true;
  const restoreState = params.restoreState ?? "authenticated";
  if (params.initialMe.kind === "success") return "loaded";

  const initialStatus = params.initialMe.status;
  if (shouldKeepSessionAfterLoadUserFailure(initialStatus)) {
    return "kept-session";
  }
  if (!shouldRetryLoadUserAfterError(initialStatus)) {
    return "kept-session";
  }

  if (params.refresh.kind === "failure") {
    if (shouldLogoutAfterRefreshFailure({
      status: params.refresh.status,
      hasRefreshToken: params.refresh.hasRefreshToken ?? true,
    })) {
      return "logged-out";
    }
    return "kept-session";
  }

  const retryMe = params.retryMe ?? { kind: "success" as const };
  if (retryMe.kind === "success") return "loaded";

  return shouldLogoutAfterPostRefreshLoadUserFailure({
    status: retryMe.status,
    initialized,
    restoreState,
  })
    ? "logged-out"
    : "kept-session";
}

function simulateProtectedRequest401Flow(refresh: RequestOutcome): "retried" | "kept-session" | "logged-out" {
  if (refresh.kind === "success") return "retried";
  return shouldLogoutAfterRefreshFailure({
    status: refresh.status,
    hasRefreshToken: refresh.hasRefreshToken ?? true,
  })
    ? "logged-out"
    : "kept-session";
}

test("loadUser keeps the session when /auth/me fails transiently before any refresh attempt", () => {
  const result = simulateLoadUserFlow({
    initialMe: { kind: "failure", status: 503 },
    refresh: { kind: "failure", status: undefined, hasRefreshToken: true },
  });

  assert.equal(result, "kept-session");
});

test("loadUser keeps the session when access token refresh fails transiently", () => {
  const result = simulateLoadUserFlow({
    initialMe: { kind: "failure", status: 401 },
    refresh: { kind: "failure", status: undefined, hasRefreshToken: true },
  });

  assert.equal(result, "kept-session");
});

test("loadUser logs out when refresh fails with an explicit auth error", () => {
  const result = simulateLoadUserFlow({
    initialMe: { kind: "failure", status: 401 },
    refresh: { kind: "failure", status: 403, hasRefreshToken: true },
  });

  assert.equal(result, "logged-out");
});

test("loadUser logs out on refresh auth error while restore is still deciding", () => {
  const result = simulateLoadUserFlow({
    initialMe: { kind: "failure", status: 401 },
    refresh: { kind: "failure", status: 401, hasRefreshToken: true },
    initialized: true,
    restoreState: "restoring_auth",
  });

  assert.equal(result, "logged-out");
});

test("loadUser keeps the session when the post-refresh /auth/me retry fails transiently", () => {
  const result = simulateLoadUserFlow({
    initialMe: { kind: "failure", status: 401 },
    refresh: { kind: "success" },
    retryMe: { kind: "failure", status: 502 },
  });

  assert.equal(result, "kept-session");
});

test("loadUser logs out when the post-refresh /auth/me retry fails with an auth error", () => {
  const result = simulateLoadUserFlow({
    initialMe: { kind: "failure", status: 401 },
    refresh: { kind: "success" },
    retryMe: { kind: "failure", status: 401 },
  });

  assert.equal(result, "logged-out");
});

test("loadUser does not logout on post-refresh /auth/me auth error while restore is still deciding", () => {
  const result = simulateLoadUserFlow({
    initialMe: { kind: "failure", status: 401 },
    refresh: { kind: "success" },
    retryMe: { kind: "failure", status: 401 },
    initialized: true,
    restoreState: "restoring_auth",
  });

  assert.equal(result, "kept-session");
});

test("protected request retries when refresh succeeds", () => {
  const result = simulateProtectedRequest401Flow({
    kind: "success",
  });

  assert.equal(result, "retried");
});

test("protected request keeps the session when refresh fails transiently", () => {
  const result = simulateProtectedRequest401Flow({
    kind: "failure",
    status: 500,
    hasRefreshToken: true,
  });

  assert.equal(result, "kept-session");
});

test("protected request logs out when refresh token is missing", () => {
  const result = simulateProtectedRequest401Flow({
    kind: "failure",
    status: undefined,
    hasRefreshToken: false,
  });

  assert.equal(result, "logged-out");
});

test("protected request logs out when refresh fails with 401/403", () => {
  assert.equal(
    simulateProtectedRequest401Flow({ kind: "failure", status: 401, hasRefreshToken: true }),
    "logged-out",
  );
  assert.equal(
    simulateProtectedRequest401Flow({ kind: "failure", status: 403, hasRefreshToken: true }),
    "logged-out",
  );
});
