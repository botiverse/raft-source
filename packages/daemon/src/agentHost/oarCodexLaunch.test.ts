import assert from "node:assert/strict";
import { BasicTracer, MemoryTraceSink, createSpanAttrContractTracer, type AgentConfig } from "@botiverse/raft-shared";
import { buildCodexAppServerArgs, codexThreadFields } from "../drivers/index";
import type { SpawnContext } from "../drivers/types";
import type { RawEvent } from "@botiverse/oar";
import { awaitCodexManagedMcp, codexOarLaunch, prepareCodexOarLaunch } from "./oarCodexLaunch";
import { DAEMON_CORE_TRACE_ATTR_CONTRACTS } from "../core";
import { traceRows } from "../testing/traceRows";
import { launchEnvOverlay } from "./oarGrokLaunch";

const ctx = (overrides: Partial<AgentConfig> = {}): SpawnContext => ({
  agentId: "agent-1",
  config: {
    name: "c", displayName: null, description: null, model: "gpt-5.5", runtime: "codex", reasoningEffort: "high",
    envVars: null, sessionId: null, serverUrl: "http://localhost:3001", authToken: "", ...overrides,
  },
  standingPrompt: "standing instructions",
  prompt: "first input",
  workingDirectory: "/work/agent-1",
  slockCliPath: "/bin/raft",
  daemonApiKey: "sk_machine_test",
});

const managedMcp = { name: "raft", endpointUrl: "http://127.0.0.1:4100/mcp", token: "mcp-token" } as const;

function prep(mcp: { name: string; endpointUrl: string; token: string } | null = managedMcp, args?: string[], windowsShim?: string) {
  const appServerArgs = buildCodexAppServerArgs(mcp);
  return {
    command: "/opt/codex",
    appServerArgs,
    args: args ?? appServerArgs,
    spawnEnv: { PATH: "/bin", NO_COLOR: "1" },
    appServerEnv: { PATH: "/bin", NO_COLOR: "1", ...(mcp ? { RAFT_MANAGED_MCP_TOKEN: mcp.token } : {}) },
    windowsShim,
    managedMcp: mcp as never,
  };
}

test("a codex launch: the driver's executable and env, managed MCP as a session MCP server, appended standing prompt, model, effort, tier; busy deliveries steer", () => {
  const { firstInputReady, ...launch } = codexOarLaunch(ctx(), prep(), { SLOCK_API_KEY: "secret" });
  assert.equal(typeof firstInputReady, "function", "the first input waits for the managed MCP server");
  assert.deepEqual(launch, {
    runtimeId: "codex",
    installation: { kind: "available", via: "executable", command: "/opt/codex" },
    options: {
      cwd: "/work/agent-1",
      env: { PATH: "/bin", NO_COLOR: "1", SLOCK_API_KEY: null },
      appendSystemPrompt: "standing instructions",
      model: "gpt-5.5",
      effort: "high",
      serviceTier: "default",
      mcpServers: [{ name: "raft", type: "http", url: "http://127.0.0.1:4100/mcp", headers: { Authorization: "Bearer mcp-token" } }],
      endTurnProcessesOnAbort: true,
    },
    busyDelivery: "now",
    managedMcpServerName: "raft",
  });
  // #oar-raft:#8: the token is only in the session's MCP entry (OAR sends it
  // over the app-server's stdin): not in the arguments, not in the environment.
  assert.equal(launch.options.launchArgs, undefined, "no driver -c overrides");
  assert.equal(JSON.stringify(launch.options.env).includes("mcp-token"), false);
  // Never `systemPrompt`: on codex that replaces Codex's own base prompt.
  assert.equal(launch.options.systemPrompt, undefined);
});

test("the server the first input waits for is the one the launch attaches", async () => {
  const launch = codexOarLaunch(ctx(), prep(), {});
  const attached = launch.options.mcpServers?.map((server) => server.name);
  assert.deepEqual(attached, [launch.managedMcpServerName]);
  const session = streamSession([mcpStatus(attached![0]!, "ready")]);
  const ready = await launch.firstInputReady!(session as never, new AbortController().signal);
  assert.equal(ready.outcome, "ready");
  assert.equal(ready.waitedFor, "managed_mcp");
});

test("a resumed codex launch keeps the standing prompt and an explicit tier; fast mode asks for Codex's own id", () => {
  const resumed = codexOarLaunch(ctx({ sessionId: "thread-9", runtimeConfig: { version: 1, runtime: "codex", model: { kind: "preset", id: "gpt-5.5" }, mode: { kind: "fast" } } } as Partial<AgentConfig>), prep(null), {});
  assert.equal(resumed.options.resume, "thread-9");
  assert.equal(resumed.options.appendSystemPrompt, "standing instructions");
  assert.equal(resumed.options.serviceTier, "priority");
  assert.equal(resumed.options.launchArgs, undefined);
  assert.equal(resumed.options.mcpServers, undefined, "no managed MCP server, no mcpServers");
  // OAR does not record it: a resume supplies it again.
  assert.equal(resumed.options.endTurnProcessesOnAbort, true);
  assert.equal(resumed.firstInputReady, undefined, "no managed MCP server, nothing to wait for");
  // No model chosen: the same model the driver would send (the catalog default).
  const bare = ctx({ model: undefined, reasoningEffort: undefined });
  const bareLaunch = codexOarLaunch(bare, prep(null), {});
  assert.equal(bareLaunch.options.model, codexThreadFields(bare).model);
  assert.equal(bareLaunch.options.effort, undefined);
  assert.equal(bareLaunch.options.serviceTier, "default");
});

test("Windows: a codex the driver runs through a node host goes to OAR as the npm shim it came from, with the transport env", () => {
  const appServerArgs = buildCodexAppServerArgs(null);
  const shim = String.raw`C:\Users\bot\AppData\Roaming\npm\codex.cmd`;
  const viaNodeHost = {
    ...prep(null, ["--no-deprecation", String.raw`C:\Users\bot\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js`, ...appServerArgs], shim),
    command: String.raw`C:\Program Files\Raft\Raft.exe`,
    // The Electron node host's env is not for the node OAR runs the shim with.
    appServerEnv: { PATH: "/bin", NO_COLOR: "1", ELECTRON_RUN_AS_NODE: "1" },
  };
  const launch = codexOarLaunch(ctx(), viaNodeHost, {});
  assert.deepEqual(launch.installation, { kind: "available", via: "executable", command: shim });
  assert.deepEqual(launch.options.env, { PATH: "/bin", NO_COLOR: "1" });
  // A native codex.exe (Desktop, or a shim that wraps the .exe) carries over as it is.
  const native = codexOarLaunch(ctx(), { ...prep(null, undefined, shim), command: String.raw`C:\Codex\bin\codex.exe` }, {});
  assert.deepEqual(native.installation, { kind: "available", via: "executable", command: String.raw`C:\Codex\bin\codex.exe` });
  // No shim OAR runs without cmd.exe (none, or one naming its target by an
  // absolute path, so the resolver left it out): the start falls back to the legacy host.
  assert.throws(() => codexOarLaunch(ctx(), prep(null, ["C:/npm/codex.js", ...appServerArgs]), {}), /host command/);
});

test("#14189: an OAR Codex launch records which install it picked on `daemon.runtime.node_host_launch`, path-free and through the daemon's attr contract", async () => {
  const appServerArgs = buildCodexAppServerArgs(null);
  const shim = String.raw`C:\Users\bot\AppData\Roaming\npm\codex.cmd`;
  const winPrep = (shimPath: string | undefined) => ({
    ...prep(null, ["--no-deprecation", String.raw`C:\Users\bot\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js`, ...appServerArgs], shimPath),
    command: String.raw`C:\Program Files\Raft\Raft.exe`,
    shell: false as const,
    // The Desktop candidate timed out and a PATH .cmd was refused before the npm install was picked.
    source: "npm_global" as const,
    rejectedCandidateCount: 2,
    rejectionKind: "timeout+batch_wrapper",
    candidateEnv: { ELECTRON_RUN_AS_NODE: "1" },
    codexHomeRoot: null,
  });
  const sink = new MemoryTraceSink();
  const tracer = createSpanAttrContractTracer(new BasicTracer({ sink }), DAEMON_CORE_TRACE_ATTR_CONTRACTS);
  const launch = await prepareCodexOarLaunch({ ...ctx(), launchId: "launch-1", tracer }, async () => winPrep(shim));
  assert.deepEqual(launch.installation, { kind: "available", via: "executable", command: shim });
  // No shim OAR can run: the span ends in error and the start falls back to the legacy driver.
  await assert.rejects(prepareCodexOarLaunch({ ...ctx(), launchId: "launch-2", tracer }, async () => winPrep(undefined)), /host command/);

  const spans = traceRows(sink).filter((span) => span.name === "daemon.runtime.node_host_launch");
  assert.deepEqual(spans.map((span) => [span.status, span.attrs]), [
    ["ok", { agentId: "agent-1", launchId: "launch-1", runtime: "codex", host: "oar", candidate_source: "npm_global", rejected_candidate_count: 2, rejection_kind: "timeout+batch_wrapper" }],
    ["error", { agentId: "agent-1", launchId: "launch-2", runtime: "codex", host: "oar", candidate_source: "npm_global", rejected_candidate_count: 2, rejection_kind: "timeout+batch_wrapper", error_class: "Error" }],
  ]);
  assert.doesNotMatch(JSON.stringify(spans.map((span) => span.attrs)), /\\|codex\.(?:cmd|js)|Raft\.exe/i, "no paths");
});

test("Windows: the daemon's `Path` is not removed under the launch's `PATH` (OAR drops every spelling of a name it sets or removes)", () => {
  const spawnEnv = { PATH: String.raw`C:\raft\wrapper;C:\Windows`, NO_COLOR: "1" };
  const inherited = { Path: String.raw`C:\Windows`, SLOCK_API_KEY: "secret" };
  const overlay = launchEnvOverlay(spawnEnv, inherited, "win32");
  assert.deepEqual(overlay, { PATH: spawnEnv.PATH, NO_COLOR: "1", SLOCK_API_KEY: null });
  // No `Path: null`: OAR sets `PATH` over every spelling of the name, so the child gets the wrapper's PATH.
  assert.equal(Object.keys(overlay).filter((name) => name.toUpperCase() === "PATH").length, 1);
  // Elsewhere names are case-sensitive, as before.
  assert.equal(launchEnvOverlay(spawnEnv, inherited, "linux").Path, null);
});

/** A session whose stream holds `recorded` and can be fed more. */
function streamSession(recorded: RawEvent[] = []) {
  const observers = new Set<(record: RawEvent) => void>();
  let unsubscribed = 0;
  return {
    id: "thread-1",
    rawEvents: (observer: (record: RawEvent) => void) => {
      for (const record of recorded) observer(record);
      observers.add(observer);
      return () => { observers.delete(observer); unsubscribed += 1; };
    },
    feed: (record: RawEvent) => { for (const observer of [...observers]) observer(record); },
    observers: () => observers.size,
    unsubscribed: () => unsubscribed,
  };
}

let seq = 0;
const mcpStatus = (name: string, status: string): RawEvent => ({
  kind: "frame", sessionId: "thread-1", agentPath: [], seq: seq++, receivedAt: 0,
  body: { type: "mcpServer/startupStatus/updated", native: { name, status }, events: [] },
} as RawEvent);

test("the first codex input waits for codex to report the managed MCP server started, or failed", async () => {
  const session = streamSession();
  const waiting = awaitCodexManagedMcp(session, "raft", new AbortController().signal, 5_000);
  session.feed(mcpStatus("other-server", "ready"));
  session.feed(mcpStatus("raft", "starting"));
  assert.equal(session.observers(), 1, "still waiting: another server, or not started yet");
  session.feed(mcpStatus("raft", "ready"));
  assert.equal((await waiting).outcome, "ready");
  assert.equal(session.observers(), 0);

  const failed = streamSession();
  const waitingFailed = awaitCodexManagedMcp(failed, "raft", new AbortController().signal, 5_000);
  failed.feed(mcpStatus("raft", "cancelled"));
  assert.deepEqual({ ...(await waitingFailed), waitedMs: 0 }, { waitedFor: "managed_mcp", outcome: "failed", waitedMs: 0 });
});

test("a report codex gave before the thread opened counts (the stream is replayed from its start)", async () => {
  const session = streamSession([mcpStatus("raft", "ready")]);
  assert.equal((await awaitCodexManagedMcp(session, "raft", new AbortController().signal, 5_000)).outcome, "ready");
  assert.equal(session.observers(), 0, "unsubscribed although it settled during the subscribe call");
});

test("Codex exiting before it reports ends the wait (nothing more will come)", async () => {
  const session = streamSession();
  const waiting = awaitCodexManagedMcp(session, "raft", new AbortController().signal, 5_000);
  session.feed({ kind: "response", sessionId: "thread-1", agentPath: [], seq: seq++, receivedAt: 0, requestId: "", body: { kind: "exited", code: 1 } } as RawEvent);
  assert.equal((await waiting).outcome, "exited");
  assert.equal(session.observers(), 0);
});

test("the wait is bounded, and a stop ends it", async () => {
  const session = streamSession();
  assert.equal((await awaitCodexManagedMcp(session, "raft", new AbortController().signal, 10)).outcome, "timeout");
  assert.equal(session.observers(), 0);
  const stop = new AbortController();
  const waiting = awaitCodexManagedMcp(session, "raft", stop.signal, 5_000);
  stop.abort();
  assert.equal((await waiting).outcome, "stopped");
  assert.equal(session.observers(), 0);
  const stopped = new AbortController();
  stopped.abort();
  assert.equal((await awaitCodexManagedMcp(session, "raft", stopped.signal, 5_000)).outcome, "stopped");
  assert.equal(session.observers(), 0, "never subscribed after a stop");
});
