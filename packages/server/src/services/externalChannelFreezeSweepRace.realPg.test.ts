import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dbTest as test } from "../test/integration/dbTest";
import { and, eq } from "drizzle-orm";
import { describe } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { EXTERNAL_CHANNELS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import * as schema from "../db/schema";
import { externalFreezeLaunchBackfill, featureFlagRules, featureFlags, serverExternalFreezes, servers, users } from "../db/schema";
import { openTestApp as startTestApp } from "../test/integration/app";
import { acceptJointChannelInvite, addHuman, archiveChannel, createChannel, createJointChannel } from "./channelService";
import { __setExternalFreezeProbeForTests, reconcileExternalFreezeForBillingChange, sweepExternalChannelFreezes } from "./externalChannelFreezeService";
import { createServer as createServerService, transitionMemberRole } from "./serverService";
import { countExternalChannelsOfServer, getExternalFreezeOfChannel } from "./externalChannelFreezeState";
import { seedBoundGuest } from "../test/guestFixture";

// The free plan's external channel freeze, sweep against a joint accept on
// real PostgreSQL: the sweep counts a server under that server's admission
// lock, and an ordinary joint accept takes the admission locks of the
// connecting server and of the joint's host, so a sweep stopped right after
// counting cannot write a stale answer over the accept that makes the server
// over (as the connecting server, or as the host). No deadlock either.
// Also: an accept first against the sweep on the host, a joint accept against
// a role change on the free host (either order), and an archive's reconcile
// against a downgrade (eligibility read under the freeze row lock).
// Each scenario is its own test on its own fresh database.
// PGlite runs one transaction at a time and cannot show this.

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

/** What the blocked session of this database waits on (pg_stat_activity.wait_event). */
async function blockedWaitEvent(observer: pg.Pool): Promise<string> {
  const result = await observer.query("SELECT wait_event FROM pg_stat_activity WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0 LIMIT 1");
  return String(result.rows[0]?.wait_event ?? "none");
}

async function freezeRow(serverId: string) {
  const [row] = await getDb().select().from(serverExternalFreezes).where(eq(serverExternalFreezes.serverId, serverId));
  return row ?? null;
}

/** Joint hosted by `host`, invite to `target` (not accepted). */
async function jointInvite(host: Awaited<ReturnType<typeof seedServer>>, target: Awaited<ReturnType<typeof seedServer>>) {
  return createJointChannel({
    hostServerId: host.server.id,
    createdByUserId: host.owner.id,
    name: `j-${randomUUID().slice(0, 8)}`,
    jointInvites: [{ targetServerSlug: target.server.slug, invitedPeople: [target.owner.email] }],
  });
}

type Outcome = { ok: boolean; error?: unknown };

function describeOutcome(outcome: Outcome): string {
  return outcome.ok ? "ok"
    : `${String(outcome.error)} (cause: ${String((outcome.error as { cause?: unknown }).cause ?? "")}; code: ${String((outcome.error as { code?: unknown }).code ?? "")})`;
}

/**
 * A fresh database for one scenario: created and migrated, the app opened on
 * it, an observer pool for pg_stat_activity probes, the freeze launch
 * backfill marked done. Everything is closed and the database dropped in
 * `finally`, and the freeze probe is reset, whatever the scenario did.
 */
async function withFreshDatabase(label: string, body: (observer: pg.Pool) => Promise<void>): Promise<void> {
  assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
  const databaseName = `slock_external_freeze_${label}_${process.pid}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "external-freeze-sweep-admin" });
  let setupPool: pg.Pool | undefined;
  let observer: pg.Pool | undefined;
  let app: Awaited<ReturnType<typeof startTestApp>> | undefined;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    const testUrl = databaseUrlFor(REAL_PG_URL, databaseName);
    setupPool = new pg.Pool({ connectionString: testUrl, application_name: "external-freeze-sweep-setup", max: 2 });
    await migrate(drizzle(setupPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
    await setupPool.end();
    setupPool = undefined;
    app = await startTestApp(testUrl, 0, { humanActivityMuteFlagDefaultEnabled: true });
    observer = new pg.Pool({ connectionString: testUrl, application_name: "external-freeze-sweep-observer", max: 4 });
    await getDb().insert(externalFreezeLaunchBackfill).values({ id: 1, launchAt: new Date(), completedAt: new Date() });
    await body(observer);
  } finally {
    __setExternalFreezeProbeForTests(null);
    if (app) await app.close();
    if (observer) await observer.end();
    if (setupPool) await setupPool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`).catch(() => {});
    await admin.end();
  }
}

/**
 * The sweep, stopped once it has counted `serverId` (under its admission
 * lock, its freeze row locked), until `release`.
 */
async function sweepStoppedAfterCounting(serverId: string) {
  let counted!: () => void;
  const countedPromise = new Promise<void>((resolve) => { counted = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let armed = true;
  __setExternalFreezeProbeForTests(async (event) => {
    if (!armed || event.phase !== "counted" || event.serverId !== serverId) return;
    armed = false;
    assert.equal(event.over, false, "the sweep counts the server not over yet");
    counted();
    await released;
  });
  const sweep = settle(sweepExternalChannelFreezes());
  await countedPromise;
  return { sweep, release };
}

/**
 * Sweep first: the sweep is stopped after counting `subject` (not over), then
 * `accept` (which makes the subject over) runs. The accept queues behind the
 * sweep's admission lock on the subject (an advisory lock), not only behind
 * its freeze row; once released, both commit and the freeze row stays.
 */
async function sweepFirstThenAccept(
  observer: pg.Pool,
  side: "connecting" | "host",
  subject: Awaited<ReturnType<typeof seedServer>>,
  accept: () => Promise<unknown>,
): Promise<void> {
  // A stale row, so the sweep has a reason to reconcile the server (and would delete it).
  await getDb().insert(serverExternalFreezes).values({ serverId: subject.server.id, freezeAt: new Date(Date.now() - 1000) });

  const { sweep, release } = await sweepStoppedAfterCounting(subject.server.id);
  const accepted = settle(accept());
  // Whatever happens, the sweep is released, so a failure is an assertion, not a hang.
  let waitedOn: string;
  try {
    waitedOn = await Promise.race([
      accepted.then(() => "finished first"),
      untilBlocked(observer, 1).then(() => blockedWaitEvent(observer), () => "never blocked"),
    ]);
  } finally {
    release();
  }
  const [sweepOutcome, acceptOutcome] = await Promise.all([sweep, accepted]);
  __setExternalFreezeProbeForTests(null);
  assert.ok(!/deadlock|40P01/i.test(`${describeOutcome(sweepOutcome)} ${describeOutcome(acceptOutcome)}`), `${side}: deadlock`);
  assert.equal(sweepOutcome.ok, true, `${side}: sweep ${describeOutcome(sweepOutcome)}`);
  assert.equal(acceptOutcome.ok, true, `${side}: accept ${describeOutcome(acceptOutcome)}`);
  const row = await freezeRow(subject.server.id);
  assert.ok(row, `${side}: the server the accept made over has its freeze row`);
  assert.equal(waitedOn, "advisory", `${side}: the accept waited on the sweep's admission lock`);
}

/**
 * A free host (flag on) with a Guest channel, hosting a joint invite to a pro
 * peer no peer has accepted yet; first peer in makes the host over.
 */
async function seedFreeHostWithGuestChannelAndJointInvite(hostLabel: string, peerLabel: string) {
  const host = await seedServer(hostLabel, "free");
  await enableExternalChannels(host.server.id);
  const room = await createChannel(host.server.id, `room-${randomUUID().slice(0, 8)}`, undefined, "private", { type: "user", id: host.owner.id });
  await seedBoundGuest({ serverId: host.server.id, userId: (await seedUser("guest")).id, channelId: room.id });
  const peer = await seedServer(peerLabel, "pro");
  const joint = await jointInvite(host, peer);
  return { host, peer, joint };
}

/**
 * No foreign key from the freeze row to servers (Cody's 40P01): a joint
 * accept writing the free host's freeze row (first peer into the host's
 * joint, the host with a Guest channel) against a role change on the host,
 * which holds the host's servers row FOR UPDATE. Joint human membership on:
 * the accept and the role change share its membership lock. The member is in
 * the joint (the host's side), so the role change revalidates its joint
 * membership.
 */
async function seedRoleChangeVsAccept() {
  const host = await seedServer("hr", "free");
  await enableExternalChannels(host.server.id);
  const member = await seedUser("hr-member");
  await getDb().insert(schema.serverMembers).values({ serverId: host.server.id, userId: member.id, role: "member" });
  const room = await createChannel(host.server.id, `room-${randomUUID().slice(0, 8)}`, undefined, "private", { type: "user", id: host.owner.id });
  await seedBoundGuest({ serverId: host.server.id, userId: (await seedUser("guest")).id, channelId: room.id });
  const peer = await seedServer("pr", "pro");
  const joint = await jointInvite(host, peer);
  await addHuman(joint.channel.id, member.id);
  const accept = () => settle(acceptJointChannelInvite({ inviteId: joint.invites[0]!.id, targetServerId: peer.server.id, acceptedByUserId: peer.owner.id }));
  const roleChange = () => settle(transitionMemberRole({ serverId: host.server.id, actorUserId: host.owner.id, targetUserId: member.id, nextRole: "admin" }));
  return { host, member, accept, roleChange };
}

/** Either order: no deadlock, both commit, the host keeps its freeze row, the role change landed. */
async function assertRoleChangeAndAcceptBothCommitted(first: "accept" | "role change", hostServerId: string, memberId: string, outcomes: Outcome[]) {
  const summary = outcomes.map(describeOutcome).join(" / ");
  assert.ok(!/deadlock|40P01/i.test(summary), `${first} first: deadlock: ${summary}`);
  assert.ok(outcomes.every((outcome) => outcome.ok), `${first} first: ${summary}`);
  assert.ok(await freezeRow(hostServerId), `${first} first: the host keeps its freeze row`);
  const [role] = await getDb().select({ role: schema.serverMembers.role }).from(schema.serverMembers)
    .where(and(eq(schema.serverMembers.serverId, hostServerId), eq(schema.serverMembers.userId, memberId)));
  assert.equal(role?.role, "admin", `${first} first: the role change committed`);
}

const realPgTest = test.skipIf(!REAL_PG_URL && !REAL_PG_REQUIRED);
const TIMEOUT_MS = 120_000;

describe("external channel freeze races on real PostgreSQL", () => {
  realPgTest(
    "sweep first, the connecting (target) server goes over: the accept waits on the sweep's admission lock; the freeze row stays; no deadlock",
    async () => {
      await withFreshDatabase("sweep_target", async (observer) => {
        // S (free, flag on) is in one joint; a second joint's invite makes it over.
        const subject = await seedServer("s", "free");
        await enableExternalChannels(subject.server.id);
        const first = await seedServer("h1", "pro");
        const one = await jointInvite(first, subject);
        await acceptJointChannelInvite({ inviteId: one.invites[0]!.id, targetServerId: subject.server.id, acceptedByUserId: subject.owner.id });
        const second = await seedServer("h2", "pro");
        const two = await jointInvite(second, subject);
        await sweepFirstThenAccept(observer, "connecting", subject,
          () => acceptJointChannelInvite({ inviteId: two.invites[0]!.id, targetServerId: subject.server.id, acceptedByUserId: subject.owner.id }));
      });
    },
    TIMEOUT_MS,
  );

  realPgTest(
    "sweep first, the host goes over: the accept waits on the sweep's admission lock on the host; the freeze row stays; no deadlock",
    async () => {
      await withFreshDatabase("sweep_host", async (observer) => {
        // H (free, flag on) has a Guest channel and hosts a joint no peer has joined; a new peer makes it over.
        const { host, peer, joint } = await seedFreeHostWithGuestChannelAndJointInvite("h", "p");
        await sweepFirstThenAccept(observer, "host", host,
          () => acceptJointChannelInvite({ inviteId: joint.invites[0]!.id, targetServerId: peer.server.id, acceptedByUserId: peer.owner.id }));
      });
    },
    TIMEOUT_MS,
  );

  realPgTest(
    "accept first, the host goes over (Cody): the sweep waits on the accept's admission lock on the host; the freeze row stays",
    async () => {
      // A free host with a Guest channel and a freeze row kept; a new peer
      // accepts the host's first joint and is stopped at its last write (the
      // invite row). A reconcile of the host (the sweep) then queues behind
      // the accept's admission lock on the host, and counts once the accept
      // has committed: the row stays.
      await withFreshDatabase("accept_host", async (observer) => {
        const { host, peer, joint } = await seedFreeHostWithGuestChannelAndJointInvite("hk", "pk");
        await getDb().insert(serverExternalFreezes).values({ serverId: host.server.id, freezeAt: new Date(Date.now() - 1000) });
        const holder = await observer.connect();
        let outcomes: Outcome[] = [];
        let sweepWaitedOn = "none";
        try {
          await holder.query("BEGIN");
          await holder.query("SELECT id FROM joint_channel_invites WHERE id = $1 FOR UPDATE", [joint.invites[0]!.id]);
          const accepted = settle(acceptJointChannelInvite({ inviteId: joint.invites[0]!.id, targetServerId: peer.server.id, acceptedByUserId: peer.owner.id }));
          await untilBlocked(observer, 1);
          const sweep = settle(sweepExternalChannelFreezes());
          await untilBlocked(observer, 2).catch(() => {});
          const waits = await observer.query("SELECT wait_event FROM pg_stat_activity WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0 AND wait_event = 'advisory'");
          sweepWaitedOn = waits.rows.length > 0 ? "advisory" : "other";
          await holder.query("ROLLBACK");
          outcomes = await Promise.all([accepted, sweep]);
        } finally {
          await holder.query("ROLLBACK").catch(() => {});
          holder.release();
        }
        assert.ok(outcomes.every((outcome) => outcome.ok), `host (accept stopped): ${outcomes.map(describeOutcome).join(" / ")}`);
        assert.ok(await freezeRow(host.server.id), "host (accept stopped): the host the accept made over keeps its freeze row");
        assert.equal(sweepWaitedOn, "advisory", "host (accept stopped): the sweep waited on the accept's admission lock on the host");
      });
    },
    TIMEOUT_MS,
  );

  realPgTest(
    "joint accept vs transitionMemberRole on the free host, accept first: no deadlock (no FK from the freeze row), both commit, the host keeps its freeze row",
    async () => {
      await withFreshDatabase("role_accept_first", async (observer) => {
        const { host, member, accept, roleChange } = await seedRoleChangeVsAccept();
        // The accept stopped once it has counted the host (its locks held), before it writes the host's row.
        let counted!: () => void;
        const countedPromise = new Promise<void>((resolve) => { counted = resolve; });
        let release!: () => void;
        const released = new Promise<void>((resolve) => { release = resolve; });
        let armed = true;
        __setExternalFreezeProbeForTests(async (event) => {
          if (!armed || event.phase !== "counted" || event.serverId !== host.server.id) return;
          armed = false;
          counted();
          await released;
        });
        const accepted = accept();
        let changed: Promise<Outcome> | undefined;
        try {
          await countedPromise;
          changed = roleChange();
          const roleChangeBlocked = await untilBlocked(observer, 1, 3_000).then(() => true, () => false);
          console.error(`[freeze-role] accept first: role change blocked behind the accept: ${roleChangeBlocked}`);
        } finally {
          release();
        }
        const outcomes = await Promise.all([accepted, changed!]);
        __setExternalFreezeProbeForTests(null);
        await assertRoleChangeAndAcceptBothCommitted("accept", host.server.id, member.id, outcomes);
      });
    },
    TIMEOUT_MS,
  );

  realPgTest(
    "transitionMemberRole first vs joint accept on the free host: no deadlock (no FK from the freeze row), both commit, the host keeps its freeze row",
    async () => {
      await withFreshDatabase("role_change_first", async (observer) => {
        const { host, member, accept, roleChange } = await seedRoleChangeVsAccept();
        // The role change stopped on the target's member row, the host's servers row FOR UPDATE held.
        const holder = await observer.connect();
        let outcomes: Outcome[];
        try {
          await holder.query("BEGIN");
          await holder.query("SELECT user_id FROM server_members WHERE server_id = $1 AND user_id = $2 FOR UPDATE", [host.server.id, member.id]);
          const changed = roleChange();
          await untilBlocked(observer, 1);
          const accepted = accept();
          await untilBlocked(observer, 2, 3_000).catch(() => {});
          await holder.query("ROLLBACK");
          outcomes = await Promise.all([accepted, changed]);
        } finally {
          await holder.query("ROLLBACK").catch(() => {});
          holder.release();
        }
        await assertRoleChangeAndAcceptBothCommitted("role change", host.server.id, member.id, outcomes);
      });
    },
    TIMEOUT_MS,
  );

  realPgTest(
    "archive reconcile paused vs downgrade freeze: eligibility (plan, flag, count) is read under the freeze row lock, so the downgrade's row stays",
    async () => {
      // Cody's eligibility case: a paid server with three Guest channels
      // archives one; its reconcile is stopped before it reads anything. A
      // downgrade to Free meanwhile writes the freeze row (billing hook). The
      // archive ends the archived channel's Guest first, under the servers row
      // (FOR SHARE, as any removal), so the downgrade's plan write queues behind
      // the archive's commit and its reconcile counts after it: Free with two
      // external channels, so the row is written and stays. Either way no
      // reconcile may leave a free server over its limit without its row.
      await withFreshDatabase("archive_downgrade", async (observer) => {
        const paid = await seedServer("pa", "pro");
        await enableExternalChannels(paid.server.id);
        const rooms = [];
        for (let i = 0; i < 3; i++) {
          const room = await createChannel(paid.server.id, `room-${randomUUID().slice(0, 8)}`, undefined, "private", { type: "user", id: paid.owner.id });
          await seedBoundGuest({ serverId: paid.server.id, userId: (await seedUser("guest")).id, channelId: room.id });
          rooms.push(room);
        }
        assert.equal(await freezeRow(paid.server.id), null);
        let started!: () => void;
        const startedPromise = new Promise<void>((resolve) => { started = resolve; });
        let release!: () => void;
        const released = new Promise<void>((resolve) => { release = resolve; });
        let armed = true;
        __setExternalFreezeProbeForTests(async (event) => {
          if (!armed || event.phase !== "start" || event.serverId !== paid.server.id) return;
          armed = false;
          started();
          await released;
        });
        const archived = settle(archiveChannel(rooms[2]!.id, paid.owner.id));
        let downgraded: Promise<Awaited<ReturnType<typeof reconcileExternalFreezeForBillingChange>>> | undefined;
        try {
          await startedPromise;
          downgraded = (async () => {
            await getDb().update(servers).set({ plan: "free" }).where(eq(servers.id, paid.server.id));
            return reconcileExternalFreezeForBillingChange(paid.server.id);
          })();
          // The plan write waits on the archive's lock of the servers row.
          await untilBlocked(observer, 1).catch(() => {});
        } finally {
          release();
        }
        const outcome = await archived;
        const downgrade = await downgraded;
        __setExternalFreezeProbeForTests(null);
        assert.equal(downgrade, "frozen", "the downgrade, counted after the archive, froze the server");
        assert.equal(outcome.ok, true, `archive: ${outcome.ok ? "" : String(outcome.error)}`);
        assert.ok(await freezeRow(paid.server.id), "free with two external channels: the archive's reconcile keeps the downgrade's row");
        assert.equal(await countExternalChannelsOfServer(getDb(), paid.server.id), 2);
        assert.ok(await getExternalFreezeOfChannel(rooms[0]!.id, paid.server.id), "and the gate refuses its writes");
      });
    },
    TIMEOUT_MS,
  );
});
