// Server features at the core boundary: the daemon asks only a server that
// advertises `server:features-v1`, once per connection and again after a
// `server:features-changed` for its own server, and hands only the answer to
// its latest request on that server to the agent manager.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SERVER_CAPABILITY_SERVER_FEATURES_V1,
  type AgentServerFeatures,
  type ServerToMachineMessage,
} from "@botiverse/raft-shared";
import { DaemonCore, type DaemonCoreOptions } from "./core";
import type { WebSocketLike } from "./connection";

class FakeWebSocket extends EventEmitter implements WebSocketLike {
  readyState = 0;
  readonly sent: unknown[] = [];
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(): void { this.readyState = 3; this.emit("close", 1000, Buffer.from("")); }
  terminate(): void { this.readyState = 3; this.emit("close", 1006, Buffer.from("")); }
  emitOpen(): void { this.readyState = 1; this.emit("open"); }
  emitServerMessage(message: ServerToMachineMessage): void { this.emit("message", Buffer.from(JSON.stringify(message))); }
  requests(): string[] {
    return this.sent.flatMap((msg) => (msg as { type?: string }).type === "server:features:request" ? [(msg as { requestId: string }).requestId] : []);
  }
}

let coreSeq = 0;

async function withCore(
  fn: (ctx: { socket: FakeWebSocket; applied: AgentServerFeatures[]; managerCalls: string[] }) => Promise<void>,
  refresh: DaemonCoreOptions["serverFeaturesRefresh"] = {},
): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-daemon-server-features-"));
  const sockets: FakeWebSocket[] = [];
  let ids = 0;
  // A key of our own: the machine lock is keyed by server URL + API key.
  const core = new DaemonCore({
    serverUrl: "https://daemon.example.com",
    apiKey: `sk_machine_features_${process.pid}_${++coreSeq}`,
    dataDir,
    runtimeDetector: () => ({ ids: [], versions: {} }),
    serverFeaturesRefresh: { random: () => 0, newRequestId: () => `req-${++ids}`, ...refresh },
    connectionOptions: { wsFactory: () => { const socket = new FakeWebSocket(); sockets.push(socket); return socket; } },
  });
  const applied: AgentServerFeatures[] = [];
  (core as any).agentManager.applyServerFeatures = (features: AgentServerFeatures) => applied.push(features);
  const managerCalls: string[] = [];
  (core as any).agentManager.setServerFeaturesCapable = (capable: boolean) => managerCalls.push(`capable:${capable}`);
  (core as any).agentManager.forgetServerFeatures = () => managerCalls.push("forget");
  try {
    core.start();
    const socket = sockets[0]!;
    socket.emitOpen();
    await fn({ socket, applied, managerCalls });
  } finally {
    await core.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const context = (capabilities: string[]): ServerToMachineMessage =>
  ({ type: "machine:context", machineId: "machine-test", serverId: "server-test", capabilities });
const changed = (serverId: string): ServerToMachineMessage => ({ type: "server:features-changed", serverId, keys: ["workspace_artifacts"] });
const answer = (requestId: string, serverId: string, features: AgentServerFeatures): ServerToMachineMessage =>
  ({ type: "server:features", requestId, serverId, features });

test("a server that does not advertise server:features-v1 is never asked", async () => {
  await withCore(async ({ socket }) => {
    socket.emitServerMessage(context([]));
    socket.emitServerMessage(changed("server-test"));
    await tick();
    assert.deepEqual(socket.requests(), []);
  });
});

test("one request per connection, another per change of this server, and only the latest answer is applied", async () => {
  await withCore(async ({ socket, applied }) => {
    socket.emitServerMessage(context([SERVER_CAPABILITY_SERVER_FEATURES_V1]));
    await tick();
    assert.deepEqual(socket.requests(), ["req-1"], "the (re)connect refresh");

    socket.emitServerMessage(answer("req-1", "server-other", { enabledApps: ["artifacts"] }));
    socket.emitServerMessage(answer("req-0", "server-test", { enabledApps: ["artifacts"] }));
    await tick();
    assert.deepEqual(applied, [], "another server's values, or an unknown request, are dropped");
    socket.emitServerMessage(answer("req-1", "server-test", { enabledApps: ["artifacts"] }));
    await tick();
    assert.deepEqual(applied, [{ enabledApps: ["artifacts"] }]);

    socket.emitServerMessage(changed("server-other"));
    await tick();
    assert.deepEqual(socket.requests(), ["req-1"], "a change of another server asks nothing");
    socket.emitServerMessage(changed("server-test"));
    socket.emitServerMessage(changed("server-test"));
    await tick();
    assert.deepEqual(socket.requests(), ["req-1", "req-2"], "a burst of changes asks once");
    socket.emitServerMessage(answer("req-1", "server-test", { taskConversations: true }));
    socket.emitServerMessage(answer("req-2", "server-test", { reminderApp: true }));
    await tick();
    assert.deepEqual(applied, [{ enabledApps: ["artifacts"] }, { reminderApp: true }]);
  });
});

test("a context without the capability cancels a refresh still waiting", async () => {
  const timers: Array<{ ms: number; cleared: boolean }> = [];
  await withCore(async ({ socket }) => {
    socket.emitServerMessage(context([SERVER_CAPABILITY_SERVER_FEATURES_V1]));
    socket.emitServerMessage(context([]));
    await tick();
    assert.equal(timers.length, 1, "the first context started a delay");
    assert.equal(timers[0]!.cleared, true, "the second one, without the capability, cleared it");
    assert.deepEqual(socket.requests(), []);
  }, {
    setTimeout: (_callback, ms) => { const timer = { ms, cleared: false }; timers.push(timer); return timer; },
    clearTimeout: (handle) => { (handle as { cleared: boolean }).cleared = true; },
  });
});

test("a dropped connection keeps the agents' last answer; a context without the capability forgets it", async () => {
  await withCore(async ({ socket, managerCalls }) => {
    socket.emitServerMessage(context([SERVER_CAPABILITY_SERVER_FEATURES_V1]));
    socket.close();
    await tick();
    assert.deepEqual(managerCalls, ["capable:true", "capable:false"], "a plain disconnect forgets nothing");
  });
  await withCore(async ({ socket, managerCalls }) => {
    socket.emitServerMessage(context([]));
    await tick();
    assert.deepEqual(managerCalls, ["capable:false", "forget"]);
  });
});
