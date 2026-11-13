import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import {
  BasicTracer,
  createSpanAttrContractTracer,
  MemoryTraceSink,
  type AgentConfig,
  type AgentMessage,
  type MachineToServerMessage,
} from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager";
import { DAEMON_CORE_TRACE_ATTR_CONTRACTS } from "./core";
import { PiDriver, PiSdkRuntimeSession, PiSdkSessionHandle } from "./drivers/pi";
import { newestPiSessionFile } from "./drivers/piSessionRotation";
import type { RuntimeSession, SpawnContext } from "./drivers/types";
import { releaseAgentManagerForTests } from "./testing/agentManagerTeardown";
import { COMPACTION_END, compactedSession, FakePiSession } from "./testing/fakePiSession";
import { installManagedRunnerCredentialFetch } from "./testing/managedRunnerCredentialFetch";
import { traceRows } from "./testing/traceRows";

// pi session rotation, the delivery contract (Tenny on #10699): while a
// rotation reopens the session, the pi runtime accepts input and queues it,
// and APM counts an accepted input as told. So an inbox delivery during a
// reopen that fails must still reach a live session: the runtime undoes the
// files and keeps the old session, which then takes the input. The real APM
// runs here over the real pi runtime session; only pi's AgentSession is a
// stand-in, so the test can make the reopen fail.

const SESSION_ID = "pi-rotation-apm";

/** A pi driver whose runtime sessions open stand-in SDK sessions. */
class StandInPiDriver extends PiDriver {
  constructor(private readonly factory: ConstructorParameters<typeof PiSdkRuntimeSession>[2]) {
    super();
  }

  override createSession(ctx: SpawnContext): RuntimeSession {
    this.sessionId = ctx.config.sessionId || null;
    return new PiSdkRuntimeSession(ctx, (sessionId) => {
      this.sessionId = sessionId;
    }, this.factory);
  }
}

function message(content: string, seq: number): AgentMessage {
  return {
    channel_id: "channel-1", channel_name: "general", channel_type: "channel", sender_id: "user-1", sender_name: "richard",
    sender_type: "human", content, timestamp: "2026-10-21T10:00:00.000Z", message_id: `m-${seq}`, seq,
  };
}

async function waitUntil(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("an inbox delivery during a rotation whose reopen fails reaches the old session, and the agent goes on", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "slock-pi-rotation-apm-"));
  const sessionDir = path.join(root, "sessions");
  mkdirSync(sessionDir, { recursive: true });
  const original = compactedSession(sessionDir, root, SESSION_ID);
  const oldFile = original.getSessionFile()!;
  await new Promise((resolve) => setTimeout(resolve, 5));

  let failReopen!: (error: Error) => void;
  const reopenGate = new Promise<void>((_resolve, reject) => { failReopen = reject; });
  const old = new FakePiSession(original);
  let reopens = 0;
  const handle = new PiSdkSessionHandle(old as unknown as AgentSession, async () => {
    reopens += 1;
    await reopenGate;
    return new PiSdkSessionHandle(new FakePiSession(SessionManager.open(newestPiSessionFile(sessionDir, SESSION_ID)!, sessionDir, root)) as unknown as AgentSession, async () => assert.fail("no second reopen"));
  });

  const sent: MachineToServerMessage[] = [];
  const sink = new MemoryTraceSink();
  const restoreFetch = installManagedRunnerCredentialFetch();
  const manager = new AgentProcessManager((msg) => sent.push(msg), "sk_machine_test", {
    dataDir: root,
    serverUrl: "https://daemon.example.com",
    slockHome: root,
    slockCliPath: "__cli",
    runtimeSessionHomeDir: root,
    driverResolver: () => new StandInPiDriver(async () => handle),
    tracer: createSpanAttrContractTracer(new BasicTracer({ sink }), DAEMON_CORE_TRACE_ATTR_CONTRACTS),
  });
  const config: AgentConfig = {
    name: "pi-agent", displayName: "Pi Agent", description: "test agent", model: "anthropic/claude-sonnet", runtime: "pi",
    reasoningEffort: null, envVars: { RAFT_PI_SESSION_ROTATION_MIN_BYTES: "1" }, sessionId: SESSION_ID,
    serverUrl: "https://daemon.example.com", authToken: "sk_machine_test", agentCredentialKey: "sk_agent_test", agentCredentialId: null,
    piSessionRotation: true,
  };
  const idle = () => (manager as any).agents.get("agent-1")?.gatedSteering.isIdle === true;
  try {
    await manager.startAgent("agent-1", config, undefined, undefined, undefined, "launch-pi-rotation");
    await waitUntil(() => old.prompts.length === 1 && idle(), "the start turn");

    // pi compacts at the end of a run; the run settles: the turn end APM sees offers the rotation.
    old.emit(COMPACTION_END);
    old.emit({ type: "agent_end", messages: [] });
    old.emit({ type: "agent_settled", aborted: false });
    await waitUntil(() => reopens === 1, "the rotation's reopen");
    assert.equal(existsSync(`${oldFile}.rotated`), true, "precondition: the files were rotated");

    // An inbox delivery while the reopen is in flight: APM sees an idle agent and writes it.
    assert.equal(await manager.deliverMessage("agent-1", message("hello during the rotation", 701)), true);
    assert.deepEqual(
      traceRows(sink).filter((row) => row.name === "daemon.agent.stdin_delivery").map((row) => [row.attrs?.mode, row.attrs?.outcome]),
      [["idle", "written"]],
      "APM counted it as delivered",
    );
    assert.equal(old.prompts.length, 1, "precondition: still queued in the runtime");

    failReopen(new Error("reopen broke"));
    await waitUntil(() => old.prompts.length === 2 && idle(), "the queued delivery's turn");

    assert.match(old.prompts[1]!, /message/i, "the inbox update reached the old, live session");
    assert.equal(old.disposed, false);
    assert.equal((manager as any).agents.get("agent-1")?.exit.kind, "live", "the runtime did not end");
    assert.ok(!sent.some((msg) => msg.type === "agent:status" && msg.status === "inactive"), "the agent was never marked inactive");
    assert.equal(newestPiSessionFile(sessionDir, SESSION_ID), oldFile, "the files are back as they were");
    assert.deepEqual(
      traceRows(sink).filter((row) => row.name === "pi.session.rotation_failed").map((row) => [row.attrs?.stage, row.attrs?.outcome]),
      [["resume", "kept_old"]],
    );
  } finally {
    await manager.stopAgent("agent-1").catch(() => {});
    await releaseAgentManagerForTests(manager);
    restoreFetch();
    rmSync(root, { recursive: true, force: true });
  }
});
