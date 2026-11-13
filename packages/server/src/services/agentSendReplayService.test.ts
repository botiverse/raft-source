import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  __resetAgentSendReplayDbForTests,
  __setAgentSendReplayDbForTests,
  createOrReplayAgentSend,
} from "./agentSendReplayService";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agents, attachments, channels, messages, servers, users } from "../db/schema";
import { __setChannelWriterFenceTransactionTestAdapterForTests } from "./channelConversionFenceService";


const FAKE_OBJECT_ID = "b0000000-0000-4000-8000-000000000001";

type InsertCapture = {
  table?: unknown;
  values?: Record<string, unknown>;
};

type UpdateCapture = {
  table?: unknown;
  setValues?: Record<string, unknown>;
};

function makeInsertBuilder(result: unknown[], capture?: InsertCapture) {
  return {
    values(values: Record<string, unknown>) {
      if (capture) capture.values = values;
      return {
        onConflictDoNothing() {
          return {
            returning() {
              return Promise.resolve(result);
            },
          };
        },
      };
    },
  };
}

function makeUpdateBuilder(result: unknown[], capture?: UpdateCapture) {
  return {
    set(values: Record<string, unknown>) {
      if (capture) capture.setValues = values;
      return {
        where() {
          return {
            returning() {
              return Promise.resolve(result);
            },
          };
        },
      };
    },
  };
}

function makeSelectBuilder(result: unknown[]) {
  const makeAfterWhere = (rows: unknown[]) => ({
    limit() {
      return Promise.resolve(rows);
    },
    for() {
      return Promise.resolve(rows);
    },
    orderBy() {
      return Promise.resolve(rows);
    },
    then(resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve(rows).then(resolve, reject);
    },
  });
  const afterWhere = makeAfterWhere(result);
  // Projection + object join: message loading reads physical metadata only
  // from an active object, so each fake projection gets one built from it.
  const joinedAfterWhere = makeAfterWhere(result.map((row) => {
    const projection = row as Record<string, unknown>;
    const objectId = projection.objectId ?? `object-${String(projection.id)}`;
    return {
      projection: { ...projection, objectId },
      object: {
        id: objectId,
        lifecycleState: "active",
        mimeType: projection.mimeType,
        sizeBytes: projection.sizeBytes,
        storageKey: projection.storageKey,
        thumbnailKey: projection.thumbnailKey,
        contentHash: projection.contentHash,
        width: projection.width,
        height: projection.height,
      },
    };
  }));

  return {
    from() {
      return {
        innerJoin() {
          return {
            where() {
              return joinedAfterWhere;
            },
          };
        },
        where() {
          return afterWhere;
        },
      };
    },
  };
}

function makeDb(options: {
  insertResults: unknown[][];
  updateResults: unknown[][];
  selectResults: unknown[][];
  insertCaptures?: InsertCapture[];
  updateCaptures?: UpdateCapture[];
}) {
  const insertResults = [...options.insertResults];
  const updateResults = [...options.updateResults];
  const selectResults = [...options.selectResults];
  const insertCaptures = [...(options.insertCaptures ?? [])];
  const updateCaptures = [...(options.updateCaptures ?? [])];

  return {
    transaction: async (fn: (tx: any) => Promise<unknown>) => {
      const tx = {
        insert(table: unknown) {
          const result = insertResults.shift();
          if (!result) throw new Error("Unexpected insert");
          const capture = insertCaptures.shift();
          if (capture) capture.table = table;
          return makeInsertBuilder(result, capture);
        },
        update(table: unknown) {
          const result = updateResults.shift();
          if (!result) throw new Error("Unexpected update");
          const capture = updateCaptures.shift();
          if (capture) capture.table = table;
          return makeUpdateBuilder(result, capture);
        },
        select() {
          const result = selectResults.shift();
          if (!result) throw new Error("Unexpected select");
          return makeSelectBuilder(result);
        },
        // Raw SQL of the hold writer (attachmentObjectHoldService): the
        // linked attachment's object is locked as active, then its hold is
        // inserted. Every projection names an object (object_id NOT NULL).
        execute: async () => ({ rows: [{ id: FAKE_OBJECT_ID, lifecycle_state: "active", unheld: false }] }),
      };

      return fn(tx);
    },
  };
}

afterEach(async () => {
  __setChannelWriterFenceTransactionTestAdapterForTests(null);
  __resetAgentSendReplayDbForTests();
  await closeTestDatabase();
});

beforeEach(() => {
  // The in-memory replay adapter intentionally has no SQL executor. Install
  // the explicit test transaction contract rather than making production
  // fence code branch on the runtime shape of a fake.
  __setChannelWriterFenceTransactionTestAdapterForTests(async () => undefined);
});

test("createOrReplayAgentSend persists a new agent message on first send", async () => {
  const insertCapture: InsertCapture = {};
  const updateCapture: UpdateCapture = {};
  const createdAt = new Date("2026-04-16T00:00:00.000Z");
  const db = makeDb({
    insertResults: [[{
      id: "msg-1",
      seq: 42,
      channelId: "channel-1",
      senderType: "agent",
      senderId: "agent-1",
      agentSendKey: "send-1",
      messageType: "chat",
      content: "hello",
      searchText: "hello",
      searchVector: null,
      threadId: null,
      taskStatus: null,
      taskNumber: null,
      taskAssigneeType: null,
      taskAssigneeId: null,
      taskClaimedAt: null,
      taskCompletedAt: null,
      createdAt,
      updatedAt: createdAt,
    }]],
    updateResults: [[{
      id: "a0000000-0000-4000-8000-000000000001",
      filename: "report.png",
      mimeType: "image/png",
      sizeBytes: 1234,
      width: 100,
      height: 50,
      thumbnailKey: "thumb-1",
    }]],
    selectResults: [
      [],
      [{
        id: "a0000000-0000-4000-8000-000000000001",
        uploaderId: "agent-1",
        messageId: null,
        objectId: FAKE_OBJECT_ID,
      }],
      [{
        id: "a0000000-0000-4000-8000-000000000001",
        messageId: "msg-1",
        messagePosition: 0,
        channelId: "channel-1",
        uploaderId: "agent-1",
        uploaderType: "agent",
        filename: "report.png",
        mimeType: "image/png",
        sizeBytes: 1234,
        storageKey: "report.png",
        thumbnailKey: "thumb-1",
        contentHash: null,
        width: 100,
        height: 50,
        createdAt,
      }],
    ],
    insertCaptures: [insertCapture],
    updateCaptures: [updateCapture],
  });
  __setAgentSendReplayDbForTests(() => db as any);

  const result = await createOrReplayAgentSend({
    channelId: "channel-1",
    senderId: "agent-1",
    content: "hello",
    agentSendKey: "send-1",
    attachmentIds: ["a0000000-0000-4000-8000-000000000001"],
  });

  assert.equal(result.replayed, false);
  assert.equal(result.message.id, "msg-1");
  assert.equal(result.attachments.length, 1);
  assert.equal(insertCapture.table, messages);
  assert.equal(insertCapture.values?.agentSendKey, "send-1");
  assert.equal(updateCapture.table, attachments);
  assert.equal(updateCapture.setValues?.messageId, "msg-1");
  assert.equal(updateCapture.setValues?.messagePosition, 0);
});

test("createOrReplayAgentSend rejects attachment IDs already linked to another message", async () => {
  const createdAt = new Date("2026-04-16T00:00:00.000Z");
  const db = makeDb({
    insertResults: [[{
      id: "msg-1",
      seq: 42,
      channelId: "channel-1",
      senderType: "agent",
      senderId: "agent-1",
      agentSendKey: "send-1",
      messageType: "chat",
      content: "hello",
      searchText: "hello",
      searchVector: null,
      threadId: null,
      taskStatus: null,
      taskNumber: null,
      taskAssigneeType: null,
      taskAssigneeId: null,
      taskClaimedAt: null,
      taskCompletedAt: null,
      createdAt,
      updatedAt: createdAt,
    }]],
    updateResults: [],
    selectResults: [
      [],
      [{
        id: "a0000000-0000-4000-8000-000000000001",
        uploaderId: "agent-1",
        messageId: "msg-already-linked",
      }],
    ],
  });
  __setAgentSendReplayDbForTests(() => db as any);

  await assert.rejects(
    () => createOrReplayAgentSend({
      channelId: "channel-1",
      senderId: "agent-1",
      content: "hello",
      agentSendKey: "send-1",
      attachmentIds: ["a0000000-0000-4000-8000-000000000001"],
    }),
    /already attached to another message/,
  );
});

test("createOrReplayAgentSend replays the original successful send instead of inserting a duplicate", async () => {
  const insertCapture: InsertCapture = {};
  const createdAt = new Date("2026-04-16T00:00:00.000Z");
  const db = makeDb({
    insertResults: [[]],
    updateResults: [],
    selectResults: [
      [{
        id: "msg-1",
        seq: 42,
        channelId: "channel-1",
        senderType: "agent",
        senderId: "agent-1",
        agentSendKey: "send-1",
        messageType: "chat",
        content: "hello",
        searchText: "hello",
        searchVector: null,
        threadId: null,
        taskStatus: null,
        taskNumber: null,
        taskAssigneeType: null,
        taskAssigneeId: null,
        taskClaimedAt: null,
        taskCompletedAt: null,
        createdAt,
        updatedAt: createdAt,
      }],
      [{
        id: "a0000000-0000-4000-8000-000000000001",
        messageId: "msg-1",
        messagePosition: 0,
        channelId: "channel-1",
        uploaderId: "agent-1",
        uploaderType: "agent",
        filename: "report.png",
        mimeType: "image/png",
        sizeBytes: 1234,
        storageKey: "report.png",
        width: 100,
        height: 50,
        thumbnailKey: "thumb-1",
        contentHash: null,
        createdAt,
      }],
    ],
    insertCaptures: [insertCapture],
  });
  __setAgentSendReplayDbForTests(() => db as any);

  const result = await createOrReplayAgentSend({
    channelId: "channel-1",
    senderId: "agent-1",
    content: "hello",
    agentSendKey: "send-1",
    attachmentIds: ["a0000000-0000-4000-8000-000000000001"],
  });

  assert.equal(result.replayed, true);
  assert.equal(result.message.id, "msg-1");
  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0]?.filename, "report.png");
  assert.equal(insertCapture.table, messages);
});

test("createOrReplayAgentSend rejects a reordered attachment replay without writes", async () => {
  const createdAt = new Date("2026-04-16T00:00:00.000Z");
  const replayedMessage = {
    id: "msg-1",
    seq: 42,
    channelId: "channel-1",
    senderType: "agent",
    senderId: "agent-1",
    agentSendKey: "send-1",
    messageType: "chat",
    content: "hello",
    searchText: "hello",
    searchVector: null,
    threadId: null,
    taskStatus: null,
    taskNumber: null,
    taskAssigneeType: null,
    taskAssigneeId: null,
    taskClaimedAt: null,
    taskCompletedAt: null,
    createdAt,
    updatedAt: createdAt,
  };
  const linked = [
    {
      id: "a0000000-0000-4000-8000-000000000001",
      messageId: "msg-1",
      messagePosition: 0,
      channelId: "channel-1",
      uploaderId: "agent-1",
      uploaderType: "agent",
      filename: "first.png",
      mimeType: "image/png",
      sizeBytes: 1,
      storageKey: "first.png",
      thumbnailKey: null,
      contentHash: null,
      width: null,
      height: null,
      createdAt,
    },
    {
      id: "a0000000-0000-4000-8000-000000000002",
      messageId: "msg-1",
      messagePosition: 1,
      channelId: "channel-1",
      uploaderId: "agent-1",
      uploaderType: "agent",
      filename: "second.png",
      mimeType: "image/png",
      sizeBytes: 1,
      storageKey: "second.png",
      thumbnailKey: null,
      contentHash: null,
      width: null,
      height: null,
      createdAt,
    },
  ];
  const db = makeDb({
    insertResults: [[]],
    updateResults: [],
    selectResults: [[replayedMessage], linked],
  });
  __setAgentSendReplayDbForTests(() => db as any);

  await assert.rejects(
    () => createOrReplayAgentSend({
      channelId: "channel-1",
      senderId: "agent-1",
      content: "hello",
      agentSendKey: "send-1",
      attachmentIds: ["a0000000-0000-4000-8000-000000000002", "a0000000-0000-4000-8000-000000000001"],
    }),
    /different ordered attachment set/,
  );
});

test("createOrReplayAgentSend commits its winning callback atomically and never reruns it on replay", async ({ db: database }) => {

  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "agent-send-transaction-owner@slock.test",
    name: "agent-send-transaction-owner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Agent Send Transaction Server",
    slug: "agent-send-transaction-server",
    ownerId: owner.id,
  }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server.id,
    name: "agent-send-transaction-agent",
    displayName: "Agent Send Transaction Agent",
    runtime: "codex",
  }).returning();
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: "agent-send-transaction-channel",
    type: "channel",
  }).returning();

  await assert.rejects(
    createOrReplayAgentSend({
      channelId: channel.id,
      senderId: agent.id,
      content: "must roll back with derived facts",
      agentSendKey: "transaction-send-1",
      onInserted: async ({ executor, message }: { executor: DatabaseExecutor; message: typeof messages.$inferSelect }) => {
        assert.equal(message.channelId, channel.id);
        const [visibleInTransaction] = await executor
          .select({ id: messages.id })
          .from(messages)
          .where(eq(messages.id, message.id));
        assert.equal(visibleInTransaction?.id, message.id);
        throw new Error("derived fact write failed");
      },
    }),
    /derived fact write failed/,
  );
  assert.equal(
    (await db.select().from(messages)).length,
    0,
    "callback failure must roll the source message back",
  );

  let callbackCalls = 0;
  const first = await createOrReplayAgentSend({
    channelId: channel.id,
    senderId: agent.id,
    content: "commit source and derived facts once",
    agentSendKey: "transaction-send-1",
    onInserted: async ({ message }: { message: typeof messages.$inferSelect }) => {
      callbackCalls += 1;
      return { factMessageId: message.id };
    },
  });
  const replay = await createOrReplayAgentSend({
    channelId: channel.id,
    senderId: agent.id,
    content: "commit source and derived facts once",
    agentSendKey: "transaction-send-1",
    onInserted: async () => {
      callbackCalls += 1;
      return { factMessageId: "must-not-run" };
    },
  });

  assert.equal(first.replayed, false);
  assert.deepEqual(first.insertedTransactionResult, { factMessageId: first.message.id });
  assert.equal(replay.replayed, true);
  assert.equal(replay.message.id, first.message.id);
  assert.equal(replay.insertedTransactionResult, null);
  assert.equal(callbackCalls, 1);
  assert.equal((await db.select().from(messages)).length, 1);
});
