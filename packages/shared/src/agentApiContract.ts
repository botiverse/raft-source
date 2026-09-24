import { z } from "zod";
import {
  actionCardActionSchema,
  integrationRegisterAppOperationSchema,
  integrationUpdateAppRegistrationOperationSchema,
} from "./actionCards.js";
import { ATTENTION_HINT_SCHEMA } from "./attentionDependencyOracle.js";
import { asChannelId, asMessageId } from "./brandedIds.js";
import type { ProfileView, TaskResourceReceipt, TaskStatus } from "./index.js";
import { MAX_KNOWLEDGE_CONTEXT_LENGTH, MIN_KNOWLEDGE_CONTEXT_LENGTH } from "./knowledgeContext.js";
import {
  attachmentUploadCapabilitiesSchema,
  attachmentUploadPathParamsSchema,
  attachmentUploadSessionSchema,
  completeAttachmentUploadSessionResponseSchema,
  createAttachmentUploadSessionRequestSchema,
  createAttachmentUploadSessionResponseSchema,
} from "./attachmentUploadContract.js";
import type { AgentInboxSourceRef } from "./agentInboxApp.js";
import { AGENT_API_BASE_PATH } from "./agentApiPaths.js";
import {
  agentApiFreshnessContextModeSchema,
  agentApiHeldFreshnessResponseSchema,
  agentApiMessageEnvelopeSchema,
  agentApiSendBodySchema,
  agentApiSendV2BodySchema,
  agentApiSendResponseSchema,
  agentApiTaskCurrentProjectionSchema,
  AGENT_API_EXTERNAL_MESSAGE_FORBIDDEN_AUTHORITY_FIELDS,
  isAgentApiExternalMessageForbiddenAuthorityField,
  type AgentApiHeldFreshnessResponse,
  type AgentApiMessageEnvelope,
  type AgentApiSendBody,
  type AgentApiSendV2Body,
  type AgentApiSendResponse,
} from "./agentApiMessageContract.js";

export {
  agentApiAttachmentEnvelopeSchema,
  agentApiFreshnessContextModeSchema,
  agentApiHeldFreshnessResponseSchema,
  agentApiMessageEnvelopeSchema,
  agentApiSendBodySchema,
  agentApiSendV2BodySchema,
  agentApiSendResponseSchema,
  agentApiSendSentResponseSchema,
  agentApiStructuredMentionSchema,
  agentApiTaskCurrentProjectionSchema,
  AGENT_API_EXTERNAL_MESSAGE_FORBIDDEN_AUTHORITY_FIELDS,
  isAgentApiExternalMessageForbiddenAuthorityField,
  legacyAgentSendBodySchema,
} from "./agentApiMessageContract.js";
export {
  AGENT_API_BASE_PATH,
  AGENT_API_MESSAGE_SEND_PATH,
  AGENT_API_MESSAGE_SEND_V2_PATH,
} from "./agentApiPaths.js";
export type {
  AgentApiAttachmentEnvelope,
  AgentApiHeldFreshnessResponse,
  AgentApiMessageEnvelope,
  AgentApiSendBody,
  AgentApiSendV2Body,
  AgentApiSendResponse,
  AgentApiSendSentResponse,
  AgentApiStructuredMention,
  LegacyAgentSendBody,
} from "./agentApiMessageContract.js";

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

export const agentApiMethods = ["GET", "POST", "PATCH", "DELETE"] as const;
export type AgentApiMethod = (typeof agentApiMethods)[number];

export const agentApiCapabilities = [
  "read",
  "send",
  "tasks",
  "channels",
  "server",
  "knowledge",
  "mentions",
  "reactions",
  "mcp",
] as const;
export type AgentApiCapability = (typeof agentApiCapabilities)[number];

const optionalStringSchema = z.string().trim().optional();
const optionalStringArraySchema = z.array(z.string().trim().min(1)).optional();
const optionalBooleanSchema = z.boolean().optional();
const optionalNumberSchema = z.number().finite().optional();
const nullableStringSchema = z.string().nullable();
const nullableNumberSchema = z.number().finite().nullable();
const optionalIsoTimestampSchema = z.string().datetime().optional();
const agentStatusSchema = z.enum(["active", "inactive", "stopped"]);
const reminderStatusSchema = z.enum(["scheduled", "fired", "canceled"]);
const reminderEventTypeSchema = z.enum(["scheduled", "fired", "snoozed", "updated", "canceled"]);
const reasoningEffortSchema = z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]);
const profileVisibilityMembershipStatusSchema = z.enum(["active", "left", "removed"]);
// The envelope is shared so daemon and Server agree on the HTTP seam. The
// locator payload itself is intentionally `unknown` here: the Server owns an
// independent, closed consumer schema so a producer edit cannot weaken both
// ends of the acceptance boundary.
export const agentApiFeedbackLocatorIngestBodySchema = z.object({
  artifact_kind: z.string().trim().min(1).max(128),
  event_kind: z.string().trim().min(1).max(128),
  payload: z.unknown(),
}).strict();

export const agentApiFeedbackLocatorAcceptanceSchema = z.object({
  status: z.literal("accepted"),
  receipt_id: z.string().uuid(),
  report_id: z.string().uuid(),
  duplicate: z.boolean(),
}).strict();

export const agentApiFeedbackLocatorListQuerySchema = z.object({
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
}).strict();

const agentApiFeedbackLocatorIndexEntrySchema = z.object({
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
}).strict();

export const agentApiFeedbackLocatorListResponseSchema = z.object({
  locators: z.array(agentApiFeedbackLocatorIndexEntrySchema),
}).strict();

const passthroughObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();

export const taskStatusSchema = z.enum(["todo", "in_progress", "in_review", "done", "closed"]);

export const agentApiEventsQuerySchema = passthroughObject({
  since: optionalStringSchema,
  limit: optionalStringSchema,
});

export const agentApiHistoryQuerySchema = passthroughObject({
  channel: z.string().trim().min(1),
  before: optionalStringSchema,
  after: optionalStringSchema,
  around: optionalStringSchema,
  limit: optionalStringSchema,
});

export const agentApiKnowledgeGetQuerySchema = passthroughObject({
  topic: z.string().trim().min(1),
  // Optional at the transport schema during the staged rollout. The current
  // CLI advertises manual-context-v1 and requires both before sending; the
  // server keeps legacy published clients compatible until the fleet gate.
  intent: z.string().trim().min(MIN_KNOWLEDGE_CONTEXT_LENGTH).max(MAX_KNOWLEDGE_CONTEXT_LENGTH).optional(),
  reason: z.string().trim().min(MIN_KNOWLEDGE_CONTEXT_LENGTH).max(MAX_KNOWLEDGE_CONTEXT_LENGTH).optional(),
  turn_id: optionalStringSchema,
  trace_id: optionalStringSchema,
});

export const agentApiKnowledgeGetResponseSchema = passthroughObject({
  ok: z.literal(true),
  docId: z.string(),
  topicOrPath: z.string(),
  docVersion: z.string(),
  docState: z.string(),
  contentType: z.string(),
  content: z.string(),
});

export const agentApiKnowledgeSearchQuerySchema = passthroughObject({
  query: z.string().trim().min(1),
  scope: optionalStringSchema,
  intent: z.string().trim().min(MIN_KNOWLEDGE_CONTEXT_LENGTH).max(MAX_KNOWLEDGE_CONTEXT_LENGTH).optional(),
  reason: z.string().trim().min(MIN_KNOWLEDGE_CONTEXT_LENGTH).max(MAX_KNOWLEDGE_CONTEXT_LENGTH).optional(),
  turn_id: optionalStringSchema,
  trace_id: optionalStringSchema,
});

export const agentApiKnowledgeSearchResultSchema = passthroughObject({
  slug: z.string(),
  title: z.string(),
  firstScreen: z.string(),
});

export const agentApiKnowledgeSearchResponseSchema = passthroughObject({
  ok: z.literal(true),
  query: z.string(),
  scope: z.string().nullable(),
  results: z.array(agentApiKnowledgeSearchResultSchema),
});

export const agentApiWikiManifestResponseSchema = passthroughObject({
  configured: z.literal(true),
  wikiSpaceId: z.string().uuid(),
  etag: z.string().nullable(),
  manifest: z.unknown().nullable(),
});

export const agentApiWikiArtifactReadParamsSchema = passthroughObject({
  artifactId: z.string().uuid(),
});

const agentApiWikiSourceRefSchema = passthroughObject({
  channelId: z.string().uuid(),
  messageId: z.string().uuid(),
  seq: z.number().int().positive(),
  slockRef: z.string().min(1),
});

const agentApiWikiArtifactSchema = passthroughObject({
  id: z.string().uuid(),
  artifactType: z.enum(["index", "log", "page"]),
  slug: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().nullable(),
  currentUnderstanding: z.string().nullable(),
  status: z.enum(["current", "tentative", "contested", "superseded", "stale", "archived"]),
  confidence: z.enum(["low", "medium", "high"]),
  sourcePolicy: z.enum(["cached_summary", "prefer_live_source"]),
  sourceRefs: z.array(agentApiWikiSourceRefSchema),
  revision: passthroughObject({
    id: z.string().uuid(),
    key: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().positive(),
  }),
  updatedAt: z.string().datetime(),
});

export const agentApiWikiArtifactReadResponseSchema = passthroughObject({
  configured: z.literal(true),
  wikiSpaceId: z.string().uuid(),
  etag: z.string().min(1),
  artifact: agentApiWikiArtifactSchema,
  markdown: z.string().min(1),
});

export const agentApiWikiPublishBodySchema = passthroughObject({
  expectedEtag: z.string().min(1).nullable(),
  manifest: z.unknown(),
  revisionBodies: z.array(passthroughObject({
    artifactId: z.string().uuid(),
    revisionId: z.string().uuid(),
    markdown: z.string().min(1),
  })).max(100),
});

const agentApiManagedMcpJsonSchema = z.object({
  type: z.literal("object"),
  properties: z.record(z.string(), z.object({}).passthrough()).optional(),
  required: z.array(z.string()).optional(),
}).passthrough();

const agentApiManagedMcpToolSchema = z.object({
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
});

export const agentApiManagedMcpToolsResponseSchema = z.object({
  catalogVersion: z.literal(1),
  tools: z.array(agentApiManagedMcpToolSchema),
});

export const agentApiManagedMcpCallBodySchema = z.object({
  mcpServerId: z.string().uuid(),
  toolName: z.string().trim().min(1),
  arguments: z.record(z.string(), z.unknown()),
  expectedConfigVersion: z.number().int().positive(),
  expectedAssignmentVersion: z.number().int().positive(),
});

const agentApiManagedMcpResultContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
]);

export const agentApiManagedMcpCallResponseSchema = z.object({
  content: z.array(agentApiManagedMcpResultContentSchema),
  isError: z.boolean(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});

export const agentApiMessageSearchQuerySchema = passthroughObject({
  q: optionalStringSchema,
  channel: optionalStringSchema,
  sender: optionalStringSchema,
  senderId: optionalStringSchema,
  sort: z.enum(["relevance", "recent"]).optional(),
  before: optionalStringSchema,
  after: optionalStringSchema,
  limit: optionalStringSchema,
  offset: optionalStringSchema,
});

export const agentApiMessageResolveParamsSchema = passthroughObject({
  msgId: z.string().trim().min(1).transform(asMessageId),
});

export const agentApiMessageReactionParamsSchema = passthroughObject({
  msgId: z.string().trim().min(1).transform(asMessageId),
});

export const agentApiMessageReactionBodySchema = passthroughObject({
  emoji: z.string().trim().min(1).max(16).refine((value) => !/\s/.test(value), {
    message: "A single reaction emoji is required",
  }),
});

export const agentApiChannelMembershipParamsSchema = passthroughObject({
  channelId: z.string().trim().min(1).transform(asChannelId),
});

export const agentApiChannelLifecycleBodySchema = passthroughObject({
  target: z.string().trim().min(1),
});

export const agentApiAttachmentDownloadParamsSchema = passthroughObject({
  attachmentId: z.string().trim().min(1),
});

export const agentApiAttachmentCommentsParamsSchema = passthroughObject({
  attachmentId: z.string().trim().min(1),
});

export const agentApiAttachmentCommentsQuerySchema = passthroughObject({
  limit: optionalStringSchema,
});

const agentApiAttachmentCommentAnchorSchema = passthroughObject({
  type: z.string().trim().min(1),
  data: z.record(z.string(), z.unknown()),
});

const agentApiAttachmentCommentReactionSchema = passthroughObject({
  emoji: z.string().trim().min(1),
  reactorType: z.string().trim().min(1),
  reactorId: z.string().trim().min(1),
  createdAt: z.string().datetime(),
});

const agentApiAttachmentCommentResolvedBySchema = passthroughObject({
  reactorId: z.string().trim().min(1),
  reactorType: z.string().trim().min(1),
});

export const agentApiAttachmentCommentSchema = passthroughObject({
  id: z.string().trim().min(1),
  channelId: z.string().trim().min(1).optional(),
  senderId: z.string().trim().min(1),
  senderType: z.enum(["user", "agent"]),
  senderName: z.string().trim().min(1),
  senderAvatarUrl: nullableStringSchema.optional(),
  senderGravatarHash: nullableStringSchema.optional(),
  content: z.string(),
  createdAt: z.string().datetime(),
  reactions: z.array(agentApiAttachmentCommentReactionSchema),
  anchor: agentApiAttachmentCommentAnchorSchema.nullable(),
  resolved: z.boolean().optional(),
  resolvedBy: agentApiAttachmentCommentResolvedBySchema.nullable().optional(),
  resolvedAt: z.string().datetime().nullable().optional(),
});

export const agentApiAttachmentCommentsResponseSchema = passthroughObject({
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
});

export const agentApiChannelMembersQuerySchema = passthroughObject({
  channel: z.string().trim().min(1),
});

export const agentApiResolveChannelBodySchema = passthroughObject({
  target: z.string().trim().min(1),
});

export const agentApiResolveChannelResponseSchema = passthroughObject({
  channelId: z.string().trim().min(1),
});

export const agentApiThreadUnfollowBodySchema = passthroughObject({
  thread: z.string().trim().min(1),
  reason: z.string().trim().min(1).max(200).optional(),
});

export const agentApiTaskClaimBodySchema = passthroughObject({
  channel: z.string().trim().min(1),
  task_numbers: z.array(z.number().int().positive()).optional(),
  message_ids: optionalStringArraySchema,
  freshnessContextMode: agentApiFreshnessContextModeSchema.optional(),
});

export const agentApiTaskListQuerySchema = passthroughObject({
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
});

export const agentApiTaskCreateBodySchema = passthroughObject({
  channel: z.string().trim().min(1),
  tasks: z.array(passthroughObject({
    title: z.string().trim().min(1),
    creates_resource: z.boolean().optional(),
  })).min(1),
  assignee: z.string().trim().refine(
    (value) => value.startsWith("@") && value.slice(1).trim().length > 0,
    { message: "assignee must be an @handle" },
  ).optional(),
});

export const agentApiTaskUnclaimBodySchema = passthroughObject({
  channel: z.string().trim().min(1),
  task_number: z.number().int().positive(),
});

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
export const agentApiTaskAssignBodySchema = passthroughObject({
  channel: z.string().trim().min(1),
  task_number: z.number().int().positive(),
  assignee: z.string().trim().min(1).nullable(),
  expected_revision: z.number().int().nonnegative().optional(),
});

export const agentApiTaskUpdateStatusBodySchema = passthroughObject({
  channel: z.string().trim().min(1),
  task_number: z.number().int().positive(),
  status: taskStatusSchema,
  freshnessContextMode: agentApiFreshnessContextModeSchema.optional(),
});

export const agentApiTaskResourceReceiptSchema = passthroughObject({
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
});

export const agentApiTaskResourceReceiptBodySchema = passthroughObject({
  channel: z.string().trim().min(1),
  task_number: z.number().int().positive(),
  receipt: agentApiTaskResourceReceiptSchema,
});

/**
 * Delete a task. Same rule as the browser: creator, or an actor holding
 * `deleteAnyTask` on this server. Agents carry a `serverAgentMembers.role`, so
 * "admin" is a real state for them, not a human-only concept.
 */
export const agentApiTaskDeleteBodySchema = passthroughObject({
  channel: z.string().trim().min(1),
  task_number: z.number().int().positive(),
});

/**
 * Convert an existing message into a task WITHOUT claiming it.
 *
 * `taskClaim` already accepts `message_ids` and converts as a side effect, but
 * that path assigns the task to the caller. An agent that is filing work for
 * someone else needs conversion on its own, exactly as the browser's
 * `POST /tasks/convert-message` gives a human.
 */
export const agentApiTaskConvertBodySchema = passthroughObject({
  channel: z.string().trim().min(1),
  message_id: z.string().trim().min(1),
});

export const agentApiTaskAmendBodySchema = passthroughObject({
  channel: z.string().trim().min(1),
  task_number: z.number().int().positive(),
  title: z.string().trim().min(1).max(10_000).optional(),
  description: z.string().max(50_000).nullable().optional(),
  freshnessContextMode: agentApiFreshnessContextModeSchema.optional(),
}).refine((value) => value.title !== undefined || value.description !== undefined, {
  message: "At least one of title or description is required",
});

export const agentApiTaskHistoryQuerySchema = passthroughObject({
  channel: z.string().trim().min(1),
  task_number: z.coerce.number().int().positive(),
});

export const agentApiReminderListQuerySchema = passthroughObject({
  status: optionalStringSchema,
  all: optionalStringSchema,
});

export const agentApiReminderParamsSchema = passthroughObject({
  reminderId: z.string().trim().min(1),
});

export const agentApiReminderScheduleBodySchema = passthroughObject({
  title: z.string(),
  fireAt: optionalStringSchema,
  delaySeconds: optionalNumberSchema,
  msgId: z.string().nullable().optional(),
  payload: z.unknown().optional(),
  repeat: optionalStringSchema,
  tz: optionalStringSchema,
  channel: optionalStringSchema,
});

export const agentApiReminderSnoozeBodySchema = passthroughObject({
  delaySeconds: z.number().finite(),
});

export const agentApiReminderUpdateBodySchema = passthroughObject({
  fireAt: optionalStringSchema,
  delaySeconds: optionalNumberSchema,
  repeat: optionalStringSchema,
  title: optionalStringSchema,
  tz: optionalStringSchema,
});

export const agentApiInboxSourceRefSchema = z.object({
  kind: z.string().trim().min(1),
  id: z.string().trim().min(1),
  revision: z.string().trim().min(1).optional(),
}).strict() satisfies z.ZodType<AgentInboxSourceRef>;

export const agentApiAppSourceAckBodySchema = passthroughObject({
  itemId: z.string().trim().min(1),
  appId: z.string().trim().min(1),
  notificationClass: z.string().trim().min(1),
  sourceRef: agentApiInboxSourceRefSchema,
  ackAttemptId: z.string().uuid(),
});

export const agentApiProfileShowQuerySchema = passthroughObject({
  target: optionalStringSchema,
});

export const agentApiProfileUpdateBodySchema = passthroughObject({
  avatarUrl: optionalStringSchema,
  displayName: optionalStringSchema,
  description: optionalStringSchema,
});

const agentApiProfileCreatedAgentSchema = passthroughObject({
  id: z.string(),
  name: z.string(),
  displayName: nullableStringSchema,
  avatarUrl: nullableStringSchema,
  runtime: z.string(),
  status: agentStatusSchema,
});

const agentApiProfileCreatorSchema = z.union([
  passthroughObject({
    type: z.literal("human"),
    id: z.string(),
    name: z.string(),
    displayName: nullableStringSchema,
    avatarUrl: nullableStringSchema,
    gravatarHash: z.string(),
  }),
  passthroughObject({
    type: z.literal("agent"),
    id: z.string(),
    name: z.string(),
    displayName: nullableStringSchema,
    avatarUrl: nullableStringSchema,
    deletedAt: nullableStringSchema,
  }),
]);

export const agentApiProfileViewSchema: z.ZodType<ProfileView> = z.discriminatedUnion("kind", [
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
]);

export const agentApiIntegrationLoginBodySchema = passthroughObject({
  service: z.string().trim().min(1),
  scopes: optionalStringArraySchema,
  target: optionalStringSchema,
});

export const agentApiIntegrationMarketplaceQuerySchema = passthroughObject({
  query: z.string().trim().max(200).optional(),
  limit: optionalStringSchema,
});

const agentApiIntegrationAppPrepareCommonBodyShape = {
  target: z.string().trim().min(1),
  name: optionalStringSchema,
  description: optionalStringSchema,
  category: z.string().trim().min(1).optional(),
  homepageUrl: optionalStringSchema,
  returnUrl: optionalStringSchema,
  agentManifestUrl: optionalStringSchema,
  scopes: optionalStringArraySchema,
  unsafeDemoUrlOverride: optionalBooleanSchema,
  draftHint: optionalStringSchema,
};

export const agentApiIntegrationAppPrepareBodySchema = z.discriminatedUnion("mode", [
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
]);

export const agentApiIntegrationAppRotateSecretBodySchema = passthroughObject({
  clientKey: z.string().trim().min(1),
});

export const agentApiIntegrationAppTransferOwnerBodySchema = passthroughObject({
  clientKey: z.string().trim().min(1),
  targetAgent: z.string().trim().min(1),
});

export const agentApiIntegrationAppUpdateBodySchema = passthroughObject({
  clientKey: z.string().trim().min(1),
  name: optionalStringSchema,
  description: optionalStringSchema,
  category: z.string().trim().min(1).optional(),
  homepageUrl: optionalStringSchema,
  returnUrl: optionalStringSchema,
  agentManifestUrl: optionalStringSchema,
  scopes: optionalStringArraySchema,
  unsafeDemoUrlOverride: optionalBooleanSchema,
});

export const agentApiIntegrationAppManageBodySchema = passthroughObject({
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
});

export const agentApiIntegrationAppStatusQuerySchema = passthroughObject({
  card: optionalStringSchema,
  client: optionalStringSchema,
});

export const agentApiActionPrepareBodySchema = passthroughObject({
  target: z.string().trim().min(1),
  action: actionCardActionSchema,
});

export const agentApiServerUpdateBodySchema = passthroughObject({
  name: z.string().trim().min(1).max(100).optional(),
  hideHumansFromMembers: z.boolean().optional(),
});

export const agentApiServerUpdateResponseSchema = passthroughObject({
  id: z.string(),
  name: z.string(),
  hideHumansFromMembers: z.boolean().nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
});

export const agentApiServerInfoResponseSchema = passthroughObject({
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
  channels: z.array(passthroughObject({
    id: z.string().transform(asChannelId),
    name: z.string(),
    joined: z.boolean(),
  })),
  agents: z.array(passthroughObject({
    name: z.string(),
    status: z.string().optional(),
    activity: z.string().nullable().optional(),
    activityDetail: z.string().nullable().optional(),
    role: z.enum(["owner", "admin", "member"]).nullable().optional(),
  })),
  humans: z.array(passthroughObject({
    name: z.string(),
    role: z.enum(["owner", "admin", "member", "guest"]).nullable().optional(),
  })),
});

export const agentApiMentionActionsPendingQuerySchema = passthroughObject({
  limit: optionalStringSchema,
});

export const agentApiMentionActionEnvelopeSchema = passthroughObject({
  resolutionId: z.string(),
});

export const agentApiMentionActionResultSchema = passthroughObject({
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
});

export const agentApiMentionActionsPendingResponseSchema = passthroughObject({
  pendingMentionActions: z.array(agentApiMentionActionEnvelopeSchema),
  has_more: z.boolean().optional(),
});

export const agentApiMentionActionsExecuteBodySchema = passthroughObject({
  action: z.enum(["notify", "add"]),
  resolutionIds: optionalStringArraySchema,
  ids: optionalStringArraySchema,
});

export const agentApiMentionActionsExecuteResponseSchema = passthroughObject({
  ok: z.literal(true),
  action: z.enum(["notify", "add"]),
  results: z.array(agentApiMentionActionResultSchema),
});

const agentApiIntegrationServiceSchema = passthroughObject({
  id: z.string(),
  clientId: z.string(),
  appType: z.enum(["server_local", "slock_builtin", "third_party_global"]).optional(),
  name: z.string(),
  description: nullableStringSchema,
  homepageUrl: nullableStringSchema,
  returnUrl: nullableStringSchema,
  agentManifestUrl: nullableStringSchema,
  agentManifestUrlSource: z.enum(["explicit", "well_known"]).nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const agentApiActiveIntegrationLoginSchema = passthroughObject({
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
});

export const agentApiIntegrationListResponseSchema = passthroughObject({
  services: z.array(agentApiIntegrationServiceSchema),
  activeLogins: z.array(agentApiActiveIntegrationLoginSchema),
});

const agentApiMarketplaceIntegrationAppSchema = passthroughObject({
  id: z.string(),
  clientId: z.string(),
  name: z.string(),
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
});

export const agentApiIntegrationMarketplaceResponseSchema = passthroughObject({
  surface: z.literal("public_marketplace"),
  metadataTrust: z.literal("untrusted_app_supplied"),
  query: nullableStringSchema,
  limit: z.number().int().min(1).max(50),
  apps: z.array(agentApiMarketplaceIntegrationAppSchema),
});

export const agentApiIntegrationLoginResponseSchema = passthroughObject({
  status: z.enum(["logged_in", "already_logged_in", "approval_required", "install_required"]),
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
});

export const agentApiIntegrationAppPrepareResponseSchema = passthroughObject({
  status: z.literal("prepared"),
  mode: z.enum(["register", "update"]),
  target: z.string(),
  actionCardMessageId: z.string(),
  action: z.discriminatedUnion("type", [
    integrationRegisterAppOperationSchema,
    integrationUpdateAppRegistrationOperationSchema,
  ]),
});

export const agentApiIntegrationAppRotateSecretResponseSchema = passthroughObject({
  clientId: z.string(),
  clientKey: z.string(),
  clientName: z.string(),
  clientSecret: z.string(),
});

export const agentApiIntegrationAppTransferOwnerResponseSchema = passthroughObject({
  clientId: z.string(),
  clientKey: z.string(),
  clientName: z.string(),
  ownerAgentId: z.string(),
  ownerAgentName: z.string(),
  ownershipOutcome: z.enum(["transferred", "already_owner"]),
  auditEventId: z.string().uuid(),
});

export const agentApiIntegrationAppUpdateResponseSchema = passthroughObject({
  clientId: z.string(),
  clientKey: z.string(),
  clientName: z.string(),
  updatedFields: z.array(z.string()),
});

const agentApiIntegrationAppShareLinkSchema = passthroughObject({
  id: z.string(),
  expiresAt: nullableStringSchema,
  revokedAt: nullableStringSchema,
  lastUsedAt: nullableStringSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const agentApiIntegrationAppManageResponseSchema = passthroughObject({
  action: agentApiIntegrationAppManageBodySchema.shape.action,
  clientId: z.string(),
  clientKey: z.string(),
  clientName: z.string(),
  publishStatus: nullableStringSchema.optional(),
  logoUrl: nullableStringSchema.optional(),
  shareUrl: nullableStringSchema.optional(),
  link: agentApiIntegrationAppShareLinkSchema.nullable().optional(),
});

export const agentApiIntegrationAppLogoResponseSchema = passthroughObject({
  clientId: z.string(),
  clientKey: z.string(),
  clientName: z.string(),
  logoUrl: z.string(),
});

// Unlike the general forward-compatible agent API envelopes, this owner-state
// projection is deliberately closed: unknown server fields must be stripped
// before CLI JSON/text rendering so a future DB-shaped response cannot expose
// secret/hash/token or internal-owner fields by accident.
export const agentApiOwnedIntegrationAppSchema = z.object({
  state: z.enum(["card_pending", "committed"]),
  card: nullableStringSchema,
  name: z.string(),
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
});

export const agentApiIntegrationAppListResponseSchema = z.object({
  apps: z.array(agentApiOwnedIntegrationAppSchema),
});

export const agentApiIntegrationAppStatusResponseSchema = z.object({
  app: agentApiOwnedIntegrationAppSchema,
});

export const agentApiAttachmentUploadResponseSchema = passthroughObject({
  id: z.string().trim().min(1),
  filename: z.string(),
  mimeType: nullableStringSchema,
  sizeBytes: z.number().int().nonnegative(),
  thumbnailUrl: nullableStringSchema,
});

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
  if (value.mentioned !== false) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "external_message must be explicitly non-mentioned",
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
export const agentApiEventsResponseSchema = passthroughObject({
  events: z.array(agentApiMessageEnvelopeSchema),
  last_seen_msgId: nullableStringSchema,
  last_seen_seq: nullableNumberSchema,
  reply_target: nullableStringSchema,
  pending_notice_ids: z.array(z.string()),
  wake_reason: z.string().nullable(),
  has_more: z.boolean(),
});

export const agentApiHistoryResponseSchema = passthroughObject({
  messages: z.array(agentApiMessageEnvelopeSchema),
  has_more: z.boolean(),
  has_older: z.boolean(),
  has_newer: z.boolean(),
  last_read_seq: nullableNumberSchema.optional(),
});

export const agentApiMessageResolveResponseSchema = passthroughObject({
  message: agentApiMessageEnvelopeSchema,
});

export const agentApiChannelAttentionSchema = passthroughObject({
  state: optionalStringSchema,
  ordinaryActivity: optionalStringSchema,
  stillArrives: optionalStringArraySchema,
  threadBoundary: optionalStringSchema,
  manageCommand: optionalStringSchema,
  manageApi: optionalStringSchema,
});

export const agentApiOkResponseSchema = passthroughObject({
  ok: z.literal(true),
  attention: agentApiChannelAttentionSchema.optional(),
});

export const agentApiSearchResultSchema = passthroughObject({
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
});

export const agentApiMessageSearchResponseSchema = passthroughObject({
  results: z.array(agentApiSearchResultSchema),
  hasMore: z.boolean(),
});

export const agentApiChannelMembersResponseSchema = passthroughObject({
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
  })),
});

export const agentApiChannelMuteResponseSchema = passthroughObject({
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
});

const agentApiChannelLifecycleResponseBaseSchema = passthroughObject({
  id: z.string().trim().min(1).transform(asChannelId),
  name: z.string().trim().min(1),
  type: z.enum(["channel", "private"]),
  archivedByUserId: nullableStringSchema.optional(),
  archivedByAgentId: nullableStringSchema.optional(),
});

export const agentApiChannelArchiveResponseSchema = agentApiChannelLifecycleResponseBaseSchema.extend({
  archivedAt: z.string().trim().min(1),
});

export const agentApiChannelUnarchiveResponseSchema = agentApiChannelLifecycleResponseBaseSchema.extend({
  archivedAt: z.null(),
});

export const agentApiChannelMuteBodySchema = passthroughObject({
  attentionHintAccepted: passthroughObject({
    schema: z.literal(ATTENTION_HINT_SCHEMA),
    trigger: z.enum(["M2", "M3"]),
    scope: z.string().trim().min(1),
    suggested_command: optionalStringSchema,
    copy_version: z.string().trim().min(1),
    epoch_ms: z.number().int().nonnegative(),
  }).optional(),
});

// Effect-boundary projection of a failed claim. The claim API declares which
// effects this specific conflict blocks; it never rules on lane ownership —
// canonical DRI/reviewer/evidence identity stays with lane/thread authority.
export const agentApiTaskClaimConflictSchema = passthroughObject({
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
});

export const agentApiTaskClaimResultSchema = passthroughObject({
  taskNumber: z.number().int().positive().optional(),
  messageId: optionalStringSchema,
  success: z.boolean(),
  reason: optionalStringSchema,
  conflict: agentApiTaskClaimConflictSchema.optional(),
});

export const agentApiTaskClaimSuccessResponseSchema = passthroughObject({
  results: z.array(agentApiTaskClaimResultSchema),
});

export const agentApiTaskClaimResponseSchema = z.union([
  agentApiTaskClaimSuccessResponseSchema,
  agentApiHeldFreshnessResponseSchema,
]);

export const agentApiTaskEnvelopeSchema = passthroughObject({
  taskNumber: z.number().int().positive().optional(),
  status: z.string().optional(),
  title: optionalStringSchema,
  description: z.string().nullable().optional(),
  revision: z.number().int().nonnegative().nullable().optional(),
  claimedByName: z.string().nullable().optional(),
  createdByName: z.string().nullable().optional(),
  createdByMembershipStatus: z.enum(["active", "left", "removed"]).nullable().optional(),
  messageId: z.string().nullable().optional(),
  channelRef: z.string().trim().min(1).optional(),
  isLegacy: optionalBooleanSchema,
  requiresResourceReceipt: optionalBooleanSchema,
  resourceReceipt: agentApiTaskResourceReceiptSchema.nullable().optional(),
  resourceReceiptRecordedAt: z.string().datetime().nullable().optional(),
  resourceTeardownOwnerAgentId: nullableStringSchema.optional(),
  resourceExpiryFollowupId: nullableStringSchema.optional(),
});

export const agentApiTaskListResponseSchema = passthroughObject({
  tasks: z.array(agentApiTaskEnvelopeSchema),
  scope: z.enum(["channel", "mine"]).optional(),
  coverage: passthroughObject({
    status: z.literal("incomplete"),
    visibleChannelTypes: z.array(z.enum(["channel", "private", "joint", "dm"])),
    includesArchived: z.boolean(),
    inaccessibleScope: z.literal("not_asserted"),
    reason: z.string().trim().min(1),
  }).optional(),
  pagination: passthroughObject({
    mode: z.literal("complete"),
    truncated: z.literal(false),
  }).optional(),
});

export const agentApiCreatedTaskEnvelopeSchema = passthroughObject({
  taskNumber: z.number().int().positive(),
  messageId: z.string(),
  title: z.string(),
  status: taskStatusSchema,
  claimedByType: z.enum(["user", "agent"]).nullable(),
  claimedById: z.string().nullable(),
  claimedByName: z.string().nullable().optional(),
  claimedAt: z.string().datetime().nullable(),
  requiresResourceReceipt: z.boolean(),
});

export const agentApiTaskAssignmentReceiptSchema = passthroughObject({
  messageId: z.string(),
  content: z.string(),
  assignee: z.string().startsWith("@"),
  state: z.enum(["started", "assigned"]),
});

export const agentApiTaskCreateResponseSchema = passthroughObject({
  tasks: z.array(agentApiCreatedTaskEnvelopeSchema),
  assignmentReceipt: agentApiTaskAssignmentReceiptSchema.optional(),
});

export const agentApiTaskResourceReceiptResponseSchema = passthroughObject({
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
});

export const agentApiTaskUnclaimResponseSchema = passthroughObject({
  ok: z.literal(true),
});

export const agentApiTaskAssignResponseSchema = passthroughObject({
  ok: z.literal(true),
  /** Echoed so a caller that lost a race can retry without a re-read. */
  revision: z.number().int().nonnegative(),
  assignee: z.string().nullable(),
});

export const agentApiTaskDeleteResponseSchema = passthroughObject({
  ok: z.literal(true),
});

export const agentApiTaskConvertResponseSchema = passthroughObject({
  task: agentApiCreatedTaskEnvelopeSchema,
});

export const agentApiTaskUpdateStatusSuccessResponseSchema = passthroughObject({
  ok: z.literal(true),
});

export const agentApiTaskUpdateStatusResponseSchema = z.union([
  agentApiTaskUpdateStatusSuccessResponseSchema,
  agentApiHeldFreshnessResponseSchema,
]);

const agentApiTaskCardProjectionSchema = passthroughObject({
  taskNumber: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullable(),
  revision: z.number().int().nonnegative(),
});

const agentApiTaskHistoryEventSchema = passthroughObject({
  id: z.string().uuid(),
  seq: z.number().int().positive(),
  eventType: z.string().trim().min(1),
  actorType: z.enum(["user", "agent", "system"]),
  actorName: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});

export const agentApiTaskAmendSuccessResponseSchema = passthroughObject({
  task: agentApiTaskCardProjectionSchema,
  event: agentApiTaskHistoryEventSchema,
});

export const agentApiTaskAmendResponseSchema = z.union([
  agentApiTaskAmendSuccessResponseSchema,
  agentApiHeldFreshnessResponseSchema,
]);

export const agentApiTaskHistoryResponseSchema = passthroughObject({
  task: agentApiTaskCardProjectionSchema,
  events: z.array(agentApiTaskHistoryEventSchema),
});

export const agentApiActionPrepareResponseSchema = passthroughObject({
  messageId: z.string(),
  metadata: passthroughObject({
    kind: z.literal("action-card"),
  }),
});

export const agentApiReminderRecurrenceSchema = z.object({
  kind: z.enum(["interval", "daily", "weekly", "unsupported"]),
  description: z.string(),
});

export const agentApiReminderSummarySchema = z.object({
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
});

export const agentApiReminderEventSummarySchema = z.object({
  eventId: z.string(),
  reminderId: z.string(),
  eventType: reminderEventTypeSchema,
  actorType: z.enum(["agent", "human", "system"]),
  actorId: nullableStringSchema,
  occurredAt: z.string(),
  nextFireAt: nullableStringSchema,
  metadata: z.record(z.string(), z.unknown()).nullable(),
});

export const agentApiReminderListResponseSchema = passthroughObject({
  reminders: z.array(agentApiReminderSummarySchema),
});

export const agentApiReminderResponseSchema = passthroughObject({
  reminder: agentApiReminderSummarySchema,
  warning: optionalStringSchema,
});

export const agentApiReminderLogResponseSchema = passthroughObject({
  events: z.array(agentApiReminderEventSummarySchema),
});

export const agentApiAppSourceAckResponseSchema = passthroughObject({
  ok: z.literal(true),
  itemId: z.string(),
  appId: z.string(),
  notificationClass: z.string(),
  sourceRef: agentApiInboxSourceRefSchema,
  sourceEventId: z.string().uuid(),
  ackAttemptId: z.string().uuid(),
  replayed: z.boolean(),
});

export const agentApiAppSourceAckRejectCodeSchema = z.enum([
  "app_source_authority_not_registered",
  "invalid_source_revision",
  "source_id_ambiguous",
  "source_not_found",
  "target_not_fired",
  "stale_source_revision",
]);

export const agentApiAppSourceAckRejectResponseSchema = passthroughObject({
  error: z.string(),
  code: agentApiAppSourceAckRejectCodeSchema,
  latestFiredSourceVersion: optionalNumberSchema,
});

export const agentApiAppConfigParamsSchema = z.object({
  appId: z.string().trim().min(1),
});

const agentApiAppConfigValueSchema = z.union([z.boolean(), z.number().int().safe()]);
const agentApiAppConfigFieldSchema = z.union([
  z.object({ type: z.literal("boolean") }).strict(),
  z.object({
    type: z.literal("integer"),
    minimum: z.number().int().safe(),
    maximum: z.number().int().safe(),
  }).strict(),
]);

export const agentApiAppConfigPatchBodySchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  set: z.record(z.string(), z.unknown()).default({}),
  unset: z.array(z.string().trim().min(1)).default([]),
}).strict();

export const agentApiAppConfigResponseSchema = passthroughObject({
  appId: z.string(),
  revision: z.number().int().nonnegative(),
  schema: z.record(z.string(), agentApiAppConfigFieldSchema),
  defaults: z.record(z.string(), agentApiAppConfigValueSchema),
  overrides: z.record(z.string(), agentApiAppConfigValueSchema),
  effective: z.record(z.string(), agentApiAppConfigValueSchema),
});

const agentApiMigrationStateSchema = z.enum([
  "provisioning",
  "prep",
  "ready",
  "in_transit",
  "arriving",
  "starting",
  "cancel_requested_pre_flip",
  "cancel_requested_post_flip",
  "canceled_pre_flip",
  "canceled_post_flip",
  "completed",
  "aborted",
  "failed",
]);

export const agentApiMigrationSummarySchema = passthroughObject({
  id: z.string(),
  agentId: z.string(),
  sourceMachineId: z.string(),
  targetMachineId: z.string(),
  state: agentApiMigrationStateSchema,
  manifestPath: nullableStringSchema,
  manifestSha256: nullableStringSchema,
  arrivalReportPath: nullableStringSchema,
  arrivalReportSha256: nullableStringSchema,
  abortReason: nullableStringSchema,
  failureReason: nullableStringSchema,
  prepDeadlineAt: z.string().datetime(),
  transferDeadlineAt: z.string().datetime(),
  arrivalDeadlineAt: z.string().datetime(),
  readyAt: nullableStringSchema,
  flippedAt: nullableStringSchema,
  arrivedAt: nullableStringSchema,
  completedAt: nullableStringSchema,
  abortedAt: nullableStringSchema,
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const agentApiMigrationBeginBodySchema = passthroughObject({
  targetMachineId: z.string().trim().min(1),
  prepDeadlineMs: z.number().int().positive().optional(),
  transferDeadlineMs: z.number().int().positive().optional(),
  arrivalDeadlineMs: z.number().int().positive().optional(),
});

export const agentApiMigrationReadyBodySchema = passthroughObject({
  manifestPath: z.string().trim().min(1),
  manifestSha256: optionalStringSchema,
});

export const agentApiMigrationArrivedBodySchema = passthroughObject({
  reportPath: optionalStringSchema,
  reportSha256: optionalStringSchema,
});

export const agentApiMigrationResponseSchema = passthroughObject({
  migration: agentApiMigrationSummarySchema,
});

export const agentApiMigrationStatusResponseSchema = passthroughObject({
  migration: agentApiMigrationSummarySchema.nullable(),
});

export type AgentApiContractResponse =
  | {
    kind?: "json";
    body: z.ZodType;
  }
  | {
    kind: "binary";
  };

export type AgentApiContractRoute = {
  key: string;
  method: AgentApiMethod;
  path: string;
  fullPath: string;
  client: {
    resource: string;
    method: string;
  };
  capability: AgentApiCapability;
  description: string;
  request: {
    params?: z.ZodType;
    query?: z.ZodType;
    body?: z.ZodType;
  };
  response: AgentApiContractResponse;
};

function route<const T extends Omit<AgentApiContractRoute, "fullPath">>(input: T): T & { fullPath: string } {
  return {
    ...input,
    fullPath: `${AGENT_API_BASE_PATH}${input.path}`,
  };
}

export const agentApiContract = {
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
  wikiManifestGet: route({
    key: "wikiManifestGet",
    method: "GET",
    path: "/wiki/manifest",
    client: { resource: "wiki", method: "manifest" },
    capability: "knowledge",
    description: "Read the canonical S3-backed Wiki manifest for the configured Wiki Agent.",
    request: {},
    response: { body: agentApiWikiManifestResponseSchema },
  }),
  wikiArtifactRead: route({
    key: "wikiArtifactRead",
    method: "GET",
    path: "/wiki/artifacts/:artifactId",
    client: { resource: "wiki", method: "read" },
    capability: "knowledge",
    description: "Read the current manifest-reachable Wiki artifact Markdown for the configured Wiki Agent.",
    request: { params: agentApiWikiArtifactReadParamsSchema },
    response: { body: agentApiWikiArtifactReadResponseSchema },
  }),
  wikiManifestPublish: route({
    key: "wikiManifestPublish",
    method: "POST",
    path: "/wiki/publish",
    client: { resource: "wiki", method: "publish" },
    capability: "knowledge",
    description: "Publish immutable Wiki revisions and atomically advance the canonical manifest.",
    request: { body: agentApiWikiPublishBodySchema },
    response: { body: agentApiWikiManifestResponseSchema },
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
    description: "Leave a joined regular channel as the bound agent credential.",
    request: { params: agentApiChannelMembershipParamsSchema },
    response: { body: agentApiOkResponseSchema },
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
  serverInfo: route({
    key: "serverInfo",
    method: "GET",
    path: "/server",
    client: { resource: "server", method: "info" },
    capability: "server",
    description: "List channels, agents, humans, and runtime context visible to the bound agent.",
    request: {},
    response: { body: agentApiServerInfoResponseSchema },
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
    description: "Claim one or more tasks by task number or message id.",
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
    description: "Convert a message into a task without claiming it.",
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
  migrationBegin: route({
    key: "migrationBegin",
    method: "POST",
    path: "/migrations",
    client: { resource: "migrations", method: "begin" },
    capability: "server",
    description: "Begin a migration for the bound agent credential.",
    request: { body: agentApiMigrationBeginBodySchema },
    response: { body: agentApiMigrationResponseSchema },
  }),
  migrationStatus: route({
    key: "migrationStatus",
    method: "GET",
    path: "/migrations/current",
    client: { resource: "migrations", method: "status" },
    capability: "read",
    description: "Read the active migration for the bound agent credential, if any.",
    request: {},
    response: { body: agentApiMigrationStatusResponseSchema },
  }),
  migrationReady: route({
    key: "migrationReady",
    method: "POST",
    path: "/migrations/ready",
    client: { resource: "migrations", method: "ready" },
    capability: "read",
    description: "Mark the bound agent's active migration prep phase ready.",
    request: { body: agentApiMigrationReadyBodySchema },
    response: { body: agentApiMigrationResponseSchema },
  }),
  migrationArrived: route({
    key: "migrationArrived",
    method: "POST",
    path: "/migrations/arrived",
    client: { resource: "migrations", method: "arrived" },
    capability: "read",
    description: "Mark the bound agent's active migration arrival phase complete.",
    request: { body: agentApiMigrationArrivedBodySchema },
    response: { body: agentApiMigrationResponseSchema },
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
    capability: "server",
    description: "Update the bound agent profile metadata.",
    request: { body: agentApiProfileUpdateBodySchema },
    response: { body: agentApiProfileViewSchema },
  }),
  profileAvatarUpdate: route({
    key: "profileAvatarUpdate",
    method: "POST",
    path: "/profile/avatar",
    client: { resource: "profile", method: "updateAvatar" },
    capability: "server",
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
    description: "List available integration services and active agent logins.",
    request: {},
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
} as const satisfies Record<string, AgentApiContractRoute>;

export type AgentApiContract = typeof agentApiContract;
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
  request: {
    params: boolean;
    query: boolean;
    body: boolean;
  };
  response: {
    kind: "json" | "binary";
    body: boolean;
  };
};

export function getAgentApiResponseKind(response: AgentApiContractResponse): "json" | "binary" {
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

export function buildLegacyAgentApiPath(agentId: string, routePath: string): string {
  return `/internal/agent/${encodeURIComponent(agentId)}${routePath}`;
}

export type AgentApiEventsQuery = z.infer<typeof agentApiEventsQuerySchema>;
export type AgentApiHistoryQuery = z.infer<typeof agentApiHistoryQuerySchema>;
export type AgentApiKnowledgeGetQuery = z.infer<typeof agentApiKnowledgeGetQuerySchema>;
export type AgentApiKnowledgeGetResponse = z.infer<typeof agentApiKnowledgeGetResponseSchema>;
export type AgentApiKnowledgeSearchQuery = z.infer<typeof agentApiKnowledgeSearchQuerySchema>;
export type AgentApiKnowledgeSearchResult = z.infer<typeof agentApiKnowledgeSearchResultSchema>;
export type AgentApiKnowledgeSearchResponse = z.infer<typeof agentApiKnowledgeSearchResponseSchema>;
export type AgentApiWikiManifestResponse = z.infer<typeof agentApiWikiManifestResponseSchema>;
export type AgentApiWikiArtifactReadParams = z.infer<typeof agentApiWikiArtifactReadParamsSchema>;
export type AgentApiWikiArtifactReadResponse = z.infer<typeof agentApiWikiArtifactReadResponseSchema>;
export type AgentApiWikiPublishBody = z.infer<typeof agentApiWikiPublishBodySchema>;
export type AgentApiManagedMcpToolsResponse = z.infer<typeof agentApiManagedMcpToolsResponseSchema>;
export type AgentApiManagedMcpCallBody = z.infer<typeof agentApiManagedMcpCallBodySchema>;
export type AgentApiManagedMcpCallResponse = z.infer<typeof agentApiManagedMcpCallResponseSchema>;
export type AgentApiMessageSearchQuery = z.infer<typeof agentApiMessageSearchQuerySchema>;
export type AgentApiMessageResolveParams = z.infer<typeof agentApiMessageResolveParamsSchema>;
export type AgentApiMessageReactionParams = z.infer<typeof agentApiMessageReactionParamsSchema>;
export type AgentApiMessageReactionBody = z.infer<typeof agentApiMessageReactionBodySchema>;
export type AgentApiChannelMembershipParams = z.infer<typeof agentApiChannelMembershipParamsSchema>;
export type AgentApiChannelMuteBody = z.infer<typeof agentApiChannelMuteBodySchema>;
export type AgentApiChannelLifecycleBody = z.infer<typeof agentApiChannelLifecycleBodySchema>;
export type AgentApiAttachmentDownloadParams = z.infer<typeof agentApiAttachmentDownloadParamsSchema>;
export type AgentApiChannelMembersQuery = z.infer<typeof agentApiChannelMembersQuerySchema>;
export type AgentApiThreadUnfollowBody = z.infer<typeof agentApiThreadUnfollowBodySchema>;
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
export type AgentApiIntegrationLoginBody = z.infer<typeof agentApiIntegrationLoginBodySchema>;
export type AgentApiIntegrationMarketplaceQuery = z.infer<typeof agentApiIntegrationMarketplaceQuerySchema>;
export type AgentApiIntegrationAppPrepareBody = z.infer<typeof agentApiIntegrationAppPrepareBodySchema>;
export type AgentApiIntegrationAppStatusQuery = z.infer<typeof agentApiIntegrationAppStatusQuerySchema>;
export type AgentApiActionPrepareBody = z.infer<typeof agentApiActionPrepareBodySchema>;
export type AgentApiAttachmentUploadResponse = z.infer<typeof agentApiAttachmentUploadResponseSchema>;
export type AgentApiAttachmentUploadCapabilitiesResponse = z.infer<typeof attachmentUploadCapabilitiesSchema>;
export type AgentApiAttachmentUploadSessionCreateBody = z.infer<typeof createAttachmentUploadSessionRequestSchema>;
export type AgentApiAttachmentUploadSessionCreateResponse = z.infer<typeof createAttachmentUploadSessionResponseSchema>;
export type AgentApiAttachmentUploadSessionCompleteResponse = z.infer<typeof completeAttachmentUploadSessionResponseSchema>;
export type AgentApiAttachmentUploadSessionResponse = z.infer<typeof attachmentUploadSessionSchema>;
export type AgentApiAttachmentDownloadResponse = Uint8Array;

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
export interface AgentApiEventsResponse {
  events: AgentApiMessageEnvelope[];
  last_seen_msgId: string | null;
  last_seen_seq: number | null;
  reply_target: string | null;
  pending_notice_ids: string[];
  wake_reason: string | null;
  has_more: boolean;
  [key: string]: unknown;
}

export interface AgentApiHistoryResponse {
  messages: AgentApiMessageEnvelope[];
  has_more: boolean;
  has_older: boolean;
  has_newer: boolean;
  last_read_seq?: number | null;
  [key: string]: unknown;
}

export type AgentApiMessageResolveResponse = z.infer<typeof agentApiMessageResolveResponseSchema>;
export type AgentApiMessageSearchResponse = z.infer<typeof agentApiMessageSearchResponseSchema>;
export type AgentApiChannelMembersResponse = z.infer<typeof agentApiChannelMembersResponseSchema>;

export type AgentApiTaskClaimConflict = z.infer<typeof agentApiTaskClaimConflictSchema>;

export interface AgentApiTaskClaimResult {
  taskNumber?: number;
  messageId?: string;
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
  createdByMembershipStatus?: "active" | "left" | "removed" | null;
  messageId?: string | null;
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
  [key: string]: unknown;
}

export interface AgentApiTaskCreateResponse {
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

export interface AgentApiTaskUnclaimResponse {
  ok: true;
  [key: string]: unknown;
}

export interface AgentApiTaskAssignResponse {
  ok: true;
  revision: number;
  assignee: string | null;
  [key: string]: unknown;
}

export interface AgentApiTaskUpdateStatusSuccessResponse {
  ok: true;
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
export type AgentApiActionPrepareResponse = z.infer<typeof agentApiActionPrepareResponseSchema>;
export type AgentApiServerInfoResponse = z.infer<typeof agentApiServerInfoResponseSchema>;
export type AgentApiServerUpdateBody = z.infer<typeof agentApiServerUpdateBodySchema>;
export type AgentApiServerUpdateResponse = z.infer<typeof agentApiServerUpdateResponseSchema>;
export type AgentApiMentionActionsPendingQuery = z.infer<typeof agentApiMentionActionsPendingQuerySchema>;
export type AgentApiMentionActionsPendingResponse = z.infer<typeof agentApiMentionActionsPendingResponseSchema>;
export type AgentApiMentionActionsExecuteBody = z.infer<typeof agentApiMentionActionsExecuteBodySchema>;
export type AgentApiMentionActionsExecuteResponse = z.infer<typeof agentApiMentionActionsExecuteResponseSchema>;
export type AgentApiResolveChannelBody = z.infer<typeof agentApiResolveChannelBodySchema>;
export type AgentApiResolveChannelResponse = z.infer<typeof agentApiResolveChannelResponseSchema>;
export type AgentApiChannelMuteResponse = z.infer<typeof agentApiChannelMuteResponseSchema>;
export type AgentApiChannelArchiveResponse = z.infer<typeof agentApiChannelArchiveResponseSchema>;
export type AgentApiChannelUnarchiveResponse = z.infer<typeof agentApiChannelUnarchiveResponseSchema>;
export type AgentApiIntegrationListResponse = z.infer<typeof agentApiIntegrationListResponseSchema>;
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
export type AgentApiMigrationBeginBody = z.infer<typeof agentApiMigrationBeginBodySchema>;
export type AgentApiMigrationReadyBody = z.infer<typeof agentApiMigrationReadyBodySchema>;
export type AgentApiMigrationArrivedBody = z.infer<typeof agentApiMigrationArrivedBodySchema>;
export type AgentApiMigrationResponse = z.infer<typeof agentApiMigrationResponseSchema>;
export type AgentApiMigrationStatusResponse = z.infer<typeof agentApiMigrationStatusResponseSchema>;
export type AgentApiFeedbackLocatorIngestBody = z.infer<typeof agentApiFeedbackLocatorIngestBodySchema>;
export type AgentApiFeedbackLocatorAcceptance = z.infer<typeof agentApiFeedbackLocatorAcceptanceSchema>;
export type AgentApiFeedbackLocatorListQuery = z.infer<typeof agentApiFeedbackLocatorListQuerySchema>;
export type AgentApiFeedbackLocatorListResponse = z.infer<typeof agentApiFeedbackLocatorListResponseSchema>;

export type AgentApiRequestParamsByRoute = {
  feedbackLocatorIngest: never;
  feedbackLocatorList: never;
  events: never;
  historyRead: never;
  knowledgeGet: never;
  knowledgeSearch: never;
  wikiManifestGet: never;
  wikiArtifactRead: AgentApiWikiArtifactReadParams;
  wikiManifestPublish: never;
  managedMcpTools: never;
  managedMcpCall: never;
  messageSend: never;
  messageSendV2: never;
  messageResolve: AgentApiMessageResolveParams;
  messageSearch: never;
  messageReactionAdd: AgentApiMessageReactionParams;
  messageReactionRemove: AgentApiMessageReactionParams;
  attachmentDownload: AgentApiAttachmentDownloadParams;
  attachmentCommentsList: AgentApiAttachmentCommentsParams;
  channelJoin: AgentApiChannelMembershipParams;
  channelLeave: AgentApiChannelMembershipParams;
  channelMute: AgentApiChannelMembershipParams;
  channelUnmute: AgentApiChannelMembershipParams;
  channelArchive: never;
  channelUnarchive: never;
  channelMembers: never;
  resolveChannel: never;
  threadUnfollow: never;
  serverInfo: never;
  serverUpdate: never;
  mentionActionsPending: never;
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
  migrationBegin: never;
  migrationStatus: never;
  migrationReady: never;
  migrationArrived: never;
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
  attachmentUpload: never;
  attachmentUploadCapabilities: never;
  attachmentUploadSessionCreate: never;
  attachmentUploadSessionComplete: z.infer<typeof attachmentUploadPathParamsSchema>;
  attachmentUploadSessionCancel: z.infer<typeof attachmentUploadPathParamsSchema>;
  attachmentUploadSessionStatus: z.infer<typeof attachmentUploadPathParamsSchema>;
};

export type AgentApiRequestQueryByRoute = {
  feedbackLocatorIngest: never;
  feedbackLocatorList: AgentApiFeedbackLocatorListQuery;
  events: AgentApiEventsQuery;
  historyRead: AgentApiHistoryQuery;
  knowledgeGet: AgentApiKnowledgeGetQuery;
  knowledgeSearch: AgentApiKnowledgeSearchQuery;
  wikiManifestGet: never;
  wikiArtifactRead: never;
  wikiManifestPublish: never;
  managedMcpTools: never;
  managedMcpCall: never;
  messageSend: never;
  messageSendV2: never;
  messageResolve: never;
  messageSearch: AgentApiMessageSearchQuery;
  messageReactionAdd: never;
  messageReactionRemove: never;
  attachmentDownload: never;
  attachmentCommentsList: AgentApiAttachmentCommentsQuery;
  channelJoin: never;
  channelLeave: never;
  channelMute: never;
  channelUnmute: never;
  channelArchive: never;
  channelUnarchive: never;
  channelMembers: AgentApiChannelMembersQuery;
  resolveChannel: never;
  threadUnfollow: never;
  serverInfo: never;
  serverUpdate: never;
  mentionActionsPending: AgentApiMentionActionsPendingQuery;
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
  migrationBegin: never;
  migrationStatus: never;
  migrationReady: never;
  migrationArrived: never;
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
  integrationList: never;
  integrationMarketplaceSearch: AgentApiIntegrationMarketplaceQuery;
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
  attachmentUpload: never;
  attachmentUploadCapabilities: never;
  attachmentUploadSessionCreate: never;
  attachmentUploadSessionComplete: never;
  attachmentUploadSessionCancel: never;
  attachmentUploadSessionStatus: never;
};

export type AgentApiRequestBodyByRoute = {
  feedbackLocatorIngest: AgentApiFeedbackLocatorIngestBody;
  feedbackLocatorList: never;
  events: never;
  historyRead: never;
  knowledgeGet: never;
  knowledgeSearch: never;
  wikiManifestGet: never;
  wikiArtifactRead: never;
  wikiManifestPublish: AgentApiWikiPublishBody;
  managedMcpTools: never;
  managedMcpCall: AgentApiManagedMcpCallBody;
  messageSend: AgentApiSendBody;
  messageSendV2: AgentApiSendV2Body;
  messageResolve: never;
  messageSearch: never;
  messageReactionAdd: AgentApiMessageReactionBody;
  messageReactionRemove: AgentApiMessageReactionBody;
  attachmentDownload: never;
  attachmentCommentsList: never;
  channelJoin: never;
  channelLeave: never;
  channelMute: AgentApiChannelMuteBody;
  channelUnmute: never;
  channelArchive: AgentApiChannelLifecycleBody;
  channelUnarchive: AgentApiChannelLifecycleBody;
  channelMembers: never;
  resolveChannel: AgentApiResolveChannelBody;
  threadUnfollow: AgentApiThreadUnfollowBody;
  serverInfo: never;
  serverUpdate: AgentApiServerUpdateBody;
  mentionActionsPending: never;
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
  migrationBegin: AgentApiMigrationBeginBody;
  migrationStatus: never;
  migrationReady: AgentApiMigrationReadyBody;
  migrationArrived: AgentApiMigrationArrivedBody;
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
  attachmentUpload: never;
  attachmentUploadCapabilities: never;
  attachmentUploadSessionCreate: z.infer<typeof createAttachmentUploadSessionRequestSchema>;
  attachmentUploadSessionComplete: never;
  attachmentUploadSessionCancel: never;
  attachmentUploadSessionStatus: never;
};

export type AgentApiResponseByRoute = {
  feedbackLocatorIngest: AgentApiFeedbackLocatorAcceptance;
  feedbackLocatorList: AgentApiFeedbackLocatorListResponse;
  events: AgentApiEventsResponse;
  historyRead: AgentApiHistoryResponse;
  knowledgeGet: AgentApiKnowledgeGetResponse;
  knowledgeSearch: AgentApiKnowledgeSearchResponse;
  wikiManifestGet: AgentApiWikiManifestResponse;
  wikiArtifactRead: AgentApiWikiArtifactReadResponse;
  wikiManifestPublish: AgentApiWikiManifestResponse;
  managedMcpTools: AgentApiManagedMcpToolsResponse;
  managedMcpCall: AgentApiManagedMcpCallResponse;
  messageSend: AgentApiSendResponse;
  messageSendV2: AgentApiSendResponse;
  messageResolve: AgentApiMessageResolveResponse;
  messageSearch: AgentApiMessageSearchResponse;
  messageReactionAdd: AgentApiMessageEnvelope;
  messageReactionRemove: AgentApiMessageEnvelope;
  attachmentDownload: AgentApiAttachmentDownloadResponse;
  attachmentCommentsList: AgentApiAttachmentCommentsResponse;
  channelJoin: AgentApiOkResponse;
  channelLeave: AgentApiOkResponse;
  channelMute: AgentApiChannelMuteResponse;
  channelUnmute: AgentApiChannelMuteResponse;
  channelArchive: AgentApiChannelArchiveResponse;
  channelUnarchive: AgentApiChannelUnarchiveResponse;
  channelMembers: AgentApiChannelMembersResponse;
  resolveChannel: AgentApiResolveChannelResponse;
  threadUnfollow: AgentApiOkResponse;
  serverInfo: AgentApiServerInfoResponse;
  serverUpdate: AgentApiServerUpdateResponse;
  mentionActionsPending: AgentApiMentionActionsPendingResponse;
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
  migrationBegin: AgentApiMigrationResponse;
  migrationStatus: AgentApiMigrationStatusResponse;
  migrationReady: AgentApiMigrationResponse;
  migrationArrived: AgentApiMigrationResponse;
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
  attachmentUpload: AgentApiAttachmentUploadResponse;
  attachmentUploadCapabilities: AgentApiAttachmentUploadCapabilitiesResponse;
  attachmentUploadSessionCreate: AgentApiAttachmentUploadSessionCreateResponse;
  attachmentUploadSessionComplete: AgentApiAttachmentUploadSessionCompleteResponse;
  attachmentUploadSessionCancel: AgentApiAttachmentUploadSessionResponse;
  attachmentUploadSessionStatus: AgentApiAttachmentUploadSessionResponse;
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
  if (getAgentApiResponseKind(response) === "binary") {
    if (!(value instanceof Uint8Array)) {
      throw new TypeError(`Agent API ${key} response did not contain binary bytes`);
    }
    return value as AgentApiResponseByRoute[K];
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
