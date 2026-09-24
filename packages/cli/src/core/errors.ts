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
  | "TOKEN_FILE_UNREADABLE"
  | "TOKEN_FILE_EMPTY"
  | "PROFILE_FILE_UNREADABLE"
  | "PROFILE_FILE_INVALID"
  | "PROFILE_MANAGED_CONTEXT_CONFLICT"
  | "MANAGED_WRAPPER_UNAVAILABLE"
  | "MANAGED_WRAPPER_REQUIRED"
  | "MANAGED_WRAPPER_FORWARD_FAILED"
  | "BRIDGE_EXPECTED_AGENT_REQUIRED"
  | "BRIDGE_IDENTITY_MISMATCH"
  | "SEND_HELD_AS_DRAFT"
  | "SEND_DRAFT_NOT_FOUND"
  | "THREAD_CONTEXT_TARGET_CONFIRMATION_REQUIRED"
  | "INVALID_ARG"
  | "INVALID_SCOPE"
  | "INVALID_TARGET"
  | "INVALID_JSON_RESPONSE"
  | "INFO_FAILED"
  | "INTEGRATION_SESSION_HANDOFF_FAILED"
  | "HISTORY_FAILED"
  | "JOIN_FAILED"
  | "KNOWLEDGE_GET_FAILED"
  | "KNOWLEDGE_SEARCH_FAILED"
  | "KNOWLEDGE_CONTEXT_INVALID"
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
  | "PROFILE_SHOW_FAILED"
  | "READ_FAILED"
  | "SEARCH_FAILED"
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
  | "VIEW_FAILED"
  | "VERSION_UNAVAILABLE"
  | "WIKI_ARTIFACT_READ_FAILED"
  | "WIKI_MANIFEST_GET_FAILED"
  | "WIKI_MANIFEST_PUBLISH_FAILED"
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
  | "unsupported_capability";

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

export type CliEffect = "draft_saved" | "message_queued";

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
