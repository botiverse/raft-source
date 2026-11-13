import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dbTest as test } from "../test/integration/dbTest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { EXTERNAL_CHANNELS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import * as schema from "../db/schema";
import { channelExternalInvites, featureFlagRules, featureFlags, jointChannelServers, servers, users } from "../db/schema";
import { parkInviteRowsAfterStarts } from "../test/externalInviteFixture";
import { openTestApp as startTestApp } from "../test/integration/app";
import { acceptJointChannelInvite, createChannel, createJointChannel } from "./channelService";
import { acceptExternalInviteAsGuest } from "./externalInviteService";
import { ExternalChannelLimitError } from "./externalChannelLimitService";
import { connectServerWithInvite } from "./externalInviteConnectService";
import { JOINT_LIFECYCLE_LOCK_NAMESPACE } from "./planService";
import { createServer as createServerService } from "./serverService";

// One free server, two channels of hosts with external channels on: an
// ordinary joint invite accept into one and an external connect into the
// other, at once. Both take the server's admission lock first
// (ADMISSION_LOCK_ORDER in planService), so they decide one after the other:
// no deadlock, and the one-external-channel rule refuses the second, in
// either order. The same against a Guest let into one of the server's own
// channels. PGlite runs one transaction at a time and cannot show this.

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

async function untilBlocked(observer: pg.Pool, n: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await observer.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0");
    if ((result.rows[0].n as number) >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`expected ${n} blocked sessions`);
}

function settle<T>(promise: Promise<T>) {
  return promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
}

async function seedUser(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await getDb().insert(users).values({
    email: `${label}-${suffix}@slock.test`,
    name: `${label}-${suffix}`,
    displayName: label,
    passwordHash: "not-used-by-this-test",
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

async function seedServer(label: string, plan: "free" | "pro", owner?: Awaited<ReturnType<typeof seedUser>>) {
  const owned = owner ?? await seedUser(`${label}-owner`);
  const server = await createServerService(`${label} ${randomUUID().slice(0, 8)}`, `${label}-${randomUUID().slice(0, 8)}`, owned.id);
  await getDb().update(servers).set({ plan }).where(eq(servers.id, server.id));
  return { owner: owned, server };
}

async function enableExternalChannels(serverId: string) {
  await getDb().insert(featureFlags)
    .values({ key: EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: false })
    .onConflictDoNothing();
  await getDb().insert(featureFlagRules).values({
    id: randomUUID(), flagKey: EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [serverId],
  });
}

async function activeOn(jointChannelId: string, serverId: string) {
  const rows = await getDb().select().from(jointChannelServers).where(and(
    eq(jointChannelServers.jointChannelId, jointChannelId),
    eq(jointChannelServers.serverId, serverId),
    eq(jointChannelServers.status, "active"),
  ));
  return rows.length > 0;
}

test.skipIf(!REAL_PG_URL && !REAL_PG_REQUIRED)(
  "a free server's ordinary joint invite accept against its external connect, or a Guest let into its own channel, at once: one gets in, the other is refused, no deadlock",
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_joint_accept_connect_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "joint-accept-connect-admin" });
    let setupPool: pg.Pool | undefined;
    let observer: pg.Pool | undefined;
    let holder: pg.PoolClient | undefined;
    let unpark: (() => void) | undefined;
    let app: Awaited<ReturnType<typeof startTestApp>> | undefined;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const testUrl = databaseUrlFor(REAL_PG_URL, databaseName);
      setupPool = new pg.Pool({ connectionString: testUrl, application_name: "joint-accept-connect-setup", max: 2 });
      await migrate(drizzle(setupPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
      await setupPool.end();
      setupPool = undefined;
      app = await startTestApp(testUrl, 0, { humanActivityMuteFlagDefaultEnabled: true });
      observer = new pg.Pool({ connectionString: testUrl, application_name: "joint-accept-connect-observer", max: 2 });

      const hold = async (table: "joint_channel_invites" | "channel_external_invites", id: string) => {
        holder = await observer!.connect();
        await holder.query("BEGIN");
        await holder.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
      };
      /** Holds a joint's lifecycle lock: the external connect queues on it after its admission and ns-3 locks. */
      const holdLifecycle = async (parentJointId: string) => {
        holder = await observer!.connect();
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock($1, $2)", [parseInt(parentJointId.replace(/-/g, "").slice(0, 8), 16) | 0, JOINT_LIFECYCLE_LOCK_NAMESPACE]);
      };
      /**
       * Parks the external connect at its own transaction's invite row lock (the last it takes), once its operation
       * start (initializeInviteSources' short transaction, which locks that row first and nothing else) ended.
       */
      const holdConnection = async (inviteId: string) => {
        holder = await observer!.connect();
        await holder.query("BEGIN");
        unpark = parkInviteRowsAfterStarts(holder, [inviteId]);
      };
      const release = async () => {
        unpark?.();
        unpark = undefined;
        await holder!.query("ROLLBACK");
        holder!.release();
        holder = undefined;
      };

      // "external connect (mid-locks)": the connect is stopped between its
      // ns-3 lock and its joint's lifecycle lock, the accept arrives then.
      // Had the connect taken T's admission lock after ns-3, the accept
      // (holding T's admission lock, waiting for ns-3) and it would deadlock.
      for (const first of ["joint accept", "external connect", "external connect (mid-locks)"] as const) {
        const owner = await seedUser("t-owner");
        const target = await seedServer("t", "free", owner);
        const hostA = await seedServer("host-a", "pro");
        const hostB = await seedServer("host-b", "pro");
        await enableExternalChannels(hostA.server.id);
        await enableExternalChannels(hostB.server.id);
        // A: an ordinary joint invite to T. B: a joint channel with an external invite to T's owner.
        const a = await createJointChannel({
          hostServerId: hostA.server.id,
          createdByUserId: hostA.owner.id,
          name: `a-${randomUUID().slice(0, 8)}`,
          jointInvites: [{ targetServerSlug: target.server.slug, invitedPeople: [owner.email] }],
        });
        // A joint is created with an invite; B's goes to a bystander that never accepts.
        const bystander = await seedServer("bystander", "pro");
        const b = await createJointChannel({
          hostServerId: hostB.server.id,
          createdByUserId: hostB.owner.id,
          name: `b-${randomUUID().slice(0, 8)}`,
          jointInvites: [{ targetServerSlug: bystander.server.slug, invitedPeople: [bystander.owner.email] }],
        });
        const token = randomBytes(32).toString("hex");
        const [external] = await getDb().insert(channelExternalInvites).values({
          channelId: b.channel.id,
          hostServerId: hostB.server.id,
          email: owner.email,
          tokenHash: createHash("sha256").update(token).digest("hex"),
          invitedByUserId: hostB.owner.id,
          expiresAt: new Date(Date.now() + 86_400_000),
        }).returning({ id: channelExternalInvites.id });

        const jointAccept = () => settle(acceptJointChannelInvite({ inviteId: a.invites[0]!.id, targetServerId: target.server.id, acceptedByUserId: owner.id }));
        const externalConnect = () => settle(connectServerWithInvite(token, owner.id, target.server.id));

        // Park the first one on the invite row it writes last: it holds every
        // lock before it, its connection written but not committed. The
        // second must queue (on T's admission lock), not count T as in no
        // external channel next to the uncommitted connection.
        let firstOutcome: ReturnType<typeof jointAccept> | ReturnType<typeof externalConnect>;
        let secondOutcome: ReturnType<typeof jointAccept> | ReturnType<typeof externalConnect>;
        if (first === "joint accept") {
          await hold("joint_channel_invites", a.invites[0]!.id);
          firstOutcome = jointAccept();
          await untilBlocked(observer, 1);
          secondOutcome = externalConnect();
        } else if (first === "external connect") {
          await holdConnection(external!.id);
          firstOutcome = externalConnect();
          await untilBlocked(observer, 1);
          secondOutcome = jointAccept();
        } else {
          await holdLifecycle(b.jointChannel.id);
          firstOutcome = externalConnect();
          await untilBlocked(observer, 1);
          secondOutcome = jointAccept();
        }
        await untilBlocked(observer, 2);
        await release();
        const [one, two] = await Promise.all([firstOutcome, secondOutcome]);
        const describe = (outcome: { ok: boolean; error?: unknown }) => outcome.ok ? "ok"
          : `${String(outcome.error)} (cause: ${String((outcome.error as { cause?: unknown }).cause ?? "")}; code: ${String((outcome.error as { code?: unknown }).code ?? "")})`;
        assert.ok(!/deadlock|40P01/i.test(`${describe(one)} ${describe(two)}`), `${first} first: deadlock: ${describe(one)} / ${describe(two)}`);
        assert.equal(one.ok, true, `${first} first: the first failed: ${describe(one)}`);
        assert.ok(
          !two.ok && two.error instanceof ExternalChannelLimitError && two.error.code === "free_external_limit"
            && two.error.limitSide === "connecting" && two.error.limitServerId === target.server.id,
          `${first} first: the second was not refused by the one-external-channel rule: ${describe(two)}`,
        );
        assert.equal(await activeOn(a.jointChannel.id, target.server.id), first === "joint accept", `${first} first: T in A`);
        assert.equal(await activeOn(b.jointChannel.id, target.server.id), first !== "joint accept", `${first} first: T in B`);
      }

      // A Guest let into one of T's own channels (T's admission lock) against
      // T's joint invite accept: the accept takes the same lock, so whichever
      // commits first makes T's one external channel and the other is refused.
      for (const first of ["guest accept", "joint accept"] as const) {
        const owner = await seedUser("t-owner");
        const target = await seedServer("t", "free", owner);
        await enableExternalChannels(target.server.id);
        const hostA = await seedServer("host-a", "pro");
        await enableExternalChannels(hostA.server.id);
        const a = await createJointChannel({
          hostServerId: hostA.server.id,
          createdByUserId: hostA.owner.id,
          name: `a-${randomUUID().slice(0, 8)}`,
          jointInvites: [{ targetServerSlug: target.server.slug, invitedPeople: [owner.email] }],
        });
        const room = await createChannel(target.server.id, `room-${randomUUID().slice(0, 8)}`, undefined, "private", { type: "user", id: owner.id });
        const guest = await seedUser("guest");
        const token = randomBytes(32).toString("hex");
        const [external] = await getDb().insert(channelExternalInvites).values({
          channelId: room.id,
          hostServerId: target.server.id,
          email: guest.email,
          tokenHash: createHash("sha256").update(token).digest("hex"),
          invitedByUserId: owner.id,
          expiresAt: new Date(Date.now() + 86_400_000),
        }).returning({ id: channelExternalInvites.id });
        const jointAccept = () => settle(acceptJointChannelInvite({ inviteId: a.invites[0]!.id, targetServerId: target.server.id, acceptedByUserId: owner.id }));
        const guestAccept = () => settle(acceptExternalInviteAsGuest(token, guest.id));
        let firstOutcome: Promise<{ ok: boolean; error?: unknown }>;
        let secondOutcome: Promise<{ ok: boolean; error?: unknown }>;
        if (first === "guest accept") {
          await hold("channel_external_invites", external!.id);
          firstOutcome = guestAccept();
          await untilBlocked(observer, 1);
          secondOutcome = jointAccept();
        } else {
          await hold("joint_channel_invites", a.invites[0]!.id);
          firstOutcome = jointAccept();
          await untilBlocked(observer, 1);
          secondOutcome = guestAccept();
        }
        await untilBlocked(observer, 2);
        await release();
        const [one, two] = await Promise.all([firstOutcome, secondOutcome]);
        const describe = (outcome: { ok: boolean; error?: unknown }) => outcome.ok ? "ok"
          : `${String(outcome.error)} (cause: ${String((outcome.error as { cause?: unknown }).cause ?? "")}; code: ${String((outcome.error as { code?: unknown }).code ?? "")})`;
        assert.ok(!/deadlock|40P01/i.test(`${describe(one)} ${describe(two)}`), `${first} first: deadlock: ${describe(one)} / ${describe(two)}`);
        assert.equal(one.ok, true, `${first} first: the first failed: ${describe(one)}`);
        assert.ok(
          !two.ok && two.error instanceof ExternalChannelLimitError && two.error.code === "free_external_limit" && two.error.limitServerId === target.server.id,
          `${first} first: the second was not refused by the one-external-channel rule: ${describe(two)}`,
        );
        assert.equal(await activeOn(a.jointChannel.id, target.server.id), first === "joint accept", `${first} first: T in A`);
      }
    } finally {
      unpark?.();
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
  120_000,
);
