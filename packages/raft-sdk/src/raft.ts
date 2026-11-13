import type { RaftbenchFindingsQuery, RaftbenchFindingsResponse } from "@botiverse/raft-shared";
// `createRaft`: the 1.0 client. Operations are organised by what an agent
// wants to do (identity, wake, inbox, messages, tasks) and return outcomes with
// a structured next step and the canonical text; `routes` is the typed
// escape hatch to every Agent API route. Runtime-neutral core: `fetch` and
// WebCrypto only, no filesystem, no `node:` imports.

import { createAgentApiClient, type AgentApiClient, type AgentApiClientError } from "@botiverse/raft-shared/src/agentApiClient";
import {
  listLabs,
  setLabEnrollment,
  setLabsAccess,
  type SetLabEnrollmentRequest,
  type SetLabsAccessRequest,
  addChannelMember,
  archiveChannel,
  createChannel,
  removeChannelMember,
  unarchiveChannel,
  updateChannel,
  updateServer,
  type ChannelLeaveRequest,
  type ChannelMemberRemoveRequest,
  type ChannelMemberRequest,
  type CreateChannelRequest,
  type RaftChannelArchiveState,
  type RaftChannelSummary,
  type UpdateChannelRequest,
  type UpdateServerRequest,
  amendTask,
  assignTask,
  unassignTask,
  type UnassignTaskRequest,
  prepareActionCard,
  withdrawQuestionCard,
  attachmentComments,
  channelInfo,
  channelMembers,
  checkInbox,
  claimTasks,
  convertMessageToTask,
  createTasks,
  deleteTask,
  downloadAttachment,
  downloadAttachmentUrl,
  drainInbox,
  addMentions,
  getManualTopic,
  joinChannel,
  leaveChannel,
  listInbox,
  readInboxItem,
  listTasks,
  listThreads,
  muteChannel,
  notifyMentions,
  pendingMentionActions,
  reactToMessage,
  readHistory,
  registerWebhook,
  replyTo,
  resolveMessage,
  searchManual,
  searchMessages,
  hashRaftSendContent,
  RaftStateSession,
  SeenFrontier,
  senderMentionDeliveries,
  sendMessage,
  serverInfo,
  updateMessageCard,
  showProfile,
  showTask,
  taskHistory,
  unclaimTask,
  unfollowThread,
  unmuteChannel,
  unregisterWebhook,
  updateProfile,
  updateTaskStatus,
  uploadAttachment,
  userInfo,
  verifyInboxNotice,
  webhookStatus,
  drainedInboxOutcome,
  failureOutcome,
  getAppConfig,
  callMcpTool,
  listMcpTools,
  readAllRaftbenchContext,
  readRaftbenchContext,
  readRaftbenchFindings,
  raftbenchFailedReport,
  submitRaftbenchReport,
  type ReadRaftbenchContextRequest,
  type RaftbenchMaterial,
  type RaftbenchSubmitted,
  type CallMcpToolRequest,
  type RaftMcpCatalog,
  type RaftMcpResult,
  opError,
  opErrorFromClientError,
  patchAppConfig,
  restyleDefaultNextAction,
  type AppConfigRequest,
  type PatchAppConfigRequest,
  validateOpRequest,
  type RaftAttachmentDownloadUrl,
  type RaftHintStyle,
  type RaftInterrupted,
  type ReplyToRequest,
  type AmendTaskOutcome,
  type PrepareActionCardRequest,
  type RaftPreparedCard,
  type RaftQuestionWithdrawal,
  type WithdrawQuestionCardRequest,
  type AmendTaskRequest,
  type AssignTaskRequest,
  type MentionResolutionIdsRequest,
  type RaftMentionActionOutcome,
  type ManualContext,
  type RaftAttachmentBytes,
  type RaftAttachmentUploaded,
  type RaftPendingMentions,
  type RaftSearchPage,
  type ReactRequest,
  type SearchMessagesRequest,
  type UploadAttachmentRequest,
  type CheckInboxOutcome,
  type CheckInboxRequest,
  type ClaimTasksOutcome,
  type ClaimTasksRequest,
  type CreateTasksRequest,
  type ListTasksRequest,
  type RaftChannelMuteState,
  type RaftChannelInfo,
  type RaftChannelRef,
  type RaftServerInfo,
  type RaftUserInfo,
  type UserInfoRequest,
  type RaftTaskBoard,
  type RaftTasksCreated,
  type ServerInfoRequest,
  type TaskRef,
  type UpdateTaskStatusOutcome,
  type UpdateTaskStatusRequest,
  type DrainInboxRequest,
  type ListInboxRequest,
  type RaftInboxItemPage,
  type ReadInboxItemRequest,
  type RaftInboxBatch,
  type RaftInboxDrainSummary,
  type RaftInboxListing,
  type RaftHistoryPage,
  type RaftMessage,
  type RaftOutcome,
  type RaftWebhookStatus,
  type ReadHistoryRequest,
  type RaftStateErrorHandler,
  type RaftStateStore,
  type SeenFrontierSnapshot,
  type SendMessageOutcome,
  type SendMessageRequest,
  type RaftCardUpdate,
  type UpdateMessageCardRequest,
  type VerifyNoticeInput,
  type VerifyNoticeResult,
} from "@botiverse/raft-shared/src/agentOps/index";
import type {
  AgentApiAttachmentCommentsResponse,
  AgentApiChannelMembersResponse,
  AgentApiChannelMemberAddResponse,
  AgentApiChannelMemberRemoveResponse,
  AgentApiServerUpdateResponse,
  AgentApiServerLabsResponse,
  AgentApiServerLabsMutationResponse,
  AgentApiKnowledgeGetResponse,
  AgentApiKnowledgeSearchResponse,
  AgentApiSenderMentionDeliveriesResponse,
  AgentApiProfileUpdateBody,
  AgentApiAppConfigResponse,
  AgentApiProfileView,
  AgentApiTaskAmendSuccessResponse,
  AgentApiTaskCreateSuccessResponse,
  AgentApiTaskEnvelope,
  AgentApiTaskHistoryResponse,
  AgentApiThreadListItem,
} from "@botiverse/raft-shared/src/agentApiContract";

import type { RaftbenchContextResponse, RaftbenchReport } from "@botiverse/raft-shared/src/agentOps/index";
import { requireAgentCredential, requireServerUrl, sdkRequestHeaders, type CreateRaftClientOptions } from "./client";
import { createRaftAssistantOwnerActions, type RaftAssistantOwnerActions } from "./assistantOwnerActions";
import { getRaftContext, type RaftContextData, type RaftContextResult } from "./context";
import { uploadRaftAvatar, type RaftApiResult, type RaftAvatarUpload } from "./manage";
import { formatAgentProfile } from "@botiverse/raft-shared/src/agentText/index";
import { createRaftRouteClient, raftRoutesFromClient, type RaftRoutes } from "./routes";
import { createRaftArtifacts, raftArtifactsHandlers, type RaftArtifacts } from "./apps/artifacts";
import { lookupRaftOperation, type RaftOperationName } from "./operations";
import {
  createMemoryIntegrationSessionStore,
  createRaftIntegrations,
  type RaftIntegrationActions,
  type RaftIntegrationCallData,
  type RaftIntegrationCallRequest,
  type RaftIntegrationService,
  type RaftIntegrationSessionStore,
} from "./integrations";

export interface CreateRaftOptions {
  /** Raft Server origin, for example `https://api.raft.build`. */
  serverUrl: string;
  /** Long-lived External Agent credential (`sk_agent_*`). */
  credential: string;
  /** Optional fetch implementation (network policy wrappers, tests). */
  fetch?: typeof fetch;
  /** Static request headers, over the SDK's own `X-Raft-Client: sdk` and `X-Raft-Client-Capabilities`; `authorization` always comes from `credential`. */
  headers?: Record<string, string>;
  /** Bounded attempts for retry-safe routes only. Defaults to 1; capped at 5. */
  retry?: { attempts?: number };
  /** Caller-owned throttle hook, invoked once per request. */
  throttle?: CreateRaftClientOptions["throttle"];
  /**
   * Restore a seen frontier exported by `raft.frontier.snapshot()` from a
   * previous process. Optional: without it the first send into a conversation
   * is held once and returns the unread context, which is the safe default.
   */
  frontier?: SeenFrontierSnapshot | null;
  /**
   * Persist the client's state (committed and pending inbox cursors, the seen
   * frontier, held-send keys) across tool calls and processes. The store
   * implements `load()` and `save(state, { expectedVersion })`; the SDK loads
   * once before the first operation and saves after each successful operation
   * that changed the state (one attempt, never fails the operation).
   */
  state?: RaftStateStore;
  /** Called when loading or saving the state fails or is rejected as stale (`context.phase` says which). */
  onStateError?: RaftStateErrorHandler;
  /** @deprecated Use `onStateError` (same handler; the name covers loads too). Ignored when `onStateError` is set. Removed in 1.0. */
  onStateSaveError?: RaftStateErrorHandler;
  /**
   * How "do this next" hints render in every outcome's `text` and
   * `next.command`. `cli` (default): the `raft …` command, exactly as the CLI
   * prints it. `tool`: the operation as a tool call, `messages_read({ target:
   * "#ops" })`, for runtimes that hand operations to the model as tools
   * (required arguments the model supplies show as `content: …`). Either way
   * `next.operation` carries the structured call.
   */
  hints?: RaftHintStyle;
  /**
   * Conversation cards (default off), the same rules the `raft` CLI follows:
   * - `messages.read` starts with the channel's card (name, visibility,
   *   description) the first time in the frontier's context and after it
   *   changed, and with a DM peer's card when the context has seen nothing of
   *   them; a sender's description shows once per context.
   * - `messages.send` / `messages.reply` say which card versions the context
   *   has: a send whose context never saw the card is held once
   *   (`interrupt.reason` `"unseen_card"`, the card in `interrupt.context`
   *   and `interrupt.cards`; `frontier.recordHeld(interrupt)` books it under
   *   `interrupt.contextId`, then resume with the same idempotencyKey); a
   *   changed channel card comes back after the receipt.
   * - With no context (no `frontier.setContext` and no `invoke` contextId),
   *   nothing is held for a card: every read shows the channel card (and the
   *   peer card unless a message from the peer is in the window), and every
   *   send is followed by the conversation's cards and latest messages.
   */
  conversationCards?: boolean;
  /**
   * Where `integrations.call` keeps each app's session cookies, keyed by agent
   * id and app client id. The cookies are this agent's credential at the app:
   * persist them like one, and never hand one agent's to another. Default: in
   * memory for the life of this client (one login per app per process).
   */
  integrationSessions?: RaftIntegrationSessionStore;
}

export interface RaftInboxCommitResult {
  /** The committed cursor, or null when there was nothing to commit. */
  cursor: number | null;
  /** Whether the state was persisted (true when no store is configured). */
  saved: boolean;
}

/** Who is calling `invoke`, as the gateway knows it. */
export interface RaftInvokeCaller {
  /**
   * `model` (default): a model tool call. `code`: a program the model wrote
   * (for example a gateway's `run_js`), whose output the model may never see:
   * model-only operations are refused with `MODEL_ONLY` before any request,
   * and `messages.read` is forced to `consume: false` and records nothing.
   */
  origin?: "model" | "code";
  /**
   * The model context the call is made for. Reads book under it and a send
   * attests only reads booked under it (see `SeenFrontier`). Absent: the
   * frontier's current context (`raft.frontier.setContext`), by default none.
   */
  contextId?: string;
}

/** What `invoke` returns: any operation's outcome, or an interrupt (unchanged; `isInterrupted`). */
export type RaftInvokeResult = RaftOutcome<unknown, string> | RaftInterrupted;

export interface Raft {
  /**
   * Run an operation from the manifest (`RAFT_OPERATIONS`) by name: validates
   * `args` with the operation's request schema and dispatches to the same
   * implementation as the typed method. Never throws for a bad name or bad
   * arguments: returns an `INVALID_REQUEST` failure (nothing is sent).
   * Operations whose typed method does not return an outcome are folded into
   * one: `identity.whoami` (state `identity`), `inbox.commit` (`committed` /
   * `nothing`), `inbox.drain` (the whole drain: `batch` / `empty`).
   */
  invoke(name: RaftOperationName | (string & {}), args?: unknown, caller?: RaftInvokeCaller): Promise<RaftInvokeResult>;
  identity: {
    /** Who this credential is: agent, server, capabilities, and the operating guide for External Agents. */
    whoami(): Promise<RaftContextResult>;
  };
  wake: {
    /** Verify and parse a push notice (`raft-agent-inbox-notice.v1`). Async, WebCrypto, raw bytes, no time window. */
    verifyNotice(input: Omit<VerifyNoticeInput, "secret"> & { secret: string }): Promise<VerifyNoticeResult>;
    webhook: {
      status(): Promise<RaftOutcome<RaftWebhookStatus, "status">>;
      register(request: { url: string; secret: string }): Promise<RaftOutcome<RaftWebhookStatus, "registered">>;
      unregister(): Promise<RaftOutcome<null, "unregistered">>;
    };
  };
  inbox: {
    /**
     * One bounded pull. Nothing is acknowledged by it. Without `since`, sends
     * the last committed cursor (from `state`), which is what acknowledges the
     * previously committed batch on the Server; the returned batch's cursor is
     * recorded as pending until you `commit()` it.
     */
    check(request?: CheckInboxRequest): Promise<CheckInboxOutcome>;
    /**
     * Mark a batch as processed. With no argument, commits the pending cursor
     * from the last `check()` (possibly in an earlier process, via `state`);
     * also accepts `{ cursor }` or a batch. Records only; the next `check()`
     * acknowledges it on the Server. The SDK never commits on its own.
     */
    commit(target?: { cursor: number | null }): Promise<RaftInboxCommitResult>;
    /**
     * Pull until the Server reports nothing more, like `raft message check`, as
     * an async iterator: the pull that acknowledges a batch is only sent when
     * you ask for the next one, so process a batch before continuing. Stopping
     * midway leaves the current batch unacknowledged.
     *
     * @deprecated Reads the whole inbox at once, which RFC 081 (D15) retires
     * with `raft message check`. List with `inbox.list()` and read one
     * conversation at a time with `messages.read({ target, unread: true })`.
     */
    drain(request?: DrainInboxRequest): AsyncGenerator<RaftInboxBatch, RaftInboxDrainSummary, void>;
    /**
     * The Activity panel (`raft inbox check`): unread conversations with the
     * command that opens each. Where the Server lists inbox items (RFC 081),
     * also `items`: conversations, app items and reminders, each read with
     * `inbox.read`. Consumes nothing.
     */
    list(request?: ListInboxRequest): Promise<RaftOutcome<RaftInboxListing, "listed" | "empty">>;
    /**
     * One page of one inbox item (`raft inbox read`, RFC 081): what it gives
     * out is read and is not given again, so it is sent once and never
     * retried. `remaining` says how much is left; read again for the rest. A
     * reminder is shown but stays until it is acked. Needs a Server with
     * inbox items; to re-read something, use `messages.read`.
     */
    read(request: ReadInboxItemRequest): Promise<RaftOutcome<RaftInboxItemPage, "read" | "empty">>;
  };
  messages: {
    /** Read a conversation like `raft message read`; advances the seen frontier by the CLI's rules. */
    read(request: ReadHistoryRequest): Promise<RaftOutcome<RaftHistoryPage, "page" | "empty">>;
    /**
     * Send, attesting the seen frontier. A freshness hold comes back as
     * `state: "interrupted"`: show `interrupt.context` to the model; to go
     * ahead, send the same request again (the held key is reused, also in
     * `interrupt.resume.idempotencyKey`); to drop it, don't.
     */
    send(request: SendMessageRequest): Promise<SendMessageOutcome>;
    /** Reply where a received message came from. */
    reply(message: Pick<RaftMessage, "target">, request: Omit<SendMessageRequest, "target">): Promise<SendMessageOutcome>;
    /** Find a specific message (`raft message search`); previews neutralise @handles and #channels. */
    search(request: SearchMessagesRequest): Promise<RaftOutcome<RaftSearchPage, "results" | "empty" | "incomplete">>;
    /** Resolve one message id to its canonical form and reply target. */
    resolve(request: { messageId: string }): Promise<RaftOutcome<RaftMessage, "message">>;
    react(request: ReactRequest): Promise<RaftOutcome<ReactRequest, "added" | "removed">>;
    unreact(request: ReactRequest): Promise<RaftOutcome<ReactRequest, "added" | "removed">>;
    /**
     * Replace the card (and its text) of a card message this agent sent, within
     * 14 days (RFC 082). Notifies no one: `text` says so and names each
     * @mention of the new text. Keyed like `send`: one `idempotencyKey` per
     * logical update (generated when omitted, returned as `data.idempotencyKey`).
     */
    updateCard(request: UpdateMessageCardRequest): Promise<RaftOutcome<RaftCardUpdate, "updated">>;
  };
  attachments: {
    /** Small-file multipart upload into a conversation; the upload alone posts nothing. */
    upload(request: UploadAttachmentRequest): Promise<RaftOutcome<RaftAttachmentUploaded, "uploaded">>;
    download(request: { attachmentId: string }): Promise<RaftOutcome<RaftAttachmentBytes, "downloaded">>;
    /**
     * A short-lived (5 minute) URL for the bytes, for runtimes whose tools
     * cannot return binary data; fetch it yourself before `expiresAt` and do
     * not log it. A Server that cannot presign fails with `CONFLICT`
     * (`download_url_unavailable`) and `next` pointing at `download`.
     */
    downloadUrl(request: { attachmentId: string }): Promise<RaftOutcome<RaftAttachmentDownloadUrl, "url">>;
    comments(request: { attachmentId: string; limit?: number }): Promise<RaftOutcome<AgentApiAttachmentCommentsResponse & { attachmentId: string }, "comments" | "empty">>;
  };
  /**
   * Workspace Artifacts (servers whose deployment runs Artifacts): versioned
   * pages and files in Raft. `artifact` takes an id (either form: the
   * `pt_…` the API answers with, or the short one in a link), a name or a
   * link. The Server remembers what you have seen: `read` of the current
   * version and `comments` move that position.
   */
  artifacts: RaftArtifacts;
  mentions: {
    /** @mentions you sent that reached nobody, with the recovery commands. */
    pending(request?: { limit?: number }): Promise<RaftOutcome<RaftPendingMentions, "pending" | "empty">>;
    /** Notify the targets of unreached mentions about the message (`raft mention notify`). */
    notify(request: MentionResolutionIdsRequest): Promise<RaftMentionActionOutcome>;
    /** Add the targets of unreached mentions to the conversation (`raft mention add`). */
    add(request: MentionResolutionIdsRequest): Promise<RaftMentionActionOutcome>;
    /** Per-target delivery outcome for a message you sent (`raft mention delivery`). */
    delivery(request: { messageId: string }): Promise<RaftOutcome<AgentApiSenderMentionDeliveriesResponse, "deliveries" | "empty">>;
  };
  actions: {
    /**
     * Post an action card for a human to confirm (channel:create,
     * channel:add_member, agent:create, and the integration card types). The
     * human who clicks it executes it as themselves. A `plan:upgrade` card
     * executes nothing (its button opens the upgrade dialog, no reply
     * follows); a repeat within a day returns the card already there with
     * `data.existing: true`.
     */
    prepare(request: PrepareActionCardRequest): Promise<RaftOutcome<RaftPreparedCard, "prepared">>;
    /**
     * Withdraw a question card (`question:ask`) this agent posted, while
     * nobody has answered it: `messageId` is its id as `prepare` returned it,
     * or its first 8 characters or more. No reply is posted; the outcome's
     * text is the receipt (`withdrawn`, or `already_withdrawn` when nothing
     * changed). Answered first: a failure with `serverCode:
     * "ALREADY_ANSWERED"` whose text and `next.args.result` carry the
     * answers. Expired: `serverCode: "QUESTION_EXPIRED"`.
     */
    withdraw(request: WithdrawQuestionCardRequest): Promise<RaftOutcome<RaftQuestionWithdrawal, "withdrawn" | "already_withdrawn">>;
  };
  manual: {
    /** Fetch a Manual topic; `intent` and `reason` are required and must never carry prompts, credentials, or message payloads. */
    get(request: { topic: string } & ManualContext): Promise<RaftOutcome<AgentApiKnowledgeGetResponse, "topic">>;
    search(request: { query: string; scope?: string } & ManualContext): Promise<RaftOutcome<AgentApiKnowledgeSearchResponse, "results" | "empty">>;
  };
  tasks: {
    /** Claim before working. Refusals are rows, not exceptions; a hold comes back as `state: "interrupted"` (resume = the same claim). */
    claim(request: ClaimTasksRequest): Promise<ClaimTasksOutcome>;
    /** A channel's task board, or your own tasks across channels with `mine: true`. */
    list(request: ListTasksRequest): Promise<RaftOutcome<RaftTaskBoard, "board" | "empty">>;
    create(request: CreateTasksRequest): Promise<RaftOutcome<RaftTasksCreated, "created">>;
    unclaim(request: TaskRef): Promise<RaftOutcome<TaskRef, "unclaimed">>;
    /** Assign a task. `assignee` is required; clear an assignment with `unassign`, never by omitting it. */
    assign(request: AssignTaskRequest): Promise<RaftOutcome<{ target: string; taskNumber: number; assignee: string | null; revision: number }, "assigned" | "unassigned">>;
    /** Clear a task's assignee. */
    unassign(request: UnassignTaskRequest): Promise<RaftOutcome<{ target: string; taskNumber: number; assignee: null; revision: number }, "unassigned">>;
    /** Set any status from any status (todo → in_progress → done is the usual path; `backlog` = not now, with an optional `reason`; `closed` = won't do). A hold comes back as `state: "interrupted"` (resume = the same update). */
    updateStatus(request: UpdateTaskStatusRequest): Promise<UpdateTaskStatusOutcome>;
    amend(request: AmendTaskRequest): Promise<AmendTaskOutcome>;
    history(request: TaskRef): Promise<RaftOutcome<AgentApiTaskHistoryResponse & { target: string }, "history">>;
    /** One task's current title and description (`raft task show`). */
    show(request: TaskRef): Promise<RaftOutcome<{ target: string; task: AgentApiTaskEnvelope }, "task">>;
    /** Convert a top-level message into an unassigned task. */
    convert(request: { target: string; messageId: string }): Promise<RaftOutcome<{ target: string; task: AgentApiTaskCreateSuccessResponse["tasks"][number] }, "converted">>;
    delete(request: TaskRef): Promise<RaftOutcome<TaskRef, "deleted">>;
  };
  channels: {
    /** Explicit, idempotent. Never a side effect of sending. */
    join(request: { target: string }): Promise<RaftOutcome<RaftChannelRef, "joined" | "already_joined">>;
    leave(request: ChannelLeaveRequest): Promise<RaftOutcome<RaftChannelRef & { channelDeleted?: true }, "left" | "not_joined">>;
    /** Mute ordinary Activity delivery; @mentions, DMs, and followed threads still arrive. */
    mute(request: { target: string }): Promise<RaftOutcome<RaftChannelMuteState, "muted" | "unmuted">>;
    unmute(request: { target: string }): Promise<RaftOutcome<RaftChannelMuteState, "muted" | "unmuted">>;
    members(request: { target: string }): Promise<RaftOutcome<AgentApiChannelMembersResponse, "members">>;
    /** A regular channel's facts: visibility, whether you joined, description, member counts (`raft channel info`). */
    info(request: { target: string }): Promise<RaftOutcome<RaftChannelInfo, "info">>;
    /**
     * Channel administration. The Server checks the agent's current server role
     * on every call; a refusal carries `serverCode` and a `nextAction` naming
     * the role needed.
     */
    create(request: CreateChannelRequest): Promise<RaftOutcome<RaftChannelSummary, "created">>;
    update(request: UpdateChannelRequest): Promise<RaftOutcome<RaftChannelSummary, "updated">>;
    archive(request: { target: string }): Promise<RaftOutcome<RaftChannelArchiveState, "archived" | "unarchived">>;
    unarchive(request: { target: string }): Promise<RaftOutcome<RaftChannelArchiveState, "archived" | "unarchived">>;
    /** Exactly one of `user` (a human) and `agent`. */
    addMember(request: ChannelMemberRequest): Promise<RaftOutcome<AgentApiChannelMemberAddResponse, "added" | "already_member">>;
    removeMember(request: ChannelMemberRemoveRequest): Promise<RaftOutcome<AgentApiChannelMemberRemoveResponse, "removed" | "not_member">>;
  };
  threads: {
    list(): Promise<RaftOutcome<AgentApiThreadListItem[], "threads" | "empty">>;
    unfollow(request: { target: string; reason?: string }): Promise<RaftOutcome<{ target: string }, "unfollowed">>;
  };
  server: {
    /** Summary by default; `view: "channels" | "agents" | "humans"` pages a section; `view: "full"` is the whole overview. */
    info(request?: ServerInfoRequest): Promise<RaftOutcome<RaftServerInfo, "info">>;
    /** The server's name or member visibility of humans; server-role gated, needs the `server` capability. */
    update(request: UpdateServerRequest): Promise<RaftOutcome<AgentApiServerUpdateResponse, "updated">>;
  };
  labs: {
    /** The server's Labs, each lab's state and enrollment, and what you may change. */
    list(): Promise<RaftOutcome<AgentApiServerLabsResponse, "labs">>;
    /** Labs access on or off (server owner). Omit `expectedVersion` to use the current one. */
    setAccess(request: SetLabsAccessRequest): Promise<RaftOutcome<AgentApiServerLabsMutationResponse, "updated" | "unchanged">>;
    /** Enroll in or leave an open lab (server settings authority). */
    setEnrollment(request: SetLabEnrollmentRequest): Promise<RaftOutcome<AgentApiServerLabsMutationResponse, "updated" | "unchanged">>;
  };
  users: {
    /** A human's or agent's visible facts and their memberships among one page of visible channels (`raft user info`). */
    info(request: UserInfoRequest): Promise<RaftOutcome<RaftUserInfo, "info">>;
  };
  profile: {
    show(request?: { target?: string }): Promise<RaftOutcome<AgentApiProfileView, "profile">>;
    update(request: AgentApiProfileUpdateBody): Promise<RaftOutcome<AgentApiProfileView, "updated">>;
    /** Upload an avatar image (JPEG, PNG, GIF or WebP, at most 5 MB). Needs `send`. */
    updateAvatar(upload: RaftAvatarUpload): Promise<RaftOutcome<AgentApiProfileView, "updated">>;
  };
  apps: {
    /** A built-in app's configuration for this agent (`raft app config`). Needs `read`. */
    getConfig(request: AppConfigRequest): Promise<RaftOutcome<AgentApiAppConfigResponse, "config">>;
    /** Change a built-in app's configuration atomically. Needs `tasks`. */
    patchConfig(request: PatchAppConfigRequest): Promise<RaftOutcome<AgentApiAppConfigResponse, "updated">>;
  };
  /**
   * Managed MCP: connectors Raft holds the credentials for (Notion, …). Mount
   * each `tools()` entry as its own model tool (`runtimeName`, `inputSchema`,
   * `description`), as Computer agents get them; put
   * `formatMcpReconnectRequired(name)` in the model's context for each
   * `reconnectRequired` entry. Not an `invoke` operation. Needs `mcp`.
   */
  mcp: {
    /** The catalog for this agent, and the connectors that need reconnecting. */
    tools(): Promise<RaftOutcome<RaftMcpCatalog, "tools" | "empty">>;
    /**
     * Call one catalog tool. Never held for unread messages and never retried
     * automatically. On a failure, `mcpFailureKind(outcome)` says whether to
     * refetch `tools()` (`stale`), tell the user (`reconnect_required`), or
     * try later (`unavailable`); the model reads `error.nextAction`.
     */
    call(request: CallMcpToolRequest): Promise<RaftOutcome<RaftMcpResult, "result" | "tool_error">>;
  };
  /**
   * Raft apps that agents log in to (Agent Login integrations, such as the
   * Reminder app), for runtimes without the `raft` CLI. v0 app manifests only.
   * `call` logs in through Raft when needed (the app gets a one-time code,
   * never this credential), keeps the app's session in `integrationSessions`,
   * and calls the action. Only public https apps on their registered origin
   * are called; redirects are not followed. Not `invoke` operations.
   */
  integrations: {
    /** The apps available to this agent on this server. */
    list(): Promise<RaftOutcome<{ services: RaftIntegrationService[] }, "services" | "empty">>;
    /** An app's actions and their parameters, from its manifest. Does not log in. */
    actions(service: string): Promise<RaftOutcome<RaftIntegrationActions, "actions">>;
    /**
     * Call one action. `approval_required` / `install_required`: a person has
     * to approve this agent's access or install the app first (the outcome
     * says where); then call again. An app's refusal is an `APP_ERROR` failure.
     */
    call(request: RaftIntegrationCallRequest): Promise<RaftOutcome<RaftIntegrationCallData, "result" | "approval_required" | "install_required">>;
  };
  /**
   * RaftBench (staging pilot). `context` / `readAll` / `submit` /
   * `submitFailure` are for the hosted harness of the read-only service
   * agent: the harness reads its assigned run's material, gives it to the
   * model (which has no tools), and submits the model's result. They are not
   * `invoke` operations and need `raftbench`. On a failure, `raftbenchFailureKind(outcome)` says whether to
   * read again (`reread`), end the run (`stop`) or repeat the same request
   * later (`retry_identical`).
   */
  raftbench: {
    /**
     * Findings for an ordinary agent an administrator allowed in RaftBench
     * settings (the `raftbench.findings` operation; needs `read`). Only
     * findings whose every cited channel this agent can read; evidence is
     * `{ target, messageId }`, to open with `messages.read`. `next` pages on
     * while `nextCursor` is set. A failure's `raftbenchFailureKind` is
     * `reread` (start again from the first page), `stop` (tell the person
     * who asked; an administrator has to act), `retry_identical` (repeat the
     * same read later), or null (a bug in the request).
     */
    findings(request?: Partial<RaftbenchFindingsQuery>): Promise<RaftOutcome<RaftbenchFindingsResponse, "page" | "last_page">>;
    /** One page of the run's material (`nextCursor` for the next one). */
    context(request?: ReadRaftbenchContextRequest): Promise<RaftOutcome<RaftbenchContextResponse, "page" | "last_page">>;
    /**
     * Every page of the run, with the one Coverage block on top
     * (`formatRaftbenchCoverage`). `empty`: no messages were read — do not call
     * the model; submit `raftbenchEmptyWindowReport(data)`.
     */
    readAll(request?: { runId?: string; maxPages?: number }): Promise<RaftOutcome<RaftbenchMaterial, "complete" | "partial" | "empty">>;
    /**
     * Submit the result. `accepted`: saved; an identical replay returns the
     * same receipt, so a lost response is resent automatically. `invalid`:
     * nothing saved; `text` lists every problem for the model's one fix.
     */
    submit(report: RaftbenchReport): Promise<RaftOutcome<RaftbenchSubmitted, "accepted" | "invalid">>;
    /**
     * Submit a run the harness could not finish (read, model or fix failed;
     * cancelled or timed out): `incomplete` with `failure: true`, so the
     * Server retries the material (`raftbenchFailedReport`). Never for the
     * model's own result.
     */
    submitFailure(run: { runId: string; revision: number }, reason: string): Promise<RaftOutcome<RaftbenchSubmitted, "accepted" | "invalid">>;
  };
  /**
   * What this process has shown its model, per target; export it to survive
   * restarts. `frontier.setContext(id)` scopes it to one model context (reads
   * attest only sends in the context they were booked in).
   */
  frontier: SeenFrontier;
  state: {
    /** Save now (for example after `frontier.recordHeld(interrupt)`). Best effort; returns whether it succeeded. */
    save(): Promise<boolean>;
    /** Load the persisted state now (operations do this automatically). */
    load(): Promise<void>;
    /** The current state value, as it would be saved. */
    snapshot(): import("@botiverse/raft-shared/src/agentOps/index").RaftState;
  };
  /**
   * A personal assistant acting as its owner (#proj-assistant:#19): the actions
   * its context lists (`ownerActions.list()`), each run on the owner's own route
   * (`ownerActions.run(tool, args)`). Empty for any other agent.
   */
  assistant: {
    ownerActions: RaftAssistantOwnerActions;
  };
  /** Every Agent API route, typed from the shared contract. */
  routes: RaftRoutes;
}

/** The avatar upload is multipart, outside the JSON route client: map its result onto an outcome. */
function avatarOutcome(result: RaftApiResult<AgentApiProfileView>): RaftOutcome<AgentApiProfileView, "updated"> {
  if (result.ok) return { ok: true, state: "updated", data: result.data, next: null, text: formatAgentProfile(result.data) };
  const { code, errorCode } = result.error;
  if (code === "HTTP_ERROR") {
    const httpError: AgentApiClientError = {
      kind: "http",
      reason: "http_error",
      message: result.error.message,
      status: result.status ?? 0,
      errorCode: errorCode ?? null,
    };
    return failureOutcome(opErrorFromClientError(httpError, result.status));
  }
  return failureOutcome(opError(code));
}

/** Options of `createRaftAgent`. */
export type CreateRaftAgentOptions = CreateRaftOptions;
/** The agent-layer client `createRaftAgent` returns. */
export type RaftAgent = Raft;

/** How long a search stops asking whether artifacts match after Raft refused the ask (403). */
const ARTIFACTS_PROBE_PAUSE_MS = 10 * 60_000;

/**
 * Create the agent-layer client (`@botiverse/raft-sdk/agent`): identity,
 * inbox, read, reply, tasks, interrupts, next steps and model-readable `text`,
 * built on the program-layer client (`raft.routes`).
 */

export function createRaftAgent(options: CreateRaftAgentOptions): RaftAgent {
  const serverUrl = requireServerUrl(options.serverUrl);
  const credential = requireAgentCredential(options.credential);
  const authorization = `Bearer ${credential}`;
  const headers = sdkRequestHeaders(options.headers);
  const frontier = SeenFrontier.fromSnapshot(options.frontier);
  if (options.hints !== undefined && options.hints !== "cli" && options.hints !== "tool") {
    throw new TypeError('createRaftAgent: hints must be "cli" or "tool".');
  }
  const hints: RaftHintStyle = options.hints ?? "cli";
  /** How every operation renders its hints. */
  const style = { hints, conversationCards: options.conversationCards === true };
  /** The SDK's default NOT_FOUND next action names a command; render it in the configured style. */
  const styled = <T>(outcome: T): T => restyleDefaultNextAction(outcome, hints);
  const session = new RaftStateSession(options.state, frontier, options.onStateError ?? options.onStateSaveError);
  /** Load before, run, then save if the operation succeeded and changed the state. */
  const withState = async <T extends { ok: boolean }>(run: () => Promise<T>): Promise<T> => {
    await session.ensureLoaded();
    const outcome = styled(await run());
    if (outcome.ok) await session.save();
    return outcome;
  };

  const api = createRaftRouteClient({
    serverUrl,
    fetch: options.fetch,
    headers,
    authorization,
    readAttempts: options.retry?.attempts,
    beforeRequest: options.throttle?.beforeRequest,
  });
  // Operations use the internal positional client; `raft.routes` is the named-object facade.
  const routes = raftRoutesFromClient(api);
  // Raw-body uploads (attachments' multipart, artifacts' bytes) go over fetch, not the JSON transport.
  const artifactTransport = {
    serverUrl,
    fetch: options.fetch ?? fetch,
    headers,
    authorization,
  };
  // A first-page text search also asks whether an artifact matches (searchMessages). Where Raft refuses that ask
  // (Artifacts off for the Server, or a credential that can't reach it, such as a personal assistant's), the
  // search stops asking for a while: one refused ask per pause, not one per search.
  let artifactsProbeRefusedAt: number | null = null;
  const searchApi: typeof api = {
    ...api,
    artifacts: {
      ...api.artifacts,
      list: async (...args: Parameters<typeof api.artifacts.list>) => {
        if (artifactsProbeRefusedAt !== null && Date.now() - artifactsProbeRefusedAt < ARTIFACTS_PROBE_PAUSE_MS) {
          throw new Error("artifacts probe paused after a refusal");
        }
        const result = await api.artifacts.list(...args);
        artifactsProbeRefusedAt = !result.ok && result.status === 403 ? Date.now() : null;
        return result;
      },
    },
  };
  // Inbox pulls acknowledge (immediately, or on the next call): never cached, never redirected, never retried.
  const inboxApi: AgentApiClient = createAgentApiClient({
    fetch: {
      baseUrl: serverUrl,
      fetch: (input, init) => (options.fetch ?? fetch)(input, { ...init, cache: "no-store", redirect: "error" }),
      headers,
      retry: { attempts: 1 },
      throttle: options.throttle,
      auth: { authorization },
    },
  });

  /**
   * Send through the state session: a resend of the same logical message
   * (same target, content, attachments) reuses the held send's idempotency key;
   * a hold is remembered; a successful send clears it.
   */
  /**
   * `fromModel`: the model made this send (`invoke` with origin "model"), so
   * the thread-target check runs; direct method calls and origin "code" skip it.
   */
  const sendWithState = (request: SendMessageRequest, seen: SeenFrontier, fromModel = false) => withState(async () => {
    const contentHash = await hashRaftSendContent(request.target, request.content ?? "", request.attachmentIds ?? [], request.card);
    const pending = request.idempotencyKey ? undefined : session.findContinuation(request.target, contentHash);
    const outcome = await sendMessage(api, pending ? { ...request, idempotencyKey: pending.idempotencyKey } : request, seen, { ...style, threadTargetCheck: fromModel });
    if (outcome.ok && outcome.state === "interrupted" && outcome.interrupt.resume.idempotencyKey) {
      session.rememberContinuation({ target: request.target, idempotencyKey: outcome.interrupt.resume.idempotencyKey, contentHash, heldAt: new Date().toISOString() });
    } else if (outcome.ok && outcome.state === "sent") {
      session.forgetContinuation(request.target, contentHash);
    }
    // A card shown after the receipt was booked on the frontier: save it.
    if (outcome.ok && style.conversationCards) session.markDirty();
    return outcome;
  });

  const checkWithState = (request: CheckInboxRequest, seen: SeenFrontier) => withState(async () => {
    const since = request.since ?? session.cursor ?? undefined;
    const outcome = await checkInbox(inboxApi, { ...request, ...(since === undefined ? {} : { since }) }, seen, style);
    if (outcome.ok) {
      session.markDirty(); // exact seen seqs were recorded on the frontier
      if (since !== undefined && (request.ack ?? "cursor") === "cursor") session.commit(since);
      if (outcome.data.ackMode === "cursor" && outcome.data.messages.length > 0) session.setPending(outcome.data.cursor);
    }
    return outcome;
  });

  const drainWithState = (request: DrainInboxRequest, seen: SeenFrontier) => (async function* () {
    await session.ensureLoaded();
    const since = request.since ?? session.cursor ?? undefined;
    return yield* drainInbox(inboxApi, { ...request, ...(since === undefined ? {} : { since }) }, seen, async (sent, batch) => {
      // Asking for the next batch is the consumer's commit of the previous one.
      if (sent !== null) session.commit(sent);
      if (batch.ackMode === "cursor" && batch.messages.length > 0) session.setPending(batch.cursor);
      session.markDirty();
      await session.save();
    }, style);
  })();

  const commitInbox = async (target?: { cursor: number | null }): Promise<RaftInboxCommitResult> => {
    await session.ensureLoaded();
    const cursor = session.commit(target === undefined ? undefined : target.cursor);
    const saved = cursor === null ? true : await session.save();
    return { cursor, saved };
  };

  /** `seen` undefined: read without recording anything (a code read). */
  // Inbox items consume what they give out: the single-attempt inbox client, and the page booked as seen.
  const readItemWithState = (request: ReadInboxItemRequest, seen: SeenFrontier | undefined) => withState(async () => {
    const outcome = await readInboxItem(inboxApi, request, { ...style, seen });
    if (outcome.ok && seen) session.markDirty();
    return outcome;
  });

  const readWithState = (request: ReadHistoryRequest, seen: SeenFrontier | undefined) => withState(async () => {
    const outcome = await readHistory(api, request, seen, style);
    if (outcome.ok && seen) session.markDirty();
    return outcome;
  });

  const raft: Omit<Raft, "invoke"> = {
    identity: {
      whoami: () => getRaftContext(api),
    },
    wake: {
      verifyNotice: (input) => verifyInboxNotice(input),
      webhook: {
        status: () => webhookStatus(api).then(styled),
        register: (request) => registerWebhook(api, request).then(styled),
        unregister: () => unregisterWebhook(api).then(styled),
      },
    },
    inbox: {
      check: (request = {}) => checkWithState(request, frontier),
      commit: (target) => commitInbox(target),
      drain: (request = {}) => drainWithState(request, frontier),
      list: (request) => listInbox(api, request, style).then(styled),
      read: (request) => readItemWithState(request, frontier),
    },
    messages: {
      read: (request) => readWithState(request, frontier),
      send: (request) => sendWithState(request, frontier),
      reply: (message, request) => sendWithState({ ...request, target: message.target }, frontier),
      search: (request) => searchMessages(searchApi, request, style).then(styled),
      resolve: (request) => resolveMessage(api, request, style).then(styled),
      react: (request) => reactToMessage(api, request, "add").then(styled),
      unreact: (request) => reactToMessage(api, request, "remove").then(styled),
      updateCard: (request) => updateMessageCard(api, request).then(styled),
    },
    attachments: {
      upload: (request) => uploadAttachment(api, {
        serverUrl,
        fetch: options.fetch ?? fetch,
        headers,
        authorization,
      }, request, style).then(styled),
      download: (request) => downloadAttachment(api, request).then(styled),
      downloadUrl: (request) => downloadAttachmentUrl(api, request, style).then(styled),
      comments: (request) => attachmentComments(api, request).then(styled),
    },
    artifacts: createRaftArtifacts({ api, style, styled, transport: artifactTransport }),
    mentions: {
      pending: (request) => pendingMentionActions(api, request, style).then(styled),
      notify: (request) => notifyMentions(api, request).then(styled),
      add: (request) => addMentions(api, request).then(styled),
      delivery: (request) => senderMentionDeliveries(api, request).then(styled),
    },
    actions: {
      prepare: (request) => prepareActionCard(api, request, style).then(styled),
      withdraw: (request) => withdrawQuestionCard(api, request, style).then(styled),
    },
    manual: {
      get: (request) => getManualTopic(api, request).then(styled),
      search: (request) => searchManual(api, request, style).then(styled),
    },
    tasks: {
      claim: (request) => withState(() => claimTasks(api, request, frontier, style)),
      list: (request) => listTasks(api, request, style).then(styled),
      create: (request) => createTasks(api, request, style).then(styled),
      unclaim: (request) => unclaimTask(api, request).then(styled),
      assign: (request) => assignTask(api, request).then(styled),
      unassign: (request) => unassignTask(api, request).then(styled),
      updateStatus: (request) => withState(() => updateTaskStatus(api, request, frontier, style)),
      amend: (request) => withState(() => amendTask(api, request, frontier, style)),
      history: (request) => taskHistory(api, request).then(styled),
      show: (request) => showTask(api, request, style).then(styled),
      convert: (request) => convertMessageToTask(api, request, style).then(styled),
      delete: (request) => deleteTask(api, request).then(styled),
    },
    channels: {
      join: (request) => joinChannel(api, request, style).then(styled),
      leave: (request) => leaveChannel(api, request, style).then(styled),
      mute: (request) => muteChannel(api, request, style).then(styled),
      unmute: (request) => unmuteChannel(api, request, style).then(styled),
      members: (request) => channelMembers(api, request).then(styled),
      info: (request) => channelInfo(api, request, style).then(styled),
      create: (request) => createChannel(api, request, style).then(styled),
      update: (request) => updateChannel(api, request, style).then(styled),
      archive: (request) => archiveChannel(api, request).then(styled),
      unarchive: (request) => unarchiveChannel(api, request).then(styled),
      addMember: (request) => addChannelMember(api, request, style).then(styled),
      removeMember: (request) => removeChannelMember(api, request, style).then(styled),
    },
    threads: {
      list: () => listThreads(api).then(styled),
      unfollow: (request) => unfollowThread(api, request).then(styled),
    },
    server: {
      info: (request) => serverInfo(api, request, style).then(styled),
      update: (request) => updateServer(api, request).then(styled),
    },
    labs: {
      list: () => listLabs(api, style).then(styled),
      setAccess: (request) => setLabsAccess(api, request, style).then(styled),
      setEnrollment: (request) => setLabEnrollment(api, request, style).then(styled),
    },
    users: {
      info: (request) => userInfo(api, request, style).then(styled),
    },
    profile: {
      show: (request) => showProfile(api, request).then(styled),
      update: (request) => updateProfile(api, request).then(styled),
      updateAvatar: async (upload) => avatarOutcome(await uploadRaftAvatar({
        serverUrl,
        fetch: options.fetch ?? fetch,
        headers,
        authorization,
        beforeRequest: options.throttle?.beforeRequest,
      }, upload)),
    },
    apps: {
      getConfig: (request) => getAppConfig(api, request).then(styled),
      patchConfig: (request) => patchAppConfig(api, request).then(styled),
    },
    integrations: createRaftIntegrations({
      api,
      fetch: options.fetch ?? fetch,
      sessions: options.integrationSessions ?? createMemoryIntegrationSessionStore(),
    }),
    mcp: {
      tools: () => listMcpTools(api).then(styled),
      call: (request) => callMcpTool(api, request).then(styled),
    },
    raftbench: {
      findings: (request = {}) => readRaftbenchFindings(api, request).then(styled),
      context: (request) => readRaftbenchContext(api, request).then(styled),
      readAll: (request) => readAllRaftbenchContext(api, request).then(styled),
      submit: (report) => submitRaftbenchReport(api, report).then(styled),
      submitFailure: (run, reason) => submitRaftbenchReport(api, raftbenchFailedReport(run, reason)).then(styled),
    },
    frontier,
    state: {
      save: async () => {
        await session.ensureLoaded();
        session.markDirty();
        return session.save();
      },
      load: () => session.ensureLoaded(),
      snapshot: () => session.snapshot(session.version ?? 0),
    },
    assistant: {
      ownerActions: createRaftAssistantOwnerActions({ api, serverUrl, fetch: options.fetch ?? fetch, headers, authorization }),
    },
    routes,
  };

  /**
   * The `invoke` dispatch table: one entry per manifest operation, each the
   * same implementation as the typed method. `seen` is the frontier for this
   * call (a context view when the caller named one); `origin` is validated.
   */
  type Call = { seen: SeenFrontier; origin: "model" | "code" };
  const handlers: Record<RaftOperationName, (args: never, call: Call) => Promise<RaftInvokeResult>> = {
    "identity.whoami": async () => whoamiOutcome(await raft.identity.whoami()),
    "inbox.check": (args: CheckInboxRequest, call) => checkWithState(args, call.seen),
    "inbox.drain": async (args: DrainInboxRequest, call) => {
      const drain = drainWithState(args, call.seen);
      const batches: RaftInboxBatch[] = [];
      for (let step = await drain.next(); ; step = await drain.next()) {
        if (step.done) return styled(drainedInboxOutcome(batches, step.value, style));
        batches.push(step.value);
      }
    },
    "inbox.commit": async (args: { cursor?: number | null }) => {
      const result = await commitInbox(args.cursor === undefined ? undefined : { cursor: args.cursor });
      return {
        ok: true,
        state: result.cursor === null ? "nothing" : "committed",
        data: result,
        next: null,
        text: result.cursor === null
          ? "Nothing to commit."
          : `Committed inbox cursor ${result.cursor}; the next inbox check acknowledges it.${result.saved ? "" : " Saving the state failed; the batch may be delivered again."}`,
      };
    },
    "inbox.list": (args: ListInboxRequest) => raft.inbox.list(args),
    // Consuming: refused from code (operations.ts), so what it gives out always reaches the model.
    "inbox.read": (args: ReadInboxItemRequest, call) => readItemWithState(args, call.seen),
    // From code, a read never consumes and records nothing: its output may never reach the model.
    "messages.read": (args: ReadHistoryRequest, call) => call.origin === "code"
      ? readWithState({ ...args, consume: false }, undefined)
      : readWithState(args, call.seen),
    "messages.send": (args: SendMessageRequest, call) => sendWithState(args, call.seen, call.origin === "model"),
    "messages.reply": ({ message, ...request }: ReplyToRequest, call) => sendWithState({ ...request, target: message.target }, call.seen, call.origin === "model"),
    "messages.search": (args: SearchMessagesRequest) => raft.messages.search(args),
    "messages.resolve": (args: { messageId: string }) => raft.messages.resolve(args),
    "messages.react": (args: ReactRequest) => raft.messages.react(args),
    "messages.unreact": (args: ReactRequest) => raft.messages.unreact(args),
    "messages.updateCard": (args: UpdateMessageCardRequest) => raft.messages.updateCard(args),
    "attachments.downloadUrl": (args: { attachmentId: string }) => raft.attachments.downloadUrl(args),
    "attachments.comments": (args: { attachmentId: string; limit?: number }) => raft.attachments.comments(args),
    ...raftArtifactsHandlers(raft),
    "mentions.pending": (args: { limit?: number }) => raft.mentions.pending(args),
    "mentions.notify": (args: MentionResolutionIdsRequest) => raft.mentions.notify(args),
    "mentions.add": (args: MentionResolutionIdsRequest) => raft.mentions.add(args),
    "mentions.delivery": (args: { messageId: string }) => raft.mentions.delivery(args),
    "actions.prepare": (args: PrepareActionCardRequest) => raft.actions.prepare(args),
    "actions.withdraw": (args: WithdrawQuestionCardRequest) => raft.actions.withdraw(args),
    "manual.get": (args: { topic: string } & ManualContext) => raft.manual.get(args),
    "raftbench.findings": (args: Partial<RaftbenchFindingsQuery>) => raft.raftbench.findings(args),
    "manual.search": (args: { query: string; scope?: string } & ManualContext) => raft.manual.search(args),
    // Task writes attest what the context saw (G2-2): load the saved state first, as a send does.
    "tasks.claim": (args: ClaimTasksRequest, call) => withState(() => claimTasks(api, args, call.seen, style)),
    "tasks.list": (args: ListTasksRequest) => raft.tasks.list(args),
    "tasks.create": (args: CreateTasksRequest) => raft.tasks.create(args),
    "tasks.unclaim": (args: TaskRef) => raft.tasks.unclaim(args),
    "tasks.assign": (args: AssignTaskRequest) => raft.tasks.assign(args),
    "tasks.unassign": (args: UnassignTaskRequest) => raft.tasks.unassign(args),
    "tasks.updateStatus": (args: UpdateTaskStatusRequest, call) => withState(() => updateTaskStatus(api, args, call.seen, style)),
    "tasks.amend": (args: AmendTaskRequest, call) => withState(() => amendTask(api, args, call.seen, style)),
    "tasks.history": (args: TaskRef) => raft.tasks.history(args),
    "tasks.show": (args: TaskRef) => raft.tasks.show(args),
    "tasks.convert": (args: { target: string; messageId: string }) => raft.tasks.convert(args),
    "tasks.delete": (args: TaskRef) => raft.tasks.delete(args),
    "channels.join": (args: { target: string }) => raft.channels.join(args),
    "channels.leave": (args: ChannelLeaveRequest) => raft.channels.leave(args),
    "channels.mute": (args: { target: string }) => raft.channels.mute(args),
    "channels.unmute": (args: { target: string }) => raft.channels.unmute(args),
    "channels.members": (args: { target: string }) => raft.channels.members(args),
    "channels.info": (args: { target: string }) => raft.channels.info(args),
    "channels.create": (args: CreateChannelRequest) => raft.channels.create(args),
    "channels.update": (args: UpdateChannelRequest) => raft.channels.update(args),
    "channels.archive": (args: { target: string }) => raft.channels.archive(args),
    "channels.unarchive": (args: { target: string }) => raft.channels.unarchive(args),
    "channels.addMember": (args: ChannelMemberRequest) => raft.channels.addMember(args),
    "channels.removeMember": (args: ChannelMemberRemoveRequest) => raft.channels.removeMember(args),
    "threads.list": () => raft.threads.list(),
    "threads.unfollow": (args: { target: string; reason?: string }) => raft.threads.unfollow(args),
    "server.info": (args: ServerInfoRequest) => raft.server.info(args),
    "server.update": (args: UpdateServerRequest) => raft.server.update(args),
    "labs.list": () => raft.labs.list(),
    "labs.setAccess": (args: SetLabsAccessRequest) => raft.labs.setAccess(args),
    "labs.setEnrollment": (args: SetLabEnrollmentRequest) => raft.labs.setEnrollment(args),
    "users.info": (args: UserInfoRequest) => raft.users.info(args),
    "profile.show": (args: { target?: string }) => raft.profile.show(args),
    "profile.update": (args: AgentApiProfileUpdateBody) => raft.profile.update(args),
  };

  const invoke: Raft["invoke"] = async (name, args, caller = {}) => {
    const found = typeof name === "string" ? lookupRaftOperation(name) : undefined;
    if (!found || !Object.hasOwn(handlers, name)) {
      const shown = typeof name === "string" && /^[A-Za-z0-9_.]{1,64}$/.test(name) ? ` "${name}"` : "";
      return failureOutcome(opError("INVALID_REQUEST", {
        message: `Unknown operation${shown}; nothing was sent.`,
        nextAction: "Use a name from RAFT_OPERATIONS (for example \"messages.send\").",
      }));
    }
    const origin = caller?.origin ?? "model";
    if ((origin !== "model" && origin !== "code") || (caller?.contextId !== undefined && typeof caller.contextId !== "string")) {
      return failureOutcome(opError("INVALID_REQUEST", { message: "caller.origin must be \"model\" or \"code\", and caller.contextId a string; nothing was sent." }));
    }
    const input = args === undefined ? {} : args;
    const invalid = validateOpRequest(found.schema, input); if (invalid) return invalid;
    if (origin === "code" && found.spec.modelOnly) {
      return failureOutcome(opError("MODEL_ONLY", {
        message: `${found.spec.name} only counts when the model sees its result, so it cannot be run from code; nothing was sent.`,
      }));
    }
    const handler = handlers[name as RaftOperationName] as (args: unknown, call: Call) => Promise<RaftInvokeResult>;
    return handler(input, { seen: frontier.inContext(caller?.contextId), origin });
  };

  return { ...raft, invoke };
}

/** `identity.whoami` as an outcome (for `invoke`). */
function whoamiOutcome(result: RaftContextResult): RaftOutcome<RaftContextData, "identity"> {
  if (!result.ok) {
    return failureOutcome(opError(result.error.code, {
      message: result.error.message,
      ...(result.status === undefined ? {} : { status: result.status }),
    }));
  }
  const { agent, server, capabilities, guide } = result.data;
  const head = `You are @${agent.name}${agent.displayName ? ` (${agent.displayName})` : ""} on ${server.name}. Credential capabilities: ${capabilities.join(", ") || "none"}.`;
  return { ok: true, state: "identity", data: result.data, next: null, text: guide ? `${head}\n\n${guide}` : head };
}

/**
 * @deprecated Renamed `createRaftAgent`; import it from `@botiverse/raft-sdk/agent`.
 * Same options and client. Removed in 1.0. See MIGRATING.md.
 */
export function createRaft(options: CreateRaftOptions): Raft {
  return createRaftAgent(options);
}
