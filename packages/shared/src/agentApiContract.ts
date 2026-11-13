import { raftbenchFindingsQuerySchema, raftbenchFindingsResponseSchema, type RaftbenchFindingsQuery, type RaftbenchFindingsResponse } from "./raftbenchContract";
import { raftbenchContextQuerySchema, raftbenchContextResponseSchema, raftbenchReportSchema, raftbenchSubmitResponseSchema, type RaftbenchContextQuery, type RaftbenchContextResponse, type RaftbenchReport, type RaftbenchSubmitResponse } from "./raftbenchContract";
import { z } from "zod";
import { lazySchema } from "./lazySchema";
import { agentApiAssistantOwnerArtifactPublishBodySchema, agentApiAssistantOwnerArtifactPublishResponseSchema, agentApiAssistantOwnerArtifactQuerySchema, agentApiAssistantOwnerArtifactResponseSchema, type AgentApiAssistantOwnerArtifactPublishBody, type AgentApiAssistantOwnerArtifactPublishResponse, type AgentApiAssistantOwnerArtifactQuery, type AgentApiAssistantOwnerArtifactResponse } from "./agentApiArtifactsContract";
import { agentApiMigrationRetryResponseSchema, type AgentApiMigrationRetryResponse } from "./agentMigrationRetry";
import { AGENT_WRITE_LANDINGS } from "./agentWriteLanding";

import { AGENT_API_ROUTE_META, type AgentApiAudience, type AgentApiIdempotency, type AgentApiSideEffect } from "./agentApiRouteMeta";
import {
  actionCardActionSchema,
  integrationRegisterAppOperationSchema,
  integrationUpdateAppRegistrationOperationSchema,
} from "./actionCards";
import { ATTENTION_HINT_SCHEMA } from "./attentionDependencyOracle";
import { asChannelId, asMessageId } from "./brandedIds";
import { channelAnnouncementSchema } from "./channelAnnouncement";
import type { ProfileView, TaskResourceReceipt, TaskStatus } from "./index";
import { MAX_KNOWLEDGE_CONTEXT_LENGTH, MIN_KNOWLEDGE_CONTEXT_LENGTH } from "./knowledgeContext";
import { TASK_DESCRIPTION_MAX_LENGTH, TASK_TITLE_MAX_LENGTH } from "./taskPermissions";
import {
  attachmentUploadCapabilitiesSchema,
  attachmentUploadPathParamsSchema,
  attachmentUploadSessionSchema,
  completeAttachmentUploadSessionResponseSchema,
  createAttachmentUploadSessionRequestSchema,
  createAttachmentUploadSessionResponseSchema,
} from "./attachmentUploadContract";
import type { AgentInboxSourceRef } from "./agentInboxApp";
import {
  agentApiRoute as route,
  mergeAppAgentApis,
  type AgentApiBodyOf,
  type AgentApiCapability,
  type AgentApiContractResponse,
  type AgentApiContractRoute,
  type AgentApiMethod,
  type AgentApiParamsOf,
  type AgentApiQueryOf,
  type AgentApiResponseOf,
  type AppAgentApiRoutes,
} from "./agentApiRoute";
import { firstPartyAppAgentApis } from "./apps";
import { IDLE_TASK_REMINDER_ITEM_REASONS, IDLE_TASK_REMINDER_SKIP_REASONS } from "./agentText/idleTaskReminder";
import {
  agentApiFreshnessContextModeSchema,
  agentApiHeldFreshnessResponseSchema,
  agentApiMessageCardUpdateBodySchema,
  agentApiMessageCardUpdateResponseSchema,
  agentApiMessageEnvelopeSchema,
  agentApiSendBodySchema,
  agentApiSendCommittedResponseSchema,
  agentApiSendV2BodySchema,
  agentApiSendResponseSchema,
  agentApiStructuredMentionSchema,
  agentApiTaskCurrentProjectionSchema,
  AGENT_API_EXTERNAL_MESSAGE_FORBIDDEN_AUTHORITY_FIELDS,
  isAgentApiExternalMessageForbiddenAuthorityField,
  type AgentApiHeldFreshnessResponse,
  type AgentApiMessageCardUpdateBody,
  type AgentApiMessageCardUpdateResponse,
  type AgentApiMessageEnvelope,
  type AgentApiSendBody,
  type AgentApiSendV2Body,
  type AgentApiSendResponse,
  agentApiChannelCardSchema,
  agentApiPeerCardSchema,
  type AgentApiChannelCard,
  type AgentApiPeerCard,
} from "./agentApiMessageContract";

export {
  agentApiAttachmentEnvelopeSchema,
  agentApiChannelCardSchema,
  agentApiPeerCardSchema,
  agentApiFreshnessContextModeSchema,
  agentApiHeldFreshnessResponseSchema,
  agentApiMessageCardUpdateBodySchema,
  agentApiMessageCardUpdateResponseSchema,
  agentApiMessageEnvelopeSchema,
  agentApiMessageReactionSchema,
  AGENT_API_MESSAGE_REACTION_REACTORS_MAX,
  agentApiSendBodySchema,
  agentApiSendV2BodySchema,
  agentApiSendResponseSchema,
  agentApiSendSentResponseSchema,
  agentApiStructuredMentionSchema,
  agentApiTaskCurrentProjectionSchema,
  AGENT_API_EXTERNAL_MESSAGE_FORBIDDEN_AUTHORITY_FIELDS,
  isAgentApiExternalMessageForbiddenAuthorityField,
  legacyAgentSendBodySchema,
} from "./agentApiMessageContract";
export {
  AGENT_API_BASE_PATH,
  AGENT_API_MESSAGE_SEND_PATH,
  AGENT_API_MESSAGE_SEND_V2_PATH,
} from "./agentApiPaths";
export { AGENT_API_RATE_LIMITED_CODE, parseAgentApiRateLimitedBody } from "./agentApiRateLimit";
export type { AgentApiRateLimitedBody, AgentApiRateLimitedDetails } from "./agentApiRateLimit";
export { AGENT_API_CLIENT_UPGRADE_REQUIRED_CODE, AGENT_API_CLIENT_UPGRADE_REQUIRED_STATUS, parseAgentApiClientUpgradeRequiredBody } from "./agentApiClientUpgrade";
export type { AgentApiClientUpgradeRequiredBody } from "./agentApiClientUpgrade";
export { agentApiCapabilities, agentApiMethods } from "./agentApiRoute";
export type { AgentApiCapability, AgentApiContractResponse, AgentApiContractRoute, AgentApiMethod } from "./agentApiRoute";
export type {
  AgentApiAttachmentEnvelope,
  AgentApiChannelCard,
  AgentApiPeerCard,
  AgentApiHeldFreshnessResponse,
  AgentApiMessageCardUpdateBody,
  AgentApiMessageCardUpdateResponse,
  AgentApiMessageEnvelope,
  AgentApiMessageReaction,
  AgentApiMessageReactor,
  AgentApiMessageReactorKind,
  AgentApiSendBody,
  AgentApiSendCommittedResponse,
  AgentApiSendV2Body,
  AgentApiSendResponse,
  AgentApiSendSentResponse,
  AgentApiStructuredMention,
  LegacyAgentSendBody,
} from "./agentApiMessageContract";

/**
 * Uniform public failure for agent attachment downloads. The response must not
 * distinguish a missing attachment from one the caller cannot read, or from a
 * UUID that belongs to another subsystem. The next action teaches the input
 * domain without turning this route into a cross-store existence oracle.
 */
export const AGENT_API_ATTACHMENT_DOWNLOAD_UNAVAILABLE_MESSAGE = "Attachment is unavailable.";
export const AGENT_API_ATTACHMENT_DOWNLOAD_UNAVAILABLE_NEXT_ACTION =
  'If this value came from a feedback report, do not use its artifactId here. Use the reportId with the Raft Feedback Admin integration instead: run `raft integration invoke --service "Raft Feedback Admin" --action download_feedback_transcript --param id=REPORT_ID --output PATH`.';
export const AGENT_API_ATTACHMENT_DOWNLOAD_UNAVAILABLE_RESPONSE = {
  // Keep the action in `error` as well as the typed field so older CLI builds,
  // which only project the binary transport's error string, remain useful
  // during a Server-first rollout.
  error: `${AGENT_API_ATTACHMENT_DOWNLOAD_UNAVAILABLE_MESSAGE} ${AGENT_API_ATTACHMENT_DOWNLOAD_UNAVAILABLE_NEXT_ACTION}`,
  code: "ATTACHMENT_UNAVAILABLE",
  suggestedNextAction: AGENT_API_ATTACHMENT_DOWNLOAD_UNAVAILABLE_NEXT_ACTION,
} as const;

/**
 * Lifetime of the presigned URLs the agent attachment routes mint: the
 * download route's 302 target and the download-URL route's `url`.
 */
export const AGENT_API_ATTACHMENT_DOWNLOAD_URL_TTL_SECONDS = 300;

/**
 * The download-URL route's answer (409) when this Server's storage backend
 * cannot presign (local disk): the attachment is readable, but only through
 * the binary download route, which streams it.
 */
export const AGENT_API_ATTACHMENT_DOWNLOAD_URL_UNAVAILABLE_RESPONSE = {
  error: "This Server's file storage cannot mint download URLs.",
  code: "download_url_unavailable",
  suggestedNextAction: "Download the attachment bytes instead: GET /internal/agent-api/attachments/:attachmentId (`raft attachment view --id <attachmentId> --output <path>`).",
} as const;


const optionalStringSchema = lazySchema("optionalStringSchema", () => z.string().trim().optional());
const optionalStringArraySchema = lazySchema("optionalStringArraySchema", () => z.array(z.string().trim().min(1)).optional());
const optionalBooleanSchema = lazySchema("optionalBooleanSchema", () => z.boolean().optional());
const optionalNumberSchema = lazySchema("optionalNumberSchema", () => z.number().finite().optional());
// What the agent's model context has seen of a task's board (glimpse G2): the
// attestation a send carries. A task write without it is never held.
const taskSeenExactSeqsSchema = lazySchema("taskSeenExactSeqsSchema", () => z.array(z.number().int().positive()).max(2_500).optional());

/**
 * What a gated task write attests its model has seen of the conversation its
 * result lands in (agentWriteLanding.ts). `seenFor` names that landing: the
 * Server checks only a boundary attested for the landing it resolves, so a
 * boundary from an older Computer (attested for the board) is not misread.
 * A write without them is not checked.
 */
function taskWriteSeenFields() {
  return {
    seenFor: z.enum(AGENT_WRITE_LANDINGS).optional(),
    seenUpToSeq: optionalNumberSchema,
    seenExactSeqs: taskSeenExactSeqsSchema,
    freshnessContextMode: agentApiFreshnessContextModeSchema.optional(),
  };
}
const nullableStringSchema = lazySchema("nullableStringSchema", () => z.string().nullable());
const nullableNumberSchema = lazySchema("nullableNumberSchema", () => z.number().finite().nullable());
const optionalIsoTimestampSchema = lazySchema("optionalIsoTimestampSchema", () => z.string().datetime().optional());
const agentStatusSchema = lazySchema("agentStatusSchema", () => z.enum(["active", "inactive", "stopped"]));
// `migrated` reaches a client only when it asks (`includeMigrated=true`): older
// CLIs parse this enum strictly and would fail the whole list on it.
const reminderStatusSchema = lazySchema("reminderStatusSchema", () => z.enum(["scheduled", "fired", "canceled", "migrated"]));
const reminderEventTypeSchema = lazySchema("reminderEventTypeSchema", () => z.enum(["scheduled", "fired", "snoozed", "updated", "canceled", "migrated"]));
const reasoningEffortSchema = lazySchema("reasoningEffortSchema", () => z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]));
const profileVisibilityMembershipStatusSchema = lazySchema("profileVisibilityMembershipStatusSchema", () => z.enum(["active", "left", "removed"]));
// The envelope is shared so daemon and Server agree on the HTTP seam. The
// locator payload itself is intentionally `unknown` here: the Server owns an
// independent, closed consumer schema so a producer edit cannot weaken both
// ends of the acceptance boundary.
export const agentApiFeedbackLocatorIngestBodySchema = lazySchema("agentApiFeedbackLocatorIngestBodySchema", () => z.object({
  artifact_kind: z.string().trim().min(1).max(128),
  event_kind: z.string().trim().min(1).max(128),
  payload: z.unknown(),
}).strict());

export const agentApiFeedbackLocatorAcceptanceSchema = lazySchema("agentApiFeedbackLocatorAcceptanceSchema", () => z.object({
  status: z.literal("accepted"),
  receipt_id: z.string().uuid(),
  report_id: z.string().uuid(),
  duplicate: z.boolean(),
}).strict());

export const agentApiFeedbackLocatorListQuerySchema = lazySchema("agentApiFeedbackLocatorListQuerySchema", () => z.object({
  report_id: z.string().uuid().optional(),
  runtime: z.enum(["claude", "codex", "grok", "kimi", "kimi-sdk", "pi", "builtin", "other"]).optional(),
  native_status: z.enum(["reachable", "unreachable", "unsupported", "not_attempted", "lookup_failed"]).optional(),
  native_lookup_method: z.enum([
    "claude_jsonl", "codex_jsonl", "grok_session_jsonl", "kimi_sdk_index",
    "pi_jsonl", "builtin_jsonl", "none", "not_attempted",
  ]).optional(),
  served_exact_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  route_basis: z.enum(["explicit_public_channel", "configured_project_channel"]).optional(),
  limit: z.string().regex(/^([1-9]|[1-9][0-9]|100)$/).optional(),
}).strict());

const agentApiFeedbackLocatorIndexEntrySchema = lazySchema("agentApiFeedbackLocatorIndexEntrySchema", () => z.object({
  report_id: z.string().uuid(),
  receipt_id: z.string().uuid(),
  captured_at: z.string().datetime(),
  runtime: z.string(),
  native_status: z.string(),
  native_lookup_method: z.string(),
  native_locator_kind: z.string(),
  has_served_exact: z.boolean(),
  served_exact_sha256: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
  route_basis: z.enum(["explicit_public_channel", "configured_project_channel"]).nullable(),
  route_target: z.string().nullable(),
}).strict());

export const agentApiFeedbackLocatorListResponseSchema = lazySchema("agentApiFeedbackLocatorListResponseSchema", () => z.object({
  locators: z.array(agentApiFeedbackLocatorIndexEntrySchema),
}).strict());

const passthroughObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();

export const taskStatusSchema = lazySchema("taskStatusSchema", () => z.enum(["backlog", "todo", "in_progress", "in_review", "done", "closed"]));

// Task #178: a managed-runner CLI that will acknowledge leased third-party
// events after writing them out declares it on the /events request. The CLI
// sends it only from the code path that performs the ack, so "declared but
// never acked" cannot occur. Daemons without lease support ignore the header.
export const AGENT_API_EVENTS_ACK_HEADER = "x-raft-events-ack";
export const AGENT_API_EVENTS_ACK_LEASE = "lease";

export const agentApiEventsQuerySchema = lazySchema("agentApiEventsQuerySchema", () => passthroughObject({
  since: optionalStringSchema,
  limit: optionalStringSchema,
  // "cursor": durable inbox rows are acknowledged by the NEXT request's
  // `since` instead of before this response is sent. Omitted = "immediate"
  // (the behavior every published client relies on).
  ack: z.enum(["cursor", "immediate"]).optional(),
  // External agents: `<target_id>:<seq>[,...]` (at most 20), the latest push
  // notice's targets (`channelId`, `latestSeq`). The server waits briefly for
  // its inbox chain to hold them before pulling; still behind, the response
  // carries `retry_after_ms`.
  wait_for: optionalStringSchema,
  // With wait_for: how many times the client already retried for this notice
  // (default 0); the server's `retry_after_ms` backs off from it.
  wait_attempt: optionalStringSchema,
}));

export const agentApiHistoryQuerySchema = lazySchema("agentApiHistoryQuerySchema", () => passthroughObject({
  channel: z.string().trim().min(1),
  before: optionalStringSchema,
  after: optionalStringSchema,
  around: optionalStringSchema,
  limit: optionalStringSchema,
  /**
   * `"false"` reads without consuming: the Server returns the page but does
   * not advance the agent's read cursor, and reports no
   * `model_seen_up_to_seq`. For reads whose output may never reach the model
   * (code a hosted agent wrote). Absent or `"true"` keeps the default.
   */
  consume: z.enum(["true", "false"]).optional(),
  /**
   * `"true"` reads this conversation's unread messages: the page starts right
   * after the agent's read position (the one `raft inbox check` counts unread
   * from) and the read advances it. Cannot be combined with before/after/around.
   * The response echoes `unread_after_seq`; a Server that omits it ignored the
   * flag.
   */
  unread: z.enum(["true", "false"]).optional(),
}));

export const agentApiKnowledgeGetQuerySchema = lazySchema("agentApiKnowledgeGetQuerySchema", () => passthroughObject({
  topic: z.string().trim().min(1),
  // Optional at the transport schema during the staged rollout. The current
  // CLI advertises manual-context-v1 and requires both before sending; the
  // server keeps legacy published clients compatible until the fleet gate.
  intent: z.string().trim().min(MIN_KNOWLEDGE_CONTEXT_LENGTH).max(MAX_KNOWLEDGE_CONTEXT_LENGTH).optional(),
  reason: z.string().trim().min(MIN_KNOWLEDGE_CONTEXT_LENGTH).max(MAX_KNOWLEDGE_CONTEXT_LENGTH).optional(),
  turn_id: optionalStringSchema,
  trace_id: optionalStringSchema,
}));

export const agentApiKnowledgeGetResponseSchema = lazySchema("agentApiKnowledgeGetResponseSchema", () => passthroughObject({
  ok: z.literal(true),
  docId: z.string(),
  topicOrPath: z.string(),
  docVersion: z.string(),
  docState: z.string(),
  contentType: z.string(),
  content: z.string(),
}));

export const agentApiKnowledgeSearchQuerySchema = lazySchema("agentApiKnowledgeSearchQuerySchema", () => passthroughObject({
  query: z.string().trim().min(1),
  scope: optionalStringSchema,
  intent: z.string().trim().min(MIN_KNOWLEDGE_CONTEXT_LENGTH).max(MAX_KNOWLEDGE_CONTEXT_LENGTH).optional(),
  reason: z.string().trim().min(MIN_KNOWLEDGE_CONTEXT_LENGTH).max(MAX_KNOWLEDGE_CONTEXT_LENGTH).optional(),
  turn_id: optionalStringSchema,
  trace_id: optionalStringSchema,
}));

export const agentApiKnowledgeSearchResultSchema = lazySchema("agentApiKnowledgeSearchResultSchema", () => passthroughObject({
  slug: z.string(),
  title: z.string(),
  firstScreen: z.string(),
}));

/** #wg-ax:#15: an agent searching one message's View Context (its own, in v1). Literal, case-insensitive. */
export const agentApiContextSearchBodySchema = lazySchema("agentApiContextSearchBodySchema", () => z.object({
  message_id: z.string().trim().min(8).max(64),
  query: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(50).optional(),
  offset: z.number().int().min(0).optional(),
}));

/** #wg-ax:#15: a window of entries around one entry of one message's View Context. */
export const agentApiContextReadBodySchema = lazySchema("agentApiContextReadBodySchema", () => z.object({
  message_id: z.string().trim().min(8).max(64),
  around: z.string().trim().regex(/^(?:s\d+|t\d+|m\d+\.p\d+)$/),
  limit: z.number().int().min(1).max(21).optional(),
  page: z.number().int().min(1).optional(),
}));

/** The daemon's answer as the Server checked it (`AgentContextQueryAnswerBody`): entries, never a context. */
export const agentApiContextQueryResponseSchema = lazySchema("agentApiContextQueryResponseSchema", () => z.object({
  ok: z.literal(true),
  runtime: z.string(),
  model: z.string().nullable(),
  entryCount: z.number().int(),
  answer: z.record(z.string(), z.unknown()),
}).passthrough());

export const agentApiKnowledgeSearchResponseSchema = lazySchema("agentApiKnowledgeSearchResponseSchema", () => passthroughObject({
  ok: z.literal(true),
  query: z.string(),
  scope: z.string().nullable(),
  results: z.array(agentApiKnowledgeSearchResultSchema),
}));

const agentApiManagedMcpJsonSchema = lazySchema("agentApiManagedMcpJsonSchema", () => z.object({
  type: z.literal("object"),
  properties: z.record(z.string(), z.object({}).passthrough()).optional(),
  required: z.array(z.string()).optional(),
}).passthrough());

const agentApiManagedMcpToolSchema = lazySchema("agentApiManagedMcpToolSchema", () => z.object({
  mcpServerId: z.string().uuid(),
  serverName: z.string(),
  toolName: z.string(),
  runtimeName: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: agentApiManagedMcpJsonSchema,
  annotations: z.object({
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    openWorldHint: z.boolean().optional(),
  }).optional(),
  configVersion: z.number().int().positive(),
  assignmentVersion: z.number().int().positive(),
}));

export const agentApiManagedMcpToolsResponseSchema = lazySchema("agentApiManagedMcpToolsResponseSchema", () => z.object({
  catalogVersion: z.literal(1),
  tools: z.array(agentApiManagedMcpToolSchema),
  /** Connectors the agent would have tools from that need a server admin to reconnect them (no tools). */
  unavailable: z.array(z.object({
    mcpServerId: z.string().uuid(),
    serverName: z.string(),
    status: z.literal("reconnect_required"),
  })).optional(),
}));

export const agentApiManagedMcpCallBodySchema = lazySchema("agentApiManagedMcpCallBodySchema", () => z.object({
  mcpServerId: z.string().uuid(),
  toolName: z.string().trim().min(1),
  arguments: z.record(z.string(), z.unknown()),
  expectedConfigVersion: z.number().int().positive(),
  expectedAssignmentVersion: z.number().int().positive(),
  /**
   * Authenticated origin of the FOREGROUND turn that triggered this call, carried by the runtime.
   *
   * It exists so that when a call is refused for want of an authorized MCP Connection, the server
   * can put the resulting connection card back into the conversation the operator is already
   * looking at -- rather than guessing a creator DM, an admin channel, or broadcasting.
   *
   * ⚠️ Deliberately a MESSAGE id and nothing else. There is no `targetChannelId` here and there
   * must never be one: a caller-supplied channel is a caller-chosen delivery target, which is
   * exactly the misdelivery this field exists to prevent. The server resolves the channel from the
   * message and independently checks it belongs to the same server and to the acting Agent's
   * conversation; an id that does not survive those checks is treated as absent.
   *
   * Optional because background work legitimately has no originating turn. In that case the server
   * records pending authorization and returns `login_required` WITHOUT posting a card -- a later
   * call that does carry a valid foreground origin is what materialises it (@peng).
   */
  origin: z.object({ sourceMessageId: z.string().uuid() }).optional(),
}));

const agentApiManagedMcpResultContentSchema = lazySchema("agentApiManagedMcpResultContentSchema", () => z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
]));

export const agentApiManagedMcpCallResponseSchema = lazySchema("agentApiManagedMcpCallResponseSchema", () => z.object({
  content: z.array(agentApiManagedMcpResultContentSchema),
  isError: z.boolean(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
}));

export const agentApiMessageSearchQuerySchema = lazySchema("agentApiMessageSearchQuerySchema", () => passthroughObject({
  q: optionalStringSchema,
  channel: optionalStringSchema,
  sender: optionalStringSchema,
  senderId: optionalStringSchema,
  sort: z.enum(["relevance", "recent"]).optional(),
  before: optionalStringSchema,
  after: optionalStringSchema,
  limit: optionalStringSchema,
  offset: optionalStringSchema,
  /** A previous page's nextCursor, unchanged (recent-sort text search only). */
  cursor: optionalStringSchema,
}));

export const agentApiMessageResolveParamsSchema = lazySchema("agentApiMessageResolveParamsSchema", () => passthroughObject({
  msgId: z.string().trim().min(1).transform(asMessageId),
}));

export const agentApiMessageReactionParamsSchema = lazySchema("agentApiMessageReactionParamsSchema", () => passthroughObject({
  msgId: z.string().trim().min(1).transform(asMessageId),
}));

/** RFC 082 §4.2: the card message to update, a full id or an 8-character short id. */
export const agentApiMessageCardUpdateParamsSchema = lazySchema("agentApiMessageCardUpdateParamsSchema", () => passthroughObject({
  messageId: z.string().trim().min(1).transform(asMessageId),
}));

export const agentApiMessageReactionBodySchema = lazySchema("agentApiMessageReactionBodySchema", () => passthroughObject({
  emoji: z.string().trim().min(1).max(16).refine((value) => !/\s/.test(value), {
    message: "A single reaction emoji is required",
  }),
}));

export const agentApiChannelMembershipParamsSchema = lazySchema("agentApiChannelMembershipParamsSchema", () => passthroughObject({
  channelId: z.string().trim().min(1).transform(asChannelId),
}));

export const agentApiChannelLifecycleBodySchema = lazySchema("agentApiChannelLifecycleBodySchema", () => passthroughObject({
  target: z.string().trim().min(1),
}));

const agentApiChannelVisibilitySchema = lazySchema("agentApiChannelVisibilitySchema", () => z.enum(["public", "private"]));

/** `POST /channels`: the Server checks the bound agent's createChannels role. */
export const agentApiChannelCreateBodySchema = lazySchema("agentApiChannelCreateBodySchema", () => passthroughObject({
  name: z.string().trim().min(1),
  description: z.string().max(500).optional(),
  visibility: agentApiChannelVisibilitySchema.optional(),
}));

/** `PATCH /channels/:channelId`: any subset; visibility needs changeChannelVisibility. */
export const agentApiChannelUpdateBodySchema = lazySchema("agentApiChannelUpdateBodySchema", () => passthroughObject({
  name: z.string().trim().min(1).optional(),
  description: z.string().max(500).optional(),
  visibility: agentApiChannelVisibilitySchema.optional(),
  /**
   * Channel announcements (`channel_announcement_v0`): the id (`pt_…`) of an
   * Artifact homed in this channel to make its announcement, replacing any
   * other; null removes it. Needs editChannelMetadata, like the name. Older
   * Servers ignore it.
   */
  announcement: z.string().trim().min(1).nullable().optional(),
}));

/** Exactly one member target; the Server rejects zero or several. */
export const agentApiChannelMemberBodySchema = lazySchema("agentApiChannelMemberBodySchema", () => passthroughObject({
  userId: z.string().trim().min(1).optional(),
  agentId: z.string().trim().min(1).optional(),
  user: z.string().trim().min(1).optional(),
  human: z.string().trim().min(1).optional(),
  agent: z.string().trim().min(1).optional(),
}));

/**
 * `deleteIfLast`: the private channel's last member may go, which deletes the
 * channel and all its messages. Without it the Server refuses that removal
 * (409 `last_member_deletes_channel`) and changes nothing, as the web asks a
 * person "Leave and Delete Channel?" first.
 */
const agentApiDeleteIfLastSchema = lazySchema("agentApiDeleteIfLastSchema", () => z.boolean().optional());

/** `POST /channels/:channelId/leave`: no body (an older client) reads as `{}`. */
export const agentApiChannelLeaveBodySchema = lazySchema("agentApiChannelLeaveBodySchema", () => passthroughObject({
  deleteIfLast: agentApiDeleteIfLastSchema,
}));

/** `DELETE /channels/:channelId/members`: one member target, as for adding one, and `deleteIfLast`. */
export const agentApiChannelMemberRemoveBodySchema = lazySchema("agentApiChannelMemberRemoveBodySchema", () => passthroughObject({
  userId: z.string().trim().min(1).optional(),
  agentId: z.string().trim().min(1).optional(),
  user: z.string().trim().min(1).optional(),
  human: z.string().trim().min(1).optional(),
  agent: z.string().trim().min(1).optional(),
  deleteIfLast: agentApiDeleteIfLastSchema,
}));

/** The created or updated channel row (with joint-channel metadata when it has any). */
export const agentApiChannelRowResponseSchema = lazySchema("agentApiChannelRowResponseSchema", () => passthroughObject({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  description: z.string().nullable().optional(),
  /** The channel's announcement after the update, null for none; only while `channel_announcement_v0` is on (absent otherwise and from older Servers). */
  announcement: channelAnnouncementSchema.nullable().optional(),
}));


export const agentApiAttachmentDownloadParamsSchema = lazySchema("agentApiAttachmentDownloadParamsSchema", () => passthroughObject({
  attachmentId: z.string().trim().min(1),
}));

/**
 * Short-lived download URL for an attachment visible to the bound agent
 * credential (`GET /attachments/:attachmentId/url`). For runtimes that cannot
 * take binary tool results: the agent fetches the bytes itself from `url`
 * before `expiresAt`. The URL is a bearer capability; never log it.
 */
export const agentApiAttachmentDownloadUrlResponseSchema = lazySchema("agentApiAttachmentDownloadUrlResponseSchema", () => passthroughObject({
  url: z.string().min(1),
  expiresAt: z.string().datetime(),
  filename: z.string(),
  mimeType: z.string(),
}));

export const agentApiAttachmentCommentsParamsSchema = lazySchema("agentApiAttachmentCommentsParamsSchema", () => passthroughObject({
  attachmentId: z.string().trim().min(1),
}));

export const agentApiAttachmentCommentsQuerySchema = lazySchema("agentApiAttachmentCommentsQuerySchema", () => passthroughObject({
  limit: optionalStringSchema,
}));

const agentApiAttachmentCommentAnchorSchema = lazySchema("agentApiAttachmentCommentAnchorSchema", () => passthroughObject({
  type: z.string().trim().min(1),
  data: z.record(z.string(), z.unknown()),
}));

const agentApiAttachmentCommentReactionSchema = lazySchema("agentApiAttachmentCommentReactionSchema", () => passthroughObject({
  emoji: z.string().trim().min(1),
  reactorType: z.string().trim().min(1),
  reactorId: z.string().trim().min(1),
  createdAt: z.string().datetime(),
}));

const agentApiAttachmentCommentResolvedBySchema = lazySchema("agentApiAttachmentCommentResolvedBySchema", () => passthroughObject({
  reactorId: z.string().trim().min(1),
  reactorType: z.string().trim().min(1),
}));

export const agentApiAttachmentCommentSchema = lazySchema("agentApiAttachmentCommentSchema", () => passthroughObject({
  id: z.string().trim().min(1),
  channelId: z.string().trim().min(1).optional(),
  senderId: z.string().trim().min(1),
  senderType: z.enum(["user", "agent"]),
  senderName: z.string().trim().min(1),
  senderAvatarUrl: nullableStringSchema.optional(),
  senderGravatarHash: nullableStringSchema.optional().describe("Deprecated: always empty; kept for older clients. Raft no longer uses Gravatar."),
  content: z.string(),
  createdAt: z.string().datetime(),
  reactions: z.array(agentApiAttachmentCommentReactionSchema),
  anchor: agentApiAttachmentCommentAnchorSchema.nullable(),
  resolved: z.boolean().optional(),
  resolvedBy: agentApiAttachmentCommentResolvedBySchema.nullable().optional(),
  resolvedAt: z.string().datetime().nullable().optional(),
}));

export const agentApiAttachmentCommentsResponseSchema = lazySchema("agentApiAttachmentCommentsResponseSchema", () => passthroughObject({
  comments: z.array(agentApiAttachmentCommentSchema),
  threadChannelId: nullableStringSchema.optional(),
  viewer: passthroughObject({
    canComment: z.boolean(),
    reason: z.string().optional(),
    canResolve: z.boolean(),
    resolveAction: passthroughObject({
      type: z.string().trim().min(1),
      emoji: z.string().trim().min(1),
    }).optional(),
  }).optional(),
}));

export const agentApiChannelMembersQuerySchema = lazySchema("agentApiChannelMembersQuerySchema", () => passthroughObject({
  channel: z.string().trim().min(1),
}));

export const agentApiResolveChannelBodySchema = lazySchema("agentApiResolveChannelBodySchema", () => passthroughObject({
  target: z.string().trim().min(1),
}));

export const agentApiResolveChannelResponseSchema = lazySchema("agentApiResolveChannelResponseSchema", () => passthroughObject({
  channelId: z.string().trim().min(1),
}));

export const agentApiThreadUnfollowBodySchema = lazySchema("agentApiThreadUnfollowBodySchema", () => passthroughObject({
  thread: z.string().trim().min(1),
  reason: z.string().trim().min(1).max(200).optional(),
}));

export const agentApiThreadFollowBodySchema = lazySchema("agentApiThreadFollowBodySchema", () => passthroughObject({
  thread: z.string().trim().min(1),
}));

export const agentApiThreadFollowResponseSchema = lazySchema("agentApiThreadFollowResponseSchema", () => passthroughObject({
  ok: z.literal(true),
  following: z.literal(true),
  /** False when the agent already followed the thread. */
  changed: z.boolean(),
}));

export const agentApiThreadListItemSchema = lazySchema("agentApiThreadListItemSchema", () => passthroughObject({
  target: z.string().trim().min(1),
  threadChannelId: z.string().uuid(),
  parentChannelRef: z.string().trim().min(1),
  parentMessageId: z.string().uuid(),
  parentMessageShortId: z.string().trim().length(8),
  followedAt: z.string().datetime(),
  reason: z.string().trim().min(1),
  doneAt: z.string().datetime().nullable(),
}));

export const agentApiThreadListResponseSchema = lazySchema("agentApiThreadListResponseSchema", () => passthroughObject({
  threads: z.array(agentApiThreadListItemSchema),
}));

export const AGENT_API_INBOX_VIEWS = ["unread", "mentions"] as const;
export type AgentApiInboxView = (typeof AGENT_API_INBOX_VIEWS)[number];
export const AGENT_API_INBOX_DEFAULT_LIMIT = 20;
export const AGENT_API_INBOX_MAX_LIMIT = 50;

const positiveIntegerStringSchema = lazySchema("positiveIntegerStringSchema", () => z.string().trim().regex(/^[1-9][0-9]*$/, "must be a positive integer"));

export const agentApiInboxListQuerySchema = lazySchema("agentApiInboxListQuerySchema", () => passthroughObject({
  view: z.enum(AGENT_API_INBOX_VIEWS).optional(),
  before_seq: positiveIntegerStringSchema.optional(),
  limit: positiveIntegerStringSchema.optional(),
  /**
   * RFC 081: `true` adds `rows`, `preLaunch` and `omitted` to the response
   * (inbox items: conversations, app items, reminders). Without it the
   * response is the conversation-only list older CLIs read. A server where
   * the inbox items flag is off ignores it (no `rows`).
   */
  items: z.literal("true").optional(),
}));

// RFC 081 inbox items. One row per item `raft inbox check` and the wake-up
// list; the shared formatter renders this row as it is (D16). A row only
// lists: it never carries a body or a command (the formatter derives the
// read and ack commands from `target` and `ack`).

/** `app:<key>/<ref>` (an app item) or `app:<key>` (its fallback item). */
export const AGENT_INBOX_APP_TARGET_PREFIX = "app:";
/** `reminder:<id>`: a reminder item, consumed only by `raft reminder ack`. */
export const AGENT_INBOX_REMINDER_TARGET_PREFIX = "reminder:";
/**
 * An app notice's `object.ref`: what the notice is about (a PR, an Artifact),
 * the key its item groups by. 1-128 chars, letter case kept; starts and ends
 * with a letter or digit, and in between only letters, digits and `_.:/#-`
 * (an Artifact's id is `pt_<uuid>`).
 */
export const AGENT_INBOX_OBJECT_REF_MAX_CHARS = 128;
export const AGENT_INBOX_OBJECT_REF_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_.:/#-]*[A-Za-z0-9])?$/;
/** `inbox check`: at most this many app rows and reminder rows; past them `omitted` counts the rest. */
export const AGENT_INBOX_MAX_APP_ROWS = 50;
export const AGENT_INBOX_MAX_REMINDER_ROWS = 20;
/** `inbox read`: at most this many entries a page (default and max), and this many chars of entry content, but always one entry. */
export const AGENT_INBOX_READ_MAX_ENTRIES = 20;
export const AGENT_INBOX_READ_MAX_CHARS = 8_000;
/** `inbox read`: `remaining` stops counting here (`remainingCapped: true`). */
export const AGENT_INBOX_READ_REMAINING_CAP = 1_000;
/** `inbox dismiss --before`: at most this many items a call; `before` must be at least this long ago. */
export const AGENT_INBOX_DISMISS_MAX_ITEMS = 500;
export const AGENT_INBOX_DISMISS_BEFORE_MIN_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * `inbox dismiss --before`: the next step for a `before` the Server refused
 * (BEFORE_TOO_RECENT) or the CLI could not send. Names the launch-day
 * exception as the refusal's sentence does; the Server and the CLI say it in
 * these same words.
 */
export const AGENT_INBOX_DISMISS_BEFORE_NEXT_ACTION = "Use YYYY-MM-DD or an RFC 3339 time at least 24 hours ago, or the launch date that raft inbox check's pre-launch line names.";

export const AGENT_INBOX_ITEM_KINDS = ["conversation", "app", "app_fallback", "reminder"] as const;
export type AgentInboxItemKind = (typeof AGENT_INBOX_ITEM_KINDS)[number];

/**
 * The refusal codes of `inbox read` and `inbox dismiss` (body
 * `{ error, errorCode, suggestedNextAction? }`). `NOT_FOUND` is one constant
 * body for an unknown target and another agent's alike.
 */
export const AGENT_INBOX_ERROR_CODES = [
  "NOT_FOUND",
  "EXPIRED",
  "AMBIGUOUS_ID",
  "INVALID_TARGET",
  "INVALID_CURSOR",
  "NEEDS_ACK",
  "INVALID_BEFORE",
  "BEFORE_TOO_RECENT",
  "INVALID_ARG",
  /** The server has inbox items switched off (the per-server flag): read with `raft message read`. */
  "INBOX_ITEMS_DISABLED",
] as const;
export type AgentInboxErrorCode = (typeof AGENT_INBOX_ERROR_CODES)[number];

export const agentApiInboxErrorSchema = lazySchema("agentApiInboxErrorSchema", () => passthroughObject({
  error: z.string().min(1),
  errorCode: z.enum(AGENT_INBOX_ERROR_CODES),
  suggestedNextAction: z.string().min(1).optional(),
}));

/** What acks one revision of a reminder item: `raft reminder ack --id <id> --revision <revision>`. */
export const agentApiInboxAckRefSchema = lazySchema("agentApiInboxAckRefSchema", () => z.object({
  app: z.literal("system.reminder"),
  /** The reminder's full id. */
  id: z.string().uuid(),
  revision: z.string().min(1),
}));

/** The app an app item is from: `key` is its OAuth client key, or `system.<id>` for Raft's own; `name` is inert display text. */
export const agentApiInboxAppSchema = lazySchema("agentApiInboxAppSchema", () => z.object({
  key: z.string().min(1),
  name: z.string().min(1),
}));

/** D8: the conversation an app notice names, as the receiving agent addresses it. Checked against the agent's access when listed. */
export const agentApiInboxRelatedSchema = lazySchema("agentApiInboxRelatedSchema", () => z.object({
  target: z.string().min(1),
}));

export const agentApiInboxLatestSenderSchema = lazySchema("agentApiInboxLatestSenderSchema", () => z.object({
  name: z.string(),
  type: z.enum(["user", "agent", "app", "system"]),
}));

export const agentApiInboxItemRowSchema = lazySchema("agentApiInboxItemRowSchema", () => passthroughObject({
  /** `#proj`, `dm:@x`, `#proj:3f4b1fd4`, `#proj:#7`, `app:stamp/pr-13754`, `app:stamp`, `reminder:76d9397d`. */
  target: z.string().min(1),
  kind: z.enum(AGENT_INBOX_ITEM_KINDS),
  // Conversation rows only.
  conversationKind: z.enum(["channel", "dm", "thread", "task"]).optional(),
  /** A task conversation's title. */
  title: z.string().nullable().optional(),
  mentions: z.number().int().nonnegative().optional(),
  lastReadSeq: z.number().int().nonnegative().optional(),
  activitySeq: z.number().int().nonnegative().optional(),
  // App, app fallback and reminder rows.
  app: agentApiInboxAppSchema.optional(),
  /** `kind: "app"` only: the `object.ref` the item groups by. */
  objectRef: z.string().min(1).max(AGENT_INBOX_OBJECT_REF_MAX_CHARS).optional(),
  related: agentApiInboxRelatedSchema.nullable().optional(),
  /** `kind: "reminder"` only: one per fired revision not yet acked, oldest first. */
  ack: z.array(agentApiInboxAckRefSchema).optional(),
  // Every kind.
  /** Conversation: unread messages; app: events not yet read or dismissed; reminder: revisions not yet acked. */
  unread: z.number().int().nonnegative(),
  latestSender: agentApiInboxLatestSenderSchema.nullable(),
  /** First line of the latest message or notice: folded to one line, inert, at most 120 chars. */
  preview: z.string().nullable(),
  /** The preview was cut (the formatter says "truncated preview"). */
  previewTruncated: z.boolean(),
  firstUnreadAt: z.string().datetime().nullable(),
  latestAt: z.string().datetime().nullable(),
  /** Its latest activity is from before inbox items launched (counted in `preLaunch`). Always false for reminders. */
  preLaunch: z.boolean(),
}));

/** `items=true`: conversations from before launch, on every page, with the launch date for `inbox dismiss --before`. */
export const agentApiInboxPreLaunchSchema = lazySchema("agentApiInboxPreLaunchSchema", () => z.object({
  count: z.number().int().nonnegative(),
  /** `YYYY-MM-DD`, the launch date (UTC). */
  before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}));

/** `items=true`: rows past the caps, not listed. */
export const agentApiInboxOmittedSchema = lazySchema("agentApiInboxOmittedSchema", () => z.object({
  app: z.number().int().nonnegative(),
  reminder: z.number().int().nonnegative(),
}));

export const agentApiInboxConversationSchema = lazySchema("agentApiInboxConversationSchema", () => passthroughObject({
  /** Task v2: a task's own conversation is listed by its ref (`#channel:#7`). */
  target: z.string().trim().min(1),
  /** A task conversation stays `thread` here (older CLIs); `conversationKind` says `task`. */
  kind: z.enum(["dm", "channel", "thread"]),
  /** Task v2: `task` for a task's own conversation. */
  conversationKind: z.literal("task").optional(),
  taskNumber: z.number().int().positive().nullable().optional(),
  /** Task v2 (`conversationKind: "task"`): the task's current title. */
  title: z.string().nullable().optional(),
  unread: z.number().int().nonnegative(),
  mentions: z.number().int().nonnegative(),
  lastReadSeq: z.number().int().nonnegative(),
  activitySeq: z.number().int().nonnegative(),
  latestSenderName: z.string().nullable(),
  latestAt: z.string().datetime().nullable(),
}));

export const agentApiInboxListResponseSchema = lazySchema("agentApiInboxListResponseSchema", () => passthroughObject({
  view: z.enum(AGENT_API_INBOX_VIEWS),
  items: z.array(agentApiInboxConversationSchema),
  hasMore: z.boolean(),
  nextBeforeSeq: z.number().int().positive().nullable(),
  totals: passthroughObject({
    conversations: z.number().int().nonnegative(),
    dms: z.number().int().nonnegative(),
    mentions: z.number().int().nonnegative(),
  }),
  /**
   * External agents only, when the page showed unread counts: the turn's
   * unread snapshot, to name in the end-of-turn report (`POST /activity`
   * `turnEnded.snapshotId`).
   */
  snapshotId: z.string().min(1).optional(),
  /**
   * `items=true` only (RFC 081): every item in list order. Page 1 carries
   * every reminder and app row; later pages carry conversation rows only.
   * `items` above stays the conversation-only list.
   */
  rows: z.array(agentApiInboxItemRowSchema).optional(),
  /** `items=true` only: null when nothing predates launch or no launch is set. */
  preLaunch: agentApiInboxPreLaunchSchema.nullable().optional(),
  /** `items=true` only: null when nothing was left out. */
  omitted: agentApiInboxOmittedSchema.nullable().optional(),
  /**
   * `items=true` only, `true` for a personal assistant: `rows` holds app rows
   * only, and its owner DM still arrives through `/events` (turn records and
   * mirroring are written there). The CLI keeps `raft message check` for it.
   */
  appRowsOnly: z.boolean().optional(),
}));

export const agentApiTaskClaimBodySchema = lazySchema("agentApiTaskClaimBodySchema", () => passthroughObject({
  channel: z.string().trim().min(1),
  task_numbers: z.array(z.number().int().positive()).optional(),
  message_ids: optionalStringArraySchema,
  ...taskWriteSeenFields(),
}));

export const agentApiTaskListQuerySchema = lazySchema("agentApiTaskListQuerySchema", () => passthroughObject({
  channel: z.string().trim().min(1).optional(),
  mine: z.literal("true").optional(),
  status: z.union([taskStatusSchema, z.literal("all")]).optional(),
}).superRefine((value, ctx) => {
  const selectors = Number(value.channel !== undefined) + Number(value.mine === "true");
  if (selectors !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "exactly one of channel or mine=true is required",
    });
  }
}));

export const agentApiTaskCreateBodySchema = lazySchema("agentApiTaskCreateBodySchema", () => passthroughObject({
  channel: z.string().trim().min(1),
  tasks: z.array(passthroughObject({
    title: z.string().trim().min(1),
    /** Optional task description (stored as the task's description). */
    description: z.string().optional(),
    creates_resource: z.boolean().optional(),
    /**
     * The chat message this task hangs under (its source: the message that
     * asked for the work): full message id or 8-char short id, resolved in the
     * target channel. Many tasks may share one message. A reply in one of the
     * channel's threads resolves to that thread's root message. Required where
     * task v2 conversations are on (400 `task_source_required` without it);
     * refused where they are off (403 `task_v2_not_enabled`).
     */
    source_message_id: z.string().trim().min(1).optional(),
  })).min(1),
  assignee: z.string().trim().refine(
    (value) => value.startsWith("@") && value.slice(1).trim().length > 0,
    { message: "assignee must be an @handle" },
  ).optional(),
  /**
   * The status every created task starts in: one of `TASK_CREATE_STATUSES`
   * (`backlog`, `todo`, `in_progress`). Omitted: assigning yourself starts the
   * work (`in_progress`), anything else is `todo`. `in_progress` with an
   * assignee starts it for them; without one the task is in progress and
   * unassigned. `in_review`, `done` and `closed` can't be chosen at creation
   * (400 `task_create_status_not_allowed`), nor can `backlog` on a server
   * without task conversations. `todo` with yourself as assignee reserves the
   * task for later without starting it.
   */
  status: taskStatusSchema.optional(),
  /**
   * Freshness (a create with one `source_message_id`, `seenFor:
   * "source_thread"`): what the model has seen of that message's thread, `0`
   * when it never read it. The create is held while the thread has replies the
   * model has not seen (someone else's "📌 created" line or "on it" there
   * means the work may already be taken). Nothing else refuses a message that
   * already has tasks.
   */
  ...taskWriteSeenFields(),
  /**
   * Retry key (same rules as message send's): a repeat with the same key and
   * the same request replays the first response without creating anything;
   * the same key with a different request is refused (409
   * `idempotency_key_reused`). Scoped to the agent and this route, and valid
   * for 24 hours; after that the key is forgotten and is a new request.
   */
  idempotencyKey: optionalStringSchema,
}));

export const agentApiTaskUnclaimBodySchema = lazySchema("agentApiTaskUnclaimBodySchema", () => passthroughObject({
  channel: z.string().trim().min(1),
  task_number: z.number().int().positive(),
  ...taskWriteSeenFields(),
}));

/**
 * Set or clear a task's assignee.
 *
 * `assignee` is a handle (`@name`) rather than an id: agents address people the
 * way they do everywhere else in the CLI, and the server resolves it. `null`
 * clears the assignment — that is the "withdraw an assignment you made to
 * someone else" case, not a separate verb.
 *
 * `expected_revision` is the OCC token. Optional, because an agent acting on a
 * task it just read has nothing to be stale about; supplied when the caller
 * wants to lose rather than clobber.
 */
export const agentApiTaskAssignBodySchema = lazySchema("agentApiTaskAssignBodySchema", () => passthroughObject({
  channel: z.string().trim().min(1),
  task_number: z.number().int().positive(),
  assignee: z.string().trim().min(1).nullable(),
  expected_revision: z.number().int().nonnegative().optional(),
  /**
   * Handing the task to someone else: what it now waits on them for (one
   * line, at most `TASK_ASSIGN_REASON_MAX_LENGTH`). Recorded on the
   * `assignee_changed` event, in the line the assignment writes in the task's
   * conversation and in the assignee's notification. A client that offers a
   * reason sends the key (empty when none was given): an agent handing a task
   * to someone other than itself must then give one (400
   * `task_assign_reason_required`). A request without the key (a CLI from
   * before reasons) is not refused for it. Taking the task yourself or
   * clearing the assignee refuses a non-blank reason (400
   * `task_assign_reason_invalid`).
   */
  reason: z.string().optional(),
  ...taskWriteSeenFields(),
}));

export const agentApiTaskUpdateStatusBodySchema = lazySchema("agentApiTaskUpdateStatusBodySchema", () => passthroughObject({
  channel: z.string().trim().min(1),
  task_number: z.number().int().positive(),
  status: taskStatusSchema,
  /**
   * Moving a task into `backlog`: what would bring it back (optional, one line,
   * at most `TASK_BACKLOG_REASON_MAX_LENGTH`). Recorded on the status event and
   * in the line the move writes in the task's conversation. With any other
   * status a non-blank reason is refused (400 `task_status_reason_invalid`).
   */
  reason: z.string().optional(),
  ...taskWriteSeenFields(),
}));

export const agentApiTaskResourceReceiptSchema = lazySchema("agentApiTaskResourceReceiptSchema", () => passthroughObject({
  object: z.string().trim().min(1),
  purpose: z.string().trim().min(1),
  teardown_owner: z.string().trim().refine(
    (value) => value.startsWith("@") && value.slice(1).trim().length > 0,
    { message: "teardown_owner must be an @agent handle" },
  ),
  security_privacy: z.string().trim().min(1),
  expiry: z.string().datetime(),
  runbook: z.string().trim().min(1),
  tracking: z.string().trim().min(1),
}));

export const agentApiTaskResourceReceiptBodySchema = lazySchema("agentApiTaskResourceReceiptBodySchema", () => passthroughObject({
  channel: z.string().trim().min(1),
  task_number: z.number().int().positive(),
  receipt: agentApiTaskResourceReceiptSchema,
}));

/**
 * Delete a task. Same rule as the browser: creator, or an actor holding
 * `deleteAnyTask` on this server. Agents carry a `serverAgentMembers.role`, so
 * "admin" is a real state for them, not a human-only concept.
 */
export const agentApiTaskDeleteBodySchema = lazySchema("agentApiTaskDeleteBodySchema", () => passthroughObject({
  channel: z.string().trim().min(1),
  task_number: z.number().int().positive(),
}));

/**
 * Convert an existing message into a task WITHOUT claiming it.
 *
 * `taskClaim` already accepts `message_ids` and converts as a side effect, but
 * that path assigns the task to the caller. An agent that is filing work for
 * someone else needs conversion on its own, exactly as the browser's
 * `POST /tasks/convert-message` gives a human.
 */
export const agentApiTaskConvertBodySchema = lazySchema("agentApiTaskConvertBodySchema", () => passthroughObject({
  channel: z.string().trim().min(1),
  message_id: z.string().trim().min(1),
}));

export const agentApiTaskAmendBodySchema = lazySchema("agentApiTaskAmendBodySchema", () => passthroughObject({
  channel: z.string().trim().min(1),
  task_number: z.number().int().positive(),
  title: z.string().trim().min(1).max(TASK_TITLE_MAX_LENGTH).optional(),
  description: z.string().max(TASK_DESCRIPTION_MAX_LENGTH).nullable().optional(),
  ...taskWriteSeenFields(),
}).refine((value) => value.title !== undefined || value.description !== undefined, {
  message: "At least one of title or description is required",
}));

export const agentApiTaskHistoryQuerySchema = lazySchema("agentApiTaskHistoryQuerySchema", () => passthroughObject({
  channel: z.string().trim().min(1),
  task_number: z.coerce.number().int().positive(),
}));

/**
 * Task v2: one task, addressed like every task route by its board (`channel`,
 * the agent's `#channel` / `dm:@peer`) and number. The CLI accepts the task
 * ref `#channel:#7` and splits it into these two.
 */
export const agentApiTaskViewQuerySchema = lazySchema("agentApiTaskViewQuerySchema", () => passthroughObject({
  channel: z.string().trim().min(1),
  task_number: z.coerce.number().int().positive(),
  /** How many of the latest conversation messages to include (default 5, max 20). */
  limit: optionalStringSchema,
}));

/** Task v2: read a task's own conversation; the window flags are `historyRead`'s. */
export const agentApiTaskReadQuerySchema = lazySchema("agentApiTaskReadQuerySchema", () => passthroughObject({
  channel: z.string().trim().min(1),
  task_number: z.coerce.number().int().positive(),
  before: optionalStringSchema,
  after: optionalStringSchema,
  around: optionalStringSchema,
  limit: optionalStringSchema,
  consume: z.enum(["true", "false"]).optional(),
  unread: z.enum(["true", "false"]).optional(),
}));

/**
 * Task v2: reply in a task's own conversation (created on the first reply for
 * a task from before task v2). Same content, attachment, typed-mention,
 * idempotency and reconciliation rules as `messageSendV2`; no freshness hold.
 */
export const agentApiTaskReplyBodySchema = lazySchema("agentApiTaskReplyBodySchema", () => z.object({
  channel: z.string().trim().min(1),
  task_number: z.number().int().positive(),
  content: z.string().optional(),
  attachmentIds: optionalStringArraySchema,
  mentions: z.array(agentApiStructuredMentionSchema).optional(),
  idempotencyKey: optionalStringSchema,
  reconcileOnly: optionalBooleanSchema,
}).passthrough());

/** Task v2: the task conversations the agent follows (`raft task list --following`). */
export const agentApiTaskFollowingQuerySchema = lazySchema("agentApiTaskFollowingQuerySchema", () => passthroughObject({}));

/** Task v2: follow / unfollow a task's own conversation. */
export const agentApiTaskFollowBodySchema = lazySchema("agentApiTaskFollowBodySchema", () => passthroughObject({
  channel: z.string().trim().min(1),
  task_number: z.number().int().positive(),
}));

export const agentApiTaskUnfollowBodySchema = lazySchema("agentApiTaskUnfollowBodySchema", () => passthroughObject({
  channel: z.string().trim().min(1),
  task_number: z.number().int().positive(),
  /** Short reason shown in the task conversation's unfollow line. */
  reason: z.string().trim().min(1).max(200).optional(),
}));

export const agentApiReminderListQuerySchema = lazySchema("agentApiReminderListQuerySchema", () => passthroughObject({
  status: optionalStringSchema,
  all: optionalStringSchema,
  /** "true": also list reminders moved to the Reminder App (status `migrated`). */
  includeMigrated: optionalStringSchema,
}));

export const agentApiReminderParamsSchema = lazySchema("agentApiReminderParamsSchema", () => passthroughObject({
  reminderId: z.string().trim().min(1),
}));

export const agentApiReminderScheduleBodySchema = lazySchema("agentApiReminderScheduleBodySchema", () => passthroughObject({
  title: z.string(),
  fireAt: optionalStringSchema,
  delaySeconds: optionalNumberSchema,
  msgId: z.string().nullable().optional(),
  payload: z.unknown().optional(),
  repeat: optionalStringSchema,
  tz: optionalStringSchema,
  channel: optionalStringSchema,
}));

export const agentApiReminderSnoozeBodySchema = lazySchema("agentApiReminderSnoozeBodySchema", () => passthroughObject({
  delaySeconds: z.number().finite(),
}));

export const agentApiReminderUpdateBodySchema = lazySchema("agentApiReminderUpdateBodySchema", () => passthroughObject({
  fireAt: optionalStringSchema,
  delaySeconds: optionalNumberSchema,
  repeat: optionalStringSchema,
  title: optionalStringSchema,
  tz: optionalStringSchema,
}));

export const agentApiInboxSourceRefSchema = lazySchema("agentApiInboxSourceRefSchema", () => z.object({
  kind: z.string().trim().min(1),
  id: z.string().trim().min(1),
  revision: z.string().trim().min(1).optional(),
}).strict() satisfies z.ZodType<AgentInboxSourceRef>);

export const agentApiAppSourceAckBodySchema = lazySchema("agentApiAppSourceAckBodySchema", () => passthroughObject({
  itemId: z.string().trim().min(1),
  appId: z.string().trim().min(1),
  notificationClass: z.string().trim().min(1),
  sourceRef: agentApiInboxSourceRefSchema,
  ackAttemptId: z.string().uuid(),
}));

export const agentApiProfileShowQuerySchema = lazySchema("agentApiProfileShowQuerySchema", () => passthroughObject({
  target: optionalStringSchema,
}));

export const agentApiProfileUpdateBodySchema = lazySchema("agentApiProfileUpdateBodySchema", () => passthroughObject({
  avatarUrl: optionalStringSchema,
  displayName: optionalStringSchema,
  description: optionalStringSchema,
}));

const agentApiProfileCreatedAgentSchema = lazySchema("agentApiProfileCreatedAgentSchema", () => passthroughObject({
  id: z.string(),
  name: z.string(),
  displayName: nullableStringSchema,
  avatarUrl: nullableStringSchema,
  runtime: z.string(),
  status: agentStatusSchema,
}));

const agentApiProfileCreatorSchema = lazySchema("agentApiProfileCreatorSchema", () => z.union([
  passthroughObject({
    type: z.literal("human"),
    id: z.string(),
    name: z.string(),
    displayName: nullableStringSchema,
    avatarUrl: nullableStringSchema,
    gravatarHash: z.string().describe("Deprecated: always empty; kept for older clients. Raft no longer uses Gravatar."),
  }),
  passthroughObject({
    type: z.literal("agent"),
    id: z.string(),
    name: z.string(),
    displayName: nullableStringSchema,
    avatarUrl: nullableStringSchema,
    deletedAt: nullableStringSchema,
  }),
]));

export const agentApiProfileViewSchema: z.ZodType<ProfileView> = lazySchema("agentApiProfileViewSchema", () => z.discriminatedUnion("kind", [
  passthroughObject({
    kind: z.literal("human"),
    id: z.string(),
    isSelf: z.boolean(),
    name: z.string(),
    displayName: nullableStringSchema,
    description: nullableStringSchema,
    avatarUrl: nullableStringSchema,
    email: nullableStringSchema,
    role: z.enum(["owner", "admin", "member", "guest"]).nullable(),
    joinedAt: nullableStringSchema,
    membershipStatus: profileVisibilityMembershipStatusSchema,
    createdAgents: z.array(agentApiProfileCreatedAgentSchema),
  }),
  passthroughObject({
    kind: z.literal("agent"),
    id: z.string(),
    isSelf: z.boolean(),
    name: z.string(),
    displayName: nullableStringSchema,
    description: nullableStringSchema,
    avatarUrl: nullableStringSchema,
    status: agentStatusSchema,
    serverRole: z.enum(["owner", "admin", "member"]).nullable(),
    runtime: z.string(),
    model: z.string(),
    reasoningEffort: reasoningEffortSchema.nullable(),
    executionMode: nullableStringSchema,
    computerId: nullableStringSchema,
    computerName: nullableStringSchema,
    computerHostname: nullableStringSchema,
    daemonVersion: nullableStringSchema,
    creator: agentApiProfileCreatorSchema.nullable(),
    createdAgents: z.array(agentApiProfileCreatedAgentSchema),
    createdAt: z.string(),
    deletedAt: nullableStringSchema,
  }),
]));

export const agentApiIntegrationTokenBodySchema = lazySchema("agentApiIntegrationTokenBodySchema", () => z.object({
  service: z.string().trim().regex(/^[a-z][a-z0-9-]{2,63}$/),
}).strict());
export const agentApiIntegrationTokenResponseSchema = lazySchema("agentApiIntegrationTokenResponseSchema", () => z.object({
  access_token: z.string().min(1),
  token_type: z.literal("Bearer"),
  audience: z.string().min(1),
  expires_in: z.literal(300),
  expires_at: z.string(),
}).strict());

export const agentApiIntegrationLoginBodySchema = lazySchema("agentApiIntegrationLoginBodySchema", () => passthroughObject({
  service: z.string().trim().min(1),
  scopes: optionalStringArraySchema,
  target: optionalStringSchema,
  agentHandoffChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
  resumeRequestId: z.string().uuid().optional(),
}));

export const agentApiIntegrationMarketplaceQuerySchema = lazySchema("agentApiIntegrationMarketplaceQuerySchema", () => passthroughObject({
  query: z.string().trim().max(200).optional(),
  limit: optionalStringSchema,
}));

const agentApiIntegrationAppPrepareCommonBodyShape = {
  target: z.string().trim().min(1),
  name: optionalStringSchema,
  description: optionalStringSchema,
  category: z.string().trim().min(1).optional(),
  homepageUrl: optionalStringSchema,
  returnUrl: optionalStringSchema,
  agentManifestUrl: optionalStringSchema,
  setupUrl: optionalStringSchema,
  setupDescription: optionalStringSchema,
  scopes: optionalStringArraySchema,
  unsafeDemoUrlOverride: optionalBooleanSchema,
  draftHint: optionalStringSchema,
};

export const agentApiIntegrationAppPrepareBodySchema = lazySchema("agentApiIntegrationAppPrepareBodySchema", () => z.discriminatedUnion("mode", [
  passthroughObject({
    mode: z.literal("register"),
    ...agentApiIntegrationAppPrepareCommonBodyShape,
    clientKey: optionalStringSchema,
  }),
  passthroughObject({
    mode: z.literal("update"),
    ...agentApiIntegrationAppPrepareCommonBodyShape,
    clientKey: z.string().trim().min(1),
  }),
]));

export const agentApiIntegrationAppRotateSecretBodySchema = lazySchema("agentApiIntegrationAppRotateSecretBodySchema", () => passthroughObject({
  clientKey: z.string().trim().min(1),
}));

export const agentApiIntegrationAppTransferOwnerBodySchema = lazySchema("agentApiIntegrationAppTransferOwnerBodySchema", () => passthroughObject({
  clientKey: z.string().trim().min(1),
  targetAgent: z.string().trim().min(1),
}));

export const agentApiIntegrationAppUpdateBodySchema = lazySchema("agentApiIntegrationAppUpdateBodySchema", () => passthroughObject({
  clientKey: z.string().trim().min(1),
  /** A new client id for an unpublished app (RFC 084); `clientKey` names the app, by any of its ids. */
  newClientKey: z.string().trim().min(1).optional(),
  name: optionalStringSchema,
  description: optionalStringSchema,
  // task #319: agent-facing "when to use this app" hint; nullable, at most
  // 160 code points, single line, no control characters, no bare @scope/pkg.
  whenToUse: optionalStringSchema,
  category: z.string().trim().min(1).optional(),
  homepageUrl: optionalStringSchema,
  returnUrl: optionalStringSchema,
  agentManifestUrl: optionalStringSchema,
  setupUrl: optionalStringSchema,
  setupDescription: optionalStringSchema,
  scopes: optionalStringArraySchema,
  unsafeDemoUrlOverride: optionalBooleanSchema,
}));

export const agentApiIntegrationAppManageBodySchema = lazySchema("agentApiIntegrationAppManageBodySchema", () => passthroughObject({
  clientKey: z.string().trim().min(1),
  action: z.enum([
    "share_link_get",
    "share_link_create",
    "share_link_revoke",
    "request_publish",
    "request_unpublish",
    "clear_logo",
    "delete",
  ]),
  expiresInDays: z.number().int().positive().max(365).optional(),
  /**
   * The slug of the one Server a share link installs on: required by
   * share_link_create; on share_link_revoke it picks that target's link
   * (without it, every active link is revoked). Every other action refuses it
   * (400 SHARE_LINK_TARGET_NOT_APPLICABLE). Raft never says whether the slug
   * names a Server.
   */
  targetServerSlug: optionalStringSchema,
}));

export const agentApiIntegrationAppStatusQuerySchema = lazySchema("agentApiIntegrationAppStatusQuerySchema", () => passthroughObject({
  card: optionalStringSchema,
  client: optionalStringSchema,
}));

/** Any card with a `type`, its fields as sent: the fallback of a prepare body's `action`. */
export const agentApiActionCardWireSchema = lazySchema("agentApiActionCardWireSchema", () => passthroughObject({
  type: z.string().trim().min(1),
}));

export const agentApiActionPrepareBodySchema = lazySchema("agentApiActionPrepareBodySchema", () => passthroughObject({
  target: z.string().trim().min(1),
  /**
   * The card: one of the known cards (described here for clients and
   * generators; a valid one gets its defaults), else any card with a `type`.
   * The Server checks the card (actionCardsService.prepareActionCard), so a
   * client never refuses a card type or field it doesn't know (a Computer's
   * CLI does not update itself; the agent learns the types from the Server's
   * manual). Only an action without a `type` fails here.
   */
  action: z.union([actionCardActionSchema, agentApiActionCardWireSchema]),
  /**
   * Retry key (same rules as message send's): a repeat with the same key and
   * the same request replays the first response (same card messageId)
   * without preparing another card; the same key with a different request is
   * refused (409 `idempotency_key_reused`). Scoped to the agent and this
   * route, and valid for 24 hours; after that the key is forgotten.
   */
  idempotencyKey: optionalStringSchema,
}));

export const agentApiServerUpdateBodySchema = lazySchema("agentApiServerUpdateBodySchema", () => passthroughObject({
  name: z.string().trim().min(1).max(100).optional(),
  hideHumansFromMembers: z.boolean().optional(),
}));

/** Server Labs as the bound agent sees them (`GET /labs`); `version` guards writes. */
export const agentApiServerLabsResponseSchema = lazySchema("agentApiServerLabsResponseSchema", () => passthroughObject({
  serverId: z.string(),
  accessEnabled: z.boolean(),
  version: z.number().int().nonnegative(),
  canManageAccess: z.boolean(),
  canManageEnrollments: z.boolean(),
  labs: z.array(passthroughObject({
    labKey: z.string(),
    name: z.string(),
    description: z.string(),
    state: z.string(),
    enrolled: z.boolean(),
    effective: z.boolean(),
    updatedAt: z.string().nullable(),
  })),
}));

/** Labs writes carry the version the caller read; a stale one is a 409. */
export const agentApiServerLabsMutationBodySchema = lazySchema("agentApiServerLabsMutationBodySchema", () => passthroughObject({
  enabled: z.boolean(),
  expectedVersion: z.number().int().nonnegative(),
}));

export const agentApiServerLabParamsSchema = lazySchema("agentApiServerLabParamsSchema", () => passthroughObject({
  labKey: z.string().trim().min(1),
}));

export const agentApiServerLabsMutationResponseSchema = lazySchema("agentApiServerLabsMutationResponseSchema", () => agentApiServerLabsResponseSchema.extend({
  applied: z.boolean(),
  auditEventId: z.string().nullable(),
}));

export const agentApiServerUpdateResponseSchema = lazySchema("agentApiServerUpdateResponseSchema", () => passthroughObject({
  id: z.string(),
  name: z.string(),
  hideHumansFromMembers: z.boolean().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
}));

/**
 * One action a personal assistant may take as its owner (assistantOf.ownerActions).
 * `tier` is "direct" or "confirm" today, but a plain string: a new tier on a
 * newer Server must not fail an older client's whole context read. A client
 * that doesn't recognise a `tier` value leaves that tool out. Raft enforces
 * the tier itself: a confirm action never runs without the owner's confirmation.
 */
export const agentApiAssistantOwnerActionSchema = lazySchema("agentApiAssistantOwnerActionSchema", () => passthroughObject({
  tool: z.string(),
  tier: z.string(),
  description: z.string(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string(),
  params: z.array(passthroughObject({
    name: z.string(),
    kind: z.string(),
    description: z.string(),
    values: z.array(z.string()).optional(),
  })),
  mapping: z.array(passthroughObject({
    param: z.string(),
    into: z.string(),
    field: z.string().optional(),
  })),
  // Body keys the entry needs; set where two entries share one route (the body picks the entry).
  requiredFields: z.array(z.string()).optional(),
}));
export type AgentApiAssistantOwnerAction = z.infer<typeof agentApiAssistantOwnerActionSchema>;

const OWNER_ACTIONS_DESCRIPTION = "What this personal assistant may do as its owner, on the owner's own web routes: one tool each, with its tier (direct or confirm), parameters and how they map onto the route. A client that doesn't recognise a `tier` value leaves that tool out. Raft enforces the tier itself: a confirm action never runs without the owner's confirmation.";

export const agentApiAgentContextResponseSchema = lazySchema("agentApiAgentContextResponseSchema", () => passthroughObject({
  agent: passthroughObject({
    id: z.string(),
    name: z.string(),
    displayName: z.string().nullable(),
    description: z.string().nullable(),
    runtime: z.string(),
    external: z.boolean(),
    // RFC 074 §2: set when this agent is someone's personal assistant (the
    // assistant-only reads exist for it); null otherwise. Optional for older
    // Servers. Says nothing about whether the feature is on for the server.
    // A plain string: an odd id must not fail the whole context read.
    // RFC 075 v4 adds the owner's IANA zone (null when unknown) and the DM
    // target the assistant sends proactive notes to (null until it exists).
    assistantOf: passthroughObject({
      userId: z.string(),
      // The owner's handle and display name (null when unset). Optional for older Servers.
      name: z.string().nullable().optional(),
      displayName: z.string().nullable().optional(),
      // RFC 077 step 2: Raft runs the checks and the brief; the runtime turns its own off. Absent on older Servers.
      raftCheck: z.boolean().optional(),
      timezone: z.string().nullable().optional(),
      // The language to talk to the owner in (null when unset). Absent on older Servers.
      language: z.string().nullable().optional(),
      dmTarget: z.string().nullable().optional(),
      // #proj-assistant:#19: what it may do as its owner on the owner's own web
      // routes, and how to call each (the SDK's assistant.ownerActions). Absent on older Servers.
      // A client that doesn't recognise a `tier` value leaves that tool out; Raft enforces the tier itself.
      ownerActions: z.array(agentApiAssistantOwnerActionSchema).optional().describe(OWNER_ACTIONS_DESCRIPTION),
    }).nullable().optional(),
    // Live server role (owner/admin/member/guest); null if not a member.
    // Optional for older Servers. A plain string, like assistantOf's id.
    serverRole: z.string().nullable().optional(),
    // Tool discovery only; absent means unavailable. Reads still check live authority.
    raftbenchReader: z.literal(true).optional(),
  }),
  server: passthroughObject({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
  }),
  credential: passthroughObject({
    capabilities: z.array(z.string()),
  }),
  // The self-hosted-runner guide rendered for this agent by the same builder
  // the daemon uses (`buildRaftCliGuideMarkdown`). Null for managed agents:
  // their standing prompt comes from the daemon that runs them.
  prompt: passthroughObject({
    audience: z.literal("self-hosted-runner"),
    text: z.string(),
  }).nullable(),
  // Server rollout flags that change how an agent should work, the same
  // values a managed agent's Computer receives at start (AgentConfig
  // reminderApp / vaultApp). Optional for older Servers; absent means off.
  features: passthroughObject({
    reminderApp: z.boolean(),
    vaultApp: z.boolean(),
    /** `task_v2_conversations_v0` (AgentConfig.taskConversations); absent on older Servers. */
    taskConversations: z.boolean().optional(),
    /**
     * `continuations_pilot_v0`: a held `raft message send` asks instead of
     * saving a draft. Present (true) only while on; absent when off and on
     * older Servers. Not in AgentConfig: the CLI reads it here when a send is
     * held, so it applies without an agent restart.
     */
    continuationsPilot: z.boolean().optional(),
    /**
     * Ids of the first-party apps on for this Server (AgentConfig.enabledApps),
     * e.g. `artifacts`. Not the Reminder or Vault app (installed integrations;
     * reminderApp / vaultApp). For a personal assistant, only the apps its
     * credential can reach (none today). Absent on older Servers.
     */
    enabledApps: z.array(z.string()).optional(),
  }).optional(),
}));

export const agentApiServerInfoChannelSchema = lazySchema("agentApiServerInfoChannelSchema", () => passthroughObject({
  id: z.string().transform(asChannelId),
  name: z.string(),
  joined: z.boolean(),
  /**
   * When a person or an agent last posted there, thread replies included
   * (system messages and app events do not count); null: nobody has posted.
   * Minute precision. Absent when unknown (older Servers, or before the
   * one-time backfill has run).
   */
  lastPostAt: z.string().nullable().optional(),
  /**
   * The channel's announcement (an Artifact homed in it), null for none.
   * Only while `channel_announcement_v0` is on for the Server: absent when
   * off and from older Servers.
   */
  announcement: channelAnnouncementSchema.nullable().optional(),
}));

export const agentApiServerInfoAgentSchema = lazySchema("agentApiServerInfoAgentSchema", () => passthroughObject({
  name: z.string(),
  status: z.string().optional(),
  activity: z.string().nullable().optional(),
  activityDetail: z.string().nullable().optional(),
  role: z.enum(["owner", "admin", "member"]).nullable().optional(),
}));

export const agentApiServerInfoHumanSchema = lazySchema("agentApiServerInfoHumanSchema", () => passthroughObject({
  name: z.string(),
  role: z.enum(["owner", "admin", "member", "guest"]).nullable().optional(),
}));

export const agentApiServerInfoResponseSchema = lazySchema("agentApiServerInfoResponseSchema", () => passthroughObject({
  runtimeContext: passthroughObject({
    agentId: z.string(),
    runtime: z.string().optional(),
    model: z.string().optional(),
    reasoningEffort: reasoningEffortSchema.nullable().optional(),
    serverId: z.string(),
    machineId: z.string().nullable().optional(),
    machineName: z.string().nullable().optional(),
    machineDescription: z.string().nullable().optional(),
    machineHostname: z.string().nullable().optional(),
    machineOs: z.string().nullable().optional(),
    daemonVersion: z.string().nullable().optional(),
    workspacePath: z.string().nullable().optional(),
  }),
  serverRole: z.string().nullable().optional(),
  serverCapabilities: passthroughObject({}).optional(),
  channels: z.array(agentApiServerInfoChannelSchema),
  /**
   * How many archived channels the agent can see (public ones, and private /
   * joint ones it can access) that `channels` leaves out. Absent from older
   * Servers.
   */
  archivedChannelCount: z.number().int().nonnegative().optional(),
  /**
   * Those archived channels (read-only: history can be read, nothing new can
   * be posted), each row `archived: true`. Only when asked for with
   * `archived=include`; absent otherwise and from older Servers.
   */
  archivedChannels: z.array(agentApiServerInfoChannelSchema).optional(),
  agents: z.array(agentApiServerInfoAgentSchema),
  humans: z.array(agentApiServerInfoHumanSchema),
}));

export const agentApiServerInfoQuerySchema = lazySchema("agentApiServerInfoQuerySchema", () => passthroughObject({
  /** `include`: also return `archivedChannels`. */
  archived: z.enum(["include"]).optional(),
}));

export const AGENT_API_USER_CHANNELS_DEFAULT_LIMIT = 50;
export const AGENT_API_USER_CHANNELS_MAX_LIMIT = 200;

const nonNegativeIntegerStringSchema = lazySchema("nonNegativeIntegerStringSchema", () => z.string().trim().regex(/^(0|[1-9][0-9]*)$/, "must be a non-negative integer"));

export const agentApiUserChannelsParamsSchema = lazySchema("agentApiUserChannelsParamsSchema", () => passthroughObject({
  name: z.string().trim().min(1),
}));

export const agentApiUserChannelsQuerySchema = lazySchema("agentApiUserChannelsQuerySchema", () => passthroughObject({
  offset: nonNegativeIntegerStringSchema.optional(),
  // 1..AGENT_API_USER_CHANNELS_MAX_LIMIT (200), as a pattern so the description carries the cap.
  limit: z.string().trim().regex(/^([1-9]|[1-9][0-9]|1[0-9][0-9]|200)$/, "must be an integer from 1 to 200").optional(),
}));

const agentApiUserChannelsPageFields = {
  // The window's channels whose roster lists the user: each channel's own
  // facts (its `serverInfo` channel fields) plus the user's membership
  // (`joined: true`, and the user's `channelRole` where channel roles exist),
  // none of the caller's role, capability, or attention fields.
  memberships: z.array(agentApiServerInfoChannelSchema),
  // Window channels whose roster check the Server would refuse (`channelMembers`
  // 404). Built-in app conversations are inspected (no one is a member), not unchecked.
  uncheckedCount: z.number().int().nonnegative(),
  page: passthroughObject({
    // Every channel visible to the caller (`serverInfo` channels), not memberships.
    total: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
  }),
};

/**
 * One user's visible facts and their memberships among one window of the
 * caller's visible channels (`GET /users/:name/channels`). `user` is the
 * user's `serverInfo` agents / humans entry, unchanged.
 */
export const agentApiUserChannelsResponseSchema = lazySchema("agentApiUserChannelsResponseSchema", () => z.discriminatedUnion("kind", [
  passthroughObject({ user: agentApiServerInfoAgentSchema, kind: z.literal("agent"), ...agentApiUserChannelsPageFields }),
  passthroughObject({ user: agentApiServerInfoHumanSchema, kind: z.literal("human"), ...agentApiUserChannelsPageFields }),
]));

/** No visible agent or human has this exact name (`404`). */
export const AGENT_API_USER_NOT_FOUND_CODE = "user_not_found";

export const agentApiMentionActionsPendingQuerySchema = lazySchema("agentApiMentionActionsPendingQuerySchema", () => passthroughObject({
  limit: optionalStringSchema,
}));

export const agentApiMentionActionEnvelopeSchema = lazySchema("agentApiMentionActionEnvelopeSchema", () => passthroughObject({
  resolutionId: z.string(),
}));

export const agentApiMentionActionResultSchema = lazySchema("agentApiMentionActionResultSchema", () => passthroughObject({
  resolutionId: z.string(),
  status: z.enum([
    "queued",
    "delivered",
    "dropped",
    "stale",
    "expired",
    "no_permission",
    "not_found",
    "ambiguous",
  ]),
  action: z.enum(["notify", "add"]).optional(),
  reason: optionalStringSchema,
  messageId: optionalStringSchema,
  channelId: optionalStringSchema,
  targetType: z.enum(["user", "agent"]).optional(),
  targetId: optionalStringSchema,
  dedupedResolutionIds: optionalStringArraySchema,
}));

export const agentApiMentionActionsPendingResponseSchema = lazySchema("agentApiMentionActionsPendingResponseSchema", () => passthroughObject({
  pendingMentionActions: z.array(agentApiMentionActionEnvelopeSchema),
  has_more: z.boolean().optional(),
}));

/**
 * task #153 — the author's per-target delivery view. Field set is the ruled
 * allowlist (@Tenny `4a6a06b8`): outcome + a category coarse enough to act on,
 * and nothing that explains why the seat broke.
 */
/**
 * Single source for the ruled closed sets. Server projection and CLI rendering
 * both import these rather than restating them — a hand-copied closed set is
 * exactly the drift hazard task #154 exists to remove, and writing a second copy
 * here while reporting that hazard would have been the same mistake twice.
 */
export const SENDER_MENTION_DELIVERY_OUTCOMES = ["delivered", "pending", "lost", "unknown"] as const;
export type SenderMentionDeliveryOutcome = (typeof SENDER_MENTION_DELIVERY_OUTCOMES)[number];

export const SENDER_MENTION_DELIVERY_REASON_CATEGORIES = ["quota", "runtime_error", "not_launched", "unclassified"] as const;
export type SenderMentionDeliveryReasonCategory = (typeof SENDER_MENTION_DELIVERY_REASON_CATEGORIES)[number];

/**
 * @Stone finding 2: the boundary must fail closed on the SHAPE, not only the
 * producer. An optional `reasonCategory` on every outcome lets "field absent"
 * carry meaning again — the exact defect the ruling removed — if a bad response
 * ever reaches a client. So the row is discriminated on `outcome`:
 *   lost                       ⇒ category REQUIRED
 *   delivered | pending | unknown ⇒ category FORBIDDEN (not merely omitted)
 * `strict()` rather than passthrough on the non-lost arm is what makes
 * "forbidden" real; passthrough would silently accept a stray category.
 */
export const agentApiSenderMentionDeliveryRowSchema = lazySchema("agentApiSenderMentionDeliveryRowSchema", () => z.discriminatedUnion("outcome", [
  z.object({
    targetHandle: z.string(),
    outcome: z.literal("lost"),
    reasonCategory: z.enum(SENDER_MENTION_DELIVERY_REASON_CATEGORIES),
  }).strict(),
  ...SENDER_MENTION_DELIVERY_OUTCOMES
    .filter((outcome): outcome is Exclude<SenderMentionDeliveryOutcome, "lost"> => outcome !== "lost")
    .map((outcome) => z.object({
      targetHandle: z.string(),
      outcome: z.literal(outcome),
    }).strict()),
]));

export const agentApiSenderMentionDeliveriesParamsSchema = lazySchema("agentApiSenderMentionDeliveriesParamsSchema", () => passthroughObject({
  messageId: z.string().trim().min(1),
}));

export const agentApiSenderMentionDeliveriesResponseSchema = lazySchema("agentApiSenderMentionDeliveriesResponseSchema", () => passthroughObject({
  messageId: z.string(),
  deliveries: z.array(agentApiSenderMentionDeliveryRowSchema),
}));

export const agentApiMentionActionsExecuteBodySchema = lazySchema("agentApiMentionActionsExecuteBodySchema", () => passthroughObject({
  action: z.enum(["notify", "add"]),
  resolutionIds: optionalStringArraySchema,
  ids: optionalStringArraySchema,
}));

export const agentApiMentionActionsExecuteResponseSchema = lazySchema("agentApiMentionActionsExecuteResponseSchema", () => passthroughObject({
  ok: z.literal(true),
  action: z.enum(["notify", "add"]),
  results: z.array(agentApiMentionActionResultSchema),
}));

const appSetupStateSchema = lazySchema("appSetupStateSchema", () => z.object({
  status: z.enum(["not_required", "pending", "complete"]),
  url: z.string().nullable(),
  description: z.string().nullable(),
  revision: z.number().int().positive(),
  completedAt: z.string().nullable(),
}));

const agentApiIntegrationServiceSchema = lazySchema("agentApiIntegrationServiceSchema", () => passthroughObject({
  id: z.string(),
  clientId: z.string(),
  appType: z.enum(["server_local", "slock_builtin", "third_party_global"]).optional(),
  name: z.string(),
  setupUrl: nullableStringSchema.optional(),
  setupDescription: nullableStringSchema.optional(),
  setup: appSetupStateSchema.nullable().optional(),
  description: nullableStringSchema,
  whenToUse: nullableStringSchema.optional(),
  homepageUrl: nullableStringSchema,
  returnUrl: nullableStringSchema,
  agentManifestUrl: nullableStringSchema,
  agentManifestUrlSource: z.enum(["explicit", "well_known"]).nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  official: z.boolean().default(false),
  purpose: z.string().default(""),
}));

const agentApiActiveIntegrationLoginSchema = lazySchema("agentApiActiveIntegrationLoginSchema", () => passthroughObject({
  id: z.string(),
  serviceId: z.string(),
  clientId: z.string(),
  appType: z.enum(["server_local", "slock_builtin", "third_party_global"]).optional(),
  name: z.string(),
  description: nullableStringSchema,
  homepageUrl: nullableStringSchema,
  returnUrl: nullableStringSchema,
  agentManifestUrl: nullableStringSchema,
  agentManifestUrlSource: z.enum(["explicit", "well_known"]).nullable().optional(),
  scopes: z.array(z.string()),
  createdAt: z.string(),
}));

/**
 * An MCP App of this Server, next to the Agent Login services in `raft integration list`. MCP Apps
 * and Agent Login Apps are all Raft Apps, of different types: an MCP App is used through the MCP tools
 * it gives the Agent's runtime, never through Agent Login or `raft integration invoke`.
 *
 * `grant` is whether this Agent has the App (`granted`: automatically or by a person; `revoked`;
 * `not_granted`); absent from servers older than it, where every listed App was granted. `state` is
 * the App's Connection state for this Agent (the call path's admission rule): `ready`,
 * `login_required` / `authorization_expired` (a person must sign it in), or `disabled` (switched off
 * on this Server). `raft integration login --service <App> --target <conversation>` asks a person
 * there for whatever is missing (grant and/or Connection) with the App's Connect card.
 */
export const agentApiIntegrationMcpAppSchema = lazySchema("agentApiIntegrationMcpAppSchema", () => passthroughObject({
  type: z.literal("mcp"),
  id: z.string(),
  name: z.string(),
  description: nullableStringSchema,
  homepageUrl: nullableStringSchema,
  state: z.enum(["ready", "login_required", "authorization_expired", "disabled"]),
  access: z.literal("mcp_tools"),
  toolCount: z.number().int().nonnegative(),
  toolNames: z.array(z.string()),
  grant: z.enum(["granted", "revoked", "not_granted"]).optional(),
}));

export const agentApiIntegrationListQuerySchema = lazySchema("agentApiIntegrationListQuerySchema", () => passthroughObject({
  /** A `--service` value: the server answers which service it names, in `resolvedServiceId`. */
  service: z.string().trim().min(1).optional(),
}));

export const agentApiIntegrationListResponseSchema = lazySchema("agentApiIntegrationListResponseSchema", () => passthroughObject({
  services: z.array(agentApiIntegrationServiceSchema),
  activeLogins: z.array(agentApiActiveIntegrationLoginSchema),
  /**
   * Added for MCP Apps; absent from older servers. A separate array, not rows in `services`, so an
   * older CLI (which renders every `services` row as an Agent Login service with a login hint, and
   * whose `appType` enum has no MCP value) ignores it instead of misreading it.
   */
  mcpApps: z.array(agentApiIntegrationMcpAppSchema).optional(),
  /**
   * The id of the service the `service` query named (current id, old id or name; an old id wins
   * over a name), null when it names none. Absent without that query, from a server older than
   * RFC 084, and for an ambiguous name: the CLI and SDK then match the names themselves.
   */
  resolvedServiceId: z.string().nullable().optional(),
}));

const agentApiMarketplaceIntegrationAppSchema = lazySchema("agentApiMarketplaceIntegrationAppSchema", () => passthroughObject({
  id: z.string(),
  clientId: z.string(),
  name: z.string(),
  setupUrl: nullableStringSchema.optional(),
  setupDescription: nullableStringSchema.optional(),
  setup: appSetupStateSchema.nullable().optional(),
  description: nullableStringSchema,
  category: z.string(),
  dataAccessSummary: nullableStringSchema,
  homepageUrl: nullableStringSchema,
  agentManifestUrl: nullableStringSchema,
  agentManifestUrlSource: z.enum(["explicit", "well_known"]).nullable(),
  allowedScopes: z.array(z.string()),
  logoUrl: nullableStringSchema,
  installedOnServer: z.boolean(),
  updatedAt: z.string(),
  official: z.boolean().default(false),
  purpose: z.string().default(""),
}));

export const agentApiIntegrationMarketplaceResponseSchema = lazySchema("agentApiIntegrationMarketplaceResponseSchema", () => passthroughObject({
  surface: z.literal("public_marketplace"),
  metadataTrust: z.literal("untrusted_app_supplied"),
  query: nullableStringSchema,
  limit: z.number().int().min(1).max(50),
  apps: z.array(agentApiMarketplaceIntegrationAppSchema),
}));

export const agentApiIntegrationLoginResponseSchema = lazySchema("agentApiIntegrationLoginResponseSchema", () => passthroughObject({
  status: z.enum(["logged_in", "already_logged_in", "approval_required", "install_required"]),
  // Optional for older Servers; keep future strings for the CLI to reject
  // explicitly instead of interpreting an unknown protocol as legacy.
  agentHandoffProtocol: z.string().optional(),
  nextAction: z.literal("install_from_marketplace").optional(),
  service: agentApiIntegrationServiceSchema,
  scopes: z.array(z.string()),
  requestId: z.string().optional(),
  session: passthroughObject({
    status: z.literal("stored"),
    source: z.enum(["cache", "fresh"]),
    path: nullableStringSchema,
  }).optional(),
  approval: passthroughObject({
    requestId: z.string(),
    target: nullableStringSchema,
    actionCardMessageId: nullableStringSchema,
  }).optional(),
  installation: passthroughObject({
    serverSlug: z.string(),
    serverName: z.string(),
    marketplaceUrl: z.string(),
    target: nullableStringSchema,
    actionCardMessageId: nullableStringSchema,
  }).optional(),
}));

export const agentApiIntegrationAppPrepareResponseSchema = lazySchema("agentApiIntegrationAppPrepareResponseSchema", () => passthroughObject({
  status: z.literal("prepared"),
  mode: z.enum(["register", "update"]),
  target: z.string(),
  actionCardMessageId: z.string(),
  action: z.discriminatedUnion("type", [
    integrationRegisterAppOperationSchema,
    integrationUpdateAppRegistrationOperationSchema,
  ]),
}));

export const agentApiIntegrationAppRotateSecretResponseSchema = lazySchema("agentApiIntegrationAppRotateSecretResponseSchema", () => passthroughObject({
  clientId: z.string(),
  clientKey: z.string(),
  clientName: z.string(),
  clientSecret: z.string(),
}));

export const agentApiIntegrationAppTransferOwnerResponseSchema = lazySchema("agentApiIntegrationAppTransferOwnerResponseSchema", () => passthroughObject({
  clientId: z.string(),
  clientKey: z.string(),
  clientName: z.string(),
  ownerAgentId: z.string(),
  ownerAgentName: z.string(),
  ownershipOutcome: z.enum(["transferred", "already_owner"]),
  auditEventId: z.string().uuid(),
}));

export const agentApiIntegrationAppUpdateResponseSchema = lazySchema("agentApiIntegrationAppUpdateResponseSchema", () => passthroughObject({
  clientId: z.string(),
  clientKey: z.string(),
  clientName: z.string(),
  updatedFields: z.array(z.string()),
}));

const agentApiIntegrationAppShareLinkSchema = lazySchema("agentApiIntegrationAppShareLinkSchema", () => passthroughObject({
  id: z.string(),
  /** The target Server's slug as it was typed; absent from older servers. */
  targetServerSlug: nullableStringSchema.optional(),
  expiresAt: nullableStringSchema,
  revokedAt: nullableStringSchema,
  /** When an install redeemed the link; absent from older servers. */
  consumedAt: nullableStringSchema.optional(),
  lastUsedAt: nullableStringSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
}));

export const agentApiIntegrationAppManageResponseSchema = lazySchema("agentApiIntegrationAppManageResponseSchema", () => passthroughObject({
  action: agentApiIntegrationAppManageBodySchema.shape.action,
  clientId: z.string(),
  clientKey: z.string(),
  clientName: z.string(),
  publishStatus: nullableStringSchema.optional(),
  logoUrl: nullableStringSchema.optional(),
  shareUrl: nullableStringSchema.optional(),
  /** share_link_create: the new link; share_link_get / share_link_revoke: the newest of `links`. */
  link: agentApiIntegrationAppShareLinkSchema.nullable().optional(),
  /** share_link_get: every active link, one per target; share_link_revoke: what it revoked. */
  links: z.array(agentApiIntegrationAppShareLinkSchema).optional(),
}));

export const agentApiIntegrationAppLogoResponseSchema = lazySchema("agentApiIntegrationAppLogoResponseSchema", () => passthroughObject({
  clientId: z.string(),
  clientKey: z.string(),
  clientName: z.string(),
  logoUrl: z.string(),
}));

// Unlike the general forward-compatible agent API envelopes, this owner-state
// projection is deliberately closed: unknown server fields must be stripped
// before CLI JSON/text rendering so a future DB-shaped response cannot expose
// secret/hash/token or internal-owner fields by accident.
export const agentApiOwnedIntegrationAppSchema = lazySchema("agentApiOwnedIntegrationAppSchema", () => z.object({
  state: z.enum(["card_pending", "committed"]),
  card: nullableStringSchema,
  installationId: z.string().uuid().nullable().optional(),
  name: z.string(),
  setupUrl: nullableStringSchema.optional(),
  setupDescription: nullableStringSchema.optional(),
  setup: appSetupStateSchema.nullable().optional(),
  clientKey: nullableStringSchema,
  createdAt: z.string(),
  updatedAt: nullableStringSchema.optional(),
  description: nullableStringSchema.optional(),
  homepageUrl: nullableStringSchema.optional(),
  callbackUrl: nullableStringSchema,
  agentManifestUrl: nullableStringSchema.optional(),
  scopes: z.array(z.string()),
  category: nullableStringSchema,
  dataAccessSummary: nullableStringSchema.optional(),
  logoUrl: nullableStringSchema.optional(),
  appType: nullableStringSchema.optional(),
  publishStatus: nullableStringSchema.optional(),
  enabled: z.boolean().nullable().optional(),
  authority: z.enum(["owner", "admin"]).nullable().optional(),
  recoveryCommand: nullableStringSchema,
}));

export const agentApiIntegrationAppListResponseSchema = lazySchema("agentApiIntegrationAppListResponseSchema", () => z.object({
  apps: z.array(agentApiOwnedIntegrationAppSchema),
}));

export const agentApiIntegrationAppStatusResponseSchema = lazySchema("agentApiIntegrationAppStatusResponseSchema", () => z.object({
  app: agentApiOwnedIntegrationAppSchema,
}));

export const agentApiAttachmentUploadResponseSchema = lazySchema("agentApiAttachmentUploadResponseSchema", () => passthroughObject({
  id: z.string().trim().min(1),
  filename: z.string(),
  mimeType: nullableStringSchema,
  sizeBytes: z.number().int().nonnegative(),
  thumbnailUrl: nullableStringSchema,
}));

/* external message contract is defined in agentApiMessageContract.ts */
/*
  schema: z.literal("external-message-provenance.v1"),
  provider: z.string().trim().min(1),
  workspace_id: z.string().trim().min(1),
  conversation_id: z.string().trim().min(1),
  message_id: z.string().trim().min(1),
  actor_id: z.string().trim().min(1),
  actor_kind: z.enum(["human", "guest", "remote", "bot", "unknown"]),
  projection_id: z.string().uuid(),
}).strict();

export const AGENT_API_EXTERNAL_MESSAGE_FORBIDDEN_AUTHORITY_FIELDS = [
  "agentSendKey",
  "agent_send_key",
  "searchText",
  "search_text",
  "searchVector",
  "search_vector",
  "externalAuthor",
  "external_author",
  "mentions",
  "actionMetadata",
  "action_metadata",
  "taskId",
  "task_id",
  "taskStatus",
  "task_status",
  "taskNumber",
  "task_number",
  "taskAssigneeId",
  "task_assignee_id",
  "taskAssigneeType",
  "task_assignee_type",
  "taskAssigneeName",
  "task_assignee_name",
  "taskClaimedAt",
  "task_claimed_at",
  "taskCompletedAt",
  "task_completed_at",
  "taskClaimedById",
  "task_claimed_by_id",
  "taskClaimedByType",
  "task_claimed_by_type",
  "taskClaimedByName",
  "task_claimed_by_name",
  "claimedById",
  "claimed_by_id",
  "claimedByType",
  "claimed_by_type",
  "claimedByName",
  "claimed_by_name",
  "claimedAt",
  "claimed_at",
  "completedAt",
  "completed_at",
] as const;

const AGENT_API_EXTERNAL_MESSAGE_FORBIDDEN_AUTHORITY_FIELD_SET = new Set<string>(
  AGENT_API_EXTERNAL_MESSAGE_FORBIDDEN_AUTHORITY_FIELDS,
);
const AGENT_API_EXTERNAL_MESSAGE_TASK_LIFECYCLE_FIELD = /^(?:task|claimed|completed)(?:_|[A-Z])/;

//
 * External Agent envelopes are deliberately closed against both today's
 * message/task projections and future task lifecycle aliases. The prefix
 * guard prevents a newly-added task field from silently becoming authority
 * merely because it has not yet been added to the explicit compatibility
 * alias list above.
//
export function isAgentApiExternalMessageForbiddenAuthorityField(field: string): boolean {
  return AGENT_API_EXTERNAL_MESSAGE_FORBIDDEN_AUTHORITY_FIELD_SET.has(field)
    || AGENT_API_EXTERNAL_MESSAGE_TASK_LIFECYCLE_FIELD.test(field);
}

const agentApiTaskCurrentProjectionSchema = passthroughObject({
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
  senderTimezone: z.string().nullable().optional(),
  sender_timezone: z.string().nullable().optional(),
  delegated_by: z.object({ name: z.string() }).passthrough().nullable().optional(),
  external_message: agentApiExternalMessageProvenanceSchema.optional(),
  mentioned: optionalBooleanSchema,
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
  let hasSenderAlias = false;
  for (const [field, senderType] of [
    ["senderType", value.senderType],
    ["sender_type", value.sender_type],
  ] as const) {
    if (senderType === undefined) continue;
    hasSenderAlias = true;
    if (senderType === "third_party_app") continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "external_message requires inert third_party_app sender type",
      path: [field],
    });
  }
  if (!hasSenderAlias) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "external_message requires inert third_party_app sender type",
      path: ["senderType"],
    });
  }
  if (typeof value.mentioned !== "boolean") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "external_message must carry an explicit mentioned boolean",
      path: ["mentioned"],
    });
  } else if (value.mentioned && value.external_message.provider !== "slack") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "non-Slack external_message must be explicitly non-mentioned",
      path: ["mentioned"],
    });
  }
  for (const field of Object.keys(value)) {
    if (!isAgentApiExternalMessageForbiddenAuthorityField(field)) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `external_message cannot carry ${field} authority`,
      path: [field],
    });
  }
});
*/
export const agentApiEventsInboxHintSchema = lazySchema("agentApiEventsInboxHintSchema", () => z.object({
  unread_conversations: z.number().int().nonnegative(),
  command: z.literal("raft inbox check"),
}));

export const agentApiEventsResponseSchema = lazySchema("agentApiEventsResponseSchema", () => passthroughObject({
  events: z.array(agentApiMessageEnvelopeSchema),
  last_seen_msgId: nullableStringSchema,
  last_seen_seq: nullableNumberSchema,
  reply_target: nullableStringSchema,
  // Deprecated placeholders: always `[]` / `null`, read by no client. Kept in
  // the response only because published CLIs/SDKs before this change parse
  // them as required; optional here so the server can drop them later.
  pending_notice_ids: z.array(z.string()).optional(),
  wake_reason: z.string().nullable().optional(),
  has_more: z.boolean(),
  // External agents: conversations still unread beyond this bounded batch,
  // present while any remain. Optional so older servers stay valid.
  inbox_hint: agentApiEventsInboxHintSchema.nullable().optional(),
  // How this batch is acknowledged: "cursor" = on the next request whose
  // `since` covers it; "immediate" = already acknowledged. Absent on older servers.
  ack_mode: z.enum(["cursor", "immediate"]).optional(),
  // wait_for only: a pair the inbox chain had not caught up to yet (has_more
  // is true too); ask again with the same wait_for and wait_attempt + 1
  // after this many ms (1000 * 2^wait_attempt, at most 8000).
  retry_after_ms: z.number().int().positive().optional(),
  // Task #178: managed runners may also receive `third_party_lease` here. It is
  // injected by the daemon proxy (see `AgentApiEventsResponse`), never by the
  // server, so it stays out of this server-router manifest and rides on the
  // passthrough.
}));

// Authenticated history projection only. This is not a general target alias:
// consumers may reconcile legacy DM queue metadata only for exact returned IDs.
export const agentApiHistoryConsumptionScopeSchema = lazySchema("agentApiHistoryConsumptionScopeSchema", () => z.object({
  agent_id: z.string().uuid(),
  channel_id: z.string().uuid(),
  channel_type: z.enum(["dm", "thread"]),
  target: z.string().min(1),
}));
export type AgentApiHistoryConsumptionScope = z.infer<typeof agentApiHistoryConsumptionScopeSchema>;

export const agentApiHistoryResponseSchema = lazySchema("agentApiHistoryResponseSchema", () => passthroughObject({
  // Canonical target resolved by the server. Optional for older servers; the
  // CLI falls back to the requested target and stays fail-closed rather than
  // trying to reconstruct identity from message-rendering fields.
  target: z.string().min(1).optional(),
  consumption_scope: agentApiHistoryConsumptionScopeSchema.optional(),
  /** Task v2: the read named a task conversation; newer CLIs read it with `raft task read <ref>`. */
  taskCommandHint: optionalStringSchema,
  messages: z.array(agentApiMessageEnvelopeSchema),
  has_more: z.boolean(),
  has_older: z.boolean(),
  has_newer: z.boolean(),
  last_read_seq: nullableNumberSchema.optional(),
  model_seen_up_to_seq: nullableNumberSchema.optional(),
  /**
   * The read reached the start of the plan's history window and older
   * messages exist behind it (Free keeps 30 days); `historyLimitMessage` says
   * so in words the CLI prints in the window header. Absent otherwise.
   */
  historyLimited: z.boolean().optional(),
  historyLimitMessage: optionalStringSchema,
  /** Present only for `unread=true`: the read position the page started after. */
  unread_after_seq: nullableNumberSchema.optional(),
  /**
   * Present only for `unread=true`: the read position after this read. Below
   * the page's newest seq when the newest rows are too recent to settle (seq
   * order is not commit order). The Server moves the read position over them a
   * few seconds later (readPositionSettle.ts); they come again on the next
   * unread read only if it comes sooner or a lower seq committed late.
   */
  read_through_seq: nullableNumberSchema.optional(),
  /**
   * The card of the channel this read is in (for a thread, its parent
   * channel): what `raft channel info` shows about it, for the passive-AX
   * channel resource (`channelCardRev`). Absent for DMs, agent events and
   * older servers.
   */
  channel_card: agentApiChannelCardSchema.optional(),
  /** The other side of a DM (or of a thread in one); absent otherwise and on older servers. */
  peer_card: agentApiPeerCardSchema.optional(),
}));

// RFC 081 `inbox read` / `inbox dismiss` (after the history read schemas the read reuses).
export const agentApiInboxReadBodySchema = lazySchema("agentApiInboxReadBodySchema", () => passthroughObject({
  /** An item's target as `inbox check` lists it, or `agent-event:<id>`. */
  target: z.string().trim().min(1).max(512),
  /** Only for a reminder item longer than one page (`nextCursor` of the page before). */
  cursor: z.string().trim().min(1).max(256).optional(),
  limit: z.number().int().min(1).max(AGENT_INBOX_READ_MAX_ENTRIES).optional(),
}));

/**
 * One entry of an `inbox read` page: a message, an app event, or a reminder revision (with its `ack`).
 *
 * The envelope extended, never `.and(...)`: an intersection throws
 * `Unmergable intersection` (an Error, not an issue, so `safeParse` throws
 * too) whenever one side changes a value the other passes through, which a
 * trimmed string does for any text with a blank at either end.
 *
 * `content` is trimmed at both ends here, unlike the envelope's: CLIs up to
 * 1.0.69 parse this response with that intersection and fail on a body that
 * still starts with a blank, after the Server has marked it read. Take the
 * override out (the envelope's rule then applies) once 1.0.69 is below the
 * supported Computer floor.
 */
export const agentApiInboxReadEntrySchema = lazySchema("agentApiInboxReadEntrySchema", () => agentApiMessageEnvelopeSchema.safeExtend({
  content: optionalStringSchema,
  ack: agentApiInboxAckRefSchema.optional(),
}));

export const agentApiInboxReadResponseSchema = lazySchema("agentApiInboxReadResponseSchema", () => passthroughObject({
  /** The item's canonical target. */
  target: z.string().min(1),
  /** `event`: a single `agent-event:<id>`. */
  kind: z.enum([...AGENT_INBOX_ITEM_KINDS, "event"]),
  /** Oldest first. Empty for an item read to the end already (re-read with `raft message read`). */
  entries: z.array(agentApiInboxReadEntrySchema),
  /** Unread when this read started. */
  unreadBefore: z.number().int().nonnegative(),
  /** Unread left after this read (`remainingCapped`: at least this many). */
  remaining: z.number().int().nonnegative(),
  remainingCapped: z.boolean(),
  /** Everything was given out: the item leaves `inbox check` and wake-ups. Always false for a reminder. */
  consumed: z.boolean(),
  /** Reminders only, when there are more revisions than one page: pass it as `cursor`. A consuming kind's next page is the same read again. */
  nextCursor: z.string().min(1).nullable(),
  app: agentApiInboxAppSchema.optional(),
  related: agentApiInboxRelatedSchema.nullable().optional(),
  /** Reminders: every revision not yet acked (each entry also carries its own). */
  ack: z.array(agentApiInboxAckRefSchema).optional(),
  // Conversations: the history read's fields.
  last_read_seq: nullableNumberSchema.optional(),
  read_through_seq: nullableNumberSchema.optional(),
  consumption_scope: agentApiHistoryConsumptionScopeSchema.optional(),
  historyLimited: z.boolean().optional(),
  historyLimitMessage: optionalStringSchema,
  channel_card: agentApiChannelCardSchema.optional(),
  peer_card: agentApiPeerCardSchema.optional(),
}));

/** Exactly one of `target` or `before`; the server refuses both or neither (400 `INVALID_ARG`). */
export const agentApiInboxDismissBodySchema = lazySchema("agentApiInboxDismissBodySchema", () => passthroughObject({
  target: z.string().trim().min(1).max(512).optional(),
  /** `YYYY-MM-DD` (00:00 UTC) or an RFC 3339 time with `Z` or an offset; at least 24 h ago. */
  before: z.string().trim().min(1).max(64).optional(),
}));

export const agentApiInboxDismissResponseSchema = lazySchema("agentApiInboxDismissResponseSchema", () => passthroughObject({
  /** Items dismissed (conversations + app items). 0 when there was nothing unread. */
  dismissed: z.number().int().nonnegative(),
  conversations: z.number().int().nonnegative(),
  appItems: z.number().int().nonnegative(),
  /** Reminder items `--before` left alone (they need an ack). */
  skippedNeedsAck: z.number().int().nonnegative(),
  /** The earliest activity among what was dismissed. */
  earliestActivityAt: z.string().datetime().nullable(),
  /** `--before`: items past this call's cap, still listed; run it again. */
  remaining: z.number().int().nonnegative(),
}));

// RFC 074 §2 personal assistant (v0). The assistant calls with its own
// credential; the Server answers as the assistant's owner (DMs too unless the
// owner turned that off, RFC 077; never the assistant's own DM). Refused
// with 403 `assistant_not_enabled` unless the bound agent is a live assistant
// whose owner is still a member and `personal_assistant` is on for the server.
// `untold`: unread and not yet told to the owner (by seq, as Raft's check
// decides it; a skip is not a telling), with an authoritative `total`.
export const AGENT_API_ASSISTANT_INBOX_FILTERS = ["all", "unread", "mentions", "unread_mentions", "untold"] as const;
export const AGENT_API_ASSISTANT_INBOX_DEFAULT_LIMIT = 20;
export const AGENT_API_ASSISTANT_INBOX_MAX_LIMIT = 50;
export const AGENT_API_ASSISTANT_MESSAGES_DEFAULT_LIMIT = 50;
export const AGENT_API_ASSISTANT_MESSAGES_MAX_LIMIT = 100;

export const agentApiAssistantOwnerInboxQuerySchema = lazySchema("agentApiAssistantOwnerInboxQuerySchema", () => passthroughObject({
  filter: z.enum(AGENT_API_ASSISTANT_INBOX_FILTERS).optional(),
  limit: positiveIntegerStringSchema.optional(),
  offset: z.string().trim().regex(/^(0|[1-9][0-9]*)$/, "must be a non-negative integer").optional(),
}));

export const agentApiAssistantOwnerInboxItemSchema = lazySchema("agentApiAssistantOwnerInboxItemSchema", () => passthroughObject({
  kind: z.enum(["channel", "thread"]),
  /** Pass to `assistantOwnerMessages` as `channelId` (a thread's own channel id for threads). */
  channelId: z.string().uuid(),
  /** The channel's name; for a thread, its parent channel's name. */
  channelName: z.string(),
  channelType: z.string(),
  /** Threads only: the channel and message the thread hangs off. */
  parentChannelId: z.string().uuid().nullable(),
  parentMessageId: z.string().uuid().nullable(),
  unread: z.number().int().nonnegative(),
  hasMention: z.boolean(),
  latestAt: z.string().nullable(),
  latestSenderName: z.string().nullable(),
  /** Who sent the latest message: their id and `human` / `agent` / `third_party_app` / `system`. Absent on older servers. */
  latestSenderId: z.string().nullable().optional(),
  latestSenderType: z.string().nullable().optional(),
  latestPreview: z.string().nullable(),
  /** Seq of the conversation's latest message (thread: latest reply); compare with a doorbell's `sources[].max_seq`. Absent on older servers. */
  latestSeq: z.number().int().nullable().optional(),
  firstUnreadMessageId: z.string().uuid().nullable(),
  /** Threads only: the owner wrote in this thread (a reply, or the message it hangs off). Absent on older servers. */
  ownerParticipated: z.boolean().optional(),
  /** A DM, or a thread in one: the other side, from the owner's side (`type`: human / agent). Null otherwise; absent on older servers. */
  peer: passthroughObject({ id: z.string(), type: z.string() }).nullable().optional(),
  /** The owner was told about this conversation up to its latest message (by seq; a skip is not a telling). Absent on older servers. */
  told: z.boolean().optional(),
}));

export const agentApiAssistantOwnerInboxResponseSchema = lazySchema("agentApiAssistantOwnerInboxResponseSchema", () => passthroughObject({
  owner: passthroughObject({ userId: z.string().uuid() }),
  filter: z.enum(AGENT_API_ASSISTANT_INBOX_FILTERS),
  items: z.array(agentApiAssistantOwnerInboxItemSchema),
  hasMore: z.boolean(),
  nextOffset: z.number().int().nonnegative().nullable(),
  /** `filter=untold` only: how many conversations match in all, whatever the page (say this number, never a count of your own). */
  total: z.number().int().nonnegative().optional(),
  /** `filter=untold` only: more unread than one read covers (300 conversations); `total` is then a lower bound. */
  totalCapped: z.boolean().optional(),
}));

export const agentApiAssistantOwnerMessagesQuerySchema = lazySchema("agentApiAssistantOwnerMessagesQuerySchema", () => passthroughObject({
  channelId: z.string().uuid(),
  /** Message id, 8-character short id, or seq. At most one of before/after/around. */
  before: optionalStringSchema,
  after: optionalStringSchema,
  around: optionalStringSchema,
  limit: positiveIntegerStringSchema.optional(),
}));

export const agentApiAssistantOwnerMessagesResponseSchema = lazySchema("agentApiAssistantOwnerMessagesResponseSchema", () => passthroughObject({
  owner: passthroughObject({ userId: z.string().uuid() }),
  channelId: z.string().uuid(),
  messages: z.array(agentApiMessageEnvelopeSchema),
  hasMore: z.boolean(),
  hasOlder: z.boolean(),
  hasNewer: z.boolean(),
}));

// RFC 077 owner actions: what the owner did themself since a time, as references.
export const agentApiAssistantOwnerActivityQuerySchema = lazySchema("agentApiAssistantOwnerActivityQuerySchema", () => passthroughObject({
  /** ISO time; activity strictly after it. Defaults to the last 24 hours. */
  since: optionalStringSchema,
  limit: positiveIntegerStringSchema.optional(),
}));

export const agentApiAssistantOwnerActivityItemSchema = lazySchema("agentApiAssistantOwnerActivityItemSchema", () => passthroughObject({
  kind: z.enum(["message", "reaction", "task"]),
  /** As in owner-inbox / owner-messages (a thread's own id for a thread). */
  channelId: z.string().uuid(),
  /** The message sent, reacted to, or carrying the task. */
  messageId: z.string().uuid(),
  at: z.string(),
  seq: z.number().int().optional(),
  emoji: z.string().optional(),
  taskNumber: z.number().int().optional(),
  /** Task change: status_changed | reopened | closed | assignee_changed. */
  event: z.string().optional(),
  status: z.string().nullable().optional(),
}));

// RFC 077 step 1: the owner's contact rules, quiet hours and "already told"
// facts, kept by Raft. The runtime's preferences tool wraps these.
export const AGENT_API_CONTACT_RULE_EFFECTS = ["mute", "always", "digest"] as const;

export const agentApiContactRuleSchema = lazySchema("agentApiContactRuleSchema", () => passthroughObject({
  id: z.string().uuid(),
  effect: z.enum(AGENT_API_CONTACT_RULE_EFFECTS),
  /** `{ kind: channel, id, name }`, `{ kind: thread, id, ref }`, `{ kind: person, id, type, name }`, `{ kind: kind, value }`, `{ kind: dms }`, or an imported `{ kind: legacy, channel, sender, itemKind }`. Names are looked up when read. */
  subject: passthroughObject({ kind: z.string() }),
  anytime: z.boolean(),
  until: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
  /** The rule as the owner reads it in a list. */
  line: z.string(),
}));

export const agentApiAssistantContactRulesResponseSchema = lazySchema("agentApiAssistantContactRulesResponseSchema", () => passthroughObject({
  rules: z.array(agentApiContactRuleSchema),
  settings: passthroughObject({
    /** Null: quiet hours off. */
    quiet: passthroughObject({ from: z.string(), to: z.string() }).nullable(),
    brief: passthroughObject({ at: z.string() }),
    timezone: z.string(),
  }),
  /** Ready-to-say lines: quiet hours, brief time, and what the owner hears about by default. */
  lines: passthroughObject({ quiet: z.string(), brief: z.string(), defaults: z.string() }),
}));

export const agentApiAssistantContactRuleAddBodySchema = lazySchema("agentApiAssistantContactRuleAddBodySchema", () => passthroughObject({
  effect: z.enum(AGENT_API_CONTACT_RULE_EFFECTS),
  /** `#channel`, `#channel:<msg short id>` (a thread), `@name` (`~human` / `~agent`), `kind:<question|review|decision|task|mention|decided>`, `dms`, or a channel / thread id from an owner read. */
  subject: z.string().trim().min(1).max(200),
  /** `always` only: also during quiet hours. */
  anytime: z.boolean().optional(),
  /** ISO time, in the future and at most 90 days out; omit for a lasting rule. */
  until: z.string().nullable().optional(),
  note: z.string().max(200).nullable().optional(),
}));

export const agentApiAssistantContactRuleAddResponseSchema = lazySchema("agentApiAssistantContactRuleAddResponseSchema", () => passthroughObject({
  rule: agentApiContactRuleSchema,
  /** Say this to the owner: it is written from what was stored. */
  confirmation: z.string(),
  /** True when the same effect on the same subject already existed and was updated. */
  updated: z.boolean(),
}));

export const agentApiAssistantContactRuleParamsSchema = lazySchema("agentApiAssistantContactRuleParamsSchema", () => passthroughObject({
  /** The rule id, or the 8 characters its line starts with. */
  ruleId: z.string().trim().min(8).max(36),
}));

export const agentApiAssistantConfirmationResponseSchema = lazySchema("agentApiAssistantConfirmationResponseSchema", () => passthroughObject({
  confirmation: z.string(),
}));

export const agentApiAssistantContactSettingsBodySchema = lazySchema("agentApiAssistantContactSettingsBodySchema", () => passthroughObject({
  /** `{ from, to }` as HH:MM in the owner's zone, or null to turn quiet hours off. Absent: unchanged. */
  quiet: passthroughObject({ from: z.string(), to: z.string() }).nullable().optional(),
  /** The IANA zone the owner told the assistant (used while Raft knows none for them); null forgets it. Absent: unchanged. */
  statedTimezone: z.string().max(100).nullable().optional(),
}));

export const agentApiAssistantContactSettingsResponseSchema = lazySchema("agentApiAssistantContactSettingsResponseSchema", () => passthroughObject({
  settings: passthroughObject({
    quiet: passthroughObject({ from: z.string(), to: z.string() }).nullable(),
    statedTimezone: z.string().nullable().optional(),
  }),
  confirmation: z.string(),
}));

/**
 * The owner's settings a personal assistant may read and change for them.
 * `theme` and `themeDecor` are the owner's own look in THIS server only (their
 * membership here; never their look in any other server). `displayLanguage` is
 * the app's UI language (not the translation target); `preferredTimezone` is
 * their IANA time zone.
 */
export const agentApiAssistantOwnerSettingsSchema = lazySchema("agentApiAssistantOwnerSettingsSchema", () => passthroughObject({
  /** The Raft theme id the owner sees here (never null; "raft", Raft Yellow, is the default). */
  theme: z.string(),
  /**
   * The theme the owner chose here ("raft" when they never chose one: the same
   * value the audit records and PATCH accepts). Differs from `theme` only for a
   * Pro theme, which is kept on a Free server but shows as Raft Yellow there.
   */
  storedTheme: z.string(),
  /** The owner's decorations switch, as stored. */
  themeDecor: z.boolean(),
  /** Whether decorations show: the shown theme has some (not "raft" or "boring") and `themeDecor` is on. */
  themeDecorShown: z.boolean(),
  /** The UI language (en, zh-cn, ...); null follows the browser. */
  displayLanguage: z.string().nullable(),
  /** IANA time zone; null follows the browser. */
  preferredTimezone: z.string().nullable(),
}));

/**
 * Any non-empty subset; what is absent stays. Checked exactly as the owner's
 * own settings are (the same 400 `{ error }`): `theme` a Raft theme id ("raft"
 * is the default; not null), `themeDecor` a boolean, `displayLanguage` a
 * supported UI language or null, `preferredTimezone` an IANA zone or null.
 * Typed loosely here so the check, and its message, is the web's.
 */
export const agentApiAssistantOwnerSettingsBodySchema = lazySchema("agentApiAssistantOwnerSettingsBodySchema", () => passthroughObject({
  theme: z.unknown().optional(),
  themeDecor: z.unknown().optional(),
  displayLanguage: z.unknown().optional(),
  preferredTimezone: z.unknown().optional(),
}));

export const agentApiAssistantOwnerSettingsResponseSchema = lazySchema("agentApiAssistantOwnerSettingsResponseSchema", () => passthroughObject({
  settings: agentApiAssistantOwnerSettingsSchema,
}));

export const agentApiAssistantOwnerSettingsUpdateResponseSchema = lazySchema("agentApiAssistantOwnerSettingsUpdateResponseSchema", () => passthroughObject({
  settings: agentApiAssistantOwnerSettingsSchema,
  /** The settings whose value actually changed (each one is shown to the owner on their settings page). */
  changed: z.array(z.enum(["theme", "themeDecor", "displayLanguage", "preferredTimezone"])),
}));

export const agentApiAssistantContactRulesImportBodySchema = lazySchema("agentApiAssistantContactRulesImportBodySchema", () => passthroughObject({
  /** The runtime's rules exactly as it kept them (each with its own `id`, the idempotency key). */
  rules: z.array(z.unknown()).max(200),
  /** The runtime's contact settings, `{ quiet }`; absent leaves them as they are. */
  contact: passthroughObject({}).optional(),
  /** A zone the owner told the assistant; kept only as a fallback for when Raft knows none. */
  statedTimezone: z.string().max(100).nullable().optional(),
}));

export const agentApiAssistantContactRulesImportResponseSchema = lazySchema("agentApiAssistantContactRulesImportResponseSchema", () => passthroughObject({
  imported: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  /** Of imported + updated: kept as older multi-condition rules. */
  legacy: z.number().int().nonnegative(),
}));

export const agentApiAssistantToldBodySchema = lazySchema("agentApiAssistantToldBodySchema", () => passthroughObject({
  messageIds: z.array(z.string()).max(100).optional(),
  /** `#channel:msgid` references as written to the owner (8-character or full id). */
  refs: z.array(z.string().max(200)).max(100).optional(),
  via: z.enum(["notify", "chat"]),
}).refine((body) => (body.messageIds?.length ?? 0) + (body.refs?.length ?? 0) > 0, { message: "give messageIds or refs" }));

export const agentApiAssistantToldResponseSchema = lazySchema("agentApiAssistantToldResponseSchema", () => passthroughObject({
  recorded: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
}));

export const agentApiAssistantToldListQuerySchema = lazySchema("agentApiAssistantToldListQuerySchema", () => passthroughObject({
  /** ISO time; facts recorded strictly after it. Defaults to the last 30 days. */
  since: optionalStringSchema,
  /** The previous page's `nextCursor`; takes precedence over `since`. */
  cursor: optionalStringSchema,
  limit: positiveIntegerStringSchema.optional(),
}));

export const agentApiAssistantToldListResponseSchema = lazySchema("agentApiAssistantToldListResponseSchema", () => passthroughObject({
  items: z.array(passthroughObject({ messageId: z.string().uuid(), via: z.string(), at: z.string() })),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
}));

// RFC 077 step 2: the model's lines for a check; Raft composes and sends the DM.
export const agentApiAssistantNotifyBodySchema = lazySchema("agentApiAssistantNotifyBodySchema", () => passthroughObject({
  /** The check this answers (the runtime adds it from the session; never the model). */
  check_id: z.string().uuid(),
  /** The runtime's key for this call (e.g. the turn id): a retry never sends a second DM. */
  idempotency_key: z.string().trim().min(1).max(200),
  /** One line per item the owner should hear about now, the ones you judge need them; empty when none does. */
  items: z.array(passthroughObject({
    channelId: z.string().uuid(),
    summary: z.string().max(1000),
    /** Why it needs them: question | review | decision | task | mention; anything else is ignored. Recorded as the line's reason. */
    kind: z.string().max(40).optional(),
  })).max(30),
}));

export const agentApiAssistantNotifyResponseSchema = lazySchema("agentApiAssistantNotifyResponseSchema", () => passthroughObject({
  outcome: z.enum(["sent", "duplicate", "nothing_to_send", "kept_for_brief"]),
  shown: z.number().int().nonnegative(),
  more: z.number().int().nonnegative(),
  dropped: z.array(passthroughObject({ channelId: z.string(), reason: z.string() })),
  /** When sent: how many lines went out for each reason (decision_needed, question, review_requested, task_assigned, mention, owner_rule, ...). */
  reasons: z.record(z.string(), z.number().int().nonnegative()).optional(),
}));

// RFC 077 step 2c: the runtime's one-time push when it sees `raftCheck` turn on.
export const agentApiAssistantCheckStateImportBodySchema = lazySchema("agentApiAssistantCheckStateImportBodySchema", () => passthroughObject({
  /** The owner-local day (YYYY-MM-DD) the runtime last briefed the owner; absent or null: not today. */
  briefSent: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
}));

export const agentApiAssistantCheckStateImportResponseSchema = lazySchema("agentApiAssistantCheckStateImportResponseSchema", () => passthroughObject({
  /** Today's brief: already sent (by the runtime or Raft), due now, or at the next 08:00. */
  briefToday: z.enum(["sent", "due", "scheduled"]),
}));

export const agentApiAssistantOwnerResolveQuerySchema = lazySchema("agentApiAssistantOwnerResolveQuerySchema", () => passthroughObject({
  /** `@name` or `name`; `~human` / `~agent` picks one when a person and an agent share it. `#name` is a channel; `dm:@name` is the owner's existing DM with them. */
  name: z.string().trim().min(1).max(200),
}));

export const agentApiAssistantOwnerResolveResponseSchema = lazySchema("agentApiAssistantOwnerResolveResponseSchema", () => passthroughObject({
  id: z.string(),
  /** `channel` only for a `#name` query; `dm` (the DM's channel id) only for a `dm:@name` query. */
  type: z.enum(["human", "agent", "channel", "dm"]),
  /** Without `@`, `#` or `dm:@`. */
  name: z.string(),
}));

export const agentApiAssistantOwnerActivityResponseSchema = lazySchema("agentApiAssistantOwnerActivityResponseSchema", () => passthroughObject({
  owner: passthroughObject({ userId: z.string().uuid() }),
  items: z.array(agentApiAssistantOwnerActivityItemSchema),
  hasMore: z.boolean(),
  /** Pass as `since` for the next page; null when there is nothing newer. */
  nextSince: z.string().nullable(),
}));

// RFC 077: a personal assistant sends a message as its owner, labeled
// `delegated_by`. Only after the owner turned "send as me" on.
export const agentApiAssistantSendAsOwnerBodySchema = lazySchema("agentApiAssistantSendAsOwnerBodySchema", () => passthroughObject({
  /** The conversation, as `channelId` from owner-inbox / owner-messages (a thread's own id for a thread). Exactly one of `channelId` and `dmWith`. */
  channelId: z.string().uuid().optional(),
  /**
   * `@name` of a person or an agent: your owner's DM with them, opened as your
   * owner when there is none yet, exactly as your owner could themselves.
   * `~human` / `~agent` picks one when a person and an agent share the name.
   */
  dmWith: z.string().trim().min(1).max(200).optional(),
  content: z.string(),
  /** Reply in the thread under this message of `channelId` (created if it has none yet). Not with `dmWith`. */
  parentMessageId: z.string().uuid().optional(),
}));

export const agentApiAssistantSendAsOwnerResponseSchema = lazySchema("agentApiAssistantSendAsOwnerResponseSchema", () => passthroughObject({
  messageId: z.string().uuid(),
  /** Where it landed: the thread's own channel when it went to a thread. */
  channelId: z.string().uuid(),
}));

// RFC 077 forwardAsOwner: forward messages as the owner, shaped like the web's
// batch POST /messages/forward. Caps (20 messages, 10 destinations) are the
// Server's, so it can answer them with their own codes.
export const agentApiAssistantForwardAsOwnerBodySchema = lazySchema("agentApiAssistantForwardAsOwnerBodySchema", () => passthroughObject({
  /**
   * 1 to 20 message ids, full or the 8-character `msg=` id, all from one
   * conversation your owner can read and you may read for them: no DM (or a
   * thread under one) while they keep DMs from you, never your own DM with
   * them. Otherwise `404 source_not_found`, the same as a message that does
   * not exist.
   */
  messages: z.array(z.string()),
  /**
   * 1 to 10 destinations: `#channel`, `@name` (`~human` / `~agent` when a person
   * and an agent share it; a DM your owner never had is opened), or a
   * conversation id. `{ to, join: true }` joins your owner to a public channel
   * they are not in (they are told in the receipt).
   */
  to: z.array(z.union([z.string(), passthroughObject({ to: z.string(), join: z.boolean().optional() })])),
  /** Optional text above the forwarded messages. */
  note: z.string().optional(),
  /**
   * A UUID you choose per forward. Retry with the same one, and after fixing
   * failed destinations (dropping one, adding `join: true`) send again with
   * the same one and the same `messages` and `note`: destinations already
   * sent come back as they were and are not re-sent. A new requestId sends
   * again everywhere it lists. Kept per destination: one this requestId
   * already sent to with other `messages` or `note` is `request_conflict`
   * there, one it never sent to is sent as a new forward; a destination whose
   * message your owner retracted is `retracted_by_owner` and is never sent again.
   */
  requestId: z.string().uuid(),
  /** Check everything and write nothing: each destination is would_send or failed, plus a preview. */
  dryRun: z.boolean().optional(),
}));

export const agentApiAssistantForwardAsOwnerResultSchema = lazySchema("agentApiAssistantForwardAsOwnerResultSchema", () => passthroughObject({
  to: z.string(),
  /** Null for a DM a dry run would open, or a destination that did not resolve. */
  channelId: z.string().nullable(),
  status: z.enum(["sent", "failed", "would_send"]),
  messageId: z.string().optional(),
  /** A link to the sent message you can share. */
  link: z.string().optional(),
  /** Why a destination failed, e.g. `join_required`, `request_conflict`, `retracted_by_owner` (do not send it there again unless your owner asks). */
  code: z.string().optional(),
  error: z.string().optional(),
  /** Your owner was (a dry run: would be) joined to this public channel. */
  joined: z.boolean().optional(),
  /** A DM your owner never had was (a dry run: would be) opened. */
  createsDm: z.boolean().optional(),
  /** `joint_external_audience`: people outside this server may see the forwarded snapshot. */
  warnings: z.array(z.string()).optional(),
}));

export const agentApiAssistantForwardAsOwnerResponseSchema = lazySchema("agentApiAssistantForwardAsOwnerResponseSchema", () => passthroughObject({
  results: z.array(agentApiAssistantForwardAsOwnerResultSchema),
  /** dryRun only: the forward as an agent reads it. */
  preview: z.string().optional(),
}));

export const agentApiAssistantSearchForwardTargetsQuerySchema = lazySchema("agentApiAssistantSearchForwardTargetsQuerySchema", () => passthroughObject({
  q: z.string().trim().min(1).max(200),
  limit: positiveIntegerStringSchema.optional(),
}));

export const agentApiAssistantSearchForwardTargetsResponseSchema = lazySchema("agentApiAssistantSearchForwardTargetsResponseSchema", () => passthroughObject({
  targets: z.array(passthroughObject({
    label: z.string(),
    /** Pass this as a forwardAsOwner destination. */
    to: z.string(),
    /** `join_channel`: pass { to, join: true }. `create_dm`: a new DM is opened. */
    requiredAction: z.enum(["join_channel", "create_dm"]).optional(),
  })),
  /** `assistant_reads_dms_off`: your owner has not let you read their DMs, so people, agents and DMs are left out (always set while that is off). */
  omitted: z.string().optional(),
  /** One sentence on what `omitted` left out and why. */
  omittedReason: z.string().optional(),
}));

export const agentApiMessageResolveResponseSchema = lazySchema("agentApiMessageResolveResponseSchema", () => passthroughObject({
  message: agentApiMessageEnvelopeSchema,
}));

export const agentApiChannelAttentionSchema = lazySchema("agentApiChannelAttentionSchema", () => passthroughObject({
  state: optionalStringSchema,
  ordinaryActivity: optionalStringSchema,
  stillArrives: optionalStringArraySchema,
  threadBoundary: optionalStringSchema,
  manageCommand: optionalStringSchema,
  manageApi: optionalStringSchema,
}));

const agentApiChannelMemberRefSchema = lazySchema("agentApiChannelMemberRefSchema", () => passthroughObject({
  type: z.enum(["human", "agent"]),
  id: z.string(),
  name: z.string(),
}));

export const agentApiChannelMemberAddResponseSchema = lazySchema("agentApiChannelMemberAddResponseSchema", () => passthroughObject({
  ok: z.literal(true),
  alreadyMember: z.boolean(),
  channelId: z.string(),
  member: agentApiChannelMemberRefSchema,
}));

/** `channelDeleted`: the member was the private channel's last, so it and all its messages were deleted (sent only then, with `deleteIfLast`). */
const agentApiChannelDeletedSchema = lazySchema("agentApiChannelDeletedSchema", () => z.literal(true).optional());

export const agentApiChannelMemberRemoveResponseSchema = lazySchema("agentApiChannelMemberRemoveResponseSchema", () => passthroughObject({
  ok: z.literal(true),
  wasMember: z.boolean(),
  channelId: z.string(),
  member: agentApiChannelMemberRefSchema,
  attention: agentApiChannelAttentionSchema.optional(),
  channelDeleted: agentApiChannelDeletedSchema,
}));

export const agentApiOkResponseSchema = lazySchema("agentApiOkResponseSchema", () => passthroughObject({
  ok: z.literal(true),
  attention: agentApiChannelAttentionSchema.optional(),
}));

export const agentApiChannelLeaveResponseSchema = lazySchema("agentApiChannelLeaveResponseSchema", () => passthroughObject({
  ok: z.literal(true),
  attention: agentApiChannelAttentionSchema.optional(),
  channelDeleted: agentApiChannelDeletedSchema,
}));

export const agentApiSearchResultSchema = lazySchema("agentApiSearchResultSchema", () => passthroughObject({
  id: z.string(),
  seq: z.number().int().nonnegative(),
  channelId: z.string(),
  threadId: z.string().nullable(),
  parentMessageId: z.string().nullable(),
  parentMessageContent: z.string().nullable(),
  parentChannelId: z.string(),
  parentChannelName: z.string(),
  parentChannelType: z.string(),
  parentChannelArchivedAt: nullableStringSchema,
  senderId: z.string(),
  senderType: z.string(),
  senderName: z.string(),
  channelName: z.string(),
  channelType: z.string(),
  channelArchivedAt: nullableStringSchema,
  content: z.string(),
  snippet: z.string(),
  createdAt: z.string().datetime(),
  taskStatus: z.string().nullable().optional(),
  taskNumber: z.number().int().positive().nullable().optional(),
  taskCurrentProjection: agentApiTaskCurrentProjectionSchema.optional(),
}));

/**
 * Server-side paging bounds for `messages.search`. Note that the two layers that
 * apply them do NOT agree on one input, and the constants deliberately do not hide
 * that:
 *
 *   `searchService`  `Math.min(params.limit ?? DEFAULT, MAX)`  -- explicit 0 stays 0
 *   the search routes `Math.min(Number(q.limit) || DEFAULT, MAX)` -- explicit 0 becomes
 *                     DEFAULT, because 0 is falsy (so does "", NaN, and "abc")
 *
 * Every caller that reaches the server over HTTP goes through a route, so the `||`
 * semantics is the one agents actually observe.
 *
 * Exported so the CLI can STATE them in `--help` rather than copy them. Before
 * this, both numbers were inline magic values at two call sites and appeared
 * nowhere a caller could read: `--help` said only "server default applies if
 * omitted". Four agents independently read the 20-row default page as a hard cap
 * on 2026-09-20, because nothing in the CLI, the help, or the response
 * distinguishes "this is all there is" from "this is one page".
 *
 * Two separate gaps remain, and documenting the bounds fixes neither:
 *
 * 1. The schema below DOES carry `hasMore`, and the server populates it -- but
 *    `formatSearchResults` prints only a bare count of the rows it received and
 *    discards the flag, so nothing in the CLI's output says more rows exist.
 *    Surfacing it belongs to #proj-daemon #326 / PR #8054, not here.
 * 2. Nothing in the payload -- `hasMore` included -- reveals that MAX silently
 *    reduced the limit the caller asked for. `hasMore` answers "are there more
 *    rows", never "was your request clamped".
 */
export const AGENT_API_MESSAGE_SEARCH_DEFAULT_LIMIT = 20;
export const AGENT_API_MESSAGE_SEARCH_MAX_LIMIT = 50;

export const agentApiMessageSearchResponseSchema = lazySchema("agentApiMessageSearchResponseSchema", () => passthroughObject({
  results: z.array(agentApiSearchResultSchema),
  hasMore: z.boolean(),
  /**
   * The search stopped at its scan budget before the page filled: these are
   * not all the matches (recent-sort text search; absent otherwise).
   */
  incomplete: z.boolean().optional(),
  /** Continue with cursor=nextCursor (offset 0); present when hasMore or incomplete on that path. */
  nextCursor: z.string().optional(),
  /** incomplete only: the oldest message time searched (ISO). */
  searchedThrough: z.string().optional(),
  /** incomplete only: how many messages were read before the search stopped. */
  searchedMessages: z.number().int().nonnegative().optional(),
  /**
   * No message matched every word, and matching any of the words was skipped
   * because too many messages match some word: the empty page does not mean
   * nothing matches. Narrow the words, or filter by channel or sender.
   */
  relaxedSkipped: z.enum(["too_broad"]).optional(),
  /**
   * The plan's history window hid matches (Free keeps 30 days; first page of a
   * search whose dates reach behind it): `historyLimitMessage` says how many
   * and why, in words the CLI prints, so "no results" isn't read as "nothing
   * exists". Absent otherwise (task #proj-commercial:#24, F).
   */
  historyLimited: z.boolean().optional(),
  historyLimitMessage: optionalStringSchema,
  /** How many matches the window hid, up to 100 (`capped` past it). Present whenever it was counted, 0 included. */
  olderHidden: passthroughObject({
    count: z.number().int().nonnegative(),
    capped: z.boolean(),
  }).optional(),
  /**
   * Relevance sort only: too many messages match to rank them, so the results
   * are newest first (as the recent sort, nextCursor continues them), not by
   * relevance. Use more specific words, or filter by channel or sender.
   */
  relevanceFallback: z.enum(["too_broad"]).optional(),
}));

export const agentApiChannelMembersResponseSchema = lazySchema("agentApiChannelMembersResponseSchema", () => passthroughObject({
  channel: passthroughObject({
    ref: z.string(),
    type: z.string(),
  }),
  agents: z.array(passthroughObject({
    name: z.string(),
    status: optionalStringSchema,
  })),
  humans: z.array(passthroughObject({
    name: z.string(),
    description: z.string().nullable().optional(),
    role: optionalStringSchema,
    // Joint channels only (RFC 075 phase 1): every server the person
    // participates through, the agent's own first and marked `yours: true`
    // when present. Omitted when the person is only on the agent's own server.
    servers: z.array(passthroughObject({
      name: z.string(),
      slug: z.string(),
      yours: z.literal(true).optional(),
    })).optional(),
  })),
}));

export const agentApiChannelMuteResponseSchema = lazySchema("agentApiChannelMuteResponseSchema", () => passthroughObject({
  activityMuted: optionalBooleanSchema,
  muteFromSeq: nullableNumberSchema.optional(),
  attention: passthroughObject({
    state: optionalStringSchema,
    ordinaryActivity: optionalStringSchema,
    unmuteCommand: optionalStringSchema,
    unmuteApi: optionalStringSchema,
    muteCommand: optionalStringSchema,
    muteApi: optionalStringSchema,
    stillArrives: optionalStringArraySchema,
    threadBoundary: optionalStringSchema,
    catchUp: optionalStringSchema,
  }).optional(),
}));

const agentApiChannelLifecycleResponseBaseSchema = lazySchema("agentApiChannelLifecycleResponseBaseSchema", () => passthroughObject({
  id: z.string().trim().min(1).transform(asChannelId),
  name: z.string().trim().min(1),
  type: z.enum(["channel", "private"]),
  archivedByUserId: nullableStringSchema.optional(),
  archivedByAgentId: nullableStringSchema.optional(),
}));

export const agentApiChannelArchiveResponseSchema = lazySchema("agentApiChannelArchiveResponseSchema", () => agentApiChannelLifecycleResponseBaseSchema.extend({
  archivedAt: z.string().trim().min(1),
}));

export const agentApiChannelUnarchiveResponseSchema = lazySchema("agentApiChannelUnarchiveResponseSchema", () => agentApiChannelLifecycleResponseBaseSchema.extend({
  archivedAt: z.null(),
}));

export const agentApiChannelMuteBodySchema = lazySchema("agentApiChannelMuteBodySchema", () => passthroughObject({
  attentionHintAccepted: passthroughObject({
    schema: z.literal(ATTENTION_HINT_SCHEMA),
    trigger: z.enum(["M2", "M3"]),
    scope: z.string().trim().min(1),
    suggested_command: optionalStringSchema,
    copy_version: z.string().trim().min(1),
    epoch_ms: z.number().int().nonnegative(),
  }).optional(),
}));

// Effect-boundary projection of a failed claim. The claim API declares which
// effects this specific conflict blocks; it never rules on lane ownership —
// canonical DRI/reviewer/evidence identity stays with lane/thread authority.
export const agentApiTaskClaimConflictSchema = lazySchema("agentApiTaskClaimConflictSchema", () => passthroughObject({
  kind: z.literal("claim_conflict"),
  conflictScope: z.literal("implementation_execution"),
  // Authoritative CLOSED set: an action not listed here is NOT blocked by
  // this claim conflict (it remains subject to its own authority/policy).
  blockedActions: z.array(z.string().trim().min(1)),
  // Explicitly illustrative and non-exhaustive; never a permission table.
  unblockedActionExamples: z.array(z.string().trim().min(1)),
  currentAssignee: z.object({
    type: z.enum(["user", "agent"]),
    name: z.string().nullable(),
  }).nullable(),
  taskStatus: z.string().nullable(),
  claimedAt: z.string().nullable(),
  // Assignment state is reported as of this instant; it is a snapshot, not a
  // ruling that stays true.
  observedAt: z.string(),
}));

export const agentApiTaskClaimResultSchema = lazySchema("agentApiTaskClaimResultSchema", () => passthroughObject({
  taskNumber: z.number().int().positive().optional(),
  /** Task v2 (a task addressed by its ref): the ref's tail, `#7`, so pre-v2 clients follow up at `#board:#7`; the host message is `hostMessageId`. */
  messageId: optionalStringSchema,
  /** Task v2: the claimed task's conversation parent (its anchor) when it differs from `messageId`. */
  conversationMessageId: optionalStringSchema,
  /** Task v2 (flag-on servers): the task's address, `#channel:#7` / `dm:@peer:#7`. */
  taskRef: optionalStringSchema,
  /** The task's title: the lifecycle line this write posts names it (attestedSendService SELF_CAUSED_FRESHNESS_EXEMPT_SUBTYPES). */
  title: optionalStringSchema,
  success: z.boolean(),
  reason: optionalStringSchema,
  conflict: agentApiTaskClaimConflictSchema.optional(),
}));

export const agentApiTaskClaimSuccessResponseSchema = lazySchema("agentApiTaskClaimSuccessResponseSchema", () => passthroughObject({
  results: z.array(agentApiTaskClaimResultSchema),
}));

export const agentApiTaskClaimResponseSchema = lazySchema("agentApiTaskClaimResponseSchema", () => z.union([
  agentApiTaskClaimSuccessResponseSchema,
  agentApiHeldFreshnessResponseSchema,
]));

export const agentApiTaskEnvelopeSchema = lazySchema("agentApiTaskEnvelopeSchema", () => passthroughObject({
  taskNumber: z.number().int().positive().optional(),
  status: z.string().optional(),
  title: optionalStringSchema,
  description: z.string().nullable().optional(),
  revision: z.number().int().nonnegative().nullable().optional(),
  /** The assignee's handle. */
  claimedByName: z.string().nullable().optional(),
  /** The creator's display name (not a handle; see `createdByHandle`). */
  createdByName: z.string().nullable().optional(),
  /** The creator's handle. Servers before 2026-10 omit it. */
  createdByHandle: z.string().nullable().optional(),
  createdByMembershipStatus: z.enum(["active", "left", "removed"]).nullable().optional(),
  /** Task v2 (a task addressed by its ref): the ref's tail, `#7`, so pre-v2 clients follow up at `#board:#7`; the host message is `hostMessageId`. */
  messageId: z.string().nullable().optional(),
  /** Task v2: the chat message the task hangs under. */
  sourceMessageId: z.string().nullable().optional(),
  /** Task v2: the conversation is a hidden anchor's thread (`#channel:<messageId short>`). */
  conversationAnchored: optionalBooleanSchema,
  /**
   * Task v2 (flag-on servers only): a task created before task v2 whose own
   * conversation does not exist yet; `messageId` is its old host message,
   * whose thread is not the task's conversation.
   */
  conversationPending: optionalBooleanSchema,
  channelRef: z.string().trim().min(1).optional(),
  isLegacy: optionalBooleanSchema,
  requiresResourceReceipt: optionalBooleanSchema,
  resourceReceipt: agentApiTaskResourceReceiptSchema.nullable().optional(),
  resourceReceiptRecordedAt: z.string().datetime().nullable().optional(),
  resourceTeardownOwnerAgentId: nullableStringSchema.optional(),
  resourceExpiryFollowupId: nullableStringSchema.optional(),
}));

export const agentApiTaskListResponseSchema = lazySchema("agentApiTaskListResponseSchema", () => passthroughObject({
  tasks: z.array(agentApiTaskEnvelopeSchema),
  scope: z.enum(["channel", "mine"]).optional(),
  coverage: passthroughObject({
    status: z.literal("incomplete"),
    visibleChannelTypes: z.array(z.enum(["channel", "private", "joint", "dm"])),
    includesArchived: z.boolean(),
    inaccessibleScope: z.literal("not_asserted"),
    reason: z.string().trim().min(1),
  }).optional(),
  /**
   * When scope is `channel`, this asserts that the response contains every
   * matching task in the authorized channel for the requested status filter.
   * It does not assert access to other channels or prevent later writes.
   * Older servers omit it: absence is unknown, not a completeness assertion.
   */
  pagination: passthroughObject({
    mode: z.literal("complete"),
    truncated: z.literal(false),
  }).optional(),
}));

export const agentApiCreatedTaskEnvelopeSchema = lazySchema("agentApiCreatedTaskEnvelopeSchema", () => passthroughObject({
  taskNumber: z.number().int().positive(),
  /** Task v2 (a task addressed by its ref): the ref's tail, `#7`, so pre-v2 clients follow up at `#board:#7`; the host message is `hostMessageId`. */
  messageId: z.string(),
  title: z.string(),
  status: taskStatusSchema,
  claimedByType: z.enum(["user", "agent"]).nullable(),
  claimedById: z.string().nullable(),
  claimedByName: z.string().nullable().optional(),
  claimedAt: z.string().datetime().nullable(),
  requiresResourceReceipt: z.boolean(),
  /** Task v2 only: present (true) when the conversation is a hidden anchor's thread. */
  conversationAnchored: z.literal(true).optional(),
  sourceMessageId: z.string().nullable().optional(),
  /**
   * Task v2: the source given was a reply in one of the channel's threads (this
   * id); the task's source is that thread's root message (`sourceMessageId`).
   * Absent when the source given was a top-level message.
   */
  sourceThreadReplyId: z.string().optional(),
}));

export const agentApiTaskAssignmentReceiptSchema = lazySchema("agentApiTaskAssignmentReceiptSchema", () => passthroughObject({
  messageId: z.string(),
  content: z.string(),
  assignee: z.string().startsWith("@"),
  state: z.enum(["started", "assigned"]),
}));

export const agentApiTaskCreateSuccessResponseSchema = lazySchema("agentApiTaskCreateSuccessResponseSchema", () => passthroughObject({
  tasks: z.array(agentApiCreatedTaskEnvelopeSchema),
  assignmentReceipt: agentApiTaskAssignmentReceiptSchema.optional(),
}));

export const agentApiTaskCreateResponseSchema = lazySchema("agentApiTaskCreateResponseSchema", () => z.union([
  agentApiTaskCreateSuccessResponseSchema,
  agentApiHeldFreshnessResponseSchema,
]));

export const agentApiTaskResourceReceiptResponseSchema = lazySchema("agentApiTaskResourceReceiptResponseSchema", () => passthroughObject({
  ok: z.literal(true),
  taskNumber: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
  receipt: agentApiTaskResourceReceiptSchema,
  expiryFollowup: passthroughObject({
    id: z.string().uuid(),
    ownerAgentId: z.string().uuid(),
    owner: z.string().startsWith("@"),
    fireAt: z.string().datetime(),
    msgId: z.string().uuid(),
    targetChannelId: z.string().uuid(),
  }),
}));

/**
 * A task write applied while the conversation it lands in had messages the
 * model had not seen (agentWriteLanding.ts `onUnseen: "attach"`): they come
 * with the response instead of holding the write, so the agent reads them in
 * the same turn and can still change course.
 */
export const agentApiTaskWriteUnseenSchema = lazySchema("agentApiTaskWriteUnseenSchema", () => passthroughObject({
  /** The conversation, as the agent addresses it (`#channel:#7`). */
  target: z.string().min(1),
  messages: z.array(agentApiMessageEnvelopeSchema),
  newMessageCount: z.number().int().nonnegative(),
  omittedMessageCount: z.number().int().nonnegative(),
  /** The boundary the model has seen once it reads `messages`. */
  seenUpToSeq: z.number().int().nonnegative(),
}));

export type AgentApiTaskWriteUnseen = z.infer<typeof agentApiTaskWriteUnseenSchema>;

export const agentApiTaskUnclaimSuccessResponseSchema = lazySchema("agentApiTaskUnclaimSuccessResponseSchema", () => passthroughObject({
  ok: z.literal(true),
  /** Task v2 (flag-on servers): the task's address, `#channel:#7` / `dm:@peer:#7`. */
  taskRef: optionalStringSchema,
  /** The task's title: the lifecycle line this write posts names it (attestedSendService SELF_CAUSED_FRESHNESS_EXEMPT_SUBTYPES). */
  title: optionalStringSchema,
  /** Messages in the task's conversation the model had not seen, attached (`agentApiTaskWriteUnseenSchema`). */
  unseen: agentApiTaskWriteUnseenSchema.optional(),
}));

export const agentApiTaskAssignSuccessResponseSchema = lazySchema("agentApiTaskAssignSuccessResponseSchema", () => passthroughObject({
  ok: z.literal(true),
  /** Echoed so a caller that lost a race can retry without a re-read. */
  revision: z.number().int().nonnegative(),
  assignee: z.string().nullable(),
  /** Task v2 (flag-on servers): the task's address, `#channel:#7` / `dm:@peer:#7`. */
  taskRef: optionalStringSchema,
  /** The task's title: the lifecycle line this write posts names it (attestedSendService SELF_CAUSED_FRESHNESS_EXEMPT_SUBTYPES). */
  title: optionalStringSchema,
}));

export const agentApiTaskUnclaimResponseSchema = lazySchema("agentApiTaskUnclaimResponseSchema", () => z.union([
  agentApiTaskUnclaimSuccessResponseSchema,
  agentApiHeldFreshnessResponseSchema,
]));

export const agentApiTaskAssignResponseSchema = lazySchema("agentApiTaskAssignResponseSchema", () => z.union([
  agentApiTaskAssignSuccessResponseSchema,
  agentApiHeldFreshnessResponseSchema,
]));

export const agentApiTaskDeleteResponseSchema = lazySchema("agentApiTaskDeleteResponseSchema", () => passthroughObject({
  ok: z.literal(true),
  /** Task v2 (flag-on servers): the task's address, `#channel:#7` / `dm:@peer:#7`. */
  taskRef: optionalStringSchema,
}));

export const agentApiTaskConvertResponseSchema = lazySchema("agentApiTaskConvertResponseSchema", () => passthroughObject({
  task: agentApiCreatedTaskEnvelopeSchema,
}));

export const agentApiTaskUpdateStatusSuccessResponseSchema = lazySchema("agentApiTaskUpdateStatusSuccessResponseSchema", () => passthroughObject({
  ok: z.literal(true),
  /**
   * The status the server stored. It can differ from the requested one: a
   * task v2 task asked for `in_review` stores `in_progress` (in_review is not
   * used for task v2 tasks). Absent from older servers: the requested status.
   */
  status: taskStatusSchema.optional(),
  /** Task v2 (flag-on servers): the task's address, `#channel:#7` / `dm:@peer:#7`. */
  taskRef: optionalStringSchema,
  /** The task's title: the lifecycle line this write posts names it (attestedSendService SELF_CAUSED_FRESHNESS_EXEMPT_SUBTYPES). */
  title: optionalStringSchema,
  /** Messages in the task's conversation the model had not seen, attached (`agentApiTaskWriteUnseenSchema`). */
  unseen: agentApiTaskWriteUnseenSchema.optional(),
}));

export const agentApiTaskUpdateStatusResponseSchema = lazySchema("agentApiTaskUpdateStatusResponseSchema", () => z.union([
  agentApiTaskUpdateStatusSuccessResponseSchema,
  agentApiHeldFreshnessResponseSchema,
]));

export const agentApiTaskViewResponseSchema = lazySchema("agentApiTaskViewResponseSchema", () => passthroughObject({
  /** The task's address, `#channel:#7` / `dm:@peer:#7`. */
  taskRef: z.string().min(1),
  task: agentApiTaskEnvelopeSchema,
  /** Whether the agent follows the task's conversation (its replies wake it). */
  following: z.boolean(),
  followReason: z.string().nullable().optional(),
  conversation: passthroughObject({
    /** False for a task from before task v2 nobody has written to since: the first reply creates it. */
    exists: z.boolean(),
    replyCount: z.number().int().nonnegative(),
  }),
  /**
   * The chat message the task was created from. Null when the task has no
   * recorded source (an older task created without one: `raft task view` says
   * "not recorded"); a task from before task v2 that was posted as its own
   * message has no recorded source either.
   */
  sourceMessage: passthroughObject({
    id: z.string(),
    target: z.string(),
    senderName: z.string().nullable(),
    /** Empty when the message is behind the plan's history window (`historyLimitMessage` says so). */
    content: z.string(),
    createdAt: z.string().nullable(),
    /** The source is older than the plan's history window (Free keeps 30 days): why its text is not shown. */
    historyLimitMessage: optionalStringSchema,
  }).nullable().optional(),
  /** A task from before task v2: its old discussion, the thread of the message it was posted as. */
  earlierDiscussion: passthroughObject({
    target: z.string(),
    replyCount: z.number().int().nonnegative(),
  }).nullable().optional(),
  /** The latest messages of the conversation, oldest first. */
  recentMessages: z.array(agentApiMessageEnvelopeSchema),
  hasOlder: z.boolean(),
  /** As on a history read: older messages of the conversation are behind the plan's history window. */
  historyLimited: z.boolean().optional(),
  historyLimitMessage: optionalStringSchema,
}));

export const agentApiTaskFollowingResponseSchema = lazySchema("agentApiTaskFollowingResponseSchema", () => passthroughObject({
  tasks: z.array(passthroughObject({
    /** `#channel:#7` / `dm:@peer:#7`. */
    taskRef: z.string().min(1),
    taskNumber: z.number().int().positive(),
    title: z.string(),
    status: z.string(),
    /** Messages from others after the agent's read position in the conversation. */
    unread: z.number().int().nonnegative(),
    followedAt: z.string().datetime(),
    reason: z.string().nullable(),
  })),
}));

export const agentApiTaskFollowResponseSchema = lazySchema("agentApiTaskFollowResponseSchema", () => passthroughObject({
  ok: z.literal(true),
  taskRef: z.string().min(1),
  following: z.boolean(),
  /** False when nothing changed (already followed / not followed). */
  changed: z.boolean(),
}));

/**
 * Idle task reminder (#wg-task-v2:#9), asked by the agent's Computer on its
 * Working→Idle edge. `freshSession`: the first ask of a new session (context
 * reset; a compaction is not one): every open task is listed once, whatever
 * was reminded before (not the tasks with no assignee it created: those come
 * only on their thresholds). `backgroundTasks`: background tasks the runtime reports
 * running; while there are any, "untouched for a while" reminders pause and
 * the notice says how many are running. `rulesShown`: this model context
 * already got a notice with the rule blocks (the Computer resets it on every
 * new session, compaction and handoff), so the notice leaves them out; absent
 * (an older Computer, or one that cannot tell) keeps them.
 */
export const agentApiTaskIdleNudgeBodySchema = lazySchema("agentApiTaskIdleNudgeBodySchema", () => passthroughObject({
  freshSession: optionalBooleanSchema,
  backgroundTasks: z.number().int().nonnegative().max(10_000).optional(),
  rulesShown: optionalBooleanSchema,
}));

export const agentApiTaskIdleNudgeItemSchema = lazySchema("agentApiTaskIdleNudgeItemSchema", () => passthroughObject({
  /** `#channel:#7` / `dm:@peer:#7`. */
  ref: z.string().min(1),
  taskNumber: z.number().int().positive(),
  /** The task's board, `#channel` / `dm:@peer`. */
  channel: z.string().min(1),
  title: z.string(),
  status: z.string(),
  reason: z.enum(IDLE_TASK_REMINDER_ITEM_REASONS),
  /** The line's "why", as the notice prints it (`newly yours (assigned by @stdrc)`, `untouched for 2h`, `no assignee, you created it (untouched for 8h)`). */
  why: z.string(),
}));

export const agentApiTaskIdleNudgeBacklogItemSchema = lazySchema("agentApiTaskIdleNudgeBacklogItemSchema", () => passthroughObject({
  ref: z.string().min(1),
  taskNumber: z.number().int().positive(),
  channel: z.string().min(1),
  title: z.string(),
}));

/**
 * `send`: deliver `text` to the agent now (once). The Server has already
 * recorded the listed tasks as reminded, so a lost response skips at most one
 * reminder. `send: false` carries `reason` and an empty `text`; a Computer
 * that asked with `freshSession` keeps asking with it until a reminder is
 * sent or the reason is `no_open_tasks` / `disabled` (a `hourly_cap` skip
 * records nothing).
 */
export const agentApiTaskIdleNudgeResponseSchema = lazySchema("agentApiTaskIdleNudgeResponseSchema", () => passthroughObject({
  send: z.boolean(),
  reason: z.enum(IDLE_TASK_REMINDER_SKIP_REASONS).optional(),
  items: z.array(agentApiTaskIdleNudgeItemSchema),
  /** Parked tasks (status `backlog`), only on a reminder that is sent anyway. */
  backlog: z.array(agentApiTaskIdleNudgeBacklogItemSchema),
  /** The ready-to-deliver notice (empty when `send` is false). */
  text: z.string(),
  /**
   * `text` carries the rules for held tasks ("For each task: …"). A Computer
   * that writes it may ask with `rulesShown` until the context changes; absent
   * (an older Server) never lets it.
   */
  rules: optionalBooleanSchema,
}));

const agentApiTaskCardProjectionSchema = lazySchema("agentApiTaskCardProjectionSchema", () => passthroughObject({
  taskNumber: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullable(),
  revision: z.number().int().nonnegative(),
}));

const agentApiTaskHistoryEventSchema = lazySchema("agentApiTaskHistoryEventSchema", () => passthroughObject({
  id: z.string().uuid(),
  seq: z.number().int().positive(),
  eventType: z.string().trim().min(1),
  actorType: z.enum(["user", "agent", "system"]),
  actorName: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
}));

export const agentApiTaskAmendSuccessResponseSchema = lazySchema("agentApiTaskAmendSuccessResponseSchema", () => passthroughObject({
  task: agentApiTaskCardProjectionSchema,
  event: agentApiTaskHistoryEventSchema,
  /** Messages in the task's conversation the model had not seen, attached (`agentApiTaskWriteUnseenSchema`). */
  unseen: agentApiTaskWriteUnseenSchema.optional(),
}));

export const agentApiTaskAmendResponseSchema = lazySchema("agentApiTaskAmendResponseSchema", () => z.union([
  agentApiTaskAmendSuccessResponseSchema,
  agentApiHeldFreshnessResponseSchema,
]));

export const agentApiTaskHistoryResponseSchema = lazySchema("agentApiTaskHistoryResponseSchema", () => passthroughObject({
  task: agentApiTaskCardProjectionSchema,
  events: z.array(agentApiTaskHistoryEventSchema),
}));

export const agentApiActionPrepareResponseSchema = lazySchema("agentApiActionPrepareResponseSchema", () => passthroughObject({
  messageId: z.string(),
  metadata: passthroughObject({
    kind: z.literal("action-card"),
  }),
  /**
   * True when nothing was posted because the same card is already there:
   * `messageId` is that card. Only `plan:upgrade` does this (a repeat for the
   * same conversation and gate within a day). Absent for a newly posted card.
   */
  existing: z.boolean().optional(),
}));

/** The question card to withdraw: its message id, or at least its first 8 characters among the agent's own question cards. */
export const agentApiActionWithdrawParamsSchema = lazySchema("agentApiActionWithdrawParamsSchema", () => passthroughObject({
  messageId: z.string().trim().min(8).max(64),
}));

export const agentApiActionWithdrawResponseSchema = lazySchema("agentApiActionWithdrawResponseSchema", () => passthroughObject({
  messageId: z.string(),
  /** The card as the agent reads it (no `presentation.card`), now `withdrawn`. */
  metadata: passthroughObject({
    kind: z.literal("action-card"),
  }),
  /** True when it was already withdrawn: nothing changed. */
  alreadyWithdrawn: z.boolean().optional(),
}));

export const agentApiReminderRecurrenceSchema = lazySchema("agentApiReminderRecurrenceSchema", () => z.object({
  kind: z.enum(["interval", "daily", "weekly", "unsupported"]),
  description: z.string(),
}));

export const agentApiReminderSummarySchema = lazySchema("agentApiReminderSummarySchema", () => z.object({
  reminderId: z.string(),
  ownerAgentId: z.string(),
  title: z.string(),
  fireAt: z.string(),
  firedAt: nullableStringSchema.optional(),
  createdAt: z.string(),
  status: reminderStatusSchema,
  msgRef: nullableStringSchema,
  msgPermalink: nullableStringSchema,
  recurrence: agentApiReminderRecurrenceSchema.nullable(),
}));

export const agentApiReminderEventSummarySchema = lazySchema("agentApiReminderEventSummarySchema", () => z.object({
  eventId: z.string(),
  reminderId: z.string(),
  eventType: reminderEventTypeSchema,
  actorType: z.enum(["agent", "human", "system"]),
  actorId: nullableStringSchema,
  occurredAt: z.string(),
  nextFireAt: nullableStringSchema,
  metadata: z.record(z.string(), z.unknown()).nullable(),
}));

export const agentApiReminderListResponseSchema = lazySchema("agentApiReminderListResponseSchema", () => passthroughObject({
  reminders: z.array(agentApiReminderSummarySchema),
}));

export const agentApiReminderResponseSchema = lazySchema("agentApiReminderResponseSchema", () => passthroughObject({
  reminder: agentApiReminderSummarySchema,
  warning: optionalStringSchema,
}));

export const agentApiReminderLogResponseSchema = lazySchema("agentApiReminderLogResponseSchema", () => passthroughObject({
  events: z.array(agentApiReminderEventSummarySchema),
}));

export const agentApiAppSourceAckResponseSchema = lazySchema("agentApiAppSourceAckResponseSchema", () => passthroughObject({
  ok: z.literal(true),
  itemId: z.string(),
  appId: z.string(),
  notificationClass: z.string(),
  sourceRef: agentApiInboxSourceRefSchema,
  sourceEventId: z.string().uuid(),
  ackAttemptId: z.string().uuid(),
  replayed: z.boolean(),
}));

export const agentApiAppSourceAckRejectCodeSchema = lazySchema("agentApiAppSourceAckRejectCodeSchema", () => z.enum([
  "app_source_authority_not_registered",
  "invalid_source_revision",
  "source_id_ambiguous",
  "source_not_found",
  "target_not_fired",
  "stale_source_revision",
]));

export const agentApiAppSourceAckRejectResponseSchema = lazySchema("agentApiAppSourceAckRejectResponseSchema", () => passthroughObject({
  error: z.string(),
  code: agentApiAppSourceAckRejectCodeSchema,
  latestFiredSourceVersion: optionalNumberSchema,
}));

export const agentApiAppConfigParamsSchema = lazySchema("agentApiAppConfigParamsSchema", () => z.object({
  appId: z.string().trim().min(1),
}));

const agentApiAppConfigValueSchema = lazySchema("agentApiAppConfigValueSchema", () => z.union([z.boolean(), z.number().int().safe()]));
const agentApiAppConfigFieldSchema = lazySchema("agentApiAppConfigFieldSchema", () => z.union([
  z.object({ type: z.literal("boolean") }).strict(),
  z.object({
    type: z.literal("integer"),
    minimum: z.number().int().safe(),
    maximum: z.number().int().safe(),
  }).strict(),
]));

export const agentApiAppConfigPatchBodySchema = lazySchema("agentApiAppConfigPatchBodySchema", () => z.object({
  expectedRevision: z.number().int().nonnegative(),
  set: z.record(z.string(), z.unknown()).default({}),
  unset: z.array(z.string().trim().min(1)).default([]),
}).strict());

export const agentApiAppConfigResponseSchema = lazySchema("agentApiAppConfigResponseSchema", () => passthroughObject({
  appId: z.string(),
  revision: z.number().int().nonnegative(),
  schema: z.record(z.string(), agentApiAppConfigFieldSchema),
  defaults: z.record(z.string(), agentApiAppConfigValueSchema),
  overrides: z.record(z.string(), agentApiAppConfigValueSchema),
  effective: z.record(z.string(), agentApiAppConfigValueSchema),
}));

// ── Routes that were served outside the typed contract until manifest metadata
// landed (SDK 1.0 Phase 1): inbox push registration and the mention inbox.
// (`/wake-hints` and `/activity` stay in `daemonApiContract`: the daemon owns
// those paths for managed runners, and `daemonApiRawClient.test.ts` forbids
// registering them here as well.) Handlers keep their own strict checks; these
// schemas are the client-facing shape.

export const agentApiPushWebhookRegisterBodySchema = lazySchema("agentApiPushWebhookRegisterBodySchema", () => z.object({
  /** Public HTTPS endpoint that receives `raft-agent-inbox-notice.v1` POSTs. */
  url: z.string().trim().min(1),
  /** Receiver-owned HMAC-SHA256 secret; stored encrypted, never returned. */
  secret: z.string().min(1).max(512),
}).strict());

export const agentApiPushWebhookStatusResponseSchema = lazySchema("agentApiPushWebhookStatusResponseSchema", () => passthroughObject({
  registered: z.boolean(),
  url: nullableStringSchema,
  enabled: z.boolean(),
  disabledReason: z.enum(["endpoint_rejected", "credential_revoked", "agent_inactive"]).nullable(),
  disabledAt: nullableStringSchema,
  lastAttemptAt: nullableStringSchema,
  lastDeliveryAt: nullableStringSchema,
  lastError: nullableStringSchema,
  consecutiveFailures: z.number().int().nonnegative(),
  nextAttemptAt: nullableStringSchema,
  /** When Raft stopped probing a stopped endpoint (30 days without recovering); a new PUT clears it. */
  probeStoppedAt: nullableStringSchema.optional(),
  /** While disabled: how push delivery resumes (Raft's probes, or a new PUT). Null while enabled. */
  recovery: nullableStringSchema.optional(),
}));

export const agentApiMentionsListQuerySchema = lazySchema("agentApiMentionsListQuerySchema", () => passthroughObject({
  limit: optionalStringSchema,
  before_seq: optionalStringSchema,
}));

export const agentApiMentionInboxRowSchema = lazySchema("agentApiMentionInboxRowSchema", () => passthroughObject({
  id: z.string(),
  messageId: z.string(),
  messageSeq: z.number(),
  channelId: z.string(),
  handleAtSendTime: nullableStringSchema.optional(),
  source: z.string(),
  confidence: z.unknown().optional(),
  createdAt: z.string(),
}));

export const agentApiMentionsListResponseSchema = lazySchema("agentApiMentionsListResponseSchema", () => passthroughObject({
  mentions: z.array(agentApiMentionInboxRowSchema),
  has_more: z.boolean(),
}));


/** Core's routes (an app's are in its own fragment, apps/<id>/agentApi.ts). */
const coreAgentApiRoutes = {
  raftbenchFindings: route({
    key: "raftbenchFindings",
    method: "GET",
    path: "/raftbench/findings",
    client: { resource: "raftbench", method: "findings" },
    capability: "read",
    description: "Read current RaftBench findings under an explicit administrator grant and the calling agent's channel access. Evidence references only; read messages separately.",
    request: { query: raftbenchFindingsQuerySchema },
    response: { body: raftbenchFindingsResponseSchema },
  }),
  raftbenchContext: route({
    key: "raftbenchContext",
    method: "GET",
    path: "/raftbench/context",
    client: { resource: "raftbench", method: "context" },
    capability: "raftbench",
    description: "Read a bounded source page for the current staging RaftBench run, with server-owned coverage.",
    request: { query: raftbenchContextQuerySchema },
    response: { body: raftbenchContextResponseSchema },
  }),
  raftbenchSubmit: route({
    key: "raftbenchSubmit",
    method: "POST",
    path: "/raftbench/submit",
    client: { resource: "raftbench", method: "submit" },
    capability: "raftbench",
    description: "Submit one complete or incomplete result for a bound run and revision; identical replays return the same receipt.",
    request: { body: raftbenchReportSchema },
    response: { body: raftbenchSubmitResponseSchema },
  }),
  feedbackLocatorIngest: route({
    key: "feedbackLocatorIngest",
    method: "POST",
    path: "/feedback-locators",
    client: { resource: "feedbackLocators", method: "create" },
    capability: "send",
    description: "Validate and atomically index one locator-only feedback artifact.",
    request: { body: agentApiFeedbackLocatorIngestBodySchema },
    response: { body: agentApiFeedbackLocatorAcceptanceSchema },
  }),
  feedbackLocatorList: route({
    key: "feedbackLocatorList",
    method: "GET",
    path: "/feedback-locators",
    client: { resource: "feedbackLocators", method: "list" },
    capability: "read",
    description: "Query the locator-only feedback index without returning session or feedback content.",
    request: { query: agentApiFeedbackLocatorListQuerySchema },
    response: { body: agentApiFeedbackLocatorListResponseSchema },
  }),
  events: route({
    key: "events",
    method: "GET",
    path: "/events",
    client: { resource: "events", method: "get" },
    capability: "read",
    description: "Drain pending events for the bound agent credential.",
    request: { query: agentApiEventsQuerySchema },
    response: { body: agentApiEventsResponseSchema },
  }),
  historyRead: route({
    key: "historyRead",
    method: "GET",
    path: "/history",
    client: { resource: "history", method: "read" },
    capability: "read",
    description: "Read visible history for a channel, DM, or thread target.",
    request: { query: agentApiHistoryQuerySchema },
    response: { body: agentApiHistoryResponseSchema },
  }),
  knowledgeGet: route({
    key: "knowledgeGet",
    method: "GET",
    path: "/knowledge",
    client: { resource: "knowledge", method: "get" },
    capability: "knowledge",
    description: "Fetch a Slock Manual for Agents topic from the current server.",
    request: { query: agentApiKnowledgeGetQuerySchema },
    response: { body: agentApiKnowledgeGetResponseSchema },
  }),
  knowledgeSearch: route({
    key: "knowledgeSearch",
    method: "GET",
    path: "/knowledge/search",
    client: { resource: "knowledge", method: "search" },
    capability: "knowledge",
    description: "Search Slock Manual for Agents topics from the current server.",
    request: { query: agentApiKnowledgeSearchQuerySchema },
    response: { body: agentApiKnowledgeSearchResponseSchema },
  }),
  contextSearch: route({
    key: "contextSearch",
    method: "POST",
    path: "/context/search",
    client: { resource: "context", method: "search" },
    capability: "read",
    description: "Search one message's View Context (the agent's own) for literal text; returns matching entries, never the whole context.",
    request: { body: agentApiContextSearchBodySchema },
    response: { body: agentApiContextQueryResponseSchema },
  }),
  contextRead: route({
    key: "contextRead",
    method: "POST",
    path: "/context/read",
    client: { resource: "context", method: "read" },
    capability: "read",
    description: "Read a window of entries around one entry of one message's View Context (the agent's own).",
    request: { body: agentApiContextReadBodySchema },
    response: { body: agentApiContextQueryResponseSchema },
  }),
  managedMcpTools: route({
    key: "managedMcpTools",
    method: "GET",
    path: "/mcp/tools",
    client: { resource: "mcp", method: "tools" },
    capability: "mcp",
    description: "Fetch the current Server-authorized managed MCP tool catalog for this Agent.",
    request: {},
    response: { body: agentApiManagedMcpToolsResponseSchema },
  }),
  managedMcpCall: route({
    key: "managedMcpCall",
    method: "POST",
    path: "/mcp/call",
    client: { resource: "mcp", method: "call" },
    capability: "mcp",
    description: "Call an allowlisted managed MCP tool through the Server gateway.",
    request: { body: agentApiManagedMcpCallBodySchema },
    response: { body: agentApiManagedMcpCallResponseSchema },
  }),
  messageSend: route({
    key: "messageSend",
    method: "POST",
    path: "/send",
    client: { resource: "messages", method: "send" },
    capability: "send",
    description: "Send a message as the bound agent credential.",
    request: { body: agentApiSendBodySchema },
    response: { body: agentApiSendResponseSchema },
  }),
  messageSendV2: route({
    key: "messageSendV2",
    method: "POST",
    path: "/v2/send",
    client: { resource: "messages", method: "sendV2" },
    capability: "send",
    description: "Send a message through the versioned typed-mention contract.",
    request: { body: agentApiSendV2BodySchema },
    response: { body: agentApiSendResponseSchema },
  }),
  messageResolve: route({
    key: "messageResolve",
    method: "GET",
    path: "/messages/:msgId/resolve",
    client: { resource: "messages", method: "resolve" },
    capability: "read",
    description: "Resolve a message id exactly and return the canonical visible message.",
    request: { params: agentApiMessageResolveParamsSchema },
    response: { body: agentApiMessageResolveResponseSchema },
  }),
  messageSearch: route({
    key: "messageSearch",
    method: "GET",
    path: "/search",
    client: { resource: "messages", method: "search" },
    capability: "read",
    description: "Search messages visible to the bound agent credential.",
    request: { query: agentApiMessageSearchQuerySchema },
    response: { body: agentApiMessageSearchResponseSchema },
  }),
  messageReactionAdd: route({
    key: "messageReactionAdd",
    method: "POST",
    path: "/messages/:msgId/reactions",
    client: { resource: "messages", method: "addReaction" },
    capability: "reactions",
    description: "Add a reaction to a visible message as the bound agent credential.",
    request: { params: agentApiMessageReactionParamsSchema, body: agentApiMessageReactionBodySchema },
    response: { body: agentApiMessageEnvelopeSchema },
  }),
  messageReactionRemove: route({
    key: "messageReactionRemove",
    method: "DELETE",
    path: "/messages/:msgId/reactions",
    client: { resource: "messages", method: "removeReaction" },
    capability: "reactions",
    description: "Remove a reaction from a visible message as the bound agent credential.",
    request: { params: agentApiMessageReactionParamsSchema, body: agentApiMessageReactionBodySchema },
    response: { body: agentApiMessageEnvelopeSchema },
  }),
  messageCardUpdate: route({
    key: "messageCardUpdate",
    method: "PUT",
    path: "/messages/:messageId/card",
    client: { resource: "messages", method: "updateCard" },
    capability: "send",
    description: "Replace the card (and its fallback text) of a card message the bound agent sent, within 14 days; notifies no one (RFC 082).",
    request: { params: agentApiMessageCardUpdateParamsSchema, body: agentApiMessageCardUpdateBodySchema },
    response: { body: agentApiMessageCardUpdateResponseSchema },
  }),
  channelJoin: route({
    key: "channelJoin",
    method: "POST",
    path: "/channels/:channelId/join",
    client: { resource: "channels", method: "join" },
    capability: "channels",
    description: "Join a visible public channel as the bound agent credential.",
    request: { params: agentApiChannelMembershipParamsSchema },
    response: { body: agentApiOkResponseSchema },
  }),
  channelLeave: route({
    key: "channelLeave",
    method: "POST",
    path: "/channels/:channelId/leave",
    client: { resource: "channels", method: "leave" },
    capability: "channels",
    description: "Leave a joined regular channel as the bound agent credential. The last member of a private channel is refused unless `deleteIfLast` is true: leaving then deletes the channel and all its messages.",
    request: { params: agentApiChannelMembershipParamsSchema, body: agentApiChannelLeaveBodySchema },
    response: { body: agentApiChannelLeaveResponseSchema },
  }),
  channelMute: route({
    key: "channelMute",
    method: "POST",
    path: "/channels/:channelId/mute",
    client: { resource: "channels", method: "mute" },
    capability: "channels",
    description: "Mute ordinary activity delivery for a visible regular channel as the bound agent credential.",
    request: { params: agentApiChannelMembershipParamsSchema, body: agentApiChannelMuteBodySchema },
    response: { body: agentApiChannelMuteResponseSchema },
  }),
  channelUnmute: route({
    key: "channelUnmute",
    method: "POST",
    path: "/channels/:channelId/unmute",
    client: { resource: "channels", method: "unmute" },
    capability: "channels",
    description: "Unmute ordinary activity delivery for a visible regular channel as the bound agent credential.",
    request: { params: agentApiChannelMembershipParamsSchema },
    response: { body: agentApiChannelMuteResponseSchema },
  }),
  channelArchive: route({
    key: "channelArchive",
    method: "POST",
    path: "/channels/archive",
    client: { resource: "channels", method: "archive" },
    capability: "channels",
    description: "Archive a regular channel when the bound agent has server channel-management authority.",
    request: { body: agentApiChannelLifecycleBodySchema },
    response: { body: agentApiChannelArchiveResponseSchema },
  }),
  channelUnarchive: route({
    key: "channelUnarchive",
    method: "POST",
    path: "/channels/unarchive",
    client: { resource: "channels", method: "unarchive" },
    capability: "channels",
    description: "Unarchive a regular channel when the bound agent has server channel-management authority.",
    request: { body: agentApiChannelLifecycleBodySchema },
    response: { body: agentApiChannelUnarchiveResponseSchema },
  }),
  channelCreate: route({
    key: "channelCreate",
    method: "POST",
    path: "/channels",
    client: { resource: "channels", method: "create" },
    capability: "channels",
    description: "Create a public or private channel when the bound agent's server role allows it; the agent joins it.",
    request: { body: agentApiChannelCreateBodySchema },
    response: { body: agentApiChannelRowResponseSchema },
  }),
  channelUpdate: route({
    key: "channelUpdate",
    method: "PATCH",
    path: "/channels/:channelId",
    client: { resource: "channels", method: "update" },
    capability: "channels",
    description: "Rename a channel, change its description, change its visibility, or set or remove its announcement (an Artifact homed in it; channel_announcement_v0), when the bound agent's role allows it.",
    request: { params: agentApiChannelMembershipParamsSchema, body: agentApiChannelUpdateBodySchema },
    response: { body: agentApiChannelRowResponseSchema },
  }),
  channelMemberAdd: route({
    key: "channelMemberAdd",
    method: "POST",
    path: "/channels/:channelId/members",
    client: { resource: "channels", method: "addMember" },
    capability: "channels",
    description: "Add a human or agent to a channel when the bound agent's role allows it.",
    request: { params: agentApiChannelMembershipParamsSchema, body: agentApiChannelMemberBodySchema },
    response: { body: agentApiChannelMemberAddResponseSchema },
  }),
  channelMemberRemove: route({
    key: "channelMemberRemove",
    method: "DELETE",
    path: "/channels/:channelId/members",
    client: { resource: "channels", method: "removeMember" },
    capability: "channels",
    description: "Remove a human or agent from a channel when the bound agent's role allows it. A private channel's last member is refused unless `deleteIfLast` is true: removing them then deletes the channel and all its messages.",
    request: { params: agentApiChannelMembershipParamsSchema, body: agentApiChannelMemberRemoveBodySchema },
    response: { body: agentApiChannelMemberRemoveResponseSchema },
  }),
  channelMembers: route({
    key: "channelMembers",
    method: "GET",
    path: "/channel-members",
    client: { resource: "channels", method: "members" },
    capability: "channels",
    description: "List agents and humans in a visible channel, DM, or thread.",
    request: { query: agentApiChannelMembersQuerySchema },
    response: { body: agentApiChannelMembersResponseSchema },
  }),
  resolveChannel: route({
    key: "resolveChannel",
    method: "POST",
    path: "/resolve-channel",
    client: { resource: "channels", method: "resolve" },
    capability: "send",
    description: "Resolve a writable channel, DM, or thread target for the bound agent credential.",
    request: { body: agentApiResolveChannelBodySchema },
    response: { body: agentApiResolveChannelResponseSchema },
  }),
  threadFollow: route({
    key: "threadFollow",
    method: "POST",
    path: "/threads/follow",
    client: { resource: "threads", method: "follow" },
    capability: "channels",
    description: "Follow a thread as the bound agent credential: its replies wake the agent (reactivates an earlier unfollow; existing replies are not unread).",
    request: { body: agentApiThreadFollowBodySchema },
    response: { body: agentApiThreadFollowResponseSchema },
  }),
  threadUnfollow: route({
    key: "threadUnfollow",
    method: "POST",
    path: "/threads/unfollow",
    client: { resource: "threads", method: "unfollow" },
    capability: "channels",
    description: "Stop ordinary delivery for a followed thread as the bound agent credential.",
    request: { body: agentApiThreadUnfollowBodySchema },
    response: { body: agentApiOkResponseSchema },
  }),
  threadList: route({
    key: "threadList",
    method: "GET",
    path: "/threads",
    client: { resource: "threads", method: "list" },
    capability: "channels",
    description: "List active threads the bound agent is following.",
    request: {},
    response: { body: agentApiThreadListResponseSchema },
  }),
  inboxList: route({
    key: "inboxList",
    method: "GET",
    // Not `/inbox`: the managed-runner daemon proxy answers GET /inbox locally
    // with its volatile pending snapshot (daemonApiContract.inboxCheck).
    path: "/inbox/conversations",
    client: { resource: "inbox", method: "list" },
    capability: "read",
    description: "List the bound agent's durable unread conversations, newest activity first.",
    request: { query: agentApiInboxListQuerySchema },
    response: { body: agentApiInboxListResponseSchema },
  }),
  inboxRead: route({
    key: "inboxRead",
    method: "POST",
    // POST because it consumes. Not under a path the daemon proxy answers
    // itself (GET /inbox, POST /inbox/seal|unseal|ack).
    path: "/inbox/read",
    client: { resource: "inbox", method: "read" },
    capability: "read",
    description: "Read one page of one inbox item (a conversation, `app:<app>/<ref>`, `app:<app>`, `reminder:<id>` or `agent-event:<id>`), oldest unread first, and consume exactly what the page returns: at most 20 entries and 8,000 chars of content, but always one entry. `remaining` is what is left; `consumed` is true once nothing is. A reminder is shown with its `ack` and never consumed: only `raft reminder ack` does that. Another agent's item answers the same 404 as an unknown one.",
    request: { body: agentApiInboxReadBodySchema },
    response: { body: agentApiInboxReadResponseSchema },
  }),
  inboxDismiss: route({
    key: "inboxDismiss",
    method: "POST",
    path: "/inbox/dismiss",
    client: { resource: "inbox", method: "dismiss" },
    capability: "read",
    description: "Dismiss without reading: `target` dismisses one item, `before` every item with no activity since then (at least 24 h ago, or the launch day `inbox check`'s `preLaunch.before` names; at most 500 items a call, `remaining` says how many are left). There is no \"all\". Reminder items are never dismissed: `target` on one answers 409 NEEDS_ACK and `before` skips them (`skippedNeedsAck`). Dismissed items leave `inbox check` and wake-ups and are not redelivered. Every use is traced.",
    request: { body: agentApiInboxDismissBodySchema },
    response: { body: agentApiInboxDismissResponseSchema },
  }),
  assistantOwnerInbox: route({
    key: "assistantOwnerInbox",
    method: "GET",
    path: "/assistant/owner-inbox",
    client: { resource: "assistant", method: "ownerInbox" },
    capability: "read",
    description: "Personal assistants only: list your owner's inbox (what they would see in Activity, including their DMs unless they turned that off; never your own DM with them), newest activity first. A DM is named by the other person, from your owner's side. Every row says whether your owner was already told about it (`told`); `filter=untold` lists only what they were not told yet, with the authoritative `total`. Reads nothing as read for anyone.",
    request: { query: agentApiAssistantOwnerInboxQuerySchema },
    response: { body: agentApiAssistantOwnerInboxResponseSchema },
  }),
  assistantOwnerMessages: route({
    key: "assistantOwnerMessages",
    method: "GET",
    path: "/assistant/owner-messages",
    client: { resource: "assistant", method: "ownerMessages" },
    capability: "read",
    description: "Personal assistants only: read messages in a conversation your owner can see, DMs included unless they turned that off (never your own DM with them): the newest, or a window before / after / around a message. Marks nothing read for anyone.",
    request: { query: agentApiAssistantOwnerMessagesQuerySchema },
    response: { body: agentApiAssistantOwnerMessagesResponseSchema },
  }),
  assistantOwnerArtifact: route({
    key: "assistantOwnerArtifact",
    method: "GET",
    path: "/assistant/owner-artifact",
    client: { resource: "assistant", method: "ownerArtifact" },
    capability: "read",
    description: "Personal assistants only: read an Artifact your owner can open, by its id, pt_ id or link (someone posted https://app.raft.build/artifacts/<id>): its title, where it lives, its versions, one file (the entry file unless you name path; text inline, binary as size and type only) and the comments your owner can see. One your owner cannot open, or in a DM while they keep DMs from you, is not found. Marks nothing read and follows nothing for them.",
    request: { query: agentApiAssistantOwnerArtifactQuerySchema },
    response: { body: agentApiAssistantOwnerArtifactResponseSchema },
  }),
  assistantOwnerArtifactPublish: route({
    key: "assistantOwnerArtifactPublish",
    method: "POST",
    path: "/assistant/owner-artifact",
    client: { resource: "assistant", method: "publishArtifact" },
    capability: "send",
    description: "Personal assistants only: publish an Artifact (a page, report or file your owner can open and comment on) into your DM with your owner, as yourself; or a new version of one you published (artifact + base, the version you read). Files inline: content, or content_base64 for bytes. Then send your owner its url. You can't push to an Artifact you didn't publish (NOT_PUBLISHED_BY_ASSISTANT), nor to one no longer in your DM with your owner (moved to a channel or the server, or from before you were given to them): that answers artifact_not_found; publish a new one, don't retry. If the answer is UNSEEN_CHANGES, read it with owner-artifact first and send the same publish with seen = the position it returned.",
    request: { body: agentApiAssistantOwnerArtifactPublishBodySchema },
    response: { body: agentApiAssistantOwnerArtifactPublishResponseSchema },
  }),
  assistantOwnerActivity: route({
    key: "assistantOwnerActivity",
    method: "GET",
    path: "/assistant/owner-activity",
    client: { resource: "assistant", method: "ownerActivity" },
    capability: "read",
    description: "Personal assistants only: what your owner did themself since a time (messages they sent, reactions, task changes), as references only, oldest first. Use it to skip reminding them of things they already handled. Same reach as your other owner reads; never messages you sent for them.",
    request: { query: agentApiAssistantOwnerActivityQuerySchema },
    response: { body: agentApiAssistantOwnerActivityResponseSchema },
  }),
  assistantOwnerResolve: route({
    key: "assistantOwnerResolve",
    method: "GET",
    path: "/assistant/owner-resolve",
    client: { resource: "assistant", method: "ownerResolve" },
    capability: "read",
    description: "Personal assistants only: who @name is, which channel #name is, or which DM dm:@name is, as your owner would find them here: { id, type, name } (type human, agent, channel or dm; name without @, # or dm:@; a dm id is the owner's existing DM with them, never a new one). 404 owner_resolve_not_found when your owner cannot see anyone or any channel by that name (whether or not it exists); 409 owner_resolve_ambiguous when a person and an agent share it (add ~human or ~agent).",
    request: { query: agentApiAssistantOwnerResolveQuerySchema },
    response: { body: agentApiAssistantOwnerResolveResponseSchema },
  }),
  assistantContactRules: route({
    key: "assistantContactRules",
    method: "GET",
    path: "/assistant/contact-rules",
    client: { resource: "assistant", method: "contactRules" },
    capability: "read",
    description: "Personal assistants only: your owner's contact rules (active ones), quiet hours, brief time and zone, each with a ready-to-say line, and what they hear about by default.",
    request: {},
    response: { body: agentApiAssistantContactRulesResponseSchema },
  }),
  assistantContactRuleAdd: route({
    key: "assistantContactRuleAdd",
    method: "POST",
    path: "/assistant/contact-rules",
    client: { resource: "assistant", method: "addContactRule" },
    capability: "send",
    description: "Personal assistants only: store a contact rule your owner asked for: mute, always (anytime: also at night) or digest (morning brief only), on one #channel, #channel:msgid thread, @person, kind:<kind> or dms. The same effect on the same subject updates that rule. Say the returned confirmation; it is written from what was stored. At most 50 rules; until at most 90 days out.",
    request: { body: agentApiAssistantContactRuleAddBodySchema },
    response: { body: agentApiAssistantContactRuleAddResponseSchema },
  }),
  assistantContactRuleRemove: route({
    key: "assistantContactRuleRemove",
    method: "DELETE",
    path: "/assistant/contact-rules/:ruleId",
    client: { resource: "assistant", method: "removeContactRule" },
    capability: "send",
    description: "Personal assistants only: remove one of your owner's contact rules by its id (or the 8 characters its line starts with).",
    request: { params: agentApiAssistantContactRuleParamsSchema },
    response: { body: agentApiAssistantConfirmationResponseSchema },
  }),
  assistantContactSettings: route({
    key: "assistantContactSettings",
    method: "PUT",
    path: "/assistant/contact-settings",
    client: { resource: "assistant", method: "setContactSettings" },
    capability: "send",
    description: "Personal assistants only: change your owner's contact settings. Only what you give changes: quiet ({ from, to } as HH:MM in their zone, or null to turn quiet hours off) and statedTimezone (the IANA zone they told you; null forgets it). Say the returned confirmation.",
    request: { body: agentApiAssistantContactSettingsBodySchema },
    response: { body: agentApiAssistantContactSettingsResponseSchema },
  }),
  assistantOwnerSettings: route({
    key: "assistantOwnerSettings",
    method: "GET",
    path: "/assistant/owner-settings",
    client: { resource: "assistant", method: "ownerSettings" },
    capability: "read",
    description: "Personal assistants only: your owner's theme and theme decorations in this server (only this server), their UI display language and their time zone. theme and themeDecorShown are what they see; storedTheme and themeDecor what they chose (a Pro theme shows as raft on a Free server).",
    request: {},
    response: { body: agentApiAssistantOwnerSettingsResponseSchema },
  }),
  assistantOwnerSettingsUpdate: route({
    key: "assistantOwnerSettingsUpdate",
    method: "PATCH",
    path: "/assistant/owner-settings",
    client: { resource: "assistant", method: "updateOwnerSettings" },
    capability: "send",
    description: "Personal assistants only: change your owner's settings when they ask you to. Only what you give changes: theme and themeDecor (their look in this server only, never their other servers), displayLanguage (the UI language) and preferredTimezone (IANA). Refused with the same message the owner would see. Your owner sees every change you make on their settings page.",
    request: { body: agentApiAssistantOwnerSettingsBodySchema },
    response: { body: agentApiAssistantOwnerSettingsUpdateResponseSchema },
  }),
  assistantContactRulesImport: route({
    key: "assistantContactRulesImport",
    method: "POST",
    path: "/assistant/contact-rules/import",
    client: { resource: "assistant", method: "importContactRules" },
    capability: "send",
    description: "Personal assistants only: one-time import of the rules and quiet hours your runtime kept, exactly as kept. Idempotent by each rule's own id: pushing again changes nothing new.",
    request: { body: agentApiAssistantContactRulesImportBodySchema },
    response: { body: agentApiAssistantContactRulesImportResponseSchema },
  }),
  assistantToldRecord: route({
    key: "assistantToldRecord",
    method: "POST",
    path: "/assistant/told",
    client: { resource: "assistant", method: "recordTold" },
    capability: "send",
    description: "Personal assistants only: record that you told your owner about these messages (by full id), so they are not told twice. Only messages in this server that your owner can see are kept. Kept 30 days.",
    request: { body: agentApiAssistantToldBodySchema },
    response: { body: agentApiAssistantToldResponseSchema },
  }),
  assistantToldList: route({
    key: "assistantToldList",
    method: "GET",
    path: "/assistant/told",
    client: { resource: "assistant", method: "listTold" },
    capability: "read",
    description: "Personal assistants only: what you already told your owner about since a time (default: the last 30 days), oldest first.",
    request: { query: agentApiAssistantToldListQuerySchema },
    response: { body: agentApiAssistantToldListResponseSchema },
  }),
  assistantNotify: route({
    key: "assistantNotify",
    method: "POST",
    path: "/assistant/notify",
    client: { resource: "assistant", method: "notify" },
    capability: "send",
    description: "Personal assistants only (Raft-run checks): give one short line, with its kind, per item of the check you were woken for that needs your owner now; leave out the rest (they stay in your owner's inbox, and the brief and \"more\" still list them). Raft writes the DM to your owner (at most three lines, then how many more), sends it, and records what it showed; items under your owner's always rules are shown even if left out. An empty list is a valid answer and sends nothing.",
    request: { body: agentApiAssistantNotifyBodySchema },
    response: { body: agentApiAssistantNotifyResponseSchema },
  }),
  assistantCheckStateImport: route({
    key: "assistantCheckStateImport",
    method: "POST",
    path: "/assistant/check-state/import",
    client: { resource: "assistant", method: "importCheckState" },
    capability: "send",
    description: "Personal assistants only: once, when raftCheck turns on, say whether you already briefed your owner today (briefSent, owner-local YYYY-MM-DD). Raft holds its own brief on its first day until this arrives, so the owner is never briefed twice. Idempotent.",
    request: { body: agentApiAssistantCheckStateImportBodySchema },
    response: { body: agentApiAssistantCheckStateImportResponseSchema },
  }),
  assistantSendAsOwner: route({
    key: "assistantSendAsOwner",
    method: "POST",
    path: "/assistant/send-as-owner",
    client: { resource: "assistant", method: "sendAsOwner" },
    capability: "send",
    description: "Personal assistants only: send a message as your owner (they are the author; everyone sees it was sent by you for them). Name the conversation by channelId, or a person or agent by dmWith (@name, ~human / ~agent when needed) for your owner's DM with them, opened if there is none and only when your owner could open it themself. Only after your owner turned this on (and, for a DM, lets you read DMs); never in your own DM with them, no @everyone or @here. Raft tells your owner about every one.",
    request: { body: agentApiAssistantSendAsOwnerBodySchema },
    response: { body: agentApiAssistantSendAsOwnerResponseSchema },
  }),
  assistantForwardAsOwner: route({
    key: "assistantForwardAsOwner",
    method: "POST",
    path: "/assistant/forward-as-owner",
    client: { resource: "assistant", method: "forwardAsOwner" },
    capability: "send",
    description: 'Personal assistants only: forward messages as your owner, the way they forward in the web (same card, plus "sent by" you), to 1-10 destinations at once, with a result per destination. messages: 1-20 ids (msg= ids work) from one conversation your owner can read and you may read for them (no DM while they keep DMs from you, never your DM with them; else source_not_found). to: "#channel", "@name" (~human / ~agent), a conversation id, or { to, join: true } for a public channel your owner has not joined (else join_required). requestId: a UUID per forward; retrying with it never sends twice. After fixing failed destinations (drop one, add join: true), send again with the same requestId and the same messages and note: destinations already sent come back as they were and are not re-sent (a new requestId would send them again); kept per destination: one already sent with other messages or note is request_conflict, one never sent to is sent as a new forward. retracted_by_owner: your owner retracted what this forward sent there; do not send it again unless they ask. A refusal about one message names it as messages[i] ("<id you passed>"). dryRun: true checks everything, writes nothing, and returns a preview. Example: first { messages: ["3f2a9c1b", "8d04e7aa"], to: ["#design", "@alice"], note: "FYI, both of these", requestId: "<uuid>", dryRun: true }, then the same without dryRun. Only after your owner turned on sending as them (and, for a DM, lets you read DMs); no @everyone or @here; never your own DM with them. Raft tells your owner in one receipt.',
    request: { body: agentApiAssistantForwardAsOwnerBodySchema },
    response: { body: agentApiAssistantForwardAsOwnerResponseSchema },
  }),
  assistantSearchForwardTargets: route({
    key: "assistantSearchForwardTargets",
    method: "GET",
    path: "/assistant/forward-targets",
    client: { resource: "assistant", method: "searchForwardTargets" },
    capability: "read",
    description: "Personal assistants only: where your owner could forward to, matching q, as the web's forward picker finds it: { targets: [{ label, to, requiredAction? }] }. Pass to as a forwardAsOwner destination; join_channel means { to, join: true }, create_dm means a new DM is opened. While your owner keeps their DMs from you, people, agents and DMs are left out and the answer says so: omitted: assistant_reads_dms_off, with omittedReason.",
    request: { query: agentApiAssistantSearchForwardTargetsQuerySchema },
    response: { body: agentApiAssistantSearchForwardTargetsResponseSchema },
  }),
  agentContext: route({
    key: "agentContext",
    method: "GET",
    path: "/context",
    client: { resource: "agent", method: "context" },
    capability: "read",
    description: "Identity bootstrap: the bound agent's identity, server, credential capabilities, and (external agents) the rendered operating guide.",
    request: {},
    response: { body: agentApiAgentContextResponseSchema },
  }),
  serverInfo: route({
    key: "serverInfo",
    method: "GET",
    path: "/server",
    client: { resource: "server", method: "info" },
    capability: "read",
    description: "List channels, agents, humans, and runtime context visible to the bound agent. Archived channels are left out of `channels` but counted (archivedChannelCount); archived=include also returns them (archivedChannels).",
    request: { query: agentApiServerInfoQuerySchema },
    response: { body: agentApiServerInfoResponseSchema },
  }),
  userChannels: route({
    key: "userChannels",
    method: "GET",
    path: "/users/:name/channels",
    client: { resource: "users", method: "channels" },
    capability: "channels",
    description: "One visible agent or human (exact name, agents first; the serverInfo entry) and which of one window of your visible channels (serverInfo order, offset/limit, limit at most 200) list them as a member, in one request. Needs the read capability as well. 404 user_not_found when no visible user has that name.",
    request: { params: agentApiUserChannelsParamsSchema, query: agentApiUserChannelsQuerySchema },
    response: { body: agentApiUserChannelsResponseSchema },
  }),
  serverUpdate: route({
    key: "serverUpdate",
    method: "PATCH",
    path: "/server",
    client: { resource: "server", method: "update" },
    capability: "server",
    description: "Update the bound agent's server profile name or member-visibility setting.",
    request: { body: agentApiServerUpdateBodySchema },
    response: { body: agentApiServerUpdateResponseSchema },
  }),
  serverLabs: route({
    key: "serverLabs",
    method: "GET",
    path: "/labs",
    client: { resource: "labs", method: "list" },
    capability: "read",
    description: "The server's Labs: whether Labs access is on, each lab's state and enrollment, and what the bound agent may change.",
    request: {},
    response: { body: agentApiServerLabsResponseSchema },
  }),
  serverLabsAccess: route({
    key: "serverLabsAccess",
    method: "PATCH",
    path: "/labs/access",
    client: { resource: "labs", method: "setAccess" },
    capability: "server",
    description: "Turn the server's Labs access on or off (server owner only).",
    request: { body: agentApiServerLabsMutationBodySchema },
    response: { body: agentApiServerLabsMutationResponseSchema },
  }),
  serverLabEnrollment: route({
    key: "serverLabEnrollment",
    method: "PUT",
    path: "/labs/:labKey",
    client: { resource: "labs", method: "setEnrollment" },
    capability: "server",
    description: "Enroll the server in an open lab or leave it (server settings authority).",
    request: { params: agentApiServerLabParamsSchema, body: agentApiServerLabsMutationBodySchema },
    response: { body: agentApiServerLabsMutationResponseSchema },
  }),
  mentionActionsPending: route({
    key: "mentionActionsPending",
    method: "GET",
    path: "/mention-actions/pending",
    client: { resource: "mentions", method: "pendingActions" },
    capability: "mentions",
    description: "List sender-side pending mention actions for unresolved outsider mentions.",
    request: { query: agentApiMentionActionsPendingQuerySchema },
    response: { body: agentApiMentionActionsPendingResponseSchema },
  }),
  senderMentionDeliveries: route({
    key: "senderMentionDeliveries",
    method: "GET",
    path: "/messages/:messageId/mention-deliveries",
    client: { resource: "mentions", method: "senderDeliveries" },
    capability: "mentions",
    description: "Per-target delivery outcome for a message the bound agent sent.",
    request: { params: agentApiSenderMentionDeliveriesParamsSchema },
    response: { body: agentApiSenderMentionDeliveriesResponseSchema },
  }),
  mentionActionsExecute: route({
    key: "mentionActionsExecute",
    method: "POST",
    path: "/mention-actions/execute",
    client: { resource: "mentions", method: "executeAction" },
    capability: "mentions",
    description: "Execute sender-side mention resolution actions.",
    request: { body: agentApiMentionActionsExecuteBodySchema },
    response: { body: agentApiMentionActionsExecuteResponseSchema },
  }),
  taskClaim: route({
    key: "taskClaim",
    method: "POST",
    path: "/tasks/claim",
    client: { resource: "tasks", method: "claim" },
    capability: "tasks",
    description: "Claim one or more tasks by task number or message id. On servers with task v2 conversations, message ids are refused (409 task_v2_use_create) with the claim-by-number / create-from-message commands to use instead.",
    request: { body: agentApiTaskClaimBodySchema },
    response: { body: agentApiTaskClaimResponseSchema },
  }),
  taskList: route({
    key: "taskList",
    method: "GET",
    path: "/tasks",
    client: { resource: "tasks", method: "list" },
    capability: "tasks",
    description: "List tasks in a channel.",
    request: { query: agentApiTaskListQuerySchema },
    response: { body: agentApiTaskListResponseSchema },
  }),
  taskCreate: route({
    key: "taskCreate",
    method: "POST",
    path: "/tasks",
    client: { resource: "tasks", method: "create" },
    capability: "tasks",
    description: "Create one or more tasks in a channel.",
    request: { body: agentApiTaskCreateBodySchema },
    response: { body: agentApiTaskCreateResponseSchema },
  }),
  taskUnclaim: route({
    key: "taskUnclaim",
    method: "POST",
    path: "/tasks/unclaim",
    client: { resource: "tasks", method: "unclaim" },
    capability: "tasks",
    description: "Release a previously claimed task.",
    request: { body: agentApiTaskUnclaimBodySchema },
    response: { body: agentApiTaskUnclaimResponseSchema },
  }),
  taskAssign: route({
    key: "taskAssign",
    method: "POST",
    path: "/tasks/assign",
    client: { resource: "tasks", method: "assign" },
    capability: "tasks",
    description: "Set or clear a task's assignee (pass null to unassign).",
    request: { body: agentApiTaskAssignBodySchema },
    response: { body: agentApiTaskAssignResponseSchema },
  }),
  taskUpdateStatus: route({
    key: "taskUpdateStatus",
    method: "POST",
    path: "/tasks/update-status",
    client: { resource: "tasks", method: "updateStatus" },
    capability: "tasks",
    description: "Update a task status.",
    request: { body: agentApiTaskUpdateStatusBodySchema },
    response: { body: agentApiTaskUpdateStatusResponseSchema },
  }),
  taskResourceReceipt: route({
    key: "taskResourceReceipt",
    method: "POST",
    path: "/tasks/resource-receipt",
    client: { resource: "tasks", method: "recordResourceReceipt" },
    capability: "tasks",
    description: "Record the structured receipt and expiry follow-up for a resource-creating task.",
    request: { body: agentApiTaskResourceReceiptBodySchema },
    response: { body: agentApiTaskResourceReceiptResponseSchema },
  }),
  taskDelete: route({
    key: "taskDelete",
    method: "POST",
    path: "/tasks/delete",
    client: { resource: "tasks", method: "delete" },
    capability: "tasks",
    description: "Delete a task (creator or server admin).",
    request: { body: agentApiTaskDeleteBodySchema },
    response: { body: agentApiTaskDeleteResponseSchema },
  }),
  taskConvert: route({
    key: "taskConvert",
    method: "POST",
    path: "/tasks/convert",
    client: { resource: "tasks", method: "convert" },
    capability: "tasks",
    description: "Convert a message into a task without claiming it. On servers with task v2 conversations this is refused (409 task_v2_use_create) with the create-from-message command to use instead.",
    request: { body: agentApiTaskConvertBodySchema },
    response: { body: agentApiTaskConvertResponseSchema },
  }),
  taskAmend: route({
    key: "taskAmend",
    method: "POST",
    path: "/tasks/amend",
    client: { resource: "tasks", method: "amend" },
    capability: "tasks",
    description: "Amend a task card with an append-only audit event.",
    request: { body: agentApiTaskAmendBodySchema },
    response: { body: agentApiTaskAmendResponseSchema },
  }),
  taskHistory: route({
    key: "taskHistory",
    method: "GET",
    path: "/tasks/history",
    client: { resource: "tasks", method: "history" },
    capability: "tasks",
    description: "Read a task's append-only lifecycle and amendment history.",
    request: { query: agentApiTaskHistoryQuerySchema },
    response: { body: agentApiTaskHistoryResponseSchema },
  }),
  taskView: route({
    key: "taskView",
    method: "GET",
    path: "/tasks/view",
    client: { resource: "tasks", method: "view" },
    capability: "tasks",
    description: "Task v2: one task's properties (status, assignee, source message), whether the agent follows it, and the latest messages of its own conversation.",
    request: { query: agentApiTaskViewQuerySchema },
    response: { body: agentApiTaskViewResponseSchema },
  }),
  taskRead: route({
    key: "taskRead",
    method: "GET",
    path: "/tasks/read",
    client: { resource: "tasks", method: "read" },
    capability: "read",
    description: "Task v2: read a task's own conversation (same window flags as history reads).",
    request: { query: agentApiTaskReadQuerySchema },
    response: { body: agentApiHistoryResponseSchema },
  }),
  taskReply: route({
    key: "taskReply",
    method: "POST",
    path: "/tasks/reply",
    client: { resource: "tasks", method: "reply" },
    capability: "send",
    description: "Task v2: reply in a task's own conversation (created lazily by the first reply). The current CLI refuses raft message send/read to a task ref locally (task_target_use_task_command); the server still accepts a message send to it, so older CLIs keep reaching the task conversation.",
    request: { body: agentApiTaskReplyBodySchema },
    response: { body: agentApiSendResponseSchema },
  }),
  taskFollowing: route({
    key: "taskFollowing",
    method: "GET",
    path: "/tasks/following",
    client: { resource: "tasks", method: "following" },
    capability: "tasks",
    description: "Task v2: the task conversations the bound agent follows, with unread counts (threads are listed by threadList).",
    request: { query: agentApiTaskFollowingQuerySchema },
    response: { body: agentApiTaskFollowingResponseSchema },
  }),
  taskFollow: route({
    key: "taskFollow",
    method: "POST",
    path: "/tasks/follow",
    client: { resource: "tasks", method: "follow" },
    capability: "channels",
    description: "Task v2: follow a task's own conversation (its replies wake the agent).",
    request: { body: agentApiTaskFollowBodySchema },
    response: { body: agentApiTaskFollowResponseSchema },
  }),
  taskUnfollow: route({
    key: "taskUnfollow",
    method: "POST",
    path: "/tasks/unfollow",
    client: { resource: "tasks", method: "unfollow" },
    capability: "channels",
    description: "Task v2: stop following a task's own conversation (a later @mention, being assigned it, claiming it or replying in it follows it again).",
    request: { body: agentApiTaskUnfollowBodySchema },
    response: { body: agentApiTaskFollowResponseSchema },
  }),
  taskIdleNudge: route({
    key: "taskIdleNudge",
    method: "POST",
    path: "/tasks/idle-nudge",
    client: { resource: "tasks", method: "idleNudge" },
    capability: "tasks",
    description: "Idle task reminder (asked by the agent's Computer when the agent goes idle): which open tasks assigned to the bound agent, or with no assignee when it created them and they have waited past a threshold, to remind it of now, why, and the notice text. Records what it returns as reminded. Off unless the server's task_v2_conversations_v0 flag is on (send: false, reason disabled).",
    request: { body: agentApiTaskIdleNudgeBodySchema },
    response: { body: agentApiTaskIdleNudgeResponseSchema },
  }),
  migrationRetry: route({
    key: "migrationRetry",
    method: "POST",
    path: "/migrations/retry",
    client: { resource: "migrations", method: "retry" },
    capability: "server",
    description: "Retry, once, your latest migration to another Computer after it failed because your workspace was too big (within 24 hours, after you trimmed the workspace). No parameters: the same target, on behalf of the person who started it, who must still be allowed to migrate you. Refused (and not used up) with NO_RETRYABLE_MIGRATION, ALREADY_RETRIED, RETRY_WINDOW_EXPIRED, SOURCE_UNSUPPORTED, STARTER_NOT_AUTHORIZED, TARGET_UNAVAILABLE, PLAN_REQUIRED or MIGRATION_ACTIVE.",
    request: {},
    response: { body: agentApiMigrationRetryResponseSchema },
  }),
  reminderList: route({
    key: "reminderList",
    method: "GET",
    path: "/reminders",
    client: { resource: "reminders", method: "list" },
    capability: "read",
    description: "List reminders owned by the bound agent credential.",
    request: { query: agentApiReminderListQuerySchema },
    response: { body: agentApiReminderListResponseSchema },
  }),
  reminderCreate: route({
    key: "reminderCreate",
    method: "POST",
    path: "/reminders",
    client: { resource: "reminders", method: "create" },
    capability: "tasks",
    description: "Create a reminder owned by the bound agent credential.",
    request: { body: agentApiReminderScheduleBodySchema },
    response: { body: agentApiReminderResponseSchema },
  }),
  reminderCancel: route({
    key: "reminderCancel",
    method: "DELETE",
    path: "/reminders/:reminderId",
    client: { resource: "reminders", method: "cancel" },
    capability: "tasks",
    description: "Cancel a scheduled or fired reminder owned by the bound agent credential.",
    request: { params: agentApiReminderParamsSchema },
    response: { body: agentApiReminderResponseSchema },
  }),
  reminderSnooze: route({
    key: "reminderSnooze",
    method: "POST",
    path: "/reminders/:reminderId/snooze",
    client: { resource: "reminders", method: "snooze" },
    capability: "tasks",
    description: "Snooze a scheduled or fired reminder owned by the bound agent credential.",
    request: { params: agentApiReminderParamsSchema, body: agentApiReminderSnoozeBodySchema },
    response: { body: agentApiReminderResponseSchema },
  }),
  reminderUpdate: route({
    key: "reminderUpdate",
    method: "PATCH",
    path: "/reminders/:reminderId",
    client: { resource: "reminders", method: "update" },
    capability: "tasks",
    description: "Update a scheduled reminder owned by the bound agent credential.",
    request: { params: agentApiReminderParamsSchema, body: agentApiReminderUpdateBodySchema },
    response: { body: agentApiReminderResponseSchema },
  }),
  appSourceAck: route({
    key: "appSourceAck",
    method: "POST",
    path: "/app-sources/ack",
    client: { resource: "appSources", method: "ack" },
    capability: "tasks",
    description: "Authorize and acknowledge one exact app-source Inbox item revision.",
    request: { body: agentApiAppSourceAckBodySchema },
    response: { body: agentApiAppSourceAckResponseSchema },
  }),
  reminderLog: route({
    key: "reminderLog",
    method: "GET",
    path: "/reminders/:reminderId/log",
    client: { resource: "reminders", method: "log" },
    capability: "read",
    description: "Read lifecycle events for a reminder owned by the bound agent credential.",
    request: { params: agentApiReminderParamsSchema },
    response: { body: agentApiReminderLogResponseSchema },
  }),
  appConfigGet: route({
    key: "appConfigGet",
    method: "GET",
    path: "/apps/:appId/config",
    client: { resource: "apps", method: "getConfig" },
    capability: "read",
    description: "Read effective durable configuration for a built-in RAP App owned by the bound agent.",
    request: { params: agentApiAppConfigParamsSchema },
    response: { body: agentApiAppConfigResponseSchema },
  }),
  appConfigPatch: route({
    key: "appConfigPatch",
    method: "PATCH",
    path: "/apps/:appId/config",
    client: { resource: "apps", method: "patchConfig" },
    capability: "tasks",
    description: "Atomically update durable configuration for a built-in RAP App owned by the bound agent.",
    request: { params: agentApiAppConfigParamsSchema, body: agentApiAppConfigPatchBodySchema },
    response: { body: agentApiAppConfigResponseSchema },
  }),
  profileShow: route({
    key: "profileShow",
    method: "GET",
    path: "/profile",
    client: { resource: "profile", method: "show" },
    capability: "read",
    description: "Show the bound agent profile, or another visible profile when target is provided.",
    request: { query: agentApiProfileShowQuerySchema },
    response: { body: agentApiProfileViewSchema },
  }),
  profileUpdate: route({
    key: "profileUpdate",
    method: "POST",
    path: "/profile",
    client: { resource: "profile", method: "update" },
    capability: "send",
    description: "Update the bound agent profile metadata.",
    request: { body: agentApiProfileUpdateBodySchema },
    response: { body: agentApiProfileViewSchema },
  }),
  profileAvatarUpdate: route({
    key: "profileAvatarUpdate",
    method: "POST",
    path: "/profile/avatar",
    client: { resource: "profile", method: "updateAvatar" },
    capability: "send",
    description: "Update the bound agent profile avatar using multipart form data.",
    request: {},
    response: { body: agentApiProfileViewSchema },
  }),
  integrationList: route({
    key: "integrationList",
    method: "GET",
    path: "/integrations",
    client: { resource: "integrations", method: "list" },
    capability: "read",
    description: "List available integration services, active agent logins, and the MCP Apps this agent has.",
    request: { query: agentApiIntegrationListQuerySchema },
    response: { body: agentApiIntegrationListResponseSchema },
  }),
  integrationMarketplaceSearch: route({
    key: "integrationMarketplaceSearch",
    method: "GET",
    path: "/integrations/marketplace",
    client: { resource: "integrations", method: "marketplace" },
    capability: "read",
    description: "Search or list public Marketplace apps without changing the installed integration inventory.",
    request: { query: agentApiIntegrationMarketplaceQuerySchema },
    response: { body: agentApiIntegrationMarketplaceResponseSchema },
  }),
  integrationToken: route({
    key: "integrationToken", method: "POST", path: "/integrations/token",
    client: { resource: "integrations", method: "token" },
    capability: "read",
    description: "Issue a short-lived Agent JWT for an operator-enabled Server-local audience.",
    request: { body: agentApiIntegrationTokenBodySchema },
    response: { body: agentApiIntegrationTokenResponseSchema },
  }),
  integrationLogin: route({
    key: "integrationLogin",
    method: "POST",
    path: "/integrations/login",
    client: { resource: "integrations", method: "login" },
    capability: "read",
    description: "Provision or reuse this agent's login for a registered integration service.",
    request: { body: agentApiIntegrationLoginBodySchema },
    response: { body: agentApiIntegrationLoginResponseSchema },
  }),
  integrationAppPrepare: route({
    key: "integrationAppPrepare",
    method: "POST",
    path: "/integrations/app/prepare",
    client: { resource: "integrations", method: "prepareApp" },
    capability: "read",
    description: "Prepare a third-party integration registration/update action card.",
    request: { body: agentApiIntegrationAppPrepareBodySchema },
    response: { body: agentApiIntegrationAppPrepareResponseSchema },
  }),
  integrationAppRotateSecret: route({
    key: "integrationAppRotateSecret",
    method: "POST",
    path: "/integrations/app/rotate-secret",
    client: { resource: "integrations", method: "rotateAppSecret" },
    // Mirrors integrationAppPrepare's "read" capability: the AgentApiCapability
    // enum has no generic "mutation"/"integrations" scope, and the sibling
    // integration app routes (prepare/login) all gate on "read". Owner-scope is
    // enforced server-side in rotateClientSecretForAgent's WHERE clause (and the
    // bound agent credential), so the capability tier is not the security
    // boundary here. Keep parity with integrationAppPrepare.
    capability: "read",
    description: "Regenerate the one-time client secret for a source-owned integration app as its owner, delegated rotate maintainer, or a current server admin; invalidates the previous secret.",
    request: { body: agentApiIntegrationAppRotateSecretBodySchema },
    response: { body: agentApiIntegrationAppRotateSecretResponseSchema },
  }),
  integrationAppTransferOwner: route({
    key: "integrationAppTransferOwner",
    method: "POST",
    path: "/integrations/app/transfer-owner",
    client: { resource: "integrations", method: "transferAppOwner" },
    capability: "read",
    description: "Transfer a source-owned integration app to another same-server agent as its owner or a current server admin.",
    request: { body: agentApiIntegrationAppTransferOwnerBodySchema },
    response: { body: agentApiIntegrationAppTransferOwnerResponseSchema },
  }),
  integrationAppUpdate: route({
    key: "integrationAppUpdate",
    method: "POST",
    path: "/integrations/app/update",
    client: { resource: "integrations", method: "updateApp" },
    capability: "read",
    description: "Update a source-owned integration app. The current app owner or a current server admin may update it.",
    request: { body: agentApiIntegrationAppUpdateBodySchema },
    response: { body: agentApiIntegrationAppUpdateResponseSchema },
  }),
  integrationAppManage: route({
    key: "integrationAppManage",
    method: "POST",
    path: "/integrations/app/manage",
    client: { resource: "integrations", method: "manageApp" },
    capability: "read",
    description: "Manage source-owned app distribution, logo reset, Marketplace requests, or deletion as the app owner or a current server admin.",
    request: { body: agentApiIntegrationAppManageBodySchema },
    response: { body: agentApiIntegrationAppManageResponseSchema },
  }),
  integrationAppLogoUpdate: route({
    key: "integrationAppLogoUpdate",
    method: "POST",
    path: "/integrations/app/logo",
    client: { resource: "integrations", method: "updateAppLogo" },
    capability: "read",
    description: "Upload a source-owned app logo as the app owner or a current server admin using multipart form data.",
    request: {},
    response: { body: agentApiIntegrationAppLogoResponseSchema },
  }),
  integrationAppList: route({
    key: "integrationAppList",
    method: "GET",
    path: "/integrations/app",
    client: { resource: "integrations", method: "listApps" },
    capability: "read",
    description: "List pending app registration cards requested by this agent and manageable source-owned apps; current server admins see every source-owned app in the server.",
    request: {},
    response: { body: agentApiIntegrationAppListResponseSchema },
  }),
  integrationAppStatus: route({
    key: "integrationAppStatus",
    method: "GET",
    path: "/integrations/app/status",
    client: { resource: "integrations", method: "getAppStatus" },
    capability: "read",
    description: "Get one requester-visible registration card or manageable source-owned app without disclosing unauthorized app existence.",
    request: { query: agentApiIntegrationAppStatusQuerySchema },
    response: { body: agentApiIntegrationAppStatusResponseSchema },
  }),
  actionPrepare: route({
    key: "actionPrepare",
    method: "POST",
    path: "/prepare-action",
    client: { resource: "actions", method: "prepare" },
    capability: "tasks",
    description: "Prepare an action card for a human to commit.",
    request: { body: agentApiActionPrepareBodySchema },
    response: { body: agentApiActionPrepareResponseSchema },
  }),
  actionWithdraw: route({
    key: "actionWithdraw",
    method: "POST",
    path: "/actions/:messageId/withdraw",
    client: { resource: "actions", method: "withdraw" },
    capability: "tasks",
    description: "Withdraw a question card the bound agent posted, while nobody has answered it; only the agent that asked may. Answered first: 409 ALREADY_ANSWERED with the card's metadata.",
    request: { params: agentApiActionWithdrawParamsSchema },
    response: { body: agentApiActionWithdrawResponseSchema },
  }),
  attachmentUpload: route({
    key: "attachmentUpload",
    method: "POST",
    path: "/upload",
    client: { resource: "attachments", method: "upload" },
    capability: "send",
    description: "Upload a multipart attachment as the bound agent credential.",
    request: {},
    response: { body: agentApiAttachmentUploadResponseSchema },
  }),
  attachmentUploadCapabilities: route({
    key: "attachmentUploadCapabilities",
    method: "GET",
    path: "/attachment-upload-capabilities",
    client: { resource: "attachments", method: "uploadCapabilities" },
    capability: "send",
    description: "Read the server-authoritative direct-upload threshold and plan file limit.",
    request: {},
    response: { body: attachmentUploadCapabilitiesSchema },
  }),
  attachmentUploadSessionCreate: route({
    key: "attachmentUploadSessionCreate",
    method: "POST",
    path: "/attachment-upload-sessions",
    client: { resource: "attachments", method: "createUploadSession" },
    capability: "send",
    description: "Create a direct attachment upload session as the bound agent credential.",
    request: { body: createAttachmentUploadSessionRequestSchema },
    response: { body: createAttachmentUploadSessionResponseSchema },
  }),
  attachmentUploadSessionComplete: route({
    key: "attachmentUploadSessionComplete",
    method: "POST",
    path: "/attachment-upload-sessions/:uploadId/complete",
    client: { resource: "attachments", method: "completeUploadSession" },
    capability: "send",
    description: "Verify and complete a direct attachment upload owned by the bound agent credential.",
    request: { params: attachmentUploadPathParamsSchema },
    response: { body: completeAttachmentUploadSessionResponseSchema },
  }),
  attachmentUploadSessionCancel: route({
    key: "attachmentUploadSessionCancel",
    method: "DELETE",
    path: "/attachment-upload-sessions/:uploadId",
    client: { resource: "attachments", method: "cancelUploadSession" },
    capability: "send",
    description: "Cancel a direct attachment upload owned by the bound agent credential.",
    request: { params: attachmentUploadPathParamsSchema },
    response: { body: attachmentUploadSessionSchema },
  }),
  attachmentUploadSessionStatus: route({
    key: "attachmentUploadSessionStatus",
    method: "GET",
    path: "/attachment-upload-sessions/:uploadId",
    client: { resource: "attachments", method: "uploadSessionStatus" },
    capability: "send",
    description: "Read a direct attachment upload session owned by the bound agent credential.",
    request: { params: attachmentUploadPathParamsSchema },
    response: { body: attachmentUploadSessionSchema },
  }),
  attachmentDownload: route({
    key: "attachmentDownload",
    method: "GET",
    path: "/attachments/:attachmentId",
    client: { resource: "attachments", method: "download" },
    capability: "read",
    description: "Download attachment bytes visible to the bound agent credential.",
    request: { params: agentApiAttachmentDownloadParamsSchema },
    response: { kind: "binary" },
  }),
  attachmentDownloadUrl: route({
    key: "attachmentDownloadUrl",
    method: "GET",
    path: "/attachments/:attachmentId/url",
    client: { resource: "attachments", method: "downloadUrl" },
    capability: "read",
    description: "Mint a short-lived (5 minute) download URL for an attachment visible to the bound agent credential, with its filename and MIME type. 409 download_url_unavailable when this Server's storage cannot presign; use the binary download instead.",
    request: { params: agentApiAttachmentDownloadParamsSchema },
    response: { body: agentApiAttachmentDownloadUrlResponseSchema },
  }),
  attachmentCommentsList: route({
    key: "attachmentCommentsList",
    method: "GET",
    path: "/attachments/:attachmentId/comments",
    client: { resource: "attachments", method: "comments" },
    capability: "read",
    description: "List comments scoped to an attachment visible to the bound agent credential.",
    request: { params: agentApiAttachmentCommentsParamsSchema, query: agentApiAttachmentCommentsQuerySchema },
    response: { body: agentApiAttachmentCommentsResponseSchema },
  }),
  pushWebhookStatus: route({
    key: "pushWebhookStatus",
    method: "GET",
    path: "/push-webhook",
    client: { resource: "pushWebhook", method: "status" },
    capability: "read",
    description: "Read the bound External Agent's inbox push registration and delivery status.",
    request: {},
    response: { body: agentApiPushWebhookStatusResponseSchema },
  }),
  pushWebhookRegister: route({
    key: "pushWebhookRegister",
    method: "PUT",
    path: "/push-webhook",
    client: { resource: "pushWebhook", method: "register" },
    capability: "read",
    description: "Register or replace the bound External Agent's inbox push webhook (raft-agent-inbox-notice.v1); a new registration replaces the secret and re-enables delivery. A personal assistant's registration is set only by its runtime provider while personal_assistant and assistant_wechat_v0 are on for its owner: 403 push_registration_provider_managed.",
    request: { body: agentApiPushWebhookRegisterBodySchema },
    response: { body: agentApiPushWebhookStatusResponseSchema },
  }),
  pushWebhookDelete: route({
    key: "pushWebhookDelete",
    method: "DELETE",
    path: "/push-webhook",
    client: { resource: "pushWebhook", method: "unregister" },
    capability: "read",
    description: "Remove the bound External Agent's inbox push registration. A personal assistant's registration is removed only by its runtime provider while personal_assistant and assistant_wechat_v0 are on for its owner: 403 push_registration_provider_managed.",
    request: {},
    response: { kind: "empty" },
  }),
  mentionsList: route({
    key: "mentionsList",
    method: "GET",
    path: "/mentions",
    client: { resource: "mentions", method: "list" },
    capability: "mentions",
    description: "List notifiable @mentions of the bound agent, newest first.",
    request: { query: agentApiMentionsListQuerySchema },
    response: { body: agentApiMentionsListResponseSchema },
  }),
} as const satisfies Record<string, AgentApiContractRoute>;

/**
 * The whole contract: core's routes, then each first-party app's own
 * (apps/index.ts, in registry order; agentApiRoute.ts mergeAppAgentApis
 * refuses a route key or a client resource and method two of them share).
 */
export const agentApiContract = mergeAppAgentApis(coreAgentApiRoutes, firstPartyAppAgentApis);

export type AgentApiContract = typeof agentApiContract;
/** Every first-party app's routes (their fragments, merged). */
export type FirstPartyAppAgentApiRoutes = AppAgentApiRoutes<typeof firstPartyAppAgentApis>;
/** The contract's own routes, not an app's. */
export type CoreAgentApiRouteKey = keyof typeof coreAgentApiRoutes;
export type AgentApiRouteKey = keyof AgentApiContract;

export type AgentApiRouteManifestEntry = {
  key: AgentApiRouteKey;
  method: AgentApiMethod;
  path: string;
  fullPath: string;
  client: {
    resource: string;
    method: string;
  };
  capability: AgentApiCapability;
  description: string;
  /** Operating metadata from `agentApiRouteMeta.ts`; one vocabulary for CLI, SDK, and tool schemas. */
  sideEffect: AgentApiSideEffect;
  idempotency: AgentApiIdempotency;
  destructive: boolean;
  audience: AgentApiAudience;
  request: {
    params: boolean;
    query: boolean;
    body: boolean;
  };
  response: {
    kind: "json" | "binary" | "empty";
    body: boolean;
  };
};

export function getAgentApiResponseKind(response: AgentApiContractResponse): "json" | "binary" | "empty" {
  return "kind" in response ? response.kind ?? "json" : "json";
}

export function buildAgentApiRouteManifest(): AgentApiRouteManifestEntry[] {
  return Object.values(agentApiContract).map((route) => ({
    key: route.key as AgentApiRouteKey,
    method: route.method,
    path: route.path,
    fullPath: route.fullPath,
    client: route.client,
    capability: route.capability,
    description: route.description,
    ...AGENT_API_ROUTE_META[route.key as AgentApiRouteKey],
    request: {
      params: "params" in route.request && Boolean(route.request.params),
      query: "query" in route.request && Boolean(route.request.query),
      body: "body" in route.request && Boolean(route.request.body),
    },
    response: {
      kind: getAgentApiResponseKind(route.response),
      body: "body" in route.response && Boolean(route.response.body),
    },
  }));
}

/**
 * Content-addressed manifest version: changes whenever any route, its
 * capability, or its operating metadata changes. Clients compare it against
 * the Server's to report skew instead of guessing which side is older.
 * Pure FNV-1a (64-bit, hex) so browsers and Node share one implementation.
 */
export function computeAgentApiManifestVersion(manifest: AgentApiRouteManifestEntry[]): string {
  const text = JSON.stringify(manifest);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

export function buildLegacyAgentApiPath(agentId: string, routePath: string): string {
  return `/internal/agent/${encodeURIComponent(agentId)}${routePath}`;
}

export type AgentApiPushWebhookRegisterBody = z.infer<typeof agentApiPushWebhookRegisterBodySchema>;
export type AgentApiPushWebhookStatusResponse = z.infer<typeof agentApiPushWebhookStatusResponseSchema>;
export type AgentApiMentionsListQuery = z.infer<typeof agentApiMentionsListQuerySchema>;
export type AgentApiMentionInboxRow = z.infer<typeof agentApiMentionInboxRowSchema>;
export type AgentApiMentionsListResponse = z.infer<typeof agentApiMentionsListResponseSchema>;
export type AgentApiEventsQuery = z.infer<typeof agentApiEventsQuerySchema>;
export type AgentApiHistoryQuery = z.infer<typeof agentApiHistoryQuerySchema>;
export type AgentApiKnowledgeGetQuery = z.infer<typeof agentApiKnowledgeGetQuerySchema>;
export type AgentApiKnowledgeGetResponse = z.infer<typeof agentApiKnowledgeGetResponseSchema>;
export type AgentApiKnowledgeSearchQuery = z.infer<typeof agentApiKnowledgeSearchQuerySchema>;
export type AgentApiKnowledgeSearchResult = z.infer<typeof agentApiKnowledgeSearchResultSchema>;
export type AgentApiContextSearchBody = z.infer<typeof agentApiContextSearchBodySchema>;
export type AgentApiContextReadBody = z.infer<typeof agentApiContextReadBodySchema>;
export type AgentApiContextQueryResponse = z.infer<typeof agentApiContextQueryResponseSchema>;
export type AgentApiKnowledgeSearchResponse = z.infer<typeof agentApiKnowledgeSearchResponseSchema>;
export type AgentApiManagedMcpToolsResponse = z.infer<typeof agentApiManagedMcpToolsResponseSchema>;
export type AgentApiManagedMcpCallBody = z.infer<typeof agentApiManagedMcpCallBodySchema>;
export type AgentApiManagedMcpCallResponse = z.infer<typeof agentApiManagedMcpCallResponseSchema>;
export type AgentApiMessageSearchQuery = z.infer<typeof agentApiMessageSearchQuerySchema>;
export type AgentApiMessageResolveParams = z.infer<typeof agentApiMessageResolveParamsSchema>;
export type AgentApiMessageReactionParams = z.infer<typeof agentApiMessageReactionParamsSchema>;
export type AgentApiMessageReactionBody = z.infer<typeof agentApiMessageReactionBodySchema>;
export type AgentApiMessageCardUpdateParams = z.infer<typeof agentApiMessageCardUpdateParamsSchema>;
export type AgentApiChannelMembershipParams = z.infer<typeof agentApiChannelMembershipParamsSchema>;
export type AgentApiChannelMuteBody = z.infer<typeof agentApiChannelMuteBodySchema>;
export type AgentApiChannelLifecycleBody = z.infer<typeof agentApiChannelLifecycleBodySchema>;
export type AgentApiChannelCreateBody = z.infer<typeof agentApiChannelCreateBodySchema>;
export type AgentApiChannelUpdateBody = z.infer<typeof agentApiChannelUpdateBodySchema>;
export type AgentApiChannelMemberBody = z.infer<typeof agentApiChannelMemberBodySchema>;
export type AgentApiChannelMemberRemoveBody = z.infer<typeof agentApiChannelMemberRemoveBodySchema>;
export type AgentApiChannelLeaveBody = z.infer<typeof agentApiChannelLeaveBodySchema>;
export type AgentApiChannelRowResponse = z.infer<typeof agentApiChannelRowResponseSchema>;
export type AgentApiChannelMemberAddResponse = z.infer<typeof agentApiChannelMemberAddResponseSchema>;
export type AgentApiChannelMemberRemoveResponse = z.infer<typeof agentApiChannelMemberRemoveResponseSchema>;
export type AgentApiAttachmentDownloadParams = z.infer<typeof agentApiAttachmentDownloadParamsSchema>;
export type AgentApiChannelMembersQuery = z.infer<typeof agentApiChannelMembersQuerySchema>;
export type AgentApiThreadUnfollowBody = z.infer<typeof agentApiThreadUnfollowBodySchema>;
export type AgentApiThreadFollowBody = z.infer<typeof agentApiThreadFollowBodySchema>;
export type AgentApiThreadFollowResponse = z.infer<typeof agentApiThreadFollowResponseSchema>;
export type AgentApiThreadListItem = z.infer<typeof agentApiThreadListItemSchema>;
export type AgentApiThreadListResponse = z.infer<typeof agentApiThreadListResponseSchema>;
export type AgentApiInboxListQuery = z.infer<typeof agentApiInboxListQuerySchema>;
export type AgentApiAssistantOwnerInboxQuery = z.infer<typeof agentApiAssistantOwnerInboxQuerySchema>;
export type AgentApiAssistantOwnerInboxResponse = z.infer<typeof agentApiAssistantOwnerInboxResponseSchema>;
export type AgentApiAssistantOwnerMessagesQuery = z.infer<typeof agentApiAssistantOwnerMessagesQuerySchema>;
export type AgentApiAssistantSendAsOwnerBody = z.infer<typeof agentApiAssistantSendAsOwnerBodySchema>;
export type AgentApiAssistantOwnerActivityQuery = z.infer<typeof agentApiAssistantOwnerActivityQuerySchema>;
export type AgentApiAssistantOwnerActivityResponse = z.infer<typeof agentApiAssistantOwnerActivityResponseSchema>;
export type AgentApiAssistantOwnerResolveQuery = z.infer<typeof agentApiAssistantOwnerResolveQuerySchema>;
export type AgentApiAssistantOwnerResolveResponse = z.infer<typeof agentApiAssistantOwnerResolveResponseSchema>;
export type AgentApiAssistantCheckStateImportBody = z.infer<typeof agentApiAssistantCheckStateImportBodySchema>;
export type AgentApiAssistantCheckStateImportResponse = z.infer<typeof agentApiAssistantCheckStateImportResponseSchema>;
export type AgentApiAssistantNotifyBody = z.infer<typeof agentApiAssistantNotifyBodySchema>;
export type AgentApiAssistantNotifyResponse = z.infer<typeof agentApiAssistantNotifyResponseSchema>;
export type AgentApiAssistantContactRulesResponse = z.infer<typeof agentApiAssistantContactRulesResponseSchema>;
export type AgentApiAssistantContactRuleAddBody = z.infer<typeof agentApiAssistantContactRuleAddBodySchema>;
export type AgentApiAssistantContactRuleAddResponse = z.infer<typeof agentApiAssistantContactRuleAddResponseSchema>;
export type AgentApiAssistantContactRuleParams = z.infer<typeof agentApiAssistantContactRuleParamsSchema>;
export type AgentApiAssistantConfirmationResponse = z.infer<typeof agentApiAssistantConfirmationResponseSchema>;
export type AgentApiAssistantContactSettingsBody = z.infer<typeof agentApiAssistantContactSettingsBodySchema>;
export type AgentApiAssistantContactSettingsResponse = z.infer<typeof agentApiAssistantContactSettingsResponseSchema>;
export type AgentApiAssistantOwnerSettings = z.infer<typeof agentApiAssistantOwnerSettingsSchema>;
export type AgentApiAssistantOwnerSettingsBody = z.infer<typeof agentApiAssistantOwnerSettingsBodySchema>;
export type AgentApiAssistantOwnerSettingsResponse = z.infer<typeof agentApiAssistantOwnerSettingsResponseSchema>;
export type AgentApiAssistantOwnerSettingsUpdateResponse = z.infer<typeof agentApiAssistantOwnerSettingsUpdateResponseSchema>;
export type AgentApiAssistantContactRulesImportBody = z.infer<typeof agentApiAssistantContactRulesImportBodySchema>;
export type AgentApiAssistantContactRulesImportResponse = z.infer<typeof agentApiAssistantContactRulesImportResponseSchema>;
export type AgentApiAssistantToldBody = z.infer<typeof agentApiAssistantToldBodySchema>;
export type AgentApiAssistantToldResponse = z.infer<typeof agentApiAssistantToldResponseSchema>;
export type AgentApiAssistantToldListQuery = z.infer<typeof agentApiAssistantToldListQuerySchema>;
export type AgentApiAssistantToldListResponse = z.infer<typeof agentApiAssistantToldListResponseSchema>;
export type AgentApiAssistantSendAsOwnerResponse = z.infer<typeof agentApiAssistantSendAsOwnerResponseSchema>;
export type AgentApiAssistantForwardAsOwnerBody = z.infer<typeof agentApiAssistantForwardAsOwnerBodySchema>;
export type AgentApiAssistantForwardAsOwnerResponse = z.infer<typeof agentApiAssistantForwardAsOwnerResponseSchema>;
export type AgentApiAssistantSearchForwardTargetsQuery = z.infer<typeof agentApiAssistantSearchForwardTargetsQuerySchema>;
export type AgentApiAssistantSearchForwardTargetsResponse = z.infer<typeof agentApiAssistantSearchForwardTargetsResponseSchema>;
export type AgentApiAssistantOwnerMessagesResponse = z.infer<typeof agentApiAssistantOwnerMessagesResponseSchema>;
export type AgentApiInboxConversation = z.infer<typeof agentApiInboxConversationSchema>;
export type AgentApiInboxListResponse = z.infer<typeof agentApiInboxListResponseSchema>;
/** RFC 081 D16: the one inbox item row, rendered by the shared formatter in the CLI and the daemon's wake-up. */
export type AgentApiInboxItemRow = z.infer<typeof agentApiInboxItemRowSchema>;
export type AgentApiInboxAckRef = z.infer<typeof agentApiInboxAckRefSchema>;
export type AgentApiInboxApp = z.infer<typeof agentApiInboxAppSchema>;
export type AgentApiInboxRelated = z.infer<typeof agentApiInboxRelatedSchema>;
export type AgentApiInboxLatestSender = z.infer<typeof agentApiInboxLatestSenderSchema>;
export type AgentApiInboxPreLaunch = z.infer<typeof agentApiInboxPreLaunchSchema>;
export type AgentApiInboxOmitted = z.infer<typeof agentApiInboxOmittedSchema>;
export type AgentApiInboxError = z.infer<typeof agentApiInboxErrorSchema>;
export type AgentApiInboxReadBody = z.infer<typeof agentApiInboxReadBodySchema>;
export type AgentApiInboxReadEntry = z.infer<typeof agentApiInboxReadEntrySchema>;
export type AgentApiInboxReadResponse = z.infer<typeof agentApiInboxReadResponseSchema>;
export type AgentApiInboxDismissBody = z.infer<typeof agentApiInboxDismissBodySchema>;
export type AgentApiInboxDismissResponse = z.infer<typeof agentApiInboxDismissResponseSchema>;
export type AgentApiTaskClaimBody = z.infer<typeof agentApiTaskClaimBodySchema>;
export type AgentApiTaskListQuery = z.infer<typeof agentApiTaskListQuerySchema>;
export type AgentApiTaskCreateBody = z.infer<typeof agentApiTaskCreateBodySchema>;
export type AgentApiTaskUnclaimBody = z.infer<typeof agentApiTaskUnclaimBodySchema>;
export type AgentApiTaskAssignBody = z.infer<typeof agentApiTaskAssignBodySchema>;
export type AgentApiTaskUpdateStatusBody = z.infer<typeof agentApiTaskUpdateStatusBodySchema>;
export type AgentApiTaskResourceReceiptBody = z.infer<typeof agentApiTaskResourceReceiptBodySchema>;
export type AgentApiTaskDeleteBody = z.infer<typeof agentApiTaskDeleteBodySchema>;
export type AgentApiTaskConvertBody = z.infer<typeof agentApiTaskConvertBodySchema>;
export type AgentApiTaskAmendBody = z.infer<typeof agentApiTaskAmendBodySchema>;
export type AgentApiTaskHistoryQuery = z.infer<typeof agentApiTaskHistoryQuerySchema>;
export type AgentApiTaskViewQuery = z.infer<typeof agentApiTaskViewQuerySchema>;
export type AgentApiTaskReadQuery = z.infer<typeof agentApiTaskReadQuerySchema>;
export type AgentApiTaskReplyBody = z.infer<typeof agentApiTaskReplyBodySchema>;
export type AgentApiTaskFollowBody = z.infer<typeof agentApiTaskFollowBodySchema>;
export type AgentApiTaskUnfollowBody = z.infer<typeof agentApiTaskUnfollowBodySchema>;
export type AgentApiTaskViewResponse = z.infer<typeof agentApiTaskViewResponseSchema>;
export type AgentApiTaskFollowResponse = z.infer<typeof agentApiTaskFollowResponseSchema>;
export type AgentApiTaskFollowingQuery = z.infer<typeof agentApiTaskFollowingQuerySchema>;
export type AgentApiTaskFollowingResponse = z.infer<typeof agentApiTaskFollowingResponseSchema>;
export type AgentApiTaskIdleNudgeBody = z.infer<typeof agentApiTaskIdleNudgeBodySchema>;
export type AgentApiTaskIdleNudgeItem = z.infer<typeof agentApiTaskIdleNudgeItemSchema>;
export type AgentApiTaskIdleNudgeBacklogItem = z.infer<typeof agentApiTaskIdleNudgeBacklogItemSchema>;
export type AgentApiTaskIdleNudgeResponse = z.infer<typeof agentApiTaskIdleNudgeResponseSchema>;
export type AgentApiReminderListQuery = z.infer<typeof agentApiReminderListQuerySchema>;
export type AgentApiReminderParams = z.infer<typeof agentApiReminderParamsSchema>;
export type AgentApiReminderScheduleBody = z.infer<typeof agentApiReminderScheduleBodySchema>;
export type AgentApiReminderSnoozeBody = z.infer<typeof agentApiReminderSnoozeBodySchema>;
export type AgentApiReminderUpdateBody = z.infer<typeof agentApiReminderUpdateBodySchema>;
export type AgentApiAppSourceAckBody = z.infer<typeof agentApiAppSourceAckBodySchema>;
export type AgentApiReminderListResponse = z.infer<typeof agentApiReminderListResponseSchema>;
export type AgentApiReminderResponse = z.infer<typeof agentApiReminderResponseSchema>;
export type AgentApiReminderLogResponse = z.infer<typeof agentApiReminderLogResponseSchema>;
export type AgentApiAppSourceAckResponse = z.infer<typeof agentApiAppSourceAckResponseSchema>;
export type AgentApiAppSourceAckRejectCode = z.infer<typeof agentApiAppSourceAckRejectCodeSchema>;
export type AgentApiAppSourceAckRejectResponse = z.infer<typeof agentApiAppSourceAckRejectResponseSchema>;
export type AgentApiAppConfigParams = z.infer<typeof agentApiAppConfigParamsSchema>;
export type AgentApiAppConfigPatchBody = z.infer<typeof agentApiAppConfigPatchBodySchema>;
export type AgentApiAppConfigResponse = z.infer<typeof agentApiAppConfigResponseSchema>;
export type AgentApiProfileShowQuery = z.infer<typeof agentApiProfileShowQuerySchema>;
export type AgentApiProfileUpdateBody = z.infer<typeof agentApiProfileUpdateBodySchema>;
export type AgentApiIntegrationTokenBody = z.infer<typeof agentApiIntegrationTokenBodySchema>;
export type AgentApiIntegrationTokenResponse = z.infer<typeof agentApiIntegrationTokenResponseSchema>;
export type AgentApiIntegrationLoginBody = z.infer<typeof agentApiIntegrationLoginBodySchema>;
export type AgentApiIntegrationMarketplaceQuery = z.infer<typeof agentApiIntegrationMarketplaceQuerySchema>;
export type AgentApiIntegrationAppPrepareBody = z.infer<typeof agentApiIntegrationAppPrepareBodySchema>;
export type AgentApiIntegrationAppStatusQuery = z.infer<typeof agentApiIntegrationAppStatusQuerySchema>;
export type AgentApiActionCardWire = z.infer<typeof agentApiActionCardWireSchema>;
export type AgentApiActionPrepareBody = z.infer<typeof agentApiActionPrepareBodySchema>;
export type AgentApiActionWithdrawParams = z.infer<typeof agentApiActionWithdrawParamsSchema>;
export type AgentApiAttachmentUploadResponse = z.infer<typeof agentApiAttachmentUploadResponseSchema>;
export type AgentApiAttachmentUploadCapabilitiesResponse = z.infer<typeof attachmentUploadCapabilitiesSchema>;
export type AgentApiAttachmentUploadSessionCreateBody = z.infer<typeof createAttachmentUploadSessionRequestSchema>;
export type AgentApiAttachmentUploadSessionCreateResponse = z.infer<typeof createAttachmentUploadSessionResponseSchema>;
export type AgentApiAttachmentUploadSessionCompleteResponse = z.infer<typeof completeAttachmentUploadSessionResponseSchema>;
export type AgentApiAttachmentUploadSessionResponse = z.infer<typeof attachmentUploadSessionSchema>;
export type AgentApiAttachmentDownloadResponse = Uint8Array;
export type AgentApiAttachmentDownloadUrlResponse = z.infer<typeof agentApiAttachmentDownloadUrlResponseSchema>;

/*
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
  external_message?: z.infer<typeof agentApiExternalMessageProvenanceSchema>;
  mentioned?: boolean;
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
*/
export interface AgentApiEventsInboxHint {
  unread_conversations: number;
  command: "raft inbox check";
}

export interface AgentApiEventsResponse {
  events: AgentApiMessageEnvelope[];
  last_seen_msgId: string | null;
  last_seen_seq: number | null;
  reply_target: string | null;
  /** @deprecated Always `[]`; kept only for older clients that require it. */
  pending_notice_ids?: string[];
  /** @deprecated Always `null`; kept only for older clients that require it. */
  wake_reason?: string | null;
  has_more: boolean;
  inbox_hint?: AgentApiEventsInboxHint | null;
  /** "cursor": acknowledged by the next request whose `since` covers it; "immediate": already acknowledged. */
  ack_mode?: "cursor" | "immediate";
  /** `wait_for` only: the inbox chain is still behind a pair (`has_more` is true); ask again (wait_attempt + 1) after this many ms. */
  retry_after_ms?: number;
  /**
   * Task #178 (managed runners only): third-party events leased to this batch,
   * injected by the daemon proxy; the CLI acks `batch_id` on the daemon after
   * writing the bodies out. Not part of the server contract (passthrough).
   */
  third_party_lease?: { batch_id: string; event_ids: string[]; expires_at: string } | null;
  [key: string]: unknown;
}

export interface AgentApiHistoryResponse {
  consumption_scope?: AgentApiHistoryConsumptionScope;
  taskCommandHint?: string;
  messages: AgentApiMessageEnvelope[];
  has_more: boolean;
  has_older: boolean;
  has_newer: boolean;
  last_read_seq?: number | null;
  model_seen_up_to_seq?: number | null;
  /** The card of the channel this read is in (for a thread, its parent channel). */
  channel_card?: AgentApiChannelCard;
  /** The other side of a DM (or of a thread in one). */
  peer_card?: AgentApiPeerCard;
  [key: string]: unknown;
}

export type AgentApiMessageResolveResponse = z.infer<typeof agentApiMessageResolveResponseSchema>;
export type AgentApiMessageSearchResponse = z.infer<typeof agentApiMessageSearchResponseSchema>;
export type AgentApiChannelMembersResponse = z.infer<typeof agentApiChannelMembersResponseSchema>;

export type AgentApiTaskClaimConflict = z.infer<typeof agentApiTaskClaimConflictSchema>;

export interface AgentApiTaskClaimResult {
  taskNumber?: number;
  messageId?: string;
  conversationMessageId?: string;
  taskRef?: string;
  success: boolean;
  reason?: string;
  conflict?: AgentApiTaskClaimConflict;
  [key: string]: unknown;
}

export interface AgentApiTaskClaimSuccessResponse {
  results: AgentApiTaskClaimResult[];
  [key: string]: unknown;
}

export type AgentApiTaskClaimResponse = AgentApiTaskClaimSuccessResponse | AgentApiHeldFreshnessResponse;

export interface AgentApiTaskEnvelope {
  taskNumber?: number;
  status?: string;
  title?: string;
  description?: string | null;
  revision?: number | null;
  claimedByName?: string | null;
  createdByName?: string | null;
  createdByHandle?: string | null;
  createdByMembershipStatus?: "active" | "left" | "removed" | null;
  messageId?: string | null;
  sourceMessageId?: string | null;
  conversationAnchored?: boolean;
  conversationPending?: boolean;
  channelRef?: string;
  isLegacy?: boolean;
  requiresResourceReceipt?: boolean;
  resourceReceipt?: TaskResourceReceipt | null;
  resourceReceiptRecordedAt?: string | null;
  resourceTeardownOwnerAgentId?: string | null;
  resourceExpiryFollowupId?: string | null;
  [key: string]: unknown;
}

export interface AgentApiTaskListResponse {
  tasks: AgentApiTaskEnvelope[];
  scope?: "channel" | "mine";
  coverage?: {
    status: "incomplete";
    visibleChannelTypes: Array<"channel" | "private" | "joint" | "dm">;
    includesArchived: boolean;
    inaccessibleScope: "not_asserted";
    reason: string;
    [key: string]: unknown;
  };
  pagination?: {
    mode: "complete";
    truncated: false;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface AgentApiCreatedTaskEnvelope {
  taskNumber: number;
  messageId: string;
  title: string;
  status: TaskStatus;
  claimedByType: "user" | "agent" | null;
  claimedById: string | null;
  claimedAt: string | null;
  requiresResourceReceipt: boolean;
  conversationAnchored?: true;
  sourceMessageId?: string | null;
  /** Task v2: the thread reply given as the source; `sourceMessageId` is its thread's root. */
  sourceThreadReplyId?: string;
  [key: string]: unknown;
}

export interface AgentApiTaskCreateSuccessResponse {
  tasks: AgentApiCreatedTaskEnvelope[];
  assignmentReceipt?: {
    messageId: string;
    content: string;
    assignee: string;
    state: "started" | "assigned";
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type AgentApiTaskCreateResponse = AgentApiTaskCreateSuccessResponse | AgentApiHeldFreshnessResponse;

export interface AgentApiTaskUnclaimSuccessResponse {
  ok: true;
  taskRef?: string;
  title?: string;
  unseen?: AgentApiTaskWriteUnseen;
  [key: string]: unknown;
}

export interface AgentApiTaskAssignSuccessResponse {
  ok: true;
  revision: number;
  assignee: string | null;
  taskRef?: string;
  [key: string]: unknown;
}

export type AgentApiTaskUnclaimResponse = AgentApiTaskUnclaimSuccessResponse | AgentApiHeldFreshnessResponse;
export type AgentApiTaskAssignResponse = AgentApiTaskAssignSuccessResponse | AgentApiHeldFreshnessResponse;

export interface AgentApiTaskUpdateStatusSuccessResponse {
  ok: true;
  /** The status the server stored (a task v2 task asked for in_review stores in_progress). */
  status?: TaskStatus;
  taskRef?: string;
  title?: string;
  unseen?: AgentApiTaskWriteUnseen;
  [key: string]: unknown;
}

export type AgentApiTaskUpdateStatusResponse = AgentApiTaskUpdateStatusSuccessResponse | AgentApiHeldFreshnessResponse;
export type AgentApiTaskResourceReceiptResponse = z.infer<typeof agentApiTaskResourceReceiptResponseSchema>;
export type AgentApiTaskDeleteResponse = z.infer<typeof agentApiTaskDeleteResponseSchema>;
export type AgentApiTaskConvertResponse = z.infer<typeof agentApiTaskConvertResponseSchema>;

export type AgentApiTaskAmendSuccessResponse = z.infer<typeof agentApiTaskAmendSuccessResponseSchema>;
export type AgentApiTaskAmendResponse = AgentApiTaskAmendSuccessResponse | AgentApiHeldFreshnessResponse;
export type AgentApiTaskHistoryResponse = z.infer<typeof agentApiTaskHistoryResponseSchema>;

export type AgentApiProfileView = z.infer<typeof agentApiProfileViewSchema>;
export type AgentApiOkResponse = z.infer<typeof agentApiOkResponseSchema>;
export type AgentApiChannelLeaveResponse = z.infer<typeof agentApiChannelLeaveResponseSchema>;
export type AgentApiActionPrepareResponse = z.infer<typeof agentApiActionPrepareResponseSchema>;
export type AgentApiActionWithdrawResponse = z.infer<typeof agentApiActionWithdrawResponseSchema>;

export type AgentApiAgentContextResponse = z.infer<typeof agentApiAgentContextResponseSchema>;
export type AgentApiServerInfoResponse = z.infer<typeof agentApiServerInfoResponseSchema>;
export type AgentApiServerInfoQuery = z.infer<typeof agentApiServerInfoQuerySchema>;
export type AgentApiUserChannelsParams = z.infer<typeof agentApiUserChannelsParamsSchema>;
export type AgentApiUserChannelsQuery = z.infer<typeof agentApiUserChannelsQuerySchema>;
export type AgentApiUserChannelsResponse = z.infer<typeof agentApiUserChannelsResponseSchema>;
export type AgentApiServerUpdateBody = z.infer<typeof agentApiServerUpdateBodySchema>;
export type AgentApiServerLabsResponse = z.infer<typeof agentApiServerLabsResponseSchema>;
export type AgentApiServerLabsMutationBody = z.infer<typeof agentApiServerLabsMutationBodySchema>;
export type AgentApiServerLabParams = z.infer<typeof agentApiServerLabParamsSchema>;
export type AgentApiServerLabsMutationResponse = z.infer<typeof agentApiServerLabsMutationResponseSchema>;
export type AgentApiServerUpdateResponse = z.infer<typeof agentApiServerUpdateResponseSchema>;
export type AgentApiMentionActionsPendingQuery = z.infer<typeof agentApiMentionActionsPendingQuerySchema>;
export type AgentApiMentionActionsPendingResponse = z.infer<typeof agentApiMentionActionsPendingResponseSchema>;
export type AgentApiSenderMentionDeliveriesParams = z.infer<typeof agentApiSenderMentionDeliveriesParamsSchema>;
export type AgentApiSenderMentionDeliveriesResponse = z.infer<typeof agentApiSenderMentionDeliveriesResponseSchema>;
export type AgentApiMentionActionsExecuteBody = z.infer<typeof agentApiMentionActionsExecuteBodySchema>;
export type AgentApiMentionActionsExecuteResponse = z.infer<typeof agentApiMentionActionsExecuteResponseSchema>;
export type AgentApiResolveChannelBody = z.infer<typeof agentApiResolveChannelBodySchema>;
export type AgentApiResolveChannelResponse = z.infer<typeof agentApiResolveChannelResponseSchema>;
export type AgentApiChannelMuteResponse = z.infer<typeof agentApiChannelMuteResponseSchema>;
export type AgentApiChannelArchiveResponse = z.infer<typeof agentApiChannelArchiveResponseSchema>;
export type AgentApiChannelUnarchiveResponse = z.infer<typeof agentApiChannelUnarchiveResponseSchema>;
export type AgentApiIntegrationListQuery = z.infer<typeof agentApiIntegrationListQuerySchema>;
export type AgentApiIntegrationListResponse = z.infer<typeof agentApiIntegrationListResponseSchema>;
export type AgentApiIntegrationMcpApp = z.infer<typeof agentApiIntegrationMcpAppSchema>;
export type AgentApiIntegrationMarketplaceResponse = z.infer<typeof agentApiIntegrationMarketplaceResponseSchema>;
export type AgentApiIntegrationLoginResponse = z.infer<typeof agentApiIntegrationLoginResponseSchema>;
export type AgentApiIntegrationAppPrepareResponse = z.infer<typeof agentApiIntegrationAppPrepareResponseSchema>;
export type AgentApiIntegrationAppRotateSecretBody = z.infer<typeof agentApiIntegrationAppRotateSecretBodySchema>;
export type AgentApiIntegrationAppRotateSecretResponse = z.infer<typeof agentApiIntegrationAppRotateSecretResponseSchema>;
export type AgentApiIntegrationAppTransferOwnerBody = z.infer<typeof agentApiIntegrationAppTransferOwnerBodySchema>;
export type AgentApiIntegrationAppTransferOwnerResponse = z.infer<typeof agentApiIntegrationAppTransferOwnerResponseSchema>;
export type AgentApiIntegrationAppUpdateBody = z.infer<typeof agentApiIntegrationAppUpdateBodySchema>;
export type AgentApiIntegrationAppUpdateResponse = z.infer<typeof agentApiIntegrationAppUpdateResponseSchema>;
export type AgentApiIntegrationAppManageBody = z.infer<typeof agentApiIntegrationAppManageBodySchema>;
export type AgentApiIntegrationAppManageResponse = z.infer<typeof agentApiIntegrationAppManageResponseSchema>;
export type AgentApiIntegrationAppLogoResponse = z.infer<typeof agentApiIntegrationAppLogoResponseSchema>;
export type AgentApiOwnedIntegrationApp = z.infer<typeof agentApiOwnedIntegrationAppSchema>;
export type AgentApiIntegrationAppListResponse = z.infer<typeof agentApiIntegrationAppListResponseSchema>;
export type AgentApiIntegrationAppStatusResponse = z.infer<typeof agentApiIntegrationAppStatusResponseSchema>;
export type AgentApiAttachmentCommentsParams = z.infer<typeof agentApiAttachmentCommentsParamsSchema>;
export type AgentApiAttachmentCommentsQuery = z.infer<typeof agentApiAttachmentCommentsQuerySchema>;
export type AgentApiAttachmentCommentsResponse = z.infer<typeof agentApiAttachmentCommentsResponseSchema>;
export type AgentApiFeedbackLocatorIngestBody = z.infer<typeof agentApiFeedbackLocatorIngestBodySchema>;
export type AgentApiFeedbackLocatorAcceptance = z.infer<typeof agentApiFeedbackLocatorAcceptanceSchema>;
export type AgentApiFeedbackLocatorListQuery = z.infer<typeof agentApiFeedbackLocatorListQuerySchema>;
export type AgentApiFeedbackLocatorListResponse = z.infer<typeof agentApiFeedbackLocatorListResponseSchema>;

type CoreAgentApiRequestParamsByRoute = {
  raftbenchFindings: never;
  raftbenchContext: never;
  raftbenchSubmit: never;
  feedbackLocatorIngest: never;
  feedbackLocatorList: never;
  events: never;
  historyRead: never;
  knowledgeGet: never;
  contextSearch: never;
  contextRead: never;
  knowledgeSearch: never;
  managedMcpTools: never;
  managedMcpCall: never;
  messageSend: never;
  messageSendV2: never;
  messageResolve: AgentApiMessageResolveParams;
  messageSearch: never;
  messageReactionAdd: AgentApiMessageReactionParams;
  messageReactionRemove: AgentApiMessageReactionParams;
  messageCardUpdate: AgentApiMessageCardUpdateParams;
  attachmentDownload: AgentApiAttachmentDownloadParams;
  attachmentDownloadUrl: AgentApiAttachmentDownloadParams;
  attachmentCommentsList: AgentApiAttachmentCommentsParams;
  channelJoin: AgentApiChannelMembershipParams;
  channelLeave: AgentApiChannelMembershipParams;
  channelMute: AgentApiChannelMembershipParams;
  channelUnmute: AgentApiChannelMembershipParams;
  channelArchive: never;
  channelUnarchive: never;
  channelCreate: never;
  channelUpdate: AgentApiChannelMembershipParams;
  channelMemberAdd: AgentApiChannelMembershipParams;
  channelMemberRemove: AgentApiChannelMembershipParams;
  channelMembers: never;
  resolveChannel: never;
  threadFollow: never;
  threadUnfollow: never;
  threadList: never;
  inboxList: never;
  inboxRead: never;
  inboxDismiss: never;
  assistantOwnerInbox: never;
  assistantOwnerMessages: never;
  assistantSendAsOwner: never;
  assistantForwardAsOwner: never;
  assistantSearchForwardTargets: never;
  assistantOwnerArtifact: never;
  assistantOwnerArtifactPublish: never;
  assistantOwnerActivity: never;
  assistantNotify: never;
  assistantOwnerResolve: never;
  assistantCheckStateImport: never;
  assistantContactRules: never;
  assistantContactRuleAdd: never;
  assistantContactRuleRemove: AgentApiAssistantContactRuleParams;
  assistantContactSettings: never;
  assistantOwnerSettings: never;
  assistantOwnerSettingsUpdate: never;
  assistantContactRulesImport: never;
  assistantToldRecord: never;
  assistantToldList: never;
  agentContext: never;
  serverInfo: never;
  userChannels: AgentApiUserChannelsParams;
  serverUpdate: never;
  serverLabs: never;
  serverLabsAccess: never;
  serverLabEnrollment: AgentApiServerLabParams;
  mentionActionsPending: never;
  senderMentionDeliveries: AgentApiSenderMentionDeliveriesParams;
  mentionActionsExecute: never;
  taskClaim: never;
  taskList: never;
  taskCreate: never;
  taskUnclaim: never;
  taskAssign: never;
  taskUpdateStatus: never;
  taskResourceReceipt: never;
  taskDelete: never;
  taskConvert: never;
  taskAmend: never;
  taskHistory: never;
  taskView: never;
  taskFollowing: never;
  taskRead: never;
  taskReply: never;
  taskFollow: never;
  taskUnfollow: never;
  taskIdleNudge: never;
  migrationRetry: never;
  reminderList: never;
  reminderCreate: never;
  reminderCancel: AgentApiReminderParams;
  reminderSnooze: AgentApiReminderParams;
  reminderUpdate: AgentApiReminderParams;
  appSourceAck: never;
  reminderLog: AgentApiReminderParams;
  appConfigGet: AgentApiAppConfigParams;
  appConfigPatch: AgentApiAppConfigParams;
  profileShow: never;
  profileUpdate: never;
  profileAvatarUpdate: never;
  integrationList: never;
  integrationMarketplaceSearch: never;
  integrationToken: never;
  integrationLogin: never;
  integrationAppPrepare: never;
  integrationAppRotateSecret: never;
  integrationAppTransferOwner: never;
  integrationAppUpdate: never;
  integrationAppManage: never;
  integrationAppLogoUpdate: never;
  integrationAppList: never;
  integrationAppStatus: never;
  actionPrepare: never;
  actionWithdraw: AgentApiActionWithdrawParams;
  attachmentUpload: never;
  attachmentUploadCapabilities: never;
  attachmentUploadSessionCreate: never;
  attachmentUploadSessionComplete: z.infer<typeof attachmentUploadPathParamsSchema>;
  attachmentUploadSessionCancel: z.infer<typeof attachmentUploadPathParamsSchema>;
  attachmentUploadSessionStatus: z.infer<typeof attachmentUploadPathParamsSchema>;
  pushWebhookStatus: never;
  pushWebhookRegister: never;
  pushWebhookDelete: never;
  mentionsList: never;
};
/** Core's entries by hand; each app route's from its own schemas. */
export type AgentApiRequestParamsByRoute = CoreAgentApiRequestParamsByRoute & {
  -readonly [K in keyof FirstPartyAppAgentApiRoutes]: AgentApiParamsOf<FirstPartyAppAgentApiRoutes[K]>;
};

type CoreAgentApiRequestQueryByRoute = {
  raftbenchFindings: RaftbenchFindingsQuery;
  raftbenchContext: RaftbenchContextQuery;
  raftbenchSubmit: never;
  feedbackLocatorIngest: never;
  feedbackLocatorList: AgentApiFeedbackLocatorListQuery;
  events: AgentApiEventsQuery;
  historyRead: AgentApiHistoryQuery;
  knowledgeGet: AgentApiKnowledgeGetQuery;
  contextSearch: never;
  contextRead: never;
  knowledgeSearch: AgentApiKnowledgeSearchQuery;
  managedMcpTools: never;
  managedMcpCall: never;
  messageSend: never;
  messageSendV2: never;
  messageResolve: never;
  messageSearch: AgentApiMessageSearchQuery;
  messageReactionAdd: never;
  messageReactionRemove: never;
  messageCardUpdate: never;
  attachmentDownload: never;
  attachmentDownloadUrl: never;
  attachmentCommentsList: AgentApiAttachmentCommentsQuery;
  channelJoin: never;
  channelLeave: never;
  channelMute: never;
  channelUnmute: never;
  channelArchive: never;
  channelUnarchive: never;
  channelCreate: never;
  channelUpdate: never;
  channelMemberAdd: never;
  channelMemberRemove: never;
  channelMembers: AgentApiChannelMembersQuery;
  resolveChannel: never;
  threadFollow: never;
  threadUnfollow: never;
  threadList: never;
  inboxList: AgentApiInboxListQuery;
  inboxRead: never;
  inboxDismiss: never;
  assistantOwnerInbox: AgentApiAssistantOwnerInboxQuery;
  assistantOwnerMessages: AgentApiAssistantOwnerMessagesQuery;
  assistantSendAsOwner: never;
  assistantForwardAsOwner: never;
  assistantSearchForwardTargets: AgentApiAssistantSearchForwardTargetsQuery;
  assistantOwnerArtifact: AgentApiAssistantOwnerArtifactQuery;
  assistantOwnerArtifactPublish: never;
  assistantOwnerActivity: AgentApiAssistantOwnerActivityQuery;
  assistantNotify: never;
  assistantOwnerResolve: AgentApiAssistantOwnerResolveQuery;
  assistantCheckStateImport: never;
  assistantContactRules: never;
  assistantContactRuleAdd: never;
  assistantContactRuleRemove: never;
  assistantContactSettings: never;
  assistantOwnerSettings: never;
  assistantOwnerSettingsUpdate: never;
  assistantContactRulesImport: never;
  assistantToldRecord: never;
  assistantToldList: AgentApiAssistantToldListQuery;
  agentContext: never;
  serverInfo: AgentApiServerInfoQuery;
  userChannels: AgentApiUserChannelsQuery;
  serverUpdate: never;
  serverLabs: never;
  serverLabsAccess: never;
  serverLabEnrollment: never;
  mentionActionsPending: AgentApiMentionActionsPendingQuery;
  senderMentionDeliveries: never;
  mentionActionsExecute: never;
  taskClaim: never;
  taskList: AgentApiTaskListQuery;
  taskCreate: never;
  taskUnclaim: never;
  taskAssign: never;
  taskUpdateStatus: never;
  taskResourceReceipt: never;
  taskDelete: never;
  taskConvert: never;
  taskAmend: never;
  taskHistory: AgentApiTaskHistoryQuery;
  taskView: AgentApiTaskViewQuery;
  taskFollowing: AgentApiTaskFollowingQuery;
  taskRead: AgentApiTaskReadQuery;
  taskReply: never;
  taskFollow: never;
  taskUnfollow: never;
  taskIdleNudge: never;
  migrationRetry: never;
  reminderList: AgentApiReminderListQuery;
  reminderCreate: never;
  reminderCancel: never;
  reminderSnooze: never;
  reminderUpdate: never;
  appSourceAck: never;
  reminderLog: never;
  appConfigGet: never;
  appConfigPatch: never;
  profileShow: AgentApiProfileShowQuery;
  profileUpdate: never;
  profileAvatarUpdate: never;
  integrationList: AgentApiIntegrationListQuery;
  integrationMarketplaceSearch: AgentApiIntegrationMarketplaceQuery;
  integrationToken: never;
  integrationLogin: never;
  integrationAppPrepare: never;
  integrationAppRotateSecret: never;
  integrationAppTransferOwner: never;
  integrationAppUpdate: never;
  integrationAppManage: never;
  integrationAppLogoUpdate: never;
  integrationAppList: never;
  integrationAppStatus: AgentApiIntegrationAppStatusQuery;
  actionPrepare: never;
  actionWithdraw: never;
  attachmentUpload: never;
  attachmentUploadCapabilities: never;
  attachmentUploadSessionCreate: never;
  attachmentUploadSessionComplete: never;
  attachmentUploadSessionCancel: never;
  attachmentUploadSessionStatus: never;
  pushWebhookStatus: never;
  pushWebhookRegister: never;
  pushWebhookDelete: never;
  mentionsList: AgentApiMentionsListQuery;
};
/** Core's entries by hand; each app route's from its own schemas. */
export type AgentApiRequestQueryByRoute = CoreAgentApiRequestQueryByRoute & {
  -readonly [K in keyof FirstPartyAppAgentApiRoutes]: AgentApiQueryOf<FirstPartyAppAgentApiRoutes[K]>;
};

type CoreAgentApiRequestBodyByRoute = {
  raftbenchFindings: never;
  raftbenchContext: never;
  raftbenchSubmit: RaftbenchReport;
  feedbackLocatorIngest: AgentApiFeedbackLocatorIngestBody;
  feedbackLocatorList: never;
  events: never;
  historyRead: never;
  knowledgeGet: never;
  contextSearch: AgentApiContextSearchBody;
  contextRead: AgentApiContextReadBody;
  knowledgeSearch: never;
  managedMcpTools: never;
  managedMcpCall: AgentApiManagedMcpCallBody;
  messageSend: AgentApiSendBody;
  messageSendV2: AgentApiSendV2Body;
  messageResolve: never;
  messageSearch: never;
  messageReactionAdd: AgentApiMessageReactionBody;
  messageReactionRemove: AgentApiMessageReactionBody;
  messageCardUpdate: AgentApiMessageCardUpdateBody;
  attachmentDownload: never;
  attachmentDownloadUrl: never;
  attachmentCommentsList: never;
  channelJoin: never;
  channelLeave: AgentApiChannelLeaveBody;
  channelMute: AgentApiChannelMuteBody;
  channelUnmute: never;
  channelArchive: AgentApiChannelLifecycleBody;
  channelUnarchive: AgentApiChannelLifecycleBody;
  channelCreate: AgentApiChannelCreateBody;
  channelUpdate: AgentApiChannelUpdateBody;
  channelMemberAdd: AgentApiChannelMemberBody;
  channelMemberRemove: AgentApiChannelMemberRemoveBody;
  channelMembers: never;
  resolveChannel: AgentApiResolveChannelBody;
  threadFollow: AgentApiThreadFollowBody;
  threadUnfollow: AgentApiThreadUnfollowBody;
  threadList: never;
  inboxList: never;
  inboxRead: AgentApiInboxReadBody;
  inboxDismiss: AgentApiInboxDismissBody;
  assistantOwnerInbox: never;
  assistantOwnerMessages: never;
  assistantSendAsOwner: AgentApiAssistantSendAsOwnerBody;
  assistantForwardAsOwner: AgentApiAssistantForwardAsOwnerBody;
  assistantSearchForwardTargets: never;
  assistantOwnerArtifact: never;
  assistantOwnerArtifactPublish: AgentApiAssistantOwnerArtifactPublishBody;
  assistantOwnerActivity: never;
  assistantNotify: AgentApiAssistantNotifyBody;
  assistantOwnerResolve: never;
  assistantCheckStateImport: AgentApiAssistantCheckStateImportBody;
  assistantContactRules: never;
  assistantContactRuleAdd: AgentApiAssistantContactRuleAddBody;
  assistantContactRuleRemove: never;
  assistantContactSettings: AgentApiAssistantContactSettingsBody;
  assistantOwnerSettings: never;
  assistantOwnerSettingsUpdate: AgentApiAssistantOwnerSettingsBody;
  assistantContactRulesImport: AgentApiAssistantContactRulesImportBody;
  assistantToldRecord: AgentApiAssistantToldBody;
  assistantToldList: never;
  agentContext: never;
  serverInfo: never;
  userChannels: never;
  serverUpdate: AgentApiServerUpdateBody;
  serverLabs: never;
  serverLabsAccess: AgentApiServerLabsMutationBody;
  serverLabEnrollment: AgentApiServerLabsMutationBody;
  mentionActionsPending: never;
  senderMentionDeliveries: never;
  mentionActionsExecute: AgentApiMentionActionsExecuteBody;
  taskClaim: AgentApiTaskClaimBody;
  taskList: never;
  taskCreate: AgentApiTaskCreateBody;
  taskUnclaim: AgentApiTaskUnclaimBody;
  taskAssign: AgentApiTaskAssignBody;
  taskUpdateStatus: AgentApiTaskUpdateStatusBody;
  taskResourceReceipt: AgentApiTaskResourceReceiptBody;
  taskDelete: AgentApiTaskDeleteBody;
  taskConvert: AgentApiTaskConvertBody;
  taskAmend: AgentApiTaskAmendBody;
  taskHistory: never;
  taskView: never;
  taskFollowing: never;
  taskRead: never;
  taskReply: AgentApiTaskReplyBody;
  taskFollow: AgentApiTaskFollowBody;
  taskUnfollow: AgentApiTaskUnfollowBody;
  taskIdleNudge: AgentApiTaskIdleNudgeBody;
  migrationRetry: never;
  reminderList: never;
  reminderCreate: AgentApiReminderScheduleBody;
  reminderCancel: never;
  reminderSnooze: AgentApiReminderSnoozeBody;
  reminderUpdate: AgentApiReminderUpdateBody;
  appSourceAck: AgentApiAppSourceAckBody;
  reminderLog: never;
  appConfigGet: never;
  appConfigPatch: AgentApiAppConfigPatchBody;
  profileShow: never;
  profileUpdate: AgentApiProfileUpdateBody;
  profileAvatarUpdate: never;
  integrationList: never;
  integrationMarketplaceSearch: never;
  integrationToken: AgentApiIntegrationTokenBody;
  integrationLogin: AgentApiIntegrationLoginBody;
  integrationAppPrepare: AgentApiIntegrationAppPrepareBody;
  integrationAppRotateSecret: AgentApiIntegrationAppRotateSecretBody;
  integrationAppTransferOwner: AgentApiIntegrationAppTransferOwnerBody;
  integrationAppUpdate: AgentApiIntegrationAppUpdateBody;
  integrationAppManage: AgentApiIntegrationAppManageBody;
  integrationAppLogoUpdate: never;
  integrationAppList: never;
  integrationAppStatus: never;
  actionPrepare: AgentApiActionPrepareBody;
  actionWithdraw: never;
  attachmentUpload: never;
  attachmentUploadCapabilities: never;
  attachmentUploadSessionCreate: z.infer<typeof createAttachmentUploadSessionRequestSchema>;
  attachmentUploadSessionComplete: never;
  attachmentUploadSessionCancel: never;
  attachmentUploadSessionStatus: never;
  pushWebhookStatus: never;
  pushWebhookRegister: AgentApiPushWebhookRegisterBody;
  pushWebhookDelete: never;
  mentionsList: never;
};
/** Core's entries by hand; each app route's from its own schemas. */
export type AgentApiRequestBodyByRoute = CoreAgentApiRequestBodyByRoute & {
  -readonly [K in keyof FirstPartyAppAgentApiRoutes]: AgentApiBodyOf<FirstPartyAppAgentApiRoutes[K]>;
};

type CoreAgentApiResponseByRoute = {
  raftbenchFindings: RaftbenchFindingsResponse;
  raftbenchContext: RaftbenchContextResponse;
  raftbenchSubmit: RaftbenchSubmitResponse;
  feedbackLocatorIngest: AgentApiFeedbackLocatorAcceptance;
  feedbackLocatorList: AgentApiFeedbackLocatorListResponse;
  events: AgentApiEventsResponse;
  historyRead: AgentApiHistoryResponse;
  knowledgeGet: AgentApiKnowledgeGetResponse;
  contextSearch: AgentApiContextQueryResponse;
  contextRead: AgentApiContextQueryResponse;
  knowledgeSearch: AgentApiKnowledgeSearchResponse;
  managedMcpTools: AgentApiManagedMcpToolsResponse;
  managedMcpCall: AgentApiManagedMcpCallResponse;
  messageSend: AgentApiSendResponse;
  messageSendV2: AgentApiSendResponse;
  messageResolve: AgentApiMessageResolveResponse;
  messageSearch: AgentApiMessageSearchResponse;
  messageReactionAdd: AgentApiMessageEnvelope;
  messageReactionRemove: AgentApiMessageEnvelope;
  messageCardUpdate: AgentApiMessageCardUpdateResponse;
  attachmentDownload: AgentApiAttachmentDownloadResponse;
  attachmentDownloadUrl: AgentApiAttachmentDownloadUrlResponse;
  attachmentCommentsList: AgentApiAttachmentCommentsResponse;
  channelJoin: AgentApiOkResponse;
  channelLeave: AgentApiChannelLeaveResponse;
  channelMute: AgentApiChannelMuteResponse;
  channelUnmute: AgentApiChannelMuteResponse;
  channelArchive: AgentApiChannelArchiveResponse;
  channelUnarchive: AgentApiChannelUnarchiveResponse;
  channelCreate: AgentApiChannelRowResponse;
  channelUpdate: AgentApiChannelRowResponse;
  channelMemberAdd: AgentApiChannelMemberAddResponse;
  channelMemberRemove: AgentApiChannelMemberRemoveResponse;
  channelMembers: AgentApiChannelMembersResponse;
  resolveChannel: AgentApiResolveChannelResponse;
  threadFollow: AgentApiThreadFollowResponse;
  threadUnfollow: AgentApiOkResponse;
  threadList: AgentApiThreadListResponse;
  inboxList: AgentApiInboxListResponse;
  inboxRead: AgentApiInboxReadResponse;
  inboxDismiss: AgentApiInboxDismissResponse;
  assistantOwnerInbox: AgentApiAssistantOwnerInboxResponse;
  assistantOwnerMessages: AgentApiAssistantOwnerMessagesResponse;
  assistantSendAsOwner: AgentApiAssistantSendAsOwnerResponse;
  assistantForwardAsOwner: AgentApiAssistantForwardAsOwnerResponse;
  assistantSearchForwardTargets: AgentApiAssistantSearchForwardTargetsResponse;
  assistantOwnerArtifact: AgentApiAssistantOwnerArtifactResponse;
  assistantOwnerArtifactPublish: AgentApiAssistantOwnerArtifactPublishResponse;
  assistantOwnerActivity: AgentApiAssistantOwnerActivityResponse;
  assistantNotify: AgentApiAssistantNotifyResponse;
  assistantOwnerResolve: AgentApiAssistantOwnerResolveResponse;
  assistantCheckStateImport: AgentApiAssistantCheckStateImportResponse;
  assistantContactRules: AgentApiAssistantContactRulesResponse;
  assistantContactRuleAdd: AgentApiAssistantContactRuleAddResponse;
  assistantContactRuleRemove: AgentApiAssistantConfirmationResponse;
  assistantContactSettings: AgentApiAssistantContactSettingsResponse;
  assistantOwnerSettings: AgentApiAssistantOwnerSettingsResponse;
  assistantOwnerSettingsUpdate: AgentApiAssistantOwnerSettingsUpdateResponse;
  assistantContactRulesImport: AgentApiAssistantContactRulesImportResponse;
  assistantToldRecord: AgentApiAssistantToldResponse;
  assistantToldList: AgentApiAssistantToldListResponse;
  agentContext: AgentApiAgentContextResponse;
  serverInfo: AgentApiServerInfoResponse;
  userChannels: AgentApiUserChannelsResponse;
  serverUpdate: AgentApiServerUpdateResponse;
  serverLabs: AgentApiServerLabsResponse;
  serverLabsAccess: AgentApiServerLabsMutationResponse;
  serverLabEnrollment: AgentApiServerLabsMutationResponse;
  mentionActionsPending: AgentApiMentionActionsPendingResponse;
  senderMentionDeliveries: AgentApiSenderMentionDeliveriesResponse;
  mentionActionsExecute: AgentApiMentionActionsExecuteResponse;
  taskClaim: AgentApiTaskClaimResponse;
  taskList: AgentApiTaskListResponse;
  taskCreate: AgentApiTaskCreateResponse;
  taskUnclaim: AgentApiTaskUnclaimResponse;
  taskAssign: AgentApiTaskAssignResponse;
  taskUpdateStatus: AgentApiTaskUpdateStatusResponse;
  taskResourceReceipt: AgentApiTaskResourceReceiptResponse;
  taskDelete: AgentApiTaskDeleteResponse;
  taskConvert: AgentApiTaskConvertResponse;
  taskAmend: AgentApiTaskAmendResponse;
  taskHistory: AgentApiTaskHistoryResponse;
  taskView: AgentApiTaskViewResponse;
  taskFollowing: AgentApiTaskFollowingResponse;
  taskRead: AgentApiHistoryResponse;
  taskReply: AgentApiSendResponse;
  taskFollow: AgentApiTaskFollowResponse;
  taskUnfollow: AgentApiTaskFollowResponse;
  taskIdleNudge: AgentApiTaskIdleNudgeResponse;
  migrationRetry: AgentApiMigrationRetryResponse;
  reminderList: AgentApiReminderListResponse;
  reminderCreate: AgentApiReminderResponse;
  reminderCancel: AgentApiReminderResponse;
  reminderSnooze: AgentApiReminderResponse;
  reminderUpdate: AgentApiReminderResponse;
  appSourceAck: AgentApiAppSourceAckResponse;
  reminderLog: AgentApiReminderLogResponse;
  appConfigGet: AgentApiAppConfigResponse;
  appConfigPatch: AgentApiAppConfigResponse;
  profileShow: AgentApiProfileView;
  profileUpdate: AgentApiProfileView;
  profileAvatarUpdate: AgentApiProfileView;
  integrationList: AgentApiIntegrationListResponse;
  integrationMarketplaceSearch: AgentApiIntegrationMarketplaceResponse;
  integrationToken: AgentApiIntegrationTokenResponse;
  integrationLogin: AgentApiIntegrationLoginResponse;
  integrationAppPrepare: AgentApiIntegrationAppPrepareResponse;
  integrationAppRotateSecret: AgentApiIntegrationAppRotateSecretResponse;
  integrationAppTransferOwner: AgentApiIntegrationAppTransferOwnerResponse;
  integrationAppUpdate: AgentApiIntegrationAppUpdateResponse;
  integrationAppManage: AgentApiIntegrationAppManageResponse;
  integrationAppLogoUpdate: AgentApiIntegrationAppLogoResponse;
  integrationAppList: AgentApiIntegrationAppListResponse;
  integrationAppStatus: AgentApiIntegrationAppStatusResponse;
  actionPrepare: AgentApiActionPrepareResponse;
  actionWithdraw: AgentApiActionWithdrawResponse;
  attachmentUpload: AgentApiAttachmentUploadResponse;
  attachmentUploadCapabilities: AgentApiAttachmentUploadCapabilitiesResponse;
  attachmentUploadSessionCreate: AgentApiAttachmentUploadSessionCreateResponse;
  attachmentUploadSessionComplete: AgentApiAttachmentUploadSessionCompleteResponse;
  attachmentUploadSessionCancel: AgentApiAttachmentUploadSessionResponse;
  attachmentUploadSessionStatus: AgentApiAttachmentUploadSessionResponse;
  pushWebhookStatus: AgentApiPushWebhookStatusResponse;
  pushWebhookRegister: AgentApiPushWebhookStatusResponse;
  pushWebhookDelete: null;
  mentionsList: AgentApiMentionsListResponse;
};
/** Core's entries by hand; each app route's from its own schemas. */
export type AgentApiResponseByRoute = CoreAgentApiResponseByRoute & {
  -readonly [K in keyof FirstPartyAppAgentApiRoutes]: AgentApiResponseOf<FirstPartyAppAgentApiRoutes[K]>;
};

type AssertNever<T extends never> = T;
type _AgentApiRouteKeyFieldMismatch = AssertNever<{
  [K in AgentApiRouteKey]: AgentApiContract[K]["key"] extends K ? never : K;
}[AgentApiRouteKey]>;
type _AgentApiRequestParamsMissingRoutes = AssertNever<Exclude<AgentApiRouteKey, keyof AgentApiRequestParamsByRoute>>;
type _AgentApiRequestParamsExtraRoutes = AssertNever<Exclude<keyof AgentApiRequestParamsByRoute, AgentApiRouteKey>>;
type _AgentApiRequestQueryMissingRoutes = AssertNever<Exclude<AgentApiRouteKey, keyof AgentApiRequestQueryByRoute>>;
type _AgentApiRequestQueryExtraRoutes = AssertNever<Exclude<keyof AgentApiRequestQueryByRoute, AgentApiRouteKey>>;
type _AgentApiRequestBodyMissingRoutes = AssertNever<Exclude<AgentApiRouteKey, keyof AgentApiRequestBodyByRoute>>;
type _AgentApiRequestBodyExtraRoutes = AssertNever<Exclude<keyof AgentApiRequestBodyByRoute, AgentApiRouteKey>>;
type _AgentApiResponseMissingRoutes = AssertNever<Exclude<AgentApiRouteKey, keyof AgentApiResponseByRoute>>;
type _AgentApiResponseExtraRoutes = AssertNever<Exclude<keyof AgentApiResponseByRoute, AgentApiRouteKey>>;

export function parseAgentApiResponse<K extends AgentApiRouteKey>(
  key: K,
  value: unknown,
): AgentApiResponseByRoute[K] {
  const response = agentApiContract[key].response;
  const kind = getAgentApiResponseKind(response);
  if (kind === "binary") {
    if (!(value instanceof Uint8Array)) {
      throw new TypeError(`Agent API ${key} response did not contain binary bytes`);
    }
    return value as AgentApiResponseByRoute[K];
  }
  if (kind === "empty") {
    if (value !== null && value !== undefined) {
      throw new TypeError(`Agent API ${key} response must be empty`);
    }
    return null as AgentApiResponseByRoute[K];
  }
  if (!("body" in response)) {
    throw new TypeError(`Agent API ${key} response contract is missing a JSON body schema`);
  }
  return response.body.parse(value) as AgentApiResponseByRoute[K];
}

const appSourceAckRejectStatusByCode = {
  app_source_authority_not_registered: 404,
  invalid_source_revision: 400,
  source_id_ambiguous: 409,
  source_not_found: 404,
  target_not_fired: 404,
  stale_source_revision: 409,
} as const satisfies Record<AgentApiAppSourceAckRejectCode, number>;

export function parseAgentApiAppSourceAckReject(
  status: number,
  value: unknown,
): AgentApiAppSourceAckRejectResponse | null {
  const parsed = agentApiAppSourceAckRejectResponseSchema.safeParse(value);
  if (!parsed.success) return null;
  if (appSourceAckRejectStatusByCode[parsed.data.code] !== status) return null;
  return parsed.data;
}
