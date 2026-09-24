import assert from "node:assert/strict";
import { test } from "vitest";
import fc from "fast-check";

import { buildApmFreshnessDecisionProducerFactId } from "./apmStateMachine.js";
import {
  planAgentInboxSideEffect,
  type AgentInboxFreshnessDecision,
  type AgentInboxStateMachineEffect,
  type AgentInboxStateMachineMessage,
} from "./agentInboxStateMachine.js";

function message(seq: number, input: Partial<AgentInboxStateMachineMessage> = {}): AgentInboxStateMachineMessage {
  return {
    seq,
    id: `message-${seq}`,
    sender_id: `sender-${seq}`,
    channel_type: "dm",
    channel_name: "tygg",
    content: `body ${seq}`,
    ...input,
  };
}

function recordedDecision(effects: AgentInboxStateMachineEffect[]): AgentInboxFreshnessDecision {
  const effect = effects.find((item) => item.type === "record_freshness_decision");
  assert.ok(effect);
  return effect.decision;
}

function consumeEffect(effects: AgentInboxStateMachineEffect[]): Extract<AgentInboxStateMachineEffect, { type: "consume_visible_messages" }> {
  const effect = effects.find((item) => item.type === "consume_visible_messages");
  assert.ok(effect);
  return effect;
}

function maxSeq(messages: readonly AgentInboxStateMachineMessage[]): number | undefined {
  const seqs = messages
    .map((item) => item.seq)
    .filter((seq): seq is number => typeof seq === "number" && Number.isFinite(seq) && seq > 0);
  return seqs.length > 0 ? Math.max(...seqs) : undefined;
}

function latestMessages(
  messages: readonly AgentInboxStateMachineMessage[],
  limit: number,
): AgentInboxStateMachineMessage[] {
  const sorted = [...messages].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return sorted.slice(Math.max(0, sorted.length - limit));
}

test("agent inbox state machine locally holds exact-target pending messages", () => {
  const pendingMessages = [40, 41, 42, 43, 44].map((seq) => message(seq));

  const plan = planAgentInboxSideEffect({
    agentId: "agent-1",
    action: "send",
    target: "dm:@tygg",
    continueAnyway: false,
    pendingMessages,
    recentMessages: [],
  });

  assert.equal(plan.outcome, "held");
  assert.equal(plan.localResponse?.state, "held");
  assert.equal(plan.localResponse?.seenUpToSeq, 44);
  assert.deepEqual(plan.localResponse?.heldMessages?.map((item) => item.seq), [42, 43, 44]);
  assert.equal(plan.localResponse?.newMessageCount, 5);
  assert.equal(plan.localResponse?.shownMessageCount, 3);
  assert.equal(plan.localResponse?.omittedMessageCount, 2);

  assert.deepEqual(consumeEffect(plan.effects), {
    type: "consume_visible_messages",
    target: "dm:@tygg",
    messages: plan.localResponse?.heldMessages,
    boundarySeq: 44,
    source: "side_effect_preflight_context",
  });

  const decision = recordedDecision(plan.effects);
  const expectedDecision = {
    action: "send",
    decision: "local_hold",
    target: "dm:@tygg",
    inboxTrustState: "trusted",
    reason: "exact_target_pending",
    pendingCount: 5,
    pendingMaxSeq: 44,
    modelSeenSeq: undefined,
    heldMessageCount: 3,
    omittedMessageCount: 2,
  } satisfies AgentInboxFreshnessDecision;
  assert.deepEqual(decision, {
    ...expectedDecision,
    producerFactId: buildApmFreshnessDecisionProducerFactId("agent-1", expectedDecision),
  });
  assert.deepEqual(plan.trace, [
    {
      step: "input",
      data: {
        action: "send",
        target: "dm:@tygg",
        continueAnyway: false,
        pendingCount: 5,
        recentCount: 0,
      },
    },
    { step: "pending_messages_found", data: { pendingCount: 5 } },
    { step: "pending_context_classified", data: { pendingCount: 5, unseenCount: 5 } },
    { step: "held_context_built", data: { boundarySeq: 44, heldBoundarySeq: 44, heldCount: 3, omittedCount: 2 } },
    {
      step: "plan_built",
      data: {
        outcome: "held",
        decision: "local_hold",
        effectCount: 2,
        localResponseState: "held",
        seenUpToSeq: 44,
      },
    },
  ]);
});

test("reviewer isolation locally holds without surfacing or consuming pending bodies", () => {
  const secretBody = "other reviewer's verdict: approve";
  const plan = planAgentInboxSideEffect({
    agentId: "agent-1",
    action: "send",
    target: "#reviews:blind",
    continueAnyway: false,
    freshnessContextMode: "withheld",
    modelSeenSeq: 40,
    pendingMessages: [message(41, { content: secretBody })],
    recentMessages: [],
  });

  assert.equal(plan.outcome, "held");
  assert.deepEqual(plan.localResponse, {
    state: "held",
    freshnessContextMode: "withheld",
    withheldMessageCount: 1,
  });
  assert.equal(plan.effects.some((effect) => effect.type === "consume_visible_messages"), false);
  assert.doesNotMatch(JSON.stringify(plan.localResponse), new RegExp(secretBody));

  const decision = recordedDecision(plan.effects);
  assert.equal(decision.decision, "local_hold");
  assert.equal(decision.freshnessContextMode, "withheld");
  assert.equal(plan.trace.at(-1)?.data?.effectCount, 1);
});

test("agent inbox state machine forwards exact-target pending messages inside model boundary", () => {
  const pendingMessages = [
    message(45, { sender_id: "agent-1", content: "self-authored pending row" }),
    message(46, { sender_id: "agent-1", content: "newer self-authored pending row" }),
  ];

  const plan = planAgentInboxSideEffect({
    agentId: "agent-1",
    action: "send",
    target: "dm:@tygg",
    continueAnyway: false,
    modelSeenSeq: 46,
    pendingMessages,
    recentMessages: [],
  });

  assert.equal(plan.outcome, "forward");
  assert.equal(plan.localResponse, undefined);
  assert.equal(plan.forwardSeenUpToSeq, 46);
  const consume = consumeEffect(plan.effects);
  assert.deepEqual(consume.messages.map((item) => item.seq), [45, 46]);
  assert.equal(consume.boundarySeq, 46);
  assert.deepEqual(recordedDecision(plan.effects), {
    action: "send",
    decision: "forward",
    target: "dm:@tygg",
    inboxTrustState: "trusted",
    reason: "exact_target_pending_already_seen",
    pendingCount: 2,
    pendingMaxSeq: 46,
    modelSeenSeq: 46,
    heldMessageCount: 0,
    omittedMessageCount: 0,
  });
  assert.deepEqual(plan.trace, [
    {
      step: "input",
      data: {
        action: "send",
        target: "dm:@tygg",
        continueAnyway: false,
        pendingCount: 2,
        recentCount: 0,
        modelSeenSeq: 46,
      },
    },
    { step: "pending_messages_found", data: { pendingCount: 2 } },
    { step: "pending_context_classified", data: { pendingCount: 2, unseenCount: 0 } },
    { step: "pending_context_already_seen", data: { boundarySeq: 46 } },
    {
      step: "plan_built",
      data: {
        outcome: "forward",
        decision: "forward",
        effectCount: 2,
        forwardSeenUpToSeq: 46,
      },
    },
  ]);
});

test("agent inbox state machine forwards self-authored pending messages without holding", () => {
  const pendingMessages = [
    message(101, { sender_id: "agent-1", content: "self-authored pending row" }),
    message(102, { sender_id: undefined, senderId: "agent-1", content: "newer self-authored pending row" }),
  ];

  const plan = planAgentInboxSideEffect({
    agentId: "agent-1",
    action: "send",
    target: "dm:@tygg",
    continueAnyway: false,
    pendingMessages,
    recentMessages: [],
  });

  assert.equal(plan.outcome, "forward");
  assert.equal(plan.localResponse, undefined);
  assert.equal(plan.forwardSeenUpToSeq, undefined);
  const consume = consumeEffect(plan.effects);
  assert.equal(consume.boundarySeq, undefined);
  assert.deepEqual(consume.messages.map((item) => item.seq), [undefined, undefined]);
  assert.deepEqual(recordedDecision(plan.effects), {
    action: "send",
    decision: "forward",
    target: "dm:@tygg",
    inboxTrustState: "trusted",
    reason: "exact_target_pending_already_seen",
    pendingCount: 2,
    pendingMaxSeq: 102,
    modelSeenSeq: undefined,
    heldMessageCount: 0,
    omittedMessageCount: 0,
  });
});

test("agent inbox state machine holds only exact-target pending rows beyond model boundary", () => {
  const pendingMessages = [
    message(47, { sender_id: "agent-1", content: "boundary-inside self-authored row" }),
    message(48, { sender_id: "human-1", content: "unseen row" }),
  ];

  const plan = planAgentInboxSideEffect({
    agentId: "agent-1",
    action: "send",
    target: "dm:@tygg",
    continueAnyway: false,
    modelSeenSeq: 47,
    pendingMessages,
    recentMessages: [],
  });

  assert.equal(plan.outcome, "held");
  assert.equal(plan.localResponse?.seenUpToSeq, 48);
  assert.equal(plan.localResponse?.newMessageCount, 1);
  assert.deepEqual(plan.localResponse?.heldMessages?.map((item) => item.seq), [48]);

  const consume = consumeEffect(plan.effects);
  assert.deepEqual(consume.messages.map((item) => item.seq), [47, 48]);
  assert.equal(consume.boundarySeq, 48);

  const decision = recordedDecision(plan.effects);
  assert.equal(decision.decision, "local_hold");
  assert.equal(decision.reason, "exact_target_pending");
  assert.equal(decision.pendingCount, 2);
  assert.equal(decision.pendingMaxSeq, 48);
  assert.equal(decision.modelSeenSeq, 47);
  assert.equal(decision.heldMessageCount, 1);
  assert.deepEqual(plan.trace, [
    {
      step: "input",
      data: {
        action: "send",
        target: "dm:@tygg",
        continueAnyway: false,
        pendingCount: 2,
        recentCount: 0,
        modelSeenSeq: 47,
      },
    },
    { step: "pending_messages_found", data: { pendingCount: 2 } },
    { step: "pending_context_classified", data: { pendingCount: 2, unseenCount: 1 } },
    { step: "held_context_built", data: { boundarySeq: 48, heldBoundarySeq: 48, heldCount: 1, omittedCount: 0 } },
    {
      step: "plan_built",
      data: {
        outcome: "held",
        decision: "local_hold",
        effectCount: 2,
        localResponseState: "held",
        seenUpToSeq: 48,
      },
    },
  ]);
});

test("agent inbox state machine does not let exact-seen newer pending rows overshoot unseen older rows", () => {
  const pendingMessages = [
    message(48, { sender_id: "human-1", content: "older unseen row" }),
    message(49, { id: "self-49", message_id: "self-49", sender_id: "agent-1", content: "newer exact-seen self row" }),
  ];

  const plan = planAgentInboxSideEffect({
    agentId: "agent-1",
    action: "send",
    target: "dm:@tygg",
    continueAnyway: false,
    modelSeenSeq: 47,
    pendingMessages,
    recentMessages: [],
    isMessageModelSeen: ({ message }) => message.message_id === "self-49",
  });

  assert.equal(plan.outcome, "held");
  assert.equal(plan.localResponse?.seenUpToSeq, 48);
  assert.equal(plan.localResponse?.newMessageCount, 1);
  assert.deepEqual(plan.localResponse?.heldMessages?.map((item) => item.seq), [48]);

  const consume = consumeEffect(plan.effects);
  assert.equal(consume.boundarySeq, 48);
  assert.deepEqual(consume.messages.map((item) => item.message_id), ["self-49", "message-48"]);
  assert.deepEqual(consume.messages.map((item) => item.seq), [undefined, 48]);

  const decision = recordedDecision(plan.effects);
  assert.equal(decision.decision, "local_hold");
  assert.equal(decision.reason, "exact_target_pending");
  assert.equal(decision.pendingMaxSeq, 48);
  assert.equal(decision.heldMessageCount, 1);
});

test("agent inbox state machine preserves generated exact-target freshness boundaries", () => {
  fc.assert(
    fc.property(
      fc.record({
        count: fc.integer({ min: 1, max: 12 }),
        modelSeenSeq: fc.integer({ min: 0, max: 14 }),
        existingSeenUpToSeq: fc.integer({ min: 0, max: 14 }),
        heldContextLimit: fc.integer({ min: 1, max: 5 }),
        exactSeenIndexes: fc.uniqueArray(fc.integer({ min: 0, max: 11 }), { maxLength: 12 }),
      }),
      ({ count, modelSeenSeq, existingSeenUpToSeq, heldContextLimit, exactSeenIndexes }) => {
        const pendingMessages = Array.from({ length: count }, (_, index) => message(index + 1, {
          id: `generated-${index + 1}`,
          message_id: `generated-${index + 1}`,
          sender_id: "human-1",
        }));
        const exactSeenIds = new Set(
          exactSeenIndexes
            .filter((index) => index < pendingMessages.length)
            .map((index) => pendingMessages[index]!.message_id),
        );
        const knownBoundary = Math.max(existingSeenUpToSeq, modelSeenSeq);
        const isSeen = (item: AgentInboxStateMachineMessage) => {
          const seq = item.seq ?? 0;
          return seq > 0 && modelSeenSeq >= seq || exactSeenIds.has(item.message_id);
        };
        const unseenMessages = pendingMessages.filter((item) => !isSeen(item));

        const plan = planAgentInboxSideEffect({
          agentId: "agent-1",
          action: "send",
          target: "dm:@tygg",
          continueAnyway: false,
          existingSeenUpToSeq,
          modelSeenSeq,
          pendingMessages,
          recentMessages: [],
          heldContextLimit,
          isMessageModelSeen: ({ message }) => exactSeenIds.has(message.message_id),
        });

        if (unseenMessages.length === 0) {
          const pendingBoundary = maxSeq(pendingMessages);
          assert.equal(plan.outcome, "forward");
          assert.equal(plan.localResponse, undefined);
          assert.equal(plan.forwardSeenUpToSeq, knownBoundary >= (pendingBoundary ?? 0) ? pendingBoundary : undefined);

          const consume = consumeEffect(plan.effects);
          assert.equal(consume.boundarySeq, knownBoundary >= (pendingBoundary ?? 0) ? pendingBoundary : undefined);
          for (const consumed of consume.messages) {
            if ((consumed.seq ?? 0) > knownBoundary) {
              assert.equal(consumed.seq, undefined);
            }
          }
          assert.equal(recordedDecision(plan.effects).reason, "exact_target_pending_already_seen");
          return;
        }

        const unseenBoundary = maxSeq(unseenMessages);
        const expectedHeldMessages = latestMessages(unseenMessages, heldContextLimit);

        assert.equal(plan.outcome, "held");
        assert.equal(plan.forwardSeenUpToSeq, undefined);
        assert.equal(plan.localResponse?.seenUpToSeq, unseenBoundary);
        assert.deepEqual(
          plan.localResponse?.heldMessages?.map((item) => item.message_id),
          expectedHeldMessages.map((item) => item.message_id),
        );
        assert.equal(plan.localResponse?.newMessageCount, unseenMessages.length);
        assert.equal(plan.localResponse?.shownMessageCount, expectedHeldMessages.length);
        assert.equal(plan.localResponse?.omittedMessageCount, Math.max(0, unseenMessages.length - expectedHeldMessages.length));

        const consume = consumeEffect(plan.effects);
        assert.equal(consume.boundarySeq, unseenBoundary);
        const consumedIds = new Set(consume.messages.map((item) => item.message_id));
        for (const held of expectedHeldMessages) {
          assert.equal(consumedIds.has(held.message_id), true);
        }
        for (const consumed of consume.messages) {
          if ((consumed.seq ?? 0) > knownBoundary && (consumed.seq ?? 0) > (unseenBoundary ?? 0)) {
            assert.equal(consumed.seq, undefined);
          }
        }

        const decision = recordedDecision(plan.effects);
        assert.equal(decision.reason, "exact_target_pending");
        assert.equal(decision.pendingMaxSeq, unseenBoundary);
        assert.equal(decision.heldMessageCount, expectedHeldMessages.length);
      },
    ),
    { numRuns: 350, seed: 15601 },
  );
});

test("agent inbox state machine does not hold generated already-safe side effects", () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.record({
          kind: fc.constant("continue_anyway" as const),
          count: fc.integer({ min: 0, max: 12 }),
          recentCount: fc.integer({ min: 0, max: 6 }),
        }),
        fc.record({
          kind: fc.constant("pending_all_model_seen" as const),
          count: fc.integer({ min: 1, max: 12 }),
        }),
        fc.record({
          kind: fc.constant("pending_all_exact_seen" as const),
          count: fc.integer({ min: 1, max: 12 }),
        }),
        fc.record({
          kind: fc.constant("pending_all_self_authored" as const),
          count: fc.integer({ min: 1, max: 12 }),
        }),
        fc.record({
          kind: fc.constant("boundary_without_pending" as const),
          boundary: fc.integer({ min: 1, max: 20 }),
        }),
        fc.record({
          kind: fc.constant("recent_all_seen" as const),
          count: fc.integer({ min: 1, max: 12 }),
        }),
        fc.record({
          kind: fc.constant("pending_missing_seq" as const),
          count: fc.integer({ min: 1, max: 12 }),
        }),
      ),
      (scenario) => {
        const pendingMessages = "count" in scenario
          ? Array.from({ length: scenario.count }, (_, index) => message(index + 1, {
            id: `generated-${index + 1}`,
            message_id: `generated-${index + 1}`,
          }))
          : [];
        const recentMessages = scenario.kind === "continue_anyway"
          ? Array.from({ length: scenario.recentCount }, (_, index) => message(index + 100, {
            id: `recent-${index + 1}`,
            message_id: `recent-${index + 1}`,
          }))
          : scenario.kind === "recent_all_seen"
            ? Array.from({ length: scenario.count }, (_, index) => message(index + 100, {
              id: `recent-${index + 1}`,
              message_id: `recent-${index + 1}`,
            }))
            : [];
        const missingSeqMessages = scenario.kind === "pending_missing_seq"
          ? pendingMessages.map((item) => ({ ...item, seq: undefined }))
          : scenario.kind === "pending_all_self_authored"
            ? pendingMessages.map((item, index) => ({
              ...item,
              sender_id: index % 2 === 0 ? "agent-1" : undefined,
              senderId: index % 2 === 0 ? undefined : "agent-1",
            }))
          : pendingMessages;
        const pendingMax = maxSeq(pendingMessages) ?? 0;

        const plan = planAgentInboxSideEffect({
          agentId: "agent-1",
          action: "send",
          target: "dm:@tygg",
          continueAnyway: scenario.kind === "continue_anyway",
          existingSeenUpToSeq: scenario.kind === "boundary_without_pending" ? scenario.boundary : 0,
          modelSeenSeq: scenario.kind === "pending_all_model_seen" ? pendingMax : 0,
          pendingMessages: missingSeqMessages,
          recentMessages,
          isMessageModelSeen: ({ message }) => (
            scenario.kind === "pending_all_exact_seen"
            || scenario.kind === "recent_all_seen"
            || scenario.kind === "continue_anyway"
          ) && Boolean(message.message_id || message.id),
        });

        assert.equal(plan.outcome, "forward");
        assert.equal(plan.localResponse, undefined);
        assert.equal(plan.effects.some((effect) => effect.type === "record_freshness_decision" && effect.decision.decision === "local_hold"), false);
        assert.equal(plan.effects.some((effect) => effect.type === "record_freshness_decision" && effect.decision.decision === "syncing_hold"), false);
      },
    ),
    { numRuns: 350, seed: 15602 },
  );
});

test("agent inbox state machine forwards send with the strongest model-seen boundary", () => {
  const plan = planAgentInboxSideEffect({
    agentId: "agent-1",
    action: "send",
    target: "#proj-aiax",
    continueAnyway: false,
    existingSeenUpToSeq: 9,
    modelSeenSeq: 12,
    pendingMessages: [],
    recentMessages: [],
  });

  assert.equal(plan.outcome, "forward");
  assert.equal(plan.forwardSeenUpToSeq, 12);
  assert.equal(plan.localResponse, undefined);
  assert.deepEqual(recordedDecision(plan.effects), {
    action: "send",
    decision: "forward",
    target: "#proj-aiax",
    inboxTrustState: "trusted",
    reason: "model_seen_boundary",
    pendingCount: 0,
    modelSeenSeq: 12,
  });
  assert.deepEqual(plan.trace, [
    {
      step: "input",
      data: {
        action: "send",
        target: "#proj-aiax",
        continueAnyway: false,
        pendingCount: 0,
        recentCount: 0,
        existingSeenUpToSeq: 9,
        modelSeenSeq: 12,
      },
    },
    { step: "model_boundary_checked", data: { boundary: 12 } },
    { step: "model_boundary_selected", data: { boundary: 12 } },
    {
      step: "plan_built",
      data: {
        outcome: "forward",
        decision: "forward",
        effectCount: 1,
        forwardSeenUpToSeq: 12,
      },
    },
  ]);
});

test("agent inbox state machine first-touch hold advances cursor with unseen recent context", () => {
  const recentMessages = [
    message(51, { sender_id: "human-1", content: "unseen recent row" }),
  ];

  const plan = planAgentInboxSideEffect({
    agentId: "agent-1",
    action: "send",
    target: "dm:@tygg",
    continueAnyway: false,
    pendingMessages: [],
    recentMessages,
  });

  assert.equal(plan.outcome, "held");
  assert.equal(plan.localResponse?.seenUpToSeq, 51);
  assert.equal(plan.localResponse?.newMessageCount, 1);
  assert.deepEqual(plan.localResponse?.heldMessages?.map((item) => item.seq), [51]);

  const consume = consumeEffect(plan.effects);
  assert.deepEqual(consume.messages.map((item) => item.seq), [51]);
  assert.equal(consume.boundarySeq, 51);

  const decision = recordedDecision(plan.effects);
  assert.equal(decision.decision, "syncing_hold");
  assert.equal(decision.inboxTrustState, "untrusted");
  assert.equal(decision.reason, "target_first_touch_recent_context");
  assert.equal(decision.pendingMaxSeq, 51);
  assert.equal(decision.modelSeenSeq, 0);
  assert.equal(decision.heldMessageCount, 1);
  assert.deepEqual(plan.trace, [
    {
      step: "input",
      data: {
        action: "send",
        target: "dm:@tygg",
        continueAnyway: false,
        pendingCount: 0,
        recentCount: 1,
      },
    },
    { step: "model_boundary_checked", data: { boundary: 0 } },
    { step: "recent_context_loaded", data: { recentCount: 1, unseenCount: 1 } },
    { step: "recent_boundary_resolved", data: { boundarySeq: 51 } },
    { step: "unseen_boundary_resolved", data: { boundarySeq: 51 } },
    {
      step: "unseen_hold_selected",
      data: {
        heldCount: 1,
        omittedCount: 0,
        consumeBoundarySeq: 51,
      },
    },
    {
      step: "plan_built",
      data: {
        outcome: "held",
        decision: "syncing_hold",
        effectCount: 2,
        localResponseState: "held",
        seenUpToSeq: 51,
      },
    },
  ]);
});

test("reviewer isolation first-touch syncing hold leaves recent context unconsumed", () => {
  const secretBody = "paired review work-in-progress";
  const plan = planAgentInboxSideEffect({
    agentId: "agent-1",
    action: "send",
    target: "#reviews:blind",
    continueAnyway: false,
    freshnessContextMode: "withheld",
    pendingMessages: [],
    recentMessages: [message(51, { sender_id: "human-1", content: secretBody })],
  });

  assert.equal(plan.outcome, "held");
  assert.deepEqual(plan.localResponse, {
    state: "held",
    freshnessContextMode: "withheld",
    withheldMessageCount: 1,
  });
  assert.equal(plan.effects.some((effect) => effect.type === "consume_visible_messages"), false);
  assert.doesNotMatch(JSON.stringify(plan.localResponse), new RegExp(secretBody));
});

test("agent inbox state machine forwards first-touch target after recent context is already model-seen", () => {
  const recentMessages = [
    message(61, { sender_id: "human-1" }),
    message(62, { sender_id: "human-1" }),
  ];

  const plan = planAgentInboxSideEffect({
    agentId: "agent-1",
    action: "send",
    target: "dm:@tygg",
    continueAnyway: false,
    pendingMessages: [],
    recentMessages,
    isMessageModelSeen: () => true,
  });

  assert.equal(plan.outcome, "forward");
  assert.equal(plan.forwardSeenUpToSeq, 62);
  const consume = consumeEffect(plan.effects);
  assert.deepEqual(consume.messages.map((item) => item.seq), [61, 62]);
  assert.equal(consume.boundarySeq, 62);
  assert.deepEqual(recordedDecision(plan.effects), {
    action: "send",
    decision: "forward",
    target: "dm:@tygg",
    inboxTrustState: "untrusted",
    reason: "target_first_touch_recent_context_already_seen",
    pendingCount: 0,
    pendingMaxSeq: 62,
    modelSeenSeq: 62,
    heldMessageCount: 0,
    omittedMessageCount: 0,
  });
  assert.deepEqual(plan.trace, [
    {
      step: "input",
      data: {
        action: "send",
        target: "dm:@tygg",
        continueAnyway: false,
        pendingCount: 0,
        recentCount: 2,
      },
    },
    { step: "model_boundary_checked", data: { boundary: 0 } },
    { step: "recent_context_loaded", data: { recentCount: 2, unseenCount: 0 } },
    { step: "recent_boundary_resolved", data: { boundarySeq: 62 } },
    { step: "recent_context_already_seen" },
    {
      step: "plan_built",
      data: {
        outcome: "forward",
        decision: "forward",
        effectCount: 2,
        forwardSeenUpToSeq: 62,
      },
    },
  ]);
});

test("agent inbox state machine trace captures continue-anyway bypass before pending context", () => {
  const plan = planAgentInboxSideEffect({
    agentId: "agent-1",
    action: "send",
    target: "dm:@tygg",
    continueAnyway: true,
    pendingMessages: [message(70, { sender_id: "human-1" })],
    recentMessages: [],
  });

  assert.equal(plan.outcome, "forward");
  assert.equal(recordedDecision(plan.effects).decision, "bypass");
  assert.deepEqual(plan.trace, [
    {
      step: "input",
      data: {
        action: "send",
        target: "dm:@tygg",
        continueAnyway: true,
        pendingCount: 1,
        recentCount: 0,
      },
    },
    { step: "continue_anyway_bypass" },
    {
      step: "plan_built",
      data: {
        outcome: "forward",
        decision: "bypass",
        effectCount: 1,
      },
    },
  ]);
});
