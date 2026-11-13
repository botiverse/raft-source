import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SpawnContext } from "./types";

const stdinWrites: string[] = [];
vi.mock("./runtimeChild", () => ({
  spawnRuntimeChild: vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child.stdin = { write: (chunk: string) => { stdinWrites.push(chunk); return true; } };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    return child;
  }),
}));
vi.mock("./cliTransport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cliTransport")>()),
  prepareCliTransport: vi.fn(async () => ({ spawnEnv: {} })),
}));

const { KimiDriver } = await import("./kimi");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "kimi-spawn-"));
  stdinWrites.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function spawnContext(sessionId: string | null, standingPrompt: string, prompt: string): SpawnContext {
  const ctx: SpawnContext = {
    agentId: "agent-1",
    config: {
      name: "hao", displayName: "Hao", description: "", runtime: "kimi", model: "kimi-k2",
      reasoningEffort: null, envVars: null, sessionId, serverUrl: "", authToken: "test-token",
    },
    standingPrompt,
    prompt,
    workingDirectory: dir,
    slockCliPath: "/unused/slock",
    daemonApiKey: "sk_machine_test",
  };
  return ctx;
}

function firstUserInput(): string {
  const request = stdinWrites.map((line) => JSON.parse(line)).find((message) => message.method === "prompt");
  return request.params.user_input;
}

test("a fresh Kimi CLI session: the standing prompt is its system prompt and the wake input its first user input", async () => {
  await new KimiDriver().spawn(spawnContext(null, "STANDING-PROMPT v1", "[Raft inbox notice: 1 message pending]"));
  assert.equal(readFileSync(path.join(dir, ".slock-kimi-system.md"), "utf8"), "STANDING-PROMPT v1");
  assert.equal(firstUserInput(), "[Raft inbox notice: 1 message pending]");
});

test("a resumed Kimi CLI session gets the current standing prompt rewritten, and its input as the user turn", async () => {
  await new KimiDriver().spawn(spawnContext(null, "STANDING-PROMPT v1", "Start."));
  stdinWrites.length = 0;
  await new KimiDriver().spawn(spawnContext("kimi-session-1", "STANDING-PROMPT v2", "resume input"));
  assert.equal(readFileSync(path.join(dir, ".slock-kimi-system.md"), "utf8"), "STANDING-PROMPT v2");
  assert.equal(firstUserInput(), "resume input");
});

test("Kimi CLI declares its native standing prompt, so the daemon does not repeat it in the first input", () => {
  assert.equal(new KimiDriver().supportsNativeStandingPrompt, true);
});
