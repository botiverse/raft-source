// RAFT_PRIVACY_MODE at the core boundary: on when the daemon's own env says so
// (DaemonCoreOptions.privacyMode) OR its server's machine:context does. Trace
// upload URLs are covered in core.traceUploadUrl.test.ts.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ServerToMachineMessage } from "@botiverse/raft-shared";
import { DaemonCore, FEEDBACK_TRANSCRIPT_PRIVACY_MODE_ERROR } from "./core";
import type { WebSocketLike } from "./connection";

class FakeWebSocket extends EventEmitter implements WebSocketLike {
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  send(data: string): void { this.sent.push(JSON.parse(data) as Record<string, unknown>); }
  close(): void { this.readyState = 3; this.emit("close", 1000, Buffer.from("")); }
  terminate(): void { this.readyState = 3; this.emit("close", 1006, Buffer.from("")); }
  emitOpen(): void { this.readyState = 1; this.emit("open"); }
  emitServerMessage(message: ServerToMachineMessage): void { this.emit("message", Buffer.from(JSON.stringify(message))); }
}

type Started = { core: DaemonCore; socket: FakeWebSocket; collected: () => number; collectArgs: () => unknown[][]; uploads: () => number; stop: () => Promise<void> };

let seq = 0;
async function start(privacyMode?: boolean): Promise<Started> {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-daemon-privacy-"));
  let socket!: FakeWebSocket;
  const core = new DaemonCore({
    serverUrl: "https://api.raft.build",
    apiKey: `sk_machine_privacy_${process.pid}_${++seq}`,
    slockHome: root,
    dataDir: path.join(root, "agents"),
    machineStateDir: path.join(root, "machines"),
    ...(privacyMode !== undefined ? { privacyMode } : {}),
    runtimeDetector: () => ({ ids: [], versions: {} }),
    connectionOptions: { wsFactory: () => { socket = new FakeWebSocket(); return socket; } },
  });
  // Count collections and uploads instead of running them: the refusal must come before both.
  let collected = 0;
  let uploads = 0;
  const collectArgs: unknown[][] = [];
  const manager = (core as unknown as { agentManager: Record<string, unknown> }).agentManager;
  manager.collectFeedbackTranscript = async (...args: unknown[]) => {
    collected += 1;
    collectArgs.push(args);
    return { reachable: true };
  };
  manager.uploadFeedbackTranscriptOutcome = async () => { uploads += 1; return "not_attempted"; };
  manager.uploadFeedbackAgentEventTail = async () => { uploads += 1; return "not_attempted"; };
  core.start();
  socket.emitOpen();
  return {
    core,
    socket,
    collected: () => collected,
    collectArgs: () => collectArgs,
    uploads: () => uploads,
    stop: async () => {
      await core.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const context = (privacyMode?: boolean): ServerToMachineMessage => ({
  type: "machine:context",
  machineId: "machine-privacy",
  serverId: "server-privacy",
  ...(privacyMode !== undefined ? { privacyMode } : {}),
});
const feedbackRequest: ServerToMachineMessage = {
  type: "agent:diagnostic:feedback_transcript",
  agentId: "agent-privacy",
  feedbackReportId: "report-1",
  requestId: "request-1",
};

function feedbackResults(socket: FakeWebSocket) {
  return socket.sent.filter((frame) => frame.type === "agent:diagnostic:feedback_transcript_result");
}

const started: Started[] = [];
afterEach(async () => {
  for (const s of started.splice(0)) await s.stop();
});

async function startTracked(privacyMode?: boolean): Promise<Started> {
  const s = await start(privacyMode);
  started.push(s);
  return s;
}

test("local privacy mode: a feedback transcript is not collected; the server gets the collector's error result", async () => {
  const s = await startTracked(true);
  s.socket.emitServerMessage(context());
  s.socket.emitServerMessage(feedbackRequest);
  await tick();
  assert.equal(s.collected(), 0);
  const [result] = feedbackResults(s.socket);
  assert.equal(result?.reachable, false);
  assert.equal(result?.error, FEEDBACK_TRANSCRIPT_PRIVACY_MODE_ERROR);
  assert.equal(result?.outcomeObject, "not_attempted_worker_not_configured");
  assert.equal(s.uploads(), 0, "nothing is uploaded after the frame");
});

test("server privacy mode (local env unset): machine:context privacyMode refuses collection", async () => {
  const s = await startTracked();
  s.socket.emitServerMessage(context(true));
  await tick();
  s.socket.emitServerMessage(feedbackRequest);
  await tick();
  assert.equal(s.collected(), 0);
  assert.equal(feedbackResults(s.socket)[0]?.error, FEEDBACK_TRANSCRIPT_PRIVACY_MODE_ERROR);
  assert.equal(s.uploads(), 0);
});

test("privacy mode off: the feedback transcript is collected as before", async () => {
  const s = await startTracked();
  s.socket.emitServerMessage(context());
  s.socket.emitServerMessage(feedbackRequest);
  await tick();
  assert.equal(s.collected(), 1);
  assert.equal(feedbackResults(s.socket)[0]?.reachable, true);
});

// The request's `sessionLookup` (the agent's launch fields, the env vars its
// session directory depends on, and the stored session id) reaches the
// collection, read as untrusted JSON.
test("a feedback request's sessionLookup reaches the collection; only session-home env keys are kept; a malformed one is dropped", async () => {
  const s = await startTracked();
  s.socket.emitServerMessage(context());
  s.socket.emitServerMessage({
    ...feedbackRequest,
    // A server that sent more than it should: the daemon keeps CODEX_HOME alone.
    sessionLookup: { runtime: "codex", model: "gpt-5.6", sessionHomeEnv: { CODEX_HOME: "/srv/codex", ANTHROPIC_API_KEY: "sk-not-for-here", GROK_HOME: "/srv/grok" }, runtimeConfig: { envVars: { ANTHROPIC_API_KEY: "sk-not-for-here" } }, sessionId: "session-1" },
  } as ServerToMachineMessage);
  s.socket.emitServerMessage({ ...feedbackRequest, requestId: "request-2", sessionLookup: { runtime: 7, sessionId: "x" } } as unknown as ServerToMachineMessage);
  s.socket.emitServerMessage({ ...feedbackRequest, requestId: "request-3", sessionLookup: { runtime: "claude", model: "sonnet", sessionHomeEnv: { CODEX_HOME: "/x" }, sessionId: { not: "a string" } } } as unknown as ServerToMachineMessage);
  s.socket.emitServerMessage({ ...feedbackRequest, requestId: "request-4" });
  await tick();
  const lookups = s.collectArgs().map((args) => (args[3] as { serverLookup?: unknown }).serverLookup);
  assert.deepEqual(lookups, [
    { runtime: "codex", model: "gpt-5.6", sessionHomeEnv: { CODEX_HOME: "/srv/codex" }, sessionId: "session-1" },
    null,
    { runtime: "claude", model: "sonnet", sessionHomeEnv: null, sessionId: null },
    null,
  ]);
});
