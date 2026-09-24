import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, test } from "vitest";
import { eq } from "drizzle-orm";
import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";

import { closeDatabase, getDb, initDatabase } from "../db/index.js";
import {
  channels,
  externalAppInstalls,
  externalAppRegistrations,
  externalAppServerGrants,
  externalChannelBindings,
  externalMessageLinks,
  externalReactionCommandAttempts,
  externalReactionCommands,
  featureFlagRules,
  featureFlags,
  messages,
  oauthClients,
  servers,
  users,
} from "../db/schema.js";
import { enqueueSlackReactionAggregateTransition } from "./externalReactionSyncService.js";
import {
  __resetExternalReactionCommandHandlerForTests,
  installExternalReactionCommandHandler,
} from "./externalReactionCommandRuntime.js";
import { updateFeatureFlag } from "./featureFlagService.js";
import { processExternalReactionCommandOnce } from "./externalReactionWorkerService.js";
import { mutateMessageReaction } from "./messageReactionService.js";
import type { SlackBridgeProviderRuntime } from "./slackBridgeProviderRuntime.js";
import {
  SLACK_BRIDGE_CREDENTIAL_LEASE_SCHEMA,
  type SlackWebApiRequest,
  type SlackWebApiTransportResult,
} from "./slackProviderAdapter.js";

const NOW = new Date("2026-09-05T05:00:00.000Z");

beforeEach(async () => { await initDatabase("pglite://"); });
afterEach(async () => {
  __resetExternalReactionCommandHandlerForTests();
  await closeDatabase();
});

async function fixture() {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `reaction-worker-${randomUUID()}@raft.test`,
    name: `reaction-worker-${randomUUID()}`,
    passwordHash: "test",
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Reaction worker",
    slug: `reaction-worker-${randomUUID()}`,
    ownerId: owner.id,
  }).returning();
  const [channel] = await db.insert(channels).values({ serverId: server.id, name: "reaction", type: "channel" }).returning();
  const [message] = await db.insert(messages).values({
    channelId: channel.id, senderType: "user", senderId: owner.id, content: "react", messageType: "chat",
  }).returning();
  const [client] = await db.insert(oauthClients).values({
    serverId: server.id,
    clientId: `reaction-${randomUUID()}`,
    clientSecretHash: "hash",
    appType: "slock_builtin",
    name: "Slack",
    createdByUserId: owner.id,
  }).returning();
  const [registration] = await db.insert(externalAppRegistrations).values({
    oauthClientId: client.id,
    provider: "slack",
    environment: "test",
    providerAppId: "A_REACTION",
    providerOAuthClientId: "reaction-client",
    capabilityManifestVersion: 1,
    capabilityManifestHash: "manifest",
    requiredCapabilities: [],
  }).returning();
  const [grant] = await db.insert(externalAppServerGrants).values({
    serverId: server.id,
    registrationId: registration.id,
    state: "active",
    grantEpoch: 1,
    grantedManifestVersion: 1,
    grantedManifestHash: "manifest",
    grantedCapabilities: [],
    grantedByType: "human",
    grantedById: owner.id,
  }).returning();
  const [install] = await db.insert(externalAppInstalls).values({
    serverId: server.id,
    registrationId: registration.id,
    serverGrantId: grant.id,
    grantEpoch: 1,
    state: "active",
    connectionEpoch: 1,
    scopeRevision: 1,
    credentialRevision: 1,
    installedScopes: ["reactions:read", "reactions:write"],
    providerAppId: "A_REACTION",
    providerTeamId: "T_REACTION",
    authorityType: "team",
    providerAuthorityId: "T_REACTION",
    botUserId: "U_BOT",
    providerBotId: "B_BOT",
  }).returning();
  const [binding] = await db.insert(externalChannelBindings).values({
    serverId: server.id,
    registrationId: registration.id,
    installId: install.id,
    channelId: channel.id,
    providerConversationId: "C_REACTION",
    providerConversationKind: "public_channel",
    privacyClass: "public",
    state: "active",
    grantEpoch: 1,
    connectionEpoch: 1,
    bindingEpoch: 1,
    consentedByType: "human",
    consentedById: owner.id,
    consentedAt: NOW,
  }).returning();
  const [link] = await db.insert(externalMessageLinks).values({
    provider: "slack",
    installId: install.id,
    providerAuthorityId: "T_REACTION",
    providerConversationId: "C_REACTION",
    providerMessageId: "1788574800.000100",
    bindingId: binding.id,
    bindingEpoch: 1,
    connectionEpoch: 1,
    raftMessageId: message.id,
    firstDirection: "raft_outbound",
    payloadFingerprint: "a".repeat(64),
    outcomeState: "accepted",
    authorityState: "active",
  }).returning();
  const [reactionFlag] = await db.select().from(featureFlags)
    .where(eq(featureFlags.key, SLACK_BRIDGE_FEATURE_FLAG_KEYS.reactionSync));
  assert.equal(reactionFlag?.enabled, true);
  assert.equal(reactionFlag?.defaultEnabled, false);
  assert.equal(reactionFlag?.killSwitch, false);
  assert.equal(reactionFlag?.randomizationUnit, "server");
  for (const key of [SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, SLACK_BRIDGE_FEATURE_FLAG_KEYS.reactionSync]) {
    assert.ok(await updateFeatureFlag(key, { enabled: true, killSwitch: false }));
    await db.insert(featureFlagRules).values({
      flagKey: key,
      stage: "server",
      priority: 100,
      decision: "allow",
      values: [server.id],
    });
  }
  await db.transaction((tx) => enqueueSlackReactionAggregateTransition({
    tx,
    raftMessageId: message.id,
    canonicalEmoji: "👍",
    localDiscussionVersion: 1,
    localAggregateCount: 1,
    desiredPresent: true,
    now: NOW,
  }));
  return { db, owner, install, binding, link };
}

function provider(outcomes: SlackWebApiTransportResult[]) {
  const calls: SlackWebApiRequest[] = [];
  const runtime = {
    credentialResolver: {
      async resolve({ authority, now }: { authority: SlackWebApiRequest["authority"]; now: Date }) {
        return {
          schema: SLACK_BRIDGE_CREDENTIAL_LEASE_SCHEMA,
          leaseId: randomUUID(),
          installId: authority.installId,
          providerAppId: authority.providerAppId,
          providerAuthorityId: authority.providerAuthorityId,
          connectionEpoch: authority.connectionEpoch,
          credentialRevision: authority.credentialRevision,
          leaseExpiresAt: new Date(now.getTime() + 60_000),
        };
      },
    },
    transport: {
      evidence: "live" as const,
      async call(request: SlackWebApiRequest) {
        calls.push(request);
        const next = outcomes.shift();
        if (!next) throw new Error("missing provider outcome");
        return next;
      },
    },
    async releaseCredential() {},
  } as unknown as SlackBridgeProviderRuntime;
  return { runtime, calls };
}

test("aggregate transition creates one command and successful add closes one exact receipt", async () => {
  const state = await fixture();
  const p = provider([{
    kind: "response", status: 200, headers: {}, body: { ok: true },
    observedAuthority: { providerAppId: "A_REACTION", providerAuthorityId: "T_REACTION" },
  }]);
  const result = await processExternalReactionCommandOnce({
    db: state.db, provider: p.runtime, leaseOwner: "reaction-worker", now: () => NOW,
  });
  assert.equal(result.kind, "attempted");
  assert.deepEqual(p.calls.map((call) => ({ method: call.method, body: call.body })), [{
    method: "reactions.add",
    body: { channel: "C_REACTION", timestamp: "1788574800.000100", name: "thumbsup" },
  }]);
  const [command] = await state.db.select().from(externalReactionCommands);
  const [attempt] = await state.db.select().from(externalReactionCommandAttempts);
  assert.equal(command.state, "accepted");
  assert.equal(attempt.outcome, "accepted");
});

test("after-send ambiguity never repeats add and authenticated bot presence reconciles it", async () => {
  const state = await fixture();
  const p = provider([{
    kind: "transport_failure", phase: "after_send", code: "timeout",
  }, {
    kind: "response", status: 200, headers: {}, body: {
      ok: true,
      message: { reactions: [{ name: "thumbsup", count: 1, users: ["U_BOT"] }] },
    },
    observedAuthority: { providerAppId: "A_REACTION", providerAuthorityId: "T_REACTION" },
  }]);
  const first = await processExternalReactionCommandOnce({
    db: state.db, provider: p.runtime, leaseOwner: "reaction-worker", now: () => NOW,
  });
  assert.equal(first.kind, "attempted");
  const later = new Date(NOW.getTime() + 30_000);
  const second = await processExternalReactionCommandOnce({
    db: state.db, provider: p.runtime, leaseOwner: "reaction-worker", now: () => later,
  });
  assert.equal(second.kind, "attempted");
  assert.deepEqual(p.calls.map((call) => call.method), ["reactions.add", "reactions.get"]);
  const [command] = await state.db.select().from(externalReactionCommands);
  assert.equal(command.state, "accepted");
  const attempts = await state.db.select().from(externalReactionCommandAttempts)
    .orderBy(externalReactionCommandAttempts.attemptNumber);
  assert.deepEqual(attempts.map((attempt) => attempt.outcome), ["outcome_unknown", "reconciled_present"]);
});

test("already reacted closes desired-present while custom Unicode records unsupported without provider I/O", async () => {
  const state = await fixture();
  const p = provider([{
    kind: "response", status: 200, headers: {}, body: { ok: false, error: "already_reacted" },
    observedAuthority: { providerAppId: "A_REACTION", providerAuthorityId: "T_REACTION" },
  }]);
  await processExternalReactionCommandOnce({
    db: state.db, provider: p.runtime, leaseOwner: "reaction-worker", now: () => NOW,
  });
  const [attempt] = await state.db.select().from(externalReactionCommandAttempts);
  assert.equal(attempt.outcome, "already_satisfied");

  await state.db.transaction((tx) => enqueueSlackReactionAggregateTransition({
    tx,
    raftMessageId: (state.link as typeof state.link).raftMessageId,
    canonicalEmoji: "🦄",
    localDiscussionVersion: 2,
    localAggregateCount: 1,
    desiredPresent: true,
    now: NOW,
  }));
  const unsupported = await state.db.select().from(externalReactionCommands)
    .where(eq(externalReactionCommands.canonicalEmoji, "🦄"));
  assert.equal(unsupported[0]?.state, "deterministic_failure");
  assert.equal(p.calls.length, 1);
});

test("local aggregate emits only 0-to-1 add and 1-to-0 remove commands", async () => {
  const state = await fixture();
  await state.db.delete(externalReactionCommands);
  installExternalReactionCommandHandler(enqueueSlackReactionAggregateTransition);
  const first = state.owner.id;
  const [secondUser] = await state.db.insert(users).values({
    email: `reaction-second-${randomUUID()}@raft.test`,
    name: `reaction-second-${randomUUID()}`,
    passwordHash: "test",
  }).returning();
  const second = secondUser.id;
  await mutateMessageReaction({ messageId: state.link.raftMessageId, emoji: "👍", actor: { kind: "user", id: first }, operation: "add" });
  await mutateMessageReaction({ messageId: state.link.raftMessageId, emoji: "👍", actor: { kind: "user", id: second }, operation: "add" });
  await mutateMessageReaction({ messageId: state.link.raftMessageId, emoji: "👍", actor: { kind: "user", id: first }, operation: "remove" });
  await mutateMessageReaction({ messageId: state.link.raftMessageId, emoji: "👍", actor: { kind: "user", id: second }, operation: "remove" });
  const commands = await state.db.select().from(externalReactionCommands)
    .orderBy(externalReactionCommands.desiredRevision);
  assert.deepEqual(commands.map((command) => ({
    revision: command.desiredRevision,
    desiredPresent: command.desiredPresent,
    localAggregateCount: command.localAggregateCount,
    state: command.state,
  })), [
    { revision: 1, desiredPresent: true, localAggregateCount: 1, state: "superseded" },
    { revision: 2, desiredPresent: false, localAggregateCount: 0, state: "queued" },
  ]);
});

test("provider 429 honors Retry-After without converting the desired state to terminal failure", async () => {
  const state = await fixture();
  const p = provider([{
    kind: "response",
    status: 429,
    headers: { "retry-after": "2" },
    body: { ok: false, error: "ratelimited" },
    observedAuthority: { providerAppId: "A_REACTION", providerAuthorityId: "T_REACTION" },
  }]);
  const result = await processExternalReactionCommandOnce({
    db: state.db, provider: p.runtime, leaseOwner: "reaction-worker", now: () => NOW,
  });
  assert.equal(result.kind, "attempted");
  const [command] = await state.db.select().from(externalReactionCommands);
  const [attempt] = await state.db.select().from(externalReactionCommandAttempts);
  assert.equal(command.state, "retry_wait");
  assert.equal(command.nextAttemptAt.toISOString(), new Date(NOW.getTime() + 2_000).toISOString());
  assert.equal(attempt.outcome, "rate_limited");
  assert.equal(attempt.retryAfterMs, 2_000);
});
