import { createApiTest } from "../test/integration/apiTest";
// Behavioral tests for task #137 — approval returns the initial secret once
// through a private transient owner wake, while owner-scoped rotate remains
// the durable recovery path. These run against the real PGlite-backed DB
// through the test harness (not the chain-mock pattern in oauthService.test.ts)
// so they exercise owner stamping, secret hashing, authentication, and
// invalidation end to end.
//
// Per org 铁律1: assert behavior (approval secret authenticates, rotation
// invalidates it, non-owner/cross-server/null-owner refused, and persisted
// card state stays secret-free) — never regex-match source.

import assert from "node:assert/strict";

import argon2 from "argon2";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import sharp from "sharp";
import { vi } from "vitest";

import { getDb } from "../db/index";
import {
  actionCards,
  agents,
  externalAppRegistrations,
  integrationAuditEvents,
  messages,
  oauthAccessRequests,
  oauthClientInstalls,
  oauthClientMaintainers,
  oauthClientShareLinks,
  oauthClients,
  oauthGrants,
  serverAgentMembers,
  users,
} from "../db/schema";
import { asServerId, INTEGRATION_INVITE_PATH_PREFIX } from "@botiverse/raft-shared";
import * as agentService from "../services/agentService";
import { createAgent } from "../services/agentService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { bindMarketplaceAppName, executeActionCard, prepareActionCard } from "../services/actionCardsService";
import * as oauthService from "../services/oauthService";
import {
  authenticateOAuthClient,
  createOAuthClient,
  rotateClientSecretForAgent,
  transferClientOwnershipForAgent,
  updateOAuthClientForAgent,
} from "../services/oauthService";
import { createServer } from "../services/serverService";
import { installRecordingLogoStorage } from "../test/recordingLogoStorage";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const ONE_BY_ONE_GIF = Buffer.from(
  "R0lGODdhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=",
  "base64",
);

async function seedUser(email: string, name: string) {
  const db = getDb();
  const [user] = await db.insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await argon2.hash("password123"),
    emailVerified: true,
  }).returning();
  return user;
}

async function login(baseUrl: string, email: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

interface CapturedNotice {
  agentId: string;
  content: string;
}

// Minimal orchestrator stub: executeActionCard only needs deliverMessage to push
// the executed-wake notice; we capture every delivered payload so the wake-content
// assertion checks the ACTUAL delivered string, not source.
function captureOrchestrator(captured: CapturedNotice[]) {
  return {
    deliverMessage: async (agentId: string, payload: { content: string }) => {
      captured.push({ agentId, content: payload.content });
    },
  } as unknown as Parameters<typeof executeActionCard>[0]["orchestrator"];
}

async function registerAppViaCard(opts: {
  baseUrl: string;
  serverId: string;
  ownerId: string;
  agentId: string;
  channelId: string;
  clientKey: string;
  captured: CapturedNotice[];
  description?: string;
  category?: string;
  scopes?: string[];
}) {
  const card = await prepareActionCard({
    serverId: opts.serverId,
    requesterAgentId: opts.agentId,
    targetChannelId: opts.channelId,
    action: {
      type: "integration:register_app",
      name: `App ${opts.clientKey}`,
      clientKey: opts.clientKey,
      description: opts.description,
      category: opts.category,
      returnUrl: "https://app.example/auth/raft/callback",
      homepageUrl: "https://app.example",
      scopes: opts.scopes ?? ["openid", "profile"],
      unsafeDemoUrlOverride: false,
    },
  });

  await executeActionCard({ webSessionFamilyId: null,
    messageId: card.messageId,
    serverId: asServerId(opts.serverId),
    userId: opts.ownerId,
    expectedState: "prepared",
    orchestrator: captureOrchestrator(opts.captured),
  });

  const db = getDb();
  const [client] = await db
    .select({
      id: oauthClients.id,
      clientId: oauthClients.clientId,
      ownerAgentId: oauthClients.ownerAgentId,
    })
    .from(oauthClients)
    .where(eq(oauthClients.clientId, opts.clientKey))
    .limit(1);
  return client;
}

test("register_app card execution stamps ownerAgentId and rotate recovers an authenticating secret", async ({ app }) => {
  const owner = await seedUser("rotate-owner@slock.test", "rotate-owner");
  const server = await createServer("Rotate Secret Server", "rotate-secret-server", owner.id);
  const agent = await createAgent(server.id, "rotate-agent", { runtime: "codex" });
  const channel = await createChannel(server.id, "rotate-channel", undefined, "channel");
  await addHuman(channel.id, owner.id);
  await addAgent(channel.id, agent.id);

  const captured: CapturedNotice[] = [];
  const clientKey = "rotate-app-key";
  const client = await registerAppViaCard({
    baseUrl: app.baseUrl,
    serverId: server.id,
    ownerId: owner.id,
    agentId: agent.id,
    channelId: channel.id,
    clientKey,
    captured,
  });

  // (a) the new oauth client is owned by the requesting agent
  assert.ok(client, "register_app should create an oauth client");
  assert.equal(client.ownerAgentId, agent.id, "ownerAgentId must equal the requesting agent");
  const [maintainer] = await getDb()
    .select()
    .from(oauthClientMaintainers)
    .where(and(
      eq(oauthClientMaintainers.clientId, client.id),
      eq(oauthClientMaintainers.role, "owner"),
      isNull(oauthClientMaintainers.revokedAt),
    ));
  assert.equal(maintainer?.agentId, agent.id, "registration must create an active app owner capability");

  // (b) approval returns the initial secret exactly through the requesting
  // owner's transient notice, together with the no-human recovery command.
  const registerNotice = captured.find((n) => n.agentId === agent.id);
  assert.ok(registerNotice, "the requesting agent should receive an executed wake notice");
  assert.match(registerNotice.content, /Private one-time client secret/);
  assert.match(registerNotice.content, /client_id: rotate-app-key/);
  const initialSecret = registerNotice.content.match(/client_secret: (raft_secret_[^\s]+)/)?.[1];
  assert.ok(initialSecret, "approval wake must carry the freshly created show-once secret");
  assert.match(
    registerNotice.content,
    /raft integration app rotate-secret --client rotate-app-key --output <new-private-path>/,
    "approval wake must explain owner-self recovery without human handoff",
  );
  assert.ok(
    await authenticateOAuthClient(clientKey, initialSecret),
    "the approval-delivered secret must authenticate",
  );

  // (c) owner recovery yields a new secret; it authenticates and invalidates
  // the approval-delivered value.
  const rotated = await rotateClientSecretForAgent({
    serverId: server.id,
    clientKey,
    actorAgentId: agent.id,
  });
  assert.equal(rotated.status, "ok", "owner rotate should succeed");
  if (rotated.status !== "ok") throw new Error("owner rotate failed");
  assert.equal(rotated.value.clientKey, clientKey);
  assert.ok(rotated.value.clientSecret.startsWith("raft_secret_"), "rotate mints a fresh raft_secret_");
  const authedNew = await authenticateOAuthClient(clientKey, rotated.value.clientSecret);
  assert.ok(authedNew, "the freshly rotated secret must authenticate");
  assert.equal(
    await authenticateOAuthClient(clientKey, initialSecret),
    null,
    "owner recovery must invalidate the approval-delivered secret",
  );

  // (b cont.) rotating again invalidates the previous secret
  const rotatedAgain = await rotateClientSecretForAgent({
    serverId: server.id,
    clientKey,
    actorAgentId: agent.id,
  });
  assert.equal(rotatedAgain.status, "ok", "second owner rotate should also succeed");
  if (rotatedAgain.status !== "ok") throw new Error("second owner rotate failed");
  const authedOld = await authenticateOAuthClient(clientKey, rotated.value.clientSecret);
  assert.equal(authedOld, null, "the previous secret must no longer authenticate after re-rotation");
  const authedNewest = await authenticateOAuthClient(clientKey, rotatedAgain.value.clientSecret);
  assert.ok(authedNewest, "the newest secret must authenticate");
});

test("registration stays committed and owner rotation recovers when initial secret delivery fails", async ({ app }) => {

  const originalConsoleError = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    const owner = await seedUser("delivery-failure-owner@slock.test", "delivery-failure-owner");
    const server = await createServer("Delivery Failure Server", "delivery-failure-server", owner.id);
    const agent = await createAgent(server.id, "delivery-failure-agent", { runtime: "codex" });
    const channel = await createChannel(server.id, "delivery-failure-channel", undefined, "channel");
    await addHuman(channel.id, owner.id);
    await addAgent(channel.id, agent.id);

    const clientKey = "delivery-failure-app";
    const card = await prepareActionCard({
      serverId: server.id,
      requesterAgentId: agent.id,
      targetChannelId: channel.id,
      action: {
        type: "integration:register_app",
        name: "Delivery Failure App",
        clientKey,
        returnUrl: "https://delivery-failure.example/auth/raft/callback",
        homepageUrl: "https://delivery-failure.example",
        scopes: ["openid"],
        unsafeDemoUrlOverride: false,
      },
    });

    const executed = await executeActionCard({ webSessionFamilyId: null,
      messageId: card.messageId,
      serverId: asServerId(server.id),
      userId: owner.id,
      expectedState: "prepared",
      orchestrator: {
        deliverMessage: async () => {
          throw new Error("simulated transport failure containing raft_secret_must_not_be_logged");
        },
      } as unknown as Parameters<typeof executeActionCard>[0]["orchestrator"],
    });
    assert.equal(executed.metadata.state, "executed", "wake failure must not roll back the committed card");

    const [client] = await getDb()
      .select({
        id: oauthClients.id,
        ownerAgentId: oauthClients.ownerAgentId,
      })
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientKey))
      .limit(1);
    assert.ok(client, "registration must remain committed after delivery failure");
    assert.equal(client.ownerAgentId, agent.id, "requesting agent must retain owner recovery authority");

    const [maintainer] = await getDb()
      .select({ agentId: oauthClientMaintainers.agentId })
      .from(oauthClientMaintainers)
      .where(and(
        eq(oauthClientMaintainers.clientId, client.id),
        eq(oauthClientMaintainers.role, "owner"),
        isNull(oauthClientMaintainers.revokedAt),
      ));
    assert.equal(maintainer?.agentId, agent.id, "durable owner capability must survive wake failure");

    const recovered = await rotateClientSecretForAgent({
      serverId: server.id,
      clientKey,
      actorAgentId: agent.id,
    });
    assert.equal(recovered.status, "ok", "owner must recover without human help");
    if (recovered.status !== "ok") throw new Error("owner recovery failed");
    assert.ok(
      await authenticateOAuthClient(clientKey, recovered.value.clientSecret),
      "recovery secret must authenticate",
    );
    assert.ok(
      logged.some((args) => args[0] === "[actionCards] failed to wake requester on executed"),
      "delivery failure must emit a secret-free diagnostic",
    );
    assert.doesNotMatch(
      JSON.stringify(logged),
      /raft_secret_must_not_be_logged/,
      "delivery failure logs must not include the secret-bearing payload or thrown error",
    );
  } finally {
    console.error = originalConsoleError;
    await app.close();
  }
});

test("owner can update and self-transfer; old owner loses lifecycle capability", async ({ app }) => {
  const human = await seedUser("lifecycle-owner@slock.test", "lifecycle-owner");
  const server = await createServer("Lifecycle Server", "lifecycle-server", human.id);
  const ownerAgent = await createAgent(server.id, "lifecycle-agent", { runtime: "codex" });
  const nextAgent = await createAgent(server.id, "lifecycle-next", { runtime: "codex" });
  const channel = await createChannel(server.id, "lifecycle-channel", undefined, "channel");
  await addHuman(channel.id, human.id);
  await addAgent(channel.id, ownerAgent.id);
  await addAgent(channel.id, nextAgent.id);
  const clientKey = "lifecycle-app";
  await registerAppViaCard({
    baseUrl: app.baseUrl,
    serverId: server.id,
    ownerId: human.id,
    agentId: ownerAgent.id,
    channelId: channel.id,
    clientKey,
    captured: [],
  });

  const updated = await updateOAuthClientForAgent({
    serverId: server.id,
    clientKey,
    actorAgentId: ownerAgent.id,
    name: "Lifecycle App Updated",
  });
  assert.equal(updated.status, "ok");
  if (updated.status !== "ok") throw new Error("owner update failed");
  assert.equal(updated.value.name, "Lifecycle App Updated");
  const clearCallback = await updateOAuthClientForAgent({
    serverId: server.id,
    clientKey,
    actorAgentId: ownerAgent.id,
    returnUrl: null,
  });
  assert.equal(clearCallback.status, "invalid_return_url");

  await assert.rejects(
    prepareActionCard({
      serverId: server.id,
      requesterAgentId: nextAgent.id,
      targetChannelId: channel.id,
      action: {
        type: "integration:update_app_registration",
        clientKey,
        name: "Legacy Card Hijack",
      },
    }),
    (err: unknown) => err instanceof Error && err.message.includes("update cards are disabled"),
  );

  // Historical cards may already exist in persisted chat. Rewrite a valid
  // carrier to that legacy shape and prove execution still fails closed.
  const historical = await prepareActionCard({
    serverId: server.id,
    requesterAgentId: nextAgent.id,
    targetChannelId: channel.id,
    action: {
      type: "integration:register_app",
      name: "Historical Carrier",
      clientKey: "historical-carrier",
      returnUrl: "https://historical.example/auth/raft/callback",
      scopes: [],
    },
  });
  const legacyAction = {
    type: "integration:update_app_registration" as const,
    clientKey,
    name: "Legacy Card Hijack",
  };
  await getDb().update(messages).set({
    actionMetadata: {
      kind: "action-card",
      action: legacyAction,
      state: "prepared",
      executedAt: null,
      executedByUserId: null,
      executedByUserName: null,
      result: null,
    },
  }).where(eq(messages.id, historical.messageId));
  await getDb().update(actionCards).set({
    actionType: legacyAction.type,
    payload: legacyAction,
  }).where(eq(actionCards.messageId, historical.messageId));
  await assert.rejects(
    executeActionCard({ webSessionFamilyId: null,
      messageId: historical.messageId,
      serverId: asServerId(server.id),
      userId: human.id,
    }),
    (err: unknown) => err instanceof Error && err.message.includes("update cards are disabled"),
  );
  const [afterLegacyAttempt] = await getDb()
    .select({ name: oauthClients.name })
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientKey));
  assert.equal(afterLegacyAttempt?.name, "Lifecycle App Updated");

  const transferred = await transferClientOwnershipForAgent({
    serverId: server.id,
    clientKey,
    actorAgentId: ownerAgent.id,
    targetAgentId: nextAgent.id,
  });
  assert.equal(transferred.status, "ok");

  const oldOwnerUpdate = await updateOAuthClientForAgent({
    serverId: server.id,
    clientKey,
    actorAgentId: ownerAgent.id,
    description: "must fail",
  });
  assert.equal(oldOwnerUpdate.status, "owner_required");
  const oldOwnerRotate = await rotateClientSecretForAgent({ serverId: server.id, clientKey, actorAgentId: ownerAgent.id });
  assert.equal(oldOwnerRotate.status, "owner_required");

  const newOwnerUpdate = await updateOAuthClientForAgent({
    serverId: server.id,
    clientKey,
    actorAgentId: nextAgent.id,
    description: "new owner update",
  });
  assert.equal(newOwnerUpdate.status, "ok");
  const newOwnerRotate = await rotateClientSecretForAgent({ serverId: server.id, clientKey, actorAgentId: nextAgent.id });
  assert.equal(newOwnerRotate.status, "ok");
});

test("app list/status exposes owned apps to owners and every source app to current server admins", async ({ app }) => {
  const human = await seedUser("query-owner@slock.test", "query-owner");
  const server = await createServer("Query Server", "query-server", human.id);
  const requester = await createAgent(server.id, "query-requester", { runtime: "codex" });
  const nextOwner = await createAgent(server.id, "query-next-owner", { runtime: "codex" });
  const channel = await createChannel(server.id, "query-channel", undefined, "channel");
  await addHuman(channel.id, human.id);
  await addAgent(channel.id, requester.id);
  const card = await prepareActionCard({
    serverId: server.id,
    requesterAgentId: requester.id,
    targetChannelId: channel.id,
    action: {
      type: "integration:register_app",
      name: "Query App",
      clientKey: "query-app",
      returnUrl: "https://query.example/auth/raft/callback",
      scopes: ["openid", "profile"],
    },
  });
  const requesterKey = (await mintAgentCredential({
    agentId: requester.id,
    scopes: ["read"],
    name: "query-requester-cred",
    issuedVia: "computer",
    createdByUserId: null,
  })).apiKey;
  const nextOwnerKey = (await mintAgentCredential({
    agentId: nextOwner.id,
    scopes: ["read"],
    name: "query-next-owner-cred",
    issuedVia: "computer",
    createdByUserId: null,
  })).apiKey;
  const auth = (key: string) => ({ Authorization: `Bearer ${key}` });

  const pendingListRes = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app`, { headers: auth(requesterKey) });
  assert.equal(pendingListRes.status, 200);
  const pendingList = await pendingListRes.json() as { apps: Array<Record<string, unknown>> };
  assert.equal(pendingList.apps.length, 1);
  assert.equal(pendingList.apps[0]?.state, "card_pending");
  assert.equal(pendingList.apps[0]?.card, card.messageId);
  assert.equal(pendingList.apps[0]?.recoveryCommand, null);
  assert.doesNotMatch(JSON.stringify(pendingList), /clientSecret|client_secret|secretHash|secret_hash|ownerAgentId|requesterAgentId/);

  const pendingStatusRes = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/status?card=${card.messageId.slice(0, 8)}`, { headers: auth(requesterKey) });
  assert.equal(pendingStatusRes.status, 200);
  assert.equal(((await pendingStatusRes.json()) as { app: { state: string } }).app.state, "card_pending");
  const hiddenPending = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/status?card=${card.messageId}`, { headers: auth(nextOwnerKey) });
  const hiddenMissing = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/status?card=deadbeef`, { headers: auth(nextOwnerKey) });
  assert.equal(hiddenPending.status, 404);
  assert.equal(hiddenMissing.status, 404, "missing and requester-hidden cards use the same status");

  await executeActionCard({ webSessionFamilyId: null,
    messageId: card.messageId,
    serverId: asServerId(server.id),
    userId: human.id,
    expectedState: "prepared",
    orchestrator: captureOrchestrator([]),
  });
  const committedListRes = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app`, { headers: auth(requesterKey) });
  const committedList = await committedListRes.json() as { apps: Array<Record<string, unknown>> };
  assert.equal(committedList.apps.length, 1, "executed card is replaced by its committed app projection");
  assert.equal(committedList.apps[0]?.state, "committed");
  assert.equal(committedList.apps[0]?.clientKey, "query-app");
  assert.equal(committedList.apps[0]?.recoveryCommand, "raft integration app rotate-secret --client query-app --output <new-private-path>");

  const committedCardRes = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/status?card=${card.messageId}`, { headers: auth(requesterKey) });
  const committedCard = await committedCardRes.json() as { app: Record<string, unknown> };
  assert.equal(committedCard.app.recoveryCommand, "raft integration app rotate-secret --client query-app --output <new-private-path>");

  const ordinaryNonOwnerList = await (await fetch(`${app.baseUrl}/internal/agent-api/integrations/app`, { headers: auth(nextOwnerKey) })).json() as { apps: unknown[] };
  assert.deepEqual(ordinaryNonOwnerList.apps, [], "an ordinary non-owner agent has no server-wide app view");
  const ordinaryNonOwnerStatus = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/status?client=query-app`, { headers: auth(nextOwnerKey) });
  assert.equal(ordinaryNonOwnerStatus.status, 404, "ordinary non-owner status stays non-enumerating");

  await getDb().update(serverAgentMembers)
    .set({ role: "admin" })
    .where(and(
      eq(serverAgentMembers.serverId, server.id),
      eq(serverAgentMembers.agentId, nextOwner.id),
    ));
  const adminNonOwnerList = await (await fetch(`${app.baseUrl}/internal/agent-api/integrations/app`, { headers: auth(nextOwnerKey) })).json() as { apps: Array<Record<string, unknown>> };
  assert.equal(adminNonOwnerList.apps.length, 1, "a current server admin sees every source-owned app");
  assert.equal(adminNonOwnerList.apps[0]?.clientKey, "query-app");
  assert.equal(adminNonOwnerList.apps[0]?.authority, "admin");
  assert.equal(adminNonOwnerList.apps[0]?.recoveryCommand, "raft integration app rotate-secret --client query-app --output <new-private-path>");
  const adminNonOwnerStatus = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/status?client=query-app`, { headers: auth(nextOwnerKey) });
  assert.equal(adminNonOwnerStatus.status, 200, "current server admin can inspect another owner's source app");
  assert.equal(((await adminNonOwnerStatus.json()) as { app: { authority: string } }).app.authority, "admin");

  const transferred = await transferClientOwnershipForAgent({
    serverId: server.id,
    clientKey: "query-app",
    actorAgentId: requester.id,
    targetAgentId: nextOwner.id,
  });
  assert.equal(transferred.status, "ok");

  const oldList = await (await fetch(`${app.baseUrl}/internal/agent-api/integrations/app`, { headers: auth(requesterKey) })).json() as { apps: unknown[] };
  assert.deepEqual(oldList.apps, [], "transferred app disappears from the old owner's list");
  const oldClient = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/status?client=query-app`, { headers: auth(requesterKey) });
  assert.equal(oldClient.status, 404);
  const historicalCard = await (await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/status?card=${card.messageId}`, { headers: auth(requesterKey) })).json() as { app: Record<string, unknown> };
  assert.equal(historicalCard.app.state, "committed");
  assert.equal(historicalCard.app.recoveryCommand, null, "historical requester loses an unusable rotate next-step after transfer");
  const newOwnerList = await (await fetch(`${app.baseUrl}/internal/agent-api/integrations/app`, { headers: auth(nextOwnerKey) })).json() as { apps: Array<Record<string, unknown>> };
  assert.equal(newOwnerList.apps[0]?.clientKey, "query-app");
  assert.equal(newOwnerList.apps[0]?.recoveryCommand, "raft integration app rotate-secret --client query-app --output <new-private-path>");
});

test("agent app management matches human fields and distribution lifecycle with owner/admin authority", async ({ app }) => {
  const human = await seedUser("manage-owner@slock.test", "manage-owner");
  const otherHuman = await seedUser("manage-other-owner@slock.test", "manage-other-owner");
  const server = await createServer("Manage App Server", "manage-app-server", human.id);
  const otherServer = await createServer("Manage App Other", "manage-app-other", otherHuman.id);
  const ownerAgent = await createAgent(server.id, "manage-app-owner-agent", { runtime: "codex" });
  const adminAgent = await createAgent(server.id, "manage-app-admin-agent", { runtime: "codex" });
  const ordinaryAgent = await createAgent(server.id, "manage-app-ordinary-agent", { runtime: "codex" });
  const crossServerAgent = await createAgent(otherServer.id, "manage-app-cross-agent", { runtime: "codex" });
  const channel = await createChannel(server.id, "manage-app-channel", undefined, "channel");
  await addHuman(channel.id, human.id);
  await addAgent(channel.id, ownerAgent.id);

  await getDb().update(serverAgentMembers)
    .set({ role: "admin" })
    .where(and(
      eq(serverAgentMembers.serverId, server.id),
      eq(serverAgentMembers.agentId, adminAgent.id),
    ));

  const registered = await registerAppViaCard({
    baseUrl: app.baseUrl,
    serverId: server.id,
    ownerId: human.id,
    agentId: ownerAgent.id,
    channelId: channel.id,
    clientKey: "managed-parity-app",
    description: "A complete app listing description.",
    category: "Business Ops",
    captured: [],
  });
  assert.ok(registered);

  const [registeredState] = await getDb().select({
    category: oauthClients.category,
    allowedScopes: oauthClients.allowedScopes,
  }).from(oauthClients).where(eq(oauthClients.id, registered.id));
  assert.equal(registeredState?.category, "Business Ops", "registration commit must preserve category");
  assert.deepEqual(registeredState?.allowedScopes, ["openid", "profile"], "registration commit must preserve requested scopes");

  const credentialFor = async (agentId: string, name: string) => (await mintAgentCredential({
    agentId,
    scopes: ["read"],
    name,
    issuedVia: "computer",
    createdByUserId: null,
  })).apiKey;
  const ownerKey = await credentialFor(ownerAgent.id, "manage-owner-credential");
  const adminKey = await credentialFor(adminAgent.id, "manage-admin-credential");
  const ordinaryKey = await credentialFor(ordinaryAgent.id, "manage-ordinary-credential");
  const crossServerKey = await credentialFor(crossServerAgent.id, "manage-cross-credential");
  const jsonHeaders = (key: string) => ({
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  });
  const manage = (key: string, body: Record<string, unknown>) => fetch(
    `${app.baseUrl}/internal/agent-api/integrations/app/manage`,
    {
      method: "POST",
      headers: jsonHeaders(key),
      body: JSON.stringify({ clientKey: "managed-parity-app", ...body }),
    },
  );

  const ordinaryUpdate = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/update`, {
    method: "POST",
    headers: jsonHeaders(ordinaryKey),
    body: JSON.stringify({ clientKey: "managed-parity-app", name: "Forbidden" }),
  });
  assert.equal(ordinaryUpdate.status, 403, "ordinary non-owner cannot update another agent's app");

  const crossServerRead = await manage(crossServerKey, { action: "share_link_get" });
  assert.equal(crossServerRead.status, 404, "cross-server app lookup stays non-enumerating");

  const adminUpdate = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/update`, {
    method: "POST",
    headers: jsonHeaders(adminKey),
    body: JSON.stringify({
      clientKey: "managed-parity-app",
      name: "Managed Parity App",
      category: "Developer Tools",
      scopes: ["identity", "openid", "profile"],
    }),
  });
  assert.equal(adminUpdate.status, 200, "current server admin can update every source-owned app");
  const [afterAdminUpdate] = await getDb().select({
    name: oauthClients.name,
    category: oauthClients.category,
    allowedScopes: oauthClients.allowedScopes,
  }).from(oauthClients).where(eq(oauthClients.id, registered.id));
  assert.equal(afterAdminUpdate?.name, "Managed Parity App");
  assert.equal(afterAdminUpdate?.category, "Developer Tools");
  assert.deepEqual(afterAdminUpdate?.allowedScopes, ["identity", "openid", "profile"]);

  const invalidScopeUpdate = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/update`, {
    method: "POST",
    headers: jsonHeaders(ownerKey),
    body: JSON.stringify({ clientKey: "managed-parity-app", scopes: ["not:a:raft:scope"] }),
  });
  assert.equal(invalidScopeUpdate.status, 400, "Agent metadata validation matches the Human editor boundary");

  const clearScopesUpdate = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/update`, {
    method: "POST",
    headers: jsonHeaders(ownerKey),
    body: JSON.stringify({ clientKey: "managed-parity-app", scopes: [] }),
  });
  assert.equal(clearScopesUpdate.status, 200, "Agent can clear an app-specific scope override");
  const [afterScopeClear] = await getDb().select({ allowedScopes: oauthClients.allowedScopes })
    .from(oauthClients)
    .where(eq(oauthClients.id, registered.id));
  assert.equal(afterScopeClear?.allowedScopes, null, "clearing scopes restores the shared default-scope contract");

  const adminRotate = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/rotate-secret`, {
    method: "POST",
    headers: jsonHeaders(adminKey),
    body: JSON.stringify({ clientKey: "managed-parity-app" }),
  });
  assert.equal(adminRotate.status, 200, "current server admin can rotate another owner's app secret");

  const ordinaryLogo = new FormData();
  ordinaryLogo.set("clientKey", "managed-parity-app");
  ordinaryLogo.set("avatar", new Blob([ONE_BY_ONE_GIF], { type: "image/gif" }), "logo.gif");
  const ordinaryLogoRes = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/logo`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ordinaryKey}` },
    body: ordinaryLogo,
  });
  assert.equal(ordinaryLogoRes.status, 403, "ordinary non-owner cannot replace another app's logo");

  const adminLogo = new FormData();
  adminLogo.set("clientKey", "managed-parity-app");
  adminLogo.set("avatar", new Blob([ONE_BY_ONE_GIF], { type: "image/gif" }), "logo.gif");
  const adminLogoRes = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/logo`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminKey}` },
    body: adminLogo,
  });
  assert.equal(adminLogoRes.status, 200, "current server admin can replace another app's logo");
  const adminLogoBody = await adminLogoRes.json() as { logoUrl: string };
  assert.match(adminLogoBody.logoUrl, new RegExp(`^/api/integration-logos/${registered.id}/[0-9a-f]{32}\\.webp$`));

  const clearLogo = await manage(ownerKey, { action: "clear_logo" });
  assert.equal(clearLogo.status, 200, "owner can clear its app logo");
  assert.equal(((await clearLogo.json()) as { logoUrl: string | null }).logoUrl, null);

  // An Agent names the one target Server too (#proj-apps:769a57d4).
  const untargetedShare = await manage(adminKey, { action: "share_link_create", expiresInDays: 7 });
  assert.equal(untargetedShare.status, 400, "a share link needs its target Server");
  assert.equal((await untargetedShare.json() as { errorCode: string }).errorCode, "SHARE_LINK_TARGET_REQUIRED");
  const malformedShare = await manage(adminKey, { action: "share_link_create", targetServerSlug: "Not A Slug!" });
  assert.equal(malformedShare.status, 400);
  assert.equal((await malformedShare.json() as { errorCode: string }).errorCode, "SHARE_LINK_TARGET_INVALID");
  assert.equal((await getDb().select({ id: oauthClientShareLinks.id }).from(oauthClientShareLinks)
    .where(eq(oauthClientShareLinks.clientId, registered.id))).length, 0, "a refused create stores nothing");

  const createShare = await manage(adminKey, { action: "share_link_create", expiresInDays: 7, targetServerSlug: otherServer.slug });
  assert.equal(createShare.status, 200, "current server admin can create a private share link");
  const createShareText = await createShare.clone().text();
  const createShareBody = await createShare.json() as { shareUrl: string; link: { id: string; targetServerSlug: string | null } };
  assert.equal(createShareBody.link.targetServerSlug, otherServer.slug);
  assert.equal(createShareText.includes(otherServer.id), false, "the resolved target is never echoed");
  assert.equal(createShareText.includes(otherServer.name), false, "the resolved target is never echoed");
  const unknownShare = await manage(adminKey, { action: "share_link_create", targetServerSlug: "manage-app-nowhere" });
  assert.equal(unknownShare.status, 200, "an unknown slug answers like a known one");
  assert.match(createShareBody.shareUrl, /\/integration-invites\/raft_share_[0-9a-f]{64}$/);
  assert.match(
    new URL(createShareBody.shareUrl).pathname,
    new RegExp(`^${INTEGRATION_INVITE_PATH_PREFIX}/raft_share_[0-9a-f]{64}$`),
    "agent-created share links must use the canonical plural web route",
  );
  assert.ok(createShareBody.link.id);

  const [install] = await getDb().select().from(oauthClientInstalls)
    .where(and(
      eq(oauthClientInstalls.serverId, server.id),
      eq(oauthClientInstalls.clientId, registered.id),
    ));
  assert.equal(install?.installedByUserId, null);
  assert.equal(install?.installedByAgentId, adminAgent.id, "source install records the acting Agent");
  const [shareLink] = await getDb().select().from(oauthClientShareLinks)
    .where(eq(oauthClientShareLinks.id, createShareBody.link.id));
  assert.equal(shareLink?.createdByUserId, null);
  assert.equal(shareLink?.createdByAgentId, adminAgent.id, "share link records the acting Agent");
  assert.equal(shareLink?.targetServerId, otherServer.id);
  assert.doesNotMatch(shareLink?.tokenHash ?? "", /raft_share_/, "only the token hash is stored");

  const getShare = await manage(ownerKey, { action: "share_link_get" });
  assert.equal(getShare.status, 200);
  const getShareText = await getShare.text();
  assert.doesNotMatch(getShareText, /raft_share_/, "share-link status never replays the one-time token");
  assert.equal(getShareText.includes(otherServer.id), false);
  const getShareBody = JSON.parse(getShareText) as { shareUrl?: string | null; links: Array<{ targetServerSlug: string | null }> };
  assert.equal(getShareBody.shareUrl ?? null, null);
  assert.deepEqual(getShareBody.links.map((link) => link.targetServerSlug).sort(), ["manage-app-nowhere", otherServer.slug].sort(), "one active link per target");

  const revokeShare = await manage(ownerKey, { action: "share_link_revoke", targetServerSlug: otherServer.slug });
  assert.equal(revokeShare.status, 200);
  const revokeShareBody = await revokeShare.json() as { link: { revokedAt: string | null }; links: Array<{ targetServerSlug: string | null }> };
  assert.ok(revokeShareBody.link.revokedAt);
  assert.deepEqual(revokeShareBody.links.map((link) => link.targetServerSlug), [otherServer.slug], "only that target's link");
  const revokeRest = await manage(ownerKey, { action: "share_link_revoke" });
  assert.equal(revokeRest.status, 200);
  assert.deepEqual((await revokeRest.json() as { links: Array<{ targetServerSlug: string | null }> }).links.map((link) => link.targetServerSlug), ["manage-app-nowhere"]);
  assert.equal((await manage(ownerKey, { action: "share_link_revoke" })).status, 404, "nothing active left");

  // A target means something only to share_link_create and share_link_revoke:
  // every other action refuses it instead of ignoring it, and does nothing.
  for (const action of ["share_link_get", "request_publish", "request_unpublish", "clear_logo", "delete"]) {
    const misplaced = await manage(adminKey, { action, targetServerSlug: otherServer.slug });
    assert.equal(misplaced.status, 400, `${action} with a target`);
    assert.equal((await misplaced.json() as { errorCode: string }).errorCode, "SHARE_LINK_TARGET_NOT_APPLICABLE", action);
  }
  const [stillPrivate] = await getDb().select({ publishStatus: oauthClients.publishStatus })
    .from(oauthClients).where(eq(oauthClients.id, registered.id));
  assert.equal(stillPrivate?.publishStatus, "private", "the refused request_publish changed nothing");

  const requestPublish = await manage(adminKey, { action: "request_publish" });
  assert.equal(requestPublish.status, 200, "current server admin can request Marketplace review");
  assert.equal((await requestPublish.json() as { publishStatus: string }).publishStatus, "publish_requested");

  await getDb().update(oauthClients).set({
    appType: "third_party_global",
    publishStatus: "published",
    enabled: true,
  }).where(eq(oauthClients.id, registered.id));
  const requestUnpublish = await manage(ownerKey, { action: "request_unpublish" });
  assert.equal(requestUnpublish.status, 200, "owner can request removal of its published app");
  assert.equal((await requestUnpublish.json() as { publishStatus: string }).publishStatus, "unpublish_requested");
  const publishedDelete = await manage(adminKey, { action: "delete" });
  assert.equal(publishedDelete.status, 409, "published lifecycle cannot be bypassed with direct deletion");

  const deletable = await registerAppViaCard({
    baseUrl: app.baseUrl,
    serverId: server.id,
    ownerId: human.id,
    agentId: ownerAgent.id,
    channelId: channel.id,
    clientKey: "managed-deletable-app",
    description: "A deletable app.",
    scopes: [],
    captured: [],
  });
  assert.ok(deletable);
  const [deletableState] = await getDb().select({ allowedScopes: oauthClients.allowedScopes })
    .from(oauthClients)
    .where(eq(oauthClients.id, deletable.id));
  assert.equal(deletableState?.allowedScopes, null, "omitted Agent scopes preserve the shared default-scope contract");
  const deleteRes = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/manage`, {
    method: "POST",
    headers: jsonHeaders(adminKey),
    body: JSON.stringify({ clientKey: "managed-deletable-app", action: "delete" }),
  });
  assert.equal(deleteRes.status, 200, "current server admin can delete another owner's eligible app");
  const [deleted] = await getDb().select({ id: oauthClients.id }).from(oauthClients)
    .where(eq(oauthClients.id, deletable.id));
  assert.equal(deleted, undefined);

  const agentAudits = await getDb().select({
    eventType: integrationAuditEvents.eventType,
    actorType: integrationAuditEvents.actorType,
    actorId: integrationAuditEvents.actorId,
  }).from(integrationAuditEvents)
    .where(eq(integrationAuditEvents.serverId, server.id));
  assert.ok(
    agentAudits.some((event) => event.eventType === "private_share.link_created" && event.actorType === "agent" && event.actorId === adminAgent.id),
    "distribution audit preserves the acting admin Agent",
  );
  assert.ok(
    agentAudits.some((event) => event.eventType === "app.offline_requested" && event.actorType === "agent" && event.actorId === ownerAgent.id),
    "owner lifecycle audit preserves the acting owner Agent",
  );
});

// Regression guard for the agent-API logo paths: an App bot's avatar IS its
// App's logo (agentService.syncAppBotAvatarsToLogo, written in the logo's own
// transaction), and each moved bot's server is told to re-read it.
test("agent-API logo upload, logo clear and App deletion keep every bound bot's avatar on the logo and tell each bot's server", async ({ app }) => {
  const owner = await seedUser("bot-avatar-agent-owner@slock.test", "bot-avatar-agent-owner");
  const otherOwner = await seedUser("bot-avatar-agent-other@slock.test", "bot-avatar-agent-other");
  const server = await createServer("Bot Avatar Agent Server", "bot-avatar-agent-server", owner.id);
  const otherServer = await createServer("Bot Avatar Agent Other", "bot-avatar-agent-other", otherOwner.id);
  const adminAgent = await createAgent(server.id, "bot-avatar-admin-agent", { runtime: "codex" });
  await getDb().update(serverAgentMembers)
    .set({ role: "admin" })
    .where(and(eq(serverAgentMembers.serverId, server.id), eq(serverAgentMembers.agentId, adminAgent.id)));
  const adminKey = (await mintAgentCredential({
    agentId: adminAgent.id,
    scopes: ["read"],
    name: "bot-avatar-admin-credential",
    issuedVia: "computer",
    createdByUserId: null,
  })).apiKey;
  const { client } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    clientId: "bot-avatar-agent-app",
    name: "Bot Avatar Agent App",
    enableBot: true,
  });
  const { createManagedAppBot } = await import("../services/appBotIdentityService");
  const bots: Array<{ serverId: string; agentId: string }> = [];
  for (const [serverId, installedByUserId] of [[server.id, owner.id], [otherServer.id, otherOwner.id]] as const) {
    const [install] = await getDb().insert(oauthClientInstalls).values({
      serverId,
      clientId: client.id,
      installedByUserId,
      status: "active",
      botGrant: "granted",
    }).returning();
    const bot = await getDb().transaction((tx) => createManagedAppBot(tx, { installId: install!.id, serverId }));
    bots.push({ serverId, agentId: bot.agentId });
  }
  const botIds = bots.map((bot) => bot.agentId);
  const avatars = async () => (await getDb().select({ avatarUrl: agents.avatarUrl }).from(agents)
    .where(inArray(agents.id, botIds))).map((row) => row.avatarUrl);
  const uploadLogo = async () => {
    const form = new FormData();
    form.set("clientKey", "bot-avatar-agent-app");
    form.set("avatar", new Blob([ONE_BY_ONE_GIF], { type: "image/gif" }), "logo.gif");
    const res = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/logo`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminKey}` },
      body: form,
    });
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json() as { logoUrl: string }).logoUrl;
  };
  const manage = (action: string) => fetch(`${app.baseUrl}/internal/agent-api/integrations/app/manage`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: "bot-avatar-agent-app", action }),
  });

  const pushes: string[] = [];
  const originalTo = app.io.to.bind(app.io);
  (app.io as any).to = (room: string | string[]) => {
    const operator = originalTo(room as any) as any;
    const originalEmit = operator.emit.bind(operator);
    operator.emit = (event: string, ...args: unknown[]) => {
      if (event === "agent:updated") pushes.push(`${String(room)} ${(args[0] as { agentId?: string } | undefined)?.agentId}`);
      return originalEmit(event, ...args);
    };
    return operator;
  };
  const assertEachBotTold = (step: string) => {
    assert.deepEqual(
      pushes.splice(0).sort(),
      bots.map((bot) => `server:${bot.serverId} ${bot.agentId}`).sort(),
      `${step}: one agent:updated per bot, to the bot's own server`,
    );
  };
  try {
    const logoUrl = await uploadLogo();
    assert.deepEqual(await avatars(), [logoUrl, logoUrl], "logo upload: every bot on every server shows the logo");
    assertEachBotTold("logo upload");

    const cleared = await manage("clear_logo");
    assert.equal(cleared.status, 200, await cleared.clone().text());
    assert.deepEqual(await avatars(), [null, null], "logo clear: the bots fall back to the generated avatar");
    assertEachBotTold("logo clear");

    const nextLogoUrl = await uploadLogo();
    assert.deepEqual(await avatars(), [nextLogoUrl, nextLogoUrl]);
    assertEachBotTold("second logo upload");
    const deleted = await manage("delete");
    assert.equal(deleted.status, 200, await deleted.clone().text());
    const [gone] = await getDb().select({ id: oauthClients.id }).from(oauthClients).where(eq(oauthClients.id, client.id));
    assert.equal(gone, undefined, "the App is deleted");
    assert.deepEqual(await avatars(), [null, null], "App deletion: the bots no longer point at the deleted logo");
    assertEachBotTold("App deletion");
  } finally {
    (app.io as any).to = originalTo;
  }
});

// Regression guard for the agent-API logo paths: an App's old logo object is
// deleted only after the change commits. If anything after the logo write fails
// in the same transaction, the change rolls back and the App and its bot still
// point at the old logo, so its object must still exist.
test("agent-API logo upload, clear_logo or delete that rolls back deletes no logo object; once committed it deletes the old one", async ({ app }) => {
  const owner = await seedUser("logo-commit-agent-owner@slock.test", "logo-commit-agent-owner");
  const server = await createServer("Logo Commit Agent Server", "logo-commit-agent-server", owner.id);
  const adminAgent = await createAgent(server.id, "logo-commit-admin-agent", { runtime: "codex" });
  await getDb().update(serverAgentMembers)
    .set({ role: "admin" })
    .where(and(eq(serverAgentMembers.serverId, server.id), eq(serverAgentMembers.agentId, adminAgent.id)));
  const adminKey = (await mintAgentCredential({
    agentId: adminAgent.id,
    scopes: ["read"],
    name: "logo-commit-admin-credential",
    issuedVia: "computer",
    createdByUserId: null,
  })).apiKey;
  const clientKey = "logo-commit-agent-app";
  const { client } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    clientId: clientKey,
    name: "Logo Commit Agent App",
    enableBot: true,
  });
  const [install] = await getDb().insert(oauthClientInstalls).values({
    serverId: server.id,
    clientId: client.id,
    installedByUserId: owner.id,
    status: "active",
    botGrant: "granted",
  }).returning();
  const { createManagedAppBot } = await import("../services/appBotIdentityService");
  const bot = await getDb().transaction((tx) => createManagedAppBot(tx, { installId: install!.id, serverId: server.id }));
  const uploadLogo = async (background: string) => {
    const image = await sharp({ create: { width: 8, height: 8, channels: 3, background } }).png().toBuffer();
    const form = new FormData();
    form.set("clientKey", clientKey);
    form.set("avatar", new Blob([new Uint8Array(image)], { type: "image/png" }), "logo.png");
    return fetch(`${app.baseUrl}/internal/agent-api/integrations/app/logo`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminKey}` },
      body: form,
    });
  };
  const manage = (action: "clear_logo" | "delete") => fetch(`${app.baseUrl}/internal/agent-api/integrations/app/manage`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey, action }),
  });
  const stored = async () => {
    const [row] = await getDb().select({ logoUrl: oauthClients.logoUrl, logoStorageKey: oauthClients.logoStorageKey })
      .from(oauthClients).where(eq(oauthClients.id, client.id));
    const [botRow] = await getDb().select({ avatarUrl: agents.avatarUrl }).from(agents).where(eq(agents.id, bot.agentId));
    return { app: row ?? null, botAvatarUrl: botRow?.avatarUrl ?? null };
  };

  // Upload and clear: make the bot avatar sync that follows the logo write
  // fail. App deletion has nothing after its write: fail right after it, as a
  // failed commit would.
  const failNextBotSync = () => vi.spyOn(agentService, "syncAppBotAvatarsToLogo")
    .mockRejectedValueOnce(new Error("injected failure after the logo write"));
  const failAfterNextAppDeletion = () => {
    const deleteLocked = oauthService.deleteLockedOAuthClient;
    return vi.spyOn(oauthService, "deleteLockedOAuthClient").mockImplementationOnce(async (...args) => {
      await deleteLocked(...args);
      throw new Error("injected failure after the App deletion write");
    });
  };

  const bucket = installRecordingLogoStorage();
  try {
    assert.equal((await uploadLogo("#d33f49")).status, 200);
    const before = await stored();
    const oldKey = before.app?.logoStorageKey;
    assert.ok(oldKey && bucket.objects.has(oldKey), "the first logo is stored");
    assert.equal(before.botAvatarUrl, before.app?.logoUrl, "the bot shows the logo");

    for (const [step, injectFailure, request] of [
      ["logo upload", failNextBotSync, () => uploadLogo("#2f6fdd")],
      ["clear_logo", failNextBotSync, () => manage("clear_logo")],
      ["delete", failAfterNextAppDeletion, () => manage("delete")],
    ] as const) {
      const injected = injectFailure();
      try {
        assert.equal((await request()).status, 500, `${step}: the injected failure fails the request`);
      } finally {
        injected.mockRestore();
      }
      assert.deepEqual(await stored(), before, `${step} rolled back: the App and its bot keep the old logo`);
      assert.deepEqual(bucket.deletes, [], `${step} rolled back: no logo object is deleted`);
      assert.ok(bucket.objects.has(oldKey), `${step} rolled back: the old logo object still exists`);
    }

    // Committed, each change deletes the object it left unreferenced.
    assert.equal((await uploadLogo("#2f6fdd")).status, 200);
    const replacedBy = (await stored()).app?.logoStorageKey;
    assert.ok(replacedBy && replacedBy !== oldKey);
    assert.deepEqual(bucket.deletes.splice(0), [oldKey], "logo upload: the replaced object is deleted");
    assert.equal((await manage("clear_logo")).status, 200);
    assert.deepEqual(bucket.deletes.splice(0), [replacedBy], "clear_logo: the removed object is deleted");
    assert.equal((await uploadLogo("#1a7f37")).status, 200);
    const lastKey = (await stored()).app?.logoStorageKey;
    assert.ok(lastKey);
    assert.equal((await manage("delete")).status, 200);
    assert.equal((await stored()).app, null, "the App is deleted");
    assert.deepEqual(bucket.deletes.splice(0), [lastKey], "delete: the App's logo object is deleted");
  } finally {
    bucket.restore();
  }
});

test("admin recovery rejects an active owner and succeeds after that owner is retired", async ({ app }) => {
  const human = await seedUser("recovery-admin@slock.test", "recovery-admin");
  const server = await createServer("Recovery Server", "recovery-server", human.id);
  const ownerAgent = await createAgent(server.id, "recovery-owner", { runtime: "codex" });
  const targetAgent = await createAgent(server.id, "recovery-target", { runtime: "codex" });
  const channel = await createChannel(server.id, "recovery-channel", undefined, "channel");
  await addHuman(channel.id, human.id);
  await addAgent(channel.id, ownerAgent.id);
  const clientKey = "recovery-app";
  await registerAppViaCard({
    baseUrl: app.baseUrl,
    serverId: server.id,
    ownerId: human.id,
    agentId: ownerAgent.id,
    channelId: channel.id,
    clientKey,
    captured: [],
  });

  const card = await prepareActionCard({
    serverId: server.id,
    requesterAgentId: ownerAgent.id,
    targetChannelId: channel.id,
    action: {
      type: "integration:recover_app_owner",
      clientKey,
      targetAgent: targetAgent.name,
      draftHint: "Recover a retired owner only.",
    },
  });
  await assert.rejects(
    executeActionCard({ webSessionFamilyId: null, messageId: card.messageId, serverId: asServerId(server.id), userId: human.id }),
    (err: unknown) => err instanceof Error && err.message.includes("active owner"),
  );

  await getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, ownerAgent.id));
  const recovered = await executeActionCard({ webSessionFamilyId: null,
    messageId: card.messageId,
    serverId: asServerId(server.id),
    userId: human.id,
  });
  assert.equal(recovered.metadata.result?.kind, "integration-app-owner-recovery");
  if (recovered.metadata.result?.kind !== "integration-app-owner-recovery") throw new Error("recovery result missing");
  assert.equal(recovered.metadata.result.ownerAgentId, targetAgent.id);
  const targetRotate = await rotateClientSecretForAgent({ serverId: server.id, clientKey, actorAgentId: targetAgent.id });
  assert.equal(targetRotate.status, "ok");
});

test("rotate-secret route: owner gets 200, same-server non-owner gets 403, and unknown stays 404", async ({ app }) => {
  const owner = await seedUser("rotate-route-owner@slock.test", "rotate-route-owner");
  const server = await createServer("Rotate Route Server", "rotate-route-server", owner.id);
  const agent = await createAgent(server.id, "rotate-route-agent", { runtime: "codex" });
  const otherAgent = await createAgent(server.id, "rotate-route-other", { runtime: "codex" });
  const thirdAgent = await createAgent(server.id, "rotate-route-third", { runtime: "codex" });
  const adminAgent = await createAgent(server.id, "rotate-route-admin", { runtime: "codex" });
  const fourthAgent = await createAgent(server.id, "rotate-route-fourth", { runtime: "codex" });
  await getDb().update(serverAgentMembers)
    .set({ role: "admin" })
    .where(and(
      eq(serverAgentMembers.serverId, server.id),
      eq(serverAgentMembers.agentId, adminAgent.id),
    ));
  const channel = await createChannel(server.id, "rotate-route-channel", undefined, "channel");
  await addHuman(channel.id, owner.id);
  await addAgent(channel.id, agent.id);

  const captured: CapturedNotice[] = [];
  const clientKey = "rotate-route-key";
  const registeredClient = await registerAppViaCard({
    baseUrl: app.baseUrl,
    serverId: server.id,
    ownerId: owner.id,
    agentId: agent.id,
    channelId: channel.id,
    clientKey,
    captured,
  });
  assert.ok(registeredClient);
  await getDb()
    .update(oauthClients)
    .set({ publishStatus: "publish_requested" })
    .where(eq(oauthClients.id, registeredClient.id));

  const ownerKey = (await mintAgentCredential({
    agentId: agent.id,
    scopes: ["read"],
    name: "rotate-route-owner-cred",
    issuedVia: "computer",
    createdByUserId: null,
  })).apiKey;
  const nonOwnerKey = (await mintAgentCredential({
    agentId: otherAgent.id,
    scopes: ["read"],
    name: "rotate-route-nonowner-cred",
    issuedVia: "computer",
    createdByUserId: null,
  })).apiKey;
  const thirdAgentKey = (await mintAgentCredential({
    agentId: thirdAgent.id,
    scopes: ["read"],
    name: "rotate-route-third-cred",
    issuedVia: "computer",
    createdByUserId: null,
  })).apiKey;
  const adminAgentKey = (await mintAgentCredential({
    agentId: adminAgent.id,
    scopes: ["read"],
    name: "rotate-route-admin-cred",
    issuedVia: "computer",
    createdByUserId: null,
  })).apiKey;
  const fourthAgentKey = (await mintAgentCredential({
    agentId: fourthAgent.id,
    scopes: ["read"],
    name: "rotate-route-fourth-cred",
    issuedVia: "computer",
    createdByUserId: null,
  })).apiKey;

  const ownerRes = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/rotate-secret`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey }),
  });
  assert.equal(ownerRes.status, 200, "owner agent rotate should be 200");
  const ownerBody = await ownerRes.json() as { clientKey: string; clientSecret: string };
  assert.equal(ownerBody.clientKey, clientKey);
  const authed = await authenticateOAuthClient(clientKey, ownerBody.clientSecret);
  assert.ok(authed, "secret returned by the route must authenticate");

  const nonOwnerRes = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/rotate-secret`, {
    method: "POST",
    headers: { Authorization: `Bearer ${nonOwnerKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey }),
  });
  assert.equal(nonOwnerRes.status, 403, "same-server non-owner agent gets a clear owner error");

  // Unknown key behaves identically (no existence disclosure).
  const unknownRes = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/rotate-secret`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: "does-not-exist-key" }),
  });
  assert.equal(unknownRes.status, 404, "unknown client key must be the same uniform 404");

  const ownerUpdateRes = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/update`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey, name: "Route Updated App", category: "Storage", publishStatus: "published" }),
  });
  assert.equal(ownerUpdateRes.status, 200, "owner can update directly");
  const ownerUpdateBody = await ownerUpdateRes.json() as { updatedFields: string[] };
  assert.deepEqual(ownerUpdateBody.updatedFields, ["name", "category"]);
  const [afterOwnerUpdate] = await getDb()
    .select({ publishStatus: oauthClients.publishStatus, category: oauthClients.category })
    .from(oauthClients)
    .where(eq(oauthClients.id, registeredClient.id));
  assert.equal(afterOwnerUpdate?.publishStatus, "publish_requested", "owner update cannot bypass marketplace review state");
  assert.equal(afterOwnerUpdate?.category, "Infrastructure", "legacy category aliases are stored canonically");

  const invalidCategoryRes = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/update`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey, category: "Automation" }),
  });
  assert.equal(invalidCategoryRes.status, 400, "unknown categories fail at the owner update boundary");

  const clearCallbackRes = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/update`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey, returnUrl: "" }),
  });
  assert.equal(clearCallbackRes.status, 400, "owner cannot remove the registered OAuth callback");
  const [afterClearAttempt] = await getDb()
    .select({ returnUrl: oauthClients.returnUrl })
    .from(oauthClients)
    .where(eq(oauthClients.id, registeredClient.id));
  assert.equal(afterClearAttempt?.returnUrl, "https://app.example/auth/raft/callback");

  const replacementCallback = "https://replacement.example/auth/raft/callback";
  const replaceCallbackRes = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/update`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey, returnUrl: replacementCallback }),
  });
  assert.equal(replaceCallbackRes.status, 200, "owner can replace the registered callback with another valid URL");

  const humanToken = await login(app.baseUrl, owner.email);
  const mismatchedAuthorize = await fetch(`${app.baseUrl}/api/oauth/authorize/human`, {
    method: "POST",
    headers: { Authorization: `Bearer ${humanToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: clientKey,
      serverId: server.id,
      returnUrl: "https://attacker.example/callback",
      scopes: ["openid", "profile"],
    }),
  });
  assert.equal(mismatchedAuthorize.status, 400, "authorization must reject a callback that does not match the replacement");
  const matchedAuthorize = await fetch(`${app.baseUrl}/api/oauth/authorize/human`, {
    method: "POST",
    headers: { Authorization: `Bearer ${humanToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: clientKey,
      serverId: server.id,
      returnUrl: replacementCallback,
      scopes: ["openid", "profile"],
    }),
  });
  assert.equal(matchedAuthorize.status, 200, "authorization accepts the exact replacement callback");

  const nonOwnerUpdateRes = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/update`, {
    method: "POST",
    headers: { Authorization: `Bearer ${nonOwnerKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey, category: "Business Ops" }),
  });
  assert.equal(nonOwnerUpdateRes.status, 403, "same-server non-owner update gets a clear owner error");

  const originalSameOwnerRes = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/transfer-owner`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey, targetAgent: agent.name }),
  });
  assert.equal(originalSameOwnerRes.status, 200, "an original same-owner request is an explicit audited no-op");
  const originalSameOwnerBody = await originalSameOwnerRes.json() as {
    ownershipOutcome: string;
    auditEventId: string;
    ownerAgentId: string;
  };
  assert.equal(originalSameOwnerBody.ownershipOutcome, "already_owner");
  assert.equal(originalSameOwnerBody.ownerAgentId, agent.id);
  assert.match(originalSameOwnerBody.auditEventId, /^[0-9a-f-]{36}$/);
  const [originalSameOwnerAudit] = await getDb().select({
    actorId: integrationAuditEvents.actorId,
    targetId: integrationAuditEvents.targetId,
    metadata: integrationAuditEvents.metadata,
  }).from(integrationAuditEvents).where(eq(integrationAuditEvents.id, originalSameOwnerBody.auditEventId));
  assert.equal(originalSameOwnerAudit?.actorId, agent.id);
  assert.equal(originalSameOwnerAudit?.targetId, agent.id);
  assert.equal(originalSameOwnerAudit?.metadata.ownershipOutcome, "already_owner");

  const transferRes = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/transfer-owner`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey, targetAgent: otherAgent.name }),
  });
  assert.equal(transferRes.status, 200, "owner can transfer directly");
  const transferBody = await transferRes.json() as {
    ownershipOutcome: string;
    auditEventId: string;
    ownerAgentId: string;
  };
  assert.equal(transferBody.ownershipOutcome, "transferred");
  assert.equal(transferBody.ownerAgentId, otherAgent.id);
  assert.notEqual(transferBody.auditEventId, originalSameOwnerBody.auditEventId);
  const [transferAudit] = await getDb().select({
    actorId: integrationAuditEvents.actorId,
    targetId: integrationAuditEvents.targetId,
    metadata: integrationAuditEvents.metadata,
  }).from(integrationAuditEvents).where(eq(integrationAuditEvents.id, transferBody.auditEventId));
  assert.equal(transferAudit?.actorId, agent.id);
  assert.equal(transferAudit?.targetId, otherAgent.id);
  assert.equal(transferAudit?.metadata.ownershipOutcome, "transferred");
  assert.equal(transferAudit?.metadata.actorAuthority, "owner");

  // Model a lost success response by issuing the exact command again from
  // the actor who performed the transfer. The displaced owner retains only
  // this same-target no-op replay and receives a fresh audit receipt.
  const replayRes = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/transfer-owner`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey, targetAgent: otherAgent.name }),
  });
  assert.equal(replayRes.status, 200, "lost-response replay by the owner transfer actor is auditable");
  const replayBody = await replayRes.json() as {
    ownershipOutcome: string;
    auditEventId: string;
    ownerAgentId: string;
  };
  assert.equal(replayBody.ownershipOutcome, "already_owner");
  assert.equal(replayBody.ownerAgentId, otherAgent.id);
  assert.notEqual(replayBody.auditEventId, transferBody.auditEventId);
  const [replayAudit] = await getDb().select({
    actorId: integrationAuditEvents.actorId,
    targetId: integrationAuditEvents.targetId,
    metadata: integrationAuditEvents.metadata,
  }).from(integrationAuditEvents).where(eq(integrationAuditEvents.id, replayBody.auditEventId));
  assert.equal(replayAudit?.actorId, agent.id);
  assert.equal(replayAudit?.targetId, otherAgent.id);
  assert.equal(replayAudit?.metadata.ownershipOutcome, "already_owner");
  assert.equal(replayAudit?.metadata.actorAuthority, "displaced_owner_replay");

  const divergentPreviousOwnerRes = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/transfer-owner`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey, targetAgent: agent.name }),
  });
  assert.equal(
    divergentPreviousOwnerRes.status,
    403,
    "owner transfer-actor replay cannot mutate ownership or target anyone except the current owner",
  );

  const oldOwnerAfterTransfer = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/rotate-secret`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey }),
  });
  assert.equal(oldOwnerAfterTransfer.status, 403, "old owner loses rotate after transfer");
  const newOwnerAfterTransfer = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/rotate-secret`, {
    method: "POST",
    headers: { Authorization: `Bearer ${nonOwnerKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey }),
  });
  assert.equal(newOwnerAfterTransfer.status, 200, "new owner gains rotate after transfer");

  const secondTransferRes = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/transfer-owner`, {
    method: "POST",
    headers: { Authorization: `Bearer ${nonOwnerKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey, targetAgent: thirdAgent.name }),
  });
  assert.equal(secondTransferRes.status, 200, "the current owner can continue the A→B→C chain");
  const secondTransferBody = await secondTransferRes.json() as {
    ownershipOutcome: string;
    ownerAgentId: string;
  };
  assert.equal(secondTransferBody.ownershipOutcome, "transferred");
  assert.equal(secondTransferBody.ownerAgentId, thirdAgent.id);

  // Revocation timestamps are not lineage. Force A and B's revoked owner
  // rows to the same legal DB value so any ORDER BY revoked_at inference is
  // ambiguous; the active C assignment provenance must remain authoritative.
  const identicalRevokedAt = new Date("2026-07-27T12:00:00.000Z");
  await getDb()
    .update(oauthClientMaintainers)
    .set({ revokedAt: identicalRevokedAt })
    .where(and(
      eq(oauthClientMaintainers.clientId, registeredClient.id),
      eq(oauthClientMaintainers.role, "owner"),
      isNotNull(oauthClientMaintainers.revokedAt),
    ));

  const staleOriginalOwnerReplay = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/transfer-owner`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey, targetAgent: thirdAgent.name }),
  });
  assert.equal(
    staleOriginalOwnerReplay.status,
    403,
    "A cannot replay A→C after A→B→C even when revoked owner timestamps tie",
  );

  await getDb()
    .update(oauthClientMaintainers)
    .set({ assignedByAuthority: null })
    .where(and(
      eq(oauthClientMaintainers.clientId, registeredClient.id),
      eq(oauthClientMaintainers.role, "owner"),
      isNull(oauthClientMaintainers.revokedAt),
    ));
  const legacyAssignmentReplay = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/transfer-owner`, {
    method: "POST",
    headers: { Authorization: `Bearer ${nonOwnerKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey, targetAgent: thirdAgent.name }),
  });
  assert.equal(legacyAssignmentReplay.status, 403, "missing transfer-time authority fails closed");

  await getDb()
    .update(oauthClientMaintainers)
    .set({ assignedByAuthority: "unknown" as "owner" })
    .where(and(
      eq(oauthClientMaintainers.clientId, registeredClient.id),
      eq(oauthClientMaintainers.role, "owner"),
      isNull(oauthClientMaintainers.revokedAt),
    ));
  const unknownAssignmentReplay = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/transfer-owner`, {
    method: "POST",
    headers: { Authorization: `Bearer ${nonOwnerKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey, targetAgent: thirdAgent.name }),
  });
  assert.equal(unknownAssignmentReplay.status, 403, "unknown transfer-time authority fails closed");

  await getDb()
    .update(oauthClientMaintainers)
    .set({ assignedByAuthority: "owner" })
    .where(and(
      eq(oauthClientMaintainers.clientId, registeredClient.id),
      eq(oauthClientMaintainers.role, "owner"),
      isNull(oauthClientMaintainers.revokedAt),
    ));

  const priorOwnerTransferActorReplay = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/transfer-owner`, {
    method: "POST",
    headers: { Authorization: `Bearer ${nonOwnerKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey, targetAgent: thirdAgent.name }),
  });
  assert.equal(priorOwnerTransferActorReplay.status, 200, "only transfer actor B can replay the B→C transfer");
  const priorOwnerTransferActorBody = await priorOwnerTransferActorReplay.json() as {
    ownershipOutcome: string;
    ownerAgentId: string;
  };
  assert.equal(priorOwnerTransferActorBody.ownershipOutcome, "already_owner");
  assert.equal(priorOwnerTransferActorBody.ownerAgentId, thirdAgent.id);

  const divergentPriorTransferActor = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/transfer-owner`, {
    method: "POST",
    headers: { Authorization: `Bearer ${nonOwnerKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey, targetAgent: agent.name }),
  });
  assert.equal(divergentPriorTransferActor.status, 403, "B replay authority is bound to current owner C only");

  const currentOwnerAfterChain = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/rotate-secret`, {
    method: "POST",
    headers: { Authorization: `Bearer ${thirdAgentKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey }),
  });
  assert.equal(currentOwnerAfterChain.status, 200, "C retains current-owner mutation authority after replay checks");

  const ownerTransferToAdminAgent = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/transfer-owner`, {
    method: "POST",
    headers: { Authorization: `Bearer ${thirdAgentKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey, targetAgent: adminAgent.name }),
  });
  assert.equal(ownerTransferToAdminAgent.status, 200, "owner C can transfer to admin agent X");

  const dualRoleOwnerTransfer = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/transfer-owner`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminAgentKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey, targetAgent: fourthAgent.name }),
  });
  assert.equal(dualRoleOwnerTransfer.status, 200, "current owner X can perform X→D while also a server admin");
  const dualRoleOwnerTransferBody = await dualRoleOwnerTransfer.json() as {
    auditEventId: string;
    ownershipOutcome: string;
    ownerAgentId: string;
  };
  assert.equal(dualRoleOwnerTransferBody.ownershipOutcome, "transferred");
  assert.equal(dualRoleOwnerTransferBody.ownerAgentId, fourthAgent.id);
  const [dualRoleOwnerTransferAudit] = await getDb()
    .select({ metadata: integrationAuditEvents.metadata })
    .from(integrationAuditEvents)
    .where(eq(integrationAuditEvents.id, dualRoleOwnerTransferBody.auditEventId));
  assert.equal(dualRoleOwnerTransferAudit?.metadata.actorAuthority, "owner");
  const [dualRoleAssignedOwner] = await getDb()
    .select({
      agentId: oauthClientMaintainers.agentId,
      assignedByType: oauthClientMaintainers.assignedByType,
      assignedById: oauthClientMaintainers.assignedById,
      assignedByAuthority: oauthClientMaintainers.assignedByAuthority,
    })
    .from(oauthClientMaintainers)
    .where(and(
      eq(oauthClientMaintainers.clientId, registeredClient.id),
      eq(oauthClientMaintainers.role, "owner"),
      isNull(oauthClientMaintainers.revokedAt),
    ));
  assert.deepEqual(dualRoleAssignedOwner, {
    agentId: fourthAgent.id,
    assignedByType: "agent",
    assignedById: adminAgent.id,
    assignedByAuthority: "owner",
  }, "a dual-role transfer actor records app-owner authority before server-admin authority");

  await getDb().update(serverAgentMembers)
    .set({ role: "member" })
    .where(and(
      eq(serverAgentMembers.serverId, server.id),
      eq(serverAgentMembers.agentId, adminAgent.id),
    ));
  const dualRoleOwnerReplayAfterAdminLoss = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/transfer-owner`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminAgentKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey, targetAgent: fourthAgent.name }),
  });
  assert.equal(
    dualRoleOwnerReplayAfterAdminLoss.status,
    200,
    "a dual-role owner transfer actor retains exact-target replay after losing server-admin role",
  );
  assert.equal(
    (await dualRoleOwnerReplayAfterAdminLoss.json() as { ownershipOutcome: string }).ownershipOutcome,
    "already_owner",
  );

  await getDb().update(serverAgentMembers)
    .set({ role: "admin" })
    .where(and(
      eq(serverAgentMembers.serverId, server.id),
      eq(serverAgentMembers.agentId, adminAgent.id),
    ));
  const nonOwnerAdminTransfer = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/transfer-owner`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminAgentKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey, targetAgent: thirdAgent.name }),
  });
  assert.equal(nonOwnerAdminTransfer.status, 200, "non-owner admin X can perform D→C using current admin authority");
  const nonOwnerAdminTransferBody = await nonOwnerAdminTransfer.json() as {
    auditEventId: string;
    ownershipOutcome: string;
    ownerAgentId: string;
  };
  assert.equal(nonOwnerAdminTransferBody.ownershipOutcome, "transferred");
  assert.equal(nonOwnerAdminTransferBody.ownerAgentId, thirdAgent.id);
  const [nonOwnerAdminTransferAudit] = await getDb()
    .select({ metadata: integrationAuditEvents.metadata })
    .from(integrationAuditEvents)
    .where(eq(integrationAuditEvents.id, nonOwnerAdminTransferBody.auditEventId));
  assert.equal(nonOwnerAdminTransferAudit?.metadata.actorAuthority, "admin");
  const [adminAssignedOwner] = await getDb()
    .select({
      agentId: oauthClientMaintainers.agentId,
      assignedByType: oauthClientMaintainers.assignedByType,
      assignedById: oauthClientMaintainers.assignedById,
      assignedByAuthority: oauthClientMaintainers.assignedByAuthority,
    })
    .from(oauthClientMaintainers)
    .where(and(
      eq(oauthClientMaintainers.clientId, registeredClient.id),
      eq(oauthClientMaintainers.role, "owner"),
      isNull(oauthClientMaintainers.revokedAt),
    ));
  assert.deepEqual(adminAssignedOwner, {
    agentId: thirdAgent.id,
    assignedByType: "agent",
    assignedById: adminAgent.id,
    assignedByAuthority: "admin",
  }, "a non-owner admin transfer actor records current server-admin authority");

  await getDb()
    .update(oauthClientMaintainers)
    .set({ revokedAt: identicalRevokedAt })
    .where(and(
      eq(oauthClientMaintainers.clientId, registeredClient.id),
      eq(oauthClientMaintainers.role, "owner"),
      isNotNull(oauthClientMaintainers.revokedAt),
    ));

  const adminReplay = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/transfer-owner`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminAgentKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey, targetAgent: thirdAgent.name }),
  });
  assert.equal(adminReplay.status, 200, "the admin transfer actor can replay while current admin authority remains");
  assert.equal((await adminReplay.json() as { ownershipOutcome: string }).ownershipOutcome, "already_owner");

  await getDb().update(serverAgentMembers)
    .set({ role: "member" })
    .where(and(
      eq(serverAgentMembers.serverId, server.id),
      eq(serverAgentMembers.agentId, adminAgent.id),
    ));
  const demotedAdminReplay = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/transfer-owner`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminAgentKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey, targetAgent: thirdAgent.name }),
  });
  assert.equal(demotedAdminReplay.status, 403, "an admin transfer actor cannot replay after losing admin authority");

  const displacedButNonActorOwnerReplay = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/transfer-owner`, {
    method: "POST",
    headers: { Authorization: `Bearer ${fourthAgentKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey, targetAgent: thirdAgent.name }),
  });
  assert.equal(
    displacedButNonActorOwnerReplay.status,
    403,
    "the owner displaced by an admin transfer cannot replay an operation it did not perform",
  );

  const currentOwnerAfterAdminTransfer = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/rotate-secret`, {
    method: "POST",
    headers: { Authorization: `Bearer ${thirdAgentKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey }),
  });
  assert.equal(currentOwnerAfterAdminTransfer.status, 200, "C retains current-owner authority after admin replay checks");
});

test("rotate is refused for a non-owner agent (and cross-server)", async ({ app }) => {
  const owner = await seedUser("rotate-nonowner-owner@slock.test", "rotate-nonowner-owner");
  const server = await createServer("Rotate NonOwner Server", "rotate-nonowner-server", owner.id);
  const agent = await createAgent(server.id, "rotate-nonowner-agent", { runtime: "codex" });
  const otherAgent = await createAgent(server.id, "rotate-other-agent", { runtime: "codex" });
  const channel = await createChannel(server.id, "rotate-nonowner-channel", undefined, "channel");
  await addHuman(channel.id, owner.id);
  await addAgent(channel.id, agent.id);

  const captured: CapturedNotice[] = [];
  const clientKey = "rotate-nonowner-key";
  await registerAppViaCard({
    baseUrl: app.baseUrl,
    serverId: server.id,
    ownerId: owner.id,
    agentId: agent.id,
    channelId: channel.id,
    clientKey,
    captured,
  });

  // (c) non-owner agent in the SAME server → null
  const byNonOwner = await rotateClientSecretForAgent({
    serverId: server.id,
    clientKey,
    actorAgentId: otherAgent.id,
  });
  assert.equal(byNonOwner.status, "owner_required", "a same-server non-owner gets a clear owner error");

  // (d) right agent, wrong serverId → null
  const otherOwner = await seedUser("rotate-cross-owner@slock.test", "rotate-cross-owner");
  const otherServer = await createServer("Rotate Cross Server", "rotate-cross-server", otherOwner.id);
  const crossServer = await rotateClientSecretForAgent({
    serverId: otherServer.id,
    clientKey,
    actorAgentId: agent.id,
  });
  assert.equal(crossServer.status, "not_found", "cross-server lookup remains non-enumerating");
});

test("rotate returns owner_required for an orphaned app with no active maintainer", async ({ app }) => {
  const owner = await seedUser("rotate-nullowner-owner@slock.test", "rotate-nullowner-owner");
  const server = await createServer("Rotate NullOwner Server", "rotate-nullowner-server", owner.id);
  const agent = await createAgent(server.id, "rotate-nullowner-agent", { runtime: "codex" });
  const channel = await createChannel(server.id, "rotate-nullowner-channel", undefined, "channel");
  await addHuman(channel.id, owner.id);
  await addAgent(channel.id, agent.id);

  const captured: CapturedNotice[] = [];
  const clientKey = "rotate-nullowner-key";
  const client = await registerAppViaCard({
    baseUrl: app.baseUrl,
    serverId: server.id,
    ownerId: owner.id,
    agentId: agent.id,
    channelId: channel.id,
    clientKey,
    captured,
  });
  assert.ok(client);

  // Simulate a human-registered / orphaned app: clear the owner.
  const db = getDb();
  await db
    .update(oauthClients)
    .set({ ownerAgentId: null })
    .where(eq(oauthClients.id, client.id));
  await db
    .update(oauthClientMaintainers)
    .set({ revokedAt: new Date() })
    .where(eq(oauthClientMaintainers.clientId, client.id));

  // (e) even the agent that "registered" it cannot rotate a null-owner app
  const result = await rotateClientSecretForAgent({
    serverId: server.id,
    clientKey,
    actorAgentId: agent.id,
  });
  assert.equal(result.status, "owner_required", "an orphaned app must not be agent-rotatable");
});

test("prepared login and Marketplace cards fail closed if the App becomes platform-managed before execution", async ({ app: _app }) => {
  const owner = await seedUser("platform-card-owner@slock.test", "platform-card-owner");
  const publisher = await createServer("Platform Card Publisher", "platform-card-publisher", owner.id);
  const target = await createServer("Platform Card Target", "platform-card-target", owner.id);
  const agent = await createAgent(target.id, "platform-card-agent", { runtime: "codex" });
  const channel = await createChannel(target.id, "platform-card-channel", undefined, "channel");
  await addHuman(channel.id, owner.id);
  await addAgent(channel.id, agent.id);

  const bindPlatformRegistration = (clientId: string, label: string) => getDb()
    .insert(externalAppRegistrations)
    .values({
      oauthClientId: clientId,
      provider: "slack",
      environment: "test",
      state: "active",
      providerAppId: `A_${label}`,
      providerOAuthClientId: `oauth-${label}`,
      capabilityManifestVersion: 1,
      capabilityManifestHash: `manifest-${label}`,
      requiredCapabilities: ["channel_events"],
    });

  const { client: loginClient } = await createOAuthClient({
    serverId: target.id,
    createdByUserId: owner.id,
    clientId: "platform-card-login",
    name: "Platform Card Login",
    returnUrl: "https://login.example.test/callback",
  });
  const [request] = await getDb().insert(oauthAccessRequests).values({
    serverId: target.id,
    principalType: "agent",
    agentId: agent.id,
    clientId: loginClient.id,
    scopes: ["openid"],
    status: "pending",
  }).returning();
  const loginCard = await prepareActionCard({
    serverId: target.id,
    requesterAgentId: agent.id,
    targetChannelId: channel.id,
    action: {
      type: "integration:approve_agent_login",
      requestId: request.id,
      agentId: agent.id,
      agentName: agent.name,
      clientId: loginClient.id,
      clientKey: loginClient.clientId,
      clientName: loginClient.name,
      scopes: ["openid"],
    },
  });
  await bindPlatformRegistration(loginClient.id, "LOGIN");
  await assert.rejects(
    executeActionCard({ webSessionFamilyId: null,
      messageId: loginCard.messageId,
      serverId: asServerId(target.id),
      userId: owner.id,
      expectedState: "prepared",
      orchestrator: captureOrchestrator([]),
    }),
    (error: unknown) => error instanceof Error && error.message === "Agent app login request not found",
  );
  assert.equal((await getDb().select().from(oauthGrants)
    .where(eq(oauthGrants.clientId, loginClient.id))).length, 0);
  assert.equal((await getDb().select().from(oauthAccessRequests)
    .where(eq(oauthAccessRequests.id, request.id)))[0]?.status, "pending");
  assert.equal((await getDb().select().from(actionCards)
    .where(eq(actionCards.messageId, loginCard.messageId)))[0]?.state, "prepared");

  const { client: marketplaceClient } = await createOAuthClient({
    serverId: publisher.id,
    createdByUserId: owner.id,
    clientId: "platform-card-marketplace",
    appType: "third_party_global",
    name: "Platform Card Marketplace",
    description: "Prepared before the platform registration is bound.",
    homepageUrl: "https://marketplace.example.test",
    returnUrl: "https://marketplace.example.test/callback",
    allowedScopes: ["openid"],
  });
  await getDb().update(oauthClients).set({
    publishStatus: "published",
    humanMarketplaceVisible: true,
  }).where(eq(oauthClients.id, marketplaceClient.id));
  const nameBinding = bindMarketplaceAppName(marketplaceClient.name);
  const installCard = await prepareActionCard({
    serverId: target.id,
    requesterAgentId: agent.id,
    targetChannelId: channel.id,
    action: {
      type: "integration:install_marketplace_app",
      clientId: marketplaceClient.id,
      clientKey: marketplaceClient.clientId,
      ...nameBinding,
      agentId: agent.id,
      agentName: agent.displayName ?? agent.name,
      scopes: ["openid"],
    },
  });
  await bindPlatformRegistration(marketplaceClient.id, "MARKETPLACE");
  await assert.rejects(
    executeActionCard({ webSessionFamilyId: null,
      messageId: installCard.messageId,
      serverId: asServerId(target.id),
      userId: owner.id,
      expectedState: "prepared",
      orchestrator: captureOrchestrator([]),
    }),
    (error: unknown) => error instanceof Error
      && error.message === "Marketplace app is no longer installable with this card; prepare a fresh login request",
  );
  assert.equal((await getDb().select().from(oauthClientInstalls).where(and(
    eq(oauthClientInstalls.serverId, target.id),
    eq(oauthClientInstalls.clientId, marketplaceClient.id),
  ))).length, 0);
  assert.equal((await getDb().select().from(actionCards)
    .where(eq(actionCards.messageId, installCard.messageId)))[0]?.state, "prepared");
});
