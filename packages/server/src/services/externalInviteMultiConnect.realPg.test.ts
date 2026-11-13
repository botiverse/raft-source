import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { EXTERNAL_CHANNELS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { test } from "vitest";
import { parkInviteRowsAfterStarts } from "../test/externalInviteFixture";
import { getDb } from "../db/index";
import * as schema from "../db/schema";
import { channelExternalInvites, channelServerConnectRequests, featureFlagRules, featureFlags, jointChannelServers, serverMembers, servers, users } from "../db/schema";
import { openTestApp as startTestApp } from "../test/integration/app";
import { createChannel } from "./channelService";
import { runChannelConversionJob, startChannelToJointConversion } from "./channelConversionService";
import { advanceExternalConnect, approveServerConnectRequest, connectServersWithInvite, type ServerConnectOutcome } from "./externalInviteConnectService";
import { createServer } from "./serverService";

// Several servers connected with one external invite (#wg-rbac:#16
// multi-connect) against what races them on that invite. PGlite runs one
// transaction at a time; real PG shows the waits. Each case parks a
// transaction on the invite row (the last lock a connection takes) while the
// writers hold everything before it, then checks each decides against what
// the other committed: no write of one undoes the other's.

const REAL_PG_URL_ENV = "EXTERNAL_INVITE_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.EXTERNAL_INVITE_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

function databaseUrlFor(adminUrl: string, databaseName: string): string {
  const parsed = new URL(adminUrl);
  assert.match(parsed.protocol, /^postgres(?:ql)?:$/, `${REAL_PG_URL_ENV} must be a PostgreSQL URL`);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

async function untilBlocked(observer: pg.Pool, n: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await observer.query("SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0");
    if (result.rows.length >= n) return;
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

/** A paid server (free-plan caps are not what these cases test), with external channels on for it. */
async function seedServer(label: string, owner?: Awaited<ReturnType<typeof seedUser>>) {
  const owned = owner ?? await seedUser(`${label}-owner`);
  const server = await createServer(label, `${label}-${randomUUID().slice(0, 8)}`, owned.id);
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, server.id));
  await getDb().insert(featureFlags)
    .values({ key: EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: false })
    .onConflictDoNothing();
  await getDb().insert(featureFlagRules).values({
    id: randomUUID(), flagKey: EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [server.id],
  });
  const channel = () => createChannel(server.id, `room-${randomUUID().slice(0, 8)}`, undefined, "private", { type: "user", id: owned.id });
  return { owner: owned, server, channel };
}

type Host = Awaited<ReturnType<typeof seedServer>>;

async function seedInvite(host: Host, channelId: string, email: string) {
  const token = randomBytes(32).toString("hex");
  const [row] = await getDb().insert(channelExternalInvites).values({
    channelId,
    hostServerId: host.server.id,
    email,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    invitedByUserId: host.owner.id,
    expiresAt: new Date(Date.now() + 86_400_000),
  }).returning({ id: channelExternalInvites.id });
  return { id: row!.id, token };
}

async function inviteRow(id: string) {
  const [row] = await getDb().select().from(channelExternalInvites).where(eq(channelExternalInvites.id, id));
  return row!;
}

async function isActiveIn(hostChannelId: string, serverId: string): Promise<boolean> {
  const [host] = await getDb().select({ jointChannelId: jointChannelServers.jointChannelId }).from(jointChannelServers)
    .where(eq(jointChannelServers.localChannelId, hostChannelId));
  if (!host) return false;
  const rows = await getDb().select().from(jointChannelServers).where(and(
    eq(jointChannelServers.jointChannelId, host.jointChannelId),
    eq(jointChannelServers.serverId, serverId),
    eq(jointChannelServers.status, "active"),
  ));
  return rows.length === 1;
}

const stateOf = (outcomes: readonly ServerConnectOutcome[], serverId: string) => outcomes.find((outcome) => outcome.serverId === serverId)?.state;

test.skipIf(!REAL_PG_URL && !REAL_PG_REQUIRED)(
  "one invite, several servers: an approval against the worker connecting a queued server, and two choices of the same invite at once",
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_external_multi_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "external-multi-admin" });
    let setupPool: pg.Pool | undefined;
    let observer: pg.Pool | undefined;
    let holder: pg.PoolClient | undefined;
    let unpark: (() => void) | undefined;
    let app: Awaited<ReturnType<typeof startTestApp>> | undefined;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const testUrl = databaseUrlFor(REAL_PG_URL, databaseName);
      setupPool = new pg.Pool({ connectionString: testUrl, application_name: "external-multi-setup", max: 2 });
      await migrate(drizzle(setupPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
      await setupPool.end();
      setupPool = undefined;
      app = await startTestApp(testUrl, 0, { humanActivityMuteFlagDefaultEnabled: true });
      observer = new pg.Pool({ connectionString: testUrl, application_name: "external-multi-observer", max: 4 });

      const park = async (inviteId: string) => {
        holder = await observer!.connect();
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM channel_external_invites WHERE id = $1 FOR UPDATE", [inviteId]);
      };
      /** The same, for connections: parked at their own transaction's invite row lock once their operation starts (which lock that row first, alone) ended. */
      const parkConnections = async (starts: number, inviteId: string) => {
        holder = await observer!.connect();
        await holder.query("BEGIN");
        unpark = parkInviteRowsAfterStarts(holder, [inviteId], starts);
      };
      const release = async () => {
        unpark?.();
        unpark = undefined;
        await holder!.query("ROLLBACK");
        holder!.release();
        holder = undefined;
      };

      // A private channel: two servers the invitee owns and one they ask an
      // owner of. The first connects after the conversion; then the worker
      // connects the queued second while the approver approves the third.
      // Both hold everything but the invite row (parked); each commits on
      // what the other committed: all three in, the queue drained, the
      // request approved, the invite accepted once the last is done.
      {
        const host = await seedServer("queue-host");
        const room = await host.channel();
        const invitee = await seedUser("invitee");
        const first = await seedServer("first", invitee);
        const second = await seedServer("second", invitee);
        const approver = await seedUser("approver");
        const third = await seedServer("third", approver);
        await getDb().insert(serverMembers).values({ serverId: third.server.id, userId: invitee.id, role: "member" });
        const invite = await seedInvite(host, room.id, invitee.email);

        const chosen = await connectServersWithInvite(invite.token, invitee.id, [
          { serverId: first.server.id },
          { serverId: second.server.id },
          { serverId: third.server.id, approverUserId: approver.id },
        ]);
        assert.deepEqual(chosen.servers.map((outcome) => outcome.state), ["connecting", "connecting", "awaiting_approval"]);
        const reserved = await inviteRow(invite.id);
        assert.ok(reserved.connectConversionJobId);
        assert.equal((await runChannelConversionJob(reserved.connectConversionJobId)).status, "done");
        assert.equal((await advanceExternalConnect(invite.id))?.targetServerId, first.server.id);
        const queued = await inviteRow(invite.id);
        assert.deepEqual({ status: queued.status, head: queued.connectServerId, queue: queued.connectQueuedServerIds }, { status: "connecting", head: second.server.id, queue: [] });
        const [request] = await getDb().select().from(channelServerConnectRequests).where(eq(channelServerConnectRequests.inviteId, invite.id));

        await park(invite.id);
        const worker = settle(advanceExternalConnect(invite.id));
        const approving = settle(approveServerConnectRequest(request!.id, approver.id));
        // The worker waits on the invite row; the approval waits on the host's admission lock the worker holds.
        await untilBlocked(observer, 2);
        await release();
        const [connected, approved] = await Promise.all([worker, approving]);
        assert.equal(connected.ok && connected.value?.targetServerId, second.server.id, `worker: ${!connected.ok && String(connected.error)}`);
        assert.equal(approved.ok && approved.value.state, "connected", `approve: ${!approved.ok && String(approved.error)}`);
        for (const server of [first, second, third]) assert.equal(await isActiveIn(room.id, server.server.id), true, server.server.name);
        const done = await inviteRow(invite.id);
        assert.deepEqual(
          { status: done.status, outcome: done.outcome, acceptedServerId: done.acceptedServerId, queue: done.connectQueuedServerIds },
          { status: "accepted", outcome: "server", acceptedServerId: first.server.id, queue: [] },
        );
        const [decided] = await getDb().select().from(channelServerConnectRequests).where(eq(channelServerConnectRequests.id, request!.id));
        assert.equal(decided?.status, "approved");
      }

      // The same invite chosen twice at once (two tabs) on a joint channel,
      // two different servers each: one choice commits first; the other
      // decides on the invite it left (already used), so the invite is
      // accepted with one server and never written back to open.
      {
        const host = await seedServer("twice-host");
        const room = await host.channel();
        const job = await startChannelToJointConversion({ serverId: host.server.id, sourceChannelId: room.id, createdByUserId: host.owner.id });
        assert.equal((await runChannelConversionJob(job.id)).status, "done");
        const invitee = await seedUser("twice");
        const a = await seedServer("a", invitee);
        const b = await seedServer("b", invitee);
        const invite = await seedInvite(host, room.id, invitee.email);

        await parkConnections(2, invite.id);
        const one = settle(connectServersWithInvite(invite.token, invitee.id, [{ serverId: a.server.id }]));
        const two = settle(connectServersWithInvite(invite.token, invitee.id, [{ serverId: b.server.id }]));
        await untilBlocked(observer, 2);
        await release();
        const [first, second] = await Promise.all([one, two]);
        assert.ok(first.ok && second.ok, `${!first.ok && String(first.error)} ${!second.ok && String(second.error)}`);
        if (!first.ok || !second.ok) return;
        const states = [stateOf(first.value.servers, a.server.id), stateOf(second.value.servers, b.server.id)].sort();
        assert.deepEqual(states, ["connected", "refused"]);
        const winner = stateOf(first.value.servers, a.server.id) === "connected" ? a : b;
        const loser = winner === a ? b : a;
        assert.equal(await isActiveIn(room.id, winner.server.id), true);
        assert.equal(await isActiveIn(room.id, loser.server.id), false);
        const done = await inviteRow(invite.id);
        assert.deepEqual({ status: done.status, acceptedServerId: done.acceptedServerId }, { status: "accepted", acceptedServerId: winner.server.id });
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
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`).catch(() => {});
      await admin.end();
    }
  },
  600_000,
);
