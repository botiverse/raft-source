/**
 * RFC 060 OAR host, per start: the agent:start config carries
 * `runtimeHost: "oar"` only when the connected daemon advertised
 * `runtime-host:oar` AND the Server's flag for the agent's runtime
 * (`agent_runtime_oar_<runtime>`) evaluates on (an OAR-only runtime asks for it whatever its flag). An older
 * Computer that never advertised the capability keeps its drivers whatever
 * the flag says; there is no version comparison. Codex has no flag: it
 * needs `runtime-host:oar:codex`. Real DB rows and the real
 * flag evaluation; only the machine socket is stubbed.
 */
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";

import { DAEMON_CAPABILITY_RUNTIME_HOST_OAR, DAEMON_CAPABILITY_RUNTIME_HOST_OAR_CODEX, DAEMON_CAPABILITY_RUNTIME_HOST_OAR_CURSOR, DAEMON_CAPABILITY_RUNTIME_HOST_OAR_GROK, type ServerToMachineMessage } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { agents, machines, serverMembers, servers, users } from "../db/schema";
import { AgentOrchestrator } from "./agentOrchestrator";
import {
  AGENT_RUNTIME_OAR_DISABLED_ENV,
  AGENT_RUNTIME_OAR_FEATURE_FLAG_KEYS,
  agentRuntimeOarFeatureFlagKey,
  createFeatureFlag,
} from "./featureFlagService";

const GROK_OAR_FLAG = AGENT_RUNTIME_OAR_FEATURE_FLAG_KEYS.grok;

afterEach(async () => {
  await closeTestDatabase();
});

class CapturingOrchestrator extends AgentOrchestrator {
  readonly starts: Array<Extract<ServerToMachineMessage, { type: "agent:start" }>> = [];

  protected override async sendToMachine(_machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    if (msg.type === "agent:start") this.starts.push(msg);
    return true;
  }
}

async function seed(slug: string, runtime: string) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `${slug}@example.com`,
    name: `OAR Owner ${slug}`,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({ name: "OAR", slug, ownerId: owner!.id }).returning();
  await db.insert(serverMembers).values({ serverId: server!.id, userId: owner!.id, role: "owner" });
  const [machine] = await db.insert(machines).values({
    serverId: server!.id,
    userId: owner!.id,
    name: "oar-mac",
    apiKeyHash: `hash-${slug}`,
  }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server!.id,
    name: "oar-agent",
    status: "inactive",
    runtime,
    model: runtime === "grok" ? "grok-4.5" : "sonnet",
    executionMode: "byoc",
    machineId: machine!.id,
  }).returning();
  return { server: server!, machine: machine!, agent: agent! };
}

function bindMachine(orchestrator: AgentOrchestrator, machineId: string, serverId: string, capabilities: string[], version: string): void {
  (orchestrator as any).machineConnections.set(machineId, {
    ws: {},
    machineId,
    serverId,
    principalKind: "computer",
    connectionEpochId: `epoch-${machineId}`,
    heartbeatTimer: null,
    runtimeAccountUsageTimer: null,
    lastPong: Date.now(),
    lastIngressAt: Date.now(),
    daemonVersion: version,
    capabilities: new Set<string>(capabilities),
    runtimes: ["grok", "claude"],
    migrationTransport: null,
    shutdownIntent: null,
    computerVersion: version,
  });
}

async function startConfig(slug: string, options: { capabilities?: string[]; runtime?: string; version?: string } = {}) {
  const { server, machine, agent } = await seed(slug, options.runtime ?? "grok");
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id, options.capabilities ?? [DAEMON_CAPABILITY_RUNTIME_HOST_OAR, DAEMON_CAPABILITY_RUNTIME_HOST_OAR_GROK], options.version ?? "1.0.53");
    assert.equal((await orchestrator.startAgent(agent.id)).outcome, "dispatched");
    assert.equal(orchestrator.starts.length, 1);
    return orchestrator.starts[0]!.config;
  } finally {
    await orchestrator.shutdown();
  }
}

test("OAR host: no flag row means the start keeps the daemon's driver", async ({ db: _db }) => {
  assert.equal((await startConfig("oar-missing")).runtimeHost, undefined);
});

test("OAR host: a flag that evaluates off keeps the driver", async ({ db: _db }) => {
  await createFeatureFlag({ key: GROK_OAR_FLAG, randomizationUnit: "server", defaultEnabled: false });
  assert.equal((await startConfig("oar-off")).runtimeHost, undefined);
});

test("OAR host: the flag on and a daemon that advertised runtime-host:oar asks for the OAR host", async ({ db: _db }) => {
  await createFeatureFlag({ key: GROK_OAR_FLAG, randomizationUnit: "server", defaultEnabled: true });
  assert.equal((await startConfig("oar-on")).runtimeHost, "oar");
});

test("OAR host: an old Computer that never advertised runtime-host:oar keeps its driver with the flag on", async ({ db: _db }) => {
  await createFeatureFlag({ key: GROK_OAR_FLAG, randomizationUnit: "server", defaultEnabled: true });
  // Any version, older or newer: only the capability counts.
  assert.equal((await startConfig("oar-old-computer", { capabilities: [], version: "1.0.40" })).runtimeHost, undefined);
  assert.equal((await startConfig("oar-new-version-no-cap", { capabilities: [], version: "9.9.9" })).runtimeHost, undefined);
});

test("OAR host: the server kill switch overrides an enabled flag", async ({ db: _db }) => {
  await createFeatureFlag({ key: GROK_OAR_FLAG, randomizationUnit: "server", defaultEnabled: true });
  const previous = process.env[AGENT_RUNTIME_OAR_DISABLED_ENV];
  process.env[AGENT_RUNTIME_OAR_DISABLED_ENV] = "1";
  try {
    assert.equal((await startConfig("oar-killed")).runtimeHost, undefined);
  } finally {
    if (previous === undefined) delete process.env[AGENT_RUNTIME_OAR_DISABLED_ENV];
    else process.env[AGENT_RUNTIME_OAR_DISABLED_ENV] = previous;
  }
});

test("OAR host: the grok flag moves only grok agents; a runtime the OAR host does not run has no flag", async ({ db: _db }) => {
  await createFeatureFlag({ key: GROK_OAR_FLAG, randomizationUnit: "server", defaultEnabled: true });
  assert.equal((await startConfig("oar-claude", { runtime: "claude" })).runtimeHost, undefined);
  assert.equal(agentRuntimeOarFeatureFlagKey("grok"), "agent_runtime_oar_grok");
  assert.equal(agentRuntimeOarFeatureFlagKey("claude"), null);
  assert.equal(agentRuntimeOarFeatureFlagKey("__proto__"), null);
  assert.equal(agentRuntimeOarFeatureFlagKey(undefined), null);
});

test("OAR host: Codex runs on the OAR host with no flag row wherever the Computer can host it; other runtimes do not follow", async ({ db: _db }) => {
  const ready = [DAEMON_CAPABILITY_RUNTIME_HOST_OAR, DAEMON_CAPABILITY_RUNTIME_HOST_OAR_CODEX];
  assert.equal(agentRuntimeOarFeatureFlagKey("codex"), null, "Codex has no OAR host flag (retired, #raft-architecture:#32)");
  assert.equal((await startConfig("oar-codex-on", { runtime: "codex", capabilities: ready })).runtimeHost, "oar");
  assert.equal((await startConfig("oar-codex-flag-grok", { capabilities: ready })).runtimeHost, undefined);
});

test("OAR host: a Computer with runtime-host:oar but not runtime-host:oar:codex keeps the Codex driver", async ({ db: _db }) => {
  // Computers up to 1.0.64 have an unfinished Codex launch behind runtime-host:oar.
  assert.equal((await startConfig("oar-codex-old-computer", { runtime: "codex" })).runtimeHost, undefined);
});

test("OAR host: the antigravity flag asks a daemon that advertised runtime-host:oar; an older one hands the start back itself", async ({ db: _db }) => {
  assert.equal((await startConfig("oar-antigravity-off", { runtime: "antigravity" })).runtimeHost, undefined);
  await createFeatureFlag({ key: AGENT_RUNTIME_OAR_FEATURE_FLAG_KEYS.antigravity, randomizationUnit: "server", defaultEnabled: true });
  assert.equal(agentRuntimeOarFeatureFlagKey("antigravity"), "agent_runtime_oar_antigravity");
  assert.equal((await startConfig("oar-antigravity-on", { runtime: "antigravity" })).runtimeHost, "oar");
  assert.equal((await startConfig("oar-antigravity-no-host", { runtime: "antigravity", capabilities: [] })).runtimeHost, undefined);
});

test("OAR host: a Computer with only runtime-host:oar:codex keeps its drivers", async ({ db: _db }) => {
  assert.equal((await startConfig("oar-codex-lone-cap", { runtime: "codex", capabilities: [DAEMON_CAPABILITY_RUNTIME_HOST_OAR_CODEX] })).runtimeHost, undefined);
});

test("OAR host: the server kill switch keeps Codex on its driver", async ({ db: _db }) => {
  const previous = process.env[AGENT_RUNTIME_OAR_DISABLED_ENV];
  process.env[AGENT_RUNTIME_OAR_DISABLED_ENV] = "1";
  try {
    const ready = [DAEMON_CAPABILITY_RUNTIME_HOST_OAR, DAEMON_CAPABILITY_RUNTIME_HOST_OAR_CODEX];
    assert.equal((await startConfig("oar-codex-killed", { runtime: "codex", capabilities: ready })).runtimeHost, undefined);
  } finally {
    if (previous === undefined) delete process.env[AGENT_RUNTIME_OAR_DISABLED_ENV];
    else process.env[AGENT_RUNTIME_OAR_DISABLED_ENV] = previous;
  }
});

test("OAR host: an OAR-only runtime (Qwen Code) always asks for the OAR host from a capable daemon, with no flag", async ({ db: _db }) => {
  // No server flag (xxchan, #proj-runtime:a5762001); an agent on it has nowhere else to run.
  assert.equal((await startConfig("oar-qwen-no-flag", { runtime: "qwen" })).runtimeHost, "oar");
  assert.equal((await startConfig("oar-qwen-no-cap", { runtime: "qwen", capabilities: [] })).runtimeHost, undefined);
  assert.equal(agentRuntimeOarFeatureFlagKey("qwen"), null);
  assert.equal(agentRuntimeOarFeatureFlagKey("qoder"), null);
  assert.equal((await startConfig("oar-codebuddy-no-flag", { runtime: "codebuddy" })).runtimeHost, "oar");
  assert.equal(agentRuntimeOarFeatureFlagKey("codebuddy"), null);
});

test("OAR host: a Computer with runtime-host:oar but not runtime-host:oar:grok keeps the Grok driver with the flag on (#oar-raft:#4)", async ({ db: _db }) => {
  await createFeatureFlag({ key: GROK_OAR_FLAG, randomizationUnit: "server", defaultEnabled: true });
  assert.equal((await startConfig("oar-grok-no-grok-cap", { capabilities: [DAEMON_CAPABILITY_RUNTIME_HOST_OAR] })).runtimeHost, undefined, "1.0.56-1.0.67 advertise only runtime-host:oar");
  assert.equal((await startConfig("oar-grok-cap", { capabilities: [DAEMON_CAPABILITY_RUNTIME_HOST_OAR, DAEMON_CAPABILITY_RUNTIME_HOST_OAR_GROK] })).runtimeHost, "oar");
  assert.equal((await startConfig("oar-grok-lone-cap", { capabilities: [DAEMON_CAPABILITY_RUNTIME_HOST_OAR_GROK] })).runtimeHost, undefined, "the Grok capability alone is not the OAR host");
});

test("OAR host: Cursor needs agent_runtime_oar_cursor on and a Computer with runtime-host:oar:cursor (#oar-raft:#10)", async ({ db: _db }) => {
  const cursorReady = [DAEMON_CAPABILITY_RUNTIME_HOST_OAR, DAEMON_CAPABILITY_RUNTIME_HOST_OAR_CURSOR];
  assert.equal(agentRuntimeOarFeatureFlagKey("cursor"), "agent_runtime_oar_cursor");
  // Flag x capability: only both together ask for the OAR host.
  assert.equal((await startConfig("oar-cursor-no-flag", { runtime: "cursor", capabilities: cursorReady })).runtimeHost, undefined, "default off: no flag row");
  await createFeatureFlag({ key: AGENT_RUNTIME_OAR_FEATURE_FLAG_KEYS.cursor, randomizationUnit: "server", defaultEnabled: true });
  assert.equal((await startConfig("oar-cursor-on", { runtime: "cursor", capabilities: cursorReady })).runtimeHost, "oar");
  assert.equal((await startConfig("oar-cursor-no-cursor-cap", { runtime: "cursor", capabilities: [DAEMON_CAPABILITY_RUNTIME_HOST_OAR] })).runtimeHost, undefined, "a Computer without the SDK (macOS, Windows, SEA) keeps the driver");
  assert.equal((await startConfig("oar-cursor-lone-cap", { runtime: "cursor", capabilities: [DAEMON_CAPABILITY_RUNTIME_HOST_OAR_CURSOR] })).runtimeHost, undefined, "the Cursor capability alone is not the OAR host");
  // The Cursor flag moves no other runtime.
  assert.equal((await startConfig("oar-cursor-flag-grok", { capabilities: [...cursorReady, DAEMON_CAPABILITY_RUNTIME_HOST_OAR_GROK] })).runtimeHost, undefined);
});

test("OAR host: the server kill switch keeps Cursor on its driver with the flag on", async ({ db: _db }) => {
  await createFeatureFlag({ key: AGENT_RUNTIME_OAR_FEATURE_FLAG_KEYS.cursor, randomizationUnit: "server", defaultEnabled: true });
  const previous = process.env[AGENT_RUNTIME_OAR_DISABLED_ENV];
  process.env[AGENT_RUNTIME_OAR_DISABLED_ENV] = "1";
  try {
    const cursorReady = [DAEMON_CAPABILITY_RUNTIME_HOST_OAR, DAEMON_CAPABILITY_RUNTIME_HOST_OAR_CURSOR];
    assert.equal((await startConfig("oar-cursor-killed", { runtime: "cursor", capabilities: cursorReady })).runtimeHost, undefined);
  } finally {
    if (previous === undefined) delete process.env[AGENT_RUNTIME_OAR_DISABLED_ENV];
    else process.env[AGENT_RUNTIME_OAR_DISABLED_ENV] = previous;
  }
});
