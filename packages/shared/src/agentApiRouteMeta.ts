// Per-route operating metadata for the credential-derived Agent API.
//
// The route contract (`agentApiContract.ts`) says WHAT each route accepts and
// returns. This file says HOW a client may treat it: whether it changes state,
// whether repeating it is safe, and which agent runtimes it serves. Clients
// derive retry policy from it, the SDK derives tool annotations from it, and
// the generated route manifest carries it so every projection (CLI, SDK, tool
// schema) reads one vocabulary.
//
// The vocabulary maps 1:1 onto MCP tool annotations (`readOnlyHint`,
// `destructiveHint`, `idempotentHint`), which the managed MCP catalog already
// uses, so consumers do not learn two dialects.
//
// Rules of classification (keep these when adding a route):
// - `sideEffect` is NOT inferred from the HTTP method. `GET /events` with the
//   default `ack=immediate` acknowledges (consumes) inbox rows before the
//   response is sent, so it is a `destructive_read`; `POST /resolve-channel`
//   changes nothing, so it is a `read`.
// - `idempotency: "natural"` means repeating the same request converges on the
//   same state (join twice = joined). `"key"` means the body carries an
//   idempotency key that makes replays safe. `"none"` means a repeat may act
//   twice or fail the second time; clients must never auto-retry it.
// - `destructive` follows MCP's `destructiveHint`: the route may remove,
//   archive, rotate, transfer, or overwrite existing state that someone else
//   depends on (delete a task, leave a channel, rotate a secret, change a task's
//   status or assignee, replace a profile or a webhook registration). Additive
//   writes are NOT destructive even though they change state: sending a
//   message, adding a reaction, joining a channel, creating a task, claiming an
//   unassigned task. Reversible per-agent attention preferences (mute/unmute)
//   are not destructive either. An approval UX keys off this flag, so it must
//   stay rare: only the routes whose outcome cannot simply be undone by
//   posting again. A `destructive_read` is destructive (it consumes).
// - `audience` records who the Server serves on that route today. `managed`
//   routes answer External Agents with a typed refusal (for example
//   `reminders_unsupported_for_external_agents`); clients can surface that
//   before the request instead of after.

import type { AgentApiRouteKey, CoreAgentApiRouteKey } from "./agentApiContract";
import { AGENT_API_META, appAgentApiRoutesOf, type AgentApiRouteMeta } from "./agentApiRoute";
import { firstPartyAppAgentApis } from "./apps";

export { AGENT_API_AUDIENCES, AGENT_API_IDEMPOTENCY, AGENT_API_SIDE_EFFECTS } from "./agentApiRoute";
export type { AgentApiAudience, AgentApiIdempotency, AgentApiRouteMeta, AgentApiSideEffect } from "./agentApiRoute";

const { read, naturalWrite, keyedWrite, write, naturalDestructive, destructive, managedWrite, managedNaturalDestructive } = AGENT_API_META;

/** Core's routes' metadata by hand; each app route's comes from its fragment (`meta`). */
const CORE_AGENT_API_ROUTE_META = {
  raftbenchFindings: { audience: "external", sideEffect: "read", idempotency: "natural", destructive: false },
  raftbenchContext: { ...read, audience: "external" },
  raftbenchSubmit: { ...naturalWrite, audience: "external" },
  feedbackLocatorIngest: naturalWrite,
  feedbackLocatorList: read,
  // Default `ack=immediate` consumes the returned rows before the response;
  // `ack=cursor` (External Agents) defers that to the next request.
  events: { sideEffect: "destructive_read", idempotency: "none", destructive: true, audience: "both" },
  historyRead: read,
  knowledgeGet: read,
  knowledgeSearch: read,
  // #wg-ax:#15: POST only for its body; it reads a context and records the view, changes nothing else.
  contextSearch: read,
  contextRead: read,
  managedMcpTools: read,
  managedMcpCall: destructive,
  messageSend: keyedWrite,
  messageSendV2: keyedWrite,
  messageResolve: read,
  messageSearch: read,
  messageReactionAdd: naturalWrite,
  messageReactionRemove: naturalDestructive,
  // RFC 082: the sender replaces its own card (every revision is kept, and
  // another update replaces it again), so not destructive; `idempotencyKey`
  // makes a retry answer the first result instead of a second revision.
  messageCardUpdate: keyedWrite,
  channelJoin: naturalWrite,
  channelLeave: naturalDestructive,
  channelMute: naturalWrite,
  channelUnmute: naturalWrite,
  channelArchive: naturalDestructive,
  channelUnarchive: naturalWrite,
  // A second create with the same name is refused, not converged.
  channelCreate: write,
  channelUpdate: naturalDestructive,
  channelMemberAdd: naturalWrite,
  channelMemberRemove: naturalDestructive,
  channelMembers: read,
  resolveChannel: read,
  threadFollow: naturalWrite,
  threadUnfollow: naturalDestructive,
  threadList: read,
  inboxList: read,
  // RFC 081: consumes exactly the entries it returns (like `events`); clients must not auto-retry.
  inboxRead: { sideEffect: "destructive_read", idempotency: "none", destructive: true, audience: "both" },
  // Moves read state forward without showing anything; a repeat converges (nothing left to dismiss).
  inboxDismiss: naturalDestructive,
  assistantOwnerInbox: read,
  assistantOwnerArtifact: read,
  assistantOwnerArtifactPublish: write,
  assistantOwnerMessages: read,
  assistantSendAsOwner: write,
  assistantForwardAsOwner: keyedWrite,
  assistantSearchForwardTargets: read,
  assistantOwnerActivity: read,
  assistantOwnerResolve: read,
  assistantCheckStateImport: naturalWrite,
  assistantNotify: keyedWrite,
  assistantContactRules: read,
  assistantContactRuleAdd: naturalWrite,
  assistantContactRuleRemove: naturalDestructive,
  assistantContactSettings: naturalDestructive,
  assistantOwnerSettings: read,
  // Set-to-value: a replay converges.
  assistantOwnerSettingsUpdate: naturalDestructive,
  assistantContactRulesImport: naturalWrite,
  assistantToldRecord: naturalWrite,
  assistantToldList: read,
  agentContext: read,
  serverInfo: read,
  userChannels: read,
  serverUpdate: naturalDestructive,
  serverLabs: read,
  // Version-guarded: a replay with the same expectedVersion converges or gets a 409.
  serverLabsAccess: naturalDestructive,
  serverLabEnrollment: naturalDestructive,
  mentionActionsPending: read,
  senderMentionDeliveries: read,
  mentionActionsExecute: write,
  taskClaim: write,
  taskList: read,
  taskCreate: keyedWrite,
  taskUnclaim: destructive,
  taskAssign: naturalDestructive,
  taskUpdateStatus: naturalDestructive,
  taskResourceReceipt: write,
  taskDelete: destructive,
  taskConvert: write,
  taskAmend: destructive,
  taskHistory: read,
  taskView: read,
  taskFollowing: read,
  taskRead: read,
  taskReply: keyedWrite,
  taskFollow: naturalWrite,
  taskUnfollow: naturalDestructive,
  // Records what it returns as reminded: a repeat answers "no change" (single attempt).
  taskIdleNudge: write,
  // Starts a migration of the agent itself; a repeat is refused (one retry per failed migration).
  migrationRetry: managedWrite,
  reminderList: read,
  reminderCreate: managedWrite,
  reminderCancel: naturalDestructive,
  reminderSnooze: managedNaturalDestructive,
  reminderUpdate: managedNaturalDestructive,
  appSourceAck: naturalWrite,
  reminderLog: read,
  appConfigGet: read,
  appConfigPatch: destructive,
  profileShow: read,
  profileUpdate: naturalDestructive,
  profileAvatarUpdate: naturalDestructive,
  integrationList: read,
  integrationMarketplaceSearch: read,
  integrationToken: write,
  integrationLogin: naturalWrite,
  integrationAppPrepare: write,
  integrationAppRotateSecret: destructive,
  integrationAppTransferOwner: naturalDestructive,
  integrationAppUpdate: naturalDestructive,
  integrationAppManage: destructive,
  integrationAppLogoUpdate: naturalDestructive,
  integrationAppList: read,
  integrationAppStatus: read,
  actionPrepare: keyedWrite,
  // Withdraw twice and it is withdrawn; asking again undoes it, so not destructive.
  actionWithdraw: naturalWrite,
  attachmentUpload: write,
  attachmentUploadCapabilities: read,
  attachmentUploadSessionCreate: write,
  attachmentUploadSessionComplete: naturalWrite,
  attachmentUploadSessionCancel: naturalDestructive,
  attachmentUploadSessionStatus: read,
  attachmentDownload: read,
  // Minting a presigned URL changes no state; each call mints a fresh URL.
  attachmentDownloadUrl: read,
  attachmentCommentsList: read,
  // Moves the caller's read position, which only it reads; repeating converges.
  // Moves the caller's read position over what it shows; repeating converges.
  // Additive: a new version keeps the older ones. Natural idempotency: the
  // same request repeated after it went through answers the version it made
  // (same base, files, settings and publisher), never a second one.
  // Content-addressed: the same bytes again are the same blob.
  // A comment is a new post: repeating it comments twice.
  // Reversible per-agent attention preferences, like mute/unmute.
  pushWebhookStatus: { sideEffect: "read", idempotency: "natural", destructive: false, audience: "external" },
  // Registering replaces the existing registration and its secret.
  pushWebhookRegister: { sideEffect: "write", idempotency: "natural", destructive: true, audience: "external" },
  pushWebhookDelete: { sideEffect: "write", idempotency: "natural", destructive: true, audience: "external" },
  mentionsList: read,
} as const satisfies Record<CoreAgentApiRouteKey, AgentApiRouteMeta>;

type AssertNever<T extends never> = T;
type _AgentApiRouteMetaMissingRoutes = AssertNever<Exclude<CoreAgentApiRouteKey, keyof typeof CORE_AGENT_API_ROUTE_META>>;
type _AgentApiRouteMetaExtraRoutes = AssertNever<Exclude<keyof typeof CORE_AGENT_API_ROUTE_META, CoreAgentApiRouteKey>>;

export const AGENT_API_ROUTE_META: Readonly<Record<AgentApiRouteKey, AgentApiRouteMeta>> = {
  ...CORE_AGENT_API_ROUTE_META,
  ...Object.fromEntries(appAgentApiRoutesOf(firstPartyAppAgentApis).map(({ route }) => [route.key, route.meta])),
} as Record<AgentApiRouteKey, AgentApiRouteMeta>;

export function getAgentApiRouteMeta(key: AgentApiRouteKey): AgentApiRouteMeta {
  return AGENT_API_ROUTE_META[key];
}

/** MCP-style tool annotations derived from route metadata. */
export interface AgentApiToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
}

export function toAgentApiToolAnnotations(meta: AgentApiRouteMeta): AgentApiToolAnnotations {
  return {
    readOnlyHint: meta.sideEffect === "read",
    destructiveHint: meta.destructive,
    idempotentHint: meta.idempotency !== "none",
  };
}

/**
 * Transport retry policy a client may apply without changing the outcome.
 * `read` routes may be retried; keyed writes may be retried only when the
 * request carries its idempotency key (the caller decides, hence "keyed");
 * everything else is exactly one attempt.
 */
export type AgentApiRetryPolicy = "retry" | "retry_when_keyed" | "single_attempt";

export function getAgentApiRetryPolicy(meta: AgentApiRouteMeta): AgentApiRetryPolicy {
  if (meta.sideEffect === "read") return "retry";
  if (meta.sideEffect === "write" && meta.idempotency === "key") return "retry_when_keyed";
  if (meta.sideEffect === "write" && meta.idempotency === "natural") return "retry";
  return "single_attempt";
}
