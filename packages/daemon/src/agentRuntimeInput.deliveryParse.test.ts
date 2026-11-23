// #wg-ax:#19: View Context reads the daemon's turn input back into notices
// (`parseRaftDelivery`, @botiverse/raft-shared). Every registered example of
// the delivery surfaces is formatted here and parsed back, so a change to the
// inbox notice, a message header or a system notice that the parser does not
// follow fails in the PR that makes it.
import assert from "node:assert/strict";
import { isThirdPartyEventsTarget, parseRaftDelivery, THIRD_PARTY_EVENTS_LABEL, type RaftNoticeSegment } from "@botiverse/raft-shared";

import { projectAgentInboxSnapshot } from "./agentInboxProjection";
import {
  formatConcreteMessagesRuntimeInput,
  formatInboxUpdateRuntimeInput,
  formatSystemNoticeRuntimeInput,
} from "./agentRuntimeInput";
import { formatAgentMessageVisibleTarget } from "./agentVisibleDeliveryLedger";

type Kind = RaftNoticeSegment["kind"];
function only<K extends Kind>(segments: readonly RaftNoticeSegment[], kind: K): Array<Extract<RaftNoticeSegment, { kind: K }>> {
  return segments.filter((segment): segment is Extract<RaftNoticeSegment, { kind: K }> => segment.kind === kind);
}

for (const [index, example] of formatInboxUpdateRuntimeInput.axExamples.entries()) {
  test(`inbox notice example ${index + 1} parses back to its targets, counts and mentions`, () => {
    // Every argument, so an example's render options (a flag-on format) are formatted as written.
    const [messages, , total, options] = example.args;
    const delivery = parseRaftDelivery(formatInboxUpdateRuntimeInput(...example.args));
    assert.ok(delivery);
    const [inbox, ...more] = only(delivery.segments, "inbox");
    assert.ok(inbox, "one inbox notice");
    assert.equal(more.length, 0);
    assert.equal(only(delivery.segments, "generic").length, 0, "never a generic fallback");
    assert.equal(inbox.pendingTotal, total ?? messages.length);
    // Inbox items on: an event the Server lists as an app item is its own row (RFC 081).
    const rows = projectAgentInboxSnapshot(messages, undefined, { appInboxItemTargets: options?.inboxItems === true });
    assert.deepEqual(
      inbox.targets.map((target) => [target.target, target.pending, target.mentioned]),
      // The grouped third-party row is labelled, not addressed by its transport target.
      rows.map((row) => [isThirdPartyEventsTarget(row.target) ? THIRD_PARTY_EVENTS_LABEL : row.target, row.pendingCount, row.flags.includes("mention")]),
    );
  });
}

// The notice with the Server's unread numbers (inbox_notice_server_rows_v0): what the daemon writes
// with the flag on parses as an inbox notice too, with the Server's count, never as a generic one.
test("the inbox notice with the Server's rows parses back as an inbox notice: reason, rows, the Server's count, a numberless row, older unread", () => {
  const GENERAL = "11111111-aaaa-4bbb-8ccc-000000000001";
  const DM = "11111111-aaaa-4bbb-8ccc-000000000002";
  const base = formatInboxUpdateRuntimeInput.axExamples[0]!.args[0][0]!;
  const messages = [
    { ...base, message_id: "aaaa0000-0000-4000-8000-000000000001", seq: 100, channel_id: GENERAL, channel_type: "channel" as const, channel_name: "general", mentioned: true },
    { ...base, message_id: "aaaa0000-0000-4000-8000-000000000002", seq: 101, channel_id: DM, channel_type: "dm" as const, channel_name: "richard", mentioned: false },
  ];
  const text = formatInboxUpdateRuntimeInput(messages, formatInboxUpdateRuntimeInput.axExamples[0]!.args[1], 2, {
    inboxItems: true,
    serverRows: {
      reason: "new",
      // The Server answered for #general only: the DM prints without a number.
      covered: () => ({
        response: {
          rows: [{ channelId: GENERAL, target: "#general", kind: "conversation", unread: 5, mentions: 1, latestSender: { name: "richard", type: "user" }, preview: "can you review?", previewTruncated: false, firstUnreadAt: null, latestAt: null, preLaunch: false }],
          behind: 0,
          otherUnread: { conversations: 3, messages: 12, mentions: 0, dms: 0 },
        },
        ids: new Set([GENERAL]),
        older: { conversations: 3, messages: 12, mentions: 0, dms: 0 },
      }),
      previousOlderMessages: null,
    },
  });
  assert.ok(text.startsWith("[Raft inbox notice: new since your last notice, in 2 targets\n"), text);
  const delivery = parseRaftDelivery(text);
  assert.ok(delivery);
  assert.equal(only(delivery.segments, "generic").length, 0, "never a generic fallback");
  const [inbox, ...more] = only(delivery.segments, "inbox");
  assert.ok(inbox, "one inbox notice");
  assert.equal(more.length, 0);
  assert.equal(inbox.reason, "new");
  assert.equal(inbox.pendingTotal, null, "the new header has no total");
  assert.deepEqual(inbox.targets.map((target) => [target.target, target.pending, target.mentioned]), [
    // The Computer's order (newest first), whatever order the Server answered in.
    ["dm:@richard", null, false],
    ["#general", 5, true],
  ]);
  assert.deepEqual(inbox.older, { messages: 12, targets: 3 });
});

// An answer whose rows may be behind (`withBehind`): the number is the Server's count up to the row's
// `activitySeq` plus what the Computer holds after it; a conversation the Server has no row for
// prints what the Computer holds; one the answer was not asked about still prints no number.
test("the inbox notice adds what the Computer holds to a Server row that is behind", () => {
  const GENERAL = "11111111-aaaa-4bbb-8ccc-000000000001";
  const DM = "11111111-aaaa-4bbb-8ccc-000000000002";
  const OPS = "11111111-aaaa-4bbb-8ccc-000000000003";
  const base = formatInboxUpdateRuntimeInput.axExamples[0]!.args[0][0]!;
  const message = (n: number, seq: number, channelId: string, channelType: "channel" | "dm", name: string) =>
    ({ ...base, message_id: `aaaa0000-0000-4000-8000-00000000000${n}`, seq, channel_id: channelId, channel_type: channelType, channel_name: name, mentioned: false });
  const messages = [
    message(1, 100, GENERAL, "channel", "general"),
    message(2, 101, GENERAL, "channel", "general"),
    message(3, 102, DM, "dm", "richard"),
    message(4, 103, OPS, "channel", "ops"),
  ];
  const text = formatInboxUpdateRuntimeInput(messages, formatInboxUpdateRuntimeInput.axExamples[0]!.args[1], 4, {
    inboxItems: true,
    serverRows: {
      reason: "new",
      covered: () => ({
        response: {
          // The view counts 3 unread in #general up to seq 100: the Computer's message 101 is not in it.
          rows: [{ channelId: GENERAL, target: "#general", kind: "conversation", unread: 3, mentions: 0, activitySeq: 100, latestSender: { name: "old", type: "user" }, preview: "an older message", previewTruncated: false, firstUnreadAt: null, latestAt: null, preLaunch: false }],
          withBehind: true,
          behind: 2,
          otherUnread: { conversations: 0, messages: 0, mentions: 0, dms: 0 },
        },
        // #ops was not asked about.
        ids: new Set([GENERAL, DM]),
        older: null,
      }),
      previousOlderMessages: null,
    },
  });
  const [inbox] = only(parseRaftDelivery(text)!.segments, "inbox");
  assert.ok(inbox, text);
  assert.deepEqual(inbox.targets.map((target) => [target.target, target.pending]), [
    ["#ops", null],
    ["dm:@richard", 1],
    ["#general", 4],
  ]);
  assert.ok(!text.includes("an older message"), "a row that is behind shows the Computer's latest message, not the Server's older one");
});

for (const example of formatConcreteMessagesRuntimeInput.axExamples) {
  test(`message delivery (${example.title ?? "example"}) parses each message's header, target and body`, () => {
    const [messages] = example.args;
    const delivery = parseRaftDelivery(formatConcreteMessagesRuntimeInput(...example.args));
    assert.ok(delivery);
    const parsed = only(delivery.segments, "message");
    assert.equal(parsed.length, messages.length, "one message notice per message");
    for (const [i, message] of messages.entries()) {
      assert.equal(parsed[i]!.target, formatAgentMessageVisibleTarget(message));
      assert.ok(parsed[i]!.body.includes(message.content), "the body as the sender wrote it");
    }
  });
}

for (const example of formatSystemNoticeRuntimeInput.axExamples) {
  test("a system notice parses as the message it wraps", () => {
    const [message] = example.args;
    const delivery = parseRaftDelivery(formatSystemNoticeRuntimeInput(...example.args));
    assert.ok(delivery);
    const [parsed] = only(delivery.segments, "message");
    assert.ok(parsed);
    assert.ok(parsed.body.includes(message.content));
  });
}
