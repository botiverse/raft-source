// Trace upload URL at the core boundary: each daemon (one per attached server)
// takes the receiver its own server names in `machine:context`, only from the
// allowlist, and the owner's env and DISABLED=1 still win.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ServerToMachineMessage } from "@botiverse/raft-shared";
import { DaemonCore } from "./core";
import type { WebSocketLike } from "./connection";
import { DEFAULT_TRACE_UPLOAD_URL, STAGING_TRACE_UPLOAD_URL } from "./traceUploadUrl";

class FakeWebSocket extends EventEmitter implements WebSocketLike {
  readyState = 0;
  send(): void {}
  close(): void { this.readyState = 3; this.emit("close", 1000, Buffer.from("")); }
  terminate(): void { this.readyState = 3; this.emit("close", 1006, Buffer.from("")); }
  emitOpen(): void { this.readyState = 1; this.emit("open"); }
  emitServerMessage(message: ServerToMachineMessage): void { this.emit("message", Buffer.from(JSON.stringify(message))); }
}

type Runner = {
  socket: FakeWebSocket;
  /** Where the core's real uploader sends this runner's own rotating bundle. */
  uploadUrl: () => string | null;
  /** Whether that upload is pinned to the receiver's origin (server-named). */
  pinned: () => boolean;
  /** Where it sends a Computer diagnostics marker. */
  diagUrl: () => string | null;
  resolved: () => { url: string; serverProvided: boolean } | null;
  stop: () => Promise<void>;
};

type UploaderProbe = { stop(): void; workerTargetFor(file: string): { url: string | null; serverProvided: boolean } };

let coreSeq = 0;
async function startRunner(serverUrl: string, options: { privacyMode?: boolean } = {}): Promise<Runner> {
  const root = await mkdtemp(path.join(os.tmpdir(), "raft-daemon-trace-url-"));
  let socket!: FakeWebSocket;
  const core = new DaemonCore({
    serverUrl,
    apiKey: `sk_machine_trace_url_${process.pid}_${++coreSeq}`,
    slockHome: root,
    dataDir: path.join(root, "agents"),
    machineStateDir: path.join(root, "machines"),
    localTrace: true,
    ...(options.privacyMode !== undefined ? { privacyMode: options.privacyMode } : {}),
    runtimeDetector: () => ({ ids: [], versions: {} }),
    connectionOptions: { wsFactory: () => { socket = new FakeWebSocket(); return socket; } },
  });
  core.start();
  const uploader = (core as unknown as { traceBundleUploader: UploaderProbe | null }).traceBundleUploader;
  assert.ok(uploader, "the core installs its trace bundle uploader");
  // Routing only: no timer-driven pass may reach the network from this test.
  uploader.stop();
  socket.emitOpen();
  const target = (name: string) => uploader.workerTargetFor(path.join(root, "machines", "traces", name));
  return {
    socket,
    uploadUrl: () => target("daemon-trace-2026-05-08T00-00-00-000Z-1000-0000.jsonl").url,
    pinned: () => target("daemon-trace-2026-05-08T00-00-00-000Z-1000-0000.jsonl").serverProvided,
    diagUrl: () => target("daemon-trace-diag-correlation-1.jsonl").url,
    resolved: () => (core as unknown as { runnerTraceUploadTarget(): { url: string; serverProvided: boolean } | null }).runnerTraceUploadTarget(),
    stop: async () => {
      await core.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const context = (serverId: string, traceUploadUrl?: string, privacyMode?: boolean): ServerToMachineMessage => ({
  type: "machine:context",
  machineId: `machine-${serverId}`,
  serverId,
  ...(traceUploadUrl !== undefined ? { traceUploadUrl } : {}),
  ...(privacyMode !== undefined ? { privacyMode } : {}),
});

const ENV_KEYS = ["SLOCK_DAEMON_TRACE_UPLOAD_URL", "SLOCK_DAEMON_TRACE_UPLOAD_DISABLED"] as const;
let savedEnv: Record<string, string | undefined> = {};
const runners: Runner[] = [];

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

async function runner(serverUrl: string, options: { privacyMode?: boolean } = {}): Promise<Runner> {
  const r = await startRunner(serverUrl, options);
  runners.push(r);
  return r;
}

test("each attached server's runner uses the URL its own server named", async () => {
  const a = await runner("http://localhost:13055");
  const b = await runner("https://b.example.com");
  // #proj-raft-computer:#54: neither is a Raft server, so nothing until a server names a receiver.
  assert.equal(a.uploadUrl(), null, "before machine:context");

  a.socket.emitServerMessage(context("server-a", "http://localhost:18787"));
  b.socket.emitServerMessage(context("server-b", "https://slock-trace-upload.botiverse.dev"));
  await tick();
  assert.equal(a.uploadUrl(), "http://localhost:18787");
  assert.equal(b.uploadUrl(), "https://slock-trace-upload.botiverse.dev");
  assert.equal(a.pinned(), true, "a server-named receiver is origin-pinned");
  assert.equal(a.diagUrl(), null, "machine-level diag markers never take a server's URL");
  assert.equal(b.diagUrl(), null);
});

test("an older server that sends no traceUploadUrl leaves the default (none for a server that is not Raft's)", async () => {
  const a = await runner("http://localhost:13055");
  a.socket.emitServerMessage(context("server-a", "http://localhost:18787"));
  await tick();
  // A reconnect to a server without the field (e.g. a rollback) drops the old value.
  a.socket.emitServerMessage(context("server-a"));
  await tick();
  assert.equal(a.uploadUrl(), null);

  // On a Raft server the dropped value gives way to that server's default again.
  const staging = await runner("https://api-aws-staging.botiverse.dev");
  staging.socket.emitServerMessage(context("server-staging", "https://slock-trace-upload.botiverse.dev"));
  await tick();
  assert.equal(staging.uploadUrl(), "https://slock-trace-upload.botiverse.dev");
  staging.socket.emitServerMessage(context("server-staging"));
  await tick();
  assert.equal(staging.uploadUrl(), STAGING_TRACE_UPLOAD_URL);
});

test("a URL outside the allowlist is ignored", async () => {
  const a = await runner("https://a.example.com");
  a.socket.emitServerMessage(context("server-a", "https://slock-trace-upload.botiverse.dev.evil.com"));
  await tick();
  assert.equal(a.uploadUrl(), null, "ignored, and a server that is not Raft's has no default");
  assert.equal(a.pinned(), false);
});

test("the owner's env URL beats the server's, and DISABLED=1 beats both", async () => {
  process.env.SLOCK_DAEMON_TRACE_UPLOAD_URL = "https://owner.example";
  const a = await runner("http://localhost:13055");
  a.socket.emitServerMessage(context("server-a", "http://localhost:18787"));
  await tick();
  assert.equal(a.uploadUrl(), "https://owner.example");
  assert.equal(a.pinned(), false, "the owner's own URL keeps today's behaviour");
  process.env.SLOCK_DAEMON_TRACE_UPLOAD_DISABLED = "1";
  assert.equal(a.resolved(), null);
});

test("a remote server cannot point this runner at a loopback receiver", async () => {
  const remote = await runner("https://api.raft.build");
  const local = await runner("http://localhost:13055");
  remote.socket.emitServerMessage(context("server-remote", "http://localhost:18841"));
  local.socket.emitServerMessage(context("server-local", "http://localhost:18841"));
  await tick();
  assert.equal(remote.uploadUrl(), DEFAULT_TRACE_UPLOAD_URL);
  assert.equal(remote.pinned(), false);
  assert.equal(local.uploadUrl(), "http://localhost:18841");
  assert.equal(local.pinned(), true);
});

// #botiverse-raft-deployment:#211: a runner set up with
// `--server-url https://api-aws-staging.botiverse.dev` uploads to staging by
// default (it used to hit production and get 401); diag markers stay on the
// machine-level URL.
test("a runner attached to AWS staging defaults to the staging receiver", async () => {
  const staging = await runner("https://api-aws-staging.botiverse.dev");
  const prod = await runner("https://api.raft.build");
  assert.equal(staging.uploadUrl(), STAGING_TRACE_UPLOAD_URL, "before machine:context");
  staging.socket.emitServerMessage(context("server-staging"));
  prod.socket.emitServerMessage(context("server-prod"));
  await tick();
  assert.equal(staging.uploadUrl(), STAGING_TRACE_UPLOAD_URL);
  assert.equal(staging.pinned(), false);
  assert.equal(prod.uploadUrl(), DEFAULT_TRACE_UPLOAD_URL);
  // Machine-level bundles follow this runner's server too (#proj-raft-computer:#54).
  assert.equal(staging.diagUrl(), STAGING_TRACE_UPLOAD_URL);
  assert.equal(prod.diagUrl(), DEFAULT_TRACE_UPLOAD_URL);
});

// RAFT_PRIVACY_MODE: the daemon is in privacy mode when its own env says so OR
// its server's machine:context does. Either way nothing is uploaded, not even
// to the owner's own URL or Raft's default receiver.
test("RAFT_PRIVACY_MODE (local): no upload URL for this runner's bundles or diag markers", async () => {
  process.env.SLOCK_DAEMON_TRACE_UPLOAD_URL = "https://owner.example";
  const a = await runner("https://api.raft.build", { privacyMode: true });
  assert.equal(a.uploadUrl(), null);
  assert.equal(a.diagUrl(), null);
  a.socket.emitServerMessage(context("server-a", "https://slock-trace-upload.botiverse.dev"));
  await tick();
  assert.equal(a.uploadUrl(), null, "a server-named receiver does not override local privacy");
  assert.equal(a.resolved(), null);
});

test("RAFT_PRIVACY_MODE (server): machine:context privacyMode turns uploads off with the local env unset", async () => {
  const a = await runner("https://api.raft.build");
  assert.equal(a.uploadUrl(), DEFAULT_TRACE_UPLOAD_URL, "before machine:context: unchanged");
  assert.equal(a.diagUrl(), DEFAULT_TRACE_UPLOAD_URL);
  a.socket.emitServerMessage(context("server-a", undefined, true));
  await tick();
  assert.equal(a.uploadUrl(), null);
  assert.equal(a.diagUrl(), null);
  assert.equal(a.resolved(), null);
  // A server without the field (privacy off, or an older server): back to today's behaviour.
  a.socket.emitServerMessage(context("server-a"));
  await tick();
  assert.equal(a.uploadUrl(), DEFAULT_TRACE_UPLOAD_URL);
});
