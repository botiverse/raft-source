import type { Tracer } from "@botiverse/raft-shared";
import { recordTraceEvent } from "./semanticTrace";
import { traceAgentIdHash, traceIdentityHash } from "./traceIdentity";

// Glimpse, input-side duplication (layer 1, "what the server offered"): one
// standalone event each time the server returns message bodies to an agent —
// a history read, the context a hold brings back, a delivery. Seqs only, never
// content or message ids. Overlapping [seq_min, seq_max] ranges for the same
// model context and conversation are a span the server offered again. It is an upper
// bound: CLI and SDK fold what the model already saw (glimpse) after this, so
// the reduction glimpse makes on reads shows only in the client render counts
// (layer 2). Message seqs are global, not per conversation, so a seq gap
// count would be meaningless; every return here is a contiguous window of its
// conversation (a delivery is one message).
//
// Launch and context come only from the daemon (`X-Agent-Launch-Id`,
// `X-Agent-Context-Id` on its agent API requests): it is the authority on
// both, and a context changes on compaction within one launch. A delivery
// carries neither: the server's cached expected launch is per instance and can
// be stale, so a delivery is placed in a launch from the daemon's own events.

export const AGENT_CONTEXT_RETURNED_EVENT = "server.agent_context.returned";

export type AgentContextReturnSource = "history" | "hold" | "attach" | "delivery";

const DAEMON_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

function daemonIdFromHeader(value: unknown): string | null {
  return typeof value === "string" && DAEMON_ID_PATTERN.test(value) ? value : null;
}

/** The launch and model context a daemon sends with an agent API request, each when well formed. */
export function agentRequestContextFromHeaders(headers: Record<string, unknown>): { launchId: string | null; contextId: string | null } {
  return {
    launchId: daemonIdFromHeader(headers["x-agent-launch-id"]),
    contextId: daemonIdFromHeader(headers["x-agent-context-id"]),
  };
}

export function recordAgentContextReturned(input: {
  source: AgentContextReturnSource;
  agentId: string;
  channelId: string;
  launchId?: string | null;
  contextId?: string | null;
  seqs: readonly unknown[];
}, fallbackTracer?: Tracer): void {
  const seqs = input.seqs
    .map((seq) => Number(seq))
    .filter((seq) => Number.isInteger(seq) && seq > 0);
  if (seqs.length === 0) return;
  const agentIdHash = traceAgentIdHash(input.agentId);
  const conversationIdHash = traceIdentityHash("conversation_id_hash", input.channelId);
  recordTraceEvent(AGENT_CONTEXT_RETURNED_EVENT, {
    source: input.source,
    seq_min: Math.min(...seqs),
    seq_max: Math.max(...seqs),
    seq_count: seqs.length,
    launch_id_present: Boolean(input.launchId),
    ...(input.launchId ? { launch_id: input.launchId } : {}),
    context_id_present: Boolean(input.contextId),
    ...(input.contextId ? { context_id: input.contextId } : {}),
    ...(agentIdHash ? { agent_id_hash: agentIdHash } : {}),
    ...(conversationIdHash ? { conversation_id_hash: conversationIdHash } : {}),
  }, fallbackTracer);
}
