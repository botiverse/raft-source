import { handlerTraceEvents } from "../test/handlerTraceEvents";
import { PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY, type TrajectoryEntry } from "@botiverse/raft-shared";
import { tokenForHuman, fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";

import { createHmac, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import {
  BasicTracer,
  AGENT_MIGRATION_BUNDLE_CONTENT_TYPE,
  AGENT_MIGRATION_COMMIT_MARKER_PATH,
  AGENT_MIGRATION_CONTROL_SCHEMA_VERSION,
  AGENT_MIGRATION_CAPABILITY,
  AGENT_MIGRATION_SOURCE_DRAIN_CAPABILITY,
  AGENT_MIGRATION_MAX_ARCHIVE_ENTRIES,
  AGENT_MIGRATION_RESUMABLE_PROTOCOL,
  EXTERNAL_AGENT_RUNTIME_ID,
  EXTERNAL_AGENT_RUNTIME_MODEL,
  hydrateRuntimeConfig,
  KIMI_SDK_FORM_DEFINITION_REF,
  MemoryTraceSink,
  PRO_AGENT_SEAT_BLOCK_SIZE,
  type RuntimeConfig,
} from "@botiverse/raft-shared";
import { RouteFailureError } from "../tracing/routeFailure";
import { appendAgentActivityEvent, listRecentAgentTrajectory, upsertAgentTurnSummaries } from "../services/agentActivityLogService";
import { rewriteDaemonActivityEntries } from "../services/agentLifecycleReducer";
import { openTestApp } from "../test/integration/app";
import { createHangingStorageTestHarness } from "../test/hangingStorageTestHarness";
import { beginArrivingTestAgentMigration, beginTestAgentMigration } from "../test/agentMigrationFixture";
import { getDb } from "../db/index";
import { agentActivitySummaryV2, agentBootstrapTokens, agentConfigChangeEvents, agentMigrations, agents, featureFlagRules, featureFlags, inboxTargetMuteStates, jointChannels, jointChannelServers, machines, messages, users, serverMembers, servers, subscriptions, thirdPartyAgentEvents } from "../db/schema";
import { createOAuthClient } from "../services/oauthService";
import {
  AgentOrchestrator,
  KimiReasoningEffortUpgradeRequiredError,
} from "../services/agentOrchestrator";
import { addMember, createServer, getAgentMemberRole, getServer, updateServerOnboardingAgent, removeMember } from "../services/serverService";
import {
  createAgent,
  deleteAgent,
  getAgent,
  listAgents,
  updateAgent,
  updateAgentStatus,
} from "../services/agentService";
import { placeAgentOnMachine } from "../test/agentMachineFixture";
import { createMessage } from "../services/messageService";
import { addAgent, addHuman, createChannel, findOrCreateAgentDM, findOrCreateDM } from "../services/channelService";
import { issueAgentBootstrapToken, mintAgentCredential, recordAgentCredentialUse, revokeAgentCredential } from "../services/agentCredentialService";
import { MAX_PROFILE_AVATAR_BYTES, PROFILE_AVATAR_TOO_LARGE_MESSAGE } from "../services/avatarService";
import sharp from "sharp";
import {
  __setCdnStorageForTests,
  __setStorageForTests,
  resetStorageForTests,
  type StorageBackend,
} from "../services/storageService";
import * as agentMigrationService from "../services/agentMigrationService";
import { BuiltInModelCatalogError, assertBuiltInPresetSupportedByCatalog } from "../services/builtinModelCatalogCompatibility";
import { registerRuntimeFormV2EntryForTests } from "../services/runtimeFormV2Registry";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });



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

test("GET /agents/:id answers 404, not 500, for an id that is not a uuid (task #12)", async ({ app }) => {
  const owner = await seedUser("uuid-guard-owner@slock.test", "uuid-guard-owner");
  const server = await createServer("Uuid Guard Server", "uuid-guard-server", owner.id);
  const token = await tokenForHuman(owner.email);
  const res = await fetch(`${app.baseUrl}/api/agents/not-a-uuid`, {
    headers: authHeaders(token, server.id),
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "Agent not found" });
});

test("human members can restart and reset session but cannot stop or fully reset someone else's agent", async ({ app }) => {
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

    // Stopping an agent is an owner/admin's or its creator's (cindyz, 2026-10-29).
    const stop = await fetch(`${app.baseUrl}/api/agents/${agent.id}/stop`, {
      method: "POST",
      headers: authHeaders(memberToken, server.id),
    });
    assert.equal(stop.status, 403);
    assert.match((await stop.json() as { error: string }).error, /stopAgents/);

    for (const mode of ["restart", "session"] as const) {
      const reset = await fetch(`${app.baseUrl}/api/agents/${agent.id}/reset`, {
        method: "POST",
        headers: { ...authHeaders(memberToken, server.id), "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      assert.equal(reset.status, 202, mode);
    }

    const full = await fetch(`${app.baseUrl}/api/agents/${agent.id}/reset`, {
      method: "POST",
      headers: { ...authHeaders(memberToken, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "full" }),
    });
    assert.equal(full.status, 403);
    assert.match((await full.json() as { error: string }).error, /resetAgentWorkspace/);
});

test("reset acknowledges before the lifecycle command finishes", async ({ app }) => {
  const owner = await seedUser("reset-accepted-owner@slock.test", "reset-accepted-owner");
  const server = await createServer("Reset Accepted Server", "reset-accepted-server", owner.id);
  const agent = await createAgent(server.id, "reset-accepted-target", {
    runtime: "codex",
    creatorType: "user",
    creatorId: owner.id,
  });
  const ownerToken = await tokenForHuman(owner.email);

  let resetStarted = false;
  let releaseReset!: () => void;
  const resetFinished = new Promise<void>((resolve) => {
    releaseReset = resolve;
  });
  app.app.set("agentOrchestrator", {
    resetAgent: async () => {
      resetStarted = true;
      await resetFinished;
    },
  });

  const reset = await fetch(`${app.baseUrl}/api/agents/${agent.id}/reset`, {
    method: "POST",
    headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "restart" }),
  });

  assert.equal(reset.status, 202);
  assert.deepEqual(await reset.json(), { ok: true, status: "accepted" });
  assert.equal(resetStarted, true);

  releaseReset();
  await new Promise<void>((resolve) => setImmediate(resolve));
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
    // Create recorded the initial configuration; an env-only PATCH (runtime_config
    // changed, runtime/model/effort did not) adds nothing, and no secret is copied.
    const configEvents = await db.select().from(agentConfigChangeEvents).where(eq(agentConfigChangeEvents.agentId, created.id));
    assert.equal(configEvents.length, 1);
    assert.equal(configEvents[0].source, "agents_route_create");
    assert.equal(configEvents[0].actorKind, "user");
    assert.equal(configEvents[0].actorId, owner.id);
    assert.equal(configEvents[0].beforeModel, null);
    assert.equal(configEvents[0].afterRuntime, "claude");
    assert.equal(configEvents[0].afterModel, "claude-opus-4-6");
    assert.ok(!JSON.stringify(configEvents).includes("sk-ant-test"));

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

// xxchan (#proj-raft-computer:bbea62a0): env vars that can make the agent's
// computer run other code are refused when a save adds or changes them; an
// agent that already has one keeps saving its other settings.
test("agent settings refuse adding or changing PATH / NODE_OPTIONS, but keep an existing unchanged value", async ({ app }) => {
  const owner = await seedUser("risky-env-owner@slock.test", "risky-env-owner");
  const server = await createServer("Risky Env Server", "risky-env-server", owner.id);
  const token = await tokenForHuman(owner.email);
  const send = (method: string, path: string, body: unknown) => fetch(`${app.baseUrl}${path}`, {
    method,
    headers: { ...authHeaders(token, server.id), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const create = await send("POST", "/api/agents", { name: "risky-env-new", runtime: "codex", envVars: { NODE_OPTIONS: "--require /tmp/x.js", TEAM_FLAG: "1" } });
  assert.equal(create.status, 400);
  const createBody = await create.json() as { code?: string; names?: string[]; error?: string };
  assert.equal(createBody.code, "env_var_not_allowed");
  assert.deepEqual(createBody.names, ["NODE_OPTIONS"]);
  assert.doesNotMatch(createBody.error ?? "", /x\.js/);

  const existing = await createAgent(server.id, "risky-env-existing", { runtime: "codex", envVars: { PATH: "/opt/bin:/usr/bin", TEAM_FLAG: "1" } });
  // The same PATH, unchanged, beside an edit of another variable: saves.
  const keep = await send("PATCH", `/api/agents/${existing.id}`, { envVars: { PATH: "/opt/bin:/usr/bin", TEAM_FLAG: "2" } });
  assert.equal(keep.status, 200);
  // Changing PATH, or adding Path in another case, is refused.
  const change = await send("PATCH", `/api/agents/${existing.id}`, { envVars: { PATH: "/evil:/usr/bin", TEAM_FLAG: "2" } });
  assert.equal(change.status, 400);
  const changeBody = await change.json() as { names?: string[]; error?: string };
  assert.deepEqual(changeBody.names, ["PATH"]);
  assert.match(changeBody.error ?? "", /login shell/);
  const add = await send("PATCH", `/api/agents/${existing.id}`, { envVars: { PATH: "/opt/bin:/usr/bin", Ld_Preload: "/tmp/x.so" } });
  assert.equal(add.status, 400);
  assert.deepEqual((await add.json() as { names?: string[] }).names, ["Ld_Preload"]);
  // Removing it is always allowed.
  const remove = await send("PATCH", `/api/agents/${existing.id}`, { envVars: { TEAM_FLAG: "2" } });
  assert.equal(remove.status, 200);
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
    const refusal = await createRes.json() as { error: string; code?: string; capacityLimit?: Record<string, unknown> };
    assert.match(refusal.error, /Seat limit reached \(1\/1 on Pro plan\)/);
    // The code and the numbers, so the web can offer to add seats in place.
    assert.equal(refusal.code, "agent_limit_reached");
    assert.equal(refusal.capacityLimit?.limitType, "universal");
    assert.equal(refusal.capacityLimit?.limit, 1);
    assert.equal(refusal.capacityLimit?.usage, 1);
    assert.equal(refusal.capacityLimit?.nextUsage, 1.1);
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
    const configEvents = await getDb().select().from(agentConfigChangeEvents)
      .where(and(eq(agentConfigChangeEvents.agentId, agent.id), eq(agentConfigChangeEvents.source, "agents_route_update")));
    assert.equal(configEvents.length, 1);
    assert.equal(configEvents[0].actorKind, "user");
    assert.equal(configEvents[0].actorId, owner.id);
    assert.equal(configEvents[0].beforeModel, "gpt-5.5");
    assert.equal(configEvents[0].afterModel, "gpt-5.6-sol");
    assert.equal(configEvents[0].beforeRuntime, "codex");
    assert.equal(configEvents[0].afterRuntime, "codex");
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
      externalSetupMethod: null,
      lastActivityAt: null,
    });

    const credential = await mintAgentCredential({
      agentId: created.id,
      scopes: ["send"],
      name: "status-test",
      issuedVia: "human",
      createdByUserId: owner.id,
    });

    const mintedRes = await fetch(`${app.baseUrl}/api/agents/${created.id}/external-status`, {
      headers: authHeaders(ownerToken, server.id),
    });
    assert.equal(mintedRes.status, 200);
    assert.deepEqual(await mintedRes.json(), {
      setupState: "credential_minted",
      credentialLastUsedAt: null,
      externalSetupMethod: null,
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

test("external agent setup status: connected by any credential; disconnected once every used one is revoked; a login token that expired unused", async ({ app }) => {
  const owner = await seedUser("external-states-owner@slock.test", "external-states-owner");
  const server = await createServer("External States Server", "external-states-server", owner.id);
  const ownerToken = await tokenForHuman(owner.email);
  const create = async (name: string) => {
    const res = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ name, external: true }),
    });
    assert.equal(res.status, 200);
    return (await res.json() as { id: string }).id;
  };
  const stateOf = async (agentId: string) => {
    const res = await fetch(`${app.baseUrl}/api/agents/${agentId}/external-status`, { headers: authHeaders(ownerToken, server.id) });
    assert.equal(res.status, 200);
    return (await res.json() as { setupState: string }).setupState;
  };

  // The CLI login's credential is used; a new one made on the agent page isn't yet: still connected.
  const agentId = await create("external-states-agent");
  const cli = await mintAgentCredential({ agentId, scopes: ["send"], name: null, issuedVia: "human", createdByUserId: owner.id });
  await recordAgentCredentialUse({ credentialId: cli.credentialId, ip: null, userAgent: null });
  const page = await mintAgentCredential({ agentId, scopes: ["send"], name: "page", issuedVia: "human", createdByUserId: owner.id });
  assert.equal(await stateOf(agentId), "connected");
  // Both revoked: it had connected, so disconnected (not "waiting"), until a new one is made.
  for (const credentialId of [cli.credentialId, page.credentialId]) await revokeAgentCredential({ credentialId, agentId, reason: "test" });
  assert.equal(await stateOf(agentId), "disconnected");
  await mintAgentCredential({ agentId, scopes: ["send"], name: "page", issuedVia: "human", createdByUserId: owner.id });
  assert.equal(await stateOf(agentId), "credential_minted");

  // Never connected: a login token waiting is still waiting; once it expired unused, login_token_expired.
  const fresh = await create("external-states-fresh");
  vi.stubEnv("AGENT_BOOTSTRAP_TOKEN_PEPPER", "external-states-test-pepper-0123456789abcdef");
  try {
    await issueAgentBootstrapToken({ agentId: fresh, serverId: server.id, issuedByUserId: owner.id, scopes: ["send"] });
  } finally {
    vi.unstubAllEnvs();
  }
  assert.equal(await stateOf(fresh), "waiting_for_login");
  await getDb().update(agentBootstrapTokens).set({ ttlExpiresAt: new Date(Date.now() - 1000) }).where(eq(agentBootstrapTokens.targetAgentId, fresh));
  assert.equal(await stateOf(fresh), "login_token_expired");
});

test("external agent setup method: set by its manager, existing_agent or sdk only, external agents only", async ({ app }) => {
  const owner = await seedUser("external-method-owner@slock.test", "external-method-owner");
  const other = await seedUser("external-method-other@slock.test", "external-method-other");
  const server = await createServer("External Method Server", "external-method-server", owner.id);
  await addMember(server.id, other.id, "member");
  const ownerToken = await tokenForHuman(owner.email);
  const otherToken = await tokenForHuman(other.email);
  const createRes = await fetch(`${app.baseUrl}/api/agents`, {
    method: "POST",
    headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
    body: JSON.stringify({ name: "external-method-agent", external: true }),
  });
  const { id } = await createRes.json() as { id: string };
  const put = (token: string, agentId: string, method: unknown) => fetch(`${app.baseUrl}/api/agents/${agentId}/external-setup-method`, {
    method: "PUT",
    headers: { ...authHeaders(token, server.id), "Content-Type": "application/json" },
    body: JSON.stringify({ method }),
  });
  assert.equal((await put(ownerToken, id, "sdk")).status, 200);
  const status = await fetch(`${app.baseUrl}/api/agents/${id}/external-status`, { headers: authHeaders(ownerToken, server.id) });
  assert.equal((await status.json() as { externalSetupMethod: string }).externalSetupMethod, "sdk");
  assert.equal((await put(ownerToken, id, "cloud")).status, 400);
  assert.equal((await put(otherToken, id, "existing_agent")).status, 403);
  const managed = await createAgent(server.id, "external-method-managed", { runtime: "codex" });
  assert.equal((await put(ownerToken, managed.id, "sdk")).status, 400);
  // Another server's agent: the one not-found, as for an unknown id.
  const elsewhere = await createServer("External Method Elsewhere", "external-method-elsewhere", other.id);
  const theirs = await createAgent(elsewhere.id, "external-method-theirs", { runtime: "codex" });
  assert.equal((await put(ownerToken, theirs.id, "sdk")).status, 404);
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

test("an agent profile edit tells the server's other open clients to re-read the agent", async ({ app }) => {
    const owner = await seedUser("agent-updated-push-owner@slock.test", "agent-updated-push-owner");
    const server = await createServer("Agent Updated Push Server", "agent-updated-push-server", owner.id);
    const agent = await createAgent(server.id, "agent-updated-push", { runtime: "codex" });
  const ownerToken = await tokenForHuman(owner.email);
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
    const updatedPushes = () => emitted.filter((entry) => entry.event === "agent:updated");
    const stored: string[] = [];
    const storage: StorageBackend = {
      async put(key) { stored.push(key); },
      async get() { throw new Error("not read in this test"); },
      async delete() {},
    };

  try {
    __setStorageForTests(storage);
    __setCdnStorageForTests(storage);

    const patchRes = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ avatarUrl: "pixel:mug" }),
    });
    assert.equal(patchRes.status, 200);
    assert.deepEqual(updatedPushes(), [
      { room: `server:${server.id}`, event: "agent:updated", payload: { agentId: agent.id } },
    ]);

    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 220, g: 30, b: 30 } } }).png().toBuffer();
    const formData = new FormData();
    formData.set("avatar", new Blob([new Uint8Array(png)], { type: "image/png" }), "red.png");
    const uploadRes = await fetch(`${app.baseUrl}/api/agents/${agent.id}/avatar`, {
      method: "POST",
      headers: authHeaders(ownerToken, server.id),
      body: formData,
    });
    assert.equal(uploadRes.status, 200);
    const uploaded = await uploadRes.json() as { avatarUrl: string | null };
    assert.equal(stored.length, 1);
    assert.ok(uploaded.avatarUrl?.endsWith(".webp"));
    assert.deepEqual(updatedPushes(), [
      { room: `server:${server.id}`, event: "agent:updated", payload: { agentId: agent.id } },
      { room: `server:${server.id}`, event: "agent:updated", payload: { agentId: agent.id } },
    ]);
  } finally {
    await app.close();
    resetStorageForTests();
  }
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

test("GET /api/avatars answers 404 for a stored avatar that is missing, 500 for other storage errors", async ({ app }) => {
  const url = `${app.baseUrl}/api/avatars/users/0123456789abcdef0123456789abcdef.webp`;
  const failingWith = (error: Error): StorageBackend => ({
    async put() {},
    async get() { throw error; },
    async delete() {},
  });
  const noSuchKey = Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" });
  try {
    // The test app's own local storage has no such file.
    const local = await fetch(url);
    assert.equal(local.status, 404);
    assert.equal((await local.json() as { code: string }).code, "avatar_not_found");
    assert.notEqual(local.headers.get("cache-control"), "public, max-age=31536000, immutable");

    __setCdnStorageForTests(failingWith(noSuchKey));
    const s3 = await fetch(url);
    assert.equal(s3.status, 404, "an S3 NoSuchKey");
    assert.equal((await s3.json() as { code: string }).code, "avatar_not_found");

    __setCdnStorageForTests(failingWith(new Error("connect ECONNREFUSED")));
    const broken = await fetch(url);
    assert.equal(broken.status, 500, "a storage outage is not a missing avatar");
    assert.equal((await broken.json() as { error: string }).error, "Failed to serve avatar");
  } finally {
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

    // An admin may demote an admin agent back to member (#triage:#290): an
    // agent is not a peer admin, and a promotion must be undoable by whoever
    // could make it. A member still may not.
    const memberDemoteDenied = await fetch(`${app.baseUrl}/api/agents/${adminManagedAgent.id}`, {
      method: "PATCH",
      headers: {
        ...authHeaders(memberToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ serverRole: "member" }),
    });
    assert.equal(memberDemoteDenied.status, 403);
    assert.equal(await getAgentMemberRole(server.id, adminManagedAgent.id), "admin");
    const adminDemote = await fetch(`${app.baseUrl}/api/agents/${adminManagedAgent.id}`, {
      method: "PATCH",
      headers: {
        ...authHeaders(adminToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ serverRole: "member" }),
    });
    assert.equal(adminDemote.status, 200);
    assert.equal((await adminDemote.json() as { serverRole: string | null }).serverRole, "member");
    assert.equal(await getAgentMemberRole(server.id, adminManagedAgent.id), "member");

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

    // Each real role change tells the agent in its DM with the human who made it;
    // refused and no-op requests post nothing.
    const ownerDm = await findOrCreateDM(server.id, owner.id, ownerManagedAgent.id);
    assert.ok(ownerDm);
    const roleNotices = await db
      .select({ content: messages.content, subtype: messages.systemSubtype })
      .from(messages)
      .where(and(eq(messages.channelId, ownerDm.id), eq(messages.messageType, "system")))
      .orderBy(messages.seq);
    assert.equal(roleNotices.length, 2);
    assert.match(roleNotices[0]!.content, /changed @owner-managed-agent-role's server role from member to admin\.$/);
    assert.match(roleNotices[1]!.content, /changed @owner-managed-agent-role's server role from admin to member\.$/);
    assert.ok(roleNotices.every((notice) => notice.subtype === "agent.server_role_changed"));
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
        return { delivered: true };
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

// The write paths share one helper, but a shared helper is not evidence that each route's
// own downstream write actually completes (@Huaihuai). These cover create, the model change and
// migrate, asserting what was PERSISTED rather than just the status.
const catalogMissingRuntimeConfig = (modelId: string) => ({
  version: 1 as const,
  runtime: "builtin" as const,
  provider: {
    kind: "preset" as const,
    providerId: "openai" as const,
    apiKey: "secret",
  },
  model: { kind: "preset" as const, id: modelId },
  mode: { kind: "default" as const },
  hostUserState: "forbidden" as const,
});

const stubCatalogMissing = (app: { app: { get: (k: string) => unknown } }, modelId: string) => {
  const counter = { calls: 0 };
  Object.assign(app.app.get("agentOrchestrator") as object, {
    hasMachineLocally: () => true,
    validateBuiltInPresetForMachine: async () => {
      counter.calls += 1;
      throw new BuiltInModelCatalogError(
        "builtin_model_unsupported_by_target",
        "The selected model is not supported by the target Computer. Upgrade the Computer or explicitly choose a supported model.",
        {
          requestedModel: modelId,
          daemonVersion: "1.0.23",
          computerVersion: "1.0.23",
          catalogRuntimeVersion: "0.84.3",
          recovery: "upgrade_or_reselect",
        },
      );
    },
    acquireBuiltInCatalogAuthority: () => () => undefined,
  });
  return counter;
};

test("Built-in preset create persists the agent when the target catalog does not list the model (task #322)", async ({ app }) => {
    const owner = await seedUser(
      "builtin-create-owner@slock.test",
      "builtin-create-owner",
    );
    const server = await createServer(
      "Built-in Create",
      "builtin-create",
      owner.id,
    );
    const [machine] = await getDb()
      .insert(machines)
      .values({
        serverId: server.id,
        userId: owner.id,
        name: "builtin-create-machine",
        apiKeyHash: "unused-builtin-create-machine-hash",
        runtimes: ["builtin"],
      })
      .returning();
    const counter = stubCatalogMissing(app, "openai/gpt-5.4");
    const token = await tokenForHuman(owner.email);
    const res = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(token, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "builtin-create-agent",
        machineId: machine.id,
        formDefinitionRef: {
          protocolVersion: 1,
          runtimeId: "builtin",
          schemaVersion: "builtin-pi.create.v3",
        },
        runtimeConfig: catalogMissingRuntimeConfig("openai/gpt-5.4"),
      }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    // The write itself must have completed, not merely returned 200.
    const created = (await res.json()) as { id: string };
    const persisted = await getAgent(created.id);
    assert.equal(persisted?.machineId, machine.id);
    assert.equal(persisted?.model, "openai/gpt-5.4");
    assert.equal(counter.calls, 1);
});

test("Built-in preset model change persists when the target catalog does not list the new model (task #322)", async ({ app }) => {
    const owner = await seedUser(
      "builtin-modelchange-owner@slock.test",
      "builtin-modelchange-owner",
    );
    const server = await createServer(
      "Built-in Model Change",
      "builtin-modelchange",
      owner.id,
    );
    const [machine] = await getDb()
      .insert(machines)
      .values({
        serverId: server.id,
        userId: owner.id,
        name: "builtin-modelchange-machine",
        apiKeyHash: "unused-builtin-modelchange-machine-hash",
        runtimes: ["builtin"],
      })
      .returning();
    const agent = await createAgent(server.id, "builtin-modelchange-agent", {
      runtime: "builtin",
      model: "openai/gpt-5.3",
      runtimeConfig: catalogMissingRuntimeConfig("openai/gpt-5.3"),
    });
    await placeAgentOnMachine(agent.id, machine.id);
    // Stub AFTER the setup assignment so the counter only sees the PATCH.
    const counter = stubCatalogMissing(app, "openai/gpt-5.4");
    const token = await tokenForHuman(owner.email);
    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: {
        ...authHeaders(token, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        runtime: "builtin",
        model: "openai/gpt-5.4",
        runtimeConfig: catalogMissingRuntimeConfig("openai/gpt-5.4"),
      }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    const updated = await getAgent(agent.id);
    assert.equal(updated?.model, "openai/gpt-5.4");
    assert.equal(updated?.machineId, machine.id);
    // The preset selection really changed, so the catalog path was entered rather than skipped
    // by builtInPresetSelectionChanged returning false.
    assert.equal(counter.calls, 1);
});

test("Built-in preset migrate enqueues the migration when the target catalog does not list the model (task #322)", async ({ app }) => {
    const db = getDb();
    const owner = await seedUser(
      "builtin-migrate-owner@slock.test",
      "builtin-migrate-owner",
    );
    const server = await createServer(
      "Built-in Migrate",
      "builtin-migrate",
      owner.id,
    );
    const now = new Date();
    const [sourceMachine] = await db.insert(machines).values({
      id: randomUUID(),
      serverId: server.id,
      userId: owner.id,
      name: "builtin-migrate-source",
      apiKeyHash: "builtin-migrate-source-hash",
      runtimes: ["builtin"],
      daemonVersion: "0.72.7",
      lastHeartbeat: now,
    }).returning();
    const [targetMachine] = await db.insert(machines).values({
      id: randomUUID(),
      serverId: server.id,
      userId: owner.id,
      name: "builtin-migrate-target",
      apiKeyHash: "builtin-migrate-target-hash",
      runtimes: ["builtin"],
      daemonVersion: "0.72.7",
      lastHeartbeat: now,
    }).returning();
    const agent = await createAgent(server.id, "builtin-migrate-agent", {
      runtime: "builtin",
      model: "openai/gpt-5.4",
      runtimeConfig: catalogMissingRuntimeConfig("openai/gpt-5.4"),
    });
    await placeAgentOnMachine(agent.id, sourceMachine.id);
    await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));

    const originalOrchestrator = app.app.get("agentOrchestrator");
    let catalogCalls = 0;
    app.app.set("agentOrchestrator", {
      ...originalOrchestrator,
      hasMachineLocally: () => true,
      getMachineStatus: async () => "online",
      getMachineDaemonVersion: () => "0.72.7",
      getMachineMigrationTransport: async () => ({ capabilities: [AGENT_MIGRATION_CAPABILITY] }),
      sendAgentMigrationTransportLease: async () => undefined,
      validateBuiltInPresetForMachine: async () => {
        catalogCalls += 1;
        throw new BuiltInModelCatalogError(
          "builtin_model_unsupported_by_target",
          "The selected model is not supported by the target Computer. Upgrade the Computer or explicitly choose a supported model.",
          {
            requestedModel: "openai/gpt-5.4",
            daemonVersion: "0.72.7",
            computerVersion: "0.72.7",
            catalogRuntimeVersion: "0.84.3",
            recovery: "upgrade_or_reselect",
          },
        );
      },
      acquireBuiltInCatalogAuthority: () => () => undefined,
    });
    app.app.set("agentMigrationObjectStoreTransferProvisioner", async () => ({
      provider: "object_store" as const,
      sessionId: "builtin-migrate-session",
      leaseMs: 60 * 60 * 1000,
      maxBytes: 123_456,
    }));

    const token = await tokenForHuman(owner.email);
    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migrate`, {
      method: "POST",
      headers: {
        ...authHeaders(token, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ targetComputer: targetMachine.id }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    // The downstream write must actually have happened: a migration grant row exists.
    const rows = await db
      .select()
      .from(agentMigrations)
      .where(eq(agentMigrations.agentId, agent.id));
    assert.equal(rows.length, 1, "catalog-missing must not stop the migration grant");
    assert.equal(
      rows[0]!.transportMaxArchiveEntries,
      AGENT_MIGRATION_MAX_ARCHIVE_ENTRIES,
      "every migration records the single entry limit",
    );
    assert.equal(catalogCalls, 1);
});

// Reconciler step 14 (Q-H): a source that advertises
// AGENT_MIGRATION_SOURCE_DRAIN_CAPABILITY waits for its agent to be quiet
// before it stops it; the migration gets that wait's prep window and the
// source lease says so. A source without it gets neither (as before). RED
// proof: drop `sourceDrainsBeforeStop` in the route and the draining source
// gets a 10 min prep window and no `sourceDrainUntil`.
test("POST /api/agents/:id/migrate gives a draining source the wait's prep window and sourceDrainUntil; another source neither", async ({ app }) => {
    const db = getDb();
    const owner = await seedUser("drain-migrate-owner@slock.test", "drain-migrate-owner");
    const server = await createServer("Drain Migrate", "drain-migrate", owner.id);
    await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
    const now = new Date();
    const machine = async (name: string) => (await db.insert(machines).values({
      id: randomUUID(),
      serverId: server.id,
      userId: owner.id,
      name,
      apiKeyHash: `${name}-hash`,
      runtimes: ["codex"],
      daemonVersion: "0.72.7",
      lastHeartbeat: now,
    }).returning())[0]!;
    const drainingSource = await machine("drain-source");
    const plainSource = await machine("plain-source");
    const target = await machine("drain-target");
    const capabilities = new Map<string, string[]>([
      [drainingSource.id, [AGENT_MIGRATION_CAPABILITY, AGENT_MIGRATION_SOURCE_DRAIN_CAPABILITY]],
      [plainSource.id, [AGENT_MIGRATION_CAPABILITY]],
      [target.id, [AGENT_MIGRATION_CAPABILITY]],
    ]);
    const sentLeases: Array<{ machineId: string; message: { role: string; sourceDrainUntil?: string } }> = [];
    const originalOrchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
    app.app.set("agentOrchestrator", {
      ...originalOrchestrator,
      getMachineStatus: async () => "online",
      getMachineMigrationTransport: async (machineId: string) => ({ capabilities: capabilities.get(machineId) ?? [] }),
      getMachineRuntimeDetection: async () => null,
      sendAgentMigrationTransportLease: async (machineId: string, message: { role: string; sourceDrainUntil?: string }) => {
        sentLeases.push({ machineId, message });
      },
    });
    app.app.set("agentMigrationObjectStoreTransferProvisioner", async () => ({
      provider: "object_store" as const,
      sessionId: `drain-session-${randomUUID()}`,
      leaseMs: 60 * 60 * 1000,
      maxBytes: 123_456,
    }));
    const token = await tokenForHuman(owner.email);
    const migrate = async (sourceMachineId: string, name: string) => {
      const agent = await createAgent(server.id, name, { runtime: "codex", machineId: sourceMachineId });
      const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migrate`, {
        method: "POST",
        headers: { ...authHeaders(token, server.id), "Content-Type": "application/json" },
        body: JSON.stringify({ targetComputer: target.id }),
      });
      assert.equal(res.status, 200, await res.clone().text());
      const [row] = await db.select().from(agentMigrations).where(eq(agentMigrations.agentId, agent.id));
      const sourceLease = sentLeases.find((lease) => lease.machineId === sourceMachineId && lease.message.role === "source");
      assert.ok(row && sourceLease);
      return { prepWindowMs: row.prepDeadlineAt.getTime() - row.createdAt.getTime(), row, sourceLease };
    };

    const draining = await migrate(drainingSource.id, "drain-migrate-agent");
    assert.equal(draining.prepWindowMs, 20 * 60 * 1000, "the ordinary 10 min plus the wait's 10 min");
    assert.equal(draining.sourceLease.message.sourceDrainUntil, new Date(draining.row.createdAt.getTime() + 10 * 60 * 1000).toISOString());

    const plain = await migrate(plainSource.id, "plain-migrate-agent");
    assert.equal(plain.prepWindowMs, 10 * 60 * 1000);
    assert.equal(plain.sourceLease.message.sourceDrainUntil, undefined, "an older source stops at once, as before");

    // The owner status the web reads carries the same deadline while the
    // source waits, and null once it quiesced or for a source without the wait.
    const ownerStatus = async (agentId: string) => {
      const res = await fetch(`${app.baseUrl}/api/agents/${agentId}/migration`, { headers: authHeaders(token, server.id) });
      assert.equal(res.status, 200, await res.clone().text());
      return (await res.json() as { migration: { sourceDrainUntil?: string | null; sourceDrain?: unknown; sourceBuildProgress?: unknown } }).migration;
    };
    assert.equal((await ownerStatus(draining.row.agentId)).sourceDrainUntil, draining.sourceLease.message.sourceDrainUntil);
    assert.equal((await ownerStatus(plain.row.agentId)).sourceDrainUntil, null);
    // task #62: the source's drain report reaches the owner as `sourceDrain`,
    // never as `sourceBuildProgress`.
    assert.equal((await ownerStatus(draining.row.agentId)).sourceDrain, null, "no drain report yet");
    const drainRecord = { phase: "draining" as const, drainUntil: draining.sourceLease.message.sourceDrainUntil!, waitingFor: "turn" as const, reportedAt: new Date().toISOString() };
    await db.update(agentMigrations).set({ sourceBuildProgress: drainRecord }).where(eq(agentMigrations.id, draining.row.id));
    const whileDraining = await ownerStatus(draining.row.agentId);
    assert.deepEqual(whileDraining.sourceDrain, { until: drainRecord.drainUntil, waitingFor: "turn", reportedAt: drainRecord.reportedAt });
    assert.equal(whileDraining.sourceBuildProgress, null);
    await db.update(agentMigrations).set({ sourceQuiescedAt: new Date() }).where(eq(agentMigrations.id, draining.row.id));
    assert.equal((await ownerStatus(draining.row.agentId)).sourceDrainUntil, null, "no wait once the source quiesced");
    assert.equal((await ownerStatus(draining.row.agentId)).sourceDrain, null, "no drain once the source quiesced");
});

// Scope controls for the SAVE routes. task #322 demoted only builtin_model_unsupported_by_target;
// builtin_catalog_unavailable means the catalog could not be READ (unknown, not known-absent) and
// must still reject. The user-facing copy that PR #8065 ships describes exactly these two routes,
// so these tests back the behaviour it promises. These pass before and after task #322; they go red only if the demotion is ever
// widened to catch BuiltInModelCatalogError as a class.
const stubCatalogUnavailable = (app: { app: { get: (k: string) => unknown } }, modelId: string) => {
  const counter = { calls: 0 };
  Object.assign(app.app.get("agentOrchestrator") as object, {
    hasMachineLocally: () => true,
    validateBuiltInPresetForMachine: async () => {
      counter.calls += 1;
      throw new BuiltInModelCatalogError(
        "builtin_catalog_unavailable",
        "The target Computer's Built-in model catalog is unavailable. Retry after the Computer reconnects.",
        {
          requestedModel: modelId,
          daemonVersion: "1.0.23",
          computerVersion: "1.0.23",
          recovery: "retry",
        },
      );
    },
    acquireBuiltInCatalogAuthority: () => () => undefined,
  });
  return counter;
};

test("Built-in preset create still rejects when the target catalog cannot be read (task #322 scope control)", async ({ app }) => {
    const db = getDb();
    const owner = await seedUser(
      "builtin-create-unavail-owner@slock.test",
      "builtin-create-unavail-owner",
    );
    const server = await createServer(
      "Built-in Create Unavailable",
      "builtin-create-unavail",
      owner.id,
    );
    const [machine] = await db
      .insert(machines)
      .values({
        serverId: server.id,
        userId: owner.id,
        name: "builtin-create-unavail-machine",
        apiKeyHash: "unused-builtin-create-unavail-machine-hash",
        runtimes: ["builtin"],
      })
      .returning();
    const before = (
      await db.select().from(agents).where(eq(agents.serverId, server.id))
    ).length;
    const counter = stubCatalogUnavailable(app, "openai/gpt-5.4");
    const token = await tokenForHuman(owner.email);
    const res = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(token, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "builtin-create-unavail-agent",
        machineId: machine.id,
        formDefinitionRef: {
          protocolVersion: 1,
          runtimeId: "builtin",
          schemaVersion: "builtin-pi.create.v3",
        },
        runtimeConfig: catalogMissingRuntimeConfig("openai/gpt-5.4"),
      }),
    });
    assert.notEqual(res.status, 200, await res.clone().text());
    assert.equal(
      ((await res.json()) as { code: string }).code,
      "builtin_catalog_unavailable",
    );
    // Nothing may have been written: the rejection happens before agent creation.
    const after = (
      await db.select().from(agents).where(eq(agents.serverId, server.id))
    ).length;
    assert.equal(after, before, "an unreadable catalog must not create an agent");
    assert.equal(counter.calls, 1);
});

test("Built-in preset model change still rejects when the target catalog cannot be read (task #322 scope control)", async ({ app }) => {
    const owner = await seedUser(
      "builtin-patch-unavail-owner@slock.test",
      "builtin-patch-unavail-owner",
    );
    const server = await createServer(
      "Built-in Patch Unavailable",
      "builtin-patch-unavail",
      owner.id,
    );
    const [machine] = await getDb()
      .insert(machines)
      .values({
        serverId: server.id,
        userId: owner.id,
        name: "builtin-patch-unavail-machine",
        apiKeyHash: "unused-builtin-patch-unavail-machine-hash",
        runtimes: ["builtin"],
      })
      .returning();
    const agent = await createAgent(server.id, "builtin-patch-unavail-agent", {
      runtime: "builtin",
      model: "openai/gpt-5.3",
      runtimeConfig: catalogMissingRuntimeConfig("openai/gpt-5.3"),
    });
    await placeAgentOnMachine(agent.id, machine.id);
    const counter = stubCatalogUnavailable(app, "openai/gpt-5.4");
    const token = await tokenForHuman(owner.email);
    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: {
        ...authHeaders(token, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        runtime: "builtin",
        model: "openai/gpt-5.4",
        runtimeConfig: catalogMissingRuntimeConfig("openai/gpt-5.4"),
      }),
    });
    assert.notEqual(res.status, 200, await res.clone().text());
    assert.equal(
      ((await res.json()) as { code: string }).code,
      "builtin_catalog_unavailable",
    );
    // The stored selection must be untouched, not merely the response non-200.
    assert.equal((await getAgent(agent.id))?.model, "openai/gpt-5.3");
    assert.equal(counter.calls, 1);
});

// task #10: a typed OpenRouter model goes through the same catalog check as a
// preset one. A Computer whose catalog does not advertise OpenRouter in
// customModelProviderIds (an older one, whose parser would refuse the config
// at start) gets a 409 builtin_custom_model_upgrade_required on create and on
// a model change, and nothing is written. The stub runs the real catalog check.
const typedOpenRouterRuntimeConfig = (name: string) => ({
  version: 1 as const,
  runtime: "builtin" as const,
  provider: { kind: "preset" as const, providerId: "openrouter" as const, apiKey: "secret" },
  model: { kind: "custom" as const, name },
  mode: { kind: "default" as const },
  hostUserState: "forbidden" as const,
});

const stubCatalogWithoutCustomModels = (app: { app: { get: (k: string) => unknown } }) => {
  const counter = { calls: 0 };
  Object.assign(app.app.get("agentOrchestrator") as object, {
    hasMachineLocally: () => true,
    validateBuiltInPresetForMachine: async (machineId: string, config: Parameters<typeof assertBuiltInPresetSupportedByCatalog>[0]) => {
      counter.calls += 1;
      const validation = assertBuiltInPresetSupportedByCatalog(
        config,
        {
          kind: "live",
          value: {
            models: [{ id: "openrouter/moonshotai/kimi-k2.6", label: "Kimi" }],
            catalog: { protocolVersion: 1, runtime: "builtin", runtimeVersion: "1.5.0" },
          },
        },
        { machineId, daemonVersion: "1.0.67", computerVersion: "1.0.67" },
      );
      return validation ? { ...validation, authority: { connectionEpochId: "e", replicaGeneration: "g" } } : null;
    },
    acquireBuiltInCatalogAuthority: () => () => undefined,
  });
  return counter;
};

test("a typed OpenRouter model is refused on create and on a model change when the Computer cannot run one (task #10)", async ({ app }) => {
    const db = getDb();
    const owner = await seedUser("builtin-or-custom-owner@slock.test", "builtin-or-custom-owner");
    const server = await createServer("Built-in OpenRouter Custom", "builtin-or-custom", owner.id);
    const [machine] = await db
      .insert(machines)
      .values({
        serverId: server.id,
        userId: owner.id,
        name: "builtin-or-custom-machine",
        apiKeyHash: "unused-builtin-or-custom-machine-hash",
        runtimes: ["builtin"],
      })
      .returning();
    const before = (await db.select().from(agents).where(eq(agents.serverId, server.id))).length;
    const counter = stubCatalogWithoutCustomModels(app);
    const token = await tokenForHuman(owner.email);
    const create = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: { ...authHeaders(token, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "builtin-or-custom-agent",
        machineId: machine.id,
        formDefinitionRef: { protocolVersion: 1, runtimeId: "builtin", schemaVersion: "builtin-pi.create.v3" },
        runtimeConfig: typedOpenRouterRuntimeConfig("vendor/unlisted-2099"),
      }),
    });
    assert.equal(create.status, 409, await create.clone().text());
    assert.equal(((await create.json()) as { code: string }).code, "builtin_custom_model_upgrade_required");
    assert.equal((await db.select().from(agents).where(eq(agents.serverId, server.id))).length, before, "nothing created");

    const agent = await createAgent(server.id, "builtin-or-custom-existing", {
      runtime: "builtin",
      model: "openrouter/moonshotai/kimi-k2.6",
      runtimeConfig: { ...typedOpenRouterRuntimeConfig("unused"), model: { kind: "preset", id: "openrouter/moonshotai/kimi-k2.6" } },
    });
    await placeAgentOnMachine(agent.id, machine.id);
    const patch = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: { ...authHeaders(token, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({
        runtime: "builtin",
        model: "vendor/unlisted-2099",
        runtimeConfig: typedOpenRouterRuntimeConfig("vendor/unlisted-2099"),
      }),
    });
    assert.equal(patch.status, 409, await patch.clone().text());
    assert.equal(((await patch.json()) as { code: string }).code, "builtin_custom_model_upgrade_required");
    assert.equal((await getAgent(agent.id))?.model, "openrouter/moonshotai/kimi-k2.6", "the stored selection is untouched");
    assert.equal(counter.calls, 2);
});

// Huaihuai's review of #13950: a LISTED OpenRouter model with an explicit
// limit is saved as a custom model (its OpenRouter id), so the same gate
// applies: an older Computer gets 409 builtin_custom_model_upgrade_required on
// create, on edit and on migrate, and nothing is written.
test("a listed OpenRouter model with a limit is refused on create, edit and migrate when the Computer cannot run one (task #10)", async ({ app }) => {
    const db = getDb();
    const owner = await seedUser("builtin-or-listed-owner@slock.test", "builtin-or-listed-owner");
    const server = await createServer("Built-in OpenRouter Listed", "builtin-or-listed", owner.id);
    const now = new Date();
    const [sourceMachine] = await db.insert(machines).values({
      id: randomUUID(),
      serverId: server.id,
      userId: owner.id,
      name: "builtin-or-listed-source",
      apiKeyHash: "builtin-or-listed-source-hash",
      runtimes: ["builtin"],
      daemonVersion: "0.72.7",
      lastHeartbeat: now,
    }).returning();
    const [targetMachine] = await db.insert(machines).values({
      id: randomUUID(),
      serverId: server.id,
      userId: owner.id,
      name: "builtin-or-listed-target",
      apiKeyHash: "builtin-or-listed-target-hash",
      runtimes: ["builtin"],
      daemonVersion: "0.72.7",
      lastHeartbeat: now,
    }).returning();
    const listedWithLimit = { ...typedOpenRouterRuntimeConfig("openrouter/moonshotai/kimi-k2.6"), model: { kind: "custom" as const, name: "openrouter/moonshotai/kimi-k2.6", contextWindow: 131_072 } };
    const before = (await db.select().from(agents).where(eq(agents.serverId, server.id))).length;
    const counter = stubCatalogWithoutCustomModels(app);
    const token = await tokenForHuman(owner.email);
    const create = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: { ...authHeaders(token, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "builtin-or-listed-agent",
        machineId: targetMachine.id,
        formDefinitionRef: { protocolVersion: 1, runtimeId: "builtin", schemaVersion: "builtin-pi.create.v3" },
        runtimeConfig: listedWithLimit,
      }),
    });
    assert.equal(create.status, 409, await create.clone().text());
    assert.equal(((await create.json()) as { code: string }).code, "builtin_custom_model_upgrade_required");
    assert.equal((await db.select().from(agents).where(eq(agents.serverId, server.id))).length, before, "nothing created");

    // An existing agent on the listed preset: adding a limit is refused.
    const listedPreset = { ...typedOpenRouterRuntimeConfig("unused"), model: { kind: "preset" as const, id: "openrouter/moonshotai/kimi-k2.6" } };
    const agent = await createAgent(server.id, "builtin-or-listed-existing", {
      runtime: "builtin",
      model: "openrouter/moonshotai/kimi-k2.6",
      runtimeConfig: listedPreset,
    });
    await placeAgentOnMachine(agent.id, sourceMachine.id);
    const patch = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: { ...authHeaders(token, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ runtime: "builtin", model: "moonshotai/kimi-k2.6", runtimeConfig: listedWithLimit }),
    });
    assert.equal(patch.status, 409, await patch.clone().text());
    assert.equal(((await patch.json()) as { code: string }).code, "builtin_custom_model_upgrade_required");
    assert.deepEqual((await getAgent(agent.id))?.runtimeConfig?.model, listedPreset.model, "the stored selection is untouched");

    // An agent already saved this way (on a Computer that runs it) cannot move to an older one.
    const overridden = await createAgent(server.id, "builtin-or-listed-overridden", {
      runtime: "builtin",
      model: "moonshotai/kimi-k2.6",
      runtimeConfig: { ...listedWithLimit, model: { kind: "custom", name: "moonshotai/kimi-k2.6", contextWindow: 131_072 } },
    });
    await placeAgentOnMachine(overridden.id, sourceMachine.id);
    await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
    Object.assign(app.app.get("agentOrchestrator") as object, {
      getMachineStatus: async () => "online",
      getMachineDaemonVersion: () => "0.72.7",
      getMachineMigrationTransport: async () => ({ capabilities: [AGENT_MIGRATION_CAPABILITY] }),
      sendAgentMigrationTransportLease: async () => undefined,
    });
    app.app.set("agentMigrationObjectStoreTransferProvisioner", async () => ({
      provider: "object_store" as const,
      sessionId: "builtin-or-listed-session",
      leaseMs: 60 * 60 * 1000,
      maxBytes: 123_456,
    }));
    const migrate = await fetch(`${app.baseUrl}/api/agents/${overridden.id}/migrate`, {
      method: "POST",
      headers: { ...authHeaders(token, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ targetComputer: targetMachine.id }),
    });
    assert.equal(migrate.status, 409, await migrate.clone().text());
    assert.equal(((await migrate.json()) as { code: string }).code, "builtin_custom_model_upgrade_required");
    assert.equal((await db.select().from(agentMigrations).where(eq(agentMigrations.agentId, overridden.id))).length, 0, "no migration granted");
    assert.equal(counter.calls, 3);
});

// task #10: the v2 edit form and save for a client WITHOUT
// dependent_select.custom_value_with_options (a shipped app). Its limit fields
// show only where a stored limit would otherwise be lost; its save keeps what
// a newer client stored, and a change of model or provider is refused.
test("v2 edit for an old client: stored limits stay visible and survive, a provider change is refused (task #10)", async ({ app }) => {
    const owner = await seedUser("builtin-or-oldclient-owner@slock.test", "builtin-or-oldclient-owner");
    const server = await createServer("Built-in OpenRouter Old Client", "builtin-or-oldclient", owner.id);
    const [machine] = await getDb().insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "builtin-or-oldclient-machine",
      apiKeyHash: "unused-builtin-or-oldclient-machine-hash",
      runtimes: ["builtin"],
    }).returning();
    const token = await tokenForHuman(owner.email);
    const withLimits = await createAgent(server.id, "builtin-or-oldclient-limits", {
      runtime: "builtin",
      model: "moonshotai/kimi-k2.6",
      runtimeConfig: { ...typedOpenRouterRuntimeConfig("moonshotai/kimi-k2.6"), model: { kind: "custom", name: "moonshotai/kimi-k2.6", contextWindow: 131_072 } },
    });
    const preset = await createAgent(server.id, "builtin-or-oldclient-preset", {
      runtime: "builtin",
      model: "openrouter/moonshotai/kimi-k2.6",
      runtimeConfig: { ...typedOpenRouterRuntimeConfig("unused"), model: { kind: "preset", id: "openrouter/moonshotai/kimi-k2.6" } },
    });
    for (const agent of [withLimits, preset]) await placeAgentOnMachine(agent.id, machine.id);
    const limitRule = async (agentId: string) => {
      const res = await fetch(`${app.baseUrl}/api/agents/${agentId}/runtime-form`, { headers: authHeaders(token, server.id) });
      assert.equal(res.status, 200, await res.clone().text());
      const body = await res.json() as { values: Record<string, unknown>; uiSchema: { visibility: Array<{ pointer: string; when: { in: string[] } }> } };
      return { values: body.values, in: body.uiSchema.visibility.find((rule) => rule.pointer === "/contextWindow")?.when.in ?? [] };
    };
    const stored = await limitRule(withLimits.id);
    assert.ok(stored.in.includes("openrouter"), "a stored limit keeps its field visible");
    assert.equal(stored.values.model, "openrouter/moonshotai/kimi-k2.6");
    assert.equal(stored.values.contextWindow, "131072");
    assert.equal((await limitRule(preset.id)).in.includes("openrouter"), false, "nothing stored: hidden");

    const patch = (formValues: Record<string, unknown>) => fetch(`${app.baseUrl}/api/agents/${withLimits.id}`, {
      method: "PATCH",
      headers: { ...authHeaders(token, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ formDefinitionRef: { protocolVersion: 2, runtimeId: "builtin" }, formValues }),
    });
    const switched = await patch({ providerId: "deepseek", apiKey: "sk-ds", model: "deepseek/deepseek-v4-pro" });
    assert.equal(switched.status, 409, await switched.clone().text());
    assert.equal(((await switched.json()) as { code: string }).code, "runtime_form_client_upgrade_required");
    assert.deepEqual((await getAgent(withLimits.id))?.runtimeConfig?.model, { kind: "custom", name: "moonshotai/kimi-k2.6", contextWindow: 131_072 }, "untouched");
});

// task #10: the old-client success path through the real route. A PATCH
// without clientCapabilities that leaves the model alone (omitted where its
// field was hidden, unchanged where it was shown) and changes another field
// keeps the stored custom model, its limits and the stored API key.
test("v2 edit save from an old client keeps a newer client's typed OpenRouter id / listed override, limits and key (task #10)", async ({ app }) => {
    const owner = await seedUser("builtin-or-oldsave-owner@slock.test", "builtin-or-oldsave-owner");
    const server = await createServer("Built-in OpenRouter Old Save", "builtin-or-oldsave", owner.id);
    const [machine] = await getDb().insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "builtin-or-oldsave-machine",
      apiKeyHash: "unused-builtin-or-oldsave-machine-hash",
      runtimes: ["builtin"],
    }).returning();
    stubCatalogWithoutCustomModels(app);
    const token = await tokenForHuman(owner.email);
    const cases = [
      {
        name: "builtin-or-oldsave-typed",
        model: { kind: "custom" as const, name: "vendor/unlisted-2099", contextWindow: 4096 },
        // The old client's Model field was hidden: left out of the save.
        formValues: { providerId: "openrouter", contextWindow: "4096", reasoningEffort: "high" },
      },
      {
        name: "builtin-or-oldsave-listed",
        model: { kind: "custom" as const, name: "moonshotai/kimi-k2.6", contextWindow: 131_072, maxOutputTokens: 16_384 },
        // Shown as the listed model with its limits, sent back unchanged.
        formValues: { providerId: "openrouter", model: "openrouter/moonshotai/kimi-k2.6", contextWindow: "131072", maxOutputTokens: "16384", reasoningEffort: "high" },
      },
    ];
    for (const entry of cases) {
      const agent = await createAgent(server.id, entry.name, {
        runtime: "builtin",
        model: entry.model.name,
        runtimeConfig: { ...typedOpenRouterRuntimeConfig(entry.model.name), provider: { kind: "preset", providerId: "openrouter", apiKey: "sk-or-stored-key" }, model: entry.model },
      });
      await placeAgentOnMachine(agent.id, machine.id);
      const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
        method: "PATCH",
        headers: { ...authHeaders(token, server.id), "Content-Type": "application/json" },
        body: JSON.stringify({ formDefinitionRef: { protocolVersion: 2, runtimeId: "builtin" }, formValues: entry.formValues }),
      });
      assert.equal(res.status, 200, `${entry.name}: ${await res.clone().text()}`);
      const saved = (await getAgent(agent.id))?.runtimeConfig;
      assert.deepEqual(saved?.model, entry.model, `${entry.name}: model and limits unchanged`);
      assert.deepEqual(saved?.provider, { kind: "preset", providerId: "openrouter", apiKey: "sk-or-stored-key" }, `${entry.name}: provider and key retained`);
      assert.equal(saved?.reasoningEffort, "high", `${entry.name}: the other field changed`);
    }
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
    const transportLookups: string[] = [];
    const resumableTransport = { capabilities: [AGENT_MIGRATION_CAPABILITY] };
    const migrationTransports = new Map<string, { capabilities: string[] | null } | null>([
      [sourceMachine.id, resumableTransport],
      [targetMachine.id, resumableTransport],
      [otherServerRunner.id, resumableTransport],
      [oldTargetMachine.id, null],
      [runtimeMissingTargetMachine.id, resumableTransport],
      [offlineTargetMachine.id, resumableTransport],
    ]);
    const runtimeDetections = new Map<string, { status: "pending" | "complete" | "incomplete"; reason?: "deadline" | "child_failed" | "cancelled"; unfinishedRuntimes?: string[]; updatedAtMs: number }>();
    let provisionerFails = true;
    let provisionerCalls = 0;
    let removedWorkspacePreflightCalls = 0;
    app.app.set("agentOrchestrator", {
      ...originalOrchestrator,
      getMachineStatus: async (machineId: string) => machineId === offlineTargetMachine.id ? "offline" : "online",
      getMachineMigrationTransport: async (machineId: string) => {
        transportLookups.push(machineId);
        return migrationTransports.get(machineId) ?? null;
      },
      // task #1268: the target's runtime detection state (pending / incomplete) gates the migration.
      getMachineRuntimeDetection: async (machineId: string) => runtimeDetections.get(machineId) ?? null,
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
        leaseMs: 60 * 60 * 1000,
        maxBytes: 123_456,
      };
    });

    const memberDenied = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migrate`, {
      method: "POST",
      headers: { ...authHeaders(memberToken, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ targetComputer: targetMachine.id }),
    });
    assert.equal(memberDenied.status, 403);
    assert.equal((await memberDenied.json() as { code?: string }).code, "not_supported");

    const postMigrate = (targetComputer: string) => fetch(`${app.baseUrl}/api/agents/${agent.id}/migrate`, {
      method: "POST",
      headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
      body: JSON.stringify({ targetComputer }),
    });
    const assertNoMigrationSideEffects = async (label: string) => {
      assert.equal(removedWorkspacePreflightCalls, 0, `${label} must not invoke removed workspace preflight`);
      assert.equal(provisionerCalls, 0, `${label} must fail before transport provisioning`);
      assert.equal(sentLeases.length, 0, `${label} must fail before lease dispatch`);
      assert.equal(
        (await db.select().from(agentMigrations).where(eq(agentMigrations.agentId, agent.id))).length,
        0,
        `${label} must not create migration state`,
      );
    };

    // Old daemons do not advertise migration/v3: refused up front with the upgrade error.
    migrationTransports.set(sourceMachine.id, { capabilities: ["migration:chunk-upload-v1", "migration:streaming-bundle-v1"] });
    const oldSource = await postMigrate(targetMachine.id);
    assert.equal(oldSource.status, 422);
    assert.deepEqual(await oldSource.json(), {
      error: "Both source and target computers must run a Raft Computer that supports migration/v3; upgrade the source computer",
      code: "MIGRATION_RESUMABLE_CAPABILITY_REQUIRED",
      details: {
        side: "source",
        reason: "capability_missing",
        failureReason: "MIGRATION_RESUMABLE_CAPABILITY_REQUIRED",
      },
    });
    assert.deepEqual(
      transportLookups,
      [sourceMachine.id, targetMachine.id],
      "capability admission must read the exact source and target server-runner machine ids",
    );
    await assertNoMigrationSideEffects("old source daemon");

    const bothOld = await postMigrate(oldTargetMachine.id);
    assert.equal(bothOld.status, 422);
    assert.deepEqual((await bothOld.json() as { details?: unknown }).details, {
      side: "both",
      reason: "capability_missing",
      failureReason: "MIGRATION_RESUMABLE_CAPABILITY_REQUIRED",
    });
    migrationTransports.set(sourceMachine.id, resumableTransport);

    const oldTarget = await postMigrate(oldTargetMachine.id);
    assert.equal(oldTarget.status, 422);
    assert.deepEqual((await oldTarget.json() as { details?: unknown }).details, {
      side: "target",
      reason: "capability_missing",
      failureReason: "MIGRATION_RESUMABLE_CAPABILITY_REQUIRED",
    });
    await assertNoMigrationSideEffects("old target daemon");

    const targetRuntimeMissing = await postMigrate(runtimeMissingTargetMachine.id);
    assert.equal(targetRuntimeMissing.status, 422);
    assert.deepEqual(await targetRuntimeMissing.json(), {
      error: "Both source and target computers must support the agent's runtime",
      code: "COMPUTER_CAPABILITY_INSUFFICIENT",
      details: {
        failureReason: "COMPUTER_CAPABILITY_INSUFFICIENT",
        failures: [{ side: "target", reason: "runtime_missing", runtime: "codex" }],
      },
    });

    await db.update(machines).set({ runtimes: ["claude"] }).where(eq(machines.id, sourceMachine.id));
    const sourceRuntimeMissing = await postMigrate(targetMachine.id);
    assert.equal(sourceRuntimeMissing.status, 422);
    assert.deepEqual((await sourceRuntimeMissing.json() as { details?: unknown }).details, {
      failureReason: "COMPUTER_CAPABILITY_INSUFFICIENT",
      failures: [{ side: "source", reason: "runtime_missing", runtime: "codex" }],
    });

    await db.update(machines).set({ runtimes: null }).where(eq(machines.id, sourceMachine.id));
    const unconfirmedSourceRuntime = await postMigrate(targetMachine.id);
    assert.equal(unconfirmedSourceRuntime.status, 422);
    assert.deepEqual((await unconfirmedSourceRuntime.json() as { details?: unknown }).details, {
      failureReason: "COMPUTER_CAPABILITY_INSUFFICIENT",
      failures: [{ side: "source", reason: "runtime_unconfirmed", runtime: "codex" }],
    });
    await db.update(machines).set({ runtimes: ["codex"] }).where(eq(machines.id, sourceMachine.id));
    await assertNoMigrationSideEffects("runtime mismatch");

    const offline = await postMigrate(offlineTargetMachine.id);
    assert.equal(offline.status, 409);
    assert.deepEqual(await offline.json(), {
      error: "Target computer is not online",
      code: "TARGET_COMPUTER_OFFLINE",
      details: { failureReason: "TARGET_COMPUTER_OFFLINE" },
    });

    // task #1268 (archer): a target still detecting, or whose last round never
    // probed this runtime, is refused with a retryable 409; a finished round
    // that did probe it is not. The source side is never gated by detection.
    runtimeDetections.set(targetMachine.id, { status: "pending", updatedAtMs: 1 });
    const targetPending = await postMigrate(targetMachine.id);
    assert.equal(targetPending.status, 409);
    assert.deepEqual(await targetPending.json(), {
      error: "The target computer is still detecting its runtimes; try again in a moment",
      code: "TARGET_RUNTIME_DETECTION_PENDING",
      details: { failureReason: "TARGET_RUNTIME_DETECTION_PENDING", side: "target", runtime: "codex", detectionStatus: "pending", retryable: true },
    });
    runtimeDetections.set(targetMachine.id, { status: "incomplete", reason: "deadline", unfinishedRuntimes: ["codex"], updatedAtMs: 2 });
    const targetIncomplete = await postMigrate(targetMachine.id);
    assert.equal(targetIncomplete.status, 409);
    assert.deepEqual((await targetIncomplete.json() as { details?: unknown }).details, {
      failureReason: "TARGET_RUNTIME_DETECTION_PENDING", side: "target", runtime: "codex", detectionStatus: "incomplete", reason: "deadline", retryable: true,
    });
    runtimeDetections.set(targetMachine.id, { status: "incomplete", reason: "deadline", unfinishedRuntimes: ["grok"], updatedAtMs: 3 });
    runtimeDetections.set(sourceMachine.id, { status: "pending", updatedAtMs: 4 });
    const targetProbed = await postMigrate(targetMachine.id);
    assert.notEqual(targetProbed.status, 409, "an incomplete round that did probe codex, and a pending source, do not gate");
    runtimeDetections.clear();
    await assertNoMigrationSideEffects("target runtime detection pending");

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
    assert.equal(rows[0]!.sourceTransportUrl, null, "no whole-bundle URL is presigned");
    assert.equal(rows[0]!.targetTransportUrl, null, "no whole-bundle URL is presigned");
    assert.equal(rows[0]!.transportLeaseSource, "server");
    assert.equal(rows[0]!.transportMaxBytes, 123_456);
    assert.equal(rows[0]!.transportMaxArchiveEntries, AGENT_MIGRATION_MAX_ARCHIVE_ENTRIES);
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
        capability: { required: [AGENT_MIGRATION_CAPABILITY] },
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
    assert.deepEqual(startedStatusBody.migration?.initiatedBy, { id: owner.id, name: owner.name, displayName: owner.displayName ?? null });
    assert.equal(startedStatusBody.migration?.transportErrorCode, null);
    assert.equal("transferSummary" in (startedStatusBody.migration ?? {}), false);
    assert.equal("grantKey" in (startedStatusBody.migration ?? {}), false);
    assert.equal("transportControlManifest" in (startedStatusBody.migration ?? {}), false);
    assert.equal("sourceTransportUrl" in (startedStatusBody.migration ?? {}), false);
    assert.equal("targetTransportUrl" in (startedStatusBody.migration ?? {}), false);
    assert.equal("sourceTransportTokenHash" in (startedStatusBody.migration ?? {}), false);
    assert.equal("targetTransportTokenHash" in (startedStatusBody.migration ?? {}), false);
    await db.update(servers).set({ plan: "free" }).where(eq(servers.id, server.id));
    await agentMigrationService.markAgentMigrationTransportLostForComputer({
      migrationId: internalMigrationId,
      serverId: server.id,
      machineId: sourceMachine.id,
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

    // Someone who has since left the server is not named.
    await db.update(agentMigrations).set({ initiatedByUserId: member.id }).where(eq(agentMigrations.id, internalMigrationId));
    await db.delete(serverMembers).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, member.id)));
    const leftStatus = await fetch(`${app.baseUrl}/api/agents/${agent.id}/migration`, {
      headers: authHeaders(ownerToken, server.id),
    });
    assert.equal(leftStatus.status, 200, await leftStatus.clone().text());
    assert.equal((await leftStatus.json() as { migration: { initiatedBy?: unknown } | null }).migration?.initiatedBy, null);
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
    const migration = await beginArrivingTestAgentMigration({
      agentId: agent.id,
      targetMachineId: targetMachine!.id,
      initiatedByUserId: owner.id,
      now,
    }, {
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
    });
    const archived = await agentMigrationService.recordAgentMigrationSourceWorkspaceArchived({
      migrationId: migration.id,
      migrationGeneration: agentMigrationService.agentMigrationGeneration(migration),
      serverId: server.id,
      targetMachineId: targetMachine!.id,
      now,
    });
    const arrival = await agentMigrationService.markAgentMigrationTargetImportArrived({
      migrationId: migration.id,
      migrationGeneration: archived.migrationGeneration,
      serverId: server.id,
      targetMachineId: targetMachine!.id,
      now,
    });
    assert.equal(arrival.migration.state, "starting");
    await agentMigrationService.recordAgentMigrationAutoStartFailure({
      migrationId: migration.id,
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
    const skippedMigration = await beginArrivingTestAgentMigration({
      agentId: skippedAgent.id,
      targetMachineId: targetMachine!.id,
      initiatedByUserId: owner.id,
      now,
    }, {
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
    });
    const skippedArchived = await agentMigrationService.recordAgentMigrationSourceWorkspaceArchived({
      migrationId: skippedMigration.id,
      migrationGeneration: agentMigrationService.agentMigrationGeneration(skippedMigration),
      serverId: server.id,
      targetMachineId: targetMachine!.id,
      now,
    });
    await agentMigrationService.markAgentMigrationTargetImportArrived({
      migrationId: skippedMigration.id,
      migrationGeneration: skippedArchived.migrationGeneration,
      serverId: server.id,
      targetMachineId: targetMachine!.id,
      now,
    });
    await agentMigrationService.recordAgentMigrationAutoStartFailure({
      migrationId: skippedMigration.id,
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
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
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

test("the owner's Stop tells the daemon owner_stop and delete tells it deleted (raft proc step 2)", async ({ app }) => {
    const owner = await seedUser("stop-reason-owner@slock.test", "stop-reason-owner");
    const server = await createServer("Stop Reason Server", "stop-reason-server", owner.id);
    const agent = await createAgent(server.id, "stop-reason-agent", { runtime: "codex" });
    const ownerToken = await tokenForHuman(owner.email);

    const stops: unknown[][] = [];
    const originalOrchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
    app.app.set("agentOrchestrator", {
      ...originalOrchestrator,
      stopAgent: async (...args: unknown[]) => {
        stops.push(args);
        return { delivered: true };
      },
      evictCache: () => {},
    });
    try {
      const stop = await fetch(`${app.baseUrl}/api/agents/${agent.id}/stop`, {
        method: "POST",
        headers: authHeaders(ownerToken, server.id),
      });
      assert.equal(stop.status, 200, await stop.clone().text());
      const del = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
        method: "DELETE",
        headers: authHeaders(ownerToken, server.id),
      });
      assert.equal(del.status, 200, await del.clone().text());
    } finally {
      app.app.set("agentOrchestrator", originalOrchestrator);
    }

    assert.deepEqual(stops, [
      [agent.id, "manual", { daemonReason: "owner_stop" }],
      [agent.id, "internal", { daemonReason: "deleted" }],
    ]);
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
    assert.deepEqual(resetCall, { agentId: agent.id, mode: "session", options: { restartIfStopped: false, terminalControl: "runtime_config_changed" } });
});

test("PATCH /agents/:id codex model switch without restartMode clears the stored session; other edits and runtimes keep it", async ({ app }) => {
  // #proj-raft-computer:#48: the session clear used to ride on restartMode, and
  // the web sends none for a stopped agent, so its next start resumed the old
  // Codex thread on the old model.
  const owner = await seedUser("codex-model-no-restart@slock.test", "codex-model-no-restart");
  const server = await createServer("Codex Model No Restart", "codex-model-no-restart", owner.id);
  const token = await tokenForHuman(owner.email);
  const headers = { ...authHeaders(token, server.id), "Content-Type": "application/json" };
  const patch = (agentId: string, body: Record<string, unknown>) =>
    fetch(`${app.baseUrl}/api/agents/${agentId}`, { method: "PATCH", headers, body: JSON.stringify(body) });

  const codex = await createAgent(server.id, "codex-no-restart-agent", { runtime: "codex", model: "gpt-5.3-codex" });
  await updateAgentStatus(codex.id, "inactive", "codex-session-id");
  const described = await patch(codex.id, { description: "only the description" });
  assert.equal(described.status, 200, await described.clone().text());
  assert.equal((await getAgent(codex.id))?.sessionId, "codex-session-id", "a description edit keeps the session");

  const switched = await patch(codex.id, { model: "gpt-5.6-sol" });
  assert.equal(switched.status, 200, await switched.clone().text());
  const after = await getAgent(codex.id);
  assert.equal(after?.model, "gpt-5.6-sol");
  assert.equal(after?.sessionId, null, "a Codex model switch clears the session without restartMode");

  const claude = await createAgent(server.id, "claude-no-restart-agent", { runtime: "claude", model: "sonnet" });
  await updateAgentStatus(claude.id, "inactive", "claude-session-id");
  const claudeSwitched = await patch(claude.id, { model: "opus" });
  assert.equal(claudeSwitched.status, 200, await claudeSwitched.clone().text());
  assert.equal((await getAgent(claude.id))?.sessionId, "claude-session-id", "other runtimes keep their session");
});

test("PATCH /agents/:id: a Pi agent saved again with its stored off is not a runtime change (#9775)", async ({ app }) => {
  // off lives in runtimeConfig only, never in the legacy column, so the change
  // check must compare against runtimeConfig; otherwise every save counts as a
  // runtime change (lifting the failure breaker, queueing a profile migration).
  const owner = await seedUser("pi-off-unchanged@slock.test", "pi-off-unchanged");
  const server = await createServer("Pi Off Unchanged", "pi-off-unchanged", owner.id);
  const token = await tokenForHuman(owner.email);
  const agent = await createAgent(server.id, "pi-off-agent", { runtime: "pi", model: "default" });
  const headers = { ...authHeaders(token, server.id), "Content-Type": "application/json" };
  const resets: Array<{ terminalControl?: unknown }> = [];
  const originalOrchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
  app.app.set("agentOrchestrator", {
    ...originalOrchestrator,
    evictCache: () => {},
    resetAgent: async (_agentId: string, _mode: string, options?: { terminalControl?: unknown }) => {
      resets.push({ terminalControl: options?.terminalControl });
    },
  });
  const patch = (body: Record<string, unknown>) => fetch(`${app.baseUrl}/api/agents/${agent.id}`, { method: "PATCH", headers, body: JSON.stringify(body) });

  const first = await patch({ reasoningEffort: "off", restartMode: "restart" });
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal(((await getAgent(agent.id))?.runtimeConfig as { reasoningEffort?: unknown } | null)?.reasoningEffort, "off");
  assert.equal(resets[0]?.terminalControl, "runtime_config_changed", "setting off is a runtime change");

  const again = await patch({ reasoningEffort: "off", restartMode: "restart" });
  assert.equal(again.status, 200, await again.clone().text());
  assert.equal(resets.length, 2);
  assert.equal(resets[1]?.terminalControl, undefined, "the same off again is not");
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
    assert.deepEqual(resetCall, { agentId: agent.id, mode: "restart", options: { restartIfStopped: false, terminalControl: "runtime_config_changed" } });
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
      schemaVersion: "builtin-pi.create.v3",
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

    // Protocol v2 submits field values, never a client-built runtimeConfig.
    const protocolRes = await create({
      name: "schema-protocol-agent",
      formDefinitionRef: { protocolVersion: 2, runtimeId: "builtin" },
      runtimeConfig: presetConfig,
    });
    assert.equal(protocolRes.status, 400);
    assert.deepEqual((await protocolRes.json() as { issues: unknown }).issues, [
      { code: "form_values_required", pointer: "/formValues" },
    ]);
    const v2Res = await create({
      name: "schema-v2-form-values-agent",
      machineId: machine.id,
      formDefinitionRef: { protocolVersion: 2, runtimeId: "builtin" },
      formValues: { providerId: "openai", apiKey: "v2-secret-key", model: "openai/gpt-5.4", unrenderedByClient: true },
    });
    assert.equal(v2Res.status, 200, await v2Res.clone().text());
    const v2Body = await v2Res.json() as { id: string; runtimeConfig: { provider: { apiKey: string }; model: unknown } };
    assert.equal(v2Body.runtimeConfig.provider.apiKey, "");
    assert.deepEqual(v2Body.runtimeConfig.model, { kind: "preset", id: "openai/gpt-5.4" });
    const v2Stored = await getAgent(v2Body.id);
    assert.equal((v2Stored?.runtimeConfig as { provider?: { apiKey?: string } } | null)?.provider?.apiKey, "v2-secret-key");

    // Edit is the same form with the agent's current values; writeOnly fields are never read back.
    const formRes = await fetch(`${app.baseUrl}/api/agents/${v2Body.id}/runtime-form`, { headers });
    assert.equal(formRes.status, 200);
    const form = await formRes.json() as { protocolVersion: number; values: Record<string, unknown> };
    assert.equal(form.protocolVersion, 2);
    assert.equal(form.values.providerId, "openai");
    assert.equal(form.values.model, "openai/gpt-5.4");
    assert.equal("apiKey" in form.values, false);
    assert.equal(JSON.stringify(form).includes("v2-secret-key"), false);
    // A blank writeOnly field on edit keeps the stored secret.
    const v2EditRes = await fetch(`${app.baseUrl}/api/agents/${v2Body.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        formDefinitionRef: { protocolVersion: 2, runtimeId: "builtin" },
        formValues: { ...form.values, apiKey: "", envVars: { V2_EDIT: "1" } },
      }),
    });
    assert.equal(v2EditRes.status, 200, await v2EditRes.clone().text());
    const v2Edited = await getAgent(v2Body.id);
    assert.equal((v2Edited?.runtimeConfig as { provider?: { apiKey?: string } } | null)?.provider?.apiKey, "v2-secret-key");
    assert.deepEqual((v2Edited?.runtimeConfig as { envVars?: unknown } | null)?.envVars, { V2_EDIT: "1" });
    // Changing provider with a blank secret is refused, pointed at the field.
    const v2SwitchRes = await fetch(`${app.baseUrl}/api/agents/${v2Body.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        formDefinitionRef: { protocolVersion: 2, runtimeId: "builtin" },
        formValues: { ...form.values, providerId: "deepseek", model: "deepseek/deepseek-chat", apiKey: "" },
      }),
    });
    assert.equal(v2SwitchRes.status, 400, await v2SwitchRes.clone().text());
    const v2SwitchBody = await v2SwitchRes.json() as { issues?: Array<{ pointer: string }> };
    for (const issue of v2SwitchBody.issues ?? []) assert.match(issue.pointer, /^\/formValues/);

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

test("Grok is admitted for new use without a feature flag; computer capability still gates it", async ({ app }) => {
  const owner = await seedUser("grok-runtime-owner@slock.test", "grok-runtime-owner");
  const server = await createServer("Grok Runtime Server", "grok-runtime-server", owner.id);
  const ownerToken = await tokenForHuman(owner.email);
  const [machine] = await getDb().insert(machines).values({
    serverId: server.id,
    userId: owner.id,
    name: "grok-runtime-machine",
    apiKeyHash: "unused-grok-runtime-machine-hash",
    runtimes: ["codex", "grok"],
  }).returning();
  const codexAgent = await createAgent(server.id, "grok-candidate-codex-agent", {
    runtime: "codex",
    model: "gpt-5",
    machineId: machine.id,
  });
  // A leftover rule from the retired grok_runtime_v0 rollout is ignored.
  await getDb().insert(featureFlagRules).values({
    id: randomUUID(),
    flagKey: "grok_runtime_v0",
    stage: "server",
    priority: 0,
    decision: "deny",
    values: [server.id],
  });

  const optionsRes = await fetch(`${app.baseUrl}/api/agents/${codexAgent.id}/runtime-options`, {
    headers: { ...authHeaders(ownerToken, server.id), "X-Raft-Runtime-Form-V2": "1" },
  });
  assert.equal(optionsRes.status, 200);
  const options = (await optionsRes.json() as { options: Array<Record<string, unknown>> }).options;
  assert.deepEqual(options.find((option) => option.runtimeId === "grok"), {
    runtimeId: "grok",
    capabilityStatus: "available",
    admissionStatus: "available_for_new",
    admissionReason: null,
    current: false,
    availableForNew: true,
    manageableForCurrentAgent: false,
    canSelectInThisContext: true,
    runtimeFormV2: { protocolVersion: 2 },
  });

  const transitionRes = await fetch(`${app.baseUrl}/api/agents/${codexAgent.id}`, {
    method: "PATCH",
    headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
    body: JSON.stringify({ runtime: "grok", model: "grok-4.5" }),
  });
  assert.equal(transitionRes.status, 200);
  assert.equal((await getAgent(codexAgent.id))?.runtime, "grok");

  await getDb().update(machines).set({ runtimes: ["codex"] }).where(eq(machines.id, machine.id));
  const unavailableCreateRes = await fetch(`${app.baseUrl}/api/agents`, {
    method: "POST",
    headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
    body: JSON.stringify({ name: "unavailable-grok-agent", runtime: "grok", model: "grok-4.5", machineId: machine.id }),
  });
  assert.equal(unavailableCreateRes.status, 409);
  assert.deepEqual(await unavailableCreateRes.json(), {
    error: "Grok Build is not available on this computer",
    code: "runtime_capability_unavailable",
  });
  assert.equal((await listAgents(server.id)).some((agent) => agent.name === "unavailable-grok-agent"), false);

  await getDb().update(machines).set({ runtimes: ["codex", "grok"] }).where(eq(machines.id, machine.id));
  const createRes = await fetch(`${app.baseUrl}/api/agents`, {
    method: "POST",
    headers: { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" },
    body: JSON.stringify({ name: "new-grok-agent", runtime: "grok", model: "grok-4.5", machineId: machine.id }),
  });
  assert.equal(createRes.status, 200);
  assert.equal((await createRes.json() as { runtime: string }).runtime, "grok");
});

test("an OAR-only runtime (Qwen Code) needs only a Computer that reports it, no server flag", async ({ app }) => {
  const owner = await seedUser("qwen-runtime-owner@slock.test", "qwen-runtime-owner");
  const server = await createServer("Qwen Runtime Server", "qwen-runtime-server", owner.id);
  const ownerToken = await tokenForHuman(owner.email);
  const headers = { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" };
  const [machine] = await getDb().insert(machines).values({
    serverId: server.id,
    userId: owner.id,
    name: "qwen-runtime-machine",
    apiKeyHash: "unused-qwen-runtime-machine-hash",
    runtimes: ["codex", "qwen"],
  }).returning();
  const codexAgent = await createAgent(server.id, "qwen-candidate-codex-agent", { runtime: "codex", model: "gpt-5", machineId: machine.id });
  const create = (name: string) => fetch(`${app.baseUrl}/api/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name, runtime: "qwen", model: "qwen3-coder-plus", machineId: machine.id }),
  });

  // No server flag: offered as soon as the Computer reports it.
  const options = await fetch(`${app.baseUrl}/api/agents/${codexAgent.id}/runtime-options`, { headers: authHeaders(ownerToken, server.id) });
  assert.equal((await options.json() as { options: Array<{ runtimeId: string }> }).options.some((option) => option.runtimeId === "qwen"), true);

  // A Computer that does not report it: refused with the way out.
  await getDb().update(machines).set({ runtimes: ["codex"] }).where(eq(machines.id, machine.id));
  const unreported = await create("qwen-unreported-agent");
  assert.equal(unreported.status, 409);
  assert.deepEqual(await unreported.json(), {
    error: "Qwen Code is not available on this computer: install its CLI there, and update the Computer if it does not list Qwen Code yet",
    code: "runtime_capability_unavailable",
  });

  await getDb().update(machines).set({ runtimes: ["codex", "qwen"] }).where(eq(machines.id, machine.id));
  const created = await create("qwen-agent");
  assert.equal(created.status, 200);
  assert.equal((await created.json() as { runtime: string }).runtime, "qwen");
  const switched = await fetch(`${app.baseUrl}/api/agents/${codexAgent.id}`, { method: "PATCH", headers, body: JSON.stringify({ runtime: "qwen", model: "qwen3-coder-plus" }) });
  assert.equal(switched.status, 200);
  assert.equal((await getAgent(codexAgent.id))?.runtime, "qwen");
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

    const updatedPushes: Array<{ room: string; payload: unknown }> = [];
    const originalTo = app.io.to.bind(app.io);
    (app.io as any).to = (room: string | string[]) => {
      const operator = originalTo(room as any) as any;
      const originalEmit = operator.emit.bind(operator);
      operator.emit = (event: string, ...args: unknown[]) => {
        if (event === "agent:updated") updatedPushes.push({ room: String(room), payload: args[0] });
        return originalEmit(event, ...args);
      };
      return operator;
    };

    const adoptRes = await fetch(`${app.baseUrl}/api/agents/${customized.id}/onboarding-identity-adoption`, {
      method: "POST",
      headers: authHeaders(ownerToken, server.id),
    });
    assert.equal(adoptRes.status, 200);
    // Adoption rewrote the name, avatar and description: other open clients are told to re-read.
    assert.deepEqual(updatedPushes, [{ room: `server:${server.id}`, payload: { agentId: customized.id } }]);
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
    assert.equal(updatedPushes.length, 1, "a second adoption changes nothing, so it pushes nothing");
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
    const reasoningUnsupportedRuntimes = ["kimi", "cursor", "gemini", "opencode"];

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

test("POST /api/agents refuses a creator whose removal commits after the request-level check, creating nothing (task #93 line G)", async ({ app }) => {
    const owner = await seedUser("create-fence-route-owner@slock.test", "create-fence-route-owner");
    const admin = await seedUser("create-fence-route-admin@slock.test", "create-fence-route-admin");
    const server = await createServer("Create Fence Route", "create-fence-route", owner.id);
    await getDb().insert(serverMembers).values({ serverId: server.id, userId: admin.id, role: "admin" });
  const adminToken = await tokenForHuman(admin.email);
    const [builtInMachine] = await getDb()
      .insert(machines)
      .values({
        serverId: server.id,
        userId: owner.id,
        name: "create-fence-route-machine",
        apiKeyHash: "unused-create-fence-route-machine-hash",
        runtimes: ["builtin"],
      })
      .returning();
    let validationCalls = 0;
    Object.assign(app.app.get("agentOrchestrator"), {
      hasMachineLocally: () => true,
      // Seam between the request-level `createAgents` check and the create transaction: the owner removes the admin.
      validateBuiltInPresetForMachine: async () => {
        validationCalls += 1;
        await removeMember(server.id, admin.id, { reason: "removed", actorUserId: owner.id });
        return { authority: { connectionEpochId: "epoch-create-fence", replicaGeneration: "generation-create-fence" } };
      },
      acquireBuiltInCatalogAuthority: () => () => undefined,
    });

    const res = await fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers: {
        ...authHeaders(adminToken, server.id),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "create-fence-route-agent",
        machineId: builtInMachine.id,
        formDefinitionRef: { protocolVersion: 1, runtimeId: "builtin", schemaVersion: "builtin-pi.create.v3" },
        runtimeConfig: {
          version: 1,
          runtime: "builtin",
          provider: { kind: "preset", providerId: "openai", apiKey: "sk-openai-create-fence" },
          model: { kind: "preset", id: "openai/gpt-5.4" },
          mode: { kind: "default" },
        },
      }),
    });
    assert.equal(validationCalls, 1, "the request reached the seam after the request-level check");
    assert.equal(res.status, 403, await res.clone().text());
    assert.equal(((await res.json()) as { error: string }).error, "Not a member of this server");
    const created = await getDb().select({ id: agents.id }).from(agents).where(eq(agents.serverId, server.id));
    assert.equal(created.length, 0, "a removed creator creates no Agent");
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
      schemaVersion: "builtin-pi.create.v3",
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
    for (const local of [jointChannel, hiddenJointChannel]) {
      const canonical = await createChannel(server.id, `${local.name}-storage`);
      const [joint] = await db.insert(jointChannels).values({
        canonicalChannelId: canonical.id,
        createdByServerId: server.id,
        createdByUserId: owner.id,
      }).returning();
      await db.insert(jointChannelServers).values({
        jointChannelId: joint.id,
        serverId: server.id,
        localChannelId: local.id,
        role: "host",
        joinedByUserId: owner.id,
      });
    }
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

    for (const name of ["all", "Human", "HUMANS", "agent", "Agents", "here", "Idle", "BUSY", "system", "reminders", "Reminders"]) {
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
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
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
      `/api/agents/${agent.id}/activity-summaries`,
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

test("activity-log returns the Tool finished outcome fields the daemon reported, after database persistence (task #17)", async ({ app }) => {
    const owner = await seedUser("activity-tool-outcome-owner@slock.test", "activity-tool-outcome-owner");
    const server = await createServer("Activity Tool Outcome Server", "activity-tool-outcome", owner.id);
    const agent = await createAgent(server.id, "activity-tool-outcome-agent", {
      runtime: "claude",
      creatorType: "user",
      creatorId: owner.id,
    });
    // Same rewrite the agent:activity ingest applies before persisting.
    const entries = rewriteDaemonActivityEntries([
      { kind: "tool_start", toolName: "Bash", toolInput: "pnpm test", callId: "toolu_1" },
      {
        kind: "status",
        activity: "working",
        detail: "Tool finished",
        detailKind: "tool_end",
        tool: { callId: "toolu_1", ok: true, durationMs: 2500, exitCode: 1 },
      },
      { kind: "status", activity: "working", detail: "Tool finished", detailKind: "tool_end", tool: { callId: "toolu_2", ok: false } },
    ], { activity: "working", detailKind: "tool_end", source: "canonical" });
    assert.ok(entries);
    await appendAgentActivityEvent(agent.id, "working", "Tool finished", entries, new Date("2026-10-16T00:00:00Z"));
    // The test app stubs the orchestrator; the real listRecentActivityLog is
    // loadPersistedActivityLog -> listRecentAgentTrajectory, read from the database.
    Object.assign(app.app.get("agentOrchestrator"), {
      listRecentActivityLog: (agentId: string, limit?: number) => listRecentAgentTrajectory(agentId, limit),
    });

    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}/activity-log`, {
      headers: authHeaders(await tokenForHuman(owner.email), server.id),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as Array<{ entry: TrajectoryEntry }>;
    assert.deepEqual(body.map((row) => row.entry), entries);
    assert.deepEqual(body.map((row) => row.entry.kind === "tool_start" ? row.entry.callId : row.entry.kind === "status" ? row.entry.tool : undefined), [
      "toolu_1",
      { callId: "toolu_1", ok: true, durationMs: 2500, exitCode: 1 },
      { callId: "toolu_2", ok: false },
    ]);
});

test("activity-summaries hides where a turn came from when the viewer cannot see that channel or DM (task #17)", async ({ app }) => {
    const owner = await seedUser("activity-summary-owner@slock.test", "activity-summary-owner");
    const server = await createServer("Activity Summary Server", "activity-summary", owner.id);
    const agent = await createAgent(server.id, "activity-summary-agent", { runtime: "claude", creatorType: "user", creatorId: owner.id });
    const publicChannel = await createChannel(server.id, "summary-public", "visible");
    const privateChannel = await createChannel(server.id, "summary-secret", "not joined", "private");
    const waking = await postWakingMessage(publicChannel.id, owner.id);
    const base = { v: 1 as const, outcome: "completed" as const, actions: [], toolCalls: 0, problems: [], problemCount: 0, messagesSent: 0 };
    const calls: unknown[] = [];
    Object.assign(app.app.get("agentOrchestrator"), {
      listTurnSummaries: async (agentId: string, options: { limit?: number }) => {
        calls.push([agentId, options]);
        // The turn just older than the page, for splitting time at its edge.
        if (options.limit === 1) return { summaries: [] };
        return { next: { endedAt: 1, id: "00000000-0000-4000-8000-000000000001" }, summaries: [
          { ...base, startedAt: 5, endedAt: 6, trigger: { target: "#summary-public", channelId: publicChannel.id, sender: "richard", messageId: waking.id } },
          { ...base, startedAt: 3, endedAt: 4, trigger: { target: "#summary-secret", channelId: privateChannel.id, sender: "richard", messageId: "m2" } },
          { ...base, startedAt: 1, endedAt: 2, trigger: { target: "dm:@someone", channelId: randomUUID(), sender: "someone", messageId: "m3" } },
          { ...base, startedAt: 0, endedAt: 1 },
        ] };
      },
      getTurnSummary: async () => null,
    });

    // What the agent sent: one message in the public channel during the first
    // turn, one in the private channel during the second.
    const [visibleSent] = await getDb().insert(messages).values({
      channelId: publicChannel.id, senderType: "agent", senderId: agent.id,
      content: "visible reply", messageType: "chat", searchText: "visible reply", createdAt: new Date(5),
    }).returning();
    await getDb().insert(messages).values({
      channelId: privateChannel.id, senderType: "agent", senderId: agent.id,
      content: "secret reply", messageType: "chat", searchText: "secret reply", createdAt: new Date(3),
    });
    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}/activity-summaries?limit=4&before=99:00000000-0000-4000-8000-000000000009`, {
      headers: authHeaders(await tokenForHuman(owner.email), server.id),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { summaries: Array<{ trigger?: unknown }>; next?: string };
    assert.deepEqual(calls, [
      [agent.id, { limit: 4, before: { endedAt: 99, id: "00000000-0000-4000-8000-000000000009" } }],
      [agent.id, { limit: 1, before: { endedAt: 1, id: "00000000-0000-4000-8000-000000000001" } }],
    ]);
    assert.equal(body.next, "1:00000000-0000-4000-8000-000000000001");
    assert.deepEqual(body.summaries.map((summary) => summary.trigger), [
      {
        target: "#summary-public", channelId: publicChannel.id, sender: "richard", messageId: waking.id,
        display: { kind: "channel", channelName: "summary-public", senderName: "activity-summary-owner" },
      },
      { hidden: "private_channel" },
      { hidden: "dm" },
      undefined,
    ]);
    assert.doesNotMatch(JSON.stringify(body), /summary-secret|someone/);
    const sent = body.summaries as Array<{ sentMessageIds?: string[]; hiddenSentCount?: number }>;
    assert.deepEqual(sent.map((summary) => [summary.sentMessageIds, summary.hiddenSentCount]), [
      [[visibleSent!.id], undefined],
      [[], 1],
      [undefined, undefined],
      [undefined, undefined],
    ], "every sent message the viewer can see, and only a count of the private one");
});

test("activity-summaries splits time with the turns just outside the page, so an edge message is listed once (task #17)", async ({ app }) => {
    const owner = await seedUser("activity-sent-edge-owner@slock.test", "activity-sent-edge-owner");
    const server = await createServer("Activity Sent Edge Server", "activity-sent-edge", owner.id);
    const agent = await createAgent(server.id, "activity-sent-edge-agent", { runtime: "claude", creatorType: "user", creatorId: owner.id });
    const channel = await createChannel(server.id, "sent-edge-public", "visible");
    const base = { v: 1 as const, outcome: "completed" as const, actions: [], toolCalls: 0, problems: [], problemCount: 0, messagesSent: 0 };
    const cursorId = "00000000-0000-4000-8000-00000000000a";
    Object.assign(app.app.get("agentOrchestrator"), {
      listTurnSummaries: async (_agentId: string, options: { limit?: number }) => options.limit === 1
        ? { summaries: [{ ...base, id: "older", startedAt: 0, endedAt: 10_000 }] }
        : { next: { endedAt: 60_000, id: "00000000-0000-4000-8000-00000000000b" }, summaries: [{ ...base, startedAt: 50_000, endedAt: 60_000 }] },
      getTurnSummary: async (_agentId: string, id: string) => (id === cursorId ? { ...base, id, startedAt: 110_000, endedAt: 120_000 } : null),
    });
    const sent = await getDb().insert(messages).values([25_000, 55_000, 90_000].map((at) => ({
      channelId: channel.id, senderType: "agent" as const, senderId: agent.id,
      content: `sent at ${at}`, messageType: "chat" as const, searchText: "sent", createdAt: new Date(at),
    }))).returning();
    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}/activity-summaries?before=200000:${cursorId}`, {
      headers: authHeaders(await tokenForHuman(owner.email), server.id),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { summaries: Array<{ sentMessageIds?: string[] }> };
    // 25 s belongs to the older neighbour and 90 s to the newer one; only 55 s is this page's.
    assert.deepEqual(body.summaries.map((summary) => summary.sentMessageIds), [[sent[1]!.id]]);
});

test("activity-summaries lists sends newest first and leaves a turn the send query cut short on its last-reply card (task #17)", async ({ app }) => {
    const owner = await seedUser("activity-sent-cut-owner@slock.test", "activity-sent-cut-owner");
    const server = await createServer("Activity Sent Cut Server", "activity-sent-cut", owner.id);
    const agent = await createAgent(server.id, "activity-sent-cut-agent", { runtime: "claude", creatorType: "user", creatorId: owner.id });
    const channel = await createChannel(server.id, "sent-cut-public", "visible");
    const base = { v: 1 as const, outcome: "completed" as const, actions: [], toolCalls: 0, problems: [], problemCount: 0, messagesSent: 0 };
    Object.assign(app.app.get("agentOrchestrator"), {
      listTurnSummaries: async () => ({ summaries: [
        { ...base, startedAt: 1_000_000, endedAt: 1_010_000 },
        { ...base, startedAt: 0, endedAt: 10_000 },
      ] }),
    });
    // 2100 sends: 1500 in the newer turn and 600 in the older one; the query
    // returns the newest 2000, so the older turn's list would be partial.
    const row = (at: number) => ({
      channelId: channel.id, senderType: "agent" as const, senderId: agent.id,
      content: "sent", messageType: "chat" as const, searchText: "sent", createdAt: new Date(at),
    });
    await getDb().insert(messages).values([
      ...Array.from({ length: 1500 }, (_, i) => row(1_000_001 + i)),
      ...Array.from({ length: 600 }, (_, i) => row(1 + i)),
    ]);
    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}/activity-summaries`, {
      headers: authHeaders(await tokenForHuman(owner.email), server.id),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { summaries: Array<{ sentMessageCount?: number; sentMessageIds?: string[] }> };
    assert.deepEqual(body.summaries.map((summary) => summary.sentMessageCount), [1500, undefined]);
    assert.equal(body.summaries[1]!.sentMessageIds, undefined);
});

test("activity-summaries lists the app events delivered in each turn and names the one that woke it, never the payload", async ({ app }) => {
  const owner = await seedUser("activity-app-events-owner@slock.test", "activity-app-events-owner");
  const server = await createServer("Activity App Events Server", "activity-app-events", owner.id);
  const agent = await createAgent(server.id, "activity-app-events-agent", { runtime: "claude", creatorType: "user", creatorId: owner.id });
  const otherAgent = await createAgent(server.id, "activity-app-events-other", { runtime: "claude", creatorType: "user", creatorId: owner.id });
  const stamp = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: "stamp-overview", name: "Stamp", allowedScopes: ["agent:event:write"] });
  const t = Date.now() - 60 * 60_000;
  const base = { v: 1 as const, outcome: "completed" as const, actions: [], toolCalls: 1, problems: [], problemCount: 0, messagesSent: 0 };
  const event = (id: string, at: number | null, extra: Partial<typeof thirdPartyAgentEvents.$inferInsert> = {}) => ({
    id,
    serverId: server.id,
    agentId: agent.id,
    clientId: stamp.client.id,
    kind: "event" as const,
    summary: `summary ${id.slice(0, 8)}`,
    payload: { token: "secret-payload" },
    payloadHash: "secret-hash",
    resource: "urn:secret-resource",
    status: at === null ? "queued" as const : "delivered" as const,
    deliveredAt: at === null ? null : new Date(at),
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    createdAt: new Date(t),
    ...extra,
  });
  await getDb().insert(thirdPartyAgentEvents).values([
    // Woke the older turn, and arrived in it.
    event("11111111-0000-4000-8000-000000000001", t + 10_000, { summary: "CI failed on #10827" }),
    // Just before the boundary (75 s, halfway into the idle gap): still the older turn.
    event("22222222-0000-4000-8000-000000000002", t + 74_000),
    // A Raft system app's event (no OAuth client): kept, just after the boundary.
    event("33333333-0000-4000-8000-000000000003", t + 76_000, { clientId: null, systemApp: "system.assistant" }),
    // Never delivered: not counted.
    event("44444444-0000-4000-8000-000000000004", null, { createdAt: new Date(t + 150_000) }),
    // Two events behind one short id, delivered during the running turn.
    event("abcdef01-0000-4000-8000-000000000005", t + 350_000),
    event("abcdef01-0000-4000-8000-000000000006", t + 351_000),
    // Another agent's event, in the newer turn's time and behind its trigger's short id.
    event("deadbeef-0000-4000-8000-000000000007", t + 150_000, { agentId: otherAgent.id }),
  ]);
  Object.assign(app.app.get("agentOrchestrator"), {
    listTurnSummaries: async () => ({ summaries: [
      { ...base, id: "00000000-0000-4000-8000-0000000000b2", startedAt: t + 100_000, endedAt: t + 200_000, trigger: { target: "agent-event:deadbeef" } },
      { ...base, id: "00000000-0000-4000-8000-0000000000b1", startedAt: t, endedAt: t + 50_000, trigger: { target: "agent-event:11111111" } },
    ] }),
    getTurnSummary: async () => null,
    getActivity: async () => ({ activity: "working", activityDetail: "" }),
    getRunningTurn: async () => ({
      continuesPreviousTurn: false,
      turn: { ...base, outcome: undefined, running: true, startedAt: t + 300_000, endedAt: t + 400_000, trigger: { target: "agent-event:abcdef01" } },
    }),
  });
  const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}/activity-summaries`, {
    headers: authHeaders(await tokenForHuman(owner.email), server.id),
  });
  assert.equal(res.status, 200);
  type Turn = { trigger?: { target?: string; appEvent?: unknown }; appEvents?: Array<Record<string, unknown>>; appEventCount?: number };
  const body = await res.json() as { summaries: Turn[]; current?: Turn };
  const ids = (turn: Turn | undefined) => turn?.appEvents?.map((row) => String(row.id).slice(0, 8));
  assert.deepEqual(body.summaries.map(ids), [["33333333"], ["11111111", "22222222"]]);
  assert.deepEqual(body.summaries.map((turn) => turn.appEventCount), [1, 2]);
  assert.deepEqual(ids(body.current), ["abcdef01", "abcdef01"], "the running turn lists its events too");
  assert.deepEqual(body.summaries[1]!.appEvents![0], {
    id: "11111111-0000-4000-8000-000000000001",
    appName: "Stamp",
    clientKey: "stamp-overview",
    logoUrl: null,
    summary: "CI failed on #10827",
    deliveredAt: t + 10_000,
    kind: "event",
  });
  assert.deepEqual(body.summaries[0]!.appEvents![0]!.appName, "system.assistant");
  // The trigger: resolved by name; another agent's event and a short-id collision are not.
  assert.deepEqual(body.summaries[1]!.trigger, { target: "agent-event:11111111", appEvent: { appName: "Stamp", summary: "CI failed on #10827" } });
  assert.deepEqual(body.summaries[0]!.trigger, { target: "agent-event:deadbeef" });
  assert.deepEqual(body.current!.trigger, { target: "agent-event:abcdef01" });
  assert.doesNotMatch(JSON.stringify(body), /secret-payload|secret-hash|secret-resource|44444444|deadbeef-0000|"payload"/);
});

test("activity-summaries never passes on server-owned fields a stored summary carries (a forged daemon turn_summary)", async ({ app }) => {
  const owner = await seedUser("activity-forged-owner@slock.test", "activity-forged-owner");
  const server = await createServer("Activity Forged Server", "activity-forged", owner.id);
  const agent = await createAgent(server.id, "activity-forged-agent", { runtime: "claude", creatorType: "user", creatorId: owner.id });
  const t = Date.now() - 60 * 60_000;
  // Stored as a daemon sent it (rows written before the server narrowed them).
  const forged = {
    v: 1 as const, startedAt: t, endedAt: t + 10_000, outcome: "completed" as const, toolCalls: 0, problems: [], problemCount: 0, messagesSent: 0,
    trigger: { target: "agent-event:11111111", appEvent: { appName: "Forged App", summary: "forged summary" }, hidden: "dm", extra: "forged-extra" },
    appEvents: [{ id: "forged-event", appName: "Forged App", clientKey: "forged", logoUrl: "https://evil.example/logo.png", summary: "forged summary", deliveredAt: t + 1, kind: "event" }],
    appEventCount: 9,
    sentMessageIds: ["forged-message"],
    sentMessageCount: 9,
    hiddenSentCount: 9,
    running: true,
    // Keys no producer has: dropped by the allowlist, whatever they are called.
    viewerNote: "forged-note",
    actions: [{ kind: "run_command", count: 1, label: "forged-label" }, { kind: "forged_kind", count: 2 }],
  };
  // A message trigger whose text claims a private channel and another sender,
  // over a public channel and a real message in it.
  const channel = await createChannel(server.id, "named-public", "visible");
  const waking = await postWakingMessage(channel.id, owner.id);
  const forgedText = {
    v: 1 as const, startedAt: t - 60_000, endedAt: t - 50_000, outcome: "completed" as const, actions: [], toolCalls: 0, problems: [], problemCount: 0, messagesSent: 0,
    trigger: { target: "#ceo-private", channelId: channel.id, sender: "ceo", messageId: waking.id, display: { kind: "channel", channelName: "ceo-private", senderName: "ceo" } },
    viewerNote: "forged-note",
  };
  await upsertAgentTurnSummaries(agent.id, [
    { turnKey: `daemon:${t}`, summary: forged as never },
    { turnKey: `daemon:${t - 60_000}`, summary: forgedText as never },
  ]);
  const real = useRealTurnReads(app, { activity: "online" });
  try {
    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}/activity-summaries`, {
      headers: authHeaders(await tokenForHuman(owner.email), server.id),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { summaries: Array<Record<string, unknown>> };
    assert.equal(body.summaries.length, 2);
    const [turn, named] = body.summaries;
    for (const key of ["appEvents", "appEventCount", "sentMessageIds", "sentMessageCount", "hiddenSentCount", "running", "viewerNote"]) {
      assert.ok(!(key in turn!), `${key} is the server's to set`);
    }
    assert.deepEqual(turn!.trigger, { target: "agent-event:11111111" });
    assert.deepEqual(turn!.actions, [{ kind: "run_command", count: 1 }]);
    assert.ok(!("viewerNote" in named!));
    // The display is the server's: the real channel and sender, not the daemon's.
    assert.deepEqual(named!.trigger, {
      target: "#ceo-private", channelId: channel.id, sender: "ceo", messageId: waking.id,
      display: { kind: "channel", channelName: "named-public", senderName: "activity-forged-owner" },
    });
    assert.doesNotMatch(JSON.stringify(body), /Forged App|forged-(?:note|label|extra|event|message|summary)|forged_kind|evil\.example/);
  } finally {
    real.shutdown();
  }
});

test("activity-summaries names a trigger's channel and sender from the server's rows, not the daemon's target and sender", async ({ app }) => {
  const owner = await seedUser("activity-display-owner@slock.test", "activity-display-owner");
  const alice = await seedUser("activity-display-alice@slock.test", "activity-display-alice");
  const server = await createServer("Activity Display Server", "activity-display", owner.id);
  const agent = await createAgent(server.id, "activity-display-agent", { runtime: "claude", creatorType: "user", creatorId: owner.id });
  const general = await createChannel(server.id, "display-general", "visible");
  const other = await createChannel(server.id, "display-other", "visible");
  const dm = await findOrCreateDM(server.id, owner.id, agent.id);
  const fromAlice = await postWakingMessage(general.id, alice!.id);
  const elsewhere = await postWakingMessage(other.id, alice!.id);
  const t = Date.now() - 60 * 60_000;
  const base = { v: 1 as const, outcome: "completed" as const, actions: [], toolCalls: 1, problems: [], problemCount: 0, messagesSent: 0 };
  const turn = (at: number, trigger: Record<string, string>) => ({ turnKey: `daemon:${at}`, summary: { ...base, startedAt: at, endedAt: at + 1_000, trigger } });
  await upsertAgentTurnSummaries(agent.id, [
    // Claims #ceo-private and @ceo over a public channel and alice's message in it.
    turn(t + 40_000, { target: "#ceo-private", channelId: general.id, sender: "ceo", messageId: fromAlice.id }),
    // A real message, but in another channel than the trigger says.
    turn(t + 30_000, { target: "#ceo-private", channelId: general.id, sender: "ceo", messageId: elsewhere.id }),
    // A message id that is no message.
    turn(t + 20_000, { target: "#ceo-private", channelId: general.id, sender: "ceo", messageId: randomUUID() }),
    // No message id: the channel by name, no sender; a DM by its peer.
    turn(t + 10_000, { target: "#ceo-private:9b526607", channelId: general.id, sender: "ceo" }),
    turn(t, { target: "dm:@ceo", channelId: dm!.id, sender: "ceo" }),
  ]);
  const real = useRealTurnReads(app, { activity: "online" });
  try {
    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}/activity-summaries`, {
      headers: authHeaders(await tokenForHuman(owner.email), server.id),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { summaries: Array<{ trigger?: Record<string, unknown> }> };
    assert.deepEqual(body.summaries.map((summary) => summary.trigger?.display ?? summary.trigger), [
      { kind: "channel", channelName: "display-general", senderName: "activity-display-alice" },
      { unresolved: true },
      { unresolved: true },
      { kind: "channel", channelName: "display-general" },
      { kind: "dm", peerName: "activity-display-owner" },
    ]);
    // An unresolved trigger carries none of the daemon's text (nor its ids).
    assert.deepEqual(body.summaries[1]!.trigger, { unresolved: true });
  } finally {
    real.shutdown();
  }
});

test("activity-summaries skips a stored row that does not read as a turn summary and pages past it", async ({ app }) => {
  const owner = await seedUser("activity-unreadable-owner@slock.test", "activity-unreadable-owner");
  const server = await createServer("Activity Unreadable Server", "activity-unreadable", owner.id);
  const agent = await createAgent(server.id, "activity-unreadable-agent", { runtime: "claude", creatorType: "user", creatorId: owner.id });
  const base = { v: 1 as const, outcome: "completed" as const, actions: [], toolCalls: 1, problems: [], problemCount: 0, messagesSent: 0 };
  const turn = (at: number, extra: Record<string, unknown> = {}) => ({ turnKey: `daemon:${at}`, summary: { ...base, startedAt: at, endedAt: at + 1_000, ...extra } as never });
  await upsertAgentTurnSummaries(agent.id, [
    turn(40_000),
    // Rows written before the server checked them on write: never shown.
    turn(30_000, { trigger: { target: 5 } }),
    turn(20_000, { v: 2 }),
    turn(10_000),
  ]);
  const real = useRealTurnReads(app, { activity: "online" });
  const headers = authHeaders(await tokenForHuman(owner.email), server.id);
  try {
    const first = await (await fetch(`${app.baseUrl}/api/agents/${agent.id}/activity-summaries?limit=1`, { headers })).json() as SummariesBody & { next?: string };
    assert.deepEqual(first.summaries.map((summary) => summary.startedAt), [40_000]);
    assert.ok(first.next, "older rows remain");
    // The first page's read (the turn and the two after it) ends on the unreadable rows: the cursor is past them.
    const second = await (await fetch(`${app.baseUrl}/api/agents/${agent.id}/activity-summaries?limit=1&before=${first.next}`, { headers })).json() as SummariesBody & { next?: string };
    assert.deepEqual(second.summaries.map((summary) => summary.startedAt), [10_000]);
    assert.equal(second.next, undefined);
  } finally {
    real.shutdown();
  }
});

test("activity-summaries reads as far as the neighbour turns: an event in the idle gap at a page edge shows on exactly one page", async ({ app }) => {
  const owner = await seedUser("activity-app-edge-owner@slock.test", "activity-app-edge-owner");
  const server = await createServer("Activity App Edge Server", "activity-app-edge", owner.id);
  const agent = await createAgent(server.id, "activity-app-edge-agent", { runtime: "claude", creatorType: "user", creatorId: owner.id });
  const t = Date.now() - 60 * 60_000;
  const base = { v: 1 as const, outcome: "completed" as const, actions: [], toolCalls: 1, problems: [], problemCount: 0, messagesSent: 0 };
  // Ten idle minutes between the two turns: the boundary sits 5 min after the older one ends.
  const older = { ...base, id: "00000000-0000-4000-8000-0000000000c1", startedAt: t, endedAt: t + 60_000 };
  const newer = { ...base, id: "00000000-0000-4000-8000-0000000000c2", startedAt: t + 660_000, endedAt: t + 720_000 };
  Object.assign(app.app.get("agentOrchestrator"), {
    listTurnSummaries: async (_agentId: string, options: { before?: unknown }) => (options.before
      ? { summaries: [older] }
      : { summaries: [newer], next: { endedAt: newer.endedAt, id: newer.id } }),
    getTurnSummary: async (_agentId: string, id: string) => (id === newer.id ? newer : null),
  });
  const stamp = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: "stamp-edge", name: "Stamp", allowedScopes: ["agent:event:write"] });
  const event = (id: string, at: number) => ({
    id, serverId: server.id, agentId: agent.id, clientId: stamp.client.id, kind: "event" as const, summary: id.slice(0, 8),
    payload: {}, payloadHash: "h", resource: "r", status: "delivered" as const, deliveredAt: new Date(at),
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000), createdAt: new Date(t),
  });
  // Both more than the 60 s edge slack from either turn, on either side of the boundary.
  await getDb().insert(thirdPartyAgentEvents).values([
    event("aaaaaaaa-0000-4000-8000-000000000001", t + 240_000),
    event("bbbbbbbb-0000-4000-8000-000000000002", t + 420_000),
  ]);
  const headers = authHeaders(await tokenForHuman(owner.email), server.id);
  type Page = { summaries: Array<{ appEvents?: Array<{ summary: string }> }>; next?: string };
  const first = await (await fetch(`${app.baseUrl}/api/agents/${agent.id}/activity-summaries`, { headers })).json() as Page;
  const second = await (await fetch(`${app.baseUrl}/api/agents/${agent.id}/activity-summaries?before=${first.next}`, { headers })).json() as Page;
  assert.deepEqual(first.summaries.map((turn) => turn.appEvents?.map((row) => row.summary)), [["bbbbbbbb"]]);
  assert.deepEqual(second.summaries.map((turn) => turn.appEvents?.map((row) => row.summary)), [["aaaaaaaa"]]);
});

/**
 * Task #17: a daemon agent's overview read through the real orchestrator and
 * database. The Remy sequence: a wake at `t` that the daemon closes empty a
 * second later (the runtime's `result`), then the real work as tool rows with
 * no closing idle (a background task outstanding).
 */
/** A message a person posted in `channelId`, for a turn trigger to name. */
async function postWakingMessage(channelId: string, senderUserId: string) {
  const [row] = await getDb().insert(messages).values({
    channelId, senderType: "user", senderId: senderUserId, content: "wake up", messageType: "chat", searchText: "wake up",
  }).returning();
  return row!;
}

async function seedEmptyWakeThenWork(agentId: string, trigger: { target: string; channelId: string; messageId?: string }, t: number) {
  const base = { v: 1 as const, actions: [], problems: [], problemCount: 0, messagesSent: 0 };
  const wake = { ...base, startedAt: t, endedAt: t + 1_000, outcome: "completed" as const, toolCalls: 0, trigger: { messageId: "m-wake", ...trigger, sender: "tenny" } };
  await upsertAgentTurnSummaries(agentId, [
    { turnKey: `daemon:${t - 60_000}`, summary: { ...base, startedAt: t - 60_000, endedAt: t - 50_000, outcome: "completed", toolCalls: 0, trigger: { target: "dm:@richard" } } },
    { turnKey: `daemon:${t}`, summary: wake },
  ]);
  const row = (at: number, activity: string, entries: TrajectoryEntry[]) => appendAgentActivityEvent(agentId, activity, "", entries, new Date(at));
  await row(t, "working", [{ kind: "status", activity: "working", detail: "Message received", detailKind: "model_request_started" }]);
  await row(t + 1_000, "online", [{ kind: "status", activity: "online", detail: "Idle", detailKind: "idle" }, { kind: "turn_summary", summary: wake }]);
  await row(t + 2_000, "working", [{ kind: "tool_start", toolName: "Bash", toolInput: "pnpm test", callId: "c1" }]);
  await row(t + 4_000, "working", [{ kind: "status", activity: "working", detail: "Tool finished", detailKind: "tool_end", tool: { callId: "c1", ok: true, exitCode: 1 } }]);
  await row(t + 5_000, "working", [{ kind: "tool_start", toolName: "Read", toolInput: JSON.stringify({ file_path: "src/a.ts" }), callId: "c2" }]);
  await row(t + 6_000, "working", [{ kind: "status", activity: "working", detail: "Waiting for 1 background task", detailKind: "subagent_activity" }]);
  const [wakeRow] = await getDb().select({ id: agentActivitySummaryV2.id }).from(agentActivitySummaryV2)
    .where(and(eq(agentActivitySummaryV2.agentId, agentId), eq(agentActivitySummaryV2.turnKey, `daemon:${t}`)));
  return { wake, wakeId: wakeRow!.id };
}

/** The real turn reads, with the agent's live activity as given (working unless a test says otherwise). */
function useRealTurnReads(app: { app: { get(name: string): unknown } }, live: { activity: string } = { activity: "working" }) {
  const real = new AgentOrchestrator();
  Object.assign(app.app.get("agentOrchestrator") as object, {
    getActivity: async () => ({ activityDetail: "", ...live }),
    listTurnSummaries: (agentId: string, options: Parameters<AgentOrchestrator["listTurnSummaries"]>[1]) => real.listTurnSummaries(agentId, options),
    getTurnSummary: (agentId: string, id: string) => real.getTurnSummary(agentId, id),
    getRunningTurn: (agentId: string, afterMs: number | null) => real.getRunningTurn(agentId, afterMs),
  });
  return real;
}

type SummariesBody = {
  summaries: Array<{ id: string; startedAt: number; endedAt: number; toolCalls: number; trigger?: unknown; outcome?: string }>;
  next?: string;
  current?: { id?: string; running: true; startedAt: number; endedAt: number; outcome?: unknown; trigger?: unknown; toolCalls: number; actions: unknown; problems: unknown; sentMessageIds?: string[] };
};

test("activity-summaries folds the running turn from the activity rows after the last finished turn, and the work after an empty wake takes over its trigger (task #17)", async ({ app }) => {
  const owner = await seedUser("activity-running-owner@slock.test", "activity-running-owner");
  const server = await createServer("Activity Running Server", "activity-running", owner.id);
  const agent = await createAgent(server.id, "activity-running-agent", { runtime: "claude", creatorType: "user", creatorId: owner.id });
  const channel = await createChannel(server.id, "running-public", "visible");
  const t = Date.now() - 10 * 60_000;
  const waking = await postWakingMessage(channel.id, owner.id);
  const { wake, wakeId } = await seedEmptyWakeThenWork(agent.id, { target: "#running-public", channelId: channel.id, messageId: waking.id }, t);
  // Named by the server from the channel and the message.
  const shownTrigger = { ...wake.trigger, display: { kind: "channel", channelName: "running-public", senderName: "activity-running-owner" } };
  const [sent] = await getDb().insert(messages).values({
    channelId: channel.id, senderType: "agent", senderId: agent.id,
    content: "progress", messageType: "chat", searchText: "progress", createdAt: new Date(t + 5_500),
  }).returning();
  const real = useRealTurnReads(app);
  const headers = authHeaders(await tokenForHuman(owner.email), server.id);
  try {
    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}/activity-summaries`, { headers });
    assert.equal(res.status, 200);
    const body = await res.json() as SummariesBody;
    // The empty wake leaves the list; the running work carries its trigger, start and id.
    assert.deepEqual(body.summaries.map((summary) => [summary.startedAt, summary.trigger]), [[t - 60_000, { hidden: "dm" }]]);
    const current = body.current!;
    assert.ok(current, "the open turn is returned");
    assert.equal(current.running, true);
    assert.equal(current.outcome, undefined);
    assert.equal(current.id, wakeId);
    assert.equal(current.startedAt, t);
    assert.ok(current.endedAt >= t + 6_000);
    assert.deepEqual(current.trigger, shownTrigger);
    assert.equal(current.toolCalls, 2);
    assert.deepEqual(current.actions, [{ kind: "run_checks", count: 1 }, { kind: "read_file", count: 1 }]);
    assert.deepEqual(current.problems, [{ kind: "run_checks", reason: "exit_nonzero", exitCode: 1, at: t + 4_000 }]);
    assert.deepEqual(current.sentMessageIds, [sent!.id]);

    // The work ends as its own turn (no trigger) and the agent goes idle. The
    // daemon's clock runs 1.5 s behind the server's, so the last busy row and
    // the idle row come after the turn's recorded end: the rows show the turn
    // closed, and nothing is running. The pair reads as one turn.
    const work = { v: 1 as const, startedAt: t + 2_000, endedAt: t + 5_500, outcome: "unknown" as const, actions: [{ kind: "run_checks" as const, count: 1 }, { kind: "read_file" as const, count: 1 }], toolCalls: 2, problems: [], problemCount: 0, messagesSent: 1 };
    await upsertAgentTurnSummaries(agent.id, [{ turnKey: `daemon:${t + 2_000}`, summary: work }]);
    await appendAgentActivityEvent(agent.id, "online", "", [{ kind: "status", activity: "online", detail: "Idle", detailKind: "idle" }], new Date(t + 7_000));
    const after = await (await fetch(`${app.baseUrl}/api/agents/${agent.id}/activity-summaries`, { headers })).json() as SummariesBody;
    assert.equal(after.current, undefined, "no running turn once the rows show it closed");
    assert.deepEqual(after.summaries.map((summary) => [summary.id, summary.startedAt, summary.endedAt, summary.toolCalls, summary.trigger]), [
      [wakeId, t, t + 5_500, 2, shownTrigger],
      [after.summaries[1]!.id, t - 60_000, t - 50_000, 0, { hidden: "dm" }],
    ]);

    // Another empty wake, then a new message wakes the agent: the running
    // turn started with a message handed over, so it is a turn of its own and
    // the empty wake stays listed.
    const emptyAgain = { ...wake, startedAt: t + 8_000, endedAt: t + 9_000 };
    await upsertAgentTurnSummaries(agent.id, [{ turnKey: `daemon:${t + 8_000}`, summary: emptyAgain }]);
    await appendAgentActivityEvent(agent.id, "working", "", [{ kind: "status", activity: "working", detail: "Message received", detailKind: "model_request_started" }], new Date(t + 10_000));
    await appendAgentActivityEvent(agent.id, "working", "", [{ kind: "tool_start", toolName: "Bash", toolInput: "ls", callId: "c3" }], new Date(t + 11_000));
    const woken = await (await fetch(`${app.baseUrl}/api/agents/${agent.id}/activity-summaries`, { headers })).json() as SummariesBody;
    assert.deepEqual(woken.summaries.map((summary) => [summary.startedAt, summary.toolCalls]), [[t + 8_000, 0], [t, 2], [t - 60_000, 0]]);
    assert.deepEqual(woken.current && [woken.current.id, woken.current.startedAt, woken.current.trigger, woken.current.toolCalls], [undefined, t + 10_000, undefined, 1]);
  } finally {
    real.shutdown();
  }
});

test("activity-summaries shows no running turn while the agent is not busy, whatever the rows leave open (task #17)", async ({ app }) => {
  const owner = await seedUser("activity-not-busy-owner@slock.test", "activity-not-busy-owner");
  const server = await createServer("Activity Not Busy Server", "activity-not-busy", owner.id);
  const agent = await createAgent(server.id, "activity-not-busy-agent", { runtime: "claude", creatorType: "user", creatorId: owner.id });
  const channel = await createChannel(server.id, "not-busy-public", "visible");
  const t = Date.now() - 10 * 60_000;
  // The rows leave the work after the empty wake open (no idle after it).
  const { wakeId } = await seedEmptyWakeThenWork(agent.id, { target: "#not-busy-public", channelId: channel.id }, t);
  const live = { activity: "error" };
  const real = useRealTurnReads(app, live);
  const headers = authHeaders(await tokenForHuman(owner.email), server.id);
  const read = async () => (await (await fetch(`${app.baseUrl}/api/agents/${agent.id}/activity-summaries`, { headers })).json()) as SummariesBody;
  try {
    // A usage limit: the turn never closed, but nothing is running.
    const errored = await read();
    assert.equal(errored.current, undefined);
    assert.equal(errored.summaries[0]!.id, wakeId, "the empty wake stays listed");
    // Idle with a lost idle frame: the rows still look open.
    live.activity = "online";
    assert.equal((await read()).current, undefined);
    live.activity = "offline";
    assert.equal((await read()).current, undefined);
    // Busy again: the same rows are the running turn.
    live.activity = "working";
    assert.equal((await read()).current?.id, wakeId);
  } finally {
    real.shutdown();
  }
});

test("activity-summaries keeps an empty wake apart from work that a restart started after it (task #17)", async ({ app }) => {
  const owner = await seedUser("activity-restart-owner@slock.test", "activity-restart-owner");
  const server = await createServer("Activity Restart Server", "activity-restart", owner.id);
  const agent = await createAgent(server.id, "activity-restart-agent", { runtime: "claude", creatorType: "user", creatorId: owner.id });
  const t = Date.now() - 10 * 60_000;
  const base = { v: 1 as const, actions: [], problems: [], problemCount: 0, messagesSent: 0, toolCalls: 0 };
  await upsertAgentTurnSummaries(agent.id, [{ turnKey: `daemon:${t}`, summary: { ...base, startedAt: t, endedAt: t + 1_000, outcome: "completed", trigger: { target: "agent-event:x" } } }]);
  // Two seconds later the runtime starts again: its turn opens at the start row, not at runtime output.
  await appendAgentActivityEvent(agent.id, "working", "", [{ kind: "status", activity: "working", detail: "Starting…", detailKind: "starting" }], new Date(t + 3_000));
  await appendAgentActivityEvent(agent.id, "working", "", [{ kind: "tool_start", toolName: "Bash", toolInput: "ls", callId: "c1" }], new Date(t + 4_000));
  const real = useRealTurnReads(app);
  try {
    const body = await (await fetch(`${app.baseUrl}/api/agents/${agent.id}/activity-summaries`, {
      headers: authHeaders(await tokenForHuman(owner.email), server.id),
    })).json() as SummariesBody;
    assert.deepEqual(body.summaries.map((summary) => summary.startedAt), [t]);
    assert.deepEqual(body.current && [body.current.id, body.current.startedAt, body.current.trigger, body.current.toolCalls], [undefined, t + 3_000, undefined, 1]);
  } finally {
    real.shutdown();
  }
});

test("activity-summaries hides the running turn's trigger like a finished one's when the viewer cannot see that channel (task #17)", async ({ app }) => {
  const owner = await seedUser("activity-running-private-owner@slock.test", "activity-running-private-owner");
  const server = await createServer("Activity Running Private Server", "activity-running-private", owner.id);
  const agent = await createAgent(server.id, "activity-running-private-agent", { runtime: "claude", creatorType: "user", creatorId: owner.id });
  const secret = await createChannel(server.id, "running-secret", "not joined", "private");
  await seedEmptyWakeThenWork(agent.id, { target: "#running-secret", channelId: secret.id }, Date.now() - 10 * 60_000);
  const real = useRealTurnReads(app);
  try {
    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}/activity-summaries`, {
      headers: authHeaders(await tokenForHuman(owner.email), server.id),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as SummariesBody;
    assert.deepEqual(body.current?.trigger, { hidden: "private_channel" });
    assert.doesNotMatch(JSON.stringify(body), /running-secret|m-wake|tenny/);
  } finally {
    real.shutdown();
  }
});

test("activity-summaries names the running turn's trigger from the status that opened it, hidden like a finished one's without channel access (task #17)", async ({ app }) => {
  const owner = await seedUser("activity-running-trigger-owner@slock.test", "activity-running-trigger-owner");
  const server = await createServer("Activity Running Trigger Server", "activity-running-trigger", owner.id);
  const visible = await createChannel(server.id, "trigger-public", "visible");
  const secret = await createChannel(server.id, "trigger-secret", "not joined", "private");
  const real = useRealTurnReads(app);
  const headers = authHeaders(await tokenForHuman(owner.email), server.id);
  try {
    const currentFor = async (channel: { id: string; name: string }) => {
      const agent = await createAgent(server.id, `activity-trigger-${channel.name}`, { runtime: "claude", creatorType: "user", creatorId: owner.id });
      const t = Date.now() - 60_000;
      const waking = await postWakingMessage(channel.id, owner.id);
      const trigger = { target: `#${channel.name}`, channelId: channel.id, sender: "tenny", messageId: waking.id };
      // A newer daemon's "Message received" names the message that woke the agent.
      await appendAgentActivityEvent(agent.id, "working", "", [{ kind: "status", activity: "working", detail: "Message received", detailKind: "model_request_started", trigger }], new Date(t));
      await appendAgentActivityEvent(agent.id, "working", "", [{ kind: "tool_start", toolName: "Bash", toolInput: "ls", callId: "c1" }], new Date(t + 1_000));
      const body = await (await fetch(`${app.baseUrl}/api/agents/${agent.id}/activity-summaries`, { headers })).json() as SummariesBody;
      return { trigger, body };
    };
    const shown = await currentFor({ id: visible.id, name: "trigger-public" });
    assert.deepEqual(shown.body.current && [shown.body.current.trigger, shown.body.current.toolCalls], [
      { ...shown.trigger, display: { kind: "channel", channelName: "trigger-public", senderName: "activity-running-trigger-owner" } },
      1,
    ]);
    const hidden = await currentFor({ id: secret.id, name: "trigger-secret" });
    assert.deepEqual(hidden.body.current?.trigger, { hidden: "private_channel" });
    assert.doesNotMatch(JSON.stringify(hidden.body), new RegExp(`trigger-secret|${hidden.trigger.messageId}|tenny|activity-running-trigger-owner`));

    // A malformed trigger in a stored row is no trigger, not a failed read.
    const malformed = await createAgent(server.id, "activity-trigger-malformed", { runtime: "claude", creatorType: "user", creatorId: owner.id });
    await appendAgentActivityEvent(malformed.id, "working", "", [{ kind: "status", activity: "working", detail: "Message received", detailKind: "model_request_started", trigger: { target: 5, channelId: visible.id } as never }], new Date(Date.now() - 60_000));
    const res = await fetch(`${app.baseUrl}/api/agents/${malformed.id}/activity-summaries`, { headers });
    assert.equal(res.status, 200);
    const body = await res.json() as SummariesBody;
    assert.ok(body.current);
    assert.equal(body.current.trigger, undefined);
  } finally {
    real.shutdown();
  }
});

test("activity-summaries gives the work after an empty wake the daemon held (no stored summary yet) the wake's trigger and start (task #17)", async ({ app }) => {
  const owner = await seedUser("activity-held-wake-owner@slock.test", "activity-held-wake-owner");
  const server = await createServer("Activity Held Wake Server", "activity-held-wake", owner.id);
  const agent = await createAgent(server.id, "activity-held-wake-agent", { runtime: "claude", creatorType: "user", creatorId: owner.id });
  const channel = await createChannel(server.id, "held-public", "visible");
  const t = Date.now() - 10 * 60_000;
  const base = { v: 1 as const, actions: [], problems: [], problemCount: 0, messagesSent: 0, toolCalls: 0, outcome: "completed" as const };
  await upsertAgentTurnSummaries(agent.id, [{ turnKey: `daemon:${t - 60_000}`, summary: { ...base, startedAt: t - 60_000, endedAt: t - 50_000, trigger: { target: "dm:@richard" } } }]);
  const waking = await postWakingMessage(channel.id, owner.id);
  const trigger = { target: "#held-public", channelId: channel.id, sender: "tenny", messageId: waking.id };
  const row = (at: number, activity: string, entries: TrajectoryEntry[]) => appendAgentActivityEvent(agent.id, activity, "", entries, new Date(at));
  await row(t, "working", [{ kind: "status", activity: "working", detail: "Message received", detailKind: "model_request_started", trigger }]);
  // Claude's `result` a second later: Idle, and no turn_summary (the daemon holds the empty wake).
  await row(t + 1_000, "online", [{ kind: "status", activity: "online", detail: "Idle", detailKind: "idle" }]);
  await row(t + 2_000, "working", [{ kind: "text", text: "picking the notice up" }, { kind: "status", activity: "working", detail: "", detailKind: "model_response_started" }]);
  await row(t + 3_000, "working", [{ kind: "tool_start", toolName: "Bash", toolInput: "pnpm test", callId: "c1" }]);
  const real = useRealTurnReads(app);
  try {
    const body = await (await fetch(`${app.baseUrl}/api/agents/${agent.id}/activity-summaries`, {
      headers: authHeaders(await tokenForHuman(owner.email), server.id),
    })).json() as SummariesBody;
    assert.deepEqual(body.summaries.map((summary) => summary.startedAt), [t - 60_000]);
    assert.deepEqual(body.current && [body.current.startedAt, body.current.trigger, body.current.toolCalls], [
      t, { ...trigger, display: { kind: "channel", channelName: "held-public", senderName: "activity-held-wake-owner" } }, 1,
    ]);
  } finally {
    real.shutdown();
  }
});

test("activity-summaries pages an empty wake and its work as one turn across a page boundary, with no running turn past the first page (task #17)", async ({ app }) => {
  const owner = await seedUser("activity-page-owner@slock.test", "activity-page-owner");
  const server = await createServer("Activity Page Server", "activity-page", owner.id);
  const agent = await createAgent(server.id, "activity-page-agent", { runtime: "claude", creatorType: "user", creatorId: owner.id });
  const base = { v: 1 as const, outcome: "completed" as const, actions: [], toolCalls: 0, problems: [], problemCount: 0, messagesSent: 0 };
  await upsertAgentTurnSummaries(agent.id, [
    { turnKey: "daemon:1000", summary: { ...base, startedAt: 1_000, endedAt: 2_000, trigger: { target: "#oldest" } } },
    { turnKey: "daemon:10000", summary: { ...base, startedAt: 10_000, endedAt: 11_000, trigger: { target: "#wake" } } },
    { turnKey: "daemon:11500", summary: { ...base, startedAt: 11_500, endedAt: 30_000, toolCalls: 4, actions: [{ kind: "run_command", count: 4 }] } },
    { turnKey: "daemon:40000", summary: { ...base, startedAt: 40_000, endedAt: 50_000, trigger: { target: "#newest" }, toolCalls: 1 } },
  ]);
  // A running turn the first page would show, after the newest finished one.
  await appendAgentActivityEvent(agent.id, "working", "", [{ kind: "tool_start", toolName: "Bash", toolInput: "ls", callId: "c1" }], new Date(60_000));
  const real = useRealTurnReads(app);
  const headers = authHeaders(await tokenForHuman(owner.email), server.id);
  try {
    const first = await (await fetch(`${app.baseUrl}/api/agents/${agent.id}/activity-summaries?limit=2`, { headers })).json() as SummariesBody;
    // The wake's trigger (a channel this test did not create, so shown hidden) on the work.
    assert.deepEqual(first.summaries.map((summary) => [summary.startedAt, summary.toolCalls, summary.trigger !== undefined]), [
      [40_000, 1, true],
      [10_000, 4, true],
    ]);
    assert.equal(first.current?.toolCalls, 1);
    assert.ok(first.next);
    const second = await (await fetch(`${app.baseUrl}/api/agents/${agent.id}/activity-summaries?limit=2&before=${first.next}`, { headers })).json() as SummariesBody;
    // The wake is not listed again on its own; the oldest turn is all that is left.
    assert.deepEqual(second.summaries.map((summary) => summary.startedAt), [1_000]);
    assert.equal(second.next, undefined);
    assert.equal(second.current, undefined);
  } finally {
    real.shutdown();
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
    // The request span names the Computer it waited on, hashed, never the raw id (#proj-o11y:#29).
    const offlineListSpan = sink.getAllSpans().find((span) => span.name === "server.http.request");
    assert.equal(offlineListSpan?.attrs?.target_runtime, assignedAgent.runtime);
    assert.ok(!JSON.stringify(sink.getAllSpans()).includes(machine!.id));

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

    assert.equal(res.status, 409);
    const body = await res.json() as { code: string; machineAffinityRoute: string; error: string };
    assert.equal(body.code, "machine_offline");
    assert.equal(body.machineAffinityRoute, "owner_missing");
    assert.match(body.error, /Machine is offline/);
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
    // A timeout is answered from the probe cache: nothing cached, so 200 unavailable, never 504.
    assert.equal(timeoutRes.status, 200);
    assert.deepEqual(await timeoutRes.json(), { global: [], workspace: [], state: "unavailable" });
    assert.equal(findFailedEvent(), undefined, "a timeout is a state, not a failed request");
    const timeoutSpan = sink.getAllSpans().find((span) =>
      span.name === "server.http.request" && span.attrs?.route_pattern === "/api/agents/:id/skills");
    assert.equal(timeoutSpan?.attrs?.computer_probe_state, "unavailable");
    const timeoutTraceJson = JSON.stringify(sink.getAllSpans());
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

test("agent skills on an offline machine (owner_missing, 409) does not record the 500-catch trace event", async ({ app }) => {
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

    assert.equal(res.status, 409);
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

    const processEventNames = handlerTraceEvents(span.events)
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

    const dbEvents = handlerTraceEvents(span.events).filter((event) => event.name === "db.query.finished");
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

test("with agent_runtime_oar_antigravity on, Antigravity agents can be created and switched to again (tygg, #oar-raft:e9798673)", async ({ app }) => {
  const owner = await seedUser("antigravity-revived@slock.test", "antigravity-revived");
  const server = await createServer("Antigravity Revived", "antigravity-revived", owner.id);
  await getDb().insert(featureFlags).values({ key: "agent_runtime_oar_antigravity", randomizationUnit: "server", salt: "test", defaultEnabled: false }).onConflictDoNothing();
  await getDb().insert(featureFlagRules).values({ id: randomUUID(), flagKey: "agent_runtime_oar_antigravity", stage: "server", priority: 0, decision: "allow", values: [server.id] });
  const ownerToken = await tokenForHuman(owner.email);
  const other = await createAgent(server.id, "revived-codex", { runtime: "codex", model: "gpt-5" });
  const headers = { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" };

  const created = await fetch(`${app.baseUrl}/api/agents`, {
    method: "POST", headers, body: JSON.stringify({ name: "new-antigravity", runtime: "antigravity", model: "default" }),
  });
  assert.equal(created.status, 200, await created.clone().text());
  assert.equal((await created.json() as { runtime: string }).runtime, "antigravity");

  const switched = await fetch(`${app.baseUrl}/api/agents/${other.id}`, {
    method: "PATCH", headers, body: JSON.stringify({ runtime: "antigravity", model: "default" }),
  });
  assert.equal(switched.status, 200, await switched.clone().text());
  assert.equal((await getAgent(other.id))?.runtime, "antigravity");

  // Only Antigravity is revived: other deprecated runtimes are still refused.
  const gemini = await fetch(`${app.baseUrl}/api/agents`, {
    method: "POST", headers, body: JSON.stringify({ name: "new-gemini", runtime: "gemini", model: "default" }),
  });
  assert.equal(gemini.status, 400);
});

test("Copilot permits existing-agent model and env edits but rejects new agents and runtime transitions", async ({ app }) => {
  const owner = await seedUser("copilot-existing@slock.test", "copilot-existing");
  const server = await createServer("Copilot Existing", "copilot-existing", owner.id);
  const ownerToken = await tokenForHuman(owner.email);
  const [machine] = await getDb().insert(machines).values({
    serverId: server.id, userId: owner.id, name: "copilot-existing-machine",
    apiKeyHash: "copilot-existing", runtimes: ["copilot", "codex"],
  }).returning();
  const existing = await createAgent(server.id, "existing-copilot", { runtime: "copilot", model: "gpt-5.4", machineId: machine.id });
  const other = await createAgent(server.id, "existing-codex", { runtime: "codex", model: "gpt-5", machineId: machine.id });
  const headers = { ...authHeaders(ownerToken, server.id), "Content-Type": "application/json" };
  const deprecatedError = "Runtime is deprecated and cannot be selected: copilot";

  for (const fields of [
    { runtime: "copilot", model: "gpt-5.4" },
    { runtimeConfig: { version: 1, runtime: "copilot", model: { kind: "preset", id: "gpt-5.4" } } },
  ]) {
    for (const request of [
      { method: "POST", url: `${app.baseUrl}/api/agents`, body: { name: "new-copilot", machineId: machine.id, ...fields } },
      { method: "PATCH", url: `${app.baseUrl}/api/agents/${other.id}`, body: fields },
    ]) {
      const response = await fetch(request.url, { method: request.method, headers, body: JSON.stringify(request.body) });
      assert.equal(response.status, 400, `${request.method} ${JSON.stringify(fields)}`);
      assert.equal((await response.json() as { error: string }).error, deprecatedError);
    }
  }

  // Protocol v2 create (web/mobile form path) is refused the same way.
  const v2Create = await fetch(`${app.baseUrl}/api/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "v2-copilot", machineId: machine.id, formDefinitionRef: { protocolVersion: 2, runtimeId: "copilot" }, formValues: { model: "gpt-5.4" } }),
  });
  assert.equal(v2Create.status, 400);
  assert.deepEqual(await v2Create.json(), { error: deprecatedError });

  // The existing Copilot agent keeps its runtime and can change model, effort and env.
  const edit = await fetch(`${app.baseUrl}/api/agents/${existing.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      description: "still editable",
      runtimeConfig: {
        version: 1,
        runtime: "copilot",
        model: { kind: "custom", name: "vendor/copilot-custom" },
        reasoningEffort: "high",
        envVars: { COPILOT_FLAG: "1" },
      },
    }),
  });
  assert.equal(edit.status, 200, await edit.clone().text());
  const edited = await edit.json() as { runtime: string; description: string; runtimeConfig: { model: unknown; envVars: unknown; reasoningEffort: unknown } };
  assert.equal(edited.runtime, "copilot");
  assert.equal(edited.description, "still editable");
  assert.deepEqual(edited.runtimeConfig.model, { kind: "custom", name: "vendor/copilot-custom" });
  assert.deepEqual(edited.runtimeConfig.envVars, { COPILOT_FLAG: "1" });
  assert.equal(edited.runtimeConfig.reasoningEffort, "high");

  // A legacy field-level model edit on the existing agent is also allowed.
  const legacyEdit = await fetch(`${app.baseUrl}/api/agents/${existing.id}`, {
    method: "PATCH", headers, body: JSON.stringify({ runtime: "copilot", model: "gpt-5.2" }),
  });
  assert.equal(legacyEdit.status, 200, await legacyEdit.clone().text());
  assert.equal((await legacyEdit.json() as { runtime: string }).runtime, "copilot");

  assert.equal((await getAgent(other.id))?.runtime, "codex");
  assert.equal((await getAgent(existing.id))?.runtime, "copilot");

  // Protocol v2 edit (web v2 form, native mobile): the existing agent's form is
  // still served, now labelled edit-only, and a save round-trips.
  const formRes = await fetch(`${app.baseUrl}/api/agents/${existing.id}/runtime-form`, { headers });
  assert.equal(formRes.status, 200);
  const form = await formRes.json() as { runtimeId: string; schemaVersion: string; values: Record<string, unknown> };
  assert.equal(form.runtimeId, "copilot");
  assert.equal(form.schemaVersion, "copilot.edit.v1");
  const v2Edit = await fetch(`${app.baseUrl}/api/agents/${existing.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      formDefinitionRef: { protocolVersion: 2, runtimeId: "copilot" },
      formValues: { ...form.values, model: "gpt-5.4", reasoningEffort: "low", envVars: { NEW: "2" } },
    }),
  });
  assert.equal(v2Edit.status, 200, await v2Edit.clone().text());
  const afterV2 = hydrateRuntimeConfig((await getAgent(existing.id))!);
  assert.equal(afterV2.runtime, "copilot");
  assert.deepEqual(afterV2.model, { kind: "preset", id: "gpt-5.4" });
  assert.equal(afterV2.reasoningEffort, "low");
  assert.deepEqual(afterV2.envVars, { NEW: "2" });

  // Server-served runtime lists (web and native mobile read these): new-agent
  // options omit Copilot; the existing agent's options keep it as grandfathered.
  const newOptions = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-options`, { headers });
  assert.equal(newOptions.status, 200);
  const newIds = (await newOptions.json() as { options: { runtimeId: string }[] }).options.map((option) => option.runtimeId);
  assert.equal(newIds.includes("copilot"), false);
  assert.equal(newIds.includes("codex"), true);
  for (const [agentId, expectCopilot] of [[existing.id, true], [other.id, false]] as const) {
    const existingOptions = await fetch(`${app.baseUrl}/api/agents/${agentId}/runtime-options`, { headers });
    assert.equal(existingOptions.status, 200);
    const copilot = (await existingOptions.json() as { options: { runtimeId: string; admissionReason: string | null; canSelectInThisContext: boolean }[] })
      .options.find((option) => option.runtimeId === "copilot");
    if (expectCopilot) {
      assert.equal(copilot?.admissionReason, "deprecated");
      assert.equal(copilot?.canSelectInThisContext, true);
    } else {
      assert.equal(copilot, undefined);
    }
  }
});

// artin 2026-09-27: installed mobile clients could not save a model — every
// PATCH was 400 "runtimeConfig.loadLocalPlugins must be a boolean". Their
// encoder sends every optional field, unset ones as null. Exact wire shape.
test("PATCH /agents/:id accepts the mobile runtimeConfig shape and keeps an enabled local-extensions choice", async ({ app }) => {
    const owner = await seedUser("mobile-null-owner@slock.test", "mobile-null-owner");
    const server = await createServer("Mobile Null Server", "mobile-null-server", owner.id);
    const token = await tokenForHuman(owner.email);
    const mobileNulls = { reasoningEffort: null, envVars: null, command: null, loadLocalPlugins: null, hostUserState: null };
    const patch = (id: string, runtimeConfig: Record<string, unknown>) =>
      fetch(`${app.baseUrl}/api/agents/${id}`, {
        method: "PATCH",
        headers: { ...authHeaders(token, server.id), "Content-Type": "application/json" },
        body: JSON.stringify({ runtimeConfig }),
      });

    const claude = await createAgent(server.id, "mobile-null-claude", { runtime: "claude", model: "sonnet" });
    const claudeRes = await patch(claude.id, {
      version: 1,
      runtime: "claude",
      provider: { kind: "default" },
      model: { kind: "preset", id: "opus" },
      mode: { kind: "default" },
      ...mobileNulls,
    });
    assert.equal(claudeRes.status, 200, await claudeRes.clone().text());
    assert.equal((await getAgent(claude.id))?.model, "opus");

    const provider = { kind: "gateway", providerId: "openai-compatible", baseUrl: "http://localhost:9876/v1", apiKey: "secret", supportsImageInput: false } as const;
    const builtin = await createAgent(server.id, "mobile-null-builtin", {
      runtime: "builtin",
      model: "model-a",
      runtimeConfig: {
        version: 1,
        runtime: "builtin",
        provider,
        model: { kind: "custom", name: "model-a" },
        mode: { kind: "default" },
        hostUserState: "forbidden",
        loadLocalPlugins: true,
      },
    });
    await placeAgentOnMachine(builtin.id, null);
    const builtinRes = await patch(builtin.id, {
      version: 1,
      runtime: "builtin",
      provider,
      model: { kind: "custom", name: "model-b" },
      mode: { kind: "default" },
      ...mobileNulls,
    });
    assert.equal(builtinRes.status, 200, await builtinRes.clone().text());
    const stored = hydrateRuntimeConfig((await getAgent(builtin.id))!);
    assert.equal(stored.runtime, "builtin");
    assert.ok(stored.runtime === "builtin");
    assert.equal(stored.loadLocalPlugins, true, "a model-only mobile save must not switch local extensions off");

    // An explicit false still turns it off.
    const offRes = await patch(builtin.id, {
      version: 1,
      runtime: "builtin",
      provider,
      model: { kind: "custom", name: "model-b" },
      mode: { kind: "default" },
      ...mobileNulls,
      loadLocalPlugins: false,
    });
    assert.equal(offRes.status, 200);
    const off = hydrateRuntimeConfig((await getAgent(builtin.id))!);
    assert.ok(off.runtime === "builtin");
    assert.equal(off.loadLocalPlugins, false);
});

test("a v2 submit is checked against the v2 registry, not the v1 refs", async ({ app }) => {
  const owner = await seedUser("v2-registry-submit@slock.test", "v2-registry-submit");
  const server = await createServer("V2 Registry Submit", "v2-registry-submit", owner.id);
  const headers = { ...authHeaders(await tokenForHuman(owner.email), server.id), "Content-Type": "application/json" };
  const create = (runtimeId: string, name: string) => fetch(`${app.baseUrl}/api/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name, formDefinitionRef: { protocolVersion: 2, runtimeId }, formValues: { model: "gpt-5.6-sol" } }),
  });

  // A runtime without a v2 form is refused before any value is read. Every
  // catalog runtime has a v2 form since batch 4, so the example is an unknown id.
  const unknownRes = await create("not-a-runtime", "v2-unregistered");
  assert.equal(unknownRes.status, 400);
  assert.deepEqual((await unknownRes.json() as { issues: unknown }).issues, [
    { code: "unknown_form_runtime", pointer: "/formDefinitionRef/runtimeId" },
  ]);

  // A runtime with a v2 form and no v1 ref is accepted: v2 does not need a v1 form.
  const unregister = registerRuntimeFormV2EntryForTests({
    runtimeId: "cursor",
    buildForm: () => { throw new Error("unused"); },
    validateProjection: () => [],
    resolveOptionSource: async () => ({ kind: "source", source: null }),
    runtimeConfigFromValues: (values, envVars) => ({
      ok: true,
      runtimeConfig: {
        version: 1,
        runtime: "cursor",
        model: { kind: "preset", id: String(values.model) },
        mode: { kind: "default" },
        reasoningEffort: null,
        envVars,
      },
    }),
    valuesFromRuntimeConfig: () => null,
  });
  try {
    const res = await create("cursor", "v2-registered");
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json() as { runtime: string; runtimeConfig: { model: unknown } };
    assert.equal(body.runtime, "cursor");
    assert.deepEqual(body.runtimeConfig.model, { kind: "preset", id: "gpt-5.6-sol" }, "the registered entry assembled it");
  } finally {
    unregister();
  }
});

test("batch 2 v2 create: OpenCode stores the legacy runtimeConfig; Kimi CLI, Gemini and Antigravity are refused like legacy deprecated creates", async ({ app }) => {
  const owner = await seedUser("v2-batch2-create@slock.test", "v2-batch2-create");
  const server = await createServer("V2 Batch2 Create", "v2-batch2-create", owner.id);
  const [machine] = await getDb().insert(machines).values({
    serverId: server.id, userId: owner.id, name: "v2-batch2-create-machine",
    apiKeyHash: "v2-batch2-create", runtimes: ["opencode", "kimi", "gemini", "antigravity"],
  }).returning();
  const headers = { ...authHeaders(await tokenForHuman(owner.email), server.id), "Content-Type": "application/json" };
  const create = (runtimeId: string, name: string, formValues: Record<string, unknown>) => fetch(`${app.baseUrl}/api/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name, machineId: machine.id, formDefinitionRef: { protocolVersion: 2, runtimeId }, formValues }),
  });

  const res = await create("opencode", "v2-opencode", { model: "deepseek/deepseek-v4-pro", envVars: { OC_FLAG: "1" }, unrenderedByClient: true });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json() as { id: string; runtime: string; model: string };
  assert.equal(body.runtime, "opencode");
  assert.equal(body.model, "deepseek/deepseek-v4-pro");
  const stored = await getAgent(body.id);
  // Exactly what the legacy web form sends for OpenCode (web buildRuntimeConfig).
  assert.deepEqual(stored?.runtimeConfig, {
    version: 1,
    runtime: "opencode",
    model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
    mode: { kind: "default" },
    reasoningEffort: null,
    envVars: { OC_FLAG: "1" },
  });

  const blankRes = await create("opencode", "v2-opencode-blank", { model: "" });
  assert.equal(blankRes.status, 400);
  assert.deepEqual((await blankRes.json() as { issues: unknown }).issues, [{ code: "model_required", pointer: "/formValues/model" }]);

  for (const [runtimeId, formValues] of [
    ["kimi", { model: "default" }],
    ["gemini", { model: "gemini-2.5-pro" }],
    // Antigravity now has a model field; a server without its OAR flag still refuses the create.
    ["antigravity", { model: "default" }],
  ] as const) {
    const refused = await create(runtimeId, `v2-${runtimeId}`, formValues);
    assert.equal(refused.status, 400, runtimeId);
    assert.deepEqual(await refused.json(), { error: `Runtime is deprecated and cannot be selected: ${runtimeId}` }, runtimeId);
  }
});

test("runtime_form.v3: a protocolVersion 3 submit stores what a v2 one does, and the edit form answers v3 only to a client that advertises it", async ({ app }) => {
  const owner = await seedUser("v3-submit@slock.test", "v3-submit");
  const server = await createServer("V3 Submit", "v3-submit", owner.id);
  const [machine] = await getDb().insert(machines).values({
    serverId: server.id, userId: owner.id, name: "v3-submit-machine", apiKeyHash: "v3-submit", runtimes: ["opencode"],
  }).returning();
  const headers = { ...authHeaders(await tokenForHuman(owner.email), server.id), "Content-Type": "application/json" };
  const create = (protocolVersion: number, name: string) => fetch(`${app.baseUrl}/api/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name, machineId: machine.id, formDefinitionRef: { protocolVersion, runtimeId: "opencode" }, formValues: { model: "deepseek/deepseek-v4-pro", envVars: {} } }),
  });
  const v3Res = await create(3, "v3-opencode");
  assert.equal(v3Res.status, 200, await v3Res.clone().text());
  const v2Res = await create(2, "v2-opencode");
  assert.equal(v2Res.status, 200);
  const v3Agent = await getAgent((await v3Res.json() as { id: string }).id);
  const v2Agent = await getAgent((await v2Res.json() as { id: string }).id);
  assert.deepEqual(v3Agent?.runtimeConfig, v2Agent?.runtimeConfig);
  assert.equal((await create(4, "v4-opencode")).status, 409, "an unknown protocol is never read as v2");

  const editUrl = `${app.baseUrl}/api/agents/${v3Agent!.id}/runtime-form`;
  const v2Edit = await (await fetch(editUrl, { headers })).json() as { protocolVersion: number; revision?: string };
  assert.equal(v2Edit.protocolVersion, 2);
  assert.equal(v2Edit.revision, undefined);
  const v3Edit = await (await fetch(`${editUrl}?clientCapabilities=runtime_form.v3`, { headers })).json() as {
    protocolVersion: number; revision?: string; values: Record<string, unknown>; uiSchema: Record<string, unknown>;
  };
  assert.equal(v3Edit.protocolVersion, 3);
  assert.ok(v3Edit.revision);
  assert.equal(v3Edit.values.model, "deepseek/deepseek-v4-pro");
  assert.ok(Array.isArray(v3Edit.uiSchema.rules));
});

test("batch 3a v2 create and edit: Codex/Grok store the legacy runtimeConfig; the live list decides reasoning efforts; legacy submits are unchanged", async ({ app }) => {
  const owner = await seedUser("v2-batch3a-create@slock.test", "v2-batch3a-create");
  const server = await createServer("V2 Batch3a Create", "v2-batch3a-create", owner.id);
  const [machine] = await getDb().insert(machines).values({
    serverId: server.id, userId: owner.id, name: "v2-batch3a-create-machine",
    apiKeyHash: "v2-batch3a-create", runtimes: ["codex", "grok"],
  }).returning();
  const headers = { ...authHeaders(await tokenForHuman(owner.email), server.id), "Content-Type": "application/json" };
  const probed: string[] = [];
  let probe: (runtime: string) => Promise<unknown> = async () => ({ kind: "live", value: { models: [] } });
  const originalOrchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
  app.app.set("agentOrchestrator", {
    ...originalOrchestrator,
    detectMachineRuntimeModels: async (_machineId: string, runtime: string) => {
      probed.push(runtime);
      return probe(runtime);
    },
  });
  const liveModels = {
    codex: [
      { id: "gpt-7-live", label: "GPT-7", supportedReasoningEfforts: ["medium", "ultra"], defaultReasoningEffort: "medium" },
      { id: "gpt-5.6-sol", label: "Sol", supportedReasoningEfforts: ["low", "medium"] },
    ],
    grok: [{ id: "grok-live-only", label: "Grok live", supportedReasoningEfforts: ["low", "max"] }],
  } as Record<string, unknown[]>;
  probe = async (runtime) => ({ kind: "live", value: { models: liveModels[runtime] ?? [] } });
  const create = (runtimeId: string, name: string, formValues: Record<string, unknown>) => fetch(`${app.baseUrl}/api/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name, machineId: machine.id, formDefinitionRef: { protocolVersion: 2, runtimeId }, formValues }),
  });
  const storedConfig = async (id: string) => (await getAgent(id))?.runtimeConfig as unknown as Record<string, unknown>;

  // A live-only Codex model with an effort only the live list offers: kept, and stored as a preset.
  const live = await create("codex", "v2-codex-live", { model: "gpt-7-live", reasoningEffort: "ultra", fastMode: true, envVars: { K: "v" } });
  assert.equal(live.status, 200, await live.clone().text());
  const liveAgent = await live.json() as { id: string };
  assert.deepEqual(await storedConfig(liveAgent.id), {
    version: 1, runtime: "codex", model: { kind: "preset", id: "gpt-7-live" }, mode: { kind: "fast" }, reasoningEffort: "ultra", envVars: { K: "v" },
  });
  assert.equal((await getAgent(liveAgent.id))?.reasoningEffort, "ultra");
  assert.deepEqual(probed, ["codex"]);

  // An effort the live list does not offer for that model is refused at the field.
  const refused = await create("codex", "v2-codex-refused", { model: "gpt-5.6-sol", reasoningEffort: "ultra" });
  assert.equal(refused.status, 400);
  assert.deepEqual((await refused.json() as { issues: unknown }).issues, [
    { code: "reasoning_effort_not_supported", pointer: "/formValues/reasoningEffort" },
  ]);

  // A typed custom model with fast mode: the legacy custom runtimeConfig.
  const custom = await create("codex", "v2-codex-custom", { model: "my-org/codex-custom", reasoningEffort: "high", fastMode: true });
  assert.equal(custom.status, 200, await custom.clone().text());
  assert.deepEqual(await storedConfig((await custom.json() as { id: string }).id), {
    version: 1, runtime: "codex", model: { kind: "custom", name: "my-org/codex-custom" }, mode: { kind: "fast" }, reasoningEffort: "high", envVars: null,
  });

  const grok = await create("grok", "v2-grok-live", { model: "grok-live-only", reasoningEffort: "max" });
  assert.equal(grok.status, 200, await grok.clone().text());
  const grokAgent = await grok.json() as { id: string };
  assert.equal((await storedConfig(grokAgent.id)).reasoningEffort, "max");

  // Probe not live: the static rule stands (an undeclared effort is dropped, as before).
  probe = async () => ({ kind: "missing_config" });
  const staticRule = await create("grok", "v2-grok-static", { model: "grok-live-only", reasoningEffort: "max" });
  assert.equal(staticRule.status, 200, await staticRule.clone().text());
  assert.equal((await storedConfig((await staticRule.json() as { id: string }).id)).reasoningEffort, null);

  // A legacy (non-v2) submit is never reconciled with the live list: same input, effort dropped, no probe.
  probe = async (runtime) => ({ kind: "live", value: { models: liveModels[runtime] ?? [] } });
  probed.length = 0;
  const legacyRes = await fetch(`${app.baseUrl}/api/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "legacy-codex",
      machineId: machine.id,
      runtimeConfig: { version: 1, runtime: "codex", model: { kind: "preset", id: "gpt-7-live" }, mode: { kind: "default" }, reasoningEffort: "ultra", envVars: null },
    }),
  });
  assert.equal(legacyRes.status, 200, await legacyRes.clone().text());
  assert.equal((await storedConfig((await legacyRes.json() as { id: string }).id)).reasoningEffort, null);
  assert.deepEqual(probed, []);

  // Edit: the stored values come back through GET runtime-form, and a v2 PATCH follows the same live rule.
  const formRes = await fetch(`${app.baseUrl}/api/agents/${liveAgent.id}/runtime-form`, { headers });
  assert.equal(formRes.status, 200);
  const editForm = await formRes.json() as { runtimeId: string; requiredClientCapabilities: string[]; values: Record<string, unknown> };
  assert.equal(editForm.runtimeId, "codex");
  assert.deepEqual(editForm.values, { model: "gpt-7-live", reasoningEffort: "ultra", fastMode: true, envVars: { K: "v" } });
  const patch = (formValues: Record<string, unknown>) => fetch(`${app.baseUrl}/api/agents/${liveAgent.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ formDefinitionRef: { protocolVersion: 2, runtimeId: "codex" }, formValues }),
  });
  const edited = await patch({ ...editForm.values, reasoningEffort: "medium", fastMode: false });
  assert.equal(edited.status, 200, await edited.clone().text());
  assert.deepEqual(await storedConfig(liveAgent.id), {
    version: 1, runtime: "codex", model: { kind: "preset", id: "gpt-7-live" }, mode: { kind: "default" }, reasoningEffort: "medium", envVars: { K: "v" },
  });
  const editRefused = await patch({ ...editForm.values, model: "gpt-5.6-sol", reasoningEffort: "ultra" });
  assert.equal(editRefused.status, 400);
  assert.deepEqual((await editRefused.json() as { issues: unknown }).issues, [
    { code: "reasoning_effort_not_supported", pointer: "/formValues/reasoningEffort" },
  ]);
  app.app.set("agentOrchestrator", originalOrchestrator);
});

test("Antigravity v2 edit: a saved effort the model no longer lists levels for falls back to Default; a newly chosen one is refused", async ({ app }) => {
  const owner = await seedUser("v2-antigravity-effort@slock.test", "v2-antigravity-effort");
  const server = await createServer("V2 Antigravity Effort", "v2-antigravity-effort", owner.id);
  const [machine] = await getDb().insert(machines).values({
    serverId: server.id, userId: owner.id, name: "v2-antigravity-effort-machine",
    apiKeyHash: "v2-antigravity-effort", runtimes: ["antigravity"],
  }).returning();
  const headers = { ...authHeaders(await tokenForHuman(owner.email), server.id), "Content-Type": "application/json" };
  const agent = await createAgent(server.id, "agy-effort", {
    runtime: "antigravity",
    model: "gemini-3.8-flash",
    machineId: machine.id,
    reasoningEffort: "high",
    runtimeConfig: {
      version: 1, runtime: "antigravity", model: { kind: "preset", id: "gemini-3.8-flash" }, mode: { kind: "default" }, reasoningEffort: "high", envVars: null,
    } as RuntimeConfig,
  });
  // agy now starts on another model, so gemini-3.8-flash is listed without levels.
  const originalOrchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
  app.app.set("agentOrchestrator", {
    ...originalOrchestrator,
    detectMachineRuntimeModels: async () => ({
      kind: "live",
      value: {
        models: [
          { id: "gemini-4-pro", label: "Gemini 4 Pro", supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" },
          { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
        ],
        default: "gemini-4-pro",
      },
    }),
  });
  try {
    const storedConfig = async () => (await getAgent(agent.id))?.runtimeConfig as unknown as Record<string, unknown>;
    const editForm = await (await fetch(`${app.baseUrl}/api/agents/${agent.id}/runtime-form`, { headers })).json() as { values: Record<string, unknown> };
    assert.deepEqual(editForm.values, { model: "gemini-3.8-flash", reasoningEffort: "high", envVars: {} });
    const patch = (formValues: Record<string, unknown>) => fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ formDefinitionRef: { protocolVersion: 2, runtimeId: "antigravity" }, formValues }),
    });

    // A newly chosen level the model does not list is refused at the field.
    const refused = await patch({ ...editForm.values, reasoningEffort: "low" });
    assert.equal(refused.status, 400);
    assert.deepEqual((await refused.json() as { issues: unknown }).issues, [
      { code: "reasoning_effort_not_supported", pointer: "/formValues/reasoningEffort" },
    ]);
    assert.equal((await storedConfig()).reasoningEffort, "high", "nothing saved");

    // Saving the form as it came back (the hidden field still holds the saved level) succeeds with Default.
    const saved = await patch({ ...editForm.values, envVars: { K: "v" } });
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.deepEqual(await storedConfig(), {
      version: 1, runtime: "antigravity", model: { kind: "preset", id: "gemini-3.8-flash" }, mode: { kind: "default" }, reasoningEffort: null, envVars: { K: "v" },
    });

    // agy's configured default takes no effort: one sent with it is dropped by the static rule.
    const toDefault = await patch({ model: "default", reasoningEffort: "high", envVars: {} });
    assert.equal(toDefault.status, 200, await toDefault.clone().text());
    assert.deepEqual((await storedConfig()).model, { kind: "preset", id: "default" });
    assert.equal((await storedConfig()).reasoningEffort, null);
  } finally {
    app.app.set("agentOrchestrator", originalOrchestrator);
  }
});

test("v2 edit: a submit for another runtime switches the agent to it, takes nothing from the old runtime's config, and clears the session", async ({ app }) => {
  // The web editor saves a runtime switch through the new runtime's v2 create
  // form (task #8), with the agent's stored config of the old runtime as `existing`.
  const owner = await seedUser("v2-runtime-switch@slock.test", "v2-runtime-switch");
  const server = await createServer("V2 Runtime Switch", "v2-runtime-switch", owner.id);
  const headers = { ...authHeaders(await tokenForHuman(owner.email), server.id), "Content-Type": "application/json" };
  const SECRET = "sk-claude-old-secret-switch";
  const agent = await createAgent(server.id, "v2-runtime-switch", {
    runtime: "claude",
    model: "sonnet",
    runtimeConfig: {
      version: 1, runtime: "claude",
      provider: { kind: "custom", apiUrl: "https://gateway.example.test", apiKey: SECRET },
      model: { kind: "preset", id: "sonnet" }, mode: { kind: "default" }, reasoningEffort: "high",
      envVars: { OLD: "1" }, command: "/opt/claude",
    } as unknown as RuntimeConfig,
  });
  await updateAgentStatus(agent.id, "active", "claude-session-id");

  const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      formDefinitionRef: { protocolVersion: 2, runtimeId: "codex" },
      formValues: { model: "gpt-5.5", envVars: { NEW: "1" } },
      restartMode: "session",
    }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const updated = await getAgent(agent.id);
  assert.equal(updated?.runtime, "codex");
  assert.equal(updated?.sessionId, null);
  const stored = updated?.runtimeConfig as unknown as Record<string, unknown>;
  assert.equal(stored.runtime, "codex");
  assert.deepEqual(stored.envVars, { NEW: "1" });
  assert.equal(JSON.stringify(stored).includes(SECRET), false, "the old runtime's secret is not carried over");
  assert.equal("command" in stored, false, "nor its command");
});

test("PATCH /agents/:id: a cleared reasoning effort stays cleared; the stored one fills in only when the request leaves it out (task #1334)", async ({ app }) => {
  // The legacy reasoningEffort column used to stand in for an explicit null in
  // the submitted runtimeConfig, so switching a Pi agent on high to OpenCode
  // (which has no effort) failed with "reasoningEffort is not supported".
  const owner = await seedUser("effort-clear-switch@slock.test", "effort-clear-switch");
  const server = await createServer("Effort Clear Switch", "effort-clear-switch", owner.id);
  const headers = { ...authHeaders(await tokenForHuman(owner.email), server.id), "Content-Type": "application/json" };
  const piOnHigh = (name: string) => createAgent(server.id, name, {
    runtime: "pi",
    model: "anthropic/sonnet-live",
    reasoningEffort: "high",
    runtimeConfig: {
      version: 1, runtime: "pi", provider: { kind: "default" }, model: { kind: "preset", id: "anthropic/sonnet-live" }, mode: { kind: "default" }, reasoningEffort: "high", envVars: null,
    } as unknown as RuntimeConfig,
  });
  const patch = (id: string, body: Record<string, unknown>) => fetch(`${app.baseUrl}/api/agents/${id}`, { method: "PATCH", headers, body: JSON.stringify(body) });
  const storedEffort = async (id: string) => ((await getAgent(id))?.runtimeConfig as unknown as { reasoningEffort: unknown }).reasoningEffort;

  // Pi -> OpenCode through the v2 form the web editor uses.
  const v2Switch = await piOnHigh("effort-v2-switch");
  const v2Res = await patch(v2Switch.id, { formDefinitionRef: { protocolVersion: 2, runtimeId: "opencode" }, formValues: { model: "deepseek/deepseek-v4-pro" }, restartMode: "session" });
  assert.equal(v2Res.status, 200, await v2Res.clone().text());
  assert.equal((await getAgent(v2Switch.id))?.runtime, "opencode");
  assert.equal(await storedEffort(v2Switch.id), null);

  // Pi -> OpenCode as a structured runtimeConfig with an explicit null.
  const structuredSwitch = await piOnHigh("effort-structured-switch");
  const structuredRes = await patch(structuredSwitch.id, {
    runtimeConfig: { version: 1, runtime: "opencode", model: { kind: "preset", id: "deepseek/deepseek-v4-pro" }, mode: { kind: "default" }, reasoningEffort: null, envVars: null },
  });
  assert.equal(structuredRes.status, 200, await structuredRes.clone().text());
  assert.equal(await storedEffort(structuredSwitch.id), null);

  // Same runtime, effort explicitly cleared.
  const sameRuntime = await piOnHigh("effort-same-runtime-clear");
  const clearRes = await patch(sameRuntime.id, {
    runtimeConfig: { version: 1, runtime: "pi", provider: { kind: "default" }, model: { kind: "preset", id: "anthropic/sonnet-live" }, mode: { kind: "default" }, reasoningEffort: null, envVars: null },
  });
  assert.equal(clearRes.status, 200, await clearRes.clone().text());
  assert.equal(await storedEffort(sameRuntime.id), null);

  // Left out of the request: the stored effort is kept.
  const omitted = await piOnHigh("effort-omitted-keeps");
  const omittedRes = await patch(omitted.id, {
    runtimeConfig: { version: 1, runtime: "pi", provider: { kind: "default" }, model: { kind: "preset", id: "anthropic/sonnet-live" }, mode: { kind: "default" }, envVars: null },
  });
  assert.equal(omittedRes.status, 200, await omittedRes.clone().text());
  assert.equal(await storedEffort(omitted.id), "high");
  const descriptionRes = await patch(omitted.id, { description: "only the description" });
  assert.equal(descriptionRes.status, 200, await descriptionRes.clone().text());
  assert.equal(await storedEffort(omitted.id), "high");
});

test("v2 edit: an older Built-in row with no provider opens with a blank provider instead of 404", async ({ app }) => {
  // The web editor no longer falls back to the v1 form when the v2 edit read
  // fails (task #8), so a hydrated Built-in config without a provider must
  // still get a form: the provider is blank and has to be chosen.
  const owner = await seedUser("v2-builtin-no-provider@slock.test", "v2-builtin-no-provider");
  const server = await createServer("V2 Builtin No Provider", "v2-builtin-no-provider", owner.id);
  const headers = { ...authHeaders(await tokenForHuman(owner.email), server.id), "Content-Type": "application/json" };
  const agent = await createAgent(server.id, "v2-builtin-no-provider", { runtime: "builtin", model: "deepseek/deepseek-v4-pro", runtimeConfig: null, envVars: { KEEP: "1" } });
  assert.equal(hydrateRuntimeConfig((await getAgent(agent.id))!).provider, undefined, "precondition: the row hydrates without a provider");

  const formRes = await fetch(`${app.baseUrl}/api/agents/${agent.id}/runtime-form`, { headers });
  assert.equal(formRes.status, 200, await formRes.clone().text());
  const form = await formRes.json() as { runtimeId: string; values: Record<string, unknown> };
  assert.equal(form.runtimeId, "builtin");
  assert.equal(form.values.providerId, "");
  assert.deepEqual(form.values.envVars, { KEEP: "1" });
});

test("batch 3b v2 edit: Claude's custom-provider API key never comes back through the v2 form, and saving without it keeps the stored key", async ({ app }) => {
  const owner = await seedUser("v2-batch3b-claude@slock.test", "v2-batch3b-claude");
  const server = await createServer("V2 Batch3b Claude", "v2-batch3b-claude", owner.id);
  const headers = { ...authHeaders(await tokenForHuman(owner.email), server.id), "Content-Type": "application/json" };
  const SECRET = "sk-claude-stored-secret-3b";
  const stored = {
    version: 1,
    runtime: "claude",
    provider: { kind: "custom", apiUrl: "https://gateway.example.test", apiKey: SECRET },
    model: { kind: "preset", id: "sonnet" },
    mode: { kind: "default" },
    reasoningEffort: "high",
    envVars: { KEEP: "1" },
    command: "/opt/claude",
  } as unknown as RuntimeConfig;
  const agent = await createAgent(server.id, "v2-claude-provider", { runtime: "claude", model: "sonnet", runtimeConfig: stored });
  const storedProvider = async () => (await getAgent(agent.id))?.runtimeConfig as unknown as { provider: Record<string, unknown>; model: unknown; command?: string };

  // The v2 edit read: the form marks the key write-only and the values leave it out.
  const formRes = await fetch(`${app.baseUrl}/api/agents/${agent.id}/runtime-form`, { headers });
  assert.equal(formRes.status, 200);
  const formText = await formRes.text();
  assert.equal(formText.includes(SECRET), false, "the stored API key is not in the v2 edit response");
  const form = JSON.parse(formText) as { runtimeId: string; values: Record<string, unknown>; capabilities: { writeOnlyPointers: string[] } };
  assert.equal(form.runtimeId, "claude");
  assert.deepEqual(form.capabilities.writeOnlyPointers, ["/apiKey"]);
  assert.deepEqual(form.values, {
    provider: "custom", apiUrl: "https://gateway.example.test", authType: "api_key", model: "sonnet", reasoningEffort: "high", fastMode: false, command: "/opt/claude", envVars: { KEEP: "1" },
  });

  const patch = (formValues: Record<string, unknown>) => fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ formDefinitionRef: { protocolVersion: 2, runtimeId: "claude" }, formValues }),
  });
  // Saving without touching the key (blank, as the client shows it, or absent) keeps it.
  const blank = await patch({ ...form.values, apiKey: "", model: "opus" });
  assert.equal(blank.status, 200, await blank.clone().text());
  assert.deepEqual((await storedProvider()).provider, { kind: "custom", apiUrl: "https://gateway.example.test", apiKey: SECRET });
  assert.deepEqual((await storedProvider()).model, { kind: "preset", id: "opus" });
  assert.equal((await storedProvider()).command, "/opt/claude");
  const absent = await patch({ ...form.values, model: "haiku" });
  assert.equal(absent.status, 200, await absent.clone().text());
  assert.equal((await storedProvider()).provider.apiKey, SECRET);

  // A different API URL never inherits the stored key: asked for at the field, nothing saved.
  const moved = await patch({ ...form.values, apiUrl: "https://other.example.test", apiKey: "" });
  assert.equal(moved.status, 400);
  assert.deepEqual((await moved.json() as { issues: unknown }).issues, [{ code: "api_key_required", pointer: "/formValues/apiKey" }]);
  assert.deepEqual((await storedProvider()).provider, { kind: "custom", apiUrl: "https://gateway.example.test", apiKey: SECRET });

  // A typed key replaces it; switching to Default drops the provider secret.
  const replaced = await patch({ ...form.values, apiKey: " sk-new " });
  assert.equal(replaced.status, 200, await replaced.clone().text());
  assert.equal((await storedProvider()).provider.apiKey, "sk-new");
  const toDefault = await patch({ ...form.values, provider: "default" });
  assert.equal(toDefault.status, 200, await toDefault.clone().text());
  assert.deepEqual((await storedProvider()).provider, { kind: "default" });
});

test("v2 edit: a Claude agent whose custom provider lives in the launch mirrors keeps its key on a blank save, and a changed URL or provider still asks for one", async ({ app }) => {
  const owner = await seedUser("v2-claude-mirror-key@slock.test", "v2-claude-mirror-key");
  const server = await createServer("V2 Claude Mirror Key", "v2-claude-mirror-key", owner.id);
  const headers = { ...authHeaders(await tokenForHuman(owner.email), server.id), "Content-Type": "application/json" };
  const SECRET = "sk-claude-mirror-secret";
  // Historical shape (hydrateLegacyRuntimeConfigWithTrace): the structured
  // provider lost its URL and key, which survive only in the agent's envVars
  // launch mirrors. Read and launch paths hydrate it to the custom provider.
  const stripped = {
    version: 1,
    runtime: "claude",
    provider: { kind: "custom", apiUrl: "", apiKey: "" },
    model: { kind: "custom", name: "claude-opus-5-5" },
    mode: { kind: "default" },
    reasoningEffort: null,
    envVars: null,
  } as unknown as RuntimeConfig;
  const mirrors = { ANTHROPIC_BASE_URL: "https://llm-gateway.example.com", ANTHROPIC_API_KEY: SECRET, ANTHROPIC_CUSTOM_MODEL_OPTION: "claude-opus-5-5" };
  const agent = await createAgent(server.id, "v2-claude-mirror", { runtime: "claude", model: "claude-opus-5-5", runtimeConfig: stripped, envVars: mirrors });
  const storedProvider = async (id: string) => ((await getAgent(id))?.runtimeConfig as unknown as { provider: Record<string, unknown> }).provider;
  const patch = (id: string, formValues: Record<string, unknown>) => fetch(`${app.baseUrl}/api/agents/${id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ formDefinitionRef: { protocolVersion: 2, runtimeId: "claude" }, formValues, restartMode: "restart" }),
  });

  // The edit read shows the provider the agent actually launches with, never the key.
  const formRes = await fetch(`${app.baseUrl}/api/agents/${agent.id}/runtime-form`, { headers });
  assert.equal(formRes.status, 200);
  const formText = await formRes.text();
  assert.equal(formText.includes(SECRET), false, "the stored API key is not in the v2 edit response");
  const form = JSON.parse(formText) as { values: Record<string, unknown> };
  assert.equal(form.values.provider, "custom");
  assert.equal(form.values.apiUrl, "https://llm-gateway.example.com");

  const exact = { provider: "custom", apiUrl: "https://llm-gateway.example.com/", apiKey: "", model: "claude-opus-5-5", reasoningEffort: null, fastMode: false, command: "", envVars: {} };
  // A changed endpoint never inherits the key; nothing is saved.
  const moved = await patch(agent.id, { ...exact, apiUrl: "https://other.example.test/" });
  assert.equal(moved.status, 400);
  assert.deepEqual((await moved.json() as { issues: unknown }).issues, [{ code: "api_key_required", pointer: "/formValues/apiKey" }]);
  assert.deepEqual(await storedProvider(agent.id), stripped.provider);

  // The production request: blank key, same endpoint (trailing slash aside) → keeps the key.
  const saved = await patch(agent.id, exact);
  assert.equal(saved.status, 200, await saved.clone().text());
  assert.deepEqual(await storedProvider(agent.id), { kind: "custom", apiUrl: "https://llm-gateway.example.com/", apiKey: SECRET });

  // Provider switch: an agent on Default has no key to keep.
  const onDefault = await createAgent(server.id, "v2-claude-default", {
    runtime: "claude",
    model: "sonnet",
    runtimeConfig: { ...stripped, provider: { kind: "default" }, model: { kind: "preset", id: "sonnet" } } as unknown as RuntimeConfig,
  });
  const switched = await patch(onDefault.id, exact);
  assert.equal(switched.status, 400);
  assert.deepEqual((await switched.json() as { issues: unknown }).issues, [{ code: "api_key_required", pointer: "/formValues/apiKey" }]);
  assert.deepEqual(await storedProvider(onDefault.id), { kind: "default" });

  // Stripped provider with no mirrors: the key is gone, so the read shows Default and a blank custom save is refused.
  const lost = await createAgent(server.id, "v2-claude-lost-key", { runtime: "claude", model: "claude-opus-5-5", runtimeConfig: stripped });
  const lostForm = await (await fetch(`${app.baseUrl}/api/agents/${lost.id}/runtime-form`, { headers })).json() as { values: Record<string, unknown> };
  assert.equal(lostForm.values.provider, "default");
  const lostSave = await patch(lost.id, exact);
  assert.equal(lostSave.status, 400);
  assert.deepEqual((await lostSave.json() as { issues: unknown }).issues, [{ code: "api_key_required", pointer: "/formValues/apiKey" }]);
});

test("batch 4 v2 create and edit: Pi stores the legacy runtimeConfig, its built-in provider key is write-only in v2, and legacy saves are unchanged", async ({ app }) => {
  const owner = await seedUser("v2-batch4-pi@slock.test", "v2-batch4-pi");
  const server = await createServer("V2 Batch4 Pi", "v2-batch4-pi", owner.id);
  const [machine] = await getDb().insert(machines).values({
    serverId: server.id, userId: owner.id, name: "v2-batch4-pi-machine",
    apiKeyHash: "v2-batch4-pi", runtimes: ["pi"],
  }).returning();
  const headers = { ...authHeaders(await tokenForHuman(owner.email), server.id), "Content-Type": "application/json" };
  const originalOrchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
  app.app.set("agentOrchestrator", {
    ...originalOrchestrator,
    detectMachineRuntimeModels: async () => ({ kind: "live", value: { models: [{ id: "anthropic/sonnet-live", label: "Sonnet · Anthropic" }] } }),
  });
  try {
    const SECRET = "sk-pi-deepseek-stored-4";
    const storedConfig = async (id: string) => (await getAgent(id))?.runtimeConfig as unknown as Record<string, unknown>;
    const create = (name: string, formValues: Record<string, unknown>) => fetch(`${app.baseUrl}/api/agents`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name, machineId: machine.id, formDefinitionRef: { protocolVersion: 2, runtimeId: "pi" }, formValues }),
    });

    // Configured: a model only the Computer's live list names is a preset, as legacy stores a picked one.
    const configured = await create("v2-pi-configured", { provider: "configured", model: "anthropic/sonnet-live", reasoningEffort: "high" });
    assert.equal(configured.status, 200, await configured.clone().text());
    assert.deepEqual(await storedConfig((await configured.json() as { id: string }).id), {
      version: 1, runtime: "pi", provider: { kind: "default" }, model: { kind: "preset", id: "anthropic/sonnet-live" }, mode: { kind: "default" }, reasoningEffort: "high", envVars: null,
    });

    // Pi's "off" is kept in runtimeConfig only: the legacy column, which the agent
    // API exposes to CLIs that validate it against the older set, stays empty.
    const off = await create("v2-pi-off", { provider: "configured", model: "anthropic/sonnet-live", reasoningEffort: "off" });
    assert.equal(off.status, 200, await off.clone().text());
    const offAgent = await getAgent((await off.json() as { id: string }).id);
    assert.equal((offAgent?.runtimeConfig as { reasoningEffort?: unknown } | null)?.reasoningEffort, "off");
    assert.equal(offAgent?.reasoningEffort ?? null, null);

    // DeepSeek: the key and a model from the provider's list.
    const created = await create("v2-pi-deepseek", { provider: "deepseek", apiKey: SECRET, providerModel: "deepseek/deepseek-v4-pro", providerReasoningEffort: "low", envVars: { KEEP: "1" } });
    assert.equal(created.status, 200, await created.clone().text());
    const agentId = (await created.json() as { id: string }).id;
    const stored = {
      version: 1, runtime: "pi", provider: { kind: "pi-builtin", providerId: "deepseek", apiKey: SECRET }, model: { kind: "preset", id: "deepseek/deepseek-v4-pro" }, mode: { kind: "default" }, reasoningEffort: "low", envVars: { KEEP: "1" },
    };
    assert.deepEqual(await storedConfig(agentId), stored);

    // The v2 edit read: the key is write-only and not in the values.
    const formRes = await fetch(`${app.baseUrl}/api/agents/${agentId}/runtime-form`, { headers });
    assert.equal(formRes.status, 200);
    const formText = await formRes.text();
    assert.equal(formText.includes(SECRET), false, "the stored API key is not in the v2 edit response");
    const form = JSON.parse(formText) as { values: Record<string, unknown>; capabilities: { writeOnlyPointers: string[] } };
    assert.deepEqual(form.capabilities.writeOnlyPointers, ["/apiKey"]);
    assert.deepEqual(form.values, { provider: "deepseek", providerModel: "deepseek/deepseek-v4-pro", providerReasoningEffort: "low", envVars: { KEEP: "1" } });

    const patch = (body: Record<string, unknown>) => fetch(`${app.baseUrl}/api/agents/${agentId}`, { method: "PATCH", headers, body: JSON.stringify(body) });
    const patchV2 = (formValues: Record<string, unknown>) => patch({ formDefinitionRef: { protocolVersion: 2, runtimeId: "pi" }, formValues });
    // Saving without touching the key keeps it.
    const blank = await patchV2({ ...form.values, apiKey: "", providerModel: "deepseek/deepseek-flash" });
    assert.equal(blank.status, 200, await blank.clone().text());
    assert.deepEqual(await storedConfig(agentId), { ...stored, model: { kind: "preset", id: "deepseek/deepseek-flash" } });

    // The v1 agent read still returns the key (legacy web and apps prefill it from here).
    const read = await fetch(`${app.baseUrl}/api/agents/${agentId}`, { headers });
    assert.equal(read.status, 200);
    assert.equal(((await read.json() as { runtimeConfig: { provider: { apiKey: string } } }).runtimeConfig.provider.apiKey), SECRET);

    // A legacy (non-v2) save with the full runtimeConfig is stored exactly as sent.
    const legacyConfig = { ...stored, provider: { kind: "pi-builtin", providerId: "deepseek", apiKey: "sk-legacy-typed" }, reasoningEffort: "medium" };
    const legacySave = await patch({ runtimeConfig: legacyConfig });
    assert.equal(legacySave.status, 200, await legacySave.clone().text());
    assert.deepEqual(await storedConfig(agentId), legacyConfig);
    const legacyConfigured = { version: 1, runtime: "pi", provider: { kind: "default" }, model: { kind: "custom", name: "my-org/pi-custom" }, mode: { kind: "default" }, reasoningEffort: "xhigh", envVars: null };
    const legacyToConfigured = await patch({ runtimeConfig: legacyConfigured });
    assert.equal(legacyToConfigured.status, 200, await legacyToConfigured.clone().text());
    assert.deepEqual(await storedConfig(agentId), legacyConfigured);

    // Switching back to DeepSeek needs a key: nothing stored to keep.
    const noKey = await patchV2({ provider: "deepseek", apiKey: "", providerModel: "deepseek/deepseek-v4-pro" });
    assert.equal(noKey.status, 400);
    assert.deepEqual((await noKey.json() as { issues: unknown }).issues, [{ code: "api_key_required", pointer: "/formValues/apiKey" }]);
    assert.deepEqual(await storedConfig(agentId), legacyConfigured);
  } finally {
    app.app.set("agentOrchestrator", originalOrchestrator);
  }
});

test("batch 2 v2 edit: Gemini, Kimi CLI and Antigravity round-trip through GET runtime-form and PATCH", async ({ app }) => {
  const owner = await seedUser("v2-batch2-edit@slock.test", "v2-batch2-edit");
  const server = await createServer("V2 Batch2 Edit", "v2-batch2-edit", owner.id);
  const headers = { ...authHeaders(await tokenForHuman(owner.email), server.id), "Content-Type": "application/json" };
  const config = (runtime: string, model: Record<string, string>, envVars: Record<string, string> | null) => ({
    version: 1, runtime, model, mode: { kind: "default" }, reasoningEffort: null, envVars,
  }) as unknown as RuntimeConfig;
  const cases = [
    { runtime: "gemini", stored: config("gemini", { kind: "preset", id: "gemini-2.5-pro" }, { OLD: "1" }), values: { model: "gemini-2.5-pro", envVars: { OLD: "1" } }, edit: { model: "gemini-2.5-flash" } },
    { runtime: "kimi", stored: config("kimi", { kind: "preset", id: "default" }, null), values: { model: "default", envVars: {} }, edit: { model: "kimi-live-model" } },
    // Antigravity has a model and an effort now; a typed model with no live list to check stays custom.
    { runtime: "antigravity", stored: config("antigravity", { kind: "custom", name: "agy-picked" }, { OLD: "1" }), values: { model: "agy-picked", reasoningEffort: "", envVars: { OLD: "1" } }, edit: { model: "agy-other" } },
  ];
  for (const { runtime, stored, values, edit } of cases) {
    const agent = await createAgent(server.id, `v2-edit-${runtime}`, { runtime, model: "x", runtimeConfig: stored });
    const formRes = await fetch(`${app.baseUrl}/api/agents/${agent.id}/runtime-form`, { headers });
    assert.equal(formRes.status, 200, runtime);
    const form = await formRes.json() as { protocolVersion: number; runtimeId: string; values: Record<string, unknown> };
    assert.equal(form.protocolVersion, 2);
    assert.equal(form.runtimeId, runtime);
    assert.deepEqual(form.values, values, runtime);

    const patch = (formValues: Record<string, unknown>) => fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ formDefinitionRef: { protocolVersion: 2, runtimeId: runtime }, formValues }),
    });
    // Saving the values unchanged stores the same runtimeConfig.
    const sameRes = await patch(form.values);
    assert.equal(sameRes.status, 200, `${runtime}: ${await sameRes.clone().text()}`);
    assert.deepEqual(hydrateRuntimeConfig((await getAgent(agent.id))!), hydrateRuntimeConfig({ runtime, model: "x", runtimeConfig: stored } as never), runtime);

    const editRes = await patch({ ...form.values, ...edit, envVars: { NEW: "2" } });
    assert.equal(editRes.status, 200, `${runtime}: ${await editRes.clone().text()}`);
    const after = hydrateRuntimeConfig((await getAgent(agent.id))!);
    assert.deepEqual(after.envVars, { NEW: "2" }, runtime);
    assert.deepEqual(after.model, runtime === "antigravity" ? { kind: "custom", name: "agy-other" } : { kind: "preset", id: (edit as { model: string }).model }, runtime);
    assert.equal(after.runtime, runtime);
  }
});

test("protocol v2 create points issues found after assembly at the submitted field", async ({ app }) => {
  const owner = await seedUser("kimi-v2-pointer@slock.test", "kimi-v2-pointer");
  const server = await createServer("Kimi V2 Pointer", "kimi-v2-pointer", owner.id);
  const [machine] = await getDb().insert(machines).values({
    serverId: server.id, userId: owner.id, name: "kimi-v2-machine",
    apiKeyHash: "kimi-v2-pointer", runtimes: ["kimi-sdk"],
  }).returning();
  const headers = { ...authHeaders(await tokenForHuman(owner.email), server.id), "Content-Type": "application/json" };
  const orchestrator = app.app.get("agentOrchestrator") as {
    detectMachineRuntimeModels: (machineId: string, runtime: string) => Promise<unknown>;
  };
  orchestrator.detectMachineRuntimeModels = async () => ({
    kind: "live", value: { default: "kimi-code/k3", models: [{ id: "kimi-code/k3", label: "Kimi K3" }] },
  });
  const res = await fetch(`${app.baseUrl}/api/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "V2Kimi",
      runtime: "kimi-sdk",
      machineId: machine.id,
      formDefinitionRef: { protocolVersion: 2, runtimeId: "kimi-sdk" },
      formValues: { model: "kimi-code/not-on-this-computer" },
    }),
  });
  const body = await res.json() as { issues?: Array<{ pointer: string }> };
  assert.equal(res.status >= 400, true, JSON.stringify(body));
  assert.ok(body.issues?.length, JSON.stringify(body));
  for (const issue of body.issues ?? []) {
    assert.equal(issue.pointer, "/formValues/model", "a v2 client can only act on /formValues pointers");
  }
});

// Review follow-up: untrusted form ID must be rejected before UUID DB lookup.
test("review: v2 malformed connection id returns 400", async ({ app }) => {
  const owner = await seedUser("review-v2-id@slock.test", "review-v2-id");
  const server = await createServer("Review Connection Id", "review-connection-id", owner.id);
  await getDb().insert(featureFlagRules).values({ id: randomUUID(), flagKey: PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [server.id] });
  const token = await tokenForHuman(owner.email);
  const absent = await fetch(`${app.baseUrl}/api/agents`, { method: "POST", headers: { ...authHeaders(token, server.id), "Content-Type": "application/json" }, body: JSON.stringify({ name: "review-absent", formDefinitionRef: { protocolVersion: 2, runtimeId: "builtin" }, formValues: { providerId: "connection:11111111-1111-4111-8111-111111111111", model: "deepseek/deepseek-v4-pro" } }) });
  assert.equal(absent.status, 409, await absent.clone().text());
  const res = await fetch(`${app.baseUrl}/api/agents`, { method: "POST", headers: { ...authHeaders(token, server.id), "Content-Type": "application/json" }, body: JSON.stringify({ name: "review-malformed", formDefinitionRef: { protocolVersion: 2, runtimeId: "builtin" }, formValues: { providerId: "connection:not-a-uuid", model: "deepseek/deepseek-v4-pro" } }) });
  assert.equal(res.status, 400, await res.clone().text());
});

test("RFC 071 §5: Start and Reset are explicit human controls; PATCH lifts the terminal breaker only on a real runtime value change", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("rfc071-controls-owner@slock.test", "rfc071-controls-owner");
  const server = await createServer("RFC071 Controls Server", "rfc071-controls-server", owner.id);
  const [machine] = await db.insert(machines).values({
    serverId: server.id,
    userId: owner.id,
    name: "rfc071-controls-machine",
    apiKeyHash: "rfc071-controls-machine-hash",
  }).returning();
  const agent = await createAgent(server.id, "rfc071-controls-agent", {
    runtime: "codex",
    model: "gpt-5.6-sol",
    machineId: machine!.id,
    creatorType: "user",
    creatorId: owner.id,
  });
  const token = await tokenForHuman(owner.email);
  const starts: unknown[] = [];
  const resets: unknown[] = [];
  const lifts: unknown[] = [];
  const originalOrchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
  app.app.set("agentOrchestrator", {
    ...originalOrchestrator,
    hasMachineLocally: () => true,
    evictCache: () => {},
    startAgent: async (agentId: string, options?: unknown) => {
      starts.push({ agentId, options });
      return { outcome: "dispatched" as const };
    },
    resetAgent: async (agentId: string, mode: string, options?: unknown) => {
      resets.push({ agentId, mode, options });
    },
    liftWakeBlockForConfigChange: async (agentId: string, options?: unknown) => {
      lifts.push({ agentId, options });
    },
  });

  const start = await fetch(`${app.baseUrl}/api/agents/${agent.id}/start`, { method: "POST", headers: authHeaders(token, server.id) });
  assert.equal(start.status, 200);
  assert.deepEqual(starts, [{ agentId: agent.id, options: { control: "human_start" } }]);

  const reset = await fetch(`${app.baseUrl}/api/agents/${agent.id}/reset`, {
    method: "POST",
    headers: { ...authHeaders(token, server.id), "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "session" }),
  });
  assert.equal(reset.status, 202);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(resets, [{ agentId: agent.id, mode: "session", options: { terminalControl: "human_reset" } }]);

  // Same model value: presence alone is not a change (F3).
  const same = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
    method: "PATCH",
    headers: { ...authHeaders(token, server.id), "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol" }),
  });
  assert.equal(same.status, 200);
  assert.deepEqual(lifts.at(-1), { agentId: agent.id, options: { runtimeValuesChanged: false, runtimeOrModelChanged: false } });

  // #triage:#263: another model clears the old one's runtime error (in the orchestrator).
  const model = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
    method: "PATCH",
    headers: { ...authHeaders(token, server.id), "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.6-terra",
      runtimeConfig: { version: 1, runtime: "codex", model: { kind: "preset", id: "gpt-5.6-terra" }, mode: { kind: "default" }, reasoningEffort: null, envVars: null },
    }),
  });
  assert.equal(model.status, 200);
  assert.deepEqual(lifts.at(-1), { agentId: agent.id, options: { runtimeValuesChanged: true, runtimeOrModelChanged: true } });

  const changed = await fetch(`${app.baseUrl}/api/agents/${agent.id}`, {
    method: "PATCH",
    headers: { ...authHeaders(token, server.id), "Content-Type": "application/json" },
    body: JSON.stringify({ reasoningEffort: "high" }),
  });
  assert.equal(changed.status, 200);
  assert.deepEqual(lifts.at(-1), { agentId: agent.id, options: { runtimeValuesChanged: true, runtimeOrModelChanged: false } });
});

test("GET /api/agents survives a version-floor check that throws for one machine", async ({ app }) => {
  const owner = await seedUser("gate-throw-owner@slock.test", "gate-throw-owner");
  const server = await createServer("Gate Throw Server", "gate-throw-server", owner.id);
  const [machine] = await getDb().insert(machines).values({
    serverId: server.id,
    userId: owner.id,
    name: "gate-throw-machine",
    apiKeyHash: "gate-throw-machine-hash",
    runtimes: ["codex"],
  }).returning();
  const agent = await createAgent(server.id, "gate-throw-agent", {
    runtime: "codex",
    creatorType: "user",
    creatorId: owner.id,
    machineId: machine!.id,
  });
  const orchestrator = app.app.get("agentOrchestrator") as { isMachineAgentWorkHeld: (machineId: string) => Promise<boolean> };
  const original = orchestrator.isMachineAgentWorkHeld;
  // A synchronous throw, not a rejected promise: `.catch()` on the call would not see it.
  orchestrator.isMachineAgentWorkHeld = () => {
    throw new Error("version floor unavailable");
  };
  try {
    const res = await fetch(`${app.baseUrl}/api/agents`, { headers: authHeaders(await tokenForHuman(owner.email), server.id) });
    assert.equal(res.status, 200);
    const list = await res.json() as Array<{ id: string; blockedReason?: string | null }>;
    assert.equal(list.find((entry) => entry.id === agent.id)?.blockedReason, null, "a failed check reads as not held");
  } finally {
    orchestrator.isMachineAgentWorkHeld = original;
  }
});

test("POST /agents/:id/interrupt-turn stops the current turn through the orchestrator and reports why it could not (task #25)", async ({ app }) => {
  const owner = await seedUser("interrupt-turn-owner@slock.test", "interrupt-turn-owner");
  const server = await createServer("Interrupt Turn Server", "interrupt-turn-server", owner.id);
  const agent = await createAgent(server.id, "interrupt-turn-target", { runtime: "codex", creatorType: "user", creatorId: owner.id });
  const token = await tokenForHuman(owner.email);
  const original = app.app.get("agentOrchestrator");
  const calls: Array<{ agentId: string; machineId: string | null }> = [];
  let next: () => Promise<unknown> = async () => ({ outcome: "restarted", toolName: "bash", stuckForMs: 660_000 });
  app.app.set("agentOrchestrator", {
    ...original,
    interruptAgentTurn: async (agentId: string, machineId: string | null) => {
      calls.push({ agentId, machineId });
      return next();
    },
  });
  onTestFinished(() => {
    app.app.set("agentOrchestrator", original);
  });
  const post = async () => {
    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}/interrupt-turn`, { method: "POST", headers: authHeaders(token, server.id) });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };

  assert.deepEqual(await post(), { status: 200, body: { outcome: "restarted", toolName: "bash", stuckForMs: 660_000 } });
  assert.equal(calls[0]?.agentId, agent.id);

  next = async () => ({ outcome: "computer_upgrade_required" });
  const upgrade = await post();
  assert.equal(upgrade.status, 409);
  assert.equal(upgrade.body.code, "computer_upgrade_required");

  next = async () => ({ outcome: "computer_offline" });
  assert.equal((await post()).body.code, "computer_offline");

  next = async () => {
    throw new RouteFailureError("daemon_timeout", "Machine response timed out");
  };
  const timeout = await post();
  assert.equal(timeout.status, 504);
  assert.equal(timeout.body.code, "computer_timeout");

  const other = await createServer("Interrupt Turn Other", "interrupt-turn-other", owner.id);
  const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}/interrupt-turn`, { method: "POST", headers: authHeaders(token, other.id) });
  assert.equal(res.status, 404, "an agent of another server is not found");
});

test("POST /agents/:id/subagents/:taskId/interrupt stops one sub-agent through the orchestrator (#proj-runtime:#41)", async ({ app }) => {
  const owner = await seedUser("interrupt-subagent-owner@slock.test", "interrupt-subagent-owner");
  const server = await createServer("Interrupt Subagent Server", "interrupt-subagent-server", owner.id);
  const agent = await createAgent(server.id, "interrupt-subagent-target", { runtime: "codex", creatorType: "user", creatorId: owner.id });
  const token = await tokenForHuman(owner.email);
  const original = app.app.get("agentOrchestrator");
  const calls: Array<{ agentId: string; machineId: string | null; taskId: string }> = [];
  let next: () => Promise<unknown> = async () => ({ outcome: "interrupted" });
  app.app.set("agentOrchestrator", {
    ...original,
    interruptAgentSubagent: async (agentId: string, machineId: string | null, taskId: string) => {
      calls.push({ agentId, machineId, taskId });
      return next();
    },
  });
  onTestFinished(() => {
    app.app.set("agentOrchestrator", original);
  });
  const post = async (taskId = "thread-child", as = token) => {
    const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}/subagents/${encodeURIComponent(taskId)}/interrupt`, { method: "POST", headers: authHeaders(as, server.id) });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };

  assert.deepEqual(await post(), { status: 200, body: { outcome: "interrupted" } });
  assert.deepEqual(calls[0], { agentId: agent.id, machineId: agent.machineId ?? null, taskId: "thread-child" });

  next = async () => ({ outcome: "computer_upgrade_required" });
  const upgrade = await post();
  assert.equal(upgrade.status, 409);
  assert.equal(upgrade.body.code, "computer_upgrade_required");

  const callsBefore = calls.length;
  assert.equal((await post("x".repeat(161))).status, 400, "an over-long sub-agent id");
  const other = await createServer("Interrupt Subagent Other", "interrupt-subagent-other", owner.id);
  const res = await fetch(`${app.baseUrl}/api/agents/${agent.id}/subagents/thread-child/interrupt`, { method: "POST", headers: authHeaders(token, other.id) });
  assert.equal(res.status, 404, "an agent of another server is not found");
  assert.equal(calls.length, callsBefore, "no request for a refused stop");
});
