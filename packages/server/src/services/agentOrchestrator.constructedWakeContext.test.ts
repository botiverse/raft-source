/**
 * Per-server flags that ride the agent:start config. RFC 070 constructed wake
 * context is no longer one of them: its `constructed_wake_context` flag was
 * retired on 2026-10-23, and the config always carries
 * `constructedWakeContext: true` for older daemons (which treat absent or
 * false as off). Current daemons ignore the field. The remaining flags are
 * per server and default off. Real DB rows and the real flag evaluation; only
 * the machine socket is stubbed.
 */
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

import {
  AGENT_CONTEXT_VIEW_FEATURE_FLAG_KEY,
  AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY,
  pickAgentServerFeatures,
  TASK_V2_CONVERSATIONS_FEATURE_FLAG_KEY,
  WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY,
  type RuntimeConfig,
  type ServerToMachineMessage,
} from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { agents, featureFlagAudienceMembers, featureFlagAudiences, machines, oauthClientInstalls, oauthClients, reminderAppMigrations, serverMembers, servers, users } from "../db/schema";
import { AgentOrchestrator } from "./agentOrchestrator";
import { createFeatureFlag, createFeatureFlagRule, PASSIVE_AX_FEATURE_FLAG_KEY, PI_SESSION_ROTATION_FEATURE_FLAG_KEY, REMINDER_APP_FEATURE_FLAG_KEY, SUBAGENT_DELEGATION_FEATURE_FLAG_KEY, VAULT_APP_FEATURE_FLAG_KEY, WAKE_RECYCLE_OAR_FEATURE_FLAG_KEY, WAKE_RECYCLE_TIER_GATE_FEATURE_FLAG_KEY, WAKE_RECYCLE_WARM_FEATURE_FLAG_KEY, TURN_END_COMPACTION_FEATURE_FLAG_KEY } from "./featureFlagService";
import { __answerFlagForTests } from "../services/deploymentAnsweredFlags";

afterEach(async () => {
  await closeTestDatabase();
});

class CapturingOrchestrator extends AgentOrchestrator {
  readonly starts: Array<Extract<ServerToMachineMessage, { type: "agent:start" }>> = [];
  readonly featureAnswers: Array<{ machineId: string; msg: Extract<ServerToMachineMessage, { type: "server:features" }> }> = [];

  protected override async sendToMachine(machineId: string, msg: ServerToMachineMessage): Promise<boolean> {
    if (msg.type === "agent:start") this.starts.push(msg);
    if (msg.type === "server:features") this.featureAnswers.push({ machineId, msg });
    return true;
  }
}

async function seed(slug: string) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `${slug}@example.com`,
    name: `Wake Owner ${slug}`,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({ name: "Wake", slug, ownerId: owner!.id }).returning();
  await db.insert(serverMembers).values({ serverId: server!.id, userId: owner!.id, role: "owner" });
  const [machine] = await db.insert(machines).values({
    serverId: server!.id,
    userId: owner!.id,
    name: "wake-mac",
    apiKeyHash: `hash-${slug}`,
  }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server!.id,
    name: "wake-agent",
    status: "inactive",
    runtime: "claude",
    model: "sonnet",
    executionMode: "byoc",
    machineId: machine!.id,
  }).returning();
  return { server: server!, machine: machine!, agent: agent! };
}

function bindMachine(orchestrator: AgentOrchestrator, machineId: string, serverId: string): void {
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
    daemonVersion: "1.0.40",
    capabilities: new Set<string>(),
    runtimes: ["claude"],
    migrationTransport: null,
    shutdownIntent: null,
    computerVersion: "1.0.40",
  });
}

async function startConfig(slug: string) {
  return startSeededConfig(await seed(slug));
}

async function startSeededConfig({ server, machine, agent }: Awaited<ReturnType<typeof seed>>) {
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, server.id);
    assert.equal((await orchestrator.startAgent(agent.id)).outcome, "dispatched");
    assert.equal(orchestrator.starts.length, 1);
    return orchestrator.starts[0]!.config;
  } finally {
    await orchestrator.shutdown();
  }
}

test("constructed wake context: the start config always carries true for older daemons, with no flag row", async ({ db: _db }) => {
  const config = await startConfig("cwc-always");
  assert.equal(config.constructedWakeContext, true);
});

test("constructed wake context: a leftover retired flag row that evaluates off is ignored", async ({ db: _db }) => {
  // The DB row is deleted later by the flag admin; until then it must not matter.
  await createFeatureFlag({ key: "constructed_wake_context", randomizationUnit: "server", defaultEnabled: false });
  const config = await startConfig("cwc-leftover-off");
  assert.equal(config.constructedWakeContext, true);
});

// The sub-agent delegation prompt rides the per-server, default-off path.
test("sub-agent delegation: no flag means the start config leaves it off", async ({ db: _db }) => {
  const config = await startConfig("sad-missing");
  assert.equal(config.subagentDelegation, undefined);
});

test("sub-agent delegation: a flag that evaluates off leaves it off", async ({ db: _db }) => {
  await createFeatureFlag({ key: SUBAGENT_DELEGATION_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: false });
  const config = await startConfig("sad-off");
  assert.equal(config.subagentDelegation, undefined);
});

test("sub-agent delegation: a flag that evaluates on for the server turns it on, independently of wake context", async ({ db: _db }) => {
  await createFeatureFlag({ key: SUBAGENT_DELEGATION_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true });
  const config = await startConfig("sad-on");
  assert.equal(config.subagentDelegation, true);
  assert.equal(config.constructedWakeContext, true);
});


// task #359: the RFC 072 passive AX gate rides the same per-server, default-off path.
test("passive AX: no flag means the start config leaves it off", async ({ db: _db }) => {
  const config = await startConfig("pax-missing");
  assert.equal(config.passiveAx, undefined);
});

test("passive AX: a flag that evaluates off leaves it off", async ({ db: _db }) => {
  await createFeatureFlag({ key: PASSIVE_AX_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: false });
  const config = await startConfig("pax-off");
  assert.equal(config.passiveAx, undefined);
});

test("passive AX: a flag that evaluates on for the server turns it on, independently of the other gates", async ({ db: _db }) => {
  await createFeatureFlag({ key: PASSIVE_AX_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true });
  const config = await startConfig("pax-on");
  assert.equal(config.passiveAx, true);
  assert.equal(config.constructedWakeContext, true);
  assert.equal(config.subagentDelegation, undefined);
});

// Reminder / Vault app rollout flags ride the same per-server, default-off path.
test("reminder and vault app flags: no flag means the start config leaves both off", async ({ db: _db }) => {
  const config = await startConfig("apps-missing");
  assert.equal(config.reminderApp, undefined);
  assert.equal(config.vaultApp, undefined);
});

test("reminder and vault app flags: flags that evaluate off leave both off", async ({ db: _db }) => {
  await createFeatureFlag({ key: REMINDER_APP_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: false });
  await createFeatureFlag({ key: VAULT_APP_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: false });
  const config = await startConfig("apps-off");
  assert.equal(config.reminderApp, undefined);
  assert.equal(config.vaultApp, undefined);
});

test("reminder app flag on turns on only its own marker", async ({ db: _db }) => {
  await createFeatureFlag({ key: REMINDER_APP_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true });
  const config = await startConfig("apps-reminder");
  assert.equal(config.reminderApp, true);
  assert.equal(config.vaultApp, undefined);
});

test("vault app flag on turns on only its own marker", async ({ db: _db }) => {
  await createFeatureFlag({ key: VAULT_APP_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true });
  const config = await startConfig("apps-vault");
  assert.equal(config.vaultApp, true);
  assert.equal(config.reminderApp, undefined);
});

// First-party apps (the server's app registry) ride as one list, beside the
// booleans older daemons read; always sent, so an empty list means none on.
test("enabled apps: no flag sends an empty list", async ({ db: _db }) => {
  const config = await startConfig("fpa-missing");
  assert.deepEqual(config.enabledApps, []);
});

test("enabled apps: Artifacts on lists it for every server, off for none, and leaves the booleans alone", async ({ db: _db }) => {
  await createFeatureFlag({ key: VAULT_APP_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true });
  const one = await seed("fpa-one");
  const two = await seed("fpa-two");
  const whenOff = await seed("fpa-off");
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  const onConfigs = [await startSeededConfig(one), await startSeededConfig(two)];
  for (const config of onConfigs) assert.deepEqual(config.enabledApps, ["artifacts"]);
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, false);
  const offConfig = await startSeededConfig(whenOff);
  assert.deepEqual(offConfig.enabledApps, []);
  for (const config of [...onConfigs, offConfig]) {
    assert.equal(config.vaultApp, true);
    assert.equal(config.reminderApp, undefined);
  }
});

// pi session rotation rides the same default-off path, and is turned on per
// server (the /raft-first rollout) by a server allow rule.
test("pi session rotation: no flag means the start config leaves it off", async ({ db: _db }) => {
  const config = await startConfig("psr-missing");
  assert.equal(config.piSessionRotation, undefined);
});

test("pi session rotation: a server rule turns it on for that server only", async ({ db: _db }) => {
  await createFeatureFlag({ key: PI_SESSION_ROTATION_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: false });
  const allowed = await seed("psr-allowed");
  const other = await seed("psr-other");
  await createFeatureFlagRule({ flagKey: PI_SESSION_ROTATION_FEATURE_FLAG_KEY, stage: "server", decision: "allow", values: [allowed.server.id] });
  const allowedConfig = await startSeededConfig(allowed);
  const otherConfig = await startSeededConfig(other);
  assert.equal(allowedConfig.piSessionRotation, true);
  assert.equal(allowedConfig.passiveAx, undefined);
  assert.equal(otherConfig.piSessionRotation, undefined);
});

// Wake recycle on the OAR host (#proj-runtime:#54) rides the same per-server,
// default-off path: one flag for the OAR host's summary facts and its
// cold-idle stop, turned on per server (/raft first) by an allow rule.
test("wake recycle on the OAR host: no flag means the start config leaves it off", async ({ db: _db }) => {
  const config = await startConfig("wro-missing");
  assert.equal(config.wakeRecycleOar, undefined);
});

test("wake recycle on the OAR host: a server rule turns it on for that server only", async ({ db: _db }) => {
  await createFeatureFlag({ key: WAKE_RECYCLE_OAR_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: false });
  const allowed = await seed("wro-allowed");
  const other = await seed("wro-other");
  await createFeatureFlagRule({ flagKey: WAKE_RECYCLE_OAR_FEATURE_FLAG_KEY, stage: "server", decision: "allow", values: [allowed.server.id] });
  const allowedConfig = await startSeededConfig(allowed);
  const otherConfig = await startSeededConfig(other);
  assert.equal(allowedConfig.wakeRecycleOar, true);
  assert.equal(allowedConfig.piSessionRotation, undefined);
  assert.equal(otherConfig.wakeRecycleOar, undefined);
});

// Wake recycle gated on the cache tier (#proj-runtime:#54 phase 2): the same
// per-server, default-off path, measured per server before it is a default.
test("wake recycle tier gate: no flag means the start config leaves it off", async ({ db: _db }) => {
  const config = await startConfig("wrt-missing");
  assert.equal(config.wakeRecycleTierGate, undefined);
});

test("wake recycle tier gate: a server rule turns it on for that server only", async ({ db: _db }) => {
  await createFeatureFlag({ key: WAKE_RECYCLE_TIER_GATE_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: false });
  const allowed = await seed("wrt-allowed");
  const other = await seed("wrt-other");
  await createFeatureFlagRule({ flagKey: WAKE_RECYCLE_TIER_GATE_FEATURE_FLAG_KEY, stage: "server", decision: "allow", values: [allowed.server.id] });
  const allowedConfig = await startSeededConfig(allowed);
  const otherConfig = await startSeededConfig(other);
  assert.equal(allowedConfig.wakeRecycleTierGate, true);
  assert.equal(allowedConfig.wakeRecycleOar, undefined, "independent of the OAR recycle flag");
  assert.equal(otherConfig.wakeRecycleTierGate, undefined);
});

// Native compaction at a turn end (#proj-runtime:#54 phase 3): the same
// per-server, default-off path, checked against the bench chain first.
test("turn end compaction: no flag means the start config leaves it off", async ({ db: _db }) => {
  const config = await startConfig("tec-missing");
  assert.equal(config.turnEndCompaction, undefined);
});

test("turn end compaction: a server rule turns it on for that server only", async ({ db: _db }) => {
  await createFeatureFlag({ key: TURN_END_COMPACTION_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: false });
  const allowed = await seed("tec-allowed");
  const other = await seed("tec-other");
  await createFeatureFlagRule({ flagKey: TURN_END_COMPACTION_FEATURE_FLAG_KEY, stage: "server", decision: "allow", values: [allowed.server.id] });
  const allowedConfig = await startSeededConfig(allowed);
  const otherConfig = await startSeededConfig(other);
  assert.equal(allowedConfig.turnEndCompaction, true);
  assert.equal(allowedConfig.wakeRecycleTierGate, undefined, "independent of the recycle flags");
  assert.equal(otherConfig.turnEndCompaction, undefined);
});

// Warm wake recycle (#proj-runtime:#54, RFC 070 §6.5): the same per-server,
// default-off path, independent of the other recycle and compaction flags.
test("warm wake recycle: no flag means the start config leaves it off", async ({ db: _db }) => {
  const config = await startConfig("wrw-missing");
  assert.equal(config.wakeRecycleWarm, undefined);
});

test("warm wake recycle: a server rule turns it on for that server only", async ({ db: _db }) => {
  await createFeatureFlag({ key: WAKE_RECYCLE_WARM_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: false });
  const allowed = await seed("wrw-allowed");
  const other = await seed("wrw-other");
  await createFeatureFlagRule({ flagKey: WAKE_RECYCLE_WARM_FEATURE_FLAG_KEY, stage: "server", decision: "allow", values: [allowed.server.id] });
  const allowedConfig = await startSeededConfig(allowed);
  const otherConfig = await startSeededConfig(other);
  assert.equal(allowedConfig.wakeRecycleWarm, true);
  assert.equal(allowedConfig.wakeRecycleOar, undefined, "independent of the OAR recycle flag");
  assert.equal(allowedConfig.wakeRecycleTierGate, undefined, "independent of the tier gate");
  assert.equal(allowedConfig.turnEndCompaction, undefined, "independent of turn-end compaction");
  assert.equal(otherConfig.wakeRecycleWarm, undefined);
});

// View Context rides the same per-server, default-off path: the daemon keeps
// its send index and answers view requests only where it is on.
test("agent context view: no flag means the start config leaves it off", async ({ db: _db }) => {
  const config = await startConfig("acv-missing");
  assert.equal(config.agentContextView, undefined);
});

test("agent context view: a server rule turns it on for that server only", async ({ db: _db }) => {
  await createFeatureFlag({ key: AGENT_CONTEXT_VIEW_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: false });
  const allowed = await seed("acv-allowed");
  const other = await seed("acv-other");
  await createFeatureFlagRule({ flagKey: AGENT_CONTEXT_VIEW_FEATURE_FLAG_KEY, stage: "server", decision: "allow", values: [allowed.server.id] });
  const allowedConfig = await startSeededConfig(allowed);
  const otherConfig = await startSeededConfig(other);
  assert.equal(allowedConfig.agentContextView, true);
  assert.equal(allowedConfig.subagentDelegation, undefined);
  assert.equal(otherConfig.agentContextView, undefined);
});

// RFC 081 inbox items ride the same per-server, default-off path: the daemon
// teaches `raft inbox read` only where the server answers it.
test("inbox items: no flag means the start config leaves it off", async ({ db: _db }) => {
  const config = await startConfig("inbox-items-missing");
  assert.equal(config.inboxItems, undefined);
  assert.equal("inboxItemsLaunchAt" in config, false);
});

test("inbox items: a server rule turns it on for that server only, and the kill switch turns it off", async ({ db: _db, onTestFinished }) => {
  vi.stubEnv("RAFT_INBOX_ITEMS_LAUNCH_AT", "2026-01-01T00:00:00Z");
  onTestFinished(() => { vi.unstubAllEnvs(); });
  await createFeatureFlag({ key: AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: false });
  const allowed = await seed("inbox-items-allowed");
  const other = await seed("inbox-items-other");
  await createFeatureFlagRule({ flagKey: AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY, stage: "server", decision: "allow", values: [allowed.server.id] });
  const { config, answer } = await startAndAskFeatures(allowed);
  assert.equal(config.inboxItems, true);
  assert.equal(answer.msg.features.inboxItems, true, "server:features carries it as agent:start does");
  const otherConfig = await startSeededConfig(other);
  assert.equal(otherConfig.inboxItems, undefined);
  assert.equal("inboxItemsLaunchAt" in otherConfig, false, "the flag off for this server: no launch time");
  await getDb().execute(sql`update feature_flags set kill_switch = true where key = ${AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY}`);
  const killed = await startSeededConfig(allowed);
  assert.equal(killed.inboxItems, undefined, "the kill switch turns it off at the next start");
  assert.equal("inboxItemsLaunchAt" in killed, false);
});

test("inbox items: the launch time rides beside inboxItems, as ISO 8601, in agent:start and server:features alike", async ({ db: _db, onTestFinished }) => {
  vi.stubEnv("RAFT_INBOX_ITEMS_LAUNCH_AT", "2026-03-04T05:06:07+02:00");
  onTestFinished(() => { vi.unstubAllEnvs(); });
  await createFeatureFlag({ key: AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true });
  const { config, answer } = await startAndAskFeatures(await seed("inbox-items-launch-at"));
  assert.equal(config.inboxItems, true, "the boolean older daemons read is unchanged");
  assert.equal(config.inboxItemsLaunchAt, "2026-03-04T03:06:07.000Z");
  assert.equal(answer.msg.features.inboxItems, true);
  assert.equal(answer.msg.features.inboxItemsLaunchAt, "2026-03-04T03:06:07.000Z");
  assert.deepEqual(answer.msg.features, pickAgentServerFeatures(config));
});

test("inbox items: the flag on with no RAFT_INBOX_ITEMS_LAUNCH_AT is off, in agent:start and server:features alike", async ({ db: _db, onTestFinished }) => {
  vi.stubEnv("RAFT_INBOX_ITEMS_LAUNCH_AT", "");
  onTestFinished(() => { vi.unstubAllEnvs(); });
  await createFeatureFlag({ key: AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true });
  const { config, answer } = await startAndAskFeatures(await seed("inbox-items-no-launch"));
  assert.equal(config.inboxItems, undefined);
  assert.equal(answer.msg.features.inboxItems, undefined);
  assert.equal("inboxItemsLaunchAt" in config, false);
  assert.equal("inboxItemsLaunchAt" in answer.msg.features, false);
});

// `server:features:request` (shared featuresChanged.ts): a daemon told that a
// flag changed asks for the values instead of waiting for each agent's next
// start, so the answer must be exactly what an agent:start now carries.
async function startAndAskFeatures(seeded: Awaited<ReturnType<typeof seed>>) {
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, seeded.machine.id, seeded.server.id);
    assert.equal((await orchestrator.startAgent(seeded.agent.id)).outcome, "dispatched");
    await orchestrator.handleMachineMessage(seeded.machine.id, { type: "server:features:request", requestId: "req-1" });
    assert.equal(orchestrator.featureAnswers.length, 1);
    return { config: orchestrator.starts[0]!.config, answer: orchestrator.featureAnswers[0]! };
  } finally {
    await orchestrator.shutdown();
  }
}

test("server features: the answer to a request carries what agent:start carries, for the connection's server", async ({ db: _db }) => {
  await createFeatureFlag({ key: SUBAGENT_DELEGATION_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true });
  await createFeatureFlag({ key: PASSIVE_AX_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: false });
  await createFeatureFlag({ key: VAULT_APP_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true });
  await createFeatureFlag({ key: PI_SESSION_ROTATION_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: false });
  const allowed = await seed("sf-allowed");
  // These two flag rows ship with migrations (off); a server rule turns them on.
  await createFeatureFlagRule({ flagKey: TASK_V2_CONVERSATIONS_FEATURE_FLAG_KEY, stage: "server", decision: "allow", values: [allowed.server.id] });
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  await createFeatureFlagRule({ flagKey: PI_SESSION_ROTATION_FEATURE_FLAG_KEY, stage: "server", decision: "allow", values: [allowed.server.id] });

  const { config, answer } = await startAndAskFeatures(allowed);
  assert.equal(answer.machineId, allowed.machine.id);
  assert.equal(answer.msg.requestId, "req-1");
  assert.equal(answer.msg.serverId, allowed.server.id);
  assert.deepEqual(answer.msg.features, pickAgentServerFeatures(config));
  assert.deepEqual(answer.msg.features, {
    subagentDelegation: true,
    vaultApp: true,
    piSessionRotation: true,
    taskConversations: true,
    enabledApps: ["artifacts"],
  });
  // Only the flag-derived fields: nothing per agent or per machine rides along.
  assert.equal("runtimeHost" in answer.msg.features, false);
  assert.equal("installedApps" in answer.msg.features, false);
});

test("server features: with every flag off the answer is an empty app list, as agent:start sends it", async ({ db: _db }) => {
  const { config, answer } = await startAndAskFeatures(await seed("sf-off"));
  assert.deepEqual(answer.msg.features, { enabledApps: [] });
  assert.deepEqual(answer.msg.features, pickAgentServerFeatures(config));
});

test("server features: a request on a connection bound to no server, or without a request id, is not answered", async ({ db: _db }) => {
  const { machine } = await seed("sf-unbound");
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, machine.id, null as unknown as string);
    await orchestrator.handleMachineMessage(machine.id, { type: "server:features:request", requestId: "req-unbound" });
    bindMachine(orchestrator, machine.id, machine.serverId);
    await orchestrator.handleMachineMessage(machine.id, { type: "server:features:request", requestId: "" });
    assert.deepEqual(orchestrator.featureAnswers, []);
  } finally {
    await orchestrator.shutdown();
  }
});

test("server features: an evaluation that fails answers nothing, never \"all off\"", async ({ db: _db }) => {
  const seeded = await seed("sf-failing");
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, seeded.machine.id, seeded.server.id);
    // A database blip: every flag read fails from here on.
    await getDb().execute(sql`alter table feature_flags rename to feature_flags_unavailable`);
    // agent:start keeps its lenient reading: there the same failure leaves each flag off.
    assert.deepEqual(await (orchestrator as any).agentServerFeatures(seeded.server.id), { enabledApps: [] });
    await orchestrator.handleMachineMessage(seeded.machine.id, { type: "server:features:request", requestId: "req-failing" });
    assert.deepEqual(orchestrator.featureAnswers, [], "no answer: the daemon keeps the values it has");
  } finally {
    await orchestrator.shutdown();
  }
});

test("server features: with every key on, the answer and agent:start still agree", async ({ db: _db, onTestFinished }) => {
  vi.stubEnv("RAFT_INBOX_ITEMS_LAUNCH_AT", "2026-01-01T00:00:00Z");
  onTestFinished(() => { vi.unstubAllEnvs(); });
  for (const key of [SUBAGENT_DELEGATION_FEATURE_FLAG_KEY, PASSIVE_AX_FEATURE_FLAG_KEY, REMINDER_APP_FEATURE_FLAG_KEY, VAULT_APP_FEATURE_FLAG_KEY, PI_SESSION_ROTATION_FEATURE_FLAG_KEY, WAKE_RECYCLE_OAR_FEATURE_FLAG_KEY, WAKE_RECYCLE_TIER_GATE_FEATURE_FLAG_KEY, TURN_END_COMPACTION_FEATURE_FLAG_KEY, WAKE_RECYCLE_WARM_FEATURE_FLAG_KEY, AGENT_CONTEXT_VIEW_FEATURE_FLAG_KEY, AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY]) {
    await createFeatureFlag({ key, randomizationUnit: "server", defaultEnabled: true });
  }
  const seeded = await seed("sf-all-on");
  await createFeatureFlagRule({ flagKey: TASK_V2_CONVERSATIONS_FEATURE_FLAG_KEY, stage: "server", decision: "allow", values: [seeded.server.id] });
  __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
  const { config, answer } = await startAndAskFeatures(seeded);
  assert.deepEqual(answer.msg.features, {
    subagentDelegation: true,
    passiveAx: true,
    reminderApp: true,
    vaultApp: true,
    piSessionRotation: true,
    wakeRecycleOar: true,
    wakeRecycleTierGate: true,
    turnEndCompaction: true,
    wakeRecycleWarm: true,
    taskConversations: true,
    agentContextView: true,
    inboxItems: true,
    inboxItemsLaunchAt: "2026-01-01T00:00:00.000Z",
    enabledApps: ["artifacts"],
  });
  assert.deepEqual(answer.msg.features, pickAgentServerFeatures(config));
});

/** The Reminder app installed on the server with its legacy migration completed (the gate's second way on). */
async function installMigratedReminderApp(seeded: Awaited<ReturnType<typeof seed>>, clientId: string) {
  const db = getDb();
  const [client] = await db.insert(oauthClients).values({
    serverId: seeded.server.id, clientId, clientSecretHash: "h", name: "Reminder", createdByUserId: seeded.server.ownerId,
    appType: "third_party_global",
  }).returning();
  const [install] = await db.insert(oauthClientInstalls).values({
    serverId: seeded.server.id, clientId: client!.id, installedByUserId: seeded.server.ownerId, approvedScopes: ["agent:notification:write"],
  }).returning();
  await db.insert(reminderAppMigrations).values({ serverId: seeded.server.id, installId: install!.id, state: "completed" });
}

test("server features: the Reminder app installed and migrated, with its flag off, is on in both", async ({ db: _db }) => {
  vi.stubEnv("REMINDER_APP_CLIENT_ID", "reminder-sf");
  try {
    await createFeatureFlag({ key: REMINDER_APP_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: false });
    const seeded = await seed("sf-reminder-installed");
    await installMigratedReminderApp(seeded, "reminder-sf");
    const { config, answer } = await startAndAskFeatures(seeded);
    assert.equal(config.reminderApp, true, "agent:start: flag or installed + migrated");
    assert.deepEqual(answer.msg.features, { reminderApp: true, enabledApps: [] });
    assert.deepEqual(answer.msg.features, pickAgentServerFeatures(config));
  } finally {
    vi.unstubAllEnvs();
  }
});

test("server features: a failing group reads as off at agent:start without turning the others off, and the request is not answered", async ({ db: _db }) => {
  vi.stubEnv("REMINDER_APP_CLIENT_ID", "reminder-sf");
  try {
    await createFeatureFlag({ key: VAULT_APP_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true });
    const seeded = await seed("sf-group-failing");
    __answerFlagForTests(WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, true);
    // Only the Reminder app's install check fails.
    await getDb().execute(sql`alter table oauth_client_installs rename to oauth_client_installs_unavailable`);
    const orchestrator = new CapturingOrchestrator();
    try {
      bindMachine(orchestrator, seeded.machine.id, seeded.server.id);
      assert.deepEqual(await (orchestrator as any).agentServerFeatures(seeded.server.id), { vaultApp: true, enabledApps: ["artifacts"] });
      await orchestrator.handleMachineMessage(seeded.machine.id, { type: "server:features:request", requestId: "req-group" });
      assert.deepEqual(orchestrator.featureAnswers, []);
    } finally {
      await orchestrator.shutdown();
    }
  } finally {
    vi.unstubAllEnvs();
  }
});

test("server features: a flag whose own rules fail to evaluate is the only one off at agent:start", async ({ db: _db }) => {
  await createFeatureFlag({ key: SUBAGENT_DELEGATION_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true });
  await createFeatureFlag({ key: VAULT_APP_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: true });
  await createFeatureFlag({ key: PASSIVE_AX_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: false });
  const seeded = await seed("sf-one-flag-failing");
  await createFeatureFlagRule({ flagKey: TASK_V2_CONVERSATIONS_FEATURE_FLAG_KEY, stage: "server", decision: "allow", values: [seeded.server.id] });
  // Passive AX is on through an audience; only its evaluation reads audience members.
  await getDb().insert(featureFlagAudiences).values({ key: "sf-insiders", name: "Insiders", description: "test cohort", enabled: true });
  await getDb().insert(featureFlagAudienceMembers).values({ audienceKey: "sf-insiders", kind: "server", targetId: seeded.server.id });
  await createFeatureFlagRule({ flagKey: PASSIVE_AX_FEATURE_FLAG_KEY, stage: "audience", decision: "allow", values: ["sf-insiders"] });
  const orchestrator = new CapturingOrchestrator();
  try {
    bindMachine(orchestrator, seeded.machine.id, seeded.server.id);
    const all = { subagentDelegation: true, passiveAx: true, vaultApp: true, taskConversations: true, enabledApps: [] };
    assert.deepEqual(await (orchestrator as any).agentServerFeatures(seeded.server.id), all, "precondition: on through its audience");

    await getDb().execute(sql`alter table feature_flag_audience_members rename to feature_flag_audience_members_unavailable`);
    const { passiveAx: _off, ...others } = all;
    assert.deepEqual(await (orchestrator as any).agentServerFeatures(seeded.server.id), others, "only the failing flag reads as off");
    await orchestrator.handleMachineMessage(seeded.machine.id, { type: "server:features:request", requestId: "req-one-flag" });
    assert.deepEqual(orchestrator.featureAnswers, [], "the request is still not answered");
  } finally {
    await orchestrator.shutdown();
  }
});

// Claude Code removes Opus 4.8 fast mode on 2026-11-30 (a fast request then
// fails). A daemon derives launch flags with its own bundled rules, so the
// start config itself carries the mode as it launches; the saved row keeps fast.
test("a saved fast mode on Claude Opus 4.8 is sent without fast mode; the saved row keeps it", async ({ db }) => {
  const seeded = await seed("opus48-fast");
  const fastConfig = {
    version: 1,
    runtime: "claude",
    provider: { kind: "default" },
    model: { kind: "preset", id: "claude-opus-4-8" },
    mode: { kind: "fast" },
    reasoningEffort: null,
  };
  await db.update(agents).set({ model: "claude-opus-4-8", runtimeConfig: fastConfig as RuntimeConfig }).where(sql`${agents.id} = ${seeded.agent.id}`);
  const config = await startSeededConfig(seeded);
  assert.deepEqual(config.runtimeConfig?.mode, { kind: "default" });
  assert.deepEqual(config.runtimeConfig?.model, { kind: "preset", id: "claude-opus-4-8" });
  const [row] = await db.select({ runtimeConfig: agents.runtimeConfig }).from(agents).where(sql`${agents.id} = ${seeded.agent.id}`);
  assert.deepEqual(row?.runtimeConfig?.mode, { kind: "fast" });
});

test("a saved fast mode on a model that runs fast is sent as fast", async ({ db }) => {
  const seeded = await seed("opus55-fast");
  await db.update(agents).set({
    model: "claude-opus-5-5",
    runtimeConfig: {
      version: 1,
      runtime: "claude",
      provider: { kind: "default" },
      model: { kind: "preset", id: "claude-opus-5-5" },
      mode: { kind: "fast" },
      reasoningEffort: null,
    } as RuntimeConfig,
  }).where(sql`${agents.id} = ${seeded.agent.id}`);
  const config = await startSeededConfig(seeded);
  assert.deepEqual(config.runtimeConfig?.mode, { kind: "fast" });
});
