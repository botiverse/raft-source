// Find-a-specific-message operations: search, resolve one id, react. Distinct
// from the inbox ("what needs me now").

import { z } from "zod";
import { lazySchema } from "../lazySchema";

import type { AgentApiClient } from "../agentApiClient";
import type { AgentApiMessageSearchResponse } from "../agentApiContract";
import { formatAgentMessages } from "../agentMessageText";
import { formatArtifactsAlsoMatch } from "../agentText/artifacts";
import { formatAgentSearchResults } from "../agentText/search";
import { artifactsMatchQuery, probeWithin } from "./artifacts";
import { hintStep, RAFT_HINTS, type RaftHintOptions } from "./hint";
import { projectRaftMessage, toAgentMessageLike, type RaftMessage } from "./message";
import { failureFromClientResult, failureOutcome, opError, validateOpRequest, type RaftNextStep, type RaftOutcome } from "./outcome";
import { requestSchema } from "./requestSchema";

export interface SearchMessagesRequest {
  /** Free-text query; may be omitted when filtering by target or sender only. */
  query?: string;
  /** Restrict to a channel, DM, or thread target. */
  target?: string;
  /** Restrict to a sender handle. */
  sender?: string;
  sort?: "relevance" | "recent";
  /** ISO timestamps, both inclusive server-side. */
  before?: string;
  after?: string;
  /** 1..50; Server default 20. */
  limit?: number;
  offset?: number;
  /** A previous page's nextCursor, unchanged (recent-sort text search). */
  cursor?: string;
}

export const searchMessagesRequestSchema = lazySchema("searchMessagesRequestSchema", () => requestSchema<SearchMessagesRequest>()(z.object({
  query: z.string().optional().describe("Free-text query; may be omitted when filtering by target or sender."),
  target: z.string().optional().describe("Only this channel, DM, or thread."),
  sender: z.string().optional().describe("Only messages from this handle."),
  sort: z.enum(["relevance", "recent"]).optional().describe("relevance (the default with a query; needs one) or recent (newest first; filter-only searches always use it)."),
  before: z.string().optional().describe("ISO timestamp; only messages at or before it."),
  after: z.string().optional().describe("ISO timestamp; only messages at or after it."),
  limit: z.number().int().positive().optional().describe("Results per page, 1..50 (Server default 20)."),
  offset: z.number().int().nonnegative().optional().describe("Skip this many results (paging)."),
  cursor: z.string().optional().describe("A previous page's nextCursor, unchanged; continues a recent-sort search exactly (use instead of offset)."),
})));

export const resolveMessageRequestSchema = lazySchema("resolveMessageRequestSchema", () => requestSchema<{ messageId: string }>()(z.object({
  messageId: z.string().describe("Full or short message id."),
})));

export const reactRequestSchema = lazySchema("reactRequestSchema", () => requestSchema<ReactRequest>()(z.object({
  messageId: z.string().describe("Full or short message id."),
  emoji: z.string().describe("One reaction emoji."),
})));

export interface RaftSearchPage {
  query: string;
  results: AgentApiMessageSearchResponse["results"];
  /** Server-reported; `null` when an older Server did not say. */
  hasMore: boolean | null;
  /** The search stopped at its scan budget: these are not all the matches. Continue with `nextCursor`. */
  incomplete: boolean;
  nextCursor: string | null;
  /** incomplete only: the oldest message time searched. */
  searchedThrough: string | null;
  /** incomplete only: how many messages were read before the search stopped. */
  searchedMessages: number | null;
  /** No message matched every word; matching any word was skipped because too many match. */
  relaxedSkipped: "too_broad" | null;
  /** The plan's history window hid matches: how many and why (absent when it hid none or wasn't counted). */
  historyLimitMessage?: string;
  /** Relevance only: too many matches to rank, so the results are newest first (as recent). */
  relevanceFallback: "too_broad" | null;
}

/**
 * Whether a message search also asks if Artifacts match: a first page of a
 * text search, filtered by conversation at most (Artifacts have no sender
 * or message time).
 */
export function messageSearchProbesArtifacts(request: Pick<SearchMessagesRequest, "query" | "sender" | "before" | "after" | "offset" | "cursor">): boolean {
  return Boolean(request.query?.trim()) && !request.sender && !request.before && !request.after && !request.offset && !request.cursor;
}

export async function searchMessages(
  client: Pick<AgentApiClient, "messages" | "artifacts">,
  request: SearchMessagesRequest,
  options: RaftHintOptions = {},
): Promise<RaftOutcome<RaftSearchPage, "results" | "empty" | "incomplete">> {
  const invalid = validateOpRequest(searchMessagesRequestSchema, request); if (invalid) return invalid;
  if (!request.query?.trim() && !request.target && !request.sender) {
    return failureOutcome(opError("INVALID_REQUEST", { message: "Pass a query, or filter by target or sender." }));
  }
  const searched = client.messages.search({
    ...(request.query?.trim() ? { q: request.query.trim() } : {}),
    ...(request.target ? { channel: request.target } : {}),
    ...(request.sender ? { sender: request.sender } : {}),
    ...(request.sort ? { sort: request.sort } : {}),
    ...(request.before ? { before: request.before } : {}),
    ...(request.after ? { after: request.after } : {}),
    ...(request.limit === undefined ? {} : { limit: String(request.limit) }),
    ...(request.offset === undefined ? {} : { offset: String(request.offset) }),
    ...(request.cursor ? { cursor: request.cursor } : {}),
  });
  // Asked alongside the search (after it), never instead of it.
  const artifactsMatch = messageSearchProbesArtifacts(request)
    ? artifactsMatchQuery(client, { query: request.query!, target: request.target })
    : Promise.resolve(false);
  const result = await searched;
  if (!result.ok) return failureFromClientResult(result);
  const data = result.data;
  const hasMore = typeof data.hasMore === "boolean" ? data.hasMore : null;
  const incomplete = data.incomplete === true;
  const nextCursor = typeof data.nextCursor === "string" && data.nextCursor ? data.nextCursor : null;
  const searchedThrough = typeof data.searchedThrough === "string" ? data.searchedThrough : null;
  const searchedMessages = typeof data.searchedMessages === "number" ? data.searchedMessages : null;
  const relaxedSkipped = data.relaxedSkipped === "too_broad" ? "too_broad" : null;
  const relevanceFallback = data.relevanceFallback === "too_broad" ? "too_broad" : null;
  const historyLimitMessage = data.historyLimited === true
    ? (typeof data.historyLimitMessage === "string" && data.historyLimitMessage ? data.historyLimitMessage : undefined)
    : undefined;
  const page: RaftSearchPage = {
    query: request.query?.trim() ?? "",
    results: data.results,
    hasMore,
    incomplete,
    nextCursor,
    searchedThrough,
    searchedMessages,
    relaxedSkipped,
    relevanceFallback,
    ...(historyLimitMessage ? { historyLimitMessage } : {}),
  };
  const { offset: _offset, ...requestWithoutOffset } = request;
  const nextArgs = nextCursor
    ? { ...requestWithoutOffset, sort: "recent" as const, cursor: nextCursor }
    : { ...request, offset: (request.offset ?? 0) + data.results.length };
  const query = request.query?.trim();
  const continueHint = nextCursor && query
    ? RAFT_HINTS.messageSearch({
      query,
      target: request.target,
      sender: request.sender,
      after: request.after,
      before: request.before,
      limit: request.limit,
      cursor: nextCursor,
    })
    : null;
  const next: RaftNextStep | null = continueHint && (incomplete || hasMore)
    ? hintStep(
      incomplete ? "continue_search" : "next_search_page",
      continueHint,
      incomplete
        ? "The search stopped before reaching older messages; continue, or narrow it with a target or sender."
        : "More results exist; this continues exactly after the page.",
      options.hints,
      nextArgs,
    )
    : hasMore
    ? {
        kind: "next_search_page",
        args: nextArgs,
        operation: { name: "messages.search", args: nextArgs },
        why: "More results exist; page on, or narrow the query.",
      }
    : null;
  return {
    ok: true,
    // "empty" means everything was searched and nothing matched; a search that
    // stopped before older messages with nothing found yet is "incomplete"
    // (next is continue_search). A page with results stays "results".
    state: data.results.length > 0 ? "results" : incomplete ? "incomplete" : "empty",
    data: page,
    next,
    text: formatAgentSearchResults(page.query, {
      results: data.results as never,
      ...(hasMore === null ? {} : { hasMore }),
      ...(incomplete ? { incomplete } : {}),
      ...(nextCursor ? { nextCursor } : {}),
      ...(searchedThrough ? { searchedThrough } : {}),
      ...(searchedMessages === null ? {} : { searchedMessages }),
      ...(relaxedSkipped ? { relaxedSkipped } : {}),
      ...(data.historyLimited === true ? { historyLimited: true, ...(historyLimitMessage ? { historyLimitMessage } : {}) } : {}),
      ...(relevanceFallback ? { relevanceFallback } : {}),
    }, request.offset, request.sort, request.limit, options.hints, {
      target: request.target,
      sender: request.sender,
      after: request.after,
      before: request.before,
    }) + (await probeWithin(artifactsMatch) ? `\n${formatArtifactsAlsoMatch(page.query, request.target, options.hints)}` : ""),
  };
}

export async function resolveMessage(
  client: Pick<AgentApiClient, "messages">,
  request: { messageId: string },
  options: RaftHintOptions = {},
): Promise<RaftOutcome<RaftMessage, "message">> {
  const invalid = validateOpRequest(resolveMessageRequestSchema, request); if (invalid) return invalid;
  if (!request.messageId?.trim()) return failureOutcome(opError("INVALID_REQUEST", { message: "A message id is required." }));
  const result = await client.messages.resolve({ msgId: request.messageId as never });
  if (!result.ok) return failureFromClientResult(result);
  const message = projectRaftMessage(result.data.message, options.hints);
  if (!message) return failureOutcome(opError("INVALID_RESPONSE", { message: "The resolved message carries no conversation identity." }));
  return {
    ok: true,
    state: "message",
    data: message,
    next: hintStep(
      "read_target",
      RAFT_HINTS.messageRead({ target: message.target, around: { shown: message.shortId ?? request.messageId, id: message.id ?? request.messageId } }),
      "Read the surrounding context before acting on one message.",
      options.hints,
      { target: message.target, around: message.id ?? request.messageId },
    ),
    text: formatAgentMessages([toAgentMessageLike(message.raw)], options.hints),
  };
}

export interface ReactRequest {
  messageId: string;
  emoji: string;
}

export async function reactToMessage(
  client: Pick<AgentApiClient, "messages">,
  request: ReactRequest,
  action: "add" | "remove" = "add",
): Promise<RaftOutcome<ReactRequest, "added" | "removed">> {
  const invalid = validateOpRequest(reactRequestSchema, request); if (invalid) return invalid;
  const emoji = request.emoji?.trim();
  if (!request.messageId?.trim() || !emoji || /\s/.test(emoji) || emoji.length > 16) {
    return failureOutcome(opError("INVALID_REQUEST", { message: "A message id and a single reaction emoji are required." }));
  }
  const params = { msgId: request.messageId as never };
  const result = action === "add"
    ? await client.messages.addReaction(params, { emoji })
    : await client.messages.removeReaction(params, { emoji });
  if (!result.ok) return failureFromClientResult(result);
  const verb = action === "add" ? "added to" : "removed from";
  return {
    ok: true,
    state: action === "add" ? "added" : "removed",
    data: { messageId: request.messageId, emoji },
    next: null,
    text: `Reaction ${emoji} ${verb} message ${request.messageId.slice(0, 8)}.`,
  };
}
