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
import { channelExternalInvites, channelHumans, channels, featureFlagRules, featureFlags, serverInvites, serverMembers, servers, users } from "../db/schema";
import { openTestApp as startTestApp } from "../test/integration/app";
import { seedBoundGuest } from "../test/guestFixture";
import { createChannel, updateChannel } from "./channelService";
import { EXTERNAL_CHANNEL_MAX_SLOTS, ExternalChannelLimitError } from "./externalChannelLimitService";
import { acceptExternalInviteAsGuest, ExternalInviteAcceptError } from "./externalInviteService";
import { acceptInvite } from "./inviteService";
import { createServer, removeMember } from "./serverService";

// Two accepts against one host Server at once (#wg-rbac:#16, P2a-2, Cody).
// PGlite runs one transaction at a time and cannot show the lock waits; real
// PG can. Each case parks the first accept on its invite row (locked last)
// while it holds the channel and the host's accept lock, and checks the
// second waits for it instead of deciding beside its uncommitted writes.

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

async function blockedCount(observer: pg.Pool): Promise<number> {
  const result = await observer.query(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0",
  );
  return result.rows[0].n as number;
}

async function untilBlocked(observer: pg.Pool, n: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await blockedCount(observer) >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`expected ${n} blocked sessions`);
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

async function seedHost(plan: "free" | "pro") {
  const owner = await seedUser("host-owner");
  const server = await createServer("Host", `host-${randomUUID().slice(0, 8)}`, owner.id);
  await getDb().update(servers).set({ plan }).where(eq(servers.id, server.id));
  await getDb().insert(featureFlags)
    .values({ key: EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: false })
    .onConflictDoNothing();
  await getDb().insert(featureFlagRules).values({
    id: randomUUID(), flagKey: EXTERNAL_CHANNELS_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [server.id],
  });
  const channel = () => createChannel(server.id, `room-${randomUUID().slice(0, 8)}`, undefined, "private", { type: "user", id: owner.id });
  return { owner, server, channel };
}

async function seedInvite(host: Awaited<ReturnType<typeof seedHost>>, channelId: string, email: string) {
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

async function seedServerInvite(host: Awaited<ReturnType<typeof seedHost>>, email: string) {
  const token = randomBytes(32).toString("hex");
  const [row] = await getDb().insert(serverInvites).values({
    serverId: host.server.id,
    invitedEmail: email,
    invitedByUserId: host.owner.id,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + 86_400_000),
  }).returning({ id: serverInvites.id });
  return { id: row!.id, token };
}

async function roleOf(serverId: string, userId: string) {
  const [row] = await getDb().select({ role: serverMembers.role, guestChannelId: serverMembers.guestChannelId }).from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
  return row ?? null;
}

async function serverInviteStatus(id: string) {
  const [row] = await getDb().select({ status: serverInvites.status }).from(serverInvites).where(eq(serverInvites.id, id));
  return row?.status;
}

function settle<T>(promise: Promise<T>) {
  return promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
}

test.skipIf(!REAL_PG_URL && !REAL_PG_REQUIRED)(
  "admissions to one host serialize: one person's two channels, two people for the last slot, a server invite against an external one, against a promotion by hand and against a removal, and making the channel public against an accept",
  async () => {
    assert.ok(REAL_PG_URL, `${REAL_PG_URL_ENV} is required`);
    const databaseName = `slock_external_accept_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "external-accept-admin" });
    let setupPool: pg.Pool | undefined;
    let observer: pg.Pool | undefined;
    let holder: pg.PoolClient | undefined;
    let app: Awaited<ReturnType<typeof startTestApp>> | undefined;
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const testUrl = databaseUrlFor(REAL_PG_URL, databaseName);
      setupPool = new pg.Pool({ connectionString: testUrl, application_name: "external-accept-setup", max: 2 });
      await migrate(drizzle(setupPool, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
      await setupPool.end();
      setupPool = undefined;
      app = await startTestApp(testUrl, 0, { humanActivityMuteFlagDefaultEnabled: true });
      observer = new pg.Pool({ connectionString: testUrl, application_name: "external-accept-observer", max: 2 });

      // Parks an accept on its invite row, the last lock it takes.
      const park = async (inviteId: string) => {
        holder = await observer!.connect();
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM channel_external_invites WHERE id = $1 FOR UPDATE", [inviteId]);
      };
      const release = async () => {
        await holder!.query("ROLLBACK");
        holder!.release();
        holder = undefined;
      };

      // One person, two channels of a paid host (the free plan's rule would refuse the second anyway).
      {
        const host = await seedHost("pro");
        const [a, b] = [await host.channel(), await host.channel()];
        const person = await seedUser("twice");
        const toA = await seedInvite(host, a.id, person.email);
        const toB = await seedInvite(host, b.id, person.email);
        await park(toA.id);
        const first = settle(acceptExternalInviteAsGuest(toA.token, person.id));
        await untilBlocked(observer, 1);
        // B's channel is free; only the host's accept lock can hold it back.
        const second = settle(acceptExternalInviteAsGuest(toB.token, person.id));
        await untilBlocked(observer, 2);
        await release();
        const [one, two] = await Promise.all([first, second]);
        assert.equal(one.ok, true, `the first accept failed: ${!one.ok && String(one.error)}`);
        assert.ok(!two.ok && two.error instanceof ExternalInviteAcceptError && two.error.code === "guest_elsewhere", `second: ${!two.ok ? String(two.error) : "succeeded"}`);
        const rows = await getDb().select({ guestChannelId: serverMembers.guestChannelId }).from(serverMembers)
          .where(and(eq(serverMembers.serverId, host.server.id), eq(serverMembers.userId, person.id)));
        assert.deepEqual(rows, [{ guestChannelId: a.id }]);
        const inB = await getDb().select().from(channelHumans).where(and(eq(channelHumans.channelId, b.id), eq(channelHumans.userId, person.id)));
        assert.equal(inB.length, 0, "never a member of a channel it is not bound to");
      }

      // Two people, the channel's last slot.
      {
        const host = await seedHost("pro");
        const room = await host.channel();
        for (let index = 0; index < EXTERNAL_CHANNEL_MAX_SLOTS - 2; index += 1) {
          await seedBoundGuest({ serverId: host.server.id, userId: (await seedUser(`filler-${index}`)).id, channelId: room.id });
        }
        const one = await seedUser("one");
        const two = await seedUser("two");
        const inviteOne = await seedInvite(host, room.id, one.email);
        const inviteTwo = await seedInvite(host, room.id, two.email);
        await park(inviteOne.id);
        const first = settle(acceptExternalInviteAsGuest(inviteOne.token, one.id));
        await untilBlocked(observer, 1);
        const second = settle(acceptExternalInviteAsGuest(inviteTwo.token, two.id));
        await untilBlocked(observer, 2);
        await release();
        const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
        assert.equal(firstOutcome.ok, true, `the first accept failed: ${!firstOutcome.ok && String(firstOutcome.error)}`);
        assert.ok(
          !secondOutcome.ok && secondOutcome.error instanceof ExternalChannelLimitError && secondOutcome.error.code === "channel_full",
          `second: ${!secondOutcome.ok ? String(secondOutcome.error) : "succeeded"}`,
        );
        const guests = await getDb().select().from(serverMembers).where(eq(serverMembers.guestChannelId, room.id));
        assert.equal(guests.length + 1, EXTERNAL_CHANNEL_MAX_SLOTS);
      }
      // Cody's race 1: a server invite and an external invite of one person at
      // once. The external accept is parked right after inserting the Guest
      // (addMember then clears their departure row, held here); the server
      // invite must not decide "not a member" beside that uncommitted Guest
      // and then take the conflicting insert for success.
      {
        const host = await seedHost("free");
        const room = await host.channel();
        const person = await seedUser("both");
        const external = await seedInvite(host, room.id, person.email);
        const normal = await seedServerInvite(host, person.email);
        await observer.query("INSERT INTO server_membership_departures (server_id, user_id, reason) VALUES ($1, $2, 'left')", [host.server.id, person.id]);
        holder = await observer.connect();
        await holder.query("BEGIN");
        await holder.query("SELECT user_id FROM server_membership_departures WHERE server_id = $1 AND user_id = $2 FOR UPDATE", [host.server.id, person.id]);
        const asGuest = settle(acceptExternalInviteAsGuest(external.token, person.id));
        await untilBlocked(observer, 1);
        const asMember = settle(acceptInvite(normal.token, person.id));
        await untilBlocked(observer, 2);
        await release();
        const [guestOutcome, memberOutcome] = await Promise.all([asGuest, asMember]);
        assert.equal(guestOutcome.ok, true, `external accept: ${!guestOutcome.ok && String(guestOutcome.error)}`);
        const finalRole = await roleOf(host.server.id, person.id);
        const normalStatus = await serverInviteStatus(normal.id);
        assert.ok(
          !(normalStatus === "accepted" && finalRole?.role === "guest"),
          `the server invite was used and they stayed a Guest (${JSON.stringify({ memberOutcome, finalRole, normalStatus })})`,
        );
        // Serialized, the server invite runs second and promotes the new Guest.
        assert.equal(memberOutcome.ok, true, `server invite: ${!memberOutcome.ok && String(memberOutcome.error)}`);
        assert.deepEqual(finalRole, { role: "member", guestChannelId: null });
        assert.equal(normalStatus, "accepted");
      }

      // Cody's race 2: a Guest's server-invite promotion against a promotion to
      // admin by hand that commits first. The admin stays admin; the invite is
      // refused and not used.
      {
        const host = await seedHost("free");
        const room = await host.channel();
        const person = await seedUser("promoted");
        await seedBoundGuest({ serverId: host.server.id, userId: person.id, channelId: room.id });
        const normal = await seedServerInvite(host, person.email);
        holder = await observer.connect();
        await holder.query("BEGIN");
        // What transitionMemberRole does first: the server row, then the member row.
        await holder.query("SELECT id FROM servers WHERE id = $1 FOR UPDATE", [host.server.id]);
        await holder.query("UPDATE server_members SET role = 'admin', guest_channel_id = NULL WHERE server_id = $1 AND user_id = $2", [host.server.id, person.id]);
        const accepting = settle(acceptInvite(normal.token, person.id));
        await untilBlocked(observer, 1);
        await holder.query("COMMIT");
        holder.release();
        holder = undefined;
        const outcome = await accepting;
        assert.ok(!outcome.ok && /already a member/.test(String(outcome.error)), `accept: ${outcome.ok ? JSON.stringify(outcome.value) : String(outcome.error)}`);
        assert.deepEqual(await roleOf(host.server.id, person.id), { role: "admin", guestChannelId: null });
        assert.equal(await serverInviteStatus(normal.id), "pending");
      }

      // A Guest's removal (server FOR SHARE, then its member row) against its
      // server-invite promotion (server FOR UPDATE first, never upgraded from
      // FOR SHARE): one waits for the other, neither deadlocks.
      {
        const host = await seedHost("free");
        const room = await host.channel();
        const person = await seedUser("leaving");
        await seedBoundGuest({ serverId: host.server.id, userId: person.id, channelId: room.id });
        const normal = await seedServerInvite(host, person.email);
        holder = await observer.connect();
        await holder.query("BEGIN");
        await holder.query("SELECT user_id FROM server_members WHERE server_id = $1 AND user_id = $2 FOR UPDATE", [host.server.id, person.id]);
        const removal = settle(removeMember(host.server.id, person.id));
        await untilBlocked(observer, 1);
        const accepting = settle(acceptInvite(normal.token, person.id));
        await untilBlocked(observer, 2);
        await release();
        const [removed, accepted] = await Promise.all([removal, accepting]);
        assert.equal(removed.ok, true, `removal: ${!removed.ok && String(removed.error)}`);
        assert.equal(accepted.ok, true, `accept: ${!accepted.ok && String(accepted.error)}`);
        // Removed first, then let in by the invite as a new member.
        assert.deepEqual(await roleOf(host.server.id, person.id), { role: "member", guestChannelId: null });
        assert.equal(await serverInviteStatus(normal.id), "accepted");
      }
      // Making the channel public against an accept as a Guest: never a public
      // channel with a Guest. The accept is parked holding the channel row.
      {
        const host = await seedHost("free");
        const room = await host.channel();
        const person = await seedUser("visible");
        const invite = await seedInvite(host, room.id, person.email);
        await park(invite.id);
        const accepting = settle(acceptExternalInviteAsGuest(invite.token, person.id));
        await untilBlocked(observer, 1);
        const publishing = settle(updateChannel(room.id, { type: "channel" }));
        await untilBlocked(observer, 2);
        await release();
        const [accepted, published] = await Promise.all([accepting, publishing]);
        const [after] = await getDb().select({ type: channels.type }).from(channels).where(eq(channels.id, room.id));
        const guest = await roleOf(host.server.id, person.id);
        assert.ok(!(after?.type === "channel" && guest), `a public channel with a Guest (${JSON.stringify({ accepted, published, after, guest })})`);
        assert.equal(accepted.ok, true, `accept: ${!accepted.ok && String(accepted.error)}`);
        assert.ok(!published.ok && /stays private/.test(String(published.error)), `make public: ${published.ok ? "succeeded" : String(published.error)}`);
        assert.equal(after?.type, "private");
      }
    } finally {
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
  120_000,
);
