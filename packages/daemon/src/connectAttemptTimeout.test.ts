import assert from "node:assert/strict";
import net from "node:net";
import { applyDaemonConnectAttemptTimeout, DAEMON_CONNECT_ATTEMPT_TIMEOUT_MS } from "./connectAttemptTimeout";

const original = net.getDefaultAutoSelectFamilyAttemptTimeout();
afterEach(() => net.setDefaultAutoSelectFamilyAttemptTimeout(original));

test("#47: the daemon gives each resolved address seconds, not Node's 250 ms, to connect", () => {
  net.setDefaultAutoSelectFamilyAttemptTimeout(250);
  applyDaemonConnectAttemptTimeout();
  assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), DAEMON_CONNECT_ATTEMPT_TIMEOUT_MS);
  // Above the ~1 s connect seen on the affected machines, and below the shared pool's 10 s connect timeout.
  assert.ok(DAEMON_CONNECT_ATTEMPT_TIMEOUT_MS >= 2_000 && DAEMON_CONNECT_ATTEMPT_TIMEOUT_MS < 10_000);
});

test("#47: a longer setting made elsewhere is kept", () => {
  net.setDefaultAutoSelectFamilyAttemptTimeout(5_000);
  applyDaemonConnectAttemptTimeout();
  assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), 5_000);
});
