import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { durableTasks, messages, notificationOutbox } from "../db/schema";
import { dbTest as test } from "../test/integration/dbTest";
import { claimExpiredDurableTasks, runDurableTask } from "./durableTasks";
import { serverAdminNoticeRegistry } from "./serverAdminNoticeService";

/**
 * The server-admin notice is retired (cindyz, #wg-rbac:#42 option A): rows of
 * its durable task an earlier release queued, or an older replica queues
 * during the rollout, are completed by recovery without sending anything.
 */
test("queued legacy server.admin_notice tasks (both kinds, a retried one, an unreadable one) complete on recovery and send nothing", async ({ db, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const past = new Date(Date.now() - 60_000);
  const row = (payload: Record<string, unknown>, extra: Partial<typeof durableTasks.$inferInsert> = {}) => ({
    kind: "server.admin_notice",
    payloadVersion: 1,
    payload,
    state: "open" as const,
    attempts: 1,
    maxAttempts: 12,
    // A lost inline run of an older release: its lease ran out.
    claimedBy: `inline:${randomUUID()}`,
    leaseUntil: past,
    createdAt: past,
    updatedAt: past,
    ...extra,
  });
  const inserted = await db.insert(durableTasks).values([
    row({
      serverId: server.id,
      notice: { kind: "joint_server_disconnected_by_host", hostServerName: "Hostco", serverName: "Bravo Labs", channelName: "bravo-side" },
      dedupeKey: randomUUID(),
      excludeUserIds: [],
    }),
    row({
      serverId: server.id,
      notice: { kind: "joint_server_connected_by_member", actorName: "@dana", connectedServerName: "Bravo Labs", channelName: "launch", reachCount: 2 },
      dedupeKey: `${randomUUID()}:${randomUUID()}`,
      excludeUserIds: [owner.id],
    }),
    // Partly failed before (an older release's retry), waiting on its backoff.
    row({
      serverId: server.id,
      notice: { kind: "joint_server_disconnected_by_host", hostServerName: "Hostco", serverName: "Bravo Labs", channelName: "bravo-side" },
      dedupeKey: randomUUID(),
      excludeUserIds: [],
    }, { attempts: 3, claimedBy: null, lastError: "SERVER_ADMIN_NOTICE_PARTIAL" }),
    // A payload no release would decode now: it completes too, it is not parked.
    row({ notice: { kind: "a_kind_never_shipped" } }, { payloadVersion: 2 }),
  ]).returning({ id: durableTasks.id });
  const ids = inserted.map((task) => task.id);

  const claims = await claimExpiredDurableTasks({ workerId: "test-recovery", registry: serverAdminNoticeRegistry, limit: 50 });
  assert.deepEqual(claims.map((claim) => claim.task.id).sort(), [...ids].sort(), "recovery claims every queued row (a known kind)");
  for (const claim of claims) assert.equal(await runDurableTask(claim, serverAdminNoticeRegistry), "succeeded");

  const after = await db.select({ state: durableTasks.state }).from(durableTasks).where(inArray(durableTasks.id, ids));
  assert.deepEqual(after.map((task) => task.state), ids.map(() => "succeeded"), "none open, none needs_attention");
  assert.deepEqual(await db.select({ id: messages.id }).from(messages).where(eq(messages.systemSubtype, "server.admin_notice")), [], "no self-DM notice");
  assert.deepEqual(await db.select({ id: notificationOutbox.id }).from(notificationOutbox).where(eq(notificationOutbox.category, "system_notice")), [], "no device notice");
  assert.deepEqual(await claimExpiredDurableTasks({ workerId: "test-recovery", registry: serverAdminNoticeRegistry, limit: 50, now: new Date(Date.now() + 24 * 60 * 60_000) }), [], "nothing left to run");
});
