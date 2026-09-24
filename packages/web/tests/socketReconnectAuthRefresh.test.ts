import test from "node:test";
import assert from "node:assert/strict";
import {
  planReconnectAuthRefresh,
  parseAccessTokenExp,
} from "../src/utils/socketReconnectAuthRefresh.js";

const NOW = 1_700_000_000_000; // fixed ms epoch

test("missing token: skip", () => {
  const action = planReconnectAuthRefresh({
    latestAccessToken: null,
    freshAuth: { token: null, serverId: "s1" },
    parseTokenExp: () => null,
    now: NOW,
  });
  assert.equal(action.type, "skip");
  if (action.type === "skip") {
    assert.equal(action.reason, "no-token");
  }
});

test("fresh token (well above threshold): update-auth-only with fresh auth", () => {
  const fresh = { token: "tok-fresh", serverId: "s1" };
  const action = planReconnectAuthRefresh({
    latestAccessToken: "tok-fresh",
    freshAuth: fresh,
    parseTokenExp: () => NOW + 600_000, // 10 min in future
    now: NOW,
    refreshSoonThresholdMs: 60_000,
  });
  assert.equal(action.type, "update-auth-only");
  if (action.type === "update-auth-only") {
    assert.deepEqual(action.auth, fresh);
  }
});

test("expired token (1s past): trigger-refresh-and-update with reason=expired", () => {
  const action = planReconnectAuthRefresh({
    latestAccessToken: "tok-stale",
    freshAuth: { token: "tok-stale", serverId: "s1" },
    parseTokenExp: () => NOW - 1_000,
    now: NOW,
    refreshSoonThresholdMs: 60_000,
  });
  assert.equal(action.type, "trigger-refresh-and-update");
  if (action.type === "trigger-refresh-and-update") {
    assert.equal(action.reason, "expired");
  }
});

test("near-expiry token (30s left, threshold 60s): trigger-refresh-and-update with reason=near-expiry", () => {
  const action = planReconnectAuthRefresh({
    latestAccessToken: "tok-soon",
    freshAuth: { token: "tok-soon", serverId: "s1" },
    parseTokenExp: () => NOW + 30_000,
    now: NOW,
    refreshSoonThresholdMs: 60_000,
  });
  assert.equal(action.type, "trigger-refresh-and-update");
  if (action.type === "trigger-refresh-and-update") {
    assert.equal(action.reason, "near-expiry");
  }
});

test("malformed token (no exp claim): trigger-refresh-and-update with reason=no-exp-claim", () => {
  const action = planReconnectAuthRefresh({
    latestAccessToken: "garbage",
    freshAuth: { token: "garbage", serverId: "s1" },
    parseTokenExp: () => null,
    now: NOW,
    refreshSoonThresholdMs: 60_000,
  });
  assert.equal(action.type, "trigger-refresh-and-update");
  if (action.type === "trigger-refresh-and-update") {
    assert.equal(action.reason, "no-exp-claim");
  }
});

test("token expiry exactly at now: treated as expired", () => {
  const action = planReconnectAuthRefresh({
    latestAccessToken: "tok-edge",
    freshAuth: { token: "tok-edge", serverId: "s1" },
    parseTokenExp: () => NOW,
    now: NOW,
    refreshSoonThresholdMs: 60_000,
  });
  assert.equal(action.type, "trigger-refresh-and-update");
  if (action.type === "trigger-refresh-and-update") {
    assert.equal(action.reason, "expired");
  }
});

test("default threshold is 60s: 59s remaining is near-expiry", () => {
  const action = planReconnectAuthRefresh({
    latestAccessToken: "tok-edge",
    freshAuth: { token: "tok-edge", serverId: "s1" },
    parseTokenExp: () => NOW + 59_000,
    now: NOW,
    // no refreshSoonThresholdMs override → uses default 60s
  });
  assert.equal(action.type, "trigger-refresh-and-update");
  if (action.type === "trigger-refresh-and-update") {
    assert.equal(action.reason, "near-expiry");
  }
});

// --- parseAccessTokenExp ---

function makeJwtWithExp(expSeconds: number | undefined): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payloadObj: Record<string, unknown> = { sub: "user-1", type: "access" };
  if (expSeconds !== undefined) payloadObj.exp = expSeconds;
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
  return `${header}.${payload}.fakesignature`;
}

test("parseAccessTokenExp extracts exp from a real JWT shape", () => {
  const jwt = makeJwtWithExp(1_777_809_633); // 2026-05-03T12:00:33Z
  const result = parseAccessTokenExp(jwt);
  assert.equal(result, 1_777_809_633_000);
});

test("parseAccessTokenExp returns null on malformed token (no dots)", () => {
  assert.equal(parseAccessTokenExp("not-a-jwt"), null);
});

test("parseAccessTokenExp returns null when exp claim is missing", () => {
  const jwt = makeJwtWithExp(undefined);
  assert.equal(parseAccessTokenExp(jwt), null);
});

test("parseAccessTokenExp returns null when payload is not valid JSON", () => {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const garbage = Buffer.from("not json").toString("base64url");
  assert.equal(parseAccessTokenExp(`${header}.${garbage}.sig`), null);
});

test("parseAccessTokenExp handles tygg's actual leaked token (2026-05-03 incident)", () => {
  // The exact JWT tygg shared in #engineering:bc625a3b msg=8bbd3b7c — verifies
  // the regression from the bug report itself, not just synthetic fixtures.
  const realJwt =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
    "eyJzdWIiOiIzZTdkZGIyMi1hYjRhLTQ1YWItOWU3NS1jNzE1MDJhNmJiMDkiLCJ0eXBlIjoiYWNjZXNzIiwiaWF0IjoxNzc3ODA4NzMzLCJleHAiOjE3Nzc4MDk2MzN9." +
    "ZlLj-PhWyKB_Pe2kP1Jn3OGBmthrDoFhmH9SngqWfKU";
  assert.equal(parseAccessTokenExp(realJwt), 1_777_809_633 * 1000);
});
