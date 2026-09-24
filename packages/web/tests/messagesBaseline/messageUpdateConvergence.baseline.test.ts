import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { ActionCardMetadata } from "@botiverse/raft-shared";
import {
  selectChannelMessageBucket,
  useMessageStore,
} from "../../src/store/messageStore";
import type {
  Message,
  MessageReaction,
} from "../../src/store/messageStore";

const channelId = "channel-j5";
const visibleMessageId = "message-visible";
const hiddenMessageId = "message-hidden";

function baseMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: visibleMessageId,
    seq: 101,
    channelId,
    senderType: "user",
    senderId: "user-1",
    senderName: "Ada",
    messageType: "chat",
    content: "original body",
    createdAt: "2026-07-10T06:00:00.000Z",
    reactions: [],
    actionMetadata: null,
    ...overrides,
  };
}

function reaction(count = 1): MessageReaction {
  return {
    emoji: "👍",
    count,
    reactorIds: ["user-2"],
    reactorNames: ["Ben"],
  };
}

function preparedActionCard(): ActionCardMetadata {
  return {
    kind: "action-card",
    state: "prepared",
    action: {
      type: "integration:approve_agent_login",
      requestId: "request-1",
      agentId: "agent-1",
      agentName: "Noel",
      clientId: "client-1",
      clientKey: "demo-app",
      clientName: "Demo App",
      scopes: ["messages:read"],
    },
  };
}

function executedActionCard(): ActionCardMetadata {
  return {
    ...preparedActionCard(),
    state: "executed",
    executedByUserName: "Ada",
    result: {
      kind: "agent-integration-login",
      requestId: "request-1",
      agentId: "agent-1",
      agentName: "Noel",
      clientId: "client-1",
      clientKey: "demo-app",
      clientName: "Demo App",
      scopes: ["messages:read"],
      grantId: "grant-1",
    },
  };
}

function seedMessages({
  visibleRows = [baseMessage()],
  bucketRows = visibleRows,
}: {
  visibleRows?: Message[];
  bucketRows?: Message[];
} = {}) {
  useMessageStore.setState({
    currentChannelId: channelId,
    channelMessages: { [channelId]: bucketRows },
    messages: visibleRows,
    unreadCounts: { [channelId]: 3 },
    lastSeq: Math.max(...bucketRows.map((message) => message.seq ?? 0), 0),
  });
}

function cachedBucketRows(): Message[] {
  return selectChannelMessageBucket(useMessageStore.getState(), channelId);
}

function cachedVisibleRows(): Message[] {
  return useMessageStore.getState().messages;
}

function cachedMessage(id = visibleMessageId): Message {
  const message = cachedBucketRows().find((row) => row.id === id);
  assert.ok(message, `expected message ${id} in channel bucket`);
  return message;
}

function updateMessage(patch: Pick<Message, "id" | "channelId"> & Partial<Message>) {
  useMessageStore.getState().updateMessage(patch);
}

function addMessage(message: Message) {
  useMessageStore.getState().addMessage(message);
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) =>
    permutations(items.filter((_, i) => i !== index)).map((rest) => [item, ...rest]),
  );
}

afterEach(() => {
  useMessageStore.setState(useMessageStore.getInitialState(), true);
});

test("T4a-J5: message updates converge cached content, reactions, delete-like state, and action cards without adding rows", () => {
  const original = baseMessage({ actionMetadata: preparedActionCard() });
  seedMessages({ visibleRows: [original], bucketRows: [original, baseMessage({ id: hiddenMessageId, seq: 102 })] });

  const deletionLikeUpdate = {
    id: visibleMessageId,
    channelId,
    messageType: "system" as const,
    content: "Ada deleted this message",
  };
  const reactionUpdate = {
    id: visibleMessageId,
    channelId,
    reactions: [reaction(2)],
  };
  const actionCardUpdate = {
    id: visibleMessageId,
    channelId,
    actionMetadata: executedActionCard(),
  };

  for (const patch of [deletionLikeUpdate, reactionUpdate, actionCardUpdate, reactionUpdate]) {
    updateMessage(patch);
  }

  assert.equal(cachedBucketRows().length, 2, "updates must not append duplicate rows to the channel bucket");
  assert.equal(cachedVisibleRows().length, 1, "updates must not append duplicate rows to the sparse visible window");
  assert.equal(useMessageStore.getState().unreadCounts[channelId], 3, "updates must not increment unread counts");

  const bucketMessage = cachedMessage();
  assert.equal(bucketMessage.messageType, "system");
  assert.equal(bucketMessage.content, "Ada deleted this message");
  assert.deepEqual(bucketMessage.reactions, [reaction(2)]);
  assert.equal((bucketMessage.actionMetadata as ActionCardMetadata | null)?.state, "executed");

  const visibleMessage = cachedVisibleRows()[0];
  assert.equal(visibleMessage?.id, visibleMessageId);
  assert.equal(visibleMessage.content, bucketMessage.content);
  assert.deepEqual(visibleMessage.reactions, bucketMessage.reactions);
  assert.equal((visibleMessage.actionMetadata as ActionCardMetadata | null)?.state, "executed");
});

test("T4a-J5: update-before-new creates no phantom row and converges when the canonical row arrives", () => {
  seedMessages({ visibleRows: [], bucketRows: [] });

  const finalMessage = baseMessage({
    id: "message-late",
    seq: 201,
    content: "edited before the create event arrived",
    reactions: [reaction()],
    actionMetadata: executedActionCard(),
  });

  updateMessage(finalMessage);
  assert.deepEqual(cachedBucketRows(), [], "an update for an uncached message must not create a phantom row");
  assert.deepEqual(cachedVisibleRows(), [], "the visible window must stay empty until the canonical message arrives");
  assert.equal(useMessageStore.getState().unreadCounts[channelId], 3, "ignored pre-new updates must not affect unread counts");

  addMessage(finalMessage);

  assert.equal(cachedBucketRows().length, 1, "canonical new event creates exactly one row");
  assert.equal(cachedVisibleRows().length, 1, "current visible window receives exactly one row");
  assert.equal(cachedMessage("message-late").content, finalMessage.content);
  assert.deepEqual(cachedMessage("message-late").reactions, [reaction()]);
  assert.equal((cachedMessage("message-late").actionMetadata as ActionCardMetadata | null)?.state, "executed");
});

test("T4a-J5: duplicate and permuted update facts are idempotent and reach the same terminal row", () => {
  const updates: Array<Pick<Message, "id" | "channelId"> & Partial<Message>> = [
    { id: visibleMessageId, channelId, content: "edited body" },
    { id: visibleMessageId, channelId, reactions: [reaction(3)] },
    { id: visibleMessageId, channelId, actionMetadata: executedActionCard() },
  ];

  for (const order of permutations(updates)) {
    seedMessages({ visibleRows: [baseMessage({ actionMetadata: preparedActionCard() })] });
    for (const patch of [...order, order[0], order[1]]) {
      updateMessage(patch);
    }

    const terminal = cachedMessage();
    assert.equal(cachedBucketRows().length, 1);
    assert.equal(cachedVisibleRows().length, 1);
    assert.equal(terminal.content, "edited body");
    assert.deepEqual(terminal.reactions, [reaction(3)]);
    assert.equal((terminal.actionMetadata as ActionCardMetadata | null)?.state, "executed");

    useMessageStore.setState(useMessageStore.getInitialState(), true);
  }
});
