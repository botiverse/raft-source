import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTH_REFRESH_REQUEST_TIMEOUT_MS,
  AUTH_REFRESH_ROTATED_REPLAY_GRACE_MS,
  AUTH_REFRESH_ROTATED_TOKEN_WAIT_MS,
  AUTH_REFRESH_ROTATION_DISCOVERY_LAG_BUDGET_MS,
  AUTH_REFRESH_ROTATION_LOSER_WORST_CHAIN_MS,
  AUTH_REFRESH_ROTATION_REPLAY_GRACE_MARGIN_MS,
  AUTH_REFRESH_ROTATION_RETRY_RTT_BUDGET_MS,
} from "./authRefreshTiming.js";

test("auth refresh loser timing remains inside server replay grace", () => {
  assert.equal(
    AUTH_REFRESH_ROTATION_LOSER_WORST_CHAIN_MS,
    AUTH_REFRESH_ROTATION_DISCOVERY_LAG_BUDGET_MS
      + AUTH_REFRESH_ROTATED_TOKEN_WAIT_MS
      + AUTH_REFRESH_ROTATION_RETRY_RTT_BUDGET_MS,
  );
  assert.ok(
    AUTH_REFRESH_ROTATION_LOSER_WORST_CHAIN_MS < AUTH_REFRESH_ROTATED_REPLAY_GRACE_MS,
    "loser discovery + bounded wait + retry RTT must fit inside replay grace",
  );
  assert.ok(
    AUTH_REFRESH_ROTATION_REPLAY_GRACE_MARGIN_MS >= 1_000,
    "replay grace must leave non-trivial margin after the loser fallback chain",
  );
  assert.ok(
    AUTH_REFRESH_REQUEST_TIMEOUT_MS > AUTH_REFRESH_ROTATED_REPLAY_GRACE_MS,
    "the HTTP timeout bounds Web Locks hold time without shortening replay-grace recovery",
  );
});
