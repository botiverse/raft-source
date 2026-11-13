import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../db/index";
import { migratePglite } from "../db/pgliteMigrations";
import * as schema from "../db/schema";
import {
  agents,
  channels,
  externalAppRegistrations,
  oauthAccessTokens,
  notificationDeliveries,
  notificationEvents,
  notificationRecipients,
  oauthAppPermissionRevisions,
  oauthClientInstalls,
  oauthClients,
  servers,
  users,
} from "../db/schema";
import {
  AppNotificationDeliveryError,
  WebhookPostError,
  appWebhookDeliveryErrorCode,
  appWebhookDeliveryOutcomeForStatus,
  createAppWebhookPinnedLookup,
  drainAppNotificationDeliveries,
  emitAppFacingMemberEvents,
  emitAppFacingNotificationEvent,
  emitAppInstallationNotificationEvent,
} from "./appNotificationDeliveryService";
import { deriveAppBotHandle } from "./appBotIdentityService";
import { __setAppMemberRefKeyForTests, deriveAppMemberRef } from "./appOutboundProjectionService";
import {
  __resetOAuthServiceDbForTests,
  __setOAuthServiceDbForTests,
  uninstallMarketplaceOAuthClient,
} from "./oauthService";
import {
  __setAppWebhookEncryptionKeyForTests,
  AppWebhookConfigError,
  configureAppWebhook,
  rotateAppWebhookSecret,
} from "./appWebhookConfigService";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SERVER_ID = "22222222-2222-4222-8222-222222222222";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const REVISION_ID = "44444444-4444-4444-8444-444444444444";
const INSTALLATION_ID = "55555555-5555-4555-8555-555555555555";

async function createTestDb() {
  const client = new PGlite();
  await migratePglite(client);
  const db = drizzle(client, { schema }) as unknown as Database;
  await db.insert(users).values({
    id: USER_ID,
    email: "outbound-test@example.com",
    name: "outbound-test",
    passwordHash: "test",
  });
  await db.insert(servers).values({
    id: SERVER_ID,
    name: "Outbound Test",
    slug: "outbound-test",
    ownerId: USER_ID,
  });
  await db.insert(oauthClients).values({
    id: CLIENT_ID,
    serverId: SERVER_ID,
    clientId: "outbound-test-app",
    clientSecretHash: "test",
    appType: "third_party_global",
    name: "Outbound Test App",
    publishStatus: "published",
    createdByUserId: USER_ID,
    outboundRequestRevision: 1,
    outboundCurrentGroups: ["server", "channel"],
    outboundCurrentEvents: ["server.config_updated", "server.public_channel_created"],
  });
  await db.insert(oauthAppPermissionRevisions).values({
    id: REVISION_ID,
    clientId: CLIENT_ID,
    revision: 1,
    requestedGroups: ["server", "channel"],
    requestedEvents: ["server.config_updated", "server.public_channel_created"],
    state: "active",
    createdByType: "human",
    createdById: USER_ID,
  });
  await db.update(oauthClients).set({ outboundCurrentRevisionId: REVISION_ID })
    .where(eq(oauthClients.id, CLIENT_ID));
  await db.insert(oauthClientInstalls).values({
    id: INSTALLATION_ID,
    serverId: SERVER_ID,
    clientId: CLIENT_ID,
    installedByUserId: USER_ID,
    approvedRequestRevisionId: REVISION_ID,
    approvedGroups: ["server", "channel"],
    subscribedEvents: ["server.config_updated", "server.public_channel_created"],
    grantRevision: 1,
    subscriptionRevision: 1,
  });
  return { client, db };
}

test("webhook status classification retries only bounded transient failures", () => {
  assert.equal(appWebhookDeliveryOutcomeForStatus(204, 1), "delivered");
  assert.equal(appWebhookDeliveryOutcomeForStatus(400, 1), "dead_lettered");
  assert.equal(appWebhookDeliveryOutcomeForStatus(429, 1), "retry");
  assert.equal(appWebhookDeliveryOutcomeForStatus(500, 5), "retry");
  assert.equal(appWebhookDeliveryOutcomeForStatus(500, 6), "dead_lettered");
});

test("webhook delivery errors persist only closed, non-sensitive codes", () => {
  assert.equal(appWebhookDeliveryErrorCode(Object.assign(new Error("getaddrinfo failed for secret.internal"), { code: "ENOTFOUND" })), "dns_error");
  assert.equal(appWebhookDeliveryErrorCode(Object.assign(new Error("private details"), { code: "CERT_HAS_EXPIRED" })), "tls_error");
  assert.equal(appWebhookDeliveryErrorCode(new Error("Webhook request timed out")), "timeout");
  assert.equal(appWebhookDeliveryErrorCode(new AppWebhookConfigError("secret material")), "configuration_error");
  assert.equal(appWebhookDeliveryErrorCode(new Error("token=must-not-survive")), "network_error");
  // The timeout phase goes to traces; the persisted code stays `timeout` (agents read it as lastError).
  const timedOut = new Error("Webhook request timed out");
  assert.equal(appWebhookDeliveryErrorCode(new WebhookPostError(timedOut, { dnsMs: 3, socketReused: false }, "connect")), "timeout");
  assert.equal(appWebhookDeliveryErrorCode(new WebhookPostError(timedOut, { dnsMs: 3, connectMs: 40, tlsMs: 90, socketReused: false }, "response")), "timeout");
  assert.equal(appWebhookDeliveryErrorCode(new WebhookPostError(Object.assign(new Error("reset"), { code: "ECONNRESET" }), { dnsMs: 3, socketReused: false }, null)), "network_error");
  assert.equal(appWebhookDeliveryErrorCode(new WebhookPostError(new AppNotificationDeliveryError("private"), { dnsMs: 3, socketReused: false }, null)), "ssrf_blocked");
});

test("webhook DNS pinning supports scalar and all-address lookup callbacks", () => {
  const pinned = { address: "203.0.113.10", family: 4 };
  const lookup = createAppWebhookPinnedLookup(pinned);

  let scalar: unknown[] = [];
  lookup("hooks.example.com", { all: false }, (...args) => {
    scalar = args;
  });
  assert.deepEqual(scalar, [null, pinned.address, pinned.family]);

  let all: unknown[] = [];
  lookup("hooks.example.com", { all: true }, (...args) => {
    all = args;
  });
  assert.deepEqual(all, [null, [pinned]]);
});

test("public channel creation replay uses its canonical channel id once", async () => {
  const { client, db } = await createTestDb();
  __setAppWebhookEncryptionKeyForTests(Buffer.alloc(32, 9));
  try {
    await configureAppWebhook({
      clientId: CLIENT_ID,
      actorUserId: USER_ID,
      endpointUrl: "https://hooks.example.com/raft",
    }, db);
    const channelId = "12121212-1212-4212-8212-121212121212";
    await db.insert(channels).values({
      id: channelId,
      serverId: SERVER_ID,
      name: "created-channel",
      type: "channel",
    });
    const event = {
      id: channelId,
      serverId: SERVER_ID,
      eventType: "server.public_channel_created" as const,
      subjectType: "channel" as const,
      subjectId: channelId,
    };
    assert.deepEqual(await emitAppFacingNotificationEvent(event, db), {
      eventId: channelId,
      recipientCount: 1,
    });
    assert.deepEqual(await emitAppFacingNotificationEvent(event, db), {
      eventId: channelId,
      recipientCount: 0,
    });
    assert.equal((await db.select().from(notificationEvents).where(eq(notificationEvents.id, channelId))).length, 1);
    assert.equal((await db.select().from(notificationRecipients).where(eq(notificationRecipients.eventId, channelId))).length, 1);
  } finally {
    __setAppWebhookEncryptionKeyForTests(null);
    await client.close();
  }
});

test("canonical fanout signs exact bodies and revalidates authority before retries and uninstall", async () => {
  const { client, db } = await createTestDb();
  __setAppWebhookEncryptionKeyForTests(Buffer.alloc(32, 9));
  __setOAuthServiceDbForTests(() => db);
  try {
    const webhook = await configureAppWebhook({
      clientId: CLIENT_ID,
      actorUserId: USER_ID,
      endpointUrl: "https://hooks.example.com/raft",
    }, db);
    assert.ok(webhook?.secret);

    const eventId = "66666666-6666-4666-8666-666666666666";
    assert.deepEqual(await emitAppFacingNotificationEvent({
      id: eventId,
      serverId: SERVER_ID,
      eventType: "server.config_updated",
      subjectType: "server",
      subjectId: SERVER_ID,
      occurredAt: new Date("2026-07-18T00:00:00.000Z"),
      provenance: {
        actor_type: "human",
        source: "api",
        changed_fields: ["translation_enabled", "translation_enabled"],
        secret: "must-not-survive",
      },
    }, db), { eventId, recipientCount: 1 });
    assert.deepEqual(
      await emitAppFacingNotificationEvent({
        id: eventId,
        serverId: SERVER_ID,
        eventType: "server.config_updated",
        subjectType: "server",
        subjectId: SERVER_ID,
      }, db),
      { eventId, recipientCount: 0 },
    );
    const rotated = await rotateAppWebhookSecret({
      clientId: CLIENT_ID,
      actorUserId: USER_ID,
    }, db);
    assert.ok(rotated?.secret);
    const graceDeliveryNow = new Date(rotated.previousValidUntil.getTime() - 60_000);
    const afterGraceDelivery = (minutes: number) => new Date(graceDeliveryNow.getTime() + minutes * 60_000);

    const posts: Array<{ body: string; headers: Record<string, string> }> = [];
    const delivered = await drainAppNotificationDeliveries({
      executor: db,
      post: async ({ body, headers }) => {
        posts.push({ body, headers });
        return { status: 204 };
      },
      now: graceDeliveryNow,
    });
    assert.deepEqual(delivered, { claimed: 1, delivered: 1, retried: 0, suppressed: 0, deadLettered: 0 });
    assert.equal(posts.length, 1);
    const envelope = JSON.parse(posts[0]!.body) as {
      installation_id: string;
      delivery_id: string;
      attempt: number;
      event: { id: string; provenance: Record<string, unknown> };
    };
    assert.equal(envelope.installation_id, INSTALLATION_ID);
    assert.equal(envelope.event.id, eventId);
    assert.deepEqual(envelope.event.provenance, {
      actor_type: "human",
      changed_fields: ["translation_enabled"],
      source: "api",
    });
    assert.equal(posts[0]!.headers["x-raft-delivery"], envelope.delivery_id);
    assert.equal(envelope.attempt, 1);
    assert.equal(
      posts[0]!.headers["x-raft-signature"],
      `v1=${createHmac("sha256", webhook.secret).update(`${posts[0]!.headers["x-raft-timestamp"]}.${posts[0]!.body}`).digest("hex")}`,
      "a delivery queued before normal rotation must use the previous secret during grace",
    );

    const retryEventId = "77777777-7777-4777-8777-777777777777";
    await emitAppFacingNotificationEvent({
      id: retryEventId,
      serverId: SERVER_ID,
      eventType: "server.config_updated",
      subjectType: "server",
      subjectId: SERVER_ID,
    }, db);
    const retryDeliveryIds: string[] = [];
    assert.deepEqual(await drainAppNotificationDeliveries({
      executor: db,
      post: async ({ headers }) => {
        retryDeliveryIds.push(headers["x-raft-delivery"]!);
        return { status: 503 };
      },
      now: afterGraceDelivery(1),
    }), { claimed: 1, delivered: 0, retried: 1, suppressed: 0, deadLettered: 0 });
    assert.deepEqual(await drainAppNotificationDeliveries({
      executor: db,
      post: async ({ headers }) => {
        retryDeliveryIds.push(headers["x-raft-delivery"]!);
        return { status: 204 };
      },
      now: afterGraceDelivery(3),
    }), { claimed: 1, delivered: 1, retried: 0, suppressed: 0, deadLettered: 0 });
    assert.equal(retryDeliveryIds.length, 2);
    assert.equal(retryDeliveryIds[0], retryDeliveryIds[1], "retry idempotency key must remain stable");

    const authorityRetryEventId = "78787878-7878-4787-8787-787878787878";
    await emitAppFacingNotificationEvent({
      id: authorityRetryEventId,
      serverId: SERVER_ID,
      eventType: "server.config_updated",
      subjectType: "server",
      subjectId: SERVER_ID,
    }, db);
    assert.deepEqual(await drainAppNotificationDeliveries({
      executor: db,
      post: async () => ({ status: 503 }),
      now: afterGraceDelivery(4),
    }), { claimed: 1, delivered: 0, retried: 1, suppressed: 0, deadLettered: 0 });

    await db.update(oauthClientInstalls).set({
      subscribedEvents: [],
      subscriptionRevision: 2,
    }).where(eq(oauthClientInstalls.id, INSTALLATION_ID));
    let retryPostCount = 0;
    assert.deepEqual(await drainAppNotificationDeliveries({
      executor: db,
      post: async () => {
        retryPostCount += 1;
        return { status: 204 };
      },
      now: afterGraceDelivery(6),
    }), { claimed: 1, delivered: 0, retried: 0, suppressed: 1, deadLettered: 0 });
    assert.equal(retryPostCount, 0);

    await db.update(oauthClientInstalls).set({
      subscribedEvents: ["server.config_updated", "server.public_channel_created"],
      subscriptionRevision: 3,
    }).where(eq(oauthClientInstalls.id, INSTALLATION_ID));
    const uninstallEventId = "88888888-8888-4888-8888-888888888888";
    await emitAppFacingNotificationEvent({
      id: uninstallEventId,
      serverId: SERVER_ID,
      eventType: "server.config_updated",
      subjectType: "server",
      subjectId: SERVER_ID,
    }, db);
    const uninstall = await uninstallMarketplaceOAuthClient({
      serverId: SERVER_ID,
      clientId: CLIENT_ID,
      revokedByUserId: USER_ID,
    });
    assert.ok(uninstall);
    const [uninstallRecipient] = await db.select().from(notificationRecipients)
      .where(eq(notificationRecipients.eventId, uninstallEventId));
    assert.ok(uninstallRecipient, "uninstall must preserve the canonical recipient receipt");
    const [uninstallDelivery] = await db.select().from(notificationDeliveries)
      .where(eq(notificationDeliveries.notificationId, uninstallRecipient.id));
    assert.equal(uninstallDelivery?.status, "suppressed");
    assert.equal(uninstallDelivery?.terminalReason, "installation_uninstalled");

    const privateChannelId = "99999999-9999-4999-8999-999999999999";
    await db.insert(channels).values({
      id: privateChannelId,
      serverId: SERVER_ID,
      name: "private-test",
      type: "private",
    });
    const privateEventId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    assert.deepEqual(await emitAppFacingNotificationEvent({
      id: privateEventId,
      serverId: SERVER_ID,
      eventType: "channel.config_updated",
      subjectType: "channel",
      subjectId: privateChannelId,
    }, db), { eventId: privateEventId, recipientCount: 0 });
    const privateEvents = await db.select().from(notificationEvents)
      .where(eq(notificationEvents.id, privateEventId));
    assert.equal(privateEvents.length, 0, "private channel events must not enter the app-facing stream");
  } finally {
    __resetOAuthServiceDbForTests();
    __setAppWebhookEncryptionKeyForTests(null);
    await client.close();
  }
});

test("retired and platform-managed clients cannot receive new App Notifications or drain queued delivery", async () => {
  const { client, db } = await createTestDb();
  __setAppWebhookEncryptionKeyForTests(Buffer.alloc(32, 9));
  try {
    await configureAppWebhook({
      clientId: CLIENT_ID,
      actorUserId: USER_ID,
      endpointUrl: "https://hooks.example.com/raft",
    }, db);
    const queuedEventId = "abababab-abab-4bab-8bab-abababababab";
    assert.deepEqual(await emitAppFacingNotificationEvent({
      id: queuedEventId,
      serverId: SERVER_ID,
      eventType: "server.config_updated",
      subjectType: "server",
      subjectId: SERVER_ID,
    }, db), { eventId: queuedEventId, recipientCount: 1 });

    await db.update(oauthClients).set({ appType: "slock_builtin" }).where(eq(oauthClients.id, CLIENT_ID));
    const retiredEventId = "bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc";
    assert.deepEqual(await emitAppFacingNotificationEvent({
      id: retiredEventId,
      serverId: SERVER_ID,
      eventType: "server.config_updated",
      subjectType: "server",
      subjectId: SERVER_ID,
    }, db), { eventId: retiredEventId, recipientCount: 0 });
    assert.deepEqual(
      await db.select({ id: notificationRecipients.id }).from(notificationRecipients)
        .where(eq(notificationRecipients.eventId, retiredEventId)),
      [],
    );

    let postCount = 0;
    assert.deepEqual(await drainAppNotificationDeliveries({
      executor: db,
      post: async () => {
        postCount += 1;
        return { status: 204 };
      },
      now: new Date("2030-01-01T00:00:00.000Z"),
    }), { claimed: 1, delivered: 0, retried: 0, suppressed: 1, deadLettered: 0 });
    assert.equal(postCount, 0, "a queued notification must be suppressed before any HTTP POST after retirement");
    const [queuedDelivery] = await db.select({ status: notificationDeliveries.status }).from(notificationDeliveries)
      .innerJoin(notificationRecipients, eq(notificationRecipients.id, notificationDeliveries.notificationId))
      .where(eq(notificationRecipients.eventId, queuedEventId));
    assert.equal(queuedDelivery?.status, "suppressed");

    await db.update(oauthClients).set({ appType: "third_party_global" }).where(eq(oauthClients.id, CLIENT_ID));
    await db.insert(externalAppRegistrations).values({
      oauthClientId: CLIENT_ID,
      provider: "slack",
      environment: "test",
      state: "active",
      providerAppId: "A_PLATFORM_NOTIFICATION",
      providerOAuthClientId: "platform-notification-client",
      capabilityManifestVersion: 1,
      capabilityManifestHash: "b".repeat(64),
      requiredCapabilities: ["channel_events"],
    });
    const platformEventId = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
    assert.deepEqual(await emitAppFacingNotificationEvent({
      id: platformEventId,
      serverId: SERVER_ID,
      eventType: "server.config_updated",
      subjectType: "server",
      subjectId: SERVER_ID,
    }, db), { eventId: platformEventId, recipientCount: 0 });
    assert.deepEqual(
      await db.select({ id: notificationRecipients.id }).from(notificationRecipients)
        .where(eq(notificationRecipients.eventId, platformEventId)),
      [],
    );
  } finally {
    __setAppWebhookEncryptionKeyForTests(null);
    await client.close();
  }
});

const OTHER_SERVER_ID = "99999999-9999-4999-8999-999999999999";
const SIGNED_IN_USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_SERVER_USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NEVER_SIGNED_IN_USER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SIGNED_IN_AGENT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

async function subscribeToMemberRemoved(db: Database) {
  await db.update(oauthClients).set({
    outboundCurrentEvents: ["server.config_updated", "server.public_channel_created", "server.member_removed"],
  }).where(eq(oauthClients.id, CLIENT_ID));
  await db.update(oauthClientInstalls).set({
    subscribedEvents: ["server.member_removed"],
    subscriptionRevision: 2,
  }).where(eq(oauthClientInstalls.id, INSTALLATION_ID));
}

async function seedSignIns(db: Database) {
  await db.insert(users).values([SIGNED_IN_USER_ID, OTHER_SERVER_USER_ID, NEVER_SIGNED_IN_USER_ID].map((id, index) => ({
    id,
    email: `member-event-${index}@example.com`,
    name: `member-event-${index}`,
    passwordHash: "test",
  })));
  await db.insert(servers).values({ id: OTHER_SERVER_ID, name: "Other", slug: "member-event-other", ownerId: USER_ID });
  await db.insert(agents).values({ id: SIGNED_IN_AGENT_ID, serverId: SERVER_ID, name: "member-event-agent" });
  const expiresAt = new Date("2026-01-01T00:00:00.000Z");
  await db.insert(oauthAccessTokens).values([
    // Expired and revoked still count: the app already received this `sub`.
    { serverId: SERVER_ID, principalType: "human", userId: SIGNED_IN_USER_ID, clientId: CLIENT_ID, tokenHash: "h1", scopes: ["openid"], expiresAt, revokedAt: expiresAt },
    // Signed in to the same app, but on another Server: not disclosed here.
    { serverId: OTHER_SERVER_ID, principalType: "human", userId: OTHER_SERVER_USER_ID, clientId: CLIENT_ID, tokenHash: "h2", scopes: ["openid"], expiresAt },
    { serverId: SERVER_ID, principalType: "agent", agentId: SIGNED_IN_AGENT_ID, clientId: CLIENT_ID, tokenHash: "h3", scopes: ["openid"], expiresAt },
  ]);
}

test("member removal events name members by member_ref and add sub only for principals who signed in to this app on this Server", async () => {
  const { client, db } = await createTestDb();
  __setAppWebhookEncryptionKeyForTests(Buffer.alloc(32, 9));
  __setAppMemberRefKeyForTests(Buffer.alloc(32, 7));
  __setOAuthServiceDbForTests(() => db);
  try {
    await configureAppWebhook({ clientId: CLIENT_ID, actorUserId: USER_ID, endpointUrl: "https://hooks.example.com/raft" }, db);
    await seedSignIns(db);

    // Not subscribed yet: nothing is written at all.
    assert.deepEqual(await emitAppFacingMemberEvents({
      serverId: SERVER_ID,
      eventType: "server.member_removed",
      members: [{ principalType: "human", principalId: SIGNED_IN_USER_ID, role: "member" }],
      provenance: { source: "server_service", actor_type: "human", reason: "removed" },
    }, db), { eventCount: 0, recipientCount: 0 });
    assert.equal((await db.select().from(notificationEvents)).length, 0);

    await subscribeToMemberRemoved(db);
    assert.deepEqual(await emitAppFacingMemberEvents({
      serverId: SERVER_ID,
      eventType: "server.member_removed",
      members: [
        { principalType: "human", principalId: SIGNED_IN_USER_ID, role: "admin" },
        { principalType: "human", principalId: OTHER_SERVER_USER_ID, role: "member" },
        { principalType: "human", principalId: NEVER_SIGNED_IN_USER_ID, role: "guest" },
        { principalType: "agent", principalId: SIGNED_IN_AGENT_ID, role: "member" },
      ],
      provenance: { source: "server_service", actor_type: "human", reason: "removed", secret: "dropped" },
    }, db), { eventCount: 4, recipientCount: 4 });

    const posts: string[] = [];
    assert.deepEqual(await drainAppNotificationDeliveries({
      executor: db,
      post: async ({ body }) => {
        posts.push(body);
        return { status: 204 };
      },
    }), { claimed: 4, delivered: 4, retried: 0, suppressed: 0, deadLettered: 0 });

    const subjects = new Map(posts.map((body) => {
      const envelope = JSON.parse(body) as { event: { type: string; subject: Record<string, unknown>; provenance: Record<string, unknown> } };
      assert.equal(envelope.event.type, "server.member_removed");
      assert.equal(envelope.event.provenance.reason, "removed");
      assert.equal(envelope.event.provenance.secret, undefined);
      assert.equal(envelope.event.subject.id, undefined, "the raw principal id is never the subject id");
      return [envelope.event.subject.member_ref as string, envelope.event.subject];
    }));
    const ref = (principalId: string) => deriveAppMemberRef({ clientId: CLIENT_ID, installationId: INSTALLATION_ID, principalId });
    assert.deepEqual(subjects.get(ref(SIGNED_IN_USER_ID).member_ref), {
      type: "member", principal_type: "human", ...ref(SIGNED_IN_USER_ID), sub: SIGNED_IN_USER_ID,
    });
    assert.deepEqual(subjects.get(ref(OTHER_SERVER_USER_ID).member_ref), {
      type: "member", principal_type: "human", ...ref(OTHER_SERVER_USER_ID),
    });
    assert.deepEqual(subjects.get(ref(NEVER_SIGNED_IN_USER_ID).member_ref), {
      type: "member", principal_type: "human", ...ref(NEVER_SIGNED_IN_USER_ID),
    });
    assert.deepEqual(subjects.get(ref(SIGNED_IN_AGENT_ID).member_ref), {
      type: "member", principal_type: "agent", ...ref(SIGNED_IN_AGENT_ID), sub: SIGNED_IN_AGENT_ID,
    });
  } finally {
    __resetOAuthServiceDbForTests();
    __setAppWebhookEncryptionKeyForTests(null);
    __setAppMemberRefKeyForTests(null);
    await client.close();
  }
});

test("a Server deletion's member removals still deliver after the tombstone; other member events do not", async () => {
  const { client, db } = await createTestDb();
  __setAppWebhookEncryptionKeyForTests(Buffer.alloc(32, 9));
  __setAppMemberRefKeyForTests(Buffer.alloc(32, 7));
  __setOAuthServiceDbForTests(() => db);
  try {
    await configureAppWebhook({ clientId: CLIENT_ID, actorUserId: USER_ID, endpointUrl: "https://hooks.example.com/raft" }, db);
    await subscribeToMemberRemoved(db);
    for (const reason of ["server_deleted", "removed"]) {
      await emitAppFacingMemberEvents({
        serverId: SERVER_ID,
        eventType: "server.member_removed",
        members: [{ principalType: "human", principalId: USER_ID, role: "owner" }],
        provenance: { source: "server_service", actor_type: "human", reason },
      }, db);
    }
    await db.update(servers).set({ deletedAt: new Date() }).where(eq(servers.id, SERVER_ID));

    const reasons: unknown[] = [];
    assert.deepEqual(await drainAppNotificationDeliveries({
      executor: db,
      post: async ({ body }) => {
        reasons.push((JSON.parse(body) as { event: { provenance: { reason: string } } }).event.provenance.reason);
        return { status: 204 };
      },
    }), { claimed: 2, delivered: 1, retried: 0, suppressed: 1, deadLettered: 0 });
    assert.deepEqual(reasons, ["server_deleted"]);
  } finally {
    __resetOAuthServiceDbForTests();
    __setAppWebhookEncryptionKeyForTests(null);
    __setAppMemberRefKeyForTests(null);
    await client.close();
  }
});

test("a member event queued about an agent is not delivered once that agent is a personal assistant", async () => {
  const { client, db } = await createTestDb();
  __setAppWebhookEncryptionKeyForTests(Buffer.alloc(32, 9));
  __setAppMemberRefKeyForTests(Buffer.alloc(32, 7));
  __setOAuthServiceDbForTests(() => db);
  try {
    await configureAppWebhook({ clientId: CLIENT_ID, actorUserId: USER_ID, endpointUrl: "https://hooks.example.com/raft" }, db);
    await subscribeToMemberRemoved(db);
    const ordinaryId = "66666666-6666-4666-8666-666666666601";
    const assistantId = "66666666-6666-4666-8666-666666666602";
    await db.insert(agents).values([
      { id: ordinaryId, serverId: SERVER_ID, name: "queued-ordinary" },
      { id: assistantId, serverId: SERVER_ID, name: "queued-assistant" },
    ]);
    const emitted = await emitAppFacingMemberEvents({
      serverId: SERVER_ID,
      eventType: "server.member_removed",
      members: [ordinaryId, assistantId].map((principalId) => ({ principalType: "agent" as const, principalId, role: "member" })),
      provenance: { source: "agent_service", actor_type: "human", reason: "removed" },
    }, db);
    assert.equal(emitted.eventCount, 2);
    // Marked after queueing (createMyAssistant marks its row after the insert).
    await db.update(agents).set({ assistantOwnerUserId: USER_ID }).where(eq(agents.id, assistantId));

    const refs: string[] = [];
    assert.deepEqual(await drainAppNotificationDeliveries({
      executor: db,
      post: async ({ body }) => {
        refs.push((JSON.parse(body) as { event: { subject: { member_ref: string } } }).event.subject.member_ref);
        return { status: 204 };
      },
    }), { claimed: 2, delivered: 1, retried: 0, suppressed: 1, deadLettered: 0 });
    assert.deepEqual(refs, [deriveAppMemberRef({ clientId: CLIENT_ID, installationId: INSTALLATION_ID, principalId: ordinaryId }).member_ref]);

    // And a new event about it is not written at all.
    assert.deepEqual(await emitAppFacingMemberEvents({
      serverId: SERVER_ID,
      eventType: "server.member_removed",
      members: [{ principalType: "agent", principalId: assistantId, role: "member" }],
      provenance: { source: "agent_service", actor_type: "human", reason: "removed" },
    }, db), { eventCount: 0, recipientCount: 0 });
  } finally {
    __resetOAuthServiceDbForTests();
    __setAppWebhookEncryptionKeyForTests(null);
    __setAppMemberRefKeyForTests(null);
    await client.close();
  }
});

test("announcing a large Server's deletion stays a few bulk writes", async () => {
  const { client, db } = await createTestDb();
  __setAppWebhookEncryptionKeyForTests(Buffer.alloc(32, 9));
  __setOAuthServiceDbForTests(() => db);
  try {
    await configureAppWebhook({ clientId: CLIENT_ID, actorUserId: USER_ID, endpointUrl: "https://hooks.example.com/raft" }, db);
    await subscribeToMemberRemoved(db);
    const members = Array.from({ length: 5000 }, (_, index) => ({
      principalType: "human" as const,
      principalId: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
      role: "member",
    }));
    const startedAt = performance.now();
    assert.deepEqual(await emitAppFacingMemberEvents({
      serverId: SERVER_ID,
      eventType: "server.member_removed",
      members,
      provenance: { source: "server_service", actor_type: "human", reason: "server_deleted" },
    }, db), { eventCount: 5000, recipientCount: 5000 });
    const elapsedMs = performance.now() - startedAt;
    console.log(JSON.stringify({ memberEventFanout: { members: 5000, elapsedMs: Math.round(elapsedMs) } }));
    assert.equal((await db.select().from(notificationDeliveries)).length, 5000);
    assert.ok(elapsedMs < 20_000, `5000 member events took ${Math.round(elapsedMs)}ms`);
  } finally {
    __resetOAuthServiceDbForTests();
    __setAppWebhookEncryptionKeyForTests(null);
    await client.close();
  }
});

// Tenny's conditions for installation.bot_changed (#proj-apps #35): it goes
// only to the installation it is about, needs no group, is never delivered to
// a suspended installation, and no other event can use its subject to skip
// groups. The registry half is pinned in packages/shared appNotifications.test.ts.
test("an installation event reaches only its own installation, needs no group, and never a suspended one", async () => {
  const { client, db } = await createTestDb();
  __setAppWebhookEncryptionKeyForTests(Buffer.alloc(32, 9));
  const OTHER_CLIENT_ID = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
  const OTHER_INSTALLATION_ID = "dededede-dede-4ede-8ede-dededededede";
  try {
    // Another App on the same Server, with no groups declared or approved.
    await db.insert(oauthClients).values({
      id: OTHER_CLIENT_ID,
      serverId: SERVER_ID,
      clientId: "outbound-other-app",
      clientSecretHash: "test",
      appType: "third_party_global",
      name: "Outbound Other App",
      publishStatus: "published",
      createdByUserId: USER_ID,
    });
    await db.insert(oauthClientInstalls).values({
      id: OTHER_INSTALLATION_ID,
      serverId: SERVER_ID,
      clientId: OTHER_CLIENT_ID,
      installedByUserId: USER_ID,
      subscribedEvents: ["installation.bot_changed"],
    });
    await db.update(oauthClientInstalls).set({
      subscribedEvents: ["installation.bot_changed", "server.config_updated", "server.public_channel_created"],
    }).where(eq(oauthClientInstalls.id, INSTALLATION_ID));
    for (const clientId of [CLIENT_ID, OTHER_CLIENT_ID]) {
      await configureAppWebhook({ clientId, actorUserId: USER_ID, endpointUrl: "https://hooks.example.com/raft" }, db);
    }
    const posts: Array<{ installation_id: string; event: { type: string; subject: unknown; data?: unknown } }> = [];
    const drain = () => drainAppNotificationDeliveries({
      executor: db,
      post: async ({ body }) => {
        posts.push(JSON.parse(body));
        return { status: 204 };
      },
    });
    const recipientsOf = async (eventId: string) => (await db.select({ id: notificationRecipients.recipientId })
      .from(notificationRecipients).where(eq(notificationRecipients.eventId, eventId))).map((row) => row.id);

    // Both installations subscribe; the event about one reaches that one only.
    const own = await emitAppInstallationNotificationEvent({
      eventType: "installation.bot_changed",
      installation: { id: INSTALLATION_ID, serverId: SERVER_ID },
    }, db);
    assert.equal(own.recipientCount, 1);
    assert.deepEqual(await recipientsOf(own.eventId), [INSTALLATION_ID]);
    // No group: the other App's installation, approved none, gets its own.
    const groupless = await emitAppInstallationNotificationEvent({
      eventType: "installation.bot_changed",
      installation: { id: OTHER_INSTALLATION_ID, serverId: SERVER_ID },
    }, db);
    assert.deepEqual(await recipientsOf(groupless.eventId), [OTHER_INSTALLATION_ID]);
    assert.deepEqual(await drain(), { claimed: 2, delivered: 2, retried: 0, suppressed: 0, deadLettered: 0 });
    assert.deepEqual(posts.map((post) => [post.installation_id, post.event.subject]).sort(), [
      [INSTALLATION_ID, { type: "installation", id: INSTALLATION_ID }],
      [OTHER_INSTALLATION_ID, { type: "installation", id: OTHER_INSTALLATION_ID }],
    ].sort());
    const ownPost = posts.find((post) => post.installation_id === INSTALLATION_ID)!;
    assert.deepEqual(ownPost.event.data, { state: "not_added", handle: deriveAppBotHandle("outbound-test-app") });

    // A row addressed to another App's installation, and a group-gated event
    // type wearing the installation subject, are both suppressed at send.
    const forgedEvent = await emitAppInstallationNotificationEvent({
      eventType: "installation.bot_changed",
      installation: { id: INSTALLATION_ID, serverId: SERVER_ID },
    }, db);
    const [crossRecipient] = await db.insert(notificationRecipients).values({
      eventId: forgedEvent.eventId, serverId: SERVER_ID, recipientType: "app_installation", recipientId: OTHER_INSTALLATION_ID,
    }).returning();
    await db.insert(notificationDeliveries).values({
      notificationId: crossRecipient!.id, adapter: "webhook", configRevision: 1, grantRevision: 0, subscriptionRevision: 0,
    });
    const [borrowed] = await db.insert(notificationEvents).values({
      serverId: SERVER_ID, eventType: "server.config_updated", requiredGroups: [], subjectType: "installation",
      subjectId: INSTALLATION_ID, occurredAt: new Date(),
    }).returning();
    const [borrowedRecipient] = await db.insert(notificationRecipients).values({
      eventId: borrowed!.id, serverId: SERVER_ID, recipientType: "app_installation", recipientId: INSTALLATION_ID,
    }).returning();
    await db.insert(notificationDeliveries).values({
      notificationId: borrowedRecipient!.id, adapter: "webhook", configRevision: 1, grantRevision: 1, subscriptionRevision: 1,
    });
    posts.length = 0;
    assert.deepEqual(await drain(), { claimed: 3, delivered: 1, retried: 0, suppressed: 2, deadLettered: 0 });
    assert.deepEqual(posts.map((post) => [post.installation_id, post.event.type]), [[INSTALLATION_ID, "installation.bot_changed"]]);

    // The emitters refuse to mix the two kinds.
    await assert.rejects(emitAppInstallationNotificationEvent({
      eventType: "server.config_updated" as never,
      installation: { id: INSTALLATION_ID, serverId: SERVER_ID },
    }, db), AppNotificationDeliveryError);
    await assert.rejects(emitAppFacingNotificationEvent({
      serverId: SERVER_ID, eventType: "installation.bot_changed" as never, subjectType: "installation" as never, subjectId: INSTALLATION_ID,
    }, db), AppNotificationDeliveryError);
    await assert.rejects(emitAppFacingNotificationEvent({
      serverId: SERVER_ID, eventType: "server.config_updated", subjectType: "channel", subjectId: SERVER_ID,
    }, db), /subject does not match/);

    // Suspended: queued before, suppressed at send; emitted during, no recipient.
    await emitAppInstallationNotificationEvent({
      eventType: "installation.bot_changed",
      installation: { id: INSTALLATION_ID, serverId: SERVER_ID },
    }, db);
    await db.update(oauthClientInstalls).set({ status: "suspended" }).where(eq(oauthClientInstalls.id, INSTALLATION_ID));
    posts.length = 0;
    assert.deepEqual(await drain(), { claimed: 1, delivered: 0, retried: 0, suppressed: 1, deadLettered: 0 });
    const duringSuspension = await emitAppInstallationNotificationEvent({
      eventType: "installation.bot_changed",
      installation: { id: INSTALLATION_ID, serverId: SERVER_ID },
    }, db);
    assert.equal(duringSuspension.recipientCount, 0);
    assert.equal((await db.select().from(notificationEvents).where(eq(notificationEvents.id, duringSuspension.eventId))).length, 1,
      "the event row is still written with the change");
    assert.deepEqual(await drain(), { claimed: 0, delivered: 0, retried: 0, suppressed: 0, deadLettered: 0 });
    assert.equal(posts.length, 0);
  } finally {
    __setAppWebhookEncryptionKeyForTests(null);
    await client.close();
  }
});
