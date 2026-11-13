import assert from "node:assert/strict";
import type { AgentConfig } from "@botiverse/raft-shared";
import type { SpawnContext } from "../drivers/types";
import { grokOarLaunch, launchEnvOverlay } from "./oarGrokLaunch";

const ctx = (overrides: Partial<AgentConfig> = {}): SpawnContext => ({
  agentId: "agent-1",
  config: {
    name: "g", displayName: null, description: null, model: "grok-4.5", runtime: "grok", reasoningEffort: "high",
    envVars: null, sessionId: null, serverUrl: "http://localhost:3001", authToken: "", ...overrides,
  },
  standingPrompt: "standing instructions",
  prompt: "first input",
  workingDirectory: "/work/agent-1",
  slockCliPath: "/bin/raft",
  daemonApiKey: "sk_machine_test",
});

test("the launch environment becomes an overlay that leaves the runtime exactly the launch environment", () => {
  const overlay = launchEnvOverlay({ PATH: "/bin", NO_COLOR: "1" }, { PATH: "/usr/bin", SLOCK_API_KEY: "secret", HOME: "/h" });
  assert.deepEqual(overlay, { PATH: "/bin", NO_COLOR: "1", SLOCK_API_KEY: null, HOME: null });
});

test("a grok launch: the driver's executable, standing prompt, model, effort and resume; busy deliveries wait for the turn end", () => {
  const launch = grokOarLaunch(ctx(), { command: "/opt/grok", env: { PATH: "/bin" }, model: "grok-4.5", reasoningEffort: "high", resumeSessionId: "grok-session-1" }, {});
  assert.deepEqual(launch, {
    runtimeId: "grok",
    installation: { kind: "available", via: "executable", command: "/opt/grok" },
    options: {
      cwd: "/work/agent-1",
      env: { PATH: "/bin" },
      systemPrompt: "standing instructions",
      model: "grok-4.5",
      effort: "high",
      resume: "grok-session-1",
      endTurnProcessesOnAbort: true,
    },
    busyDelivery: "now",
  });
  const fresh = grokOarLaunch(ctx({ model: "default" }), { command: "/opt/grok", env: {} }, {});
  assert.equal(fresh.options.resume, undefined);
  assert.equal(fresh.options.model, undefined);
  assert.equal(fresh.options.effort, undefined);
  assert.equal(fresh.options.endTurnProcessesOnAbort, true, "a Stop ends the turn's processes on a fresh session too");
});

test("OAR upgrade check: OAR's grok no longer refuses endTurnProcessesOnAbort (OAR 0.99, #733)", async () => {
  const { grokRuntime } = await import("@botiverse/oar/runtimes/grok");
  assert.equal(grokRuntime.refusedSessionOptions?.endTurnProcessesOnAbort, undefined);
});

test("a grok launch attaches managed MCP as a session MCP server, given again on resume; none without it (#oar-raft:#8)", () => {
  const managedMcp = { name: "rmAbc123", url: "http://127.0.0.1:4100/mcp/grok-token", endpointUrl: "http://127.0.0.1:4100/mcp", token: "grok-token" };
  const launch = grokOarLaunch(ctx(), { command: "/opt/grok", env: { PATH: "/bin" }, resumeSessionId: "grok-session-1", managedMcp }, {});
  assert.deepEqual(launch.options.mcpServers, [
    { name: "rmAbc123", type: "http", url: "http://127.0.0.1:4100/mcp", headers: { Authorization: "Bearer grok-token" } },
  ]);
  assert.equal(launch.options.resume, "grok-session-1");
  assert.equal(JSON.stringify(launch.options.env).includes("grok-token"), false);
  assert.equal(launch.options.systemPrompt?.includes("grok-token"), false);
  assert.equal("mcpServers" in grokOarLaunch(ctx(), { command: "/opt/grok", env: {}, managedMcp: null }, {}).options, false);
  assert.equal("mcpServers" in grokOarLaunch(ctx(), { command: "/opt/grok", env: {} }, {}).options, false);
});

test("an interject that timed out counts as delivered only when grok echoed it with this input's id (#oar-raft:#4)", async () => {
  const { interjectionEchoed } = await import("./oarAgentHost");
  const frame = (type: string, native: unknown) => ({ kind: "frame", seq: 1, body: { type, native, events: [] } });
  const session = (records: unknown[]) => ({ records: () => records }) as unknown as Parameters<typeof interjectionEchoed>[0];
  const id = "5f0c1d1e-0000-4000-8000-000000000001";
  assert.equal(interjectionEchoed(session([frame("_x.ai/session/interjection", { params: { interjectionId: id, text: "hi" } })]), id), true);
  assert.equal(interjectionEchoed(session([frame("_x.ai/session/interjection", { params: { interjectionId: "another" } })]), id), false);
  assert.equal(interjectionEchoed(session([frame("_x.ai/interject", { params: { interjectionId: id } })]), id), false);
  assert.equal(interjectionEchoed(session([]), id), false);
});
