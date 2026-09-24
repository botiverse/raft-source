import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMessageContextRequest,
  buildMessageContextRequestConfig,
  buildThreadParentContextRequest,
} from "../src/components/message/messageContextRequest";

test("thread panel message-context requests include the message URL and local channel scope", () => {
  assert.deepEqual(buildMessageContextRequest("reply-message", "local-thread-channel"), {
    url: "/messages/context/reply-message",
    config: {
      params: { channelId: "local-thread-channel" },
    },
  });
});

test("thread parent hydration uses the typed parent-channel projection scope", () => {
  assert.deepEqual(buildThreadParentContextRequest("parent-message", "participant-parent-projection"), {
    url: "/messages/context/parent-message",
    config: {
      params: { channelId: "participant-parent-projection" },
    },
  });
});

test("thread panel message-context requests carry the local channel scope", () => {
  assert.deepEqual(buildMessageContextRequestConfig("local-thread-channel"), {
    params: { channelId: "local-thread-channel" },
  });
});

test("message-context request config is omitted when there is no scoped channel", () => {
  assert.equal(buildMessageContextRequestConfig(null), undefined);
  assert.equal(buildMessageContextRequestConfig(undefined), undefined);
});
