import { test } from "vitest";
import assert from "node:assert/strict";

import { partitionAcknowledgedMessages } from "./agentOrchestrator.js";
import type { AgentMessage } from "@botiverse/raft-shared";

function makeMessage(seq?: number, messageId?: string): AgentMessage {
  return {
    channel_id: "channel-1",
    channel_name: "general",
    channel_type: "channel",
    sender_id: "user-1",
    sender_name: "tygg",
    sender_type: "human",
    content: `msg-${seq ?? messageId ?? "none"}`,
    timestamp: new Date(0).toISOString(),
    seq,
    message_id: messageId,
  };
}

test("partitionAcknowledgedMessages removes only matching sequenced messages", () => {
  const seq1 = makeMessage(1, "m1");
  const seq2 = makeMessage(2, "m2");
  const seq3 = makeMessage(3, "m3");

  assert.deepEqual(
    partitionAcknowledgedMessages({
      inbox: [seq1, seq2, seq3],
      ackedSeqs: new Set([2]),
    }),
    {
      removed: [seq2],
      retained: [seq1, seq3],
    },
  );
});

test("partitionAcknowledgedMessages keeps seq-less messages even when ack set is non-empty", () => {
  const seq1 = makeMessage(1, "m1");
  const noSeq = makeMessage(undefined, "m-no-seq");

  assert.deepEqual(
    partitionAcknowledgedMessages({
      inbox: [seq1, noSeq],
      ackedSeqs: new Set([1, 999]),
    }),
    {
      removed: [seq1],
      retained: [noSeq],
    },
  );
});

test("partitionAcknowledgedMessages returns the full inbox as retained when no seq matches", () => {
  const seq1 = makeMessage(1, "m1");
  const seq2 = makeMessage(2, "m2");

  assert.deepEqual(
    partitionAcknowledgedMessages({
      inbox: [seq1, seq2],
      ackedSeqs: new Set([42]),
    }),
    {
      removed: [],
      retained: [seq1, seq2],
    },
  );
});
