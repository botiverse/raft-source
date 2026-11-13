// #oar-raft:#10 in the agent manager (the legacy host): Cursor's two session
// stores. A start naming a Cursor SDK session (`agent-<uuid>`, the OAR
// host's) cannot resume it with the Cursor CLI: it starts a new session, the
// server forgets the old one (`runtime_host_migration`) and the owner sees an
// Activity Log row with the reason. A Cursor CLI session is resumed as before.
// Helpers are slimmed copies per this repo's APM test convention.
//
// RED proof: drop runtimeHostSessionDrop from withStartSessionChoice and the
// SDK session reaches `cursor-agent --resume`; drop the invalidate or the row
// in traceSessionDroppedForSpec and their assertions fail.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { asAxSurfaceText, type AgentConfig, type AxSurfaceText, type MachineToServerMessage } from "@botiverse/raft-shared";
import { AgentProcessManager, CURSOR_CLI_MIGRATION_TEXT } from "./agentProcessManager";
import { buildCursorArgs } from "./drivers/cursor";
import type { RuntimeDriver, SpawnContext, SpawnResult, ParsedEvent } from "./drivers/index";
import { releaseAgentManagerForTests } from "./testing/agentManagerTeardown";

const SDK_SESSION = "agent-0b9e8f2a-5c1d-4e7f-9a3b-2d6c8e4f1a07";
const CLI_SESSION = "0b9e8f2a-5c1d-4e7f-9a3b-2d6c8e4f1a07";

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: () => true };
  kills = 0;

  get killed(): boolean {
    return this.kills > 0;
  }

  kill(): boolean {
    this.kills += 1;
    this.emit("exit", 143, "SIGTERM");
    this.emit("close", 143, "SIGTERM");
    return true;
  }
}

/** Stands in for the cursor driver: records each spawn's context, never runs cursor-agent. */
class FakeCursorDriver implements RuntimeDriver {
  readonly acceptsStdinDuringCompaction = true;
  readonly id = "cursor";
  readonly lifecycle = { kind: "persistent", stdin: "direct", inFlightWake: "steer" } as const;
  readonly communication = { chat: "slock_cli", runtimeControl: "none" } as const;
  readonly session = { recovery: "resume_or_fresh", compaction: "reported", compactionFailure: "does_not_stick" } as const;
  readonly model = { detectedModelsVerifiedAs: "launchable" } as const;
  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "direct" as const;
  readonly liveSessionReadyAt = "turn_end" as const;
  readonly terminateProcessOnTurnEnd = false;
  readonly spawnCalls: SpawnContext[] = [];

  spawn(ctx: SpawnContext): SpawnResult {
    this.spawnCalls.push(ctx);
    return { process: new FakeChildProcess() as unknown as ChildProcess };
  }

  parseLine(_line: string): ParsedEvent[] {
    return [];
  }

  encodeStdinMessage(text?: string): string | null {
    return text ? JSON.stringify({ text }) : null;
  }

  buildSystemPrompt(): AxSurfaceText {
    return asAxSurfaceText("standing prompt");
  }
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "agent",
    displayName: "Agent",
    description: "test agent",
    model: "default",
    runtime: "cursor",
    reasoningEffort: null,
    envVars: null,
    sessionId: null,
    serverUrl: "http://localhost:3001",
    authToken: "sk_machine_test",
    agentCredentialKey: "sk_agent_test",
    // No credential id: a stop would revoke it over the network.
    agentCredentialId: null,
    ...overrides,
  };
}

async function withManager(fn: (ctx: { driver: FakeCursorDriver; manager: AgentProcessManager; frames: MachineToServerMessage[]; events: Array<{ name: string; attrs: Record<string, unknown> }> }) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "slock-cursor-session-host-test-"));
  const driver = new FakeCursorDriver();
  const frames: MachineToServerMessage[] = [];
  const manager = new AgentProcessManager(
    (msg) => { frames.push(msg); },
    "sk_machine_test",
    { dataDir, serverUrl: "https://daemon.example.com", driverResolver: () => driver, runtimeSessionHomeDir: dataDir },
  );
  const events: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  const recordDaemonEvent = (manager as any).recordDaemonEvent.bind(manager);
  (manager as any).recordDaemonEvent = (name: string, attrs: Record<string, unknown> = {}, ...rest: unknown[]) => {
    events.push({ name, attrs });
    return recordDaemonEvent(name, attrs, ...rest);
  };
  try {
    await fn({ driver, manager, frames, events });
  } finally {
    await releaseAgentManagerForTests(manager);
    await rm(dataDir, { recursive: true, force: true });
  }
}

const systemRows = (frames: MachineToServerMessage[]) => frames
  .flatMap((frame) => frame.type === "agent:activity" ? frame.entries ?? [] : [])
  .filter((entry) => entry.kind === "system");

test("a Cursor SDK session is never handed to cursor-agent --resume: a new session, the server forgets it, the owner is told why", async () => {
  await withManager(async ({ driver, manager, frames, events }) => {
    await manager.startAgent("agent-sdk", makeConfig({ sessionId: SDK_SESSION, envVars: { OPENAI_API_KEY: "x" } }));
    assert.equal(driver.spawnCalls.length, 1);
    const spawned = driver.spawnCalls[0]!;
    assert.equal(spawned.config.sessionId, null, "a new session");
    assert.equal(buildCursorArgs(spawned, "linux").includes("--resume"), false);
    assert.ok(events.some((event) => event.name === "daemon.agent.session_dropped_for_spec" && event.attrs.reason === "runtime_host_changed" && event.attrs.host === "legacy"));
    const invalidates = frames.filter((frame): frame is Extract<MachineToServerMessage, { type: "agent:session:invalidate" }> => frame.type === "agent:session:invalidate");
    assert.deepEqual(invalidates.map((frame) => [frame.agentId, frame.sessionId, frame.reason]), [["agent-sdk", SDK_SESSION, "runtime_host_migration"]]);
    const rows = systemRows(frames);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind === "system" ? rows[0]!.text : "", CURSOR_CLI_MIGRATION_TEXT);
  });
});

test("a Cursor CLI session is kept and resumed, with no invalidate and no row", async () => {
  await withManager(async ({ driver, manager, frames, events }) => {
    await manager.startAgent("agent-cli", makeConfig({ sessionId: CLI_SESSION }));
    assert.equal(driver.spawnCalls.length, 1);
    const spawned = driver.spawnCalls[0]!;
    assert.equal(spawned.config.sessionId, CLI_SESSION);
    const args = buildCursorArgs(spawned, "linux");
    assert.equal(args[args.indexOf("--resume") + 1], CLI_SESSION);
    assert.equal(events.some((event) => event.name === "daemon.agent.session_dropped_for_spec"), false);
    assert.equal(frames.some((frame) => frame.type === "agent:session:invalidate"), false);
    assert.deepEqual(systemRows(frames), []);
  });
});

test("the row names the likely reason: Cursor through the SDK off or not available (env vars no longer are one)", () => {
  assert.match(CURSOR_CLI_MIGRATION_TEXT, /off or not available/);
  assert.match(CURSOR_CLI_MIGRATION_TEXT, /new Cursor session/);
  assert.doesNotMatch(CURSOR_CLI_MIGRATION_TEXT, /environment variables/);
});
