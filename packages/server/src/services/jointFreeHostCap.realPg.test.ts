import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dbTest as test } from "../test/integration/dbTest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { getDb } from "../db/index";
import * as schema from "../db/schema";
import { servers, users } from "../db/schema";
import { openTestApp as startTestApp } from "../test/integration/app";
import { acceptJointChannelInvite, createJointChannel } from "./channelService";
import { countHostedJointChannels, JointChannelLimitError } from "./jointChannelLimitService";
import { createServer as createServerService } from "./serverService";

// A free server may host one joint another server has joined. The check runs
// when the first other server joins, under the joining server's own lock, so
// two servers joining two different lone joints of the same free host hold
// different locks; only the shared JOINT_HOST lock stops both from seeing
// zero joined joints. PGlite runs one transaction at a time and cannot show
// this; real PG can.

const REAL_PG_URL_ENV = "CHANNEL_CONVERSION_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.CHANNEL_CONVERSION_REAL_PG_REQUIRED === "1";
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

async function blockedCount(observer: pg.Pool): Promise<number> {
  const result = await observer.query(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0",
  );
  return result.rows[0].n as number;
}

/** Resolves once `n` sessions are blocked, or `settled` resolves first. */
async function untilBlockedOrSettled(observer: pg.Pool, n: number, settled: Promise<unknown>, timeoutMs = 5_000): Promise<"blocked" | "settled"> {
  let done = false;
  void settled.finally(() => { done = true; });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done) return "settled";
    if (await blockedCount(observer) >= n) return "blocked";
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`expected ${n} blocked sessions`);
}

async function seedServer(label: string, plan: "free" | "founder") {
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await getDb().insert(users).values({
    email: `${label}-${suffix}@slock.test`,
    name: `${label}-${suffix}`,
    displayName: label,
    passwordHash: "not-used-by-this-test",
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServerService(`${label} ${suffix}`, `${label}-${suffix}`, owner.id);
  await getDb().update(servers).set({ plan }).where(eq(servers.id, server.id));
  return { owner, server };
}

test.skipIf(!REAL_PG_URL && !REAL_PG_REQUIRED)(
  "two servers joining two lone joints of one free host at once: exactly one gets in",
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_joint_free_host_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "joint-free-host-admin" });
    let setupPool: pg.Pool | undefined;
    let observer: pg.Pool | undefined;
    let holder: pg.PoolClient | undefined;
    let app: Awaited<ReturnType<typeof startTestApp>> | undefined;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const testUrl = databaseUrlFor(REAL_PG_URL, databaseName);
      setupPool = new pg.Pool({ connectionString: testUrl, application_name: "joint-free-host-setup", max: 2 });
      await migrate(drizzle(setupPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
      await setupPool.end();
      setupPool = undefined;
      app = await startTestApp(testUrl, 0, { humanActivityMuteFlagDefaultEnabled: true });
      observer = new pg.Pool({ connectionString: testUrl, application_name: "joint-free-host-observer", max: 2 });

      const host = await seedServer("host", "free");
      const x = await seedServer("x", "founder");
      const y = await seedServer("y", "founder");
      const createFor = (target: Awaited<ReturnType<typeof seedServer>>) => createJointChannel({
        hostServerId: host.server.id,
        createdByUserId: host.owner.id,
        name: `joint-${randomUUID().slice(0, 8)}`,
        jointInvites: [{ targetServerSlug: target.server.slug, invitedPeople: [target.owner.email] }],
      });
      const a = await createFor(x);
      const b = await createFor(y);
      const acceptAs = (inviteId: string, target: Awaited<ReturnType<typeof seedServer>>) =>
        acceptJointChannelInvite({ inviteId, targetServerId: target.server.id, acceptedByUserId: target.owner.id }).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );

      // Park X's accept after it inserted its projection but before commit:
      // it marks its invite accepted last, so hold that row.
      holder = await observer.connect();
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM joint_channel_invites WHERE id = $1 FOR UPDATE", [a.invites[0]!.id]);
      const xAccept = acceptAs(a.invites[0]!.id, x);
      assert.equal(await untilBlockedOrSettled(observer, 1, xAccept), "blocked", "X's accept should wait on the held invite row");

      // Y's accept of B must wait for X's transaction instead of counting
      // zero joined joints next to X's uncommitted projection.
      const yAccept = acceptAs(b.invites[0]!.id, y);
      const yState = await untilBlockedOrSettled(observer, 2, yAccept);
      await holder.query("ROLLBACK");
      holder.release();
      holder = undefined;

      const [xOutcome, yOutcome] = await Promise.all([xAccept, yAccept]);
      assert.equal(xOutcome.ok, true, `X's accept failed: ${!xOutcome.ok && String(xOutcome.error)}`);
      assert.equal(yOutcome.ok, false, `Y got in too (Y ${yState} while X was uncommitted)`);
      assert.ok(
        !yOutcome.ok && yOutcome.error instanceof JointChannelLimitError && yOutcome.error.code === "joint_channel_free_limit_reached",
        `Y was rejected with the wrong error: ${!yOutcome.ok && String(yOutcome.error)}`,
      );
      assert.equal(await countHostedJointChannels(getDb(), host.server.id), 1);
    } finally {
      if (holder) {
        await holder.query("ROLLBACK").catch(() => {});
        holder.release();
      }
      if (app) await app.close();
      if (observer) await observer.end();
      if (setupPool) await setupPool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`).catch(() => {});
      await admin.end();
    }
  },
  60_000,
);
