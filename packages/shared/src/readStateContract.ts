// Read-state HTTP contract: Mark as Unread (`POST /api/channels/{channelId}/unread`).
// Registered in the OpenAPI registry (openApiContract.ts); the server route
// checks its 200 answer against `MarkConversationUnreadResponse` at compile
// time, and its API test parses real answers with the schema.
//
// Do not add `import "zod-openapi"` here: this file is reachable from the
// package barrel (see attachmentUploadContract.ts for why).
import { z } from "zod";
import { lazySchema } from "./lazySchema";

/**
 * What Mark as Unread left on the conversation, decided in the read-state
 * transaction from the state it wrote (not re-read afterwards):
 * - `counted`: a message from someone else that the person can count lies past
 *   their read position, so the conversation shows a number (`unreadCount`).
 * - `marked`: nothing countable lies past it (a thread of only the person's own
 *   replies), so the conversation carries the marked-unread flag with no count.
 * - `nothing`: neither; it stays read (no messages at all, or a conversation
 *   the person is not in).
 * Counted wins over marked: a rewind clears an older mark.
 */
export const MARK_UNREAD_OUTCOMES = ["counted", "marked", "nothing"] as const;
export const markUnreadOutcomeSchema = lazySchema("markUnreadOutcomeSchema", () => z.enum(MARK_UNREAD_OUTCOMES)
  .meta({ id: "MarkUnreadOutcome" }));
export type MarkUnreadOutcome = z.infer<typeof markUnreadOutcomeSchema>;

export const markConversationUnreadPathParamsSchema = lazySchema("markConversationUnreadPathParamsSchema", () => z.strictObject({
  channelId: z.uuid(),
}).meta({ id: "MarkConversationUnreadPathParams" }));

export const markConversationUnreadResponseSchema = lazySchema("markConversationUnreadResponseSchema", () => z.strictObject({
  ok: z.literal(true),
  unreadCount: z.int().nonnegative(),
  maxReadSeq: z.int().nonnegative(),
  readStateVersion: z.int().nonnegative(),
  /** Always sent, so a client can tell this server from one older than the mark. */
  markedUnread: z.boolean(),
  /** Added after `markedUnread`: this server always sends it, older servers omit it. */
  outcome: markUnreadOutcomeSchema.optional(),
}).meta({ id: "MarkConversationUnreadResponse" }));
export type MarkConversationUnreadResponse = z.infer<typeof markConversationUnreadResponseSchema>;

/**
 * What a 200 Mark as Unread answer means: the server's `outcome` when it sends
 * one, else the inference clients used before it (a count wins over the mark,
 * as on the server; an answer with neither is `nothing`). Pinned by the R1
 * cases in `contract-cases/unread/`; the app's MarkUnreadOutcome.kt follows
 * the same cases.
 */
export function resolveMarkUnreadOutcome(
  answer: Readonly<{ outcome?: unknown; unreadCount?: unknown; markedUnread?: unknown }> | null | undefined,
): MarkUnreadOutcome {
  const outcome = answer?.outcome;
  if (outcome === "counted" || outcome === "marked" || outcome === "nothing") return outcome;
  if (Number(answer?.unreadCount ?? 0) > 0) return "counted";
  return answer?.markedUnread === true ? "marked" : "nothing";
}

/** 202: the write is admitted but its result is not known yet (the read-mutation frontier tells). */
export const readMutationPendingResponseSchema = lazySchema("readMutationPendingResponseSchema", () => z.strictObject({
  code: z.literal("READ_MUTATION_PENDING"),
  status: z.literal("admitted"),
  outcome: z.literal("unknown"),
  mutationId: z.uuid(),
  authoritySeq: z.int().nonnegative(),
  frontierUrl: z.string(),
}).meta({ id: "ReadMutationPendingResponse" }));

export const readStateErrorResponseSchema = lazySchema("readStateErrorResponseSchema", () => z.strictObject({
  error: z.string(),
  code: z.literal("READ_MUTATION_FENCE_REFUSED").optional(),
}).meta({ id: "ReadStateErrorResponse" }));

type OperationDefinition = Readonly<{
  method: "get" | "post" | "delete";
  path: string;
  operationId: string;
  summary: string;
  requestParams?: z.ZodObject;
  requestBody?: z.ZodType;
  responses: Readonly<Record<number, Readonly<{ description: string; schema: z.ZodType }>>>;
}>;

const defineOperation = <const Operation extends OperationDefinition>(operation: Operation) => operation;

export const readStateContract = {
  markUnread: defineOperation({
    method: "post",
    path: "/api/channels/{channelId}/unread",
    operationId: "markConversationUnread",
    summary: "Mark a conversation unread (no request body)",
    requestParams: markConversationUnreadPathParamsSchema,
    responses: {
      200: { description: "The read state after the write, and what it left (`outcome`)", schema: markConversationUnreadResponseSchema },
      202: { description: "Admitted; the result is not known yet", schema: readMutationPendingResponseSchema },
      403: { description: "The read-state fence refused the caller", schema: readStateErrorResponseSchema },
      404: { description: "The conversation does not exist or is not visible to the caller", schema: readStateErrorResponseSchema },
    },
  }),
} as const;
