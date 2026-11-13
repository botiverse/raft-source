// CLI-local errors use SCREAMING_SNAKE_CASE. Server-passthrough codes keep
// their wire casing so callers can branch on the exact server contract.
export type CliErrorCode =
  | "MISSING_AGENT_ID"
  | "MISSING_SERVER_URL"
  | "MISSING_AGENT_PROXY_URL"
  | "MULTIPLE_AGENT_PROXY_TOKENS"
  | "MISSING_AGENT_PROXY_TOKEN"
  | "MISSING_TOKEN"
  | "CHECK_FAILED"
  | "ARCHIVE_FAILED"
  | "AMEND_FAILED"
  | "COMMENTS_FAILED"
  | "CREATE_FAILED"
  | "RECEIPT_FAILED"
  | "INBOX_CHECK_FAILED"
  | "INBOX_UNAVAILABLE"
  // RFC 081 `raft inbox read` / `raft inbox dismiss` refusals (shared AGENT_INBOX_ERROR_CODES) and their fallbacks.
  | "INBOX_ITEMS_DISABLED"
  | "INBOX_READ_FAILED"
  | "INBOX_DISMISS_FAILED"
  | "EXPIRED"
  | "INVALID_CURSOR"
  | "NEEDS_ACK"
  | "MESSAGE_CHECK_REMOVED"
  | "INVALID_BEFORE"
  | "BEFORE_TOO_RECENT"
  | "TOKEN_FILE_UNREADABLE"
  | "TOKEN_FILE_EMPTY"
  | "PROFILE_FILE_UNREADABLE"
  | "PROFILE_FILE_INVALID"
  | "PROFILE_MANAGED_CONTEXT_CONFLICT"
  | "MANAGED_WRAPPER_UNAVAILABLE"
  | "MANAGED_WRAPPER_REQUIRED"
  | "MANAGED_WRAPPER_FORWARD_FAILED"
  // The daemon proxy refused a request whose launch has ended (shared cliStableEntry.ts LOCAL_PROXY_LIFECYCLE_CODES).
  | "LAUNCH_SUPERSEDED"
  | "AGENT_NOT_RUNNING"
  | "AGENT_ID_MISMATCH"
  | "BRIDGE_EXPECTED_AGENT_REQUIRED"
  | "BRIDGE_IDENTITY_MISMATCH"
  | "SEND_HELD_AS_DRAFT"
  | "ATTACHMENT_ID_INVALID"
  | "SEND_HELD"
  | "GUIDANCE_DELIVERED"
  // A continuation's answer was refused, or its store failed (commands/continuation).
  | "CONTINUATION_REFUSED"
  | "CONTINUATION_STORE_FAILED"
  | "SEND_DRAFT_NOT_FOUND"
  | "SEND_DRAFT_EXPIRED"
  | "THREAD_CONTEXT_TARGET_CONFIRMATION_REQUIRED"
  | "INVALID_ARG"
  // `raft action prepare`: the card JSON has no `type`, or the Server refused the card (its code).
  | "INVALID_ACTION"
  // `raft action prepare`: a refusal without a well-formed code from the Server (its sentence and next step); any other code is shown as the Server sent it.
  | "PREPARE_FAILED"
  // `raft action withdraw`: a refusal without a well-formed code from the Server; its codes (ALREADY_ANSWERED, QUESTION_EXPIRED, NOT_REQUESTER, AMBIGUOUS_MESSAGE_ID, …) are shown as it sent them.
  | "WITHDRAW_FAILED"
  | "INVALID_SCOPE"
  | "INVALID_TARGET"
  | "INVALID_JSON_RESPONSE"
  | "IDENTITY_MISMATCH"
  | "PROMPT_UNAVAILABLE"
  | "WHOAMI_FAILED"
  | "INFO_FAILED"
  | "INTEGRATION_SESSION_HANDOFF_FAILED"
  // `raft integration invoke` (and app-backed commands): no registered service matched.
  | "INTEGRATION_NOT_FOUND"
  // `raft reminder trigger` / `raft reminder log --key`: the Reminder app is not on this server.
  | "REMINDER_APP_NOT_INSTALLED"
  | "HISTORY_FAILED"
  | "HISTORY_LIMITED"
  | "UNSUPPORTED_BY_SERVER"
  | "JOIN_FAILED"
  | "KNOWLEDGE_GET_FAILED"
  | "KNOWLEDGE_SEARCH_FAILED"
  | "KNOWLEDGE_CONTEXT_INVALID"
  | "LAST_MEMBER"
  | "LEAVE_FAILED"
  | "LIST_FAILED"
  | "MEMBERS_FAILED"
  | "MUTE_FAILED"
  | "MENTION_ACTION_FAILED"
  | "MENTION_DELIVERY_FAILED"
  | "AMBIGUOUS_ID"
  | "BRIDGE_ALREADY_RUNNING"
  | "BRIDGE_WAKE_HINTS_FAILED"
  | "BRIDGE_WAKE_STREAM_FAILED"
  | "BRIDGE_WAKE_STREAM_UNAVAILABLE"
  | "BRIDGE_ACTIVITY_DRAIN_FAILED"
  | "BRIDGE_ACTIVITY_FORWARD_FAILED"
  | "BRIDGE_REQUIRES_PROFILE"
  | "NOT_FOUND"
  // Workspace Artifacts (`raft artifact …`): the Server's own codes, shown as they are.
  | "NOT_VISIBLE"
  | "INVALID_ARTIFACT_REF"
  | "AMBIGUOUS_ARTIFACT_NAME"
  | "VERSION_NOT_FOUND"
  | "FILE_NOT_FOUND"
  | "INVALID_PATH"
  | "TARGET_NOT_FOUND"
  | "ARTIFACTS_NOT_ENABLED"
  | "ARTIFACTS_STORAGE_UNAVAILABLE"
  // Workspace Artifacts push (S1b): the Server's own codes, shown as they are.
  | "FORBIDDEN"
  | "TARGET_REQUIRED"
  | "TITLE_REQUIRED"
  | "INVALID_NAME"
  | "NAME_TAKEN"
  | "BASE_REQUIRED"
  | "BASE_MOVED"
  | "UNSEEN_CHANGES"
  | "DUPLICATE_PATH"
  | "ENTRY_NOT_FOUND"
  | "INVALID_CONTENT"
  | "SIZE_MISMATCH"
  | "SHA256_MISMATCH"
  | "CONTENT_LENGTH_REQUIRED"
  | "FILE_TOO_LARGE"
  | "TOO_MANY_FILES"
  | "REQUEST_TOO_LARGE"
  | "FIELD_TOO_LONG"
  | "UPLOAD_QUOTA_EXCEEDED"
  | "FILE_UPLOAD_QUOTA_EXCEEDED"
  | "COMMENT_NOT_FOUND"
  | "COMMENT_IS_REPLY"
  | "ANCHOR_WITHOUT_PATH"
  | "TOO_MANY_MENTIONS"
  | "TOO_MANY_COMMENTS"
  | "REVIEWS_NOT_AVAILABLE"
  // Workspace Artifacts import from raft-artifacts.com: the Server's own codes, shown as they are.
  | "IMPORT_UNAVAILABLE"
  | "NOT_A_LEGACY_LINK"
  | "LEGACY_OTHER_SERVER"
  | "LEGACY_NOT_FOUND"
  | "IMPORT_TOO_LARGE"
  | "IMPORT_MISMATCH"
  | "ALREADY_IMPORTED"
  | "TARGET_NOT_SUPPORTED"
  | "TARGET_HAS_GUESTS"
  // Workspace Artifacts saving an attachment: the Server's own codes, shown as they are.
  | "ATTACHMENT_NOT_FOUND"
  | "ALREADY_SAVED"
  | "ATTACHMENT_NOT_SAVABLE"
  | "CONTENT_UNAVAILABLE"
  // Workspace Artifacts move: the Server's own code, shown as it is.
  | "HOME_NOT_WIDER"
  | "ARTIFACT_FAILED"
  | "ARTIFACT_DIR_CONFLICT"
  // Core's per-agent limit on a first-party app's agent API writes (429): the Server's code, shown as it is.
  | "RATE_LIMITED"
  // The Server refusing a CLI too old for the route (426; Artifacts' minimum CLI version): the Server's code, shown as it is.
  | "CLIENT_UPGRADE_REQUIRED"
  | "PROFILE_SHOW_FAILED"
  | "READ_FAILED"
  | "SEARCH_FAILED"
  // `raft context search|read` when the Server's refusal carries no code of its own.
  | "CONTEXT_QUERY_FAILED"
  | "SCOPE_DENIED"
  | "QUERY_TOO_BROAD"
  | "SEARCH_TIMEOUT"
  | "SEARCH_UNAVAILABLE"
  | "SERVER_5XX"
  | "PROXY_5XX"
  | "UNFOLLOW_FAILED"
  | "UNARCHIVE_FAILED"
  | "UNMUTE_FAILED"
  | "UNCLAIM_FAILED"
  | "CLAIM_FAILED"
  | "CLAIM_CONFLICT"
  | "ASSIGN_FAILED"
  | "DELETE_FAILED"
  | "CONVERT_FAILED"
  | "UPDATE_FAILED"
  // Channel announcements (`raft artifact push --announcement`): refused before the push, or the set after it.
  | "CHANNEL_ANNOUNCEMENT_DISABLED"
  | "CHANNEL_ANNOUNCEMENT_FORBIDDEN"
  | "CHANNEL_ANNOUNCEMENT_NOT_SET"
  | "VIEW_FAILED"
  | "VERSION_UNAVAILABLE"
  | "WAIT_FAILED"
  | "LOCAL_WRITE_FAILED"
  | "LOCAL_WRITE_SOURCE_FAILED"
  | "LOCAL_WRITE_DESTINATION_FAILED"
  | "LOCAL_WRITE_PARTIAL_FAILED"
  | "LOCAL_WRITE_POST_COMMIT_FAILED"
  | "LOCAL_WRITE_SIZE_EXCEEDED"
  | "INTERNAL_BUG"
  | "knowledge_agent_missing"
  | "knowledge_internal_error"
  | "knowledge_intent_invalid"
  | "knowledge_language_unsupported"
  | "knowledge_not_found"
  | "knowledge_query_invalid"
  | "knowledge_reason_invalid"
  | "knowledge_scope_invalid"
  | "knowledge_source_invalid"
  | "knowledge_topic_invalid"
  | "knowledge_trace_id_invalid"
  | "knowledge_turn_id_invalid"
  | "unsupported_capability"
  | "task_v2_use_create"
  | "task_target_use_task_command"
  | "FOLLOW_FAILED"
  | "REPLY_FAILED"
  // `raft proc`: this Computer's daemon runs no jobs (older, Windows, not daemon-managed), and the daemon's refusals.
  | "PROC_UNSUPPORTED"
  | "PROC_INVALID_NAME"
  | "PROC_NAME_TAKEN"
  | "PROC_LIMIT"
  | "PROC_NOT_FOUND"
  | "PROC_SCOPE_UNCONFIRMED"
  | "PROC_RUNTIME_RESTRICTED"
  | "PROC_FAILED"
  // `raft migration retry`: a refusal without one of the Server's AGENT_MIGRATION_RETRY_REFUSAL_CODES (those are shown as it sent them).
  | "MIGRATION_RETRY_FAILED";

export interface FileWriteEffectState {
  targetPath: string;
  targetCommitted: boolean;
  bytesWritten?: number;
  created?: boolean;
  overwritten?: boolean;
  unknown?: boolean;
  dirCreated?: boolean;
  dirCreatedPath?: string;
  dirCleaned?: boolean;
  tempDirCreated?: boolean;
  tempDirCleaned?: boolean;
  cleanupFailed?: boolean;
  retainedParentDirs?: string[];
  retainedTempArtifacts?: string[];
  tempFileCreated?: boolean;
  tempFilePath?: string;
}

export type CliEffect = "draft_saved" | "message_queued" | "not_executed";

/**
 * Text-only presentation intent. When set, the text renderer omits the labelled
 * lines that merely restate what the command already printed in full above
 * (Effect / Draft saved / Next action). `Error`, `Code` and `Retryable` carry the
 * classification and are never omitted. JSON output is unaffected.
 */
export type CliTextDetailMode = "omit_restated_lines";

export interface CliErrorOptions {
  code: CliErrorCode;
  message: string;
  exitCode?: number;
  cause?: unknown;
  suggestedNextAction?: string;
  textDetailMode?: CliTextDetailMode;
  draftSaved?: boolean;
  effect?: CliEffect;
  details?: Record<string, unknown>;
  layer?: string;
  correlationId?: string;
  proxyFailureClass?: string;
  proxyCauseCode?: string;
  proxyRouteFamily?: string;
  proxyUpstreamLayer?: string;
  proxyUpstreamStatus?: number;
  proxyResponseStarted?: boolean | null;
  proxyResponseComplete?: boolean | null;
  retryable?: boolean | null;
  faultDomain?: string;
  effectState?: FileWriteEffectState;
  outputMode?: "text" | "json";
}

export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly exitCode: number;
  readonly suggestedNextAction?: string;
  readonly textDetailMode?: CliTextDetailMode;
  readonly draftSaved?: boolean;
  readonly effect?: CliEffect;
  readonly details?: Record<string, unknown>;
  readonly layer?: string;
  readonly correlationId?: string;
  readonly proxyFailureClass?: string;
  readonly proxyCauseCode?: string;
  readonly proxyRouteFamily?: string;
  readonly proxyUpstreamLayer?: string;
  readonly proxyUpstreamStatus?: number;
  readonly proxyResponseStarted?: boolean | null;
  readonly proxyResponseComplete?: boolean | null;
  readonly retryable?: boolean | null;
  readonly fault_domain?: string;
  readonly effect_state?: FileWriteEffectState;
  readonly next_action?: string;
  outputMode?: "text" | "json";

  constructor(options: CliErrorOptions) {
    super(options.message);
    this.name = "CliError";
    this.code = options.code;
    this.exitCode = options.exitCode ?? 1;
    this.cause = options.cause;
    this.suggestedNextAction = options.suggestedNextAction;
    this.textDetailMode = options.textDetailMode;
    this.draftSaved = options.draftSaved;
    this.effect = options.effect;
    this.details = options.details;
    this.layer = options.layer;
    this.correlationId = options.correlationId;
    this.proxyFailureClass = options.proxyFailureClass;
    this.proxyCauseCode = options.proxyCauseCode;
    this.proxyRouteFamily = options.proxyRouteFamily;
    this.proxyUpstreamLayer = options.proxyUpstreamLayer;
    this.proxyUpstreamStatus = options.proxyUpstreamStatus;
    this.proxyResponseStarted = options.proxyResponseStarted;
    this.proxyResponseComplete = options.proxyResponseComplete;
    this.retryable = options.retryable;
    this.fault_domain = options.faultDomain ?? options.layer;
    this.effect_state = options.effectState;
    this.next_action = options.suggestedNextAction;
    this.outputMode = options.outputMode;
  }
}

export class CliExit extends Error {
  constructor(public readonly exitCode: number) {
    super(`CliExit(${exitCode})`);
    this.name = "CliExit";
  }
}

export class InternalBugError extends CliError {
  constructor(cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super({
      code: "INTERNAL_BUG",
      message: `Unexpected error: ${message}`,
      cause,
    });
    this.name = "InternalBugError";
  }
}

export function cliError(
  code: string,
  message: string,
  options: {
    suggestedNextAction?: string;
    textDetailMode?: CliTextDetailMode;
    cause?: unknown;
    exitCode?: number;
    draftSaved?: boolean;
    effect?: CliEffect;
    details?: Record<string, unknown>;
    layer?: string;
    correlationId?: string;
    proxyFailureClass?: string;
    proxyCauseCode?: string;
    proxyRouteFamily?: string;
    proxyUpstreamLayer?: string;
    proxyUpstreamStatus?: number;
    proxyResponseStarted?: boolean | null;
    proxyResponseComplete?: boolean | null;
    retryable?: boolean | null;
    faultDomain?: string;
    effectState?: FileWriteEffectState;
    outputMode?: "text" | "json";
  } = {},
): CliError {
  return new CliError({
    code: code as CliErrorCode,
    message,
    exitCode: options.exitCode,
    cause: options.cause,
    suggestedNextAction: options.suggestedNextAction,
    textDetailMode: options.textDetailMode,
    draftSaved: options.draftSaved,
    effect: options.effect,
    details: options.details,
    layer: options.layer,
    correlationId: options.correlationId,
    proxyFailureClass: options.proxyFailureClass,
    proxyCauseCode: options.proxyCauseCode,
    proxyRouteFamily: options.proxyRouteFamily,
    proxyUpstreamLayer: options.proxyUpstreamLayer,
    proxyUpstreamStatus: options.proxyUpstreamStatus,
    proxyResponseStarted: options.proxyResponseStarted,
    proxyResponseComplete: options.proxyResponseComplete,
    retryable: options.retryable,
    faultDomain: options.faultDomain,
    effectState: options.effectState,
    outputMode: options.outputMode,
  });
}

export function toCliError(err: unknown): CliError {
  if (err instanceof CliError) return err;
  return new InternalBugError(err);
}
