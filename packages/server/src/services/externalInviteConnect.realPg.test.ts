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
import { channelConversionJobs, channelExternalInvites, channels, featureFlagRules, featureFlags, jointChannelServers, serverMembers, servers, users } from "../db/schema";
import { openTestApp as startTestApp } from "../test/integration/app";
import { acceptJointChannelInvite, acceptJointChannelInvites, archiveChannel, JointChannelArchivedError, updateChannel, createChannel, createJointChannelInvite, disconnectJointChannel, resendPendingJointChannelInvites } from "./channelService";
import { withLockedChannelActorCapabilities, withLockedChannelActorCapability } from "../lib/channelActorPermissions";
import { cancelChannelConversionJob, runChannelConversionJob, startChannelToJointConversion } from "./channelConversionService";
import { acceptExternalInviteAsGuest, ExternalInviteAcceptError } from "./externalInviteService";
import { __setExternalConnectSettleBarrierForTests, advanceExternalConnect, approveServerConnectRequest, connectServerWithInvite, ExternalConnectError, requestServerConnectApproval } from "./externalInviteConnectService";
import { setFeatureFlagKillSwitch } from "./featureFlagService";
import { cleanJointMembershipDepartureBatch, type JointMembershipDepartureId } from "./jointMembershipDeparture";
import { createServer } from "./serverService";

// Connecting a server with an external invite against what races it
// (#wg-rbac:#16, P2a-3, Cody). PGlite runs one transaction at a time; real PG
// shows the waits. Each case parks a transaction on the invite row (the last
// lock a connection takes) while it holds everything before it, then checks
// the other side waits for it and decides against its committed result.

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

async function blockedPids(observer: pg.Pool): Promise<number[]> {
  const result = await observer.query("SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0");
  return result.rows.map((row: { pid: number }) => row.pid);
}

async function untilBlocked(observer: pg.Pool, n: number, timeoutMs = 10_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pids = await blockedPids(observer);
    if (pids.length >= n) return pids;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`expected ${n} blocked sessions`);
}

/**
 * Pauses the first query the app sends that the armed matcher accepts, at the
 * driver (as Cody's scripts do): the transaction holds everything it took so
 * far and the query itself runs unchanged once released. The hook is
 * installed on pg.Client before the app opens its pool (the pool binds each
 * client's query when it checks the client out) and armed per case.
 */
type ArmedPause = { match: (text: string, values: readonly unknown[]) => boolean; reached: () => void; released: Promise<void> };
let armedPause: ArmedPause | null = null;
const originalClientQuery = pg.Client.prototype.query;
function installQueryPauseHook(): void {
  pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
    const config = args[0] as string | { text?: string; values?: unknown[] } | undefined;
    const text = typeof config === "string" ? config : config?.text;
    const values = Array.isArray(args[1]) ? args[1] as unknown[] : (typeof config === "object" && config?.values) || [];
    const pause = armedPause;
    if (pause && text && pause.match(text, values)) {
      armedPause = null;
      pause.reached();
      return pause.released.then(() => (originalClientQuery as (...a: unknown[]) => unknown).apply(this, args));
    }
    return (originalClientQuery as (...a: unknown[]) => unknown).apply(this, args);
  } as typeof originalClientQuery;
}
function pauseQuery(match: ArmedPause["match"]) {
  let reached!: () => void;
  const atPause = new Promise<void>((resolve) => { reached = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  armedPause = { match, reached, released };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("the paused query was never sent")), 10_000); });
  return {
    atPause: Promise.race([atPause, timeout]).finally(() => clearTimeout(timer)),
    release,
    restore: () => { clearTimeout(timer); armedPause = null; release(); },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** A paid server with external channels on (paid: free-plan joint caps are not what these cases test). */
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

async function jointChannel(host: Host) {
  const channel = await host.channel();
  const job = await startChannelToJointConversion({ serverId: host.server.id, sourceChannelId: channel.id, createdByUserId: host.owner.id });
  assert.equal((await runChannelConversionJob(job.id)).status, "done");
  return channel;
}

async function inviteStatus(id: string) {
  const [row] = await getDb().select().from(channelExternalInvites).where(eq(channelExternalInvites.id, id));
  return row!;
}

async function activeProjections(hostChannelId: string, serverId: string) {
  const [host] = await getDb().select({ jointChannelId: jointChannelServers.jointChannelId }).from(jointChannelServers)
    .where(eq(jointChannelServers.localChannelId, hostChannelId));
  if (!host) return [];
  return getDb().select().from(jointChannelServers).where(and(
    eq(jointChannelServers.jointChannelId, host.jointChannelId),
    eq(jointChannelServers.serverId, serverId),
    eq(jointChannelServers.status, "active"),
  ));
}

test.skipIf(!REAL_PG_URL && !REAL_PG_REQUIRED)(
  "connections against what races them: two servers into each other's channels at once, a Guest accept against a reservation both ways, two reconnects after a disconnect, a crash after the conversion committed, a kill switch or an expiry while queued, a stale worker, and the ordinary joint invite writers",
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_external_connect_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "external-connect-admin" });
    let setupPool: pg.Pool | undefined;
    let observer: pg.Pool | undefined;
    let holder: pg.PoolClient | undefined;
    let unpark: (() => void) | undefined;
    let app: Awaited<ReturnType<typeof startTestApp>> | undefined;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const testUrl = databaseUrlFor(REAL_PG_URL, databaseName);
      setupPool = new pg.Pool({ connectionString: testUrl, application_name: "external-connect-setup", max: 2 });
      await migrate(drizzle(setupPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
      await setupPool.end();
      setupPool = undefined;
      installQueryPauseHook();
      app = await startTestApp(testUrl, 0, { humanActivityMuteFlagDefaultEnabled: true });
      observer = new pg.Pool({ connectionString: testUrl, application_name: "external-connect-observer", max: 4 });

      const park = async (...inviteIds: string[]) => {
        holder = await observer!.connect();
        await holder.query("BEGIN");
        for (const id of inviteIds) await holder.query("SELECT id FROM channel_external_invites WHERE id = $1 FOR UPDATE", [id]);
      };
      /**
       * Parks connections at their own transaction's invite row lock (the last lock they take), once their
       * operation starts (initializeInviteSources' short transaction, which locks that row first) ended.
       */
      const parkConnections = async (starts: number, ...inviteIds: string[]) => {
        holder = await observer!.connect();
        await holder.query("BEGIN");
        unpark = parkInviteRowsAfterStarts(holder, inviteIds, starts);
      };
      const release = async () => {
        unpark?.();
        unpark = undefined;
        await holder!.query("ROLLBACK");
        holder!.release();
        holder = undefined;
      };
      /** Holds `serverId`'s ns-3 lock: the first lock a connection to a joint channel queues on (after the admission locks). */
      const holdServerLock3 = async (serverId: string) => {
        holder = await observer!.connect();
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock($1, 3)", [parseInt(serverId.replace(/-/g, "").slice(0, 8), 16) | 0]);
      };
      /** Holds a channel row: the reservation queues on it inside its conversion start. */
      const holdChannelRow = async (channelId: string) => {
        holder = await observer!.connect();
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM channels WHERE id = $1 FOR UPDATE", [channelId]);
      };
      const conversionJobs = (channelId: string) => getDb().select().from(channelConversionJobs).where(eq(channelConversionJobs.sourceChannelId, channelId));
      const setExpiry = (inviteId: string, at: Date) => getDb().update(channelExternalInvites).set({ expiresAt: at }).where(eq(channelExternalInvites.id, inviteId));
      /** A connecting invite in its connection step: the conversion of `room` committed, the worker has not connected yet. */
      const convertedAndWaiting = async (host: Host) => {
        const room = await host.channel();
        const connector = await seedUser("connector");
        const target = await seedServer("target", connector);
        const invite = await seedInvite(host, room.id, connector.email);
        const reserved = await connectServerWithInvite(invite.token, connector.id, target.server.id);
        assert.equal(reserved.state, "connecting");
        if (reserved.state !== "connecting") throw new Error("expected a reservation");
        assert.equal((await runChannelConversionJob(reserved.conversionJobId)).status, "done");
        assert.equal((await inviteStatus(invite.id)).connectPhase, "connection");
        return { room, connector, target, invite };
      };

      // H<->T: each server connects into the other's joint channel at once,
      // both parked holding every accept lock before their invite rows. The
      // two connections share no lock; both must commit (no deadlock).
      {
        const a = await seedServer("alpha");
        const b = await seedServer("beta");
        const roomA = await jointChannel(a);
        const roomB = await jointChannel(b);
        const intoA = await seedInvite(a, roomA.id, b.owner.email);
        const intoB = await seedInvite(b, roomB.id, a.owner.email);
        await parkConnections(2, intoA.id, intoB.id);
        const first = settle(connectServerWithInvite(intoA.token, b.owner.id, b.server.id));
        const second = settle(connectServerWithInvite(intoB.token, a.owner.id, a.server.id));
        await untilBlocked(observer, 2);
        await release();
        const [one, two] = await Promise.all([first, second]);
        assert.equal(one.ok, true, `B into A: ${!one.ok && String(one.error)}`);
        assert.equal(two.ok, true, `A into B: ${!two.ok && String(two.error)}`);
        assert.equal((await activeProjections(roomA.id, b.server.id)).length, 1);
        assert.equal((await activeProjections(roomB.id, a.server.id)).length, 1);
        assert.equal((await inviteStatus(intoA.id)).status, "accepted");
        assert.equal((await inviteStatus(intoB.id)).status, "accepted");
      }

      // A Guest accept parked first (it holds the channel row): the
      // reservation waits, then sees the committed Guest and, with the host's
      // external_channels_v1 on (P3), goes ahead: the conversion carries the
      // Guest into the joint channel (guests_present before P3).
      {
        const host = await seedServer("guest-first");
        const room = await host.channel();
        const guest = await seedUser("guest");
        const connector = await seedUser("connector");
        const target = await seedServer("target", connector);
        const asGuest = await seedInvite(host, room.id, guest.email);
        const toConnect = await seedInvite(host, room.id, connector.email);
        await park(asGuest.id);
        const accepting = settle(acceptExternalInviteAsGuest(asGuest.token, guest.id));
        await untilBlocked(observer, 1);
        const connecting = settle(connectServerWithInvite(toConnect.token, connector.id, target.server.id));
        await untilBlocked(observer, 2);
        await release();
        const [accepted, connected] = await Promise.all([accepting, connecting]);
        assert.equal(accepted.ok, true, `guest accept: ${!accepted.ok && String(accepted.error)}`);
        assert.ok(connected.ok, `connect: ${connected.ok ? JSON.stringify(connected.value) : String(connected.error)}`);
        assert.equal((await inviteStatus(toConnect.id)).status, "connecting");
        const jobs = await getDb().select().from(channelConversionJobs).where(eq(channelConversionJobs.sourceChannelId, room.id));
        assert.equal(jobs.length, 1);
        const [after] = await getDb().select({ type: channels.type }).from(channels).where(eq(channels.id, room.id));
        assert.equal(after?.type, "private");
      }

      // The reservation parked first (it holds the conversion lock, the
      // channel row and the new fence): the Guest accept waits, then is
      // refused by the committed fence; nobody is bound as a Guest.
      {
        const host = await seedServer("connect-first");
        const room = await host.channel();
        const guest = await seedUser("guest");
        const connector = await seedUser("connector");
        const target = await seedServer("target", connector);
        const asGuest = await seedInvite(host, room.id, guest.email);
        const toConnect = await seedInvite(host, room.id, connector.email);
        await parkConnections(1, toConnect.id);
        const connecting = settle(connectServerWithInvite(toConnect.token, connector.id, target.server.id));
        await untilBlocked(observer, 1);
        const accepting = settle(acceptExternalInviteAsGuest(asGuest.token, guest.id));
        await untilBlocked(observer, 2);
        await release();
        const [connected, accepted] = await Promise.all([connecting, accepting]);
        assert.equal(connected.ok && connected.value.state, "connecting", `connect: ${!connected.ok && String(connected.error)}`);
        assert.equal(accepted.ok, false, `guest accept: ${accepted.ok ? JSON.stringify(accepted.value) : ""}`);
        const bound = await getDb().select().from(serverMembers).where(and(eq(serverMembers.serverId, host.server.id), eq(serverMembers.userId, guest.id)));
        assert.equal(bound.length, 0);
        assert.equal((await inviteStatus(toConnect.id)).status, "connecting");
      }

      // Disconnect, then two admins of the same server reconnect it at once
      // with two invites: one reconnects, the other finds it connected; one
      // active projection.
      {
        const host = await seedServer("reconnect-host");
        const room = await jointChannel(host);
        const owner = await seedUser("t-owner");
        const target = await seedServer("t", owner);
        const otherAdmin = await seedUser("t-admin");
        await getDb().insert(serverMembers).values({ serverId: target.server.id, userId: otherAdmin.id, role: "admin" });
        const firstInvite = await seedInvite(host, room.id, owner.email);
        const first = await connectServerWithInvite(firstInvite.token, owner.id, target.server.id);
        assert.equal(first.state, "connected");
        if (first.state !== "connected") return;
        await disconnectJointChannel(first.connection.localChannelId, owner.id);
        assert.equal((await activeProjections(room.id, target.server.id)).length, 0);
        // The disconnect's membership cleanup must finish before T may reconnect.
        for (const departure of await getDb().select().from(schema.jointMembershipDepartures)
          .where(eq(schema.jointMembershipDepartures.localChannelId, first.connection.localChannelId))) {
          while (!await cleanJointMembershipDepartureBatch(departure.id as JointMembershipDepartureId, { revoke: async () => {} }));
        }

        const byOwner = await seedInvite(host, room.id, owner.email);
        const byAdmin = await seedInvite(host, room.id, otherAdmin.email);
        await parkConnections(2, byOwner.id, byAdmin.id);
        const one = settle(connectServerWithInvite(byOwner.token, owner.id, target.server.id));
        const two = settle(connectServerWithInvite(byAdmin.token, otherAdmin.id, target.server.id));
        await untilBlocked(observer, 2);
        await release();
        const outcomes = await Promise.all([one, two]);
        const succeeded = outcomes.filter((outcome) => outcome.ok);
        const refused = outcomes.filter((outcome) => !outcome.ok);
        assert.equal(succeeded.length, 1, JSON.stringify(outcomes.map((outcome) => outcome.ok ? "ok" : String(outcome.error))));
        assert.ok(refused[0] && !refused[0].ok && refused[0].error instanceof ExternalConnectError && refused[0].error.code === "already_connected");
        assert.equal((await activeProjections(room.id, target.server.id)).length, 1);
      }

      // A crash after the conversion committed: the connection transaction is
      // aborted (its statement cancelled, so PostgreSQL rolls it back as it
      // would for a dead process) while it holds every lock but the invite
      // row. Nothing of it remains, the invite still holds its connection
      // step, and the next attempt connects.
      {
        const host = await seedServer("crash-host");
        const room = await host.channel();
        const connector = await seedUser("connector");
        const target = await seedServer("target", connector);
        const invite = await seedInvite(host, room.id, connector.email);
        const reserved = await connectServerWithInvite(invite.token, connector.id, target.server.id);
        assert.equal(reserved.state, "connecting");
        if (reserved.state !== "connecting") return;
        assert.equal((await runChannelConversionJob(reserved.conversionJobId)).status, "done");
        assert.equal((await inviteStatus(invite.id)).connectPhase, "connection");

        await park(invite.id);
        const attempt = settle(advanceExternalConnect(invite.id));
        const [pid] = await untilBlocked(observer, 1);
        await observer.query("SELECT pg_cancel_backend($1)", [pid]);
        await release();
        await attempt;
        const afterCrash = await inviteStatus(invite.id);
        assert.deepEqual({ status: afterCrash.status, phase: afterCrash.connectPhase }, { status: "connecting", phase: "connection" });
        assert.equal((await activeProjections(room.id, target.server.id)).length, 0, "the killed transaction left nothing");

        const connection = await advanceExternalConnect(invite.id);
        assert.equal(connection?.targetServerId, target.server.id);
        assert.equal((await inviteStatus(invite.id)).status, "accepted");
        assert.equal((await activeProjections(room.id, target.server.id)).length, 1);
        assert.equal(await advanceExternalConnect(invite.id), null, "a re-run connects nothing");
      }

      // Cody 1: the worker passed the flag check and queued on T's ns-3 lock;
      // the kill switch went on meanwhile. Under the flag's shared lock it
      // reads the switch at the final boundary: no connection, nothing written.
      {
        const host = await seedServer("kill-host");
        const { room, target, invite } = await convertedAndWaiting(host);
        await holdServerLock3(target.server.id);
        const attempt = settle(advanceExternalConnect(invite.id));
        await untilBlocked(observer, 1);
        await setFeatureFlagKillSwitch(EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, true);
        try {
          await release();
          const outcome = await attempt;
          assert.ok(outcome.ok && outcome.value === null, `worker: ${outcome.ok ? JSON.stringify(outcome.value) : String(outcome.error)}`);
          assert.equal((await activeProjections(room.id, target.server.id)).length, 0, "connected past the kill switch");
          const row = await inviteStatus(invite.id);
          assert.deepEqual({ status: row.status, phase: row.connectPhase }, { status: "connecting", phase: "connection" });
        } finally {
          await setFeatureFlagKillSwitch(EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, false);
        }
      }

      // Cody 2: a direct connect queued on T's ns-3 lock while its invite
      // expired. The expiry is judged with the time read after the locks.
      {
        const host = await seedServer("expiry-host");
        const room = await jointChannel(host);
        const connector = await seedUser("connector");
        const target = await seedServer("target", connector);
        const invite = await seedInvite(host, room.id, connector.email);
        await holdServerLock3(target.server.id);
        const attempt = settle(connectServerWithInvite(invite.token, connector.id, target.server.id));
        await untilBlocked(observer, 1);
        await setExpiry(invite.id, new Date());
        await new Promise((resolve) => setTimeout(resolve, 20));
        await release();
        const outcome = await attempt;
        assert.ok(!outcome.ok && outcome.error instanceof ExternalInviteAcceptError && outcome.error.code === "invalid",
          `connect: ${outcome.ok ? JSON.stringify(outcome.value) : String(outcome.error)}`);
        assert.equal((await activeProjections(room.id, target.server.id)).length, 0);
        assert.equal((await inviteStatus(invite.id)).status, "expired");
      }

      // The reservation, queued on the channel row inside its conversion
      // start: the invite expires, or the kill switch goes on, meanwhile.
      // Refused in both, with the job rolled back with it.
      for (const change of ["expires", "kill switch"] as const) {
        const host = await seedServer(`reserve-${change === "expires" ? "expiry" : "kill"}`);
        const room = await host.channel();
        const connector = await seedUser("connector");
        const target = await seedServer("target", connector);
        const invite = await seedInvite(host, room.id, connector.email);
        await holdChannelRow(room.id);
        const attempt = settle(connectServerWithInvite(invite.token, connector.id, target.server.id));
        await untilBlocked(observer, 1);
        if (change === "expires") await setExpiry(invite.id, new Date());
        else await setFeatureFlagKillSwitch(EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, true);
        try {
          await new Promise((resolve) => setTimeout(resolve, 20));
          await release();
          const outcome = await attempt;
          assert.ok(!outcome.ok && outcome.error instanceof ExternalInviteAcceptError && outcome.error.code === "invalid",
            `reserve (${change}): ${outcome.ok ? JSON.stringify(outcome.value) : String(outcome.error)}`);
          assert.equal((await conversionJobs(room.id)).length, 0, `reserve (${change}): the conversion started`);
          assert.equal((await inviteStatus(invite.id)).status, change === "expires" ? "expired" : "pending");
        } finally {
          if (change === "kill switch") await setFeatureFlagKillSwitch(EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, false);
        }
      }

      // An approval queued on its request row (held by another session) while
      // the invite and request expire: the request row is locked before the
      // final checks, so the expiry is seen. On a joint channel (direct) and
      // on a private one (the conversion reservation).
      for (const path of ["joint", "conversion"] as const) {
        const host = await seedServer(`approve-${path}`);
        const room = path === "joint" ? await jointChannel(host) : await host.channel();
        const approver = await seedUser("approver");
        const requester = await seedUser("requester");
        const target = await seedServer("target", approver);
        await getDb().insert(serverMembers).values({ serverId: target.server.id, userId: requester.id, role: "member" });
        const invite = await seedInvite(host, room.id, requester.email);
        const { requestId } = await requestServerConnectApproval(invite.token, requester.id, target.server.id, approver.id);
        const jobsBefore = (await conversionJobs(room.id)).length;
        // Valid when the approval passes its early checks; lapsed while it waits
        // (the approval then holds the invite row, so time passes instead of an update).
        const expiry = new Date(Date.now() + 700);
        await setExpiry(invite.id, expiry);
        await getDb().update(schema.channelServerConnectRequests).set({ expiresAt: expiry }).where(eq(schema.channelServerConnectRequests.id, requestId));
        holder = await observer.connect();
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM channel_server_connect_requests WHERE id = $1 FOR UPDATE", [requestId]);
        const approving = settle(approveServerConnectRequest(requestId, approver.id));
        await untilBlocked(observer, 1);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        assert.ok(expiry < new Date());
        await holder.query("COMMIT");
        holder.release();
        holder = undefined;
        const outcome = await approving;
        assert.ok(!outcome.ok && outcome.error instanceof ExternalConnectError && outcome.error.code === "request_expired",
          `approve (${path}): ${outcome.ok ? JSON.stringify(outcome.value) : String(outcome.error)}`);
        assert.equal((await activeProjections(room.id, target.server.id)).length, 0, `approve (${path}): connected`);
        assert.equal((await conversionJobs(room.id)).length, jobsBefore, `approve (${path}): a conversion started`);
        assert.equal((await inviteStatus(invite.id)).status, "expired");
      }

      // Cody 4: a stale worker. The first conversion is cancelled; worker A
      // reads that and pauses right before settling; worker B settles it; the
      // invitee connects again (a new reservation and job). A's settle must
      // match nothing.
      {
        const host = await seedServer("aba-host");
        const room = await host.channel();
        const connector = await seedUser("connector");
        const target = await seedServer("target", connector);
        const invite = await seedInvite(host, room.id, connector.email);
        const first = await connectServerWithInvite(invite.token, connector.id, target.server.id);
        if (first.state !== "connecting") throw new Error("expected a reservation");
        await cancelChannelConversionJob(first.conversionJobId);
        let resume!: () => void;
        const paused = new Promise<void>((resolve) => { resume = resolve; });
        let reached!: () => void;
        const atBarrier = new Promise<void>((resolve) => { reached = resolve; });
        let calls = 0;
        __setExternalConnectSettleBarrierForTests(async () => {
          calls += 1;
          if (calls === 1) { reached(); await paused; }
        });
        try {
          const workerA = settle(advanceExternalConnect(invite.id));
          await atBarrier;
          await advanceExternalConnect(invite.id);
          assert.equal((await inviteStatus(invite.id)).status, "pending");
          const second = await connectServerWithInvite(invite.token, connector.id, target.server.id);
          if (second.state !== "connecting") throw new Error("expected a second reservation");
          const reserved = await inviteStatus(invite.id);
          resume();
          await workerA;
          const after = await inviteStatus(invite.id);
          assert.deepEqual(
            { status: after.status, job: after.connectConversionJobId, generation: after.connectGeneration },
            { status: "connecting", job: second.conversionJobId, generation: reserved.connectGeneration },
            "the stale worker reset the new reservation",
          );
          const [job] = await getDb().select().from(channelConversionJobs).where(eq(channelConversionJobs.id, second.conversionJobId));
          assert.equal(job?.status, "pending");
          assert.equal(job?.externalConnectGeneration, reserved.connectGeneration);
        } finally {
          __setExternalConnectSettleBarrierForTests(null);
        }
      }

      // A Guest accept into T's own projection X (an active joint channel, so
      // invitable; refused only after its locks) and another connection of T
      // to the same joint, both in ADMISSION_LOCK_ORDER (T's admission lock
      // before X's row). X's row is held elsewhere first: the Guest accept
      // queues on it holding T's admission lock, the connection queues on
      // that admission lock holding nothing. A Guest accept taking X before
      // the admission lock would deadlock against the connection, which holds
      // the admission lock when it reaches X.
      {
        const host = await seedServer("prior-host");
        const room = await jointChannel(host);
        const owner = await seedUser("t-owner");
        const target = await seedServer("t", owner);
        const first = await connectServerWithInvite((await seedInvite(host, room.id, owner.email)).token, owner.id, target.server.id);
        if (first.state !== "connected") throw new Error("expected a connection");
        const projectionId = first.connection.localChannelId;
        const guest = await seedUser("x-guest");
        const intoProjection = await seedInvite(target, projectionId, guest.email);
        const again = await seedInvite(host, room.id, owner.email);
        await holdChannelRow(projectionId);
        const guestAccept = settle(acceptExternalInviteAsGuest(intoProjection.token, guest.id));
        await untilBlocked(observer, 1);
        const reconnect = settle(connectServerWithInvite(again.token, owner.id, target.server.id));
        await untilBlocked(observer, 2);
        await release();
        const [accepted, connected] = await Promise.all([guestAccept, reconnect]);
        const describe = (outcome: { ok: boolean; error?: unknown }) => outcome.ok ? "ok"
          : `${String(outcome.error)} (cause: ${String((outcome.error as { cause?: unknown }).cause ?? "")})`;
        assert.ok(!/deadlock/i.test(`${describe(accepted)} ${describe(connected)}`), `deadlock: guest ${describe(accepted)} / connect ${describe(connected)}`);
        // Another server's projection never takes a Guest (P3: only the host's does).
        assert.ok(!accepted.ok && accepted.error instanceof ExternalInviteAcceptError && accepted.error.code === "guest_unavailable", `guest accept: ${describe(accepted)}`);
        assert.ok(!connected.ok && connected.error instanceof ExternalConnectError && connected.error.code === "already_connected", `connect: ${describe(connected)}`);
        assert.equal((await activeProjections(room.id, target.server.id)).length, 1);
      }

      // Cody 3: a pending joint invite for the
      // same J/T/authorizer. An external connect queued on T's server row
      // (FOR NO KEY UPDATE held) races the ordinary create and resend of that
      // invite. Both orders hold J and the joint row before the invite row:
      // no deadlock, one connection.
      for (const ordinary of ["create", "resend"] as const) {
        const host = await seedServer(`order-${ordinary}`);
        const room = await jointChannel(host);
        const owner = await seedUser("t-owner");
        const target = await seedServer("t", owner);
        const invite = await seedInvite(host, room.id, owner.email);
        const [projection] = await getDb().select().from(jointChannelServers).where(eq(jointChannelServers.localChannelId, room.id));
        const common = { jointChannelId: projection!.jointChannelId, fromServerId: host.server.id, targetServerId: target.server.id, invitedUserId: owner.id, invitedByUserId: host.owner.id };
        await createJointChannelInvite(common);
        holder = await observer.connect();
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM servers WHERE id = $1 FOR NO KEY UPDATE", [target.server.id]);
        const external = settle(connectServerWithInvite(invite.token, owner.id, target.server.id));
        await untilBlocked(observer, 1);
        const normal = settle<unknown>(ordinary === "create"
          ? createJointChannelInvite(common)
          : resendPendingJointChannelInvites({ localChannelId: room.id, fromServerId: host.server.id, requestedByUserId: host.owner.id }));
        // Either the ordinary writer finishes (fixed order) or it queues behind the external one.
        await Promise.race([normal, untilBlocked(observer, 2).catch(() => undefined)]);
        await release();
        const [connected, ordinaryOutcome] = await Promise.all([external, normal]);
        const describe = (outcome: { ok: boolean; error?: unknown }) => outcome.ok ? "ok"
          : `${String(outcome.error)} (cause: ${String((outcome.error as { cause?: unknown }).cause ?? "")})`;
        assert.ok(!/deadlock/i.test(`${describe(connected)} ${describe(ordinaryOutcome)}`), `deadlock (${ordinary}): ${describe(connected)} / ${describe(ordinaryOutcome)}`);
        assert.equal(connected.ok, true, `external (${ordinary}): ${describe(connected)}`);
        assert.equal(ordinaryOutcome.ok, true, `ordinary ${ordinary}: ${describe(ordinaryOutcome)}`);
        assert.equal((await activeProjections(room.id, target.server.id)).length, 1);
        assert.equal((await inviteStatus(invite.id)).status, "accepted");
      }

      // Archive against a new projection, through the wrapper the archive
      // routes use (withLockedChannelActorCapability + archiveChannel).
      // Connect first: the
      // archive waits and archives the new projection too. Archive first: the
      // connection waits and is refused as archived. Either way every
      // projection agrees.
      const archiveThroughRoute = (host: Host, channelId: string, gate?: Promise<void>) => withLockedChannelActorCapability({
        serverId: host.server.id, channelId, actorType: "user", actorId: host.owner.id, capability: "archiveChannels",
      }, async (tx) => {
        const archived = await archiveChannel(channelId, host.owner.id, tx);
        await gate;
        return archived;
      });
      const archivedStates = async (hostChannelId: string) => {
        const rows = await observer!.query(`SELECT p.server_id, c.archived_at IS NOT NULL AS archived FROM joint_channel_servers p
          JOIN channels c ON c.id = p.local_channel_id
          WHERE p.status = 'active' AND p.joint_channel_id = (SELECT joint_channel_id FROM joint_channel_servers WHERE local_channel_id = $1)`, [hostChannelId]);
        return rows.rows as Array<{ server_id: string; archived: boolean }>;
      };
      {
        const mode = "joint";

        // Connect first, paused at its last write (the invite accepted).
        {
          const host = await seedServer(`arch-c-${mode}`);
          const room = await jointChannel(host);
          const owner = await seedUser("t-owner");
          const target = await seedServer("t", owner);
          const invite = await seedInvite(host, room.id, owner.email);
          const pause = pauseQuery((text, values) => text.startsWith('update "channel_external_invites"') && values.includes(invite.id) && values.includes("accepted"));
          try {
            const connecting = settle(connectServerWithInvite(invite.token, owner.id, target.server.id));
            await pause.atPause;
            const archiving = settle(archiveThroughRoute(host, room.id));
            await Promise.race([archiving, sleep(1_500)]);
            pause.release();
            const [connected, archived] = await Promise.all([connecting, archiving]);
            assert.equal(connected.ok, true, `connect first (${mode}): ${!connected.ok && String(connected.error)}`);
            assert.equal(archived.ok, true, `archive (${mode}): ${!archived.ok && String(archived.error)}`);
            const states = await archivedStates(room.id);
            assert.equal(states.length, 2);
            assert.ok(states.every((state) => state.archived), `connect first (${mode}): ${JSON.stringify(states)}`);
          } finally {
            pause.restore();
          }
        }

        // Archive first, paused before its commit.
        {
          const host = await seedServer(`arch-a-${mode}`);
          const room = await jointChannel(host);
          const owner = await seedUser("t-owner");
          const target = await seedServer("t", owner);
          const invite = await seedInvite(host, room.id, owner.email);
          let open!: () => void;
          const gate = new Promise<void>((resolve) => { open = resolve; });
          const archiving = settle(archiveThroughRoute(host, room.id, gate));
          await sleep(300);
          const connecting = settle(connectServerWithInvite(invite.token, owner.id, target.server.id));
          await Promise.race([connecting, sleep(1_500)]);
          open();
          const [archived, connected] = await Promise.all([archiving, connecting]);
          assert.equal(archived.ok, true, `archive first (${mode}): ${!archived.ok && String(archived.error)}`);
          // P3 (#wg-rbac:#25): with the host's external_channels_v1 on (seedServer),
          // archiving a joint channel revokes
          // its open invites as an ordinary channel's archive does, so the queued
          // connection finds the invite gone: the neutral invalid-invite answer.
          assert.ok(!connected.ok && connected.error instanceof ExternalInviteAcceptError && connected.error.code === "invalid",
            `archive first (${mode}): connect ${connected.ok ? JSON.stringify(connected.value) : String(connected.error)}`);
          assert.equal((await activeProjections(room.id, target.server.id)).length, 0);
          assert.equal((await inviteStatus(invite.id)).status, "revoked");
        }

        // Reconnecting a disconnected T, whose old projection X still exists,
        // queued on X while an archive of the joint queues behind it: no
        // deadlock, and the new projection is archived with the rest.
        {
          const host = await seedServer(`arch-x-${mode}`);
          const room = await jointChannel(host);
          const owner = await seedUser("t-owner");
          const target = await seedServer("t", owner);
          const first = await connectServerWithInvite((await seedInvite(host, room.id, owner.email)).token, owner.id, target.server.id);
          if (first.state !== "connected") throw new Error("expected a connection");
          await disconnectJointChannel(first.connection.localChannelId, owner.id);
          // The disconnect's membership cleanup must finish before T may reconnect.
          for (const departure of await getDb().select().from(schema.jointMembershipDepartures)
            .where(eq(schema.jointMembershipDepartures.localChannelId, first.connection.localChannelId))) {
            while (!await cleanJointMembershipDepartureBatch(departure.id as JointMembershipDepartureId, { revoke: async () => {} }));
          }
          const again = await seedInvite(host, room.id, owner.email);
          holder = await observer.connect();
          await holder.query("BEGIN");
          await holder.query("SELECT id FROM channels WHERE id = $1 FOR UPDATE", [first.connection.localChannelId]);
          const connecting = settle(connectServerWithInvite(again.token, owner.id, target.server.id));
          await untilBlocked(observer, 1);
          const archiving = settle(archiveThroughRoute(host, room.id));
          await untilBlocked(observer, 2);
          await release();
          const [connected, archived] = await Promise.all([connecting, archiving]);
          const describe = (outcome: { ok: boolean; error?: unknown }) => outcome.ok ? "ok"
            : `${String(outcome.error)} (cause: ${String((outcome.error as { cause?: unknown }).cause ?? "")})`;
          assert.ok(!/deadlock/i.test(`${describe(connected)} ${describe(archived)}`), `reconnect vs archive (${mode}): ${describe(connected)} / ${describe(archived)}`);
          assert.equal(connected.ok, true, `reconnect (${mode}): ${describe(connected)}`);
          assert.equal(archived.ok, true, `archive (${mode}): ${describe(archived)}`);
          const states = await archivedStates(room.id);
          assert.equal(states.length, 2);
          assert.ok(states.every((state) => state.archived), `reconnect then archive (${mode}): ${JSON.stringify(states)}`);
        }

        // Cody 7180b5fb, serial: the archive through the human wrapper commits,
        // then the ordinary joint accept runs.
        {
          const host = await seedServer(`arch-serial-${mode}`);
          const room = await jointChannel(host);
          const owner = await seedUser("t-owner");
          const target = await seedServer("t", owner);
          const [projection] = await getDb().select().from(jointChannelServers).where(eq(jointChannelServers.localChannelId, room.id));
          const jointInvite = await createJointChannelInvite({ jointChannelId: projection!.jointChannelId, fromServerId: host.server.id, targetServerId: target.server.id, invitedUserId: owner.id, invitedByUserId: host.owner.id });
          await archiveThroughRoute(host, room.id);
          const accepted = await settle(acceptJointChannelInvite({ inviteId: jointInvite.id, targetServerId: target.server.id, acceptedByUserId: owner.id }));
          assert.ok(!accepted.ok && accepted.error instanceof JointChannelArchivedError, `serial archive then accept (${mode}): ${accepted.ok ? "accepted" : String(accepted.error)}`);
          assert.equal((await activeProjections(room.id, target.server.id)).length, 0);
        }

        // Archive first, the ordinary joint accept (single and batch) queued
        // behind it on the lifecycle lock: refused as
        // archived, no new projection, the joint invite still pending.
        for (const batch of [false, true]) {
          const host = await seedServer(`arch-ja-${mode}${batch ? "-b" : ""}`);
          const room = await jointChannel(host);
          const owner = await seedUser("t-owner");
          const target = await seedServer("t", owner);
          const [projection] = await getDb().select().from(jointChannelServers).where(eq(jointChannelServers.localChannelId, room.id));
          const jointInvite = await createJointChannelInvite({ jointChannelId: projection!.jointChannelId, fromServerId: host.server.id, targetServerId: target.server.id, invitedUserId: owner.id, invitedByUserId: host.owner.id });
          let open!: () => void;
          const gate = new Promise<void>((resolve) => { open = resolve; });
          const archiving = settle(archiveThroughRoute(host, room.id, gate));
          await sleep(300);
          const accepting = settle<unknown>(batch
            ? acceptJointChannelInvites({ inviteIds: [jointInvite.id], acceptedByUserId: owner.id })
            : acceptJointChannelInvite({ inviteId: jointInvite.id, targetServerId: target.server.id, acceptedByUserId: owner.id }));
          await untilBlocked(observer, 1);
          open();
          const [archived, accepted] = await Promise.all([archiving, accepting]);
          const label = `archive then joint accept (${mode}${batch ? ", batch" : ""})`;
          assert.equal(archived.ok, true, `${label}: archive ${!archived.ok && String(archived.error)}`);
          assert.ok(!accepted.ok && accepted.error instanceof JointChannelArchivedError, `${label}: ${accepted.ok ? "accepted" : String(accepted.error)}`);
          assert.equal((await activeProjections(room.id, target.server.id)).length, 0, label);
          const [row] = await getDb().select().from(schema.jointChannelInvites).where(eq(schema.jointChannelInvites.id, jointInvite.id));
          assert.equal(row?.status, "pending", label);
        }

        // A rename fanned out to every projection (the PATCH route's wrapper),
        // paused before its commit, with the ordinary joint accept (single,
        // and batch) queued behind it: the new projection
        // takes the new name and description.
        for (const batch of [false, true]) {
          const host = await seedServer(`meta-${mode}${batch ? "-b" : ""}`);
          const room = await jointChannel(host);
          const owner = await seedUser("t-owner");
          const target = await seedServer("t", owner);
          const [projection] = await getDb().select().from(jointChannelServers).where(eq(jointChannelServers.localChannelId, room.id));
          const jointInvite = await createJointChannelInvite({ jointChannelId: projection!.jointChannelId, fromServerId: host.server.id, targetServerId: target.server.id, invitedUserId: owner.id, invitedByUserId: host.owner.id });
          const renamed = { name: `renamed-${randomUUID().slice(0, 8)}`, description: "after the rename" };
          let open!: () => void;
          const gate = new Promise<void>((resolve) => { open = resolve; });
          const renaming = settle(withLockedChannelActorCapabilities({
            serverId: host.server.id, channelId: room.id, actorType: "user", actorId: host.owner.id, capabilities: ["editChannelMetadata"],
          }, async (tx) => {
            const updated = await updateChannel(room.id, renamed, tx);
            await gate;
            return updated;
          }));
          await sleep(300);
          const accepting = settle<unknown>(batch
            ? acceptJointChannelInvites({ inviteIds: [jointInvite.id], acceptedByUserId: owner.id })
            : acceptJointChannelInvite({ inviteId: jointInvite.id, targetServerId: target.server.id, acceptedByUserId: owner.id }));
          await untilBlocked(observer, 1);
          open();
          const [renamedOutcome, accepted] = await Promise.all([renaming, accepting]);
          const label = `rename then joint accept (${mode}${batch ? ", batch" : ""})`;
          assert.equal(renamedOutcome.ok, true, `${label}: rename ${!renamedOutcome.ok && String(renamedOutcome.error)}`);
          assert.equal(accepted.ok, true, `${label}: accept ${!accepted.ok && String(accepted.error)}`);
          const [created] = await activeProjections(room.id, target.server.id);
          const [local] = await getDb().select({ name: channels.name, description: channels.description }).from(channels).where(eq(channels.id, created!.localChannelId));
          assert.deepEqual(local, renamed, label);
        }

        // The ordinary joint accept against the same archive: it also creates a projection.
        {
          const host = await seedServer(`arch-j-${mode}`);
          const room = await jointChannel(host);
          const owner = await seedUser("t-owner");
          const target = await seedServer("t", owner);
          const [projection] = await getDb().select().from(jointChannelServers).where(eq(jointChannelServers.localChannelId, room.id));
          const jointInvite = await createJointChannelInvite({ jointChannelId: projection!.jointChannelId, fromServerId: host.server.id, targetServerId: target.server.id, invitedUserId: owner.id, invitedByUserId: host.owner.id });
          const pause = pauseQuery((text, values) => text.startsWith('update "joint_channel_invites"') && values.includes(jointInvite.id) && values.includes("accepted"));
          try {
            const accepting = settle(acceptJointChannelInvite({ inviteId: jointInvite.id, targetServerId: target.server.id, acceptedByUserId: owner.id }));
            await pause.atPause;
            const archiving = settle(archiveThroughRoute(host, room.id));
            await Promise.race([archiving, sleep(1_500)]);
            pause.release();
            const [accepted, archived] = await Promise.all([accepting, archiving]);
            assert.equal(accepted.ok, true, `joint accept (${mode}): ${!accepted.ok && String(accepted.error)}`);
            assert.equal(archived.ok, true, `archive (${mode}): ${!archived.ok && String(archived.error)}`);
            const states = await archivedStates(room.id);
            assert.equal(states.length, 2);
            assert.ok(states.every((state) => state.archived), `joint accept then archive (${mode}): ${JSON.stringify(states)}`);
          } finally {
            pause.restore();
          }
        }
      }
    } finally {
      unpark?.();
      if (holder) {
        await holder.query("ROLLBACK").catch(() => {});
        holder.release();
      }
      pg.Client.prototype.query = originalClientQuery;
      if (app) await app.close();
      if (observer) await observer.end();
      if (setupPool) await setupPool.end();
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`).catch(() => {});
      await admin.end();
    }
  },
  600_000,
);
