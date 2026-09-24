import assert from "node:assert/strict";
import { test } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq } from "drizzle-orm";
import { closeDatabase, getDb, initDatabase } from "../db/index.js";
import { agents, serverMembers, servers, users } from "../db/schema.js";
import { transitionMemberRole, updateServerOnboardingSettings } from "./serverService.js";

/**
 * #4883 concurrency regression — opt-in, real PostgreSQL only (PGlite runs statements serially and
 * cannot exhibit this). Set PROMOTED_OWNER_REAL_PG_URL to an admin PG URL to run it.
 *
 * Review (John) found a lost-update race: owner-entry (`transitionMemberRole` / `addMember`) and a
 * checkpoint setter (`updateServerOnboardingSettings` / `updateServerOnboardingAgent`) touch the
 * same (owner × checkpoint) set in opposite orders, so under snapshot isolation each misses the
 * other's uncommitted change and a promoted owner is left `not_started`. The fix serializes both
 * on one lock order — `servers` row first, then `server_members`.
 *
 * Unlike the PGlite logic teeth, this drives the REAL service functions concurrently against real
 * PostgreSQL, so it guards the actual lock wiring in serverService, not a mirror of it. With the
 * fix the two operations serialize and the promoted owner is always reconciled; reverting the
 * `servers`-row lock reproduces the leak (verified in review).
 */

const REAL_PG_URL_ENV = "PROMOTED_OWNER_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const ITERATIONS = 25;

function quoteIdentifier(identifier: string): string {
  assert.match(identifier, /^[a-z0-9_]+$/);
  return `"${identifier}"`;
}

function databaseUrlFor(adminUrl: string, databaseName: string): string {
  const parsed = new URL(adminUrl);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

test(
  "concurrent promote-owner and checkpoint-set never leave a not_started owner (real PG)",
  { skip: !REAL_PG_URL },
  async () => {
    assert.ok(REAL_PG_URL);
    const databaseName = `slock_4883_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "4883-admin" });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const testUrl = databaseUrlFor(REAL_PG_URL, databaseName);

      // Migrate the fresh DB, then point the global db (what the service functions use) at it.
      const migratePool = new pg.Pool({ connectionString: testUrl, max: 1 });
      await migrate(drizzle(migratePool), { migrationsFolder: MIGRATIONS_FOLDER });
      await migratePool.end();
      await initDatabase(testUrl);
      const db = getDb();

      for (let i = 0; i < ITERATIONS; i++) {
        const serverId = randomUUID();
        const ownerId = randomUUID();
        const coOwnerId = randomUUID();
        const tag = `${databaseName}_${i}`;

        await db.insert(users).values([
          { id: ownerId, email: `o-${tag}@t.test`, name: `o-${tag}`, passwordHash: "h", emailVerified: true },
          { id: coOwnerId, email: `c-${tag}@t.test`, name: `c-${tag}`, passwordHash: "h", emailVerified: true },
        ]);
        await db.insert(servers).values({ id: serverId, name: "S", slug: `s-${tag}`, ownerId });
        const [agent] = await db.insert(agents).values({
          serverId, name: "Cindy", displayName: "Onboarding Assistant",
          description: "official", avatarUrl: "pixel:mug", runtime: "claude",
        }).returning();
        // Original owner already complete; co-owner is a plain member; checkpoint NOT crossed yet.
        await db.insert(serverMembers).values([
          { serverId, userId: ownerId, role: "owner", setupStatus: "complete", setupCompletionReason: "normal" },
          { serverId, userId: coOwnerId, role: "member", setupStatus: "not_started" },
        ]);

        // The two racing operations: promote the co-owner, and cross the checkpoint.
        await Promise.all([
          transitionMemberRole({
            serverId,
            actorUserId: ownerId,
            targetUserId: coOwnerId,
            nextRole: "owner",
            guestTransitionsEnabled: true,
          }),
          updateServerOnboardingSettings(serverId, { onboardingAgentId: agent.id }),
        ]);

        const [row] = await db.select({
          role: serverMembers.role,
          status: serverMembers.setupStatus,
          reason: serverMembers.setupCompletionReason,
        }).from(serverMembers).where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, coOwnerId)));

        assert.deepEqual(
          { role: row.role, status: row.status },
          { role: "owner", status: "complete" },
          `iteration ${i}: promoted owner must not be left not_started (got ${row.status}/${row.reason})`,
        );
      }

      await closeDatabase();
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`).catch(() => {});
      await admin.end();
    }
  },
);
