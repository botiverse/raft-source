// Real connections prove that revocation and delegated-message persistence
// serialize; the API regression separately exercises the complete forward route.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { asServerId } from "@botiverse/raft-shared";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { closeDatabase, getDb, initDatabase } from "../db/index";
import { agents, channels, channelHumans, messages, serverMembers, servers, users } from "../db/schema";
import { lockActorMembershipRow } from "../lib/actorMembershipFence";
import { migrateRealPgTestDatabase } from "../test/integration/realPgMigrate";
import { AssistantSendAsOwnerError, lockAssistantDelegatedMessageAuthority } from "./assistantDelegatedMessageAuthority";
import { withChannelWriterFence } from "./channelConversionFenceService";
import { persistForwardBundle } from "./attachmentForwardService";
import { buildForwardedBundleMetadata } from "./messageForwardService";
import { createMessage } from "./messageService";
import { deleteAgent } from "./agentService";
import { removeMemberInTransaction } from "./serverService";

const url = process.env.CHANNEL_CONVERSION_REAL_PG_URL;
const required = process.env.CHANNEL_CONVERSION_REAL_PG_REQUIRED === "1";
const realTest = test.skipIf(!url && !required);

async function withRealPg(run: (pool: pg.Pool) => Promise<void>) {
  assert.ok(url, "CHANNEL_CONVERSION_REAL_PG_URL is required");
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  await migrateRealPgTestDatabase(pool, fileURLToPath(new URL("../../drizzle", import.meta.url)));
  await initDatabase(url);
  try { await run(pool); } finally { await closeDatabase(); await pool.end(); }
}

async function fixture() {
  const suffix = randomUUID();
  const [owner] = await getDb().insert(users).values({ name: `owner-${suffix}`, email: `${suffix}@example.test`, passwordHash: "unused-synthetic-fixture" }).returning();
  const [server] = await getDb().insert(servers).values({ name: "delegation test", slug: `delegation-${suffix}`, ownerId: owner.id }).returning();
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });
  const [channel] = await getDb().insert(channels).values({ serverId: server.id, name: `room-${suffix}` }).returning();
  const [assistant] = await getDb().insert(agents).values({ serverId: server.id, name: `assistant-${suffix}`, assistantOwnerUserId: owner.id, assistantSendAsOwner: true }).returning();
  return { serverId: server.id, ownerUserId: owner.id, agentId: assistant.id, channelId: channel.id };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function waitBlocked(pool: pg.Pool, pid: number) {
  for (let i = 0; i < 100; i++) {
    const { rows } = await pool.query<{ blocked: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked", [pid]);
    if (rows[0]?.blocked) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail("competing transaction did not block on the admitted send");
}

realTest("committed opt-out wins against a waiting delegated message", async () => {
  await withRealPg(async pool => {
    const f = await fixture();
    const owner = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await owner.query("BEGIN");
      const { rows: [{ pid }] } = await owner.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await owner.query("UPDATE agents SET assistant_send_as_owner=false WHERE id=$1", [f.agentId]);
      pending = withChannelWriterFence(f.channelId, async tx => {
        await lockAssistantDelegatedMessageAuthority(tx, f);
        return createMessage(f.channelId, "user", f.ownerUserId, "must not persist", "chat", undefined, { delegatedByAgentId: f.agentId }, tx);
      });
      const refusal = assert.rejects(pending, (error: unknown) => error instanceof AssistantSendAsOwnerError && error.code === "assistant_send_as_owner_off");
      await waitBlocked(pool, pid);
      await owner.query("COMMIT");
      await refusal;
      assert.equal((await getDb().select().from(messages).where(eq(messages.delegatedByAgentId, f.agentId))).length, 0);
    } finally { await owner.query("ROLLBACK"); owner.release(); await pending?.catch(() => {}); }
  });
}, 60_000);

for (const revocation of ["opt-out", "archive", "remove-owner"] as const) {
  realTest(`admitted send commits before a concurrent ${revocation}, without a lock cycle`, async () => {
    await withRealPg(async pool => {
      const f = await fixture();
      const release = gate(); const admitted = gate();
      let holderPid = 0;
      const send = withChannelWriterFence(f.channelId, async tx => {
        await lockAssistantDelegatedMessageAuthority(tx, f);
        const pid = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        holderPid = pid.rows[0]!.pid;
        const message = await createMessage(f.channelId, "user", f.ownerUserId, "admitted first", "chat", undefined, { delegatedByAgentId: f.agentId }, tx);
        admitted.release(); await release.promise;
        return message;
      });
      let revoke: Promise<unknown> | undefined;
      try {
        await admitted.promise;
        revoke = getDb().transaction(async tx => {
          if (revocation === "remove-owner") return removeMemberInTransaction(tx, f.serverId, f.ownerUserId);
          await lockActorMembershipRow(tx, f.serverId, f.ownerUserId);
          await tx.select().from(agents).where(eq(agents.id, f.agentId)).for("update");
          if (revocation === "archive") return deleteAgent(f.agentId, { executor: tx });
          return tx.update(agents).set({ assistantSendAsOwner: false }).where(eq(agents.id, f.agentId));
        });
        await waitBlocked(pool, holderPid);
        release.release();
        const [message] = await Promise.all([send, revoke]);
        assert.equal(message.delegatedByAgentId, f.agentId);
        await assert.rejects(withChannelWriterFence(f.channelId, tx => lockAssistantDelegatedMessageAuthority(tx, f)), AssistantSendAsOwnerError);
      } finally { release.release(); await Promise.allSettled([send, ...(revoke ? [revoke] : [])]); }
    });
  }, 60_000);
}

realTest("unlinked or foreign assistant authority never authorizes a new message", async () => {
  await withRealPg(async () => {
    const f = await fixture();
    await getDb().update(agents).set({ assistantOwnerUserId: null }).where(eq(agents.id, f.agentId));
    await assert.rejects(withChannelWriterFence(f.channelId, tx => lockAssistantDelegatedMessageAuthority(tx, f)), AssistantSendAsOwnerError);
    await getDb().update(agents).set({ assistantOwnerUserId: f.ownerUserId }).where(eq(agents.id, f.agentId));
    const foreign = await fixture();
    await assert.rejects(withChannelWriterFence(foreign.channelId, tx => lockAssistantDelegatedMessageAuthority(tx, { ...foreign, agentId: f.agentId })), AssistantSendAsOwnerError);
  });
}, 60_000);

realTest("two delegated sends share authority without serializing each other", async () => {
  await withRealPg(async () => {
    const f = await fixture(); const admitted = gate(); const release = gate();
    const first = withChannelWriterFence(f.channelId, async tx => {
      await lockAssistantDelegatedMessageAuthority(tx, f);
      admitted.release(); await release.promise;
    });
    try {
      await admitted.promise;
      await withChannelWriterFence(f.channelId, tx => lockAssistantDelegatedMessageAuthority(tx, f));
    } finally { release.release(); await first; }
  });
}, 60_000);

realTest("actual forward persistence takes Server before member when a role writer already holds Server", async () => {
  await withRealPg(async pool => {
    const f = await fixture();
    await getDb().insert(channelHumans).values({ channelId: f.channelId, userId: f.ownerUserId });
    const source = await createMessage(f.channelId, "user", f.ownerUserId, "synthetic forward source");
    const metadata = await buildForwardedBundleMetadata({ serverId: asServerId(f.serverId), forwarderUserId: f.ownerUserId, delegatedByAgentId: f.agentId, sourceMessageIds: [source.id] });
    const owner = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await owner.query("BEGIN");
      await owner.query("SET LOCAL lock_timeout='2s'");
      const { rows: [{ pid }] } = await owner.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await owner.query("SELECT id FROM servers WHERE id=$1 FOR UPDATE", [f.serverId]);
      pending = persistForwardBundle({ destinationStorageChannelId: f.channelId, destinationRequestChannelId: f.channelId, senderId: f.ownerUserId, content: "forwarded", randomId: randomUUID(), sourceMessageIds: [source.id], requestServerId: f.serverId, metadata: { ...metadata, kind: "forwarded-bundle" }, delegatedByAgentId: f.agentId });
      await waitBlocked(pool, pid);
      // This must succeed while the forward waits on Server. Taking member
      // first in the forward would form a cycle here (or hit lock_timeout).
      await owner.query("SELECT user_id FROM server_members WHERE server_id=$1 AND user_id=$2 FOR UPDATE", [f.serverId, f.ownerUserId]);
      await owner.query("COMMIT");
      const persisted = await pending as Awaited<ReturnType<typeof persistForwardBundle>>;
      assert.equal(persisted.message.delegatedByAgentId, f.agentId);
    } finally { await owner.query("ROLLBACK"); owner.release(); await pending?.catch(() => {}); }
  });
}, 60_000);
