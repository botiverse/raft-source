import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../db/index.js";
import { migratePglite } from "../db/pgliteMigrations.js";
import * as schema from "../db/schema.js";
import {
  computerLifecycleOperations,
  computerOutageOccurrences,
  computers,
  machines,
  notificationDeliveries,
  notificationEvents,
  oauthAppPermissionRevisions,
  oauthClientInstalls,
  oauthClients,
  servers,
  users,
} from "../db/schema.js";
import {
  drainAppNotificationDeliveries,
  emitAppFacingNotificationEvent,
} from "./appNotificationDeliveryService.js";
import {
  __setAppWebhookEncryptionKeyForTests,
  configureAppWebhook,
} from "./appWebhookConfigService.js";
import {
  drainDueComputerOutageNotifications,
  recordComputerOfflineTransition,
  recordComputerOnlineTransition,
} from "./computerOutageNotificationService.js";

async function createFixture() {
  const client = new PGlite();
  await migratePglite(client);
  const db = drizzle(client, { schema }) as unknown as Database;
  const userId = randomUUID();
  const serverId = randomUUID();
  const clientId = randomUUID();
  const revisionId = randomUUID();
  const installationId = randomUUID();
  await db.insert(users).values({
    id: userId,
    email: `${randomUUID()}@outage.test`,
    name: `outage-${randomUUID()}`,
    passwordHash: "test",
  });
  await db.insert(servers).values({
    id: serverId,
    name: "Computer Outage Test",
    slug: `outage-${randomUUID()}`,
    ownerId: userId,
  });
  const [machine] = await db.insert(machines).values({
    serverId,
    userId,
    name: "outage-machine",
    apiKeyHash: "machine-hash",
  }).returning();
  assert.ok(machine);
  const [computer] = await db.insert(computers).values({
    serverId,
    name: "outage-computer",
    apiKeyHash: "computer-hash",
    apiKeyPrefix: `sk_computer_${randomUUID().slice(0, 8)}`,
    attachedByUserId: userId,
    machineId: machine.id,
  }).returning();
  assert.ok(computer);

  await db.insert(oauthClients).values({
    id: clientId,
    serverId,
    clientId: `outage-app-${randomUUID()}`,
    clientSecretHash: "test",
    appType: "third_party_global",
    name: "Computer Outage App",
    publishStatus: "published",
    createdByUserId: userId,
    outboundRequestRevision: 1,
    outboundCurrentGroups: ["computer"],
    outboundCurrentEvents: ["computer.offline", "computer.online"],
  });
  await db.insert(oauthAppPermissionRevisions).values({
    id: revisionId,
    clientId,
    revision: 1,
    requestedGroups: ["computer"],
    requestedEvents: ["computer.offline", "computer.online"],
    state: "active",
    createdByType: "human",
    createdById: userId,
  });
  await db.update(oauthClients).set({ outboundCurrentRevisionId: revisionId })
    .where(eq(oauthClients.id, clientId));
  await db.insert(oauthClientInstalls).values({
    id: installationId,
    serverId,
    clientId,
    installedByUserId: userId,
    approvedRequestRevisionId: revisionId,
    approvedGroups: ["computer"],
    subscribedEvents: ["computer.offline", "computer.online"],
    grantRevision: 1,
    subscriptionRevision: 1,
  });
  __setAppWebhookEncryptionKeyForTests(Buffer.alloc(32, 8));
  await configureAppWebhook({
    clientId,
    actorUserId: userId,
    endpointUrl: "https://hooks.example.com/raft",
  }, db);

  return { client, db, userId, serverId, machineId: machine.id, computerId: computer.id };
}

async function closeFixture(fixture: Awaited<ReturnType<typeof createFixture>>) {
  __setAppWebhookEncryptionKeyForTests(null);
  await fixture.client.close();
}

function at(ms: number): Date {
  return new Date(Date.UTC(2026, 7, 14, 12, 0, 0, ms));
}

async function readEvents(db: Database) {
  return db.select().from(notificationEvents).orderBy(asc(notificationEvents.createdAt));
}

async function alignFixtureOutboxClock(db: Database, now: Date) {
  await db.update(notificationDeliveries).set({
    nextAttemptAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

test("unexpected managed Computer outage emits one offline and one correlated online receipt", async () => {
  const fixture = await createFixture();
  try {
    assert.deepEqual(await recordComputerOfflineTransition({
      serverId: fixture.serverId,
      machineId: fixture.machineId,
      connectionEpochId: "epoch-unexpected",
      now: at(0),
      dwellMs: 60_000,
      executor: fixture.db,
    }), { status: "created", occurrenceId: (await fixture.db.select().from(computerOutageOccurrences))[0]!.id });

    assert.deepEqual(await drainDueComputerOutageNotifications({
      now: at(59_999),
      executor: fixture.db,
    }), { claimed: 0, offlineEmitted: 0 });
    assert.equal((await readEvents(fixture.db)).length, 0);

    assert.deepEqual(await drainDueComputerOutageNotifications({
      now: at(60_000),
      executor: fixture.db,
    }), { claimed: 1, offlineEmitted: 1 });
    const [offline] = await readEvents(fixture.db);
    assert.ok(offline);
    assert.equal(offline.eventType, "computer.offline");
    assert.equal(offline.subjectType, "computer");
    assert.equal(offline.subjectId, fixture.computerId);
    assert.equal(offline.provenance.source, "machine_connection_transition");
    assert.equal(typeof offline.provenance.outage_occurrence_id, "string");

    assert.deepEqual(await recordComputerOnlineTransition({
      serverId: fixture.serverId,
      machineId: fixture.machineId,
      now: at(75_000),
      executor: fixture.db,
    }), { recovered: 1, suppressedFlaps: 0, offlineEmitted: 0, onlineEmitted: 1 });

    const events = await readEvents(fixture.db);
    assert.equal(events.length, 2);
    const online = events.find((event) => event.eventType === "computer.online");
    assert.ok(online);
    assert.equal(online.subjectId, fixture.computerId);
    assert.equal(online.provenance.outage_occurrence_id, offline.provenance.outage_occurrence_id);
    assert.equal(online.provenance.recovery_for_event_id, offline.id);
    assert.equal((await fixture.db.select().from(notificationDeliveries)).length, 2);
  } finally {
    await closeFixture(fixture);
  }
});

test("reconnect before dwell suppresses the flap and emits no app incident", async () => {
  const fixture = await createFixture();
  try {
    await recordComputerOfflineTransition({
      serverId: fixture.serverId,
      machineId: fixture.machineId,
      connectionEpochId: "epoch-flap",
      now: at(0),
      dwellMs: 60_000,
      executor: fixture.db,
    });
    assert.deepEqual(await recordComputerOnlineTransition({
      serverId: fixture.serverId,
      machineId: fixture.machineId,
      now: at(20_000),
      executor: fixture.db,
    }), { recovered: 0, suppressedFlaps: 1, offlineEmitted: 0, onlineEmitted: 0 });
    assert.deepEqual(await drainDueComputerOutageNotifications({
      now: at(90_000),
      executor: fixture.db,
    }), { claimed: 0, offlineEmitted: 0 });
    assert.equal((await readEvents(fixture.db)).length, 0);
    const [occurrence] = await fixture.db.select().from(computerOutageOccurrences);
    assert.equal(occurrence?.state, "suppressed");
    assert.equal(occurrence.suppressReason, "recovered_before_dwell");
  } finally {
    await closeFixture(fixture);
  }
});

test("clean shutdown and matching lifecycle operation suppress outage incidents", async () => {
  const fixture = await createFixture();
  try {
    assert.deepEqual(await recordComputerOfflineTransition({
      serverId: fixture.serverId,
      machineId: fixture.machineId,
      connectionEpochId: "epoch-shutdown",
      shutdownIntent: { reason: "computer_stop" },
      now: at(0),
      executor: fixture.db,
    }), { status: "suppressed_planned", reason: "machine_shutdown" });

    await fixture.db.insert(computerLifecycleOperations).values({
      serverId: fixture.serverId,
      computerId: fixture.computerId,
      machineId: fixture.machineId,
      action: "restart",
      actorUserId: fixture.userId,
      dispatchMode: "local",
      connectionEpochBefore: "epoch-restart",
    });
    assert.deepEqual(await recordComputerOfflineTransition({
      serverId: fixture.serverId,
      machineId: fixture.machineId,
      connectionEpochId: "epoch-restart",
      now: at(1_000),
      executor: fixture.db,
    }), { status: "suppressed_planned", reason: "lifecycle_operation" });

    assert.equal((await fixture.db.select().from(computerOutageOccurrences)).length, 0);
    assert.equal((await readEvents(fixture.db)).length, 0);
  } finally {
    await closeFixture(fixture);
  }
});

test("duplicate same-epoch disconnects, due drains, and reconnects are exactly-once", async () => {
  const fixture = await createFixture();
  try {
    const first = await recordComputerOfflineTransition({
      serverId: fixture.serverId,
      machineId: fixture.machineId,
      connectionEpochId: "epoch-duplicate",
      now: at(0),
      dwellMs: 60_000,
      executor: fixture.db,
    });
    assert.equal(first.status, "created");
    assert.deepEqual(await recordComputerOfflineTransition({
      serverId: fixture.serverId,
      machineId: fixture.machineId,
      connectionEpochId: "epoch-duplicate",
      now: at(5_000),
      dwellMs: 60_000,
      executor: fixture.db,
    }), { status: "duplicate" });
    assert.equal((await fixture.db.select().from(computerOutageOccurrences)).length, 1);

    const drains = await Promise.all([
      drainDueComputerOutageNotifications({ now: at(61_000), executor: fixture.db }),
      drainDueComputerOutageNotifications({ now: at(61_000), executor: fixture.db }),
    ]);
    assert.equal(drains.reduce((sum, item) => sum + item.offlineEmitted, 0), 1);

    const recoveries = await Promise.all([
      recordComputerOnlineTransition({
        serverId: fixture.serverId,
        machineId: fixture.machineId,
        now: at(75_000),
        executor: fixture.db,
      }),
      recordComputerOnlineTransition({
        serverId: fixture.serverId,
        machineId: fixture.machineId,
        now: at(75_000),
        executor: fixture.db,
      }),
    ]);
    assert.equal(recoveries.reduce((sum, item) => sum + item.onlineEmitted, 0), 1);
    const events = await readEvents(fixture.db);
    assert.deepEqual(events.map((event) => event.eventType).sort(), ["computer.offline", "computer.online"]);
  } finally {
    await closeFixture(fixture);
  }
});

test("two server replicas promoting the same epoch emit one occurrence and one offline", async () => {
  const fixture = await createFixture();
  try {
    const records = await Promise.all([
      recordComputerOfflineTransition({
        serverId: fixture.serverId,
        machineId: fixture.machineId,
        connectionEpochId: "epoch-replica",
        now: at(0),
        dwellMs: 60_000,
        executor: fixture.db,
      }),
      recordComputerOfflineTransition({
        serverId: fixture.serverId,
        machineId: fixture.machineId,
        connectionEpochId: "epoch-replica",
        now: at(0),
        dwellMs: 60_000,
        executor: fixture.db,
      }),
    ]);
    assert.deepEqual(records.map((item) => item.status).sort(), ["created", "duplicate"]);
    assert.equal((await fixture.db.select().from(computerOutageOccurrences)).length, 1);

    const drains = await Promise.all([
      drainDueComputerOutageNotifications({ now: at(60_000), executor: fixture.db }),
      drainDueComputerOutageNotifications({ now: at(60_000), executor: fixture.db }),
    ]);
    assert.equal(drains.reduce((sum, item) => sum + item.claimed, 0), 1);
    assert.equal(drains.reduce((sum, item) => sum + item.offlineEmitted, 0), 1);
    const events = await readEvents(fixture.db);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.eventType, "computer.offline");
  } finally {
    await closeFixture(fixture);
  }
});

test("delivery retry reuses the app notification outbox without duplicating the outage occurrence", async () => {
  const fixture = await createFixture();
  try {
    await recordComputerOfflineTransition({
      serverId: fixture.serverId,
      machineId: fixture.machineId,
      connectionEpochId: "epoch-retry",
      now: at(0),
      dwellMs: 60_000,
      executor: fixture.db,
    });
    await drainDueComputerOutageNotifications({ now: at(60_000), executor: fixture.db });
    await alignFixtureOutboxClock(fixture.db, at(60_000));
    const [delivery] = await fixture.db.select().from(notificationDeliveries);
    assert.ok(delivery);

    assert.deepEqual(await drainAppNotificationDeliveries({
      executor: fixture.db,
      now: at(61_000),
      post: async () => ({ status: 503 }),
    }), { claimed: 1, delivered: 0, retried: 1, suppressed: 0, deadLettered: 0 });
    assert.deepEqual(await drainAppNotificationDeliveries({
      executor: fixture.db,
      now: at(122_000),
      post: async () => ({ status: 204 }),
    }), { claimed: 1, delivered: 1, retried: 0, suppressed: 0, deadLettered: 0 });

    const [afterRetry] = await fixture.db.select().from(notificationDeliveries)
      .where(eq(notificationDeliveries.id, delivery.id));
    assert.ok(afterRetry);
    assert.equal(afterRetry.attemptCount, 2);
    assert.equal(afterRetry.status, "delivered");
    assert.equal((await fixture.db.select().from(computerOutageOccurrences)).length, 1);
    assert.equal((await readEvents(fixture.db)).length, 1);
  } finally {
    await closeFixture(fixture);
  }
});

test("server delivery worker pushes an existing outbox after the Computer is offline", async () => {
  const fixture = await createFixture();
  try {
    await recordComputerOfflineTransition({
      serverId: fixture.serverId,
      machineId: fixture.machineId,
      connectionEpochId: "epoch-server-worker-live",
      now: at(0),
      dwellMs: 60_000,
      executor: fixture.db,
    });
    await drainDueComputerOutageNotifications({ now: at(60_000), executor: fixture.db });
    await alignFixtureOutboxClock(fixture.db, at(60_000));

    const posts: Array<{ body: string; headers: Record<string, string> }> = [];
    assert.deepEqual(await drainAppNotificationDeliveries({
      executor: fixture.db,
      now: at(61_000),
      post: async ({ body, headers }) => {
        posts.push({ body, headers });
        return { status: 204 };
      },
    }), { claimed: 1, delivered: 1, retried: 0, suppressed: 0, deadLettered: 0 });

    assert.equal(posts.length, 1);
    const envelope = JSON.parse(posts[0]!.body) as {
      delivery_id: string;
      event: { type: string; subject: { type: string; id: string }; provenance: Record<string, unknown> };
    };
    assert.equal(envelope.event.type, "computer.offline");
    assert.deepEqual(envelope.event.subject, { type: "computer", id: fixture.computerId });
    assert.equal(envelope.event.provenance.source, "machine_connection_transition");
    assert.equal(posts[0]!.headers["x-raft-delivery"], envelope.delivery_id);
  } finally {
    await closeFixture(fixture);
  }
});

test("outage delivery fixture keeps occurrence and outbox on one injected test clock", async () => {
  const fixture = await createFixture();
  try {
    const occurredAt = at(0);
    const outboxReadyAt = at(60_000);
    const deliveryNow = at(61_000);

    await recordComputerOfflineTransition({
      serverId: fixture.serverId,
      machineId: fixture.machineId,
      connectionEpochId: "epoch-clock-contract",
      now: occurredAt,
      dwellMs: 60_000,
      executor: fixture.db,
    });
    await drainDueComputerOutageNotifications({ now: outboxReadyAt, executor: fixture.db });
    await alignFixtureOutboxClock(fixture.db, outboxReadyAt);

    const [deliveryBefore] = await fixture.db.select().from(notificationDeliveries);
    assert.ok(deliveryBefore);
    assert.equal(
      deliveryBefore.nextAttemptAt.toISOString(),
      outboxReadyAt.toISOString(),
      "fixture outbox must be due on the same fixed clock as outage notification emission",
    );

    const posts: Array<{ body: string; headers: Record<string, string> }> = [];
    assert.deepEqual(await drainAppNotificationDeliveries({
      executor: fixture.db,
      now: deliveryNow,
      post: async ({ body, headers }) => {
        posts.push({ body, headers });
        return { status: 204 };
      },
    }), { claimed: 1, delivered: 1, retried: 0, suppressed: 0, deadLettered: 0 });

    assert.equal(posts.length, 1);
    const envelope = JSON.parse(posts[0]!.body) as {
      event: { occurred_at: string };
    };
    assert.equal(
      envelope.event.occurred_at,
      occurredAt.toISOString(),
      "webhook event time must come from the outage occurrence clock",
    );
    assert.equal(
      posts[0]!.headers["x-raft-timestamp"],
      Math.floor(deliveryNow.getTime() / 1000).toString(),
      "delivery attempt timestamp must come from the injected drain clock",
    );
  } finally {
    await closeFixture(fixture);
  }
});

test("online recovery promotes a due pending occurrence without interleaving", async () => {
  const fixture = await createFixture();
  try {
    await recordComputerOfflineTransition({
      serverId: fixture.serverId,
      machineId: fixture.machineId,
      connectionEpochId: "epoch-online-control",
      now: at(0),
      dwellMs: 60_000,
      executor: fixture.db,
    });
    await fixture.db.update(computerOutageOccurrences)
      .set({ notifyAfter: at(10) })
      .where(eq(computerOutageOccurrences.machineId, fixture.machineId));

    assert.deepEqual(await recordComputerOnlineTransition({
      serverId: fixture.serverId,
      machineId: fixture.machineId,
      now: at(30),
      executor: fixture.db,
    }), { recovered: 1, suppressedFlaps: 0, offlineEmitted: 1, onlineEmitted: 1 });

    const [row] = await fixture.db.select().from(computerOutageOccurrences)
      .where(eq(computerOutageOccurrences.machineId, fixture.machineId));
    assert.equal(row?.state, "recovered");
    const events = await readEvents(fixture.db);
    assert.deepEqual(events.map((event) => event.eventType), ["computer.offline", "computer.online"]);
  } finally {
    await closeFixture(fixture);
  }
});

test("online recovery survives a concurrent drain advancing the pending snapshot", async () => {
  const fixture = await createFixture();
  try {
    await recordComputerOfflineTransition({
      serverId: fixture.serverId,
      machineId: fixture.machineId,
      connectionEpochId: "epoch-online-race",
      now: at(0),
      dwellMs: 60_000,
      executor: fixture.db,
    });
    await fixture.db.update(computerOutageOccurrences)
      .set({ notifyAfter: at(10) })
      .where(eq(computerOutageOccurrences.machineId, fixture.machineId));

    let advanced = false;
    const wrapChain = (node: any, tx: any): any => new Proxy(node, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: any[]) => {
          const result = value.apply(target, args);
          if (property === "orderBy") {
            return (async () => {
              const rows = await result;
              if (!advanced) {
                const [occurrence] = rows;
                assert.ok(occurrence);
                advanced = true;
                await tx.update(computerOutageOccurrences)
                  .set({ state: "notified", offlineNotifiedAt: at(20), updatedAt: at(20) })
                  .where(eq(computerOutageOccurrences.machineId, fixture.machineId));
                await emitAppFacingNotificationEvent({
                  id: occurrence.offlineEventId,
                  serverId: occurrence.serverId,
                  eventType: "computer.offline",
                  subjectType: "computer",
                  subjectId: occurrence.computerId,
                  occurredAt: occurrence.firstOfflineAt,
                  provenance: {
                    source: "machine_connection_transition",
                    outage_occurrence_id: occurrence.id,
                  },
                }, tx);
              }
              return rows;
            })();
          }
          return result && typeof result === "object" ? wrapChain(result, tx) : result;
        };
      },
    });
    const interleavingDb = new Proxy(fixture.db as any, {
      get(target, property, receiver) {
        if (property === "transaction") {
          return (callback: any, ...args: any[]) => target.transaction(async (tx: any) => {
            const txProxy = new Proxy(tx, {
              get(txTarget, txProperty, txReceiver) {
                if (txProperty === "select") {
                  return (...selectArgs: any[]) => wrapChain(txTarget.select(...selectArgs), txTarget);
                }
                return Reflect.get(txTarget, txProperty, txReceiver);
              },
            });
            return callback(txProxy);
          }, ...args);
        }
        return Reflect.get(target, property, receiver);
      },
    }) as Database;

    assert.deepEqual(await recordComputerOnlineTransition({
      serverId: fixture.serverId,
      machineId: fixture.machineId,
      now: at(30),
      executor: interleavingDb,
    }), { recovered: 1, suppressedFlaps: 0, offlineEmitted: 0, onlineEmitted: 1 });
    assert.equal(advanced, true);

    const [row] = await fixture.db.select().from(computerOutageOccurrences)
      .where(eq(computerOutageOccurrences.machineId, fixture.machineId));
    assert.equal(row?.state, "recovered");
    const events = await readEvents(fixture.db);
    assert.deepEqual(events.map((event) => event.eventType), ["computer.offline", "computer.online"]);

    assert.deepEqual(await recordComputerOfflineTransition({
      serverId: fixture.serverId,
      machineId: fixture.machineId,
      connectionEpochId: "epoch-after-recovery-race",
      now: at(90_000),
      dwellMs: 60_000,
      executor: fixture.db,
    }), { status: "created", occurrenceId: (await fixture.db.select().from(computerOutageOccurrences)
      .where(eq(computerOutageOccurrences.connectionEpochId, "epoch-after-recovery-race")))[0]!.id });
  } finally {
    await closeFixture(fixture);
  }
});

test("unmanaged machine disconnects do not enter the app-facing Computer stream", async () => {
  const fixture = await createFixture();
  try {
    const otherMachineId = randomUUID();
    await fixture.db.insert(machines).values({
      id: otherMachineId,
      serverId: fixture.serverId,
      userId: fixture.userId,
      name: "unmanaged-machine",
      apiKeyHash: "machine-hash",
    });
    assert.deepEqual(await recordComputerOfflineTransition({
      serverId: fixture.serverId,
      machineId: otherMachineId,
      connectionEpochId: "epoch-unmanaged",
      now: at(0),
      executor: fixture.db,
    }), { status: "ignored_unmanaged" });
    assert.equal((await readEvents(fixture.db)).length, 0);
  } finally {
    await closeFixture(fixture);
  }
});
