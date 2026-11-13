// Card messages (RFC 082) as agent operations: the card a send or an update
// carries, checked with the shared schema before any request (so the caller
// gets the element's path and the limit it breaks), the Server's card
// refusals in its own sentence, and `messages.updateCard`: the sender
// replacing its card message's card and text, which notifies no one.

import { z } from "zod";
import { lazySchema } from "../lazySchema";

import type { AgentApiClient, AgentApiClientResult } from "../agentApiClient";
import type { AgentApiRouteKey } from "../agentApiContract";
import type { AgentApiMessageCardUpdateBody } from "../agentApiMessageContract";
import { formatAgentMessageCardUpdated } from "../agentText/messageCards";
import { asMessageId } from "../brandedIds";
import {
  formatMessageCardProblem,
  MESSAGE_CARD_ERROR_CODES,
  messageCardFallbackProblem,
  parseMessageCard,
  type MessageCardInput,
  type MessageCardProblem,
} from "../messageCard";
import { failureFromClientResult, failureOutcome, keyedWriteFailure, opError, validateOpRequest, type RaftFailure, type RaftOutcome } from "./outcome";
import { requestSchema } from "./requestSchema";

/**
 * A card in an operation's input, read loosely here: `parseMessageCard`
 * checks it (messageCardRequestFailure) and names the element's path and the
 * limit, which a schema issue would not. Typed as the card a sender writes.
 */
export const raftMessageCardInputSchema = lazySchema("raftMessageCardInputSchema", () => z.object({
  version: z.number().describe("Always 1."),
  header: z.object({}).passthrough().optional()
    .describe("Optional: { title (1-100), subtitle? (1-100, one line), tags? (at most 3: { text (1-24), tone: neutral | info | success | warning | danger }) }, drawn at the top of the card; plain text."),
  root: z.string().describe("The id of the root element, usually a Stack."),
  elements: z.record(z.string(), z.object({}).passthrough())
    .describe("Element id → { type, props } (a Stack also has children: element ids). Types: Stack, Text, Badge, RelativeTime, Duration, Button (props.action { kind: \"navigate\", url: an https URL }), Markdown (props.content: 1-2000; paragraphs, bold, italic, strikethrough, code, fenced code, lists and quotes nested at most 3 deep, http, https and mailto links; anything else is refused), Fields (props.items: 1-8 { label (1-40), value (1-200), mono? }), Divider (props {})."),
}).passthrough()) as unknown as z.ZodType<MessageCardInput, MessageCardInput>;

/** What a card field says to a model (messages.send / reply / updateCard). */
export const RAFT_MESSAGE_CARD_FIELD_DESCRIPTION =
  "A card message's card (only where the Server has card messages on): a small display-only layout everyone sees the same way. "
  + "At most 16 elements, depth 4, 4 buttons, 8 KiB of JSON; buttons only open https links.";

function invalidCard(problem: MessageCardProblem): RaftFailure {
  return failureOutcome(opError("INVALID_REQUEST", {
    message: `${formatMessageCardProblem(problem)} Nothing was sent.`,
    nextAction: `Fix ${problem.path}, then send the same request again.`,
  }));
}

/**
 * The card of a send or an update, checked as the Server checks it: null
 * when it may be sent, else the refusal (nothing was sent). `content` is the
 * text the caller wrote; without it the card must have something to derive
 * the text from, and `mentions` are refused (a derived text mentions no one).
 */
export function messageCardRequestFailure(card: unknown, content: string | undefined, mentions?: readonly unknown[]): RaftFailure | null {
  const parsed = parseMessageCard(card);
  if (!parsed.ok) return invalidCard(parsed.problem);
  const fallback = messageCardFallbackProblem(parsed.card, content);
  if (fallback) return invalidCard(fallback);
  if (mentions && mentions.length > 0 && !(typeof content === "string" && content.length > 0)) {
    return failureOutcome(opError("INVALID_REQUEST", {
      message: "mentions need the content they appear in: a card sent without content gets a text Raft derives from the card, and it mentions no one. Nothing was sent.",
      nextAction: "Write the content with the @mentions, or leave out mentions.",
    }));
  }
  return null;
}

const CARD_REFUSAL_CODES: ReadonlySet<string> = new Set([...Object.values(MESSAGE_CARD_ERROR_CODES), "idempotency_key_reused"]);
const CARD_REFUSAL_SENTENCE_MAX_CHARS = 1000;

/**
 * A card refusal (4xx with a card code; not a 429, whose sentence the
 * standard mapping keeps) in the Server's own sentence, written for agents:
 * what is wrong (the element's path and the limit) and that nothing changed.
 * Code, Server code, next step and retryable are the standard mapping's.
 */
export function messageCardFailure<K extends AgentApiRouteKey>(result: Extract<AgentApiClientResult<K>, { ok: false }>): RaftFailure {
  const failure = failureFromClientResult(result);
  const { error } = result;
  if (error.kind !== "http" || error.status < 400 || error.status >= 500 || error.status === 429) return failure;
  if (!error.errorCode || !CARD_REFUSAL_CODES.has(error.errorCode)) return failure;
  const sentence = error.message.trim();
  return sentence && !/[\r\n]/.test(sentence) && sentence.length <= CARD_REFUSAL_SENTENCE_MAX_CHARS
    ? failureOutcome({ ...failure.error, message: sentence })
    : failure;
}

// ── update ────────────────────────────────────────────────────────────────

/** Attempts for a keyed update whose request never reached the Server (transport failure only). */
const UPDATE_TRANSPORT_ATTEMPTS = 3;

export interface UpdateMessageCardRequest {
  /** The card message: its id (full or 8-character short). Only one you sent, within 14 days. */
  messageId: string;
  /** The new card; it replaces the whole card. */
  card: MessageCardInput;
  /** The new text agents, search and notifications read; derived from the new card when omitted. Mentions in it notify no one. */
  content?: string;
  /** The revision last read (`card=rN`); another current revision refuses with CONFLICT and changes nothing. */
  expectedRevision?: number;
  /**
   * One key per logical update; generated with `crypto.randomUUID()` when
   * omitted. The same key with the same card and content answers the first
   * result again instead of a second revision.
   */
  idempotencyKey?: string;
}

export const updateMessageCardRequestSchema = lazySchema("updateMessageCardRequestSchema", () => requestSchema<UpdateMessageCardRequest>()(z.object({
  messageId: z.string().describe("The card message you sent: its id (full or short). Only one you sent in the last 14 days."),
  card: raftMessageCardInputSchema.describe(`The new card; it replaces the whole card. ${RAFT_MESSAGE_CARD_FIELD_DESCRIPTION}`),
  content: z.string().optional().describe("The new text agents, search and notifications read; Raft derives it from the card when omitted. An @mention in it notifies no one."),
  expectedRevision: z.number().int().positive().optional().describe("The revision you last read (card=rN in the message header). If the card changed since, nothing changes (CONFLICT)."),
  idempotencyKey: z.string().optional().describe("One key per logical update; generated when omitted. Reuse it to retry: the same update with the same key answers the first result."),
})));

export interface RaftCardUpdate {
  messageId: string;
  revision: number;
  /** ISO UTC. */
  updatedAt: string;
  /** Each @mention in the new text; none of them was notified. */
  unnotifiedMentionHandles: string[];
  /** The key this update was sent with (the caller's, or the generated one). */
  idempotencyKey: string;
}

/** 409 card_revision_conflict: the card moved on; the next step is the same update with the current revision. */
function revisionConflictFailure(failure: RaftFailure, response: unknown, expectedRevision: number | undefined): RaftFailure {
  const current = response && typeof response === "object" ? (response as { currentRevision?: unknown }).currentRevision : undefined;
  if (typeof current !== "number" || !Number.isSafeInteger(current)) return failure;
  const error = {
    ...failure.error,
    message: `The card is at revision ${current}${expectedRevision === undefined ? "" : `, not ${expectedRevision}`}: it was updated since you read it, and nothing changed now.`,
    nextAction: `Read the message if you need to, then update it again with expectedRevision ${current}.`,
  };
  return { ...failureOutcome(error), next: { kind: "retry_with_revision", args: { expectedRevision: current }, why: error.nextAction } };
}

/**
 * Replace the card (and its text) of a card message this agent sent, within
 * 14 days (RFC 082 §4.2). Notifies no one: the outcome text says so and names
 * each @mention of the new text. The card is checked before any request; a
 * request that never reached the Server is sent again under the same key.
 */
export async function updateMessageCard(
  client: Pick<AgentApiClient, "messages">,
  request: UpdateMessageCardRequest,
): Promise<RaftOutcome<RaftCardUpdate, "updated">> {
  const invalid = validateOpRequest(updateMessageCardRequestSchema, request); if (invalid) return invalid;
  const messageId = request.messageId.trim();
  if (!messageId) return failureOutcome(opError("INVALID_REQUEST", { message: "A message id is required to update a card." }));
  const content = typeof request.content === "string" && request.content.length > 0 ? request.content : undefined;
  const refused = messageCardRequestFailure(request.card, content); if (refused) return refused;
  const idempotencyKey = request.idempotencyKey?.trim() || globalThis.crypto.randomUUID();
  const body: AgentApiMessageCardUpdateBody = {
    card: request.card,
    ...(content !== undefined ? { content } : {}),
    ...(request.expectedRevision !== undefined ? { expectedRevision: request.expectedRevision } : {}),
    idempotencyKey,
  };
  const params = { messageId: asMessageId(messageId) };
  // The key makes a repeat safe, so a request that never reached the Server is retried (bounded).
  let result = await client.messages.updateCard(params, body);
  for (let attempt = 1; !result.ok && result.error.kind === "transport" && attempt < UPDATE_TRANSPORT_ATTEMPTS; attempt += 1) {
    result = await client.messages.updateCard(params, body);
  }
  if (!result.ok) {
    const failure = messageCardFailure(result);
    const { error } = result;
    return keyedWriteFailure(
      error.kind === "http" && error.errorCode === MESSAGE_CARD_ERROR_CODES.revisionConflict
        ? revisionConflictFailure(failure, error.response, request.expectedRevision)
        : failure,
      idempotencyKey,
    );
  }
  const data = result.data;
  return {
    ok: true,
    state: "updated",
    data: {
      messageId: data.messageId,
      revision: data.revision,
      updatedAt: data.updatedAt,
      unnotifiedMentionHandles: data.unnotifiedMentionHandles,
      idempotencyKey,
    },
    next: null,
    text: formatAgentMessageCardUpdated({ messageId: data.messageId, revision: data.revision, notice: data.notice }),
  };
}
