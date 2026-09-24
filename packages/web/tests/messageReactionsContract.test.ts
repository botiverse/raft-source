import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { QUICK_REACTION_EMOJIS } from "../src/components/message/reactionConstants";
import type { Message } from "../src/store/messageStore";
import { useMessageStore } from "../src/store/messageStore";
import { reactionReadModelStore } from "../src/store/reactionReadModels";

function message(id: string, channelId: string, content: string): Message {
  return {
    id,
    channelId,
    senderType: "user",
    senderId: "user-1",
    senderName: "User One",
    messageType: "chat",
    content,
    createdAt: "2026-08-22T00:00:00.000Z",
  };
}

afterEach(() => {
  useMessageStore.setState(useMessageStore.getInitialState(), true);
  reactionReadModelStore.getState().reset();
});

test("quick reactions expose the shared product emoji set", () => {
  assert.deepEqual(QUICK_REACTION_EMOJIS, ["👍", "❤️", "🎉", "👀", "🔥", "😂", "✅"]);
});

test("legacy reaction ingress becomes normalized shared facts without a private roster", () => {
  reactionReadModelStore.getState().activatePrincipal("user-1");
  const facts = reactionReadModelStore.getState().applyLegacyIngress({
    principalId: "user-1",
    serverId: "server-1",
    parentScopeKey: { serverId: "server-1", scopeKind: "channel", scopeId: "channel-1" },
    messageId: "message-1",
    source: "receiver-private",
    viewerUserId: "user-1",
    reactions: [{
      emoji: "👍",
      count: 2,
      reactorIds: ["user-1", "user-2"],
      reactorNames: ["User One", "User Two"],
    }],
  });

  assert.deepEqual(facts, [{ emoji: "👍", count: 2, previewK: [] }]);
  assert.equal(JSON.stringify(facts).includes("reactorIds"), false);
  assert.deepEqual(
    reactionReadModelStore.getState().readViewerOverlay("user-1", "server-1", "message-1", "👍"),
    { status: "loaded", reactedByMe: true },
  );
});

test("message updates patch both the channel cache and the visible sparse window", () => {
  const cached = message("message-1", "channel-1", "cached copy");
  const visible = message("message-1", "channel-1", "visible copy");
  const other = message("message-2", "channel-1", "untouched");
  useMessageStore.setState({
    currentChannelId: "channel-1",
    channelMessages: { "channel-1": [cached, other] },
    messages: [visible],
  } as never);

  useMessageStore.getState().updateMessage({
    id: "message-1",
    channelId: "channel-1",
    reactions: [{ emoji: "🎉", count: 3, reactorIds: [], reactorNames: [] }],
  });

  const state = useMessageStore.getState();
  assert.equal(state.channelMessages["channel-1"]?.[0]?.reactions?.[0]?.count, 3);
  assert.equal(state.messages[0]?.reactions?.[0]?.count, 3);
  assert.equal(state.channelMessages["channel-1"]?.[1], other, "unrelated cached rows retain identity");
});
