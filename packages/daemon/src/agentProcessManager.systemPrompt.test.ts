import { EventEmitter } from "node:events";
import { stripInboxPreviewLines } from "./testing/inboxPreview";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asAxSurfaceText, type AgentConfig, type AgentMessage } from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager";
import { setDaemonFetchImplForTests } from "./daemonFetch";
import { formatResumeEmptyPrompt, formatResumeUnreadSummaryPrompt } from "./agentRuntimeInput";
import type { RuntimeDriver, SpawnContext } from "./drivers/index";
import { buildCopilotArgs, CopilotDriver } from "./drivers/copilot";
import { buildCursorArgs, CursorDriver } from "./drivers/cursor";
import { GeminiDriver } from "./drivers/gemini";
import { afterFreshSessionStandingPrompt, afterStartupMemoryBlock, promptConfig } from "./testing/promptFixture";

class PromptChild extends EventEmitter {
  exitCode: number | null = null;
  readonly signalCode = null;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = { write: () => true };
  kill(): boolean {
    // Real children exit after kill returns; let stopAgent install its waiter.
    queueMicrotask(() => {
      this.exitCode = 0;
      this.emit("exit", 0, null);
      this.emit("close", 0, null);
    });
    return true;
  }
}

async function withPromptManager(
  nativeStandingPrompt: boolean | RuntimeDriver,
  run: (ctx: { manager: AgentProcessManager; driver: RuntimeDriver; spawns: SpawnContext[] }) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-prompt-test-"));
  const spawns: SpawnContext[] = [];
  const driver: RuntimeDriver = typeof nativeStandingPrompt !== "boolean" ? nativeStandingPrompt : {
    id: "prompt-test",
    lifecycle: { kind: "persistent", stdin: "direct", inFlightWake: "steer" },
    communication: { chat: "slock_cli", runtimeControl: "none" },
    session: { recovery: "resume_or_fresh", compaction: "reported", compactionFailure: "does_not_stick" } as const,
    model: { detectedModelsVerifiedAs: "suggestion_only" },
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    supportsNativeStandingPrompt: nativeStandingPrompt,
    // A sentinel isolates routing from copy. Real rendered instructions are
    // covered by drivers/systemPrompt.snapshot.test.ts.
    buildSystemPrompt: (config: AgentConfig) => asAxSurfaceText(`standing:${config.description}`),
    spawn: (ctx) => {
      spawns.push(ctx);
      return { process: new PromptChild() as unknown as ChildProcess };
    },
    parseLine: () => [],
    encodeStdinMessage: (text) => text,
  };
  if (typeof nativeStandingPrompt !== "boolean") {
    // A real driver: everything but the child process.
    driver.spawn = async (ctx) => {
      spawns.push(ctx);
      return { process: new PromptChild() as unknown as ChildProcess };
    };
  }
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
    await run({ manager, driver, spawns });
  } finally {
    try {
      await manager.stopAll();
    } finally {
      fetch.mockRestore();
      setDaemonFetchImplForTests(undefined);
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}

test.each([true, false])("cold start routes standing instructions with native support=%s", async (native) => {
  await withPromptManager(native, async ({ manager, spawns }) => {
    await manager.startAgent("agent-1", promptConfig({ description: "initial-role" }));
    expect(spawns).toHaveLength(1);
    expect(spawns[0].standingPrompt).toBe("standing:initial-role");
    // Without a native layer the standing prompt comes first; then the startup
    // MEMORY.md block (RFC 070, always on) and the neutral starter.
    const afterStandingPrompt = native ? spawns[0].prompt : afterFreshSessionStandingPrompt(spawns[0]);
    expect(afterStartupMemoryBlock(afterStandingPrompt)).toBe("Start.");
    if (native) expect(spawns[0].prompt).not.toContain("standing:");
  });
});

const wakeMessage = (overrides: Partial<AgentMessage> = {}): AgentMessage => ({
  message_id: "wake-1", channel_id: "channel-1", channel_name: "general", channel_type: "channel",
  sender_id: "human-1", sender_name: "bob", sender_type: "human",
  content: "message-body-sentinel", timestamp: "2026-09-05T00:00:00.000Z",
  ...overrides,
});

// Every way a fresh session can start. Without a native standing prompt the
// first input is the only place the runtime ever sees it.
const freshStarts: Array<[string, (manager: AgentProcessManager) => Promise<void>, RegExp]> = [
  ["a wake message", (manager) => manager.startAgent("agent-1", promptConfig({ description: "role" }), wakeMessage()), /^\[Raft inbox notice:/],
  ["a transient wake", (manager) => manager.startAgent("agent-1", promptConfig({ description: "role" }), wakeMessage(), undefined, undefined, undefined, true), /^System notice received:/],
  ["resume catch-up for a dropped session", (manager) => manager.startAgent("agent-1", promptConfig({ description: "role" }), undefined, undefined, undefined, "launch-1", false, [wakeMessage()]), /message-body-sentinel/],
  ["a release notice", (manager) => manager.startAgent("agent-1", promptConfig({
    description: "role",
    runtimeProfileControl: { kind: "daemon_release_notice", key: "release-1", message: "Daemon v9 released" } as never,
  })), /^Start\.$/],
];

test.each(freshStarts)("a fresh session started by %s opens with the standing prompt when the runtime has no native one", async (_label, start, rest) => {
  await withPromptManager(false, async ({ manager, spawns }) => {
    await start(manager);
    expect(spawns).toHaveLength(1);
    expect(spawns[0].config.sessionId ?? null).toBeNull();
    expect(afterStartupMemoryBlock(afterFreshSessionStandingPrompt(spawns[0]))).toMatch(rest);
  });
});

test.each(freshStarts)("a native runtime's fresh session started by %s keeps the standing prompt out of its first input", async (_label, start) => {
  await withPromptManager(true, async ({ manager, spawns }) => {
    await start(manager);
    expect(spawns).toHaveLength(1);
    expect(spawns[0].standingPrompt).toBe("standing:role");
    expect(spawns[0].prompt).not.toContain("standing:");
  });
});

test.each([
  ["cursor", () => new CursorDriver(), (ctx: SpawnContext) => buildCursorArgs(ctx).at(-1)],
  ["gemini", () => new GeminiDriver(), (ctx: SpawnContext) => ctx.prompt],
  ["copilot", () => new CopilotDriver(), (ctx: SpawnContext) => { const args = buildCopilotArgs(ctx); return args[args.indexOf("-p") + 1]; }],
] as const)("%s: a session-less wake sends the full standing prompt ahead of the message", async (runtime, makeDriver, sentInput) => {
  const driver: RuntimeDriver = makeDriver();
  expect(driver.supportsNativeStandingPrompt ?? false).toBe(false);
  await withPromptManager(driver, async ({ manager, spawns }) => {
    await manager.startAgent("agent-1", promptConfig({ runtime, description: "standing-role-sentinel" }), wakeMessage());
    expect(spawns).toHaveLength(1);
    expect(spawns[0].standingPrompt).toContain("standing-role-sentinel");
    expect(sentInput(spawns[0])).toBe(spawns[0].prompt);
    expect(afterStartupMemoryBlock(afterFreshSessionStandingPrompt(spawns[0]))).toMatch(/^\[Raft inbox notice:/);
  });
});

test("prompt construction receives the resolved workspace and spawn receives live versions", async () => {
  await withPromptManager(true, async ({ manager, driver, spawns }) => {
    driver.buildSystemPrompt = (config) => asAxSurfaceText(`workspace:${config.runtimeContext?.workspacePath}`);
    await manager.startAgent("agent-1", promptConfig({
      runtimeContext: {
        agentId: "agent-1", serverId: "server-1", machineId: "computer-1",
        workspacePath: null, daemonVersion: "0.0.0-stale",
      },
    }));
    expect(spawns).toHaveLength(1);
    expect(spawns[0].config.runtimeContext?.workspacePath).toBe(spawns[0].workingDirectory);
    expect(spawns[0].standingPrompt).toBe(`workspace:${spawns[0].workingDirectory}`);
    expect(spawns[0].daemonVersion).toBe("1.0.1-test");
    expect(spawns[0].computerVersion).toBe("2.0.1-test");
  });
});

test("restart rebuilds standing instructions from current config and keeps resume input separate", async () => {
  await withPromptManager(true, async ({ manager, driver, spawns }) => {
    await manager.startAgent("agent-1", promptConfig({ description: "old-role" }));
    await manager.stopAgent("agent-1", { wait: true });
    await manager.startAgent("agent-1", promptConfig({ description: "new-role", sessionId: "session-2" }));
    expect(spawns).toHaveLength(2);
    expect(spawns[1].standingPrompt).toBe("standing:new-role");
    expect(spawns[1].config.sessionId).toBe("session-2");
    expect(spawns[1].prompt).toBe(formatResumeEmptyPrompt(driver));
    expect(spawns[1].prompt).not.toContain("standing:");
  });
});

test("resume selects unread catch-up input instead of empty-resume input", async () => {
  await withPromptManager(true, async ({ manager, driver, spawns }) => {
    const unread = { "#general": 2, "dm:@bob": 1 };
    await manager.startAgent("agent-1", promptConfig({ sessionId: "session-1" }), undefined, unread);
    expect(spawns).toHaveLength(1);
    expect(spawns[0].prompt).toBe(formatResumeUnreadSummaryPrompt(unread, driver));
    expect(spawns[0].standingPrompt).toBe("standing:");
  });
});

test("a concrete wake takes precedence over the empty-resume path without replacing standing instructions", async () => {
  await withPromptManager(true, async ({ manager, driver, spawns }) => {
    const wake: AgentMessage = {
      message_id: "wake-1", channel_id: "channel-1", channel_name: "general", channel_type: "channel",
      sender_id: "human-1", sender_name: "bob", sender_type: "human",
      content: "message-body-sentinel", timestamp: "2026-09-05T00:00:00.000Z",
    };
    await manager.startAgent("agent-1", promptConfig({ description: "role", sessionId: "session-1" }), wake);
    expect(spawns).toHaveLength(1);
    expect(spawns[0].standingPrompt).toBe("standing:role");
    expect(spawns[0].prompt).not.toBe(formatResumeEmptyPrompt(driver));
    expect(spawns[0].prompt).toContain("#general");
    expect(stripInboxPreviewLines(spawns[0].prompt)).not.toContain(wake.content);
  });
});
