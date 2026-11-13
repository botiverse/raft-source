import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import { getDb } from "../db/index";
import { users, oauthClients, externalAppRegistrations, externalAppServerGrants,
  externalAppInstalls, externalAppInstallGrantReceipts } from "../db/schema";
import { createServer } from "./serverService";
import { readSlackInboundCurrentSelfBotId, readSlackInboundSelfIdentity } from "./slackInboundSelfIdentity";
import type { SlackInboundIdentityScope } from "./slackInboundSelfIdentity";

afterEach(async () => { await closeTestDatabase(); });

test("only verified self observations from the authenticated registration, environment, app and workspace count", async () => {
  await openTestDatabase("pglite://");
  const db = getDb();
  const [owner] = await db.insert(users).values({ email: `${randomUUID()}@test.invalid`, name: randomUUID(),
    passwordHash: "test-only", emailVerified: true }).returning();
  const server = await createServer("test", randomUUID(), owner.id);
  const [client] = await db.insert(oauthClients).values({ serverId: server.id, clientId: randomUUID(),
    clientSecretHash: "test-only", appType: "slock_builtin", name: "Slack", allowedScopes: [], createdByUserId: owner.id }).returning();
  const [registration] = await db.insert(externalAppRegistrations).values({ oauthClientId: client.id, provider: "slack",
    environment: "test", providerAppId: "A_SELF", providerOAuthClientId: randomUUID(), capabilityManifestVersion: 1,
    capabilityManifestHash: "test" }).returning();
  const [grant] = await db.insert(externalAppServerGrants).values({ serverId: server.id, registrationId: registration.id,
    grantEpoch: 1, grantedManifestVersion: 1, grantedManifestHash: "test", grantedCapabilities: [],
    grantedByType: "human", grantedById: owner.id }).returning();
  const makeInstall = async (team: string) => (await db.insert(externalAppInstalls).values({ serverId: server.id,
    registrationId: registration.id, serverGrantId: grant.id, grantEpoch: 1, state: "active", providerAppId: "A_SELF",
    providerTeamId: team, providerAuthorityId: team, authorityType: "team" }).returning())[0]!;
  const own = await makeInstall("T_SELF");
  const other = await makeInstall("T_OTHER");
  const observedAt = new Date("2026-01-01T00:00:00Z");
  const expiresAt = new Date("2026-01-02T00:00:00Z");
  const receipt = (installId: string, team: string, revision: number, user: string, bot: string,
    status: "valid" | "mismatch" = "valid") => ({ registrationId: registration.id, installId, receiptRevision: revision,
    connectionEpoch: 1, scopeRevision: 1, credentialRevision: 1, providerAppId: "A_SELF", providerAuthorityId: team,
    botUserId: user, providerBotId: bot, grantedScopes: [], grantHash: "a".repeat(64),
    observationSource: "token_introspection" as const, status, errorCode: status === "valid" ? null : "mismatch",
    observedAt, expiresAt });
  await db.insert(externalAppInstallGrantReceipts).values([
    receipt(own.id, "T_SELF", 1, "U_OLD", "B_OLD"),
    receipt(own.id, "T_SELF", 2, "U_BAD", "B_BAD", "mismatch"),
    receipt(other.id, "T_OTHER", 1, "U_OTHER", "B_OTHER"),
    // Even a valid-looking row with inconsistent install scope is not evidence.
    receipt(other.id, "T_SELF", 2, "U_WRONG_INSTALL", "B_WRONG_INSTALL"),
  ]);
  const aad: SlackInboundIdentityScope = { registrationId: registration.id, environment: "test", providerAppId: "A_SELF",
    providerAuthorityId: "T_SELF" };
  assert.deepEqual(await readSlackInboundSelfIdentity({ db, aad }), {
    providerAppId: "A_SELF", installations: [{ botUserId: "U_OLD", botId: "B_OLD" }],
  });
  for (const different of [{ environment: "production" as const }, { providerAppId: "A_OTHER" },
    { registrationId: randomUUID() }]) {
    assert.equal(await readSlackInboundSelfIdentity({ db, aad: { ...aad, ...different } }), null);
  }
  assert.deepEqual(await readSlackInboundSelfIdentity({ db, aad: { ...aad, providerAuthorityId: "T_EMPTY" } }),
    { providerAppId: "A_SELF", installations: [] });

  // Classification does not reuse historic observations. The caller must
  // supply the revision from a fresh successful authority resolution.
  const now = new Date("2026-01-01T12:00:00Z");
  const authority = { ...aad, installId: own.id, connectionEpoch: 1, scopeRevision: 1,
    credentialRevision: 1, installGrantReceiptRevision: 3 };
  await db.update(externalAppInstalls).set({ botUserId: "U_CURRENT", providerBotId: "B_CURRENT" })
    .where(eq(externalAppInstalls.id, own.id));
  await db.insert(externalAppInstallGrantReceipts).values(receipt(own.id, "T_SELF", 3, "U_CURRENT", "B_CURRENT"));
  assert.equal(await readSlackInboundCurrentSelfBotId({ db, authority, now }), "B_CURRENT");
  assert.equal(await readSlackInboundCurrentSelfBotId({ db, authority: { ...authority, installGrantReceiptRevision: 1 }, now }), null);
  assert.equal(await readSlackInboundCurrentSelfBotId({ db, authority: { ...authority, providerAuthorityId: "T_OTHER" }, now }), null);
  assert.equal(await readSlackInboundCurrentSelfBotId({ db, authority, now: expiresAt }), null);
  await db.insert(externalAppInstallGrantReceipts).values(receipt(own.id, "T_SELF", 4, "U_CURRENT", "B_CURRENT", "mismatch"));
  assert.equal(await readSlackInboundCurrentSelfBotId({ db, authority, now }), null);
  assert.equal(await readSlackInboundCurrentSelfBotId({ db, authority: { ...authority, installGrantReceiptRevision: 4 }, now }), null);
});
