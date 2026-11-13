import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import {
  agents,
  channelAgents,
  channelHumans,
  channels,
  externalActorProjections,
  externalAddressabilityProjections,
  externalAppCredentials,
  externalAppInstallServerGrants,
  externalAppInstalls,
  externalAppRegistrations,
  externalAppRegistrationSecrets,
  externalAppServerGrants,
  externalBindingAudienceSnapshots,
  externalChannelBindings,
  externalHumanIdentityLinks,
  slackUsergroupIdentities,
  type SlackUsergroupRecoveryRef,
  externalInboundEvents,
  externalMessageLinks,
  externalOutboundDeliveries,
  externalDeliveryPartitions,
  slackAttachmentPlanRollout,
  featureFlags,
  messageMentions,
  messages,
  oauthClientInstalls,
  oauthClients,
  servers,
  users,
} from "../db/schema";
import { SLACK_BRIDGE_REQUIRED_BOT_SCOPES } from "../routes/slackBridge";
import { resolveExternalBindingAuthority } from "./externalAppControlPlaneService";
import {
  createFeatureFlagRule,
  updateFeatureFlagRule,
} from "./featureFlagService";
import {
  enqueueExternalInboundEvent,
  type ExternalInboundNormalizedMessage,
  type ExternalInboundRuntimeAuthority,
} from "./externalInboundWorkerService";
import { createServer } from "./serverService";
import { broadcastAndDeliver } from "./messageService";
import {
  EXTERNAL_DELIVERY_AUTHORITY_BACKOFF_BASE_MS,
  EXTERNAL_DELIVERY_AUTHORITY_OVERDUE_MS,
  type ExternalDeliveryAuthorityAlert,
} from "./externalDeliveryWorkerService";
import { slackBridgeDatabaseRuntimeRevision } from "./slackBridgeDatabaseRuntimeAuthority";
import {
  createSlackBridgeEnvCredentialCipher,
  slackBridgeKeyFromEnv,
  SLACK_BRIDGE_CREDENTIAL_KEY_ID,
} from "./slackBridgeEnvSecrets";
import { createSlackBridgeServerRuntimeFromEnv } from "./slackBridgeServerRuntime";
import { refreshSlackConversationAuthority } from "./slackBridgeProvisioningControlPlane";
import { withChannelDelivery } from "../test/orchestratorStub";

// Built at runtime so secret scanners don't flag this test sample.
const SLACK_XOXB = "xo" + "xb-";

const MANAGED_ENV: NodeJS.ProcessEnv = {
  SLACK_BRIDGE_ENVIRONMENT: "production",
  SLACK_BRIDGE_REGISTRATION_ID: "11111111-1111-4111-8111-111111111111",
  SLACK_BRIDGE_PROVIDER_APP_ID: "A_MANAGED_RUNTIME",
  SLACK_BRIDGE_PROVIDER_OAUTH_CLIENT_ID: "managed-runtime-client",
  SLACK_BRIDGE_OAUTH_REDIRECT_URI: "https://raft.example/api/slack-bridge/oauth/callback",
  SLACK_BRIDGE_EVENTS_REQUEST_URL: "https://bridge.example/api/slack-bridge/events",
  SLACK_BRIDGE_SIGNING_SECRET: "signing-secret",
  SLACK_BRIDGE_OAUTH_CLIENT_SECRET: "oauth-client-secret",
  SLACK_BRIDGE_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  SLACK_BRIDGE_PAYLOAD_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  APP_URL: "https://raft.example/",
};

const NOW = new Date("2026-08-11T20:00:00.000Z");

const noopOrchestrator = withChannelDelivery({ deliverMessage: async () => undefined }) as any;

function createIo() {
  return {
    to() {
      return { emit() {} };
    },
    in() {
      return { in() { return { socketsJoin() {} }; }, socketsJoin() {} };
    },
  } as any;
}

beforeEach(async () => {
  await openTestDatabase("pglite://");
});

afterEach(async () => {
  await closeTestDatabase();
});

async function seedManagedAudience(privacyClass: "public" | "private" = "private") {
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `slack-managed-${randomUUID()}@raft.test`,
    name: `slack-managed-${randomUUID().slice(0, 8)}`,
    passwordHash: "test-only",
    emailVerified: true,
  }).returning();
  const server = await createServer(
    "Slack Managed Runtime",
    `slack-managed-${randomUUID()}`,
    owner.id,
  );
  const masterRule = await createFeatureFlagRule({
    flagKey: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master,
    stage: "server",
    decision: "allow",
    values: [server.id],
  });
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: `slack-private-${randomUUID().slice(0, 8)}`,
    type: privacyClass === "private" ? "private" : "channel",
  }).returning();
  await db.insert(channelHumans).values({ channelId: channel.id, userId: owner.id });
  const [client] = await db.insert(oauthClients).values({
    serverId: server.id,
    clientId: `slack-managed-${randomUUID()}`,
    clientSecretHash: "test-only",
    appType: "slock_builtin",
    name: "Slack Bridge",
    allowedScopes: ["messages:read", "messages:write"],
    createdByUserId: owner.id,
  }).returning();
  await db.insert(oauthClientInstalls).values({
    serverId: server.id,
    clientId: client.id,
    installedByUserId: owner.id,
  });
  const [registration] = await db.insert(externalAppRegistrations).values({
    id: MANAGED_ENV.SLACK_BRIDGE_REGISTRATION_ID,
    oauthClientId: client.id,
    provider: "slack",
    environment: "production",
    providerAppId: "A_MANAGED_RUNTIME",
    providerOAuthClientId: "managed-runtime-client",
    capabilityManifestVersion: 1,
    capabilityManifestHash: "managed-runtime-v1",
    requiredCapabilities: ["private_audience"],
  }).returning();
  const [grant] = await db.insert(externalAppServerGrants).values({
    serverId: server.id,
    registrationId: registration.id,
    grantEpoch: 1,
    grantedManifestVersion: 1,
    grantedManifestHash: "managed-runtime-v1",
    grantedCapabilities: ["private_audience"],
    grantedByType: "human",
    grantedById: owner.id,
  }).returning();
  await db.insert(externalAppRegistrationSecrets).values({
    registrationId: registration.id,
    purpose: "signing_secret",
    encryptedSecretRef: "env://SLACK_BRIDGE_SIGNING_SECRET",
    envelopeKeyId: "env:process",
    secretRevision: 1,
  });
  const [install] = await db.insert(externalAppInstalls).values({
    serverId: server.id,
    registrationId: registration.id,
    serverGrantId: grant.id,
    grantEpoch: 1,
    state: "active",
    connectionEpoch: 2,
    scopeRevision: 1,
    credentialRevision: 1,
    installedScopes: [...SLACK_BRIDGE_REQUIRED_BOT_SCOPES],
    providerAppId: "A_MANAGED_RUNTIME",
    providerTeamId: "T_MANAGED_RUNTIME",
    authorityType: "team",
    providerAuthorityId: "T_MANAGED_RUNTIME",
    botUserId: "U_MANAGED_BOT",
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
  const credentialCipher = createSlackBridgeEnvCredentialCipher({
    key: slackBridgeKeyFromEnv(
      MANAGED_ENV.SLACK_BRIDGE_CREDENTIAL_ENCRYPTION_KEY,
      "SLACK_BRIDGE_CREDENTIAL_ENCRYPTION_KEY",
    ),
  });
  const sealed = await credentialCipher.sealer.seal({
    serverId: server.id,
    accessToken: `${SLACK_XOXB}managed-test`,
    tokenType: "bot",
    providerAppId: "A_MANAGED_RUNTIME",
    providerTeamId: "T_MANAGED_RUNTIME",
    botUserId: "U_MANAGED_BOT",
    now: NOW,
  });
  await db.insert(externalAppCredentials).values({
    installId: install.id,
    state: "active",
    encryptedMaterial: sealed.encryptedMaterial,
    envelopeKeyId: sealed.envelopeKeyId,
    aadVersion: sealed.aadVersion,
    credentialRevision: 1,
  });
  const [binding] = await db.insert(externalChannelBindings).values({
    serverId: server.id,
    registrationId: registration.id,
    installId: install.id,
    channelId: channel.id,
    providerConversationId: privacyClass === "private" ? "G_MANAGED_PRIVATE" : "C_MANAGED_PUBLIC",
    providerConversationKind: privacyClass === "private" ? "private_channel" : "public_channel",
    privacyClass,
    state: "active",
    grantEpoch: 1,
    connectionEpoch: 2,
    bindingEpoch: 3,
    audienceRevision: privacyClass === "private" ? 1 : null,
    audienceFreshUntil: privacyClass === "private" ? new Date(NOW.getTime() + 60_000) : null,
    consentedByType: "human",
    consentedById: owner.id,
    consentedAt: NOW,
  }).returning();
  await db.insert(externalBindingAudienceSnapshots).values({
    bindingId: binding.id,
    bindingEpoch: 3,
    audienceRevision: 1,
    externalMemberCount: 1,
    externalAudienceDigest: "old-external",
    raftMemberCount: 1,
    raftAudienceDigest: "old-raft",
    status: privacyClass === "private" ? "unavailable" : "matched",
    observedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60_000),
  });
  const [projection] = await db.insert(externalActorProjections).values({
    provider: "slack",
    appRegistrationId: registration.id,
    installId: install.id,
    workspaceId: "T_MANAGED_RUNTIME",
    externalActorId: "U_MANAGED_OWNER",
    displayName: "Managed Owner",
    handles: ["managed-owner"],
    actorKind: "human",
    state: "active",
    deactivated: false,
    projectionRevision: 1,
    observedAt: NOW,
  }).returning();
  await db.insert(externalHumanIdentityLinks).values({
    serverId: server.id,
    installId: install.id,
    userId: owner.id,
    provider: "slack",
    providerAuthorityId: "T_MANAGED_RUNTIME",
    providerUserId: "U_MANAGED_OWNER",
    state: "active",
    linkEpoch: 1,
    observedConnectionEpoch: 2,
  });
  // Human mentions render through a managed usergroup, not an OAuth link.
  await db.insert(slackUsergroupIdentities).values({
    installId: install.id,
    serverId: server.id,
    principalKind: "user",
    principalId: owner.id,
    recoveryRef: randomBytes(24).toString("hex") as SlackUsergroupRecoveryRef,
    providerUsergroupId: "S_MANAGED_OWNER",
    humanCanonical: true,
  });
  await db.insert(externalAddressabilityProjections).values({
    projectionId: projection.id,
    provider: "slack",
    appRegistrationId: registration.id,
    installId: install.id,
    workspaceId: "T_MANAGED_RUNTIME",
    connectionEpoch: 2,
    bindingId: binding.id,
    bindingEpoch: 3,
    conversationId: "G_MANAGED_PRIVATE",
    memberRevision: 1,
    contextRevision: 1,
    state: "active",
    observedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60 * 60_000),
  });
  return {
    owner,
    server,
    channel,
    registration,
    grant,
    install,
    binding,
    projection,
    masterRule,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function waitFor(
  predicate: () => Promise<boolean>,
  label: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("managed runtime selection is explicit, complete, and mutually exclusive with local custody", async () => {
  assert.equal(await createSlackBridgeServerRuntimeFromEnv({ NODE_ENV: "production" }), undefined);
  await assert.rejects(createSlackBridgeServerRuntimeFromEnv({
    SLACK_BRIDGE_PAYLOAD_KMS_KEY_ID: "kms-key",
  }), /legacy local\/AWS runtime configuration is not supported/);
  await assert.rejects(createSlackBridgeServerRuntimeFromEnv({
    ...MANAGED_ENV,
    SLACK_BRIDGE_LOCAL_RUNTIME_CONFIG_FILE: "/tmp/local.json",
  }), /legacy local\/AWS runtime configuration is not supported/);
  await assert.rejects(createSlackBridgeServerRuntimeFromEnv({
    ...MANAGED_ENV,
    SLACK_BRIDGE_EVENTS_REQUEST_URL: "http://bridge.example/api/slack-bridge/events",
  }), /credential-free HTTPS/);
  await assert.rejects(createSlackBridgeServerRuntimeFromEnv({
    ...MANAGED_ENV,
    APP_URL: "http://raft.example",
  }), /app URL must be credential-free HTTPS/);
  const missingAppUrl = { ...MANAGED_ENV };
  delete missingAppUrl.APP_URL;
  await assert.rejects(
    createSlackBridgeServerRuntimeFromEnv(missingAppUrl),
    /requires APP_URL/,
  );
  const missing = { ...MANAGED_ENV };
  delete missing.SLACK_BRIDGE_PAYLOAD_ENCRYPTION_KEY;
  await assert.rejects(createSlackBridgeServerRuntimeFromEnv(missing), /SLACK_BRIDGE_PAYLOAD_ENCRYPTION_KEY/);
});

test("managed test runtime requires an explicit credential-free HTTP(S) app origin", async () => {
  const testEnv: NodeJS.ProcessEnv = {
    ...MANAGED_ENV,
    SLACK_BRIDGE_ENVIRONMENT: "test",
    APP_URL: "http://127.0.0.1:5173/ignored/path",
  };
  const runtime = await createSlackBridgeServerRuntimeFromEnv(testEnv);
  assert.ok(runtime);
  assert.equal(runtime.appOrigin, "http://127.0.0.1:5173");
  await runtime.stop();

  const missingAppUrl = { ...testEnv };
  delete missingAppUrl.APP_URL;
  await assert.rejects(
    createSlackBridgeServerRuntimeFromEnv(missingAppUrl),
    /requires APP_URL/,
  );
  await assert.rejects(
    createSlackBridgeServerRuntimeFromEnv({
      ...testEnv,
      APP_URL: "not a URL",
    }),
    /app URL is invalid/,
  );
  await assert.rejects(
    createSlackBridgeServerRuntimeFromEnv({
      ...testEnv,
      APP_URL: "https://user:password@raft.example",
    }),
    /app URL must be credential-free HTTP\(S\)/,
  );
  await assert.rejects(
    createSlackBridgeServerRuntimeFromEnv({
      ...testEnv,
      APP_URL: "ftp://raft.example",
    }),
    /app URL must be credential-free HTTP\(S\)/,
  );
});

test("managed runtime composition is side-effect free before the server start hook", async () => {
  let providerCalls = 0;
  const runtime = await createSlackBridgeServerRuntimeFromEnv(MANAGED_ENV, {
    fetch: (async () => {
      providerCalls += 1;
      throw new Error("must not call Slack during startup");
    }) as typeof fetch,
  });

  assert.ok(runtime && "inboundWorkerDependencies" in runtime);
  assert.equal(runtime.environment, "production");
  assert.equal(runtime.oauthRedirectUri, MANAGED_ENV.SLACK_BRIDGE_OAUTH_REDIRECT_URI);
  assert.equal(runtime.eventsRequestUrl, MANAGED_ENV.SLACK_BRIDGE_EVENTS_REQUEST_URL);
  assert.equal(typeof runtime.secretResolver.resolveSigningSecret, "function");
  assert.equal(typeof runtime.payloadSealer.sealNormalizedPayload, "function");
  assert.equal(typeof runtime.runtimeResolver?.resolveCurrentRuntime, "function");
  assert.equal(typeof runtime.provisioning?.load, "function");
  assert.equal(typeof runtime.inboundWorkerDependencies.decryptNormalizedPayload, "function");
  assert.equal(typeof runtime.inboundWorkerDependencies.resolveCurrentRuntime, "function");
  await runtime.stop();
  assert.equal(providerCalls, 0);
});

test("managed runtime resolves the trusted IM Bridges destination from the claimed server", async () => {
  const seeded = await seedManagedAudience();
  const runtime = await createSlackBridgeServerRuntimeFromEnv(MANAGED_ENV, {
    db: getDb(),
  });
  assert.ok(runtime);

  assert.equal(
    await runtime.resolveOAuthCompletionRedirectPath({ serverId: seeded.server.id }),
    `/s/${encodeURIComponent(seeded.server.slug)}/settings/im-bridges`,
  );
  assert.equal(
    await runtime.resolveOAuthCompletionRedirectPath({ serverId: randomUUID() }),
    null,
  );
  await getDb()
    .update(servers)
    .set({ kind: "joint_storage" })
    .where(eq(servers.id, seeded.server.id));
  assert.equal(
    await runtime.resolveOAuthCompletionRedirectPath({ serverId: seeded.server.id }),
    null,
  );
  await getDb()
    .update(servers)
    .set({ kind: "normal", deletedAt: NOW })
    .where(eq(servers.id, seeded.server.id));
  assert.equal(
    await runtime.resolveOAuthCompletionRedirectPath({ serverId: seeded.server.id }),
    null,
  );
  await runtime.stop();
});

test("attachment authority rejects a stale server-grant epoch with the canonical binding fence", async () => {
  const seeded = await seedManagedAudience("public");
  // A retained legacy child flag stays off; attachment authority follows master.
  await getDb().insert(featureFlags).values({
    key: SLACK_BRIDGE_FEATURE_FLAG_KEYS.attachmentTransfer,
    description: "Retired attachment flag", enabled: true, defaultEnabled: false,
    killSwitch: false, randomizationUnit: "server", salt: SLACK_BRIDGE_FEATURE_FLAG_KEYS.attachmentTransfer,
  });
  const runtime = await createSlackBridgeServerRuntimeFromEnv(MANAGED_ENV, {
    db: getDb(),
    now: () => NOW,
  });
  assert.ok(runtime);
  const authority = {
    provider: "slack",
    appRegistrationId: seeded.registration.id,
    installId: seeded.install.id,
    workspaceId: seeded.install.providerAuthorityId,
    providerAuthorityId: seeded.install.providerAuthorityId,
    providerConversationId: seeded.binding.providerConversationId,
    connectionEpoch: seeded.install.connectionEpoch,
    bindingId: seeded.binding.id,
    bindingEpoch: seeded.binding.bindingEpoch,
  };
  const authorityIsCurrent = runtime.inboundAttachmentWorkerDependencies.authorityIsCurrent;
  assert.ok(authorityIsCurrent);
  assert.equal(await authorityIsCurrent(authority, seeded.projection.id, getDb()), true);
  await updateFeatureFlagRule(SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, seeded.masterRule.id, { decision: "deny" });
  assert.equal(await authorityIsCurrent(authority, seeded.projection.id, getDb()), "paused");
  await updateFeatureFlagRule(SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, seeded.masterRule.id, { decision: "allow" });
  assert.equal(await authorityIsCurrent(authority, seeded.projection.id, getDb()), true);

  await getDb().update(externalAppServerGrants).set({ grantEpoch: 2 })
    .where(eq(externalAppServerGrants.id, seeded.grant.id));
  const canonical = await resolveExternalBindingAuthority({
    serverId: seeded.server.id,
    bindingId: seeded.binding.id,
    expectedConnectionEpoch: seeded.binding.connectionEpoch,
    expectedBindingEpoch: seeded.binding.bindingEpoch,
    now: NOW,
  });
  assert.deepEqual(canonical, { active: false, reason: "epoch_mismatch" });
  assert.equal(await authorityIsCurrent(authority, seeded.projection.id, getDb()), false);
  await runtime.stop();
});

test("managed server lifecycle consumes the database human resolver on start, event, periodic, and stop", async () => {
  const seeded = await seedManagedAudience();
  let installGrantCalls = 0;
  let audienceCalls = 0;
  let allowRunClaim = true;
  let privacyCalls = 0;
  let mentionCalls = 0;
  const humanUsergroupMarkers: string[] = [];
  let rateLimitNextPrivacyCall = false;
  let runtimeNow = NOW;
  let periodic: () => void = () => assert.fail("periodic callback was not scheduled");
  let cleared = false;
  const receipts: unknown[] = [];
  let receiptWaiter: (() => void) | null = null;
  const waitForReceipt = async (count: number) => {
    while (receipts.length < count) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error(`missing lifecycle receipt ${count}`)),
          1_000,
        );
        receiptWaiter = () => {
          clearTimeout(timeout);
          resolve();
        };
      });
    }
  };
  const runtime = await createSlackBridgeServerRuntimeFromEnv(MANAGED_ENV, {
    db: getDb(),
    now: () => runtimeNow,
    lifecycleIntervalMs: 1_000,
    claimLifecycleRun: async () => allowRunClaim
      ? { held: async () => true, end() {} }
      : null,
    lifecycleClock: {
      scheduleEvery(fn, intervalMs) {
        assert.equal(intervalMs, 1_000);
        periodic = fn;
        return "managed-lifecycle";
      },
      clear(handle) {
        assert.equal(handle, "managed-lifecycle");
        cleared = true;
      },
    },
    onLifecycleReceipt(receipt) {
      receipts.push(receipt);
      receiptWaiter?.();
      receiptWaiter = null;
    },
    fetch: (async (url, init) => {
      assert.match(String(new Headers(init?.headers).get("authorization")), /^Bearer xoxb-/);
      if (String(url) === "https://slack.com/api/auth.test") {
        installGrantCalls += 1;
        return new Response(JSON.stringify({
          ok: true,
          app_id: "A_MANAGED_RUNTIME",
          team_id: "T_MANAGED_RUNTIME",
          user_id: "U_MANAGED_BOT",
          bot_id: "B_MANAGED_BOT",
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-oauth-scopes": SLACK_BRIDGE_REQUIRED_BOT_SCOPES.join(","),
          },
        });
      }
      if (String(url).startsWith("https://slack.com/api/conversations.info")) {
        privacyCalls += 1;
        const requestUrl = new URL(String(url));
        const providerConversationId = requestUrl.searchParams.get("channel");
        assert.ok([
          "G_MANAGED_PRIVATE",
          "G_MANAGED_PRIVATE_SECOND",
        ].includes(providerConversationId ?? ""));
        if (rateLimitNextPrivacyCall) {
          rateLimitNextPrivacyCall = false;
          return new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
            status: 429,
            headers: { "content-type": "application/json", "retry-after": "120" },
          });
        }
        return new Response(JSON.stringify({
          ok: true,
          channel: {
            id: providerConversationId,
            is_private: true,
            is_archived: false,
            is_member: true,
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (String(url).startsWith("https://slack.com/api/usergroups.list")) {
        mentionCalls += 1;
        return new Response(JSON.stringify({ ok: true, usergroups: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(url).startsWith("https://slack.com/api/usergroups.create") || String(url).startsWith("https://slack.com/api/usergroups.update")) {
        // Bound-channel humans get managed usergroups alongside Agents.
        const request = JSON.parse(String(init?.body)) as Record<string, string>;
        humanUsergroupMarkers.push(String(request.description));
        return new Response(JSON.stringify({
          ok: true,
          usergroup: { id: "SMANAGEDHUMAN", ...request, date_delete: 0 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (String(url).startsWith("https://slack.com/api/users.info")) {
        const requestUrl = new URL(String(url));
        const providerUserId = requestUrl.searchParams.get("user") ?? "";
        return new Response(JSON.stringify({
          ok: true,
          user: {
            id: providerUserId,
            name: providerUserId.toLowerCase(),
            is_bot: providerUserId === "U_MANAGED_BOT",
            profile: { display_name: providerUserId },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      audienceCalls += 1;
      const requestUrl = new URL(String(url));
      assert.equal(
        requestUrl.origin + requestUrl.pathname,
        "https://slack.com/api/conversations.members",
      );
      assert.ok([
        "G_MANAGED_PRIVATE",
        "G_MANAGED_PRIVATE_SECOND",
      ].includes(requestUrl.searchParams.get("channel") ?? ""));
      assert.equal(requestUrl.searchParams.get("limit"), "200");
      assert.equal(requestUrl.searchParams.has("token"), false);
      assert.equal(init?.method, "GET");
      assert.equal(init?.body, undefined);
      assert.equal(new Headers(init?.headers).has("content-type"), false);
      return new Response(JSON.stringify({
        ok: true,
        members: ["U_MANAGED_OWNER", "U_MANAGED_BOT"],
        response_metadata: { next_cursor: "" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  assert.ok(runtime && "requestLifecycleReconcile" in runtime);

  runtime.start();
  await waitForReceipt(1);
  assert.equal(installGrantCalls, 1, "server start repairs missing install authority once");
  assert.equal(audienceCalls, 1, "server start performs one live audience refresh");
  assert.equal(privacyCalls, 1, "server start verifies provider privacy separately");
  assert.equal(mentionCalls, 1, "server start reconciles Agent mention handles");
  assert.ok(
    humanUsergroupMarkers.includes("Raft member"),
    "server start reconciles paired-channel human mention handles",
  );
  const startSnapshot = await getDb().select().from(externalBindingAudienceSnapshots);
  assert.equal(startSnapshot.at(-1)?.bindingId, seeded.binding.id);
  assert.equal(startSnapshot.at(-1)?.status, "matched");

  await runtime.requestLifecycleReconcile?.();
  await waitForReceipt(2);
  assert.equal(installGrantCalls, 1, "fresh install authority is not re-read on every event");
  assert.equal(audienceCalls, 2, "explicit reconciliation reaches the provider");
  assert.equal(privacyCalls, 2, "explicit reconciliation refreshes privacy freshness");
  assert.equal(mentionCalls, 2, "explicit reconciliation refreshes Agent handles");

  allowRunClaim = false;
  const deniedPass = await runtime.requestLifecycleReconcile?.();
  assert.deepEqual(deniedPass, { kind: "completed", trigger: "event", bindingCount: 0 });
  assert.deepEqual([installGrantCalls, audienceCalls, privacyCalls, mentionCalls], [1, 2, 2, 2],
    "a replica without the whole-pass claim must do no provider work");
  const snapshotsBeforePeriodic = (await getDb().select().from(externalBindingAudienceSnapshots)).length;
  allowRunClaim = true;
  periodic();
  await waitForReceipt(3);
  assert.equal(installGrantCalls, 1, "fresh install authority is not re-read on every tick");
  assert.equal(audienceCalls, 2, "periodic reconciliation reuses a coherent fresh member snapshot");
  assert.equal((await getDb().select().from(externalBindingAudienceSnapshots)).length, snapshotsBeforePeriodic,
    "an unchanged fresh periodic pass must not append another audience revision");
  assert.equal(privacyCalls, 3, "periodic reconciliation refreshes privacy freshness");
  assert.equal(mentionCalls, 3, "periodic reconciliation refreshes Agent handles");

  const [secondChannel] = await getDb().insert(channels).values({
    serverId: seeded.server.id,
    name: `slack-private-second-${randomUUID().slice(0, 8)}`,
    type: "private",
  }).returning();
  await getDb().insert(channelHumans).values({
    channelId: secondChannel.id,
    userId: seeded.owner.id,
  });
  const [secondBinding] = await getDb().insert(externalChannelBindings).values({
    id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    serverId: seeded.server.id,
    registrationId: seeded.registration.id,
    installId: seeded.install.id,
    channelId: secondChannel.id,
    providerConversationId: "G_MANAGED_PRIVATE_SECOND",
    providerConversationKind: "private_channel",
    privacyClass: "private",
    state: "active",
    grantEpoch: 1,
    connectionEpoch: 2,
    bindingEpoch: 1,
    audienceRevision: 1,
    audienceFreshUntil: new Date(NOW.getTime() + 60_000),
    consentedByType: "human",
    consentedById: seeded.owner.id,
    consentedAt: NOW,
  }).returning();
  rateLimitNextPrivacyCall = true;
  await runtime.requestLifecycleReconcile?.();
  await waitForReceipt(4);
  assert.equal(
    privacyCalls,
    4,
    "the first binding rate limit stops the same install before its second provider call",
  );
  await runtime.requestLifecycleReconcile?.();
  await waitForReceipt(5);
  assert.equal(
    privacyCalls,
    4,
    "event reconciliation must not retry privacy before Slack Retry-After",
  );
  runtimeNow = new Date(NOW.getTime() + 120_000);
  await runtime.requestLifecycleReconcile?.();
  await waitForReceipt(6);
  assert.equal(
    privacyCalls,
    6,
    "both bindings resume only after their shared install retry deadline",
  );
  await getDb().update(externalChannelBindings).set({
    state: "paused",
    stateReason: "test_second_binding_pause",
  }).where(eq(externalChannelBindings.id, secondBinding.id));
  const audienceCallsAfterPrivacyBackoff = audienceCalls;

  await getDb().update(externalAppCredentials).set({ envelopeKeyId: "env:wrong-key" });
  await runtime.requestLifecycleReconcile?.();
  await waitForReceipt(7);
  assert.equal(
    audienceCalls,
    audienceCallsAfterPrivacyBackoff,
    "a mismatched env key id fails closed before Slack access",
  );

  await getDb().update(externalAppCredentials).set({ envelopeKeyId: SLACK_BRIDGE_CREDENTIAL_KEY_ID });
  await getDb().delete(externalHumanIdentityLinks);
  await runtime.requestLifecycleReconcile?.();
  await waitForReceipt(8);
  assert.equal(
    audienceCalls,
    audienceCallsAfterPrivacyBackoff + 1,
    "per-member OAuth links are no longer a private refresh prerequisite",
  );
  const unavailableSnapshot = await getDb().select().from(externalBindingAudienceSnapshots);
  assert.equal(
    unavailableSnapshot.at(-1)?.status,
    "matched",
    "private audience observation matches on provider member fact alone",
  );

  const callsBeforeRenewal = audienceCalls;
  await getDb().update(externalBindingAudienceSnapshots).set({
    expiresAt: new Date(runtimeNow.getTime() + 10 * 60_000),
  });
  const receiptsBeforeRenewal = receipts.length;
  periodic();
  await waitForReceipt(receiptsBeforeRenewal + 1);
  assert.equal(audienceCalls, callsBeforeRenewal + 1, "the shared fallback renews before the existing authority expires");
  await getDb().update(externalAddressabilityProjections).set({ contextRevision: 999 });
  const receiptsBeforeDrift = receipts.length;
  periodic();
  await waitForReceipt(receiptsBeforeDrift + 1);
  assert.equal(audienceCalls, callsBeforeRenewal + 2, "a real authority mismatch cannot reuse a fresh snapshot");
  const callsBeforePause = audienceCalls;
  const snapshotsBeforePause = (await getDb().select().from(externalBindingAudienceSnapshots)).length;

  await getDb().update(externalChannelBindings).set({
    state: "paused",
    stateReason: "test_pause",
  });
  const pausedResult = await runtime.requestLifecycleReconcile?.();
  assert.deepEqual(pausedResult, { kind: "completed", trigger: "event", bindingCount: 0 });
  assert.equal(audienceCalls, callsBeforePause);
  assert.equal(
    (await getDb().select().from(externalBindingAudienceSnapshots)).length,
    snapshotsBeforePause,
    "inactive bindings do not append audience snapshots",
  );

  await runtime.stop();
  assert.equal(cleared, true);
  await runtime.requestLifecycleReconcile?.();
  assert.equal(
    audienceCalls,
    callsBeforePause,
    "stopped runtime rejects later event reconciliation",
  );
});

test("managed server start and stop own the durable inbound worker lifecycle", async ({ onTestFinished }) => {
  const seeded = await seedManagedAudience();
  let firstReceipt: (() => void) | null = null;
  const started = new Promise<void>((resolve) => {
    firstReceipt = resolve;
  });
  const runtime = await createSlackBridgeServerRuntimeFromEnv(MANAGED_ENV, {
    db: getDb(),
    now: () => NOW,
    lifecycleIntervalMs: 60_000,
    inboundWorkerIntervalMs: 10,
    inboundWorkerLeaseOwner: "managed-runtime-inbound-test",
    onLifecycleReceipt() {
      firstReceipt?.();
      firstReceipt = null;
    },
    fetch: (async (url) => {
      if (String(url) === "https://slack.com/api/auth.test") {
        return new Response(JSON.stringify({
          ok: true,
          app_id: "A_MANAGED_RUNTIME",
          team_id: "T_MANAGED_RUNTIME",
          user_id: "U_MANAGED_BOT",
          bot_id: "B_MANAGED_BOT",
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-oauth-scopes": SLACK_BRIDGE_REQUIRED_BOT_SCOPES.join(","),
          },
        });
      }
      return new Response(JSON.stringify({
        ok: true,
        members: ["U_MANAGED_OWNER", "U_MANAGED_BOT"],
        response_metadata: { next_cursor: "" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  assert.ok(runtime);
  onTestFinished(async () => runtime.stop());

  runtime.start();
  await started;
  const authorityDecision = await resolveExternalBindingAuthority({
    serverId: seeded.server.id,
    bindingId: seeded.binding.id,
    expectedConnectionEpoch: seeded.install.connectionEpoch,
    expectedBindingEpoch: seeded.binding.bindingEpoch,
    now: NOW,
  }, getDb());
  if (!authorityDecision.active) assert.fail(authorityDecision.reason);
  const authority: ExternalInboundRuntimeAuthority = {
    runtimeRevision: slackBridgeDatabaseRuntimeRevision(authorityDecision.fact),
    provider: authorityDecision.fact.provider,
    environment: authorityDecision.fact.environment,
    appRegistrationId: authorityDecision.fact.registrationId,
    installId: authorityDecision.fact.installId,
    workspaceId: authorityDecision.fact.providerAuthorityId,
    providerAuthorityId: authorityDecision.fact.providerAuthorityId,
    providerConversationId: authorityDecision.fact.providerConversationId,
    bindingId: authorityDecision.fact.bindingId,
    bindingEpoch: authorityDecision.fact.bindingEpoch,
    connectionEpoch: authorityDecision.fact.connectionEpoch,
    raftChannelId: authorityDecision.fact.channelId,
    privacyClass: authorityDecision.fact.privacyClass,
  };
  const admit = async (providerEventId: string, providerMessageId: string) => {
    const payload: ExternalInboundNormalizedMessage = {
      schema: "external-inbound-normalized-event.v1",
      projectionId: seeded.projection.id,
      actorProjectionRevision: seeded.projection.projectionRevision,
      externalActorId: seeded.projection.externalActorId,
      providerMessageId,
      providerThreadId: null,
      content: `managed runtime inbound ${providerMessageId}`,
      createdAt: NOW.toISOString(),
    };
    const plaintext = JSON.stringify(payload);
    const aad = {
      purpose: "external-inbound-normalized-event" as const,
      aadVersion: 1 as const,
      schemaVersion: 1 as const,
      provider: "slack" as const,
      environment: authority.environment,
      appRegistrationId: authority.appRegistrationId,
      installId: authority.installId,
      workspaceId: authority.workspaceId,
      providerAuthorityId: authority.providerAuthorityId,
      providerConversationId: authority.providerConversationId,
      providerEventId,
      bindingId: authority.bindingId,
      bindingEpoch: authority.bindingEpoch,
      connectionEpoch: authority.connectionEpoch,
      runtimeRevision: authority.runtimeRevision,
      raftChannelId: authority.raftChannelId,
      privacyClass: authority.privacyClass,
    };
    const sealed = await runtime.payloadSealer.sealNormalizedPayload({ plaintext, aad });
    return {
      sealed,
      enqueue: () => enqueueExternalInboundEvent({
        db: getDb(),
        authority,
        providerEventId,
        normalizedPayloadDigest: sha256(plaintext),
        encryptedPayload: sealed.encryptedPayload,
        envelopeKeyId: sealed.envelopeKeyId,
        payloadExpiresAt: new Date(NOW.getTime() + 5 * 60_000),
        receivedAt: NOW,
      }),
    };
  };

  const beforeStart = {
    messages: (await getDb().select().from(messages)).length,
    links: (await getDb().select().from(externalMessageLinks)).length,
  };
  const first = await admit("Ev-managed-start", "1786406400.000001");
  const firstEvent = await first.enqueue();
  await waitFor(async () => {
    const event = (await getDb().select().from(externalInboundEvents))
      .find((row) => row.id === firstEvent.event.id);
    return event?.status === "committed" || Boolean(event?.outcomeReason);
  }, "managed inbound worker outcome after runtime start");
  const committedEvent = (await getDb().select().from(externalInboundEvents))
    .find((row) => row.id === firstEvent.event.id);
  assert.equal(
    committedEvent?.status,
    "committed",
    `managed inbound worker outcome: ${committedEvent?.outcomeReason ?? "missing"}`,
  );
  assert.equal((await getDb().select().from(messages)).length, beforeStart.messages + 1);
  assert.equal((await getDb().select().from(externalMessageLinks)).length, beforeStart.links + 1);

  const afterStop = await admit("Ev-managed-stop", "1786406401.000001");
  await runtime.stop();
  const stoppedEvent = await afterStop.enqueue();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const [stoppedRow] = (await getDb().select().from(externalInboundEvents))
    .filter((row) => row.id === stoppedEvent.event.id);
  assert.equal(stoppedRow?.status, "queued", "runtime stop prevents later inbound consumption");
  assert.equal((await getDb().select().from(messages)).length, beforeStart.messages + 1);
  assert.equal((await getDb().select().from(externalMessageLinks)).length, beforeStart.links + 1);
});

test("managed server start owns ordinary Raft to Slack admission and delivery", async ({ onTestFinished }) => {
  const seeded = await seedManagedAudience();
  let workerNow = NOW;
  let firstReceipt: (() => void) | null = null;
  const started = new Promise<void>((resolve) => {
    firstReceipt = resolve;
  });
  const postedBodies: unknown[] = [];
  const authorityAlerts: ExternalDeliveryAuthorityAlert[] = [];
  const outboundErrors: unknown[] = [];
  const runtime = await createSlackBridgeServerRuntimeFromEnv(MANAGED_ENV, {
    db: getDb(),
    now: () => workerNow,
    lifecycleIntervalMs: 60_000,
    inboundWorkerIntervalMs: 60_000,
    outboundWorkerIntervalMs: 250,
    outboundWorkerLeaseOwner: "managed-runtime-outbound-test",
    onLifecycleReceipt() {
      firstReceipt?.();
      firstReceipt = null;
    },
    onOutboundAuthorityAlert(alert: ExternalDeliveryAuthorityAlert) {
      authorityAlerts.push(alert);
    },
    onOutboundError(error: unknown) {
      outboundErrors.push(error);
    },
    fetch: (async (url, init) => {
      const method = new URL(String(url)).pathname.split("/").at(-1);
      if (method === "auth.test") {
        return new Response(JSON.stringify({
          ok: true,
          team_id: "T_MANAGED_RUNTIME",
          user_id: "U_MANAGED_BOT",
          bot_id: "B_MANAGED_BOT",
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-oauth-scopes": SLACK_BRIDGE_REQUIRED_BOT_SCOPES.join(","),
          },
        });
      }
      if (method === "users.info") {
        const providerUserId = new URL(String(url)).searchParams.get("user") ?? "";
        return new Response(JSON.stringify({
          ok: true,
          user: {
            id: providerUserId,
            name: providerUserId.toLowerCase(),
            is_bot: providerUserId === "U_MANAGED_BOT",
            profile: { display_name: providerUserId },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "conversations.members") {
        return new Response(JSON.stringify({
          ok: true,
          members: ["U_MANAGED_OWNER", "U_MANAGED_BOT"],
          response_metadata: { next_cursor: "" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "chat.postMessage") {
        postedBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({
          ok: true,
          channel: "G_MANAGED_PRIVATE",
          ts: "1786601594.810619",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected Slack method ${method}`);
    }) as typeof fetch,
  } as any);
  assert.ok(runtime);
  onTestFinished(async () => runtime.stop());

  runtime.start();
  await started;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(
    outboundErrors,
    [],
    "an active legacy binding with no delivery partition is idle before its first message",
  );
  const [agent] = await getDb().insert(agents).values({
    serverId: seeded.server.id,
    name: "managed-runtime-agent",
    displayName: "Managed Runtime Agent",
    runtime: "codex",
  }).returning();
  await getDb().insert(channelAgents).values({ channelId: seeded.channel.id, agentId: agent.id });

  const message = await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: seeded.channel.id,
    senderType: "agent",
    senderId: agent.id,
    senderName: agent.displayName!,
    content: "managed runtime outbound",
  });
  assert.equal(
    (await getDb().select().from(externalOutboundDeliveries)).length,
    1,
    "managed start must install outbound admission before the source transaction",
  );
  const staleSince = new Date(NOW.getTime() - EXTERNAL_DELIVERY_AUTHORITY_OVERDUE_MS);
  await getDb().update(externalOutboundDeliveries).set({
    createdAt: staleSince,
    updatedAt: staleSince,
  });
  await getDb().update(externalBindingAudienceSnapshots).set({ status: "mismatch" });
  await waitFor(async () => {
    const [partition] = await getDb().select().from(externalDeliveryPartitions)
      .where(eq(externalDeliveryPartitions.bindingId, seeded.binding.id));
    return partition?.authorityBlockedReason === "runtime_authority_inactive_or_mismatched:frozen_audience_snapshot_missing_or_expired";
  }, "managed outbound pair authority block");
  const [waitingPartition] = await getDb().select().from(externalDeliveryPartitions)
    .where(eq(externalDeliveryPartitions.bindingId, seeded.binding.id));
  assert.equal(waitingPartition?.authorityBlockedAt?.toISOString(), NOW.toISOString(), "the queue clock starts at the first block, not at message creation");
  assert.equal((await getDb().select().from(externalOutboundDeliveries))[0]?.state, "queued");
  assert.deepEqual(authorityAlerts, [], "an old message is not overdue until the authority block ages");
  assert.equal(postedBodies.length, 0);
  workerNow = new Date(NOW.getTime() + EXTERNAL_DELIVERY_AUTHORITY_OVERDUE_MS);
  await waitFor(async () => authorityAlerts.length === 1, "managed outbound overdue authority alert");
  assert.equal(
    postedBodies.length,
    0,
    "a private audience mismatch after enqueue must fail closed before Slack I/O",
  );
  assert.notEqual(
    (await getDb().select().from(externalOutboundDeliveries))[0]?.state,
    "accepted",
  );
  assert.deepEqual(authorityAlerts[0], {
    schema: "external-delivery-authority-alert.v1",
    severity: "overdue",
    deliveryId: (await getDb().select().from(externalOutboundDeliveries))[0]!.id,
    bindingId: seeded.binding.id,
    bindingEpoch: seeded.binding.bindingEpoch,
    partitionPosition: 1,
    blockReason: "runtime_authority_inactive_or_mismatched:frozen_audience_snapshot_missing_or_expired",
    observedAt: workerNow.toISOString(),
    deliveryAgeMs: EXTERNAL_DELIVERY_AUTHORITY_OVERDUE_MS,
    requiredAction: "restore_authority_or_audited_skip",
  });

  await getDb().update(externalBindingAudienceSnapshots).set({ status: "matched" });
  workerNow = new Date(workerNow.getTime() + 2 * EXTERNAL_DELIVERY_AUTHORITY_BACKOFF_BASE_MS);
  await waitFor(async () => {
    const [delivery] = await getDb().select().from(externalOutboundDeliveries);
    return delivery?.state === "accepted";
  }, "managed outbound acceptance");

  const [delivery] = await getDb().select().from(externalOutboundDeliveries);
  assert.equal(delivery?.sourceMessageId, message.id);
  assert.equal(delivery?.state, "accepted");
  const [recoveredPartition] = await getDb().select().from(externalDeliveryPartitions)
    .where(eq(externalDeliveryPartitions.bindingId, seeded.binding.id));
  assert.equal(recoveredPartition?.authorityBlockedAt, null);
  assert.equal(recoveredPartition?.authorityBlockedReason, null);
  assert.equal(postedBodies.length, 1);
  assert.equal((postedBodies[0] as { channel?: string }).channel, "G_MANAGED_PRIVATE");
  assert.match(
    String((postedBodies[0] as { text?: string }).text),
    /managed runtime outbound/,
  );

  await runtime.stop();
  await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: seeded.channel.id,
    senderType: "user",
    senderId: seeded.owner.id,
    senderName: seeded.owner.name,
    content: "managed runtime after stop",
  });
  assert.equal(
    (await getDb().select().from(externalOutboundDeliveries)).length,
    1,
    "runtime stop must uninstall ordinary outbound admission",
  );
  assert.equal(postedBodies.length, 1);
});

test("managed outbound renders a Raft-principal mention as its frozen Slack token", async ({ onTestFinished }) => {
  const seeded = await seedManagedAudience();
  let firstReceipt: (() => void) | null = null;
  const started = new Promise<void>((resolve) => {
    firstReceipt = resolve;
  });
  const postedBodies: unknown[] = [];
  let workerNow = NOW;
  const runtime = await createSlackBridgeServerRuntimeFromEnv(MANAGED_ENV, {
    db: getDb(),
    now: () => workerNow,
    lifecycleIntervalMs: 60_000,
    inboundWorkerIntervalMs: 60_000,
    outboundWorkerIntervalMs: 250,
    outboundWorkerLeaseOwner: "managed-runtime-outbound-test",
    onLifecycleReceipt() {
      firstReceipt?.();
      firstReceipt = null;
    },
    fetch: (async (url, init) => {
      const method = new URL(String(url)).pathname.split("/").at(-1);
      if (method === "auth.test") {
        return new Response(JSON.stringify({
          ok: true,
          team_id: "T_MANAGED_RUNTIME",
          user_id: "U_MANAGED_BOT",
          bot_id: "B_MANAGED_BOT",
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-oauth-scopes": SLACK_BRIDGE_REQUIRED_BOT_SCOPES.join(","),
          },
        });
      }
      if (method === "users.info") {
        const providerUserId = new URL(String(url)).searchParams.get("user") ?? "";
        return new Response(JSON.stringify({
          ok: true,
          user: {
            id: providerUserId,
            name: providerUserId.toLowerCase(),
            is_bot: providerUserId === "U_MANAGED_BOT",
            profile: { display_name: providerUserId },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "conversations.members") {
        return new Response(JSON.stringify({
          ok: true,
          members: ["U_MANAGED_OWNER", "U_MANAGED_BOT"],
          response_metadata: { next_cursor: "" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "usergroups.list") {
        return new Response(JSON.stringify({ ok: true, usergroups: [] }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      if (method === "usergroups.create" || method === "usergroups.update") {
        const request = JSON.parse(String(init?.body)) as Record<string, string>;
        return new Response(JSON.stringify({
          ok: true,
          usergroup: { id: "S_MANAGED_OWNER", ...request, date_delete: 0 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "chat.postMessage") {
        postedBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({
          ok: true,
          channel: "G_MANAGED_PRIVATE",
          ts: "1786601594.810619",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected Slack method ${method}`);
    }) as typeof fetch,
  } as any);
  assert.ok(runtime);
  onTestFinished(async () => runtime.stop());
  runtime.start();
  await started;

  const [agent] = await getDb().insert(agents).values({
    serverId: seeded.server.id,
    name: "managed-mention-agent",
    runtime: "codex",
  }).returning();
  await getDb().insert(channelAgents).values({ channelId: seeded.channel.id, agentId: agent.id });

  // Reviewer probe: this workspace human was first provisioned from another server.
  const firstServer = await createServer("First workspace server", `first-${randomUUID()}`, seeded.owner.id);
  await getDb().update(slackUsergroupIdentities).set({ serverId: firstServer.id })
    .where(eq(slackUsergroupIdentities.principalId, seeded.owner.id));

  // Humans and agents now both render through slack_usergroup_identities: the
  // owner gets a managed usergroup whose <!subteam^…> token freezes at enqueue.
  await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: seeded.channel.id,
    senderType: "agent",
    senderId: agent.id,
    senderName: agent.name,
    content: `ack @${seeded.owner.name}`,
  });

  const deliveries = await getDb().select().from(externalOutboundDeliveries);
  assert.equal(deliveries.length, 1, "the managed runtime must enqueue the outbound delivery");
  const mentionRows = await getDb().select().from(messageMentions);
  assert.equal(mentionRows.length, 1, "the @handle must resolve to a Raft mention row first");
  assert.deepEqual(
    mentionRows.map((row) => ({
      targetType: row.targetType,
      targetId: row.targetId,
      handle: row.handleAtSendTime,
    })),
    [{ targetType: "user", targetId: seeded.owner.id, handle: seeded.owner.name }],
  );
  const [delivery] = deliveries;
  const snapshot = delivery?.renderSnapshot as {
    raftMentionSubstitutions?: Array<{ kind: string; handle: string; token: string }>;
  } | undefined;
  assert.deepEqual(
    Object.keys(snapshot ?? {}).sort(),
    [
      "attachments", "authorName", "authorPresentation", "bindingAuthority",
      "canonicalConversationId", "canonicalRootMessageId", "enqueueRuntimeRevision",
      "externalMentions", "level", "raftMentionSubstitutions", "sanitizedText",
      "schema", "senderId", "senderType", "sourceMessageId", "sourceMessageSeq",
      "sourcePermalink",
    ],
    "stored snapshot carries the substitution field",
  );
  assert.deepEqual(snapshot?.raftMentionSubstitutions, [{
    kind: "usergroup",
    handle: seeded.owner.name,
    token: "<!subteam^S_MANAGED_OWNER>",
    installId: seeded.install.id,
    bindingId: seeded.binding.id,
    bindingEpoch: seeded.binding.bindingEpoch,
  }], "enqueue must freeze the Raft-principal mention to its provider token");

  await waitFor(async () => {
    const [row] = await getDb().select().from(externalOutboundDeliveries);
    return row?.state === "accepted";
  }, "managed outbound acceptance with mention");
  assert.equal(postedBodies.length, 1);
  const postedText = String((postedBodies[0] as { text?: string }).text);
  assert.match(postedText, /<!subteam\^S_MANAGED_OWNER>/);
  assert.ok(
    !new RegExp(`@${seeded.owner.name}\\b`, "u").test(postedText),
    "the raw @handle must not survive substitution",
  );
  await getDb().insert(slackUsergroupIdentities).values({
    installId: seeded.install.id, serverId: seeded.server.id, principalKind: "user", principalId: seeded.owner.id,
    recoveryRef: randomBytes(24).toString("hex") as SlackUsergroupRecoveryRef,
    providerUsergroupId: "S_RETIRED_LOCAL_ALIAS", humanCanonical: false,
  });
  await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: seeded.channel.id, senderType: "agent", senderId: agent.id, senderName: agent.name,
    content: `again @${seeded.owner.name}`,
  });
  const [latest] = await getDb().select().from(externalOutboundDeliveries).orderBy(desc(externalOutboundDeliveries.partitionPosition)).limit(1);
  const latestSnapshot = latest.renderSnapshot as { raftMentionSubstitutions?: Array<{ token: string }> };
  assert.deepEqual(latestSnapshot.raftMentionSubstitutions?.map((mention) => mention.token), ["<!subteam^S_MANAGED_OWNER>"],
    "new outbound messages use the workspace canonical group, never a retired local alias");
});

test("zero-policy public thread reply follows the exact accepted root link", async ({ onTestFinished }) => {
  const seeded = await seedManagedAudience("public");
  let firstReceipt: (() => void) | null = null;
  const started = new Promise<void>((resolve) => {
    firstReceipt = resolve;
  });
  const postedBodies: unknown[] = [];
  const runtime = await createSlackBridgeServerRuntimeFromEnv(MANAGED_ENV, {
    db: getDb(),
    now: () => NOW,
    lifecycleIntervalMs: 60_000,
    inboundWorkerIntervalMs: 60_000,
    outboundWorkerIntervalMs: 10,
    outboundWorkerLeaseOwner: "managed-runtime-public-thread-test",
    onLifecycleReceipt() {
      firstReceipt?.();
      firstReceipt = null;
    },
    fetch: (async (url, init) => {
      const method = new URL(String(url)).pathname.split("/").at(-1);
      if (method === "auth.test") {
        return new Response(JSON.stringify({
          ok: true,
          team_id: "T_MANAGED_RUNTIME",
          user_id: "U_MANAGED_BOT",
          bot_id: "B_MANAGED_BOT",
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-oauth-scopes": SLACK_BRIDGE_REQUIRED_BOT_SCOPES.join(","),
          },
        });
      }
      if (method === "users.info") {
        const providerUserId = new URL(String(url)).searchParams.get("user") ?? "";
        return new Response(JSON.stringify({
          ok: true,
          user: {
            id: providerUserId,
            name: providerUserId.toLowerCase(),
            is_bot: providerUserId === "U_MANAGED_BOT",
            profile: { display_name: providerUserId },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "conversations.members") {
        return new Response(JSON.stringify({
          ok: true,
          members: ["U_MANAGED_OWNER", "U_MANAGED_BOT"],
          response_metadata: { next_cursor: "" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "conversations.info") {
        return new Response(JSON.stringify({
          ok: true,
          channel: { id: "C_MANAGED_PUBLIC", is_channel: true, is_private: false },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "chat.postMessage") {
        postedBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({
          ok: true,
          channel: "C_MANAGED_PUBLIC",
          ts: "1786601594.810621",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected Slack method ${method}`);
    }) as typeof fetch,
  });
  assert.ok(runtime);
  onTestFinished(async () => runtime.stop());

  runtime.start();
  await started;
  await getDb().delete(externalBindingAudienceSnapshots)
    .where(eq(externalBindingAudienceSnapshots.bindingId, seeded.binding.id));
  await getDb().insert(externalBindingAudienceSnapshots).values({
    bindingId: seeded.binding.id,
    bindingEpoch: seeded.binding.bindingEpoch,
    audienceRevision: 1,
    externalMemberCount: 1,
    externalAudienceDigest: "public-thread-audience",
    raftMemberCount: 1,
    raftAudienceDigest: "public-thread-audience",
    status: "matched",
    observedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60_000),
  });
  const [agent] = await getDb().insert(agents).values({
    serverId: seeded.server.id,
    name: "managed-public-thread-agent",
    displayName: "Managed Public Thread Agent",
    runtime: "codex",
  }).returning();
  const [root] = await getDb().insert(messages).values({
    channelId: seeded.channel.id,
    senderType: "user",
    senderId: seeded.owner.id,
    content: "managed public root",
  }).returning();
  const [thread] = await getDb().insert(channels).values({
    serverId: seeded.server.id,
    name: `managed-public-thread-${randomUUID().slice(0, 8)}`,
    type: "thread",
    parentMessageId: root.id,
  }).returning();
  await getDb().update(messages).set({ threadId: thread.id }).where(eq(messages.id, root.id));
  await getDb().insert(channelAgents).values({ channelId: seeded.channel.id, agentId: agent.id });
  assert.equal(
    (await getDb().select().from(channelAgents).where(eq(channelAgents.channelId, thread.id))).length,
    0,
    "thread authority inherits the parent channel and has no legacy thread membership row",
  );
  await getDb().insert(externalMessageLinks).values({
    provider: "slack",
    installId: seeded.install.id,
    providerAuthorityId: seeded.install.providerAuthorityId,
    providerConversationId: seeded.binding.providerConversationId,
    providerMessageId: "1786601594.810600",
    bindingId: seeded.binding.id,
    bindingEpoch: seeded.binding.bindingEpoch,
    connectionEpoch: seeded.binding.connectionEpoch,
    raftMessageId: root.id,
    firstDirection: "raft_outbound",
    payloadFingerprint: "a".repeat(64),
    outcomeState: "accepted",
    authorityState: "active",
  });
  const reply = await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: thread.id,
    senderType: "agent",
    senderId: agent.id,
    senderName: agent.displayName!,
    content: "managed public thread reply",
  });
  const [queued] = await getDb().select().from(externalOutboundDeliveries);
  assert.equal(queued?.sourceMessageId, reply.id);
  assert.equal(queued?.renderSnapshot.level, "thread");
  assert.equal(queued?.renderSnapshot.canonicalRootMessageId, root.id);
  await waitFor(async () => {
    const [delivery] = await getDb().select().from(externalOutboundDeliveries);
    return delivery?.state === "accepted";
  }, "managed public thread acceptance");
  assert.equal(postedBodies.length, 1);
  assert.equal((postedBodies[0] as { channel?: string }).channel, "C_MANAGED_PUBLIC");
  assert.equal((postedBodies[0] as { thread_ts?: string }).thread_ts, "1786601594.810600");
  assert.match(String((postedBodies[0] as { text?: string }).text), /managed public thread reply/);
});

test("managed active binding drops OFF-window Raft messages without replay after master recovery", async ({ onTestFinished }) => {
  const seeded = await seedManagedAudience();
  let firstReceipt: (() => void) | null = null;
  const started = new Promise<void>((resolve) => {
    firstReceipt = resolve;
  });
  const postedBodies: unknown[] = [];
  const runtime = await createSlackBridgeServerRuntimeFromEnv(MANAGED_ENV, {
    db: getDb(),
    now: () => NOW,
    lifecycleIntervalMs: 60_000,
    inboundWorkerIntervalMs: 60_000,
    outboundWorkerIntervalMs: 10,
    outboundWorkerLeaseOwner: "managed-runtime-master-gate-test",
    onLifecycleReceipt() {
      firstReceipt?.();
      firstReceipt = null;
    },
    fetch: (async (url, init) => {
      const method = new URL(String(url)).pathname.split("/").at(-1);
      if (method === "auth.test") {
        return new Response(JSON.stringify({
          ok: true,
          team_id: "T_MANAGED_RUNTIME",
          user_id: "U_MANAGED_BOT",
          bot_id: "B_MANAGED_BOT",
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-oauth-scopes": SLACK_BRIDGE_REQUIRED_BOT_SCOPES.join(","),
          },
        });
      }
      if (method === "users.info") {
        const providerUserId = new URL(String(url)).searchParams.get("user") ?? "";
        return new Response(JSON.stringify({
          ok: true,
          user: {
            id: providerUserId,
            name: providerUserId.toLowerCase(),
            is_bot: providerUserId === "U_MANAGED_BOT",
            profile: { display_name: providerUserId },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "conversations.members") {
        return new Response(JSON.stringify({
          ok: true,
          members: ["U_MANAGED_OWNER", "U_MANAGED_BOT"],
          response_metadata: { next_cursor: "" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (method === "chat.postMessage") {
        postedBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({
          ok: true,
          channel: "G_MANAGED_PRIVATE",
          ts: "1786601594.810620",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected Slack method ${method}`);
    }) as typeof fetch,
  });
  assert.ok(runtime);
  onTestFinished(async () => runtime.stop());

  runtime.start();
  await started;
  await updateFeatureFlagRule(
    SLACK_BRIDGE_FEATURE_FLAG_KEYS.master,
    seeded.masterRule.id,
    { decision: "deny" },
  );
  const offMessage = await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: seeded.channel.id,
    senderType: "user",
    senderId: seeded.owner.id,
    senderName: seeded.owner.name,
    content: "managed runtime master OFF",
  });
  assert.equal((await getDb().select().from(externalOutboundDeliveries)).length, 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(postedBodies.length, 0, "master OFF must stop Slack provider I/O");

  await updateFeatureFlagRule(
    SLACK_BRIDGE_FEATURE_FLAG_KEYS.master,
    seeded.masterRule.id,
    { decision: "allow" },
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    (await getDb().select().from(externalOutboundDeliveries)).length,
    0,
    "master recovery must not enqueue the OFF-window message",
  );
  assert.equal(postedBodies.length, 0, "master recovery must not replay provider I/O");

  const onMessage = await broadcastAndDeliver(createIo(), noopOrchestrator, {
    channelId: seeded.channel.id,
    senderType: "user",
    senderId: seeded.owner.id,
    senderName: seeded.owner.name,
    content: "managed runtime master recovered",
  });
  await waitFor(async () => {
    const deliveries = await getDb().select().from(externalOutboundDeliveries);
    return deliveries.length === 1 && deliveries[0]?.state === "accepted";
  }, "post-recovery managed outbound acceptance");

  const [delivery] = await getDb().select().from(externalOutboundDeliveries);
  assert.equal(delivery?.sourceMessageId, onMessage.id);
  assert.notEqual(delivery?.sourceMessageId, offMessage.id);
  assert.equal(postedBodies.length, 1);
});

async function maintenanceFixture(loseAfterMethod?: string) {
  const seeded = await seedManagedAudience();
  const calls: string[] = [];
  const errors: unknown[] = [];
  let held = true;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const runtime = await createSlackBridgeServerRuntimeFromEnv(MANAGED_ENV, {
    db: getDb(), now: () => NOW,
    lifecycleClock: { scheduleEvery: () => "fixture", clear() {} },
    claimLifecycleRun: async () => ({ held: async () => held, end: finish }),
    onLifecycleError(error) { errors.push(error); },
    fetch: (async (url, init) => {
      const target = new URL(String(url));
      const method = target.pathname.split("/").at(-1)!;
      calls.push(method);
      if (method === loseAfterMethod) held = false;
      let body: Record<string, unknown>;
      switch (method) {
        case "auth.test":
          body = { ok: true, app_id: "A_MANAGED_RUNTIME", team_id: "T_MANAGED_RUNTIME",
            user_id: "U_MANAGED_BOT", bot_id: "B_MANAGED_BOT" };
          break;
        case "usergroups.list": body = { ok: true, usergroups: [] }; break;
        case "usergroups.create":
        case "usergroups.update":
          body = { ok: true, usergroup: { ...JSON.parse(String(init?.body)), id: "S_COMPACT_OWNER", date_delete: 0 } };
          break;
        case "conversations.info":
          body = { ok: true, channel: { id: "G_MANAGED_PRIVATE", is_private: true,
            is_archived: false, is_member: true } };
          break;
        case "conversations.members":
          body = { ok: true, members: ["U_MANAGED_OWNER", "U_MANAGED_BOT",
            ...(loseAfterMethod === "users.info" ? ["U_SECOND_MEMBER"] : [])],
            response_metadata: { next_cursor: "" } };
          break;
        case "users.info": {
          const id = target.searchParams.get("user");
          body = { ok: true, user: { id, name: id, is_bot: false, profile: { display_name: id } } };
          break;
        }
        default: throw new Error(`unexpected maintenance provider method ${method}`);
      }
      return new Response(JSON.stringify(body), { status: 200,
        headers: { "content-type": "application/json", "x-oauth-scopes": SLACK_BRIDGE_REQUIRED_BOT_SCOPES.join(",") } });
    }) as typeof fetch,
  });
  assert.ok(runtime);
  return { seeded, runtime, calls, errors, finished };
}

for (const method of ["auth.test", "usergroups.list", "conversations.info", "conversations.members", "users.info"]) {
  test(`lost maintenance claim after ${method} stops subsequent provider work`, async () => {
    const fixture = await maintenanceFixture(method);
    fixture.runtime.start();
    try {
      await fixture.finished;
      assert.deepEqual(fixture.errors, []);
      assert.equal(fixture.calls.at(-1), method, "no later provider operation may begin after ownership loss");
      assert.equal(fixture.calls.filter((value) => value === method).length, 1);
      assert.equal((await getDb().select().from(externalBindingAudienceSnapshots)).length, 1,
        "cancellation must not append an unavailable audience observation");
    } finally { await fixture.runtime.stop(); }
  });
}

test("fresh member reuse rejects expired, revoked and superseded credentials", async () => {
  const fixture = await maintenanceFixture();
  fixture.runtime.start();
  try {
    await fixture.finished;
    assert.deepEqual(fixture.errors, []);
    const provider = {
      readInstallGrant: async () => ({ kind: "unverified" as const }),
      readWorkspace: async () => ({ oauth: "unverified" as const, directory: { kind: "unverified" as const } }),
      readConversationAudience: async () => ({ kind: "unverified" as const }),
    };
    const refresh = () => refreshSlackConversationAuthority({ db: getDb(), provider,
      bindingId: fixture.seeded.binding.id, now: NOW, reuseFresh: true });
    assert.equal((await refresh()).audienceStatus, "matched", "the control has a coherent fresh member snapshot");
    for (const values of [
      { expiresAt: NOW },
      { expiresAt: null, state: "revoked" as const, revokedAt: NOW },
      { state: "active" as const, revokedAt: null, credentialRevision: 2 },
    ]) {
      await getDb().update(externalAppCredentials).set(values);
      const result = await refresh();
      assert.equal(result.audienceStatus, "unavailable");
      assert.equal(result.reason, "credential_unavailable");
    }
  } finally { await fixture.runtime.stop(); }
});

test("identity observation defaults off and is scoped to explicit channel IDs", async () => {
  const disabled = await createSlackBridgeServerRuntimeFromEnv(MANAGED_ENV);
  assert.ok(disabled);
  assert.equal(disabled.testIdentityObserver, undefined);
  disabled.stop();
  const invalid = await createSlackBridgeServerRuntimeFromEnv({ ...MANAGED_ENV,
    SLACK_BRIDGE_OBSERVE_CHANNEL_IDS: "CTEST,invalid" });
  assert.ok(invalid);
  assert.equal(invalid.testIdentityObserver, undefined);
  invalid.stop();
  const enabled = await createSlackBridgeServerRuntimeFromEnv({ ...MANAGED_ENV,
    SLACK_BRIDGE_OBSERVE_CHANNEL_IDS: "CTEST,GTEST,CTEST" });
  assert.deepEqual(enabled?.testIdentityObserver?.providerConversationIds, ["CTEST", "GTEST"]);
  enabled?.stop();
});

test("invalid observation scope logs a fixed warning without echoing configuration", async () => {
  const messages: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { messages.push(args); };
  try {
    const runtime = await createSlackBridgeServerRuntimeFromEnv({ ...MANAGED_ENV,
      SLACK_BRIDGE_OBSERVE_CHANNEL_IDS: "private-invalid-value" });
    assert.ok(runtime);
    assert.equal(runtime.testIdentityObserver, undefined);
    assert.deepEqual(messages, [["Slack identity observation configuration is invalid; observation disabled"]]);
    runtime.stop();
  } finally {
    console.warn = originalWarn;
  }
});


test("managed deployment environment drives the attachment DB control after start and can pause it", async () => {
  let providerCalls = 0;
  const env = { ...MANAGED_ENV, SLACK_BRIDGE_ATTACHMENT_FALLBACK_ENABLED: "true",
    SLACK_BRIDGE_ATTACHMENT_FALLBACK_CONFIG_GENERATION: "1", SLACK_BRIDGE_ATTACHMENT_FALLBACK_VERIFIED_RELEASE: "a".repeat(40), SLACK_BRIDGE_ATTACHMENT_FALLBACK_VERIFIED_BY: "@test-verifier" };
  const create = (input: NodeJS.ProcessEnv) => createSlackBridgeServerRuntimeFromEnv(input, { now: () => NOW,
    fetch: (async () => { providerCalls++; throw new Error("no Slack work exists"); }) as typeof fetch });
  const waitForGeneration = async (generation: number) => {
    for (let turn = 0; turn < 100; turn++) {
      const [state] = await getDb().select().from(slackAttachmentPlanRollout);
      if (state?.configGeneration === generation) return state;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error("deployment configuration did not reach the real control row");
  };
  const runtime = await create(env);
  assert.ok(runtime);
  assert.equal((await getDb().select().from(slackAttachmentPlanRollout)).length, 0, "composition does not mutate before start");
  runtime.start();
  try {
    const state = await waitForGeneration(1);
    assert.equal(state.enabled, true);
    assert.equal(state.verifiedBy, "@test-verifier");
  }
  finally { await runtime.stop(); }
  const paused = await create({ ...env, SLACK_BRIDGE_ATTACHMENT_FALLBACK_ENABLED: "false",
    SLACK_BRIDGE_ATTACHMENT_FALLBACK_CONFIG_GENERATION: "2" });
  assert.ok(paused); paused.start();
  try {
    const state = await waitForGeneration(2);
    assert.equal(state.enabled, false); assert.equal(state.minimumWriterVersion, 1);
  } finally { await paused.stop(); }
  assert.equal(providerCalls, 0, "the deployment change itself performs no provider I/O");
});

test("managed runtime drains a verified Slack receipt after the durable switch is enabled", async ({ onTestFinished }) => {
  const { enableTestSlackIngress } = await import("../test/integration/slackIngressRollout");
  const { enqueueSlackVerifiedIngress } = await import("./slackVerifiedIngressInbox");
  const { createSlackVerifiedIngressEnvCrypto } = await import("./slackVerifiedIngressEnvCrypto");
  const { SLACK_BRIDGE_PAYLOAD_KEY_ID, slackBridgeKeyFromEnv } = await import("./slackBridgeEnvSecrets");
  const seeded = await seedManagedAudience();
  let lifecycleReady!: () => void;
  const started = new Promise<void>(resolve => { lifecycleReady = resolve; });
  const runtime = await createSlackBridgeServerRuntimeFromEnv(MANAGED_ENV, {
    db: getDb(), now: () => NOW, lifecycleIntervalMs: 60_000,
    inboundWorkerIntervalMs: 20, verifiedIngressWorkerIntervalMs: 20,
    onLifecycleReceipt: () => lifecycleReady(),
    fetch: (async (url) => {
      if (String(url) === "https://slack.com/api/auth.test") return new Response(JSON.stringify({
        ok: true, app_id: "A_MANAGED_RUNTIME", team_id: "T_MANAGED_RUNTIME", user_id: "U_MANAGED_BOT", bot_id: "B_MANAGED_BOT",
      }), { status: 200, headers: { "content-type": "application/json", "x-oauth-scopes": SLACK_BRIDGE_REQUIRED_BOT_SCOPES.join(",") } });
      return new Response(JSON.stringify({ ok: true, members: ["U_MANAGED_OWNER", "U_MANAGED_BOT"],
        response_metadata: { next_cursor: "" } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  assert.ok(runtime);
  onTestFinished(async () => runtime.stop());
  runtime.start();
  await started;
  const authority = await resolveExternalBindingAuthority({ serverId: seeded.server.id, bindingId: seeded.binding.id,
    expectedConnectionEpoch: seeded.install.connectionEpoch, expectedBindingEpoch: seeded.binding.bindingEpoch, now: NOW }, getDb());
  assert.equal(authority.active, true);
  await enableTestSlackIngress();
  const aad = { purpose: "slack-verified-ingress" as const, version: 1 as const,
    registrationId: seeded.registration.id, environment: "production" as const,
    providerAppId: seeded.registration.providerAppId, providerAuthorityId: seeded.install.providerAuthorityId,
    providerConversationId: seeded.binding.providerConversationId, providerEventId: "Ev_MANAGED_VERIFIED" };
  const bytes = Buffer.from(JSON.stringify({ type: "event_callback", api_app_id: aad.providerAppId,
    team_id: aad.providerAuthorityId, event_id: aad.providerEventId, event: { type: "message", channel: aad.providerConversationId,
      user: seeded.projection.externalActorId, ts: `${Math.floor(NOW.getTime() / 1000)}.001234`, text: "runtime verified message" } }));
  const crypto = createSlackVerifiedIngressEnvCrypto({ key: slackBridgeKeyFromEnv(MANAGED_ENV.SLACK_BRIDGE_PAYLOAD_ENCRYPTION_KEY,
    "SLACK_BRIDGE_PAYLOAD_ENCRYPTION_KEY"), keyId: SLACK_BRIDGE_PAYLOAD_KEY_ID,
    registrationId: aad.registrationId, environment: aad.environment, providerAppId: aad.providerAppId });
  const sealed = await crypto.seal({ bytes, aad });
  await enqueueSlackVerifiedIngress({ db: getDb(), aad, rawDigest: createHash("sha256").update(bytes).digest("hex"),
    encryptedPayload: sealed.encryptedPayload, envelopeKeyId: sealed.envelopeKeyId, now: NOW,
    validateEndpoint: async () => true });
  await waitFor(async () => (await getDb().select().from(messages).where(eq(messages.content, "runtime verified message"))).length === 1,
    "verified raw receipt to canonical message", 10_000);
  await runtime.stop();
});

test("managed startup applies reviewed ingress deployment config before starting workers", async () => {
  const { readSlackIngressRollout } = await import("./slackVerifiedIngressRollout");
  const { slackVerifiedIngressRollout } = await import("../db/schema");
  const env = { ...MANAGED_ENV, SLACK_BRIDGE_VERIFIED_INGRESS_ENABLED: "false",
    SLACK_BRIDGE_VERIFIED_INGRESS_CONFIG_GENERATION: "1" };
  const runtime = await createSlackBridgeServerRuntimeFromEnv(env, { db: getDb(), now: () => NOW });
  assert.ok(runtime);
  const [policy] = await getDb().select().from(slackVerifiedIngressRollout);
  assert.equal(policy.configGeneration, 1);
  assert.equal((await readSlackIngressRollout(getDb())).mode, "legacy");
  await runtime.stop();
  const errors: unknown[] = [];
  await assert.rejects(createSlackBridgeServerRuntimeFromEnv({ ...env, SLACK_BRIDGE_VERIFIED_INGRESS_ENABLED: "true",
    SLACK_BRIDGE_VERIFIED_INGRESS_RELEASE_RECORD: "00000000-0000-4000-8000-000000000022" },
  { db: getDb(), now: () => NOW, onInboundError: error => errors.push(error) }), /could not be applied/);
  assert.equal(errors.length, 1);
});

test("managed runtime wires the payload rotation keyring through the actual normalized worker", async () => {
  const baseEnv = { ...MANAGED_ENV, SLACK_BRIDGE_ENVIRONMENT: "test", APP_URL: "http://127.0.0.1:5173" };
  const old = await createSlackBridgeServerRuntimeFromEnv(baseEnv); assert.ok(old);
  const aad = { purpose: "external-inbound-normalized-event" as const, aadVersion: 1 as const, schemaVersion: 1 as const,
    provider: "slack" as const, environment: "test" as const, appRegistrationId: MANAGED_ENV.SLACK_BRIDGE_REGISTRATION_ID!,
    installId: "install", workspaceId: "T1", providerAuthorityId: "T1", providerConversationId: "C1",
    providerEventId: "Ev1", bindingId: "binding", bindingEpoch: 1, connectionEpoch: 1, runtimeRevision: "r1",
    raftChannelId: "channel", privacyClass: "public" as const };
  const sealed = await old.payloadSealer.sealNormalizedPayload({ plaintext: "before rotation", aad });
  await old.stop();
  const rotated = await createSlackBridgeServerRuntimeFromEnv({ ...baseEnv, SLACK_BRIDGE_PAYLOAD_ACTIVE_KEY_ID: "env:next",
    SLACK_BRIDGE_PAYLOAD_DECRYPTION_KEYS: JSON.stringify({ "env:next": Buffer.alloc(32, 44).toString("base64") }) });
  assert.ok(rotated);
  const plaintext = await rotated.inboundWorkerDependencies.decryptNormalizedPayload({ eventId: "event-1",
    ciphertext: sealed.encryptedPayload, envelopeKeyId: sealed.envelopeKeyId, aad });
  assert.equal(plaintext, "before rotation");
  const next = await rotated.payloadSealer.sealNormalizedPayload({ plaintext: "after rotation", aad });
  assert.equal(next.envelopeKeyId, "env:next");
  assert.equal(await rotated.inboundWorkerDependencies.decryptNormalizedPayload({ eventId: "event-2",
    ciphertext: next.encryptedPayload, envelopeKeyId: next.envelopeKeyId, aad }), "after rotation");
  await rotated.stop();
});
