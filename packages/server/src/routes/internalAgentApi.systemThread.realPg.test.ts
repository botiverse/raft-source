import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import { getDb } from "../db/index";
import * as schema from "../db/schema";
import { threadFollows, users } from "../db/schema";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import {
  __resetOrdinaryMessageOutboundAuthorizationResolverForTests,
  __setOrdinaryMessageOutboundAuthorizationResolverForTests,
  __setSlackBridgeReconciliationMarkerMinterForTests,
} from "../services/externalDeliveryOutboxService";
import { createMessage } from "../services/messageService";
import { createServer } from "../services/serverService";
import { fixturePasswordHash } from "../test/integration/credentials";
import { openTestApp } from "../test/integration/app";

const REAL_PG_URL_ENV = "SYSTEM_THREAD_SEND_REAL_PG_URL";
const DATABASE_URL = process.env[REAL_PG_URL_ENV];
const REQUIRED = process.env.SYSTEM_THREAD_SEND_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

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

test(
  "real PG: agent reply to a system-message thread never binds the system identity as a user UUID",
  {
    skip: !(DATABASE_URL || REQUIRED),
    timeout: 120_000,
  },
  async () => {
    assert.ok(DATABASE_URL, `${REAL_PG_URL_ENV} is required`);
    const previousAttestedSendMode = process.env.SLOCK_ATTESTED_SEND_MODE;
    process.env.SLOCK_ATTESTED_SEND_MODE = "force";
    const databaseName = `slock_system_thread_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({
      connectionString: DATABASE_URL,
      application_name: "system-thread-send-real-pg-admin",
    });
    let setupPool: pg.Pool | undefined;
    let app: Awaited<ReturnType<typeof openTestApp>> | undefined;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const testUrl = databaseUrlFor(DATABASE_URL, databaseName);
      setupPool = new pg.Pool({
        connectionString: testUrl,
        application_name: "system-thread-send-real-pg-setup",
        max: 2,
      });
      await migrate(drizzle(setupPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
      await setupPool.end();
      setupPool = undefined;

      app = await openTestApp(testUrl, 0, {
        humanActivityMuteFlagDefaultEnabled: true,
        skipAuthRateLimit: true,
      });
      __setOrdinaryMessageOutboundAuthorizationResolverForTests(async () => null);
      __setSlackBridgeReconciliationMarkerMinterForTests(({ deliveryId }) => `test:${deliveryId}`);
      const db = getDb();
      const suffix = randomUUID();
      const [owner] = await db.insert(users).values({
        email: `system-thread-real-pg-${suffix}@slock.test`,
        name: `system-thread-real-pg-${suffix}`,
        displayName: "System Thread Real PG Owner",
        passwordHash: await fixturePasswordHash("password123"),
        emailVerified: true,
        profileSetupCompletedAt: new Date(),
      }).returning();
      const server = await createServer(
        "System Thread Real PG",
        `system-thread-real-pg-${suffix}`,
        owner.id,
      );
      const agent = await createAgent(server.id, "SystemThreadRealPgAgent", {
        runtime: "claude",
        model: "sonnet",
      });
      const channel = await createChannel(server.id, `system-thread-${suffix}`);
      await addHuman(channel.id, owner.id);
      await addAgent(channel.id, agent.id);
      const credential = await mintAgentCredential({
        agentId: agent.id,
        scopes: ["send", "read"],
        name: "system-thread-real-pg",
        issuedVia: "computer",
        createdByUserId: null,
      });
      const parent = await createMessage(
        channel.id,
        "user",
        "system",
        "system thread parent",
        "system",
      );

      const response = await fetch(`${app.baseUrl}/internal/agent-api/send`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credential.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          target: `#${channel.name}:${parent.id.slice(0, 8)}`,
          content: "real-pg reply to system thread",
          seenUpToSeq: parent.seq,
        }),
      });
      const body = await response.json() as { state?: string; messageId?: string };

      assert.equal(response.status, 200);
      assert.equal(body.state, "sent");
      assert.ok(body.messageId);

      const follows = await db
        .select({ followerType: threadFollows.followerType, followerId: threadFollows.followerId })
        .from(threadFollows)
        .where(eq(threadFollows.parentMessageId, parent.id));
      assert.deepEqual(follows, [{ followerType: "agent", followerId: agent.id }]);
    } finally {
      __resetOrdinaryMessageOutboundAuthorizationResolverForTests();
      await app?.close();
      await setupPool?.end();
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
      } finally {
        await admin.end();
      }
      if (previousAttestedSendMode === undefined) delete process.env.SLOCK_ATTESTED_SEND_MODE;
      else process.env.SLOCK_ATTESTED_SEND_MODE = previousAttestedSendMode;
    }
  },
);
