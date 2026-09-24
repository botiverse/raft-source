import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach } from "vitest";

import { eq } from "drizzle-orm";

import { getDb } from "../db/index.js";
import {
  externalAppCredentials,
  externalAppInstallGrantReceipts,
  externalAppInstalls,
  externalAppRegistrations,
  externalAppServerGrants,
  oauthClients,
  users,
} from "../db/schema.js";
import { SLACK_BRIDGE_REQUIRED_BOT_SCOPES } from "../routes/slackBridge.js";
import { createServer } from "./serverService.js";
import {
  refreshSlackBridgeInstallGrantReceipts,
  slackBridgeInstallGrantHash,
} from "./slackBridgeInstallGrantService.js";
import type { SlackBridgeProvisioningProvider } from "./slackBridgeProvisioningControlPlane.js";


const NOW = new Date("2026-08-12T08:00:00.000Z");
const SCOPES = [...SLACK_BRIDGE_REQUIRED_BOT_SCOPES];

afterEach(async () => {
  await closeTestDatabase();
});

async function fixture() {
  await openTestDatabase("pglite://");
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `install-grant-${randomUUID()}@test.invalid`,
    name: `install-grant-${randomUUID()}`,
    passwordHash: "test-only",
    emailVerified: true,
  }).returning();
  const server = await createServer("Install Grant", `install-grant-${randomUUID()}`, owner.id);
  const [client] = await db.insert(oauthClients).values({
    serverId: server.id,
    clientId: `install-grant-${randomUUID()}`,
    clientSecretHash: "test-only",
    appType: "slock_builtin",
    name: "Slack Bridge",
    allowedScopes: [],
    createdByUserId: owner.id,
  }).returning();
  const [registration] = await db.insert(externalAppRegistrations).values({
    oauthClientId: client.id,
    provider: "slack",
    environment: "test",
    providerAppId: "A_INSTALL_GRANT",
    providerOAuthClientId: "install-grant-client",
    capabilityManifestVersion: 1,
    capabilityManifestHash: "internal-capability-v1",
    requiredCapabilities: ["channel_events"],
  }).returning();
  const [grant] = await db.insert(externalAppServerGrants).values({
    serverId: server.id,
    registrationId: registration.id,
    state: "active",
    grantEpoch: 1,
    grantedManifestVersion: 1,
    grantedManifestHash: "internal-capability-v1",
    grantedCapabilities: ["channel_events"],
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
    installedScopes: SCOPES,
    providerAppId: "A_INSTALL_GRANT",
    providerTeamId: "T_INSTALL_GRANT",
    authorityType: "team",
    providerAuthorityId: "T_INSTALL_GRANT",
    botUserId: "U_INSTALL_GRANT",
    providerBotId: "B_INSTALL_GRANT",
  }).returning();
  await db.insert(externalAppCredentials).values({
    installId: install.id,
    state: "active",
    encryptedMaterial: "sealed-test-only",
    envelopeKeyId: "test-only",
    aadVersion: 1,
    credentialRevision: 1,
  });
  await db.insert(externalAppInstallGrantReceipts).values({
    registrationId: registration.id,
    installId: install.id,
    receiptRevision: 1,
    connectionEpoch: 1,
    scopeRevision: 1,
    credentialRevision: 1,
    providerAppId: "A_INSTALL_GRANT",
    providerAuthorityId: "T_INSTALL_GRANT",
    botUserId: "U_INSTALL_GRANT",
    providerBotId: "B_INSTALL_GRANT",
    grantedScopes: SCOPES,
    grantHash: slackBridgeInstallGrantHash({
      providerAppId: "A_INSTALL_GRANT",
      providerAuthorityId: "T_INSTALL_GRANT",
      botUserId: "U_INSTALL_GRANT",
      providerBotId: "B_INSTALL_GRANT",
      grantedScopes: SCOPES,
    }),
    observationSource: "token_introspection",
    status: "valid",
    observedAt: new Date(NOW.getTime() - 20 * 60_000),
    expiresAt: new Date(NOW.getTime() + 5 * 60_000),
  });
  return { db, install };
}

function provider(
  read: SlackBridgeProvisioningProvider["readInstallGrant"],
): SlackBridgeProvisioningProvider {
  return {
    readInstallGrant: read,
    async readWorkspace() {
      return { kind: "unverified" };
    },
    async readConversationAudience() {
      return { kind: "unverified" };
    },
  };
}

const FACT = {
  providerAppId: "A_INSTALL_GRANT",
  providerAuthorityId: "T_INSTALL_GRANT",
  botUserId: "U_INSTALL_GRANT",
  providerBotId: "B_INSTALL_GRANT",
  grantedScopes: SCOPES,
};

test("fresh provider read renews once while concurrent writers cannot duplicate the receipt revision", async () => {
  const { db, install } = await fixture();
  let reads = 0;
  const grantProvider = provider(async () => {
    reads += 1;
    return { kind: "fact", fact: FACT };
  });
  await Promise.all([
    refreshSlackBridgeInstallGrantReceipts({ db, provider: grantProvider, now: NOW }),
    refreshSlackBridgeInstallGrantReceipts({ db, provider: grantProvider, now: NOW }),
  ]);
  const receipts = await db.select().from(externalAppInstallGrantReceipts)
    .where(eq(externalAppInstallGrantReceipts.installId, install.id));
  assert.equal(receipts.length, 2);
  assert.deepEqual(receipts.map((receipt) => receipt.receiptRevision).sort(), [1, 2]);
  assert.equal(receipts.at(-1)?.observedAt.getTime(), NOW.getTime());
  assert.equal(reads, 1, "the install lease must admit exactly one provider read");
});

test("fresh provider read repairs a prior receipt whose hash contradicts its bound grant", async () => {
  const { db, install } = await fixture();
  const tamperedHash = "0".repeat(64);
  await db.update(externalAppInstallGrantReceipts).set({
    grantHash: tamperedHash,
  }).where(eq(externalAppInstallGrantReceipts.installId, install.id));

  const result = await refreshSlackBridgeInstallGrantReceipts({
    db,
    provider: provider(async () => ({ kind: "fact", fact: FACT })),
    now: NOW,
  });

  assert.equal(result.renewed, 1);
  const receipts = await db.select().from(externalAppInstallGrantReceipts)
    .where(eq(externalAppInstallGrantReceipts.installId, install.id));
  assert.equal(receipts.length, 2);
  const latest = receipts.sort((left, right) => right.receiptRevision - left.receiptRevision)[0]!;
  assert.equal(latest.receiptRevision, 2);
  assert.notEqual(latest.grantHash, tamperedHash);
  assert.equal(latest.grantHash, slackBridgeInstallGrantHash(latest));
});

test("provider failure never extends an expired receipt", async () => {
  const { db, install } = await fixture();
  await db.update(externalAppInstallGrantReceipts).set({
    expiresAt: new Date(NOW.getTime() - 1),
  }).where(eq(externalAppInstallGrantReceipts.installId, install.id));
  const result = await refreshSlackBridgeInstallGrantReceipts({
    db,
    provider: provider(async () => ({ kind: "unverified" })),
    now: NOW,
  });
  assert.equal(result.failed, 1);
  const receipts = await db.select().from(externalAppInstallGrantReceipts)
    .where(eq(externalAppInstallGrantReceipts.installId, install.id));
  assert.equal(receipts.length, 1);
  assert.ok(receipts[0]!.expiresAt < NOW);
});

test("a fresh provider observation with a removed scope never renews the prior receipt", async () => {
  const { db, install } = await fixture();
  const result = await refreshSlackBridgeInstallGrantReceipts({
    db,
    provider: provider(async () => ({
      kind: "fact",
      fact: {
        ...FACT,
        grantedScopes: SCOPES.slice(1),
      },
    })),
    now: NOW,
  });
  assert.equal(result.failed, 1);
  const receipts = await db.select().from(externalAppInstallGrantReceipts)
    .where(eq(externalAppInstallGrantReceipts.installId, install.id));
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.receiptRevision, 1);
  assert.equal(receipts[0]?.expiresAt.getTime(), NOW.getTime() + 5 * 60_000);
});

test("a provider observation cannot substitute the durable app authority", async () => {
  const { db, install } = await fixture();
  const result = await refreshSlackBridgeInstallGrantReceipts({
    db,
    provider: provider(async () => ({
      kind: "fact",
      fact: {
        ...FACT,
        providerAppId: "A_OTHER_WITH_SAME_TEAM_AND_BOT",
      },
    })),
    now: NOW,
  });
  assert.equal(result.failed, 1);
  const receipts = await db.select().from(externalAppInstallGrantReceipts)
    .where(eq(externalAppInstallGrantReceipts.installId, install.id));
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.providerAppId, "A_INSTALL_GRANT");
});

test("a legacy null provider bot id is filled once by the current exact grant", async () => {
  const { db, install } = await fixture();
  await db.update(externalAppInstalls).set({
    providerBotId: null,
  }).where(eq(externalAppInstalls.id, install.id));
  await db.update(externalAppInstallGrantReceipts).set({
    expiresAt: new Date(NOW.getTime() + 1),
  }).where(eq(externalAppInstallGrantReceipts.installId, install.id));

  const result = await refreshSlackBridgeInstallGrantReceipts({
    db,
    provider: provider(async () => ({ kind: "fact", fact: FACT })),
    now: NOW,
  });

  assert.equal(result.renewed, 1);
  const [updated] = await db.select().from(externalAppInstalls)
    .where(eq(externalAppInstalls.id, install.id));
  assert.equal(updated?.providerBotId, "B_INSTALL_GRANT");
  const receipts = await db.select().from(externalAppInstallGrantReceipts)
    .where(eq(externalAppInstallGrantReceipts.installId, install.id));
  assert.equal(receipts.length, 2);
});

test("a non-null provider bot mismatch fails closed and is never overwritten", async () => {
  const { db, install } = await fixture();
  await db.update(externalAppInstalls).set({
    providerBotId: "B_DIFFERENT",
  }).where(eq(externalAppInstalls.id, install.id));

  const result = await refreshSlackBridgeInstallGrantReceipts({
    db,
    provider: provider(async () => ({ kind: "fact", fact: FACT })),
    now: NOW,
  });

  assert.equal(result.failed, 1);
  const [unchanged] = await db.select().from(externalAppInstalls)
    .where(eq(externalAppInstalls.id, install.id));
  assert.equal(unchanged?.providerBotId, "B_DIFFERENT");
  const receipts = await db.select().from(externalAppInstallGrantReceipts)
    .where(eq(externalAppInstallGrantReceipts.installId, install.id));
  assert.equal(receipts.length, 1);
});

test("a stale provider response after reinstall/rebind loses the revision CAS and writes no receipt", async () => {
  const { db, install } = await fixture();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const renewal = refreshSlackBridgeInstallGrantReceipts({
    db,
    provider: provider(async () => {
      await wait;
      return { kind: "fact", fact: FACT };
    }),
    now: NOW,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await db.update(externalAppInstalls).set({
    connectionEpoch: 2,
  }).where(eq(externalAppInstalls.id, install.id));
  release();
  await renewal;
  const receipts = await db.select().from(externalAppInstallGrantReceipts)
    .where(eq(externalAppInstallGrantReceipts.installId, install.id));
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.connectionEpoch, 1);
});

test("a stale provider response after credential rotation loses the credential CAS and writes no receipt", async () => {
  const { db, install } = await fixture();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const renewal = refreshSlackBridgeInstallGrantReceipts({
    db,
    provider: provider(async () => {
      await wait;
      return { kind: "fact", fact: FACT };
    }),
    now: NOW,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await db.transaction(async (tx) => {
    await tx.update(externalAppInstalls).set({
      credentialRevision: 2,
    }).where(eq(externalAppInstalls.id, install.id));
    await tx.update(externalAppCredentials).set({
      encryptedMaterial: "sealed-rotated-test-only",
      credentialRevision: 2,
    }).where(eq(externalAppCredentials.installId, install.id));
  });
  release();
  await renewal;
  const receipts = await db.select().from(externalAppInstallGrantReceipts)
    .where(eq(externalAppInstallGrantReceipts.installId, install.id));
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.credentialRevision, 1);
});

test("a stale provider response cannot backfill a null bot id after credential rotation", async () => {
  const { db, install } = await fixture();
  await db.update(externalAppInstalls).set({
    providerBotId: null,
  }).where(eq(externalAppInstalls.id, install.id));
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const renewal = refreshSlackBridgeInstallGrantReceipts({
    db,
    provider: provider(async () => {
      await wait;
      return { kind: "fact", fact: FACT };
    }),
    now: NOW,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await db.transaction(async (tx) => {
    await tx.update(externalAppInstalls).set({
      credentialRevision: 2,
    }).where(eq(externalAppInstalls.id, install.id));
    await tx.update(externalAppCredentials).set({
      encryptedMaterial: "sealed-rotated-test-only",
      credentialRevision: 2,
    }).where(eq(externalAppCredentials.installId, install.id));
  });
  release();
  await renewal;
  const [unchanged] = await db.select().from(externalAppInstalls)
    .where(eq(externalAppInstalls.id, install.id));
  assert.equal(unchanged?.providerBotId, null);
  const receipts = await db.select().from(externalAppInstallGrantReceipts)
    .where(eq(externalAppInstallGrantReceipts.installId, install.id));
  assert.equal(receipts.length, 1);
});

test("a stale provider response after revocation writes no receipt or legacy bot-id backfill", async () => {
  const { db, install } = await fixture();
  await db.update(externalAppInstalls).set({
    providerBotId: null,
  }).where(eq(externalAppInstalls.id, install.id));
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const renewal = refreshSlackBridgeInstallGrantReceipts({
    db,
    provider: provider(async () => {
      await wait;
      return { kind: "fact", fact: FACT };
    }),
    now: NOW,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await db.transaction(async (tx) => {
    await tx.update(externalAppInstalls).set({
      state: "revoked",
      stateReason: "test_revocation",
    }).where(eq(externalAppInstalls.id, install.id));
    await tx.update(externalAppCredentials).set({
      state: "revoked",
      revokedAt: NOW,
    }).where(eq(externalAppCredentials.installId, install.id));
  });
  release();
  await renewal;
  const [unchanged] = await db.select().from(externalAppInstalls)
    .where(eq(externalAppInstalls.id, install.id));
  assert.equal(unchanged?.state, "revoked");
  assert.equal(unchanged?.providerBotId, null);
  const receipts = await db.select().from(externalAppInstallGrantReceipts)
    .where(eq(externalAppInstallGrantReceipts.installId, install.id));
  assert.equal(receipts.length, 1);
});
