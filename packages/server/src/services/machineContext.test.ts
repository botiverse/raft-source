import assert from "node:assert/strict";

import { machineTraceUploadUrl, sendAuthenticatedMachineContext } from "./machineContext";
import { serverMachineContextCapabilities } from "../runtimeOutcomeOutboxIngest";
import { setPrivacyModeForTest } from "../config/privacyMode";

test("authenticated machine context serializes the exact accepted owner identities", () => {
  const sent: string[] = [];
  sendAuthenticatedMachineContext({ send: (data) => sent.push(data) }, {
    machineId: "machine-1",
    serverId: "server-1",
  });
  // task #1268: the server now always advertises at least the async-detection
  // capability, so the frame carries the current list verbatim.
  assert.deepEqual(sent.map((data) => JSON.parse(data)), [{
    type: "machine:context",
    machineId: "machine-1",
    serverId: "server-1",
    capabilities: serverMachineContextCapabilities(),
  }]);
  assert.ok(serverMachineContextCapabilities().includes("machine:runtime-detection-async-v1"));
});

test("machine context send failure is synchronous so the route can fail closed", () => {
  assert.throws(() => sendAuthenticatedMachineContext({
    send: () => { throw new Error("socket closed"); },
  }, {
    machineId: "machine-1",
    serverId: "server-1",
  }), /socket closed/);
});

// task #1268: the WebSocket 101 response pre-reads the same capability list
// the `machine:context` frame carries, and `machine:context` now declares
// ready-before-detection.
import { machineUpgradeCapabilitiesHeader } from "../routes/daemon";
import { RAFT_SERVER_CAPABILITIES_HEADER, SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1 } from "@botiverse/raft-shared";

test("task #1268: machine:context and the upgrade response both declare runtime-detection-async-v1", () => {
  const caps = serverMachineContextCapabilities();
  assert.ok(caps.includes(SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1));
  assert.ok(serverMachineContextCapabilities(false).includes(SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1), "offered even when outbox acks are off");
  const header = machineUpgradeCapabilitiesHeader(caps);
  assert.ok(header);
  assert.match(header!, new RegExp(`^${RAFT_SERVER_CAPABILITIES_HEADER}: `));
  assert.ok(header!.split(": ")[1]!.split(" ").includes(SERVER_CAPABILITY_RUNTIME_DETECTION_ASYNC_V1));
  assert.equal(machineUpgradeCapabilitiesHeader([]), null, "no header when nothing is advertised");
  assert.equal(machineUpgradeCapabilitiesHeader([" ", ""]), null);
});

test("traceUploadUrl is sent only when SLOCK_MACHINE_TRACE_UPLOAD_URL is set", () => {
  assert.equal(machineTraceUploadUrl({}), undefined);
  assert.equal(machineTraceUploadUrl({ SLOCK_MACHINE_TRACE_UPLOAD_URL: "  " }), undefined);
  assert.equal(machineTraceUploadUrl({ SLOCK_MACHINE_TRACE_UPLOAD_URL: " http://localhost:18787 " }), "http://localhost:18787");

  const sent: string[] = [];
  const socket = { send: (data: string) => sent.push(data) };
  const ids = { machineId: "machine-1", serverId: "server-1" };
  sendAuthenticatedMachineContext(socket, ids, [], undefined);
  sendAuthenticatedMachineContext(socket, ids, [], "http://localhost:18787");
  const [without, withUrl] = sent.map((data) => JSON.parse(data) as Record<string, unknown>);
  assert.equal("traceUploadUrl" in without!, false, "an unconfigured server's frame is unchanged for every daemon");
  assert.deepEqual(withUrl, { type: "machine:context", ...ids, traceUploadUrl: "http://localhost:18787" });
});

test("RAFT_PRIVACY_MODE: machine:context carries privacyMode and never a trace upload URL", () => {
  const env = { SLOCK_MACHINE_TRACE_UPLOAD_URL: "http://localhost:18787" };
  const ids = { machineId: "machine-1", serverId: "server-1" };
  const sent: string[] = [];
  const socket = { send: (data: string) => sent.push(data) };
  setPrivacyModeForTest(true);
  try {
    assert.equal(machineTraceUploadUrl(env), undefined);
    sendAuthenticatedMachineContext(socket, ids, []);
    // Even a URL handed in explicitly stays off the frame.
    sendAuthenticatedMachineContext(socket, ids, [], "http://localhost:18787");
  } finally {
    setPrivacyModeForTest(false);
  }
  for (const frame of sent.map((data) => JSON.parse(data))) {
    assert.deepEqual(frame, { type: "machine:context", ...ids, privacyMode: true });
  }
  // Off: no field at all, so the frame is byte-for-byte what it was.
  sendAuthenticatedMachineContext(socket, ids, [], undefined);
  assert.equal(sent.at(-1), JSON.stringify({ type: "machine:context", ...ids }));
});
