import assert from "node:assert/strict";
import { test } from "vitest";

import type { AgentMessage } from "@botiverse/raft-shared";
import { formatConcreteMessagesRuntimeInput } from "./agentRuntimeInput.js";

const driver = {
  communication: { chat: "slock_cli", runtimeControl: "none" },
} as any;

function message(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    channel_id: "thread-id",
    channel_name: "thread-name",
    channel_type: "thread",
    parent_channel_name: "proj-chat",
    parent_channel_type: "channel",
    sender_id: "sender-id",
    sender_name: "sender",
    sender_type: "human",
    content: "hello",
    timestamp: "2026-08-04T00:00:00.000Z",
    message_id: "12345678-0000-0000-0000-000000000000",
    ...overrides,
  };
}

test("direct-mention follow reactivation renders the exact repeatable unfollow command", () => {
  const output = formatConcreteMessagesRuntimeInput([
    message({
      thread_follow_reactivation: { thread_target: "#proj-chat:09a5ff05" },
    }),
  ], driver);

  assert.match(output, /this @mention re-subscribed you to ordinary replies/);
  assert.match(output, /raft thread unfollow --target "#proj-chat:09a5ff05"/);
});

test("ordinary followed-thread delivery does not invent a reactivation reminder", () => {
  const output = formatConcreteMessagesRuntimeInput([message()], driver);
  assert.doesNotMatch(output, /thread follow restored|thread unfollow/);
});

test("agent-facing timestamps are explicit UTC rather than host-local time", () => {
  const output = formatConcreteMessagesRuntimeInput([message()], driver);
  assert.match(output, /time=2026-08-04 00:00:00Z/);
});
