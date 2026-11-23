import assert from "node:assert/strict";
import type { AgentMessage } from "@botiverse/raft-shared";
import { RUNTIME_PROFILE_DAEMON_NOTICE_MESSAGE_PREFIX } from "./agentRuntimeInput";
import { breaksNoticeHold, isNoticeHoldEnabled, NOTICE_HOLD_DISABLED_ENV, OutstandingNoticeHold } from "./outstandingNoticeHold";

function message(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    channel_id: "channel-1",
    channel_name: "general",
    channel_type: "channel",
    sender_id: "user-1",
    sender_name: "alice",
    sender_type: "human",
    content: "hello",
    timestamp: "2026-11-16T00:00:00.000Z",
    seq: 1,
    message_id: "message-1",
    ...overrides,
  } as AgentMessage;
}

test("task #triage:#399: an @mention, a DM, a DM-thread reply and a runtime-profile message break through; channel traffic and app events do not", () => {
  assert.equal(breaksNoticeHold(message()), false);
  assert.equal(breaksNoticeHold(message({ channel_type: "thread", parent_channel_type: "channel" })), false);
  assert.equal(breaksNoticeHold(message({ mentioned: true })), true);
  assert.equal(breaksNoticeHold(message({ channel_type: "dm", channel_name: "alice" })), true);
  assert.equal(breaksNoticeHold(message({ channel_type: "thread", parent_channel_type: "dm" })), true);
  assert.equal(breaksNoticeHold(message({ message_id: `${RUNTIME_PROFILE_DAEMON_NOTICE_MESSAGE_PREFIX}k1` })), true);
  assert.equal(breaksNoticeHold(message({
    channel_type: "dm",
    sender_type: "third_party_app",
    third_party_event: {
      id: "event-1",
      kind: "notification",
      client_id: "stamp",
      client_name: "stamp",
      payload_hash: "0".repeat(64),
      payload: {},
    },
  } as Partial<AgentMessage>)), false);
});

test("task #triage:#399: the hold holds only in the session its notice went to, counts what it held and ends on release", () => {
  const hold = new OutstandingNoticeHold();
  assert.equal(hold.holds("session-1"), false, "nothing outstanding yet");
  assert.equal(hold.arm("session-1"), 0);
  assert.equal(hold.holds("session-1"), true);
  assert.equal(hold.holds("session-2"), false, "never across a session change");
  assert.equal(hold.noteSuppressed(), 1);
  assert.equal(hold.noteSuppressed(), 2);
  assert.equal(hold.arm("session-1"), 2, "a break-through re-arms and reports what the last one held");
  assert.equal(hold.suppressedCount, 0);
  hold.noteSuppressed();
  assert.deepEqual(hold.release(), { suppressed: 1 });
  assert.equal(hold.holds("session-1"), false);
  assert.equal(hold.release(), null);
});

test("task #triage:#399: a notice written before the session id is known holds in the session it learns (task #389)", () => {
  const hold = new OutstandingNoticeHold();
  hold.arm(null);
  assert.equal(hold.holds("session-1"), true);
  assert.equal(hold.holds("session-2"), false);
});

test("task #triage:#399: RAFT_DAEMON_NOTICE_HOLD_DISABLED turns the hold off", () => {
  assert.equal(isNoticeHoldEnabled({}), true);
  assert.equal(isNoticeHoldEnabled({ [NOTICE_HOLD_DISABLED_ENV]: "0" }), true);
  assert.equal(isNoticeHoldEnabled({ [NOTICE_HOLD_DISABLED_ENV]: "1" }), false);
  const previous = process.env[NOTICE_HOLD_DISABLED_ENV];
  process.env[NOTICE_HOLD_DISABLED_ENV] = "1";
  try {
    const hold = new OutstandingNoticeHold();
    hold.arm("session-1");
    assert.equal(hold.holds("session-1"), false);
  } finally {
    if (previous === undefined) delete process.env[NOTICE_HOLD_DISABLED_ENV];
    else process.env[NOTICE_HOLD_DISABLED_ENV] = previous;
  }
});
