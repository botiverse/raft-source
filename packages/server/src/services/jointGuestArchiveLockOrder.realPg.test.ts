import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { EXTERNAL_CHANNELS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { test } from "vitest";
import { getDb } from "../db/index";
import * as schema from "../db/schema";
import { channelAgents, channelExternalInvites, channels, featureFlagRules, featureFlags, jointChannelMembers, jointChannelServers, serverMembers, servers, users } from "../db/schema";
import { openTestApp as startTestApp } from "../test/integration/app";
import { seedBoundGuest } from "../test/guestFixture";
import { installQueryPauseHook, pauseQuery, uninstallQueryPauseHook } from "../test/pgQueryPause";
import { withLockedChannelActorCapability } from "../lib/channelActorPermissions";
import { acceptJointChannelInvite, archiveChannel, createJointChannel, markRead, removeHuman, setLocalChannelArchivedByAgent } from "./channelService";
import { createMessage } from "./messageService";
import { acceptExternalInviteAsGuest } from "./externalInviteService";
import { prepareJointHumanMembershipMirror } from "./jointHumanMembershipMirror";
import { createAgent } from "./agentService";
import { createServer, removeMember } from "./serverService";

// P3 (#wg-rbac:#25, Cody on PR #13205): archiving a joint channel ends its
// bound Guests' server memberships. Every member removal takes
// server -> member row -> J; the archive must take the Guests' member rows
// before J as well, on the human and the agent archive path, or an archive
// holding J and a removal holding the Guest's member row wait on each other.
// PGlite runs one transaction at a time; real PostgreSQL shows the waits.

// Runs in CI's "Joint source preview real PostgreSQL 17" step (test:joint-source-preview-real-pg).
const REAL_PG_URL_ENV = "JOINT_SOURCE_PREVIEW_REAL_PG_URL";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const REAL_PG_REQUIRED = process.env.JOINT_SOURCE_PREVIEW_REAL_PG_REQUIRED === "1";
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

function settle<T>(promise: Promise<T>) {
  return promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
}
const describe = (outcome: { ok: boolean; error?: unknown }) => outcome.ok ? "ok"
  : `${String(outcome.error)} (cause: ${String((outcome.error as { cause?: unknown }).cause ?? "")})`;

async function seedUser(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await getDb().insert(users).values({
    email: `${label}-${suffix}@slock.test`, name: `${label}-${suffix}`, displayName: label,
    passwordHash: "not-used-by-this-test", emailVerified: true, profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

/** A paid host with external channels on, a joint with a peer, and a Guest of the host bound to the host projection, in it. */
async function seedJointWithGuest(label: string) {
  const owner = await seedUser(`${label}-owner`);
  const peerOwner = await seedUser(`${label}-peer`);
  const guest = await seedUser(`${label}-guest`);
  const host = await createServer(`${label} host`, `${label}-h-${randomUUID().slice(0, 8)}`, owner.id);
  const peer = await createServer(`${label} peer`, `${label}-p-${randomUUID().slice(0, 8)}`, peerOwner.id);
  // The archiving agent first: on the free plan agents take no seat.
  const agent = await createAgent(host.id, `Archiver${randomUUID().slice(0, 4)}`, { runtime: "claude", model: "sonnet" });
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, host.id));
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, peer.id));
  await getDb().insert(featureFlagRules).values({
    id: randomUUID(), flagKey: EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [host.id],
  });
  const made = await createJointChannel({
    hostServerId: host.id, createdByUserId: owner.id, name: `${label}-${randomUUID().slice(0, 6)}`,
    targetServerSlug: peer.slug, invitedPeople: [`@${peerOwner.name}`],
  });
  await acceptJointChannelInvite({ inviteId: made.invites[0]!.id, targetServerId: peer.id, acceptedByUserId: peerOwner.id });
  // The agent manages the host projection (an appointed channel admin may archive).
  await getDb().insert(channelAgents).values({ channelId: made.channel.id, agentId: agent.id, role: "admin" });
  await seedBoundGuest({ serverId: host.id, userId: guest.id, channelId: made.channel.id });
  await getDb().transaction(async (tx) => {
    const mirror = await prepareJointHumanMembershipMirror(tx, { channelIds: [made.channel.id] }, "join");
    await mirror.apply([guest.id], { actorUserId: owner.id });
  });
  const [joined] = await getDb().select().from(jointChannelMembers)
    .where(and(eq(jointChannelMembers.jointChannelId, made.jointChannel.id), eq(jointChannelMembers.userId, guest.id)));
  assert.ok(joined, "the Guest is a joint member");
  return { owner, guest, host, channelId: made.channel.id, jointId: made.jointChannel.id, canonicalId: made.jointChannel.canonicalChannelId, agent };
}

async function assertGuestGone(f: Awaited<ReturnType<typeof seedJointWithGuest>>, label: string) {
  assert.equal((await getDb().select().from(serverMembers)
    .where(and(eq(serverMembers.serverId, f.host.id), eq(serverMembers.userId, f.guest.id)))).length, 0, `${label}: the Guest left the host`);
  assert.equal((await getDb().select().from(jointChannelMembers)
    .where(and(eq(jointChannelMembers.jointChannelId, f.jointId), eq(jointChannelMembers.userId, f.guest.id)))).length, 0, `${label}: and the joint`);
  const states = await getDb().select({ archivedAt: channels.archivedAt }).from(jointChannelServers)
    .innerJoin(channels, eq(channels.id, jointChannelServers.localChannelId))
    .where(and(eq(jointChannelServers.jointChannelId, f.jointId), eq(jointChannelServers.status, "active")));
  assert.equal(states.length, 2, `${label}: both projections active`);
  assert.ok(states.every((state) => state.archivedAt !== null), `${label}: every projection archived`);
}

test.skipIf(!REAL_PG_URL && !REAL_PG_REQUIRED)(
  "a joint archive, the removal of its bound Guest and that Guest's reads keep one lock order: either may go first, no deadlock (human and agent archive, guest removal, self-leave, host removal, accept retry)",
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_joint_guest_archive_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "joint-guest-archive-admin" });
    let observer: pg.Pool | undefined;
    let app: Awaited<ReturnType<typeof startTestApp>> | undefined;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const testUrl = databaseUrlFor(REAL_PG_URL, databaseName);
      const setupPool = new pg.Pool({ connectionString: testUrl, max: 2 });
      await migrate(drizzle(setupPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
      await setupPool.end();
      installQueryPauseHook();
      app = await startTestApp(testUrl, 0, { humanActivityMuteFlagDefaultEnabled: true });
      observer = new pg.Pool({ connectionString: testUrl, application_name: "joint-guest-archive-observer", max: 2 });
      await getDb().insert(featureFlags)
        .values({ key: EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: false })
        .onConflictDoNothing();

      type F = Awaited<ReturnType<typeof seedJointWithGuest>>;
      type Hold = { reached: () => void; gate: Promise<void> };
      const archivers: Array<[string, (f: F, hold?: Hold) => Promise<unknown>]> = [
        ["human", (f, hold) => withLockedChannelActorCapability({
          serverId: f.host.id, channelId: f.channelId, actorType: "user", actorId: f.owner.id, capability: "archiveChannels",
        }, async (tx) => { const archived = await archiveChannel(f.channelId, f.owner.id, tx); hold?.reached(); await hold?.gate; return archived; })],
        ["agent", (f, hold) => withLockedChannelActorCapability({
          serverId: f.host.id, channelId: f.channelId, actorType: "agent", actorId: f.agent.id, capability: "archiveChannels",
        }, async (tx) => { const archived = await setLocalChannelArchivedByAgent(f.channelId, f.agent.id, true, tx); hold?.reached(); await hold?.gate; return archived; })],
      ];
      const archive0 = (f: F) => archivers[0]![1](f);
      const holdOpen = () => {
        let reached!: () => void; let open!: () => void;
        const atHold = new Promise<void>((resolve) => { reached = resolve; });
        const gate = new Promise<void>((resolve) => { open = resolve; });
        return { hold: { reached, gate }, atHold, open };
      };

      for (const [path, archive] of archivers) {
        // Removal first, paused at its joint lock (J) while it holds the
        // Guest's member row: the archive must wait BEFORE taking J (on that
        // member row), so the removal then takes J and both finish.
        {
          const f = await seedJointWithGuest(`rm-first-${path}`);
          const pause = pauseQuery((text, values) => text.includes("pg_advisory_xact_lock") && values.includes(`joint-human-membership:${f.jointId}`));
          try {
            const removing = settle(removeMember(f.host.id, f.guest.id));
            await pause.atPause;
            const archiving = settle(archive(f));
            await Promise.race([untilBlocked(observer, 1), archiving.then((outcome) => {
              throw new Error(`removal first (${path}): the archive did not wait: ${describe(outcome)}`);
            })]);
            pause.release();
            const [removed, archived] = await Promise.all([removing, archiving]);
            assert.ok(!/deadlock/i.test(`${describe(removed)} ${describe(archived)}`), `removal first (${path}): ${describe(removed)} / ${describe(archived)}`);
            assert.equal(removed.ok, true, `removal first (${path}): removal ${describe(removed)}`);
            assert.equal(archived.ok, true, `removal first (${path}): archive ${describe(archived)}`);
            await assertGuestGone(f, `removal first (${path})`);
          } finally {
            pause.restore();
          }
        }

        // Archive first, held open after its writes: the removal waits on the
        // Guest's member row and then finds the Guest already gone.
        {
          const f = await seedJointWithGuest(`ar-first-${path}`);
          const { hold, atHold, open } = holdOpen();
          const archiving = settle(archive(f, hold));
          await atHold;
          const removing = settle(removeMember(f.host.id, f.guest.id));
          await untilBlocked(observer, 1);
          open();
          const [archived, removed] = await Promise.all([archiving, removing]);
          assert.ok(!/deadlock/i.test(`${describe(removed)} ${describe(archived)}`), `archive first (${path}): ${describe(archived)} / ${describe(removed)}`);
          assert.equal(archived.ok, true, `archive first (${path}): archive ${describe(archived)}`);
          assert.equal(removed.ok, true, `archive first (${path}): removal ${describe(removed)}`);
          await assertGuestGone(f, `archive first (${path})`);
        }
      }

      // The Guest marks the joint channel read (a read mutation through
      // prepareJointReadFanout) against the archive. The read takes its
      // member row before the channel rows' FOR KEY SHARE elsewhere (the
      // admission fence); the archive's channel locks are FOR NO KEY UPDATE
      // and the fan-out takes the channel rows before the member rows, so
      // neither order closes a cycle.
      for (const [label, at] of [
        // Paused where the fan-out locks the local channel rows.
        ["at the fan-out's channel lock", (text: string) => text.includes("SELECT id FROM channels WHERE id=ANY(") && text.includes("FOR KEY SHARE")],
        // Paused after the fan-out holds the channel and member rows.
        ["after the fan-out's member lock", (text: string) => text.includes("storage.type='thread'") && text.includes("JOIN messages parent")],
      ] as const) {
        const f = await seedJointWithGuest(`read-${label.length}`);
        const message = await createMessage(f.canonicalId, "user", f.owner.id, "read me");
        const pause = pauseQuery((text) => at(text));
        try {
          const reading = settle(markRead(f.guest.id, f.channelId, Number(message.seq)));
          await pause.atPause;
          const archiving = settle(archive0(f));
          // The archive either waits on the reader (observed) or, holding
          // nothing the reader has, finishes first.
          const deadline = Date.now() + 10_000;
          let waited = false;
          while (Date.now() < deadline) {
            if ((await blockedPids(observer)).length > 0) { waited = true; break; }
            if (await Promise.race([archiving.then(() => true), new Promise<false>((resolve) => setTimeout(() => resolve(false), 20))])) break;
          }
          pause.release();
          const [read, archived] = await Promise.all([reading, archiving]);
          assert.ok(!/deadlock/i.test(`${describe(read)} ${describe(archived)}`), `read vs archive (${label}): ${describe(read)} / ${describe(archived)}`);
          assert.equal(archived.ok, true, `read vs archive (${label}): archive ${describe(archived)}`);
          if (label === "after the fan-out's member lock") assert.ok(waited, `read vs archive (${label}): the archive waits on the reader's member row`);
          await assertGuestGone(f, `read vs archive (${label})`);
        } finally {
          pause.restore();
        }
      }

      // The Guest leaving the joint channel, or the host removing it
      // (removeHuman), against that Guest marking the channel read. The read's
      // admission holds the Guest's member row and then asks for the channel
      // FOR KEY SHARE; the removal locks the joint channel row FOR NO KEY
      // UPDATE (never FOR UPDATE: a joint removal deletes no channel) and then
      // waits on the member row, so the read finishes first.
      const removals: Array<[string, (f: F) => Promise<unknown>]> = [
        ["self-leave", (f) => removeHuman(f.channelId, f.guest.id, { self: true })],
        ["host removal", (f) => withLockedChannelActorCapability({
          serverId: f.host.id, channelId: f.channelId, actorType: "user", actorId: f.owner.id,
          capability: "removeChannelMembers", humanSubjectIds: [f.guest.id],
        }, (tx, context) => removeHuman(f.channelId, f.guest.id, context, tx))],
      ];
      for (const [label, remove] of removals) {
        const f = await seedJointWithGuest(`rm-read-${label.length}`);
        const message = await createMessage(f.canonicalId, "user", f.owner.id, "read me");
        // The admission's scope lock: after its member-row fence, before the channel's FOR KEY SHARE.
        const pause = pauseQuery((text, values) => text.includes("FROM channels c") && text.includes("FOR KEY SHARE") && values.includes(f.channelId));
        try {
          const reading = settle(markRead(f.guest.id, f.channelId, Number(message.seq)));
          await pause.atPause;
          const removing = settle(remove(f));
          await Promise.race([untilBlocked(observer, 1), removing.then((outcome) => {
            throw new Error(`${label} vs read: the removal did not wait: ${describe(outcome)}`);
          })]);
          pause.release();
          const [read, removed] = await Promise.all([reading, removing]);
          assert.ok(!/deadlock/i.test(`${describe(read)} ${describe(removed)}`), `${label} vs read: ${describe(read)} / ${describe(removed)}`);
          assert.equal(removed.ok, true, `${label} vs read: removal ${describe(removed)}`);
          assert.equal((await getDb().select().from(serverMembers)
            .where(and(eq(serverMembers.serverId, f.host.id), eq(serverMembers.userId, f.guest.id)))).length, 0, `${label}: the Guest left the host`);
          assert.equal((await getDb().select().from(jointChannelMembers)
            .where(and(eq(jointChannelMembers.jointChannelId, f.jointId), eq(jointChannelMembers.userId, f.guest.id)))).length, 0, `${label}: and the joint`);
        } finally {
          pause.restore();
        }
      }

      // An admitted joint Guest retrying its invite acceptance (idempotent:
      // projection channel row, then its member row) against its own
      // mark-read (member row, then the channel FOR KEY SHARE): the retry
      // locks the joint projection FOR NO KEY UPDATE, so the read finishes.
      {
        const f = await seedJointWithGuest("accept-retry");
        const token = randomBytes(32).toString("hex");
        await getDb().insert(channelExternalInvites).values({
          channelId: f.channelId, hostServerId: f.host.id, email: f.guest.email,
          tokenHash: createHash("sha256").update(token).digest("hex"), invitedByUserId: f.owner.id,
          expiresAt: new Date(Date.now() + 86_400_000), status: "accepted", outcome: "guest", acceptedUserId: f.guest.id,
        });
        const message = await createMessage(f.canonicalId, "user", f.owner.id, "read me");
        const pause = pauseQuery((text, values) => text.includes("FROM channels c") && text.includes("FOR KEY SHARE") && values.includes(f.channelId));
        try {
          const reading = settle(markRead(f.guest.id, f.channelId, Number(message.seq)));
          await pause.atPause;
          const retrying = settle(acceptExternalInviteAsGuest(token, f.guest.id));
          await Promise.race([untilBlocked(observer, 1), retrying.then((outcome) => {
            throw new Error(`accept retry vs read: the retry did not wait: ${describe(outcome)}`);
          })]);
          pause.release();
          const [read, retried] = await Promise.all([reading, retrying]);
          assert.ok(!/deadlock/i.test(`${describe(read)} ${describe(retried)}`), `accept retry vs read: ${describe(read)} / ${describe(retried)}`);
          assert.equal(read.ok, true, `accept retry vs read: read ${describe(read)}`);
          assert.equal(retried.ok, true, `accept retry vs read: retry ${describe(retried)}`);
          assert.deepEqual(retried.ok && retried.value, { serverId: f.host.id, channelId: f.channelId, joined: false });
        } finally {
          pause.restore();
        }
      }
    } finally {
      uninstallQueryPauseHook();
      if (app) await app.close();
      if (observer) await observer.end();
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`).catch(() => {});
      await admin.end();
    }
  },
  600_000,
);
