import { handlerTraceEvents } from "../test/handlerTraceEvents";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { parseRuntimeFormV2, releasedRuntimeFormDefinition } from "@botiverse/raft-runtime-form";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import argon2 from "argon2";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  BasicTracer,
  COMPUTER_CAPABILITY_SERVICE_IPC_UNREACHABLE,
  COMPUTER_CAPABILITY_SUPERVISOR_MUTATIONS,
  KIMI_SDK_FORM_DEFINITION_REF,
  MemoryTraceSink,
  PI_BUILTIN_PROVIDER_MODELS,
  PRO_AGENT_SEAT_BLOCK_SIZE,
  REMOTE_COMPUTER_UPGRADE_PLATFORM_HOLD_FEATURE_FLAG_KEYS,
  RAFT_CLIENT_CAPABILITIES_HEADER,
  RUNTIMES,
  RUNTIME_USAGE_WINDOW_SCOPE_CLIENT_CAPABILITY,
  SERVER_GUEST_FEATURE_FLAG_KEY,
  SERVER_RUNTIME_CATALOG_VERSION,
  traceEventRowsForSpan,
  type ServerRuntimeCatalog,
} from "@botiverse/raft-shared";
import { openTestApp } from "../test/integration/app";
import { seedPlaywrightScenario } from "../test/seedPlaywrightScenario";
import { getDb } from "../db/index";
import { agentMigrations, agentRuntimeProfiles, agents, channelHumans, channels as channelsTable, computerLifecycleDispatches, computerLifecycleOperationTargets, computerLifecycleOperations, computerOutageOccurrences, computerRevokeTokens, computers, featureFlagRules, featureFlags, jointChannels, jointChannelServers, machines, serverAgentMembers, serverInvites, serverJoinLinks, serverMemberRoleAuditEvents, serverMembers, servers as serversTable, subscriptions, users } from "../db/schema";
import { createServer, getMemberSidebarOrder, removeMember, updateMemberSidebarOrder } from "../services/serverService";
import { addHuman, createChannel, deleteChannel, findOrCreateDM, findOrCreateUserDM } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { createAgent, deleteAgent } from "../services/agentService";
import { completeAgentMigrationAutoStart } from "../services/agentMigrationService";
import { beginTestAgentMigration } from "../test/agentMigrationFixture";
import { registerMachine } from "../services/machineService";
import * as computerVersionService from "../services/computerVersionService";
import { getLatestComputerReleaseNotes, getLatestComputerVersion, __resetLatestComputerVersionForTest } from "../services/computerVersionService";
import { OFFICIAL_ONBOARDING_AGENT_IDENTITY } from "../services/officialOnboardingAgentIdentity";
import { computerUpgradeRequests } from "../db/schema";
import { getOpenComputerUpgradeRequest } from "../services/computerUpgradeRequestService";
import { __clearRuntimeAccountUsageLocalCacheForTests, runtimeAccountUsageCacheService } from "../services/runtimeAccountUsageCacheService";
import { __clearMachineRuntimeModelCatalogLocalCacheForTests, machineRuntimeModelCatalogService } from "../services/machineRuntimeModelCatalogService";
import { RouteFailureError } from "../tracing/routeFailure";
import { MachineCatalogStaleError } from "../services/machineCatalogAuthority";
import { ComputerProbeCacheService, createLocalComputerProbeCacheBackend } from "../services/computerProbeCacheService";
import { buildRuntimeFormV2, removeRuntimeFormV2EntryForTests } from "../services/runtimeFormV2Registry";
import {
  evaluateBroadcastPolicy,
  type ComputerBroadcastPolicyDecision,
  type EvaluateComputerBroadcastPolicyInput,
} from "../services/computerBroadcastPolicyService";
import { seedBoundGuest } from "../test/guestFixture";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const ONE_BY_ONE_GIF = Buffer.from(
  "R0lGODdhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=",
  "base64",
);

const TRACE_EVENT_ROW_TEST_RESOURCE = {
  serviceName: "slock-server",
  deploymentEnvironment: "test",
};

interface EmittedEvent {
  room: string;
  event: string;
  payload: unknown;
}

function testBroadcastPolicyDecision(
  input: EvaluateComputerBroadcastPolicyInput,
  overrides: Partial<ComputerBroadcastPolicyDecision> = {},
): ComputerBroadcastPolicyDecision {
  return {
    eligibility: "no_broadcast",
    reasonCode: "policy_row_missing",
    policyRevision: "test-policy-v1",
    sourceVersion: input.source?.version ?? null,
    sourceObservedAt: input.source?.observedAt ?? null,
    sourceProvenance: input.source?.provenance ?? null,
    platform: input.platform,
    targetVersion: null,
    targetRole: null,
    migrationClass: null,
    policyRow: null,
    ...overrides,
  };
}

function installFakeIo(app: { set: (key: string, value: unknown) => void }): EmittedEvent[] {
  const events: EmittedEvent[] = [];
  app.set("io", {
    to(room: string) {
      return {
        emit(event: string, payload: unknown) {
          events.push({ room, event, payload });
        },
      };
    },
  });
  return events;
}

test("pglite-backed API app can login and list seeded servers without docker", async ({ app }) => {
    const seed = await seedPlaywrightScenario();

    const loginResponse = await fetch(`${app.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: seed.user.email,
        password: seed.user.password,
      }),
    });
    assert.equal(loginResponse.status, 200);
    const loginData = await loginResponse.json() as { accessToken: string };
    assert.ok(loginData.accessToken);

    const serversResponse = await fetch(`${app.baseUrl}/api/servers`, {
      headers: {
        Authorization: `Bearer ${loginData.accessToken}`,
      },
    });
    assert.equal(serversResponse.status, 200);
    const servers = await serversResponse.json() as Array<{ slug: string }>;
    assert.deepEqual(
      servers.map((server) => server.slug),
      [seed.server.slug],
    );
});

test("GET/PATCH /api/servers/order persists and sanitizes the server switcher order", async ({ app }) => {
    const events = installFakeIo(app.app);
    const { userAB, serverA, serverB } = await seedTwoServerFixture();
  const token = await tokenForHuman(userAB.email);

    async function listServers() {
      const res = await fetch(`${app.baseUrl}/api/servers`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      return await res.json() as Array<{ id: string; slug: string; serverOrderVersion: number }>;
    }

    assert.deepEqual(
      (await listServers()).map((server) => server.id),
      [serverA.id, serverB.id],
    );
    assert.deepEqual(
      (await listServers()).map((server) => server.serverOrderVersion),
      [0, 0],
      "auth /servers snapshot should carry the initial server order version",
    );

    const patchRes = await fetch(`${app.baseUrl}/api/servers/order`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        serverOrder: [serverB.id, "not-a-server", serverA.id, serverB.id],
      }),
    });
    assert.equal(patchRes.status, 200);
    const patchBody = await patchRes.json() as { serverOrder: string[]; serverOrderVersion: number };
    assert.deepEqual(patchBody.serverOrder, [serverB.id, serverA.id]);
    assert.equal(patchBody.serverOrderVersion, 1);
    assert.deepEqual(events.at(-1), {
      room: `user:${userAB.id}`,
      event: "server_order:updated",
      payload: {
        serverIds: [serverB.id, serverA.id],
        serverOrderVersion: 1,
      },
    });

    const getRes = await fetch(`${app.baseUrl}/api/servers/order`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json() as { serverOrder: string[]; serverOrderVersion: number };
    assert.deepEqual(getBody.serverOrder, [serverB.id, serverA.id]);
    assert.equal(getBody.serverOrderVersion, 1);

    assert.deepEqual(
      (await listServers()).map((server) => server.id),
      [serverB.id, serverA.id],
    );
    assert.deepEqual(
      (await listServers()).map((server) => server.serverOrderVersion),
      [1, 1],
      "auth /servers snapshot should carry the latest server order version",
    );

    const afterFirstEventCount = events.length;
    const noOpPatchRes = await fetch(`${app.baseUrl}/api/servers/order`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        serverOrder: [serverB.id, serverA.id],
      }),
    });
    assert.equal(noOpPatchRes.status, 200);
    assert.deepEqual(await noOpPatchRes.json(), {
      serverOrder: [serverB.id, serverA.id],
      serverOrderVersion: 1,
    });
    assert.equal(events.length, afterFirstEventCount, "same-value server order PATCH must not bump or emit");

    const secondPatchRes = await fetch(`${app.baseUrl}/api/servers/order`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        serverOrder: [serverA.id, serverB.id],
      }),
    });
    assert.equal(secondPatchRes.status, 200);
    assert.deepEqual(await secondPatchRes.json(), {
      serverOrder: [serverA.id, serverB.id],
      serverOrderVersion: 2,
    });
    assert.deepEqual(events.at(-1), {
      room: `user:${userAB.id}`,
      event: "server_order:updated",
      payload: {
        serverIds: [serverA.id, serverB.id],
        serverOrderVersion: 2,
      },
    });

    const invalidRes = await fetch(`${app.baseUrl}/api/servers/order`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ serverOrder: serverA.id }),
    });
    assert.equal(invalidRes.status, 400);
});

test("GET/PATCH /api/servers/:id/appearance-settings keeps each server's theme for the member, validated, and lists it on /servers", async ({ app }) => {
    const events = installFakeIo(app.app);
    const { userAB, serverA, serverB } = await seedTwoServerFixture();
    const token = await tokenForHuman(userAB.email);
    const call = (serverId: string, init?: RequestInit) => fetch(`${app.baseUrl}/api/servers/${serverId}/appearance-settings`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Server-Id": serverId },
    });

    // Nothing chosen yet: Raft Yellow (null) with decorations on.
    assert.deepEqual(await (await call(serverA.id)).json(), { theme: null, themeDecor: true });

    const patched = await call(serverA.id, { method: "PATCH", body: JSON.stringify({ theme: "space", themeDecor: false }) });
    assert.equal(patched.status, 200);
    assert.deepEqual(await patched.json(), { theme: "space", themeDecor: false });
    assert.deepEqual(events.at(-1), {
      room: `user:${userAB.id}`,
      event: "appearance:updated",
      payload: { serverId: serverA.id, theme: "space", themeDecor: false },
    });

    // Each server keeps its own; choosing Raft Yellow stores the default.
    assert.deepEqual(await (await call(serverB.id)).json(), { theme: null, themeDecor: true });
    await call(serverA.id, { method: "PATCH", body: JSON.stringify({ theme: "boring" }) });
    const list = await (await fetch(`${app.baseUrl}/api/servers`, { headers: { Authorization: `Bearer ${token}` } })).json() as Array<{ id: string; theme: string | null; themeDecor: boolean }>;
    assert.deepEqual(list.map((server) => [server.id, server.theme, server.themeDecor]), [[serverA.id, "boring", false], [serverB.id, null, true]]);
    await call(serverA.id, { method: "PATCH", body: JSON.stringify({ theme: "raft" }) });
    assert.deepEqual(await (await call(serverA.id)).json(), { theme: null, themeDecor: false });

    // Unknown theme, wrong type, empty body: 400 and nothing changes.
    assert.equal((await call(serverA.id, { method: "PATCH", body: JSON.stringify({ theme: "neon" }) })).status, 400);
    assert.equal((await call(serverA.id, { method: "PATCH", body: JSON.stringify({ themeDecor: "yes" }) })).status, 400);
    assert.equal((await call(serverA.id, { method: "PATCH", body: JSON.stringify({}) })).status, 400);
    assert.deepEqual(await (await call(serverA.id)).json(), { theme: null, themeDecor: false });

    // Not a member: the server-scope middleware refuses before the route.
    assert.equal((await call(randomUUID())).status, 403);
});

test("PATCH /api/servers/order keeps user-level version monotonic after deleting a membership", async ({ app }) => {
    const events = installFakeIo(app.app);
    const { userAB, serverA, serverB } = await seedTwoServerFixture();
    const serverC = await createServer("Charlie", "three-charlie", userAB.id);
  const token = await tokenForHuman(userAB.email);
    const db = getDb();
    await db.update(users)
      .set({
        serverSwitcherOrder: [serverA.id, serverB.id, serverC.id],
        serverOrderVersion: 7,
      })
      .where(eq(users.id, userAB.id));

    const getRes = await fetch(`${app.baseUrl}/api/servers/order`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(getRes.status, 200);
    assert.deepEqual(await getRes.json(), {
      serverOrder: [serverA.id, serverB.id, serverC.id],
      serverOrderVersion: 7,
    });

    await db.delete(serverMembers)
      .where(and(eq(serverMembers.userId, userAB.id), eq(serverMembers.serverId, serverA.id)));

    const patchRes = await fetch(`${app.baseUrl}/api/servers/order`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ serverOrder: [serverC.id, serverB.id] }),
    });
    assert.equal(patchRes.status, 200);
    assert.deepEqual(await patchRes.json(), {
      serverOrder: [serverC.id, serverB.id],
      serverOrderVersion: 8,
    });
    assert.deepEqual(events.at(-1), {
      room: `user:${userAB.id}`,
      event: "server_order:updated",
      payload: {
        serverIds: [serverC.id, serverB.id],
        serverOrderVersion: 8,
      },
    });
});

test("receiver-state push kill-switch suppresses server order emits but leaves versions visible", async () => {
  const previousFlag = process.env.SLOCK_RECEIVER_STATE_PUSH_ENABLED;
  process.env.SLOCK_RECEIVER_STATE_PUSH_ENABLED = "false";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const events = installFakeIo(app.app);
    const { userAB, serverA, serverB } = await seedTwoServerFixture();
    const token = await tokenForHuman(userAB.email);

    const patchRes = await fetch(`${app.baseUrl}/api/servers/order`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ serverOrder: [serverB.id, serverA.id] }),
    });
    assert.equal(patchRes.status, 200);
    assert.deepEqual(await patchRes.json(), {
      serverOrder: [serverB.id, serverA.id],
      serverOrderVersion: 1,
    });
    assert.deepEqual(events, [], "receiver-state push kill-switch should suppress server_order socket emits");

    const getRes = await fetch(`${app.baseUrl}/api/servers/order`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(getRes.status, 200);
    assert.deepEqual(await getRes.json(), {
      serverOrder: [serverB.id, serverA.id],
      serverOrderVersion: 1,
    });
  } finally {
    if (previousFlag === undefined) delete process.env.SLOCK_RECEIVER_STATE_PUSH_ENABLED;
    else process.env.SLOCK_RECEIVER_STATE_PUSH_ENABLED = previousFlag;
    await app.close();
  }
});

test("GET /api/servers/:id/members hides other members' emails from non-admin members", async ({ app }) => {
    const db = getDb();

    const [owner] = await db.insert(users).values({
      email: "owner-email@slock.test",
      name: "owner-email",
      displayName: "Owner",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();

    const [admin] = await db.insert(users).values({
      email: "admin-email@slock.test",
      name: "admin-email",
      displayName: "Admin",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();

    const [member] = await db.insert(users).values({
      email: "member-email@slock.test",
      name: "member-email",
      displayName: "Member",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();

    const [other] = await db.insert(users).values({
      email: "other-email@slock.test",
      name: "other-email",
      displayName: "Other",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();

    const server = await createServer("Email Visibility Server", "email-visibility-server", owner.id);
    await db.insert(serverMembers).values([
      { serverId: server.id, userId: admin.id, role: "admin" },
      { serverId: server.id, userId: member.id, role: "member" },
      { serverId: server.id, userId: other.id, role: "member" },
    ]);



    async function listMembers(token: string) {
      const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/members`, {
        headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
      });
      assert.equal(res.status, 200);
      return await res.json() as Array<{ userId: string; email: string | null }>;
    }

  const ownerToken = await tokenForHuman(owner.email);
    const ownerView = await listMembers(ownerToken);
    for (const row of ownerView) {
      assert.ok(row.email && row.email.length > 0, `owner should see email for ${row.userId}`);
    }

  const adminToken = await tokenForHuman(admin.email);
    const adminView = await listMembers(adminToken);
    for (const row of adminView) {
      assert.ok(row.email && row.email.length > 0, `admin should see email for ${row.userId}`);
    }

  const memberToken = await tokenForHuman(member.email);
    const memberView = await listMembers(memberToken);
    for (const row of memberView) {
      if (row.userId === member.id) {
        assert.equal(row.email, member.email, "member sees own email");
      } else {
        assert.equal(row.email, null, `member must not see email for ${row.userId}`);
      }
    }

    const memberViewJson = JSON.stringify(memberView);
    assert.ok(!memberViewJson.includes(owner.email), "owner email must not leak in member view");
    assert.ok(!memberViewJson.includes(admin.email), "admin email must not leak in member view");
    assert.ok(!memberViewJson.includes(other.email), "other member email must not leak in member view");
});

test("GET /api/servers/:id/members hides the human directory from ordinary members when configured", async ({ app }) => {
    const db = getDb();

    const [owner] = await db.insert(users).values({
      email: "hide-directory-owner@slock.test",
      name: "hide-directory-owner",
      displayName: "Owner",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    const [member] = await db.insert(users).values({
      email: "hide-directory-member@slock.test",
      name: "hide-directory-member",
      displayName: "Member",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    const [other] = await db.insert(users).values({
      email: "hide-directory-other@slock.test",
      name: "hide-directory-other",
      displayName: "Other",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();

    const server = await createServer("Hide Directory Server", "hide-directory-server", owner.id);
    await db.update(serversTable).set({ hideHumansFromMembers: true }).where(eq(serversTable.id, server.id));
    await db.insert(serverMembers).values([
      { serverId: server.id, userId: member.id, role: "member" },
      { serverId: server.id, userId: other.id, role: "member" },
    ]);

  const memberToken = await tokenForHuman(member.email);
    const memberRes = await fetch(`${app.baseUrl}/api/servers/${server.id}/members`, {
      headers: { Authorization: `Bearer ${memberToken}`, "X-Server-Id": server.id },
    });
    assert.equal(memberRes.status, 200);
    const memberBody = await memberRes.json() as Array<{ userId: string }>;
    assert.deepEqual(memberBody.map((row) => row.userId), [member.id]);
    assert.ok(!JSON.stringify(memberBody).includes(owner.name), "owner must not leak into ordinary member directory response");
    assert.ok(!JSON.stringify(memberBody).includes(other.name), "other member must not leak into ordinary member directory response");

  const ownerToken = await tokenForHuman(owner.email);
    const ownerRes = await fetch(`${app.baseUrl}/api/servers/${server.id}/members`, {
      headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id },
    });
    assert.equal(ownerRes.status, 200);
    const ownerBody = await ownerRes.json() as Array<{ userId: string }>;
    assert.deepEqual(ownerBody.map((row) => row.userId).sort(), [owner.id, member.id, other.id].sort());
});

test("GET /api/servers/:id/members/:memberId/profile cannot bypass a hidden human directory with a known user id", async ({ app }) => {
    const db = getDb();
    const [owner] = await db.insert(users).values({
      email: "hidden-profile-owner@slock.test",
      name: "hidden-profile-owner",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    const [requester] = await db.insert(users).values({
      email: "hidden-profile-requester@slock.test",
      name: "hidden-profile-requester",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    const [hiddenPeer] = await db.insert(users).values({
      email: "hidden-profile-peer@slock.test",
      name: "hidden-profile-peer",
      displayName: "Hidden Profile Peer",
      description: "must-not-leak-through-direct-profile",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();

    const server = await createServer("Hidden Profile Server", "hidden-profile-server", owner.id);
    await db.update(serversTable).set({ hideHumansFromMembers: true }).where(eq(serversTable.id, server.id));
    await db.insert(serverMembers).values([
      { serverId: server.id, userId: requester.id, role: "member" },
      { serverId: server.id, userId: hiddenPeer.id, role: "member" },
    ]);

  const requesterToken = await tokenForHuman(requester.email);
  const ownerToken = await tokenForHuman(owner.email);
    const requestProfile = (memberId: string) => fetch(
      `${app.baseUrl}/api/servers/${server.id}/members/${memberId}/profile`,
      { headers: { Authorization: `Bearer ${requesterToken}`, "X-Server-Id": server.id } },
    );

    const ownerView = await fetch(`${app.baseUrl}/api/servers/${server.id}/members/${hiddenPeer.id}/profile`, {
      headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id },
    });
    assert.equal(ownerView.status, 200, "owners keep full hidden-directory visibility");

    const hidden = await requestProfile(hiddenPeer.id);
    assert.equal(hidden.status, 404);
    assert.deepEqual(await hidden.json(), { error: "User not found" });

    const self = await requestProfile(requester.id);
    assert.equal(self.status, 200, "hidden-directory members keep their own profile");

    const shared = await createChannel(server.id, "hidden-profile-shared");
    await addHuman(shared.id, requester.id);
    await addHuman(shared.id, hiddenPeer.id);
    const visibleAfterSharedMembership = await requestProfile(hiddenPeer.id);
    assert.equal(visibleAfterSharedMembership.status, 200, "a shared visible channel grants contextual profile visibility");
    const visibleBody = await visibleAfterSharedMembership.json() as { userId: string; email: string | null };
    assert.equal(visibleBody.userId, hiddenPeer.id);
    assert.equal(visibleBody.email, null, "contextual visibility still does not expose the peer email");
});

test("GET /api/servers/:id/* enforces server membership and X-Server-Id (members listing probe)", async ({ app }) => {
    const db = getDb();

    const [owner] = await db.insert(users).values({
      email: "server-gate-owner@slock.test",
      name: "server-gate-owner",
      displayName: "Server Gate Owner",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    const [outsider] = await db.insert(users).values({
      email: "server-gate-outsider@slock.test",
      name: "server-gate-outsider",
      displayName: "Server Gate Outsider",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    const [otherOwner] = await db.insert(users).values({
      email: "server-gate-other-owner@slock.test",
      name: "server-gate-other-owner",
      displayName: "Server Gate Other Owner",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();

    const server = await createServer("Server Gate Server", "server-gate-server", owner.id);
    const otherServer = await createServer("Server Gate Other Server", "server-gate-other-server", otherOwner.id);
  const outsiderToken = await tokenForHuman(outsider.email);

    const missingHeader = await fetch(`${app.baseUrl}/api/servers/${server.id}/members`, {
      headers: { Authorization: `Bearer ${outsiderToken}` },
    });
    assert.equal(missingHeader.status, 400);

    const mismatchedHeader = await fetch(`${app.baseUrl}/api/servers/${server.id}/members`, {
      headers: {
        Authorization: `Bearer ${outsiderToken}`,
        "X-Server-Id": otherServer.id,
      },
    });
    assert.equal(mismatchedHeader.status, 400);

    const outsiderResponse = await fetch(`${app.baseUrl}/api/servers/${server.id}/members`, {
      headers: {
        Authorization: `Bearer ${outsiderToken}`,
        "X-Server-Id": server.id,
      },
    });
    assert.equal(outsiderResponse.status, 403);
});

test("GET /api/servers/:id/members/:memberId/profile hides email from non-admin members", async ({ app }) => {
    const db = getDb();

    const [owner] = await db.insert(users).values({
      email: "owner-profile@slock.test",
      name: "owner-profile",
      displayName: "Owner",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();

    const [admin] = await db.insert(users).values({
      email: "admin-profile@slock.test",
      name: "admin-profile",
      displayName: "Admin",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();

    const [member] = await db.insert(users).values({
      email: "member-profile@slock.test",
      name: "member-profile",
      displayName: "Member",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();

    const [other] = await db.insert(users).values({
      email: "other-profile@slock.test",
      name: "other-profile",
      displayName: "Other",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();

    const server = await createServer("Profile Visibility Server", "profile-visibility-server", owner.id);
    await db.insert(serverMembers).values([
      { serverId: server.id, userId: admin.id, role: "admin" },
      { serverId: server.id, userId: member.id, role: "member" },
      { serverId: server.id, userId: other.id, role: "member" },
    ]);



    async function fetchProfile(token: string, targetId: string) {
      const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/members/${targetId}/profile`, {
        headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
      });
      assert.equal(res.status, 200);
      return await res.json() as { userId: string; email: string | null };
    }

  const ownerToken = await tokenForHuman(owner.email);
    assert.equal((await fetchProfile(ownerToken, member.id)).email, member.email);
    assert.equal((await fetchProfile(ownerToken, other.id)).email, other.email);

  const adminToken = await tokenForHuman(admin.email);
    assert.equal((await fetchProfile(adminToken, member.id)).email, member.email);
    assert.equal((await fetchProfile(adminToken, owner.id)).email, owner.email);

  const memberToken = await tokenForHuman(member.email);
    const selfProfile = await fetchProfile(memberToken, member.id);
    assert.equal(selfProfile.email, member.email, "member can see own email");

    const ownerProfile = await fetchProfile(memberToken, owner.id);
    assert.equal(ownerProfile.email, null, "member must not see owner's email");
    const adminProfile = await fetchProfile(memberToken, admin.id);
    assert.equal(adminProfile.email, null, "member must not see admin's email");
    const otherProfile = await fetchProfile(memberToken, other.id);
    assert.equal(otherProfile.email, null, "member must not see other member's email");

    const combined = JSON.stringify([ownerProfile, adminProfile, otherProfile]);
    assert.ok(!combined.includes(owner.email), "owner email must not leak in member-viewed profile");
    assert.ok(!combined.includes(admin.email), "admin email must not leak in member-viewed profile");
    assert.ok(!combined.includes(other.email), "other member email must not leak in member-viewed profile");
});

/**
 * Regression tests for #proj-security task #10 (2026-04-19):
 *
 * stdrc's contract (msg=256c4eda): "所有 authenticated API 都必须带
 * X-Server-Id 且限定到那个 server". Prior to the fix, `/api/servers/:id/*`
 * handlers only ran their own `isMember(req.params.id, req.userId)` check,
 * which returned true for any server the user happened to belong to — so
 * a user on server A holding X-Server-Id=A could fetch
 * `/api/servers/B/members` (or any other resource under server B) as long
 * as they were also a member of B, silently crossing the scope the header
 * claimed. `requireServerMatchesParam` refuses that before the handler.
 */



test("GET /api/servers/:id/apps is gone with the dropped composer App references", async ({ app }) => {
  const { owner, server } = await seedRoleFixture("installed-app-reference-list");
  const token = await tokenForHuman(owner.email);
  const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/apps`, {
    headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
  });
  assert.equal(res.status, 404);
});

async function assertSanitizedGlobalServerError(res: Response) {
  assert.equal(res.status, 500);
  assert.match(res.headers.get("x-slock-error-id") ?? "", /.+/);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);

  const body = await res.json() as { error?: string; code?: string; correlationId?: string };
  assert.deepEqual(Object.keys(body).sort(), ["code", "correlationId", "error"]);
  assert.equal(body.error, "Internal server error");
  assert.equal(body.code, "internal_server_error");
  assert.equal(body.correlationId, res.headers.get("x-slock-error-id"));

  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /Failed query|server_members|users|params:|select|where|inner join/i);
}

test("global error boundary sanitizes requireServer middleware database failures", async ({ app }) => {
    const db = getDb();
    const { owner, server } = await seedRoleFixture("middleware-require-server-error");
  const token = await tokenForHuman(owner.email);

    await db.execute(sql`drop table server_members`);

    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/members`, {
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
    });
    await assertSanitizedGlobalServerError(res);
});

test("global error boundary sanitizes requireVerified middleware database failures", async ({ app }) => {
    const db = getDb();
    const { owner } = await seedRoleFixture("middleware-require-verified-error");
  const token = await tokenForHuman(owner.email);

    await db.execute(sql`drop table users cascade`);

    const res = await fetch(`${app.baseUrl}/api/servers`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await assertSanitizedGlobalServerError(res);
});

async function seedPasswordUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: `${label}-${randomUUID().slice(0, 8)}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

async function insertActiveProSubscription(serverId: string, ownerId: string, packQuantity = 1) {
  await getDb().insert(subscriptions).values({
    serverId,
    plan: "pro",
    provider: "stripe",
    stripeCustomerId: `cus_${randomUUID()}`,
    stripeSubscriptionId: `sub_${randomUUID()}`,
    stripeProPackItemId: `si_pro_${randomUUID()}`,
    status: "active",
    provisionedHumanSeats: packQuantity,
    provisionedAgentSeats: packQuantity * PRO_AGENT_SEAT_BLOCK_SIZE,
    proPackQuantity: packQuantity,
    trialFreePackQuantity: 1,
    firstPackTrialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    currentPeriodStart: new Date(),
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    createdByUserId: ownerId,
    updatedByUserId: ownerId,
  });
}

async function withTranslationEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void>,
) {
  const keys = [
    "TRANSLATION_PROVIDER",
    "TRANSLATION_AZURE_ENDPOINT",
    "TRANSLATION_AZURE_API_KEY",
    "TRANSLATION_AZURE_REGION",
    "TRANSLATION_VOLCENGINE_ACCESS_KEY_ID",
    "TRANSLATION_VOLCENGINE_SECRET_ACCESS_KEY",
    "TRANSLATION_VOLCENGINE_ENDPOINT",
    "TRANSLATION_VOLCENGINE_REGION",
    "TRANSLATION_GOOGLE_PROJECT_ID",
    "TRANSLATION_GOOGLE_LOCATION",
    "TRANSLATION_GOOGLE_ACCESS_TOKEN",
    "TRANSLATION_GOOGLE_SERVICE_ACCOUNT_JSON",
    "TRANSLATION_GOOGLE_CLIENT_EMAIL",
    "TRANSLATION_GOOGLE_PRIVATE_KEY",
    "TRANSLATION_GOOGLE_QUOTA_PROJECT_ID",
    "TRANSLATION_GOOGLE_ENDPOINT",
    "TRANSLATION_SSM_ENVIRONMENT",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await fn();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function seedTwoServerFixture() {
  const db = getDb();

  const [userAB] = await db
    .insert(users)
    .values({
      email: "two-server-ab@slock.test",
      name: "two-server-ab",
      displayName: "AB",
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    })
    .returning();

  // userAB is an owner of serverA AND a member of serverB — this is the
  // exact shape that made the pre-fix bug exploitable (the user's isMember
  // check passes for both, so the URL :id alone decided scope).
  const serverA = await createServer("Alpha", "two-alpha", userAB.id);
  const serverB = await createServer("Bravo", "two-bravo", userAB.id);

  return { userAB, serverA, serverB };
}

test("GET /api/servers/:id/members rejects when X-Server-Id doesn't match :id", async ({ app }) => {
    const { userAB, serverA, serverB } = await seedTwoServerFixture();
  const token = await tokenForHuman(userAB.email);

    // Caller claims server A (valid) but fetches server B. The user is a
    // legitimate member of both — pre-fix this returned 200 because the
    // per-handler `isMember(:id, userId)` check passed. Post-fix it must
    // 400 (header mismatch) before the handler runs.
    const res = await fetch(`${app.baseUrl}/api/servers/${serverB.id}/members`, {
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": serverA.id },
    });
    assert.equal(res.status, 400, `expected 400 on scope mismatch, got ${res.status}`);
});

test("GET /api/servers/:id/members rejects missing X-Server-Id", async ({ app }) => {
    const { userAB, serverA } = await seedTwoServerFixture();
  const token = await tokenForHuman(userAB.email);

    const res = await fetch(`${app.baseUrl}/api/servers/${serverA.id}/members`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 400, `expected 400 on missing header, got ${res.status}`);
});

test("GET /api/servers/:id/members accepts matching X-Server-Id", async ({ app }) => {
    const { userAB, serverA } = await seedTwoServerFixture();
  const token = await tokenForHuman(userAB.email);

    const res = await fetch(`${app.baseUrl}/api/servers/${serverA.id}/members`, {
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": serverA.id },
    });
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
});

test("GET /api/servers/:id rejects non-member even when X-Server-Id matches", async ({ app }) => {
    const db = getDb();

    const [outsider] = await db.insert(users).values({
      email: "outsider@slock.test",
      name: "outsider",
      displayName: "Outsider",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();

    const [owner] = await db.insert(users).values({
      email: "owner-outsider@slock.test",
      name: "owner-outsider",
      displayName: "Owner",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();

    const server = await createServer("Closed", "closed-server", owner.id);
  const token = await tokenForHuman(outsider.email);

    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}`, {
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
    });
    assert.equal(res.status, 403, `expected 403 for non-member, got ${res.status}`);
});

test("GET /api/servers/unread-summary does not require X-Server-Id (cross-server endpoint)", async ({ app }) => {
    const { userAB } = await seedTwoServerFixture();
  const token = await tokenForHuman(userAB.email);

    // unread-summary aggregates across all the user's servers — intentionally
    // user-scoped, not server-scoped. The `requireServerMatchesParam`
    // middleware is registered on `/:id` only, so this no-`:id` route skips
    // the scope check entirely.
    const res = await fetch(`${app.baseUrl}/api/servers/unread-summary`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200, `expected 200 without X-Server-Id, got ${res.status}`);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
});

test("GET /api/servers/unread-summary ignores unread from non-joined regular channels", async ({ app }) => {
    const db = getDb();

    const [owner] = await db.insert(users).values({
      email: "owner-unread@slock.test",
      name: "owner-unread",
      displayName: "Owner Unread",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();

    const [member] = await db.insert(users).values({
      email: "member-unread@slock.test",
      name: "member-unread",
      displayName: "Member Unread",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();

    const server = await createServer("Unread Summary Server", "unread-summary-server", owner.id);
    await db.insert(serverMembers).values({
      serverId: server.id,
      userId: member.id,
      role: "member",
    });
    await db
      .update(serverMembers)
      .set({ serverPushMode: "none" })
      .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, member.id)));

    const joinedChannel = await createChannel(server.id, "joined-room");
    await addHuman(joinedChannel.id, member.id);
    await addHuman(joinedChannel.id, owner.id);

    const nonJoinedChannel = await createChannel(server.id, "hidden-room");
    await addHuman(nonJoinedChannel.id, owner.id);

    // Joined-channel messages go through the HTTP route so inbox serving rows
    // are built (bare-service createMessage skips them): this makes the new
    // activityUnreadCount reflect the same 2 unread the sidebar counts.
    const ownerLogin = await fetch(`${app.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: owner.email, password: "password123" }),
    });
    assert.equal(ownerLogin.status, 200);
    const ownerToken = (await ownerLogin.json() as { accessToken: string }).accessToken;
    for (const content of ["joined unread 1", "joined unread 2"]) {
      const res = await fetch(`${app.baseUrl}/api/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ownerToken}`,
          "X-Server-Id": server.id,
        },
        body: JSON.stringify({ channelId: joinedChannel.id, content }),
      });
      assert.equal(res.status, 200);
    }
    await createMessage(nonJoinedChannel.id, "user", owner.id, "hidden unread 1");
    await createMessage(nonJoinedChannel.id, "user", owner.id, "hidden unread 2");
    await createMessage(nonJoinedChannel.id, "user", owner.id, "hidden unread 3");

    const loginResponse = await fetch(`${app.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: member.email,
        password: "password123",
      }),
    });
    assert.equal(loginResponse.status, 200);
    const loginData = await loginResponse.json() as { accessToken: string };
    assert.ok(loginData.accessToken);

    const summaryResponse = await fetch(`${app.baseUrl}/api/servers/unread-summary`, {
      headers: {
        Authorization: `Bearer ${loginData.accessToken}`,
      },
    });
    assert.equal(summaryResponse.status, 200);
    const summary = await summaryResponse.json() as Array<{
      serverId: string;
      unreadCount: number;
      serverPushMuted: boolean;
    }>;

    assert.deepEqual(summary, [
      {
        serverId: server.id,
        unreadCount: 2,
        serverPushMuted: true,
        // task #235: fact count present despite serverPushMuted (mute is
        // presentation, never count authority). Non-joined-channel unread is
        // excluded from Activity exactly as it is from the sidebar count.
        activityUnreadCount: 2,
      },
    ]);
});

test("GET /api/servers/unread-summary records phases and batched query shape", async ({ app }) => {
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({
      sink,
      traceIdGenerator: () => "b".repeat(32),
      spanIdGenerator: (() => {
        let next = 1;
        return () => String(next++).padStart(16, "0");
      })(),
    });
    app.app.set("serverTracer", tracer);

    const db = getDb();
    const { userAB, serverA, serverB } = await seedTwoServerFixture();
    // Pin both servers to an unlimited-history plan so the batched unread-summary
    // phases / query shape don't depend on the ambient free-trial wall-clock:
    // a free server's history limit is unlimited only while the trial is active
    // (isTrialActive vs TRIAL_END_DATE) and gains a 30-day cutoff afterward,
    // which changes the history-filter query shape this test pins.
    await db.update(serversTable).set({ plan: "founder" }).where(inArray(serversTable.id, [serverA.id, serverB.id]));
    const [peer] = await db
      .insert(users)
      .values({
        email: "summary-trace-peer@slock.test",
        name: "summary-trace-peer",
        displayName: "Summary Trace Peer",
      passwordHash: await fixturePasswordHash("password123"),
        emailVerified: true,
        profileSetupCompletedAt: new Date(),
      })
      .returning();
    await db.insert(serverMembers).values([
      { serverId: serverA.id, userId: peer.id, role: "member" },
      { serverId: serverB.id, userId: peer.id, role: "member" },
    ]);

    const channelA = await createChannel(serverA.id, "summary-trace-a");
    await addHuman(channelA.id, userAB.id);
    await addHuman(channelA.id, peer.id);
    await createMessage(channelA.id, "user", peer.id, "server a unread 1");
    await createMessage(channelA.id, "user", peer.id, "server a unread 2");

    const channelB = await createChannel(serverB.id, "summary-trace-b");
    await addHuman(channelB.id, userAB.id);
    await addHuman(channelB.id, peer.id);
    await createMessage(channelB.id, "user", peer.id, "server b unread 1");
    await createMessage(channelB.id, "user", peer.id, "server b unread 2");
    await createMessage(channelB.id, "user", peer.id, "server b unread 3");

  const token = await tokenForHuman(userAB.email);
    sink.clear();

    const res = await fetch(`${app.baseUrl}/api/servers/unread-summary`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const summary = await res.json() as Array<{ serverId: string; unreadCount: number }>;
    assert.deepEqual(
      summary.map((item) => [item.serverId, item.unreadCount]).sort(),
      [
        [serverA.id, 2],
        [serverB.id, 3],
      ].sort(),
    );

    const span = sink.getAllSpans().find((candidate) =>
      candidate.name === "server.http.request"
      && candidate.attrs?.route_pattern === "/api/servers/unread-summary",
    );
    assert.ok(span, "expected GET /api/servers/unread-summary root span");

    const processEventNames = handlerTraceEvents(span.events)
      .map((event) => event.name)
      .filter((name) => name !== "db.query.finished");
    // Legacy phases keep their exact order. 2026-09-21 teardown: without a
    // RisingWave environment the activity totals are the membership-gated
    // per-server canonical computation (getInboxItems, limit 1) — each server
    // contributes one backend selection plus its row-read trace pair. With RW
    // configured the totals come from the totals MV in one derivation query.
    assert.deepEqual(processEventNames, [
      "unread_summary.load.started",
      "server_memberships.loaded",
      "inbox.backend.selected",
      "unread_summary.loaded",
      "inbox.backend.selected",
      "inbox.serving_row.read.page",
      "inbox.serving_row.read",
      "inbox.backend.selected",
      "inbox.serving_row.read.page",
      "inbox.serving_row.read",
      "activity_unread_summary.loaded",
      // Object Activity's badge phase (S6) is traced whether or not any object app is on.
      "activity_object_unread_summary.loaded",
      "response.ready",
      "http.response.finished",
    ]);

    const dbEvents = handlerTraceEvents(span.events).filter((event) => event.name === "db.query.finished");
    assert.deepEqual(
      dbEvents.map((event) => event.attrs?.query_name).sort(),
      [
        "channels.inbox_items_by_user",
        "channels.inbox_items_by_user",
        "channels.inbox_read_state_authority",
        "channels.inbox_read_state_authority",
        "servers.memberships_by_user",
        "servers.sidebar_unread_counts_by_user",
      ],
    );
    assert.equal(dbEvents.length, 6);

    const dbEventByQuery = new Map(dbEvents.map((event) => [event.attrs?.query_name, event]));
    assert.equal(dbEventByQuery.get("servers.memberships_by_user")?.attrs?.phase, "server_memberships.loaded");
    assert.equal(dbEventByQuery.get("servers.memberships_by_user")?.attrs?.servers_count, 2);
    assert.equal(dbEventByQuery.get("servers.sidebar_unread_counts_by_user")?.attrs?.phase, "unread_summary.loaded");
    assert.equal(dbEventByQuery.get("servers.sidebar_unread_counts_by_user")?.attrs?.servers_count, 2);
    assert.equal(dbEventByQuery.get("servers.sidebar_unread_counts_by_user")?.attrs?.servers_with_unread_count, 2);
    assert.equal(dbEventByQuery.get("servers.sidebar_unread_counts_by_user")?.attrs?.["inbox.backend"], "rw_mv");
    assert.equal(dbEventByQuery.get("servers.sidebar_unread_counts_by_user")?.attrs?.rw_conversation_unread_view, "rw_conversation_unread_v4");
    assert.equal(dbEventByQuery.get("servers.sidebar_unread_counts_by_user")?.attrs?.["inbox.route"], "sidebar_summary");
    assert.equal(dbEventByQuery.get("servers.sidebar_unread_counts_by_user")?.attrs?.["inbox.fallback_reason"], "none");
    assert.equal(dbEventByQuery.get("servers.sidebar_unread_counts_by_user")?.attrs?.["inbox.contract_version"], 3);
    const perServerTotalsEvents = dbEvents.filter((event) => event.attrs?.query_name === "channels.inbox_items_by_user");
    assert.equal(perServerTotalsEvents.length, 2, "one canonical totals computation per member server");
    for (const event of perServerTotalsEvents) {
      assert.equal(event.attrs?.phase, "activity_unread_summary.loaded");
      assert.equal(event.attrs?.["inbox.backend"], "pg_legacy");
    }

    const backendEvent = span.events.find((event) => event.name === "inbox.backend.selected");
    assert.ok(backendEvent);
    assert.equal(backendEvent.attrs?.["inbox.backend"], "rw_mv");
    assert.equal(backendEvent.attrs?.["inbox.route"], "sidebar_summary");
    assert.equal(backendEvent.attrs?.["inbox.fallback_reason"], "none");
    assert.equal(backendEvent.attrs?.["inbox.contract_version"], 3);

    const loadedEvent = span.events.find((event) => event.name === "unread_summary.loaded");
    assert.ok(loadedEvent);
    assert.equal(loadedEvent.attrs?.servers_count, 2);
    assert.equal(loadedEvent.attrs?.servers_with_unread_count, 2);
    assert.equal(loadedEvent.attrs?.total_unread_count, 5);

    const readyEvent = span.events.find((event) => event.name === "response.ready");
    assert.ok(readyEvent);
    assert.equal(readyEvent.attrs?.servers_count, 2);
    assert.equal(readyEvent.attrs?.total_unread_count, 5);
    assert.equal(Object.values(span.attrs ?? {}).includes(userAB.id), false);
    assert.equal(Object.values(readyEvent.attrs ?? {}).includes(serverA.id), false);
    assert.equal(
      dbEvents.some((event) => Object.values(event.attrs ?? {}).includes(serverB.id)),
      false,
    );
});

test("GET /api/servers/:id/sidebar-order sanitizes saved ids and synthesizes typed pinned refs", async ({ app }) => {
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({
      sink,
      traceIdGenerator: () => "c".repeat(32),
      spanIdGenerator: (() => {
        let next = 1;
        return () => String(next++).padStart(16, "0");
      })(),
    });
    app.app.set("serverTracer", tracer);

    const { userAB, serverA } = await seedTwoServerFixture();
    const channel = await createChannel(serverA.id, "sidebar-order-trace");
    await addHuman(channel.id, userAB.id);
    const privateChannel = await createChannel(serverA.id, "sidebar-order-private", undefined, "private");
    await addHuman(privateChannel.id, userAB.id);
    const nonMemberPrivateChannel = await createChannel(serverA.id, "sidebar-order-private-hidden", undefined, "private");
    const jointChannel = await createChannel(serverA.id, "sidebar-order-joint", undefined, "joint");
    const nonMemberJointChannel = await createChannel(serverA.id, "sidebar-order-joint-hidden", undefined, "joint");
    for (const local of [jointChannel, nonMemberJointChannel]) {
      const canonical = await createChannel(serverA.id, `${local.name}-storage`);
      const [joint] = await getDb().insert(jointChannels).values({
        canonicalChannelId: canonical.id,
        createdByServerId: serverA.id,
        createdByUserId: userAB.id,
      }).returning();
      await getDb().insert(jointChannelServers).values({
        jointChannelId: joint.id,
        serverId: serverA.id,
        localChannelId: local.id,
        role: "host",
        joinedByUserId: userAB.id,
      });
    }
    await addHuman(jointChannel.id, userAB.id);
    const agent = await createAgent(serverA.id, "sidebar-order-agent", { runtime: "codex" });
    const dm = await findOrCreateDM(serverA.id, userAB.id, agent.id);
    assert.ok(dm, "expected agent DM");
    await createMessage(dm.id, "user", userAB.id, "sidebar order trace dm");
    const staleId = "not-a-valid-id";
    await updateMemberSidebarOrder(serverA.id, userAB.id, {
      channelOrder: [staleId, channel.id, privateChannel.id, nonMemberPrivateChannel.id, jointChannel.id, nonMemberJointChannel.id],
      agentOrder: [agent.id, staleId],
      dmOrder: [staleId, dm.id],
      channelSortMode: "recent",
      jointChannelSortMode: "az",
      dmSortMode: "az",
      pinnedSortMode: "recent",
      pinnedChannelIds: [staleId, channel.id, privateChannel.id, nonMemberPrivateChannel.id, jointChannel.id, nonMemberJointChannel.id, dm.id],
      pinnedAgentIds: [staleId, agent.id],
      pinnedOrder: [staleId, channel.id, privateChannel.id, nonMemberPrivateChannel.id, jointChannel.id, nonMemberJointChannel.id, agent.id, dm.id],
      hiddenDmIds: [dm.id, staleId],
      channelPanelTabOrder: ["files", "not-a-tab", "chat"],
      agentPanelTabOrder: ["activity", "usage", "workspace", "permissions", "not-a-tab", "integrations", "profile"],
    });

  const token = await tokenForHuman(userAB.email);
    sink.clear();

    const res = await fetch(`${app.baseUrl}/api/servers/${serverA.id}/sidebar-order`, {
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": serverA.id },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      channelOrder: string[];
      agentOrder: string[];
      dmOrder: string[];
      channelSortMode: string;
      jointChannelSortMode: string;
      dmSortMode: string;
      pinnedSortMode: string;
      pinned: Array<{ kind: "channel" | "agent" | "human"; id: string }>;
      pinnedChannelIds: string[];
      pinnedAgentIds: string[];
      pinnedOrder: string[];
      hiddenDmIds: string[];
      channelPanelTabOrder: string[];
      agentPanelTabOrder: string[];
      pinnedVersion: number;
    };
    assert.deepEqual(body.channelOrder, [channel.id, privateChannel.id, jointChannel.id]);
    assert.deepEqual(body.agentOrder, [agent.id]);
    assert.deepEqual(body.dmOrder, [dm.id]);
    assert.equal(body.channelSortMode, "recent");
    assert.equal(body.jointChannelSortMode, "az");
    assert.equal(body.dmSortMode, "az");
    assert.equal(body.pinnedSortMode, "recent");
    assert.deepEqual(body.pinned, [
      { kind: "channel", id: channel.id },
      { kind: "channel", id: privateChannel.id },
      { kind: "channel", id: jointChannel.id },
      { kind: "agent", id: agent.id },
    ]);
    assert.deepEqual(body.pinnedChannelIds, [channel.id, privateChannel.id, jointChannel.id, dm.id]);
    assert.deepEqual(body.pinnedAgentIds, [agent.id]);
    assert.deepEqual(body.pinnedOrder, [channel.id, privateChannel.id, jointChannel.id, agent.id, dm.id]);
    assert.deepEqual(body.hiddenDmIds, [dm.id]);
    assert.deepEqual(body.channelPanelTabOrder, ["files", "chat"]);
    assert.deepEqual(body.agentPanelTabOrder, ["activity", "usage", "workspace", "integrations", "profile"]);
    assert.equal(body.pinnedVersion, 1);

    const span = sink.getAllSpans().find((candidate) =>
      candidate.name === "server.http.request"
      && candidate.attrs?.route_pattern === "/api/servers/:id/sidebar-order",
    );
    assert.ok(span, "expected GET /api/servers/:id/sidebar-order root span");

    const processEventNames = handlerTraceEvents(span.events)
      .map((event) => event.name)
      .filter((name) => name !== "db.query.finished");
    assert.deepEqual(processEventNames, [
      "sidebar_order.load.started",
      "server.membership.checked",
      "sidebar_order.loaded",
      "response.ready",
      "http.response.finished",
    ]);

    const dbEvents = handlerTraceEvents(span.events).filter((event) => event.name === "db.query.finished");
    const queryNames = dbEvents.map((event) => event.attrs?.query_name);
    assert.ok(queryNames.includes("servers.member_by_user"));
    assert.ok(queryNames.includes("servers.sidebar_order_by_member_sanitized"));

    const dbEventByQuery = new Map(dbEvents.map((event) => [event.attrs?.query_name, event]));
    assert.equal(dbEventByQuery.get("servers.member_by_user")?.attrs?.phase, "server.membership.checked");
    assert.equal(dbEventByQuery.get("servers.sidebar_order_by_member_sanitized")?.attrs?.phase, "sidebar_order.loaded");

    const readyEvent = span.events.find((event) => event.name === "response.ready");
    assert.ok(readyEvent);
    assert.equal(readyEvent.attrs?.channel_order_count, 3);
    assert.equal(readyEvent.attrs?.agent_order_count, 1);
    assert.equal(readyEvent.attrs?.dm_order_count, 1);
    assert.equal(readyEvent.attrs?.pinned_count, 4);
    assert.equal(Object.values(span.attrs ?? {}).includes(serverA.id), false);
    assert.equal(Object.values(readyEvent.attrs ?? {}).includes(channel.id), false);
    assert.equal(
      dbEvents.some((event) => Object.values(event.attrs ?? {}).includes(agent.id)),
      false,
    );
});

test("PATCH /api/servers/:id/sidebar-order persists sidebar sort modes", async ({ app }) => {
    const { userAB, serverA } = await seedTwoServerFixture();
  const token = await tokenForHuman(userAB.email);

    async function patch(body: unknown) {
      return fetch(`${app.baseUrl}/api/servers/${serverA.id}/sidebar-order`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Server-Id": serverA.id,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    }

    const updateRes = await patch({
      channelSortMode: "recent",
      jointChannelSortMode: "az",
      dmSortMode: "az",
      pinnedSortMode: "recent",
      channelPanelTabOrder: ["files", "tasks", "chat"],
      agentPanelTabOrder: ["activity", "usage", "permissions", "integrations", "profile"],
    });
    assert.equal(updateRes.status, 200);
    const updateBody = await updateRes.json() as {
      channelSortMode: string;
      jointChannelSortMode: string;
      dmSortMode: string;
      pinnedSortMode: string;
      channelPanelTabOrder: string[];
      agentPanelTabOrder: string[];
    };
    assert.equal(updateBody.channelSortMode, "recent");
    assert.equal(updateBody.jointChannelSortMode, "az");
    assert.equal(updateBody.dmSortMode, "az");
    assert.equal(updateBody.pinnedSortMode, "recent");
    assert.deepEqual(updateBody.channelPanelTabOrder, ["files", "tasks", "chat"]);
    assert.deepEqual(updateBody.agentPanelTabOrder, ["activity", "usage", "integrations", "profile"]);

    const getRes = await fetch(`${app.baseUrl}/api/servers/${serverA.id}/sidebar-order`, {
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": serverA.id },
    });
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json() as {
      channelSortMode: string;
      jointChannelSortMode: string;
      dmSortMode: string;
      pinnedSortMode: string;
      channelPanelTabOrder: string[];
      agentPanelTabOrder: string[];
    };
    assert.equal(getBody.channelSortMode, "recent");
    assert.equal(getBody.jointChannelSortMode, "az");
    assert.equal(getBody.dmSortMode, "az");
    assert.equal(getBody.pinnedSortMode, "recent");
    assert.deepEqual(getBody.channelPanelTabOrder, ["files", "tasks", "chat"]);
    assert.deepEqual(getBody.agentPanelTabOrder, ["activity", "usage", "integrations", "profile"]);

    const invalidRes = await patch({ channelSortMode: "newest" });
    assert.equal(invalidRes.status, 400);
    const invalidJointRes = await patch({ jointChannelSortMode: "newest" });
    assert.equal(invalidJointRes.status, 400);
    const invalidPinnedRes = await patch({ pinnedSortMode: "newest" });
    assert.equal(invalidPinnedRes.status, 400);
    const invalidPanelTabRes = await patch({ channelPanelTabOrder: "files" });
    assert.equal(invalidPanelTabRes.status, 400);
});

test("PATCH /api/servers/:id/sidebar-order persists, sanitizes, and versions custom sections", async ({ app }) => {
    const { userAB, serverA } = await seedTwoServerFixture();
  const token = await tokenForHuman(userAB.email);
    const channel = await createChannel(serverA.id, "sidebar-custom-section");
    const staleId = randomUUID();
    const headers = {
      Authorization: `Bearer ${token}`,
      "X-Server-Id": serverA.id,
      "Content-Type": "application/json",
    };

    const updateRes = await fetch(`${app.baseUrl}/api/servers/${serverA.id}/sidebar-order`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        customSections: [{ id: "project", name: " Project ", emoji: "📁", sortMode: "manual" }],
        sectionOrder: ["project", "system:pinned"],
        sectionPlacements: [
          { kind: "channel", id: channel.id, sectionId: "project", position: 9 },
          { kind: "channel", id: staleId, sectionId: "project", position: 10 },
        ],
        sectionsVersion: 0,
      }),
    });
    assert.equal(updateRes.status, 200);
    const updateBody = await updateRes.json() as {
      customSections: Array<{ id: string; name: string; emoji: string | null; sortMode: string }>;
      sectionOrder: string[];
      sectionPlacements: Array<{ kind: string; id: string; sectionId: string; position: number }>;
      sectionsVersion: number;
    };
    assert.deepEqual(updateBody.customSections, [{ id: "project", name: "Project", emoji: "📁", sortMode: "manual" }]);
    assert.deepEqual(updateBody.sectionOrder, ["project", "system:pinned", "system:joint", "system:channels", "system:dms"]);
    assert.deepEqual(updateBody.sectionPlacements, [{ kind: "channel", id: channel.id, sectionId: "project", position: 0 }]);
    assert.equal(updateBody.sectionsVersion, 1);

    const conflictRes = await fetch(`${app.baseUrl}/api/servers/${serverA.id}/sidebar-order`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ customSections: [], sectionsVersion: 0 }),
    });
    assert.equal(conflictRes.status, 409);
    assert.equal((await conflictRes.json() as { code: string }).code, "SIDEBAR_SECTIONS_VERSION_CONFLICT");

    const getRes = await fetch(`${app.baseUrl}/api/servers/${serverA.id}/sidebar-order`, { headers });
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json() as typeof updateBody;
    assert.deepEqual(getBody.customSections, updateBody.customSections);
    assert.deepEqual(getBody.sectionPlacements, updateBody.sectionPlacements);
    assert.equal(getBody.sectionsVersion, 1);
});

test("PATCH /api/servers/:id/sidebar-order preserves live channel order while omitting a deleted channel", async ({ app }) => {
    const { userAB, serverA } = await seedTwoServerFixture();
    const token = await tokenForHuman(userAB.email);
    const firstChannel = await createChannel(serverA.id, "sidebar-order-live-first");
    const deletedChannel = await createChannel(serverA.id, "sidebar-order-deleted-before-sparse-patch");
    const lastChannel = await createChannel(serverA.id, "sidebar-order-live-last");
    await updateMemberSidebarOrder(serverA.id, userAB.id, {
      channelOrder: [lastChannel.id, deletedChannel.id, firstChannel.id],
    });
    await deleteChannel(deletedChannel.id);

    const headers = {
      Authorization: `Bearer ${token}`,
      "X-Server-Id": serverA.id,
      "Content-Type": "application/json",
    };
    const expectedLiveOrder = [lastChannel.id, firstChannel.id];
    const beforeUpdateRes = await fetch(`${app.baseUrl}/api/servers/${serverA.id}/sidebar-order`, { headers });
    assert.equal(beforeUpdateRes.status, 200);
    const beforeUpdate = await beforeUpdateRes.json() as {
      channelOrder: string[];
      sectionsVersion: number;
    };
    assert.deepEqual(beforeUpdate.channelOrder, expectedLiveOrder);

    const updateRes = await fetch(`${app.baseUrl}/api/servers/${serverA.id}/sidebar-order`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        customSections: [{ id: "project", name: "Project", emoji: null, sortMode: "manual" }],
        sectionOrder: ["project"],
        sectionPlacements: [],
        sectionsVersion: beforeUpdate.sectionsVersion,
      }),
    });
    assert.equal(updateRes.status, 200);
    const updateBody = await updateRes.json() as {
      channelOrder: string[];
      sectionOrder: string[];
      sectionsVersion: number;
    };
    assert.deepEqual(updateBody.channelOrder, expectedLiveOrder);
    assert.deepEqual(updateBody.sectionOrder, ["project", "system:pinned", "system:joint", "system:channels", "system:dms"]);
    assert.equal(updateBody.sectionsVersion, beforeUpdate.sectionsVersion + 1);
});

test("sidebar section persistence atomically rejects concurrent writes at the same version", async ({ app }) => {
    const { userAB, serverA } = await seedTwoServerFixture();
    const section = (id: string) => [{ id, name: id, emoji: null, sortMode: "manual" as const }];

    const results = await Promise.all([
      updateMemberSidebarOrder(serverA.id, userAB.id, {
        customSections: section("alpha"),
        sectionsVersion: 0,
      }),
      updateMemberSidebarOrder(serverA.id, userAB.id, {
        customSections: section("beta"),
        sectionsVersion: 0,
      }),
    ]);

    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(results.filter((result) => result === null).length, 1);
    const persisted = await getMemberSidebarOrder(serverA.id, userAB.id);
    assert.ok(persisted);
    assert.equal(persisted.sectionsVersion, 1);
    assert.ok(["alpha", "beta"].includes(persisted.customSections[0]?.id ?? ""));
});

test("PATCH /api/servers/:id/sidebar-order accepts typed pinned refs and projects legacy fields", async ({ app }) => {
    const events = installFakeIo(app.app);
    const { userAB, serverA } = await seedTwoServerFixture();
    const db = getDb();
    const [peer] = await db.insert(users).values({
      email: "typed-pinned-peer@slock.test",
      name: "typed-pinned-peer",
      displayName: "Pinned Peer",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    await db.insert(serverMembers).values({ serverId: serverA.id, userId: peer.id, role: "member" });

    const channel = await createChannel(serverA.id, "typed-pinned-channel");
    await addHuman(channel.id, userAB.id);
    const hiddenChannel = await createChannel(serverA.id, "typed-pinned-hidden", undefined, "private");
    const agent = await createAgent(serverA.id, "typed-pinned-agent", { runtime: "codex" });
    const agentDm = await findOrCreateDM(serverA.id, userAB.id, agent.id);
    assert.ok(agentDm, "expected agent DM");
    const humanDm = await findOrCreateUserDM(serverA.id, userAB.id, peer.id);
    assert.ok(humanDm, "expected human DM");
  const token = await tokenForHuman(userAB.email);

    async function patch(body: unknown) {
      return fetch(`${app.baseUrl}/api/servers/${serverA.id}/sidebar-order`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Server-Id": serverA.id,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    }

    const mixedRes = await patch({
      pinned: [{ kind: "channel", id: channel.id }],
      pinnedChannelIds: [channel.id],
    });
    assert.equal(mixedRes.status, 400);

    const updateRes = await patch({
      pinned: [
        { kind: "channel", id: channel.id },
        { kind: "channel", id: hiddenChannel.id },
        { kind: "agent", id: agent.id },
        { kind: "human", id: peer.id },
        { kind: "agent", id: agent.id },
        { kind: "human", id: randomUUID() },
        { kind: "bogus", id: channel.id },
      ],
    });
    assert.equal(updateRes.status, 400);

    const validUpdateRes = await patch({
      pinned: [
        // DM-channel typed refs canonicalize to their peer entity before dedupe:
        // human entity + human DM channel collapse, pure agent DM channel becomes agent.
        { kind: "human", id: peer.id },
        { kind: "channel", id: humanDm.id },
        { kind: "channel", id: channel.id },
        { kind: "channel", id: hiddenChannel.id },
        { kind: "channel", id: agentDm.id },
        { kind: "human", id: randomUUID() },
      ],
    });
    assert.equal(validUpdateRes.status, 200);
    const updateBody = await validUpdateRes.json() as {
      pinned: Array<{ kind: "channel" | "agent" | "human"; id: string }>;
      pinnedChannelIds: string[];
      pinnedAgentIds: string[];
      pinnedOrder: string[];
      pinnedVersion: number;
    };
    assert.deepEqual(updateBody.pinned, [
      { kind: "human", id: peer.id },
      { kind: "channel", id: channel.id },
      { kind: "agent", id: agent.id },
    ]);
    assert.deepEqual(updateBody.pinnedChannelIds, [humanDm.id, channel.id]);
    assert.deepEqual(updateBody.pinnedAgentIds, [agent.id]);
    assert.deepEqual(updateBody.pinnedOrder, [humanDm.id, channel.id, agent.id]);
    assert.equal(updateBody.pinnedVersion, 1);
    assert.deepEqual(events.at(-1), {
      room: `user:${userAB.id}`,
      event: "pinned:updated",
      payload: {
        pinned: [
          { kind: "human", id: peer.id },
          { kind: "channel", id: channel.id },
          { kind: "agent", id: agent.id },
        ],
        pinnedVersion: 1,
      },
    });

    const afterFirstEventCount = events.length;
    const noOpRes = await patch({
      pinned: [
        { kind: "human", id: peer.id },
        { kind: "channel", id: channel.id },
        { kind: "agent", id: agent.id },
      ],
    });
    assert.equal(noOpRes.status, 200);
    assert.deepEqual(await noOpRes.json(), updateBody);
    assert.equal(events.length, afterFirstEventCount, "same-value typed pinned PATCH must not bump or emit");

    const getRes = await fetch(`${app.baseUrl}/api/servers/${serverA.id}/sidebar-order`, {
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": serverA.id },
    });
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json() as typeof updateBody;
    assert.deepEqual(getBody, updateBody);
});

test("PATCH /api/servers/:id/sidebar-order keeps typed DM pins after peers leave the directory", async ({ app }) => {
    const { userAB, serverA } = await seedTwoServerFixture();
    const db = getDb();
    const [peer] = await db.insert(users).values({
      email: "removed-typed-pinned-peer@slock.test",
      name: "removed-typed-pinned-peer",
      displayName: "Removed Pinned Peer",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    await db.insert(serverMembers).values({ serverId: serverA.id, userId: peer.id, role: "member" });

    const agent = await createAgent(serverA.id, "deleted-typed-pinned-agent", { runtime: "codex" });
    const humanDm = await findOrCreateUserDM(serverA.id, userAB.id, peer.id);
    const agentDm = await findOrCreateDM(serverA.id, userAB.id, agent.id);
    assert.ok(humanDm, "expected human DM");
    assert.ok(agentDm, "expected agent DM");

    await db.delete(serverMembers).where(and(
      eq(serverMembers.serverId, serverA.id),
      eq(serverMembers.userId, peer.id),
    ));
    await deleteAgent(agent.id);

    assert.equal(
      (await db.select().from(serverMembers).where(and(
        eq(serverMembers.serverId, serverA.id),
        eq(serverMembers.userId, peer.id),
      ))).length,
      0,
      "pin authority must not resurrect the removed human in the member directory",
    );
    assert.equal(
      (await db.select().from(agents).where(and(eq(agents.id, agent.id), isNull(agents.deletedAt)))).length,
      0,
      "pin authority must not resurrect the deleted agent in the agent directory",
    );

  const token = await tokenForHuman(userAB.email);
    const patch = (pinned: Array<{ kind: "human" | "agent"; id: string }>) => fetch(
      `${app.baseUrl}/api/servers/${serverA.id}/sidebar-order`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Server-Id": serverA.id,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ pinned }),
      },
    );

    const pinRes = await patch([
      { kind: "human", id: peer.id },
      { kind: "agent", id: agent.id },
      { kind: "human", id: randomUUID() },
    ]);
    assert.equal(pinRes.status, 200);
    const pinBody = await pinRes.json() as {
      pinned: Array<{ kind: "human" | "agent"; id: string }>;
      pinnedChannelIds: string[];
      pinnedAgentIds: string[];
      pinnedOrder: string[];
      pinnedVersion: number;
    };
    assert.deepEqual(pinBody.pinned, [
      { kind: "human", id: peer.id },
      { kind: "agent", id: agent.id },
    ]);
    assert.deepEqual(pinBody.pinnedChannelIds, [humanDm.id]);
    assert.deepEqual(pinBody.pinnedAgentIds, [agent.id]);
    assert.deepEqual(pinBody.pinnedOrder, [humanDm.id, agent.id]);
    assert.equal(pinBody.pinnedVersion, 1);

    const unpinRes = await patch([]);
    assert.equal(unpinRes.status, 200);
    const unpinBody = await unpinRes.json() as typeof pinBody;
    assert.deepEqual(unpinBody.pinned, []);
    assert.deepEqual(unpinBody.pinnedChannelIds, []);
    assert.deepEqual(unpinBody.pinnedAgentIds, []);
    assert.deepEqual(unpinBody.pinnedOrder, []);
    assert.equal(unpinBody.pinnedVersion, 2);
});

test("PATCH /api/servers/:id/sidebar-order legacy pinned writes preserve new-only typed refs", async ({ app }) => {
    const events = installFakeIo(app.app);
    const { userAB, serverA } = await seedTwoServerFixture();
    const db = getDb();
    const [peerWithoutDm] = await db.insert(users).values({
      email: "typed-pinned-no-dm@slock.test",
      name: "typed-pinned-no-dm",
      displayName: "No DM Peer",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    await db.insert(serverMembers).values({ serverId: serverA.id, userId: peerWithoutDm.id, role: "member" });
    const channel = await createChannel(serverA.id, "typed-pinned-preserve-channel");
    await addHuman(channel.id, userAB.id);
  const token = await tokenForHuman(userAB.email);

    async function patch(body: unknown) {
      return fetch(`${app.baseUrl}/api/servers/${serverA.id}/sidebar-order`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Server-Id": serverA.id,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    }

    const seedRes = await patch({
      pinned: [
        { kind: "human", id: peerWithoutDm.id },
        { kind: "channel", id: channel.id },
      ],
    });
    assert.equal(seedRes.status, 200);
    const seedBody = await seedRes.json() as {
      pinned: Array<{ kind: "channel" | "agent" | "human"; id: string }>;
      pinnedChannelIds: string[];
      pinnedAgentIds: string[];
      pinnedOrder: string[];
      pinnedVersion: number;
    };
    assert.deepEqual(seedBody.pinned, [
      { kind: "human", id: peerWithoutDm.id },
      { kind: "channel", id: channel.id },
    ]);
    assert.deepEqual(seedBody.pinnedChannelIds, [channel.id]);
    assert.deepEqual(seedBody.pinnedOrder, [channel.id]);
    assert.equal(seedBody.pinnedVersion, 1);

    const legacyRes = await patch({
      pinnedChannelIds: [],
      pinnedAgentIds: [],
      pinnedOrder: [],
    });
    assert.equal(legacyRes.status, 200);
    const legacyBody = await legacyRes.json() as typeof seedBody;
    assert.deepEqual(legacyBody.pinned, [
      { kind: "human", id: peerWithoutDm.id },
    ]);
    assert.deepEqual(legacyBody.pinnedChannelIds, []);
    assert.deepEqual(legacyBody.pinnedAgentIds, []);
    assert.deepEqual(legacyBody.pinnedOrder, []);
    assert.equal(legacyBody.pinnedVersion, 2);
    assert.deepEqual(events.at(-1), {
      room: `user:${userAB.id}`,
      event: "pinned:updated",
      payload: {
        pinned: [
          { kind: "human", id: peerWithoutDm.id },
        ],
        pinnedVersion: 2,
      },
    });
});

test("receiver-state push kill-switch suppresses pinned emits but leaves versions visible", async () => {
  const previousFlag = process.env.SLOCK_RECEIVER_STATE_PUSH_ENABLED;
  process.env.SLOCK_RECEIVER_STATE_PUSH_ENABLED = "false";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const events = installFakeIo(app.app);
    const { userAB, serverA } = await seedTwoServerFixture();
    const channel = await createChannel(serverA.id, "pinned-flag-channel");
    await addHuman(channel.id, userAB.id);
    const token = await tokenForHuman(userAB.email);

    const patchRes = await fetch(`${app.baseUrl}/api/servers/${serverA.id}/sidebar-order`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Server-Id": serverA.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        pinned: [{ kind: "channel", id: channel.id }],
      }),
    });
    assert.equal(patchRes.status, 200);
    const patchBody = await patchRes.json() as {
      pinned: Array<{ kind: "channel" | "agent" | "human"; id: string }>;
      pinnedVersion: number;
    };
    assert.deepEqual(patchBody.pinned, [{ kind: "channel", id: channel.id }]);
    assert.equal(patchBody.pinnedVersion, 1);
    assert.deepEqual(events, [], "receiver-state push kill-switch should suppress pinned socket emits");

    const getRes = await fetch(`${app.baseUrl}/api/servers/${serverA.id}/sidebar-order`, {
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": serverA.id },
    });
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json() as typeof patchBody;
    assert.deepEqual(getBody.pinned, patchBody.pinned);
    assert.equal(getBody.pinnedVersion, 1);
  } finally {
    if (previousFlag === undefined) delete process.env.SLOCK_RECEIVER_STATE_PUSH_ENABLED;
    else process.env.SLOCK_RECEIVER_STATE_PUSH_ENABLED = previousFlag;
    await app.close();
  }
});

async function seedRoleFixture(serverSlug: string) {
  const db = getDb();
  const seed = async (email: string) => {
    const [row] = await db.insert(users).values({
      email,
      name: email.split("@")[0],
      displayName: email.split("@")[0],
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    return row;
  };
  const owner = await seed(`owner-${serverSlug}@slock.test`);
  const admin = await seed(`admin-${serverSlug}@slock.test`);
  const member = await seed(`member-${serverSlug}@slock.test`);
  const server = await createServer(`Role ${serverSlug}`, serverSlug, owner.id);
  await db.update(serversTable).set({ plan: "founder" }).where(eq(serversTable.id, server.id));
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: admin.id, role: "admin" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);
  return { owner, admin, member, server };
}

async function getServerMemberRole(serverId: string, userId: string) {
  const [row] = await getDb()
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
  return row?.role;
}

test("PATCH /api/servers/:id/members/:memberId lets owners grant and revoke owner role while preserving a remaining owner", async ({ app }) => {
    const { owner, admin, member, server } = await seedRoleFixture("multi-owner-roles");
  const ownerToken = await tokenForHuman(owner.email);
  const adminToken = await tokenForHuman(admin.email);

    const patchRole = (token: string, targetId: string, role: string) => fetch(`${app.baseUrl}/api/servers/${server.id}/members/${targetId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Server-Id": server.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ role }),
    });

    const adminOwnerRes = await patchRole(adminToken, member.id, "owner");
    assert.equal(adminOwnerRes.status, 403, "admin cannot grant owner");

    const promoteOwnerRes = await patchRole(ownerToken, member.id, "owner");
    assert.equal(promoteOwnerRes.status, 200);
    assert.equal(await getServerMemberRole(server.id, member.id), "owner");

    const revokeOwnerRes = await patchRole(ownerToken, member.id, "member");
    assert.equal(revokeOwnerRes.status, 200);
    assert.equal(await getServerMemberRole(server.id, member.id), "member");

    const selfDemoteRes = await patchRole(ownerToken, owner.id, "member");
    assert.equal(selfDemoteRes.status, 400, "owners still cannot change their own role through the member route");
});

test("PATCH member role never makes a Guest; a bound Guest is promoted with no flag, keeping its channel; audit", async ({ app }) => {
    const db = getDb();
    const { owner, admin, member, server } = await seedRoleFixture("guest-role-transitions");
    const secondOwner = await (async () => {
      const [row] = await db.insert(users).values({
        email: "second-owner-guest-role-transitions@slock.test",
        name: "second-owner-guest-role-transitions",
        displayName: "Second Owner",
        passwordHash: await fixturePasswordHash("password123"),
        emailVerified: true,
        profileSetupCompletedAt: new Date(),
      }).returning();
      return row;
    })();
    const ownerToken = await tokenForHuman(owner.email);
    const adminToken = await tokenForHuman(admin.email);
    const patchRole = (token: string, targetId: string, role: string) => fetch(
      `${app.baseUrl}/api/servers/${server.id}/members/${targetId}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Server-Id": server.id,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ role }),
      },
    );
    const [allChannel] = await db.select({ id: channelsTable.id })
      .from(channelsTable)
      .where(and(eq(channelsTable.serverId, server.id), eq(channelsTable.name, "all")));
    assert.ok(allChannel);
    const ordinary = await createChannel(server.id, "guest-role-ordinary", undefined, "channel");
    await db.insert(channelHumans).values([
      { channelId: allChannel.id, userId: member.id, role: "member" },
      { channelId: ordinary.id, userId: member.id, role: "admin" },
    ]).onConflictDoNothing();

    // Guests are invited to a channel (#wg-rbac:#15): no role change makes one,
    // whoever asks, with the old rollout flag on or off.
    for (const flagOn of [false, true]) {
      if (flagOn) {
        await db.insert(featureFlagRules).values({
          id: randomUUID(), flagKey: SERVER_GUEST_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [server.id],
        });
      }
      for (const token of [ownerToken, adminToken]) {
        const demote = await patchRole(token, member.id, "guest");
        assert.equal(demote.status, 403, `flag ${flagOn ? "on" : "off"}: Member-to-Guest is refused`);
      }
    }
    assert.equal(await getServerMemberRole(server.id, member.id), "member");
    const [ordinaryMembership] = await db.select().from(channelHumans).where(and(
      eq(channelHumans.channelId, ordinary.id),
      eq(channelHumans.userId, member.id),
    ));
    assert.equal(ordinaryMembership?.role, "admin", "a refused transition changes no channel authority");
    assert.equal((await db.select().from(channelHumans).where(and(
      eq(channelHumans.channelId, allChannel.id),
      eq(channelHumans.userId, member.id),
    ))).length, 1, "a refused transition leaves #all membership");
    await db.insert(serverMembers).values({ serverId: server.id, userId: secondOwner.id, role: "owner" });
    assert.equal((await patchRole(ownerToken, owner.id, "guest")).status, 403, "an Owner cannot self-transition to Guest either");
    assert.equal(await getServerMemberRole(server.id, owner.id), "owner");

    // A bound Guest is promoted, with no rollout flag needed: the binding clears, its channel stays.
    await db.delete(featureFlagRules).where(eq(featureFlagRules.flagKey, SERVER_GUEST_FEATURE_FLAG_KEY));
    const guestHome = await createChannel(server.id, "guest-role-home", undefined, "private");
    const [guestUser] = await db.insert(users).values({
      email: "guest-guest-role-transitions@slock.test",
      name: "guest-guest-role-transitions",
      displayName: "Guest",
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    await seedBoundGuest({ serverId: server.id, userId: guestUser!.id, channelId: guestHome.id });
    const restore = await patchRole(adminToken, guestUser!.id, "member");
    assert.equal(restore.status, 200, "Admin may promote a Guest to Member");
    const [promoted] = await db.select({ role: serverMembers.role, guestChannelId: serverMembers.guestChannelId })
      .from(serverMembers)
      .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, guestUser!.id)));
    assert.deepEqual(promoted, { role: "member", guestChannelId: null });
    assert.equal(
      (await db.select().from(channelHumans).where(and(
        eq(channelHumans.channelId, guestHome.id),
        eq(channelHumans.userId, guestUser!.id),
      ))).length,
      1,
      "Guest-to-Member preserves its channel membership",
    );

    assert.equal((await patchRole(adminToken, owner.id, "member")).status, 403);
    assert.equal((await patchRole(adminToken, admin.id, "member")).status, 403);
    assert.equal((await patchRole(adminToken, member.id, "owner")).status, 403);
    assert.equal((await patchRole(adminToken, admin.id, "admin")).status, 403, "Admin cannot even no-op a protected Admin target");

    const audits = await db.select().from(serverMemberRoleAuditEvents)
      .where(eq(serverMemberRoleAuditEvents.serverId, server.id));
    assert.deepEqual(
      audits.map(({ actorUserId, targetUserId, previousRole, nextRole }) => ({
        actorUserId,
        targetUserId,
        previousRole,
        nextRole,
      })),
      [
        { actorUserId: admin.id, targetUserId: guestUser!.id, previousRole: "guest", nextRole: "member" },
      ],
      "only committed role changes write durable audit facts",
    );
});

test("Guest-to-Member transition reacquires a paid human seat", async ({ app }) => {
  const db = getDb();
  const owner = await seedPasswordUser("guest-seat-transition-owner");
  const guest = await seedPasswordUser("guest-seat-transition-guest");
  const server = await createServer("Guest seat transition", `guest-seat-transition-${randomUUID()}`, owner.id);
  await seedBoundGuest({ serverId: server.id, userId: guest.id }, db);
  await insertActiveProSubscription(server.id, owner.id, 1);
  await db.insert(featureFlagRules).values({
    id: randomUUID(),
    flagKey: SERVER_GUEST_FEATURE_FLAG_KEY,
    stage: "server",
    priority: 0,
    decision: "allow",
    values: [server.id],
  });

  const response = await fetch(`${app.baseUrl}/api/servers/${server.id}/members/${guest.id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${await tokenForHuman(owner.email)}`,
      "X-Server-Id": server.id,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ role: "member" }),
  });
  assert.equal(response.status, 409);
  const refusal = await response.json() as { code?: string; capacityLimit?: { limit?: number; nextUsage?: number } };
  assert.equal(refusal.code, "human_seat_limit_reached");
  assert.equal(refusal.capacityLimit?.limit, 1);
  assert.equal(refusal.capacityLimit?.nextUsage, 2);
  const [membership] = await db.select({ role: serverMembers.role }).from(serverMembers).where(and(
    eq(serverMembers.serverId, server.id),
    eq(serverMembers.userId, guest.id),
  ));
  assert.equal(membership?.role, "guest", "failed promotion leaves the Guest membership unchanged");
});

test("DELETE /api/servers/:id/members/:memberId allows removing a non-last owner only by another owner", async ({ app }) => {
    const { owner, admin, member, server } = await seedRoleFixture("multi-owner-remove");
    await getDb()
      .update(serverMembers)
      .set({ role: "owner" })
      .where(eq(serverMembers.userId, member.id));

  const ownerToken = await tokenForHuman(owner.email);
  const adminToken = await tokenForHuman(admin.email);

    const remove = (token: string, targetId: string) => fetch(`${app.baseUrl}/api/servers/${server.id}/members/${targetId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Server-Id": server.id,
      },
    });

    const adminRemoveOwnerRes = await remove(adminToken, member.id);
    assert.equal(adminRemoveOwnerRes.status, 403, "admin cannot remove owner");

    const ownerRemoveOwnerRes = await remove(ownerToken, member.id);
    assert.equal(ownerRemoveOwnerRes.status, 200);
    assert.equal(await getServerMemberRole(server.id, member.id), undefined);

    const removeLastOwnerRes = await remove(ownerToken, owner.id);
    assert.equal(removeLastOwnerRes.status, 400, "last owner cannot be removed");
});

test("POST /api/servers/:id/leave lets an owner leave only when another owner remains", async ({ app }) => {
    const { owner, member, server } = await seedRoleFixture("multi-owner-leave");
  const ownerToken = await tokenForHuman(owner.email);
  const memberToken = await tokenForHuman(member.email);

    const leave = (token: string) => fetch(`${app.baseUrl}/api/servers/${server.id}/leave`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
    });

    const onlyOwnerRes = await leave(ownerToken);
    assert.equal(onlyOwnerRes.status, 405);

    await getDb()
      .update(serverMembers)
      .set({ role: "owner" })
      .where(eq(serverMembers.userId, member.id));

    const secondOwnerRes = await leave(memberToken);
    assert.equal(secondOwnerRes.status, 200);
});

test("PATCH /api/servers/:id lets owner and admin rename, rejects member", async ({ app }) => {
    const { owner, admin, member, server } = await seedRoleFixture("patch-profile");

    async function patch(token: string, body: unknown) {
      return fetch(`${app.baseUrl}/api/servers/${server.id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Server-Id": server.id,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    }

  const ownerToken = await tokenForHuman(owner.email);
    const ownerRes = await patch(ownerToken, { name: "Renamed by Owner", hideHumansFromMembers: true });
    assert.equal(ownerRes.status, 200);
    const ownerBody = await ownerRes.json() as { name: string; hideHumansFromMembers: boolean };
    assert.equal(ownerBody.name, "Renamed by Owner");
    assert.equal(ownerBody.hideHumansFromMembers, true);

    const [storedAfterOwner] = await getDb()
      .select({ hideHumansFromMembers: serversTable.hideHumansFromMembers })
      .from(serversTable)
      .where(eq(serversTable.id, server.id));
    assert.equal(storedAfterOwner.hideHumansFromMembers, true);

  const adminToken = await tokenForHuman(admin.email);
    const adminRes = await patch(adminToken, { name: "Renamed by Admin", hideHumansFromMembers: false });
    assert.equal(adminRes.status, 200);
    const adminBody = await adminRes.json() as { name: string; hideHumansFromMembers: boolean };
    assert.equal(adminBody.name, "Renamed by Admin");
    assert.equal(adminBody.hideHumansFromMembers, false);

  const memberToken = await tokenForHuman(member.email);
    const memberRes = await patch(memberToken, { hideHumansFromMembers: true });
    assert.equal(memberRes.status, 403);

    const emptyRes = await patch(ownerToken, { name: "   " });
    assert.equal(emptyRes.status, 400);

    const invalidPrivacyRes = await patch(ownerToken, { hideHumansFromMembers: "yes" });
    assert.equal(invalidPrivacyRes.status, 400);
});

test("POST /api/servers/:id/avatar lets owner and admin upload server avatar", async ({ app }) => {
    const { owner, admin, member, server } = await seedRoleFixture("server-avatar");

    async function upload(token: string, filename: string) {
      const formData = new FormData();
      formData.set("avatar", new Blob([ONE_BY_ONE_GIF], { type: "image/gif" }), filename);
      return fetch(`${app.baseUrl}/api/servers/${server.id}/avatar`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Server-Id": server.id,
        },
        body: formData,
      });
    }

  const ownerToken = await tokenForHuman(owner.email);
    const ownerRes = await upload(ownerToken, "owner.gif");
    assert.equal(ownerRes.status, 200);
    const ownerBody = await ownerRes.json() as { avatarUrl: string | null };
    assert.match(ownerBody.avatarUrl ?? "", new RegExp(`^/api/avatars/server-${server.id}/[0-9a-f]+\\.webp$`));

    const getRes = await fetch(`${app.baseUrl}/api/servers/${server.id}`, {
      headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id },
    });
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json() as { avatarUrl: string | null };
    assert.equal(getBody.avatarUrl, ownerBody.avatarUrl);

  const adminToken = await tokenForHuman(admin.email);
    const adminRes = await upload(adminToken, "admin.gif");
    assert.equal(adminRes.status, 200);

  const memberToken = await tokenForHuman(member.email);
    const memberRes = await upload(memberToken, "member.gif");
    assert.equal(memberRes.status, 403);
});

test("POST /api/servers/:id/invites rejects invalid email addresses", async ({ app }) => {
    const { owner, server } = await seedRoleFixture("invite-invalid-email");
  const ownerToken = await tokenForHuman(owner.email);

    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/invites`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "X-Server-Id": server.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: "not-an-email" }),
    });

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Enter a valid email address" });
});

test("two paid seats let an owner invite and accept one more human", async ({ app }) => {
  const owner = await seedPasswordUser("two-seat-invite-owner");
  const invitee = await seedPasswordUser("two-seat-invitee");
  const server = await createServer("Two Seat Invite", `two-seat-invite-${randomUUID()}`, owner.id);
  await insertActiveProSubscription(server.id, owner.id, 2);
  const ownerToken = await tokenForHuman(owner.email);

  const inviteRes = await fetch(`${app.baseUrl}/api/servers/${server.id}/invites`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      "X-Server-Id": server.id,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email: invitee.email }),
  });
  assert.equal(inviteRes.status, 200, await inviteRes.clone().text());

  const [invite] = await getDb()
    .select({ id: serverInvites.id })
    .from(serverInvites)
    .where(and(
      eq(serverInvites.serverId, server.id),
      eq(serverInvites.invitedEmail, invitee.email),
      eq(serverInvites.status, "pending"),
    ));
  assert.ok(invite, "the email invite must be persisted before it can be accepted");

  // The production API deliberately returns no bearer token. Rebind only its
  // one-way hash in the isolated test database so this same persisted invite
  // can traverse the authenticated acceptance route.
  const rawToken = `two-seat-invite-${randomUUID()}`;
  await getDb()
    .update(serverInvites)
    .set({ tokenHash: createHash("sha256").update(rawToken).digest("hex") })
    .where(eq(serverInvites.id, invite.id));

  const previewRes = await fetch(`${app.baseUrl}/api/auth/invite-info?token=${encodeURIComponent(rawToken)}`);
  assert.equal(previewRes.status, 200);
  const preview = await previewRes.json() as { humanSeatLimitReached: boolean };
  assert.equal(preview.humanSeatLimitReached, false);

  const inviteeToken = await tokenForHuman(invitee.email);
  const acceptRes = await fetch(`${app.baseUrl}/api/auth/accept-invite`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${inviteeToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token: rawToken }),
  });
  assert.equal(acceptRes.status, 200, await acceptRes.clone().text());

  const [membership] = await getDb()
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, invitee.id)));
  assert.deepEqual(membership, { role: "member" });
});

test("email invites are blocked but join links can be created when Pro universal seats are full", async ({ app }) => {
    const owner = await seedPasswordUser("full-human-seat-owner");
    const server = await createServer("Full Human Seat", `full-human-seat-${randomUUID()}`, owner.id);
    await insertActiveProSubscription(server.id, owner.id, 1);
  const ownerToken = await tokenForHuman(owner.email);

    const inviteRes = await fetch(`${app.baseUrl}/api/servers/${server.id}/invites`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "X-Server-Id": server.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: `new-human-${randomUUID()}@slock.test` }),
    });
    assert.equal(inviteRes.status, 400);
    const inviteRefusal = await inviteRes.json() as { error: string; code?: string; capacityLimit?: Record<string, unknown> };
    assert.match(inviteRefusal.error, /Seat limit reached \(1\/1 on Pro plan\)/);
    assert.equal(inviteRefusal.code, "human_seat_limit_reached");
    assert.deepEqual(inviteRefusal.capacityLimit, { limitType: "universal", limit: 1, usage: 1, nextUsage: 2, humans: 1, agents: 0 });

    await getDb().insert(featureFlagRules).values({
      id: randomUUID(),
      flagKey: SERVER_GUEST_FEATURE_FLAG_KEY,
      stage: "server",
      priority: 0,
      decision: "allow",
      values: [server.id],
    });
    const guestInviteRes = await fetch(`${app.baseUrl}/api/servers/${server.id}/invites`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "X-Server-Id": server.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: `new-guest-${randomUUID()}@slock.test`, role: "guest" }),
    });
    // A Guest is invited to a channel, not to the server (#wg-rbac:#15): refused, seats full or not.
    assert.equal(guestInviteRes.status, 400);
    assert.deepEqual(await guestInviteRes.json(), { error: "Guests are invited to one channel, not to the server" });

    const linkRes = await fetch(`${app.baseUrl}/api/servers/${server.id}/join-links`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "X-Server-Id": server.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ maxUses: null, expiresAt: null }),
    });
    assert.equal(linkRes.status, 200);
    const linkBody = await linkRes.json() as { token: string };
    assert.ok(linkBody.token);

    const infoRes = await fetch(`${app.baseUrl}/api/auth/invite-info?token=${encodeURIComponent(linkBody.token)}`);
    assert.equal(infoRes.status, 200);
    const info = await infoRes.json() as {
      humanSeatLimitReached: boolean;
      humanSeatLimitMessage: string | null;
    };
    assert.equal(info.humanSeatLimitReached, true);
    assert.match(info.humanSeatLimitMessage ?? "", /Seat limit reached \(1\/1 on Pro plan\)/);
});

test("accepting an existing join link reports human seat exhaustion", async ({ app }) => {
    const owner = await seedPasswordUser("stale-link-owner");
    const invitee = await seedPasswordUser("stale-link-invitee");
    const server = await createServer("Stale Join Link", `stale-join-link-${randomUUID()}`, owner.id);
  const ownerToken = await tokenForHuman(owner.email);

    const linkRes = await fetch(`${app.baseUrl}/api/servers/${server.id}/join-links`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "X-Server-Id": server.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ maxUses: null, expiresAt: null }),
    });
    assert.equal(linkRes.status, 200);
    const linkBody = await linkRes.json() as { token: string };
    await insertActiveProSubscription(server.id, owner.id, 1);

    const infoRes = await fetch(`${app.baseUrl}/api/auth/invite-info?token=${encodeURIComponent(linkBody.token)}`);
    assert.equal(infoRes.status, 200);
    const info = await infoRes.json() as {
      humanSeatLimitReached: boolean;
      humanSeatLimitMessage: string | null;
    };
    assert.equal(info.humanSeatLimitReached, true);
    assert.match(info.humanSeatLimitMessage ?? "", /Seat limit reached \(1\/1 on Pro plan\)/);

  const inviteeToken = await tokenForHuman(invitee.email);
    const acceptRes = await fetch(`${app.baseUrl}/api/auth/accept-invite`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${inviteeToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token: linkBody.token }),
    });
    assert.equal(acceptRes.status, 400);
    const acceptRefusal = await acceptRes.json() as { error: string; code?: string; capacityLimit?: unknown };
    assert.match(acceptRefusal.error, /Seat limit reached \(1\/1 on Pro plan\)/);
    // The invitee isn't a member: the code, but not how many people and agents the server has.
    assert.equal(acceptRefusal.code, "human_seat_limit_reached");
    assert.equal(acceptRefusal.capacityLimit, undefined);
});

test("GET /api/servers/:id/settings groups onboarding and feedback settings without leaking configuration", async () => {
  const envKeys = [
    "HANDS_FEEDBACK_BASE_URL",
    "HANDS_FEEDBACK_APP_SLUG",
    "HANDS_FEEDBACK_CLIENT_KEY",
    "HANDS_FEEDBACK_APP_TOKEN",
    "HANDS_FEEDBACK_REPORTER_ID_SECRET",
    "HANDS_FEEDBACK_APP_ID",
    "HANDS_FEEDBACK_CONVERSATION_APP_TOKEN",
    "HANDS_FEEDBACK_CONVERSATION_CREDENTIAL_REVISION",
    "HANDS_FEEDBACK_CONVERSATION_SESSION_ENABLED",
    "HANDS_FEEDBACK_CURSOR_SECRET",
    "HANDS_FEEDBACK_REPORTER_INTEGRATION_ID",
    "HANDS_FEEDBACK_ROUTE_SUBJECT_KEY_ID",
    "HANDS_FEEDBACK_ROUTE_SUBJECT_ROOT",
  ] as const;
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    HANDS_FEEDBACK_BASE_URL: "https://hands.example",
    HANDS_FEEDBACK_APP_SLUG: "raft-web",
    HANDS_FEEDBACK_CLIENT_KEY: "test-client-key",
    HANDS_FEEDBACK_APP_TOKEN: "test-app-token",
    HANDS_FEEDBACK_REPORTER_ID_SECRET: "test-reporter-secret",
    HANDS_FEEDBACK_APP_ID: "11111111-1111-4111-8111-111111111111",
    HANDS_FEEDBACK_CONVERSATION_APP_TOKEN: "test-conversation-token",
    HANDS_FEEDBACK_CONVERSATION_CREDENTIAL_REVISION: "revision-1",
    HANDS_FEEDBACK_CURSOR_SECRET: "test-cursor-secret",
    HANDS_FEEDBACK_REPORTER_INTEGRATION_ID: "legacy-feedback:11111111-1111-4111-8111-111111111111",
    HANDS_FEEDBACK_ROUTE_SUBJECT_KEY_ID: "v1",
    HANDS_FEEDBACK_ROUTE_SUBJECT_ROOT: Buffer.alloc(32, 1).toString("base64url"),
  });

  let app: Awaited<ReturnType<typeof openTestApp>> | null = null;
  try {
    app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
    const { owner, server } = await seedRoleFixture("general-server-settings");
    const token = await tokenForHuman(owner.email);
    const headers = { Authorization: `Bearer ${token}`, "X-Server-Id": server.id };

    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/settings`, { headers });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      settings: {
        onboardSettings: { onboardingAgentId: string | null };
        feedbackSettings: { enabled?: boolean };
      };
    };
    assert.equal(body.settings.onboardSettings.onboardingAgentId, null);
    assert.equal(body.settings.feedbackSettings.enabled, true);
    const serialized = JSON.stringify(body);
    assert.doesNotMatch(serialized, /test-client-key|test-app-token|test-reporter-secret|https:\/\/hands\.example|raft-web/);

    const legacyRes = await fetch(`${app.baseUrl}/api/servers/${server.id}/onboarding-settings`, { headers });
    assert.equal(legacyRes.status, 200);
    assert.deepEqual(await legacyRes.json(), body.settings.onboardSettings);
  } finally {
    await app?.close();
    for (const key of envKeys) {
      const previous = previousEnv[key];
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }
});

test("PATCH /api/servers/:id/onboarding-settings lets owner/admin set onboarding agent and keeps member limited to reminder prefs", async ({ app }) => {
    const { owner, admin, member, server } = await seedRoleFixture("onboarding-settings");
    const ownerAgent = await createAgent(server.id, "owner-onboarding-agent", { runtime: "codex" });
    const adminAgent = await createAgent(server.id, "admin-onboarding-agent", { runtime: "codex" });

    async function patch(token: string, body: unknown) {
      return fetch(`${app.baseUrl}/api/servers/${server.id}/onboarding-settings`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Server-Id": server.id,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    }

  const ownerToken = await tokenForHuman(owner.email);
    const initialRes = await fetch(`${app.baseUrl}/api/servers/${server.id}/onboarding-settings`, {
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "X-Server-Id": server.id,
      },
    });
    assert.equal(initialRes.status, 200);
    const initialBody = await initialRes.json() as {
      agentAllChannelGreetingEnabled: boolean;
      onboardingWizardEnabled: boolean;
      dismissedAddComputerStepAt: string | null;
      dismissedCreateAgentStepAt: string | null;
      dismissedInviteStepAt: string | null;
      dismissedCommunityStepAt: string | null;
      dismissedNotificationStepAt: string | null;
      onboardingWizardCurrentStep: string | null;
    };
    assert.equal(initialBody.agentAllChannelGreetingEnabled, true);
    assert.equal(initialBody.onboardingWizardEnabled, true);
    assert.equal(initialBody.dismissedAddComputerStepAt, null);
    assert.equal(initialBody.dismissedCreateAgentStepAt, null);
    assert.equal(initialBody.dismissedInviteStepAt, null);
    assert.equal(initialBody.dismissedCommunityStepAt, null);
    assert.equal(initialBody.dismissedNotificationStepAt, null);
    assert.equal(initialBody.onboardingWizardCurrentStep, null);

    const ownerRes = await patch(ownerToken, { onboardingAgentId: ownerAgent.id, agentAllChannelGreetingEnabled: false });
    assert.equal(ownerRes.status, 200);
    const ownerBody = await ownerRes.json() as { onboardingAgentId: string | null; agentAllChannelGreetingEnabled: boolean };
    assert.equal(ownerBody.onboardingAgentId, ownerAgent.id);
    assert.equal(ownerBody.agentAllChannelGreetingEnabled, false);

  const adminToken = await tokenForHuman(admin.email);
    const adminRes = await patch(adminToken, { onboardingAgentId: adminAgent.id, agentAllChannelGreetingEnabled: true });
    assert.equal(adminRes.status, 200);
    const adminBody = await adminRes.json() as { onboardingAgentId: string | null; agentAllChannelGreetingEnabled: boolean };
    assert.equal(adminBody.onboardingAgentId, adminAgent.id);
    assert.equal(adminBody.agentAllChannelGreetingEnabled, true);

  const memberToken = await tokenForHuman(member.email);
    const memberReminderRes = await patch(memberToken, {
      setupModalReminderOptOut: true,
      dismissedAddComputerStep: true,
      dismissedCreateAgentStep: true,
      dismissedInviteStep: true,
      dismissedCommunityStep: true,
      dismissedNotificationStep: true,
      onboardingWizardCurrentStep: "invite-teammates",
    });
    assert.equal(memberReminderRes.status, 200);
    const memberReminderBody = await memberReminderRes.json() as {
      setupModalReminderOptOut: boolean;
      dismissedAddComputerStepAt: string | null;
      dismissedCreateAgentStepAt: string | null;
      dismissedInviteStepAt: string | null;
      dismissedCommunityStepAt: string | null;
      dismissedNotificationStepAt: string | null;
      onboardingWizardCurrentStep: string | null;
    };
    assert.equal(memberReminderBody.setupModalReminderOptOut, true);
    assert.ok(memberReminderBody.dismissedAddComputerStepAt);
    assert.ok(memberReminderBody.dismissedCreateAgentStepAt);
    assert.ok(memberReminderBody.dismissedInviteStepAt);
    assert.ok(memberReminderBody.dismissedCommunityStepAt);
    assert.ok(memberReminderBody.dismissedNotificationStepAt);
    assert.equal(memberReminderBody.onboardingWizardCurrentStep, "invite-teammates");

    const memberClearStepRes = await patch(memberToken, { onboardingWizardCurrentStep: null });
    assert.equal(memberClearStepRes.status, 200);
    const memberClearStepBody = await memberClearStepRes.json() as { onboardingWizardCurrentStep: string | null };
    assert.equal(memberClearStepBody.onboardingWizardCurrentStep, null);

    const memberAgentRes = await patch(memberToken, { onboardingAgentId: ownerAgent.id });
    assert.equal(memberAgentRes.status, 403);
    const memberAgentBody = await memberAgentRes.json() as { error: string };
    assert.equal(memberAgentBody.error, "Only server owners and admins can update onboarding settings");

    const memberGreetingRes = await patch(memberToken, { agentAllChannelGreetingEnabled: false });
    assert.equal(memberGreetingRes.status, 403);

    const invalidGreetingRes = await patch(ownerToken, { agentAllChannelGreetingEnabled: "nope" });
    assert.equal(invalidGreetingRes.status, 400);

    const invalidStepRes = await patch(memberToken, { onboardingWizardCurrentStep: "bogus" });
    assert.equal(invalidStepRes.status, 400);
});

test("GET /api/servers/:id/onboarding-settings disables owner wizard gate for community servers", async ({ app }) => {
    for (const slug of ["community", "community-cn"]) {
      const { owner, server } = await seedRoleFixture(slug);
    const ownerToken = await tokenForHuman(owner.email);
      const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/onboarding-settings`, {
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "X-Server-Id": server.id,
        },
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { onboardingWizardEnabled: boolean };
      assert.equal(body.onboardingWizardEnabled, false, `${slug} must never show the owner wizard`);
    }
});

test("server setup projection and transition routes reject retired defer and enforce completion gates", async ({ app }) => {
    const { owner, member, server } = await seedRoleFixture("setup-projection-routes");
  const ownerToken = await tokenForHuman(owner.email);
  const memberToken = await tokenForHuman(member.email);
    const headers = (token: string) => ({
      Authorization: `Bearer ${token}`,
      "X-Server-Id": server.id,
      "Content-Type": "application/json",
    });
    const getProjection = (token: string) => fetch(
      `${app.baseUrl}/api/servers/${server.id}/setup-projection`,
      { headers: headers(token) },
    );
    const transition = (token: string, action: string) => fetch(
      `${app.baseUrl}/api/servers/${server.id}/setup-transition`,
      {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify({ action }),
      },
    );

    const initial = await getProjection(ownerToken);
    assert.equal(initial.status, 200);
    assert.deepEqual(await initial.json(), {
      surface: "computer_runtime",
      phase: "not_started",
      currentStep: "computer_runtime",
      blocksChat: true,
      // No bypass is OFFERED any more — an unfinished server is finished, or it is thrown away.
      // (The `defer` transition itself still exists: rows in the database still hold `deferred`,
      // and a column has to be able to describe its own past even after we stop writing to it.)
      allowedExits: ["reset", "return_to_server"],
      sideEffectState: { transitions: "enabled", completion: "disabled" },
      // Screen B's two facts now ride the projection: the server decides "is the runtime
      // usable / is the computer online", and the browser draws it instead of deriving a
      // second opinion from the socket-fed machine store (task #159).
      computerStatus: "offline",
      runtimeStatus: "unknown",
      runtimeOptions: [],
      // DURABLE: no non-revoked `computers` row. A closed laptop is not the same as never
      // having connected one, and the recovery screen names the ones they do have.
      hasConnectedComputer: false,
      offlineComputers: [],
      gateReason: "computer_offline",
      // Nothing is owed before the flow is finished: the survey and the handoff are the
      // two screens AFTER setup completes. `not_started` cannot owe them.
      postSetup: { surveyPending: false, upgradePending: false, handoffPending: false },
      hostedCindyTestEntry: false,
    });

    const memberProjection = await getProjection(memberToken);
    assert.equal(memberProjection.status, 200);
    assert.deepEqual(await memberProjection.json(), {
      surface: "none",
      phase: null,
      currentStep: null,
      blocksChat: false,
      allowedExits: ["return_to_server"],
      sideEffectState: { transitions: "disabled", completion: "disabled" },
      gateReason: "insufficient_permission",
      // No live facts were resolved on this path, so we say "unknown" rather than
      // inventing "offline"/"not_ready". Absence of a reading is not a reading.
      computerStatus: "unknown",
      runtimeStatus: "unknown",
      runtimeOptions: [],
      hasConnectedComputer: false,
      offlineComputers: [],
      postSetup: { surveyPending: false, upgradePending: false, handoffPending: false },
      hostedCindyTestEntry: false,
    });
    const memberStart = await transition(memberToken, "start");
    assert.equal(memberStart.status, 403);
    assert.deepEqual(await memberStart.json(), { error: "INSUFFICIENT_PERMISSION" });

    const advance = await transition(ownerToken, "advance");
    assert.equal(advance.status, 400);
    assert.deepEqual(await advance.json(), { error: "INVALID_SETUP_ACTION" });

    const started = await transition(ownerToken, "start");
    assert.equal(started.status, 200);
    assert.equal((await started.json() as { phase: string }).phase, "in_progress");

    // task #172 Phase 1: `defer` is a retired action. The endpoint rejects it (so the runtime
    // never writes a new `deferred` row), and the persisted state is left untouched.
    const deferred = await transition(ownerToken, "defer");
    assert.equal(deferred.status, 400);
    assert.deepEqual(await deferred.json(), { error: "INVALID_SETUP_ACTION" });
    const [afterDefer] = await getDb().select({
      status: serverMembers.setupStatus,
      deferredAt: serverMembers.setupDeferredAt,
    }).from(serverMembers).where(and(
      eq(serverMembers.serverId, server.id),
      eq(serverMembers.userId, owner.id),
    ));
    assert.equal(afterDefer.status, "in_progress");
    assert.equal(afterDefer.deferredAt, null, "a rejected defer writes nothing to setup_deferred_at");

    const [machine] = await getDb().insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "setup-route-computer",
      apiKeyHash: "setup-route-computer-hash",
      runtimes: ["builtin"],
    }).returning();
    // The managed Computer this daemon runs as. Setup online-ness keys off a non-revoked
    // `computers` row linked by `machineId` (same source as `hasConnectedComputer`), which a
    // v2-onboarding `raft-computer setup` always creates — so the connected computer needs one.
    await getDb().insert(computers).values({
      serverId: server.id, name: "setup-route-managed-computer", apiKeyHash: "x",
      apiKeyPrefix: "sk_computer_sr", machineId: machine.id,
    });
    const orchestrator = app.app.get("agentOrchestrator") as {
      getMachineStatus(machineId: string): Promise<"online" | "offline">;
    };
    orchestrator.getMachineStatus = async (machineId) => machineId === machine.id ? "online" : "offline";
    // Runtime readiness is read from the persisted machines.runtimes column — the
    // single cross-replica source the "ready" handler writes before emitting to the
    // client — so drive it by writing that column. The machine was inserted with
    // ["builtin"] above (not recommended/supported → runtime_not_ready).

    const builtinWithoutKey = await getProjection(ownerToken);
    assert.equal(builtinWithoutKey.status, 200);
    const builtinWithoutKeyBody = await builtinWithoutKey.json() as { surface: string; gateReason: string };
    assert.equal(builtinWithoutKeyBody.surface, "computer_runtime");
    assert.equal(builtinWithoutKeyBody.gateReason, "runtime_not_ready");

    await getDb().update(machines).set({ runtimes: ["codex"] }).where(eq(machines.id, machine.id));

    const readyWithoutAgent = await getProjection(ownerToken);
    assert.equal(readyWithoutAgent.status, 200);
    const readyWithoutAgentBody = await readyWithoutAgent.json() as { surface: string; gateReason: string };
    assert.equal(readyWithoutAgentBody.surface, "create_agent");
    assert.equal(readyWithoutAgentBody.gateReason, "official_onboarding_agent_missing");
    const blockedComplete = await transition(ownerToken, "complete");
    assert.equal(blockedComplete.status, 409);
    assert.deepEqual(await blockedComplete.json(), { error: "OFFICIAL_ONBOARDING_AGENT_NOT_USABLE" });

    const [officialAgent] = await getDb().insert(agents).values({
      serverId: server.id,
      name: OFFICIAL_ONBOARDING_AGENT_IDENTITY.name,
      displayName: OFFICIAL_ONBOARDING_AGENT_IDENTITY.displayName,
      description: OFFICIAL_ONBOARDING_AGENT_IDENTITY.description,
      avatarUrl: OFFICIAL_ONBOARDING_AGENT_IDENTITY.avatarUrl,
      runtime: "codex",
      machineId: machine.id,
    }).returning();
    await getDb().insert(serverAgentMembers).values({
      serverId: server.id,
      agentId: officialAgent.id,
      role: "admin",
    });
    await getDb().update(serversTable)
      .set({ onboardingAgentId: officialAgent.id })
      .where(eq(serversTable.id, server.id));

    const completed = await transition(ownerToken, "complete");
    assert.equal(completed.status, 200);
    assert.deepEqual(await completed.json(), {
      surface: "complete",
      phase: "complete",
      currentStep: null,
      blocksChat: false,
      allowedExits: ["return_to_server"],
      sideEffectState: { transitions: "disabled", completion: "disabled" },
      gateReason: "setup_complete",
      // Completed through the real flow, by the owner: both post-setup screens are owed —
      // the survey until it is answered, the handoff until "Let's Go" is pressed (which is
      // now a durable stamp of its own, not a guess from Cindy's briefing delivery).
      computerStatus: "unknown",
      runtimeStatus: "unknown",
      runtimeOptions: [],
      hasConnectedComputer: false,
      offlineComputers: [],
      postSetup: { surveyPending: true, upgradePending: false, handoffPending: true },
    });
});

test("setup Pro step is owed only on Free, and the owner's answer retires it", async ({ app }) => {
  const { owner, member, server } = await seedRoleFixture("setup-upgrade-prompt");
  const ownerToken = await tokenForHuman(owner.email);
  const memberToken = await tokenForHuman(member.email);
  const headers = (token: string) => ({
    Authorization: `Bearer ${token}`,
    "X-Server-Id": server.id,
    "Content-Type": "application/json",
  });
  const postSetup = async () => {
    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/setup-projection`, { headers: headers(ownerToken) });
    assert.equal(res.status, 200);
    return (await res.json() as { postSetup: { surveyPending: boolean; upgradePending: boolean; handoffPending: boolean } }).postSetup;
  };
  const answer = (token: string) => fetch(`${app.baseUrl}/api/servers/${server.id}/setup-upgrade-prompt`, {
    method: "POST",
    headers: headers(token),
  });
  const ownerRow = and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, owner.id));

  // A Free server whose owner finished the real flow and has not pressed "Let's Go" yet.
  await getDb().update(serversTable).set({ plan: "free" }).where(eq(serversTable.id, server.id));
  await getDb().update(serverMembers)
    .set({ setupStatus: "complete", setupCompletionReason: "normal" })
    .where(ownerRow);

  // No feature flag: every Free server owes the step.
  assert.deepEqual(await postSetup(), { surveyPending: true, upgradePending: true, handoffPending: true });

  // Not on Free: no step.
  await getDb().update(serversTable).set({ plan: "founder" }).where(eq(serversTable.id, server.id));
  assert.equal((await postSetup()).upgradePending, false);
  await getDb().update(serversTable).set({ plan: "free" }).where(eq(serversTable.id, server.id));

  // Only the owner can answer it.
  assert.equal((await answer(memberToken)).status, 403);

  const answered = await answer(ownerToken);
  assert.equal(answered.status, 200);
  assert.deepEqual(
    (await answered.json() as { postSetup: unknown }).postSetup,
    { surveyPending: true, upgradePending: false, handoffPending: true },
  );
  const [row] = await getDb().select({ seenAt: serverMembers.setupUpgradePromptSeenAt }).from(serverMembers).where(ownerRow);
  assert.ok(row?.seenAt instanceof Date);

  // Idempotent, and the handoff is still owed.
  assert.equal((await answer(ownerToken)).status, 200);
  assert.deepEqual(await postSetup(), { surveyPending: true, upgradePending: false, handoffPending: true });

  // An owner who already pressed "Let's Go" is never offered it.
  await getDb().update(serverMembers)
    .set({ setupUpgradePromptSeenAt: null, setupHandoffAcknowledgedAt: new Date() })
    .where(ownerRow);
  assert.deepEqual(await postSetup(), { surveyPending: true, upgradePending: false, handoffPending: false });
});

test("GET/PATCH /api/servers/:id/translation-settings is server-scoped and owner/admin managed", async () => {
  await withTranslationEnv({ TRANSLATION_PROVIDER: "fake" }, async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
    try {
      const { owner, admin, member, server } = await seedRoleFixture("translation-settings");

      const request = (token: string, method: "GET" | "PATCH", body?: unknown) => fetch(`${app.baseUrl}/api/servers/${server.id}/translation-settings`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Server-Id": server.id,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      const ownerToken = await tokenForHuman(owner.email);
      const adminToken = await tokenForHuman(admin.email);
      const memberToken = await tokenForHuman(member.email);
      const getRes = await request(ownerToken, "GET");
      assert.equal(getRes.status, 200);
      assert.deepEqual(await getRes.json(), {
        translationEnabled: false,
        translationAvailable: true,
        canManageTranslation: true,
      });

      const memberGet = await request(memberToken, "GET");
      assert.equal(memberGet.status, 200);
      assert.deepEqual(await memberGet.json(), {
        translationEnabled: false,
        translationAvailable: true,
        canManageTranslation: false,
      });

      const memberPatch = await request(memberToken, "PATCH", { translationEnabled: true });
      assert.equal(memberPatch.status, 403);
      assert.deepEqual(await memberPatch.json(), { error: "Only server owners and admins can update translation settings" });

      const invalidPatch = await request(ownerToken, "PATCH", { translationEnabled: "yes" });
      assert.equal(invalidPatch.status, 400);
      assert.deepEqual(await invalidPatch.json(), { error: "translationEnabled must be a boolean" });

      const adminPatch = await request(adminToken, "PATCH", { translationEnabled: true });
      assert.equal(adminPatch.status, 200);
      assert.deepEqual(await adminPatch.json(), {
        translationEnabled: true,
        translationAvailable: true,
        canManageTranslation: true,
      });

      const patchRes = await request(ownerToken, "PATCH", { translationEnabled: false });
      assert.equal(patchRes.status, 200);
      assert.deepEqual(await patchRes.json(), {
        translationEnabled: false,
        translationAvailable: true,
        canManageTranslation: true,
      });
    } finally {
      await app.close();
    }
  });
});

test("GET /api/servers/:id/translation-settings reports Volcengine provider availability from credentials", async () => {
  await withTranslationEnv({
    TRANSLATION_PROVIDER: "volcengine",
    TRANSLATION_VOLCENGINE_ACCESS_KEY_ID: "ak-test",
    TRANSLATION_VOLCENGINE_SECRET_ACCESS_KEY: "sk-test",
  }, async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
    try {
      const { owner, server } = await seedRoleFixture("translation-volcengine-available");
      const ownerToken = await tokenForHuman(owner.email);

      const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/translation-settings`, {
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "X-Server-Id": server.id,
        },
      });

      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        translationEnabled: false,
        translationAvailable: true,
        canManageTranslation: true,
      });
    } finally {
      await app.close();
    }
  });
});

test("GET /api/servers/:id/translation-settings reports Volcengine unavailable without credentials", async () => {
  await withTranslationEnv({ TRANSLATION_PROVIDER: "volcengine" }, async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
    try {
      const { owner, server } = await seedRoleFixture("translation-volcengine-unavailable");
      const ownerToken = await tokenForHuman(owner.email);

      const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/translation-settings`, {
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "X-Server-Id": server.id,
        },
      });

      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        translationEnabled: false,
        translationAvailable: false,
        canManageTranslation: true,
      });
    } finally {
      await app.close();
    }
  });
});

test("GET /api/servers/:id/translation-settings reports Google provider availability from credentials", async () => {
  await withTranslationEnv({
    TRANSLATION_PROVIDER: "google",
    TRANSLATION_GOOGLE_PROJECT_ID: "slock-test",
    TRANSLATION_GOOGLE_ACCESS_TOKEN: "ya29.test",
  }, async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
    try {
      const { owner, server } = await seedRoleFixture("translation-google-available");
      const ownerToken = await tokenForHuman(owner.email);

      const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/translation-settings`, {
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "X-Server-Id": server.id,
        },
      });

      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        translationEnabled: false,
        translationAvailable: true,
        canManageTranslation: true,
      });
    } finally {
      await app.close();
    }
  });
});

test("GET /api/servers/:id/translation-settings reports Google unavailable without auth", async () => {
  await withTranslationEnv({
    TRANSLATION_PROVIDER: "google",
    TRANSLATION_GOOGLE_PROJECT_ID: "slock-test",
  }, async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
    try {
      const { owner, server } = await seedRoleFixture("translation-google-unavailable");
      const ownerToken = await tokenForHuman(owner.email);

      const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/translation-settings`, {
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "X-Server-Id": server.id,
        },
      });

      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        translationEnabled: false,
        translationAvailable: false,
        canManageTranslation: true,
      });
    } finally {
      await app.close();
    }
  });
});

test("GET /api/servers/:id/translation-settings reports translation unavailable when provider is unconfigured", async () => {
  await withTranslationEnv({}, async () => {
    const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
    try {
      const { owner, server } = await seedRoleFixture("translation-unavailable");
      const ownerToken = await tokenForHuman(owner.email);

      const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/translation-settings`, {
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "X-Server-Id": server.id,
        },
      });

      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        translationEnabled: false,
        translationAvailable: false,
        canManageTranslation: true,
      });
    } finally {
      await app.close();
    }
  });
});

test("GET/PATCH /api/servers/:id/notification-settings lets each member mute only their own server notifications", async ({ app }) => {
    const events = installFakeIo(app.app);
    const { owner, member, server } = await seedRoleFixture("notification-settings");
  const memberToken = await tokenForHuman(member.email);
  const ownerToken = await tokenForHuman(owner.email);

    const getSettings = (token: string) => fetch(`${app.baseUrl}/api/servers/${server.id}/notification-settings`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Server-Id": server.id,
      },
    });
    const patchSettings = (token: string, body: unknown) => fetch(`${app.baseUrl}/api/servers/${server.id}/notification-settings`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Server-Id": server.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const initialRes = await getSettings(memberToken);
    assert.equal(initialRes.status, 200);
    const initialBody = await initialRes.json() as { serverPushMuted: boolean; serverPushMentionsOnly: boolean; serverPushMode: string; prefsVersion: number };
    assert.equal(initialBody.serverPushMuted, false);
    assert.equal(initialBody.serverPushMentionsOnly, false);
    assert.equal(initialBody.serverPushMode, "all");
    assert.equal(initialBody.prefsVersion, 0);

    const invalidRes = await patchSettings(memberToken, { serverPushMuted: "yes" });
    assert.equal(invalidRes.status, 400);

    const invalidModeRes = await patchSettings(memberToken, { serverPushMode: "important" });
    assert.equal(invalidModeRes.status, 400);

    const mentionsRes = await patchSettings(memberToken, { serverPushMode: "mentions" });
    assert.equal(mentionsRes.status, 200);
    assert.deepEqual(await mentionsRes.json(), {
      serverPushMuted: false,
      serverPushMentionsOnly: true,
      serverPushMode: "mentions",
      prefsVersion: 1,
    });
    assert.deepEqual(events.at(-1), {
      room: `user:${member.id}`,
      event: "notification_prefs:updated",
      payload: {
        type: "server",
        serverId: server.id,
        scopeId: server.id,
        level: "mentions",
        prefs: {
          serverPushMuted: false,
          serverPushMentionsOnly: true,
          serverPushMode: "mentions",
        },
        prefsVersion: 1,
      },
    });

    const mutedRes = await patchSettings(memberToken, { serverPushMuted: true });
    assert.equal(mutedRes.status, 200);
    const mutedBody = await mutedRes.json() as { serverPushMuted: boolean; serverPushMentionsOnly: boolean; serverPushMode: string; prefsVersion: number };
    assert.equal(mutedBody.serverPushMuted, true);
    assert.equal(mutedBody.serverPushMentionsOnly, false);
    assert.equal(mutedBody.serverPushMode, "none");
    assert.equal(mutedBody.prefsVersion, 2);
    assert.deepEqual(events.at(-1), {
      room: `user:${member.id}`,
      event: "notification_prefs:updated",
      payload: {
        type: "server",
        serverId: server.id,
        scopeId: server.id,
        level: "none",
        prefs: {
          serverPushMuted: true,
          serverPushMentionsOnly: false,
          serverPushMode: "none",
        },
        prefsVersion: 2,
      },
    });
    const afterMutedEventCount = events.length;
    const repeatedMutedRes = await patchSettings(memberToken, { serverPushMuted: true });
    assert.equal(repeatedMutedRes.status, 200);
    assert.deepEqual(await repeatedMutedRes.json(), {
      serverPushMuted: true,
      serverPushMentionsOnly: false,
      serverPushMode: "none",
      prefsVersion: 2,
    });
    assert.equal(events.length, afterMutedEventCount, "same-value server notification PATCH must not emit");

    const ownerRes = await getSettings(ownerToken);
    assert.equal(ownerRes.status, 200);
    const ownerBody = await ownerRes.json() as { serverPushMuted: boolean; serverPushMentionsOnly: boolean; serverPushMode: string; prefsVersion: number };
    assert.equal(ownerBody.serverPushMuted, false);
    assert.equal(ownerBody.serverPushMentionsOnly, false);
    assert.equal(ownerBody.serverPushMode, "all");
    assert.equal(ownerBody.prefsVersion, 0);

    const unmutedRes = await patchSettings(memberToken, { serverPushMuted: false });
    assert.equal(unmutedRes.status, 200);
    const unmutedBody = await unmutedRes.json() as { serverPushMuted: boolean; serverPushMentionsOnly: boolean; serverPushMode: string; prefsVersion: number };
    assert.equal(unmutedBody.serverPushMuted, false);
    assert.equal(unmutedBody.serverPushMentionsOnly, false);
    assert.equal(unmutedBody.serverPushMode, "all");
    assert.equal(unmutedBody.prefsVersion, 3);
    assert.deepEqual(events.at(-1), {
      room: `user:${member.id}`,
      event: "notification_prefs:updated",
      payload: {
        type: "server",
        serverId: server.id,
        scopeId: server.id,
        level: "all",
        prefs: {
          serverPushMuted: false,
          serverPushMentionsOnly: false,
          serverPushMode: "all",
        },
        prefsVersion: 3,
      },
    });
    const afterUnmutedEventCount = events.length;
    const repeatedUnmutedRes = await patchSettings(memberToken, { serverPushMuted: false });
    assert.equal(repeatedUnmutedRes.status, 200);
    assert.deepEqual(await repeatedUnmutedRes.json(), {
      serverPushMuted: false,
      serverPushMentionsOnly: false,
      serverPushMode: "all",
      prefsVersion: 3,
    });
    assert.equal(events.length, afterUnmutedEventCount, "same-value server notification unmute PATCH must not emit");

    // The mode is the only storage (migration server_members_push_muted_drop):
    // a mode write reads back with the legacy fields derived from it.
    await getDb()
      .update(serverMembers)
      .set({ serverPushMode: "mentions" })
      .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, member.id)));
    const modeWritten = await getSettings(memberToken);
    assert.deepEqual(await modeWritten.json(), {
      serverPushMuted: false,
      serverPushMentionsOnly: true,
      serverPushMode: "mentions",
      prefsVersion: 3,
    });
});

test("POST /api/servers/:id/leave removes admin and member, rejects owner", async ({ app }) => {
    const { owner, admin, member, server } = await seedRoleFixture("leave-server");
    const [allChannel] = await getDb()
      .select({ id: channelsTable.id })
      .from(channelsTable)
      .where(and(eq(channelsTable.serverId, server.id), eq(channelsTable.name, "all")));
    assert.ok(allChannel, "expected #all channel");
    await createMessage(allChannel.id, "user", member.id, "member history before leaving");
    await createMessage(allChannel.id, "user", admin.id, "admin history before leaving");

    async function leave(token: string) {
      return fetch(`${app.baseUrl}/api/servers/${server.id}/leave`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
      });
    }

  const memberToken = await tokenForHuman(member.email);
    const memberRes = await leave(memberToken);
    assert.equal(memberRes.status, 200);

  const adminToken = await tokenForHuman(admin.email);
    const adminRes = await leave(adminToken);
    assert.equal(adminRes.status, 200);

  const ownerToken = await tokenForHuman(owner.email);
    const ownerRes = await leave(ownerToken);
    assert.equal(ownerRes.status, 405);

    async function profileStatus(userId: string) {
      const profileRes = await fetch(`${app.baseUrl}/api/servers/${server.id}/members/${userId}/profile`, {
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "X-Server-Id": server.id,
        },
      });
      assert.equal(profileRes.status, 200);
      const profile = await profileRes.json() as { membershipStatus: string };
      return profile.membershipStatus;
    }

    assert.equal(await profileStatus(member.id), "left");
    assert.equal(await profileStatus(admin.id), "left");
});

test("DELETE /api/servers/:id broadcasts deleted server removal to all active members", async ({ app }) => {
    const { owner, admin, member, server } = await seedRoleFixture("delete-server-socket");
    const events = installFakeIo(app.app);

  const ownerToken = await tokenForHuman(owner.email);
    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "X-Server-Id": server.id,
      },
    });
    assert.equal(res.status, 200);

    assert.deepEqual(
      events.filter((event) => event.event === "server:deleted"),
      [
        {
          room: `server:${server.id}`,
          event: "server:deleted",
          payload: {
            serverId: server.id,
          },
        },
      ],
    );

    const removalRooms = events
      .filter((event) => event.event === "server:membership-removed")
      .map((event) => event.room)
      .sort();
    assert.deepEqual(
      removalRooms,
      [`user:${owner.id}`, `user:${admin.id}`, `user:${member.id}`].sort(),
    );
    for (const event of events.filter((event) => event.event === "server:membership-removed")) {
      assert.deepEqual(event.payload, { serverId: server.id });
    }
});

test("DELETE /api/servers/:id rolls back a failed cleanup and lets the owner retry with residual machines", { timeout: 15_000 }, async ({ app }) => {
    const { owner, admin, server } = await seedRoleFixture("delete-server-retryable");
    const events = installFakeIo(app.app);
    const db = getDb();

    const [residualMachine] = await db.insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "residual-offline-machine",
      apiKeyHash: "task87-test-key-hash",
    }).returning({ id: machines.id });
    await db.insert(subscriptions).values({
      serverId: server.id,
      stripeCustomerId: "cus_task87_retryable",
      stripeSubscriptionId: "sub_task87_retryable",
      status: "active",
    });

    await db.execute(sql.raw(`
      CREATE FUNCTION task87_fail_subscription_delete() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'task87 injected subscription cleanup failure';
      END;
      $$ LANGUAGE plpgsql
    `));
    await db.execute(sql.raw(`
      CREATE TRIGGER task87_fail_subscription_delete
      BEFORE DELETE ON subscriptions
      FOR EACH ROW EXECUTE FUNCTION task87_fail_subscription_delete()
    `));

  const ownerToken = await tokenForHuman(owner.email);
    const deleteAsOwner = () => fetch(`${app.baseUrl}/api/servers/${server.id}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "X-Server-Id": server.id,
      },
    });

    const failed = await deleteAsOwner();
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { error: "Failed to delete server" });

    const [afterFailure] = await db
      .select({ deletedAt: serversTable.deletedAt })
      .from(serversTable)
      .where(eq(serversTable.id, server.id));
    assert.equal(afterFailure?.deletedAt, null, "cleanup failure must roll the tombstone back");
    assert.equal(
      (await db.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.serverId, server.id))).length,
      1,
      "cleanup failure must leave the local billing row retryable",
    );
    assert.deepEqual(events, [], "a failed deletion must not broadcast success");

    const activeServers = await fetch(`${app.baseUrl}/api/servers`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(activeServers.status, 200);
    assert.ok(
      (await activeServers.json() as Array<{ id: string }>).some((candidate) => candidate.id === server.id),
      "the failed server must remain visible to the owner",
    );

    await db.execute(sql.raw("DROP TRIGGER task87_fail_subscription_delete ON subscriptions"));
    await db.execute(sql.raw("DROP FUNCTION task87_fail_subscription_delete()"));

    const retried = await deleteAsOwner();
    assert.equal(retried.status, 200);
    assert.deepEqual(await retried.json(), { ok: true });

    const [afterRetry] = await db
      .select({ deletedAt: serversTable.deletedAt })
      .from(serversTable)
      .where(eq(serversTable.id, server.id));
    assert.ok(afterRetry?.deletedAt instanceof Date);
    assert.equal(
      (await db.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.serverId, server.id))).length,
      0,
    );
    assert.equal(
      (await db.select({ id: machines.id }).from(machines).where(eq(machines.serverId, server.id))).length,
      1,
      "a residual machine is not a server soft-delete blocker",
    );

    const successEventCount = events.length;
    assert.ok(successEventCount > 0, "the successful transition must broadcast removal");

  const adminToken = await tokenForHuman(admin.email);
    const nonOwnerCleanup = await fetch(`${app.baseUrl}/api/servers/${server.id}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "X-Server-Id": server.id,
      },
    });
    assert.equal(nonOwnerCleanup.status, 403, "only the original owner may clean deleted residue");

    const nestedDelete = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${residualMachine.id}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "X-Server-Id": server.id,
      },
    });
    assert.equal(nestedDelete.status, 403, "deleted-server re-entry is limited to the server cleanup endpoint");

    const idempotentOwnerCleanup = await deleteAsOwner();
    assert.equal(idempotentOwnerCleanup.status, 200);
    assert.deepEqual(await idempotentOwnerCleanup.json(), { ok: true });
    assert.equal(events.length, successEventCount, "an idempotent cleanup retry must not rebroadcast deletion");
});

test("DELETE /api/servers/:id lets the owner finish after a post-commit response-path failure", async ({ app }) => {
    const { owner, server } = await seedRoleFixture("delete-server-post-commit-retry");
    app.app.set("io", {
      to() {
        return {
          emit() {
            throw new Error("task87 injected post-commit socket failure");
          },
        };
      },
    });

  const ownerToken = await tokenForHuman(owner.email);
    const deleteAsOwner = () => fetch(`${app.baseUrl}/api/servers/${server.id}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "X-Server-Id": server.id,
      },
    });

    const interruptedResponse = await deleteAsOwner();
    assert.equal(interruptedResponse.status, 500);
    assert.deepEqual(await interruptedResponse.json(), { error: "Failed to delete server" });

    const [committed] = await getDb()
      .select({ deletedAt: serversTable.deletedAt })
      .from(serversTable)
      .where(eq(serversTable.id, server.id));
    assert.ok(committed?.deletedAt instanceof Date, "the response-path failure happens after deletion commits");

    const recovered = await deleteAsOwner();
    assert.equal(recovered.status, 200);
    assert.deepEqual(await recovered.json(), { ok: true });
});

test("POST /api/servers/:id/members is not routed; members join through invites and join links", async ({ app }) => {
    const { owner, server } = await seedRoleFixture("member-add-removed");
    const [target] = await getDb().insert(users).values({
      email: "target-member-add-removed@slock.test",
      name: "target-member-add-removed",
      displayName: "Target Member Add Removed",
    passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();

  const ownerToken = await tokenForHuman(owner.email);
    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/members`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "X-Server-Id": server.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId: target.id, role: "member" }),
    });
    assert.equal(res.status, 404);
    assert.equal(await getServerMemberRole(server.id, target.id), undefined);
});

test("PATCH /api/servers/:id/members/:memberId broadcasts server:member-updated to refresh member roles", async ({ app }) => {
    const { owner, member, server } = await seedRoleFixture("member-updated-socket");
    const events = installFakeIo(app.app);

  const ownerToken = await tokenForHuman(owner.email);
    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/members/${member.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "X-Server-Id": server.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ role: "admin" }),
    });
    assert.equal(res.status, 200);

    assert.deepEqual(events, [{
      room: `server:${server.id}`,
      event: "server:member-updated",
      payload: {
        serverId: server.id,
        userId: member.id,
        previousRole: "member",
        role: "admin",
      },
    }]);
});

test("DELETE /api/servers/:id/members/:memberId broadcasts server member removal to active server clients", async ({ app }) => {
    const { owner, member, server } = await seedRoleFixture("member-removed-socket");
    const events = installFakeIo(app.app);
    const [allChannel] = await getDb()
      .select({ id: channelsTable.id })
      .from(channelsTable)
      .where(and(eq(channelsTable.serverId, server.id), eq(channelsTable.name, "all")));
    assert.ok(allChannel, "expected #all channel");
    await createMessage(allChannel.id, "user", member.id, "member history before removal");

  const ownerToken = await tokenForHuman(owner.email);
    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/members/${member.id}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "X-Server-Id": server.id,
      },
    });
    assert.equal(res.status, 200);

    assert.deepEqual(events, [
      {
        room: `server:${server.id}`,
        event: "server:member-removed",
        payload: {
          serverId: server.id,
          userId: member.id,
        },
      },
      {
        room: `user:${member.id}`,
        event: "server:membership-removed",
        payload: {
          serverId: server.id,
        },
      },
    ]);

    const profileRes = await fetch(`${app.baseUrl}/api/servers/${server.id}/members/${member.id}/profile`, {
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "X-Server-Id": server.id,
      },
    });
    assert.equal(profileRes.status, 200);
    const profile = await profileRes.json() as { membershipStatus: string };
    assert.equal(profile.membershipStatus, "removed");
});

test("machine register and rename responses never carry the key hash or fingerprint", async ({ app }) => {
  const { owner, server } = await seedRoleFixture("machine-no-key-secrets");
  const ownerToken = await tokenForHuman(owner.email);
  const headers = { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id, "Content-Type": "application/json" };

  const createRes = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines`, {
    method: "POST", headers, body: JSON.stringify({ name: "secret-free-machine" }),
  });
  assert.equal(createRes.status, 200);
  const created = await createRes.json() as { machine: Record<string, unknown>; apiKey: string };
  assert.ok(created.apiKey.startsWith("sk_machine_"), "the one-time key itself is still returned once");
  assert.equal("apiKeyHash" in created.machine, false);
  assert.equal("apiKeyFingerprint" in created.machine, false);

  const renameRes = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${created.machine.id}`, {
    method: "PATCH", headers, body: JSON.stringify({ name: "renamed-secret-free-machine" }),
  });
  assert.equal(renameRes.status, 200);
  const renamed = await renameRes.json() as Record<string, unknown>;
  assert.equal(renamed.name, "renamed-secret-free-machine");
  assert.equal("apiKeyHash" in renamed, false);
  assert.equal("apiKeyFingerprint" in renamed, false);
});

test("server machine mutations broadcast machine:updated to active server clients", async ({ app }) => {
    const { owner, server } = await seedRoleFixture("machine-updated-socket");
    const events = installFakeIo(app.app);
  const ownerToken = await tokenForHuman(owner.email);

    const createRes = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "X-Server-Id": server.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "socket-machine" }),
    });
    assert.equal(createRes.status, 200);
    const createBody = await createRes.json() as { machine: { id: string } };
    const machineId = createBody.machine.id;

    const renameRes = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machineId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "X-Server-Id": server.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "renamed-socket-machine" }),
    });
    assert.equal(renameRes.status, 200);

    const deleteRes = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machineId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "X-Server-Id": server.id,
      },
    });
    assert.equal(deleteRes.status, 200);

    assert.deepEqual(events, [
      {
        room: `server:${server.id}`,
        event: "machine:updated",
        payload: { serverId: server.id, machineId },
      },
      {
        room: `server:${server.id}`,
        event: "machine:updated",
        payload: { serverId: server.id, machineId },
      },
      {
        room: `server:${server.id}`,
        event: "machine:updated",
        payload: { serverId: server.id, machineId },
      },
    ]);
});

test("PATCH /api/servers/:id/machines/:machineId updates machine description", async ({ app }) => {
    const { owner, server } = await seedRoleFixture("machine-description-update");
  const ownerToken = await tokenForHuman(owner.email);
    const { machine } = await registerMachine(server.id, owner.id, "described-machine");

    const updateRes = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "X-Server-Id": server.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ description: "  Runs the staging smoke tests  " }),
    });
    assert.equal(updateRes.status, 200);
    const updateBody = await updateRes.json() as { description: string | null; name: string };
    assert.equal(updateBody.name, "described-machine");
    assert.equal(updateBody.description, "Runs the staging smoke tests");

    const listRes = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines`, {
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "X-Server-Id": server.id,
      },
    });
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json() as { machines: Array<{ id: string; description: string | null }> };
    assert.equal(
      listBody.machines.find((candidate) => candidate.id === machine.id)?.description,
      "Runs the staging smoke tests",
    );

    const clearRes = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "X-Server-Id": server.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ description: "   " }),
    });
    assert.equal(clearRes.status, 200);
    const clearBody = await clearRes.json() as { description: string | null };
    assert.equal(clearBody.description, null);
});

test("DELETE /api/servers/:id/machines/:machineId disconnects live Computer-backed machine immediately", async ({ app }) => {
    const db = getDb();
    const { owner, server } = await seedRoleFixture("machine-delete-disconnects-computer");
    const { machine } = await registerMachine(server.id, owner.id, "computer-backed-machine");
    await db.insert(computers).values({
      serverId: server.id,
      name: "computer-backed-machine",
      apiKeyHash: await argon2.hash("sk_computer_test"),
      apiKeyPrefix: "sk_computer_test".slice(0, 16),
      attachedByUserId: owner.id,
      machineId: machine.id,
    });

    const disconnects: string[] = [];
    app.app.set("agentOrchestrator", {
      hasMachineLocally: (machineId: string) => machineId === machine.id,
      disconnectMachineForUnlink: async (machineId: string) => {
        disconnects.push(machineId);
        return true;
      },
    });

  const token = await tokenForHuman(owner.email);
    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(disconnects, [machine.id]);
});

test("DELETE /api/servers/:id/machines/:machineId does not expose unexpected service errors", async ({ app }) => {

  const originalConsoleError = console.error;
  try {
    const db = getDb();
    const { owner, server } = await seedRoleFixture("machine-delete-sanitizes-error");
    const { machine } = await registerMachine(server.id, owner.id, "computer-delete-error");
    await db.execute(sql`DROP TABLE ${computerOutageOccurrences}`);
    await db.execute(sql`DROP TABLE ${computerRevokeTokens}`);
    await db.execute(sql`DROP TABLE "computers"`);
    console.error = () => {};

    const token = await tokenForHuman(owner.email);
    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
    });
    assert.equal(res.status, 500);
    assert.match(res.headers.get("x-slock-error-id") ?? "", /.+/);
    const body = await res.json() as { error: string; code?: string; correlationId?: string };
    assert.equal(body.error, "Failed to delete machine");
    assert.equal(body.code, "machine_delete_failed");
    assert.equal(body.correlationId, res.headers.get("x-slock-error-id"));
    assert.doesNotMatch(JSON.stringify(body), /Failed query|computers|params:|DROP TABLE/i);
  } finally {
    console.error = originalConsoleError;
    await app.close();
  }
});

async function seedMachineDeleteFixture(slug: string) {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `${slug}@slock.test`,
    name: slug,
    displayName: slug,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer(`Machine Delete ${slug}`, `machine-delete-${slug}`, owner.id);
  const { machine } = await registerMachine(server.id, owner.id, `${slug}-machine`);
  const agent = await createAgent(server.id, `${slug}-agent`, { runtime: "codex", machineId: machine.id });
  await db.insert(agentRuntimeProfiles).values({
    agentId: agent.id,
    serverId: server.id,
    machineId: machine.id,
    runtimeProfileFingerprint: `${slug}-fingerprint`,
    runtime: "codex",
    model: "gpt-5.3-codex",
    executionMode: "byoc",
    baselineRuntimeProfileFingerprint: `${slug}-baseline-fingerprint`,
    baselineMachineId: machine.id,
    baselineRuntime: "codex",
    baselineModel: "gpt-5.3-codex",
    baselineExecutionMode: "byoc",
  });
  return { owner, server, machine, agent };
}

async function completeMachineMigrationForDeleteFixture(input: {
  agentId: string;
  targetMachineId: string;
  initiatedByUserId: string;
}) {
  const db = getDb();
  const { migration } = await beginTestAgentMigration(input);
  const now = new Date();
  await db.update(agents).set({ machineId: input.targetMachineId }).where(eq(agents.id, input.agentId));
  await db.update(agentMigrations).set({
    state: "starting",
    transferSummary: {
      includedFileCount: 2,
      includedBytes: 128,
      excludedRegenerableCount: 0,
      excludedRegenerableByCategory: {
        thirdPartyDependencies: 0,
        caches: 0,
        buildArtifacts: 0,
        otherRegenerable: 0,
      },
      keyWorkspaceEntries: {
        memoryMdPresent: true,
        notesPresent: true,
      },
    },
    sourceWorkspaceArchivedAt: now,
  }).where(eq(agentMigrations.id, migration.id));
  return completeAgentMigrationAutoStart({
    migrationId: migration.id,
    agentId: input.agentId,
    targetMachineId: input.targetMachineId,
    now,
  });
}

test("DELETE /api/servers/:id/machines/:machineId cleans deleted-agent runtime profiles before deleting machine", async ({ app }) => {
    const db = getDb();
    const { owner, server, machine, agent } = await seedMachineDeleteFixture("deleted-profile");
    await deleteAgent(agent.id);

  const token = await tokenForHuman(owner.email);
    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
    });
    assert.equal(res.status, 200);

    const machineRows = await db.select({ id: machines.id }).from(machines).where(eq(machines.id, machine.id));
    assert.deepEqual(machineRows, []);
    const profileRows = await db
      .select({ agentId: agentRuntimeProfiles.agentId })
      .from(agentRuntimeProfiles)
      .where(eq(agentRuntimeProfiles.agentId, agent.id));
    assert.deepEqual(profileRows, []);
});

test("DELETE /api/servers/:id/machines/:machineId returns 409 when an active runtime profile references machine", async ({ app }) => {
    const db = getDb();
    const { owner, server, machine, agent } = await seedMachineDeleteFixture("active-profile");
    await db.update(agents).set({ machineId: null }).where(eq(agents.id, agent.id));

  const token = await tokenForHuman(owner.email);
    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
    });
    assert.equal(res.status, 409);
    const body = await res.json() as { error: string };
    assert.match(body.error, /runtime profiles still reference active agents/);
});

test("DELETE /api/servers/:id/machines/:machineId removes a stale source profile after a completed migration", async ({ app }) => {
    const db = getDb();
    const { owner, server, machine: sourceMachine, agent } = await seedMachineDeleteFixture("completed-profile-move");
    const { machine: targetMachine } = await registerMachine(server.id, owner.id, "completed-profile-target");
    const migration = await completeMachineMigrationForDeleteFixture({
      agentId: agent.id,
      targetMachineId: targetMachine.id,
      initiatedByUserId: owner.id,
    });

  const token = await tokenForHuman(owner.email);
    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${sourceMachine.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
    });
    assert.equal(res.status, 200);

    assert.deepEqual(
      await db.select({ id: machines.id }).from(machines).where(eq(machines.id, sourceMachine.id)),
      [],
    );
    assert.deepEqual(
      await db.select({ agentId: agentRuntimeProfiles.agentId }).from(agentRuntimeProfiles).where(eq(agentRuntimeProfiles.agentId, agent.id)),
      [],
    );
    assert.deepEqual(
      await db.select({ state: agentMigrations.state }).from(agentMigrations).where(eq(agentMigrations.id, migration.id)),
      [{ state: "completed" }],
    );
});

test("DELETE /api/servers/:id/machines/:machineId preserves a pending release notice on a stale source profile", async ({ app }) => {
    const db = getDb();
    const { owner, server, machine: sourceMachine, agent } = await seedMachineDeleteFixture("pending-notice-source");
    const { machine: targetMachine } = await registerMachine(server.id, owner.id, "pending-notice-target");
    await completeMachineMigrationForDeleteFixture({
      agentId: agent.id,
      targetMachineId: targetMachine.id,
      initiatedByUserId: owner.id,
    });
    const noticeUrl = "https://example.com/daemon-release-notes";
    await db.update(agentRuntimeProfiles).set({
      migrationStatus: "pending",
      pendingKind: "daemon_release_notice",
      pendingKey: `release:${randomUUID()}`,
      pendingBeforeMachineId: sourceMachine.id,
      pendingAfterMachineId: targetMachine.id,
      pendingReleaseNotesUrl: noticeUrl,
    }).where(eq(agentRuntimeProfiles.agentId, agent.id));

  const token = await tokenForHuman(owner.email);
    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${sourceMachine.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
    });
    assert.equal(res.status, 409);

    const [profile] = await db.select().from(agentRuntimeProfiles).where(eq(agentRuntimeProfiles.agentId, agent.id));
    assert.equal(profile.machineId, sourceMachine.id);
    assert.equal(profile.pendingKind, "daemon_release_notice");
    assert.equal(profile.pendingReleaseNotesUrl, noticeUrl);
});

test("DELETE /api/servers/:id/machines/:machineId releases only the historical pending-before reference after a completed migration", async ({ app }) => {
    const db = getDb();
    const { owner, server, machine: sourceMachine, agent } = await seedMachineDeleteFixture("completed-pending-before");
    const { machine: targetMachine } = await registerMachine(server.id, owner.id, "completed-pending-before-target");
    await completeMachineMigrationForDeleteFixture({
      agentId: agent.id,
      targetMachineId: targetMachine.id,
      initiatedByUserId: owner.id,
    });
    await db.update(agentRuntimeProfiles).set({
      machineId: targetMachine.id,
      baselineMachineId: targetMachine.id,
      pendingBeforeMachineId: sourceMachine.id,
      pendingAfterMachineId: targetMachine.id,
      migrationStatus: "pending",
      pendingKind: "daemon_release_notice",
      pendingKey: `release:${randomUUID()}`,
    }).where(eq(agentRuntimeProfiles.agentId, agent.id));

  const token = await tokenForHuman(owner.email);
    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${sourceMachine.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
    });
    assert.equal(res.status, 200);

    const [profile] = await db.select().from(agentRuntimeProfiles).where(eq(agentRuntimeProfiles.agentId, agent.id));
    assert.equal(profile.machineId, targetMachine.id);
    assert.equal(profile.baselineMachineId, targetMachine.id);
    assert.equal(profile.pendingBeforeMachineId, null);
    assert.equal(profile.pendingAfterMachineId, targetMachine.id);
    assert.equal(profile.pendingKind, "daemon_release_notice");
});

test("DELETE /api/servers/:id/machines/:machineId keeps cross-machine runtime profiles fail-closed without completed migration proof", async ({ app }) => {
    const db = getDb();
    const { owner, server, machine: sourceMachine, agent } = await seedMachineDeleteFixture("unproved-profile-move");
    const { machine: targetMachine } = await registerMachine(server.id, owner.id, "unproved-profile-target");
    const { migration: abortedMigration } = await beginTestAgentMigration({
      agentId: agent.id,
      targetMachineId: targetMachine.id,
      initiatedByUserId: owner.id,
    });
    await db.update(agentMigrations).set({ state: "aborted" }).where(eq(agentMigrations.id, abortedMigration.id));
    await db.update(agents).set({ machineId: targetMachine.id }).where(eq(agents.id, agent.id));

  const token = await tokenForHuman(owner.email);
    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${sourceMachine.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
    });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), {
      error: "Cannot delete computer while runtime profiles still reference active agents. Remove or migrate related agents first.",
      code: "MACHINE_HAS_ACTIVE_RUNTIME_PROFILE",
    });
});

test("DELETE /api/servers/:id/machines/:machineId keeps stale profiles fail-closed when the completed target no longer matches assignment", async ({ app }) => {
    const db = getDb();
    const { owner, server, machine: sourceMachine, agent } = await seedMachineDeleteFixture("mismatched-target");
    const { machine: completedTarget } = await registerMachine(server.id, owner.id, "mismatched-target-receipt");
    const { machine: laterMachine } = await registerMachine(server.id, owner.id, "mismatched-target-current");
    await completeMachineMigrationForDeleteFixture({
      agentId: agent.id,
      targetMachineId: completedTarget.id,
      initiatedByUserId: owner.id,
    });
    await db.update(agents).set({ machineId: laterMachine.id }).where(eq(agents.id, agent.id));

  const token = await tokenForHuman(owner.email);
    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${sourceMachine.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
    });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), {
      error: "Cannot delete computer while runtime profiles still reference active agents. Remove or migrate related agents first.",
      code: "MACHINE_HAS_ACTIVE_RUNTIME_PROFILE",
    });
});

test("DELETE /api/servers/:id/machines/:machineId preserves terminal migration history", async ({ app }) => {
    const db = getDb();
    const { owner, server } = await seedRoleFixture("machine-delete-terminal-migration");
    const { machine: sourceMachine } = await registerMachine(server.id, owner.id, "terminal-migration-source");
    const { machine: targetMachine } = await registerMachine(server.id, owner.id, "terminal-migration-target");
    const agent = await createAgent(server.id, "terminal-migration-agent", {
      runtime: "codex",
      machineId: targetMachine.id,
    });
    const deadline = new Date(Date.now() + 60_000);
    const [migration] = await db.insert(agentMigrations).values({
      contractVersion: 2,
      serverId: server.id,
      agentId: agent.id,
      sourceMachineId: sourceMachine.id,
      targetMachineId: targetMachine.id,
      sourceMachineNameSnapshot: sourceMachine.name,
      targetMachineNameSnapshot: targetMachine.name,
      state: "aborted",
      supportRef: `mig_${randomUUID().replaceAll("-", "").slice(0, 22)}`,
      grantKey: `terminal-migration:${randomUUID()}`,
      prepDeadlineAt: deadline,
      transferDeadlineAt: deadline,
      arrivalDeadlineAt: deadline,
      abortedAt: new Date(),
    }).returning();

  const token = await tokenForHuman(owner.email);
    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${sourceMachine.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
    });
    assert.equal(res.status, 200);

    assert.deepEqual(
      await db.select({ id: machines.id }).from(machines).where(eq(machines.id, sourceMachine.id)),
      [],
    );
    assert.deepEqual(
      await db
        .select({ sourceMachineId: agentMigrations.sourceMachineId, targetMachineId: agentMigrations.targetMachineId })
        .from(agentMigrations)
        .where(eq(agentMigrations.id, migration.id)),
      [{ sourceMachineId: sourceMachine.id, targetMachineId: targetMachine.id }],
    );
});

test("DELETE /api/servers/:id/machines/:machineId returns a typed 409 for an active migration", async ({ app }) => {
    const db = getDb();
    const { owner, server } = await seedRoleFixture("machine-delete-active-migration");
    const { machine: sourceMachine } = await registerMachine(server.id, owner.id, "active-migration-source");
    const { machine: targetMachine } = await registerMachine(server.id, owner.id, "active-migration-target");
    const agent = await createAgent(server.id, "active-migration-agent", {
      runtime: "codex",
      machineId: targetMachine.id,
    });
    const deadline = new Date(Date.now() + 60_000);
    await db.insert(agentMigrations).values({
      contractVersion: 2,
      serverId: server.id,
      agentId: agent.id,
      sourceMachineId: sourceMachine.id,
      targetMachineId: targetMachine.id,
      sourceMachineNameSnapshot: sourceMachine.name,
      targetMachineNameSnapshot: targetMachine.name,
      state: "prep",
      grantKey: `active-migration:${randomUUID()}`,
      prepDeadlineAt: deadline,
      transferDeadlineAt: deadline,
      arrivalDeadlineAt: deadline,
    });

  const token = await tokenForHuman(owner.email);
    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${sourceMachine.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id },
    });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), {
      error: "Cannot delete computer while an agent migration is in progress. Wait for it to finish or abort it first.",
      code: "MACHINE_HAS_ACTIVE_MIGRATION",
    });
    assert.equal(
      (await db.select({ id: machines.id }).from(machines).where(eq(machines.id, sourceMachine.id))).length,
      1,
    );
});

for (const versions of [
  { label: "no cached versions", computer: null },
  { label: "cached versions available", computer: "1.0.25" },
]) {
  test(`GET /api/servers/:id/machines records restore-route phases and machine query shape (${versions.label})`, async ({ app }) => {
    // Version availability is the event's fact; request-scope version presence
    // is a different fact. Exercise both equal and differing values explicitly.
    const computerVersion = vi.spyOn(computerVersionService, "getLatestComputerVersion").mockResolvedValue(versions.computer);
    try {
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

      const { owner, server } = await seedRoleFixture("machines-trace");
      const db = getDb();
      const [onlineMachine, offlineMachine] = await db.insert(machines).values([
        {
          serverId: server.id,
          userId: owner.id,
          name: "online-machine",
          description: "Primary CI runner",
          apiKeyHash: "unused-hash-online",
          runtimes: ["codex"],
          daemonVersion: "0.42.0",
        },
        {
          serverId: server.id,
          userId: owner.id,
          name: "offline-machine",
          apiKeyHash: "unused-hash-offline",
          runtimes: ["claude"],
        },
      ]).returning();
      app.app.set("agentOrchestrator", {
        getMachineStatus: async (machineId: string) => machineId === onlineMachine.id ? "online" : "offline",
        getMachineStatusVersion: async (machineId: string) => machineId === onlineMachine.id ? 7 : 0,
        getMachineDaemonVersion: (machineId: string) => machineId === onlineMachine.id ? "0.43.0" : null,
      });

      const ownerToken = await tokenForHuman(owner.email);
      sink.clear();

      const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines`, {
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "X-Server-Id": server.id,
        },
      });
      assert.equal(res.status, 200);
      const body = await res.json() as {
        machines: Array<{ id: string; status: string; daemonVersion: string | null; description: string | null }>;
        latestDaemonVersion: string | null;
        latestComputerVersion: string | null;
      };
      assert.equal(body.machines.length, 2);
      assert.equal(body.machines.find((machine) => machine.id === onlineMachine.id)?.status, "online");
      assert.equal(body.machines.find((machine) => machine.id === onlineMachine.id)?.daemonVersion, "0.43.0");
      assert.equal(body.machines.find((machine) => machine.id === onlineMachine.id)?.description, "Primary CI runner");
      assert.equal(body.machines.find((machine) => machine.id === offlineMachine.id)?.status, "offline");
      // Retired standalone daemon release: the key survives for old clients, always null.
      assert.equal(body.latestDaemonVersion, null);
      assert.equal(body.latestComputerVersion, versions.computer);

      const span = sink.getAllSpans().find((candidate) =>
        candidate.name === "server.http.request"
        && candidate.attrs?.route_pattern === "/api/servers/:id/machines",
      );
      assert.ok(span, "expected GET /api/servers/:id/machines root span");

      const processEventNames = handlerTraceEvents(span.events)
        .map((event) => event.name)
        .filter((name) => name !== "db.query.finished");
      assert.deepEqual(processEventNames, [
        "machines.list.started",
        "server.machine_list_authority.checked",
        "machines.loaded",
        "machines.read_models.built",
        "latest_computer_version.loaded",
        "response.ready",
        "http.response.finished",
      ]);

      const dbEvents = handlerTraceEvents(span.events).filter((event) => event.name === "db.query.finished");
      assert.deepEqual(dbEvents.map((event) => event.attrs?.query_name), [
        "machines.list_by_server",
        "machines.agent_counts_by_server",
      ]);
      assert.equal(dbEvents[0]?.attrs?.phase, "machines.loaded");
      assert.equal(dbEvents[0]?.attrs?.row_count, 2);
      assert.equal(dbEvents[1]?.attrs?.phase, "machines.agent_counts.loaded");
      assert.equal(dbEvents[1]?.attrs?.row_count, 0);

      const readModelEvent = span.events.find((event) => event.name === "machines.read_models.built");
      assert.ok(readModelEvent);
      assert.equal(readModelEvent.attrs?.machines_count, 2);
      assert.equal(readModelEvent.attrs?.online_machines_count, 1);
      assert.equal(readModelEvent.attrs?.daemon_version_present_count, 1);

      assert.equal(span.attrs?.daemon_version_present, false, "human request carries no daemon version");
      const latestComputerVersionEvent = span.events.find((event) => event.name === "latest_computer_version.loaded");
      assert.ok(latestComputerVersionEvent);
      assert.equal(span.attrs?.computer_version_present, false, "human request carries no computer version");
      assert.equal(
        latestComputerVersionEvent.attrs?.computer_version_present ?? span.attrs?.computer_version_present,
        versions.computer !== null,
        "effective event presence must describe the loaded computer version",
      );
      const latestComputerVersionRow = traceEventRowsForSpan(span, TRACE_EVENT_ROW_TEST_RESOURCE)
        .find((row) => row.event_name === "latest_computer_version.loaded");
      assert.ok(latestComputerVersionRow);
      assert.equal(latestComputerVersionRow.route_pattern, "/api/servers/:id/machines");
      assert.equal(latestComputerVersionRow.caller_kind, "human");

      const readyEvent = span.events.find((event) => event.name === "response.ready");
      assert.ok(readyEvent);
      assert.equal(readyEvent.attrs?.machines_count, 2);
      assert.equal(readyEvent.attrs?.online_machines_count, 1);
      assert.equal(readyEvent.attrs?.daemon_version_present_count, 1);
      assert.equal(readyEvent.attrs?.latest_computer_version_present, Boolean(body.latestComputerVersion));
      assert.equal(Object.values(span.attrs ?? {}).includes(onlineMachine.id), false);
    } finally {
      computerVersion.mockRestore();
      await app.close();
    }
  });
}

test("Grok is in the new-agent catalog without a feature flag, and the machine capability is served raw", async ({ app }) => {
    const { owner, server } = await seedRoleFixture("grok-runtime-catalog-gate");
    const [machine] = await getDb().insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "grok-runtime-machine",
      apiKeyHash: "unused-grok-runtime-machine-hash",
      runtimes: ["codex", "grok"],
    }).returning();
  const ownerToken = await tokenForHuman(owner.email);
    let runtimeDetectCalls = 0;
    app.app.set("agentOrchestrator", {
      getMachineStatus: async () => "online",
      getMachineStatusVersion: async () => 1,
      getMachineDaemonVersion: () => null,
      hasMachineLocally: () => true,
      detectMachineRuntimeModels: async () => {
        runtimeDetectCalls += 1;
        return { models: [{ id: "grok-4.5", label: "Grok 4.5" }], default: "grok-4.5" };
      },
    });

    const listMachines = async () => {
      const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines`, {
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "X-Server-Id": server.id,
        },
      });
      assert.equal(res.status, 200);
      return await res.json() as { machines: Array<{ id: string; runtimes: string[] }> };
    };

    const list = await listMachines();
    assert.deepEqual(list.machines.find((item) => item.id === machine.id)?.runtimes, ["codex", "grok"]);

    const optionsRes = await fetch(
      `${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-options`,
      {
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "X-Server-Id": server.id,
        },
      },
    );
    assert.equal(optionsRes.status, 200);
    const options = await optionsRes.json() as {
      context: string;
      machineId: string;
      options: Array<{ runtimeId: string; canSelectInThisContext: boolean }>;
    };
    assert.equal(options.context, "new_agent");
    assert.equal(options.machineId, machine.id);
    for (const runtimeId of ["codex", "grok"]) {
      assert.equal(options.options.find((option) => option.runtimeId === runtimeId)?.canSelectInThisContext, true, runtimeId);
    }

    const modelsRes = await fetch(
      `${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-models/grok`,
      {
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "X-Server-Id": server.id,
        },
      },
    );
    assert.equal(modelsRes.status, 200);
    assert.deepEqual(await modelsRes.json(), {
      models: [{ id: "grok-4.5", label: "Grok 4.5" }],
      default: "grok-4.5",
      state: "ok",
    });
    assert.equal(runtimeDetectCalls, 1);
});

test("server runtime catalog: any member reads it, a non-member is refused", async ({ app }) => {
    const { member, server } = await seedRoleFixture("runtime-catalog");
    const { member: outsider } = await seedRoleFixture("runtime-catalog-other");
    const url = `${app.baseUrl}/api/servers/${server.id}/runtimes`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${await tokenForHuman(member.email)}`, "X-Server-Id": server.id },
    });
    assert.equal(res.status, 200);
    const catalog = await res.json() as ServerRuntimeCatalog;
    assert.equal(catalog.catalogVersion, SERVER_RUNTIME_CATALOG_VERSION);
    assert.deepEqual(catalog.runtimes.map((runtime) => runtime.id), RUNTIMES.map((runtime) => runtime.id));
    assert.deepEqual(catalog.runtimes.find((runtime) => runtime.id === "kimi-sdk")?.forms, [
      { kind: "v1", schemaVersion: KIMI_SDK_FORM_DEFINITION_REF.schemaVersion },
      { kind: "v2" },
    ]);

    const outsiderRes = await fetch(url, {
      headers: { Authorization: `Bearer ${await tokenForHuman(outsider.email)}`, "X-Server-Id": server.id },
    });
    // The server-scope middleware refuses a non-member before the route runs.
    assert.equal(outsiderRes.status, 403);
});

test("schema runtime options serve Built-in Pi and live model-scoped Kimi definitions", async ({ app }) => {
    const { owner, server } = await seedRoleFixture("builtin-pi-schema-form");
    const [machine] = await getDb().insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "builtin-pi-schema-machine",
      apiKeyHash: "unused-builtin-pi-schema-machine-hash",
      runtimes: ["builtin", "codex", "kimi-sdk"],
    }).returning();
  const ownerToken = await tokenForHuman(owner.email);
    const headers = {
      Authorization: `Bearer ${ownerToken}`,
      "X-Server-Id": server.id,
    };
    let catalogMode: "supported" | "legacy" | "offline" = "supported";
    app.app.set("agentOrchestrator", {
      hasMachineLocally: () => true,
      detectMachineRuntimeModelsWithAuthority: async () => {
        if (catalogMode === "offline") {
          throw new RouteFailureError(
            "daemon_offline",
            "Computer disconnected during model detection",
          );
        }
        return {
          outcome: {
            kind: "live" as const,
            value: {
              models: Object.values(PI_BUILTIN_PROVIDER_MODELS).flat(),
              ...(catalogMode === "supported"
                ? {
                    catalog: {
                      protocolVersion: 1 as const,
                      runtime: "builtin" as const,
                      runtimeVersion: "0.84.3",
                      customModelProviderIds: ["openrouter"],
                    },
                  }
                : {}),
            },
          },
          authority: {
            connectionEpochId: "epoch-a",
            replicaGeneration: "generation-a",
          },
          daemonVersion: catalogMode === "supported" ? "1.0.23" : "1.0.17",
          computerVersion: catalogMode === "supported" ? "1.0.23" : "1.0.17",
        };
      },
    });

    const optionsRes = await fetch(
      `${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-options`,
      { headers },
    );
    assert.equal(optionsRes.status, 200);
    const catalog = await optionsRes.json() as {
      options: Array<{ runtimeId: string; formDefinitionRef?: { protocolVersion: number; runtimeId: string; schemaVersion: string } }>;
    };
    const builtIn = catalog.options.find((option) => option.runtimeId === "builtin");
    assert.deepEqual(builtIn?.formDefinitionRef, {
      protocolVersion: 1,
      runtimeId: "builtin",
      schemaVersion: "builtin-pi.create.v3",
    });
    assert.equal(catalog.options.find((option) => option.runtimeId === "codex")?.formDefinitionRef, undefined);
    const kimi = catalog.options.find((option) => option.runtimeId === "kimi-sdk");
    assert.deepEqual(kimi?.formDefinitionRef, KIMI_SDK_FORM_DEFINITION_REF);

    const definitionRes = await fetch(
      `${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-form-definitions/builtin?schemaVersion=${builtIn?.formDefinitionRef?.schemaVersion}`,
      { headers },
    );
    assert.equal(definitionRes.status, 200);
    const definitionBody = await definitionRes.json() as unknown;
    // A released version is served verbatim from its frozen sample (packages/runtime-form).
    assert.deepEqual(definitionBody, releasedRuntimeFormDefinition("builtin-pi.create.v3"));
    const definition = definitionBody as unknown as {
      protocolVersion: number;
      runtimeId: string;
      schemaVersion: string;
      dataSchema: {
        properties: {
          apiKey: Record<string, unknown>;
          supportsImageInput: Record<string, unknown>;
        } & Record<string, Record<string, unknown>>;
        required: string[];
      };
      capabilities: { writeOnlyPointers: string[]; forbiddenPointers: string[] };
      optionSources: Record<string, { protocolVersion: number; runtimeId: string; schemaVersion: string; sourceId: string }>;
    };
    assert.equal(definition.protocolVersion, 1);
    assert.equal(definition.runtimeId, "builtin");
    assert.equal(definition.dataSchema.properties.apiKey.writeOnly, true);
    assert.equal("default" in definition.dataSchema.properties.apiKey, false);
    assert.equal(definition.dataSchema.properties.supportsImageInput?.type, "boolean");
    assert.deepEqual(definition.capabilities.writeOnlyPointers, ["/apiKey"]);
    assert.deepEqual(definition.capabilities.forbiddenPointers, ["/hostUserState"]);
    for (const source of Object.values(definition.optionSources)) {
      assert.deepEqual(
        { protocolVersion: source.protocolVersion, runtimeId: source.runtimeId, schemaVersion: source.schemaVersion },
        { protocolVersion: 1, runtimeId: "builtin", schemaVersion: definition.schemaVersion },
      );
      assert.equal("options" in source, false);
      assert.equal("optionsByValue" in source, false);
    }

    const providerSourceRes = await fetch(
      `${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-form-definitions/builtin/option-sources/provider?schemaVersion=${definition.schemaVersion}`,
      { headers },
    );
    const providerSourceBody = await providerSourceRes.json() as {
      sourceId: string;
      schemaVersion: string;
      kind: string;
      options: Array<{ value: string; providerKind: string }>;
      error?: string;
      code?: string;
    };
    assert.equal(
      providerSourceRes.status,
      200,
      JSON.stringify(providerSourceBody),
    );
    const providerSource = providerSourceBody;
    assert.equal(providerSource.sourceId, "provider");

    // Protocol v2: current form, no schemaVersion pin, rendered by field kind.
    const v2Res = await fetch(
      `${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-forms/v2/builtin`,
      { headers },
    );
    assert.equal(v2Res.status, 200);
    const v2 = parseRuntimeFormV2(await v2Res.json());
    assert.ok(v2, "the v2 endpoint serves a v2 form");
    assert.equal(v2.fields.find((field) => field.key === "providerId")?.kind, "select");
    assert.equal(v2.fields.find((field) => field.key === "model")?.kind, "dependent_select");
    const v2ProviderRes = await fetch(
      `${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-forms/v2/builtin/option-sources/provider`,
      { headers },
    );
    const v2ProviderBody = await v2ProviderRes.json() as unknown;
    assert.equal(v2ProviderRes.status, 200, `v2 option sources need no schemaVersion: ${JSON.stringify(v2ProviderBody)}`);
    assert.deepEqual(v2ProviderBody, providerSourceBody);
    assert.equal(v2ProviderRes.headers.get("content-language"), "en");

    // v2 copy follows Accept-Language; values and structure do not change.
    const zhHeaders = { ...headers, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" };
    const zhRes = await fetch(
      `${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-forms/v2/builtin`,
      { headers: zhHeaders },
    );
    assert.equal(zhRes.status, 200);
    assert.equal(zhRes.headers.get("content-language"), "zh-CN");
    assert.match(zhRes.headers.get("vary") ?? "", /Accept-Language/i);
    const zh = parseRuntimeFormV2(await zhRes.json());
    assert.ok(zh, "a localized form is still a valid v2 form");
    assert.equal(zh.fields.find((field) => field.key === "providerId")?.label, "提供方");
    assert.deepEqual(zh.fields.map((field) => [field.key, field.kind]), v2.fields.map((field) => [field.key, field.kind]));
    assert.equal(v2.fields.find((field) => field.key === "providerId")?.label, "Provider");
    const zhProviderRes = await fetch(
      `${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-forms/v2/builtin/option-sources/provider`,
      { headers: zhHeaders },
    );
    assert.equal(zhProviderRes.status, 200);
    assert.equal(zhProviderRes.headers.get("content-language"), "zh-CN");
    const zhProvider = await zhProviderRes.json() as { options: Array<{ value: string }> };
    assert.deepEqual(
      zhProvider.options.map((option) => option.value),
      providerSource.options.map((option) => option.value),
    );
    assert.equal(providerSource.schemaVersion, definition.schemaVersion);
    assert.equal(providerSource.kind, "select");
    assert.ok(providerSource.options.some((option) => option.value === "deepseek" && option.providerKind === "preset"));

    const modelSourceRes = await fetch(
      `${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-form-definitions/builtin/option-sources/model?schemaVersion=${definition.schemaVersion}`,
      { headers },
    );
    assert.equal(modelSourceRes.status, 200);
    const modelSource = await modelSourceRes.json() as {
      sourceId: string;
      schemaVersion: string;
      kind: string;
      optionsByValue: Record<string, unknown[]>;
    };
    assert.equal(modelSource.sourceId, "model");
    assert.equal(modelSource.schemaVersion, definition.schemaVersion);
    assert.equal(modelSource.kind, "dependent_select");
    assert.ok((modelSource.optionsByValue.deepseek ?? []).length > 0);
    // task #10: a typed OpenRouter id is v2-only. A v1 client builds its own
    // config and only ever builds a custom model for a gateway.
    const v1Custom = (modelSource as unknown as { customValueAllowedByValue: Record<string, boolean> }).customValueAllowedByValue;
    assert.equal(v1Custom.openrouter, false, "v1 keeps OpenRouter list-only");
    assert.equal(v1Custom["openai-compatible"], true, "v1 gateways still take a typed id");
    // task #10: typing on OpenRouter and its limit fields need BOTH a client
    // that advertises dependent_select.custom_value_with_options AND a
    // Computer that runs a typed id. Anything else is served as before.
    const CAP = "?clientCapabilities=dependent_select.custom_value_with_options";
    const v2Model = async (query: string) => {
      const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-forms/v2/builtin/option-sources/model${query}`, { headers });
      assert.equal(res.status, 200);
      return (await res.json() as { customValueAllowedByValue: Record<string, boolean> }).customValueAllowedByValue;
    };
    const limitVisibility = async (query: string) => {
      const started = Date.now();
      const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-forms/v2/builtin${query}`, { headers });
      assert.equal(res.status, 200, await res.clone().text());
      const definition = await res.json() as { uiSchema: { visibility: Array<{ pointer: string; when: { in: string[] } }> } };
      return { in: definition.uiSchema.visibility.find((rule) => rule.pointer === "/contextWindow")?.when.in ?? [], ms: Date.now() - started };
    };
    const GATEWAYS = ["openai-compatible", "anthropic-compatible"];
    assert.equal((await v2Model(CAP)).openrouter, true, "a capable client on a capable Computer may type an OpenRouter id");
    assert.deepEqual((await limitVisibility(CAP)).in, [...GATEWAYS, "openrouter"]);
    // A shipped app that does not advertise the capability: list-only, no OpenRouter limit fields.
    assert.equal((await v2Model("")).openrouter, false, "an old client keeps OpenRouter list-only");
    assert.equal((await v2Model("")).deepseek, false);
    assert.equal((await v2Model(""))["openai-compatible"], true, "gateways are unchanged for everyone");
    assert.deepEqual((await limitVisibility("")).in, GATEWAYS);

    // An offline Computer: hidden, answered from the bundled path without waiting on a probe.
    catalogMode = "offline";
    const offline = await limitVisibility(CAP);
    assert.deepEqual(offline.in, GATEWAYS, "an offline Computer hides them for OpenRouter");
    assert.ok(offline.ms < 5_000, `answered in ${offline.ms}ms`);

    catalogMode = "legacy";
    assert.deepEqual((await limitVisibility(CAP)).in, GATEWAYS, "an older Computer hides them for OpenRouter");
    const legacySourceRes = await fetch(
      `${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-form-definitions/builtin/option-sources/model?schemaVersion=${definition.schemaVersion}`,
      { headers },
    );
    assert.equal(legacySourceRes.status, 409);
    assert.deepEqual(
      await legacySourceRes.json(),
      {
        error:
          "This Computer is too old to prove which Built-in models it supports. Upgrade the Computer before selecting or starting this model.",
        code: "builtin_catalog_capability_required",
        daemonVersion: "1.0.17",
        computerVersion: "1.0.17",
        recovery: "upgrade_required",
      },
      "legacy live lists stay typed unavailable instead of becoming empty form catalogs",
    );

    catalogMode = "offline";
    const offlineSourceRes = await fetch(
      `${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-form-definitions/builtin/option-sources/model?schemaVersion=${definition.schemaVersion}`,
      { headers },
    );
    // Offline: the bundled catalog keeps the form usable (never an empty one);
    // starting the agent still checks the Computer's own catalog.
    assert.equal(offlineSourceRes.status, 200);
    const offlineSource = await offlineSourceRes.json() as {
      kind: string;
      optionsByValue: Record<string, unknown[]>;
    };
    assert.equal(offlineSource.kind, "dependent_select");
    assert.ok((offlineSource.optionsByValue.deepseek ?? []).length > 0, "offline serves the bundled catalog, not an empty one");

    const staleSourceRes = await fetch(
      `${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-form-definitions/builtin/option-sources/provider?schemaVersion=stale`,
      { headers },
    );
    assert.equal(staleSourceRes.status, 409);

    const staleRes = await fetch(
      `${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-form-definitions/builtin?schemaVersion=stale`,
      { headers },
    );
    assert.equal(staleRes.status, 409);
    assert.deepEqual((await staleRes.json() as { issues: unknown }).issues, [
      { code: "stale_form_schema", pointer: "/schemaVersion" },
    ]);

    const kimiDefinitionRes = await fetch(
      `${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-form-definitions/kimi-sdk?schemaVersion=${kimi?.formDefinitionRef?.schemaVersion}`,
      { headers },
    );
    assert.equal(kimiDefinitionRes.status, 200);
    const kimiDefinition = await kimiDefinitionRes.json() as {
      runtimeId: string;
      dataSchema: { required: string[] };
      optionSources: Record<string, unknown>;
    };
    assert.equal(kimiDefinition.runtimeId, "kimi-sdk");
    assert.deepEqual(kimiDefinition.dataSchema.required, ["model"]);
    assert.deepEqual(Object.keys(kimiDefinition.optionSources), ["model"]);

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
    const kimiSourceRes = await fetch(
      `${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-form-definitions/kimi-sdk/option-sources/model?schemaVersion=${kimi?.formDefinitionRef?.schemaVersion}`,
      { headers },
    );
    assert.equal(kimiSourceRes.status, 200);
    const kimiSource = await kimiSourceRes.json() as {
      options: Array<{ value: string; supportedReasoningEfforts?: string[] }>;
    };
    assert.deepEqual(kimiSource.options, [
      { value: "kimi-code/k3", label: "K3", supportedReasoningEfforts: ["balanced-plus"], defaultReasoningEffort: "balanced-plus" },
      { value: "kimi-code/k2", label: "K2" },
    ]);
});

test("schema kimi option source falls back to the managed default on missing_config, other failures stay typed", async ({ app }) => {
    const { owner, server } = await seedRoleFixture("kimi-missing-config-fallback");
    const [machine] = await getDb().insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "kimi-missing-config-machine",
      apiKeyHash: "unused-kimi-missing-config-machine-hash",
      runtimes: ["kimi-sdk"],
    }).returning();
  const ownerToken = await tokenForHuman(owner.email);
    const headers = {
      Authorization: `Bearer ${ownerToken}`,
      "X-Server-Id": server.id,
    };
    let outcome: unknown = { kind: "missing_config", recovery: "kimi_login" };
    app.app.set("agentOrchestrator", {
      hasMachineLocally: () => true,
      detectMachineRuntimeModels: async () => outcome,
    });
    const sourceUrl = `${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-form-definitions/kimi-sdk/option-sources/model?schemaVersion=${KIMI_SDK_FORM_DEFINITION_REF.schemaVersion}`;

    // First-install shape (no ~/.kimi-code/config.toml yet): the managed
    // default must be offered, not a hard failure.
    const fallbackRes = await fetch(sourceUrl, { headers });
    assert.equal(fallbackRes.status, 200);
    const fallbackSource = await fallbackRes.json() as {
      options: Array<{ value: string; label: string }>;
      defaultValue: string;
    };
    assert.deepEqual(fallbackSource.options, [
      { value: "kimi-code/kimi-for-coding", label: "Kimi for Coding (default)" },
    ]);
    assert.equal(fallbackSource.defaultValue, "kimi-code/kimi-for-coding");

    // Offline Computer: the same managed default, not a hard failure.
    outcome = { kind: "error", retryable: true, code: "computer_offline" };
    const offlineRes = await fetch(sourceUrl, { headers });
    assert.equal(offlineRes.status, 200);
    assert.equal((await offlineRes.json() as { defaultValue: string }).defaultValue, "kimi-code/kimi-for-coding");

    // Genuine detection failures still fail closed.
    outcome = { kind: "error", retryable: true };
    const errorRes = await fetch(sourceUrl, { headers });
    assert.equal(errorRes.status, 409);
    assert.deepEqual((await errorRes.json() as { issues: unknown }).issues, [
      { code: "runtime_model_source_error", pointer: "/optionSources/model" },
    ]);

    // Adjacent non-live outcomes must NOT be disguised as a launchable
    // default: an empty grant (config exists, no models) and an unsupported
    // runtime keep their typed 409s.
    outcome = { kind: "no_models" };
    const emptyGrantRes = await fetch(sourceUrl, { headers });
    assert.equal(emptyGrantRes.status, 409);
    assert.deepEqual((await emptyGrantRes.json() as { issues: unknown }).issues, [
      { code: "runtime_model_source_no_models", pointer: "/optionSources/model" },
    ]);

    outcome = { kind: "unsupported" };
    const unsupportedRes = await fetch(sourceUrl, { headers });
    assert.equal(unsupportedRes.status, 409);
    assert.deepEqual((await unsupportedRes.json() as { issues: unknown }).issues, [
      { code: "runtime_model_source_unsupported", pointer: "/optionSources/model" },
    ]);
});

test("v2 Kimi and Built-in Pi model sources report status instead of a 409; v1 bodies are unchanged", async ({ app }) => {
    const { owner, server } = await seedRoleFixture("kimi-builtin-v2-source-status");
    const [machine] = await getDb().insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "kimi-builtin-v2-status-machine",
      apiKeyHash: "unused-kimi-builtin-v2-status-machine-hash",
      runtimes: ["builtin", "kimi-sdk"],
    }).returning();
    const headers = { Authorization: `Bearer ${await tokenForHuman(owner.email)}`, "X-Server-Id": server.id };
    let kimiOutcome: unknown = { kind: "missing_config", recovery: "kimi_login" };
    let builtinMode: "supported" | "legacy" | "offline" | "timeout" = "supported";
    app.app.set("agentOrchestrator", {
      hasMachineLocally: () => true,
      detectMachineRuntimeModels: async () => kimiOutcome,
      detectMachineRuntimeModelsWithAuthority: async () => {
        if (builtinMode === "offline") throw new RouteFailureError("daemon_offline", "Computer disconnected during model detection");
        return {
          outcome: builtinMode === "timeout"
            ? { kind: "error" as const, retryable: true, code: "detect_timeout" }
            : {
              kind: "live" as const,
              value: {
                models: Object.values(PI_BUILTIN_PROVIDER_MODELS).flat(),
                ...(builtinMode === "supported" ? { catalog: { protocolVersion: 1 as const, runtime: "builtin" as const, runtimeVersion: "0.84.3" } } : {}),
              },
            },
          authority: { connectionEpochId: "epoch-a", replicaGeneration: "generation-a" },
          daemonVersion: builtinMode === "supported" ? "1.0.23" : "1.0.17",
          computerVersion: builtinMode === "supported" ? "1.0.23" : "1.0.17",
        };
      },
    });
    const v2 = (runtime: string, sourceId = "model") =>
      fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-forms/v2/${runtime}/option-sources/${sourceId}`, { headers });
    type Source = { status?: string; reason?: string; retryable?: boolean; options?: unknown[]; optionsByValue?: Record<string, unknown[]>; defaultValue?: string };

    // Per-source status is always on: neither form lists the capability, and a
    // client handles one source's status instead of failing the whole form.
    for (const runtime of ["kimi-sdk", "builtin"]) {
      const formRes = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-forms/v2/${runtime}`, { headers });
      assert.equal(formRes.status, 200, runtime);
      const form = await formRes.json() as { requiredClientCapabilities?: string[] };
      assert.equal(form.requiredClientCapabilities?.includes("option_source.status") ?? false, false, `${runtime} does not list option_source.status`);
    }

    // Kimi: the cases that offered the managed default still do, marked fallback.
    const missing = await (await v2("kimi-sdk")).json() as Source;
    assert.deepEqual([missing.status, missing.reason, missing.retryable], ["fallback", "missing_config", false]);
    assert.equal(missing.defaultValue, "kimi-code/kimi-for-coding");
    kimiOutcome = { kind: "error", retryable: true, code: "computer_offline" };
    const offline = await (await v2("kimi-sdk")).json() as Source;
    assert.deepEqual([offline.status, offline.reason, offline.retryable], ["fallback", "machine_offline", true]);
    // The cases that failed closed still offer nothing to launch with, per source.
    for (const [outcome, reason, retryable] of [
      [{ kind: "error", retryable: true }, "probe_failed", true],
      [{ kind: "error", retryable: true, code: "detect_timeout" }, "probe_timeout", true],
      [{ kind: "no_models" }, "no_models", true],
      [{ kind: "unsupported" }, "unsupported", false],
    ] as const) {
      kimiOutcome = outcome;
      const res = await v2("kimi-sdk");
      assert.equal(res.status, 200, reason);
      const body = await res.json() as Source;
      assert.deepEqual([body.status, body.reason, body.retryable, body.options], ["unavailable", reason, retryable, []], reason);
    }
    kimiOutcome = { kind: "live", value: { models: [{ id: "kimi-code/k3", label: "K3" }], default: "kimi-code/k3" } };
    const kimiLive = await (await v2("kimi-sdk")).json() as Source;
    assert.equal(kimiLive.status, "live");
    assert.equal("reason" in kimiLive, false);

    // Built-in: live catalog, offline bundle, a probe without the catalog.
    const live = await (await v2("builtin")).json() as Source;
    assert.equal(live.status, "live");
    const provider = await (await v2("builtin", "provider")).json() as Source;
    assert.equal("status" in provider, false, "the static provider select carries no status");
    builtinMode = "offline";
    const bundled = await (await v2("builtin")).json() as Source;
    assert.deepEqual([bundled.status, bundled.reason], ["fallback", "machine_offline"]);
    assert.ok((bundled.optionsByValue?.deepseek ?? []).length > 0, "offline still serves the bundled catalog");
    builtinMode = "timeout";
    const timedOut = await v2("builtin");
    assert.equal(timedOut.status, 200);
    const timedOutBody = await timedOut.json() as Source;
    assert.deepEqual([timedOutBody.status, timedOutBody.reason, timedOutBody.retryable, timedOutBody.optionsByValue], ["unavailable", "probe_timeout", true, {}]);
    // Too old to prove its catalog: still the typed 409, an upgrade fixes it.
    builtinMode = "legacy";
    const legacy = await v2("builtin");
    assert.equal(legacy.status, 409);
    assert.equal((await legacy.json() as { code: string }).code, "builtin_catalog_capability_required");

    // v1 keeps its bodies: no status fields, and the old 409s.
    kimiOutcome = { kind: "missing_config", recovery: "kimi_login" };
    const v1Kimi = await (await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-form-definitions/kimi-sdk/option-sources/model?schemaVersion=${KIMI_SDK_FORM_DEFINITION_REF.schemaVersion}`, { headers })).json() as Source;
    assert.equal("status" in v1Kimi, false);
    kimiOutcome = { kind: "no_models" };
    const v1Failed = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-form-definitions/kimi-sdk/option-sources/model?schemaVersion=${KIMI_SDK_FORM_DEFINITION_REF.schemaVersion}`, { headers });
    assert.equal(v1Failed.status, 409);
    await v1Failed.text();
    builtinMode = "timeout";
    const v1Builtin = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-form-definitions/builtin/option-sources/model?schemaVersion=builtin-pi.create.v3`, { headers });
    assert.equal(v1Builtin.status, 409);
    assert.equal((await v1Builtin.json() as { code: string }).code, "builtin_catalog_unavailable");
});

test("a runtime with only a v2 form is served on v2 and stays invisible to v1 clients", async ({ app }) => {
    const { owner, server } = await seedRoleFixture("v2-only-runtime-form");
    const [machine] = await getDb().insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "v2-only-runtime-machine",
      apiKeyHash: "unused-v2-only-runtime-machine-hash",
      runtimes: ["pi"],
    }).returning();
    const headers = { Authorization: `Bearer ${await tokenForHuman(owner.email)}`, "X-Server-Id": server.id };
    app.app.set("agentOrchestrator", { hasMachineLocally: () => true });
    const base = `${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}`;
    const piRow = async (optIn = true) => {
      const res = await fetch(`${base}/runtime-options`, {
        headers: optIn ? { ...headers, "X-Raft-Runtime-Form-V2": "1" } : headers,
      });
      assert.equal(res.status, 200);
      const body = await res.json() as { options: Array<Record<string, unknown> & { runtimeId: string }> };
      return body.options.find((option) => option.runtimeId === "pi");
    };
    // Pi (batch 4) has a v2 form and no v1 form.
    // v2 clients: the marker, the form and its option source.
    const row = await piRow();
    assert.deepEqual(row?.runtimeFormV2, { protocolVersion: 2 });
    // Clients that do not opt in (released mobile apps decode strictly) never see it.
    const strictRow = await piRow(false);
    assert.ok(strictRow);
    assert.equal("runtimeFormV2" in strictRow, false);
    const formRes = await fetch(`${base}/runtime-forms/v2/pi`, { headers });
    assert.equal(formRes.status, 200);
    assert.deepEqual(await formRes.json(), JSON.parse(JSON.stringify(buildRuntimeFormV2("pi"))));
    const sourceRes = await fetch(`${base}/runtime-forms/v2/pi/option-sources/provider`, { headers });
    assert.equal(sourceRes.status, 200);
    assert.equal((await sourceRes.json() as { defaultValue: string }).defaultValue, "configured");

    // v1 clients: no ref on the row, and both v1 routes answer as for any runtime without a form.
    assert.equal(row && "formDefinitionRef" in row, false);
    for (const url of [
      `${base}/runtime-form-definitions/pi?schemaVersion=pi.create.v1`,
      `${base}/runtime-form-definitions/pi/option-sources/provider?schemaVersion=pi.create.v1`,
    ]) {
      const res = await fetch(url, { headers });
      assert.equal(res.status, 404, url);
      assert.deepEqual((await res.json() as { issues: unknown }).issues, [{ code: "unknown_form_runtime", pointer: "/runtimeId" }]);
    }

    // Without a registry entry (every catalog runtime has one now, so the test
    // takes Pi's out): no marker, and the v2 route 404s as mobile's fallback expects.
    const restore = removeRuntimeFormV2EntryForTests("pi");
    try {
      const without = await piRow();
      assert.ok(without, "the runtime is still offered");
      assert.equal("runtimeFormV2" in without, false);
      const goneRes = await fetch(`${base}/runtime-forms/v2/pi`, { headers });
      assert.equal(goneRes.status, 404);
      assert.deepEqual((await goneRes.json() as { issues: unknown }).issues, [{ code: "unknown_form_runtime", pointer: "/runtimeId" }]);
    } finally {
      restore();
    }
    assert.deepEqual((await piRow())?.runtimeFormV2, { protocolVersion: 2 });
});

test("batch 2 v2 forms: OpenCode option source is the live probe or the static fallback (200), Gemini is static, v1 routes stay 404", async ({ app }) => {
    const { owner, server } = await seedRoleFixture("v2-batch2-runtime-forms");
    const [machine] = await getDb().insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "v2-batch2-machine",
      apiKeyHash: "unused-v2-batch2-machine-hash",
      runtimes: ["opencode", "kimi", "gemini", "antigravity"],
    }).returning();
    const headers = { Authorization: `Bearer ${await tokenForHuman(owner.email)}`, "X-Server-Id": server.id };
    // A probe cache of this test's own (not the process-wide one).
    const probes = new ComputerProbeCacheService(createLocalComputerProbeCacheBackend(Date.now, new Map()));
    app.app.set("computerProbeCache", probes);
    const probed: string[] = [];
    let probe: () => Promise<unknown> = async () => ({ kind: "live", value: { models: [{ id: "a/one", label: "One" }, { id: "b/two", label: "Two" }], default: "b/two" } });
    app.app.set("agentOrchestrator", {
      hasMachineLocally: () => true,
      detectMachineRuntimeModels: async (_machineId: string, runtime: string, options?: { force?: boolean }) => {
        probed.push(runtime);
        forced.push(options?.force === true);
        return probe();
      },
    });
    const forced: boolean[] = [];
    const base = `${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}`;
    const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../runtime-form/fixtures/${name}`, import.meta.url), "utf8")) as unknown;

    // The OpenCode row carries the v2 marker and no v1 ref; the deprecated runtimes are not offered for new agents.
    const rowsRes = await fetch(`${base}/runtime-options`, { headers: { ...headers, "X-Raft-Runtime-Form-V2": "1" } });
    assert.equal(rowsRes.status, 200);
    const rows = (await rowsRes.json() as { options: Array<Record<string, unknown> & { runtimeId: string }> }).options;
    const opencodeRow = rows.find((row) => row.runtimeId === "opencode");
    assert.deepEqual(opencodeRow?.runtimeFormV2, { protocolVersion: 2 });
    assert.equal(opencodeRow && "formDefinitionRef" in opencodeRow, false);
    assert.deepEqual(rows.filter((row) => ["kimi", "gemini", "antigravity"].includes(row.runtimeId)), []);

    const formRes = await fetch(`${base}/runtime-forms/v2/opencode`, { headers });
    assert.equal(formRes.status, 200);
    assert.deepEqual(await formRes.json(), fixture("opencode.form.json"));

    const sourceUrl = `${base}/runtime-forms/v2/opencode/option-sources/model`;
    const liveRes = await fetch(sourceUrl, { headers });
    assert.equal(liveRes.status, 200);
    const live = await liveRes.json() as { options: unknown; defaultValue: string };
    assert.deepEqual(live.options, [{ value: "a/one", label: "One" }, { value: "b/two", label: "Two" }]);
    assert.equal(live.defaultValue, "b/two");
    assert.deepEqual(probed, ["opencode"]);
    // The refresh action on a live source re-asks the Computer, bypassing its model cache.
    const refreshed = await fetch(`${sourceUrl}?refresh=1`, { headers });
    assert.equal(refreshed.status, 200);
    assert.deepEqual(forced, [false, true]);
    probed.length = 0;

    // Not live: the bundled list as a normal select, byte-equal to the shared fixture; never a 409 or 500.
    for (const nonLive of [
      async () => ({ kind: "missing_config" }),
      async () => ({ kind: "no_models" }),
      async () => ({ kind: "unsupported" }),
      async () => ({ kind: "error", retryable: true, code: "detect_timeout" }),
      async () => { throw new Error("probe crashed"); },
    ]) {
      probe = nonLive;
      const res = await fetch(sourceUrl, { headers });
      assert.equal(res.status, 200);
      assert.equal(`${JSON.stringify(await res.json(), null, 2)}\n`, readFileSync(new URL("../../../runtime-form/fixtures/opencode.option-source.fallback.json", import.meta.url), "utf8"));
    }
    // The server's wait timing out answers with the Computer's last live list
    // (computerProbeCacheService); this form has no status to mark it with.
    await probes.probeModels(machine.id, "opencode", async () => ({
      kind: "live",
      value: { models: [{ id: "c/last", label: "Last" }], default: "c/last" },
    }));
    probe = async () => { throw new RouteFailureError("daemon_timeout", "timed out"); };
    const timedOut = await (await fetch(sourceUrl, { headers })).json() as { options: unknown; status?: unknown };
    assert.deepEqual(timedOut.options, [{ value: "c/last", label: "Last" }]);
    assert.equal("status" in timedOut, false);
    probe = async () => ({ kind: "missing_config" });
    const kimiRes = await fetch(`${base}/runtime-forms/v2/kimi/option-sources/model`, { headers });
    assert.equal(kimiRes.status, 200);
    assert.deepEqual(await kimiRes.json(), fixture("kimi.option-source.fallback.json"));

    // Gemini: the static list, without asking the Computer.
    probed.length = 0;
    const geminiRes = await fetch(`${base}/runtime-forms/v2/gemini/option-sources/model`, { headers });
    assert.equal(geminiRes.status, 200);
    assert.deepEqual(await geminiRes.json(), fixture("gemini.option-source.json"));
    assert.deepEqual(probed, []);
    // Antigravity: the Computer's agy list; not live here, so agy's configured default alone.
    const antigravityRes = await fetch(`${base}/runtime-forms/v2/antigravity/option-sources/model`, { headers });
    assert.equal(antigravityRes.status, 200);
    const antigravity = await antigravityRes.json() as { options: unknown; defaultValue: unknown; status: unknown };
    assert.deepEqual(antigravity.options, [{ value: "default", label: "AGY configured default", supportedReasoningEfforts: [] }]);
    assert.equal(antigravity.defaultValue, "default");
    assert.equal(antigravity.status, "fallback");

    // v1 clients never see these forms.
    for (const runtimeId of ["opencode", "kimi", "gemini", "antigravity"]) {
      for (const url of [
        `${base}/runtime-form-definitions/${runtimeId}?schemaVersion=${runtimeId}.create.v1`,
        `${base}/runtime-form-definitions/${runtimeId}/option-sources/model?schemaVersion=${runtimeId}.create.v1`,
      ]) {
        const res = await fetch(url, { headers });
        assert.equal(res.status, 404, url);
        assert.deepEqual((await res.json() as { issues: unknown }).issues, [{ code: "unknown_form_runtime", pointer: "/runtimeId" }]);
      }
    }
});
test("runtime_form.v3 over HTTP: the advertised capability gets the v3 form and effort source, a stale revision is a 409, others keep v2 byte for byte", async ({ app }) => {
    const { owner, server } = await seedRoleFixture("v3-runtime-forms");
    const [machine] = await getDb().insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "v3-machine",
      apiKeyHash: "unused-v3-machine-hash",
      runtimes: ["codex"],
    }).returning();
    const headers = { Authorization: `Bearer ${await tokenForHuman(owner.email)}`, "X-Server-Id": server.id };
    app.app.set("agentOrchestrator", {
      hasMachineLocally: () => true,
      detectMachineRuntimeModels: async () => ({
        kind: "live",
        value: {
          models: [
            { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
            { id: "gpt-7-preview", label: "GPT-7 Preview", supportedReasoningEfforts: ["low", "medium", "high", "max"], defaultReasoningEffort: "high" },
          ],
          default: "gpt-5.6-sol",
        },
      }),
    });
    const base = `${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-forms/v2/codex`;
    const v3 = "clientCapabilities=dependent_select.custom_value_with_options,runtime_form.v3";
    const fixtureText = (name: string) => readFileSync(new URL(`../../../runtime-form/fixtures/${name}`, import.meta.url), "utf8");
    const asSent = async (res: Response) => `${JSON.stringify(await res.json(), null, 2)}\n`;

    const v2Form = await fetch(base, { headers });
    assert.equal(await asSent(v2Form), fixtureText("codex.form.json"), "no capability: today's v2 form");
    const v3FormRes = await fetch(`${base}?${v3}`, { headers });
    assert.equal(v3FormRes.status, 200);
    const v3Text = await asSent(v3FormRes);
    assert.equal(v3Text, fixtureText("codex.form.v3.json"));
    const revision = (JSON.parse(v3Text) as { revision: string }).revision;

    const effort = await fetch(`${base}/option-sources/reasoningEffort?formRevision=${revision}&${v3}`, { headers });
    assert.equal(effort.status, 200);
    assert.equal(await asSent(effort), fixtureText("codex.option-source.reasoning-effort.v3.json"));
    const unrevisioned = await fetch(`${base}/option-sources/reasoningEffort?${v3}`, { headers });
    assert.equal(unrevisioned.status, 200, "the revision stays optional");

    const stale = await fetch(`${base}/option-sources/model?formRevision=stale-token&${v3}`, { headers });
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), {
      error: "Runtime form has changed; refetch it before loading options",
      code: "form_revision_stale",
      recovery: "refetch_form",
    });

    // The effort source exists only on v3.
    const v2Effort = await fetch(`${base}/option-sources/reasoningEffort`, { headers });
    assert.equal(v2Effort.status, 404);
});
test("batch 3a v2 forms: Codex/Grok option sources carry option_source.status over HTTP, retry with refresh=1 probes again, v1 routes stay 404", async ({ app }) => {
    const { owner, server } = await seedRoleFixture("v2-batch3a-runtime-forms");
    const [machine] = await getDb().insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "v2-batch3a-machine",
      apiKeyHash: "unused-v2-batch3a-machine-hash",
      runtimes: ["codex", "grok", "opencode"],
    }).returning();
    const headers = { Authorization: `Bearer ${await tokenForHuman(owner.email)}`, "X-Server-Id": server.id };
    const probed: string[] = [];
    const forced: boolean[] = [];
    let local = true;
    let probe: () => Promise<unknown> = async () => ({ kind: "missing_config" });
    app.app.set("agentOrchestrator", {
      hasMachineLocally: () => local,
      detectMachineRuntimeModels: async (_machineId: string, runtime: string, options?: { force?: boolean }) => {
        probed.push(runtime);
        forced.push(options?.force === true);
        return probe();
      },
    });
    const base = `${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}`;
    const fixtureText = (name: string) => readFileSync(new URL(`../../../runtime-form/fixtures/${name}`, import.meta.url), "utf8");
    const asSent = async (res: Response) => `${JSON.stringify(await res.json(), null, 2)}\n`;

    const formRes = await fetch(`${base}/runtime-forms/v2/codex`, { headers });
    assert.equal(formRes.status, 200);
    assert.equal(await asSent(formRes), fixtureText("codex.form.json"));
    const grokFormRes = await fetch(`${base}/runtime-forms/v2/grok`, { headers });
    assert.equal(grokFormRes.status, 200);
    assert.equal(await asSent(grokFormRes), fixtureText("grok.form.json"));

    // missing_config: 200 with the bundled list marked fallback, byte-equal to the shared fixture.
    const sourceUrl = `${base}/runtime-forms/v2/codex/option-sources/model`;
    forced.length = 0;
    const fallback = await fetch(sourceUrl, { headers });
    assert.equal(fallback.status, 200);
    assert.deepEqual(forced, [false], "a plain source read may be answered from the Computer's model cache");
    assert.equal(await asSent(fallback), fixtureText("codex.option-source.fallback.json"));

    // A retry asks the Computer again and gets the live list.
    probe = async () => ({ kind: "live", value: { models: [{ id: "gpt-7-preview", label: "GPT-7 Preview" }] } });
    probed.length = 0;
    const retried = await fetch(`${sourceUrl}?refresh=1`, { headers });
    assert.equal(retried.status, 200);
    const retriedBody = await retried.json() as { status: string; options: Array<{ value: string }> };
    assert.equal(retriedBody.status, "live");
    assert.deepEqual(retriedBody.options.map((option) => option.value), ["gpt-7-preview"]);
    assert.deepEqual(probed, ["codex"]);
    assert.deepEqual(forced.slice(-1), [true], "refresh=1 asks the Computer to bypass its model cache");

    // Every source-level failure is a 200 with a reason, never a 409/500 (no v1 fallback for a source).
    for (const [detect, reason, retryable] of [
      [async () => ({ kind: "unsupported" }), "unsupported", false],
      [async () => ({ kind: "error", retryable: true, code: "detect_timeout" }), "probe_timeout", true],
      [async () => { throw new RouteFailureError("daemon_timeout", "timed out"); }, "probe_timeout", true],
      [async () => { throw new Error("probe crashed"); }, "probe_failed", true],
    ] as const) {
      probe = detect;
      const res = await fetch(`${base}/runtime-forms/v2/grok/option-sources/model`, { headers });
      assert.equal(res.status, 200, reason);
      const body = await res.json() as Record<string, unknown>;
      assert.deepEqual([body.status, body.reason, body.retryable, "customValueAllowed" in body], ["fallback", reason, retryable, false], reason);
    }
    local = false;
    probed.length = 0;
    const offline = await fetch(sourceUrl, { headers });
    assert.equal(offline.status, 200);
    const offlineBody = await offline.json() as Record<string, unknown>;
    assert.deepEqual([offlineBody.status, offlineBody.reason, offlineBody.retryable], ["fallback", "machine_offline", true]);
    assert.deepEqual(probed, [], "an unrouted Computer is not probed");
    local = true;

    // A source with no probe status (OpenCode) keeps its source exactly as before, refresh=1 or not.
    probe = async () => ({ kind: "missing_config" });
    const opencode = await fetch(`${base}/runtime-forms/v2/opencode/option-sources/model?refresh=1`, { headers });
    assert.equal(opencode.status, 200);
    assert.equal(await asSent(opencode), fixtureText("opencode.option-source.fallback.json"));

    // v1 clients never see these forms or their status.
    for (const runtimeId of ["codex", "grok"]) {
      for (const url of [
        `${base}/runtime-form-definitions/${runtimeId}?schemaVersion=${runtimeId}.create.v1`,
        `${base}/runtime-form-definitions/${runtimeId}/option-sources/model?schemaVersion=${runtimeId}.create.v1`,
      ]) {
        const res = await fetch(url, { headers });
        assert.equal(res.status, 404, url);
        assert.deepEqual((await res.json() as { issues: unknown }).issues, [{ code: "unknown_form_runtime", pointer: "/runtimeId" }]);
      }
    }
});

test("GET /api/servers/:id/machines projects the Computer creator profile without exposing the raw attacher field", async ({ app }) => {
    const { owner, member, server } = await seedRoleFixture("machines-computer-attacher");
    const db = getDb();
    const [machine] = await db.insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "owner-computer-machine",
      apiKeyHash: "unused-computer-attacher-hash",
    }).returning();
    await db.insert(computers).values({
      serverId: server.id,
      machineId: machine.id,
      name: "owner-computer",
      apiKeyHash: "unused-computer-attacher-key-hash",
      apiKeyPrefix: "sk_computer_owner",
      attachedByUserId: owner.id,
    });
    await createAgent(server.id, "owner-computer-agent", { runtime: "codex", machineId: machine.id });
    app.app.set("agentOrchestrator", {
      getCurrentTimeMs: () => Date.parse("2026-07-24T05:00:00.000Z"),
      getMachineStatus: async () => "online",
      getMachineStatusVersion: async () => 1,
      getMachineDaemonVersion: () => null,
      getMachineComputerVersion: async () => "0.0.70",
    });

    const fetchMachine = async (email: string, machineId = machine.id) => {
    const token = await tokenForHuman(email);
      const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines`, {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Server-Id": server.id,
        },
      });
      assert.equal(res.status, 200);
      const body = await res.json() as {
        machines: Array<Record<string, unknown> & {
          id: string;
          isComputer: boolean;
          computerAttachedByCurrentUser: boolean;
          agentCount: number;
          creator: {
            type: "human";
            id: string;
            name: string;
            displayName: string | null;
            avatarUrl: string | null;
            gravatarHash: string;
          } | null;
        }>;
      };
      return body.machines.find((item) => item.id === machineId);
    };

    const ownerView = await fetchMachine(owner.email);
    assert.equal(ownerView?.isComputer, true);
    assert.equal(ownerView?.computerAttachedByCurrentUser, true);
    assert.equal(ownerView?.agentCount, 1);
    assert.equal(ownerView?.creator?.type, "human");
    assert.equal(ownerView?.creator?.id, owner.id);
    assert.equal(ownerView?.creator?.name, owner.name);
    assert.equal(ownerView?.creator?.displayName, owner.displayName);
    assert.equal(ownerView?.creator?.avatarUrl, owner.avatarUrl);
    assert.equal(ownerView?.creator?.gravatarHash, "", "the deprecated hash is always empty");
    assert.equal("computerAttachedByUserId" in (ownerView ?? {}), false);

    const memberView = await fetchMachine(member.email);
    assert.equal(memberView?.isComputer, true);
    assert.equal(memberView?.computerAttachedByCurrentUser, false);
    assert.equal(memberView?.agentCount, 1);
    assert.deepEqual(memberView?.creator, ownerView?.creator);
    assert.equal("computerAttachedByUserId" in (memberView ?? {}), false);

    const [departedMachine] = await db.insert(machines).values({
      serverId: server.id,
      userId: member.id,
      name: "departed-creator-computer-machine",
      apiKeyHash: "unused-departed-creator-hash",
    }).returning();
    await db.insert(computers).values({
      serverId: server.id,
      machineId: departedMachine.id,
      name: "departed-creator-computer",
      apiKeyHash: "unused-departed-creator-key-hash",
      apiKeyPrefix: "sk_computer_departed",
      attachedByUserId: member.id,
    });
    await db.delete(serverMembers).where(and(
      eq(serverMembers.serverId, server.id),
      eq(serverMembers.userId, member.id),
    ));

    const departedCreatorView = await fetchMachine(owner.email, departedMachine.id);
    assert.equal(departedCreatorView?.isComputer, true);
    assert.equal(departedCreatorView?.creator, null, "departed creators must not leak raw audit identity");
});

test("runtime-account usage needs no rollout rule and remains server-admin-or-attacher-only, cache-read-only, and refresh-deduped", async ({ app }) => {

  __clearRuntimeAccountUsageLocalCacheForTests();
  try {
    const { owner, admin, member, server } = await seedRoleFixture("runtime-usage-private");
    const db = getDb();
    const [bystander] = await db.insert(users).values({
      email: "bystander-runtime-usage-private@slock.test",
      name: "bystander-runtime-usage-private",
      displayName: "bystander-runtime-usage-private",
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    await db.insert(serverMembers).values({
      serverId: server.id,
      userId: bystander.id,
      role: "member",
    });
    const [machine] = await db.insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "runtime-usage-computer",
      apiKeyHash: "unused-runtime-usage-machine-hash",
      runtimes: ["codex"],
    }).returning();
    await db.insert(computers).values({
      serverId: server.id,
      machineId: machine.id,
      name: "runtime-usage-computer",
      apiKeyHash: "unused-runtime-usage-computer-hash",
      apiKeyPrefix: "sk_computer_usage",
      attachedByUserId: member.id,
    });
    await runtimeAccountUsageCacheService.write(machine.id, {
      protocolVersion: 2,
      provider: "codex",
      collectedAt: new Date(Date.now() - 60_000).toISOString(),
      staleAfter: new Date(Date.now() + 29 * 60_000).toISOString(),
      collectorVersion: "1.6.2",
      accounts: [{
        accountKey: "c".repeat(64),
        maskedLabel: "run****email@company.com",
        planLabel: "Pro",
        health: "ok",
        windows: [{
          id: "primary",
          label: "7 days",
          status: "ok",
          usedRatio: 0.2,
          resetsAt: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
          scope: { kind: "model", name: "GPT-5.3-Codex-Spark" },
        }],
      }],
    });

    const ownerToken = await tokenForHuman(owner.email);
    const adminToken = await tokenForHuman(admin.email);
    const memberToken = await tokenForHuman(member.email);
    const bystanderToken = await tokenForHuman(bystander.email);
    const url = `${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-account-usage/codex`;
    const headers = (token: string) => ({ Authorization: `Bearer ${token}`, "X-Server-Id": server.id });

    const ownerRead = await fetch(url, { headers: headers(ownerToken) });
    assert.equal(ownerRead.status, 200, "server owner can inspect another human's Computer usage");
    assert.equal((await ownerRead.json() as any).snapshot.accounts[0].maskedLabel, "run****email@company.com");
    const adminRead = await fetch(url, { headers: headers(adminToken) });
    assert.equal(adminRead.status, 200, "server admin can inspect another human's Computer usage");
    assert.equal((await adminRead.json() as any).snapshot.accounts[0].maskedLabel, "run****email@company.com");
    assert.equal((await fetch(url, { headers: headers(bystanderToken) })).status, 403, "ordinary non-attaching member stays excluded");

    // Window scopes reach only a client that declares it reads them: an older
    // web bundle's strict parse would drop the whole snapshot.
    const withoutCapability = await (await fetch(url, { headers: headers(ownerToken) })).json() as any;
    assert.equal("scope" in withoutCapability.snapshot.accounts[0].windows[0], false, "a client that does not declare it gets no scope");
    const withCapability = await (await fetch(url, {
      headers: { ...headers(ownerToken), [RAFT_CLIENT_CAPABILITIES_HEADER]: RUNTIME_USAGE_WINDOW_SCOPE_CLIENT_CAPABILITY },
    })).json() as any;
    assert.deepEqual(withCapability.snapshot.accounts[0].windows[0].scope, { kind: "model", name: "GPT-5.3-Codex-Spark" });
    // A bundle declaring only @1 still gets a model's scope.
    const v1 = await (await fetch(url, { headers: { ...headers(ownerToken), [RAFT_CLIENT_CAPABILITIES_HEADER]: "runtime-usage-window-scope@1" } })).json() as any;
    assert.deepEqual(v1.snapshot.accounts[0].windows[0].scope, { kind: "model", name: "GPT-5.3-Codex-Spark" });

    // Antigravity's model groups (`models`, OAR 0.103): only to a client
    // declaring @2; an @1 bundle's parser knows no `models` kind.
    await runtimeAccountUsageCacheService.write(machine.id, {
      protocolVersion: 2,
      provider: "antigravity",
      collectedAt: new Date(Date.now() - 60_000).toISOString(),
      staleAfter: new Date(Date.now() + 29 * 60_000).toISOString(),
      collectorVersion: "1.6.2",
      accounts: [{
        accountKey: "e".repeat(64),
        health: "ok",
        windows: [{ id: "gemini_weekly", label: "Gemini Models · Weekly", status: "ok", usedRatio: 0.4, scope: { kind: "models", name: "Gemini Models" } }],
      }],
    });
    const groupUrl = `${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-account-usage/antigravity`;
    // A Computer whose daemon does not read Antigravity's usage (an older one,
    // no DAEMON_CAPABILITY_RUNTIME_ACCOUNT_USAGE_ANTIGRAVITY): no usage for it,
    // never "needs attention", and nothing asked of it; offline, the cache answers.
    const realOrchestrator = app.app.get("agentOrchestrator");
    let readable: "readable" | "unsupported" | "unknown" = "readable";
    const asked: string[] = [];
    app.app.set("agentOrchestrator", {
      runtimeAccountUsageReadable: async () => readable,
      requestRuntimeAccountUsageRefresh: async (_machineId: string, provider: string) => { asked.push(provider); return true; },
    });
    const groupV1 = await (await fetch(groupUrl, { headers: { ...headers(ownerToken), [RAFT_CLIENT_CAPABILITIES_HEADER]: "runtime-usage-window-scope@1" } })).json() as any;
    assert.equal("scope" in groupV1.snapshot.accounts[0].windows[0], false, "an @1 client gets the group's window unscoped");
    const groupV2 = await (await fetch(groupUrl, { headers: { ...headers(ownerToken), [RAFT_CLIENT_CAPABILITIES_HEADER]: RUNTIME_USAGE_WINDOW_SCOPE_CLIENT_CAPABILITY } })).json() as any;
    assert.deepEqual(groupV2.snapshot.accounts[0].windows[0].scope, { kind: "models", name: "Gemini Models" });

    try {
      readable = "unsupported";
      assert.deepEqual(await (await fetch(groupUrl, { headers: headers(ownerToken) })).json(), { state: "unsupported", snapshot: null });
      const refused = await fetch(`${groupUrl}/refresh`, { method: "POST", headers: { ...headers(ownerToken), "Content-Type": "application/json" }, body: JSON.stringify({ reason: "stale_or_missing" }) });
      assert.equal(refused.status, 202);
      assert.deepEqual(await refused.json(), { accepted: false, state: "unsupported" });
      assert.deepEqual(asked, [], "an older Computer is never asked for it");
      readable = "unknown";
      assert.equal((await (await fetch(groupUrl, { headers: headers(ownerToken) })).json() as any).state, "fresh", "offline: the cache answers");
    } finally {
      app.app.set("agentOrchestrator", realOrchestrator);
    }

    const refreshes: Array<{ machineId: string; provider: string; reason: string }> = [];
    app.app.set("agentOrchestrator", {
      requestRuntimeAccountUsageRefresh: async (machineId: string, provider: string, reason: string) => {
        refreshes.push({ machineId, provider, reason });
        return true;
      },
    });

    const attacherRead = await fetch(url, { headers: headers(memberToken) });
    assert.equal(attacherRead.status, 200, "the attaching human remains authorized without an admin role");
    assert.equal(attacherRead.headers.get("cache-control"), "private, no-store");
    const bodyText = await attacherRead.text();
    assert.equal(bodyText.includes("run****email@company.com"), true, "attacher response includes only the masked account label");
    assert.equal(bodyText.includes("runtime-email@company.com"), false, "raw account email never crosses the response boundary");
    assert.equal(bodyText.includes("access_token"), false);
    assert.equal(refreshes.length, 0, "cache GET must never dispatch a provider refresh");

    const refreshUrl = `${url}/refresh`;
    assert.equal((await fetch(refreshUrl, {
      method: "POST",
      headers: { ...headers(bystanderToken), "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "stale_or_missing" }),
    })).status, 403, "ordinary non-attaching member cannot trigger provider collection");

    const firstRefresh = await fetch(refreshUrl, {
      method: "POST",
      headers: { ...headers(adminToken), "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "stale_or_missing" }),
    });
    assert.equal(firstRefresh.status, 202);
    assert.deepEqual(await firstRefresh.json(), { accepted: true, state: "requested" });
    assert.deepEqual(refreshes, [{ machineId: machine.id, provider: "codex", reason: "stale_or_missing" }]);

    const duplicateRefresh = await fetch(refreshUrl, {
      method: "POST",
      headers: { ...headers(memberToken), "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "stale_or_missing" }),
    });
    assert.equal(duplicateRefresh.status, 202);
    assert.deepEqual(await duplicateRefresh.json(), { accepted: false, state: "cooldown" });
    assert.equal(refreshes.length, 1);
  } finally {
    __clearRuntimeAccountUsageLocalCacheForTests();
    await app.close();
  }
});

test("manual runtime-account usage refresh waits for the machine reply: fresh, malformed, timeout, offline", async ({ app }) => {

  __clearRuntimeAccountUsageLocalCacheForTests();
  try {
    const { owner, server } = await seedRoleFixture("runtime-usage-manual-sync");
    const db = getDb();
    const [machine] = await db.insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "runtime-usage-manual-computer",
      apiKeyHash: "unused-runtime-usage-manual-hash",
      runtimes: ["codex", "kimi", "grok", "claude"],
    }).returning();
    await db.insert(computers).values({
      serverId: server.id,
      machineId: machine.id,
      name: "runtime-usage-manual-computer",
      apiKeyHash: "unused-runtime-usage-manual-computer-hash",
      apiKeyPrefix: "sk_computer_usage_manual",
      attachedByUserId: owner.id,
    });

    const freshSnapshot = {
      protocolVersion: 2,
      provider: "codex",
      collectedAt: new Date(Date.now() - 5_000).toISOString(),
      staleAfter: new Date(Date.now() + 25 * 60_000).toISOString(),
      collectorVersion: "1.6.2",
      accounts: [{
        accountKey: "d".repeat(64),
        maskedLabel: "man****email@company.com",
        planLabel: "Pro",
        health: "ok",
        windows: [{
          id: "primary",
          label: "7 days",
          status: "ok",
          usedRatio: 0.42,
          resetsAt: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
        }],
      }],
    };

    const awaited: Array<{ machineId: string; provider: string }> = [];
    const fireAndForget: Array<{ machineId: string; provider: string; reason: string }> = [];
    let behavior: "fresh" | "scoped" | "malformed" | "timeout" | "offline" = "fresh";
    app.app.set("agentOrchestrator", {
      requestRuntimeAccountUsageRefresh: async (machineId: string, provider: string, reason: string) => {
        fireAndForget.push({ machineId, provider, reason });
        return true;
      },
      requestRuntimeAccountUsageRefreshAndAwait: async (machineId: string, provider: string) => {
        awaited.push({ machineId, provider });
        if (behavior === "timeout") throw new RouteFailureError("daemon_timeout", "Machine response timed out");
        if (behavior === "offline") throw new RouteFailureError("daemon_offline", "Machine reply transport unavailable");
        if (behavior === "malformed") {
          // A computer reported an account whose `windows` is not an array.
          const account = { ...freshSnapshot.accounts[0]!, windows: { primary: freshSnapshot.accounts[0]!.windows[0] } };
          return { type: "machine:runtime_account_usage:snapshot", requestId: "req-manual-2", snapshot: { ...freshSnapshot, provider, accounts: [account] } };
        }
        if (behavior === "scoped") {
          const account = { ...freshSnapshot.accounts[0]!, windows: [{ ...freshSnapshot.accounts[0]!.windows[0]!, scope: { kind: "account" } }] };
          return { type: "machine:runtime_account_usage:snapshot", requestId: "req-manual-3", snapshot: { ...freshSnapshot, accounts: [account] } };
        }
        return { type: "machine:runtime_account_usage:snapshot", requestId: "req-manual-1", snapshot: freshSnapshot };
      },
    });

    const ownerToken = await tokenForHuman(owner.email);
    const headers = { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id, "Content-Type": "application/json" };
    const refreshUrl = (provider: string) =>
      `${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-account-usage/${provider}/refresh`;

    const fresh = await fetch(refreshUrl("codex"), { method: "POST", headers, body: JSON.stringify({ reason: "manual" }) });
    assert.equal(fresh.status, 200, "a manual refresh that reached the machine answers 200, not 202");
    assert.deepEqual(await fresh.json(), { accepted: true, state: "fresh", snapshot: freshSnapshot });
    assert.deepEqual(awaited, [{ machineId: machine.id, provider: "codex" }]);
    assert.equal(fireAndForget.length, 0, "manual refreshes never take the fire-and-forget path");

    const cooling = await fetch(refreshUrl("codex"), { method: "POST", headers, body: JSON.stringify({ reason: "manual" }) });
    assert.equal(cooling.status, 202);
    assert.deepEqual(await cooling.json(), { accepted: false, state: "cooldown" });
    assert.equal(awaited.length, 1, "the cooldown gate fires before any machine dispatch");

    // Its own Computer: the refresh cooldown is per Computer and provider.
    const [malformedMachine] = await db.insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "runtime-usage-malformed-computer",
      apiKeyHash: "unused-runtime-usage-malformed-hash",
      runtimes: ["codex"],
    }).returning();
    behavior = "malformed";
    const malformed = await fetch(
      `${app.baseUrl}/api/servers/${server.id}/machines/${malformedMachine.id}/runtime-account-usage/codex/refresh`,
      { method: "POST", headers, body: JSON.stringify({ reason: "manual" }) },
    );
    assert.equal(malformed.status, 200);
    assert.deepEqual(await malformed.json(), { accepted: true, state: "fresh", snapshot: null }, "a reply outside the snapshot schema is never relayed");

    // A refreshed snapshot carries window scopes only to a client that declares it reads them.
    behavior = "scoped";
    const scopedPlain = await fetch(
      `${app.baseUrl}/api/servers/${server.id}/machines/${malformedMachine.id}/runtime-account-usage/claude/refresh`,
      { method: "POST", headers, body: JSON.stringify({ reason: "manual" }) },
    );
    assert.deepEqual(await scopedPlain.json(), { accepted: true, state: "fresh", snapshot: freshSnapshot }, "no scope without the capability");
    const scopedCapable = await fetch(
      `${app.baseUrl}/api/servers/${server.id}/machines/${malformedMachine.id}/runtime-account-usage/grok/refresh`,
      { method: "POST", headers: { ...headers, [RAFT_CLIENT_CAPABILITIES_HEADER]: RUNTIME_USAGE_WINDOW_SCOPE_CLIENT_CAPABILITY }, body: JSON.stringify({ reason: "manual" }) },
    );
    assert.deepEqual((await scopedCapable.json() as any).snapshot.accounts[0].windows[0].scope, { kind: "account" });

    behavior = "timeout";
    const timedOut = await fetch(refreshUrl("kimi"), { method: "POST", headers, body: JSON.stringify({ reason: "manual" }) });
    assert.equal(timedOut.status, 200, "a relay timeout is still an accepted refresh");
    assert.deepEqual(await timedOut.json(), { accepted: true, state: "timeout" });

    behavior = "offline";
    const offline = await fetch(refreshUrl("grok"), { method: "POST", headers, body: JSON.stringify({ reason: "manual" }) });
    assert.equal(offline.status, 202);
    assert.deepEqual(await offline.json(), { accepted: false, state: "computer_offline" });

    behavior = "fresh";
    const background = await fetch(refreshUrl("claude"), { method: "POST", headers, body: JSON.stringify({ reason: "stale_or_missing" }) });
    assert.equal(background.status, 202, "background-triggered refreshes keep the requested contract");
    assert.deepEqual(await background.json(), { accepted: true, state: "requested" });
    assert.deepEqual(fireAndForget, [{ machineId: machine.id, provider: "claude", reason: "stale_or_missing" }]);
    assert.equal(awaited.length, 6, "stale_or_missing never waits on the relay");
  } finally {
    __clearRuntimeAccountUsageLocalCacheForTests();
    await app.close();
  }
});

test("GET /api/servers/:id/machines projects one source-aware policy decision per Computer", async ({ app }) => {

  const originalFetch = globalThis.fetch;
  __resetLatestComputerVersionForTest();
  try {
    const { owner, server } = await seedRoleFixture("machines-computer-upgrade-state");
    const db = getDb();
    const [oldComputer, currentComputer, rawDaemon] = await db.insert(machines).values([
      {
        serverId: server.id,
        userId: owner.id,
        name: "old-computer",
        apiKeyHash: "unused-old-computer-hash",
        os: "linux x64",
      },
      {
        serverId: server.id,
        userId: owner.id,
        name: "current-computer",
        apiKeyHash: "unused-current-computer-hash",
        os: "linux x64",
      },
      {
        serverId: server.id,
        userId: owner.id,
        name: "raw-daemon",
        apiKeyHash: "unused-raw-daemon-hash",
      },
    ]).returning();
    await db.insert(computers).values([
      {
        serverId: server.id,
        machineId: oldComputer.id,
        name: "old-computer",
        apiKeyHash: "unused-old-computer-key-hash",
        apiKeyPrefix: "sk_computer_old",
        attachedByUserId: owner.id,
      },
      {
        serverId: server.id,
        machineId: currentComputer.id,
        name: "current-computer",
        apiKeyHash: "unused-current-computer-key-hash",
        apiKeyPrefix: "sk_computer_current",
        attachedByUserId: owner.id,
      },
    ]);
    app.app.set("agentOrchestrator", {
      // Reconciler step 13: this fake Computer does not advertise drain.
      computerUpgradeDrainMs: async () => null,
      getComputerUpgradeDrain: () => null,
      getCurrentTimeMs: () => Date.parse("2026-07-24T05:00:00.000Z"),
      getMachineStatus: async () => "online",
      getMachineStatusVersion: async () => 1,
      getMachineDaemonVersion: () => null,
      hasMachineLocally: () => true,
      // Every capability but the negative "cannot reach its service" fact.
      hasMachineCapability: (_machineId: string, capability: string) => capability !== COMPUTER_CAPABILITY_SERVICE_IPC_UNREACHABLE,
      getMachineConnectionEpoch: () => "policy-test-epoch",
      getMachineComputerVersionFact: async (machineId: string) => {
        const version = machineId === oldComputer.id
          ? "1.0.46"
          : machineId === currentComputer.id
            ? "1.0.47"
            : null;
        return {
          version,
          observedAt: new Date().toISOString(),
          provenance: "owner_connection",
        };
      },
      sendComputerControl: async () => {
        throw new Error("no-broadcast machine must never reach relay");
      },
    });
    app.app.set("computerBroadcastPolicyEvaluator", (input: EvaluateComputerBroadcastPolicyInput) => {
      if (input.source?.version === "1.0.46") {
        return testBroadcastPolicyDecision(input, {
          eligibility: "eligible",
          reasonCode: "eligible",
          targetVersion: "2.0.0",
          targetRole: "K",
          migrationClass: "controlled_reinstall_repair",
        });
      }
      return testBroadcastPolicyDecision(input);
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://hands.build/public/v2/apps/raft-computer-cli/updates/check")) {
        return new Response(JSON.stringify({ update_available: true, release: { id: "r-test", version: "9.9.9" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://hands.build/public/v2/apps/raft-computer-cli/latest?channel=main") {
        return new Response(JSON.stringify({
          build: { version: "9.9.9", release_notes: { en: "- Faster startup", "zh-CN": "- 启动更快" } },
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    assert.equal(await getLatestComputerVersion(), null);
    for (let attempt = 0; attempt < 10 && getLatestComputerReleaseNotes() === null; attempt += 1) {
      await getLatestComputerVersion();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(await getLatestComputerVersion(), "9.9.9");

    const ownerToken = await tokenForHuman(owner.email);
    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines`, {
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "X-Server-Id": server.id,
      },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      machines: Array<{
        id: string;
        computerUpgradeAvailable: boolean | null;
        computerBroadcastPolicy: {
          eligibility: string;
          targetVersion: string | null;
          policyRevision: string | null;
          reasonCode: string;
        } | null;
      }>;
      latestComputerVersion: string | null;
      latestComputerReleaseNotes: { version: string; en?: string; "zh-CN"?: string } | null;
    };
    assert.equal(body.latestComputerVersion, "9.9.9");
    assert.deepEqual(body.latestComputerReleaseNotes, {
      version: "9.9.9",
      en: "- Faster startup",
      "zh-CN": "- 启动更快",
    });
    assert.equal(body.machines.find((machine) => machine.id === oldComputer.id)?.computerUpgradeAvailable, true);
    assert.equal(body.machines.find((machine) => machine.id === currentComputer.id)?.computerUpgradeAvailable, false);
    assert.equal(body.machines.find((machine) => machine.id === rawDaemon.id)?.computerUpgradeAvailable, null);
    assert.deepEqual(
      body.machines.find((machine) => machine.id === oldComputer.id)?.computerBroadcastPolicy,
      {
        eligibility: "eligible",
        targetVersion: "2.0.0",
        targetRole: "K",
        migrationClass: "controlled_reinstall_repair",
        policyRevision: "test-policy-v1",
        reasonCode: "eligible",
      },
    );
    assert.equal(
      body.machines.find((machine) => machine.id === currentComputer.id)?.computerBroadcastPolicy?.reasonCode,
      "policy_row_missing",
    );
    assert.equal(
      body.machines.find((machine) => machine.id === rawDaemon.id)?.computerBroadcastPolicy,
      null,
    );

    const refusalSink = new MemoryTraceSink();
    app.app.set("serverTracer", new BasicTracer({ sink: refusalSink }));
    const deniedDispatch = await fetch(
      `${app.baseUrl}/api/servers/${server.id}/machines/${currentComputer.id}/computer/upgrade`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "X-Server-Id": server.id,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ targetVersion: "2.0.0" }),
      },
    );
    assert.equal(deniedDispatch.status, 409);
    const deniedBody = await deniedDispatch.json() as {
      code: string;
      policy: { policyRevision: string; reasonCode: string };
    };
    assert.equal(deniedBody.code, "computer_broadcast_not_eligible");
    assert.deepEqual(deniedBody.policy, {
      eligibility: "no_broadcast",
      targetVersion: null,
      targetRole: null,
      migrationClass: null,
      policyRevision: "test-policy-v1",
      reasonCode: "policy_row_missing",
    });
    // The refusal's trace event names the policy's reason, as the body does (#proj-o11y:#29).
    const refused = refusalSink.getAllSpans().flatMap((span) => span.events)
      .find((event) => event.name === "computer.control.rejected");
    assert.equal(refused?.attrs?.reason, "computer_broadcast_not_eligible");
    assert.equal(refused?.attrs?.policy_reason_code, "policy_row_missing");
    assert.equal(refused?.attrs?.policy_eligibility, "no_broadcast");
    assert.equal(refused?.attrs?.policy_target_version, undefined);

    // Remote upgrade v2 happy path: one request row, the exact policy target
    // sent as the command, and a repeat click returns the same open request.
    const sent: Array<{ machineId: string; targetVersion: string; requestId: string }> = [];
    (app.app.get("agentOrchestrator") as Record<string, unknown>).sendComputerUpgrade = async (machineId: string, targetVersion: string, requestId: string) => {
      sent.push({ machineId, targetVersion, requestId });
      return { sent: true };
    };
    const v2 = await fetch(
      `${app.baseUrl}/api/servers/${server.id}/machines/${oldComputer.id}/computer/upgrade`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id, "Content-Type": "application/json" },
        body: JSON.stringify({ targetVersion: "2.0.0" }),
      },
    );
    assert.equal(v2.status, 201);
    const v2Body = (await v2.json()) as { upgradeRequest: { id: string; targetVersion: string; state: string } };
    assert.equal(v2Body.upgradeRequest.targetVersion, "2.0.0");
    assert.equal(v2Body.upgradeRequest.state, "pending");
    assert.deepEqual(sent, [{ machineId: oldComputer.id, targetVersion: "2.0.0", requestId: v2Body.upgradeRequest.id }]);
    const rows = await getDb().select().from(computerUpgradeRequests);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.machineId, oldComputer.id);
    assert.equal(rows[0]!.outcome, null);
    const v2Again = await fetch(
      `${app.baseUrl}/api/servers/${server.id}/machines/${oldComputer.id}/computer/upgrade`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id, "Content-Type": "application/json" },
        body: JSON.stringify({ targetVersion: "2.0.0" }),
      },
    );
    assert.equal(v2Again.status, 200, "an open request is returned, not duplicated");
    assert.equal(((await v2Again.json()) as { upgradeRequest: { id: string } }).upgradeRequest.id, v2Body.upgradeRequest.id);
    assert.equal(sent.length, 1, "no second command for an open request");
    // The machines projection carries the request.
    const listed = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines`, {
      headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id },
    });
    const listedBody = (await listed.json()) as { machines: Array<{ id: string; upgradeRequest: { id: string; state: string } | null }> };
    assert.equal(listedBody.machines.find((machine) => machine.id === oldComputer.id)?.upgradeRequest?.state, "pending");
    assert.equal(listedBody.machines.find((machine) => machine.id === currentComputer.id)?.upgradeRequest, null);

    // Below the first v2-capable Computer release: the projection says so (web
    // greys the button and shows the local-upgrade hint) and a direct request
    // is refused before any policy or command work.
    const orchestrator = app.app.get("agentOrchestrator") as {
      getMachineComputerVersionFact: (machineId: string) => Promise<{ version: string | null; observedAt: string; provenance: string }>;
    };
    const supportedFact = orchestrator.getMachineComputerVersionFact;
    orchestrator.getMachineComputerVersionFact = async (machineId: string) => {
      const fact = await supportedFact(machineId);
      return machineId === currentComputer.id ? { ...fact, version: "1.0.36" } : fact;
    };
    const legacyDispatch = await fetch(
      `${app.baseUrl}/api/servers/${server.id}/machines/${currentComputer.id}/computer/upgrade`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id, "Content-Type": "application/json" },
        body: JSON.stringify({ targetVersion: "2.0.0" }),
      },
    );
    assert.equal(legacyDispatch.status, 409);
    assert.equal(((await legacyDispatch.json()) as { code: string }).code, "computer_remote_upgrade_unsupported");
    assert.equal(sent.length, 1, "no command for an unsupported Computer");
    const listedAfter = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines`, {
      headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id },
    });
    const listedAfterBody = (await listedAfter.json()) as { machines: Array<{ id: string; remoteUpgradeSupported: boolean | null }> };
    assert.equal(listedAfterBody.machines.find((machine) => machine.id === oldComputer.id)?.remoteUpgradeSupported, true);
    assert.equal(listedAfterBody.machines.find((machine) => machine.id === currentComputer.id)?.remoteUpgradeSupported, false);
    assert.equal(listedAfterBody.machines.find((machine) => machine.id === rawDaemon.id)?.remoteUpgradeSupported, null);

    // A prerelease of a release below the threshold (staging / rc build) is
    // below it too: the projection says unsupported and a direct request is
    // refused, never sent.
    orchestrator.getMachineComputerVersionFact = async (machineId: string) => {
      const fact = await supportedFact(machineId);
      return machineId === currentComputer.id ? { ...fact, version: "1.0.36-rc.1" } : fact;
    };
    const prereleaseDispatch = await fetch(
      `${app.baseUrl}/api/servers/${server.id}/machines/${currentComputer.id}/computer/upgrade`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id, "Content-Type": "application/json" },
        body: JSON.stringify({ targetVersion: "2.0.0" }),
      },
    );
    assert.equal(prereleaseDispatch.status, 409);
    assert.equal(((await prereleaseDispatch.json()) as { code: string }).code, "computer_remote_upgrade_unsupported");
    assert.equal(sent.length, 1, "no command for an unsupported prerelease Computer");
    const listedPrerelease = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines`, {
      headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id },
    });
    const listedPrereleaseBody = (await listedPrerelease.json()) as {
      machines: Array<{ id: string; computerVersion: string | null; remoteUpgradeSupported: boolean | null }>;
    };
    const prereleaseRow = listedPrereleaseBody.machines.find((machine) => machine.id === currentComputer.id);
    assert.equal(prereleaseRow?.computerVersion, "1.0.36-rc.1", "the projection read the prerelease version");
    assert.equal(prereleaseRow?.remoteUpgradeSupported, false);
  } finally {
    globalThis.fetch = originalFetch;
    __resetLatestComputerVersionForTest();
    await app.close();
  }
});

test("machine workspace scan and runtime model detect require admin machine privileges", async ({ app }) => {
    const { owner, member, server } = await seedRoleFixture("machine-privilege-gate");
    const [machine] = await getDb().insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "privileged-machine",
      apiKeyHash: "unused-machine-privilege-hash",
      runtimes: ["codex"],
    }).returning();
  const memberToken = await tokenForHuman(member.email);
  const ownerToken = await tokenForHuman(owner.email);

    let workspaceScanCalls = 0;
    let runtimeDetectCalls = 0;
    app.app.set("agentOrchestrator", {
      hasMachineLocally: () => true,
      scanMachineWorkspaces: async () => {
        workspaceScanCalls += 1;
        return [{
          directoryName: "orphan-workspace",
          totalSizeBytes: 42,
          lastModified: new Date(0).toISOString(),
          fileCount: 1,
        }];
      },
      detectMachineRuntimeModels: async () => {
        runtimeDetectCalls += 1;
        return { kind: "live", value: { models: [{ id: "gpt-5.4", label: "GPT 5.4" }], default: "gpt-5.4" } };
      },
    });

    const memberWorkspaceRes = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/workspaces`, {
      headers: {
        Authorization: `Bearer ${memberToken}`,
        "X-Server-Id": server.id,
      },
    });
    assert.equal(memberWorkspaceRes.status, 403);
    assert.equal(workspaceScanCalls, 0, "member must not trigger daemon workspace scan");

    const memberRuntimeRes = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-models/codex`, {
      headers: {
        Authorization: `Bearer ${memberToken}`,
        "X-Server-Id": server.id,
      },
    });
    assert.equal(memberRuntimeRes.status, 403);
    assert.equal(runtimeDetectCalls, 0, "member must not trigger daemon runtime detection");

    const ownerWorkspaceRes = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/workspaces`, {
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "X-Server-Id": server.id,
      },
    });
    assert.equal(ownerWorkspaceRes.status, 200);
    assert.equal(workspaceScanCalls, 1);

    const ownerRuntimeRes = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-models/codex`, {
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "X-Server-Id": server.id,
      },
    });
    assert.equal(ownerRuntimeRes.status, 200);
    assert.equal(runtimeDetectCalls, 1);
    assert.deepEqual(await ownerRuntimeRes.json(), {
      kind: "live",
      value: { models: [{ id: "gpt-5.4", label: "GPT 5.4" }], default: "gpt-5.4" },
      models: [{ id: "gpt-5.4", label: "GPT 5.4" }],
      default: "gpt-5.4",
      state: "ok",
    });
});

test("machine workspace scan and delete are scoped to the requesting server's agents on a shared Computer", async ({ app }) => {
  // One Computer attached to two servers keeps every agent workspace under one data
  // root, and each server sees the host through its own machine row. Server A's
  // controller must only ever see or remove directories that A's own agent records
  // account for; server B's workspace and unattributable directories stay invisible.
  const a = await seedRoleFixture("workspace-tenant-a");
  const b = await seedRoleFixture("workspace-tenant-b");
  const [machineA] = await getDb().insert(machines).values({
    serverId: a.server.id,
    userId: a.owner.id,
    name: "shared-host",
    apiKeyHash: "unused-shared-host-a",
    runtimes: ["codex"],
  }).returning();
  const [machineB] = await getDb().insert(machines).values({
    serverId: b.server.id,
    userId: b.owner.id,
    name: "shared-host",
    apiKeyHash: "unused-shared-host-b",
    runtimes: ["codex"],
  }).returning();
  const [liveAgentA] = await getDb().insert(agents).values({
    serverId: a.server.id, name: "a-live", runtime: "codex", machineId: machineA.id, status: "active",
  }).returning();
  const [deletedAgentA] = await getDb().insert(agents).values({
    serverId: a.server.id, name: "a-gone", runtime: "codex", machineId: machineA.id, deletedAt: new Date(),
  }).returning();
  const [agentB] = await getDb().insert(agents).values({
    serverId: b.server.id, name: "b-live", runtime: "codex", machineId: machineB.id, status: "active",
  }).returning();
  const unattributedDir = randomUUID();
  const ownerAToken = await tokenForHuman(a.owner.email);

  const entry = (directoryName: string) => ({
    directoryName,
    totalSizeBytes: 42,
    lastModified: new Date(0).toISOString(),
    fileCount: 1,
  });
  const deleteCalls: Array<{ machineId: string; directoryName: string }> = [];
  app.app.set("agentOrchestrator", {
    hasMachineLocally: () => true,
    scanMachineWorkspaces: async () => [
      entry(liveAgentA.id),
      entry(deletedAgentA.id),
      entry(agentB.id),
      entry(unattributedDir),
    ],
    deleteMachineWorkspaceDir: async (machineId: string, directoryName: string) => {
      deleteCalls.push({ machineId, directoryName });
      return true;
    },
  });
  const headers = { Authorization: `Bearer ${ownerAToken}`, "X-Server-Id": a.server.id };

  const scanRes = await fetch(`${app.baseUrl}/api/servers/${a.server.id}/machines/${machineA.id}/workspaces`, { headers });
  assert.equal(scanRes.status, 200);
  const scanned = (await scanRes.json()) as Array<{ directoryName: string; status: string; agentName: string | null }>;
  // Only A's own directories, with the leftover of its deleted agent still offered for cleanup.
  assert.deepEqual(
    scanned.map((ws) => [ws.directoryName, ws.status, ws.agentName]),
    [[liveAgentA.id, "active", "a-live"], [deletedAgentA.id, "deleted", "a-gone"]],
  );

  const deleteOther = await fetch(
    `${app.baseUrl}/api/servers/${a.server.id}/machines/${machineA.id}/workspaces/${agentB.id}`,
    { method: "DELETE", headers },
  );
  assert.equal(deleteOther.status, 404, "another server's workspace reads as absent, not forbidden");
  const deleteUnknown = await fetch(
    `${app.baseUrl}/api/servers/${a.server.id}/machines/${machineA.id}/workspaces/${unattributedDir}`,
    { method: "DELETE", headers },
  );
  assert.equal(deleteUnknown.status, 404);
  assert.deepEqual(deleteCalls, [], "no daemon delete for a directory outside this server's agents");

  const deleteOwnLeftover = await fetch(
    `${app.baseUrl}/api/servers/${a.server.id}/machines/${machineA.id}/workspaces/${deletedAgentA.id}`,
    { method: "DELETE", headers },
  );
  assert.equal(deleteOwnLeftover.status, 200);
  assert.deepEqual(await deleteOwnLeftover.json(), { ok: true });
  assert.deepEqual(deleteCalls, [{ machineId: machineA.id, directoryName: deletedAgentA.id }]);
});

test("machine workspace scan lists a personal assistant's workspace to its owner only", async ({ app }) => {
  const f = await seedRoleFixture("workspace-assistant");
  // The admin's own Computer: they may scan it, and so may the server owner.
  // The assistant is hosted, never on a Computer (agents_assistant_not_on_machine);
  // its directory here is a leftover from before, still matched by agent id.
  const [machine] = await getDb().insert(machines).values({
    serverId: f.server.id, userId: f.admin.id, name: "admin-host", apiKeyHash: "unused-workspace-assistant", runtimes: ["codex"],
  }).returning();
  const [ordinary] = await getDb().insert(agents).values({
    serverId: f.server.id, name: "ws-ordinary", runtime: "codex", machineId: machine.id, status: "active",
  }).returning();
  const [assistant] = await getDb().insert(agents).values({
    serverId: f.server.id, name: "ws-assistant", runtime: "codex", status: "active", assistantOwnerUserId: f.admin.id,
  }).returning();
  const entry = (directoryName: string) => ({ directoryName, totalSizeBytes: 1, lastModified: new Date(0).toISOString(), fileCount: 1 });
  app.app.set("agentOrchestrator", {
    hasMachineLocally: () => true,
    scanMachineWorkspaces: async () => [entry(ordinary.id), entry(assistant.id)],
  });
  const scan = async (email: string) => {
    const res = await fetch(`${app.baseUrl}/api/servers/${f.server.id}/machines/${machine.id}/workspaces`, {
      headers: { Authorization: `Bearer ${await tokenForHuman(email)}`, "X-Server-Id": f.server.id },
    });
    assert.equal(res.status, 200);
    return ((await res.json()) as Array<{ directoryName: string }>).map((ws) => ws.directoryName).sort();
  };
  assert.deepEqual(await scan(f.owner.email), [ordinary.id], "the server owner never finds another person's assistant");
  assert.deepEqual(await scan(f.admin.email), [ordinary.id, assistant.id].sort(), "its owner does");
});

test("GET /api/servers/:id/machines/:machineId/runtime-models/:runtime records detect phases and failures", async ({ app }) => {
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({
      sink,
      traceIdGenerator: () => "d".repeat(32),
      spanIdGenerator: (() => {
        let next = 1;
        return () => String(next++).padStart(16, "0");
      })(),
    });
    app.app.set("serverTracer", tracer);

    const { owner, server } = await seedRoleFixture("runtime-models-trace");
    const db = getDb();
    const [machine] = await db.insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "runtime-model-machine",
      apiKeyHash: "unused-runtime-model-hash",
      runtimes: ["codex"],
      daemonVersion: "0.44.0",
    }).returning();
  const ownerToken = await tokenForHuman(owner.email);

    app.app.set("agentOrchestrator", {
      hasMachineLocally: () => true,
      detectMachineRuntimeModels: async () => ({ kind: "live", value: { models: [{ id: "gpt-5.4", label: "GPT 5.4" }], default: "gpt-5.4" } }),
    });
    sink.clear();
    let res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-models/codex`, {
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "X-Server-Id": server.id,
      },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      kind: "live",
      value: { models: [{ id: "gpt-5.4", label: "GPT 5.4" }], default: "gpt-5.4" },
      models: [{ id: "gpt-5.4", label: "GPT 5.4" }],
      default: "gpt-5.4",
      state: "ok",
    });
    let span = sink.getAllSpans().find((candidate) =>
      candidate.name === "server.http.request"
      && candidate.attrs?.route_pattern === "/api/servers/:id/machines/:machineId/runtime-models/:runtime",
    );
    assert.ok(span, "expected runtime-models root span");
    assert.deepEqual(
      handlerTraceEvents(span.events).map((event) => event.name),
      [
        "runtime_models.detect.started",
        "server.membership.checked",
        "machine.loaded",
        "machine.affinity.routed",
        "machine.routing.checked",
        "runtime_models.detected",
        "response.ready",
        "http.response.finished",
      ],
    );
    // The affinity event carries the hashed Computer id, never the raw one (#proj-o11y:#29).
    const affinityEvent = span.events.find((event) => event.name === "machine.affinity.routed");
    assert.equal(affinityEvent?.attrs?.machine_id_present, true);
    assert.ok(!JSON.stringify(affinityEvent?.attrs ?? {}).includes(machine.id));
    const detectedEvent = span.events.find((event) => event.name === "runtime_models.detected");
    assert.ok(detectedEvent);
    assert.equal(detectedEvent.attrs?.runtime, "codex");
    assert.equal(detectedEvent.attrs?.outcome, "live");
    assert.equal(detectedEvent.attrs?.models_count, 1);
    assert.equal(detectedEvent.attrs?.default_model_present, true);
    assert.equal(Object.values(span.attrs ?? {}).includes(machine.id), false);

    for (const outcome of [
      { kind: "missing_config", recovery: "kimi_login" },
      { kind: "no_models" },
      { kind: "unsupported" },
      { kind: "error", retryable: true },
      { kind: "error", retryable: true, code: "runtime_not_authenticated" },
    ] as const) {
      app.app.set("agentOrchestrator", {
        hasMachineLocally: () => true,
        detectMachineRuntimeModels: async () => outcome,
      });
      res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-models/codex`, {
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "X-Server-Id": server.id,
        },
      });
      assert.equal(res.status, 200, outcome.kind);
      assert.deepEqual(await res.json(), { ...outcome, state: "ok" }, outcome.kind);
    }

    // A timeout answers from the probe cache (none for grok here): unavailable.
    // An offline Computer is a known state.
    for (const [subkind, code, state] of [
      ["daemon_timeout", "detect_timeout", "unavailable"],
      ["daemon_offline", "computer_offline", "ok"],
    ] as const) {
      app.app.set("agentOrchestrator", {
        hasMachineLocally: () => true,
        detectMachineRuntimeModels: async () => { throw new RouteFailureError(subkind, "opaque diagnostic"); },
      });
      const failure = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-models/grok`, {
        headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id },
      });
      assert.equal(failure.status, 200);
      assert.deepEqual(await failure.json(), { kind: "error", retryable: true, code, state });
    }
    // A failure of the server's own (a stale catalog authority, a DB error, a
    // throw from the catalog write) is not "the Computer did not answer in
    // time": no state, so the client keeps its generic error copy.
    for (const serverError of [new MachineCatalogStaleError(), new Error("connection terminated unexpectedly")]) {
      app.app.set("agentOrchestrator", {
        hasMachineLocally: () => true,
        detectMachineRuntimeModels: async () => { throw serverError; },
      });
      const failure = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-models/grok`, {
        headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id },
      });
      assert.equal(failure.status, 200);
      assert.deepEqual(await failure.json(), { kind: "error", retryable: true }, serverError.constructor.name);
    }
    app.app.set("agentOrchestrator", {
      hasMachineLocally: () => true,
      detectMachineRuntimeModels: async () => {
        throw new Error("daemon detect failed");
      },
    });
    sink.clear();
    res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-models/codex`, {
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "X-Server-Id": server.id,
      },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { kind: "error", retryable: true });
    span = sink.getAllSpans().find((candidate) =>
      candidate.name === "server.http.request"
      && candidate.attrs?.route_pattern === "/api/servers/:id/machines/:machineId/runtime-models/:runtime",
    );
    assert.ok(span, "expected failed runtime-models root span");
    const failedEvent = span.events.find((event) => event.name === "runtime_models.detect.failed");
    assert.ok(failedEvent);
    assert.equal(failedEvent.attrs?.runtime, "codex");
    assert.equal(failedEvent.attrs?.daemon_version, "0.44.0");
    assert.equal(failedEvent.attrs?.daemon_version_present, true);
    assert.equal("daemon_version_reason" in (failedEvent.attrs ?? {}), false);
    assert.equal(failedEvent.attrs?.error_class, "Error");
    assert.equal(Object.values(failedEvent.attrs ?? {}).includes(machine.id), false);

    await db.update(machines).set({ daemonVersion: null }).where(eq(machines.id, machine.id));
    sink.clear();
    res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/runtime-models/codex`, {
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "X-Server-Id": server.id,
      },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { kind: "error", retryable: true });
    span = sink.getAllSpans().find((candidate) =>
      candidate.name === "server.http.request"
      && candidate.attrs?.route_pattern === "/api/servers/:id/machines/:machineId/runtime-models/:runtime",
    );
    const unknownVersionFailure = span?.events.find((event) => event.name === "runtime_models.detect.failed");
    assert.ok(unknownVersionFailure);
    assert.equal(unknownVersionFailure.attrs?.daemon_version, "unknown");
    assert.equal("daemon_version_present" in (unknownVersionFailure.attrs ?? {}), false);
    assert.equal(span?.attrs?.daemon_version_present, false);
    const unknownVersionFailureRow = span
      ? traceEventRowsForSpan(span, TRACE_EVENT_ROW_TEST_RESOURCE)
        .find((row) => row.event_name === "runtime_models.detect.failed")
      : undefined;
    assert.ok(unknownVersionFailureRow);
    assert.equal(
      unknownVersionFailureRow.route_pattern,
      "/api/servers/:id/machines/:machineId/runtime-models/:runtime",
    );
    assert.equal(unknownVersionFailureRow.caller_kind, "human");
    assert.equal(unknownVersionFailure.attrs?.daemon_version_reason, "version_unknown_no_handshake");
});

// ---------------------------------------------------------------------------
// POST /api/servers/:id/machines/:machineId/computer/:action
// Remote restart/upgrade relay for managed Computers. Every supported 0.72.x
// runner enters either native 0.72.9+ control or the historical Upgrade ingress.
// The version rule is a lower bound: unknown higher versions remain forward-compatible.
// ---------------------------------------------------------------------------

/** Insert a `computers` row linking a Computer to its presenting machine. */
async function linkComputer(serverId: string, machineId: string) {
  await getDb().insert(computers).values({
    serverId,
    machineId,
    name: "test-computer",
    apiKeyHash: "unused-computer-control-hash",
    apiKeyPrefix: "sk_computer_test",
  });
}

async function computerLifecycleRowCounts(machineId: string) {
  const operations = await getDb().select({ id: computerLifecycleOperations.id }).from(computerLifecycleOperations)
    .where(eq(computerLifecycleOperations.machineId, machineId));
  const dispatches = await getDb().select({ id: computerLifecycleDispatches.id }).from(computerLifecycleDispatches)
    .where(eq(computerLifecycleDispatches.machineId, machineId));
  const targets = await getDb().select({ operationId: computerLifecycleOperationTargets.operationId }).from(computerLifecycleOperationTargets)
    .where(eq(computerLifecycleOperationTargets.machineIdAtIntent, machineId));
  return { operations: operations.length, dispatches: dispatches.length, targets: targets.length };
}

test("POST /computer/:action — a removal that commits after the request-level check leaves zero lifecycle rows (task #91)", async ({ app }) => {
    const { owner, admin, server } = await seedRoleFixture("computer-control-removal-wins");
    const [machine] = await getDb().insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "computer-machine",
      apiKeyHash: "unused-computer-control-removal-hash",
    }).returning();
    await linkComputer(server.id, machine.id);
  const adminToken = await tokenForHuman(admin.email);

    let relayCalls = 0;
    app.app.set("agentOrchestrator", {
      hasMachineLocally: () => true,
      hasMachineCapability: () => false,
      getMachineConnectionEpoch: () => "removal-wins-epoch",
      getCurrentTimeMs: () => Date.parse("2026-09-01T01:00:00.000Z"),
      // Seam between the request-level authority check and the fenced admission: the owner removes the admin here.
      getMachineComputerVersion: async () => {
        await removeMember(server.id, admin.id, { reason: "removed", actorUserId: owner.id });
        return "1.0.23";
      },
      sendComputerControl: async () => {
        relayCalls += 1;
        return true;
      },
    });

    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/computer/restart`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "X-Server-Id": server.id },
    });
    assert.equal(res.status, 403, await res.clone().text());
    assert.equal((await res.json() as { error: string }).error, "Not a member of this server");
    assert.deepEqual(await computerLifecycleRowCounts(machine.id), { operations: 0, dispatches: 0, targets: 0 });
    assert.equal(relayCalls, 0, "a removed admin must not trigger a Computer control relay");
});

test("POST /computer-lifecycle-operations — a removal that commits after the request-level check leaves zero lifecycle rows (task #91)", async ({ app }) => {
    const { owner, admin, server } = await seedRoleFixture("computer-lifecycle-removal-wins");
    const [machine] = await getDb().insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "lifecycle-removal-computer",
      apiKeyHash: "unused-lifecycle-removal-hash",
      os: "darwin arm64",
    }).returning();
    await linkComputer(server.id, machine.id);
  const adminToken = await tokenForHuman(admin.email);
    app.app.set("agentOrchestrator", {
      getCurrentTimeMs: () => Date.parse("2026-09-01T01:00:00.000Z"),
      hasMachineLocally: () => true,
      getMachineConnectionEpoch: () => "lifecycle-removal-epoch",
      getMachineComputerVersionFact: async () => ({
        version: "1.0.23",
        observedAt: "2026-09-01T00:59:59.000Z",
        provenance: "owner_connection",
      }),
    });
    // Seam between the request-level authority check and the fenced admission: the owner removes the admin while the
    // Server resolves the upgrade target.
    app.app.set("computerBroadcastPolicyEvaluator", async (input: EvaluateComputerBroadcastPolicyInput) => {
      await removeMember(server.id, admin.id, { reason: "removed", actorUserId: owner.id });
      return testBroadcastPolicyDecision(input, { eligibility: "eligible", reasonCode: "eligible", targetVersion: "1.0.24" });
    });

    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/computer-lifecycle-operations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "X-Server-Id": server.id, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "upgrade", operationId: randomUUID(), parentOperationId: randomUUID() }),
    });
    assert.equal(res.status, 403, await res.clone().text());
    assert.equal((await res.json() as { error: string }).error, "Not a member of this server");
    assert.deepEqual(await computerLifecycleRowCounts(machine.id), { operations: 0, dispatches: 0, targets: 0 });
});

test("POST /computer/:action — member without manageMachines is refused (403, no relay)", async ({ app }) => {
    const { owner, member, server } = await seedRoleFixture("computer-control-role-gate");
    const [machine] = await getDb().insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "computer-machine",
      apiKeyHash: "unused-computer-control-role-hash",
    }).returning();
    await linkComputer(server.id, machine.id);
  const memberToken = await tokenForHuman(member.email);

    let relayCalls = 0;
    app.app.set("agentOrchestrator", {
      hasMachineLocally: () => true,
      getMachineComputerVersion: async () => "0.0.19",
      sendComputerControl: async () => {
        relayCalls += 1;
        return true;
      },
    });

    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/computer/restart`, {
      method: "POST",
      headers: { Authorization: `Bearer ${memberToken}`, "X-Server-Id": server.id },
    });
    assert.equal(res.status, 403);
    assert.equal(relayCalls, 0, "member must not trigger a Computer control relay");
});

test("POST /computer/:action — unknown action is rejected (400 unknown_action)", async ({ app }) => {
    const { owner, server } = await seedRoleFixture("computer-control-bad-action");
    const [machine] = await getDb().insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "computer-machine",
      apiKeyHash: "unused-computer-control-bad-action-hash",
    }).returning();
    await linkComputer(server.id, machine.id);
  const ownerToken = await tokenForHuman(owner.email);
    app.app.set("agentOrchestrator", { hasMachineLocally: () => true, getMachineComputerVersion: async () => "0.0.19", sendComputerControl: async () => true });

    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/computer/frobnicate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id },
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "unknown_action");
});

test("POST /computer/:action — raw daemon (not a Computer) is refused (409 not_a_computer)", async ({ app }) => {
    const { owner, server } = await seedRoleFixture("computer-control-not-computer");
    const [machine] = await getDb().insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "raw-daemon-machine",
      apiKeyHash: "unused-computer-control-not-computer-hash",
    }).returning();
    // No computers link → raw daemon.
  const ownerToken = await tokenForHuman(owner.email);

    let relayCalls = 0;
    app.app.set("agentOrchestrator", {
      hasMachineLocally: () => true,
      getMachineComputerVersion: async () => "0.0.19",
      sendComputerControl: async () => {
        relayCalls += 1;
        return true;
      },
    });

    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/computer/restart`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id },
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, "not_a_computer");
    assert.equal(relayCalls, 0, "a raw daemon must not receive a Computer control relay");
});

test("POST /computer/:action — offline Computer is refused (409 computer_offline, no relay)", async ({ app }) => {
    const { owner, server } = await seedRoleFixture("computer-control-offline");
    const [machine] = await getDb().insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "offline-computer",
      apiKeyHash: "unused-computer-control-offline-hash",
    }).returning();
    await linkComputer(server.id, machine.id);
  const ownerToken = await tokenForHuman(owner.email);

    let relayCalls = 0;
    app.app.set("agentOrchestrator", {
      hasMachineLocally: () => false, // not connected to any replica → offline
      getMachineComputerVersion: async () => null,
      sendComputerControl: async () => {
        relayCalls += 1;
        return true;
      },
    });

    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/computer/restart`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id },
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, "computer_offline");
    assert.equal(relayCalls, 0, "offline Computer must not receive a relay");
});

test("POST /computer/:action — online Computer without a supported reported version is refused", async ({ app }) => {
    const { owner, server } = await seedRoleFixture("computer-control-unsupported");
    const [machine] = await getDb().insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "old-computer",
      apiKeyHash: "unused-computer-control-unsupported-hash",
    }).returning();
    await linkComputer(server.id, machine.id);
  const ownerToken = await tokenForHuman(owner.email);

    let relayCalls = 0;
    app.app.set("agentOrchestrator", {
      hasMachineLocally: () => true, // online…
      getMachineComputerVersion: async () => null, // …but reports no version → no onComputerControl handler
      sendComputerControl: async () => {
        relayCalls += 1;
        return true;
      },
    });

    const missingConsent = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/computer/upgrade`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id },
    });
    assert.equal(missingConsent.status, 400);
    assert.equal((await missingConsent.json() as { code: string }).code, "invalid_target_version");
    assert.equal(relayCalls, 0, "missing exact-version consent must fail before relay");

    // Restart is the only legacy-ledger action left; a Computer that reports
    // no version is refused before any relay (remote upgrade v2 has its own gate).
    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/computer/restart`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id },
    });
    assert.equal(res.status, 409);
    const body = await res.json() as { code: string; error: string };
    assert.equal(body.code, "computer_control_unsupported");
    assert.equal(body.error, "Raft couldn't verify the Computer version. Reconnect the Computer, then try again.");
    assert.equal(relayCalls, 0, "must NOT relay to a Computer that would silently ignore the command");
});

test("POST /computer/:action — future control-capable Computer versions remain forward-compatible", async ({ app }) => {
    const sink = new MemoryTraceSink();
    const tracer = new BasicTracer({
      sink,
      traceIdGenerator: () => "9".repeat(32),
      spanIdGenerator: (() => {
        let next = 1;
        return () => String(next++).padStart(16, "0");
      })(),
    });
    app.app.set("serverTracer", tracer);
    const { owner, server } = await seedRoleFixture("computer-control-success");
    const [machine] = await getDb().insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "live-computer",
      apiKeyHash: "unused-computer-control-success-hash",
    }).returning();
    await linkComputer(server.id, machine.id);
  const ownerToken = await tokenForHuman(owner.email);

    const relayed: Array<"restart" | "upgrade"> = [];
    app.app.set("agentOrchestrator", {
      hasMachineLocally: () => true,
      getMachineComputerVersion: async () => "1.0.0",
      hasMachineCapability: (_machineId: string, capability: string) =>
        capability === COMPUTER_CAPABILITY_SUPERVISOR_MUTATIONS,
      sendComputerControl: async (_machineId: string, action: "restart" | "upgrade") => {
        relayed.push(action);
        return { sent: true, requestId: "test-request-id" };
      },
    });

    sink.clear();
    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/computer/restart`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id },
    });
    assert.equal(res.status, 200);
    // requestId is threaded back so the web can correlate progress/done frames.
    const body = await res.json() as { ok: boolean; action: string; requestId: string; operationId: string };
    assert.equal(body.ok, true);
    assert.equal(body.action, "restart");
    assert.equal(body.requestId, "test-request-id");
    assert.equal(typeof body.operationId, "string");
    assert.deepEqual(relayed, ["restart"]);
    const span = sink.getAllSpans().find((candidate) =>
      candidate.name === "server.http.request"
      && candidate.attrs?.route_pattern === "/api/servers/:id/machines/:machineId/computer/:action"
    );
    assert.ok(span, "expected Computer control route root span");
    const computerControlEvents = span.events
      .filter((event) => event.name.startsWith("computer.control."));
    assert.deepEqual(
      computerControlEvents.map((event) => event.name),
      ["computer.control.requested", "computer.control.sent"],
    );
    assert.equal(computerControlEvents[0]?.attrs?.action, "restart");
    assert.equal(computerControlEvents[0]?.attrs?.server_id, server.id);
    assert.equal(computerControlEvents[0]?.attrs?.machine_id, machine.id);
    assert.equal(computerControlEvents[1]?.attrs?.action, "restart");
    assert.equal(computerControlEvents[1]?.attrs?.server_id, server.id);
    assert.equal(computerControlEvents[1]?.attrs?.machine_id, machine.id);
    assert.equal(computerControlEvents[1]?.attrs?.request_id, "test-request-id");
    assert.equal(computerControlEvents[1]?.attrs?.computer_version, "1.0.0");
});

test("legacy manual upgrade resolves Hands stable (main) without a target and retains auth and operation identity", async ({ app }) => {
  const { owner, admin, member, server } = await seedRoleFixture("legacy-upgrade-hands");
  const [machine] = await getDb().insert(machines).values({
    serverId: server.id, userId: owner.id, name: "legacy-computer", apiKeyHash: "legacy-hands-hash", os: "darwin arm64",
  }).returning();
  await linkComputer(server.id, machine.id);
  const ownerToken = await tokenForHuman(owner.email);
  const memberToken = await tokenForHuman(member.email);
  const adminToken = await tokenForHuman(admin.email);
  app.app.set("agentOrchestrator", {
    getCurrentTimeMs: () => Date.parse("2026-09-10T00:00:00Z"),
    hasMachineLocally: () => true,
    getMachineConnectionEpoch: () => "legacy-hands-epoch",
    getMachineComputerVersionFact: async () => ({ version: "1.0.23", observedAt: null, provenance: "owner_connection" }),
  });
  let requests = 0;
  let available = false;
  let version = "1.0.31";
  app.app.set("computerBroadcastPolicyEvaluator", (input: EvaluateComputerBroadcastPolicyInput) =>
    evaluateBroadcastPolicy(input, { fetchFn: async (url) => {
      requests += 1;
      assert.equal(new URL(String(url)).searchParams.get("channel"), "main");
      if (!available) return new Response("unavailable", { status: 503 });
      return Response.json({
        app: { slug: "raft-computer-cli", platform: "node" }, channel: "main",
        build: { id: "build-31", version }, scoped: { release_id: "release-31" },
        assets: [{ platform: "darwin", arch: "arm64", variant: null, filetype: "binary",
          sha256: "a".repeat(64), size_bytes: 100, download_url: "https://hands.build/artifact" }],
      });
    } }));
  const operationId = randomUUID();
  const body = { action: "upgrade", operationId, parentOperationId: randomUUID(), channel: "main" };
  const send = (token: string, override: Record<string, string> = {}) => fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/computer-lifecycle-operations`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "X-Server-Id": server.id, "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, ...override }),
  });
  assert.equal((await send(memberToken)).status, 403);
  assert.equal(requests, 0, "unauthorized callers must not reach release resolution");
  assert.equal((await send(ownerToken)).status, 503);
  assert.equal((await getDb().select().from(computerLifecycleOperations).where(eq(computerLifecycleOperations.id, operationId))).length, 0);
  available = true;
  const result = await send(ownerToken);
  assert.equal(result.status, 201);
  const responseBody = await result.json() as { operationId: string; targetVersion: string };
  assert.equal(responseBody.operationId, operationId);
  assert.equal(responseBody.targetVersion, "1.0.31");
  const [stored] = await getDb().select().from(computerLifecycleOperations).where(eq(computerLifecycleOperations.id, operationId));
  assert.equal(stored?.targetVersion, "1.0.31");
  assert.equal(stored?.dispatchMode, "local");
  assert.equal(stored?.connectionEpochBefore, "legacy-hands-epoch");
  const requestsBeforeReplay = requests;
  available = false;
  const outageReplay = await send(ownerToken);
  assert.equal(outageReplay.status, 201, "recorded operation replays while Hands is unavailable");
  assert.equal((await outageReplay.json() as { targetVersion: string }).targetVersion, "1.0.31");
  available = true;
  version = "1.0.32";
  const changedAlphaReplay = await send(ownerToken);
  assert.equal(changedAlphaReplay.status, 201, "new alpha must not change an existing operation");
  assert.equal((await changedAlphaReplay.json() as { targetVersion: string }).targetVersion, "1.0.31");
  assert.equal((await send(ownerToken, { parentOperationId: randomUUID() })).status, 409, "different parent is not a replay");
  assert.equal((await send(adminToken)).status, 409, "another authorized actor cannot adopt the operation");
  assert.equal((await send(ownerToken, { action: "restart" })).status, 409, "different action is not a replay");
  assert.equal((await send(ownerToken, { operationId: randomUUID(), targetVersion: "1.0.31" })).status, 409,
    "another operation ID cannot alias a pending operation");
  assert.equal((await send(ownerToken, { parentOperationId: randomUUID(), targetVersion: "1.0.31" })).status, 409,
    "explicit-target requests must preserve parent identity too");
  assert.equal(requests, requestsBeforeReplay, "replay and identity conflicts do not consult Hands");
  assert.equal((await getDb().select().from(computerLifecycleOperations).where(eq(computerLifecycleOperations.id, operationId))).length, 1);
});

test("POST /computer-lifecycle-operations records an explicit operator-authorized upgrade without broadcast admission", async ({ app }) => {
    const { owner, admin, member, server } = await seedRoleFixture("computer-local-upgrade-authority");
    const [machine] = await getDb().insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "local-hands-upgrade-computer",
      apiKeyHash: "unused-local-hands-upgrade-hash",
      os: "darwin arm64",
    }).returning();
    await linkComputer(server.id, machine.id);
  const ownerToken = await tokenForHuman(owner.email);
  const adminToken = await tokenForHuman(admin.email);
  const memberToken = await tokenForHuman(member.email);
    let machineLocal = false;
    let broadcastPolicyCalls = 0;
    app.app.set("agentOrchestrator", {
      getCurrentTimeMs: () => Date.parse("2026-09-01T01:00:00.000Z"),
      hasMachineLocally: () => machineLocal,
      getMachineConnectionEpoch: () => "local-upgrade-epoch",
      getMachineComputerVersionFact: async () => ({
        version: "1.0.23",
        observedAt: "2026-09-01T00:59:59.000Z",
        provenance: "owner_connection",
      }),
    });
    app.app.set("computerBroadcastPolicyEvaluator", (input: EvaluateComputerBroadcastPolicyInput) => {
      broadcastPolicyCalls += 1;
      return testBroadcastPolicyDecision(input, {
        reasonCode: "policy_expired",
      });
    });

    const endpoint = (machineId: string) =>
      `${app.baseUrl}/api/servers/${server.id}/machines/${machineId}/computer-lifecycle-operations`;
    const send = (
      token: string,
      machineId: string,
      body: Record<string, unknown>,
    ) => fetch(endpoint(machineId), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Server-Id": server.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const operationId = randomUUID();
    const parentOperationId = randomUUID();
    const validBody = {
      action: "upgrade",
      operationId,
      parentOperationId,
      targetVersion: "1.0.24",
      // These untrusted fields must not select or alter provenance.
      dispatchMode: "server",
      broadcastPolicyDecision: { eligibility: "eligible" },
    };

    let response = await send(ownerToken, machine.id, {
      ...validBody,
      operationId: randomUUID(),
      targetVersion: "1.0.24.0",
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { code: string }).code, "invalid_target_version");

    response = await send(ownerToken, randomUUID(), {
      ...validBody,
      operationId: randomUUID(),
    });
    assert.equal(response.status, 404);

    response = await send(memberToken, machine.id, {
      ...validBody,
      operationId: randomUUID(),
    });
    assert.equal(response.status, 403);

    response = await send(ownerToken, machine.id, {
      ...validBody,
      operationId: randomUUID(),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { code: string }).code, "computer_offline");

    machineLocal = true;
    // `local` is the lifecycle dispatch class for an explicit per-machine
    // operator action, not a network-location claim. An admin who did not
    // create this machine may deliberately bypass broadcast rollout policy by
    // exercising `controlComputers`; an ordinary member still cannot.
    response = await send(adminToken, machine.id, validBody);

    assert.equal(response.status, 201);
    assert.equal(broadcastPolicyCalls, 0, "explicit manual upgrades must not consult rollout policy");
    const body = await response.json() as { operationId: string; action: string };
    assert.equal(body.operationId, operationId);
    assert.equal(body.action, "upgrade");
    const [stored] = await getDb().select().from(computerLifecycleOperations).where(eq(
      computerLifecycleOperations.id,
      operationId,
    ));
    assert.equal(stored?.dispatchMode, "local");
    assert.equal(stored?.targetVersion, "1.0.24");
    assert.equal(stored?.broadcastPolicyDecision, null);
    assert.equal(stored?.connectionEpochBefore, "local-upgrade-epoch");
});

test("POST /computer-lifecycle-operations derives local start/stop authority from the user and connection epoch", async ({ app }) => {
    const { owner, server } = await seedRoleFixture("computer-local-lifecycle");
    const [machine] = await getDb().insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "local-computer",
      apiKeyHash: "unused-local-lifecycle-hash",
    }).returning();
    await linkComputer(server.id, machine!.id);
  const ownerToken = await tokenForHuman(owner.email);
    let epoch: string | null = null;
    let machineLocal = false;
    let epochReads = 0;
    let liveVersion = "0.72.5";
    let liveProvenance: "owner_connection" | "replica_meta" = "owner_connection";
    let liveSourceVisible = true;
    const liveObservedAt = new Date().toISOString();
    app.app.set("agentOrchestrator", {
      getCurrentTimeMs: () => Date.parse("2026-07-24T05:00:00.000Z"),
      hasMachineLocally: () => machineLocal,
      getMachineConnectionEpoch: () => {
        epochReads += 1;
        return epoch;
      },
      getMachineComputerVersionFact: async () => liveSourceVisible
        ? {
            version: liveVersion,
            observedAt: liveObservedAt,
            provenance: liveProvenance,
          }
        : null,
    });
    const parentOperationId = randomUUID();
    const startOperationId = randomUUID();
    const endpoint = `${app.baseUrl}/api/servers/${server.id}/machines/${machine!.id}/computer-lifecycle-operations`;
    const send = (body: Record<string, unknown>) => fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "X-Server-Id": server.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    let response = await send({ action: "start", operationId: startOperationId, parentOperationId });
    assert.equal(response.status, 201);
    assert.equal(epochReads, 0, "owner-missing start must not consult this replica's connection epoch");
    // Same canonical child is an idempotent replay, not a second operation.
    response = await send({ action: "start", operationId: startOperationId, parentOperationId });
    assert.equal(response.status, 201);

    machineLocal = true;
    epoch = "epoch-before-stop";
    const stopOperationId = randomUUID();
    response = await send({ action: "stop", operationId: stopOperationId, parentOperationId });
    assert.equal(response.status, 201);
    const restartOperationId = randomUUID();
    response = await send({ action: "restart", operationId: restartOperationId, parentOperationId });
    assert.equal(response.status, 201);
    const upgradeOperationId = randomUUID();
    response = await send({
      action: "upgrade",
      operationId: upgradeOperationId,
      parentOperationId,
      targetVersion: "0.72.6",
    });
    assert.equal(response.status, 201);
    liveVersion = "0.72.6";
    response = await send({
      action: "upgrade",
      operationId: upgradeOperationId,
      parentOperationId,
      targetVersion: "0.72.6",
      completionMode: "legacy_k_promoted",
    });
    assert.equal(response.status, 409, "an ordinary upgrade id cannot be replayed as a legacy completion");
    await getDb().update(computerLifecycleOperations).set({
      status: "completed",
      terminalAt: new Date(),
    }).where(eq(computerLifecycleOperations.id, upgradeOperationId));

    liveVersion = "0.72.5";
    const completionOperationId = randomUUID();
    const completionParentOperationId = randomUUID();
    const completionBody = {
      action: "upgrade",
      operationId: completionOperationId,
      parentOperationId: completionParentOperationId,
      targetVersion: liveVersion,
      completionMode: "legacy_k_promoted",
    };
    liveSourceVisible = false;
    response = await send(completionBody);
    assert.equal(response.status, 409, "a connected socket may race ahead of its ready attestation");
    assert.equal(
      (await response.json() as { code?: string }).code,
      "computer_lifecycle_completion_ready_pending",
    );
    liveSourceVisible = true;
    response = await send(completionBody);
    assert.equal(response.status, 201);
    response = await send(completionBody);
    assert.equal(response.status, 201, "same generation exact completion replay is idempotent");

    epoch = "replacement-generation";
    response = await send(completionBody);
    assert.equal(response.status, 409, "a replacement replica generation cannot replay the old completion identity");

    response = await send({
      ...completionBody,
      operationId: randomUUID(),
      targetVersion: "0.72.4",
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { code?: string }).code, "computer_lifecycle_completion_target_mismatch");
    liveProvenance = "replica_meta";
    response = await send({
      ...completionBody,
      operationId: randomUUID(),
    });
    assert.equal(response.status, 409, "a stale replica-meta version is not a live completion attestation");
    assert.equal((await response.json() as { code?: string }).code, "computer_lifecycle_completion_target_mismatch");
    liveProvenance = "owner_connection";
    machineLocal = false;
    response = await send({
      ...completionBody,
      operationId: randomUUID(),
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { code?: string }).code, "computer_offline");
    machineLocal = true;
    epoch = "epoch-before-stop";
    const rows = await getDb().select().from(computerLifecycleOperations).where(eq(
      computerLifecycleOperations.serverId,
      server.id,
    ));
    assert.equal(rows.length, 5);
    assert.deepEqual(rows.map((row) => row.action).sort(), ["restart", "start", "stop", "upgrade", "upgrade"]);
    assert.ok(rows.every((row) => row.actorUserId === owner.id && row.cause === "user_action"));
    assert.equal(rows.find((row) => row.id === stopOperationId)?.connectionEpochBefore, "epoch-before-stop");
    assert.equal(rows.find((row) => row.id === upgradeOperationId)?.targetVersion, "0.72.6");
    assert.deepEqual(
      rows.find((row) => row.id === completionOperationId)?.broadcastPolicyDecision,
      {
        completionMode: "legacy_k_promoted",
        connectionEpoch: "epoch-before-stop",
        sourceVersion: "0.72.5",
        sourceObservedAt: rows.find((row) => row.id === completionOperationId)?.broadcastPolicyDecision
          && (rows.find((row) => row.id === completionOperationId)?.broadcastPolicyDecision as {
            sourceObservedAt: string;
          }).sourceObservedAt,
        sourceProvenance: "owner_connection",
      },
    );
    assert.equal(rows.find((row) => row.id === upgradeOperationId)?.broadcastPolicyDecision, null);
});

// Provenance: task #69 (@cindyz, #wg-rbac). An email invite could only ever
// produce a member, so there was no way to bring a Guest into a server at all —
// role could only be changed after they were already inside.
test("an email invite carries the member role, and Guest is refused rather than downgraded, with the old gate off or on", async ({ app }) => {
  const db = getDb();
  const { owner, server } = await seedRoleFixture("invite-with-role");
  const ownerToken = await tokenForHuman(owner.email);

  const invite = (email: string, body: Record<string, unknown>) => fetch(`${app.baseUrl}/api/servers/${server.id}/invites`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      "X-Server-Id": server.id,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, ...body }),
  });

  // Default is unchanged: omitting role still yields a member invite.
  const defaulted = await invite(`invite-default-${randomUUID()}@slock.test`, {});
  assert.equal(defaulted.status, 200);
  assert.equal((await defaulted.json()).role, "member", "omitting role must keep the existing behaviour");

  // A bad role is rejected outright rather than coerced.
  const bogus = await invite(`invite-bogus-${randomUUID()}@slock.test`, { role: "owner" });
  assert.equal(bogus.status, 400, "admin/owner must not be reachable by email invite");
  assert.deepEqual(await bogus.json(), { error: "role must be one of: member, guest" });

  // A Guest is invited to a channel, not to the server (#wg-rbac:#15), with the
  // old server_guest_v0 gate off or on. The inviter must not receive a member
  // invite after asking for a Guest one: that would hand out more access than
  // they chose, silently. So assert the absence of the row, not just the shape
  // of the response (raised by @Ark, #proj-frontend).
  for (const gateOn of [false, true]) {
    if (gateOn) {
      await db.insert(featureFlagRules).values({
        id: randomUUID(), flagKey: SERVER_GUEST_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [server.id],
      });
    }
    const guestEmail = `invite-guest-${gateOn ? "on" : "off"}-${randomUUID()}@slock.test`;
    const refused = await invite(guestEmail, { role: "guest" });
    assert.equal(refused.status, 400, `gate ${gateOn ? "on" : "off"}`);
    assert.deepEqual(await refused.json(), { error: "Guests are invited to one channel, not to the server" });
    const leaked = await db.select({ id: serverInvites.id }).from(serverInvites)
      .where(eq(serverInvites.invitedEmail, guestEmail));
    assert.equal(leaked.length, 0, "a refused Guest invite must not leave an invite row behind");
  }
});

test("an upgrade lifecycle operation resolves its target from Hands with no upgrade flag set", async ({ app }) => {
  // remote_computer_upgrade_v2 is retired: with no flag created, the real
  // policy (no evaluator gate injected) admits the upgrade.
  const { owner, server } = await seedRoleFixture("computer-upgrade-gate-closed");
  const [machine] = await getDb().insert(machines).values({
    serverId: server.id, userId: owner.id, name: "gated-computer",
    apiKeyHash: "gated-computer-hash", os: "darwin arm64",
  }).returning();
  await linkComputer(server.id, machine.id);
  const ownerToken = await tokenForHuman(owner.email);
  app.app.set("agentOrchestrator", {
    getCurrentTimeMs: () => Date.parse("2026-09-10T00:00:00Z"),
    hasMachineLocally: () => true,
    getMachineConnectionEpoch: () => "gated-epoch",
    getMachineComputerVersionFact: async () => ({ version: "1.0.23", observedAt: null, provenance: "owner_connection" }),
  });
  let handsRequests = 0;
  app.app.set("computerBroadcastPolicyEvaluator", (input: EvaluateComputerBroadcastPolicyInput) =>
    evaluateBroadcastPolicy(input, { fetchFn: async () => {
      handsRequests += 1;
      return Response.json({
        app: { slug: "raft-computer-cli", platform: "node" }, channel: "main",
        build: { id: "build-31", version: "1.0.31" }, scoped: { release_id: "release-31" },
        assets: [{ platform: "darwin", arch: "arm64", variant: null, filetype: "binary",
          sha256: "a".repeat(64), size_bytes: 100, download_url: "https://hands.build/artifact" }],
      });
    } }));

  const allowed = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/computer-lifecycle-operations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "upgrade", operationId: randomUUID(), parentOperationId: randomUUID(), channel: "main" }),
  });
  assert.equal(allowed.status, 201, await allowed.clone().text());
  assert.equal((await allowed.json() as { targetVersion: string }).targetVersion, "1.0.31");
  assert.ok(handsRequests > 0, "the target comes from Hands");
});

test("with no upgrade flag set the machine-list projection is eligible and the v2 upgrade route sends", async ({ app }) => {
  // remote_computer_upgrade_v2 is retired. This drives the REAL flag
  // evaluation (no evaluator stub, no gate injection) with no upgrade flag
  // created: the projection is eligible and the route sends.
  const originalFetch = globalThis.fetch;
  __resetLatestComputerVersionForTest();
  try {
    const { owner, server } = await seedRoleFixture("remote-upgrade-v2-single-gate");
    const [machine] = await getDb().insert(machines).values({
      serverId: server.id, userId: owner.id, name: "v2-gated-computer",
      apiKeyHash: "v2-gated-computer-hash", os: "darwin arm64",
    }).returning();
    await linkComputer(server.id, machine.id);
    const ownerToken = await tokenForHuman(owner.email);
    const sent: Array<{ machineId: string; targetVersion: string; requestId: string }> = [];
    app.app.set("agentOrchestrator", {
      // Reconciler step 13: this fake Computer does not advertise drain.
      computerUpgradeDrainMs: async () => null,
      getComputerUpgradeDrain: () => null,
      getCurrentTimeMs: () => Date.parse("2026-09-10T00:00:00Z"),
      getMachineStatus: async () => "online",
      getMachineStatusVersion: async () => 1,
      getMachineDaemonVersion: () => null,
      hasMachineLocally: () => true,
      // Every capability but the negative "cannot reach its service" fact.
      hasMachineCapability: (_machineId: string, capability: string) => capability !== COMPUTER_CAPABILITY_SERVICE_IPC_UNREACHABLE,
      getMachineConnectionEpoch: () => "v2-gated-epoch",
      getMachineComputerVersionFact: async () => ({
        version: "1.0.46", observedAt: new Date().toISOString(), provenance: "owner_connection",
      }),
      sendComputerControl: async () => {
        throw new Error("the v2 upgrade route must not use the legacy control relay");
      },
      sendComputerUpgrade: async (machineId: string, targetVersion: string, requestId: string) => {
        if (!deliver) return { sent: false };
        sent.push({ machineId, targetVersion, requestId });
        return { sent: true };
      },
    });
    let deliver = true;
    let handsRequests = 0;
    app.app.set("computerBroadcastPolicyEvaluator", (input: EvaluateComputerBroadcastPolicyInput) =>
      evaluateBroadcastPolicy(input, { fetchFn: async () => {
        handsRequests += 1;
        return Response.json({
          app: { slug: "raft-computer-cli", platform: "node" }, channel: "main",
          build: { id: "build-47", version: "1.0.47" }, scoped: { release_id: "release-47" },
          assets: [{ platform: "darwin", arch: "arm64", variant: null, filetype: "binary",
            sha256: "a".repeat(64), size_bytes: 100, download_url: "https://hands.build/artifact" }],
        });
      } }));
    // The machine list also asks Hands for the latest CDN version; keep that
    // off the network. It does not feed the broadcast policy.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://hands.build/")) return new Response("unavailable", { status: 503 });
      return originalFetch(input, init);
    }) as typeof fetch;

    const listPolicy = async () => {
      const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines`, {
        headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id },
      });
      assert.equal(res.status, 200);
      const body = await res.json() as {
        machines: Array<{ id: string; computerBroadcastPolicy: { eligibility: string; reasonCode: string; targetVersion: string | null } | null }>;
      };
      return body.machines.find((candidate) => candidate.id === machine.id)?.computerBroadcastPolicy;
    };
    const upgrade = () => fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/computer/upgrade`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id, "Content-Type": "application/json" },
      body: JSON.stringify({ targetVersion: "1.0.47" }),
    });

    const openPolicy = await listPolicy();
    assert.equal(openPolicy?.eligibility, "eligible");
    assert.equal(openPolicy?.reasonCode, "eligible");
    assert.equal(openPolicy?.targetVersion, "1.0.47");
    // The command cannot be delivered (machine dropped between the route's
    // check and the send): the request is settled on the spot, so the next
    // click creates a fresh request and really sends it instead of getting the
    // stuck row back (`created: false`, nothing sent) until the deadline.
    deliver = false;
    const undelivered = await upgrade();
    assert.equal(undelivered.status, 409, await undelivered.clone().text());
    assert.equal(((await undelivered.json()) as { code: string }).code, "computer_offline");
    assert.equal(await getOpenComputerUpgradeRequest(machine.id), null, "no open request is left behind");
    const [undeliveredRow] = await getDb().select().from(computerUpgradeRequests).where(eq(computerUpgradeRequests.machineId, machine.id));
    assert.equal(undeliveredRow?.outcome, "failed");
    assert.equal(undeliveredRow?.reason, "command_not_delivered");
    deliver = true;
    const openUpgrade = await upgrade();
    assert.equal(openUpgrade.status, 201, await openUpgrade.clone().text());
    const openBody = await openUpgrade.json() as { upgradeRequest: { id: string; targetVersion: string } };
    assert.equal(openBody.upgradeRequest.targetVersion, "1.0.47");
    assert.deepEqual(sent, [{ machineId: machine.id, targetVersion: "1.0.47", requestId: openBody.upgradeRequest.id }]);
  } finally {
    globalThis.fetch = originalFetch;
    __resetLatestComputerVersionForTest();
  }
});

test("a Computer bundled in Raft Desktop is never offered or sent a web upgrade", async ({ app }) => {
  // 10-30: a Desktop Computer (ready.installKind "electron") on 1.0.57 was
  // offered the web upgrade; both clicks failed in the standalone installer,
  // which cannot replace Desktop's bundled Computer. Desktop updates it itself.
  const originalFetch = globalThis.fetch;
  __resetLatestComputerVersionForTest();
  try {
    const { owner, server } = await seedRoleFixture("desktop-managed-computer");
    const inserted = await getDb().insert(machines).values(([
      ["desktop", "electron"], ["standalone", "sea"], ["node", "node"], ["older", null],
    ] as const).map(([name, installKind]) => ({
      serverId: server.id, userId: owner.id, name: `${name}-computer`,
      apiKeyHash: `${name}-computer-hash`, os: "darwin arm64", installKind,
    }))).returning();
    const [desktop, standalone, nodeInstall, older] = inserted as [typeof inserted[number], typeof inserted[number], typeof inserted[number], typeof inserted[number]];
    for (const machine of inserted) await linkComputer(server.id, machine.id);
    const ownerToken = await tokenForHuman(owner.email);
    const sent: string[] = [];
    app.app.set("agentOrchestrator", {
      // Reconciler step 13: this fake Computer does not advertise drain.
      computerUpgradeDrainMs: async () => null,
      getComputerUpgradeDrain: () => null,
      getCurrentTimeMs: () => Date.parse("2026-10-30T00:00:00Z"),
      getMachineStatus: async () => "online",
      getMachineStatusVersion: async () => 1,
      getMachineDaemonVersion: () => null,
      hasMachineLocally: () => true,
      hasMachineCapability: (_machineId: string, capability: string) => capability !== COMPUTER_CAPABILITY_SERVICE_IPC_UNREACHABLE,
      getMachineConnectionEpoch: () => "desktop-managed-epoch",
      getMachineComputerVersionFact: async () => ({
        version: "1.0.57", observedAt: new Date().toISOString(), provenance: "owner_connection",
      }),
      sendComputerControl: async () => {
        throw new Error("the v2 upgrade route must not use the legacy control relay");
      },
      sendComputerUpgrade: async (machineId: string) => {
        sent.push(machineId);
        return { sent: true };
      },
    });
    app.app.set("computerBroadcastPolicyEvaluator", (input: EvaluateComputerBroadcastPolicyInput) =>
      evaluateBroadcastPolicy(input, { fetchFn: async () => Response.json({
        app: { slug: "raft-computer-cli", platform: "node" }, channel: "main",
        build: { id: "build-59", version: "1.0.59" }, scoped: { release_id: "release-59" },
        assets: [{ platform: "darwin", arch: "arm64", variant: null, filetype: "binary",
          sha256: "a".repeat(64), size_bytes: 100, download_url: "https://hands.build/artifact" }],
      }) }));
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://hands.build/")) return new Response("unavailable", { status: 503 });
      return originalFetch(input, init);
    }) as typeof fetch;

    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines`, {
      headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      machines: Array<Record<string, unknown> & {
        id: string;
        computerUpgradeAvailable: boolean | null;
        computerBroadcastPolicy: { eligibility: string; reasonCode: string; targetVersion: string | null } | null;
      }>;
    };
    const row = (id: string) => body.machines.find((machine) => machine.id === id)!;
    assert.equal(row(desktop.id).computerUpgradeAvailable, false);
    assert.equal(row(desktop.id).computerBroadcastPolicy?.eligibility, "no_broadcast");
    assert.equal(row(desktop.id).computerBroadcastPolicy?.reasonCode, "managed_by_desktop");
    for (const machine of [standalone, nodeInstall, older]) {
      assert.equal(row(machine.id).computerUpgradeAvailable, true, machine.name);
      assert.equal(row(machine.id).computerBroadcastPolicy?.reasonCode, "eligible", machine.name);
    }
    // The install kind is a policy input, not a projected field.
    assert.ok(body.machines.every((machine) => !("installKind" in machine)));

    const upgrade = (machineId: string) => fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machineId}/computer/upgrade`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id, "Content-Type": "application/json" },
      body: JSON.stringify({ targetVersion: "1.0.59" }),
    });
    const refused = await upgrade(desktop.id);
    assert.equal(refused.status, 409);
    const refusedBody = await refused.json() as { code: string; policy: { reasonCode: string } };
    assert.equal(refusedBody.code, "computer_managed_by_desktop");
    assert.equal(refusedBody.policy.reasonCode, "managed_by_desktop");
    assert.deepEqual(sent, [], "nothing reaches the installer");
    assert.equal(
      (await getDb().select().from(computerUpgradeRequests).where(eq(computerUpgradeRequests.machineId, desktop.id))).length,
      0,
      "no upgrade request is recorded",
    );

    const accepted = await upgrade(standalone.id);
    assert.equal(accepted.status, 201, await accepted.clone().text());
    assert.deepEqual(sent, [standalone.id]);
  } finally {
    globalThis.fetch = originalFetch;
    __resetLatestComputerVersionForTest();
  }
});

test("a per-platform upgrade pause hides Upgrade and refuses the request for that OS only", async ({ app }) => {
  // remote_computer_upgrade_hold_<os> is the operator's pause for one OS
  // (docs/operations/computer-release-sop.md#pausing-web-upgrades). Real flag
  // evaluation: only Hands is stubbed.
  const originalFetch = globalThis.fetch;
  __resetLatestComputerVersionForTest();
  try {
    const { owner, server } = await seedRoleFixture("computer-upgrade-platform-pause");
    const inserted = await getDb().insert(machines).values(([
      ["windows", "win32 x64"], ["mac", "darwin arm64"], ["unknown-os", null],
    ] as const).map(([name, os]) => ({
      serverId: server.id, userId: owner.id, name: `${name}-computer`,
      apiKeyHash: `${name}-pause-computer-hash`, os,
    }))).returning();
    const [windows, mac, unknownOs] = inserted as [typeof inserted[number], typeof inserted[number], typeof inserted[number]];
    for (const machine of inserted) await linkComputer(server.id, machine.id);
    const ownerToken = await tokenForHuman(owner.email);
    const sent: string[] = [];
    app.app.set("agentOrchestrator", {
      computerUpgradeDrainMs: async () => null,
      getComputerUpgradeDrain: () => null,
      getCurrentTimeMs: () => Date.parse("2026-11-11T00:00:00Z"),
      getMachineStatus: async () => "online",
      getMachineStatusVersion: async () => 1,
      getMachineDaemonVersion: () => null,
      hasMachineLocally: () => true,
      hasMachineCapability: (_machineId: string, capability: string) => capability !== COMPUTER_CAPABILITY_SERVICE_IPC_UNREACHABLE,
      getMachineConnectionEpoch: () => "platform-pause-epoch",
      getMachineComputerVersionFact: async () => ({
        version: "1.0.57", observedAt: new Date().toISOString(), provenance: "owner_connection",
      }),
      sendComputerControl: async () => {
        throw new Error("the v2 upgrade route must not use the legacy control relay");
      },
      sendComputerUpgrade: async (machineId: string) => {
        sent.push(machineId);
        return { sent: true };
      },
    });
    let handsRequests = 0;
    const asset = (platform: string, arch: string) => ({ platform, arch, variant: null, filetype: "binary",
      sha256: "a".repeat(64), size_bytes: 100, download_url: "https://hands.build/artifact" });
    app.app.set("computerBroadcastPolicyEvaluator", (input: EvaluateComputerBroadcastPolicyInput) =>
      evaluateBroadcastPolicy(input, { fetchFn: async () => {
        handsRequests += 1;
        return Response.json({
          app: { slug: "raft-computer-cli", platform: "node" }, channel: "main",
          build: { id: "build-59", version: "1.0.59" }, scoped: { release_id: "release-59" },
          assets: [asset("darwin", "arm64"), asset("win32", "x64")],
        });
      } }));
    // The machine list's own latest-version lookup stays off the network.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://hands.build/")) return new Response("unavailable", { status: 503 });
      return originalFetch(input, init);
    }) as typeof fetch;

    const list = async () => {
      const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines`, {
        headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id },
      });
      assert.equal(res.status, 200);
      const body = await res.json() as {
        machines: Array<{ id: string; computerUpgradeAvailable: boolean | null; computerBroadcastPolicy: { reasonCode: string } | null }>;
      };
      return (id: string) => {
        const row = body.machines.find((machine) => machine.id === id);
        assert.ok(row);
        return { available: row.computerUpgradeAvailable, reason: row.computerBroadcastPolicy?.reasonCode };
      };
    };
    const upgrade = (machineId: string) => fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machineId}/computer/upgrade`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id, "Content-Type": "application/json" },
      body: JSON.stringify({ targetVersion: "1.0.59" }),
    });

    // No pause flag at all: nothing changes.
    const before = await list();
    assert.deepEqual(before(windows.id), { available: true, reason: "eligible" });
    assert.deepEqual(before(mac.id), { available: true, reason: "eligible" });
    assert.deepEqual(before(unknownOs.id), { available: false, reason: "platform_unknown" });

    // An operator pauses Windows for this server.
    const holdKey = REMOTE_COMPUTER_UPGRADE_PLATFORM_HOLD_FEATURE_FLAG_KEYS.windows;
    await getDb().insert(featureFlags).values({
      key: holdKey, description: "test windows upgrade pause", enabled: true, killSwitch: false,
      randomizationUnit: "server", defaultEnabled: false, salt: "platform-pause-api-test",
    });
    const ruleId = randomUUID();
    await getDb().insert(featureFlagRules).values({
      id: ruleId, flagKey: holdKey, stage: "server", priority: 0, decision: "allow", values: [server.id],
    });
    const paused = await list();
    assert.deepEqual(paused(windows.id), { available: false, reason: "platform_held" });
    assert.deepEqual(paused(mac.id), { available: true, reason: "eligible" });
    assert.deepEqual(paused(unknownOs.id), { available: false, reason: "platform_unknown" });

    const handsBeforeRefusal = handsRequests;
    const refused = await upgrade(windows.id);
    assert.equal(refused.status, 409);
    const refusedBody = await refused.json() as { code: string; error: string };
    assert.equal(refusedBody.code, "COMPUTER_UPGRADE_PAUSED_FOR_PLATFORM");
    assert.equal(
      refusedBody.error,
      "Upgrades for this operating system are paused while we investigate a problem. Your Computer keeps working on its current version.",
    );
    assert.equal(handsRequests, handsBeforeRefusal, "a paused platform does not reach Hands");
    assert.equal(
      (await getDb().select().from(computerUpgradeRequests).where(eq(computerUpgradeRequests.machineId, windows.id))).length,
      0,
      "no upgrade request is recorded",
    );

    // Unknown platform is not paused: it keeps its own (unchanged) refusal.
    const unknownRefused = await upgrade(unknownOs.id);
    assert.equal(unknownRefused.status, 409);
    assert.equal((await unknownRefused.json() as { code: string }).code, "computer_broadcast_not_eligible");

    // Other platforms are unaffected.
    const macAccepted = await upgrade(mac.id);
    assert.equal(macAccepted.status, 201, await macAccepted.clone().text());
    assert.deepEqual(sent, [mac.id]);

    // Lifting the pause (no deploy) offers Windows again.
    await getDb().delete(featureFlagRules).where(eq(featureFlagRules.id, ruleId));
    assert.deepEqual((await list())(windows.id), { available: true, reason: "eligible" });
    const windowsAccepted = await upgrade(windows.id);
    assert.equal(windowsAccepted.status, 201, await windowsAccepted.clone().text());
    assert.deepEqual(sent, [mac.id, windows.id]);
  } finally {
    globalThis.fetch = originalFetch;
    __resetLatestComputerVersionForTest();
  }
});

test("a Computer reporting an installer repair hint gets it on the machine list and can still be upgraded from the web", async ({ app }) => {
  // #proj-raft-computer task #34: advisory only. The web recommends the
  // install command, but eligibility and the upgrade route are unchanged, so a
  // wrong hint can never lock a machine out of the installer.
  const originalFetch = globalThis.fetch;
  __resetLatestComputerVersionForTest();
  try {
    const { owner, server } = await seedRoleFixture("installer-repair-hint-computer");
    const inserted = await getDb().insert(machines).values((["hinted", "healthy"] as const).map((name) => ({
      serverId: server.id, userId: owner.id, name: `${name}-computer`,
      apiKeyHash: `${name}-computer-hash`, os: "darwin arm64", installKind: "sea",
    }))).returning();
    const [hinted, healthy] = inserted as [typeof inserted[number], typeof inserted[number]];
    for (const machine of inserted) await linkComputer(server.id, machine.id);
    const ownerToken = await tokenForHuman(owner.email);
    const sent: string[] = [];
    app.app.set("agentOrchestrator", {
      // Reconciler step 13: this fake Computer does not advertise drain.
      computerUpgradeDrainMs: async () => null,
      getComputerUpgradeDrain: () => null,
      getCurrentTimeMs: () => Date.parse("2026-11-03T00:00:00Z"),
      getMachineStatus: async () => "online",
      getMachineStatusVersion: async () => 1,
      getMachineDaemonVersion: () => null,
      hasMachineLocally: () => true,
      hasMachineCapability: (_machineId: string, capability: string) => capability !== COMPUTER_CAPABILITY_SERVICE_IPC_UNREACHABLE,
      getMachineConnectionEpoch: () => "installer-repair-hint-epoch",
      getMachineComputerVersionFact: async () => ({
        version: "1.0.57", observedAt: new Date().toISOString(), provenance: "owner_connection",
      }),
      getMachineInstallerRepairHint: async (machineId: string) => machineId === hinted.id ? { reason: "unrecovered_operation" } : null,
      sendComputerControl: async () => {
        throw new Error("the v2 upgrade route must not use the legacy control relay");
      },
      sendComputerUpgrade: async (machineId: string) => {
        sent.push(machineId);
        return { sent: true };
      },
    });
    app.app.set("computerBroadcastPolicyEvaluator", (input: EvaluateComputerBroadcastPolicyInput) =>
      evaluateBroadcastPolicy(input, { fetchFn: async () => Response.json({
        app: { slug: "raft-computer-cli", platform: "node" }, channel: "main",
        build: { id: "build-59", version: "1.0.59" }, scoped: { release_id: "release-59" },
        assets: [{ platform: "darwin", arch: "arm64", variant: null, filetype: "binary",
          sha256: "a".repeat(64), size_bytes: 100, download_url: "https://hands.build/artifact" }],
      }) }));
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://hands.build/")) return new Response("unavailable", { status: 503 });
      return originalFetch(input, init);
    }) as typeof fetch;

    const res = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines`, {
      headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      machines: Array<{ id: string; computerUpgradeAvailable: boolean | null; computerBroadcastPolicy: { reasonCode: string } | null; installerRepairHint?: unknown }>;
    };
    const row = (id: string) => body.machines.find((machine) => machine.id === id)!;
    assert.deepEqual(row(hinted.id).installerRepairHint, { reason: "unrecovered_operation" });
    assert.equal(row(hinted.id).computerUpgradeAvailable, true);
    assert.equal(row(hinted.id).computerBroadcastPolicy?.reasonCode, "eligible");
    assert.equal(row(healthy.id).installerRepairHint, null);
    assert.equal(row(healthy.id).computerUpgradeAvailable, true);

    const upgrade = (machineId: string) => fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machineId}/computer/upgrade`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "X-Server-Id": server.id, "Content-Type": "application/json" },
      body: JSON.stringify({ targetVersion: "1.0.59" }),
    });
    const accepted = await upgrade(hinted.id);
    assert.equal(accepted.status, 201, await accepted.clone().text());
    assert.deepEqual(sent, [hinted.id], "the hint never stops the upgrade");
  } finally {
    globalThis.fetch = originalFetch;
    __resetLatestComputerVersionForTest();
  }
});

test("model label catalog is member-readable and carries only ids, labels and timestamps", async ({ app }) => {
  __clearMachineRuntimeModelCatalogLocalCacheForTests();
  try {
    const { owner, member, server } = await seedRoleFixture("model-label-catalog");
    const db = getDb();
    const [machine] = await db.insert(machines).values({
      serverId: server.id,
      userId: owner.id,
      name: "model-label-catalog-computer",
      apiKeyHash: "unused-model-label-catalog-machine-hash",
      runtimes: ["codex"],
    }).returning();
    await machineRuntimeModelCatalogService.writeRuntime(machine.id, "codex", [
      { id: "gpt-6-astra", label: "GPT-6-Astra" },
      { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
    ]);
    const [outsider] = await db.insert(users).values({
      email: "outsider-model-label-catalog@slock.test",
      name: "outsider-model-label-catalog",
      displayName: "outsider-model-label-catalog",
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();

    const [guest] = await db.insert(users).values({
      email: "guest-model-label-catalog@slock.test",
      name: "guest-model-label-catalog",
      displayName: "guest-model-label-catalog",
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    await seedBoundGuest({ serverId: server.id, userId: guest.id }, db);

    const memberToken = await tokenForHuman(member.email);
    const url = `${app.baseUrl}/api/servers/${server.id}/model-label-catalog`;
    const headers = (token: string) => ({ Authorization: `Bearer ${token}`, "X-Server-Id": server.id });

    const read = await fetch(url, { headers: headers(memberToken) });
    assert.equal(read.status, 200, "ordinary members read the shared display catalog");
    const body = await read.json() as any;
    assert.deepEqual(body.machines[machine.id].runtimes.codex.models, [
      { id: "gpt-6-astra", label: "GPT-6-Astra" },
      { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
    ]);

    // Field whitelist: nothing but ids, labels and report timestamps may
    // leave the server through the member-readable endpoint.
    for (const runtime of Object.values<any>(body.machines[machine.id].runtimes)) {
      assert.deepEqual(Object.keys(runtime).sort(), ["models", "updatedAt"]);
      for (const model of runtime.models) {
        assert.deepEqual(Object.keys(model).sort(), ["id", "label"]);
      }
    }

    // Guests render agent name rows too, so they must read the same catalog;
    // the endpoint only requires server membership.
    const guestRead = await fetch(url, { headers: headers(await tokenForHuman(guest.email)) });
    assert.equal(guestRead.status, 200, "guests read the same display catalog");
    assert.deepEqual((await guestRead.json() as any).machines[machine.id].runtimes.codex.models, [
      { id: "gpt-6-astra", label: "GPT-6-Astra" },
      { id: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
    ]);

    const outsiderRead = await fetch(url, { headers: headers(await tokenForHuman(outsider.email)) });
    assert.equal(outsiderRead.status, 403, "non-members are refused");
  } finally {
    __clearMachineRuntimeModelCatalogLocalCacheForTests();
  }
});

test("POST /api/servers enforces the minimum slug length only for new servers", async ({ app }) => {
  const owner = await seedPasswordUser("create-slug-min");
  const token = await tokenForHuman(owner.email);
  const create = (slug: string) => fetch(`${app.baseUrl}/api/servers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: `Server ${slug}`, slug }),
  });

  const tooShort = await create("abcd");
  assert.equal(tooShort.status, 400);
  assert.deepEqual(await tooShort.json(), { error: "Slug must be at least 5 characters" });
  const rows = await getDb().select({ id: serversTable.id }).from(serversTable).where(eq(serversTable.slug, "abcd"));
  assert.equal(rows.length, 0);

  const ok = await create("abcde");
  assert.equal(ok.status, 200);
  assert.equal((await ok.json() as { slug: string }).slug, "abcde");
});

test("GET/PATCH /api/servers/:id/product-analytics-settings: owners and admins switch it, members only read", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const { owner, admin, member, server } = await seedRoleFixture("product-analytics-settings");
    const request = (token: string, method: "GET" | "PATCH", body?: unknown) => fetch(`${app.baseUrl}/api/servers/${server.id}/product-analytics-settings`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Server-Id": server.id,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const ownerToken = await tokenForHuman(owner.email);
    const adminToken = await tokenForHuman(admin.email);
    const memberToken = await tokenForHuman(member.email);

    assert.deepEqual(await (await request(ownerToken, "GET")).json(), {
      productAnalyticsEnabled: true,
      canManageProductAnalytics: true,
    });
    assert.deepEqual(await (await request(memberToken, "GET")).json(), {
      productAnalyticsEnabled: true,
      canManageProductAnalytics: false,
    });

    const memberPatch = await request(memberToken, "PATCH", { productAnalyticsEnabled: false });
    assert.equal(memberPatch.status, 403);
    const invalid = await request(ownerToken, "PATCH", { productAnalyticsEnabled: "no" });
    assert.equal(invalid.status, 400);

    const adminPatch = await request(adminToken, "PATCH", { productAnalyticsEnabled: false });
    assert.equal(adminPatch.status, 200);
    assert.deepEqual(await adminPatch.json(), { productAnalyticsEnabled: false, canManageProductAnalytics: true });
    const [row] = await getDb().select({ enabled: serversTable.productAnalyticsEnabled }).from(serversTable).where(eq(serversTable.id, server.id));
    assert.equal(row.enabled, false);
  } finally {
    await app.close();
  }
});
