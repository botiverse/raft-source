// `recordComputerUse` writes a computer's last_used_* triple at most once per
// COMPUTER_USE_WRITE_INTERVAL_MS: within the interval this process skips the
// database, and another instance's write is a no-op until the stored value is
// older than the interval (no queue on the row lock when many requests from
// one computer land at once).
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/index";
import { computers, users } from "../db/schema";
import { createServer } from "./serverService";
import {
  attachComputer,
  COMPUTER_USE_WRITE_INTERVAL_MS,
  recordComputerUse,
  resetComputerUseWriteCacheForTests,
} from "./computerCredentialService";

afterEach(async () => {
  resetComputerUseWriteCacheForTests();
  await closeTestDatabase();
});

async function attach(): Promise<string> {
  const suffix = randomUUID();
  const [owner] = await getDb().insert(users).values({
    email: `computer-use-${suffix}@slock.test`,
    name: `computer-use-${suffix}`,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const server = await createServer("Computer use", `computer-use-${suffix}`, owner!.id);
  const attached = await attachComputer({ userId: owner!.id, serverSlug: server.slug, name: `use-${suffix.slice(0, 8)}` });
  assert.ok(attached.ok, JSON.stringify(attached));
  const [row] = await getDb().select({ id: computers.id }).from(computers).where(eq(computers.serverId, server.id));
  return row!.id;
}

async function lastUse(computerId: string) {
  const [row] = await getDb().select({
    at: computers.lastUsedAt,
    ip: computers.lastUsedIp,
    userAgent: computers.lastUsedUserAgent,
  }).from(computers).where(eq(computers.id, computerId));
  return row!;
}

test("the first use is written; a second use within the interval writes nothing", async ({ db }) => {
  void db;
  const computerId = await attach();
  const t0 = Date.now();
  await recordComputerUse({ computerId, ip: "10.0.0.1", userAgent: "daemon/1" }, t0);
  const first = await lastUse(computerId);
  assert.equal(first.ip, "10.0.0.1");
  assert.ok(first.at, "the first use sets last_used_at");

  await recordComputerUse({ computerId, ip: "10.0.0.2", userAgent: "daemon/2" }, t0 + 1_000);
  assert.deepEqual(await lastUse(computerId), first, "a use within the interval must not change the row");
});

test("another instance (empty process cache) still skips while the stored use is recent", async ({ db }) => {
  void db;
  const computerId = await attach();
  await recordComputerUse({ computerId, ip: "10.0.0.1", userAgent: "daemon/1" });
  const first = await lastUse(computerId);

  resetComputerUseWriteCacheForTests(); // a different server instance
  await recordComputerUse({ computerId, ip: "10.0.0.3", userAgent: "daemon/3" });
  assert.deepEqual(await lastUse(computerId), first, "the WHERE clause must make the second instance's write a no-op");
});

test("once the stored use is older than the interval, the next use is written", async ({ db }) => {
  void db;
  const computerId = await attach();
  await recordComputerUse({ computerId, ip: "10.0.0.1", userAgent: "daemon/1" });
  await getDb().update(computers)
    .set({ lastUsedAt: sql`now() - make_interval(secs => ${COMPUTER_USE_WRITE_INTERVAL_MS / 1000 + 5})` })
    .where(eq(computers.id, computerId));

  resetComputerUseWriteCacheForTests();
  await recordComputerUse({ computerId, ip: "10.0.0.4", userAgent: "daemon/4" });
  const after = await lastUse(computerId);
  assert.equal(after.ip, "10.0.0.4");
  assert.equal(after.userAgent, "daemon/4");
});
