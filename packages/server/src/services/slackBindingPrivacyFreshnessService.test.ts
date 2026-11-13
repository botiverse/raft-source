import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import { getDb } from "../db/index";
import {
  channels,
  externalAppInstallServerGrants,
  externalAppInstalls,
  externalAppRegistrations,
  externalAppServerGrants,
  externalChannelBindings,
  oauthClientInstalls,
  oauthClients,
  users,
} from "../db/schema";
import { createServer } from "./serverService";
import {
  refreshSlackBindingPrivacy,
} from "./slackBindingPrivacyFreshnessService";
import {
  SLACK_BRIDGE_CREDENTIAL_LEASE_SCHEMA,
  type SlackProviderAuthorityFence,
  type SlackWebApiTransportResult,
} from "./slackProviderAdapter";
import type { SlackBridgeProviderRuntime } from "./slackBridgeProviderRuntime";

const NOW = new Date("2026-09-14T12:00:00.000Z");

beforeEach(async () => openTestDatabase("pglite://"));
afterEach(async () => closeTestDatabase());

async function seedPublicBinding() {
  const [owner] = await getDb().insert(users).values({
    email: `privacy-${randomUUID()}@raft.test`, name: `privacy-${randomUUID()}`,
    passwordHash: "hash", emailVerified: true,
  }).returning();
  const server = await createServer("Privacy Freshness", `privacy-${randomUUID()}`, owner.id);
  const [channel] = await getDb().insert(channels).values({ serverId: server.id, name: "bridge", type: "channel" }).returning();
  const [client] = await getDb().insert(oauthClients).values({
    serverId: server.id, clientId: `privacy-${randomUUID()}`, clientSecretHash: "hash",
    appType: "slock_builtin", name: "Slack Privacy", allowedScopes: ["channels:read"], createdByUserId: owner.id,
  }).returning();
  await getDb().insert(oauthClientInstalls).values({ serverId: server.id, clientId: client.id, installedByUserId: owner.id });
  const [registration] = await getDb().insert(externalAppRegistrations).values({
    oauthClientId: client.id, provider: "slack", environment: "test", providerAppId: "A_PRIVACY",
    providerOAuthClientId: `oauth-${randomUUID()}`, capabilityManifestVersion: 1,
    capabilityManifestHash: "privacy-v1", requiredCapabilities: ["channels"],
  }).returning();
  const [grant] = await getDb().insert(externalAppServerGrants).values({
    serverId: server.id, registrationId: registration.id, grantEpoch: 1,
    grantedManifestVersion: 1, grantedManifestHash: "privacy-v1", grantedCapabilities: ["channels"],
    grantedByType: "human", grantedById: owner.id,
  }).returning();
  const [install] = await getDb().insert(externalAppInstalls).values({
    serverId: server.id, registrationId: registration.id, serverGrantId: grant.id, grantEpoch: 1,
    state: "active", connectionEpoch: 1, scopeRevision: 1, credentialRevision: 1,
    installedScopes: ["channels:read"], providerAppId: "A_PRIVACY", providerTeamId: "T_PRIVACY",
    authorityType: "team", providerAuthorityId: "T_PRIVACY", botUserId: "U_BOT",
  }).returning();
  await getDb().insert(externalAppInstallServerGrants).values({
    installId: install.id, serverId: server.id, registrationId: registration.id,
    serverGrantId: grant.id, grantEpoch: grant.grantEpoch, state: "active",
    authorizedByType: "human", authorizedById: owner.id,
  });
  const [binding] = await getDb().insert(externalChannelBindings).values({
    serverId: server.id, registrationId: registration.id, installId: install.id, channelId: channel.id,
    providerConversationId: "C_PRIVACY", providerConversationKind: "public_channel", privacyClass: "public",
    state: "active", grantEpoch: 1, connectionEpoch: 1, bindingEpoch: 1,
    consentedByType: "human", consentedById: owner.id, consentedAt: NOW,
    privacyFreshUntil: new Date(NOW.getTime() - 1),
  }).returning();
  return { binding, server, channel, grant };
}

function provider(
  result: SlackWebApiTransportResult,
  calls?: { value: number },
): SlackBridgeProviderRuntime {
  return {
    credentialResolver: {
      async resolve({ authority, now }: { authority: SlackProviderAuthorityFence; now: Date }) {
        return {
          schema: SLACK_BRIDGE_CREDENTIAL_LEASE_SCHEMA,
          leaseId: "lease-privacy",
          installId: authority.installId,
          providerAppId: authority.providerAppId,
          providerAuthorityId: authority.providerAuthorityId,
          connectionEpoch: authority.connectionEpoch,
          credentialRevision: authority.credentialRevision,
          leaseExpiresAt: new Date(now.getTime() + 60_000),
        };
      },
    },
    transport: { evidence: "live", async call() { if (calls) calls.value += 1; return result; } },
    quarantineSink: { async quarantine() { return "applied"; } },
    async releaseCredential() {},
  } as unknown as SlackBridgeProviderRuntime;
}

test("fresh public observation keeps the binding active and extends only privacy freshness", async () => {
  const { binding } = await seedPublicBinding();
  const receipt = await refreshSlackBindingPrivacy({
    bindingId: binding.id, provider: provider({ kind: "response", status: 200, headers: {}, body: {
      ok: true, channel: { id: "C_PRIVACY", is_private: false, is_archived: false, is_member: true },
    } }), now: NOW,
  });
  assert.equal(receipt.kind, "fresh");
  const [row] = await getDb().select().from(externalChannelBindings).where(eq(externalChannelBindings.id, binding.id));
  assert.equal(row.state, "active");
  assert.equal(row.privacyClass, "public");
  assert.equal(row.providerConversationKind, "public_channel");
  assert.equal(row.privacyFreshUntil.getTime(), NOW.getTime() + 10 * 60_000);
});

test("public to private observation records the new class in place and stays active", async () => {
  const { binding } = await seedPublicBinding();
  const receipt = await refreshSlackBindingPrivacy({
    bindingId: binding.id, provider: provider({ kind: "response", status: 200, headers: {}, body: {
      ok: true, channel: { id: "C_PRIVACY", is_private: true, is_archived: false, is_member: true },
    } }), now: NOW,
  });
  assert.equal(receipt.kind, "changed");
  const [row] = await getDb().select().from(externalChannelBindings).where(eq(externalChannelBindings.id, binding.id));
  assert.equal(row.state, "active");
  assert.equal(row.stateReason, null);
  assert.equal(row.privacyClass, "private");
  assert.equal(row.providerConversationKind, "private_channel");
  assert.equal(row.privacyFreshUntil.getTime(), NOW.getTime() + 10 * 60_000);
  assert.equal(row.bindingEpoch, binding.bindingEpoch, "a visibility flip is not an authority change");
});

test("provider unavailable never extends stale privacy or mutates binding identity", async () => {
  const { binding } = await seedPublicBinding();
  const receipt = await refreshSlackBindingPrivacy({
    bindingId: binding.id,
    provider: provider({ kind: "transport_failure", phase: "before_send", code: "unavailable" }),
    now: NOW,
  });
  assert.equal(receipt.kind, "unavailable");
  const [row] = await getDb().select().from(externalChannelBindings).where(eq(externalChannelBindings.id, binding.id));
  assert.equal(row.state, "active");
  assert.equal(row.privacyClass, "public");
  assert.equal(row.bindingEpoch, 1);
  assert.equal(row.privacyFreshUntil.getTime(), NOW.getTime() - 1);
});

test("stale server-grant epoch cannot extend privacy freshness or call Slack", async () => {
  const { binding, grant } = await seedPublicBinding();
  await getDb().update(externalAppServerGrants).set({ grantEpoch: grant.grantEpoch + 1 })
    .where(eq(externalAppServerGrants.id, grant.id));
  const calls = { value: 0 };
  const receipt = await refreshSlackBindingPrivacy({
    bindingId: binding.id,
    provider: provider({
      kind: "response",
      status: 200,
      headers: {},
      body: { ok: true, channel: { id: "C_PRIVACY", is_private: false } },
    }, calls),
    now: NOW,
  });

  assert.deepEqual(receipt, {
    kind: "unavailable",
    bindingId: binding.id,
    reason: "authority_quarantined",
  });
  assert.equal(calls.value, 0);
  const [row] = await getDb().select().from(externalChannelBindings)
    .where(eq(externalChannelBindings.id, binding.id));
  assert.equal(row.privacyFreshUntil.getTime(), NOW.getTime() - 1);
  assert.equal(row.state, "active");
  assert.equal(row.bindingEpoch, binding.bindingEpoch);
});

test("provider rate limit preserves retry timing without blessing stale privacy", async () => {
  const { binding } = await seedPublicBinding();
  const receipt = await refreshSlackBindingPrivacy({
    bindingId: binding.id,
    provider: provider({
      kind: "response",
      status: 429,
      headers: { "retry-after": "120" },
      body: { ok: false, error: "ratelimited" },
    }),
    now: NOW,
  });
  assert.deepEqual(receipt, {
    kind: "unavailable",
    bindingId: binding.id,
    reason: "provider_rate_limited",
    retryAfterMs: 120_000,
  });
  const [row] = await getDb().select().from(externalChannelBindings)
    .where(eq(externalChannelBindings.id, binding.id));
  assert.equal(row.privacyFreshUntil.getTime(), NOW.getTime() - 1);
  assert.equal(row.state, "active");
});
