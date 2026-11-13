/**
 * Real-PostgreSQL probe: a Connection's OAuth status write cannot put a STALE default's status into
 * the App-level `oauth_status` mirror while the default is being switched.
 *
 * The race (@Huarong): default A's refresh fails and `recordConnectionOAuthStatus(A, error)` reads
 * "A is the default"; meanwhile `setServerDefaultConnection` makes B the default and mirrors B's
 * `connected`; A's write then lands `error` on top, and every Agent following the default is refused
 * although the default (B) is fine. The fix locks the App row BEFORE deciding which Connection is
 * the default, in the same order `setServerDefaultConnection` locks, so the two serialize.
 *
 * PGlite serializes transactions and cannot show this; only real parallel connections can. The test
 * holds the App-row lock in a "make B default" transaction, lets the status write start (and, without
 * the fix, read "A is default") while the lock is held, then switches the default and commits.
 *
 * Default-skipped. Run it with:
 *
 *   docker run -d --name pgmcpfix -e POSTGRES_PASSWORD=probe -p 55441:5432 postgres:16-alpine
 *   MCP_DEFAULT_MIRROR_REAL_PG_URL=postgres://postgres:probe@127.0.0.1:55441/postgres \
 *     pnpm --filter @botiverse/raft-server test:mcp-default-mirror
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { eq } from "drizzle-orm";
import { afterAll, test } from "vitest";

import { closeDatabase, getDb, initDatabase } from "./index";
import { managedMcpCredentials, managedMcpServers, servers, users } from "./schema";
import { setServerDefaultConnection } from "../services/managedMcpConnectionService";
import { __recordConnectionOAuthStatusForTests } from "../services/managedMcpOAuthService";

const REAL_PG_URL_ENV = "MCP_DEFAULT_MIRROR_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.MCP_DEFAULT_MIRROR_REAL_PG_REQUIRED === "1";

const drizzleDir = fileURLToPath(new URL("../../drizzle", import.meta.url));
const journal = JSON.parse(readFileSync(`${drizzleDir}/meta/_journal.json`, "utf8")) as { entries: Array<{ tag: string }> };

let createdDb: string | null = null;

afterAll(async () => {
  await closeDatabase().catch(() => {});
  if (createdDb && REAL_PG_URL) {
    const cleanup = new pg.Client({ connectionString: REAL_PG_URL });
    cleanup.on("error", () => {});
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS "${createdDb}" WITH (FORCE)`);
    await cleanup.end();
  }
});

async function freshDatabaseUrl(): Promise<string> {
  const name = `mcpmirror_${process.pid}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: REAL_PG_URL! });
  admin.on("error", () => {});
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  createdDb = name;
  const url = REAL_PG_URL!.replace(/\/[^/]*$/, `/${name}`);
  const migrator = new pg.Client({ connectionString: url });
  migrator.on("error", () => {});
  await migrator.connect();
  for (const entry of journal.entries) {
    await migrator.query("BEGIN");
    await migrator.query(readFileSync(`${drizzleDir}/${entry.tag}.sql`, "utf8"));
    await migrator.query("COMMIT");
  }
  await migrator.end();
  return url;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  "a failed refresh on the OLD default cannot overwrite the NEW default's status in the App mirror",
  { skip: !(REAL_PG_URL || REAL_PG_REQUIRED), timeout: 120_000 },
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    await initDatabase(await freshDatabaseUrl());
    const db = getDb();
    const [user] = await db.insert(users).values({
      email: `mirror-${randomUUID()}@example.test`, name: `mirror-${randomUUID().slice(0, 8)}`, passwordHash: "fixture-value-not-a-credential",
    }).returning();
    const [server] = await db.insert(servers).values({ name: "Mirror", slug: `mirror-${randomUUID().slice(0, 8)}`, ownerId: user.id }).returning();
    const [app] = await db.insert(managedMcpServers).values({
      serverId: server.id, name: "Signed", authMode: "oauth", oauthStatus: "connected", endpointUrl: "https://mirror.example.test/mcp", sourceKind: "url",
    }).returning();
    const [a] = await db.insert(managedMcpCredentials).values({
      serverId: server.id, mcpServerId: app.id, isServerDefault: true, name: "A", authKind: "oauth", authStatus: "ready",
    }).returning();
    const [b] = await db.insert(managedMcpCredentials).values({
      serverId: server.id, mcpServerId: app.id, isServerDefault: false, name: "B", authKind: "oauth", authStatus: "ready",
    }).returning();

    // The status write must start OUTSIDE the switch's async context, or it would share that
    // transaction's connection instead of racing it on its own.
    let locked!: () => void;
    let proceed!: () => void;
    const lockHeld = new Promise<void>((resolve) => { locked = resolve; });
    const mayProceed = new Promise<void>((resolve) => { proceed = resolve; });
    const makeBDefault = db.transaction(async (tx) => {
      // "Make B the default" has taken the App row lock and has not switched yet.
      await tx.select({ id: managedMcpServers.id }).from(managedMcpServers).where(eq(managedMcpServers.id, app.id)).for("update");
      locked();
      await mayProceed;
      await setServerDefaultConnection(tx, { serverId: server.id, mcpServerId: app.id, connectionId: b.id, userId: user.id });
    });
    await lockHeld;
    // A's refresh fails now, concurrently, on another connection.
    const statusWrite = __recordConnectionOAuthStatusForTests(app, a.id, { status: "expired", lastError: "refresh failed" });
    await sleep(500);
    proceed();
    await makeBDefault;
    assert.equal(await statusWrite, true);

    const [after] = await db.select().from(managedMcpServers).where(eq(managedMcpServers.id, app.id));
    const [aAfter] = await db.select().from(managedMcpCredentials).where(eq(managedMcpCredentials.id, a.id));
    assert.equal(aAfter.authStatus, "expired", "A's own status is still recorded");
    assert.equal(aAfter.isServerDefault, false);
    assert.equal(after.oauthStatus, "connected", "⭐ the mirror describes the NEW default (B), not A's failure");
  },
);
