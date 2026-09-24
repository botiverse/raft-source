import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import {
  closeDatabase,
  type Database,
  initDatabase,
} from "../db/index.js";
import * as schema from "../db/schema.js";
import {
  agents,
  channelAgents,
  channelHumans,
  channels,
  externalActorProjections,
  externalInboundEvents,
  externalMessageLinks,
  jointChannels,
  jointChannelServers,
  messages,
  serverMembers,
  servers,
  users,
} from "../db/schema.js";
import {
  enqueueExternalInboundEvent,
  processExternalInboundEventOnce,
  type ExternalInboundNormalizedMessage,
  type ExternalInboundRuntimeAuthority,
  type ExternalInboundWorkerDependencies,
} from "./externalInboundWorkerService.js";
import {
  __resetOrdinaryMessageOutboundAuthorizationResolverForTests,
  __setOrdinaryMessageOutboundAuthorizationResolverForTests,
} from "./externalDeliveryOutboxService.js";
import {
  broadcastAndDeliver,
  drainSenderReadReceiptsForTests,
} from "./messageService.js";

const REAL_PG_URL_ENV = "EXTERNAL_INBOUND_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.EXTERNAL_INBOUND_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const NOW = new Date("2026-08-13T04:47:00.000Z");
const noopOrchestrator = { deliverMessage: async () => undefined } as any;

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

function databaseUrlFor(adminUrl: string, databaseName: string): string {
  const parsed = new URL(adminUrl);
  assert.match(parsed.protocol, /^postgres(?:ql)?:$/, `${REAL_PG_URL_ENV} must be a PostgreSQL URL`);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function quoteIdentifier(identifier: string): string {
  assert.match(identifier, /^[a-z0-9_]+$/);
  return `"${identifier}"`;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function waitForApplicationLock(
  observer: pg.Client,
  input: {
    waiterApplication: string;
    waiterQuery: string;
    blockerApplication: string;
    blockerQuery: string;
  },
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await observer.query<{ wait_event_type: string | null }>(`
      SELECT waiter.wait_event_type
      FROM pg_stat_activity AS waiter
      CROSS JOIN LATERAL unnest(pg_blocking_pids(waiter.pid)) AS blocked_by(pid)
      INNER JOIN pg_stat_activity AS blocker ON blocker.pid = blocked_by.pid
      WHERE waiter.datname = current_database()
        AND waiter.application_name = $1
        AND waiter.query ILIKE $2
        AND blocker.application_name = $3
        AND blocker.query ILIKE $4
    `, [
      input.waiterApplication,
      input.waiterQuery,
      input.blockerApplication,
      input.blockerQuery,
    ]);
    if (result.rows.some((row) => row.wait_event_type === "Lock")) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `expected real PostgreSQL lock wait: ${input.waiterApplication} ${input.waiterQuery} blocked by ${input.blockerApplication} ${input.blockerQuery}`,
  );
}

async function seedFixture(db: Database) {
  const [owner, member] = await db.insert(users).values([
    {
      email: `inbound-real-pg-owner-${randomUUID()}@raft.test`,
      name: `inbound-real-pg-owner-${randomUUID().slice(0, 8)}`,
      displayName: "Inbound Real PG Owner",
      passwordHash: "test",
      emailVerified: true,
    },
    {
      email: `inbound-real-pg-member-${randomUUID()}@raft.test`,
      name: `inbound-real-pg-member-${randomUUID().slice(0, 8)}`,
      displayName: "Inbound Real PG Member",
      passwordHash: "test",
      emailVerified: true,
    },
  ]).returning();
  const [server] = await db.insert(servers).values({
    name: "External Inbound Worker Real PostgreSQL",
    slug: `external-inbound-real-pg-${randomUUID()}`,
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: `external-inbound-real-pg-${randomUUID()}`,
    type: "channel",
  }).returning();
  await db.insert(channelHumans).values([
    { channelId: channel.id, userId: owner.id },
    { channelId: channel.id, userId: member.id },
  ]);
  const [agent] = await db.insert(agents).values({
    serverId: server.id,
    name: `inbound-real-pg-agent-${randomUUID().slice(0, 8)}`,
    runtime: "codex",
  }).returning();
  await db.insert(channelAgents).values({ channelId: channel.id, agentId: agent.id });
  const [actor] = await db.insert(externalActorProjections).values({
    provider: "provider-real-pg",
    appRegistrationId: "registration-real-pg",
    installId: "install-real-pg",
    workspaceId: "workspace-real-pg",
    externalActorId: "external-actor-real-pg",
    displayName: "External Real PG Alice",
    handles: ["alice"],
    actorKind: "human",
    state: "active",
    deactivated: false,
    projectionRevision: 1,
    observedAt: NOW,
  }).returning();
  const authority: ExternalInboundRuntimeAuthority = {
    runtimeRevision: "runtime-real-pg-r1",
    provider: actor.provider,
    environment: "test",
    appRegistrationId: actor.appRegistrationId,
    installId: actor.installId,
    workspaceId: actor.workspaceId,
    providerAuthorityId: "authority-real-pg",
    providerConversationId: "conversation-real-pg",
    bindingId: "binding-real-pg",
    bindingEpoch: 1,
    connectionEpoch: 1,
    raftChannelId: channel.id,
    privacyClass: "public",
  };
  return { owner, server, channel, actor, authority };
}

async function convertFixtureToJoint(db: Database, fixture: Awaited<ReturnType<typeof seedFixture>>) {
  const [storageServer] = await db.insert(servers).values({
    name: "External inbound race canonical storage",
    slug: `external-inbound-race-storage-${randomUUID()}`,
    ownerId: fixture.owner.id,
  }).returning();
  const [canonical] = await db.insert(channels).values({
    serverId: storageServer.id,
    name: `external-inbound-race-canonical-${randomUUID()}`,
    type: "channel",
  }).returning();
  await db.update(channels).set({ type: "joint" }).where(eq(channels.id, fixture.channel.id));
  const [joint] = await db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: fixture.server.id,
    createdByUserId: fixture.owner.id,
  }).returning();
  await db.insert(jointChannelServers).values({
    jointChannelId: joint.id,
    serverId: fixture.server.id,
    localChannelId: fixture.channel.id,
    role: "host",
    joinedByUserId: fixture.owner.id,
  });
  return { canonical };
}

async function seedJointThreadProjection(
  db: Database,
  fixture: Awaited<ReturnType<typeof seedFixture>>,
  canonicalParent: typeof channels.$inferSelect,
) {
  const [canonicalRoot] = await db.insert(messages).values({
    channelId: canonicalParent.id,
    senderType: "user",
    senderId: fixture.owner.id,
    content: "canonical Joint root",
    messageType: "chat",
  }).returning();
  const [canonicalThread] = await db.insert(channels).values({
    serverId: canonicalParent.serverId,
    name: `canonical-joint-thread-${randomUUID()}`,
    type: "thread",
    parentMessageId: canonicalRoot.id,
  }).returning();
  const [localThread] = await db.insert(channels).values({
    serverId: fixture.server.id,
    name: `local-joint-thread-${randomUUID()}`,
    type: "thread",
    parentMessageId: null,
  }).returning();
  const [jointThread] = await db.insert(jointChannels).values({
    canonicalChannelId: canonicalThread.id,
    createdByServerId: fixture.server.id,
    createdByUserId: fixture.owner.id,
  }).returning();
  await db.insert(jointChannelServers).values({
    jointChannelId: jointThread.id,
    serverId: fixture.server.id,
    localChannelId: localThread.id,
    role: "host",
    joinedByUserId: fixture.owner.id,
  });
  return { canonicalRoot, canonicalThread, localThread };
}

function payload(
  projectionId: string,
  providerMessageId: string,
  providerThreadId: string | null = null,
): ExternalInboundNormalizedMessage {
  return {
    schema: "external-inbound-normalized-event.v1",
    projectionId,
    actorProjectionRevision: 1,
    externalActorId: "external-actor-real-pg",
    providerMessageId,
    providerThreadId,
    content: `provider content ${providerMessageId}`,
    createdAt: "2026-08-13T04:46:00.000Z",
  };
}

async function enqueue(
  db: Database,
  authority: ExternalInboundRuntimeAuthority,
  providerEventId: string,
  body: ExternalInboundNormalizedMessage,
  receivedAt: Date,
) {
  const plaintext = JSON.stringify(body);
  return enqueueExternalInboundEvent({
    db,
    authority,
    providerEventId,
    normalizedPayloadDigest: digest(plaintext),
    encryptedPayload: plaintext,
    envelopeKeyId: "opaque-real-pg-envelope-key",
    payloadExpiresAt: new Date(receivedAt.getTime() + 5 * 60_000),
    receivedAt,
  });
}

test(
  "real PostgreSQL claim fairness lets a newer event pass a blocked oldest row without dropping retry",
  {
    skip: !(REAL_PG_URL || REAL_PG_REQUIRED),
  },
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_task96_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({
      connectionString: REAL_PG_URL,
      application_name: "task96-real-pg-admin",
    });
    let pool: pg.Pool | null = null;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      pool = new pg.Pool({
        connectionString: databaseUrlFor(REAL_PG_URL, databaseName),
        application_name: "task96-real-pg-worker",
        max: 2,
      });
      const db = drizzle(pool, { schema }) as Database;
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      const fixture = await seedFixture(db);
      const blocked = await enqueue(
        db,
        fixture.authority,
        "event-real-pg-blocked",
        payload(fixture.actor.id, "provider-message-real-pg-blocked"),
        NOW,
      );
      let clock = NOW;
      let advanceFirstBlockedResolution = true;
      const dependencies: ExternalInboundWorkerDependencies = {
        now: () => clock,
        async decryptNormalizedPayload({ ciphertext }) {
          return ciphertext;
        },
        async resolveCurrentRuntime({ eventId }) {
          if (eventId !== blocked.event.id) return fixture.authority;
          if (advanceFirstBlockedResolution) {
            advanceFirstBlockedResolution = false;
            clock = new Date(clock.getTime() + 31_000);
          }
          return null;
        },
      };
      const processOnce = () => processExternalInboundEventOnce({
        db,
        leaseOwner: "task96-real-pg-worker",
        dependencies,
      });

      const firstBlocked = await processOnce();
      assert.equal(firstBlocked.kind, "blocked");
      if (firstBlocked.kind !== "blocked") assert.fail("oldest event must be blocked");
      assert.equal(firstBlocked.reason, "runtime_authority_inactive_or_mismatched");
      clock = new Date(clock.getTime() + 1_000);
      const newer = await enqueue(
        db,
        fixture.authority,
        "event-real-pg-newer",
        payload(fixture.actor.id, "provider-message-real-pg-newer"),
        clock,
      );
      const committed = await processOnce();
      assert.equal(committed.kind, "committed");
      assert.equal(committed.eventId, newer.event.id);
      assert.equal((await db.select().from(messages).where(eq(messages.senderType, "external_projection"))).length, 1);
      assert.equal((await db.select().from(externalMessageLinks)).length, 1);

      const [duringBackoff] = await db.select().from(externalInboundEvents)
        .where(eq(externalInboundEvents.id, blocked.event.id));
      assert.equal(duringBackoff.status, "queued");
      assert.equal(duringBackoff.leaseGeneration, 1);

      clock = new Date(NOW.getTime() + 61_000);
      const retriedBlocked = await processOnce();
      assert.equal(retriedBlocked.kind, "blocked");
      if (retriedBlocked.kind !== "blocked") assert.fail("blocked event must remain retryable");
      assert.equal(retriedBlocked.reason, "runtime_authority_inactive_or_mismatched");
      const [retried] = await db.select().from(externalInboundEvents)
        .where(eq(externalInboundEvents.id, blocked.event.id));
      assert.equal(retried.status, "queued");
      assert.equal(retried.leaseGeneration, 2);
    } finally {
      await pool?.end().catch(() => undefined);
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
      } finally {
        await admin.end();
      }
    }
  },
);

test(
  "real PostgreSQL serializes racing Joint replies into one canonical thread projection",
  {
    skip: !(REAL_PG_URL || REAL_PG_REQUIRED),
  },
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_task131_joint_thread_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL });
    let pool: pg.Pool | null = null;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      pool = new pg.Pool({
        connectionString: databaseUrlFor(REAL_PG_URL, databaseName),
        application_name: "task131-joint-thread-worker",
        max: 4,
      });
      const db = drizzle(pool, { schema }) as Database;
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      const fixture = await seedFixture(db);
      const { canonical } = await convertFixtureToJoint(db, fixture);
      const rootProviderMessageId = "provider-message-task131-root";
      await enqueue(
        db,
        fixture.authority,
        "event-task131-root",
        payload(fixture.actor.id, rootProviderMessageId),
        NOW,
      );
      const dependencies: ExternalInboundWorkerDependencies = {
        now: () => new Date(NOW.getTime() + 10_000),
        async decryptNormalizedPayload({ ciphertext }) { return ciphertext; },
        async resolveCurrentRuntime() { return fixture.authority; },
      };
      const root = await processExternalInboundEventOnce({
        db,
        leaseOwner: "task131-root-worker",
        dependencies,
      });
      assert.equal(root.kind, "committed");

      await Promise.all([
        enqueue(
          db,
          fixture.authority,
          "event-task131-reply-a",
          payload(fixture.actor.id, "provider-message-task131-reply-a", rootProviderMessageId),
          new Date(NOW.getTime() + 1_000),
        ),
        enqueue(
          db,
          fixture.authority,
          "event-task131-reply-b",
          payload(fixture.actor.id, "provider-message-task131-reply-b", rootProviderMessageId),
          new Date(NOW.getTime() + 2_000),
        ),
      ]);
      const results = await Promise.all([
        processExternalInboundEventOnce({
          db,
          leaseOwner: "task131-reply-worker-a",
          dependencies,
        }),
        processExternalInboundEventOnce({
          db,
          leaseOwner: "task131-reply-worker-b",
          dependencies,
        }),
      ]);
      assert.deepEqual(results.map((result) => result.kind).sort(), ["committed", "committed"]);

      const [canonicalRoot] = await db.select().from(messages).where(and(
        eq(messages.channelId, canonical.id),
        eq(messages.content, `provider content ${rootProviderMessageId}`),
      ));
      assert.ok(canonicalRoot);
      const canonicalThreads = await db.select().from(channels).where(and(
        eq(channels.type, "thread"),
        eq(channels.parentMessageId, canonicalRoot.id),
      ));
      assert.equal(canonicalThreads.length, 1);
      assert.equal(
        (await db.select().from(messages).where(eq(messages.channelId, canonicalThreads[0]!.id))).length,
        2,
      );
      const jointThreads = await db.select().from(jointChannels)
        .where(eq(jointChannels.canonicalChannelId, canonicalThreads[0]!.id));
      assert.equal(jointThreads.length, 1);
      const localThreadFaces = await db.select().from(jointChannelServers)
        .where(eq(jointChannelServers.jointChannelId, jointThreads[0]!.id));
      assert.equal(localThreadFaces.length, 1);
      assert.equal(localThreadFaces[0]!.serverId, fixture.server.id);
      assert.equal((await db.select().from(externalMessageLinks)).length, 3);
    } finally {
      await pool?.end().catch(() => undefined);
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
      } finally {
        await admin.end();
      }
    }
  },
);

test(
  "real PostgreSQL Joint inbound rechecks local host authority after its row lock wait",
  {
    skip: !(REAL_PG_URL || REAL_PG_REQUIRED),
  },
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_task118_inbound_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL });
    const workerApplication = "task118-joint-inbound-worker";
    const blockerApplication = "task118-joint-inbound-blocker";
    let pool: pg.Pool | null = null;
    let blocker: pg.Client | null = null;
    let observer: pg.Client | null = null;
    let worker: Promise<Awaited<ReturnType<typeof processExternalInboundEventOnce>>> | null = null;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const databaseUrl = databaseUrlFor(REAL_PG_URL, databaseName);
      pool = new pg.Pool({
        connectionString: databaseUrl,
        application_name: workerApplication,
        max: 2,
      });
      blocker = new pg.Client({ connectionString: databaseUrl, application_name: blockerApplication });
      observer = new pg.Client({ connectionString: databaseUrl, application_name: "task118-joint-inbound-observer" });
      await Promise.all([blocker.connect(), observer.connect()]);
      const db = drizzle(pool, { schema }) as Database;
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      const fixture = await seedFixture(db);
      const { canonical } = await convertFixtureToJoint(db, fixture);
      await enqueue(
        db,
        fixture.authority,
        "event-joint-authority-race",
        payload(fixture.actor.id, "provider-message-joint-authority-race"),
        NOW,
      );

      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM channels WHERE id = $1 FOR UPDATE", [fixture.channel.id]);
      worker = processExternalInboundEventOnce({
        db,
        leaseOwner: workerApplication,
        dependencies: {
          now: () => NOW,
          async decryptNormalizedPayload({ ciphertext }) {
            return ciphertext;
          },
          async resolveCurrentRuntime() {
            return fixture.authority;
          },
        },
      });
      await waitForApplicationLock(observer, {
        waiterApplication: workerApplication,
        waiterQuery: '%FROM "channels"%FOR UPDATE%',
        blockerApplication,
        blockerQuery: "%SELECT id FROM channels%FOR UPDATE%",
      });
      await blocker.query("UPDATE channels SET archived_at = $1 WHERE id = $2", [NOW, fixture.channel.id]);
      await blocker.query("COMMIT");

      const result = await worker;
      worker = null;
      assert.equal(result.kind, "blocked");
      if (result.kind !== "blocked") assert.fail("archived Joint host authority must block inbound commit");
      assert.equal(result.reason, "commit_authority_lost_or_root_unavailable");
      assert.equal((await db.select().from(messages).where(eq(messages.channelId, canonical.id))).length, 0);
      assert.equal((await db.select().from(externalMessageLinks)).length, 0);
    } finally {
      await blocker?.query("ROLLBACK").catch(() => undefined);
      await worker?.catch(() => undefined);
      await Promise.all([
        blocker?.end().catch(() => undefined),
        observer?.end().catch(() => undefined),
      ]);
      await pool?.end().catch(() => undefined);
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
      } finally {
        await admin.end();
      }
    }
  },
);

test(
  "real PostgreSQL Joint thread outbound rechecks inherited local host authority after its row lock wait",
  {
    skip: !(REAL_PG_URL || REAL_PG_REQUIRED),
  },
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_task118_outbound_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL });
    const workerApplication = "task118-joint-outbound-writer";
    const blockerApplication = "task118-joint-outbound-blocker";
    let pool: pg.Pool | null = null;
    let blocker: pg.Client | null = null;
    let observer: pg.Client | null = null;
    let writer: Promise<void> | null = null;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const databaseUrl = databaseUrlFor(REAL_PG_URL, databaseName);
      pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
      blocker = new pg.Client({ connectionString: databaseUrl, application_name: blockerApplication });
      observer = new pg.Client({ connectionString: databaseUrl, application_name: "task118-joint-outbound-observer" });
      await Promise.all([blocker.connect(), observer.connect()]);
      const db = drizzle(pool, { schema }) as Database;
      await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      const fixture = await seedFixture(db);
      const { canonical } = await convertFixtureToJoint(db, fixture);
      const { canonicalThread, localThread } = await seedJointThreadProjection(db, fixture, canonical);
      __setOrdinaryMessageOutboundAuthorizationResolverForTests(async () => null);
      const writerUrl = new URL(databaseUrl);
      writerUrl.searchParams.set("application_name", workerApplication);
      await initDatabase(writerUrl.toString());

      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM channels WHERE id = $1 FOR UPDATE", [fixture.channel.id]);
      writer = broadcastAndDeliver(createIo(), noopOrchestrator, {
        channelId: localThread.id,
        senderType: "user",
        senderId: fixture.owner.id,
        senderName: fixture.owner.name,
        content: "must not cross archived Joint thread host authority",
      }).then(() => undefined);
      await waitForApplicationLock(observer, {
        waiterApplication: workerApplication,
        waiterQuery: '%FROM "channels"%FOR UPDATE%',
        blockerApplication,
        blockerQuery: "%SELECT id FROM channels%FOR UPDATE%",
      });
      await blocker.query("UPDATE channels SET archived_at = $1 WHERE id = $2", [NOW, fixture.channel.id]);
      await blocker.query("COMMIT");

      await assert.rejects(writer, /conversation is unavailable/);
      writer = null;
      assert.equal((await db.select().from(messages).where(eq(messages.channelId, canonicalThread.id))).length, 0);
    } finally {
      __resetOrdinaryMessageOutboundAuthorizationResolverForTests();
      await blocker?.query("ROLLBACK").catch(() => undefined);
      await writer?.catch(() => undefined);
      await drainSenderReadReceiptsForTests().catch(() => undefined);
      await closeDatabase().catch(() => undefined);
      await Promise.all([
        blocker?.end().catch(() => undefined),
        observer?.end().catch(() => undefined),
      ]);
      await pool?.end().catch(() => undefined);
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
      } finally {
        await admin.end();
      }
    }
  },
);
