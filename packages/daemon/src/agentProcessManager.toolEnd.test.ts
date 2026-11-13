import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager";
import { setDaemonFetchImplForTests } from "./daemonFetch";
import type { RuntimeDriver } from "./drivers/index";
import { CopilotDriver } from "./drivers/copilot";
import { CursorDriver } from "./drivers/cursor";
import { GeminiDriver } from "./drivers/gemini";
import { KimiDriver } from "./drivers/kimi";
import { OpenCodeDriver } from "./drivers/opencode";
import { promptConfig } from "./testing/promptFixture";

/**
 * task #26: these drivers reported tool starts but no tool ends, so the
 * daemon's open-tool count stayed above zero for the rest of the turn: a quiet
 * stretch after any tool call read as "stuck on a tool", and a stalled Kimi
 * turn could not be recovered. Each case feeds the CLI's own output lines
 * through the real driver and the real manager; only the child is faked.
 */

class ToolChild extends EventEmitter {
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

interface ToolCountView {
  gatedSteering: { outstandingToolUses: number };
  toolStuck?: { openCount: number };
}

function agentView(manager: AgentProcessManager): ToolCountView {
  const view = (manager as unknown as { agents: Map<string, ToolCountView> }).agents.get("agent-1");
  if (!view) throw new Error("agent-1 is not running");
  return view;
}

const wake: AgentMessage = {
  message_id: "wake-1", channel_id: "channel-1", channel_name: "general", channel_type: "channel",
  sender_id: "human-1", sender_name: "bob", sender_type: "human",
  content: "run ls", timestamp: "2026-10-24T00:00:00.000Z",
};

const kimiEvent = (type: string, payload: unknown) => ({ jsonrpc: "2.0", method: "event", params: { type, payload } });

const cases: Array<[string, () => RuntimeDriver, unknown[], unknown[]]> = [
  ["copilot", () => new CopilotDriver(),
    [{ type: "assistant.message", data: { toolRequests: [{ toolCallId: "c1", name: "bash", arguments: { command: "ls" } }] } }],
    [{ type: "tool.execution_complete", data: { toolCallId: "c1", success: true, shellExecution: { exitCode: 0 } } }]],
  ["cursor", () => new CursorDriver(),
    [{ type: "tool_call", subtype: "started", call_id: "c1", tool_call: { shellToolCall: { args: { command: "ls" } } } }],
    [{ type: "tool_call", subtype: "completed", call_id: "c1", tool_call: { shellToolCall: { args: { command: "ls" }, result: { success: { exitCode: 0 } } } } }]],
  ["gemini", () => new GeminiDriver(),
    [{ type: "tool_use", tool_name: "run_shell_command", tool_id: "c1", parameters: { command: "ls" } }],
    [{ type: "tool_result", tool_id: "c1", status: "success", output: "" }]],
  ["kimi", () => new KimiDriver(),
    [kimiEvent("ToolCall", { type: "function", id: "c1", function: { name: "Shell", arguments: "{\"command\": \"ls\"}" } })],
    [kimiEvent("ToolResult", { tool_call_id: "c1", return_value: { is_error: false, output: "" } })]],
  // OpenCode prints a call only once it has finished: one line opens and closes it.
  ["opencode", () => new OpenCodeDriver(),
    [],
    [{ type: "tool_use", part: { type: "tool", tool: "bash", callID: "c1", state: { status: "completed", input: { command: "ls" }, metadata: { exit: 0 } } } }]],
];

async function withToolManager(
  driver: RuntimeDriver,
  run: (ctx: { manager: AgentProcessManager; emit: (lines: unknown[]) => Promise<void> }) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-tool-end-test-"));
  const children: ToolChild[] = [];
  // A real driver: everything but the child process.
  driver.spawn = async () => {
    const child = new ToolChild();
    children.push(child);
    return { process: child as unknown as ChildProcess };
  };
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.includes("/internal/computer/runners/") && method === "POST") {
      return Response.json({ apiKey: "sk_agent_tool_test", credentialId: "tool-test" }, { status: 201 });
    }
    if (url.includes("/internal/computer/runners/") && method === "DELETE") return new Response(null, { status: 204 });
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  setDaemonFetchImplForTests(fetch as never);
  const manager = new AgentProcessManager(() => {}, "sk_machine_test", {
    dataDir, slockHome: dataDir, runtimeSessionHomeDir: dataDir,
    daemonVersion: "1.0.1-test", computerVersion: "2.0.1-test",
    serverUrl: "https://raft.example.test", driverResolver: () => driver,
  });
  const emit = async (lines: unknown[]) => {
    expect(children).toHaveLength(1);
    for (const line of lines) children[0]!.stdout.emit("data", Buffer.from(`${JSON.stringify(line)}\n`));
    await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    await run({ manager, emit });
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

test.each(cases)("%s: a finished tool call leaves no open tool in the daemon", async (runtime, makeDriver, startLines, endLines) => {
  await withToolManager(makeDriver(), async ({ manager, emit }) => {
    // OpenCode starts only for a concrete message, so every case gets one.
    await manager.startAgent("agent-1", promptConfig({ runtime, sessionId: "session-1" }), wake);

    if (startLines.length > 0) {
      await emit(startLines);
      await vi.waitFor(() => expect(agentView(manager).gatedSteering.outstandingToolUses).toBe(1));
      expect(agentView(manager).toolStuck?.openCount).toBe(1);
    }

    await emit(endLines);
    await vi.waitFor(() => expect(agentView(manager).toolStuck?.openCount).toBe(0));
    expect(agentView(manager).gatedSteering.outstandingToolUses).toBe(0);
  });
});

// The daemon decrements its count on any tool end, so a result the driver no
// longer holds open must never reach it: here one that arrives after its turn
// ended, while the next turn's call is running (Kimi CLI keeps one process
// across turns).
test("kimi: a late result for an earlier turn's call does not close the running call", async () => {
  await withToolManager(new KimiDriver(), async ({ manager, emit }) => {
    await manager.startAgent("agent-1", promptConfig({ runtime: "kimi", sessionId: "session-1" }), wake);
    await emit([
      kimiEvent("ToolCall", { type: "function", id: "a", function: { name: "Shell", arguments: "{}" } }),
      kimiEvent("TurnEnd", {}),
      kimiEvent("ToolCall", { type: "function", id: "b", function: { name: "Shell", arguments: "{}" } }),
    ]);
    await vi.waitFor(() => expect(agentView(manager).gatedSteering.outstandingToolUses).toBe(1));
    await emit([kimiEvent("ToolResult", { tool_call_id: "a", return_value: { is_error: false } })]);
    expect(agentView(manager).gatedSteering.outstandingToolUses).toBe(1);
    expect(agentView(manager).toolStuck?.openCount).toBe(1);
    await emit([kimiEvent("ToolResult", { tool_call_id: "b", return_value: { is_error: false } })]);
    await vi.waitFor(() => expect(agentView(manager).gatedSteering.outstandingToolUses).toBe(0));
  });
});
