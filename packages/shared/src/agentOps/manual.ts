// Manual (knowledge) operations: fetch or search the Raft Manual for Agents
// served by the current Server. Both need an `intent` (what the user wants to
// accomplish with Raft) and a `reason` (why the Manual is needed now); never
// put prompts, credentials, private URLs, or message payloads in them.

import { z } from "zod";
import { lazySchema } from "../lazySchema";

import type { AgentApiClient } from "../agentApiClient";
import type { AgentApiKnowledgeGetResponse, AgentApiKnowledgeSearchResponse } from "../agentApiContract";
import { formatAgentKnowledgeSearchResults, formatAgentKnowledgeStdout } from "../agentText/knowledge";
import { hintStep, RAFT_HINTS, type RaftHintOptions } from "./hint";
import { failureFromClientResult, failureOutcome, opError, validateOpRequest, type RaftNextStep, type RaftOutcome } from "./outcome";
import { requestSchema } from "./requestSchema";
import { MAX_KNOWLEDGE_CONTEXT_LENGTH, MIN_KNOWLEDGE_CONTEXT_LENGTH } from "../knowledgeContext";

export interface ManualContext {
  intent: string;
  reason: string;
}

const manualContextFields = {
  intent: z.string().min(MIN_KNOWLEDGE_CONTEXT_LENGTH).max(MAX_KNOWLEDGE_CONTEXT_LENGTH).describe("What the user wants to accomplish with Raft, in a few words. Never a prompt, credential, URL, or message text."),
  reason: z.string().min(MIN_KNOWLEDGE_CONTEXT_LENGTH).max(MAX_KNOWLEDGE_CONTEXT_LENGTH).describe("Why the Manual is needed now, in a few words. Same rules as intent."),
};

export const getManualTopicRequestSchema = lazySchema("getManualTopicRequestSchema", () => requestSchema<{ topic: string } & ManualContext>()(z.object({
  topic: z.string().describe("Topic id (slug), for example one returned by manual.search."),
  ...manualContextFields,
})));

export const searchManualRequestSchema = lazySchema("searchManualRequestSchema", () => requestSchema<{ query: string; scope?: string } & ManualContext>()(z.object({
  query: z.string().describe("Search keywords."),
  scope: z.string().optional().describe("Restrict the search to one Manual section."),
  ...manualContextFields,
})));

function requireContext(context: ManualContext) {
  if (!context?.intent?.trim() || !context?.reason?.trim()) {
    return failureOutcome(opError("INVALID_REQUEST", { message: "Manual calls need a short `intent` and `reason`." }));
  }
  return null;
}

export async function getManualTopic(
  client: Pick<AgentApiClient, "knowledge">,
  request: { topic: string } & ManualContext,
): Promise<RaftOutcome<AgentApiKnowledgeGetResponse, "topic">> {
  const malformed = validateOpRequest(getManualTopicRequestSchema, request); if (malformed) return malformed;
  const invalid = requireContext(request); if (invalid) return invalid;
  if (!request.topic?.trim()) return failureOutcome(opError("INVALID_REQUEST", { message: "A topic id is required." }));
  const result = await client.knowledge.get({ topic: request.topic.trim(), intent: request.intent.trim(), reason: request.reason.trim() });
  if (!result.ok) return failureFromClientResult(result);
  return { ok: true, state: "topic", data: result.data, next: null, text: formatAgentKnowledgeStdout(result.data.content) };
}

export async function searchManual(
  client: Pick<AgentApiClient, "knowledge">,
  request: { query: string; scope?: string } & ManualContext,
  options: RaftHintOptions = {},
): Promise<RaftOutcome<AgentApiKnowledgeSearchResponse, "results" | "empty">> {
  const malformed = validateOpRequest(searchManualRequestSchema, request); if (malformed) return malformed;
  const invalid = requireContext(request); if (invalid) return invalid;
  if (!request.query?.trim()) return failureOutcome(opError("INVALID_REQUEST", { message: "Search keywords are required." }));
  const result = await client.knowledge.search({
    query: request.query.trim(),
    ...(request.scope ? { scope: request.scope } : {}),
    intent: request.intent.trim(),
    reason: request.reason.trim(),
  });
  if (!result.ok) return failureFromClientResult(result);
  const data = result.data;
  const results = (data as { results: Array<{ slug: string; title: string; firstScreen: string }> }).results;
  const first = results[0];
  const next: RaftNextStep | null = first
    ? hintStep("read_manual_topic", RAFT_HINTS.manualGet(first.slug, { intent: request.intent.trim(), reason: request.reason.trim() }), "Open the best-matching topic.", options.hints, { topic: first.slug })
    : null;
  return {
    ok: true,
    state: results.length > 0 ? "results" : "empty",
    data,
    next,
    text: results.length > 0 ? formatAgentKnowledgeSearchResults(results) : "No Manual topics matched. Retry with different keywords, keeping your intent and reason.\n",
  };
}
