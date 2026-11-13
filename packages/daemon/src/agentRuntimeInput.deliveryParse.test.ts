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
