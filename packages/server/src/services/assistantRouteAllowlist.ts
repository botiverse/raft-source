import { agentApiContract, type AgentApiRouteKey } from "@botiverse/raft-shared";

/**
 * RFC 075 v4: what a personal assistant's own credential may call. Default
 * deny at authentication, before any handler runs: only the routes decided
 * `allow` below pass; everything else answers 403 `assistant_route_not_allowed`.
 * The routes that name a channel, message or attachment are further held to
 * the owner DM in their handlers.
 *
 * Every Agent API route is decided here, contracted or not (#raft-antiproton:93d648cc):
 * a contract route missing from ASSISTANT_ROUTE_DECISIONS fails the typecheck,
 * and a registered route outside the contract missing from
 * ASSISTANT_UNCONTRACTED_ROUTE_DECISIONS fails assistantRouteAllowlist.test.ts.
 * So "nobody decided" stops a merge instead of quietly denying, the way
 * `POST /third-party-events/delivered` was denied by omission. `pairsWith`
 * names the routes an allowed one only works together with, for review.
 */
export type AssistantRouteDecision =
  | { allow: true; reason: string; pairsWith?: readonly string[] }
  | { allow: false; reason: string };

const OUTSIDE_OWNER_DM = "Acts in or reads conversations beyond its owner DM; an assistant talks only with its owner and reads through the owner-scoped /assistant routes.";
const NOT_A_SERVER_ADMIN = "Changes the server or its settings; an assistant never administers anything.";
const NO_TASKS = "Tasks live in channels; an assistant does not take or manage work there.";
const RAFT_REMINDERS = "Raft's own reminders; an assistant schedules through the Reminder app (assistantIntegrations.ts).";
const NO_APP_MANAGEMENT = "Creates or manages a Raft app; an assistant only uses the Reminder app.";
const NO_ARTIFACTS = "The Artifacts app; an assistant reaches no first-party app (assistantReachesApp).";
const NO_RAFTBENCH = "RaftBench runs only for its dedicated agent.";
const NOT_FOR_ASSISTANTS = "Not part of what an assistant does for its owner.";
// Same wording as assistantService.ASSISTANT_PROFILE_FIXED_ERROR (not imported: keeps this table free of service imports).
const ASSISTANT_PROFILE_FIXED = "An assistant's name and avatar are always Ottie's, so there is nothing to change: leave them out.";
const OWNER_DM_ATTACHMENT = "An attachment in the owner DM only (held there in the handler).";

export const ASSISTANT_ROUTE_DECISIONS = {
  // Self
  agentContext: { allow: true, reason: "Its own context: who it is, its owner, what it may use." },
  events: { allow: true, reason: "Its own events (doorbells, reminders) by id or by pull.", pairsWith: ["POST /third-party-events/delivered"] },
  pushWebhookStatus: { allow: true, reason: "Its own push registration.", pairsWith: ["events"] },
  pushWebhookRegister: { allow: true, reason: "Its own push registration: how its runtime is woken.", pairsWith: ["events", "POST /third-party-events/delivered"] },
  pushWebhookDelete: { allow: true, reason: "Its own push registration." },
  profileShow: { allow: true, reason: "Its own profile." },
  profileUpdate: { allow: false, reason: ASSISTANT_PROFILE_FIXED },
  profileAvatarUpdate: { allow: false, reason: ASSISTANT_PROFILE_FIXED },
  // The owner DM only (enforced in the handler or by the post gate)
  messageSendV2: { allow: true, reason: "Talks to its owner; the post gate holds it to the owner DM." },
  messageSend: { allow: false, reason: "The v1 send; an assistant uses messageSendV2." },
  historyRead: { allow: true, reason: "Reads its owner DM (held there in the handler)." },
  messageReactionAdd: { allow: true, reason: "Reacts in its owner DM (held there in the handler)." },
  messageReactionRemove: { allow: true, reason: "Reacts in its owner DM (held there in the handler)." },
  messageCardUpdate: { allow: true, reason: "Updates a card message it sent in its owner DM (held there in the handler).", pairsWith: ["messageSendV2"] },
  attachmentUploadCapabilities: { allow: true, reason: OWNER_DM_ATTACHMENT, pairsWith: ["attachmentUploadSessionCreate"] },
  attachmentUploadSessionCreate: { allow: true, reason: OWNER_DM_ATTACHMENT, pairsWith: ["attachmentUploadSessionComplete", "attachmentUploadSessionCancel", "attachmentUploadSessionStatus"] },
  attachmentUploadSessionComplete: { allow: true, reason: OWNER_DM_ATTACHMENT, pairsWith: ["attachmentUploadSessionCreate"] },
  attachmentUploadSessionCancel: { allow: true, reason: OWNER_DM_ATTACHMENT, pairsWith: ["attachmentUploadSessionCreate"] },
  attachmentUploadSessionStatus: { allow: true, reason: OWNER_DM_ATTACHMENT, pairsWith: ["attachmentUploadSessionCreate"] },
  attachmentUpload: { allow: false, reason: "The one-shot upload; an assistant uses upload sessions." },
  attachmentDownloadUrl: { allow: true, reason: OWNER_DM_ATTACHMENT, pairsWith: ["attachmentDownload"] },
  attachmentDownload: { allow: true, reason: OWNER_DM_ATTACHMENT, pairsWith: ["attachmentDownloadUrl"] },
  attachmentCommentsList: { allow: false, reason: OUTSIDE_OWNER_DM },
  // Borrowed reads of what the owner can see (RFC 074)
  assistantOwnerInbox: { allow: true, reason: "The owner's inbox as the owner sees it, owner's mute included.", pairsWith: ["assistantOwnerMessages"] },
  assistantOwnerMessages: { allow: true, reason: "Reads a conversation the owner can see; pure read, moves no read position.", pairsWith: ["assistantOwnerInbox"] },
  assistantOwnerArtifact: { allow: true, reason: "Reads an Artifact the owner can open, by the web's own checks with the owner as reader (one in a DM only while the owner lets it read DMs, its own DM with the owner always); pure read: moves no read position, follows nothing (#proj-assistant:#31)." },
  assistantOwnerArtifactPublish: { allow: true, reason: "Publishes an Artifact as itself into its DM with its owner, or a new version of one it published (marked; anything else is NOT_PUBLISHED_BY_ASSISTANT); Artifacts' own publish, its checks, quota and notices (#proj-assistant:#31).", pairsWith: ["assistantOwnerArtifact", "messageSendV2"] },
  // What the owner did themself (RFC 077 owner actions)
  assistantOwnerActivity: { allow: true, reason: "What the owner did themself, so it does not tell them." },
  assistantOwnerResolve: { allow: true, reason: "Names a person or channel the owner can see." },
  assistantCheckStateImport: { allow: true, reason: "Imports its own check state (RFC 077)." },
  assistantNotify: {
    allow: true,
    reason: "Tells its owner: Raft writes and sends the DM itself, to the owner DM only. The body has no recipient field and its items are held to the check's own candidates; a summary is plain message text like any other.",
    pairsWith: ["assistantToldRecord", "assistantToldList"],
  },
  assistantContactRules: { allow: true, reason: "Its own contact rules for its owner (RFC 077)." },
  assistantContactRuleAdd: { allow: true, reason: "Its own contact rules for its owner (RFC 077)." },
  assistantContactRuleRemove: { allow: true, reason: "Its own contact rules for its owner (RFC 077)." },
  assistantContactSettings: { allow: true, reason: "Its owner's quiet hours (RFC 077)." },
  // The owner's own settings, when the owner asks for a change (owner-visible: every change is audited and shown on their settings page)
  assistantOwnerSettings: { allow: true, reason: "Reads its owner's theme in this server, UI language and time zone, so it can change them when asked.", pairsWith: ["assistantOwnerSettingsUpdate"] },
  assistantOwnerSettingsUpdate: {
    allow: true,
    reason: "Changes its owner's theme in this server only, UI language or time zone when the owner asks; the web's own checks, every change audited and shown to the owner on their settings page.",
    pairsWith: ["assistantOwnerSettings"],
  },
  assistantContactRulesImport: { allow: true, reason: "Imports its own contact rules (RFC 077)." },
  assistantToldRecord: { allow: true, reason: "Records what it told its owner.", pairsWith: ["assistantNotify"] },
  assistantToldList: { allow: true, reason: "Lists what it told its owner.", pairsWith: ["assistantNotify"] },
  // Sending as the owner, once they turned it on (RFC 077)
  assistantSendAsOwner: { allow: true, reason: "Sends as its owner only once the owner turned it on; the handler checks that and labels the message (RFC 077)." },
  assistantForwardAsOwner: { allow: true, reason: "Forwards as its owner by the web's forward rules, only once the owner turned sending on; labeled and receipted (RFC 077)." },
  assistantSearchForwardTargets: { allow: true, reason: "The web forward picker's search, as its owner (RFC 077)." },
  // The Reminder app only (task #7): the list shows only it, a login to any other app is refused
  // (assistantIntegrations.ts). The app is then called directly with its session, not through Raft.
  integrationList: { allow: true, reason: "Lists only the Reminder app for an assistant.", pairsWith: ["integrationLogin"] },
  integrationLogin: { allow: true, reason: "Logs in to the Reminder app only; any other app is refused.", pairsWith: ["integrationList"] },
  integrationToken: { allow: false, reason: "An assistant calls the Reminder app with the session from integrationLogin." },
  integrationMarketplaceSearch: { allow: false, reason: "Finding apps to install; an assistant only uses the Reminder app." },
  integrationAppPrepare: { allow: false, reason: NO_APP_MANAGEMENT },
  integrationAppRotateSecret: { allow: false, reason: NO_APP_MANAGEMENT },
  integrationAppTransferOwner: { allow: false, reason: NO_APP_MANAGEMENT },
  integrationAppUpdate: { allow: false, reason: NO_APP_MANAGEMENT },
  integrationAppManage: { allow: false, reason: NO_APP_MANAGEMENT },
  integrationAppLogoUpdate: { allow: false, reason: NO_APP_MANAGEMENT },
  integrationAppList: { allow: false, reason: NO_APP_MANAGEMENT },
  integrationAppStatus: { allow: false, reason: NO_APP_MANAGEMENT },
  // Everything else: denied
  messageResolve: { allow: false, reason: OUTSIDE_OWNER_DM },
  messageSearch: { allow: false, reason: OUTSIDE_OWNER_DM },
  channelJoin: { allow: false, reason: OUTSIDE_OWNER_DM },
  channelLeave: { allow: false, reason: OUTSIDE_OWNER_DM },
  channelMute: { allow: false, reason: "Its own channel mute; an assistant is in no channel (the owner's mute applies through the owner inbox)." },
  channelUnmute: { allow: false, reason: "Its own channel mute; an assistant is in no channel (the owner's mute applies through the owner inbox)." },
  channelArchive: { allow: false, reason: NOT_A_SERVER_ADMIN },
  channelUnarchive: { allow: false, reason: NOT_A_SERVER_ADMIN },
  channelCreate: { allow: false, reason: NOT_A_SERVER_ADMIN },
  channelUpdate: { allow: false, reason: NOT_A_SERVER_ADMIN },
  channelMemberAdd: { allow: false, reason: NOT_A_SERVER_ADMIN },
  channelMemberRemove: { allow: false, reason: NOT_A_SERVER_ADMIN },
  channelMembers: { allow: false, reason: OUTSIDE_OWNER_DM },
  resolveChannel: { allow: false, reason: "Resolves a channel for itself; it names things through assistantOwnerResolve." },
  threadFollow: { allow: false, reason: OUTSIDE_OWNER_DM },
  threadUnfollow: { allow: false, reason: OUTSIDE_OWNER_DM },
  threadList: { allow: false, reason: OUTSIDE_OWNER_DM },
  // RFC 081, app rows only (Tenny, #wg-ax:#17): its own app notices (`app:system.assistant/...`, its
  // Reminder app's) once `raft message check` is gone. Never a conversation, reminder or agent-event
  // target: the handlers list no conversation row and refuse those (agentInboxItemsRoutes.ts
  // refuseAssistantNonAppTarget). Its owner DM stays on `events`, the one path that records its turns.
  inboxList: { allow: true, reason: "Lists its own app notices only (app rows): never a conversation row; what it watches is its owner's, through assistantOwnerInbox.", pairsWith: ["inboxRead"] },
  inboxRead: { allow: true, reason: "Reads and consumes its own app notices (app targets only); a conversation target is refused: its owner DM reaches it through events.", pairsWith: ["inboxList"] },
  inboxDismiss: { allow: true, reason: "Dismisses its own app notices (app targets only, `before` takes app rows only); never a conversation's read position.", pairsWith: ["inboxList"] },
  mentionsList: { allow: false, reason: "Its own mentions; an assistant is in no channel." },
  mentionActionsPending: { allow: false, reason: OUTSIDE_OWNER_DM },
  senderMentionDeliveries: { allow: false, reason: OUTSIDE_OWNER_DM },
  mentionActionsExecute: { allow: false, reason: OUTSIDE_OWNER_DM },
  userChannels: { allow: false, reason: OUTSIDE_OWNER_DM },
  serverInfo: { allow: false, reason: OUTSIDE_OWNER_DM },
  serverUpdate: { allow: false, reason: NOT_A_SERVER_ADMIN },
  serverLabs: { allow: false, reason: NOT_A_SERVER_ADMIN },
  serverLabsAccess: { allow: false, reason: NOT_A_SERVER_ADMIN },
  serverLabEnrollment: { allow: false, reason: NOT_A_SERVER_ADMIN },
  appConfigGet: { allow: false, reason: NOT_A_SERVER_ADMIN },
  appConfigPatch: { allow: false, reason: NOT_A_SERVER_ADMIN },
  appSourceAck: { allow: false, reason: RAFT_REMINDERS },
  knowledgeGet: { allow: false, reason: NOT_FOR_ASSISTANTS },
  knowledgeSearch: { allow: false, reason: NOT_FOR_ASSISTANTS },
  // Warden (#wg-ax:#15): its own context only, which it already read; v1 has no other target.
  contextSearch: { allow: true, reason: "Its own View Context: what it read when it sent a message." },
  contextRead: { allow: true, reason: "Its own View Context: what it read when it sent a message." },
  managedMcpTools: { allow: false, reason: NOT_FOR_ASSISTANTS },
  managedMcpCall: { allow: false, reason: NOT_FOR_ASSISTANTS },
  feedbackLocatorIngest: { allow: false, reason: NOT_FOR_ASSISTANTS },
  feedbackLocatorList: { allow: false, reason: NOT_FOR_ASSISTANTS },
  actionPrepare: { allow: false, reason: "Action cards for channel work; an assistant talks to its owner in plain messages." },
  actionWithdraw: { allow: false, reason: "Withdraws a question card, which an assistant never prepares." },
  taskClaim: { allow: false, reason: NO_TASKS },
  taskList: { allow: false, reason: NO_TASKS },
  taskCreate: { allow: false, reason: NO_TASKS },
  taskUnclaim: { allow: false, reason: NO_TASKS },
  taskAssign: { allow: false, reason: NO_TASKS },
  taskUpdateStatus: { allow: false, reason: NO_TASKS },
  taskResourceReceipt: { allow: false, reason: NO_TASKS },
  taskDelete: { allow: false, reason: NO_TASKS },
  taskConvert: { allow: false, reason: NO_TASKS },
  taskAmend: { allow: false, reason: NO_TASKS },
  taskHistory: { allow: false, reason: NO_TASKS },
  taskView: { allow: false, reason: NO_TASKS },
  taskRead: { allow: false, reason: NO_TASKS },
  taskReply: { allow: false, reason: NO_TASKS },
  taskFollowing: { allow: false, reason: NO_TASKS },
  taskFollow: { allow: false, reason: NO_TASKS },
  taskUnfollow: { allow: false, reason: NO_TASKS },
  taskIdleNudge: { allow: false, reason: NO_TASKS },
  migrationRetry: { allow: false, reason: "An assistant is never on a Computer, so it has no migration to retry." },
  reminderList: { allow: false, reason: RAFT_REMINDERS },
  reminderCreate: { allow: false, reason: RAFT_REMINDERS },
  reminderCancel: { allow: false, reason: RAFT_REMINDERS },
  reminderSnooze: { allow: false, reason: RAFT_REMINDERS },
  reminderUpdate: { allow: false, reason: RAFT_REMINDERS },
  reminderLog: { allow: false, reason: RAFT_REMINDERS },
  artifactList: { allow: false, reason: NO_ARTIFACTS },
  artifactRead: { allow: false, reason: NO_ARTIFACTS },
  artifactFile: { allow: false, reason: NO_ARTIFACTS },
  artifactFileContent: { allow: false, reason: NO_ARTIFACTS },
  artifactComments: { allow: false, reason: NO_ARTIFACTS },
  artifactPublish: { allow: false, reason: NO_ARTIFACTS },
  artifactImport: { allow: false, reason: NO_ARTIFACTS },
  artifactUpload: { allow: false, reason: NO_ARTIFACTS },
  artifactCommentImageUpload: { allow: false, reason: NO_ARTIFACTS },
  artifactCommentImage: { allow: false, reason: NO_ARTIFACTS },
  artifactCheck: { allow: false, reason: NO_ARTIFACTS },
  artifactCheckShot: { allow: false, reason: NO_ARTIFACTS },
  artifactComment: { allow: false, reason: NO_ARTIFACTS },
  artifactReview: { allow: false, reason: NO_ARTIFACTS },
  artifactCommentResolve: { allow: false, reason: NO_ARTIFACTS },
  artifactCommentReopen: { allow: false, reason: NO_ARTIFACTS },
  artifactSubscribe: { allow: false, reason: NO_ARTIFACTS },
  artifactUnsubscribe: { allow: false, reason: NO_ARTIFACTS },
  artifactMove: { allow: false, reason: NO_ARTIFACTS },
  artifactDelete: { allow: false, reason: NO_ARTIFACTS },
  artifactSaveAttachment: { allow: false, reason: NO_ARTIFACTS },
  raftbenchFindings: { allow: false, reason: NO_RAFTBENCH },
  raftbenchContext: { allow: false, reason: NO_RAFTBENCH },
  raftbenchSubmit: { allow: false, reason: NO_RAFTBENCH },
} as const satisfies Record<AgentApiRouteKey, AssistantRouteDecision>;

/** The contract routes an assistant may call (ASSISTANT_ROUTE_DECISIONS `allow`). */
export const ASSISTANT_ALLOWED_AGENT_API_ROUTES: readonly AgentApiRouteKey[] = (Object.keys(ASSISTANT_ROUTE_DECISIONS) as AgentApiRouteKey[])
  .filter((key) => ASSISTANT_ROUTE_DECISIONS[key].allow);

/** Every Agent API route registered outside the shared contract, decided the same way. */
export const ASSISTANT_UNCONTRACTED_ROUTE_DECISIONS: ReadonlyArray<{ method: string; path: string } & AssistantRouteDecision> = [
  { method: "GET", path: "/", allow: true, reason: "whoami: who its credential is." },
  { method: "POST", path: "/activity", allow: true, reason: "Reports its own activity every turn (the most-called route)." },
  {
    method: "POST",
    path: "/third-party-events/delivered",
    allow: true,
    reason: "Reports that it handled its own events; the route only marks rows of the calling agent.",
    pairsWith: ["events", "pushWebhookRegister"],
  },
  { method: "GET", path: "/wake-hints", allow: false, reason: "Computer-hosted wake hints; an assistant is hosted and woken by push." },
  { method: "GET", path: "/wake-hints/stream", allow: false, reason: "Computer-hosted wake hints; an assistant is hosted and woken by push." },
  { method: "GET", path: "/mentions/:messageId/delivery", allow: false, reason: OUTSIDE_OWNER_DM },
  { method: "POST", path: "/attachments/:attachmentId/comments", allow: false, reason: OUTSIDE_OWNER_DM },
  { method: "POST", path: "/server/avatar", allow: false, reason: NOT_A_SERVER_ADMIN },
  { method: "POST", path: "/credentials/self/revoke", allow: false, reason: "Its credential is held and replaced by its hosted runtime; an assistant never revokes it (the route also refuses every key a person did not mint)." },
];

export const ASSISTANT_ROUTE_NOT_ALLOWED_CODE = "assistant_route_not_allowed";

export const ASSISTANT_ROUTE_NOT_ALLOWED_BODY = {
  error: "A personal assistant can only work in its DM with its owner and read what its owner can see; this operation is not available to it.",
  code: ASSISTANT_ROUTE_NOT_ALLOWED_CODE,
  suggestedNextAction: "Reply to your owner in your DM with them. Do not retry: this will not change.",
} as const;

const AGENT_API_PREFIX = "/internal/agent-api";

function pathPattern(path: string): RegExp {
  const escaped = path.split("/").map((segment) => segment.startsWith(":")
    ? "[^/]+"
    : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/");
  return new RegExp(`^${escaped}$`);
}

const ALLOWED: ReadonlyArray<{ method: string; pattern: RegExp }> = [
  ...ASSISTANT_ALLOWED_AGENT_API_ROUTES.map((key) => {
    const route = agentApiContract[key];
    return { method: route.method, pattern: pathPattern(route.path) };
  }),
  ...ASSISTANT_UNCONTRACTED_ROUTE_DECISIONS.filter((route) => route.allow).map((route) => ({ method: route.method, pattern: pathPattern(route.path) })),
];

/**
 * Whether an assistant's credential reaches any route of the first-party app
 * `appId`. An app's agent API routes are the contract routes at `/<id>` or
 * under `/<id>/` (platform/apps.ts). None is allowlisted today, so an
 * assistant's context lists no app (`features.enabledApps`) and a client
 * built from it offers no tool Raft would refuse.
 */
export function assistantReachesApp(appId: string): boolean {
  return ASSISTANT_ALLOWED_AGENT_API_ROUTES.some((key) => {
    const path = agentApiContract[key].path;
    return path === `/${appId}` || path.startsWith(`/${appId}/`);
  });
}

/** `originalPath` is the request path without its query string, e.g. `/internal/agent-api/history`. */
export function isAssistantAgentApiRequestAllowed(method: string, originalPath: string): boolean {
  if (!originalPath.startsWith(AGENT_API_PREFIX)) return false;
  const path = originalPath.slice(AGENT_API_PREFIX.length).replace(/\/+$/, "") || "/";
  const upper = method.toUpperCase();
  return ALLOWED.some((route) => route.method === upper && route.pattern.test(path));
}
