import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentConfig } from "@botiverse/raft-shared";
import type { SpawnContext } from "../drivers/types";
import { antigravityOarLaunch } from "./oarAntigravityLaunch";
import { loadOarSessionRuntime } from "../oarLoader";

const ctx = (overrides: Partial<AgentConfig> = {}): SpawnContext => ({
  agentId: "agent-1",
  config: {
    name: "a", displayName: null, description: null, model: "default", runtime: "antigravity", reasoningEffort: null,
    envVars: null, sessionId: null, serverUrl: "http://localhost:3001", authToken: "", ...overrides,
  },
  standingPrompt: "standing instructions",
  prompt: "first input",
  workingDirectory: "/work/agent-1",
} as SpawnContext);

const plan = { command: "/bin/agy", env: { NO_COLOR: "1", KEPT: "yes" } };

test("a fresh launch: the driver's command and environment, the standing prompt appended, and steering", () => {
  const launch = antigravityOarLaunch(ctx(), plan, { KEPT: "yes", SSH_TTY: "/dev/pts/1" });
  assert.equal(launch.runtimeId, "antigravity");
  assert.deepEqual(launch.installation, { kind: "available", via: "executable", command: "/bin/agy" });
  assert.equal(launch.busyDelivery, "now");
  assert.deepEqual(launch.options, {
    cwd: "/work/agent-1",
    // A daemon variable the launch doesn't carry is removed: `agy` picks its token store by SSH_*.
    env: { NO_COLOR: "1", KEPT: "yes", SSH_TTY: null },
    appendSystemPrompt: "standing instructions",
  });
});

test("a model and a session to resume are passed; the runtime's default model is not", () => {
  const launch = antigravityOarLaunch(ctx({ model: "gemini-pro", sessionId: "session-1" }), plan, {});
  assert.equal(launch.options.model, "gemini-pro");
  assert.equal(launch.options.resume, "session-1");
  assert.equal(antigravityOarLaunch(ctx({ model: "default" }), plan, {}).options.model, undefined);
});

test("a chosen reasoning effort is the session's effort; none leaves agy's own thought level", () => {
  const launch = antigravityOarLaunch(ctx({ model: "gemini-3.8-flash", reasoningEffort: "high" }), plan, {});
  assert.equal(launch.options.model, "gemini-3.8-flash");
  assert.equal(launch.options.effort, "high");
  assert.equal("effort" in antigravityOarLaunch(ctx({ model: "gemini-3.8-flash" }), plan, {}).options, false);
  // agy's configured default: its model and so its level are agy's; an effort is never passed.
  assert.equal("effort" in antigravityOarLaunch(ctx({ model: "default", reasoningEffort: "high" }), plan, {}).options, false);
});

test("OAR refuses none of what the launch sets", async () => {
  const runtime = await loadOarSessionRuntime("antigravity");
  const refused = Object.keys(runtime.refusedSessionOptions ?? {});
  for (const option of Object.keys(antigravityOarLaunch(ctx({ model: "m", reasoningEffort: "low", sessionId: "s" }), plan, {}).options)) {
    assert.equal(refused.includes(option), false, option);
  }
});

test("managed MCP never goes through ACP here: OAR refuses a credentialed entry, and Raft's always carries the launch token (#oar-raft:#8)", async () => {
  const runtime = await loadOarSessionRuntime("antigravity");
  assert.ok(Object.keys(runtime.refusedSessionOptions ?? {}).includes("mcpServerCredentials"));
  assert.equal("mcpServers" in antigravityOarLaunch(ctx({ model: "m", sessionId: "s" }), plan, {}).options, false);
});
