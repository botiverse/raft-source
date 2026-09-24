import {
  buildApmFreshnessDecisionProducerFactId,
  projectApmHeldFreshnessEnvelope,
  type ApmFreshnessHeldDecision,
  type ApmHeldFreshnessEnvelopeBody,
} from "./apmStateMachine.js";

export type AgentInboxStateMachineAction = "send" | "task_claim" | "task_update";

export type AgentInboxStateMachineMessage = {
  seq?: number;
  id?: string;
  message_id?: string;
  sender_id?: string;
  senderId?: string;
  channel_type?: string;
  channel_name?: string;
  parent_channel_type?: string;
  parent_channel_name?: string;
  sender_type?: string;
  sender_name?: string;
  sender_description?: string | null;
  senderType?: string;
  senderName?: string;
  senderDescription?: string | null;
  content?: string;
  timestamp?: string;
  createdAt?: string;
};

export type AgentInboxFreshnessDecision = {
  action: AgentInboxStateMachineAction;
  decision: "local_hold" | "syncing_hold" | "forward" | "bypass";
  freshnessContextMode?: "inline" | "withheld";
  producerFactId?: string;
  target?: string;
  inboxTrustState: "trusted" | "untrusted";
  reason: string;
  pendingCount?: number;
  pendingMaxSeq?: number;
  modelSeenSeq?: number;
  heldMessageCount?: number;
  omittedMessageCount?: number;
};

type AgentInboxHeldFreshnessDecision = AgentInboxFreshnessDecision & {
  decision: ApmFreshnessHeldDecision;
};

export type AgentInboxConsumeSource =
  | "server_held_context"
  // `agent_api_events` remains split by call-site for trace/source clarity:
  // local daemon-inbox drains and server /events forwards are both sparse
  // event projections, so both are exact-id-only model-seen inputs.
  | "agent_api_events_local"
  | "agent_api_events_server"
  | "agent_api_history"
  | "agent_api_send_commit"
  | "side_effect_preflight_context";

export type AgentInboxStateMachineEffect =
  | {
    type: "record_freshness_decision";
    decision: AgentInboxFreshnessDecision;
  }
  | {
    type: "consume_visible_messages";
    target?: string;
    messages: AgentInboxStateMachineMessage[];
    boundarySeq?: number;
    source: AgentInboxConsumeSource;
  };

export type AgentInboxStateMachineTraceValue = string | number | boolean | null;

export type AgentInboxStateMachineTraceStep = {
  step: string;
  data?: Record<string, AgentInboxStateMachineTraceValue>;
};

export type AgentInboxSideEffectPlan = {
  outcome: "forward" | "held";
  target: string;
  effects: AgentInboxStateMachineEffect[];
  trace: AgentInboxStateMachineTraceStep[];
  forwardSeenUpToSeq?: number;
  localResponse?: ApmHeldFreshnessEnvelopeBody<AgentInboxStateMachineMessage>;
};

export type AgentInboxSideEffectPlanInput = {
  agentId: string;
  action: AgentInboxStateMachineAction;
  target: string;
  continueAnyway: boolean;
  freshnessContextMode?: "inline" | "withheld";
  existingSeenUpToSeq?: number;
  modelSeenSeq?: number;
  pendingMessages: AgentInboxStateMachineMessage[];
  recentMessages: AgentInboxStateMachineMessage[];
  isMessageModelSeen?: (input: { target: string; message: AgentInboxStateMachineMessage }) => boolean;
  heldContextLimit?: number;
};

type FreshnessBoundaryResult =
  | { ok: true; seenUpToSeq: number }
  | { ok: false; reason: "missing_seq_boundary" };

type HeldContext = {
  heldMessages: AgentInboxStateMachineMessage[];
  newMessageCount: number;
  shownMessageCount: number;
  omittedMessageCount: number;
  seenUpToSeq: number;
};

const DEFAULT_HELD_CONTEXT_LIMIT = 3;

export function planAgentInboxSideEffect(input: AgentInboxSideEffectPlanInput): AgentInboxSideEffectPlan {
  const heldContextLimit = input.heldContextLimit ?? DEFAULT_HELD_CONTEXT_LIMIT;
  const trace: AgentInboxStateMachineTraceStep[] = [
    {
      step: "input",
      data: compactTraceData({
        action: input.action,
        target: input.target,
        continueAnyway: input.continueAnyway,
        freshnessContextMode: input.freshnessContextMode,
        pendingCount: input.pendingMessages.length,
        recentCount: input.recentMessages.length,
        existingSeenUpToSeq: input.existingSeenUpToSeq,
        modelSeenSeq: input.modelSeenSeq,
      }),
    },
  ];
  if (input.continueAnyway) {
    appendTrace(trace, "continue_anyway_bypass");
    return forwardPlan(input, {
      action: input.action,
      decision: "bypass",
      target: input.target,
      inboxTrustState: "trusted",
      reason: "continue_anyway",
    }, trace);
  }

  if (input.pendingMessages.length > 0) {
    appendTrace(trace, "pending_messages_found", { pendingCount: input.pendingMessages.length });
    const pending = sortInboxMessagesBySeq(normalizeInboxVisibleMessages(input.pendingMessages, input.target));
    const boundary = resolveFreshnessBoundary(pending);
    if (!boundary.ok) {
      appendTrace(trace, "pending_context_missing_boundary");
      return forwardWithoutDecision(input, trace);
    }

    const alreadySeenPending: AgentInboxStateMachineMessage[] = [];
    const unconsumedMessages: AgentInboxStateMachineMessage[] = [];
    for (const message of pending) {
      if (isMessageModelSeen(input, message)) {
        alreadySeenPending.push(message);
      } else {
        unconsumedMessages.push(message);
      }
    }
    appendTrace(trace, "pending_context_classified", {
      pendingCount: pending.length,
      unseenCount: unconsumedMessages.length,
    });

    if (unconsumedMessages.length === 0) {
      const contiguousBoundary = maxKnownContiguousBoundary(input);
      const canAdvanceBoundary = typeof contiguousBoundary === "number" && contiguousBoundary >= boundary.seenUpToSeq;
      appendTrace(trace, "pending_context_already_seen", { boundarySeq: boundary.seenUpToSeq });
      return forwardPlan(input, {
        action: input.action,
        decision: "forward",
        target: input.target,
        inboxTrustState: "trusted",
        reason: "exact_target_pending_already_seen",
        pendingCount: pending.length,
        pendingMaxSeq: boundary.seenUpToSeq,
        modelSeenSeq: contiguousBoundary,
        heldMessageCount: 0,
        omittedMessageCount: 0,
      }, trace, {
        forwardSeenUpToSeq: input.action === "send" && canAdvanceBoundary ? boundary.seenUpToSeq : undefined,
        consumeEffect: {
          type: "consume_visible_messages",
          target: input.target,
          messages: exactSeenConsumeMessages(input, pending),
          boundarySeq: canAdvanceBoundary ? boundary.seenUpToSeq : undefined,
          source: "side_effect_preflight_context",
        },
      });
    }

    const heldBoundary = resolveFreshnessBoundary(unconsumedMessages);
    if (heldBoundary.ok) {
      const heldMessages = latestVisibleMessages(unconsumedMessages, heldContextLimit);
      const omittedMessageCount = Math.max(0, unconsumedMessages.length - heldMessages.length);
      const context: HeldContext = {
        heldMessages,
        newMessageCount: unconsumedMessages.length,
        shownMessageCount: heldMessages.length,
        omittedMessageCount,
        seenUpToSeq: heldBoundary.seenUpToSeq,
      };
      appendTrace(trace, "held_context_built", {
        boundarySeq: boundary.seenUpToSeq,
        heldBoundarySeq: heldBoundary.seenUpToSeq,
        heldCount: context.shownMessageCount,
        omittedCount: context.omittedMessageCount,
      });
      return heldPlan(input, {
        decision: {
          action: input.action,
          decision: "local_hold",
          target: input.target,
          inboxTrustState: "trusted",
          reason: "exact_target_pending",
          pendingCount: input.pendingMessages.length,
          pendingMaxSeq: heldBoundary.seenUpToSeq,
          modelSeenSeq: input.modelSeenSeq,
          heldMessageCount: context.shownMessageCount,
          omittedMessageCount: context.omittedMessageCount,
        },
        context,
        consumeMessages: sortInboxMessagesBySeq([
          ...exactSeenConsumeMessages(input, alreadySeenPending),
          ...context.heldMessages,
        ]),
        consumeBoundarySeq: heldBoundary.seenUpToSeq,
      }, trace);
    }
    appendTrace(trace, "pending_unseen_context_missing_boundary");
    return forwardWithoutDecision(input, trace);
  }

  const boundary = Math.max(input.existingSeenUpToSeq ?? 0, input.modelSeenSeq ?? 0);
  appendTrace(trace, "model_boundary_checked", { boundary });
  if (boundary > 0) {
    appendTrace(trace, "model_boundary_selected", { boundary });
    return forwardPlan(input, {
      action: input.action,
      decision: "forward",
      target: input.target,
      inboxTrustState: "trusted",
      reason: "model_seen_boundary",
      pendingCount: 0,
      modelSeenSeq: boundary,
    }, trace, { forwardSeenUpToSeq: input.action === "send" ? boundary : undefined });
  }

  if (input.recentMessages.length > 0) {
    return planFirstTouchRecentContext(input, heldContextLimit, trace);
  }

  appendTrace(trace, "no_context_available");
  return forwardPlan(input, {
    action: input.action,
    decision: "forward",
    target: input.target,
    inboxTrustState: "trusted",
    reason: "no_exact_target_pending_or_recent_context",
    pendingCount: 0,
    modelSeenSeq: 0,
  }, trace);
}

export function normalizeInboxVisibleMessage(
  message: AgentInboxStateMachineMessage,
  target?: string,
): AgentInboxStateMachineMessage {
  const targetFields = target ? parseTargetFields(target) : {};
  const normalized: AgentInboxStateMachineMessage = {
    ...targetFields,
    ...message,
    message_id: message.message_id ?? message.id,
    timestamp: message.timestamp ?? message.createdAt,
    sender_type: message.sender_type ?? message.senderType,
    sender_name: message.sender_name ?? message.senderName,
    sender_description: message.sender_description ?? message.senderDescription ?? null,
  };
  const senderId = messageSenderId(message);
  if (senderId) normalized.sender_id = senderId;
  return normalized;
}

export function normalizeInboxVisibleMessages(
  messages: AgentInboxStateMachineMessage[],
  target?: string,
): AgentInboxStateMachineMessage[] {
  return messages.map((message) => normalizeInboxVisibleMessage(message, target));
}

export function maxInboxMessageSeq(messages: AgentInboxStateMachineMessage[]): number | undefined {
  let maxSeq = 0;
  for (const message of messages) {
    const seq = Math.floor(messageSeq(message));
    if (Number.isFinite(seq) && seq > 0) maxSeq = Math.max(maxSeq, seq);
  }
  return maxSeq > 0 ? maxSeq : undefined;
}

function maxKnownContiguousBoundary(input: AgentInboxSideEffectPlanInput): number | undefined {
  const boundary = Math.max(input.existingSeenUpToSeq ?? 0, input.modelSeenSeq ?? 0);
  return boundary > 0 ? boundary : undefined;
}

function exactSeenConsumeMessages(
  input: AgentInboxSideEffectPlanInput,
  messages: AgentInboxStateMachineMessage[],
): AgentInboxStateMachineMessage[] {
  const boundary = maxKnownContiguousBoundary(input);
  return messages.map((message) => {
    const seq = Math.floor(messageSeq(message));
    if (Number.isFinite(seq) && seq > 0 && typeof boundary === "number" && boundary >= seq) {
      return message;
    }
    const id = typeof message.message_id === "string" && message.message_id.length > 0
      ? message.message_id
      : typeof message.id === "string" && message.id.length > 0
        ? message.id
        : undefined;
    return id
      ? { ...message, seq: undefined }
      : message;
  });
}

export function sortInboxMessagesBySeq(messages: AgentInboxStateMachineMessage[]): AgentInboxStateMachineMessage[] {
  return [...messages].sort((a, b) => messageSeq(a) - messageSeq(b));
}

function planFirstTouchRecentContext(
  input: AgentInboxSideEffectPlanInput,
  heldContextLimit: number,
  trace: AgentInboxStateMachineTraceStep[],
): AgentInboxSideEffectPlan {
  const recent = sortInboxMessagesBySeq(normalizeInboxVisibleMessages(input.recentMessages, input.target));
  const unconsumedMessages = recent.filter((message) => !isMessageModelSeen(input, message));
  appendTrace(trace, "recent_context_loaded", {
    recentCount: recent.length,
    unseenCount: unconsumedMessages.length,
  });
  const boundary = resolveFreshnessBoundary(recent);
  if (!boundary.ok) {
    appendTrace(trace, "recent_context_missing_boundary");
    return forwardPlan(input, {
      action: input.action,
      decision: "forward",
      target: input.target,
      inboxTrustState: "untrusted",
      reason: "target_first_touch_recent_context_without_seq_boundary",
      pendingCount: 0,
      modelSeenSeq: 0,
    }, trace);
  }
  appendTrace(trace, "recent_boundary_resolved", { boundarySeq: boundary.seenUpToSeq });
  if (unconsumedMessages.length === 0) {
    appendTrace(trace, "recent_context_already_seen");
    return forwardPlan(input, {
      action: input.action,
      decision: "forward",
      target: input.target,
      inboxTrustState: "untrusted",
      reason: "target_first_touch_recent_context_already_seen",
      pendingCount: 0,
      pendingMaxSeq: boundary.seenUpToSeq,
      modelSeenSeq: boundary.seenUpToSeq,
      heldMessageCount: 0,
      omittedMessageCount: 0,
    }, trace, {
      forwardSeenUpToSeq: input.action === "send" ? boundary.seenUpToSeq : undefined,
      consumeEffect: {
        type: "consume_visible_messages",
        target: input.target,
        messages: recent,
        boundarySeq: boundary.seenUpToSeq,
        source: "side_effect_preflight_context",
      },
    });
  }

  const heldBoundary = resolveFreshnessBoundary(unconsumedMessages);
  if (!heldBoundary.ok) {
    appendTrace(trace, "unseen_context_missing_boundary");
    return forwardPlan(input, {
      action: input.action,
      decision: "forward",
      target: input.target,
      inboxTrustState: "untrusted",
      reason: "target_first_touch_unseen_context_without_seq_boundary",
      pendingCount: 0,
      modelSeenSeq: 0,
    }, trace);
  }
  appendTrace(trace, "unseen_boundary_resolved", { boundarySeq: heldBoundary.seenUpToSeq });

  const heldMessages = latestVisibleMessages(unconsumedMessages, heldContextLimit);
  const omittedMessageCount = Math.max(0, unconsumedMessages.length - heldMessages.length);
  appendTrace(trace, "unseen_hold_selected", {
    heldCount: heldMessages.length,
    omittedCount: omittedMessageCount,
    consumeBoundarySeq: boundary.seenUpToSeq,
  });
  return heldPlan(input, {
    decision: {
      action: input.action,
      decision: "syncing_hold",
      target: input.target,
      inboxTrustState: "untrusted",
      reason: "target_first_touch_recent_context",
      pendingCount: 0,
      pendingMaxSeq: heldBoundary.seenUpToSeq,
      modelSeenSeq: 0,
      heldMessageCount: heldMessages.length,
      omittedMessageCount,
    },
    context: {
      heldMessages,
      newMessageCount: unconsumedMessages.length,
      shownMessageCount: heldMessages.length,
      omittedMessageCount,
      seenUpToSeq: boundary.seenUpToSeq,
    },
    consumeMessages: recent,
    consumeBoundarySeq: boundary.seenUpToSeq,
  }, trace);
}

function heldPlan(
  input: AgentInboxSideEffectPlanInput,
  held: {
    decision: AgentInboxHeldFreshnessDecision;
    context: HeldContext;
    consumeMessages: AgentInboxStateMachineMessage[];
    consumeBoundarySeq: number;
  },
  trace: AgentInboxStateMachineTraceStep[],
): AgentInboxSideEffectPlan {
  const withholdContext = input.freshnessContextMode === "withheld";
  const decisionInput: AgentInboxHeldFreshnessDecision = withholdContext
    ? { ...held.decision, freshnessContextMode: "withheld" }
    : held.decision;
  const producerFactId = buildApmFreshnessDecisionProducerFactId(input.agentId, decisionInput);
  const decision = { ...decisionInput, producerFactId };
  appendTrace(trace, "plan_built", {
    outcome: "held",
    decision: decision.decision,
    freshnessContextMode: input.freshnessContextMode,
    effectCount: withholdContext ? 1 : 2,
    localResponseState: "held",
    seenUpToSeq: withholdContext ? undefined : held.context.seenUpToSeq,
  });
  return {
    outcome: "held",
    target: input.target,
    effects: withholdContext
      ? [{ type: "record_freshness_decision", decision }]
      : [
          {
            type: "consume_visible_messages",
            target: input.target,
            messages: held.consumeMessages,
            boundarySeq: held.consumeBoundarySeq,
            source: "side_effect_preflight_context",
          },
          { type: "record_freshness_decision", decision },
        ],
    trace,
    localResponse: projectApmHeldFreshnessEnvelope({
      producerFactId,
      action: input.action,
      decision: held.decision.decision,
      heldMessages: held.context.heldMessages,
      newMessageCount: held.context.newMessageCount,
      omittedMessageCount: held.context.omittedMessageCount,
      seenUpToSeq: held.context.seenUpToSeq,
      freshnessContextMode: input.freshnessContextMode,
    }).body,
  };
}

function forwardPlan(
  input: AgentInboxSideEffectPlanInput,
  decision: AgentInboxFreshnessDecision,
  trace: AgentInboxStateMachineTraceStep[],
  options: {
    forwardSeenUpToSeq?: number;
    consumeEffect?: Extract<AgentInboxStateMachineEffect, { type: "consume_visible_messages" }>;
  } = {},
): AgentInboxSideEffectPlan {
  appendTrace(trace, "plan_built", {
    outcome: "forward",
    decision: decision.decision,
    effectCount: options.consumeEffect ? 2 : 1,
    forwardSeenUpToSeq: options.forwardSeenUpToSeq,
  });
  return {
    outcome: "forward",
    target: input.target,
    forwardSeenUpToSeq: options.forwardSeenUpToSeq,
    effects: [
      ...(options.consumeEffect ? [options.consumeEffect] : []),
      { type: "record_freshness_decision", decision },
    ],
    trace,
  };
}

function forwardWithoutDecision(
  input: AgentInboxSideEffectPlanInput,
  trace: AgentInboxStateMachineTraceStep[],
): AgentInboxSideEffectPlan {
  appendTrace(trace, "plan_built", {
    outcome: "forward",
    decision: "none",
    effectCount: 0,
  });
  return {
    outcome: "forward",
    target: input.target,
    effects: [],
    trace,
  };
}

function resolveFreshnessBoundary(messages: AgentInboxStateMachineMessage[]): FreshnessBoundaryResult {
  const seenUpToSeq = maxInboxMessageSeq(messages);
  return typeof seenUpToSeq === "number"
    ? { ok: true, seenUpToSeq }
    : { ok: false, reason: "missing_seq_boundary" };
}

function latestVisibleMessages(
  messages: AgentInboxStateMachineMessage[],
  limit: number,
): AgentInboxStateMachineMessage[] {
  const sorted = sortInboxMessagesBySeq(messages);
  return sorted.slice(Math.max(0, sorted.length - limit));
}

function isMessageModelSeen(
  input: AgentInboxSideEffectPlanInput,
  message: AgentInboxStateMachineMessage,
): boolean {
  if (messageSenderId(message) === input.agentId) return true;
  const seq = Math.floor(messageSeq(message));
  if (Number.isFinite(seq) && seq > 0 && typeof input.modelSeenSeq === "number" && input.modelSeenSeq >= seq) return true;
  return input.isMessageModelSeen?.({ target: input.target, message }) === true;
}

function messageSeq(message: AgentInboxStateMachineMessage): number {
  return Number(message.seq ?? 0);
}

function messageSenderId(message: AgentInboxStateMachineMessage): string | undefined {
  if (typeof message.sender_id === "string" && message.sender_id.length > 0) return message.sender_id;
  if (typeof message.senderId === "string" && message.senderId.length > 0) return message.senderId;
  return undefined;
}

function appendTrace(
  trace: AgentInboxStateMachineTraceStep[],
  step: string,
  data?: Record<string, AgentInboxStateMachineTraceValue | undefined>,
): void {
  const compacted = compactTraceData(data);
  trace.push(Object.keys(compacted).length > 0 ? { step, data: compacted } : { step });
}

function compactTraceData(
  data: Record<string, AgentInboxStateMachineTraceValue | undefined> | undefined,
): Record<string, AgentInboxStateMachineTraceValue> {
  const compacted: Record<string, AgentInboxStateMachineTraceValue> = {};
  if (!data) return compacted;
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) compacted[key] = value;
  }
  return compacted;
}

function parseTargetFields(target: string): Partial<AgentInboxStateMachineMessage> {
  if (target.startsWith("dm:@")) {
    const rest = target.slice("dm:@".length);
    const [peer, threadId] = rest.split(":", 2);
    if (threadId) {
      return {
        channel_type: "thread",
        channel_name: threadId,
        parent_channel_type: "dm",
        parent_channel_name: peer,
      };
    }
    return { channel_type: "dm", channel_name: peer };
  }
  if (target.startsWith("#")) {
    const rest = target.slice(1);
    const [channel, threadId] = rest.split(":", 2);
    if (threadId) {
      return {
        channel_type: "thread",
        channel_name: threadId,
        parent_channel_type: "channel",
        parent_channel_name: channel,
      };
    }
    return { channel_type: "channel", channel_name: channel };
  }
  return {};
}
