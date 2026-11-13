import { newSlackMentionAuthorizationId } from "./slackMentionReconcileState";
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import {
  channels,
  externalAppCredentials,
  externalAppInstallGrantReceipts,
  externalAppInstallServerGrants,
  externalAppInstalls, externalAppRegistrationSecrets,
  externalAppRegistrations,
  externalAppServerGrants,
  externalBindingAudienceSnapshots,
  externalChannelBindings,
  externalOAuthAttempts,
  oauthClientInstalls,
  oauthClients,
  servers,
  users
} from "../db/schema";
import { createServer } from "./serverService";
import {
  beginExternalOAuthAttempt,
  claimExternalOAuthAttempt,
  completeExternalOAuthAttempt,
  ExternalAppControlPlaneError,
  getExternalAppRegistrationMetadata,
  markExternalOAuthExchangeUnknown,
  resolveExternalBindingAuthority,
} from "./externalAppControlPlaneService";


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
  encryptedMaterial = "sealed:test-only-ciphertext",
  installedScopes = ["chat:write", "channels:history"],
  workspaceAdminVerified = true,
) {
  return completeExternalOAuthAttempt({
    attemptId,
    providerAppId: seeded.registration.providerAppId,
    providerTeamId: teamId,
    providerUserId,
    workspaceAdminVerified,
    botUserId: "U_TEST_BOT",
    providerBotId: "B_TEST_BOT",
    workspaceName: "Test Workspace",
    installedScopes,
    sealedCredential: {
      encryptedMaterial,
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

  const completed = await completeInstall(seeded, claimed.attemptId);
  assert.equal(completed.connectionEpoch, 1);
  assert.equal(completed.credentialRevision, 1);
  const [install] = await getDb().select().from(externalAppInstalls);
  const [credential] = await getDb().select().from(externalAppCredentials);
  const [attempt] = await getDb().select().from(externalOAuthAttempts);
  assert.equal(install.state, "active");
  assert.equal(install.serverId, seeded.server.id);
  assert.deepEqual(install.installedScopes, ["channels:history", "chat:write"]);
  assert.equal(credential.installId, install.id);
  assert.equal(credential.encryptedMaterial, "sealed:test-only-ciphertext");
  assert.equal(attempt.status, "consumed");
  assert.ok(attempt.consumedAt);
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
  assert.equal(
    (await getDb().select().from(externalOAuthAttempts))[0]?.status,
    "exchanging",
  );
});

test("OAuth reauthorization refreshes the same install with monotonic epochs", async () => {
  const seeded = await seedControlPlane();
  const first = await beginAndClaim(seeded);
  const firstCompleted = await completeInstall(
    seeded,
    first.claimed.attemptId,
    "T_TEST_WORKSPACE",
    "U_TEST_OWNER",
  );
  const second = await beginAndClaim(seeded);
  assert.equal(second.begun.providerTeamId, "T_TEST_WORKSPACE", "reauthorization hints the existing workspace by team id");
  const secondCompleted = await completeInstall(
    seeded,
    second.claimed.attemptId,
    "T_TEST_WORKSPACE",
    "U_TEST_OWNER",
  );

  assert.equal(firstCompleted.connectionEpoch, 1);
  assert.equal(secondCompleted.connectionEpoch, 2);
  assert.equal(secondCompleted.credentialRevision, 2);
});

for (const otherWorkspaceExists of [false, true]) {
  test(`reauthorization cannot add a second workspace (${otherWorkspaceExists ? "shared install" : "new install"})`, async () => {
    const seeded = await seedControlPlane();
    const first = await beginAndClaim(seeded);
    // Start both attempts before there is a selected workspace: completion must
    // recheck the selection, rather than trusting only the authorization start.
    const wrongWorkspaceAttempt = await beginAndClaim(seeded);
    const original = await completeInstall(seeded, first.claimed.attemptId);
    const [channel] = await getDb().insert(channels).values({
      serverId: seeded.server.id, name: `workspace-fence-${randomUUID()}`, type: "channel",
    }).returning();
    await getDb().insert(externalChannelBindings).values({
      serverId: seeded.server.id, registrationId: seeded.registration.id,
      installId: original.installId, channelId: channel.id,
      providerConversationId: "C_ORIGINAL", providerConversationKind: "public_channel",
      privacyClass: "public", grantEpoch: seeded.grant.grantEpoch,
      connectionEpoch: original.connectionEpoch, bindingEpoch: 1,
      consentedByType: "human", consentedById: seeded.owner.id, consentedAt: new Date(),
    });
    if (otherWorkspaceExists) {
      const server = await createServer("Other workspace server", `other-workspace-${randomUUID()}`, seeded.owner.id);
      await getDb().insert(oauthClientInstalls).values({
        serverId: server.id, clientId: seeded.client.id, installedByUserId: seeded.owner.id,
      });
      const [grant] = await getDb().insert(externalAppServerGrants).values({
        serverId: server.id, registrationId: seeded.registration.id, grantEpoch: 1,
        grantedManifestVersion: 1, grantedManifestHash: "manifest-v1",
        grantedCapabilities: ["external_projection", "channel_events"],
        grantedByType: "human", grantedById: seeded.owner.id,
      }).returning();
      const other = { ...seeded, server, grant };
      const attempt = await beginAndClaim(other);
      await completeInstall(other, attempt.claimed.attemptId, "T_OTHER_WORKSPACE");
    }
    const snapshot = async () => ({
      installs: await getDb().select().from(externalAppInstalls),
      credentials: await getDb().select().from(externalAppCredentials),
      associations: await getDb().select().from(externalAppInstallServerGrants),
      bindings: await getDb().select().from(externalChannelBindings),
    });
    const before = await snapshot();
    await assert.rejects(
      completeInstall(seeded, wrongWorkspaceAttempt.claimed.attemptId, "T_OTHER_WORKSPACE"),
      (error: unknown) => error instanceof ExternalAppControlPlaneError
        && error.code === "external_app_workspace_mismatch"
        && error.message.includes("another Slack workspace"),
    );
    assert.deepEqual(await snapshot(), before, "failed reauthorization must leave both workspaces and original bindings unchanged");
    const [attempt] = await getDb().select().from(externalOAuthAttempts)
      .where(eq(externalOAuthAttempts.id, wrongWorkspaceAttempt.claimed.attemptId));
    assert.equal(attempt.status, "exchanging", "the completion transaction must roll back");
  });
}

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

test("one provider workspace install is shared across two independently granted Raft servers", async () => {
  const seeded = await seedControlPlane();
  const first = await beginAndClaim(seeded);
  const firstInstall = await completeInstall(seeded, first.claimed.attemptId);
  const oldCapability = {
    authorizationId: newSlackMentionAuthorizationId(), result: "paid_teams_only" as const,
    connectionEpoch: firstInstall.connectionEpoch, credentialRevision: firstInstall.credentialRevision,
  };
  await getDb().update(externalAppInstalls).set({ slackMentionCapability: oldCapability })
    .where(eq(externalAppInstalls.id, firstInstall.installId));
  const [firstBoundChannel] = await getDb().insert(channels).values({
    serverId: seeded.server.id,
    name: `slack-first-bound-${randomUUID()}`,
    type: "channel",
  }).returning();
  const [firstBinding] = await getDb().insert(externalChannelBindings).values({
    serverId: seeded.server.id,
    registrationId: seeded.registration.id,
    installId: firstInstall.installId,
    channelId: firstBoundChannel.id,
    providerConversationId: "C_FIRST_SERVER",
    providerConversationKind: "public_channel",
    privacyClass: "public",
    grantEpoch: seeded.grant.grantEpoch,
    connectionEpoch: firstInstall.connectionEpoch,
    bindingEpoch: 1,
    consentedByType: "human",
    consentedById: seeded.owner.id,
    consentedAt: new Date(),
  }).returning();

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

  const secondSeed = { ...seeded, owner: secondOwner, server: secondServer, grant: secondGrant };
  await assert.rejects(completeInstall(secondSeed, secondClaim.attemptId, "T_TEST_WORKSPACE",
    "U_SECOND_OWNER", "sealed:must-not-overwrite", ["chat:write", "channels:history"], false),
  (error: unknown) => error instanceof ExternalAppControlPlaneError && error.code === "external_app_not_authorized");
  assert.equal((await getDb().select().from(externalAppInstallServerGrants)).length, 1,
    "a non-admin must not gain a server grant to the existing workspace");

  const second = await completeInstall(
    { ...seeded, owner: secondOwner, server: secondServer, grant: secondGrant },
    secondClaim.attemptId,
    "T_TEST_WORKSPACE",
    "U_SECOND_OWNER",
    "sealed:second-server-must-not-overwrite",
  );
  const installs = await getDb().select().from(externalAppInstalls);
  const serverGrants = await getDb().select().from(externalAppInstallServerGrants);
  assert.equal(serverGrants.find(row => row.serverId === secondServer.id)?.providerAuthorizingUserId, "U_SECOND_OWNER");
  const credentials = await getDb().select().from(externalAppCredentials);
  assert.equal(installs.length, 1, "the workspace token must not be copied per server");
  assert.equal(credentials.length, 1, "the shared install must retain one credential row");
  assert.equal(installs[0]!.slackMentionCapability?.result, "unverified",
    "fresh consent must re-probe a plan limitation even when sharing the existing token");
  assert.notEqual(installs[0]!.slackMentionCapability?.authorizationId, oldCapability.authorizationId);
  assert.equal(credentials[0]!.encryptedMaterial, "sealed:test-only-ciphertext");
  assert.equal(second.installId, installs[0]!.id);
  assert.equal(second.connectionEpoch, 1, "granting a second server must not rotate the shared workspace credential");
  assert.equal(installs[0]!.serverId, seeded.server.id, "the second server must not steal credential custody");
  const [preservedFirstBinding] = await getDb().select().from(externalChannelBindings)
    .where(eq(externalChannelBindings.id, firstBinding.id));
  assert.equal(preservedFirstBinding.state, "active");
  assert.equal(preservedFirstBinding.stateReason, null);
  assert.equal(preservedFirstBinding.connectionEpoch, firstInstall.connectionEpoch);
  assert.equal(preservedFirstBinding.bindingEpoch, 1);
  assert.deepEqual(
    serverGrants.map((entry) => [entry.serverId, entry.serverGrantId, entry.state]).sort(),
    [
      [seeded.server.id, seeded.grant.id, "active"],
      [secondServer.id, secondGrant.id, "active"],
    ].sort(),
  );

  const now = new Date("2026-09-25T00:00:00.000Z");
  await seedFreshInstallGrant(seeded, second.installId, now);
  const [secondChannel] = await getDb().insert(channels).values({
    serverId: secondServer.id,
    name: `slack-second-server-${randomUUID()}`,
    type: "channel",
  }).returning();
  const [secondBinding] = await getDb().insert(externalChannelBindings).values({
    serverId: secondServer.id,
    registrationId: seeded.registration.id,
    installId: second.installId,
    channelId: secondChannel.id,
    providerConversationId: "C_SECOND_SERVER",
    providerConversationKind: "public_channel",
    privacyClass: "public",
    privacyFreshUntil: new Date(now.getTime() + 60 * 60_000),
    grantEpoch: secondGrant.grantEpoch,
    connectionEpoch: second.connectionEpoch,
    bindingEpoch: 1,
    consentedByType: "human",
    consentedById: secondOwner.id,
    consentedAt: now,
  }).returning();
  const authority = await resolveExternalBindingAuthority({
    serverId: secondServer.id,
    bindingId: secondBinding.id,
    expectedConnectionEpoch: second.connectionEpoch,
    expectedBindingEpoch: secondBinding.bindingEpoch,
    now,
  });
  if (!authority.active) {
    assert.fail(`the second server must resolve through its own grant association: ${authority.reason}`);
  }

  const [firstCollisionChannel] = await getDb().insert(channels).values({
    serverId: seeded.server.id,
    name: `slack-first-server-${randomUUID()}`,
    type: "channel",
  }).returning();
  await assert.rejects(
    getDb().insert(externalChannelBindings).values({
      serverId: seeded.server.id,
      registrationId: seeded.registration.id,
      installId: second.installId,
      channelId: firstCollisionChannel.id,
      providerConversationId: "C_SECOND_SERVER",
      providerConversationKind: "public_channel",
      privacyClass: "public",
      privacyFreshUntil: new Date(now.getTime() + 60 * 60_000),
      grantEpoch: seeded.grant.grantEpoch,
      connectionEpoch: second.connectionEpoch,
      bindingEpoch: 1,
      consentedByType: "human",
      consentedById: seeded.owner.id,
      consentedAt: now,
    }),
    "one Slack channel must remain globally exclusive across server partitions",
  );

  const reconnectAttempt = await beginAndClaim(seeded);
  const reconnected = await completeInstall(
    seeded,
    reconnectAttempt.claimed.attemptId,
    "T_TEST_WORKSPACE",
    "U_TEST_OWNER",
    "sealed:workspace-reconnected",
  );
  assert.equal(reconnected.installId, second.installId);
  assert.equal(reconnected.connectionEpoch, 2);
  const frozenBindings = await getDb().select().from(externalChannelBindings).where(and(
    eq(externalChannelBindings.installId, second.installId),
    eq(externalChannelBindings.connectionEpoch, reconnected.connectionEpoch),
  ));
  assert.equal(frozenBindings.length, 2);
  assert.equal(frozenBindings.every((binding) =>
    binding.state === "paused"
    && binding.stateReason === "provider_reauthorized_review_required"
    && binding.bindingEpoch === 2), true,
  "workspace credential reconnect must atomically freeze every server partition");
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

test("private binding carries audience observations as refresh metadata, not an authority gate", async () => {
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
  // Private parity rule: audience snapshot rows are refresh observations, not
  // authority coordinates. A mismatched observation does not gate authority;
  // the outbound dispatch gate alone decides from the newest snapshot.
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
  const mismatchActive = await resolveExternalBindingAuthority({
    serverId: seeded.server.id,
    bindingId: binding.id,
    expectedConnectionEpoch: 1,
    expectedBindingEpoch: 4,
    now,
  });
  assert.equal(mismatchActive.active, true);
  if (!mismatchActive.active) assert.fail("expected private binding authority");
  assert.equal(mismatchActive.fact.audienceRevision, 7);
  assert.equal(mismatchActive.fact.privacyClass, "private");

  await getDb()
    .update(externalBindingAudienceSnapshots)
    .set({ status: "unavailable" })
    .where(eq(externalBindingAudienceSnapshots.bindingId, binding.id));
  const unavailableActive = await resolveExternalBindingAuthority({
    serverId: seeded.server.id,
    bindingId: binding.id,
    expectedConnectionEpoch: 1,
    expectedBindingEpoch: 4,
    now,
  });
  assert.equal(unavailableActive.active, true);

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
});

test("second server shares install when install scopes cover requested; rejects when install is missing a required scope", async () => {
  const seeded = await seedControlPlane();
  const first = await beginAndClaim(seeded);
  // First install carries extras beyond the two test requested scopes.
  await completeInstall(
    seeded,
    first.claimed.attemptId,
    "T_TEST_WORKSPACE",
    "U_TEST_OWNER",
    "sealed:test-only-ciphertext",
    ["chat:write", "channels:history", "usergroups:read", "usergroups:write"],
  );

  const [secondOwner] = await getDb().insert(users).values({
    email: `scope-second-${randomUUID()}@raft.test`,
    name: `scope-second-${randomUUID().slice(0, 8)}`,
    displayName: "Second Owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const secondServer = await createServer(
    "Scope Second Server",
    `scope-second-${randomUUID()}`,
    secondOwner.id,
  );
  await getDb().insert(oauthClientInstalls).values({
    serverId: secondServer.id,
    clientId: seeded.client.id,
    installedByUserId: secondOwner.id,
  });
  const [secondGrant] = await getDb().insert(externalAppServerGrants).values({
    serverId: secondServer.id,
    registrationId: seeded.registration.id,
    grantEpoch: 1,
    grantedManifestVersion: 1,
    grantedManifestHash: "manifest-v1",
    grantedCapabilities: ["external_projection", "channel_events"],
    grantedByType: "human",
    grantedById: secondOwner.id,
  }).returning();
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
  // Superset install + matching contract → second server shares (no conflict).
  const second = await completeInstall(
    { ...seeded, owner: secondOwner, server: secondServer, grant: secondGrant },
    secondClaim.attemptId,
    "T_TEST_WORKSPACE",
    "U_SECOND_OWNER",
    "sealed:second-must-not-overwrite",
    ["chat:write", "channels:history", "usergroups:read", "usergroups:write"],
  );
  const installs = await getDb().select().from(externalAppInstalls);
  assert.equal(installs.length, 1, "second server must share the existing install");
  assert.equal(second.installId, installs[0]!.id);

  // Now simulate the reverse: install is missing a required scope.
  // Remove chat:write from the install's recorded scopes.
  await getDb().update(externalAppInstalls).set({
    installedScopes: ["channels:history"],
  }).where(eq(externalAppInstalls.id, installs[0]!.id));

  const [thirdOwner] = await getDb().insert(users).values({
    email: `scope-third-${randomUUID()}@raft.test`,
    name: `scope-third-${randomUUID().slice(0, 8)}`,
    displayName: "Third Owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const thirdServer = await createServer(
    "Scope Third Server",
    `scope-third-${randomUUID()}`,
    thirdOwner.id,
  );
  await getDb().insert(oauthClientInstalls).values({
    serverId: thirdServer.id,
    clientId: seeded.client.id,
    installedByUserId: thirdOwner.id,
  });
  const [thirdGrant] = await getDb().insert(externalAppServerGrants).values({
    serverId: thirdServer.id,
    registrationId: seeded.registration.id,
    grantEpoch: 1,
    grantedManifestVersion: 1,
    grantedManifestHash: "manifest-v1",
    grantedCapabilities: ["external_projection", "channel_events"],
    grantedByType: "human",
    grantedById: thirdOwner.id,
  }).returning();
  const thirdAttempt = await beginExternalOAuthAttempt({
    serverId: thirdServer.id,
    registrationId: seeded.registration.id,
    serverGrantId: thirdGrant.id,
    grantEpoch: 1,
    requestingUserId: thirdOwner.id,
    redirectUri: "https://raft.test/api/external-apps/slack/oauth/callback",
    requestedScopes: ["channels:history", "chat:write"],
    grantIntent: "third-server-install",
  });
  const thirdClaim = await claimExternalOAuthAttempt({
    state: thirdAttempt.state,
    expectedEnvironment: "test",
    expectedRedirectUri: "https://raft.test/api/external-apps/slack/oauth/callback",
  });
  // Install missing chat:write but attempt requires it → must not share.
  await assert.rejects(
    completeInstall(
      { ...seeded, owner: thirdOwner, server: thirdServer, grant: thirdGrant },
      thirdClaim.attemptId,
      "T_TEST_WORKSPACE",
      "U_THIRD_OWNER",
      "sealed:third-must-not-overwrite",
      ["chat:write", "channels:history"],
    ),
    (error: unknown) =>
      error instanceof ExternalAppControlPlaneError
      && error.code === "external_app_install_conflict",
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
