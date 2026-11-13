// task #1102 — no-process residency invariants must never take the whole
// daemon down. Field (2026-09-13, two machines): one agent's stale no-process
// facts made EVERY agent's read/history/send fail with
// LOCAL_DAEMON_STATE_INVALID until a daemon restart.
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asAxSurfaceText, type AgentConfig, type AgentMessage } from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager";
import { setDaemonFetchImplForTests } from "./daemonFetch";
import type { RuntimeDriver } from "./drivers/index";
import { promptConfig } from "./testing/promptFixture";
import type { AgentLifecycleRecords } from "./agentLifecycleRecord";
import type { AgentStartPendingDeliveryBuffer } from "./agentStartPendingDeliveryBuffer";
import { drainAgentManagerForTests } from "./testing/agentManagerTeardown";

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  readonly signalCode = null;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = { write: () => true };
  kill(): boolean {
    queueMicrotask(() => {
      this.exitCode = 0;
      this.emit("exit", 0, null);
      this.emit("close", 0, null);
    });
    return true;
  }
}

type ManagerInternals = {
  agents: Map<string, { inbox: AgentMessage[] }>;
  lifecycleRecords: AgentLifecycleRecords;
  startingInboxes: AgentStartPendingDeliveryBuffer;
  refuseUnreliableSpawn(agentId: string, start: { config: AgentConfig; wakeMessage?: AgentMessage; wakeMessageTransient: boolean; launchId?: string }, detail: string, spawnTraceparent: string): void;
  consumeVisibleMessages(agentId: string, input: { messages: AgentMessage[]; source: string }): void;
};

function internals(manager: AgentProcessManager): ManagerInternals {
  return manager as unknown as ManagerInternals;
}

function makeMessage(content: string, overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    channel_id: "channel-1",
    channel_name: "general",
    channel_type: "channel",
    sender_id: "user-1",
    sender_name: "richard",
    sender_type: "human",
    content,
    timestamp: "2026-09-13T01:35:31.000Z",
    ...overrides,
  };
}

async function withManager(run: (manager: AgentProcessManager) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-residency-test-"));
  const driver: RuntimeDriver = {
    id: "prompt-test",
    lifecycle: { kind: "persistent", stdin: "direct", inFlightWake: "steer" },
    communication: { chat: "slock_cli", runtimeControl: "none" },
    session: { recovery: "resume_or_fresh", compaction: "reported", compactionFailure: "does_not_stick" } as const,
    model: { detectedModelsVerifiedAs: "suggestion_only" },
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    supportsNativeStandingPrompt: true,
    buildSystemPrompt: () => asAxSurfaceText("standing"),
    spawn: () => ({ process: new FakeChild() as unknown as ChildProcess }),
    parseLine: () => [],
    encodeStdinMessage: (text) => text,
  };
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.includes("/internal/computer/runners/") && method === "POST") {
      return Response.json({ apiKey: "sk_agent_prompt_test", credentialId: "prompt-test" }, { status: 201 });
    }
    if (url.includes("/internal/computer/runners/") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  setDaemonFetchImplForTests(fetch as never);
  const manager = new AgentProcessManager(() => {}, "sk_machine_test", {
    dataDir, slockHome: dataDir, runtimeSessionHomeDir: dataDir,
    daemonVersion: "1.0.1-test", computerVersion: "2.0.1-test",
    serverUrl: "https://raft.example.test", driverResolver: () => driver,
  });
  try {
    await run(manager);
  } finally {
    await drainAgentManagerForTests(manager);
    try {
      await manager.stopAll();
    } finally {
      fetch.mockRestore();
      setDaemonFetchImplForTests(undefined);
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}

/**
 * Drive `victim` into the real terminal residency with one buffered message.
 * Reconciler step 12: terminal records are RFC 071's refused spawn's only
 * (`refuseUnreliableSpawn`); a runtime's own failure no longer writes one.
 */
async function terminalFailureWithPendingInbox(manager: AgentProcessManager, victim: string): Promise<void> {
  const m = internals(manager);
  m.refuseUnreliableSpawn(victim, {
    config: promptConfig({ name: victim, displayName: victim }),
    wakeMessage: makeMessage("buffered while failing", { message_id: `${victim}-pending`, seq: 7 }),
    wakeMessageTransient: false,
    launchId: `${victim}-launch`,
  }, "the runtime outcome of the last launch is unknown", "");
  expect(m.lifecycleRecords.getTerminalFailure(victim)).toBeTruthy();
  expect(m.startingInboxes.has(victim)).toBe(true);
}

test("stopping a terminal-failed agent with a buffered inbox leaves no orphan pending delivery (I4)", async () => {
  await withManager(async (manager) => {
    await manager.startAgent("bystander", promptConfig({ name: "bystander", displayName: "Bystander" }));
    await terminalFailureWithPendingInbox(manager, "victim");

    // Field sequence: the web sends agent:stop for an agent with no process.
    await manager.stopAgent("victim");

    const m = internals(manager);
    expect(m.startingInboxes.has("victim")).toBe(false);
    // Another agent reading its own inbox (CLI visible-consume) must succeed.
    expect(() => m.consumeVisibleMessages("bystander", {
      messages: [makeMessage("hello bystander", { message_id: "bystander-1", seq: 8 })],
      source: "agent_api_events_local",
    })).not.toThrow();
  });
});

test("one agent's orphan pending delivery does not fail another agent's visible-consume (blast radius)", async () => {
  await withManager(async (manager) => {
    await manager.startAgent("bystander", promptConfig({ name: "bystander", displayName: "Bystander" }));
    const m = internals(manager);
    // Inject the exact corrupt fact observed in the field: pending delivery for
    // an agent with no queued/starting/terminal/cooldown residency.
    m.startingInboxes.bufferDuringStart("ghost", makeMessage("orphan", { message_id: "ghost-1", seq: 9 }));

    expect(() => m.consumeVisibleMessages("bystander", {
      messages: [makeMessage("hello bystander", { message_id: "bystander-2", seq: 10 })],
      source: "agent_api_events_local",
    })).not.toThrow();
    // The corrupt fact is repaired, not merely tolerated.
    expect(m.startingInboxes.has("ghost")).toBe(false);
  });
});

test("terminal failure plus idle restart config for one agent does not fail another agent's visible-consume (I2 blast radius)", async () => {
  await withManager(async (manager) => {
    await manager.startAgent("bystander", promptConfig({ name: "bystander", displayName: "Bystander" }));
    const m = internals(manager);
    // Force both facts through the raw maps to model an older daemon's state.
    const records = m.lifecycleRecords as unknown as {
      terminalFailures: Map<string, unknown>;
      idleRestartSnapshots: Map<string, unknown>;
    };
    records.terminalFailures.set("cindy", { detail: "runtime error", launchId: "launch-cindy" });
    records.idleRestartSnapshots.set("cindy", {
      config: promptConfig({ name: "cindy", displayName: "Cindy" }),
      sessionId: "session-cindy",
      launchId: "launch-cindy",
    });

    expect(() => m.consumeVisibleMessages("bystander", {
      messages: [makeMessage("hello bystander", { message_id: "bystander-3", seq: 11 })],
      source: "agent_api_events_local",
    })).not.toThrow();
    // Repair keeps the wakeable fact: the agent can restart on its next message.
    expect(m.lifecycleRecords.getTerminalFailure("cindy")).toBeUndefined();
    expect(m.lifecycleRecords.getRestartSnapshot("cindy")).toBeTruthy();
  });
});

test("a terminal-failed agent can be started again by an explicit start (field: Cindy 2026-09-11)", async () => {
  await withManager(async (manager) => {
    await terminalFailureWithPendingInbox(manager, "cindy");
    await expect(manager.startAgent("cindy", promptConfig({ name: "cindy", displayName: "Cindy" }))).resolves.toBeUndefined();
    const m = internals(manager);
    expect(m.agents.has("cindy")).toBe(true);
    expect(m.lifecycleRecords.getTerminalFailure("cindy")).toBeUndefined();
  });
});
