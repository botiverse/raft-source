import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../db/index.js";
import { migratePglite } from "../db/pgliteMigrations.js";
import * as schema from "../db/schema.js";
import {
  channels,
  notificationDeliveries,
  notificationEvents,
  notificationRecipients,
  oauthAppPermissionRevisions,
  oauthClientInstalls,
  oauthClients,
  servers,
  users,
} from "../db/schema.js";
import {
  appWebhookDeliveryErrorCode,
  appWebhookDeliveryOutcomeForStatus,
  createAppWebhookPinnedLookup,
  drainAppNotificationDeliveries,
  emitAppFacingNotificationEvent,
} from "./appNotificationDeliveryService.js";
import {
  __resetOAuthServiceDbForTests,
  __setOAuthServiceDbForTests,
  uninstallMarketplaceOAuthClient,
} from "./oauthService.js";
import {
  __setAppWebhookEncryptionKeyForTests,
  AppWebhookConfigError,
  configureAppWebhook,
  rotateAppWebhookSecret,
} from "./appWebhookConfigService.js";

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
