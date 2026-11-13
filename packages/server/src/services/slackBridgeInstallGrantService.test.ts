import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { getDb } from "../db/index";
import {
  externalAppCredentials,
  externalAppInstallGrantReceipts,
  externalAppInstallServerGrants,
  externalAppInstalls,
  externalAppRegistrations,
  externalAppServerGrants,
  oauthClients,
  users,
} from "../db/schema";
import { SLACK_BRIDGE_REQUIRED_BOT_SCOPES } from "../routes/slackBridge";
import { SLACK_BRIDGE_CORE_BOT_SCOPES } from "./slackBridgeProductionAppContract";
import { createServer } from "./serverService";
import {
  refreshSlackBridgeInstallGrantReceipts,
  slackBridgeGrantScopesSupportRuntime,
  slackBridgeInstallGrantHash,
} from "./slackBridgeInstallGrantService";
import type { SlackBridgeProvisioningProvider } from "./slackBridgeProvisioningControlPlane";


const NOW = new Date("2026-08-12T08:00:00.000Z");
// Legacy pre-Agent-mention installs carry the 11-scope core grant; the
// provider may observe the 13-scope set (usergroups:* added) after a Slack
// app update, which is the drift case these tests exercise.
const SCOPES = [...SLACK_BRIDGE_CORE_BOT_SCOPES];

test("legacy core Slack grants keep message sync while Agent mention scopes roll out", () => {
  assert.equal(slackBridgeGrantScopesSupportRuntime([...SLACK_BRIDGE_CORE_BOT_SCOPES]), true);
  assert.equal(slackBridgeGrantScopesSupportRuntime([...SLACK_BRIDGE_REQUIRED_BOT_SCOPES]), true);
  assert.equal(slackBridgeGrantScopesSupportRuntime(
    SLACK_BRIDGE_CORE_BOT_SCOPES.filter((scope) => scope !== "chat:write"),
  ), false);
  // Extra scopes are tolerated — matching the #9179/#9185 contract that a
  // broader grant is not a mismatch.
  assert.equal(slackBridgeGrantScopesSupportRuntime([
    ...SLACK_BRIDGE_REQUIRED_BOT_SCOPES,
    "admin",
  ]), true);
});

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
  await db.insert(externalAppInstallServerGrants).values({
    installId: install.id,
    serverId: server.id,
    registrationId: registration.id,
    serverGrantId: grant.id,
    grantEpoch: grant.grantEpoch,
    state: "active",
    authorizedByType: "human",
    authorizedById: owner.id,
  });
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
  return { db, grant, install };
}

function provider(
  read: SlackBridgeProvisioningProvider["readInstallGrant"],
): SlackBridgeProvisioningProvider {
  return {
    readInstallGrant: read,
    async readWorkspace() {
      return { oauth: "unverified", directory: { kind: "unverified" } };
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

test("install with extra granted scopes still matches the contract grant", async () => {
  const { db, install } = await fixture();
  // x-oauth-scopes on the Slack token carries usergroups:* beyond the
  // 11-scope contract (as staging currently does). Install and grant
  // both store the actual scopes; the contract check is required ⊆ granted.
  const SUPERSET = [...SCOPES, "usergroups:read", "usergroups:write"];
  await db.update(externalAppInstalls).set({ installedScopes: SUPERSET })
    .where(eq(externalAppInstalls.id, install.id));

  const grantProvider = provider(async () => ({
    kind: "fact",
    fact: { ...FACT, grantedScopes: SUPERSET },
  }));
  await refreshSlackBridgeInstallGrantReceipts({ db, provider: grantProvider, now: NOW });

  const receipts = await db.select().from(externalAppInstallGrantReceipts)
    .where(eq(externalAppInstallGrantReceipts.installId, install.id));
  assert.ok(receipts.length >= 1, "grant receipt must be issued for a superset install");
});

test("provider-observed scope drift reconciles installed_scopes and renews under the new revision", async () => {
  const { db, install } = await fixture();
  // Staging 2026-09-25: Slack app gained usergroups:* via User Token Scopes;
  // auth.test's x-oauth-scopes carries them, but installed_scopes still
  // records the install-time 11. Renewal must repair the record, not fail.
  const DRIFTED = [...SCOPES, "usergroups:read", "usergroups:write"];
  const driftEvents: Array<{ source: string; previousScopes: readonly string[]; observedScopes: readonly string[] }> = [];
  const grantProvider = provider(async () => ({
    kind: "fact",
    fact: { ...FACT, grantedScopes: DRIFTED },
  }));

  const result = await refreshSlackBridgeInstallGrantReceipts({
    db,
    provider: grantProvider,
    now: NOW,
    onScopeDrift: (event) => { driftEvents.push(event); },
  });

  assert.equal(result.renewed, 1);
  assert.equal(driftEvents.length, 1);
  assert.equal(driftEvents[0]!.source, "renewal");
  assert.deepEqual(driftEvents[0]!.previousScopes, SCOPES);
  assert.deepEqual([...driftEvents[0]!.observedScopes].sort(), [...DRIFTED].sort());

  const [reconciled] = await db.select().from(externalAppInstalls)
    .where(eq(externalAppInstalls.id, install.id));
  assert.equal(reconciled!.scopeRevision, 2);
  assert.deepEqual([...reconciled!.installedScopes].sort(), [...DRIFTED].sort());

  const receipts = await db.select().from(externalAppInstallGrantReceipts)
    .where(eq(externalAppInstallGrantReceipts.installId, install.id));
  const latest = receipts.sort((left, right) => right.receiptRevision - left.receiptRevision)[0]!;
  assert.equal(latest.scopeRevision, 2, "receipt is written against the reconciled revision");
  assert.deepEqual([...latest.grantedScopes].sort(), [...DRIFTED].sort());
});

test("the next renewal on a shared install self-converges after scope drift repair", async () => {
  const { db, install } = await fixture();
  const DRIFTED = [...SCOPES, "usergroups:read", "usergroups:write"];
  const grantProvider = provider(async () => ({
    kind: "fact",
    fact: { ...FACT, grantedScopes: DRIFTED },
  }));

  // First renewal repairs the record; a second server observing the same
  // token scopes then finds installed_scopes already reconciled and renews
  // normally — proof a shared install does not get stuck after drift repair.
  const first = await refreshSlackBridgeInstallGrantReceipts({ db, provider: grantProvider, now: NOW });
  const second = await refreshSlackBridgeInstallGrantReceipts({
    db,
    provider: grantProvider,
    now: new Date(NOW.getTime() + 60_000),
  });
  assert.equal(first.renewed, 1);
  assert.equal(second.renewed, 0);
  assert.equal(second.skipped, 1, "post-repair install has a current receipt and skips");
});

test("granted scopes that lose the required contract are a mismatch, not a drift update", async () => {
  const { db, install } = await fixture();
  const MISSING = SCOPES.filter((scope) => scope !== "chat:write");
  const grantProvider = provider(async () => ({
    kind: "fact",
    fact: { ...FACT, grantedScopes: MISSING },
  }));

  const result = await refreshSlackBridgeInstallGrantReceipts({
    db,
    provider: grantProvider,
    now: NOW,
  });

  assert.equal(result.failed, 1);
  const [unchanged] = await db.select().from(externalAppInstalls)
    .where(eq(externalAppInstalls.id, install.id));
  assert.equal(unchanged!.scopeRevision, 1);
  assert.deepEqual([...unchanged!.installedScopes].sort(), SCOPES);
  const receipts = await db.select().from(externalAppInstallGrantReceipts)
    .where(eq(externalAppInstallGrantReceipts.installId, install.id));
  assert.equal(receipts.length, 1, "no new receipt may be written for a mismatched grant");
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

test("stale server-grant epoch cannot drive provider token introspection", async () => {
  const { db, grant, install } = await fixture();
  await db.update(externalAppServerGrants).set({ grantEpoch: grant.grantEpoch + 1 })
    .where(eq(externalAppServerGrants.id, grant.id));
  let reads = 0;
  const result = await refreshSlackBridgeInstallGrantReceipts({
    db,
    provider: provider(async () => {
      reads += 1;
      return { kind: "fact", fact: FACT };
    }),
    now: NOW,
  });

  assert.deepEqual(result, { considered: 1, renewed: 0, skipped: 1, failed: 0 });
  assert.equal(reads, 0);
  assert.equal((await db.select().from(externalAppInstallGrantReceipts).where(
    eq(externalAppInstallGrantReceipts.installId, install.id),
  )).length, 1);
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
