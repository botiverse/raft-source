import { z } from "zod";
import { lazySchema } from "./lazySchema";
import { isSlackBridgedExternalProvider } from "./externalProjection";
import type { AgentMessageCardMarker, MessageCardInput } from "./messageCard";

const optionalStringSchema = lazySchema("optionalStringSchema", () => z.string().trim().optional());
const optionalStringArraySchema = lazySchema("optionalStringArraySchema", () => z.array(z.string().trim().min(1)).optional());
const optionalBooleanSchema = lazySchema("optionalBooleanSchema", () => z.boolean().optional());
const optionalNumberSchema = lazySchema("optionalNumberSchema", () => z.number().finite().optional());
const optionalExactSeqArraySchema = lazySchema("optionalExactSeqArraySchema", () => z.array(z.number().int().positive()).max(2_500).optional());
const optionalIsoTimestampSchema = lazySchema("optionalIsoTimestampSchema", () => z.string().datetime().optional());
const nullableStringSchema = lazySchema("nullableStringSchema", () => z.string().nullable());

const passthroughObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();

export const agentApiFreshnessContextModeSchema = lazySchema("agentApiFreshnessContextModeSchema", () => z.enum(["inline", "withheld"]));

export interface AgentApiStructuredMention {
  type: "user" | "agent";
  id: string;
  name: string;
}

export const agentApiStructuredMentionSchema = lazySchema("agentApiStructuredMentionSchema", () => z.object({
  type: z.enum(["user", "agent"]),
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(128),
}));

/**
 * A channel's card (passive-AX `channel` resource, versioned by
 * `channelCardRev`): what `raft channel info` shows about it. Returned with
 * history reads, and by a send that names its card version.
 */
export const agentApiChannelCardSchema = lazySchema("agentApiChannelCardSchema", () => passthroughObject({
  id: z.string().min(1),
  name: z.string(),
  type: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  archived: z.boolean().optional(),
}));

export interface AgentApiChannelCard {
  id: string;
  name: string;
  type?: string | null;
  description?: string | null;
  archived?: boolean;
}

/**
 * The other side of a DM (the `sender` passive resource): their kind, handle,
 * description, and the zone their latest message carried. Returned with
 * history reads of a DM, and by a send that names its version.
 */
export const agentApiPeerCardSchema = lazySchema("agentApiPeerCardSchema", () => passthroughObject({
  kind: z.enum(["human", "agent"]),
  name: z.string(),
  description: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
}));

export interface AgentApiPeerCard {
  kind: "human" | "agent";
  name: string;
  description?: string | null;
  timezone?: string | null;
}

/**
 * Card versions the sender has in its current model context. `channel`: the
 * `channelCardRev` of the target's channel card; `peer`: the `peerCardRev`
 * this context has for a DM target's peer (only null-or-not is compared:
 * the zone travels with each message). Null: this context has not seen it.
 * Absent: the client does not track that card (today's behavior).
 */
const agentApiSeenCardsSchema = lazySchema("agentApiSeenCardsSchema", () => z.object({
  channel: z.string().min(1).nullable().optional(),
  peer: z.string().min(1).nullable().optional(),
}));

const agentApiSendBodyKnownSchema = lazySchema("agentApiSendBodyKnownSchema", () => z.object({
  target: z.string().optional(),
  content: z.string().optional(),
  attachmentIds: optionalStringArraySchema,
  idempotencyKey: optionalStringSchema,
  reconcileOnly: optionalBooleanSchema,
  continue: optionalBooleanSchema,
  sendDraft: optionalBooleanSchema,
  continueAnyway: optionalBooleanSchema,
  draftReholdCount: optionalNumberSchema,
  draftReplacedExisting: optionalBooleanSchema,
  seenUpToSeq: optionalNumberSchema,
  seenExactSeqs: optionalExactSeqArraySchema,
  seenCards: agentApiSeenCardsSchema.optional(),
  freshnessContextMode: agentApiFreshnessContextModeSchema.optional(),
}));

export const agentApiSendBodySchema = lazySchema("agentApiSendBodySchema", () => agentApiSendBodyKnownSchema.passthrough());

/**
 * RFC 082: a card on a v2 send, read loosely here. The Server checks it with
 * the shared `parseMessageCard` and refuses one that breaks a rule with 400
 * `card_invalid` naming the element's path and the limit, not a contract
 * mismatch; a Server whose `message_cards` flag is off refuses any card
 * (`message_cards_disabled`). Older Servers ignore the field (passthrough).
 */
const agentApiSendCardSchema = lazySchema("agentApiSendCardSchema", () => z.object({}).passthrough()
  .describe("A message card (RFC 082): { version: 1, header?, root, elements }, validated by the Server"));

export const agentApiSendV2BodySchema = lazySchema("agentApiSendV2BodySchema", () => agentApiSendBodyKnownSchema.extend({
  mentions: z.array(agentApiStructuredMentionSchema).optional(),
  card: agentApiSendCardSchema.optional(),
}).passthrough());

/**
 * RFC 082 §4.2: `PUT /messages/:messageId/card`, the sender replacing its
 * card message's card and fallback. `card` is read loosely here and checked
 * by the Server as at send (400 `card_invalid`); `content` absent: the
 * fallback is derived from the new card. Mentions are never resolved again,
 * so the body has no `mentions`.
 */
export const agentApiMessageCardUpdateBodySchema = lazySchema("agentApiMessageCardUpdateBodySchema", () => z.object({
  card: agentApiSendCardSchema,
  content: z.string().optional(),
  /** The revision the caller last read; another current revision refuses with 409 `card_revision_conflict`. */
  expectedRevision: z.number().int().positive().optional(),
  idempotencyKey: optionalStringSchema,
}).passthrough());

/** A card update's answer (also the replay of a repeated `idempotencyKey`). */
export const agentApiMessageCardUpdateResponseSchema = lazySchema("agentApiMessageCardUpdateResponseSchema", () => passthroughObject({
  ok: z.literal(true),
  messageId: z.string(),
  revision: z.number().int().positive(),
  updatedAt: z.string(),
  /** Each @mention in the new fallback: none of them was notified. */
  unnotifiedMentionHandles: z.array(z.string()),
  /** "Updating notifies no one. …" for the agent, naming those mentions. */
  notice: z.string(),
}));

export const legacyAgentSendBodySchema = lazySchema("legacyAgentSendBodySchema", () => agentApiSendBodySchema.extend({
  channel: z.string().optional(),
  dm_to: z.string().optional(),
}));

export const agentApiAttachmentEnvelopeSchema = lazySchema("agentApiAttachmentEnvelopeSchema", () => passthroughObject({
  id: z.string(),
  filename: z.string(),
}));

/** Task v2: one task hanging under a chat message (servers with task v2 conversations only). */
export const agentApiMessageSourceTaskSchema = lazySchema("agentApiMessageSourceTaskSchema", () => passthroughObject({
  number: z.number().int().positive(),
  status: z.string(),
  assignee_type: z.string().nullable().optional(),
  assignee_id: z.string().nullable().optional(),
  assignee_name: z.string().nullable().optional(),
}));

export const agentApiTaskCurrentProjectionSchema = lazySchema("agentApiTaskCurrentProjectionSchema", () => passthroughObject({
  title: z.string(),
  description: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  superseded: z.boolean(),
  amendedAt: z.string().datetime().nullable().optional(),
  amended_at: z.string().datetime().nullable().optional(),
  amendedByType: z.enum(["user", "agent", "system"]).nullable().optional(),
  amended_by_type: z.enum(["user", "agent", "system"]).nullable().optional(),
  amendedByName: z.string().nullable().optional(),
  amended_by_name: z.string().nullable().optional(),
  source: z.literal("tasks_current_projection"),
}));

const agentApiExternalMessageProvenanceSchema = lazySchema("agentApiExternalMessageProvenanceSchema", () => z.object({
  schema: z.literal("external-message-provenance.v1"),
  provider: z.string().trim().min(1),
  workspace_id: z.string().trim().min(1),
  conversation_id: z.string().trim().min(1),
  message_id: z.string().trim().min(1),
  actor_id: z.string().trim().min(1),
  actor_kind: z.enum(["human", "guest", "remote", "bot", "unknown"]),
  projection_id: z.string().uuid(),
}).strict());

export interface AgentApiExternalMessageProvenance {
  schema: "external-message-provenance.v1";
  provider: string;
  workspace_id: string;
  conversation_id: string;
  message_id: string;
  actor_id: string;
  actor_kind: "human" | "guest" | "remote" | "bot" | "unknown";
  projection_id: string;
}

export const AGENT_API_EXTERNAL_MESSAGE_FORBIDDEN_AUTHORITY_FIELDS = [
  "agentSendKey", "agent_send_key", "searchText", "search_text", "searchVector", "search_vector",
  "externalAuthor", "external_author", "mentions", "actionMetadata", "action_metadata", "taskId", "task_id",
  "taskStatus", "task_status", "taskNumber", "task_number", "taskAssigneeId", "task_assignee_id",
  "taskAssigneeType", "task_assignee_type", "taskAssigneeName", "task_assignee_name", "taskClaimedAt", "task_claimed_at",
  "taskCompletedAt", "task_completed_at", "taskClaimedById", "task_claimed_by_id", "taskClaimedByType", "task_claimed_by_type",
  "taskClaimedByName", "task_claimed_by_name", "claimedById", "claimed_by_id", "claimedByType", "claimed_by_type",
  "claimedByName", "claimed_by_name", "claimedAt", "claimed_at", "completedAt", "completed_at",
] as const;
const AGENT_API_EXTERNAL_MESSAGE_FORBIDDEN_AUTHORITY_FIELD_SET = new Set<string>(AGENT_API_EXTERNAL_MESSAGE_FORBIDDEN_AUTHORITY_FIELDS);
const AGENT_API_EXTERNAL_MESSAGE_TASK_LIFECYCLE_FIELD = /^(?:task|claimed|completed)(?:_|[A-Z])/;
export function isAgentApiExternalMessageForbiddenAuthorityField(field: string): boolean {
  return AGENT_API_EXTERNAL_MESSAGE_FORBIDDEN_AUTHORITY_FIELD_SET.has(field)
    || AGENT_API_EXTERNAL_MESSAGE_TASK_LIFECYCLE_FIELD.test(field);
}

/** At most this many reactors are named per emoji in a message envelope's `reactions`; `count` is the true total. */
export const AGENT_API_MESSAGE_REACTION_REACTORS_MAX = 5;

/**
 * One emoji's reactions on a message, as an agent reads them
 * (`AgentApiMessageEnvelope.reactions`): how many reacted with it, and the
 * first AGENT_API_MESSAGE_REACTION_REACTORS_MAX of them, in the order they
 * reacted. `reactors` is absent from a Server older than the field (then only
 * `count` is known). Not gated by any flag.
 */
export const agentApiMessageReactionSchema = lazySchema("agentApiMessageReactionSchema", () => passthroughObject({
  emoji: z.string(),
  count: z.number().int().nonnegative(),
  reactors: z.array(passthroughObject({
    /** The reactor's handle, written without `@`; a display name where there is no handle. */
    name: z.string(),
    /** `human`, `agent`, or `external` (someone mirrored from another service, such as Slack). */
    kind: z.string(),
  })).optional(),
}));

export const agentApiMessageEnvelopeSchema = lazySchema("agentApiMessageEnvelopeSchema", () => passthroughObject({
  seq: optionalNumberSchema,
  id: optionalStringSchema,
  message_id: optionalStringSchema,
  timestamp: optionalIsoTimestampSchema,
  createdAt: optionalIsoTimestampSchema,
  senderType: optionalStringSchema,
  sender_type: optionalStringSchema,
  senderName: optionalStringSchema,
  sender_name: optionalStringSchema,
  senderDescription: z.string().nullable().optional(),
  sender_description: z.string().nullable().optional(),
  senderTimezone: z.string().nullable().optional(),
  sender_timezone: z.string().nullable().optional(),
  delegated_by: z.object({ name: z.string() }).passthrough().nullable().optional(),
  external_message: agentApiExternalMessageProvenanceSchema.optional(),
  channel_type: optionalStringSchema,
  channel_name: optionalStringSchema,
  parent_channel_type: optionalStringSchema,
  parent_channel_name: optionalStringSchema,
  // The body keeps its leading blanks (a first line of indented code reads as
  // written); only trailing blanks go (most sends end with a line break).
  content: z.string().overwrite((text) => text.trimEnd()).optional(),
  attachments: z.array(agentApiAttachmentEnvelopeSchema).optional(),
  taskStatus: z.string().nullable().optional(),
  task_status: z.string().nullable().optional(),
  taskNumber: z.number().int().positive().nullable().optional(),
  task_number: z.number().int().positive().nullable().optional(),
  taskAssigneeId: z.string().nullable().optional(),
  task_assignee_id: z.string().nullable().optional(),
  taskAssigneeType: z.string().nullable().optional(),
  task_assignee_type: z.string().nullable().optional(),
  taskAssigneeName: z.string().nullable().optional(),
  task_assignee_name: z.string().nullable().optional(),
  taskCurrentProjection: agentApiTaskCurrentProjectionSchema.optional(),
  task_current_projection: agentApiTaskCurrentProjectionSchema.optional(),
  source_tasks: z.array(agentApiMessageSourceTaskSchema).optional(),
  task_conversation_number: z.number().int().positive().optional(),
  threadId: z.string().nullable().optional(),
  replyCount: z.number().int().nonnegative().nullable().optional(),
  /**
   * RFC 082: a card message's revision and when it last changed (`card=r1` in
   * the header), and `text`, the card as markdown Raft generates from it
   * (§4.3; absent from an older Server).
   */
  message_card: z.object({ revision: z.number().int().positive(), updated_at: z.string(), text: z.string().optional() }).nullable().optional(),
  /** The message's reactions, one entry per emoji in the order each was first used; empty or absent when it has none. */
  reactions: z.array(agentApiMessageReactionSchema).optional(),
}).superRefine((value, ctx) => {
  if (!value.external_message) return;
  const senderTypes = [value.senderType, value.sender_type].filter((v): v is string => v !== undefined);
  if (senderTypes.length === 0 || senderTypes.some((v) => v !== "third_party_app")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "external_message requires inert third_party_app sender type", path: ["senderType"] });
  }
  // Slack-bridged messages carry the reader's mention fact like an ordinary
  // message; every other external provider must stay explicitly non-mentioned.
  const mentioned = (value as { mentioned?: unknown }).mentioned;
  if (typeof mentioned !== "boolean") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "external_message must carry an explicit mentioned boolean", path: ["mentioned"] });
  } else if (mentioned && !isSlackBridgedExternalProvider(value.external_message.provider)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "non-Slack external_message must be explicitly non-mentioned", path: ["mentioned"] });
  }
  for (const field of Object.keys(value)) if (isAgentApiExternalMessageForbiddenAuthorityField(field)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `external_message cannot carry ${field} authority`, path: [field] });
  }
}));

export const agentApiHeldFreshnessResponseSchema = lazySchema("agentApiHeldFreshnessResponseSchema", () => passthroughObject({
  ok: z.literal(true).optional(),
  state: z.literal("held"),
  outcome: z.literal("held").optional(),
  subtype: z.literal("freshness").optional(),
  reason: z.string().optional(),
  decision: z.enum(["local_hold", "syncing_hold"]).optional(),
  producerFactId: optionalStringSchema,
  available_actions: z.array(z.string()).optional(),
  heldMessages: z.array(agentApiMessageEnvelopeSchema).optional(),
  recentUnread: z.array(agentApiMessageEnvelopeSchema).optional(),
  newMessageCount: optionalNumberSchema,
  shownMessageCount: optionalNumberSchema,
  omittedMessageCount: optionalNumberSchema,
  mentionAnnotation: passthroughObject({
    formalMentionCount: z.number().finite(),
  }).optional(),
  continueAnywaySuggested: optionalBooleanSchema,
  freshnessContextMode: agentApiFreshnessContextModeSchema.optional(),
  withheldMessageCount: optionalNumberSchema,
  seenUpToSeq: optionalNumberSchema,
  seenUpToMessageId: nullableStringSchema.optional(),
  /** Why the send was held; absent means unread messages (`unread_messages`). */
  // Open set: a reason an older client does not know must not fail its parse.
  holdReasons: z.array(z.string()).optional(),
  /** The target's channel card, when the send named a version this context has not seen. */
  channelCard: agentApiChannelCardSchema.optional(),
  /** True when this context saw an older version of `channelCard`. */
  channelCardChanged: optionalBooleanSchema,
  /** A DM target's peer card, when this context has not seen the peer. */
  peerCard: agentApiPeerCardSchema.optional(),
}));

export const agentApiSendSentResponseSchema = lazySchema("agentApiSendSentResponseSchema", () => passthroughObject({
  ok: z.literal(true),
  state: z.literal("sent"),
  messageId: z.string(),
  messageSeq: optionalNumberSchema,
  /** Task v2: the target named a task conversation; newer CLIs reply with `raft task reply <ref>`. */
  taskCommandHint: optionalStringSchema,
  recentUnread: z.array(agentApiMessageEnvelopeSchema).optional(),
  pendingMentionActions: z.array(agentApiMessageEnvelopeSchema).optional(),
  unresolvedMentionHandles: z.array(z.string()).optional(),
  /** Handles of the agents this message was delivered to, sorted; [] when none. Absent when not counted (Joint channel, older Server). */
  deliveredToAgents: z.array(z.string()).optional(),
  attention: passthroughObject({
    driveByJoinedToPost: passthroughObject({
      reason: optionalStringSchema,
      muteCommand: optionalStringSchema,
      stillArrives: optionalStringArraySchema,
    }).optional(),
  }).optional(),
  /** The target's channel card, when the send named a version this context has not seen. */
  channelCard: agentApiChannelCardSchema.optional(),
  /** True when this context saw an older version of `channelCard`. */
  channelCardChanged: optionalBooleanSchema,
  /** A DM target's peer card, when this context has not seen the peer. */
  peerCard: agentApiPeerCardSchema.optional(),
  /** RFC 082: the card stored with the message (a send with `card`; a replay: its revision now). Absent: no card was stored (an older Server ignores `card` and posts the text). */
  messageCard: passthroughObject({ revision: z.number().int().positive() }).optional(),
}));

export const agentApiSendNotFoundResponseSchema = lazySchema("agentApiSendNotFoundResponseSchema", () => passthroughObject({
  ok: z.literal(true),
  state: z.literal("not_found"),
  reconciliation: z.literal(true),
}));

export const agentApiSendCommittedResponseSchema = lazySchema("agentApiSendCommittedResponseSchema", () => passthroughObject({
  ok: z.literal(true),
  state: z.literal("committed"),
  messageId: z.string(),
  messageSeq: optionalNumberSchema,
  reconciliation: z.literal(true),
  receiptComplete: z.literal(false),
  /** RFC 082: the committed message carries a card (its revision now). Absent: no card (a text message, or an older Server). */
  messageCard: passthroughObject({ revision: z.number().int().positive() }).optional(),
}));

export const agentApiSendResponseSchema = lazySchema("agentApiSendResponseSchema", () => z.discriminatedUnion("state", [
  agentApiSendSentResponseSchema,
  agentApiHeldFreshnessResponseSchema,
  agentApiSendNotFoundResponseSchema,
  agentApiSendCommittedResponseSchema,
]));

// Keep the exported request projection independent of Zod so downstream SDK
// declaration bundles do not require consumers to install our validator.
// The passthrough index signature matches the runtime schema's forward-
// compatible treatment of unknown fields.
interface AgentApiSendBodyKnownFields {
  target?: string;
  content?: string;
  attachmentIds?: string[];
  idempotencyKey?: string;
  reconcileOnly?: boolean;
  continue?: boolean;
  sendDraft?: boolean;
  continueAnyway?: boolean;
  draftReholdCount?: number;
  draftReplacedExisting?: boolean;
  seenUpToSeq?: number;
  seenExactSeqs?: number[];
  seenCards?: { channel?: string | null; peer?: string | null };
  freshnessContextMode?: "inline" | "withheld";
}

export interface AgentApiSendBody extends AgentApiSendBodyKnownFields {
  [key: string]: unknown;
}

export interface AgentApiSendV2Body extends AgentApiSendBodyKnownFields {
  mentions?: AgentApiStructuredMention[];
  /**
   * RFC 082: post the message as a card. `content` is then optional: it is the
   * card's fallback (what agents, search and push read), derived from the card
   * when absent; only a `content` the sender wrote mentions anyone.
   */
  card?: MessageCardInput;
  [key: string]: unknown;
}

/**
 * RFC 082 §4.2: the sender replaces the card (and its fallback `content`,
 * derived from the new card when absent). Notifies no one: a mention in the
 * new `content` is not resolved.
 */
export interface AgentApiMessageCardUpdateBody {
  card: MessageCardInput;
  content?: string;
  /** The revision last read; the update is refused (409 `card_revision_conflict`) when the card moved on. */
  expectedRevision?: number;
  /** The same key with the same body answers the first result again; with another body, 409 `idempotency_key_reused`. */
  idempotencyKey?: string;
  [key: string]: unknown;
}

export interface AgentApiMessageCardUpdateResponse {
  ok: true;
  messageId: string;
  revision: number;
  updatedAt: string;
  unnotifiedMentionHandles: string[];
  notice: string;
  [key: string]: unknown;
}

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
    (<Value>() => Value extends Right ? 1 : 2)
    ? (<Value>() => Value extends Right ? 1 : 2) extends
      (<Value>() => Value extends Left ? 1 : 2)
      ? true
      : false
    : false;
type Assert<T extends true> = T;
type _AgentApiSendBodySchemaLockstep = Assert<Equal<
  AgentApiSendBodyKnownFields,
  z.infer<typeof agentApiSendBodyKnownSchema>
>>;

export type LegacyAgentSendBody = z.infer<typeof legacyAgentSendBodySchema>;

// These interfaces intentionally describe the stable projection consumed by
// callers, while the passthrough schemas above remain forward-compatible with
// fields that only some Server versions emit.
export interface AgentApiAttachmentEnvelope {
  id: string;
  filename: string;
  [key: string]: unknown;
}

export interface AgentApiMessageEnvelope {
  seq?: number;
  id?: string;
  message_id?: string;
  timestamp?: string;
  createdAt?: string;
  senderType?: string;
  sender_type?: string;
  senderName?: string;
  sender_name?: string;
  senderDescription?: string | null;
  sender_description?: string | null;
  senderTimezone?: string | null;
  sender_timezone?: string | null;
  /** RFC 077: the personal assistant that sent this as its owner (the sender). */
  delegated_by?: { name: string } | null;
  external_message?: AgentApiExternalMessageProvenance;
  channel_type?: string;
  channel_name?: string;
  parent_channel_type?: string;
  parent_channel_name?: string;
  content?: string;
  attachments?: AgentApiAttachmentEnvelope[];
  taskStatus?: string | null;
  task_status?: string | null;
  taskNumber?: number | null;
  task_number?: number | null;
  taskAssigneeId?: string | null;
  task_assignee_id?: string | null;
  taskAssigneeType?: string | null;
  task_assignee_type?: string | null;
  taskAssigneeName?: string | null;
  task_assignee_name?: string | null;
  /** Task v2: every task hanging under this chat message (servers with task v2 conversations only). */
  source_tasks?: AgentApiMessageSourceTask[];
  /** Task v2: the message is in this task's own conversation (its target is the task ref `#channel:#7`). */
  task_conversation_number?: number;
  threadId?: string | null;
  replyCount?: number | null;
  /** RFC 082: set on a card message; `content` is its fallback text, `message_card.text` the card as markdown. */
  message_card?: AgentMessageCardMarker | null;
  /** The message's reactions, one entry per emoji; empty or absent when it has none. */
  reactions?: AgentApiMessageReaction[];
  [key: string]: unknown;
}

/** Who reacted, as an agent reads it: `external` is someone mirrored from another service (Slack). */
export type AgentApiMessageReactorKind = "human" | "agent" | "external";

export interface AgentApiMessageReactor {
  /** The handle, written without `@`; a display name where there is no handle. */
  name: string;
  kind: AgentApiMessageReactorKind | (string & {});
  [key: string]: unknown;
}

/** One emoji's reactions on a message (agentApiMessageReactionSchema). */
export interface AgentApiMessageReaction {
  emoji: string;
  /** Everyone who reacted with it, however many `reactors` names. */
  count: number;
  /** The first AGENT_API_MESSAGE_REACTION_REACTORS_MAX, in the order they reacted; absent from an older Server. */
  reactors?: AgentApiMessageReactor[];
  [key: string]: unknown;
}

export interface AgentApiMessageSourceTask {
  number: number;
  status: string;
  assignee_type?: string | null;
  assignee_id?: string | null;
  assignee_name?: string | null;
  [key: string]: unknown;
}

export interface AgentApiHeldFreshnessResponse {
  ok?: true;
  state: "held";
  outcome?: "held";
  subtype?: "freshness";
  reason?: string;
  decision?: "local_hold" | "syncing_hold";
  producerFactId?: string;
  available_actions?: string[];
  heldMessages?: AgentApiMessageEnvelope[];
  recentUnread?: AgentApiMessageEnvelope[];
  newMessageCount?: number;
  shownMessageCount?: number;
  omittedMessageCount?: number;
  mentionAnnotation?: { formalMentionCount: number; [key: string]: unknown };
  continueAnywaySuggested?: boolean;
  freshnessContextMode?: "inline" | "withheld";
  withheldMessageCount?: number;
  seenUpToSeq?: number;
  seenUpToMessageId?: string | null;
  /** Lowest seq inside the displayed held window (--before anchor for browsing older). */
  firstShownSeq?: number;
  /** Thread-start anchor for thread targets (freshness-hold digest). */
  threadParentMessage?: {
    seq: number;
    messageId?: string;
    senderName?: string | null;
    createdAt?: string | null;
    content?: string;
  };
  /** Why the send was held (`unread_messages`, `channel_card`, `peer_card`, …); absent means unread messages. */
  holdReasons?: string[];
  /** The target's channel card, when the send named a version this context has not seen. */
  channelCard?: AgentApiChannelCard;
  /** This context saw an older version of `channelCard`. */
  channelCardChanged?: boolean;
  /** A DM target's peer card, when this context has not seen the peer. */
  peerCard?: AgentApiPeerCard;
  [key: string]: unknown;
}

export interface AgentApiSendSentResponse {
  ok: true;
  state: "sent";
  messageId: string;
  messageSeq?: number;
  taskCommandHint?: string;
  recentUnread?: AgentApiMessageEnvelope[];
  pendingMentionActions?: AgentApiMessageEnvelope[];
  unresolvedMentionHandles?: string[];
  /** Handles of the agents this message was delivered to, sorted; [] when none. Absent when not counted (Joint channel, older Server). */
  deliveredToAgents?: string[];
  attention?: {
    driveByJoinedToPost?: {
      reason?: string;
      muteCommand?: string;
      stillArrives?: string[];
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  /** The target's channel card, when the send named a version this context has not seen. */
  channelCard?: AgentApiChannelCard;
  /** This context saw an older version of `channelCard`. */
  channelCardChanged?: boolean;
  /** A DM target's peer card, when this context has not seen the peer. */
  peerCard?: AgentApiPeerCard;
  /** RFC 082: the card stored with the message (a send with `card`; a replay: its revision now). Absent: no card was stored (an older Server ignores `card` and posts the text). */
  messageCard?: { revision: number; [key: string]: unknown };
  [key: string]: unknown;
}

export interface AgentApiSendNotFoundResponse {
  ok: true;
  state: "not_found";
  reconciliation: true;
  [key: string]: unknown;
}

export interface AgentApiSendCommittedResponse {
  ok: true;
  state: "committed";
  messageId: string;
  messageSeq?: number;
  reconciliation: true;
  receiptComplete: false;
  /** RFC 082: the committed message carries a card (its revision now). Absent: no card (a text message, or an older Server). */
  messageCard?: { revision: number; [key: string]: unknown };
  [key: string]: unknown;
}

export type AgentApiSendResponse =
  | AgentApiSendSentResponse
  | AgentApiHeldFreshnessResponse
  | AgentApiSendNotFoundResponse
  | AgentApiSendCommittedResponse;
