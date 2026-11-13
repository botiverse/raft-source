// #wg-ax:#15: an agent searching or reading one message's View Context
// (`raft context search` / `raft context read`). An agent reads its own
// context with no grant; another agent's only through a View Context grant a
// server owner or admin gave it (agentContextViewGrantService.ts), checked
// here on every call and again when the result arrives.
//
// The order is Warden's: every check that decides whether the caller may see
// anything runs first, and every way of failing them gives the same 404 with
// the same sentence, so nothing tells the causes apart. Only then the rate
// limit, and only then what can go wrong with the Computer.

import type { Request, Response } from "express";
import {
  AGENT_CONTEXT_VIEW_FEATURE_FLAG_KEY,
  type AgentContextQuery,
  type AgentContextViewFailureReason,
} from "@botiverse/raft-shared";
import { asMachineId } from "@botiverse/raft-shared";
import { refuse } from "../lib/refusal";
import type { AgentOrchestrator } from "./agentOrchestrator";
import type { AgentContextQueryResult, AgentContextViewRelay } from "./agentContextViewRelay";
import { findUsableAgentContextViewGrant } from "./agentContextViewGrantService";
import { getAgent } from "./agentService";
import { evaluateFeatureFlag } from "./featureFlagService";
import * as messageService from "./messageService";

/**
 * Searches and reads per viewing agent, per replica: each replica counts on
 * its own, so the real ceiling is this times the replicas. Refusals don't
 * name a number for that reason.
 */
export const AGENT_CONTEXT_QUERY_RATE_LIMIT = 20;
export const AGENT_CONTEXT_QUERY_RATE_WINDOW_MS = 60_000;

/** The one refusal for everything an agent may not see; fixed, whatever the cause (Warden). */
export function agentContextNotViewableSentence(messageId: string): string {
  return `No context you can view for message ${messageId}: it doesn't exist, wasn't sent by an agent on this server, `
    + "View Context isn't on for this server, it is a personal assistant's context, or viewing that agent needs a grant you don't have.";
}

const NOT_VIEWABLE_NEXT = "To view your own context, use a message you sent. To view another agent's, ask a server owner or admin for a View Context grant.";

function refuseNotViewable(res: Response, messageId: string): void {
  refuse(res, 404, { code: "context_not_viewable", error: agentContextNotViewableSentence(messageId), suggestedNextAction: NOT_VIEWABLE_NEXT });
}

/** In-memory sliding window per agent; a replica restart forgets it, which only ever allows more. */
export class AgentContextQueryRateLimiter {
  private readonly calls = new Map<string, number[]>();

  constructor(
    private readonly limit = AGENT_CONTEXT_QUERY_RATE_LIMIT,
    private readonly windowMs = AGENT_CONTEXT_QUERY_RATE_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds until another call is allowed, or 0 when this one is (and counts it). */
  take(agentId: string): number {
    const now = this.now();
    const recent = (this.calls.get(agentId) ?? []).filter((at) => now - at < this.windowMs);
    if (recent.length >= this.limit) {
      this.calls.set(agentId, recent);
      return Math.max(1, Math.ceil((recent[0]! + this.windowMs - now) / 1000));
    }
    recent.push(now);
    this.calls.set(agentId, recent);
    if (this.calls.size > 10_000) {
      for (const [id, times] of this.calls) if (times.every((at) => now - at >= this.windowMs)) this.calls.delete(id);
    }
    return 0;
  }
}

const FAILURE_SENTENCES: Partial<Record<AgentContextViewFailureReason, { status: 404 | 409 | 410 | 413 | 422; error: string; next?: string }>> = {
  not_found: { status: 404, error: "This message's context isn't kept: only messages sent after View Context was turned on, within the last 30 days, can be viewed." },
  not_recorded: { status: 404, error: "This runtime's requests weren't recorded for that message, so there's nothing to view." },
  unsupported_runtime: { status: 422, error: "View Context doesn't support this agent's runtime yet." },
  no_computer: { status: 409, error: "This agent has no Computer, so its context can't be read." },
  offline: { status: 409, error: "The agent's Computer is offline, so its context can't be read right now.", next: "Check it with `raft user info @<agent>`, then try again." },
  old_daemon: { status: 409, error: "The agent's Computer is too old to answer a context search: it needs Computer 1.0.66 or newer.", next: "The Computer's owner upgrades it." },
  agent_moved: { status: 409, error: "The agent moved to another Computer while this was being read.", next: "Try again." },
  expired: { status: 410, error: "The agent's Computer didn't answer in time.", next: "Try again." },
};

function tooLargeSentence(cause: string | undefined): string {
  if (cause === "session_file") return "This agent's session is too long to restore here, so its context can't be searched.";
  if (cause === "restore_limit") return "Restoring this context ran past its memory or record limit, so it can't be searched.";
  return "The answer is too large to return.";
}

function answerFailure(res: Response, result: Extract<AgentContextQueryResult, { kind: "failure" }>): void {
  if (result.reason === "too_large") {
    refuse(res, 413, {
      code: "context_too_large",
      error: tooLargeSentence(result.tooLargeCause),
      ...(result.tooLargeCause === "request" ? { suggestedNextAction: "Ask for fewer entries with `--limit`, or read a later `--page`." } : {}),
    });
    return;
  }
  const known = FAILURE_SENTENCES[result.reason];
  if (known) {
    refuse(res, known.status, { code: `context_${result.reason}`, error: known.error, ...(known.next ? { suggestedNextAction: known.next } : {}) });
    return;
  }
  refuse(res, 422, { code: "context_read_failed", error: "The agent's Computer couldn't read this context.", suggestedNextAction: "Try again; if it keeps failing, view it on the web." });
}

/**
 * POST /internal/agent-api/context/search and /context/read. The body has
 * passed the contract's schema; `query` is what the daemon is asked.
 */
export async function handleAgentContextQuery(
  req: Request,
  res: Response,
  input: { agentId: string; serverId: string; messageId: string; query: AgentContextQuery; limiter: AgentContextQueryRateLimiter },
): Promise<void> {
  const { agentId, serverId, messageId, query, limiter } = input;
  // 1. Everything that decides whether the caller may see anything: one 404.
  const flag = await evaluateFeatureFlag({ key: AGENT_CONTEXT_VIEW_FEATURE_FLAG_KEY, serverId });
  if (!flag.enabled) return refuseNotViewable(res, messageId);
  const resolved = await messageService.resolveMessageIdVisibleToAgent(serverId, agentId, messageId);
  if (!resolved.ok) return refuseNotViewable(res, messageId);
  const message = resolved.message;
  // The target is the message's sender, an agent of this server (not deleted).
  if (message.senderType !== "agent") return refuseNotViewable(res, messageId);
  const agent = await getAgent(message.senderId);
  if (!agent || agent.serverId !== serverId) return refuseNotViewable(res, messageId);
  // Its own context needs no grant. Another agent's needs a usable grant: the
  // caller an ordinary agent of this server holding an unrevoked grant, the
  // target not a personal assistant, the granter's account live and
  // canViewAgentContext(granter, target) true now.
  const grant = agent.id === agentId
    ? null
    : await findUsableAgentContextViewGrant({ serverId, viewerAgentId: agentId, target: agent });
  if (agent.id !== agentId && !grant) return refuseNotViewable(res, messageId);

  // 2. Only once the caller may see it: the rate limit (so a 429 never tells a refusal apart).
  const retryAfterSeconds = limiter.take(agentId);
  if (retryAfterSeconds > 0) {
    refuse(res, 429, {
      code: "RATE_LIMITED",
      error: `Too many context searches. Try again in ${retryAfterSeconds} seconds.`,
      retryAfterSeconds,
      details: { operation: "context_query", limit: AGENT_CONTEXT_QUERY_RATE_LIMIT, windowSeconds: AGENT_CONTEXT_QUERY_RATE_WINDOW_MS / 1000, retryAfterSeconds },
    });
    return;
  }

  // 3. The Computer.
  const relay = req.app.get("agentContextViewRelay") as AgentContextViewRelay;
  const result = await relay.openQuery({
    viewerAgentId: agentId,
    agent: { id: agent.id, serverId: agent.serverId, runtime: agent.runtime, machineId: agent.machineId ? asMachineId(agent.machineId) : null },
    messageId: message.id,
    query,
    grant,
    orchestrator: req.app.get("agentOrchestrator") as AgentOrchestrator,
  });
  if (result.kind === "refused") return refuseNotViewable(res, messageId);
  if (result.kind === "failure") return answerFailure(res, result);
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(result.body);
}
