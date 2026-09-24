import assert from "node:assert/strict";
import test from "node:test";
import {
  getSocketAuthErrorRecoveryAction,
  resolveSocketRefreshOutcome,
  shouldAttemptSocketTokenRefresh,
} from "../src/utils/socketSessionPolicy.js";

test("socket auth-looking connect_error triggers a token refresh attempt", () => {
  assert.equal(
    shouldAttemptSocketTokenRefresh({
      message: "Authentication expired",
      refreshInFlight: false,
    }),
    true,
  );
  assert.equal(
    shouldAttemptSocketTokenRefresh({
      message: "Invalid token",
      refreshInFlight: false,
    }),
    true,
  );
});

test("authorization changes during server handshake use the existing recovery path", () => {
  assert.equal(getSocketAuthErrorRecoveryAction({
    message: "Authentication changed; reconnect required",
    refreshInFlight: false,
    socketAuthToken: "access-current",
    latestAccessToken: "access-current",
  }), "refresh-token");
});

test("socket auth error matching is case-insensitive", () => {
  assert.equal(
    shouldAttemptSocketTokenRefresh({
      message: "authentication failed",
      refreshInFlight: false,
    }),
    true,
  );
  assert.equal(
    shouldAttemptSocketTokenRefresh({
      message: "INVALID TOKEN",
      refreshInFlight: false,
    }),
    true,
  );
});

test("non-auth socket errors do not trigger a refresh attempt", () => {
  assert.equal(
    shouldAttemptSocketTokenRefresh({
      message: "websocket timeout",
      refreshInFlight: false,
    }),
    false,
  );
  assert.equal(
    shouldAttemptSocketTokenRefresh({
      message: "transport close",
      refreshInFlight: false,
    }),
    false,
  );
});

test("socket auth errors do not start a second refresh while one is already in flight", () => {
  assert.equal(
    shouldAttemptSocketTokenRefresh({
      message: "Authentication failed",
      refreshInFlight: true,
    }),
    false,
  );
});

test("socket auth error retries with latest local access token before refreshing", () => {
  assert.equal(
    getSocketAuthErrorRecoveryAction({
      message: "Invalid or expired token",
      refreshInFlight: false,
      socketAuthToken: "access-old",
      latestAccessToken: "access-new",
    }),
    "retry-with-latest-token",
  );
});

test("socket auth error refreshes only when socket auth matches latest token", () => {
  assert.equal(
    getSocketAuthErrorRecoveryAction({
      message: "Invalid or expired token",
      refreshInFlight: false,
      socketAuthToken: "access-old",
      latestAccessToken: "access-old",
    }),
    "refresh-token",
  );
});

test("socket auth recovery ignores non-auth and in-flight refresh cases", () => {
  assert.equal(
    getSocketAuthErrorRecoveryAction({
      message: "websocket timeout",
      refreshInFlight: false,
      socketAuthToken: "access-old",
      latestAccessToken: "access-new",
    }),
    "ignore",
  );
  assert.equal(
    getSocketAuthErrorRecoveryAction({
      message: "Invalid or expired token",
      refreshInFlight: true,
      socketAuthToken: "access-old",
      latestAccessToken: "access-new",
    }),
    "ignore",
  );
});

test("successful socket refresh retries the websocket connection", () => {
  assert.equal(
    resolveSocketRefreshOutcome({
      refreshSucceeded: true,
      hasRefreshToken: true,
      initialized: true,
      restoreState: "authenticated",
    }),
    "retry",
  );
});

test("transient socket refresh failure keeps the session when a refresh token still exists", () => {
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

test("socket refresh failure logs out when refresh token is missing during restore", () => {
  assert.equal(
    resolveSocketRefreshOutcome({
      refreshSucceeded: false,
      hasRefreshToken: false,
      initialized: false,
      restoreState: "booting",
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

test("socket refresh failure logs out when there is no refresh token left", () => {
  assert.equal(
    resolveSocketRefreshOutcome({
      refreshSucceeded: false,
      hasRefreshToken: false,
      initialized: true,
      restoreState: "authenticated",
    }),
    "logout",
  );
});
