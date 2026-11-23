import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { executeSearchSql as executeSearchSqlFromDb, getDb } from "../db/index";
import {
  agents, channelConversionFences, channelConversionPhaseLedger, channels, featureFlagRules,
  featureFlags, jointChannels, jointChannelServers, messages, serverMembers, servers as serversTable, tasks,
  userChannelReadCursors, users,
} from "../db/schema";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { onlineMoveCanonicalForRoot } from "./channelConversionReadScope";
import {
  cancelChannelConversionJob, ChannelConversionError, getChannelConversionJob, retryChannelConversionJob,
  runChannelConversionJob, startChannelToJointConversion,
} from "./channelConversionService";
import { runChannelConversionWorkerPass } from "./channelConversionWorker";
import { addAgent, addHuman, createChannel, getMessageStorageChannelIdWithExecutor, getOrCreateThread, getOrCreateThreadForChannel } from "./channelService";
import { CHANNEL_CONVERSION_ONLINE_MOVE_FEATURE_FLAG_KEY } from "./featureFlagService";
import { createMessage } from "./messageService";
import {
  __resetSearchServiceDepsForTests, __setSearchServiceDepsForTests, MESSAGE_SEARCH_RECENT_COLLECT_FIRST_TEXT_MATCH_LIMIT,
  searchMessagesForUser,
} from "./searchService";
import { createServer as createServerService } from "./serverService";
import { createTaskConversationsInTransaction, ensureTaskConversation } from "./taskConversationService";
import { retractDelegatedMessage } from "./assistantSendAsOwnerService";

// channel_conversion_online_move_v1, step 3: the start prepares everything in
// its own transaction and leaves the job in `online_move` with no fence, so
// the channel keeps taking writes (new root messages in the canonical
// channel, thread replies in the canonical thread). Lock and timeout
// behaviour is in channelConversionOnlineMove.realPg.test.ts.

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

function headers(token: string, serverId: string) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Server-Id": serverId };
}

async function seedUser(email: string, name: string) {
  const [user] = await getDb().insert(users).values({
    email, name, displayName: name, passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true, profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

async function enableOnlineMove(serverId: string) {
  await getDb().insert(featureFlags).values({
    key: CHANNEL_CONVERSION_ONLINE_MOVE_FEATURE_FLAG_KEY, enabled: true, defaultEnabled: false,
    randomizationUnit: "server", salt: "online-move",
  }).onConflictDoNothing();
  await getDb().insert(featureFlagRules).values({
    flagKey: CHANNEL_CONVERSION_ONLINE_MOVE_FEATURE_FLAG_KEY, stage: "server", decision: "allow", values: [serverId],
  });
}

/**
 * A channel with an old root message carrying a thread (with a reply), a
 * task with its task conversation, and a task-number high water of 7.
 */
async function seed(prefix: string, opts: { onlineMove?: boolean } = {}) {
  const owner = await seedUser(`${prefix}-owner@slock.test`, `${prefix}-owner`);
  const member = await seedUser(`${prefix}-member@slock.test`, `${prefix}-member`);
  const server = await createServerService(`${prefix} host`, `${prefix}-host`, owner.id);
  await getDb().update(serversTable).set({ plan: "founder" }).where(eq(serversTable.id, server.id));
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  const [agent] = await getDb().insert(agents).values({ serverId: server.id, name: `${prefix}-agent`, runtime: "codex" }).returning();
  if (opts.onlineMove !== false) await enableOnlineMove(server.id);
  const channel = await createChannel(server.id, `${prefix}-room`, "move me", "channel");
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, member.id);
  await addAgent(channel.id, agent!.id);
  const parent = await createMessage(channel.id, "user", owner.id, "parent history");
  const thread = await getOrCreateThread(parent.id, owner.id, "user");
  const reply = await createMessage(thread.id, "user", owner.id, "thread history");
  const [task] = await getDb().insert(tasks).values({
    channelId: channel.id, taskNumber: 7, title: "old task", createdByType: "user", createdById: owner.id,
  }).returning();
  await getDb().update(channels).set({ taskNumberHighWater: 7 }).where(eq(channels.id, channel.id));
  const created = await createTaskConversationsInTransaction(getDb(), {
    tasks: [{ id: task!.id, channelId: channel.id }],
    storageChannel: { id: channel.id, serverId: server.id, type: "channel" },
    initiatingServerId: server.id,
    createdByUserId: owner.id,
  });
  const taskConversationId = created.get(task!.id)!.canonicalChannelId;
  const taskReply = await createMessage(taskConversationId, "user", owner.id, "task conversation history");
  return { owner, member, server, agent: agent!, channel, parent, thread, reply, task: task!, taskConversationId, taskReply };
}

async function activeFences(sourceChannelId: string) {
  return getDb().select().from(channelConversionFences).where(and(
    eq(channelConversionFences.sourceChannelId, sourceChannelId), eq(channelConversionFences.status, "active"),
  ));
}

async function channelOf(messageId: string) {
  const [row] = await getDb().select({ channelId: messages.channelId }).from(messages).where(eq(messages.id, messageId));
  return row?.channelId;
}

async function send(baseUrl: string, token: string, serverId: string, body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/api/messages`, { method: "POST", headers: headers(token, serverId), body: JSON.stringify(body) });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return JSON.parse(text) as { id: string; channelId: string };
}

async function canonicalThreadOf(parentMessageId: string) {
  const [row] = await getDb().select().from(channels)
    .where(and(eq(channels.parentMessageId, parentMessageId), eq(channels.type, "thread")));
  return row;
}

test("flag off: a start fences the source as before", async ({ app }) => {
  assert.ok(app.baseUrl);
  const f = await seed(`online-off-${randomUUID().slice(0, 8)}`, { onlineMove: false });
  const job = await startChannelToJointConversion({ serverId: f.server.id, sourceChannelId: f.channel.id, createdByUserId: f.owner.id });
  assert.equal(job.phase, "prepare");
  assert.equal(job.status, "pending");
  assert.equal(job.canonicalChannelId, null);
  assert.equal((await activeFences(f.channel.id)).length, 1);
  assert.equal(await onlineMoveCanonicalForRoot(getDb(), f.channel.id), null);
});

test("flag on: the start prepares the canonical channel, threads, task conversations and numbering inline, and admits writers", async ({ app }) => {
  const f = await seed(`online-start-${randomUUID().slice(0, 8)}`);
  const job = await startChannelToJointConversion({ serverId: f.server.id, sourceChannelId: f.channel.id, createdByUserId: f.owner.id });
  assert.equal(job.phase, "online_move");
  assert.equal(job.status, "running");
  assert.ok(job.canonicalChannelId && job.jointChannelId);
  assert.equal(job.canCancel, true);
  const canonicalId = job.canonicalChannelId;
  assert.deepEqual(await activeFences(f.channel.id), [], "no fence: writers are admitted");

  const [source] = await getDb().select().from(channels).where(eq(channels.id, f.channel.id));
  const [canonical] = await getDb().select().from(channels).where(eq(channels.id, canonicalId));
  const [storage] = await getDb().select({ id: serversTable.id }).from(serversTable).where(eq(serversTable.kind, "joint_storage"));
  assert.equal(source!.type, "channel", "the source stays an ordinary channel until the switch");
  assert.equal(canonical!.serverId, storage!.id);
  assert.ok(canonical!.taskNumberHighWater >= 7, "the source's task-number high water is carried to the canonical channel");
  assert.equal(await onlineMoveCanonicalForRoot(getDb(), f.channel.id), canonicalId);
  assert.equal(await getMessageStorageChannelIdWithExecutor(getDb(), f.channel.id), canonicalId, "the route is the canonical channel");

  // Threads: from the source's current parents, which have not moved.
  assert.equal(await channelOf(f.parent.id), f.channel.id, "parents move later");
  const canonicalThread = await canonicalThreadOf(f.parent.id);
  assert.ok(canonicalThread);
  assert.equal(canonicalThread.serverId, storage!.id);
  assert.equal(canonicalThread.parentChannelId, f.channel.id, "a canonical thread follows its parent message, still in the source");
  const [parentAfter] = await getDb().select({ threadId: messages.threadId }).from(messages).where(eq(messages.id, f.parent.id));
  assert.equal(parentAfter!.threadId, canonicalThread.id);
  const [localThread] = await getDb().select().from(channels).where(eq(channels.id, f.thread.id));
  assert.equal(localThread!.parentMessageId, null, "the local thread becomes the host's projection");
  assert.equal(await channelOf(f.reply.id), f.thread.id, "old replies move later");
  const projections = await getDb().select({ localChannelId: jointChannelServers.localChannelId, canonicalChannelId: jointChannels.canonicalChannelId, role: jointChannelServers.role })
    .from(jointChannelServers).innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(inArray(jointChannelServers.localChannelId, [f.channel.id, f.thread.id, f.taskConversationId]));
  const [task] = await getDb().select().from(tasks).where(eq(tasks.id, f.task.id));
  assert.equal(task!.channelId, f.channel.id, "tasks move later");
  assert.notEqual(task!.conversationChannelId, f.taskConversationId, "the task points at its canonical conversation");
  assert.deepEqual(new Set(projections.map((row) => `${row.localChannelId}>${row.canonicalChannelId}:${row.role}`)), new Set([
    `${f.channel.id}>${canonicalId}:host`,
    `${f.thread.id}>${canonicalThread.id}:host`,
    `${f.taskConversationId}>${task!.conversationChannelId}:host`,
  ]));
  assert.equal(job.progress.preparedThreads, 1);
  assert.equal(job.progress.preparedTaskConversations, 1);
  assert.equal(typeof job.progress.onlineMovePreparedAt, "string");
  const ledger = await getDb().select({ phase: channelConversionPhaseLedger.phase, batchKey: channelConversionPhaseLedger.batchKey, sourceCount: channelConversionPhaseLedger.sourceCount })
    .from(channelConversionPhaseLedger).where(eq(channelConversionPhaseLedger.jobId, job.id));
  assert.deepEqual(ledger.find((row) => row.phase === "online_move" && row.batchKey === "prepared"), { phase: "online_move", batchKey: "prepared", sourceCount: 2 });
  assert.ok(ledger.some((row) => row.phase === "prepare"), "today's prepare phase is recorded");
  assert.ok(ledger.some((row) => row.phase === "prepare_tasks"), "today's prepare_tasks phase is recorded");

  // Nothing runs it until the mover lands; a repeated start answers it; it cannot be retried.
  await runChannelConversionWorkerPass();
  assert.equal((await runChannelConversionJob(job.id)).phase, "online_move");
  assert.equal((await getChannelConversionJob(job.id))!.updatedAt.getTime(), job.updatedAt.getTime(), "the worker leaves it alone");
  assert.equal((await startChannelToJointConversion({ serverId: f.server.id, sourceChannelId: f.channel.id, createdByUserId: f.owner.id })).id, job.id);
  await assert.rejects(retryChannelConversionJob(job.id), (error: unknown) => error instanceof ChannelConversionError && error.code === "channel_conversion_retry_not_allowed");

  // Writers: a root send lands in the canonical channel, labelled with the root.
  const token = await tokenForHuman(f.owner.email);
  const rootSend = await send(app.baseUrl, token, f.server.id, { channelId: f.channel.id, content: "sent during the move" });
  assert.equal(await channelOf(rootSend.id), canonicalId);
  assert.equal(rootSend.channelId, f.channel.id, "the sender sees the root, never the storage id");
  // A thread reply lands in the canonical thread.
  const threadSend = await send(app.baseUrl, token, f.server.id, { channelId: f.thread.id, content: "reply during the move" });
  assert.equal(await channelOf(threadSend.id), canonicalThread.id);
  // A task created during the move is numbered past the source's.
  const taskSend = await send(app.baseUrl, token, f.server.id, { channelId: f.channel.id, content: "task during the move", asTask: true });
  const [newTask] = await getDb().select().from(tasks).where(or(eq(tasks.sourceMessageId, taskSend.id), eq(tasks.messageId, taskSend.id)));
  assert.ok(newTask, "the task exists");
  assert.equal(newTask.channelId, canonicalId);
  assert.ok(newTask.taskNumber > 7, `numbered past the source's 7, got ${newTask.taskNumber}`);
});

test("flag on: cancel of an online move undoes the prepared threads, task conversations and numbering and returns the route to the source", async ({ app }) => {
  const f = await seed(`online-cancel-${randomUUID().slice(0, 8)}`);
  const job = await startChannelToJointConversion({ serverId: f.server.id, sourceChannelId: f.channel.id, createdByUserId: f.owner.id });
  const canonicalId = job.canonicalChannelId!;
  const canonicalThread = (await canonicalThreadOf(f.parent.id))!;
  const token = await tokenForHuman(f.owner.email);
  const rootSend = await send(app.baseUrl, token, f.server.id, { channelId: f.channel.id, content: "sent during the move" });
  const threadSend = await send(app.baseUrl, token, f.server.id, { channelId: f.thread.id, content: "reply during the move" });
  const taskSend = await send(app.baseUrl, token, f.server.id, { channelId: f.channel.id, content: "task during the move", asTask: true });
  const [newTask] = await getDb().select().from(tasks).where(or(eq(tasks.sourceMessageId, taskSend.id), eq(tasks.messageId, taskSend.id)));

  const canceled = await cancelChannelConversionJob(job.id);
  assert.equal(canceled.status, "canceled");
  assert.equal(canceled.phase, "done", "the job left online_move in the cancel's transaction");
  assert.equal(await onlineMoveCanonicalForRoot(getDb(), f.channel.id), null);
  assert.equal(await getMessageStorageChannelIdWithExecutor(getDb(), f.channel.id), f.channel.id, "the route is the source again");

  assert.deepEqual(await getDb().select().from(channels).where(inArray(channels.id, [canonicalId, canonicalThread.id])), [], "canonical channel and thread are gone");
  assert.deepEqual(await getDb().select().from(jointChannelServers).where(inArray(jointChannelServers.localChannelId, [f.channel.id, f.thread.id, f.taskConversationId])), []);
  assert.equal(await channelOf(rootSend.id), f.channel.id, "a message sent during the move is back in the source");
  assert.equal(await channelOf(threadSend.id), f.thread.id, "a reply sent during the move is back in the local thread");
  assert.equal(await channelOf(f.reply.id), f.thread.id);
  const [localThread] = await getDb().select().from(channels).where(eq(channels.id, f.thread.id));
  assert.equal(localThread!.parentMessageId, f.parent.id, "the local thread has its parent again");
  assert.equal(localThread!.parentChannelId, f.channel.id);
  const [parentAfter] = await getDb().select({ threadId: messages.threadId }).from(messages).where(eq(messages.id, f.parent.id));
  assert.equal(parentAfter!.threadId, f.thread.id);
  const [task] = await getDb().select().from(tasks).where(eq(tasks.id, f.task.id));
  assert.equal(task!.conversationChannelId, f.taskConversationId, "the task points at its own conversation again");
  assert.equal(await channelOf(f.taskReply.id), f.taskConversationId);
  const [movedBackTask] = await getDb().select().from(tasks).where(eq(tasks.id, newTask!.id));
  assert.equal(movedBackTask!.channelId, f.channel.id, "a task created during the move is back in the source");
  const [source] = await getDb().select().from(channels).where(eq(channels.id, f.channel.id));
  assert.ok(source!.taskNumberHighWater >= newTask!.taskNumber, "the canonical channel's numbers are carried back (never reused)");
  assert.deepEqual(await activeFences(f.channel.id), []);

  const after = await send(app.baseUrl, token, f.server.id, { channelId: f.channel.id, content: "after cancel" });
  assert.equal(await channelOf(after.id), f.channel.id);
});

test("search during an online move: each message once on the text-match plans, the server walk returns only unmoved rows", async ({ app }) => {
  const f = await seed(`online-search-${randomUUID().slice(0, 8)}`);
  const term = `quokka${randomUUID().slice(0, 6)}`;
  const old = await createMessage(f.channel.id, "user", f.owner.id, `${term} old unmoved message`);
  const job = await startChannelToJointConversion({ serverId: f.server.id, sourceChannelId: f.channel.id, createdByUserId: f.owner.id });
  const token = await tokenForHuman(f.owner.email);
  const fresh = await send(app.baseUrl, token, f.server.id, { channelId: f.channel.id, content: `${term} new message` });
  assert.equal(await channelOf(old.id), f.channel.id);
  assert.equal(await channelOf(fresh.id), job.canonicalChannelId);

  const dialect = new PgDialect();
  let injectedTextMatchEstimate: number | null = null;
  let walked = false;
  __setSearchServiceDepsForTests({
    executeSearchSql: (async (statement: SQL, options?: { signal?: AbortSignal }) => {
      const rendered = dialect.sqlToQuery(statement).sql.replace(/\s+/g, " ").trim();
      if (injectedTextMatchEstimate !== null && rendered.startsWith("EXPLAIN (FORMAT JSON) SELECT t.message_id")) {
        return { rows: [{ "QUERY PLAN": [{ Plan: { "Node Type": "Bitmap Heap Scan", "Plan Rows": injectedTextMatchEstimate } }] }] };
      }
      if (rendered.includes("OFFSET") && rendered.includes("LIMIT 2") && rendered.includes("FROM message_server_timeline t WHERE t.server_id")) walked = true;
      return executeSearchSqlFromDb(statement, options);
    }) as typeof executeSearchSqlFromDb,
  });
  try {
    const search = (extra: { channelId?: string } = {}) => searchMessagesForUser({
      userId: f.owner.id, serverId: f.server.id, query: term, historyCutoff: undefined, sort: "recent", limit: 20, ...extra,
    });
    const ids = (page: Awaited<ReturnType<typeof search>>) => page.results.map((row) => row.id).sort();

    // Channel-filtered: the filter is the source OR its canonical channel.
    const filtered = await search({ channelId: f.channel.id });
    assert.deepEqual(ids(filtered), [old.id, fresh.id].sort(), "each found exactly once with the channel filter");
    assert.ok(filtered.results.every((row) => row.channelId === f.channel.id && row.parentChannelId === f.channel.id), "results carry the local id");

    // Unfiltered, sparse term: text_matches_first, reading the host and the storage server.
    injectedTextMatchEstimate = 1;
    const sparse = await search();
    assert.equal(walked, false, "a sparse term takes the text matches first");
    assert.deepEqual(ids(sparse), [old.id, fresh.id].sort(), "each found exactly once on text_matches_first");
    assert.ok(sparse.results.every((row) => row.channelId === f.channel.id));

    // Unfiltered, dense term: the server timeline walk (this server's rows only, unchanged).
    injectedTextMatchEstimate = MESSAGE_SEARCH_RECENT_COLLECT_FIRST_TEXT_MATCH_LIMIT + 1;
    const dense = await search();
    assert.equal(walked, true, "a dense term walks the server timeline");
    const denseIds = dense.results.map((row) => row.id);
    assert.equal(new Set(denseIds).size, denseIds.length, "no message twice");
    assert.deepEqual(denseIds, [old.id], "only the unmoved row: the walk reads this server's timeline");
  } finally {
    __resetSearchServiceDepsForTests();
  }
  // Untouched by the walk: the canonical copy really is on the storage server's timeline.
  const timeline = await getDb().execute(sql`SELECT server_id::text AS server_id FROM message_server_timeline WHERE message_id = ${fresh.id}`);
  assert.equal(timeline.rows.length, 1);
  assert.notEqual((timeline.rows[0] as { server_id: string }).server_id, f.server.id);
});

async function storageServerId() {
  const [storage] = await getDb().select({ id: serversTable.id }).from(serversTable).where(eq(serversTable.kind, "joint_storage"));
  return storage!.id;
}

/** The joint shape of a thread or task conversation started during the move, read from its local face. */
async function jointFaceOf(localId: string) {
  const [local] = await getDb().select().from(channels).where(eq(channels.id, localId));
  const [projection] = await getDb().select({ role: jointChannelServers.role, canonicalChannelId: jointChannels.canonicalChannelId })
    .from(jointChannelServers).innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(and(eq(jointChannelServers.localChannelId, localId), eq(jointChannelServers.status, "active")));
  const [canonical] = projection ? await getDb().select().from(channels).where(eq(channels.id, projection.canonicalChannelId)) : [];
  return { local: local!, projection, canonical };
}

test("flag on: a thread started during the move, on a new or an old message, is a joint thread; replies land in canonical; cancel restores both", async ({ app }) => {
  const f = await seed(`online-thread-${randomUUID().slice(0, 8)}`);
  const oldMessage = await createMessage(f.channel.id, "user", f.owner.id, "old message, no thread yet");
  const job = await startChannelToJointConversion({ serverId: f.server.id, sourceChannelId: f.channel.id, createdByUserId: f.owner.id });
  const storage = await storageServerId();
  const token = await tokenForHuman(f.owner.email);
  const newMessage = await send(app.baseUrl, token, f.server.id, { channelId: f.channel.id, content: "new message during the move" });
  assert.equal(await channelOf(newMessage.id), job.canonicalChannelId);

  const opened = new Map<string, { localId: string; canonicalId: string; replyId: string }>();
  for (const [label, parentId] of [["new", newMessage.id], ["old", oldMessage.id]] as const) {
    const thread = await getOrCreateThreadForChannel(f.channel.id, parentId, f.owner.id, "user");
    assert.equal(thread.created, true, `${label}: created`);
    assert.notEqual(thread.id, thread.canonicalThreadChannelId, `${label}: opened through its local face`);
    const shape = await jointFaceOf(thread.id);
    assert.equal(shape.local.serverId, f.server.id, `${label}: the local face is on the host`);
    assert.equal(shape.local.type, "thread");
    assert.equal(shape.local.parentMessageId, null, `${label}: the local face has no parent message`);
    assert.equal(shape.projection?.role, "host");
    assert.equal(shape.projection?.canonicalChannelId, thread.canonicalThreadChannelId);
    assert.equal(shape.canonical!.serverId, storage, `${label}: the canonical thread is on the storage server`);
    assert.equal(shape.canonical!.parentMessageId, parentId);
    const [parent] = await getDb().select({ threadId: messages.threadId }).from(messages).where(eq(messages.id, parentId));
    assert.equal(parent!.threadId, thread.canonicalThreadChannelId, `${label}: the parent points at the canonical thread`);
    // Opening it again, or through the agents' path, finds the same thread.
    assert.equal((await getOrCreateThreadForChannel(f.channel.id, parentId, f.owner.id, "user")).id, thread.id);
    assert.equal((await getOrCreateThread(parentId, f.owner.id, "user")).id, thread.canonicalThreadChannelId);
    const reply = await send(app.baseUrl, token, f.server.id, { channelId: thread.id, content: `${label} reply` });
    assert.equal(await channelOf(reply.id), thread.canonicalThreadChannelId, `${label}: the reply lands in the canonical thread`);
    opened.set(label, { localId: thread.id, canonicalId: thread.canonicalThreadChannelId, replyId: reply.id });
  }
  const threadsOnParent = await getDb().select({ id: channels.id }).from(channels)
    .where(and(inArray(channels.parentMessageId, [newMessage.id, oldMessage.id]), eq(channels.type, "thread")));
  assert.equal(threadsOnParent.length, 2, "one canonical thread per parent, no stray plain thread");

  await cancelChannelConversionJob(job.id);
  for (const [label, parentId] of [["new", newMessage.id], ["old", oldMessage.id]] as const) {
    const { localId, canonicalId, replyId } = opened.get(label)!;
    const [local] = await getDb().select().from(channels).where(eq(channels.id, localId));
    assert.equal(local!.parentMessageId, parentId, `${label}: the local thread has its parent again`);
    assert.equal(local!.parentChannelId, f.channel.id);
    assert.deepEqual(await getDb().select().from(channels).where(eq(channels.id, canonicalId)), [], `${label}: canonical thread gone`);
    assert.deepEqual(await getDb().select().from(jointChannelServers).where(eq(jointChannelServers.localChannelId, localId)), []);
    assert.equal(await channelOf(replyId), localId, `${label}: the reply is back in the local thread`);
    const [parent] = await getDb().select({ threadId: messages.threadId, channelId: messages.channelId }).from(messages).where(eq(messages.id, parentId));
    assert.equal(parent!.threadId, localId);
    assert.equal(parent!.channelId, f.channel.id);
  }
});

test("flag on: a task conversation started during the move (an old task's, a new task's) is a joint one; cancel restores it", async ({ app }) => {
  const f = await seed(`online-taskconv-${randomUUID().slice(0, 8)}`);
  const [oldTask] = await getDb().insert(tasks).values({
    channelId: f.channel.id, taskNumber: 8, title: "old task, no conversation yet", createdByType: "user", createdById: f.owner.id, ownConversation: true,
  }).returning();
  const job = await startChannelToJointConversion({ serverId: f.server.id, sourceChannelId: f.channel.id, createdByUserId: f.owner.id });
  const storage = await storageServerId();
  const [newTask] = await getDb().insert(tasks).values({
    channelId: job.canonicalChannelId!, taskNumber: 9, title: "task created during the move", createdByType: "user", createdById: f.owner.id, ownConversation: true,
  }).returning();
  const token = await tokenForHuman(f.owner.email);

  const started = new Map<string, { localId: string; canonicalId: string; replyId: string }>();
  for (const [label, task] of [["old", oldTask!], ["new", newTask!]] as const) {
    const ensured = await ensureTaskConversation(task.id, { initiatingServerId: f.server.id, createdByUserId: f.owner.id });
    assert.ok(ensured, `${label}: a conversation`);
    const localId = ensured.conversation.localByServer.get(f.server.id)!.localChannelId;
    const canonicalId = ensured.conversation.canonicalChannelId;
    assert.notEqual(localId, canonicalId, `${label}: a joint conversation`);
    const [canonical] = await getDb().select().from(channels).where(eq(channels.id, canonicalId));
    const [local] = await getDb().select().from(channels).where(eq(channels.id, localId));
    assert.equal(canonical!.serverId, storage, `${label}: canonical on the storage server`);
    assert.equal(canonical!.parentChannelId, job.canonicalChannelId, `${label}: under the canonical channel`);
    assert.equal(local!.serverId, f.server.id);
    assert.equal(local!.parentChannelId, f.channel.id, `${label}: the host's face under the root`);
    const [taskRow] = await getDb().select().from(tasks).where(eq(tasks.id, task.id));
    assert.equal(taskRow!.conversationChannelId, canonicalId);
    const reply = await send(app.baseUrl, token, f.server.id, { channelId: localId, content: `${label} task reply` });
    assert.equal(await channelOf(reply.id), canonicalId, `${label}: the reply lands in the canonical conversation`);
    started.set(label, { localId, canonicalId, replyId: reply.id });
  }

  await cancelChannelConversionJob(job.id);
  for (const [label, task] of [["old", oldTask!], ["new", newTask!]] as const) {
    const { localId, canonicalId, replyId } = started.get(label)!;
    const [taskRow] = await getDb().select().from(tasks).where(eq(tasks.id, task.id));
    assert.equal(taskRow!.channelId, f.channel.id, `${label}: the task is in the source`);
    assert.equal(taskRow!.conversationChannelId, localId, `${label}: the task points at its local conversation`);
    assert.deepEqual(await getDb().select().from(channels).where(eq(channels.id, canonicalId)), []);
    assert.equal(await channelOf(replyId), localId, `${label}: the reply is back`);
    const [local] = await getDb().select().from(channels).where(eq(channels.id, localId));
    assert.equal(local!.parentChannelId, f.channel.id);
  }
});

test("flag on: send-as-task during the move is still refused to a non-member of the source channel", async ({ app }) => {
  const f = await seed(`online-nonmember-${randomUUID().slice(0, 8)}`);
  const outsider = await seedUser(`online-nonmember-${randomUUID().slice(0, 8)}@slock.test`, "outsider");
  await getDb().insert(serverMembers).values({ serverId: f.server.id, userId: outsider.id, role: "member" });
  await getDb().update(channels).set({ type: "private" }).where(eq(channels.id, f.channel.id));
  const job = await startChannelToJointConversion({ serverId: f.server.id, sourceChannelId: f.channel.id, createdByUserId: f.owner.id });
  assert.equal(job.phase, "online_move");
  const tasksBefore = await getDb().select({ id: tasks.id }).from(tasks).where(inArray(tasks.channelId, [f.channel.id, job.canonicalChannelId!]));
  const res = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(await tokenForHuman(outsider.email), f.server.id),
    body: JSON.stringify({ channelId: f.channel.id, content: "not my channel", asTask: true }),
  });
  assert.ok(res.status === 403 || res.status === 404, `refused by the source's membership, got ${res.status}`);
  const tasksAfter = await getDb().select({ id: tasks.id }).from(tasks).where(inArray(tasks.channelId, [f.channel.id, job.canonicalChannelId!]));
  assert.equal(tasksAfter.length, tasksBefore.length, "no task created");
  assert.deepEqual(await getDb().select().from(messages).where(eq(messages.content, "not my channel")), []);
  // A member is admitted as before.
  const ok = await send(app.baseUrl, await tokenForHuman(f.member.email), f.server.id, { channelId: f.channel.id, content: "member task", asTask: true });
  assert.equal(await channelOf(ok.id), job.canonicalChannelId);
});

test("flag on: a member joining during the move starts reading at the latest message of the pair", async ({ app }) => {
  assert.ok(app.baseUrl);
  const f = await seed(`online-join-${randomUUID().slice(0, 8)}`);
  const last = await createMessage(f.channel.id, "user", f.owner.id, "last before the move");
  await startChannelToJointConversion({ serverId: f.server.id, sourceChannelId: f.channel.id, createdByUserId: f.owner.id });
  const joiner = await seedUser(`online-join-${randomUUID().slice(0, 8)}@slock.test`, "joiner");
  await getDb().insert(serverMembers).values({ serverId: f.server.id, userId: joiner.id, role: "member" });
  await addHuman(f.channel.id, joiner.id);
  const [cursor] = await getDb().select({ lastReadSeq: userChannelReadCursors.lastReadSeq }).from(userChannelReadCursors)
    .where(and(eq(userChannelReadCursors.userId, joiner.id), eq(userChannelReadCursors.channelId, f.channel.id)));
  assert.equal(Number(cursor?.lastReadSeq ?? 0), Number(last.seq), "the unmoved history counts: nothing old reads as unread");
});

test("flag on: reactions on a message stored in canonical during the move: a member of the source reacts, a non-member is refused", async ({ app }) => {
  const f = await seed(`online-react-${randomUUID().slice(0, 8)}`);
  await getDb().update(channels).set({ type: "private" }).where(eq(channels.id, f.channel.id));
  const outsider = await seedUser(`online-react-out-${randomUUID().slice(0, 8)}@slock.test`, "outsider");
  await getDb().insert(serverMembers).values({ serverId: f.server.id, userId: outsider.id, role: "member" });
  const job = await startChannelToJointConversion({ serverId: f.server.id, sourceChannelId: f.channel.id, createdByUserId: f.owner.id });
  const fresh = await send(app.baseUrl, await tokenForHuman(f.owner.email), f.server.id, { channelId: f.channel.id, content: "react to me" });
  assert.equal(await channelOf(fresh.id), job.canonicalChannelId);
  const react = (email: string) => tokenForHuman(email).then((token) => fetch(`${app.baseUrl}/api/messages/${fresh.id}/reactions`, {
    method: "POST", headers: headers(token, f.server.id), body: JSON.stringify({ emoji: "👍" }),
  }));
  const ok = await react(f.member.email);
  const okBody = await ok.json() as { channelId?: string; reactions?: Array<{ emoji: string; count: number }> };
  assert.equal(ok.status, 200, JSON.stringify(okBody));
  assert.equal(okBody.channelId, f.channel.id, "answered with the root's id, not the storage id");
  assert.ok(okBody.reactions?.some((reaction) => reaction.emoji === "👍" && reaction.count === 1));
  const refused = await react(outsider.email);
  assert.ok(refused.status === 403 || refused.status === 404, `a non-member of the source is refused, got ${refused.status}`);
});

test("flag on: an owner retracts a delegated message stored in canonical during the move; nobody else can", async ({ app }) => {
  const f = await seed(`online-retract-${randomUUID().slice(0, 8)}`);
  const job = await startChannelToJointConversion({ serverId: f.server.id, sourceChannelId: f.channel.id, createdByUserId: f.owner.id });
  const [delegated] = await getDb().insert(messages).values({
    channelId: job.canonicalChannelId!, senderType: "user", senderId: f.owner.id, content: "sent by my assistant", delegatedByAgentId: f.agent.id,
  }).returning();
  const io = app.app.get("io");
  await assert.rejects(
    retractDelegatedMessage({ io, serverId: f.server.id, userId: f.member.id, messageId: delegated!.id }),
    (error: unknown) => (error as { status?: number }).status === 404,
    "someone else's message is not theirs to retract",
  );
  const retracted = await retractDelegatedMessage({ io, serverId: f.server.id, userId: f.owner.id, messageId: delegated!.id });
  assert.equal(retracted.messageId, delegated!.id);
  const [row] = await getDb().select({ deletedAt: messages.deletedAt }).from(messages).where(eq(messages.id, delegated!.id));
  assert.ok(row!.deletedAt, "retracted");
});

test("flag on: a forward into the root during the move is stored in canonical, answered with the root's id, and replays idempotently", async ({ app }) => {
  const f = await seed(`online-forward-${randomUUID().slice(0, 8)}`);
  const job = await startChannelToJointConversion({ serverId: f.server.id, sourceChannelId: f.channel.id, createdByUserId: f.owner.id });
  const token = await tokenForHuman(f.owner.email);
  const requestId = randomUUID();
  const forward = () => fetch(`${app.baseUrl}/api/messages/forward`, {
    method: "POST", headers: headers(token, f.server.id),
    body: JSON.stringify({ destinationChannelId: f.channel.id, sourceMessageIds: [f.parent.id], note: "forwarded during the move", requestId }),
  });
  const first = await forward();
  const firstText = await first.text();
  assert.equal(first.status, 200, firstText);
  const body = JSON.parse(firstText) as { id: string; channelId: string };
  assert.equal(body.channelId, f.channel.id, "the client gets the root's id");
  assert.equal(await channelOf(body.id), job.canonicalChannelId, "stored in the canonical channel");
  const again = await forward();
  const againText = await again.text();
  assert.equal(again.status, 200, againText);
  assert.equal((JSON.parse(againText) as { id: string }).id, body.id, "the replay finds the same message");
});
