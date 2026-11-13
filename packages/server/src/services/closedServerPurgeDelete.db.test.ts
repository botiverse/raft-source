// Closed-server purge, `delete` mode (closedServerPurgeDelete.ts, run by
// closedServerPurge.ts): only the explicit variant deletes; what it deletes
// and keeps, in which order (Artifacts in kept channels too); the lease, the
// eligibility re-check under it, resuming, the run's stop rules, the flag
// re-checked every batch, one server's error backing off only that server,
// old-bucket objects, and that it is safe to run again.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { BasicTracer, MemoryTraceSink, type ServerId } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import {
  agentActivitySummaryV2,
  agents,
  attachmentObjectArtifacts,
  attachmentObjectGcJobs,
  attachmentObjectHolds,
  attachmentObjects,
  attachments,
  attachmentStorageArtifacts,
  channels,
  featureFlags,
  messages,
  messageTranslations,
  objectEvents,
  objectInboxStates,
  serverMembers,
  servers,
  tasks,
} from "../db/schema";
import type { AppPurgeServerOptions, FirstPartyApp } from "../platform/apps";
import { close, DAY_MS, daysAgo, deleteFor, flag, insertMessage, noGuards, NOW, run, seedServer } from "../test/closedServerPurgeFixture";
import { dbTest as test } from "../test/integration/dbTest";
import type { createSeed } from "../test/integration/seed";
import { setDefaultTraceTracer } from "../tracing/semanticTrace";
import { createAgent } from "./agentService";
import {
  CLOSED_SERVER_PURGE_DELETE_SERVER_EVENT,
  CLOSED_SERVER_PURGE_FEATURE_FLAG_KEY,
  CLOSED_SERVER_PURGE_RUN_EVENT,
  closedServerPurgeGuardVerdict,
  memoryClosedServerPurgeState,
  runClosedServerPurge,
  SLOT_PAUSE_BYTES,
  SLOT_RESUME_BYTES,
  SLOT_STOP_BYTES,
  type ClosedServerPurgeDeps,
  type ClosedServerPurgeGuardReading,
} from "./closedServerPurge";
import { createFeatureFlagRule } from "./featureFlagService";
import { registerMachine } from "./machineService";

const MB = 1024 * 1024;

type Seed = ReturnType<typeof createSeed>;

/**
 * seedServer's content (a channel with messages, attachments, tasks, object
 * events; a joint projection with a thread; a receipt channel), plus: a
 * channel whose first message has a translation and an attachment on a
 * new-bucket object, whose second has one on an object with a thumbnail in
 * the old CDN bucket (both held, as the app holds them); a thread under its
 * third message; a task with its own conversation; an agent's activity
 * summary; an Activity row; the server's avatar.
 */
async function seedPurgeable(seed: Seed) {
  const base = await seedServer(seed);
  const db = getDb();
  const { owner, server } = base;
  const channel = await seed.channel({ server, members: [owner] });
  const [m1, m2, m3] = [await insertMessage(channel.id, owner.id, "one"), await insertMessage(channel.id, owner.id, "two"), await insertMessage(channel.id, owner.id, "three")];
  await db.insert(messageTranslations).values({
    serverId: server.id, messageId: m1.id, contentHash: "h", sourceLang: "en", targetLang: "fr",
    provider: "test", providerVersion: "1", placeholderPolicyVersion: "1", status: "translated", translatedContent: "un",
  });

  const object = async (originalKey: string, thumbnailKey: string | null) => {
    const [row] = await db.insert(attachmentObjects).values({ originServerId: server.id, uploaderId: owner.id, uploaderType: "user", storageKey: originalKey, thumbnailKey, mimeType: "image/png", sizeBytes: 10 }).returning();
    const artifacts: Array<{ backend: "attachment" | "cdn"; key: string; role: "original" | "thumbnail" }> = [{ backend: "attachment", key: originalKey, role: "original" }];
    if (thumbnailKey) artifacts.push({ backend: "cdn", key: thumbnailKey, role: "thumbnail" });
    for (const artifact of artifacts) {
      const [stored] = await db.insert(attachmentStorageArtifacts).values({ backend: artifact.backend, storageKey: artifact.key }).returning();
      await db.insert(attachmentObjectArtifacts).values({ objectId: row!.id, artifactId: stored!.id, role: artifact.role });
    }
    return row!;
  };
  const newBucket = await object(`attachments/v2/${server.id}/server/${randomUUID()}`, `content/v2/thumbnails/${randomUUID()}.webp`);
  const oldBucket = await object(`attachments/v2/${server.id}/server/${randomUUID()}`, `thumbnails/${randomUUID()}.webp`);
  for (const [message, obj] of [[m1, newBucket], [m2, oldBucket]] as const) {
    const [attachment] = await db.insert(attachments).values({ objectId: obj.id, messageId: message.id, channelId: channel.id, uploaderId: owner.id, uploaderType: "user", filename: "a.png" }).returning();
    await db.insert(attachmentObjectHolds).values({ holderType: "attachment", holderId: attachment!.id, objectId: obj.id });
  }

  const [thread] = await db.insert(channels).values({ serverId: server.id, name: `thread-${randomUUID().slice(0, 8)}`, type: "thread", parentMessageId: m3.id }).returning();
  await insertMessage(thread!.id, owner.id, "in thread");
  const [task] = await db.insert(tasks).values({ channelId: channel.id, taskNumber: 9, title: "t9", createdByType: "user", createdById: owner.id }).returning();
  const [conversation] = await db.insert(channels).values({ serverId: server.id, name: `task-${randomUUID().slice(0, 8)}`, type: "task", taskId: task!.id }).returning();
  await insertMessage(conversation!.id, owner.id, "in task");

  const { machine } = await registerMachine(server.id, owner.id, "Box");
  const agent = await createAgent(server.id, `purge-agent-${randomUUID().slice(0, 6)}`, { runtime: "codex", machineId: machine.id });
  await db.insert(agentActivitySummaryV2).values({ agentId: agent.id, turnKey: "k1", startedAt: NOW, endedAt: NOW, outcome: "ok", summary: {} as never });
  const [event] = await db.select().from(objectEvents).where(eq(objectEvents.serverId, server.id)).limit(1);
  await db.insert(objectInboxStates).values({
    userId: owner.id, objectKind: event!.objectKind, objectId: event!.objectId, serverId: server.id,
    homeKind: "server", lastEventId: event!.id, lastEventSeq: event!.seq, lastEventAt: NOW,
  });
  await db.update(servers).set({ avatarUrl: `/api/avatars/server-${server.id}/x.webp` }).where(eq(servers.id, server.id));

  return { ...base, channel, thread: thread!, conversation: conversation!, objects: { newBucket, oldBucket } };
}

/** Every row of the server the purge would touch, and the rows it keeps. */
async function serverSnapshot(serverId: string) {
  const db = getDb();
  const channelIds = (await db.select({ id: channels.id }).from(channels).where(eq(channels.serverId, serverId))).map((row) => row.id).sort();
  const count = async (rows: Promise<Array<{ n: number }>>) => Number((await rows)[0]!.n);
  const n = sql<number>`count(*)::int`;
  return {
    channels: channelIds,
    messages: channelIds.length ? await count(db.select({ n }).from(messages).where(inArray(messages.channelId, channelIds))) : 0,
    attachments: channelIds.length ? await count(db.select({ n }).from(attachments).where(inArray(attachments.channelId, channelIds))) : 0,
    tasks: channelIds.length ? await count(db.select({ n }).from(tasks).where(inArray(tasks.channelId, channelIds))) : 0,
    translations: await count(db.select({ n }).from(messageTranslations).where(eq(messageTranslations.serverId, serverId))),
    objectEvents: await count(db.select({ n }).from(objectEvents).where(eq(objectEvents.serverId, serverId))),
    inboxStates: await count(db.select({ n }).from(objectInboxStates).where(eq(objectInboxStates.serverId, serverId))),
    gcJobs: await count(db.select({ n }).from(attachmentObjectGcJobs).innerJoin(attachmentObjects, eq(attachmentObjects.id, attachmentObjectGcJobs.objectId)).where(eq(attachmentObjects.originServerId, serverId))),
    server: (await db.select({ name: servers.name, slug: servers.slug, avatarUrl: servers.avatarUrl, purgedAt: servers.purgedAt, purgeState: servers.purgeState }).from(servers).where(eq(servers.id, serverId)))[0],
  };
}

function withTracer<T>(work: (sink: MemoryTraceSink) => Promise<T>): Promise<T> {
  const sink = new MemoryTraceSink();
  setDefaultTraceTracer(new BasicTracer({ sink }));
  return work(sink).finally(() => setDefaultTraceTracer(null));
}

const eventsNamed = (sink: MemoryTraceSink, name: string) => sink.getAllLogEvents().filter((event) => event.name === name);

test("only the variant `delete` deletes: none and `count` leave the server as it is; `delete` clears it and keeps what the design keeps", async ({ seed }) => {
  const old = await seedPurgeable(seed);
  const recent = await seedPurgeable(seed);
  const live = await seedPurgeable(seed);
  await close(old.server.id, daysAgo(31));
  await close(recent.server.id, daysAgo(29));
  const before = await serverSnapshot(old.server.id);
  const recentBefore = await serverSnapshot(recent.server.id);
  const liveBefore = await serverSnapshot(live.server.id);
  const storageBefore = await serverSnapshot(old.storage.id);

  for (const variant of [null, "count"]) {
    await flag(variant);
    const result = await run();
    assert.equal(result.purged.length, 0, `variant ${variant}: nothing claimed`);
    assert.deepEqual(await serverSnapshot(old.server.id), before, `variant ${variant}: nothing deleted`);
  }

  await deleteFor(old.server.id, recent.server.id, live.server.id);
  const { result, sink } = await withTracer(async (sink) => ({ result: await run(), sink }));
  assert.equal(result.stoppedReason, "pass_done");
  const entry = result.purged.find((purged) => purged.serverId === old.serverId)!;
  assert.equal(entry.outcome, "done");
  assert.ok(!result.purged.some((purged) => purged.serverId === recent.serverId || purged.serverId === live.serverId), "29 days, or live: never claimed");

  const after = await serverSnapshot(old.server.id);
  const kept = [...old.skipped.joint, ...old.skipped.receipt].sort();
  assert.deepEqual(after.channels, kept, "only the joint projection (and its thread) and the receipt channel are left");
  assert.equal(after.messages, 4, "their messages stay: 2 + 1 in the joint projection and its thread, 1 in the receipt channel");
  assert.equal(after.attachments, 0);
  assert.equal(after.tasks, 0);
  assert.equal(after.translations, 0);
  assert.equal(after.objectEvents, 0);
  assert.equal(after.inboxStates, 0);
  assert.deepEqual(after.server, { name: "Closed server", slug: before.server!.slug, avatarUrl: null, purgedAt: NOW, purgeState: "done" }, "the tombstone: scrubbed, slug kept; purged (the finish: closedServerPurgeFinish.db.test.ts)");
  const [lease] = await getDb().select({ until: servers.purgeLeaseUntil, token: servers.purgeLeaseToken }).from(servers).where(eq(servers.id, old.server.id));
  assert.deepEqual(lease, { until: null, token: null }, "done: the lease released");
  const summaries = await getDb().select({ id: agentActivitySummaryV2.id }).from(agentActivitySummaryV2)
    .innerJoin(agents, eq(agents.id, agentActivitySummaryV2.agentId)).where(eq(agents.serverId, old.server.id));
  assert.equal(summaries.length, 0, "the agents' activity summaries are gone");

  // Objects: both queued for the GC with no hold left, the one with an old-bucket copy too (the old bucket is treated as gone).
  const objects = await getDb().select({ id: attachmentObjects.id, state: attachmentObjects.lifecycleState }).from(attachmentObjects)
    .where(inArray(attachmentObjects.id, [old.objects.newBucket.id, old.objects.oldBucket.id]));
  assert.deepEqual(new Map(objects.map((row) => [row.id, row.state])), new Map([[old.objects.newBucket.id, "gc_pending"], [old.objects.oldBucket.id, "gc_pending"]]));
  const holds = await getDb().select().from(attachmentObjectHolds).where(inArray(attachmentObjectHolds.objectId, [old.objects.newBucket.id, old.objects.oldBucket.id]));
  assert.equal(holds.length, 0, "holds removed for both");
  assert.equal(entry.counts.attachment_objects_skipped_old_bucket, undefined, "no object is left for its old-bucket copy");
  assert.ok((entry.counts.attachment_objects_gc_queued ?? 0) >= 4, "both objects and seedServer's two");
  assert.equal(entry.counts.old_bucket_avatars_skipped, 1, "the server's avatar, in the old CDN bucket, is counted, not deleted");
  assert.equal(entry.counts.channels_skipped_joint, 2);
  assert.equal(entry.counts.channels_skipped_receipt, 1);
  assert.equal(entry.counts.agent_activity_summaries_deleted, 1);
  assert.equal(entry.counts.messages_deleted, before.messages - 4);

  // The other servers, and the joint storage server, are untouched.
  assert.deepEqual(await serverSnapshot(recent.server.id), recentBefore);
  assert.deepEqual(await serverSnapshot(live.server.id), liveBefore);
  assert.deepEqual(await serverSnapshot(old.storage.id), storageBefore);

  const [event] = eventsNamed(sink, CLOSED_SERVER_PURGE_DELETE_SERVER_EVENT).filter((logged) => logged.attrs?.server_id === old.serverId);
  assert.equal(event!.attrs?.outcome, "done");
  assert.equal(event!.attrs?.messages_deleted, entry.counts.messages_deleted);
  for (const [key, value] of Object.entries(event!.attrs ?? {})) {
    assert.ok(typeof value === "number" || ["server_id", "outcome", "purge_state", "stop_reason", "error_class", "sqlstate"].includes(key), `ids and numbers only, no content or names: ${key}`);
  }
  const [finished] = eventsNamed(sink, CLOSED_SERVER_PURGE_RUN_EVENT);
  assert.equal(finished!.attrs?.servers_done, 1);
  assert.equal(finished!.attrs?.servers_in_rows_deleted, 0, "passed through rows_deleted to done");
  assert.equal(finished!.attrs?.messages_deleted, entry.counts.messages_deleted);
});

test("apps go first, with `delete`, batch by batch until nothing is left", async ({ seed }) => {
  const old = await seedPurgeable(seed);
  await close(old.server.id, daysAgo(40));
  await deleteFor(old.server.id);
  const calls: Array<{ mode: string; channelsLeft: number }> = [];
  const app = {
    id: "fake-app",
    purgeServer: async (serverId: ServerId, options: { mode: string }) => {
      const rows = await getDb().select({ id: channels.id }).from(channels).where(eq(channels.serverId, serverId));
      calls.push({ mode: options.mode, channelsLeft: rows.length });
      return { remaining: calls.length < 2, counts: { items: 3 } };
    },
  } as unknown as FirstPartyApp;
  const result = await run({ apps: [app] });
  const entry = result.purged.find((purged) => purged.serverId === old.serverId)!;
  assert.equal(entry.outcome, "done");
  assert.equal(calls.length, 2, "called again while it said something remained");
  assert.ok(calls.every((call) => call.mode === "delete" && call.channelsLeft > 3), "before the channel pass");
  assert.equal(entry.counts.app_fake_app_items, 6);
});

test("an object's bytes are queued only in the commit that removed every row derived from it", async ({ seed }) => {
  const old = await seedPurgeable(seed);
  await close(old.server.id, daysAgo(40));
  await deleteFor(old.server.id);
  const db = getDb();
  let checks = 0;
  // Called before every batch: whatever is queued for the GC by then has no attachment, message or translation left.
  const readGuards = async (): Promise<ClosedServerPurgeGuardReading> => {
    const queued = await db.select({ id: attachmentObjects.id }).from(attachmentObjects)
      .where(and(eq(attachmentObjects.originServerId, old.server.id), isNotNull(attachmentObjects.gcToken)));
    for (const { id } of queued) {
      const linked = await db.select({ messageId: attachments.messageId }).from(attachments).where(eq(attachments.objectId, id));
      assert.equal(linked.length, 0, "no attachment of a queued object");
    }
    if (queued.some((row) => row.id === old.objects.newBucket.id)) {
      const [translations] = await db.select({ n: sql<number>`count(*)::int` }).from(messageTranslations).where(eq(messageTranslations.serverId, old.server.id));
      assert.equal(Number(translations!.n), 0, "the translation of its message went first");
    }
    checks += 1;
    return { slot: null, rwOverloadedRecently: false };
  };
  const result = await run({ readGuards, messageBatch: 1 });
  assert.equal(result.purged.find((purged) => purged.serverId === old.serverId)?.outcome, "done");
  assert.ok(checks > 10, "checked at every batch");
});

test("resumes after partial progress: a run stopped by its message cap, then a crashed run's expired lease", async ({ seed }) => {
  const old = await seedPurgeable(seed);
  await close(old.server.id, daysAgo(40));
  await deleteFor(old.server.id);
  const before = await serverSnapshot(old.server.id);

  let appCalls = 0;
  const app = { id: "fake-app", purgeServer: async () => { appCalls += 1; return { remaining: false, counts: {} }; } } as unknown as FirstPartyApp;
  const first = await run({ messageCap: 2, messageBatch: 1, apps: [app] });
  assert.equal(first.stoppedReason, "message_cap");
  const partial = first.purged.find((purged) => purged.serverId === old.serverId)!;
  assert.equal(partial.outcome, "stopped");
  assert.equal(partial.counts.messages_deleted, 2);
  const middle = await serverSnapshot(old.server.id);
  assert.equal(middle.server!.purgeState, "channels");
  assert.equal(middle.messages, before.messages - 2);

  // A run that crashed while holding the server: its lease ran out.
  await getDb().update(servers).set({ purgeLeaseToken: randomUUID(), purgeLeaseUntil: new Date(NOW.getTime() - 1) }).where(eq(servers.id, old.server.id));
  const second = await run({ apps: [app] });
  const done = second.purged.find((purged) => purged.serverId === old.serverId)!;
  assert.equal(done.outcome, "done");
  assert.equal((partial.counts.messages_deleted ?? 0) + (done.counts.messages_deleted ?? 0), before.messages - 4, "every message once");
  assert.equal(appCalls, 1, "the apps step, done in the first run, was not repeated");
  assert.equal((await serverSnapshot(old.server.id)).server!.purgeState, "done");
});

test("the lease: a server another run holds is not touched; a run whose lease was taken over stops", async ({ seed }) => {
  const held = await seedPurgeable(seed);
  const taken = await seedPurgeable(seed);
  await close(held.server.id, daysAgo(40));
  await close(taken.server.id, daysAgo(40));
  await deleteFor(held.server.id, taken.server.id);
  const otherToken = randomUUID();
  await getDb().update(servers).set({ purgeLeaseToken: otherToken, purgeLeaseUntil: new Date(NOW.getTime() + 60_000), purgeState: "channels" }).where(eq(servers.id, held.server.id));
  const heldBefore = await serverSnapshot(held.server.id);
  const takenBefore = await serverSnapshot(taken.server.id);

  const result = await run({
    hooks: {
      afterClaim: async (serverId) => {
        // Another run takes this one over right after the claim.
        if (serverId === taken.serverId) await getDb().update(servers).set({ purgeLeaseToken: randomUUID() }).where(eq(servers.id, serverId));
      },
    },
  });
  assert.ok(!result.purged.some((purged) => purged.serverId === held.serverId), "held elsewhere: not even claimed");
  assert.deepEqual(await serverSnapshot(held.server.id), heldBefore);
  const [heldLease] = await getDb().select({ token: servers.purgeLeaseToken }).from(servers).where(eq(servers.id, held.server.id));
  assert.equal(heldLease!.token, otherToken, "the other run's lease is left alone");
  assert.equal(result.purged.find((purged) => purged.serverId === taken.serverId)?.outcome, "lease_lost");
  const takenAfter = await serverSnapshot(taken.server.id);
  assert.deepEqual({ ...takenAfter, server: undefined }, { ...takenBefore, server: undefined }, "nothing deleted after the lease was lost");
});

test("eligibility is checked again under the lease: a server reopened, or closed less than 30 days ago, after the claim is not touched", async ({ seed }) => {
  const reopened = await seedPurgeable(seed);
  const reclosed = await seedPurgeable(seed);
  await close(reopened.server.id, daysAgo(40));
  await close(reclosed.server.id, daysAgo(40));
  await deleteFor(reopened.server.id, reclosed.server.id);
  const before = { reopened: await serverSnapshot(reopened.server.id), reclosed: await serverSnapshot(reclosed.server.id) };

  const result = await run({
    hooks: {
      afterClaim: async (serverId) => {
        if (serverId === reopened.serverId) await getDb().update(servers).set({ deletedAt: null }).where(eq(servers.id, serverId));
        if (serverId === reclosed.serverId) await close(serverId, daysAgo(10));
      },
    },
  });
  for (const [name, server] of [["reopened", reopened], ["reclosed", reclosed]] as const) {
    assert.equal(result.purged.find((purged) => purged.serverId === server.serverId)?.outcome, "not_eligible", name);
    const after = await serverSnapshot(server.server.id);
    assert.deepEqual({ ...after, server: undefined }, { ...before[name], server: undefined }, `${name}: nothing deleted`);
    const [lease] = await getDb().select({ state: servers.purgeState, until: servers.purgeLeaseUntil, token: servers.purgeLeaseToken, purgedAt: servers.purgedAt }).from(servers).where(eq(servers.id, server.server.id));
    assert.deepEqual(lease, { state: null, until: null, token: null, purgedAt: null }, `${name}: lease released, progress cleared (a later close starts from the apps), not purged`);
  }
});

test("stop rules: the CDC slot (pause with hysteresis, stop, wal_status), RisingWave overload and the budget end the run before any delete", async ({ seed }) => {
  // The verdict on its own.
  const slot = (bytes: number, walStatus = "reserved"): ClosedServerPurgeGuardReading => ({ slot: { retainedWalBytes: bytes, walStatus }, rwOverloadedRecently: false });
  assert.deepEqual(closedServerPurgeGuardVerdict(slot(20 * MB), false), { stop: null, paused: false });
  assert.deepEqual(closedServerPurgeGuardVerdict(slot(SLOT_PAUSE_BYTES + 1), false), { stop: "slot_paused", paused: true });
  assert.deepEqual(closedServerPurgeGuardVerdict(slot(40 * MB), true), { stop: "slot_paused", paused: true }, "paused until under 32 MB");
  assert.deepEqual(closedServerPurgeGuardVerdict(slot(SLOT_RESUME_BYTES - 1), true), { stop: null, paused: false });
  assert.deepEqual(closedServerPurgeGuardVerdict(slot(SLOT_STOP_BYTES + 1), false), { stop: "slot_stopped", paused: true });
  assert.equal(closedServerPurgeGuardVerdict(slot(1, "extended"), false).stop, "slot_wal_status");
  assert.equal(closedServerPurgeGuardVerdict({ slot: null, rwOverloadedRecently: true }, false).stop, "rw_overloaded");
  assert.deepEqual(closedServerPurgeGuardVerdict({ slot: null, rwOverloadedRecently: false }, false), { stop: null, paused: false }, "no slot outside production: no reading");
  assert.equal(closedServerPurgeGuardVerdict({ slot: null, slotRequired: true, rwOverloadedRecently: false }, false).stop, "slot_missing", "no slot in production: stop, never allow");
  assert.equal(closedServerPurgeGuardVerdict({ slot: { retainedWalBytes: MB, walStatus: "reserved" }, slotRequired: true, rwOverloadedRecently: false }, false).stop, null);

  const old = await seedPurgeable(seed);
  await close(old.server.id, daysAgo(40));
  await deleteFor(old.server.id);
  const before = await serverSnapshot(old.server.id);
  const state = memoryClosedServerPurgeState(() => NOW);
  let runs = 0;
  // Each run gets the claim; the state (and its slot pause) carries over.
  const runWith = (deps: ClosedServerPurgeDeps) => {
    runs += 1;
    // 12:31Z, 12:32Z, ...: outside every quiet time.
    const at = new Date(NOW.getTime() + runs * 60_000);
    return runClosedServerPurge({ now: () => at, state: { ...state, claimRun: async () => true, passResting: async () => false }, apps: [], ...deps });
  };
  for (const [reading, reason] of [
    [slot(SLOT_STOP_BYTES + MB), "slot_stopped"],
    [slot(1, "unreserved"), "slot_wal_status"],
    [{ slot: null, rwOverloadedRecently: true }, "rw_overloaded"],
    [{ slot: null, slotRequired: true, rwOverloadedRecently: false }, "slot_missing"],
    [slot(SLOT_PAUSE_BYTES + MB), "slot_paused"],
    [slot(40 * MB), "slot_paused"],
  ] as const) {
    const result = await runWith({ readGuards: async () => reading });
    assert.equal(result.stoppedReason, reason);
    assert.deepEqual(await serverSnapshot(old.server.id), { ...before, server: { ...before.server!, purgeState: "apps" } }, `${reason}: nothing deleted`);
  }
  const budget = await runWith({ readGuards: noGuards, budgetMs: 0 });
  assert.equal(budget.stoppedReason, "budget");
  assert.deepEqual(await serverSnapshot(old.server.id), { ...before, server: { ...before.server!, purgeState: "apps" } }, "budget: nothing deleted");

  const resumed = await runWith({ readGuards: async () => slot(10 * MB) });
  assert.equal(resumed.purged.find((purged) => purged.serverId === old.serverId)?.outcome, "done", "under 32 MB the pause lifts");
});

test("a channel this version can't clear (a Guest's) is left, the server goes to `blocked` and waits a day; the rest of its channels go", async ({ seed }) => {
  const old = await seedPurgeable(seed);
  await close(old.server.id, daysAgo(40));
  const guest = await seed.human();
  await getDb().insert(serverMembers).values({ serverId: old.server.id, userId: guest.id, role: "guest", guestChannelId: old.channel.id });
  await deleteFor(old.server.id);

  const result = await run();
  const entry = result.purged.find((purged) => purged.serverId === old.serverId)!;
  assert.equal(entry.outcome, "blocked");
  assert.equal(entry.counts.channels_blocked_guest, 1);
  const after = await serverSnapshot(old.server.id);
  assert.ok(after.channels.includes(old.channel.id), "the Guest's channel stays");
  assert.ok(!after.channels.includes(old.thread.id) && !after.channels.includes(old.conversation.id), "its thread and task conversation went");
  const [row] = await getDb().select({ state: servers.purgeState, until: servers.purgeLeaseUntil, purgedAt: servers.purgedAt, name: servers.name }).from(servers).where(eq(servers.id, old.server.id));
  assert.equal(row!.state, "blocked");
  assert.equal(row!.purgedAt, null);
  assert.notEqual(row!.name, "Closed server", "not scrubbed while blocked");
  assert.equal(row!.until!.getTime(), NOW.getTime() + DAY_MS, "retried a day later");
  const again = await run();
  assert.ok(!again.purged.some((purged) => purged.serverId === old.serverId), "not before then");
});

test("idempotent: a done server is not claimed or scanned again, and every step run again over it deletes nothing and fails nothing", async ({ seed }) => {
  const old = await seedPurgeable(seed);
  await close(old.server.id, daysAgo(40));
  await deleteFor(old.server.id);
  assert.equal((await run()).purged.find((purged) => purged.serverId === old.serverId)?.outcome, "done");
  const purged = await serverSnapshot(old.server.id);

  // done: not claimed again, nothing re-scanned (no batch, no event).
  const { result: again, sink } = await withTracer(async (sink) => ({ result: await run({ readGuards: async () => { throw new Error("no batch may run"); } }), sink }));
  assert.equal(again.stoppedReason, "pass_done");
  assert.ok(!again.purged.some((entry) => entry.serverId === old.serverId), "done: not a candidate");
  assert.equal(eventsNamed(sink, CLOSED_SERVER_PURGE_DELETE_SERVER_EVENT).length, 0);
  assert.equal(eventsNamed(sink, CLOSED_SERVER_PURGE_RUN_EVENT)[0]!.attrs?.servers_in_rows_deleted, 0);
  assert.deepEqual(await serverSnapshot(old.server.id), purged);
  assert.deepEqual(purged.server!.purgedAt, NOW);

  // As if the last commit had been lost: every step again, from the first.
  await getDb().update(servers).set({ purgeState: "apps", purgedAt: null, purgeLeaseUntil: null }).where(eq(servers.id, old.server.id));
  const rerun = await run();
  const entry = rerun.purged.find((purgedEntry) => purgedEntry.serverId === old.serverId)!;
  assert.equal(entry.outcome, "done");
  assert.equal(entry.counts.messages_deleted ?? 0, 0);
  assert.equal(entry.counts.channels_deleted ?? 0, 0);
  assert.equal(entry.counts.object_events_deleted ?? 0, 0);
  assert.deepEqual(await serverSnapshot(old.server.id), purged);
});

test("apps are told the kept channels (joint projection, its thread, receipt channel), every batch, and never a channel the purge clears", async ({ seed }) => {
  const old = await seedPurgeable(seed);
  await close(old.server.id, daysAgo(40));
  await deleteFor(old.server.id);
  const received: Array<readonly string[] | undefined> = [];
  const app = {
    id: "fake-app",
    purgeServer: async (_serverId: ServerId, options: AppPurgeServerOptions) => {
      received.push(options.keepChannelIds);
      return { remaining: received.length < 2, counts: {} };
    },
  } as unknown as FirstPartyApp;

  const result = await run({ apps: [app] });
  assert.equal(result.purged.find((entry) => entry.serverId === old.serverId)?.outcome, "done");
  assert.equal(received.length, 2);
  const kept = [...old.skipped.joint, ...old.skipped.receipt].sort();
  for (const keep of received) {
    assert.deepEqual([...(keep ?? [])].sort(), kept, "the full kept set");
    for (const cleared of [old.channel.id, old.thread.id, old.conversation.id]) assert.ok(!keep!.includes(cleared), "not a channel the purge clears");
  }
  // (What an app does with them: Artifacts' own test, apps/artifacts/purge.db.test.ts.)
});

/** Two closed servers in delete mode, in the order the run takes them (by id). */
async function twoServers(seed: Seed) {
  const [first, second] = [await seedPurgeable(seed), await seedPurgeable(seed)].sort((a, b) => a.server.id.localeCompare(b.server.id));
  await close(first!.server.id, daysAgo(40));
  await close(second!.server.id, daysAgo(40));
  await deleteFor(first!.server.id, second!.server.id);
  return [first!, second!] as const;
}

const leaseOf = async (serverId: string) =>
  (await getDb().select({ state: servers.purgeState, until: servers.purgeLeaseUntil, token: servers.purgeLeaseToken }).from(servers).where(eq(servers.id, serverId)))[0]!;

/** An app's refusal, as an app would throw it (Artifacts: ArtifactPurgeRefusedError). */
class FakeAppRefused extends Error {
  constructor() {
    super("refused");
    this.name = "FakeAppRefused";
  }
}

test("one server's error (an app refusing) backs off only that server, a day, at its step; the run goes on to the next and to the count pass", async ({ seed }) => {
  const [failing, next] = await twoServers(seed);
  const app = {
    id: "fake-app",
    purgeServer: async (serverId: ServerId) => {
      if (serverId === failing.serverId) throw new FakeAppRefused();
      return { remaining: false, counts: {} };
    },
  } as unknown as FirstPartyApp;
  const { result, sink } = await withTracer(async (sink) => ({ result: await run({ apps: [app] }), sink }));
  assert.equal(result.stoppedReason, "pass_done", "the run, and its count pass, went on");
  const failed = result.purged.find((entry) => entry.serverId === failing.serverId)!;
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.errorClass, "FakeAppRefused");
  assert.deepEqual(await leaseOf(failing.server.id), { state: "apps", until: new Date(NOW.getTime() + DAY_MS), token: null }, "backed off a day, resumes at its step");
  assert.equal(result.purged.find((entry) => entry.serverId === next.serverId)?.outcome, "done");
  const [event] = eventsNamed(sink, CLOSED_SERVER_PURGE_DELETE_SERVER_EVENT).filter((logged) => logged.attrs?.server_id === failing.serverId);
  assert.equal(event!.attrs?.outcome, "failed");
  assert.equal(event!.attrs?.error_class, "FakeAppRefused");
  assert.equal(eventsNamed(sink, CLOSED_SERVER_PURGE_RUN_EVENT)[0]!.attrs?.servers_delete_failed, 1);

  const again = await run({ apps: [app] });
  assert.ok(!again.purged.some((entry) => entry.serverId === failing.serverId), "not first in line next run: not before the day is up");
});

test("a statement timeout in the channel step backs that server off and ends the run; the next run starts with the next server", async ({ seed }) => {
  const [failing, next] = await twoServers(seed);
  const timeout = () => Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" });
  let channelBatches = 0;
  const hooks = {
    // In the channel step, after it is recorded (its first batch writes `channels`).
    inBatch: async (serverId: ServerId, state: string) => {
      if (serverId === failing.serverId && state === "channels" && ++channelBatches === 3) throw timeout();
    },
  };
  const first = await run({ hooks });
  assert.equal(first.stoppedReason, "timeout", "a timeout still ends the run");
  const failed = first.purged.find((entry) => entry.serverId === failing.serverId)!;
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.sqlstate, "57014");
  assert.deepEqual(await leaseOf(failing.server.id), { state: "channels", until: new Date(NOW.getTime() + DAY_MS), token: null });
  assert.ok(!first.purged.some((entry) => entry.serverId === next.serverId), "the run ended at the timeout");

  const second = await run({ hooks });
  assert.deepEqual(second.purged.map((entry) => [entry.serverId, entry.outcome]), [[next.serverId, "done"]], "the next run starts past the backed-off server");
});

test("the flag is checked before every batch: a kill switch mid-purge stops it at the next batch and the lease is released", async ({ seed }) => {
  const old = await seedPurgeable(seed);
  await close(old.server.id, daysAgo(40));
  await deleteFor(old.server.id);
  const before = await serverSnapshot(old.server.id);
  let batches = 0;
  const readGuards = async (): Promise<ClosedServerPurgeGuardReading> => {
    batches += 1;
    // A few batches in (the kept-channel read, the step, the channel page, a channel's first checks and messages); then the kill switch.
    if (batches === 7) await getDb().update(featureFlags).set({ killSwitch: true }).where(eq(featureFlags.key, CLOSED_SERVER_PURGE_FEATURE_FLAG_KEY));
    return { slot: null, rwOverloadedRecently: false };
  };
  const result = await run({ readGuards, messageBatch: 1 });
  const entry = result.purged.find((purged) => purged.serverId === old.serverId)!;
  assert.equal(entry.outcome, "flag_off");
  const after = await serverSnapshot(old.server.id);
  assert.ok(after.messages < before.messages, "it had started");
  assert.ok(after.messages > 4, "and stopped mid-way (4 are the kept channels'), at the batch after the switch");
  assert.deepEqual(await leaseOf(old.server.id), { state: "channels", until: null, token: null });
});

test("`delete` only from a rule naming the server: as the default variant, or from a percentage rule, the server is counted and nothing is deleted", async ({ seed }) => {
  const old = await seedPurgeable(seed);
  await close(old.server.id, daysAgo(40));
  const before = await serverSnapshot(old.server.id);
  for (const setup of ["default", "percentage"] as const) {
    if (setup === "default") {
      await flag("delete");
    } else {
      await flag(null);
      await createFeatureFlagRule({ flagKey: CLOSED_SERVER_PURGE_FEATURE_FLAG_KEY, stage: "percentage", decision: "allow", percentageBasisPoints: 10_000, variant: "delete" });
    }
    const { result, sink } = await withTracer(async (sink) => ({ result: await run(), sink }));
    assert.equal(result.purged.length, 0, `${setup}: nothing claimed`);
    assert.ok(result.counted.some((counted) => counted.serverId === old.serverId), `${setup}: counted instead`);
    assert.ok(Number(eventsNamed(sink, CLOSED_SERVER_PURGE_RUN_EVENT)[0]!.attrs?.servers_delete_not_server_rule) >= 1, `${setup}: said on the run event`);
    assert.deepEqual(await serverSnapshot(old.server.id), before, `${setup}: nothing deleted`);
  }
});
