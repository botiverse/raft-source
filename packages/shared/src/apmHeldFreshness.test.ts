import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  buildApmFreshnessDecisionProducerFactId,
  projectApmFreshnessDecisionTrace,
  projectApmHeldFreshnessActivity,
  projectApmHeldFreshnessEnvelope,
} from "./apmHeldFreshness.js";

test("APM freshness producer fact is stable and body-free", () => {
  const input = {
    action: "send" as const,
    decision: "local_hold" as const,
    target: "#proj-runtime:ec2e5abc",
    reason: "pending messages are newer than model boundary",
    pendingMaxSeq: 42,
    modelSeenSeq: 40,
    heldMessageCount: 2,
    omittedMessageCount: 1,
  };

  const factId = buildApmFreshnessDecisionProducerFactId("agent-1", input);
  const expectedStableInput = [
    "{\"action\":\"send\",\"agentId\":\"agent-1\",\"decision\":\"local_hold\",",
    "\"heldMessageCount\":2,\"modelSeenSeq\":40,\"omittedMessageCount\":1,",
    "\"pendingMaxSeq\":42,\"reason\":\"pending messages are newer than model boundary\",",
    "\"target\":\"#proj-runtime:ec2e5abc\"}",
  ].join("");
  const expectedHash = createHash("sha256").update(expectedStableInput).digest("hex");

  assert.match(factId, /^freshness_decision_fact:[0-9a-f]{64}$/);
  assert.equal(factId, `freshness_decision_fact:${expectedHash}`);
  assert.equal(
    buildApmFreshnessDecisionProducerFactId("agent-1", { ...input }),
    factId,
    "same freshness decision boundaries must produce stable lineage",
  );
  assert.notEqual(
    buildApmFreshnessDecisionProducerFactId("agent-1", { ...input, pendingMaxSeq: 43 }),
    factId,
    "lineage must change when the freshness boundary changes",
  );
  assert.doesNotMatch(factId, /pending messages|#proj-runtime|body/i);
});

test("APM held freshness projector emits canonical response, activity, and trace projections", () => {
  const heldMessages = [
    { seq: 42, message_id: "pending-42", content: "newer pending body" },
    { seq: 43, message_id: "pending-43", content: "second pending body" },
  ];
  const producerFactId = "freshness_decision_fact:unit-held-response";

  const envelope = projectApmHeldFreshnessEnvelope({
    producerFactId,
    action: "send",
    heldMessages,
    newMessageCount: 5,
    omittedMessageCount: 3,
    seenUpToSeq: 43,
  });

  assert.deepEqual(envelope, {
    clauseId: "SMR-006",
    projector: "held-envelope",
    surface: "agent-api-held-response",
    producerFactId,
    body: {
      state: "held",
      outcome: "held",
      subtype: "freshness",
      reason: "newer_messages_available",
      decision: "local_hold",
      producerFactId,
      available_actions: ["check_messages", "send_draft", "send_anyway"],
      heldMessages,
      newMessageCount: 5,
      shownMessageCount: 2,
      omittedMessageCount: 3,
      seenUpToSeq: 43,
    },
  });

  const activity = projectApmHeldFreshnessActivity({
    producerFactId,
    action: "send",
    decision: "local_hold",
    target: "dm:@tygg",
    messageCount: 2,
  });
  assert.deepEqual(activity, {
    clauseId: "SMR-006",
    projector: "held-envelope",
    surface: "agent:activity",
    producerFactId,
    statusEntry: {
      kind: "status",
      activity: "working",
      activityKind: "working",
      detail: "Send held by freshness check",
      detailKind: "freshness_hold",
      producerFactId,
    },
    entry: {
      kind: "slock_action",
      producerFactId,
      title: "Send held by freshness check",
      text: [
        "target: dm:@tygg",
        "new messages: 2 newer messages",
        "decision: local hold; review the newer context before retrying",
      ].join("\n"),
    },
    entries: [
      {
        kind: "status",
        activity: "working",
        activityKind: "working",
        detail: "Send held by freshness check",
        detailKind: "freshness_hold",
        producerFactId,
      },
      {
        kind: "slock_action",
        producerFactId,
        title: "Send held by freshness check",
        text: [
          "target: dm:@tygg",
          "new messages: 2 newer messages",
          "decision: local hold; review the newer context before retrying",
        ].join("\n"),
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(activity.entry), /newer pending body|second pending body/);

  const trace = projectApmFreshnessDecisionTrace({
    producerFactId,
    decision: {
      action: "send",
      decision: "local_hold",
      target: "dm:@tygg",
      inboxTrustState: "model_stale",
      reason: "pending messages are newer than model boundary",
      pendingCount: 2,
      pendingMaxSeq: 43,
      modelSeenSeq: 41,
      heldMessageCount: 2,
      omittedMessageCount: 3,
    },
  });
  assert.deepEqual(trace, {
    clauseId: "SMR-006",
    projector: "held-envelope",
    surface: "daemon-trace",
    producerFactId,
    attrs: {
      producer_fact_id: producerFactId,
      action: "send",
      decision: "local_hold",
      target: "dm:@tygg",
      inbox_trust_state: "model_stale",
      reason: "pending messages are newer than model boundary",
      pending_count: 2,
      pending_max_seq: 43,
      model_seen_seq: 41,
      held_message_count: 2,
      omitted_message_count: 3,
    },
  });
});

test("APM held freshness projector keeps non-send actions as retry-only readouts", () => {
  const envelope = projectApmHeldFreshnessEnvelope({
    producerFactId: "freshness_decision_fact:unit-task-hold",
    action: "task_claim",
    heldMessages: [{ seq: 8, message_id: "pending-task" }],
    newMessageCount: 1,
    omittedMessageCount: 0,
    seenUpToSeq: 8,
  });
  assert.deepEqual(envelope.body.available_actions, ["check_messages", "retry_action"]);

  const activity = projectApmHeldFreshnessActivity({
    producerFactId: envelope.producerFactId,
    action: "task_claim",
    decision: "syncing_hold",
    target: "#proj-runtime",
    messageCount: 1,
  });
  assert.deepEqual(activity.entry, {
    kind: "slock_action",
    producerFactId: envelope.producerFactId,
    title: "Task claim held by freshness check",
    text: [
      "target: #proj-runtime",
      "unreviewed synced context for this target: 1 message",
      "reason: this target's latest synced context was not yet in your reviewed context",
      "action: review the synced context, then retry this action",
    ].join("\n"),
  });
  assert.deepEqual(activity.statusEntry, {
    kind: "status",
    activity: "working",
    activityKind: "working",
    detail: "Task claim held by freshness check",
    detailKind: "freshness_hold",
    producerFactId: envelope.producerFactId,
  });
});

test("reviewer-isolation held projector exposes only held state plus a content-free count", () => {
  const poison = {
    body: "independent reviewer verdict: reject",
    sender: "peer-reviewer",
    id: "blind-message-id",
    timestamp: "2042-01-02T03:04:05.000Z",
    reason: "peer_rejected_the_change",
  };
  const envelope = projectApmHeldFreshnessEnvelope({
    producerFactId: "freshness_decision_fact:unit-reviewer-isolation",
    action: "send",
    decision: "local_hold",
    freshnessContextMode: "withheld",
    heldMessages: [{
      seq: 9,
      message_id: poison.id,
      sender_name: poison.sender,
      timestamp: poison.timestamp,
      content: poison.body,
      reason: poison.reason,
    }],
    newMessageCount: 4,
    omittedMessageCount: 3,
    seenUpToSeq: 9,
  });

  assert.deepEqual(envelope.body, {
    state: "held",
    freshnessContextMode: "withheld",
    withheldMessageCount: 4,
  });
  const surface = JSON.stringify(envelope.body);
  for (const value of Object.values(poison)) {
    assert.doesNotMatch(surface, new RegExp(value));
  }
  assert.doesNotMatch(surface, /producerFactId|seenUpToSeq|heldMessages|available_actions|reason|decision|timestamp|sender/i);

});
