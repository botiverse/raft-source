import { tokenForHuman, fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { createHmac, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import {
  BasicTracer,
  AGENT_MIGRATION_BUNDLE_CONTENT_TYPE,
  AGENT_MIGRATION_COMMIT_MARKER_PATH,
  AGENT_MIGRATION_CONTROL_SCHEMA_VERSION,
  AGENT_MIGRATION_RESUMABLE_CAPABILITIES,
  AGENT_MIGRATION_RESUMABLE_PROTOCOL,
  AGENT_MIGRATION_SOURCE_WORKSPACE_ARCHIVE_CAPABILITY,
  EXTERNAL_AGENT_RUNTIME_ID,
  EXTERNAL_AGENT_RUNTIME_MODEL,
  KIMI_SDK_FORM_DEFINITION_REF,
  MemoryTraceSink,
  PRO_AGENT_SEAT_BLOCK_SIZE,
  type RuntimeConfig,
} from "@botiverse/raft-shared";
import { RouteFailureError } from "../tracing/routeFailure.js";
import { openTestApp } from "../test/integration/app.js";
import { createHangingStorageTestHarness } from "../test/hangingStorageTestHarness.js";
import { getDb } from "../db/index.js";
import { agentMigrations, agents, featureFlagRules, inboxTargetMuteStates, machines, users, serverMembers, servers, subscriptions } from "../db/schema.js";
import {
  AgentOrchestrator,
  KimiReasoningEffortUpgradeRequiredError,
} from "../services/agentOrchestrator.js";
import { createServer, getAgentMemberRole, getServer, updateServerOnboardingAgent } from "../services/serverService.js";
import {
  assignMachine as assignAgentMachine,
  createAgent,
  deleteAgent,
  getAgent,
  listAgents,
  updateAgent,
  updateAgentStatus,
} from "../services/agentService.js";
import { createMessage } from "../services/messageService.js";
import { addAgent, addHuman, createChannel, findOrCreateAgentDM, findOrCreateDM } from "../services/channelService.js";
import { mintAgentCredential, recordAgentCredentialUse } from "../services/agentCredentialService.js";
import {
  AGENT_MIGRATION_FEATURE_FLAG_KEY,
  GROK_RUNTIME_FEATURE_FLAG_KEY,
} from "../services/featureFlagService.js";
import { MAX_PROFILE_AVATAR_BYTES, PROFILE_AVATAR_TOO_LARGE_MESSAGE } from "../services/avatarService.js";
import {
  __setCdnStorageForTests,
  __setStorageForTests,
  resetStorageForTests,
  type StorageBackend,
} from "../services/storageService.js";
import * as agentMigrationService from "../services/agentMigrationService.js";
import { BuiltInModelCatalogError } from "../services/builtinModelCatalogCompatibility.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });



async function seedUser(email: string, name: string) {
  const db = getDb();
  const [user] = await db.insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

function authHeaders(token: string, serverId: string) {
  return {
    Authorization: `Bearer ${token}`,
    "X-Server-Id": serverId,
  };
}

test("human members can control agent runtime but cannot fully reset its workspace", async ({ app }) => {
    const db = getDb();
    const owner = await seedUser("runtime-member-owner@slock.test", "runtime-member-owner");
    const member = await seedUser("runtime-member@slock.test", "runtime-member");
    const server = await createServer("Runtime Member Server", "runtime-member-server", owner.id);
    await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
    const agent = await createAgent(server.id, "runtime-member-target", {
      runtime: "codex",
      creatorType: "user",
      creatorId: owner.id,
    });
  const memberToken = await tokenForHuman(member.email);

    const stop = await fetch(`${app.baseUrl}/api/agents/${agent.id}/stop`, {
      method: "POST",
      headers: authHeaders(memberToken, server.id),
    });
    assert.equal(stop.status, 200);

    for (const mode of ["restart", "session"] as const) {
      const reset = await fetch(`${app.baseUrl}/api/agents/${agent.id}/reset`, {
        method: "POST",
        headers: { ...authHeaders(memberToken, server.id), "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      assert.equal(reset.status, 200, mode);
    }

    const full = await fetch(`${app.baseUrl}/api/agents/${agent.id}/reset`, {
      method: "POST",
      headers: { ...authHeaders(memberToken, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "full" }),
    });
    assert.equal(full.status, 403);
    assert.match((await full.json() as { error: string }).error, /resetAgentWorkspace/);
});

type WorkspaceTestTimer = { id: number };

class WorkspaceTestClock {
  private nowMs = 0;
  private nextId = 1;
  private timeouts = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.nowMs;
  }

  scheduleRepeated(): WorkspaceTestTimer {
    return { id: this.nextId++ };
  }

  cancelRepeated(): void {}

  setTimeout(fn: () => void, ms: number): WorkspaceTestTimer {
    const handle = { id: this.nextId++ };
    this.timeouts.set(handle.id, { at: this.nowMs + ms, fn });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    if (!handle || typeof handle !== "object" || !("id" in handle)) return;
    this.timeouts.delete((handle as WorkspaceTestTimer).id);
  }

  get pendingTimeouts(): number {
    return this.timeouts.size;
  }

  advance(ms: number): void {
    const target = this.nowMs + ms;
    const due = [...this.timeouts.entries()]
      .filter(([, timer]) => timer.at <= target)
      .sort(([, left], [, right]) => left.at - right.at);
    for (const [id, timer] of due) {
      this.timeouts.delete(id);
      this.nowMs = timer.at;
      timer.fn();
    }
    this.nowMs = target;
  }
}

async function waitForWorkspaceTimeout(clock: WorkspaceTestClock): Promise<void> {
  for (let attempt = 0; attempt < 20 && clock.pendingTimeouts === 0; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(clock.pendingTimeouts, 1, "expected workspace request to schedule its real timeout");
}

async function enableMigrationFlag(serverId: string) {
  await getDb().insert(featureFlagRules).values({
    id: randomUUID(),
    flagKey: AGENT_MIGRATION_FEATURE_FLAG_KEY,
    stage: "server",
    priority: 0,
    decision: "allow",
    values: [serverId],
  });
}

async function enableGrokRuntimeFlag(serverId: string) {
  await getDb().insert(featureFlagRules).values({
    id: randomUUID(),
    flagKey: GROK_RUNTIME_FEATURE_FLAG_KEY,
    stage: "server",
    priority: 0,
    decision: "allow",
    values: [serverId],
  });
}

function signReplicaReplayForTest(method: string, pathWithSearch: string, machineId: string, timestamp: string) {
  const secret = process.env.SLOCK_REPLICA_REPLAY_SECRET || process.env.JWT_SECRET || "test-replica-replay-secret";
  return createHmac("sha256", secret)
    .update(method.toUpperCase())
    .update("\n")
    .update(pathWithSearch)
    .update("\n")
    .update(machineId)
    .update("\n")
    .update(timestamp)
    .digest("hex");
}

async function insertActiveProSubscription(serverId: string, ownerId: string, seatQuantity = 1) {
  await getDb().insert(subscriptions).values({
    serverId,
    plan: "pro",
    provider: "stripe",
    stripeCustomerId: `cus_${randomUUID()}`,
    stripeSubscriptionId: `sub_${randomUUID()}`,
    stripeProPackItemId: `si_pro_${randomUUID()}`,
    status: "active",
    provisionedHumanSeats: seatQuantity,
    provisionedAgentSeats: seatQuantity * PRO_AGENT_SEAT_BLOCK_SIZE,
    proPackQuantity: seatQuantity,
    trialFreePackQuantity: 1,
    firstPackTrialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    currentPeriodStart: new Date(),
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    createdByUserId: ownerId,
    updatedByUserId: ownerId,
  });
}

test("agent create persists structured runtimeConfig and strips it from non-admin list responses", async ({ app }) => {
    const db = getDb();
    const owner = await seedUser("runtime-config-owner@slock.test", "runtime-config-owner");
    const member = await seedUser("runtime-config-member@slock.test", "runtime-config-member");
    const server = await createServer("Runtime Config Server", "runtime-config-server", owner.id);
    await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  const ownerToken = await tokenForHuman(owner.email);
  const memberToken = await tokenForHuman(member.email);

    const createRes = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "runtime-config-agent",
        runtimeConfig: {
          version: 1,
          runtime: "claude",
          provider: { kind: "custom", apiUrl: "https://gateway.example.test/v1", apiKey: "sk-ant-test" },
          model: { kind: "custom", name: "claude-opus-4-6" },
          command: "claude-p",
          envVars: { TEAM_FLAG: "enabled" },
        },
      }),
    });
    assert.equal(createRes.status, 200);
    const created = await createRes.json() as {
      id: string;
      runtime: string;
      model: string;
      envVars: Record<string, string>;
      runtimeConfig: Record<string, unknown>;
    };
    assert.equal(created.runtime, "claude");
    assert.equal(created.model, "claude-opus-4-6");
    assert.deepEqual(created.envVars, {
      TEAM_FLAG: "enabled",
      ANTHROPIC_BASE_URL: "https://gateway.example.test/v1",
      ANTHROPIC_API_KEY: "sk-ant-test",
      ANTHROPIC_CUSTOM_MODEL_OPTION: "claude-opus-4-6",
    });
    assert.deepEqual(created.runtimeConfig, {
      version: 1,
      runtime: "claude",
      provider: { kind: "custom", apiUrl: "https://gateway.example.test/v1", apiKey: "sk-ant-test" },
      model: { kind: "custom", name: "claude-opus-4-6" },
      mode: { kind: "default" },
      reasoningEffort: null,
      command: "claude-p",
      envVars: { TEAM_FLAG: "enabled" },
    });

    const patchRes = await fetch(`${app.baseUrl}/api/agents/${created.id}`, {
      method: "PATCH",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        envVars: {
          TEAM_FLAG: "changed",
          ANTHROPIC_BASE_URL: "https://should-strip.example.test",
          ANTHROPIC_API_KEY: "should-strip",
        },
      }),
    });
    assert.equal(patchRes.status, 200);
    const patched = await patchRes.json() as {
      envVars: Record<string, string>;
      runtimeConfig: Record<string, unknown>;
    };
    assert.deepEqual(patched.runtimeConfig, {
      version: 1,
      runtime: "claude",
      provider: { kind: "custom", apiUrl: "https://gateway.example.test/v1", apiKey: "sk-ant-test" },
      model: { kind: "custom", name: "claude-opus-4-6" },
      mode: { kind: "default" },
      reasoningEffort: null,
      command: "claude-p",
      envVars: { TEAM_FLAG: "changed" },
    });
    assert.deepEqual(patched.envVars, {
      TEAM_FLAG: "changed",
      ANTHROPIC_BASE_URL: "https://gateway.example.test/v1",
      ANTHROPIC_API_KEY: "sk-ant-test",
      ANTHROPIC_CUSTOM_MODEL_OPTION: "claude-opus-4-6",
    });

    const creatorAgent = await createAgent(server.id, "member-created-agent", {
      runtime: "codex",
      envVars: { CREATOR_VISIBLE: "true" },
      creatorType: "user",
      creatorId: member.id,
    });

    const memberListRes = await fetch(`${app.baseUrl}/api/agents`, {
      headers: authHeaders(memberToken, server.id),
    });
    assert.equal(memberListRes.status, 200);
    const memberList = await memberListRes.json() as Array<Record<string, unknown>>;
    const visibleAgent = memberList.find((agent) => agent.id === created.id);
    assert.ok(visibleAgent);
    assert.equal("envVars" in visibleAgent, false);
    assert.equal("runtimeConfig" in visibleAgent, false);
    const creatorVisibleAgent = memberList.find((agent) => agent.id === creatorAgent.id);
    assert.deepEqual(creatorVisibleAgent?.envVars, { CREATOR_VISIBLE: "true" });
});

// The bug this closes: the onboarding modal was the ONLY writer of `setup_status`. A user
// who configured their server the ordinary way — Add Computer, Create Agent, no modal —
// stayed `not_started` forever, so the gate kept demanding setup they had already done
// (132 production servers, 2026-07-13). A server that HAS an agent is set up; the record
// must say so, or the fact and the record drift apart and the gate believes the record.
test("creating an agent records the owner's setup as complete — the ordinary path is a real path", async ({ app }) => {
    const db = getDb();
    const owner = await seedUser("setup-complete-owner@slock.test", "setup-complete-owner");
    const server = await createServer("Setup Complete Server", "setup-complete-server", owner.id);
  const ownerToken = await tokenForHuman(owner.email);

    // Fresh server: the owner has not been through the onboarding modal.
    const [before] = await db
      .select({ status: serverMembers.setupStatus })
      .from(serverMembers)
      .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, owner.id)));
    assert.equal(before?.status, "not_started");

    const createRes = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
      // Deliberately NOT Cindy: someone running any agent has set their server up. Gating
      // this on the official onboarding agent would leave exactly the people who set
      // things up their own way stuck behind a modal telling them to set things up.
      body: JSON.stringify({ name: "ordinary-agent", runtime: "claude" }),
    });
    assert.equal(createRes.status, 200);

    const [after] = await db
      .select({ status: serverMembers.setupStatus, reason: serverMembers.setupCompletionReason })
      .from(serverMembers)
      .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, owner.id)));
    assert.equal(after?.status, "complete");
    // `normal`, not `grandfathered`: this user really did set the server up, just not
    // through our modal. `grandfathered` stays migration-exclusive.
    assert.equal(after?.reason, "normal");
});

test("agent create creates a visible creator DM and hydrates the Chat DM list", async ({ app }) => {
    const db = getDb();
    const owner = await seedUser("creator-dm-owner@slock.test", "creator-dm-owner");
    const member = await seedUser("creator-dm-member@slock.test", "creator-dm-member");
    const server = await createServer("Creator DM Server", "creator-dm-server", owner.id);
    await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  const ownerToken = await tokenForHuman(owner.email);
  const memberToken = await tokenForHuman(member.email);
    const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
    const originalTo = app.io.to.bind(app.io);
    (app.io as any).to = (room: string | string[]) => {
      const operator = originalTo(room as any) as any;
      const originalEmit = operator.emit.bind(operator);
      operator.emit = (event: string, ...args: unknown[]) => {
        emitted.push({ room: String(room), event, payload: args[0] });
        return originalEmit(event, ...args);
      };
      return operator;
    };

    const createRes = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "creator-dm-agent", runtime: "codex" }),
    });
    assert.equal(createRes.status, 200);
    const created = await createRes.json() as { id: string };

    const ownerDmRes = await fetch(`${app.baseUrl}/api/channels/dm`, {
      headers: authHeaders(ownerToken, server.id),
    });
    assert.equal(ownerDmRes.status, 200);
    const ownerDms = await ownerDmRes.json() as Array<{
      id: string;
      peerId: string;
      peerType: string;
      lastMessageAt: string | null;
    }>;
    const creatorDm = ownerDms.find((dm) => dm.peerType === "agent" && dm.peerId === created.id);
    assert.ok(creatorDm, "creator should see a new empty DM with the created agent");
    assert.equal(creatorDm.lastMessageAt, null);

    const memberDmRes = await fetch(`${app.baseUrl}/api/channels/dm`, {
      headers: authHeaders(memberToken, server.id),
    });
    assert.equal(memberDmRes.status, 200);
    const memberDms = await memberDmRes.json() as Array<{ peerId: string; peerType: string }>;
    assert.equal(
      memberDms.some((dm) => dm.peerType === "agent" && dm.peerId === created.id),
      false,
      "other server members should not inherit the creator's new agent DM",
    );

    const sameDm = await findOrCreateDM(server.id, owner.id, created.id);
    assert.equal(sameDm?.id, creatorDm.id, "create path should reuse the canonical creator-agent DM");

    const dmNewEvents = emitted.filter((entry) =>
      entry.event === "dm:new" && (entry.payload as { channelId?: string } | undefined)?.channelId === creatorDm.id
    );
    assert.deepEqual(
      dmNewEvents.map((entry) => entry.room).sort(),
      [`channel:${creatorDm.id}`, `user:${owner.id}`].sort(),
    );
});

// Proof-of-catch for the parse-don't-validate envVars boundary. These assert
// that bad top-level envVars are REJECTED at parse (400 + reason) and never
// persisted, and that valid/null/undefined are handled correctly. If
// parseEnvVars were reverted to a pass-through, the rejection cases below would
// return 200 and create/update the agent with the bad value, failing the test.
test("top-level envVars are parsed at the boundary: bad shapes rejected, valid typed, null/undefined handled", async ({ app }) => {
    const owner = await seedUser("parse-envvars-owner@slock.test", "parse-envvars-owner");
    const server = await createServer("Parse EnvVars Server", "parse-envvars-server", owner.id);
  const ownerToken = await tokenForHuman(owner.email);

    const createAgentReq = (body: Record<string, unknown>) =>
      fetch(`${app.baseUrl}/api/agents`, {
        method: "POST",
        headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const base = { runtime: "claude", model: "sonnet" } as const;

    // (a) invalid shapes are REJECTED at parse with the same reason messages.
    const rejectionCases: Array<{ name: string; envVars: unknown; reason: string }> = [
      { name: "reject-non-object", envVars: "TEAM_FLAG=1", reason: "envVars must be an object" },
      { name: "reject-array", envVars: ["TEAM_FLAG"], reason: "envVars must be an object" },
      { name: "reject-non-string-value", envVars: { TEAM_FLAG: 1 }, reason: "envVars keys and values must be strings" },
      {
        name: "reject-bad-key",
        envVars: { "1BAD": "x" },
        reason: 'Invalid env var key "1BAD": must match [A-Za-z_][A-Za-z0-9_]*',
      },
      {
        name: "reject-null-byte",
        envVars: { TEAM_FLAG: "ab\0cd" },
        reason: "envVars keys and values must not contain null bytes",
      },
    ];
    for (const c of rejectionCases) {
      const res = await createAgentReq({ name: c.name, ...base, envVars: c.envVars });
      assert.equal(res.status, 400, `expected 400 for ${c.name}`);
      const body = await res.json() as { error: string };
      assert.equal(body.error, c.reason, `expected reason for ${c.name}`);
      // Proof-of-catch: the rejection actually blocks creation.
      assert.equal(
        (await listAgents(server.id)).some((agent) => agent.name === c.name),
        false,
        `${c.name} must not be created`,
      );
    }

    // (b) valid envVars parse to the typed value and are persisted.
    const validRes = await createAgentReq({ name: "parse-valid", ...base, envVars: { TEAM_FLAG: "enabled" } });
    assert.equal(validRes.status, 200);
    const validBody = await validRes.json() as { id: string; envVars: Record<string, string> };
    assert.equal(validBody.envVars.TEAM_FLAG, "enabled");

    // (c) null/undefined are handled (no-op: agent created without user envVars).
    const nullRes = await createAgentReq({ name: "parse-null-env", ...base, envVars: null });
    assert.equal(nullRes.status, 200);
    const undefinedRes = await createAgentReq({ name: "parse-undefined-env", ...base });
    assert.equal(undefinedRes.status, 200);

    // Update path: bad envVars rejected and NOT applied; undefined keeps existing.
    const patch = (id: string, body: Record<string, unknown>) =>
      fetch(`${app.baseUrl}/api/agents/${id}`, {
        method: "PATCH",
        headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const badPatchRes = await patch(validBody.id, { envVars: { TEAM_FLAG: 1 } });
    assert.equal(badPatchRes.status, 400);
    const badPatchBody = await badPatchRes.json() as { error: string };
    assert.equal(badPatchBody.error, "envVars keys and values must be strings");
    // Proof-of-catch: existing value is untouched after a rejected update.
    const afterBadPatch = await getAgent(validBody.id);
    assert.equal(afterBadPatch?.envVars?.TEAM_FLAG, "enabled");

    // undefined (omitted) keeps existing; a valid value sets it.
    const keepRes = await patch(validBody.id, { displayName: "renamed" });
    assert.equal(keepRes.status, 200);
    assert.equal((await getAgent(validBody.id))?.envVars?.TEAM_FLAG, "enabled");

    const setRes = await patch(validBody.id, { envVars: { TEAM_FLAG: "changed" } });
    assert.equal(setRes.status, 200);
    assert.equal((await getAgent(validBody.id))?.envVars?.TEAM_FLAG, "changed");
});

test("agent create respects Pro universal seat capacity", async ({ app }) => {
    const owner = await seedUser("agent-seat-limit-owner@slock.test", "agent-seat-limit-owner");
    const server = await createServer("Agent Seat Limit", "agent-seat-limit", owner.id);
    await insertActiveProSubscription(server.id, owner.id, 1);
  const ownerToken = await tokenForHuman(owner.email);

    const createRes = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "seat-limit-agent", runtime: "external", external: true }),
    });

    assert.equal(createRes.status, 400);
    assert.match((await createRes.json() as { error: string }).error, /Seat limit reached \(1\/1 on Pro plan\)/);
});

test("agent create rejects runtime command outside Claude runtime", async ({ app }) => {
    const owner = await seedUser("runtime-command-owner@slock.test", "runtime-command-owner");
    const server = await createServer("Runtime Command Server", "runtime-command-server", owner.id);
  const ownerToken = await tokenForHuman(owner.email);

    const createRes = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "runtime-command-agent",
        runtimeConfig: {
          version: 1,
          runtime: "codex",
          command: "codex-alt",
          model: { kind: "preset", id: "gpt-5.5" },
          mode: { kind: "default" },
          reasoningEffort: null,
          envVars: null,
        },
      }),
    });
    assert.equal(createRes.status, 400);
    const body = await createRes.json() as { error: string };
    assert.equal(body.error, "runtimeConfig.command is not supported for runtime: codex");
});

test("PATCH /agents/:id preserves host-discovered Codex preset model in runtime config response", async ({ app }) => {
    const owner = await seedUser("runtime-dynamic-model-owner@slock.test", "runtime-dynamic-model-owner");
    const server = await createServer("Runtime Dynamic Model Server", "runtime-dynamic-model-server", owner.id);
  const token = await tokenForHuman(owner.email);
    const agent = await createAgent(server.id, "runtime-dynamic-model-agent", { runtime: "codex", model: "gpt-5.5" });

    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: {
        ...authHeaders(token, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        runtime: "codex",
        model: "gpt-5.6-sol",
        runtimeConfig: {
          version: 1,
          runtime: "codex",
          model: { kind: "preset", id: "gpt-5.6-sol" },
          mode: { kind: "default" },
          reasoningEffort: null,
          envVars: null,
        },
        reasoningEffort: null,
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.json() as { model: string; runtimeConfig: { model: unknown } };
    assert.equal(body.model, "gpt-5.6-sol");
    assert.deepEqual(body.runtimeConfig.model, { kind: "preset", id: "gpt-5.6-sol" });

    const updated = await getAgent(agent.id);
    assert.equal(updated?.model, "gpt-5.6-sol");
});

test("external agent create pins sentinel runtime, avoids machine assignment, and projects external", async ({ app }) => {
    const db = getDb();
    const owner = await seedUser("external-create-owner@slock.test", "external-create-owner");
    const server = await createServer("External Create Server", "external-create-server", owner.id);
    const [machine] = await db.insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "available-machine",
      apiKeyHash: "external-create-machine-hash",
      runtimes: ["codex", "claude"],
    }).returning();
  const ownerToken = await tokenForHuman(owner.email);

    const createRes = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "external-api-agent",
        external: true,
        runtime: "claude",
        model: "sonnet",
        runtimeConfig: {
          version: 1,
          runtime: "claude",
          provider: { kind: "custom", apiUrl: "https://gateway.example.test/v1", apiKey: "sk-ant-test" },
          model: { kind: "preset", id: "sonnet" },
          mode: { kind: "fast" },
          reasoningEffort: "high",
          envVars: { SHOULD_DROP: "true" },
        },
        reasoningEffort: "high",
        envVars: { SHOULD_DROP: "true" },
        avatarUrl: "pixel:external-create",
      }),
    });
    assert.equal(createRes.status, 200);
    const created = await createRes.json() as {
      id: string;
      external: boolean;
      runtime: string;
      model: string;
      machineId: string | null;
      reasoningEffort: string | null;
      envVars: Record<string, string> | null;
      runtimeConfig: {
        version: number;
        runtime: string;
        model: { kind: "preset"; id: string };
        mode: { kind: "default" };
        reasoningEffort: null;
        envVars: null;
      };
    };
    assert.equal(created.external, true);
    assert.equal(created.runtime, EXTERNAL_AGENT_RUNTIME_ID);
    assert.equal(created.model, EXTERNAL_AGENT_RUNTIME_MODEL);
    assert.equal(created.machineId, null);
    assert.equal(created.reasoningEffort, null);
    assert.equal(created.envVars, null);
    assert.deepEqual(created.runtimeConfig, {
      version: 1,
      runtime: EXTERNAL_AGENT_RUNTIME_ID,
      model: { kind: "preset", id: EXTERNAL_AGENT_RUNTIME_MODEL },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    });

    const stored = await getAgent(created.id);
    assert.equal(stored?.runtime, EXTERNAL_AGENT_RUNTIME_ID);
    assert.equal(stored?.model, EXTERNAL_AGENT_RUNTIME_MODEL);
    assert.equal(stored?.machineId, null);

    const listRes = await fetch(`${app.baseUrl}/api/agents`, {
      headers: authHeaders(ownerToken, server.id),
    });
    assert.equal(listRes.status, 200);
    const list = await listRes.json() as Array<{ id: string; external?: boolean }>;
    assert.equal(list.find((agent) => agent.id === created.id)?.external, true);

    const machineRes = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "external-machine-rejected",
        external: true,
        machineId: machine.id,
      }),
    });
    assert.equal(machineRes.status, 400);
    const machineBody = await machineRes.json() as { error: string };
    assert.equal(machineBody.error, "External agents cannot be assigned to a Computer");
});

test("external agent setup status follows active credential state", async ({ app }) => {
    const owner = await seedUser("external-status-owner@slock.test", "external-status-owner");
    const server = await createServer("External Status Server", "external-status-server", owner.id);
  const ownerToken = await tokenForHuman(owner.email);

    const createRes = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "external-status-agent",
        external: true,
      }),
    });
    assert.equal(createRes.status, 200);
    const created = await createRes.json() as { id: string };

    const waitingRes = await fetch(`${app.baseUrl}/api/agents/${created.id}/external-status`, {
      headers: authHeaders(ownerToken, server.id),
    });
    assert.equal(waitingRes.status, 200);
    assert.deepEqual(await waitingRes.json(), {
      setupState: "waiting_for_login",
      credentialLastUsedAt: null,
      lastActivityAt: null,
    });

    const credential = await mintAgentCredential({
      agentId: created.id,
      scopes: ["send"],
      name: "status-test",
      createdByUserId: owner.id,
    });

    const mintedRes = await fetch(`${app.baseUrl}/api/agents/${created.id}/external-status`, {
      headers: authHeaders(ownerToken, server.id),
    });
    assert.equal(mintedRes.status, 200);
    assert.deepEqual(await mintedRes.json(), {
      setupState: "credential_minted",
      credentialLastUsedAt: null,
      lastActivityAt: null,
    });

    await recordAgentCredentialUse({
      credentialId: credential.credentialId,
      ip: null,
      userAgent: null,
    });

    const connectedRes = await fetch(`${app.baseUrl}/api/agents/${created.id}/external-status`, {
      headers: authHeaders(ownerToken, server.id),
    });
    assert.equal(connectedRes.status, 200);
    const connected = await connectedRes.json() as {
      setupState: string;
      credentialLastUsedAt: string | null;
      lastActivityAt: string | null;
    };
    assert.equal(connected.setupState, "connected");
    assert.equal(typeof connected.credentialLastUsedAt, "string");
    assert.equal(connected.lastActivityAt, null);

    const managed = await createAgent(server.id, "managed-status-agent", { runtime: "codex" });
    const managedRes = await fetch(`${app.baseUrl}/api/agents/${managed.id}/external-status`, {
      headers: authHeaders(ownerToken, server.id),
    });
    assert.equal(managedRes.status, 400);
    const managedBody = await managedRes.json() as { error: string };
    assert.equal(managedBody.error, "Agent is not external");
});

test("agent server membership rows default to member for new agents", async ({ app }) => {
    const owner = await seedUser("agent-role-owner@slock.test", "agent-role-owner");
    const server = await createServer("Agent Role Server", "agent-role-server", owner.id);
    const agent = await createAgent(server.id, "actor-rbac-agent", { runtime: "codex" });
    assert.equal(await getAgentMemberRole(server.id, agent.id), "member");

  const ownerToken = await tokenForHuman(owner.email);

    const listRes = await fetch(`${app.baseUrl}/api/agents`, {
      headers: authHeaders(ownerToken, server.id),
    });
    assert.equal(listRes.status, 200);
    const list = await listRes.json() as Array<{ id: string; serverRole: string | null }>;
    assert.equal(list.find((item) => item.id === agent.id)?.serverRole, "member");

    const profileRes = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
      headers: authHeaders(ownerToken, server.id),
    });
    assert.equal(profileRes.status, 200);
    const profile = await profileRes.json() as { id: string; serverRole: string | null };
    assert.equal(profile.id, agent.id);
    assert.equal(profile.serverRole, "member");
});

test("POST /api/agents/:id/avatar rejects oversized avatars with a clear limit error", async ({ app }) => {
    const owner = await seedUser("agent-avatar-large-owner@slock.test", "agent-avatar-large-owner");
    const server = await createServer("Agent Avatar Large Server", "agent-avatar-large-server", owner.id);
    const agent = await createAgent(server.id, "agent-avatar-large", { runtime: "codex" });
  const ownerToken = await tokenForHuman(owner.email);

    const formData = new FormData();
    formData.set("avatar", new Blob([new Uint8Array(MAX_PROFILE_AVATAR_BYTES + 1)], { type: "image/png" }), "huge.png");

    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}/avatar`, {
      method: "POST",
      headers: authHeaders(ownerToken, server.id),
      body: formData,
    });

    assert.equal(res.status, 400);
    const body = await res.json() as { error: string; errorCode: string; maxBytes: number };
    assert.equal(body.error, PROFILE_AVATAR_TOO_LARGE_MESSAGE);
    assert.equal(body.errorCode, "PROFILE_AVATAR_TOO_LARGE");
    assert.equal(body.maxBytes, MAX_PROFILE_AVATAR_BYTES);
});

test("GET /api/avatars serves avatars from the configured CDN storage", async ({ app }) => {

  const avatarKey = "avatars/users/0123456789abcdef0123456789abcdef.webp";
  const avatarBytes = new Uint8Array([0x52, 0x41, 0x46, 0x54]);
  const cdnStorage: StorageBackend = {
    async put() {},
    async get(key) {
      assert.equal(key, avatarKey);
      return Readable.from([Buffer.from(avatarBytes)]);
    },
    async delete() {},
  };
  const mainStorage: StorageBackend = {
    async put() {},
    async get() {
      throw new Error("avatar must not be read from the main storage bucket");
    },
    async delete() {},
  };

  try {
    __setStorageForTests(mainStorage);
    __setCdnStorageForTests(cdnStorage);

    const response = await fetch(`${app.baseUrl}/api/avatars/users/0123456789abcdef0123456789abcdef.webp`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/webp");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), avatarBytes);
  } finally {
    await app.close();
    resetStorageForTests();
  }
});

test("GET /api/avatars releases its real upstream Agent socket when the client aborts", async ({ app }) => {
  const harness = await createHangingStorageTestHarness();
  try {
    __setCdnStorageForTests(harness.storage);

    await harness.abortDownload(
      `${app.baseUrl}/api/avatars/users/0123456789abcdef0123456789abcdef.webp`,
      undefined,
      (response) => {
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "image/webp");
        assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
      },
    );
  } finally {
    await harness.close();
    resetStorageForTests();
  }
});

test("agent profile PATCH updates agent server role with human role-transition policy", async ({ app }) => {
    const db = getDb();
    const owner = await seedUser("agent-role-update-owner@slock.test", "agent-role-update-owner");
    const admin = await seedUser("agent-role-update-admin@slock.test", "agent-role-update-admin");
    const member = await seedUser("agent-role-update-member@slock.test", "agent-role-update-member");
    const server = await createServer("Agent Role Update Server", "agent-role-update-server", owner.id);
    await db.insert(serverMembers).values([
      { serverId: server.id, userId: admin.id, role: "admin" },
      { serverId: server.id, userId: member.id, role: "member" },
    ]);
  const ownerToken = await tokenForHuman(owner.email);
  const adminToken = await tokenForHuman(admin.email);
  const memberToken = await tokenForHuman(member.email);
    const ownerManagedAgent = await createAgent(server.id, "owner-managed-agent-role", { runtime: "codex" });
    const adminManagedAgent = await createAgent(server.id, "admin-managed-agent-role", { runtime: "codex" });

    const invalidOwnerRole = await fetch(`${app.baseUrl}/api/agents/${ownerManagedAgent.id}`, {
      method: "PATCH",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ serverRole: "owner" }),
    });
    assert.equal(invalidOwnerRole.status, 400);
    assert.equal(await getAgentMemberRole(server.id, ownerManagedAgent.id), "member");

    const memberDenied = await fetch(`${app.baseUrl}/api/agents/${ownerManagedAgent.id}`, {
      method: "PATCH",
      headers: {
        ...authHeaders(memberToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ serverRole: "admin" }),
    });
    assert.equal(memberDenied.status, 403);
    assert.equal(await getAgentMemberRole(server.id, ownerManagedAgent.id), "member");

    const ownerPromote = await fetch(`${app.baseUrl}/api/agents/${ownerManagedAgent.id}`, {
      method: "PATCH",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ serverRole: "admin" }),
    });
    assert.equal(ownerPromote.status, 200);
    const ownerPromoteBody = await ownerPromote.json() as { serverRole: string | null };
    assert.equal(ownerPromoteBody.serverRole, "admin");
    assert.equal(await getAgentMemberRole(server.id, ownerManagedAgent.id), "admin");

    const adminDemoteDenied = await fetch(`${app.baseUrl}/api/agents/${ownerManagedAgent.id}`, {
      method: "PATCH",
      headers: {
        ...authHeaders(adminToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ serverRole: "member" }),
    });
    assert.equal(adminDemoteDenied.status, 403);
    assert.equal(await getAgentMemberRole(server.id, ownerManagedAgent.id), "admin");

    const adminPromote = await fetch(`${app.baseUrl}/api/agents/${adminManagedAgent.id}`, {
      method: "PATCH",
      headers: {
        ...authHeaders(adminToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ serverRole: "admin" }),
    });
    assert.equal(adminPromote.status, 200);
    const adminPromoteBody = await adminPromote.json() as { serverRole: string | null };
    assert.equal(adminPromoteBody.serverRole, "admin");
    assert.equal(await getAgentMemberRole(server.id, adminManagedAgent.id), "admin");

    const ownerDemote = await fetch(`${app.baseUrl}/api/agents/${ownerManagedAgent.id}`, {
      method: "PATCH",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ serverRole: "member" }),
    });
    assert.equal(ownerDemote.status, 200);
    const ownerDemoteBody = await ownerDemote.json() as { serverRole: string | null };
    assert.equal(ownerDemoteBody.serverRole, "member");
    assert.equal(await getAgentMemberRole(server.id, ownerManagedAgent.id), "member");
});

test("external agent rejects managed runtime mutation, lifecycle, and machine assignment", async ({ app }) => {
    const db = getDb();
    const owner = await seedUser("external-lifecycle-owner@slock.test", "external-lifecycle-owner");
    const server = await createServer("External Lifecycle Server", "external-lifecycle-server", owner.id);
    const [machine] = await db.insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "lifecycle-machine",
      apiKeyHash: "external-lifecycle-machine-hash",
      runtimes: ["codex"],
    }).returning();
  const ownerToken = await tokenForHuman(owner.email);

    const createRes = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "external-lifecycle-agent",
        external: true,
      }),
    });
    assert.equal(createRes.status, 200);
    const created = await createRes.json() as { id: string };

    const profilePatchRes = await fetch(`${app.baseUrl}/api/agents/${created.id}`, {
      method: "PATCH",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        description: "external profile updates still work",
      }),
    });
    assert.equal(profilePatchRes.status, 200);
    const profilePatch = await profilePatchRes.json() as { description: string };
    assert.equal(profilePatch.description, "external profile updates still work");

    const runtimePatchRes = await fetch(`${app.baseUrl}/api/agents/${created.id}`, {
      method: "PATCH",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        runtime: "codex",
      }),
    });
    assert.equal(runtimePatchRes.status, 400);
    const runtimePatchBody = await runtimePatchRes.json() as { error: string };
    assert.equal(runtimePatchBody.error, "External agent runtime fields are immutable");

    let startCalled = false;
    let stopCalled = false;
    let resetCalled = false;
    let evictedAgentId: string | null = null;
    const originalOrchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
    app.app.set("agentOrchestrator", {
      ...originalOrchestrator,
      startAgent: async () => {
        startCalled = true;
      },
      stopAgent: async () => {
        stopCalled = true;
      },
      resetAgent: async () => {
        resetCalled = true;
      },
      evictCache: (agentId: string) => {
        evictedAgentId = agentId;
      },
    });

    for (const action of ["start", "stop", "reset"]) {
      const res = await fetch(`${app.baseUrl}/api/agents/${created.id}/${action}`, {
        method: "POST",
        headers: {
          ...authHeaders(ownerToken, server.id),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ mode: "session" }),
      });
      assert.equal(res.status, 400, action);
      const body = await res.json() as { error: string };
      assert.equal(body.error, "External agents do not use Raft-managed runtime lifecycle");
    }
    assert.equal(startCalled, false);
    assert.equal(stopCalled, false);
    assert.equal(resetCalled, false);

    const assignRes = await fetch(`${app.baseUrl}/api/agents/${created.id}/assign-machine`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ machineId: machine.id }),
    });
    assert.equal(assignRes.status, 400);
    const assignBody = await assignRes.json() as { error: string };
    assert.equal(assignBody.error, "External agents cannot be assigned to a Computer");

    const deleteRes = await fetch(`${app.baseUrl}/api/agents/${created.id}`, {
      method: "DELETE",
      headers: authHeaders(ownerToken, server.id),
    });
    assert.equal(deleteRes.status, 200);
    assert.equal(stopCalled, false);
    assert.equal(evictedAgentId, created.id);
    const deleted = await getAgent(created.id, true);
    assert.ok(deleted?.deletedAt, "external agent should be soft-deleted");
});

test("Built-in preset assignment validates the target catalog before persisting the Computer", async ({ app }) => {
    const owner = await seedUser(
      "builtin-assignment-owner@slock.test",
      "builtin-assignment-owner",
    );
    const server = await createServer(
      "Built-in Assignment",
      "builtin-assignment",
      owner.id,
    );
    const [machine] = await getDb()
      .insert(machines)
      .values({
        serverId: server.id,
        userId: owner.id,
        name: "builtin-assignment-machine",
        apiKeyHash: "unused-builtin-assignment-machine-hash",
        runtimes: ["builtin"],
      })
      .returning();
    const runtimeConfig = {
      version: 1 as const,
      runtime: "builtin" as const,
      provider: {
        kind: "preset" as const,
        providerId: "openai" as const,
        apiKey: "secret",
      },
      model: { kind: "preset" as const, id: "openai/gpt-5.4" },
      mode: { kind: "default" as const },
      hostUserState: "forbidden" as const,
    };
    const accepted = await createAgent(
      server.id,
      "builtin-assignment-accepted",
      {
        runtime: "builtin",
        model: runtimeConfig.model.id,
        runtimeConfig,
      },
    );
    const rejected = await createAgent(
      server.id,
      "builtin-assignment-rejected",
      {
        runtime: "builtin",
        model: runtimeConfig.model.id,
        runtimeConfig,
      },
    );
    await assignAgentMachine(accepted.id, null);
    await assignAgentMachine(rejected.id, null);
    let rejectCatalog = false;
    let validationCalls = 0;
    Object.assign(app.app.get("agentOrchestrator"), {
      hasMachineLocally: () => true,
      validateBuiltInPresetForMachine: async () => {
        validationCalls += 1;
        if (rejectCatalog) {
          throw new BuiltInModelCatalogError(
            "builtin_model_unsupported_by_target",
            "The selected model is not supported by the target Computer. Upgrade the Computer or explicitly choose a supported model.",
            {
              requestedModel: runtimeConfig.model.id,
              daemonVersion: "1.0.23",
              computerVersion: "1.0.23",
              catalogRuntimeVersion: "0.84.3",
              recovery: "upgrade_or_reselect",
            },
          );
        }
        return {
          authority: {
            connectionEpochId: "epoch-a",
            replicaGeneration: "generation-a",
          },
        };
      },
      acquireBuiltInCatalogAuthority: () => () => undefined,
    });
    const token = await tokenForHuman(owner.email);
    const assign = (agentId: string) =>
      fetch(`${app.baseUrl}/api/agents/${agentId}/assign-machine`, {
        method: "POST",
        headers: {
          ...authHeaders(token, server.id),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ machineId: machine.id }),
      });

    const acceptedRes = await assign(accepted.id);
    assert.equal(acceptedRes.status, 200, await acceptedRes.clone().text());
    assert.equal((await getAgent(accepted.id))?.machineId, machine.id);

    rejectCatalog = true;
    const rejectedRes = await assign(rejected.id);
    assert.equal(rejectedRes.status, 409);
    assert.equal(
      ((await rejectedRes.json()) as { code: string }).code,
      "builtin_model_unsupported_by_target",
    );
    assert.equal((await getAgent(rejected.id))?.machineId, null);
    assert.equal(validationCalls, 2);
});

test("POST /api/agents/:id/migrate starts owner migration without target workspace preflight", async ({ app }) => {
    const db = getDb();
    const owner = await seedUser("direct-migrate-owner@slock.test", "direct-migrate-owner");
    const member = await seedUser("direct-migrate-member@slock.test", "direct-migrate-member");
    const server = await createServer("Direct Migration", "direct-migration", owner.id);
    const otherServer = await createServer("Other Runner", "other-runner", owner.id);
    await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
    const now = new Date();
    const [sourceMachine] = await db.insert(machines).values({
      id: randomUUID(),
      serverId: server.id,
      userId: owner.id,
      name: "direct-source",
      apiKeyHash: "source-hash",
      runtimes: ["codex"],
      hostname: "shared-physical-host",
      daemonVersion: "0.72.7",
      lastHeartbeat: now,
    }).returning();
    const [otherServerRunner] = await db.insert(machines).values({
      id: randomUUID(),
      serverId: otherServer.id,
      userId: owner.id,
      name: "direct-source",
      apiKeyHash: "other-server-source-hash",
      runtimes: ["codex"],
      hostname: "shared-physical-host",
      daemonVersion: "0.72.7",
      lastHeartbeat: now,
    }).returning();
    const [targetMachine] = await db.insert(machines).values({
      id: randomUUID(),
      serverId: server.id,
      userId: owner.id,
      name: "direct-target",
      apiKeyHash: "target-hash",
      runtimes: ["codex"],
      daemonVersion: "0.72.7",
      lastHeartbeat: now,
    }).returning();
    const [oldTargetMachine] = await db.insert(machines).values({
      id: randomUUID(),
      serverId: server.id,
      userId: owner.id,
      name: "old-target",
      apiKeyHash: "old-target-hash",
      runtimes: ["codex"],
      daemonVersion: "0.72.6",
      lastHeartbeat: now,
    }).returning();
    const [mixedCapabilityTargetMachine] = await db.insert(machines).values({
      id: randomUUID(),
      serverId: server.id,
      userId: owner.id,
      name: "mixed-capability-target",
      apiKeyHash: "mixed-capability-target-hash",
      runtimes: ["claude"],
      daemonVersion: "0.72.6",
      lastHeartbeat: now,
    }).returning();
    const [runtimeMissingTargetMachine] = await db.insert(machines).values({
      id: randomUUID(),
      serverId: server.id,
      userId: owner.id,
      name: "runtime-missing-target",
      apiKeyHash: "runtime-missing-target-hash",
      runtimes: ["claude"],
      daemonVersion: "0.72.7",
      lastHeartbeat: now,
    }).returning();
    const [offlineTargetMachine] = await db.insert(machines).values({
      id: randomUUID(),
      serverId: server.id,
      userId: owner.id,
      name: "offline-target",
      apiKeyHash: "offline-target-hash",
      runtimes: ["codex"],
      daemonVersion: "0.72.7",
      lastHeartbeat: new Date(now.getTime() - 10 * 60 * 1000),
    }).returning();
    const agent = await createAgent(server.id, "direct-migrate-agent", {
      runtime: "codex",
      machineId: sourceMachine.id,
    });
  const ownerToken = await tokenForHuman(owner.email);
  const memberToken = await tokenForHuman(member.email);
    const originalOrchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
    const sentLeases: Array<{ machineId: string; message: { role: string; transferKind: string; bearerToken?: string } }> = [];
    const liveDaemonVersions = new Map<string, string | null>([
      [sourceMachine.id, "0.0.0-dev"],
      [otherServerRunner.id, "0.72.7"],
      [targetMachine.id, "0.72.7"],
      [oldTargetMachine.id, "0.72.6"],
      [mixedCapabilityTargetMachine.id, "0.72.6"],
      [runtimeMissingTargetMachine.id, "0.72.7"],
      [offlineTargetMachine.id, "0.72.7"],
    ]);
    const daemonVersionLookups: string[] = [];
    const resumableTransport = {
      protocol: AGENT_MIGRATION_RESUMABLE_PROTOCOL,
      capabilities: [...AGENT_MIGRATION_RESUMABLE_CAPABILITIES],
    };
    const sourceResumableTransport = {
      protocol: AGENT_MIGRATION_RESUMABLE_PROTOCOL,
      capabilities: [
        ...AGENT_MIGRATION_RESUMABLE_CAPABILITIES,
        AGENT_MIGRATION_SOURCE_WORKSPACE_ARCHIVE_CAPABILITY,
      ],
    };
    const migrationTransports = new Map<string, {
      protocol: string | null;
      capabilities: string[] | null;
    } | null>([
      [sourceMachine.id, sourceResumableTransport],
      [targetMachine.id, resumableTransport],
      [oldTargetMachine.id, null],
      [offlineTargetMachine.id, resumableTransport],
    ]);
    let provisionerFails = true;
    let provisionerCalls = 0;
    let removedWorkspacePreflightCalls = 0;
    app.app.set("agentOrchestrator", {
      ...originalOrchestrator,
      getMachineStatus: async (machineId: string) => machineId === offlineTargetMachine.id ? "offline" : "online",
      getMachineDaemonVersion: (machineId: string) => {
        daemonVersionLookups.push(machineId);
        return liveDaemonVersions.get(machineId) ?? null;
      },
      getMachineMigrationTransport: async (machineId: string) => migrationTransports.get(machineId) ?? null,
      preflightAgentMigrationTargetWorkspace: async () => {
        removedWorkspacePreflightCalls += 1;
        throw new Error("removed target workspace preflight must not be called");
      },
      sendAgentMigrationTransportLease: async (machineId: string, message: { role: string; transferKind: string; bearerToken?: string }) => {
        sentLeases.push({ machineId, message });
      },
    });
    app.app.set("agentMigrationObjectStoreTransferProvisioner", async () => {
      provisionerCalls += 1;
      if (provisionerFails) {
        throw new Error("R2 presign unavailable");
      }
      return {
        provider: "object_store" as const,
        sessionId: "route-session-1",
        sourceTransferUrl: "https://r2.example.test/agent-migrations/route-session-1/bundle?put=1",
        targetTransferUrl: "https://r2.example.test/agent-migrations/route-session-1/bundle?get=1",
        leaseMs: 60 * 60 * 1000,
        maxBytes: 123_456,
        storageKey: "agent-migrations/route-session-1/bundle",
      };
    });

    const flagDenied = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migrate`, {
      method: "POST",
      headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ targetComputer: targetMachine.id }),
    });
    assert.equal(flagDenied.status, 403);
    assert.equal((await flagDenied.json() as { code?: string }).code, "agent_migration_ui_disabled");
    assert.equal(provisionerCalls, 0, "feature flag must retain precedence over the paywall");
    await enableMigrationFlag(server.id);

    const memberDenied = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migrate`, {
      method: "POST",
      headers: { ...authHeaders(memberToken, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ targetComputer: targetMachine.id }),
    });
    assert.equal(memberDenied.status, 403);
    assert.equal((await memberDenied.json() as { code?: string }).code, "not_supported");

    const staleHostingRunner = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migrate`, {
      method: "POST",
      headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ targetComputer: targetMachine.id }),
    });
    assert.equal(staleHostingRunner.status, 422);
    assert.deepEqual(await staleHostingRunner.json(), {
      error: "Both source and target computers must run daemon >= 0.72.7 with compatible runtime support",
      code: "COMPUTER_CAPABILITY_INSUFFICIENT",
      details: {
        failureReason: "COMPUTER_CAPABILITY_INSUFFICIENT",
        failures: [{
          side: "source",
          reason: "daemon_version_too_old",
          minimumDaemonVersion: "0.72.7",
        }],
      },
    });
    assert.deepEqual(
      daemonVersionLookups,
      [sourceMachine.id, targetMachine.id],
      "capability admission must read the exact source and target server-runner machine ids",
    );
    assert.equal(
      daemonVersionLookups.includes(otherServerRunner.id),
      false,
      "an upgraded runner attachment on the same physical host must not satisfy another server runner's gate",
    );
    assert.equal(provisionerCalls, 0, "stale hosting runner must fail before transport provisioning");
    assert.equal(sentLeases.length, 0, "stale hosting runner must fail before lease dispatch");
    assert.equal(
      (await db.select().from(agentMigrations).where(eq(agentMigrations.agentId, agent.id))).length,
      0,
      "stale hosting runner must not create migration state",
    );

    liveDaemonVersions.set(sourceMachine.id, "0.72.7");
    daemonVersionLookups.length = 0;

    const oldVersion = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migrate`, {
      method: "POST",
      headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ targetComputer: oldTargetMachine.id }),
    });
    assert.equal(oldVersion.status, 422);
    assert.deepEqual(await oldVersion.json(), {
      error: "Both source and target computers must run daemon >= 0.72.7 with compatible runtime support",
      code: "COMPUTER_CAPABILITY_INSUFFICIENT",
      details: {
        failureReason: "COMPUTER_CAPABILITY_INSUFFICIENT",
        failures: [{
          side: "target",
          reason: "daemon_version_too_old",
          minimumDaemonVersion: "0.72.7",
        }],
      },
    });

    const targetRuntimeMissing = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migrate`, {
      method: "POST",
      headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ targetComputer: runtimeMissingTargetMachine.id }),
    });
    assert.equal(targetRuntimeMissing.status, 422);
    assert.deepEqual((await targetRuntimeMissing.json() as { details?: unknown }).details, {
      failureReason: "COMPUTER_CAPABILITY_INSUFFICIENT",
      failures: [{ side: "target", reason: "runtime_missing", runtime: "codex" }],
    });

    await db.update(machines).set({ runtimes: ["claude"] }).where(eq(machines.id, sourceMachine.id));
    const sourceRuntimeMissing = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migrate`, {
      method: "POST",
      headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ targetComputer: targetMachine.id }),
    });
    assert.equal(sourceRuntimeMissing.status, 422);
    assert.deepEqual((await sourceRuntimeMissing.json() as { details?: unknown }).details, {
      failureReason: "COMPUTER_CAPABILITY_INSUFFICIENT",
      failures: [{ side: "source", reason: "runtime_missing", runtime: "codex" }],
    });
    await db.update(machines).set({ runtimes: ["codex"] }).where(eq(machines.id, sourceMachine.id));

    const mixedCapabilities = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migrate`, {
      method: "POST",
      headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ targetComputer: mixedCapabilityTargetMachine.id }),
    });
    assert.equal(mixedCapabilities.status, 422);
    assert.deepEqual(await mixedCapabilities.json(), {
      error: "Both source and target computers must run daemon >= 0.72.7 with compatible runtime support",
      code: "COMPUTER_CAPABILITY_INSUFFICIENT",
      details: {
        failureReason: "COMPUTER_CAPABILITY_INSUFFICIENT",
        failures: [
          {
            side: "target",
            reason: "daemon_version_too_old",
            minimumDaemonVersion: "0.72.7",
          },
          { side: "target", reason: "runtime_missing", runtime: "codex" },
        ],
      },
    });

    liveDaemonVersions.set(sourceMachine.id, null);
    await db.update(machines).set({ daemonVersion: null }).where(eq(machines.id, sourceMachine.id));
    const unconfirmedSourceVersion = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migrate`, {
      method: "POST",
      headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ targetComputer: targetMachine.id }),
    });
    assert.equal(unconfirmedSourceVersion.status, 422);
    assert.deepEqual((await unconfirmedSourceVersion.json() as { details?: unknown }).details, {
      failureReason: "COMPUTER_CAPABILITY_INSUFFICIENT",
      failures: [{
        side: "source",
        reason: "daemon_version_unconfirmed",
        minimumDaemonVersion: "0.72.7",
      }],
    });
    liveDaemonVersions.set(sourceMachine.id, "0.72.7");
    await db.update(machines).set({ daemonVersion: "0.72.7", runtimes: null }).where(eq(machines.id, sourceMachine.id));
    const unconfirmedSourceRuntime = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migrate`, {
      method: "POST",
      headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ targetComputer: targetMachine.id }),
    });
    assert.equal(unconfirmedSourceRuntime.status, 422);
    assert.deepEqual((await unconfirmedSourceRuntime.json() as { details?: unknown }).details, {
      failureReason: "COMPUTER_CAPABILITY_INSUFFICIENT",
      failures: [{ side: "source", reason: "runtime_unconfirmed", runtime: "codex" }],
    });
    await db.update(machines).set({ runtimes: ["codex"] }).where(eq(machines.id, sourceMachine.id));

    const offline = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migrate`, {
      method: "POST",
      headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ targetComputer: offlineTargetMachine.id }),
    });
    assert.equal(offline.status, 409);
    assert.deepEqual(await offline.json(), {
      error: "Target computer is not online",
      code: "TARGET_COMPUTER_OFFLINE",
      details: { failureReason: "TARGET_COMPUTER_OFFLINE" },
    });

    migrationTransports.set(targetMachine.id, null);
    const mixedVersion = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migrate`, {
      method: "POST",
      headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ targetComputer: targetMachine.id }),
    });
    assert.equal(mixedVersion.status, 422);
    assert.deepEqual(await mixedVersion.json(), {
      error: "Both source and target computers must advertise the resumable migration protocol; mixed or old versions cannot downgrade",
      code: "MIGRATION_RESUMABLE_CAPABILITY_REQUIRED",
      details: {
        side: "target",
        reason: "protocol_missing",
        failureReason: "MIGRATION_RESUMABLE_CAPABILITY_REQUIRED",
      },
    });
    assert.equal(provisionerCalls, 0, "mixed-version fail-closed must run before transport provisioning");

    migrationTransports.set(targetMachine.id, resumableTransport);
    migrationTransports.set(sourceMachine.id, {
      protocol: "agent-migration/resumable-v0",
      capabilities: [...AGENT_MIGRATION_RESUMABLE_CAPABILITIES],
    });
    const oldProtocol = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migrate`, {
      method: "POST",
      headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ targetComputer: targetMachine.id }),
    });
    assert.equal(oldProtocol.status, 422);
    assert.deepEqual((await oldProtocol.json() as { details?: unknown }).details, {
      side: "source",
      reason: "protocol_old",
      failureReason: "MIGRATION_RESUMABLE_CAPABILITY_REQUIRED",
    });

    const legacyV1Capabilities = [
      "migration:chunk-upload-v1",
      "migration:chunk-download-v1",
      "migration:staged-atomic-commit-v1",
    ];
    const legacyV1Transport = {
      protocol: "agent-migration/resumable-v1",
      capabilities: legacyV1Capabilities,
    };
    migrationTransports.set(sourceMachine.id, legacyV1Transport);
    const legacySource = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migrate`, {
      method: "POST",
      headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ targetComputer: targetMachine.id }),
    });
    assert.equal(legacySource.status, 422);
    assert.deepEqual((await legacySource.json() as { details?: unknown }).details, {
      side: "source",
      reason: "protocol_old",
      failureReason: "MIGRATION_RESUMABLE_CAPABILITY_REQUIRED",
    });
    assert.equal(removedWorkspacePreflightCalls, 0, "legacy source must not invoke removed workspace preflight");
    assert.equal(provisionerCalls, 0, "legacy source must fail before transport provisioning");
    assert.equal(sentLeases.length, 0, "legacy source must fail before lease dispatch");
    assert.equal(
      (await db.select().from(agentMigrations).where(eq(agentMigrations.agentId, agent.id))).length,
      0,
      "legacy source must fail before migration state is created",
    );

    migrationTransports.set(sourceMachine.id, sourceResumableTransport);
    migrationTransports.set(targetMachine.id, legacyV1Transport);
    const legacyTarget = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migrate`, {
      method: "POST",
      headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ targetComputer: targetMachine.id }),
    });
    assert.equal(legacyTarget.status, 422);
    assert.deepEqual((await legacyTarget.json() as { details?: unknown }).details, {
      side: "target",
      reason: "protocol_old",
      failureReason: "MIGRATION_RESUMABLE_CAPABILITY_REQUIRED",
    });
    assert.equal(removedWorkspacePreflightCalls, 0, "legacy target must not invoke removed workspace preflight");
    assert.equal(provisionerCalls, 0, "legacy target must fail before transport provisioning");
    assert.equal(sentLeases.length, 0, "legacy target must fail before lease dispatch");
    assert.equal(
      (await db.select().from(agentMigrations).where(eq(agentMigrations.agentId, agent.id))).length,
      0,
      "legacy target must fail before migration state is created",
    );
    migrationTransports.set(targetMachine.id, resumableTransport);

    migrationTransports.set(sourceMachine.id, {
      protocol: AGENT_MIGRATION_RESUMABLE_PROTOCOL,
      capabilities: [
        ...legacyV1Capabilities,
        AGENT_MIGRATION_SOURCE_WORKSPACE_ARCHIVE_CAPABILITY,
      ],
    });
    const missingSourceSummaryCapability = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migrate`, {
      method: "POST",
      headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ targetComputer: targetMachine.id }),
    });
    assert.equal(missingSourceSummaryCapability.status, 422);
    assert.deepEqual((await missingSourceSummaryCapability.json() as { details?: unknown }).details, {
      side: "source",
      reason: "capability_missing",
      failureReason: "MIGRATION_RESUMABLE_CAPABILITY_REQUIRED",
    });
    assert.equal(removedWorkspacePreflightCalls, 0, "summary-incompatible source must not invoke removed workspace preflight");
    assert.equal(provisionerCalls, 0, "summary-incompatible source must fail before transport provisioning");
    assert.equal(sentLeases.length, 0, "summary-incompatible source must fail before lease dispatch");
    assert.equal(
      (await db.select().from(agentMigrations).where(eq(agentMigrations.agentId, agent.id))).length,
      0,
      "summary-incompatible source must fail before migration state is created",
    );

    migrationTransports.set(sourceMachine.id, {
      protocol: AGENT_MIGRATION_RESUMABLE_PROTOCOL,
      capabilities: [...AGENT_MIGRATION_RESUMABLE_CAPABILITIES],
    });
    const missingSourceArchiveCapability = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migrate`, {
      method: "POST",
      headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ targetComputer: targetMachine.id }),
    });
    assert.equal(missingSourceArchiveCapability.status, 422);
    assert.deepEqual((await missingSourceArchiveCapability.json() as { details?: unknown }).details, {
      side: "source",
      reason: "capability_missing",
      failureReason: "MIGRATION_RESUMABLE_CAPABILITY_REQUIRED",
    });
    assert.equal(provisionerCalls, 0, "missing source archive capability must fail before provisioning");

    migrationTransports.set(sourceMachine.id, sourceResumableTransport);
    migrationTransports.set(targetMachine.id, {
      protocol: AGENT_MIGRATION_RESUMABLE_PROTOCOL,
      capabilities: [...legacyV1Capabilities],
    });
    const missingTargetSummaryCapability = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migrate`, {
      method: "POST",
      headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ targetComputer: targetMachine.id }),
    });
    assert.equal(missingTargetSummaryCapability.status, 422);
    assert.deepEqual((await missingTargetSummaryCapability.json() as { details?: unknown }).details, {
      side: "target",
      reason: "capability_missing",
      failureReason: "MIGRATION_RESUMABLE_CAPABILITY_REQUIRED",
    });
    assert.equal(removedWorkspacePreflightCalls, 0, "summary-incompatible target must not invoke removed workspace preflight");
    assert.equal(provisionerCalls, 0, "summary-incompatible target must fail before transport provisioning");
    assert.equal(sentLeases.length, 0, "summary-incompatible target must fail before lease dispatch");
    assert.equal(
      (await db.select().from(agentMigrations).where(eq(agentMigrations.agentId, agent.id))).length,
      0,
      "typed resumable failures must not create migration state",
    );
    migrationTransports.set(targetMachine.id, resumableTransport);

    const freeDenied = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migrate`, {
      method: "POST",
      headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ targetComputer: targetMachine.id }),
    });
    assert.equal(freeDenied.status, 403);
    assert.deepEqual(await freeDenied.json(), {
      error: "Agent migration requires the Pro plan.",
      code: "MIGRATION_PRO_PLAN_REQUIRED",
      details: { failureReason: "MIGRATION_PRO_PLAN_REQUIRED" },
    });
    assert.equal(provisionerCalls, 0, "paywall must reject before transport provisioning");
    assert.equal(removedWorkspacePreflightCalls, 0, "paywall must not invoke removed workspace preflight");
    assert.equal(sentLeases.length, 0, "paywall must reject before lease dispatch");
    assert.equal(
      (await db.select().from(agentMigrations).where(eq(agentMigrations.agentId, agent.id))).length,
      0,
      "paywall must reject before migration state is created",
    );

    await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));

    const provisionFailed = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migrate`, {
      method: "POST",
      headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ targetComputer: targetMachine.id }),
    });
    assert.equal(provisionFailed.status, 422);
    assert.equal((await provisionFailed.json() as { code?: string }).code, "MIGRATION_TRANSPORT_PROVISION_FAILED");
    assert.equal(removedWorkspacePreflightCalls, 0, "normal migration must not invoke target workspace preflight");
    assert.equal(sentLeases.length, 0, "failed provisioning must have zero lease side effects");
    let rows = await db.select().from(agentMigrations).where(eq(agentMigrations.agentId, agent.id));
    assert.equal(rows.length, 0, "failed transfer provisioning must not mint a migration grant");

    provisionerFails = false;
    const success = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migrate`, {
      method: "POST",
      headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ targetComputer: "direct-target" }),
    });
    const successText = await success.text();
    assert.equal(success.status, 200, successText);
    const successBody = JSON.parse(successText) as {
      migrationRef: string;
      state: string;
      sourceMachineId: string;
      targetMachineId: string;
      prepDeadlineAt: string;
      transferDeadlineAt: string;
      arrivalDeadlineAt: string;
    };
    assert.equal("migrationId" in successBody, false);
    assert.equal(successBody.state, "provisioning");
    assert.match(successBody.migrationRef, /^mig_[A-Za-z0-9_-]{22}$/);
    assert.equal(successBody.sourceMachineId, sourceMachine.id);
    assert.equal(successBody.targetMachineId, targetMachine.id);
    assert.deepEqual(
      migrationTransports.get(targetMachine.id)?.capabilities,
      [...AGENT_MIGRATION_RESUMABLE_CAPABILITIES],
      "target admission must require only the core resumable capabilities",
    );
    assert.equal(removedWorkspacePreflightCalls, 0, "successful migration must not invoke target workspace preflight");
    assert.ok(successBody.prepDeadlineAt);
    assert.ok(successBody.transferDeadlineAt);
    assert.ok(successBody.arrivalDeadlineAt);

    rows = await db.select().from(agentMigrations).where(eq(agentMigrations.supportRef, successBody.migrationRef));
    assert.equal(rows.length, 1);
    const internalMigrationId = rows[0]!.id;
    assert.equal(rows[0]!.initiatedByUserId, owner.id);
    assert.equal(rows[0]!.state, "provisioning");
    assert.equal(rows[0]!.transportProvider, "object_store");
    assert.equal(rows[0]!.transportSessionId, "route-session-1");
    assert.equal(rows[0]!.sourceTransportUrl, "https://r2.example.test/agent-migrations/route-session-1/bundle?put=1");
    assert.equal(rows[0]!.targetTransportUrl, "https://r2.example.test/agent-migrations/route-session-1/bundle?get=1");
    assert.equal(rows[0]!.transportLeaseSource, "server");
    assert.equal(rows[0]!.transportMaxBytes, 123_456);
    assert.ok(rows[0]!.sourceTransportTokenHash);
    assert.ok(rows[0]!.targetTransportTokenHash);
    assert.equal(sentLeases.length, 2);
    assert.notEqual(rows[0]!.sourceTransportTokenHash, sentLeases[0]?.message.bearerToken);
    assert.notEqual(rows[0]!.targetTransportTokenHash, sentLeases[1]?.message.bearerToken);
    assert.deepEqual(sentLeases.map((lease) => ({
      machineId: lease.machineId,
      role: lease.message.role,
      transferKind: lease.message.transferKind,
      hasBearerToken: Boolean(lease.message.bearerToken),
    })), [
      { machineId: sourceMachine.id, role: "source", transferKind: "upload", hasBearerToken: true },
      { machineId: targetMachine.id, role: "target", transferKind: "download", hasBearerToken: true },
    ]);

    const duplicate = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migrate`, {
      method: "POST",
      headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ targetComputer: targetMachine.id }),
    });
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json() as { code?: string }).code, "MIGRATION_ALREADY_IN_PROGRESS");

    await db.update(agentMigrations).set({
      transportControlManifest: {
        schemaVersion: AGENT_MIGRATION_CONTROL_SCHEMA_VERSION,
        protocol: AGENT_MIGRATION_RESUMABLE_PROTOCOL,
        identity: {
          migrationId: internalMigrationId,
          migrationGeneration: "route-generation-1",
          leaseId: "route-lease-1",
          agentId: agent.id,
          sourceMachineId: sourceMachine.id,
          targetMachineId: targetMachine.id,
        },
        capability: {
          required: AGENT_MIGRATION_RESUMABLE_CAPABILITIES,
        },
        bundle: {
          contentType: AGENT_MIGRATION_BUNDLE_CONTENT_TYPE,
          totalBytes: 1_048_576,
          sha256: "a".repeat(64),
          chunkSizeBytes: 1_048_576,
          chunks: [{
            index: 0,
            offsetBytes: 0,
            sizeBytes: 1_048_576,
            sha256: "b".repeat(64),
          }],
        },
        archive: {
          format: "tar+gzip",
          entryCount: 1_234,
          expandedBytes: 4_194_304,
          maxEntryBytes: 1_048_576,
          allowedEntryTypes: ["file", "symlink"],
        },
        transferSummary: {
          includedFileCount: 1_234,
          includedBytes: 4_194_304,
          excludedRegenerableCount: 0,
          excludedRegenerableByCategory: {
            thirdPartyDependencies: 0,
            caches: 0,
            buildArtifacts: 0,
            otherRegenerable: 0,
          },
          keyWorkspaceEntries: { memoryMdPresent: true, notesPresent: true },
        },
        commit: {
          mode: "atomic-rename",
          markerPath: AGENT_MIGRATION_COMMIT_MARKER_PATH,
          requireWholeBundleDigest: true,
          requireAllChunkDigests: true,
          existingWorkspace: "idle-or-same-commit",
        },
      },
    }).where(eq(agentMigrations.id, internalMigrationId));

    const memberStatusDenied = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migration`, {
      headers: authHeaders(memberToken, server.id),
    });
    assert.equal(memberStatusDenied.status, 403);
    assert.equal((await memberStatusDenied.json() as { code?: string }).code, "not_supported");

    const startedStatus = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migration`, {
      headers: authHeaders(ownerToken, server.id),
    });
    assert.equal(startedStatus.status, 200, await startedStatus.clone().text());
    const startedStatusBody = await startedStatus.json() as {
      migration: Record<string, unknown> | null;
    };
    assert.equal("history" in startedStatusBody, false);
    assert.equal("migrationId" in (startedStatusBody.migration ?? {}), false);
    assert.equal(startedStatusBody.migration?.migrationRef, successBody.migrationRef);
    assert.equal(startedStatusBody.migration?.state, "provisioning");
    assert.ok(Number.isInteger(startedStatusBody.migration?.revision));
    assert.ok(Number(startedStatusBody.migration?.revision) > 0);
    assert.equal(startedStatusBody.migration?.targetMachineId, targetMachine.id);
    assert.equal(startedStatusBody.migration?.transportErrorCode, null);
    assert.equal("transferSummary" in (startedStatusBody.migration ?? {}), false);
    assert.equal("grantKey" in (startedStatusBody.migration ?? {}), false);
    assert.equal("transportControlManifest" in (startedStatusBody.migration ?? {}), false);
    assert.equal("sourceTransportUrl" in (startedStatusBody.migration ?? {}), false);
    assert.equal("targetTransportUrl" in (startedStatusBody.migration ?? {}), false);
    assert.equal("sourceTransportTokenHash" in (startedStatusBody.migration ?? {}), false);
    assert.equal("targetTransportTokenHash" in (startedStatusBody.migration ?? {}), false);
    await db.update(servers).set({ plan: "free" }).where(eq(servers.id, server.id));
    await agentMigrationService.markAgentMigrationTransportLost({
      migrationId: internalMigrationId,
      message: "MIGRATION_OBJECT_STORE_DOWNLOAD_RETRY_EXHAUSTED:404",
    });

    const failedStatus = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migration`, {
      headers: authHeaders(ownerToken, server.id),
    });
    assert.equal(failedStatus.status, 200, await failedStatus.clone().text());
    const failedStatusBody = await failedStatus.json() as {
      migration: {
        migrationRef?: string;
        state?: string;
        failureReason?: string | null;
        transportErrorCode?: string | null;
        transportErrorMessage?: string | null;
        transportLostAt?: string | null;
        transportTeardownAt?: string | null;
      } | null;
    };
    assert.equal("history" in failedStatusBody, false);
    assert.equal("migrationId" in (failedStatusBody.migration ?? {}), false);
    assert.equal(failedStatusBody.migration?.migrationRef, successBody.migrationRef);
    assert.equal(failedStatusBody.migration?.state, "failed");
    assert.equal(failedStatusBody.migration?.failureReason, "MIGRATION_TRANSPORT_LOST");
    assert.equal(failedStatusBody.migration?.transportErrorCode, "MIGRATION_TRANSPORT_LOST");
    assert.equal(failedStatusBody.migration?.transportErrorMessage, "MIGRATION_OBJECT_STORE_DOWNLOAD_RETRY_EXHAUSTED:404");
    assert.ok(failedStatusBody.migration?.transportLostAt);
    assert.ok(failedStatusBody.migration?.transportTeardownAt);
    assert.equal("transferSummary" in (failedStatusBody.migration ?? {}), false);
});

test("POST /api/agents/:id/migration/cancel is owner-gated and dispatches the frozen generation to both Computers", async ({ app }) => {
    const db = getDb();
    const owner = await seedUser("migration-cancel-owner@slock.test", "migration-cancel-owner");
    const member = await seedUser("migration-cancel-member@slock.test", "migration-cancel-member");
    const server = await createServer("Migration Cancel", "migration-cancel", owner.id);
    await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
    const [sourceMachine] = await db.insert(machines).values({
      id: randomUUID(),
      serverId: server.id,
      userId: owner.id,
      name: "cancel-source",
      apiKeyHash: "cancel-source-hash",
    }).returning();
    const [targetMachine] = await db.insert(machines).values({
      id: randomUUID(),
      serverId: server.id,
      userId: owner.id,
      name: "cancel-target",
      apiKeyHash: "cancel-target-hash",
    }).returning();
    const agent = await createAgent(server.id, "cancel-agent", {
      runtime: "codex",
      machineId: sourceMachine.id,
    });
    const now = new Date("2026-08-03T10:00:00.000Z");
    const provisioned = await agentMigrationService.beginAgentMigrationProvisioning({
      agentId: agent.id,
      targetMachineId: targetMachine.id,
      initiatedByUserId: owner.id,
      transportSessionId: "route-cancel-session",
      sourceTransferUrl: "https://r2.example.test/source",
      targetTransferUrl: "https://r2.example.test/target",
      now,
    });
    const [migration] = await db.update(agentMigrations)
      .set({
        state: "in_transit",
        transportGeneration: "route-transport-generation",
        updatedAt: now,
      })
      .where(eq(agentMigrations.id, provisioned.migration.id))
      .returning();
    assert.ok(migration);
  const ownerToken = await tokenForHuman(owner.email);
  const memberToken = await tokenForHuman(member.email);
    await enableMigrationFlag(server.id);
    const deliveries: Array<{ machineId: string; message: Record<string, unknown> }> = [];
    const originalOrchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
    app.app.set("agentOrchestrator", {
      ...originalOrchestrator,
      sendAgentMigrationCancel: async (machineId: string, message: Record<string, unknown>) => {
        deliveries.push({ machineId, message });
      },
    });

    const denied = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migration/cancel`, {
      method: "POST",
      headers: { ...authHeaders(memberToken, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ migrationRef: migration.supportRef, expectedRevision: migration.revision }),
    });
    assert.equal(denied.status, 403);
    assert.equal(deliveries.length, 0);

    for (const body of [
      { migrationId: migration.id, expectedRevision: migration.revision },
      { migrationRef: migration.supportRef, migrationId: migration.id, expectedRevision: migration.revision },
    ]) {
      const invalidIdentity = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migration/cancel`, {
        method: "POST",
        headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(invalidIdentity.status, 400);
      assert.equal((await invalidIdentity.json() as { code?: string }).code, "MIGRATION_REF_INVALID");
      assert.equal(deliveries.length, 0);
    }

    const canceled = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migration/cancel`, {
      method: "POST",
      headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ migrationRef: migration.supportRef, expectedRevision: migration.revision, reason: "owner requested" }),
    });
    const body = await canceled.json() as { migration?: Record<string, unknown> };
    assert.equal(canceled.status, 200, JSON.stringify(body));
    assert.equal("migrationId" in (body.migration ?? {}), false);
    assert.equal(body.migration?.migrationRef, migration.supportRef);
    assert.equal(body.migration?.state, "canceled_pre_flip");
    assert.equal(body.migration?.cancelReason, "owner requested");
    assert.equal(body.migration?.cancelNeedsAttention, false);
    assert.equal(body.migration?.cancelDispatchAttempts, 1);
    assert.equal(typeof body.migration?.cancelLastDispatchAt, "string");
    assert.equal(body.migration?.cancelErrorCode, null);
    assert.equal(body.migration?.cancelErrorMessage, null);
    assert.equal(deliveries.length, 2);
    assert.deepEqual(deliveries.map((delivery) => ({
      machineId: delivery.machineId,
      role: delivery.message.role,
      migrationRef: delivery.message.migrationRef,
      transportGeneration: delivery.message.transportGeneration,
      stopAgent: delivery.message.stopAgent,
    })), [
      {
        machineId: sourceMachine.id,
        role: "source",
        migrationRef: migration.supportRef,
        transportGeneration: "route-transport-generation",
        stopAgent: false,
      },
      {
        machineId: targetMachine.id,
        role: "target",
        migrationRef: migration.supportRef,
        transportGeneration: "route-transport-generation",
        stopAgent: false,
      },
    ]);
});

test("manual agent start completes a retryable migration only after a dispatched receipt", async ({ app }) => {
    const db = getDb();
    const owner = await seedUser("migration-retry-owner@slock.test", "migration-retry-owner");
    const server = await createServer("Migration Retry", "migration-retry", owner.id);
    const now = new Date();
    const [sourceMachine, targetMachine] = await db.insert(machines).values([
      {
        serverId: server.id,
        userId: owner.id,
        name: "migration-retry-source",
        apiKeyHash: "migration-retry-source-hash",
        runtimes: ["codex"],
        lastHeartbeat: now,
      },
      {
        serverId: server.id,
        userId: owner.id,
        name: "migration-retry-target",
        apiKeyHash: "migration-retry-target-hash",
        runtimes: ["codex"],
        lastHeartbeat: now,
      },
    ]).returning();
    const agent = await createAgent(server.id, "migration-retry-agent", {
      runtime: "codex",
      machineId: sourceMachine!.id,
    });
    const migration = await agentMigrationService.beginAgentMigration({
      agentId: agent.id,
      targetMachineId: targetMachine!.id,
      initiatedByUserId: owner.id,
      now,
    });
    await agentMigrationService.markAgentMigrationReady({
      grantKey: migration.grantKey,
      manifestPath: "bundle/manifest.json",
      now,
    });
    await db.update(agentMigrations).set({
      transferSummary: {
        includedFileCount: 1,
        includedBytes: 64,
        excludedRegenerableCount: 0,
        excludedRegenerableByCategory: {
          thirdPartyDependencies: 0,
          caches: 0,
          buildArtifacts: 0,
          otherRegenerable: 0,
        },
        keyWorkspaceEntries: { memoryMdPresent: false, notesPresent: false },
      },
    }).where(eq(agentMigrations.id, migration.id));
    await agentMigrationService.startAgentMigrationTransfer(migration.grantKey, now);
    const arriving = await agentMigrationService.flipAgentMigrationMachine(migration.grantKey, now);
    const archived = await agentMigrationService.recordAgentMigrationSourceWorkspaceArchived({
      grantKey: migration.grantKey,
      migrationGeneration: agentMigrationService.agentMigrationGeneration(arriving),
      serverId: server.id,
      targetMachineId: targetMachine!.id,
      now,
    });
    const arrival = await agentMigrationService.markAgentMigrationTargetImportArrived({
      grantKey: migration.grantKey,
      migrationGeneration: archived.migrationGeneration,
      serverId: server.id,
      targetMachineId: targetMachine!.id,
      now,
    });
    assert.equal(arrival.migration.state, "starting");
    await agentMigrationService.recordAgentMigrationAutoStartFailure({
      grantKey: migration.grantKey,
      agentId: agent.id,
      targetMachineId: targetMachine!.id,
      stage: "start_agent",
      code: "start_not_dispatched",
      now,
    });

    let startedAgentId: string | null = null;
    Object.assign(app.app.get("agentOrchestrator"), {
      hasMachineLocally: () => true,
      startAgent: async (agentId: string) => {
        startedAgentId = agentId;
        return { outcome: "dispatched" as const };
      },
    });
  const ownerToken = await tokenForHuman(owner.email);
    const start = await fetch(`${app.baseUrl}/api/agents/${agent.id}/start`, {
      method: "POST",
      headers: authHeaders(ownerToken, server.id),
    });

    assert.equal(start.status, 200, await start.clone().text());
    assert.equal(startedAgentId, agent.id);
    const [completed] = await db.select().from(agentMigrations).where(eq(agentMigrations.id, migration.id));
    assert.equal(completed.state, "completed");
    assert.equal(completed.failureReason, null);
    assert.ok(completed.completedAt);

    const skippedAgent = await createAgent(server.id, "migration-retry-skipped-agent", {
      runtime: "codex",
      machineId: sourceMachine!.id,
    });
    const skippedMigration = await agentMigrationService.beginAgentMigration({
      agentId: skippedAgent.id,
      targetMachineId: targetMachine!.id,
      initiatedByUserId: owner.id,
      now,
    });
    await agentMigrationService.markAgentMigrationReady({
      grantKey: skippedMigration.grantKey,
      manifestPath: "bundle/skipped-manifest.json",
      now,
    });
    await db.update(agentMigrations).set({
      transferSummary: {
        includedFileCount: 1,
        includedBytes: 64,
        excludedRegenerableCount: 0,
        excludedRegenerableByCategory: {
          thirdPartyDependencies: 0,
          caches: 0,
          buildArtifacts: 0,
          otherRegenerable: 0,
        },
        keyWorkspaceEntries: { memoryMdPresent: false, notesPresent: false },
      },
    }).where(eq(agentMigrations.id, skippedMigration.id));
    await agentMigrationService.startAgentMigrationTransfer(skippedMigration.grantKey, now);
    const skippedArriving = await agentMigrationService.flipAgentMigrationMachine(skippedMigration.grantKey, now);
    const skippedArchived = await agentMigrationService.recordAgentMigrationSourceWorkspaceArchived({
      grantKey: skippedMigration.grantKey,
      migrationGeneration: agentMigrationService.agentMigrationGeneration(skippedArriving),
      serverId: server.id,
      targetMachineId: targetMachine!.id,
      now,
    });
    await agentMigrationService.markAgentMigrationTargetImportArrived({
      grantKey: skippedMigration.grantKey,
      migrationGeneration: skippedArchived.migrationGeneration,
      serverId: server.id,
      targetMachineId: targetMachine!.id,
      now,
    });
    await agentMigrationService.recordAgentMigrationAutoStartFailure({
      grantKey: skippedMigration.grantKey,
      agentId: skippedAgent.id,
      targetMachineId: targetMachine!.id,
      stage: "start_agent",
      code: "start_not_dispatched",
      now,
    });
    Object.assign(app.app.get("agentOrchestrator"), {
      startAgent: async () => ({ outcome: "skipped" as const, reason: "wake_lock_held" as const }),
    });

    const skippedStart = await fetch(`${app.baseUrl}/api/agents/${skippedAgent.id}/start`, {
      method: "POST",
      headers: authHeaders(ownerToken, server.id),
    });
    assert.equal(skippedStart.status, 200, await skippedStart.clone().text());
    const [stillStarting] = await db.select().from(agentMigrations).where(eq(agentMigrations.id, skippedMigration.id));
    assert.equal(stillStarting.state, "starting");
    assert.equal(stillStarting.failureReason, "auto_start_failed");
    assert.equal(stillStarting.completedAt, null);
});

test("DELETE /api/agents/:id soft-deletes even if runtime stop hangs", async () => {
  const previousTimeout = process.env.SLOCK_AGENT_DELETE_STOP_TIMEOUT_MS;
  process.env.SLOCK_AGENT_DELETE_STOP_TIMEOUT_MS = "5";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const owner = await seedUser("delete-hanging-stop-owner@slock.test", "delete-hanging-stop-owner");
    const server = await createServer("Delete Hanging Stop", "delete-hanging-stop", owner.id);
    const agent = await createAgent(server.id, "delete-hanging-stop-agent", { runtime: "codex" });
    const ownerToken = await tokenForHuman(owner.email);

    let stopCalled = false;
    let evictedAgentId: string | null = null;
    const originalOrchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
    app.app.set("agentOrchestrator", {
      ...originalOrchestrator,
      stopAgent: async () => {
        stopCalled = true;
        await new Promise<void>(() => {});
      },
      evictCache: (agentId: string) => {
        evictedAgentId = agentId;
      },
    });

    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
      method: "DELETE",
      headers: authHeaders(ownerToken, server.id),
      signal: AbortSignal.timeout(1_000),
    });
    assert.equal(res.status, 200);
    assert.equal(stopCalled, true);
    assert.equal(evictedAgentId, agent.id);

    const deleted = await getAgent(agent.id, true);
    assert.ok(deleted?.deletedAt, "agent should be soft-deleted even when stop does not return");

    const active = await getAgent(agent.id);
    assert.equal(active, null, "default agent lookup should hide the soft-deleted agent");
  } finally {
    if (previousTimeout === undefined) {
      delete process.env.SLOCK_AGENT_DELETE_STOP_TIMEOUT_MS;
    } else {
      process.env.SLOCK_AGENT_DELETE_STOP_TIMEOUT_MS = previousTimeout;
    }
    await app.close();
  }
});

test("PATCH /agents/:id clears persisted runtime session when runtime changes", async ({ app }) => {
    const owner = await seedUser("runtime-session-reset-owner@slock.test", "runtime-session-reset-owner");
    const server = await createServer("Runtime Session Reset Server", "runtime-session-reset-server", owner.id);
  const token = await tokenForHuman(owner.email);
    const agent = await createAgent(server.id, "runtime-session-reset-agent", { runtime: "claude", model: "sonnet" });
    await updateAgentStatus(agent.id, "active", "claude-session-id");

    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: {
        ...authHeaders(token, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        runtime: "codex",
        model: "gpt-5.3-codex",
      }),
    });

    assert.equal(res.status, 200);
    const updated = await getAgent(agent.id);
    assert.equal(updated?.runtime, "codex");
    assert.equal(updated?.sessionId, null);
});

test("PATCH /agents/:id session reset uses user-facing auto-start semantics", async ({ app }) => {
    const owner = await seedUser("runtime-session-autostart-owner@slock.test", "runtime-session-autostart-owner");
    const server = await createServer("Runtime Session Autostart Server", "runtime-session-autostart-server", owner.id);
  const token = await tokenForHuman(owner.email);
    const agent = await createAgent(server.id, "runtime-session-autostart-agent", { runtime: "claude", model: "sonnet" });
    await updateAgentStatus(agent.id, "inactive", "claude-session-id");

    let evictedAgentId: string | null = null;
    let resetCall: { agentId: string; mode: string; options: unknown } | null = null;
    const originalOrchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
    app.app.set("agentOrchestrator", {
      ...originalOrchestrator,
      evictCache: (agentId: string) => {
        evictedAgentId = agentId;
      },
      resetAgent: async (agentId: string, mode: string, options?: unknown) => {
        resetCall = { agentId, mode, options };
      },
    });

    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: {
        ...authHeaders(token, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        description: "reset session should start the agent",
        restartMode: "session",
      }),
    });

    assert.equal(res.status, 200);
    assert.equal(evictedAgentId, agent.id);
    assert.deepEqual(resetCall, { agentId: agent.id, mode: "session", options: { restartIfStopped: false } });
});

test("PATCH /agents/:id session reset avoids restarting explicit stopped state", async ({ app }) => {
    const owner = await seedUser("runtime-session-stopped-owner@slock.test", "runtime-session-stopped-owner");
    const server = await createServer("Runtime Session Stopped Server", "runtime-session-stopped-server", owner.id);
  const token = await tokenForHuman(owner.email);
    const agent = await createAgent(server.id, "runtime-session-stopped-agent", { runtime: "claude", model: "sonnet" });
    await updateAgentStatus(agent.id, "stopped", "claude-session-id");

    let resetCall: { agentId: string; mode: string; options: unknown } | null = null;
    const originalOrchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
    app.app.set("agentOrchestrator", {
      ...originalOrchestrator,
      resetAgent: async (agentId: string, mode: string, options?: unknown) => {
        resetCall = { agentId, mode, options };
      },
    });

    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: {
        ...authHeaders(token, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        description: "reset session should not start a stopped agent",
        restartMode: "session",
      }),
    });

    assert.equal(res.status, 200);
    assert.deepEqual(resetCall, { agentId: agent.id, mode: "session", options: { restartIfStopped: false } });
});

test("PATCH /agents/:id codex model switch forces session reset even when caller requests restart", async ({ app }) => {
  // tygg/Tenny 2026-07-10: Codex `thread/resume` pins the resumed thread's model,
  // so a plain restart keeps launching the old model (the 5.5→5.6 switch-not-
  // applying hang). The server must upgrade a Codex model switch to a full session
  // reset regardless of the client-sent mode.

    const owner = await seedUser("codex-model-switch-owner@slock.test", "codex-model-switch-owner");
    const server = await createServer("Codex Model Switch Server", "codex-model-switch-server", owner.id);
  const token = await tokenForHuman(owner.email);
    const agent = await createAgent(server.id, "codex-model-switch-agent", { runtime: "codex", model: "gpt-5.3-codex" });
    await updateAgentStatus(agent.id, "inactive", "codex-session-id");

    let resetCall: { agentId: string; mode: string; options: unknown } | null = null;
    const originalOrchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
    app.app.set("agentOrchestrator", {
      ...originalOrchestrator,
      evictCache: () => {},
      resetAgent: async (agentId: string, mode: string, options?: unknown) => {
        resetCall = { agentId, mode, options };
      },
    });

    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: { ...authHeaders(token, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", restartMode: "restart" }),
    });

    assert.equal(res.status, 200);
    // codex model switch must force session reset, not the caller-requested restart.
    assert.deepEqual(resetCall, { agentId: agent.id, mode: "session", options: { restartIfStopped: false } });
});

test("PATCH /agents/:id codex reasoning-only change honors the caller's restart mode", async ({ app }) => {
  // A reasoning-effort-only change is applied reliably via thread/resume + a fresh
  // model_reasoning_effort, so it stays on the caller-selected restart (context kept).

    const owner = await seedUser("codex-reasoning-owner@slock.test", "codex-reasoning-owner");
    const server = await createServer("Codex Reasoning Server", "codex-reasoning-server", owner.id);
  const token = await tokenForHuman(owner.email);
    const agent = await createAgent(server.id, "codex-reasoning-agent", { runtime: "codex", model: "gpt-5.6-sol" });
    await updateAgentStatus(agent.id, "inactive", "codex-session-id");

    let resetCall: { agentId: string; mode: string; options: unknown } | null = null;
    const originalOrchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
    app.app.set("agentOrchestrator", {
      ...originalOrchestrator,
      evictCache: () => {},
      resetAgent: async (agentId: string, mode: string, options?: unknown) => {
        resetCall = { agentId, mode, options };
      },
    });

    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: { ...authHeaders(token, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ reasoningEffort: "high", restartMode: "restart" }),
    });

    assert.equal(res.status, 200);
    // reasoning-effort-only change stays on the caller-selected restart (context kept).
    assert.deepEqual(resetCall, { agentId: agent.id, mode: "restart", options: { restartIfStopped: false } });
});

test("POST /agents rejects provider config for Cursor because current Cursor CLI has no API URL contract", async ({ app }) => {
    const owner = await seedUser("runtime-config-cursor-provider@slock.test", "runtime-config-cursor-provider");
    const server = await createServer("Runtime Config Cursor Provider", "runtime-config-cursor-provider", owner.id);
  const ownerToken = await tokenForHuman(owner.email);

    const res = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "cursor-provider-agent",
        runtimeConfig: {
          version: 1,
          runtime: "cursor",
          provider: { kind: "custom", apiUrl: "https://gateway.example.test/v1", apiKey: "sk-ant-test" },
          model: { kind: "custom", name: "custom-cursor-model" },
        },
      }),
    });

    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.equal(body.error, "runtimeConfig.provider is not supported for runtime: cursor");
});

test("POST /agents rejects malformed structured runtimeConfig", async ({ app }) => {
    const owner = await seedUser("runtime-config-invalid@slock.test", "runtime-config-invalid");
    const server = await createServer("Runtime Config Invalid", "runtime-config-invalid", owner.id);
  const ownerToken = await tokenForHuman(owner.email);

    const res = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "bad-runtime-config-agent",
        runtimeConfig: {
          version: 1,
          runtime: "claude",
          model: { kind: "custom" },
        },
      }),
    });

    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.equal(body.error, "runtimeConfig.model.name is required");

    const missingProviderKeyRes = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "bad-provider-key-agent",
        runtimeConfig: {
          version: 1,
          runtime: "claude",
          provider: { kind: "custom", apiUrl: "https://gateway.example.test/v1" },
          model: { kind: "preset", id: "sonnet" },
        },
      }),
    });
    assert.equal(missingProviderKeyRes.status, 400);
    const missingProviderKeyBody = await missingProviderKeyRes.json() as { error: string };
    assert.equal(missingProviderKeyBody.error, "runtimeConfig.provider.apiKey is required");
});

test("POST /agents rejects deprecated runtimes from legacy and structured runtime inputs", async ({ app }) => {
    const owner = await seedUser("runtime-config-deprecated-create@slock.test", "runtime-config-deprecated-create");
    const server = await createServer("Runtime Config Deprecated Create", "runtime-config-deprecated-create", owner.id);
  const ownerToken = await tokenForHuman(owner.email);

    const legacyRes = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "legacy-kimi-agent",
        runtime: "kimi",
      }),
    });

    assert.equal(legacyRes.status, 400);
    const legacyBody = await legacyRes.json() as { error: string };
    assert.equal(legacyBody.error, "Runtime is deprecated and cannot be selected: kimi");

    const structuredRes = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "structured-gemini-agent",
        runtimeConfig: {
          version: 1,
          runtime: "gemini",
          model: { kind: "custom", name: "gemini-pro" },
        },
      }),
    });

    assert.equal(structuredRes.status, 400);
    const structuredBody = await structuredRes.json() as { error: string };
    assert.equal(structuredBody.error, "Runtime is deprecated and cannot be selected: gemini");
});

test("PATCH /agents/:id rejects transitions into deprecated runtimes but preserves current legacy runtime", async ({ app }) => {
    const owner = await seedUser("runtime-config-deprecated-patch@slock.test", "runtime-config-deprecated-patch");
    const server = await createServer("Runtime Config Deprecated Patch", "runtime-config-deprecated-patch", owner.id);
  const ownerToken = await tokenForHuman(owner.email);
    const activeAgent = await createAgent(server.id, "active-codex-agent", { runtime: "codex", model: "gpt-5" });
    const legacyAgent = await createAgent(server.id, "existing-kimi-agent", { runtime: "kimi", model: "default" });

    const legacyRuntimeRes = await fetch(`${app.baseUrl}/api/agents/${activeAgent.id}`, {
      method: "PATCH",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        runtime: "kimi",
      }),
    });
    assert.equal(legacyRuntimeRes.status, 400);
    const legacyRuntimeBody = await legacyRuntimeRes.json() as { error: string };
    assert.equal(legacyRuntimeBody.error, "Runtime is deprecated and cannot be selected: kimi");

    const structuredRuntimeRes = await fetch(`${app.baseUrl}/api/agents/${activeAgent.id}`, {
      method: "PATCH",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        runtimeConfig: {
          version: 1,
          runtime: "gemini",
          model: { kind: "custom", name: "gemini-pro" },
        },
      }),
    });
    assert.equal(structuredRuntimeRes.status, 400);
    const structuredRuntimeBody = await structuredRuntimeRes.json() as { error: string };
    assert.equal(structuredRuntimeBody.error, "Runtime is deprecated and cannot be selected: gemini");
    assert.equal((await getAgent(activeAgent.id))?.runtime, "codex");

    const sameLegacyRuntimeRes = await fetch(`${app.baseUrl}/api/agents/${legacyAgent.id}`, {
      method: "PATCH",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        description: "keeps existing legacy runtime",
        runtimeConfig: {
          version: 1,
          runtime: "kimi",
          model: { kind: "custom", name: "kimi-k2" },
        },
      }),
    });
    assert.equal(sameLegacyRuntimeRes.status, 200);
    const sameLegacyRuntimeBody = await sameLegacyRuntimeRes.json() as {
      description: string;
      runtime: string;
      runtimeConfig: { runtime: string; model: unknown };
    };
    assert.equal(sameLegacyRuntimeBody.description, "keeps existing legacy runtime");
    assert.equal(sameLegacyRuntimeBody.runtime, "kimi");
    assert.deepEqual(sameLegacyRuntimeBody.runtimeConfig.model, { kind: "custom", name: "kimi-k2" });
});

test("schema-backed Built-in Pi create fails closed, preserves parser authority, and never reads secrets back", async ({ app }) => {
    const owner = await seedUser("builtin-schema-create-owner@slock.test", "builtin-schema-create-owner");
    const server = await createServer(
      "Built-in Schema Create",
      "builtin-schema-create",
      owner.id,
    );
    const [machine] = await getDb()
      .insert(machines)
      .values({
        serverId: server.id,
        userId: owner.id,
        name: "builtin-schema-create-machine",
        apiKeyHash: "unused-builtin-schema-create-machine-hash",
        runtimes: ["builtin"],
      })
      .returning();
    let catalogValidationCalls = 0;
    Object.assign(app.app.get("agentOrchestrator"), {
      hasMachineLocally: () => true,
      validateBuiltInPresetForMachine: async () => {
        catalogValidationCalls += 1;
        return {
          authority: {
            connectionEpochId: "epoch-a",
            replicaGeneration: "generation-a",
          },
        };
      },
      acquireBuiltInCatalogAuthority: () => () => undefined,
    });
    const ownerToken = await tokenForHuman(owner.email);
    const headers = {
      ...authHeaders(ownerToken, server.id),
      "Content-Type": "application/json",
    };
    const formDefinitionRef = {
      protocolVersion: 1,
      runtimeId: "builtin",
      schemaVersion: "builtin-pi.create.v2",
    };
    const presetConfig = {
      version: 1,
      runtime: "builtin",
      provider: { kind: "preset", providerId: "openai", apiKey: "schema-secret-key" },
      model: { kind: "preset", id: "openai/gpt-5.4" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
      hostUserState: "forbidden",
    };
    const create = async (body: Record<string, unknown>) => fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const validRes = await create({
      name: "schema-preset-agent",
      machineId: machine.id,
      formDefinitionRef,
      runtimeConfig: presetConfig,
    });
    assert.equal(validRes.status, 200);
    assert.equal(catalogValidationCalls, 1);
    const validBody = await validRes.json() as {
      id: string;
      runtimeConfig: { provider: { apiKey: string }; hostUserState: string };
    };
    assert.equal(validBody.runtimeConfig.provider.apiKey, "");
    assert.equal(validBody.runtimeConfig.hostUserState, "forbidden");
    assert.equal(JSON.stringify(validBody).includes("schema-secret-key"), false);
    const stored = await getAgent(validBody.id);
    assert.equal((stored?.runtimeConfig as { provider?: { apiKey?: string } } | null)?.provider?.apiKey, "schema-secret-key");

    const omittedRefRes = await create({ name: "schema-omitted-ref-agent", runtimeConfig: presetConfig });
    assert.equal(omittedRefRes.status, 409);
    assert.deepEqual((await omittedRefRes.json() as { issues: unknown }).issues, [
      { code: "form_definition_ref_required", pointer: "/formDefinitionRef" },
    ]);

    const whitespaceOmittedRefRes = await create({
      name: "schema-whitespace-agent",
      runtimeConfig: { ...presetConfig, runtime: " builtin " },
    });
    assert.equal(whitespaceOmittedRefRes.status, 409);
    assert.deepEqual((await whitespaceOmittedRefRes.json() as { issues: unknown }).issues, [
      { code: "form_definition_ref_required", pointer: "/formDefinitionRef" },
    ]);
    assert.equal(
      (await listAgents(server.id)).some((agent) => agent.name === "schema-whitespace-agent"),
      false,
    );

    const externalRefRes = await create({
      name: "external-ref-mismatch-agent",
      external: true,
      formDefinitionRef,
      runtimeConfig: presetConfig,
    });
    assert.equal(externalRefRes.status, 400);
    assert.deepEqual((await externalRefRes.json() as { issues: unknown }).issues, [
      { code: "external_form_definition_forbidden", pointer: "/formDefinitionRef" },
    ]);

    const readRes = await fetch(`${app.baseUrl}/api/agents/${validBody.id}`, {
      headers: authHeaders(ownerToken, server.id),
    });
    assert.equal(readRes.status, 200);
    assert.equal(JSON.stringify(await readRes.json()).includes("schema-secret-key"), false);

    const retainSecretRes = await fetch(`${app.baseUrl}/api/agents/${validBody.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        runtimeConfig: {
          ...presetConfig,
          provider: { kind: "preset", providerId: "openai" },
          envVars: { RETAINED_SECRET_EDIT: "1" },
        },
      }),
    });
    assert.equal(retainSecretRes.status, 200);
    assert.equal(
      catalogValidationCalls,
      1,
      "profile/reasoning/key-only edits preserve the persisted preset without revalidating a new selection",
    );
    const retainSecretBody = await retainSecretRes.json() as {
      runtimeConfig: { provider: { apiKey: string }; envVars: Record<string, string> };
    };
    assert.equal(retainSecretBody.runtimeConfig.provider.apiKey, "");
    assert.deepEqual(retainSecretBody.runtimeConfig.envVars, { RETAINED_SECRET_EDIT: "1" });
    assert.equal(JSON.stringify(retainSecretBody).includes("schema-secret-key"), false);
    const retainedStored = await getAgent(validBody.id);
    assert.equal(
      (retainedStored?.runtimeConfig as { provider?: { apiKey?: string } } | null)?.provider?.apiKey,
      "schema-secret-key",
    );

    const changedProviderWithoutSecretRes = await fetch(`${app.baseUrl}/api/agents/${validBody.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        runtimeConfig: {
          ...presetConfig,
          provider: { kind: "preset", providerId: "deepseek" },
          model: { kind: "preset", id: "deepseek/deepseek-chat" },
        },
      }),
    });
    assert.equal(changedProviderWithoutSecretRes.status, 400);

    const staleRes = await create({
      name: "schema-stale-agent",
      formDefinitionRef: { ...formDefinitionRef, schemaVersion: "stale" },
      runtimeConfig: presetConfig,
    });
    assert.equal(staleRes.status, 409);
    assert.deepEqual((await staleRes.json() as { issues: unknown }).issues, [
      { code: "stale_form_schema", pointer: "/formDefinitionRef/schemaVersion" },
    ]);

    const protocolRes = await create({
      name: "schema-protocol-agent",
      formDefinitionRef: { ...formDefinitionRef, protocolVersion: 2 },
      runtimeConfig: presetConfig,
    });
    assert.equal(protocolRes.status, 409);
    assert.equal((await protocolRes.json() as { issues: Array<{ code: string }> }).issues[0]?.code, "unsupported_form_protocol");

    const hostStateRes = await create({
      name: "schema-host-state-agent",
      formDefinitionRef,
      runtimeConfig: { ...presetConfig, hostUserState: "inherit" },
    });
    assert.equal(hostStateRes.status, 400);
    assert.deepEqual((await hostStateRes.json() as { issues: unknown }).issues, [
      { code: "forbidden_field", pointer: "/runtimeConfig/hostUserState" },
    ]);

    const unknownFieldRes = await create({
      name: "schema-unknown-field-agent",
      formDefinitionRef,
      runtimeConfig: { ...presetConfig, surprise: true },
    });
    assert.equal(unknownFieldRes.status, 400);
    assert.deepEqual((await unknownFieldRes.json() as { issues: unknown }).issues, [
      { code: "unknown_field", pointer: "/runtimeConfig" },
    ]);

    const gatewayConfig = {
      version: 1,
      runtime: "builtin",
      provider: {
        kind: "gateway",
        providerId: "openai-compatible",
        baseUrl: "https://gateway.example.test/v1",
        apiKey: "gateway-secret-key",
        supportsImageInput: true,
      },
      model: { kind: "custom", name: "acme/custom" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    };
    const gatewayRes = await create({
      name: "schema-gateway-agent",
      formDefinitionRef,
      runtimeConfig: gatewayConfig,
    });
    assert.equal(gatewayRes.status, 200);
    const gatewayBody = await gatewayRes.json() as {
      id: string;
      runtimeConfig: { provider: { apiKey: string; baseUrl: string; supportsImageInput?: boolean }; model: unknown };
    };
    assert.equal(gatewayBody.runtimeConfig.provider.apiKey, "");
    assert.equal(gatewayBody.runtimeConfig.provider.baseUrl, "https://gateway.example.test/v1");
    assert.equal(gatewayBody.runtimeConfig.provider.supportsImageInput, true);
    assert.deepEqual(gatewayBody.runtimeConfig.model, { kind: "custom", name: "acme/custom" });

    const retainGatewaySecretRes = await fetch(`${app.baseUrl}/api/agents/${gatewayBody.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        runtimeConfig: {
          ...gatewayConfig,
          provider: {
            kind: "gateway",
            providerId: "openai-compatible",
            baseUrl: " https://gateway.example.test/v1 ",
            supportsImageInput: false,
          },
          envVars: { RETAINED_GATEWAY_SECRET_EDIT: "1" },
        },
      }),
    });
    assert.equal(retainGatewaySecretRes.status, 200);
    const retainGatewaySecretBody = await retainGatewaySecretRes.json() as {
      runtimeConfig: {
        provider: { apiKey: string; baseUrl: string; supportsImageInput?: boolean };
        envVars: Record<string, string>;
      };
    };
    assert.equal(retainGatewaySecretBody.runtimeConfig.provider.apiKey, "");
    assert.equal(retainGatewaySecretBody.runtimeConfig.provider.baseUrl, "https://gateway.example.test/v1");
    assert.equal(retainGatewaySecretBody.runtimeConfig.provider.supportsImageInput, false);
    assert.deepEqual(retainGatewaySecretBody.runtimeConfig.envVars, { RETAINED_GATEWAY_SECRET_EDIT: "1" });
    const retainedGatewayStored = await getAgent(gatewayBody.id);
    const retainedGatewayStoredProvider = (retainedGatewayStored?.runtimeConfig as {
      provider?: { apiKey?: string; supportsImageInput?: boolean };
    } | null)?.provider;
    assert.equal(retainedGatewayStoredProvider?.apiKey, "gateway-secret-key");
    assert.equal(retainedGatewayStoredProvider?.supportsImageInput, false);

    const changedGatewayUrlWithoutSecretRes = await fetch(`${app.baseUrl}/api/agents/${gatewayBody.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        runtimeConfig: {
          ...gatewayConfig,
          provider: {
            kind: "gateway",
            providerId: "openai-compatible",
            baseUrl: "https://attacker.example.test/v1",
            supportsImageInput: true,
          },
        },
      }),
    });
    assert.equal(changedGatewayUrlWithoutSecretRes.status, 400);
    const gatewayStoredAfterRejectedUrlChange = await getAgent(gatewayBody.id);
    const gatewayStoredProvider = (gatewayStoredAfterRejectedUrlChange?.runtimeConfig as {
      provider?: { baseUrl?: string; apiKey?: string; supportsImageInput?: boolean };
    } | null)?.provider;
    assert.equal(gatewayStoredProvider?.baseUrl, "https://gateway.example.test/v1");
    assert.equal(gatewayStoredProvider?.apiKey, "gateway-secret-key");
    assert.equal(gatewayStoredProvider?.supportsImageInput, false);

    const legacyRes = await create({
      name: "legacy-codex-still-works",
      runtimeConfig: {
        version: 1,
        runtime: "codex",
        model: { kind: "preset", id: "gpt-5" },
        mode: { kind: "default" },
      },
    });
    assert.equal(legacyRes.status, 200);
});

test("Kimi create tolerates a legacy daemon that cannot answer detect, but only when no effort was requested", async ({ app }) => {
  const owner = await seedUser("kimi-legacy-detect-owner@slock.test", "kimi-legacy-detect-owner");
  const server = await createServer("Kimi Legacy Detect", "kimi-legacy-detect", owner.id);
  const [machine] = await getDb().insert(machines).values({
    serverId: server.id,
    userId: owner.id,
    name: "kimi-legacy-detect-machine",
    apiKeyHash: "kimi-legacy-detect-machine-hash",
    runtimes: ["kimi-sdk"],
  }).returning();
  const orchestrator = app.app.get("agentOrchestrator") as {
    detectMachineRuntimeModels: () => Promise<unknown>;
  };
  const ownerToken = await tokenForHuman(owner.email);
  const headers = { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" };
  const baseRuntimeConfig: RuntimeConfig = {
    version: 1,
    runtime: "kimi-sdk",
    model: { kind: "preset", id: "kimi-code/k3" },
    mode: { kind: "default" },
    reasoningEffort: null,
    envVars: null,
  };

  // (a) daemon_timeout + no requested effort => downgrade, creation still succeeds.
  for (const subkind of ["daemon_timeout", "daemon_offline"] as const) {
    orchestrator.detectMachineRuntimeModels = async () => {
      throw new RouteFailureError(subkind, `detect failed: ${subkind}`);
    };
    const legacyCreated: Response = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: `kimi-legacy-${subkind}`, machineId: machine.id, runtimeConfig: baseRuntimeConfig }),
    });
    const legacyBody = await legacyCreated.clone().text();
    assert.equal(legacyCreated.status, 200, `${subkind} with null effort must still create: ${legacyBody}`);
  }

  // (b) an explicitly requested effort must NOT be downgraded - it fails closed.
  orchestrator.detectMachineRuntimeModels = async () => {
    throw new RouteFailureError("daemon_timeout", "detect failed: daemon_timeout");
  };
  const withEffort = await fetch(`${app.baseUrl}/api/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "kimi-legacy-effort-requested",
      machineId: machine.id,
      runtimeConfig: { ...baseRuntimeConfig, reasoningEffort: "balanced-plus" },
    }),
  });
  // Without formDefinitionRef the request never reaches detect -- the earlier
  // /formDefinitionRef guard turns it away first. Asserted so the two paths stay distinct.
  assert.equal(withEffort.status, 409, await withEffort.clone().text());
  assert.equal((await withEffort.json() as { code?: string }).code, "upgrade_required");

  // (b2) Supplying formDefinitionRef gets past that guard, so the request actually reaches
  // detect. With detect unreachable and an effort explicitly requested, the catch guard's
  // `reasoningEffort !== null` clause is the ONLY thing preventing a silent downgrade:
  // delete it and the agent is created carrying an effort whose capability was never
  // verified (observed: 200). Fail-closed is asserted as the exact status rather than
  // "not 200", so that a malformed request (e.g. a name over the 32-char limit, which
  // also is not 200) cannot make this pass for the wrong reason.
  for (const subkind of ["daemon_timeout", "daemon_offline"] as const) {
    orchestrator.detectMachineRuntimeModels = async () => {
      throw new RouteFailureError(subkind, `detect failed: ${subkind}`);
    };
    const effortReachingDetect: Response = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: `kimi-eff-fc-${subkind === "daemon_timeout" ? "to" : "off"}`,
        machineId: machine.id,
        formDefinitionRef: KIMI_SDK_FORM_DEFINITION_REF,
        runtimeConfig: { ...baseRuntimeConfig, reasoningEffort: "balanced-plus" },
      }),
    });
    const failClosedBody = await effortReachingDetect.clone().text();
    // Pin the REJECTION, not the status mapping (500-vs-typed-409 is task #409).
    // 400 is excluded explicitly: a malformed request is also "not 200", and an
    // over-long agent name once made an earlier draft of this test pass while never
    // reaching the guard at all.
    assert.notEqual(effortReachingDetect.status, 200, `POST ${subkind}: explicit effort was silently downgraded: ${failClosedBody}`);
    assert.notEqual(effortReachingDetect.status, 400, `POST ${subkind}: request was malformed, so it never reached the guard: ${failClosedBody}`);
  }

  // (b3) Same tooth on PATCH: its catch carries the identical clause and the identical
  // /formDefinitionRef precondition, so the same downgrade is reachable through edit.
  const editable = await fetch(`${app.baseUrl}/api/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "kimi-eff-patch-base", machineId: machine.id, runtimeConfig: baseRuntimeConfig }),
  });
  assert.equal(editable.status, 200, await editable.clone().text());
  const editableId = (await editable.json() as { id: string }).id;
  for (const subkind of ["daemon_timeout", "daemon_offline"] as const) {
    orchestrator.detectMachineRuntimeModels = async () => {
      throw new RouteFailureError(subkind, `detect failed: ${subkind}`);
    };
    const patched: Response = await fetch(`${app.baseUrl}/api/agents/${editableId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        formDefinitionRef: KIMI_SDK_FORM_DEFINITION_REF,
        runtimeConfig: { ...baseRuntimeConfig, reasoningEffort: "balanced-plus" },
      }),
    });
    const patchedBody = await patched.clone().text();
    assert.notEqual(patched.status, 200, `PATCH ${subkind}: explicit effort was silently downgraded: ${patchedBody}`);
    assert.notEqual(patched.status, 400, `PATCH ${subkind}: request was malformed, so it never reached the guard: ${patchedBody}`);
    // and no effort may have been persisted
    const after = await getAgent(editableId);
    assert.equal(
      (after?.runtimeConfig as { reasoningEffort?: string | null } | null)?.reasoningEffort ?? null,
      null,
      `PATCH ${subkind}: an unverified effort was written to storage`,
    );
  }

  // (c) An answered non-live daemon: staging must behave EXACTLY as v1.12.2 does in
  // production. PRODUCT DECISION (@artin, 2026-09-06, #proj-uiux:8cf7b0a7 and DM):
  // "1.12.2 已经修复的，staging 必须一样" -- if v1.12.2 refuses a kind, staging refuses it;
  // if v1.12.2 admits it, staging admits it.
  //
  // Why this is not the same as "answered means refuse": Computers older than 1.0.25 DO
  // implement the detect call (handler landed 2026-04-14, #768 -- earlier than every
  // computer-v1.0.x tag), so a legacy machine ANSWERS. One whose Kimi is simply not
  // logged in answers `missing_config`. Refusing that is what broke creation for the
  // very users #7409 was written for.
  //
  // Split, mirroring v1.12.2 exactly:
  //   unsupported                      -> 409, whatever the effort   (kept)
  //   missing_config/no_models/error   -> downgraded when no effort was requested
  // Accepted cost (@artin's call): a not-logged-in user creates successfully and only
  // learns at runtime. ⛔ Do not re-narrow without asking him.
  const answeredRefusedKinds = ["unsupported"] as const;
  const answeredDowngradedKinds = ["missing_config", "no_models", "error"] as const;

  for (const kind of answeredRefusedKinds) {
    orchestrator.detectMachineRuntimeModels = async () => ({ kind });
    const answered: Response = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: `kimi-answered-${kind}`, machineId: machine.id, runtimeConfig: baseRuntimeConfig }),
    });
    assert.equal(answered.status, 409, `POST ${kind}: v1.12.2 refuses this kind, so staging must too: ${await answered.clone().text()}`);
    assert.equal(
      (await answered.json() as { issues: Array<{ code: string }> }).issues[0]?.code,
      `runtime_model_source_${kind}`,
      `POST ${kind}: the typed code must name the kind the daemon reported`,
    );
  }

  for (const kind of answeredDowngradedKinds) {
    orchestrator.detectMachineRuntimeModels = async () => ({ kind });
    const answered: Response = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: `kimi-answered-${kind}`, machineId: machine.id, runtimeConfig: baseRuntimeConfig }),
    });
    assert.equal(
      answered.status,
      200,
      `POST ${kind}: v1.12.2 admits this kind when no effort was requested, so staging must too: ${await answered.clone().text()}`,
    );
  }

  // (c2) Same split on PATCH -- its block carries the identical shape. `unsupported` is
  // exercised first and asserts storage was NOT written; the downgraded kinds run after
  // and DO write, so a shared `before` snapshot would be corrupted by them.
  orchestrator.detectMachineRuntimeModels = async () => {
    throw new RouteFailureError("daemon_timeout", "detect failed: daemon_timeout");
  };
  const answeredEditable = await fetch(`${app.baseUrl}/api/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "kimi-answered-patch-base", machineId: machine.id, runtimeConfig: baseRuntimeConfig }),
  });
  assert.equal(answeredEditable.status, 200, await answeredEditable.clone().text());
  const answeredEditableId = (await answeredEditable.json() as { id: string }).id;

  for (const kind of answeredRefusedKinds) {
    const beforeModel = (await getAgent(answeredEditableId))?.runtimeConfig as { model?: unknown } | null;
    orchestrator.detectMachineRuntimeModels = async () => ({ kind });
    const patchedAnswered: Response = await fetch(`${app.baseUrl}/api/agents/${answeredEditableId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ runtimeConfig: { ...baseRuntimeConfig, model: { kind: "preset", id: "kimi-code/k2" } } }),
    });
    assert.equal(patchedAnswered.status, 409, `PATCH ${kind}: v1.12.2 refuses this kind, so staging must too: ${await patchedAnswered.clone().text()}`);
    assert.equal(
      (await patchedAnswered.json() as { issues: Array<{ code: string }> }).issues[0]?.code,
      `runtime_model_source_${kind}`,
      `PATCH ${kind}: the typed code must name the kind the daemon reported`,
    );
    const afterModel = (await getAgent(answeredEditableId))?.runtimeConfig as { model?: unknown } | null;
    assert.deepEqual(afterModel?.model, beforeModel?.model, `PATCH ${kind}: config was written despite the 409`);
  }

  for (const kind of answeredDowngradedKinds) {
    orchestrator.detectMachineRuntimeModels = async () => ({ kind });
    const patchedAnswered: Response = await fetch(`${app.baseUrl}/api/agents/${answeredEditableId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ runtimeConfig: { ...baseRuntimeConfig, model: { kind: "preset", id: "kimi-code/k2" } } }),
    });
    assert.equal(
      patchedAnswered.status,
      200,
      `PATCH ${kind}: v1.12.2 admits this kind when no effort was requested, so staging must too: ${await patchedAnswered.clone().text()}`,
    );
  }
});

for (const subkind of ["daemon_timeout", "daemon_offline"] as const) {
  test(`Kimi full onboarding create and edit return recoverable ${subkind} without writes`, async ({ app }) => {
    const owner = await seedUser(`kimi-recover-${subkind}@slock.test`, `kimi-recover-${subkind}`);
    const server = await createServer("Kimi Recover", `kimi-recover-${subkind}`, owner.id);
    const [machine] = await getDb().insert(machines).values({
      serverId: server.id, userId: owner.id, name: "kimi-recover-machine",
      apiKeyHash: `kimi-recover-${subkind}`, runtimes: ["kimi-sdk"],
    }).returning();
    const headers = { ...authHeaders(await tokenForHuman(owner.email), server.id), "Content-Type": "application/json" };
    const runtimeConfig: RuntimeConfig = {
      version: 1, runtime: "kimi-sdk", model: { kind: "preset", id: "kimi-code/k3" },
      mode: { kind: "default" }, reasoningEffort: "high", envVars: null,
    };
    const request = {
      name: "Cindy", description: "Onboarding Assistant", model: "kimi-code/k3", runtime: "kimi-sdk",
      runtimeConfig, formDefinitionRef: KIMI_SDK_FORM_DEFINITION_REF,
      machineId: machine.id, avatarUrl: "pixel:mug", onboarding: true,
    };
    const orchestrator = app.app.get("agentOrchestrator") as {
      detectMachineRuntimeModels: (machineId: string, runtime: string) => Promise<unknown>;
    };
    let calls = 0;
    orchestrator.detectMachineRuntimeModels = async (id, runtime) => {
      assert.equal(id, machine.id);
      assert.equal(runtime, "kimi-sdk");
      calls++;
      throw new RouteFailureError(subkind, "private daemon detail must not reach the response");
    };
    const expectedCode = subkind === "daemon_timeout" ? "runtime_model_source_timeout" : "runtime_model_source_offline";
    async function assertUnavailable(response: Response) {
      const body = await response.json() as { error: string; code: string; issues: unknown };
      assert.equal(response.status, 409, JSON.stringify(body));
      assert.equal(body.code, expectedCode);
      assert.deepEqual(body.issues, [{ code: expectedCode, pointer: "/runtimeConfig/model" }]);
      assert.match(body.error, /try again/i);
      assert.doesNotMatch(body.error, /private daemon/);
    }
    await assertUnavailable(await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST", headers, body: JSON.stringify(request),
    }));
    assert.equal(calls, 1, "complete onboarding request must reach detect");
    assert.equal((await listAgents(server.id)).length, 0, "failed create must not write an agent");
    assert.equal((await getServer(server.id))?.onboardingAgentId, null);

    const editable = await createAgent(server.id, "kimi-edit-recover", {
      runtime: "kimi-sdk", model: "kimi-code/k3", machineId: machine.id,
      runtimeConfig: { ...runtimeConfig, reasoningEffort: null },
    });
    const before = await getAgent(editable.id);
    await assertUnavailable(await fetch(`${app.baseUrl}/api/agents/${editable.id}`, {
      method: "PATCH", headers, body: JSON.stringify({
        runtimeConfig, formDefinitionRef: KIMI_SDK_FORM_DEFINITION_REF, description: "must not persist",
      }),
    }));
    assert.equal(calls, 2);
    assert.deepEqual(await getAgent(editable.id), before, "failed edit must leave the complete agent row unchanged");

    orchestrator.detectMachineRuntimeModels = async () => ({
      kind: "live", value: { default: "kimi-code/k3", models: [{
        id: "kimi-code/k3", label: "K3", supportedReasoningEfforts: ["high"], defaultReasoningEffort: "high",
      }] },
    });
    const retry = await fetch(`${app.baseUrl}/api/agents`, { method: "POST", headers, body: JSON.stringify(request) });
    const created = await retry.json() as { id: string; runtimeConfig: RuntimeConfig };
    assert.equal(retry.status, 200, JSON.stringify(created));
    assert.equal(created.runtimeConfig.reasoningEffort, "high", "retry must retain the selected effort");
    assert.equal((await getServer(server.id))?.onboardingAgentId, created.id);
    assert.equal((await getAgent(created.id))?.runtimeConfig?.reasoningEffort, "high");
  });
}

test("schema-backed Kimi create and edit use the same live per-model effort authority", async ({ app }) => {
    const owner = await seedUser("kimi-schema-owner@slock.test", "kimi-schema-owner");
    const server = await createServer("Kimi Schema", "kimi-schema", owner.id);
    const [machine] = await getDb().insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "kimi-schema-machine",
      apiKeyHash: "kimi-schema-machine-hash",
      runtimes: ["kimi-sdk"],
    }).returning();
    const orchestrator = app.app.get("agentOrchestrator") as {
      detectMachineRuntimeModels: () => Promise<unknown>;
    };
    orchestrator.detectMachineRuntimeModels = async () => ({
      kind: "live",
      value: {
        default: "kimi-code/k3",
        models: [
          {
            id: "kimi-code/k3",
            label: "K3",
            supportedReasoningEfforts: ["balanced-plus"],
            defaultReasoningEffort: "balanced-plus",
          },
          { id: "kimi-code/k2", label: "K2" },
        ],
      },
    });
  const ownerToken = await tokenForHuman(owner.email);
    const headers = {
      ...authHeaders(ownerToken, server.id),
      "Content-Type": "application/json",
    };
    const runtimeConfig: RuntimeConfig = {
      version: 1,
      runtime: "kimi-sdk",
      model: { kind: "preset", id: "kimi-code/k3" },
      mode: { kind: "default" },
      reasoningEffort: "balanced-plus",
      envVars: null,
    };

    const { reasoningEffort: _omittedLegacyCreateEffort, ...legacyCreateRuntimeConfig } = runtimeConfig;
    const legacyOmittedCreate = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "kimi-legacy-omitted-create",
        machineId: machine.id,
        runtimeConfig: legacyCreateRuntimeConfig,
      }),
    });
    assert.equal(legacyOmittedCreate.status, 200, await legacyOmittedCreate.clone().text());

    const legacyCreate = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "kimi-legacy-create",
        machineId: machine.id,
        runtimeConfig: { ...runtimeConfig, reasoningEffort: null },
      }),
    });
    assert.equal(legacyCreate.status, 200, await legacyCreate.clone().text());

    const legacyExplicitEffort = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "kimi-legacy-explicit-effort", machineId: machine.id, runtimeConfig }),
    });
    assert.equal(legacyExplicitEffort.status, 409);
    assert.equal((await legacyExplicitEffort.json() as { code?: string }).code, "upgrade_required");

    const missingMetadataWrite = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "kimi-missing-metadata-write",
        machineId: machine.id,
        formDefinitionRef: KIMI_SDK_FORM_DEFINITION_REF,
        runtimeConfig: {
          ...runtimeConfig,
          model: { kind: "preset", id: "kimi-code/k2" },
        },
      }),
    });
    assert.equal(missingMetadataWrite.status, 409);
    assert.equal((await missingMetadataWrite.clone().json() as { code?: string }).code, "upgrade_required");
    assert.equal(
      (await missingMetadataWrite.json() as { issues: Array<{ pointer: string }> }).issues[0]?.pointer,
      "/runtimeConfig/reasoningEffort",
    );

    const createRes = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "kimi-schema-agent",
        machineId: machine.id,
        formDefinitionRef: KIMI_SDK_FORM_DEFINITION_REF,
        runtimeConfig,
      }),
    });
    assert.equal(createRes.status, 200);
    const created = await createRes.json() as { id: string };
    const stored = await getAgent(created.id);
    assert.equal(stored?.reasoningEffort, null);
    assert.equal((stored?.runtimeConfig as { reasoningEffort?: string } | null)?.reasoningEffort, "balanced-plus");

    // Compatibility specimens must be storage-constructed. Creating this
    // unknown value through the new write path would test the producer, not a
    // released no-ref client reading and saving a pre-existing row.
    await getDb().update(agents).set({
      runtimeConfig: {
        ...runtimeConfig,
        envVars: { DIRECT_STORAGE_SPECIMEN: "1" },
      },
    }).where(eq(agents.id, created.id));

    const { reasoningEffort: _omittedLegacyEditEffort, ...legacyEditRuntimeConfig } = runtimeConfig;
    const legacyOmittedSameModelEdit = await fetch(`${app.baseUrl}/api/agents/${created.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        runtimeConfig: {
          ...legacyEditRuntimeConfig,
          envVars: { DIRECT_STORAGE_SPECIMEN: "1", LEGACY_OMITTED_EDIT: "1" },
        },
      }),
    });
    assert.equal(legacyOmittedSameModelEdit.status, 200, await legacyOmittedSameModelEdit.clone().text());
    assert.equal(
      ((await getAgent(created.id))?.runtimeConfig as { reasoningEffort?: string } | null)?.reasoningEffort,
      "balanced-plus",
      "an omitted legacy effort must retain the storage-constructed open effort byte-for-byte",
    );

    const legacySameModelEdit = await fetch(`${app.baseUrl}/api/agents/${created.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        runtimeConfig: {
          ...runtimeConfig,
          reasoningEffort: null,
          envVars: { DIRECT_STORAGE_SPECIMEN: "1", LEGACY_ENV_EDIT: "1" },
        },
      }),
    });
    assert.equal(legacySameModelEdit.status, 200, await legacySameModelEdit.clone().text());
    const immediatelyStoredAfterLegacyEdit = await getAgent(created.id);
    assert.equal(
      (immediatelyStoredAfterLegacyEdit?.runtimeConfig as { reasoningEffort?: string } | null)?.reasoningEffort,
      "balanced-plus",
      "the same save must retain the storage-constructed open effort byte-for-byte",
    );

    const legacyExplicitSameModelEdit = await fetch(`${app.baseUrl}/api/agents/${created.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ runtimeConfig }),
    });
    assert.equal(legacyExplicitSameModelEdit.status, 409);
    assert.equal((await legacyExplicitSameModelEdit.json() as { code?: string }).code, "upgrade_required");
    assert.equal(
      ((await getAgent(created.id))?.runtimeConfig as { reasoningEffort?: string } | null)?.reasoningEffort,
      "balanced-plus",
    );

    const legacyModelSwitch = await fetch(`${app.baseUrl}/api/agents/${created.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        runtimeConfig: {
          ...runtimeConfig,
          model: { kind: "preset", id: "kimi-code/k2" },
          reasoningEffort: null,
        },
      }),
    });
    assert.equal(legacyModelSwitch.status, 409);
    assert.equal((await legacyModelSwitch.json() as { code?: string }).code, "upgrade_required");
    const immediatelyStoredAfterRejectedSwitch = await getAgent(created.id);
    assert.equal(
      (immediatelyStoredAfterRejectedSwitch?.runtimeConfig as { model?: { id?: string }; reasoningEffort?: string } | null)?.model?.id,
      "kimi-code/k3",
    );
    assert.equal(
      (immediatelyStoredAfterRejectedSwitch?.runtimeConfig as { reasoningEffort?: string } | null)?.reasoningEffort,
      "balanced-plus",
    );

    const missingMetadataEdit = await fetch(`${app.baseUrl}/api/agents/${created.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        formDefinitionRef: KIMI_SDK_FORM_DEFINITION_REF,
        runtimeConfig: {
          ...runtimeConfig,
          model: { kind: "preset", id: "kimi-code/k2" },
        },
      }),
    });
    assert.equal(missingMetadataEdit.status, 409);
    assert.equal((await missingMetadataEdit.json() as { code?: string }).code, "upgrade_required");
    const immediatelyStoredAfterMissingCapability = await getAgent(created.id);
    assert.equal(
      (immediatelyStoredAfterMissingCapability?.runtimeConfig as { model?: { id?: string } } | null)?.model?.id,
      "kimi-code/k3",
    );

    const editRes = await fetch(`${app.baseUrl}/api/agents/${created.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        formDefinitionRef: KIMI_SDK_FORM_DEFINITION_REF,
        runtimeConfig: {
          ...runtimeConfig,
          model: { kind: "preset", id: "kimi-code/k2" },
          reasoningEffort: null,
        },
      }),
    });
    assert.equal(editRes.status, 200);

    const leakedEffort = await fetch(`${app.baseUrl}/api/agents/${created.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        formDefinitionRef: KIMI_SDK_FORM_DEFINITION_REF,
        runtimeConfig: {
          ...runtimeConfig,
          model: { kind: "preset", id: "kimi-code/k2" },
        },
      }),
    });
    assert.equal(leakedEffort.status, 409);
    assert.equal((await leakedEffort.clone().json() as { code?: string }).code, "upgrade_required");
    assert.equal(
      (await leakedEffort.json() as { issues: Array<{ pointer: string }> }).issues[0]?.pointer,
      "/runtimeConfig/reasoningEffort",
    );
});

test("grok_runtime_v0 gates new Grok selections while preserving existing Grok agent management", async ({ app }) => {
    const owner = await seedUser("grok-runtime-flag-owner@slock.test", "grok-runtime-flag-owner");
    const server = await createServer("Grok Runtime Flag Server", "grok-runtime-flag-server", owner.id);
  const ownerToken = await tokenForHuman(owner.email);
    const [machine] = await getDb().insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "grok-runtime-flag-machine",
      apiKeyHash: "unused-grok-runtime-flag-machine-hash",
      runtimes: ["codex", "grok"],
    }).returning();
    const codexAgent = await createAgent(server.id, "flagged-codex-agent", {
      runtime: "codex",
      model: "gpt-5",
      machineId: machine.id,
    });
    const existingGrokAgent = await createAgent(server.id, "existing-grok-agent", {
      runtime: "grok",
      model: "grok-4.5",
      machineId: machine.id,
    });

    const getRuntimeOptions = async (agentId: string) => {
      const res = await fetch(`${app.baseUrl}/api/agents/${agentId}/runtime-options`, {
        headers: authHeaders(ownerToken, server.id),
      });
      assert.equal(res.status, 200);
      return await res.json() as {
        context: string;
        machineId: string | null;
        options: Array<{
          runtimeId: string;
          capabilityStatus: string;
          admissionStatus: string;
          admissionReason: string | null;
          current: boolean;
          availableForNew: boolean;
          manageableForCurrentAgent: boolean;
          canSelectInThisContext: boolean;
        }>;
      };
    };

    const disabledCodexOptions = await getRuntimeOptions(codexAgent.id);
    assert.equal(disabledCodexOptions.options.some((option) => option.runtimeId === "grok"), false);
    const disabledExistingGrokOptions = await getRuntimeOptions(existingGrokAgent.id);
    assert.equal(disabledExistingGrokOptions.context, "existing_agent");
    assert.equal(disabledExistingGrokOptions.machineId, machine.id);
    assert.deepEqual(disabledExistingGrokOptions.options.find((option) => option.runtimeId === "grok"), {
      runtimeId: "grok",
      capabilityStatus: "available",
      admissionStatus: "grandfathered_current",
      admissionReason: "feature_flag_off",
      current: true,
      availableForNew: false,
      manageableForCurrentAgent: true,
      canSelectInThisContext: true,
    });

    const createDisabledRes = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "disabled-grok-agent",
        runtime: "grok",
        model: "grok-4.5",
      }),
    });
    assert.equal(createDisabledRes.status, 403);
    assert.deepEqual(await createDisabledRes.json(), {
      error: "Grok Build is not enabled on this server",
      code: "grok_runtime_disabled",
    });

    const transitionDisabledRes = await fetch(`${app.baseUrl}/api/agents/${codexAgent.id}`, {
      method: "PATCH",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        runtime: "grok",
        model: "grok-4.5",
      }),
    });
    assert.equal(transitionDisabledRes.status, 403);
    assert.equal(((await transitionDisabledRes.json()) as { code: string }).code, "grok_runtime_disabled");
    assert.equal((await getAgent(codexAgent.id))?.runtime, "codex");

    const existingManagementRes = await fetch(`${app.baseUrl}/api/agents/${existingGrokAgent.id}`, {
      method: "PATCH",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        description: "existing Grok remains manageable while rollout is off",
        runtime: "grok",
        model: "grok-composer-2.5-fast",
      }),
    });
    assert.equal(existingManagementRes.status, 200);
    const existingManagementBody = await existingManagementRes.json() as {
      description: string;
      runtime: string;
      model: string;
    };
    assert.equal(existingManagementBody.description, "existing Grok remains manageable while rollout is off");
    assert.equal(existingManagementBody.runtime, "grok");
    assert.equal(existingManagementBody.model, "grok-composer-2.5-fast");

    await getDb().update(machines).set({ runtimes: ["codex"] }).where(eq(machines.id, machine.id));
    const unavailableExistingGrokOptions = await getRuntimeOptions(existingGrokAgent.id);
    assert.deepEqual(unavailableExistingGrokOptions.options.find((option) => option.runtimeId === "grok"), {
      runtimeId: "grok",
      capabilityStatus: "not_installed",
      admissionStatus: "grandfathered_current",
      admissionReason: "feature_flag_off",
      current: true,
      availableForNew: false,
      manageableForCurrentAgent: false,
      canSelectInThisContext: false,
    });
    const unavailableManagementRes = await fetch(`${app.baseUrl}/api/agents/${existingGrokAgent.id}`, {
      method: "PATCH",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "grok-4.5" }),
    });
    assert.equal(unavailableManagementRes.status, 409);
    assert.deepEqual(await unavailableManagementRes.json(), {
      error: "Grok Build is not available on this computer",
      code: "runtime_capability_unavailable",
    });

    const unavailableProfileEditRes = await fetch(`${app.baseUrl}/api/agents/${existingGrokAgent.id}`, {
      method: "PATCH",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ description: "profile edits do not require runtime capability" }),
    });
    assert.equal(unavailableProfileEditRes.status, 200);
    assert.equal(
      ((await unavailableProfileEditRes.json()) as { description: string }).description,
      "profile edits do not require runtime capability",
    );

    const leaveGrokRes = await fetch(`${app.baseUrl}/api/agents/${existingGrokAgent.id}`, {
      method: "PATCH",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        runtimeConfig: {
          version: 1,
          runtime: "codex",
          model: { kind: "custom", name: "gpt-5" },
        },
      }),
    });
    assert.equal(leaveGrokRes.status, 200);
    assert.equal((await getAgent(existingGrokAgent.id))?.runtime, "codex");
    const afterLeavingGrokOptions = await getRuntimeOptions(existingGrokAgent.id);
    assert.equal(afterLeavingGrokOptions.options.some((option) => option.runtimeId === "grok"), false);

    await enableGrokRuntimeFlag(server.id);

    const unavailableCreateRes = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "unavailable-grok-agent",
        runtime: "grok",
        model: "grok-4.5",
        machineId: machine.id,
      }),
    });
    assert.equal(unavailableCreateRes.status, 409);
    assert.deepEqual(await unavailableCreateRes.json(), {
      error: "Grok Build is not available on this computer",
      code: "runtime_capability_unavailable",
    });
    assert.equal((await listAgents(server.id)).some((agent) => agent.name === "unavailable-grok-agent"), false);

    await getDb().update(machines).set({ runtimes: ["codex", "grok"] }).where(eq(machines.id, machine.id));
    const createEnabledRes = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "enabled-grok-agent",
        runtime: "grok",
        model: "grok-4.5",
        machineId: machine.id,
      }),
    });
    assert.equal(createEnabledRes.status, 200);
    const createEnabledBody = await createEnabledRes.json() as { runtime: string; model: string; machineId: string | null };
    assert.equal(createEnabledBody.runtime, "grok");
    assert.equal(createEnabledBody.model, "grok-4.5");
    assert.equal(createEnabledBody.machineId, machine.id);
});

test("POST /agents onboarding Cindy can recover after other agents already exist", async ({ app }) => {
    const owner = await seedUser("onboarding-cindy-recovery-owner@slock.test", "onboarding-cindy-recovery-owner");
    const server = await createServer("Onboarding Cindy Recovery", "onboarding-cindy-recovery", owner.id);
    await createAgent(server.id, "existing-helper", { runtime: "codex" });
  const ownerToken = await tokenForHuman(owner.email);

    const res = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Custom Guide",
        description: "Custom onboarding guide",
        avatarUrl: "pixel:finch",
        runtime: "codex",
        onboarding: true,
      }),
    });

    assert.equal(res.status, 200);
    const body = await res.json() as { id: string; name: string; displayName: string | null; description: string | null; avatarUrl: string | null; serverRole: string | null; runtimeConfig?: { envVars?: Record<string, string> | null } };
    assert.equal(body.name, "Cindy");
    assert.equal(body.displayName, "Cindy");
    assert.equal(body.description, "Onboarding Assistant");
    assert.equal(body.avatarUrl, "pixel:mug");
    assert.equal(body.serverRole, "admin");
    assert.equal(await getAgentMemberRole(server.id, body.id), "admin");
    assert.equal(body.runtimeConfig?.envVars?.SLOCK_ONBOARDING_MEMORY_SEED, "first-cindy");

    const updatedServer = await getServer(server.id);
    assert.equal(updatedServer?.onboardingAgentId, body.id);

    const regularRes = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "regular-helper",
        runtime: "codex",
      }),
    });
    assert.equal(regularRes.status, 200);
    const regularBody = await regularRes.json() as { id: string; serverRole: string | null };
    assert.equal(regularBody.serverRole, "member");
    assert.equal(await getAgentMemberRole(server.id, regularBody.id), "member");
});

test("POST /agents onboarding Cindy rejects a second active Cindy", async ({ app }) => {
    const owner = await seedUser("onboarding-cindy-duplicate-owner@slock.test", "onboarding-cindy-duplicate-owner");
    const server = await createServer("Onboarding Cindy Duplicate", "onboarding-cindy-duplicate", owner.id);
    await createAgent(server.id, "Cindy", {
      description: "Onboarding Assistant",
      runtime: "codex",
    });
  const ownerToken = await tokenForHuman(owner.email);

    const res = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Cindy",
        description: "Onboarding Assistant",
        runtime: "codex",
        onboarding: true,
      }),
    });

    assert.equal(res.status, 409);
    const body = await res.json() as { error?: string };
    assert.match(body.error ?? "", /Cindy agent already exists/i);
});

test("POST /agents onboarding rejects when server already has an onboarding agent without overwriting it", async ({ app }) => {
    const owner = await seedUser("onboarding-existing-owner@slock.test", "onboarding-existing-owner");
    const server = await createServer("Onboarding Existing", "onboarding-existing", owner.id);
    const customized = await createAgent(server.id, "SetupGuide", {
      description: "Custom setup guide",
      runtime: "codex",
      avatarUrl: "pixel:finch",
    });
    await updateServerOnboardingAgent(server.id, customized.id);
  const ownerToken = await tokenForHuman(owner.email);

    const res = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "Cindy",
        description: "Onboarding Assistant",
        runtime: "codex",
        onboarding: true,
      }),
    });

    assert.equal(res.status, 409);
    const body = await res.json() as { error?: string; onboardingAgentId?: string };
    assert.match(body.error ?? "", /Onboarding agent already exists/i);
    assert.equal(body.onboardingAgentId, customized.id);

    const unchanged = await getAgent(customized.id);
    assert.equal(unchanged?.name, "SetupGuide");
    assert.equal(unchanged?.description, "Custom setup guide");
    assert.equal(unchanged?.avatarUrl, "pixel:finch");
});

test("onboarding identity adoption previews then applies official Cindy identity", async ({ app }) => {
    const owner = await seedUser("onboarding-adopt-owner@slock.test", "onboarding-adopt-owner");
    const server = await createServer("Onboarding Adopt", "onboarding-adopt", owner.id);
    const customized = await createAgent(server.id, "SetupGuide", {
      description: "Custom setup guide",
      runtime: "codex",
      avatarUrl: "pixel:finch",
    });
    await updateAgent(customized.id, { displayName: "Setup Guide" });
    await updateServerOnboardingAgent(server.id, customized.id);
  const ownerToken = await tokenForHuman(owner.email);
    assert.equal(await getAgentMemberRole(server.id, customized.id), "member");

    const previewRes = await fetch(`${app.baseUrl}/api/agents/${customized.id}/onboarding-identity-adoption`, {
      headers: authHeaders(ownerToken, server.id),
    });
    assert.equal(previewRes.status, 200);
    const preview = await previewRes.json() as {
      canAdopt: boolean;
      changes: Array<{ field: string; before: string | null; after: string | null }>;
    };
    assert.equal(preview.canAdopt, true);
    assert.deepEqual(
      preview.changes.map((change) => [change.field, change.before, change.after]),
      [
        ["name", "SetupGuide", "Cindy"],
        ["displayName", "Setup Guide", "Cindy"],
        ["role", "Custom setup guide", "Onboarding Assistant"],
        ["serverRole", "member", "admin"],
        ["avatarUrl", "pixel:finch", "pixel:mug"],
      ],
    );

    const stillCustom = await getAgent(customized.id);
    assert.equal(stillCustom?.name, "SetupGuide");
    assert.equal(stillCustom?.displayName, "Setup Guide");
    assert.equal(stillCustom?.description, "Custom setup guide");
    assert.equal(stillCustom?.avatarUrl, "pixel:finch");

    const adoptRes = await fetch(`${app.baseUrl}/api/agents/${customized.id}/onboarding-identity-adoption`, {
      method: "POST",
      headers: authHeaders(ownerToken, server.id),
    });
    assert.equal(adoptRes.status, 200);
    const adopted = await adoptRes.json() as {
      canAdopt: boolean;
      appliedChanges: Array<{ field: string; before: string | null; after: string | null }>;
      agent: { id: string; name: string; displayName: string | null; description: string | null; avatarUrl: string | null; serverRole: string | null };
    };
    assert.equal(adopted.canAdopt, false);
    assert.deepEqual(
      adopted.appliedChanges.map((change) => [change.field, change.before, change.after]),
      preview.changes.map((change) => [change.field, change.before, change.after]),
    );
    assert.equal(adopted.agent.id, customized.id);
    assert.equal(adopted.agent.name, "Cindy");
    assert.equal(adopted.agent.displayName, "Cindy");
    assert.equal(adopted.agent.description, "Onboarding Assistant");
    assert.equal(adopted.agent.avatarUrl, "pixel:mug");
    assert.equal(adopted.agent.serverRole, "admin");
    assert.equal(await getAgentMemberRole(server.id, customized.id), "admin");

    const secondAdoptRes = await fetch(`${app.baseUrl}/api/agents/${customized.id}/onboarding-identity-adoption`, {
      method: "POST",
      headers: authHeaders(ownerToken, server.id),
    });
    assert.equal(secondAdoptRes.status, 200);
    const secondAdopt = await secondAdoptRes.json() as {
      canAdopt: boolean;
      changes: Array<{ field: string; before: string | null; after: string | null }>;
      appliedChanges: Array<{ field: string; before: string | null; after: string | null }>;
      agent: { id: string; name: string; displayName: string | null; description: string | null; avatarUrl: string | null; serverRole: string | null };
    };
    assert.equal(secondAdopt.canAdopt, false);
    assert.deepEqual(secondAdopt.changes, []);
    assert.deepEqual(secondAdopt.appliedChanges, []);
    assert.equal(secondAdopt.agent.id, customized.id);
    assert.equal(secondAdopt.agent.name, "Cindy");
    assert.equal(secondAdopt.agent.displayName, "Cindy");
    assert.equal(secondAdopt.agent.description, "Onboarding Assistant");
    assert.equal(secondAdopt.agent.avatarUrl, "pixel:mug");
    assert.equal(secondAdopt.agent.serverRole, "admin");

    const updatedServer = await getServer(server.id);
    assert.equal(updatedServer?.onboardingAgentId, customized.id);
});

test("onboarding identity adoption returns 409 on exact Cindy handle conflict without clobbering rows", async ({ app }) => {
    const owner = await seedUser("onboarding-adopt-conflict-owner@slock.test", "onboarding-adopt-conflict-owner");
    const server = await createServer("Onboarding Adopt Conflict", "onboarding-adopt-conflict", owner.id);
    const cindy = await createAgent(server.id, "Cindy", {
      description: "Existing Cindy helper",
      runtime: "codex",
      avatarUrl: "pixel:finch",
    });
    await updateAgent(cindy.id, { displayName: "Existing Cindy" });
    const customized = await createAgent(server.id, "SetupGuide", {
      description: "Custom setup guide",
      runtime: "codex",
      avatarUrl: "pixel:astronaut",
    });
    await updateAgent(customized.id, { displayName: "Setup Guide" });
    await updateServerOnboardingAgent(server.id, customized.id);
  const ownerToken = await tokenForHuman(owner.email);
    assert.equal(await getAgentMemberRole(server.id, customized.id), "member");

    const adoptRes = await fetch(`${app.baseUrl}/api/agents/${customized.id}/onboarding-identity-adoption`, {
      method: "POST",
      headers: authHeaders(ownerToken, server.id),
    });

    assert.equal(adoptRes.status, 409);
    const body = await adoptRes.json() as { error?: string };
    assert.match(body.error ?? "", /Agent name "Cindy" is already taken/);

    const unchangedCindy = await getAgent(cindy.id);
    assert.equal(unchangedCindy?.name, "Cindy");
    assert.equal(unchangedCindy?.displayName, "Existing Cindy");
    assert.equal(unchangedCindy?.description, "Existing Cindy helper");
    assert.equal(unchangedCindy?.avatarUrl, "pixel:finch");

    const unchangedOnboarding = await getAgent(customized.id);
    assert.equal(unchangedOnboarding?.name, "SetupGuide");
    assert.equal(unchangedOnboarding?.displayName, "Setup Guide");
    assert.equal(unchangedOnboarding?.description, "Custom setup guide");
    assert.equal(unchangedOnboarding?.avatarUrl, "pixel:astronaut");
    assert.equal(await getAgentMemberRole(server.id, customized.id), "member");

    const updatedServer = await getServer(server.id);
    assert.equal(updatedServer?.onboardingAgentId, customized.id);
});

test("POST /agents rejects unsupported runtimeConfig launch axes", async ({ app }) => {
    const owner = await seedUser("runtime-config-unsupported@slock.test", "runtime-config-unsupported");
    const server = await createServer("Runtime Config Unsupported", "runtime-config-unsupported", owner.id);
  const ownerToken = await tokenForHuman(owner.email);

    const providerUnsupportedRuntimes = ["codex", "grok", "antigravity", "kimi", "copilot", "cursor", "gemini", "opencode"];
    const fastUnsupportedRuntimes = ["grok", "antigravity", "kimi", "copilot", "cursor", "gemini", "opencode"];
    const reasoningUnsupportedRuntimes = ["antigravity", "kimi", "cursor", "gemini", "opencode"];

    const cases = [
      ...providerUnsupportedRuntimes.map((runtime) => ({
        name: `${runtime}-provider-agent`,
        runtimeConfig: {
          version: 1,
          runtime,
          provider: { kind: "custom", apiUrl: "https://gateway.example.test/v1", apiKey: "sk-ant-test" },
          model: { kind: "preset", id: "default" },
        },
        error: `runtimeConfig.provider is not supported for runtime: ${runtime}`,
      })),
      ...fastUnsupportedRuntimes.map((runtime) => ({
        name: `${runtime}-fast-agent`,
        runtimeConfig: {
          version: 1,
          runtime,
          model: { kind: "preset", id: "default" },
          mode: { kind: "fast" },
        },
        error: `runtimeConfig.mode is not supported for runtime: ${runtime}`,
      })),
      ...reasoningUnsupportedRuntimes.map((runtime) => ({
        name: `${runtime}-reasoning-agent`,
        runtimeConfig: {
          version: 1,
          runtime,
          model: { kind: "preset", id: "default" },
          reasoningEffort: "high",
        },
        error: `runtimeConfig.reasoningEffort is not supported for runtime: ${runtime}`,
      })),
    ];

    for (const item of cases) {
      const res = await fetch(`${app.baseUrl}/api/agents`, {
        method: "POST",
        headers: {
          ...authHeaders(ownerToken, server.id),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(item),
      });
      assert.equal(res.status, 400, item.name);
      const body = await res.json() as { error: string };
      assert.equal(body.error, item.error);
    }
});

test("POST /agents records runtimeConfig trace acceptance without secret or raw-field leakage", async ({ app }) => {
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({
      sink,
      traceIdGenerator: () => "2".repeat(32),
      spanIdGenerator: (() => {
        let next = 1;
        return () => String(next++).padStart(16, "0");
      })(),
    });
    app.app.set("serverTracer", tracer);

    const owner = await seedUser("runtime-config-trace-owner@slock.test", "runtime-config-trace-owner");
    const server = await createServer("Runtime Config Trace", "runtime-config-trace", owner.id);
  const ownerToken = await tokenForHuman(owner.email);
    const formDefinitionRef = {
      protocolVersion: 1,
      runtimeId: "builtin",
      schemaVersion: "builtin-pi.create.v2",
    };

    sink.clear();
    const validRes = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "trace-valid-agent",
        runtimeConfig: {
          version: 1,
          runtime: "claude",
          provider: { kind: "custom", apiUrl: "https://gateway.example.test/v1", apiKey: "sk-ant-test" },
          model: { kind: "custom", name: "claude-opus-4-6" },
          mode: { kind: "default" },
          envVars: { TEAM_FLAG: "enabled" },
        },
      }),
    });
    assert.equal(validRes.status, 200);
    const validSpan = sink.getAllSpans().find((span) => span.name === "server.http.request");
    assert.ok(validSpan);
    const validParse = validSpan.events.find((event) => event.name === "server.runtime_config.parse");
    const validLaunch = validSpan.events.find((event) => event.name === "server.runtime_config.launch_plan");
    assert.equal(validParse?.attrs?.outcome, "accepted");
    assert.equal(validParse?.attrs?.runtime, "claude");
    assert.equal(validParse?.attrs?.provider_kind, "custom");
    assert.equal(validLaunch?.attrs?.outcome, "materialized");
    assert.equal(validLaunch?.attrs?.runtime, "claude");
    assert.equal(validLaunch?.attrs?.provider_kind, "custom");
    assert.equal(validLaunch?.attrs?.env_key_count, 4);
    const validTraceJson = JSON.stringify(validSpan.events);
    assert.equal(validTraceJson.includes("sk-ant-test"), false);
    assert.equal(validTraceJson.includes("gateway.example.test"), false);
    assert.equal(validTraceJson.includes("TEAM_FLAG"), false);

    const [builtInMachine] = await getDb()
      .insert(machines)
      .values({
        serverId: server.id,
        userId: owner.id,
        name: "runtime-config-trace-machine",
        apiKeyHash: "unused-runtime-config-trace-machine-hash",
        runtimes: ["builtin"],
      })
      .returning();
    Object.assign(app.app.get("agentOrchestrator"), {
      hasMachineLocally: () => true,
      validateBuiltInPresetForMachine: async () => ({
        authority: {
          connectionEpochId: "epoch-trace",
          replicaGeneration: "generation-trace",
        },
      }),
      acquireBuiltInCatalogAuthority: () => () => undefined,
    });

    sink.clear();
    const builtInRes = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "trace-builtin-agent",
        machineId: builtInMachine.id,
        formDefinitionRef,
        runtimeConfig: {
          version: 1,
          runtime: "builtin",
          provider: { kind: "preset", providerId: "openai", apiKey: "sk-openai-test" },
          model: { kind: "preset", id: "openai/gpt-5.4" },
          mode: { kind: "default" },
          envVars: { TEAM_FLAG: "enabled", OPENAI_API_KEY: "sk-user-controlled" },
        },
      }),
    });
    assert.equal(builtInRes.status, 200);
    const builtInBody = await builtInRes.json() as {
      runtime: string;
      envVars: Record<string, string> | null;
      runtimeConfig: { hostUserState?: string };
    };
    assert.equal(builtInBody.runtime, "builtin");
    assert.deepEqual(builtInBody.envVars, { TEAM_FLAG: "enabled" });
    assert.equal(builtInBody.runtimeConfig.hostUserState, "forbidden");
    const builtInSpan = sink.getAllSpans().find((span) => span.name === "server.http.request");
    assert.ok(builtInSpan);
    const builtInParse = builtInSpan.events.find((event) => event.name === "server.runtime_config.parse");
    const builtInLaunch = builtInSpan.events.find((event) => event.name === "server.runtime_config.launch_plan");
    assert.equal(builtInParse?.attrs?.outcome, "accepted");
    assert.equal(builtInParse?.attrs?.runtime, "builtin");
    assert.equal(builtInParse?.attrs?.provider_kind, "preset");
    assert.equal(builtInParse?.attrs?.provider_id, "openai");
    assert.equal(builtInParse?.attrs?.model_kind, "preset");
    assert.equal(builtInParse?.attrs?.model_id, "openai/gpt-5.4");
    assert.equal(builtInLaunch?.attrs?.outcome, "materialized");
    assert.equal(builtInLaunch?.attrs?.runtime, "builtin");
    assert.equal(builtInLaunch?.attrs?.provider_kind, "preset");
    assert.equal(builtInLaunch?.attrs?.provider_id, "openai");
    assert.equal(builtInLaunch?.attrs?.model_kind, "preset");
    assert.equal(builtInLaunch?.attrs?.model_id, "openai/gpt-5.4");
    assert.equal(builtInLaunch?.attrs?.config_source, "agent_config");
    assert.equal(builtInLaunch?.attrs?.provider_key_present, true);
    assert.equal(builtInLaunch?.attrs?.provider_key_source, "runtime_config_plaintext");
    assert.equal(builtInLaunch?.attrs?.env_key_count, 2);
    const builtInTraceJson = JSON.stringify(builtInSpan.events);
    assert.equal(builtInTraceJson.includes("sk-openai-test"), false);
    assert.equal(builtInTraceJson.includes("sk-user-controlled"), false);
    assert.equal(builtInTraceJson.includes("OPENAI_API_KEY"), false);
    assert.equal(builtInTraceJson.includes("DEEPSEEK_API_KEY"), false);
    assert.equal(builtInTraceJson.includes("TEAM_FLAG"), false);

    sink.clear();
    const builtInGatewayRes = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "trace-builtin-gateway-agent",
        formDefinitionRef,
        runtimeConfig: {
          version: 1,
          runtime: "builtin",
          provider: { kind: "gateway", providerId: "openai-compatible", baseUrl: "https://gateway.example.test/v1", apiKey: "sk-openai-test" },
          model: { kind: "custom", name: "openai/gpt-custom" },
          mode: { kind: "default" },
          envVars: {
            TEAM_FLAG: "enabled",
            OPENAI_API_KEY: "sk-user-controlled",
            OPENAI_BASE_URL: "https://stale.example.test/v1",
          },
        },
      }),
    });
    assert.equal(builtInGatewayRes.status, 200);
    const builtInGatewayBody = await builtInGatewayRes.json() as {
      runtime: string;
      envVars: Record<string, string> | null;
      runtimeConfig: { provider?: { kind?: string; providerId?: string; baseUrl?: string }; model?: { kind?: string; name?: string } };
    };
    assert.equal(builtInGatewayBody.runtime, "builtin");
    assert.deepEqual(builtInGatewayBody.envVars, { TEAM_FLAG: "enabled" });
    assert.equal(builtInGatewayBody.runtimeConfig.provider?.kind, "gateway");
    assert.equal(builtInGatewayBody.runtimeConfig.provider?.providerId, "openai-compatible");
    assert.equal(builtInGatewayBody.runtimeConfig.provider?.baseUrl, "https://gateway.example.test/v1");
    assert.equal(builtInGatewayBody.runtimeConfig.model?.kind, "custom");
    const builtInGatewaySpan = sink.getAllSpans().find((span) => span.name === "server.http.request");
    assert.ok(builtInGatewaySpan);
    const builtInGatewayParse = builtInGatewaySpan.events.find((event) => event.name === "server.runtime_config.parse");
    const builtInGatewayLaunch = builtInGatewaySpan.events.find((event) => event.name === "server.runtime_config.launch_plan");
    assert.equal(builtInGatewayParse?.attrs?.outcome, "accepted");
    assert.equal(builtInGatewayParse?.attrs?.runtime, "builtin");
    assert.equal(builtInGatewayParse?.attrs?.provider_kind, "gateway");
    assert.equal(builtInGatewayParse?.attrs?.provider_id, "openai-compatible");
    assert.equal(builtInGatewayParse?.attrs?.model_kind, "custom");
    assert.equal(builtInGatewayParse?.attrs?.base_url_present, true);
    assert.equal(builtInGatewayParse?.attrs?.base_url_host_class, "public");
    assert.equal(builtInGatewayLaunch?.attrs?.outcome, "materialized");
    assert.equal(builtInGatewayLaunch?.attrs?.provider_kind, "gateway");
    assert.equal(builtInGatewayLaunch?.attrs?.provider_id, "openai-compatible");
    assert.equal(builtInGatewayLaunch?.attrs?.model_kind, "custom");
    assert.equal(builtInGatewayLaunch?.attrs?.base_url_present, true);
    assert.equal(builtInGatewayLaunch?.attrs?.base_url_host_class, "public");
    assert.equal(builtInGatewayLaunch?.attrs?.provider_key_present, true);
    assert.equal(builtInGatewayLaunch?.attrs?.provider_key_source, "runtime_config_plaintext");
    assert.equal(builtInGatewayLaunch?.attrs?.env_key_count, 3);
    const builtInGatewayTraceJson = JSON.stringify(builtInGatewaySpan.events);
    assert.equal(builtInGatewayTraceJson.includes("sk-openai-test"), false);
    assert.equal(builtInGatewayTraceJson.includes("sk-user-controlled"), false);
    assert.equal(builtInGatewayTraceJson.includes("gateway.example.test"), false);
    assert.equal(builtInGatewayTraceJson.includes("stale.example.test"), false);
    assert.equal(builtInGatewayTraceJson.includes("OPENAI_API_KEY"), false);
    assert.equal(builtInGatewayTraceJson.includes("OPENAI_BASE_URL"), false);
    assert.equal(builtInGatewayTraceJson.includes("TEAM_FLAG"), false);

    sink.clear();
    const invalidRes = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "trace-invalid-agent",
        runtimeConfig: {
          version: 1,
          runtime: "claude",
          provider: { kind: "pi-builtin", providerId: "deepseek", apiKey: "sk-ds-test" },
          model: { kind: "preset", id: "sonnet" },
          mode: { kind: "default" },
        },
      }),
    });
    assert.equal(invalidRes.status, 400);
    const invalidSpan = sink.getAllSpans().find((span) => span.name === "server.http.request");
    assert.ok(invalidSpan);
    const invalidParse = invalidSpan.events.find((event) => event.name === "server.runtime_config.parse");
    assert.equal(invalidParse?.attrs?.outcome, "rejected");
    assert.equal(invalidParse?.attrs?.runtime, "claude");
    assert.equal(invalidParse?.attrs?.provider_kind, "pi-builtin");
    assert.equal(invalidParse?.attrs?.reason, "cross_runtime_provider");
    assert.equal(invalidSpan.events.some((event) => event.name === "server.runtime_config.launch_plan"), false);
    assert.equal((await listAgents(server.id)).some((agent) => agent.name === "trace-invalid-agent"), false);
    assert.equal(JSON.stringify(invalidSpan.events).includes("sk-ds-test"), false);

    sink.clear();
    const invalidBuiltInRes = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "trace-invalid-builtin-agent",
        formDefinitionRef,
        runtimeConfig: {
          version: 1,
          runtime: "builtin",
          provider: { kind: "pi-builtin", providerId: "deepseek", apiKey: "sk-ds-test" },
          model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
          mode: { kind: "default" },
        },
      }),
    });
    assert.equal(invalidBuiltInRes.status, 400);
    const invalidBuiltInSpan = sink.getAllSpans().find((span) => span.name === "server.http.request");
    assert.ok(invalidBuiltInSpan);
    const invalidBuiltInParse = invalidBuiltInSpan.events.find((event) => event.name === "server.runtime_config.parse");
    assert.equal(invalidBuiltInParse?.attrs?.outcome, "rejected");
    assert.equal(invalidBuiltInParse?.attrs?.runtime, "builtin");
    assert.equal(invalidBuiltInParse?.attrs?.provider_kind, "pi-builtin");
    assert.equal(invalidBuiltInParse?.attrs?.reason, "cross_runtime_provider");
    assert.equal(invalidBuiltInSpan.events.some((event) => event.name === "server.runtime_config.launch_plan"), false);
    assert.equal((await listAgents(server.id)).some((agent) => agent.name === "trace-invalid-builtin-agent"), false);
    assert.equal(JSON.stringify(invalidBuiltInSpan.events).includes("sk-ds-test"), false);

    sink.clear();
    const invalidBuiltInGatewayRes = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "trace-builtin-gw-bad",
        formDefinitionRef,
        runtimeConfig: {
          version: 1,
          runtime: "builtin",
          provider: { kind: "gateway", providerId: "openai-compatible", baseUrl: "https://user:pass@gateway.example.test/v1", apiKey: "sk-openai-test" },
          model: { kind: "custom", name: "openai/gpt-custom" },
          mode: { kind: "default" },
        },
      }),
    });
    assert.equal(invalidBuiltInGatewayRes.status, 400);
    const invalidBuiltInGatewaySpan = sink.getAllSpans().find((span) => span.name === "server.http.request");
    assert.ok(invalidBuiltInGatewaySpan);
    const invalidBuiltInGatewayParse = invalidBuiltInGatewaySpan.events.find((event) => event.name === "server.runtime_config.parse");
    assert.equal(invalidBuiltInGatewayParse?.attrs?.outcome, "rejected");
    assert.equal(invalidBuiltInGatewayParse?.attrs?.runtime, "builtin");
    assert.equal(invalidBuiltInGatewayParse?.attrs?.provider_kind, "gateway");
    assert.equal(invalidBuiltInGatewayParse?.attrs?.reason, "invalid_provider");
    assert.equal(invalidBuiltInGatewaySpan.events.some((event) => event.name === "server.runtime_config.launch_plan"), false);
    assert.equal((await listAgents(server.id)).some((agent) => agent.name === "trace-builtin-gw-bad"), false);
    const invalidBuiltInGatewayTraceJson = JSON.stringify(invalidBuiltInGatewaySpan.events);
    assert.equal(invalidBuiltInGatewayTraceJson.includes("sk-openai-test"), false);
    assert.equal(invalidBuiltInGatewayTraceJson.includes("gateway.example.test"), false);

    sink.clear();
    const invalidEnvRes = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "trace-invalid-env-agent",
        runtimeConfig: {
          version: 1,
          runtime: "claude",
          provider: { kind: "default" },
          model: { kind: "preset", id: "sonnet" },
          mode: { kind: "default" },
          envVars: { GOOD: "1", BAD: 1 },
        },
      }),
    });
    assert.equal(invalidEnvRes.status, 400);
    const invalidEnvSpan = sink.getAllSpans().find((span) => span.name === "server.http.request");
    assert.ok(invalidEnvSpan);
    const invalidEnvParse = invalidEnvSpan.events.find((event) => event.name === "server.runtime_config.parse");
    assert.equal(invalidEnvParse?.attrs?.outcome, "rejected");
    assert.equal(invalidEnvParse?.attrs?.runtime, "claude");
    assert.equal(invalidEnvParse?.attrs?.provider_kind, "default");
    assert.equal(invalidEnvParse?.attrs?.reason, "invalid_env_vars");
    assert.equal(invalidEnvSpan.events.some((event) => event.name === "server.runtime_config.launch_plan"), false);
    assert.equal((await listAgents(server.id)).some((agent) => agent.name === "trace-invalid-env-agent"), false);

    sink.clear();
    const legacyAgent = await createAgent(server.id, "trace-legacy-agent", {
      runtime: "claude",
      model: "sonnet",
      runtimeConfig: {
        version: 1,
        runtime: "claude",
        provider: { kind: "default" },
        model: { kind: "preset", id: "sonnet" },
        mode: { kind: "default" },
        unknownApiKey: "must-not-leak",
      } as never,
      creatorType: "user",
      creatorId: owner.id,
    });
    const legacyRes = await fetch(`${app.baseUrl}/api/agents/${legacyAgent.id}`, {
      headers: authHeaders(ownerToken, server.id),
    });
    assert.equal(legacyRes.status, 200);
    const legacyBody = await legacyRes.json() as { runtimeConfig: Record<string, unknown> };
    assert.equal("unknownApiKey" in legacyBody.runtimeConfig, false);
    assert.equal(JSON.stringify(legacyBody).includes("must-not-leak"), false);
    const legacySpan = sink.getAllSpans().find((span) => span.name === "server.http.request");
    assert.ok(legacySpan);
    const legacyParse = legacySpan.events.find((event) => event.name === "server.runtime_config.parse");
    assert.equal(legacyParse?.attrs?.outcome, "legacy_sanitized");
    assert.equal(legacyParse?.attrs?.runtime, "claude");
    assert.equal(legacyParse?.attrs?.provider_kind, "default");
    assert.equal(legacyParse?.attrs?.unknown_fields_dropped_count, 1);
    const legacyTraceJson = JSON.stringify(legacySpan.events);
    assert.equal(legacyTraceJson.includes("unknownApiKey"), false);
    assert.equal(legacyTraceJson.includes("must-not-leak"), false);
});

test("GET /agents/:id/agent-dms returns only agent-to-agent DMs for that agent", async ({ app }) => {
    const db = getDb();

    const [owner] = await db.insert(users).values({
      email: "owner-agent-dm@slock.test",
      name: "owner-agent-dm",
      displayName: "Owner",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    const [member] = await db.insert(users).values({
      email: "member-agent-dm@slock.test",
      name: "member-agent-dm",
      displayName: "Member",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();

    const server = await createServer("Agent DM Test", "agent-dm-test", owner.id);
    await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });

    const agentA = await createAgent(server.id, "agent-a", { runtime: "codex" });
    const agentB = await createAgent(server.id, "agent-b", { runtime: "codex" });

    const a2aDm = await findOrCreateAgentDM(server.id, agentA.id, agentB.id);
    assert.ok(a2aDm, "expected an agent-to-agent DM");
    await createMessage(a2aDm.id, "agent", agentA.id, "agent to agent preview");

    const humanDm = await findOrCreateDM(server.id, member.id, agentA.id);
    assert.ok(humanDm, "expected a human DM");
    await createMessage(humanDm.id, "user", member.id, "human private message");

  const ownerToken = await tokenForHuman(owner.email);
    const res = await fetch(`${app.baseUrl}/api/agents/${agentA.id}/agent-dms`, {
      headers: authHeaders(ownerToken, server.id),
    });

    assert.equal(res.status, 200);
    const body = await res.json() as Array<{
      id: string;
      peerId: string;
      peerName: string;
      lastMessagePreview: string | null;
    }>;

    assert.equal(body.length, 1);
    assert.equal(body[0].id, a2aDm.id);
    assert.equal(body[0].peerId, agentB.id);
    assert.equal(body[0].peerName, "agent-b");
    assert.equal(body[0].lastMessagePreview, "agent to agent preview");
});

test("GET /agents/:id/agent-dms preview ignores trailing system messages", async ({ app }) => {
    const db = getDb();

    const [owner] = await db.insert(users).values({
      email: "owner-agent-dm-system@slock.test",
      name: "owner-agent-dm-system",
      displayName: "Owner",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();

    const server = await createServer("Agent DM System Preview", "agent-dm-system", owner.id);

    const agentA = await createAgent(server.id, "agent-system-a", { runtime: "codex" });
    const agentB = await createAgent(server.id, "agent-system-b", { runtime: "codex" });

    const a2aDm = await findOrCreateAgentDM(server.id, agentA.id, agentB.id);
    assert.ok(a2aDm, "expected an agent-to-agent DM");
    await createMessage(a2aDm.id, "agent", agentA.id, "real chat preview");
    await createMessage(a2aDm.id, "agent", agentA.id, "ACTIVITY ONLY", "system");

  const ownerToken = await tokenForHuman(owner.email);
    const res = await fetch(`${app.baseUrl}/api/agents/${agentA.id}/agent-dms`, {
      headers: authHeaders(ownerToken, server.id),
    });

    assert.equal(res.status, 200);
    const body = await res.json() as Array<{
      id: string;
      lastMessagePreview: string | null;
    }>;

    assert.equal(body.length, 1);
    assert.equal(body[0].id, a2aDm.id);
    assert.equal(body[0].lastMessagePreview, "real chat preview");
});

test("GET /agents/:id/channels returns viewer-visible listable channel memberships for that agent", async ({ app }) => {
    const db = getDb();

    const [owner] = await db.insert(users).values({
      email: "owner-agent-channels@slock.test",
      name: "owner-agent-channels",
      displayName: "Owner",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();

    const server = await createServer("Agent Channels Test", "agent-channels-test", owner.id);
    const agentA = await createAgent(server.id, "channels-agent-a", { runtime: "codex" });
    const agentB = await createAgent(server.id, "channels-agent-b", { runtime: "codex" });

    const publicChannel = await createChannel(server.id, "alpha-public", "visible public channel");
    const privateChannel = await createChannel(server.id, "beta-private", "private membership", "private");
    const jointChannel = await createChannel(server.id, "gamma-joint", undefined, "joint");
    const hiddenPrivateChannel = await createChannel(server.id, "delta-hidden-private", undefined, "private");
    const hiddenJointChannel = await createChannel(server.id, "epsilon-hidden-joint", undefined, "joint");
    await addAgent(publicChannel.id, agentA.id);
    await addAgent(privateChannel.id, agentA.id);
    await addAgent(jointChannel.id, agentA.id);
    await addAgent(hiddenPrivateChannel.id, agentA.id);
    await addAgent(hiddenJointChannel.id, agentA.id);
    await addHuman(privateChannel.id, owner.id);
    await addHuman(jointChannel.id, owner.id);
    await db.insert(inboxTargetMuteStates).values([
      {
        receiverType: "agent",
        receiverId: agentA.id,
        serverId: server.id,
        sourceChannelId: privateChannel.id,
        muteFromSeq: 7,
      },
      {
        receiverType: "user",
        receiverId: owner.id,
        serverId: server.id,
        sourceChannelId: publicChannel.id,
        muteFromSeq: 3,
      },
    ]);

    const a2aDm = await findOrCreateAgentDM(server.id, agentA.id, agentB.id);
    assert.ok(a2aDm, "expected an agent-to-agent DM");

  const ownerToken = await tokenForHuman(owner.email);
    const res = await fetch(`${app.baseUrl}/api/agents/${agentA.id}/channels`, {
      headers: authHeaders(ownerToken, server.id),
    });

    assert.equal(res.status, 200);
    const body = await res.json() as Array<{
      id: string;
      name: string;
      description: string | null;
      type: string;
      createdAt: string;
      archivedAt: string | null;
      activityMuted: boolean;
      muteFromSeq: number | null;
    }>;

    const byName = new Map(body.map((channel) => [channel.name, channel]));
    assert.equal(byName.has("all"), false, "virtual #all is no longer stored as an explicit agent channel membership");
    assert.equal(byName.get("alpha-public")?.id, publicChannel.id);
    assert.equal(byName.get("alpha-public")?.type, "channel");
    assert.equal(byName.get("alpha-public")?.description, "visible public channel");
    assert.equal(
      byName.get("alpha-public")?.activityMuted,
      false,
      "viewer mute state must not be reported as the agent's mute state",
    );
    assert.equal(byName.get("alpha-public")?.muteFromSeq, null);
    assert.equal(byName.get("beta-private")?.id, privateChannel.id);
    assert.equal(byName.get("beta-private")?.type, "private");
    assert.equal(byName.get("beta-private")?.description, "private membership");
    assert.equal(byName.get("beta-private")?.activityMuted, true);
    assert.equal(byName.get("beta-private")?.muteFromSeq, 7);
    assert.equal(byName.get("gamma-joint")?.id, jointChannel.id);
    assert.equal(byName.get("gamma-joint")?.type, "joint");
    assert.equal(byName.get("gamma-joint")?.description, null);
    assert.equal(byName.get("gamma-joint")?.activityMuted, false);
    assert.equal(byName.get("gamma-joint")?.muteFromSeq, null);
    assert.equal(byName.has("delta-hidden-private"), false, "private channels should require viewer membership");
    assert.equal(byName.has("epsilon-hidden-joint"), false, "joint channels should require viewer membership");
    assert.ok(body.every((channel) => typeof channel.createdAt === "string"));
    assert.ok(body.every((channel) => channel.archivedAt === null));
    assert.equal(body.some((channel) => channel.id === a2aDm.id), false, "agent DMs should not appear as channels");
});

test("POST /agents rejects a handle already used by an active agent in the server", async ({ app }) => {
    const owner = await seedUser("principal-api-owner@slock.test", "principal-api-owner");
    const server = await createServer("Principal API", "principal-api", owner.id);
    await createAgent(server.id, "principal-api-agent", { runtime: "codex" });

  const ownerToken = await tokenForHuman(owner.email);
    const res = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "principal-api-agent", runtime: "codex" }),
    });

    assert.equal(res.status, 409);
    const body = await res.json() as { error?: string };
    assert.match(body.error ?? "", /already taken/i);
});

test("POST /agents rejects reserved mention-like handles", async ({ app }) => {
    const owner = await seedUser("reserved-agent-owner@slock.test", "reserved-agent-owner");
    const server = await createServer("Reserved Agent API", "reserved-agent-api", owner.id);
  const ownerToken = await tokenForHuman(owner.email);

    for (const name of ["all", "Human", "HUMANS", "agent", "Agents", "here", "Idle", "BUSY", "system"]) {
      const res = await fetch(`${app.baseUrl}/api/agents`, {
        method: "POST",
        headers: {
          ...authHeaders(ownerToken, server.id),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name, runtime: "codex" }),
      });

      assert.equal(res.status, 400, name);
      const body = await res.json() as { error?: string };
      assert.match(body.error ?? "", /is reserved\. Choose another name\./i);
    }

    const validRes = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "agent-helper", runtime: "codex" }),
    });
    assert.equal(validRes.status, 200);
    const validBody = await validRes.json() as { name?: string };
    assert.equal(validBody.name, "agent-helper");
});

test("agent creator is set at creation and cannot be changed", async ({ app }) => {
    const db = getDb();
    const owner = await seedUser("creator-owner@slock.test", "creator-owner");
    const member = await seedUser("creator-member@slock.test", "creator-member");
    const server = await createServer("Creator Server", "creator-server", owner.id);
    await db.insert(serverMembers).values([
      { serverId: server.id, userId: member.id, role: "member" },
    ]);

  const ownerToken = await tokenForHuman(owner.email);
  const memberToken = await tokenForHuman(member.email);

    const createRes = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "creator-agent", runtime: "codex" }),
    });
    assert.equal(createRes.status, 200);
    const created = await createRes.json() as { id: string; creator: { type: string; id: string } | null };
    assert.equal(created.creator?.type, "human");
    assert.equal(created.creator?.id, owner.id);

    const ownerProfileRes = await fetch(`${app.baseUrl}/api/servers/${server.id}/members/${owner.id}/profile`, {
      headers: authHeaders(ownerToken, server.id),
    });
    assert.equal(ownerProfileRes.status, 200);
    const ownerProfile = await ownerProfileRes.json() as { createdAgents: Array<{ id: string }> };
    assert.deepEqual(ownerProfile.createdAgents.map((m) => m.id), [created.id]);

    const forbiddenRes = await fetch(`${app.baseUrl}/api/agents/${created.id}/creator`, {
      method: "PATCH",
      headers: {
        ...authHeaders(memberToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ creatorType: "user", creatorId: member.id }),
    });
    assert.equal(forbiddenRes.status, 404);

    const getRes = await fetch(`${app.baseUrl}/api/agents/${created.id}`, {
      headers: authHeaders(ownerToken, server.id),
    });
    assert.equal(getRes.status, 200);
    const afterPatch = await getRes.json() as { creator: { id: string } | null };
    assert.equal(afterPatch.creator?.id, owner.id);
});

test("member viewAgents authority reaches runtime options without an owner/admin-only gate", async ({ app }) => {
    const db = getDb();
    const owner = await seedUser("runtime-options-owner@slock.test", "runtime-options-owner");
    const member = await seedUser("runtime-options-member@slock.test", "runtime-options-member");
    const server = await createServer("Runtime Options Server", "runtime-options-server", owner.id);
    await db.insert(serverMembers).values({
      serverId: server.id,
      userId: member.id,
      role: "member",
    });
    const agent = await createAgent(server.id, "runtime-options-agent", {
      runtime: "codex",
      creatorType: "user",
      creatorId: owner.id,
    });
  const memberToken = await tokenForHuman(member.email);

    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}/runtime-options`, {
      headers: authHeaders(memberToken, server.id),
    });
    assert.equal(res.status, 200, "member's viewAgents capability must satisfy the runtime-options read gate");
});

test("bootstrap-token denial names issueAgentCredentials and human creator authority", async () => {
  const gateKey = "SLOCK_SELF_HOSTED_RUNNER_BOOTSTRAP_ENABLED";
  const oldGate = process.env[gateKey];
  const oldPepper = process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER;
  process.env[gateKey] = "true";
  process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER = "bootstrap-copy-test-pepper-at-least-32-bytes";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const db = getDb();
    const owner = await seedUser("bootstrap-copy-owner@slock.test", "bootstrap-copy-owner");
    const member = await seedUser("bootstrap-copy-member@slock.test", "bootstrap-copy-member");
    const server = await createServer("Bootstrap Copy Server", "bootstrap-copy-server", owner.id);
    await db.insert(serverMembers).values({
      serverId: server.id,
      userId: member.id,
      role: "member",
    });
    const agent = await createAgent(server.id, "bootstrap-copy-agent", {
      runtime: "codex",
      creatorType: "user",
      creatorId: owner.id,
    });
    const memberToken = await tokenForHuman(member.email);

    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}/bootstrap-tokens`, {
      method: "POST",
      headers: {
        ...authHeaders(memberToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 403);
    const body = await res.json() as { code: string; error: string };
    assert.equal(body.code, "insufficient_role");
    assert.match(body.error, /issueAgentCredentials/);
    assert.match(body.error, /human creator authority/);
    assert.doesNotMatch(body.error, /owners and admins/);
  } finally {
    await app.close();
    if (oldGate === undefined) delete process.env[gateKey];
    else process.env[gateKey] = oldGate;
    if (oldPepper === undefined) delete process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER;
    else process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER = oldPepper;
  }
});

test("agent private surfaces (workspace, skills, activity, agent-DMs, reminders) are limited to creator or server admin", async ({ app }) => {
    const db = getDb();
    const owner = await seedUser("private-surface-owner@slock.test", "private-surface-owner");
    const creator = await seedUser("private-surface-creator@slock.test", "private-surface-creator");
    const admin = await seedUser("private-surface-admin@slock.test", "private-surface-admin");
    const viewer = await seedUser("private-surface-viewer@slock.test", "private-surface-viewer");
    const server = await createServer("Agent Private Surface Server", "agent-private-surface", owner.id);
    await db.insert(serverMembers).values([
      { serverId: server.id, userId: creator.id, role: "member" },
      { serverId: server.id, userId: admin.id, role: "admin" },
      { serverId: server.id, userId: viewer.id, role: "member" },
    ]);
    const [machine] = await db.insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "private-surface-machine",
      apiKeyHash: "private-surface-machine-hash",
      runtimes: ["codex"],
    }).returning();
    const agent = await createAgent(server.id, "private-surface-agent", {
      runtime: "codex",
      machineId: machine!.id,
      creatorType: "user",
      creatorId: creator.id,
    });

    Object.assign(app.app.get("agentOrchestrator"), {
      listRecentActivityLog: async () => [{ activity: "working", detail: "secret work" }],
      getAgentFileTree: async () => [{ name: "MEMORY.md", path: "MEMORY.md", type: "file" }],
      readAgentFile: async () => ({
        content: "secret",
        binary: false,
        size: 6,
        mimeType: "text/plain",
        encoding: "utf8",
      }),
      getAgentSkills: async () => ({
        global: [],
        workspace: [{ name: "secret-skill", path: "skills/secret-skill/SKILL.md" }],
      }),
    });

  const creatorToken = await tokenForHuman(creator.email);
  const adminToken = await tokenForHuman(admin.email);
  const viewerToken = await tokenForHuman(viewer.email);
    const routes = [
      `/api/agents/${agent.id}/activity-log`,
      `/api/agents/${agent.id}/workspace-files`,
      `/api/agents/${agent.id}/workspace-files/read?path=MEMORY.md`,
      `/api/agents/${agent.id}/skills`,
      `/api/agents/${agent.id}/agent-dms`,
      `/api/agents/${agent.id}/channels`,
      `/api/reminders?ownerAgentId=${agent.id}`,
    ];

    for (const route of routes) {
      const viewerRes = await fetch(`${app.baseUrl}${route}`, {
        headers: authHeaders(viewerToken, server.id),
      });
      assert.equal(viewerRes.status, 403, `${route} should reject non-creator members`);

      const creatorRes = await fetch(`${app.baseUrl}${route}`, {
        headers: authHeaders(creatorToken, server.id),
      });
      assert.equal(creatorRes.status, 200, `${route} should allow the agent creator`);

      const adminRes = await fetch(`${app.baseUrl}${route}`, {
        headers: authHeaders(adminToken, server.id),
      });
      assert.equal(adminRes.status, 200, `${route} should allow server admins`);
    }
});

test("workspace file tree forwards includeHidden to the daemon request", async ({ app }) => {
    const db = getDb();
    const owner = await seedUser("workspace-hidden-owner@slock.test", "workspace-hidden-owner");
    const server = await createServer("Workspace Hidden Server", "workspace-hidden-server", owner.id);
    const [machine] = await db.insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "workspace-hidden-machine",
      apiKeyHash: "workspace-hidden-machine-hash",
      runtimes: ["codex"],
    }).returning();
    const agent = await createAgent(server.id, "workspace-hidden-agent", {
      runtime: "codex",
      machineId: machine!.id,
      creatorType: "user",
      creatorId: owner.id,
    });

    const calls: Array<{ agentId: string; dirPath?: string; includeHidden?: boolean }> = [];
    Object.assign(app.app.get("agentOrchestrator"), {
      getAgentFileTree: async (agentId: string, dirPath?: string, includeHidden?: boolean) => {
        calls.push({ agentId, dirPath, includeHidden });
        return [{ name: ".gitignore", path: ".gitignore", isDirectory: false, size: 12, modifiedAt: new Date().toISOString(), isHidden: true }];
      },
    });

  const ownerToken = await tokenForHuman(owner.email);
    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}/workspace-files?dirPath=notes&includeHidden=true`, {
      headers: authHeaders(ownerToken, server.id),
    });

    assert.equal(res.status, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { agentId: agent.id, dirPath: "notes", includeHidden: true });
    const body = await res.json() as { files: Array<{ name: string; isHidden?: boolean }> };
    assert.equal(body.files[0]?.name, ".gitignore");
    assert.equal(body.files[0]?.isHidden, true);
});

test("workspace file routes classify closed machine failures while unknown failures stay fail-closed", async ({ app }) => {
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({
      sink,
      traceIdGenerator: () => "5".repeat(32),
      spanIdGenerator: (() => {
        let next = 1;
        return () => String(next++).padStart(16, "0");
      })(),
    });
    app.app.set("serverTracer", tracer);

    const db = getDb();
    const owner = await seedUser("workspace-failure-owner@slock.test", "workspace-failure-owner");
    const server = await createServer("Workspace Failure Server", "workspace-failure-server", owner.id);
    const unassignedAgent = await createAgent(server.id, "workspace-unassigned-agent", {
      runtime: "codex",
      creatorType: "user",
      creatorId: owner.id,
    });
    const [machine] = await db.insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "workspace-failure-machine",
      apiKeyHash: "workspace-failure-machine-hash",
      runtimes: ["codex"],
    }).returning();
    const assignedAgent = await createAgent(server.id, "workspace-assigned-agent", {
      runtime: "codex",
      machineId: machine!.id,
      creatorType: "user",
      creatorId: owner.id,
    });
  const ownerToken = await tokenForHuman(owner.email);
    const events = () => sink.getAllSpans().flatMap((span) => span.events);
    const orchestrator = app.app.get("agentOrchestrator");

    const directOrchestrator = new AgentOrchestrator();
    try {
      for (const request of [
        () => directOrchestrator.getAgentFileTree(unassignedAgent.id),
        () => directOrchestrator.readAgentFile(unassignedAgent.id, "MEMORY.md"),
      ]) {
        await assert.rejects(request, (error: unknown) => {
          assert.ok(error instanceof RouteFailureError);
          assert.equal(error.subkind, "daemon_offline");
          assert.equal(error.message, "Agent has no connected machine");
          return true;
        });
      }
    } finally {
      directOrchestrator.shutdown();
    }

    const seedDirectMachineConnection = (
      target: AgentOrchestrator,
      send: (payload: string) => void,
    ) => {
      (target as unknown as {
        machineConnections: Map<string, unknown>;
      }).machineConnections.set(machine!.id, {
        ws: { readyState: 1, send },
        machineId: machine!.id,
        serverId: server.id,
        principalKind: "computer",
        connectionEpochId: "workspace-route-test-epoch",
        heartbeatTimer: null,
        lastPong: 0,
        lastIngressAt: 0,
        daemonVersion: "test",
        capabilities: new Set<string>(),
        migrationTransport: null,
        shutdownIntent: null,
        computerVersion: null,
      });
    };
    const assertRouteFailure = (
      subkind: "daemon_offline" | "daemon_timeout",
      message: string,
    ) => (error: unknown) => {
      assert.ok(error instanceof RouteFailureError);
      assert.equal(error.subkind, subkind);
      assert.equal(error.message, message);
      return true;
    };

    const timeoutClock = new WorkspaceTestClock();
    const timeoutOrchestrator = new AgentOrchestrator(undefined, timeoutClock);
    seedDirectMachineConnection(timeoutOrchestrator, () => {});
    try {
      const listTimeout = timeoutOrchestrator.getAgentFileTree(assignedAgent.id);
      await waitForWorkspaceTimeout(timeoutClock);
      timeoutClock.advance(15_000);
      await assert.rejects(
        listTimeout,
        assertRouteFailure("daemon_timeout", "File tree request timed out"),
      );

      const readTimeout = timeoutOrchestrator.readAgentFile(assignedAgent.id, "MEMORY.md");
      await waitForWorkspaceTimeout(timeoutClock);
      timeoutClock.advance(15_000);
      await assert.rejects(
        readTimeout,
        assertRouteFailure("daemon_timeout", "File read request timed out"),
      );
    } finally {
      timeoutOrchestrator.shutdown();
    }

    const sendFailureOrchestrator = new AgentOrchestrator();
    seedDirectMachineConnection(sendFailureOrchestrator, () => {
      throw new Error("synthetic closed socket");
    });
    try {
      await assert.rejects(
        () => sendFailureOrchestrator.getAgentFileTree(assignedAgent.id),
        assertRouteFailure("daemon_offline", "Failed to send request — machine WebSocket not ready"),
      );
      await assert.rejects(
        () => sendFailureOrchestrator.readAgentFile(assignedAgent.id, "MEMORY.md"),
        assertRouteFailure("daemon_offline", "Failed to send request — machine WebSocket not ready"),
      );
    } finally {
      sendFailureOrchestrator.shutdown();
    }

    Object.assign(orchestrator, {
      hasMachineLocally: () => true,
      getAgentFileTree: async () => {
        throw new Error("Agent has no connected machine");
      },
      readAgentFile: async () => {
        throw new Error("Agent has no connected machine");
      },
    });

    sink.clear();
    const unassignedListRes = await fetch(
      `${app.baseUrl}/api/agents/${unassignedAgent.id}/workspace-files`,
      { headers: authHeaders(ownerToken, server.id) },
    );
    assert.equal(unassignedListRes.status, 409);
    assert.equal((await unassignedListRes.json() as { code?: string }).code, "machine_unassigned");
    const unassignedListEvent = events().find((event) => event.name === "agent.workspace.list.rejected");
    assert.ok(unassignedListEvent, "expected unassigned workspace-list rejection event");
    assert.equal(unassignedListEvent.attrs?.route_action, "workspace_list");
    assert.equal(unassignedListEvent.attrs?.reason, "machine_unassigned");
    assert.equal(unassignedListEvent.attrs?.http_status, 409);
    assert.equal(unassignedListEvent.attrs?.response_code, "machine_unassigned");
    assert.equal(events().some((event) => event.name === "server.route.error_response"), false);

    sink.clear();
    const unassignedReadRes = await fetch(
      `${app.baseUrl}/api/agents/${unassignedAgent.id}/workspace-files/read?path=MEMORY.md`,
      { headers: authHeaders(ownerToken, server.id) },
    );
    assert.equal(unassignedReadRes.status, 409);
    assert.equal((await unassignedReadRes.json() as { code?: string }).code, "machine_unassigned");
    const unassignedReadEvent = events().find((event) => event.name === "agent.workspace.read.rejected");
    assert.ok(unassignedReadEvent, "expected unassigned workspace-read rejection event");
    assert.equal(unassignedReadEvent.attrs?.route_action, "workspace_read");
    assert.equal(unassignedReadEvent.attrs?.reason, "machine_unassigned");
    assert.equal(unassignedReadEvent.attrs?.http_status, 409);
    assert.equal(unassignedReadEvent.attrs?.response_code, "machine_unassigned");
    assert.equal(events().some((event) => event.name === "server.route.error_response"), false);

    Object.assign(orchestrator, {
      getAgentFileTree: async () => {
        throw new RouteFailureError("daemon_offline", "Agent has no connected machine");
      },
      readAgentFile: async () => {
        throw new RouteFailureError("daemon_timeout", "File read request timed out");
      },
    });

    sink.clear();
    const offlineListRes = await fetch(
      `${app.baseUrl}/api/agents/${assignedAgent.id}/workspace-files`,
      { headers: authHeaders(ownerToken, server.id) },
    );
    assert.equal(offlineListRes.status, 409);
    assert.deepEqual(await offlineListRes.json(), {
      error: "Agent has no connected machine",
      code: "machine_offline",
    });
    const offlineListEvent = events().find((event) => event.name === "agent.workspace.list.failed");
    assert.ok(offlineListEvent, "expected classified workspace-list failure event");
    assert.equal(offlineListEvent.attrs?.route_action, "workspace_list");
    assert.equal(offlineListEvent.attrs?.outcome, "error");
    assert.equal(offlineListEvent.attrs?.error_kind, "daemon_unavailable");
    assert.equal(offlineListEvent.attrs?.error_subkind, "daemon_offline");
    assert.equal(offlineListEvent.attrs?.http_status, 409);
    assert.equal(offlineListEvent.attrs?.response_code, "machine_offline");
    assert.equal(events().some((event) => event.name === "server.route.error_response"), false);

    sink.clear();
    const timeoutReadRes = await fetch(
      `${app.baseUrl}/api/agents/${assignedAgent.id}/workspace-files/read?path=MEMORY.md`,
      { headers: authHeaders(ownerToken, server.id) },
    );
    assert.equal(timeoutReadRes.status, 504);
    assert.deepEqual(await timeoutReadRes.json(), {
      error: "Workspace file read request timed out",
      code: "daemon_timeout",
    });
    const timeoutReadEvent = events().find((event) => event.name === "agent.workspace.read.failed");
    assert.ok(timeoutReadEvent, "expected classified workspace-read failure event");
    assert.equal(timeoutReadEvent.attrs?.route_action, "workspace_read");
    assert.equal(timeoutReadEvent.attrs?.outcome, "error");
    assert.equal(timeoutReadEvent.attrs?.error_kind, "daemon_unavailable");
    assert.equal(timeoutReadEvent.attrs?.error_subkind, "daemon_timeout");
    assert.equal(timeoutReadEvent.attrs?.http_status, 504);
    assert.equal(timeoutReadEvent.attrs?.response_code, "daemon_timeout");
    assert.equal(events().some((event) => event.name === "server.route.error_response"), false);

    Object.assign(orchestrator, {
      getAgentFileTree: async () => {
        throw new Error("Agent has no connected machine");
      },
    });

    sink.clear();
    const unknownListRes = await fetch(
      `${app.baseUrl}/api/agents/${assignedAgent.id}/workspace-files`,
      { headers: authHeaders(ownerToken, server.id) },
    );
    assert.equal(unknownListRes.status, 500);
    assert.equal(
      (await unknownListRes.json() as { code?: string }).code,
      "agent_workspace_files_failed",
    );
    const unknownEvent = events().find((event) => event.name === "server.route.error_response");
    assert.ok(unknownEvent, "expected unknown workspace failure to retain central 500 trace");
    assert.equal(unknownEvent.attrs?.reason, "unexpected_server_error");
    assert.equal(unknownEvent.attrs?.http_status, 500);
    assert.equal(events().some((event) => event.name === "agent.workspace.list.failed"), false);
});

test("agent skills returns a closed machine-affinity error when non-local owner is missing", async ({ app }) => {
    const db = getDb();
    const owner = await seedUser("skills-affinity-owner@slock.test", "skills-affinity-owner");
    const server = await createServer("Skills Affinity Server", "skills-affinity-server", owner.id);
    const [machine] = await db.insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "skills-affinity-machine",
      apiKeyHash: "skills-affinity-machine-hash",
      runtimes: ["codex"],
    }).returning();
    const agent = await createAgent(server.id, "skills-affinity-agent", {
      runtime: "codex",
      machineId: machine!.id,
      creatorType: "user",
      creatorId: owner.id,
    });

    Object.assign(app.app.get("agentOrchestrator"), {
      hasMachineLocally: () => false,
      getAgentSkills: async () => {
        throw new Error("should not list skills without a local or replay owner");
      },
    });

  const ownerToken = await tokenForHuman(owner.email);
    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}/skills`, {
      headers: authHeaders(ownerToken, server.id),
    });

    assert.equal(res.status, 503);
    const body = await res.json() as { code: string; machineAffinityRoute: string; error: string };
    assert.equal(body.code, "machine_affinity_unavailable");
    assert.equal(body.machineAffinityRoute, "owner_missing");
    assert.match(body.error, /Machine is not connected/);
});

test("agent start rejects unassigned machines and classifies daemon-offline failures", async ({ app }) => {
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({
      sink,
      traceIdGenerator: () => "4".repeat(32),
      spanIdGenerator: (() => {
        let next = 1;
        return () => String(next++).padStart(16, "0");
      })(),
    });
    app.app.set("serverTracer", tracer);

    const db = getDb();
    const owner = await seedUser("start-route-failure-owner@slock.test", "start-route-failure-owner");
    const server = await createServer("Start Route Failure Server", "start-route-failure-server", owner.id);
    const unassignedAgent = await createAgent(server.id, "start-unassigned-agent", {
      runtime: "codex",
      creatorType: "user",
      creatorId: owner.id,
    });
    const [machine] = await db.insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "start-route-failure-machine",
      apiKeyHash: "start-route-failure-machine-hash",
    }).returning();
    const assignedAgent = await createAgent(server.id, "start-offline-agent", {
      runtime: "codex",
      machineId: machine!.id,
      creatorType: "user",
      creatorId: owner.id,
    });

    Object.assign(app.app.get("agentOrchestrator"), {
      hasMachineLocally: () => true,
      startAgent: async () => {
        throw new RouteFailureError("daemon_offline", "Machine offline. Please start your local daemon.");
      },
    });
  const ownerToken = await tokenForHuman(owner.email);

    sink.clear();
    const unassignedRes = await fetch(`${app.baseUrl}/api/agents/${unassignedAgent.id}/start`, {
      method: "POST",
      headers: authHeaders(ownerToken, server.id),
    });
    assert.equal(unassignedRes.status, 409);
    assert.equal((await unassignedRes.json() as { code?: string }).code, "machine_unassigned");
    const unassignedEvent = sink
      .getAllSpans()
      .flatMap((span) => span.events)
      .find((event) => event.name === "agent.start.rejected");
    assert.ok(unassignedEvent, "expected unassigned start rejection event");
    assert.equal(unassignedEvent.attrs?.reason, "machine_unassigned");
    assert.equal(unassignedEvent.attrs?.http_status, 409);

    sink.clear();
    const offlineRes = await fetch(`${app.baseUrl}/api/agents/${assignedAgent.id}/start`, {
      method: "POST",
      headers: authHeaders(ownerToken, server.id),
    });
    assert.equal(offlineRes.status, 409);
    assert.equal((await offlineRes.json() as { code?: string }).code, "machine_offline");
    const offlineEvent = sink
      .getAllSpans()
      .flatMap((span) => span.events)
      .find((event) => event.name === "agent.start.failed");
    assert.ok(offlineEvent, "expected classified start failure event");
    assert.equal(offlineEvent.attrs?.error_kind, "daemon_unavailable");
    assert.equal(offlineEvent.attrs?.error_subkind, "daemon_offline");
    assert.equal(offlineEvent.attrs?.http_status, 409);
    assert.equal(offlineEvent.attrs?.response_code, "machine_offline");

    Object.assign(app.app.get("agentOrchestrator"), {
      startAgent: async () => {
        throw new KimiReasoningEffortUpgradeRequiredError();
      },
    });
    const upgradeRequiredRes = await fetch(`${app.baseUrl}/api/agents/${assignedAgent.id}/start`, {
      method: "POST",
      headers: authHeaders(ownerToken, server.id),
    });
    assert.equal(upgradeRequiredRes.status, 409);
    assert.equal((await upgradeRequiredRes.json() as { code?: string }).code, "upgrade_required");
});

test("agent skills failures return typed statuses and record classified sanitized trace events", async ({ app }) => {
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({
      sink,
      traceIdGenerator: () => "2".repeat(32),
      spanIdGenerator: (() => {
        let next = 1;
        return () => String(next++).padStart(16, "0");
      })(),
    });
    app.app.set("serverTracer", tracer);

    const owner = await seedUser("skills-trace-owner@slock.test", "skills-trace-owner");
    const server = await createServer("Skills Trace Server", "skills-trace-server", owner.id);
    const timeoutAgent = await createAgent(server.id, "skills-trace-timeout-agent", {
      runtime: "codex",
      creatorType: "user",
      creatorId: owner.id,
    });
    const daemonAgent = await createAgent(server.id, "skills-trace-daemon-agent", {
      runtime: "claude",
      creatorType: "user",
      creatorId: owner.id,
    });

  const ownerToken = await tokenForHuman(owner.email);
    const findFailedEvent = () => sink
      .getAllSpans()
      .flatMap((span) => span.events)
      .find((event) => event.name === "agent.skills.list.failed");

    Object.assign(app.app.get("agentOrchestrator"), {
      getAgentSkills: async () => {
        throw new RouteFailureError(
          "daemon_timeout",
          "Skills list request timed out while reading /Users/alice/workspace/skills/secret-skill/SKILL.md",
        );
      },
    });
    sink.clear();
    const timeoutRes = await fetch(`${app.baseUrl}/api/agents/${timeoutAgent.id}/skills`, {
      headers: authHeaders(ownerToken, server.id),
    });
    assert.equal(timeoutRes.status, 504);
    assert.equal((await timeoutRes.json() as { code?: string }).code, "daemon_timeout");
    const timeoutEvent = findFailedEvent();
    assert.ok(timeoutEvent, "expected skills-list failure trace event");
    assert.equal(timeoutEvent.attrs?.route_action, "skills_list");
    assert.equal(timeoutEvent.attrs?.outcome, "error");
    assert.equal(timeoutEvent.attrs?.reason, "daemon_timeout");
    assert.equal(timeoutEvent.attrs?.error_class, "RouteFailureError");
    assert.equal(timeoutEvent.attrs?.error_kind, "daemon_unavailable");
    assert.equal(timeoutEvent.attrs?.error_subkind, "daemon_timeout");
    assert.equal(timeoutEvent.attrs?.error_message, "Skills list request timed out");
    assert.equal(timeoutEvent.attrs?.runtime, "codex");
    assert.equal(timeoutEvent.attrs?.http_status, 504);
    assert.equal(timeoutEvent.attrs?.response_code, "daemon_timeout");
    assert.equal(typeof timeoutEvent.attrs?.duration_ms, "number");
    const timeoutTraceJson = JSON.stringify(timeoutEvent.attrs);
    assert.equal(timeoutTraceJson.includes("/Users/alice"), false);
    assert.equal(timeoutTraceJson.includes("secret-skill"), false);

    Object.assign(app.app.get("agentOrchestrator"), {
      getAgentSkills: async () => {
        throw new RouteFailureError(
          "daemon_offline",
          "Failed to send request: machine WebSocket not ready for /tmp/workspace/skills/private-skill",
        );
      },
    });
    sink.clear();
    const daemonRes = await fetch(`${app.baseUrl}/api/agents/${daemonAgent.id}/skills`, {
      headers: authHeaders(ownerToken, server.id),
    });
    assert.equal(daemonRes.status, 409);
    assert.equal((await daemonRes.json() as { code?: string }).code, "machine_offline");
    const daemonEvent = findFailedEvent();
    assert.ok(daemonEvent, "expected daemon-error trace event");
    assert.equal(daemonEvent.attrs?.reason, "daemon_error");
    assert.equal(daemonEvent.attrs?.error_kind, "daemon_unavailable");
    assert.equal(daemonEvent.attrs?.error_subkind, "daemon_offline");
    assert.equal(daemonEvent.attrs?.error_message, "Failed to send skills list request to daemon");
    assert.equal(daemonEvent.attrs?.runtime, "claude");
    assert.equal(daemonEvent.attrs?.http_status, 409);
    assert.equal(daemonEvent.attrs?.response_code, "machine_offline");
    const daemonTraceJson = JSON.stringify(daemonEvent.attrs);
    assert.equal(daemonTraceJson.includes("/tmp/workspace"), false);
    assert.equal(daemonTraceJson.includes("private-skill"), false);
});

test("agent skills machine-affinity 503 does not record the 500-catch trace event", async ({ app }) => {
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({
      sink,
      traceIdGenerator: () => "3".repeat(32),
      spanIdGenerator: (() => {
        let next = 1;
        return () => String(next++).padStart(16, "0");
      })(),
    });
    app.app.set("serverTracer", tracer);

    const db = getDb();
    const owner = await seedUser("skills-affinity-trace-owner@slock.test", "skills-affinity-trace-owner");
    const server = await createServer("Skills Affinity Trace Server", "skills-affinity-trace-server", owner.id);
    const [machine] = await db.insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "skills-affinity-trace-machine",
      apiKeyHash: "skills-affinity-trace-machine-hash",
      runtimes: ["codex"],
    }).returning();
    const agent = await createAgent(server.id, "skills-affinity-trace-agent", {
      runtime: "codex",
      machineId: machine!.id,
      creatorType: "user",
      creatorId: owner.id,
    });

    let listedSkills = false;
    Object.assign(app.app.get("agentOrchestrator"), {
      hasMachineLocally: () => false,
      getAgentSkills: async () => {
        listedSkills = true;
        throw new Error("should not list skills without a local or replay owner");
      },
    });

  const ownerToken = await tokenForHuman(owner.email);
    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}/skills`, {
      headers: authHeaders(ownerToken, server.id),
    });

    assert.equal(res.status, 503);
    assert.equal(listedSkills, false);
    const failedEvents = sink
      .getAllSpans()
      .flatMap((span) => span.events)
      .filter((event) => event.name === "agent.skills.list.failed");
    assert.equal(failedEvents.length, 0);
});

test("agent skills rejects forged replay headers before running the local owner handler", async ({ app }) => {
    const db = getDb();
    const owner = await seedUser("skills-forged-replay-owner@slock.test", "skills-forged-replay-owner");
    const server = await createServer("Skills Forged Replay Server", "skills-forged-replay-server", owner.id);
    const [machine] = await db.insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "skills-forged-replay-machine",
      apiKeyHash: "skills-forged-replay-machine-hash",
      runtimes: ["codex"],
    }).returning();
    const agent = await createAgent(server.id, "skills-forged-replay-agent", {
      runtime: "codex",
      machineId: machine!.id,
      creatorType: "user",
      creatorId: owner.id,
    });

    Object.assign(app.app.get("agentOrchestrator"), {
      hasMachineLocally: () => true,
      getAgentSkills: async () => {
        throw new Error("should reject forged replay headers before listing skills");
      },
    });

  const ownerToken = await tokenForHuman(owner.email);
    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}/skills`, {
      headers: {
        ...authHeaders(ownerToken, server.id),
        "x-raft-replica-replay": "1",
        "x-raft-replica-replay-machine": machine!.id,
        "x-raft-replica-replay-timestamp": String(Date.now()),
        "x-raft-replica-replay-signature": "forged",
      },
    });

    assert.equal(res.status, 400);
    const body = await res.json() as { code: string; machineAffinityRoute: string; error: string };
    assert.equal(body.code, "invalid_replica_replay_signature");
    assert.equal(body.machineAffinityRoute, "owner_not_local");
    assert.match(body.error, /Invalid internal replay signature/);
});

test("agent skills replay loop guard returns owner_not_local when replay reaches a non-owner replica", async ({ app }) => {
    const db = getDb();
    const owner = await seedUser("skills-replay-loop-owner@slock.test", "skills-replay-loop-owner");
    const server = await createServer("Skills Replay Loop Server", "skills-replay-loop-server", owner.id);
    const [machine] = await db.insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "skills-replay-loop-machine",
      apiKeyHash: "skills-replay-loop-machine-hash",
      runtimes: ["codex"],
    }).returning();
    const agent = await createAgent(server.id, "skills-replay-loop-agent", {
      runtime: "codex",
      machineId: machine!.id,
      creatorType: "user",
      creatorId: owner.id,
    });

    Object.assign(app.app.get("agentOrchestrator"), {
      hasMachineLocally: () => false,
      getAgentSkills: async () => {
        throw new Error("should stop replay loops before listing skills");
      },
    });

  const ownerToken = await tokenForHuman(owner.email);
    const path = `/api/agents/${agent.id}/skills`;
    const timestamp = String(Date.now());
    const res = await fetch(`${app.baseUrl}${path}`, {
      headers: {
        ...authHeaders(ownerToken, server.id),
        "x-raft-replica-replay": "1",
        "x-raft-replica-replay-machine": machine!.id,
        "x-raft-replica-replay-timestamp": timestamp,
        "x-raft-replica-replay-signature": signReplicaReplayForTest("GET", path, machine!.id, timestamp),
      },
    });

    assert.equal(res.status, 409);
    const body = await res.json() as { code: string; machineAffinityRoute: string; error: string };
    assert.equal(body.code, "machine_owner_not_local");
    assert.equal(body.machineAffinityRoute, "owner_not_local");
    assert.match(body.error, /not connected to this replica/);
});

test("GET /agents records restore-path trace phases with batched creator enrichment", async ({ app }) => {
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({
      sink,
      traceIdGenerator: () => "1".repeat(32),
      spanIdGenerator: (() => {
        let next = 1;
        return () => String(next++).padStart(16, "0");
      })(),
    });
    app.app.set("serverTracer", tracer);

    const db = getDb();
    const owner = await seedUser("agents-trace-owner@slock.test", "agents-trace-owner");
    const server = await createServer("Agents Trace Server", "agents-trace-server", owner.id);
    await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
    const rootAgent = await createAgent(server.id, "root-agent", {
      runtime: "codex",
      creatorType: "user",
      creatorId: owner.id,
    });
    await createAgent(server.id, "child-agent", {
      runtime: "codex",
      creatorType: "agent",
      creatorId: rootAgent.id,
    });

  const ownerToken = await tokenForHuman(owner.email);
    sink.clear();

    const res = await fetch(`${app.baseUrl}/api/agents`, {
      headers: authHeaders(ownerToken, server.id),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as Array<{ id: string; createdAgents: Array<{ id: string }> }>;
    assert.equal(body.length, 2);

    const span = sink.getAllSpans().find((candidate) =>
      candidate.name === "server.http.request"
      && candidate.attrs?.route_pattern === "/api/agents/",
    );
    assert.ok(span, "expected GET /api/agents root span");

    const processEventNames = span.events
      .map((event) => event.name)
      .filter((name) => name !== "db.query.finished" && name !== "server.runtime_config.parse");
    assert.deepEqual(processEventNames, [
      "agents.list.started",
      "agent.permissions.checked",
      "agents.loaded",
      "runtime_profiles.loaded",
      "agent_server_roles.loaded",
      "activities.loaded",
      "creators.enriched",
      "response.ready",
      "http.response.finished",
    ]);

    const dbEvents = span.events.filter((event) => event.name === "db.query.finished");
    assert.deepEqual(
      dbEvents.map((event) => event.attrs?.query_name).sort(),
      [
        "agents.batch_creator_enrich.agent_creators",
        "agents.batch_creator_enrich.created_agents",
        "agents.batch_creator_enrich.user_creators",
        "agents.list_by_server",
        "agents.runtime_profiles_by_agents",
      ],
    );
    const dbEventByQuery = new Map(dbEvents.map((event) => [event.attrs?.query_name, event]));
    assert.equal(dbEventByQuery.get("agents.list_by_server")?.attrs?.phase, "agents.loaded");
    assert.equal(dbEventByQuery.get("agents.list_by_server")?.attrs?.row_count, 2);
    assert.equal(dbEventByQuery.get("agents.list_by_server")?.attrs?.include_deleted, true);
    assert.equal(dbEventByQuery.get("agents.runtime_profiles_by_agents")?.attrs?.phase, "runtime_profiles.loaded");
    assert.equal(dbEventByQuery.get("agents.runtime_profiles_by_agents")?.attrs?.input_count, 2);
    assert.equal(dbEventByQuery.get("agents.batch_creator_enrich.user_creators")?.attrs?.phase, "creators.enriched");
    assert.equal(dbEventByQuery.get("agents.batch_creator_enrich.user_creators")?.attrs?.row_count, 1);
    assert.equal(dbEventByQuery.get("agents.batch_creator_enrich.agent_creators")?.attrs?.row_count, 1);
    assert.equal(dbEventByQuery.get("agents.batch_creator_enrich.created_agents")?.attrs?.row_count, 1);

    const creatorsEvent = span.events.find((event) => event.name === "creators.enriched");
    assert.ok(creatorsEvent);
    assert.equal(creatorsEvent.attrs?.batched, true);
    assert.equal(creatorsEvent.attrs?.agents_count, 2);
    assert.equal(creatorsEvent.attrs?.creator_user_count, 1);
    assert.equal(creatorsEvent.attrs?.creator_agent_count, 1);

    const readyEvent = span.events.find((event) => event.name === "response.ready");
    assert.ok(readyEvent);
    assert.equal(readyEvent.attrs?.agents_count, 2);
    assert.equal(readyEvent.attrs?.env_vars_stripped, false);
});

test("agent-to-agent DM channels are not readable through ordinary human message routes", async ({ app }) => {
    const db = getDb();

    const [owner] = await db.insert(users).values({
      email: "owner-a2a-read@slock.test",
      name: "owner-a2a-read",
      displayName: "Owner",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    const [member] = await db.insert(users).values({
      email: "member-a2a-read@slock.test",
      name: "member-a2a-read",
      displayName: "Member",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();

    const server = await createServer("Agent DM Visibility", "agent-dm-visibility", owner.id);
    await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });

    const agentA = await createAgent(server.id, "agent-reader-a", { runtime: "codex" });
    const agentB = await createAgent(server.id, "agent-reader-b", { runtime: "codex" });
    const a2aDm = await findOrCreateAgentDM(server.id, agentA.id, agentB.id);
    assert.ok(a2aDm, "expected an agent-to-agent DM");

    await createMessage(a2aDm.id, "agent", agentA.id, "private agent transcript");

  const memberToken = await tokenForHuman(member.email);
    const res = await fetch(`${app.baseUrl}/api/messages/channel/${a2aDm.id}`, {
      headers: authHeaders(memberToken, server.id),
    });

    // task #48: JUDGED individually. A human member of the server reading an
    // AGENT-TO-AGENT DM has no participant row and no receiver-owned residue for
    // it -- agent-agent DMs have no human participants at all. So this caller is
    // a stranger to that channel and the honest 403 would be telling them a
    // private agent transcript exists. Denial unchanged; disclosure removed.
    assert.equal(res.status, 404);
});

test("user-to-agent DMs keep conversation actions after the peer agent is deleted", async ({ app }) => {
    const owner = await seedUser("owner-deleted-agent-dm@slock.test", "owner-deleted-agent-dm");
    const server = await createServer("Deleted Agent DM", "deleted-agent-dm", owner.id);
    const agent = await createAgent(server.id, "deleted-dm-peer", { runtime: "codex" });
    const dm = await findOrCreateDM(server.id, owner.id, agent.id);
    assert.ok(dm, "expected a user-to-agent DM");
    // The peer agent leaves a message, then is deleted. mark-unread targets the latest
    // NON-self message (a self-authored message correctly never shows as unread to its
    // author), so the surviving unread here must come from the agent — this is what
    // proves the DM's conversation/unread actions still work after the peer is deleted.
    await createMessage(dm.id, "agent", agent.id, "historical deleted-agent DM message");

    await deleteAgent(agent.id);

  const ownerToken = await tokenForHuman(owner.email);
    const unreadRes = await fetch(`${app.baseUrl}/api/channels/${dm.id}/unread`, {
      method: "POST",
      headers: authHeaders(ownerToken, server.id),
    });
    assert.equal(unreadRes.status, 200);
    assert.equal((await unreadRes.json() as { unreadCount: number }).unreadCount, 1);

    const readRes = await fetch(`${app.baseUrl}/api/channels/${dm.id}/read-all`, {
      method: "POST",
      headers: authHeaders(ownerToken, server.id),
    });
    assert.equal(readRes.status, 200);

    const orderRes = await fetch(`${app.baseUrl}/api/servers/${server.id}/sidebar-order`, {
      method: "PATCH",
      headers: {
        ...authHeaders(ownerToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        pinnedChannelIds: [dm.id],
        pinnedOrder: [dm.id],
        hiddenDmIds: [dm.id],
      }),
    });
    assert.equal(orderRes.status, 200);
    const order = await orderRes.json() as {
      pinnedChannelIds: string[];
      pinnedOrder: string[];
      hiddenDmIds: string[];
    };
    assert.deepEqual(order.pinnedChannelIds, [dm.id]);
    assert.deepEqual(order.pinnedOrder, [dm.id]);
    assert.deepEqual(order.hiddenDmIds, [dm.id]);
});

test("Antigravity permits existing-agent edits but rejects new agents and runtime transitions", async ({ app }) => {
  const owner = await seedUser("antigravity-existing@slock.test", "antigravity-existing");
  const server = await createServer("Antigravity Existing", "antigravity-existing", owner.id);
  const ownerToken = await tokenForHuman(owner.email);
  const existing = await createAgent(server.id, "existing-antigravity", { runtime: "antigravity", model: "default" });
  const other = await createAgent(server.id, "existing-codex", { runtime: "codex", model: "gpt-5" });
  const headers = { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" };

  for (const fields of [
    { runtime: "antigravity", model: "default" },
    { runtimeConfig: { version: 1, runtime: "antigravity", model: { kind: "preset", id: "default" } } },
  ]) {
    for (const request of [
      { method: "POST", url: `${app.baseUrl}/api/agents`, body: { name: "new-antigravity", ...fields } },
      { method: "PATCH", url: `${app.baseUrl}/api/agents/${other.id}`, body: fields },
    ]) {
      const response = await fetch(request.url, { method: request.method, headers, body: JSON.stringify(request.body) });
      assert.equal(response.status, 400);
      assert.equal((await response.json() as { error: string }).error, "Runtime is deprecated and cannot be selected: antigravity");
    }
    const edit = await fetch(`${app.baseUrl}/api/agents/${existing.id}`, {
      method: "PATCH", headers, body: JSON.stringify({ description: "still editable", ...fields }),
    });
    assert.equal(edit.status, 200);
    assert.equal((await edit.json() as { runtime: string }).runtime, "antigravity");
  }
  assert.equal((await getAgent(other.id))?.runtime, "codex");
});
