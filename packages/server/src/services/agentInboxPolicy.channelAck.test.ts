import assert from "node:assert/strict";
import type { AgentMessage } from "@botiverse/raft-shared";
import { partitionTargetScopedMessagesUpToSeq } from "./agentInboxPolicy";

test("partitionTargetScopedMessagesUpToSeq keeps other channels and newer target messages", () => {
  const targetOld = { channel_id: "target", seq: 1 } as AgentMessage;
  const targetLatest = { channel_id: "target", seq: 2 } as AgentMessage;
  const targetFuture = { channel_id: "target", seq: 3 } as AgentMessage;
  const side = { channel_id: "side", seq: 2 } as AgentMessage;

  assert.deepEqual(
    partitionTargetScopedMessagesUpToSeq({
      inbox: [targetOld, targetLatest, targetFuture, side],
      channelId: "target",
      maxSeq: 2,
    }),
    {
      removed: [targetOld, targetLatest],
      retained: [targetFuture, side],
    },
  );
});
