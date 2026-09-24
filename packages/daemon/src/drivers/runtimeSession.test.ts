import { asAxSurfaceText, type AxSurfaceText } from "@botiverse/raft-shared";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "vitest";
import { ChildProcessRuntimeSession } from "./runtimeSession.js";
import type { ParsedEvent, RuntimeDriver, SpawnContext, SpawnResult } from "./types.js";

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: (_chunk: string) => true };
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid = 1234;

  kill(signal?: NodeJS.Signals) {
    this.signalCode = signal ?? "SIGTERM";
    this.emit("exit", null, this.signalCode);
    this.emit("close", null, this.signalCode);
    return true;
  }
}

class Utf8Driver implements RuntimeDriver {
  readonly id = "utf8-test";
  readonly lifecycle = { kind: "persistent", stdin: "direct", inFlightWake: "steer" } as const;
  readonly communication = { chat: "slock_cli", runtimeControl: "none" } as const;
  readonly session = { recovery: "fresh" } as const;
  readonly model = { detectedModelsVerifiedAs: "launchable" } as const;
  readonly supportsStdinNotification = true;
  readonly busyDeliveryMode = "direct" as const;
  readonly spawned = new FakeChildProcess();

  spawn(_ctx: SpawnContext): SpawnResult {
    return { process: this.spawned as unknown as ChildProcess };
  }

  parseLine(line: string): ParsedEvent[] {
    const parsed = JSON.parse(line) as { text: string };
    return [{ kind: "text", text: parsed.text }];
  }

  encodeStdinMessage(text: string): string {
    return JSON.stringify({ text });
  }

  buildSystemPrompt(): AxSurfaceText {
    return asAxSurfaceText("");
  }
}

const spawnContext: SpawnContext = {
  agentId: "agent-1",
  config: {
    name: "agent",
    displayName: "Agent",
    description: "test",
    model: "model",
    runtime: "utf8-test",
    reasoningEffort: null,
    envVars: null,
    sessionId: null,
    serverUrl: "https://api.slock.ai",
    authToken: "sk_machine_test",
  } as any,
  standingPrompt: "",
  prompt: "",
  workingDirectory: "/tmp/agent",
  slockCliPath: "/tmp/slock",
  daemonApiKey: "token",
};

test("child-process runtime session decodes split UTF-8 stdout before line parsing", async () => {
  const driver = new Utf8Driver();
  const session = new ChildProcessRuntimeSession(driver, spawnContext);
  const events: ParsedEvent[] = [];
  session.on("runtime_event", (event) => events.push(event));
  await session.start({ text: "start" });

  const line = `${JSON.stringify({ text: "hello 你好" })}\n`;
  const bytes = Buffer.from(line, "utf8");
  const splitAt = bytes.indexOf(Buffer.from("你", "utf8")[0]) + 1;
  driver.spawned.stdout.emit("data", bytes.subarray(0, splitAt));
  driver.spawned.stdout.emit("data", bytes.subarray(splitAt));

  assert.deepEqual(events, [{ kind: "text", text: "hello 你好" }]);
});
