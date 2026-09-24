import { z } from "zod";

const optionalStringSchema = z.string().trim().optional();
const optionalStringArraySchema = z.array(z.string().trim().min(1)).optional();
const optionalBooleanSchema = z.boolean().optional();
const optionalNumberSchema = z.number().finite().optional();
const optionalIsoTimestampSchema = z.string().datetime().optional();
const nullableStringSchema = z.string().nullable();

const passthroughObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();

export const agentApiFreshnessContextModeSchema = z.enum(["inline", "withheld"]);

export interface AgentApiStructuredMention {
  type: "user" | "agent";
  id: string;
  name: string;
}

export const agentApiStructuredMentionSchema = z.object({
  type: z.enum(["user", "agent"]),
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(128),
});

const agentApiSendBodyKnownSchema = z.object({
  target: z.string().optional(),
  content: z.string().optional(),
  attachmentIds: optionalStringArraySchema,
  idempotencyKey: optionalStringSchema,
  continue: optionalBooleanSchema,
  sendDraft: optionalBooleanSchema,
  continueAnyway: optionalBooleanSchema,
  draftReholdCount: optionalNumberSchema,
  draftReplacedExisting: optionalBooleanSchema,
  seenUpToSeq: optionalNumberSchema,
  freshnessContextMode: agentApiFreshnessContextModeSchema.optional(),
});

export const agentApiSendBodySchema = agentApiSendBodyKnownSchema.passthrough();

export const agentApiSendV2BodySchema = agentApiSendBodyKnownSchema.extend({
  mentions: z.array(agentApiStructuredMentionSchema).optional(),
}).passthrough();

export const legacyAgentSendBodySchema = agentApiSendBodySchema.extend({
  channel: z.string().optional(),
  dm_to: z.string().optional(),
});

export const agentApiAttachmentEnvelopeSchema = passthroughObject({
  id: z.string(),
  filename: z.string(),
});

export const agentApiTaskCurrentProjectionSchema = passthroughObject({
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
});

const agentApiExternalMessageProvenanceSchema = z.object({
  schema: z.literal("external-message-provenance.v1"),
  provider: z.string().trim().min(1),
  workspace_id: z.string().trim().min(1),
  conversation_id: z.string().trim().min(1),
  message_id: z.string().trim().min(1),
  actor_id: z.string().trim().min(1),
  actor_kind: z.enum(["human", "guest", "remote", "bot", "unknown"]),
  projection_id: z.string().uuid(),
}).strict();

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

export const agentApiMessageEnvelopeSchema = passthroughObject({
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
  external_message: agentApiExternalMessageProvenanceSchema.optional(),
  channel_type: optionalStringSchema,
  channel_name: optionalStringSchema,
  parent_channel_type: optionalStringSchema,
  parent_channel_name: optionalStringSchema,
  content: optionalStringSchema,
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
  threadId: z.string().nullable().optional(),
  replyCount: z.number().int().nonnegative().nullable().optional(),
}).superRefine((value, ctx) => {
  if (!value.external_message) return;
  const senderTypes = [value.senderType, value.sender_type].filter((v): v is string => v !== undefined);
  if (senderTypes.length === 0 || senderTypes.some((v) => v !== "third_party_app")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "external_message requires inert third_party_app sender type", path: ["senderType"] });
  }
  if (value.mentioned !== false) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "external_message must be explicitly non-mentioned", path: ["mentioned"] });
  for (const field of Object.keys(value)) if (isAgentApiExternalMessageForbiddenAuthorityField(field)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `external_message cannot carry ${field} authority`, path: [field] });
  }
});

export const agentApiHeldFreshnessResponseSchema = passthroughObject({
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
});

export const agentApiSendSentResponseSchema = passthroughObject({
  ok: z.literal(true),
  state: z.literal("sent"),
  messageId: z.string(),
  messageSeq: optionalNumberSchema,
  recentUnread: z.array(agentApiMessageEnvelopeSchema).optional(),
  pendingMentionActions: z.array(agentApiMessageEnvelopeSchema).optional(),
  unresolvedMentionHandles: z.array(z.string()).optional(),
  attention: passthroughObject({
    driveByJoinedToPost: passthroughObject({
      reason: optionalStringSchema,
      muteCommand: optionalStringSchema,
      stillArrives: optionalStringArraySchema,
    }).optional(),
  }).optional(),
});

export const agentApiSendResponseSchema = z.discriminatedUnion("state", [
  agentApiSendSentResponseSchema,
  agentApiHeldFreshnessResponseSchema,
]);

// Keep the exported request projection independent of Zod so downstream SDK
// declaration bundles do not require consumers to install our validator.
// The passthrough index signature matches the runtime schema's forward-
// compatible treatment of unknown fields.
interface AgentApiSendBodyKnownFields {
  target?: string;
  content?: string;
  attachmentIds?: string[];
  idempotencyKey?: string;
  continue?: boolean;
  sendDraft?: boolean;
  continueAnyway?: boolean;
  draftReholdCount?: number;
  draftReplacedExisting?: boolean;
  seenUpToSeq?: number;
  freshnessContextMode?: "inline" | "withheld";
}

export interface AgentApiSendBody extends AgentApiSendBodyKnownFields {
  [key: string]: unknown;
}

export interface AgentApiSendV2Body extends AgentApiSendBodyKnownFields {
  mentions?: AgentApiStructuredMention[];
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
  threadId?: string | null;
  replyCount?: number | null;
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
  [key: string]: unknown;
}

export interface AgentApiSendSentResponse {
  ok: true;
  state: "sent";
  messageId: string;
  messageSeq?: number;
  recentUnread?: AgentApiMessageEnvelope[];
  pendingMentionActions?: AgentApiMessageEnvelope[];
  unresolvedMentionHandles?: string[];
  attention?: {
    driveByJoinedToPost?: {
      reason?: string;
      muteCommand?: string;
      stillArrives?: string[];
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type AgentApiSendResponse = AgentApiSendSentResponse | AgentApiHeldFreshnessResponse;
