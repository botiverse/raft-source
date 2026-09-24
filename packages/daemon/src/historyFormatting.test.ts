import assert from "node:assert/strict";
import { test } from "vitest";
import { formatHistoryMessageLine } from "./historyFormatting.js";

test("formatHistoryMessageLine includes thread metadata when present", () => {
  const line = formatHistoryMessageLine({
    seq: 42,
    id: "msg-1",
    createdAt: "2026-04-15T00:00:00.000Z",
    senderName: "alice",
    senderType: "agent",
    content: "hello",
    threadId: "thread-123",
    replyCount: 3,
  });

  assert.match(line, /^\[seq=42 msg=msg-1 time=2026-04-15 00:00:00Z type=agent threadId=thread-123 replyCount=3\] @alice: hello$/);
});

test("formatHistoryMessageLine omits thread metadata for normal messages", () => {
  const line = formatHistoryMessageLine({
    seq: 7,
    id: "msg-2",
    createdAt: "2026-04-15T00:00:00.000Z",
    senderName: "bob",
    content: "plain",
  });

  assert.equal(line, "[seq=7 msg=msg-2 time=2026-04-15 00:00:00Z] @bob: plain");
});

test("formatHistoryMessageLine points CLI agents at raft attachment view", () => {
  const line = formatHistoryMessageLine({
    seq: 9,
    id: "msg-3",
    createdAt: "2026-04-15T00:00:00.000Z",
    senderName: "carol",
    content: "see attached",
    attachments: [{ id: "att-1", filename: "trace.log" }],
  });

  assert.match(line, /trace\.log \(id:att-1\)/);
  assert.match(line, /`raft attachment view --id <attachmentId> --output <path>`/);
  assert.doesNotMatch(line, /view_file/);
});
