import {
  type AgentProxyFreshnessDecision,
  type AgentProxyInboxCoordinator,
  type AgentProxyVisibleMessage,
} from "./agentCredentialProxy";
import { inboxProjectionTraceAttrs } from "./agentRuntimeInput";
import {
  buildApmFreshnessDecisionProducerFactId,
  projectApmFreshnessDecisionTrace,
} from "./apmStateMachine";
import { daemonProxyFailureTraceAttrs, daemonTransportErrorExcerpt } from "./proxyFailureTrace";

type TraceRecorder = (
  name: string,
  attrs: Record<string, unknown>,
  status?: "ok" | "error",
) => void;

export function buildAgentProxyInboxCoordinator(input: {
  agentId: string;
  serverUrl: string;
  daemonApiKey: string;
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  getBoundary: AgentProxyInboxCoordinator["getBoundary"];
  getPendingMessages: AgentProxyInboxCoordinator["getPendingMessages"];
  isMessageModelSeen: NonNullable<AgentProxyInboxCoordinator["isMessageModelSeen"]>;
  getExactSeenSeqs?: AgentProxyInboxCoordinator["getExactSeenSeqs"];
  getContextId?: AgentProxyInboxCoordinator["getContextId"];
  getAllPendingMessages: NonNullable<AgentProxyInboxCoordinator["getAllPendingMessages"]>;
  consumeVisibleMessages: AgentProxyInboxCoordinator["consumeVisibleMessages"];
  recordHeldWriteSpan?: AgentProxyInboxCoordinator["recordHeldWriteSpan"];
  getHeldWriteSpan?: AgentProxyInboxCoordinator["getHeldWriteSpan"];
  getThreadTargetOfMessage?: AgentProxyInboxCoordinator["getThreadTargetOfMessage"];
  recordTrace: TraceRecorder;
  recordFreshnessDecisionActivity: (decision: AgentProxyFreshnessDecision, producerFactId: string) => void;
  recordSendOutcome?: AgentProxyInboxCoordinator["recordSendOutcome"];
  recordMessageCommitted?: AgentProxyInboxCoordinator["recordMessageCommitted"];
}): AgentProxyInboxCoordinator {
  return {
    getBoundary: input.getBoundary,
    getPendingMessages: input.getPendingMessages,
    isMessageModelSeen: input.isMessageModelSeen,
    getExactSeenSeqs: input.getExactSeenSeqs,
    getContextId: input.getContextId,
    getAllPendingMessages: input.getAllPendingMessages,
    consumeVisibleMessages: input.consumeVisibleMessages,
    ...(input.recordHeldWriteSpan ? { recordHeldWriteSpan: input.recordHeldWriteSpan } : {}),
    ...(input.getHeldWriteSpan ? { getHeldWriteSpan: input.getHeldWriteSpan } : {}),
    ...(input.getThreadTargetOfMessage ? { getThreadTargetOfMessage: input.getThreadTargetOfMessage } : {}),
    recordInboxSnapshot: (projection) => input.recordTrace("daemon.agent.inbox_projection.snapshot", {
      agentId: input.agentId,
      source: projection.source,
      ...inboxProjectionTraceAttrs(projection.rows, projection.pendingMessageCount),
    }),
    recordDrainOutcome: (outcome) => input.recordTrace("daemon.agent.drain.outcome", {
      agentId: input.agentId,
      source: outcome.source,
      since_cursor_kind: outcome.sinceCursorKind ?? undefined,
      notified_count: outcome.notifiedCount,
      drained_count: outcome.drainedCount,
      has_more: outcome.hasMore,
    }),
    recordProxyFailure: (failure) => input.recordTrace("daemon.proxy.failed", {
      agentId: input.agentId,
      ...daemonProxyFailureTraceAttrs(failure),
    }, "error"),
    recordTransportNormalizedError: (error) => input.recordTrace("daemon.transport.normalized_error", {
      producer: "daemon",
      agentId: input.agentId,
      normalized_code: error.normalizedCode,
      route_family: error.routeFamily,
      failure_class: error.failureClass,
      response_started: error.responseStarted,
      response_complete: error.responseComplete,
      cause_code: error.causeCode,
      upstream_layer: error.upstreamLayer,
      ...(typeof error.upstreamStatus === "number" ? { upstream_status: error.upstreamStatus } : {}),
      error_excerpt: daemonTransportErrorExcerpt(error),
      launchId: error.launchId,
      target_host_class: error.targetHostClass,
      downstream_caller: error.downstreamCaller,
      upstream: error.upstream,
    }, "error"),
    recordFreshnessDecision: (decision) => {
      const producerFactId = decision.producerFactId
        ?? buildApmFreshnessDecisionProducerFactId(input.agentId, decision);
      const trace = projectApmFreshnessDecisionTrace({ producerFactId, decision });
      input.recordTrace("daemon.agent.inbox.freshness_decision", {
        agentId: input.agentId,
        ...trace.attrs,
      });
      input.recordFreshnessDecisionActivity(decision, producerFactId);
      // A send the daemon held itself never reaches the Server, so no response reports it.
      if (decision.action === "send" && (decision.decision === "local_hold" || decision.decision === "syncing_hold")) {
        input.recordSendOutcome?.({ state: "held" });
      }
    },
    ...(input.recordSendOutcome ? { recordSendOutcome: input.recordSendOutcome } : {}),
    ...(input.recordMessageCommitted ? { recordMessageCommitted: input.recordMessageCommitted } : {}),
  };
}
