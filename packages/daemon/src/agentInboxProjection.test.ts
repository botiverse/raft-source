import assert from "node:assert/strict";
import { test } from "vitest";
import fc from "fast-check";
import { ATTENTION_HINT_COPY_VERSION, ATTENTION_HINT_SCHEMA } from "@botiverse/raft-shared";

import {
  AGENT_INBOX_TARGET_ROW_KEYS,
  formatAgentInboxDelta,
  formatAgentInboxSnapshot,
  type AgentInboxProjectionMessage,
  type AgentInboxTargetRow,
  projectAgentInboxSnapshot,
} from "./agentInboxProjection.js";

type TargetFixture = {
  expectedTarget: string;
  messageTarget: Pick<
    AgentInboxProjectionMessage,
    "channel_type" | "channel_name" | "parent_channel_type" | "parent_channel_name" | "channel_id" | "parent_channel_id"
  >;
};

type GeneratedProjectionMessage = AgentInboxProjectionMessage & {
  expectedTarget: string;
};

type GeneratedMessageInput = {
  target: TargetFixture;
  senderType: "human" | "agent" | "system" | "third_party_app";
  senderName: string;
  taskNumber: number | null;
  taskStatus: string | null;
  mentioned: boolean;
};

const TARGET_FIXTURES: readonly TargetFixture[] = [
  {
    expectedTarget: "#proj-runtime",
    messageTarget: {
      channel_id: "channel-proj-runtime",
      channel_type: "channel",
      channel_name: "proj-runtime",
    },
  },
  {
    expectedTarget: "#proj-o11y",
    messageTarget: {
      channel_id: "channel-proj-o11y",
      channel_type: "channel",
      channel_name: "proj-o11y",
    },
  },
  {
    expectedTarget: "dm:@tygg",
    messageTarget: {
      channel_id: "dm-tygg",
      channel_type: "dm",
      channel_name: "tygg",
    },
  },
  {
    expectedTarget: "#proj-runtime:feedface",
    messageTarget: {
      channel_id: "thread-feedface",
      channel_type: "thread",
      channel_name: "thread-feedface-0000-4000-8000-000000000000",
      parent_channel_id: "channel-proj-runtime",
      parent_channel_type: "channel",
      parent_channel_name: "proj-runtime",
    },
  },
  {
    expectedTarget: "dm:@stdrc:badc0ffe",
    messageTarget: {
      channel_id: "thread-badc0ffe",
      channel_type: "thread",
      channel_name: "thread-badc0ffe-0000-4000-8000-000000000000",
      parent_channel_id: "dm-stdrc",
      parent_channel_type: "dm",
      parent_channel_name: "stdrc",
    },
  },
];

const generatedMessageArbitrary: fc.Arbitrary<GeneratedMessageInput> = fc.record({
  target: fc.constantFrom(...TARGET_FIXTURES),
  senderType: fc.constantFrom("human", "agent", "system", "third_party_app" as const),
  senderName: fc.constantFrom("tygg", "Jianwei", "Pai", "system", "external-build-app"),
  taskNumber: fc.option(fc.integer({ min: 1, max: 200 }), { nil: null }),
  taskStatus: fc.option(fc.constantFrom("todo", "in_progress", "in_review", "done"), { nil: null }),
  mentioned: fc.boolean(),
});

function generatedMessage(input: GeneratedMessageInput, index: number): GeneratedProjectionMessage {
  const seq = index + 1;
  return {
    ...input.target.messageTarget,
    expectedTarget: input.target.expectedTarget,
    seq,
    message_id: `generated-${String(seq).padStart(4, "0")}`,
    sender_type: input.senderType,
    sender_name: input.senderName,
    task_number: input.taskNumber,
    task_status: input.taskStatus,
    mentioned: input.mentioned,
  };
}

function expectedRows(messages: readonly GeneratedProjectionMessage[]): AgentInboxTargetRow[] {
  const buckets = new Map<string, GeneratedProjectionMessage[]>();
  for (const message of messages) {
    const bucket = buckets.get(message.expectedTarget) ?? [];
    bucket.push(message);
    buckets.set(message.expectedTarget, bucket);
  }
  return [...buckets.entries()]
    .map(([target, bucket]) => {
      const sorted = [...bucket].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || String(a.message_id).localeCompare(String(b.message_id)));
      const first = sorted[0]!;
      const latest = sorted[sorted.length - 1]!;
      const flags = new Set<string>();
      if (bucket.some((message) => message.channel_type === "thread")) flags.add("thread");
      if (bucket.some((message) => message.channel_type === "dm")) flags.add("dm");
      if (bucket.some((message) => Boolean(message.task_number || message.task_status))) flags.add("task");
      if (bucket.some((message) => message.mentioned === true)) flags.add("mention");
      return {
        target,
        pendingCount: bucket.length,
        firstPendingMsgId: first.message_id,
        firstPendingSeq: first.seq,
        latestMsgId: latest.message_id,
        latestSeq: latest.seq,
        latestSenderName: latest.sender_name,
        latestSenderType: latest.sender_type as AgentInboxTargetRow["latestSenderType"],
        flags: [...flags].sort() as AgentInboxTargetRow["flags"],
      };
    })
    .sort((a, b) => (b.latestSeq ?? 0) - (a.latestSeq ?? 0) || a.target.localeCompare(b.target));
}

test("agent inbox projection groups pending messages by target without content", () => {
  const rows = projectAgentInboxSnapshot(([
    {
      seq: 10,
      message_id: "aaaaaaaa-0000-4000-8000-000000000000",
      channel_id: "thread-channel-id",
      channel_type: "thread",
      channel_name: "thread-12345678-aaaa-bbbb-cccc-000000000000",
      parent_channel_type: "channel",
      parent_channel_name: "proj-aiax",
      sender_type: "human",
      sender_name: "tygg",
      content: "must not leak" as never,
    },
    {
      seq: 12,
      message_id: "bbbbbbbb-0000-4000-8000-000000000000",
      channel_id: "thread-channel-id",
      channel_type: "thread",
      channel_name: "thread-12345678-aaaa-bbbb-cccc-000000000000",
      parent_channel_type: "channel",
      parent_channel_name: "proj-aiax",
      sender_type: "agent",
      sender_name: "Jianwei",
      content: "must not leak either" as never,
    },
    {
      seq: 11,
      id: "cccccccc-0000-4000-8000-000000000000",
      channel_id: "dm-channel-id",
      channel_type: "dm",
      channel_name: "tygg",
      sender_type: "human",
      sender_name: "tygg",
      task_status: "todo",
    },
  ] as any));

  assert.equal(rows.length, 2);
  assert.deepEqual(Object.keys(rows[0]).sort(), [...AGENT_INBOX_TARGET_ROW_KEYS].filter((key) => key !== "attentionHint" && key !== "suppressedCount").sort());
  assert.equal(rows[0].target, "#proj-aiax:12345678");
  assert.equal(rows[0].pendingCount, 2);
  assert.equal(rows[0].firstPendingMsgId, "aaaaaaaa-0000-4000-8000-000000000000");
  assert.equal(rows[0].firstPendingSeq, 10);
  assert.equal(rows[0].latestMsgId, "bbbbbbbb-0000-4000-8000-000000000000");
  assert.equal(rows[0].latestSeq, 12);
  assert.equal(rows[0].latestSenderName, "Jianwei");
  assert.deepEqual(rows[0].flags, ["thread"]);

  assert.equal(rows[1].target, "dm:@tygg");
  assert.deepEqual(rows[1].flags, ["dm", "task"]);
  assert.equal(JSON.stringify(rows).includes("must not leak"), false);
});

test("agent inbox projection treats mention flags as recipient-specific", () => {
  const rows = projectAgentInboxSnapshot(([
    {
      seq: 20,
      message_id: "dddddddd-0000-4000-8000-000000000000",
      channel_type: "channel",
      channel_name: "proj-aiax",
      sender_type: "human",
      sender_name: "tygg",
      mention: true,
    },
    {
      seq: 21,
      message_id: "eeeeeeee-0000-4000-8000-000000000000",
      channel_type: "channel",
      channel_name: "proj-runtime",
      sender_type: "human",
      sender_name: "tygg",
      mentioned: true,
    },
  ] as any));

  assert.deepEqual(rows.find((row) => row.target === "#proj-aiax")?.flags, []);
  assert.deepEqual(rows.find((row) => row.target === "#proj-runtime")?.flags, ["mention"]);
});

test("agent inbox projection preserves notify-only outsider reply guidance", () => {
  const rows = projectAgentInboxSnapshot([{
    seq: 22,
    message_id: "ffffffff-0000-4000-8000-000000000000",
    channel_type: "thread",
    channel_name: "thread-12345678-aaaa-bbbb-cccc-000000000000",
    parent_channel_type: "channel",
    parent_channel_name: "proj-aiax",
    sender_type: "human",
    sender_name: "tygg",
    mentioned: true,
    non_member_mention: true,
  }]);

  assert.deepEqual(rows[0]?.flags, ["mention", "non_member_mention", "thread"]);
  const output = formatAgentInboxDelta(rows);
  assert.match(output, /If no reply is needed, no action is required\. Otherwise, DM the person who mentioned you or join the channel to participate/);
});

test("agent inbox projection preserves generated bucket invariants", () => {
  fc.assert(
    fc.property(fc.array(generatedMessageArbitrary, { minLength: 1, maxLength: 40 }), (inputs) => {
      const messages = inputs.map(generatedMessage);
      const rows = projectAgentInboxSnapshot(messages);
      const expected = expectedRows(messages);

      assert.equal(rows.length, expected.length);
      for (let index = 0; index < expected.length; index += 1) {
        const row = rows[index]!;
        const expectedRow = expected[index]!;
        assert.equal(row.target, expectedRow.target);
        assert.equal(row.pendingCount, expectedRow.pendingCount);
        assert.equal(row.firstPendingMsgId, expectedRow.firstPendingMsgId);
        assert.equal(row.firstPendingSeq, expectedRow.firstPendingSeq);
        assert.equal(row.latestMsgId, expectedRow.latestMsgId);
        assert.equal(row.latestSeq, expectedRow.latestSeq);
        assert.equal(row.latestSenderName, expectedRow.latestSenderName);
        assert.equal(row.latestSenderType, expectedRow.latestSenderType);
        assert.deepEqual(row.flags, expectedRow.flags);
        if (row.pendingCount < 12 || row.flags.length > 0 || !row.target.startsWith("#")) {
          assert.equal(row.attentionHint, undefined);
        }
      }
    }),
    { numRuns: 250, seed: 156 },
  );
});

test("agent inbox projection renders explicit structured M2 attention hint", () => {
  const rows = projectAgentInboxSnapshot(Array.from({ length: 12 }, (_, index) => ({
    seq: index + 1,
    message_id: `${String(index + 1).padStart(8, "0")}-0000-4000-8000-000000000000`,
    channel_id: "channel-proj-runtime",
    channel_type: "channel",
    channel_name: "proj-runtime",
    sender_type: "human",
    sender_name: "tygg",
    ...(index === 11 ? {
      attention_hint: {
        schema: ATTENTION_HINT_SCHEMA,
        trigger: "M2",
        scope: "#proj-runtime",
        suggested_command: "raft channel mute \"#proj-runtime\"",
        copy: "You've received 12 updates from #proj-runtime with no action taken. If this channel doesn't need your attention: raft channel mute \"#proj-runtime\" -- @mentions still reach you; followed threads keep delivering until you unfollow them.",
        copy_version: ATTENTION_HINT_COPY_VERSION,
        epoch_ms: 123,
        thresholds: { K: 12, window_ms: 7 * 24 * 60 * 60 * 1000 },
      },
    } : {}),
    content: "must not leak" as never,
  })));

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.attentionHint?.trigger, "M2");
  assert.equal(rows[0]?.attentionHint?.scope, "#proj-runtime");
  assert.equal(rows[0]?.attentionHint?.thresholds.K, 12);
  assert.deepEqual(Object.keys(rows[0] ?? {}).sort(), [...AGENT_INBOX_TARGET_ROW_KEYS].filter((key) => key !== "suppressedCount").sort());
  const delta = formatAgentInboxDelta(rows, { totalPendingMessages: 12 });
  assert.match(delta, /attention_hint=/);
  assert.match(delta, /"schema":"attention-dependency-hint\.v1"/);
  assert.match(delta, /"trigger":"M2"/);
  assert.match(delta, /followed threads keep delivering until you unfollow them/);
  assert.doesNotMatch(delta, /threads you follow still deliver|thread following is separate/i);
  assert.doesNotMatch(delta, /must not leak/);
});

test("gate_blind_nudger does not synthesize hint without explicit oracle payload", () => {
  const rows = projectAgentInboxSnapshot(Array.from({ length: 12 }, (_, index) => ({
    seq: index + 1,
    message_id: `${String(index + 1).padStart(8, "0")}-0000-4000-8000-000000000000`,
    channel_id: "channel-proj-runtime",
    channel_type: "channel",
    channel_name: "proj-runtime",
    sender_type: "human",
    sender_name: "tygg",
    content: "must not leak" as never,
  })));

  assert.equal(rows[0]?.attentionHint, undefined);
  assert.deepEqual(rows[0]?.flags, []);
});

test("agent inbox formatting renders target rows without previews", () => {
  const rows = projectAgentInboxSnapshot(([
    {
      seq: 1,
      message_id: "dddddddd-0000-4000-8000-000000000000",
      channel_type: "channel",
      channel_name: "proj-runtime",
      sender_type: "human",
      sender_name: "tygg",
      content: "hidden" as never,
    },
  ] as any));

  const snapshot = formatAgentInboxSnapshot(rows);
  assert.match(snapshot, /^Inbox: 1 pending target/);
  assert.match(snapshot, /#proj-runtime/);
  assert.match(snapshot, /first msg=dddddddd/);
  assert.doesNotMatch(snapshot, /hidden/);

  const delta = formatAgentInboxDelta(rows);
  assert.match(delta, /^Inbox update: 1 changed target/);
  assert.match(delta, /#proj-runtime/);
  assert.doesNotMatch(delta, /hidden/);

  const totalDelta = formatAgentInboxDelta(rows, { totalPendingMessages: 3 });
  assert.match(totalDelta, /^Inbox update: 3 unread messages total; 1 changed target/);
  assert.match(totalDelta, /#proj-runtime/);
  assert.doesNotMatch(totalDelta, /hidden/);
});

test("third-party event inbox notice stays a grouped pending projection", () => {
  const rows = projectAgentInboxSnapshot(([
    {
      message_id: "11111111-0000-4000-8000-000000000000",
      channel_id: "third-party-agent-events:agent-123",
      channel_type: "dm",
      channel_name: "third-party-agent-events:agent-123",
      sender_type: "third_party_app",
      sender_name: "task44-demo-third-party",
      content: "must not leak" as never,
      third_party_event: {
        id: "aaaaaaaa-0000-4000-8000-000000000000",
        kind: "event",
      },
    },
    {
      message_id: "22222222-0000-4000-8000-000000000000",
      channel_id: "third-party-agent-events:agent-123",
      channel_type: "dm",
      channel_name: "third-party-agent-events:agent-123",
      sender_type: "third_party_app",
      sender_name: "task44-demo-third-party",
      content: "must not leak either" as never,
      third_party_event: {
        id: "bbbbbbbb-0000-4000-8000-000000000000",
        kind: "notification",
      },
    },
  ] as any));

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.target, "dm:@third-party-agent-events:agent-123");
  assert.equal(rows[0]?.pendingCount, 2);
  assert.equal(rows[0]?.latestSenderType, "third_party_app");
  assert.deepEqual(rows[0]?.flags, ["dm"]);

  const delta = formatAgentInboxDelta(rows, { totalPendingMessages: 2 });
  assert.match(delta, /dm:@third-party-agent-events:agent-123/);
  assert.doesNotMatch(delta, /agent-event:aaaaaaaa/);
  assert.doesNotMatch(delta, /agent-event:bbbbbbbb/);
  assert.doesNotMatch(delta, /must not leak/);
});

test("agent inbox formatting handles empty snapshot and delta", () => {
  assert.equal(formatAgentInboxSnapshot([]), "Inbox: empty");
  assert.equal(formatAgentInboxDelta([]), "Inbox update: no pending targets");
});

// --- task #143: suppressed counts ride ALONGSIDE the message list -----------
//
// Ruled: the count is a property of the TARGET, not of any message, so it
// arrives as a sibling parameter. Synthesising placeholder "suppressed
// messages" into the list would make a non-message into a message and would
// change the message surface, which this work does not touch.

test("#143 a suppressed count attaches to its target's row", () => {
  const rows = projectAgentInboxSnapshot(
    [{ seq: 5, id: "m1", channel_id: "c1", channel_name: "qa", channel_type: "channel" }],
    new Map([["#qa", 4]]),
  );
  const qa = rows.find((r) => r.target === "#qa");
  assert.ok(qa, "expected a row for #qa");
  assert.equal(qa.suppressedCount, 4);
});

test("#143 a target whose notifications were ALL suppressed still produces a row", () => {
  // This is the case the card exists for: no messages arrived, so without this
  // the target has no row at all and the suppression stays invisible.
  const rows = projectAgentInboxSnapshot([], new Map([["#silent", 3]]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].target, "#silent");
  assert.equal(rows[0].pendingCount, 0);
  assert.equal(rows[0].suppressedCount, 3);
});

test("#143 control: omitting the sibling argument changes nothing", () => {
  const messages = [{ seq: 5, id: "m1", channel_id: "c1", channel_name: "qa", channel_type: "channel" }];
  assert.deepEqual(projectAgentInboxSnapshot(messages), projectAgentInboxSnapshot(messages, new Map()));
});

test("#143 control: a zero count adds neither a row nor a field", () => {
  const rows = projectAgentInboxSnapshot([], new Map([["#none", 0]]));
  assert.equal(rows.length, 0);
});

// --- #143 count domain: the map's `number` admits values the surface must not show
//
// `ReadonlyMap<string, number>` accepts Infinity, 1.5, -3 and NaN, and the
// renderer would faithfully print "Infinity suppressed (not delivered)".
// Validated HERE rather than deferred to a future server->daemon parser: that
// parser does not exist, so treating a bare number as already-validated would
// be trusting a check nobody has written. Illegal values fail closed -- the
// count is dropped, not rendered -- because a wrong number in a surface the
// agent reads is worse than none: it looks like a measurement.

for (const [label, bad] of [["Infinity", Infinity], ["fraction", 1.5], ["negative", -3], ["NaN", NaN]] as const) {
  test(`#143 count domain: ${label} is rejected, not rendered`, () => {
    const rows = projectAgentInboxSnapshot(
      [{ seq: 1, id: "m1", channel_id: "c1", channel_name: "qa", channel_type: "channel" }],
      new Map([["#qa", bad]]),
    );
    assert.equal(rows[0]?.suppressedCount, undefined);
  });

  test(`#143 count domain: ${label} cannot conjure a suppressed-only row`, () => {
    assert.deepEqual(projectAgentInboxSnapshot([], new Map([["#ghost", bad]])), []);
  });
}

test("#143 count domain control: a valid positive integer still passes", () => {
  const rows = projectAgentInboxSnapshot([], new Map([["#ok", 2]]));
  assert.equal(rows[0]?.suppressedCount, 2);
});
