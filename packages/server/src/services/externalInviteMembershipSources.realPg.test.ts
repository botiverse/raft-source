import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { test } from "vitest";
import { isInTransaction } from "../db/ambientTransaction";
import { getDb } from "../db/index";
import * as schema from "../db/schema";
import { channelExternalInvites, channelServerConnectRequests, jointChannelAdmissions, jointChannelMembers, jointChannelServers, serverMembers, servers } from "../db/schema";
import { openTestApp as startTestApp } from "../test/integration/app";
import { captureEmails, enableExternalChannelsFlag, seedUser as seedFixtureUser, sha256 } from "../test/externalInviteFixture";
import { acceptJointChannelInvite, createChannel, inviteServerToJointChannel, removeHuman } from "./channelService";
import { runChannelConversionJob, startChannelToJointConversion } from "./channelConversionService";
import {
  __initializeInviteSourcesForTests,
  __setInviteSourcesSnapshotBarrierForTests,
  advanceExternalConnect,
  approveServerConnectRequest,
  connectServersWithInvite,
  ExternalConnectError,
} from "./externalInviteConnectService";
import { createServer } from "./serverService";

// Joint membership sources of one external invite (the operation, #12901)
// against what races it on real PostgreSQL 17, on separate connections:
// PGlite runs one transaction at a time, so externalInviteMembershipSources
// .api.test.ts can only show these one after the other. Each case parks the
// first writer on a row it locks after the joint's membership lock (J), so
// the second queues behind J (or before it) while the first's writes are
// uncommitted, then releases it: both orders, never by sleeping. Lock order
// J -> invite row: no deadlock (each case is bounded by the test timeout and
// the transactions' own lock_timeout).
//
// 1. A queued server's connection (invite joined(g)) against the joiner
//    leaving: connect first, the source is recorded and the leave ends the
//    membership; leave first, the connection is refused and re-adds nobody.
// 2. An approval of an operation awaiting its first join against the person
//    joining another way (a joint invite accept): one membership; the old
//    operation is its source only if it made it (else no_sources).
// 3. An operation's start (initializeInviteSources) against a join
//    committing at the same time: its state is one snapshot's, so after the
//    person leaves its connection is refused and does not re-add them.
// 4. The rejoin race: an operation in joined(g1) with a server still
//    awaiting approval; the person leaves and rejoins another way (g2)
//    while that approval runs. The old operation never records a source of
//    g2, never makes a member or a generation: refused membership_changed,
//    or (it committed against g1 first) its g1 source is historical.

const REAL_PG_URL_ENV = "EXTERNAL_INVITE_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.EXTERNAL_INVITE_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const DAY_MS = 86_400_000;

function databaseUrlFor(adminUrl: string, databaseName: string): string {
  const parsed = new URL(adminUrl);
  assert.match(parsed.protocol, /^postgres(?:ql)?:$/, `${REAL_PG_URL_ENV} must be a PostgreSQL URL`);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

/** Waits for `n` sessions blocked on a lock; their backend pids (each a connection of its own). */
async function untilBlocked(observer: pg.Pool, n: number, timeoutMs = 10_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await observer.query<{ pid: number }>("SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0");
    if (result.rows.length >= n) return result.rows.map((row) => row.pid);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`expected ${n} blocked sessions`);
}

function settle<T>(promise: Promise<T>) {
  return promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
}

type Settled = { ok: boolean; error?: unknown };
const describe = (outcome: Settled) => outcome.ok ? "ok"
  : `${String(outcome.error)} (code: ${String((outcome.error as { code?: unknown }).code ?? "")}; cause: ${String((outcome.error as { cause?: unknown }).cause ?? "")})`;
function assertNoDeadlock(label: string, ...outcomes: Settled[]) {
  const text = outcomes.map(describe).join(" / ");
  assert.ok(!/deadlock|40P01|lock timeout|55P03/i.test(text), `${label}: ${text}`);
}

const seedUser = (label: string) => seedFixtureUser(`${label}-${randomBytes(4).toString("hex")}`);
type Person = Awaited<ReturnType<typeof seedUser>>;

async function seedHost() {
  const owner = await seedUser("race-host-owner");
  const server = await createServer("Race Host", `race-host-${randomBytes(4).toString("hex")}`, owner.id);
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, server.id));
  await enableExternalChannelsFlag(server.id);
  const room = () => createChannel(server.id, `race-room-${randomBytes(4).toString("hex")}`, undefined, "private", { type: "user", id: owner.id });
  return { owner, server, room };
}
type Host = Awaited<ReturnType<typeof seedHost>>;

async function seedTarget(owner: Person, members: Person[] = []) {
  const server = await createServer("Race Target", `race-target-${randomBytes(4).toString("hex")}`, owner.id);
  for (const member of members) await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, server.id));
  return server;
}

async function seedInvite(host: Host, channelId: string, email: string) {
  const token = randomBytes(32).toString("hex");
  const [row] = await getDb().insert(channelExternalInvites).values({
    channelId,
    hostServerId: host.server.id,
    email,
    tokenHash: sha256(token),
    invitedByUserId: host.owner.id,
    expiresAt: new Date(Date.now() + 14 * DAY_MS),
  }).returning({ id: channelExternalInvites.id });
  return { id: row!.id, token };
}

async function convertToJoint(host: Host, channelId: string) {
  const job = await startChannelToJointConversion({ serverId: host.server.id, sourceChannelId: channelId, createdByUserId: host.owner.id });
  assert.equal((await runChannelConversionJob(job.id)).status, "done");
}

async function inviteRow(id: string) {
  const [row] = await getDb().select().from(channelExternalInvites).where(eq(channelExternalInvites.id, id));
  return row!;
}

const sourceStateOf = async (id: string) => {
  const row = await inviteRow(id);
  return { state: row.sourceState, start: row.sourceStartGeneration, generation: row.sourceGeneration };
};

async function jointOf(hostChannelId: string): Promise<string> {
  const [row] = await getDb().select({ jointChannelId: jointChannelServers.jointChannelId }).from(jointChannelServers)
    .where(eq(jointChannelServers.localChannelId, hostChannelId));
  assert.ok(row, "the channel is joint");
  return row.jointChannelId;
}

async function projectionOn(jointId: string, serverId: string) {
  const [row] = await getDb().select().from(jointChannelServers)
    .where(and(eq(jointChannelServers.jointChannelId, jointId), eq(jointChannelServers.serverId, serverId), eq(jointChannelServers.status, "active")));
  return row ?? null;
}

async function membersOf(jointId: string, userId: string) {
  return getDb().select().from(jointChannelMembers)
    .where(and(eq(jointChannelMembers.jointChannelId, jointId), eq(jointChannelMembers.userId, userId)));
}

async function counterOf(jointId: string, userId: string): Promise<number> {
  const result = await getDb().execute<{ n: number }>(sql`SELECT last_generation AS n FROM joint_membership_generations
    WHERE joint_channel_id = ${jointId}::uuid AND principal_kind = 'user' AND principal_id = ${userId}::uuid`);
  return result.rows[0] ? Number(result.rows[0].n) : 0;
}

/** The person's sources, by server id: [server, generation, admitted_by]. */
async function sourcesOf(jointId: string, userId: string) {
  const rows = await getDb().select().from(jointChannelAdmissions)
    .where(and(eq(jointChannelAdmissions.jointChannelId, jointId), eq(jointChannelAdmissions.userId, userId)));
  return rows.map((row) => ({ serverId: row.serverId, generation: row.generation, admittedBy: row.admittedBy }))
    .sort((a, b) => a.serverId.localeCompare(b.serverId) || a.generation - b.generation);
}

/** A joint invite from the host to `serverId` for the person (the other route); accepting it joins them. */
async function anotherWay(host: Host, hostChannelId: string, invitee: Person, serverId: string) {
  const [server] = await getDb().select({ slug: servers.slug }).from(servers).where(eq(servers.id, serverId));
  const sent = await inviteServerToJointChannel({ localChannelId: hostChannelId, fromServerId: host.server.id, invitedByUserId: host.owner.id, targetServerSlug: server!.slug, invitedPeople: [`@${invitee.name}`] });
  const inviteId = sent.invites[0]!.id;
  return { inviteId, accept: () => acceptJointChannelInvite({ inviteId, targetServerId: serverId, acceptedByUserId: invitee.id }) };
}

async function requestOf(inviteId: string, serverId: string) {
  const [row] = await getDb().select().from(channelServerConnectRequests)
    .where(and(eq(channelServerConnectRequests.inviteId, inviteId), eq(channelServerConnectRequests.targetServerId, serverId)));
  assert.ok(row, "a request waits for approval");
  return row.id;
}

const backendPid = async () => Number((await getDb().execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);

const isMembershipChanged = (outcome: Settled) => !outcome.ok && outcome.error instanceof ExternalConnectError && outcome.error.code === "membership_changed";

test.skipIf(!REAL_PG_URL && !REAL_PG_REQUIRED)(
  "joint membership sources of one operation, raced on separate connections: a queued connect against a leave, an approval against a join another way, an operation's start against a join; both orders, no deadlock",
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_invite_sources_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "invite-sources-admin" });
    let setupPool: pg.Pool | undefined;
    let observer: pg.Pool | undefined;
    let holder: pg.PoolClient | undefined;
    let app: Awaited<ReturnType<typeof startTestApp>> | undefined;
    const mail = captureEmails();
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const testUrl = databaseUrlFor(REAL_PG_URL, databaseName);
      setupPool = new pg.Pool({ connectionString: testUrl, application_name: "invite-sources-setup", max: 2 });
      await migrate(drizzle(setupPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
      await setupPool.end();
      setupPool = undefined;
      app = await startTestApp(testUrl, 0, { humanActivityMuteFlagDefaultEnabled: true });
      observer = new pg.Pool({ connectionString: testUrl, application_name: "invite-sources-observer", max: 4 });
      /** Locks one row in an open transaction of its own: a writer reaching it after J waits there, J held, its writes uncommitted. */
      const park = async (table: "channel_external_invites" | "joint_channel_invites", id: string) => {
        holder = await observer!.connect();
        await holder.query("BEGIN");
        await holder.query(`SELECT 1 FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
      };
      const parkMember = async (jointId: string, userId: string) => {
        holder = await observer!.connect();
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM joint_channel_members WHERE joint_channel_id = $1 AND user_id = $2 FOR UPDATE", [jointId, userId]);
      };
      // Released promptly: the parked writer holds J under SET LOCAL lock_timeout '2s'.
      const release = async () => {
        await holder!.query("ROLLBACK");
        holder!.release();
        holder = undefined;
      };

      // ── 1. A queued server's connection (joined(g)) against the joiner leaving ──
      for (const first of ["connect", "leave"] as const) {
        const label = `1 (${first} first)`;
        const host = await seedHost();
        const invitee = await seedUser("race-1");
        const a = await seedTarget(invitee);
        const b = await seedTarget(invitee);
        const room = await host.room();
        const invite = await seedInvite(host, room.id, invitee.email);
        // A private channel: one reservation, A connected after the conversion, B queued.
        await connectServersWithInvite(invite.token, invitee.id, [{ serverId: a.id }, { serverId: b.id }]);
        assert.equal((await runChannelConversionJob((await inviteRow(invite.id)).connectConversionJobId!)).status, "done");
        assert.equal((await advanceExternalConnect(invite.id))?.targetServerId, a.id, `${label}: A connects`);
        const jointId = await jointOf(room.id);
        const [member] = await membersOf(jointId, invitee.id);
        assert.ok(member, `${label}: joined through A`);
        assert.deepEqual(await sourceStateOf(invite.id), { state: "joined", start: null, generation: member.generation }, `${label}: joined(g)`);
        assert.equal((await inviteRow(invite.id)).connectServerId, b.id, `${label}: B queued`);
        const before = await sourcesOf(jointId, invitee.id);
        const onA = (await projectionOn(jointId, a.id))!.localChannelId;

        const worker = () => settle(advanceExternalConnect(invite.id));
        const leave = () => settle(removeHuman(onA, invitee.id, { self: true }));
        let connectOutcome: Promise<Settled & { value?: unknown }>;
        let leaveOutcome: Promise<Settled>;
        if (first === "connect") {
          // The worker parks on the invite row (after J, B's projection and source written); the leave queues on J.
          await park("channel_external_invites", invite.id);
          connectOutcome = worker();
          await untilBlocked(observer, 1);
          leaveOutcome = leave();
        } else {
          // The leave parks deleting the member row (after J); the worker queues on its admission/lifecycle/J locks.
          await parkMember(jointId, invitee.id);
          leaveOutcome = leave();
          await untilBlocked(observer, 1);
          connectOutcome = worker();
        }
        // Two backends of their own, both waiting: neither runs as a savepoint of the other.
        assert.equal(new Set(await untilBlocked(observer, 2)).size, 2, `${label}: two connections`);
        await release();
        const [connected, left] = await Promise.all([connectOutcome, leaveOutcome]);
        assertNoDeadlock(label, connected, left);
        assert.ok(left.ok, `${label}: leave failed: ${describe(left)}`);
        assert.ok(connected.ok, `${label}: worker threw: ${describe(connected)}`);

        assert.deepEqual(await membersOf(jointId, invitee.id), [], `${label}: not a member afterwards (never re-added)`);
        assert.equal(await counterOf(jointId, invitee.id), member.generation, `${label}: no new membership`);
        const after = await sourcesOf(jointId, invitee.id);
        assert.ok(after.every((row) => row.generation === member.generation), `${label}: every source is of g: ${JSON.stringify(after)}`);
        if (first === "connect") {
          assert.equal((connected.value as { targetServerId?: string } | null)?.targetServerId, b.id, `${label}: B connected`);
          assert.ok(after.some((row) => row.serverId === b.id && row.generation === member.generation), `${label}: B is a source of g (historical now)`);
        } else {
          assert.equal(connected.value, null, `${label}: the worker connected nothing`);
          assert.equal(await projectionOn(jointId, b.id), null, `${label}: B not connected`);
          assert.deepEqual(after, before, `${label}: no source written`);
        }
        const done = await inviteRow(invite.id);
        assert.deepEqual({ status: done.status, state: done.sourceState, generation: done.sourceGeneration },
          { status: "accepted", state: "joined", generation: member.generation }, `${label}: the invite rests accepted, joined(g)`);
      }

      // ── 2. An approval of an operation awaiting its first join against a join another way ──
      for (const first of ["approval", "joint accept"] as const) {
        const label = `2 (${first} first)`;
        const host = await seedHost();
        const invitee = await seedUser("race-2");
        const approver = await seedUser("race-2-approver");
        const m = await seedTarget(approver, [invitee]);
        const c = await seedTarget(invitee);
        const room = await host.room();
        await convertToJoint(host, room.id);
        const jointId = await jointOf(room.id);
        const invite = await seedInvite(host, room.id, invitee.email);
        await connectServersWithInvite(invite.token, invitee.id, [{ serverId: m.id, approverUserId: approver.id }]);
        assert.deepEqual(await sourceStateOf(invite.id), { state: "awaiting_first_join", start: 0, generation: null }, `${label}: awaiting_first_join(0)`);
        const requestId = await requestOf(invite.id, m.id);
        const other = await anotherWay(host, room.id, invitee, c.id);

        const approval = () => settle(approveServerConnectRequest(requestId, approver.id));
        const jointAccept = () => settle(other.accept());
        let approveOutcome: Promise<Settled>;
        let acceptOutcome: Promise<Settled>;
        if (first === "approval") {
          // The approval parks on the invite row (after J, the member written); the accept queues on the host's admission lock.
          await park("channel_external_invites", invite.id);
          approveOutcome = approval();
          await untilBlocked(observer, 1);
          acceptOutcome = jointAccept();
        } else {
          // The accept parks on its joint invite row (after J); the approval queues on the host's admission lock.
          await park("joint_channel_invites", other.inviteId);
          acceptOutcome = jointAccept();
          await untilBlocked(observer, 1);
          approveOutcome = approval();
        }
        // Two backends of their own, both waiting: neither runs as a savepoint of the other.
        assert.equal(new Set(await untilBlocked(observer, 2)).size, 2, `${label}: two connections`);
        await release();
        const [approved, accepted] = await Promise.all([approveOutcome, acceptOutcome]);
        assertNoDeadlock(label, approved, accepted);
        assert.ok(approved.ok, `${label}: approval failed: ${describe(approved)}`);
        assert.ok(accepted.ok, `${label}: joint accept failed: ${describe(accepted)}`);

        const members = await membersOf(jointId, invitee.id);
        assert.equal(members.length, 1, `${label}: one member row`);
        assert.equal(members[0]!.generation, 1, `${label}: one membership generation`);
        assert.equal(await counterOf(jointId, invitee.id), 1, `${label}: the counter moved once`);
        assert.equal((await projectionOn(jointId, m.id))?.status, "active", `${label}: M connected`);
        assert.equal((await projectionOn(jointId, c.id))?.status, "active", `${label}: C connected`);
        const sources = await sourcesOf(jointId, invitee.id);
        assert.ok(sources.every((row) => row.generation === 1), `${label}: no source of another generation: ${JSON.stringify(sources)}`);
        if (first === "approval") {
          // The operation made the membership: M is its source, admitted by the approver.
          assert.ok(sources.some((row) => row.serverId === m.id && row.admittedBy === approver.id), `${label}: M is a source: ${JSON.stringify(sources)}`);
          assert.deepEqual(await sourceStateOf(invite.id), { state: "joined", start: null, generation: 1 }, `${label}: joined(1)`);
        } else {
          // The accept made it: the old operation connects M but is no source of a membership it did not make.
          assert.deepEqual(sources, [{ serverId: c.id, generation: 1, admittedBy: invitee.id }], `${label}: only the accept's source`);
          assert.deepEqual(await sourceStateOf(invite.id), { state: "no_sources", start: null, generation: null }, `${label}: no_sources`);
        }
      }

      // ── 3. An operation's start against a join committing at the same time ──
      for (const order of ["join inside the start", "join held open across the start"] as const) {
        const label = `3 (${order})`;
        const host = await seedHost();
        const invitee = await seedUser("race-3");
        const approver = await seedUser("race-3-approver");
        const m = await seedTarget(approver, [invitee]);
        const c = await seedTarget(invitee);
        const room = await host.room();
        await convertToJoint(host, room.id);
        const jointId = await jointOf(room.id);
        const invite = await seedInvite(host, room.id, invitee.email);
        const other = await anotherWay(host, room.id, invitee, c.id);

        if (order === "join inside the start") {
          // The start holds the invite row (its transaction open); the join
          // commits on another connection before the start's snapshot. The
          // barrier runs inside the start's ambient transaction
          // (db/ambientTransaction, AsyncLocalStorage): called from there, the
          // join would open a SAVEPOINT on the start's own connection. So it is
          // bound here, outside any transaction, and opens a root transaction
          // of its own (its pid recorded) for the accept to run in.
          let startPid = 0;
          let joinPid = 0;
          const joinOnOwnConnection = AsyncResource.bind(async () => {
            assert.equal(isInTransaction(), false, `${label}: the join is outside the start's transaction`);
            return getDb().transaction(async (tx) => {
              joinPid = Number((await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid);
              return other.accept();
            });
          });
          let joined: Settled | undefined;
          __setInviteSourcesSnapshotBarrierForTests(async (inviteId) => {
            if (inviteId !== invite.id || joined) return;
            assert.equal(isInTransaction(), true, `${label}: the barrier runs in the start's transaction`);
            startPid = await backendPid();
            joined = await settle(joinOnOwnConnection());
          });
          try {
            await connectServersWithInvite(invite.token, invitee.id, [{ serverId: m.id, approverUserId: approver.id }]);
          } finally {
            __setInviteSourcesSnapshotBarrierForTests(null);
          }
          assert.ok(joined?.ok, `${label}: the join committed during the start: ${joined && describe(joined)}`);
          assert.ok(startPid > 0 && joinPid > 0 && startPid !== joinPid, `${label}: the start (pid ${startPid}) and the join (pid ${joinPid}) on separate connections`);
          // One snapshot: a member at counter 1, so the operation has no sources.
          // Never awaiting_first_join(1) (no member, then the counter of the join).
          assert.deepEqual(await sourceStateOf(invite.id), { state: "no_sources", start: null, generation: null }, `${label}: no_sources`);
        } else {
          // The join holds J, its member written but uncommitted; the start
          // takes no J lock (connections take J before the invite row), so it
          // finishes on the committed state while the join waits.
          await park("joint_channel_invites", other.inviteId);
          const joining = settle(other.accept());
          const [joinPid] = await untilBlocked(observer, 1);
          let startPid = 0;
          __setInviteSourcesSnapshotBarrierForTests(async (inviteId) => {
            if (inviteId === invite.id) startPid = await backendPid();
          });
          try {
            await __initializeInviteSourcesForTests(invite.id, invitee.id, "external");
          } finally {
            __setInviteSourcesSnapshotBarrierForTests(null);
          }
          assert.ok(startPid > 0 && joinPid !== undefined && startPid !== joinPid, `${label}: the start (pid ${startPid}) and the waiting join (pid ${joinPid}) on separate connections`);
          await release();
          const joined = await joining;
          assertNoDeadlock(label, joined);
          assert.ok(joined.ok, `${label}: the join failed: ${describe(joined)}`);
          assert.deepEqual(await sourceStateOf(invite.id), { state: "awaiting_first_join", start: 0, generation: null }, `${label}: awaiting_first_join(0)`);
          await connectServersWithInvite(invite.token, invitee.id, [{ serverId: m.id, approverUserId: approver.id }]);
          assert.deepEqual(await sourceStateOf(invite.id), { state: "awaiting_first_join", start: 0, generation: null }, `${label}: set once`);
        }
        const [member] = await membersOf(jointId, invitee.id);
        assert.equal(member?.generation, 1, `${label}: joined another way`);

        // They leave; the old operation's approval must not bring them back.
        const onC = (await projectionOn(jointId, c.id))!.localChannelId;
        await removeHuman(onC, invitee.id, { self: true });
        assert.deepEqual(await membersOf(jointId, invitee.id), [], `${label}: left`);
        const before = await sourcesOf(jointId, invitee.id);
        const approved = await settle(approveServerConnectRequest(await requestOf(invite.id, m.id), approver.id));
        assert.ok(isMembershipChanged(approved), `${label}: refused membership_changed: ${describe(approved)}`);
        assert.deepEqual(await membersOf(jointId, invitee.id), [], `${label}: not re-added`);
        assert.equal(await counterOf(jointId, invitee.id), 1, `${label}: no new membership`);
        assert.equal(await projectionOn(jointId, m.id), null, `${label}: M not connected`);
        assert.deepEqual(await sourcesOf(jointId, invitee.id), before, `${label}: no source written`);
      }

      // ── 4. The rejoin race: an old operation in joined(g1) against leave + rejoin another way (g2) ──
      // - "approval first, left before": the leave committed; the approval
      //   holds the host's admission lock (parked on the joiner's member row
      //   of M, before J) while the rejoin queues behind it.
      // - "rejoin first, left before": the leave committed; the rejoin parks
      //   on its joint invite row holding J with g2 written; the approval
      //   queues and then meets g2, not g1.
      // - "approval first, leave racing": the approval parks on the invite
      //   row (after J, its g1 source written); the leave queues on J and the
      //   rejoin runs after the leave commits.
      for (const variant of ["approval first, left before", "rejoin first, left before", "approval first, leave racing"] as const) {
        const label = `4 (${variant})`;
        const host = await seedHost();
        const invitee = await seedUser("race-4");
        const approver = await seedUser("race-4-approver");
        const a = await seedTarget(invitee);
        const m = await seedTarget(approver, [invitee]);
        const c = await seedTarget(invitee);
        const room = await host.room();
        await convertToJoint(host, room.id);
        const jointId = await jointOf(room.id);
        const invite = await seedInvite(host, room.id, invitee.email);
        // A connects now (the first join, g1); M waits for its approver.
        await connectServersWithInvite(invite.token, invitee.id, [{ serverId: a.id }, { serverId: m.id, approverUserId: approver.id }]);
        const [g1] = await membersOf(jointId, invitee.id);
        assert.ok(g1, `${label}: joined through A`);
        assert.deepEqual(await sourceStateOf(invite.id), { state: "joined", start: null, generation: g1.generation }, `${label}: joined(g1)`);
        const requestId = await requestOf(invite.id, m.id);
        const rejoin = await anotherWay(host, room.id, invitee, c.id);
        const onA = (await projectionOn(jointId, a.id))!.localChannelId;

        const approval = () => settle(approveServerConnectRequest(requestId, approver.id));
        let approveOutcome: Promise<Settled>;
        let rejoinOutcome: Promise<Settled>;
        if (variant === "approval first, left before") {
          await removeHuman(onA, invitee.id, { self: true });
          holder = await observer.connect();
          await holder.query("BEGIN");
          await holder.query("SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2 FOR UPDATE", [m.id, invitee.id]);
          approveOutcome = approval();
          await untilBlocked(observer, 1);
          rejoinOutcome = settle(rejoin.accept());
        } else if (variant === "rejoin first, left before") {
          await removeHuman(onA, invitee.id, { self: true });
          await park("joint_channel_invites", rejoin.inviteId);
          rejoinOutcome = settle(rejoin.accept());
          await untilBlocked(observer, 1);
          approveOutcome = approval();
        } else {
          await park("channel_external_invites", invite.id);
          approveOutcome = approval();
          await untilBlocked(observer, 1);
          rejoinOutcome = settle(removeHuman(onA, invitee.id, { self: true }).then(() => rejoin.accept()));
        }
        assert.equal(new Set(await untilBlocked(observer, 2)).size, 2, `${label}: two connections`);
        await release();
        const [approved, rejoined] = await Promise.all([approveOutcome, rejoinOutcome]);
        assertNoDeadlock(label, approved, rejoined);
        assert.ok(rejoined.ok, `${label}: the leave and rejoin failed: ${describe(rejoined)}`);

        // g2 is the rejoin's: one member row, the counter moved once more, its only source C.
        const members = await membersOf(jointId, invitee.id);
        assert.equal(members.length, 1, `${label}: one member row`);
        const g2 = g1.generation + 1;
        assert.equal(members[0]!.generation, g2, `${label}: the rejoin's membership`);
        assert.equal(await counterOf(jointId, invitee.id), g2, `${label}: no generation from the old operation`);
        const sources = await sourcesOf(jointId, invitee.id);
        assert.deepEqual(sources.filter((row) => row.generation === g2), [{ serverId: c.id, generation: g2, admittedBy: invitee.id }], `${label}: g2's only source is the rejoin's`);
        assert.ok(!sources.some((row) => row.serverId === m.id && row.generation === g2), `${label}: no source of M at g2`);
        if (variant === "approval first, leave racing") {
          // Committed against g1 before the leave: M connected, its source g1's (historical now).
          assert.ok(approved.ok, `${label}: approval failed: ${describe(approved)}`);
          assert.ok(sources.some((row) => row.serverId === m.id && row.generation === g1.generation && row.admittedBy === approver.id), `${label}: M is a source of g1: ${JSON.stringify(sources)}`);
        } else {
          assert.ok(isMembershipChanged(approved), `${label}: refused membership_changed: ${describe(approved)}`);
          assert.equal(await projectionOn(jointId, m.id), null, `${label}: M not connected`);
          assert.ok(!sources.some((row) => row.serverId === m.id), `${label}: no source of M at all: ${JSON.stringify(sources)}`);
        }
        assert.deepEqual(await sourceStateOf(invite.id), { state: "joined", start: null, generation: g1.generation }, `${label}: the old operation stays joined(g1)`);
      }
    } finally {
      mail.stop();
      __setInviteSourcesSnapshotBarrierForTests(null);
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
  300_000,
);
