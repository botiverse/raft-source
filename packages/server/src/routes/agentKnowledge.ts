import type { Request, Response } from "express";
import {
  currentTimeMs,
  hasManualContextCapability,
  MANUAL_CONTEXT_CAPABILITY,
  RAFT_CLIENT_CAPABILITIES_HEADER,
  type KnowledgeContextField,
} from "@botiverse/raft-shared";
import {
  agentBelongsToServer,
  buildAgentKnowledgeIndexCommand,
  buildAgentKnowledgeNotFoundGuidanceWithCandidates,
  normalizeKnowledgeSearchScope,
  normalizeKnowledgeTopic,
  normalizeOptionalKnowledgeField,
  recordAgentKnowledgeEvent,
  resolveAgentKnowledgeDocWithDiscovery,
  manualQueryNeedsEnglish,
  searchAgentKnowledgeDocsWithResolution,
  validateKnowledgeIntent,
  validateKnowledgeReason,
  type AgentKnowledgeDoc,
  type AgentKnowledgeSearchResult,
  type AgentKnowledgeSource,
} from "../services/agentKnowledgeService.js";

export interface AgentKnowledgeActor {
  agentId: string;
  serverId: string;
  computerId?: string | null;
}

export async function handleAgentKnowledgeGet(
  req: Request,
  res: Response,
  actor: AgentKnowledgeActor,
): Promise<void> {
  const startedAt = Date.now();
  const source = resolveKnowledgeSource(req);
  if (!source) {
    res.status(400).json({
      ok: false,
      code: "knowledge_source_invalid",
      error: "Knowledge requests must come from an implemented source",
    });
    return;
  }

  const topic = normalizeKnowledgeTopic(req.query.topic);
  if (!topic) {
    res.status(400).json({
      ok: false,
      code: "knowledge_topic_invalid",
      error: "topic query parameter is required",
    });
    return;
  }

  const contextContractVersion = resolveKnowledgeContextContractVersion(req);
  const intent = resolveKnowledgeContext(
    req.query.intent,
    "intent",
    contextContractVersion !== null,
  );
  if (!intent.ok) {
    res.status(400).json({
      ok: false,
      code: "knowledge_intent_invalid",
      error: intent.error ?? "intent is invalid",
    });
    return;
  }

  const reason = resolveKnowledgeContext(
    req.query.reason,
    "reason",
    contextContractVersion !== null,
  );
  if (!reason.ok) {
    res.status(400).json({
      ok: false,
      code: "knowledge_reason_invalid",
      error: reason.error ?? "reason is invalid",
    });
    return;
  }

  const turnId = resolveCorrelationField(req.query.turn_id, req.header("X-Slock-Turn-Id"));
  if (!turnId.ok) {
    res.status(400).json({
      ok: false,
      code: "knowledge_turn_id_invalid",
      error: turnId.error,
    });
    return;
  }

  const traceId = resolveCorrelationField(req.query.trace_id, req.header("X-Slock-Trace-Id"));
  if (!traceId.ok) {
    res.status(400).json({
      ok: false,
      code: "knowledge_trace_id_invalid",
      error: traceId.error,
    });
    return;
  }

  try {
    const belongs = await agentBelongsToServer(actor.agentId, actor.serverId);
    if (!belongs) {
      res.status(401).json({ ok: false, code: "knowledge_agent_missing", error: "Agent no longer exists" });
      return;
    }

    const resolved = await resolveAgentKnowledgeDocWithDiscovery(topic);
    if (!resolved) {
      const guidance = await buildAgentKnowledgeNotFoundGuidanceWithCandidates(
        topic,
        contextContractVersion !== null,
      );
      await recordAgentKnowledgeEvent({
        serverId: actor.serverId,
        agentId: actor.agentId,
        computerId: actor.computerId ?? null,
        topicOrPath: topic,
        source,
        status: "not_found",
        operation: "get",
        latencyMs: Date.now() - startedAt,
        turnId: turnId.value,
        traceId: traceId.value,
        intent: intent.value,
        reason: reason.value,
        contextContractVersion,
      });
      res.status(404).json({
        ok: false,
        code: "knowledge_not_found",
        error: guidance.error,
        indexTopic: guidance.indexTopic,
        suggestedTopicIds: guidance.suggestedTopicIds,
        suggested_next_action: guidance.suggestedNextAction,
        candidates: guidance.candidates,
      });
      return;
    }

    const doc = resolved.doc;
    const responseBytes = Buffer.byteLength(doc.content, "utf8");
    await recordAgentKnowledgeEvent({
      serverId: actor.serverId,
      agentId: actor.agentId,
      computerId: actor.computerId ?? null,
      docId: doc.docId,
      topicOrPath: topic,
      docVersion: doc.docVersion,
      docState: doc.docState,
      source,
      status: "success",
      operation: "get",
      resolution: resolved.resolution,
      latencyMs: Date.now() - startedAt,
      responseBytes,
      turnId: turnId.value,
      traceId: traceId.value,
      intent: intent.value,
      reason: reason.value,
      contextContractVersion,
    });

    res.status(200).json(serializeKnowledgeDoc(doc));
  } catch (err) {
    console.error("agent.knowledge.get error:", err);
    try {
      await recordAgentKnowledgeEvent({
        serverId: actor.serverId,
        agentId: actor.agentId,
        computerId: actor.computerId ?? null,
        topicOrPath: topic,
        source,
        status: "error",
        operation: "get",
        latencyMs: Date.now() - startedAt,
        turnId: turnId.value,
        traceId: traceId.value,
        intent: intent.value,
        reason: reason.value,
        contextContractVersion,
      });
    } catch (eventErr) {
      console.error("agent.knowledge.get event write failed:", eventErr);
    }
    res.status(500).json({
      ok: false,
      code: "knowledge_internal_error",
      error: "Failed to load manual topic",
    });
  }
}

export async function handleAgentKnowledgeSearch(
  req: Request,
  res: Response,
  actor: AgentKnowledgeActor,
): Promise<void> {
  const startedAt = Date.now();
  const source = resolveKnowledgeSource(req);
  if (!source) {
    res.status(400).json({
      ok: false,
      code: "knowledge_source_invalid",
      error: "Knowledge requests must come from an implemented source",
    });
    return;
  }

  const query = normalizeKnowledgeTopic(req.query.query);
  if (!query) {
    res.status(400).json({
      ok: false,
      code: "knowledge_query_invalid",
      error: "query parameter is required",
    });
    return;
  }

  const scope = normalizeKnowledgeSearchScope(req.query.scope);
  if (scope === undefined) {
    res.status(400).json({
      ok: false,
      code: "knowledge_scope_invalid",
      error: "scope must be omitted or set to recipes",
    });
    return;
  }

  const contextContractVersion = resolveKnowledgeContextContractVersion(req);
  const intent = resolveKnowledgeContext(
    req.query.intent,
    "intent",
    contextContractVersion !== null,
  );
  if (!intent.ok) {
    res.status(400).json({
      ok: false,
      code: "knowledge_intent_invalid",
      error: intent.error ?? "intent is invalid",
    });
    return;
  }

  const reason = resolveKnowledgeContext(
    req.query.reason,
    "reason",
    contextContractVersion !== null,
  );
  if (!reason.ok) {
    res.status(400).json({
      ok: false,
      code: "knowledge_reason_invalid",
      error: reason.error ?? "reason is invalid",
    });
    return;
  }

  const turnId = resolveCorrelationField(req.query.turn_id, req.header("X-Slock-Turn-Id"));
  if (!turnId.ok) {
    res.status(400).json({
      ok: false,
      code: "knowledge_turn_id_invalid",
      error: turnId.error,
    });
    return;
  }

  const traceId = resolveCorrelationField(req.query.trace_id, req.header("X-Slock-Trace-Id"));
  if (!traceId.ok) {
    res.status(400).json({
      ok: false,
      code: "knowledge_trace_id_invalid",
      error: traceId.error,
    });
    return;
  }

  try {
    const belongs = await agentBelongsToServer(actor.agentId, actor.serverId);
    if (!belongs) {
      res.status(401).json({ ok: false, code: "knowledge_agent_missing", error: "Agent no longer exists" });
      return;
    }

    if (manualQueryNeedsEnglish(query)) {
      await recordAgentKnowledgeEvent({
        serverId: actor.serverId,
        agentId: actor.agentId,
        computerId: actor.computerId ?? null,
        topicOrPath: query,
        source,
        status: "not_found",
        operation: "search",
        // This is a deliberate language-policy rejection, not an ordinary
        // retrieval miss; keep status stable while preserving the distinction.
        resolution: "language_gate",
        // Injected clock seam keeps latency deterministic in tests.
        latencyMs: currentTimeMs() - startedAt,
        turnId: turnId.value,
        traceId: traceId.value,
        intent: intent.value,
        reason: reason.value,
        contextContractVersion,
      });
      const contextRequired = contextContractVersion !== null;
      const retryContext = contextRequired ? ", keeping your --intent/--reason" : "";
      res.status(404).json({
        ok: false,
        code: "knowledge_language_unsupported",
        error: "The Manual is written in English and is not translated. Search in English.",
        suggested_next_action: `Retry the same question using English keywords${retryContext}. To browse all topics, run:\n${buildAgentKnowledgeIndexCommand(contextRequired)}`,
      });
      return;
    }

    const searchOutcome = await searchAgentKnowledgeDocsWithResolution(query, scope);
    const { results } = searchOutcome;
    const responseBytes = Buffer.byteLength(JSON.stringify({ query, scope, results }), "utf8");
    if (results.length === 0) {
      await recordAgentKnowledgeEvent({
        serverId: actor.serverId,
        agentId: actor.agentId,
        computerId: actor.computerId ?? null,
        topicOrPath: query,
        source,
        status: "not_found",
        operation: "search",
        latencyMs: Date.now() - startedAt,
        turnId: turnId.value,
        traceId: traceId.value,
        intent: intent.value,
        reason: reason.value,
        contextContractVersion,
      });
      const scopeHint = scope ? ` in ${scope}` : "";
      const contextRequired = contextContractVersion !== null;
      const indexCommand = buildAgentKnowledgeIndexCommand(contextRequired);
      const retryContext = contextRequired ? ", keeping your --intent/--reason" : "";
      res.status(404).json({
        ok: false,
        code: "knowledge_not_found",
        error: `Manual search found no matching topics${scopeHint}. Retry with different keywords${retryContext}.`,
        suggested_next_action: `Retry with different keywords${retryContext}. To browse all topics, run:\n${indexCommand}`,
      });
      return;
    }

    await recordAgentKnowledgeEvent({
      serverId: actor.serverId,
      agentId: actor.agentId,
      computerId: actor.computerId ?? null,
      docId: results[0]?.slug ?? null,
      topicOrPath: query,
      docVersion: results[0]?.docVersion ?? null,
      docState: results[0]?.docState ?? null,
      source,
      status: "success",
      operation: "search",
      resolution: searchOutcome.resolution,
      latencyMs: Date.now() - startedAt,
      responseBytes,
      turnId: turnId.value,
      traceId: traceId.value,
      intent: intent.value,
      reason: reason.value,
      contextContractVersion,
    });

    res.status(200).json(serializeKnowledgeSearch(query, scope, results));
  } catch (err) {
    console.error("agent.knowledge.search error:", err);
    try {
      await recordAgentKnowledgeEvent({
        serverId: actor.serverId,
        agentId: actor.agentId,
        computerId: actor.computerId ?? null,
        topicOrPath: query,
        source,
        status: "error",
        operation: "search",
        latencyMs: Date.now() - startedAt,
        turnId: turnId.value,
        traceId: traceId.value,
        intent: intent.value,
        reason: reason.value,
        contextContractVersion,
      });
    } catch (eventErr) {
      console.error("agent.knowledge.search event write failed:", eventErr);
    }
    res.status(500).json({
      ok: false,
      code: "knowledge_internal_error",
      error: "Failed to search manual topics",
    });
  }
}

function serializeKnowledgeDoc(doc: AgentKnowledgeDoc) {
  return {
    ok: true,
    docId: doc.docId,
    topicOrPath: doc.topicOrPath,
    docVersion: doc.docVersion,
    docState: doc.docState,
    contentType: doc.contentType,
    content: doc.content,
  };
}

/**
 * Exported for the delivery-surface test: the agent-facing payload shape is a
 * contract, and asserting it only at the service boundary once let the match
 * reasons be computed and then silently dropped here.
 */
export function serializeKnowledgeSearch(query: string, scope: string | null, results: AgentKnowledgeSearchResult[]) {
  return {
    ok: true,
    query,
    scope,
    // Match reasons are part of the agent-facing contract, not internal
    // scoring detail: an agent decides whether to open a result from these.
    // Additive fields — older carriers ignore what they do not model.
    results: results.map(({ slug, title, firstScreen, matchedTerms, correctedTerms }) => ({
      slug,
      title,
      firstScreen,
      matchedTerms,
      correctedTerms,
    })),
  };
}

function resolveKnowledgeSource(req: Request): AgentKnowledgeSource | null {
  // Dual-read is permanent: senders switched from X-Slock-Client to
  // X-Raft-Client in the slock→raft rename, but already-deployed CLI/daemon
  // builds keep sending the legacy header indefinitely.
  const client = req.header("X-Raft-Client") ?? req.header("X-Slock-Client");
  return client === "cli" ? "cli" : null;
}

function resolveKnowledgeContextContractVersion(req: Request): string | null {
  return hasManualContextCapability(req.header(RAFT_CLIENT_CAPABILITIES_HEADER))
    ? MANUAL_CONTEXT_CAPABILITY
    : null;
}

function resolveKnowledgeContext(
  raw: unknown,
  field: KnowledgeContextField,
  required: boolean,
): { ok: true; value: string | null } | { ok: false; value: null; error: string } {
  const missing = raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "");
  if (!required && missing) return { ok: true, value: null };
  return field === "intent" ? validateKnowledgeIntent(raw) : validateKnowledgeReason(raw);
}

function resolveCorrelationField(
  queryValue: unknown,
  headerValue: string | undefined,
): { ok: true; value: string | null } | { ok: false; error: string } {
  const fromQuery = normalizeOptionalKnowledgeField(queryValue);
  const fromHeader = normalizeOptionalKnowledgeField(headerValue);
  if (fromQuery && fromHeader && fromQuery !== fromHeader) {
    return { ok: false, error: "query parameter and header value disagree" };
  }
  return { ok: true, value: fromHeader ?? fromQuery };
}
