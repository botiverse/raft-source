import assert from "node:assert/strict";
import test from "node:test";
import { shouldLogoutAfterPostRefreshLoadUserFailure } from "../src/utils/authSessionPolicy.js";
import { resolveSocketRefreshOutcome } from "../src/utils/socketSessionPolicy.js";

type Event = "post-refresh-me-401" | "socket-connect-error-auth-failed";

function applyEventDuringRestore(event: Event): "keep-session" | "logout" {
  if (event === "post-refresh-me-401") {
    return shouldLogoutAfterPostRefreshLoadUserFailure({
      status: 401,
      initialized: true,
      restoreState: "restoring_auth",
    })
      ? "logout"
      : "keep-session";
  }

  return resolveSocketRefreshOutcome({
    refreshSucceeded: false,
    hasRefreshToken: false,
    initialized: true,
    restoreState: "restoring_auth",
  }) === "logout"
    ? "logout"
    : "keep-session";
}

test("auth restore defers /auth/me 401 but treats missing refresh token as terminal", () => {
  const orders: Event[][] = [
    ["post-refresh-me-401", "socket-connect-error-auth-failed"],
    ["socket-connect-error-auth-failed", "post-refresh-me-401"],
  ];

  for (const order of orders) {
    assert.deepEqual(
      order.map(applyEventDuringRestore),
      order.map((event) => event === "socket-connect-error-auth-failed" ? "logout" : "keep-session"),
    );
  }
});

test("after auth restore is settled, hard auth failures may logout", () => {
  assert.equal(
    shouldLogoutAfterPostRefreshLoadUserFailure({
      status: 401,
      initialized: true,
      restoreState: "authenticated",
    }),
    true,
  );
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
