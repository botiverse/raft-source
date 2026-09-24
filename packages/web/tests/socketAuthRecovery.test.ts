import assert from "node:assert/strict";
import test from "node:test";
import { recoverSocketAuthWithLatestToken } from "../src/utils/socketAuthRecovery.js";

class FakeSocket {
  public auth: Record<string, unknown> = { token: "access-old", serverId: "server-1" };
  public connectCalls = 0;

  connect() {
    this.connectCalls += 1;
  }
}

test("socket auth error with newer local token reconnects without requiring refresh", () => {
  const socket = new FakeSocket();

  const result = recoverSocketAuthWithLatestToken({
    socket,
    message: "Invalid or expired token",
    refreshInFlight: false,
    latestAccessToken: "access-new",
    buildFreshAuth: () => ({ token: "access-new", serverId: "server-1" }),
  });

  assert.equal(result, "retried-with-latest-token");
  assert.deepEqual(socket.auth, { token: "access-new", serverId: "server-1" });
  assert.equal(socket.connectCalls, 1);
});

test("socket auth error with current local token still requires refresh", () => {
  const socket = new FakeSocket();

  const result = recoverSocketAuthWithLatestToken({
    socket,
    message: "Invalid or expired token",
    refreshInFlight: false,
    latestAccessToken: "access-old",
    buildFreshAuth: () => ({ token: "access-new", serverId: "server-1" }),
  });

  assert.equal(result, "needs-refresh");
  assert.deepEqual(socket.auth, { token: "access-old", serverId: "server-1" });
  assert.equal(socket.connectCalls, 0);
});
