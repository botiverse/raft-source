import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  channels,
  externalAppCredentials,
  externalAppInstallGrantReceipts,
  externalAppInstalls, externalAppRegistrationSecrets,
  externalAppRegistrations,
  externalAppServerGrants,
  externalBindingAudienceSnapshots,
  externalChannelBindings,
  externalHumanIdentityLinks,
  externalOAuthAttempts,
  oauthClientInstalls,
  oauthClients,
  serverMembers,
  servers,
  users
} from "../db/schema.js";
import { createServer } from "./serverService.js";
import {
  beginExternalOAuthAttempt,
  claimExternalOAuthAttempt,
  completeExternalOAuthAttempt,
  ExternalAppControlPlaneError,
  getExternalAppRegistrationMetadata,
  markExternalOAuthExchangeUnknown,
  resolveExternalBindingAuthority,
  revokeExternalHumanIdentityLink,
} from "./externalAppControlPlaneService.js";
import { reconcileSlackPrivateAudience } from "./slackBindingLifecycleService.js";


beforeEach(async () => {
  await openTestDatabase("pglite://");
});

afterEach(async () => {
  await closeTestDatabase();
});

async function seedControlPlane() {
  const [owner] = await getDb()
    .insert(users)
    .values({
      email: `external-app-${randomUUID()}@raft.test`,
      name: `external-app-${randomUUID().slice(0, 8)}`,
      displayName: "External App Owner",
      passwordHash: "hash",
      emailVerified: true,
    })
    .returning();
  const server = await createServer(
    "External App Test",
    `external-app-${randomUUID()}`,
    owner.id,
  );
  const [client] = await getDb()
    .insert(oauthClients)
    .values({
      serverId: server.id,
      clientId: `external-app-${randomUUID()}`,
      clientSecretHash: "not-a-real-secret",
      appType: "slock_builtin",
      name: "Slack Bridge",
      allowedScopes: ["messages:read", "messages:write"],
      createdByUserId: owner.id,
    })
    .returning();
  await getDb().insert(oauthClientInstalls).values({
    serverId: server.id,
    clientId: client.id,
    installedByUserId: owner.id,
  });
  const [registration] = await getDb()
    .insert(externalAppRegistrations)
    .values({
      oauthClientId: client.id,
      provider: "slack",
      environment: "test",
      providerAppId: "A_TEST_BRIDGE",
      providerOAuthClientId: "oauth-client-test",
      capabilityManifestVersion: 1,
      capabilityManifestHash: "manifest-v1",
      requiredCapabilities: ["external_projection", "channel_events"],
    })
    .returning();
  const [grant] = await getDb()
    .insert(externalAppServerGrants)
    .values({
      serverId: server.id,
      registrationId: registration.id,
      grantEpoch: 1,
      grantedManifestVersion: 1,
      grantedManifestHash: "manifest-v1",
      grantedCapabilities: ["external_projection", "channel_events"],
      grantedByType: "human",
      grantedById: owner.id,
    })
    .returning();
  await getDb().insert(externalAppRegistrationSecrets).values([
    {
      registrationId: registration.id,
      purpose: "signing_secret",
      encryptedSecretRef: "sealed:test-signing-secret-ref",
      envelopeKeyId: "test-envelope-key",
      secretRevision: 1,
    },
    {
      registrationId: registration.id,
      purpose: "manifest_manager",
      encryptedSecretRef: "sealed:test-manifest-manager-ref",
      envelopeKeyId: "test-envelope-key",
      secretRevision: 1,
    },
  ]);
  return { owner, server, client, registration, grant };
}

async function beginAndClaim(
  seeded: Awaited<ReturnType<typeof seedControlPlane>>,
  requestingUserId = seeded.owner.id,
) {
  const redirectUri = "https://raft.test/api/external-apps/slack/oauth/callback";
  const begun = await beginExternalOAuthAttempt({
    serverId: seeded.server.id,
    registrationId: seeded.registration.id,
    serverGrantId: seeded.grant.id,
    grantEpoch: seeded.grant.grantEpoch,
    requestingUserId,
    redirectUri,
    requestedScopes: ["channels:history", "chat:write"],
    grantIntent: `install:${seeded.server.id}:${seeded.registration.id}`,
  });
  const claimed = await claimExternalOAuthAttempt({
    state: begun.state,
    expectedEnvironment: "test",
    expectedRedirectUri: redirectUri,
  });
  return { begun, claimed };
}

async function completeInstall(
  seeded: Awaited<ReturnType<typeof seedControlPlane>>,
  attemptId: string,
  teamId = "T_TEST_WORKSPACE",
  providerUserId = "U_TEST_OWNER",
) {
  return completeExternalOAuthAttempt({
    attemptId,
    providerAppId: seeded.registration.providerAppId,
    providerTeamId: teamId,
    providerUserId,
    botUserId: "U_TEST_BOT",
    providerBotId: "B_TEST_BOT",
    workspaceName: "Test Workspace",
    installedScopes: ["chat:write", "channels:history"],
    sealedCredential: {
      encryptedMaterial: "sealed:test-only-ciphertext",
      envelopeKeyId: "test-envelope-key",
      aadVersion: 1,
    },
  });
}

test("external OAuth state is hashed, boundary-bound, single-use, and owner-authorized", async () => {
  const seeded = await seedControlPlane();
  const redirectUri = "https://raft.test/api/external-apps/slack/oauth/callback";
  const begun = await beginExternalOAuthAttempt({
    serverId: seeded.server.id,
    registrationId: seeded.registration.id,
    serverGrantId: seeded.grant.id,
    grantEpoch: 1,
    requestingUserId: seeded.owner.id,
    redirectUri,
    requestedScopes: ["chat:write", "channels:history", "chat:write"],
    grantIntent: "test-install-intent",
  });

  const [stored] = await getDb().select().from(externalOAuthAttempts);
  assert.notEqual(stored.stateHash, begun.state);
  assert.equal(
    stored.stateHash,
    createHash("sha256").update(begun.state, "utf8").digest("hex"),
  );
  assert.deepEqual(stored.requestedScopes, ["channels:history", "chat:write"]);

  await assert.rejects(
    claimExternalOAuthAttempt({
      state: begun.state,
      expectedEnvironment: "production",
      expectedRedirectUri: redirectUri,
    }),
    (error: unknown) =>
      error instanceof ExternalAppControlPlaneError
      && error.code === "external_app_invalid_state",
  );
  assert.equal(
    (await getDb().select().from(externalOAuthAttempts))[0].status,
    "pending",
  );

  const claimed = await claimExternalOAuthAttempt({
    state: begun.state,
    expectedEnvironment: "test",
    expectedRedirectUri: redirectUri,
  });
  assert.equal(claimed.attemptId, begun.attemptId);
  await assert.rejects(
    claimExternalOAuthAttempt({
      state: begun.state,
      expectedEnvironment: "test",
      expectedRedirectUri: redirectUri,
    }),
    (error: unknown) =>
      error instanceof ExternalAppControlPlaneError
      && error.code === "external_app_invalid_state",
  );
});

test("callback rechecks current grant, install presence, and manager authority before exchange", async () => {
  const seeded = await seedControlPlane();
  const redirectUri = "https://raft.test/api/external-apps/slack/oauth/callback";
  const begun = await beginExternalOAuthAttempt({
    serverId: seeded.server.id,
    registrationId: seeded.registration.id,
    serverGrantId: seeded.grant.id,
    grantEpoch: 1,
    requestingUserId: seeded.owner.id,
    redirectUri,
    requestedScopes: ["channels:history"],
    grantIntent: "test-install-intent",
  });
  const revokedAt = new Date();
  await getDb()
    .update(externalAppServerGrants)
    .set({
      state: "revoked",
      grantEpoch: 2,
      revokedAt,
      revokeReason: "test_revoke",
      updatedAt: revokedAt,
    })
    .where(eq(externalAppServerGrants.id, seeded.grant.id));

  await assert.rejects(
    claimExternalOAuthAttempt({
      state: begun.state,
      expectedEnvironment: "test",
      expectedRedirectUri: redirectUri,
    }),
    (error: unknown) =>
      error instanceof ExternalAppControlPlaneError
      && error.code === "external_app_not_authorized",
  );
  assert.equal(
    (await getDb().select().from(externalOAuthAttempts))[0].status,
    "pending",
  );
  assert.equal((await getDb().select().from(externalAppCredentials)).length, 0);
});

test("OAuth completion atomically installs only exact scopes and sealed credentials", async () => {
  const seeded = await seedControlPlane();
  const { claimed } = await beginAndClaim(seeded);

  await assert.rejects(
    completeExternalOAuthAttempt({
      attemptId: claimed.attemptId,
      providerAppId: seeded.registration.providerAppId,
      providerTeamId: "T_TEST_WORKSPACE",
      providerUserId: "U_TEST_OWNER",
      botUserId: "U_TEST_BOT",
      installedScopes: ["chat:write"],
      sealedCredential: {
        encryptedMaterial: "sealed:test-only-ciphertext",
        envelopeKeyId: "test-envelope-key",
        aadVersion: 1,
      },
    }),
    (error: unknown) =>
      error instanceof ExternalAppControlPlaneError
      && error.code === "external_app_scope_mismatch",
  );
  assert.equal((await getDb().select().from(externalAppInstalls)).length, 0);
  assert.equal((await getDb().select().from(externalAppCredentials)).length, 0);
  assert.equal(
    (await getDb().select().from(externalOAuthAttempts))[0].status,
    "exchanging",
  );

  await assert.rejects(
    completeExternalOAuthAttempt({
      attemptId: claimed.attemptId,
      providerAppId: seeded.registration.providerAppId,
      providerTeamId: "T_TEST_WORKSPACE",
      providerUserId: "U_TEST_BOT",
      botUserId: "U_TEST_BOT",
      installedScopes: ["chat:write", "channels:history"],
      sealedCredential: {
        encryptedMaterial: "sealed:test-only-ciphertext",
        envelopeKeyId: "test-envelope-key",
        aadVersion: 1,
      },
    }),
    (error: unknown) =>
      error instanceof ExternalAppControlPlaneError
      && error.code === "external_app_not_authorized",
  );
  assert.equal((await getDb().select().from(externalAppInstalls)).length, 0);
  assert.equal((await getDb().select().from(externalHumanIdentityLinks)).length, 0);

  const completed = await completeInstall(seeded, claimed.attemptId);
  assert.equal(completed.connectionEpoch, 1);
  assert.equal(completed.credentialRevision, 1);
  assert.equal(completed.identityLinkEpoch, 1);
  const [install] = await getDb().select().from(externalAppInstalls);
  const [credential] = await getDb().select().from(externalAppCredentials);
  const [attempt] = await getDb().select().from(externalOAuthAttempts);
  const [identityLink] = await getDb().select().from(externalHumanIdentityLinks);
  assert.equal(install.state, "active");
  assert.equal(install.serverId, seeded.server.id);
  assert.deepEqual(install.installedScopes, ["channels:history", "chat:write"]);
  assert.equal(credential.installId, install.id);
  assert.equal(credential.encryptedMaterial, "sealed:test-only-ciphertext");
  assert.equal(attempt.status, "consumed");
  assert.ok(attempt.consumedAt);
  assert.equal(identityLink.serverId, seeded.server.id);
  assert.equal(identityLink.installId, install.id);
  assert.equal(identityLink.userId, seeded.owner.id);
  assert.equal(identityLink.providerAuthorityId, "T_TEST_WORKSPACE");
  assert.equal(identityLink.providerUserId, "U_TEST_OWNER");
  assert.equal(identityLink.state, "active");
  assert.equal(identityLink.linkEpoch, 1);
  assert.equal(identityLink.observedConnectionEpoch, 1);
});

test("OAuth completion refuses to install after the claimed server is deleted", async () => {
  const seeded = await seedControlPlane();
  const { claimed } = await beginAndClaim(seeded);

  await getDb()
    .update(servers)
    .set({ deletedAt: new Date() })
    .where(eq(servers.id, seeded.server.id));

  await assert.rejects(
    completeInstall(seeded, claimed.attemptId),
    (error: unknown) =>
      error instanceof ExternalAppControlPlaneError
      && error.code === "external_app_not_authorized",
  );
  assert.equal((await getDb().select().from(externalAppInstalls)).length, 0);
  assert.equal((await getDb().select().from(externalAppCredentials)).length, 0);
  assert.equal((await getDb().select().from(externalHumanIdentityLinks)).length, 0);
  assert.equal(
    (await getDb().select().from(externalOAuthAttempts))[0]?.status,
    "exchanging",
  );
});

test("OAuth reauthorization refreshes the same explicit human link with monotonic epochs", async () => {
  const seeded = await seedControlPlane();
  const first = await beginAndClaim(seeded);
  const firstCompleted = await completeInstall(
    seeded,
    first.claimed.attemptId,
    "T_TEST_WORKSPACE",
    "U_TEST_OWNER",
  );
  const second = await beginAndClaim(seeded);
  const secondCompleted = await completeInstall(
    seeded,
    second.claimed.attemptId,
    "T_TEST_WORKSPACE",
    "U_TEST_OWNER",
  );

  assert.equal(firstCompleted.identityLinkEpoch, 1);
  assert.equal(secondCompleted.connectionEpoch, 2);
  assert.equal(secondCompleted.identityLinkEpoch, 2);
  const links = await getDb().select().from(externalHumanIdentityLinks);
  assert.equal(links.length, 1);
  assert.equal(links[0]!.state, "active");
  assert.equal(links[0]!.linkEpoch, 2);
  assert.equal(links[0]!.observedConnectionEpoch, 2);
});

test("OAuth reauthorization replaces one Raft human's Slack identity without losing history", async () => {
  const seeded = await seedControlPlane();
  const first = await beginAndClaim(seeded);
  await completeInstall(seeded, first.claimed.attemptId, "T_TEST_WORKSPACE", "U_OLD_OWNER");
  const second = await beginAndClaim(seeded);
  const completed = await completeInstall(
    seeded,
    second.claimed.attemptId,
    "T_TEST_WORKSPACE",
    "U_NEW_OWNER",
  );

  assert.equal(completed.identityLinkEpoch, 2);
  const links = await getDb().select().from(externalHumanIdentityLinks)
    .orderBy(externalHumanIdentityLinks.linkEpoch);
  assert.equal(links.length, 2);
  assert.deepEqual(links.map((link) => ({
    providerUserId: link.providerUserId,
    state: link.state,
    linkEpoch: link.linkEpoch,
    revokeReason: link.revokeReason,
  })), [{
    providerUserId: "U_OLD_OWNER",
    state: "revoked",
    linkEpoch: 1,
    revokeReason: "provider_identity_replaced",
  }, {
    providerUserId: "U_NEW_OWNER",
    state: "active",
    linkEpoch: 2,
    revokeReason: null,
  }]);
  assert.ok(links[0]!.revokedAt);
});

test("one Slack human cannot be claimed by another Raft human and OAuth persistence rolls back", async () => {
  const seeded = await seedControlPlane();
  const first = await beginAndClaim(seeded);
  const installed = await completeInstall(
    seeded,
    first.claimed.attemptId,
    "T_TEST_WORKSPACE",
    "U_SHARED_HUMAN",
  );
  const [other] = await getDb().insert(users).values({
    email: `external-app-other-${randomUUID()}@raft.test`,
    name: `external-app-other-${randomUUID().slice(0, 8)}`,
    displayName: "Other External App Admin",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  await getDb().insert(serverMembers).values({
    serverId: seeded.server.id,
    userId: other.id,
    role: "admin",
  });
  const conflicting = await beginAndClaim(seeded, other.id);

  await assert.rejects(
    completeInstall(
      seeded,
      conflicting.claimed.attemptId,
      "T_TEST_WORKSPACE",
      "U_SHARED_HUMAN",
    ),
    (error: unknown) =>
      error instanceof ExternalAppControlPlaneError
      && error.code === "external_app_install_conflict",
  );
  const [install] = await getDb().select().from(externalAppInstalls);
  const [credential] = await getDb().select().from(externalAppCredentials);
  const links = await getDb().select().from(externalHumanIdentityLinks);
  assert.equal(install.id, installed.installId);
  assert.equal(install.connectionEpoch, 1);
  assert.equal(install.credentialRevision, 1);
  assert.equal(credential.credentialRevision, 1);
  assert.equal(links.length, 1);
  assert.equal(links[0]!.userId, seeded.owner.id);
  assert.equal(
    (await getDb().select().from(externalOAuthAttempts)
      .where(eq(externalOAuthAttempts.id, conflicting.claimed.attemptId)))[0]!.status,
    "exchanging",
  );
});

test("explicit human identity revocation is epoch-fenced and durable", async () => {
  const seeded = await seedControlPlane();
  const attempt = await beginAndClaim(seeded);
  const completed = await completeInstall(seeded, attempt.claimed.attemptId);

  assert.deepEqual(await revokeExternalHumanIdentityLink({
    serverId: seeded.server.id,
    installId: completed.installId,
    userId: seeded.owner.id,
    expectedLinkEpoch: 2,
    reason: "test unlink",
  }), { revoked: false, linkEpoch: null });
  assert.deepEqual(await revokeExternalHumanIdentityLink({
    serverId: seeded.server.id,
    installId: completed.installId,
    userId: seeded.owner.id,
    expectedLinkEpoch: 1,
    reason: "test unlink",
  }), { revoked: true, linkEpoch: 1 });
  assert.deepEqual(await revokeExternalHumanIdentityLink({
    serverId: seeded.server.id,
    installId: completed.installId,
    userId: seeded.owner.id,
    expectedLinkEpoch: 1,
    reason: "duplicate unlink",
  }), { revoked: false, linkEpoch: null });
  const [link] = await getDb().select().from(externalHumanIdentityLinks);
  assert.equal(link.state, "revoked");
  assert.equal(link.revokeReason, "test unlink");
  assert.ok(link.revokedAt);
});

test("ambiguous provider exchange is terminally fenced from automatic state reuse", async () => {
  const seeded = await seedControlPlane();
  const { begun, claimed } = await beginAndClaim(seeded);
  assert.equal(await markExternalOAuthExchangeUnknown(claimed.attemptId), true);
  assert.equal(await markExternalOAuthExchangeUnknown(claimed.attemptId), false);
  await assert.rejects(
    claimExternalOAuthAttempt({
      state: begun.state,
      expectedEnvironment: "test",
      expectedRedirectUri: "https://raft.test/api/external-apps/slack/oauth/callback",
    }),
    (error: unknown) =>
      error instanceof ExternalAppControlPlaneError
      && error.code === "external_app_invalid_state",
  );
  assert.equal((await getDb().select().from(externalAppInstalls)).length, 0);
  assert.equal((await getDb().select().from(externalAppCredentials)).length, 0);
});

test("one provider workspace authority cannot be copied to a second Raft server", async () => {
  const seeded = await seedControlPlane();
  const first = await beginAndClaim(seeded);
  await completeInstall(seeded, first.claimed.attemptId);

  const [secondOwner] = await getDb()
    .insert(users)
    .values({
      email: `external-app-2-${randomUUID()}@raft.test`,
      name: `external-app-2-${randomUUID().slice(0, 8)}`,
      displayName: "Second Owner",
      passwordHash: "hash",
      emailVerified: true,
    })
    .returning();
  const secondServer = await createServer(
    "Second External App Test",
    `external-app-2-${randomUUID()}`,
    secondOwner.id,
  );
  await getDb().insert(oauthClientInstalls).values({
    serverId: secondServer.id,
    clientId: seeded.client.id,
    installedByUserId: secondOwner.id,
  });
  const [secondGrant] = await getDb()
    .insert(externalAppServerGrants)
    .values({
      serverId: secondServer.id,
      registrationId: seeded.registration.id,
      grantEpoch: 1,
      grantedManifestVersion: 1,
      grantedManifestHash: "manifest-v1",
      grantedCapabilities: ["external_projection", "channel_events"],
      grantedByType: "human",
      grantedById: secondOwner.id,
    })
    .returning();
  const secondAttempt = await beginExternalOAuthAttempt({
    serverId: secondServer.id,
    registrationId: seeded.registration.id,
    serverGrantId: secondGrant.id,
    grantEpoch: 1,
    requestingUserId: secondOwner.id,
    redirectUri: "https://raft.test/api/external-apps/slack/oauth/callback",
    requestedScopes: ["channels:history", "chat:write"],
    grantIntent: "second-server-install",
  });
  const secondClaim = await claimExternalOAuthAttempt({
    state: secondAttempt.state,
    expectedEnvironment: "test",
    expectedRedirectUri: "https://raft.test/api/external-apps/slack/oauth/callback",
  });

  await assert.rejects(
    completeInstall(
      { ...seeded, owner: secondOwner, server: secondServer, grant: secondGrant },
      secondClaim.attemptId,
    ),
    (error: unknown) =>
      error instanceof ExternalAppControlPlaneError
      && error.code === "external_app_install_conflict",
  );
  assert.equal((await getDb().select().from(externalAppInstalls)).length, 1);
});

test("database invariants reject org-wide installs and privacy-class substitution", async () => {
  const seeded = await seedControlPlane();
  await assert.rejects(
    getDb().insert(externalAppInstalls).values({
      serverId: seeded.server.id,
      registrationId: seeded.registration.id,
      serverGrantId: seeded.grant.id,
      grantEpoch: 1,
      state: "active",
      connectionEpoch: 1,
      scopeRevision: 1,
      credentialRevision: 1,
      installedScopes: ["channels:history", "chat:write"],
      providerAppId: seeded.registration.providerAppId,
      providerTeamId: null,
      providerEnterpriseId: "E_TEST_ENTERPRISE",
      authorityType: "enterprise",
      providerAuthorityId: "E_TEST_ENTERPRISE",
      botUserId: "U_TEST_BOT",
    }),
  );

  const { claimed } = await beginAndClaim(seeded);
  const completed = await completeInstall(seeded, claimed.attemptId);
  const [channel] = await getDb()
    .insert(channels)
    .values({
      serverId: seeded.server.id,
      name: `slack-privacy-substitution-${randomUUID()}`,
      type: "channel",
    })
    .returning();
  await assert.rejects(
    getDb().insert(externalChannelBindings).values({
      serverId: seeded.server.id,
      registrationId: seeded.registration.id,
      installId: completed.installId,
      channelId: channel.id,
      providerConversationId: "C_PUBLIC_AS_PRIVATE",
      providerConversationKind: "public_channel",
      privacyClass: "private",
      grantEpoch: 1,
      connectionEpoch: 1,
      bindingEpoch: 1,
      audienceRevision: 1,
      audienceFreshUntil: new Date(Date.now() + 60_000),
      consentedByType: "human",
      consentedById: seeded.owner.id,
      consentedAt: new Date(),
    }),
  );
});

async function seedFreshInstallGrant(
  seeded: Awaited<ReturnType<typeof seedControlPlane>>,
  installId: string,
  now: Date,
) {
  const [install] = await getDb().select().from(externalAppInstalls)
    .where(eq(externalAppInstalls.id, installId));
  assert.ok(install?.botUserId && install.providerBotId);
  const grantedScopes = [...install.installedScopes].sort();
  const grantHash = createHash("sha256").update(JSON.stringify({
    version: 1,
    provider: "slack",
    providerAppId: install.providerAppId,
    providerAuthorityId: install.providerAuthorityId,
    botUserId: install.botUserId,
    providerBotId: install.providerBotId,
    grantedScopes,
  }), "utf8").digest("hex");
  const [receipt] = await getDb()
    .insert(externalAppInstallGrantReceipts)
    .values({
      registrationId: seeded.registration.id,
      installId: install.id,
      receiptRevision: 1,
      connectionEpoch: install.connectionEpoch,
      scopeRevision: install.scopeRevision,
      credentialRevision: install.credentialRevision,
      providerAppId: install.providerAppId,
      providerAuthorityId: install.providerAuthorityId,
      botUserId: install.botUserId,
      providerBotId: install.providerBotId,
      grantedScopes,
      grantHash,
      observationSource: "token_introspection",
      status: "valid",
      observedAt: new Date(now.getTime() - 60_000),
      expiresAt: new Date(now.getTime() + 60 * 60_000),
    })
    .returning();
  return receipt;
}

test("public binding authority is a secret-free same-epoch fact and fails closed on drift", async () => {
  const seeded = await seedControlPlane();
  const { claimed } = await beginAndClaim(seeded);
  const completed = await completeInstall(seeded, claimed.attemptId);
  const now = new Date("2026-07-24T00:00:00.000Z");
  await seedFreshInstallGrant(seeded, completed.installId, now);
  const [channel] = await getDb()
    .insert(channels)
    .values({
      serverId: seeded.server.id,
      name: `slack-public-${randomUUID()}`,
      type: "channel",
    })
    .returning();
  const [binding] = await getDb()
    .insert(externalChannelBindings)
    .values({
      serverId: seeded.server.id,
      registrationId: seeded.registration.id,
      installId: completed.installId,
      channelId: channel.id,
      providerConversationId: "C_PUBLIC",
      providerConversationKind: "public_channel",
      privacyClass: "public",
      grantEpoch: 1,
      connectionEpoch: completed.connectionEpoch,
      bindingEpoch: 1,
      consentedByType: "human",
      consentedById: seeded.owner.id,
      consentedAt: now,
    })
    .returning();

  const active = await resolveExternalBindingAuthority({
    serverId: seeded.server.id,
    bindingId: binding.id,
    expectedConnectionEpoch: 1,
    expectedBindingEpoch: 1,
    now,
  });
  assert.equal(active.active, true);
  if (!active.active) assert.fail("expected active authority");
  assert.deepEqual(
    Object.keys(active.fact).sort(),
    [
      "audienceRevision",
      "bindingEpoch",
      "bindingId",
      "channelId",
      "connectionEpoch",
      "credentialRevision",
      "environment",
      "grantEpoch",
      "installId",
      "installGrantReceiptRevision",
      "privacyClass",
      "provider",
      "providerAppId",
      "providerAuthorityId",
      "providerConversationId",
      "registrationId",
      "scopeRevision",
      "serverGrantId",
      "serverId",
    ].sort(),
  );
  assert.equal(JSON.stringify(active).includes("sealed:test-only-ciphertext"), false);
  assert.equal(JSON.stringify(active).includes("oauth-client-test"), false);

  await getDb()
    .delete(externalAppRegistrationSecrets)
    .where(and(
      eq(externalAppRegistrationSecrets.registrationId, seeded.registration.id),
      eq(externalAppRegistrationSecrets.purpose, "signing_secret"),
    ));
  assert.deepEqual(
    await resolveExternalBindingAuthority({
      serverId: seeded.server.id,
      bindingId: binding.id,
      expectedConnectionEpoch: 1,
      expectedBindingEpoch: 1,
      now,
    }),
    { active: false, reason: "secret_reference_unavailable" },
  );
  await getDb().insert(externalAppRegistrationSecrets).values({
    registrationId: seeded.registration.id,
    purpose: "signing_secret",
    encryptedSecretRef: "sealed:test-signing-secret-ref",
    envelopeKeyId: "test-envelope-key",
    secretRevision: 1,
  });

  await getDb()
    .update(externalAppInstallGrantReceipts)
    .set({ expiresAt: new Date(now.getTime() - 1) })
    .where(eq(
      externalAppInstallGrantReceipts.registrationId,
      seeded.registration.id,
    ));
  assert.deepEqual(
    await resolveExternalBindingAuthority({
      serverId: seeded.server.id,
      bindingId: binding.id,
      expectedConnectionEpoch: 1,
      expectedBindingEpoch: 1,
      now,
    }),
    { active: false, reason: "install_grant_stale" },
  );
  await getDb()
    .update(externalAppInstallGrantReceipts)
    .set({ expiresAt: new Date(now.getTime() + 60 * 60_000) })
    .where(eq(
      externalAppInstallGrantReceipts.registrationId,
      seeded.registration.id,
    ));

  await getDb()
    .update(externalAppCredentials)
    .set({ credentialRevision: 2 })
    .where(eq(externalAppCredentials.installId, completed.installId));
  assert.deepEqual(
    await resolveExternalBindingAuthority({
      serverId: seeded.server.id,
      bindingId: binding.id,
      expectedConnectionEpoch: 1,
      expectedBindingEpoch: 1,
      now,
    }),
    { active: false, reason: "credential_stale" },
  );
  await getDb()
    .update(externalAppCredentials)
    .set({ credentialRevision: 1 })
    .where(eq(externalAppCredentials.installId, completed.installId));

  const staleEpoch = await resolveExternalBindingAuthority({
    serverId: seeded.server.id,
    bindingId: binding.id,
    expectedConnectionEpoch: 2,
    expectedBindingEpoch: 1,
    now,
  });
  assert.deepEqual(staleEpoch, { active: false, reason: "epoch_mismatch" });

  await getDb()
    .delete(oauthClientInstalls)
    .where(and(
      eq(oauthClientInstalls.serverId, seeded.server.id),
      eq(oauthClientInstalls.clientId, seeded.client.id),
    ));
  const absentPresence = await resolveExternalBindingAuthority({
    serverId: seeded.server.id,
    bindingId: binding.id,
    expectedConnectionEpoch: 1,
    expectedBindingEpoch: 1,
    now,
  });
  assert.deepEqual(absentPresence, {
    active: false,
    reason: "install_presence_missing",
  });
});

test("private binding requires the exact fresh matched audience snapshot", async () => {
  const seeded = await seedControlPlane();
  const { claimed } = await beginAndClaim(seeded);
  const completed = await completeInstall(seeded, claimed.attemptId);
  const now = new Date("2026-07-24T00:00:00.000Z");
  await seedFreshInstallGrant(seeded, completed.installId, now);
  const [channel] = await getDb()
    .insert(channels)
    .values({
      serverId: seeded.server.id,
      name: `slack-private-${randomUUID()}`,
      type: "private",
    })
    .returning();
  const [binding] = await getDb()
    .insert(externalChannelBindings)
    .values({
      serverId: seeded.server.id,
      registrationId: seeded.registration.id,
      installId: completed.installId,
      channelId: channel.id,
      providerConversationId: "G_PRIVATE",
      providerConversationKind: "private_channel",
      privacyClass: "private",
      grantEpoch: 1,
      connectionEpoch: completed.connectionEpoch,
      bindingEpoch: 4,
      audienceRevision: 7,
      audienceFreshUntil: new Date(now.getTime() + 30 * 60_000),
      consentedByType: "human",
      consentedById: seeded.owner.id,
      consentedAt: now,
    })
    .returning();
  await getDb().insert(externalBindingAudienceSnapshots).values({
    bindingId: binding.id,
    bindingEpoch: 4,
    audienceRevision: 7,
    externalMemberCount: 3,
    externalAudienceDigest: "external-audience-digest",
    raftMemberCount: 3,
    raftAudienceDigest: "raft-audience-digest",
    status: "mismatch",
    observedAt: new Date(now.getTime() - 60_000),
    expiresAt: new Date(now.getTime() + 30 * 60_000),
  });

  assert.deepEqual(
    await resolveExternalBindingAuthority({
      serverId: seeded.server.id,
      bindingId: binding.id,
      expectedConnectionEpoch: 1,
      expectedBindingEpoch: 4,
      now,
    }),
    { active: false, reason: "audience_mismatch" },
  );

  await getDb()
    .update(externalBindingAudienceSnapshots)
    .set({ status: "unavailable" })
    .where(eq(externalBindingAudienceSnapshots.bindingId, binding.id));
  assert.deepEqual(
    await resolveExternalBindingAuthority({
      serverId: seeded.server.id,
      bindingId: binding.id,
      expectedConnectionEpoch: 1,
      expectedBindingEpoch: 4,
      now,
    }),
    { active: false, reason: "audience_unavailable" },
  );

  await getDb()
    .update(externalBindingAudienceSnapshots)
    .set({ status: "matched" })
    .where(eq(externalBindingAudienceSnapshots.bindingId, binding.id));
  const active = await resolveExternalBindingAuthority({
    serverId: seeded.server.id,
    bindingId: binding.id,
    expectedConnectionEpoch: 1,
    expectedBindingEpoch: 4,
    now,
  });
  assert.equal(active.active, true);
  if (!active.active) assert.fail("expected private binding authority");
  assert.equal(active.fact.audienceRevision, 7);
  assert.equal(active.fact.privacyClass, "private");

  const memberRowsBefore = await getDb().select().from(serverMembers);
  assert.deepEqual(await reconcileSlackPrivateAudience({
    serverId: seeded.server.id,
    bindingId: binding.id,
    expectedConnectionEpoch: 1,
    expectedBindingEpoch: 4,
    expectedAudienceRevision: 7,
    observation: {
      kind: "observed",
      externalMemberIds: ["U_B", "U_A", "U_A"],
      raftAuthorizedProviderMemberIds: ["U_A", "U_B"],
    },
    observedAt: new Date(now.getTime() + 1_000),
    expiresAt: new Date(now.getTime() + 31 * 60_000),
  }), {
    kind: "recorded",
    status: "matched",
    audienceRevision: 8,
    externalMemberCount: 2,
    raftMemberCount: 2,
  });
  assert.deepEqual(await reconcileSlackPrivateAudience({
    serverId: seeded.server.id,
    bindingId: binding.id,
    expectedConnectionEpoch: 1,
    expectedBindingEpoch: 4,
    expectedAudienceRevision: 8,
    observation: {
      kind: "observed",
      externalMemberIds: ["U_A", "U_B", "U_EXTERNAL_ONLY"],
      raftAuthorizedProviderMemberIds: ["U_A", "U_B"],
    },
    observedAt: new Date(now.getTime() + 2_000),
    expiresAt: new Date(now.getTime() + 32 * 60_000),
  }), {
    kind: "recorded",
    status: "mismatch",
    audienceRevision: 9,
    externalMemberCount: 3,
    raftMemberCount: 2,
  });
  assert.deepEqual(
    await resolveExternalBindingAuthority({
      serverId: seeded.server.id,
      bindingId: binding.id,
      expectedConnectionEpoch: 1,
      expectedBindingEpoch: 4,
      now: new Date(now.getTime() + 3_000),
    }),
    { active: false, reason: "audience_mismatch" },
  );
  assert.deepEqual(await reconcileSlackPrivateAudience({
    serverId: seeded.server.id,
    bindingId: binding.id,
    expectedConnectionEpoch: 1,
    expectedBindingEpoch: 4,
    expectedAudienceRevision: 9,
    observation: { kind: "unavailable", reason: "provider_rate_limited" },
    observedAt: new Date(now.getTime() + 3_000),
    expiresAt: new Date(now.getTime() + 33 * 60_000),
  }), {
    kind: "recorded",
    status: "unavailable",
    audienceRevision: 10,
    externalMemberCount: 0,
    raftMemberCount: 0,
  });
  assert.deepEqual(
    await resolveExternalBindingAuthority({
      serverId: seeded.server.id,
      bindingId: binding.id,
      expectedConnectionEpoch: 1,
      expectedBindingEpoch: 4,
      now: new Date(now.getTime() + 4_000),
    }),
    { active: false, reason: "audience_unavailable" },
  );
  const snapshotCount = (await getDb().select().from(externalBindingAudienceSnapshots)).length;
  assert.deepEqual(await reconcileSlackPrivateAudience({
    serverId: seeded.server.id,
    bindingId: binding.id,
    expectedConnectionEpoch: 1,
    expectedBindingEpoch: 4,
    expectedAudienceRevision: 9,
    observation: {
      kind: "observed",
      externalMemberIds: ["U_A"],
      raftAuthorizedProviderMemberIds: ["U_A"],
    },
    observedAt: new Date(now.getTime() + 4_000),
    expiresAt: new Date(now.getTime() + 34 * 60_000),
  }), { kind: "fence_mismatch" });
  assert.equal(
    (await getDb().select().from(externalBindingAudienceSnapshots)).length,
    snapshotCount,
    "stale audience revisions must not append a snapshot",
  );
  assert.deepEqual(
    await getDb().select().from(serverMembers),
    memberRowsBefore,
    "audience reconciliation must never add or remove Raft members",
  );
});

test("registration metadata projection cannot expose provider IDs or secret custody rows", async () => {
  const seeded = await seedControlPlane();
  const { claimed } = await beginAndClaim(seeded);
  const completed = await completeInstall(seeded, claimed.attemptId);
  const now = new Date("2026-07-24T00:00:00.000Z");
  await seedFreshInstallGrant(seeded, completed.installId, now);
  const metadata = await getExternalAppRegistrationMetadata(
    seeded.registration.id,
  );
  assert.ok(metadata);
  assert.equal(metadata.latestInstallGrantReceipt?.status, "valid");
  const serialized = JSON.stringify(metadata);
  assert.equal(serialized.includes(seeded.registration.providerAppId), false);
  assert.equal(serialized.includes(seeded.registration.providerOAuthClientId), false);
  assert.equal(serialized.includes("encrypted"), false);
  assert.deepEqual(
    Object.keys(metadata).sort(),
    [
      "capabilityManifestHash",
      "capabilityManifestVersion",
      "environment",
      "id",
      "latestInstallGrantReceipt",
      "provider",
      "state",
    ].sort(),
  );
});
