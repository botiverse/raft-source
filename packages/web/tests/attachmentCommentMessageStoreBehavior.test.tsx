import assert from "node:assert/strict";
import test from "node:test";

const { useMessageStore } = await import("../src/store/messageStore.js");

type Message = import("../src/store/messageStore.js").Message;

const existingCommentRef: NonNullable<Message["commentRef"]> = {
  commentId: "comment-1",
  attachmentId: "attachment-1",
  attachmentName: "screen.png",
  anchorLabel: "line 12",
};

const replacementCommentRef: NonNullable<Message["commentRef"]> = {
  commentId: "comment-2",
  attachmentId: "attachment-2",
  attachmentName: "trace.txt",
  anchorLabel: "line 44",
};

function message(overrides: Partial<Message> & Pick<Message, "id" | "channelId">): Message {
  return {
    senderType: "user",
    senderId: "user-1",
    content: "hello",
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function resetMessageStore() {
  useMessageStore.setState({
    channelMessages: {},
    messages: [],
    currentChannelId: null,
    unreadCounts: {},
    mentionFlags: {},
    hasNewer: false,
    isNearBottom: true,
    lastSeq: 0,
  });
}

test("shared stripped cached message updates preserve scoped comment refs", () => {
  try {
    resetMessageStore();
    useMessageStore.getState().addMessage(message({
      id: "message-1",
      channelId: "channel-1",
      content: "original",
      commentRef: existingCommentRef,
    }));

    useMessageStore.getState().addMessage(message({
      id: "message-1",
      channelId: "channel-1",
      content: "shared stripped update",
    }));

    let cached = useMessageStore.getState().channelMessages["channel-1"]?.[0];
    assert.equal(cached?.content, "shared stripped update");
    assert.deepEqual(cached?.commentRef, existingCommentRef);

    useMessageStore.getState().addMessage(message({
      id: "message-1",
      channelId: "channel-1",
      content: "shared explicit null update",
      commentRef: null,
    }));

    cached = useMessageStore.getState().channelMessages["channel-1"]?.[0];
    assert.equal(cached?.content, "shared explicit null update");
    assert.deepEqual(cached?.commentRef, existingCommentRef);

    useMessageStore.getState().addMessage(message({
      id: "message-1",
      channelId: "channel-1",
      content: "scoped replacement update",
      commentRef: replacementCommentRef,
    }));

    cached = useMessageStore.getState().channelMessages["channel-1"]?.[0];
    assert.equal(cached?.content, "scoped replacement update");
    assert.deepEqual(cached?.commentRef, replacementCommentRef);
  } finally {
    resetMessageStore();
  }
});

test("cached message updates merge only the matching message id", () => {
  try {
    resetMessageStore();
    useMessageStore.setState({
      currentChannelId: "channel-1",
      channelMessages: {
        "channel-1": [
          message({
            id: "message-target",
            channelId: "channel-1",
            content: "target original",
            commentRef: existingCommentRef,
          }),
          message({
            id: "message-other",
            channelId: "channel-1",
            content: "other original",
          }),
        ],
      },
      messages: [
        message({
          id: "message-target",
          channelId: "channel-1",
          content: "target original",
          commentRef: existingCommentRef,
        }),
        message({
          id: "message-other",
          channelId: "channel-1",
          content: "other original",
        }),
      ],
    });

    useMessageStore.getState().addMessage(message({
      id: "message-target",
      channelId: "channel-1",
      content: "target updated",
    }));

    const bucket = useMessageStore.getState().channelMessages["channel-1"] ?? [];
    assert.equal(bucket.length, 2);
    assert.deepEqual(
      bucket.map((cached) => [cached.id, cached.content, cached.commentRef ?? null]),
      [
        ["message-target", "target updated", existingCommentRef],
        ["message-other", "other original", null],
      ],
    );
    assert.deepEqual(
      useMessageStore.getState().messages.map((cached) => [cached.id, cached.content]),
      [
        ["message-target", "target updated"],
        ["message-other", "other original"],
      ],
    );
  } finally {
    resetMessageStore();
  }
});
